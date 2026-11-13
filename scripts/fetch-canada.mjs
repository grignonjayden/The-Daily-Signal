// Module 3 — Canada Work. Pulls daily Canadian stats and writes canada.json.
// Runs a few times a day in GitHub Actions (.github/workflows/update-canada.yml). No dependencies.
// Sources: CAA (daily gas), Bank of Canada Valet API (loonie, rates), Statistics Canada WDS (CPI, jobs).
import { writeFileSync, existsSync, readFileSync } from 'node:fs';

const TZ = 'America/Toronto';
const UA = { 'User-Agent': 'Mozilla/5.0 (TheDailySignal personal dashboard)' };
const OUT = 'canada.json';
const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;

// Bank of Canada scheduled rate announcements (published by the Bank; 9:45 AM ET).
const BOC_DATES = ['2026-12-09', '2027-01-27', '2027-03-03', '2027-04-28', '2027-06-02',
  '2027-07-21', '2027-09-08', '2027-10-27', '2027-12-08'];

const URLS = {
  caa: 'https://www.caa.ca/gas-prices/',
  fx: 'https://www.bankofcanada.ca/rates/exchange/daily-exchange-rates/',
  bonds: 'https://www.bankofcanada.ca/rates/interest-rates/bond-yields/benchmark-bond-yields/',
  policy: 'https://www.bankofcanada.ca/core-functions/monetary-policy/key-interest-rate/',
  posted: 'https://www.bankofcanada.ca/rates/banking-and-financial-statistics/posted-interest-rates-offered-by-chartered-banks/',
  cpi: 'https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=1810000401',
  lfs: 'https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=1410028701',
};

async function get(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { ...UA, ...(opts.headers || {}) }, signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
  return res;
}
const fmtDay = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const fmtMonth = (iso) => new Date(iso.slice(0, 7) + '-15T12:00:00Z').toLocaleDateString('en-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const arrow = (d) => d > 0 ? '▲' : d < 0 ? '▼' : '●';
const dir = (d, eps = 1e-9) => d > eps ? 'up' : d < -eps ? 'down' : 'flat';

// ---------- CAA daily gas price ----------
async function gas() {
  const html = await (await get(URLS.caa, { headers: { Accept: 'text/html' } })).text();
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&#8217;|&rsquo;|’/g, "'").replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  const num = (re) => { const m = text.match(re); return m ? parseFloat(m[1]) : null; };
  const today = num(/Today'?s Average\s*([\d.]+)\s*\/?\s*L/i);
  const yest = num(/Yesterday\s*\(Avg\.?\)\s*([\d.]+)/i);
  const week = num(/Week Ago\s*\(Avg\.?\)\s*([\d.]+)/i);
  const month = num(/Month Ago\s*\(Avg\.?\)\s*([\d.]+)/i);
  const year = num(/Year Ago\s*\(Avg\.?\)\s*([\d.]+)/i);
  const upd = (text.match(/Last updated:?\s*([A-Za-z]+ \d{1,2},? \d{4}(?: at [\d:]+\s*[ap]m)?)/i) || [])[1];
  if (today == null) {
    const i = text.search(/Today/i);
    console.log('CAA parse failed. Snippet:', text.slice(Math.max(0, i - 100), i + 400));
    throw new Error('CAA: no national average found');
  }
  const d = yest != null ? +(today - yest).toFixed(1) : null;
  const parts = [];
  if (week != null) parts.push('Week ago ' + week.toFixed(1) + '¢');
  if (month != null) parts.push('month ago ' + month.toFixed(1) + '¢');
  if (year != null) parts.push('year ago ' + year.toFixed(1) + '¢');
  return {
    name: 'Gas (regular, national avg.)',
    value: today.toFixed(1) + '¢/L',
    delta: d == null ? null : { value: Math.abs(d).toFixed(1) + '¢', label: 'vs yesterday', dir: dir(d) },
    note: parts.join(' · '),
    as_of: upd ? 'CAA · ' + upd : 'CAA · today',
    url: URLS.caa,
  };
}

// ---------- Bank of Canada Valet ----------
async function valet(series, recent) {
  const j = await (await get(`https://www.bankofcanada.ca/valet/observations/${series}/json?recent=${recent}`, { headers: { Accept: 'application/json' } })).json();
  const obs = (j.observations || []).map(o => ({ d: o.d, v: o[series] && o[series].v !== '' ? parseFloat(o[series].v) : NaN })).filter(o => !isNaN(o.v))
    .sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : 0); // Valet returns newest first with ?recent
  if (!obs.length) throw new Error('Valet: no data for ' + series);
  console.log('Valet', series, '=', (j.seriesDetail && j.seriesDetail[series] && j.seriesDetail[series].label), obs[obs.length - 1]);
  return obs;
}

async function loonie() {
  const o = await valet('FXUSDCAD', 3);
  const last = o[o.length - 1], before = o[o.length - 2];
  const cad = 1 / last.v;
  const d = before ? (1 / last.v - 1 / before.v) * 100 : null; // US cents
  return {
    name: 'Canadian dollar',
    value: '$' + cad.toFixed(4) + ' US',
    delta: d == null ? null : { value: Math.abs(d).toFixed(2) + '¢ US', label: 'vs day before', dir: dir(d, 0.005) },
    note: 'What 1 Canadian dollar buys in U.S. dollars. US$1 = C$' + last.v.toFixed(4) + '.',
    as_of: 'Bank of Canada · ' + fmtDay(last.d),
    url: URLS.fx,
  };
}

async function bond5() {
  const o = await valet('BD.CDN.5YR.DQ.YLD', 3);
  const last = o[o.length - 1], before = o[o.length - 2];
  const bps = before ? Math.round((last.v - before.v) * 100) : null;
  return {
    name: '5-year Canada bond yield',
    value: last.v.toFixed(2) + '%',
    delta: bps == null ? null : { value: Math.abs(bps) + ' bps', label: 'vs day before', dir: dir(bps) },
    note: 'Fixed mortgage rates tend to follow this yield.',
    as_of: 'Bank of Canada · ' + fmtDay(last.d),
    url: URLS.bonds,
  };
}

async function policyRate(todayIso) {
  const o = await valet('V39079', 400);
  const last = o[o.length - 1];
  let since = o[0].d, changedBy = null;
  for (let i = o.length - 1; i > 0; i--) {
    if (o[i].v !== o[i - 1].v) { since = o[i].d; changedBy = o[i].v - o[i - 1].v; break; }
  }
  const next = BOC_DATES.find(d => d >= todayIso);
  const sinceTxt = changedBy == null ? 'Unchanged for over a year' :
    (changedBy > 0 ? 'Raised' : 'Cut') + ' ' + Math.abs(changedBy).toFixed(2) + ' pts, in effect since ' + fmtDay(since);
  return {
    name: 'Bank of Canada rate',
    value: last.v.toFixed(2) + '%',
    delta: next ? { value: fmtDay(next).replace(/, \d{4}$/, ''), label: 'next decision', dir: 'event' } : null,
    note: sinceTxt + '. Sets the base for prime, variable mortgages and savings rates.',
    as_of: 'Bank of Canada · ' + fmtDay(last.d),
    url: URLS.policy,
  };
}

async function postedRate(series, name, note) {
  const o = await valet(series, 2);
  const last = o[o.length - 1], before = o[o.length - 2];
  const d = before ? +(last.v - before.v).toFixed(2) : null;
  return {
    name,
    value: last.v.toFixed(2) + '%',
    delta: d == null ? null : (d === 0 ? { value: 'No change', label: 'this week', dir: 'flat' } : { value: Math.abs(d).toFixed(2) + ' pts', label: 'this week', dir: dir(d) }),
    note,
    as_of: 'Bank of Canada (weekly) · ' + fmtDay(last.d),
    url: URLS.posted,
  };
}

// ---------- Statistics Canada WDS ----------
async function statcan(vectors) {
  const body = JSON.stringify(vectors.map(v => ({ vectorId: v.id, latestN: v.n })));
  const j = await (await get('https://www150.statcan.gc.ca/t1/wds/rest/getDataFromVectorsAndLatestNPeriods', {
    method: 'POST', body, headers: { 'Content-Type': 'application/json', Accept: 'application/json' } })).json();
  try {
    const info = await (await get('https://www150.statcan.gc.ca/t1/wds/rest/getSeriesInfoFromVector', {
      method: 'POST', body: JSON.stringify(vectors.map(v => ({ vectorId: v.id }))), headers: { 'Content-Type': 'application/json' } })).json();
    info.forEach(r => r.object && console.log('StatCan v' + r.object.vectorId, '=', r.object.SeriesTitleEn));
  } catch (e) { /* titles are only logged for checking */ }
  const out = {};
  j.forEach(r => {
    if (r.status !== 'SUCCESS' || !r.object) return;
    out[r.object.vectorId] = (r.object.vectorDataPoint || []).map(p => ({ d: p.refPer, v: p.value })).sort((a, b) => a.d < b.d ? -1 : 1);
  });
  return out;
}
function yoy(pts) {
  if (!pts || pts.length < 13) return null;
  const last = pts[pts.length - 1], yearAgo = pts[pts.length - 13];
  const prevM = pts[pts.length - 2], prevYearAgo = pts[pts.length - 14];
  const r = +(((last.v / yearAgo.v) - 1) * 100).toFixed(1);
  const pr = prevYearAgo ? +(((prevM.v / prevYearAgo.v) - 1) * 100).toFixed(1) : null;
  return { d: last.d, r, pr };
}

// Month-over-month change in a 12-month rate, e.g. 3.0% -> 3.1% = up 0.1 pts.
function monthMove(x) {
  const ch = +(x.r - x.pr).toFixed(1);
  return { value: ch === 0 ? 'No change' : Math.abs(ch).toFixed(1) + ' pts', label: 'from ' + x.pr.toFixed(1) + '% last month', dir: dir(ch) };
}
async function costOfLiving() {
  const V = { cpi: 41690973, food: 41690974, unemp: 2062815 };
  const s = await statcan([{ id: V.cpi, n: 14 }, { id: V.food, n: 14 }, { id: V.unemp, n: 2 }]);
  const items = [];
  const cpi = yoy(s[V.cpi]);
  if (cpi) items.push({
    name: 'Inflation (CPI)',
    value: cpi.r.toFixed(1) + '%',
    delta: cpi.pr == null ? null : monthMove(cpi),
    note: 'How much prices overall rose over the past 12 months. The Bank of Canada aims for 2%.',
    as_of: 'Statistics Canada · ' + fmtMonth(cpi.d),
    url: URLS.cpi,
  });
  const food = yoy(s[V.food]);
  if (food) items.push({
    name: 'Food prices',
    value: food.r.toFixed(1) + '%',
    delta: food.pr == null ? null : monthMove(food),
    note: 'How much food prices rose over the past 12 months.',
    as_of: 'Statistics Canada · ' + fmtMonth(food.d),
    url: URLS.cpi,
  });
  const u = s[V.unemp];
  if (u && u.length) {
    const last = u[u.length - 1], b = u[u.length - 2];
    const d = b ? +(last.v - b.v).toFixed(1) : null;
    items.push({
      name: 'Unemployment rate',
      value: last.v.toFixed(1) + '%',
      delta: d == null ? null : (d === 0 ? { value: 'No change', label: 'vs last month', dir: 'flat' } : { value: Math.abs(d).toFixed(1) + ' pts', label: 'vs last month', dir: dir(d) }),
      note: 'Share of people looking for work who can’t find a job.',
      as_of: 'Statistics Canada · ' + fmtMonth(last.d),
      url: URLS.lfs,
    });
  }
  if (!items.length) throw new Error('StatCan: no data');
  return items;
}

// ---------- assemble ----------
const now = new Date();
const todayIso = now.toLocaleDateString('en-CA', { timeZone: TZ });
const prevItem = (name) => {
  for (const s of (prev && prev.sections) || []) for (const it of s.items || []) if (it.name === name) return { ...it, stale: true };
  return null;
};
async function safe(fn, fallbackNames) {
  try { const r = await fn(); return Array.isArray(r) ? r : [r]; }
  catch (e) { console.error('!', e.message); return fallbackNames.map(prevItem).filter(Boolean); }
}

const [g, fx, b5, pol, prime, mort, gic, col] = await Promise.all([
  safe(gas, ['Gas (regular, national avg.)']),
  safe(loonie, ['Canadian dollar']),
  safe(bond5, ['5-year Canada bond yield']),
  safe(() => policyRate(todayIso), ['Bank of Canada rate']),
  safe(() => postedRate('V80691311', 'Prime rate', 'What banks charge their best customers; variable loans and lines of credit move with it.'), ['Prime rate']),
  safe(() => postedRate('V80691335', '5-yr fixed mortgage (posted)', 'Big banks’ advertised rate. Most borrowers get a lower, discounted rate.'), ['5-yr fixed mortgage (posted)']),
  safe(() => postedRate('V80691339', '1-year GIC', 'Typical rate banks pay on a 1-year guaranteed investment certificate.'), ['1-year GIC']),
  safe(costOfLiving, ['Inflation (CPI)', 'Food prices', 'Unemployment rate']),
]);

const sections = [
  { key: 'daily', title: 'Today in Canada', icon: 'car', caption: 'Updates daily', items: [...g, ...fx, ...b5] },
  { key: 'rates', title: 'Borrowing & Saving', icon: 'bank', caption: 'Bank of Canada data · updates daily and weekly', items: [...pol, ...prime, ...mort, ...gic] },
  { key: 'living', title: 'Cost of Living & Jobs', icon: 'cart', caption: 'Statistics Canada · updates monthly', items: col },
].filter(s => s.items.length);

if (!sections.length) { console.error('Nothing fetched; keeping existing canada.json'); process.exit(0); }

const out = {
  generated_at: now.toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET',
  date_key: todayIso,
  sections,
  sources: [
    { title: 'CAA gas prices', url: URLS.caa },
    { title: 'Bank of Canada', url: 'https://www.bankofcanada.ca/rates/' },
    { title: 'Statistics Canada', url: 'https://www150.statcan.gc.ca/n1/dai-quo/index-eng.htm' },
  ],
};
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log('Wrote', OUT, sections.map(s => s.title + ': ' + s.items.map(i => i.name + ' ' + i.value + (i.stale ? ' (stale)' : '')).join(', ')).join(' | '));
