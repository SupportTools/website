---
title: "Kubernetes Rollout Strategies: Blue-Green, Canary, and Feature Flag Integration"
date: 2031-04-26T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Deployments", "Canary", "Blue-Green", "Feature Flags", "Argo Rollouts"]
categories:
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Kubernetes rollout strategies: native rolling update configuration, blue-green via Service selector switching, Argo Rollouts canary with header-based routing, LaunchDarkly and Unleash feature flag integration, traffic shadowing, and automated rollback triggers based on Prometheus metrics."
more_link: "yes"
url: "/kubernetes-rollout-strategies-blue-green-canary-feature-flags/"
---

Releasing software to production is the moment of highest risk in the deployment lifecycle. The traditional binary release model — old version replaced by new version — concentrates all risk at a single point in time. Progressive delivery strategies — rolling updates, blue-green, canary, and feature flags — spread risk across time and user segments, providing observation windows and rapid rollback paths.

This guide covers the full spectrum of Kubernetes rollout strategies from the native rolling update mechanism through Argo Rollouts advanced canary analysis with automated Prometheus-based rollback triggers, and shows how to integrate feature flag systems for controlled user exposure independent of deployment state.

<!--more-->

# Kubernetes Rollout Strategies: Blue-Green, Canary, and Feature Flag Integration

## Section 1: Native Kubernetes Rolling Updates

### Rolling Update Configuration

Kubernetes Deployments support rolling updates natively through the `spec.strategy` field. The key parameters are `maxSurge` (how many extra pods to run during rollout) and `maxUnavailable` (how many pods can be unavailable):

```yaml
# deployment-rolling-update.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-service
  namespace: production
spec:
  replicas: 10
  strategy:
    type: RollingUpdate
    rollingUpdate:
      # Run up to 2 extra pods during rollout (20% above desired)
      maxSurge: 2
      # Allow 0 pods to be unavailable (zero-downtime requirement)
      maxUnavailable: 0
  selector:
    matchLabels:
      app: api-service
  template:
    metadata:
      labels:
        app: api-service
        version: v2.1.0
    spec:
      containers:
      - name: api-service
        image: registry.support.tools/api-service:v2.1.0
        readinessProbe:
          httpGet:
            path: /readyz
            port: 8080
          # Crucial: wait for the app to be ready before routing traffic
          initialDelaySeconds: 10
          periodSeconds: 5
          successThreshold: 2
          failureThreshold: 3
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10
        lifecycle:
          preStop:
            exec:
              # Allow in-flight requests to complete before pod termination
              command: ["/bin/sh", "-c", "sleep 10"]
      terminationGracePeriodSeconds: 60
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: kubernetes.io/hostname
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: api-service
```

### Monitoring a Rolling Update

```bash
# Watch the rollout status
kubectl rollout status deployment/api-service -n production --timeout=10m

# Get detailed rollout history
kubectl rollout history deployment/api-service -n production

# Get details on a specific revision
kubectl rollout history deployment/api-service -n production --revision=3

# Rollback to the previous version
kubectl rollout undo deployment/api-service -n production

# Rollback to a specific revision
kubectl rollout undo deployment/api-service -n production --to-revision=2
```

### Rolling Update Limits for Stateful Applications

For applications where you need to control rollout speed more precisely:

```bash
# Pause a rollout after deploying a percentage of pods
kubectl set image deployment/api-service api-service=registry.support.tools/api-service:v2.1.0 -n production
kubectl rollout pause deployment/api-service -n production

# Monitor metrics, then resume
kubectl rollout resume deployment/api-service -n production
```

## Section 2: Blue-Green Deployment via Service Selector

### Architecture

Blue-green deployment maintains two identical production environments. "Blue" is the current version, "green" is the new version. The switch is atomic — the Service's `selector` is updated to point to the green deployment:

```
Load Balancer → Service (selector: version=blue)
                     ↓
               Blue Deployment (current version, 10 replicas)

               Green Deployment (new version, 10 replicas) ← pre-warmed, ready
```

After testing the green deployment:

```
Load Balancer → Service (selector: version=green)
                     ↓
               Green Deployment (now active)

               Blue Deployment (idle, kept for rollback)
```

### Implementing Blue-Green

```yaml
# blue-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-service-blue
  namespace: production
  labels:
    app: api-service
    color: blue
    version: v2.0.0
spec:
  replicas: 10
  selector:
    matchLabels:
      app: api-service
      color: blue
  template:
    metadata:
      labels:
        app: api-service
        color: blue
        version: v2.0.0
    spec:
      containers:
      - name: api-service
        image: registry.support.tools/api-service:v2.0.0
        readinessProbe:
          httpGet:
            path: /readyz
            port: 8080
          periodSeconds: 5
---
# green-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-service-green
  namespace: production
  labels:
    app: api-service
    color: green
    version: v2.1.0
spec:
  replicas: 10  # Same replica count
  selector:
    matchLabels:
      app: api-service
      color: green
  template:
    metadata:
      labels:
        app: api-service
        color: green
        version: v2.1.0
    spec:
      containers:
      - name: api-service
        image: registry.support.tools/api-service:v2.1.0
        readinessProbe:
          httpGet:
            path: /readyz
            port: 8080
          periodSeconds: 5
---
# service.yaml
apiVersion: v1
kind: Service
metadata:
  name: api-service
  namespace: production
spec:
  selector:
    app: api-service
    color: blue  # Currently pointing to blue
  ports:
  - port: 80
    targetPort: 8080
```

### Blue-Green Switch Automation

```bash
#!/bin/bash
# blue-green-switch.sh
set -euo pipefail

NAMESPACE="production"
SERVICE_NAME="api-service"
NEW_VERSION="$1"  # "blue" or "green"
SMOKE_TEST_URL="https://api.support.tools/healthz"
SMOKE_TEST_TIMEOUT=60

echo "=== Blue-Green Switch to ${NEW_VERSION} ==="

# Verify the new deployment is ready
DEPLOYMENT_NAME="${SERVICE_NAME}-${NEW_VERSION}"
echo "Checking ${DEPLOYMENT_NAME} readiness..."

kubectl -n "${NAMESPACE}" rollout status \
    deployment/"${DEPLOYMENT_NAME}" \
    --timeout=5m

READY=$(kubectl -n "${NAMESPACE}" get deployment "${DEPLOYMENT_NAME}" \
    -o jsonpath='{.status.readyReplicas}')
DESIRED=$(kubectl -n "${NAMESPACE}" get deployment "${DEPLOYMENT_NAME}" \
    -o jsonpath='{.spec.replicas}')

if [ "${READY}" != "${DESIRED}" ]; then
    echo "ERROR: ${DEPLOYMENT_NAME} has ${READY}/${DESIRED} ready replicas"
    exit 1
fi

echo "Deployment ${DEPLOYMENT_NAME} is ready (${READY}/${DESIRED} replicas)"

# Run pre-switch smoke test against the new deployment directly
echo "Running pre-switch smoke tests..."
kubectl -n "${NAMESPACE}" run smoke-test \
    --image=curlimages/curl:latest \
    --restart=Never \
    --rm \
    --attach \
    -- curl -sf "http://${DEPLOYMENT_NAME}/healthz" || {
    echo "ERROR: Pre-switch smoke test failed"
    exit 1
}

echo "Smoke tests passed"

# Execute the switch
echo "Switching service selector to color=${NEW_VERSION}..."
kubectl -n "${NAMESPACE}" patch service "${SERVICE_NAME}" \
    --type=merge \
    -p "{\"spec\":{\"selector\":{\"color\":\"${NEW_VERSION}\"}}}"

echo "Service selector updated to ${NEW_VERSION}"

# Wait for the switch to propagate (endpoints to update)
sleep 5

# Validate the switch
CURRENT_SELECTOR=$(kubectl -n "${NAMESPACE}" get service "${SERVICE_NAME}" \
    -o jsonpath='{.spec.selector.color}')
echo "Current selector: color=${CURRENT_SELECTOR}"

if [ "${CURRENT_SELECTOR}" != "${NEW_VERSION}" ]; then
    echo "ERROR: Selector was not updated correctly"
    exit 1
fi

# Run post-switch smoke tests
echo "Running post-switch smoke tests..."
for i in $(seq 1 5); do
    sleep 2
    if curl -sf "${SMOKE_TEST_URL}" >/dev/null; then
        echo "  [${i}/5] Smoke test passed"
    else
        echo "  [${i}/5] Smoke test FAILED"

        # Automatic rollback
        PREVIOUS_COLOR=$([ "${NEW_VERSION}" = "green" ] && echo "blue" || echo "green")
        echo "Initiating automatic rollback to ${PREVIOUS_COLOR}..."

        kubectl -n "${NAMESPACE}" patch service "${SERVICE_NAME}" \
            --type=merge \
            -p "{\"spec\":{\"selector\":{\"color\":\"${PREVIOUS_COLOR}\"}}}"

        echo "Rollback complete. Investigate ${NEW_VERSION} deployment before retrying."
        exit 1
    fi
done

echo ""
echo "=== Blue-Green switch complete ==="
echo "Active: ${NEW_VERSION} (version: ${NEW_VERSION})"
echo "Standby: $([ "${NEW_VERSION}" = "green" ] && echo "blue" || echo "green")"
echo ""
echo "The standby deployment can be kept for rollback or scaled down."
echo "To rollback: kubectl -n ${NAMESPACE} patch service ${SERVICE_NAME} --type=merge -p '{\"spec\":{\"selector\":{\"color\":\"$([ "${NEW_VERSION}" = "green" ] && echo "blue" || echo "green")\"}}}'"
```

## Section 3: Argo Rollouts for Advanced Canary

### Installing Argo Rollouts

```bash
# Install Argo Rollouts controller
kubectl create namespace argo-rollouts
kubectl apply -n argo-rollouts \
    -f https://github.com/argoproj/argo-rollouts/releases/latest/download/install.yaml

# Install the kubectl plugin
curl -LO https://github.com/argoproj/argo-rollouts/releases/latest/download/kubectl-argo-rollouts-linux-amd64
chmod +x kubectl-argo-rollouts-linux-amd64
mv kubectl-argo-rollouts-linux-amd64 /usr/local/bin/kubectl-argo-rollouts

# Verify
kubectl argo rollouts version
```

### Canary Rollout with Automated Analysis

```yaml
# argo-rollout-canary.yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: api-service
  namespace: production
spec:
  replicas: 20
  selector:
    matchLabels:
      app: api-service
  template:
    metadata:
      labels:
        app: api-service
    spec:
      containers:
      - name: api-service
        image: registry.support.tools/api-service:v2.1.0
        readinessProbe:
          httpGet:
            path: /readyz
            port: 8080
          periodSeconds: 5
        resources:
          requests:
            cpu: 200m
            memory: 256Mi
          limits:
            cpu: 1000m
            memory: 512Mi

  strategy:
    canary:
      # Stable service receives non-canary traffic
      stableService: api-service-stable
      # Canary service receives canary traffic
      canaryService: api-service-canary

      # Traffic routing via NGINX Ingress
      trafficRouting:
        nginx:
          stableIngress: api-service-stable
          annotationPrefix: nginx.ingress.kubernetes.io
          additionalIngressAnnotations:
            canary-by-header: X-Canary
            canary-by-header-value: "true"

      # Canary steps
      steps:
      # Step 1: Route 5% of traffic to canary
      - setWeight: 5
      # Step 2: Run analysis for 5 minutes
      - analysis:
          templates:
          - templateName: success-rate
          - templateName: latency-p99
          args:
          - name: service-name
            value: api-service-canary
          - name: namespace
            value: production

      # Step 3: Pause for manual approval
      - pause:
          duration: 5m

      # Step 4: Increase to 20%
      - setWeight: 20
      # Step 5: Run extended analysis
      - analysis:
          templates:
          - templateName: success-rate
          - templateName: latency-p99
          args:
          - name: service-name
            value: api-service-canary
          - name: namespace
            value: production

      # Step 6: Pause — optional manual gate
      - pause: {}  # Infinite pause — requires manual promotion

      # Step 7: 50%
      - setWeight: 50
      - pause:
          duration: 10m

      # Step 8: Full rollout
      - setWeight: 100

      # Anti-affinity for canary pods (keep separate from stable for isolation)
      canaryMetadata:
        labels:
          role: canary
        annotations:
          prometheus.io/scrape: "true"
          prometheus.io/port: "9090"
      stableMetadata:
        labels:
          role: stable
```

### Analysis Templates for Automated Rollback

```yaml
# analysis-template-success-rate.yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: success-rate
  namespace: production
spec:
  args:
  - name: service-name
  - name: namespace
  metrics:
  - name: success-rate
    interval: 1m
    count: 5
    successCondition: result[0] >= 0.99
    failureLimit: 1
    provider:
      prometheus:
        address: http://prometheus-operated.monitoring.svc.cluster.local:9090
        query: |
          sum(
            rate(
              http_requests_total{
                namespace="{{ args.namespace }}",
                service="{{ args.service-name }}",
                status!~"5.."
              }[5m]
            )
          ) /
          sum(
            rate(
              http_requests_total{
                namespace="{{ args.namespace }}",
                service="{{ args.service-name }}"
              }[5m]
            )
          )
---
# analysis-template-latency.yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: latency-p99
  namespace: production
spec:
  args:
  - name: service-name
  - name: namespace
  metrics:
  - name: p99-latency
    interval: 1m
    count: 5
    # P99 latency must be under 500ms
    successCondition: result[0] < 0.5
    failureLimit: 2
    provider:
      prometheus:
        address: http://prometheus-operated.monitoring.svc.cluster.local:9090
        query: |
          histogram_quantile(0.99,
            sum(
              rate(
                http_request_duration_seconds_bucket{
                  namespace="{{ args.namespace }}",
                  service="{{ args.service-name }}"
                }[5m]
              )
            ) by (le)
          )
  - name: error-rate-absolute
    interval: 1m
    count: 5
    successCondition: result[0] < 10
    failureLimit: 1
    provider:
      prometheus:
        address: http://prometheus-operated.monitoring.svc.cluster.local:9090
        query: |
          sum(
            rate(
              http_requests_total{
                namespace="{{ args.namespace }}",
                service="{{ args.service-name }}",
                status=~"5.."
              }[5m]
            )
          ) * 60
---
# Web test — hit a specific endpoint and check for 200 OK
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: smoke-test
  namespace: production
spec:
  args:
  - name: canary-host
  metrics:
  - name: smoke-test-pass
    count: 1
    successCondition: result == "200"
    provider:
      web:
        url: "https://{{ args.canary-host }}/healthz"
        timeoutSeconds: 10
        successCondition: "response.status == 200"
```

### Services and Ingress for Canary

```yaml
# api-service-stable.yaml
apiVersion: v1
kind: Service
metadata:
  name: api-service-stable
  namespace: production
spec:
  selector:
    app: api-service
  ports:
  - port: 80
    targetPort: 8080
---
# api-service-canary.yaml
apiVersion: v1
kind: Service
metadata:
  name: api-service-canary
  namespace: production
spec:
  selector:
    app: api-service
  ports:
  - port: 80
    targetPort: 8080
---
# Ingress — Argo Rollouts manages the canary annotations
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-service-stable
  namespace: production
  annotations:
    kubernetes.io/ingress.class: nginx
spec:
  rules:
  - host: api.support.tools
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: api-service-stable
            port:
              number: 80
```

### Header-Based Canary Routing

For testing canary releases with specific users before weight-based rollout:

```yaml
# Trigger canary via header: X-Canary: true
# This allows internal testers to access the canary before public rollout

# The Argo Rollouts NGINX integration adds this annotation automatically:
# nginx.ingress.kubernetes.io/canary-by-header: X-Canary
# nginx.ingress.kubernetes.io/canary-by-header-value: "true"

# Test canary directly:
# curl -H "X-Canary: true" https://api.support.tools/v1/orders
```

### Managing Rollouts with kubectl argo rollouts

```bash
# Create a new rollout
kubectl apply -f argo-rollout-canary.yaml

# Watch rollout progress
kubectl argo rollouts get rollout api-service -n production --watch

# Promote a paused rollout
kubectl argo rollouts promote api-service -n production

# Abort and rollback
kubectl argo rollouts abort api-service -n production

# Retry after aborting
kubectl argo rollouts retry rollout api-service -n production

# Set a specific weight manually
kubectl argo rollouts set weight api-service 25 -n production

# View analysis run
kubectl argo rollouts list analysisruns -n production

# Get analysis run details
kubectl argo rollouts get analysisrun api-service-XXXXX -n production
```

## Section 4: Traffic Shadowing (Dark Mirroring)

Traffic shadowing sends a copy of production traffic to the new version without affecting the response to the user. The user sees only the stable response; the canary processes the mirrored traffic silently.

### Istio Traffic Mirroring

```yaml
# istio-mirroring.yaml
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: api-service
  namespace: production
spec:
  hosts:
  - api-service
  http:
  - route:
    - destination:
        host: api-service
        subset: stable
      weight: 100
    # Mirror 25% of traffic to the canary for testing
    mirror:
      host: api-service
      subset: canary
    mirrorPercentage:
      value: 25.0
---
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: api-service
  namespace: production
spec:
  host: api-service
  subsets:
  - name: stable
    labels:
      version: v2.0.0
  - name: canary
    labels:
      version: v2.1.0
```

### Argo Rollouts Traffic Mirroring Step

```yaml
strategy:
  canary:
    steps:
    # First, mirror 10% of traffic without affecting responses
    - experiment:
        templates:
        - name: canary-shadow
          specRef: canary
          weight: 10
    # Then proceed with weighted canary
    - setWeight: 5
    - analysis:
        templates:
        - templateName: success-rate
```

## Section 5: Feature Flag Integration

Feature flags (also called feature toggles) decouple deployment from release. A service can be deployed with new code that is disabled by a feature flag, allowing safe deployment and controlled activation.

### LaunchDarkly Integration in Go

```go
// pkg/features/launchdarkly.go
package features

import (
    "context"
    "fmt"
    "os"
    "time"

    ld "github.com/launchdarkly/go-server-sdk/v7"
    ldcontext "github.com/launchdarkly/go-server-sdk/v7/ldcontext"
    "go.uber.org/zap"
)

// FeatureFlags provides type-safe access to feature flags.
type FeatureFlags struct {
    client *ld.LDClient
    logger *zap.Logger
}

// UserContext represents the evaluation context for feature flags.
type UserContext struct {
    UserID    string
    TenantID  string
    Role      string
    PlanTier  string
    Country   string
    IsInternal bool
}

// NewFeatureFlags initializes the LaunchDarkly client.
func NewFeatureFlags(sdkKey string, logger *zap.Logger) (*FeatureFlags, error) {
    config := ld.Config{
        // Use streaming for real-time flag updates
        Events: ldcomponents.SendEvents().
            Capacity(10000).
            FlushInterval(5 * time.Second),
        // Cache flags locally for 30s in case of SDK connectivity issues
        DataSystem: ldcomponents.DataSystem().
            DataStore(ldcomponents.InMemoryDataStore()),
    }

    client, err := ld.MakeCustomClient(sdkKey, config, 5*time.Second)
    if err != nil {
        return nil, fmt.Errorf("creating LaunchDarkly client: %w", err)
    }

    if !client.Initialized() {
        logger.Warn("LaunchDarkly client not fully initialized — using defaults")
    }

    return &FeatureFlags{
        client: client,
        logger: logger,
    }, nil
}

// Close shuts down the LaunchDarkly client.
func (f *FeatureFlags) Close() {
    f.client.Close()
}

// buildContext converts a UserContext to an LD context.
func buildContext(ctx UserContext) ldcontext.Context {
    return ldcontext.NewBuilder(ctx.UserID).
        Kind("user").
        SetString("tenantId", ctx.TenantID).
        SetString("role", ctx.Role).
        SetString("planTier", ctx.PlanTier).
        SetString("country", ctx.Country).
        SetBool("isInternal", ctx.IsInternal).
        Build()
}

// IsNewCheckoutEnabled returns true if the new checkout flow is enabled for the user.
func (f *FeatureFlags) IsNewCheckoutEnabled(ctx UserContext) bool {
    ldCtx := buildContext(ctx)
    enabled, err := f.client.BoolVariation("new-checkout-flow", ldCtx, false)
    if err != nil {
        f.logger.Warn("LaunchDarkly flag evaluation failed",
            zap.String("flag", "new-checkout-flow"),
            zap.String("user_id", ctx.UserID),
            zap.Error(err))
        return false // Default off
    }
    return enabled
}

// GetCheckoutAlgorithm returns the checkout pricing algorithm variant.
func (f *FeatureFlags) GetCheckoutAlgorithm(ctx UserContext) string {
    ldCtx := buildContext(ctx)
    variant, err := f.client.StringVariation("checkout-pricing-algorithm", ldCtx, "legacy")
    if err != nil {
        f.logger.Warn("LaunchDarkly flag evaluation failed",
            zap.String("flag", "checkout-pricing-algorithm"),
            zap.Error(err))
        return "legacy"
    }
    return variant
}

// GetRateLimit returns the configured rate limit for the user's plan.
func (f *FeatureFlags) GetRateLimit(ctx UserContext) int {
    ldCtx := buildContext(ctx)
    limit, err := f.client.IntVariation("api-rate-limit-per-minute", ldCtx, 100)
    if err != nil {
        return 100 // Default
    }
    return limit
}

// TrackConversion records a conversion event for A/B test analysis.
func (f *FeatureFlags) TrackConversion(ctx UserContext, eventKey string, value float64) {
    ldCtx := buildContext(ctx)
    if err := f.client.TrackMetric(ldCtx, eventKey, nil, value); err != nil {
        f.logger.Warn("Failed to track LaunchDarkly event",
            zap.String("event", eventKey),
            zap.Error(err))
    }
}
```

### Unleash (Self-Hosted) Integration

```go
// pkg/features/unleash.go
package features

import (
    "context"
    "fmt"

    "github.com/Unleash/unleash-client-go/v4"
    "github.com/Unleash/unleash-client-go/v4/context"
    "go.uber.org/zap"
)

// UnleashFeatureFlags provides feature flag evaluation via Unleash.
type UnleashFeatureFlags struct {
    logger *zap.Logger
}

// NewUnleashFlags initializes the Unleash client.
func NewUnleashFlags(serverURL, apiToken, appName string, logger *zap.Logger) (*UnleashFeatureFlags, error) {
    err := unleash.Initialize(
        unleash.WithUrl(serverURL),
        unleash.WithAppName(appName),
        unleash.WithCustomHeaders(http.Header{"Authorization": {apiToken}}),
        unleash.WithRefreshInterval(15*time.Second),
        unleash.WithMetricsInterval(60*time.Second),
        unleash.WithListener(&unleashListener{logger: logger}),
    )
    if err != nil {
        return nil, fmt.Errorf("initializing Unleash: %w", err)
    }

    return &UnleashFeatureFlags{logger: logger}, nil
}

func (f *UnleashFeatureFlags) IsEnabled(featureName string, ctx UserContext) bool {
    uctx := unleashctx.Context{
        UserId:     ctx.UserID,
        SessionId:  ctx.TenantID,
        RemoteAddress: ctx.Country,
        Properties: map[string]string{
            "tenantId": ctx.TenantID,
            "planTier": ctx.PlanTier,
            "role":     ctx.Role,
        },
    }

    return unleash.IsEnabled(featureName, unleash.WithContext(uctx))
}

// unleashListener logs Unleash client events.
type unleashListener struct {
    logger *zap.Logger
}

func (l *unleashListener) OnError(err error) {
    l.logger.Error("Unleash error", zap.Error(err))
}

func (l *unleashListener) OnWarning(warning error) {
    l.logger.Warn("Unleash warning", zap.Error(warning))
}

func (l *unleashListener) OnReady() {
    l.logger.Info("Unleash client ready")
}

func (l *unleashListener) OnCount(toggle string, enabled bool) {
    // Called for every flag evaluation — do not log in production
}

func (l *unleashListener) OnSent(payload unleash.MetricsPayload) {
    l.logger.Debug("Unleash metrics sent", zap.Int("toggles", len(payload.Bucket.Toggles)))
}

func (l *unleashListener) OnRegistered(payload unleash.ClientData) {
    l.logger.Info("Unleash client registered", zap.String("appName", payload.AppName))
}
```

### Using Feature Flags in HTTP Handlers

```go
// internal/api/checkout_handler.go
package api

import (
    "net/http"

    "github.com/support-tools/myservice/pkg/features"
)

type CheckoutHandler struct {
    flags    *features.FeatureFlags
    newFlow  *NewCheckoutFlow
    legacyFlow *LegacyCheckoutFlow
}

func (h *CheckoutHandler) HandleCheckout(w http.ResponseWriter, r *http.Request) {
    userCtx := features.UserContext{
        UserID:   getUserIDFromRequest(r),
        TenantID: getTenantIDFromRequest(r),
        Role:     getRoleFromRequest(r),
        PlanTier: getPlanTierFromRequest(r),
    }

    // Feature flag gates the new checkout flow
    if h.flags.IsNewCheckoutEnabled(userCtx) {
        // Track that the user was shown the new flow (for analytics)
        defer h.flags.TrackConversion(userCtx, "checkout-flow-new", 1.0)

        // Use the new implementation
        algorithm := h.flags.GetCheckoutAlgorithm(userCtx)
        h.newFlow.Handle(w, r, algorithm)
        return
    }

    // Default to legacy flow
    defer h.flags.TrackConversion(userCtx, "checkout-flow-legacy", 1.0)
    h.legacyFlow.Handle(w, r)
}
```

### Connecting Feature Flags to Canary Rollout

The power of combining feature flags with canary deployments is that you can separate concerns:

- **Canary deployment**: controls which version of the code runs on which pods.
- **Feature flags**: controls which features are active for which users within the new code.

This allows:
1. Deploy v2.1.0 to 5% of pods (canary) with all new features disabled via flags.
2. Enable features for internal users only (by targeting flag by `isInternal: true`).
3. Gradually enable features for external users after internal validation.
4. If issues arise, disable the feature flag immediately without a rollback deployment.

## Section 6: Automated Rollback Triggers

### Argo Rollouts with Prometheus-Based Analysis

The analysis template runs Prometheus queries and automatically aborts the rollout if success conditions are not met:

```yaml
# Comprehensive analysis template with multiple metrics
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: comprehensive-canary-analysis
  namespace: production
spec:
  args:
  - name: canary-service
  - name: stable-service
  - name: namespace
  metrics:
  - name: canary-error-rate
    interval: 2m
    count: 5
    # Canary error rate must not exceed stable error rate by more than 0.5%
    successCondition: |
      result[0] < 0.005 + (
        sum(rate(http_requests_total{service="{{ args.stable-service }}", status=~"5.."}[5m]))
        /
        sum(rate(http_requests_total{service="{{ args.stable-service }}"}[5m]))
      )
    failureLimit: 2
    provider:
      prometheus:
        address: http://prometheus-operated.monitoring.svc.cluster.local:9090
        query: |
          sum(rate(http_requests_total{
            namespace="{{ args.namespace }}",
            service="{{ args.canary-service }}",
            status=~"5.."
          }[5m]))
          /
          sum(rate(http_requests_total{
            namespace="{{ args.namespace }}",
            service="{{ args.canary-service }}"
          }[5m]))

  - name: canary-p99-vs-stable-p99
    interval: 2m
    count: 5
    # Canary P99 must not be more than 20% worse than stable P99
    successCondition: |
      result[0] < 1.2 * (
        histogram_quantile(0.99,
          sum(rate(http_request_duration_seconds_bucket{
            service="{{ args.stable-service }}"
          }[5m])) by (le)
        )
      )
    failureLimit: 2
    provider:
      prometheus:
        address: http://prometheus-operated.monitoring.svc.cluster.local:9090
        query: |
          histogram_quantile(0.99,
            sum(rate(http_request_duration_seconds_bucket{
              namespace="{{ args.namespace }}",
              service="{{ args.canary-service }}"
            }[5m])) by (le)
          )

  - name: canary-request-volume
    interval: 2m
    count: 3
    # Verify the canary is actually receiving traffic (not silently failing)
    successCondition: result[0] > 0
    failureLimit: 1
    provider:
      prometheus:
        address: http://prometheus-operated.monitoring.svc.cluster.local:9090
        query: |
          sum(rate(http_requests_total{
            namespace="{{ args.namespace }}",
            service="{{ args.canary-service }}"
          }[5m]))
```

### Alertmanager-Driven Rollback

For organizations using Alertmanager, integrate rollback with existing alerting:

```yaml
# alertmanager-receiver for rollback
receivers:
- name: argo-rollout-abort
  webhook_configs:
  - url: http://argo-rollouts-webhook.production.svc.cluster.local/rollback
    send_resolved: false

route:
  routes:
  - match:
      severity: critical
      rollout_name: api-service
    receiver: argo-rollout-abort
    continue: true
```

```go
// Webhook handler for Alertmanager-triggered rollback
func handleRollbackWebhook(w http.ResponseWriter, r *http.Request) {
    var payload alertmanager.WebhookPayload
    json.NewDecoder(r.Body).Decode(&payload)

    for _, alert := range payload.Alerts {
        rolloutName := alert.Labels["rollout_name"]
        namespace := alert.Labels["namespace"]

        if rolloutName == "" || namespace == "" {
            continue
        }

        // Abort the Argo Rollout
        cmd := exec.Command("kubectl", "argo", "rollouts", "abort",
            rolloutName, "-n", namespace)
        if err := cmd.Run(); err != nil {
            log.Printf("Failed to abort rollout %s: %v", rolloutName, err)
        }
    }
    w.WriteHeader(http.StatusOK)
}
```

The combination of Argo Rollouts' automated analysis, Prometheus metrics-based success conditions, and feature flag integration creates a deployment pipeline where risk is continuously measured and acted upon — not just observed. When the canary P99 latency exceeds the threshold, the analysis marks the rollout as failed and Argo Rollouts automatically scales the canary down to zero, returning 100% of traffic to the stable version without any human intervention.
