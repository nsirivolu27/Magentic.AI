import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startLocalWorkbench } from "../workbench/local.js";
import { SESSION_COOKIE } from "../workbench/local-session.js";
import { StorageError } from "../workbench/storage.js";

/**
 * The create, run, restart, reopen journey, across real process boundaries.
 *
 * Closing and reopening objects in one process proves the store reloads. It
 * does not prove the lock is released by a dying process, or that a second
 * instance is refused, which are the failures a person actually meets.
 */

const ENTRY = fileURLToPath(new URL("../workbench/local-main.js", import.meta.url));
/**
 * An asset directory the server can serve.
 *
 * The real app.js is produced by the esbuild step, which these tests do not
 * run, so a placeholder stands in. That is honest about scope: this file
 * exercises HTTP, the session handshake and persistence across processes,
 * not the browser bundle.
 */
function assetDir(): string {
  const source = fileURLToPath(new URL("../../workbench/", import.meta.url));
  const out = mkdtempSync(join(tmpdir(), "magentic-assets-"));
  for (const name of ["index.html", "styles.css", "agency.css", "pipeline.css", "chat.css", "theme.css", "mcp.css", "email.css", "manifest.webmanifest", "icon.svg"]) {
    try { copyFileSync(join(source, name), join(out, name)); } catch { writeFileSync(join(out, name), ""); }
  }
  writeFileSync(join(out, "app.js"), "/* not bundled in tests */\n");
  return out;
}
const ASSETS = assetDir();

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "magentic-journey-"));
}

/** Start the real entry point as a child and wait for its URL. */
function launch(dataDir: string): Promise<{ child: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
    const child = fork(ENTRY, ["--desktop"], {
      env: { ...process.env, MAGENTIC_WORKSPACES_DIR: dataDir, MAGENTIC_WORKBENCH_ASSETS: ASSETS },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error("the child never reported a URL")); }, 20_000);
    child.once("message", (message) => {
      clearTimeout(timer);
      const url = (message as { url?: string }).url;
      if (!url) { child.kill(); reject(new Error("no url in the startup message")); return; }
      resolve({ child, url });
    });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`the child exited early with code ${code}`)); });
  });
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) { resolve(); return; }
    child.once("exit", () => resolve());
    child.disconnect();
    setTimeout(() => { child.kill("SIGKILL"); }, 5_000).unref();
  });
}

async function claim(url: string): Promise<string> {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie && cookie.startsWith(`${SESSION_COOKIE}=`), "the first window gets the session");
  return cookie.split(";")[0]!;
}

test("a run survives the application closing and reopening", { timeout: 60_000 }, async () => {
  const dataDir = scratch();

  const first = await launch(dataDir);
  const cookie = await claim(first.url);
  const start = await fetch(`${first.url}api/pipeline`, {
    method: "POST",
    headers: { cookie, origin: first.url.replace(/\/$/, ""), "content-type": "application/json" },
    body: JSON.stringify({
      action: "start", requestId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
      title: "Survive a restart", brief: "Record something durable and close the app.",
    }),
  });
  const startBody = await start.text();
  assert.equal(start.status, 200, startBody);
  const started = JSON.parse(startBody) as { runs: { id: string; title: string }[] };
  assert.equal(started.runs.length, 1);
  const runId = started.runs[0]!.id;
  await stop(first.child);

  // A different process, the same data directory.
  const second = await launch(dataDir);
  const cookie2 = await claim(second.url);
  const reopened = await fetch(`${second.url}api/workspace`, { headers: { cookie: cookie2 } });
  assert.equal(reopened.status, 200);
  const body = await reopened.json() as { pipelines?: { storage: string; runs: { id: string; title: string }[] }; demo: boolean };
  assert.equal(body.demo, false, "the real application is not demo mode");
  assert.equal(body.pipelines?.storage, "file");
  assert.equal(body.pipelines?.runs.length, 1, "the run came back");
  assert.equal(body.pipelines?.runs[0]?.id, runId);
  assert.equal(body.pipelines?.runs[0]?.title, "Survive a restart");
  await stop(second.child);
});

test("a second instance on the same data directory is refused", { timeout: 60_000 }, async () => {
  process.env.MAGENTIC_WORKBENCH_ASSETS = ASSETS;
  const dataDir = scratch();
  const first = await launch(dataDir);
  await assert.rejects(
    () => startLocalWorkbench({ dataDir, port: 0 }),
    (error: unknown) => error instanceof StorageError && /another instance/i.test(error.message),
  );
  await stop(first.child);

  // Once the first is gone the lock is free, which is the other half of the
  // claim: the dying process released what it owned.
  const third = await startLocalWorkbench({ dataDir, port: 0 });
  await third.close();
});

test("a failed start leaves no lock behind for the next attempt", async () => {
  process.env.MAGENTIC_WORKBENCH_ASSETS = ASSETS;
  const dataDir = scratch();
  // A workspace id that cannot become a file name fails after the lock is
  // taken, which is exactly the window where a leak would hide.
  await assert.rejects(() => startLocalWorkbench({ dataDir, workspaceId: "../escape", port: 0 }));
  const recovered = await startLocalWorkbench({ dataDir, port: 0 });
  await recovered.close();
});

test("the local application rejects demo credentials over real HTTP", { timeout: 60_000 }, async () => {
  const dataDir = scratch();
  const app = await launch(dataDir);
  for (const demo of ["alex.writer", "taylor.admin"]) {
    const response = await fetch(`${app.url}api/workspace`, { headers: { authorization: `Bearer ${demo}` } });
    assert.equal(response.status, 401, `${demo} must not authenticate against the real application`);
  }
  await stop(app.child);
});
