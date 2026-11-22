require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const https = require('https');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const { BOT_TOKEN, APP_URL, PROXY_URL } = process.env;
const PORT = process.env.PORT || 3000;

// ---------- логи ----------
function log(level, ...args) {
  console.log(`[${new Date().toISOString()}] [${level}]`, ...args);
}

if (!BOT_TOKEN || BOT_TOKEN.includes('PASTE_YOUR_TOKEN')) {
  log('ERROR', 'BOT_TOKEN не задан в .env');
  process.exit(1);
}
if (!APP_URL || !APP_URL.startsWith('https://')) {
  log('WARN', 'APP_URL должен начинаться с https:// — иначе Telegram не откроет Mini App');
}

// ---------- прокси для запросов к Telegram ----------
let agent;
if (PROXY_URL) {
  agent = PROXY_URL.startsWith('socks')
    ? new SocksProxyAgent(PROXY_URL)
    : new HttpsProxyAgent(PROXY_URL);
  log('INFO', `Запросы к Telegram идут через прокси: ${PROXY_URL}`);
} else {
  log('INFO', 'Прокси не задан, запросы к Telegram идут напрямую');
}

function tg(method, params = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params);
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${BOT_TOKEN}/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        agent,
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (!json.ok) return reject(new Error(`${method}: ${json.description}`));
            resolve(json.result);
          } catch (e) {
            reject(new Error(`${method}: некорректный ответ (${res.statusCode}): ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`${method}: таймаут`)));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------- проверка initData (подтверждает, что запрос пришёл из Telegram) ----------
function checkInitData(initData) {
  if (!initData) return { valid: false, reason: 'initData пустой (страница открыта не из Telegram?)' };
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { valid: false, reason: 'нет hash' };
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (calc !== hash) return { valid: false, reason: 'подпись не совпала' };
  let user = null;
  try { user = JSON.parse(params.get('user')); } catch {}
  return { valid: true, user };
}

// ---------- веб-сервер ----------
const app = express();
app.use(express.json({ limit: '10kb' }));

app.use((req, res, next) => {
  const start = Date.now();
  log('HTTP', `--> ${req.method} ${req.url} (ip: ${req.headers['x-forwarded-for'] || req.ip})`);
  res.on('finish', () => {
    log('HTTP', `<-- ${req.method} ${req.url} ${res.statusCode} (${Date.now() - start} мс)`);
  });
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.send('ok'));

app.post('/api/word', (req, res) => {
  const word = String(req.body.word ?? '').trim().slice(0, 200);
  log('API', `Получено слово: "${word}"`);

  const auth = checkInitData(req.body.initData);
  if (auth.valid) {
    log('API', `initData валиден, пользователь: ${auth.user?.id} (@${auth.user?.username || '-'})`);
  } else {
    log('WARN', `initData НЕ валиден: ${auth.reason}`);
  }

  const message = `Ваше слово - ${word}`;
  log('API', `Отправляю ответ: "${message}"`);
  res.json({ message, telegramVerified: auth.valid });
});

app.listen(PORT, () => log('INFO', `Сервер запущен на порту ${PORT}, APP_URL=${APP_URL}`));

// ---------- бот: long polling ----------
async function startBot() {
  try {
    const me = await tg('getMe');
    log('BOT', `Бот подключён: @${me.username}`);
  } catch (e) {
    log('ERROR', `Не удалось подключиться к Telegram (проверь токен и прокси): ${e.message}`);
  }

  try {
    await tg('setChatMenuButton', {
      menu_button: { type: 'web_app', text: 'Открыть', web_app: { url: APP_URL } },
    });
    log('BOT', 'Кнопка меню Mini App установлена');
  } catch (e) {
    log('ERROR', `setChatMenuButton: ${e.message}`);
  }

  let offset = 0;
  while (true) {
    try {
      const updates = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, 40000);
      for (const u of updates) {
        offset = u.update_id + 1;
        const m = u.message;
        if (!m) continue;
        log('BOT', `Сообщение от ${m.from.id}: "${m.text || '[не текст]'}"`);
        await tg('sendMessage', {
          chat_id: m.chat.id,
          text: 'Нажми кнопку, чтобы открыть Mini App 👇',
          reply_markup: {
            inline_keyboard: [[{ text: 'Открыть Mini App', web_app: { url: APP_URL } }]],
          },
        });
        log('BOT', `Ответ с кнопкой отправлен в чат ${m.chat.id}`);
      }
    } catch (e) {
      log('ERROR', `polling: ${e.message}. Повтор через 5 сек`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
startBot();
