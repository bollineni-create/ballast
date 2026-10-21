import { ta } from "./indicators.js";

// A strategy is the body of a function `(data, ta)` that returns
// { entry(i) -> bool, exit(i) -> bool, stopLoss?, takeProfit? }.
// `data` holds aligned arrays: time, open, high, low, close, volume.
export function compileStrategy(code) {
  let factory;
  try {
    factory = new Function("data", "ta", `"use strict";\n${code}`);
  } catch (e) {
    throw new Error(`Syntax error in strategy: ${e.message}`);
  }
  return (data) => {
    const s = factory(data, ta);
    if (!s || typeof s.entry !== "function" || typeof s.exit !== "function") {
      throw new Error("Strategy must return an object with entry(i) and exit(i) functions.");
    }
    return s;
  };
}

// Signals are evaluated on each bar's close and filled at the next bar's open.
// Stops and targets are checked intrabar against the high/low.
export function runBacktest(data, code, opts = {}) {
  const { capital = 10000, feeBps = 5, slippageBps = 5 } = opts;
  const strat = compileStrategy(code)(data);
  const n = data.close.length;
  const cost = (feeBps + slippageBps) / 10000;
  const equity = new Array(n).fill(capital);
  const trades = [];
  let cash = capital, shares = 0, entry = null, pending = null, barsInMarket = 0;

  const close = (i, price, reason) => {
    const proceeds = shares * price * (1 - cost);
    trades.push({
      entryIndex: entry.index, exitIndex: i,
      entryTime: data.time[entry.index], exitTime: data.time[i],
      entryPrice: entry.price, exitPrice: price,
      shares, pnl: proceeds - entry.outlay, returnPct: (proceeds / entry.outlay - 1) * 100,
      bars: i - entry.index, reason,
    });
    cash += proceeds;
    shares = 0;
    entry = null;
  };

  for (let i = 0; i < n; i++) {
    if (pending === "buy" && shares === 0) {
      const price = data.open[i];
      shares = cash / (price * (1 + cost));
      entry = { index: i, price, outlay: cash };
      cash = 0;
    } else if (pending === "sell" && shares > 0) {
      close(i, data.open[i], "signal");
    }
    pending = null;

    if (shares > 0) {
      const stop = strat.stopLoss ? entry.price * (1 - strat.stopLoss) : null;
      const target = strat.takeProfit ? entry.price * (1 + strat.takeProfit) : null;
      if (stop && data.low[i] <= stop) close(i, Math.min(stop, data.open[i]), "stop loss");
      else if (target && data.high[i] >= target) close(i, Math.max(target, data.open[i]), "take profit");
    }

    if (i < n - 1) {
      if (shares === 0 && strat.entry(i)) pending = "buy";
      else if (shares > 0 && strat.exit(i)) pending = "sell";
    }
    if (shares > 0) barsInMarket++;
    equity[i] = cash + shares * data.close[i];
  }
  const openPosition = shares > 0 ? { ...entry, shares, markPrice: data.close[n - 1] } : null;
  if (shares > 0) close(n - 1, data.close[n - 1], "end of data");

  return { equity, trades, openPosition, metrics: computeMetrics(data, equity, trades, capital, barsInMarket) };
}

export function computeMetrics(data, equity, trades, capital, barsInMarket) {
  const n = equity.length;
  const rets = [];
  for (let i = 1; i < n; i++) rets.push(equity[i] / equity[i - 1] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length || 1));
  let peak = -Infinity, maxDD = 0;
  for (const v of equity) {
    peak = Math.max(peak, v);
    maxDD = Math.min(maxDD, v / peak - 1);
  }
  const years = (data.time[n - 1] - data.time[0]) / (365.25 * 864e5) || n / 252;
  const final = equity[n - 1];
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
  return {
    finalEquity: final,
    totalReturn: (final / capital - 1) * 100,
    cagr: (Math.pow(final / capital, 1 / years) - 1) * 100,
    buyHold: (data.close[n - 1] / data.close[0] - 1) * 100,
    maxDrawdown: maxDD * 100,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(252) : 0,
    trades: trades.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    avgTrade: trades.length ? trades.reduce((a, t) => a + t.returnPct, 0) / trades.length : 0,
    exposure: (barsInMarket / n) * 100,
  };
}
