# Deploy MBBS Revision to the internet

The app now stores everything **server-side (SQLite)** and has **password login**, so
any device you log in from sees the same lessons, cards, mistakes and progress.

Pick one option below. In every case you must set a strong `PASSWORD`.

---

## Option A — Railway (easiest, recommended)

1. Push this folder to a **GitHub** repository (do **not** commit `data/` or `config.json` — they're ignored anyway).
2. Go to <https://railway.app> → **New Project → Deploy from GitHub repo** → select your repo.
3. In the service **Variables** tab, add:
   - `PASSWORD` = a strong password you'll use to log in
4. Add a **Volume** mounted at `/app/data` (this keeps your data + API keys across redeploys).
5. Railway auto-detects the `Dockerfile`. Deploy → you get a `https://…​.up.railway.app` URL.

Open that URL, log in with `PASSWORD`, then fill your DeepSeek + Bailian keys in **Settings**.

---

## Option B — Docker on any VPS (Alibaba Cloud HK / DigitalOcean / Hetzner …)

On the server (with Docker installed):

```bash
git clone <your-repo> mbbs && cd mbbs
docker build -t mbbs .
docker run -d --name mbbs \
  -p 80:8756 \
  -v mbbs-data:/app/data \
  -e PASSWORD='a-strong-password-here' \
  --restart unless-stopped \
  mbbs
```

Then visit `http://<server-ip>`. For **HTTPS**, put Caddy or Nginx + a domain in front, or
enable Cloudflare's orange-cloud proxy.

> `mbbs-data` is a named volume holding `data/config.json` (your API keys) + `data/data.db`
> (all your study data). Back it up with `docker run --rm -v mbbs-data:/d -v $(pwd):/b alpine tar czf /b/mbbs-backup.tgz -C /d .`

---

## Option C — Render

Similar to Railway: new Web Service → connect repo → set `PASSWORD` env var → add a
persistent disk mounted at `/app/data` → Deploy.

---

## After deploying (all options)

1. Log in with your `PASSWORD`.
2. **Settings** → paste your two API keys (they're saved to the server, shared across devices):
   - Text: `https://api.deepseek.com` · `deepseek-v4-pro`
   - Vision: `https://dashscope.aliyuncs.com/compatible-mode/v1` · `qwen-vl-max`
3. **Settings → Account** → change the password to something only you know.
4. Log in from your other computer with the same URL + password — same data, everywhere.

## Security notes

- Every `/api/*` endpoint requires the password; only the login page is public.
- API keys live in `data/config.json` on the server, never in the browser. Keep that file private (`chmod 600`).
- Set a strong `PASSWORD` env var — never rely on the default (`mbbs1234`).
- Login has a per-IP backoff (10 failed attempts within 5 minutes = 429), and changing your password rotates the session secret so previously issued logins stop working.
- Put the app behind HTTPS when exposing it to the internet (Railway/Render do this automatically).
