import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkForUpdate, compareVersions, describe, verifyDownload } from "../workbench/desktop/update.js";

const feed = { version: "0.3.0", url: "https://example.invalid/Magentic-Developer-0.3.0-Windows.zip", sha256: "a".repeat(64) };
const answer = (body: unknown, status = 200) => (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;

test("update check compares versions, reads only a small https feed, and never throws", async () => {
  assert.ok(compareVersions("0.2.0", "0.3.0") < 0); assert.ok(compareVersions("0.10.0", "0.9.9") > 0); assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.deepEqual(await checkForUpdate("https://example.invalid/latest.json", "0.2.0", answer(feed)), { status: "available", feed });
  assert.deepEqual(await checkForUpdate("https://example.invalid/latest.json", "0.3.0", answer(feed)), { status: "current" });
  assert.equal((await checkForUpdate("http://example.invalid/latest.json", "0.2.0", answer(feed))).status, "unreachable");
  assert.equal((await checkForUpdate("https://example.invalid/latest.json", "0.2.0", answer(feed, 404))).status, "unreachable");
  assert.equal((await checkForUpdate("https://example.invalid/latest.json", "0.2.0", answer({ ...feed, url: "http://example.invalid/x.zip" }))).status, "unreachable");
  assert.equal((await checkForUpdate("https://example.invalid/latest.json", "0.2.0", answer("x".repeat(5000)))).status, "unreachable");
  assert.equal((await checkForUpdate("https://example.invalid/latest.json", "0.2.0", (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).status, "unreachable");
  assert.match(describe({ status: "available", feed }, "0.2.0"), /Update available: 0\.3\.0/);
  assert.match(describe({ status: "unreachable", reason: "offline" }, "0.2.0"), /skipped: offline/);
});

test("a downloaded package is accepted only when its SHA256 matches the feed", async t => {
  const dir = await mkdtemp(join(tmpdir(), "magentic-update-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "package.zip");
  await writeFile(path, "not really a zip");
  const digest = createHash("sha256").update("not really a zip").digest("hex");
  assert.equal(await verifyDownload(path, digest), true);
  assert.equal(await verifyDownload(path, digest.toUpperCase()), true);
  assert.equal(await verifyDownload(path, "b".repeat(64)), false);
});
