// The rule spec behind a plain-English strategy, and the renderer that turns a spec
// back into canonical English. Canonical English is what the user edits; parse.js
// reads it (or any looser phrasing) back into the same spec.
//
// Expressions (values per bar)
//   { t: "price", f: "close"|"open"|"high"|"low"|"volume", sym? }
//   { t: "num", v }                                   percents are plain numbers (5 = 5%)
//   { t: "ind", ind, n, ...params, sym? }             see INDICATORS
//   { t: "ago", e, n }                                e, n bars earlier
//   { t: "pct", e, p }                                e * (1 + p/100)
// Conditions
//   { t: "cmp", a, op: ">"|"<"|">="|"<=", b }   { t: "cross", a, dir: "above"|"below", b }
//   { t: "and"|"or", c: [...] }   { t: "not", c }   { t: "streak", dir: "up"|"down", n, sym? }
// A missing `sym` means "the asset being traded" (or each asset, when ranking).
//
// Strategies
//   signal:   { kind: "signal", symbols, entry, exit, shortEntry, shortExit, stopLoss, takeProfit, trailingStop,
//               maxHold, size, volTarget }                      entry and/or shortEntry is set
//   allocate: { kind: "allocate", symbols, weights, rotate: { top, by, absolute }, rebalance, band,
//               riskOff: { when, hold }, weighting: "invvol"|null, volTarget }
//   volTarget is an annualized volatility as a fraction (0.12 = 12%).

import { sma, ema, rsi, atr, bollinger, macd, highest, lowest } from "./indicators.js";

export const INDICATORS = {
  sma: { label: (e) => `${e.n}-day SMA`, pct: false },
  ema: { label: (e) => `${e.n}-day EMA`, pct: false },
  rsi: { label: (e) => `${e.n}-day RSI`, pct: false },
  atr: { label: (e) => `${e.n}-day ATR`, pct: false },
  ret: { label: (e) => `${e.n}-day return`, pct: true },
  hi: { label: (e) => `${e.n}-day high`, pct: false },
  lo: { label: (e) => `${e.n}-day low`, pct: false },
  bbu: { label: (e) => `upper Bollinger Band (${e.n}, ${e.m})`, pct: false },
  bbm: { label: (e) => `middle Bollinger Band (${e.n}, ${e.m})`, pct: false },
  bbl: { label: (e) => `lower Bollinger Band (${e.n}, ${e.m})`, pct: false },
  macd: { label: (e) => `MACD line (${e.n}, ${e.s}, ${e.g})`, pct: false },
  macds: { label: (e) => `MACD signal line (${e.n}, ${e.s}, ${e.g})`, pct: false },
  macdh: { label: (e) => `MACD histogram (${e.n}, ${e.s}, ${e.g})`, pct: false },
  avgvol: { label: (e) => `${e.n}-day average volume`, pct: false },
  dd: { label: (e) => `drawdown from ${e.n}-day high`, pct: true },
  vol: { label: (e) => `${e.n}-day volatility`, pct: true },
};

// ---------- evaluation on one symbol's own bars ----------
// `d` is { time, open, high, low, close, volume } for one symbol. Returns an array
// aligned with d.close. `cache` memoizes by expression.
export function evalNative(e, d, cache = new Map()) {
  if (e.t === "num") return new Array(d.close.length).fill(e.v);
  const key = JSON.stringify(e);
  if (cache.has(key)) return cache.get(key);
  let out;
  const c = d.close;
  switch (e.t) {
    case "price": out = d[e.f]; break;
    case "ago": {
      const s = evalNative(e.e, d, cache);
      out = s.map((_, i) => (i >= e.n ? s[i - e.n] : NaN));
      break;
    }
    case "pct": out = evalNative(e.e, d, cache).map((v) => v * (1 + e.p / 100)); break;
    case "ind":
      switch (e.ind) {
        case "sma": out = sma(c, e.n); break;
        case "ema": out = ema(c, e.n); break;
        case "rsi": out = rsi(c, e.n); break;
        case "atr": out = atr(d.high, d.low, c, e.n); break;
        case "ret": out = c.map((v, i) => (i >= e.n ? (v / c[i - e.n] - 1) * 100 : NaN)); break;
        // Highs and lows of the n bars BEFORE this one, so "price is above its 20-day high" can fire.
        case "hi": { const h = highest(d.high, e.n); out = h.map((_, i) => (i >= 1 ? h[i - 1] : NaN)); break; }
        case "lo": { const l = lowest(d.low, e.n); out = l.map((_, i) => (i >= 1 ? l[i - 1] : NaN)); break; }
        case "bbu": out = bollinger(c, e.n, e.m).upper; break;
        case "bbm": out = bollinger(c, e.n, e.m).mid; break;
        case "bbl": out = bollinger(c, e.n, e.m).lower; break;
        case "macd": out = macd(c, e.n, e.s, e.g).macd; break;
        case "macds": out = macd(c, e.n, e.s, e.g).signal; break;
        case "macdh": out = macd(c, e.n, e.s, e.g).hist; break;
        case "avgvol": out = sma(d.volume, e.n); break;
        case "dd": { const h = highest(c, e.n); out = c.map((v, i) => (h[i] > 0 ? (1 - v / h[i]) * 100 : NaN)); break; }
        case "vol": {
          const r = c.map((v, i) => (i ? Math.log(v / c[i - 1]) : NaN));
          out = r.map((_, i) => {
            if (i < e.n) return NaN;
            let s = 0, s2 = 0;
            for (let j = i - e.n + 1; j <= i; j++) { s += r[j]; s2 += r[j] * r[j]; }
            const m = s / e.n;
            return Math.sqrt(Math.max(0, s2 / e.n - m * m)) * Math.sqrt(252) * 100;
          });
          break;
        }
        default: throw new Error(`Unknown indicator ${e.ind}`);
      }
      break;
    default: throw new Error(`Unknown expression ${e.t}`);
  }
  cache.set(key, out);
  return out;
}

// The symbol an expression reads, or undefined for "the asset being traded".
export function symOf(e) {
  if (!e) return undefined;
  if (e.t === "ago" || e.t === "pct") return symOf(e.e);
  return e.sym;
}

// Every symbol named anywhere in a spec (traded, held or referenced by a rule).
export function referencedSymbols(spec) {
  const out = new Set(spec.symbols || []);
  const walk = (x) => {
    if (!x || typeof x !== "object") return;
    if (x.sym) out.add(x.sym);
    for (const v of Object.values(x)) if (typeof v === "object") walk(v);
  };
  walk(spec.entry); walk(spec.exit); walk(spec.shortEntry); walk(spec.shortExit); walk(spec.rotate); walk(spec.riskOff?.when);
  if (spec.riskOff?.hold) out.add(spec.riskOff.hold);
  if (spec.weights) Object.keys(spec.weights).forEach((s) => out.add(s));
  return [...out];
}

// Longest lookback in bars a spec needs before its rules mean anything.
export function warmup(spec) {
  let w = 1;
  const walk = (x) => {
    if (!x || typeof x !== "object") return;
    if (x.t === "ind") w = Math.max(w, (x.s || 0) + (x.g || 0), x.n + 1);
    if (x.t === "ago") w = Math.max(w, x.n + 1);
    if (x.t === "streak") w = Math.max(w, x.n + 1);
    for (const v of Object.values(x)) if (typeof v === "object") walk(v);
  };
  walk(spec.entry); walk(spec.exit); walk(spec.shortEntry); walk(spec.shortExit); walk(spec.rotate); walk(spec.riskOff?.when);
  if (spec.volTarget || spec.weighting) w = Math.max(w, 61);
  return w;
}

// ---------- negation (for "hold X when ..., otherwise Y") ----------
const FLIP = { ">": "<=", "<": ">=", ">=": "<", "<=": ">" };
export function negate(c) {
  if (c.t === "cmp") return { ...c, op: FLIP[c.op] };
  if (c.t === "and") return { t: "or", c: c.c.map(negate) };
  if (c.t === "or") return { t: "and", c: c.c.map(negate) };
  if (c.t === "not") return c.c;
  return { t: "not", c };
}

// ---------- canonical English ----------
const fmt = (v) => String(Math.round(v * 10000) / 10000);
const isPct = (e) => e?.t === "ind" && INDICATORS[e.ind].pct;

export function exprText(e, pctNums = false) {
  switch (e.t) {
    case "num": return `${fmt(e.v)}${pctNums ? "%" : ""}`;
    case "price": return `${{ close: "price", open: "open", high: "high", low: "low", volume: "volume" }[e.f]}${e.sym ? ` of ${e.sym}` : ""}`;
    case "ind": return `${INDICATORS[e.ind].label(e)}${e.sym ? ` of ${e.sym}` : ""}`;
    case "ago": return `${exprText(e.e)} ${e.n} ${e.n === 1 ? "day" : "days"} ago`;
    case "pct": return `${fmt(Math.abs(e.p))}% ${e.p >= 0 ? "above" : "below"} ${exprText(e.e)}`;
    default: throw new Error(`Unknown expression ${e.t}`);
  }
}

const OP_WORD = { ">": "above", "<": "below", ">=": "at least", "<=": "at most" };
const PCT_PHRASE = { ">+": "more than", ">=+": "at least", "<-": "more than", "<=-": "at least", "<+": "less than", ">-": "less than" };

export function condText(c, parent) {
  switch (c.t) {
    case "cmp": {
      const a = exprText(c.a, isPct(c.b));
      if (c.b.t === "pct") {
        const lead = PCT_PHRASE[`${c.op}${c.b.p >= 0 ? "+" : "-"}`] || "at least";
        return `${a} is ${lead} ${exprText(c.b)}`;
      }
      return `${a} is ${OP_WORD[c.op]} ${exprText(c.b, isPct(c.a))}`;
    }
    case "cross": return `${exprText(c.a, isPct(c.b))} crosses ${c.dir} ${exprText(c.b, isPct(c.a))}`;
    case "streak": return `${c.sym ? `price of ${c.sym}` : "price"} closes ${c.dir} ${c.n} days in a row`;
    case "not": return `not (${condText(c.c)})`;
    case "and": case "or": {
      const s = c.c.map((x) => condText(x, c.t)).join(` ${c.t} `);
      return parent && parent !== c.t ? `(${s})` : s;
    }
    default: throw new Error(`Unknown condition ${c.t}`);
  }
}

const pctOf = (f) => fmt(f * 100);

// Canonical, line-per-rule English for a spec. parse(describe(spec)) gives back spec.
export function describe(spec) {
  const lines = [];
  if (spec.kind === "signal") {
    if (spec.symbols?.length) lines.push(`Trade ${spec.symbols.join(", ")}`);
    if (spec.entry) lines.push(`Buy when ${condText(spec.entry)}`);
    if (spec.exit) lines.push(`Sell when ${condText(spec.exit)}`);
    if (spec.shortEntry) lines.push(`Short when ${condText(spec.shortEntry)}`);
    if (spec.shortExit) lines.push(`Cover when ${condText(spec.shortExit)}`);
    if (spec.stopLoss) lines.push(`Stop loss ${pctOf(spec.stopLoss)}%`);
    if (spec.takeProfit) lines.push(`Take profit ${pctOf(spec.takeProfit)}%`);
    if (spec.trailingStop) lines.push(`Trailing stop ${pctOf(spec.trailingStop)}%`);
    if (spec.maxHold) lines.push(`Sell after ${spec.maxHold} days`);
    if (spec.size) lines.push(`Position size ${pctOf(spec.size)}%`);
    if (spec.volTarget) lines.push(`Target ${pctOf(spec.volTarget)}% volatility`);
  } else {
    if (spec.rotate) {
      lines.push(`Rotate among ${spec.symbols.join(", ")}`);
      lines.push(`Hold the top ${spec.rotate.top} by ${exprText(spec.rotate.by)}`);
      if (spec.rotate.absolute) lines.push(`Only hold assets whose ${exprText(spec.rotate.by)} is above 0`);
    } else {
      lines.push(`Hold ${Object.entries(spec.weights).map(([s, w]) => `${pctOf(w)}% ${s}`).join(", ")}`);
    }
    if (spec.weighting === "invvol") lines.push("Weight by inverse volatility");
    if (spec.riskOff) lines.push(`When ${condText(spec.riskOff.when)}, hold ${spec.riskOff.hold || "cash"} instead`);
    if (spec.volTarget) lines.push(`Target ${pctOf(spec.volTarget)}% volatility`);
    if (spec.rebalance) lines.push(`Rebalance ${spec.rebalance}`);
    if (spec.band) lines.push(`Rebalance when any holding drifts ${pctOf(spec.band)}% from its target`);
  }
  return lines.join("\n");
}

// One-paragraph summary for the chat log and library cards.
export function summarize(spec) {
  if (spec.kind === "signal") {
    const who = spec.symbols?.length ? spec.symbols.join(", ") : "the chosen symbol";
    const an = (v) => (/^(8|11|18)(\D|$)|^8\d/.test(String(v)) ? "an" : "a");
    const risk = [
      spec.stopLoss && `${an(pctOf(spec.stopLoss))} ${pctOf(spec.stopLoss)}% stop loss`, spec.takeProfit && `${an(pctOf(spec.takeProfit))} ${pctOf(spec.takeProfit)}% take profit`,
      spec.trailingStop && `${an(pctOf(spec.trailingStop))} ${pctOf(spec.trailingStop)}% trailing stop`, spec.maxHold && `${an(spec.maxHold)} ${spec.maxHold}-day time limit`,
    ].filter(Boolean);
    const long = spec.entry ? `Buys ${who} when ${condText(spec.entry)}${spec.exit ? `, and sells when ${condText(spec.exit)}` : ""}.` : "";
    const short = spec.shortEntry ? ` ${spec.entry ? "Shorts it" : `Shorts ${who}`} when ${condText(spec.shortEntry)}${spec.shortExit ? `, and covers when ${condText(spec.shortExit)}` : ""}.` : "";
    const vt = spec.volTarget ? ` Sizes each position for about ${pctOf(spec.volTarget)}% annual volatility.` : "";
    return `${long}${short}${risk.length ? ` Exits early on ${risk.join(", ")}.` : ""}${vt}`.trim();
  }
  const what = spec.rotate
    ? `Holds the top ${spec.rotate.top} of ${spec.symbols.join(", ")} by ${exprText(spec.rotate.by)}${spec.rotate.absolute ? " (only while it is positive)" : ""}`
    : `Holds ${Object.entries(spec.weights).map(([s, w]) => `${pctOf(w)}% ${s}`).join(", ")}`;
  const when = spec.rebalance ? `, rebalanced ${spec.rebalance}` : spec.band ? `, rebalanced when a holding drifts ${pctOf(spec.band)}% from target` : "";
  const off = spec.riskOff ? ` Switches to ${spec.riskOff.hold || "cash"} while ${condText(spec.riskOff.when)}.` : "";
  const wt = spec.weighting === "invvol" ? " Calmer assets get bigger weights (inverse volatility)." : "";
  const vt = spec.volTarget ? ` Holds some cash when markets are rough, aiming for about ${pctOf(spec.volTarget)}% annual volatility.` : "";
  return `${what}${when}.${wt}${off}${vt}`;
}

// A short default name, e.g. "SMA 50/200 cross on SPY" or "60/40 SPY/TLT".
export function nameFor(spec) {
  const on = spec.symbols?.length ? ` on ${spec.symbols.join(", ")}` : "";
  if (spec.kind === "allocate") {
    if (spec.rotate) return `Top ${spec.rotate.top} of ${spec.symbols.length} by ${exprText(spec.rotate.by)}`;
    const w = Object.entries(spec.weights);
    const base = w.length === 1 ? `Hold ${w[0][0]}` : `${w.map(([, v]) => Math.round(v * 100)).join("/")} ${w.map(([s]) => s).join("/")}`;
    if (spec.weighting === "invvol") return `Risk-weighted ${w.map(([s]) => s).join("/")}`;
    return spec.riskOff ? `${base}, ${spec.riskOff.hold || "cash"} when risk-off` : base;
  }
  const e = spec.entry || spec.shortEntry;
  const short = spec.entry ? "" : "Short ";
  const label = (x) => (x.t === "ind" ? INDICATORS[x.ind].label(x).replace(/^\d+-day /, "").replace(/ \(.*\)$/, "") : x.t === "price" ? (x.sym ? `${x.sym}` : "Price") : "");
  if (e.t === "cross" && e.a.t === "ind" && e.b.t === "ind" && e.a.ind === e.b.ind) return `${short}${e.a.ind.toUpperCase()} ${e.a.n}/${e.b.n} cross${on}`;
  if (e.t === "streak") return `${short}${e.n} ${e.dir} days${on}`;
  const first = e.t === "and" || e.t === "or" ? e.c[0] : e;
  const what = first.a ? label(first.a) || label(first.b) : "";
  return `${short}${what ? `${what} ` : ""}${first.t === "cross" ? "cross" : "rule"}${on}`.replace(/^./, (c) => c.toUpperCase());
}
