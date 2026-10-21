// Portfolio rebalancing math. Pure functions: holdings + live prices + targets in,
// a list of suggested trades out. Nothing here places orders.

// holdings: [{ symbol, shares, target }] where target is a percent (0–100).
// prices: { SYMBOL: price }. Positions without a price are left out of the math.
export function analyze(holdings, prices, cash) {
  const rows = holdings
    .filter((h) => Number.isFinite(prices[h.symbol]))
    .map((h) => ({ ...h, price: prices[h.symbol], value: h.shares * prices[h.symbol] }));
  const invested = rows.reduce((a, r) => a + r.value, 0);
  const total = invested + cash;
  for (const r of rows) {
    r.weight = total > 0 ? (r.value / total) * 100 : 0;
    r.drift = r.weight - r.target;
  }
  const targetSum = holdings.reduce((a, h) => a + (Number(h.target) || 0), 0);
  return { rows, total, invested, cash, cashWeight: total > 0 ? (cash / total) * 100 : 0, targetSum };
}

// Bands: a holding needs attention when its weight is more than `band` percentage
// points away from target, or when it has a target of 0 (it shouldn't be held).
// Returns the suggested trades to bring every holding back to target, keeping
// `cashBuffer` percent in cash. Sells run first so their proceeds fund the buys.
export function plan(analysis, { band = 5, minTrade = 25, fractional = true, cashBuffer = 0, force = false } = {}) {
  const { rows, total } = analysis;
  // Holdings with no target (target 0) always count as out of band, so they get sold.
  const outOfBand = rows.filter((r) => Math.abs(r.drift) > band || (r.target === 0 && r.value >= minTrade));
  if (!force && !outOfBand.length) return { needed: false, outOfBand, trades: [], cashAfter: analysis.cash };

  const investable = total * (1 - cashBuffer / 100);
  const qty = (dollars, price) => (fractional ? Math.floor((dollars / price) * 1e4) / 1e4 : Math.floor(dollars / price));
  const trades = [];
  let cash = analysis.cash;

  for (const r of rows) {
    const excess = r.value - (investable * r.target) / 100;
    if (excess < minTrade) continue;
    const shares = Math.min(r.shares, r.target === 0 ? r.shares : qty(excess, r.price));
    if (shares <= 0) continue;
    trades.push({ side: "SELL", symbol: r.symbol, shares, price: r.price, amount: shares * r.price });
    cash += shares * r.price;
  }

  const spendable = Math.max(0, cash - (total * cashBuffer) / 100);
  let budget = spendable;
  const buys = rows
    .map((r) => ({ r, gap: (investable * r.target) / 100 - r.value }))
    .filter((b) => b.gap >= minTrade)
    .sort((a, b) => b.gap - a.gap);
  for (const { r, gap } of buys) {
    const shares = qty(Math.min(gap, budget), r.price);
    if (shares <= 0 || shares * r.price < minTrade) continue;
    trades.push({ side: "BUY", symbol: r.symbol, shares, price: r.price, amount: shares * r.price });
    budget -= shares * r.price;
  }

  return { needed: true, outOfBand, trades, cashAfter: cash - (spendable - budget) };
}
