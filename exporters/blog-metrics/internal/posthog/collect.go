package posthog

import (
	"context"
	"fmt"

	"github.com/supporttools/website/exporters/blog-metrics/internal/botfilter"
	"github.com/supporttools/website/exporters/blog-metrics/internal/classify"
	"github.com/supporttools/website/exporters/blog-metrics/internal/snapshot"
)

const topTopics = 20
const topPosts = 20

// windowCounts are the three window columns every grouped query returns, in the
// order of snapshot.TrafficWindows (1d, 7d, 28d). Queries scan 28 days.
const windowCounts = `countIf(timestamp > now() - INTERVAL 1 DAY), countIf(timestamp > now() - INTERVAL 7 DAY), count()`

// Collect reads the traffic numbers for host, with the bot excluded everywhere
// except the bot count itself.
func Collect(ctx context.Context, c *Client, host string) (snapshot.Traffic, error) {
	tr := snapshot.Traffic{
		Pageviews: map[snapshot.Window]float64{},
		Visitors:  map[snapshot.Window]float64{},
		Bot:       map[snapshot.Window]float64{},
		Channels:  windowMaps(),
		Topics:    windowMaps(),
		Reads:     windowMaps(),
		Kinds:     windowMaps(),
		TopPosts:  map[snapshot.Window][]snapshot.Ranked{},
	}
	scope := func(filter string) string {
		return fmt.Sprintf("timestamp > now() - INTERVAL 28 DAY AND properties.$host = '%s' AND %s", host, filter)
	}
	human, bot := scope(botfilter.Human()), scope(botfilter.Bot())

	rows, err := c.Query(ctx, `SELECT `+windowCounts+`,
		uniqIf(distinct_id, timestamp > now() - INTERVAL 1 DAY), uniqIf(distinct_id, timestamp > now() - INTERVAL 7 DAY), uniq(distinct_id)
		FROM events WHERE event = '$pageview' AND `+human)
	if err != nil {
		return tr, fmt.Errorf("totals: %w", err)
	}
	if len(rows) == 1 && len(rows[0]) == 6 {
		for i, w := range snapshot.TrafficWindows {
			tr.Pageviews[w] = toFloat(rows[0][i])
			tr.Visitors[w] = toFloat(rows[0][3+i])
		}
	}

	rows, err = c.Query(ctx, `SELECT `+windowCounts+` FROM events WHERE event = '$pageview' AND `+bot)
	if err != nil {
		return tr, fmt.Errorf("bot: %w", err)
	}
	if len(rows) == 1 && len(rows[0]) == 3 {
		for i, w := range snapshot.TrafficWindows {
			tr.Bot[w] = toFloat(rows[0][i])
		}
	}

	rows, err = c.Query(ctx, `SELECT properties.$referring_domain, properties.utm_source, `+windowCounts+`
		FROM events WHERE event = '$pageview' AND `+human+` GROUP BY 1, 2`)
	if err != nil {
		return tr, fmt.Errorf("channels: %w", err)
	}
	for _, r := range rows {
		if len(r) != 5 {
			continue
		}
		ch := classify.Channel(str(r[0]), str(r[1]))
		addWindows(tr.Channels, ch, r[2:])
	}

	rows, err = c.Query(ctx, `SELECT properties.post_category, event, `+windowCounts+`
		FROM events WHERE event IN ('$pageview', 'article_read') AND `+human+` GROUP BY 1, 2`)
	if err != nil {
		return tr, fmt.Errorf("topics: %w", err)
	}
	topics, reads := windowMaps(), windowMaps()
	for _, r := range rows {
		if len(r) != 5 || str(r[0]) == "" {
			continue
		}
		if str(r[1]) == "article_read" {
			addWindows(reads, str(r[0]), r[2:])
		} else {
			addWindows(topics, str(r[0]), r[2:])
		}
	}
	keep := classify.TopKeys(topics[snapshot.W28d], topTopics)
	for _, w := range snapshot.TrafficWindows {
		tr.Topics[w] = classify.Bucket(topics[w], keep, "other")
		tr.Reads[w] = classify.Bucket(reads[w], keep, "other")
	}

	rows, err = c.Query(ctx, `SELECT properties.post_kind, `+windowCounts+`
		FROM events WHERE event = '$pageview' AND `+human+` GROUP BY 1`)
	if err != nil {
		return tr, fmt.Errorf("kinds: %w", err)
	}
	for _, r := range rows {
		if len(r) != 4 {
			continue
		}
		addWindows(tr.Kinds, classify.Kind(str(r[0])), r[1:])
	}

	for _, w := range snapshot.LongWindows {
		days := map[snapshot.Window]int{snapshot.W7d: 7, snapshot.W28d: 28}[w]
		rows, err = c.Query(ctx, fmt.Sprintf(`SELECT properties.post_slug AS s, count() AS c
			FROM events WHERE event = '$pageview' AND timestamp > now() - INTERVAL %d DAY AND properties.post_slug IS NOT NULL AND properties.post_slug != ''
			AND properties.$host = '%s' AND %s GROUP BY s ORDER BY c DESC, s LIMIT %d`, days, host, botfilter.Human(), topPosts))
		if err != nil {
			return tr, fmt.Errorf("top posts %s: %w", w, err)
		}
		for _, r := range rows {
			if len(r) == 2 && str(r[0]) != "" {
				tr.TopPosts[w] = append(tr.TopPosts[w], snapshot.Ranked{Slug: str(r[0]), Pageviews: toFloat(r[1])})
			}
		}
	}
	return tr, nil
}

func windowMaps() map[snapshot.Window]map[string]float64 {
	m := map[snapshot.Window]map[string]float64{}
	for _, w := range snapshot.TrafficWindows {
		m[w] = map[string]float64{}
	}
	return m
}

// addWindows adds the three window cells to key in each window's map.
func addWindows(m map[snapshot.Window]map[string]float64, key string, cells []any) {
	for i, w := range snapshot.TrafficWindows {
		m[w][key] += toFloat(cells[i])
	}
}
