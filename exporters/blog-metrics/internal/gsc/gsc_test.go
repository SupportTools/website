package gsc

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/supporttools/website/exporters/blog-metrics/internal/testsrv"

	"github.com/supporttools/website/exporters/blog-metrics/internal/snapshot"
)

func testKey(t *testing.T) (*rsa.PrivateKey, []byte) {
	t.Helper()
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKCS8PrivateKey(k)
	pemKey := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
	j, _ := json.Marshal(map[string]string{"client_email": "sa@test.iam.gserviceaccount.com", "private_key": string(pemKey)})
	return k, j
}

// tokenServer checks the JWT assertion's signature and claims and counts calls.
func tokenServer(t *testing.T, k *rsa.PrivateKey, calls *int) *httptest.Server {
	t.Helper()
	srv := testsrv.New(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*calls++
		r.ParseForm()
		if r.Form.Get("grant_type") != "urn:ietf:params:oauth:grant-type:jwt-bearer" {
			t.Errorf("grant_type = %q", r.Form.Get("grant_type"))
		}
		parts := strings.Split(r.Form.Get("assertion"), ".")
		if len(parts) != 3 {
			t.Fatalf("assertion has %d parts", len(parts))
		}
		sig, _ := base64.RawURLEncoding.DecodeString(parts[2])
		sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
		if err := rsa.VerifyPKCS1v15(&k.PublicKey, crypto.SHA256, sum[:], sig); err != nil {
			t.Errorf("bad signature: %v", err)
		}
		claimsJSON, _ := base64.RawURLEncoding.DecodeString(parts[1])
		var claims map[string]any
		json.Unmarshal(claimsJSON, &claims)
		if claims["iss"] != "sa@test.iam.gserviceaccount.com" || claims["scope"] != "https://www.googleapis.com/auth/webmasters.readonly" {
			t.Errorf("claims = %v", claims)
		}
		io.WriteString(w, `{"access_token":"tok-1","expires_in":3600}`)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestTokenSignsAndCaches(t *testing.T) {
	k, keyJSON := testKey(t)
	calls := 0
	srv := tokenServer(t, k, &calls)
	now := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	ts, err := NewTokenSource(keyJSON, srv.URL, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		tok, err := ts.Token(context.Background())
		if err != nil || tok != "tok-1" {
			t.Fatalf("Token = %q, %v", tok, err)
		}
	}
	if calls != 1 {
		t.Fatalf("token requests = %d, want 1 (cached)", calls)
	}
	now = now.Add(3600*time.Second - 30*time.Second) // inside the 60 s refresh margin
	if _, err := ts.Token(context.Background()); err != nil || calls != 2 {
		t.Fatalf("refresh: calls = %d, err %v", calls, err)
	}
}

func TestNewTokenSourceRejectsBadKey(t *testing.T) {
	if _, err := NewTokenSource([]byte(`{"client_email":"x","private_key":"nope"}`), "u", time.Now); err == nil {
		t.Fatal("want error for a non-PEM key")
	}
}

func TestGSCWindowDates(t *testing.T) {
	w := Windows(time.Date(2026, 10, 23, 0, 0, 30, 0, time.UTC))
	if got := w[snapshot.W7d]; got != [2]string{"2026-10-14", "2026-10-20"} {
		t.Fatalf("7d = %v", got)
	}
	if got := w[snapshot.W28d]; got != [2]string{"2026-09-23", "2026-10-20"} {
		t.Fatalf("28d = %v", got)
	}
	if got := PrevWeek(time.Date(2026, 10, 23, 23, 59, 0, 0, time.UTC)); got != [2]string{"2026-10-07", "2026-10-13"} {
		t.Fatalf("prev week = %v", got)
	}
}

// fakeGSC answers searchAnalytics by the requested dimension and counts the
// searchAnalytics requests in queries.
func fakeGSC(t *testing.T, queries *int) *httptest.Server {
	t.Helper()
	srv := testsrv.New(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			io.WriteString(w, `{"access_token":"tok","expires_in":3600}`)
			return
		}
		*queries++
		if r.Header.Get("Authorization") != "Bearer tok" {
			t.Errorf("Authorization = %q", r.Header.Get("Authorization"))
		}
		if !strings.Contains(r.URL.EscapedPath(), url.PathEscape("sc-domain:support.tools")) {
			t.Errorf("path = %s", r.URL.EscapedPath())
		}
		var body struct {
			StartDate  string   `json:"startDate"`
			Dimensions []string `json:"dimensions"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		dim := strings.Join(body.Dimensions, ",")
		switch {
		case dim == "":
			io.WriteString(w, `{"rows":[{"clicks":150,"impressions":30000,"ctr":0.005,"position":17.2}]}`)
		case dim == "page":
			io.WriteString(w, `{"rows":[
				{"keys":["https://support.tools/curl-host-header/"],"clicks":40,"impressions":900},
				{"keys":["https://support.tools/rke2-x/"],"clicks":10,"impressions":800},
				{"keys":["https://support.tools/unknown/"],"clicks":5,"impressions":100}]}`)
		case dim == "query" && body.StartDate == "2026-10-07":
			io.WriteString(w, `{"rows":[{"keys":["curl host header"],"clicks":20,"impressions":400,"position":5}]}`)
		case dim == "query":
			io.WriteString(w, `{"rows":[
				{"keys":["curl host header"],"clicks":30,"impressions":500,"position":4},
				{"keys":["ping mtu"],"clicks":1,"impressions":900,"position":12}]}`)
		default:
			t.Errorf("unexpected dimensions %q", dim)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestSearchByTopic(t *testing.T) {
	_, keyJSON := testKey(t)
	queries := 0
	srv := fakeGSC(t, &queries)
	now := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	ts, err := NewTokenSource(keyJSON, srv.URL+"/token", func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	c := &Client{BaseURL: srv.URL, Site: "sc-domain:support.tools", Tokens: ts, HTTP: http.DefaultClient}
	topics := map[string]string{"curl-host-header": "networking", "rke2-x": "rke2", "other-post": "networking"}
	s, err := Collect(context.Background(), c, topics, now)
	if err != nil {
		t.Fatal(err)
	}
	if s.Totals[snapshot.W7d].Clicks != 150 || s.Totals[snapshot.W28d].Position != 17.2 {
		t.Fatalf("totals = %v", s.Totals)
	}
	if c := s.ClicksByTopic[snapshot.W28d]; c["networking"] != 40 || c["rke2"] != 10 || c["other"] != 5 {
		t.Fatalf("clicks by topic = %v", c)
	}
	if s.ArticlesByTopic["networking"] != 2 || s.ArticlesByTopic["rke2"] != 1 {
		t.Fatalf("articles by topic = %v", s.ArticlesByTopic)
	}
	if len(s.Queries) != 2 || s.Queries[0].Query != "ping mtu" {
		t.Fatalf("queries not ordered by impressions: %v", s.Queries)
	}
	q := s.Queries[1]
	if q.Query != "curl host header" || q.Clicks != 30 || q.PrevClicks != 20 || q.PrevPosition != 5 {
		t.Fatalf("query with previous week = %+v", q)
	}
	// Both windows' query rows: curl host header (30 clicks, 500 impressions,
	// position 4) and ping mtu (1, 900, 12). Nothing in the top 3.
	for _, w := range snapshot.LongWindows {
		want := snapshot.SERP{QueryRows: 2, QueryImpressions: 1400, Top10Impressions: 500, StableQueries: 2, StableMedianPosition: 8}
		if got := s.SERP[w]; got != want {
			t.Fatalf("SERP %s = %+v, want %+v", w, got, want)
		}
	}
	// Per window: totals, pages, queries (one page each), plus the previous week.
	if queries != 7 {
		t.Fatalf("searchAnalytics requests = %d, want 7", queries)
	}
}

func TestQueryErrorIncludesStatus(t *testing.T) {
	_, keyJSON := testKey(t)
	srv := testsrv.New(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			io.WriteString(w, `{"access_token":"tok","expires_in":3600}`)
			return
		}
		http.Error(w, `{"error":{"message":"User does not have sufficient permission"}}`, http.StatusForbidden)
	}))
	defer srv.Close()
	ts, _ := NewTokenSource(keyJSON, srv.URL+"/token", time.Now)
	c := &Client{BaseURL: srv.URL, Site: "sc-domain:support.tools", Tokens: ts, HTTP: http.DefaultClient}
	_, err := c.Query(context.Background(), "2026-10-01", "2026-10-07", nil, 1)
	if err == nil || !strings.Contains(err.Error(), "403") || !strings.Contains(err.Error(), "sufficient permission") {
		t.Fatalf("err = %v", err)
	}
}

func TestSearchKeepsAllTopicsUnbucketed(t *testing.T) {
	_, keyJSON := testKey(t)
	var rows []string
	topics := map[string]string{}
	for i := 0; i < 25; i++ {
		slug := "p" + strconv.Itoa(i)
		topics[slug] = "t" + strconv.Itoa(i)
		rows = append(rows, `{"keys":["https://support.tools/`+slug+`/"],"clicks":`+strconv.Itoa(i+1)+`,"impressions":10}`)
	}
	srv := testsrv.New(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			io.WriteString(w, `{"access_token":"tok","expires_in":3600}`)
			return
		}
		var body struct {
			Dimensions []string `json:"dimensions"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if strings.Join(body.Dimensions, ",") == "page" {
			io.WriteString(w, `{"rows":[`+strings.Join(rows, ",")+`]}`)
			return
		}
		io.WriteString(w, `{"rows":[]}`)
	}))
	now := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	ts, _ := NewTokenSource(keyJSON, srv.URL+"/token", func() time.Time { return now })
	c := &Client{BaseURL: srv.URL, Site: "sc-domain:support.tools", Tokens: ts, HTTP: http.DefaultClient}
	s, err := Collect(context.Background(), c, topics, now)
	if err != nil {
		t.Fatal(err)
	}
	if n := len(s.ClicksByTopic[snapshot.W28d]); n != 25 {
		t.Fatalf("topics = %d, want all 25 (bucketing happens at scrape time)", n)
	}
}
