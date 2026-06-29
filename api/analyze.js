// WaveRead backend — server-side. Holds the API key, enforces a free daily
// cap, calls Claude with forced tool-use. The model supplies RAW INPUTS
// (swing, which Fib level to enter, target prices, stop, a single canonical
// wave status). The SERVER computes the Fib ladder, snaps entry to an exact
// level, computes target %, and flags price/decision contradictions — so the
// math and internal consistency never depend on the model's arithmetic.

const SYSTEM = `You are a trading analyst applying a strict protocol (Elliott Wave + Wyckoff + Fibonacci) to a candlestick chart image. Work in ENGLISH.

Method:
1. Read latest candle OHLC + % change.
2. List the last 5 candle lows. Lowest = latest SSL test.
3. Wyckoff phase (note SC/spring if seen).
4. Count waves W1->W5 from the SC low, left->right.

CONSISTENCY — THIS IS CRITICAL:
- State ONE canonical 'active_wave': which wave is in progress AND whether the prior wave has completed (e.g. "W4 complete at 1.28, W5 pending" OR "W4 in progress, still seeking its bottom"). Pick ONE.
- waves, subwave and wyckoff MUST all agree with active_wave. Never contradict yourself (do NOT say "W5 pending" in one field and "price is in W4 correction" in another).

ENTRY:
- Give swing_low and swing_high = the move whose Fib retracement defines the entry.
- Give entry_fib = the SINGLE standard level you'd enter at: 38.2, 50, 61.8 or 78.6. The system computes the exact entry price from it — do NOT give a separate price.
- Decide WAIT vs BUY by where price is NOW relative to that level: choose WAIT only if price has NOT yet reached the level (price must still travel down to it). If price has ALREADY traded at/through the level (check the last 5 lows and current price), it is NOT WAIT — the pullback already happened.

TARGETS/STOP: give target prices (targets_px) and stop_price as plain numbers. stop_reason must be consistent with stop_price.

Keep every text field to ONE short line, phone-readable. decision_note = short action sentence, no level numbers. No time estimates. If the image isn't sharp enough, say so in warnings. Report via report_trade_plan.`;

const TOOL = {
  name: 'report_trade_plan',
  description: 'Report the analysis. Supply raw inputs; the system computes Fib levels, entry price and target %.',
  input_schema: {
    type: 'object',
    properties: {
      ticker: { type: 'string' },
      timeframe: { type: 'string' },
      ohlc: { type: 'object', properties: { open: { type: 'string' }, high: { type: 'string' }, low: { type: 'string' }, close: { type: 'string' }, change: { type: 'string' } } },
      last5lows: { type: 'array', items: { type: 'string' } },
      ssl_test: { type: 'string', description: 'One short line' },
      wyckoff: { type: 'string', description: 'One short line, must agree with active_wave' },
      active_wave: { type: 'string', description: 'THE canonical wave status. One short line. Source of truth.' },
      waves: { type: 'string', description: 'Compact W1->W5, must agree with active_wave' },
      subwave: { type: 'string', description: 'One short line, must agree with active_wave' },
      swing_low: { type: 'number', description: 'Low of the move being retraced for entry' },
      swing_high: { type: 'number', description: 'High of that move' },
      entry_fib: { type: 'number', enum: [38.2, 50, 61.8, 78.6], description: 'The single Fib level to enter at' },
      targets_px: { type: 'array', items: { type: 'number' }, description: 'T1..T3 target prices' },
      stop_price: { type: 'number' },
      stop_reason: { type: 'string', description: 'One short line, consistent with stop_price' },
      volume: { type: 'string', description: 'One short line' },
      decision: { type: 'string', enum: ['BUY', 'WAIT', 'AVOID'] },
      decision_note: { type: 'string', description: 'Short action sentence, no level numbers' },
      warnings: { type: 'array', items: { type: 'string' } },
    },
    required: ['decision', 'decision_note', 'active_wave'],
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

function compute(input) {
  const lo = num(input.swing_low), hi = num(input.swing_high);
  const sp = num(input.stop_price);
  const close = num(input.ohlc && input.ohlc.close);
  const warnings = Array.isArray(input.warnings) ? input.warnings.slice() : [];

  let ladder = null, fib_ladder;
  if (lo != null && hi != null && hi > lo) {
    ladder = [38.2, 50, 61.8, 78.6].map((p) => ({ p, price: hi - (p / 100) * (hi - lo) }));
    fib_ladder = `(${fmt(lo)}→${fmt(hi)})  ` + ladder.map((l) => `${l.p}% ${fmt(l.price)}`).join('  ·  ');
  }

  // Snap entry to the exact chosen Fib level.
  let entry = 'No confirmed entry', entryPrice = null;
  const efib = num(input.entry_fib);
  if (ladder && efib != null) {
    const lvl = ladder.find((l) => l.p === efib);
    if (lvl) { entryPrice = lvl.price; entry = `${fmt(entryPrice)} · ${efib}% Fib`; }
  }

  // Consistency guard: WAIT only valid if price hasn't reached the entry yet.
  if (entryPrice != null && close != null && (input.decision || '').toUpperCase() === 'WAIT') {
    if (close <= entryPrice * 1.01) {
      warnings.unshift(`Says WAIT but price (${fmt(close)}) has already reached the entry level (${fmt(entryPrice)}) — pullback done, treat as live and verify.`);
    }
  }

  // Targets % from the exact entry price.
  let targets = [];
  const tps = Array.isArray(input.targets_px) ? input.targets_px.map(num).filter((v) => v != null) : [];
  if (tps.length) {
    targets = tps.slice(0, 3).map((tp, i) => {
      let pct = '';
      if (entryPrice != null && entryPrice !== 0) {
        const v = ((tp - entryPrice) / entryPrice) * 100;
        pct = (v >= 0 ? '+' : '') + (Math.round(v * 10) / 10) + '%';
      }
      return { label: 'T' + (i + 1), price: fmt(tp), pct };
    });
  }

  return {
    ticker: input.ticker, timeframe: input.timeframe, ohlc: input.ohlc,
    last5lows: input.last5lows, ssl_test: input.ssl_test,
    active_wave: input.active_wave, wyckoff: input.wyckoff, waves: input.waves, subwave: input.subwave,
    fib_ladder, entry, targets, stop: sp != null ? fmt(sp) : '—', stop_reason: input.stop_reason,
    volume: input.volume, decision: input.decision, decision_note: input.decision_note, warnings,
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
