package postindex

import (
	"context"
	"io"
	"net/http"
	"testing"

	"github.com/supporttools/website/exporters/blog-metrics/internal/testsrv"
)

func TestSlugFromURL(t *testing.T) {
	for in, want := range map[string]string{
		"https://support.tools/curl-host-header/":                "curl-host-header",
		"https://support.tools/known-good-designs/a/b/?x=1#frag": "known-good-designs/a/b",
		"https://support.tools/":                                 "",
		"https://support.tools/post/old-slug":                    "post/old-slug",
		"not a url %%":                                           "",
	} {
		if got := SlugFromURL(in); got != want {
			t.Errorf("SlugFromURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestFetchIndex(t *testing.T) {
	srv := testsrv.New(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `[{"post_slug":"curl-host-header","post_category":"networking","post_kind":"guide"},
			{"post_slug":"no-topic","post_category":""},
			{"post_slug":"kgd/a","post_category":"rancher"}]`)
	}))
	defer srv.Close()
	got, err := Fetch(context.Background(), srv.URL, http.DefaultClient)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got["curl-host-header"] != "networking" || got["kgd/a"] != "rancher" {
		t.Fatalf("Fetch = %v", got)
	}
}

func TestFetchIndexRejectsBadStatusAndEmpty(t *testing.T) {
	for _, tc := range []struct {
		status int
		body   string
	}{{500, "oops"}, {200, "[]"}} {
		srv := testsrv.New(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(tc.status)
			io.WriteString(w, tc.body)
		}))
		if _, err := Fetch(context.Background(), srv.URL, http.DefaultClient); err == nil {
			t.Errorf("status %d body %q: want error", tc.status, tc.body)
		}
		srv.Close()
	}
}
