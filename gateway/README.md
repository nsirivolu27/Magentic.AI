# Magentic gateway

A Go service that fans one MCP endpoint out across several downstream MCP
servers. It exists because that fan-out is concurrent by nature: every
downstream server is an independent network call, one slow server must not hold
up the rest, and one dead server must not take the catalog down with it.

## What is here so far

`internal/mcp` is a small client for one MCP server over the streamable HTTP
transport. It handles the handshake, session header, both the JSON and the
event-stream response forms, and paginated `tools/list`.

`internal/broker` holds the downstream servers. `Refresh` asks all of them for
their tools at the same time and builds one catalog, namespacing each tool as
`server__tool` so two servers can both expose `search`. Servers that fail are
reported in `Catalog.Failures` and contribute nothing, so the catalog never
advertises a tool the gateway cannot currently reach. `Call` takes a namespaced
name and routes it to the owning server under the tool's original name.

## What is not here yet

The upstream MCP server that exposes the catalog, configuration loading, auth
to downstream servers, and a refresh loop. Those come next.

## Running the tests

    go test ./... -race
