// Package testsrv starts httptest servers on ports outside the Kubernetes
// NodePort range.
//
// On a Kubernetes node (a workstation running RKE2, an ARC runner host), any
// connection to a local address on a NodePort port (30000-32767) is redirected
// to that Service, even 127.0.0.1 and even when a test server holds the port.
// Linux's default ephemeral range overlaps it, so plain httptest.NewServer
// picks a hijacked port a few percent of the time and the test gets another
// service's nginx 404, a TLS error or a refused connection.
package testsrv

import (
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

const (
	nodePortMin = 30000
	nodePortMax = 32767
)

// New starts a server on 127.0.0.1 outside the NodePort range and closes it
// when the test ends.
func New(t testing.TB, h http.Handler) *httptest.Server {
	t.Helper()
	var rejected []net.Listener
	defer func() {
		for _, l := range rejected {
			l.Close()
		}
	}()
	for {
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatalf("testsrv: listen: %v", err)
		}
		if p := l.Addr().(*net.TCPAddr).Port; p >= nodePortMin && p <= nodePortMax {
			rejected = append(rejected, l) // hold it so the next Listen gets a different port
			continue
		}
		srv := httptest.NewUnstartedServer(h)
		srv.Listener.Close()
		srv.Listener = l
		srv.Start()
		t.Cleanup(srv.Close)
		return srv
	}
}
