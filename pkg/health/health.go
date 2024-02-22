package health

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/supporttools/website/pkg/logging"
)

// VersionInfo represents the structure of version information.
type VersionInfo struct {
	Version   string `json:"version"`
	GitCommit string `json:"gitCommit"`
	BuildTime string `json:"buildTime"`
}

var logger = logging.SetupLogging()
var version = "MISSING VERSION INFO"
var GitCommit = "MISSING GIT COMMIT"
var BuildTime = "MISSING BUILD TIME"

func HealthzHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "ok")
	}
}

// VersionHandler returns version information as JSON.
func VersionHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		logger.Info("VersionHandler")

		versionInfo := VersionInfo{
			Version:   version,
			GitCommit: GitCommit,
			BuildTime: BuildTime,
		}

		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(versionInfo); err != nil {
			logger.Error("Failed to encode version info to JSON", err)
			http.Error(w, "Failed to encode version info", http.StatusInternalServerError)
		}
	}
}
