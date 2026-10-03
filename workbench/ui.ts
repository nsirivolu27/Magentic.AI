/**
 * HTML primitives shared by every workbench page.
 *
 * Views build strings; these are the strings they build from. Keeping them
 * here means a status looks the same in a table, an attention list and a
 * context panel, and that a change to one primitive reaches every page.
 * Browser code only: no Node imports.
 */

/**
 * Hints: one plain sentence that says what a screen or step is for.
 *
 * Off by default: the pages should read on their own. The sidebar switch
 * turns them on for someone new, and the choice is remembered per browser.
 * Every hint is a sentence about the work, never about the product.
 */
let hintsOn = false;
export function setHints(on: boolean): void { hintsOn = on; }
export function hint(text: string): string {
  return hintsOn ? `<p class="hint">${escape(text)}</p>` : "";
}
/** A word a newcomer may not know, with its meaning one hover or focus away. */
export function term(word: string, meaning: string): string {
  return hintsOn ? `<span class="term" tabindex="0" title="${escape(meaning)}">${escape(word)}</span>` : escape(word);
}
export const TERMS = {
  recipe: "A ready made setup for one kind of assistant: what its training data looks like, sensible training defaults, and the checks it must pass.",
  candidate: "The model produced by the latest successful training run. It is a candidate until an evaluation passes and reviewers approve it.",
  artifact: "The output of a training run. With the development provider this is a labelled placeholder; no real model weights exist.",
  hash: "A fingerprint of the exact content. Reviewers sign the fingerprint, so if anything changes their signatures stop counting.",
  baseline: "What the candidate is compared against: the last approved release of this project, or the untrained starting point.",
  threshold: "The minimum score a metric must reach for the evaluation to pass.",
  release: "A frozen, reviewed version of a model that assistants can use once enough reviewers approve it.",
  evaluation: "A set of checks run on a candidate. It has to pass before a release can be requested.",
};

export const escape = (value: string | number | undefined | null): string =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A local date and time. */
export const when = (iso: string): string => escape(new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }));

/** "just now", "4 min ago", "3 h ago", "2 d ago", else the date. */
export function ago(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} d ago`;
  return escape(new Date(iso).toLocaleDateString());
}

/** A duration between two timestamps, for job cards. */
export function duration(from: string, to: string): string {
  const seconds = Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${seconds % 60} s`;
}

export const short = (hash: string, length = 12): string => `<code class="hash" title="${escape(hash)}">${escape(hash.slice(0, length))}</code>`;
export const percent = (value: number): string => `${Math.round(value * 100)}%`;
export const plural = (count: number, word: string, pluralWord = `${word}s`): string => `${count} ${count === 1 ? word : pluralWord}`;

// ------------------------------------------------------------------ status

export type Tone = "ok" | "warn" | "bad" | "info" | "accent" | "neutral" | "progress";
const MARKS: Record<Tone, string> = { ok: "✓", warn: "!", bad: "✗", info: "•", accent: "●", neutral: "○", progress: "◐" };

/** A status pill. The mark carries the meaning as well as the color. */
export function status(tone: Tone, text: string): string {
  const cls = tone === "progress" ? "status-accent status-progress" : `status-${tone}`;
  return `<span class="status ${cls}"><span class="status-mark" aria-hidden="true">${MARKS[tone]}</span>${escape(text)}</span>`;
}

// ------------------------------------------------------------------ tables

export interface Column { label: string; align?: "num"; hidden?: boolean; nowrap?: boolean }
export interface Row { cells: string[]; href?: string; selected?: boolean; className?: string }

export function table(columns: Column[], rows: Row[], options: { empty?: string; compact?: boolean; scroll?: boolean; label?: string } = {}): string {
  if (!rows.length && options.empty) return options.empty;
  const head = columns.map((column) => `<th scope="col"${column.align ? ` class="${column.align}"` : ""}>${column.hidden ? `<span class="visually-hidden">${escape(column.label)}</span>` : escape(column.label)}</th>`).join("");
  const body = rows.map((row) => `<tr${row.href ? ` data-href="${escape(row.href)}"` : ""}${row.selected ? ' aria-selected="true"' : ""}${row.className ? ` class="${row.className}"` : ""}>${row.cells.map((cell, index) => { const cls = [columns[index]?.align, columns[index]?.nowrap ? "nowrap" : ""].filter(Boolean).join(" "); return `<td${cls ? ` class="${cls}"` : ""}>${cell}</td>`; }).join("")}</tr>`).join("");
  return `<div class="table-wrap ${options.scroll ? "table-scroll" : ""}"><table class="table ${options.compact ? "table-compact" : ""}" ${options.label ? `aria-label="${escape(options.label)}"` : ""}><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/** The first cell of a row: a real link, so keyboards and screen readers get the destination too. */
export function cellLink(href: string, text: string, detail?: string): string {
  return `<a href="${escape(href)}">${escape(text)}</a>${detail ? `<small>${detail}</small>` : ""}`;
}

// ---------------------------------------------------------------- surfaces

export function detail(rows: [string, string][], wide = false): string {
  // A label is plain text unless it is a term() span, which is already safe HTML.
  return `<dl class="detail ${wide ? "detail-wide" : ""}">${rows.map(([label, value]) => `<div><dt>${label.startsWith('<span class="term"') ? label : escape(label)}</dt><dd>${value}</dd></div>`).join("")}</dl>`;
}

export function panel(title: string, body: string, options: { count?: string; actions?: string; id?: string } = {}): string {
  return `<section class="panel section" ${options.id ? `id="${options.id}"` : ""} aria-label="${escape(title)}"><div class="panel-head"><h2>${escape(title)}${options.count ? ` <span class="count">${escape(options.count)}</span>` : ""}</h2>${options.actions ?? ""}</div>${body}</section>`;
}

export function empty(text: string, action?: { label: string; href?: string; attrs?: string }): string {
  const button = action ? (action.href ? `<a class="btn" href="${escape(action.href)}">${escape(action.label)}</a>` : `<button class="btn" ${action.attrs ?? ""}>${escape(action.label)}</button>`) : "";
  return `<div class="empty"><p>${escape(text)}</p>${button}</div>`;
}

export function callout(tone: "ok" | "warn" | "bad" | "info", title: string, text: string): string {
  return `<p class="callout ${tone}" role="status"><strong>${escape(title)}</strong>${text}</p>`;
}

export function inlineError(text: string): string {
  return `<div class="inline-error" role="alert">${escape(text)}</div>`;
}

export function more(summary: string, body: string, open = false): string {
  return `<details class="more" ${open ? "open" : ""}><summary>${escape(summary)}</summary>${body}</details>`;
}

/** An overflow menu for secondary actions. Items are buttons with their own data attributes. */
export function menu(items: string, label = "More actions"): string {
  return items.trim() ? `<details class="menu"><summary aria-label="${escape(label)}" title="${escape(label)}">⋯</summary><div>${items}</div></details>` : "";
}

/** A primary control the user cannot use right now, with the reason beside it. */
export function disabledAction(label: string, reason: string): string {
  return `<button class="primary" disabled title="${escape(reason)}">${escape(label)}</button><span class="disabled-reason">${escape(reason)}</span>`;
}

// ------------------------------------------------------------------ phases

/** How far a project phase has come. The graph draws these as node states. */
export type StepState = "complete" | "current" | "blocked" | "failed" | "not-started";
export const STEP_STATE_LABEL: Record<StepState, string> = { complete: "Complete", current: "In progress", blocked: "Blocked", failed: "Failed", "not-started": "Not started" };

// ------------------------------------------------------------------- graph

export interface GraphNode { id: string; label: string; value: string; note: string; state: "linked" | "active" | "pending" | "blocked" | "broken"; href: string }
const NODE_MARK: Record<GraphNode["state"], string> = { linked: "✓", active: "◐", pending: "○", blocked: "!", broken: "✗" };
const NODE_WORD: Record<GraphNode["state"], string> = { linked: "connected", active: "in progress", pending: "not yet", blocked: "blocked", broken: "broken" };

/**
 * A chain of nodes joined by wires. The wire into a node takes that node's
 * state: solid green when the link holds, magenta while it is being made,
 * red when it is broken, dashed when nothing is there yet. Each node is a
 * link, so the graph is also the navigation.
 */
export function graph(nodes: GraphNode[], selected?: string, options: { compact?: boolean; label?: string } = {}): string {
  const wire = (state: GraphNode["state"], ready: boolean) => `<li class="wire ${state === "linked" ? "on" : state === "active" || ready ? "next" : state === "broken" ? "broken" : "off"}" aria-hidden="true"><svg viewBox="0 0 40 12" preserveAspectRatio="none" focusable="false"><path class="wire-line" d="M0 6H31"/><path class="wire-head" d="M30 1.5 38 6 30 10.5"/></svg></li>`;
  // The first thing waiting behind an unbroken chain is where the work is.
  const ready = nodes.findIndex((node, index) => node.state === "pending" && index > 0 && nodes[index - 1]!.state === "linked");
  const items = nodes.map((node, index) => {
    const current = node.id === selected;
    const body = `<li class="${["node", node.state, current ? "selected" : "", index === ready ? "ready" : ""].filter(Boolean).join(" ")}"><a href="${escape(node.href)}" ${current ? 'aria-current="step"' : ""}><span class="node-top"><span class="node-label">${escape(node.label)}</span><span class="node-mark" aria-hidden="true">${NODE_MARK[node.state]}</span></span><strong class="node-value" title="${escape(node.value)}">${escape(node.value)}</strong>${options.compact ? "" : `<small class="node-note">${escape(node.note)}</small>`}<span class="visually-hidden">, ${NODE_WORD[node.state]}${options.compact ? `, ${escape(node.note)}` : ""}</span></a></li>`;
    return (index ? wire(node.state, index === ready) : "") + body;
  });
  return `<ol class="${options.compact ? "graph compact" : "graph"}" aria-label="${escape(options.label ?? "Connections")}">${items.join("")}</ol>`;
}

// -------------------------------------------------------------- transitions

export function transition(from: string | undefined, to: string | undefined): string {
  if (!from && !to) return "";
  return `<span class="transition">${from ? `<b>${escape(from)}</b>` : ""}${from && to ? " → " : ""}${to ? `<b>${escape(to)}</b>` : ""}</span>`;
}
