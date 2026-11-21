// Strategy builder: turns any plain-English trading idea into Ballast's canonical rule
// lines. Claude does the translation when a key is set; the built-in parser reads the
// result (so the rules are always checked before they reach the page) and handles
// requests on its own when no key is set or Claude is unavailable. Shared by the
// local server and the hosted website's serverless route.
import Anthropic from "@anthropic-ai/sdk";
import { parseStrategy } from "./public/lib/parse.js";
import { localStrategy } from "./public/lib/builder.js";
import { describe, summarize, nameFor } from "./public/lib/spec.js";
import { MARKETS } from "./public/lib/markets.js";

export const aiEnabled = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const client = aiEnabled ? new Anthropic() : null;

// Set when Anthropic rejects the key, so the page can say so instead of claiming Claude is on.
export let aiKeyError = null;
const KEY_HELP = "Anthropic rejected the API key. Paste a valid key (it starts with sk-ant-) into Ballast > Edit Keys; until then the built-in builder is used.";

const SYMBOL_HINTS = MARKETS.map((g) => `${g.group}: ${g.items.map(([s, n]) => `${s} (${n})`).join(", ")}`).join("\n");

const SYSTEM = `You translate plain-English trading ideas into Ballast's rule language: short English lines that a deterministic parser reads and a daily-bar backtester runs. Output only lines in the grammar below.

STRATEGY TYPE 1: buy/sell rules (long only, daily bars)
  Trade <SYMBOL>[, <SYMBOL>...]          optional; omit to trade whatever symbol the user has selected
  Buy when <condition>                    required
  Sell when <condition>                   optional
  Stop loss <N>%                          optional, below entry price
  Take profit <N>%                        optional
  Trailing stop <N>%                      optional, below the highest high since entry
  Sell after <N> days                     optional time limit, in trading days
  Position size <N>%                      optional, % of equity per position (default: split evenly across traded symbols)
  Short when <condition>                  optional, alone or alongside Buy when: sells short
  Cover when <condition>                  optional, closes a short (stops, targets and time limits apply to shorts too)
  Target <N>% volatility                  optional, shrinks positions when the asset's volatility runs above N% a year

STRATEGY TYPE 2: portfolios
  Hold <N>% <SYMBOL>, <N>% <SYMBOL>...    fixed weights summing to 100
  or
  Rotate among <SYMBOL>, <SYMBOL>, ...
  Hold the top <N> by <value>             ranks every asset by <value> (written without "of SYMBOL")
  Only hold assets whose <value> is above 0     optional; empty slots stay in cash
  then optionally
  When <condition>, hold <SYMBOL> instead       or: When <condition>, hold cash instead   (checked daily)
  Rebalance daily|weekly|monthly|quarterly|yearly
  Rebalance when any holding drifts <N>% from its target
  Weight by inverse volatility            optional ("risk parity"): calmer assets get bigger weights
  Target <N>% volatility                  optional: holds some cash when the portfolio's volatility runs above N% a year

CONDITIONS
  <value> is above|below|at least|at most <value>
  <value> crosses above|below <value>
  <value> is more than|at least|less than <N>% above|below <value>
  price closes up|down <N> days in a row            (or: price of <SYMBOL> closes ...)
  combine with "and", "or", parentheses, and "not (...)"

VALUES (append " of <SYMBOL>" to read another market, e.g. "price of ^VIX", "200-day SMA of SPY"; without it a value reads the asset being traded)
  price | open | high | low | volume | a plain number (percent values may carry %)
  <N>-day SMA | <N>-day EMA | <N>-day RSI | <N>-day ATR
  <N>-day return (percent change over N days) | <N>-day volatility (annualized %, from daily returns)
  <N>-day high | <N>-day low   (highest high / lowest low of the N days BEFORE today)
  drawdown from <N>-day high   (percent below the highest close of the last N days)
  upper|middle|lower Bollinger Band (<N>, <K>)
  MACD line (<F>, <S>, <G>) | MACD signal line (<F>, <S>, <G>) | MACD histogram (<F>, <S>, <G>)
  <N>-day average volume
  <value> <N> days ago

Conventions: 1 week = 5 days, 1 month = 21, 3 months = 63, 6 months = 126, 1 year or 52 weeks = 252. RSI defaults to 14, MACD to (12, 26, 9), Bollinger to (20, 2).

SYMBOLS use Yahoo Finance tickers: US stocks/ETFs plain (AAPL, SPY), indices with ^ (^GSPC, ^VIX, ^N225), other exchanges with a suffix (.L London, .DE Frankfurt, .PA Paris, .AS Amsterdam, .SW Zurich, .T Tokyo, .HK Hong Kong, .SS Shanghai, .TW Taipei, .KS Seoul, .NS India, .AX Sydney, .TO Toronto, .SA São Paulo), FX with =X (EURUSD=X), futures with =F (GC=F gold, CL=F oil), crypto as Coinbase pairs (BTC-USD). Common ones:
${SYMBOL_HINTS}
Map names to tickers ("Toyota" -> 7203.T, "the S&P 500" -> SPY when traded or as a market filter, "bonds" -> TLT, "gold" -> GLD for portfolios or GC=F for futures). Pick the most liquid sensible ticker.

If the idea needs something the language can't express (intraday bars, options, fundamentals, news, leverage above 1x), write the closest version and say exactly what you changed in the explanation. Never invent syntax.

Reply with exactly:
NAME: <short strategy name>
EXPLANATION: <1-3 plain sentences: what it does, any assumptions or changes>
\`\`\`rules
<rule lines>
\`\`\``;

async function askClaude(content) {
  const response = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 4000,
    output_config: { effort: "low" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    messages: content,
  });
  if (response.stop_reason === "refusal") throw new Error("The model declined this request.");
  return response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

async function generateWithClaude(prompt, currentRules) {
  const ask = currentRules
    ? `Current rules:\n\`\`\`rules\n${currentRules}\n\`\`\`\n\nRequested change: ${prompt}`
    : prompt;
  const messages = [{ role: "user", content: ask }];
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await askClaude(messages);
    const rules = text.match(/```(?:rules)?\s*\n([\s\S]*?)```/)?.[1]?.trim();
    if (!rules) throw new Error("The model did not return any rules.");
    try {
      const parsed = parseStrategy(rules);
      if (parsed.unparsed.length) throw new Error(`These lines don't fit the rule language: ${parsed.unparsed.join(" | ")}`);
      return {
        name: text.match(/NAME:\s*(.+)/)?.[1]?.trim() || nameFor(parsed.spec),
        explanation: text.match(/EXPLANATION:\s*([\s\S]+?)(?:```|$)/)?.[1]?.trim() || summarize(parsed.spec),
        rules: describe(parsed.spec),
        notes: parsed.notes,
        source: "ai",
      };
    } catch (e) {
      messages.push({ role: "assistant", content: text }, { role: "user", content: `The parser rejected that: ${e.message}. Rewrite the rules using only the grammar.` });
    }
  }
  throw new Error("Claude's rules didn't pass the parser twice.");
}

// `current` is the strategy's current rule text, used when refining.
export async function generateStrategy(prompt, current) {
  if (!aiEnabled) return localStrategy(prompt, current);
  try {
    return await generateWithClaude(prompt, current);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      aiKeyError = KEY_HELP;
      return { ...localStrategy(prompt, current), warning: KEY_HELP };
    }
    const reason = e instanceof Anthropic.APIError ? e.error?.error?.message || `HTTP ${e.status}` : e.message;
    return { ...localStrategy(prompt, current), warning: `Claude unavailable (${reason}); used the built-in parser.` };
  }
}

// ---------- reading a portfolio from a screenshot or loose text ----------
const PORTFOLIO_SYSTEM = `You read investment account screenshots and loose descriptions of holdings, and return the positions as JSON. You never give advice.

Return ONLY a JSON object, no prose, in this shape:
{"positions":[{"symbol":"AAPL","shares":50,"value":17000}],"cash":1200,"goals":{"years":20,"monthly":500,"target":1000000,"maxDrop":25,"risk":"low|medium|high","income":true},"notes":"one short sentence, only if something was unreadable or assumed"}

Rules:
- symbol: the Yahoo Finance ticker (AAPL, VTI, BRK-B, 7203.T, BTC-USD for crypto). If only a fund or company name is shown, give its ticker. Skip a row you cannot identify and mention it in notes.
- shares: the quantity held, if shown. value: the position's current market value in the account's currency, if shown. Give whichever the image shows, or both. Use "weight" (a percent of the portfolio) only when neither is shown.
- cash: cash, sweep or money-market balance, if shown.
- Numbers are plain numbers: no currency signs, commas or percent signs.
- goals: include only fields the person actually stated in their text; omit the rest (omit "goals" if none). years = time horizon, monthly = money added per month, target = amount they want to reach, maxDrop = the largest percent drop they said they could accept.
- Do not invent positions. If nothing in the input is a holding, return {"positions":[]}.`;

const cleanNum = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);

// `image` is a data URL (PNG, JPEG, WebP or GIF). Returns { positions, cash, goals, notes }.
export async function readPortfolio({ text = "", image = null }) {
  if (!aiEnabled) throw Object.assign(new Error("Reading a picture needs Claude. Add an Anthropic API key, or type the positions instead."), { status: 501 });
  const content = [];
  if (image) {
    const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(image);
    if (!m) throw Object.assign(new Error("That picture isn't a PNG, JPEG, WebP or GIF."), { status: 400 });
    content.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
  }
  content.push({ type: "text", text: text.trim() ? `What the person wrote:\n${text.slice(0, 6000)}` : "Read the holdings in this picture." });
  let raw;
  try {
    const response = await client.messages.create({ model: "claude-opus-5-5", max_tokens: 4000, system: PORTFOLIO_SYSTEM, messages: [{ role: "user", content }] });
    if (response.stop_reason === "refusal") throw new Error("The model declined this request.");
    raw = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) { aiKeyError = KEY_HELP; throw Object.assign(new Error(KEY_HELP), { status: 502 }); }
    throw Object.assign(new Error(`Claude couldn't read that (${e instanceof Anthropic.APIError ? e.error?.error?.message || `HTTP ${e.status}` : e.message}).`), { status: 502 });
  }
  let json;
  try { json = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)); } catch { throw Object.assign(new Error("Claude's reading of that came back garbled. Try again, or type the positions."), { status: 502 }); }
  // Keep only what the page expects, whatever the model returned.
  const positions = (Array.isArray(json.positions) ? json.positions : []).slice(0, 80).map((p) => {
    const symbol = String(p?.symbol || "").toUpperCase().trim();
    if (!/^\^?[A-Z0-9][A-Z0-9.\-=]{0,14}$/.test(symbol)) return null;
    const out = { symbol, shares: cleanNum(p.shares), value: cleanNum(p.value), weight: cleanNum(p.weight) };
    return out.shares || out.value || out.weight ? JSON.parse(JSON.stringify(out)) : null;
  }).filter(Boolean);
  const g = json.goals && typeof json.goals === "object" ? json.goals : {};
  const goals = JSON.parse(JSON.stringify({
    years: cleanNum(g.years), monthly: cleanNum(g.monthly), target: cleanNum(g.target), maxDrop: cleanNum(g.maxDrop),
    risk: ["low", "medium", "high"].includes(g.risk) ? g.risk : undefined, income: g.income === true ? true : undefined,
  }));
  return { positions, cash: cleanNum(json.cash) || 0, goals, notes: typeof json.notes === "string" ? json.notes.slice(0, 300) : "" };
}

export { localStrategy };
