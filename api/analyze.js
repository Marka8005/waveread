// WaveRead backend — runs on the server, never in the browser.
// Holds the API key, enforces a free daily cap, and calls Claude.
// The protocol lives here (server-side), so it is never exposed to users.

const SYSTEM = `You are a trading analyst applying a strict protocol (Elliott Wave + Wyckoff + Fibonacci) to a candlestick chart image. Reply in ENGLISH.

BE EXTREMELY CONCISE. Every text field = ONE short line, no paragraphs. This renders on a phone. Cut all filler.

Method (do internally, output only the short result):
1. Read latest candle OHLC + % change from the image.
2. List the last 5 candle lows. Lowest = latest SSL test.
3. Wyckoff phase (accumulation/markup/distribution/markdown; note SC/spring if seen).
4. Count waves W1->W5 directly from the SC low. Read all waves left->right. Never assume W3 without verifying; check if W3/W4/W5 already completed.
5. Entry ONLY at a standard Fib level of the active wave (38.2/50/61.8/78.6%). If price is between levels = not confirmed = WAIT. Never invent custom percentages.
6. If any of the last 5 lows already sits on/near (within 5%) a Fib level -> confirm and give entry there. Never say "wait for X" if price already traded at X.
7. Targets T1/T2/T3 from W1 length, 1.0/1.618/2.618 extension from the W2 low. Show as % gain from entry, never R/R.
8. Stop with a one-line reason. Decision: BUY / WAIT / AVOID.
If the image isn't sharp enough for exact levels, say so briefly in warnings and name which numbers the user should type in. No time estimates.

Output ONLY valid JSON, no markdown, no code fences, no text before/after. Keep every value SHORT:
{"ticker":"","timeframe":"","ohlc":{"open":"","high":"","low":"","close":"","change":""},"last5lows":["","","","",""],"ssl_test":"one short line","wyckoff":"one short line","waves":"W1 a->b | W2 c | W3 c->d | W4 now e | W5 pending","subwave":"one short line","entry":"price + Fib level, or 'No confirmed entry'","targets":[{"label":"T1","price":"","pct":""},{"label":"T2","price":"","pct":""},{"label":"T3","price":"","pct":""}],"stop":"","stop_reason":"one short line","volume":"one short line","decision":"BUY|WAIT|AVOID","decision_note":"one short sentence","warnings":["short, only if needed"]}`;

// --- Free-tier cap (best-effort, in-memory) ---
// Milestone 1: 5 free analyses per visitor per day, plus a global safety
// ceiling so total spend can't run away even under abuse. For a durable
// cap that survives restarts, wire Upstash Redis later (see README).
const DAILY_CAP = 5;
const GLOBAL_DAILY_CAP = 500;

const ipHits = new Map();
let globalCount = 0;
let currentDay = null;

function today() {
  return new Date().toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const day = today();
  if (currentDay !== day) {
    currentDay = day;
    globalCount = 0;
    ipHits.clear();
  }

  if (globalCount >= GLOBAL_DAILY_CAP) {
    return res.status(429).json({ error: 'Daily capacity reached. Try again tomorrow.', limit: true });
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const ipKey = day + ':' + ip;
  const used = ipHits.get(ipKey) || 0;
  if (used >= DAILY_CAP) {
    return res.status(429).json({ error: 'Free limit reached for today.', limit: true, cap: DAILY_CAP });
  }

  const { image, mime, ticker, tf, ohlc } = req.body || {};
  if (!image || !mime) {
    return res.status(400).json({ error: 'Missing image.' });
  }

  const ctx = [];
  if (ticker) ctx.push('Ticker: ' + ticker);
  if (tf) ctx.push('Timeframe: ' + tf);
  if (ohlc) ctx.push('User-provided OHLC/levels:\n' + ohlc);
  const userText = (ctx.length ? ctx.join('\n') + '\n\n' : '') + 'Analyze the chart in the image. Be concise.';

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime, data: image } },
            { type: 'text', text: userText },
          ],
        }],
      }),
    });

    if (!r.ok) {
      const detail = (await r.text()).slice(0, 300);
      return res.status(502).json({ error: 'Upstream error from the model.', detail });
    }

    const data = await r.json();
    const text = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    ipHits.set(ipKey, used + 1);
    globalCount++;

    return res.status(200).json({ text, used: used + 1, cap: DAILY_CAP });
  } catch (e) {
    return res.status(500).json({ error: 'Server error.' });
  }
}
