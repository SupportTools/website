package main

import (
	"strings"
	"testing"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func full() map[string]string {
	return map[string]string{
		"POSTHOG_PROJECT_ID": "78897", "POSTHOG_API_KEY": "phx", "GSC_KEY_JSON": "{}",
		"BUFFER_API_KEY": "buf", "BUFFER_ORG_ID": "org", "BUFFER_CHANNELS": "linkedin=a, bluesky=b",
	}
}

func TestConfigDefaultsAndChannels(t *testing.T) {
	c, err := loadConfig(env(full()))
	if err != nil {
		t.Fatal(err)
	}
	if c.PostHogURL != "https://us.posthog.com" || c.SiteHost != "support.tools" || c.GSCSite != "sc-domain:support.tools" ||
		c.BufferURL != "https://api.buffer.com" || c.PostIndexURL != "https://support.tools/post-index.json" ||
		c.BuildInfoURL != "https://support.tools/build.json" || c.Listen != ":8080" {
		t.Fatalf("defaults = %+v", c)
	}
	if len(c.BufferChannels) != 2 || c.BufferChannels["linkedin"] != "a" || c.BufferChannels["bluesky"] != "b" {
		t.Fatalf("channels = %v", c.BufferChannels)
	}
}

func TestConfigRequiresKeys(t *testing.T) {
	for _, k := range []string{"POSTHOG_PROJECT_ID", "POSTHOG_API_KEY", "GSC_KEY_JSON", "BUFFER_API_KEY", "BUFFER_ORG_ID", "BUFFER_CHANNELS"} {
		m := full()
		delete(m, k)
		_, err := loadConfig(env(m))
		if err == nil || !strings.Contains(err.Error(), k) {
			t.Fatalf("without %s: err = %v", k, err)
		}
	}
}

func TestConfigRejectsBadChannels(t *testing.T) {
	m := full()
	m["BUFFER_CHANNELS"] = "linkedin"
	if _, err := loadConfig(env(m)); err == nil {
		t.Fatal("want error for a channel without an ID")
	}
}
