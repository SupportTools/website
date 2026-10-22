// Package posthog reads blog traffic from PostHog's HogQL query API.
package posthog

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// Client calls POST {BaseURL}/api/projects/{ProjectID}/query/ with a personal
// API key that only has query read scope.
type Client struct {
	BaseURL   string
	ProjectID string
	APIKey    string
	HTTP      *http.Client
}

const queryTimeout = 60 * time.Second

// Query runs one HogQL query and returns its result rows. JSON numbers come
// back as json.Number and nulls as nil; use toFloat and str to read them.
func (c *Client) Query(ctx context.Context, hogql string) ([][]any, error) {
	body, err := json.Marshal(map[string]any{
		"query": map[string]string{"kind": "HogQLQuery", "query": hogql},
		"name":  "blog-metrics-exporter",
	})
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, queryTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		fmt.Sprintf("%s/api/projects/%s/query/", c.BaseURL, c.ProjectID), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("posthog query: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
		return nil, fmt.Errorf("posthog query: HTTP %d: %s", resp.StatusCode, bytes.TrimSpace(snippet))
	}
	var out struct {
		Results [][]any `json:"results"`
	}
	dec := json.NewDecoder(resp.Body)
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil {
		return nil, fmt.Errorf("posthog query: decode: %w", err)
	}
	return out.Results, nil
}

// toFloat reads a numeric cell; anything else is 0.
func toFloat(v any) float64 {
	switch n := v.(type) {
	case json.Number:
		f, _ := n.Float64()
		return f
	case float64:
		return n
	case string:
		f, _ := strconv.ParseFloat(n, 64)
		return f
	}
	return 0
}

// str reads a string cell; null is "".
func str(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}
