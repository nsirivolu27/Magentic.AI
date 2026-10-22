# Internal-operator interface

The Workspace view opens on a prioritized work queue. The top-bar Services
menu searches operations, assurance and configuration without a permanent
sidebar. This is an incremental interface migration, not a new backend.

## Team console

- Work: personal or team queues, with reviews and blockers first.
- Agents: saved configurations and assistants, with their assigned stages.
- Tools: searchable services for building, connecting and coordinating work.
- Workflows: stage assignments, models, execution limits and review gates;
  open the canvas to assemble stages or the stage editor to adjust settings.
- Readiness: refresh or export configuration checks before a supervised run.
  Passing these checks does not deploy infrastructure or prove live execution.
- Access: current identity, roles and company membership management. Local
  mode remains a local owner; it does not simulate a company directory.

The Services menu filters existing navigation links, preserves permission-hidden
entries, supports Escape and keyboard focus containment, and closes on selection.
Console tabs use shareable addresses under `#/workspace?tab=...`.
Existing runs retain their saved configuration when the workflow is edited.

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
  a light work surface, Accenture-purple accents, near-black violet navigation,
  explicit state labels, visible focus,
  reduced-motion/forced-color support, and a keyboard-contained Services menu.
- Workflow-run URLs use `#/desk/<run-id>`. Legacy `#/tasks/<run-id>` links resolve
  to the same run; missing records do not silently open another record.
- Admin stage settings preserve unsaved instructions, context, staffing, and
  checked/unchecked review gates across navigation and refresh. Saves use the
  existing configure command; other stages and already-open runs stay unchanged.
- Scheduled stage prompts receive the exact saved reference excerpts as JSON
  data, with requested stage context. Source URLs remain explicitly unfetched;
  references cannot grant tools or change human approval requirements.

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
overflow, local workspace/session disclosure, and per-stage settings (drafts,
admin authorization, saving, and existing-run policy snapshots). The two queue views
(desktop and mobile) are audited with axe-core's WCAG A/AA rules. These automated
checks are not a manual accessibility audit or a Section 508 certification.

On constrained hosts, `PLAYWRIGHT_CHROMIUM_EXECUTABLE` may select a supplied
Chromium. `PLAYWRIGHT_LOW_MEMORY=1` adds single-process testing flags; run test
names individually with `--grep` in that mode to avoid sharing browser contexts.
These options affect tests only, not application behavior.

Regression coverage includes the previously incomplete stage-settings form,
missing scheduled reference/context inputs, and the Node 22 HTTP teardown
cancellations. Oversized uploads still enforce the one-million-byte cap while
preserving the 413 response; remaining input is discarded without buffering and
the connection closes. Tests check the response body and a subsequent health
request, without disabling authentication or relaxing the body limit.

Optional LangChain provider tests require their separate adapters. No live
agency/model-provider integration is validated by these interface tests. The
latest GitHub Actions result on the pull request is the authoritative CI status;
local browser checks do not replace it.

## Federal deployment boundary

The design is informed by USWDS principles; it does not import USWDS components
or use official government branding. It makes no FedRAMP, ATO, FISMA, data
classification, retention, or accessibility-certification claim. Agency-specific
identity, permissions, records policy, hosting accreditation, and manual
accessibility validation must be designed and verified separately before use with
sensitive or production agency data.

## Agent Studio

Agent Studio lives under Configuration at `#/agent-studio`; older `#/team`
links resolve there. It shows the current workflow staffing and reusable agents.
An admin can create an agent from a job template, choose its model and explicit
repository read tools, save it, and assign a copy to a stage for future runs.
The existing versioned pipeline command enforces roles and refuses stale saves.
Unsaved tool choices and their original version survive navigation.

Import creates a new identity; export copies only the saved definition. Neither
grants execution rights or produces an approved release. Running workflows,
review gates and Model Studio release signatures retain their existing rules.
Repository execution requires local mode with an attached repository and a
configured model. The sample-data preview demonstrates configuration only.
