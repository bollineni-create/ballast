// Ballast's simulation engine. Runs a rule spec (spec.js) over daily bars from one
// or more markets and returns the equity curve, trades, orders and what the rules
// say to do today.
//
// How time works: each symbol's indicators are computed on its own trading days,
// then aligned to one shared calendar (the union of every symbol's days) by carrying
// the last value forward. Rules are read at each bar's close; orders fill at the
// next bar's open. Stops and targets are checked inside each bar against its high
// and low.
//
// What it models: long and short positions, stop / trailing / target / time exits,
// volatility-scaled position sizes, fixed-weight and rotating portfolios with
// inverse-volatility weights, risk-off switches, calendar and drift rebalancing,
// trading costs, and conversion of every market into one base currency.

import { evalNative, symOf, referencedSymbols } from "./spec.js";
import { toSeries } from "./data.js";
import { computeStats } from "./metrics.js";

const DAY = 864e5;
const VOL_WINDOW = 60; // days of returns behind volatility targets and inverse-vol weights
const VOL_EXPR = { t: "ind", ind: "vol", n: 20 };

export function tradedSymbols(spec, fallback) {
  if (spec.kind === "signal") return spec.symbols?.length ? spec.symbols : [fallback];
  return spec.symbols;
}

// Every symbol whose history a spec needs.
export function neededSymbols(spec, fallback) {
  return [...new Set([...tradedSymbols(spec, fallback), ...referencedSymbols(spec)])];
}

// Shared calendar, aligned prices and a rule evaluator for a spec.
// `fx` maps a symbol to bars of its currency's value in the base currency.
function context(spec, barsBySym, fallback, fx = {}) {
  const syms = neededSymbols(spec, fallback);
  for (const s of syms) if (!barsBySym[s]?.length) throw new Error(`No price history for ${s}.`);
  const native = Object.fromEntries(syms.map((s) => [s, toSeries(barsBySym[s])]));
  const start = Math.max(...syms.map((s) => native[s].time[0]));
  const times = [...new Set(syms.flatMap((s) => native[s].time))].filter((t) => t >= start).sort((a, b) => a - b);
  if (times.length < 3) throw new Error(`${syms.join(", ")} don't have enough overlapping history to test together.`);
  const n = times.length;

  // pos[s][i]: index of s's latest own bar on or before calendar day i; has[s][i]: s traded that day.
  const pos = {}, has = {}, px = {}, prev = {}, rate = {};
  for (const s of syms) {
    const d = native[s], p = new Int32Array(n), h = new Uint8Array(n), pv = new Int32Array(n);
    let j = -1, last = -1;
    for (let i = 0; i < n; i++) {
      while (j + 1 < d.time.length && d.time[j + 1] <= times[i]) j++;
      p[i] = j;
      h[i] = j >= 0 && d.time[j] === times[i] ? 1 : 0;
      pv[i] = last; // calendar day of s's previous session
      if (h[i]) last = i;
    }
    pos[s] = p; has[s] = h; prev[s] = pv;
    // On days a market is closed its price stays at the last close.
    const pick = (f) => Float64Array.from(times, (_, i) => (h[i] ? d[f][p[i]] : d.close[p[i]]));
    px[s] = { open: pick("open"), high: pick("high"), low: pick("low"), close: pick("close") };
    // Currency rate into the base currency, carried forward (and back to the first known rate).
    const r = new Float64Array(n).fill(1);
    const fb = fx[s];
    if (fb?.length) {
      let k = -1;
      for (let i = 0; i < n; i++) {
        while (k + 1 < fb.length && fb[k + 1].time <= times[i]) k++;
        r[i] = fb[Math.max(k, 0)].close;
      }
    }
    rate[s] = r;
  }

  const nativeCache = Object.fromEntries(syms.map((s) => [s, new Map()]));
  const alignedCache = new Map();
  const aligned = (e, self) => {
    const sym = symOf(e) ?? self;
    const key = `${sym}|${JSON.stringify(e)}`;
    let out = alignedCache.get(key);
    if (out) return out;
    if (e.t === "num") out = new Float64Array(n).fill(e.v);
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
        const a0 = a[j], a1 = a[i], b0 = b[j], b1 = b[i];
        if (!(Number.isFinite(a0) && Number.isFinite(a1) && Number.isFinite(b0) && Number.isFinite(b1))) return false;
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

  // Daily returns in the base currency, for volatility estimates.
  const retCache = {};
  const rets = (s) => (retCache[s] ??= Float64Array.from(times, (_, i) =>
    (i ? (px[s].close[i] * rate[s][i]) / (px[s].close[i - 1] * rate[s][i - 1]) - 1 : 0)));
  // Annualized volatility of a weighted mix over the last VOL_WINDOW days, as a fraction.
  const perYear = Math.min(366, Math.max(200, ((n - 1) * 365.25 * DAY) / (times[n - 1] - times[0])));
  const mixVol = (weights, i) => {
    const w = Object.entries(weights).filter(([, v]) => v);
    if (!w.length || i < VOL_WINDOW) return NaN;
    let sum = 0, sq = 0;
    for (let k = i - VOL_WINDOW + 1; k <= i; k++) {
      let r = 0;
      for (const [s, v] of w) r += v * rets(s)[k];
      sum += r; sq += r * r;
    }
    const m = sum / VOL_WINDOW;
    return Math.sqrt(Math.max(0, sq / VOL_WINDOW - m * m) * perYear);
  };

  return { syms, native, times, n, pos, has, px, rate, aligned, test, mixVol, perYear };
}

// Entry/exit functions for one symbol on the shared calendar (used by live paper trading).
export function signalRules(spec, barsBySym, symbol) {
  const ctx = context({ ...spec, symbols: [symbol] }, barsBySym, symbol);
  const on = (c) => (c ? (i) => ctx.test(c, symbol, i) : () => false);
  return {
    time: ctx.times, close: ctx.px[symbol].close, hasBar: ctx.has[symbol],
    entry: on(spec.entry), exit: on(spec.exit), shortEntry: on(spec.shortEntry), shortExit: on(spec.shortExit),
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

// options:
//   fallbackSymbol  asset traded by rules with no Trade line
//   capital, costBps
//   from            time (ms): rules are ignored before it and results start there
//   fx              { SYM: bars of that market's currency in the base currency }
//   benchmark       symbol to compare with (must be among the loaded symbols)
export function backtestSpec(spec, barsBySym, { fallbackSymbol = "SPY", capital = 10000, costBps = 10, from = -Infinity, fx = {}, benchmark = null } = {}) {
  // A benchmark outside the strategy stays off the shared calendar, so adding a
  // comparison never changes the strategy's own results.
  const extra = benchmark && barsBySym[benchmark]?.length && !neededSymbols(spec, fallbackSymbol).includes(benchmark) ? benchmark : null;
  const ctx = context(spec, barsBySym, fallbackSymbol, fx);
  const { times, px, has, rate, n } = ctx;
  const cost = costBps / 10000;
  const traded = tradedSymbols(spec, fallbackSymbol);
  const startIndex = Math.min(n - 1, Math.max(0, times.findIndex((t) => t >= from)));
  const live = (i) => i >= startIndex;
  const equity = new Float64Array(n);
  const exposure = new Float64Array(n); // net invested share of equity, -1..1
  const trades = [], orders = [];
  let cash = capital, barsInMarket = 0;
  const shares = Object.fromEntries(ctx.syms.map((s) => [s, 0]));
  const val = (s, i, f = "close") => shares[s] * px[s][f][i] * rate[s][i];
  const value = (i, f = "close") => cash + ctx.syms.reduce((a, s) => a + val(s, i, f), 0);
  const gross = (i, f = "close") => ctx.syms.reduce((a, s) => a + Math.abs(val(s, i, f)), 0);
  const order = (i, s, qty, price) => {
    if (!qty) return;
    const notional = qty * price * rate[s][i];
    cash -= notional + Math.abs(notional) * cost;
    shares[s] += qty;
    if (Math.abs(shares[s]) < 1e-9) shares[s] = 0;
    orders.push({ index: i, time: times[i], symbol: s, side: qty > 0 ? "buy" : "sell", shares: Math.abs(qty), price, value: Math.abs(notional) });
  };

  let weightHistory = null, openPositions = [], now;
  if (spec.kind === "signal") {
    const size = spec.size ?? 1 / traded.length;
    const pos = {}, pending = {};
    const closeOut = (i, s, price, reason) => {
      const p = pos[s], q = Math.abs(shares[s]), fxr = rate[s][i];
      order(i, s, -shares[s], price);
      const back = p.dir > 0 ? q * price * fxr * (1 - cost) : p.outlay + (p.proceeds - q * price * fxr * (1 + cost));
      trades.push({
        symbol: s, side: p.dir > 0 ? "long" : "short", entryIndex: p.index, exitIndex: i, entryTime: times[p.index], exitTime: times[i],
        entryPrice: p.price, exitPrice: price, shares: q, pnl: back - p.outlay, returnPct: (back / p.outlay - 1) * 100,
        bars: p.bars, reason,
      });
      delete pos[s];
    };
    const open = (i, s, dir, o) => {
      // Scale the slice down when the asset is running hotter than the volatility target.
      let frac = size;
      if (spec.volTarget) {
        const v = ctx.aligned(VOL_EXPR, s)[Math.max(0, i - 1)] / 100;
        if (v > 0) frac *= Math.min(1, spec.volTarget / v);
      }
      const eq = value(i, "open");
      const budget = Math.min(Math.max(0, eq - gross(i, "open")), eq * frac);
      const q = budget / (o * rate[s][i] * (1 + cost));
      if (!(q > 0)) return;
      order(i, s, dir * q, o);
      const notional = q * o * rate[s][i];
      pos[s] = { dir, index: i, price: o, outlay: notional * (1 + cost), proceeds: notional * (1 - cost), best: o, bars: 0 };
    };
    // What the rules ask for at bar i's close, given the position in s.
    const decide = (s, i) => {
      const p = pos[s];
      if (!p) {
        if (spec.entry && ctx.test(spec.entry, s, i)) return { act: "long" };
        if (spec.shortEntry && ctx.test(spec.shortEntry, s, i)) return { act: "short" };
        return null;
      }
      if (spec.maxHold && p.bars >= spec.maxHold) return { act: "exit", reason: "time limit" };
      if (p.dir > 0) {
        if (spec.exit && ctx.test(spec.exit, s, i)) return { act: "exit", reason: "signal" };
        if (spec.shortEntry && ctx.test(spec.shortEntry, s, i)) return { act: "short", reason: "reversal" };
      } else {
        if (spec.shortExit && ctx.test(spec.shortExit, s, i)) return { act: "exit", reason: "signal" };
        if (spec.entry && ctx.test(spec.entry, s, i)) return { act: "long", reason: "reversal" };
      }
      return null;
    };

    for (let i = 0; i < n; i++) {
      for (const s of traded) {
        if (!has[s][i]) continue;
        const o = px[s].open[i], h = px[s].high[i], l = px[s].low[i];
        const want = pending[s];
        pending[s] = null;
        if (want) {
          if (pos[s]) closeOut(i, s, o, want.reason || "signal");
          if (want.act === "long") open(i, s, 1, o);
          else if (want.act === "short") open(i, s, -1, o);
        }
        const p = pos[s];
        if (!p) continue;
        p.bars++;
        if (p.dir > 0) {
          const stop = spec.stopLoss ? p.price * (1 - spec.stopLoss) : -Infinity;
          const trail = spec.trailingStop ? p.best * (1 - spec.trailingStop) : -Infinity;
          const floor = Math.max(stop, trail);
          const target = spec.takeProfit ? p.price * (1 + spec.takeProfit) : Infinity;
          if (l <= floor) closeOut(i, s, Math.min(floor, o), floor === stop ? "stop loss" : "trailing stop");
          else if (h >= target) closeOut(i, s, Math.max(target, o), "take profit");
          else p.best = Math.max(p.best, h);
        } else {
          const stop = spec.stopLoss ? p.price * (1 + spec.stopLoss) : Infinity;
          const trail = spec.trailingStop ? p.best * (1 + spec.trailingStop) : Infinity;
          const ceil = Math.min(stop, trail);
          const target = spec.takeProfit ? p.price * (1 - spec.takeProfit) : -Infinity;
          if (h >= ceil) closeOut(i, s, Math.max(ceil, o), ceil === stop ? "stop loss" : "trailing stop");
          else if (l <= target) closeOut(i, s, Math.min(target, o), "take profit");
          else p.best = Math.min(p.best, l);
        }
      }
      if (i < n - 1 && live(i)) {
        for (const s of traded) if (has[s][i] && !pending[s]) pending[s] = decide(s, i);
      }
      if (Object.keys(pos).length) barsInMarket++;
      const eq = value(i);
      equity[i] = eq;
      exposure[i] = eq > 0 ? ctx.syms.reduce((a, s) => a + val(s, i), 0) / eq : 0;
    }
    openPositions = Object.entries(pos).map(([s, p]) => ({ symbol: s, side: p.dir > 0 ? "long" : "short", index: p.index, price: p.price, bars: p.bars, shares: Math.abs(shares[s]), markPrice: px[s].close[n - 1] }));
    // What to do at the next open, from the latest bar.
    now = {
      asOf: times[n - 1],
      actions: traded.map((s) => {
        const p = pos[s], d = decide(s, n - 1);
        const held = p ? (p.dir > 0 ? "long" : "short") : "flat";
        const action = !d ? (p ? "hold" : "wait")
          : d.act === "exit" ? (p.dir > 0 ? "sell" : "cover")
          : d.act === "long" ? (p ? "cover and buy" : "buy") : (p ? "sell and short" : "short");
        const stops = p ? {
          stop: spec.stopLoss ? p.price * (1 - p.dir * spec.stopLoss) : null,
          trail: spec.trailingStop ? p.best * (1 - p.dir * spec.trailingStop) : null,
          target: spec.takeProfit ? p.price * (1 + p.dir * spec.takeProfit) : null,
        } : null;
        return { symbol: s, held, action, reason: d?.reason || null, entryPrice: p?.price ?? null, entryTime: p ? times[p.index] : null, price: px[s].close[n - 1], stops };
      }),
    };
    for (const s of Object.keys(pos)) closeOut(n - 1, s, px[s].close[n - 1], "end of data");
  } else {
    const self = spec.symbols[0];
    const assets = [...new Set([...spec.symbols, ...(spec.riskOff?.hold ? [spec.riskOff.hold] : [])])];
    weightHistory = Object.fromEntries(assets.map((s) => [s, new Float64Array(n)]));
    let pendingTargets = null, pendingLegs = new Set(), lastPeriod = null, rotation = null, riskWas = null, started = false, target = null;
    const rank = (i) => {
      const r = spec.symbols
        .map((s) => ({ s, v: ctx.aligned(spec.rotate.by, s)[i] }))
        .filter((x) => Number.isFinite(x.v))
        .sort((a, b) => b.v - a.v);
      if (r.length < Math.min(spec.rotate.top, spec.symbols.length)) return null; // still warming up
      const picks = r.slice(0, spec.rotate.top).filter((x) => !spec.rotate.absolute || x.v > 0);
      return Object.fromEntries(picks.map((x) => [x.s, 1 / spec.rotate.top]));
    };
    // Applies inverse-volatility weights and the volatility target to a base allocation.
    const shape = (base, i) => {
      let w = base;
      if (spec.weighting === "invvol") {
        const total = Object.values(w).reduce((a, b) => a + b, 0);
        const inv = Object.keys(w).map((s) => [s, 1 / ctx.mixVol({ [s]: 1 }, i)]);
        if (inv.length > 1 && inv.every(([, v]) => Number.isFinite(v) && v > 0)) {
          const sum = inv.reduce((a, [, v]) => a + v, 0);
          w = Object.fromEntries(inv.map(([s, v]) => [s, (v / sum) * total]));
        }
      }
      if (spec.volTarget) {
        const v = ctx.mixVol(w, i);
        if (v > spec.volTarget) w = Object.fromEntries(Object.entries(w).map(([s, x]) => [s, (x * spec.volTarget) / v]));
      }
      return w;
    };
    const dynamic = Boolean(spec.weighting || spec.volTarget);
    // The allocation the rules want at bar i's close, or null while still warming up.
    const wanted = (i, scheduled) => {
      if (spec.rotate && (scheduled || !rotation)) {
        const r = rank(i);
        if (r) rotation = r;
      }
      const base = spec.rotate ? rotation : spec.weights;
      if (!base) return null;
      if (dynamic && i < VOL_WINDOW) return null;
      const riskOff = spec.riskOff ? ctx.test(spec.riskOff.when, self, i) : false;
      return { riskOff, base: riskOff ? (spec.riskOff.hold ? { [spec.riskOff.hold]: 1 } : {}) : base };
    };

    for (let i = 0; i < n; i++) {
      if (pendingTargets) {
        const eq = value(i, "open");
        // Trade only markets open today; closed ones fill at their next session.
        const openToday = assets.filter((s) => pendingLegs.has(s) && has[s][i]);
        openToday.forEach((s) => pendingLegs.delete(s));
        // sells first so they fund the buys
        const legs = openToday.map((s) => {
          const o = px[s].open[i], unit = o * rate[s][i];
          return { s, o, unit, qty: ((pendingTargets[s] || 0) * eq) / (unit * (1 + cost)) - shares[s] };
        }).filter((x) => Math.abs(x.qty * x.unit) > eq * 1e-4).sort((a, b) => a.qty - b.qty);
        for (const leg of legs) {
          // Buys only spend cash on hand: if a sell that funds them is waiting on a closed
          // market, buy what cash allows now and the rest after that sell fills.
          let qty = leg.qty;
          if (qty > 0) {
            const affordable = Math.max(0, cash) / (leg.unit * (1 + cost));
            if (qty > affordable) {
              if ((qty - affordable) * leg.unit > eq * 1e-3) pendingLegs.add(leg.s);
              qty = affordable;
            }
          }
          order(i, leg.s, qty, leg.o);
        }
        if (!pendingLegs.size) pendingTargets = null;
      }
      const eq = value(i);
      equity[i] = eq;
      let inv = 0;
      for (const s of assets) { const w = eq > 0 ? val(s, i) / eq : 0; weightHistory[s][i] = w * 100; inv += w; }
      exposure[i] = inv;
      if (inv > 1e-9) barsInMarket++;
      if (i >= n - 1 || !live(i)) continue;

      const period = spec.rebalance ? periodKey(times[i], spec.rebalance) : null;
      const scheduled = Boolean(spec.rebalance) && period !== lastPeriod;
      const want = wanted(i, scheduled);
      if (!want) continue;
      let go = !started || want.riskOff !== riskWas || scheduled;
      // Weights that move with volatility are only re-shaped when a rebalance is due.
      if (go || !target) target = want.riskOff ? want.base : shape(want.base, i);
      if (!go && spec.band) go = assets.some((s) => Math.abs(weightHistory[s][i] / 100 - (target[s] || 0)) > spec.band);
      if (go) {
        pendingTargets = target;
        pendingLegs = new Set(assets);
        started = true;
        lastPeriod = period;
      }
      riskWas = want.riskOff;
    }
    openPositions = assets.filter((s) => shares[s] > 0).map((s) => ({ symbol: s, side: "long", shares: shares[s], markPrice: px[s].close[n - 1] }));
    // Today's target next to what the test portfolio holds.
    const want = wanted(n - 1, true);
    const tgt = want ? (want.riskOff ? want.base : shape(want.base, n - 1)) : null;
    now = {
      asOf: times[n - 1], riskOff: Boolean(want?.riskOff),
      targets: assets.map((s) => ({ symbol: s, target: tgt ? (tgt[s] || 0) * 100 : null, current: weightHistory[s][n - 1], price: px[s].close[n - 1] })),
      cashTarget: tgt ? Math.max(0, 1 - Object.values(tgt).reduce((a, b) => a + b, 0)) * 100 : null,
    };
  }

  // Benchmark: the chosen symbol, or buy and hold of what the strategy trades.
  let benchSyms = spec.kind === "signal" ? traded : [spec.symbols[0]];
  let benchLabel = `Buy & hold ${benchSyms.join(" + ")}`;
  let bench;
  if (benchmark && ctx.syms.includes(benchmark)) { benchSyms = [benchmark]; benchLabel = `Buy & hold ${benchmark}`; }
  if (extra) {
    // A benchmark outside the strategy: carry its closes onto the strategy's calendar.
    const b = barsBySym[extra], fb = fx[extra];
    let k = -1, f = -1;
    const at = Float64Array.from(times, (t) => {
      while (k + 1 < b.length && b[k + 1].time <= t) k++;
      if (fb?.length) while (f + 1 < fb.length && fb[f + 1].time <= t) f++;
      return k < 0 ? NaN : b[k].close * (fb?.length ? fb[Math.max(f, 0)].close : 1);
    });
    const base = at[startIndex];
    if (Number.isFinite(base)) {
      bench = Float64Array.from(at, (v, i) => (i < startIndex ? capital : (capital * v) / base));
      benchLabel = `Buy & hold ${extra}`;
    }
  }
  bench ??= Float64Array.from(times, (_, i) => (i < startIndex ? capital
    : benchSyms.reduce((a, s) => a + (capital / benchSyms.length) * ((px[s].close[i] * rate[s][i]) / (px[s].close[startIndex] * rate[s][startIndex])), 0)));

  const metrics = computeStats({ time: times, equity, bench, trades, capital, barsInMarket, start: startIndex });
  if (spec.kind === "allocate") Object.assign(metrics, { trades: orders.length, winRate: NaN, profitFactor: NaN, avgTrade: NaN });
  return {
    kind: spec.kind, time: times, equity: Array.from(equity), bench: Array.from(bench), benchLabel,
    trades, orders, openPositions, metrics, traded, weightHistory, exposure, startIndex, now, perYear: ctx.perYear,
    prices: Object.fromEntries(ctx.syms.map((s) => [s, Array.from(px[s].close)])),
  };
}
