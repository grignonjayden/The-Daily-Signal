// Portfolio Visualizer price list, written to quotes.json. Runs about every 15 minutes inside the news loop
// (.github/workflows/update-news.yml) and from update-quotes.yml. No dependencies.
// Covers: every U.S.-listed stock worth $1B+ (from a daily copy of Nasdaq's listings), recent U.S. IPOs,
// the S&P/TSX Composite and more Canadian names, ~350 popular ETFs (bond funds flagged), major indexes and futures.
// Crypto is priced live in the visitor's browser from CoinGecko, so it isn't listed here.
// Record fields: s symbol, x exchange (TSX | US | IDX | FUT), n name, c currency, p price, pc previous close,
// t type (s stock, e ETF, i index, f future), m market cap ($B, U.S. stocks), ipo year, b 1 = bond ETF,
// r rank in its list (for browsing), k futures contract multiplier, h 1 = also gets a year of weekly history (risk tools), stale = last known price.
import { writeFileSync, existsSync, readFileSync } from 'node:fs';

const UA = { 'User-Agent': 'Mozilla/5.0 (TheDailySignal personal dashboard)', 'Accept': 'application/json' };
const TZ = 'America/Toronto';
const words = s => s.split(/\s+/).filter(Boolean);

// ---- Canada: S&P/TSX Composite-style list plus other well-known TSX names ----
const TSX = words(`RY TD SHOP ENB CNQ CP CNR BMO BNS CM BN TRI CSU ATD SU MFC SLF TRP NA CVE WCN IFC AEM ABX FNV NTR BCE T RCI-B QSR L
GIB-A DOL WPM TECK-B IMO PPL FTS EMA H MG GWO POW CCO K FM SAP WSP CAE OTEX BAM CTC-A X MRU WN CCL-B TOU ARX AC LUN
CLS KXS DSG FFH TFII EQB GFL BIP-UN BEP-UN CAR-UN REI-UN
AGI ALA AP-UN AQN ATH ATRL ATZ BB BBD-B BDGI BEI-UN BHC BIR BLX BTE BYD CCA CEU CG CHP-UN CIGI CIX CJT CPX CRR-UN CRT-UN CS
CSH-UN CU DFY DML DOO ELD EFN EFR EMP-A EQX ERO FCR-UN FRU FSV FTT FVI GEI GIL GRT-UN GSY HBM HR-UN HWX IAG IGM IIP-UN IMG IVN
KEY KMP-UN KNT LB LIF LNR LSPD LUG MATR MDA MEG MFI MRE MTL MTY MX NFI NGD NPI NVA NWC NWH-UN NXE OGC OLA ONEX OR PAAS PBH PD PET
PEY PKI POU PRMW PSI PSK QBR-B RCH RUS SCR SES SIA SII SJ SOBO SRU-UN SSRM STN SVI SVM TA TCL-A TFPM TIH TLRY TPZ TVE TXG VET
WCP WDO WELL WFG WPK DIR-UN SGR-UN SMU-UN AX-UN TNT-UN HOM-U MI-UN PMZ-UN NG ORA CPKR ACO-X BLDP WEED ACB HUT BITF HIVE DNTL GOOS`);
const TSX_ETF = words(`XIU XIC VFV VEQT XEQT VGRO XGRO VBAL XBAL VCNS XCNS VCIP VCN ZCN ZSP XUS XUU VUN VUS ZEB XEI VDY ZDV HXT HXQ HXS HXDM XAW VXC
ZQQ QQC XQQ TEC ZWB ZWC ZWU ZWE ZWH ZWT CASH PSA ZMMK HSAV CMR XSP XEF XEC ZEA ZEM VIU VEE VEF VI XGD ZGLD CGL ZUQ ZLB ZLU ZRE
XRE VRE XEG ZEO XFN XIT XHC ZDI ZGRO ZBAL ZEQT ZCON ZESG XESG HMAX UMAX ZPR CPD XDIV XDV CDZ ZDY VGG ZUE ZUT XMA XMD XCS ZID ZJPN
QQCC QMAX TXF
ZAG XBB VAB XSB ZST XHY ZHY XCB ZCS ZCM VSB VSC ZDB ZFL XLB ZUB HBB`);
const TSX_BOND = new Set(words('ZAG XBB VAB XSB ZST XHY ZHY XCB ZCS ZCM VSB VSC ZDB ZFL XLB ZUB HBB ZPR CPD'));

// ---- U.S.: the original core list (always priced, always gets history) and popular ETFs ----
const US_CORE = words(`AAPL MSFT NVDA AMZN GOOGL META TSLA AVGO BRK-B JPM V MA LLY UNH XOM JNJ WMT PG HD COST ORCL NFLX AMD CRM ADBE KO PEP MRK ABBV
BAC CVX INTC CSCO QCOM TXN IBM DIS NKE MCD SBUX BA CAT GE UBER PLTR COIN PYPL SQ SNOW MU ARM SMCI TSM ASML BABA SHOP
VZ T PFE MRNA WFC GS MS C SCHW BLK SPGI ABNB RIVN F GM LULU TGT LOW`);
const US_ETF = words(`SPY VOO IVV VTI QQQ DIA IWM SCHD VGT VUG VTV VXUS VEA VWO BND AGG TLT GLD SLV ARKK SMH SOXX XLK XLF XLE XLV JEPI JEPQ
QQQM IWF IWD IJH IJR MDY RSP SPLG SCHB SCHX SCHG SCHA SCHF SCHE SCHP SCHZ SCHH VO VB VBR VBK VYM VIG VNQ VT VEU BNDX IEF SHY SHV
BIL SGOV TIP LQD HYG JNK EMB MUB GOVT VCIT VCSH VGIT VGSH BSV BIV BLV IAU GLDM PPLT USO UNG DBC PDBC ARKW ARKG ARKF XLY XLP XLI
XLB XLU XLRE XLC KRE KBE XBI IBB XOP XHB ITB XRT GDX GDXJ SIL URA LIT TAN ICLN QCLN JETS HACK CIBR BOTZ ROBO AIQ IGV SKYY FDN
KWEB FXI MCHI EWJ EWZ EWC EWG EWU EWA EWY EWT INDA EFA EEM IEFA IEMG ACWI MTUM QUAL USMV VLUE SPHD SPYD DGRO DVY HDV NOBL QYLD
XYLD DIVO SPYI TQQQ SQQQ SPXL SPXU UPRO SOXL SOXS TNA TZA UVXY VXX SVXY IBIT FBTC GBTC ETHA ARKB BITO COWZ AVUV DFAC VTWO VXF
ESGU ESGV VOOG VOOV VONG MGK SPYG SPYV IUSG IVW IVE ITOT IXUS VGK VPL EZU XLG OEF SPMO SPHQ FTEC VHT VDE VFH VIS VPU VAW VCR VDC
VOX VNQI REET IYR ICF SDY FVD PFF PGX FLOT USFR TFLO JPST MINT NEAR VTIP STIP SCHR SPTL SPTS SPAB SPIB SPSB IGSB IGIB USIG HYLB
SJNK BKLN SRLN ANGL FALN VWOB PCY CWB`);
const US_BOND = new Set(words(`BND AGG TLT BNDX IEF SHY SHV BIL SGOV TIP LQD HYG JNK EMB MUB GOVT VCIT VCSH VGIT VGSH BSV BIV BLV PFF PGX FLOT USFR TFLO
JPST MINT NEAR VTIP STIP SCHR SPTL SPTS SPAB SPIB SPSB IGSB IGIB USIG HYLB SJNK BKLN SRLN ANGL FALN VWOB PCY CWB SCHP SCHZ`));

// ---- Indexes (can't be bought directly; the site points to funds that track them) ----
const INDEXES = [['^GSPC', 'S&P 500'], ['^IXIC', 'Nasdaq Composite'], ['^NDX', 'Nasdaq-100'], ['^DJI', 'Dow Jones Industrial Average'],
  ['^RUT', 'Russell 2000'], ['^GSPTSE', 'S&P/TSX Composite'], ['^VIX', 'VIX (fear gauge)'], ['^FTSE', 'FTSE 100 (U.K.)'], ['^GDAXI', 'DAX (Germany)'],
  ['^FCHI', 'CAC 40 (France)'], ['^STOXX50E', 'Euro Stoxx 50'], ['^N225', 'Nikkei 225 (Japan)'], ['^HSI', 'Hang Seng (Hong Kong)'],
  ['000001.SS', 'Shanghai Composite'], ['^AXJO', 'S&P/ASX 200 (Australia)'], ['^KS11', 'KOSPI (South Korea)'], ['^NSEI', 'Nifty 50 (India)'],
  ['^BVSP', 'Bovespa (Brazil)'], ['^MXX', 'IPC (Mexico)'], ['^TNX', 'U.S. 10-year Treasury yield'], ['^IRX', 'U.S. 13-week T-bill yield'],
  ['^TYX', 'U.S. 30-year Treasury yield'], ['DX-Y.NYB', 'U.S. Dollar Index']];

// ---- Futures: [symbol, name, contract multiplier (dollars per 1.00 move in the quoted price)] ----
const FUTURES = [['ES=F', 'E-mini S&P 500', 50], ['MES=F', 'Micro E-mini S&P 500', 5], ['NQ=F', 'E-mini Nasdaq-100', 20], ['MNQ=F', 'Micro E-mini Nasdaq-100', 2],
  ['YM=F', 'E-mini Dow', 5], ['RTY=F', 'E-mini Russell 2000', 50], ['CL=F', 'Crude oil (WTI)', 1000], ['BZ=F', 'Brent crude oil', 1000],
  ['NG=F', 'Natural gas', 10000], ['RB=F', 'Gasoline (RBOB)', 42000], ['HO=F', 'Heating oil', 42000], ['GC=F', 'Gold', 100], ['MGC=F', 'Micro gold', 10],
  ['SI=F', 'Silver', 5000], ['HG=F', 'Copper', 25000], ['PL=F', 'Platinum', 50], ['PA=F', 'Palladium', 100], ['ZC=F', 'Corn', 50], ['ZW=F', 'Wheat', 50],
  ['ZS=F', 'Soybeans', 50], ['KC=F', 'Coffee', 375], ['SB=F', 'Sugar', 1120], ['CC=F', 'Cocoa', 10], ['CT=F', 'Cotton', 500], ['LE=F', 'Live cattle', 400],
  ['HE=F', 'Lean hogs', 400], ['ZB=F', 'U.S. 30-year Treasury bond', 1000], ['ZN=F', 'U.S. 10-year Treasury note', 1000], ['ZF=F', 'U.S. 5-year Treasury note', 1000],
  ['ZT=F', 'U.S. 2-year Treasury note', 2000], ['6C=F', 'Canadian dollar', 100000], ['6E=F', 'Euro', 125000], ['6J=F', 'Japanese yen', 12500000],
  ['6B=F', 'British pound', 62500], ['BTC=F', 'Bitcoin (CME)', 5], ['MBT=F', 'Micro Bitcoin (CME)', 0.1], ['ETH=F', 'Ether (CME)', 50]];

async function getJSON(url, ms = 15000) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// U.S. stock directory: a daily copy of Nasdaq's NASDAQ/NYSE/AMEX listings with market cap and IPO year.
const prev = existsSync('quotes.json') ? JSON.parse(readFileSync('quotes.json', 'utf8')) : null;
const thisYear = new Date().getFullYear();
let usDir = [];
try {
  for (const ex of ['nasdaq', 'nyse', 'amex']) {
    const rows = await getJSON(`https://raw.githubusercontent.com/rreichel3/US-Stock-Symbols/main/${ex}/${ex}_full_tickers.json`, 30000);
    for (const r of rows) {
      const sym = String(r.symbol || '').trim().replace(/[/.]/g, '-');
      if (!sym || /[\^ ]/.test(sym)) continue; // skip preferreds and odd classes
      const mc = parseFloat(r.marketCap) || 0, ipo = parseInt(r.ipoyear, 10) || null;
      const recentIpo = ipo && ipo >= thisYear - 1;
      if (mc >= 1e9 || (recentIpo && mc >= 1e8)) usDir.push({ s: sym, n: String(r.name || sym).replace(/\s+(Common Stock|Class [A-C] Common Stock|Ordinary Shares|American Depositary Shares)\b.*$/i, '').trim() || sym, m: +(mc / 1e9).toFixed(1), ipo: recentIpo ? ipo : undefined });
    }
  }
  console.log(`U.S. directory: ${usDir.length} stocks ($1B+ or recent IPOs).`);
} catch (e) {
  console.warn('U.S. directory unavailable (' + e.message + '); reusing last list.');
  usDir = ((prev && prev.quotes) || []).filter(q => q.x === 'US' && q.t === 's').map(q => ({ s: q.s, n: q.n, m: q.m, ipo: q.ipo }));
}

// Build the list of things to price: [yahooSymbol, base record]
const items = new Map();
const add = (ysym, rec) => { if (!items.has(ysym)) items.set(ysym, rec); };
TSX.forEach((s, r) => add(s + '.TO', { s, x: 'TSX', t: 's', h: 1, r }));
TSX_ETF.forEach((s, i) => add(s + '.TO', { s, x: 'TSX', t: 'e', b: TSX_BOND.has(s) ? 1 : undefined, h: i < 120 ? 1 : undefined, r: i }));
US_ETF.forEach((s, i) => add(s, { s, x: 'US', t: 'e', b: US_BOND.has(s) ? 1 : undefined, h: i < 160 ? 1 : undefined, r: i }));
const coreSet = new Set(US_CORE);
usDir.sort((a, b) => (b.m || 0) - (a.m || 0)).forEach(d => { if (!US_ETF.includes(d.s)) add(d.s, { s: d.s, x: 'US', t: 's', n: d.n, m: d.m, ipo: d.ipo, h: (coreSet.has(d.s) || d.m >= 50) ? 1 : undefined }); });
US_CORE.forEach(s => add(s, { s, x: 'US', t: 's', h: 1 }));
INDEXES.forEach(([s, n], r) => add(s, { s, x: 'IDX', t: 'i', n, r }));
FUTURES.forEach(([s, n, k], r) => add(s, { s, x: 'FUT', t: 'f', n, k, r }));
console.log(`Pricing ${items.size} symbols…`);

// Prices: Yahoo's spark endpoint takes 20 symbols per call; anything it misses falls back to one chart call each.
const meta = new Map();
async function spark(list) {
  for (const host of ['query1', 'query2']) {
    try {
      const j = await getJSON(`https://${host}.finance.yahoo.com/v7/finance/spark?symbols=${list.map(encodeURIComponent).join(',')}&range=1d&interval=1d`);
      let n = 0;
      for (const r of (j.spark && j.spark.result) || []) {
        const m = r.response && r.response[0] && r.response[0].meta;
        if (m && typeof m.regularMarketPrice === 'number') { meta.set(r.symbol, m); n++; }
      }
      if (n) return;
    } catch (e) { /* try next host */ }
  }
}
async function chart(symbol) {
  for (const host of ['query1', 'query2']) {
    try {
      const j = await getJSON(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`);
      const m = j.chart.result[0].meta;
      if (typeof m.regularMarketPrice === 'number') { meta.set(symbol, m); return; }
    } catch (e) { /* try next host */ }
  }
}
const started = Date.now(), budget = (+process.env.QUOTES_BUDGET_SEC || 150) * 1000; // stays short: this runs inside the 3-minute news loop
const all = [...items.keys()];
const batches = []; for (let i = 0; i < all.length; i += 20) batches.push(all.slice(i, i + 20));
for (let i = 0; i < batches.length && Date.now() - started < budget; i += 4) await Promise.all(batches.slice(i, i + 4).map(spark));
const missing = all.filter(s => !meta.has(s));
// Fallback: priority symbols first (history set, indexes, futures), then the rest while time allows.
missing.sort((a, b) => (items.get(b).h ? 1 : 0) - (items.get(a).h ? 1 : 0) || (items.get(b).t !== 's' ? 1 : 0) - (items.get(a).t !== 's' ? 1 : 0));
console.log(`Spark priced ${meta.size}; ${missing.length} left for single lookups.`);
for (let i = 0; i < missing.length && Date.now() - started < budget; i += 10) await Promise.all(missing.slice(i, i + 10).map(chart));

const today = new Date().toISOString().slice(0, 10), cutoff = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
const prevBy = new Map(((prev && prev.quotes) || []).map(q => [q.x + ':' + q.s, q]));
const out = [];
for (const [ysym, rec] of items) {
  const m = meta.get(ysym), old = prevBy.get(rec.x + ':' + rec.s);
  const base = { ...rec, n: rec.n || (m && (m.shortName || m.longName)) || (old && old.n) || rec.s };
  base.n = String(base.n).replace(/\s+/g, ' ').trim();
  if (m) {
    const pc = m.chartPreviousClose ?? m.previousClose;
    out.push({ ...base, c: (m.currency || (rec.x === 'TSX' ? 'CAD' : 'USD')).toUpperCase(), p: +m.regularMarketPrice.toFixed(4), pc: typeof pc === 'number' ? +pc.toFixed(4) : null });
  } else if (old && typeof old.p === 'number') out.push({ ...base, c: old.c, p: old.p, pc: old.pc, stale: true, sd: old.sd || today });
}
// Keep anything from the last file that dropped out of today's lists (so saved holdings keep a price).
const have = new Set(out.map(q => q.x + ':' + q.s));
// Stale records are dropped after 30 days without a fresh price.
for (const q of (prev && prev.quotes) || []) if (!have.has(q.x + ':' + q.s) && (!q.sd || q.sd >= cutoff)) out.push({ ...q, stale: true, sd: q.sd || today });
for (const q of out) for (const k of Object.keys(q)) if (q[k] === undefined) delete q[k];

if (out.filter(q => !q.stale).length < 20) { console.error('Too few quotes this run; keeping quotes.json unchanged.'); process.exit(0); }

const now = new Date();
// One record per line so git stores small diffs between runs.
const head = {
  generated_at: now.toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET',
  updated_ts: now.getTime(),
  source: { title: 'Yahoo Finance', url: 'https://finance.yahoo.com/' },
};
const body = out.sort((a, b) => a.x.localeCompare(b.x) || a.s.localeCompare(b.s)).map(q => JSON.stringify(q)).join(',\n');
writeFileSync('quotes.json', JSON.stringify(head).slice(0, -1) + ',"quotes":[\n' + body + '\n]}\n');
console.log(`Wrote quotes.json: ${out.length} quotes (${out.filter(q => q.stale).length} stale) in ${Math.round((Date.now() - started) / 1000)}s.`);
