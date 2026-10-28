// Strategy builder: turns a plain-English idea into strategy code with Claude, or with
// the built-in template builder when no key is set or Claude is unavailable. Shared by
// the local server and the hosted website's serverless route.
import Anthropic from "@anthropic-ai/sdk";
import { templateStrategy } from "./public/lib/templates.js";

export const aiEnabled = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
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

export async function generateStrategy(prompt, currentCode) {
  if (!aiEnabled) return { ...templateStrategy(prompt), source: "template" };
  try {
    return await generateWithClaude(prompt, currentCode);
  } catch (e) {
    return { ...templateStrategy(prompt), source: "template", warning: `AI unavailable (${e.message}); used the built-in builder.` };
  }
}
