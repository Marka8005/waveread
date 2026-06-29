# WaveRead — Milestone 1

A web app (PWA) that reads a chart screenshot and returns a trade plan
(Wyckoff + Elliott Wave + Fibonacci). Free, capped, with a secure backend
that keeps your API key off the browser.

## What's here

```
index.html              the app (frontend)
api/analyze.js          the backend — holds the key, calls Claude, enforces the cap
manifest.webmanifest    PWA manifest (home-screen install)
sw.js                   service worker (installability)
icon-192/512.png        app icons
apple-touch-icon.png    iOS home-screen icon
```

## Deploy (Vercel — free)

1. Create an Anthropic API key at https://console.anthropic.com → API keys.
2. **Set a low monthly spending limit on that account** (Billing → limits).
   This is your real backstop: even if the cap is bypassed, your bill can't
   run past the number you set. Start small, e.g. a few dollars.
3. Push this folder to a GitHub repo.
4. Go to https://vercel.com, import the repo.
5. In Vercel project settings → Environment Variables, add:
   `ANTHROPIC_API_KEY = sk-ant-...`
6. Deploy. You get a live URL like `waveread.vercel.app`.
7. (Optional) Add a custom domain in Vercel → Domains (e.g. waveread.se,
   bought at Loopia / One.com / Namecheap for ~100–150 kr/year).

Netlify works the same way (env var + import); the `api/` folder maps to
Netlify Functions with a tiny tweak — ask if you go that route.

## The free cap

`api/analyze.js` allows **5 free analyses per visitor per day**, plus a
**global ceiling of 500/day** as a safety valve. This is best-effort
(in-memory): it resets when the server restarts, so it's a soft cap, not
bulletproof. The Anthropic spending limit in step 2 is the hard backstop.

### Durable cap (when you want it)

For a cap that survives restarts (needed before any real launch), add a
free Upstash Redis store and swap the in-memory `Map` for a Redis counter
keyed by `day:ip`. Two env vars and ~15 lines. Say the word and I'll wire it.

## Notes

- The frontend downscales images to max 1600px before upload — smaller
  payloads and lower token cost per analysis.
- The protocol lives server-side in `api/analyze.js`, so it isn't exposed
  to users in the browser.
- No payment yet — that's Milestone 2 (Stripe + tiers).
