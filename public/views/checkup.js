// Check-up: share a portfolio (typed, pasted or as a screenshot) and goals, and see
// how the mix has behaved, where its risk sits and how it lines up with the goals.
import { $, esc, money, pct, num, tone, store, state, settings, on, emit, showing, toast, postJson, quotesInBase, loadBars } from "../core.js";
import { parseHoldings, toWeights } from "../lib/holdings.js";
import { checkup } from "../lib/checkup.js";
import { describe } from "../lib/spec.js";
import { nameOf } from "../lib/markets.js";
import { lineChart } from "../lib/charts.js";
import { openStrategy } from "./studio.js";

let image = null; // data URL of the attached screenshot
let read = null; // { positions, cash, cashWeight, weights, total, notes, data } from the last analysis
let report = null;
let seq = 0;
let stated = {}; // goals said in words that have no field of their own (income)

const GOAL_FIELDS = [["#ck-years", "years"], ["#ck-monthly", "monthly"], ["#ck-target", "target"], ["#ck-drop", "maxDrop"]];
function goalsFromFields() {
  const g = {};
  for (const [id, k] of GOAL_FIELDS) { const v = Number($(id).value); if (v > 0) g[k] = v; }
  if ($("#ck-risk").value) g.risk = $("#ck-risk").value;
  return { ...stated, ...g };
}
function fillGoals(g) {
  for (const [id, k] of GOAL_FIELDS) $(id).value = g[k] ?? "";
  $("#ck-risk").value = g.risk || "";
}

const status = (text) => { $("#ck-status").hidden = !text; if (text) $("#ck-status-text").textContent = text; };
const fail = (msg) => { $("#ck-error").hidden = !msg; $("#ck-error").textContent = msg || ""; };

// Shrinks a picture so it uploads quickly; account screenshots stay readable at this size.
async function toDataUrl(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.88);
}
async function attach(file) {
  if (!file || !file.type.startsWith("image/")) return;
  if (!state.reader) return fail(state.server ? "Reading a picture needs Claude, which isn't switched on here. Type or paste the positions instead." : "Reading a picture needs the Ballast server. Type or paste the positions instead.");
  try {
    image = await toDataUrl(file);
    $("#ck-thumb").src = image;
    $("#ck-shot-note").textContent = "Claude reads the positions from this picture. It is sent for that one reading and not saved.";
    $("#ck-shot").hidden = false;
    fail("");
  } catch { fail("Couldn't open that picture. Try a PNG or JPEG screenshot."); }
}
function detach() { image = null; $("#ck-shot").hidden = true; $("#ck-file").value = ""; }

async function analyze() {
  const text = $("#ck-text").value.trim();
  if (!text && !image) return fail("Type what you hold, or add a screenshot of your account.");
  const mine = ++seq;
  fail("");
  $("#ck-run").disabled = true;
  try {
    const typed = parseHoldings(text);
    let positions = typed.positions, cash = typed.cash, cashWeight = typed.cashWeight, goals = typed.goals, notes = "";
    // A picture always goes to Claude; plain text only when the built-in reader found nothing.
    if (image || (!positions.length && state.reader && text)) {
      status(image ? "Reading your picture…" : "Reading what you wrote…");
      const ai = await postJson("api/portfolio/read", { text, image });
      const seen = new Set(positions.map((p) => p.symbol));
      // A row with a share count or a value doesn't also need its percent.
      const rows = ai.positions.map((p) => (p.weight != null && (p.shares != null || p.value != null) ? { symbol: p.symbol, shares: p.shares, value: p.value } : p));
      positions = [...positions, ...rows.filter((p) => !seen.has(p.symbol))];
      cash ||= ai.cash || 0;
      goals = { ...ai.goals, ...goals };
      notes = ai.notes || "";
    }
    if (mine !== seq) return;
    if (!positions.length) throw new Error(image ? "No holdings could be read from that picture. Try a clearer screenshot of the positions list, or type them." : "Couldn't find any holdings in that. Try a list like \"50 AAPL, $5,000 in VTI, 10% bonds\".");
    if (positions.some((p) => p.weight != null) && positions.some((p) => p.weight == null)) throw new Error("Some holdings are given in percent and others in shares or dollars. Use one or the other for all of them.");
    if (positions.every((p) => p.weight != null) && cash > 0) throw new Error("The holdings are in percent but the cash is in dollars. Give the cash as a percent too, like \"10% cash\".");

    status("Getting prices…");
    const needPrice = positions.filter((p) => p.weight == null).map((p) => p.symbol); // values too, so they can become share counts
    const prices = {};
    if (needPrice.length) {
      Object.assign(prices, (await quotesInBase(needPrice)).prices); // one currency, so holdings can be added up
    }
    const w = toWeights({ positions, cash, cashWeight }, prices);
    if (w.missing.length) throw new Error(`Couldn't get a price for ${w.missing.join(", ")}. Check the symbol, or give that holding as a dollar amount.`);
    const syms = Object.keys(w.weights);
    status(`Loading history for ${syms.join(", ")}…`);
    const spec = { kind: "allocate", symbols: syms, weights: w.weights, rotate: null, rebalance: "yearly", band: null, riskOff: null };
    const data = await loadBars(spec, syms[0], { ...settings, years: "max", benchmark: "", source: "live" });
    if (mine !== seq) return;
    // Cash in dollars, whether it was typed as dollars or as a share of the whole.
    const cashAmount = cash || (w.total ? w.cashWeight * w.total : 0);
    read = { positions, prices, ...w, cash: cashAmount, notes, data, spec, unread: typed.unread };
    stated = goals.income ? { income: true } : {};
    fillGoals({ ...goalsFromFields(), ...goals });
    store.set("checkup", { text });
    run();
  } catch (e) {
    if (mine === seq) fail(e.message);
  } finally {
    if (mine === seq) { status(""); $("#ck-run").disabled = false; }
  }
}

// Re-runs the analysis on the holdings already read (used when a goal field changes).
function run() {
  if (!read) return;
  try {
    report = checkup({ weights: read.weights, bars: read.data.bars, fx: read.data.fx, total: read.total, goals: goalsFromFields() });
    fail("");
    render();
  } catch (e) { fail(e.message); }
}

const metric = (label, value, cls = "", sub = "") => `<div class="metric"><div class="label">${esc(label)}</div><div class="value ${cls}">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;
const short = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M` : v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v.toFixed(0)}`);

function render() {
  if (!report || !showing("portfolio")) return;
  const c = report, m = c.metrics, g = goalsFromFields();
  $("#ck-out").hidden = false;
  $("#ck-read").innerHTML = [
    ...read.positions.map((p) => `<span class="chip">${esc(p.symbol)} · ${p.shares != null ? `${+p.shares.toFixed(4)} sh` : p.value != null ? money(p.value) : `${p.weight}%`}</span>`),
    ...(read.cash ? [`<span class="chip">Cash · ${money(read.cash)}</span>`] : []),
  ].join("");
  $("#ck-notes").textContent = [
    read.total ? `Worth about ${money(read.total)} at current prices.` : "Given as percentages, so dollar figures assume $10,000.",
    read.notes, read.unread.length ? `Not read as a holding or a goal: "${read.unread.join('", "')}".` : "", ...read.data.warnings,
  ].filter(Boolean).join(" ");
  $("#ck-findings").innerHTML = c.findings.map((f) => `<li class="${f.tone}"><span><b>${esc(f.title)}</b>${esc(f.text)}</span></li>`).join("");
  $("#ck-metrics").innerHTML = [
    metric("Return per year", pct(m.cagr), tone(m.cagr), `over ${num(m.years, 1)} years, rebalanced yearly`),
    metric("Worst drop", pct(m.maxDrawdown), "neg", `${Math.round(m.longestDrawdownDays / 30.4)} months to recover`),
    metric("Worst year", pct(m.worstYear), tone(m.worstYear), `best ${pct(m.bestYear)}`),
    metric("Swings per year", pct(m.vol), "", `acts like ${num(c.effective, 1)} equal holdings`),
  ].join("");
  $("#ck-holdings").innerHTML = `<thead><tr><th>Holding</th><th class="num">Share of money</th><th class="num">Share of swings</th><th class="num">Own swings</th></tr></thead><tbody>${c.holdings.map((h) =>
    `<tr><td><strong>${esc(h.symbol)}</strong> <span class="note">${esc(nameOf(h.symbol) === h.symbol ? h.cls : nameOf(h.symbol))}</span></td><td class="num">${pct(h.weight)}</td><td class="num ${h.riskShare - h.weight > 12 ? "neg" : ""}">${pct(h.riskShare)}</td><td class="num">${pct(h.vol, 0)}</td></tr>`).join("")}
    ${c.cashWeight > 0.1 ? `<tr><td><strong>Cash</strong></td><td class="num">${pct(c.cashWeight)}</td><td class="num">0.0%</td><td class="num">0%</td></tr>` : ""}</tbody>`;
  $("#ck-classes").innerHTML = Object.entries(c.classes).sort((a, b) => b[1] - a[1]).map(([name, v]) => `<div class="wbar"><span>${esc(name)}</span><div class="track"><i style="width:${Math.min(100, v)}%"></i></div><span class="v">${pct(v, 0)}</span></div>`).join("");

  const p = c.projection;
  if (p) {
    const now = Date.now(), t = p.bands[0].map((_, k) => now + (k * p.years * 365.25 * 864e5) / (p.bands[0].length - 1));
    $("#ck-chart-title").textContent = `Where it could be in ${p.years} years`;
    $("#ck-legend").innerHTML = `<span><i style="background:var(--c1)"></i>Middle outcome</span><span><i style="background:var(--c1);opacity:.3"></i>8 in 10 / half of futures</span>${g.target ? `<span><i class="dash" style="background:var(--c3)"></i>Your target</span>` : ""}`;
    lineChart($("#ck-chart"), {
      bands: [{ time: t, lo: p.bands[0], hi: p.bands[4], color: "--c1", alpha: 0.12 }, { time: t, lo: p.bands[1], hi: p.bands[3], color: "--c1", alpha: 0.2 }],
      series: [
        { time: t, values: p.bands[2], color: "--c1", label: "Middle outcome", width: 2 },
        { time: t, values: t.map((_, k) => c.start + (g.monthly || 0) * 12 * ((k * p.years) / (t.length - 1))), color: "--quiet", label: "Money put in", width: 1.2, dash: [4, 3] },
        ...(g.target ? [{ time: t, values: t.map(() => g.target), color: "--c3", label: "Target", width: 1.2, dash: [2, 3] }] : []),
      ],
      log: false, min: 0, format: short,
    });
    $("#ck-chart-note").textContent = `500 futures made by reshuffling this mix's real daily returns${g.monthly ? `, adding $${g.monthly.toLocaleString()} a month` : ""}. Half end between ${short(p.end.p25)} and ${short(p.end.p75)}; you would have put in ${short(p.paid)}. Not adjusted for inflation or taxes.`;
  } else {
    const r = c.result;
    $("#ck-chart-title").textContent = "How this mix has done";
    $("#ck-legend").innerHTML = "";
    lineChart($("#ck-chart"), { series: [{ time: r.time, values: r.equity, color: "--c1", label: "This mix", width: 2, fill: true, fillAlpha: 0.08 }], format: short });
    $("#ck-chart-note").textContent = "Growth of $10,000 held in these proportions and rebalanced once a year. Add how many years you have to go to see where it could end up.";
  }
}

export function initCheckup() {
  $("#ck-text").value = store.get("checkup", {}).text || "";
  $("#ck-form").addEventListener("submit", (e) => { e.preventDefault(); analyze(); });
  $("#ck-text").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); analyze(); } });
  $("#ck-file").addEventListener("change", (e) => attach(e.target.files[0]));
  $("#ck-shot-remove").addEventListener("click", detach);
  // A screenshot can also be pasted or dropped onto the card.
  $("#ck-text").addEventListener("paste", (e) => {
    const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith("image/"));
    if (f) { e.preventDefault(); attach(f); }
  });
  const card = $("#checkup");
  card.addEventListener("dragover", (e) => { e.preventDefault(); card.classList.add("drag"); });
  card.addEventListener("dragleave", () => card.classList.remove("drag"));
  card.addEventListener("drop", (e) => { e.preventDefault(); card.classList.remove("drag"); attach(e.dataTransfer.files[0]); });
  for (const id of [...GOAL_FIELDS.map(([x]) => x), "#ck-risk"]) $(id).addEventListener("change", run);

  $("#ck-to-holdings").addEventListener("click", () => {
    if (!read || !confirm("Replace the holdings in the rebalancer with these, using today's mix as the targets?")) return;
    const p = state.portfolio;
    p.holdings = report.holdings.map((h) => {
      const pos = read.positions.find((x) => x.symbol === h.symbol);
      const shares = pos.shares ?? (pos.value != null && read.prices[h.symbol] ? pos.value / read.prices[h.symbol] : 0);
      // The rebalancer's targets cover the invested part; the cash share becomes "cash to keep".
      return { symbol: h.symbol, shares: Math.round(shares * 1e4) / 1e4, target: Math.round((h.weight / (100 - report.cashWeight)) * 1000) / 10 };
    });
    p.cashBuffer = Math.round(report.cashWeight * 10) / 10;
    if (read.total) p.cash = Math.round(read.cash * 100) / 100;
    store.set("portfolio", p);
    emit("data");
    toast("Holdings copied to the rebalancer");
  });
  $("#ck-to-studio").addEventListener("click", () => read && openStrategy({ name: "My portfolio", rules: describe({ ...read.spec, weights: Object.fromEntries(Object.entries(read.spec.weights).map(([s, v]) => [s, Math.round(v * 1000) / 1000])) }) }));

  $("#ck-how").textContent = state.reader ? "Typed, pasted, or a screenshot" : "Typed or pasted";
  $("#ck-file-label").hidden = !state.reader && state.server;
  on("show", (v) => v === "portfolio" && render());
}
