// Performance statistics for an equity curve, measured against a benchmark.
// Everything is computed from `start` onward, so a test that only begins trading
// part-way through its data (walk-forward) is judged on the part it traded.

const DAY = 864e5;
const YEAR = 365.25 * DAY;

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sd = (a, m = mean(a)) => (a.length ? Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length) : 0);

export function dailyReturns(equity, start = 0) {
  const out = new Float64Array(Math.max(0, equity.length - start - 1));
  for (let i = start + 1; i < equity.length; i++) out[i - start - 1] = equity[i - 1] > 0 ? equity[i] / equity[i - 1] - 1 : 0;
  return out;
}

// Percent below the running peak, per bar (0 or negative).
export function drawdownSeries(equity, start = 0) {
  const out = new Float64Array(equity.length);
  let peak = -Infinity;
  for (let i = start; i < equity.length; i++) {
    peak = Math.max(peak, equity[i]);
    out[i] = peak > 0 ? (equity[i] / peak - 1) * 100 : 0;
  }
  return out;
}

// Deepest drawdown and the longest stretch spent below a previous peak.
export function drawdownStats(time, equity, start = 0) {
  let peak = -Infinity, peakAt = start, maxDD = 0, troughAt = start, ddPeakAt = start, longest = 0, sumSq = 0;
  for (let i = start; i < equity.length; i++) {
    if (equity[i] >= peak) { peak = equity[i]; peakAt = i; }
    const dd = peak > 0 ? equity[i] / peak - 1 : 0;
    sumSq += dd * dd;
    if (dd < maxDD) { maxDD = dd; troughAt = i; ddPeakAt = peakAt; }
    longest = Math.max(longest, time[i] - time[peakAt]);
  }
  const n = equity.length - start;
  return { maxDrawdown: maxDD * 100, peakTime: time[ddPeakAt], troughTime: time[troughAt], longestDays: Math.round(longest / DAY), ulcer: Math.sqrt(sumSq / Math.max(1, n)) * 100 };
}

// Core numbers for one curve between two indexes.
export function curveStats(time, equity, start = 0, end = equity.length - 1) {
  const eq = equity.slice(start, end + 1);
  const t = time.slice(start, end + 1);
  const n = eq.length;
  const years = n > 1 ? (t[n - 1] - t[0]) / YEAR : 0;
  const r = dailyReturns(eq);
  const perYear = years > 0 ? r.length / years : 252;
  const m = mean(r), s = sd(r, m);
  const down = Math.sqrt(mean(Array.from(r, (x) => Math.min(0, x) ** 2)));
  const total = n > 1 && eq[0] > 0 ? eq[n - 1] / eq[0] : 1;
  const cagr = years > 0 && total > 0 ? (Math.pow(total, 1 / years) - 1) * 100 : 0;
  const dd = drawdownStats(t, eq);
  const sharpe = s > 0 ? (m / s) * Math.sqrt(perYear) : 0;
  return {
    years, perYear, totalReturn: (total - 1) * 100, cagr, vol: s * Math.sqrt(perYear) * 100, sharpe,
    sortino: down > 0 ? (m / down) * Math.sqrt(perYear) : 0,
    calmar: dd.maxDrawdown < 0 ? cagr / -dd.maxDrawdown : 0,
    tStat: sharpe * Math.sqrt(Math.max(0, years)),
    ...dd,
  };
}

// Calendar-year and calendar-month returns, in percent: [{ year, months[12], total }].
export function periodTable(time, equity, start = 0) {
  const rows = new Map();
  let monthBase = equity[start], yearBase = equity[start], prev = equity[start], py = null, pm = null;
  for (let i = start; i < equity.length; i++) {
    const d = new Date(time[i]);
    const y = d.getUTCFullYear(), m = d.getUTCMonth();
    if (py != null && (y !== py || m !== pm)) { monthBase = prev; if (y !== py) yearBase = prev; }
    let row = rows.get(y);
    if (!row) rows.set(y, (row = { year: y, months: new Array(12).fill(null), total: 0 }));
    row.months[m] = (equity[i] / monthBase - 1) * 100;
    row.total = (equity[i] / yearBase - 1) * 100;
    py = y; pm = m; prev = equity[i];
  }
  return [...rows.values()];
}

// Full statistics: the fields older parts of Ballast expect, plus risk, benchmark
// comparison and trade detail.
export function computeStats({ time, equity, bench, trades = [], capital, barsInMarket = 0, start = 0 }) {
  const n = equity.length;
  const c = curveStats(time, equity, start);
  const b = bench ? curveStats(time, bench, start) : null;
  const final = equity[n - 1];

  let beta = NaN, alpha = NaN, corr = NaN;
  if (bench) {
    const rs = dailyReturns(equity, start), rb = dailyReturns(bench, start);
    const ms = mean(rs), mb = mean(rb);
    let cov = 0, vb = 0, vs = 0;
    for (let i = 0; i < rs.length; i++) { cov += (rs[i] - ms) * (rb[i] - mb); vb += (rb[i] - mb) ** 2; vs += (rs[i] - ms) ** 2; }
    if (vb > 0) {
      beta = cov / vb;
      alpha = (ms - beta * mb) * c.perYear * 100;
      corr = vs > 0 ? cov / Math.sqrt(vb * vs) : 0;
    }
  }

  const table = periodTable(time, equity, start);
  const months = table.flatMap((y) => y.months.filter((m) => m != null));
  const full = table.length > 2 ? table.slice(1, -1) : table; // judge best/worst on complete years when there are any
  const benchTable = bench ? periodTable(time, bench, start) : [];
  const beat = table.filter((y, k) => benchTable[k] && y.total > benchTable[k].total + 0.05).length;

  const wins = trades.filter((t) => t.pnl > 0), losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0), grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
  const avg = (list, f) => (list.length ? list.reduce((a, t) => a + f(t), 0) / list.length : 0);

  return {
    // long-standing fields
    finalEquity: final,
    totalReturn: (final / capital - 1) * 100,
    cagr: c.cagr,
    buyHold: b ? b.totalReturn : 0,
    maxDrawdown: c.maxDrawdown,
    sharpe: c.sharpe,
    trades: trades.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    avgTrade: avg(trades, (t) => t.returnPct),
    exposure: (barsInMarket / Math.max(1, n - start)) * 100,
    // risk
    years: c.years, vol: c.vol, sortino: c.sortino, calmar: c.calmar, tStat: c.tStat, ulcer: c.ulcer,
    ddPeakTime: c.peakTime, ddTroughTime: c.troughTime, longestDrawdownDays: c.longestDays,
    bestYear: full.length ? Math.max(...full.map((y) => y.total)) : NaN,
    worstYear: full.length ? Math.min(...full.map((y) => y.total)) : NaN,
    positiveMonths: months.length ? (months.filter((m) => m > 0).length / months.length) * 100 : NaN,
    positiveYears: table.length ? (table.filter((y) => y.total > 0).length / table.length) * 100 : NaN,
    yearsBeatBench: beat, yearsCount: table.length,
    // benchmark
    benchCagr: b?.cagr ?? NaN, benchMaxDrawdown: b?.maxDrawdown ?? NaN, benchSharpe: b?.sharpe ?? NaN, benchVol: b?.vol ?? NaN,
    excessCagr: b ? c.cagr - b.cagr : NaN, beta, alpha, corr,
    // trades
    avgWin: avg(wins, (t) => t.returnPct), avgLoss: avg(losses, (t) => t.returnPct), avgBars: avg(trades, (t) => t.bars),
    bestTrade: trades.length ? Math.max(...trades.map((t) => t.returnPct)) : NaN,
    worstTrade: trades.length ? Math.min(...trades.map((t) => t.returnPct)) : NaN,
    longTrades: trades.filter((t) => t.side !== "short").length, shortTrades: trades.filter((t) => t.side === "short").length,
  };
}
