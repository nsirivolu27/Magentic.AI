// Package broker fans one gateway out across several MCP servers.
//
// The gateway presents a single catalog of tools upstream. Each downstream
// server contributes its own tools, namespaced by the server's name so two
// servers can both expose a "search" tool without colliding. A call is routed
// back to whichever server owns the tool.
package broker

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/nsirivolu27/magentic-ai/gateway/internal/mcp"
)

// NameSeparator joins a server name and a tool name into a namespaced name.
// It is a character that MCP tool names do not use, so splitting is safe.
const NameSeparator = "__"

// Caller is the part of an MCP client the broker depends on. The concrete
// implementation is mcp.Client; tests substitute their own.
type Caller interface {
	Tools(ctx context.Context) ([]mcp.Tool, error)
	Call(ctx context.Context, name string, args json.RawMessage) (*mcp.CallResult, error)
}

// Server is one downstream MCP server the broker fans out to.
type Server struct {
	// Name namespaces this server's tools. It must be unique and must not
	// contain NameSeparator.
	Name   string
	Client Caller
}

// Tool is a downstream tool as the gateway presents it upstream.
type Tool struct {
	// Name is the namespaced name, for example "lnkz__save_conversation".
	Name string `json:"name"`
	// Server is which downstream server owns it.
	Server      string          `json:"server"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"inputSchema,omitempty"`
}

// ServerError records that one server failed to answer during a refresh. A
// failing server is reported rather than failing the whole catalog, because
// the other servers are still usable.
type ServerError struct {
	Server string `json:"server"`
	Err    error  `json:"-"`
}

func (e ServerError) Error() string {
	return fmt.Sprintf("server %q: %v", e.Server, e.Err)
}

// Catalog is the result of one fan-out across every server.
type Catalog struct {
	// Tools is sorted by name so the catalog is stable between refreshes.
	Tools []Tool
	// Failures lists the servers that did not answer, in server-name order.
	Failures []ServerError
}

// Broker holds the downstream servers and the most recent catalog.
type Broker struct {
	// perServerTimeout bounds how long any one server may take during a
	// refresh. One slow server must not hold up the whole fan-out.
	perServerTimeout time.Duration

	mu      sync.RWMutex
	servers []Server
	// route maps a namespaced tool name to the server that owns it.
	route   map[string]Server
	catalog Catalog
}

// New returns a broker over the given servers. A perServerTimeout of zero
// means each server is bounded only by the caller's context.
func New(servers []Server, perServerTimeout time.Duration) (*Broker, error) {
	seen := make(map[string]bool, len(servers))
	for _, server := range servers {
		if server.Name == "" {
			return nil, fmt.Errorf("server name must not be empty")
		}
		if strings.Contains(server.Name, NameSeparator) {
			return nil, fmt.Errorf("server name %q must not contain %q", server.Name, NameSeparator)
		}
		if seen[server.Name] {
			return nil, fmt.Errorf("duplicate server name %q", server.Name)
		}
		if server.Client == nil {
			return nil, fmt.Errorf("server %q has no client", server.Name)
		}
		seen[server.Name] = true
	}
	return &Broker{
		perServerTimeout: perServerTimeout,
		servers:          servers,
		route:            map[string]Server{},
	}, nil
}

// Refresh asks every server for its tools at the same time and rebuilds the
// catalog from whatever came back. Servers that fail are reported in
// Catalog.Failures and keep none of their previous tools, so the catalog never
// advertises a tool the broker cannot currently reach.
func (b *Broker) Refresh(ctx context.Context) (Catalog, error) {
	b.mu.RLock()
	servers := make([]Server, len(b.servers))
	copy(servers, b.servers)
	b.mu.RUnlock()

	type outcome struct {
		server Server
		tools  []mcp.Tool
		err    error
	}
	results := make([]outcome, len(servers))

	var wait sync.WaitGroup
	for i, server := range servers {
		wait.Add(1)
		go func() {
			defer wait.Done()
			callCtx := ctx
			if b.perServerTimeout > 0 {
				var cancel context.CancelFunc
				callCtx, cancel = context.WithTimeout(ctx, b.perServerTimeout)
				defer cancel()
			}
			tools, err := server.Client.Tools(callCtx)
			results[i] = outcome{server: server, tools: tools, err: err}
		}()
	}
	wait.Wait()

	catalog := Catalog{}
	route := make(map[string]Server)
	for _, result := range results {
		if result.err != nil {
			catalog.Failures = append(catalog.Failures, ServerError{Server: result.server.Name, Err: result.err})
			continue
		}
		for _, tool := range result.tools {
			name := result.server.Name + NameSeparator + tool.Name
			// Namespacing makes collisions between servers impossible, so a
			// duplicate here means one server listed a tool twice. Keep the
			// first and ignore the rest rather than routing unpredictably.
			if _, taken := route[name]; taken {
				continue
			}
			route[name] = result.server
			catalog.Tools = append(catalog.Tools, Tool{
				Name:        name,
				Server:      result.server.Name,
				Description: tool.Description,
				InputSchema: tool.InputSchema,
			})
		}
	}
	sort.Slice(catalog.Tools, func(i, j int) bool { return catalog.Tools[i].Name < catalog.Tools[j].Name })
	sort.Slice(catalog.Failures, func(i, j int) bool { return catalog.Failures[i].Server < catalog.Failures[j].Server })

	b.mu.Lock()
	b.route = route
	b.catalog = catalog
	b.mu.Unlock()

	// Every server failing is reported as an error as well, because an empty
	// catalog is not a useful success.
	if len(servers) > 0 && len(catalog.Failures) == len(servers) {
		return catalog, fmt.Errorf("every downstream server failed")
	}
	return catalog, nil
}

// Catalog returns the catalog from the last Refresh.
func (b *Broker) Catalog() Catalog {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.catalog
}

// ErrUnknownTool is returned when a namespaced name is not in the catalog.
var ErrUnknownTool = fmt.Errorf("unknown tool")

// Call routes a namespaced tool name to the server that owns it and invokes
// the tool there under its original, un-namespaced name.
func (b *Broker) Call(ctx context.Context, name string, args json.RawMessage) (*mcp.CallResult, error) {
	b.mu.RLock()
	server, found := b.route[name]
	b.mu.RUnlock()
	if !found {
		return nil, fmt.Errorf("%w: %q", ErrUnknownTool, name)
	}
	_, toolName, _ := strings.Cut(name, NameSeparator)
	return server.Client.Call(ctx, toolName, args)
}
