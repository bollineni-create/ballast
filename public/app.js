// Ballast: entry point. Wires the views together and finds out what it is running on.
import { $, $$, state, go, on, emit, fetchJson } from "./core.js";
import { initStudio, startStudio } from "./views/studio.js";
import { initCompare } from "./views/compare.js";
import { initPortfolio } from "./views/portfolio.js";
import { initLive } from "./views/live.js";
import { initLibrary } from "./views/library.js";
import { initCheckup } from "./views/checkup.js";
import { startSync } from "./sync.js";

$("#nav").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (b) go(b.dataset.view);
});

function renderStatus(status = {}) {
  const pill = $("#ai-status");
  pill.hidden = false;
  pill.textContent = state.ai ? "Claude + rule reader" : status.aiKeyError ? "Claude key rejected" : "Built-in rule reader";
  pill.classList.toggle("on", state.ai);
  pill.classList.toggle("bad", Boolean(status.aiKeyError) && !state.ai);
  pill.title = state.ai ? "Claude turns your words into rules; Ballast's rule reader checks every rule before it runs."
    : status.aiKeyError || (!state.server ? "Ballast's built-in reader turns your words into rules. Claude can read looser descriptions when Ballast runs with an Anthropic key."
      : state.autopilot ? "Add an Anthropic API key in Ballast → Edit Keys… to have Claude read looser descriptions."
      : "This site has no Claude key set, so Ballast's built-in reader turns your words into rules.");
}

(async function init() {
  let status;
  try {
    status = await fetchJson("api/status");
    state.ai = status.ai;
    state.server = true;
    // The website has a server for prices and the builder, but the autopilot and its
    // Alpaca keys only ever run in the Mac app.
    state.autopilot = status.autopilot !== false;
    // Reading a screenshot needs a server that has the reader and a Claude key.
    state.reader = Boolean(status.portfolioReader && status.ai);
  } catch { /* no server: opened from disk */ }
  document.documentElement.classList.toggle("website", !state.server);
  renderStatus(status);
  on("status", renderStatus);
  if (!state.autopilot) $("#ai-status").insertAdjacentHTML("afterend", `<a class="chip" href="https://github.com/bollineni-create/ballast#install-it-on-a-mac" target="_blank" rel="noopener">Mac app</a>`);

  initStudio();
  initLive();
  initPortfolio();
  initCheckup();
  initCompare();
  initLibrary();
  startSync();
  startStudio();
})();

// A deep link like #library opens that section.
const fromHash = () => { const v = location.hash.slice(1); if ($$("#nav button").some((b) => b.dataset.view === v)) go(v); };
fromHash();
addEventListener("hashchange", fromHash);

// Appearance: theme and light/dark, applied by theme.js before the page paints.
for (const [id, key] of [["#theme-pick", "theme"], ["#mode-pick", "mode"]]) {
  const el = $(id);
  el.value = window.BallastTheme?.get()[key] ?? el.value;
  el.addEventListener("change", () => {
    window.BallastTheme?.set({ [key]: el.value });
    $$("canvas").forEach((c) => c._draw?.()); // charts read their colors when they draw
  });
}
