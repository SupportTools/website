package testsrv

import (
	"io"
	"net/http"
	"net/url"
	"strconv"
	"testing"
)

func TestServerNeverUsesNodePortRange(t *testing.T) {
	for i := 0; i < 300; i++ {
		srv := New(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "mine") }))
		u, _ := url.Parse(srv.URL)
		port, _ := strconv.Atoi(u.Port())
		if port >= nodePortMin && port <= nodePortMax {
			t.Fatalf("server on NodePort-range port %d", port)
		}
		resp, err := http.Get(srv.URL)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if string(b) != "mine" {
			t.Fatalf("port %d answered %q", port, b)
		}
		srv.Close()
	}
}
