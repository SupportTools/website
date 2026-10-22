package classify

import (
	"fmt"
	"testing"
)

func TestChannel(t *testing.T) {
	cases := []struct {
		domain, utm, want string
	}{
		{"www.google.com", "", "google"},
		{"google.co.uk", "", "google"},
		{"www.google.com", "linkedin", "linkedin"},
		{"$direct", "bluesky", "bluesky"},
		{"$direct", "", "direct"},
		{"", "", "direct"},
		{"support.tools", "", "internal"},
		{"stg.support.tools", "", "internal"},
		{"www.bing.com", "", "bing"},
		{"duckduckgo.com", "", "other_search"},
		{"search.brave.com", "", "other_search"},
		{"gemini.google.com", "", "ai_assistant"},
		{"chatgpt.com", "", "ai_assistant"},
		{"$direct", "chatgpt.com", "ai_assistant"},
		{"$direct", "copilot.com", "ai_assistant"},
		{"www.linkedin.com", "", "linkedin"},
		{"lnkd.in", "", "linkedin"},
		{"bsky.app", "", "bluesky"},
		{"old.reddit.com", "", "reddit"},
		{"news.ycombinator.com", "", "hackernews"},
		{"es.gridinsoft.com", "", "other"},
		{"WWW.Google.COM", "", "google"},
	}
	for _, c := range cases {
		t.Run(fmt.Sprintf("%s/%s", c.domain, c.utm), func(t *testing.T) {
			if got := Channel(c.domain, c.utm); got != c.want {
				t.Fatalf("Channel(%q, %q) = %q, want %q", c.domain, c.utm, got, c.want)
			}
		})
	}
}

func TestChannelIsAlwaysInTheBoundedSet(t *testing.T) {
	allowed := map[string]bool{}
	for _, c := range Channels {
		allowed[c] = true
	}
	for _, d := range []string{"", "$direct", "x.y", "google", "üñí.com", "a b"} {
		if got := Channel(d, d); !allowed[got] {
			t.Fatalf("Channel(%q) = %q, not in Channels", d, got)
		}
	}
}

func TestKind(t *testing.T) {
	for in, want := range map[string]string{
		"guide": "guide", "incident": "incident", "troubleshooting": "troubleshooting",
		"reference": "reference", "": "page", "weird": "page", "page": "page",
	} {
		if got := Kind(in); got != want {
			t.Fatalf("Kind(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestTopN(t *testing.T) {
	m := map[string]float64{"": 99}
	for i := 0; i < 22; i++ {
		m[fmt.Sprintf("t%02d", i)] = float64(i + 1)
	}
	got := TopN(m, 20, "other")
	if len(got) != 21 {
		t.Fatalf("len = %d, want 21 (20 + other)", len(got))
	}
	if _, ok := got[""]; ok {
		t.Fatal("empty key kept")
	}
	if got["other"] != 1+2 {
		t.Fatalf("other = %v, want 3 (t00 + t01)", got["other"])
	}
	if got["t21"] != 22 {
		t.Fatalf("t21 = %v, want 22", got["t21"])
	}
}

func TestTopNTiesBreakByKeyAndNoEmptyOther(t *testing.T) {
	got := TopN(map[string]float64{"b": 1, "a": 1, "c": 1}, 2, "other")
	if _, ok := got["c"]; ok || got["a"] != 1 || got["b"] != 1 || got["other"] != 1 {
		t.Fatalf("got %v, want a, b kept and c in other", got)
	}
	got = TopN(map[string]float64{"a": 1}, 20, "other")
	if _, ok := got["other"]; ok {
		t.Fatalf("other present with zero: %v", got)
	}
}

func TestTopKeysOrder(t *testing.T) {
	keys := TopKeys(map[string]float64{"a": 1, "b": 3, "c": 2, "": 9}, 2)
	if fmt.Sprint(keys) != "[b c]" {
		t.Fatalf("TopKeys = %v, want [b c]", keys)
	}
}
