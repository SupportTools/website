// Package postindex reads the site's /post-index.json, which maps each article
// to its topic, so Search Console pages can be grouped by topic.
package postindex

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// Fetch returns slug -> topic for every article with a topic.
func Fetch(ctx context.Context, indexURL string, hc *http.Client) (map[string]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, indexURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("post index: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("post index: HTTP %d", resp.StatusCode)
	}
	var posts []struct {
		Slug     string `json:"post_slug"`
		Category string `json:"post_category"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&posts); err != nil {
		return nil, fmt.Errorf("post index: decode: %w", err)
	}
	out := make(map[string]string, len(posts))
	for _, p := range posts {
		if p.Slug != "" && p.Category != "" {
			out[p.Slug] = p.Category
		}
	}
	if len(out) == 0 {
		// An empty index would send every search click to "other"; keep the last good one.
		return nil, fmt.Errorf("post index: no articles with a topic")
	}
	return out, nil
}

// SlugFromURL turns https://support.tools/a/b/?q=1 into "a/b".
func SlugFromURL(u string) string {
	p, err := url.Parse(u)
	if err != nil {
		return ""
	}
	return strings.Trim(p.Path, "/")
}
