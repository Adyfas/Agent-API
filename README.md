# Bot Telegram Agent Message

Bot Telegram berbasis **Node.js + Express + Telegraf** dengan API notifikasi, siap deploy ke **Vercel** via Git.

## Fitur

- `POST /api/send` — menerima JSON `{ title, content, url, chat_id? }` lalu mengirim notifikasi ke Telegram dengan format **MarkdownV2** (title tebal, content monospace, link button, timestamp WIB).
- `POST /api/webhook` — webhook Telegram (bukan polling) via `bot.webhookCallback`.
- Keamanan: middleware `API_SECRET` — header `x-api-secret` harus sama dengan `process.env.API_SECRET`.
- Bot command: `/start` dan `/help`.
- Helper `escapeMarkdownV2` agar pesan MarkdownV2 tidak error.

## Struktur

```
.
├── api/
│   └── index.js      # Entry point (Express app)
├── vercel.json       # Rewrites + config serverless function
├── package.json      # type: module (ESM)
├── .env.example      # Template environment variables
└── README.md
```

## Konfigurasi

| Variabel            | Keterangan                                        |
| ------------------- | ------------------------------------------------- |
| `BOT_TOKEN`         | Token bot dari [@BotFather](https://t.me/BotFather) |
| `CHAT_ID_DEFAULT`   | Chat ID tujuan default (grup/user/channel)         |
| `API_SECRET`        | Secret untuk header `x-api-secret`                 |

## Testing Lokal

```bash
cp .env.example .env   # isi dengan nilai asli
npm install
node api/index.js
```

> Catatan: untuk testing lokal, jalankan dengan pola `BOT_TOKEN=... node api/index.js` atau gunakan `telegraf` polling sementara, karena webhook membutuhkan URL publik.

Tes kirim notifikasi:

```bash
curl -X POST http://localhost:3000/api/send \
  -H "x-api-secret: rahasia_super_aman_123" \
  -H "Content-Type: application/json" \
  -d '{"title":"Tes Berhasil","content":"Bot sudah live!"}'
```

## Deploy ke Vercel via Git

1. Push project ke GitHub:

   ```bash
   git init
   git add .
   git commit -m "init bot"
   git branch -M main
   git remote add origin https://github.com/username/bot-kamu.git
   git push -u origin main
   ```

2. Buka [vercel.com](https://vercel.com) → **Add New Project** → **Import** repo kamu.

3. Di tab **Environment Variables**, isi: `BOT_TOKEN`, `CHAT_ID_DEFAULT`, `API_SECRET`.

4. **Deploy**.

5. Setelah dapat URL, set webhook (sekali saja) — buka di browser:

   ```
   https://api.telegram.org/bot<TOKEN_KAMU>/setWebhook?url=https://URL_VERCEL_KAMU/api/webhook
   ```

6. Tes kirim:

   ```bash
   curl -X POST https://URL_VERCEL_KAMU/api/send \
     -H "x-api-secret: rahasia_super_aman_123" \
     -H "Content-Type: application/json" \
     -d '{"title":"Tes Berhasil","content":"Bot sudah live di Vercel!"}'
   ```

## Contoh Response

| Kasus        | Status | Body                                      |
| ------------ | ------ | ----------------------------------------- |
| Sukses       | 200    | `{ "ok": true }`                          |
| Secret salah | 401    | `{ "ok": false, "message": "Unauthorized" }` |
| Tanpa chat_id| 400    | `{ "ok": false, "message": "chat_id required ..." }` |
| Error kirim  | 500    | `{ "ok": false, "error": "<detail>" }`    |

## Catatan

- Webhook hanya perlu di-set ulang jika URL Vercel berubah (mis. project di-rename).
- Untuk menghapus webhook: `https://api.telegram.org/bot<TOKEN>/deleteWebhook`
