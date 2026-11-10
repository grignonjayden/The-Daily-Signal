// Pulls live market and crypto prices and writes prices.json.
// Runs every ~15 minutes in GitHub Actions (.github/workflows/update-prices.yml). No dependencies.
import { writeFileSync, existsSync, readFileSync } from 'node:fs';

const TZ = 'America/Toronto';
const UA = { 'User-Agent': 'Mozilla/5.0 (TheDailySignal personal dashboard)', 'Accept': 'application/json' };

// Markets: Yahoo Finance chart data (source link points to each quote page)
const MARKETS = [
  { symbol: '^GSPC', name: 'S&P 500' },
  { symbol: '^DJI', name: 'Dow Jones' },
  { symbol: '^IXIC', name: 'Nasdaq' },
  { symbol: '^GSPTSE', name: 'S&P/TSX' },
  { symbol: '^RUT', name: 'Russell 2000' },
  { symbol: '^VIX', name: 'VIX' },
  { symbol: '^TNX', name: 'U.S. 10-yr yield', suffix: '%' },
  { symbol: 'CL=F', name: 'WTI crude', prefix: '$' },
  { symbol: 'GC=F', name: 'Gold', prefix: '$' },
  { symbol: 'CAD=X', name: 'USD/CAD' },
];
const SECTORS = [
  { symbol: 'XLK', name: 'Technology' }, { symbol: 'SMH', name: 'Semiconductors' },
  { symbol: 'XLF', name: 'Financials' }, { symbol: 'XLE', name: 'Energy' },
  { symbol: 'XLV', name: 'Health care' }, { symbol: 'XLI', name: 'Industrials' },
  { symbol: 'XLY', name: 'Consumer discretionary' }, { symbol: 'XLP', name: 'Consumer staples' },
  { symbol: 'XLU', name: 'Utilities' }, { symbol: 'XLRE', name: 'Real estate' },
];

async function getJSON(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function yahoo(item) {
  for (const host of ['query1', 'query2']) {
    try {
      const j = await getJSON(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(item.symbol)}?range=1d&interval=15m`);
      const r = j.chart.result[0];
      const m = r.meta;
      const price = m.regularMarketPrice;
      const prev = m.chartPreviousClose ?? m.previousClose;
      const closes = (r.indicators?.quote?.[0]?.close || []).filter(v => v != null);
      return {
        name: item.name, symbol: item.symbol, price, prefix: item.prefix || '', suffix: item.suffix || '',
        change_pct: prev ? +(((price - prev) / prev) * 100).toFixed(2) : null,
        spark: closes.length > 1 ? closes.map(v => +v.toFixed(4)) : [prev, price],
        url: `https://finance.yahoo.com/quote/${encodeURIComponent(item.symbol)}`,
      };
    } catch (e) { if (host === 'query2') console.warn(`${item.symbol}: skipped (${e.message})`); }
  }
  return null;
}

async function crypto() {
  const base = 'https://api.coingecko.com/api/v3';
  const out = { coins: [], movers: [], global: null };
  try {
    const coins = await getJSON(`${base}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=true&price_change_percentage=24h`);
    const card = c => ({
      name: `${c.name} (${c.symbol.toUpperCase()})`, price: c.current_price, prefix: '$',
      change_pct: c.price_change_percentage_24h != null ? +c.price_change_percentage_24h.toFixed(2) : null,
      spark: (c.sparkline_in_7d?.price || []).filter((_, i, a) => i % 6 === 0 || i === a.length - 1).map(v => +v.toPrecision(6)),
      url: `https://www.coingecko.com/en/coins/${c.id}`, image: c.image,
    });
    out.coins = coins.slice(0, 10).filter(c => !['usdt', 'usdc', 'steth', 'wsteth', 'wbtc', 'weth', 'usds', 'usde'].includes(c.symbol)).slice(0, 8).map(card);
    const ranked = coins.filter(c => c.price_change_percentage_24h != null && !/usd/i.test(c.symbol));
    ranked.sort((a, b) => b.price_change_percentage_24h - a.price_change_percentage_24h);
    out.movers = [...ranked.slice(0, 4), ...ranked.slice(-4).reverse()].map(c => ({
      name: `${c.name} (${c.symbol.toUpperCase()})`, pct: +c.price_change_percentage_24h.toFixed(2),
      price: c.current_price, url: `https://www.coingecko.com/en/coins/${c.id}`,
    }));
    console.log(`CoinGecko coins: ${out.coins.length}, movers: ${out.movers.length}`);
  } catch (e) { console.warn('CoinGecko coins: skipped (' + e.message + ')'); }
  try {
    const g = (await getJSON(`${base}/global`)).data;
    out.global = {
      market_cap_usd: g.total_market_cap.usd,
      market_cap_change_pct: +g.market_cap_change_percentage_24h_usd.toFixed(2),
      btc_dominance: +g.market_cap_percentage.btc.toFixed(1),
      eth_dominance: +g.market_cap_percentage.eth.toFixed(1),
      url: 'https://www.coingecko.com/en/global-charts',
    };
  } catch (e) { console.warn('CoinGecko global: skipped (' + e.message + ')'); }
  return out;
}

const [markets, sectors, cryptoData] = await Promise.all([
  Promise.all(MARKETS.map(yahoo)),
  Promise.all(SECTORS.map(yahoo)),
  crypto(),
]);

const old = existsSync('prices.json') ? JSON.parse(readFileSync('prices.json', 'utf8')) : {};
const now = new Date();
const out = {
  generated_at: now.toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET',
  markets: markets.filter(Boolean),
  sectors: sectors.filter(Boolean).map(s => ({ name: s.name, symbol: s.symbol, change_pct: s.change_pct, url: s.url })),
  crypto: cryptoData.coins,
  crypto_movers: cryptoData.movers,
  crypto_global: cryptoData.global,
  sources: [
    { title: 'Yahoo Finance — market quotes', url: 'https://finance.yahoo.com/markets/' },
    { title: 'CoinGecko — cryptocurrency prices', url: 'https://www.coingecko.com/' },
  ],
};
// If a provider fails this run, keep its last good numbers instead of blanking the page.
for (const k of ['markets', 'sectors', 'crypto', 'crypto_movers']) if (!out[k].length && old[k]) out[k] = old[k];
if (!out.crypto_global && old.crypto_global) out.crypto_global = old.crypto_global;

console.log(`Markets: ${out.markets.length}, sectors: ${out.sectors.length}, crypto: ${out.crypto.length}`);
if (!out.markets.length && !out.crypto.length) { console.error('Nothing fetched; leaving prices.json unchanged.'); process.exit(0); }
writeFileSync('prices.json', JSON.stringify(out) + '\n');
