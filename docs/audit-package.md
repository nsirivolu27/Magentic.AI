# Audit package

One run's chain of custody as a file an auditor can keep and check without
Magentic. Every stage's output with its hash, who produced it, who signed it,
the events in order, and the reference material with its own hashes, under a
package hash over the whole body.

## Get one

On any run, the Approval block of the output review offers two downloads:

- Markdown, for a person reading the record.
- JSON, for verification and for keeping alongside the Markdown.

Both come from `GET /api/audit-package?run=<id>&format=markdown|json`. The
caller must be a member of the run's workspace. The package contains only
what the run page already shows to that member.

## Verify one

Windows PowerShell, in the repository folder:

```powershell
corepack pnpm audit:verify .\audit-package-<id>.json
```

The command recomputes every hash from the text in the file and reports each
difference on its own line, then exits 1. It needs Node and nothing else.

What verification proves: the file is internally consistent and was not
edited after it was produced, and no signer was the run owner or the output
author. What it does not prove: that the named people were who they said
they were. Identity comes from the workspace's sign in and membership
records, which the company server keeps.

## Format

`workbench/audit-package.ts` holds the schema. The package hash is a SHA-256
over the canonical JSON of the body (keys sorted, no whitespace), so a file
that is reformatted or reordered still verifies and a file whose content
changed does not.
