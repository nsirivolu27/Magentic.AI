import { build } from "esbuild";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32" || process.version !== "v22.23.2") {
  throw new Error("Build this Windows preview with Node 22.23.2; the bundled license matches that runtime.");
}
const repo = fileURLToPath(new URL("../../", import.meta.url));
const desktop = fileURLToPath(new URL("./", import.meta.url));
const output = join(repo, "dist", "desktop");
const destination = join(output, `Magentic-Developer-${Date.now()}`);
await mkdir(destination, { recursive: true });
await import("../build.mjs");
await mkdir(join(destination, "app"));
for (const name of await readdir(join(repo, "dist", "workbench"))) {
  await copyFile(join(repo, "dist", "workbench", name), join(destination, "app", name));
}
await mkdir(join(destination, "runtime"));
await copyFile(process.execPath, join(destination, "runtime", "node.exe"));
const options = { bundle: true, platform: "node", format: "esm", target: "node22", metafile: true, logLevel: "info" };
const app = await build({ ...options, entryPoints: [join(repo, "workbench", "demo.ts")], outfile: join(destination, "app", "demo.mjs") });
const local = await build({ ...options, entryPoints: [join(repo, "workbench", "local-main.ts")], outfile: join(destination, "app", "local-main.mjs") });
const launcher = await build({ ...options, entryPoints: [join(desktop, "main.ts")], outfile: join(destination, "launcher.mjs") });
const adapterDir = join(destination, "app", "node_modules", "@langchain", "ollama");
await mkdir(adapterDir, { recursive: true });
const adapter = await build({ ...options, stdin: { contents: 'export { ChatOllama } from "@langchain/ollama";', resolveDir: repo, sourcefile: "desktop-ollama.ts" }, outfile: join(adapterDir, "index.mjs") });
await writeFile(join(adapterDir, "package.json"), JSON.stringify({ name: "@langchain/ollama", type: "module", exports: "./index.mjs" }));
for (const name of ["Start-Magentic.ps1", "Install.ps1", "Install.cmd", "README.txt"]) await copyFile(join(desktop, name), join(destination, name));
await mkdir(join(destination, "licenses"));
await copyFile(join(desktop, "licenses", "Node-LICENSE.txt"), join(destination, "licenses", "Node-LICENSE.txt"));
// Bundled dependencies still need their notices even though their package
// directories are no longer shipped with the application.
const packages = new Map();
for (const result of [app, local, launcher, adapter]) {
  for (const input of Object.keys(result.metafile.inputs)) {
    if (!input.includes("node_modules")) continue;
    let folder = dirname(resolve(repo, input));
    while (folder !== dirname(folder)) {
      try {
        const pkg = JSON.parse(await readFile(join(folder, "package.json"), "utf8"));
        if (pkg.name && pkg.version) { packages.set(`${pkg.name}@${pkg.version}`, { folder, pkg }); break; }
      } catch { /* A source directory need not be a package root. */ }
      folder = dirname(folder);
    }
  }
}
let notices = "Magentic Developer bundles the following third-party packages.\nNode.js notices are in Node-LICENSE.txt.\n\n";
for (const [name, { folder, pkg }] of packages) {
  notices += `${name} — ${pkg.license ?? "See package license"}\n`;
  for (const file of await readdir(folder)) {
    if (/^(license|notice|copying)(\.|$)/i.test(file)) notices += `${file}\n${await readFile(join(folder, file), "utf8")}\n`;
  }
  notices += "\n";
}
await writeFile(join(destination, "licenses", "THIRD-PARTY-NOTICES.txt"), notices);
const checksums = {};
async function hashFiles(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) await hashFiles(path);
    else checksums[relative(destination, path).replaceAll("\\", "/")] = createHash("sha256").update(await readFile(path)).digest("hex");
  }
}
await hashFiles(destination);
await writeFile(join(destination, "checksums.json"), JSON.stringify(checksums, null, 2));
const zip = join(output, "Magentic-Developer-Windows.zip");
const quote = value => "'" + value.replaceAll("'", "''") + "'";
execFileSync("powershell.exe", ["-NoProfile", "-Command", `Compress-Archive -LiteralPath ${quote(destination)} -DestinationPath ${quote(zip)} -Force`], { windowsHide: true, stdio: "inherit" });
console.log(`Desktop package: ${zip}`);
console.log(`Extracted package: ${destination}`);
