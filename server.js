import "./env.js";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { templateStrategy } from "./public/lib/templates.js";
import { getHistory, getQuotes, stockProvider } from "./marketdata.js";
import { alpacaConfigured } from "./alpaca.js";
import { runOnce, status as autopilotStatus, saveConfig, report, reportMarkdown } from "./autopilot.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "public");
const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || "127.0.0.1";
const aiEnabled = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const client = aiEnabled ? new Anthropic() : null;

const SYSTEM = `You turn plain-English trading ideas into strategy code for a long-only daily-bar backtester.

Write the BODY of a JavaScript function with parameters (data, ta). It must return:
  { entry: (i) => boolean, exit: (i) => boolean, stopLoss?: number, takeProfit?: number }
- data: aligned arrays data.time, data.open, data.high, data.low, data.close, data.volume.
- entry(i)/exit(i) are evaluated at the close of bar i; orders fill at the next bar's open.
- stopLoss / takeProfit are optional fractions of the entry price (0.05 = 5%).
- Never read data at an index greater than i (no lookahead).
- Precompute indicators once at the top, outside entry/exit.
- Indicator helpers (all return arrays aligned with input, NaN during warm-up):
  ta.sma(src,n) ta.ema(src,n) ta.rsi(src,n) ta.stdev(src,n) ta.roc(src,n)
  ta.bollinger(src,n,k) -> {upper,mid,lower}
  ta.macd(src,fast,slow,signal) -> {macd,signal,hist}
  ta.atr(high,low,close,n) ta.highest(src,n) ta.lowest(src,n)
  ta.crossover(a,b,i) ta.crossunder(a,b,i)  (b may be a number)
- Plain JavaScript only: no imports, no network, no DOM, no async.
If the idea needs something unsupported (shorting, intraday, multiple assets), build the closest long-only version and say what you changed.

Reply with exactly:
NAME: <short strategy name>
EXPLANATION: <2-3 sentences in plain English describing the rules>
\`\`\`js
<code>
\`\`\``;

async function generateWithClaude(prompt, currentCode) {
  const content = currentCode
    ? `Current strategy code:\n\`\`\`js\n${currentCode}\n\`\`\`\n\nRequested change: ${prompt}`
    : prompt;
  const response = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    output_config: { effort: "medium" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    messages: [{ role: "user", content }],
  });
  if (response.stop_reason === "refusal") throw new Error("The model declined this request.");
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const code = text.match(/```(?:js|javascript)?\s*\n([\s\S]*?)```/)?.[1]?.trim();
  if (!code) throw new Error("The model did not return any code.");
  return {
    name: text.match(/NAME:\s*(.+)/)?.[1]?.trim() || "AI strategy",
    explanation: text.match(/EXPLANATION:\s*([\s\S]+?)(?:```|$)/)?.[1]?.trim() || "",
    code,
    source: "ai",
  };
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1e6) throw new Error("Request too large");
  }
  return JSON.parse(body || "{}");
}

const send = (res, status, data, type = "application/json") => {
  res.writeHead(status, { "Content-Type": type });
  res.end(type === "application/json" ? JSON.stringify(data) : data);
};

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };

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
    if (url.pathname === "/api/status") return send(res, 200, { ai: aiEnabled, stockProvider });
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
      const { prompt, currentCode } = await readJson(req);
      if (!prompt || typeof prompt !== "string") return send(res, 400, { error: "prompt is required" });
      if (aiEnabled) {
        try {
          return send(res, 200, await generateWithClaude(prompt, currentCode));
        } catch (e) {
          const fallback = templateStrategy(prompt);
          return send(res, 200, { ...fallback, source: "template", warning: `AI unavailable (${e.message}); used the built-in builder.` });
        }
      }
      return send(res, 200, { ...templateStrategy(prompt), source: "template" });
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
  console.log(`Market data: ${stockProvider} for stocks, Coinbase for crypto pairs (e.g. BTC-USD)`);
  if (alpacaConfigured()) {
    console.log("Alpaca paper autopilot: checks every 5 minutes whether today's rebalance check is due (only acts when enabled).");
    const tick = () => runOnce().then((r) => r.skipped || console.log(`[autopilot] ${r.type}: ${r.message ?? ""}`), (e) => console.error("[autopilot]", e.message));
    tick();
    setInterval(tick, 5 * 60e3);
  }
  console.log(aiEnabled ? "AI strategy builder: on (Claude)" : "AI strategy builder: off. Set ANTHROPIC_API_KEY to enable it; using the built-in builder.");
});
