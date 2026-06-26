# Voice Agent

Simple voice agent using Cloudflare Worker + Pages.

- Browser Web Speech API (mic + TTS)
- Backend: Groq (Llama) primary + Grok (xAI) fallback
- Local development with Wrangler
- Minimal and clean

## Setup

1. Install dependencies (none for the frontend, Wrangler for backend)

2. Set secrets (per-Worker):

```bash
npx wrangler secret put XAI_API_KEY
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put ACCESS_TOKEN   # strong random value, e.g. `openssl rand -hex 32`
```

(You will be prompted for the values.)

Or add them in the dashboard for the Worker: Settings > Variables and Secrets > Secrets > Add secret.

For local development, create `.dev.vars`:

```env
GROQ_API_KEY=your_groq_key_here
XAI_API_KEY=your_xai_api_key_here
ACCESS_TOKEN=your-strong-random-token-here
```

## Local Development

```bash
# Terminal 1 - Backend
wrangler dev

# Terminal 2 (optional) - Serve frontend
cd public && python3 -m http.server 5173
```

Open http://localhost:5173 (or open `public/index.html` directly) and set the **Backend URL** to `http://localhost:8787` in the UI.

The Settings modal now also includes:
- **Temperament** slider (Kind ↔ Angry) that affects both the LLM's response style and the voice delivery.
- **PWA features**: The app is now a full Progressive Web App. Install from Chrome menu ("Add to home screen" / Install app) on Android for standalone experience with splash screen.
- **Persistent permissions button**: Request camera & mic access. On Pixel, make them persistent via Android App info > Permissions > Allow.

**Splash screen**: Uses the 512x512 icon + black background_color. Replace the placeholder icons in `public/manifest.json` with real PNGs (192x192 and 512x512) for a custom branded splash on launch.

**Service worker**: Basic offline support for the app shell.

## Deploy

### Deploy Worker (Backend)

```bash
npx wrangler deploy
```

### Deploy Pages (Frontend)

```bash
npx wrangler pages deploy public --project-name voice-agent
```

After deploy, open the **stable** app URL (below) — not per-deploy preview hash links.

## Auth (Google Sign-In)

### 1. Google Cloud Console

1. Go to https://console.cloud.google.com/
2. **APIs & Services → OAuth consent screen** — External, add yourself as a test user if in Testing mode.
3. **Credentials → Create OAuth client ID → Web application**
4. **Authorized JavaScript origins** (exact match required):
   - `https://xylaphonetango.com`
   - `http://localhost:5173` (local dev only)
5. **Authorized redirect URIs:** leave empty (GSI button uses a JS callback, not redirect).
6. Client ID is already in `wrangler.toml` and `public/index.html`.

### 2. Custom domain

**Always open:** https://xylaphonetango.com

Custom domain is attached to the Cloudflare Pages project `voice-agent`. If DNS is still pending, finish activation in the dashboard: Workers & Pages → voice-agent → Custom domains.

Do not use per-deploy `*.pages.dev` preview URLs for Google OAuth — they change every deploy.

On Pixel PWA: sign in via “Sign in via Chrome”, then return to the app.

### Current URLs

- **App:** https://xylaphonetango.com
- **Public demo (no sign-in):** https://xylaphonetango.com/demo.html
- **Demo API stream:** https://voice-agent-backend.7zzkwwb7hd.workers.dev/demo
- **Worker:** https://voice-agent-backend.7zzkwwb7hd.workers.dev
- **Source:** https://github.com/CloudCay/xylaphone-tango

## Notes

- The Worker is the API only.
- All secrets are handled server-side.
- Works best in Chrome / Edge (best Web Speech API support).
- Groq is used for speed. Falls back to Grok on error.

## Project Structure

```
voice-agent/
├── wrangler.toml
├── src/
│   └── index.ts
├── public/
│   └── index.html
└── README.md
```