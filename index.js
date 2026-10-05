import express from 'express';
import { Telegraf } from 'telegraf';

const app = express();
app.use(express.json());

// TELEGRAM_API_BASE: hook untuk test (mock Bot API); default tetap https://api.telegram.org
const bot = new Telegraf(
  process.env.BOT_TOKEN,
  process.env.TELEGRAM_API_BASE ? { telegram: { apiRoot: process.env.TELEGRAM_API_BASE } } : undefined
);

// === BOT COMMANDS ===
bot.start((ctx) =>
  ctx.reply('Bot aktif! Kirim POST ke /api/send dengan header x-api-secret untuk mengirim notifikasi.')
);
bot.help((ctx) =>
  ctx.reply(
    'Perintah:\n' +
      '/start - info bot\n' +
      '/ask <pertanyaan> - tanya AI + websearch (session aktif + riwayat + sisa kuota harian)\n' +
      '/new <judul> - buat session baru\n' +
      '/sessions - list semua session\n' +
      '/use <id> - ganti session aktif\n' +
      '/model - pilih model AI (list/set/reset)\n' +
      '/status - cek status bot (web, API key, usage OpenRouter, kuota)\n' +
      '/help - bantuan ini\n\n' +
      'Catatan: session & pilihan model tersimpan di memori server, hilang saat cold start.\n' +
      'Notifikasi dikirim via POST /api/send dengan body { title, content, url, chat_id? }.\n' +
      'Tanya AI via API: POST /api/ask dengan body { prompt, model?, history? }.\n' +
      'Cek status via API: GET /api/status (header x-api-secret).'
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
// OPENROUTER_API_BASE: hook untuk test (mock OpenRouter); default tetap https://openrouter.ai/api/v1
const OPENROUTER_API_BASE = (process.env.OPENROUTER_API_BASE || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
const AI_MODEL = process.env.AI_MODEL || 'openai/gpt-4o-mini';
const AI_SYSTEM_PROMPT =
  process.env.AI_SYSTEM_PROMPT ||
  'Kamu adalah asisten AI di Telegram. Jawab singkat, jelas, dan to the point dalam bahasa Indonesia. Gunakan plain text tanpa markdown. PENTING: Jika pertanyaan membutuhkan informasi terkini (berita, perkembangan terbaru, fakta saat ini, versi, harga, dll), kamu WAJIB memanggil tool web_search dulu, lalu menjawab berdasarkan hasil search dan mencantumkan sumber URL-nya. Jangan menjawab topik terkini dari pengetahuan lama.';

// Bangun system prompt dinamis: sisipkan tanggal hari ini agar query search selalu terkini
const buildSystemPrompt = () => {
  const now = new Date();
  const today = now.toLocaleDateString('en-CA'); // YYYY-MM-DD
  const monthYear = now.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
  return (
    `${AI_SYSTEM_PROMPT} ` +
    `Hari ini tanggal ${today} (${monthYear}). ` +
    `Saat memanggil web_search, selalu sertakan tanggal/bulan/tahun terkini dalam query pencarianmu agar hasil yang dikembalikan adalah yang paling baru.`
  );
};

// Daftar model FREE default yang support tool calling (fallback jika AI_AVAILABLE_MODELS kosong)
const DEFAULT_FREE_MODELS = [
  // 1. Router Otomatis & Model Stealth Agentic Utama
  'openrouter/free',                                    // Mengarahkan otomatis ke model gratis yang mendukung tools
  'space-bunny/alpha:free',                             // Model stealth premium gratis dengan dukungan native tools kuat
  
  // 2. Model Spesialis Agentic & Coding Tier Gratis
  'cohere/north-mini-code:free',                        // Optimal untuk SWE-agent, mendukung tooluse via JSON schema
  'deepseek/deepseek-v4-flash:free',                     // Latensi instan, dirancang untuk alur kerja agentic
  'apodex/apodex-1.1-mini:free',                        // Khusus riset mandiri berbasis integrasi berkas dan tools
  'thinking-machines/inkling:free',                     // Dibuat khusus untuk sistem agentic dan tool-use
  'thinking-machines/inkling-small:free',               // Versi efisien untuk alur kerja agentic multimodal
  'dots-studio/dots3-note-preview:free',                // Mendukung multi-step agent workflows secara native
  'nvidia/nemotron-3-super-120b-a12b:free',             // Penalaran kompleks yang andal untuk multi-agent
  'openai/gpt-oss-120b:free',                           // Varian gratis open-weight yang mendukung function calling

  // 3. Model Terbuka Populer (Tier Gratis) dengan Kapabilitas Tool/Function Bawaan
  'meta-llama/llama-3.3-70b-instruct:free',             // Llama 3.3 memiliki native tool calling bawaan yang sangat stabil
  'meta-llama/llama-3.1-8b-instruct:free',              // Versi ringan Llama yang mendukung pemanggilan fungsi
  'meta-llama/llama-3.1-70b-instruct:free',             // Llama 3.1 70B versi gratis dengan dukungan tools eksternal
  'qwen/qwen-2.5-72b-instruct:free',                    // Seri Qwen 2.5 sangat andal mengeksekusi function/tool calling
  'qwen/qwen-2.5-coder-32b-instruct:free',              // Khusus coding agent, native tool use
  'google/gemini-flash-1.5-8b:free',                    // Gemini Flash gratis dengan integrasi tool calling via API
  'google/gemma-2-9b-it:free',                          // Instruksi ketat yang aman untuk skema JSON / tools
  'mistralai/mistral-7b-instruct:free',                 // Mendukung pemanggilan fungsi dasar lewat API konvensional
  'microsoft/phi-3-medium-128k-instruct:free',          // Jendela konteks panjang untuk parsing skema tools
  'yi/yi-1.5-34b-chat:free'                             // Model chat serbaguna yang kompatibel dengan instruksi tools
];



// Daftar model bisa diatur user via env var AI_AVAILABLE_MODELS (comma-separated)
const AVAILABLE_MODELS = (process.env.AI_AVAILABLE_MODELS || DEFAULT_FREE_MODELS.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// State model per chat (in-memory; reset saat server restart / cold start di Vercel)
const chatModel = new Map();

const getModelForChat = (chatId) => (chatId ? chatModel.get(chatId) : undefined);

// === SESSION STORE (in-memory; hilang saat cold start Vercel) ===
const sessions = new Map(); // sessionId -> { id, title, messages: [{role, content}], createdAt }
const activeSession = new Map(); // chatId -> sessionId
let sessionCounter = 0;

const createSession = (title) => {
  sessionCounter += 1;
  const session = {
    id: sessionCounter,
    title: title || `Session ${sessionCounter}`,
    messages: [],
    createdAt: Date.now(),
  };
  sessions.set(session.id, session);
  return session;
};

// Session aktif untuk chat ini; auto-buat "Session Baru" jika belum ada
const getActiveSession = (chatId) => {
  const id = activeSession.get(chatId);
  if (id != null && sessions.has(id)) return sessions.get(id);
  const session = createSession('Session Baru');
  activeSession.set(chatId, session.id);
  return session;
};

const listSessions = () => [...sessions.values()].sort((a, b) => a.id - b.id);

// === PENGGUNAAN AI HARI INI (in-memory; reset saat cold start Vercel) ===
// Limit default 50 request/hari (free tier OpenRouter); bisa diubah via env AI_DAILY_LIMIT
const AI_DAILY_LIMIT = Number.parseInt(process.env.AI_DAILY_LIMIT, 10) || 50;
const aiDateStr = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
let aiUsage = { date: aiDateStr(), count: 0 };

// Hitung 1 request setiap kali OpenRouter menjawab (sukses maupun error HTTP)
const bumpAiUsage = () => {
  const today = aiDateStr();
  if (aiUsage.date !== today) aiUsage = { date: today, count: 0 };
  aiUsage.count += 1;
};

const getAiUsage = () => {
  const today = aiDateStr();
  const count = aiUsage.date === today ? aiUsage.count : 0;
  return { today: count, limit: AI_DAILY_LIMIT, percent: Math.round((count / AI_DAILY_LIMIT) * 100) };
};

const usageFooter = () => {
  const u = getAiUsage();
  return `\n\n📊 Kuota AI hari ini: ${u.today}/${u.limit} request (${u.percent}%)`;
};

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

// === MARKDOWNV2 ESCAPE HELPER ===
// Escape semua karakter khusus MarkdownV2 agar pesan tidak error saat parse
const escapeMarkdownV2 = (text = '') =>
  String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');

// Strategi aman untuk pesan MarkdownV2: tulis teks polos dengan sentinel untuk
// marker bold/italic/code, escape SELURUH teks, lalu ganti sentinel dengan
// karakter markdown literal. Semua karakter khusus (termasuk di teks dinamis)
// otomatis ke-escape; marker markdown tetap berfungsi.
const MD_BOLD = '\u0000';
const MD_ITALIC = '\u0001';
const MD_CODE = '\u0002';
const toMarkdownV2 = (text) =>
  escapeMarkdownV2(text)
    .split(MD_BOLD)
    .join('*')
    .split(MD_ITALIC)
    .join('_')
    .split(MD_CODE)
    .join('`');

const mapOpenRouterError = (status, body) => {
  const short = body.length > 200 ? `${body.slice(0, 200)}...` : body;
  if (status === 429) {
    // Ambil alasan + waktu reset dari metadata OpenRouter (X-RateLimit-Reset, ms).
    // Metadata bisa kosong (mis. request dengan tools) → estimasi reset = 00:00 UTC berikutnya.
    let resetWib = null;
    let reason = 'rate limit';
    try {
      const err = JSON.parse(body);
      const m = (err?.error?.message || '').match(/exceeded:\s*([^.]+)/);
      if (m) reason = m[1].trim();
      const resetMs = err?.error?.metadata?.headers?.['X-RateLimit-Reset'];
      if (resetMs) resetWib = new Date(Number(resetMs)).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    } catch {}
    if (!resetWib) {
      const now = new Date();
      const nextUtcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
      resetWib = nextUtcMidnight.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    }
    return `Rate limit (${reason}), reset: ${resetWib} WIB - coba lagi setelah itu`;
  }
  switch (status) {
    case 401:
      return 'API key OpenRouter tidak valid';
    case 402:
      return 'Kredit OpenRouter habis';
    case 400:
      return `Model tidak ditemukan atau tidak mendukung tool calling (${short})`;
    default:
      return `OpenRouter ${status}: ${short}`;
  }
};

// === STATUS CHECK: web health + OpenRouter API key (/auth/key) + kredit (/credits) ===
const fetchWithTimeout = async (url, options = {}, timeoutMs = 10000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

// Health check endpoint bot sendiri (GET /) — ukur latensi
const checkWebHealth = async (timeoutMs = 5000) => {
  const port = process.env.PORT || 3000;
  const start = Date.now();
  try {
    const resp = await fetchWithTimeout(`http://127.0.0.1:${port}/`, {}, timeoutMs);
    return { ok: resp.ok, latencyMs: Date.now() - start };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  }
};

// Cek status komprehensif (parallel, tiap check punya timeout sendiri).
// Promise.allSettled: satu check gagal tidak menggagalkan yang lain (partial data).
// Endpoint OpenRouter untuk API key biasa (bukan management key):
//   GET /auth/key  → validasi key + limit + free_model_daily_requests (used/limit/remaining)
//   GET /credits   → total kredit terpakai (lifetime)
// (Catatan: /usage & /activity tidak tersedia untuk API key biasa → 404/403)
const checkOpenRouterStatus = async (timeoutMs = 10000) => {
  const headers = OPENROUTER_API_KEY ? { Authorization: `Bearer ${OPENROUTER_API_KEY}` } : {};
  const noKey = () => Promise.reject(new Error('OPENROUTER_API_KEY belum diset'));

  const [web, keyResp, creditsResp] = await Promise.allSettled([
    checkWebHealth(5000),
    OPENROUTER_API_KEY ? fetchWithTimeout(`${OPENROUTER_API_BASE}/auth/key`, { headers }, timeoutMs) : noKey(),
    OPENROUTER_API_KEY ? fetchWithTimeout(`${OPENROUTER_API_BASE}/credits`, { headers }, timeoutMs) : noKey(),
  ]);

  const result = {
    web: web.status === 'fulfilled' ? web.value : { ok: false, error: web.reason?.message || 'unknown' },
    timestamp: new Date().toISOString(),
  };

  // API key: GET /auth/key (validasi + kuota free tier harian + kredit)
  if (keyResp.status === 'rejected') {
    result.apiKey = {
      valid: false,
      error: keyResp.reason?.name === 'AbortError' ? 'OpenRouter unavailable (timeout)' : keyResp.reason?.message || 'error',
    };
  } else {
    const resp = keyResp.value;
    if (resp.status === 401 || resp.status === 403) {
      result.apiKey = { valid: false, error: 'API key tidak valid' };
    } else if (resp.status === 429) {
      result.apiKey = { valid: false, error: 'rate limit (429)' }; // fallback ke counter internal
    } else if (!resp.ok) {
      result.apiKey = { valid: false, error: `OpenRouter HTTP ${resp.status}` };
    } else {
      const data = await resp.json().catch(() => ({}));
      const d = data.data || {};
      const freeDaily = d.free_model_daily_requests
        ? {
            used: Number(d.free_model_daily_requests.used) || 0,
            limit: Number(d.free_model_daily_requests.limit) || 0,
            remaining: Number(d.free_model_daily_requests.remaining) || 0,
          }
        : null;
      result.apiKey = {
        valid: true,
        isFreeTier: d.is_free_tier ?? null,
        creditUsage: d.usage ?? null,
        creditUsageDaily: d.usage_daily ?? null,
        creditLimit: d.limit ?? null,
        freeDaily,
      };
    }
  }

  // Kredit: GET /credits (total lifetime)
  if (creditsResp.status === 'rejected') {
    result.credits = {
      error:
        creditsResp.reason?.name === 'AbortError' ? 'OpenRouter unavailable (timeout)' : creditsResp.reason?.message || 'error',
    };
  } else {
    const resp = creditsResp.value;
    if (resp.status === 429) {
      result.credits = { error: 'rate_limit' };
    } else if (!resp.ok) {
      result.credits = { error: `OpenRouter HTTP ${resp.status}` };
    } else {
      const data = await resp.json().catch(() => ({}));
      const d = data.data || {};
      result.credits = { totalCredits: d.total_credits ?? null, totalUsage: d.total_usage ?? null };
    }
  }

  return result;
};

// Deteksi query yang meminta informasi terkini (untuk memicu retry jika model tidak search)
const CURRENT_INFO_RE = /(terbaru|terkini|saat ini|hari ini|sekarang|kini|berita|news|carikan|cari|update|kabar|informasi|info)/i;

// Satu panggilan ke OpenRouter; messages = [system, ...riwayat, user]; return { answer, searched }
const callOpenRouter = async (model, messages, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
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
        messages,
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
  bumpAiUsage(); // request sudah sampai OpenRouter → masuk kuota harian
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(mapOpenRouterError(resp.status, errText));
  }
  const data = await resp.json();
  const answer = data.choices?.[0]?.message?.content?.trim() || '(response kosong)';
  // Sinyal reliable apakah web search benar-benar dijalankan
  const searched =
    (data.usage?.server_tool_use_details?.web_search_requests || 0) > 0 ||
    (data.choices?.[0]?.message?.annotations || []).length > 0;
  return { answer, searched };
};

// Batas riwayat yang dikirim ke model (hemat token & aman dari limit context)
const HISTORY_LIMIT = 20;

const askAI = async (prompt, modelOverride, chatId, history = []) => {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY belum diset di environment variables');
  }
  const model = modelOverride || getModelForChat(chatId) || AI_MODEL;
  const recent = history.slice(-HISTORY_LIMIT);
  const buildMessages = (userContent) => [
    { role: 'system', content: buildSystemPrompt() },
    ...recent,
    { role: 'user', content: userContent },
  ];
  const start = Date.now();
  const first = await callOpenRouter(model, buildMessages(prompt), 40_000);
  // Jika query minta info terkini tapi model tidak search (balas cepat tanpa sumber),
  // retry sekali dengan riwayat + instruksi eksplisit. Budget total tetap < 60s (limit Vercel).
  if (!first.searched && CURRENT_INFO_RE.test(prompt) && Date.now() - start < 20_000) {
    const retryPrompt =
      `Wajib gunakan tool web_search untuk mencari informasi terkini di web, ` +
      `lalu jawab berdasarkan hasil pencarian dengan mencantumkan sumber URL.\n\n` +
      `Pertanyaan: ${prompt}`;
    const second = await callOpenRouter(model, buildMessages(retryPrompt), 30_000);
    return second.answer;
  }
  return first.answer;
};

// === ENDPOINT 3: TANYA AI VIA API ===
app.post('/api/ask', checkSecret, async (req, res) => {
  try {
    const { prompt, model, history } = req.body || {};
    if (!prompt) {
      return res.status(400).json({ ok: false, message: 'prompt required' });
    }
    // Riwayat opsional (stateless): hanya pesan user/assistant dengan content string
    const safeHistory = Array.isArray(history)
      ? history.filter((m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'))
      : [];
    const answer = await askAI(prompt, model, undefined, safeHistory);
    res.json({ ok: true, answer, usage: getAiUsage() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// === ENDPOINT: CEK STATUS VIA API (GET /api/status) ===
// Untuk test lokal & monitoring: balasan berisi data status + teks laporan MarkdownV2
// (teks yang sama persis yang dikirim command /status di Telegram)
app.get('/api/status', checkSecret, async (req, res) => {
  try {
    const status = await checkOpenRouterStatus();
    res.json({ ok: true, status, report: formatStatusReport(status, undefined) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// === COMMAND: /ask <pertanyaan> (pakai session aktif + riwayat) ===
bot.command('ask', async (ctx) => {
  const prompt = (ctx.message.text || '').replace(/^\/ask(@\w+)?\s*/i, '').trim();
  if (!prompt) {
    return ctx.reply('Pakai format: /ask <pertanyaan>\nContoh: /ask apa itu API?');
  }
  const session = getActiveSession(ctx.chat.id);
  session.messages.push({ role: 'user', content: prompt });
  const history = session.messages.slice(0, -1); // riwayat sebelum pesan ini
  const statusMsg = await ctx.reply('⏳ Sedang berpikir...');
  try {
    const answer = await askAI(prompt, undefined, ctx.chat.id, history);
    session.messages.push({ role: 'assistant', content: answer }); // riwayat tetap bersih (tanpa footer)
    const chunks = chunkText(`[Session #${session.id} | ${session.title}]\n${answer}${usageFooter()}`);
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, '', chunks[0]);
    for (let i = 1; i < chunks.length; i++) {
      await ctx.reply(chunks[i]);
    }
  } catch (err) {
    // Jangan append pesan assistant: riwayat tetap valid untuk percakapan berikutnya
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

// === COMMAND: /new <judul> — buat session baru ===
bot.command('new', async (ctx) => {
  const title = (ctx.message.text || '').replace(/^\/new(@\w+)?\s*/i, '').trim();
  const session = createSession(title);
  activeSession.set(ctx.chat.id, session.id);
  await ctx.reply(`[Session #${session.id}] ${session.title} dibuat. Session aktif sekarang.`);
});

// === COMMAND: /sessions — list semua session ===
bot.command('sessions', async (ctx) => {
  const list = listSessions();
  if (!list.length) {
    return ctx.reply('Belum ada session. Buat dengan /new <judul>.');
  }
  const activeId = activeSession.get(ctx.chat.id);
  const lines = list.map((s) =>
    s.id === activeId ? `#${s.id} - ${s.title} (aktif)` : `#${s.id} - ${s.title} (${s.messages.length} pesan)`
  );
  await ctx.reply(`Session:\n${lines.join('\n')}\n\nGanti: /use <id>`);
});

// === COMMAND: /use <id> — set session aktif ===
bot.command('use', async (ctx) => {
  const arg = (ctx.message.text || '').replace(/^\/use(@\w+)?\s*/i, '').trim();
  const id = Number.parseInt(arg, 10);
  if (!Number.isInteger(id) || !sessions.has(id)) {
    const list = listSessions().map((s) => `#${s.id} - ${s.title}`).join('\n');
    return ctx.reply(`Session "${arg}" tidak ditemukan.\nSession tersedia:\n${list || '(belum ada)'}`);
  }
  activeSession.set(ctx.chat.id, id);
  const s = sessions.get(id);
  await ctx.reply(`Session aktif: #${s.id} - ${s.title}`);
});

// === COMMAND: /status — status komprehensif (web + API key + usage OpenRouter + kuota) ===
const fmtNum = (n) => Number(n || 0).toLocaleString('id-ID');
const fmtCost = (n) => `$${Number(n || 0).toFixed(3)}`;

// Format laporan status jadi MarkdownV2 (teks polos + sentinel, lihat toMarkdownV2)
const formatStatusReport = (status, chatId) => {
  const time = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const lines = [`📊 ${MD_BOLD}Status Bot${MD_BOLD} (${time} WIB)`, ''];

  lines.push(
    status.web?.ok
      ? `🌐 ${MD_BOLD}Web Status${MD_BOLD}: ✅ UP (${status.web.latencyMs}ms)`
      : `🌐 ${MD_BOLD}Web Status${MD_BOLD}: ❌ DOWN`
  );

  if (status.apiKey?.valid) {
    let line = `🔑 ${MD_BOLD}API Key${MD_BOLD}: ✅ Valid`;
    if (status.apiKey.isFreeTier) line += ' (Free Tier)';
    lines.push(line);
    if (status.apiKey.freeDaily) {
      const f = status.apiKey.freeDaily;
      const note = f.remaining > 0 ? `(sisa ${fmtNum(f.remaining)})` : '(⚠️ kuota habis, reset harian 00:00 UTC / 07:00 WIB)';
      lines.push(`📊 ${MD_BOLD}Free Tier Hari Ini${MD_BOLD}: ${fmtNum(f.used)}/${fmtNum(f.limit)} request ${note}`);
    }
    if (status.credits && !status.credits.error && status.credits.totalUsage != null) {
      lines.push(
        `💳 ${MD_BOLD}Kredit${MD_BOLD}: ${fmtCost(status.apiKey.creditUsageDaily ?? 0)} hari ini | ${fmtCost(status.credits.totalUsage)} total`
      );
    }
  } else {
    lines.push(`🔑 ${MD_BOLD}API Key${MD_BOLD}: ❌ ${status.apiKey?.error || 'tidak valid'}`);
    // Fallback: kuota tetap terlihat dari counter internal di footer
  }

  lines.push('');
  lines.push(`⚡ ${MD_BOLD}Model aktif${MD_BOLD}: ${getModelForChat(chatId) || AI_MODEL}`);
  const activeId = activeSession.get(chatId);
  const active = activeId != null ? sessions.get(activeId) : undefined;
  lines.push(
    active
      ? `💬 ${MD_BOLD}Session aktif${MD_BOLD}: #${active.id} | ${active.title}`
      : `💬 ${MD_BOLD}Session aktif${MD_BOLD}: (belum ada, otomatis dibuat saat /ask)`
  );

  const u = getAiUsage();
  lines.push(`📊 ${MD_BOLD}Kuota AI hari ini${MD_BOLD}: ${u.today}/${u.limit} request (${u.percent}%)`);
  return toMarkdownV2(lines.join('\n'));
};

bot.command('status', async (ctx) => {
  const statusMsg = await ctx.reply('⏳ Mengecek status...');
  try {
    const status = await checkOpenRouterStatus();
    const chunks = chunkText(formatStatusReport(status, ctx.chat.id));
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, '', chunks[0], {
      parse_mode: 'MarkdownV2',
    });
    for (let i = 1; i < chunks.length; i++) {
      await ctx.telegram.sendMessage(ctx.chat.id, chunks[i], { parse_mode: 'MarkdownV2' });
    }
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, '', `⚠️ Error: ${err.message}`);
  }
});

// === CATCH-ALL: balas "oke" untuk semua pesan teks selain command ===
bot.on('text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return;
  await ctx.reply('oke');
});

// === FORMAT PESAN ===
const formatMessage = ({ title, content, url }) => {
  const t = title || 'Notifikasi';
  // Rapatkan whitespace agar rapi di code span (monospace)
  const c = String(content ?? '').replace(/\s+/g, ' ').trim() || '-';
  const time = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

  const lines = [
    `${MD_BOLD}${t}${MD_BOLD}`,
    '────────────────',
    `${MD_CODE}${c}${MD_CODE}`,
  ];

  if (url) lines.push(`🔗 [Buka Link](${url})`);

  lines.push(`${MD_ITALIC}🕒 ${time} WIB${MD_ITALIC}`);
  return toMarkdownV2(lines.join('\n'));
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
