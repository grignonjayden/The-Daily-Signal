// Portfolio Visualizer risk data: one year of weekly returns for every stock/ETF in quotes.json, plus the TSX and S&P 500.
// Writes history.json with each symbol's weekly returns, beta (vs its home index and vs a 50/50 TSX + S&P 500 "market"),
// yearly volatility and 1-year return. Used in the browser for CAPM, the Sharpe ratio, systematic vs idiosyncratic
// risk and the Markowitz model mix. Runs a few times a day from the news loop. No dependencies.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const UA = { 'User-Agent': 'Mozilla/5.0 (TheDailySignal personal dashboard)', 'Accept': 'application/json' };
const TZ = 'America/Toronto';
const WEEKS = 52;

async function weekly(symbol) {
  for (const host of ['query1', 'query2']) {
    try {
      const res = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1wk`, { headers: UA, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const r = (await res.json()).chart.result[0];
      const ts = r.timestamp || [], c = (r.indicators.adjclose && r.indicators.adjclose[0].adjclose) || r.indicators.quote[0].close;
      return ts.map((t, i) => [t * 1000, c[i]]).filter(([, v]) => typeof v === 'number' && v > 0);
    } catch (e) { if (host === 'query2') console.warn(`${symbol}: skipped (${e.message})`); }
  }
  return null;
}
// Put a series on the reference weeks (nearest bar within 4 days), then turn prices into weekly returns.
function align(series, ref) {
  const px = ref.map(t => { let best = null, bd = 4 * 864e5; for (const [ts, v] of series) { const d = Math.abs(ts - t); if (d <= bd) { bd = d; best = v; } } return best; });
  const r = []; for (let i = 1; i < px.length; i++) r.push(px[i] != null && px[i - 1] != null ? +(px[i] / px[i - 1] - 1).toFixed(5) : null);
  return r;
}
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
function stats(r, m) { // r: asset returns, m: market returns (same length, nulls allowed)
  const pairs = r.map((x, i) => [x, m[i]]).filter(([x, y]) => x != null && y != null);
  if (pairs.length < 20) return null;
  const xs = pairs.map(p => p[0]), ys = pairs.map(p => p[1]), mx = mean(xs), my = mean(ys);
  let cov = 0, vm = 0, vx = 0; pairs.forEach(([x, y]) => { cov += (x - mx) * (y - my); vm += (y - my) ** 2; vx += (x - mx) ** 2; });
  return { beta: +(cov / vm).toFixed(3), vol: +Math.sqrt(vx / (pairs.length - 1) * 52).toFixed(4) };
}

// Only the core set flagged h:1 in quotes.json (TSX, popular ETFs, U.S. $50B+ and the original list) gets history, to keep history.json small.
const quotes = (existsSync('quotes.json') ? JSON.parse(readFileSync('quotes.json', 'utf8')).quotes || [] : []).filter(q => q.h || (!q.t && (q.x === 'TSX' || q.x === 'US')));
if (!quotes.length) { console.error('No quotes.json yet; skipping history.'); process.exit(0); }

const sp = await weekly('^GSPC'), tsx = await weekly('^GSPTSE');
if (!sp || !tsx || sp.length < 40) { console.error('Index history unavailable; keeping history.json unchanged.'); process.exit(0); }
const ref = sp.slice(-(WEEKS + 1)).map(([t]) => t);
const mSP = align(sp, ref), mTSX = align(tsx, ref);
const mBlend = mSP.map((x, i) => x != null && mTSX[i] != null ? +((x + mTSX[i]) / 2).toFixed(5) : null);

const out = {};
for (let i = 0; i < quotes.length; i += 8) {
  await Promise.all(quotes.slice(i, i + 8).map(async q => {
    const sym = q.x === 'TSX' ? q.s + '.TO' : q.s;
    const ser = await weekly(sym); if (!ser || ser.length < 25) return;
    const r = align(ser, ref);
    const home = stats(r, q.x === 'TSX' ? mTSX : mSP), mk = stats(r, mBlend);
    if (!home || !mk) return;
    const first = ser.find(([t]) => t >= ref[0] - 4 * 864e5), last = ser[ser.length - 1];
    out[q.x + ':' + q.s] = { r, b: home.beta, bm: mk.beta, v: mk.vol, y: first ? +(last[1] / first[1] - 1).toFixed(4) : null };
  }));
}
if (Object.keys(out).length < 20) { console.error('Too few histories; keeping history.json unchanged.'); process.exit(0); }

const now = new Date();
writeFileSync('history.json', JSON.stringify({
  generated_at: now.toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET',
  weeks: ref.map(t => new Date(t).toISOString().slice(0, 10)),
  market: { sp500: mSP, tsx: mTSX, blend: mBlend, sp500_vol: stats(mSP, mSP).vol, tsx_vol: stats(mTSX, mTSX).vol },
  s: out,
  source: { title: 'Yahoo Finance (weekly prices, past year)', url: 'https://finance.yahoo.com/' },
}) + '\n');
console.log(`Wrote history.json: ${Object.keys(out).length} symbols, ${ref.length - 1} weeks.`);
