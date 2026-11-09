// Pulls the latest headlines from official and Wall Street news feeds and writes news.json.
// Runs on a schedule in GitHub Actions (.github/workflows/update-news.yml). No dependencies.
import { writeFileSync } from 'node:fs';

const FEEDS = [
  // Central banks, regulators and governments
  { source: 'Federal Reserve', official: true, url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
  { source: 'Bank of Canada', official: true, url: 'https://www.bankofcanada.ca/content_type/press-releases/feed/' },
  { source: 'Finance Canada', official: true, url: 'https://api.io.canada.ca/io-server/gc/news/en/v2?dept=departmentfinance&sort=publishedDate&orderBy=desc&pick=20&format=atom' },
  { source: 'Statistics Canada', official: true, url: 'https://www150.statcan.gc.ca/n1/rss/dai-quo/0-eng.atom' },
  { source: 'U.S. SEC', official: true, url: 'https://www.sec.gov/news/pressreleases.rss' },
  // Wall Street and Canadian business news
  { source: 'WSJ Markets', url: 'https://feeds.content.dowjones.io/public/rss/RSSMarketsMain' },
  { source: 'CNBC', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114' },
  { source: 'MarketWatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
  { source: 'Globe and Mail', url: 'https://www.theglobeandmail.com/arc/outboundfeeds/rss/category/business/' },
];

const MAX_ARTICLES = 12; // main "Latest headlines" list (news outlets only)
const PER_SOURCE = 3;    // cap per outlet so one source can't take over the list
const MAX_OFFICIAL = 8;  // "Official releases" card
const OFFICIAL_PER_SOURCE = 2;
const MAX_TICKER = 12;   // rows in "Throughout the Day"
const MAX_AGE_DAYS = 7;
const TZ = 'America/Toronto';

const decode = s => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;|&#8217;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

const tag = (block, names) => {
  for (const n of names) {
    const m = block.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`, 'i'));
    if (m) return m[1];
  }
  return '';
};

// Pulls a thumbnail from media:content / media:thumbnail / image enclosure / first <img> in the item.
function findImage(b) {
  const pats = [
    /<media:thumbnail[^>]*url="([^"]+)"/i,
    /<media:content[^>]*url="([^"]+\.(?:jpe?g|png|webp)[^"]*)"/i,
    /<media:content[^>]*medium="image"[^>]*url="([^"]+)"/i,
    /<media:content[^>]*url="([^"]+)"[^>]*medium="image"/i,
    /<enclosure[^>]*url="([^"]+)"[^>]*type="image/i,
    /<enclosure[^>]*type="image[^"]*"[^>]*url="([^"]+)"/i,
    /<img[^>]*src=["']([^"']+)["']/i,
    /&lt;img[^&]*src=(?:&quot;|")([^"&]+)/i,
  ];
  for (const re of pats) {
    const m = b.match(re);
    if (m && /^https:\/\//.test(m[1])) return m[1].replace(/&amp;/g, '&');
  }
  return '';
}

function parse(xml, source) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map(b => {
    let url = decode(tag(b, ['link']));
    if (!url) { const m = b.match(/<link[^>]*href="([^"]+)"/i); url = m ? m[1].replace(/&amp;/g, '&') : ''; }
    const date = new Date(decode(tag(b, ['pubDate', 'published', 'updated', 'dc:date'])));
    let snippet = decode(tag(b, ['description', 'summary', 'content']));
    if (snippet.length > 220) snippet = snippet.slice(0, 217).replace(/\s+\S*$/, '') + '…';
    return { source, title: decode(tag(b, ['title'])), url, snippet, date, image: findImage(b) };
  }).filter(i => i.title && /^https?:\/\//.test(i.url) && !isNaN(i.date));
}

async function load(feed) {
  try {
    const res = await fetch(feed.url, {
      headers: { 'User-Agent': 'TheDailySignal/1.0 (personal news digest; github.com/grignonjayden/the-daily-signal)', 'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const items = parse(await res.text(), feed.source).map(i => ({ ...i, official: !!feed.official }));
    const newest = items.reduce((m, i) => (i.date > m ? i.date : m), new Date(0));
    console.log(`${feed.source}: ${items.length} items, newest ${newest.toISOString()} (${feed.url})`);
    return items;
  } catch (e) {
    console.warn(`${feed.source}: skipped (${e.message})`);
    return [];
  }
}

const fmt = (d, opts) => d.toLocaleString('en-US', { timeZone: TZ, ...opts });

const cutoff = Date.now() - MAX_AGE_DAYS * 864e5;
const results = await Promise.all(FEEDS.map(load));
const all = results.flat().filter(i => i.date.getTime() >= cutoff).sort((a, b) => b.date - a.date);

if (!all.length) { console.error('No feeds returned anything; leaving news.json unchanged.'); process.exit(0); }

const seen = new Set();
const unique = all.filter(i => !seen.has(i.url) && seen.add(i.url));

const capBy = (items, per, max) => { const n = {}; return items.filter(i => (n[i.source] = (n[i.source] || 0) + 1) <= per).slice(0, max); };
const news = unique.filter(i => !i.official);
const articles = capBy(news, PER_SOURCE, MAX_ARTICLES);
const used = new Set(articles.map(a => a.url));
const ticker = news.filter(i => !used.has(i.url)).slice(0, MAX_TICKER);
const official = capBy(unique.filter(i => i.official), OFFICIAL_PER_SOURCE, MAX_OFFICIAL);

const now = new Date();
const card = a => ({
  title: a.title, source: a.source, url: a.url, snippet: a.snippet, image: a.image || undefined,
  time: fmt(a.date, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
});
const out = {
  generated_at: fmt(now, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET',
  date_key: now.toLocaleDateString('en-CA', { timeZone: TZ }),
  articles: articles.map(card),
  official: official.map(card),
  ticker: ticker.map(t => {
    const sameDay = t.date.toLocaleDateString('en-CA', { timeZone: TZ }) === now.toLocaleDateString('en-CA', { timeZone: TZ });
    return { time: fmt(t.date, sameDay ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric' }), title: t.source + ' — ' + t.title, url: t.url };
  }),
};

writeFileSync('news.json', JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote news.json: ${out.articles.length} articles, ${out.official.length} official, ${out.ticker.length} ticker rows.`);
