---
title: "OpenFeature: Standardizing Feature Flag Management in Kubernetes"
date: 2027-03-09T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Feature Flags", "OpenFeature", "Progressive Delivery", "DevOps"]
categories: ["Kubernetes", "DevOps", "Progressive Delivery"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to OpenFeature SDK and flagd on Kubernetes, covering provider implementations, evaluation context, targeting rules, Argo Rollouts integration for progressive feature delivery, and Prometheus metrics for flag evaluation tracking."
more_link: "yes"
url: "/openfeature-feature-flags-kubernetes-guide/"
---

Feature flags are a foundational technique for decoupling deployment from release, enabling progressive delivery, and reducing rollback risk. The industry has historically fragmented across proprietary SDKs — LaunchDarkly, Split, Unleash, Flagsmith — each requiring vendor-specific integration code that locks teams into a single provider. OpenFeature, a CNCF sandbox project, establishes a vendor-neutral specification and SDK that abstracts flag evaluation behind a standardized API. This guide covers the full production deployment path on Kubernetes: flagd as the in-cluster backend, SDK integration across Go, Java, and Python, targeting rules, Argo Rollouts integration, and Prometheus observability.

<!--more-->

## Section 1: OpenFeature Specification Overview

OpenFeature defines a standard evaluation API that application code calls without knowing which flag backend is in use. The core abstractions are:

- **Provider** — implements the evaluation API for a specific backend (flagd, LaunchDarkly, Unleash, etc.)
- **Client** — application-facing interface for evaluating flags
- **Evaluation Context** — per-request key-value data used by targeting rules (user ID, region, plan tier)
- **Hook** — middleware functions that run before/after flag evaluation for logging, metrics, and validation
- **Domain** — named grouping of clients sharing a provider (useful for multi-tenant applications)

```
┌───────────────────────────────────────────────────────────────┐
│                     Application Code                          │
│                                                               │
│  client.BooleanValue("new-checkout", false, evalCtx)         │
└───────────────────────────┬───────────────────────────────────┘
                            │  OpenFeature Client API
┌───────────────────────────▼───────────────────────────────────┐
│                   OpenFeature SDK                             │
│                                                               │
│  ┌─────────────────┐   ┌───────────────┐   ┌──────────────┐  │
│  │     Hooks       │   │    Provider   │   │  Evaluation  │  │
│  │  (before/after) │   │  (flagd impl) │   │    Context   │  │
│  └─────────────────┘   └───────┬───────┘   └──────────────┘  │
└───────────────────────────────┬───────────────────────────────┘
                                │  gRPC / HTTP
┌───────────────────────────────▼───────────────────────────────┐
│                        flagd                                  │
│              (in-cluster flag evaluation service)             │
│                                                               │
│  ┌───────────────────────────────────────────────────────┐    │
│  │              Flag Configuration (JSON/YAML)           │    │
│  │  Stored in ConfigMap, file, or HTTP endpoint          │    │
│  └───────────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────────┘
```

## Section 2: flagd Deployment on Kubernetes

flagd is the OpenFeature reference implementation of a flag evaluation service. It reads flag definitions from configurable sources, evaluates them using the JsonLogic targeting engine, and exposes both gRPC (port 8013) and HTTP (port 8080) evaluation APIs.

### Helm Deployment

```bash
# Add the OpenFeature Helm repository
helm repo add open-feature https://open-feature.github.io/open-feature-operator/
helm repo update

# Install flagd via the OpenFeature Operator
helm install openfeature-operator \
  open-feature/open-feature-operator \
  --namespace openfeature \
  --create-namespace \
  --version 0.7.2 \
  --values openfeature-operator-values.yaml
```

Production Helm values:

```yaml
# openfeature-operator-values.yaml
replicaCount: 2

image:
  manager:
    repository: ghcr.io/open-feature/open-feature-operator
    tag: v0.7.2
  flagd:
    repository: ghcr.io/open-feature/flagd
    tag: v0.10.2

resources:
  manager:
    limits:
      cpu: 500m
      memory: 256Mi
    requests:
      cpu: 100m
      memory: 128Mi

flagd:
  # Default flagd port for gRPC evaluation
  port: 8013
  # Management port for metrics and health
  managementPort: 8014
  # Log format for structured logging
  logFormat: json

podSecurityContext:
  runAsNonRoot: true
  runAsUser: 65534

securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop:
      - ALL

# Enable Prometheus metrics
metrics:
  enabled: true
  serviceMonitor:
    enabled: true
    namespace: monitoring
    interval: 30s

# Leader election for HA
leaderElection:
  enabled: true
```

### Standalone flagd Deployment (without Operator)

```yaml
# flagd-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: flagd
  namespace: openfeature
  labels:
    app: flagd
    version: v0.10.2
spec:
  replicas: 2
  selector:
    matchLabels:
      app: flagd
  template:
    metadata:
      labels:
        app: flagd
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8014"
        prometheus.io/path: "/metrics"
    spec:
      serviceAccountName: flagd
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        fsGroup: 65534
      containers:
        - name: flagd
          image: ghcr.io/open-feature/flagd:v0.10.2
          args:
            - start
            # Load flags from a ConfigMap-mounted file
            - --uri
            - file:/etc/flagd/flags.json
            # Enable gRPC evaluation API
            - --port
            - "8013"
            # Management port for metrics
            - --management-port
            - "8014"
            # Metrics format
            - --metrics-exporter
            - prometheus
          ports:
            - containerPort: 8013
              name: grpc
              protocol: TCP
            - containerPort: 8080
              name: http
              protocol: TCP
            - containerPort: 8014
              name: management
              protocol: TCP
          volumeMounts:
            - name: flag-config
              mountPath: /etc/flagd
          resources:
            limits:
              cpu: 500m
              memory: 256Mi
            requests:
              cpu: 100m
              memory: 128Mi
          livenessProbe:
            httpGet:
              path: /healthz
              port: management
            initialDelaySeconds: 10
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /readyz
              port: management
            initialDelaySeconds: 5
            periodSeconds: 10
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
      volumes:
        - name: flag-config
          configMap:
            name: flagd-flags
---
apiVersion: v1
kind: Service
metadata:
  name: flagd
  namespace: openfeature
  labels:
    app: flagd
spec:
  selector:
    app: flagd
  ports:
    - name: grpc
      port: 8013
      targetPort: 8013
      protocol: TCP
    - name: http
      port: 8080
      targetPort: 8080
      protocol: TCP
    - name: management
      port: 8014
      targetPort: 8014
      protocol: TCP
```

## Section 3: Flag Configuration in ConfigMap

Flag definitions use the OpenFeature JSON format. Each flag specifies a type (`boolean`, `string`, `integer`, `float`, `object`), default variant, a map of variants, and optional targeting rules evaluated with JsonLogic.

```yaml
# flagd-flags-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: flagd-flags
  namespace: openfeature
  labels:
    app: flagd
data:
  flags.json: |
    {
      "$schema": "https://flagd.dev/schema/v0/flags.json",
      "flags": {
        "new-checkout-flow": {
          "state": "ENABLED",
          "variants": {
            "on": true,
            "off": false
          },
          "defaultVariant": "off",
          "targeting": {
            "if": [
              {
                "in": [
                  {"var": "email"},
                  [
                    "beta-user-1@example.com",
                    "beta-user-2@example.com"
                  ]
                ]
              },
              "on",
              "off"
            ]
          }
        },
        "payment-provider": {
          "state": "ENABLED",
          "variants": {
            "stripe": "stripe",
            "braintree": "braintree",
            "adyen": "adyen"
          },
          "defaultVariant": "stripe",
          "targeting": {
            "if": [
              {
                "==": [{"var": "region"}, "eu-west"]
              },
              "adyen",
              {
                "if": [
                  {
                    "==": [{"var": "plan"}, "enterprise"]
                  },
                  "braintree",
                  "stripe"
                ]
              }
            ]
          }
        },
        "api-rate-limit": {
          "state": "ENABLED",
          "variants": {
            "standard": 1000,
            "premium": 5000,
            "unlimited": 999999
          },
          "defaultVariant": "standard",
          "targeting": {
            "if": [
              {
                "==": [{"var": "plan"}, "enterprise"]
              },
              "unlimited",
              {
                "if": [
                  {
                    "==": [{"var": "plan"}, "premium"]
                  },
                  "premium",
                  "standard"
                ]
              }
            ]
          }
        },
        "canary-feature-v2": {
          "state": "ENABLED",
          "variants": {
            "on": true,
            "off": false
          },
          "defaultVariant": "off",
          "targeting": {
            "fractional": [
              {"var": "targetingKey"},
              ["on", 20],
              ["off", 80]
            ]
          }
        },
        "dark-mode": {
          "state": "ENABLED",
          "variants": {
            "enabled": {
              "theme": "dark",
              "contrast": "high"
            },
            "disabled": {
              "theme": "light",
              "contrast": "normal"
            }
          },
          "defaultVariant": "disabled"
        }
      }
    }
```

### Hot-Reloading Flag Changes

flagd watches the mounted file for changes. To update flags without restarting:

```bash
# Update the ConfigMap directly
kubectl create configmap flagd-flags \
  --namespace openfeature \
  --from-file=flags.json=./updated-flags.json \
  --dry-run=client -o yaml | kubectl apply -f -

# flagd detects the file change within the inotify watch interval (default: 5 seconds)
# and reloads flags without dropping connections

# Verify the reload via flagd management API
kubectl port-forward svc/flagd -n openfeature 8014:8014 &
curl -s http://localhost:8014/metrics | grep flagd_flag_evaluations_total
```

## Section 4: SDK Usage Examples

### Go SDK

```go
// go.mod: require github.com/open-feature/go-sdk v1.12.0
// go.mod: require github.com/open-feature/go-sdk-contrib/providers/flagd v0.2.0

package main

import (
    "context"
    "log"

    "github.com/open-feature/go-sdk/openfeature"
    flagd "github.com/open-feature/go-sdk-contrib/providers/flagd/pkg"
)

func main() {
    // Initialize the flagd provider pointing at the in-cluster service
    provider := flagd.NewProvider(
        flagd.WithHost("flagd.openfeature.svc.cluster.local"),
        flagd.WithPort(8013),
        flagd.WithTLS(false), // Enable in production with cert-manager TLS
    )

    // Register the provider as the global OpenFeature provider
    if err := openfeature.SetProvider(provider); err != nil {
        log.Fatalf("failed to set OpenFeature provider: %v", err)
    }

    // Create a named client for the payment service
    client := openfeature.NewClient("payment-service")

    // Build evaluation context from the incoming request
    evalCtx := openfeature.NewEvaluationContext(
        "user-8472",                    // targetingKey — stable identifier for fractional targeting
        map[string]interface{}{
            "email":  "user@example.com",
            "region": "eu-west",
            "plan":   "enterprise",
        },
    )

    ctx := context.Background()

    // Evaluate a boolean flag
    useNewCheckout, err := client.BooleanValue(ctx, "new-checkout-flow", false, evalCtx)
    if err != nil {
        log.Printf("flag evaluation error: %v", err)
        // Default value (false) is already applied when err != nil
    }

    if useNewCheckout {
        log.Println("routing to new checkout flow")
    } else {
        log.Println("routing to legacy checkout flow")
    }

    // Evaluate a string flag for payment provider selection
    provider2, err := client.StringValue(ctx, "payment-provider", "stripe", evalCtx)
    if err != nil {
        log.Printf("payment-provider flag error: %v", err)
    }
    log.Printf("using payment provider: %s", provider2)

    // Evaluate an integer flag for rate limiting
    rateLimit, err := client.IntValue(ctx, "api-rate-limit", 1000, evalCtx)
    if err != nil {
        log.Printf("api-rate-limit flag error: %v", err)
    }
    log.Printf("rate limit for this request: %d req/min", rateLimit)

    // Evaluate an object flag
    themeDetails, err := client.ObjectValue(ctx, "dark-mode", map[string]interface{}{
        "theme": "light", "contrast": "normal",
    }, evalCtx)
    if err != nil {
        log.Printf("dark-mode flag error: %v", err)
    }
    log.Printf("theme config: %v", themeDetails)
}
```

### Go Hook Implementation for Metrics

```go
// metrics_hook.go
package featureflags

import (
    "context"
    "time"

    "github.com/open-feature/go-sdk/openfeature"
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    // Counter for total flag evaluations
    flagEvaluationsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "openfeature_flag_evaluations_total",
            Help: "Total number of OpenFeature flag evaluations",
        },
        []string{"flag_key", "variant", "reason"},
    )

    // Histogram for evaluation latency
    flagEvaluationDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "openfeature_flag_evaluation_duration_seconds",
            Help:    "Duration of OpenFeature flag evaluations",
            Buckets: []float64{0.001, 0.005, 0.01, 0.05, 0.1, 0.5},
        },
        []string{"flag_key"},
    )
)

// MetricsHook records Prometheus metrics for every flag evaluation
type MetricsHook struct{}

// After is called after each flag evaluation with the resolved details
func (h *MetricsHook) After(
    ctx context.Context,
    hookContext openfeature.HookContext,
    flagEvaluationDetails openfeature.InterfaceEvaluationDetails,
    hookHints openfeature.HookHints,
) error {
    flagEvaluationsTotal.WithLabelValues(
        hookContext.FlagKey(),
        flagEvaluationDetails.Variant,
        string(flagEvaluationDetails.Reason),
    ).Inc()
    return nil
}

// Before records the start time for latency tracking
func (h *MetricsHook) Before(
    ctx context.Context,
    hookContext openfeature.HookContext,
    hookHints openfeature.HookHints,
) (*openfeature.EvaluationContext, error) {
    // Store start time in context for latency calculation in After
    return nil, nil
}

// Error is called when flag evaluation returns an error
func (h *MetricsHook) Error(
    ctx context.Context,
    hookContext openfeature.HookContext,
    err error,
    hookHints openfeature.HookHints,
) {
    flagEvaluationsTotal.WithLabelValues(
        hookContext.FlagKey(),
        "error",
        "ERROR",
    ).Inc()
}

// Finally is always called after evaluation completes
func (h *MetricsHook) Finally(
    ctx context.Context,
    hookContext openfeature.HookContext,
    hookHints openfeature.HookHints,
) {}
```

### Java SDK

```java
// pom.xml dependency: dev.openfeature:sdk:1.9.0
// pom.xml dependency: dev.openfeature.contrib.providers:flagd:0.8.9

import dev.openfeature.sdk.*;
import dev.openfeature.contrib.providers.flagd.FlagdProvider;
import dev.openfeature.contrib.providers.flagd.FlagdOptions;

public class PaymentService {

    private final Client featureClient;

    public PaymentService() {
        // Configure flagd provider for in-cluster service
        FlagdOptions options = FlagdOptions.builder()
            .host("flagd.openfeature.svc.cluster.local")
            .port(8013)
            .tls(false)
            .deadline(3000)  // 3 second evaluation timeout
            .build();

        FeatureProvider provider = new FlagdProvider(options);

        // Register the provider
        OpenFeatureAPI.getInstance().setProvider(provider);

        // Create a named client for this service
        this.featureClient = OpenFeatureAPI.getInstance().getClient("payment-service");
    }

    public String selectPaymentProvider(String userId, String region, String plan) {
        // Build evaluation context from request attributes
        ImmutableContext evalCtx = new ImmutableContext(
            userId,  // targetingKey
            Map.of(
                "region", new Value(region),
                "plan", new Value(plan)
            )
        );

        // Evaluate the string flag — default to "stripe" if evaluation fails
        FlagEvaluationDetails<String> details = featureClient.getStringDetails(
            "payment-provider",
            "stripe",
            evalCtx
        );

        // Log evaluation metadata for observability
        System.out.printf(
            "Flag: payment-provider, Variant: %s, Reason: %s%n",
            details.getVariant(),
            details.getReason()
        );

        return details.getValue();
    }

    public boolean isNewCheckoutEnabled(String userEmail) {
        ImmutableContext evalCtx = new ImmutableContext(
            userEmail,
            Map.of("email", new Value(userEmail))
        );

        return featureClient.getBooleanValue("new-checkout-flow", false, evalCtx);
    }
}
```

### Python SDK

```python
# requirements.txt: openfeature-sdk==0.4.2
# requirements.txt: openfeature-provider-flagd==0.1.5

from openfeature import api
from openfeature.provider.flagd.flagd_provider import FlagdProvider
from openfeature.evaluation_context import EvaluationContext
from openfeature.flag_evaluation import FlagEvaluationDetails

def configure_openfeature():
    """Configure OpenFeature with the in-cluster flagd provider."""
    provider = FlagdProvider(
        host="flagd.openfeature.svc.cluster.local",
        port=8013,
        tls=False,
        timeout=3,   # 3 second evaluation timeout
    )
    api.set_provider(provider)


def evaluate_flags(user_id: str, region: str, plan: str) -> dict:
    """Evaluate feature flags for a given request context."""
    client = api.get_client("payment-service")

    # Build evaluation context
    eval_ctx = EvaluationContext(
        targeting_key=user_id,
        attributes={
            "region": region,
            "plan": plan,
        }
    )

    results = {}

    # Boolean flag evaluation
    new_checkout: bool = client.get_boolean_value(
        flag_key="new-checkout-flow",
        default_value=False,
        evaluation_context=eval_ctx,
    )
    results["new_checkout"] = new_checkout

    # String flag evaluation
    payment_provider: str = client.get_string_value(
        flag_key="payment-provider",
        default_value="stripe",
        evaluation_context=eval_ctx,
    )
    results["payment_provider"] = payment_provider

    # Integer flag evaluation
    rate_limit: int = client.get_integer_value(
        flag_key="api-rate-limit",
        default_value=1000,
        evaluation_context=eval_ctx,
    )
    results["rate_limit"] = rate_limit

    return results


if __name__ == "__main__":
    configure_openfeature()

    # Example usage with request attributes
    flags = evaluate_flags(
        user_id="user-8472",
        region="eu-west",
        plan="enterprise",
    )
    print(f"Resolved flags: {flags}")
```

## Section 5: Targeting Rules with JsonLogic

flagd uses [JsonLogic](https://jsonlogic.com/) for targeting rules, enabling sophisticated flag targeting without custom code.

### Percentage-Based Rollout

```json
{
  "flags": {
    "new-search-algorithm": {
      "state": "ENABLED",
      "variants": {
        "on": true,
        "off": false
      },
      "defaultVariant": "off",
      "targeting": {
        "fractional": [
          {"var": "targetingKey"},
          ["on", 10],
          ["off", 90]
        ]
      }
    }
  }
}
```

### Multi-Condition Targeting

```json
{
  "flags": {
    "advanced-analytics": {
      "state": "ENABLED",
      "variants": {
        "on": true,
        "off": false
      },
      "defaultVariant": "off",
      "targeting": {
        "if": [
          {
            "and": [
              {">=": [{"var": "account_age_days"}, 30]},
              {"in": [{"var": "plan"}, ["premium", "enterprise"]]},
              {"!=": [{"var": "region"}, "cn-north"]}
            ]
          },
          "on",
          "off"
        ]
      }
    }
  }
}
```

### String Matching for Beta Groups

```json
{
  "flags": {
    "beta-dashboard": {
      "state": "ENABLED",
      "variants": {
        "on": true,
        "off": false
      },
      "defaultVariant": "off",
      "targeting": {
        "if": [
          {
            "or": [
              {
                "ends_with": [{"var": "email"}, "@internal.example.com"]
              },
              {
                "in": [{"var": "group"}, ["beta-testers", "early-access"]]
              }
            ]
          },
          "on",
          "off"
        ]
      }
    }
  }
}
```

## Section 6: Argo Rollouts Integration

OpenFeature flags can drive Argo Rollouts canary analysis and header-based traffic routing, enabling feature flags to serve as the control plane for progressive delivery.

### Rollout with Header-Based Routing

```yaml
# payment-service-rollout.yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: payment-service
  namespace: production
spec:
  replicas: 10
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
          image: registry.example.com/payment-service:v2.3.1
          env:
            - name: FLAGD_HOST
              value: flagd.openfeature.svc.cluster.local
            - name: FLAGD_PORT
              value: "8013"
          ports:
            - containerPort: 8080
  strategy:
    canary:
      stableMetadata:
        labels:
          role: stable
      canaryMetadata:
        labels:
          role: canary
      steps:
        # Step 1: 10% of traffic to canary, match beta users via header
        - setWeight: 10
        - pause:
            duration: 10m
        # Step 2: Run metric analysis during canary phase
        - analysis:
            templates:
              - templateName: payment-success-rate
        # Step 3: Expand to 25%
        - setWeight: 25
        - pause:
            duration: 15m
        # Step 4: 50% with full analysis
        - setWeight: 50
        - analysis:
            templates:
              - templateName: payment-success-rate
              - templateName: p99-latency
        # Step 5: Full rollout
        - setWeight: 100
      # Use NGINX ingress for header-based routing
      trafficRouting:
        nginx:
          stableIngress: payment-service-stable
          annotationPrefix: nginx.ingress.kubernetes.io
          additionalIngressAnnotations:
            canary-by-header: "X-Feature-Canary"
            canary-by-header-value: "true"
---
# AnalysisTemplate for payment success rate
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: payment-success-rate
  namespace: production
spec:
  metrics:
    - name: payment-success-rate
      interval: 2m
      successCondition: result[0] >= 0.99
      failureLimit: 2
      provider:
        prometheus:
          address: http://prometheus.monitoring.svc.cluster.local:9090
          query: |
            sum(rate(payment_transactions_total{status="success",version="{{args.canary-hash}}"}[5m]))
            /
            sum(rate(payment_transactions_total{version="{{args.canary-hash}}"}[5m]))
  args:
    - name: canary-hash
```

### Feature Flag as Rollout Gate

Use OpenFeature flags to programmatically control whether a canary rollout proceeds:

```go
// rollout_gate.go
package main

import (
    "context"
    "fmt"
    "log"
    "os/exec"

    "github.com/open-feature/go-sdk/openfeature"
    flagd "github.com/open-feature/go-sdk-contrib/providers/flagd/pkg"
)

// RolloutGate checks OpenFeature flags before promoting a canary rollout
func checkRolloutGate(namespace, rolloutName string) error {
    provider := flagd.NewProvider(
        flagd.WithHost("flagd.openfeature.svc.cluster.local"),
        flagd.WithPort(8013),
    )
    if err := openfeature.SetProvider(provider); err != nil {
        return fmt.Errorf("setting provider: %w", err)
    }

    client := openfeature.NewClient("rollout-gate")
    ctx := context.Background()

    // Evaluate the promotion gate flag for this rollout
    evalCtx := openfeature.NewEvaluationContext(
        rolloutName,
        map[string]interface{}{
            "namespace": namespace,
            "rollout":   rolloutName,
        },
    )

    promote, err := client.BooleanValue(
        ctx,
        fmt.Sprintf("promote-%s-rollout", rolloutName),
        false,
        evalCtx,
    )
    if err != nil {
        return fmt.Errorf("evaluating promotion flag: %w", err)
    }

    if !promote {
        log.Printf("promotion gate for %s/%s is closed — aborting rollout", namespace, rolloutName)
        // Abort the canary rollout via kubectl
        cmd := exec.Command("kubectl", "argo", "rollouts", "abort",
            rolloutName, "-n", namespace)
        if out, err := cmd.CombinedOutput(); err != nil {
            return fmt.Errorf("aborting rollout: %w, output: %s", err, out)
        }
        return fmt.Errorf("rollout aborted by feature flag gate")
    }

    log.Printf("promotion gate for %s/%s is open — proceeding", namespace, rolloutName)
    return nil
}
```

## Section 7: flagd Prometheus Metrics

flagd exposes standard Prometheus metrics on the management port for flag evaluation observability.

### Available Metrics

```
# HELP flagd_flag_evaluations_total Total number of flag evaluations
# TYPE flagd_flag_evaluations_total counter
flagd_flag_evaluations_total{flag_key="new-checkout-flow",reason="TARGETING_MATCH",variant="on"} 1243
flagd_flag_evaluations_total{flag_key="new-checkout-flow",reason="DEFAULT",variant="off"} 8751
flagd_flag_evaluations_total{flag_key="payment-provider",reason="TARGETING_MATCH",variant="adyen"} 412
flagd_flag_evaluations_total{flag_key="payment-provider",reason="DEFAULT",variant="stripe"} 5812

# HELP flagd_flag_evaluation_duration_seconds Duration of flag evaluations
# TYPE flagd_flag_evaluation_duration_seconds histogram
flagd_flag_evaluation_duration_seconds_bucket{flag_key="new-checkout-flow",le="0.001"} 9832
flagd_flag_evaluation_duration_seconds_bucket{flag_key="new-checkout-flow",le="0.005"} 9994

# HELP flagd_config_reload_total Total number of flag configuration reloads
# TYPE flagd_config_reload_total counter
flagd_config_reload_total{source="file:/etc/flagd/flags.json"} 3
```

### ServiceMonitor Configuration

```yaml
# flagd-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: flagd
  namespace: monitoring
  labels:
    release: prometheus
spec:
  namespaceSelector:
    matchNames:
      - openfeature
  selector:
    matchLabels:
      app: flagd
  endpoints:
    - port: management
      interval: 15s
      path: /metrics
      scheme: http
```

### Grafana Dashboard Queries

```promql
# Flag evaluation rate by flag key
rate(flagd_flag_evaluations_total[5m])

# Variant distribution for a specific flag
sum by (variant) (
  rate(flagd_flag_evaluations_total{flag_key="new-checkout-flow"}[5m])
)

# Percentage of targeted evaluations (non-default)
sum(rate(flagd_flag_evaluations_total{reason!="DEFAULT"}[5m]))
/
sum(rate(flagd_flag_evaluations_total[5m]))

# Flag evaluation latency (99th percentile)
histogram_quantile(0.99,
  rate(flagd_flag_evaluation_duration_seconds_bucket[5m])
)

# Config reloads per hour
increase(flagd_config_reload_total[1h])
```

## Section 8: OpenFeature Operator and FeatureFlagSource CRD

The OpenFeature Operator extends Kubernetes with CRDs that inject flagd as a sidecar into application pods automatically.

```yaml
# featureflagsource.yaml
apiVersion: core.openfeature.dev/v1alpha2
kind: FeatureFlagSource
metadata:
  name: payment-service-flags
  namespace: production
spec:
  sources:
    - source: production/flagd-flags    # ConfigMap: namespace/name
      provider: file
    # Additional source: HTTP endpoint for central flag management
    - source: https://flags.internal.example.com/api/v1/flags
      provider: http
      httpSyncBearerToken: EXAMPLE_TOKEN_REPLACE_ME
  port: 8013
  metricsPort: 8014
  evaluator: json
  image: ghcr.io/open-feature/flagd:v0.10.2
  tag: v0.10.2
  resources:
    limits:
      cpu: 200m
      memory: 128Mi
    requests:
      cpu: 50m
      memory: 64Mi
  probesEnabled: true
  debugLogging: false
  otelCollectorUri: otel-collector.monitoring.svc.cluster.local:4317
```

Annotate the application pod to inject flagd sidecar automatically:

```yaml
# payment-service-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: payment-service
  template:
    metadata:
      labels:
        app: payment-service
      annotations:
        # Inject flagd sidecar using the FeatureFlagSource above
        openfeature.dev/enabled: "true"
        openfeature.dev/featureflagsource: "payment-service-flags"
    spec:
      containers:
        - name: payment-service
          image: registry.example.com/payment-service:v2.3.1
          env:
            # The injected sidecar is always localhost
            - name: FLAGD_HOST
              value: "localhost"
            - name: FLAGD_PORT
              value: "8013"
          ports:
            - containerPort: 8080
          resources:
            limits:
              cpu: 500m
              memory: 512Mi
            requests:
              cpu: 100m
              memory: 256Mi
```

## Section 9: Migration from LaunchDarkly and Unleash

### Migration from LaunchDarkly

The LaunchDarkly provider for OpenFeature wraps the existing LaunchDarkly Go SDK:

```bash
# Install the LaunchDarkly provider for OpenFeature
go get github.com/open-feature/go-sdk-contrib/providers/launchdarkly@latest
```

```go
// launchdarkly_migration.go
package main

import (
    "context"
    "log"

    ldProvider "github.com/open-feature/go-sdk-contrib/providers/launchdarkly/pkg"
    "github.com/open-feature/go-sdk/openfeature"
    ldclient "gopkg.in/launchdarkly/go-server-sdk.v5"
)

func migrateToOpenFeature() {
    // Phase 1: Wrap LaunchDarkly with the OpenFeature provider
    // This maintains all existing LD flag configurations and targeting
    ldConfig := ldclient.Config{}
    ldClient, err := ldclient.MakeClient(
        "EXAMPLE_LD_SDK_KEY_REPLACE_ME",
        ldConfig,
        5, // 5 second timeout
    )
    if err != nil {
        log.Fatalf("failed to create LD client: %v", err)
    }

    // Wrap in the OpenFeature provider - no flag configuration changes needed
    provider := ldProvider.NewProvider(ldClient)
    if err := openfeature.SetProvider(provider); err != nil {
        log.Fatalf("failed to set LD provider: %v", err)
    }

    // All existing flag evaluations now go through the OpenFeature API
    client := openfeature.NewClient("app")
    ctx := context.Background()

    evalCtx := openfeature.NewEvaluationContext(
        "user-1234",
        map[string]interface{}{"plan": "premium"},
    )

    enabled, _ := client.BooleanValue(ctx, "new-feature", false, evalCtx)
    log.Printf("new-feature: %v", enabled)

    // Phase 2: Gradually migrate flags to flagd ConfigMap
    // Phase 3: Switch provider to flagd and remove LD SDK dependency
}
```

### Migration from Unleash

```go
// unleash_migration.go
package main

import (
    "context"
    "log"

    unleashProvider "github.com/open-feature/go-sdk-contrib/providers/unleash/pkg"
    "github.com/open-feature/go-sdk/openfeature"
    unleash "github.com/Unleash/unleash-client-go/v4"
)

func migrateUnleashToOpenFeature() {
    // Initialize Unleash client
    unleash.Initialize(
        unleash.WithUrl("https://unleash.internal.example.com/api"),
        unleash.WithAppName("payment-service"),
        unleash.WithCustomHeaders(map[string]string{
            "Authorization": "EXAMPLE_TOKEN_REPLACE_ME",
        }),
    )

    // Wrap Unleash with OpenFeature provider
    provider := unleashProvider.NewProvider(unleash.DefaultClient)
    if err := openfeature.SetProvider(provider); err != nil {
        log.Fatalf("failed to set Unleash provider: %v", err)
    }

    client := openfeature.NewClient("payment-service")
    ctx := context.Background()

    evalCtx := openfeature.NewEvaluationContext(
        "user-9876",
        map[string]interface{}{"environment": "production"},
    )

    featureEnabled, _ := client.BooleanValue(ctx, "payment-provider-v2", false, evalCtx)
    log.Printf("payment-provider-v2: %v", featureEnabled)
}
```

## Section 10: RBAC and Security Configuration

### flagd RBAC

```yaml
# flagd-rbac.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: flagd
  namespace: openfeature
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: flagd-configmap-reader
rules:
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["core.openfeature.dev"]
    resources: ["featureflags", "featureflagsources"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: flagd-configmap-reader
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: flagd-configmap-reader
subjects:
  - kind: ServiceAccount
    name: flagd
    namespace: openfeature
```

### TLS for flagd gRPC

```yaml
# flagd-tls-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: flagd-tls-config
  namespace: openfeature
data:
  flagd-args: |
    --tls-cert-path /etc/flagd/tls/tls.crt
    --tls-key-path /etc/flagd/tls/tls.key
    --port 8013
---
# Create TLS certificate with cert-manager
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: flagd-tls
  namespace: openfeature
spec:
  secretName: flagd-tls-secret
  duration: 2160h    # 90 days
  renewBefore: 360h  # 15 days before expiry
  dnsNames:
    - flagd.openfeature.svc.cluster.local
    - flagd.openfeature.svc
    - flagd
  issuerRef:
    name: cluster-issuer-internal
    kind: ClusterIssuer
```

## Section 11: Testing Feature Flag Behavior

### Unit Testing with In-Memory Provider

```go
// feature_flag_test.go
package payment_test

import (
    "context"
    "testing"

    "github.com/open-feature/go-sdk/openfeature"
)

// TestNewCheckoutFlow verifies routing logic based on flag values
func TestNewCheckoutFlow(t *testing.T) {
    tests := []struct {
        name          string
        flagValue     bool
        expectedRoute string
    }{
        {
            name:          "new checkout enabled",
            flagValue:     true,
            expectedRoute: "/checkout/v2",
        },
        {
            name:          "new checkout disabled",
            flagValue:     false,
            expectedRoute: "/checkout/v1",
        },
    }

    for _, tc := range tests {
        t.Run(tc.name, func(t *testing.T) {
            // Use the in-memory provider for testing without flagd
            provider := openfeature.NewInMemoryProvider(map[string]openfeature.InMemoryFlag{
                "new-checkout-flow": {
                    DefaultVariant: func() string {
                        if tc.flagValue {
                            return "on"
                        }
                        return "off"
                    }(),
                    Variants: map[string]interface{}{
                        "on":  true,
                        "off": false,
                    },
                },
            })

            // Reset the global provider for this test
            if err := openfeature.SetProvider(provider); err != nil {
                t.Fatalf("setting provider: %v", err)
            }

            client := openfeature.NewClient("test")
            result, err := client.BooleanValue(
                context.Background(),
                "new-checkout-flow",
                false,
                openfeature.NewEvaluationContext("test-user", nil),
            )
            if err != nil {
                t.Fatalf("flag evaluation error: %v", err)
            }

            if result != tc.flagValue {
                t.Errorf("expected %v, got %v", tc.flagValue, result)
            }
        })
    }
}
```

## Section 12: Production Recommendations

**Flag Lifecycle Management:** Treat feature flags as technical debt. Establish a flag expiry policy (90 days for canary flags, indefinite for operational/kill-switch flags). Use flag metadata fields to record owner, ticket reference, and planned removal date.

**Evaluation Context Standardization:** Define a canonical set of context keys (`targetingKey`, `userId`, `orgId`, `plan`, `region`, `environment`) and validate them at SDK initialization with a Before hook. Inconsistent context leads to targeting rules producing unexpected results in production.

**flagd Availability:** flagd uses a circuit breaker pattern — if the evaluation service is unreachable, the SDK returns the configured default value rather than blocking. Set default values conservatively (i.e., the safe/existing behavior) so that flagd downtime degrades to existing functionality rather than activating partially-deployed features.

**ConfigMap vs. HTTP Source:** ConfigMap-based flag storage is simpler but requires a `kubectl apply` to update flags. HTTP source mode allows flag management through an external system (custom admin UI, GitOps pipeline) without touching Kubernetes objects. Use HTTP source for any flag that changes more than once per day.

**Multi-Cluster Consistency:** When running flagd across multiple clusters (e.g., per region), use a single HTTP source pointing at a central flag repository to ensure consistent flag state. ConfigMap-per-cluster approaches can diverge during deployments.
