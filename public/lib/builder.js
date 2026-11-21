// The built-in strategy builder: plain English in, canonical rules out, no AI needed.
// Used by the server when no Anthropic key is set and by the page when it has no server.
import { parseStrategy, symsIn } from "./parse.js";
import { describe, summarize, nameFor } from "./spec.js";

// Rule lines a follow-up instruction replaces rather than adds to.
const REPLACES = [
  [/\bcover\b[^.]*\b(?:when|if|on)\b/i, /^cover when/i],
  [/\b(?:short|bet against)\b[^.]*\b(?:when|if|on)\b/i, /^short when/i],
  [/\b(?:buy|enter|go long)\b(?!\s+to\s+cover)[^.]*\b(?:when|if|on|after)\b/i, /^buy when/i],
  [/\b(?:sell|exit|get out)\b(?!\s+short)[^.]*\b(?:when|if|on)\b/i, /^sell when/i],
  [/\bvol(?:atility)?\b[^.]*\d\s*%|\d\s*%[^.]*\bvol(?:atility)?\b/i, /^target \d[\d.]*% volatility/i],
  [/\binverse[- ]vol|risk[- ]parity|risk[- ]weight/i, /^weight by/i],
  [/\btrailing\b/i, /^trailing stop/i],
  [/(?<!trailing\s)\bstop\b(?!\s+trailing)/i, /^stop loss/i],
  // "target" alone means take profit, but not in "volatility target" or "target 10% volatility"
  [/\btake[- ]?profit\b|(?<!vol(?:atility)?\s)\btarget\b(?![^.]*\bvol)/i, /^take profit/i],
  [/\b(?:after|for)\s+\d+\s*(?:trading\s+)?(?:days?|weeks?|months?|bars?)\b/i, /^sell after/i],
  [/\bposition size\b|%\s+per\s+(?:position|trade)/i, /^position size/i],
  [/\brebalanc|\b(?:monthly|quarterly|weekly|yearly|annually)\b/i, /^rebalance/i],
  [/^(?:use|switch to|try|trade|run it on|test it on|test on|on)\s+\S+(?:\s+instead)?\s*$/i, /^trade /i],
];

const REMOVE = /\b(?:remove|drop|delete|no|without|get rid of)\s+(?:the\s+)?(volatility target|vol target|stop loss|stop|take profit|target|trailing stop|time limit|sell rule|position size|short rule|cover rule)/i;

function merge(prompt, current) {
  let lines = current.split("\n").map((l) => l.trim()).filter(Boolean);
  const rm = prompt.match(REMOVE);
  if (rm) {
    const what = rm[1].toLowerCase();
    const re = /vol/.test(what) ? /^target \d[\d.]*% volatility/i : what.startsWith("trailing") ? /^trailing stop/i : what.startsWith("stop") ? /^stop loss/i
      : /take profit|target/.test(what) ? /^take profit/i : what === "time limit" ? /^sell after/i
      : what === "sell rule" ? /^sell when/i : what === "short rule" ? /^(?:short|cover) when/i : what === "cover rule" ? /^cover when/i
      : /vol/.test(what) ? /^target \d[\d.]*% volatility/i : /^position size/i;
    lines = lines.filter((l) => !re.test(l));
    prompt = prompt.replace(rm[0], " ");
  }
  for (const [ask, line] of REPLACES) if (ask.test(prompt)) lines = lines.filter((l) => !line.test(l));
  // "use QQQ instead" / "switch to toyota"
  const swap = prompt.match(/^(?:use|switch to|try|trade|run it on|test it on|test on|on)\s+(.+?)(?:\s+instead)?\s*$/i);
  if (swap && symsIn(swap[1]).length) prompt = `Trade ${symsIn(swap[1]).join(", ")}`;
  return [prompt, ...lines].join("\n");
}

export function localStrategy(prompt, current) {
  const attempt = (text) => {
    const { spec, notes, unparsed } = parseStrategy(text);
    return {
      name: nameFor(spec), explanation: summarize(spec), rules: describe(spec), source: "parser",
      notes: [...notes, ...unparsed.map((u) => `Ignored "${u}": the rule language doesn't cover that yet.`)],
    };
  };
  try {
    if (current?.trim()) {
      // A complete new strategy replaces the current one; anything else edits it.
      try {
        const fresh = parseStrategy(prompt);
        if (!fresh.unparsed.length && (/\b(?:buy|hold|rotate|top)\b/i.test(prompt))) return attempt(prompt);
      } catch { /* not a full strategy: treat it as an edit */ }
      return attempt(merge(prompt, current));
    }
    return attempt(prompt);
  } catch (e) {
    return { name: null, rules: null, source: "parser", explanation: e.message, notes: [] };
  }
}
