import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { localAppUrl, edgeArguments, startRuntime, stopRuntime } from "../workbench/desktop/runtime.js";

async function fixture(source: string, run: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "magentic-desktop-"));
  try { const path = join(directory, "runtime.mjs"); await writeFile(path, source); await run(path); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("desktop only accepts an explicit loopback runtime URL", () => {
  assert.equal(localAppUrl("http://127.0.0.1:4199/"), "http://127.0.0.1:4199/");
  for (const url of ["https://example.com/", "http://localhost:4199/", "http://127.0.0.1/", "http://user@127.0.0.1:4199/", "http://127.0.0.1:4199/?token=x", "file:///tmp/app", null]) {
    assert.throws(() => localAppUrl(url));
  }
});

test("desktop passes the app URL and profile as separate process arguments", () => {
  const args = edgeArguments("http://127.0.0.1:4199/", "C:\\Test Profile\\Magentic");
  assert.equal(args[0], "--app=http://127.0.0.1:4199/");
  assert.equal(args[1], "--user-data-dir=C:\\Test Profile\\Magentic");
  assert.ok(args.includes("--disable-background-mode"));
});

test("runtime reports its selected port and exits when its launcher disconnects", async () => {
  await fixture('process.send({url:"http://127.0.0.1:4199/"}); process.on("disconnect",()=>process.exit(0));', async path => {
    const runtime = await startRuntime(path);
    assert.equal(runtime.url, "http://127.0.0.1:4199/");
    await stopRuntime(runtime.child);
    assert.equal(runtime.child.exitCode, 0);
    await stopRuntime(runtime.child);
  });
});

test("runtime rejects an unexpected address and stops the child", async () => {
  await fixture('process.send({url:"https://example.com/"}); process.on("disconnect",()=>process.exit(0));', async path => {
    await assert.rejects(startRuntime(path), /loopback/);
  });
});

test("runtime startup timeout and early exit produce actionable failures", async () => {
  await fixture('process.on("disconnect",()=>process.exit(0));', async path => {
    await assert.rejects(startRuntime(path, 100), /did not start in time/);
  });
  await fixture('process.exit(1);', async path => {
    await assert.rejects(startRuntime(path), /exited before/);
  });
});
