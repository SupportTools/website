package gsc

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/supporttools/website/exporters/blog-metrics/internal/snapshot"
	"github.com/supporttools/website/exporters/blog-metrics/internal/testsrv"
)

func q(name string, clicks, impressions, position float64) Row {
	return Row{Keys: []string{name}, Clicks: clicks, Impressions: impressions, Position: position}
}

func TestSERPStats(t *testing.T) {
	for _, tc := range []struct {
		name string
		rows []Row
		want snapshot.SERP
	}{
		{
			name: "empty",
			rows: nil,
			want: snapshot.SERP{},
		},
		{
			// Position bands are inclusive: 3.0 is top 3, 10.0 is top 10.
			// Stable set (>= 10 impressions): positions 1.5, 3, 8, 10, 40 (odd count, median 8).
			name: "bands and odd median",
			rows: []Row{
				q("a", 30, 100, 1.5),
				q("b", 10, 200, 3.0),
				q("c", 5, 5, 3.01),
				q("d", 2, 400, 8),
				q("e", 0, 10, 10.0),
				q("f", 0, 9, 2), // below the stable threshold, still in the bands
				q("g", 1, 600, 40),
				{Keys: nil, Clicks: 99, Impressions: 999, Position: 1}, // keyless row ignored
			},
			want: snapshot.SERP{
				QueryRows: 7, QueryImpressions: 1324,
				Top3Clicks: 40, Top3Impressions: 309,
				Top10Impressions: 724,
				StableQueries:    5, StableMedianPosition: 8,
			},
		},
		{
			name: "even median averages the middle two",
			rows: []Row{q("a", 0, 10, 12), q("b", 0, 10, 2), q("c", 0, 10, 6), q("d", 0, 10, 30)},
			want: snapshot.SERP{
				QueryRows: 4, QueryImpressions: 40,
				Top3Clicks: 0, Top3Impressions: 10,
				Top10Impressions: 20,
				StableQueries:    4, StableMedianPosition: 9, // (6 + 12) / 2
			},
		},
		{
			name: "no stable queries",
			rows: []Row{q("a", 1, 5, 1), q("b", 0, 3, 20)},
			want: snapshot.SERP{
				QueryRows: 2, QueryImpressions: 8,
				Top3Clicks: 1, Top3Impressions: 5, Top10Impressions: 5,
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := SERPStats(tc.rows); got != tc.want {
				t.Fatalf("SERPStats\n got %+v\nwant %+v", got, tc.want)
			}
		})
	}
}

// pagedGSC serves total query rows in pages, honouring rowLimit and startRow,
// and records each request's startRow.
func pagedGSC(t *testing.T, total int, starts *[]int) *Client {
	t.Helper()
	_, keyJSON := testKey(t)
	srv := testsrv.New(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			io.WriteString(w, `{"access_token":"tok","expires_in":3600}`)
			return
		}
		var body struct {
			RowLimit int `json:"rowLimit"`
			StartRow int `json:"startRow"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		*starts = append(*starts, body.StartRow)
		var rows []string
		for i := body.StartRow; i < total && i < body.StartRow+body.RowLimit; i++ {
			rows = append(rows, fmt.Sprintf(`{"keys":["q%d"],"impressions":1}`, i))
		}
		io.WriteString(w, `{"rows":[`+strings.Join(rows, ",")+`]}`)
	}))
	ts, _ := NewTokenSource(keyJSON, srv.URL+"/token", time.Now)
	return &Client{BaseURL: srv.URL, Site: "sc-domain:support.tools", Tokens: ts, HTTP: http.DefaultClient}
}

func TestQueryAllPaginates(t *testing.T) {
	var starts []int
	c := pagedGSC(t, 7, &starts)
	rows, err := c.queryAll(context.Background(), "2026-10-01", "2026-10-07", []string{"query"}, 3, 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 7 || rows[6].Keys[0] != "q6" {
		t.Fatalf("rows = %d, want 7", len(rows))
	}
	if fmt.Sprint(starts) != "[0 3 6]" {
		t.Fatalf("startRows = %v, want [0 3 6]", starts)
	}
}

// An exact multiple of the page size needs one more (empty) page to prove the end.
func TestQueryAllStopsOnEmptyPage(t *testing.T) {
	var starts []int
	c := pagedGSC(t, 6, &starts)
	rows, err := c.queryAll(context.Background(), "2026-10-01", "2026-10-07", []string{"query"}, 3, 5)
	if err != nil || len(rows) != 6 || fmt.Sprint(starts) != "[0 3 6]" {
		t.Fatalf("rows = %d, starts %v, err %v", len(rows), starts, err)
	}
}

func TestQueryAllFailsInsteadOfTruncating(t *testing.T) {
	var starts []int
	c := pagedGSC(t, 100, &starts)
	_, err := c.queryAll(context.Background(), "2026-10-01", "2026-10-07", []string{"query"}, 3, 2)
	if err == nil || !strings.Contains(err.Error(), "truncated") {
		t.Fatalf("err = %v, want a truncation error", err)
	}
}
