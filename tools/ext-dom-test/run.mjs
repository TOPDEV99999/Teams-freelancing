// Builds test.ts and runs it in headless Chrome with a throw-away profile (never your own profiles).
//   node tools/ext-dom-test/run.mjs
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "wa-domtest-"));
await build({ entryPoints: [fileURLToPath(new URL("./test.ts", import.meta.url))], bundle: true,
  outfile: join(dir, "test.js"), format: "iife", target: "chrome116", logLevel: "error" });
// The test replaces <body>; keep the output element outside of it.
writeFileSync(join(dir, "index.html"), `<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>
<script>const o=document.createElement('pre');o.id='out';o.textContent='pending';document.documentElement.appendChild(o);</script>
<script src="test.js"></script>`);
const chrome = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
if (!chrome) { console.error("no Chrome/Edge found"); process.exit(2); }
const profile = join(dir, "profile");
const html = execFileSync(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--user-data-dir=${profile}`, "--window-size=1280,900", "--virtual-time-budget=60000", "--dump-dom",
  pathToFileURL(join(dir, "index.html")).href], { encoding: "utf8", timeout: 120000 });
rmSync(dir, { recursive: true, force: true });
const m = html.match(/<pre id="out">([\s\S]*?)<\/pre>/);
const raw = (m?.[1] ?? "").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
let results;
try { results = JSON.parse(raw); } catch { console.error("no results:", raw.slice(0, 500)); process.exit(1); }
let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  -> ${r.detail}`}`);
  if (!r.ok) failed++;
}
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
