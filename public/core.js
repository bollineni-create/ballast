// Shared pieces every view uses: DOM helpers, saved state, formatting, market data.
import { simulatedBars } from "./lib/data.js";
import { isCrypto, coinbaseHistory, coinbaseQuote } from "./lib/coinbase.js";
import { neededSymbols } from "./lib/engine.js";
import { resolveSymbol } from "./lib/markets.js";
import { localStrategy } from "./lib/builder.js";

export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const day = (t) => new Date(t).toISOString().slice(0, 10);
export const money = (v, cur = "USD") => {
  try { return v.toLocaleString(undefined, { style: "currency", currency: cur, maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2, minimumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 }); } catch { return v.toFixed(2); }
};
export const pct = (v, d = 1) => (Number.isFinite(v) ? `${v.toFixed(d)}%` : "–");
export const signed = (v, d = 1) => (Number.isFinite(v) ? `${v > 0 ? "+" : ""}${v.toFixed(d)}%` : "–");
export const num = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : v === Infinity ? "∞" : "–");
export const tone = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "");
export const price = (v) => (Number.isFinite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: v >= 1000 ? 2 : v >= 1 ? 2 : 6, minimumFractionDigits: v >= 1 ? 2 : 0 }) : "–");

// ---------- saved state (browser storage; keys are shared with earlier versions) ----------
const watchers = [];
export const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(`slab:${key}`)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`slab:${key}`, JSON.stringify(value)); } catch { /* storage unavailable */ }
    for (const f of watchers) f(key);
  },
  onSet(f) { watchers.push(f); },
};

export const state = {
  server: false, // a Ballast server answers (Mac app, npm start, or the website)
  autopilot: false, // only the local server holds Alpaca keys
  ai: false,
  reader: false, // the server can read a portfolio from a picture (needs Claude)
  chat: store.get("chat", []),
  saved: store.get("saved", []),
  watchlist: store.get("watchlist", ["SPY", "AAPL", "BTC-USD"]),
  alerts: store.get("alerts", []),
  deployments: store.get("deployments", []),
  activity: store.get("activity", []),
  portfolio: store.get("portfolio", {
    holdings: [{ symbol: "VTI", shares: 0, target: 60 }, { symbol: "VXUS", shares: 0, target: 25 }, { symbol: "BND", shares: 0, target: 15 }],
    cash: 10000, band: 5, minTrade: 25, cashBuffer: 1, fractional: true,
  }),
};

// Test settings, shared by the Studio and Compare.
export const settings = {
  years: store.get("history", "max"), capital: 10000, cost: 10, benchmark: "", currency: "USD", dividends: true, source: "live",
  ...store.get("settings", {}),
};
export const saveSettings = () => { store.set("settings", settings); store.set("history", settings.years); };

// ---------- tiny event bus between views ----------
const listeners = {};
export const on = (name, f) => (listeners[name] ??= []).push(f);
export const emit = (name, ...args) => (listeners[name] || []).forEach((f) => f(...args));

export function go(view) {
  $$("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  window.scrollTo({ top: 0 });
  emit("show", view);
}
export const showing = (view) => $(`#view-${view}`).classList.contains("active");

let toastTimer;
export function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

export function downloadCsv(name, rows) {
  const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([rows.map((r) => r.map(cell).join(",")).join("\n")], { type: "text/csv" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export async function copyText(text, done = "Copied") {
  try { await navigator.clipboard.writeText(text); toast(done); } catch { window.prompt("Copy this:", text); }
}

// ---------- starter strategies ----------
// Written the way people describe them; the built-in parser reads each at load.
export const LIBRARY = [
  { tag: "Trend", name: "Golden cross on the S&P 500", prompt: "Buy SPY on a golden cross, sell on a death cross" },
  { tag: "Trend", name: "200-day trend filter", prompt: "Hold SPY when it's above its 200 day average, otherwise bonds" },
  { tag: "Trend", name: "Turtle-style breakout", prompt: "Buy QQQ when price closes above the prior 55-day high, sell on a close below the prior 20-day low" },
  { tag: "Mean reversion", name: "Nasdaq RSI(2) dip buyer", prompt: "Buy QQQ when RSI(2) is below 10, sell when RSI(2) is above 70, 5% stop loss" },
  { tag: "Mean reversion", name: "Buy fear: VIX above 30", prompt: "Buy QQQ when the VIX closes above 30, sell after 20 days, 8% stop" },
  { tag: "Portfolio", name: "60/40 stocks and bonds", prompt: "60/40 stocks and bonds, rebalanced quarterly" },
  { tag: "Portfolio", name: "Risk parity: stocks, bonds, gold", prompt: "Risk parity SPY, TLT and GLD, rebalanced monthly" },
  { tag: "Portfolio", name: "60/40 with a volatility cap", prompt: "60/40 SPY TLT rebalanced monthly, target 8% volatility" },
  { tag: "Portfolio", name: "Buy and hold the S&P 500", prompt: "Hold 100% SPY" },
  { tag: "Rotation", name: "Global momentum rotation", prompt: "Each month hold the top 2 of SPY, EFA, EEM, GLD and TLT by 6-month momentum, only if it's positive" },
  { tag: "Rotation", name: "Sector momentum, risk-weighted", prompt: "Each month hold the top 3 of XLK, XLF, XLE, XLV, XLY, XLP, XLI and XLU by 6-month momentum, weight by inverse volatility" },
  { tag: "Long/short", name: "Trend follower, both ways", prompt: "Buy SPY when the 50-day SMA crosses above the 200-day SMA, short when the 50-day SMA crosses below the 200-day SMA, 15% stop loss" },
  { tag: "Long/short", name: "Fade the overbought Nasdaq", prompt: "Short QQQ when RSI is above 80, cover when RSI is below 50, 6% stop loss" },
  { tag: "World", name: "Nikkei pullback", prompt: "Buy the Nikkei when it is more than 5% below its 50-day SMA and RSI is below 35, sell when RSI is above 60" },
  { tag: "World", name: "SAP trend, DAX filter", prompt: "Buy SAP when the 20 EMA crosses above the 50 EMA and the DAX is above its 200 day average, sell when the 20 EMA crosses below the 50 EMA, 12% trailing stop" },
  { tag: "World", name: "World markets, equal weight", prompt: "Equal weight SPY, ^N225, ^GDAXI, ^FTSE and GC=F, rebalance when any holding drifts 5%" },
  { tag: "Commodities", name: "Gold on dollar weakness", prompt: "Buy gold when the dollar falls 3% in a month, sell after 3 months" },
  { tag: "Crypto", name: "Bitcoin momentum", prompt: "Buy bitcoin when it crosses above its 50 day average and the 50 day average is above the 200 day average, sell when it crosses below the 50 day average, 15% trailing stop" },
].map((item, k) => ({ ...localStrategy(item.prompt), ...item, id: `lib-${k}` })).filter((s) => s.rules);

// ---------- market data ----------
export async function fetchJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}
export async function postJson(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// Without a Ballast server (index.html opened from disk) live data comes straight from
// Coinbase, which allows it for crypto pairs. Everything else needs the server.
export const NEEDS_APP = "Live stock, index, currency and futures prices need the Ballast server (the website, the Mac app or npm start). Opened from disk, live data covers crypto pairs like BTC-USD";

async function fetchHistory(symbol, years) {
  if (state.server) return fetchJson(`api/history?symbol=${encodeURIComponent(symbol)}&years=${years}`);
  if (!isCrypto(symbol)) throw new Error(NEEDS_APP);
  return { symbol, source: "Coinbase", ...(await coinbaseHistory(symbol, years)) };
}

export async function fetchQuotes(symbols) {
  if (state.server) return fetchJson(`api/quotes?symbols=${symbols.map(encodeURIComponent).join(",")}`);
  const quotes = {}, errors = {};
  await Promise.all(symbols.map((s) => (isCrypto(s)
    ? coinbaseQuote(s).then((q) => (quotes[s] = { symbol: s, source: "Coinbase", ...q }), (e) => (errors[s] = e.message))
    : (errors[s] = NEEDS_APP))));
  return { quotes, errors };
}

const historyCache = new Map();
export function liveHistory(symbol, years = 3) {
  const key = `${symbol}:${years}`;
  if (!historyCache.has(key)) {
    const p = fetchHistory(symbol, years);
    historyCache.set(key, p);
    p.catch(() => historyCache.delete(key));
    setTimeout(() => historyCache.delete(key), 10 * 60e3);
  }
  return historyCache.get(key);
}

// Prices quoted in a currency's small unit (London stocks trade in pence).
const MINOR = { GBp: ["GBP", 100], GBX: ["GBP", 100], ILA: ["ILS", 100], ZAc: ["ZAR", 100] };
const STABLE = { USDT: "USD", USDC: "USD" };

// Folds dividends into the bars so buy & hold includes them (total return).
const totalReturn = (bars) => bars.map((b) => (b.adj ? { ...b, open: b.open * b.adj, high: b.high * b.adj, low: b.low * b.adj, close: b.close * b.adj } : b));

// Loads everything a spec needs under the given settings.
// Returns { bars, fx, benchmark, lines: [facts about the data], warnings: [...] }.
export async function loadBars(spec, fallback, opt = settings, csv = null) {
  const syms = neededSymbols(spec, fallback);
  const bench = resolveSymbol(opt.benchmark);
  const bars = {}, fx = {}, lines = [], warnings = [];
  if (csv) { bars[csv.symbol] = csv.bars; lines.push(`${csv.symbol}: your file ${csv.name}, ${day(csv.bars[0].time)} to ${day(csv.bars.at(-1).time)}`); }
  const want = [...new Set([...syms, ...(bench ? [bench] : [])])].filter((s) => !bars[s]);
  if (opt.source === "sim") {
    for (const s of want) bars[s] = simulatedBars(s);
    lines.push(`Simulated daily data for ${want.join(", ")}: 750 made-up bars each, the same every time for a given name`);
    return { bars, fx, benchmark: bench, lines, warnings };
  }
  const results = await Promise.allSettled(want.map((s) => liveHistory(s, opt.years)));
  const failed = [], currency = {};
  let dividends = false, benchOk = Boolean(bench);
  results.forEach((r, k) => {
    const s = want[k];
    if (r.status !== "fulfilled") {
      if (s === bench && !syms.includes(s)) { benchOk = false; warnings.push(`Couldn't load ${s} to compare with (${r.reason.message}); comparing with buy & hold instead.`); }
      else failed.push(`${s}: ${r.reason.message}`);
      return;
    }
    const h = r.value;
    const hasDiv = h.bars.some((b) => b.adj);
    bars[s] = opt.dividends && hasDiv ? totalReturn(h.bars) : h.bars;
    dividends ||= opt.dividends && hasDiv;
    currency[s] = h.currency;
    lines.push(`${s}${h.name && h.name !== s ? ` (${h.name})` : ""}: ${h.source}, ${day(h.bars[0].time)} to ${day(h.bars.at(-1).time)}${h.currency ? `, ${h.currency}` : ""}`);
    if (h.warning) warnings.push(h.warning);
    // One-day jumps that look like data errors (bad splits, redenominations) rather than markets.
    if (!isCrypto(s) && !/^\^V/.test(s)) {
      const b = h.bars, i = b.findIndex((x, j) => j && (x.close / b[j - 1].close > 1.8 || x.close / b[j - 1].close < 0.45));
      if (i > 0) warnings.push(`${s} moves ${((b[i].close / b[i - 1].close - 1) * 100).toFixed(0)}% on ${day(b[i].time)}, which looks like a data error from the provider; results before that date can be off.`);
    }
  });
  if (failed.length) throw new Error(`Couldn't load market data for ${failed.join("; ")}. Check the symbol (AAPL, ^N225, 7203.T, EURUSD=X, GC=F, BTC-USD), or switch Data to Simulated.`);

  // Currency conversion: one exchange-rate series per foreign currency.
  const base = opt.currency;
  const distinct = [...new Set(Object.values(currency).filter(Boolean).map((c) => STABLE[c] || MINOR[c]?.[0] || c))];
  if (base && state.server) {
    const need = {};
    for (const [s, c0] of Object.entries(currency)) {
      if (!c0 || /=X$/.test(s)) continue; // currency pairs are already a rate
      const [c, div] = MINOR[c0] || [STABLE[c0] || c0, 1];
      if (c !== base || div !== 1) (need[`${c}|${div}`] ??= []).push(s);
    }
    await Promise.all(Object.entries(need).map(async ([key, list]) => {
      const [c, div] = key.split("|");
      try {
        const rate = c === base ? null : (await liveHistory(`${c}${base}=X`, "max")).bars;
        const first = rate ? rate[0].time : -Infinity;
        for (const s of list) {
          fx[s] = rate ? rate.map((b) => ({ time: b.time, close: b.close / div })) : [{ time: 0, close: 1 / div }];
          if (rate && bars[s][0].time < first) warnings.push(`${c}/${base} exchange rates start ${day(first)}; ${s}'s earlier years use that first rate.`);
        }
      } catch {
        warnings.push(`Couldn't load the ${c}/${base} exchange rate, so ${list.join(", ")} stay${list.length > 1 ? "" : "s"} in ${c}.`);
      }
    }));
    if (Object.keys(fx).length) lines.push(`Foreign markets converted to ${base} at each day's exchange rate`);
  } else if (distinct.length > 1) {
    warnings.push(`Mixed currencies (${distinct.join(", ")}): each market's returns are in its own currency, with no conversion.`);
  }
  if (dividends) lines.push("Dividends reinvested");
  else if (opt.dividends && syms.some((s) => !isCrypto(s) && !/^\^|=[XF]$/.test(s))) lines.push("Price moves only: this data source doesn't include dividends");
  return { bars, fx, benchmark: benchOk ? bench : null, lines, warnings };
}
