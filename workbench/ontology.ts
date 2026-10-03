import { readFileSync, statSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { setting } from "../env.js";
import { materialSchema, type Material } from "./materials.js";

const apiName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/);
const primaryKey = z.string().min(1).max(200).refine(value => value !== "." && value !== ".." && !/[\u0000-\u001f]/.test(value));
const objectPolicy = z.object({ apiName, properties: z.array(apiName).min(1).max(30),
  links: z.array(z.object({ apiName, targetType: apiName }).strict()).max(10).default([]),
}).strict();
const connection = z.discriminatedUnion("mode", [
  z.object({ workspaceId: identifier, mode: z.literal("sample") }).strict(),
  z.object({ workspaceId: identifier, mode: z.literal("foundry"), ontology: identifier,
    baseUrl: z.string().url().refine(value => {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
    }, "Use an HTTPS Foundry origin without a path or credentials."),
    tokenSetting: z.string().regex(/^MAGENTIC_FOUNDRY_TOKEN(?:_[A-Z0-9]+)*$/),
    objectTypes: z.array(objectPolicy).min(1).max(30),
  }).strict(),
]);
export const ontologyConfigSchema = z.object({ version: z.literal(1), workspaces: z.array(connection).max(50) }).strict().superRefine((config, ctx) => {
  const workspaces = new Set<string>();
  config.workspaces.forEach((item, index) => {
    if (workspaces.has(item.workspaceId)) ctx.addIssue({ code: "custom", path: ["workspaces", index, "workspaceId"], message: "Duplicate workspace." });
    workspaces.add(item.workspaceId);
    if (item.mode === "sample") return;
    const names = new Set(item.objectTypes.map(type => type.apiName));
    if (names.size !== item.objectTypes.length) ctx.addIssue({ code: "custom", path: ["workspaces", index, "objectTypes"], message: "Duplicate object type." });
    item.objectTypes.forEach((type, typeIndex) => {
      if (new Set(type.links.map(link => link.apiName)).size !== type.links.length) ctx.addIssue({ code: "custom", path: ["workspaces", index, "objectTypes", typeIndex, "links"], message: "Duplicate link." });
      type.links.forEach((link, linkIndex) => {
        if (!names.has(link.targetType)) ctx.addIssue({ code: "custom", path: ["workspaces", index, "objectTypes", typeIndex, "links", linkIndex, "targetType"], message: "Target must be an allowed object type." });
      });
    });
  });
});

export const ontologyListSchema = z.object({ objectType: apiName, pageSize: z.number().int().min(1).max(10).default(5), pageToken: z.string().min(1).max(4000).optional() }).strict();
export const ontologyGetSchema = z.object({ objectType: apiName, primaryKey }).strict();
export const ontologyLinksSchema = ontologyListSchema.extend({ primaryKey, linkType: apiName }).strict();
type ObjectPolicy = z.infer<typeof objectPolicy>;
export interface OntologyCatalog { mode: "sample" | "foundry"; ontology: string; objectTypes: ObjectPolicy[] }
export interface OntologyObject {
  objectType: string; primaryKey: string; properties: Record<string, unknown>;
  source: { mode: "sample" | "foundry"; ontology: string; retrievedAt: string; url?: string };
}
export interface OntologyPage { objects: OntologyObject[]; nextPageToken?: string }
export interface OntologyReader {
  catalog(): OntologyCatalog;
  list(raw: unknown, signal?: AbortSignal): Promise<OntologyPage>;
  get(raw: unknown, signal?: AbortSignal): Promise<OntologyObject>;
  links(raw: unknown, signal?: AbortSignal): Promise<OntologyPage>;
}
export type OntologyDirectory = (workspaceId: string) => OntologyReader | undefined;
export class OntologyError extends Error {}

const sampleTypes: ObjectPolicy[] = [
  { apiName: "Service", properties: ["name", "description"], links: [{ apiName: "dependencies", targetType: "Dependency" }] },
  { apiName: "Dependency", properties: ["name", "version", "reviewStatus"], links: [] },
];
const sampleObjects = [
  { __apiName: "Service", __primaryKey: "demo-service", name: "Synthetic public-service portal", description: "Sample only. Review the dependency before proposing a maintenance task." },
  { __apiName: "Dependency", __primaryKey: "demo-library", name: "example-library", version: "1.0.0", reviewStatus: "Synthetic review request; not a real vulnerability finding." },
];

export function createOntologyDirectory(raw: unknown, readSetting: (name: string) => string | undefined = setting, fetcher: typeof fetch = fetch): OntologyDirectory {
  const config = ontologyConfigSchema.parse(raw);
  const readers = new Map<string, OntologyReader>();
  for (const configItem of config.workspaces) {
    const sample = configItem.mode === "sample";
    const catalog: OntologyCatalog = { mode: configItem.mode, ontology: sample ? "synthetic-demo" : configItem.ontology,
      objectTypes: sample ? sampleTypes : configItem.objectTypes };
    // Credentials stay in the adapter closure, never in catalog or model output.
    const token = sample ? undefined : readSetting(configItem.tokenSetting);
    if (!sample && (!token || !/^[\x21-\x7e]+$/.test(token))) throw new Error(`${configItem.tokenSetting}: set a valid Foundry bearer token locally.`);
    const origin = sample ? undefined : new URL(configItem.baseUrl).origin;
    function policy(name: string): ObjectPolicy {
      const type = catalog.objectTypes.find(item => item.apiName === name);
      if (!type) throw new OntologyError("This object type is not enabled for this workspace.");
      return type;
    }
    function objectPath(type: string, key?: string) {
      return `/api/v2/ontologies/${encodeURIComponent(catalog.ontology)}/objects/${encodeURIComponent(type)}` + (key === undefined ? "" : `/${encodeURIComponent(key)}`);
    }
    function normalize(rawObject: unknown, type: ObjectPolicy): OntologyObject {
      const parsed = z.object({ __apiName: z.literal(type.apiName), __primaryKey: z.union([z.string(), z.number()]) }).passthrough().safeParse(rawObject);
      if (!parsed.success) throw new OntologyError("Foundry returned an invalid object response.");
      const key = primaryKey.safeParse(String(parsed.data.__primaryKey));
      if (!key.success) throw new OntologyError("Foundry returned an invalid object key.");
      // Projection is enforced again locally even if a provider ignores select.
      const properties = Object.fromEntries(type.properties.filter(name => Object.hasOwn(parsed.data, name)).map(name => [name, parsed.data[name]]));
      return { objectType: type.apiName, primaryKey: key.data, properties,
        source: { mode: catalog.mode, ontology: catalog.ontology, retrievedAt: new Date().toISOString(), ...(origin ? { url: origin + objectPath(type.apiName, key.data) } : {}) } };
    }
    async function request(path: string, type: ObjectPolicy, page: { pageSize: number; pageToken?: string | undefined } | undefined, signal?: AbortSignal): Promise<unknown> {
      const url = new URL(path, origin);
      for (const property of type.properties) url.searchParams.append("select", property);
      if (page) {
        url.searchParams.set("pageSize", String(page.pageSize));
        if (page.pageToken) url.searchParams.set("pageToken", page.pageToken);
      }
      const timeout = AbortSignal.timeout(10_000);
      const boundedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        const response = await fetcher(url, { method: "GET", redirect: "error", signal: boundedSignal,
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
        if (!response.ok) { await response.body?.cancel(); throw new OntologyError(`Foundry read failed (HTTP ${response.status}). Check access and configuration.`); }
        const reader = response.body?.getReader();
        if (!reader) throw new OntologyError("Foundry returned an empty response.");
        const chunks: Uint8Array[] = []; let size = 0;
        try {
          while (true) {
            const chunk = await reader.read(); if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 128_000) throw new OntologyError("Foundry response is too large. Select fewer properties or a smaller page.");
            chunks.push(chunk.value);
          }
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch (error) {
        if (error instanceof OntologyError) throw error;
        if (boundedSignal.aborted) throw new OntologyError("Foundry read stopped or exceeded ten seconds.");
        // Upstream bodies and network errors can contain credentials or private URLs.
        throw new OntologyError("Foundry could not return valid data. Check the connection and configuration.");
      }
    }
    function pageResult(rawPage: unknown, type: ObjectPolicy): OntologyPage {
      const page = z.object({ data: z.array(z.unknown()).max(50).default([]), nextPageToken: z.string().min(1).max(4000).optional() }).safeParse(rawPage);
      if (!page.success) throw new OntologyError("Foundry returned an invalid or oversized page.");
      return { objects: page.data.data.map(item => normalize(item, type)), ...(page.data.nextPageToken ? { nextPageToken: page.data.nextPageToken } : {}) };
    }
    const reader: OntologyReader = {
      catalog: () => structuredClone(catalog),
      async list(rawInput, signal) {
        signal?.throwIfAborted();
        const input = ontologyListSchema.parse(rawInput); const type = policy(input.objectType);
        if (!sample) return pageResult(await request(objectPath(type.apiName), type, input, signal), type);
        if (input.pageToken) throw new OntologyError("The sample has no additional pages.");
        return { objects: sampleObjects.filter(item => item.__apiName === type.apiName).map(item => normalize(item, type)) };
      },
      async get(rawInput, signal) {
        signal?.throwIfAborted();
        const input = ontologyGetSchema.parse(rawInput); const type = policy(input.objectType);
        const rawObject = sample ? sampleObjects.find(item => item.__apiName === type.apiName && item.__primaryKey === input.primaryKey)
          : await request(objectPath(type.apiName, input.primaryKey), type, undefined, signal);
        if (!rawObject) throw new OntologyError("Object not found in the sample.");
        const object = normalize(rawObject, type);
        if (object.primaryKey !== input.primaryKey) throw new OntologyError("Foundry returned a different object key.");
        return object;
      },
      async links(rawInput, signal) {
        signal?.throwIfAborted();
        const input = ontologyLinksSchema.parse(rawInput); const source = policy(input.objectType);
        const link = source.links.find(item => item.apiName === input.linkType);
        if (!link) throw new OntologyError("This link is not enabled for this workspace.");
        const target = policy(link.targetType);
        if (!sample) return pageResult(await request(objectPath(source.apiName, input.primaryKey) + `/links/${encodeURIComponent(link.apiName)}`, target, input, signal), target);
        await reader.get({ objectType: input.objectType, primaryKey: input.primaryKey }, signal);
        return reader.list({ objectType: target.apiName, pageSize: input.pageSize, ...(input.pageToken ? { pageToken: input.pageToken } : {}) }, signal);
      },
    };
    readers.set(configItem.workspaceId, reader);
  }
  return workspaceId => readers.get(workspaceId);
}

export function loadOntologyDirectory(readSetting: (name: string) => string | undefined = setting): OntologyDirectory {
  const path = readSetting("MAGENTIC_ONTOLOGY_FILE");
  if (!path) return () => undefined;
  let raw: unknown;
  try {
    if (statSync(path).size > 128_000) throw new Error();
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch { throw new Error("MAGENTIC_ONTOLOGY_FILE: provide a readable JSON configuration under 128 KB."); }
  return createOntologyDirectory(raw, readSetting);
}

export function ontologyMaterial(object: OntologyObject): Material {
  const serialized = JSON.stringify(object);
  const hash = createHash("sha256").update(serialized).digest("hex");
  const content = `Ontology evidence snapshot (${object.source.mode}). SHA-256: ${hash}\n${serialized}`;
  if (content.length > 6000) throw new OntologyError("This object exceeds the reference limit. Select fewer properties in the connection configuration.");
  return materialSchema.parse({ id: randomUUID(), title: `${object.source.mode === "sample" ? "SAMPLE" : "Foundry"}: ${object.objectType} / ${object.primaryKey}`.slice(0, 120),
    content, ...(object.source.url ? { url: object.source.url } : {}) });
}
