import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Ingestion: a blueprint plus one CSV file per object type becomes one
 * dataset file that the Ontology adapter reads in "dataset" mode.
 *
 * The blueprint is the same design document a person uses to create the
 * object types in Foundry's Ontology Manager, so the local path and the
 * Foundry path share one definition. Every row is checked before anything
 * is written: unknown columns, bad types, duplicate keys and links that
 * point nowhere stop the run with the file, row and column named.
 */

const apiName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/);
const propertyType = z.enum(["string", "integer", "number", "boolean", "timestamp"]);

export const blueprintSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1).max(120),
  status: z.string().max(60).optional(),
  description: z.string().max(2000).optional(),
  /** When set, a link may only join two objects that carry the same value here (for example companyId). */
  scopeProperty: apiName.optional(),
  objectTypes: z.array(z.object({
    apiName,
    primaryKey: apiName,
    properties: z.record(apiName, propertyType),
    links: z.array(z.object({ apiName, targetType: apiName, foreignKey: apiName }).strict()).max(10).default([]),
  }).strict()).min(1).max(30),
}).strict().superRefine((blueprint, ctx) => {
  const names = new Set(blueprint.objectTypes.map(type => type.apiName));
  if (names.size !== blueprint.objectTypes.length) ctx.addIssue({ code: "custom", path: ["objectTypes"], message: "Duplicate object type." });
  blueprint.objectTypes.forEach((type, index) => {
    const path = ["objectTypes", index];
    if (!(type.primaryKey in type.properties)) ctx.addIssue({ code: "custom", path: [...path, "primaryKey"], message: "The primary key must be one of the properties." });
    if (Object.keys(type.properties).length > 30) ctx.addIssue({ code: "custom", path: [...path, "properties"], message: "At most 30 properties per object type." });
    if (new Set(type.links.map(link => link.apiName)).size !== type.links.length) ctx.addIssue({ code: "custom", path: [...path, "links"], message: "Duplicate link." });
    type.links.forEach((link, linkIndex) => {
      if (!names.has(link.targetType)) ctx.addIssue({ code: "custom", path: [...path, "links", linkIndex, "targetType"], message: "Target must be an object type in this blueprint." });
      if (!(link.foreignKey in type.properties)) ctx.addIssue({ code: "custom", path: [...path, "links", linkIndex, "foreignKey"], message: "The foreign key must be one of the properties." });
    });
    if (blueprint.scopeProperty && type.links.length && !(blueprint.scopeProperty in type.properties)) ctx.addIssue({ code: "custom", path: [...path, "properties"], message: `An object type with links must carry the scope property ${blueprint.scopeProperty}.` });
  });
});
export type Blueprint = z.infer<typeof blueprintSchema>;

const primitive = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const datasetObjectSchema = z.object({ __apiName: apiName, __primaryKey: z.string().min(1).max(200) }).catchall(primitive);
export const datasetSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1).max(120),
  ingestedAt: z.string().datetime(),
  blueprint: blueprintSchema,
  sources: z.array(z.object({ file: z.string().min(1).max(200), objectType: apiName, sha256: z.string().regex(/^[a-f0-9]{64}$/), rows: z.number().int().min(0) }).strict()).max(30),
  objects: z.array(datasetObjectSchema).max(50_000),
}).strict();
export type Dataset = z.infer<typeof datasetSchema>;
export type DatasetObject = z.infer<typeof datasetObjectSchema>;

export class IngestError extends Error {}

/** A small RFC 4180 reader: quoted fields, doubled quotes, CRLF or LF. No dependency. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let field = ""; let quoted = false;
  const input = text.startsWith("﻿") ? text.slice(1) : text;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (quoted) {
      if (char === '"') { if (input[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += char;
  }
  if (quoted) throw new IngestError("The file ends inside a quoted field.");
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(item => !(item.length === 1 && item[0] === ""));
}

function coerce(value: string, type: z.infer<typeof propertyType>, where: string): string | number | boolean {
  switch (type) {
    case "string": return value;
    case "integer": if (!/^-?\d{1,15}$/.test(value)) throw new IngestError(`${where}: expected an integer, found "${value}".`); return Number(value);
    case "number": if (!/^-?\d+(\.\d+)?$/.test(value)) throw new IngestError(`${where}: expected a number, found "${value}".`); return Number(value);
    case "boolean": if (value !== "true" && value !== "false") throw new IngestError(`${where}: expected true or false, found "${value}".`); return value === "true";
    case "timestamp": if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/.test(value) || Number.isNaN(Date.parse(value))) throw new IngestError(`${where}: expected an ISO 8601 date or timestamp, found "${value}".`); return value;
  }
}

export interface IngestInput { blueprint: unknown; files: Map<string, string>; now?: Date }

/** Turns a blueprint and the CSV text of each object type into one checked dataset. Pure: no file system. */
export function ingest(input: IngestInput): Dataset {
  const parsed = blueprintSchema.safeParse(input.blueprint);
  if (!parsed.success) throw new IngestError(`Blueprint: ${parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  const blueprint = parsed.data;
  const objects: DatasetObject[] = [];
  const sources: Dataset["sources"] = [];
  const keys = new Map<string, Set<string>>();
  for (const type of blueprint.objectTypes) {
    const file = `${type.apiName}.csv`;
    const text = input.files.get(file);
    if (text === undefined) throw new IngestError(`${file}: missing. Every object type in the blueprint needs a CSV file with this name.`);
    const rows = parseCsv(text);
    const header = rows[0];
    if (!header) throw new IngestError(`${file}: empty. The first row must list the columns.`);
    const expected = Object.keys(type.properties);
    for (const column of header) if (!expected.includes(column)) throw new IngestError(`${file}: column "${column}" is not a property of ${type.apiName}. Add it to the blueprint or remove it from the file.`);
    for (const column of expected) if (!header.includes(column)) throw new IngestError(`${file}: column "${column}" is missing.`);
    const seen = new Set<string>(); keys.set(type.apiName, seen);
    const foreignKeys = new Set(type.links.map(link => link.foreignKey));
    rows.slice(1).forEach((cells, index) => {
      const where = `${file} row ${index + 2}`;
      if (cells.length !== header.length) throw new IngestError(`${where}: ${cells.length} values for ${header.length} columns.`);
      const object: DatasetObject = { __apiName: type.apiName, __primaryKey: "" };
      header.forEach((column, cell) => {
        const value = cells[cell]!;
        const required = column === type.primaryKey || foreignKeys.has(column) || column === blueprint.scopeProperty;
        if (value === "") {
          if (required) throw new IngestError(`${where}: ${column} is empty. Keys, foreign keys and the scope property are required.`);
          object[column] = null; return;
        }
        object[column] = coerce(value, type.properties[column]!, `${where}, ${column}`);
      });
      const key = String(object[type.primaryKey]);
      if (key.length > 200 || /[\u0000-\u001f]/.test(key)) throw new IngestError(`${where}: ${type.primaryKey} must be at most 200 printable characters.`);
      if (seen.has(key)) throw new IngestError(`${where}: duplicate ${type.primaryKey} "${key}".`);
      seen.add(key); object.__primaryKey = key; objects.push(object);
    });
    sources.push({ file, objectType: type.apiName, sha256: createHash("sha256").update(text).digest("hex"), rows: rows.length - 1 });
  }
  // Links are checked after every file is read, so order in the blueprint does not matter.
  const byKey = new Map(objects.map(object => [`${object.__apiName}\u0000${object.__primaryKey}`, object]));
  for (const type of blueprint.objectTypes) for (const link of type.links) {
    for (const object of objects) {
      if (object.__apiName !== type.apiName) continue;
      const target = byKey.get(`${link.targetType}\u0000${String(object[link.foreignKey])}`);
      if (!target) throw new IngestError(`${type.apiName}.csv: ${type.apiName} "${object.__primaryKey}" links to ${link.targetType} "${String(object[link.foreignKey])}" through ${link.apiName}, which does not exist.`);
      const scope = blueprint.scopeProperty;
      if (scope && scope in target && object[scope] !== target[scope]) throw new IngestError(`${type.apiName}.csv: ${type.apiName} "${object.__primaryKey}" links to ${link.targetType} "${target.__primaryKey}" in a different ${scope}. Links must stay within one ${scope}.`);
    }
  }
  return datasetSchema.parse({ version: 1, name: blueprint.name, ingestedAt: (input.now ?? new Date()).toISOString(), blueprint, sources, objects });
}

/** One line per object type for the terminal, plus the lineage a reviewer wants to see. */
export function summarize(dataset: Dataset): string {
  const lines = dataset.sources.map(source => `${source.objectType.padEnd(16)} ${String(source.rows).padStart(6)} rows  ${source.file}  sha256 ${source.sha256.slice(0, 16)}`);
  return [`${dataset.name}: ${dataset.objects.length} objects from ${dataset.sources.length} files, ingested ${dataset.ingestedAt}`, ...lines].join("\n");
}
