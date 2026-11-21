// The research lab: tools that test whether a backtest result can be trusted.
//
//   holdout()       how the second part of history compares with the first
//   monteCarlo()    reshuffles the strategy's own daily returns into alternate histories
//   findParams()    the numbers in a strategy that could be tuned
//   sweep()         re-runs the strategy across a grid of one or two of those numbers
//   walkForward()   tunes on the past, trades the next stretch, repeats: a true out-of-sample test
//   score()         one 0-100 robustness grade with the reasons behind it

import { backtestSpec } from "./engine.js";
import { curveStats, dailyReturns } from "./metrics.js";
import { rng } from "./data.js";

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (v, a, b) => clamp((v - a) / (b - a), 0, 1);
const pause = () => new Promise((r) => setTimeout(r, 0));

// ---------- first part vs last part ----------
export function holdout(result, split = 0.7) {
  const { time, equity, bench, startIndex: s0 = 0 } = result;
  const n = time.length;
  const cut = Math.min(n - 2, Math.max(s0 + 1, s0 + Math.floor((n - 1 - s0) * split)));
  return {
    splitTime: time[cut], splitIndex: cut,
    early: curveStats(time, equity, s0, cut), late: curveStats(time, equity, cut, n - 1),
    benchEarly: curveStats(time, bench, s0, cut), benchLate: curveStats(time, bench, cut, n - 1),
  };
}

// ---------- Monte Carlo ----------
// Block bootstrap: stitches random multi-week blocks of the strategy's real daily
// returns into new histories, which keeps streaks and volatility clusters intact.
// The benchmark is resampled with the same blocks so the two stay comparable.
export function monteCarlo(result, { runs = 500, block = 21, points = 80, seed = 7 } = {}) {
  const s0 = result.startIndex || 0;
  const rs = dailyReturns(result.equity, s0), rb = dailyReturns(result.bench, s0);
  const n = rs.length;
  if (n < block * 4) return null;
  const years = (result.time.at(-1) - result.time[s0]) / (365.25 * 864e5);
  const rand = rng(seed);
  const step = Math.max(1, Math.floor(n / points));
  const marks = [];
  for (let i = step - 1; i < n; i += step) marks.push(i);
  if (marks.at(-1) !== n - 1) marks.push(n - 1);
  const paths = marks.map(() => new Float64Array(runs));
  const finals = new Float64Array(runs), dds = new Float64Array(runs);
  let beat = 0, loss = 0;
  for (let r = 0; r < runs; r++) {
    let v = 1, b = 1, peak = 1, dd = 0, k = 0, m = 0;
    while (k < n) {
      const at = Math.floor(rand() * n);
      for (let j = 0; j < block && k < n; j++, k++) {
        const i = (at + j) % n;
        v *= 1 + rs[i]; b *= 1 + rb[i];
        if (v > peak) peak = v;
        dd = Math.min(dd, v / peak - 1);
        if (k === marks[m]) paths[m++][r] = v;
      }
    }
    finals[r] = v; dds[r] = dd * 100;
    if (v > b * 1.001) beat++;
    if (v < 1) loss++;
  }
  const pct = (arr, p) => { const a = Float64Array.from(arr).sort(); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };
  const cagr = (mult) => (years > 0 && mult > 0 ? (Math.pow(mult, 1 / years) - 1) * 100 : -100);
  const P = [0.05, 0.25, 0.5, 0.75, 0.95];
  return {
    runs, years,
    index: marks.map((i) => s0 + 1 + i),
    bands: P.map((p) => paths.map((a) => pct(a, p))),
    cagr: Object.fromEntries(P.map((p) => [`p${p * 100}`, cagr(pct(finals, p))])),
    maxDrawdown: Object.fromEntries(P.map((p) => [`p${p * 100}`, pct(dds, p)])), // p5 = the deep end
    probLoss: (loss / runs) * 100, probBeat: (beat / runs) * 100,
  };
}

// ---------- tunable numbers ----------
const CONDS = [["entry", "buy rule"], ["exit", "sell rule"], ["shortEntry", "short rule"], ["shortExit", "cover rule"]];
const IND_NAME = { sma: "SMA", ema: "EMA", rsi: "RSI", atr: "ATR", ret: "return", hi: "high", lo: "low", bbu: "Bollinger", bbm: "Bollinger", bbl: "Bollinger", macd: "MACD fast", macds: "MACD fast", macdh: "MACD fast", avgvol: "average volume", dd: "drawdown", vol: "volatility" };

// Returns [{ id, label, value, kind: "days"|"level"|"pct", paths: [[...keys]] }]. A number that
// appears in several places (the same average in the buy and the sell rule) is one entry.
export function findParams(spec) {
  const found = new Map();
  const add = (id, label, value, kind, path) => {
    if (!found.has(id)) found.set(id, { id, label, value, kind, paths: [] });
    found.get(id).paths.push(path);
  };
  const walk = (x, path, where) => {
    if (!x || typeof x !== "object") return;
    if (x.t === "ind" && x.n >= 2) add(`ind:${x.ind}:${x.n}:${x.sym || ""}`, `${x.n}-day ${IND_NAME[x.ind] || x.ind}${x.sym ? ` of ${x.sym}` : ""}`, x.n, "days", [...path, "n"]);
    if (x.t === "cmp" || x.t === "cross") {
      for (const side of ["a", "b"]) {
        const o = side === "a" ? x.b : x.a;
        if (x[side]?.t !== "num" || x[side].v === 0 || !(o?.t === "ind" || o?.t === "price")) continue;
        const what = o.t === "ind" ? IND_NAME[o.ind] || o.ind : `${o.sym ? `${o.sym} ` : ""}price`;
        add(`lvl:${JSON.stringify(o)}:${x[side].v}:${where}`, `${what} level ${x[side].v} (${where})`, x[side].v, "level", [...path, side, "v"]);
      }
    }
    if (x.t === "pct") add(`pct:${x.p}:${where}`, `${Math.abs(x.p)}% distance (${where})`, x.p, "level", [...path, "p"]);
    for (const [k, v] of Object.entries(x)) if (v && typeof v === "object") walk(v, [...path, k], where);
  };
  for (const [k, where] of CONDS) walk(spec[k], [k], where);
  walk(spec.riskOff?.when, ["riskOff", "when"], "risk-off rule");
  walk(spec.rotate?.by, ["rotate", "by"], "ranking");
  for (const [k, label] of [["stopLoss", "Stop loss"], ["takeProfit", "Take profit"], ["trailingStop", "Trailing stop"], ["band", "Drift band"], ["volTarget", "Volatility target"]]) {
    if (spec[k]) add(k, `${label} %`, spec[k], "pct", [k]);
  }
  if (spec.maxHold) add("maxHold", "Time limit (days)", spec.maxHold, "days", ["maxHold"]);
  if (spec.rotate && spec.symbols.length > 2) add("top", "Assets held", spec.rotate.top, "count", ["rotate", "top"]);
  return [...found.values()];
}

export function withParam(spec, param, value) {
  const out = structuredClone(spec);
  for (const path of param.paths) {
    let o = out;
    for (const k of path.slice(0, -1)) o = o[k];
    o[path.at(-1)] = value;
  }
  return out;
}

// A sensible grid around a parameter's current value.
export function gridFor(param, steps = 9, spec) {
  const v = param.value;
  if (param.kind === "count") return Array.from({ length: Math.min(steps, spec.symbols.length) }, (_, i) => i + 1);
  const lo = v * 0.4, hi = v * 2;
  const raw = Array.from({ length: steps }, (_, i) => lo * Math.pow(hi / lo, i / (steps - 1)));
  const round = param.kind === "days" ? (x) => Math.max(2, Math.round(x))
    : param.kind === "pct" ? (x) => Math.round(x * 1000) / 1000
    : (x) => (Math.abs(v) >= 10 ? Math.round(x) : Math.round(x * 10) / 10);
  const vals = [...new Set([...raw.map(round), v])].sort((a, b) => a - b);
  // RSI-style levels live between 0 and 100
  return /^lvl:.*"ind":"rsi"/.test(param.id) ? vals.filter((x) => x > 0 && x < 100) : vals;
}

const cell = (r) => ({ cagr: r.metrics.cagr, sharpe: r.metrics.sharpe, maxDrawdown: r.metrics.maxDrawdown, trades: r.metrics.trades, excess: r.metrics.excessCagr });

// Re-runs the strategy over a grid of one or two parameters.
// Returns { a, b, grid: [bIndex][aIndex] of cell|null, stability }.
export async function sweep(spec, bars, opts, a, b = null, { onProgress } = {}) {
  const av = a.values, bv = b ? b.values : [null];
  const grid = [];
  let done = 0;
  for (const y of bv) {
    const row = [];
    for (const x of av) {
      let s = withParam(spec, a.param, x);
      if (b) s = withParam(s, b.param, y);
      try { row.push(cell(backtestSpec(s, bars, opts))); } catch { row.push(null); }
      if (++done % 4 === 0) { onProgress?.(done / (av.length * bv.length)); await pause(); }
    }
    grid.push(row);
  }
  // Stability: how much of the grid still works. A lone bright cell in a dark grid is luck.
  const cells = grid.flat().filter(Boolean);
  const ia = av.indexOf(a.param.value), ib = b ? bv.indexOf(b.param.value) : 0;
  const here = grid[ib]?.[ia] ?? null;
  const good = cells.filter((c) => c.sharpe > 0 && c.cagr > 0);
  const best = cells.reduce((m, c) => (c.sharpe > (m?.sharpe ?? -Infinity) ? c : m), null);
  const sorted = cells.map((c) => c.sharpe).sort((p, q) => p - q);
  return {
    a: { label: a.param.label, values: av, at: ia }, b: b ? { label: b.param.label, values: bv, at: ib } : null,
    grid, here, best,
    stability: cells.length ? good.length / cells.length : 0,
    median: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
    rank: here && sorted.length ? sorted.filter((v) => v <= here.sharpe).length / sorted.length : null,
  };
}

// ---------- walk-forward ----------
// Splits history into `folds` test windows after an initial training stretch. For each
// window it picks the parameter value that did best on everything before it, then
// trades the window with that value. Stitched together, the test windows are a result
// the tuning never saw.
export async function walkForward(spec, bars, opts, param, values, { folds = 5, trainShare = 0.4, onProgress } = {}) {
  const full = backtestSpec(spec, bars, opts);
  const t = full.time, n = t.length;
  const first = Math.floor(n * trainShare);
  if (n - first < folds * 20) throw new Error("Not enough history for a walk-forward test.");
  const edges = Array.from({ length: folds + 1 }, (_, k) => first + Math.floor(((n - 1 - first) * k) / folds));
  const upTo = (time) => Object.fromEntries(Object.entries(bars).map(([s, b]) => [s, b.filter((x) => x.time <= time)]));
  const picks = [], rets = [], times = [t[edges[0]]];
  let done = 0;
  for (let k = 0; k < folds; k++) {
    const trainBars = upTo(t[edges[k]]);
    let bestV = values[0], bestS = -Infinity;
    for (const v of values) {
      try {
        const r = backtestSpec(withParam(spec, param, v), trainBars, opts);
        if (r.metrics.sharpe > bestS) { bestS = r.metrics.sharpe; bestV = v; }
      } catch { /* this value can't run on this window */ }
      onProgress?.(++done / (folds * values.length));
      await pause();
    }
    const test = backtestSpec(withParam(spec, param, bestV), upTo(t[edges[k + 1]]), { ...opts, from: t[edges[k]] });
    const r = dailyReturns(test.equity, test.startIndex);
    for (let i = 0; i < r.length; i++) { rets.push(r[i]); times.push(test.time[test.startIndex + 1 + i]); }
    picks.push({ from: t[edges[k]], to: t[edges[k + 1]], value: bestV, trainSharpe: bestS, testReturn: (test.equity.at(-1) / test.equity[test.startIndex] - 1) * 100 });
  }
  const equity = [opts.capital ?? 10000];
  for (const r of rets) equity.push(equity.at(-1) * (1 + r));
  const out = curveStats(times, equity);
  const same = curveStats(t, full.equity, edges[0], n - 1); // the untuned rules over the same stretch
  const bench = curveStats(t, full.bench, edges[0], n - 1);
  return { picks, time: times, equity, out, same, bench, param: param.label };
}

// ---------- robustness score ----------
// Five checks, 20 points each. The point is not a precise number but a quick,
// explained answer to "should I believe this backtest?".
export function score(result, hold, mc) {
  const m = result.metrics;
  const parts = [];
  const add = (key, label, pts, good, text) => parts.push({ key, label, points: Math.round(clamp(pts, 0, 20)), good, text });
  const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "–");
  const tiny = result.kind === "signal" && m.trades < 30;

  // 1. Did it earn more per unit of risk than just holding?
  const edge = m.sharpe - m.benchSharpe;
  add("edge", "Edge over buy & hold", 10 + edge * 20, edge > 0.05,
    `Sharpe ${f(m.sharpe, 2)} vs ${f(m.benchSharpe, 2)} for buy & hold; ${f(m.cagr)}% a year vs ${f(m.benchCagr)}%.`);

  // 2. Were the losses shallower?
  const ratio = m.benchMaxDrawdown < 0 ? m.maxDrawdown / m.benchMaxDrawdown : 1;
  add("risk", "Drawdown control", 20 * (1 - lerp(ratio, 0.4, 1.4)), ratio < 0.85,
    `Worst drop ${f(m.maxDrawdown)}% vs ${f(m.benchMaxDrawdown)}% for buy & hold${m.longestDrawdownDays ? `; longest time underwater ${Math.round(m.longestDrawdownDays / 30.4)} months` : ""}.`);

  // 3. Did the later years hold up? Rules tuned to the past usually fade.
  const keep = hold.early.sharpe > 0.1 ? hold.late.sharpe / hold.early.sharpe : hold.late.sharpe > 0.3 ? 1 : 0;
  add("hold", "Staying power", 20 * lerp(keep, 0, 1), keep >= 0.6,
    `Sharpe ${f(hold.early.sharpe, 2)} in the first 70% of history, ${f(hold.late.sharpe, 2)} in the last 30%; beat buy & hold in ${m.yearsBeatBench} of ${m.yearsCount} years.`);

  // 4. Is there enough evidence? Few trades or few years prove little.
  const conf = lerp(m.tStat, 0, 3) * (tiny ? m.trades / 30 : 1);
  add("evidence", "Weight of evidence", 20 * conf, m.tStat >= 2 && !tiny,
    tiny ? `Only ${m.trades} trade${m.trades === 1 ? "" : "s"} in ${f(m.years)} years: too few to tell skill from luck.`
      : `${f(m.years)} years${result.kind === "signal" ? ` and ${m.trades} trades` : ""}; t-statistic ${f(m.tStat, 1)} (above 2 is hard to get by chance).`);

  // 5. Does it survive a reshuffled history?
  if (mc) add("chance", "Resilience to bad luck", 20 * lerp(mc.cagr.p5, -8, 3), mc.cagr.p5 > 0,
    `In ${mc.runs} reshuffled histories, 1 in 20 earned ${f(mc.cagr.p5)}% a year or less; it lost money in ${f(mc.probLoss, 0)}% and beat buy & hold in ${f(mc.probBeat, 0)}%.`);
  else add("chance", "Resilience to bad luck", 0, false, "Not enough history to reshuffle.");

  const total = parts.reduce((a, p) => a + p.points, 0);
  const [grade, word] = total >= 80 ? ["A", "Robust"] : total >= 65 ? ["B", "Promising"] : total >= 50 ? ["C", "Mixed"] : total >= 35 ? ["D", "Fragile"] : ["F", "Unconvincing"];
  const worst = [...parts].sort((a, b) => a.points - b.points)[0];
  const bestPart = [...parts].sort((a, b) => b.points - a.points)[0];
  const headline = total >= 65 ? `Strongest on ${bestPart.label.toLowerCase()}; weakest on ${worst.label.toLowerCase()}.`
    : `Held back mostly by ${worst.label.toLowerCase()}.`;
  return { total, grade, word, headline, parts };
}
