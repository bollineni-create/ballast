// Minimal Alpaca Trading API client, locked to PAPER trading.
//
// Paper keys only work against paper-api.alpaca.markets, and this client refuses
// any other trading host (except localhost, for tests), so it cannot place
// real-money orders even if live keys are supplied by mistake.

const PAPER_URL = "https://paper-api.alpaca.markets";

function tradingUrl() {
  const url = process.env.ALPACA_TRADING_URL || PAPER_URL;
  const host = new URL(url).hostname;
  if (host !== "paper-api.alpaca.markets" && host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to trade against ${host}: Ballast only supports Alpaca paper trading.`);
  }
  return url.replace(/\/$/, "");
}

export function alpacaConfigured() {
  return Boolean(process.env.ALPACA_API_KEY_ID && process.env.ALPACA_API_SECRET_KEY);
}

async function call(method, path, body) {
  if (!alpacaConfigured()) throw new Error("Set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY (paper keys) to use the autopilot.");
  const res = await fetch(`${tradingUrl()}${path}`, {
    method,
    headers: {
      "APCA-API-KEY-ID": process.env.ALPACA_API_KEY_ID,
      "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET_KEY,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`Alpaca ${method} ${path} failed (HTTP ${res.status}): ${json?.message || text}`);
  return json;
}

export const alpaca = {
  account: () => call("GET", "/v2/account"),
  clock: () => call("GET", "/v2/clock"),
  positions: () => call("GET", "/v2/positions"),
  asset: (symbol) => call("GET", `/v2/assets/${encodeURIComponent(symbol)}`),
  openOrders: () => call("GET", "/v2/orders?status=open&limit=100"),
  order: (id) => call("GET", `/v2/orders/${id}`),
  // Exactly one of qty / notional. Fractional and notional orders must be market/day.
  submitOrder: ({ symbol, side, qty, notional, clientOrderId }) =>
    call("POST", "/v2/orders", {
      symbol, side, type: "market", time_in_force: "day",
      ...(notional != null ? { notional: notional.toFixed(2) } : { qty: String(qty) }),
      client_order_id: clientOrderId,
    }),
  portfolioHistory: (period = "1A") => call("GET", `/v2/account/portfolio/history?period=${period}&timeframe=1D`),
};
