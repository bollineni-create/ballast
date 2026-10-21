// Technical indicators. Every function returns an array aligned with its input;
// values are NaN until enough bars exist to compute them.

export function sma(src, n) {
  const out = new Array(src.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < src.length; i++) {
    sum += src[i];
    if (i >= n) sum -= src[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function ema(src, n) {
  const out = new Array(src.length).fill(NaN);
  const k = 2 / (n + 1);
  let prev = NaN;
  for (let i = 0; i < src.length; i++) {
    if (i === n - 1) {
      let s = 0;
      for (let j = 0; j < n; j++) s += src[j];
      prev = s / n;
    } else if (i >= n) {
      prev = src[i] * k + prev * (1 - k);
    }
    if (i >= n - 1) out[i] = prev;
  }
  return out;
}

export function rsi(src, n = 14) {
  const out = new Array(src.length).fill(NaN);
  let gain = 0, loss = 0;
  for (let i = 1; i < src.length; i++) {
    const d = src[i] - src[i - 1];
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= n) {
      gain += g; loss += l;
      if (i === n) { gain /= n; loss /= n; }
    } else {
      gain = (gain * (n - 1) + g) / n;
      loss = (loss * (n - 1) + l) / n;
    }
    if (i >= n) out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function stdev(src, n) {
  const mean = sma(src, n);
  return src.map((_, i) => {
    if (i < n - 1) return NaN;
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (src[j] - mean[i]) ** 2;
    return Math.sqrt(s / n);
  });
}

export function bollinger(src, n = 20, k = 2) {
  const mid = sma(src, n), sd = stdev(src, n);
  return {
    mid,
    upper: mid.map((m, i) => m + k * sd[i]),
    lower: mid.map((m, i) => m - k * sd[i]),
  };
}

export function macd(src, fast = 12, slow = 26, sig = 9) {
  const f = ema(src, fast), s = ema(src, slow);
  const line = f.map((v, i) => v - s[i]);
  const firstValid = line.findIndex((v) => !Number.isNaN(v));
  const signal = new Array(src.length).fill(NaN);
  if (firstValid >= 0) {
    const tail = ema(line.slice(firstValid), sig);
    tail.forEach((v, j) => (signal[firstValid + j] = v));
  }
  return { macd: line, signal, hist: line.map((v, i) => v - signal[i]) };
}

export function atr(high, low, close, n = 14) {
  const tr = high.map((h, i) =>
    i === 0 ? h - low[i] : Math.max(h - low[i], Math.abs(h - close[i - 1]), Math.abs(low[i] - close[i - 1]))
  );
  return sma(tr, n);
}

function windowExtreme(src, n, better) {
  const out = new Array(src.length).fill(NaN);
  for (let i = n - 1; i < src.length; i++) {
    let v = src[i - n + 1];
    for (let j = i - n + 2; j <= i; j++) if (better(src[j], v)) v = src[j];
    out[i] = v;
  }
  return out;
}

export const highest = (src, n) => windowExtreme(src, n, (a, b) => a > b);
export const lowest = (src, n) => windowExtreme(src, n, (a, b) => a < b);

export function roc(src, n) {
  return src.map((v, i) => (i < n ? NaN : (v / src[i - n] - 1) * 100));
}

const at = (x, i) => (typeof x === "number" ? x : x[i]);

// True on the bar where `a` moves from at-or-below `b` to above it. `b` may be a number.
export function crossover(a, b, i) {
  if (i < 1) return false;
  return at(a, i - 1) <= at(b, i - 1) && at(a, i) > at(b, i);
}

export function crossunder(a, b, i) {
  if (i < 1) return false;
  return at(a, i - 1) >= at(b, i - 1) && at(a, i) < at(b, i);
}

export const ta = { sma, ema, rsi, stdev, bollinger, macd, atr, highest, lowest, roc, crossover, crossunder };
