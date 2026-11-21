// Reads a portfolio and goals typed the way people write them:
//   "50 AAPL, 20 shares of MSFT, $5,000 in VTI, 10% bonds, 3k cash.
//    Retire in 20 years, adding $500 a month, want $1M, can't stomach more than a 25% drop."
// Returns { positions: [{ symbol, shares?, value?, weight? }], cash, goals, unread: [...] }.
import { replaceNames, resolveSymbol } from "./markets.js";

const STOP = new Set("I A AN THE MY OF IN AND AT TO ON IS AM HAVE OWN HOLD GOT WITH PLUS ABOUT AROUND WORTH SHARE SHARES SH UNITS STOCK STOCKS ETF ETFS FUND FUNDS USD CASH IRA ROTH K M REST EACH PER FOR IT AS ALSO SOME".split(" "));
const amount = (n, unit) => Number(String(n).replace(/,/g, "")) * ({ k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6 }[(unit || "").toLowerCase()] || 1);
const NUM = String.raw`(\d[\d,]*(?:\.\d+)?)\s*(k|mm|m|thousand|million)?\b`;

function findSymbol(text) {
  for (const raw of text.match(/\^?[A-Za-z][A-Za-z0-9.\-=]{0,11}/g) || []) {
    if (STOP.has(raw.toUpperCase())) continue;
    // Tickers are written in capitals, or are the only word left once the numbers are gone.
    if (raw !== raw.toUpperCase() && !/^[a-z]{1,5}$/.test(raw)) continue;
    const s = resolveSymbol(raw);
    if (s) return s;
  }
  return null;
}

function position(chunk) {
  let m;
  let c = chunk.trim();
  if (!c) return null;
  // Numeric tickers (7203.T, 0700.HK) come out first, so their digits aren't read as a quantity.
  const numeric = c.match(/\b\d{4,6}\.[A-Z]{1,3}\b/);
  if (numeric) c = c.replace(numeric[0], " ");
  const symbolIn = (text) => numeric?.[0] || findSymbol(text);
  if ((m = c.match(new RegExp(String.raw`\$\s*${NUM}`, "i"))) || (m = c.match(new RegExp(String.raw`${NUM}\s*(?:dollars|usd)`, "i")))) {
    const rest = c.replace(m[0], " ");
    if (/\bcash\b/i.test(rest)) return { cash: amount(m[1], m[2]) };
    const symbol = symbolIn(rest);
    return symbol ? { symbol, value: amount(m[1], m[2]) } : null;
  }
  if ((m = c.match(/(\d+(?:\.\d+)?)\s*%/))) {
    const rest = c.replace(m[0], " ");
    if (/\bcash\b/i.test(rest)) return { cashWeight: Number(m[1]) };
    const symbol = symbolIn(rest);
    return symbol ? { symbol, weight: Number(m[1]) } : null;
  }
  if ((m = c.match(new RegExp(NUM, "i")))) {
    const rest = c.replace(m[0], " ");
    if (/\bcash\b/i.test(rest)) return { cash: amount(m[1], m[2]) };
    const symbol = symbolIn(rest);
    return symbol ? { symbol, shares: amount(m[1], m[2]) } : null;
  }
  return null;
}

// Goals are looked for across the whole text; every field is optional.
export function parseGoals(text) {
  const g = {};
  let m;
  const t = text.replace(/,(?=\d{3})/g, "");
  if ((m = t.match(/\b(?:in|over|for|within|next)\s+(?:the\s+next\s+)?(\d{1,2})\s*(?:\+\s*)?(?:years?|yrs?)\b/i)) // a bare "20 years" counts only when it stands alone or points forward, not "10-year treasury" or "held 5 years"
    || (m = t.match(/(?<!\b(?:held|owned|had|past|last|for)\s)(?<![-\d])\b(\d{1,2})\s*\+?[- ]?\s*(?:years?|yrs?)(?=\s*(?:[,.;!]|$|\n|to go\b|left\b|away\b|from now\b|out\b|until\b|till\b|before\b|horizon\b))/i))) g.years = Number(m[1]);
  if ((m = t.match(new RegExp(String.raw`\$?\s*${NUM}\s*(?:dollars\s*)?(?:a|per|each|every|\/)\s*(month|mo|year|yr)\b`, "i")))) g.monthly = Math.round(amount(m[1], m[2]) / (/^y/i.test(m[3]) ? 12 : 1));
  // The target is the first amount of $1,000 or more after a goal verb that isn't a holding
  // ("want $5,000 in VTI") or a monthly amount ("want to add $2,000 a month").
  for (const x of t.matchAll(new RegExp(String.raw`(?:reach|hit|get to|grow (?:it )?to|end up with|goal of|target of|goal is|target is|want(?: to have)?|need(?: to have)?)\D{0,25}?\$?\s*${NUM}(?!\s*(?:%|shares?\b|sh\b|in\s+(?!\d{1,2}\s*\+?\s*(?:years?|yrs?)\b)\S|of\b|a\b|per\b|each\b|every\b|\/|worth\b))`, "gi"))) {
    if (amount(x[1], x[2]) >= 1000) { g.target = amount(x[1], x[2]); break; }
  }
  if ((m = t.match(/(?:more than|max(?:imum)?(?: of)?|at most|over|beyond|up to|only)\s+(?:an?\s+)?(\d{1,2})\s*%\s*(?:drop|loss|decline|drawdown|down|fall|dip|hit)/i))
    || (m = t.match(/(?:drop|loss|lose|losing|decline|drawdown|fall|down)\D{0,25}?(\d{1,2})\s*%/i))) g.maxDrop = Number(m[1]);
  if (/\b(?:conservative|cautious|low[- ]risk|safe|capital preservation|risk[- ]averse)\b/i.test(t)) g.risk = "low";
  else if (/\b(?:aggressive|high[- ]risk|max(?:imum)? growth|risk[- ]tolerant)\b/i.test(t)) g.risk = "high";
  else if (/\b(?:moderate|balanced|medium[- ]risk)\b/i.test(t)) g.risk = "medium";
  if (/\b(?:income|dividends?|yield)\b/i.test(t)) g.income = true;
  return g;
}

const GOALISH = /\b(?:retire|years?|yrs?|month|goal|target|reach|risk|conservative|aggressive|moderate|balanced|drop|drawdown|lose|loss|income|dividend|want|need|plan|horizon|stomach|comfortable|adding|contribute|save|saving)\b/i;

export function parseHoldings(raw) {
  const text = replaceNames(String(raw || "")).replace(/[•·*]/g, "\n");
  const positions = new Map(), unread = [];
  let cash = 0, cashWeight = 0;
  // A thousands comma is not a separator: "1,500 shares".
  for (const line of text.split(/\n|;|\.(?=\s|$)/)) {
    for (const chunk of line.split(/,(?!\d{3}\b)|\s+and\s+|\s+plus\s+|\s\+\s/i)) {
      if (!chunk.trim()) continue;
      const goalish = GOALISH.test(chunk);
      const p = goalish && !/\b(?:shares?|sh)\b/i.test(chunk) ? null : position(chunk);
      if (!p) { if (!goalish && /[a-z0-9]/i.test(chunk)) unread.push(chunk.trim()); continue; }
      if (p.cash != null) cash += p.cash;
      else if (p.cashWeight != null) cashWeight += p.cashWeight;
      else {
        const prev = positions.get(p.symbol) || { symbol: p.symbol };
        for (const k of ["shares", "value", "weight"]) if (p[k] != null) prev[k] = (prev[k] || 0) + p[k];
        positions.set(p.symbol, prev);
      }
    }
  }
  return { positions: [...positions.values()], cash, cashWeight, goals: parseGoals(String(raw || "")), unread };
}

// Turns positions into weights (fractions of the whole portfolio, cash included).
// `prices` is needed only for positions given as share counts.
// Returns { weights: { SYM: w }, cashWeight, total: dollars or null, missing: [symbols without a price] }.
export function toWeights({ positions, cash = 0, cashWeight = 0 }, prices = {}) {
  const pctOnly = positions.length > 0 && positions.every((p) => p.weight != null && p.shares == null && p.value == null);
  if (pctOnly) {
    const sum = positions.reduce((a, p) => a + p.weight, 0) + cashWeight;
    const scale = sum > 99.5 ? 100 / sum : 1; // over 100% is scaled down; under 100% leaves the rest in cash
    const weights = Object.fromEntries(positions.map((p) => [p.symbol, (p.weight * scale) / 100]));
    const held = Object.values(weights).reduce((a, b) => a + b, 0);
    return { weights, cashWeight: Math.max(0, Math.round((1 - held) * 1e6) / 1e6), total: null, missing: [] };
  }
  const dollars = {}, missing = [];
  for (const p of positions) {
    if (p.value != null) dollars[p.symbol] = p.value;
    else if (p.shares != null) {
      if (Number.isFinite(prices[p.symbol])) dollars[p.symbol] = p.shares * prices[p.symbol]; else missing.push(p.symbol);
    }
  }
  const invested = Object.values(dollars).reduce((a, b) => a + b, 0);
  // Cash may be dollars ("3k cash") or a share of the whole ("10% cash") next to share counts.
  const pctCash = !cash && cashWeight > 0 && cashWeight < 100 ? cashWeight / 100 : 0;
  const total = pctCash ? invested / (1 - pctCash) : invested + cash;
  if (!(total > 0)) return { weights: {}, cashWeight: 0, total: null, missing };
  return { weights: Object.fromEntries(Object.entries(dollars).map(([s, v]) => [s, v / total])), cashWeight: pctCash || cash / total, total, missing };
}
