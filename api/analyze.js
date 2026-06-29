// WaveRead backend — server-side. Holds the API key, enforces a free daily
// cap, calls Claude with forced tool-use. The model classifies the SETUP TYPE
// and supplies raw inputs; the SERVER computes the Fib ladder, resolves the
// entry to match the setup, computes target % and risk, and flags poor R/R
// and price/decision contradictions.

const SYSTEM = `You are a trading analyst applying a strict protocol (Elliott Wave + Wyckoff + Fibonacci) to a candlestick chart image. Work in ENGLISH.

Method:
1. Read latest candle OHLC + % change.
2. List the last 5 candle lows. Lowest = latest SSL test.
3. Wyckoff phase (note SC/spring if seen).
4. Count waves W1->W5 from the SC low, left->right.

CONSISTENCY — CRITICAL:
- State ONE canonical 'active_wave': which wave is in progress AND whether the prior wave completed. Pick ONE.
- waves, subwave and wyckoff MUST all agree with active_wave. Never contradict yourself.

SETUP TYPE — choose setup_type and make the entry MATCH the thesis:
- "reversal": a Spring / SC / W4-low reversal where you buy NEAR the reversal low. entry_price = at/just above the actual reversal-low candle; it must NOT be above current price (that would mean waiting for a drop = pullback, not reversal) and NOT far above the recent low. stop just below that low. The Fib ladder is for targets/context only.
- "pullback": price has already confirmed an up-move and is extended; you wait for a retracement DOWN to a Fib level. entry_fib = the level (38.2/50/61.8/78.6); choose WAIT only until price reaches it.
- "breakout": entry just above a confirmation/breakout level. entry_price = that level.
NEVER propose buying far above a low you just called support. If your read is a bottom/spring, the entry is AT the bottom, not above it. Entry must fit the thesis.

CONFIRMATION & AMBIGUITY:
- Set setup_confirmed = true ONLY if the trigger has actually printed (e.g. a confirmed reversal candle / spring test / a held Fib level). If you are "waiting for confirmation", set it false and decision = WAIT.
- A single green bounce candle inside an ongoing downtrend is NOT a confirmed reversal. On ambiguous charts with no clean, confirmed setup, prefer decision = AVOID or WAIT and do not force a precise entry.

ENTRY INPUTS: give swing_low and swing_high (the move whose Fib retracement matters). For "pullback" give entry_fib. For "reversal"/"breakout" give entry_price as a plain number.
TARGETS/STOP: give target prices (targets_px) and stop_price as plain numbers; stop_reason consistent with stop_price.

Keep every text field to ONE short line, phone-readable. decision_note = short action sentence, no level numbers. No time estimates. If the image isn't sharp enough, say so in warnings. Report via report_trade_plan.`;

const TOOL = {
  name: 'report_trade_plan',
  description: 'Report the analysis. Supply raw inputs + setup_type; the system resolves entry, Fib levels, target % and risk.',
  input_schema: {
    type: 'object',
    properties: {
      ticker: { type: 'string' },
      timeframe: { type: 'string' },
      ohlc: { type: 'object', properties: { open: { type: 'string' }, high: { type: 'string' }, low: { type: 'string' }, close: { type: 'string' }, change: { type: 'string' } } },
      last5lows: { type: 'array', items: { type: 'string' } },
      ssl_test: { type: 'string', description: 'One short line' },
      wyckoff: { type: 'string', description: 'One short line, must agree with active_wave' },
      active_wave: { type: 'string', description: 'THE canonical wave status. One short line.' },
      waves: { type: 'string', description: 'Compact W1->W5, must agree with active_wave' },
      subwave: { type: 'string', description: 'One short line, must agree with active_wave' },
      setup_type: { type: 'string', enum: ['reversal', 'pullback', 'breakout'], description: 'Determines how entry is set' },
      setup_confirmed: { type: 'boolean', description: 'True only if the entry trigger has actually printed. False if waiting for confirmation.' },
      swing_low: { type: 'number', description: 'Low of the move being retraced' },
      swing_high: { type: 'number', description: 'High of that move' },
      entry_fib: { type: 'number', enum: [38.2, 50, 61.8, 78.6], description: 'For pullback setups: the Fib level to enter at' },
      entry_price: { type: 'number', description: 'For reversal/breakout setups: the entry price near the actionable level' },
      targets_px: { type: 'array', items: { type: 'number' }, description: 'T1..T3 target prices' },
      stop_price: { type: 'number' },
      stop_reason: { type: 'string', description: 'One short line, consistent with stop_price' },
      volume: { type: 'string', description: 'One short line' },
      decision: { type: 'string', enum: ['BUY', 'WAIT', 'AVOID'] },
      decision_note: { type: 'string', description: 'Short action sentence, no level numbers' },
      warnings: { type: 'array', items: { type: 'string' } },
    },
    required: ['decision', 'decision_note', 'active_wave', 'setup_type', 'setup_confirmed'],
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
  const stopP = num(input.stop_price);
  const close = num(input.ohlc && input.ohlc.close);
  const stype = (input.setup_type || '').toLowerCase();
  const decision = (input.decision || '').toUpperCase();
  const warnings = Array.isArray(input.warnings) ? input.warnings.slice() : [];

  let ladder = null, fib_ladder;
  if (lo != null && hi != null && hi > lo) {
    ladder = [38.2, 50, 61.8, 78.6].map((p) => ({ p, price: hi - (p / 100) * (hi - lo) }));
    fib_ladder = `(${fmt(lo)}→${fmt(hi)})  ` + ladder.map((l) => `${l.p}% ${fmt(l.price)}`).join('  ·  ');
  }

  // Resolve entry to match the setup type.
  let entry = 'No confirmed entry', entryPrice = null;
  if (stype === 'pullback') {
    const efib = num(input.entry_fib);
    if (ladder && efib != null) {
      const lvl = ladder.find((l) => l.p === efib);
      if (lvl) { entryPrice = lvl.price; entry = `${fmt(entryPrice)} · ${efib}% Fib (pullback)`; }
    }
  }
  if (entryPrice == null) {
    const ep = num(input.entry_price);
    if (ep != null) { entryPrice = ep; entry = `${fmt(ep)} · ${stype || 'entry'}`; }
  }

  // WAIT only valid (for pullback) if price hasn't reached the entry yet.
  if (stype === 'pullback' && entryPrice != null && close != null && decision === 'WAIT' && close <= entryPrice * 1.01) {
    warnings.unshift(`Says WAIT but price (${fmt(close)}) has already reached the entry level (${fmt(entryPrice)}) — pullback done, treat as live and verify.`);
  }

  // Targets % from the resolved entry.
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

  // Reversal sanity: entry must anchor to the actual low, not require a drop.
  const lows = (Array.isArray(input.last5lows) ? input.last5lows : []).map(num).filter((v) => v != null);
  const ohlcLow = num(input.ohlc && input.ohlc.low);
  const recentLow = [...lows, ...(ohlcLow != null ? [ohlcLow] : [])].reduce((m, v) => (m == null ? v : Math.min(m, v)), null);
  if (stype === 'reversal' && entryPrice != null) {
    if (close != null && entryPrice < close * 0.995) {
      warnings.unshift(`Marked "reversal" but entry (${fmt(entryPrice)}) is below current price (${fmt(close)}) — that is pullback logic, not a reversal. Setup type and entry disagree.`);
    } else if (recentLow != null && entryPrice > recentLow * 1.03) {
      warnings.unshift(`Reversal entry (${fmt(entryPrice)}) sits >3% above the reversal low (~${fmt(recentLow)}) — for a reversal you buy near the low. Verify.`);
    }
  }

  // Unconfirmed setup = a watch, not a live entry.
  let decisionOut = input.decision || '';
  if (input.setup_confirmed === false) {
    if ((decisionOut || '').toUpperCase() === 'BUY') decisionOut = 'WAIT';
    if (entryPrice != null && entry !== 'No confirmed entry') entry = entry + ' (unconfirmed — wait for trigger)';
    warnings.unshift('Setup not yet confirmed — treat as a watch, not a live entry.');
  }

  // Risk + R/R sanity check.
  let risk;
  if (entryPrice != null && stopP != null && entryPrice !== 0) {
    const rp = ((entryPrice - stopP) / entryPrice) * 100;
    risk = (rp >= 0 ? '-' : '+') + fmt(Math.abs(rp)) + '% to stop';
    if (rp > 0 && tps.length) {
      const r1 = ((tps[0] - entryPrice) / entryPrice) * 100;
      if (r1 > 0 && r1 < rp) {
        warnings.unshift(`Poor risk/reward: risking ~${fmt(rp)}% to make ~${fmt(r1)}% at T1 — entry may be too far from the actionable level for this setup.`);
      }
    }
  }

  return {
    ticker: input.ticker, timeframe: input.timeframe, setup_type: input.setup_type, ohlc: input.ohlc,
    last5lows: input.last5lows, ssl_test: input.ssl_test,
    active_wave: input.active_wave, wyckoff: input.wyckoff, waves: input.waves, subwave: input.subwave,
    fib_ladder, entry, targets, stop: stopP != null ? fmt(stopP) : '—', risk, stop_reason: input.stop_reason,
    volume: input.volume, decision: decisionOut, decision_note: input.decision_note, warnings,
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
