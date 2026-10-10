# Internal-operator interface

The workbench opens on a prioritized work queue instead of a collection of
dashboard panels. Its navigation separates operations, assurance, and
configuration. This is an incremental interface migration, not a new backend.

## Implementation

- `operations-model.ts` derives queue rows from loaded workspace records:
  pending releases, active training jobs, incomplete model projects, stopped
  learning schedules, and open workflow runs. Reviews and blockers sort first.
- `operations-queue.tsx` supplies the React/TypeScript queue, status filters,
  search, source-derived counts, and empty/unavailable states.
- The existing feature views and object maps remain in place. Browser rendering
  unmounts the React root before replacing its host, and filters survive refresh
  only within the current in-memory workspace/actor scope.
- `agency.css` is the final visual layer over legacy feature sheets. It supplies
  a light work surface, navy navigation, explicit state labels, visible focus,
  reduced-motion/forced-color support, and a keyboard-contained mobile drawer.
- Workflow-run URLs use `#/desk/<run-id>`. Legacy `#/tasks/<run-id>` links resolve
  to the same run; missing records do not silently open another record.

The queue offers navigation, not approval or execution shortcuts. Release
eligibility uses the existing release policy helper; workflow review eligibility
uses the existing task helper. Backend authorization, revision/hash checks, MCP
contracts, and execution gates are unchanged. Record-specific self-approval
exceptions are disclosed rather than represented as independent-review assurance.

The environment banner distinguishes synthetic demo data from local records,
and local mode warns that remote model providers may receive inputs. Local
storage is not a claim that all processing stays on the device. The existing
demo identity switcher is not production authentication.

## Preview and verification

Use the package manager pinned in `package.json`:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm build:workbench
corepack pnpm demo:workbench
```

The demo binds to loopback at `http://127.0.0.1:4173`. To run checks:

```sh
corepack pnpm typecheck
corepack pnpm test
corepack pnpm exec playwright install chromium
corepack pnpm test:ui
```

Browser tests start disposable demo and local servers on ports 4173 and 4174.
They cover search/filter refresh, work-item creation, exact/deprecated/missing
deep links, existing feature navigation, keyboard skip/focus behavior, mobile
overflow, and the local workspace/session disclosure. The two queue views
(desktop and mobile) are audited with axe-core's WCAG A/AA rules. These automated
checks are not a manual accessibility audit or a Section 508 certification.

On constrained hosts, `PLAYWRIGHT_CHROMIUM_EXECUTABLE` may select a supplied
Chromium. `PLAYWRIGHT_LOW_MEMORY=1` adds single-process testing flags; run test
names individually with `--grep` in that mode to avoid sharing browser contexts.
These options affect tests only, not application behavior.

The untouched base commit had four failing unit tests. This change restores
workflow review attention/legacy routing; three pre-existing failures remain:
the workflow-stage settings label/template test and two scheduled-document
reference-context tests. They are outside this visual migration and should be
tracked before a production release. Optional LangChain provider tests require
their separate adapters; no live agency/model-provider integration is validated
by these interface tests.

## Federal deployment boundary

The design is informed by USWDS principles; it does not import USWDS components
or use official government branding. It makes no FedRAMP, ATO, FISMA, data
classification, retention, or accessibility-certification claim. Agency-specific
identity, permissions, records policy, hosting accreditation, and manual
accessibility validation must be designed and verified separately before use with
sensitive or production agency data.
