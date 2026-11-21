// Builds public/tokens.css, the single source of Ballast's design tokens.
// Edit the data here, then run:  node tools/tokens.mjs
// DESIGN.md explains how the tokens are meant to be used.
import { writeFileSync } from "node:fs";

// Scales shared by every theme.
const SCALES = {
  // type: one family, eight sizes
  "--sans": '"Archivo", "Helvetica Neue", Helvetica, Arial, sans-serif',
  "--mono": 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  "--fs-1": "12px", "--fs-2": "13px", "--fs-3": "14px", "--fs-4": "15px", "--fs-5": "17px", "--fs-6": "20px", "--fs-7": "24px",
  "--fs-8": "clamp(28px, 4vw, 40px)",
  "--w-regular": "400", "--w-medium": "600", "--w-bold": "700", "--w-heavy": "800",
  // space: 4px grid
  "--s-1": "4px", "--s-2": "8px", "--s-3": "12px", "--s-4": "16px", "--s-5": "20px", "--s-6": "24px", "--s-8": "32px", "--s-10": "40px",
  // shape
  "--r-s": "8px", "--r-m": "12px", "--r-l": "16px", "--r-xl": "22px", "--r-full": "999px",
  // motion
  "--ease": "cubic-bezier(.32, .72, 0, 1)", "--t-fast": ".15s", "--t-base": ".25s", "--t-slow": ".8s",
  // brand: the logo keeps these in every theme
  "--brand-wash": "#0A2826", "--brand-tint": "#2DD4BF",
  // layout
  "--side": "max(20px, env(safe-area-inset-left), env(safe-area-inset-right))", "--page": "1320px",
};

// Semantic colors. Components only ever use these names, never raw hex values.
//   bg page · surface cards · raised wells and inputs · line borders · grid chart lines
//   ink headings · text body · quiet secondary text
//   tint the one action color · tint-ink text on tint · tint-soft tinted backgrounds
//   up / down gains and losses · warn cautions · c1..c6 chart series
const THEMES = {
  tide: {
    label: "Tide", note: "Teal on deep green. The bollineni.co tint for Ballast, carried through the whole surface.",
    light: { bg: "#F4F7F6", surface: "#FFFFFF", raised: "#F0F4F3", line: "#DFE6E4", grid: "#E9EEEC", ink: "#050707", text: "#1F2625", quiet: "#5E6B69",
      tint: "#0B7A6E", "tint-ink": "#FFFFFF", "tint-soft": "#DDF5F1", up: "#0B7F49", down: "#D62E1F", warn: "#9A5B00", "warn-soft": "#FFF3D9", "down-soft": "#FDE7E4",
      c1: "#0B7A6E", c2: "#6D4AD6", c3: "#C2410C", c4: "#0369A1", c5: "#B4236E", c6: "#5B6B14" },
    dark: { bg: "#061A19", surface: "#0A2826", raised: "#0F3431", line: "#1A433F", grid: "#123835", ink: "#FFFFFF", text: "#DCEBE8", quiet: "#8DAEA9",
      tint: "#2DD4BF", "tint-ink": "#04201D", "tint-soft": "#0F3F3A", up: "#4ADE80", down: "#FF7A6B", warn: "#F6C453", "warn-soft": "#3A2F0E", "down-soft": "#3D1814",
      c1: "#2DD4BF", c2: "#A78BFA", c3: "#FB923C", c4: "#60A5FA", c5: "#F472B6", c6: "#BEF264" },
  },
  ink: {
    label: "Ink", note: "Black on white, the bollineni.co page itself. Teal appears only in charts and gains.",
    light: { bg: "#FFFFFF", surface: "#FFFFFF", raised: "#F4F4F4", line: "#E2E2E2", grid: "#EEEEEE", ink: "#000000", text: "#262626", quiet: "#5E5E5E",
      tint: "#000000", "tint-ink": "#FFFFFF", "tint-soft": "#F0F0F0", up: "#0B7F49", down: "#D62E1F", warn: "#8A5200", "warn-soft": "#FFF3D9", "down-soft": "#FDE7E4",
      c1: "#0B7A6E", c2: "#6D4AD6", c3: "#C2410C", c4: "#0369A1", c5: "#B4236E", c6: "#5B6B14" },
    dark: { bg: "#000000", surface: "#101010", raised: "#1A1A1A", line: "#303030", grid: "#222222", ink: "#FFFFFF", text: "#DADADA", quiet: "#A8A8A8",
      tint: "#FFFFFF", "tint-ink": "#000000", "tint-soft": "#242424", up: "#4ADE80", down: "#FF7A6B", warn: "#F6C453", "warn-soft": "#3A2F0E", "down-soft": "#3D1814",
      c1: "#2DD4BF", c2: "#A78BFA", c3: "#FB923C", c4: "#60A5FA", c5: "#F472B6", c6: "#BEF264" },
  },
  harbor: {
    label: "Harbor", note: "Cobalt on warm paper and navy. Calmer and more traditional, like a brokerage statement.",
    light: { bg: "#F6F5F1", surface: "#FFFFFF", raised: "#F0EEE7", line: "#E1DDD1", grid: "#ECE9DF", ink: "#0E1A2B", text: "#27303F", quiet: "#667085",
      tint: "#1F4FD8", "tint-ink": "#FFFFFF", "tint-soft": "#E3EAFD", up: "#0B7F49", down: "#C8321F", warn: "#8A5200", "warn-soft": "#FBEFD2", "down-soft": "#FBE6E2",
      c1: "#1F4FD8", c2: "#0B7A6E", c3: "#C2410C", c4: "#7C3AED", c5: "#B4236E", c6: "#5B6B14" },
    dark: { bg: "#0B1220", surface: "#111A2C", raised: "#18233A", line: "#25324E", grid: "#1A2740", ink: "#FFFFFF", text: "#D6DEEB", quiet: "#8A99B4",
      tint: "#7AA2FF", "tint-ink": "#071022", "tint-soft": "#18284C", up: "#4ADE80", down: "#FF7A6B", warn: "#F6C453", "warn-soft": "#3A2F0E", "down-soft": "#3D1814",
      c1: "#7AA2FF", c2: "#2DD4BF", c3: "#FB923C", c4: "#C4B5FD", c5: "#F472B6", c6: "#BEF264" },
  },
};
export { SCALES, THEMES };

const SHADOW = {
  light: { "--shadow-1": "0 1px 2px rgb(10 20 20 / .05), 0 8px 24px -12px rgb(10 20 20 / .12)", "--shadow-2": "0 30px 80px -20px rgb(0 0 0 / .35)" },
  dark: { "--shadow-1": "0 1px 0 rgb(255 255 255 / .03) inset, 0 12px 32px -16px rgb(0 0 0 / .6)", "--shadow-2": "0 30px 80px -20px rgb(0 0 0 / .7)" },
};
const block = (sel, mode, colors) => `${sel} {\n  color-scheme: ${mode};\n${[...Object.entries(colors).map(([k, v]) => [`--${k}`, v]), ...Object.entries(SHADOW[mode])].map(([k, v]) => `  ${k}: ${v};`).join("\n")}\n}`;

let css = `/* Ballast design tokens. GENERATED by tools/tokens.mjs: edit that file, not this one.
   Theme: <html data-theme="tide|ink|harbor">. Mode: follows the system, or force it with data-mode="light|dark". */
@font-face {
  font-family: "Archivo"; src: url("fonts/archivo.woff2") format("woff2");
  font-weight: 100 900; font-stretch: 62% 125%; font-style: normal; font-display: swap;
}
:root {\n${Object.entries(SCALES).map(([k, v]) => `  ${k}: ${v};`).join("\n")}\n}\n`;
for (const [name, t] of Object.entries(THEMES)) {
  const sel = name === "tide" ? ":root" : `[data-theme="${name}"]`; // tide is the default
  css += `\n/* ---------- ${t.label}: ${t.note} ---------- */\n`;
  css += block(`${sel}, ${sel === ":root" ? ':root[data-mode="light"]' : `${sel}[data-mode="light"]`}`, "light", t.light) + "\n";
  css += `@media (prefers-color-scheme: dark) {\n${block(sel === ":root" ? ':root:not([data-mode="light"])' : `${sel}:not([data-mode="light"])`, "dark", t.dark).replace(/^/gm, "  ")}\n}\n`;
  css += block(sel === ":root" ? ':root[data-mode="dark"]' : `${sel}[data-mode="dark"]`, "dark", t.dark) + "\n";
}
writeFileSync(new URL("../public/tokens.css", import.meta.url), css);
console.log("wrote public/tokens.css", css.length, "bytes");
