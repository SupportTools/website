package main

import (
	"bytes"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/supporttools/website/pkg/config"
	"github.com/supporttools/website/pkg/logging"
	"github.com/supporttools/website/pkg/metrics"
)

var logger = logging.SetupLogging()

var (
	// memoryFiles stores the content of each file keyed by its path
	memoryFiles map[string]*fileData
)

type fileData struct {
	contentType string
	content     []byte
	modTime     time.Time
}

func main() {
	logger.Println("Starting Support Tools Website")
	config.LoadConfiguration()
	if config.CFG.Debug {
		logger.Println("Debug mode enabled")
		logger.Println("Configuration:")
		logger.Printf("Debug: %t", config.CFG.Debug)
		logger.Printf("Port: %d", config.CFG.Port)
		logger.Printf("Metrics Port: %d", config.CFG.MetricsPort)
		logger.Printf("Web Root: %s", config.CFG.WebRoot)
	}

	logger.Println("Loading files into memory")
	loadFilesIntoMemory(config.CFG.WebRoot)
	logger.Println("Files loaded into memory")

	go webserver()

	metrics.StartMetricsServer(config.CFG.MetricsPort)
}

func webserver() {
	fs := http.FileServer(http.Dir(config.CFG.WebRoot))
	http.Handle("/", promMiddleware(logRequest(fs)))
	//http.Handle("/", http.HandlerFunc(serveFromMemory))

	// Expose the registered Prometheus metrics via HTTP.
	http.Handle("/metrics", promhttp.Handler())

	serverAddress := ":8080"
	log.Printf("Serving %s on HTTP port: %s\n", config.CFG.WebRoot, serverAddress)
	log.Fatal(http.ListenAndServe(serverAddress, nil))

}

// promMiddleware wraps the HTTP handler to measure requests count and duration
func promMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		startTime := time.Now()
		next.ServeHTTP(w, r)
		duration := time.Since(startTime).Seconds()
		metrics.RecordMetrics(r.URL.Path, duration)
	})
}

// logRequest is a middleware that logs the HTTP method, URL, and the remote address of each request
func logRequest(handler http.Handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()

		// Wrap the ResponseWriter to capture the status code
		lrw := &loggingResponseWriter{ResponseWriter: w, statusCode: http.StatusOK}

		handler.ServeHTTP(lrw, r)

		// Calculate the duration
		duration := time.Since(start)

		log.Printf("%s %s %s %s %d %s\n", r.RemoteAddr, r.Method, r.URL, r.UserAgent(), lrw.statusCode, duration)
	}
}

// loggingResponseWriter wraps http.ResponseWriter to capture the status code
type loggingResponseWriter struct {
	http.ResponseWriter
	statusCode int
}

// WriteHeader captures the status code and calls the original WriteHeader
func (lrw *loggingResponseWriter) WriteHeader(code int) {
	lrw.statusCode = code
	lrw.ResponseWriter.WriteHeader(code)
}

func loadFilesIntoMemory(rootDir string) {
	memoryFiles = make(map[string]*fileData)
	err := filepath.WalkDir(rootDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			content, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			relPath, err := filepath.Rel(rootDir, path)
			if err != nil {
				return err
			}
			// Normalize path for URL matching
			urlPath := "/" + strings.Replace(relPath, string(filepath.Separator), "/", -1)
			if d.IsDir() {
				urlPath += "/index.html" // Assuming index.html should be served for directories
			}
			memoryFiles[urlPath] = &fileData{
				contentType: http.DetectContentType(content),
				content:     content,
				modTime:     time.Now(),
			}
		}
		return nil
	})
	if err != nil {
		log.Fatalf("Failed to load files into memory: %v", err)
	}
}

func serveFromMemory(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	// Ensure we try to serve index.html for directory requests
	if strings.HasSuffix(path, "/") {
		path += "index.html"
	}

	fd, found := memoryFiles[path]
	if !found {
		// Attempt to serve index.html if it exists for the given path
		if indexFd, indexFound := memoryFiles[path+"/index.html"]; indexFound {
			fd = indexFd
		} else {
			http.NotFound(w, r)
			return
		}
	}
	w.Header().Set("Content-Type", fd.contentType)
	http.ServeContent(w, r, r.URL.Path, fd.modTime, bytes.NewReader(fd.content))
}
