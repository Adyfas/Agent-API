import express from 'express';
import { Telegraf } from 'telegraf';

const app = express();
app.use(express.json());

const bot = new Telegraf(process.env.BOT_TOKEN);

// === BOT COMMANDS ===
bot.start((ctx) =>
  ctx.reply('Bot aktif! Kirim POST ke /api/send dengan header x-api-secret untuk mengirim notifikasi.')
);
bot.help((ctx) =>
  ctx.reply(
    'Perintah:\n' +
      '/start - info bot\n' +
      '/ask <pertanyaan> - tanya AI (via OpenRouter)\n' +
      '/help - bantuan ini\n\n' +
      'Notifikasi dikirim via POST /api/send dengan body { title, content, url, chat_id? }.\n' +
      'Tanya AI via API: POST /api/ask dengan body { prompt, model? }.'
  )
);

// === SECURITY MIDDLEWARE ===
const checkSecret = (req, res, next) => {
  if (req.headers['x-api-secret'] !== process.env.API_SECRET) {
    return res.status(401).json({ ok: false, message: 'Unauthorized' });
  }
  next();
};

// === OPENROUTER AI ASSISTANT ===
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const AI_MODEL = process.env.AI_MODEL || 'openai/gpt-4o-mini';
const AI_SYSTEM_PROMPT =
  process.env.AI_SYSTEM_PROMPT ||
  'Kamu adalah asisten AI di Telegram. Jawab singkat, jelas, dan to the point dalam bahasa Indonesia. Gunakan plain text tanpa markdown.';

const askAI = async (prompt, modelOverride) => {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY belum diset di environment variables');
  }
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://agentadyfas.vercel.app',
      'X-Title': 'AgentAdyfas Bot',
    },
    body: JSON.stringify({
      model: modelOverride || AI_MODEL,
      messages: [
        { role: 'system', content: AI_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`OpenRouter ${resp.status}: ${errText}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || '(response kosong)';
};

// === ENDPOINT 3: TANYA AI VIA API ===
app.post('/api/ask', checkSecret, async (req, res) => {
  try {
    const { prompt, model } = req.body || {};
    if (!prompt) {
      return res.status(400).json({ ok: false, message: 'prompt required' });
    }
    const answer = await askAI(prompt, model);
    res.json({ ok: true, answer });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// === COMMAND: /ask <pertanyaan> ===
bot.command('ask', async (ctx) => {
  const prompt = (ctx.message.text || '').replace(/^\/ask(@\w+)?\s*/i, '').trim();
  if (!prompt) {
    return ctx.reply('Pakai format: /ask <pertanyaan>\nContoh: /ask apa itu API?');
  }
  const statusMsg = await ctx.reply('⏳ Sedang berpikir...');
  try {
    const answer = await askAI(prompt);
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, '', answer);
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, '', `⚠️ Error: ${err.message}`);
  }
});

// === CATCH-ALL: balas "oke" untuk semua pesan teks selain command ===
bot.on('text', (ctx) => {
  if (ctx.message.text.startsWith('/')) return;
  ctx.reply('oke');
});

// === MARKDOWNV2 ESCAPE HELPER ===
// Escape semua karakter khusus MarkdownV2 agar pesan tidak error saat parse
const escapeMarkdownV2 = (text = '') =>
  String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');

// === FORMAT PESAN ===
const formatMessage = ({ title, content, url }) => {
  const t = title || 'Notifikasi';
  // Sanitasi content: ganti backtick & rapatkan whitespace agar aman di code span (monospace)
  const c = String(content ?? '').replace(/`/g, "'").replace(/\s+/g, ' ').trim() || '-';
  const time = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

  const lines = [
    `*${escapeMarkdownV2(t)}*`,
    '────────────────',
    `\`${c}\``,
  ];

  if (url) lines.push(`🔗 [Buka Link](${escapeMarkdownV2(url)})`);

  lines.push(`_🕒 ${escapeMarkdownV2(time)} WIB_`);
  return lines.join('\n');
};

// === ENDPOINT 1: KIRIM NOTIFIKASI ===
app.post('/api/send', checkSecret, async (req, res) => {
  try {
    const { title, content, url, chat_id } = req.body || {};
    const targetChat = chat_id || process.env.CHAT_ID_DEFAULT;

    if (!targetChat) {
      return res.status(400).json({ ok: false, message: 'chat_id required (body.chat_id atau CHAT_ID_DEFAULT)' });
    }

    const text = formatMessage({ title, content, url });

    await bot.telegram.sendMessage(targetChat, text, {
      parse_mode: 'MarkdownV2',
      link_preview_options: { is_disabled: true },
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// === ENDPOINT 2: WEBHOOK TELEGRAM ===
// Mount tanpa prefix path: filter Telegraf membandingkan req.url dengan '/api/webhook'
app.use(bot.webhookCallback('/api/webhook'));

// === HEALTH CHECK ===
app.get('/', (req, res) => res.send('Bot running!'));

// === START SERVER ===
// Vercel akan menjalankan file ini sebagai server dan me-route semua request ke PORT yang diberikan
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server berjalan di port ${port}`));
