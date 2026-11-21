import "./env.js";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aiEnabled, aiKeyError, generateStrategy, readPortfolio } from "./ai.js";
import { getHistory, getQuotes, stockProvider, alpacaKeyError } from "./marketdata.js";
import { alpacaConfigured } from "./alpaca.js";
import { runOnce, status as autopilotStatus, saveConfig, report, reportMarkdown } from "./autopilot.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "public");
const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || "127.0.0.1";
async function readJson(req, limit = 1e6) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw Object.assign(new Error("Request too large"), { status: 413 });
  }
  return JSON.parse(body || "{}");
}

const send = (res, status, data, type = "application/json") => {
  res.writeHead(status, { "Content-Type": type });
  res.end(type === "application/json" ? JSON.stringify(data) : data);
};

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json",
  ".png": "image/png", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    // State-changing requests must come from this app's own page: same origin and a JSON body,
    // so other websites open in the browser can't trigger them.
    if (req.method === "POST") {
      const origin = req.headers.origin;
      if ((origin && origin !== `http://${req.headers.host}`) || !String(req.headers["content-type"]).startsWith("application/json")) {
        return send(res, 403, { error: "Forbidden" });
      }
    }
    if (url.pathname === "/api/autopilot/status") return send(res, 200, await autopilotStatus());
    if (url.pathname === "/api/autopilot/config" && req.method === "POST") return send(res, 200, saveConfig(await readJson(req)));
    if (url.pathname === "/api/autopilot/run" && req.method === "POST") return send(res, 200, await runOnce({ force: true, reason: "manual" }));
    if (url.pathname === "/api/autopilot/report") {
      const r = await report();
      return send(res, 200, { ...r, markdown: reportMarkdown(r) });
    }
    if (url.pathname === "/api/status") return send(res, 200, { ai: aiEnabled && !aiKeyError, aiKeyError, stockProvider: stockProvider(), alpacaKeyError, portfolioReader: true });
    // Reads positions out of a screenshot or loose text with Claude. Nothing is stored.
    if (url.pathname === "/api/portfolio/read" && req.method === "POST") {
      const { text, image } = await readJson(req, 9e6);
      if (typeof text !== "string" && typeof image !== "string") return send(res, 400, { error: "text or image is required" });
      return send(res, 200, await readPortfolio({ text: typeof text === "string" ? text : "", image: typeof image === "string" ? image : null }));
    }
    if (url.pathname === "/api/history") {
      const raw = url.searchParams.get("years");
      const years = raw === "max" ? "max" : Math.min(50, Math.max(1, Number(raw) || 3));
      return send(res, 200, await getHistory(url.searchParams.get("symbol"), years));
    }
    if (url.pathname === "/api/quotes") {
      const symbols = (url.searchParams.get("symbols") || "").split(",").filter(Boolean);
      return send(res, 200, await getQuotes(symbols));
    }
    if (url.pathname === "/api/generate" && req.method === "POST") {
      const { prompt, currentRules, currentCode } = await readJson(req);
      if (!prompt || typeof prompt !== "string") return send(res, 400, { error: "prompt is required" });
      return send(res, 200, await generateStrategy(prompt, currentRules ?? currentCode));
    }

    const file = path.normalize(path.join(publicDir, url.pathname === "/" ? "index.html" : url.pathname));
    if (!file.startsWith(publicDir)) return send(res, 403, "Forbidden", "text/plain");
    const data = await readFile(file);
    send(res, 200, data, MIME[path.extname(file)] || "application/octet-stream");
  } catch (e) {
    if (e.code === "ENOENT") return send(res, 404, "Not found", "text/plain");
    send(res, e.status || 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Ballast running at http://${HOST}:${PORT}`);
  console.log(`Market data: ${stockProvider()} for stocks, Coinbase for crypto pairs (e.g. BTC-USD)`);
  if (alpacaConfigured()) {
    console.log("Alpaca paper autopilot: checks every 5 minutes whether today's rebalance check is due (only acts when enabled).");
    const tick = () => runOnce().then((r) => r.skipped || console.log(`[autopilot] ${r.type}: ${r.message ?? ""}`), (e) => console.error("[autopilot]", e.message));
    tick();
    setInterval(tick, 5 * 60e3);
  }
  console.log(aiEnabled ? "AI strategy builder: on (Claude)" : "AI strategy builder: off. Set ANTHROPIC_API_KEY to enable it; using the built-in builder.");
});
