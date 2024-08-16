package metrics

import (
	"net/http"
	"strconv"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/supporttools/website/pkg/config"
	"github.com/supporttools/website/pkg/health"
	"github.com/supporttools/website/pkg/logging"
)

var logger = logging.SetupLogging(&config.CFG)

var (
	// Register a counter metric for counting the total number of requests
	totalRequests = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "http_requests_total",
			Help: "Number of get requests.",
		},
		[]string{"path"},
	)

	// Register a histogram to observe the response times
	responseDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "http_response_duration_seconds",
			Help:    "Duration of HTTP responses.",
			Buckets: prometheus.DefBuckets,
		},
		[]string{"path"},
	)
)

func init() {
	// Register the histograms with Prometheus.
	prometheus.MustRegister(totalRequests)
	prometheus.MustRegister(responseDuration)
}

func StartMetricsServer(port int) {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.Handle("/healthz", health.HealthzHandler())
	mux.Handle("/version", health.VersionHandler())

	serverPort := strconv.Itoa(port)
	logger.Printf("Metrics server starting on port %d\n", port)

	if err := http.ListenAndServe(":"+serverPort, mux); err != nil {
		logger.Fatalf("Metrics server failed to start: %v", err)
	}
}

func RecordMetrics(path string, duration float64) {
	totalRequests.WithLabelValues(path).Inc()
	responseDuration.WithLabelValues(path).Observe(duration)
}
