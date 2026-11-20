// Backtests a rule spec (spec.js) on daily bars from one or more markets.
//
// Each symbol's indicators are computed on its own trading days, then aligned to a
// shared calendar (the union of every symbol's days) by carrying the last value
// forward, so "buy the Nikkei when the S&P 500 is above its 200-day SMA" compares
// each market on its own sessions. Rules are evaluated at each bar's close and
// orders fill at the next bar's open; stops are checked intrabar against high/low.
// Prices stay in each market's own currency (no FX conversion).

import { evalNative, symOf, referencedSymbols } from "./spec.js";
import { toSeries } from "./data.js";
import { computeMetrics } from "./backtest.js";

const DAY = 864e5;

export function tradedSymbols(spec, fallback) {
  if (spec.kind === "signal") return spec.symbols?.length ? spec.symbols : [fallback];
  return spec.symbols;
}

// Every symbol whose history a spec needs.
export function neededSymbols(spec, fallback) {
  return [...new Set([...tradedSymbols(spec, fallback), ...referencedSymbols(spec)])];
}

function context(spec, barsBySym, fallback) {
  const syms = neededSymbols(spec, fallback);
  for (const s of syms) if (!barsBySym[s]?.length) throw new Error(`No price history for ${s}.`);
  const native = Object.fromEntries(syms.map((s) => [s, toSeries(barsBySym[s])]));
  const start = Math.max(...syms.map((s) => native[s].time[0]));
  const times = [...new Set(syms.flatMap((s) => native[s].time))].filter((t) => t >= start).sort((a, b) => a - b);
  if (times.length < 3) throw new Error(`${syms.join(", ")} don't have enough overlapping history to test together.`);

  // pos[s][i]: index of s's latest native bar on or before calendar day i; has[s][i]: s traded that day.
  const pos = {}, has = {}, px = {}, prev = {};
  for (const s of syms) {
    const d = native[s], p = new Int32Array(times.length), h = new Uint8Array(times.length);
    let j = -1;
    times.forEach((t, i) => {
      while (j + 1 < d.time.length && d.time[j + 1] <= t) j++;
      p[i] = j;
      h[i] = j >= 0 && d.time[j] === t ? 1 : 0;
    });
    pos[s] = p; has[s] = h;
    // prev[s][i]: the calendar day of s's previous session before day i
    const pv = new Int32Array(times.length);
    let last = -1;
    times.forEach((_, i) => { pv[i] = last; if (h[i]) last = i; });
    prev[s] = pv;
    // On days a market is closed its price simply stays at the last close.
    const pick = (f) => Float64Array.from(times, (_, i) => (h[i] ? d[f][p[i]] : d.close[p[i]]));
    px[s] = { open: pick("open"), high: pick("high"), low: pick("low"), close: pick("close") };
  }

  const nativeCache = Object.fromEntries(syms.map((s) => [s, new Map()]));
  const alignedCache = new Map();
  const aligned = (e, self) => {
    const sym = symOf(e) ?? self;
    const key = `${sym}|${JSON.stringify(e)}`;
    if (alignedCache.has(key)) return alignedCache.get(key);
    let out;
    if (e.t === "num") out = new Float64Array(times.length).fill(e.v);
    else {
      if (!native[sym]) throw new Error(`No price history for ${sym}.`);
      const arr = evalNative(e, native[sym], nativeCache[sym]);
      out = Float64Array.from(times, (_, i) => (pos[sym][i] >= 0 ? arr[pos[sym][i]] : NaN));
    }
    alignedCache.set(key, out);
    return out;
  };

  const test = (c, self, i) => {
    switch (c.t) {
      case "cmp": {
        const a = aligned(c.a, self)[i], b = aligned(c.b, self)[i];
        if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
        return c.op === ">" ? a > b : c.op === "<" ? a < b : c.op === ">=" ? a >= b : a <= b;
      }
      case "cross": {
        // Compare with the traded market's previous session, so a cross in another
        // market while this one was closed still counts at its next session.
        const j = has[self]?.[i] ? prev[self][i] : i - 1;
        if (j < 0) return false;
        const a = aligned(c.a, self), b = aligned(c.b, self);
        const [a0, a1, b0, b1] = [a[j], a[i], b[j], b[i]];
        if (![a0, a1, b0, b1].every(Number.isFinite)) return false;
        return c.dir === "above" ? a0 <= b0 && a1 > b1 : a0 >= b0 && a1 < b1;
      }
      case "streak": {
        const sym = c.sym ?? self, p = pos[sym][i], cl = native[sym].close;
        if (p < c.n) return false;
        for (let k = 0; k < c.n; k++) {
          const up = cl[p - k] > cl[p - k - 1], down = cl[p - k] < cl[p - k - 1];
          if (c.dir === "up" ? !up : !down) return false;
        }
        return true;
      }
      case "and": return c.c.every((x) => test(x, self, i));
      case "or": return c.c.some((x) => test(x, self, i));
      case "not": return !test(c.c, self, i);
      default: throw new Error(`Unknown condition ${c.t}`);
    }
  };

  return { syms, native, times, pos, has, px, aligned, test };
}

// Entry/exit functions for one symbol on the shared calendar (used by live paper trading).
export function signalRules(spec, barsBySym, symbol) {
  const ctx = context({ ...spec, symbols: [symbol] }, barsBySym, symbol);
  return {
    time: ctx.times, close: ctx.px[symbol].close, hasBar: ctx.has[symbol],
    entry: (i) => ctx.test(spec.entry, symbol, i),
    exit: (i) => (spec.exit ? ctx.test(spec.exit, symbol, i) : false),
    stopLoss: spec.stopLoss, takeProfit: spec.takeProfit, trailingStop: spec.trailingStop, maxHold: spec.maxHold,
  };
}

const periodKey = (t, freq) => {
  const d = new Date(t);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  switch (freq) {
    case "daily": return t;
    case "weekly": return Math.floor((t / DAY + 3) / 7);
    case "monthly": return y * 12 + m;
    case "quarterly": return y * 4 + Math.floor(m / 3);
    case "yearly": return y;
    default: return 0;
  }
};

export function backtestSpec(spec, barsBySym, { fallbackSymbol = "SPY", capital = 10000, costBps = 10 } = {}) {
  const ctx = context(spec, barsBySym, fallbackSymbol);
  const { times, px, has } = ctx;
  const n = times.length, cost = costBps / 10000;
  const traded = tradedSymbols(spec, fallbackSymbol);
  const equity = new Float64Array(n);
  const trades = [], orders = [];
  let cash = capital, barsInMarket = 0;
  const shares = Object.fromEntries(ctx.syms.map((s) => [s, 0]));
  const value = (i, f = "close") => cash + ctx.syms.reduce((a, s) => a + shares[s] * px[s][f][i], 0);
  const order = (i, s, qty, price) => {
    if (!qty) return;
    const notional = qty * price;
    cash -= notional + Math.abs(notional) * cost;
    shares[s] += qty;
    if (Math.abs(shares[s]) < 1e-9) shares[s] = 0;
    orders.push({ index: i, time: times[i], symbol: s, side: qty > 0 ? "buy" : "sell", shares: Math.abs(qty), price, value: Math.abs(notional) });
  };

  let weightHistory = null, openPositions = [];
  if (spec.kind === "signal") {
    const size = spec.size ?? 1 / traded.length;
    const pos = {}, pending = {};
    const closeOut = (i, s, price, reason) => {
      const p = pos[s];
      const q = shares[s];
      order(i, s, -q, price);
      const proceeds = q * price * (1 - cost);
      trades.push({
        symbol: s, entryIndex: p.index, exitIndex: i, entryTime: times[p.index], exitTime: times[i],
        entryPrice: p.price, exitPrice: price, shares: q, pnl: proceeds - p.outlay, returnPct: (proceeds / p.outlay - 1) * 100,
        bars: p.bars, reason,
      });
      delete pos[s];
    };
    for (let i = 0; i < n; i++) {
      for (const s of traded) {
        if (!has[s][i]) continue;
        const o = px[s].open[i], h = px[s].high[i], l = px[s].low[i];
        if (pending[s] === "buy" && !pos[s]) {
          const budget = Math.min(cash, value(i, "open") * size);
          const q = budget / (o * (1 + cost));
          if (q > 0) {
            order(i, s, q, o);
            pos[s] = { index: i, price: o, outlay: q * o * (1 + cost), peak: o, bars: 0 };
          }
        } else if (pending[s] === "sell" && pos[s]) closeOut(i, s, o, pending.reason?.[s] || "signal");
        pending[s] = null;
        const p = pos[s];
        if (p) {
          p.bars++;
          const stop = spec.stopLoss ? p.price * (1 - spec.stopLoss) : -Infinity;
          const trail = spec.trailingStop ? p.peak * (1 - spec.trailingStop) : -Infinity;
          const floor = Math.max(stop, trail);
          const target = spec.takeProfit ? p.price * (1 + spec.takeProfit) : Infinity;
          if (l <= floor) closeOut(i, s, Math.min(floor, o), floor === stop ? "stop loss" : "trailing stop");
          else if (h >= target) closeOut(i, s, Math.max(target, o), "take profit");
          else p.peak = Math.max(p.peak, h);
        }
      }
      if (i < n - 1) {
        for (const s of traded) {
          if (!has[s][i] || pending[s]) continue;
          if (!pos[s] && ctx.test(spec.entry, s, i)) pending[s] = "buy";
          else if (pos[s] && spec.maxHold && pos[s].bars >= spec.maxHold) { pending[s] = "sell"; (pending.reason ??= {})[s] = "time limit"; }
          else if (pos[s] && spec.exit && ctx.test(spec.exit, s, i)) { pending[s] = "sell"; (pending.reason ??= {})[s] = "signal"; }
        }
      }
      if (Object.keys(pos).length) barsInMarket++;
      equity[i] = value(i);
    }
    openPositions = Object.entries(pos).map(([s, p]) => ({ symbol: s, ...p, shares: shares[s], markPrice: px[s].close[n - 1] }));
    for (const s of Object.keys(pos)) closeOut(n - 1, s, px[s].close[n - 1], "end of data");
  } else {
    // allocate
    const self = spec.symbols[0];
    const assets = [...new Set([...spec.symbols, ...(spec.riskOff?.hold ? [spec.riskOff.hold] : [])])];
    weightHistory = Object.fromEntries(assets.map((s) => [s, new Float64Array(n)]));
    let pendingTargets = null, pendingLegs = new Set(), lastPeriod = null, rotation = null, riskWas = null, started = false;
    const rank = (i) => {
      const r = spec.symbols
        .map((s) => ({ s, v: ctx.aligned(spec.rotate.by, s)[i] }))
        .filter((x) => Number.isFinite(x.v))
        .sort((a, b) => b.v - a.v);
      if (r.length < Math.min(spec.rotate.top, spec.symbols.length)) return null; // still warming up
      const picks = r.slice(0, spec.rotate.top).filter((x) => !spec.rotate.absolute || x.v > 0);
      return Object.fromEntries(picks.map((x) => [x.s, 1 / spec.rotate.top]));
    };
    for (let i = 0; i < n; i++) {
      if (pendingTargets) {
        const eq = value(i, "open");
        // Trade only markets open today; closed ones fill at their next session.
        const open = assets.filter((s) => pendingLegs.has(s) && has[s][i]);
        open.forEach((s) => pendingLegs.delete(s));
        // sells first so they fund the buys
        const legs = open.map((s) => {
          const o = px[s].open[i];
          return { s, o, qty: ((pendingTargets[s] || 0) * eq) / (o * (1 + cost)) - shares[s] };
        }).filter((x) => Math.abs(x.qty * x.o) > eq * 1e-4).sort((a, b) => a.qty - b.qty);
        for (const leg of legs) {
          // Buys only spend cash on hand: if a sell that funds them is waiting on a closed
          // market, buy what cash allows now and the rest after that sell fills.
          let qty = leg.qty;
          if (qty > 0) {
            const affordable = Math.max(0, cash) / (leg.o * (1 + cost));
            if (qty > affordable) {
              if ((qty - affordable) * leg.o > eq * 1e-3) pendingLegs.add(leg.s);
              qty = affordable;
            }
          }
          order(i, leg.s, qty, leg.o);
        }
        if (!pendingLegs.size) pendingTargets = null;
      }
      const eq = value(i);
      equity[i] = eq;
      for (const s of assets) weightHistory[s][i] = eq > 0 ? (shares[s] * px[s].close[i]) / eq * 100 : 0;
      if (assets.some((s) => shares[s] > 0)) barsInMarket++;
      if (i >= n - 1) continue;

      const period = spec.rebalance ? periodKey(times[i], spec.rebalance) : null;
      const scheduled = spec.rebalance && period !== lastPeriod;
      if (spec.rotate && (scheduled || !rotation)) {
        const r = rank(i);
        if (r) rotation = r;
      }
      const base = spec.rotate ? rotation : spec.weights;
      if (!base) continue; // rotation still warming up
      const riskOff = spec.riskOff ? ctx.test(spec.riskOff.when, self, i) : false;
      const target = riskOff ? (spec.riskOff.hold ? { [spec.riskOff.hold]: 1 } : {}) : base;
      let go = !started || riskOff !== riskWas || scheduled;
      if (!go && spec.band) {
        go = assets.some((s) => Math.abs(weightHistory[s][i] / 100 - (target[s] || 0)) > spec.band);
      }
      if (go) {
        pendingTargets = target;
        pendingLegs = new Set(assets);
        started = true;
        lastPeriod = period;
      }
      riskWas = riskOff;
    }
    openPositions = assets.filter((s) => shares[s] > 0).map((s) => ({ symbol: s, shares: shares[s], markPrice: px[s].close[n - 1] }));
  }

  // Benchmark: buy and hold the traded symbols (or the first holding) in equal parts.
  const benchSyms = spec.kind === "signal" ? traded : [spec.symbols[0]];
  const bench = Float64Array.from(times, (_, i) =>
    benchSyms.reduce((a, s) => a + (capital / benchSyms.length) * (px[s].close[i] / px[s].close[0]), 0));
  const metrics = computeMetrics({ time: times, close: Array.from(bench) }, Array.from(equity), trades, capital, barsInMarket);
  if (spec.kind === "allocate") Object.assign(metrics, { trades: orders.length, winRate: NaN, profitFactor: NaN, avgTrade: NaN });
  return {
    kind: spec.kind, time: times, equity: Array.from(equity), bench: Array.from(bench),
    benchLabel: `Buy & hold ${benchSyms.join(" + ")}`,
    trades, orders, openPositions, metrics, traded, weightHistory,
    prices: Object.fromEntries(ctx.syms.map((s) => [s, Array.from(px[s].close)])),
  };
}
