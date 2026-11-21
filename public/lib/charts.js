// Canvas charts: time-series lines with bands, fills, trade markers and a hover
// readout; grouped bars; and an inline sparkline. Colors may be CSS variable names
// ("--tint"), read at draw time so charts follow the light or dark theme.

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
export const color = (c) => (c?.startsWith("--") ? css(c) : c);
const day = (t) => new Date(t).toISOString().slice(0, 10);

// One observer redraws every chart whose canvas changes size.
const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver((entries) => {
  for (const e of entries) if (e.target.clientWidth) e.target._draw?.();
});
matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => document.querySelectorAll("canvas").forEach((c) => c._draw?.()));

function setup(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.font = `11.5px ${css("--sans") || "sans-serif"}`;
  return { ctx, w, h };
}

// Index of the last time <= t.
function locate(time, t) {
  let lo = 0, hi = time.length - 1;
  if (t < time[0]) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (time[mid] <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}

const niceStep = (span, target) => {
  const raw = span / target, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / mag;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
};

// series: [{ time, values, color, label, width, dash, fill }]   fill shades between the line and `base`
// bands:  [{ time, lo, hi, color }]                              shaded range
// markers:[{ time, value, type: "buy"|"sell"|"short"|"cover" }]
// lines:  [{ time, label }]                                      vertical guides
export function lineChart(canvas, { series, bands = [], markers = [], lines = [], format = (v) => v.toFixed(2), log = "auto", base = null, min = null, max = null }) {
  const pad = { l: 6, r: 58, t: 10, b: 22 };
  let hover = null;

  function draw() {
    if (!canvas.clientWidth) return;
    const { ctx, w, h } = setup(canvas);
    const all = series.filter((s) => s.values.length > 1);
    if (!all.length) return;
    const t0 = Math.min(...all.map((s) => s.time[0])), t1 = Math.max(...all.map((s) => s.time[s.time.length - 1]));
    let lo = Infinity, hi = -Infinity;
    const see = (v) => { if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } };
    for (const s of all) for (const v of s.values) see(v);
    for (const b of bands) { b.lo.forEach(see); b.hi.forEach(see); }
    if (base != null) see(base);
    if (min != null) lo = min;
    if (max != null) hi = max;
    if (lo === hi) { lo -= 1; hi += 1; }
    // Log scale when values span more than 8x (decades of history), so early years stay readable.
    const useLog = log === true || (log === "auto" && lo > 0 && hi / lo > 8);
    const fwd = useLog ? Math.log : (v) => v, inv = useLog ? Math.exp : (v) => v;
    let flo = fwd(lo), fhi = fwd(hi);
    const span = fhi - flo;
    if (min == null) flo -= span * 0.05;
    if (max == null) fhi += span * 0.05;
    const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
    const x = (t) => pad.l + ((t - t0) / (t1 - t0 || 1)) * pw;
    const y = (v) => pad.t + (1 - (fwd(v) - flo) / (fhi - flo)) * ph;

    // grid and y labels
    ctx.fillStyle = css("--quiet");
    ctx.strokeStyle = css("--grid");
    ctx.lineWidth = 1;
    const ticks = [];
    if (useLog) for (let k = 0; k <= 4; k++) ticks.push(inv(flo + ((fhi - flo) * k) / 4));
    else {
      const step = niceStep(fhi - flo, Math.max(2, Math.floor(ph / 48)));
      for (let v = Math.ceil(flo / step) * step; v <= fhi + 1e-9; v += step) ticks.push(Math.abs(v) < step * 1e-6 ? 0 : v);
    }
    for (const v of ticks) {
      const yy = Math.round(y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(w - pad.r, yy); ctx.stroke();
      ctx.fillText(format(v), w - pad.r + 6, yy + 4);
    }
    // x labels: years when the span is long, dates otherwise
    const years = (t1 - t0) / (365.25 * 864e5);
    const nx = Math.max(2, Math.min(7, Math.floor(pw / 90)));
    if (years > 2.5) {
      const step = Math.max(1, Math.ceil(years / nx));
      for (let yr = new Date(t0).getUTCFullYear() + 1; ; yr++) {
        const t = Date.UTC(yr, 0, 1);
        if (t > t1) break;
        if (yr % step) continue;
        const xx = x(t), label = String(yr), tw = ctx.measureText(label).width;
        if (xx - tw / 2 >= pad.l && xx + tw / 2 <= w - pad.r) ctx.fillText(label, xx - tw / 2, h - 6);
      }
    } else {
      for (let k = 0; k <= nx; k++) {
        const t = t0 + ((t1 - t0) * k) / nx, label = day(t), tw = ctx.measureText(label).width;
        ctx.fillText(label, Math.min(Math.max(x(t) - tw / 2, pad.l), w - pad.r - tw), h - 6);
      }
    }

    // shaded bands
    for (const b of bands) {
      ctx.fillStyle = color(b.color);
      ctx.globalAlpha = b.alpha ?? 0.16;
      ctx.beginPath();
      b.time.forEach((t, i) => (i ? ctx.lineTo(x(t), y(b.hi[i])) : ctx.moveTo(x(t), y(b.hi[i]))));
      for (let i = b.time.length - 1; i >= 0; i--) ctx.lineTo(x(b.time[i]), y(b.lo[i]));
      ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 1;
    }

    for (const s of all) {
      const n = s.values.length, col = color(s.color);
      // Long series: a min/max pair per pixel keeps drawing fast without hiding spikes.
      const pts = [];
      const bucket = Math.max(1, Math.floor(n / pw));
      for (let i = 0; i < n; i += bucket) {
        if (bucket === 1) { if (Number.isFinite(s.values[i])) pts.push(i); continue; }
        let a = -1, b = -1;
        for (let j = i; j < Math.min(n, i + bucket); j++) {
          if (!Number.isFinite(s.values[j])) continue;
          if (a < 0 || s.values[j] < s.values[a]) a = j;
          if (b < 0 || s.values[j] > s.values[b]) b = j;
        }
        if (a < 0) continue;
        pts.push(Math.min(a, b));
        if (a !== b) pts.push(Math.max(a, b));
      }
      if (bucket > 1 && Number.isFinite(s.values[n - 1]) && pts.at(-1) !== n - 1) pts.push(n - 1);
      if (!pts.length) continue;
      const path = () => { ctx.beginPath(); pts.forEach((i, k) => (k ? ctx.lineTo(x(s.time[i]), y(s.values[i])) : ctx.moveTo(x(s.time[i]), y(s.values[i])))); };
      if (s.fill) {
        const by = y(base ?? (useLog ? inv(flo) : Math.max(lo, Math.min(hi, 0))));
        path();
        ctx.lineTo(x(s.time[pts.at(-1)]), by); ctx.lineTo(x(s.time[pts[0]]), by); ctx.closePath();
        ctx.fillStyle = col; ctx.globalAlpha = s.fillAlpha ?? 0.14; ctx.fill(); ctx.globalAlpha = 1;
      }
      path();
      ctx.strokeStyle = col; ctx.lineWidth = s.width ?? 1.6; ctx.lineJoin = "round"; ctx.setLineDash(s.dash ?? []);
      ctx.stroke(); ctx.setLineDash([]);
    }

    for (const g of lines) {
      const gx = Math.round(x(g.time)) + 0.5;
      ctx.strokeStyle = css("--quiet"); ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(gx, pad.t); ctx.lineTo(gx, h - pad.b); ctx.stroke(); ctx.setLineDash([]);
      if (g.label) { ctx.fillStyle = css("--quiet"); ctx.fillText(g.label, Math.min(gx + 5, w - pad.r - ctx.measureText(g.label).width), pad.t + 10); }
    }

    // trade markers: skip drawing thousands on a small chart
    const stride = Math.max(1, Math.ceil(markers.length / 400));
    markers.forEach((m, k) => {
      if (k % stride) return;
      const mx = x(m.time), my = y(m.value), up = m.type === "buy" || m.type === "cover";
      ctx.fillStyle = css(m.type === "buy" ? "--up" : m.type === "sell" ? "--down" : "--c2");
      ctx.beginPath();
      ctx.moveTo(mx, my + (up ? 5 : -5)); ctx.lineTo(mx - 4.5, my + (up ? 12 : -12)); ctx.lineTo(mx + 4.5, my + (up ? 12 : -12));
      ctx.fill();
    });

    if (useLog) { ctx.fillStyle = css("--quiet"); ctx.fillText("log scale", pad.l + 4, pad.t + 10); }

    if (hover != null) {
      const t = t0 + ((hover - pad.l) / pw) * (t1 - t0);
      const main = all[0], i0 = Math.max(0, locate(main.time, t)), tt = main.time[i0], hx = x(tt);
      ctx.strokeStyle = css("--quiet");
      ctx.beginPath(); ctx.moveTo(hx, pad.t); ctx.lineTo(hx, h - pad.b); ctx.stroke();
      const rows = [[day(tt), null]];
      for (const s of all) {
        if (!s.label) continue;
        const i = locate(s.time, tt), v = i >= 0 ? s.values[i] : NaN;
        rows.push([`${s.label}  ${Number.isFinite(v) ? format(v) : "–"}`, color(s.color)]);
        if (Number.isFinite(v)) { ctx.fillStyle = color(s.color); ctx.beginPath(); ctx.arc(hx, y(v), 3, 0, 7); ctx.fill(); }
      }
      const bw = Math.max(...rows.map(([l]) => ctx.measureText(l).width)) + 30, bh = rows.length * 17 + 8;
      const bx = hx + 12 + bw > w - 4 ? hx - bw - 12 : hx + 12;
      ctx.fillStyle = css("--surface"); ctx.strokeStyle = css("--line");
      ctx.beginPath(); ctx.roundRect(Math.max(2, bx), pad.t, bw, bh, 8); ctx.fill(); ctx.stroke();
      rows.forEach(([l, c], k) => {
        const ty = pad.t + 17 + k * 17, tx = Math.max(2, bx) + 10;
        if (c) { ctx.fillStyle = c; ctx.fillRect(tx, ty - 8, 8, 8); }
        ctx.fillStyle = css(c ? "--text" : "--quiet");
        ctx.fillText(l, tx + (c ? 13 : 0), ty);
      });
    }
  }

  canvas.onpointermove = (e) => { hover = Math.max(pad.l, Math.min(canvas.clientWidth - pad.r, e.clientX - canvas.getBoundingClientRect().left)); draw(); };
  canvas.onpointerleave = () => { hover = null; draw(); };
  canvas._draw = draw;
  ro?.observe(canvas);
  draw();
}

// Grouped bars around a zero line. groups: [{ label, color, values }], one value per label.
export function barChart(canvas, { labels, groups, format = (v) => `${v.toFixed(0)}%` }) {
  const pad = { l: 6, r: 50, t: 10, b: 22 };
  let hover = null;
  function draw() {
    if (!canvas.clientWidth) return;
    const { ctx, w, h } = setup(canvas);
    const vals = groups.flatMap((g) => g.values).filter(Number.isFinite);
    if (!vals.length) return;
    let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
    if (lo === hi) hi = 1;
    const span = hi - lo; lo -= lo < 0 ? span * 0.06 : 0; hi += span * 0.06;
    const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
    const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * ph;
    const slot = pw / labels.length, bw = Math.max(1, Math.min(18, (slot * 0.78) / groups.length));
    ctx.strokeStyle = css("--grid"); ctx.fillStyle = css("--quiet"); ctx.lineWidth = 1;
    const step = niceStep(hi - lo, Math.max(2, Math.floor(ph / 44)));
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      ctx.strokeStyle = css(Math.abs(v) < 1e-9 ? "--quiet" : "--grid");
      ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(w - pad.r, yy); ctx.stroke();
      ctx.fillText(format(v), w - pad.r + 6, yy + 4);
    }
    const every = Math.ceil(labels.length / Math.max(1, Math.floor(pw / 44)));
    labels.forEach((l, i) => {
      const cx = pad.l + slot * (i + 0.5);
      if (hover === i) { ctx.fillStyle = css("--raised"); ctx.fillRect(pad.l + slot * i, pad.t, slot, ph); }
      groups.forEach((g, k) => {
        const v = g.values[i];
        if (!Number.isFinite(v)) return;
        ctx.fillStyle = color(g.color);
        const bx = cx - (bw * groups.length) / 2 + k * bw, y0 = y(0), y1 = y(v);
        ctx.beginPath(); ctx.roundRect(bx + 0.5, Math.min(y0, y1), Math.max(1, bw - 1), Math.max(1, Math.abs(y1 - y0)), Math.min(3, bw / 2)); ctx.fill();
      });
      if (i % every === 0) { ctx.fillStyle = css("--quiet"); const tw = ctx.measureText(l).width; ctx.fillText(l, cx - tw / 2, h - 6); }
    });
    if (hover != null) {
      const rows = [[String(labels[hover]), null], ...groups.map((g) => [`${g.label}  ${Number.isFinite(g.values[hover]) ? format(g.values[hover]) : "–"}`, color(g.color)])];
      const bwid = Math.max(...rows.map(([l]) => ctx.measureText(l).width)) + 30, bh = rows.length * 17 + 8;
      const cx = pad.l + slot * (hover + 0.5), bx = Math.max(2, cx + 12 + bwid > w ? cx - bwid - 12 : cx + 12);
      ctx.fillStyle = css("--surface"); ctx.strokeStyle = css("--line");
      ctx.beginPath(); ctx.roundRect(bx, pad.t, bwid, bh, 8); ctx.fill(); ctx.stroke();
      rows.forEach(([l, c], k) => {
        const ty = pad.t + 17 + k * 17;
        if (c) { ctx.fillStyle = c; ctx.fillRect(bx + 10, ty - 8, 8, 8); }
        ctx.fillStyle = css(c ? "--text" : "--quiet");
        ctx.fillText(l, bx + 10 + (c ? 13 : 0), ty);
      });
    }
  }
  canvas.onpointermove = (e) => {
    const fx = (e.clientX - canvas.getBoundingClientRect().left - pad.l) / (canvas.clientWidth - pad.l - pad.r);
    hover = Math.max(0, Math.min(labels.length - 1, Math.floor(fx * labels.length)));
    draw();
  };
  canvas.onpointerleave = () => { hover = null; draw(); };
  canvas._draw = draw;
  ro?.observe(canvas);
  draw();
}

// A tiny inline line, as an SVG string.
export function sparkline(values, { w = 84, h = 24, up = true } = {}) {
  const v = values.filter(Number.isFinite);
  if (v.length < 2) return "";
  const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
  const pts = v.map((x, i) => `${((i / (v.length - 1)) * w).toFixed(1)},${(h - 2 - ((x - lo) / span) * (h - 4)).toFixed(1)}`).join(" ");
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="var(${up ? "--up" : "--down"})" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

// Background for a heat-map cell: green above zero, red below, stronger further out.
export function heat(v, scale) {
  if (!Number.isFinite(v)) return "";
  const a = Math.min(1, Math.abs(v) / (scale || 1)) * 0.55 + 0.06;
  return `background: color-mix(in srgb, var(${v >= 0 ? "--up" : "--down"}) ${Math.round(a * 100)}%, transparent)`;
}
