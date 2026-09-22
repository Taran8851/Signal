// Copies the console (../frontend) into dist/ for Tauri to embed, leaving out pages that
// only make sense on the website: the AI playground (a dev page), the old redirect shim and
// QA scratch files.
import { cpSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const from = path.resolve(here, "../../frontend");
const to = path.resolve(here, "../dist");
const skip = new Set(["ai-playground.html", "signal.html"]);

rmSync(to, { recursive: true, force: true });
cpSync(from, to, {
  recursive: true,
  filter: (src) => {
    const name = path.basename(src);
    return !skip.has(name) && !name.startsWith(".qa");
  },
});
console.log("Copied app/frontend to app/desktop/dist");
