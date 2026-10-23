import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { blueprintSchema, datasetSchema, ingest, parseCsv, summarize } from "../workbench/ontology-ingest.js";

/**
 * Ingestion turns the company blueprint and its CSV files into one dataset.
 * Every check names the file, row and column, and nothing partial survives.
 */

// Tests run from the repository root, like company-ontology.test.ts.
const exampleDir = join("examples", "ontology", "company");

export function companyInput() {
  const files = new Map<string, string>();
  for (const name of readdirSync(join(exampleDir, "data"))) files.set(name, readFileSync(join(exampleDir, "data", name), "utf8"));
  return { blueprint: JSON.parse(readFileSync(join(exampleDir, "blueprint.json"), "utf8")) as unknown, files, now: new Date("2026-10-21T00:00:00Z") };
}

test("the CSV reader handles quotes, doubled quotes, CRLF and a byte order mark", () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n1,"x, y"\r\n2,"say ""hi"""\n'), [["a", "b"], ["1", "x, y"], ["2", 'say "hi"']]);
  assert.deepEqual(parseCsv("a,b\n1,\n"), [["a", "b"], ["1", ""]]);
  assert.throws(() => parseCsv('a\n"open'), /quoted field/);
});

test("the company example ingests with lineage, typed values, nulls and resolved links", () => {
  const dataset = ingest(companyInput());
  assert.equal(datasetSchema.safeParse(dataset).success, true);
  assert.equal(dataset.objects.length, 6);
  assert.deepEqual(dataset.sources.map(source => [source.objectType, source.rows]), [["Company", 1], ["Workflow", 1], ["Agent", 1], ["Run", 1], ["Evidence", 1], ["Approval", 1]]);
  assert.ok(dataset.sources.every(source => /^[a-f0-9]{64}$/.test(source.sha256)));
  const workflow = dataset.objects.find(object => object.__apiName === "Workflow")!;
  assert.equal(workflow.version, 1);
  const approval = dataset.objects.find(object => object.__apiName === "Approval")!;
  assert.equal(approval.decidedAt, null);
  assert.equal(approval.__primaryKey, "demo-approval");
  assert.equal(dataset.ingestedAt, "2026-10-21T00:00:00.000Z");
  assert.match(summarize(dataset), /6 objects from 6 files/);
  assert.match(summarize(dataset), /Approval +1 rows {2}Approval\.csv {2}sha256 [a-f0-9]{16}/);
});

test("every bad row stops ingestion with the file, row and column named", () => {
  const cases: [string, (files: Map<string, string>) => void, RegExp][] = [
    ["unknown column", files => files.set("Company.csv", "companyId,name,extra\ndemo-company,Synthetic company,1\n"), /Company\.csv: column "extra" is not a property/],
    ["missing column", files => files.set("Company.csv", "companyId\ndemo-company\n"), /Company\.csv: column "name" is missing/],
    ["bad integer", files => files.set("Workflow.csv", "workflowId,companyId,name,version\ndemo-workflow,demo-company,Review,one\n"), /Workflow\.csv row 2, version: expected an integer/],
    ["bad timestamp", files => files.set("Run.csv", "runId,companyId,workflowId,agentId,status,startedAt\ndemo-run,demo-company,demo-workflow,demo-agent,not_started,yesterday\n"), /Run\.csv row 2, startedAt: expected an ISO 8601/],
    ["empty key", files => files.set("Company.csv", "companyId,name\n,Synthetic company\n"), /Company\.csv row 2: companyId is empty/],
    ["duplicate key", files => files.set("Company.csv", "companyId,name\ndemo-company,A\ndemo-company,B\n"), /Company\.csv row 3: duplicate companyId "demo-company"/],
    ["dangling link", files => files.set("Agent.csv", "agentId,companyId,name,model,releaseId,status\ndemo-agent,other-company,Reviewer,m,r,draft\n"), /Agent "demo-agent" links to Company "other-company" through company, which does not exist/],
    ["missing file", files => files.delete("Evidence.csv"), /Evidence\.csv: missing/],
    ["ragged row", files => files.set("Company.csv", "companyId,name\ndemo-company\n"), /Company\.csv row 2: 1 values for 2 columns/],
  ];
  for (const [name, change, expected] of cases) {
    const input = companyInput(); change(input.files);
    assert.throws(() => ingest(input), expected, name);
  }
});

test("links must stay within one scope value when the blueprint names a scope property", () => {
  const input = companyInput();
  input.files.set("Company.csv", "companyId,name\ndemo-company,Synthetic company\nother-company,Other\n");
  input.files.set("Run.csv", "runId,companyId,workflowId,agentId,status,startedAt\ndemo-run,other-company,demo-workflow,demo-agent,not_started,2026-01-01T00:00:00Z\n");
  assert.throws(() => ingest(input), /Run "demo-run" links to Workflow "demo-workflow" in a different companyId/);
});

test("the blueprint is checked before any file is read", () => {
  const base = companyInput().blueprint as { objectTypes: { apiName: string; primaryKey: string; links: { targetType: string }[] }[] };
  const badKey = structuredClone(base); badKey.objectTypes[0]!.primaryKey = "missing";
  assert.throws(() => blueprintSchema.parse(badKey), /primary key must be one of the properties/);
  const badTarget = structuredClone(base); badTarget.objectTypes[1]!.links[0]!.targetType = "Nowhere";
  assert.throws(() => blueprintSchema.parse(badTarget), /Target must be an object type/);
  assert.throws(() => ingest({ blueprint: { version: 2 }, files: new Map() }), /Blueprint: version/);
});
