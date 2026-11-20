import test from "node:test";
import assert from "node:assert/strict";
import { simulatedBars } from "../public/lib/data.js";
import { toSeries } from "../public/lib/data.js";
import { runBacktest } from "../public/lib/backtest.js";
import { parseStrategy } from "../public/lib/parse.js";
import { backtestSpec, signalRules } from "../public/lib/engine.js";

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
    for (const k of ["totalReturn", "maxDrawdown", "sharpe", "exposure", "buyHold"]) close(a.metrics[k], b.metrics[k]);
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
