---
title: "Go: Implementing Feature Flags with LaunchDarkly and OpenFeature SDK for Progressive Delivery"
date: 2031-07-09T00:00:00-05:00
draft: false
tags: ["Go", "Feature Flags", "LaunchDarkly", "OpenFeature", "Progressive Delivery", "DevOps", "Golang"]
categories: ["Go", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to implementing feature flags in Go using the OpenFeature SDK and LaunchDarkly provider for safe progressive delivery, canary releases, and A/B testing in production environments."
more_link: "yes"
url: "/go-feature-flags-launchdarkly-openfeature-sdk-progressive-delivery/"
---

Feature flags — also called feature toggles or feature switches — are one of the most powerful techniques in the progressive delivery toolkit. They allow teams to deploy code continuously while keeping new features hidden until they are ready for release, and to roll out changes to specific user segments without additional deployments. This guide walks through implementing a robust feature flag system in Go using the OpenFeature SDK for provider abstraction and LaunchDarkly as the backend, with patterns applicable to any OpenFeature-compatible provider.

<!--more-->

# Go Feature Flags with LaunchDarkly and OpenFeature SDK

## Section 1: Why Feature Flags and Why OpenFeature

Feature flags decouple deployment from release. Before feature flags, shipping a new feature meant deploying it fully to all users at once. With feature flags, you can:

- **Canary releases**: Roll out to 1%, 10%, 50%, then 100% of users while monitoring error rates.
- **Kill switches**: Instantly disable a feature causing production problems without a rollback.
- **A/B testing**: Serve variant A to half of users and variant B to the other half, measure outcomes.
- **Beta programs**: Enable features only for users who opt in or belong to specific organizations.
- **Operational flags**: Change database connection pool sizes or timeout values without redeployment.

### The OpenFeature Standard

OpenFeature (openfeature.dev) is a CNCF incubating project that defines a vendor-neutral specification and SDK for feature flagging. The critical advantage is provider abstraction: your application code uses the OpenFeature SDK API, and you swap providers (LaunchDarkly, Flagsmith, Unleash, OpenFlagd, or a custom mock) without changing application code.

```
Application Code
      |
 OpenFeature SDK (Go)
      |
 Provider Interface
      |
┌─────┴──────────────────────────────┐
│  LaunchDarkly │ Flagsmith │ Unleash │
│  OpenFlagd    │  Custom   │  Mock   │
└──────────────────────────────────── ┘
```

## Section 2: Setting Up the OpenFeature Go SDK

### Dependencies

```bash
go get go.openfeature.dev/sdk@latest
go get github.com/launchdarkly/go-server-sdk/v7@latest
go get github.com/open-feature/go-sdk-contrib/providers/launchdarkly@latest
```

### Project Structure

```
feature-flags-demo/
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── featureflags/
│   │   ├── client.go         # OpenFeature wrapper
│   │   ├── context.go        # Evaluation context builders
│   │   ├── flags.go          # Flag key constants
│   │   └── middleware.go     # HTTP middleware for flag injection
│   ├── handlers/
│   │   └── checkout.go       # Business logic using flags
│   └── config/
│       └── config.go
├── go.mod
└── go.sum
```

### Flag Key Constants

Define all flag keys as typed constants to prevent typos and enable IDE autocompletion:

```go
// internal/featureflags/flags.go
package featureflags

// Flag keys — match exactly what is configured in LaunchDarkly
const (
    // Release flags
    FlagNewCheckoutFlow         = "new-checkout-flow"
    FlagRedesignedProductPage   = "redesigned-product-page"
    FlagEnhancedSearchResults   = "enhanced-search-results"

    // Operational flags
    FlagCheckoutServiceTimeout  = "checkout-service-timeout-ms"
    FlagProductCacheSize        = "product-cache-size"
    FlagMaxConcurrentCheckouts  = "max-concurrent-checkouts"

    // Experiment flags
    FlagCheckoutButtonColor     = "checkout-button-color"
    FlagProductRecommendations  = "product-recommendation-algorithm"

    // Kill switches
    FlagDisableInventoryCheck   = "disable-inventory-check"
    FlagDisableEmailNotifs      = "disable-email-notifications"
)

// Variation value type documentation
// FlagNewCheckoutFlow          -> bool
// FlagRedesignedProductPage    -> bool
// FlagCheckoutServiceTimeout   -> int (milliseconds)
// FlagProductCacheSize         -> int (number of items)
// FlagCheckoutButtonColor      -> string ("blue", "green", "orange")
// FlagProductRecommendations   -> string ("collaborative", "content-based", "hybrid")
// FlagDisableInventoryCheck    -> bool
```

## Section 3: OpenFeature Client Wrapper

A wrapper around the OpenFeature client provides type-safe accessors, sensible defaults, and centralized logging of flag evaluations.

```go
// internal/featureflags/client.go
package featureflags

import (
    "context"
    "fmt"
    "log/slog"
    "time"

    "go.openfeature.dev/sdk"
    of "go.openfeature.dev/sdk/pkg/openfeature"
)

// Client wraps the OpenFeature client with typed accessors and
// evaluation event logging.
type Client struct {
    of     *of.Client
    logger *slog.Logger
}

// NewClient creates a new feature flag client for the given domain.
// The domain name is used to namespace flag evaluations in logs and metrics.
func NewClient(domain string, logger *slog.Logger) *Client {
    return &Client{
        of:     sdk.NewClient(domain),
        logger: logger,
    }
}

// BoolValue evaluates a boolean flag with the given context and default value.
// It logs all evaluation details for auditability.
func (c *Client) BoolValue(ctx context.Context, flagKey string, defaultValue bool, evalCtx of.EvaluationContext) bool {
    result, err := c.of.BooleanValueDetails(ctx, flagKey, defaultValue, evalCtx)
    if err != nil {
        c.logger.Error("feature flag evaluation error",
            "flag_key", flagKey,
            "default", defaultValue,
            "error", err,
        )
        return defaultValue
    }

    c.logger.Debug("feature flag evaluated",
        "flag_key", flagKey,
        "value", result.Value,
        "reason", result.Reason,
        "variant", result.Variant,
        "target_key", evalCtx.TargetingKey(),
    )

    return result.Value
}

// StringValue evaluates a string flag.
func (c *Client) StringValue(ctx context.Context, flagKey, defaultValue string, evalCtx of.EvaluationContext) string {
    result, err := c.of.StringValueDetails(ctx, flagKey, defaultValue, evalCtx)
    if err != nil {
        c.logger.Error("feature flag evaluation error",
            "flag_key", flagKey,
            "default", defaultValue,
            "error", err,
        )
        return defaultValue
    }

    c.logger.Debug("feature flag evaluated",
        "flag_key", flagKey,
        "value", result.Value,
        "reason", result.Reason,
        "variant", result.Variant,
    )

    return result.Value
}

// IntValue evaluates an integer flag.
func (c *Client) IntValue(ctx context.Context, flagKey string, defaultValue int64, evalCtx of.EvaluationContext) int64 {
    result, err := c.of.IntValueDetails(ctx, flagKey, defaultValue, evalCtx)
    if err != nil {
        c.logger.Error("feature flag evaluation error",
            "flag_key", flagKey,
            "default", defaultValue,
            "error", err,
        )
        return defaultValue
    }
    return result.Value
}

// FloatValue evaluates a float flag.
func (c *Client) FloatValue(ctx context.Context, flagKey string, defaultValue float64, evalCtx of.EvaluationContext) float64 {
    result, err := c.of.FloatValueDetails(ctx, flagKey, defaultValue, evalCtx)
    if err != nil {
        c.logger.Error("feature flag evaluation error",
            "flag_key", flagKey,
            "default", defaultValue,
            "error", err,
        )
        return defaultValue
    }
    return result.Value
}

// WaitForReady blocks until the provider is ready or the timeout elapses.
func WaitForReady(timeout time.Duration) error {
    deadline := time.Now().Add(timeout)
    for time.Now().Before(deadline) {
        state := sdk.GetProviderStatus()
        if state == of.ReadyState {
            return nil
        }
        if state == of.ErrorState {
            return fmt.Errorf("feature flag provider entered error state")
        }
        time.Sleep(100 * time.Millisecond)
    }
    return fmt.Errorf("feature flag provider did not become ready within %s", timeout)
}
```

## Section 4: Evaluation Context Builders

The evaluation context carries the attributes used by LaunchDarkly's targeting rules (user key, attributes, segments).

```go
// internal/featureflags/context.go
package featureflags

import (
    of "go.openfeature.dev/sdk/pkg/openfeature"
)

// UserContext represents the authenticated user making a request.
type UserContext struct {
    UserID       string
    Email        string
    Organization string
    Plan         string            // "free", "pro", "enterprise"
    Country      string
    Attributes   map[string]interface{}
}

// BuildUserEvalContext creates an OpenFeature EvaluationContext from a UserContext.
// The targeting key is the user ID, and all other fields become custom attributes
// that LaunchDarkly rules can target.
func BuildUserEvalContext(user UserContext) of.EvaluationContext {
    attrs := of.NewEvaluationContext(
        user.UserID,
        map[string]interface{}{
            "email":        user.Email,
            "organization": user.Organization,
            "plan":         user.Plan,
            "country":      user.Country,
            "kind":         "user",
        },
    )

    // Merge any additional custom attributes
    for k, v := range user.Attributes {
        attrs.Attributes()[k] = v
    }

    return attrs
}

// BuildAnonymousContext creates an EvaluationContext for unauthenticated requests.
// A session ID or device ID is used as the targeting key to maintain consistent
// flag evaluations within a session.
func BuildAnonymousContext(sessionID string) of.EvaluationContext {
    return of.NewEvaluationContext(
        sessionID,
        map[string]interface{}{
            "anonymous": true,
            "kind":      "user",
        },
    )
}

// BuildOrganizationContext creates a multi-context for B2B targeting.
// Multi-contexts allow LaunchDarkly to target based on both user and organization
// attributes simultaneously.
func BuildOrganizationContext(user UserContext, orgID, orgPlan string, orgSize int) of.EvaluationContext {
    return of.NewEvaluationContext(
        user.UserID,
        map[string]interface{}{
            "email":             user.Email,
            "plan":              user.Plan,
            "country":           user.Country,
            "kind":              "multi",
            "organization_id":   orgID,
            "organization_plan": orgPlan,
            "organization_size": orgSize,
        },
    )
}
```

## Section 5: LaunchDarkly Provider Initialization

```go
// internal/featureflags/provider.go
package featureflags

import (
    "fmt"
    "log/slog"
    "time"

    ldgoflags "github.com/open-feature/go-sdk-contrib/providers/launchdarkly/pkg"
    "go.openfeature.dev/sdk"
    ld "github.com/launchdarkly/go-server-sdk/v7"
    "github.com/launchdarkly/go-server-sdk/v7/ldcomponents"
)

// ProviderConfig holds configuration for the LaunchDarkly provider.
type ProviderConfig struct {
    SDKKey          string
    InitTimeout     time.Duration
    StreamingEnabled bool
    // For offline/testing mode
    Offline         bool
    // Optional: point to a LaunchDarkly Relay Proxy
    StreamingBaseURI string
    PollingBaseURI   string
    EventsBaseURI    string
}

// InitLaunchDarkly initializes the LaunchDarkly SDK and registers it as the
// OpenFeature provider. This must be called once at application startup.
func InitLaunchDarkly(cfg ProviderConfig, logger *slog.Logger) (func(), error) {
    if cfg.SDKKey == "" {
        return nil, fmt.Errorf("LaunchDarkly SDK key is required")
    }

    // Build the LD config
    ldConfig := ld.Config{}

    if cfg.Offline {
        ldConfig.Offline = true
    }

    // Configure streaming vs polling
    if cfg.StreamingEnabled {
        streamConfig := ldcomponents.StreamingDataSource()
        if cfg.StreamingBaseURI != "" {
            streamConfig.BaseURI(cfg.StreamingBaseURI)
        }
        ldConfig.DataSource = streamConfig
    } else {
        pollConfig := ldcomponents.PollingDataSource()
        pollConfig.PollInterval(30 * time.Second)
        if cfg.PollingBaseURI != "" {
            pollConfig.BaseURI(cfg.PollingBaseURI)
        }
        ldConfig.DataSource = pollConfig
    }

    // Configure event delivery
    eventsConfig := ldcomponents.SendEvents()
    if cfg.EventsBaseURI != "" {
        eventsConfig.BaseURI(cfg.EventsBaseURI)
    }
    eventsConfig.FlushInterval(5 * time.Second)
    ldConfig.Events = eventsConfig

    // Create the LaunchDarkly client
    ldClient, err := ld.MakeCustomClient(cfg.SDKKey, ldConfig, cfg.InitTimeout)
    if err != nil {
        return nil, fmt.Errorf("failed to initialize LaunchDarkly client: %w", err)
    }

    if !ldClient.Initialized() {
        logger.Warn("LaunchDarkly client not fully initialized, using default values for flags")
    }

    // Create and register the OpenFeature provider
    provider, err := ldgoflags.NewProvider(ldClient)
    if err != nil {
        ldClient.Close()
        return nil, fmt.Errorf("failed to create LaunchDarkly OpenFeature provider: %w", err)
    }

    if err := sdk.SetProvider(provider); err != nil {
        ldClient.Close()
        return nil, fmt.Errorf("failed to set OpenFeature provider: %w", err)
    }

    logger.Info("LaunchDarkly OpenFeature provider initialized",
        "sdk_version", ld.Version,
        "initialized", ldClient.Initialized(),
    )

    // Return cleanup function
    cleanup := func() {
        logger.Info("Closing LaunchDarkly client")
        ldClient.Close()
    }

    return cleanup, nil
}

// InitInMemoryProvider initializes a simple in-memory provider for testing.
// Flag values can be set directly without a real LaunchDarkly connection.
func InitInMemoryProvider(flags map[string]interface{}) error {
    // Use OpenFlagD's in-process provider or a custom mock provider for tests
    // This is environment-specific implementation
    return nil
}
```

## Section 6: Application Integration Patterns

### HTTP Middleware for Context Propagation

```go
// internal/featureflags/middleware.go
package featureflags

import (
    "context"
    "net/http"

    of "go.openfeature.dev/sdk/pkg/openfeature"
)

type contextKey string

const (
    evalContextKey contextKey = "feature_flag_eval_context"
)

// UserFromRequest is a function type that extracts user information from a request.
// Implement this based on your authentication mechanism.
type UserFromRequest func(r *http.Request) (UserContext, bool)

// EvalContextMiddleware extracts the user from the request and stores the
// OpenFeature EvaluationContext in the request context for downstream handlers.
func EvalContextMiddleware(extractUser UserFromRequest) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            var evalCtx of.EvaluationContext

            if user, ok := extractUser(r); ok {
                evalCtx = BuildUserEvalContext(user)
            } else {
                // Use session cookie or generate anonymous context
                sessionID := getSessionID(r)
                evalCtx = BuildAnonymousContext(sessionID)
            }

            ctx := context.WithValue(r.Context(), evalContextKey, evalCtx)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

// EvalContextFromContext retrieves the evaluation context from the request context.
func EvalContextFromContext(ctx context.Context) (of.EvaluationContext, bool) {
    evalCtx, ok := ctx.Value(evalContextKey).(of.EvaluationContext)
    return evalCtx, ok
}

func getSessionID(r *http.Request) string {
    cookie, err := r.Cookie("session_id")
    if err != nil || cookie.Value == "" {
        return "anonymous-" + r.RemoteAddr
    }
    return cookie.Value
}
```

### Using Flags in Business Logic

```go
// internal/handlers/checkout.go
package handlers

import (
    "context"
    "encoding/json"
    "net/http"
    "time"

    "github.com/your-org/your-app/internal/featureflags"
    of "go.openfeature.dev/sdk/pkg/openfeature"
)

type CheckoutHandler struct {
    flags         *featureflags.Client
    checkoutSvc   CheckoutService
    inventorySvc  InventoryService
}

func NewCheckoutHandler(flags *featureflags.Client, checkout CheckoutService, inventory InventoryService) *CheckoutHandler {
    return &CheckoutHandler{
        flags:        flags,
        checkoutSvc:  checkout,
        inventorySvc: inventory,
    }
}

func (h *CheckoutHandler) HandleCheckout(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    // Get the evaluation context set by middleware
    evalCtx, ok := featureflags.EvalContextFromContext(ctx)
    if !ok {
        evalCtx = of.NewEvaluationContext("anonymous", nil)
    }

    // Read operational flag: timeout in milliseconds
    timeoutMS := h.flags.IntValue(ctx, featureflags.FlagCheckoutServiceTimeout, 5000, evalCtx)
    checkoutCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMS)*time.Millisecond)
    defer cancel()

    // Kill switch: skip inventory validation if the flag is enabled
    skipInventory := h.flags.BoolValue(ctx, featureflags.FlagDisableInventoryCheck, false, evalCtx)

    var request CheckoutRequest
    if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
        http.Error(w, "invalid request body", http.StatusBadRequest)
        return
    }

    // Feature flag: use new checkout flow for eligible users
    useNewFlow := h.flags.BoolValue(ctx, featureflags.FlagNewCheckoutFlow, false, evalCtx)

    var result *CheckoutResult
    var err error

    if useNewFlow {
        result, err = h.checkoutSvc.ProcessV2(checkoutCtx, request, skipInventory)
    } else {
        result, err = h.checkoutSvc.ProcessV1(checkoutCtx, request, skipInventory)
    }

    if err != nil {
        http.Error(w, "checkout failed", http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(result)
}

// ProductPageHandler demonstrates string flag usage for A/B testing
type ProductPageHandler struct {
    flags *featureflags.Client
}

func (h *ProductPageHandler) HandleProductPage(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    evalCtx, _ := featureflags.EvalContextFromContext(ctx)

    // Get the button color variant for A/B testing
    buttonColor := h.flags.StringValue(ctx, featureflags.FlagCheckoutButtonColor, "blue", evalCtx)

    // Get recommendation algorithm
    recAlgorithm := h.flags.StringValue(
        ctx,
        featureflags.FlagProductRecommendations,
        "collaborative",
        evalCtx,
    )

    // Use redesigned page layout
    useRedesign := h.flags.BoolValue(ctx, featureflags.FlagRedesignedProductPage, false, evalCtx)

    response := ProductPageResponse{
        Layout:              "v1",
        CheckoutButtonColor: buttonColor,
        RecommendationAlgo:  recAlgorithm,
    }

    if useRedesign {
        response.Layout = "v2"
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(response)
}
```

## Section 7: Testing with Feature Flags

### Mock Provider for Unit Tests

```go
// internal/featureflags/mock_provider.go
package featureflags

import (
    "context"
    "sync"

    of "go.openfeature.dev/sdk/pkg/openfeature"
)

// MockProvider implements the OpenFeature provider interface for testing.
// It allows tests to set flag values without network calls.
type MockProvider struct {
    mu    sync.RWMutex
    flags map[string]interface{}
    name  string
}

func NewMockProvider() *MockProvider {
    return &MockProvider{
        flags: make(map[string]interface{}),
        name:  "mock-provider",
    }
}

func (p *MockProvider) Metadata() of.Metadata {
    return of.Metadata{Name: p.name}
}

func (p *MockProvider) Hooks() []of.Hook { return nil }

func (p *MockProvider) SetFlag(key string, value interface{}) {
    p.mu.Lock()
    defer p.mu.Unlock()
    p.flags[key] = value
}

func (p *MockProvider) BooleanEvaluation(
    ctx context.Context,
    flag string,
    defaultValue bool,
    evalCtx of.FlattenedContext,
) of.BoolResolutionDetail {
    p.mu.RLock()
    defer p.mu.RUnlock()

    if val, ok := p.flags[flag]; ok {
        if boolVal, ok := val.(bool); ok {
            return of.BoolResolutionDetail{
                Value:                    boolVal,
                ProviderResolutionDetail: of.ProviderResolutionDetail{Reason: of.StaticReason},
            }
        }
    }

    return of.BoolResolutionDetail{
        Value:                    defaultValue,
        ProviderResolutionDetail: of.ProviderResolutionDetail{Reason: of.DefaultReason},
    }
}

func (p *MockProvider) StringEvaluation(
    ctx context.Context,
    flag, defaultValue string,
    evalCtx of.FlattenedContext,
) of.StringResolutionDetail {
    p.mu.RLock()
    defer p.mu.RUnlock()

    if val, ok := p.flags[flag]; ok {
        if strVal, ok := val.(string); ok {
            return of.StringResolutionDetail{
                Value:                    strVal,
                ProviderResolutionDetail: of.ProviderResolutionDetail{Reason: of.StaticReason},
            }
        }
    }

    return of.StringResolutionDetail{
        Value:                    defaultValue,
        ProviderResolutionDetail: of.ProviderResolutionDetail{Reason: of.DefaultReason},
    }
}

func (p *MockProvider) IntEvaluation(
    ctx context.Context,
    flag string,
    defaultValue int64,
    evalCtx of.FlattenedContext,
) of.IntResolutionDetail {
    p.mu.RLock()
    defer p.mu.RUnlock()

    if val, ok := p.flags[flag]; ok {
        switch v := val.(type) {
        case int64:
            return of.IntResolutionDetail{Value: v}
        case int:
            return of.IntResolutionDetail{Value: int64(v)}
        }
    }
    return of.IntResolutionDetail{Value: defaultValue}
}

func (p *MockProvider) FloatEvaluation(
    ctx context.Context,
    flag string,
    defaultValue float64,
    evalCtx of.FlattenedContext,
) of.FloatResolutionDetail {
    p.mu.RLock()
    defer p.mu.RUnlock()

    if val, ok := p.flags[flag]; ok {
        if fVal, ok := val.(float64); ok {
            return of.FloatResolutionDetail{Value: fVal}
        }
    }
    return of.FloatResolutionDetail{Value: defaultValue}
}

func (p *MockProvider) ObjectEvaluation(
    ctx context.Context,
    flag string,
    defaultValue interface{},
    evalCtx of.FlattenedContext,
) of.InterfaceResolutionDetail {
    return of.InterfaceResolutionDetail{Value: defaultValue}
}
```

### Writing Tests with the Mock Provider

```go
// internal/handlers/checkout_test.go
package handlers_test

import (
    "bytes"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"

    "github.com/your-org/your-app/internal/featureflags"
    "github.com/your-org/your-app/internal/handlers"
    "go.openfeature.dev/sdk"
    of "go.openfeature.dev/sdk/pkg/openfeature"
)

func setupMockFlags(t *testing.T, flagValues map[string]interface{}) *featureflags.Client {
    t.Helper()

    mock := featureflags.NewMockProvider()
    for k, v := range flagValues {
        mock.SetFlag(k, v)
    }

    if err := sdk.SetProviderAndWait(mock); err != nil {
        t.Fatalf("failed to set mock provider: %v", err)
    }

    return featureflags.NewClient("test", nil)
}

func TestCheckoutWithNewFlow(t *testing.T) {
    flags := setupMockFlags(t, map[string]interface{}{
        featureflags.FlagNewCheckoutFlow:        true,
        featureflags.FlagCheckoutServiceTimeout: int64(3000),
        featureflags.FlagDisableInventoryCheck:  false,
    })

    mockCheckout := &MockCheckoutService{
        v2Response: &CheckoutResult{OrderID: "order-123"},
    }

    handler := handlers.NewCheckoutHandler(flags, mockCheckout, nil)

    body := CheckoutRequest{CartID: "cart-456", PaymentToken: "<payment-token>"}
    bodyBytes, _ := json.Marshal(body)
    req := httptest.NewRequest(http.MethodPost, "/checkout", bytes.NewReader(bodyBytes))

    // Set evaluation context on request
    evalCtx := featureflags.BuildUserEvalContext(featureflags.UserContext{
        UserID: "user-789",
        Plan:   "enterprise",
    })
    ctx := context.WithValue(req.Context(), featureflags.EvalContextKey, evalCtx)
    req = req.WithContext(ctx)

    rr := httptest.NewRecorder()
    handler.HandleCheckout(rr, req)

    if rr.Code != http.StatusOK {
        t.Errorf("expected 200, got %d: %s", rr.Code, rr.Body.String())
    }

    // Verify v2 flow was called
    if !mockCheckout.v2Called {
        t.Error("expected v2 checkout flow to be called")
    }
}

func TestCheckoutKillSwitch(t *testing.T) {
    flags := setupMockFlags(t, map[string]interface{}{
        featureflags.FlagDisableInventoryCheck: true,
        featureflags.FlagNewCheckoutFlow:       false,
    })

    mockCheckout := &MockCheckoutService{
        v1Response: &CheckoutResult{OrderID: "order-skip-inv"},
    }

    handler := handlers.NewCheckoutHandler(flags, mockCheckout, nil)

    body := CheckoutRequest{CartID: "cart-111"}
    bodyBytes, _ := json.Marshal(body)
    req := httptest.NewRequest(http.MethodPost, "/checkout", bytes.NewReader(bodyBytes))

    rr := httptest.NewRecorder()
    handler.HandleCheckout(rr, req)

    if !mockCheckout.skipInventoryPassed {
        t.Error("expected skipInventory=true to be passed to checkout service")
    }
}
```

## Section 8: LaunchDarkly Flag Configuration Best Practices

### Naming Conventions

Use a consistent naming pattern for all flags in LaunchDarkly:

```
{service}-{feature-area}-{flag-name}
```

Examples:
- `checkout-payment-new-flow`
- `search-algorithm-v2-enabled`
- `api-gateway-rate-limit-multiplier`

### Targeting Rules in LaunchDarkly

Configure targeting rules using user attributes set in the evaluation context:

```json
{
  "key": "new-checkout-flow",
  "on": true,
  "variations": [true, false],
  "fallthrough": {"variation": 1},
  "targets": [],
  "rules": [
    {
      "description": "Enable for internal employees",
      "clauses": [
        {
          "attribute": "email",
          "op": "endsWith",
          "values": ["@company.com"]
        }
      ],
      "variation": 0
    },
    {
      "description": "Enable for enterprise plan customers",
      "clauses": [
        {
          "attribute": "plan",
          "op": "in",
          "values": ["enterprise"]
        }
      ],
      "variation": 0
    },
    {
      "description": "Percentage rollout for pro plan",
      "clauses": [
        {
          "attribute": "plan",
          "op": "in",
          "values": ["pro"]
        }
      ],
      "rollout": {
        "variations": [
          {"variation": 0, "weight": 10000},
          {"variation": 1, "weight": 90000}
        ]
      }
    }
  ]
}
```

### Flag Lifecycle Management

Flags that are no longer needed create technical debt. Implement a flag lifecycle policy:

1. **Creation**: Flag created with owner and expiration date in LaunchDarkly tags.
2. **Rollout**: Progressive percentage rollout with monitoring.
3. **Graduation**: Flag reaches 100% rollout.
4. **Cleanup**: Flag value hardcoded in code, flag deleted from LaunchDarkly.

```go
// Use build tags to enforce flag cleanup
// When a flag is graduated and hardcoded:
// +build !feature_new_checkout_flow_cleanup

// Once the flag code path is removed:
// +build feature_new_checkout_flow_cleanup
```

## Section 9: Observability and Monitoring

Track flag evaluation metrics using Prometheus:

```go
// internal/featureflags/metrics.go
package featureflags

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    flagEvaluationsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "feature_flag_evaluations_total",
            Help: "Total number of feature flag evaluations.",
        },
        []string{"flag_key", "value", "reason"},
    )

    flagEvaluationDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "feature_flag_evaluation_duration_seconds",
            Help:    "Duration of feature flag evaluations.",
            Buckets: []float64{0.0001, 0.0005, 0.001, 0.005, 0.01},
        },
        []string{"flag_key"},
    )
)

// InstrumentedClient wraps Client with Prometheus metrics.
type InstrumentedClient struct {
    *Client
}

func (c *InstrumentedClient) BoolValue(ctx context.Context, flagKey string, defaultValue bool, evalCtx of.EvaluationContext) bool {
    timer := prometheus.NewTimer(flagEvaluationDuration.WithLabelValues(flagKey))
    defer timer.ObserveDuration()

    val := c.Client.BoolValue(ctx, flagKey, defaultValue, evalCtx)

    flagEvaluationsTotal.WithLabelValues(
        flagKey,
        fmt.Sprintf("%v", val),
        "evaluated",
    ).Inc()

    return val
}
```

## Conclusion

The combination of the OpenFeature SDK and LaunchDarkly provides a production-grade feature flagging system that gives Go teams the ability to ship code continuously while maintaining full control over feature exposure. The provider abstraction means you can start with LaunchDarkly and migrate to another backend without touching application code. The mock provider pattern makes unit tests deterministic and fast. Combined with the operational patterns described here — typed flag constants, evaluation context middleware, instrumented clients, and a clear flag lifecycle policy — you have a complete progressive delivery foundation that scales from a single service to hundreds of microservices across multiple clusters.
