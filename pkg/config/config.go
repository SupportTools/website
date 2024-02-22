package config

import (
	"log"
	"os"
	"strconv"
)

// AppConfig structure for environment-based configurations.
type AppConfig struct {
	Debug       bool   `json:"debug"`
	Port        int    `json:"port"`
	MetricsPort int    `json:"metricsPort"`
	WebRoot     string `json:"webroot"`
}

var CFG AppConfig

// LoadConfiguration loads configuration from environment variables.
func LoadConfiguration() {
	CFG.Debug = parseEnvBool("DEBUG", false)                // Assuming false as the default value
	CFG.Port = parseEnvInt("PORT", 8080)                    // Assuming 8080 as the default port
	CFG.MetricsPort = parseEnvInt("METRICS_PORT", 9090)     // Assuming 9090 as the default port
	CFG.WebRoot = getEnvOrDefault("WEBROOT", "/app/public") // Assuming "/app/public" as the default web root
}

func getEnvOrDefault(key, defaultValue string) string {
	if value, exists := os.LookupEnv(key); exists {
		return value
	}
	return defaultValue
}

func parseEnvInt(key string, defaultValue int) int {
	value, exists := os.LookupEnv(key)
	if !exists {
		return defaultValue
	}
	intValue, err := strconv.Atoi(value)
	if err != nil {
		log.Printf("Error parsing %s as int: %v. Using default value: %d", key, err, defaultValue)
		return defaultValue
	}
	return intValue
}

func parseEnvBool(key string, defaultValue bool) bool {
	value, exists := os.LookupEnv(key)
	if !exists {
		return defaultValue
	}
	boolValue, err := strconv.ParseBool(value)
	if err != nil {
		log.Printf("Error parsing %s as bool: %v. Using default value: %t", key, err, defaultValue)
		return defaultValue
	}
	return boolValue
}
