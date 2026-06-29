// WaveRead backend — server-side. Holds the API key, enforces a free daily
// cap, and calls Claude with forced tool-use. The model supplies RAW NUMBERS
// (swing, entry, target prices, stop); the SERVER computes the Fibonacci
// ladder and the target percentages deterministically, so the math is always
// internally consistent — no LLM mental-arithmetic in the trust-critical path.

const SYSTEM = `You are a trading analyst applying a strict protocol (Elliott Wave + Wyckoff + Fibonacci) to a candlestick chart image. Work in ENGLISH.

Method:
1. Read latest candle OHLC + % change.
2. List the last 5 candle lows. Lowest = latest SSL test.
3. Wyckoff phase (note SC/spring if seen).
4. Count waves W1->W5 from the SC low, left->right. Never assume W3 without verifying.
5. Identify the swing being retraced for the active entry: give swing_low and swing_high (the move whose Fib retracement matters). Entry must be at a standard Fib level (38.2/50/61.8/78.6%). If current price is between levels, decision = WAIT and entry_price = the level you'd wait for.
6. Never say "wait for X" if price has already traded at X (check the last 5 lows).
7. Give target prices T1/T2/T3 as raw numbers (targets_px). Give stop_price as a raw number.

IMPORTANT: You provide RAW NUMBERS only. Do NOT compute Fib levels or percentages yourself — the system does that. Just give swing_low, swing_high, entry_price, targets_px, stop_price as plain numbers, and make sure stop_reason is consistent with stop_price.

Keep every text field to ONE short line, readable on a phone. decision_note = a short action sentence; do NOT put specific level numbers in it (the numeric fields carry those). No time estimates. If the image isn't sharp enough for exact levels, say so in warnings. Report via the report_trade_plan tool.`;

const TOOL = {
  name: 'report_trade_plan',
  description: 'Report the chart analysis. Supply raw numbers; the system computes Fib levels and target %.',
  input_schema: {
    type: 'object',
    properties: {
      ticker: { type: 'string' },
      timeframe: { type: 'string' },
      ohlc: { type: 'object', properties: { open: { type: 'string' }, high: { type: 'string' }, low: { type: 'string' }, close: { type: 'string' }, change: { type: 'string' } } },
      last5lows: { type: 'array', items: { type: 'string' } },
      ssl_test: { type: 'string', description: 'One short line' },
      wyckoff: { type: 'string', description: 'One short line' },
      waves: { type: 'string', description: 'Compact: W1 a->b | W2 c | W3 ... | W5 pending' },
      subwave: { type: 'string', description: 'One short line' },
      swing_low: { type: 'number', description: 'Low of the move being retraced for entry' },
      swing_high: { type: 'number', description: 'High of that move' },
      entry_price: { type: 'number', description: 'Planned entry. On WAIT, the level to wait for.' },
      targets_px: { type: 'array', items: { type: 'number' }, description: 'T1..T3 target prices' },
      stop_price: { type: 'number' },
      stop_reason: { type: 'string', description: 'One short line, consistent with stop_price' },
      volume: { type: 'string', description: 'One short line' },
      decision: { type: 'string', enum: ['BUY', 'WAIT', 'AVOID'] },
      decision_note: { type: 'string', description: 'Short action sentence, no level numbers' },
      warnings: { type: 'array', items: { type: 'string' } },
    },
    required: ['decision', 'decision_note'],
  },
};

const DAILY_CAP = 5;
const GLOBAL_DAILY_CAP = 500;
const ipHits = new Map();
let globalCount = 0;
let currentDay = null;
function today() { return new Date().toISOString().slice(0, 10); }

function num(x) {
  if (x == null) return null;
  const n = parseFloat(String(x).replace(/[^0-9.\-]/g, ''));
  return isFinite(n) ? n : null;
}
function fmt(n) { return (Math.round(n * 100) / 100).toString(); }

// Build the display result with server-computed Fib ladder + target %.
function compute(input) {
  const lo = num(input.swing_low), hi = num(input.swing_high);
  const ep = num(input.entry_price);
  const sp = num(input.stop_price);

  let ladder = null, fib_ladder;
  if (lo != null && hi != null && hi > lo) {
    ladder = [38.2, 50, 61.8, 78.6].map((p) => ({ p, price: hi - (p / 100) * (hi - lo) }));
    fib_ladder = `(${fmt(lo)}→${fmt(hi)})  ` + ladder.map((l) => `${l.p}% ${fmt(l.price)}`).join('  ·  ');
  }

  let entry;
  if (ep != null) {
    let label = 'between levels — not a standard Fib';
    if (ladder) {
      const near = ladder.find((l) => Math.abs(ep - l.price) / l.price <= 0.02);
      if (near) label = `${near.p}% Fib`;
    }
    entry = `${fmt(ep)} · ${label}`;
  } else {
    entry = 'No confirmed entry';
  }

  let targets = [];
  const tps = Array.isArray(input.targets_px) ? input.targets_px.map(num).filter((v) => v != null) : [];
  if (tps.length) {
    targets = tps.slice(0, 3).map((tp, i) => {
      let pct = '';
      if (ep != null && ep !== 0) {
        const v = ((tp - ep) / ep) * 100;
        pct = (v >= 0 ? '+' : '') + (Math.round(v * 10) / 10) + '%';
      }
      return { label: 'T' + (i + 1), price: fmt(tp), pct };
    });
  }

  const stop = sp != null ? fmt(sp) : '—';

  return {
    ticker: input.ticker, timeframe: input.timeframe, ohlc: input.ohlc,
    last5lows: input.last5lows, ssl_test: input.ssl_test,
    wyckoff: input.wyckoff, waves: input.waves, subwave: input.subwave,
    fib_ladder, entry, targets, stop, stop_reason: input.stop_reason,
    volume: input.volume, decision: input.decision, decision_note: input.decision_note,
    warnings: input.warnings,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const day = today();
  if (currentDay !== day) { currentDay = day; globalCount = 0; ipHits.clear(); }
  if (globalCount >= GLOBAL_DAILY_CAP) return res.status(429).json({ error: 'Daily capacity reached. Try again tomorrow.', limit: true });
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const ipKey = day + ':' + ip;
  const used = ipHits.get(ipKey) || 0;
  if (used >= DAILY_CAP) return res.status(429).json({ error: 'Free limit reached for today.', limit: true, cap: DAILY_CAP });

  const { image, mime, ticker, tf, ohlc } = req.body || {};
  if (!image || !mime) return res.status(400).json({ error: 'Missing image.' });

  const ctx = [];
  if (ticker) ctx.push('Ticker: ' + ticker);
  if (tf) ctx.push('Timeframe: ' + tf);
  if (ohlc) ctx.push('User-provided OHLC/levels:\n' + ohlc);
  const userText = (ctx.length ? ctx.join('\n') + '\n\n' : '') + 'Analyze the chart in the image and report via the tool.';

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 1024, system: SYSTEM,
        tools: [TOOL], tool_choice: { type: 'tool', name: 'report_trade_plan' },
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data: image } },
          { type: 'text', text: userText },
        ] }],
      }),
    });

    if (!r.ok) {
      const detail = (await r.text()).slice(0, 300);
      return res.status(502).json({ error: 'Upstream error from the model.', detail });
    }

    const data = await r.json();
    const block = (data.content || []).find((b) => b.type === 'tool_use');
    if (!block || !block.input) return res.status(502).json({ error: 'No analysis produced. Try a clearer image.' });

    ipHits.set(ipKey, used + 1);
    globalCount++;

    return res.status(200).json({ result: compute(block.input), used: used + 1, cap: DAILY_CAP });
  } catch (e) {
    return res.status(500).json({ error: 'Server error.' });
  }
}
