package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// decodeRequest reads the JSON-RPC request a test server received.
func decodeRequest(t *testing.T, r *http.Request) rpcRequest {
	t.Helper()
	body, err := io.ReadAll(r.Body)
	if err != nil {
		t.Fatalf("read request: %v", err)
	}
	var decoded rpcRequest
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("decode request %s: %v", body, err)
	}
	return decoded
}

func writeJSON(w http.ResponseWriter, result string) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"jsonrpc":"2.0","id":1,"result":%s}`, result)
}

func TestToolsReadsAJSONResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, `{"tools":[{"name":"save","description":"save it","inputSchema":{"type":"object"}}]}`)
	}))
	defer server.Close()

	tools, err := NewClient(server.URL, server.Client()).Tools(context.Background())
	if err != nil {
		t.Fatalf("Tools: %v", err)
	}
	if len(tools) != 1 || tools[0].Name != "save" || tools[0].Description != "save it" {
		t.Fatalf("unexpected tools: %+v", tools)
	}
	if string(tools[0].InputSchema) != `{"type":"object"}` {
		t.Fatalf("input schema was not preserved verbatim: %s", tools[0].InputSchema)
	}
}

func TestToolsReadsAnEventStreamResponse(t *testing.T) {
	// Streamable HTTP servers may answer with SSE instead of a JSON body.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"tools\":[{\"name\":\"save\"}]}}\n\n")
	}))
	defer server.Close()

	tools, err := NewClient(server.URL, server.Client()).Tools(context.Background())
	if err != nil {
		t.Fatalf("Tools: %v", err)
	}
	if len(tools) != 1 || tools[0].Name != "save" {
		t.Fatalf("unexpected tools: %+v", tools)
	}
}

func TestToolsFollowsPagination(t *testing.T) {
	page := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		page++
		if page == 1 {
			writeJSON(w, `{"tools":[{"name":"one"}],"nextCursor":"c2"}`)
			return
		}
		if got := decodeRequest(t, r).Params.(map[string]any)["cursor"]; got != "c2" {
			t.Errorf("second page sent cursor %v, want c2", got)
		}
		writeJSON(w, `{"tools":[{"name":"two"}]}`)
	}))
	defer server.Close()

	tools, err := NewClient(server.URL, server.Client()).Tools(context.Background())
	if err != nil {
		t.Fatalf("Tools: %v", err)
	}
	if len(tools) != 2 || tools[0].Name != "one" || tools[1].Name != "two" {
		t.Fatalf("pagination did not collect both pages: %+v", tools)
	}
}

func TestToolsStopsWhenAServerRepeatsItsCursor(t *testing.T) {
	// A server that never advances the cursor would otherwise loop forever.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, `{"tools":[{"name":"one"}],"nextCursor":"same"}`)
	}))
	defer server.Close()

	tools, err := NewClient(server.URL, server.Client()).Tools(context.Background())
	if err != nil {
		t.Fatalf("Tools: %v", err)
	}
	if len(tools) != 2 {
		t.Fatalf("expected the walk to stop once the cursor repeated, got %d tools", len(tools))
	}
}

func TestCallSendsTheToolNameAndArguments(t *testing.T) {
	var seen rpcRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = decodeRequest(t, r)
		writeJSON(w, `{"content":[{"type":"text","text":"done"}]}`)
	}))
	defer server.Close()

	result, err := NewClient(server.URL, server.Client()).
		Call(context.Background(), "save", json.RawMessage(`{"title":"x"}`))
	if err != nil {
		t.Fatalf("Call: %v", err)
	}
	if result.IsError {
		t.Fatal("result should not be flagged as an error")
	}
	params := seen.Params.(map[string]any)
	if params["name"] != "save" {
		t.Fatalf("sent name %v, want save", params["name"])
	}
	if params["arguments"].(map[string]any)["title"] != "x" {
		t.Fatalf("arguments were not forwarded: %v", params["arguments"])
	}
}

func TestAJSONRPCErrorBecomesAGoError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"no such tool"}}`)
	}))
	defer server.Close()

	_, err := NewClient(server.URL, server.Client()).Call(context.Background(), "nope", nil)
	if err == nil || !strings.Contains(err.Error(), "no such tool") {
		t.Fatalf("got %v, want the server's error message", err)
	}
}

func TestAnHTTPFailureIsReportedWithItsStatus(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	}))
	defer server.Close()

	_, err := NewClient(server.URL, server.Client()).Tools(context.Background())
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("got %v, want an error naming the status", err)
	}
}

func TestInitializeStoresTheSessionAndSendsItBack(t *testing.T) {
	var sessionOnSecondCall string
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.Header().Set("Mcp-Session-Id", "sess-123")
			writeJSON(w, `{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"t","version":"1"}}`)
			return
		}
		if sessionOnSecondCall == "" {
			sessionOnSecondCall = r.Header.Get("Mcp-Session-Id")
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()

	client := NewClient(server.URL, server.Client())
	if err := client.Initialize(context.Background(), "gateway", "0.1.0"); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	if sessionOnSecondCall != "sess-123" {
		t.Fatalf("session header was %q, want it echoed back to the server", sessionOnSecondCall)
	}
}

func TestRequestsCarryTheProtocolVersionHeader(t *testing.T) {
	var header string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header = r.Header.Get("MCP-Protocol-Version")
		writeJSON(w, `{"tools":[]}`)
	}))
	defer server.Close()

	if _, err := NewClient(server.URL, server.Client()).Tools(context.Background()); err != nil {
		t.Fatalf("Tools: %v", err)
	}
	if header != ProtocolVersion {
		t.Fatalf("protocol header %q, want %q", header, ProtocolVersion)
	}
}
