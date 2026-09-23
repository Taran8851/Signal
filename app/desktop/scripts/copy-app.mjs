// Copies the console (../frontend) into dist/ for Tauri to embed, leaving out pages that
// only make sense on the website: the AI playground (a dev page), the old redirect shim and
// QA scratch files.
import { cpSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const from = path.resolve(here, "../../frontend");
const to = path.resolve(here, "../dist");
const skip = new Set(["ai-playground.html", "signal.html"]);

rmSync(to, { recursive: true, force: true });
cpSync(from, to, {
  recursive: true,
  // tokens.css is a symlink to the landing's copy; copy the file, not the link.
  dereference: true,
  filter: (src) => {
    const name = path.basename(src);
    return !skip.has(name) && !name.startsWith(".qa");
  },
});
// Insider builds: SIGNAL_INSIDER_CONFIG points at a JSON file outside the repo with the gateway
// address ({ gateway, model, name }). No keys: the gateway holds them on the server.
if (process.env.SIGNAL_INSIDER_CONFIG) {
  const cfg = JSON.parse(readFileSync(process.env.SIGNAL_INSIDER_CONFIG, "utf8"));
  writeFileSync(path.join(to, "insider-config.js"), "window.SignalInsider = " + JSON.stringify(cfg) + ";\n");
  console.log("Insider build: " + cfg.gateway);
}
console.log("Copied app/frontend to app/desktop/dist");
