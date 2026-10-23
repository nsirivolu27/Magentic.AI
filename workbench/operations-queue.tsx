import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { WorkbenchSnapshot } from "./snapshot.js";
import { filterQueue, operationsQueue, QUEUE_LABELS, type QueueFilter } from "./operations-model.js";

// Keep filters across snapshot refreshes, but never share them across identities
// or workspaces. No credentials, content or preferences go to browser storage.
let preferences: { scope: string; filter: QueueFilter; query: string } | undefined;

export function OperationsQueue({ snapshot }: { snapshot: WorkbenchSnapshot }) {
  const scope = `${snapshot.workspaceId}\0${snapshot.actor}`;
  const [filter, setFilter] = useState<QueueFilter>(preferences?.scope === scope ? preferences.filter : "all");
  const [query, setQuery] = useState(preferences?.scope === scope ? preferences.query : "");
  const items = operationsQueue(snapshot);
  const modelUnavailable = !snapshot.studio || Boolean(snapshot.studioError);
  const visible = filterQueue(items, filter, query);
  const change = (nextFilter: QueueFilter, nextQuery: string) => {
    preferences = { scope, filter: nextFilter, query: nextQuery };
    setFilter(nextFilter); setQuery(nextQuery);
  };
  const counts = (key: QueueFilter) => key === "all" ? items.length : items.filter(item => item.state === key).length;
  return <section className="operations-queue" aria-labelledby="queue-title">
    <div className="queue-heading">
      <div><p className="section-kicker">YOUR OPERATIONAL PICTURE</p><h2 id="queue-title">Work requiring attention</h2>
        <p>Prioritized by review, blockers, and the next phase of work.</p></div>
      <a className="queue-evidence-link" href="#/activity">View audit trail <span aria-hidden="true">↗</span></a>
    </div>
    <div className="queue-summary" aria-label="Current work counts">
      {(["review", "blocked", "active", "ready"] as const).map(key =>
        <button type="button" key={key} className={`queue-stat ${key}`} aria-pressed={filter === key}
          onClick={() => change(filter === key ? "all" : key, query)}>
          <span>{QUEUE_LABELS[key]}</span><strong>{counts(key)}</strong>
          <small>{key === "review" ? "Eligible for your signature" : key === "blocked" ? "Requires investigation"
            : key === "active" ? "Open workflow or training" : "A phase is ready to continue"}</small>
        </button>)}
    </div>
    {modelUnavailable && <p className="queue-data-warning" role="status">Model project data is unavailable. Counts cover only the workflow data that loaded; they do not mean all work is clear.</p>}
    <div className="queue-toolbar">
      <div className="queue-filters" role="group" aria-label="Filter work queue">
        {(Object.keys(QUEUE_LABELS) as QueueFilter[]).map(key => <button type="button" key={key}
          aria-pressed={filter === key} onClick={() => change(key, query)}>
          {QUEUE_LABELS[key]} <span>{counts(key)}</span>
        </button>)}
      </div>
      <label className="queue-search"><span className="visually-hidden">Search work queue</span>
        <span aria-hidden="true">⌕</span><input type="search" value={query} placeholder="Search work, owner, or phase"
          onChange={event => change(filter, event.target.value)} /></label>
    </div>
    <p className="queue-results" role="status" aria-live="polite">{visible.length} of {items.length} work items</p>
    <div className="queue-table-wrap" tabIndex={0} role="region" aria-label="Work queue table, scroll horizontally on small screens">
      <table className="queue-table">
        <caption className="visually-hidden">Workspace work queue. Opening an item does not approve or execute it.</caption>
        <thead><tr><th scope="col">Work item</th><th scope="col">Current phase</th><th scope="col">Status</th><th scope="col">Owner</th><th scope="col"><span className="visually-hidden">Next action</span></th></tr></thead>
        <tbody>{visible.map(item => <tr key={item.id}>
          <td><small className="queue-kind">{item.kind}</small><a className="queue-item-title" href={item.href}>{item.title}</a><p>{item.detail}</p></td>
          <td>{item.phase}</td><td><span className={`queue-state ${item.state}`}><span aria-hidden="true">{item.state === "blocked" ? "!" : item.state === "review" ? "◇" : item.state === "active" ? "◐" : "○"}</span>{QUEUE_LABELS[item.state]}</span></td>
          <td className="queue-owner">{item.owner}</td><td><a className="queue-action" href={item.href}>{item.action} <span aria-hidden="true">→</span></a></td>
        </tr>)}</tbody>
      </table>
    </div>
    {!visible.length && <div className="queue-empty"><span aria-hidden="true">{items.length ? "⌕" : "✓"}</span>
      <h3>{items.length ? "No work matches these filters" : modelUnavailable ? "No work items in the available data" : "Nothing needs your attention"}</h3>
      <p>{items.length ? "Try a different status, owner, or search term." : "Completed work remains in its detail pages and audit trail."}</p>
      {items.length ? <button type="button" className="secondary" onClick={() => change("all", "")}>Clear filters</button>
        : snapshot.canAuthor ? <a className="primary" href="#/desk">Start a work item</a> : <a className="secondary" href="#/activity">Inspect activity</a>}
    </div>}
    <div className="queue-footnote"><span aria-hidden="true">◇</span> Review eligibility is derived from the current records. Opening an item never bypasses its approval policy.</div>
  </section>;
}

export function mountOperationsQueue(container: HTMLElement, snapshot: WorkbenchSnapshot): Root {
  const root = createRoot(container);
  root.render(<OperationsQueue snapshot={snapshot} />);
  return root;
}
