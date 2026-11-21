import test from "node:test";
import assert from "node:assert/strict";
import { simulatedBars } from "../public/lib/data.js";
import { toSeries } from "../public/lib/data.js";
import { runBacktest } from "../public/lib/backtest.js";
import { parseStrategy } from "../public/lib/parse.js";
import { backtestSpec, signalRules } from "../public/lib/engine.js";
import { holdout, monteCarlo, findParams, gridFor, sweep, walkForward, score, withParam } from "../public/lib/lab.js";
import { periodTable, curveStats } from "../public/lib/metrics.js";

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} != ${b}`);

test("single-asset rules match the original code engine exactly", () => {
  const bars = simulatedBars("PARITY", 1500);
  const cases = [
    ["Buy when the 20-day SMA crosses above the 50-day SMA, sell when it crosses back below", `const f=ta.sma(data.close,20),s=ta.sma(data.close,50);return{entry:(i)=>ta.crossover(f,s,i),exit:(i)=>ta.crossunder(f,s,i)};`],
    ["Buy when RSI 14 crosses above 30, sell when it crosses above 70, 5% stop loss, 12% take profit", `const r=ta.rsi(data.close,14);return{entry:(i)=>ta.crossover(r,30,i),exit:(i)=>ta.crossover(r,70,i),stopLoss:0.05,takeProfit:0.12};`],
    ["Buy when price closes below the lower Bollinger Band (20, 2), sell when price is above the middle band", `const b=ta.bollinger(data.close,20,2);return{entry:(i)=>data.close[i]<b.lower[i],exit:(i)=>data.close[i]>b.mid[i]};`],
  ];
  for (const [english, code] of cases) {
    const { spec } = parseStrategy(english);
    const a = backtestSpec(spec, { X: bars }, { fallbackSymbol: "X", capital: 10000, costBps: 10 });
    const b = runBacktest(toSeries(bars), code, { capital: 10000, feeBps: 5, slippageBps: 5 });
    assert.equal(a.trades.length, b.trades.length, english);
    // (Sharpe is left out: it now annualizes by the data's real bars per year, not a fixed 252.)
    for (const k of ["totalReturn", "maxDrawdown", "exposure", "buyHold"]) close(a.metrics[k], b.metrics[k]);
  }
});

const day = (i) => Date.UTC(2020, 0, 1) + i * 864e5;
const series = (closes, skip = () => false) => closes.flatMap((c, i) => (skip(i) ? [] : [{ time: day(i), open: c, high: c, low: c, close: c, volume: 1e6 }]));

test("cross-market filter uses the other market's own bars", () => {
  // Trade A only while B is above 100; B is only open on even days.
  const A = series(Array.from({ length: 40 }, (_, i) => 100 + i));
  const B = series(Array.from({ length: 40 }, (_, i) => (i < 20 ? 90 : 110)), (i) => i % 2 === 1);
  const { spec } = parseStrategy("Buy AAA when BBB is above 100, sell when BBB is below 100");
  const r = backtestSpec(spec, { AAA: A, BBB: B });
  assert.equal(r.trades.length, 1);
  assert.equal(new Date(r.trades[0].entryTime).getUTCDate(), new Date(day(21)).getUTCDate()); // signal day 20, fill day 21
});

test("trailing stop and time limit exits", () => {
  const up = Array.from({ length: 30 }, (_, i) => (i < 10 ? 100 : i < 15 ? 100 + (i - 9) * 10 : 150 - (i - 14) * 5));
  const A = series(up).map((b) => ({ ...b, high: b.close * 1.001, low: b.close * 0.999 }));
  let r = backtestSpec(parseStrategy("Buy AAA when price is above 0, 10% trailing stop").spec, { AAA: A });
  assert.equal(r.trades[0].reason, "trailing stop");
  r = backtestSpec(parseStrategy("Buy AAA when price is above 0, sell after 5 days").spec, { AAA: A });
  assert.equal(r.trades[0].reason, "time limit");
  assert.equal(r.trades[0].bars, 5);
});

test("60/40 quarterly rebalance keeps weights near target", () => {
  const S = simulatedBars("STOCKS", 800), T = simulatedBars("BONDS", 800);
  const r = backtestSpec(parseStrategy("60/40 SPY TLT rebalanced quarterly").spec, { SPY: S, TLT: T });
  const quarters = new Set(r.orders.map((o) => `${new Date(o.time).getUTCFullYear()}Q${Math.floor(new Date(o.time).getUTCMonth() / 3)}`));
  assert.ok(quarters.size >= 8 && quarters.size <= 13, `rebalanced in ${quarters.size} quarters`);
  const lastTrade = r.orders.at(-1).index;
  close(r.weightHistory.SPY[lastTrade], 60, 0.02);
  assert.ok(r.equity.every(Number.isFinite));
});

test("rotation holds the strongest asset and goes to cash when nothing is positive", () => {
  const n = 300;
  const A = series(Array.from({ length: n }, (_, i) => 100 * Math.exp(0.002 * i)));
  const B = series(Array.from({ length: n }, (_, i) => 100 * Math.exp(-0.001 * i)));
  let r = backtestSpec(parseStrategy("Each month hold the top 1 of AAA, BBB by 63-day return").spec, { AAA: A, BBB: B });
  assert.ok(r.orders.every((o) => o.symbol === "AAA"));
  const down = series(Array.from({ length: n }, (_, i) => 100 * Math.exp(-0.002 * i)));
  r = backtestSpec(parseStrategy("Each month hold the top 1 of AAA, BBB by 63-day return, only if it's positive").spec, { AAA: down, BBB: B });
  assert.equal(r.orders.length, 0);
});

test("risk-off switch moves to the fallback asset", () => {
  const n = 400;
  const S = series(Array.from({ length: n }, (_, i) => (i < 250 ? 100 + i : 350 - (i - 250) * 2)));
  const T = series(Array.from({ length: n }, () => 100));
  const r = backtestSpec(parseStrategy("Hold SPY when it's above its 200 day average, otherwise TLT").spec, { SPY: S, TLT: T });
  assert.ok(r.orders.some((o) => o.symbol === "TLT" && o.side === "buy"));
  assert.ok(r.weightHistory.TLT.at(-2) > 99);
});

test("live paper-trading rules expose entry/exit on the shared calendar", () => {
  const bars = simulatedBars("LIVE", 300);
  const rules = signalRules(parseStrategy("Buy when RSI is below 30, sell when RSI is above 70").spec, { LIVE: bars }, "LIVE");
  assert.equal(rules.time.length, 300);
  assert.equal(typeof rules.entry(299), "boolean");
});

test("a cross in another market while this one is closed counts at the next session", () => {
  // BBB crosses above 100 on day 5, a day AAA is closed.
  const A = series(Array.from({ length: 20 }, () => 50), (i) => i === 5);
  const B = series(Array.from({ length: 20 }, (_, i) => (i < 5 ? 90 : 110)));
  const r = backtestSpec(parseStrategy("Buy AAA when BBB crosses above 100").spec, { AAA: A, BBB: B });
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].entryTime, day(7)); // seen on day 6 (AAA's next session), filled day 7
});

test("portfolios only trade a market on days it is open", () => {
  const A = series(Array.from({ length: 60 }, (_, i) => 100 + i));
  const B = series(Array.from({ length: 60 }, (_, i) => 100 - i * 0.5), (i) => i % 3 === 1);
  const r = backtestSpec(parseStrategy("Hold 50% AAA, 50% BBB, rebalance weekly").spec, { AAA: A, BBB: B });
  assert.ok(r.orders.length > 4);
  const bDays = new Set(B.map((b) => b.time));
  assert.ok(r.orders.filter((o) => o.symbol === "BBB").every((o) => bDays.has(o.time)));
});

test("buys never spend cash a pending sell on a closed market hasn't raised yet", () => {
  // Switch from BBB to AAA; BBB is closed on the rebalance day, so AAA can only be bought after BBB sells.
  const n = 80;
  // BBB leads first, then AAA; BBB only trades one day in four, so the switch's sell waits.
  const A = series(Array.from({ length: n }, (_, i) => (i < 40 ? 100 - i * 0.2 : 92 + (i - 40) * 2)));
  const B = series(Array.from({ length: n }, (_, i) => (i < 40 ? 100 + i : 140 - (i - 40) * 2)), (i) => i % 4 !== 0);
  const r = backtestSpec(parseStrategy("Each week hold the top 1 of AAA, BBB by 10-day return").spec, { AAA: A, BBB: B }, { costBps: 10 });
  // replay cash through the orders: it must never go meaningfully negative
  let cash = 10000;
  for (const o of r.orders) {
    cash += (o.side === "buy" ? -1 : 1) * o.value - o.value * 0.001;
    assert.ok(cash > -1, `cash ${cash.toFixed(2)} after ${o.side} ${o.symbol} on day ${o.index}`);
  }
  assert.ok(r.orders.some((o) => o.symbol === "AAA" && o.side === "buy"));
});

// ---------- engine: shorts, sizing, currencies ----------
const ohlc = (closes) => closes.map((c, i) => ({ time: day(i), open: c, high: c, low: c, close: c, volume: 1e6 }));

test("a short makes money when the price falls, and its stop caps the loss when it rises", () => {
  const fall = ohlc(Array.from({ length: 40 }, (_, i) => 100 - i));
  let r = backtestSpec(parseStrategy("Short AAA when price is below 100").spec, { AAA: fall }, { costBps: 0 });
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].side, "short");
  // signal on day 1 (99), short at day 2's open (98), marked at 61 on the last day
  close(r.trades[0].returnPct, ((98 - 61) / 98) * 100);
  close(r.equity.at(-1), 10000 * (1 + (98 - 61) / 98));
  assert.ok(r.exposure.at(-2) < 0);

  const rise = ohlc(Array.from({ length: 40 }, (_, i) => 100 + i));
  r = backtestSpec(parseStrategy("Short AAA when price is above 100, 10% stop loss").spec, { AAA: rise }, { costBps: 0 });
  assert.equal(r.trades[0].reason, "stop loss");
  // shorted at 102, stop at 112.2; the next bar opens beyond it at 113, so it fills there
  close(r.trades[0].returnPct, ((102 - 113) / 102) * 100);
});

test("long and short rules reverse into each other", () => {
  const wave = ohlc(Array.from({ length: 200 }, (_, i) => 100 + 20 * Math.sin(i / 10)));
  const r = backtestSpec(parseStrategy("Buy AAA when price crosses above 100, short when price crosses below 100").spec, { AAA: wave }, { costBps: 0 });
  assert.ok(r.trades.length >= 5);
  assert.ok(r.trades.some((t) => t.side === "long") && r.trades.some((t) => t.side === "short"));
  assert.ok(r.trades.slice(0, -1).every((t) => t.reason === "reversal"));
  for (let k = 1; k < r.trades.length; k++) assert.equal(r.trades[k].entryIndex, r.trades[k - 1].exitIndex);
});

test("a volatility target shrinks positions in a wild market", () => {
  const wild = simulatedBars("WILD", 600).map((b, i) => ({ ...b, close: b.close * (i % 2 ? 1.04 : 0.96) }));
  const calm = parseStrategy("Hold 100% AAA, rebalance monthly").spec;
  const target = parseStrategy("Hold 100% AAA, rebalance monthly, target 10% volatility").spec;
  const a = backtestSpec(calm, { AAA: wild }), b = backtestSpec(target, { AAA: wild });
  assert.ok(a.metrics.vol > 40);
  assert.ok(b.metrics.vol < a.metrics.vol * 0.5, `${b.metrics.vol} vs ${a.metrics.vol}`);
  assert.ok(b.now.cashTarget > 30);
});

test("inverse-volatility weights favour the calmer asset", () => {
  const A = simulatedBars("CALM", 500).map((b, i) => ({ ...b, close: 100 * (1 + 0.002 * (i % 2)) }));
  const B = simulatedBars("ROUGH", 500).map((b, i) => ({ ...b, close: 100 * (1 + 0.02 * (i % 2)) }));
  const r = backtestSpec(parseStrategy("risk parity AAA, BBB").spec, { AAA: A, BBB: B });
  const last = r.orders.at(-1).index;
  assert.ok(r.weightHistory.AAA[last] > 85, `${r.weightHistory.AAA[last]}`);
});

test("foreign markets are converted into the base currency", () => {
  const flat = ohlc(Array.from({ length: 30 }, () => 100));
  const fx = Array.from({ length: 30 }, (_, i) => ({ time: day(i), close: 1 + i * 0.01 }));
  const r = backtestSpec(parseStrategy("Hold 100% AAA").spec, { AAA: flat }, { costBps: 0, fx: { AAA: fx } });
  // bought at day 1's rate (1.01), worth 1.29 at the end: all of the gain is currency
  close(r.equity.at(-1), 10000 * (1.29 / 1.01));
  close(r.bench.at(-1), 10000 * 1.29);
});

test("an outside benchmark doesn't change the strategy's own result", () => {
  const S = simulatedBars("STRAT", 400), B = simulatedBars("BENCH", 300);
  const spec = parseStrategy("Buy AAA when RSI is below 40, sell when RSI is above 60").spec;
  const a = backtestSpec(spec, { AAA: S }), b = backtestSpec(spec, { AAA: S, BBB: B }, { benchmark: "BBB" });
  assert.deepEqual(a.equity, b.equity);
  assert.equal(b.benchLabel, "Buy & hold BBB");
  assert.notDeepEqual(a.bench, b.bench);
});

test("results report what to do today", () => {
  const up = ohlc(Array.from({ length: 60 }, (_, i) => 100 + i));
  let r = backtestSpec(parseStrategy("Buy AAA when price is above 120, sell when price is below 110, 5% trailing stop").spec, { AAA: up });
  assert.deepEqual([r.now.actions[0].held, r.now.actions[0].action], ["long", "hold"]);
  close(r.now.actions[0].stops.trail, 159 * 0.95);
  r = backtestSpec(parseStrategy("Buy AAA when price is above 158").spec, { AAA: up });
  assert.deepEqual([r.now.actions[0].held, r.now.actions[0].action], ["flat", "buy"]); // fires on the last bar
  r = backtestSpec(parseStrategy("Hold 60% AAA, 40% BBB, rebalance yearly").spec, { AAA: up, BBB: ohlc(Array.from({ length: 60 }, () => 50)) });
  assert.deepEqual(r.now.targets.map((t) => t.target), [60, 40]);
  assert.ok(r.now.targets[0].current > 60);
});

test("`from` keeps the strategy out of the market until that date", () => {
  const bars = simulatedBars("FROM", 500);
  const spec = parseStrategy("Buy when the 10-day SMA crosses above the 30-day SMA, sell when it crosses back below").spec;
  const r = backtestSpec(spec, { X: bars }, { fallbackSymbol: "X", from: bars[250].time });
  assert.equal(r.startIndex, 250);
  assert.ok(r.equity.slice(0, 251).every((v) => v === 10000));
  assert.ok(r.trades.every((t) => t.entryIndex > 250));
  assert.equal(r.bench[250], 10000);
});

// ---------- statistics ----------
test("monthly and yearly tables compound back to the total return", () => {
  const bars = simulatedBars("TABLE", 700);
  const time = bars.map((b) => b.time), eq = bars.map((b) => b.close);
  const rows = periodTable(time, eq);
  const viaYears = rows.reduce((a, y) => a * (1 + y.total / 100), 1);
  const viaMonths = rows.flatMap((y) => y.months.filter((m) => m != null)).reduce((a, m) => a * (1 + m / 100), 1);
  close(viaYears, eq.at(-1) / eq[0]);
  close(viaMonths, eq.at(-1) / eq[0]);
  const s = curveStats(time, eq);
  close(Math.pow(1 + s.cagr / 100, s.years), eq.at(-1) / eq[0]);
  assert.ok(s.maxDrawdown < 0 && s.longestDays > 0);
});

// ---------- lab ----------
test("holdout, Monte Carlo and the score work on a real run", () => {
  const bars = simulatedBars("LAB", 1500);
  const r = backtestSpec(parseStrategy("Buy when the 20-day SMA crosses above the 50-day SMA, sell when it crosses back below").spec, { X: bars }, { fallbackSymbol: "X" });
  const h = holdout(r);
  assert.ok(h.splitIndex > 1000 && h.splitIndex < 1100);
  close((1 + h.early.totalReturn / 100) * (1 + h.late.totalReturn / 100), r.equity.at(-1) / r.equity[0]);
  const mc = monteCarlo(r, { runs: 200 });
  assert.equal(mc.bands.length, 5);
  assert.ok(mc.cagr.p5 <= mc.cagr.p50 && mc.cagr.p50 <= mc.cagr.p95);
  assert.ok(mc.maxDrawdown.p5 <= mc.maxDrawdown.p95 && mc.maxDrawdown.p95 <= 0);
  assert.deepEqual(monteCarlo(r, { runs: 200 }).cagr, mc.cagr); // seeded: the same every time
  const s = score(r, h, mc);
  assert.equal(s.parts.length, 5);
  assert.ok(s.total >= 0 && s.total <= 100 && s.total === s.parts.reduce((a, p) => a + p.points, 0));
});

test("buy and hold scores in the middle, never as robust", () => {
  const bars = simulatedBars("HOLD", 1500);
  const r = backtestSpec(parseStrategy("Hold 100% AAA").spec, { AAA: bars });
  const s = score(r, holdout(r), monteCarlo(r, { runs: 200 }));
  assert.ok(s.parts.find((p) => p.key === "edge").points <= 11);
  assert.ok(s.total < 80);
});

test("parameters are found once each, and a sweep reproduces the base run", async () => {
  const spec = parseStrategy("Buy when the 20-day SMA crosses above the 50-day SMA and RSI is below 70, sell when the 20-day SMA crosses below the 50-day SMA, 8% stop loss").spec;
  const params = findParams(spec);
  assert.deepEqual(params.map((p) => p.label), ["20-day SMA", "50-day SMA", "RSI level 70 (buy rule)", "14-day RSI", "Stop loss %"]);
  assert.equal(params[0].paths.length, 2); // the buy rule and the sell rule share it
  const moved = withParam(spec, params[0], 10);
  assert.equal(moved.entry.c[0].a.n, 10);
  assert.equal(moved.exit.a.n, 10);
  assert.equal(spec.entry.c[0].a.n, 20);
  const bars = { X: simulatedBars("SWEEP", 900) }, opts = { fallbackSymbol: "X" };
  const a = { param: params[0], values: gridFor(params[0], 5) }, b = { param: params[1], values: gridFor(params[1], 5) };
  assert.ok(a.values.includes(20) && a.values.every((v) => Number.isInteger(v) && v >= 2));
  const sw = await sweep(spec, bars, opts, a, b);
  assert.equal(sw.grid.length, b.values.length);
  close(sw.here.cagr, backtestSpec(spec, bars, opts).metrics.cagr);
  assert.ok(sw.stability >= 0 && sw.stability <= 1);
});

test("walk-forward only reports results from windows the tuning hadn't seen", async () => {
  const spec = parseStrategy("Buy when the 20-day SMA crosses above the 50-day SMA, sell when it crosses back below").spec;
  const bars = { X: simulatedBars("WALK", 1500) }, opts = { fallbackSymbol: "X", capital: 10000 };
  const p = findParams(spec)[0];
  const wf = await walkForward(spec, bars, opts, p, [10, 20, 30], { folds: 4 });
  assert.equal(wf.picks.length, 4);
  assert.ok(wf.picks.every((k) => [10, 20, 30].includes(k.value) && k.to > k.from));
  assert.equal(wf.time[0], bars.X[600].time); // starts after the 40% training stretch
  assert.equal(wf.time.length, wf.equity.length);
  assert.ok(Number.isFinite(wf.out.cagr) && Number.isFinite(wf.same.cagr));
});

// ---------- portfolio check-up ----------
import { parseHoldings, toWeights } from "../public/lib/holdings.js";
import { checkup, project, classOf } from "../public/lib/checkup.js";

test("typed portfolios and goals are read", () => {
  const r = parseHoldings("50 AAPL, 20 shares of MSFT, $5,000 in VTI and 3k cash. Retire in 20 years, adding $500 a month, want to reach $1M, can't stomach more than a 25% drop");
  assert.deepEqual(r.positions, [{ symbol: "AAPL", shares: 50 }, { symbol: "MSFT", shares: 20 }, { symbol: "VTI", value: 5000 }]);
  assert.equal(r.cash, 3000);
  assert.deepEqual(r.goals, { years: 20, monthly: 500, target: 1000000, maxDrop: 25 });
  const w = toWeights(r, { AAPL: 340, MSFT: 500 });
  assert.equal(w.total, 35000);
  close(w.weights.AAPL, 17000 / 35000);
  close(w.cashWeight, 3000 / 35000);
  assert.deepEqual(toWeights(r, { AAPL: 340 }).missing, ["MSFT"]);
  const p = parseHoldings("VTI 60%\nVXUS 25%\nBND 15%\nconservative, 10 year horizon");
  assert.deepEqual(toWeights(p).weights, { VTI: 0.6, VXUS: 0.25, BND: 0.15 });
  assert.deepEqual(p.goals, { years: 10, risk: "low" });
  assert.deepEqual(parseHoldings("apple 100 shares; 1,500 shares of nvda; bitcoin $12,000").positions.map((x) => x.symbol), ["AAPL", "NVDA", "BTC-USD"]);
  assert.deepEqual(parseHoldings("what should I do").positions, []);
});

test("the check-up flags concentration and a broken drawdown limit, and projections are ordered", () => {
  const wild = simulatedBars("WILDCO", 1500), calm = simulatedBars("BND", 1500).map((b, i) => ({ ...b, open: 100, high: 100, low: 100, close: 100 + (i % 2) * 0.05 }));
  const c = checkup({ weights: { WILDCO: 0.7, BND: 0.2 }, bars: { WILDCO: wild, BND: calm }, total: 50000, goals: { years: 10, monthly: 500, target: 200000, maxDrop: 5 } });
  assert.equal(classOf("WILDCO"), "Single stocks");
  close(c.cashWeight, 10);
  close(c.holdings.reduce((a, h) => a + h.riskShare, 0), 100, 1e-6);
  assert.ok(c.holdings[0].riskShare > 99);
  const titles = c.findings.map((x) => x.title).join(" | ");
  assert.match(titles, /WILDCO is 70% of the portfolio/);
  assert.match(titles, /further than your 5% limit/);
  assert.match(titles, /% of futures reach your target/);
  const p = c.projection;
  assert.equal(p.bands[0].length, 11);
  assert.ok(p.end.p10 <= p.end.p50 && p.end.p50 <= p.end.p90);
  assert.equal(p.paid, 50000 + 500 * 120);
  // with no market moves, the projection is just the money paid in
  const flat = project(new Float64Array(500), { start: 1000, years: 2, monthly: 100, target: 3000 });
  close(flat.end.p50, 1000 + 2400);
  assert.equal(flat.chance, 100);
});

test("goals and cash are read without confusing them with holdings", () => {
  const g = (t) => parseHoldings(t).goals;
  assert.equal(g("I have $50,000 in VTI and want to reach $1M in 20 years").target, 1000000);
  assert.equal(g("I want $5,000 in VTI. Goal of 750k").target, 750000);
  assert.equal(g("need 500 a month, want $2 million").target, 2000000);
  assert.equal(g("I have 50 AAPL").target, undefined);
  assert.equal(g("want income from dividends").income, true);
  // percent cash next to share counts, and the reverse
  const w = toWeights(parseHoldings("50 AAPL, 10% cash"), { AAPL: 180 });
  close(w.total, 10000); close(w.cashWeight, 0.1); close(w.weights.AAPL, 0.9);
  assert.deepEqual(parseHoldings("100 shares of Toyota, 7203.T 50, $2,000 in 0700.HK").positions, [{ symbol: "7203.T", shares: 150 }, { symbol: "0700.HK", value: 2000 }]);
  const p = parseHoldings("60% VTI, 30% BND, 10% cash");
  close(toWeights(p).cashWeight, 0.1);
});
