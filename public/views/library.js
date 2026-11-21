// Library: starter strategies and the ones the user saved.
import { $, esc, store, state, on, emit, go, LIBRARY } from "../core.js";
import { openStrategy } from "./studio.js";

let tagFilter = "All";

const card = (s, actions) => `<article class="card strat">${s.tag ? `<span class="tag">${esc(s.tag)}</span>` : ""}<h4>${esc(s.name)}</h4>
  ${s.prompt ? `<p>“${esc(s.prompt)}”</p>` : ""}
  ${s.rules ? (s.prompt ? `<details><summary>See the rules</summary><pre>${esc(s.rules)}</pre></details>` : `<pre>${esc(s.rules)}</pre>`) : `<p>Saved as code by an early version of Ballast. Open it to describe it again in plain English.</p>`}
  <div class="row">${actions}</div></article>`;

function render() {
  const tags = ["All", ...new Set(LIBRARY.map((s) => s.tag))];
  $("#library-tags").innerHTML = tags.map((t) => `<button type="button" class="chip ${t === tagFilter ? "active" : ""}" data-tag="${esc(t)}">${esc(t)}</button>`).join("");
  $("#library").innerHTML = LIBRARY.filter((s) => tagFilter === "All" || s.tag === tagFilter)
    .map((s) => card(s, `<button type="button" class="btn small" data-compare="${s.id}">Add to compare</button><button type="button" class="btn small primary" data-lib="${s.id}">Open &amp; test</button>`)).join("");
  $("#saved").innerHTML = state.saved.length
    ? [...state.saved].reverse().map((s) => card(s, `<button type="button" class="link" data-del="${esc(s.id)}">Delete</button>${s.rules ? `<button type="button" class="btn small" data-compare="${esc(s.id)}">Add to compare</button>` : ""}<button type="button" class="btn small primary" data-open="${esc(s.id)}">Open</button>`)).join("")
    : `<p class="empty-state">Nothing saved yet. Build a strategy in the Studio and choose Save.</p>`;
}

export function initLibrary() {
  $("#view-library").addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    const d = t.dataset;
    if (d.tag) { tagFilter = d.tag; render(); }
    if (d.lib) openStrategy(LIBRARY.find((s) => s.id === d.lib));
    if (d.open) openStrategy(state.saved.find((s) => s.id === d.open));
    if (d.compare) { emit("compare-add", d.compare); go("compare"); }
    if (d.del) {
      const s = state.saved.find((x) => x.id === d.del);
      if (!s || !confirm(`Delete "${s.name}"?`)) return;
      state.saved = state.saved.filter((x) => x.id !== d.del);
      store.set("saved", state.saved);
      emit("saved");
    }
  });
  on("saved", render);
  on("data", render);
  render();
}
