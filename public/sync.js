// Sync across devices (bollineni.co only).
// On the site, /sync/kit.js keeps saved strategies, the rebalancing portfolio, the watchlist,
// price alerts and the strategy conversation the same on every device linked to the site's sync,
// with no account. Everything is encrypted in this browser first. Paper-trading runs stay on the
// device that started them: they move with every price tick, and two devices trading one book
// would fight.
import { $, store, state, emit } from "./core.js";

export function startSync() {
  const S = window.BollineniSync;
  if (!S || !window.crypto?.subtle) return;
  const PREF_KEYS = ["watchlist", "alerts", "portfolio", "chat"];
  const sym = (v) => typeof v === "string" && /^[A-Z0-9.^=-]{1,15}$/.test(v);
  const num = (v) => Number.isFinite(v);
  const CHECK = {
    watchlist: (v) => Array.isArray(v) && v.length <= 50 && v.every(sym),
    alerts: (v) => Array.isArray(v) && v.length <= 100 && v.every((a) => a && sym(a.symbol) && (a.dir === "above" || a.dir === "below") && num(a.price) && typeof a.triggered === "boolean"),
    portfolio: (v) => v && Array.isArray(v.holdings) && v.holdings.length <= 60 && v.holdings.every((h) => h && typeof h.symbol === "string" && h.symbol.length <= 15 && num(h.shares) && num(h.target))
      && num(v.cash) && num(v.band) && num(v.minTrade) && num(v.cashBuffer) && typeof v.fractional === "boolean",
    chat: (v) => Array.isArray(v) && v.length <= 60 && v.every((m) => m && typeof m === "object" && JSON.stringify(m).length < 40000),
  };
  let applying = false;
  const engine = S.createEngine({
    app: "ballast",
    collections: { strategies: { first: "keep" }, prefs: { first: "remote" } },
    read() {
      const strategies = {};
      // A strategy is plain-English rules; ones saved by early versions hold code instead.
      for (const s of state.saved) {
        const out = { name: s.name, created: s.created || 0 };
        if (typeof s.rules === "string") out.rules = s.rules;
        if (typeof s.code === "string") out.code = s.code;
        strategies[s.id] = out;
      }
      const prefs = { watchlist: state.watchlist, alerts: state.alerts, portfolio: { ...state.portfolio }, chat: state.chat.slice(-60) };
      return { strategies, prefs: JSON.parse(JSON.stringify(prefs)) };
    },
    clean(col, v, id) {
      if (col === "strategies") {
        const text = (t) => t === undefined || (typeof t === "string" && t.length <= 60000);
        return /^[\w-]{1,64}$/.test(id) && v && typeof v.name === "string" && v.name.length <= 120 && num(v.created)
          && text(v.rules) && text(v.code) && (typeof v.rules === "string" || typeof v.code === "string")
          ? { name: v.name, created: v.created, ...(v.rules !== undefined && { rules: v.rules }), ...(v.code !== undefined && { code: v.code }) } : null;
      }
      if (col === "prefs") return Object.hasOwn(CHECK, id) && CHECK[id](v) ? v : null;
      return null;
    },
    async write(v) {
      applying = true; // these saves came from another device; don't echo them back as changes
      try {
        state.saved = Object.entries(v.strategies).map(([id, s]) => ({ id, ...s })).sort((a, b) => a.created - b.created);
        if (v.prefs.watchlist) state.watchlist = v.prefs.watchlist;
        if (v.prefs.alerts) state.alerts = v.prefs.alerts;
        if (v.prefs.chat) state.chat = v.prefs.chat;
        if (v.prefs.portfolio) state.portfolio = v.prefs.portfolio;
        store.set("saved", state.saved);
        store.set("watchlist", state.watchlist);
        store.set("alerts", state.alerts);
        store.set("chat", state.chat);
        store.set("portfolio", state.portfolio);
      } finally { applying = false; }
      emit("data");
      emit("chat");
    },
    maxPayload: 790000,
  });
  S.register(engine, "Ballast");
  // Every save to one of these keys is a change to sync.
  store.onSet((key) => { if (!applying && (key === "saved" || PREF_KEYS.includes(key))) engine.changed(); });
  const btn = $("#sync-btn");
  const draw = () => {
    const st = engine.status();
    btn.hidden = !st.available;
    btn.classList.toggle("on", st.on);
    btn.textContent = !st.on ? "Sync" : st.phase === "syncing" ? "Syncing…" : st.phase === "error" ? "Sync ⚠" : "Synced";
    btn.title = st.on ? (st.problem?.message || "Synced with your devices. Click to manage.") : "Keep strategies, portfolio, watchlist and alerts on all your devices";
  };
  engine.onStatus(draw);
  S.site.onChange(draw);
  btn.addEventListener("click", () => S.openPanel({ app: "ballast", tint: "#2DD4BF" }));
  engine.start().catch(() => {});
}
