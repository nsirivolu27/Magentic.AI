import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OperationsQueue } from "../workbench/operations-queue.js";
import { memoryPipelines } from "../workbench/pipeline.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";
import type { WorkbenchSnapshot } from "../workbench/snapshot.js";

const base = (): WorkbenchSnapshot => ({ workspaceId: "w", actor: "owner", roles: ["author", "admin"], canAuthor: true, workflow: DEFAULT_WORKFLOW, records: [], audit: [], demo: false,
  pipelines: memoryPipelines().snapshot("w"), chat: { configured: false, model: "" } } as unknown as WorkbenchSnapshot);

test("a workspace with no runs and no projects shows first steps, not an all clear", () => {
  const html = renderToStaticMarkup(createElement(OperationsQueue, { snapshot: base() }));
  assert.match(html, /Nothing here yet/);
  assert.match(html, /Connect a model/); assert.match(html, /Start a workflow run/); assert.match(html, /Create a model project/);
  assert.doesNotMatch(html, /Nothing needs your attention/);
});

test("a read only viewer of an empty workspace is not told to set things up", () => {
  const viewer = { ...base(), roles: ["viewer"], canAuthor: false } as unknown as WorkbenchSnapshot;
  const html = renderToStaticMarkup(createElement(OperationsQueue, { snapshot: viewer }));
  assert.doesNotMatch(html, /Nothing here yet/);
  assert.match(html, /Inspect activity/);
});
