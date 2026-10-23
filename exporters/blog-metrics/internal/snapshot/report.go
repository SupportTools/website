package snapshot

import (
	"sort"
	"time"
)

// TopicRow joins traffic, reading and search numbers for one topic.
type TopicRow struct {
	Topic            string  `json:"topic"`
	Pageviews7d      float64 `json:"pageviews_7d"`
	Pageviews28d     float64 `json:"pageviews_28d"`
	Reads28d         float64 `json:"reads_28d"`
	ReadRate28d      float64 `json:"read_rate_28d"`
	SearchClicks28d  float64 `json:"search_clicks_28d"`
	SearchImpr28d    float64 `json:"search_impressions_28d"`
	Articles         float64 `json:"articles"`
	PageviewsPerPost float64 `json:"pageviews_per_article_28d"`
}

type trafficReport struct {
	Pageviews map[Window]float64            `json:"pageviews"`
	Visitors  map[Window]float64            `json:"visitors"`
	Bot       map[Window]float64            `json:"bot_pageviews"`
	Channels  map[Window]map[string]float64 `json:"channels"`
	Kinds     map[Window]map[string]float64 `json:"kinds"`
}

type searchReport struct {
	Totals  map[Window]Totals     `json:"totals"`
	SERP    map[Window]serpReport `json:"serp"`
	Queries []Query               `json:"queries"`
}

// serpReport is one window's SERP numbers; a ratio or median with nothing to
// measure is null.
type serpReport struct {
	QueryRows            int      `json:"query_rows"`
	QueryImpressions     float64  `json:"query_impressions"`
	Top3Clicks           float64  `json:"top3_clicks"`
	Top3Impressions      float64  `json:"top3_impressions"`
	Top3CTR              *float64 `json:"top3_ctr"`
	Top10Impressions     float64  `json:"top10_impressions"`
	StableMinImpressions int      `json:"stable_min_impressions"`
	StableQueries        int      `json:"stable_queries"`
	StableMedianPosition *float64 `json:"stable_median_position"`
}

func serpReports(m map[Window]SERP) map[Window]serpReport {
	out := make(map[Window]serpReport, len(m))
	for w, s := range m {
		r := serpReport{
			QueryRows: s.QueryRows, QueryImpressions: s.QueryImpressions,
			Top3Clicks: s.Top3Clicks, Top3Impressions: s.Top3Impressions, Top10Impressions: s.Top10Impressions,
			StableMinImpressions: StableMinImpressions, StableQueries: s.StableQueries,
		}
		if ctr, ok := s.Top3CTR(); ok {
			r.Top3CTR = &ctr
		}
		if s.StableQueries > 0 {
			pos := s.StableMedianPosition
			r.StableMedianPosition = &pos
		}
		out[w] = r
	}
	return out
}

// ReportDoc is the /report JSON the weekly scorecard reads.
type ReportDoc struct {
	GeneratedAt time.Time                                `json:"generated_at"`
	Sources     map[string]Status                        `json:"sources"`
	Traffic     trafficReport                            `json:"traffic"`
	Topics      []TopicRow                               `json:"topics"`
	TopPosts    map[Window][]Ranked                      `json:"top_posts"`
	Search      searchReport                             `json:"search"`
	Social      map[Window]map[string]map[string]float64 `json:"social"`
}

// Report builds the /report document from a store view.
func Report(v View) ReportDoc {
	t, s := v.Traffic, v.Search
	rows := map[string]*TopicRow{}
	row := func(topic string) *TopicRow {
		if rows[topic] == nil {
			rows[topic] = &TopicRow{Topic: topic}
		}
		return rows[topic]
	}
	for topic, n := range t.Topics[W28d] {
		r := row(topic)
		r.Pageviews28d = n
		r.Pageviews7d = t.Topics[W7d][topic]
		r.Reads28d = t.Reads[W28d][topic]
		if n > 0 {
			r.ReadRate28d = r.Reads28d / n
		}
	}
	for topic, n := range s.ClicksByTopic[W28d] {
		row(topic).SearchClicks28d = n
		row(topic).SearchImpr28d = s.ImpressionsByTopic[W28d][topic]
	}
	out := make([]TopicRow, 0, len(rows))
	for topic, r := range rows {
		r.Articles = s.ArticlesByTopic[topic]
		if r.Articles > 0 {
			r.PageviewsPerPost = r.Pageviews28d / r.Articles
		}
		out = append(out, *r)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Pageviews28d != out[j].Pageviews28d {
			return out[i].Pageviews28d > out[j].Pageviews28d
		}
		return out[i].Topic < out[j].Topic
	})
	return ReportDoc{
		GeneratedAt: v.At.UTC(),
		Sources:     v.Status,
		Traffic: trafficReport{
			Pageviews: t.Pageviews, Visitors: t.Visitors, Bot: t.Bot, Channels: t.Channels, Kinds: t.Kinds,
		},
		Topics:   out,
		TopPosts: t.TopPosts,
		Search:   searchReport{Totals: s.Totals, SERP: serpReports(s.SERP), Queries: s.Queries},
		Social:   v.Social.Metrics,
	}
}
