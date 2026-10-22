package gsc

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// Client calls the Search Console searchAnalytics API for one property.
type Client struct {
	BaseURL string // https://searchconsole.googleapis.com
	Site    string // sc-domain:support.tools
	Tokens  *TokenSource
	HTTP    *http.Client
}

// Row is one searchAnalytics row; Keys follow the requested dimensions.
type Row struct {
	Keys        []string `json:"keys"`
	Clicks      float64  `json:"clicks"`
	Impressions float64  `json:"impressions"`
	CTR         float64  `json:"ctr"`
	Position    float64  `json:"position"`
}

// Query returns rows for [start, end] (YYYY-MM-DD, inclusive) grouped by dims.
func (c *Client) Query(ctx context.Context, start, end string, dims []string, rowLimit int) ([]Row, error) {
	tok, err := c.Tokens.Token(ctx)
	if err != nil {
		return nil, err
	}
	reqBody := map[string]any{"startDate": start, "endDate": end, "rowLimit": rowLimit}
	if len(dims) > 0 {
		reqBody["dimensions"] = dims
	}
	body, _ := json.Marshal(reqBody)
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	endpoint := fmt.Sprintf("%s/webmasters/v3/sites/%s/searchAnalytics/query", c.BaseURL, url.PathEscape(c.Site))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("gsc query: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
		return nil, fmt.Errorf("gsc query: HTTP %d: %s", resp.StatusCode, bytes.TrimSpace(snippet))
	}
	var out struct {
		Rows []Row `json:"rows"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("gsc query: decode: %w", err)
	}
	return out.Rows, nil
}
