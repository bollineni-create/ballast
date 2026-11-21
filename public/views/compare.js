// Compare: a lineup of up to six strategies (your own, saved or starters) over the same years.
import { $, $$, esc, day, pct, num, tone, store, state, settings, on, emit, showing, loadBars, toast, LIBRARY } from "../core.js";
import { parseStrategy } from "../lib/parse.js";
import { summarize } from "../lib/spec.js";
import { localStrategy } from "../lib/builder.js";
import { backtestSpec } from "../lib/engine.js";
import { holdout, monteCarlo, score } from "../lib/lab.js";
import { lineChart } from "../lib/charts.js";
import { currentStrategy, openStrategy, generate } from "./studio.js";

const SERIES = ["--c1", "--c2", "--c3", "--c4", "--c5", "--c6"];
const MAX = 6;
let picked = store.get("compare", ["current", "lib-8"]);
let custom = store.get("compare-custom", []); // strategies written here: { id, name, prompt, rules, named }
let out = null, ranWith = "";
let editing = null, addTab = "write", checkTimer;

// ---------- what can be in the lineup ----------
function candidates() {
  const cur = currentStrategy();
  return [
    ...(cur.rules?.trim() ? [{ id: "current", name: cur.name, rules: cur.rules, where: "Open in the Studio" }] : []),
    ...custom.map((s) => ({ ...s, where: "Written here", own: true })),
    ...state.saved.filter((s) => s.rules).map((s) => ({ id: s.id, name: s.name, rules: s.rules, where: "Saved" })),
    ...LIBRARY.map((s) => ({ id: s.id, name: s.name, rules: s.rules, prompt: s.prompt, where: s.tag })),
  ];
}
const lineup = () => { const all = candidates(); return picked.map((id) => all.find((c) => c.id === id)).filter(Boolean); };
const full = () => picked.length >= MAX;
const fingerprint = () => JSON.stringify(lineup().map((c) => [c.id, c.rules]));
const summaryOf = (rules) => { try { return summarize(parseStrategy(rules).spec); } catch { return ""; } };

function save() {
  store.set("compare", picked);
  store.set("compare-custom", custom);
  renderAll();
}

function add(id) {
  if (picked.includes(id)) return true;
  if (full()) { toast(`Your lineup is full (${MAX}). Remove one to add another.`); return false; }
  picked = [...picked, id];
  save();
  return true;
}

function remove(id) {
  picked = picked.filter((x) => x !== id);
  // Strategies written here only live in the lineup; Save keeps one for good.
  custom = custom.filter((c) => c.id !== id || picked.includes(c.id));
  if (editing === id) stopEditing();
  save();
}

// ---------- rendering ----------
function renderLineup() {
  const items = lineup();
  picked = items.map((c) => c.id);
  $("#compare-count").textContent = `${items.length} of ${MAX}`;
  const slots = items.map((c, k) => `<li class="${editing === c.id ? "editing" : ""}"><i style="background:var(${SERIES[k]})"></i>
      <div><b title="${esc(c.name)}">${esc(c.name)}</b><span class="sub" title="${esc(summaryOf(c.rules))}">${esc(c.where)} · ${esc(summaryOf(c.rules) || c.rules)}</span></div>
      <div class="acts">${c.own ? `<button type="button" class="link" data-edit="${esc(c.id)}">Edit</button>` : ""}<button type="button" class="link x" data-remove="${esc(c.id)}" aria-label="Remove ${esc(c.name)}" title="Remove">×</button></div></li>`);
  const empty = MAX - items.length;
  if (empty) slots.push(`<li class="empty">${items.length ? `${empty} more ${empty === 1 ? "slot" : "slots"} open` : "Nothing here yet. Add strategies on the right, or write your own."}</li>`);
  $("#compare-lineup").innerHTML = slots.join("");

  const btn = $("#compare-run");
  if (!btn.dataset.busy) {
    btn.disabled = items.length < 2;
    btn.textContent = items.length < 2 ? "Compare" : `Compare ${items.length} strategies`;
  }
  $("#compare-hint").textContent = items.length < 2
    ? `Add ${2 - items.length === 2 ? "two strategies" : "one more strategy"} to compare.`
    : `Same test settings as the Studio: ${settings.years === "max" ? "all available history" : `the last ${settings.years} years`}, ${settings.cost} bps per trade${settings.currency ? `, in ${settings.currency}` : ""}.`;
}

function addRow(c) {
  const inIt = picked.includes(c.id);
  return `<div class="add-row"><div><b>${esc(c.name)}</b><span>${esc(c.prompt ? `“${c.prompt}”` : summaryOf(c.rules))}</span></div>
    <button type="button" class="btn small ${inIt ? "on" : ""}" data-toggle="${esc(c.id)}" ${!inIt && full() ? "disabled title=\"Your lineup is full\"" : ""}>${inIt ? "Added ✓" : "Add"}</button></div>`;
}

function renderLists() {
  const groups = {};
  for (const s of LIBRARY) (groups[s.tag] ??= []).push(s);
  $("#add-library").innerHTML = Object.entries(groups).map(([tag, list]) => `<h5>${esc(tag)}</h5>${list.map(addRow).join("")}`).join("");
  const saved = state.saved.filter((s) => s.rules);
  const cur = candidates().find((c) => c.id === "current");
  $("#add-saved").innerHTML = (cur ? `<h5>Open in the Studio</h5>${addRow(cur)}` : "")
    + (saved.length ? `<h5>Saved</h5>${[...saved].reverse().map((s) => addRow({ ...s, where: "Saved" })).join("")}`
      : `<p class="empty-state">Nothing saved yet. Strategies you save in the Studio, or from a comparison, show up here.</p>`);
}

function renderAll() {
  if (!showing("compare")) return;
  renderLineup();
  renderLists();
  $("#compare-stale").hidden = !out || fingerprint() === ranWith;
}

// ---------- writing your own ----------
function checkCustom() {
  const box = $("#custom-check"), text = $("#custom-rules").value.trim();
  if (!text) { box.hidden = true; return; }
  const r = localStrategy(text);
  box.hidden = false;
  if (!r.rules) {
    box.className = "rules-check warn";
    box.innerHTML = state.ai ? `<strong>The built-in reader can't follow this yet.</strong> Claude will have a go when you add it.` : `<strong>Not understood yet.</strong> ${esc(r.explanation)}`;
    return;
  }
  box.className = `rules-check ${r.notes.length ? "warn" : "ok"}`;
  box.innerHTML = `<strong>Reads as</strong> · ${esc(r.explanation)}${r.notes.map((n) => `<div>${esc(n)}</div>`).join("")}`;
}

function startEditing(id) {
  const c = custom.find((x) => x.id === id);
  if (!c) return;
  editing = id;
  showAddTab("write");
  $("#custom-rules").value = c.prompt || c.rules;
  $("#custom-name").value = c.named ? c.name : "";
  $("#custom-add").textContent = "Update";
  $("#custom-cancel").hidden = false;
  checkCustom();
  renderLineup();
  $("#custom-rules").focus();
}

function stopEditing() {
  editing = null;
  $("#custom-form").reset();
  $("#custom-check").hidden = true;
  $("#custom-add").textContent = "Add to lineup";
  $("#custom-cancel").hidden = true;
}

async function submitCustom(e) {
  e.preventDefault();
  const prompt = $("#custom-rules").value.trim(), name = $("#custom-name").value.trim();
  const box = $("#custom-check");
  if (!prompt) { $("#custom-rules").focus(); return; }
  if (!editing && full()) {
    box.hidden = false; box.className = "rules-check bad";
    box.textContent = `Your lineup is full (${MAX}). Remove one to add this.`;
    return;
  }
  const btn = $("#custom-add"), label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Reading…";
  let r;
  try { r = state.ai ? await generate(prompt, false) : localStrategy(prompt); } finally { btn.disabled = false; btn.textContent = label; }
  if (!r.rules) {
    box.hidden = false; box.className = "rules-check bad";
    box.innerHTML = `<strong>Couldn't turn that into rules.</strong> ${esc(r.explanation || "Try naming what to buy and when, like the examples below.")}`;
    return;
  }
  const entry = { name: name || r.name || "My strategy", named: Boolean(name), prompt, rules: r.rules };
  if (editing) {
    custom = custom.map((c) => (c.id === editing ? { ...c, ...entry } : c));
    toast("Updated");
  } else {
    const id = `custom-${crypto.randomUUID().slice(0, 8)}`;
    custom = [...custom, { id, ...entry }];
    picked = [...picked, id];
    toast(`Added "${entry.name}"`);
  }
  stopEditing();
  save();
}

function showAddTab(tab) {
  addTab = tab;
  $$("#add-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.add === tab));
  $$("[data-add-panel]").forEach((p) => p.classList.toggle("active", p.dataset.addPanel === tab));
}

// ---------- running ----------
async function run() {
  const chosen = lineup();
  const err = $("#compare-error");
  err.hidden = true;
  if (chosen.length < 2) return;
  const btn = $("#compare-run");
  btn.disabled = true;
  btn.dataset.busy = "1";
  btn.textContent = `Testing ${chosen.length} strategies…`;
  try {
    const opt = { ...settings, benchmark: "" };
    const loaded = await Promise.all(chosen.map(async (c) => {
      let spec;
      try { ({ spec } = parseStrategy(c.rules)); } catch (e) { throw new Error(`"${c.name}": ${e.message}`); }
      const data = await loadBars(spec, "SPY", opt);
      const base = { fallbackSymbol: "SPY", capital: Number(settings.capital) || 10000, costBps: Number(settings.cost) || 0, fx: data.fx };
      return { c, spec, data, base, first: backtestSpec(spec, data.bars, base) };
    }));
    // Judge everyone over the years they all have.
    const from = Math.max(...loaded.map((x) => x.first.time[0]));
    out = {
      from,
      rows: loaded.map((x) => {
        const r = x.first.time[0] === from ? x.first : backtestSpec(x.spec, x.data.bars, { ...x.base, from });
        return { c: x.c, r, score: score(r, holdout(r), monteCarlo(r, { runs: 300 })) };
      }),
    };
    ranWith = fingerprint();
    render();
    $("#compare-out").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    err.hidden = false;
    err.textContent = e.message;
  } finally {
    delete btn.dataset.busy;
    renderLineup();
  }
}

function verdict() {
  const rows = [...out.rows].sort((a, b) => b.score.total - a.score.total);
  const [w, second] = rows;
  const calm = [...out.rows].sort((a, b) => b.r.metrics.maxDrawdown - a.r.metrics.maxDrawdown)[0];
  const fast = [...out.rows].sort((a, b) => b.r.metrics.cagr - a.r.metrics.cagr)[0];
  const m = w.r.metrics;
  const bits = [`Score ${w.score.total} (${w.score.word.toLowerCase()}), ${pct(m.cagr)} a year, worst drop ${pct(m.maxDrawdown)}.`];
  if (second) bits.push(`Next: ${esc(second.c.name)} at ${second.score.total}.`);
  if (fast !== w) bits.push(`Highest return: ${esc(fast.c.name)} (${pct(fast.r.metrics.cagr)} a year).`);
  if (calm !== w) bits.push(`Smallest worst drop: ${esc(calm.c.name)} (${pct(calm.r.metrics.maxDrawdown)}).`);
  return `<span class="eyebrow">Most trustworthy result since ${day(out.from)}</span><h2>${esc(w.c.name)}</h2><p>${bits.join(" ")}</p>`;
}

function render() {
  if (!out || !showing("compare")) return;
  $("#compare-out").hidden = false;
  $("#compare-stale").hidden = fingerprint() === ranWith;
  $("#compare-verdict").innerHTML = verdict();
  $("#compare-legend").innerHTML = out.rows.map((x, k) => `<span><i style="background:var(${SERIES[k]})"></i>${esc(x.c.name)}</span>`).join("");
  lineChart($("#compare-chart"), {
    series: out.rows.map((x, k) => {
      const s = x.r.startIndex, base = x.r.equity[s];
      return { time: x.r.time.slice(s), values: x.r.equity.slice(s).map((v) => (v / base) * 100), color: SERIES[k], label: x.c.name.length > 26 ? `${x.c.name.slice(0, 25)}…` : x.c.name, width: 1.7 };
    }),
    format: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)),
  });
  const best = (f, hi = true) => { const v = out.rows.map(f); return hi ? Math.max(...v) : Math.min(...v); };
  const top = { cagr: best((x) => x.r.metrics.cagr), sharpe: best((x) => x.r.metrics.sharpe), dd: best((x) => x.r.metrics.maxDrawdown), score: best((x) => x.score.total) };
  const b = (v, is) => (is ? `<strong>${v}</strong>` : v);
  const savedAlready = (c) => state.saved.some((s) => s.rules === c.rules);
  $("#compare-table").innerHTML = `<thead><tr><th>Strategy</th><th class="num">Score</th><th class="num">Per year</th><th class="num">Total</th><th class="num">Worst drop</th><th class="num">Volatility</th><th class="num" title="Return per unit of risk">Sharpe</th><th class="num">Worst year</th><th class="num">Time invested</th><th></th></tr></thead><tbody>${out.rows.map((x, k) => {
    const m = x.r.metrics;
    return `<tr><td><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:var(${SERIES[k]});margin-right:8px"></i>${esc(x.c.name)}</td>
      <td class="num">${b(`${x.score.total} · ${x.score.word}`, x.score.total === top.score)}</td><td class="num ${tone(m.cagr)}">${b(pct(m.cagr), m.cagr === top.cagr)}</td><td class="num">${pct(m.totalReturn, 0)}</td>
      <td class="num neg">${b(pct(m.maxDrawdown), m.maxDrawdown === top.dd)}</td><td class="num">${pct(m.vol)}</td><td class="num">${b(num(m.sharpe), m.sharpe === top.sharpe)}</td><td class="num ${tone(m.worstYear)}">${pct(m.worstYear)}</td><td class="num">${pct(m.exposure, 0)}</td>
      <td class="num"><div class="row">${x.c.own && !savedAlready(x.c) ? `<button type="button" class="btn small" data-save="${k}">Save</button>` : ""}<button type="button" class="btn small" data-open="${k}">Open</button></div></td></tr>`;
  }).join("")}</tbody><caption class="note">All measured from ${day(out.from)}, the first day every strategy has data. Best in each column is bold. Past results don't predict future returns.</caption>`;
}

function saveRow(k) {
  const c = out.rows[k].c;
  state.saved.push({ id: crypto.randomUUID(), name: c.name, rules: c.rules, created: Date.now() });
  store.set("saved", state.saved);
  emit("saved");
  toast(`Saved "${c.name}" to your Library`);
  render();
}

export function initCompare() {
  $("#compare-run").addEventListener("click", run);
  $("#compare-lineup").addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (t?.dataset.remove) remove(t.dataset.remove);
    if (t?.dataset.edit) startEditing(t.dataset.edit);
  });
  $("#add-tabs").addEventListener("click", (e) => { const t = e.target.closest("button[data-add]"); if (t) showAddTab(t.dataset.add); });
  $(".add-card").addEventListener("click", (e) => {
    const t = e.target.closest("button[data-toggle]");
    if (t) picked.includes(t.dataset.toggle) ? remove(t.dataset.toggle) : add(t.dataset.toggle);
    const ex = e.target.closest("button[data-try]");
    if (ex) { $("#custom-rules").value = ex.dataset.try; checkCustom(); $("#custom-rules").focus(); }
  });
  $("#custom-form").addEventListener("submit", submitCustom);
  $("#custom-rules").addEventListener("input", () => { clearTimeout(checkTimer); checkTimer = setTimeout(checkCustom, 250); });
  $("#custom-rules").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("#custom-form").requestSubmit(); });
  $("#custom-cancel").addEventListener("click", () => { stopEditing(); renderLineup(); });
  $("#compare-table").addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (t?.dataset.open) openStrategy(out.rows[t.dataset.open].c);
    if (t?.dataset.save) saveRow(Number(t.dataset.save));
  });
  on("compare-add", (id) => { if (add(id)) toast("Added to your Compare lineup"); });
  // From the Studio: a frozen copy of the current rules, so versions can be compared.
  on("compare-snapshot", ({ name, rules }) => {
    if (!rules?.trim()) return toast("Write some rules first.");
    if (full()) return toast(`Your Compare lineup is full (${MAX}). Remove one there first.`);
    const taken = new Set(candidates().map((c) => c.name));
    let label = name || "My strategy", n = 2;
    while (taken.has(label)) label = `${name} (${n++})`;
    const id = `custom-${crypto.randomUUID().slice(0, 8)}`;
    custom = [...custom, { id, name: label, named: true, prompt: rules, rules }];
    picked = [...picked, id];
    save();
    toast(`"${label}" is in your lineup (${picked.length} of ${MAX})`);
  });
  on("show", (v) => { if (v === "compare") { renderAll(); render(); } });
  on("data", renderAll);
  on("saved", renderAll);
}
