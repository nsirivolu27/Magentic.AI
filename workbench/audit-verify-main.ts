import { readFileSync, statSync } from "node:fs";
import { verifyAuditPackage } from "./audit-package.js";

/**
 * audit:verify <package.json>
 *
 * Reads one audit package and recomputes every hash in it. Exit code 0 when
 * the file is consistent, 1 when anything differs, with each difference on
 * its own line. Works on any machine with Node; Magentic itself is not needed.
 */

const path = process.argv[2];
try {
  if (!path) throw new Error("Usage: audit:verify <package.json>");
  if (statSync(path).size > 16_000_000) throw new Error("The file is larger than 16 MB, which no audit package is.");
  const result = verifyAuditPackage(JSON.parse(readFileSync(path, "utf8")));
  console.log(result.summary);
  if (result.ok) console.log("Verified: every hash matches its text and the package hash matches its contents.");
  else { for (const problem of result.problems) console.error(`Problem: ${problem}`); process.exitCode = 1; }
} catch (error) {
  console.error(`Verification stopped. ${error instanceof Error ? error.message.slice(0, 300) : "The file could not be read."}`);
  process.exitCode = 1;
}
