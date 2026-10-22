// Package classify maps raw analytics values onto the exporter's bounded label
// sets, so Prometheus never sees a label per URL, domain or query.
package classify

import (
	"sort"
	"strings"
)

// Channels is the full channel label set, in display order.
var Channels = []string{
	"google", "bing", "other_search", "ai_assistant", "direct",
	"linkedin", "bluesky", "reddit", "hackernews", "internal", "other",
}

// Kinds is the full post kind label set. "page" is any event without a post kind.
var Kinds = []string{"troubleshooting", "incident", "guide", "reference", "page"}

var (
	aiDomains = []string{
		"chatgpt.com", "chat.openai.com", "copilot.com", "copilot.microsoft.com",
		"gemini.google.com", "perplexity.ai", "claude.ai",
	}
	aiSources    = []string{"chatgpt.com", "copilot.com", "gemini", "perplexity"}
	otherSearch  = []string{"duckduckgo", "yahoo", "yandex", "baidu", "ecosia", "qwant", "search.brave", "startpage"}
	socialByHost = map[string]string{
		"linkedin.com": "linkedin", "lnkd.in": "linkedin",
		"bsky.app":   "bluesky",
		"reddit.com": "reddit", "old.reddit.com": "reddit", "out.reddit.com": "reddit",
		"news.ycombinator.com": "hackernews",
	}
)

// hostIs reports whether host is domain or a subdomain of it.
func hostIs(host, domain string) bool {
	return host == domain || strings.HasSuffix(host, "."+domain)
}

// Channel classifies a pageview by its referring domain and utm_source. Our own
// UTM tags win, then AI assistants (checked before Google, so gemini.google.com
// is not search), then search engines, social sites and everything else.
func Channel(referringDomain, utmSource string) string {
	host := strings.ToLower(strings.TrimSpace(referringDomain))
	utm := strings.ToLower(strings.TrimSpace(utmSource))

	switch utm {
	case "linkedin", "bluesky":
		return utm
	}
	for _, s := range aiSources {
		if utm == s {
			return "ai_assistant"
		}
	}
	if host == "" || host == "$direct" {
		return "direct"
	}
	if hostIs(host, "support.tools") {
		return "internal"
	}
	for _, d := range aiDomains {
		if hostIs(host, d) {
			return "ai_assistant"
		}
	}
	if strings.HasPrefix(host, "google.") || strings.HasPrefix(host, "www.google.") {
		return "google"
	}
	if hostIs(host, "bing.com") {
		return "bing"
	}
	for _, s := range otherSearch {
		if strings.Contains(host, s) {
			return "other_search"
		}
	}
	for d, ch := range socialByHost {
		if hostIs(host, d) {
			return ch
		}
	}
	return "other"
}

// Kind returns v when it is a known post kind, otherwise "page".
func Kind(v string) string {
	for _, k := range Kinds {
		if v == k {
			return v
		}
	}
	return "page"
}

// TopKeys returns the n keys with the largest values, largest first; ties break
// by key, ascending. Empty keys are ignored.
func TopKeys(m map[string]float64, n int) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		if k != "" {
			keys = append(keys, k)
		}
	}
	sort.Slice(keys, func(i, j int) bool {
		if m[keys[i]] != m[keys[j]] {
			return m[keys[i]] > m[keys[j]]
		}
		return keys[i] < keys[j]
	})
	if len(keys) > n {
		keys = keys[:n]
	}
	return keys
}

// TopN keeps the n largest entries of m and sums the rest into other. other is
// left out when nothing falls into it. Empty keys are dropped.
func TopN(m map[string]float64, n int, other string) map[string]float64 {
	return Bucket(m, TopKeys(m, n), other)
}

// Bucket keeps the keys in keep and sums every other non-empty key into other,
// so several windows can share one top set.
func Bucket(m map[string]float64, keep []string, other string) map[string]float64 {
	kept := make(map[string]bool, len(keep))
	for _, k := range keep {
		kept[k] = true
	}
	out := make(map[string]float64, len(keep)+1)
	for k, v := range m {
		switch {
		case k == "":
		case kept[k]:
			out[k] += v
		default:
			out[other] += v
		}
	}
	if out[other] == 0 {
		delete(out, other)
	}
	return out
}
