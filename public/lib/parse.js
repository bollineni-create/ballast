// Plain English -> rule spec (see spec.js). Reads Ballast's canonical rule lines
// exactly, and a wide range of looser phrasing: "buy QQQ when the VIX closes above 30,
// sell after 20 days, 5% stop", "60/40 stocks and bonds rebalanced quarterly",
// "each month hold the top 2 of SPY, EFA, EEM and TLT by 6-month momentum".
//
// parseStrategy(text) -> { spec, notes: [...], unparsed: [...] } or throws ParseError.

import { replaceNames } from "./markets.js";
import { negate } from "./spec.js";

export class ParseError extends Error {}

const WORD_NUM = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const UNIT_DAYS = { d: 1, day: 1, bar: 1, period: 1, session: 1, wk: 5, week: 5, mo: 21, month: 21, yr: 252, year: 252 };
const CAPS_WORDS = new Set("I A AN SMA EMA MA DMA RSI MACD ATR ROC BB AND OR NOT IF WHEN THE ETF ETFS OK US USD SELL BUY HOLD STOP TP SL DAY DAYS".split(" "));

const periodDays = (n, unit) => {
  const u = unit.toLowerCase().replace(/s$/, "").replace(/^trading /, "");
  if ((u === "week" || u === "wk") && n === 52) return 252;
  return Math.round(n * (UNIT_DAYS[u] ?? 1));
};

// ---------- tokens ----------
// { k: "sym", v } { k: "num", v, pct } { k: "per", n } { k: "w", v } { k: "p", v }
const TOKEN = /(\^[A-Za-z0-9.]+)|(\d{4,6}\.[A-Z]{1,3})\b|((?<![A-Za-z0-9.])-\d+(?:\.\d+)?|\d+(?:\.\d+)?)(\s*%)?(?:\s*-?\s*(trading days?|days?|weeks?|months?|years?|bars?|periods?|sessions?|wks?|mos?|yrs?|d)\b)?|([A-Z][A-Z0-9]*(?:[.\-][A-Z0-9]+)*(?:=[XF])?)(?![a-z])|('s\b|[a-z][a-z]*|[A-Za-z]+)|(>=|<=|[<>()=,\/&+])/g;

export function tokenize(text) {
  const out = [];
  for (const m of text.matchAll(TOKEN)) {
    const [, caret, numTicker, num, pct, unit, caps, word, punct] = m;
    if (caret) out.push({ k: "sym", v: caret.toUpperCase() });
    else if (numTicker) out.push({ k: "sym", v: numTicker });
    else if (num != null) {
      if (unit && !pct) out.push({ k: "per", n: periodDays(Number(num), unit) });
      else out.push({ k: "num", v: Number(num), pct: Boolean(pct) });
    } else if (caps) {
      if (CAPS_WORDS.has(caps) || (caps.length === 1 && !/[.\-=]/.test(caps))) out.push({ k: "w", v: caps.toLowerCase() });
      else out.push({ k: "sym", v: caps });
    } else if (word) {
      const w = word.toLowerCase();
      if (w in WORD_NUM && w !== "one") out.push({ k: "num", v: WORD_NUM[w], pct: false, word: true });
      else out.push({ k: "w", v: w });
    } else if (punct) out.push({ k: "p", v: punct });
  }
  return out;
}

function normalize(text) {
  return replaceNames(String(text))
    .replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/≥/g, ">=").replace(/≤/g, "<=").replace(/–|—/g, " - ")
    .replace(/\b(it|that|he|she)'s\b/gi, "$1 is").replace(/\b(they|we)'re\b/gi, "$1 are")
    .replace(/\b(sma|ema|rsi|atr|ma|dma)(\d+)/gi, "$1 $2")
    .replace(/(\d)(sma|ema|rsi|ma|dma)\b/gi, "$1 $2")
    .replace(/\b(\d+)\s*(?:-|\s)?\s*d\s*(sma|ema|ma)\b/gi, "$1-day $2")
    .replace(/\((?:[a-z\s]+|[^()]*σ[^()]*)\)/gi, (m) => (/σ/.test(m) ? m.replace(/σ/g, "") : " "))
    .replace(/\bgolden\s+cross\b/gi, "50-day SMA crosses above the 200-day SMA")
    .replace(/\bdeath\s+cross\b/gi, "50-day SMA crosses below the 200-day SMA")
    .replace(/\b(?:is\s+|gets\s+|becomes\s+|turns\s+)?(oversold|overbought)\b/gi, (m, w, off, str) =>
      `${/rsi/i.test(str.slice(Math.max(0, off - 40), off)) ? "" : " RSI"} is ${w.toLowerCase() === "oversold" ? "below 30" : "above 70"}`);
}

// ---------- condition grammar ----------
const FILL = new Set(["the", "a", "an", "is", "are", "was", "be", "being", "currently", "now", "still", "does", "do"]);
const VERB_FILL = new Set(["is", "are", "closes", "close", "closed", "trades", "trading", "stays", "remains", "finishes", "ends", "sits", "prints", "gets", "has", "was", "the", "currently", "now", "still", "back", "price", "settles"]);
const ABOVE = new Set(["above", "over", "greater", "higher", "exceeds", "more", "beyond"]);
const BELOW = new Set(["below", "under", "less", "lower", "beneath", "underneath"]);
const CROSS_VERBS = new Set(["crosses", "cross", "crossed", "crossing", "breaks", "break", "broke", "rises", "rise", "climbs", "jumps", "moves", "goes", "pops", "falls", "drops", "dips", "sinks", "slips", "goes", "turns"]);
const UP_VERBS = new Set(["rises", "rise", "gains", "gain", "jumps", "climbs", "rallies", "increases", "surges", "up", "advances", "rose", "gained"]);
const DOWN_VERBS = new Set(["falls", "fall", "drops", "drop", "declines", "loses", "sinks", "dips", "plunges", "tumbles", "slides", "down", "decreases", "fell", "dropped", "pulls"]);

class Parser {
  constructor(tokens, src, opts = {}) { this.t = tokens; this.i = 0; this.src = src; this.it = opts.it; this.lastA = null; this.firstA = null; }
  peek(o = 0) { return this.t[this.i + o]; }
  isW(v, o = 0) { const x = this.peek(o); return x && x.k === "w" && (v instanceof Set ? v.has(x.v) : Array.isArray(v) ? v.includes(x.v) : x.v === v); }
  isP(v, o = 0) { const x = this.peek(o); return x && x.k === "p" && x.v === v; }
  acceptW(v) { if (this.isW(v)) return this.t[this.i++].v; return null; }
  acceptSeq(...ws) {
    for (let j = 0; j < ws.length; j++) if (!this.isW(ws[j], j)) return false;
    this.i += ws.length;
    return true;
  }
  done() { return this.i >= this.t.length; }
  fail(msg) { throw new ParseError(msg || `Couldn't read "${this.src}"`); }
  skip(set) { while (this.isW(set)) this.i++; }

  // cond := and ("or" and)*
  cond() {
    const parts = [this.and()];
    while (this.acceptW("or")) parts.push(this.and());
    return parts.length > 1 ? { t: "or", c: parts.flatMap((p) => (p.t === "or" ? p.c : [p])) } : parts[0];
  }
  and() {
    const parts = [this.unary()];
    while (this.acceptW(["and", "but", "while"]) || (this.isP("&") && this.i++ >= 0)) {
      this.acceptW("also");
      parts.push(this.unary());
    }
    return parts.length > 1 ? { t: "and", c: parts.flatMap((p) => (p.t === "and" ? p.c : [p])) } : parts[0];
  }
  unary() {
    this.skip(new Set(["when", "if", "whenever", "once"]));
    if (this.acceptW("not")) {
      this.acceptSeq("the", "case", "that");
      return { t: "not", c: this.unary() };
    }
    if (this.isP("(")) {
      this.i++;
      const c = this.cond();
      if (!this.isP(")")) this.fail("Missing a closing parenthesis");
      this.i++;
      return c;
    }
    return this.predicate();
  }

  // Streaks: "price closes up 3 days in a row", "3 down days in a row", "SPY falls 4 days straight".
  streak() {
    const start = this.i;
    let sym;
    if (this.peek()?.k === "sym") sym = this.t[this.i++].v;
    if (this.acceptW("price") && this.acceptW("of") && this.peek()?.k === "sym") sym = this.t[this.i++].v;
    this.skip(VERB_FILL);
    const verbFirst = this.acceptW(["up", "higher", "down", "lower", "rises", "falls", "gains", "drops", "declines", "advances"]);
    let n = null;
    const tk = this.peek();
    if (tk?.k === "per") { n = tk.n; this.i++; }
    else if (tk?.k === "num" && !tk.pct) { n = tk.v; this.i++; }
    const dirAfter = !verbFirst && this.acceptW(["up", "down", "higher", "lower", "green", "red", "straight", "consecutive"]);
    this.acceptW(["days", "day", "sessions", "bars", "closes", "straight", "consecutive"]);
    this.acceptW(["up", "down", "higher", "lower"]);
    const row = this.acceptSeq("in", "a", "row") || this.acceptW(["straight", "consecutively"]) || this.acceptSeq("in", "row");
    const dirWord = verbFirst || dirAfter || this.t.slice(start, this.i).find((x) => x.k === "w" && ["up", "down", "higher", "lower", "green", "red"].includes(x.v))?.v;
    if (n && row && dirWord) {
      const dir = ["up", "higher", "rises", "gains", "advances", "green"].includes(dirWord) ? "up" : "down";
      return { t: "streak", dir, n, ...(sym && { sym }) };
    }
    this.i = start;
    return null;
  }

  predicate() {
    const st = this.streak();
    if (st) return st;
    this.skip(FILL);
    const start = this.i;
    let a = this.operand({});
    if (!a) a = this.lastA || { t: "price", f: "close" };
    this.lastA = a;
    this.firstA ??= a;
    const ctx = { sym: a.sym ?? a.e?.sym, like: a };
    this.skip(VERB_FILL);

    // between X and Y
    if (this.acceptW("between")) {
      const lo = this.operand(ctx); this.acceptW("and"); const hi = this.operand(ctx);
      if (!lo || !hi) this.fail();
      return { t: "and", c: [{ t: "cmp", a, op: ">=", b: lo }, { t: "cmp", a, op: "<=", b: hi }] };
    }

    // symbolic comparators
    if (this.peek()?.k === "p" && [">", "<", ">=", "<=", "="].includes(this.peek().v)) {
      let op = this.t[this.i++].v;
      if (op === "=") op = ">=";
      if (this.isP("=")) { this.i++; op += "="; }
      return { t: "cmp", a, op, b: this.need(ctx) };
    }

    // turns negative / is positive
    {
      const save = this.i;
      const turn = this.acceptW(["turns", "turned", "goes", "becomes", "flips", "crosses"]);
      const sign = this.acceptW(["positive", "negative"]);
      if (sign) {
        const zero = { t: "num", v: 0 };
        return turn ? { t: "cross", a, dir: sign === "positive" ? "above" : "below", b: zero } : { t: "cmp", a, op: sign === "positive" ? ">" : "<", b: zero };
      }
      this.i = save;
    }

    // crosses above / breaks below / rises above
    const beforeVerb = this.i;
    const crossVerb = this.acceptW(CROSS_VERBS);
    if (crossVerb) {
      this.acceptW(["back", "out", "up", "down", "to", "and", "closes"]);
      this.acceptW(["back", "up", "down"]);
      const dirW = this.acceptW(["above", "over", "below", "under", "through", "beneath"]);
      if (dirW) {
        const dir = dirW === "through"
          ? (["falls", "drops", "dips", "sinks", "slips"].includes(crossVerb) || this.t[this.i - 2]?.v === "down" ? "below" : "above")
          : ABOVE.has(dirW) ? "above" : "below";
        return { t: "cross", a, dir, b: this.need(ctx) };
      }
      // "falls 5%..." / "rises 3% in 10 days" are moves, handled below
      this.i = beforeVerb;
    }

    // N% above/below X, with an optional "more than / at least / less than / within" lead
    const pctLead = this.pctLead();
    if (pctLead !== undefined) return pctLead(a, ctx);

    // above / below / at least / at most
    if (this.acceptSeq("at", "least") || this.acceptSeq("greater", "than", "or", "equal", "to") || this.acceptSeq("no", "less", "than")) return { t: "cmp", a, op: ">=", b: this.need(ctx) };
    if (this.acceptSeq("at", "most") || this.acceptSeq("less", "than", "or", "equal", "to") || this.acceptSeq("no", "more", "than")) return { t: "cmp", a, op: "<=", b: this.need(ctx) };
    const cmpW = this.acceptW(ABOVE) || this.acceptW(BELOW);
    if (cmpW) {
      this.acceptW("than");
      const op = ABOVE.has(cmpW) ? ">" : "<";
      if (this.acceptSeq("or", "equal", "to")) return { t: "cmp", a, op: op + "=", b: this.need(ctx) };
      return { t: "cmp", a, op, b: this.need(ctx) };
    }

    // new highs / lows
    {
      const save = this.i;
      this.acceptW(["makes", "hits", "sets", "reaches", "at", "prints", "posts", "closes", "to"]);
      this.acceptW(["a", "an"]);
      if (this.acceptW("new")) {
        let n = 252;
        if (this.peek()?.k === "per") n = this.t[this.i++].n;
        const hw = this.acceptW(["high", "highs", "low", "lows"]);
        if (hw) {
          const hi = hw.startsWith("high");
          return { t: "cmp", a: { t: "price", f: "close", ...(ctx.sym && { sym: ctx.sym }) }, op: hi ? ">" : "<", b: { t: "ind", ind: hi ? "hi" : "lo", n, ...(ctx.sym && { sym: ctx.sym }) } };
        }
      }
      this.i = save;
    }

    // moves: rises 5% in 10 days / falls 10% from its 52-week high
    const up = this.acceptW(UP_VERBS), down = !up && this.acceptW(DOWN_VERBS);
    if (up || down) {
      this.acceptW(["by", "more", "than", "at", "least", "over"]);
      this.acceptW(["than", "least"]);
      const tk = this.peek();
      if (tk?.k === "num") {
        this.i++;
        const pct = tk.v;
        this.acceptW(["or", "more"]); this.acceptW("more");
        if (this.acceptW(["from", "off", "below", "since"])) {
          this.acceptW(["its", "the", "a", "their"]);
          let n = 252;
          if (this.peek()?.k === "per") n = this.t[this.i++].n;
          const hw = this.acceptW(["high", "highs", "peak", "top", "low", "lows", "bottom"]);
          if (!hw) this.fail();
          const fromHigh = ["high", "highs", "peak", "top"].includes(hw);
          const s = ctx.sym && { sym: ctx.sym };
          if (fromHigh && down) return { t: "cmp", a: { t: "ind", ind: "dd", n, ...s }, op: ">=", b: { t: "num", v: pct } };
          if (!fromHigh && up) return { t: "cmp", a: { t: "price", f: "close", ...s }, op: ">=", b: { t: "pct", e: { t: "ind", ind: "lo", n, ...s }, p: pct } };
          this.fail();
        }
        this.acceptW(["in", "over", "within", "during", "across", "for"]);
        this.acceptW(["the", "a", "one", "single"]); this.acceptW(["last", "past", "prior"]);
        let n = 1;
        if (this.peek()?.k === "per") n = this.t[this.i++].n;
        else if (this.isW(["day", "session", "week", "month", "year"])) n = periodDays(1, this.t[this.i++].v);
        const s = ctx.sym && { sym: ctx.sym };
        return { t: "cmp", a: { t: "ind", ind: "ret", n, ...s }, op: up ? ">=" : "<=", b: { t: "num", v: up ? pct : -pct } };
      }
      if (this.acceptW(["to", "back"])) {
        this.acceptW("to");
        return { t: "cmp", a, op: up ? ">=" : "<=", b: this.need(ctx) };
      }
      this.fail();
    }

    // rising / falling (over N days)
    const trend = this.acceptW(["rising", "falling", "increasing", "decreasing", "sloping", "trending", "turning"]);
    if (trend) {
      const dirW = ["sloping", "trending", "turning"].includes(trend) ? this.acceptW(["up", "upward", "higher", "down", "downward", "lower"]) : trend;
      const rising = ["rising", "increasing", "up", "upward", "higher"].includes(dirW);
      let n = 1;
      if (this.acceptW(["for", "over", "across"])) { this.acceptW(["the", "last", "past"]); this.acceptW(["last", "past"]); if (this.peek()?.k === "per") n = this.t[this.i++].n; }
      return { t: "cmp", a, op: rising ? ">" : "<", b: { t: "ago", e: a, n } };
    }

    // returns to / reaches / touches X
    if (this.acceptW(["returns", "reaches", "touches", "hits", "tags", "recovers", "to", "gets"])) {
      this.acceptW(["to", "back"]); this.acceptW("to");
      return { t: "cmp", a, op: ">=", b: this.need(ctx) };
    }

    this.i = start;
    this.fail();
  }

  // "more than 5% above the 50-day SMA" etc. Returns a builder or undefined.
  pctLead() {
    const save = this.i;
    let lead = null;
    if (this.acceptSeq("more", "than") || this.acceptSeq("over") || this.acceptSeq("greater", "than")) lead = "more";
    else if (this.acceptSeq("at", "least")) lead = "least";
    else if (this.acceptSeq("less", "than") || this.acceptW("within") || this.acceptSeq("no", "more", "than")) lead = "less";
    const tk = this.peek();
    if (lead === "less" && tk?.k === "num" && tk.pct && this.isW("of", 1)) {
      this.i += 2;
      return (a, ctx) => ({ t: "cmp", a, op: ">", b: { t: "pct", e: this.need(ctx), p: -tk.v } });
    }
    if (tk?.k === "num" && tk.pct && this.isW(["above", "below", "over", "under"], 1)) {
      this.i += 1;
      const above = ["above", "over"].includes(this.t[this.i++].v);
      const p = above ? tk.v : -tk.v;
      const op = lead === "less" ? (above ? "<" : ">") : lead === "more" ? (above ? ">" : "<") : (above ? ">=" : "<=");
      return (a, ctx) => ({ t: "cmp", a, op, b: { t: "pct", e: this.need(ctx), p } });
    }
    this.i = save;
    return undefined;
  }

  need(ctx) {
    const b = this.operand(ctx);
    if (!b) this.fail();
    return b;
  }

  // An operand: a number, a price, or an indicator, optionally "of SYM" and "N days ago".
  operand(ctx) {
    const start = this.i;
    let pronoun = false, ago = 0;
    for (;;) {
      if (this.acceptW(["the", "a", "an", "its", "their", "his", "her", "own"])) { if (["its", "their"].includes(this.t[this.i - 1].v)) pronoun = true; continue; }
      if (this.acceptW(["previous", "prior", "yesterday", "yesterdays"])) { ago = 1; this.acceptW("'s"); continue; }
      break;
    }
    let sym;
    const tk = this.peek();
    if (tk?.k === "sym") {
      this.i++;
      sym = tk.v;
      if (this.acceptW("'s")) {
        // SPY's 200-day SMA
      } else if (!this.startsCore()) {
        return this.finish({ t: "price", f: "close", sym }, ago);
      }
    }
    if (this.acceptW("it") || this.acceptW("they")) {
      if (this.it && !ctx.like) return this.finish(this.it, ago);
      return this.finish({ t: "price", f: "close", ...((ctx.sym && { sym: ctx.sym }) || {}) }, ago);
    }
    let e = this.core(ctx);
    if (!e) { this.i = start; return null; }
    if (e.t === "num") return e;
    if (!sym && this.isW(["of", "on", "for", "in"])) {
      const save = this.i++;
      this.acceptW("the");
      if (this.peek()?.k === "sym") sym = this.t[this.i++].v;
      else this.i = save;
    }
    // "the prior 20-day high": highs and lows already exclude today
    if (ago === 1 && e.t === "ind" && (e.ind === "hi" || e.ind === "lo")) ago = 0;
    if (!sym && pronoun && ctx.sym) sym = ctx.sym;
    if (sym) e = { ...e, sym };
    return this.finish(e, ago);
  }

  finish(e, ago) {
    // "N days ago"
    const tk = this.peek();
    if (tk?.k === "per" && this.isW("ago", 1)) { this.i += 2; ago += tk.n; }
    else if (tk?.k === "num" && this.isW(["days", "bars", "sessions"], 1) && this.isW("ago", 2)) { this.i += 3; ago += tk.v; }
    return ago ? { t: "ago", e, n: ago } : e;
  }

  startsCore() {
    const x = this.peek();
    if (!x) return false;
    if (x.k === "per") return true;
    return x.k === "w" && ["sma", "ema", "rsi", "atr", "macd", "moving", "simple", "exponential", "average", "ma", "dma", "upper", "lower", "middle", "mid", "bollinger", "volume", "drawdown", "volatility", "return", "returns", "momentum", "relative", "close", "closing", "open", "opening", "high", "low", "signal", "histogram", "performance", "roc"].includes(x.v);
  }

  // Number list after an indicator: "14", "(20, 2)", "12 26 9".
  params(max) {
    const out = [];
    const paren = this.isP("(") && ++this.i;
    while (out.length < max) {
      const x = this.peek();
      if (x?.k === "num" && !x.pct && !x.word) { out.push(x.v); this.i++; }
      else if (x?.k === "per" && paren) { out.push(x.n); this.i++; }
      else break;
      if (this.isP(",")) this.i++;
    }
    if (paren && this.isP(")")) this.i++;
    return out;
  }

  core(ctx) {
    const x = this.peek();
    if (!x) return null;
    if (x.k === "num") {
      // a number directly followed by an indicator word is its length ("50 sma")
      if (!x.pct && this.isW(["sma", "ema", "ma", "dma", "rsi", "atr"], 1)) {
        this.i++;
        return this.indicator(x.v, ctx);
      }
      this.i++;
      return { t: "num", v: x.v };
    }
    let n = null;
    if (x.k === "per") { n = x.n; this.i++; }
    const e = this.indicator(n, ctx);
    if (e) return e;
    if (n != null) {
      // a bare length: "crosses above the 200-day" -> same kind of average as the left side
      const like = ctx.like?.t === "ind" && ["sma", "ema"].includes(ctx.like.ind) ? ctx.like.ind : "sma";
      return { t: "ind", ind: like, n };
    }
    return null;
  }

  indicator(n, ctx) {
    const ind = (name, dn, extra = {}) => {
      if (n == null) {
        const p = this.params(1);
        n = p[0];
        if (n == null && this.isW(["over", "in", "during", "across"]) ) {
          const save = this.i++;
          this.acceptW(["the", "last", "past"]); this.acceptW(["last", "past"]);
          if (this.peek()?.k === "per") n = this.t[this.i++].n; else this.i = save;
        }
        n ??= dn;
      }
      return { t: "ind", ind: name, n, ...extra };
    };
    if (this.acceptW(["sma", "ma", "dma", "mavg"]) || this.acceptSeq("simple", "moving", "average") || this.acceptSeq("moving", "average") || this.acceptSeq("day", "moving", "average") || this.acceptSeq("day", "average")) {
      this.acceptW(["average", "averages"]);
      return ind("sma", 50);
    }
    if (this.acceptW(["ema"]) || this.acceptSeq("exponential", "moving", "average") || this.acceptW("exponential")) {
      this.acceptW(["average", "moving"]); this.acceptW("average");
      return ind("ema", 20);
    }
    if (this.isW("average") && !this.isW(["volume", "true"], 1)) { this.i++; return ind("sma", 50); }
    if (this.acceptW("rsi") || this.acceptSeq("relative", "strength", "index") || this.acceptSeq("relative", "strength")) return ind("rsi", 14);
    if (this.acceptW("atr") || this.acceptSeq("average", "true", "range")) return ind("atr", 14);
    if (this.acceptW(["return", "returns", "momentum", "performance", "change", "roc", "gain"])) return ind("ret", 21);
    if (this.acceptW(["volatility"])) return ind("vol", 21);
    if (this.acceptW("drawdown")) {
      if (n == null) {
        n = 252;
        if (this.acceptW("from")) { this.acceptW(["its", "the"]); if (this.peek()?.k === "per") n = this.t[this.i++].n; this.acceptW(["high", "peak"]); }
      }
      return { t: "ind", ind: "dd", n };
    }
    if (n != null && this.acceptW(["high", "highs", "peak"])) return { t: "ind", ind: "hi", n };
    if (n != null && this.acceptW(["low", "lows"])) return { t: "ind", ind: "lo", n };
    if ((this.isW(["average", "avg"]) && this.isW("volume", 1)) || (n != null && this.isW("average") && this.isW("volume", 1))) {
      this.i += 2;
      if (n == null) { const p = this.params(1); n = p[0] ?? 20; }
      return { t: "ind", ind: "avgvol", n };
    }
    const band = this.acceptW(["upper", "lower", "middle", "mid", "top", "bottom"]);
    if (band) {
      this.acceptW("bollinger");
      if (!this.acceptW(["band", "bands"])) { this.i -= 1 + (this.t[this.i - 1].v === "bollinger" ? 1 : 0); return null; }
      const p = this.params(2);
      const len = n ?? p[0] ?? 20, m = n != null ? (p[0] ?? 2) : (p[1] ?? 2);
      const kind = ["upper", "top"].includes(band) ? "bbu" : ["lower", "bottom"].includes(band) ? "bbl" : "bbm";
      return { t: "ind", ind: kind, n: len, m };
    }
    if (this.acceptW("macd") || this.isW("signal") || this.isW("histogram")) {
      const wasMacd = this.t[this.i - 1]?.v === "macd";
      let kind = "macd";
      if (this.acceptW("signal")) kind = "macds";
      else if (this.acceptW("histogram")) kind = "macdh";
      else if (!wasMacd) return null;
      this.acceptW("line");
      const p = this.params(3);
      return { t: "ind", ind: kind, n: p[0] ?? 12, s: p[1] ?? 26, g: p[2] ?? 9 };
    }
    if (n != null) return null;
    if (this.acceptW("volume")) return { t: "price", f: "volume" };
    if (this.acceptW(["price", "close", "closing", "last"]) ) { this.acceptW("price"); return { t: "price", f: "close" }; }
    if (this.acceptW(["open", "opening"])) { this.acceptW("price"); return { t: "price", f: "open" }; }
    if (this.acceptW("high")) return { t: "price", f: "high" };
    if (this.acceptW("low")) return { t: "price", f: "low" };
    return null;
  }
}

export function parseCondition(text, opts) {
  return parseConditionFull(text, opts).cond;
}
function parseConditionFull(text, opts) {
  text = String(text).replace(/(?:\s*(?:,|\b(?:and|or|then|with|a|an|using|plus|also)\b))+\s*$/i, "");
  const p = new Parser(tokenize(normalize(text)), text.trim(), opts);
  const c = p.cond();
  while (p.isW(["instead", "too", "again"]) || p.isP(",")) p.i++;
  if (!p.done()) throw new ParseError(`Couldn't read "${text.trim()}" (stuck at "${p.t.slice(p.i, p.i + 4).map((x) => x.v ?? x.n).join(" ")}")`);
  return { cond: c, firstA: p.firstA };
}

// ---------- statements ----------
export const symsIn = (text) => tokenize(normalize(text)).filter((x) => x.k === "sym").map((x) => x.v);
const uniq = (a) => [...new Set(a)];

const FREQ = [
  [/\b(?:daily|every\s*day|each\s*day)\b/, "daily"],
  [/\b(?:weekly|every\s*week|each\s*week|once\s+a\s+week)\b/, "weekly"],
  [/\b(?:monthly|every\s*month|each\s*month|once\s+a\s+month|end\s+of\s+(?:the|each)\s+month)\b/, "monthly"],
  [/\b(?:quarterly|every\s*quarter|each\s*quarter|every\s+3\s+months|every\s+three\s+months)\b/, "quarterly"],
  [/\b(?:yearly|annually|every\s*year|each\s*year|once\s+a\s+year)\b/, "yearly"],
];

const ENTRY_VERB = String.raw`(?:buys?|enter|go long(?: on| in)?|get in(?:to)?|long|purchase|open a(?: long)? position in|trade|accumulate)`;
const EXIT_VERB = String.raw`(?:sells?|exits?|get out(?: of)?|close(?: the| out the| out)?(?: position| trade)?|go flat|close it|take profits)`;
const COND_WORD = String.raw`(?:when(?:ever)?|if|once|as soon as|after|on)`;

const FILLER_ONLY = /^(?:\b(?:with|a|an|and|use|using|plus|also|set|add|put|place|the|of|at|please|i|want|to|it|rules?)\b|[,\s])*$/i;
function splitClauses(text) {
  const parts = text
    .split(/\n|;|(?<![\d^A-Z])\.(?!\d)(?:\s|$)|\.\s+/)
    .flatMap((s) => s.split(/,?\s+(?:and\s+)?then\s+|,\s*(?=(?:and\s+)?(?:sells?|exits?|get out|close (?:the |out)|rebalance|rotate)\b)|,\s*(?=(?:and\s+)?(?:buys?|enter|go long)\b[^,]*\b(?:when|if|on|once)\b)|\s+and\s+(?=(?:sells?|exits?|get out|cover|(?:go |sell )?short)\b)|,\s*(?=(?:and\s+)?(?:(?:go |sell )?short|(?:buy to )?cover)\b[^,]*\b(?:when|if|on|once)\b)/i))
    .map((s) => s.trim().replace(/^(?:and|also|then)\s+/i, "").trim())
    .filter((s) => s && /[a-z0-9]/i.test(s) && !FILLER_ONLY.test(s));
  // "When X, sell" was split above only if it also said when; nothing to merge back.
  return parts;
}

function grab(re, text, fn) {
  // rules never span lines: "Stop loss 5%\nTrailing stop 8%" is two rules
  re = new RegExp(re.source.replace(/\\s/g, "[^\\S\\n]"), re.flags);
  const m = text.match(re);
  if (!m) return [null, text];
  return [fn(m), text.replace(m[0], " , ")];
}

const num = (s) => Number(s);

export function parseStrategy(raw) {
  if (!String(raw || "").trim()) throw new ParseError("Describe a strategy first.");
  let text = normalize(raw);
  const notes = [], unparsed = [];
  const lower = () => text.toLowerCase();
  let trailingStop, stopLoss, takeProfit, maxHold, size, band, rebalance;
  let volTarget, weighting;

  // Before take profit, which also reads "target N%".
  [volTarget, text] = grab(/(?:target(?:ing)?|aim(?:ing)?\s+for|scale(?:d)?\s+to|keep(?:\s+it)?\s+(?:at|near|around))\s+(?:a\s+|an\s+|about\s+)?(\d+(?:\.\d+)?)\s*%\s+(?:annual(?:ized)?\s+)?vol(?:atility)?\b|(\d+(?:\.\d+)?)\s*%\s+(?:annual(?:ized)?\s+)?vol(?:atility)?\s+target|vol(?:atility)?\s+target(?:\s+(?:of|at))?\s+(\d+(?:\.\d+)?)\s*%/i, text, (m) => num(m[1] ?? m[2] ?? m[3]) / 100);
  [weighting, text] = grab(/(?:weight(?:ed|ing|s)?\s+(?:them\s+|each\s+|assets\s+)?by\s+inverse\s+vol(?:atility)?|inverse[- ]vol(?:atility)?(?:[- ]weight(?:ed|ing|s)?)?|risk[- ]parity|risk[- ]weight(?:ed|ing))/i, text, () => "invvol");

  [trailingStop, text] = grab(/(\d+(?:\.\d+)?)\s*%\s*trailing(?:\s+stop(?:[- ]?loss)?)?|trailing(?:\s+stop(?:[- ]?loss)?)?(?:\s+(?:of|at))?\s+(\d+(?:\.\d+)?)\s*%/i, text, (m) => num(m[1] ?? m[2]) / 100);
  [stopLoss, text] = grab(/(\d+(?:\.\d+)?)\s*%\s*(?:hard\s+)?stop(?:[- ]?loss)?(?:\s+below\s+entry)?|stop(?:[- ]?loss)?(?:\s+(?:of|at|is|to))?\s+(\d+(?:\.\d+)?)\s*%(?:\s+below\s+(?:the\s+)?entry)?|(?:cut|exit)\s+(?:losses|the position)?\s*(?:at|after)\s+(?:a\s+)?(\d+(?:\.\d+)?)\s*%\s+loss/i, text, (m) => num(m[1] ?? m[2] ?? m[3]) / 100);
  [takeProfit, text] = grab(/(\d+(?:\.\d+)?)\s*%\s*(?:take[- ]?profit|profit\s+target|target|profit)|(?:take[- ]?profit|profit\s+target|target)(?:\s+(?:of|at|is))?\s+(\d+(?:\.\d+)?)\s*%/i, text, (m) => num(m[1] ?? m[2]) / 100);
  [maxHold, text] = grab(/(?:sell|exit|close(?: it| the position)?|get out)\s+(?:it\s+|the position\s+)?after\s+(\d+)\s*(trading days?|days?|weeks?|months?|bars?|sessions?)|hold(?:\s+(?:it|each position|positions|the position|for))?\s+(?:for\s+)?(?:up to\s+|at most\s+)?(\d+)\s*(trading days?|days?|weeks?|months?|bars?|sessions?)(?:\s+max(?:imum)?)?|time\s+stop\s+(?:of\s+)?(\d+)\s*(days?|weeks?|bars?)/i, text, (m) => periodDays(num(m[1] ?? m[3] ?? m[5]), m[2] ?? m[4] ?? m[6]));
  [size, text] = grab(/position\s+size\s+(?:of\s+)?(\d+(?:\.\d+)?)\s*%|(?:put|use|risk|invest|allocate)\s+(\d+(?:\.\d+)?)\s*%\s+(?:of\s+(?:equity|capital|the account|the portfolio|cash)\s*)?(?:per|in each|on each|into each)\s+(?:position|trade)|(\d+(?:\.\d+)?)\s*%\s+(?:of\s+(?:equity|capital|the portfolio)\s+)?per\s+(?:position|trade)/i, text, (m) => num(m[1] ?? m[2] ?? m[3]) / 100);
  [band, text] = grab(/(?:rebalance\s+)?(?:when|if|whenever)\s+(?:any|a|one)\s+(?:holding|asset|position|weight)\s+drifts?\s+(?:more\s+than\s+|by\s+)?(\d+(?:\.\d+)?)\s*%(?:\s+(?:points?\s+)?(?:from|away from|off)\s+(?:its\s+)?target)?|(\d+(?:\.\d+)?)\s*%\s*(?:drift\s+)?(?:band|threshold)|drift\s+(?:band|threshold)\s+(?:of\s+)?(\d+(?:\.\d+)?)\s*%/i, text, (m) => num(m[1] ?? m[2] ?? m[3]) / 100);
  for (const [re, f] of FREQ) {
    const m = lower().match(new RegExp(String.raw`(?:rebalanc\w*|rotate|check\w*|review\w*)?\s*(?:it\s+|the portfolio\s+)?(?:every|each|once)?\s*` + re.source));
    if (m && (/rebalanc|rotat|hold|top|best|weight|%|\//i.test(text) || /rebalanc/.test(m[0]))) {
      rebalance = f;
      text = text.slice(0, m.index) + " , " + text.slice(m.index + m[0].length);
      break;
    }
  }
  text = text.replace(/\brebalanc\w*\b(?=\s*(?:,|$|\.|\n))/gi, " ");

  const spec = { entry: null, exit: null, symbols: [], weights: null, rotate: null, riskOff: null };
  let rotUniverse = [];
  let entryIt, shortIt;

  for (const clause of splitClauses(text)) {
    const c = clause.replace(/\s+/g, " ").replace(/^[,\s]+|[,\s]+$/g, "");
    if (!c || /^[,.\s]*$/.test(c)) continue;
    const lc = c.toLowerCase();
    let m;
    try {
      // Trade SPY, QQQ  /  Symbol: SPY
      if ((m = c.match(/^(?:trade|trading|symbols?|tickers?|on|universe|assets?)\s*:?\s+(.+)$/i)) && symsIn(m[1]).length && !/\b(?:when|if)\b/i.test(m[1])) {
        spec.symbols.push(...symsIn(m[1]));
        continue;
      }
      // Rotate among A, B, C
      if ((m = c.match(/^(?:rotate|rotating|choose|pick|select)\s+(?:among|between|from|across|through)\s+(.+)$/i))) {
        rotUniverse.push(...symsIn(m[1]));
        continue;
      }
      // Only hold assets whose X is above 0 / only if momentum is positive
      if (/^only\s+(?:hold|buy|own|invest)/i.test(c) && /(above\s+0|above\s+zero|positive|is up|are up)/i.test(c)) {
        spec.rotate = { ...(spec.rotate || {}), absolute: true };
        continue;
      }
      // When C, hold X instead / go to cash when C
      if ((m = c.match(/^(?:when|if|whenever|while)\s+(.+?),?\s+(?:hold|switch\s+to|move\s+to|go\s+to|rotate\s+(?:in)?to|buy|own|be\s+in)\s+(.+?)\s+instead$/i))
        || (m = c.match(/^(?:when|if|whenever|while)\s+(.+?),?\s+(?:go\s+to|move\s+to|switch\s+to|sell\s+everything\s+and\s+hold|be\s+in|hold|stay\s+in)\s+(cash|[\^A-Z0-9][\w.\-=^]*)$/i))) {
        const hold = /cash/i.test(m[2]) ? null : symsIn(m[2])[0] ?? null;
        spec.riskOff = { when: parseCondition(m[1]), hold };
        continue;
      }
      if ((m = c.match(/^(?:go|move|switch|rotate|get)\s+(?:in)?to\s+(cash|[\^A-Z0-9][\w.\-=^]*)\s+(?:when|if|whenever|while)\s+(.+)$/i))) {
        spec.riskOff = { when: parseCondition(m[2]), hold: /cash/i.test(m[1]) ? null : symsIn(m[1])[0] ?? null };
        continue;
      }
      // Rotation: hold the top 2 by 126-day return / best performing of A, B, C over 3 months
      if (/\b(?:top|best|strongest|highest|leading)\b/i.test(c) && !new RegExp(String.raw`^${ENTRY_VERB}\b.*\b(?:when|if)\b`, "i").test(c)) {
        const t = lc.match(/\btop\s+(\d+|one|two|three|four|five)\b/);
        const top = t ? (WORD_NUM[t[1]] ?? Number(t[1])) : 1;
        const syms = symsIn(c);
        if (syms.length) rotUniverse.push(...syms);
        let by = null;
        const byM = c.match(/\b(?:by|on|based on|ranked by|using|with the (?:highest|best|strongest))\s+(.+?)(?:\s+(?:among|of|from)\s+.*)?$/i);
        if (byM) {
          try {
            const p = new Parser(tokenize(normalize(byM[1])), byM[1]);
            p.skip(new Set(["the", "their", "its", "highest", "best", "strongest", "trailing", "recent"]));
            by = p.operand({});
            if (by?.t === "num") by = null;
          } catch { by = null; }
        }
        if (!by) {
          const per = tokenize(normalize(c)).find((x) => x.k === "per");
          by = { t: "ind", ind: "ret", n: per ? per.n : 126 };
        }
        if (by.sym) { const { sym, ...rest } = by; by = rest; }
        spec.rotate = { top, by, absolute: spec.rotate?.absolute || /\b(?:positive|negative|above (?:0|zero)|below (?:0|zero)|otherwise cash|else cash|absolute|go(?:es)? to cash|in cash)\b/i.test(c) };
        continue;
      }
      // Hold SPY when/while C, otherwise TLT
      if ((m = c.match(/^(?:hold|own|stay\s+in|be\s+in|invest\s+in|buy\s+and\s+hold)\s+(.+?)\s+(?:only\s+)?(?:when|if|while|whenever|as long as)\s+(.+?)(?:,?\s*(?:otherwise|else|or else)\s*,?\s*(?:hold\s+|move\s+to\s+|switch\s+to\s+|go\s+to\s+|buy\s+|be\s+in\s+|stay\s+in\s+)?(.+))?$/i))) {
        const held = symsIn(m[1]);
        if (!held.length) throw new ParseError(`Which asset should "${c}" hold?`);
        const otherwise = m[3] && !/cash/i.test(m[3]) ? symsIn(m[3])[0] ?? null : null;
        const when = negate(parseCondition(m[2], { it: { t: "price", f: "close", sym: held[0] } }));
        spec.weights = round6(Object.fromEntries(held.map((s) => [s, 1 / held.length])));
        spec.riskOff = { when, hold: otherwise };
        continue;
      }
      // Allocations: Hold 60% SPY, 40% TLT / 60/40 SPY TLT / equal weight A, B, C / buy and hold SPY
      const alloc = parseWeights(c);
      if (alloc) { spec.weights = alloc; continue; }

      // Short X when C / cover when C
      if ((m = c.match(new RegExp(String.raw`^(?:sell short|go short(?: on)?|short(?: sell)?|bet against)\s+(.*?)\b${COND_WORD}\s+(.+)$`, "i")))) {
        spec.symbols.push(...symsIn(m[1]));
        const r = parseConditionFull(m[2].replace(/^(?:a|the)\s+(?=close|cross|break)/i, ""));
        spec.shortEntry = andWith(spec.shortEntry, r.cond);
        shortIt ??= r.firstA;
        continue;
      }
      if ((m = c.match(new RegExp(String.raw`^(?:buy to cover|cover(?: the short| shorts?| it)?|close (?:the |out the )?shorts?)\s*(.*?)\b${COND_WORD}\s+(.+)$`, "i")))) {
        let cond;
        try {
          cond = parseCondition(m[2].replace(/^(?:a|the)\s+(?=close|cross|break)/i, ""), { it: shortIt });
          if ((cond.t === "cmp" || cond.t === "cross") && JSON.stringify(cond.a) === JSON.stringify(cond.b)) cond = mirror(spec.shortEntry, c);
        } catch (e) {
          if (!(e instanceof ParseError) || !/\b(?:cross\w*\s+back|opposite|revers)/i.test(c)) throw e;
          cond = mirror(spec.shortEntry, c, e);
        }
        spec.shortExit = spec.shortExit ? { t: "or", c: [spec.shortExit, cond] } : cond;
        continue;
      }
      // Entry: buy X when C  /  when C, buy X
      if ((m = c.match(new RegExp(String.raw`^${ENTRY_VERB}\s+(.*?)\b${COND_WORD}\s+(.+)$`, "i")))) {
        spec.symbols.push(...symsIn(m[1]));
        const r = parseConditionFull(m[2].replace(/^(?:a|the)\s+(?=close|cross|break)/i, ""));
        spec.entry = andWith(spec.entry, r.cond);
        entryIt ??= r.firstA;
        continue;
      }
      if ((m = c.match(new RegExp(String.raw`^(?:when|if|whenever|once)\s+(.+?),?\s+${ENTRY_VERB}(?:\s+(.*))?$`, "i")))) {
        if (m[2]) spec.symbols.push(...symsIn(m[2]));
        const r = parseConditionFull(m[1]);
        spec.entry = andWith(spec.entry, r.cond);
        entryIt ??= r.firstA;
        continue;
      }
      // Exit: sell when C / sell on the opposite cross
      if (new RegExp(String.raw`^${EXIT_VERB}\b`, "i").test(c) && /\b(?:opposite|reverse|reversal|other way)\b/i.test(c)) {
        spec.exit = mirror(spec.entry, c);
        continue;
      }
      if ((m = c.match(new RegExp(String.raw`^${EXIT_VERB}\s*(.*?)\b${COND_WORD}\s+(.+)$`, "i")))) {
        let cond;
        try {
          cond = parseCondition(m[2].replace(/^(?:a|the)\s+(?=close|cross|break)/i, ""), { it: entryIt });
          if ((cond.t === "cmp" || cond.t === "cross") && JSON.stringify(cond.a) === JSON.stringify(cond.b)) cond = mirror(spec.entry, c);
        } catch (e) {
          if (!(e instanceof ParseError) || !/\b(?:cross\w*\s+back|opposite|revers)|\bcross\w*\s+(?:above|below|over|under)\s*$/i.test(c)) throw e;
          cond = mirror(spec.entry, c, e);
        }
        spec.exit = spec.exit ? { t: "or", c: [spec.exit, cond] } : cond;
        continue;
      }
      if ((m = c.match(new RegExp(String.raw`^(?:when|if|whenever|once)\s+(.+?),?\s+${EXIT_VERB}\b.*$`, "i")))) {
        const cond = parseCondition(m[1], { it: entryIt });
        spec.exit = spec.exit ? { t: "or", c: [spec.exit, cond] } : cond;
        continue;
      }
      // A bare condition right after a buy rule ("buy SPY when X, and Y") is too ambiguous; report it.
      unparsed.push(c);
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      unparsed.push(c);
      notes.push(e.message);
    }
  }

  spec.symbols = uniq(spec.symbols);
  rotUniverse = uniq(rotUniverse);

  // "risk parity SPY, TLT, GLD": a weighting with a bare list of assets
  if (weighting && !spec.entry && !spec.shortEntry && !spec.weights && !spec.rotate) {
    const list = uniq([...spec.symbols, ...unparsed.flatMap((u) => symsIn(u))]);
    if (list.length >= 2) {
      spec.weights = round6(Object.fromEntries(list.map((s) => [s, 1 / list.length])));
      unparsed.length = 0;
    }
  }

  let out;
  if (spec.entry || spec.shortEntry) {
    out = {
      kind: "signal", symbols: spec.symbols, entry: spec.entry, exit: spec.exit,
      stopLoss: stopLoss ?? null, takeProfit: takeProfit ?? null, trailingStop: trailingStop ?? null,
      maxHold: maxHold ?? null, size: size ?? null,
    };
    if (spec.shortEntry) { out.shortEntry = spec.shortEntry; out.shortExit = spec.shortExit ?? null; }
    if (volTarget) out.volTarget = volTarget;
    if (spec.weights || spec.rotate) notes.push("Found both a buy rule and a portfolio allocation; kept the buy rule.");
    const stops = stopLoss || takeProfit || trailingStop || maxHold;
    if (spec.entry && !spec.exit && !stops && !spec.shortEntry) notes.push("No sell rule: each position is held until the end of the test. Add one like \"sell when RSI is above 70\" or \"sell after 20 days\".");
    if (spec.shortEntry && !spec.shortExit && !stops && !spec.entry) notes.push("No cover rule: each short is held until the end of the test. Add one like \"cover when RSI is below 30\" or a stop loss.");
  } else if (spec.rotate && (rotUniverse.length || spec.symbols.length)) {
    const universe = uniq([...rotUniverse, ...spec.symbols]).filter((s) => s !== spec.riskOff?.hold);
    if (universe.length < 2) throw new ParseError("A rotation needs at least two assets to choose from, e.g. \"hold the top 1 of SPY, EFA and TLT by 126-day return\".");
    out = {
      kind: "allocate", symbols: universe, weights: null,
      rotate: { top: Math.min(spec.rotate.top ?? 1, universe.length), by: spec.rotate.by ?? { t: "ind", ind: "ret", n: 126 }, absolute: Boolean(spec.rotate.absolute) },
      rebalance: rebalance ?? (band ? null : "monthly"), band: band ?? null, riskOff: spec.riskOff,
    };
    if (weighting) out.weighting = weighting;
    if (volTarget) out.volTarget = volTarget;
  } else if (spec.weights) {
    out = {
      kind: "allocate", symbols: Object.keys(spec.weights), weights: spec.weights, rotate: null,
      rebalance: rebalance ?? ((weighting || volTarget) && !band ? "monthly" : null), band: band ?? (rebalance || weighting || volTarget || Object.keys(spec.weights).length < 2 ? null : 0.05), riskOff: spec.riskOff,
    };
    if (weighting) out.weighting = weighting;
    if (volTarget) out.volTarget = volTarget;
    if (!rebalance && !band && !weighting && !volTarget && Object.keys(spec.weights).length > 1) notes.push("No rebalance schedule given, so it rebalances when any holding drifts 5% from target.");
  } else {
    throw new ParseError(
      unparsed.length
        ? `Couldn't find a buy rule, a short rule or a portfolio in that. ${notes[0] || ""} Try "buy when the 50-day SMA crosses above the 200-day SMA" or "hold 60% SPY, 40% TLT, rebalance quarterly".`.replace(/\s+/g, " ")
        : `Couldn't find a buy rule or a portfolio in that. Try "buy when the 50-day SMA crosses above the 200-day SMA" or "hold 60% SPY, 40% TLT, rebalance quarterly".`
    );
  }
  if (out.kind === "allocate" && (stopLoss || takeProfit || trailingStop || maxHold || size)) notes.push("Stops, targets and time limits apply to buy/sell strategies, so they were left out of this portfolio.");
  return { spec: out, notes: uniq(notes), unparsed };
}

const leftmost = (c) => (!c ? undefined : c.t === "and" || c.t === "or" ? leftmost(c.c[0]) : c.t === "not" ? leftmost(c.c) : c.a);
const andWith = (a, b) => (a ? { t: "and", c: [...(a.t === "and" ? a.c : [a]), b] } : b);

// "sell on the opposite cross" / "sell when it crosses back below"
function mirror(entry, clause, err) {
  const flipDir = (c) => {
    if (c?.t === "cross") return { ...c, dir: c.dir === "above" ? "below" : "above" };
    if (c?.t === "cmp") return negate(c);
    return null;
  };
  const leaf = entry?.t === "and" || entry?.t === "or" ? entry.c[0] : entry;
  const m = flipDir(leaf);
  if (!m) throw err || new ParseError(`Couldn't read "${clause}": there's no buy rule to reverse.`);
  return m;
}

const round6 = (w) => (w ? Object.fromEntries(Object.entries(w).map(([k, v]) => [k, Math.round(v * 1e6) / 1e6])) : w);
function parseWeights(c) { return round6(parseWeightsRaw(c)); }
function parseWeightsRaw(c) {
  const lc = c.toLowerCase();
  if (/\b(?:when|if|whenever|while)\b/.test(lc)) return null;
  const toks = tokenize(normalize(c));
  const syms = toks.filter((x) => x.k === "sym").map((x) => x.v);
  if (!syms.length) return null;
  // 60/40 SPY/TLT
  const ratio = c.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?))?/);
  if (ratio) {
    const parts = [ratio[1], ratio[2], ratio[3]].filter(Boolean).map(Number);
    const tail = symsIn(c.slice(ratio.index + ratio[0].length));
    const list = tail.length >= parts.length ? tail : syms;
    if (list.length >= parts.length) {
      const sum = parts.reduce((a, b) => a + b, 0);
      return Object.fromEntries(parts.map((p, k) => [list[k], p / sum]));
    }
  }
  // 60% SPY, 40% TLT  or  SPY 60%, TLT 40%
  const w = {};
  for (let k = 0; k < toks.length; k++) {
    const x = toks[k];
    if (x.k === "num" && x.pct) {
      let j = k + 1;
      while (toks[j]?.k === "w" && ["in", "of", "into", "to"].includes(toks[j].v)) j++;
      if (toks[j]?.k === "sym") { w[toks[j].v] = x.v / 100; k = j; continue; }
    }
    if (x.k === "sym" && toks[k + 1]?.k === "num" && toks[k + 1].pct) { w[x.v] = toks[k + 1].v / 100; k++; }
    else if (x.k === "sym" && toks[k + 1]?.k === "w" && toks[k + 1].v === "at" && toks[k + 2]?.k === "num" && toks[k + 2].pct) { w[x.v] = toks[k + 2].v / 100; k += 2; }
  }
  const named = Object.keys(w);
  if (named.length) {
    const sum = Object.values(w).reduce((a, b) => a + b, 0);
    if (sum > 1.0001) return Object.fromEntries(named.map((s) => [s, w[s] / sum]));
    const rest = syms.filter((s) => !(s in w));
    if (rest.length && sum < 0.9999) rest.forEach((s) => (w[s] = (1 - sum) / rest.length));
    return w;
  }
  if (/\b(?:equal(?:ly)?(?:[- ]weight(?:ed)?)?|evenly|split)\b/.test(lc) || /^(?:hold|own|buy and hold|invest in|keep)\b/.test(lc)) {
    const list = uniq(syms);
    return Object.fromEntries(list.map((s) => [s, 1 / list.length]));
  }
  return null;
}
