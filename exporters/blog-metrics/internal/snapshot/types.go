// Package snapshot holds the exporter's last good numbers per source and turns
// them into Prometheus metrics and the /report JSON.
package snapshot

// Window is a trailing time window label.
type Window string

const (
	W1d  Window = "1d"
	W7d  Window = "7d"
	W28d Window = "28d"
)

// TrafficWindows are the PostHog windows; LongWindows are the GSC and Buffer ones.
var (
	TrafficWindows = []Window{W1d, W7d, W28d}
	LongWindows    = []Window{W7d, W28d}
)

// Ranked is one top post.
type Ranked struct {
	Slug      string  `json:"slug"`
	Pageviews float64 `json:"pageviews"`
}

// Traffic is what the PostHog source reports, bot excluded (except Bot).
type Traffic struct {
	Pageviews map[Window]float64
	Visitors  map[Window]float64
	Bot       map[Window]float64
	Channels  map[Window]map[string]float64
	Topics    map[Window]map[string]float64 // article pageviews by topic
	Reads     map[Window]map[string]float64 // article_read events by topic
	Kinds     map[Window]map[string]float64
	TopPosts  map[Window][]Ranked
}

// Totals are Search Console totals for one window.
type Totals struct {
	Clicks      float64 `json:"clicks"`
	Impressions float64 `json:"impressions"`
	CTR         float64 `json:"ctr"`
	Position    float64 `json:"position"`
}

// Query is one search query this week against the week before.
type Query struct {
	Query           string  `json:"query"`
	Clicks          float64 `json:"clicks"`
	Impressions     float64 `json:"impressions"`
	Position        float64 `json:"position"`
	PrevClicks      float64 `json:"prev_clicks"`
	PrevImpressions float64 `json:"prev_impressions"`
	PrevPosition    float64 `json:"prev_position"`
}

// SERP bands one window's query rows by average position, to tell a click-through
// loss at a stable position (an AI answer above the result) from a ranking loss.
// It covers visible queries only: Search Console leaves anonymized queries out of
// query rows, so QueryImpressions is below the window's total impressions.
type SERP struct {
	QueryRows        int     // query rows in the window
	QueryImpressions float64 // impressions over those rows
	Top3Clicks       float64 // clicks over rows at position <= 3
	Top3Impressions  float64 // impressions over rows at position <= 3
	Top10Impressions float64 // impressions over rows at position <= 10
	// StableQueries counts rows with at least StableMinImpressions impressions;
	// StableMedianPosition is the median of their positions (0 when there are none).
	StableQueries        int
	StableMedianPosition float64
}

// StableMinImpressions is the impressions floor for the stable query set.
const StableMinImpressions = 10

// Top3CTR is clicks per impression at position <= 3; ok is false with no such impressions.
func (s SERP) Top3CTR() (ctr float64, ok bool) {
	if s.Top3Impressions <= 0 {
		return 0, false
	}
	return s.Top3Clicks / s.Top3Impressions, true
}

// Search is what the Search Console source reports.
type Search struct {
	Totals             map[Window]Totals
	ClicksByTopic      map[Window]map[string]float64
	ImpressionsByTopic map[Window]map[string]float64
	SERP               map[Window]SERP // set for each window whose query rows were read
	Queries            []Query
	ArticlesByTopic    map[string]float64 // published articles per topic, from post-index.json
}

// Social is what the Buffer source reports: window, channel, metric, value.
type Social struct {
	Metrics map[Window]map[string]map[string]float64
}
