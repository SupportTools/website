package logging

import (
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/sirupsen/logrus"
	"github.com/supporttools/website/pkg/config"
)

var log *logrus.Logger

func LogFile() *logrus.Entry {
	_, filename, line, ok := runtime.Caller(1)
	if !ok {
		panic("Unable to get caller information")
	}
	filename = filepath.Base(filename)

	config := config.CFG
	// Check if the logger is in debug mode
	if config.Debug {
		logFilename := log.WithField("filename", filename).WithField("line", line)
		return logFilename
	}

	// If not in debug mode, return a log entry without the filename
	return log.WithField("line", line)
}

func SetupLogging() *logrus.Logger {
	log := logrus.New()
	log.SetReportCaller(true)

	customFormatter := new(logrus.TextFormatter)
	customFormatter.TimestampFormat = "2006-01-02 15:04:05"
	customFormatter.FullTimestamp = true
	log.SetFormatter(customFormatter)

	// Log as JSON instead of the default ASCII formatter.
	//log.SetFormatter(&logrus.JSONFormatter{})

	// Output to stderr instead of stdout, could also be a file.
	log.SetOutput(os.Stderr)

	// Set the default log level to Info
	if config.CFG.Debug {
		log.SetLevel(logrus.DebugLevel)
	} else {
		log.SetLevel(logrus.InfoLevel)
	}

	return log
}

func GetRelativePath(filePath string) string {
	wd, _ := os.Getwd()
	relPath, _ := filepath.Rel(wd, filePath)
	return relPath
}

// sanitizeLogField sanitizes the log fields to prevent log injection
func sanitizeLogField(input string) string {
	replacer := strings.NewReplacer(
		"\n", "\\n",
		"\r", "\\r",
		"\t", "\\t",
	)
	return replacer.Replace(input)
}

// LogRequest is a middleware that logs the HTTP method, URL, and remote address of each request
func LogRequest(handler http.Handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		remoteAddr := sanitizeLogField(r.RemoteAddr) // Sanitize remote address
		method := sanitizeLogField(r.Method)         // Sanitize HTTP method
		uri := sanitizeLogField(r.URL.String())      // Sanitize URL

		log.WithFields(logrus.Fields{
			"remote_addr": remoteAddr,
			"method":      method,
			"url":         uri,
		}).Info("Received request")

		handler.ServeHTTP(w, r)
	}
}
