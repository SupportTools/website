package buildinfo

import (
	"context"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/supporttools/website/exporters/blog-metrics/internal/testsrv"
)

func TestFetchBuildTime(t *testing.T) {
	srv := testsrv.New(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"built_at":1799990000}`)
	}))
	defer srv.Close()
	got, err := Fetch(context.Background(), srv.URL, http.DefaultClient)
	if err != nil {
		t.Fatal(err)
	}
	if !got.Equal(time.Unix(1_799_990_000, 0)) {
		t.Fatalf("Fetch = %v", got)
	}
}

// A page that is not the build file (an HTML 404 served with 200, or a file
// without the field) must fail the poll, not report a build at the Unix epoch.
func TestFetchBuildTimeRejectsBadResponses(t *testing.T) {
	for _, tc := range []struct {
		status int
		body   string
	}{{404, "not found"}, {200, "<!doctype html>"}, {200, `{}`}, {200, `{"built_at":0}`}} {
		srv := testsrv.New(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(tc.status)
			io.WriteString(w, tc.body)
		}))
		if _, err := Fetch(context.Background(), srv.URL, http.DefaultClient); err == nil {
			t.Errorf("Fetch(%d %q) succeeded, want an error", tc.status, tc.body)
		}
		srv.Close()
	}
}
