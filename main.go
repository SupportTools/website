package main

import (
	"bytes"
	"compress/gzip"
	"fmt"
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
	logger = logging.SetupLogging(&config.CFG)
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

// webserver starts the HTTP server and serves files from the filesystem or memory
func webserver() {
	logger.Println("Starting web server...")

	if config.CFG.UseMemory {
		logger.Println("Serving files from memory")
		http.Handle("/", gzipMiddleware(promMiddleware(logRequest(http.HandlerFunc(serveFromMemory)))))
	} else {
		logger.Println("Serving files directly from filesystem")
		fs := http.FileServer(http.Dir(config.CFG.WebRoot))
		http.Handle("/", gzipMiddleware(promMiddleware(logRequest(fs))))
	}

	// Expose the registered Prometheus metrics via HTTP.
	http.Handle("/metrics", promhttp.Handler())

	serverAddress := ":8080"
	logger.Printf("Serving %s on HTTP port: %s\n", config.CFG.WebRoot, serverAddress)
	log.Fatal(http.ListenAndServe(serverAddress, nil))
}

// promMiddleware records request duration as a Prometheus metric
func promMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		startTime := time.Now()
		sanitizedPath := sanitizePath(r.URL.Path)
		logger.Infof("Processing request for: %s", sanitizedPath)
		next.ServeHTTP(w, r)
		duration := time.Since(startTime).Seconds()
		logger.Infof("Request for %s processed in %f seconds", sanitizedPath, duration)
		metrics.RecordMetrics(sanitizedPath, duration)
	})
}

// logRequest logs the request in the Nginx access log format
func logRequest(handler http.Handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Get the real client IP, falling back to RemoteAddr if not behind Cloudflare
		clientIP := r.Header.Get("CF-Connecting-IP")
		if clientIP == "" {
			clientIP = r.RemoteAddr
		}

		// Create a custom response writer to capture the status code and response size
		lrw := &loggingResponseWriter{ResponseWriter: w, statusCode: http.StatusOK}
		handler.ServeHTTP(lrw, r)

		// Format log like Nginx access log
		logLine := fmt.Sprintf("%s - - [%s] \"%s %s %s\" %d %d \"%s\" \"%s\"",
			clientIP, // $remote_addr (real client IP)
			time.Now().Format("02/Jan/2006:15:04:05 -0700"), // [$time_local]
			r.Method,         // $request method
			r.RequestURI,     // $request URI
			r.Proto,          // $request protocol
			lrw.statusCode,   // $status
			lrw.responseSize, // $body_bytes_sent
			r.Referer(),      // $http_referer
			r.UserAgent(),    // $http_user_agent
		)
		logger.Info(logLine)
	}
}

type loggingResponseWriter struct {
	http.ResponseWriter
	statusCode   int
	responseSize int
}

// Implement the http.ResponseWriter interface
func (lrw *loggingResponseWriter) WriteHeader(code int) {
	lrw.statusCode = code
	lrw.ResponseWriter.WriteHeader(code)
}

// Implement the http.ResponseWriter interface
func (lrw *loggingResponseWriter) Write(b []byte) (int, error) {
	size, err := lrw.ResponseWriter.Write(b)
	lrw.responseSize += size
	return size, err
}

// loadFilesIntoMemory reads all files and directories from the web root directory into memory
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

// serveFromMemory serves files from memory
func serveFromMemory(w http.ResponseWriter, r *http.Request) {
	sanitizedPath := sanitizePath(r.URL.Path)

	logger.Infof("Serving request for: %s", sanitizedPath)

	// If the path ends with a slash, try to serve the directory's index.html
	if strings.HasSuffix(sanitizedPath, "/") {
		logger.Infof("Request is for a directory, attempting to serve index.html for: %s", sanitizedPath)
		sanitizedPath += "index.html"
	}

	// Attempt to find the file in memory
	fd, found := memoryFiles[sanitizedPath]
	if !found {
		logger.Infof("File not found in memory for path: %s", sanitizedPath)
		// Attempt to serve the directory's index.html explicitly if not found with a trailing slash
		if !strings.HasSuffix(sanitizedPath, "/index.html") {
			indexPath := sanitizedPath + "/index.html"
			if indexFd, indexFound := memoryFiles[indexPath]; indexFound {
				fd = indexFd
				found = true
				logger.Infof("Found index.html for path: %s", indexPath)
			}
		}
	}

	// If still not found, return a 404
	if !found {
		logger.Infof("Returning 404 for path: %s", sanitizedPath)
		http.NotFound(w, r)
		return
	}

	logger.WithField("path", sanitizedPath).Info("Serving file from memory")
	w.Header().Set("Cache-Control", "max-age=31536000")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Length", strconv.Itoa(len(fd.content)))
	w.Header().Set("Last-Modified", fd.modTime.UTC().Format(http.TimeFormat))
	w.Header().Set("ETag", `"`+strconv.FormatInt(fd.modTime.Unix(), 10)+`"`)
	w.Header().Set("Content-Type", fd.contentType)

	http.ServeContent(w, r, sanitizedPath, fd.modTime, bytes.NewReader(fd.content))
}

// sanitizePath sanitizes the path by escaping special characters and removing control characters
func sanitizePath(path string) string {
	sanitizedPath := url.QueryEscape(path)
	sanitizedPath = strings.Replace(sanitizedPath, "%2F", "/", -1)
	sanitizedPath = strings.ReplaceAll(sanitizedPath, "\n", "")
	sanitizedPath = strings.ReplaceAll(sanitizedPath, "\r", "")
	sanitizedPath = strings.ReplaceAll(sanitizedPath, "\t", "")
	sanitizedPath = strings.Map(func(r rune) rune {
		if r < 32 || r == 127 {
			return -1
		}
		return r
	}, sanitizedPath)
	return sanitizedPath
}

// gzipMiddleware compresses the response using gzip if the client supports it.
func gzipMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Check if the client supports gzip compression
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			// If not, simply pass the request to the next handler
			next.ServeHTTP(w, r)
			return
		}

		// Create a gzip response writer
		gzw := gzip.NewWriter(w)
		defer gzw.Close()

		// Set the appropriate headers
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("Vary", "Accept-Encoding")

		// Wrap the original ResponseWriter with a gzip writer
		grw := &gzipResponseWriter{ResponseWriter: w, Writer: gzw}
		next.ServeHTTP(grw, r)
	})
}

type gzipResponseWriter struct {
	http.ResponseWriter
	Writer *gzip.Writer
}

// Write method to implement the http.ResponseWriter interface
func (grw *gzipResponseWriter) Write(b []byte) (int, error) {
	return grw.Writer.Write(b)
}
