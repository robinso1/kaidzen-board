// Еженедельный дайджест кайдзен-доски в Telegram.
// Запускается GitHub Action'ом (см. .github/workflows/digest.yml).
// Нужны секреты репозитория: FIREBASE_SA (JSON сервис-аккаунта), TG_TOKEN.
// TG_CHAT_ID необязателен: если не задан, бот берёт chat id из последнего
// сообщения, написанного ему (для этого один раз напиши боту /start).

const crypto = require('crypto');

const PROJECT = 'kaidzen-artem';
const WEB_API_KEY = 'AIzaSyCh9cfvDd2oA4JyGQGWs7M43YRq1uh2LAQ'; // публичный, из firebaseConfig
const UID = 'plXnTD3BKhN6ZVpGiwbW8OIC7KG3';                    // Firebase UID Артёма (id документа boards/{uid})
const BOARD_URL = 'https://robinso1.github.io/kaidzen-board/';
const STALE_DAYS = 30;
const BOARDS = { health: 'Здоровье', finance: 'Финансы', love: 'Любовь' };
const MONTHS_RU = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Мятим Firebase custom token на приватном ключе сервис-аккаунта (локальная подпись,
// прав IAM не требует) и меняем его на обычный ID-токен пользователя UID. Дальше читаем
// Firestore как этот пользователь — правила boards/{uid} с auth.uid==uid пропускают.
async function getIdToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    sub: sa.client_email,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now,
    exp: now + 3600,
    uid: UID,
  }));
  const unsigned = header + '.' + claims;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const sig = signer.sign(sa.private_key).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const customToken = unsigned + '.' + sig;
  const res = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=' + WEB_API_KEY, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  const j = await res.json();
  if (!j.idToken) throw new Error('обмен custom token не удался: ' + JSON.stringify(j).slice(0, 300));
  return j.idToken;
}

// Firestore REST отдаёт значения в обёртках {stringValue: ...} и т.п.
function dec(v) {
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return parseInt(v.integerValue, 10);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.nullValue !== undefined) return null;
  if (v.mapValue) return decMap(v.mapValue.fields || {});
  if (v.arrayValue) return (v.arrayValue.values || []).map(dec);
  return null;
}
function decMap(fields) {
  const o = {};
  for (const k in fields) o[k] = dec(fields[k]);
  return o;
}

function daysSince(iso) {
  if (!iso) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(iso)) / 86400000));
}

function fmtMoney(n) {
  return n.toLocaleString('ru-RU') + ' ₽';
}

function buildDigest(d) {
  const lines = [];

  const waveItems = ((d.wave && d.wave.items) || []).filter(x => x);
  if (waveItems.length) {
    lines.push('🌊 Волна: ' + waveItems.join(' + ') + ' (держится ' + daysSince(d.wave.updated) + ' дн.)');
    lines.push('Если в голове уже другая волна, зайди и перепиши.');
  } else {
    lines.push('🌊 Волна не задана. Зайди и впиши одной строкой, на чём ты сейчас.');
  }

  const stale = [];
  let total = 0, done = 0;
  for (const key in BOARDS) {
    const b = d[key];
    if (!b) continue;
    total += b.cards.length;
    done += b.cards.filter(c => c.c === b.cols.length - 1).length;
    b.cards.forEach(c => {
      if (c.c !== b.cols.length - 1 && c.m && daysSince(c.m) >= STALE_DAYS) {
        stale.push({ board: BOARDS[key], t: c.t, days: daysSince(c.m) });
      }
    });
  }
  if (stale.length) {
    stale.sort((a, b) => b.days - a.days);
    lines.push('');
    lines.push('🟡 Закисло 30+ дней (' + stale.length + '):');
    stale.slice(0, 7).forEach(s => {
      const t = s.t.length > 80 ? s.t.slice(0, 77) + '...' : s.t;
      lines.push('• ' + s.board + ': ' + t + ' (' + s.days + ' дн.)');
    });
    if (stale.length > 7) lines.push('...и ещё ' + (stale.length - 7));
    lines.push('Вопрос к каждой: это даст больше денег или меньше стресса? Если нет, крести без жалости.');
  } else {
    lines.push('');
    lines.push('🟢 Лежаков нет, всё живое.');
  }

  const curYm = new Date().toISOString().slice(0, 7);
  const moneyParts = [];
  ((d.picture) || []).forEach(p => {
    if (p.inc && p.inc[curYm] != null) moneyParts.push(p.dir + ': ' + fmtMoney(p.inc[curYm]));
  });
  if (moneyParts.length) {
    lines.push('');
    lines.push('💰 ' + MONTHS_RU[parseInt(curYm.slice(5), 10) - 1] + ': ' + moneyParts.join(' · '));
  }

  const inbox = Array.isArray(d.inbox) ? d.inbox.length : 0;
  if (inbox) {
    lines.push('');
    lines.push('📥 Во «Входящих» ' + inbox + ' мыслей, разбери на доске.');
  }

  lines.push('');
  lines.push('📊 Карточек закрыто: ' + done + ' из ' + total + '.');
  lines.push('Доска: ' + BOARD_URL);
  return lines.join('\n');
}

async function main() {
  const { FIREBASE_SA, TG_TOKEN, TG_CHAT_ID } = process.env;
  if (!FIREBASE_SA || !TG_TOKEN) {
    console.log('Секреты не заданы (FIREBASE_SA / TG_TOKEN), выходим тихо.');
    return;
  }
  let chatId = TG_CHAT_ID;
  if (!chatId) {
    const u = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/getUpdates').then(r => r.json());
    const upd = (u.result || []).slice().reverse().find(x => x.message && x.message.chat);
    if (!upd) throw new Error('chat id не найден: напиши своему боту /start и запусти дайджест ещё раз');
    chatId = upd.message.chat.id;
  }
  const sa = JSON.parse(FIREBASE_SA);
  const idToken = await getIdToken(sa);
  const res = await fetch(
    'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents/boards/' + UID,
    { headers: { authorization: 'Bearer ' + idToken } }
  );
  const j = await res.json();
  if (!j.fields) throw new Error('документ доски недоступен: ' + JSON.stringify(j).slice(0, 300));
  const doc = decMap(j.fields);
  const text = buildDigest(doc);

  const tg = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  const tj = await tg.json();
  if (!tj.ok) throw new Error('telegram failed: ' + JSON.stringify(tj));
  console.log('Дайджест отправлен.');
}

main().catch(err => { console.error(err); process.exit(1); });
