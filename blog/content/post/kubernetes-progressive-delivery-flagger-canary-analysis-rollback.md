---
title: "Kubernetes Progressive Delivery with Flagger: Automated Canary Analysis and Rollback"
date: 2030-10-11T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Flagger", "Canary", "Progressive Delivery", "GitOps", "Istio", "Prometheus"]
categories:
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise Flagger guide covering canary deployment lifecycle, metric analysis providers (Prometheus, Datadog), webhooks for load testing and smoke testing, A/B testing configuration, blue-green deployments, and automated rollback on SLO violations."
more_link: "yes"
url: "/kubernetes-progressive-delivery-flagger-canary-analysis-rollback/"
---

Flagger automates the "ship it carefully" part of continuous delivery. Rather than requiring engineers to manually monitor metrics during a rollout and decide when to promote or roll back, Flagger codifies the analysis logic in a `Canary` resource and executes it automatically. The result is faster deployment cadence with lower incident risk — deployments happen on every merge without requiring an on-call engineer to babysit them.

<!--more-->

## Flagger Architecture

Flagger runs as a Kubernetes controller that watches `Canary` resources. When a controlled Deployment's pod spec changes (typically the container image), Flagger:

1. Creates a canary Deployment (with `-canary` suffix)
2. Creates a stable Deployment (the current stable version)
3. Adjusts traffic routing through the mesh/ingress to split traffic
4. Queries metrics providers at each analysis interval
5. If metrics pass: increments traffic weight by stepWeight
6. If metrics fail: rolls back to stable version

```
┌─────────────────────────────────────────────────────────┐
│  Flagger Controller                                      │
│                                                          │
│  Watches: Deployment changes → triggers canary analysis  │
│  Manages: Canary weights, metric queries, webhooks       │
└─────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────┐
│  Traffic                                                 │
│                                                          │
│  ┌───────────────┐         ┌───────────────────────┐    │
│  │  Stable (95%) │         │  Canary (5% → 100%)   │    │
│  │  v1.2.0       │         │  v1.3.0               │    │
│  └───────────────┘         └───────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

---

## Installation

### Flagger with Nginx Ingress

```bash
helm repo add flagger https://flagger.app
helm repo update

# Install Flagger with nginx ingress controller support
helm upgrade --install flagger flagger/flagger \
  --namespace flagger-system \
  --create-namespace \
  --set meshProvider=nginx \
  --set metricsServer=http://prometheus-operated.monitoring.svc.cluster.local:9090 \
  --set logLevel=info

# Install Flagger load tester (used in webhook pre-tests)
helm upgrade --install flagger-loadtester flagger/loadtester \
  --namespace flagger-system
```

### Flagger with Istio

```bash
helm upgrade --install flagger flagger/flagger \
  --namespace istio-system \
  --set meshProvider=istio \
  --set metricsServer=http://prometheus.istio-system:9090
```

### Flagger with Linkerd

```bash
helm upgrade --install flagger flagger/flagger \
  --namespace linkerd \
  --set meshProvider=linkerd \
  --set metricsServer=http://prometheus.linkerd-viz:9090
```

---

## Core Canary Resource

### Basic Canary with Nginx Ingress

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: podinfo
  namespace: production
spec:
  # Reference to the Deployment being controlled
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: podinfo

  # Ingress for traffic routing
  ingressRef:
    apiVersion: networking.k8s.io/v1
    kind: Ingress
    name: podinfo

  # Progressive delivery analysis
  analysis:
    # Check metrics every 1 minute
    interval: 1m
    # Roll back after 5 consecutive failures
    threshold: 5
    # Promote after reaching 100% traffic weight
    maxWeight: 100
    # Increment traffic by 10% at each interval
    stepWeight: 10

    metrics:
      - name: request-success-rate
        # Minimum 99% success rate (1xx, 2xx, 3xx)
        thresholdRange:
          min: 99
        interval: 1m
      - name: request-duration
        # Maximum P99 latency of 500ms
        thresholdRange:
          max: 500
        interval: 1m

    # Pre-rollout smoke test
    webhooks:
      - name: smoke-test
        type: pre-rollout
        url: http://flagger-loadtester.flagger-system/
        timeout: 60s
        metadata:
          type: bash
          cmd: >
            curl -sd 'test' http://podinfo-canary.production:9898/token |
            grep -q token && echo 'smoke test passed' || exit 1

      # Load test during analysis
      - name: load-test
        url: http://flagger-loadtester.flagger-system/
        timeout: 5s
        metadata:
          type: cmd
          cmd: >
            hey -z 1m -q 10 -c 2
            -H "Host: app.example.com"
            http://podinfo-canary.production:9898/
          logCmdOutput: "true"

  # Service configuration
  service:
    port: 9898
    targetPort: 9898
    portDiscovery: true
```

### Full Canary with Istio Traffic Management

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: api-gateway
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-gateway
  progressDeadlineSeconds: 120
  service:
    port: 8080
    targetPort: 8080
    gateways:
      - public-gateway.istio-system.svc.cluster.local
    hosts:
      - api.example.com
    trafficPolicy:
      tls:
        mode: ISTIO_MUTUAL
    retries:
      attempts: 3
      perTryTimeout: 1s
      retryOn: "gateway-error,connect-failure,refused-stream"
    headers:
      request:
        add:
          x-progressive-delivery: "canary"
    corsPolicy:
      allowOrigins:
        - exact: "https://app.example.com"
      allowMethods:
        - GET
        - POST
        - PUT
        - DELETE
        - OPTIONS
      allowHeaders:
        - Authorization
        - Content-Type
      maxAge: "24h"
  analysis:
    interval: 1m
    threshold: 5
    maxWeight: 50
    stepWeight: 5
    metrics:
      - name: request-success-rate
        thresholdRange:
          min: 99.5
        interval: 1m
      - name: request-duration
        thresholdRange:
          max: 200
        interval: 1m
      # Custom metric: database error rate
      - name: db-error-rate
        templateRef:
          name: db-error-rate-template
          namespace: flagger-system
        thresholdRange:
          max: 0.5
        interval: 1m
    webhooks:
      - name: acceptance-test
        type: pre-rollout
        url: http://flagger-loadtester.flagger-system/
        timeout: 120s
        metadata:
          type: bash
          cmd: |
            kubectl -n production run acceptance-test \
              --image=curlimages/curl \
              --restart=Never \
              --rm \
              -it \
              -- curl -sf http://api-gateway-canary.production:8080/health |
              jq '.status == "healthy"'
      - name: functional-test
        type: pre-rollout
        url: http://flagger-loadtester.flagger-system/
        timeout: 300s
        metadata:
          type: bash
          cmd: >
            newman run /collections/api-smoke-tests.json
            --env-var "baseUrl=http://api-gateway-canary.production:8080"
            --reporters cli,junit
            --reporter-junit-export /tmp/results.xml
      - name: load-test
        url: http://flagger-loadtester.flagger-system/
        timeout: 5s
        metadata:
          type: cmd
          cmd: >
            hey -z 1m -q 20 -c 4
            -H "Authorization: Bearer <load-test-token>"
            http://api-gateway-canary.production:8080/api/v1/health
      - name: notify-team
        type: event
        url: http://flagger-loadtester.flagger-system/
        metadata:
          type: bash
          cmd: >
            curl -sf -X POST
            http://alertmanager.monitoring:9093/api/v2/alerts
            -H "Content-Type: application/json"
            -d '[{"labels":{"alertname":"CanaryPromoted","deployment":"api-gateway"}}]'
```

---

## MetricTemplates for Custom Analysis

Flagger's built-in metrics cover basic success rate and latency. For business-level SLOs, define custom MetricTemplates:

### Prometheus MetricTemplate

```yaml
apiVersion: flagger.app/v1beta1
kind: MetricTemplate
metadata:
  name: db-error-rate
  namespace: flagger-system
spec:
  provider:
    type: prometheus
    address: http://prometheus-operated.monitoring:9090
  query: |
    100 - sum(
      rate(
        db_query_duration_seconds_count{
          job="api-gateway",
          status!="error",
          namespace="{{ namespace }}"
        }[{{ interval }}]
      )
    ) /
    sum(
      rate(
        db_query_duration_seconds_count{
          job="api-gateway",
          namespace="{{ namespace }}"
        }[{{ interval }}]
      )
    ) * 100
---
apiVersion: flagger.app/v1beta1
kind: MetricTemplate
metadata:
  name: apdex-score
  namespace: flagger-system
spec:
  provider:
    type: prometheus
    address: http://prometheus-operated.monitoring:9090
  query: |
    (
      sum(rate(http_request_duration_seconds_bucket{
        le="0.1",
        namespace="{{ namespace }}",
        name="{{ target }}"
      }[{{ interval }}]))
      +
      sum(rate(http_request_duration_seconds_bucket{
        le="0.4",
        namespace="{{ namespace }}",
        name="{{ target }}"
      }[{{ interval }}])) / 2
    ) /
    sum(rate(http_request_duration_seconds_count{
      namespace="{{ namespace }}",
      name="{{ target }}"
    }[{{ interval }}]))
```

### Datadog MetricTemplate

```yaml
apiVersion: flagger.app/v1beta1
kind: MetricTemplate
metadata:
  name: p99-latency-datadog
  namespace: flagger-system
spec:
  provider:
    type: datadog
    address: https://api.datadoghq.com
    secretRef:
      name: datadog-api-credentials
  query: |
    avg:trace.web.request.duration.by.service.99p{
      env:production,
      service:{{ target }}
    }.rollup(avg, {{ interval }})
---
apiVersion: v1
kind: Secret
metadata:
  name: datadog-api-credentials
  namespace: flagger-system
type: Opaque
stringData:
  apiKey: <datadog-api-key>
  applicationKey: <datadog-application-key>
```

---

## A/B Testing Configuration

A/B testing routes traffic based on HTTP headers or cookies, allowing simultaneous testing of multiple variants:

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: checkout-service
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: checkout-service
  service:
    port: 8080
    hosts:
      - checkout.example.com
    gateways:
      - public-gateway.istio-system.svc.cluster.local
  analysis:
    interval: 1m
    threshold: 10
    # A/B mode: no traffic weight progression
    # canary receives all traffic matching the header
    iterations: 10
    match:
      # Route requests with this header to canary
      - headers:
          x-canary-user:
            exact: "true"
      # Or route based on cookie
      - headers:
          cookie:
            regex: "^(.*; )?canary=true(;.*)?$"
    metrics:
      - name: request-success-rate
        thresholdRange:
          min: 99
        interval: 1m
      - name: request-duration
        thresholdRange:
          max: 300
        interval: 1m
    webhooks:
      - name: load-test-ab
        url: http://flagger-loadtester.flagger-system/
        timeout: 5s
        metadata:
          type: cmd
          cmd: >
            hey -z 1m -q 10 -c 2
            -H "x-canary-user: true"
            http://checkout-service-canary.production:8080/checkout
```

---

## Blue-Green Deployments

For stateful services or when gradual rollout is not acceptable, Flagger supports blue-green deployments — full traffic switch with the ability to roll back:

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: payment-processor
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payment-processor
  progressDeadlineSeconds: 300
  service:
    port: 8443
    targetPort: 8443
  analysis:
    # Blue-green: jump to 100% immediately after pre-rollout tests pass
    interval: 30s
    threshold: 2
    maxWeight: 100
    stepWeight: 100  # Full cutover in one step
    webhooks:
      - name: acceptance-test
        type: pre-rollout
        url: http://flagger-loadtester.flagger-system/
        timeout: 300s
        metadata:
          type: bash
          cmd: |
            # Run full regression suite against canary
            pytest /tests/integration/ \
              --base-url=http://payment-processor-canary.production:8443 \
              --timeout=60 \
              -v
      - name: post-rollout-validation
        type: post-rollout
        url: http://flagger-loadtester.flagger-system/
        timeout: 60s
        metadata:
          type: bash
          cmd: |
            # Validate production traffic is flowing correctly
            curl -sf http://payment-processor.production:8443/health/ready
```

---

## Automated Rollback on SLO Violations

Flagger automatically rolls back when metric thresholds are breached for the configured number of consecutive intervals:

```yaml
analysis:
  interval: 1m
  threshold: 5       # 5 consecutive failures triggers rollback
  maxWeight: 50
  stepWeight: 5
  metrics:
    - name: request-success-rate
      thresholdRange:
        min: 99       # Below 99% success → failure
      interval: 1m
    - name: request-duration
      thresholdRange:
        max: 500      # Above 500ms P99 → failure
      interval: 1m
```

Rollback sequence:

1. Metric fails at interval T
2. Flagger increments failure counter
3. After 5 failures: routes 100% traffic back to stable version
4. Scales down canary Deployment to 0 replicas
5. Sets Canary resource status to `Failed`
6. Fires webhooks of type `rollback`

```yaml
webhooks:
  - name: notify-rollback
    type: rollback
    url: http://flagger-loadtester.flagger-system/
    metadata:
      type: bash
      cmd: |
        MESSAGE="Canary rollback: {{ name }} in {{ namespace }}"
        curl -sf -X POST https://hooks.slack.com/services/<WORKSPACE_ID>/<CHANNEL_ID>/<WEBHOOK_TOKEN> \
          -H "Content-Type: application/json" \
          -d "{\"text\": \"${MESSAGE}\"}"
```

### Monitoring Canary Status

```bash
# Watch canary progression in real time
watch -n 5 kubectl get canaries -n production

# Detailed status
kubectl describe canary podinfo -n production

# Expected output during progression:
# Status:
#   Canary Weight:  20
#   Failed Checks:  0
#   Phase:          Progressing
#   Conditions:
#     Type:    Promoted
#     Status:  Unknown
#     Reason:  Progressing
#     Message: Advance podinfo.production canary weight 20/100

# Event stream
kubectl get events -n production \
  --field-selector reason=Synced \
  --sort-by='.lastTimestamp'

# Flagger controller logs
kubectl logs -n flagger-system deploy/flagger -f | \
  grep "podinfo"
```

---

## Flagger with Flux v2 GitOps

Integrating Flagger with Flux creates a fully automated delivery pipeline: a merge to Git triggers Flux to update the Deployment image, Flagger detects the change and begins the canary analysis, and the result (promotion or rollback) is the only human-free gate between development and production.

```yaml
# Kustomization that includes the Canary resource alongside the Deployment
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: production-apps
  namespace: flux-system
spec:
  interval: 5m
  sourceRef:
    kind: GitRepository
    name: fleet-infra
  path: ./apps/production
  prune: true
  healthChecks:
    # Flux waits for the Canary to report Promoted before marking
    # the Kustomization as ready
    - apiVersion: flagger.app/v1beta1
      kind: Canary
      name: podinfo
      namespace: production
```

---

## Notification Providers

### Slack Notifications

```yaml
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Provider
metadata:
  name: slack-deployments
  namespace: flagger-system
spec:
  type: slack
  channel: "#deployments"
  secretRef:
    name: slack-webhook
---
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Alert
metadata:
  name: canary-alerts
  namespace: flagger-system
spec:
  providerRef:
    name: slack-deployments
  eventSeverity: info
  eventSources:
    - kind: Canary
      namespace: production
      name: "*"
```

Flagger sends events at each stage:
- `Progressing`: canary weight updated
- `Promoted`: canary fully promoted, stable updated
- `Failed`: rollback completed
- `Waiting`: pre-rollout webhooks running

---

## Operational Runbook

```bash
# Force a manual promotion (override analysis)
kubectl annotate canary podinfo -n production \
  flagger.app/action=promote

# Force a manual rollback
kubectl annotate canary podinfo -n production \
  flagger.app/action=rollback

# Pause a canary (hold at current weight)
kubectl patch canary podinfo -n production \
  --type='json' \
  -p='[{"op":"replace","path":"/spec/analysis/interval","value":"999999h"}]'

# Resume by resetting interval
kubectl patch canary podinfo -n production \
  --type='json' \
  -p='[{"op":"replace","path":"/spec/analysis/interval","value":"1m"}]'

# Check which version is currently primary
kubectl get canary podinfo -n production -o jsonpath='{.status.trackedConfigs}'

# Get the current traffic split
kubectl get virtualservice podinfo -n production -o yaml | \
  yq '.spec.http[].route'

# Inspect failed checks
kubectl get canary podinfo -n production \
  -o jsonpath='{.status.conditions}' | jq '.'

# View the canary's current deployment spec
kubectl get deployment podinfo-canary -n production \
  -o jsonpath='{.spec.template.spec.containers[0].image}'

# View the stable deployment spec (what's serving 100% of traffic after rollback)
kubectl get deployment podinfo-primary -n production \
  -o jsonpath='{.spec.template.spec.containers[0].image}'
```

---

## Tuning Analysis for Different Risk Profiles

For different service criticality levels, adjust the analysis parameters:

```yaml
# High-risk: payment critical path — conservative analysis
analysis:
  interval: 2m
  threshold: 2        # Roll back after just 2 failures
  maxWeight: 20       # Never route more than 20% to canary
  stepWeight: 2       # Small increments

# Medium-risk: standard API services
analysis:
  interval: 1m
  threshold: 5
  maxWeight: 50
  stepWeight: 5

# Low-risk: static asset services or read-only endpoints
analysis:
  interval: 30s
  threshold: 10
  maxWeight: 100
  stepWeight: 20       # Fast promotion for low-risk services
```

Flagger's power lies not in individual capabilities but in their composition: metric-driven promotion gates, pre-rollout testing, load test generation, and notification webhooks create a deployment system that enforces your SLOs automatically on every release — making progressive delivery as routine as a CI test run rather than an event requiring on-call supervision.
