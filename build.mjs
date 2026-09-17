import { build } from "esbuild";
import { rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await build({
  // Three entry points: the adapter as a subprocess of one person's client,
  // the adapter hosted for many, and a command that prints the catalog
  // without starting either.
  entryPoints: ["stdio.ts", "http-main.ts", "list.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  sourcemap: "linked",
  logLevel: "info",
  external: ["node:*"],
});
