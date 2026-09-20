// Package mcp is a small client for talking to an MCP server over the
// streamable HTTP transport. It covers only what the gateway needs:
// initialize, list the server's tools, and call one of them.
package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
)

// ProtocolVersion is the MCP revision this client speaks.
const ProtocolVersion = "2025-06-18"

// Tool is one tool as a downstream server describes it.
type Tool struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"inputSchema,omitempty"`
}

// CallResult is the payload an MCP server returns from tools/call. Content is
// left as raw JSON because the gateway forwards it without interpreting it.
type CallResult struct {
	Content json.RawMessage `json:"content,omitempty"`
	IsError bool            `json:"isError,omitempty"`
}

// Client talks to exactly one MCP server.
type Client struct {
	endpoint string
	http     *http.Client

	nextID atomic.Int64
	// sessionID is handed to us by the server during initialize. Servers that
	// do not use sessions leave it empty and we simply never send the header.
	sessionID string
}

// NewClient returns a client for the MCP server at endpoint. Pass nil for
// httpClient to use http.DefaultClient.
func NewClient(endpoint string, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &Client{endpoint: endpoint, http: httpClient}
}

// Endpoint reports the URL this client was built for.
func (c *Client) Endpoint() string { return c.endpoint }

// rpcRequest is a JSON-RPC 2.0 request.
type rpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int64  `json:"id,omitempty"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

// rpcError is the error member of a JSON-RPC response.
type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *rpcError) Error() string {
	return fmt.Sprintf("mcp error %d: %s", e.Code, e.Message)
}

// rpcResponse is a JSON-RPC 2.0 response.
type rpcResponse struct {
	Result json.RawMessage `json:"result"`
	Error  *rpcError       `json:"error"`
}

// Initialize performs the MCP handshake. Call it once before Tools or Call.
func (c *Client) Initialize(ctx context.Context, clientName, clientVersion string) error {
	params := map[string]any{
		"protocolVersion": ProtocolVersion,
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": clientName, "version": clientVersion},
	}
	if _, err := c.do(ctx, "initialize", params); err != nil {
		return err
	}
	// The spec requires a notification once the handshake is accepted. It has
	// no id and no response, so a failure here is not fatal to us.
	_, _ = c.do(ctx, "notifications/initialized", map[string]any{})
	return nil
}

// Tools lists the tools this server exposes, following pagination to the end.
func (c *Client) Tools(ctx context.Context) ([]Tool, error) {
	var all []Tool
	cursor := ""
	// A server that keeps handing back the same cursor would spin forever, so
	// cap the number of pages we are willing to walk.
	for page := 0; page < 100; page++ {
		params := map[string]any{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		raw, err := c.do(ctx, "tools/list", params)
		if err != nil {
			return nil, err
		}
		var body struct {
			Tools      []Tool `json:"tools"`
			NextCursor string `json:"nextCursor"`
		}
		if err := json.Unmarshal(raw, &body); err != nil {
			return nil, fmt.Errorf("decode tools/list: %w", err)
		}
		all = append(all, body.Tools...)
		if body.NextCursor == "" || body.NextCursor == cursor {
			return all, nil
		}
		cursor = body.NextCursor
	}
	return all, fmt.Errorf("tools/list did not finish paginating after 100 pages")
}

// Call invokes one tool by its name on this server.
func (c *Client) Call(ctx context.Context, name string, args json.RawMessage) (*CallResult, error) {
	params := map[string]any{"name": name}
	if len(args) > 0 {
		params["arguments"] = args
	}
	raw, err := c.do(ctx, "tools/call", params)
	if err != nil {
		return nil, err
	}
	var result CallResult
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, fmt.Errorf("decode tools/call: %w", err)
	}
	return &result, nil
}

// do sends one JSON-RPC request and returns the raw result member.
func (c *Client) do(ctx context.Context, method string, params any) (json.RawMessage, error) {
	notification := strings.HasPrefix(method, "notifications/")

	payload := rpcRequest{JSONRPC: "2.0", Method: method, Params: params}
	if !notification {
		payload.ID = c.nextID.Add(1)
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("encode %s: %w", method, err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build %s request: %w", method, err)
	}
	req.Header.Set("Content-Type", "application/json")
	// Streamable HTTP lets the server answer with either a JSON body or an SSE
	// stream, so we tell it we accept both and handle both below.
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("MCP-Protocol-Version", ProtocolVersion)
	if c.sessionID != "" {
		req.Header.Set("Mcp-Session-Id", c.sessionID)
	}

	response, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", method, err)
	}
	defer response.Body.Close()

	if session := response.Header.Get("Mcp-Session-Id"); session != "" {
		c.sessionID = session
	}

	// A notification is answered with 202 and no body.
	if notification {
		_, _ = io.Copy(io.Discard, response.Body)
		return nil, nil
	}

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		preview, _ := io.ReadAll(io.LimitReader(response.Body, 512))
		return nil, fmt.Errorf("%s: http %d: %s", method, response.StatusCode, strings.TrimSpace(string(preview)))
	}

	raw, err := readResponseBody(response)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", method, err)
	}

	var decoded rpcResponse
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, fmt.Errorf("decode %s response: %w", method, err)
	}
	if decoded.Error != nil {
		return nil, decoded.Error
	}
	return decoded.Result, nil
}

// readResponseBody returns the JSON-RPC message, unwrapping SSE framing when
// the server chose the event-stream form.
func readResponseBody(response *http.Response) ([]byte, error) {
	if !strings.Contains(response.Header.Get("Content-Type"), "text/event-stream") {
		return io.ReadAll(io.LimitReader(response.Body, maxBodyBytes))
	}

	// An SSE response carries the JSON-RPC message in the first event's data.
	// Events may split data across several "data:" lines, joined by newlines.
	scanner := bufio.NewScanner(io.LimitReader(response.Body, maxBodyBytes))
	scanner.Buffer(make([]byte, 0, 64*1024), maxBodyBytes)
	var data []string
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if len(data) > 0 {
				return []byte(strings.Join(data, "\n")), nil
			}
			continue
		}
		if after, found := strings.CutPrefix(line, "data:"); found {
			data = append(data, strings.TrimPrefix(after, " "))
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read event stream: %w", err)
	}
	if len(data) == 0 {
		return nil, fmt.Errorf("event stream carried no data")
	}
	return []byte(strings.Join(data, "\n")), nil
}

// maxBodyBytes caps how much we will read from a downstream server so one
// misbehaving server cannot exhaust the gateway's memory.
const maxBodyBytes = 8 << 20
