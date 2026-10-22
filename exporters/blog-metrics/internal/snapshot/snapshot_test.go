package snapshot

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"
)

func gather(t *testing.T, s *Store) map[string]*dto.MetricFamily {
	t.Helper()
	reg := prometheus.NewPedanticRegistry()
	reg.MustRegister(NewCollector(s))
	mfs, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]*dto.MetricFamily{}
	for _, mf := range mfs {
		out[mf.GetName()] = mf
	}
	return out
}

func label(m *dto.Metric, name string) string {
	for _, l := range m.GetLabel() {
		if l.GetName() == name {
			return l.GetValue()
		}
	}
	return ""
}

func fixedNow() func() time.Time {
	return func() time.Time { return time.Unix(1_800_000_000, 0) }
}

func sampleTraffic() Traffic {
	return Traffic{
		Pageviews: map[Window]float64{W1d: 1, W7d: 7, W28d: 28},
		Visitors:  map[Window]float64{W1d: 1, W7d: 5, W28d: 20},
		Bot:       map[Window]float64{W1d: 2, W7d: 9, W28d: 40},
		Channels:  map[Window]map[string]float64{W28d: {"google": 20, "direct": 8}},
		Topics:    map[Window]map[string]float64{W28d: {"networking": 10, "rke2": 0}},
		Reads:     map[Window]map[string]float64{W28d: {"networking": 4, "rke2": 1}},
		Kinds:     map[Window]map[string]float64{W28d: {"guide": 20, "page": 8}},
		TopPosts:  map[Window][]Ranked{W28d: {{"curl-host-header", 9}, {"ping-mtu", 4}}},
	}
}

func TestNoValuesBeforeFirstSuccess(t *testing.T) {
	mfs := gather(t, NewStore(fixedNow()))
	if len(mfs) != 1 {
		names := []string{}
		for n := range mfs {
			names = append(names, n)
		}
		t.Fatalf("families = %v, want only blog_metrics_source_up", names)
	}
	up := mfs["blog_metrics_source_up"]
	if up == nil || len(up.GetMetric()) != 3 {
		t.Fatalf("source_up = %v", up)
	}
	for _, m := range up.GetMetric() {
		if m.GetGauge().GetValue() != 0 {
			t.Fatalf("%s up = %v before any poll", label(m, "source"), m.GetGauge().GetValue())
		}
	}
}

func TestSourceFailureKeepsLastGood(t *testing.T) {
	s := NewStore(fixedNow())
	s.SetTraffic(sampleTraffic())
	s.Fail(SourcePostHog)
	mfs := gather(t, s)
	pv := mfs["blog_pageviews"]
	if pv == nil || len(pv.GetMetric()) != 3 {
		t.Fatalf("pageviews dropped after a failure: %v", pv)
	}
	for _, m := range mfs["blog_metrics_source_up"].GetMetric() {
		if label(m, "source") == SourcePostHog && m.GetGauge().GetValue() != 0 {
			t.Fatal("posthog still up after Fail")
		}
	}
	ls := mfs["blog_metrics_source_last_success_timestamp_seconds"]
	if ls == nil || len(ls.GetMetric()) != 1 || ls.GetMetric()[0].GetGauge().GetValue() != 1_800_000_000 {
		t.Fatalf("last success = %v", ls)
	}
}

func TestTopPostsChurnLeavesNoStaleSlug(t *testing.T) {
	s := NewStore(fixedNow())
	s.SetTraffic(sampleTraffic())
	next := sampleTraffic()
	next.TopPosts = map[Window][]Ranked{W28d: {{"new-post", 12}}}
	s.SetTraffic(next)
	for _, m := range gather(t, s)["blog_top_post_pageviews"].GetMetric() {
		if label(m, "slug") != "new-post" || label(m, "rank") != "1" {
			t.Fatalf("stale or wrong top post series: slug=%s rank=%s", label(m, "slug"), label(m, "rank"))
		}
	}
}

func TestReadRateOmittedWhenNoPageviews(t *testing.T) {
	s := NewStore(fixedNow())
	s.SetTraffic(sampleTraffic())
	rates := gather(t, s)["blog_read_rate"].GetMetric()
	if len(rates) != 1 || label(rates[0], "topic") != "networking" || rates[0].GetGauge().GetValue() != 0.4 {
		t.Fatalf("read rates = %v", rates)
	}
}

func TestMetricNamesMatchSpec(t *testing.T) {
	s := NewStore(fixedNow())
	s.SetTraffic(sampleTraffic())
	s.SetSearch(Search{
		Totals:             map[Window]Totals{W7d: {150, 30000, 0.005, 17.2}},
		ClicksByTopic:      map[Window]map[string]float64{W7d: {"networking": 40}},
		ImpressionsByTopic: map[Window]map[string]float64{W7d: {"networking": 900}},
	})
	s.SetSocial(Social{Metrics: map[Window]map[string]map[string]float64{
		W7d: {"linkedin": {"posts": 1, "reactions": 2, "comments": 3, "impressions": 4, "reach": 5}},
	}})
	var names []string
	for n := range gather(t, s) {
		names = append(names, n)
	}
	sort.Strings(names)
	want := strings.Fields(`blog_article_reads blog_bot_pageviews blog_metrics_source_last_success_timestamp_seconds
		blog_metrics_source_up blog_pageviews blog_pageviews_by_channel blog_pageviews_by_kind blog_pageviews_by_topic
		blog_read_rate blog_search_clicks blog_search_clicks_by_topic blog_search_ctr blog_search_impressions
		blog_search_impressions_by_topic blog_search_position blog_social_comments blog_social_impressions
		blog_social_posts blog_social_reach blog_social_reactions blog_top_post_pageviews blog_visitors`)
	if strings.Join(names, " ") != strings.Join(want, " ") {
		t.Fatalf("metric names\n got %v\nwant %v", names, want)
	}
}

func TestReportShape(t *testing.T) {
	s := NewStore(fixedNow())
	s.SetTraffic(sampleTraffic())
	s.SetSearch(Search{
		Totals:          map[Window]Totals{W28d: {150, 30000, 0.005, 17.2}},
		ClicksByTopic:   map[Window]map[string]float64{W28d: {"networking": 40, "kubernetes": 3}},
		ArticlesByTopic: map[string]float64{"networking": 12},
		Queries:         []Query{{Query: "curl host header", Clicks: 30, PrevClicks: 20}},
	})
	b, err := json.Marshal(Report(s.Get()))
	if err != nil {
		t.Fatal(err)
	}
	var r map[string]any
	json.Unmarshal(b, &r)
	for _, k := range []string{"generated_at", "sources", "traffic", "topics", "top_posts", "search", "social"} {
		if _, ok := r[k]; !ok {
			t.Fatalf("report lacks %q: %s", k, b)
		}
	}
	topics := r["topics"].([]any)
	first := topics[0].(map[string]any)
	if first["topic"] != "networking" || first["read_rate_28d"] != 0.4 || first["search_clicks_28d"] != 40.0 || first["articles"] != 12.0 {
		t.Fatalf("first topic row = %v", first)
	}
	if len(topics) != 3 { // networking, rke2 (traffic), kubernetes (search only)
		t.Fatalf("topics = %v", topics)
	}
}

// manyTopics returns 25 topics t00..t24 where t24 has the most pageviews.
func manyTopics() map[string]float64 {
	m := map[string]float64{}
	for i := 0; i < 25; i++ {
		m[fmt.Sprintf("t%02d", i)] = float64(i + 1)
	}
	return m
}

// Traffic and search topics are bucketed with one top-20 set (by 28-day
// pageviews), so a topic row never joins a different "other" across sources.
func TestCollectorUsesOneTopSetForTrafficAndSearch(t *testing.T) {
	s := NewStore(fixedNow())
	tr := sampleTraffic()
	tr.Topics = map[Window]map[string]float64{W28d: manyTopics()}
	tr.Reads = map[Window]map[string]float64{}
	s.SetTraffic(tr)
	s.SetSearch(Search{
		Totals:             map[Window]Totals{W28d: {}},
		ClicksByTopic:      map[Window]map[string]float64{W28d: {"t00": 500, "t24": 1, "nonarticle": 7}},
		ImpressionsByTopic: map[Window]map[string]float64{W28d: {"t00": 900}},
	})
	mfs := gather(t, s)
	keep := map[string]bool{"other": true}
	for _, m := range mfs["blog_pageviews_by_topic"].GetMetric() {
		keep[label(m, "topic")] = true
	}
	if len(keep) != 21 || keep["t00"] || !keep["t24"] {
		t.Fatalf("traffic topics = %v, want t05..t24 plus other", keep)
	}
	clicks := map[string]float64{}
	for _, m := range mfs["blog_search_clicks_by_topic"].GetMetric() {
		if !keep[label(m, "topic")] {
			t.Fatalf("search topic %q is outside the traffic top set", label(m, "topic"))
		}
		clicks[label(m, "topic")] = m.GetGauge().GetValue()
	}
	if clicks["other"] != 507 || clicks["t24"] != 1 {
		t.Fatalf("search clicks by topic = %v, want t00 and nonarticle in other", clicks)
	}
}

func TestCollectorFallsBackToSearchTopSetWithoutTraffic(t *testing.T) {
	s := NewStore(fixedNow())
	s.SetSearch(Search{ClicksByTopic: map[Window]map[string]float64{W28d: manyTopics()}})
	got := gather(t, s)["blog_search_clicks_by_topic"].GetMetric()
	if len(got) != 21 {
		t.Fatalf("search topics = %d, want 20 plus other", len(got))
	}
}

// /report joins unbucketed maps, so a topic outside one source's top 20 still
// shows its real numbers from the other.
func TestReportJoinsUnbucketedTopics(t *testing.T) {
	s := NewStore(fixedNow())
	tr := sampleTraffic()
	tr.Topics = map[Window]map[string]float64{W28d: manyTopics()}
	s.SetTraffic(tr)
	s.SetSearch(Search{ClicksByTopic: map[Window]map[string]float64{W28d: {"t00": 500}}})
	for _, row := range Report(s.Get()).Topics {
		if row.Topic == "t00" {
			if row.Pageviews28d != 1 || row.SearchClicks28d != 500 {
				t.Fatalf("t00 row = %+v", row)
			}
			return
		}
	}
	t.Fatal("t00 missing from /report topics")
}
