// Package botfilter holds the HogQL bot definition shared with PostHog.
//
// bot-filter.hogql is a copy of analytics/bot-filter.hogql, the expression saved
// as project 78897's test-account filter. A test keeps the two identical, so the
// exporter's numbers and PostHog's insights exclude the same traffic.
package botfilter

import (
	_ "embed"
	"strings"
)

//go:embed bot-filter.hogql
var raw string

// Human is a HogQL boolean that is true for events from real readers.
func Human() string { return strings.TrimSpace(raw) }

// Bot is a HogQL boolean that is true for the filtered bot traffic.
func Bot() string { return "NOT (" + Human() + ")" }
