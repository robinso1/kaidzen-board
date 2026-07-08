// Двусторонний Telegram-бот кайдзен-доски.
// Запускается по расписанию (см. .github/workflows/tgbot.yml, каждые 5 минут).
// Забирает новые сообщения через getUpdates, пишет в Firestore (волна / входящие),
// отвечает пользователю. Секреты: FIREBASE_SA, TG_TOKEN. Никаких серверов.
//
// Команды в чате:
//   волна: <текст>   → обновить текущую волну (главное дело)
//   <любой текст>     → закинуть мысль во «Входящие» доски
//   ? или помощь      → показать подсказку

const crypto = require('crypto');

const PROJECT = 'kaidzen-artem';
const WEB_API_KEY = 'AIzaSyCh9cfvDd2oA4JyGQGWs7M43YRq1uh2LAQ';
const UID = 'plXnTD3BKhN6ZVpGiwbW8OIC7KG3';
const ALLOWED_CHAT = 922721753; // только чат Артёма, чужие сообщения игнорируем
const BOARD_URL = 'https://robinso1.github.io/kaidzen-board/';
const HELP = 'Я бот твоей кайдзен-доски. Просто пиши:\n' +
  '• «волна: делаю то-то» — обновлю текущую волну\n' +
  '• любой текст — закину мысль во «Входящие» доски, разберёшь потом\n' +
  'Раз в неделю сам пришлю выжимку. Доска: ' + BOARD_URL;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getIdToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    sub: sa.client_email,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now, exp: now + 3600, uid: UID,
  }));
  const unsigned = header + '.' + claims;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const sig = signer.sign(sa.private_key).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const res = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=' + WEB_API_KEY, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: unsigned + '.' + sig, returnSecureToken: true }),
  });
  const j = await res.json();
  if (!j.idToken) throw new Error('обмен custom token не удался: ' + JSON.stringify(j).slice(0, 300));
  return j.idToken;
}

// Firestore REST: значения обёрнуты в {stringValue}/{integerValue}/...
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
function decMap(fields) { const o = {}; for (const k in fields) o[k] = dec(fields[k]); return o; }

function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  if (typeof v === 'object') { const f = {}; for (const k in v) f[k] = enc(v[k]); return { mapValue: { fields: f } }; }
  return { nullValue: null };
}

function todayISO() { return new Date().toISOString().slice(0, 10); }
function daysSince(iso) { return iso ? Math.max(0, Math.floor((Date.now() - new Date(iso)) / 86400000)) : 0; }

async function tg(token, method, body) {
  const res = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return res.json();
}

async function main() {
  const { FIREBASE_SA, TG_TOKEN } = process.env;
  if (!FIREBASE_SA || !TG_TOKEN) { console.log('нет секретов, выходим тихо'); return; }

  const upd = await (await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/getUpdates?timeout=0&allowed_updates=%5B%22message%22%5D')).json();
  const updates = upd.result || [];
  const msgs = updates.filter(u => u.message && u.message.chat && u.message.chat.id === ALLOWED_CHAT && typeof u.message.text === 'string');

  if (!updates.length) { console.log('новых сообщений нет'); return; }

  const maxId = Math.max(...updates.map(u => u.update_id));

  if (msgs.length) {
    const sa = JSON.parse(FIREBASE_SA);
    const idToken = await getIdToken(sa);
    const base = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents/boards/' + UID;

    const snap = await (await fetch(base, { headers: { authorization: 'Bearer ' + idToken } })).json();
    const doc = snap.fields ? decMap(snap.fields) : {};
    if (!doc.wave) doc.wave = { items: ['', ''], updated: '', history: [] };
    if (!doc.wave.history) doc.wave.history = [];
    if (!Array.isArray(doc.inbox)) doc.inbox = [];

    const replies = [];
    for (const u of msgs) {
      const text = u.message.text.trim();
      if (!text) continue;
      if (/^(\?|помощь|\/start|\/help)$/i.test(text)) { replies.push(HELP); continue; }
      const m = text.match(/^волна\s*[:\-]?\s*(.+)/is);
      if (m) {
        const val = m[1].trim();
        if (doc.wave.items[0] && daysSince(doc.wave.updated) >= 1) {
          doc.wave.history.unshift({ text: doc.wave.items.filter(Boolean).join(' + '), days: daysSince(doc.wave.updated), to: todayISO() });
          doc.wave.history = doc.wave.history.slice(0, 8);
        }
        doc.wave.items[0] = val;
        doc.wave.updated = todayISO();
        replies.push('🌊 Волна обновлена: ' + val);
      } else {
        doc.inbox.unshift({ text, ts: todayISO() });
        doc.inbox = doc.inbox.slice(0, 100);
        replies.push('📥 Закинул во «Входящие» (' + doc.inbox.length + '). Разберёшь на доске, когда будет настроение.');
      }
    }

    const patchUrl = base + '?updateMask.fieldPaths=wave&updateMask.fieldPaths=inbox';
    const pr = await fetch(patchUrl, {
      method: 'PATCH', headers: { authorization: 'Bearer ' + idToken, 'content-type': 'application/json' },
      body: JSON.stringify({ fields: { wave: enc(doc.wave), inbox: enc(doc.inbox) } }),
    });
    if (!pr.ok) throw new Error('запись в Firestore не удалась: ' + (await pr.text()).slice(0, 300));

    for (const r of replies) await tg(TG_TOKEN, 'sendMessage', { chat_id: ALLOWED_CHAT, text: r, disable_web_page_preview: true });
    console.log('обработано сообщений: ' + msgs.length);
  }

  // Подтвердить обработку: следующий getUpdates не вернёт эти апдейты.
  await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/getUpdates?offset=' + (maxId + 1) + '&timeout=0');
}

main().catch(err => { console.error(err); process.exit(1); });
