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
  ctx.reply('Gunakan /start untuk memulai.\nNotifikasi dikirim via POST /api/send dengan body { title, content, url, chat_id? }.')
);

// === SECURITY MIDDLEWARE ===
const checkSecret = (req, res, next) => {
  if (req.headers['x-api-secret'] !== process.env.API_SECRET) {
    return res.status(401).json({ ok: false, message: 'Unauthorized' });
  }
  next();
};

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
app.use('/api/webhook', bot.webhookCallback('/api/webhook'));

// === HEALTH CHECK ===
app.get('/', (req, res) => res.send('Bot running!'));

// === LOCAL DEV ===
// Di Vercel, framework yang serve app ini (NODE_ENV=production), jadi listen hanya untuk local dev
if (process.env.NODE_ENV !== 'production') {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Server lokal berjalan di http://localhost:${port}`));
}

export default app;
