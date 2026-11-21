// Portfolio check-up: what a set of holdings has done, where its risk sits, and
// how it lines up with the owner's goals. Facts and odds, never orders.
import { backtestSpec } from "./engine.js";
import { periodTable, dailyReturns } from "./metrics.js";
import { rng } from "./data.js";

// Rough asset classes for common tickers; anything unknown counts as a single stock.
const CLASS = {
  "US stock funds": "SPY VOO IVV VTI QQQ DIA IWM VUG VTV SCHD SCHB VYM RSP XLK XLF XLE XLV XLY XLP XLI XLU XLB XLRE XLC SMH ARKK ^GSPC ^IXIC ^DJI ^RUT",
  "International stocks": "VXUS VEA VWO EFA EEM IEFA IEMG VEU ACWI VT EWJ FXI INDA ^FTSE ^GDAXI ^FCHI ^STOXX50E ^N225 ^HSI ^NSEI ^KS11 ^AXJO ^GSPTSE ^BVSP 000001.SS",
  Bonds: "BND AGG TLT IEF SHY SHV BIL TIP LQD HYG MUB BNDX VGIT VGSH VGLT GOVT SGOV VCIT JNK EMB",
  "Gold & commodities": "GLD IAU SLV DBC PDBC USO GC=F SI=F CL=F HG=F NG=F",
  "Real estate": "VNQ SCHH IYR XLRE",
};
const CLASS_OF = new Map(Object.entries(CLASS).flatMap(([c, list]) => list.split(" ").map((s) => [s, c])));
export const classOf = (s) => CLASS_OF.get(s) || (/-(USD|USDT|USDC|EUR|GBP)$/.test(s) ? "Crypto" : /=X$/.test(s) ? "Currencies" : "Single stocks");
const GROWTH = new Set(["US stock funds", "International stocks", "Single stocks", "Crypto", "Real estate"]);

const pctile = (arr, p) => { const a = Float64Array.from(arr).sort(); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };

// Where a mix could go: reshuffles its real daily returns (in month-long blocks) into
// `runs` futures of `years` length, adding `monthly` each month.
export function project(returns, { start, years, monthly = 0, target = null, runs = 500, perYear = 252, seed = 11 }) {
  const n = returns.length, days = Math.round(years * perYear), block = 21, rand = rng(seed);
  const marks = Array.from({ length: Math.max(1, Math.round(years)) }, (_, k) => Math.round(((k + 1) * days) / Math.max(1, Math.round(years))) - 1);
  const paths = marks.map(() => new Float64Array(runs)), drops = new Float64Array(runs);
  let hit = 0;
  for (let r = 0; r < runs; r++) {
    let v = start, peak = start, dd = 0, k = 0, m = 0;
    while (k < days) {
      const at = Math.floor(rand() * n);
      for (let j = 0; j < block && k < days; j++, k++) {
        v *= 1 + returns[(at + j) % n];
        if (k % 21 === 20) v += monthly;
        if (v > peak) peak = v;
        dd = Math.min(dd, v / peak - 1);
        if (k === marks[m]) paths[m++][r] = v;
      }
    }
    drops[r] = dd * 100;
    if (target != null && v >= target) hit++;
  }
  const P = [0.1, 0.25, 0.5, 0.75, 0.9];
  return {
    years, paid: start + monthly * 12 * years,
    bands: P.map((p) => [start, ...paths.map((a) => pctile(a, p))]),
    end: Object.fromEntries(P.map((p) => [`p${p * 100}`, pctile(paths.at(-1), p)])),
    typicalDrop: pctile(drops, 0.5), badDrop: pctile(drops, 0.1),
    chance: target != null ? (hit / runs) * 100 : null,
  };
}

// weights: { SYM: fraction of the whole portfolio }; whatever is missing from 1 is cash.
// goals: { years, monthly, target, maxDrop, risk, income }, all optional.
export function checkup({ weights, bars, fx = {}, total = null, goals = {} }) {
  const syms = Object.keys(weights).filter((s) => weights[s] > 0);
  if (!syms.length) throw new Error("No holdings to analyze.");
  const cashWeight = Math.max(0, 1 - syms.reduce((a, s) => a + weights[s], 0));
  const spec = { kind: "allocate", symbols: syms, weights: Object.fromEntries(syms.map((s) => [s, weights[s]])), rotate: null, rebalance: "yearly", band: null, riskOff: null };
  const r = backtestSpec(spec, bars, { capital: 10000, costBps: 0, fx });
  const m = r.metrics, t = r.time, n = t.length;

  // Each holding's own daily returns on the shared calendar, then who drives the swings.
  const ret = Object.fromEntries(syms.map((s) => [s, dailyReturns(r.prices[s])]));
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const mu = Object.fromEntries(syms.map((s) => [s, mean(ret[s])]));
  const cov = (a, b) => { let c = 0; for (let i = 0; i < n - 1; i++) c += (ret[a][i] - mu[a]) * (ret[b][i] - mu[b]); return c / (n - 1); };
  const C = Object.fromEntries(syms.map((a) => [a, Object.fromEntries(syms.map((b) => [b, cov(a, b)]))]));
  const pv = syms.reduce((acc, a) => acc + syms.reduce((x, b) => x + weights[a] * weights[b] * C[a][b], 0), 0);
  const holdings = syms.map((s) => ({
    symbol: s, weight: weights[s] * 100, cls: classOf(s),
    vol: Math.sqrt(C[s][s] * r.perYear) * 100,
    riskShare: pv > 0 ? (weights[s] * syms.reduce((x, b) => x + weights[b] * C[s][b], 0) / pv) * 100 : 0,
  })).sort((a, b) => b.weight - a.weight);
  let pairs = 0, corrSum = 0;
  for (let i = 0; i < syms.length; i++) for (let j = i + 1; j < syms.length; j++) {
    const d = Math.sqrt(C[syms[i]][syms[i]] * C[syms[j]][syms[j]]);
    if (d > 0) { corrSum += C[syms[i]][syms[j]] / d; pairs++; }
  }
  const classes = {};
  for (const h of holdings) classes[h.cls] = (classes[h.cls] || 0) + h.weight;
  if (cashWeight > 0.001) classes.Cash = cashWeight * 100;
  const growth = holdings.filter((h) => GROWTH.has(h.cls)).reduce((a, h) => a + h.weight, 0);
  const effective = 1 / (holdings.reduce((a, h) => a + (h.weight / 100) ** 2, 0) + cashWeight ** 2);
  const years = periodTable(t, r.equity);
  const top = holdings[0], hot = [...holdings].sort((a, b) => b.riskShare - a.riskShare)[0];
  const start = total || 10000;
  const proj = goals.years ? project(dailyReturns(r.equity), { start, years: goals.years, monthly: goals.monthly || 0, target: goals.target ?? null, perYear: r.perYear }) : null;

  // ---------- findings ----------
  const out = [];
  const add = (tone, title, text) => out.push({ tone, title, text });
  const f = (v, d = 0) => v.toFixed(d);
  if (m.years < 5) add("info", "Short history", `These holdings only share ${f(m.years, 1)} years of data (the youngest one sets the limit), so every figure here rests on a small sample.`);

  if (top.weight >= 25 && top.cls === "Single stocks") add("warn", `${top.symbol} is ${f(top.weight)}% of the portfolio`, `One company carries a quarter or more of your money. It has swung ${f(top.vol)}% a year, against ${f(m.vol)}% for the whole mix.`);
  else if (top.weight >= 40 && syms.length > 1) add("info", `${top.symbol} is ${f(top.weight)}% of the portfolio`, `The largest holding is a ${top.cls.toLowerCase()} position; the mix behaves like about ${f(effective, 1)} equal holdings.`);
  if (hot.riskShare >= 45 && hot.riskShare - hot.weight >= 12) add("warn", `${hot.symbol} drives ${f(hot.riskShare)}% of the swings`, `It is ${f(hot.weight)}% of the money but causes ${f(hot.riskShare)}% of the ups and downs.`);
  if (pairs && corrSum / pairs > 0.7 && syms.length >= 3) add("warn", "The holdings move together", `Average correlation between them is ${f(corrSum / pairs, 2)}. In a sell-off they are likely to fall at the same time, so the count of holdings overstates the diversification.`);
  else if (pairs && corrSum / pairs < 0.35) add("good", "The holdings offset each other", `Average correlation between them is ${f(corrSum / pairs, 2)}, which is why the mix swings less (${f(m.vol)}% a year) than its parts.`);

  if (goals.maxDrop) {
    if (-m.maxDrawdown > goals.maxDrop * 1.1) add("warn", `It has fallen further than your ${goals.maxDrop}% limit`, `This mix dropped ${f(-m.maxDrawdown)}% at its worst (${new Date(m.ddPeakTime).getUTCFullYear()}–${new Date(m.ddTroughTime).getUTCFullYear()}) and spent ${Math.round(m.longestDrawdownDays / 30.4)} months below its high.${proj ? ` Over ${goals.years} years, a typical future includes a ${f(-proj.typicalDrop)}% drop.` : ""}`);
    else add("good", `Inside your ${goals.maxDrop}% limit so far`, `Its worst drop in ${f(m.years, 1)} years was ${f(-m.maxDrawdown)}%.${proj && -proj.badDrop > goals.maxDrop ? ` A rough stretch could still go past it: 1 future in 10 falls ${f(-proj.badDrop)}% or more.` : ""}`);
  }
  if (goals.risk === "low" && (growth > 50 || m.vol > 10)) add("warn", "Riskier than conservative", `${f(growth)}% is in stocks or other growth assets and the mix has swung ${f(m.vol)}% a year; its worst year was ${f(m.worstYear)}%.`);
  if (goals.risk === "high" && growth < 60) add("info", "Cautious for an aggressive goal", `Only ${f(growth)}% is in growth assets; the rest steadies the ride and has held returns to ${f(m.cagr, 1)}% a year.`);
  if (goals.years && goals.years <= 4 && growth > 50) add("warn", `${goals.years} years is short for this much stock`, `${f(growth)}% is in growth assets. Over stretches this short the mix has lost as much as ${f(-m.maxDrawdown)}%, with little time to recover.`);
  if (cashWeight >= 0.2 && (goals.years || 0) >= 10) add("info", `${f(cashWeight * 100)}% is in cash`, `Over ${goals.years} years cash is the part least likely to keep up with prices.`);
  if (goals.income && !holdings.some((h) => h.cls === "Bonds" || /^(SCHD|VYM|DVY|HDV|JEPI|JEPQ)$/.test(h.symbol))) add("info", "Little here is built for income", "None of the holdings is a bond or dividend fund, so income would mostly come from selling shares.");

  if (proj && goals.target != null) {
    const need = start > 0 && !goals.monthly ? (Math.pow(goals.target / start, 1 / goals.years) - 1) * 100 : null;
    add(proj.chance >= 70 ? "good" : proj.chance >= 40 ? "info" : "warn", `${f(proj.chance)}% of futures reach your target`,
      `Out of 500 futures built from this mix's own history, ${f(proj.chance)}% end at or above the target after ${goals.years} years. The middle outcome is ${money(proj.end.p50)}; 1 in 10 ends below ${money(proj.end.p10)}.${need != null ? ` Without adding money you would need ${f(need, 1)}% a year; the mix has earned ${f(m.cagr, 1)}%.` : ""}`);
  }
  if (proj && m.cagr > 12) add("info", "The projection leans on an unusually good past", `It reuses this mix's own history, which earned ${f(m.cagr, 1)}% a year. Broad stock markets have earned closer to 7 to 10% over the long run, so read the odds above as a best case rather than an expectation.`);
  if (!out.some((x) => x.tone === "warn")) add("good", "Nothing stands out", "No concentration, drawdown or goal mismatch crossed a threshold in this check.");

  return { result: r, metrics: m, holdings, classes, cashWeight: cashWeight * 100, growth, effective, avgCorr: pairs ? corrSum / pairs : null, years, projection: proj, findings: out, start };
}

function money(v) { return `$${Math.round(v).toLocaleString("en-US")}`; }
