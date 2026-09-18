# Working on lnkz-mcp

This repository provides the standalone MCP adapter over the LNKZ REST API.
Configure it through LNKZ_BASE_URL and LNKZ_API_KEY. Keep conversation storage,
authorization and business logic in LNKZ; do not import src/lnkz from another
checkout. LNKZ's embedded MCP and stdio surfaces remain part of LNKZ.

Inspect the branch, dirty diff and worktree list before editing. Preserve local
changes. Use a separate codex/ branch and worktree for independent tasks, and
reuse an existing task's checkout when continuing its work. The installed
github-management skill provides local checkout selection and launch commands.

Use the package manager pinned in package.json. For adapter code changes run
corepack pnpm typecheck, corepack pnpm test and corepack pnpm build. Inspect the
actual scripts before claiming additional verification. Keep credentials and
generated output out of commits. Build only the phase requested by the user;
MCP work does not imply authorization to build or publish a marketplace.
