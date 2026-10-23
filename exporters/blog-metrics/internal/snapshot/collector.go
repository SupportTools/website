package snapshot

import (
	"strconv"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/supporttools/website/exporters/blog-metrics/internal/classify"
)

// topTopics is the topic label budget per metric: the 20 topics with the most
// 28-day article pageviews (or search clicks when PostHog has no data yet),
// with every other topic summed into "other". Traffic and search share this one
// set so their topic series line up.
const topTopics = 20

// collector builds const metrics from the store on every scrape, so a label
// value that left the data (a top post, a topic) disappears instead of staying
// frozen at its last value. A source with no successful poll yet exports only
// blog_metrics_source_up 0, never zeros.
type collector struct{ store *Store }

// NewCollector exposes the store as Prometheus metrics.
func NewCollector(s *Store) prometheus.Collector { return collector{store: s} }

// Describe sends nothing: the metric set depends on the data (an unchecked collector).
func (collector) Describe(chan<- *prometheus.Desc) {}

func desc(name, help string, labels ...string) *prometheus.Desc {
	return prometheus.NewDesc(name, help, labels, nil)
}

var (
	dPageviews   = desc("blog_pageviews", "Human pageviews on support.tools in the window (bot filter applied).", "window")
	dVisitors    = desc("blog_visitors", "Unique human visitors in the window.", "window")
	dBot         = desc("blog_bot_pageviews", "Pageviews removed by the shared bot filter in the window.", "window")
	dChannel     = desc("blog_pageviews_by_channel", "Human pageviews by traffic channel.", "window", "channel")
	dTopic       = desc("blog_pageviews_by_topic", "Article pageviews by topic (top 20 by 28-day pageviews, rest in other).", "window", "topic")
	dReads       = desc("blog_article_reads", "article_read events (75% of the article, 30 s visible) by topic.", "window", "topic")
	dReadRate    = desc("blog_read_rate", "article_read events per article pageview, by topic.", "window", "topic")
	dKind        = desc("blog_pageviews_by_kind", "Human pageviews by post kind; page means not an article.", "window", "kind")
	dTopPost     = desc("blog_top_post_pageviews", "Pageviews of the top 20 articles.", "window", "rank", "slug")
	dSClicks     = desc("blog_search_clicks", "Google Search clicks (window ends 3 days ago).", "window")
	dSImpr       = desc("blog_search_impressions", "Google Search impressions (window ends 3 days ago).", "window")
	dSCTR        = desc("blog_search_ctr", "Google Search click-through rate, 0 to 1.", "window")
	dSPos        = desc("blog_search_position", "Google Search average position.", "window")
	dSClicksT    = desc("blog_search_clicks_by_topic", "Google Search clicks by topic.", "window", "topic")
	dSImprT      = desc("blog_search_impressions_by_topic", "Google Search impressions by topic.", "window", "topic")
	dSTop3CTR    = desc("blog_search_top3_ctr", "Google Search click-through rate, 0 to 1, over visible query rows at average position <= 3 (anonymized queries excluded).", "window")
	dSTop10Impr  = desc("blog_search_top10_impressions", "Google Search impressions over visible query rows at average position <= 10 (anonymized queries excluded).", "window")
	dSStablePos  = desc("blog_search_stable_query_median_position", "Median average position of visible queries with at least "+strconv.Itoa(StableMinImpressions)+" impressions in the window.", "window")
	dUp          = desc("blog_metrics_source_up", "1 when the source's last poll succeeded.", "source")
	dLastSuccess = desc("blog_metrics_source_last_success_timestamp_seconds", "Unix time of the source's last successful poll.", "source")
	dSocial      = map[string]*prometheus.Desc{}
)

func init() {
	for metric, help := range map[string]string{
		"posts":       "Posts published through Buffer.",
		"reactions":   "Reactions on Buffer posts.",
		"comments":    "Comments on Buffer posts.",
		"impressions": "Impressions of Buffer posts (LinkedIn only).",
		"reach":       "Unique people reached by Buffer posts (LinkedIn only).",
	} {
		dSocial[metric] = desc("blog_social_"+metric, help, "window", "channel")
	}
}

func (c collector) Collect(ch chan<- prometheus.Metric) {
	v := c.store.Get()
	gauge := func(d *prometheus.Desc, val float64, labels ...string) {
		ch <- prometheus.MustNewConstMetric(d, prometheus.GaugeValue, val, labels...)
	}
	byKey := func(d *prometheus.Desc, m map[Window]map[string]float64) {
		for w, kv := range m {
			for k, val := range kv {
				gauge(d, val, string(w), k)
			}
		}
	}
	keep := classify.TopKeys(v.Search.ClicksByTopic[W28d], topTopics)
	if v.Status[SourcePostHog].HasData {
		keep = classify.TopKeys(v.Traffic.Topics[W28d], topTopics)
	}
	bucket := func(m map[Window]map[string]float64) map[Window]map[string]float64 {
		out := make(map[Window]map[string]float64, len(m))
		for w, kv := range m {
			out[w] = classify.Bucket(kv, keep, "other")
		}
		return out
	}

	for _, s := range Sources {
		st := v.Status[s]
		up := 0.0
		if st.Up {
			up = 1
		}
		gauge(dUp, up, s)
		if st.HasData {
			gauge(dLastSuccess, float64(st.LastSuccess.Unix()), s)
		}
	}

	if v.Status[SourcePostHog].HasData {
		t := v.Traffic
		for w, val := range t.Pageviews {
			gauge(dPageviews, val, string(w))
		}
		for w, val := range t.Visitors {
			gauge(dVisitors, val, string(w))
		}
		for w, val := range t.Bot {
			gauge(dBot, val, string(w))
		}
		byKey(dChannel, t.Channels)
		topics, reads := bucket(t.Topics), bucket(t.Reads)
		byKey(dTopic, topics)
		byKey(dReads, reads)
		byKey(dKind, t.Kinds)
		for w, pv := range topics {
			for topic, n := range pv {
				if n > 0 {
					gauge(dReadRate, reads[w][topic]/n, string(w), topic)
				}
			}
		}
		for w, posts := range t.TopPosts {
			for i, p := range posts {
				gauge(dTopPost, p.Pageviews, string(w), strconv.Itoa(i+1), p.Slug)
			}
		}
	}

	if v.Status[SourceGSC].HasData {
		for w, t := range v.Search.Totals {
			gauge(dSClicks, t.Clicks, string(w))
			gauge(dSImpr, t.Impressions, string(w))
			gauge(dSCTR, t.CTR, string(w))
			gauge(dSPos, t.Position, string(w))
		}
		byKey(dSClicksT, bucket(v.Search.ClicksByTopic))
		byKey(dSImprT, bucket(v.Search.ImpressionsByTopic))
		// Ratios and medians with nothing to measure are left out, never NaN or 0.
		for w, sp := range v.Search.SERP {
			gauge(dSTop10Impr, sp.Top10Impressions, string(w))
			if ctr, ok := sp.Top3CTR(); ok {
				gauge(dSTop3CTR, ctr, string(w))
			}
			if sp.StableQueries > 0 {
				gauge(dSStablePos, sp.StableMedianPosition, string(w))
			}
		}
	}

	if v.Status[SourceBuffer].HasData {
		for w, channels := range v.Social.Metrics {
			for channel, metrics := range channels {
				for metric, val := range metrics {
					if d, ok := dSocial[metric]; ok {
						gauge(d, val, string(w), channel)
					}
				}
			}
		}
	}
}
