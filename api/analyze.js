// WaveRead backend — server-side. Holds the API key, enforces a free daily
// cap, calls Claude with forced tool-use. Supports dual-chart (weekly + daily)
// mode for a combined macro/entry read.

const SYSTEM_SINGLE = `You are a trading analyst applying a strict protocol (Elliott Wave + Wyckoff + Fibonacci) to a candlestick chart image. Work in ENGLISH.

Method:
1. Read latest candle OHLC + % change.
2. List the last 5 candle lows. Lowest = latest SSL test.
3. Wyckoff phase (note SC/spring if seen).
4. Count waves W1->W5 from the SC low, left->right.

CHART CALIBRATION (required — the app draws your analysis onto the user's own chart image):
Look at the DAILY chart image and report chart_calibration:
- top_price / bottom_price: the price values at the very top and very bottom of the PRICE plot area (use the axis labels; extrapolate to the actual edges).
- plot_top_pct / plot_bottom_pct: where the price plot area starts and ends vertically, as fractions of total image height. plot_bottom_pct must be ABOVE the volume bars panel — the price area only.
- plot_left_pct / plot_right_pct: where the plot area starts and ends horizontally (plot_right_pct = where the price axis labels begin).
Be as accurate as you can — these fractions position every line that gets drawn.

For each wave_point also give x_pct: its horizontal position within the plot area (0=left edge, 1=right edge), matching where that pivot actually sits in time on the chart. For projected/not-yet-formed waves, set projected:true and place x_pct to the right of the last real pivot (up to 1.0).

ELLIOTT WAVE RULES — check ALL before reporting:
ABSOLUTE (never break):
- W2 must NOT retrace more than 100% of W1 (w2_end must be above w1_start for a bull move)
- W3 must NOT be the shortest of W1, W3, W5 (by price length). If W3 is shortest, the count is invalid.
- W4 must NOT overlap W1 top (w4_end must stay above w1_end for a bull move)
GUIDELINES (flag if broken but can still trade):
- W3 is typically the longest (ideally >1.618x W1)
- W4 typically retraces 38.2% of W3
- W5 typically equals W1 or 0.618x W1
Supply w1_start, w1_end, w2_end, and any completed w3_end/w4_end/w5_end. The system will validate all rules and flag violations.

CONSISTENCY — CRITICAL:
- State ONE canonical active_wave: which wave is in progress AND whether the prior wave completed. Pick ONE.
- waves, subwave and wyckoff MUST all agree with active_wave. Never contradict yourself.

SETUP TYPE — choose setup_type and make entry MATCH the thesis:
- "reversal": buy NEAR the reversal low. entry_price = at/just above the actual reversal-low candle; must NOT be above current price and NOT far above the recent low. The Fib ladder is for targets/context only.
- "pullback": wait for retracement DOWN to a Fib level. entry_fib = the level (38.2/50/61.8/78.6). WAIT only if price has NOT yet reached the level.
- "breakout": entry just above a confirmation level. entry_price = that level.
NEVER propose buying far above a low you just called support. Entry must fit the thesis.

CONFIRMATION RULES (be specific, not always conservative):
- set setup_confirmed = true if ANY of: (a) volume is clearly climactic/spike on the reversal candle AND price closed strongly, (b) a clear hammer/doji/engulfing reversal candle printed at a Fib level, (c) price has already bounced off the level and held for 2+ candles.
- set setup_confirmed = false ONLY if: price is still falling with no reversal signal, OR the bounce is a single weak candle with no volume confirmation.
- Do NOT default to false. A strong SC + high volume + reversal candle = confirmed = BUY.

ENTRY: give swing_low and swing_high. For pullback: entry_fib. For reversal/breakout: entry_price.
TARGETS/STOP: targets_px and stop_price as plain numbers. For a long, stop_price MUST be below entry. stop_reason consistent with stop_price.

Keep every text field to ONE short line, phone-readable. decision_note = short action sentence. No time estimates. Warnings if image isn't sharp enough. Report via report_trade_plan.`;

const SYSTEM_DUAL = `You are a trading analyst applying a strict protocol (Elliott Wave + Wyckoff + Fibonacci) to TWO candlestick chart images: a WEEKLY chart (macro context) and a DAILY chart (entry timing). Work in ENGLISH.

Your job is to produce ONE unified trade plan that combines both timeframes:
1. Use the WEEKLY chart for macro wave count (W1→W5 big picture), Wyckoff phase, and major Fib levels.
2. Use the DAILY chart for entry timing, sub-wave position, and the specific Fib level to enter at.
3. macro_context = one short line summarizing the weekly read.
4. The entry must be consistent with BOTH timeframes — if weekly says W4 correction ongoing, daily entry should be at the expected W4 bottom zone, not a pullback above it.

CONSISTENCY: ONE canonical active_wave. All fields must agree with it.
SETUP TYPE + ENTRY: same rules as single-chart mode.
For a long: stop_price MUST be below entry.
Keep every text field ONE short line. No time estimates. Report via report_trade_plan.`;

const TOOL = {
  name: 'report_trade_plan',
  description: 'Report the chart analysis. Supply raw numbers; the system computes Fib levels, entry price, target % and risk.',
  input_schema: {
    type: 'object',
    properties: {
      ticker: { type: 'string' },
      timeframe: { type: 'string' },
      macro_context: { type: 'string', description: 'For dual-chart: one line summary of the weekly read' },
      ohlc: { type: 'object', properties: { open:{type:'string'}, high:{type:'string'}, low:{type:'string'}, close:{type:'string'}, change:{type:'string'} } },
      last5lows: { type: 'array', items: { type: 'string' } },
      ssl_test: { type: 'string', description: 'One short line' },
      wyckoff: { type: 'string', description: 'One short line, must agree with active_wave' },
      active_wave: { type: 'string', description: 'THE canonical wave status. One short line.' },
      waves: { type: 'string', description: 'Compact W1->W5, must agree with active_wave' },
      subwave: { type: 'string', description: 'One short line, must agree with active_wave' },
      setup_type: { type: 'string', enum: ['reversal','pullback','breakout'], description: 'Determines how entry is set' },
      setup_confirmed: { type: 'boolean', description: 'True only if the entry trigger has actually printed.' },
      swing_low: { type: 'number', description: 'Low of the move being retraced' },
      swing_high: { type: 'number', description: 'High of that move' },
      entry_fib: { type: 'number', enum: [38.2,50,61.8,78.6], description: 'For pullback: the Fib level to enter at' },
      alt_entry_fib: { type: 'number', enum: [38.2,50,61.8,78.6], description: 'Alternative closer Fib level if risk is >15% — a better entry for improved R/R' },
      entry_price: { type: 'number', description: 'For reversal/breakout: the entry price' },
      targets_px: { type: 'array', items: { type: 'number' }, description: 'T1..T3 target prices' },
      stop_price: { type: 'number' },
      stop_reason: { type: 'string', description: 'One short line, consistent with stop_price' },
      volume: { type: 'string', description: 'One short line' },
      decision: { type: 'string', enum: ['BUY','WAIT','AVOID'] },
      decision_note: { type: 'string', description: 'Short action sentence, no level numbers' },
      warnings: { type: 'array', items: { type: 'string' } },
      wave_points: { type: 'array', description: 'Wave pivots in order, each with the label, its price, and x_pct = its horizontal position in the chart plot area (0 = left edge, 1 = right edge). Projected/future waves get x_pct beyond the last real pivot.', items: { type: 'object', properties: { label:{type:'string'}, price:{type:'number'}, x_pct:{type:'number'}, projected:{type:'boolean'} } } },
      chart_calibration: { type: 'object', description: 'Maps the DAILY image to prices so the app can draw lines on it. Read the price axis and the plot area edges.', properties: {
        top_price: { type:'number', description:'Price value at the TOP edge of the plot area' },
        bottom_price: { type:'number', description:'Price value at the BOTTOM edge of the plot area' },
        plot_top_pct: { type:'number', description:'Top edge of plot area as fraction of image height (0-1)' },
        plot_bottom_pct: { type:'number', description:'Bottom edge of the price plot area (above the volume panel) as fraction of image height (0-1)' },
        plot_left_pct: { type:'number', description:'Left edge of plot area as fraction of image width (0-1)' },
        plot_right_pct: { type:'number', description:'Right edge of plot area (where the price axis starts) as fraction of image width (0-1)' }
      } },
      w1_start: { type: 'number', description: 'W1 start price (SC low)' },
      w1_end: { type: 'number', description: 'W1 end price (W1 top)' },
      w2_end: { type: 'number', description: 'W2 end price (W2 bottom)' },
      w3_end: { type: 'number', description: 'W3 end price (W3 top), null if not yet completed' },
      w4_end: { type: 'number', description: 'W4 end price (W4 bottom), null if not yet completed' },
      w5_end: { type: 'number', description: 'W5 end price (W5 top), null if not yet completed' },
    },
    required: ['decision','decision_note','active_wave','setup_type','setup_confirmed'],
  },
};

const DAILY_CAP = 5;
const GLOBAL_DAILY_CAP = 500;
const ipHits = new Map();
let globalCount = 0;
let currentDay = null;
function today() { return new Date().toISOString().slice(0, 10); }
function num(x) { if(x==null)return null; const n=parseFloat(String(x).replace(/[^0-9.\-]/g,'')); return isFinite(n)?n:null; }
function fmt(n) { return (Math.round(n*100)/100).toString(); }

function coherence(setup, decision, entryPrice, close, recentLow) {
  if(entryPrice==null||close==null||close===0)return null;
  const gap=((entryPrice-close)/close)*100;
  const D=(decision||'').toUpperCase();
  if(D==='BUY'&&Math.abs(gap)>2) return `Decision is BUY but entry (${fmt(entryPrice)}) is ${fmt(Math.abs(gap))}% ${gap>0?'above':'below'} current price (${fmt(close)}) — should be WAIT.`;
  if(setup==='pullback'){
    if(gap>1)return `Pullback entry (${fmt(entryPrice)}) is above current price (${fmt(close)}) — pullback waits for price to fall. Contradiction.`;
    if(D==='WAIT'&&close<=entryPrice*1.005)return `Says WAIT but price (${fmt(close)}) has already reached entry (${fmt(entryPrice)}) — pullback done, treat as live.`;
    if(gap<-8)return `Waiting for a ~${fmt(Math.abs(gap))}% pullback to ${fmt(entryPrice)} — do not wait for a dip if the impulse has already started.`;
  } else if(setup==='breakout'){
    if(gap<-1)return `Breakout entry (${fmt(entryPrice)}) is below current price (${fmt(close)}) — contradiction.`;
  } else if(setup==='reversal'){
    if(gap<-1)return `Reversal entry (${fmt(entryPrice)}) is below current price (${fmt(close)}) — that is pullback logic, not a reversal.`;
    if(recentLow!=null&&entryPrice>recentLow*1.03)return `Reversal entry (${fmt(entryPrice)}) sits >3% above the reversal low (~${fmt(recentLow)}) — buy near the low.`;
  }
  return null;
}

function compute(input) {
  const lo=num(input.swing_low), hi=num(input.swing_high);
  const stopP=num(input.stop_price);
  const close=num(input.ohlc&&input.ohlc.close);
  const stype=(input.setup_type||'').toLowerCase();
  const decision=(input.decision||'').toUpperCase();
  const warnings=Array.isArray(input.warnings)?input.warnings.slice():[];

  let ladder=null, fib_ladder;
  if(lo!=null&&hi!=null&&hi>lo){
    ladder=[38.2,50,61.8,78.6].map(p=>({p,price:hi-(p/100)*(hi-lo)}));
    fib_ladder=`(${fmt(lo)}→${fmt(hi)})  `+ladder.map(l=>`${l.p}% ${fmt(l.price)}`).join('  ·  ');
  }

  let entry='No confirmed entry', entryPrice=null;
  if(stype==='pullback'){
    const efib=num(input.entry_fib);
    if(ladder&&efib!=null){
      const lvl=ladder.find(l=>l.p===efib);
      if(lvl){entryPrice=lvl.price; entry=`${fmt(entryPrice)} · ${efib}% Fib (pullback)`;}
    }
  }
  if(entryPrice==null){
    const ep=num(input.entry_price);
    if(ep!=null){entryPrice=ep; entry=`${fmt(ep)} · ${stype||'entry'}`;}
  }

  const lows=(Array.isArray(input.last5lows)?input.last5lows:[]).map(num).filter(v=>v!=null);
  const ohlcLow=num(input.ohlc&&input.ohlc.low);
  const recentLow=[...lows,...(ohlcLow!=null?[ohlcLow]:[])].reduce((m,v)=>(m==null?v:Math.min(m,v)),null);
  const coh=coherence(stype,decision,entryPrice,close,recentLow);
  if(coh)warnings.unshift(coh);

  let decisionOut=input.decision||'';
  if(input.setup_confirmed===false){
    if((decisionOut||'').toUpperCase()==='BUY')decisionOut='WAIT';
    if(entryPrice!=null&&entry!=='No confirmed entry')entry=entry+' (unconfirmed — wait for trigger)';
    warnings.unshift('Setup not yet confirmed — treat as a watch, not a live entry.');
  }

  let targets=[];
  const tps=Array.isArray(input.targets_px)?input.targets_px.map(num).filter(v=>v!=null):[];
  if(tps.length){
    targets=tps.slice(0,3).map((tp,i)=>{
      let pct='';
      if(entryPrice!=null&&entryPrice!==0){const v=((tp-entryPrice)/entryPrice)*100;pct=(v>=0?'+':'')+( Math.round(v*10)/10)+'%';}
      return{label:'T'+(i+1),price:fmt(tp),pct};
    });
  }

  let risk;
  if(entryPrice!=null&&stopP!=null&&entryPrice!==0){
    if(stopP>=entryPrice){
      warnings.unshift(`Invalid stop: stop (${fmt(stopP)}) is at/above entry (${fmt(entryPrice)}) — for a long the stop must be below entry. Do not trade as shown.`);
      risk='stop above entry — invalid';
    } else {
      const rp=((entryPrice-stopP)/entryPrice)*100;
      risk='-'+fmt(rp)+'% to stop';
      if(rp>15){
        const altFib=num(input.alt_entry_fib);
        let altNote='';
        if(ladder&&altFib!=null){const altLvl=ladder.find(l=>l.p===altFib);if(altLvl)altNote=` Consider waiting for ${altFib}% (${fmt(altLvl.price)}) for better R/R.`;}
        warnings.unshift(`High risk: −${fmt(rp)}% to stop is large for most position sizes.${altNote}`);
      }
      if(tps.length){const r1=((tps[0]-entryPrice)/entryPrice)*100;if(r1>0&&r1<rp)warnings.unshift(`Poor risk/reward: risking ~${fmt(rp)}% to make ~${fmt(r1)}% at T1 — entry may be too far from the actionable level.`);}
    }
  }

  // --- Elliott Wave rule validation ---
  const ew_warnings = [];
  const w1s=num(input.w1_start), w1e=num(input.w1_end), w2e=num(input.w2_end);
  const w3e=num(input.w3_end), w4e=num(input.w4_end), w5e=num(input.w5_end);
  if(w1s!=null&&w1e!=null&&w2e!=null){
    const w1len=Math.abs(w1e-w1s);
    // Rule 1: W2 no full retrace
    if(w2e<=w1s) ew_warnings.push('EW RULE BROKEN: W2 retraced >100% of W1 — count is invalid. W2 must not go below W1 start.');
    // Rule 2 & 3: W3 not shortest
    if(w3e!=null){
      const w3len=Math.abs(w3e-w2e);
      const w5len=w5e!=null?Math.abs(w5e-w4e):null;
      if(w5len!=null&&w3len<w1len&&w3len<w5len) ew_warnings.push('EW RULE BROKEN: W3 is the shortest wave — Elliott Wave rules prohibit this. Count needs revision.');
      else if(w5len==null&&w3len<w1len) ew_warnings.push('EW WARNING: W3 shorter than W1 — if W5 is also shorter, count is invalid. Monitor.');
      // Rule 4: W4 no overlap
      if(w4e!=null&&w1e!=null){
        const bullish=w1e>w1s;
        if(bullish&&w4e<w1e) ew_warnings.push('EW RULE BROKEN: W4 overlaps W1 top — count is invalid unless diagonal triangle.');
        if(!bullish&&w4e>w1e) ew_warnings.push('EW RULE BROKEN: W4 overlaps W1 bottom — count is invalid unless diagonal triangle.');
      }
      // Guideline: W3 should be longest
      if(w3len<w1len*1.0) ew_warnings.push('EW GUIDELINE: W3 is shorter than W1 — typically W3 is the longest. Count is possible but weak.');
    }
  }
  if(ew_warnings.length) warnings.unshift(...ew_warnings);

    return {
    ticker:input.ticker, timeframe:input.timeframe, macro_context:input.macro_context, wave_points:input.wave_points, chart_calibration:input.chart_calibration, w1_start:input.w1_start, w1_end:input.w1_end, w2_end:input.w2_end, w3_end:input.w3_end, w4_end:input.w4_end, w5_end:input.w5_end,
    setup_type:input.setup_type, ohlc:input.ohlc, last5lows:input.last5lows, ssl_test:input.ssl_test,
    active_wave:input.active_wave, wyckoff:input.wyckoff, waves:input.waves, subwave:input.subwave,
    fib_ladder, entry, targets, stop:stopP!=null?fmt(stopP):'—', risk, stop_reason:input.stop_reason,
    volume:input.volume, decision:decisionOut, decision_note:input.decision_note, warnings,
  };
}

export default async function handler(req, res) {
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  const day=today();
  if(currentDay!==day){currentDay=day;globalCount=0;ipHits.clear();}
  if(globalCount>=GLOBAL_DAILY_CAP)return res.status(429).json({error:'Daily capacity reached. Try again tomorrow.',limit:true});
  const ip=(req.headers['x-forwarded-for']||'').split(',')[0].trim()||'unknown';
  const ipKey=day+':'+ip;
  const used=ipHits.get(ipKey)||0;
  if(used>=DAILY_CAP)return res.status(429).json({error:'Free limit reached for today.',limit:true,cap:DAILY_CAP});

  const{image,mime,imageWeekly,mimeWeekly,ticker,tf,ohlc}=req.body||{};
  if(!image||!mime)return res.status(400).json({error:'Missing image.'});

  const dual=!!(imageWeekly&&mimeWeekly);
  const ctx=[];
  if(ticker)ctx.push('Ticker: '+ticker);
  if(tf)ctx.push('Timeframe: '+tf);
  if(ohlc)ctx.push('User-provided OHLC/levels:\n'+ohlc);

  let content;
  if(dual){
    const userText=(ctx.length?ctx.join('\n')+'\n\n':'')+'Analyze BOTH charts and produce ONE unified trade plan via the tool. First image = WEEKLY (macro), second image = DAILY (entry).';
    content=[
      {type:'image',source:{type:'base64',media_type:mimeWeekly,data:imageWeekly}},
      {type:'text',text:'[WEEKLY CHART — macro wave count and Wyckoff phase]'},
      {type:'image',source:{type:'base64',media_type:mime,data:image}},
      {type:'text',text:'[DAILY CHART — entry timing and sub-wave position]\n\n'+userText},
    ];
  } else {
    const userText=(ctx.length?ctx.join('\n')+'\n\n':'')+'Analyze the chart in the image and report via the tool.';
    content=[
      {type:'image',source:{type:'base64',media_type:mime,data:image}},
      {type:'text',text:userText},
    ];
  }

  try{
    const r=await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{'content-type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},
      body:JSON.stringify({
        model:'claude-sonnet-4-6', max_tokens:1200,
        system:dual?SYSTEM_DUAL:SYSTEM_SINGLE,
        tools:[TOOL], tool_choice:{type:'tool',name:'report_trade_plan'},
        messages:[{role:'user',content}],
      }),
    });
    if(!r.ok){const detail=(await r.text()).slice(0,300);return res.status(502).json({error:'Upstream error.',detail});}
    const data=await r.json();
    const block=(data.content||[]).find(b=>b.type==='tool_use');
    if(!block||!block.input)return res.status(502).json({error:'No analysis produced. Try a clearer image.'});
    ipHits.set(ipKey,used+1);
    globalCount++;
    return res.status(200).json({result:compute(block.input),used:used+1,cap:DAILY_CAP,dual});
  }catch(e){return res.status(500).json({error:'Server error.'});}
}
