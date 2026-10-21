// Loads .env (KEY=value lines) before other modules read process.env.
// Import this first. Variables already set in the environment take precedence.
// BALLAST_HOME moves .env and autopilot-data out of the code folder; the packaged
// Mac app sets it to ~/Library/Application Support/Ballast.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const home = process.env.BALLAST_HOME || path.dirname(fileURLToPath(import.meta.url));
const file = path.join(home, ".env");
if (fs.existsSync(file)) process.loadEnvFile(file);

// A test folder can name its own paper account with "alpacaKeyPrefix" in its
// config.json (e.g. "ALPACA_2" reads ALPACA_2_API_KEY_ID / ALPACA_2_API_SECRET_KEY).
// The default keys are then removed for this process, so a folder whose own keys
// are missing can never fall back to, and trade in, another test's account.
if (process.env.AUTOPILOT_DIR) {
  let prefix = "ALPACA";
  try { prefix = JSON.parse(fs.readFileSync(path.join(process.env.AUTOPILOT_DIR, "config.json"), "utf8")).alpacaKeyPrefix || prefix; } catch { /* no config yet */ }
  if (prefix !== "ALPACA") {
    for (const k of ["API_KEY_ID", "API_SECRET_KEY"]) {
      const v = process.env[`${prefix}_${k}`];
      if (v) process.env[`ALPACA_${k}`] = v;
      else delete process.env[`ALPACA_${k}`];
    }
  }
}
