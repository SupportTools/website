// Package buildinfo reads the site's /build.json, which Hugo writes on every
// build, so the exporter can report how old the live site is. A deploy that
// stops reaching production shows up as a build time that stops moving.
package buildinfo

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// Fetch returns the time the live site was built.
func Fetch(ctx context.Context, buildURL string, hc *http.Client) (time.Time, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, buildURL, nil)
	if err != nil {
		return time.Time{}, err
	}
	resp, err := hc.Do(req)
	if err != nil {
		return time.Time{}, fmt.Errorf("build info: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return time.Time{}, fmt.Errorf("build info: HTTP %d", resp.StatusCode)
	}
	var b struct {
		BuiltAt int64 `json:"built_at"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&b); err != nil {
		return time.Time{}, fmt.Errorf("build info: decode: %w", err)
	}
	if b.BuiltAt <= 0 {
		return time.Time{}, fmt.Errorf("build info: no built_at")
	}
	return time.Unix(b.BuiltAt, 0), nil
}
