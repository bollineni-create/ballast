// Studio: describe a strategy, read and edit its rules, test it, and judge the result.
import { $, $$, esc, day, money, pct, signed, num, tone, price, store, state, settings, saveSettings, on, emit, go, showing, toast, downloadCsv, copyText, fetchJson, fetchQuotes, loadBars, LIBRARY, NEEDS_APP } from "../core.js";
import { parseCSV } from "../lib/data.js";
import { parseStrategy } from "../lib/parse.js";
import { summarize, describe } from "../lib/spec.js";
import { localStrategy } from "../lib/builder.js";
import { backtestSpec, neededSymbols } from "../lib/engine.js";
import { drawdownSeries, periodTable } from "../lib/metrics.js";
import { holdout, monteCarlo, score, findParams, gridFor, sweep, walkForward, withParam } from "../lib/lab.js";
import { MARKETS, SYMBOLS, resolveSymbol, nameOf } from "../lib/markets.js";
import { lineChart, barChart, heat } from "../lib/charts.js";

const SERIES = ["--c1", "--c2", "--c3", "--c4", "--c5", "--c6"];
const IDEAS = [
  ["Golden cross", "Buy SPY on a golden cross, sell on a death cross"],
  ["Buy the dip", "Buy QQQ when RSI(2) is below 10, sell when RSI(2) is above 70, 5% stop loss"],
  ["60/40", "60/40 stocks and bonds, rebalanced quarterly"],
  ["Risk parity", "Risk parity SPY, TLT and GLD, rebalanced monthly"],
  ["Momentum rotation", "Each month hold the top 2 of SPY, EFA, EEM, GLD and TLT by 6-month momentum, only if it's positive"],
  ["Long and short", "Buy SPY when the 50-day SMA crosses above the 200-day SMA, short when it crosses below, 15% stop loss"],
  ["Toyota pullback", "Buy Toyota when it drops 10% from its 52-week high and the Nikkei is above its 200-day average, 8% trailing stop"],
  ["Bitcoin trend", "Buy bitcoin when it crosses above its 50 day average, sell when it crosses below, 15% trailing stop"],
];

let csv = null; // { name, symbol, bars } when the user tests on their own file
let parsed = null; // { spec, notes, unparsed } for the rules in the editor
let last = null; // the latest run: { spec, result, data, opts, hold, mc, score }
let runSeq = 0;
let tab = "overview";

const rulesText = () => $("#rules").value;
const nameText = () => $("#strategy-name").value.trim() || "Untitled strategy";
const saveDraft = () => store.set("draft", { name: $("#strategy-name").value, rules: rulesText() });
export const currentStrategy = () => ({ name: nameText(), rules: rulesText() });
export const lastRun = () => last;
const fallbackSymbol = () => (csv ? csv.symbol : resolveSymbol($("#symbol").value.split(",")[0]) || "SPY");

// ---------- composer ----------
function renderChat() {
  $("#history").hidden = !state.chat.length;
  const log = $("#chat-log");
  log.innerHTML = state.chat.map((m) => `<div class="msg ${m.role}">${esc(m.text)}${m.meta ? `<span class="meta">${esc(m.meta)}</span>` : ""}</div>`).join("");
  log.scrollTop = log.scrollHeight;
}
function pushChat(msg) {
  state.chat.push(msg);
  state.chat = state.chat.slice(-40);
  store.set("chat", state.chat);
  renderChat();
}
function reply(html, bad = false) {
  const el = $("#reply");
  el.hidden = !html;
  el.className = `reply${bad ? " bad" : ""}`;
  el.innerHTML = html || "";
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
    if (typeof out.rules !== "string" && out.rules !== null) return localStrategy(prompt, current); // an older server
    // A server that doesn't know the newest rule lines yet drops them; the built-in reader keeps them.
    const local = localStrategy(prompt, current);
    return local.rules && /^(short|cover|weight by|target \d)/im.test(local.rules) && !/^(short|cover|weight by|target \d)/im.test(out.rules || "") ? local : out;
  } catch {
    return localStrategy(prompt, current);
  }
}

async function build(prompt) {
  const btn = $("#chat-send");
  btn.disabled = true;
  btn.textContent = "Reading…";
  pushChat({ role: "user", text: prompt });
  $("#chat-input").value = "";
  const out = await generate(prompt, $("#chat-refine").checked && rulesText().trim());
  btn.disabled = false;
  btn.textContent = "Build";
  if (state.ai && out.source !== "ai") fetchJson("api/status").then((s) => { state.ai = s.ai; emit("status", s); }, () => {});
  const meta = [out.source === "ai" ? "Written by Claude, checked by Ballast's rule reader" : "Read by Ballast's built-in rule reader", out.warning].filter(Boolean).join(" · ");
  if (!out.rules) {
    pushChat({ role: "assistant", text: `I couldn't turn that into rules yet.\n\n${out.explanation}`, meta });
    reply(`<strong>I couldn't turn that into rules yet.</strong> ${esc(out.explanation)}`, true);
    return;
  }
  csv = null;
  loadStrategy(out);
  const notes = out.notes?.length ? ` ${out.notes.join(" ")}` : "";
  pushChat({ role: "assistant", text: `${out.name}\n\n${out.explanation}${notes ? `\n\nNote:${notes}` : ""}`, meta });
  reply(`<strong>${esc(out.name)}.</strong> ${esc(out.explanation)}${notes ? ` <em>${esc(notes.trim())}</em>` : ""}<span class="meta">${esc(meta)}</span>`);
  $("#chat-refine").checked = true;
  run();
}

// ---------- rules ----------
export function loadStrategy({ name, rules }) {
  $("#strategy-name").value = name || "Untitled strategy";
  $("#rules").value = rules || "";
  saveDraft();
  checkRules();
}

// Opens a strategy from the library, a saved one or a shared link, and tests it.
export function openStrategy(s) {
  go("studio");
  if (!s.rules) {
    reply(`<strong>"${esc(s.name)}" was saved as code by an early version of Ballast.</strong> Strategies are plain English now: describe it above and I'll rebuild it.`, true);
    return;
  }
  csv = null;
  $("#chat-refine").checked = true;
  reply("");
  loadStrategy(s);
  run();
}

// Reads the rules as you type and shows how Ballast understood them.
function checkRules() {
  const box = $("#rules-check");
  try {
    const r = parseStrategy(rulesText());
    parsed = r;
    const warn = [...r.notes, ...r.unparsed.map((u) => `Not understood, ignored: "${u}"`)];
    box.className = `rules-check ${warn.length ? "warn" : "ok"}`;
    box.innerHTML = `<strong>${r.spec.kind === "signal" ? (r.spec.shortEntry ? (r.spec.entry ? "Long/short rules" : "Short rules") : "Buy/sell rules") : "Portfolio"}</strong> · ${esc(summarize(r.spec))}${warn.map((w) => `<div>${esc(w)}</div>`).join("")}`;
    syncSymbolField(r.spec);
  } catch (e) {
    parsed = null;
    box.className = "rules-check bad";
    box.textContent = e.message;
  }
}

// The Market field is the asset traded by rules with no "Trade" line; for rules that
// name their own assets it shows them read-only.
function syncSymbolField(spec) {
  const own = spec.kind === "allocate" || spec.symbols?.length;
  const f = $("#symbol");
  if (own && !csv) f.value = spec.symbols.join(", ");
  f.disabled = Boolean(own) || Boolean(csv);
  f.title = own ? "Set by the rules (their Trade, Hold or Rotate line). Edit the rules to change it." : "The asset these rules trade. Type a ticker or a name like Toyota, gold or Nikkei.";
}

// ---------- running a test ----------
function showError(msg) {
  $("#error").hidden = !msg;
  $("#error").textContent = msg || "";
}
function busy(text) {
  $("#loading").hidden = !text;
  if (text) $("#loading-text").textContent = text;
}

export async function run() {
  showError("");
  checkRules();
  if (!parsed) return;
  const seq = ++runSeq;
  const spec = parsed.spec, fallback = fallbackSymbol();
  try {
    busy(settings.source === "sim" ? "Running…" : `Loading ${settings.years === "max" ? "full" : `${settings.years}-year`} history for ${neededSymbols(spec, fallback).join(", ")}…`);
    const data = await loadBars(spec, fallback, settings, csv);
    if (seq !== runSeq) return; // a newer run started while data was loading
    const opts = { fallbackSymbol: fallback, capital: Number(settings.capital) || 10000, costBps: Number(settings.cost) || 0, fx: data.fx, benchmark: data.benchmark };
    const result = backtestSpec(spec, data.bars, opts);
    const hold = holdout(result), mc = monteCarlo(result);
    last = { spec, result, data, opts, hold, mc, score: score(result, hold, mc), name: nameText() };
    busy("");
    $("#data-note").innerHTML = [...data.lines.map(esc), ...data.warnings.map((w) => `<span class="neg">${esc(w)}</span>`)].join("<br>");
    render();
    emit("run", last);
  } catch (err) {
    if (seq !== runSeq) return;
    busy("");
    showError(err.message);
  }
}

const metric = (label, value, cls = "", sub = "") => `<div class="metric"><div class="label">${esc(label)}</div><div class="value ${cls}">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;
const compact = (v) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(Math.abs(v) >= 1e5 ? 0 : 1)}k` : v.toFixed(0));

function render() {
  const { result: r, score: s } = last;
  const m = r.metrics;
  $("#results").hidden = false;

  // score
  const C = 2 * Math.PI * 52;
  const el = $("#score");
  el.className = `card score g-${s.grade}`;
  el.innerHTML = `
    <div class="ring"><svg viewBox="0 0 120 120"><circle class="track" cx="60" cy="60" r="52"/><circle class="arc" cx="60" cy="60" r="52" stroke-dasharray="${C}" stroke-dashoffset="${C}"/></svg>
      <div class="num"><div><b>${s.total}</b><br><span>of 100</span></div></div></div>
    <div class="score-body">
      <h2>${esc(s.word)}</h2>
      <p class="sub">How far to trust this backtest. ${esc(s.headline)}</p>
      <div class="checks">${s.parts.map((p) => `<div class="${p.points < 7 ? "weak" : p.points < 13 ? "mid" : ""}"><span class="name">${esc(p.label)}</span><span class="meter" title="${p.points} of 20"><i style="width:${p.points * 5}%"></i></span><span class="why">${esc(p.text)}</span></div>`).join("")}</div>
    </div>`;
  requestAnimationFrame(() => el.querySelector(".arc")?.setAttribute("stroke-dashoffset", C * (1 - s.total / 100)));

  const bh = r.benchLabel.replace("Buy & hold ", "");
  $("#metrics").innerHTML = [
    metric("Return per year", pct(m.cagr), tone(m.cagr), `${pct(m.benchCagr)} holding ${esc(bh)}`),
    metric("Total return", pct(m.totalReturn, Math.abs(m.totalReturn) >= 1000 ? 0 : 1), tone(m.totalReturn), `${money(m.finalEquity)} from ${money(last.opts.capital)}`),
    metric("Worst drop", pct(m.maxDrawdown), "neg", `${pct(m.benchMaxDrawdown)} holding ${esc(bh)}`),
    metric("Sharpe", num(m.sharpe), tone(m.sharpe), `Sortino ${num(m.sortino)}`),
    metric("Volatility", pct(m.vol), "", `${pct(m.benchVol)} holding ${esc(bh)}`),
    metric("Time invested", pct(m.exposure, 0), "", `${num(m.years, 1)} years tested`),
    r.kind === "signal"
      ? metric("Trades", m.trades, "", m.trades ? `${pct(m.winRate, 0)} won · profit factor ${num(m.profitFactor)}` : "The buy rule never fired")
      : metric("Orders", m.trades, "", `${num(m.trades / Math.max(m.years, 0.1), 1)} a year`),
    metric("Beat buy & hold", `${m.yearsBeatBench} of ${m.yearsCount}`, "", "calendar years"),
  ].join("");

  // Spot rules that fight each other: buy and sell both true, so it churns daily.
  const quick = r.kind === "signal" && r.trades.length >= 30 && r.trades.filter((t) => t.bars <= 1 && t.reason === "signal").length / r.trades.length > 0.5;
  $("#result-note").hidden = !quick;
  $("#result-note").textContent = quick ? "Most trades last a single day: the buy and sell rules are often true at the same time, so the strategy buys and sells again the next day. Try a sell rule that can't overlap the buy rule (sell when price crosses above the 50-day SMA, rather than is above it)." : "";
  $("#tab-trades-btn").textContent = r.kind === "signal" ? `Trades (${r.trades.length})` : `Orders (${r.orders.length})`;
  fillSweepControls();
  $("#sweep-out").innerHTML = $("#wf-out").innerHTML = "";
  renderTab();
}

function renderTab() {
  if (!last || !showing("studio")) return;
  ({ overview: renderOverview, robust: renderRobust, returns: renderReturns, trades: renderTrades, today: renderToday })[tab]();
}

function renderOverview() {
  const { result: r, hold } = last;
  const t = r.time.slice(r.startIndex);
  const from = (a) => Array.from(a).slice(r.startIndex);
  $("#equity-legend").innerHTML = `<span><i style="background:var(--c1)"></i>${esc(last.name)}</span><span><i class="dash" style="background:var(--quiet)"></i>${esc(r.benchLabel)}</span>`;
  lineChart($("#equity-chart"), {
    series: [
      { time: t, values: from(r.equity), color: "--c1", label: "Strategy", width: 2, fill: true, fillAlpha: 0.08 },
      { time: t, values: from(r.bench), color: "--quiet", label: r.benchLabel.replace("Buy & hold", "Hold"), width: 1.2, dash: [4, 3] },
    ],
    lines: [{ time: hold.splitTime, label: "last 30%" }],
    format: compact,
  });
  lineChart($("#dd-chart"), {
    series: [
      { time: t, values: from(drawdownSeries(r.equity, r.startIndex)), color: "--down", label: "Strategy", width: 1.4, fill: true, fillAlpha: 0.18 },
      { time: t, values: from(drawdownSeries(r.bench, r.startIndex)), color: "--quiet", label: "Hold", width: 1, dash: [4, 3] },
    ],
    base: 0, max: 0, log: false, format: (v) => `${v.toFixed(0)}%`,
  });
  if (r.kind === "signal") {
    const sym = r.traded[0];
    $("#second-title").textContent = r.traded.length > 1 ? `${sym} price & trades (first of ${r.traded.length})` : `${sym} price & trades`;
    const shorts = r.trades.some((x) => x.side === "short");
    $("#second-legend").innerHTML = `<span><i style="background:var(--up)"></i>Buy</span><span><i style="background:var(--down)"></i>Sell</span>${shorts ? `<span><i style="background:var(--c2)"></i>Short / cover</span>` : ""}`;
    const markers = r.trades.filter((x) => x.symbol === sym).flatMap((x) => [
      { time: x.entryTime, value: r.prices[sym][x.entryIndex], type: x.side === "short" ? "short" : "buy" },
      ...(x.reason === "end of data" ? [] : [{ time: x.exitTime, value: r.prices[sym][x.exitIndex], type: x.side === "short" ? "cover" : "sell" }]),
    ]);
    lineChart($("#price-chart"), { series: [{ time: r.time, values: r.prices[sym], color: "--text", label: sym, width: 1.2 }], markers, format: price });
  } else {
    $("#second-title").textContent = "What it held (% of the portfolio)";
    const syms = Object.keys(r.weightHistory);
    $("#second-legend").innerHTML = syms.map((s, k) => `<span><i style="background:var(${SERIES[k % 6]})"></i>${esc(s)}</span>`).join("");
    lineChart($("#price-chart"), {
      series: syms.map((s, k) => ({ time: t, values: from(r.weightHistory[s]), color: SERIES[k % 6], label: s, width: 1.3 })),
      min: 0, log: false, format: (v) => `${v.toFixed(0)}%`,
    });
  }
}

function renderRobust() {
  const { result: r, hold: h, mc } = last;
  const row = (label, f) => {
    const a = f(h.early), b = f(h.late), ba = f(h.benchEarly), bb = f(h.benchLate);
    return `<tr><td>${label}</td><td class="num">${a}</td><td class="num">${b}</td><td class="num note">${ba}</td><td class="num note">${bb}</td></tr>`;
  };
  $("#holdout").innerHTML = `<thead><tr><th></th><th class="num">${day(r.time[r.startIndex])} to ${day(h.splitTime)}</th><th class="num">${day(h.splitTime)} to ${day(r.time.at(-1))}</th><th class="num">Hold, first part</th><th class="num">Hold, last part</th></tr></thead><tbody>
    ${row("Return per year", (x) => pct(x.cagr))}${row("Sharpe", (x) => num(x.sharpe))}${row("Worst drop", (x) => pct(x.maxDrawdown))}${row("Volatility", (x) => pct(x.vol))}</tbody>`;

  if (!mc) {
    $("#mc-stats").innerHTML = `<p class="note">Not enough history to reshuffle.</p>`;
    $("#mc-legend").innerHTML = "";
  } else {
    const start = r.equity[r.startIndex], t = mc.index.map((i) => r.time[i]);
    const scale = (a) => Array.from(a, (v) => v * start);
    $("#mc-legend").innerHTML = `<span><i style="background:var(--c1)"></i>What happened</span><span><i class="dash" style="background:var(--c2)"></i>Typical reshuffle</span><span><i style="background:var(--c2);opacity:.3"></i>9 in 10 / half of them</span>`;
    lineChart($("#mc-chart"), {
      bands: [{ time: t, lo: scale(mc.bands[0]), hi: scale(mc.bands[4]), color: "--c2", alpha: 0.13 }, { time: t, lo: scale(mc.bands[1]), hi: scale(mc.bands[3]), color: "--c2", alpha: 0.2 }],
      series: [
        { time: r.time.slice(r.startIndex), values: r.equity.slice(r.startIndex), color: "--c1", label: "What happened", width: 2 },
        { time: t, values: scale(mc.bands[2]), color: "--c2", label: "Typical reshuffle", width: 1.3, dash: [4, 3] },
      ],
      format: compact,
    });
    $("#mc-stats").innerHTML = [
      metric("Typical, per year", pct(mc.cagr.p50), tone(mc.cagr.p50)),
      metric("Unlucky, per year", pct(mc.cagr.p5), tone(mc.cagr.p5), "1 history in 20"),
      metric("Lucky, per year", pct(mc.cagr.p95), tone(mc.cagr.p95), "1 history in 20"),
      metric("Typical worst drop", pct(mc.maxDrawdown.p50), "neg"),
      metric("Unlucky worst drop", pct(mc.maxDrawdown.p5), "neg", "1 in 20"),
      metric("Chance of a loss", pct(mc.probLoss, 0), "", `over ${num(mc.years, 1)} years`),
      metric("Chance of beating hold", pct(mc.probBeat, 0)),
    ].join("");
  }
}

// ---------- sensitivity ----------
let params = [];
function fillSweepControls() {
  params = findParams(last.spec);
  const opt = (p, k) => `<option value="${k}">${esc(p.label)}</option>`;
  $("#sweep-a").innerHTML = params.map(opt).join("") || `<option value="">Nothing to vary</option>`;
  $("#sweep-b").innerHTML = `<option value="">nothing else</option>${params.map(opt).join("")}`;
  if (params.length > 1) $("#sweep-b").value = "1";
  $("#sweep-run").disabled = $("#wf-run").disabled = !params.length;
}
const showValue = (p, v) => (p.kind === "pct" ? `${+(v * 100).toFixed(1)}%` : String(v));
const METRIC = { sharpe: ["Sharpe", (v) => num(v), 1.5], cagr: ["Return per year", (v) => pct(v), 20], maxDrawdown: ["Worst drop", (v) => pct(v, 0), 60] };

async function runSweep() {
  const a = params[$("#sweep-a").value], b = params[$("#sweep-b").value];
  if (!a) return;
  const pb = b && b !== a ? b : null;
  const out = $("#sweep-out"), cur = last;
  out.innerHTML = `<div class="progress"><i></i></div>`;
  $("#sweep-run").disabled = true;
  try {
    const steps = pb ? 7 : 11;
    const sw = await sweep(cur.spec, cur.data.bars, cur.opts, { param: a, values: gridFor(a, steps, cur.spec) }, pb ? { param: pb, values: gridFor(pb, steps, cur.spec) } : null,
      { onProgress: (f) => { const bar = out.querySelector(".progress i"); if (bar) bar.style.width = `${f * 100}%`; } });
    if (cur !== last) return;
    const key = $("#sweep-metric").value, [label, fmt, scale] = METRIC[key];
    const centre = key === "maxDrawdown" ? -30 : 0; // drawdowns are always negative: shade around -30%
    const td = (c, x, y, here) => (c
      ? `<td class="cell num${here ? " here" : ""}" style="${heat(c[key] - centre, scale)}" data-a="${x}" data-b="${y ?? ""}" title="${esc(a.label)} ${showValue(a, x)}${pb ? `, ${esc(pb.label)} ${showValue(pb, y)}` : ""}: ${pct(c.cagr)} a year, Sharpe ${num(c.sharpe)}, worst drop ${pct(c.maxDrawdown, 0)}, ${c.trades} trades. Click to use.">${fmt(c[key])}</td>`
      : `<td class="cell num note">–</td>`);
    const head = `<tr><th class="axis">${pb ? `${esc(pb.label)} ↓ &nbsp; ${esc(a.label)} →` : esc(a.label)}</th>${sw.a.values.map((v) => `<th>${showValue(a, v)}</th>`).join("")}</tr>`;
    const body = sw.grid.map((rowCells, j) => `<tr><th class="axis">${pb ? showValue(pb, sw.b.values[j]) : label}</th>${rowCells.map((c, i) => td(c, sw.a.values[i], pb ? sw.b.values[j] : null, i === sw.a.at && (!pb || j === sw.b.at))).join("")}</tr>`).join("");
    const share = Math.round(sw.stability * 100), rank = sw.rank == null ? null : Math.round(sw.rank * 100);
    const read = share >= 75 ? "Most nearby settings work too, so the result doesn't hang on these exact numbers."
      : share >= 40 ? "It works across part of the grid. Prefer settings surrounded by other good ones over a lone bright cell."
      : "Few nearby settings work. The result looks tuned to these exact numbers.";
    const lucky = rank != null && rank >= 90 && share < 75 ? " Your setting is near the very top of the grid, which is what a lucky pick looks like." : "";
    out.innerHTML = `<p class="verdict"><strong>${share}% of the grid makes money with a positive Sharpe.</strong> ${read}${lucky}</p>
      <div class="table-wrap"><table class="heat">${head}${body}</table></div>
      <p class="note" style="margin-top:8px">${label} for each setting; yours is outlined. Click a cell to use those numbers.</p>`;
    out.querySelector("table").onclick = (e) => {
      const c = e.target.closest("td[data-a]");
      if (!c) return;
      let s = withParam(cur.spec, a, Number(c.dataset.a));
      if (pb) s = withParam(s, pb, Number(c.dataset.b));
      $("#rules").value = describe(s);
      saveDraft();
      run2();
    };
  } catch (err) {
    out.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  } finally {
    $("#sweep-run").disabled = false;
  }
}
const run2 = () => { run(); toast("Rules updated"); };

async function runWalkForward() {
  const a = params[$("#sweep-a").value];
  if (!a) return;
  const out = $("#wf-out"), runNow = last;
  out.innerHTML = `<div class="progress"><i></i></div>`;
  $("#wf-run").disabled = true;
  try {
    const wf = await walkForward(runNow.spec, runNow.data.bars, runNow.opts, a, gridFor(a, 7, runNow.spec),
      { onProgress: (f) => { const bar = out.querySelector(".progress i"); if (bar) bar.style.width = `${f * 100}%`; } });
    if (runNow !== last) return;
    const keep = wf.same.sharpe > 0.1 ? wf.out.sharpe / wf.same.sharpe : null;
    const read = wf.out.cagr > wf.bench.cagr && wf.out.sharpe > wf.bench.sharpe ? "Tuned only on the past, it still beat buy & hold on years it had never seen. That is the strongest evidence a backtest can give."
      : wf.out.sharpe > 0.3 ? "It made money on years it had never seen, but not more than buy & hold for the risk."
      : "Tuned on the past, it did poorly on the years that followed. Treat the headline result with suspicion.";
    out.innerHTML = `<h4 style="margin-top:18px">Walk-forward: ${esc(wf.param)}</h4>
      <p class="verdict"><strong>${pct(wf.out.cagr)} a year, Sharpe ${num(wf.out.sharpe)}, out of sample.</strong> ${read}${keep != null && keep < 0.5 ? " Much of the original result came from knowing the best setting in advance." : ""}</p>
      <div class="table-wrap"><table><thead><tr><th>Test window</th><th class="num">Setting picked from earlier data</th><th class="num">Result in the window</th></tr></thead><tbody>
      ${wf.picks.map((p) => `<tr><td>${day(p.from)} to ${day(p.to)}</td><td class="num">${showValue(a, p.value)}</td><td class="num ${tone(p.testReturn)}">${signed(p.testReturn)}</td></tr>`).join("")}</tbody></table></div>
      <div class="metrics compact">${[
        metric("Walk-forward", pct(wf.out.cagr), tone(wf.out.cagr), `Sharpe ${num(wf.out.sharpe)} · drop ${pct(wf.out.maxDrawdown, 0)}`),
        metric("Your setting, same years", pct(wf.same.cagr), tone(wf.same.cagr), `Sharpe ${num(wf.same.sharpe)} · drop ${pct(wf.same.maxDrawdown, 0)}`),
        metric("Buy & hold, same years", pct(wf.bench.cagr), tone(wf.bench.cagr), `Sharpe ${num(wf.bench.sharpe)} · drop ${pct(wf.bench.maxDrawdown, 0)}`),
      ].join("")}</div>`;
  } catch (err) {
    out.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  } finally {
    $("#wf-run").disabled = false;
  }
}

// ---------- returns ----------
function renderReturns() {
  const { result: r } = last, m = r.metrics;
  const rows = periodTable(r.time, r.equity, r.startIndex), bench = periodTable(r.time, r.bench, r.startIndex);
  $("#years-legend").innerHTML = `<span><i style="background:var(--c1)"></i>${esc(last.name)}</span><span><i style="background:var(--quiet)"></i>${esc(r.benchLabel)}</span>`;
  barChart($("#years-chart"), {
    labels: rows.map((y) => String(y.year)),
    groups: [{ label: "Strategy", color: "--c1", values: rows.map((y) => y.total) }, { label: "Hold", color: "--quiet", values: bench.map((y) => y.total) }],
  });
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  $("#months").innerHTML = `<thead><tr><th class="axis">Year</th>${M.map((x) => `<th>${x}</th>`).join("")}<th>Year</th></tr></thead><tbody>${[...rows].reverse().map((y) =>
    `<tr><th class="axis">${y.year}</th>${y.months.map((v) => (v == null ? `<td class="cell"></td>` : `<td class="cell" style="${heat(v, 8)}">${v.toFixed(1)}</td>`)).join("")}<td class="cell" style="${heat(y.total, 25)}"><strong>${y.total.toFixed(1)}</strong></td></tr>`).join("")}</tbody>`;
  $("#detail-metrics").innerHTML = [
    metric("Best year", signed(m.bestYear), tone(m.bestYear)), metric("Worst year", signed(m.worstYear), tone(m.worstYear)),
    metric("Winning months", pct(m.positiveMonths, 0)), metric("Winning years", pct(m.positiveYears, 0)),
    metric("Longest time underwater", `${Math.round(m.longestDrawdownDays / 30.4)} mo`, "", `deepest ${day(m.ddPeakTime)} to ${day(m.ddTroughTime)}`),
    metric("Return ÷ worst drop", num(m.calmar), "", "Calmar ratio"),
    metric("Moves with the benchmark", num(m.beta), "", `beta · correlation ${num(m.corr)}`),
    metric("Return beyond the benchmark", signed(m.alpha), tone(m.alpha), "alpha, per year"),
    ...(r.kind === "signal" && m.trades ? [
      metric("Average trade", signed(m.avgTrade, 2), tone(m.avgTrade), `${num(m.avgBars, 0)} days held`),
      metric("Average win / loss", `${signed(m.avgWin, 1)} / ${signed(m.avgLoss, 1)}`),
      metric("Best / worst trade", `${signed(m.bestTrade, 0)} / ${signed(m.worstTrade, 0)}`),
      ...(m.shortTrades ? [metric("Long / short trades", `${m.longTrades} / ${m.shortTrades}`)] : []),
    ] : []),
  ].join("");
}

// ---------- trades ----------
function renderTrades() {
  const { result: r } = last;
  if (r.kind === "signal") {
    $("#trades-title").textContent = "Trades";
    const multi = r.traded.length > 1, sides = r.trades.some((t) => t.side === "short");
    const rows = r.trades.slice(-1000).reverse();
    $("#trades").innerHTML = `<thead><tr>${multi ? "<th>Symbol</th>" : ""}${sides ? "<th>Side</th>" : ""}<th>Bought</th><th class="num">At</th><th>Sold</th><th class="num">At</th><th class="num">Days</th><th class="num">Profit</th><th class="num">Return</th><th>Why it closed</th></tr></thead><tbody>${
      rows.length
        ? rows.map((t) => `<tr>${multi ? `<td>${esc(t.symbol)}</td>` : ""}${sides ? `<td>${t.side}</td>` : ""}<td>${day(t.entryTime)}</td><td class="num">${price(t.entryPrice)}</td><td>${day(t.exitTime)}</td><td class="num">${price(t.exitPrice)}</td><td class="num">${t.bars}</td><td class="num ${tone(t.pnl)}">${money(t.pnl)}</td><td class="num ${tone(t.returnPct)}">${signed(t.returnPct, 2)}</td><td>${t.reason === "end of data" ? "still open" : t.reason}</td></tr>`).join("")
        : `<tr><td colspan="10" class="empty">No trades. The rules never fired on this data.</td></tr>`
    }</tbody>${r.trades.length > rows.length ? `<caption class="note">Showing the latest ${rows.length} of ${r.trades.length}. Export CSV for all.</caption>` : ""}`;
  } else {
    $("#trades-title").textContent = "Rebalancing orders";
    const rows = r.orders.slice(-600).reverse();
    $("#trades").innerHTML = `<thead><tr><th>Date</th><th>Symbol</th><th>Side</th><th class="num">Shares</th><th class="num">Price</th><th class="num">Value</th></tr></thead><tbody>${
      rows.length
        ? rows.map((o) => `<tr><td>${day(o.time)}</td><td>${esc(o.symbol)}</td><td class="${o.side === "buy" ? "pos" : "neg"}">${o.side}</td><td class="num">${o.shares.toFixed(4)}</td><td class="num">${price(o.price)}</td><td class="num">${money(o.value)}</td></tr>`).join("")
        : `<tr><td colspan="6" class="empty">No orders. The portfolio never had enough history to start.</td></tr>`
    }</tbody>${r.orders.length > rows.length ? `<caption class="note">Showing the latest ${rows.length} of ${r.orders.length}. Export CSV for all.</caption>` : ""}`;
  }
}

function exportTrades() {
  if (!last) return;
  const r = last.result;
  const rows = r.kind === "signal"
    ? [["symbol", "side", "entry_date", "entry_price", "exit_date", "exit_price", "shares", "pnl", "return_pct", "reason"],
      ...r.trades.map((t) => [t.symbol, t.side, day(t.entryTime), t.entryPrice.toFixed(4), day(t.exitTime), t.exitPrice.toFixed(4), t.shares.toFixed(4), t.pnl.toFixed(2), t.returnPct.toFixed(3), t.reason])]
    : [["date", "symbol", "side", "shares", "price", "value"], ...r.orders.map((o) => [day(o.time), o.symbol, o.side, o.shares.toFixed(6), o.price.toFixed(4), o.value.toFixed(2)])];
  downloadCsv(`${nameText().replace(/\W+/g, "_")}_${r.kind === "signal" ? "trades" : "orders"}.csv`, rows);
}

// ---------- today ----------
const VERB = { buy: "Buy", sell: "Sell", short: "Short", cover: "Cover", hold: "Hold", wait: "Wait", "cover and buy": "Cover and buy", "sell and short": "Sell and short" };
function renderToday() {
  const { result: r } = last, now = r.now;
  const el = $("#today");
  const head = `<h3>What the rules say now</h3><p class="note">Read from the close on ${day(now.asOf)}. Orders would go in at the next open. This is the test portfolio's view, not advice.</p>`;
  if (r.kind === "signal") {
    el.innerHTML = `${head}<div class="today-grid">${now.actions.map((a) => {
      const act = a.action !== "hold" && a.action !== "wait";
      const rowsHtml = [
        ["Position", a.held === "flat" ? "None" : `${a.held === "long" ? "Long" : "Short"} since ${day(a.entryTime)} at ${price(a.entryPrice)}`],
        ["Last price", price(a.price)],
        a.stops?.stop && ["Stop loss", price(a.stops.stop)], a.stops?.trail && ["Trailing stop", price(a.stops.trail)], a.stops?.target && ["Take profit", price(a.stops.target)],
        a.reason && ["Because", a.reason === "signal" ? "exit rule is true" : a.reason],
      ].filter(Boolean).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");
      return `<div class="today-card"><div class="note">${esc(a.symbol)} · ${esc(nameOf(a.symbol))}</div><div class="do ${act ? "act" : ""}">${VERB[a.action]}</div><dl>${rowsHtml}</dl></div>`;
    }).join("")}</div>`;
  } else {
    const ready = now.targets.some((t) => t.target != null);
    el.innerHTML = `${head}${now.riskOff ? `<p class="callout">The risk-off rule is on, so it holds its fallback.</p>` : ""}
      <div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>Asset</th><th class="num">Target now</th><th class="num">Test portfolio holds</th><th class="num">Last price</th></tr></thead><tbody>
      ${now.targets.map((t) => `<tr><td><strong>${esc(t.symbol)}</strong> <span class="note">${esc(nameOf(t.symbol) === t.symbol ? "" : nameOf(t.symbol))}</span></td><td class="num">${t.target == null ? "–" : pct(t.target)}</td><td class="num">${pct(t.current)}</td><td class="num">${price(t.price)}</td></tr>`).join("")}
      <tr><td>Cash</td><td class="num">${now.cashTarget == null ? "–" : pct(now.cashTarget)}</td><td class="num">${pct(Math.max(0, 100 - now.targets.reduce((a, t) => a + t.current, 0)))}</td><td></td></tr></tbody></table></div>
      <div class="row wrap" style="margin-top:14px"><button class="btn primary" type="button" id="today-to-portfolio" ${ready ? "" : "disabled"}>Use these targets in Portfolio</button><span class="note">Copies today's targets into the rebalancer; your share counts stay as they are.</span></div>`;
    $("#today-to-portfolio").onclick = () => emit("targets", now.targets.filter((t) => t.target > 0.05).map((t) => ({ symbol: t.symbol, target: Math.round(t.target * 10) / 10 })));
  }
}

// ---------- market browser ----------
let browserGroup = MARKETS[0].group;
function renderMarkets(quotes = {}) {
  const g = MARKETS.find((x) => x.group === browserGroup);
  $("#market-tabs").innerHTML = MARKETS.map((x) => `<button type="button" class="chip ${x.group === browserGroup ? "active" : ""}" data-market-group="${esc(x.group)}">${esc(x.group)}</button>`).join("");
  $("#market-note").textContent = `${g.note[0].toUpperCase()}${g.note.slice(1)}. ${state.server ? "Live quotes." : `${NEEDS_APP}.`}`;
  $("#market-list").innerHTML = `<thead><tr><th>Symbol</th><th>Name</th><th class="num">Last</th><th class="num">Today</th><th></th></tr></thead><tbody>${g.items.map(([s, name]) => {
    const q = quotes[s];
    return `<tr><td><strong>${esc(s)}</strong></td><td>${esc(name)}</td><td class="num">${q ? price(q.price) : `<span class="note">…</span>`}</td><td class="num ${q ? tone(q.changePct) : ""}">${q ? signed(q.changePct, 2) : ""}</td><td><span class="row"><button type="button" class="btn small primary" data-use-symbol="${esc(s)}">Use</button><button type="button" class="btn small" data-watch-symbol="${esc(s)}">Watch</button></span></td></tr>`;
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

// Points the strategy at a symbol: rewrites the Trade line when the rules have one.
function useSymbol(s) {
  $("#markets").close();
  if (parsed?.spec.kind === "allocate") {
    reply(`<strong>This is a portfolio</strong>, so its assets come from its Hold or Rotate line. Edit that line to add ${esc(s)} (${esc(nameOf(s))}).`);
    return;
  }
  if (parsed?.spec.kind === "signal" && parsed.spec.symbols.length) $("#rules").value = describe({ ...parsed.spec, symbols: [s] });
  csv = null;
  $("#symbol").value = s;
  saveDraft();
  run();
}

// ---------- share links ----------
const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
function sharedStrategy() {
  const m = location.hash.match(/[#&]s=([\w-]+)/);
  if (!m) return null;
  try {
    const { n, r } = JSON.parse(unb64(m[1]));
    if (typeof r !== "string" || r.length > 20000) return null;
    parseStrategy(r); // only open links that hold readable rules
    history.replaceState(null, "", location.pathname + location.search);
    return { name: String(n || "Shared strategy").slice(0, 120), rules: r };
  } catch { return null; }
}

// ---------- wiring ----------
export function initStudio() {
  $("#ideas").innerHTML = IDEAS.map(([label], k) => `<button type="button" class="chip" data-idea="${k}">${esc(label)}</button>`).join("");
  $("#symbol-hints").innerHTML = [...SYMBOLS.values()].map((x) => `<option value="${esc(x.symbol)}">${esc(x.name)}</option>`).join("");

  $("#chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const prompt = $("#chat-input").value.trim();
    if (prompt) build(prompt);
  });
  $("#chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $("#chat-form").requestSubmit(); }
  });
  $("#ideas").addEventListener("click", (e) => {
    const b = e.target.closest("[data-idea]");
    if (!b) return;
    $("#chat-refine").checked = false;
    build(IDEAS[b.dataset.idea][1]);
  });
  $("#chat-clear").addEventListener("click", () => { state.chat = []; store.set("chat", []); renderChat(); reply(""); });

  let timer = null;
  $("#rules").addEventListener("input", () => { saveDraft(); clearTimeout(timer); timer = setTimeout(checkRules, 250); });
  $("#rules").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(); }
  });
  $("#strategy-name").addEventListener("input", saveDraft);
  $("#run").addEventListener("click", run);

  // test settings
  const bind = (id, key, read = (el) => el.value) => {
    const el = $(id);
    if (el.type === "checkbox") el.checked = Boolean(settings[key]); else el.value = settings[key];
    el.addEventListener("change", () => { settings[key] = read(el); saveSettings(); run(); });
  };
  bind("#history-years", "years");
  bind("#capital", "capital", (el) => Math.max(100, Number(el.value) || 10000));
  bind("#cost", "cost", (el) => Math.max(0, Number(el.value) || 0));
  bind("#benchmark", "benchmark", (el) => (el.value = resolveSymbol(el.value) || ""));
  bind("#currency", "currency");
  bind("#data-source", "source");
  bind("#dividends", "dividends", (el) => el.checked);
  $("#symbol").addEventListener("change", () => {
    const s = resolveSymbol($("#symbol").value);
    if (s) $("#symbol").value = s;
    run();
  });
  $("#csv").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const symbol = file.name.replace(/\.csv$/i, "").toUpperCase().replace(/[^A-Z0-9.\-^=]/g, "").slice(0, 12) || "CSV";
      csv = { name: file.name, symbol, bars: parseCSV(await file.text()) };
      $("#symbol").value = symbol;
      run();
    } catch (err) { showError(err.message); }
  });

  // result tabs
  $("#result-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (!b) return;
    tab = b.dataset.tab;
    $$("#result-tabs button").forEach((x) => x.classList.toggle("active", x === b));
    $$(".panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${tab}`));
    renderTab();
  });
  $("#sweep-run").addEventListener("click", runSweep);
  $("#wf-run").addEventListener("click", runWalkForward);
  $("#export-trades").addEventListener("click", exportTrades);

  // save, paper trade, share
  $("#save-strategy").addEventListener("click", () => {
    checkRules();
    if (!parsed) return showError("Fix the rules before saving them.");
    const name = nameText();
    const existing = state.saved.find((s) => s.name === name);
    if (existing) { existing.rules = rulesText(); delete existing.code; }
    else state.saved.push({ id: crypto.randomUUID(), name, rules: rulesText(), created: Date.now() });
    store.set("saved", state.saved);
    emit("saved");
    toast(existing ? "Saved over the earlier version" : "Saved to your library");
  });
  $("#deploy-strategy").addEventListener("click", () => {
    checkRules();
    if (!parsed) return showError("Fix the rules before paper trading them.");
    if (parsed.spec.kind !== "signal") return showError("Paper trading runs buy/sell rules. For a portfolio, open Today and send its targets to Portfolio.");
    emit("deploy", { name: nameText(), rules: rulesText(), spec: parsed.spec, symbol: csv ? "SPY" : (parsed.spec.symbols[0] || fallbackSymbol()), mode: csv ? "live" : settings.source });
  });
  $("#share-strategy").addEventListener("click", () => {
    checkRules();
    if (!parsed) return showError("Fix the rules before sharing them.");
    copyText(`${location.origin}${location.pathname}#s=${b64(JSON.stringify({ n: nameText(), r: rulesText() }))}`, "Link copied");
  });

  // markets
  $("#browse-markets").addEventListener("click", () => { $("#markets").showModal(); loadMarketQuotes(); });
  $("#markets-close").addEventListener("click", () => $("#markets").close());
  $("#market-search").addEventListener("submit", (e) => {
    e.preventDefault();
    const s = resolveSymbol($("#market-query").value);
    if (s) useSymbol(s);
  });
  $("#markets").addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.marketGroup) { browserGroup = t.dataset.marketGroup; loadMarketQuotes(); }
    if (t.dataset.useSymbol) useSymbol(t.dataset.useSymbol);
    if (t.dataset.watchSymbol) { emit("watch", t.dataset.watchSymbol); t.textContent = "Watching"; }
  });

  on("show", (v) => v === "studio" && renderTab());
  on("chat", renderChat);
}

// First load: a shared link, then the draft from last time, then a starter.
export function startStudio() {
  // The website without a server can only load real prices for crypto, so open on a real series there.
  if (!state.server && $("#symbol").value === "SPY") $("#symbol").value = "BTC-USD";
  const shared = sharedStrategy();
  const draft = store.get("draft", null);
  renderChat();
  if (shared) { loadStrategy(shared); toast("Opened a shared strategy"); }
  else loadStrategy(draft?.rules ? draft : state.server ? LIBRARY[0] : LIBRARY.find((x) => x.tag === "Crypto"));
  if (draft?.rules || shared) $("#chat-refine").checked = true;
  run();
}
