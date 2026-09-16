import { build } from "esbuild";
import { rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await build({
  // Two entry points, two ways to run the same adapter: as a subprocess of
  // one person's client, or hosted for many.
  entryPoints: ["stdio.ts", "http-main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  sourcemap: "linked",
  logLevel: "info",
  external: ["node:*"],
});
