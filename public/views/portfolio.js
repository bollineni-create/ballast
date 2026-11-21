// Portfolio: keeps real holdings on target (advice only, it never places orders),
// plus the optional Alpaca paper autopilot that the Mac app runs.
import { $, esc, money, store, state, on, go, showing, toast, downloadCsv, copyText, fetchJson, postJson, quotesInBase } from "../core.js";
import { analyze, plan } from "../lib/rebalance.js";
import { log, notify } from "./live.js";
import { lastRun } from "./studio.js";

const prices = {}, errors = {};
let rbPlan = null, wasOut = false;
const pf = () => state.portfolio;
const save = () => store.set("portfolio", state.portfolio);

async function refreshPrices() {
  const symbols = [...new Set(pf().holdings.map((h) => h.symbol).filter(Boolean))];
  if (!symbols.length) return render();
  try {
    // In one currency, so foreign holdings add up correctly with the rest.
    const q = await quotesInBase(symbols, "USD"); // cash and every figure here are dollars
    for (const s of symbols) {
      if (q.prices[s] != null) { prices[s] = q.prices[s]; delete errors[s]; } else errors[s] = q.errors[s] || "No quote";
    }
    $("#rb-updated").textContent = `Prices updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    $("#rb-updated").textContent = `Price update failed: ${err.message}`;
  }
  render();
}

export function render() {
  const p = pf();
  const a = analyze(p.holdings, prices, Number(p.cash) || 0, p.cashBuffer);
  rbPlan = plan(a, { band: p.band, minTrade: p.minTrade, fractional: p.fractional, cashBuffer: p.cashBuffer, force: $("#rb-force").checked });
  const out = rbPlan.outOfBand.length;
  const priced = p.holdings.every((h) => !h.symbol || prices[h.symbol] != null);

  // Notify once each time the portfolio drifts out of its band.
  if (priced && out && !wasOut) {
    log(`Rebalance suggested: ${rbPlan.outOfBand.map((r) => `${r.symbol} ${r.drift > 0 ? "+" : ""}${r.drift.toFixed(1)} pts`).join(", ")}.`);
    notify(`Portfolio drifted: ${rbPlan.outOfBand.map((r) => r.symbol).join(", ")} outside the ${p.band}-point band`);
  }
  if (priced) wasOut = out > 0;
  if (!showing("portfolio")) return;

  const pill = $("#rb-status");
  pill.textContent = !priced ? "Loading prices…" : out ? `${out} holding${out > 1 ? "s" : ""} off target` : "On target";
  pill.className = `chip ${!priced ? "" : out ? "bad" : "on"}`;

  const maxDrift = a.rows.reduce((m, r) => Math.max(m, Math.abs(r.drift)), 0);
  $("#rb-metrics").innerHTML = [
    ["Portfolio value", money(a.total)], ["Invested", money(a.invested)], ["Cash", `${money(a.cash)}`, `${a.cashWeight.toFixed(1)}% of the portfolio`],
    ["Furthest off target", `${maxDrift.toFixed(1)} pts`, `band is ±${p.band} pts`],
  ].map(([l, v, s]) => `<div class="metric"><div class="label">${l}</div><div class="value">${v}</div>${s ? `<div class="sub">${s}</div>` : ""}</div>`).join("");

  const warn = $("#rb-warn");
  warn.hidden = Math.abs(a.targetSum - 100) < 0.01;
  warn.textContent = `Targets add up to ${a.targetSum.toFixed(1)}%. They should total 100% (the cash you keep is taken off the top).`;

  // Only rebuild the inputs when the table isn't being edited, so typing isn't interrupted.
  const tbl = $("#rb-holdings");
  if (!tbl.contains(document.activeElement)) {
    tbl.innerHTML = `<thead><tr><th>Symbol</th><th>Shares</th><th class="num">Price</th><th class="num">Value</th><th>Target %</th><th class="num">Off by</th><th></th></tr></thead><tbody>${p.holdings.map((h, k) => {
      const r = a.rows.find((x) => x.symbol === h.symbol), err = errors[h.symbol];
      const drift = r ? r.drift : null;
      return `<tr>
        <td><input data-rb="${k}" data-field="symbol" value="${esc(h.symbol)}" maxlength="20" spellcheck="false" aria-label="Symbol" /></td>
        <td><input data-rb="${k}" data-field="shares" type="number" min="0" step="any" value="${h.shares}" aria-label="Shares" /></td>
        <td class="num">${r ? r.price.toFixed(2) : err ? `<span class="neg" title="${esc(err)}">no price</span>` : "…"}</td>
        <td class="num">${r ? money(r.value) : "–"}</td>
        <td><input data-rb="${k}" data-field="target" type="number" min="0" max="100" step="0.5" value="${h.target}" aria-label="Target percent" /></td>
        <td class="num ${drift == null ? "" : Math.abs(drift) > p.band ? "neg" : "pos"}">${drift == null ? "–" : `${drift > 0 ? "+" : ""}${drift.toFixed(1)} pts`}</td>
        <td><button type="button" class="link" data-rb-del="${k}" title="Remove">✕</button></td></tr>`;
    }).join("")}</tbody>`;
  }
  // Each bar is the holding's share of the portfolio; the tick is its target.
  const top = Math.max(10, ...a.rows.map((r) => Math.max(r.weight, r.target))) * 1.1;
  $("#rb-bars").innerHTML = a.rows.map((r) => `<div class="wbar"><strong>${esc(r.symbol)}</strong><div class="track"><i style="width:${(r.weight / top) * 100}%;${Math.abs(r.drift) > p.band ? "background:var(--down)" : ""}"></i><b style="left:${(r.target / top) * 100}%"></b></div><span class="v">${r.weight.toFixed(1)}% of ${r.target}%</span></div>`).join("");

  $("#rb-plan").innerHTML = !rbPlan.needed
    ? `<tbody><tr><td class="empty">Nothing to do. Every holding is within ±${p.band} points of its target.</td></tr></tbody>`
    : rbPlan.trades.length
      ? `<thead><tr><th>Action</th><th class="num">Shares</th><th>Symbol</th><th class="num">About</th><th class="num">Amount</th></tr></thead><tbody>${rbPlan.trades
        .map((t) => `<tr><td class="${t.side === "BUY" ? "pos" : "neg"}"><strong>${t.side === "BUY" ? "Buy" : "Sell"}</strong></td><td class="num">${t.shares}</td><td>${esc(t.symbol)}</td><td class="num">${t.price.toFixed(2)}</td><td class="num">${money(t.amount)}</td></tr>`)
        .join("")}<tr><td colspan="4">Cash afterwards</td><td class="num">${money(rbPlan.cashAfter)}</td></tr></tbody>`
      : `<tbody><tr><td class="empty">Off target, but every trade would be under the ${money(p.minTrade)} minimum.</td></tr></tbody>`;
}

function syncInputs() {
  const p = pf();
  $("#rb-cash").value = p.cash; $("#rb-band").value = p.band; $("#rb-min").value = p.minTrade; $("#rb-buffer").value = p.cashBuffer;
  $("#rb-fractional").checked = p.fractional;
}

const planText = () => rbPlan.trades.map((t) => `${t.side} ${t.shares} ${t.symbol} (about ${money(t.amount)} at ${t.price.toFixed(2)})`).join("\n");

// Copies target weights from a strategy into the holdings, keeping share counts.
function setTargets(targets) {
  const p = pf();
  const bySym = Object.fromEntries(targets.map((t) => [t.symbol, t.target]));
  for (const h of p.holdings) h.target = bySym[h.symbol] ?? 0;
  for (const t of targets) if (!p.holdings.some((h) => h.symbol === t.symbol)) p.holdings.push({ symbol: t.symbol, shares: 0, target: t.target });
  p.holdings = p.holdings.filter((h) => h.target > 0 || h.shares > 0);
  save();
  go("portfolio");
  refreshPrices();
  toast("Targets copied from the strategy");
}

// ---------- Alpaca paper autopilot ----------
let ap = null;
async function loadAutopilot() {
  if (!state.autopilot) return renderAutopilot();
  try { ap = await fetchJson("api/autopilot/status"); } catch (err) { ap = { error: err.message }; }
  renderAutopilot();
}

function renderAutopilot(extra = "") {
  const s = ap, body = $("#ap-body"), pill = $("#ap-pill");
  pill.className = "chip";
  if (!state.autopilot) {
    pill.textContent = "Mac app only";
    body.innerHTML = `<p class="note">The autopilot runs this rebalancer on an Alpaca paper account: real prices, pretend money. It needs the Ballast Mac app (or <code>npm start</code>), which keeps your Alpaca keys on your own computer. This website never sees any keys.</p>`;
    return;
  }
  if (!s) return;
  if (s.error) {
    pill.textContent = "Unavailable";
    body.innerHTML = `<p class="note">Couldn't reach the autopilot: ${esc(s.error)}. Is the server running?</p>`;
    return;
  }
  if (!s.configured) {
    pill.textContent = "Not connected";
    body.innerHTML = `<p>Runs this rebalancer automatically on an <strong>Alpaca paper-trading</strong> account: real prices, pretend money. It can't place real-money orders.</p>
      <ol class="note"><li>Create a free account at alpaca.markets and open the Paper Trading dashboard.</li><li>Generate paper API keys.</li>
      <li>Add them in the Mac app with Ballast → Edit Keys… (or, running from source, in <code>.env</code>).</li><li>Restart Ballast, then come back here.</li></ol>`;
    return;
  }
  const c = s.config, isOn = c.enabled && !s.stopped;
  pill.textContent = s.stopped ? "Emergency stop on" : isOn ? "On" : "Off";
  pill.classList.toggle("on", isOn);
  const acct = s.account ? `${money(s.account.equity)} equity, ${money(s.account.cash)} cash` : `<span class="neg">${esc(s.accountError || "account unavailable")}</span>`;
  const entries = s.journal.slice(0, 12).map((e) => {
    const what = e.type === "order" ? `${e.side} ${esc(e.symbol)} ${e.notional != null ? money(Number(e.notional)) : `${e.qty} sh`} → ${esc(e.status)}${e.fillPrice ? ` at ${e.fillPrice.toFixed(2)}` : ""}`
      : e.type === "check" ? `Check: equity ${money(e.equity)}${e.outOfBand.length ? `, off target: ${esc(e.outOfBand.join(", "))}` : ", all on target"}`
      : `${e.type === "error" ? "⚠ " : ""}${esc(e.message || e.type)}`;
    return `<li><span><time>${new Date(e.ts).toLocaleString()}</time>${what}</span></li>`;
  }).join("");
  body.innerHTML = `
    <div class="ap-grid">
      <div><div class="note">Paper account</div>${acct}</div>
      <div><div class="note">Targets</div>${c.targets.map((t) => `${esc(t.symbol)} ${t.target}%`).join(" · ")}</div>
      <div><div class="note">Rules</div>±${c.band} pts band · min ${money(c.minTrade)} · ${c.cashBuffer}% cash · daily check after ${esc(c.checkTimeET)} ET</div>
      <div><div class="note">Test started</div>${c.startedAt ? `${esc(c.startedAt)} with ${money(c.startEquity)}` : "Not yet. Starts at the first check."}</div>
    </div>
    ${s.configErrors.length ? `<p class="error" style="margin-top:10px">${esc(s.configErrors.join("; "))}</p>` : ""}
    <div class="row wrap" style="margin-top:12px">
      <button type="button" class="btn small" id="ap-sync" title="Copy the targets and rules from the table above">Use targets &amp; rules above</button>
      <button type="button" class="btn small ${isOn ? "" : "primary"}" id="ap-toggle">${c.enabled ? "Turn off" : "Turn on"}</button>
      <button type="button" class="btn small" id="ap-run">Run check now</button>
      <button type="button" class="btn small" id="ap-report">Test report</button>
    </div>
    ${extra}
    <h4 style="margin-top:16px">Decision log</h4>
    <ul class="list activity">${entries || `<li class="empty">Nothing yet.</li>`}</ul>`;

  const attempt = async (f) => { try { await f(); } catch (err) { renderAutopilot(`<p class="error" style="margin-top:10px">${esc(err.message)}</p>`); } };
  $("#ap-sync").onclick = () => attempt(async () => {
    const p = pf();
    const targets = p.holdings.filter((h) => h.symbol && h.target > 0).map((h) => ({ symbol: h.symbol, target: h.target }));
    await postJson("api/autopilot/config", { targets, band: p.band, minTrade: Math.max(1, p.minTrade), cashBuffer: p.cashBuffer });
    await loadAutopilot();
  });
  $("#ap-toggle").onclick = () => attempt(async () => {
    await postJson("api/autopilot/config", { enabled: !c.enabled });
    log(`Paper autopilot turned ${c.enabled ? "off" : "on"}.`);
    await loadAutopilot();
  });
  $("#ap-run").onclick = () => attempt(async () => {
    if (!confirm("Run a rebalance check on the paper account now? If anything is off target it will place paper orders.")) return;
    $("#ap-run").disabled = true;
    const r = await postJson("api/autopilot/run");
    await loadAutopilot();
    renderAutopilot(`<p class="note" style="margin-top:10px">${esc(r.message || r.skipped || "Done")}</p>`);
  });
  $("#ap-report").onclick = () => attempt(async () => {
    const r = await fetchJson("api/autopilot/report");
    renderAutopilot(`<pre class="report">${esc(r.markdown)}</pre>`);
  });
}

export function initPortfolio() {
  syncInputs();
  for (const [id, key] of [["#rb-cash", "cash"], ["#rb-band", "band"], ["#rb-min", "minTrade"], ["#rb-buffer", "cashBuffer"]]) {
    $(id).addEventListener("input", () => { pf()[key] = Math.max(0, Number($(id).value) || 0); save(); render(); });
  }
  $("#rb-fractional").addEventListener("change", () => { pf().fractional = $("#rb-fractional").checked; save(); render(); });
  $("#rb-force").addEventListener("change", render);

  const tbl = $("#rb-holdings");
  tbl.addEventListener("input", (e) => {
    const k = e.target.dataset.rb;
    if (k == null) return;
    const h = pf().holdings[k], f = e.target.dataset.field;
    h[f] = f === "symbol" ? e.target.value.trim().toUpperCase() : Math.max(0, Number(e.target.value) || 0);
    save();
  });
  // Recalculate (and fetch a price for a new symbol) when the user leaves a field.
  tbl.addEventListener("focusout", (e) => {
    if (e.target.dataset.field === "symbol" && e.target.value && prices[e.target.value.trim().toUpperCase()] == null) setTimeout(refreshPrices, 0);
    else setTimeout(render, 0);
  });
  tbl.addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur(); });
  tbl.addEventListener("click", (e) => {
    const t = e.target.closest("button[data-rb-del]");
    if (!t) return;
    pf().holdings.splice(Number(t.dataset.rbDel), 1);
    save();
    render();
  });
  $("#rb-add").addEventListener("click", () => {
    pf().holdings.push({ symbol: "", shares: 0, target: 0 });
    save();
    render();
    $(`#rb-holdings input[data-rb="${pf().holdings.length - 1}"][data-field="symbol"]`)?.focus();
  });
  $("#rb-from-strategy").addEventListener("click", () => {
    const now = lastRun()?.result;
    if (now?.kind !== "allocate" || !now.now.targets.some((t) => t.target != null)) return toast("Open a portfolio strategy in the Studio first");
    setTargets(now.now.targets.filter((t) => t.target > 0.05).map((t) => ({ symbol: t.symbol, target: Math.round(t.target * 10) / 10 })));
  });
  $("#rb-copy").addEventListener("click", () => rbPlan?.trades.length && copyText(planText(), "Trade list copied"));
  $("#rb-export").addEventListener("click", () => {
    if (!rbPlan?.trades.length) return;
    downloadCsv(`rebalance_${new Date().toISOString().slice(0, 10)}.csv`, [["side", "symbol", "shares", "approx_price", "approx_amount"], ...rbPlan.trades.map((t) => [t.side, t.symbol, t.shares, t.price.toFixed(4), t.amount.toFixed(2)])]);
  });
  // After the user places the trades at their broker, roll the plan into the holdings.
  $("#rb-apply").addEventListener("click", () => {
    if (!rbPlan?.trades.length) return;
    if (!confirm("Update share counts and cash as if these trades filled at the shown prices? Edit them afterwards to match your actual fills.")) return;
    const p = pf();
    for (const t of rbPlan.trades) {
      const h = p.holdings.find((x) => x.symbol === t.symbol);
      h.shares = Math.max(0, Math.round((h.shares + (t.side === "BUY" ? t.shares : -t.shares)) * 1e4) / 1e4);
    }
    p.cash = Math.round(rbPlan.cashAfter * 100) / 100;
    log(`Recorded rebalance: ${rbPlan.trades.map((t) => `${t.side} ${t.shares} ${t.symbol}`).join(", ")}.`);
    save();
    syncInputs();
    $("#rb-force").checked = false;
    render();
  });

  on("targets", setTargets);
  on("show", (v) => { if (v === "portfolio") { render(); loadAutopilot(); } });
  // Holdings changed from elsewhere (sync, the check-up): price anything new.
  on("data", () => { syncInputs(); if (pf().holdings.some((h) => h.symbol && prices[h.symbol] == null)) refreshPrices(); else render(); });
  refreshPrices();
  setInterval(refreshPrices, 15000);
  setInterval(() => showing("portfolio") && loadAutopilot(), 60000);
}
