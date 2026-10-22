package posthog

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/supporttools/website/exporters/blog-metrics/internal/botfilter"
	"github.com/supporttools/website/exporters/blog-metrics/internal/snapshot"
)

// fakeAPI answers HogQL queries with canned rows, picked by a marker in the query.
func fakeAPI(t *testing.T, answers map[string]string) (*httptest.Server, *[]string) {
	t.Helper()
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/projects/78897/query/" {
			t.Errorf("request %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer phx_test" {
			t.Errorf("Authorization = %q", got)
		}
		var body struct {
			Query struct{ Kind, Query string } `json:"query"`
		}
		b, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(b, &body); err != nil || body.Query.Kind != "HogQLQuery" {
			t.Errorf("body %s", b)
		}
		q := body.Query.Query
		seen = append(seen, q)
		for marker, rows := range answers {
			if strings.Contains(q, marker) {
				io.WriteString(w, `{"results":`+rows+`}`)
				return
			}
		}
		io.WriteString(w, `{"results":[]}`)
	}))
	t.Cleanup(srv.Close)
	return srv, &seen
}

func client(url string) *Client {
	return &Client{BaseURL: url, ProjectID: "78897", APIKey: "phx_test", HTTP: http.DefaultClient}
}

func TestQuerySendsHogQLAndParsesResults(t *testing.T) {
	srv, seen := fakeAPI(t, map[string]string{"SELECT 1": `[[1, "a", null]]`})
	rows, err := client(srv.URL).Query(context.Background(), "SELECT 1")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || toFloat(rows[0][0]) != 1 || str(rows[0][1]) != "a" || str(rows[0][2]) != "" {
		t.Fatalf("rows = %v", rows)
	}
	if len(*seen) != 1 {
		t.Fatalf("requests = %d", len(*seen))
	}
}

func TestQueryErrorIncludesStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"detail":"permission denied"}`, http.StatusForbidden)
	}))
	defer srv.Close()
	_, err := client(srv.URL).Query(context.Background(), "SELECT 1")
	if err == nil || !strings.Contains(err.Error(), "403") || !strings.Contains(err.Error(), "permission denied") {
		t.Fatalf("err = %v", err)
	}
}

var canned = map[string]string{
	// window columns are always 1d, 7d, 28d
	"NOT (NOT (":                               `[[10, 70, 280]]`,
	"uniqIf":                                   `[[5, 40, 150, 4, 30, 100]]`,
	"properties.$referring_domain":             `[["www.google.com", null, 3, 20, 90], ["$direct", null, 1, 5, 20], ["bsky.app", "bluesky", 0, 2, 4], ["chatgpt.com", null, 1, 1, 6], [null, null, 0, 0, 2]]`,
	"properties.post_category":                 `[["networking", "$pageview", 2, 10, 40], ["networking", "article_read", 1, 3, 9], ["kubernetes", "$pageview", 1, 8, 50], [null, "$pageview", 2, 22, 60], ["", "$pageview", 0, 1, 1]]`,
	"properties.post_kind":                     `[["guide", 3, 12, 60], ["troubleshooting", 1, 6, 30], [null, 1, 22, 60], ["bogus", 0, 0, 1]]`,
	"INTERVAL 7 DAY AND properties.post_slug":  `[["curl-host-header", 9], ["ping-mtu", 4]]`,
	"INTERVAL 28 DAY AND properties.post_slug": `[["curl-host-header", 30], ["vmware-default-passwords", 25], ["ping-mtu", 12]]`,
}

func TestCollectBuildsTraffic(t *testing.T) {
	srv, seen := fakeAPI(t, canned)
	tr, err := Collect(context.Background(), client(srv.URL), "support.tools")
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range *seen {
		if !strings.Contains(q, "properties.$host = 'support.tools'") {
			t.Errorf("query lacks the host filter: %s", q)
		}
		if !strings.Contains(q, botfilter.Human()) {
			t.Errorf("query lacks the bot filter: %s", q)
		}
	}
	if tr.Pageviews[snapshot.W7d] != 40 || tr.Visitors[snapshot.W28d] != 100 || tr.Bot[snapshot.W1d] != 10 {
		t.Fatalf("totals: pv %v visitors %v bot %v", tr.Pageviews, tr.Visitors, tr.Bot)
	}
	ch := tr.Channels[snapshot.W28d]
	if ch["google"] != 90 || ch["direct"] != 22 || ch["bluesky"] != 4 || ch["ai_assistant"] != 6 {
		t.Fatalf("channels 28d = %v", ch)
	}
	if tr.Topics[snapshot.W28d]["kubernetes"] != 50 || tr.Reads[snapshot.W7d]["networking"] != 3 {
		t.Fatalf("topics %v reads %v", tr.Topics, tr.Reads)
	}
	if got := tr.TopPosts[snapshot.W28d]; len(got) != 3 || got[0].Slug != "curl-host-header" || got[0].Pageviews != 30 {
		t.Fatalf("top 28d = %v", got)
	}
	if got := tr.TopPosts[snapshot.W7d]; len(got) != 2 {
		t.Fatalf("top 7d = %v", got)
	}
}

func TestNullPropertiesBucketed(t *testing.T) {
	srv, _ := fakeAPI(t, canned)
	tr, err := Collect(context.Background(), client(srv.URL), "support.tools")
	if err != nil {
		t.Fatal(err)
	}
	if tr.Kinds[snapshot.W28d]["page"] != 61 {
		t.Fatalf("page kind = %v, want 61 (null 60 + bogus 1)", tr.Kinds[snapshot.W28d])
	}
	for _, w := range snapshot.TrafficWindows {
		for _, m := range []map[string]float64{tr.Channels[w], tr.Topics[w], tr.Reads[w], tr.Kinds[w]} {
			if _, ok := m[""]; ok {
				t.Fatalf("empty label key in window %s: %v", w, m)
			}
		}
	}
	if _, ok := tr.Topics[snapshot.W28d][""]; ok {
		t.Fatal("null topic kept")
	}
}

// HogQL evaluates NULL != ” as true, so without IS NOT NULL the pre-instrumentation
// pageviews come back as one null row and take one of the 20 top-post slots
// (seen against project 78897 on 2026-10-22).
func TestTopPostsQueryExcludesNullSlugs(t *testing.T) {
	srv, seen := fakeAPI(t, canned)
	if _, err := Collect(context.Background(), client(srv.URL), "support.tools"); err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, q := range *seen {
		if strings.Contains(q, "properties.post_slug AS s") {
			n++
			if !strings.Contains(q, "properties.post_slug IS NOT NULL") {
				t.Errorf("top-posts query lets null slugs in: %s", q)
			}
		}
	}
	if n != 2 {
		t.Fatalf("top-posts queries = %d, want 2", n)
	}
}
