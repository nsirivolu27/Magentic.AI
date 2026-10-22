# UI components

The reference for adding a page to the workbench. Every component below is a
plain HTML pattern produced by a view function in `workbench/*-view.ts` and
styled by `styles.css` with the theme overlay in `agency.css`. Colours come
from the tokens in `design-tokens.md`. The helpers live in `workbench/ui.ts`.

## Buttons

| Class | Use | States |
|---|---|---|
| `.primary` | The one action the page is for | hover darkens, active shifts 1 px, `disabled` dims; add `title` with the reason when disabled |
| `.secondary`, `.btn` | Other actions | raised surface, hover tints to brand soft |
| `.quiet` | Inline, low weight actions (remove, edit) | hover tints, no border |

All buttons are 36 px tall, 6 px radius, and show a 3 px focus ring on
keyboard focus only. A link styled as a button uses the same classes.

## Status pill

`status(tone, text)` renders `<span class="status status-<tone>">` with a
mark (✓ ! ✗ • ● ○ ◐) that carries the meaning next to the colour. Tones: ok,
warn, bad, info, accent, neutral, progress (progress spins). Use a pill for a
state, never for a verb.

## Panels and cards

| Class | Use |
|---|---|
| `.panel` with `.panel-head` and `.panel-body` | A titled block; the head may carry a count or a pill |
| `.flow-row` | One project or run as a row with its chain |
| `.agent-studio-card` | One saved agent in the library |
| `.stage-card` (inside `.stage-guide`) | One Model Studio stage; state class on the `li`, `aria-current="step"` on the link |
| `.review-block` (inside `.review-grid`) | Evidence, Original output, Handoff, Approval |
| `.queue-stat` | A number with a label on the work queue |

Cards use `--surface`, a `--line` border and `--radius-lg`; a selected card
uses `--brand-primary` for the border and the glow.

## Forms

`<label class="field">Label<input></label>`; the label text sits above the
control, `small` under it for help. Inputs use `--input` background and
`--border-strong`; focus shows the brand border and a halo. Group related
fields in `.form-grid`. Disabled fieldsets (`<fieldset disabled>`) are how a
read only viewer sees a form.

## Tables

`table(columns, rows, options)` renders `.table-wrap > .table`. Each cell
carries `data-label` with its column name, so under 600 px a row becomes a
card of label and value pairs; pass `scroll: true` for a table that must keep
scrolling sideways. Clickable rows carry `data-href` and always contain a
real link for the keyboard. The work queue uses `.queue-table` with the same
narrow rule.

## Alerts and notices

| Class | Use |
|---|---|
| `.callout`, with `.warn`, `.bad`, `.ok` | A short message inside a block, with a bold lead |
| `.chat-setup.warn` | A setup state with numbered steps (for example Ollama not running) |
| `.chat-error`, `[role="alert"]` | A failure the person must read now |
| `.empty` via `empty(text, action)` | Nothing here yet, with the one action that changes that |
| `hint(text)` | Quiet guidance under a heading |

Use warn for a state the person can resolve by setup, bad only for a failure.

## Rails and graphs

`graph(nodes, selected)` renders `.graph` with `.node` and `.wire` items for
stage and phase chains. The rail scrolls sideways; under 600 px it fades on
the right and snaps per node. The active node mark spins while something runs.

## Navigation

The sidebar `.nav` entries carry `data-route` and get `aria-current` from the
router. Agent Studio pages use `.agent-studio-nav` tabs; Model Studio uses the
`.stage-guide` rail. On every route change focus moves to `#title`.

## The seven states every page must show

Loading, empty, error, not connected, not assigned, blocked, awaiting
approval. Not connected, not assigned and blocked are neutral or warn pills
with the one step that resolves them; awaiting approval shows k of n and who
can act; error uses `role="alert"` and keeps the retry control available.

## Adding a page

1. Write the view as a function returning `{ title, context?, actions?, body }`.
2. Build with the helpers above; add a class to `agency.css` only when no
   component fits, using tokens.
3. Check 1440 and 360 widths, keyboard order, and the seven states.
4. Add a test under `tests/` that renders the view for each state.
