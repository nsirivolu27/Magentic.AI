import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Role } from "../registry/roles.js";
import { atomicJson, digest } from "./bot-project.js";
import { PipelineError, type PipelineEngine } from "./pipeline.js";
import { StudioError, type ModelStudio } from "./studio/engine.js";
import { StudioStorageError } from "./studio/store.js";
import { findSecretKinds } from "./studio/dataset.js";
import { recipeFor, type DatasetShape } from "./studio/recipes.js";

/**
 * The documentation portal.
 *
 * Any document a person gives the workspace is stored once, by content
 * hash, and connects to the LLM workspace in two ways from that one copy:
 * attached to a running workflow as the reference material its stage
 * prompts carry, or added to an assistant's project as a dataset in the
 * shape the recipe wants. Both are the ordinary engine commands, run as the
 * person, so the audit trail reads as if they had done it by hand.
 *
 * Secrets are counted at add time and never shown; a document with a
 * finding is kept (so the person can see it and remove it) but is refused
 * everywhere it would reach a prompt or a dataset. Adding a document never
 * trains, releases or approves anything.
 */

export const MAX_DOCUMENT_CHARS = 200_000;
const MATERIAL_CHARS = 6_000;
const EXCERPT_CHARS = 300;

export const documentSchema = z.object({
  id: z.string().uuid(), workspaceId: z.string().min(1), title: z.string().trim().min(1).max(120),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().min(0),
  /** How many lines looked like a credential. The lines themselves are never recorded. */
  secretFindings: z.number().int().min(0),
  /** The first few hundred characters, for lists. The content lives in the store. */
  excerpt: z.string().max(EXCERPT_CHARS),
  addedBy: z.string().min(1), addedAt: z.string(),
  /** Workflow runs this document was attached to and datasets made from it. */
  runs: z.array(z.string().uuid()), datasets: z.array(z.string().uuid()),
}).strict();
export type DocumentRecord = z.infer<typeof documentSchema>;
export const documentStateSchema = z.object({ documents: z.array(documentSchema) }).strict();
export type DocumentState = z.infer<typeof documentStateSchema>;

export const documentCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add_document"), title: z.string().trim().min(1).max(120), text: z.string().max(MAX_DOCUMENT_CHARS) }).strict(),
  z.object({ action: z.literal("remove_document"), documentId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("attach_to_run"), documentId: z.string().uuid(), runId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("add_to_project"), documentId: z.string().uuid(), projectId: z.string().uuid() }).strict(),
]);
export type DocumentCommand = z.infer<typeof documentCommandSchema>;

export class DocumentError extends Error { constructor(readonly status: number, message: string) { super(message); } }

/** Where document content and the index live: in memory for the demo, on disk for the local application. */
export interface DocumentStore {
  readState(workspace: string): DocumentState | undefined;
  commitState(workspace: string, state: DocumentState): void;
  /** Store content by hash; storing the same text twice is one copy. */
  putContent(hash: string, text: string): void;
  getContent(hash: string): string | undefined;
}

export function memoryDocumentStore(): DocumentStore {
  const states = new Map<string, DocumentState>();
  const contents = new Map<string, string>();
  return {
    readState: (workspace) => states.get(workspace) ? structuredClone(states.get(workspace)!) : undefined,
    commitState: (workspace, state) => { states.set(workspace, structuredClone(state)); },
    putContent: (hash, text) => { contents.set(hash, text); },
    getContent: (hash) => contents.get(hash),
  };
}

/** `<directory>/<workspace digest>.json` for the index, `<directory>/content/<hash>.txt` for the text. Atomic index writes. */
export function fileDocumentStore(directory: string): DocumentStore {
  const contentDir = join(directory, "content");
  mkdirSync(contentDir, { recursive: true });
  const indexFor = (workspace: string) => join(directory, `${digest(workspace)}.json`);
  return {
    readState(workspace) {
      try { return documentStateSchema.parse(JSON.parse(readFileSync(indexFor(workspace), "utf8"))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    },
    commitState: (workspace, state) => atomicJson(indexFor(workspace), state),
    putContent(hash, text) {
      const file = join(contentDir, `${hash}.txt`);
      if (!existsSync(file)) writeFileSync(file, text, { encoding: "utf8", mode: 0o600 });
    },
    getContent(hash) {
      try { return readFileSync(join(contentDir, `${hash}.txt`), "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    },
  };
}

/**
 * Turn a document into dataset records in the shape a recipe wants. One
 * record per paragraph or numbered section, each carrying the document
 * title so an answer can say where it came from. The wording is the
 * document's own; nothing is paraphrased.
 */
export function documentRecords(title: string, text: string, shape: DatasetShape): string[] {
  const parts = text.split(/\n\s*\n|\n(?=\s*\d+[.)]\s)/).map((part) => part.replace(/\s+/g, " ").trim()).filter((part) => part.length >= 20);
  return parts.map((part, index) => {
    const label = `${title}, part ${index + 1} of ${parts.length}`;
    return shape === "prompt-completion"
      ? JSON.stringify({ prompt: `Reference ${label}`, completion: part })
      : JSON.stringify({ messages: [{ role: "user", content: `${label}: what does it say?` }, { role: "assistant", content: part }] });
  });
}

export interface DocumentsOptions {
  store: DocumentStore;
  studio?: ModelStudio;
  pipelines?: PipelineEngine;
  now?: () => string;
  /** The approval policy the studio command runs under when a dataset is registered. */
  requiredApprovals?: number;
}
export interface DocumentsEngine {
  snapshot(workspace: string): DocumentState;
  /** The stored text of one document. Throws when it is unknown or removed. */
  content(workspace: string, documentId: string): string;
  execute(workspace: string, actor: string, roles: readonly Role[], raw: unknown): DocumentState;
}

const MAX_DOCUMENTS = 200;

export function createDocuments(options: DocumentsOptions): DocumentsEngine {
  const now = options.now ?? (() => new Date().toISOString());
  const approvals = options.requiredApprovals ?? 2;
  const states = new Map<string, DocumentState>();

  function state(workspace: string): DocumentState {
    let value = states.get(workspace);
    if (!value) { value = options.store.readState(workspace) ?? { documents: [] }; states.set(workspace, value); }
    return value;
  }
  function save(workspace: string): DocumentState {
    const value = state(workspace);
    options.store.commitState(workspace, value);
    return structuredClone(value);
  }
  function find(workspace: string, documentId: string): DocumentRecord {
    const doc = state(workspace).documents.find((item) => item.id === documentId);
    if (!doc) throw new DocumentError(404, "Document not found in this workspace.");
    return doc;
  }
  function usableContent(doc: DocumentRecord): string {
    if (doc.secretFindings > 0) throw new DocumentError(409, `"${doc.title}" has ${doc.secretFindings} line${doc.secretFindings === 1 ? "" : "s"} that look like a credential. Remove the secret and add it again before using it.`);
    const text = options.store.getContent(doc.contentHash);
    if (text === undefined) throw new DocumentError(404, "The document's content is missing from the store.");
    return text;
  }

  return {
    snapshot: (workspace) => structuredClone(state(workspace)),
    content(workspace, documentId) {
      const text = options.store.getContent(find(workspace, documentId).contentHash);
      if (text === undefined) throw new DocumentError(404, "The document's content is missing from the store.");
      return text;
    },
    execute(workspace, actor, roles, raw) {
      const parsed = documentCommandSchema.safeParse(raw);
      if (!parsed.success) throw new DocumentError(400, parsed.error.issues[0]?.message ?? "Invalid document command.");
      const command = parsed.data;
      const admin = roles.includes("admin");
      const author = admin || roles.includes("author");
      const value = state(workspace);

      switch (command.action) {
        case "add_document": {
          if (!author) throw new DocumentError(403, "Only an author or admin can add a document.");
          const text = command.text.replace(/\r\n/g, "\n");
          if (!text.trim()) throw new DocumentError(400, "The document is empty.");
          if (value.documents.length >= MAX_DOCUMENTS) throw new DocumentError(409, "This workspace holds the maximum number of documents. Remove one first.");
          const lines = text.split("\n");
          const clean = lines.filter((line) => findSecretKinds(line).length === 0);
          const secretFindings = lines.length - clean.length;
          const contentHash = digest(text);
          options.store.putContent(contentHash, text);
          // The excerpt is built from the clean lines only, so a credential never reaches a list or a snapshot.
          value.documents.push({ id: randomUUID(), workspaceId: workspace, title: command.title, contentHash, bytes: Buffer.byteLength(text, "utf8"),
            secretFindings, excerpt: clean.join(" ").replace(/\s+/g, " ").trim().slice(0, EXCERPT_CHARS), addedBy: actor, addedAt: now(), runs: [], datasets: [] });
          return save(workspace);
        }
        case "remove_document": {
          const doc = find(workspace, command.documentId);
          if (!admin && doc.addedBy !== actor) throw new DocumentError(403, "Only the person who added a document, or an admin, can remove it.");
          // Runs and datasets keep their own copies; only the portal entry goes.
          value.documents = value.documents.filter((item) => item.id !== doc.id);
          return save(workspace);
        }
        case "attach_to_run": {
          if (!options.pipelines) throw new DocumentError(404, "Workflows are not configured.");
          const doc = find(workspace, command.documentId);
          const text = usableContent(doc);
          const run = options.pipelines.snapshot(workspace).runs.find((item) => item.id === command.runId);
          if (!run) throw new DocumentError(404, "Run not found in this workspace.");
          if (!admin && run.owner !== actor) throw new DocumentError(403, "The run owner or an admin must attach reference material.");
          if (doc.runs.includes(run.id)) return structuredClone(value);
          const existing = (run.materials ?? []).filter((item) => item.id !== doc.id);
          if (existing.length >= 8) throw new DocumentError(409, "This run already carries eight reference documents.");
          const material = { id: doc.id, title: doc.title, content: text.length > MATERIAL_CHARS ? `${text.slice(0, MATERIAL_CHARS - 1)}…` : text };
          try {
            options.pipelines.execute(workspace, actor, roles, { action: "materials", runId: run.id, expectedRevision: run.revision, materials: [...existing, material] }, approvals);
          } catch (error) {
            if (error instanceof PipelineError) throw new DocumentError(error.status, error.message);
            throw error;
          }
          doc.runs.push(run.id);
          return save(workspace);
        }
        case "add_to_project": {
          if (!options.studio) throw new DocumentError(404, "Model Studio is not configured.");
          const doc = find(workspace, command.documentId);
          const text = usableContent(doc);
          const studio = options.studio.snapshot(workspace);
          const project = studio.projects.find((item) => item.id === command.projectId);
          if (!project) throw new DocumentError(404, "Project not found in this workspace.");
          const name = `${doc.title} (document)`;
          const already = studio.datasets.find((item) => item.projectId === project.id && doc.datasets.includes(item.id));
          if (already) throw new DocumentError(409, `This document is already the dataset "${already.name}" on ${project.name}.`);
          const records = documentRecords(doc.title, text, recipeFor(project.recipeId).datasetShape);
          if (!records.length) throw new DocumentError(400, "The document has no paragraph long enough to become a record.");
          try {
            const registered = options.studio.execute(workspace, actor, roles, { action: "register_dataset", projectId: project.id, name, source: { kind: "inline", text: records.join("\n") } }, approvals);
            const dataset = registered.datasets.find((item) => item.projectId === project.id && item.name === name && !studio.datasets.some((before) => before.id === item.id));
            if (!dataset) throw new DocumentError(500, "The dataset was not registered.");
            options.studio.execute(workspace, actor, roles, { action: "validate_dataset", datasetId: dataset.id }, approvals);
            doc.datasets.push(dataset.id);
          } catch (error) {
            if (error instanceof StudioError || error instanceof StudioStorageError) throw new DocumentError(409, error.message);
            throw error;
          }
          return save(workspace);
        }
      }
    },
  };
}
