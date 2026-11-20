import { simulatedBars, parseCSV, toSeries, nextBar, rng } from "./lib/data.js";
import { compileStrategy } from "./lib/backtest.js";
import { lineChart } from "./lib/chart.js";
import { analyze, plan } from "./lib/rebalance.js";
import { isCrypto, coinbaseHistory, coinbaseQuote } from "./lib/coinbase.js";
import { parseStrategy } from "./lib/parse.js";
import { summarize, describe } from "./lib/spec.js";
import { localStrategy } from "./lib/builder.js";
import { backtestSpec, neededSymbols, signalRules } from "./lib/engine.js";
import { MARKETS, resolveSymbol, nameOf } from "./lib/markets.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = (v) => v.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const day = (t) => new Date(t).toISOString().slice(0, 10);

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(`slab:${key}`)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`slab:${key}`, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

const state = {
  server: false, // true when a Ballast server answers (Mac app, npm start, or the hosted website)
  autopilot: false, // true only with the local server, which holds the Alpaca keys
  ai: false,
  csv: null, // { name, bars } when the user imports real data
  chat: store.get("chat", []),
  saved: store.get("saved", []),
  watchlist: store.get("watchlist", ["SPY", "AAPL", "BTC-USD"]),
  alerts: store.get("alerts", []),
  deployments: store.get("deployments", []),
  activity: store.get("activity", []),
};

// Starter strategies, written the way people describe them. Each is read by the
// built-in parser at load, so they also show what the rule language understands.
const LIBRARY = [
  { tag: "Trend", name: "Golden cross on the S&P 500", prompt: "Buy SPY on a golden cross, sell on a death cross" },
  { tag: "Mean reversion", name: "Nasdaq RSI(2) dip buyer", prompt: "Buy QQQ when RSI(2) is below 10, sell when RSI(2) is above 70, 5% stop loss" },
  { tag: "Cross-market", name: "Buy fear: VIX above 30", prompt: "Buy QQQ when the VIX closes above 30, sell after 20 days, 8% stop" },
  { tag: "Portfolio", name: "60/40 stocks and bonds", prompt: "60/40 stocks and bonds, rebalanced quarterly" },
  { tag: "Risk-off", name: "200-day trend filter", prompt: "Hold SPY when it's above its 200 day average, otherwise bonds" },
  { tag: "Rotation", name: "Global momentum rotation", prompt: "Each month hold the top 2 of SPY, EFA, EEM, GLD and TLT by 6-month momentum, only if it's positive" },
  { tag: "Japan", name: "Nikkei pullback", prompt: "Buy the Nikkei when it is more than 5% below its 50-day SMA and RSI is below 35, sell when RSI is above 60" },
  { tag: "Europe", name: "SAP trend, DAX filter", prompt: "Buy SAP when the 20 EMA crosses above the 50 EMA and the DAX is above its 200 day average, sell when the 20 EMA crosses below the 50 EMA, 12% trailing stop" },
  { tag: "Commodities", name: "Gold on dollar weakness", prompt: "Buy gold when the dollar falls 3% in a month, sell after 3 months" },
  { tag: "Crypto", name: "Bitcoin momentum", prompt: "Buy bitcoin when it crosses above its 50 day average and the 50 day average is above the 200 day average, sell when it crosses below the 50 day average, 15% trailing stop" },
  { tag: "Breakout", name: "Turtle-style breakout", prompt: "Buy when price closes above the prior 55-day high, sell on a close below the prior 20-day low" },
  { tag: "Global", name: "World markets, equal weight", prompt: "Equal weight SPY, ^N225, ^GDAXI, ^FTSE and GC=F, rebalance when any holding drifts 5%" },
].map((item) => ({ ...localStrategy(item.prompt), ...item }));

// ---------- tabs ----------
document.querySelectorAll(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${tab.dataset.view}`));
    if (tab.dataset.view === "monitor") renderMonitor();
    if (tab.dataset.view === "rebalance") { renderRebalance(); loadAutopilot(); }
    if (tab.dataset.view === "build" && lastResult) renderResults(lastResult);
  })
);

// ---------- build: chat ----------
function renderChat() {
  const log = $("#chat-log");
  if (!state.chat.length) {
    log.innerHTML = `<div class="msg">Describe a trading idea in plain English, for any major market. I'll turn it into rules you can read, edit and backtest. No code.\n\nTry: "Buy the Nikkei when it's 5% below its 50-day average and the VIX is under 25", or "60/40 stocks and bonds, rebalanced quarterly".</div>`;
    return;
  }
  log.innerHTML = state.chat
    .map((m) => `<div class="msg ${m.role}">${esc(m.text)}${m.meta ? `<span class="meta">${esc(m.meta)}</span>` : ""}</div>`)
    .join("");
  log.scrollTop = log.scrollHeight;
}

function pushChat(msg) {
  state.chat.push(msg);
  state.chat = state.chat.slice(-40);
  store.set("chat", state.chat);
  renderChat();
}

async function generate(prompt, refine) {
  const current = refine ? rulesText() : undefined;
  if (!state.server) return localStrategy(prompt, current);
  try {
    const res = await fetch("api/generate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      // currentCode: older servers read the current strategy from this field
      body: JSON.stringify({ prompt, currentRules: current, currentCode: current }),
    });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    const out = await res.json();
    // A server from before plain-English rules answers with code: build locally instead.
    return typeof out.rules === "string" || out.rules === null ? out : localStrategy(prompt, current);
  } catch {
    return localStrategy(prompt, current);
  }
}

$("#chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const prompt = $("#chat-input").value.trim();
  if (!prompt) return;
  const btn = $("#chat-send");
  btn.disabled = true;
  btn.textContent = "Thinking…";
  pushChat({ role: "user", text: prompt });
  $("#chat-input").value = "";
  const out = await generate(prompt, $("#chat-refine").checked && rulesText().trim());
  btn.disabled = false;
  btn.textContent = "Build";
  if (state.ai && out.source !== "ai") fetchJson("api/status").then((s) => { state.ai = s.ai; renderAiPill(s); }, () => {});
  const meta = [out.source === "ai" ? "Written by Claude, checked by Ballast's parser" : "Built-in parser", out.warning].filter(Boolean).join(" · ");
  if (!out.rules) {
    pushChat({ role: "assistant", text: `I couldn't turn that into rules yet.\n\n${out.explanation}`, meta });
    return;
  }
  loadStrategy(out);
  pushChat({ role: "assistant", text: `${out.name}\n\n${out.explanation}${out.notes?.length ? `\n\nNote: ${out.notes.join(" ")}` : ""}`, meta });
  $("#chat-refine").checked = true;
  runAndShow();
});

$("#chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("#chat-form").requestSubmit();
});

// ---------- build: rules editor ----------
const rulesText = () => $("#rules").value;

function loadStrategy({ name, rules }) {
  $("#strategy-name").value = name || "Untitled strategy";
  $("#rules").value = rules || "";
  store.set("draft", { name: $("#strategy-name").value, rules: rulesText() });
  checkRules();
}

// Reads the rules as you type and shows how Ballast understood them.
let parsed = null;
function checkRules() {
  const box = $("#rules-check");
  try {
    const r = parseStrategy(rulesText());
    parsed = r;
    const warn = [...r.notes, ...r.unparsed.map((u) => `Not understood, ignored: "${u}"`)];
    box.className = `rules-check ${warn.length ? "warn" : "ok"}`;
    box.innerHTML = `<strong>${r.spec.kind === "signal" ? "Buy/sell rules" : "Portfolio"}</strong> · ${esc(summarize(r.spec))}${warn.map((w) => `<div>${esc(w)}</div>`).join("")}`;
    syncSymbolField(r.spec);
  } catch (e) {
    parsed = null;
    box.className = "rules-check bad";
    box.textContent = e.message;
  }
}

// The Market field is the asset traded by rules without a "Trade" line; for rules that
// name their own assets it shows them read-only.
function syncSymbolField(spec) {
  const own = spec.kind === "allocate" || spec.symbols?.length;
  const f = $("#symbol");
  if (own && !state.csv) f.value = spec.symbols.join(", ");
  f.disabled = Boolean(own) || Boolean(state.csv);
  f.title = own ? "Set by the rules (Trade, Hold or Rotate line). Edit the rules to change it." : "The asset these rules trade. Type a ticker or a name like Toyota, gold or Nikkei.";
  $("#browse-markets").textContent = own ? "Markets" : "Browse markets";
}

let checkTimer = null;
$("#rules").addEventListener("input", () => {
  store.set("draft", { name: $("#strategy-name").value, rules: rulesText() });
  clearTimeout(checkTimer);
  checkTimer = setTimeout(checkRules, 250);
});
$("#rules").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); checkRules(); runAndShow(); }
});

// ---------- market data ----------
async function fetchJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

// Without a Ballast server (index.html opened from disk) live data comes straight from
// Coinbase, which allows it for crypto pairs. Everything else needs the server.
const NEEDS_APP = "Live stock, index, FX and futures prices need the Ballast server (the website, the Mac app or npm start). Opened from disk, live data covers crypto pairs like BTC-USD";

async function fetchHistory(symbol, years) {
  if (state.server) return fetchJson(`api/history?symbol=${encodeURIComponent(symbol)}&years=${years}`);
  if (!isCrypto(symbol)) throw new Error(NEEDS_APP);
  return { symbol, source: "Coinbase", ...(await coinbaseHistory(symbol, years)) };
}

async function fetchQuotes(symbols) {
  if (state.server) return fetchJson(`api/quotes?symbols=${symbols.map(encodeURIComponent).join(",")}`);
  const quotes = {}, errors = {};
  await Promise.all(symbols.map((s) => isCrypto(s)
    ? coinbaseQuote(s).then((q) => (quotes[s] = { symbol: s, source: "Coinbase", ...q }), (e) => (errors[s] = e.message))
    : (errors[s] = NEEDS_APP)));
  return { quotes, errors };
}

const historyCache = new Map();
async function liveHistory(symbol, years = 3) {
  const key = `${symbol}:${years}`;
  if (!historyCache.has(key)) {
    const p = fetchHistory(symbol, years);
    historyCache.set(key, p);
    p.catch(() => historyCache.delete(key));
    setTimeout(() => historyCache.delete(key), 10 * 60e3);
  }
  return historyCache.get(key);
}

const chosenSymbol = () => resolveSymbol($("#symbol").value.split(",")[0]) || "SPY";

// Loads every symbol the rules need. Returns { bars: { SYM: bars }, note }.
async function loadData(spec) {
  const fallback = state.csv ? state.csv.symbol : chosenSymbol();
  const syms = neededSymbols(spec, fallback);
  const mode = $("#data-source").value;
  const years = $("#history").value;
  const bars = {}, info = [];
  if (state.csv) bars[state.csv.symbol] = state.csv.bars;
  const rest = syms.filter((s) => !bars[s]);
  if (mode === "sim") {
    for (const s of rest) bars[s] = simulatedBars(s);
    return { bars, fallback, note: `Simulated daily data for ${rest.join(", ")} (750 bars each; every name gives its own repeatable series).` };
  }
  $("#data-note").textContent = `Loading ${years === "max" ? "full" : `${years}-year`} history for ${rest.join(", ")}…`;
  const results = await Promise.allSettled(rest.map((s) => liveHistory(s, years)));
  const failed = [];
  results.forEach((r, k) => {
    const s = rest[k];
    if (r.status === "fulfilled") {
      bars[s] = r.value.bars;
      info.push(`${s} ${r.value.name && r.value.name !== s ? `(${r.value.name}) ` : ""}from ${r.value.source}, ${day(r.value.bars[0].time)} → ${day(r.value.bars.at(-1).time)}, ${r.value.currency || ""}`.trim());
      if (r.value.warning) info.push(r.value.warning);
    } else failed.push(`${s}: ${r.reason.message}`);
  });
  if (failed.length) {
    throw new Error(`Couldn't load market data for ${failed.join("; ")}. Check the symbol (AAPL, ^N225, 7203.T, EURUSD=X, GC=F, BTC-USD) or switch Data to Simulated.`);
  }
  // Flag one-day jumps that look like data errors (bad splits, redenominations) rather than markets.
  for (const sym of rest) {
    if (isCrypto(sym) || /^\^VX|^\^VIX/.test(sym)) continue; // crypto and volatility indices really do move this much
    const b = bars[sym];
    const k = b.findIndex((x, i) => i && (x.close / b[i - 1].close > 1.8 || x.close / b[i - 1].close < 0.45));
    if (k > 0) info.push(`⚠️ ${sym} moves ${((b[k].close / b[k - 1].close - 1) * 100).toFixed(0)}% on ${day(b[k].time)}, which may be a data error from the provider; results before that date can be off`);
  }
  const currencies = new Set(results.map((r) => r.value?.currency).filter(Boolean));
  const fx = currencies.size > 1 ? ` Mixed currencies (${[...currencies].join(", ")}): each asset's returns are in its own currency, with no FX conversion.` : "";
  return { bars, fallback, note: `${state.csv ? `Imported ${state.csv.name} as ${state.csv.symbol}. ` : ""}${info.join(" · ")}.${fx}` };
}

$("#csv").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const symbol = file.name.replace(/\.csv$/i, "").toUpperCase().replace(/[^A-Z0-9.\-^=]/g, "").slice(0, 12) || "CSV";
    state.csv = { name: file.name, symbol, bars: parseCSV(await file.text()) };
    $("#symbol").value = symbol;
    $("#symbol").disabled = true;
    runAndShow();
  } catch (err) {
    showError(err.message);
  }
});
$("#symbol").addEventListener("change", () => {
  const s = resolveSymbol($("#symbol").value);
  if (s) $("#symbol").value = s;
  runAndShow();
});
$("#data-source").addEventListener("change", runAndShow);
$("#history").addEventListener("change", () => {
  store.set("history", $("#history").value);
  runAndShow();
});

function showError(msg) {
  $("#error").hidden = !msg;
  $("#error").textContent = msg || "";
}

let lastResult = null;
let runSeq = 0;
async function runAndShow() {
  showError("");
  checkRules();
  if (!parsed) return;
  const seq = ++runSeq;
  try {
    const { bars, fallback, note } = await loadData(parsed.spec);
    if (seq !== runSeq) return; // a newer run started while data was loading
    $("#data-note").textContent = note;
    const result = backtestSpec(parsed.spec, bars, {
      fallbackSymbol: fallback,
      capital: Number($("#capital").value) || 10000,
      costBps: Number($("#cost").value) || 0,
    });
    lastResult = result;
    renderResults(result);
  } catch (err) {
    if (seq === runSeq) showError(err.message);
  }
}
$("#run").addEventListener("click", runAndShow);

function renderResults(r) {
  const m = r.metrics;
  $("#results").hidden = false;
  const sign = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "");
  const pct = (v, d = 1) => (Number.isFinite(v) ? `${v.toFixed(d)}%` : "—");
  const cards = [
    ["Total return", pct(m.totalReturn), sign(m.totalReturn)],
    [r.benchLabel, pct(m.buyHold), sign(m.buyHold)],
    ["CAGR", pct(m.cagr), sign(m.cagr)],
    ["Max drawdown", pct(m.maxDrawdown), "neg"],
    ["Sharpe", m.sharpe.toFixed(2), sign(m.sharpe)],
    [r.kind === "signal" ? "Trades" : "Orders", m.trades, ""],
    ...(r.kind === "signal" ? [
      ["Win rate", pct(m.winRate, 0), ""],
      ["Profit factor", Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : m.profitFactor === Infinity ? "∞" : "—", ""],
      ["Avg trade", pct(m.avgTrade, 2), sign(m.avgTrade)],
    ] : []),
    ["Time invested", pct(m.exposure, 0), ""],
    ["Final equity", money(m.finalEquity), ""],
  ];
  $("#metrics").innerHTML = cards.map(([l, v, c]) => `<div class="metric"><div class="label">${esc(l)}</div><div class="value ${c}">${v}</div></div>`).join("");
  $("#bench-legend").textContent = r.benchLabel;
  // Spot rules that fight each other: buy and sell both true, so it churns daily.
  const quick = r.kind === "signal" && r.trades.length >= 30 && r.trades.filter((t) => t.bars <= 1 && t.reason === "signal").length / r.trades.length > 0.5;
  $("#result-note").hidden = !quick;
  $("#result-note").textContent = quick ? "Most trades last a single day: the buy and sell rules are often true at the same time, so the strategy buys and sells again the next day. Try a sell rule that can't overlap the buy rule (e.g. sell when price crosses above the 50-day SMA, rather than is above it)." : "";

  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  lineChart($("#equity-chart"), {
    time: r.time,
    series: [
      { values: r.bench, color: css("--muted"), label: r.benchLabel, width: 1, dash: [4, 3] },
      { values: r.equity, color: css("--accent"), label: "Strategy", width: 2 },
    ],
    format: (v) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)),
  });

  const palette = ["--accent", "--up", "--down", "--text", "--muted"].map(css).concat(["#7c3aed", "#d97706", "#0284c7"]);
  if (r.kind === "signal") {
    const sym = r.traded[0];
    $("#second-title").textContent = r.traded.length > 1 ? `${sym} price & trades (first of ${r.traded.length})` : `${sym} price & trades`;
    $("#second-legend").innerHTML = `<i style="background:var(--up)"></i>Buy <i style="background:var(--down)"></i>Sell`;
    const markers = r.trades.filter((t) => t.symbol === sym).flatMap((t) => [
      { index: t.entryIndex, value: r.prices[sym][t.entryIndex], type: "buy" },
      ...(t.reason === "end of data" ? [] : [{ index: t.exitIndex, value: r.prices[sym][t.exitIndex], type: "sell" }]),
    ]);
    lineChart($("#price-chart"), { time: r.time, series: [{ values: r.prices[sym], color: css("--text"), label: sym, width: 1.25 }], markers });
  } else {
    $("#second-title").textContent = "Holdings over time (% of portfolio)";
    const syms = Object.keys(r.weightHistory);
    $("#second-legend").innerHTML = syms.map((s, k) => `<i style="background:${palette[k % palette.length]}"></i>${esc(s)}`).join(" ");
    lineChart($("#price-chart"), {
      time: r.time,
      series: syms.map((s, k) => ({ values: Array.from(r.weightHistory[s]), color: palette[k % palette.length], label: s, width: 1.25 })),
      format: (v) => `${v.toFixed(0)}%`,
    });
  }

  if (r.kind === "signal") {
    $("#trades-title").textContent = "Trades";
    const multi = r.traded.length > 1;
    $("#trades").innerHTML = `<thead><tr><th>#</th>${multi ? "<th>Symbol</th>" : ""}<th>Entry</th><th>Entry price</th><th>Exit</th><th>Exit price</th><th>Days</th><th>P&amp;L</th><th>Return</th><th>Exit reason</th></tr></thead><tbody>${
      r.trades.length
        ? r.trades.map((t, k) => `<tr><td>${k + 1}</td>${multi ? `<td>${esc(t.symbol)}</td>` : ""}<td>${day(t.entryTime)}</td><td>${t.entryPrice.toFixed(2)}</td><td>${day(t.exitTime)}</td><td>${t.exitPrice.toFixed(2)}</td><td>${t.bars}</td><td class="${sign(t.pnl)}">${money(t.pnl)}</td><td class="${sign(t.returnPct)}">${t.returnPct.toFixed(2)}%</td><td>${t.reason}</td></tr>`).join("")
        : `<tr><td colspan="10" class="empty">No trades. The buy rule never fired on this data.</td></tr>`
    }</tbody>`;
  } else {
    $("#trades-title").textContent = "Rebalancing orders";
    const rows = r.orders.slice(-500);
    $("#trades").innerHTML = `<thead><tr><th>Date</th><th>Symbol</th><th>Side</th><th>Shares</th><th>Price</th><th>Value</th></tr></thead><tbody>${
      rows.length
        ? rows.map((o) => `<tr><td>${day(o.time)}</td><td>${esc(o.symbol)}</td><td class="${o.side === "buy" ? "pos" : "neg"}">${o.side}</td><td>${o.shares.toFixed(4)}</td><td>${o.price.toFixed(2)}</td><td>${money(o.value)}</td></tr>`).join("")
        : `<tr><td colspan="6" class="empty">No orders. The portfolio never had enough history to start.</td></tr>`
    }</tbody>${r.orders.length > rows.length ? `<caption class="note">Showing the last ${rows.length} of ${r.orders.length} orders. Export CSV for all.</caption>` : ""}`;
  }
}

$("#export-trades").addEventListener("click", () => {
  if (!lastResult) return;
  const rows = lastResult.kind === "signal"
    ? [["symbol", "entry_date", "entry_price", "exit_date", "exit_price", "shares", "pnl", "return_pct", "reason"],
      ...lastResult.trades.map((t) => [t.symbol, day(t.entryTime), t.entryPrice.toFixed(4), day(t.exitTime), t.exitPrice.toFixed(4), t.shares.toFixed(4), t.pnl.toFixed(2), t.returnPct.toFixed(3), t.reason])]
    : [["date", "symbol", "side", "shares", "price", "value"],
      ...lastResult.orders.map((o) => [day(o.time), o.symbol, o.side, o.shares.toFixed(6), o.price.toFixed(4), o.value.toFixed(2)])];
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([rows.map((r) => r.join(",")).join("\n")], { type: "text/csv" }));
  a.download = `${$("#strategy-name").value.replace(/\W+/g, "_")}_${lastResult.kind === "signal" ? "trades" : "orders"}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$("#save-strategy").addEventListener("click", () => {
  const name = $("#strategy-name").value.trim() || "Untitled strategy";
  const existing = state.saved.find((s) => s.name === name);
  if (existing) { existing.rules = rulesText(); delete existing.code; }
  else state.saved.push({ id: crypto.randomUUID(), name, rules: rulesText(), created: Date.now() });
  store.set("saved", state.saved);
  renderLibrary();
  flash($("#save-strategy"), "Saved ✓");
});

$("#deploy-strategy").addEventListener("click", () => {
  checkRules();
  if (!parsed) return showError("Fix the rules before paper trading them.");
  if (parsed.spec.kind !== "signal") return showError("Paper trading runs buy/sell rules. For portfolios, use the Rebalance tab and its Alpaca paper autopilot.");
  const symbol = state.csv ? "SPY" : (parsed.spec.symbols[0] || chosenSymbol());
  const mode = state.csv ? "live" : $("#data-source").value;
  for (const s of neededSymbols(parsed.spec, symbol)) if (!state.watchlist.includes(s)) state.watchlist.push(s);
  state.deployments.push({ id: crypto.randomUUID(), name: $("#strategy-name").value, rules: rulesText(), symbol, capital: 10000, cash: 10000, shares: 0, entryPrice: null, trades: 0, active: true, mode });
  persistMonitor();
  log(`Started paper trading "${$("#strategy-name").value}" on ${symbol} (${mode === "live" ? "live data" : "simulated feed"}) with $10,000.`);
  flash($("#deploy-strategy"), "Deployed ✓");
});

function flash(btn, text) {
  const orig = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = orig), 1200);
}

// ---------- market browser ----------
let browserGroup = MARKETS[0].group;
function renderMarkets(quotes = {}) {
  const g = MARKETS.find((x) => x.group === browserGroup);
  $("#market-tabs").innerHTML = MARKETS.map((x) => `<button class="tab ${x.group === browserGroup ? "active" : ""}" data-market-group="${esc(x.group)}">${esc(x.group)}</button>`).join("");
  $("#market-note").textContent = `${g.note[0].toUpperCase()}${g.note.slice(1)}. ${state.server ? "Live quotes." : NEEDS_APP + "."}`;
  $("#market-list").innerHTML = `<thead><tr><th>Symbol</th><th>Name</th><th>Last</th><th>Change</th><th></th></tr></thead><tbody>${g.items.map(([s, name]) => {
    const q = quotes[s];
    return `<tr><td><strong>${esc(s)}</strong></td><td>${esc(name)}</td><td>${q ? q.price.toLocaleString(undefined, { maximumFractionDigits: 4 }) : `<span class="note">…</span>`}</td><td class="${q ? (q.changePct >= 0 ? "pos" : "neg") : ""}">${q ? `${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)}%` : ""}</td><td class="row"><button class="btn small primary" data-use-symbol="${esc(s)}">Use</button><button class="btn small" data-watch-symbol="${esc(s)}">Watch</button></td></tr>`;
  }).join("")}</tbody>`;
}
async function loadMarketQuotes() {
  const g = MARKETS.find((x) => x.group === browserGroup);
  renderMarkets();
  try {
    const { quotes } = await fetchQuotes(g.items.map(([s]) => s));
    if (g.group === browserGroup) renderMarkets(quotes);
  } catch { /* quotes are a nicety; the list still works */ }
}
$("#browse-markets").addEventListener("click", () => { $("#markets").showModal(); loadMarketQuotes(); });
$("#markets-close").addEventListener("click", () => $("#markets").close());
$("#market-search").addEventListener("submit", (e) => {
  e.preventDefault();
  const s = resolveSymbol($("#market-query").value);
  if (s) useSymbol(s);
});

// Points the strategy at a symbol: rewrites the Trade line when the rules have one.
function useSymbol(s) {
  $("#markets").close();
  if (parsed?.spec.kind === "signal" && parsed.spec.symbols.length) {
    // The asset may be named in a Trade line or in the Buy line; rewrite the rules either way.
    $("#rules").value = describe({ ...parsed.spec, symbols: [s] });
  } else if (parsed?.spec.kind === "allocate") {
    pushChat({ role: "assistant", text: `This is a portfolio, so its assets come from its Hold or Rotate line. Edit that line to add ${s} (${nameOf(s)}).` });
    return;
  }
  $("#symbol").value = s;
  store.set("draft", { name: $("#strategy-name").value, rules: rulesText() });
  runAndShow();
}

// ---------- library ----------
function renderLibrary() {
  const card = (s, actions) => `<div class="card">${s.tag ? `<span class="tag">${esc(s.tag)}</span>` : ""}<h4>${esc(s.name)}</h4><p>${esc(s.prompt ? `“${s.prompt}”` : s.explanation || "Saved strategy")}</p>${s.rules ? `<pre class="rules-preview">${esc(s.rules)}</pre>` : `<p class="note">Saved as code by an earlier Ballast. Open it to rewrite it in plain English.</p>`}<div class="row">${actions}</div></div>`;
  $("#library").innerHTML = LIBRARY.filter((s) => s.rules).map((s, i) => card(s, `<button class="btn small primary" data-lib="${i}">Open &amp; test</button>`)).join("");
  $("#saved").innerHTML = state.saved.length
    ? state.saved.map((s) => card(s, `<button class="btn small" data-del="${s.id}">Delete</button><button class="btn small primary" data-open="${s.id}">Open</button>`)).join("")
    : `<p class="empty">Nothing saved yet. Use Save in the editor.</p>`;
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  const openInBuilder = (s) => {
    document.querySelector('.tab[data-view="build"]').click();
    if (!s.rules) {
      pushChat({ role: "assistant", text: `"${s.name}" was saved as JavaScript by an earlier version of Ballast. Strategies are plain English now: describe it in the box below and I'll rebuild it.` });
      return;
    }
    state.csv = null;
    loadStrategy(s);
    runAndShow();
  };
  if (t.dataset.lib) openInBuilder(LIBRARY.filter((s) => s.rules)[t.dataset.lib]);
  if (t.dataset.open) openInBuilder(state.saved.find((s) => s.id === t.dataset.open));
  if (t.dataset.del) {
    state.saved = state.saved.filter((s) => s.id !== t.dataset.del);
    store.set("saved", state.saved);
    renderLibrary();
  }
  if (t.dataset.marketGroup) { browserGroup = t.dataset.marketGroup; loadMarketQuotes(); }
  if (t.dataset.useSymbol) useSymbol(t.dataset.useSymbol);
  if (t.dataset.watchSymbol) {
    if (!state.watchlist.includes(t.dataset.watchSymbol)) state.watchlist.push(t.dataset.watchSymbol);
    persistMonitor();
    flash(t, "Watching ✓");
  }
});

// ---------- monitor: live or simulated feed + paper trading ----------
// Each feed holds daily bars for one symbol. In live mode the last bar is the
// forming bar for the current session, updated from each quote poll.
const feeds = new Map(); // `${mode}:${symbol}` -> { status, bars, quote, error, source, rand, sim }
const feedMode = () => $("#feed-mode").value;

function feed(symbol, mode = feedMode()) {
  const key = `${mode}:${symbol}`;
  let f = feeds.get(key);
  if (f && !(f.status === "error" && Date.now() > f.retryAt)) return f;
  f = { status: "loading", bars: [] };
  feeds.set(key, f);
  if (mode === "sim") {
    f.bars = simulatedBars(symbol).slice(-400);
    const rets = f.bars.slice(-60).map((b, i, a) => (i ? Math.log(b.close / a[i - 1].close) : 0)).slice(1);
    f.sim = { drift: 0, vol: Math.sqrt(rets.reduce((s, r) => s + r * r, 0) / rets.length) };
    f.rand = rng(Date.now() ^ (symbol.length * 7919));
    f.source = "Simulated";
    f.status = "ready";
  } else {
    liveHistory(symbol).then(
      (h) => {
        f.bars = h.bars.slice(-400).map((b) => ({ ...b }));
        f.source = h.source;
        f.status = "ready";
        renderMonitorIfVisible();
      },
      (err) => {
        Object.assign(f, { status: "error", error: err.message, retryAt: Date.now() + 60e3 });
        renderMonitorIfVisible();
      }
    );
  }
  return f;
}

function applyQuote(f, q) {
  f.quote = q;
  const last = f.bars.at(-1);
  const qTime = Date.parse(`${q.day}T00:00:00Z`);
  if (!last || qTime > last.time) {
    f.bars.push({ time: qTime, open: q.price, high: Math.max(q.high ?? q.price, q.price), low: Math.min(q.low ?? q.price, q.price), close: q.price, volume: q.volume || 0 });
    if (f.bars.length > 600) f.bars.shift();
  } else if (qTime === last.time) {
    last.close = q.price;
    last.high = Math.max(last.high, q.high ?? q.price, q.price);
    last.low = Math.min(last.low, q.low ?? q.price, q.price);
    if (q.volume) last.volume = q.volume;
  }
}

let polling = false;
async function tick() {
  const mode = feedMode();
  if (mode === "sim") {
    for (const sym of state.watchlist) {
      const f = feed(sym, "sim");
      const last = f.bars.at(-1);
      f.bars.push(nextBar(last.close, last.time + 864e5, f.rand, f.sim));
      if (f.bars.length > 600) f.bars.shift();
    }
  } else {
    if (polling) return;
    state.watchlist.forEach((s) => feed(s, "live"));
    const ready = state.watchlist.filter((s) => feed(s, "live").status === "ready");
    if (!ready.length) return renderMonitorIfVisible();
    polling = true;
    try {
      const { quotes, errors } = await fetchQuotes(ready);
      for (const s of ready) {
        const f = feed(s, "live");
        if (quotes[s]) { applyQuote(f, quotes[s]); f.error = null; }
        else f.error = errors[s] || "No quote";
      }
      $("#feed-note").textContent = `Last update ${new Date().toLocaleTimeString()}.`;
    } catch (err) {
      $("#feed-note").textContent = `Quote update failed: ${err.message}. Retrying.`;
    } finally {
      polling = false;
    }
    if (feedMode() !== mode) return;
  }
  checkAlerts();
  stepDeployments();
  renderMonitorIfVisible();
}

function lastPrice(symbol) {
  const f = feed(symbol);
  return f.status === "ready" ? f.bars.at(-1).close : null;
}

function checkAlerts() {
  for (const a of state.alerts) {
    if (a.triggered) continue;
    const price = lastPrice(a.symbol);
    if (price == null) continue;
    if ((a.dir === "above" && price >= a.price) || (a.dir === "below" && price <= a.price)) {
      a.triggered = true;
      log(`🔔 Alert: ${a.symbol} is ${a.dir} ${a.price.toFixed(2)} (now ${price.toFixed(2)}).`);
      notify(`${a.symbol} ${a.dir} ${a.price.toFixed(2)}`);
    }
  }
  store.set("alerts", state.alerts);
}

// Builds a deployment's rules on the current feeds: { time, close, entry, exit, stops } or null if feeds aren't ready.
function liveRules(d) {
  if (d.rules) {
    const { spec } = parseStrategy(d.rules);
    const bars = {};
    for (const s of neededSymbols(spec, d.symbol)) {
      const f = feed(s);
      if (f.status !== "ready" || f.bars.length < 2) return null;
      bars[s] = f.bars;
    }
    return signalRules(spec, bars, d.symbol);
  }
  // Strategies deployed by earlier versions of Ballast as code.
  const f = feed(d.symbol);
  if (f.status !== "ready" || f.bars.length < 2) return null;
  const data = toSeries(f.bars);
  const strat = compileStrategy(d.code)(data);
  return { time: data.time, close: data.close, entry: strat.entry, exit: strat.exit, stopLoss: strat.stopLoss, takeProfit: strat.takeProfit };
}

function stepDeployments() {
  for (const d of state.deployments) {
    d.mode ??= "sim";
    if (!d.active || d.mode !== feedMode()) continue;
    let r;
    try {
      r = liveRules(d);
    } catch (err) {
      d.active = false;
      log(`⚠️ "${d.name}" stopped: ${err.message}`);
      continue;
    }
    if (!r) continue;
    const i = r.time.length - 1;
    // With a cross-market rule the latest day can be another exchange's session.
    if (r.hasBar && !r.hasBar[i]) continue;
    const price = r.close[i], bar = r.time[i];
    // Rule signals act at most once per daily bar; stops and targets can fire any time.
    const canSignal = d.lastSignalBar !== bar;
    if (d.shares > 0) {
      if (d.lastBar !== bar) { d.barsHeld = (d.barsHeld || 0) + 1; d.lastBar = bar; }
      d.peak = Math.max(d.peak ?? d.entryPrice, price);
      const stopHit = r.stopLoss && price <= d.entryPrice * (1 - r.stopLoss);
      const trailHit = r.trailingStop && price <= d.peak * (1 - r.trailingStop);
      const targetHit = r.takeProfit && price >= d.entryPrice * (1 + r.takeProfit);
      const timeHit = canSignal && r.maxHold && d.barsHeld >= r.maxHold;
      const exitSignal = canSignal && r.exit(i);
      if (stopHit || trailHit || targetHit || timeHit || exitSignal) {
        const pnl = d.shares * (price - d.entryPrice);
        d.cash += d.shares * price;
        const why = stopHit ? "stop loss" : trailHit ? "trailing stop" : targetHit ? "take profit" : timeHit ? "time limit" : "exit signal";
        log(`SELL ${d.shares.toFixed(4)} ${d.symbol} @ ${price.toFixed(2)} · "${d.name}" · ${why} · P&L ${money(pnl)}`);
        Object.assign(d, { shares: 0, entryPrice: null, peak: null, barsHeld: 0, lastSignalBar: bar });
        d.trades++;
      }
    } else if (canSignal && r.entry(i)) {
      // Leave the fill bar out of the count. The backtest includes it, then sells
      // on the next session once the count reaches N; paper sells on that session.
      Object.assign(d, { shares: d.cash / price, entryPrice: price, peak: price, cash: 0, barsHeld: 0, lastBar: bar, lastSignalBar: bar });
      log(`BUY ${d.shares.toFixed(4)} ${d.symbol} @ ${price.toFixed(2)} · "${d.name}"`);
    }
  }
  persistMonitor();
}

function persistMonitor() {
  store.set("watchlist", state.watchlist);
  store.set("deployments", state.deployments);
  store.set("alerts", state.alerts);
}

function log(text) {
  state.activity.unshift({ t: Date.now(), text });
  state.activity = state.activity.slice(0, 200);
  store.set("activity", state.activity);
  if ($("#view-monitor").classList.contains("active")) renderActivity();
}

function notify(text) {
  if ("Notification" in window && Notification.permission === "granted") new Notification("Ballast alert", { body: text });
}

function renderActivity() {
  $("#activity").innerHTML = state.activity.length
    ? state.activity.map((a) => `<li><span><time>${new Date(a.t).toLocaleTimeString()}</time>${esc(a.text)}</span></li>`).join("")
    : `<li class="empty">Fills, alerts, and status changes will show up here.</li>`;
}

function renderMonitorIfVisible() {
  if ($("#view-monitor").classList.contains("active")) renderMonitor();
}

function renderMonitor() {
  const mode = feedMode();
  $("#watchlist").innerHTML = `<thead><tr><th>Symbol</th><th>Last</th><th>Change</th><th>Source</th><th></th></tr></thead><tbody>${state.watchlist
    .map((s) => {
      const f = feed(s);
      const remove = `<button class="link" data-unwatch="${esc(s)}" title="Remove">✕</button>`;
      if (f.status !== "ready") {
        const msg = f.status === "error" ? `<span class="neg" title="${esc(f.error)}">${esc(f.error)}</span>` : `<span class="note">Loading…</span>`;
        return `<tr><td><strong>${esc(s)}</strong></td><td colspan="3">${msg}</td><td>${remove}</td></tr>`;
      }
      const last = f.bars.at(-1).close;
      const ch = mode === "live" && f.quote ? f.quote.changePct : (last / f.bars.at(-2).close - 1) * 100;
      const age = mode === "live" && f.quote ? ` title="Quote time ${new Date(f.quote.time).toLocaleString()}"` : "";
      return `<tr><td><strong>${esc(s)}</strong></td><td${age}>${last.toFixed(2)}</td><td class="${ch >= 0 ? "pos" : "neg"}">${ch >= 0 ? "+" : ""}${ch.toFixed(2)}%</td><td class="note">${esc(f.source)}${f.error ? " ⚠️" : ""}</td><td>${remove}</td></tr>`;
    })
    .join("")}</tbody>`;

  const sel = $("#alert-symbol"), chosen = sel.value;
  sel.innerHTML = state.watchlist.map((s) => `<option>${esc(s)}</option>`).join("");
  if (state.watchlist.includes(chosen)) sel.value = chosen;

  $("#alerts").innerHTML = state.alerts.length
    ? state.alerts.map((a, k) => `<li><span>${esc(a.symbol)} ${a.dir} ${a.price.toFixed(2)} ${a.triggered ? "· <strong>triggered</strong>" : ""}</span><button class="link" data-unalert="${k}" title="Remove">✕</button></li>`).join("")
    : `<li class="empty">No alerts yet.</li>`;

  $("#deployments").innerHTML = state.deployments.length
    ? `<thead><tr><th>Strategy</th><th>Symbol</th><th>Feed</th><th>Status</th><th>Position</th><th>Equity</th><th>Return</th><th>Closed trades</th><th></th></tr></thead><tbody>${state.deployments
        .map((d) => {
          d.mode ??= "sim";
          const f = d.mode === mode ? feed(d.symbol) : null;
          const price = f?.status === "ready" ? f.bars.at(-1).close : d.entryPrice;
          const eq = d.cash + d.shares * (price ?? 0), ret = (eq / d.capital - 1) * 100;
          const status = !d.active ? "Stopped" : d.mode !== mode ? `Paused (switch to ${d.mode === "live" ? "live" : "simulated"} feed)` : "Running";
          return `<tr><td>${esc(d.name)}</td><td>${esc(d.symbol)}</td><td>${d.mode === "live" ? "Live" : "Simulated"}</td><td>${status}</td><td>${d.shares > 0 ? `Long @ ${d.entryPrice.toFixed(2)}` : "Flat"}</td><td>${money(eq)}</td><td class="${ret >= 0 ? "pos" : "neg"}">${ret.toFixed(2)}%</td><td>${d.trades}</td><td><button class="btn small" data-toggle-dep="${d.id}">${d.active ? "Stop" : "Resume"}</button> <button class="link" data-del-dep="${d.id}" title="Remove">✕</button></td></tr>`;
        })
        .join("")}</tbody>`
    : `<tbody><tr><td class="empty">No paper strategies yet. Build one and click "Paper trade".</td></tr></tbody>`;
  renderActivity();
}

$("#watch-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const s = resolveSymbol($("#watch-symbol").value);
  if (s && !state.watchlist.includes(s)) state.watchlist.push(s);
  $("#watch-symbol").value = "";
  persistMonitor();
  renderMonitor();
});

$("#alert-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const price = parseFloat($("#alert-price").value);
  if (!Number.isFinite(price)) return;
  state.alerts.push({ symbol: $("#alert-symbol").value, dir: $("#alert-dir").value, price, triggered: false });
  $("#alert-price").value = "";
  if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
  persistMonitor();
  renderMonitor();
});

document.addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  if (t.dataset.unwatch) {
    state.watchlist = state.watchlist.filter((s) => s !== t.dataset.unwatch);
    state.alerts = state.alerts.filter((a) => a.symbol !== t.dataset.unwatch);
    state.deployments = state.deployments.filter((d) => d.symbol !== t.dataset.unwatch);
  }
  if (t.dataset.unalert) state.alerts.splice(Number(t.dataset.unalert), 1);
  if (t.dataset.toggleDep) {
    const d = state.deployments.find((x) => x.id === t.dataset.toggleDep);
    d.active = !d.active;
    log(`${d.active ? "Resumed" : "Stopped"} "${d.name}".`);
  }
  if (t.dataset.delDep) state.deployments = state.deployments.filter((d) => d.id !== t.dataset.delDep);
  if (t.dataset.unwatch || t.dataset.unalert || t.dataset.toggleDep || t.dataset.delDep) {
    persistMonitor();
    renderMonitor();
  }
});

$("#clear-activity").addEventListener("click", () => {
  state.activity = [];
  store.set("activity", []);
  renderActivity();
});

let timer = null;
function startFeed() {
  clearInterval(timer);
  timer = setInterval(tick, Number($("#tick-speed").value));
  tick();
  $("#feed-toggle").textContent = "Pause";
}
$("#tick-speed").addEventListener("change", () => timer && startFeed());
$("#feed-mode").addEventListener("change", () => {
  store.set("feedMode", feedMode());
  $("#feed-note").textContent = "";
  renderMonitor();
  if (timer) tick();
});
$("#feed-toggle").addEventListener("click", () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
    $("#feed-toggle").textContent = "Resume";
  } else startFeed();
});

window.addEventListener("resize", () => lastResult && $("#view-build").classList.contains("active") && renderResults(lastResult));

// ---------- rebalance (advice only: never places orders) ----------
const portfolio = store.get("portfolio", {
  holdings: [
    { symbol: "VTI", shares: 0, target: 60 },
    { symbol: "VXUS", shares: 0, target: 25 },
    { symbol: "BND", shares: 0, target: 15 },
  ],
  cash: 10000, band: 5, minTrade: 25, cashBuffer: 1, fractional: true,
});
const rbPrices = {}, rbErrors = {};
let rbPlan = null, rbWasOut = false;

const savePortfolio = () => store.set("portfolio", portfolio);

async function refreshPortfolioPrices() {
  const symbols = [...new Set(portfolio.holdings.map((h) => h.symbol).filter(Boolean))];
  if (!symbols.length) return renderRebalance();
  try {
    const { quotes, errors } = await fetchQuotes(symbols);
    for (const s of symbols) {
      if (quotes[s]) { rbPrices[s] = quotes[s].price; delete rbErrors[s]; }
      else rbErrors[s] = errors[s] || "No quote";
    }
    $("#rb-updated").textContent = `Last update ${new Date().toLocaleTimeString()}.`;
  } catch (err) {
    $("#rb-updated").textContent = `Price update failed: ${err.message}.`;
  }
  renderRebalance();
}

function renderRebalance() {
  const a = analyze(portfolio.holdings, rbPrices, Number(portfolio.cash) || 0);
  rbPlan = plan(a, { band: portfolio.band, minTrade: portfolio.minTrade, fractional: portfolio.fractional, cashBuffer: portfolio.cashBuffer, force: $("#rb-force").checked });
  const out = rbPlan.outOfBand.length;
  const priced = portfolio.holdings.every((h) => !h.symbol || rbPrices[h.symbol] != null);

  // Notify once each time the portfolio drifts out of its band.
  if (priced && out && !rbWasOut) {
    log(`⚖️ Rebalance suggested: ${rbPlan.outOfBand.map((r) => `${r.symbol} ${r.drift > 0 ? "+" : ""}${r.drift.toFixed(1)} pts`).join(", ")}.`);
    notify(`Portfolio drifted: ${rbPlan.outOfBand.map((r) => r.symbol).join(", ")} outside the ${portfolio.band}-pt band`);
  }
  if (priced) rbWasOut = out > 0;

  const pill = $("#rb-status");
  pill.textContent = !priced ? "Loading prices…" : out ? `${out} holding${out > 1 ? "s" : ""} out of band` : "Within band";
  pill.classList.toggle("on", priced && !out);

  const maxDrift = a.rows.reduce((m, r) => Math.max(m, Math.abs(r.drift)), 0);
  $("#rb-metrics").innerHTML = [
    ["Portfolio value", money(a.total)],
    ["Invested", money(a.invested)],
    ["Cash", `${money(a.cash)} (${a.cashWeight.toFixed(1)}%)`],
    ["Largest drift", `${maxDrift.toFixed(1)} pts`],
    ["Band", `±${portfolio.band} pts`],
  ].map(([l, v]) => `<div class="metric"><div class="label">${l}</div><div class="value">${v}</div></div>`).join("");

  const warn = $("#rb-warn");
  warn.hidden = Math.abs(a.targetSum - 100) < 0.01;
  warn.textContent = `Targets add up to ${a.targetSum.toFixed(1)}%; they should total 100% (the cash buffer is applied on top).`;

  // Only rebuild the inputs when the table isn't being edited, so typing isn't interrupted.
  const tbl = $("#rb-holdings");
  if (!tbl.contains(document.activeElement)) {
    tbl.innerHTML = `<thead><tr><th>Symbol</th><th>Shares</th><th>Price</th><th>Value</th><th>Weight</th><th>Target %</th><th>Drift</th><th></th></tr></thead><tbody>${portfolio.holdings
      .map((h, k) => {
        const r = a.rows.find((x) => x.symbol === h.symbol);
        const err = rbErrors[h.symbol];
        const drift = r ? r.drift : null;
        const cls = drift == null ? "" : Math.abs(drift) > portfolio.band ? "neg" : "pos";
        return `<tr>
          <td><input data-rb="${k}" data-field="symbol" value="${esc(h.symbol)}" maxlength="20" /></td>
          <td><input data-rb="${k}" data-field="shares" type="number" min="0" step="any" value="${h.shares}" /></td>
          <td>${r ? r.price.toFixed(2) : err ? `<span class="neg" title="${esc(err)}">${esc(err)}</span>` : "…"}</td>
          <td>${r ? money(r.value) : "–"}</td>
          <td>${r ? `${r.weight.toFixed(1)}%` : "–"}</td>
          <td><input data-rb="${k}" data-field="target" type="number" min="0" max="100" step="0.5" value="${h.target}" /></td>
          <td class="${cls}">${drift == null ? "–" : `${drift > 0 ? "+" : ""}${drift.toFixed(1)} pts`}</td>
          <td><button class="link" data-rb-del="${k}" title="Remove">✕</button></td></tr>`;
      })
      .join("")}</tbody>`;
  }

  $("#rb-plan").innerHTML = !rbPlan.needed
    ? `<tbody><tr><td class="empty">No trades needed. Every holding is within ±${portfolio.band} pts of its target.</td></tr></tbody>`
    : rbPlan.trades.length
      ? `<thead><tr><th>Action</th><th>Shares</th><th>Symbol</th><th>Approx. price</th><th>Approx. amount</th></tr></thead><tbody>${rbPlan.trades
          .map((t) => `<tr><td class="${t.side === "BUY" ? "pos" : "neg"}"><strong>${t.side}</strong></td><td>${t.shares}</td><td>${esc(t.symbol)}</td><td>${t.price.toFixed(2)}</td><td>${money(t.amount)}</td></tr>`)
          .join("")}<tr><td colspan="4">Cash after trades</td><td>${money(rbPlan.cashAfter)}</td></tr></tbody>`
      : `<tbody><tr><td class="empty">Out of band, but every trade would be under the ${money(portfolio.minTrade)} minimum.</td></tr></tbody>`;
}

function syncRuleInputs() {
  $("#rb-cash").value = portfolio.cash;
  $("#rb-band").value = portfolio.band;
  $("#rb-min").value = portfolio.minTrade;
  $("#rb-buffer").value = portfolio.cashBuffer;
  $("#rb-fractional").checked = portfolio.fractional;
}

for (const [id, key] of [["#rb-cash", "cash"], ["#rb-band", "band"], ["#rb-min", "minTrade"], ["#rb-buffer", "cashBuffer"]]) {
  $(id).addEventListener("input", () => {
    portfolio[key] = Math.max(0, Number($(id).value) || 0);
    savePortfolio();
    renderRebalance();
  });
}
$("#rb-fractional").addEventListener("change", () => {
  portfolio.fractional = $("#rb-fractional").checked;
  savePortfolio();
  renderRebalance();
});
$("#rb-force").addEventListener("change", renderRebalance);

$("#rb-holdings").addEventListener("input", (e) => {
  const k = e.target.dataset.rb;
  if (k == null) return;
  const h = portfolio.holdings[k], f = e.target.dataset.field;
  h[f] = f === "symbol" ? e.target.value.trim().toUpperCase() : Math.max(0, Number(e.target.value) || 0);
  savePortfolio();
});
// Recalculate (and fetch a price for a new symbol) when the user leaves a field.
$("#rb-holdings").addEventListener("focusout", (e) => {
  if (e.target.dataset.field === "symbol" && e.target.value && rbPrices[e.target.value.trim().toUpperCase()] == null) {
    setTimeout(refreshPortfolioPrices, 0);
  } else setTimeout(renderRebalance, 0);
});
$("#rb-holdings").addEventListener("keydown", (e) => {
  if (e.key === "Enter") e.target.blur();
});

$("#rb-add").addEventListener("click", () => {
  portfolio.holdings.push({ symbol: "", shares: 0, target: 0 });
  savePortfolio();
  renderRebalance();
  $(`#rb-holdings input[data-rb="${portfolio.holdings.length - 1}"][data-field="symbol"]`)?.focus();
});

document.addEventListener("click", (e) => {
  const t = e.target.closest("button[data-rb-del]");
  if (!t) return;
  portfolio.holdings.splice(Number(t.dataset.rbDel), 1);
  savePortfolio();
  renderRebalance();
});

const planText = () =>
  rbPlan.trades.map((t) => `${t.side} ${t.shares} ${t.symbol} (about ${money(t.amount)} at ${t.price.toFixed(2)})`).join("\n");

$("#rb-copy").addEventListener("click", async () => {
  if (!rbPlan?.trades.length) return;
  try {
    await navigator.clipboard.writeText(planText());
    flash($("#rb-copy"), "Copied ✓");
  } catch {
    window.prompt("Copy the trade list:", planText());
  }
});

$("#rb-export").addEventListener("click", () => {
  if (!rbPlan?.trades.length) return;
  const rows = [["side", "symbol", "shares", "approx_price", "approx_amount"], ...rbPlan.trades.map((t) => [t.side, t.symbol, t.shares, t.price.toFixed(4), t.amount.toFixed(2)])];
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([rows.map((r) => r.join(",")).join("\n")], { type: "text/csv" }));
  a.download = `rebalance_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// After the user places the trades at their broker, roll the plan into the holdings.
$("#rb-apply").addEventListener("click", () => {
  if (!rbPlan?.trades.length) return;
  if (!confirm("Update share counts and cash as if these trades filled at the shown prices? Edit them afterwards to match your actual fills.")) return;
  for (const t of rbPlan.trades) {
    const h = portfolio.holdings.find((x) => x.symbol === t.symbol);
    h.shares = Math.max(0, Math.round((h.shares + (t.side === "BUY" ? t.shares : -t.shares)) * 1e4) / 1e4);
  }
  portfolio.cash = Math.round(rbPlan.cashAfter * 100) / 100;
  log(`Recorded rebalance: ${rbPlan.trades.map((t) => `${t.side} ${t.shares} ${t.symbol}`).join(", ")}.`);
  savePortfolio();
  syncRuleInputs();
  $("#rb-force").checked = false;
  renderRebalance();
});

// ---------- Alpaca paper autopilot panel ----------
async function postJson(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

let apStatus = null;
async function loadAutopilot() {
  if (!state.autopilot) return renderAutopilot();
  try {
    apStatus = await fetchJson("api/autopilot/status");
  } catch (err) {
    apStatus = { error: err.message };
  }
  renderAutopilot();
}

function renderAutopilot(extra = "") {
  const s = apStatus, body = $("#ap-body"), pill = $("#ap-pill");
  if (!state.autopilot) {
    pill.textContent = "Mac app only";
    body.innerHTML = `<p class="note">The paper-trading autopilot needs the Ballast Mac app (or <code>npm start</code>), which keeps your Alpaca keys on your own computer. This website never sees any keys.</p>`;
    return;
  }
  if (!s) return;
  if (s.error) {
    pill.textContent = "Unavailable";
    body.innerHTML = `<p class="note">Couldn't reach the autopilot: ${esc(s.error)}. Is the server running?</p>`;
    return;
  }
  if (!s.configured) {
    pill.textContent = "Not connected";
    pill.classList.remove("on");
    body.innerHTML = `<p>Runs this rebalancer automatically on an <strong>Alpaca paper-trading</strong> account: real prices, simulated money. It can't place real-money orders.</p>
      <ol class="note"><li>Create a free account at alpaca.markets and open the Paper Trading dashboard.</li>
      <li>Generate paper API keys.</li>
      <li>Copy <code>.env.example</code> in the Ballast folder to <code>.env</code> and paste the keys in (the Mac installer can do this for you).</li>
      <li>Restart with <code>npm start</code>, then come back here.</li></ol>`;
    return;
  }
  const c = s.config, on = c.enabled && !s.stopped;
  pill.textContent = s.stopped ? "Emergency stop on" : on ? "On" : "Off";
  pill.classList.toggle("on", on);
  const targets = c.targets.map((t) => `${esc(t.symbol)} ${t.target}%`).join(" · ");
  const acct = s.account ? `${money(s.account.equity)} equity, ${money(s.account.cash)} cash` : `<span class="neg">${esc(s.accountError || "account unavailable")}</span>`;
  const entries = s.journal.slice(0, 12).map((e) => {
    const what = e.type === "order" ? `${e.side} ${e.symbol} ${e.notional != null ? money(Number(e.notional)) : `${e.qty} sh`} → ${e.status}${e.fillPrice ? ` @ ${e.fillPrice.toFixed(2)}` : ""}`
      : e.type === "check" ? `Check: equity ${money(e.equity)}${e.outOfBand.length ? `, out of band: ${e.outOfBand.join(", ")}` : ", all within band"}`
      : `${e.type === "error" ? "⚠️ " : ""}${esc(e.message || e.type)}`;
    return `<li><span><time>${new Date(e.ts).toLocaleString()}</time>${what}</span></li>`;
  }).join("");
  body.innerHTML = `
    <div class="ap-grid">
      <div><div class="label note">Paper account</div>${acct}</div>
      <div><div class="label note">Targets</div>${targets}</div>
      <div><div class="label note">Rules</div>±${c.band} pts band · min ${money(c.minTrade)} · ${c.cashBuffer}% cash · daily check after ${esc(c.checkTimeET)} ET</div>
      <div><div class="label note">Test started</div>${c.startedAt ? `${esc(c.startedAt)} with ${money(c.startEquity)}` : "Not yet. Starts at the first check."}</div>
    </div>
    ${s.configErrors.length ? `<p class="error">${esc(s.configErrors.join("; "))}</p>` : ""}
    <div class="row wrap" style="margin-top:12px">
      <button class="btn small" id="ap-sync" title="Copy the targets and rules from the table above">Use targets &amp; rules above</button>
      <button class="btn small ${on ? "" : "primary"}" id="ap-toggle">${c.enabled ? "Turn off" : "Turn on"}</button>
      <button class="btn small" id="ap-run">Run check now</button>
      <button class="btn small" id="ap-report">Test report</button>
    </div>
    ${extra}
    <h3 style="margin-top:16px">Decision log</h3>
    <ul class="list activity">${entries || `<li class="empty">Nothing yet.</li>`}</ul>`;

  $("#ap-sync").onclick = async () => {
    const targets = portfolio.holdings.filter((h) => h.symbol && h.target > 0).map((h) => ({ symbol: h.symbol, target: h.target }));
    try {
      await postJson("api/autopilot/config", { targets, band: portfolio.band, minTrade: Math.max(1, portfolio.minTrade), cashBuffer: portfolio.cashBuffer });
      await loadAutopilot();
    } catch (err) { renderAutopilot(`<p class="error">${esc(err.message)}</p>`); }
  };
  $("#ap-toggle").onclick = async () => {
    try {
      await postJson("api/autopilot/config", { enabled: !c.enabled });
      log(`Paper autopilot turned ${c.enabled ? "off" : "on"}.`);
      await loadAutopilot();
    } catch (err) { renderAutopilot(`<p class="error">${esc(err.message)}</p>`); }
  };
  $("#ap-run").onclick = async () => {
    if (!confirm("Run a rebalance check on the paper account now? If anything is out of band it will place paper orders.")) return;
    $("#ap-run").disabled = true;
    try {
      const r = await postJson("api/autopilot/run");
      await loadAutopilot();
      renderAutopilot(`<p class="note">${esc(r.message || r.skipped || "Done")}</p>`);
    } catch (err) { renderAutopilot(`<p class="error">${esc(err.message)}</p>`); }
  };
  $("#ap-report").onclick = async () => {
    try {
      const r = await fetchJson("api/autopilot/report");
      renderAutopilot(`<pre class="report">${esc(r.markdown)}</pre>`);
    } catch (err) { renderAutopilot(`<p class="note">${esc(err.message)}</p>`); }
  };
}

setInterval(() => $("#view-rebalance").classList.contains("active") && loadAutopilot(), 60000);

// ---------- init ----------
function renderAiPill(status = {}) {
  const pill = $("#ai-status");
  pill.textContent = state.ai ? "Builder: Claude + parser" : status.aiKeyError ? "Builder: Claude key rejected" : "Builder: built-in parser";
  pill.classList.toggle("on", state.ai);
  pill.title = state.ai ? "Claude turns your words into rules; Ballast's parser checks every rule before it runs." : status.aiKeyError || (!state.server ? "The built-in parser reads your strategy. Claude can read looser descriptions when Ballast runs with an Anthropic key." : state.autopilot ? "Add an Anthropic API key in Ballast > Edit Keys to enable the AI builder." : "This site has no Claude key set, so the built-in parser reads your strategy.");
}

(async function init() {
  let status;
  try {
    status = await fetchJson("api/status");
    state.ai = status.ai;
    state.server = true;
    // The hosted website has a server for prices and the builder, but the autopilot
    // and its Alpaca keys only ever run in the Mac app.
    state.autopilot = status.autopilot !== false;
  } catch { /* no server: website mode */ }
  document.documentElement.classList.toggle("website", !state.server);
  // The website can only load real prices for crypto, so open on a real series there.
  if (!state.server && $("#symbol").value === "SPY") $("#symbol").value = "BTC-USD";
  renderAiPill(status);
  const pill = $("#ai-status");
  if (!state.autopilot) pill.insertAdjacentHTML("afterend", `<a class="pill on" href="https://github.com/bollineni-create/ballast#install-it-on-a-mac" target="_blank" rel="noopener">Get the Mac app</a>`);

  $("#feed-mode").value = store.get("feedMode", "live");
  $("#history").value = store.get("history", "max");
  const draft = store.get("draft", null);
  loadStrategy(draft?.rules ? draft : state.server ? LIBRARY[0] : LIBRARY.find((x) => x.tag === "Crypto"));
  renderChat();
  renderLibrary();
  runAndShow();
  startFeed();
  syncRuleInputs();
  refreshPortfolioPrices();
  setInterval(refreshPortfolioPrices, 15000);
})();


// ---------- sync across devices (bollineni.co only) ----------
// On the site, /sync/kit.js keeps saved strategies, the rebalancing portfolio, the watchlist,
// price alerts and the strategy chat the same on every device linked to the site's sync, with no
// account. Everything is encrypted in this browser first. Paper-trading runs stay on the device
// that started them: they move with every price tick, and two devices trading one book would fight.
(function startSync() {
  const S = window.BollineniSync;
  if (!S || !window.crypto?.subtle) return;
  const PREF_KEYS = ["watchlist", "alerts", "portfolio", "chat"];
  const sym = (v) => typeof v === "string" && /^[A-Z0-9.^=-]{1,15}$/.test(v);
  const num = (v) => Number.isFinite(v);
  const CHECK = {
    watchlist: (v) => Array.isArray(v) && v.length <= 50 && v.every(sym),
    alerts: (v) => Array.isArray(v) && v.length <= 100 && v.every((a) => a && sym(a.symbol) && (a.dir === "above" || a.dir === "below") && num(a.price) && typeof a.triggered === "boolean"),
    portfolio: (v) => v && Array.isArray(v.holdings) && v.holdings.length <= 60 && v.holdings.every((h) => h && typeof h.symbol === "string" && h.symbol.length <= 15 && num(h.shares) && num(h.target))
      && num(v.cash) && num(v.band) && num(v.minTrade) && num(v.cashBuffer) && typeof v.fractional === "boolean",
    chat: (v) => Array.isArray(v) && v.length <= 60 && v.every((m) => m && typeof m === "object" && JSON.stringify(m).length < 40000),
  };
  const engine = S.createEngine({
    app: "ballast",
    collections: { strategies: { first: "keep" }, prefs: { first: "remote" } },
    read() {
      const strategies = {};
      // A strategy is plain-English rules now; ones saved before that hold code instead.
      for (const s of state.saved) {
        const out = { name: s.name, created: s.created || 0 };
        if (typeof s.rules === "string") out.rules = s.rules;
        if (typeof s.code === "string") out.code = s.code;
        strategies[s.id] = out;
      }
      const prefs = { watchlist: state.watchlist, alerts: state.alerts, portfolio: { ...portfolio }, chat: state.chat.slice(-60) };
      return { strategies, prefs: JSON.parse(JSON.stringify(prefs)) };
    },
    clean(col, v, id) {
      if (col === "strategies") {
        const text = (t) => t === undefined || (typeof t === "string" && t.length <= 60000);
        return /^[\w-]{1,64}$/.test(id) && v && typeof v.name === "string" && v.name.length <= 120 && num(v.created)
          && text(v.rules) && text(v.code) && (typeof v.rules === "string" || typeof v.code === "string")
          ? { name: v.name, created: v.created, ...(v.rules !== undefined && { rules: v.rules }), ...(v.code !== undefined && { code: v.code }) } : null;
      }
      if (col === "prefs") return Object.hasOwn(CHECK, id) && CHECK[id](v) ? v : null;
      return null;
    },
    async write(v) {
      state.saved = Object.entries(v.strategies).map(([id, s]) => ({ id, ...s })).sort((a, b) => a.created - b.created);
      if (v.prefs.watchlist) state.watchlist = v.prefs.watchlist;
      if (v.prefs.alerts) state.alerts = v.prefs.alerts;
      if (v.prefs.chat) state.chat = v.prefs.chat;
      if (v.prefs.portfolio) { for (const k of Object.keys(portfolio)) delete portfolio[k]; Object.assign(portfolio, v.prefs.portfolio); }
      store.set("saved", state.saved);
      persistMonitor();
      store.set("chat", state.chat);
      savePortfolio();
      renderLibrary();
      renderChat();
      renderRebalance();
      renderMonitorIfVisible();
    },
    maxPayload: 790000,
  });
  S.register(engine, "Ballast");
  // Every save to one of these keys is a change to sync.
  const set = store.set;
  store.set = (key, value) => { set(key, value); if (key === "saved" || PREF_KEYS.includes(key)) engine.changed(); };
  const btn = $("#sync-btn");
  const draw = () => {
    const st = engine.status();
    btn.hidden = !st.available;
    btn.classList.toggle("on", st.on);
    btn.textContent = !st.on ? "Sync" : st.phase === "syncing" ? "Syncing…" : st.phase === "error" ? "Sync ⚠" : "Synced";
    btn.title = st.on ? (st.problem?.message || "Synced with your devices. Click to manage.") : "Keep strategies, portfolio, watchlist and alerts on all your devices";
  };
  engine.onStatus(draw);
  S.site.onChange(draw);
  btn.addEventListener("click", () => S.openPanel({ app: "ballast", tint: "#2DD4BF" }));
  engine.start().catch(() => {});
})();
