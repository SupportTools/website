package main

import (
	"fmt"
	"strings"
)

// Config comes from env vars; credentials are filled by the ExternalSecret.
type Config struct {
	PostHogURL       string
	PostHogProjectID string
	PostHogAPIKey    string
	SiteHost         string
	GSCKeyJSON       string
	GSCSite          string
	GSCURL           string
	GSCTokenURL      string
	BufferURL        string
	BufferAPIKey     string
	BufferOrgID      string
	BufferChannels   map[string]string // label -> Buffer channel ID
	PostIndexURL     string
	BuildInfoURL     string
	Listen           string
}

func loadConfig(getenv func(string) string) (Config, error) {
	var missing []string
	get := func(key, def string) string {
		if v := strings.TrimSpace(getenv(key)); v != "" {
			return v
		}
		if def == "" {
			missing = append(missing, key)
		}
		return def
	}
	c := Config{
		PostHogURL:       get("POSTHOG_URL", "https://us.posthog.com"),
		PostHogProjectID: get("POSTHOG_PROJECT_ID", ""),
		PostHogAPIKey:    get("POSTHOG_API_KEY", ""),
		SiteHost:         get("SITE_HOST", "support.tools"),
		GSCKeyJSON:       get("GSC_KEY_JSON", ""),
		GSCSite:          get("GSC_SITE", "sc-domain:support.tools"),
		GSCURL:           get("GSC_URL", "https://searchconsole.googleapis.com"),
		GSCTokenURL:      get("GSC_TOKEN_URL", "https://oauth2.googleapis.com/token"),
		BufferURL:        get("BUFFER_URL", "https://api.buffer.com"),
		BufferAPIKey:     get("BUFFER_API_KEY", ""),
		BufferOrgID:      get("BUFFER_ORG_ID", ""),
		PostIndexURL:     get("POST_INDEX_URL", "https://support.tools/post-index.json"),
		BuildInfoURL:     get("BUILD_INFO_URL", "https://support.tools/build.json"),
		Listen:           get("LISTEN_ADDR", ":8080"),
	}
	channels := get("BUFFER_CHANNELS", "")
	if len(missing) > 0 {
		return c, fmt.Errorf("missing required env: %s", strings.Join(missing, ", "))
	}
	c.BufferChannels = map[string]string{}
	for _, pair := range strings.Split(channels, ",") {
		name, id, ok := strings.Cut(strings.TrimSpace(pair), "=")
		if !ok || name == "" || id == "" {
			return c, fmt.Errorf("BUFFER_CHANNELS: want name=id[,name=id], got %q", pair)
		}
		c.BufferChannels[name] = id
	}
	return c, nil
}
