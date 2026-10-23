package gsc

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/supporttools/website/exporters/blog-metrics/internal/postindex"
	"github.com/supporttools/website/exporters/blog-metrics/internal/snapshot"
)

// Search Console data lags 2 to 3 days, so every window ends 3 days ago.
const lagDays = 3

const (
	topTopics  = 20
	topQueries = 50
	pageRows   = 5000
	dateLayout = "2006-01-02"
	otherTopic = "other"
)

func day(now time.Time, back int) string {
	y, m, d := now.UTC().Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC).AddDate(0, 0, -back).Format(dateLayout)
}

// Windows returns each window's [start, end] dates: 7 and 28 whole days ending lagDays ago (UTC).
func Windows(now time.Time) map[snapshot.Window][2]string {
	return map[snapshot.Window][2]string{
		snapshot.W7d:  {day(now, lagDays+6), day(now, lagDays)},
		snapshot.W28d: {day(now, lagDays+27), day(now, lagDays)},
	}
}

// PrevWeek is the 7 days before the 7d window, for week-over-week query changes.
func PrevWeek(now time.Time) [2]string {
	return [2]string{day(now, lagDays+13), day(now, lagDays+7)}
}

// Collect reads totals, clicks and impressions by topic, the SERP position bands,
// and the top queries. topics maps article slugs to topics (from post-index.json);
// pages that are not articles count as "other".
func Collect(ctx context.Context, c *Client, topics map[string]string, now time.Time) (snapshot.Search, error) {
	s := snapshot.Search{
		Totals:             map[snapshot.Window]snapshot.Totals{},
		ClicksByTopic:      map[snapshot.Window]map[string]float64{},
		ImpressionsByTopic: map[snapshot.Window]map[string]float64{},
		SERP:               map[snapshot.Window]snapshot.SERP{},
	}
	var week []Row // the 7d query rows, reused for the top queries
	for w, r := range Windows(now) {
		// Every query row, not a click-ordered top N: the bands and the stable set
		// need low-click rows too. Usually one request per window.
		rows, err := c.QueryAll(ctx, r[0], r[1], []string{"query"})
		if err != nil {
			return s, fmt.Errorf("queries %s: %w", w, err)
		}
		s.SERP[w] = SERPStats(rows)
		if w == snapshot.W7d {
			week = rows
		}

		rows, err = c.Query(ctx, r[0], r[1], nil, 1)
		if err != nil {
			return s, fmt.Errorf("totals %s: %w", w, err)
		}
		if len(rows) > 0 {
			t := rows[0]
			s.Totals[w] = snapshot.Totals{Clicks: t.Clicks, Impressions: t.Impressions, CTR: t.CTR, Position: t.Position}
		}
		rows, err = c.Query(ctx, r[0], r[1], []string{"page"}, pageRows)
		if err != nil {
			return s, fmt.Errorf("pages %s: %w", w, err)
		}
		// All topics are kept here; the scrape and /report decide how to bucket them.
		clicks, impressions := map[string]float64{}, map[string]float64{}
		for _, row := range rows {
			if len(row.Keys) == 0 {
				continue
			}
			topic, ok := topics[postindex.SlugFromURL(row.Keys[0])]
			if !ok {
				topic = otherTopic
			}
			clicks[topic] += row.Clicks
			impressions[topic] += row.Impressions
		}
		s.ClicksByTopic[w], s.ImpressionsByTopic[w] = clicks, impressions
	}
	articles := map[string]float64{}
	for _, t := range topics {
		articles[t]++
	}
	s.ArticlesByTopic = articles

	queries := topByImpressions(week)
	prev, err := c.QueryAll(ctx, PrevWeek(now)[0], PrevWeek(now)[1], []string{"query"})
	if err != nil {
		return s, fmt.Errorf("previous week queries: %w", err)
	}
	before := map[string]Row{}
	for _, r := range prev {
		if len(r.Keys) > 0 {
			before[r.Keys[0]] = r
		}
	}
	for _, q := range queries {
		p := before[q.Keys[0]]
		s.Queries = append(s.Queries, snapshot.Query{
			Query: q.Keys[0], Clicks: q.Clicks, Impressions: q.Impressions, Position: q.Position,
			PrevClicks: p.Clicks, PrevImpressions: p.Impressions, PrevPosition: p.Position,
		})
	}
	return s, nil
}

// topByImpressions returns the topQueries query rows with the most impressions.
// It copies, so the caller's rows keep their order.
func topByImpressions(rows []Row) []Row {
	var kept []Row
	for _, row := range rows {
		if len(row.Keys) > 0 {
			kept = append(kept, row)
		}
	}
	sort.SliceStable(kept, func(i, j int) bool { return kept[i].Impressions > kept[j].Impressions })
	if len(kept) > topQueries {
		kept = kept[:topQueries]
	}
	return kept
}

// SERPStats bands query rows by average position and takes the median position
// of the stable set (rows with at least snapshot.StableMinImpressions
// impressions). Rows without a key are skipped.
func SERPStats(rows []Row) snapshot.SERP {
	var s snapshot.SERP
	var stable []float64
	for _, r := range rows {
		if len(r.Keys) == 0 {
			continue
		}
		s.QueryRows++
		s.QueryImpressions += r.Impressions
		if r.Position <= 3 {
			s.Top3Clicks += r.Clicks
			s.Top3Impressions += r.Impressions
		}
		if r.Position <= 10 {
			s.Top10Impressions += r.Impressions
		}
		if r.Impressions >= snapshot.StableMinImpressions {
			stable = append(stable, r.Position)
		}
	}
	s.StableQueries = len(stable)
	s.StableMedianPosition = median(stable)
	return s
}

// median sorts xs in place and returns its median, 0 for an empty slice.
func median(xs []float64) float64 {
	n := len(xs)
	if n == 0 {
		return 0
	}
	sort.Float64s(xs)
	if n%2 == 1 {
		return xs[n/2]
	}
	return (xs[n/2-1] + xs[n/2]) / 2
}
