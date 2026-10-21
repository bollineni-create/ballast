// Market data: a deterministic simulated feed per symbol, plus CSV import for real data.

function hashString(s) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand) {
  const u = Math.max(rand(), 1e-12), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Builds one bar after `prevClose`, using a regime-switching random walk so
// simulated series have trends and choppy stretches.
export function nextBar(prevClose, time, rand, state) {
  if (rand() < 0.01) state.drift = (rand() - 0.45) * 0.003;
  const ret = state.drift + state.vol * gaussian(rand);
  const open = prevClose * (1 + state.vol * 0.25 * gaussian(rand));
  const close = Math.max(0.5, prevClose * Math.exp(ret));
  const span = Math.abs(gaussian(rand)) * state.vol * prevClose;
  const high = Math.max(open, close) + span * 0.6;
  const low = Math.max(0.1, Math.min(open, close) - span * 0.6);
  const volume = Math.round(1e6 * (0.5 + rand()) * (1 + Math.abs(ret) * 40));
  return { time, open, high, low, close, volume };
}

export function simulatedBars(symbol, days = 750) {
  const rand = rng(hashString(symbol.toUpperCase()));
  const state = { drift: (rand() - 0.4) * 0.0015, vol: 0.012 + rand() * 0.02 };
  let close = 20 + rand() * 300;
  const bars = [];
  const d = new Date(Date.UTC(2023, 0, 2));
  while (bars.length < days) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) {
      const bar = nextBar(close, d.getTime(), rand, state);
      bars.push(bar);
      close = bar.close;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return bars;
}

// Accepts CSV with a header row containing date/time and close columns
// (open/high/low/volume optional), e.g. exports from most data providers.
export function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error("CSV needs a header row and at least one data row.");
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/[^a-z]/g, ""));
  const col = (...names) => header.findIndex((h) => names.includes(h));
  const iTime = col("date", "time", "timestamp", "datetime");
  const iClose = col("close", "adjclose", "price");
  if (iTime < 0 || iClose < 0) throw new Error("CSV must have a Date and a Close column.");
  const iOpen = col("open"), iHigh = col("high"), iLow = col("low"), iVol = col("volume", "vol");
  const bars = [];
  for (const line of lines.slice(1)) {
    const f = line.split(",");
    const close = parseFloat(f[iClose]);
    const rawTime = f[iTime].trim();
    const time = /^\d+$/.test(rawTime)
      ? Number(rawTime) * (rawTime.length <= 10 ? 1000 : 1)
      : Date.parse(rawTime);
    if (!Number.isFinite(close) || !Number.isFinite(time)) continue;
    const num = (i) => (i >= 0 && Number.isFinite(parseFloat(f[i])) ? parseFloat(f[i]) : close);
    bars.push({ time, open: num(iOpen), high: num(iHigh), low: num(iLow), close, volume: iVol >= 0 ? parseFloat(f[iVol]) || 0 : 0 });
  }
  if (bars.length < 2) throw new Error("No usable rows found in CSV.");
  return bars.sort((a, b) => a.time - b.time);
}

export function toSeries(bars) {
  return {
    time: bars.map((b) => b.time),
    open: bars.map((b) => b.open),
    high: bars.map((b) => b.high),
    low: bars.map((b) => b.low),
    close: bars.map((b) => b.close),
    volume: bars.map((b) => b.volume),
  };
}
