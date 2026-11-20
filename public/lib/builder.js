// The built-in strategy builder: plain English in, canonical rules out, no AI needed.
// Used by the server when no Anthropic key is set and by the page when it has no server.
import { parseStrategy, symsIn } from "./parse.js";
import { describe, summarize, nameFor } from "./spec.js";

// Rule lines a follow-up instruction replaces rather than adds to.
const REPLACES = [
  [/\b(?:buy|enter|go long)\b[^.]*\b(?:when|if|on|after)\b/i, /^buy when/i],
  [/\b(?:sell|exit|get out)\b[^.]*\b(?:when|if|on)\b/i, /^sell when/i],
  [/\btrailing\b/i, /^trailing stop/i],
  [/(?<!trailing\s)\bstop\b(?!\s+trailing)/i, /^stop loss/i],
  [/\b(?:take[- ]?profit|target)\b/i, /^take profit/i],
  [/\b(?:after|for)\s+\d+\s*(?:trading\s+)?(?:days?|weeks?|months?|bars?)\b/i, /^sell after/i],
  [/\bposition size\b|%\s+per\s+(?:position|trade)/i, /^position size/i],
  [/\brebalanc|\b(?:monthly|quarterly|weekly|yearly|annually)\b/i, /^rebalance/i],
  [/^(?:use|switch to|try|trade|run it on|test it on|test on|on)\s+\S+(?:\s+instead)?\s*$/i, /^trade /i],
];

const REMOVE = /\b(?:remove|drop|delete|no|without|get rid of)\s+(?:the\s+)?(stop loss|stop|take profit|target|trailing stop|time limit|sell rule|position size)/i;

function merge(prompt, current) {
  let lines = current.split("\n").map((l) => l.trim()).filter(Boolean);
  const rm = prompt.match(REMOVE);
  if (rm) {
    const what = rm[1].toLowerCase();
    const re = what.startsWith("trailing") ? /^trailing stop/i : what.startsWith("stop") ? /^stop loss/i
      : /take profit|target/.test(what) ? /^take profit/i : what === "time limit" ? /^sell after/i
      : what === "sell rule" ? /^sell when/i : /^position size/i;
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
