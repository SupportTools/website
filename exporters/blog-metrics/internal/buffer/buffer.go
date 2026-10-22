// Package buffer reads per-channel post analytics from Buffer's GraphQL API.
//
// Buffer reports posts, reactions and comments on every channel, and
// impressions and reach only on LinkedIn. It has no link clicks: social clicks
// come from PostHog pageviews tagged utm_source=linkedin|bluesky.
package buffer

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/supporttools/website/exporters/blog-metrics/internal/snapshot"
)

// Client calls Buffer's GraphQL endpoint with an API key.
type Client struct {
	URL    string
	APIKey string
	OrgID  string
	HTTP   *http.Client
}

const aggregatedQuery = `query($org: OrganizationId!, $channels: [ChannelId!], $start: DateTime!, $end: DateTime!) {
  aggregatedPostMetrics(input: {organizationId: $org, channelIds: $channels, startDateTime: $start, endDateTime: $end}) {
    metrics { type value }
  }
}`

// kept maps Buffer metric types to the exporter's metric names.
var kept = map[string]string{
	"postCount": "posts", "reactions": "reactions", "comments": "comments",
	"impressions": "impressions", "reach": "reach",
}

// Aggregated returns the channel's totals for [start, end].
func (c *Client) Aggregated(ctx context.Context, channelID string, start, end time.Time) (map[string]float64, error) {
	body, _ := json.Marshal(map[string]any{
		"query": aggregatedQuery,
		"variables": map[string]any{
			"org": c.OrgID, "channels": []string{channelID},
			"start": start.UTC().Format(time.RFC3339), "end": end.UTC().Format(time.RFC3339),
		},
	})
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.URL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("buffer: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("buffer: HTTP %d: %.200s", resp.StatusCode, bytes.TrimSpace(raw))
	}
	var out struct {
		Data struct {
			Aggregated struct {
				Metrics []struct {
					Type  string  `json:"type"`
					Value float64 `json:"value"`
				} `json:"metrics"`
			} `json:"aggregatedPostMetrics"`
		} `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("buffer: decode: %w", err)
	}
	if len(out.Errors) > 0 {
		msgs := make([]string, len(out.Errors))
		for i, e := range out.Errors {
			msgs[i] = e.Message
		}
		return nil, fmt.Errorf("buffer: %s", strings.Join(msgs, "; "))
	}
	m := map[string]float64{}
	for _, x := range out.Data.Aggregated.Metrics {
		if name, ok := kept[x.Type]; ok {
			m[name] = x.Value
		}
	}
	return m, nil
}

// Collect reads every channel (name -> Buffer channel ID) for 7 and 28 days
// ending at now. Buffer's free plan only answers for the last 31 days.
func Collect(ctx context.Context, c *Client, channels map[string]string, now time.Time) (snapshot.Social, error) {
	s := snapshot.Social{Metrics: map[snapshot.Window]map[string]map[string]float64{}}
	for _, w := range snapshot.LongWindows {
		days := map[snapshot.Window]int{snapshot.W7d: 7, snapshot.W28d: 28}[w]
		s.Metrics[w] = map[string]map[string]float64{}
		for name, id := range channels {
			m, err := c.Aggregated(ctx, id, now.AddDate(0, 0, -days), now)
			if err != nil {
				return s, fmt.Errorf("%s %s: %w", name, w, err)
			}
			s.Metrics[w][name] = m
		}
	}
	return s, nil
}
