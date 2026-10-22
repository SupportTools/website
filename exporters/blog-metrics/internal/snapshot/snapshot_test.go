package snapshot

import (
	"encoding/json"
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
