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
      '/ask <pertanyaan> - tanya AI + websearch (via OpenRouter)\n' +
      '/model - pilih model AI (list/set/reset)\n' +
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

// Daftar model FREE yang support tool calling (untuk /model list)
const AVAILABLE_MODELS = [
  'apodex/apodex-1.1-mini:free',
  'qwen/qwen3.8-27b:free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'inclusionai/ling-3.0-flash-sante:free',
];

// State model per chat (in-memory; reset saat server restart / cold start di Vercel)
const chatModel = new Map();

const getModelForChat = (chatId) => (chatId ? chatModel.get(chatId) : undefined);

// Pecah teks panjang (>4096 char, limit Telegram) menjadi beberapa pesan
const chunkText = (text, limit = 4096) => {
  if (text.length <= limit) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
};

const mapOpenRouterError = (status, body) => {
  const short = body.length > 200 ? `${body.slice(0, 200)}...` : body;
  switch (status) {
    case 401:
      return 'API key OpenRouter tidak valid';
    case 402:
      return 'Kredit OpenRouter habis';
    case 429:
      return 'Rate limit, coba lagi sebentar lagi';
    case 400:
      return `Model tidak ditemukan atau tidak mendukung tool calling (${short})`;
    default:
      return `OpenRouter ${status}: ${short}`;
  }
};

const askAI = async (prompt, modelOverride, chatId) => {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY belum diset di environment variables');
  }
  const model = modelOverride || getModelForChat(chatId) || AI_MODEL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55_000);
  let resp;
  try {
    resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://agentadyfas.vercel.app',
        'X-Title': 'AgentAdyfas Bot',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: AI_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        // Server tool websearch: OpenRouter yang menjalankan search, model memutuskan kapan dipakai
        tools: [
          {
            type: 'openrouter:web_search',
            parameters: { engine: 'auto', max_results: 5, max_uses: 3 },
          },
        ],
      }),
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('Request ke AI timeout');
    throw new Error(`Gagal menghubungi OpenRouter: ${err.message}`);
  }
  clearTimeout(timer);
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(mapOpenRouterError(resp.status, errText));
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
    const answer = await askAI(prompt, undefined, ctx.chat.id);
    const chunks = chunkText(answer);
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, '', chunks[0]);
    for (let i = 1; i < chunks.length; i++) {
      await ctx.reply(chunks[i]);
    }
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, '', `⚠️ Error: ${err.message}`);
  }
});

// === COMMAND: /model — pilih model AI per chat ===
bot.command('model', async (ctx) => {
  const arg = (ctx.message.text || '').replace(/^\/model(@\w+)?\s*/i, '').trim();
  const current = getModelForChat(ctx.chat.id) || AI_MODEL;

  if (!arg) {
    return ctx.reply(
      `Model saat ini: ${current}\n\n` +
        'Pilihan:\n' +
        '/model list - daftar model\n' +
        '/model set <model> - ganti model\n' +
        '/model reset - kembali ke default\n\n' +
        'Catatan: pilihan tersimpan di memori server, reset saat server restart.'
    );
  }

  if (arg === 'list') {
    return ctx.reply(
      'Model tersedia (semua support tool calling + websearch):\n' +
        AVAILABLE_MODELS.map((m, i) => `${i + 1}. ${m}${m === AI_MODEL ? ' (default)' : ''}`).join('\n')
    );
  }

  if (arg === 'reset') {
    chatModel.delete(ctx.chat.id);
    return ctx.reply(`Model di-reset ke default: ${AI_MODEL}`);
  }

  if (arg.startsWith('set ')) {
    const wanted = arg.slice(4).trim().toLowerCase();
    const match = AVAILABLE_MODELS.find((m) => m.toLowerCase() === wanted);
    if (!match) {
      return ctx.reply(`Model "${wanted}" tidak tersedia.\nPilihan valid:\n${AVAILABLE_MODELS.join('\n')}`);
    }
    chatModel.set(ctx.chat.id, match);
    return ctx.reply(`Model diganti menjadi: ${match}\nGunakan /ask untuk mencobanya.`);
  }

  return ctx.reply(
    'Usage:\n/model - lihat model saat ini\n/model list - daftar model\n/model set <model>\n/model reset'
  );
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
