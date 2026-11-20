// Major markets Ballast can pull live data for, and the plain-English names people
// use for them. Symbols follow Yahoo Finance conventions (crypto pairs come from
// Coinbase): exchange suffixes like .L (London) or .T (Tokyo), ^ for indices,
// =X for currency pairs and =F for futures.

export const MARKETS = [
  {
    group: "US", note: "NYSE and Nasdaq, in USD",
    items: [
      ["SPY", "S&P 500 ETF", "s&p 500, s&p, sp500, spx etf, the market, us stocks, stocks"],
      ["QQQ", "Nasdaq-100 ETF", "nasdaq 100, nasdaq-100, nasdaq, tech stocks"],
      ["DIA", "Dow Jones ETF", "dow etf, dow jones"],
      ["IWM", "Russell 2000 ETF", "russell 2000, small caps, small cap stocks"],
      ["AAPL", "Apple", "apple"], ["MSFT", "Microsoft", "microsoft"], ["NVDA", "Nvidia", "nvidia"],
      ["AMZN", "Amazon", "amazon"], ["GOOGL", "Alphabet", "alphabet, google"], ["META", "Meta", "meta, facebook"],
      ["TSLA", "Tesla", "tesla"], ["BRK-B", "Berkshire Hathaway", "berkshire, berkshire hathaway"],
      ["JPM", "JPMorgan Chase", "jpmorgan, jp morgan"],
    ],
  },
  {
    group: "Indices", note: "price indices, no dividends",
    items: [
      ["^GSPC", "S&P 500 index", "s&p 500 index, spx"], ["^IXIC", "Nasdaq Composite", "nasdaq composite"],
      ["^DJI", "Dow Jones Industrial Average", "dow jones index, djia"], ["^RUT", "Russell 2000 index", "russell 2000 index"],
      ["^VIX", "CBOE Volatility Index", "vix, volatility index, fear index"],
      ["^FTSE", "FTSE 100", "ftse, ftse 100, uk stocks"], ["^GDAXI", "DAX", "dax, german stocks"],
      ["^FCHI", "CAC 40", "cac, cac 40, french stocks"], ["^STOXX50E", "Euro Stoxx 50", "euro stoxx, euro stoxx 50, european stocks"],
      ["^N225", "Nikkei 225", "nikkei, nikkei 225, japanese stocks, japan"], ["^HSI", "Hang Seng", "hang seng, hong kong stocks"],
      ["000001.SS", "Shanghai Composite", "shanghai composite, chinese stocks"], ["^NSEI", "Nifty 50", "nifty, nifty 50, indian stocks"],
      ["^KS11", "KOSPI", "kospi, korean stocks"], ["^AXJO", "S&P/ASX 200", "asx, asx 200, australian stocks"],
      ["^GSPTSE", "S&P/TSX Composite", "tsx, canadian stocks"], ["^BVSP", "Bovespa", "bovespa, ibovespa, brazilian stocks"],
    ],
  },
  {
    group: "Europe", note: "local currency",
    items: [
      ["SHEL.L", "Shell (London)", "shell"], ["AZN.L", "AstraZeneca (London)", "astrazeneca"], ["HSBA.L", "HSBC (London)", "hsbc"],
      ["SAP.DE", "SAP (Frankfurt)", "sap"], ["SIE.DE", "Siemens (Frankfurt)", "siemens"],
      ["MC.PA", "LVMH (Paris)", "lvmh"], ["ASML.AS", "ASML (Amsterdam)", "asml"], ["NESN.SW", "Nestlé (Zurich)", "nestle"],
      ["NOVO-B.CO", "Novo Nordisk (Copenhagen)", "novo nordisk"],
    ],
  },
  {
    group: "Asia-Pacific", note: "local currency",
    items: [
      ["7203.T", "Toyota (Tokyo)", "toyota"], ["6758.T", "Sony (Tokyo)", "sony"], ["9984.T", "SoftBank Group (Tokyo)", "softbank"],
      ["0700.HK", "Tencent (Hong Kong)", "tencent"], ["9988.HK", "Alibaba (Hong Kong)", "alibaba"],
      ["2330.TW", "TSMC (Taipei)", "tsmc, taiwan semiconductor"], ["005930.KS", "Samsung Electronics (Seoul)", "samsung"],
      ["RELIANCE.NS", "Reliance Industries (NSE)", "reliance"], ["BHP.AX", "BHP (Sydney)", "bhp"],
    ],
  },
  {
    group: "Americas", note: "local currency",
    items: [
      ["SHOP.TO", "Shopify (Toronto)", "shopify"], ["RY.TO", "Royal Bank of Canada (Toronto)", "royal bank of canada"],
      ["VALE3.SA", "Vale (São Paulo)", "vale"], ["PETR4.SA", "Petrobras (São Paulo)", "petrobras"],
    ],
  },
  {
    group: "Bonds & ETFs", note: "US-listed, in USD",
    items: [
      ["TLT", "20+ Year Treasury ETF", "long bonds, long-term treasuries, treasuries, bonds, long term bonds"],
      ["IEF", "7-10 Year Treasury ETF", "intermediate treasuries, intermediate bonds"],
      ["SHY", "1-3 Year Treasury ETF", "short-term treasuries, short term bonds, t-bills"],
      ["AGG", "US Aggregate Bond ETF", "aggregate bonds, bond market"], ["EFA", "Developed Markets ETF", "developed markets, international stocks"],
      ["EEM", "Emerging Markets ETF", "emerging markets"], ["VNQ", "US REIT ETF", "reits, real estate"],
      ["GLD", "Gold ETF", "gold etf"],
    ],
  },
  {
    group: "Commodities", note: "front-month futures",
    items: [
      ["GC=F", "Gold futures", "gold"], ["SI=F", "Silver futures", "silver"], ["CL=F", "WTI crude oil futures", "oil, crude, crude oil, wti"],
      ["BZ=F", "Brent crude futures", "brent"], ["NG=F", "Natural gas futures", "natural gas, nat gas"], ["HG=F", "Copper futures", "copper"],
      ["ZC=F", "Corn futures", "corn"], ["ZW=F", "Wheat futures", "wheat"],
    ],
  },
  {
    group: "Currencies", note: "spot FX",
    items: [
      ["DX-Y.NYB", "US Dollar Index", "dollar index, dollar, us dollar, dxy"], ["EURUSD=X", "EUR/USD", "euro, eur/usd, eurusd"],
      ["GBPUSD=X", "GBP/USD", "pound, sterling, gbp/usd"], ["USDJPY=X", "USD/JPY", "yen, usd/jpy"],
      ["USDCNY=X", "USD/CNY", "yuan, usd/cny"], ["AUDUSD=X", "AUD/USD", "aussie dollar, aud/usd"],
    ],
  },
  {
    group: "Crypto", note: "Coinbase, trades 24/7",
    items: [
      ["BTC-USD", "Bitcoin", "bitcoin, btc"], ["ETH-USD", "Ethereum", "ethereum, ether, eth"], ["SOL-USD", "Solana", "solana, sol"],
      ["XRP-USD", "XRP", "xrp, ripple"], ["DOGE-USD", "Dogecoin", "dogecoin, doge"],
    ],
  },
];

export const SYMBOLS = new Map(); // symbol -> { symbol, name, group }
const ALIASES = []; // [lowercase alias, symbol], longest first

for (const { group, items } of MARKETS) {
  for (const [symbol, name, aliases] of items) {
    SYMBOLS.set(symbol, { symbol, name, group });
    for (const a of aliases.split(",").map((s) => s.trim()).filter(Boolean)) ALIASES.push([a, symbol]);
    // lowercase tickers people type ("buy spy when..."), skipping ones that are ordinary words
    if (/^[A-Z]{3,5}$/.test(symbol) && !["SHY", "META"].includes(symbol)) ALIASES.push([symbol.toLowerCase(), symbol]);
  }
}
ALIASES.sort((a, b) => b[0].length - a[0].length);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ALIAS_RE = new RegExp(`(?<![\\w^.=-])(?:${ALIASES.map(([a]) => escapeRe(a)).join("|")})(?![\\w=-]|\\.[A-Za-z])`, "gi");
const ALIAS_MAP = new Map(ALIASES);

// Replaces company, index and asset names in free text with their symbols,
// e.g. "buy toyota when the nikkei..." -> "buy 7203.T when ^N225...".
export function replaceNames(text) {
  return text.replace(ALIAS_RE, (m) => ` ${ALIAS_MAP.get(m.toLowerCase())} `);
}

// A typed symbol or a plain name ("toyota", "gold", "nikkei") -> symbol, or null.
export function resolveSymbol(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const byName = ALIAS_MAP.get(s.toLowerCase());
  if (byName) return byName;
  const up = s.toUpperCase();
  return /^[\^]?[A-Z0-9][A-Z0-9.\-=]{0,19}$/.test(up) ? up : null;
}

export const nameOf = (symbol) => SYMBOLS.get(symbol)?.name || symbol;
