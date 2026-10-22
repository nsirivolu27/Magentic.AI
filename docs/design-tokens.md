# Design tokens

The workbench is styled by three sheets loaded in order: `styles.css` (layout
and base components), `theme.css` (legacy variables) and `agency.css`, the
theme overlay loaded last. Every colour, radius, control height and motion
value a page needs is a custom property on `:root` in `agency.css`. New pages
use the tokens below and never a literal colour.

## Surfaces

| Token | Value | Use |
|---|---|---|
| `--bg` | #0b0b0f | Page background and the top bar |
| `--surface` | #121218 | Panels, cards, table headers |
| `--raised` | #1a1a23 | Hover rows, nested blocks, secondary buttons |
| `--input` | #0e0e13 | Inputs, code and preformatted text |
| `--line` | #22222c | Hairlines and dividers |
| `--line-strong` | #2e2e3a | Number badges, stronger dividers |
| `--border-strong` | #42424f | Input and secondary button borders |

The navigation has its own set (`--nav-bg`, `--nav-surface`, `--nav-raised`,
`--nav-line`, `--nav-border`, `--nav-text`, `--nav-text-2`, `--nav-text-3`,
`--nav-accent`, `--nav-active`) with the same values, so the sidebar can be
re-tinted on its own later.

## Text

| Token | Value | Contrast on `--surface` | Use |
|---|---|---|---|
| `--text` | #ededf2 | 16.8:1 | Body copy, headings |
| `--text-2` | #b0b0bf | 8.7:1 | Secondary copy, labels in forms |
| `--text-3` | #8a8a9a | 5.5:1 | Kickers, meta lines, footnotes. Lowest ratio in the product; stays above 5:1 on every surface it is used on |

## Brand

| Token | Value | Use |
|---|---|---|
| `--brand-primary` | #6457e0 | Primary buttons, selected borders, active node glow. White on it is 5.3:1 |
| `--brand-hover` | #7c6cf0 | Primary button hover |
| `--brand-link` | #b3a7ff | Links, focus ring, active navigation text (8.8:1) |
| `--brand-soft` | #1b1933 | Selected backgrounds, hover on secondary buttons |
| `--brand-border` | #3b3577 | Borders on selected and active elements |
| `--brand-selection` | #2b2660 | Text selection |
| `--brand-pink`, `--brand-pink-soft` | #e07ac4, #2a1a26 | The diamond brand mark only |

`--accent`, `--accent-strong`, `--accent-soft`, `--info`, `--info-soft` and
`--focus` alias the brand tokens so older rules in `styles.css` pick up the
theme without edits.

## State

Each state has a text colour, a soft background and a line. Pills use all
three; text alone uses the first.

| State | Text | Soft | Line | Meaning |
|---|---|---|---|---|
| ok | `--ok` #6fd3a0 | `--ok-soft` | `--ok-line` | Done, approved, connected, ready |
| warn | `--warn` #e9c46a | `--warn-soft` | `--warn-line` | Awaiting approval, credentials needed, blocked by a person |
| bad | `--bad` #f58a98 | `--bad-soft` | `--bad-line` | Failed, cancelled, error |
| accent | `--brand-link` | `--brand-soft` | `--brand-border` | Running, in progress, current step |
| neutral | `--text-2` | `--raised` | `--line` | Not started, not connected, not assigned, no gate |

Pill text sits between 7.4:1 and 9.3:1 on its soft background.

## Shape and motion

| Token | Value | Use |
|---|---|---|
| `--radius` | 6px | Buttons, inputs, pills, small cards |
| `--radius-lg` | 10px | Panels and large cards |
| `--control-h` | 36px | Buttons, inputs, selects |
| `--shadow` | inset highlight plus 24 px drop | Raised panels only |
| `--ease` | 140 ms, ease out | Every transition; the only looping animation is the running mark |
| `--sidebar`, `--content-max` | 250px, 1580px | Layout widths |

`prefers-reduced-motion: reduce` turns off every animation and transition.

## Literal colours that remain, on purpose

`agency.css` keeps seven literal values: white on the primary button, the
blurred top bar (`#0b0b0fcc`), the brand mark border, the focus halo on inputs
(`#6457e040`, the primary at 25 percent), the inset highlight on panels, the
table hover tint (`#ffffff05`) and the navigation backdrop on narrow screens
(`#000000a6`). They are translucent overlays or white, which have no token of
their own. `styles.css` and `theme.css` still carry their original literals;
`agency.css` overrides the ones a page can see, and new rules go in
`agency.css`.

## Checking a change

Measured on the rendered pages, not from this table: the contrast script in
the UI checks walks every text node on the main routes and reports anything
under 4.5:1 (3:1 for large text). Run it after changing a token.
