---
title: "Kubernetes Flagger: Progressive Delivery with Canary Analysis and Metrics"
date: 2029-02-21T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Flagger", "Canary", "Progressive Delivery", "Istio", "Observability"]
categories:
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Kubernetes Flagger for automated canary deployments — configuring canary analysis, custom metrics, webhooks, and rollback automation for enterprise GitOps workflows."
more_link: "yes"
url: "/kubernetes-flagger-progressive-delivery-canary-analysis/"
---

Progressive delivery is the practice of releasing changes incrementally to production, validating each increment against real traffic before proceeding. Flagger automates this process on Kubernetes by controlling traffic routing between stable and canary deployments, analyzing metrics at each step, and triggering automatic rollback when analysis fails.

Compared to a simple blue-green deployment, Flagger's canary analysis introduces a structured feedback loop: traffic is shifted incrementally, metrics are collected and evaluated at each increment, and the rollout proceeds only when success criteria are satisfied. This transforms a binary deploy/rollback decision into a continuous confidence-building process.

<!--more-->

## Architecture Overview

Flagger operates as a Kubernetes operator. It watches `Canary` custom resources, manages shadow deployments, and integrates with traffic routing providers (Istio, Linkerd, Contour, NGINX, AWS App Mesh) to shift traffic between the primary and canary deployments.

The lifecycle of a Flagger-managed deployment:

1. A new image tag is applied to the target Deployment.
2. Flagger creates a canary Deployment (the new version) and a primary Deployment (the current stable version).
3. Traffic is sent to primary by default. When a change is detected, the canary receives an initial traffic weight (e.g., 5%).
4. At each analysis interval, Flagger queries Prometheus (or Datadog, CloudWatch, etc.) for success rate and latency metrics.
5. If all metrics pass, traffic weight increases by the configured step size.
6. If any metric fails its threshold, Flagger rolls back: sets canary traffic to 0% and reverts the primary Deployment to the original image.
7. If the canary reaches 100% traffic and all checks pass, the primary is updated to the new image and the canary is scaled down.

## Installation

```bash
# Add the Flagger Helm repository.
helm repo add flagger https://flagger.app
helm repo update

# Install Flagger with Istio provider.
helm upgrade --install flagger flagger/flagger \
  --namespace istio-system \
  --set meshProvider=istio \
  --set metricsServer=http://prometheus-operated.monitoring:9090 \
  --set slack.url=https://hooks.slack.com/services/<WORKSPACE_ID>/<CHANNEL_ID>/<WEBHOOK_TOKEN> \
  --set slack.channel=deployments \
  --set slack.user=flagger \
  --set logLevel=info \
  --version 1.37.0

# Verify Flagger is running.
kubectl -n istio-system rollout status deployment/flagger

# Install Flagger's Prometheus integration for Istio metrics.
helm upgrade --install flagger-prometheus flagger/prometheus \
  --namespace istio-system
```

## Canary Resource Configuration

The `Canary` resource is Flagger's primary configuration object. It references the target Deployment, defines the analysis parameters, and configures the traffic routing.

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: payment-api
  namespace: production
spec:
  # Target Deployment to progressively deliver.
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payment-api

  # Automatically promote HPA changes.
  autoscalerRef:
    apiVersion: autoscaling/v2
    kind: HorizontalPodAutoscaler
    name: payment-api

  # Kubernetes service configuration — Flagger will manage this Service.
  service:
    port: 8080
    targetPort: 8080
    portName: http
    gateways:
    - public-gateway.istio-system.svc.cluster.local
    hosts:
    - api.payments.example.com
    trafficPolicy:
      tls:
        mode: ISTIO_MUTUAL
    retries:
      attempts: 3
      perTryTimeout: 5s
      retryOn: "gateway-error,connect-failure,refused-stream"

  analysis:
    # How often to run the analysis step.
    interval: 1m
    # Number of failed analysis runs before rollback.
    threshold: 5
    # Maximum traffic weight the canary will receive.
    maxWeight: 50
    # Traffic step increment at each successful analysis.
    stepWeight: 10
    # Minimum weight at initial canary rollout.
    # Useful for warming up caches before running analysis.
    stepWeightPromotion: 0

    # Prometheus-based metrics analysis.
    metrics:
    - name: request-success-rate
      # Built-in metric from Flagger's Prometheus queries.
      templateRef:
        name: request-success-rate
        namespace: flagger-system
      thresholdRange:
        min: 99.5
      interval: 1m

    - name: request-duration
      templateRef:
        name: request-duration
        namespace: flagger-system
      # P99 latency must stay below 500ms.
      thresholdRange:
        max: 500
      interval: 1m

    # Custom business metric: payment success rate.
    - name: payment-success-rate
      templateRef:
        name: payment-success-rate
        namespace: production
      thresholdRange:
        min: 99.0
      interval: 2m

    # Webhooks for pre-rollout validation and load testing.
    webhooks:
    - name: smoke-test
      type: pre-rollout
      url: http://flagger-loadtester.production/
      timeout: 30s
      metadata:
        type: bash
        cmd: "curl -s http://payment-api-canary.production/healthz | grep 'ok'"

    - name: load-test
      url: http://flagger-loadtester.production/
      timeout: 5s
      metadata:
        type: cmd
        cmd: "hey -z 2m -q 50 -c 5 http://payment-api-canary.production:8080/api/v1/health"

    - name: acceptance-test
      type: pre-rollout
      url: http://flagger-loadtester.production/
      timeout: 60s
      metadata:
        type: bash
        cmd: |
          curl -sf http://payment-api-canary.production:8080/api/v1/version | \
            python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if int(d['build']) > 0 else 1)"

    - name: notify-on-rollback
      type: rollback
      url: https://hooks.slack.com/services/<WORKSPACE_ID>/<CHANNEL_ID>/<WEBHOOK_TOKEN>
      metadata:
        text: "Canary rollback triggered for payment-api"
```

## Custom Metric Templates

Flagger's built-in metrics cover common Istio/Linkerd signal sources, but production deployments frequently need business-level metrics that combine application-specific Prometheus metrics with Flagger's traffic-weighting metadata.

```yaml
apiVersion: flagger.app/v1beta1
kind: MetricTemplate
metadata:
  name: payment-success-rate
  namespace: production
spec:
  provider:
    type: prometheus
    address: http://prometheus-operated.monitoring:9090
  query: |
    100 - (
      sum(
        rate(
          payment_transactions_total{
            status="failed",
            namespace="{{ namespace }}",
            pod=~"{{ target }}-[0-9a-z]+-[0-9a-z]+"
          }[{{ interval }}]
        )
      )
      /
      sum(
        rate(
          payment_transactions_total{
            namespace="{{ namespace }}",
            pod=~"{{ target }}-[0-9a-z]+-[0-9a-z]+"
          }[{{ interval }}]
        )
      )
    ) * 100
```

```yaml
# Database connection pool saturation — canary must not degrade DB connectivity.
apiVersion: flagger.app/v1beta1
kind: MetricTemplate
metadata:
  name: db-connection-saturation
  namespace: production
spec:
  provider:
    type: prometheus
    address: http://prometheus-operated.monitoring:9090
  query: |
    max(
      pg_pool_connections_active{
        namespace="{{ namespace }}",
        pod=~"{{ target }}-[0-9a-z]+-[0-9a-z]+"
      }
      /
      pg_pool_connections_max{
        namespace="{{ namespace }}",
        pod=~"{{ target }}-[0-9a-z]+-[0-9a-z]+"
      }
    ) * 100
```

## Alert Templates

```yaml
apiVersion: flagger.app/v1beta1
kind: AlertProvider
metadata:
  name: pagerduty
  namespace: production
spec:
  type: pagerduty
  secretRef:
    name: pagerduty-token
---
apiVersion: v1
kind: Secret
metadata:
  name: pagerduty-token
  namespace: production
type: Opaque
stringData:
  token: "rk_prod_xxxxxxxxxxxxxxxxxxxx"
```

Attach the alert provider to the Canary spec:

```yaml
# Within the Canary spec.analysis block:
    alerts:
    - name: "production-alerts"
      severity: warn
      providerRef:
        name: pagerduty
        namespace: production
```

## A/B Testing with Header-Based Routing

Flagger supports A/B testing, where traffic routing is based on HTTP headers rather than weights. This enables targeted rollouts to specific user segments.

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: frontend-ab-test
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: frontend
  service:
    port: 80
    targetPort: 8080
  analysis:
    interval: 1m
    threshold: 10
    iterations: 10
    match:
    # Route traffic with this header to the canary.
    - headers:
        x-canary:
          exact: "true"
    - headers:
        cookie:
          regex: "^(.*; )?canary=true(;.*)?$"
    metrics:
    - name: request-success-rate
      templateRef:
        name: request-success-rate
        namespace: flagger-system
      thresholdRange:
        min: 99.0
      interval: 1m
    webhooks:
    - name: integration-tests
      type: pre-rollout
      url: http://flagger-loadtester.production/
      timeout: 120s
      metadata:
        type: bash
        cmd: "cd /tmp && git clone https://github.com/example/e2e-tests && cd e2e-tests && go test ./... -run TestCanary -v"
```

## Blue-Green Deployments with Flagger

For deployments where progressive traffic shift is not desired — such as schema migrations or breaking API changes — Flagger supports blue-green mode.

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
    port: 443
    targetPort: 8443
  analysis:
    # Blue-green: run analysis for 5 iterations before promoting.
    interval: 30s
    threshold: 2
    iterations: 5
    metrics:
    - name: request-success-rate
      templateRef:
        name: request-success-rate
        namespace: flagger-system
      thresholdRange:
        min: 99.9
      interval: 30s
    webhooks:
    - name: full-stack-tests
      type: pre-rollout
      url: http://flagger-loadtester.production/
      timeout: 180s
      metadata:
        type: bash
        cmd: |
          pytest /opt/tests/acceptance/ \
            --base-url http://api-gateway-canary.production \
            --junit-xml /tmp/test-results.xml \
            -v --tb=short
```

## GitOps Integration with Flux

```yaml
# Flux Kustomization that manages Flagger Canary resources.
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: production-canaries
  namespace: flux-system
spec:
  interval: 5m
  sourceRef:
    kind: GitRepository
    name: platform-config
  path: ./clusters/production/canaries
  prune: true
  healthChecks:
  - apiVersion: flagger.app/v1beta1
    kind: Canary
    name: payment-api
    namespace: production
  timeout: 10m
  # Post-build substitution allows the CI system to inject the image tag.
  postBuild:
    substitute:
      PAYMENT_API_IMAGE_TAG: "v2.14.7"
```

## Monitoring Canary State

```bash
# Watch canary progress.
watch kubectl -n production describe canary payment-api

# Check canary status across all namespaces.
kubectl get canaries -A

# View Flagger events for a specific canary.
kubectl -n production get events \
  --field-selector involvedObject.name=payment-api,involvedObject.kind=Canary \
  --sort-by='.lastTimestamp'

# Manually trigger a rollback (sets the failed annotation).
kubectl -n production annotate canary/payment-api flagger.app/manual-rollback=true

# Manually promote a canary that is paused (e.g., at a manual approval gate).
kubectl -n production label canary/payment-api flagger.app/manual-gate=open

# View the VirtualService Flagger is managing.
kubectl -n production get virtualservice payment-api -o yaml | \
  grep -A 20 'spec:'
```

## Prometheus Dashboards for Canary Analysis

```yaml
# ConfigMap for a Grafana dashboard tracking Flagger canary health.
apiVersion: v1
kind: ConfigMap
metadata:
  name: flagger-canary-dashboard
  namespace: monitoring
  labels:
    grafana_dashboard: "1"
data:
  flagger-canary.json: |
    {
      "title": "Flagger Canary Analysis",
      "panels": [
        {
          "title": "Canary Traffic Weight",
          "targets": [{
            "expr": "flagger_canary_weight{namespace=\"production\"}"
          }]
        },
        {
          "title": "Canary Request Success Rate",
          "targets": [{
            "expr": "rate(istio_requests_total{reporter=\"destination\",destination_workload=~\".*-canary\",response_code!~\"5..\"}[1m]) / rate(istio_requests_total{reporter=\"destination\",destination_workload=~\".*-canary\"}[1m])"
          }]
        },
        {
          "title": "Canary P99 Latency",
          "targets": [{
            "expr": "histogram_quantile(0.99, sum(rate(istio_request_duration_milliseconds_bucket{reporter=\"destination\",destination_workload=~\".*-canary\"}[1m])) by (le))"
          }]
        }
      ]
    }
```

Flagger transforms Kubernetes deployments from binary events into measured, evidence-based processes. By encoding analysis criteria in version-controlled configuration, teams gain reproducible progressive delivery pipelines that automatically protect production from regressions — without requiring manual monitoring during each rollout.
