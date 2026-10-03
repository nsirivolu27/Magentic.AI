import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const output = new URL("../dist/workbench/", import.meta.url);
await mkdir(output, { recursive: true });
await build({ entryPoints: [fileURLToPath(new URL("./demo.ts", import.meta.url))], bundle: true, platform: "node", format: "esm", outfile: fileURLToPath(new URL("demo.mjs", output)), logLevel: "info" });
await build({ entryPoints: [fileURLToPath(new URL("./local-main.ts", import.meta.url))], bundle: true, platform: "node", format: "esm", outfile: fileURLToPath(new URL("local-main.mjs", output)), logLevel: "info" });
await build({ entryPoints: [fileURLToPath(new URL("./browser.ts", import.meta.url))], bundle: true, platform: "browser", format: "esm", target: "es2022", outfile: fileURLToPath(new URL("app.js", output)), logLevel: "info" });
await build({ entryPoints: [fileURLToPath(new URL("./ontology-main.ts", import.meta.url))], bundle: true, platform: "node", format: "esm", target: "node22", outfile: fileURLToPath(new URL("ontology-main.mjs", output)), logLevel: "info" });
for (const file of ["index.html", "styles.css", "email.css", "mcp.css", "theme.css", "chat.css", "pipeline.css", "manifest.webmanifest", "icon.svg"]) await copyFile(new URL(`./${file}`, import.meta.url), new URL(file, output));
