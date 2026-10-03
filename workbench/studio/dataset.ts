import { z } from "zod";
import type { DatasetShape } from "./recipes.js";
import { sha256, type DatasetIssue } from "./schema.js";

/**
 * JSONL dataset validation.
 *
 * A dataset is one JSON object per line. Every line is checked against the
 * shape its recipe expects, counted, and scanned for things that look like
 * credentials. The report names line numbers and issue codes and nothing
 * else: a line that failed because it holds a key is exactly the line whose
 * content must not end up in a saved record, an audit event or a browser.
 */

/** Upper bounds, so a stray file cannot pin the process. */
export const MAX_DATASET_BYTES = 20 * 1024 * 1024;
export const MAX_DATASET_LINES = 50_000;
const MAX_ISSUES = 50;

export interface DatasetReport {
  records: number;
  rejected: number;
  duplicates: number;
  secretFindings: number;
  issues: DatasetIssue[];
  contentHash: string;
  bytes: number;
  passed: boolean;
}

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().min(1).max(16_000),
}).strict();

const shapes: Record<DatasetShape, z.ZodTypeAny> = {
  messages: z.object({ messages: z.array(messageSchema).min(2).max(64) }).strict()
    .refine((record) => record.messages.at(-1)?.role === "assistant", "The last message must be from the assistant."),
  "prompt-completion": z.object({ prompt: z.string().min(1).max(16_000), completion: z.string().min(1).max(16_000) }).strict(),
};

/**
 * Patterns that look like credentials.
 *
 * Deliberately broad. A false positive costs someone a look at one line; a
 * false negative puts a key into training data that is copied, shared and
 * kept. Each pattern is named so the report can say what kind of thing it
 * saw without quoting it.
 */
const SECRET_PATTERNS: readonly [string, RegExp][] = [
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["slack-token", /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["assigned-secret", /\b(?:api[_-]?key|secret|password|passwd|token|bearer)\b["']?\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{16,}/i],
];

export function findSecretKinds(text: string): string[] {
  return SECRET_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([kind]) => kind);
}

export function validateJsonl(text: string, shape: DatasetShape): DatasetReport {
  const bytes = Buffer.byteLength(text, "utf8");
  const contentHash = sha256(text);
  const issues: DatasetIssue[] = [];
  let records = 0, rejected = 0, duplicates = 0, secretFindings = 0;
  const add = (line: number, code: string, message: string) => {
    if (issues.length < MAX_ISSUES) issues.push({ line, code, message });
  };

  if (bytes > MAX_DATASET_BYTES) {
    add(0, "too-large", `The file is larger than ${MAX_DATASET_BYTES / 1024 / 1024} MB.`);
    return { records, rejected, duplicates, secretFindings, issues, contentHash, bytes, passed: false };
  }

  const lines = text.split(/\r?\n/);
  if (lines.length > MAX_DATASET_LINES + 1) {
    add(0, "too-many-lines", `The file has more than ${MAX_DATASET_LINES} lines.`);
    return { records, rejected, duplicates, secretFindings, issues, contentHash, bytes, passed: false };
  }

  const seen = new Set<string>();
  const schema = shapes[shape];
  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    if (!raw.trim()) continue;
    records++;

    // Secrets are checked on the raw line, before parsing, so a line that is
    // not even valid JSON still gets scanned.
    const kinds = findSecretKinds(raw);
    if (kinds.length) {
      secretFindings++;
      rejected++;
      add(line, "secret", `Looks like a credential (${kinds.join(", ")}). Remove it before training.`);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      rejected++;
      add(line, "invalid-json", "Not a JSON object.");
      continue;
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      rejected++;
      const issue = result.error.issues[0];
      add(line, "wrong-shape", `${issue?.path.join(".") || "record"}: ${issue?.message ?? "does not match the recipe's shape"}`);
      continue;
    }

    // Exact duplicates after JSON normalization. Counted, not rejected: a
    // repeated example weakens a dataset without making it wrong.
    const key = sha256(JSON.stringify(parsed));
    if (seen.has(key)) {
      duplicates++;
      add(line, "duplicate", "Identical to an earlier record.");
    }
    seen.add(key);
  }

  if (records === 0) add(0, "empty", "The file has no records.");
  const passed = records > 0 && rejected === 0 && secretFindings === 0;
  return { records, rejected, duplicates, secretFindings, issues, contentHash, bytes, passed };
}
