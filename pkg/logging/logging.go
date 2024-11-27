package logging

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/sirupsen/logrus"
	"github.com/supporttools/website/pkg/config"
)

var (
	logger        *logrus.Logger
	accessLogFile *os.File
)

func LogCallerInfo() *logrus.Entry {
	_, filename, line, ok := runtime.Caller(1)
	if !ok {
		panic("Unable to get caller information")
	}
	filename = sanitizeLogField(filepath.Base(filename))

	cfg := config.CFG
	if cfg.Debug {
		return logger.WithField("filename", filename).WithField("line", line)
	}

	return logger.WithField("line", line)
}

// SetupLogging initializes application logging and opens the access log file
func SetupLogging(cfg *config.AppConfig) *logrus.Logger {
	logger = logrus.New()
	logger.SetReportCaller(true)

	customFormatter := &logrus.TextFormatter{
		DisableTimestamp: true, // Disable timestamps for application logs
	}
	logger.SetFormatter(customFormatter)
	logger.SetOutput(os.Stderr)

	if cfg.Debug {
		logger.SetLevel(logrus.DebugLevel)
	} else {
		logger.SetLevel(logrus.InfoLevel)
	}

	// Use LOG_FILE_PATH environment variable for the access log path
	logFilePath := os.Getenv("LOG_FILE_PATH")
	if logFilePath == "" {
		logFilePath = "/var/log/access.log" // Default path
	}

	// Create the log directory if it doesn't exist
	logDir := filepath.Dir(logFilePath)
	if _, err := os.Stat(logDir); os.IsNotExist(err) {
		if err := os.MkdirAll(logDir, 0755); err != nil {
			logger.Fatalf("Failed to create log directory: %v", err)
		}
	}

	// Open the access log file
	var err error
	accessLogFile, err = os.OpenFile(logFilePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		logger.Fatalf("Failed to open access log file: %v", err)
	}

	return logger
}
func GetRelativePath(filePath string) (string, error) {
	wd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	relPath, err := filepath.Rel(wd, filePath)
	if err != nil {
		return "", err
	}
	return relPath, nil
}

func sanitizeLogField(input string) string {
	replacer := strings.NewReplacer(
		"\n", "\\n",
		"\r", "\\r",
		"\t", "\\t",
	)
	return replacer.Replace(input)
}

// CloseAccessLog closes the access log file
func CloseAccessLog() {
	if accessLogFile != nil {
		_ = accessLogFile.Close()
	}
}

// LogRequest logs HTTP requests to the access log file
func LogRequest(handler http.Handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		vHost := r.Host
		clientIP := r.Header.Get("CF-Connecting-IP")
		if clientIP == "" {
			clientIP = r.Header.Get("X-Forwarded-For")
		}
		if clientIP == "" {
			clientIP = r.RemoteAddr
		}

		method := r.Method
		uri := r.URL.String()
		proto := r.Proto
		userAgent := r.Header.Get("User-Agent")
		referer := r.Header.Get("Referer")

		// Capture the response status and size
		lrw := &loggingResponseWriter{ResponseWriter: w, statusCode: http.StatusOK}
		handler.ServeHTTP(lrw, r)

		// Format the current time in UTC
		timestamp := time.Now().UTC().Format("02/Jan/2006:15:04:05 -0700")

		// Format access log entry
		logEntry := fmt.Sprintf("%s %s [%s] \"%s %s %s\" %d %d \"%s\" \"%s\"\n",
			vHost,            // Virtual host
			clientIP,         // Real client IP address
			timestamp,        // Timestamp in UTC
			method,           // HTTP method
			uri,              // Request URI
			proto,            // Protocol
			lrw.statusCode,   // Response status
			lrw.responseSize, // Response size
			referer,          // Referer
			userAgent,        // User-Agent
		)

		// Write to the access log file
		if _, err := accessLogFile.WriteString(logEntry); err != nil {
			logger.Errorf("Failed to write to access log file: %v", err)
		}
	}
}

type loggingResponseWriter struct {
	http.ResponseWriter
	statusCode   int
	responseSize int
}

func (lrw *loggingResponseWriter) WriteHeader(code int) {
	lrw.statusCode = code
	lrw.ResponseWriter.WriteHeader(code)
}

func (lrw *loggingResponseWriter) Write(b []byte) (int, error) {
	size, err := lrw.ResponseWriter.Write(b)
	lrw.responseSize += size
	return size, err
}
