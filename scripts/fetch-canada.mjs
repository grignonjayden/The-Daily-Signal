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

// ---------- Where Ottawa is investing (federal commitments; update when a new budget lands) ----------
const BUDGET = 'https://www.canada.ca/en/department-finance/news/2026/11/budget-2026-key-measures.html';
const SECTORS = [
  { name: 'Defence & security', icon: 'shield', value: '$700B+', note: 'Forecast defence spending over 5 years. On track for 4% of GDP this decade, 5% by 2035.', as_of: 'Budget 2026 · Nov 5, 2026', url: 'https://occ.ca/rapidpolicy/2026-federal-budget/' },
  { name: 'Major projects', icon: 'drill', value: '$125B+', note: 'Investment in 21 nation-building projects (LNG, mines, ports, power lines) run through the Major Projects Office.', as_of: 'Spring Economic Update · Apr 2026', url: 'https://www.canada.ca/en/department-finance/news/2026/04/spring-economic-update-2026-key-measures.html' },
  { name: 'Electricity & energy', icon: 'bolt', value: '$50B+', note: 'National Electricity Strategy, plus $518.5M for nuclear and $2B+ for heat pump rebates.', as_of: 'Budget 2026 · Nov 5, 2026', url: BUDGET },
  { name: 'Indigenous communities', icon: 'people', value: '$50B+', note: 'Over 10 years, including $32B for First Nations housing and infrastructure.', as_of: 'Budget 2026 · Nov 5, 2026', url: BUDGET },
  { name: 'Housing', icon: 'home', value: '$44.7B', note: 'Over 11 years to build the homes Canada needs, including Build Canada Homes.', as_of: 'Budget 2026 · Nov 5, 2026', url: BUDGET },
  { name: 'Canada Strong Fund', icon: 'coin', value: '$25B', note: 'Canada’s first sovereign wealth fund. It invests alongside private money in Canadian projects and companies.', as_of: 'Budget 2026 · Nov 5, 2026', url: BUDGET },
  { name: 'Forestry', icon: 'tree', value: '$6.5B', note: 'Over six years to transform the forest sector.', as_of: 'Budget 2026 · Nov 5, 2026', url: BUDGET },
  { name: 'Critical minerals', icon: 'gem', value: '$2.3B', note: 'Mine-to-market strategy, plus a $2B accelerator run by Export Development Canada.', as_of: 'Budget 2026 · Nov 5, 2026', url: 'https://budget.canada.ca/2026/report-rapport/chap1-en.html' },
  { name: 'AI & tech', icon: 'chip', value: 'Up to $1.6B', note: 'Investment in Canadian AI company Cohere. BDC is also putting $700M into defence and dual-use tech.', as_of: 'Budget 2026 · Nov 5, 2026', url: 'https://budget.canada.ca/2026/report-rapport/chap1-en.html' },
  { name: 'Culture & media', icon: 'film', value: '$600M', note: 'For audio and screen industries (the Canada Media Fund’s area), plus $300M for CBC/Radio-Canada.', as_of: 'Budget 2026 · Nov 5, 2026', url: BUDGET },
];

// ---------- Deals in the works (headlines from Canadian news and federal sources) ----------
const GC = (dept) => `https://api.io.canada.ca/io-server/gc/news/en/v2?dept=${dept}&sort=publishedDate&orderBy=desc&pick=20&format=atom`;
const DEAL_FEEDS = [
  { source: 'CBC News', badge: 'CBC', news: true, urls: ['https://www.cbc.ca/webfeed/rss/rss-business', 'https://www.cbc.ca/webfeed/rss/rss-politics'] },
  { source: 'CP24', badge: 'CP24', news: true, urls: ['https://www.cp24.com/arc/outboundfeeds/rss/?outputType=xml', 'https://www.cp24.com/arc/outboundfeeds/rss/category/news/?outputType=xml'] },
  { source: 'ISED', badge: 'ISED', urls: [GC('departmentofindustry'), GC('departmentindustry'), GC('innovationscienceeconomicdevelopment')] },
  { source: 'Finance Canada', badge: 'FIN', urls: [GC('departmentfinance')] },
  { source: 'CDEV', badge: 'CDEV', maxDays: 90, urls: ['https://cdev.gc.ca/feed/', 'https://www.cdev.gc.ca/feed/'] },
  { source: 'Canada Media Fund', badge: 'CMF', maxDays: 45, urls: ['https://cmf-fmc.ca/feed/', 'https://cmf-fmc.ca/news/feed/'] },
  { source: 'C.D. Howe Institute', badge: 'CDH', analysis: true, urls: ['https://www.cdhowe.org/feed', 'https://www.cdhowe.org/rss.xml'] },
  { source: 'Bank of Canada', badge: 'BoC', policyOnly: true, maxDays: 45, urls: ['https://www.bankofcanada.ca/content_type/press/feed/', 'https://www.bankofcanada.ca/content_type/press-releases/feed/'] },
];
// Canadian economic policy: monetary (Bank of Canada, rates, inflation) and fiscal (budget, taxes, deficit, spending).
const MONETARY_RE = /bank of canada|macklem|interest rates?|rate (cut|hike|hold|decision)|policy rate|monetary|inflation|price stability|\bCPI\b/i;
const FISCAL_RE = /budget|deficit|fiscal|\btax(es|ation)?\b|\bGST\b|\bHST\b|federal (spending|debt|finances)|public debt|economic (update|statement)|spending (cuts?|review)/i;
const CANADA_RE = /canad|ottawa|federal|carney|champagne|macklem|\bCRA\b|provinc/i;
const NOT_CANADA_RE = /federal reserve|\bthe fed\b|powell|\bfomc\b|u\.s\. (budget|deficit|treasury)|trump('s)? (tax|budget)/i;
const isPolicy = t => (MONETARY_RE.test(t) || FISCAL_RE.test(t)) && CANADA_RE.test(t) && !NOT_CANADA_RE.test(t);
// Monetary stories are always policy; fiscal ones only when no specific industry is named in the headline.
const groupOf = (title, sector, source) => source === 'Bank of Canada' || (MONETARY_RE.test(title) && !NOT_CANADA_RE.test(title)) ? 'policy'
  : FISCAL_RE.test(title) && (sector === 'Budget' || sector === 'General') && !NOT_CANADA_RE.test(title) ? 'policy' : 'sector';
const DEAL_RE = /invest|fund|billion|million|\bdeal\b|agreement|partnership|contract|procure|acqui|stake|loan|major project|MOU|memorandum|build canada|canada strong/i;
const FED_RE = /federal|ottawa|carney|crown corp|canada strong|major projects|champagne|joly|government of canada/i;
const ANALYSIS_RE = /invest|budget|fiscal|defence|housing|energy|trade|tariff|productivity|infrastructure|\bAI\b|mineral|major project|sovereign/i;
const SECTOR_TAGS = [
  ['Defence', /defen[cs]e|military|armed forces|submarine|drone|nato|water ?bomber/i], ['Housing', /housing|\bhomes?\b|homeownership|mortgage/i],
  ['Energy', /energy|electricity|nuclear|\bLNG\b|pipeline|hydro|\boil\b|natural gas|power grid/i], ['Minerals', /mineral|\bmines?\b|mining|graphite|lithium|nickel|tungsten/i],
  ['AI & tech', /\bAI\b|artificial intelligence|quantum|semiconductor|technolog|cohere|data cent/i], ['Autos', /auto(mobile|motive)?\b|\bEVs?\b|electric vehicle/i],
  ['Media', /\bmedia\b|\bfilm|television|\bTV\b|journalis|screen|\bCBC\b|creator|audiovisual/i],
  ['Infrastructure', /infrastructure|major projects|\brail|\bports?\b|highway|transit|bridge|airport/i], ['Trade', /trade|tariff|export|CUSMA/i],
  ['Budget', /budget|deficit|fiscal|\btax/i],
];
const xdecode = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;|&#8217;|&rsquo;/g, '’')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const xtag = (b, names) => { for (const n of names) { const m = b.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`, 'i')); if (m) return m[1]; } return ''; };
// Picture for a headline: feed media tags first, then the article page's og:image / twitter:image.
const BAD_IMG = /logo|\.svg|favicon|sprite|placeholder|default-share|wmms|bck-srh|gravatar|avatar|\/content\/dam\/canada\/[^/]+$/i;
function feedImage(b) {
  const pats = [/<media:thumbnail[^>]*url="([^"]+)"/i, /<media:content[^>]*url="([^"]+\.(?:jpe?g|png|webp)[^"]*)"/i,
    /<media:content[^>]*medium="image"[^>]*url="([^"]+)"/i, /<media:content[^>]*url="([^"]+)"[^>]*medium="image"/i,
    /<enclosure[^>]*url="([^"]+)"[^>]*type="image/i, /<enclosure[^>]*type="image[^"]*"[^>]*url="([^"]+)"/i,
    /<img[^>]*src=["']([^"']+)["']/i, /&lt;img[^&]*src=(?:&quot;|")([^"&]+)/i];
  for (const re of pats) { const m = b.match(re); if (m && /^https:\/\//.test(m[1]) && !BAD_IMG.test(m[1])) return m[1].replace(/&amp;/g, '&'); }
  return '';
}
async function pageImage(url) {
  try {
    const html = (await (await get(url, { headers: { Accept: 'text/html' } })).text()).slice(0, 600000);
    const ok = (raw) => {
      if (!raw) return '';
      try { const u = new URL(raw.replace(/&amp;/g, '&').trim(), url).href; return /^https:\/\//.test(u) && !BAD_IMG.test(u) ? u : ''; } catch (e) { return ''; }
    };
    // 1) share-image meta tags and JSON-LD
    const metas = [/<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url|:url)?|twitter:image(?::src)?)["'][^>]*content=["']([^"']+)["']/gi,
      /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image(?::secure_url|:url)?|twitter:image(?::src)?)["']/gi,
      /<link[^>]+rel=["']image_src["'][^>]*href=["']([^"']+)["']/gi,
      /"image"\s*:\s*(?:\{[^}]*?"url"\s*:\s*)?\[?\s*"([^"]+)"/gi];
    for (const re of metas) for (const m of html.matchAll(re)) { const u = ok(m[1]); if (u) return u; }
    // 2) first real photo inside the article body
    const body = (html.match(/<(?:article|main)[\s>][\s\S]*?<\/(?:article|main)>/i) || [html])[0];
    for (const m of body.matchAll(/<img[^>]+>/gi)) {
      const tagHtml = m[0];
      const src = (tagHtml.match(/\s(?:data-src|src)=["']([^"']+)["']/i) || [])[1] || ((tagHtml.match(/\ssrcset=["']([^"'\s,]+)/i) || [])[1]);
      const w = +((tagHtml.match(/\swidth=["']?(\d+)/i) || [])[1] || 0);
      if (w && w < 200) continue;
      if (/icon|avatar|badge|flag|wordmark|signature|spinner|pixel|1x1/i.test(tagHtml)) continue;
      const u = ok(src); if (u && /\.(jpe?g|png|webp)(\?|$)|\/images?\//i.test(u)) return u;
    }
  } catch (e) { /* no picture */ }
  return '';
}
async function readFeed(url) {
  const xml = await (await get(url, { headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' } })).text();
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map(b => {
    let link = xdecode(xtag(b, ['link']));
    if (!/^https?:/.test(link)) { const m = b.match(/<link[^>]*href="([^"]+)"/i); link = m ? m[1].replace(/&amp;/g, '&') : ''; }
    const date = new Date(xdecode(xtag(b, ['pubDate', 'published', 'updated', 'dc:date'])));
    return { title: xdecode(xtag(b, ['title'])), url: link, image: feedImage(b), summary: xdecode(xtag(b, ['description', 'summary', 'content'])).slice(0, 400), date: isNaN(date) ? null : date };
  }).filter(i => i.title && /^https?:/.test(i.url));
}
const feedStatus = [];
async function deals() {
  const all = [];
  await Promise.all(DEAL_FEEDS.map(async f => {
    const got = [];
    for (const u of f.urls) { try { got.push(...await readFeed(u)); } catch (e) { console.error('!', f.source, e.message); } }
    const seen = new Set();
    const keep = got.filter(i => {
      if (seen.has(i.title)) return false; seen.add(i.title);
      if (!i.date || i.date < Date.now() - (f.maxDays || 21) * 864e5) return false;
      const t = i.title + ' ' + i.summary;
      if (f.policyOnly) return !/availability|advisory|webcast|upcoming|blackout|appoint|museum|bank note|unclaimed|^speech:/i.test(i.title);
      if (isPolicy(i.title)) return true;
      if (f.news) return DEAL_RE.test(t) && FED_RE.test(t) && !/trump administration|american samoa/i.test(i.title);
      if (f.analysis) return ANALYSIS_RE.test(t);
      return DEAL_RE.test(t);
    }).sort((a, b) => b.date - a.date);
    // up to 2 industry stories and 2 policy stories per source
    const pol = keep.filter(i => f.policyOnly || isPolicy(i.title)).slice(0, f.policyOnly ? 3 : 2);
    keep.splice(0, keep.length, ...keep.filter(i => !f.policyOnly && !isPolicy(i.title)).slice(0, 2), ...pol);
    feedStatus.push({ source: f.source, fetched: got.length, kept: keep.length });
    if (!got.length) { // source down this run: keep its last stories (still within the age window)
      const old = ((prevGov && prevGov.items) || []).filter(a => a.source === f.source && Date.parse(a.date || 0) > Date.now() - (f.maxDays || 21) * 864e5);
      old.forEach(a => all.push({ ...a, image: BAD_IMG.test(a.image || '') ? '' : a.image, ts: Date.parse(a.date) }));
      return;
    }
    keep.forEach(i => all.push({
      title: i.title, url: i.url, image: i.image || '', source: f.source, badge: f.badge, analysis: !!f.analysis,
      sector: (SECTOR_TAGS.find(([, re]) => re.test(i.title)) || SECTOR_TAGS.find(([, re]) => re.test(i.summary)) || ['General'])[0],
      policy: f.policyOnly || isPolicy(i.title),
      time: i.date.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: TZ }), date: i.date.toISOString(), ts: i.date.getTime(),
    }));
  }));
  all.sort((a, b) => b.ts - a.ts);
  if (!all.length) throw new Error('Deals: no headlines');
  all.forEach(a => {
    if (a.policy) a.sector = MONETARY_RE.test(a.title) || a.source === 'Bank of Canada' ? 'Monetary' : 'Fiscal';
    a.group = a.policy ? 'policy' : groupOf(a.title, a.sector, a.source);
    if (a.group === 'policy' && !/Monetary|Fiscal/.test(a.sector)) a.sector = MONETARY_RE.test(a.title) ? 'Monetary' : 'Fiscal';
    delete a.policy;
  });
  const top = [...all.filter(a => a.group === 'sector').slice(0, 12), ...all.filter(a => a.group === 'policy').slice(0, 6)];
  await Promise.all(top.filter(a => !a.image).map(async a => { a.image = await pageImage(a.url); }));
  console.log('Deal pictures:', top.filter(a => a.image).length + '/' + top.length);
  top.forEach(a => console.log(' ', a.source, a.image ? 'photo' : 'none', a.url));
  return top.map(({ ts, ...rest }) => rest);
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
let dealItems;
const GOV_OUT = 'government.json';
const prevGov = existsSync(GOV_OUT) ? JSON.parse(readFileSync(GOV_OUT, 'utf8')) : null;
try { dealItems = await deals(); } catch (e) { console.error('!', e.message); dealItems = (prevGov && prevGov.items) || []; }

const sections = [
  { key: 'invest', title: 'Government Expenditure', icon: 'building', caption: 'Biggest federal commitments from Budget 2026 and the Spring Economic Update · amounts are multi-year, not investment advice', items: SECTORS.slice(0, 5) },
  { key: 'invest2', title: 'Funds & Growing Industries', icon: 'chip', caption: 'More federal commitments from Budget 2026 · amounts are multi-year, not investment advice', items: SECTORS.slice(5) },
  { key: 'daily', title: 'Today in Canada', icon: 'car', caption: 'Updates daily', items: [...g, ...fx, ...b5] },
  { key: 'rates', title: 'Borrowing & Saving', icon: 'bank', caption: 'Bank of Canada data · updates daily and weekly', items: [...pol, ...prime, ...mort, ...gic] },
  { key: 'living', title: 'Cost of Living & Jobs', icon: 'cart', caption: 'Statistics Canada · updates monthly', items: col },
].filter(s => s.items.length);

// Government Decisions tab — its own file so it loads like News and Crypto.
if (dealItems.length) writeFileSync(GOV_OUT, JSON.stringify({
  generated_at: now.toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET',
  date_key: todayIso,
  caption: 'Federal decisions and Canadian economic policy from CBC, CP24, ISED, Finance Canada, the Bank of Canada, CDEV, the Canada Media Fund and the C.D. Howe Institute · updates a few times a day',
  items: dealItems,
  sources: [
    { title: 'CBC News', url: 'https://www.cbc.ca/news/business' }, { title: 'CP24', url: 'https://www.cp24.com/' },
    { title: 'ISED', url: 'https://ised-isde.canada.ca/site/ised/en' }, { title: 'Finance Canada', url: 'https://www.canada.ca/en/department-finance.html' }, { title: 'Bank of Canada', url: 'https://www.bankofcanada.ca/press/' },
    { title: 'CDEV', url: 'https://cdev.gc.ca/' }, { title: 'Canada Media Fund', url: 'https://cmf-fmc.ca/' }, { title: 'C.D. Howe Institute', url: 'https://www.cdhowe.org/' },
  ],
  feed_status: feedStatus,
}, null, 2) + '\n');

if (!sections.some(s => !s.key.startsWith('invest'))) { console.error('Nothing fetched; keeping existing canada.json'); process.exit(0); }

const out = {
  generated_at: now.toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET',
  date_key: todayIso,
  sections,
  sources: [
    { title: 'CAA gas prices', url: URLS.caa },
    { title: 'Bank of Canada', url: 'https://www.bankofcanada.ca/rates/' },
    { title: 'Statistics Canada', url: 'https://www150.statcan.gc.ca/n1/dai-quo/index-eng.htm' },
    { title: 'Budget 2026', url: 'https://budget.canada.ca/2026/home-accueil-en.html' },
  ],
};
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log('Wrote', OUT, sections.map(s => s.title + ': ' + s.items.map(i => i.name + ' ' + i.value + (i.stale ? ' (stale)' : '')).join(', ')).join(' | '));
