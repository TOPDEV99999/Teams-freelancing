// Bundles both Chrome extensions into <ext>/dist (load that folder via chrome://extensions → Load unpacked).
import { build, context } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");

const exts = ["ext-chatgpt", "ext-workana"];

for (const ext of exts) {
  const dir = join(root, ext);
  const out = join(dir, "dist");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(join(dir, "manifest.json"), join(out, "manifest.json"));
  cpSync(join(dir, "src", "popup.html"), join(out, "popup.html"));

  const opts = {
    entryPoints: {
      background: join(dir, "src", "background.ts"),
      content: join(dir, "src", "content.ts"),
      popup: join(dir, "src", "popup.ts"),
    },
    outdir: out,
    bundle: true,
    format: "iife",
    target: "chrome116",
    sourcemap: "inline",
    logLevel: "info",
  };
  if (watch) {
    const ctx = await context(opts);
    await ctx.watch();
  } else {
    await build(opts);
  }
  console.log(`✓ ${ext} → ${ext}/dist`);
}
if (watch) console.log("watching… (manifest/popup.html changes need a rebuild)");
