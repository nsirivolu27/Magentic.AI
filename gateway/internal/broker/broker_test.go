package broker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nsirivolu27/magentic-ai/gateway/internal/mcp"
)

// fakeCaller stands in for one downstream MCP server.
type fakeCaller struct {
	tools    []mcp.Tool
	listErr  error
	delay    time.Duration
	calls    atomic.Int32
	lastName string
	lastArgs json.RawMessage
	mu       sync.Mutex
}

func (f *fakeCaller) Tools(ctx context.Context) ([]mcp.Tool, error) {
	if f.delay > 0 {
		select {
		case <-time.After(f.delay):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if f.listErr != nil {
		return nil, f.listErr
	}
	return f.tools, nil
}

func (f *fakeCaller) Call(ctx context.Context, name string, args json.RawMessage) (*mcp.CallResult, error) {
	f.calls.Add(1)
	f.mu.Lock()
	f.lastName, f.lastArgs = name, args
	f.mu.Unlock()
	return &mcp.CallResult{Content: json.RawMessage(fmt.Sprintf(`[{"type":"text","text":%q}]`, name))}, nil
}

func tool(name string) mcp.Tool { return mcp.Tool{Name: name, Description: name + " does a thing"} }

func TestRefreshNamespacesToolsFromEveryServer(t *testing.T) {
	broker, err := New([]Server{
		{Name: "lnkz", Client: &fakeCaller{tools: []mcp.Tool{tool("search"), tool("save")}}},
		{Name: "slack", Client: &fakeCaller{tools: []mcp.Tool{tool("search")}}},
	}, 0)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	catalog, err := broker.Refresh(context.Background())
	if err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if len(catalog.Failures) != 0 {
		t.Fatalf("expected no failures, got %v", catalog.Failures)
	}

	var names []string
	for _, tool := range catalog.Tools {
		names = append(names, tool.Name)
	}
	want := []string{"lnkz__save", "lnkz__search", "slack__search"}
	if fmt.Sprint(names) != fmt.Sprint(want) {
		t.Fatalf("catalog = %v, want %v (sorted, same-named tools kept apart)", names, want)
	}
}

func TestRefreshKeepsWorkingServersWhenOneFails(t *testing.T) {
	healthy := &fakeCaller{tools: []mcp.Tool{tool("save")}}
	broken := &fakeCaller{listErr: errors.New("connection refused")}
	broker, err := New([]Server{
		{Name: "lnkz", Client: healthy},
		{Name: "jira", Client: broken},
	}, 0)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	catalog, err := broker.Refresh(context.Background())
	if err != nil {
		t.Fatalf("one failing server must not fail the refresh: %v", err)
	}
	if len(catalog.Tools) != 1 || catalog.Tools[0].Name != "lnkz__save" {
		t.Fatalf("healthy server's tools missing: %v", catalog.Tools)
	}
	if len(catalog.Failures) != 1 || catalog.Failures[0].Server != "jira" {
		t.Fatalf("failure not reported: %v", catalog.Failures)
	}
}

func TestRefreshErrorsWhenEveryServerFails(t *testing.T) {
	broker, err := New([]Server{
		{Name: "a", Client: &fakeCaller{listErr: errors.New("down")}},
		{Name: "b", Client: &fakeCaller{listErr: errors.New("down")}},
	}, 0)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := broker.Refresh(context.Background()); err == nil {
		t.Fatal("an empty catalog should be reported as an error")
	}
}

func TestRefreshBoundsEachServerSeparately(t *testing.T) {
	slow := &fakeCaller{tools: []mcp.Tool{tool("slow")}, delay: 2 * time.Second}
	fast := &fakeCaller{tools: []mcp.Tool{tool("fast")}}
	broker, err := New([]Server{
		{Name: "slow", Client: slow},
		{Name: "fast", Client: fast},
	}, 50*time.Millisecond)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	start := time.Now()
	catalog, err := broker.Refresh(context.Background())
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if elapsed > time.Second {
		t.Fatalf("one slow server blocked the fan-out for %v", elapsed)
	}
	if len(catalog.Tools) != 1 || catalog.Tools[0].Name != "fast__fast" {
		t.Fatalf("fast server's tools missing: %v", catalog.Tools)
	}
	if len(catalog.Failures) != 1 || catalog.Failures[0].Server != "slow" {
		t.Fatalf("timed-out server not reported: %v", catalog.Failures)
	}
}

func TestRefreshRunsServersConcurrently(t *testing.T) {
	// Three servers that each take 150ms must finish together, not in series.
	const each = 150 * time.Millisecond
	servers := []Server{
		{Name: "a", Client: &fakeCaller{tools: []mcp.Tool{tool("x")}, delay: each}},
		{Name: "b", Client: &fakeCaller{tools: []mcp.Tool{tool("x")}, delay: each}},
		{Name: "c", Client: &fakeCaller{tools: []mcp.Tool{tool("x")}, delay: each}},
	}
	broker, err := New(servers, 0)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	start := time.Now()
	if _, err := broker.Refresh(context.Background()); err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if elapsed := time.Since(start); elapsed > 2*each {
		t.Fatalf("fan-out took %v, which means the servers ran in series", elapsed)
	}
}

func TestCallRoutesToTheOwningServerWithoutTheNamespace(t *testing.T) {
	lnkz := &fakeCaller{tools: []mcp.Tool{tool("search")}}
	slack := &fakeCaller{tools: []mcp.Tool{tool("search")}}
	broker, err := New([]Server{{Name: "lnkz", Client: lnkz}, {Name: "slack", Client: slack}}, 0)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := broker.Refresh(context.Background()); err != nil {
		t.Fatalf("Refresh: %v", err)
	}

	args := json.RawMessage(`{"query":"launch"}`)
	if _, err := broker.Call(context.Background(), "slack__search", args); err != nil {
		t.Fatalf("Call: %v", err)
	}

	if lnkz.calls.Load() != 0 {
		t.Fatal("the call reached the wrong server")
	}
	if slack.calls.Load() != 1 {
		t.Fatalf("slack received %d calls, want 1", slack.calls.Load())
	}
	slack.mu.Lock()
	defer slack.mu.Unlock()
	if slack.lastName != "search" {
		t.Fatalf("downstream saw %q, want the un-namespaced %q", slack.lastName, "search")
	}
	if string(slack.lastArgs) != string(args) {
		t.Fatalf("arguments were altered: %s", slack.lastArgs)
	}
}

func TestCallRejectsAToolThatIsNotInTheCatalog(t *testing.T) {
	broker, err := New([]Server{{Name: "lnkz", Client: &fakeCaller{tools: []mcp.Tool{tool("save")}}}}, 0)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := broker.Refresh(context.Background()); err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if _, err := broker.Call(context.Background(), "lnkz__missing", nil); !errors.Is(err, ErrUnknownTool) {
		t.Fatalf("got %v, want ErrUnknownTool", err)
	}
}

func TestCallStopsRoutingToAServerThatDroppedOutOfTheCatalog(t *testing.T) {
	flaky := &fakeCaller{tools: []mcp.Tool{tool("save")}}
	broker, err := New([]Server{{Name: "lnkz", Client: flaky}}, 0)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := broker.Refresh(context.Background()); err != nil {
		t.Fatalf("Refresh: %v", err)
	}

	// The server goes away. After a refresh its tools must no longer be
	// advertised or routable, rather than lingering from the previous catalog.
	flaky.listErr = errors.New("gone")
	if _, err := broker.Refresh(context.Background()); err == nil {
		t.Fatal("expected an error when the only server fails")
	}
	if _, err := broker.Call(context.Background(), "lnkz__save", nil); !errors.Is(err, ErrUnknownTool) {
		t.Fatalf("stale route survived the refresh: %v", err)
	}
}

func TestNewRejectsUnusableServerNames(t *testing.T) {
	good := &fakeCaller{}
	cases := map[string][]Server{
		"empty name":        {{Name: "", Client: good}},
		"duplicate name":    {{Name: "lnkz", Client: good}, {Name: "lnkz", Client: good}},
		"separator in name": {{Name: "ln" + NameSeparator + "kz", Client: good}},
		"missing client":    {{Name: "lnkz"}},
	}
	for name, servers := range cases {
		if _, err := New(servers, 0); err == nil {
			t.Errorf("%s: expected New to reject this", name)
		}
	}
}
