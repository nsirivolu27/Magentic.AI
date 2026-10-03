import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Change, Project } from "./bot-schema.js";
import { PipelineError } from "./pipeline.js";

export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

export function command(executable: string, args: string[], cwd: string, signal?: AbortSignal, outputLimit = 12_000): Promise<{ exitCode: number | null; output: string; passed: boolean }> {
  return new Promise(resolveResult => {
    // Arguments stay separate from the executable. Repository configuration,
    // never model output, chooses commands; no shell expands either value.
    execFile(executable === "node" ? process.execPath : executable, args, {
      cwd, windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024, ...(signal ? { signal } : {}),
    }, (error, stdout, stderr) => resolveResult({
      exitCode: error ? (typeof error.code === "number" ? error.code : null) : 0,
      passed: !error, output: (stdout + stderr + (error && !stderr ? `\nCommand failed (${error.code ?? "terminated"}).` : "")).slice(0, outputLimit),
    }));
  });
}
async function git(root: string, args: string[]): Promise<string> {
  const result = await command("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], root, undefined, 64 * 1024);
  if (!result.passed) throw new PipelineError(409, "Git operation failed. Check the repository path, Git installation, and checkout permissions.");
  return result.output.trim();
}
export async function inspectProject(project: Project): Promise<Project> {
  if (!isAbsolute(project.root)) throw new PipelineError(400, "Choose an absolute repository path.");
  // VS Code can lowercase the drive letter while Git keeps it uppercase.
  // Native canonical paths avoid rejecting the same Windows directory.
  const root = realpathSync.native(project.root);
  if (!lstatSync(root).isDirectory()) throw new PipelineError(400, "The repository path must be a directory.");
  const top = await git(root, ["rev-parse", "--show-toplevel"]);
  if (realpathSync.native(top) !== root) throw new PipelineError(400, "Select the repository root, not a subdirectory.");
  await git(root, ["rev-parse", "--verify", "HEAD"]);
  return { ...project, root };
}
export async function createCheckout(project: Project, path: string): Promise<{ checkout: string; baseCommit: string }> {
  const baseCommit = await git(project.root, ["rev-parse", "HEAD"]);
  mkdirSync(resolve(path, ".."), { recursive: true });
  // A run starts from committed HEAD. The developer's current checkout and
  // uncommitted changes remain available in their existing editor.
  await git(project.root, ["worktree", "add", "--detach", path, baseCommit]);
  return { checkout: realpathSync(path), baseCommit };
}

export function projectPath(root: string, name: string): string {
  if (!name || name.length > 250 || name.includes("\\") || name.includes(":")) throw new PipelineError(400, "Use a relative project file path with forward slashes.");
  const parts = name.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || /[. ]$/.test(part)
    || /^(?:\.git|\.env(?:\..*)?|node_modules|\.ssh|\.aws|\.npmrc|\.pypirc|credentials.*|id_rsa|id_ed25519|.*\.(?:pem|key|p12)|(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?)$/i.test(part))) {
    throw new PipelineError(403, "This path is outside the bot's permitted project files.");
  }
  if (lstatSync(root).isSymbolicLink()) throw new PipelineError(403, "Linked checkouts are unavailable.");
  const canonicalRoot = realpathSync(root);
  const target = resolve(canonicalRoot, ...parts);
  const rel = relative(canonicalRoot, target);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep)) throw new PipelineError(403, "The path leaves the checkout.");
  let current = canonicalRoot;
  for (const part of parts) {
    current = join(current, part);
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink() || info.nlink > 1 && info.isFile()) throw new PipelineError(403, "Linked files are not available to bots.");
      const actual = relative(canonicalRoot, realpathSync(current));
      if (isAbsolute(actual) || actual.startsWith(".." + sep)) throw new PipelineError(403, "The path leaves the checkout.");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return target;
}
export function readProjectFile(root: string, name: string): string | null {
  const path = projectPath(root, name);
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > 30_000) throw new PipelineError(400, "Choose a text file smaller than 30 KB.");
    const content = readFileSync(path, "utf8");
    if (content.includes("\0") || content.includes("\uFFFD")) throw new PipelineError(400, "Binary or non-UTF-8 files are unavailable.");
    return content;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export async function listProjectFiles(root: string, limit = 300): Promise<string[]> {
  const names = (await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).split("\0").filter(Boolean);
  return names.filter(name => { try { projectPath(root, name); return true; } catch { return false; } }).slice(0, limit);
}
export async function projectDiff(root: string): Promise<string> {
  const names = await listProjectFiles(root);
  if (!names.length) return "";
  return (await git(root, ["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--", ...names])).slice(0, 20_000);
}
export async function treeDigest(root: string): Promise<string> {
  const names = await listProjectFiles(root, Number.MAX_SAFE_INTEGER);
  const hash = createHash("sha256");
  let size = 0;
  for (const name of names.sort()) {
    const path = projectPath(root, name);
    try {
      const info = lstatSync(path);
      if (!info.isFile()) continue;
      size += info.size;
      if (size > 100 * 1024 * 1024) throw new PipelineError(409, "The checkout exceeds the 100 MB validation snapshot limit.");
      hash.update(JSON.stringify([name, info.size])).update(readFileSync(path));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; hash.update(JSON.stringify([name, null])); }
  }
  return hash.digest("hex");
}
export function applyChanges(root: string, changes: Change[]): void {
  const names = changes.map(change => change.path.toLowerCase());
  if (new Set(names).size !== names.length) throw new PipelineError(400, "A proposal must not target the same file twice.");
  for (const change of changes) {
    if (readProjectFile(root, change.path) !== change.before) throw new PipelineError(409, "A proposed file changed. Run the bot again before applying it.");
  }
  const written: Change[] = [];
  try {
    for (const change of changes) {
      const path = projectPath(root, change.path);
      mkdirSync(resolve(path, ".."), { recursive: true });
      // Exclusive temporary files keep partial content out of editor views.
      const temporary = `${path}.magentic-${randomUUID()}`;
      const mode = change.before === null ? 0o644 : lstatSync(path).mode;
      try { writeFileSync(temporary, change.after, { flag: "wx", mode }); renameSync(temporary, path); }
      finally { rmSync(temporary, { force: true }); }
      written.push(change);
    }
  } catch (error) {
    for (const change of written.reverse()) {
      const path = projectPath(root, change.path);
      if (change.before === null) rmSync(path); else writeFileSync(path, change.before);
    }
    throw error;
  }
}
