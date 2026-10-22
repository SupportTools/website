package buffer

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/supporttools/website/exporters/blog-metrics/internal/snapshot"
)

func TestAggregatedSendsQueryAndKeepsKnownMetrics(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer buf_test" {
			t.Errorf("Authorization = %q", r.Header.Get("Authorization"))
		}
		var body struct {
			Query     string         `json:"query"`
			Variables map[string]any `json:"variables"`
		}
		b, _ := io.ReadAll(r.Body)
		json.Unmarshal(b, &body)
		if !strings.Contains(body.Query, "aggregatedPostMetrics") || body.Variables["org"] != "org1" {
			t.Errorf("body = %s", b)
		}
		if ch, _ := body.Variables["channels"].([]any); len(ch) != 1 || ch[0] != "chan1" {
			t.Errorf("channels = %v", body.Variables["channels"])
		}
		io.WriteString(w, `{"data":{"aggregatedPostMetrics":{"metrics":[
			{"type":"postCount","value":2},{"type":"reactions","value":72},{"type":"comments","value":9},
			{"type":"impressions","value":3049},{"type":"reach","value":1878},{"type":"engagementRate","value":2.66},
			{"type":"views","value":0}]}}}`)
	}))
	defer srv.Close()
	c := &Client{URL: srv.URL, APIKey: "buf_test", OrgID: "org1", HTTP: http.DefaultClient}
	end := time.Date(2026, 10, 22, 0, 0, 0, 0, time.UTC)
	got, err := c.Aggregated(context.Background(), "chan1", end.AddDate(0, 0, -7), end)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]float64{"posts": 2, "reactions": 72, "comments": 9, "impressions": 3049, "reach": 1878}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

func TestAggregatedGraphQLErrorIsAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"errors":[{"message":"Not authorized"}]}`)
	}))
	defer srv.Close()
	c := &Client{URL: srv.URL, APIKey: "x", OrgID: "o", HTTP: http.DefaultClient}
	_, err := c.Aggregated(context.Background(), "c", time.Now().Add(-time.Hour), time.Now())
	if err == nil || !strings.Contains(err.Error(), "Not authorized") {
		t.Fatalf("err = %v", err)
	}
}

func TestCollectPerWindowAndChannel(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		io.WriteString(w, `{"data":{"aggregatedPostMetrics":{"metrics":[{"type":"postCount","value":1}]}}}`)
	}))
	defer srv.Close()
	c := &Client{URL: srv.URL, APIKey: "x", OrgID: "o", HTTP: http.DefaultClient}
	s, err := Collect(context.Background(), c, map[string]string{"linkedin": "a", "bluesky": "b"}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if calls != 4 || s.Metrics[snapshot.W28d]["bluesky"]["posts"] != 1 || s.Metrics[snapshot.W7d]["linkedin"]["posts"] != 1 {
		t.Fatalf("calls %d metrics %v", calls, s.Metrics)
	}
}
