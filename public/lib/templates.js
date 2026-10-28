// Offline strategy builder: turns common plain-English ideas into strategy code
// without an AI model. Used when no API key is configured, and as a fallback.

const pct = (text, words) => {
  const m = text.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*%\\s*(?:${words})|(?:${words})\\D{0,12}(\\d+(?:\\.\\d+)?)\\s*%`));
  return m ? parseFloat(m[1] ?? m[2]) / 100 : null;
};

function riskLines(text) {
  const stop = pct(text, "stop(?:[- ]loss)?|stop out");
  const target = pct(text, "take[- ]profit|profit target|target");
  const lines = [];
  if (stop) lines.push(`  stopLoss: ${stop},`);
  if (target) lines.push(`  takeProfit: ${target},`);
  return { lines, stop, target };
}

function nums(text) {
  return (text.match(/\d+(?:\.\d+)?/g) || []).map(Number);
}

export function templateStrategy(prompt) {
  const text = prompt.toLowerCase();
  const risk = riskLines(text);
  const riskText = [risk.stop && `${risk.stop * 100}% stop loss`, risk.target && `${risk.target * 100}% take profit`].filter(Boolean).join(" and ");
  const withRisk = (body) => body.replace("RISK\n", risk.lines.length ? risk.lines.join("\n") + "\n" : "");
  const clean = text.replace(/\d+(?:\.\d+)?\s*%[^,.]*/g, "");
  const n = nums(clean);

  if (/\brsi\b/.test(text)) {
    const len = n.find((x) => x >= 2 && x <= 50 && x !== 30 && x !== 70) ?? 14;
    const low = n.find((x) => x < 50 && x !== len) ?? 30;
    const high = n.find((x) => x > 50 && x <= 100) ?? 70;
    return {
      name: `RSI ${len} mean reversion`,
      explanation: `Buys when RSI(${len}) crosses back above ${low} (oversold) and sells when it crosses above ${high} (overbought).${riskText ? ` Uses a ${riskText}.` : ""}`,
      code: withRisk(`const r = ta.rsi(data.close, ${len});

return {
  entry: (i) => ta.crossover(r, ${low}, i),
  exit: (i) => ta.crossover(r, ${high}, i),
RISK
};`),
    };
  }

  if (/bollinger|band/.test(text)) {
    const len = n.find((x) => x >= 5) ?? 20;
    const k = n.find((x) => x > 0 && x < 5) ?? 2;
    return {
      name: `Bollinger ${len}/${k} reversion`,
      explanation: `Buys when price closes below the lower Bollinger Band (${len}, ${k}σ) and exits when it returns to the middle band.${riskText ? ` Uses a ${riskText}.` : ""}`,
      code: withRisk(`const bb = ta.bollinger(data.close, ${len}, ${k});

return {
  entry: (i) => data.close[i] < bb.lower[i],
  exit: (i) => data.close[i] > bb.mid[i],
RISK
};`),
    };
  }

  if (/macd/.test(text)) {
    return {
      name: "MACD signal cross",
      explanation: `Buys when the MACD line crosses above its signal line and sells on the opposite cross.${riskText ? ` Uses a ${riskText}.` : ""}`,
      code: withRisk(`const m = ta.macd(data.close, 12, 26, 9);

return {
  entry: (i) => ta.crossover(m.macd, m.signal, i),
  exit: (i) => ta.crossunder(m.macd, m.signal, i),
RISK
};`),
    };
  }

  if (/breakout|donchian|new high|channel/.test(text)) {
    const len = n.find((x) => x >= 5) ?? 20;
    const exitLen = n.filter((x) => x >= 5)[1] ?? Math.max(5, Math.round(len / 2));
    return {
      name: `${len}-day breakout`,
      explanation: `Buys when price closes above the prior ${len}-day high and exits on a close below the prior ${exitLen}-day low.${riskText ? ` Uses a ${riskText}.` : ""}`,
      code: withRisk(`const hi = ta.highest(data.high, ${len});
const lo = ta.lowest(data.low, ${exitLen});

return {
  entry: (i) => i > 0 && data.close[i] > hi[i - 1],
  exit: (i) => i > 0 && data.close[i] < lo[i - 1],
RISK
};`),
    };
  }

  if (/\b(?:goes|go|drops?|dips?|falls?|trades?|closes?|is|gets?) (?:under|below)\b|\bdips?\b|\bpullback\b/.test(text)) {
    const len = n.find((x) => x >= 5) ?? 200;
    return {
      name: `Buy the dip below SMA ${len}`,
      explanation: `Buys when price closes below its ${len}-day average and sells once it closes back above it.${riskText ? ` Uses a ${riskText}.` : ""} The rules trade the symbol you backtest, so set Symbol to what you want to buy (QQQ for the Nasdaq-100, SPY for the S&P 500).`,
      code: withRisk(`const avg = ta.sma(data.close, ${len});

return {
  entry: (i) => data.close[i] < avg[i],
  exit: (i) => data.close[i] > avg[i],
RISK
};`),
    };
  }

  // Default: moving-average crossover.
  const recognized = /\b[se]ma\b|moving average|exponential|cross/.test(text);
  const kind = /\bema\b|exponential/.test(text) ? "ema" : "sma";
  const [a = 20, b = 50] = n.filter((x) => x >= 2);
  const fast = Math.min(a, b), slow = Math.max(a, b) === fast ? fast * 2 : Math.max(a, b);
  return {
    name: `${kind.toUpperCase()} ${fast}/${slow} crossover`,
    explanation: `${recognized ? "" : "The built-in builder didn't recognize this idea, so here is its default setup. It handles moving-average crossovers, RSI, Bollinger Bands, MACD, breakouts and dips below an average; a valid Anthropic key lets Claude write anything else. "}Buys when the ${fast}-bar ${kind.toUpperCase()} crosses above the ${slow}-bar ${kind.toUpperCase()} and sells when it crosses back below.${riskText ? ` Uses a ${riskText}.` : ""}`,
    code: withRisk(`const fast = ta.${kind}(data.close, ${fast});
const slow = ta.${kind}(data.close, ${slow});

return {
  entry: (i) => ta.crossover(fast, slow, i),
  exit: (i) => ta.crossunder(fast, slow, i),
RISK
};`),
  };
}

export const LIBRARY = [
  { prompt: "Buy when the 20-day SMA crosses above the 50-day SMA, sell on the cross back down", tag: "Trend" },
  { prompt: "Buy when RSI 14 crosses above 30, sell when it crosses above 70, with a 5% stop loss", tag: "Mean reversion" },
  { prompt: "Buy a close below the lower Bollinger Band 20 2, exit at the middle band", tag: "Mean reversion" },
  { prompt: "MACD signal line crossover with a 10% take profit", tag: "Momentum" },
  { prompt: "55-day breakout, exit on a 20-day low", tag: "Trend" },
  { prompt: "EMA 9 / 21 crossover with a 3% stop loss and 6% take profit", tag: "Trend" },
].map((item) => ({ ...item, ...templateStrategy(item.prompt) }));
