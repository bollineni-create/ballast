import test from "node:test";
import assert from "node:assert/strict";
import { parseStrategy, ParseError } from "../public/lib/parse.js";
import { describe } from "../public/lib/spec.js";
import { localStrategy } from "../public/lib/builder.js";

// Free-form ideas -> the canonical rules Ballast shows (and re-reads) for them.
const CASES = [
  ["Buy when the 50 day moving average crosses above the 200 day, sell when it crosses back below",
    "Buy when 50-day SMA crosses above 200-day SMA\nSell when 50-day SMA crosses below 200-day SMA"],
  ["Buy QQQ when the VIX closes above 30, sell after 20 days, 5% stop",
    "Trade QQQ\nBuy when price of ^VIX is above 30\nStop loss 5%\nSell after 20 days"],
  ["60/40 stocks and bonds rebalanced quarterly", "Hold 60% SPY, 40% TLT\nRebalance quarterly"],
  ["Hold SPY when it's above its 200 day average, otherwise bonds",
    "Hold 100% SPY\nWhen price of SPY is at most 200-day SMA of SPY, hold TLT instead"],
  ["Each month buy the top 3 of SPY, EFA, EEM, GLD, TLT by 6-month momentum",
    "Rotate among SPY, EFA, EEM, GLD, TLT\nHold the top 3 by 126-day return\nRebalance monthly"],
  ["Buy toyota when it drops 10% from its 52 week high, sell when it gets back to the 50 day average",
    "Trade 7203.T\nBuy when drawdown from 252-day high is at least 10%\nSell when price is at least 50-day SMA"],
  ["buy bitcoin when RSI under 25, sell when rsi above 60, 8% trailing stop",
    "Trade BTC-USD\nBuy when 14-day RSI is below 25\nSell when 14-day RSI is above 60\nTrailing stop 8%"],
  ["Buy gold when the dollar falls 3% in a month and sell after 3 months",
    "Trade GC=F\nBuy when 21-day return of DX-Y.NYB is at most -3%\nSell after 63 days"],
  ["Buy on a golden cross, sell on a death cross",
    "Buy when 50-day SMA crosses above 200-day SMA\nSell when 50-day SMA crosses below 200-day SMA"],
  ["Buy when RSI 14 crosses above 30, sell when it crosses above 70, with a 5% stop loss",
    "Buy when 14-day RSI crosses above 30\nSell when 14-day RSI crosses above 70\nStop loss 5%"],
  ["Buys when the MACD line crosses above its signal line and sells on the opposite cross.",
    "Buy when MACD line (12, 26, 9) crosses above MACD signal line (12, 26, 9)\nSell when MACD line (12, 26, 9) crosses below MACD signal line (12, 26, 9)"],
  ["Buys when price closes above the prior 55-day high and exits on a close below the prior 20-day low.",
    "Buy when price is above 55-day high\nSell when price is below 20-day low"],
  ["buy spy after 3 down days in a row, sell when it closes above the 5 day sma",
    "Trade SPY\nBuy when price closes down 3 days in a row\nSell when price is above 5-day SMA"],
  ["Equal weight SPY, QQQ, GLD and TLT, rebalance when any holding drifts 5%",
    "Hold 25% SPY, 25% QQQ, 25% GLD, 25% TLT\nRebalance when any holding drifts 5% from its target"],
  ["best performing of SPY, QQQ and TLT over the last 3 months, go to cash if momentum is negative",
    "Rotate among SPY, QQQ, TLT\nHold the top 1 by 63-day return\nOnly hold assets whose 63-day return is above 0\nRebalance monthly"],
  ["Buy the Nikkei when it is more than 5% below its 50-day SMA and RSI is below 35, sell when RSI is above 60",
    "Trade ^N225\nBuy when price is more than 5% below 50-day SMA and 14-day RSI is below 35\nSell when 14-day RSI is above 60"],
  ["Buy AAPL if the 10 day EMA is above the 30 day EMA and the S&P 500 is above its 200 day moving average, sell when the MACD histogram turns negative",
    "Trade AAPL\nBuy when 10-day EMA is above 30-day EMA and price of SPY is above 200-day SMA of SPY\nSell when MACD histogram (12, 26, 9) crosses below 0"],
  ["buy ETH-USD when it rises 10% in 5 days, sell when it falls 5% in 2 days",
    "Trade ETH-USD\nBuy when 5-day return is at least 10%\nSell when 2-day return is at most -5%"],
  ["Buy SAP when price is within 2% of the 52-week high and volume is above the 20 day average volume, take profit 15%",
    "Trade SAP.DE\nBuy when price is less than 2% below 252-day high and volume is above 20-day average volume\nTake profit 15%"],
  ["Buy SPY when RSI is below 30, sell when RSI is above 70\nStop loss 5%\nTrailing stop 8%\nTake profit 20%",
    "Trade SPY\nBuy when 14-day RSI is below 30\nSell when 14-day RSI is above 70\nStop loss 5%\nTake profit 20%\nTrailing stop 8%"],
  ["When the VIX is above 30, hold cash instead. Hold 70% SPY, 30% GLD. Rebalance monthly",
    "Hold 70% SPY, 30% GLD\nWhen price of ^VIX is above 30, hold cash instead\nRebalance monthly"],
  ["Buy when RSI(2) < 10 or price closes down 4 days in a row, sell when RSI(2) > 70, position size 50%",
    "Buy when 2-day RSI is below 10 or price closes down 4 days in a row\nSell when 2-day RSI is above 70\nPosition size 50%"],
];

test("free-form English becomes the expected canonical rules", () => {
  for (const [input, expected] of CASES) assert.equal(describe(parseStrategy(input).spec), expected, input);
});

test("canonical rules read back to the identical spec", () => {
  for (const [input] of CASES) {
    const a = parseStrategy(input).spec;
    assert.deepEqual(parseStrategy(describe(a)).spec, a, input);
  }
});

test("shorts, volatility targets and inverse-volatility weights round-trip", () => {
  const cases = [
    ["Short SPY when the 50 day SMA crosses below the 200 day SMA, cover when it crosses back above, 8% stop loss",
      "Trade SPY\nShort when 50-day SMA crosses below 200-day SMA\nCover when 50-day SMA crosses above 200-day SMA\nStop loss 8%"],
    ["Buy QQQ when RSI is below 30, sell when RSI is above 60, short when RSI is above 80 and cover when RSI is below 50",
      "Trade QQQ\nBuy when 14-day RSI is below 30\nSell when 14-day RSI is above 60\nShort when 14-day RSI is above 80\nCover when 14-day RSI is below 50"],
    ["60/40 SPY TLT rebalanced monthly, target 10% volatility", "Hold 60% SPY, 40% TLT\nTarget 10% volatility\nRebalance monthly"],
    ["risk parity SPY, TLT, GLD", "Hold 33.3333% SPY, 33.3333% TLT, 33.3333% GLD\nWeight by inverse volatility\nRebalance monthly"],
    ["Buy SPY when price is above the 200 day SMA, sell when price is below the 200 day SMA, 12% volatility target, take profit 30%",
      "Trade SPY\nBuy when price is above 200-day SMA\nSell when price is below 200-day SMA\nTake profit 30%\nTarget 12% volatility"],
  ];
  for (const [english, rules] of cases) {
    const r = parseStrategy(english);
    assert.deepEqual(r.unparsed, [], english);
    assert.equal(describe(r.spec), rules);
    assert.equal(describe(parseStrategy(rules).spec), rules);
  }
});

test("nonsense is rejected with a helpful message", () => {
  assert.throws(() => parseStrategy("make me rich"), (e) => e instanceof ParseError && /buy rule, a short rule or a portfolio/.test(e.message));
  assert.throws(() => parseStrategy(""), ParseError);
});

test("unreadable parts are reported, not silently dropped", () => {
  const r = parseStrategy("Buy when RSI is below 30, sell when the moon is full");
  assert.equal(r.unparsed.length, 1);
  assert.match(r.unparsed[0], /moon/);
});

test("follow-up edits change only the rule they name", () => {
  const base = "Trade SPY\nBuy when price is above 200-day SMA\nShort when 14-day RSI is above 80\nCover when 14-day RSI is below 50\nTake profit 30%\nTarget 12% volatility";
  const edit = (t) => localStrategy(t, base).rules;
  assert.equal(edit("target 10% volatility"), base.replace("12%", "10%"));
  assert.equal(edit("remove the volatility target"), base.replace("\nTarget 12% volatility", ""));
  assert.equal(edit("remove the target"), base.replace("\nTake profit 30%", ""));
  assert.equal(edit("take profit 20%"), base.replace("30%", "20%"));
  assert.equal(edit("buy to cover when RSI is below 40"), base.replace("below 50", "below 40"));
  assert.equal(edit("cover when RSI is below 40"), base.replace("below 50", "below 40"));
  assert.equal(edit("to cover when RSI is below 40"), base);
  assert.equal(edit("I want to cover when RSI is below 40"), base);
});
