---
title: "Kubernetes Deployment Strategies Deep Dive: Blue-Green, Canary with Argo Rollouts, and Feature Flags"
date: 2030-03-24T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Argo Rollouts", "Canary Deployment", "Blue-Green", "Progressive Delivery", "LaunchDarkly", "Feature Flags"]
categories: ["Kubernetes", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Argo Rollouts for progressive delivery: analysis templates with Prometheus and Datadog metrics, blue-green with instant cutover, canary percentage-based rollouts, and integrating with LaunchDarkly feature flags."
more_link: "yes"
url: "/kubernetes-deployment-strategies-blue-green-canary-argo-rollouts-feature-flags/"
---

The gap between deploying code and releasing features has never been wider, or more important to manage deliberately. A canary deployment that checks only CPU and memory may catch OOM errors but miss a regression in checkout conversion rate. A blue-green switch that completes in 30 seconds can still cause revenue loss if the new version has a subtle authentication bug affecting 2% of users. Progressive delivery bridges deployment infrastructure and business outcomes by making success metrics — not just technical health — the gate that controls how far a rollout progresses.

Argo Rollouts is the Kubernetes-native progressive delivery controller that brings blue-green, canary, and analysis-driven promotion to production Kubernetes workloads. Combined with feature flag systems like LaunchDarkly, it enables the complete decoupling of deployment (code going to production) from release (users experiencing the new behavior).

<!--more-->

## Progressive Delivery Architecture

```
Code Merged to Main
         |
         v
CI Pipeline (build, test, scan)
         |
         v
GitOps Commit (update image tag)
         |
         v
Argo CD applies Rollout object
         |
         v
Argo Rollouts Controller
         |
    +----+----+
    |         |
    v         v
Blue-Green  Canary
    |         |
    v         v
Analysis  Analysis
(Prometheus, (Datadog,
 Datadog)     New Relic)
    |         |
    +----+----+
         |
    Pass / Fail
         |
    +----+----+
    |         |
    v         v
Promote    Abort
(full      (roll back
 rollout)   to stable)
```

## Installing Argo Rollouts

```bash
# Install Argo Rollouts controller
kubectl create namespace argo-rollouts
kubectl apply -n argo-rollouts \
  -f https://github.com/argoproj/argo-rollouts/releases/latest/download/install.yaml

# Install kubectl plugin
curl -LO https://github.com/argoproj/argo-rollouts/releases/latest/download/kubectl-argo-rollouts-linux-amd64
chmod +x kubectl-argo-rollouts-linux-amd64
mv kubectl-argo-rollouts-linux-amd64 /usr/local/bin/kubectl-argo-rollouts

# Verify installation
kubectl argo rollouts version
# argo-rollouts: v1.7.0

kubectl get pods -n argo-rollouts
# NAME                                 READY   STATUS    RESTARTS   AGE
# argo-rollouts-76f8d9bbdb-x8p9k      1/1     Running   0          1m
```

## Blue-Green Deployments with Argo Rollouts

Blue-green deployment maintains two identical environments. Only one receives production traffic at a time. The new version (green) is deployed and tested while the old version (blue) continues to serve production traffic. Cutover is instant (or near-instant) when confidence is established.

### Basic Blue-Green Rollout

```yaml
# rollouts/api-server-blue-green.yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: api-server
  namespace: production
spec:
  replicas: 5
  selector:
    matchLabels:
      app: api-server
  template:
    metadata:
      labels:
        app: api-server
    spec:
      containers:
      - name: api-server
        image: mycompany/api-server:1.0.0
        ports:
        - containerPort: 8080
        readinessProbe:
          httpGet:
            path: /healthz/ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 10
          failureThreshold: 3
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
          limits:
            cpu: "2"
            memory: 2Gi

  strategy:
    blueGreen:
      # Service that receives production traffic (blue = current)
      activeService: api-server-active
      # Service for preview/testing (green = new version)
      previewService: api-server-preview
      # Number of replicas to keep in preview environment
      previewReplicaCount: 2
      # Wait for all preview pods to be ready before testing
      autoPromotionEnabled: false  # Manual promotion required
      # How long to wait before auto-promotion (if enabled)
      # autoPromotionSeconds: 300
      # Scale down old version delay after promotion
      scaleDownDelaySeconds: 600  # 10 minutes to allow connections to drain
      # Run analysis before promotion
      prePromotionAnalysis:
        templates:
        - templateName: success-rate-analysis
        args:
        - name: service-name
          value: api-server-preview
      # Run analysis after promotion (while old version is still alive)
      postPromotionAnalysis:
        templates:
        - templateName: success-rate-analysis
        args:
        - name: service-name
          value: api-server-active
---
# Active service (receives 100% of production traffic)
apiVersion: v1
kind: Service
metadata:
  name: api-server-active
  namespace: production
spec:
  selector:
    app: api-server
  ports:
  - port: 80
    targetPort: 8080
  type: ClusterIP
---
# Preview service (receives no production traffic; used for testing)
apiVersion: v1
kind: Service
metadata:
  name: api-server-preview
  namespace: production
spec:
  selector:
    app: api-server
  ports:
  - port: 80
    targetPort: 8080
  type: ClusterIP
```

### Blue-Green with Ingress Traffic Splitting

```yaml
# For Nginx Ingress Controller
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-server-ingress
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  ingressClassName: nginx
  rules:
  - host: api.mycompany.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: api-server-active
            port:
              number: 80
---
# Preview ingress for internal testing
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-server-preview-ingress
  namespace: production
  annotations:
    # Restrict to internal network
    nginx.ingress.kubernetes.io/whitelist-source-range: "10.0.0.0/8,172.16.0.0/12"
spec:
  ingressClassName: nginx
  rules:
  - host: api-preview.mycompany.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: api-server-preview
            port:
              number: 80
```

### Promoting a Blue-Green Rollout

```bash
# Deploy new version (update image)
kubectl argo rollouts set image api-server api-server=mycompany/api-server:2.0.0 \
  -n production

# Watch the rollout progress
kubectl argo rollouts get rollout api-server -n production --watch
# Name:            api-server
# Namespace:       production
# Status:          ◷ Progressing
# Message:         waiting for all steps to complete
# Strategy:        BlueGreen
# ...
# Status:          ॥ Paused
# Message:         BlueGreenPause

# Check status
kubectl argo rollouts status api-server -n production

# Test the preview version
curl https://api-preview.mycompany.com/api/v1/health
# Run smoke tests against preview

# When ready, promote to production
kubectl argo rollouts promote api-server -n production

# Watch promotion complete
kubectl argo rollouts get rollout api-server -n production --watch
# Status: ✔ Healthy

# If issues detected, abort and rollback
kubectl argo rollouts abort api-server -n production
kubectl argo rollouts undo api-server -n production
```

## Canary Deployments with Progressive Traffic Shifting

Canary deployments send a percentage of production traffic to the new version, gradually increasing as confidence builds. Unlike blue-green, they allow real production traffic to validate the new version.

### Canary Rollout with Analysis Templates

```yaml
# rollouts/payment-service-canary.yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: payment-service
  namespace: production
spec:
  replicas: 20
  selector:
    matchLabels:
      app: payment-service
  template:
    metadata:
      labels:
        app: payment-service
    spec:
      containers:
      - name: payment-service
        image: mycompany/payment-service:1.0.0
        ports:
        - containerPort: 8080
        readinessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 5
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
          limits:
            cpu: "2"
            memory: 2Gi

  strategy:
    canary:
      # Service names
      canaryService: payment-service-canary
      stableService: payment-service-stable

      # Traffic routing via Nginx ingress
      trafficRouting:
        nginx:
          stableIngress: payment-service-ingress
          annotationPrefix: nginx.ingress.kubernetes.io
          additionalIngressAnnotations:
            canary-by-header: x-canary
            canary-by-header-value: "true"

      # Analysis configuration
      analysis:
        # Run analysis starting at 5% canary
        startingStep: 2  # Zero-indexed, so this is the 5% step
        templates:
        - templateName: payment-success-rate
        - templateName: payment-latency-p99
        args:
        - name: canary-service
          valueFrom:
            fieldRef:
              fieldPath: metadata.annotations['rollouts.argoproj.io/canary-pod-hash']

      # Canary progression steps
      steps:
      # Step 0: Deploy 5% of replicas (1 canary pod out of 20)
      - setWeight: 5
      # Step 1: Pause and run analysis for 10 minutes
      - pause:
          duration: 10m
      # Step 2: Increase to 10%
      - setWeight: 10
      - pause:
          duration: 10m
      # Step 3: Increase to 25%
      - setWeight: 25
      - pause:
          duration: 10m
      # Step 4: Increase to 50%
      - setWeight: 50
      - pause:
          duration: 10m
      # Step 5: Increase to 100% - promotion complete
      - setWeight: 100
```

### Analysis Templates: Prometheus-Based

```yaml
# rollouts/analysis-templates/success-rate.yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: payment-success-rate
  namespace: production
spec:
  args:
  - name: service-name
    default: payment-service-canary
  - name: namespace
    default: production

  metrics:
  # Check payment success rate
  - name: payment-success-rate
    interval: 5m
    # Run for 15 minutes before considering this metric complete
    count: 3
    successCondition: result[0] >= 0.95  # 95% success rate required
    failureLimit: 1  # Abort if fails more than once

    provider:
      prometheus:
        address: http://prometheus.monitoring.svc.cluster.local:9090
        query: |
          sum(
            rate(payment_transactions_total{
              service="{{args.service-name}}",
              namespace="{{args.namespace}}",
              status="success"
            }[5m])
          )
          /
          sum(
            rate(payment_transactions_total{
              service="{{args.service-name}}",
              namespace="{{args.namespace}}"
            }[5m])
          )

  # Check payment processing latency
  - name: payment-p99-latency
    interval: 5m
    count: 3
    # p99 latency must be under 500ms
    successCondition: result[0] < 0.5
    failureLimit: 0  # Zero tolerance for latency regression

    provider:
      prometheus:
        address: http://prometheus.monitoring.svc.cluster.local:9090
        query: |
          histogram_quantile(0.99,
            sum(
              rate(payment_request_duration_seconds_bucket{
                service="{{args.service-name}}",
                namespace="{{args.namespace}}"
              }[5m])
            ) by (le)
          )

  # Check error rate
  - name: error-rate
    interval: 5m
    count: 3
    successCondition: result[0] < 0.01  # Less than 1% error rate
    failureLimit: 1

    provider:
      prometheus:
        address: http://prometheus.monitoring.svc.cluster.local:9090
        query: |
          sum(
            rate(http_requests_total{
              service="{{args.service-name}}",
              code=~"5.."
            }[5m])
          )
          /
          sum(
            rate(http_requests_total{
              service="{{args.service-name}}"
            }[5m])
          )
---
# Analysis template using Datadog
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: datadog-success-rate
  namespace: production
spec:
  args:
  - name: service-name
  - name: baseline-service

  metrics:
  # Compare canary vs baseline using Datadog
  - name: compare-success-rate
    interval: 5m
    count: 3
    # Canary success rate must be within 2% of baseline
    successCondition: |
      result.canary >= (result.baseline - 0.02)
    failureLimit: 1

    provider:
      datadog:
        apiVersion: v2
        interval: 5m
        queries:
          canary: |
            sum:payment.success{service:{{args.service-name}}}.as_rate()
            /
            sum:payment.total{service:{{args.service-name}}}.as_rate()
          baseline: |
            sum:payment.success{service:{{args.baseline-service}}}.as_rate()
            /
            sum:payment.total{service:{{args.baseline-service}}}.as_rate()
```

### Web Analytics Analysis Template

```yaml
# Analyze business metrics, not just technical metrics
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: checkout-conversion-rate
  namespace: production
spec:
  args:
  - name: canary-variant

  metrics:
  # Check that checkout conversion didn't regress
  - name: checkout-conversion
    interval: 10m
    count: 6  # Run for 1 hour
    successCondition: result[0] >= 0.035  # 3.5% minimum conversion rate
    failureLimit: 2

    provider:
      prometheus:
        address: http://prometheus.monitoring.svc.cluster.local:9090
        query: |
          sum(
            increase(checkout_completed_total{
              variant="{{args.canary-variant}}"
            }[10m])
          )
          /
          sum(
            increase(checkout_started_total{
              variant="{{args.canary-variant}}"
            }[10m])
          )
```

## Feature Flags with LaunchDarkly Integration

Feature flags provide a second layer of control beyond deployment strategies. While Argo Rollouts controls which pods receive traffic, feature flags control which code paths execute within those pods.

### LaunchDarkly Go SDK Integration

```go
// pkg/features/flags.go
package features

import (
    "context"
    "fmt"
    "log/slog"
    "time"

    ldclient "github.com/launchdarkly/go-server-sdk/v7"
    "github.com/launchdarkly/go-server-sdk/v7/ldcomponents"
    ldcontext "github.com/launchdarkly/go-sdk-common/v3/ldcontext"
    "github.com/launchdarkly/go-sdk-common/v3/ldvalue"
)

// FeatureFlags wraps the LaunchDarkly client
type FeatureFlags struct {
    client *ldclient.LDClient
}

// NewFeatureFlags creates a FeatureFlags instance connected to LaunchDarkly
func NewFeatureFlags(sdkKey string) (*FeatureFlags, error) {
    config := ldclient.Config{
        Events: ldcomponents.SendEvents().
            FlushInterval(5 * time.Second).
            EventQueueSize(10000),
        DataSource: ldcomponents.StreamingDataSource().
            InitialReconnectDelay(1 * time.Second),
    }

    client, err := ldclient.MakeCustomClient(sdkKey, config, 5*time.Second)
    if err != nil {
        return nil, fmt.Errorf("initializing LaunchDarkly client: %w", err)
    }

    if !client.Initialized() {
        slog.Warn("LaunchDarkly client did not initialize in 5s, operating in fallback mode")
    }

    return &FeatureFlags{client: client}, nil
}

// UserContext creates a LaunchDarkly evaluation context for a user
func UserContext(userID, email, plan string, attributes map[string]string) ldcontext.Context {
    builder := ldcontext.NewBuilder(userID).
        SetValue("email", ldvalue.String(email)).
        SetValue("plan", ldvalue.String(plan))

    for k, v := range attributes {
        builder.SetValue(k, ldvalue.String(v))
    }

    return builder.Build()
}

// IsEnabled checks if a boolean feature flag is enabled for a user
func (f *FeatureFlags) IsEnabled(flag string, ctx ldcontext.Context, defaultValue bool) bool {
    value, err := f.client.BoolVariation(flag, ctx, defaultValue)
    if err != nil {
        slog.Warn("feature flag evaluation error",
            "flag", flag,
            "error", err,
            "default", defaultValue)
        return defaultValue
    }
    return value
}

// StringVariation returns a string feature flag value
func (f *FeatureFlags) StringVariation(flag string, ctx ldcontext.Context, defaultValue string) string {
    value, err := f.client.StringVariation(flag, ctx, defaultValue)
    if err != nil {
        slog.Warn("feature flag evaluation error", "flag", flag, "error", err)
        return defaultValue
    }
    return value
}

// IntVariation returns an integer feature flag value
func (f *FeatureFlags) IntVariation(flag string, ctx ldcontext.Context, defaultValue int) int {
    value, err := f.client.IntVariation(flag, ctx, defaultValue)
    if err != nil {
        slog.Warn("feature flag evaluation error", "flag", flag, "error", err)
        return defaultValue
    }
    return value
}

// Close releases client resources
func (f *FeatureFlags) Close() {
    f.client.Close()
}
```

### Feature Flag Usage in HTTP Handlers

```go
// handlers/checkout.go
package handlers

import (
    "net/http"

    "myapp/pkg/features"
)

type CheckoutHandler struct {
    flags *features.FeatureFlags
}

func (h *CheckoutHandler) HandleCheckout(w http.ResponseWriter, r *http.Request) {
    userID := getUserID(r)
    userEmail := getUserEmail(r)
    userPlan := getUserPlan(r)

    // Build evaluation context
    ctx := features.UserContext(userID, userEmail, userPlan, map[string]string{
        "country":    r.Header.Get("CF-IPCountry"),
        "ab_test_id": getABTestID(r),
    })

    // Feature flag gates new checkout flow
    useNewCheckout := h.flags.IsEnabled("new-checkout-flow", ctx, false)

    if useNewCheckout {
        h.handleNewCheckout(w, r)
    } else {
        h.handleLegacyCheckout(w, r)
    }
}

// Graduated rollout: read from flag, not from code
func (h *CheckoutHandler) GetPaymentMethods(w http.ResponseWriter, r *http.Request) {
    ctx := buildContext(r)

    // String variation for multi-variant testing
    paymentProcessor := h.flags.StringVariation(
        "payment-processor-variant",
        ctx,
        "stripe",  // default
    )

    switch paymentProcessor {
    case "stripe":
        h.useStripe(w, r)
    case "braintree":
        h.useBraintree(w, r)
    case "adyen":
        h.useAdyen(w, r)
    default:
        h.useStripe(w, r)
    }
}
```

### Coordinating Argo Rollouts with Feature Flags

The most powerful pattern combines Argo Rollouts (infrastructure-level traffic control) with feature flags (application-level feature control):

```yaml
# Rollout with feature flag analysis step
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: checkout-service
  namespace: production
spec:
  replicas: 10
  selector:
    matchLabels:
      app: checkout-service
  template:
    metadata:
      labels:
        app: checkout-service
    spec:
      containers:
      - name: checkout-service
        image: mycompany/checkout-service:2.0.0
        env:
        - name: LAUNCHDARKLY_SDK_KEY
          valueFrom:
            secretKeyRef:
              name: launchdarkly-credentials
              key: sdk-key
        - name: DEPLOYMENT_VERSION
          value: "2.0.0"

  strategy:
    canary:
      canaryService: checkout-service-canary
      stableService: checkout-service-stable

      steps:
      # Step 1: 5% traffic to new version, feature flag OFF
      - setWeight: 5
      - pause:
          duration: 5m

      # Step 2: Run technical analysis
      - analysis:
          templates:
          - templateName: checkout-error-rate
          - templateName: checkout-latency

      # Step 3: Increase to 25%, enable feature flag for canary users
      # Feature flag is enabled via LaunchDarkly targeting rule
      # that targets users being served by canary pods
      - setWeight: 25
      - pause:
          duration: 15m

      # Step 4: Run business metric analysis (conversion rate)
      - analysis:
          templates:
          - templateName: checkout-conversion-rate

      # Step 5: Full rollout
      - setWeight: 100
```

### LaunchDarkly Analysis Template

```yaml
# Analysis template that queries LaunchDarkly metrics API
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: launchdarkly-experiment
  namespace: production
spec:
  args:
  - name: flag-key
  - name: experiment-key
  - name: metric-key

  metrics:
  - name: experiment-metric
    interval: 10m
    count: 6
    successCondition: result.pValue < 0.05 && result.effect > 0
    failureLimit: 1

    provider:
      web:
        url: "https://app.launchdarkly.com/api/v2/flags/{{args.flag-key}}/experiments/{{args.experiment-key}}/metric-results/{{args.metric-key}}"
        headers:
        - key: Authorization
          value: "{{secrets.launchdarkly-api-key}}"
        jsonPath: "$.results[-1:][0]"
```

## Monitoring Progressive Delivery

### Argo Rollouts Prometheus Metrics

```yaml
# monitoring/rollout-alerts.yaml
groups:
- name: argo-rollouts
  rules:
  # Alert when a rollout is degraded
  - alert: RolloutDegraded
    expr: |
      rollout_info{phase="Degraded"} == 1
    for: 5m
    labels:
      severity: critical
    annotations:
      summary: "Rollout {{ $labels.name }} in {{ $labels.namespace }} is degraded"
      description: "Rollout has been in Degraded state for more than 5 minutes. Immediate investigation required."

  # Alert when analysis fails
  - alert: AnalysisRunFailed
    expr: |
      analysisrun_info{phase="Failed"} == 1
    for: 2m
    labels:
      severity: warning
    annotations:
      summary: "AnalysisRun failed: {{ $labels.name }}"
      description: "An AnalysisRun for rollout {{ $labels.rollout }} has failed. The rollout may be automatically aborted."

  # Alert when rollout is stuck paused too long
  - alert: RolloutPausedTooLong
    expr: |
      rollout_info{phase="Paused"} == 1
    for: 2h
    labels:
      severity: warning
    annotations:
      summary: "Rollout {{ $labels.name }} has been paused for 2+ hours"
      description: "Consider promoting or aborting. Manual intervention may be required."
```

### Rollout Status Dashboard Script

```bash
#!/bin/bash
# scripts/rollout-status.sh
# Comprehensive status report for all active rollouts

echo "=== Active Rollouts Status ==="
echo ""

kubectl get rollouts -A -o json | jq -r '
.items[] |
"Namespace: \(.metadata.namespace)\n" +
"Name: \(.metadata.name)\n" +
"Strategy: \(.spec.strategy | to_entries[0].key)\n" +
"Current: \(.spec.template.spec.containers[0].image)\n" +
"Replicas: \(.status.readyReplicas)/\(.spec.replicas)\n" +
"Phase: \(.status.phase)\n" +
"---"
'

echo ""
echo "=== Recent AnalysisRuns ==="
kubectl get analysisruns -A --sort-by='.metadata.creationTimestamp' | tail -20

echo ""
echo "=== Recent Rollout Events ==="
kubectl get events -A \
  --field-selector reason=RolloutUpdated,reason=RolloutCompleted,reason=RolloutAborted \
  --sort-by='.lastTimestamp' | tail -20
```

## Production Rollout Runbook

```bash
#!/bin/bash
# runbooks/deploy-with-rollout.sh
# Standard procedure for production rollouts using Argo Rollouts

set -euo pipefail

NAMESPACE="${1:-production}"
ROLLOUT_NAME="${2:?Usage: $0 <namespace> <rollout-name> <new-image-tag>}"
NEW_IMAGE_TAG="${3:?Usage: $0 <namespace> <rollout-name> <new-image-tag>}"
MAX_WAIT_MINUTES="${4:-60}"

echo "=== Production Rollout Procedure ==="
echo "Rollout: $NAMESPACE/$ROLLOUT_NAME"
echo "New Image: $NEW_IMAGE_TAG"
echo ""

# Step 1: Verify current state
echo "--- Step 1: Verify Pre-Deployment State ---"
kubectl argo rollouts get rollout "$ROLLOUT_NAME" -n "$NAMESPACE"

CURRENT_PHASE=$(kubectl get rollout "$ROLLOUT_NAME" -n "$NAMESPACE" \
  -o jsonpath='{.status.phase}')
if [[ "$CURRENT_PHASE" != "Healthy" && "$CURRENT_PHASE" != "Degraded" ]]; then
    echo "ABORT: Rollout is not in Healthy state (current: $CURRENT_PHASE)"
    exit 1
fi

# Step 2: Update image
echo ""
echo "--- Step 2: Update Image ---"
kubectl argo rollouts set image "$ROLLOUT_NAME" \
  "${ROLLOUT_NAME}=${NEW_IMAGE_TAG}" \
  -n "$NAMESPACE"

echo "Image updated, rollout started"

# Step 3: Watch for canary weight to reach first step
echo ""
echo "--- Step 3: Monitor Rollout Progress ---"
START_TIME=$(date +%s)
MAX_WAIT=$((MAX_WAIT_MINUTES * 60))

while true; do
    ELAPSED=$(( $(date +%s) - START_TIME ))
    if [[ $ELAPSED -gt $MAX_WAIT ]]; then
        echo "TIMEOUT: Rollout did not complete within $MAX_WAIT_MINUTES minutes"
        echo "Current status:"
        kubectl argo rollouts get rollout "$ROLLOUT_NAME" -n "$NAMESPACE"
        exit 1
    fi

    PHASE=$(kubectl get rollout "$ROLLOUT_NAME" -n "$NAMESPACE" \
      -o jsonpath='{.status.phase}')
    CANARY_WEIGHT=$(kubectl get rollout "$ROLLOUT_NAME" -n "$NAMESPACE" \
      -o jsonpath='{.status.canary.weights.canary.weight}' 2>/dev/null || echo "N/A")

    echo "[$(date -u +%H:%M:%S)] Phase: $PHASE, Canary Weight: ${CANARY_WEIGHT}%"

    case "$PHASE" in
        "Healthy")
            echo ""
            echo "SUCCESS: Rollout completed successfully!"
            kubectl argo rollouts get rollout "$ROLLOUT_NAME" -n "$NAMESPACE"
            exit 0
            ;;
        "Degraded")
            echo ""
            echo "FAILURE: Rollout degraded!"
            kubectl argo rollouts get rollout "$ROLLOUT_NAME" -n "$NAMESPACE"
            echo ""
            echo "Initiating rollback..."
            kubectl argo rollouts undo "$ROLLOUT_NAME" -n "$NAMESPACE"
            exit 1
            ;;
        "Paused")
            # Paused waiting for manual promotion or analysis
            echo "  (waiting for analysis completion or manual action)"
            ;;
    esac

    sleep 15
done
```

## Key Takeaways

Progressive delivery with Argo Rollouts transforms deployment from a high-stakes, binary operation into a controlled, data-driven process:

**Analysis templates are the key differentiator**: Deploying a canary that simply shifts traffic without measuring business outcomes is table stakes. The power of Argo Rollouts is in analysis templates that check payment conversion rates, checkout abandonment, error budgets, and SLO compliance — not just CPU and memory.

**Blue-green for high-confidence instant cutover**: When you need zero-downtime deployments with the ability to switch back in seconds (schema migrations, stateful service upgrades), blue-green is superior. The prePromotionAnalysis and postPromotionAnalysis hooks let you validate both before and after the traffic switch while the old version is still alive.

**Canary for gradual risk reduction**: For stateless services where a 1% regression affects 1% of users (not 100%), canary deployments reduce the blast radius of bugs. The stepped approach (5% → 10% → 25% → 50% → 100%) with analysis gates at each step provides multiple opportunities to catch regressions before they affect your entire user base.

**Feature flags decouple deployment from release**: Argo Rollouts controls which pods receive traffic; feature flags control which code paths execute within those pods. This combination enables shipping code continuously (every commit to main goes to production as a canary) while controlling feature exposure through LaunchDarkly targeting rules.

**Automate the rollback**: Configure `failureLimit` and `failureCondition` in your analysis templates to automatically abort and roll back when metrics regress. Human-in-the-loop promotion is appropriate; human-in-the-loop rollback is too slow when a bad canary is causing revenue loss.
