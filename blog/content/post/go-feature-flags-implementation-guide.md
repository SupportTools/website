---
title: "Feature Flags in Go: OpenFeature, LaunchDarkly, Unleash, and Gradual Rollout Patterns"
date: 2028-06-07T00:00:00-05:00
draft: false
tags: ["Go", "Feature Flags", "OpenFeature", "LaunchDarkly", "Unleash", "A/B Testing"]
categories: ["Go", "DevOps", "Architecture"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to feature flag implementation in Go: OpenFeature SDK, LaunchDarkly and Unleash integration, local file-based flags for testing, gradual rollout percentage logic, A/B testing infrastructure, and production operational patterns."
more_link: "yes"
url: "/go-feature-flags-implementation/"
---

Feature flags decouple deployment from release, enabling continuous delivery teams to ship code independently of feature activation. A well-designed feature flag system lets engineering teams control rollout percentages, run A/B experiments, perform dark launches, and perform instant rollbacks without redeploying code. This guide covers the full spectrum: the OpenFeature standard for vendor portability, integrating LaunchDarkly and Unleash for enterprise feature management, building a local file-based provider for testing, and implementing percentage-based gradual rollout logic in Go.

<!--more-->

## Why Feature Flags Matter in Continuous Delivery

Feature flags enable patterns that would otherwise require complex branch management or careful deployment coordination:

- **Trunk-based development**: All code merges to main; incomplete features are hidden behind flags
- **Dark launches**: Deploy code to production but only activate it for internal users or a subset of traffic
- **Gradual rollouts**: Expose a new feature to 1% of users, monitor metrics, then expand to 10%, 25%, 100%
- **A/B testing**: Route users to different variants and measure conversion or engagement metrics
- **Instant kill switches**: If a new feature causes errors, disable it without a deployment
- **Canary releases**: Activate new code only for users in a specific region or cohort

The cost of not using feature flags is higher: teams revert releases, coordinate deployment windows, and maintain long-lived branches that accumulate merge debt.

## OpenFeature: The Vendor-Neutral Standard

OpenFeature is a CNCF project that provides a standard API for feature flags, with provider plugins for commercial and open-source backends. Writing against the OpenFeature SDK prevents vendor lock-in and simplifies testing.

### Installation

```bash
go get github.com/open-feature/go-sdk
```

### Core Concepts

```go
package flags

import (
    "context"
    "log/slog"

    "github.com/open-feature/go-sdk/openfeature"
)

// InitOpenFeature sets up the global OpenFeature client with the specified provider.
func InitOpenFeature(provider openfeature.FeatureProvider) error {
    if err := openfeature.SetProvider(provider); err != nil {
        return err
    }
    return nil
}

// GetClient returns a named OpenFeature client for a service or component.
func GetClient(name string) *openfeature.Client {
    return openfeature.NewClient(name)
}

// Example: evaluating feature flags throughout the application
func HandleCheckout(ctx context.Context, userID string) error {
    client := openfeature.NewClient("checkout-service")

    // Evaluation context carries targeting attributes
    evalCtx := openfeature.NewEvaluationContext(
        userID,  // Targeting key
        map[string]interface{}{
            "email":      "user@example.com",
            "plan":       "enterprise",
            "country":    "US",
            "beta_user":  true,
        },
    )

    // Boolean flag: feature on/off
    newCheckoutEnabled, err := client.BooleanValue(
        ctx,
        "new-checkout-flow",
        false,  // default value
        evalCtx,
    )
    if err != nil {
        slog.Warn("flag evaluation error", "flag", "new-checkout-flow", "error", err)
        // Default value is returned on error; continue with default
    }

    if newCheckoutEnabled {
        return handleNewCheckout(ctx, userID)
    }
    return handleLegacyCheckout(ctx, userID)
}

// String flag: variant selection
func GetRecommendationAlgorithm(ctx context.Context, userID string) string {
    client := openfeature.NewClient("recommendations")

    evalCtx := openfeature.NewEvaluationContext(userID, map[string]interface{}{})

    algorithm, err := client.StringValue(
        ctx,
        "recommendation-algorithm",
        "collaborative-filtering",  // default
        evalCtx,
    )
    if err != nil {
        return "collaborative-filtering"
    }
    return algorithm
}

// Integer flag: configuration value
func GetSearchResultsLimit(ctx context.Context, userID string) int64 {
    client := openfeature.NewClient("search")
    evalCtx := openfeature.NewEvaluationContext(userID, map[string]interface{}{})

    limit, err := client.IntValue(ctx, "search-results-limit", 20, evalCtx)
    if err != nil {
        return 20
    }
    return limit
}
```

## Local File-Based Provider for Testing

In tests and local development, a file-based provider eliminates dependencies on external services:

```go
package flagprovider

import (
    "context"
    "encoding/json"
    "fmt"
    "os"
    "sync"
    "time"

    "github.com/open-feature/go-sdk/openfeature"
    "github.com/fsnotify/fsnotify"
)

// FlagDefinition represents a feature flag in the local config file.
type FlagDefinition struct {
    DefaultVariant string                 `json:"defaultVariant"`
    Variants       map[string]interface{} `json:"variants"`
    State          string                 `json:"state"` // enabled | disabled
    Rules          []Rule                 `json:"rules"`
}

// Rule represents a targeting rule for the flag.
type Rule struct {
    Context  map[string]interface{} `json:"context"`  // attribute matching
    Variant  string                 `json:"variant"`
    Rollout  *int                   `json:"rollout"`  // percentage 0-100
}

// FileProvider is an OpenFeature provider backed by a JSON configuration file.
type FileProvider struct {
    mu       sync.RWMutex
    flags    map[string]FlagDefinition
    filePath string
}

// NewFileProvider creates a provider that loads flags from a JSON file.
// It watches the file for changes and hot-reloads.
func NewFileProvider(filePath string) (*FileProvider, error) {
    p := &FileProvider{filePath: filePath}
    if err := p.load(); err != nil {
        return nil, fmt.Errorf("loading flags from %s: %w", filePath, err)
    }

    go p.watch()
    return p, nil
}

func (p *FileProvider) load() error {
    data, err := os.ReadFile(p.filePath)
    if err != nil {
        return err
    }

    var flags map[string]FlagDefinition
    if err := json.Unmarshal(data, &flags); err != nil {
        return err
    }

    p.mu.Lock()
    p.flags = flags
    p.mu.Unlock()
    return nil
}

func (p *FileProvider) watch() {
    watcher, err := fsnotify.NewWatcher()
    if err != nil {
        return
    }
    defer watcher.Close()

    _ = watcher.Add(p.filePath)
    for {
        select {
        case event, ok := <-watcher.Events:
            if !ok {
                return
            }
            if event.Has(fsnotify.Write) || event.Has(fsnotify.Create) {
                time.Sleep(50 * time.Millisecond) // debounce
                _ = p.load()
            }
        case <-watcher.Errors:
            return
        }
    }
}

// Metadata implements openfeature.FeatureProvider.
func (p *FileProvider) Metadata() openfeature.Metadata {
    return openfeature.Metadata{Name: "file-provider"}
}

// BooleanEvaluation implements openfeature.FeatureProvider.
func (p *FileProvider) BooleanEvaluation(ctx context.Context, flag string, defaultValue bool, evalCtx openfeature.FlattenedContext) openfeature.BoolResolutionDetail {
    p.mu.RLock()
    def, ok := p.flags[flag]
    p.mu.RUnlock()

    if !ok || def.State == "disabled" {
        return openfeature.BoolResolutionDetail{
            Value: defaultValue,
            ProviderResolutionDetail: openfeature.ProviderResolutionDetail{
                Reason: openfeature.DefaultReason,
            },
        }
    }

    variant := p.resolveVariant(def, evalCtx)
    value, ok := def.Variants[variant].(bool)
    if !ok {
        return openfeature.BoolResolutionDetail{
            Value: defaultValue,
            ProviderResolutionDetail: openfeature.ProviderResolutionDetail{
                Reason:       openfeature.ErrorReason,
                ErrorMessage: "variant is not a bool",
            },
        }
    }

    return openfeature.BoolResolutionDetail{
        Value: value,
        ProviderResolutionDetail: openfeature.ProviderResolutionDetail{
            Variant: variant,
            Reason:  openfeature.TargetingMatchReason,
        },
    }
}

// StringEvaluation implements openfeature.FeatureProvider.
func (p *FileProvider) StringEvaluation(ctx context.Context, flag string, defaultValue string, evalCtx openfeature.FlattenedContext) openfeature.StringResolutionDetail {
    p.mu.RLock()
    def, ok := p.flags[flag]
    p.mu.RUnlock()

    if !ok || def.State == "disabled" {
        return openfeature.StringResolutionDetail{Value: defaultValue}
    }

    variant := p.resolveVariant(def, evalCtx)
    value, ok := def.Variants[variant].(string)
    if !ok {
        return openfeature.StringResolutionDetail{Value: defaultValue}
    }

    return openfeature.StringResolutionDetail{
        Value: value,
        ProviderResolutionDetail: openfeature.ProviderResolutionDetail{
            Variant: variant,
            Reason:  openfeature.TargetingMatchReason,
        },
    }
}

// IntEvaluation and FloatEvaluation follow the same pattern...

func (p *FileProvider) resolveVariant(def FlagDefinition, evalCtx openfeature.FlattenedContext) string {
    for _, rule := range def.Rules {
        if p.matchesContext(rule.Context, evalCtx) {
            if rule.Rollout != nil {
                if !isInRollout(evalCtx["targetingKey"].(string), *rule.Rollout) {
                    continue
                }
            }
            return rule.Variant
        }
    }
    return def.DefaultVariant
}

func (p *FileProvider) matchesContext(ruleCtx map[string]interface{}, evalCtx openfeature.FlattenedContext) bool {
    for key, expectedValue := range ruleCtx {
        actualValue, ok := evalCtx[key]
        if !ok || actualValue != expectedValue {
            return false
        }
    }
    return true
}
```

### Flag Configuration File

```json
{
  "new-checkout-flow": {
    "state": "enabled",
    "defaultVariant": "off",
    "variants": {
      "on": true,
      "off": false
    },
    "rules": [
      {
        "context": {"beta_user": true},
        "variant": "on"
      },
      {
        "rollout": 25,
        "variant": "on"
      }
    ]
  },
  "recommendation-algorithm": {
    "state": "enabled",
    "defaultVariant": "collaborative",
    "variants": {
      "collaborative": "collaborative-filtering",
      "content-based": "content-based-filtering",
      "hybrid": "hybrid-model"
    },
    "rules": [
      {
        "context": {"plan": "enterprise"},
        "variant": "hybrid"
      }
    ]
  },
  "search-results-limit": {
    "state": "enabled",
    "defaultVariant": "default",
    "variants": {
      "default": 20,
      "expanded": 50,
      "beta": 100
    }
  }
}
```

## Gradual Rollout Implementation

Percentage-based rollout must be deterministic: the same user should always get the same variant within a given flag's rollout configuration. This prevents the jarring experience of a feature appearing and disappearing on refreshes.

### Deterministic Hashing

```go
package rollout

import (
    "crypto/sha256"
    "encoding/binary"
    "fmt"
)

// IsInRollout returns true if the given targeting key falls within the rollout percentage.
// The result is deterministic: the same key always returns the same boolean for the same percentage.
// The flagName is incorporated to ensure different flags create different cohorts for the same user.
func IsInRollout(targetingKey string, flagName string, percentage int) bool {
    if percentage <= 0 {
        return false
    }
    if percentage >= 100 {
        return true
    }

    // Hash the combination of flag name and targeting key
    h := sha256.New()
    h.Write([]byte(fmt.Sprintf("%s:%s", flagName, targetingKey)))
    hashBytes := h.Sum(nil)

    // Use the first 4 bytes as a uint32 for the bucket calculation
    bucket := binary.BigEndian.Uint32(hashBytes[:4])

    // Map to 0-99 range
    userBucket := int(bucket % 100)

    return userBucket < percentage
}

// RolloutBucket returns the user's bucket number (0-99) for a given flag.
// Useful for graduated rollout steps: 10% → 25% → 50% → 100%
func RolloutBucket(targetingKey string, flagName string) int {
    h := sha256.New()
    h.Write([]byte(fmt.Sprintf("%s:%s", flagName, targetingKey)))
    hashBytes := h.Sum(nil)
    bucket := binary.BigEndian.Uint32(hashBytes[:4])
    return int(bucket % 100)
}
```

### Gradual Rollout Service

```go
package flags

import (
    "context"
    "fmt"
    "sync"
    "time"

    "github.com/yourorg/service/rollout"
)

// RolloutConfig defines the rollout schedule for a feature flag.
type RolloutConfig struct {
    FlagName   string
    Percentage int        // Current rollout percentage (0-100)
    Schedule   []RolloutStep
    UpdatedAt  time.Time
}

// RolloutStep represents a planned percentage increase.
type RolloutStep struct {
    Percentage int
    At         time.Time
}

// RolloutService manages gradual rollout percentages.
type RolloutService struct {
    mu      sync.RWMutex
    configs map[string]*RolloutConfig
}

func NewRolloutService() *RolloutService {
    return &RolloutService{
        configs: make(map[string]*RolloutConfig),
    }
}

// SetRollout updates the rollout percentage for a flag.
func (rs *RolloutService) SetRollout(flagName string, percentage int) {
    rs.mu.Lock()
    defer rs.mu.Unlock()

    if cfg, ok := rs.configs[flagName]; ok {
        cfg.Percentage = percentage
        cfg.UpdatedAt = time.Now()
    } else {
        rs.configs[flagName] = &RolloutConfig{
            FlagName:   flagName,
            Percentage: percentage,
            UpdatedAt:  time.Now(),
        }
    }
}

// IsEnabled returns true if the feature is enabled for the given targeting key.
func (rs *RolloutService) IsEnabled(ctx context.Context, flagName string, targetingKey string) bool {
    rs.mu.RLock()
    cfg, ok := rs.configs[flagName]
    rs.mu.RUnlock()

    if !ok {
        return false
    }
    return rollout.IsInRollout(targetingKey, flagName, cfg.Percentage)
}

// GetPercentage returns the current rollout percentage for a flag.
func (rs *RolloutService) GetPercentage(flagName string) int {
    rs.mu.RLock()
    defer rs.mu.RUnlock()

    if cfg, ok := rs.configs[flagName]; ok {
        return cfg.Percentage
    }
    return 0
}

// ProgressRollout advances to the next scheduled step if the time has come.
func (rs *RolloutService) ProgressRollout(flagName string) {
    rs.mu.Lock()
    defer rs.mu.Unlock()

    cfg, ok := rs.configs[flagName]
    if !ok {
        return
    }

    now := time.Now()
    for _, step := range cfg.Schedule {
        if now.After(step.At) && cfg.Percentage < step.Percentage {
            cfg.Percentage = step.Percentage
            cfg.UpdatedAt = now
        }
    }
}
```

## LaunchDarkly Integration

LaunchDarkly provides a mature feature management platform with real-time flag updates, targeting rules, and experiment analysis:

```bash
go get github.com/launchdarkly/go-server-sdk/v7
```

```go
package provider

import (
    "context"
    "fmt"
    "log/slog"
    "time"

    ld "github.com/launchdarkly/go-server-sdk/v7"
    "github.com/launchdarkly/go-server-sdk/v7/ldcomponents"
    ldcontext "github.com/launchdarkly/go-server-sdk-evaluation/v3/ldmodel"

    "gopkg.in/launchdarkly/go-sdk-common.v3/ldcontext"
    "gopkg.in/launchdarkly/go-sdk-common.v3/ldvalue"
)

// LaunchDarklyProvider wraps the LaunchDarkly SDK for use with the feature flag service.
type LaunchDarklyProvider struct {
    client *ld.LDClient
}

// NewLaunchDarklyProvider creates a LaunchDarkly provider with the given SDK key.
func NewLaunchDarklyProvider(sdkKey string) (*LaunchDarklyProvider, error) {
    config := ld.Config{
        DataSystem: ldcomponents.DataSystem().DataSource(
            ldcomponents.StreamingDataSource().
                InitialReconnectDelay(100 * time.Millisecond),
        ),
        Logging: ldcomponents.Logging().
            LogEvaluationErrors(true).
            LogContextKeyInErrors(false),
    }

    client, err := ld.MakeCustomClient(sdkKey, config, 10*time.Second)
    if err != nil {
        return nil, fmt.Errorf("initializing LaunchDarkly client: %w", err)
    }

    if !client.Initialized() {
        // Client failed to connect; can still serve from cached data
        slog.Warn("LaunchDarkly client not fully initialized, serving from cache")
    }

    return &LaunchDarklyProvider{client: client}, nil
}

// EvaluateFlag evaluates a boolean feature flag for a user context.
func (p *LaunchDarklyProvider) EvaluateFlag(
    ctx context.Context,
    flagKey string,
    userID string,
    attributes map[string]interface{},
    defaultValue bool,
) bool {
    // Build the evaluation context
    builder := ldcontext.NewBuilder(userID).Kind("user")

    for key, value := range attributes {
        switch v := value.(type) {
        case string:
            builder.SetString(key, v)
        case bool:
            builder.SetBool(key, v)
        case int:
            builder.SetInt(key, v)
        case float64:
            builder.SetFloat64(key, v)
        }
    }

    ldCtx := builder.Build()

    result, err := p.client.BoolVariation(flagKey, ldCtx, defaultValue)
    if err != nil {
        slog.Warn("LaunchDarkly evaluation error",
            "flag", flagKey,
            "userID", userID,
            "error", err,
        )
        return defaultValue
    }
    return result
}

// EvaluateFlagWithDetail returns the flag value and the reason for the evaluation result.
func (p *LaunchDarklyProvider) EvaluateFlagWithDetail(
    ctx context.Context,
    flagKey string,
    userID string,
    attributes map[string]interface{},
    defaultValue bool,
) (bool, string) {
    builder := ldcontext.NewBuilder(userID)
    for key, value := range attributes {
        switch v := value.(type) {
        case string:
            builder.SetString(key, v)
        case bool:
            builder.SetBool(key, v)
        }
    }
    ldCtx := builder.Build()

    detail, err := p.client.BoolVariationDetail(flagKey, ldCtx, defaultValue)
    if err != nil {
        return defaultValue, "ERROR"
    }

    reason := string(detail.Reason.GetKind())
    return detail.Value, reason
}

// Track records a custom event for experiment analysis.
func (p *LaunchDarklyProvider) Track(ctx context.Context, eventName string, userID string, value float64) {
    ldCtx := ldcontext.New(userID)
    _ = p.client.TrackMetric(eventName, ldCtx, value)
}

// Close shuts down the LaunchDarkly client gracefully.
func (p *LaunchDarklyProvider) Close() {
    _ = p.client.Close()
}
```

## Unleash Integration

Unleash is an open-source feature management solution, self-hostable or available as a cloud service:

```bash
go get github.com/Unleash/unleash-client-go/v4
```

```go
package provider

import (
    "context"
    "fmt"
    "log/slog"

    unleash "github.com/Unleash/unleash-client-go/v4"
    "github.com/Unleash/unleash-client-go/v4/context"
)

// UnleashProvider wraps the Unleash client.
type UnleashProvider struct {
    // Unleash uses a global client via unleash.Initialize
}

// NewUnleashProvider initializes the global Unleash client.
func NewUnleashProvider(serverURL, appName, instanceID, apiToken string) (*UnleashProvider, error) {
    err := unleash.Initialize(
        unleash.WithUrl(serverURL),
        unleash.WithAppName(appName),
        unleash.WithInstanceId(instanceID),
        unleash.WithCustomHeaders(map[string]string{
            "Authorization": apiToken,
        }),
        unleash.WithListener(&unleash.DebugListener{}),
    )
    if err != nil {
        return nil, fmt.Errorf("initializing Unleash: %w", err)
    }

    return &UnleashProvider{}, nil
}

// IsEnabled evaluates a feature toggle for the given context.
func (p *UnleashProvider) IsEnabled(
    ctx context.Context,
    toggleName string,
    userID string,
    sessionID string,
    remoteAddr string,
    properties map[string]string,
) bool {
    unleashCtx := &context.Context{
        UserId:     userID,
        SessionId:  sessionID,
        RemoteAddress: remoteAddr,
        Properties: properties,
    }

    return unleash.IsEnabled(toggleName, unleash.WithContext(unleashCtx))
}

// GetVariant returns the variant for a gradual rollout with variants.
func (p *UnleashProvider) GetVariant(
    ctx context.Context,
    toggleName string,
    userID string,
) unleash.Variant {
    unleashCtx := &context.Context{
        UserId: userID,
    }
    return unleash.GetVariant(toggleName, unleash.WithContext(unleashCtx))
}
```

## A/B Testing Infrastructure

Feature flags provide the mechanism for A/B tests, but measurement requires connecting flag assignments to outcome metrics:

```go
package experiment

import (
    "context"
    "time"

    "github.com/yourorg/service/flags"
    "github.com/yourorg/service/metrics"
)

// Assignment records which variant a user received for an experiment.
type Assignment struct {
    ExperimentID string
    UserID       string
    Variant      string
    AssignedAt   time.Time
}

// ABTestService manages experiment assignments and outcome recording.
type ABTestService struct {
    flagService     *flags.Service
    metricsRecorder *metrics.Recorder
    store           AssignmentStore
}

// AssignVariant determines which variant a user receives for an experiment.
// The assignment is persisted to ensure the same user always sees the same variant.
func (s *ABTestService) AssignVariant(
    ctx context.Context,
    experimentID string,
    userID string,
) (string, error) {
    // Check for existing assignment (sticky assignment)
    existing, err := s.store.GetAssignment(ctx, experimentID, userID)
    if err == nil {
        return existing.Variant, nil
    }

    // Evaluate flag for new assignment
    variant, err := s.flagService.StringValue(ctx, experimentID, "control", userID, nil)
    if err != nil {
        return "control", nil // default to control on error
    }

    // Persist the assignment
    assignment := &Assignment{
        ExperimentID: experimentID,
        UserID:       userID,
        Variant:      variant,
        AssignedAt:   time.Now(),
    }
    if err := s.store.SaveAssignment(ctx, assignment); err != nil {
        // Non-fatal: assignment not saved, user may get different variant on next request
        // log.Warn("assignment persistence failed", "error", err)
    }

    // Record the assignment event for analysis
    s.metricsRecorder.RecordExperimentAssignment(experimentID, variant, userID)

    return variant, nil
}

// RecordConversion records when a user completes a goal action for an experiment.
func (s *ABTestService) RecordConversion(
    ctx context.Context,
    experimentID string,
    userID string,
    goalName string,
    value float64,
) {
    assignment, err := s.store.GetAssignment(ctx, experimentID, userID)
    if err != nil {
        return // User not in experiment
    }

    s.metricsRecorder.RecordExperimentConversion(
        experimentID,
        assignment.Variant,
        goalName,
        value,
    )
}

// Usage example
func HandleProductPage(ctx context.Context, userID string, productID string) {
    svc := getABTestService()

    // Assign user to checkout button experiment
    variant, _ := svc.AssignVariant(ctx, "checkout-button-color", userID)

    // Apply variant
    buttonColor := "blue"
    if variant == "treatment" {
        buttonColor = "green"
    }

    // ... render page with buttonColor ...

    // Record page view as an exposure event
    svc.metricsRecorder.RecordExperimentExposure("checkout-button-color", variant, userID)
}

func HandleCheckoutClick(ctx context.Context, userID string) {
    svc := getABTestService()
    // Record the conversion event
    svc.RecordConversion(ctx, "checkout-button-color", userID, "checkout_click", 1.0)
}
```

## Middleware for HTTP Services

Inject feature flag evaluation results into request context for downstream handlers:

```go
package middleware

import (
    "context"
    "net/http"

    "github.com/yourorg/service/flags"
)

type contextKey string

const flagContextKey contextKey = "feature_flags"

type FlagSet map[string]interface{}

// FeatureFlagMiddleware evaluates relevant flags for each request.
func FeatureFlagMiddleware(flagService *flags.Service, flagKeys []string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            userID := r.Header.Get("X-User-ID")
            if userID == "" {
                userID = "anonymous"
            }

            evalCtx := map[string]interface{}{
                "country":  r.Header.Get("CF-IPCountry"),
                "plan":     r.Header.Get("X-User-Plan"),
                "beta":     r.Header.Get("X-Beta-User") == "true",
            }

            flagSet := make(FlagSet, len(flagKeys))
            for _, key := range flagKeys {
                value, _ := flagService.BooleanValue(r.Context(), key, false, userID, evalCtx)
                flagSet[key] = value
            }

            ctx := context.WithValue(r.Context(), flagContextKey, flagSet)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

// GetFlag retrieves a pre-evaluated flag value from the request context.
func GetFlag(ctx context.Context, key string) (interface{}, bool) {
    flagSet, ok := ctx.Value(flagContextKey).(FlagSet)
    if !ok {
        return nil, false
    }
    value, ok := flagSet[key]
    return value, ok
}

func IsEnabled(ctx context.Context, key string) bool {
    value, ok := GetFlag(ctx, key)
    if !ok {
        return false
    }
    b, ok := value.(bool)
    return ok && b
}
```

## Testing with Feature Flags

```go
package handler_test

import (
    "net/http"
    "net/http/httptest"
    "testing"

    "github.com/yourorg/service/flags"
    "github.com/yourorg/service/handler"
)

// InMemoryProvider implements openfeature.FeatureProvider for unit tests.
type InMemoryProvider struct {
    bools   map[string]bool
    strings map[string]string
}

func NewInMemoryProvider() *InMemoryProvider {
    return &InMemoryProvider{
        bools:   make(map[string]bool),
        strings: make(map[string]string),
    }
}

func (p *InMemoryProvider) SetBool(key string, value bool) {
    p.bools[key] = value
}

func (p *InMemoryProvider) SetString(key string, value string) {
    p.strings[key] = value
}

// Implement openfeature.FeatureProvider interface...
// (BooleanEvaluation, StringEvaluation, etc.)

func TestCheckoutHandler_NewCheckoutFlow(t *testing.T) {
    provider := NewInMemoryProvider()
    provider.SetBool("new-checkout-flow", true)

    svc := flags.NewService(provider)
    h := handler.NewCheckoutHandler(svc)

    req := httptest.NewRequest(http.MethodPost, "/checkout", nil)
    req.Header.Set("X-User-ID", "user-123")
    w := httptest.NewRecorder()

    h.ServeHTTP(w, req)

    if w.Code != http.StatusOK {
        t.Errorf("expected 200, got %d", w.Code)
    }
    // Verify new checkout flow was used
    // ...
}

func TestCheckoutHandler_LegacyCheckoutFlow(t *testing.T) {
    provider := NewInMemoryProvider()
    provider.SetBool("new-checkout-flow", false)

    svc := flags.NewService(provider)
    h := handler.NewCheckoutHandler(svc)

    // ... test legacy path
}

// Table-driven tests across flag combinations
func TestRecommendations(t *testing.T) {
    tests := []struct {
        name      string
        algorithm string
        expectLen int
    }{
        {"collaborative", "collaborative-filtering", 10},
        {"content-based", "content-based-filtering", 8},
        {"hybrid", "hybrid-model", 12},
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            provider := NewInMemoryProvider()
            provider.SetString("recommendation-algorithm", tt.algorithm)
            // ... test
        })
    }
}
```

## Production Operational Patterns

### Flag Hygiene and Lifecycle

Feature flags accumulate technical debt if not managed. Establish a lifecycle:

1. **Created**: Flag added for dark launch
2. **Active**: Flag being used in rollout/experiment
3. **Deprecated**: Rollout complete; code still references flag
4. **Removed**: Flag deleted from both code and flag management system

```go
// Tag flags with their lifecycle metadata
// Use linting to detect deprecated flags still referenced in code

// Example: custom linter rule to detect deprecated flags
// go/analysis linter that scans for flag keys matching a deprecation list
```

### Flag Evaluation Latency

Track how long flag evaluation takes, especially for network-backed providers:

```go
func (s *Service) BooleanValueWithMetrics(
    ctx context.Context,
    flagKey string,
    defaultValue bool,
    userID string,
    attrs map[string]interface{},
) bool {
    start := time.Now()
    defer func() {
        flagEvalDuration.WithLabelValues(flagKey).Observe(time.Since(start).Seconds())
    }()
    return s.BooleanValue(ctx, flagKey, defaultValue, userID, attrs)
}
```

### Emergency Disable

All flags should support an emergency override that disables any feature immediately, bypassing normal evaluation:

```go
// Emergency kill switch: set FEATURE_FLAGS_EMERGENCY_OFF=flag1,flag2
func (s *Service) BooleanValue(ctx context.Context, flagKey string, defaultValue bool, userID string, attrs map[string]interface{}) bool {
    if s.isEmergencyDisabled(flagKey) {
        return false
    }
    // Normal evaluation...
}
```

Feature flags are infrastructure. Treat them with the same reliability and observability standards as databases and message queues — because in a continuous delivery environment, they are the control plane for every feature your users interact with.
