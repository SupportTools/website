package main

import (
	"bytes"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/sirupsen/logrus"
	"github.com/supporttools/website/pkg/config"
	"github.com/supporttools/website/pkg/logging"
	"github.com/supporttools/website/pkg/metrics"
)

var (
	// Global logger variable
	logger *logrus.Logger

	// memoryFiles stores the content of each file keyed by its path
	memoryFiles map[string]*fileData
)

type fileData struct {
	contentType string
	content     []byte
	modTime     time.Time
}

func main() {
	config.LoadConfiguration()
	logger = logging.SetupLogging()
	logger.Info("Debug logging enabled")
	if config.CFG.Debug {
		logger.Infoln("Debug mode enabled")
		logger.Infoln("Configuration:")
		logger.Infof("Debug: %t", config.CFG.Debug)
		logger.Infof("Port: %d", config.CFG.Port)
		logger.Infof("Metrics Port: %d", config.CFG.MetricsPort)
		logger.Infof("Web Root: %s", config.CFG.WebRoot)
		logger.Infof("Use Memory: %t", config.CFG.UseMemory)
	}

	if config.CFG.UseMemory {
		logger.Infoln("Loading files into memory")
		loadFilesIntoMemory(config.CFG.WebRoot)
		logger.Infoln("Files loaded into memory")
	}

	go webserver()

	metrics.StartMetricsServer(config.CFG.MetricsPort)
}

func webserver() {
	logger.Println("Starting web server...")

	if config.CFG.UseMemory {
		logger.Println("Serving files from memory")
		http.Handle("/", promMiddleware(logRequest(http.HandlerFunc(serveFromMemory))))
	} else {
		logger.Println("Serving files directly from filesystem")
		fs := http.FileServer(http.Dir(config.CFG.WebRoot))
		http.Handle("/", promMiddleware(logRequest(fs)))
	}

	// Expose the registered Prometheus metrics via HTTP.
	http.Handle("/metrics", promhttp.Handler())

	serverAddress := ":8080"
	logger.Printf("Serving %s on HTTP port: %s\n", config.CFG.WebRoot, serverAddress)
	log.Fatal(http.ListenAndServe(serverAddress, nil))
}

func promMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		startTime := time.Now()

		// Sanitize the URL path to prevent log injection
		sanitizedPath := url.QueryEscape(r.URL.Path)

		logger.Infof("Processing request for: %s", sanitizedPath)
		next.ServeHTTP(w, r)
		duration := time.Since(startTime).Seconds()
		logger.Infof("Request for %s processed in %f seconds", sanitizedPath, duration)
		metrics.RecordMetrics(sanitizedPath, duration)
	})
}

func logRequest(handler http.Handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()

		// Sanitize the URL path to prevent log injection
		sanitizedPath := url.QueryEscape(r.URL.Path)

		logger.Infof("Incoming request: %s %s from %s", r.Method, sanitizedPath, r.RemoteAddr)

		lrw := &loggingResponseWriter{ResponseWriter: w, statusCode: http.StatusOK}
		handler.ServeHTTP(lrw, r)

		duration := time.Since(start)
		logger.Infof("Request %s %s completed with status %d in %s", r.Method, sanitizedPath, lrw.statusCode, duration)
	}
}

type loggingResponseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (lrw *loggingResponseWriter) WriteHeader(code int) {
	lrw.statusCode = code
	lrw.ResponseWriter.WriteHeader(code)
}

func loadFilesIntoMemory(rootDir string) {
	memoryFiles = make(map[string]*fileData)
	err := filepath.WalkDir(rootDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			logger.Printf("Error accessing path %q: %v\n", path, err)
			return err
		}

		relPath, err := filepath.Rel(rootDir, path)
		if err != nil {
			logger.Printf("Failed to get relative path for %q: %v\n", path, err)
			return err
		}

		// Normalize path for URL matching
		urlPath := "/" + strings.Replace(relPath, string(filepath.Separator), "/", -1)

		if d.IsDir() {
			logger.Infof("Loading directory: %s\n", path)
			// Ensure that the directory has a trailing slash for URL matching
			if !strings.HasSuffix(urlPath, "/") {
				urlPath += "/"
			}

			// Check if directory contains an index.html file
			indexFilePath := filepath.Join(path, "index.html")
			if _, err := os.Stat(indexFilePath); err == nil {
				content, err := os.ReadFile(indexFilePath)
				if err != nil {
					logger.Printf("Failed to read index file %q: %v\n", indexFilePath, err)
					return err
				}
				memoryFiles[urlPath] = &fileData{
					contentType: http.DetectContentType(content),
					content:     content,
					modTime:     time.Now(),
				}
				logger.Infof("Directory %s loaded with index.html\n", urlPath)
			} else {
				// Directory has no index.html, could log this or handle differently if needed
				logger.Infof("Directory %s does not contain an index.html\n", urlPath)
			}
		} else {
			logger.Infof("Loading file: %s\n", path)

			content, err := os.ReadFile(path)
			if err != nil {
				logger.Infof("Failed to read file %q: %v\n", path, err)
				return err
			}

			memoryFiles[urlPath] = &fileData{
				contentType: http.DetectContentType(content),
				content:     content,
				modTime:     time.Now(),
			}

			logger.Infof("File %s loaded into memory with urlPath %s\n", path, urlPath)
		}
		return nil
	})
	if err != nil {
		logger.Fatalf("Failed to load files into memory: %v", err)
	}

	logger.Println("All files and directories successfully loaded into memory.")
}

func serveFromMemory(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	logger.Infof("Serving request for: %s", path)

	// If the path ends with a slash, try to serve the directory's index.html
	if strings.HasSuffix(path, "/") {
		logger.Infof("Request is for a directory, attempting to serve index.html for: %s", path)
		path += "index.html"
	}

	fd, found := memoryFiles[path]
	if !found {
		logger.Infof("File not found in memory for path: %s", path)
		// Attempt to serve the directory's index.html explicitly if not found with a trailing slash
		if !strings.HasSuffix(path, "/index.html") {
			indexPath := path + "/index.html"
			if indexFd, indexFound := memoryFiles[indexPath]; indexFound {
				fd = indexFd
				found = true
				logger.Infof("Found index.html for path: %s", indexPath)
			}
		}
	}

	// If still not found, return a 404
	if !found {
		logger.Infof("Returning 404 for path: %s", path)
		http.NotFound(w, r)
		return
	}

	// Set response headers and serve the content
	logger.Printf("Serving file from memory: %s", path)
	w.Header().Set("Cache-Control", "max-age=31536000")
	w.Header().Set("Content-Length", strconv.Itoa(len(fd.content)))
	w.Header().Set("Last-Modified", fd.modTime.UTC().Format(http.TimeFormat))
	w.Header().Set("ETag", `"`+strconv.FormatInt(fd.modTime.Unix(), 10)+`"`)
	w.Header().Set("Content-Type", fd.contentType)

	http.ServeContent(w, r, r.URL.Path, fd.modTime, bytes.NewReader(fd.content))
}
