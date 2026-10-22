// blog-metrics-exporter polls PostHog, Google Search Console and Buffer for
// support.tools traffic and serves it as Prometheus metrics (/metrics) and as
// JSON for the weekly scorecard (/report). Scrapes never call an API: each
// source has its own poll loop and the last good result is served.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/supporttools/website/exporters/blog-metrics/internal/buffer"
	"github.com/supporttools/website/exporters/blog-metrics/internal/gsc"
	"github.com/supporttools/website/exporters/blog-metrics/internal/posthog"
	"github.com/supporttools/website/exporters/blog-metrics/internal/postindex"
	"github.com/supporttools/website/exporters/blog-metrics/internal/snapshot"
)

const (
	postHogEvery = time.Hour
	dailyEvery   = 24 * time.Hour
	retryAfter   = 15 * time.Minute
)

func main() {
	cfg, err := loadConfig(os.Getenv)
	if err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	hc := &http.Client{Timeout: 90 * time.Second}
	store := snapshot.NewStore(time.Now)

	ph := &posthog.Client{BaseURL: cfg.PostHogURL, ProjectID: cfg.PostHogProjectID, APIKey: cfg.PostHogAPIKey, HTTP: hc}
	tokens, err := gsc.NewTokenSource([]byte(cfg.GSCKeyJSON), cfg.GSCTokenURL, time.Now)
	if err != nil {
		log.Fatal(err)
	}
	tokens.HTTP = hc
	sc := &gsc.Client{BaseURL: cfg.GSCURL, Site: cfg.GSCSite, Tokens: tokens, HTTP: hc}
	buf := &buffer.Client{URL: cfg.BufferURL, APIKey: cfg.BufferAPIKey, OrgID: cfg.BufferOrgID, HTTP: hc}

	var topics map[string]string // last good post index; only the GSC loop touches it
	go poll(ctx, snapshot.SourcePostHog, postHogEvery, store, func(ctx context.Context) error {
		t, err := posthog.Collect(ctx, ph, cfg.SiteHost)
		if err == nil {
			store.SetTraffic(t)
		}
		return err
	})
	go poll(ctx, snapshot.SourceGSC, dailyEvery, store, func(ctx context.Context) error {
		if idx, err := postindex.Fetch(ctx, cfg.PostIndexURL, hc); err == nil {
			topics = idx
		} else if topics == nil {
			return err
		} else {
			log.Printf("post index: %v (keeping the last good index)", err)
		}
		s, err := gsc.Collect(ctx, sc, topics, time.Now())
		if err == nil {
			store.SetSearch(s)
		}
		return err
	})
	go poll(ctx, snapshot.SourceBuffer, dailyEvery, store, func(ctx context.Context) error {
		s, err := buffer.Collect(ctx, buf, cfg.BufferChannels, time.Now())
		if err == nil {
			store.SetSocial(s)
		}
		return err
	})

	reg := prometheus.NewRegistry()
	reg.MustRegister(snapshot.NewCollector(store), collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.HandlerFor(reg, promhttp.HandlerOpts{}))
	mux.HandleFunc("/report", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(snapshot.Report(store.Get()))
	})
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok\n")) })
	srv := &http.Server{Addr: cfg.Listen, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(shutdown)
	}()
	log.Printf("listening on %s", cfg.Listen)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

// poll runs fn now and then every interval, or retryAfter after a failure. It
// logs one line per poll and never logs credentials (errors carry only status
// codes and the first bytes of an API's error body).
func poll(ctx context.Context, source string, every time.Duration, store *snapshot.Store, fn func(context.Context) error) {
	for {
		start := time.Now()
		err := fn(ctx)
		next := every
		if err != nil {
			store.Fail(source)
			next = retryAfter
			log.Printf("poll %s failed after %s: %v (retry in %s)", source, time.Since(start).Round(time.Millisecond), err, next)
		} else {
			log.Printf("poll %s ok in %s", source, time.Since(start).Round(time.Millisecond))
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(next):
		}
	}
}
