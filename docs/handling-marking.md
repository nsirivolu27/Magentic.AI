# Handling marking

Agencies that handle controlled unclassified information mark every screen
and every export that carries it. Magentic shows one marking per deployment,
set by the operator, at the top and bottom of every page and at the top and
bottom of every audit package.

## Set it

Windows PowerShell, before starting the workbench:

```powershell
$env:MAGENTIC_HANDLING_MARKING = 'CUI//SP-PRVCY'
corepack pnpm local:workbench
```

On the company server, put the same setting in the service environment. The
value is read once at start. Upper case letters, digits, spaces and the
separators `/ ( ) - ,` are accepted, up to 80 characters; anything else stops
the server with the setting name and the reason. No setting means no banner.

## Where it appears

- Every page: a banner above the top bar and one below the content, both
  labelled for screen readers.
- The workspace snapshot (`GET /api/workspace`) as `handling`, so other
  clients can show it.
- Every audit package, JSON and Markdown. The value is part of the package
  hash, so a marking added or removed after export fails verification.

## What it does not do

The marking is a label. It does not change who can read the workspace, what
a model receives, or where data is stored. Those controls are described in
`federal-readiness.md`.
