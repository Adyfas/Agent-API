# Catatan Planning — Lanjutan Project (Websearch + /model)

Update terakhir: 2026-10-04 ~15:40 WIB

## Status Saat Ini

| Item | Status |
|---|---|
| Kode websearch + /model di `index.js` | ✅ Selesai (BELUM di-commit) |
| `vercel.json` (maxDuration 60) | ✅ Selesai (BELUM di-commit) |
| `.env.example` (template key + komentar) | ✅ Selesai (BELUM di-commit) |
| `.env` lokal (key + model free) | ✅ Terisi |
| Test lokal T1-T4, T9-T17 | ✅ LULUS (12/17) |
| Test AI T5-T8, T12 | ⏸️ WAITING — kuota free tier OpenRouter habis, reset 00:03 WIB |
| Commit + push + deploy | ⏸️ Belum (nanti setelah test AI lulus) |

## Keputusan yang Sudah Dibuat
- **Scope**: websearch + command `/model` (list/set/reset)
- **Pendekatan websearch**: OpenRouter server tool `openrouter:web_search` — OpenRouter yang menjalankan search (engine auto: native provider / fallback Exa), model memutuskan kapan search. Tidak ada tool loop di kode kita.
- **Model**: SEMUA FREE (permintaan user) — daftar di `AVAILABLE_MODELS` hanya model `:free` yang support tool calling. Default dari env `AI_MODEL=apodex/apodex-1.1-mini:free`.
- **State /model**: in-memory per chat; reset saat cold start di Vercel (diterima, tercatat di teks bantuan).
- **Timeout**: fetch 55 detik; `maxDuration: 60` di vercel.json (batas Vercel Hobby).
- **Balasan panjang**: chunking 4096 char (limit Telegram).

## Fakta Penting (baca dulu sebelum lanjut)
1. **Free tier OpenRouter**: 50 request model/hari (tanpa kredit). Reset harian ~00:00 WIB. Kalau sudah $10 kredit: 1000 request/hari.
2. **Websearch BUKAN free**: engine Exa $0.005 per search call, dipotong dari kredit OpenRouter. Tanpa kredit, request yang memicu search akan gagal dengan 402 → bot menampilkan error ramah "Kredit OpenRouter habis". Ini expected, bukan bug.
3. **Biaya kalau top-up $10**: ~1000-2000 pertanyaan termasuk websearch. Sangat murah.
4. `.env` gitignored — JANGAN PERNAH di-commit (berisi BOT_TOKEN + API key).

## Langkah Lanjutan (besok)

### 1. Pastikan kuota free sudah reset (setelah 00:03 WIB)
```bash
source .env && curl -s https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer ${OPENROUTER_API_KEY}" -H "Content-Type: application/json" \
  -d '{"model":"apodex/apodex-1.1-mini:free","messages":[{"role":"user","content":"halo"}]}' | head -c 200
```
Harus 200. Kalau masih 429, tunggu reset harian.

### 2. Jalankan server lokal
```bash
set -a && source .env && set +a && node index.js
```

### 3. Ulangi test AI yang tertunda
| # | Test | Expected |
|---|---|---|
| T6 | `POST /api/ask` (secret) `{"prompt":"apa itu HTTP? jawab singkat"}` | 200 `{ok:true,answer}` |
| T5 | `POST /api/ask` (secret) `{"prompt":"berita AI terbaru hari ini, sertakan sumbernya"}` | Tanpa kredit: 500 "Kredit OpenRouter habis" (expected). Dengan kredit: 200 + jawaban ber-citation |
| T8 | Simulasi webhook: `POST /api/webhook` body `{"update_id":999300,"message":{"message_id":40,"from":{"id":7025713080,"is_bot":false,"first_name":"CodeSantai","username":"codesantai"},"chat":{"id":7025713080,"first_name":"CodeSantai","username":"codesantai","type":"private"},"date":1791200000,"text":"/ask apa itu API"}}` | 200 + jawaban masuk chat Telegram |
| T12 | Webhook `/model set qwen/qwen3.8-27b:free` lalu `/ask apa itu API` | Model baru dipakai |

### 4. Commit + push (hanya jika test lulus)
```bash
git status   # PASTIKAN .env TIDAK muncul
git add index.js vercel.json .env.example PLANNING.md
git commit -m "Add websearch tool and /model command (free tier models)"
git push
```

### 5. Verifikasi produksi
- Tunggu build Vercel 2-3 menit → `curl https://agentadyfas.vercel.app/` harus 200 "Bot running!"
- `POST https://agentadyfas.vercel.app/api/ask` dengan header `x-api-secret: agentadyfas` + prompt sederhana
- Telegram asli ke @adyfas_apibot: `/ask apa itu API`, `/model list`, `/model set qwen/qwen3.8-27b:free`, `/ask` lagi, `/model reset`
- Cek Vercel logs: tidak ada error

### 6. (Opsional, disarankan) Top-up kredit OpenRouter
- openrouter.ai → Credits → minimal $10
- Efek: 1000 request free model/hari + websearch berfungsi penuh
- Tanpa langkah ini: /ask basic jalan (50x/hari), websearch selalu error "Kredit OpenRouter habis"

## Struktur Test Lengkap (17 test) — untuk referensi
T1 health `/` · T2 `/api/send` regresi · T3 `/api/ask` 401 · T4 prompt kosong 400 ·
T5 AI query search · T6 AI query basic · T7 model override · T8 webhook /ask ·
T9 `/model` · T10 `/model list` · T11 `/model set` · T12 /ask setelah set ·
T13 `/model reset` · T14 `/model set` invalid · T15 catch-all "oke" ·
T16 `/start`+`/help` · T17 key kosong 500 ramah

## Out of Scope (untuk iterasi berikutnya)
- Persisten pilihan model lintas cold start (butuh Vercel KV/Redis)
- Streaming jawaban
- Kirim gambar/file
- Dukungan grup chat
