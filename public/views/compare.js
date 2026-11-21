// Compare: several strategies over the same years, side by side.
import { $, esc, day, pct, num, tone, store, state, settings, on, showing, loadBars, LIBRARY } from "../core.js";
import { parseStrategy } from "../lib/parse.js";
import { backtestSpec } from "../lib/engine.js";
import { holdout, monteCarlo, score } from "../lib/lab.js";
import { lineChart } from "../lib/charts.js";
import { currentStrategy, openStrategy } from "./studio.js";

const SERIES = ["--c1", "--c2", "--c3", "--c4", "--c5", "--c6"];
const MAX = 6;
let picked = store.get("compare", ["current", "lib-8"]);
let out = null;

// Everything that can be compared: what's open in the Studio, saved strategies, starters.
function candidates() {
  const cur = currentStrategy();
  return [
    { id: "current", name: cur.name, rules: cur.rules, where: "Open in the Studio" },
    ...state.saved.filter((s) => s.rules).map((s) => ({ id: s.id, name: s.name, rules: s.rules, where: "Saved" })),
    ...LIBRARY.map((s) => ({ id: s.id, name: s.name, rules: s.rules, where: s.tag })),
  ];
}

function renderPicks() {
  const all = candidates();
  picked = picked.filter((id) => all.some((c) => c.id === id));
  $("#compare-picks").innerHTML = all.map((c) => `<label class="pick"><input type="checkbox" value="${esc(c.id)}" ${picked.includes(c.id) ? "checked" : ""} /><span><b>${esc(c.name)}</b><span>${esc(c.where)}</span></span></label>`).join("");
  $("#compare-hint").textContent = `Pick up to ${MAX}. They share the Studio's test settings: ${settings.years === "max" ? "all available history" : `${settings.years} years`}, ${settings.cost} bps per trade${settings.currency ? `, in ${settings.currency}` : ""}.`;
}

async function run() {
  const all = candidates(), chosen = picked.map((id) => all.find((c) => c.id === id)).filter(Boolean);
  const err = $("#compare-error");
  err.hidden = true;
  if (chosen.length < 2) { err.hidden = false; err.textContent = "Pick at least two strategies to compare."; return; }
  const btn = $("#compare-run");
  btn.disabled = true;
  btn.textContent = "Running…";
  try {
    const opt = { ...settings, benchmark: "" };
    const loaded = await Promise.all(chosen.map(async (c) => {
      const { spec } = parseStrategy(c.rules);
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
        const h = holdout(r);
        return { c: x.c, r, score: score(r, h, monteCarlo(r, { runs: 300 })) };
      }),
    };
    render();
  } catch (e) {
    err.hidden = false;
    err.textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Compare selected";
  }
}

function render() {
  if (!out || !showing("compare")) return;
  $("#compare-out").hidden = false;
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
  $("#compare-table").innerHTML = `<thead><tr><th>Strategy</th><th class="num">Score</th><th class="num">Per year</th><th class="num">Total</th><th class="num">Worst drop</th><th class="num">Volatility</th><th class="num">Sharpe</th><th class="num">Worst year</th><th class="num">Time invested</th><th></th></tr></thead><tbody>${out.rows.map((x, k) => {
    const m = x.r.metrics;
    return `<tr><td><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:var(${SERIES[k]});margin-right:8px"></i>${esc(x.c.name)}</td>
      <td class="num">${b(`${x.score.total} · ${x.score.word}`, x.score.total === top.score)}</td><td class="num ${tone(m.cagr)}">${b(pct(m.cagr), m.cagr === top.cagr)}</td><td class="num">${pct(m.totalReturn, 0)}</td>
      <td class="num neg">${b(pct(m.maxDrawdown), m.maxDrawdown === top.dd)}</td><td class="num">${pct(m.vol)}</td><td class="num">${b(num(m.sharpe), m.sharpe === top.sharpe)}</td><td class="num ${tone(m.worstYear)}">${pct(m.worstYear)}</td><td class="num">${pct(m.exposure, 0)}</td>
      <td class="num"><button type="button" class="btn small" data-open="${k}">Open</button></td></tr>`;
  }).join("")}</tbody><caption class="note">All measured from ${day(out.from)}, the first day every strategy has data. Best in each column is bold.</caption>`;
}

export function initCompare() {
  $("#compare-picks").addEventListener("change", (e) => {
    const id = e.target.value;
    if (e.target.checked) {
      if (picked.length >= MAX) { e.target.checked = false; return; }
      picked.push(id);
    } else picked = picked.filter((x) => x !== id);
    store.set("compare", picked);
  });
  $("#compare-run").addEventListener("click", run);
  $("#compare-table").addEventListener("click", (e) => {
    const t = e.target.closest("button[data-open]");
    if (t) openStrategy(out.rows[t.dataset.open].c);
  });
  on("compare-add", (id) => {
    if (!picked.includes(id)) picked = [...picked.slice(-(MAX - 1)), id];
    store.set("compare", picked);
  });
  on("show", (v) => { if (v === "compare") { renderPicks(); render(); } });
  on("data", () => showing("compare") && renderPicks());
}
