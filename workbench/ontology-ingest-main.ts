import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { IngestError, blueprintSchema, ingest, summarize } from "./ontology-ingest.js";

/**
 * ontology:ingest --blueprint <file> --data <folder> --out <file>
 *
 * Reads <Type>.csv for every object type in the blueprint, checks every row,
 * and writes one dataset file. Nothing is written when any check fails.
 */

export const DATASET_LIMIT = 4_000_000;

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new IngestError(`Missing --${name}. Usage: ontology:ingest --blueprint <file> --data <folder> --out <file>`);
  return resolve(value);
}

try {
  const blueprintPath = argument("blueprint"), dataDir = argument("data"), outPath = argument("out");
  const blueprint = blueprintSchema.parse(JSON.parse(readFileSync(blueprintPath, "utf8")));
  const files = new Map<string, string>();
  for (const type of blueprint.objectTypes) {
    const file = join(dataDir, `${type.apiName}.csv`);
    if (!existsSync(file)) throw new IngestError(`${type.apiName}.csv: not found in ${dataDir}.`);
    files.set(`${type.apiName}.csv`, readFileSync(file, "utf8"));
  }
  const dataset = ingest({ blueprint, files });
  const text = JSON.stringify(dataset, null, 2);
  if (text.length > DATASET_LIMIT) throw new IngestError(`The dataset is ${text.length} bytes; the adapter reads at most ${DATASET_LIMIT}. Ingest fewer rows or fewer properties.`);
  const temp = join(dirname(outPath), `.${Date.now()}.ingest.tmp`);
  writeFileSync(temp, text); renameSync(temp, outPath);
  console.log(summarize(dataset));
  console.log(`Wrote ${outPath}`);
} catch (error) {
  const message = error instanceof IngestError ? error.message : error instanceof Error ? error.message.slice(0, 300) : "Ingestion failed.";
  console.error(`Ingestion stopped. ${message}`);
  process.exitCode = 1;
}
