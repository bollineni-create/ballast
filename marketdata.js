// Live market data providers, normalized to daily bars and quotes.
//
// - Crypto pairs (BTC-USD, ETH-USD, …): Coinbase Exchange public API, no key
//   (public/lib/coinbase.js, shared with the page).
// - Stocks/ETFs/indices: Alpaca when ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY
//   are set (official API, free IEX feed), otherwise Yahoo Finance's public chart
//   endpoint (no key; unofficial, so it can change or rate-limit without notice).
//
// Bars: { time, open, high, low, close, volume } where time is UTC midnight of the
// trading day in the exchange's timezone. Quotes carry `day` (YYYY-MM-DD) in the
// same convention so the client can update or roll the forming daily bar.

import { isCrypto, coinbaseHistory, coinbaseQuote } from "./public/lib/coinbase.js";

const UA = { "User-Agent": "Mozilla/5.0 (Ballast local app)" };
const alpacaKeys = process.env.ALPACA_API_KEY_ID && process.env.ALPACA_API_SECRET_KEY
  ? { "APCA-API-KEY-ID": process.env.ALPACA_API_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET_KEY }
  : null;
const alpacaFeed = process.env.ALPACA_FEED || "iex";
const alpacaData = (process.env.ALPACA_DATA_URL || "https://data.alpaca.markets").replace(/\/$/, "");

export { isCrypto };

// Set when Alpaca rejects the keys (HTTP 401/403). Stocks then come from Yahoo
// Finance for the rest of this run instead of failing every request.
export let alpacaKeyError = null;
const useAlpaca = () => alpacaKeys && !alpacaKeyError;
export const stockProvider = () => (useAlpaca() ? "Alpaca" : "Yahoo Finance");

function rejectAlpaca(e) {
  if (!e.auth) throw e;
  alpacaKeyError = `Alpaca rejected the API keys (HTTP ${e.auth}), so stock prices come from Yahoo Finance. Check the Alpaca paper keys in Ballast > Edit Keys.`;
  console.warn(`[market data] ${alpacaKeyError}`);
}

export function cleanSymbol(raw) {
  const s = String(raw || "").trim().toUpperCase();
  if (!/^[A-Z0-9^.=\-]{1,20}$/.test(s)) throw new HttpError(400, `Invalid symbol "${raw}"`);
  return s;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(15000) });
  if (res.status === 404) throw new HttpError(404, "Symbol not found");
  if (res.status === 429) throw new HttpError(429, "Data provider rate limit hit; try again shortly");
  if (res.status === 401 || res.status === 403) {
    const e = new HttpError(502, `Data provider rejected the request (HTTP ${res.status})`);
    e.auth = res.status;
    throw e;
  }
  if (!res.ok) throw new HttpError(502, `Data provider returned HTTP ${res.status}`);
  return res.json();
}

// `years` is a number of years or "max" for all available history.
const startOf = (years) => (years === "max" ? Date.UTC(1900, 0, 1) : Date.now() - years * 365.25 * 864e5);
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const utcMidnight = (day) => Date.parse(`${day}T00:00:00Z`);
const nyDay = (date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(date));

// ---------- Yahoo Finance ----------
async function yahooChart(symbol, span, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${span}&interval=${interval}&includePrePost=false`;
  const json = await getJson(url);
  const result = json.chart?.result?.[0];
  if (!result) throw new HttpError(404, json.chart?.error?.description || `No data for ${symbol}`);
  return result;
}

async function yahooHistory(symbol, years) {
  // An explicit period keeps daily bars; Yahoo's range=max silently downsamples to monthly.
  const period1 = Math.floor(startOf(years) / 1000);
  const r = await yahooChart(symbol, `period1=${period1}&period2=${Math.floor(Date.now() / 1000)}`, "1d");
  const q = r.indicators?.quote?.[0] || {};
  const offset = (r.meta.gmtoffset || 0) * 1000;
  const bars = [];
  (r.timestamp || []).forEach((t, k) => {
    const close = q.close?.[k];
    if (close == null) return;
    bars.push({
      time: utcMidnight(dayOf(t * 1000 + offset)),
      open: q.open[k] ?? close, high: q.high[k] ?? close, low: q.low[k] ?? close, close,
      volume: q.volume?.[k] ?? 0,
    });
  });
  return { bars, currency: r.meta.currency, name: r.meta.longName || r.meta.shortName || symbol, exchange: r.meta.exchangeName };
}

async function yahooQuote(symbol) {
  const { meta } = await yahooChart(symbol, "range=1d", "1d");
  const price = meta.regularMarketPrice;
  const prev = meta.chartPreviousClose ?? meta.previousClose;
  const time = (meta.regularMarketTime || Date.now() / 1000) * 1000;
  return {
    price, prevClose: prev, changePct: prev ? (price / prev - 1) * 100 : 0,
    high: meta.regularMarketDayHigh ?? price, low: meta.regularMarketDayLow ?? price, volume: meta.regularMarketVolume ?? 0,
    time, day: dayOf(time + (meta.gmtoffset || 0) * 1000), currency: meta.currency,
  };
}

// ---------- Alpaca ----------
async function alpacaHistory(symbol, years) {
  // Alpaca's stock history starts in 2016.
  const start = new Date(Math.max(startOf(years), Date.UTC(2016, 0, 1))).toISOString().slice(0, 10);
  const bars = [];
  let token = "";
  do {
    const url = `${alpacaData}/v2/stocks/bars?symbols=${encodeURIComponent(symbol)}&timeframe=1Day&start=${start}&adjustment=all&feed=${alpacaFeed}&limit=10000${token ? `&page_token=${token}` : ""}`;
    const json = await getJson(url, alpacaKeys);
    for (const b of json.bars?.[symbol] || []) {
      bars.push({ time: utcMidnight(nyDay(b.t)), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });
    }
    token = json.next_page_token;
  } while (token);
  if (!bars.length) throw new HttpError(404, `No Alpaca data for ${symbol}`);
  return { bars, currency: "USD", name: symbol, exchange: `Alpaca (${alpacaFeed})` };
}

async function alpacaQuotes(symbols) {
  const json = await getJson(`${alpacaData}/v2/stocks/snapshots?symbols=${symbols.map(encodeURIComponent).join(",")}&feed=${alpacaFeed}`, alpacaKeys);
  const out = {};
  for (const s of symbols) {
    const snap = json[s];
    if (!snap?.latestTrade) continue;
    const price = snap.latestTrade.p, prev = snap.prevDailyBar?.c, day = snap.dailyBar?.t ? nyDay(snap.dailyBar.t) : nyDay(snap.latestTrade.t);
    out[s] = {
      price, prevClose: prev, changePct: prev ? (price / prev - 1) * 100 : 0,
      high: Math.max(snap.dailyBar?.h ?? price, price), low: Math.min(snap.dailyBar?.l ?? price, price), volume: snap.dailyBar?.v ?? 0,
      time: Date.parse(snap.latestTrade.t), day, currency: "USD",
    };
  }
  return out;
}

// ---------- public API with small caches ----------
const historyCache = new Map(); // symbol -> { at, data }
const quoteCache = new Map();
const HISTORY_TTL = 10 * 60e3;
const QUOTE_TTL = 4e3;

export async function getHistory(rawSymbol, years = 3) {
  const symbol = cleanSymbol(rawSymbol);
  const key = `${symbol}:${years}`;
  const hit = historyCache.get(key);
  if (hit && Date.now() - hit.at < HISTORY_TTL) return hit.data;
  let source = isCrypto(symbol) ? "Coinbase" : stockProvider();
  let raw;
  if (source === "Alpaca") raw = await alpacaHistory(symbol, years).catch(rejectAlpaca);
  if (!raw) {
    if (source === "Alpaca") source = "Yahoo Finance";
    raw = source === "Coinbase" ? await coinbaseHistory(symbol, years) : await yahooHistory(symbol, years);
  }
  if (raw.bars.length < 2) throw new HttpError(404, `Not enough history for ${symbol}`);
  const data = { symbol, source, ...raw, ...(source === "Yahoo Finance" && alpacaKeyError && { warning: alpacaKeyError }) };
  historyCache.set(key, { at: Date.now(), data });
  return data;
}

// `fresh` skips the short quote cache (the autopilot always trades on fresh prices).
export async function getQuotes(rawSymbols, { fresh = false } = {}) {
  const symbols = [...new Set(rawSymbols.map(cleanSymbol))].slice(0, 50);
  const out = {}, errors = {}, stale = [];
  for (const s of symbols) {
    const hit = quoteCache.get(s);
    if (!fresh && hit && Date.now() - hit.at < QUOTE_TTL) out[s] = hit.data;
    else stale.push(s);
  }
  const save = (s, q, source) => {
    out[s] = { symbol: s, source, ...q };
    quoteCache.set(s, { at: Date.now(), data: out[s] });
  };
  const crypto = stale.filter(isCrypto), stocks = stale.filter((s) => !isCrypto(s));
  const jobs = crypto.map((s) => coinbaseQuote(s).then((q) => save(s, q, "Coinbase"), (e) => (errors[s] = e.message)));
  const yahoo = (list) => Promise.all(list.map((s) => yahooQuote(s).then((q) => save(s, q, "Yahoo Finance"), (e) => (errors[s] = e.message))));
  if (stocks.length && useAlpaca()) {
    jobs.push(alpacaQuotes(stocks).then(
      (qs) => stocks.forEach((s) => (qs[s] ? save(s, qs[s], "Alpaca") : (errors[s] = "No Alpaca quote"))),
      (e) => {
        try { rejectAlpaca(e); } catch { return stocks.forEach((s) => (errors[s] = e.message)); }
        return yahoo(stocks);
      }
    ));
  } else {
    jobs.push(yahoo(stocks));
  }
  await Promise.all(jobs);
  return { quotes: out, errors };
}
