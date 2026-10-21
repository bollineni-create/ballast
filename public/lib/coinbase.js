// Coinbase Exchange public market data for crypto pairs (BTC-USD, ETH-USD, …).
// No key, and Coinbase allows requests from web pages, so this runs both in the
// server and directly in the page when Ballast is opened as a plain website.
//
// Bars: { time, open, high, low, close, volume } with time at UTC midnight.

const CRYPTO = /^[A-Z0-9]{2,10}-(USD|USDT|USDC|EUR|GBP|BTC|ETH)$/;
export const isCrypto = (s) => CRYPTO.test(s);

const BASE = "https://api.exchange.coinbase.com/products";
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
// `years` is a number of years or "max" for all available history.
const startOf = (years) => (years === "max" ? Date.UTC(1900, 0, 1) : Date.now() - years * 365.25 * 864e5);

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    const status = res.status === 404 || res.status === 429 ? res.status : 502;
    const err = new Error(status === 404 ? "Symbol not found"
      : status === 429 ? "Data provider rate limit hit; try again shortly"
      : `Data provider returned HTTP ${res.status}`);
    err.status = status;
    throw err;
  }
  return res.json();
}

export async function coinbaseHistory(symbol, years) {
  const bars = new Map();
  let end = Date.now();
  const stop = Math.max(startOf(years), Date.UTC(2014, 0, 1)); // Coinbase launched pairs from 2015
  let emptyPages = 0;
  while (end > stop && emptyPages < 2) {
    const start = Math.max(stop, end - 299 * 864e5);
    const rows = await getJson(`${BASE}/${symbol}/candles?granularity=86400&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`);
    // Stop after two empty pages in a row: we're before the pair was listed.
    emptyPages = Array.isArray(rows) && rows.length ? 0 : emptyPages + 1;
    if (Array.isArray(rows)) for (const [t, low, high, open, close, volume] of rows) bars.set(t * 1000, { time: t * 1000, open, high, low, close, volume });
    end = start - 864e5;
    await new Promise((r) => setTimeout(r, 120)); // stay under Coinbase's public rate limit
  }
  if (!bars.size) throw Object.assign(new Error(`No Coinbase data for ${symbol}`), { status: 404 });
  return { bars: [...bars.values()].sort((a, b) => a.time - b.time), currency: symbol.split("-")[1], name: symbol, exchange: "Coinbase" };
}

export async function coinbaseQuote(symbol) {
  const [ticker, stats] = await Promise.all([getJson(`${BASE}/${symbol}/ticker`), getJson(`${BASE}/${symbol}/stats`)]);
  const price = Number(ticker.price), open = Number(stats.open);
  const time = Date.parse(ticker.time) || Date.now();
  return {
    price, prevClose: open, changePct: open ? (price / open - 1) * 100 : 0,
    high: Number(stats.high), low: Number(stats.low), volume: Number(stats.volume),
    time, day: dayOf(time), currency: symbol.split("-")[1],
  };
}
