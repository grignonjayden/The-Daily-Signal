// Portfolio Visualizer price list: popular Canadian and U.S. stocks and ETFs, written to quotes.json.
// Runs about every 15 minutes inside the news loop (.github/workflows/update-news.yml). No dependencies.
// Crypto is priced live in the visitor's browser from CoinGecko, so it isn't listed here.
import { writeFileSync, existsSync, readFileSync } from 'node:fs';

const UA = { 'User-Agent': 'Mozilla/5.0 (TheDailySignal personal dashboard)', 'Accept': 'application/json' };
const TZ = 'America/Toronto';

// TSX: big companies (roughly the S&P/TSX 60) and popular Canadian ETFs.
const TSX = `RY TD SHOP ENB CNQ CP CNR BMO BNS CM BN TRI CSU ATD SU MFC SLF TRP NA CVE WCN IFC AEM ABX FNV NTR BCE T RCI-B QSR L
GIB-A DOL WPM TECK-B IMO PPL FTS EMA H MG GWO POW CCO K FM SAP WSP CAE OTEX BAM CTC-A X MRU WN CCL-B TOU ARX AC LUN
CLS KXS DSG FFH TFII EQB GFL BIP-UN BEP-UN CAR-UN REI-UN
XIU XIC VFV VEQT XEQT VGRO XGRO VBAL XBAL VCNS VCN ZCN ZSP XUS ZEB XEI VDY ZDV ZAG XBB VAB HXT HXQ XAW VXC ZQQ QQC XQQ
TEC ZWB ZWC CASH PSA ZMMK HSAV XSP XEF XEC ZEA ZEM VIU XGD ZGLD CGL`.split(/\s+/).filter(Boolean).map(s => s + '.TO');
// U.S.: the largest companies and the most-held ETFs.
const US = `AAPL MSFT NVDA AMZN GOOGL META TSLA AVGO BRK-B JPM V MA LLY UNH XOM JNJ WMT PG HD COST ORCL NFLX AMD CRM ADBE KO PEP MRK ABBV
BAC CVX INTC CSCO QCOM TXN IBM DIS NKE MCD SBUX BA CAT GE UBER PLTR COIN PYPL SQ SNOW MU ARM SMCI TSM ASML BABA SHOP
VZ T PFE MRNA WFC GS MS C SCHW BLK SPGI ABNB RIVN F GM LULU TGT LOW
SPY VOO IVV VTI QQQ DIA IWM SCHD VGT VUG VTV VXUS VEA VWO BND AGG TLT GLD SLV ARKK SMH SOXX XLK XLF XLE XLV JEPI JEPQ`.split(/\s+/).filter(Boolean);

async function getJSON(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}
async function quote(symbol) {
  for (const host of ['query1', 'query2']) {
    try {
      const j = await getJSON(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`);
      const m = j.chart.result[0].meta;
      const price = m.regularMarketPrice, prev = m.chartPreviousClose ?? m.previousClose;
      if (typeof price !== 'number') throw new Error('no price');
      return {
        s: symbol.replace(/\.TO$/, ''), x: symbol.endsWith('.TO') ? 'TSX' : 'US',
        n: (m.shortName || m.longName || symbol).replace(/\s+/g, ' ').trim(),
        c: (m.currency || (symbol.endsWith('.TO') ? 'CAD' : 'USD')).toUpperCase(),
        p: +price.toFixed(4), pc: prev ? +prev.toFixed(4) : null,
      };
    } catch (e) { if (host === 'query2') console.warn(`${symbol}: skipped (${e.message})`); }
  }
  return null;
}

// A few at a time so Yahoo doesn't rate-limit us.
const symbols = [...TSX, ...US];
const out = [];
for (let i = 0; i < symbols.length; i += 8) {
  const got = await Promise.all(symbols.slice(i, i + 8).map(quote));
  out.push(...got.filter(Boolean));
}

// Keep the last known price for anything that failed this run (marked stale).
const prev = existsSync('quotes.json') ? JSON.parse(readFileSync('quotes.json', 'utf8')) : null;
const have = new Set(out.map(q => q.x + ':' + q.s));
for (const q of (prev && prev.quotes) || []) if (!have.has(q.x + ':' + q.s)) out.push({ ...q, stale: true });

if (out.filter(q => !q.stale).length < 20) { console.error('Too few quotes this run; keeping quotes.json unchanged.'); process.exit(0); }

const now = new Date();
writeFileSync('quotes.json', JSON.stringify({
  generated_at: now.toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET',
  updated_ts: now.getTime(),
  source: { title: 'Yahoo Finance', url: 'https://finance.yahoo.com/' },
  quotes: out.sort((a, b) => a.s.localeCompare(b.s)),
}) + '\n');
console.log(`Wrote quotes.json: ${out.length} quotes (${out.filter(q => q.stale).length} stale).`);
