// Live: watchlist, price alerts and paper trading on a live or simulated feed.
import { $, esc, money, signed, tone, price, store, state, on, showing, toast, fetchQuotes, liveHistory } from "../core.js";
import { simulatedBars, toSeries, nextBar, rng } from "../lib/data.js";
import { compileStrategy } from "../lib/backtest.js";
import { parseStrategy } from "../lib/parse.js";
import { neededSymbols, signalRules } from "../lib/engine.js";
import { resolveSymbol, nameOf } from "../lib/markets.js";
import { sparkline } from "../lib/charts.js";

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
      (h) => { f.bars = h.bars.slice(-400).map((b) => ({ ...b })); f.source = h.source; f.status = "ready"; renderIfVisible(); },
      (err) => { Object.assign(f, { status: "error", error: err.message, retryAt: Date.now() + 60e3 }); renderIfVisible(); },
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
      const f = feed(sym, "sim"), last = f.bars.at(-1);
      f.bars.push(nextBar(last.close, last.time + 864e5, f.rand, f.sim));
      if (f.bars.length > 600) f.bars.shift();
    }
  } else {
    if (polling) return;
    state.watchlist.forEach((s) => feed(s, "live"));
    const ready = state.watchlist.filter((s) => feed(s, "live").status === "ready");
    if (!ready.length) return renderIfVisible();
    polling = true;
    try {
      const { quotes, errors } = await fetchQuotes(ready);
      for (const s of ready) {
        const f = feed(s, "live");
        if (quotes[s]) { applyQuote(f, quotes[s]); f.error = null; } else f.error = errors[s] || "No quote";
      }
      $("#feed-note").textContent = `Prices updated ${new Date().toLocaleTimeString()}.`;
    } catch (err) {
      $("#feed-note").textContent = `Price update failed: ${err.message}. Retrying.`;
    } finally {
      polling = false;
    }
    if (feedMode() !== mode) return;
  }
  checkAlerts();
  stepDeployments();
  renderIfVisible();
}

const lastPrice = (symbol) => { const f = feed(symbol); return f.status === "ready" ? f.bars.at(-1).close : null; };

export function log(text) {
  state.activity.unshift({ t: Date.now(), text });
  state.activity = state.activity.slice(0, 200);
  store.set("activity", state.activity);
  if (showing("live")) renderActivity();
}
export function notify(text) {
  if ("Notification" in window && Notification.permission === "granted") new Notification("Ballast", { body: text });
}
function persist() {
  store.set("watchlist", state.watchlist);
  store.set("deployments", state.deployments);
  store.set("alerts", state.alerts);
}
export function watch(symbol) {
  if (!symbol || state.watchlist.includes(symbol)) return;
  state.watchlist.push(symbol);
  persist();
  renderIfVisible();
}

function checkAlerts() {
  let fired = false;
  for (const a of state.alerts) {
    if (a.triggered) continue;
    const p = lastPrice(a.symbol);
    if (p == null) continue;
    if ((a.dir === "above" && p >= a.price) || (a.dir === "below" && p <= a.price)) {
      a.triggered = fired = true;
      log(`Alert: ${a.symbol} is ${a.dir} ${price(a.price)} (now ${price(p)}).`);
      notify(`${a.symbol} ${a.dir} ${price(a.price)}`);
    }
  }
  if (fired) store.set("alerts", state.alerts);
}

// A paper strategy's rules on the current feeds, or null while feeds are loading.
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
  // Strategies deployed by early versions of Ballast as code.
  const f = feed(d.symbol);
  if (f.status !== "ready" || f.bars.length < 2) return null;
  const data = toSeries(f.bars);
  const strat = compileStrategy(d.code)(data);
  return { time: data.time, close: data.close, entry: strat.entry, exit: strat.exit, shortEntry: () => false, shortExit: () => false, stopLoss: strat.stopLoss, takeProfit: strat.takeProfit };
}

// A paper position: d.shares > 0 is long, < 0 is short; d.cash holds everything else.
function stepDeployments() {
  let changed = false;
  for (const d of state.deployments) {
    d.mode ??= "sim";
    if (!d.active || d.mode !== feedMode()) continue;
    let r;
    try { r = liveRules(d); } catch (err) { d.active = false; changed = true; log(`"${d.name}" stopped: ${err.message}`); continue; }
    if (!r) continue;
    const i = r.time.length - 1;
    if (r.hasBar && !r.hasBar[i]) continue; // the latest day can be another exchange's session
    const p = r.close[i], bar = r.time[i];
    // Rule signals act at most once per daily bar; stops and targets can fire at any update.
    const canSignal = d.lastSignalBar !== bar;
    const enter = (dir) => {
      const q = (d.cash / p) * dir;
      Object.assign(d, { shares: q, cash: d.cash - q * p, entryPrice: p, peak: p, barsHeld: 0, lastBar: bar, lastSignalBar: bar });
      log(`${dir > 0 ? "BUY" : "SHORT"} ${Math.abs(q).toFixed(4)} ${d.symbol} at ${price(p)} · "${d.name}"`);
      changed = true;
    };
    if (d.shares) {
      const dir = d.shares > 0 ? 1 : -1;
      if (d.lastBar !== bar) { d.barsHeld = (d.barsHeld || 0) + 1; d.lastBar = bar; changed = true; }
      d.peak = dir > 0 ? Math.max(d.peak ?? d.entryPrice, p) : Math.min(d.peak ?? d.entryPrice, p);
      const stopHit = r.stopLoss && dir * (p - d.entryPrice) <= -r.stopLoss * d.entryPrice;
      const trailHit = r.trailingStop && dir * (p - d.peak) <= -r.trailingStop * d.peak;
      const targetHit = r.takeProfit && dir * (p - d.entryPrice) >= r.takeProfit * d.entryPrice;
      const timeHit = canSignal && r.maxHold && d.barsHeld >= r.maxHold;
      const exitSignal = canSignal && (dir > 0 ? r.exit(i) : r.shortExit(i));
      const reverse = canSignal && !exitSignal && (dir > 0 ? r.shortEntry(i) : r.entry(i));
      if (stopHit || trailHit || targetHit || timeHit || exitSignal || reverse) {
        const pnl = d.shares * (p - d.entryPrice);
        const why = stopHit ? "stop loss" : trailHit ? "trailing stop" : targetHit ? "take profit" : timeHit ? "time limit" : exitSignal ? "exit rule" : "reversal";
        log(`${dir > 0 ? "SELL" : "COVER"} ${Math.abs(d.shares).toFixed(4)} ${d.symbol} at ${price(p)} · "${d.name}" · ${why} · ${money(pnl)}`);
        Object.assign(d, { cash: d.cash + d.shares * p, shares: 0, entryPrice: null, peak: null, barsHeld: 0, lastSignalBar: bar, trades: d.trades + 1 });
        changed = true;
        if (reverse) enter(-dir);
      }
    } else if (canSignal && r.entry(i)) enter(1);
    else if (canSignal && r.shortEntry(i)) enter(-1);
  }
  if (changed) store.set("deployments", state.deployments);
}

function renderActivity() {
  $("#activity").innerHTML = state.activity.length
    ? state.activity.map((a) => `<li><span><time>${new Date(a.t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>${esc(a.text)}</span></li>`).join("")
    : `<li class="empty">Fills, alerts and status changes show up here.</li>`;
}

export function renderIfVisible() { if (showing("live")) render(); }

function render() {
  const mode = feedMode();
  $("#watchlist").innerHTML = state.watchlist.length ? `<thead><tr><th>Symbol</th><th class="num">Last</th><th class="num">Today</th><th>3 months</th><th></th></tr></thead><tbody>${state.watchlist.map((s) => {
    const f = feed(s);
    const remove = `<button type="button" class="link" data-unwatch="${esc(s)}" title="Remove ${esc(s)}">✕</button>`;
    const label = `<strong>${esc(s)}</strong><br><span class="note">${esc(nameOf(s) === s ? f.source || "" : nameOf(s))}</span>`;
    if (f.status !== "ready") return `<tr><td>${label}</td><td colspan="3">${f.status === "error" ? `<span class="neg">${esc(f.error)}</span>` : `<span class="note">Loading…</span>`}</td><td class="num">${remove}</td></tr>`;
    const last = f.bars.at(-1).close;
    const ch = mode === "live" && f.quote ? f.quote.changePct : (last / f.bars.at(-2).close - 1) * 100;
    const tail = f.bars.slice(-63).map((b) => b.close);
    return `<tr><td>${label}</td><td class="num"${f.quote ? ` title="Quote time ${new Date(f.quote.time).toLocaleString()}"` : ""}>${price(last)}${f.error ? " ⚠" : ""}</td><td class="num ${tone(ch)}">${signed(ch, 2)}</td><td>${sparkline(tail, { up: tail.at(-1) >= tail[0] })}</td><td class="num">${remove}</td></tr>`;
  }).join("")}</tbody>` : `<tbody><tr><td class="empty">Nothing on the watchlist. Add a symbol above.</td></tr></tbody>`;

  const sel = $("#alert-symbol"), chosen = sel.value;
  sel.innerHTML = state.watchlist.map((s) => `<option>${esc(s)}</option>`).join("");
  if (state.watchlist.includes(chosen)) sel.value = chosen;
  $("#alerts").innerHTML = state.alerts.length
    ? state.alerts.map((a, k) => `<li><span>${esc(a.symbol)} ${a.dir} ${price(a.price)}${a.triggered ? " · <strong>triggered</strong>" : ""}</span><button type="button" class="link" data-unalert="${k}" title="Remove">✕</button></li>`).join("")
    : `<li class="empty">No alerts yet.</li>`;

  $("#deployments").innerHTML = state.deployments.length
    ? `<thead><tr><th>Strategy</th><th>Symbol</th><th>Status</th><th>Position</th><th class="num">Value</th><th class="num">Return</th><th class="num">Closed trades</th><th></th></tr></thead><tbody>${state.deployments.map((d) => {
      d.mode ??= "sim";
      const f = d.mode === mode ? feed(d.symbol) : null;
      const p = f?.status === "ready" ? f.bars.at(-1).close : d.entryPrice;
      const eq = d.cash + d.shares * (p ?? 0), ret = (eq / d.capital - 1) * 100;
      const status = !d.active ? "Stopped" : d.mode !== mode ? `Paused: needs the ${d.mode === "live" ? "live" : "simulated"} feed` : "Running";
      return `<tr><td>${esc(d.name)}</td><td>${esc(d.symbol)}</td><td>${status}</td><td>${d.shares ? `${d.shares > 0 ? "Long" : "Short"} from ${price(d.entryPrice)}` : "None"}</td><td class="num">${money(eq)}</td><td class="num ${tone(ret)}">${signed(ret, 2)}</td><td class="num">${d.trades}</td><td class="num"><button type="button" class="btn small" data-toggle-dep="${d.id}">${d.active ? "Stop" : "Resume"}</button> <button type="button" class="link" data-del-dep="${d.id}" title="Remove">✕</button></td></tr>`;
    }).join("")}</tbody>`
    : `<tbody><tr><td class="empty">No paper strategies yet. Build one in the Studio and choose Paper trade.</td></tr></tbody>`;
  renderActivity();
}

let timer = null;
function startFeed() {
  clearInterval(timer);
  timer = setInterval(tick, Number($("#tick-speed").value));
  tick();
  $("#feed-toggle").textContent = "Pause";
}

export function initLive() {
  $("#feed-mode").value = store.get("feedMode", "live");
  $("#watch-form").addEventListener("submit", (e) => {
    e.preventDefault();
    watch(resolveSymbol($("#watch-symbol").value));
    $("#watch-symbol").value = "";
    render();
  });
  $("#alert-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const p = parseFloat($("#alert-price").value);
    if (!Number.isFinite(p) || !$("#alert-symbol").value) return;
    state.alerts.push({ symbol: $("#alert-symbol").value, dir: $("#alert-dir").value, price: p, triggered: false });
    $("#alert-price").value = "";
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
    persist();
    render();
  });
  $("#view-live").addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    const d = t.dataset;
    if (d.unwatch) {
      state.watchlist = state.watchlist.filter((s) => s !== d.unwatch);
      state.alerts = state.alerts.filter((a) => a.symbol !== d.unwatch);
      state.deployments = state.deployments.filter((x) => x.symbol !== d.unwatch);
    }
    if (d.unalert) state.alerts.splice(Number(d.unalert), 1);
    if (d.toggleDep) {
      const x = state.deployments.find((y) => y.id === d.toggleDep);
      x.active = !x.active;
      log(`${x.active ? "Resumed" : "Stopped"} "${x.name}".`);
    }
    if (d.delDep) state.deployments = state.deployments.filter((x) => x.id !== d.delDep);
    if (d.unwatch || d.unalert || d.toggleDep || d.delDep) { persist(); render(); }
  });
  $("#clear-activity").addEventListener("click", () => { state.activity = []; store.set("activity", []); renderActivity(); });
  $("#tick-speed").addEventListener("change", () => timer && startFeed());
  $("#feed-mode").addEventListener("change", () => { store.set("feedMode", feedMode()); $("#feed-note").textContent = ""; render(); if (timer) tick(); });
  $("#feed-toggle").addEventListener("click", () => {
    if (timer) { clearInterval(timer); timer = null; $("#feed-toggle").textContent = "Resume"; } else startFeed();
  });

  on("watch", (s) => { watch(s); toast(`Watching ${s}`); });
  on("deploy", ({ name, rules, spec, symbol, mode }) => {
    for (const s of neededSymbols(spec, symbol)) if (!state.watchlist.includes(s)) state.watchlist.push(s);
    state.deployments.push({ id: crypto.randomUUID(), name, rules, symbol, capital: 10000, cash: 10000, shares: 0, entryPrice: null, trades: 0, active: true, mode });
    persist();
    log(`Started paper trading "${name}" on ${symbol} (${mode === "live" ? "live prices" : "simulated feed"}) with $10,000.`);
    toast("Paper trading started. See Live.");
  });
  on("show", (v) => v === "live" && render());
  on("data", renderIfVisible);
  startFeed();
}
