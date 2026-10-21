// Paper-trading rebalancing autopilot for Alpaca.
//
// Once per market day, after the configured check time (US Eastern), it reads the
// paper account, compares holdings with the target weights, and if anything has
// drifted outside the band, places market orders (sells first, then buys) to bring
// the portfolio back to target. Every decision, order, fill and error is appended
// to autopilot-data/journal.jsonl so the test can be audited afterwards.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { alpaca, alpacaConfigured } from "./alpaca.js";
import { analyze, plan } from "./public/lib/rebalance.js";
import { getQuotes, getHistory, cleanSymbol } from "./marketdata.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const dataDir = process.env.AUTOPILOT_DIR || path.join(here, "autopilot-data");
const configPath = path.join(dataDir, "config.json");
const journalPath = path.join(dataDir, "journal.jsonl");
const lockPath = path.join(dataDir, ".lock");
export const stopPath = path.join(dataDir, "STOP");

const DEFAULT_CONFIG = {
  enabled: false,
  targets: [
    { symbol: "VTI", target: 60 },
    { symbol: "VXUS", target: 25 },
    { symbol: "BND", target: 15 },
  ],
  band: 5,
  // "band": trade whenever a holding drifts past the band.
  // "monthly": rebalance to target at the first check of each month, and only then.
  rebalance: "band",
  minTrade: 25,
  cashBuffer: 1,
  checkTimeET: "10:30",
  maxOrderPct: 75,
  benchmark: "SPY",
  startedAt: null,
  startEquity: null,
};

// ---------- config + journal ----------
export function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath, "utf8")) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function validateConfig(cfg) {
  const errors = [];
  const seen = new Set();
  for (const t of cfg.targets) {
    try { cleanSymbol(t.symbol); } catch { errors.push(`Invalid symbol "${t.symbol}"`); }
    if (/-(USD|USDT|USDC|EUR|GBP|BTC|ETH)$/.test(t.symbol)) errors.push(`${t.symbol}: the autopilot trades US stocks and ETFs only`);
    if (seen.has(t.symbol)) errors.push(`${t.symbol} is listed twice`);
    seen.add(t.symbol);
    if (!(t.target >= 0 && t.target <= 100)) errors.push(`${t.symbol}: target must be 0–100%`);
  }
  const sum = cfg.targets.reduce((a, t) => a + t.target, 0);
  if (Math.abs(sum - 100) > 0.01) errors.push(`Targets add up to ${sum}%; they must total 100%`);
  if (!(cfg.band > 0 && cfg.band <= 50)) errors.push("Band must be between 0 and 50 points");
  if (!["band", "monthly"].includes(cfg.rebalance)) errors.push('Rebalance must be "band" or "monthly"');
  if (!(cfg.cashBuffer >= 0 && cfg.cashBuffer < 50)) errors.push("Cash buffer must be 0–50%");
  if (!(cfg.minTrade >= 1)) errors.push("Minimum trade must be at least $1");
  if (!/^\d{2}:\d{2}$/.test(cfg.checkTimeET) || cfg.checkTimeET < "09:35" || cfg.checkTimeET > "15:45") errors.push("Check time must be HH:MM between 09:35 and 15:45 ET");
  if (!(cfg.maxOrderPct > 0 && cfg.maxOrderPct <= 100)) errors.push("Max order size must be 1–100% of equity");
  return errors;
}

export function saveConfig(patch) {
  const cfg = { ...loadConfig(), ...patch };
  cfg.targets = cfg.targets.map((t) => ({ symbol: String(t.symbol).trim().toUpperCase(), target: Number(t.target) }));
  for (const k of ["band", "minTrade", "cashBuffer", "maxOrderPct"]) cfg[k] = Number(cfg[k]);
  const errors = validateConfig(cfg);
  if (errors.length) throw Object.assign(new Error(errors.join("; ")), { status: 400 });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  return cfg;
}

function journal(entry) {
  fs.mkdirSync(dataDir, { recursive: true });
  const line = { ts: new Date().toISOString(), ...entry };
  fs.appendFileSync(journalPath, JSON.stringify(line) + "\n");
  return line;
}

export function readJournal(limit = Infinity) {
  try {
    const lines = fs.readFileSync(journalPath, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function nyNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

// Account ids pinned by the other paper-test* folders next to this one.
function siblingPins() {
  const here = path.resolve(dataDir), parent = path.dirname(here);
  return fs.readdirSync(parent)
    .filter((d) => /^paper-test/.test(d) && path.join(parent, d) !== here)
    .map((d) => {
      try { return { dir: d, id: JSON.parse(fs.readFileSync(path.join(parent, d, "config.json"), "utf8")).accountId }; } catch { return { dir: d }; }
    })
    .filter((x) => x.id);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function acquireLock() {
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    // A crashed run can leave a lock behind; treat locks older than 30 minutes as stale.
    if (Date.now() - fs.statSync(lockPath).mtimeMs > 30 * 60e3) {
      fs.unlinkSync(lockPath);
      return acquireLock();
    }
    return false;
  }
}

async function waitForFill(id, timeoutMs = 90e3) {
  const end = Date.now() + timeoutMs;
  let o;
  do {
    o = await alpaca.order(id);
    if (["filled", "canceled", "expired", "rejected", "done_for_day"].includes(o.status)) return o;
    await sleep(2000);
  } while (Date.now() < end);
  return o;
}

// ---------- the daily check ----------
// `force` (a manual "run now") skips the enabled flag, the check time and the
// once-per-day limit. It never skips the safety checks or the market-hours check.
export async function runOnce({ force = false, reason = "schedule" } = {}) {
  if (!alpacaConfigured()) return { skipped: "Alpaca paper keys not set" };
  const cfg = loadConfig();
  if (!force && !cfg.enabled) return { skipped: "autopilot disabled" };
  if (fs.existsSync(stopPath)) return { skipped: `STOP file present (${stopPath})` };
  const { date, time } = nyNow();
  if (!force && time < cfg.checkTimeET) return { skipped: `before today's check time (${cfg.checkTimeET} ET)` };
  const today = readJournal(300).filter((e) => e.date === date);
  if (!force && today.some((e) => e.type === "run")) return { skipped: "already checked today" };
  // Errors and skips retry on the next tick, but give up for the day after three.
  if (!force && today.filter((e) => e.type === "error" || e.type === "skip").length >= 3) return { skipped: "gave up for today after repeated errors" };
  if (!acquireLock()) return { skipped: "another run is in progress" };

  try {
    const errors = validateConfig(cfg);
    if (errors.length) return journal({ type: "error", date, reason, message: `Invalid config: ${errors.join("; ")}` });

    const clock = await alpaca.clock();
    if (!clock.is_open) {
      return force ? journal({ type: "skip", date, reason, message: `Market closed; next open ${clock.next_open}` }) : { skipped: "market closed" };
    }

    const account = await alpaca.account();
    if (account.trading_blocked || account.account_blocked || account.status !== "ACTIVE") {
      return journal({ type: "error", date, reason, message: `Account not tradable (status ${account.status})` });
    }
    // Each test is pinned to the paper account it started on, so keys pasted into
    // the wrong slot can't trade one test's strategy in another test's account.
    if (cfg.accountId && cfg.accountId !== account.id) {
      return journal({ type: "error", date, reason, message: "These keys belong to a different paper account than the one this test started on; nothing traded" });
    }
    if (!cfg.accountId) {
      // Never start a new test on an account another test folder already uses.
      const owner = siblingPins().find((x) => x.id === account.id);
      if (owner) return journal({ type: "error", date, reason, message: `These keys belong to the paper account ${owner.dir} already uses; nothing traded` });
      saveConfig({ accountId: account.id });
    }
    const open = await alpaca.openOrders();
    if (open.length) return journal({ type: "skip", date, reason, message: `${open.length} open order(s) still pending; not trading on top of them` });

    const positions = await alpaca.positions();
    const posBy = Object.fromEntries(positions.map((p) => [p.symbol, p]));
    const symbols = [...new Set([...cfg.targets.map((t) => t.symbol), ...positions.map((p) => p.symbol)])];

    // Price everything from the same quote source, so held and unheld symbols are comparable.
    const { quotes } = await getQuotes(symbols, { fresh: true });
    const prices = {};
    for (const s of symbols) {
      const q = quotes[s]?.price, p = Number(posBy[s]?.current_price);
      prices[s] = Number.isFinite(q) ? q : p;
      if (!Number.isFinite(prices[s])) return journal({ type: "error", date, reason, message: `No price for ${s}; skipping today` });
      if (Number.isFinite(q) && Number.isFinite(p) && Math.abs(q / p - 1) > 0.1) {
        return journal({ type: "error", date, reason, message: `${s} quote ${q} differs from Alpaca's ${p} by over 10%; skipping today` });
      }
    }

    const targetBy = Object.fromEntries(cfg.targets.map((t) => [t.symbol, t.target]));
    const holdings = symbols.map((s) => ({ symbol: s, shares: Number(posBy[s]?.qty || 0), target: targetBy[s] ?? 0 }));
    const cash = Number(account.cash);
    const a = analyze(holdings, prices, cash);

    if (!cfg.startedAt) saveConfig({ startedAt: date, startEquity: Math.round(a.total * 100) / 100 });

    const monthly = cfg.rebalance === "monthly";
    const monthDue = monthly && !readJournal(300).some((e) => e.type === "run" && e.date?.slice(0, 7) === date.slice(0, 7));
    const p = plan(a, { band: monthly ? Infinity : cfg.band, minTrade: cfg.minTrade, fractional: true, cashBuffer: cfg.cashBuffer, force: monthDue });
    journal({
      type: "check", date, reason, equity: a.total, cash,
      weights: a.rows.map((r) => ({ symbol: r.symbol, price: r.price, weight: +r.weight.toFixed(3), target: r.target, drift: +r.drift.toFixed(3) })),
      outOfBand: p.outOfBand.map((r) => r.symbol), needed: p.needed,
    });
    if (!p.needed || !p.trades.length) {
      const message = monthly ? (monthDue ? "Monthly rebalance: already on target" : "Monthly mode: next rebalance at the first check of next month") : "All holdings within band";
      return journal({ type: "run", date, reason, traded: false, message });
    }

    for (const t of p.trades) {
      if (t.amount > (a.total * cfg.maxOrderPct) / 100) {
        return journal({ type: "error", date, reason, message: `Planned ${t.side} ${t.symbol} of $${t.amount.toFixed(2)} exceeds the ${cfg.maxOrderPct}% max order size; nothing traded` });
      }
    }

    const assets = {};
    for (const t of p.trades) {
      assets[t.symbol] ??= await alpaca.asset(t.symbol);
      if (!assets[t.symbol].tradable) return journal({ type: "error", date, reason, message: `${t.symbol} is not tradable on Alpaca; nothing traded` });
    }

    const results = [];
    const place = async (t, order) => {
      const clientOrderId = `slab-${date}-${t.side}-${t.symbol}-${Date.now()}`;
      try {
        const submitted = await alpaca.submitOrder({ symbol: t.symbol, side: t.side.toLowerCase(), clientOrderId, ...order });
        const o = await waitForFill(submitted.id);
        const fill = Number(o.filled_avg_price);
        const entry = journal({
          type: "order", date, side: t.side, symbol: t.symbol, ...order, status: o.status, orderId: o.id,
          expectedPrice: t.price, filledQty: Number(o.filled_qty), fillPrice: Number.isFinite(fill) ? fill : null,
          slippageBps: Number.isFinite(fill) ? +(((fill / t.price - 1) * (t.side === "BUY" ? 1 : -1)) * 1e4).toFixed(2) : null,
        });
        results.push(entry);
      } catch (err) {
        results.push(journal({ type: "error", date, reason, message: `${t.side} ${t.symbol} failed: ${err.message}` }));
      }
    };

    // Sells first; their proceeds fund the buys.
    for (const t of p.trades.filter((x) => x.side === "SELL")) {
      const held = Number(posBy[t.symbol]?.qty || 0);
      const qty = targetBy[t.symbol] == null || t.shares >= held ? held : assets[t.symbol].fractionable ? t.shares : Math.floor(t.shares);
      if (qty > 0) await place(t, { qty });
    }

    const after = await alpaca.account();
    let budget = Number(after.cash) - (a.total * cfg.cashBuffer) / 100;
    for (const t of p.trades.filter((x) => x.side === "BUY")) {
      const amount = Math.min(t.amount, budget);
      if (amount < Math.max(1, cfg.minTrade)) continue;
      if (assets[t.symbol].fractionable) {
        await place(t, { notional: Math.floor(amount * 100) / 100 });
      } else {
        const qty = Math.floor(amount / t.price);
        if (qty > 0) await place(t, { qty });
      }
      budget -= amount;
    }

    const failed = results.filter((r) => r.type === "error" || r.status !== "filled").length;
    return journal({ type: "run", date, reason, traded: true, orders: results.length, failed, message: failed ? `${failed} order(s) did not fill cleanly; see journal` : "Rebalanced" });
  } catch (err) {
    return journal({ type: "error", date, reason, message: err.message });
  } finally {
    try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
  }
}

// ---------- status + report ----------
export async function status() {
  const cfg = loadConfig();
  const out = {
    configured: alpacaConfigured(), config: cfg, configErrors: validateConfig(cfg),
    stopped: fs.existsSync(stopPath), journal: readJournal(40).reverse(),
  };
  if (!out.configured) return out;
  try {
    const [account, positions, clock] = await Promise.all([alpaca.account(), alpaca.positions(), alpaca.clock()]);
    out.account = { equity: Number(account.equity), cash: Number(account.cash), status: account.status };
    out.positions = positions.map((p) => ({ symbol: p.symbol, qty: Number(p.qty), value: Number(p.market_value), price: Number(p.current_price), pnl: Number(p.unrealized_pl) }));
    out.clock = clock;
  } catch (err) {
    out.accountError = err.message;
  }
  return out;
}

function seriesStats(values) {
  let peak = -Infinity, maxDD = 0;
  const rets = [];
  values.forEach((v, i) => {
    peak = Math.max(peak, v);
    maxDD = Math.min(maxDD, v / peak - 1);
    if (i) rets.push(v / values[i - 1] - 1);
  });
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const vol = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length || 1)) * Math.sqrt(252);
  return { start: values[0], end: values.at(-1), returnPct: (values.at(-1) / values[0] - 1) * 100, maxDrawdownPct: maxDD * 100, volatilityPct: vol * 100 };
}

export async function report() {
  const cfg = loadConfig();
  if (!cfg.startedAt) throw Object.assign(new Error("The test hasn't started yet: no rebalance check has run."), { status: 400 });
  const hist = await alpaca.portfolioHistory("5A");
  const days = [], equity = [];
  hist.timestamp.forEach((t, k) => {
    const d = new Date(t * 1000).toISOString().slice(0, 10);
    if (d >= cfg.startedAt && hist.equity[k] != null) { days.push(d); equity.push(hist.equity[k]); }
  });
  if (days.length < 2) throw Object.assign(new Error("Not enough history yet; check back after a few trading days."), { status: 400 });

  // Benchmarks start from the same equity on the same day.
  const closesOn = async (symbol) => {
    const h = await getHistory(symbol, 6);
    const byDay = new Map(h.bars.map((b) => [new Date(b.time).toISOString().slice(0, 10), b.close]));
    let last = null;
    return days.map((d) => (last = byDay.get(d) ?? last));
  };
  const start = equity[0];
  const investable = start * (1 - cfg.cashBuffer / 100);
  const holdValues = days.map(() => start - investable);
  for (const t of cfg.targets) {
    const closes = await closesOn(t.symbol);
    const shares = (investable * t.target) / 100 / closes[0];
    closes.forEach((c, i) => (holdValues[i] += shares * c));
  }
  const bench = await closesOn(cfg.benchmark);
  const benchValues = bench.map((c) => (start * c) / bench[0]);

  const entries = readJournal().filter((e) => e.date >= cfg.startedAt);
  const orders = entries.filter((e) => e.type === "order");
  const filled = orders.filter((o) => o.status === "filled" && o.slippageBps != null);
  const checkedDays = new Set(entries.filter((e) => e.type === "check" || e.type === "run").map((e) => e.date));
  return {
    period: { from: days[0], to: days.at(-1), tradingDays: days.length },
    autopilot: seriesStats(equity),
    buyAndHoldTargets: seriesStats(holdValues),
    benchmark: { symbol: cfg.benchmark, ...seriesStats(benchValues) },
    activity: {
      rebalances: entries.filter((e) => e.type === "run" && e.traded).length,
      orders: orders.length,
      ordersNotFilled: orders.filter((o) => o.status !== "filled").length,
      avgSlippageBps: filled.length ? +(filled.reduce((a, o) => a + o.slippageBps, 0) / filled.length).toFixed(2) : null,
      worstSlippageBps: filled.length ? Math.max(...filled.map((o) => o.slippageBps)) : null,
      errors: entries.filter((e) => e.type === "error").length,
      missedDays: days.filter((d) => !checkedDays.has(d)).length,
    },
    series: { days, autopilot: equity, buyAndHoldTargets: holdValues, benchmark: benchValues },
  };
}

export function reportMarkdown(r) {
  const pct = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  const row = (name, s) => `| ${name} | $${s.start.toFixed(2)} | $${s.end.toFixed(2)} | ${pct(s.returnPct)} | ${s.maxDrawdownPct.toFixed(2)}% | ${s.volatilityPct.toFixed(1)}% |`;
  const a = r.activity;
  return `# Paper rebalancing test: ${r.period.from} to ${r.period.to}

${r.period.tradingDays} trading days.

| Portfolio | Start | End | Return | Max drawdown | Volatility (ann.) |
|---|---|---|---|---|---|
${row("Autopilot (rebalanced)", r.autopilot)}
${row("Same targets, never rebalanced", r.buyAndHoldTargets)}
${row(`${r.benchmark.symbol} only`, r.benchmark)}

## Did the tool behave?

- Rebalances: ${a.rebalances}, orders: ${a.orders}, orders not filled: ${a.ordersNotFilled}
- Average slippage vs. the price it planned with: ${a.avgSlippageBps ?? "n/a"} bps (worst ${a.worstSlippageBps ?? "n/a"} bps)
- Errors logged: ${a.errors}
- Trading days with no check (computer off, app not running, or skipped): ${a.missedDays}

Paper fills are simulated and tend to be kinder than real ones, and a few months is far too short to judge returns. Weigh the "did it behave" section more heavily than the return numbers.
`;
}
