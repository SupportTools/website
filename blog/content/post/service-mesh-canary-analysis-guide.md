---
title: "Service Mesh Canary Analysis: Automated Rollback with Prometheus Metrics"
date: 2028-03-08T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Flagger", "Canary", "Istio", "Prometheus", "Service Mesh", "Progressive Delivery"]
categories: ["Kubernetes", "Progressive Delivery"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to automated canary analysis with Flagger, covering metric templates for P99 latency and error rates, webhook gates, Istio VirtualService traffic shifting, automated rollback, and A/B testing patterns."
more_link: "yes"
url: "/service-mesh-canary-analysis-guide/"
---

Manual canary deployments create operational risk: engineers must monitor dashboards, make subjective calls on whether metrics look acceptable, and execute rollbacks under pressure. Flagger automates this process by continuously querying Prometheus (or Datadog, InfluxDB, Graphite) during a canary promotion, comparing against threshold-based metric templates, and triggering automatic rollback when service level objectives are violated. This guide covers the full Flagger implementation stack on top of Istio.

<!--more-->

## Architecture Overview

Flagger extends Kubernetes with a `Canary` CRD and a controller that orchestrates the promotion lifecycle:

```
┌─────────────────────────────────────────────────────────────────┐
│                        Kubernetes Cluster                       │
│                                                                 │
│  ┌──────────────┐     ┌───────────────────────────────────────┐  │
│  │   Flagger    │────▶│  VirtualService (Istio)               │  │
│  │  controller  │     │  weight: primary=95, canary=5         │  │
│  └──────┬───────┘     └───────────────────────────────────────┘  │
│         │                                                        │
│    metric queries                  traffic split                 │
│         │                               │                       │
│  ┌──────▼────────┐    ┌────────────┐   ┌▼──────────────────────┐ │
│  │  Prometheus   │    │  primary   │   │  canary               │ │
│  │  (metrics)    │    │  (stable)  │   │  (new version)        │ │
│  └───────────────┘    └────────────┘   └───────────────────────┘ │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │  Canary CR: analysis interval, step weight, metric thresholds│ │
│  └──────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## Installing Flagger with Istio

```bash
# Add Flagger Helm repo
helm repo add flagger https://flagger.app
helm repo update

# Install Flagger CRDs
kubectl apply -f https://raw.githubusercontent.com/fluxcd/flagger/main/artifacts/flagger/crd.yaml

# Install Flagger with Istio provider
helm install flagger flagger/flagger \
  --namespace istio-system \
  --set meshProvider=istio \
  --set metricsServer=http://prometheus-operated.monitoring.svc.cluster.local:9090 \
  --set slack.url="" \
  --set slack.channel="" \
  --set podMonitor.enabled=true \
  --set resources.requests.cpu=10m \
  --set resources.requests.memory=32Mi

# Install Flagger load tester (for webhook-based traffic generation during analysis)
helm install flagger-loadtester flagger/loadtester \
  --namespace test \
  --set cmd.timeout=1h
```

## Canary Resource Definition

### Basic Canary with P99 Latency and Error Rate Analysis

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: checkout-service
  namespace: production
spec:
  # Reference the Deployment being managed
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: checkout-service

  # Progressive traffic shifting via Istio
  progressDeadlineSeconds: 3600

  service:
    port: 8080
    targetPort: 8080
    gateways:
      - public-gateway.istio-system.svc.cluster.local
    hosts:
      - checkout.example.com
    trafficPolicy:
      tls:
        mode: ISTIO_MUTUAL
    retries:
      attempts: 3
      perTryTimeout: 30s
      retryOn: "gateway-error,connect-failure,refused-stream"

  analysis:
    # Duration between metric checks
    interval: 1m
    # Number of successful checks required before promoting
    threshold: 10
    # Maximum number of failed metric checks before rollback
    maxWeight: 50
    # Step size for traffic shifting per interval
    stepWeight: 10
    # Minimum traffic weight to start analysis at
    stepWeightPromotion: 100

    metrics:
      - name: request-success-rate
        # Minimum success rate (non-5xx responses) threshold
        thresholdRange:
          min: 99
        interval: 1m

      - name: request-duration
        # Maximum P99 latency threshold in milliseconds
        thresholdRange:
          max: 500
        interval: 1m

    webhooks:
      - name: load-test
        url: http://flagger-loadtester.test/
        timeout: 5s
        metadata:
          type: cmd
          cmd: "hey -z 1m -q 10 -c 2 http://checkout-service-canary.production:8080/health"

      - name: acceptance-test
        type: pre-rollout
        url: http://flagger-loadtester.test/
        timeout: 30s
        metadata:
          type: bash
          cmd: "curl -sd 'test' http://checkout-service-canary.production:8080/readyz | grep OK"

      - name: smoke-test
        type: rollout
        url: http://flagger-loadtester.test/
        timeout: 15s
        metadata:
          type: bash
          cmd: |
            curl -s http://checkout-service-canary.production:8080/health | \
              python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d['status']=='healthy' else 1)"
```

## Custom Metric Templates

### P99 Latency Metric Template

```yaml
apiVersion: flagger.app/v1beta1
kind: MetricTemplate
metadata:
  name: latency-p99
  namespace: production
spec:
  provider:
    type: prometheus
    address: http://prometheus-operated.monitoring.svc.cluster.local:9090
  query: |
    histogram_quantile(
      0.99,
      sum(
        rate(
          istio_request_duration_milliseconds_bucket{
            destination_workload_namespace="{{ namespace }}",
            destination_workload=~"{{ target }}"
          }[{{ interval }}]
        )
      ) by (le)
    )
```

### Error Rate Metric Template

```yaml
apiVersion: flagger.app/v1beta1
kind: MetricTemplate
metadata:
  name: error-rate
  namespace: production
spec:
  provider:
    type: prometheus
    address: http://prometheus-operated.monitoring.svc.cluster.local:9090
  query: |
    100 - (
      sum(
        rate(
          istio_requests_total{
            destination_workload_namespace="{{ namespace }}",
            destination_workload=~"{{ target }}",
            response_code!~"5.*"
          }[{{ interval }}]
        )
      )
      /
      sum(
        rate(
          istio_requests_total{
            destination_workload_namespace="{{ namespace }}",
            destination_workload=~"{{ target }}"
          }[{{ interval }}]
        )
      ) * 100
    )
```

### Database Connection Pool Exhaustion Metric

```yaml
apiVersion: flagger.app/v1beta1
kind: MetricTemplate
metadata:
  name: db-pool-saturation
  namespace: production
spec:
  provider:
    type: prometheus
    address: http://prometheus-operated.monitoring.svc.cluster.local:9090
  query: |
    max(
      db_pool_connections_active{
        namespace="{{ namespace }}",
        workload="{{ target }}"
      }
      /
      db_pool_connections_max{
        namespace="{{ namespace }}",
        workload="{{ target }}"
      }
    ) * 100
```

### Using Custom Metrics in a Canary

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
  analysis:
    interval: 2m
    threshold: 5
    maxWeight: 30
    stepWeight: 5
    metrics:
      - name: error-rate
        templateRef:
          name: error-rate
          namespace: production
        thresholdRange:
          max: 1.0
        interval: 2m

      - name: latency-p99
        templateRef:
          name: latency-p99
          namespace: production
        thresholdRange:
          max: 300
        interval: 2m

      - name: db-pool-saturation
        templateRef:
          name: db-pool-saturation
          namespace: production
        thresholdRange:
          max: 80
        interval: 2m
```

## Webhook Gates for Integration Tests

### Pre-Rollout Webhook (Runs Before Traffic Shifting)

```yaml
webhooks:
  - name: integration-test-gate
    type: pre-rollout
    url: http://flagger-loadtester.test/
    timeout: 120s
    metadata:
      type: bash
      cmd: |
        set -euo pipefail

        # Run integration test suite against canary
        CANARY_URL="http://checkout-service-canary.production:8080"

        # Test 1: Health check
        HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${CANARY_URL}/health")
        [ "${HTTP_CODE}" = "200" ] || (echo "Health check failed: ${HTTP_CODE}" && exit 1)

        # Test 2: API contract
        RESPONSE=$(curl -s -X POST "${CANARY_URL}/api/v1/orders" \
          -H "Content-Type: application/json" \
          -d '{"items":[{"sku":"TEST-001","qty":1}],"currency":"USD"}')
        echo "${RESPONSE}" | python3 -c "
        import sys, json
        d = json.load(sys.stdin)
        assert 'order_id' in d, f'Missing order_id in response: {d}'
        assert d.get('status') in ('pending','created'), f'Unexpected status: {d}'
        print('Integration test passed')
        "
```

### Rollout Webhook (Runs During Each Analysis Interval)

```yaml
webhooks:
  - name: performance-gate
    type: rollout
    url: http://flagger-loadtester.test/
    timeout: 30s
    metadata:
      type: bash
      cmd: |
        # Verify canary is not consuming excessive memory
        CANARY_POD=$(kubectl get pods -n production \
          -l app=checkout-service,flagger.app/component=canary \
          -o jsonpath='{.items[0].metadata.name}')

        MEM_USAGE=$(kubectl top pod "${CANARY_POD}" -n production \
          --no-headers | awk '{print $3}' | tr -d 'Mi')

        MAX_MEM=512
        if [ "${MEM_USAGE}" -gt "${MAX_MEM}" ]; then
          echo "Memory usage ${MEM_USAGE}Mi exceeds limit ${MAX_MEM}Mi"
          exit 1
        fi
        echo "Memory check passed: ${MEM_USAGE}Mi"
```

### Post-Rollout Webhook (Runs After Successful Promotion)

```yaml
webhooks:
  - name: notify-promotion
    type: post-rollout
    url: http://flagger-loadtester.test/
    timeout: 30s
    metadata:
      type: bash
      cmd: |
        # Record deployment event in CMDB
        curl -s -X POST "https://cmdb.internal/api/deployments" \
          -H "Content-Type: application/json" \
          -d "{
            \"service\": \"checkout-service\",
            \"namespace\": \"production\",
            \"event\": \"canary-promoted\",
            \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"
          }"

  - name: notify-rollback
    type: rollback
    url: http://flagger-loadtester.test/
    timeout: 30s
    metadata:
      type: bash
      cmd: |
        curl -s -X POST "https://cmdb.internal/api/deployments" \
          -H "Content-Type: application/json" \
          -d "{
            \"service\": \"checkout-service\",
            \"namespace\": \"production\",
            \"event\": \"canary-rolled-back\",
            \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"
          }"
```

## Istio VirtualService Traffic Shifting

Flagger manages the `VirtualService` automatically, but the structure is worth understanding for debugging:

```yaml
# This is managed by Flagger — shown for reference
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: checkout-service
  namespace: production
spec:
  gateways:
    - public-gateway.istio-system.svc.cluster.local
    - mesh
  hosts:
    - checkout-service
    - checkout.example.com
  http:
    - match:
        - headers:
            x-canary:
              exact: "true"
      route:
        - destination:
            host: checkout-service-canary
            port:
              number: 8080
          weight: 100
    - route:
        - destination:
            host: checkout-service-primary
            port:
              number: 8080
          weight: 90  # Updated by Flagger each interval
        - destination:
            host: checkout-service-canary
            port:
              number: 8080
          weight: 10  # Increases by stepWeight each interval
```

Monitor traffic shifting progress:

```bash
# Watch Canary status in real time
watch -n 5 'kubectl describe canary checkout-service -n production | \
  grep -E "(Status|Weight|Phase|Message|Step)"'

# Follow Flagger controller logs
kubectl logs -n istio-system \
  -l app.kubernetes.io/name=flagger \
  --tail=100 \
  -f | grep checkout-service
```

## Automated Rollback Triggers

Flagger automatically rolls back when:

1. A metric threshold is exceeded for `threshold` consecutive intervals
2. A webhook gate returns a non-2xx HTTP status
3. The canary pod fails its readiness probe
4. The `progressDeadlineSeconds` is reached without completion

Manual rollback trigger:

```bash
# Annotate the Canary to force rollback
kubectl annotate canary checkout-service -n production \
  flagger.app/rollback=true \
  --overwrite

# Or set max failed checks to 0 temporarily
kubectl patch canary checkout-service -n production \
  --type=json \
  -p='[{"op":"replace","path":"/spec/analysis/threshold","value":0}]'
```

### Rollback Detection Event Monitoring

```yaml
# Alert on Flagger rollback events
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: flagger-alerts
  namespace: monitoring
spec:
  groups:
    - name: flagger
      rules:
        - alert: FlaggerCanaryRollback
          expr: |
            increase(flagger_canary_total{phase="Failed"}[10m]) > 0
          for: 1m
          labels:
            severity: warning
          annotations:
            summary: "Flagger canary rollback in {{ $labels.namespace }}/{{ $labels.workload }}"
            description: "Canary deployment rolled back due to metric threshold violations."

        - alert: FlaggerCanaryProgressing
          expr: |
            flagger_canary_status{phase="Progressing"} == 1
          for: 30m
          labels:
            severity: info
          annotations:
            summary: "Flagger canary progressing for 30+ minutes"
```

## Slack and PagerDuty Notifications

### Slack Notifications

```bash
helm upgrade flagger flagger/flagger \
  --namespace istio-system \
  --set slack.url=https://hooks.slack.com/services/PLACEHOLDER/PLACEHOLDER/PLACEHOLDER \
  --set slack.channel=deployments \
  --set slack.username=flagger
```

The Slack webhook URL should be stored in a Kubernetes Secret and referenced by Flagger, not embedded in Helm values for production deployments:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: flagger-slack-token
  namespace: istio-system
type: Opaque
stringData:
  address: "REPLACE_WITH_ACTUAL_WEBHOOK_URL"
---
apiVersion: flagger.app/v1beta1
kind: AlertProvider
metadata:
  name: slack
  namespace: production
spec:
  type: slack
  channel: deployments
  username: flagger
  secretRef:
    name: flagger-slack-token
```

Reference the alert provider from the Canary:

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: checkout-service
  namespace: production
spec:
  # ... other fields ...
  analysis:
    # ... analysis config ...
    alerts:
      - name: "slack deployment"
        severity: info
        providerRef:
          name: slack
          namespace: production
      - name: "pagerduty on rollback"
        severity: error
        providerRef:
          name: pagerduty
          namespace: production
```

### PagerDuty Alert Provider

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: flagger-pagerduty-token
  namespace: production
type: Opaque
stringData:
  token: "REPLACE_WITH_PAGERDUTY_INTEGRATION_KEY"
---
apiVersion: flagger.app/v1beta1
kind: AlertProvider
metadata:
  name: pagerduty
  namespace: production
spec:
  type: pagerduty
  secretRef:
    name: flagger-pagerduty-token
```

## A/B Testing vs Canary Deployment

### When to Use Each

| Pattern | Traffic Split | Analysis Basis | Use Case |
|---|---|---|---|
| Canary | Progressive 0→100% | SLI metrics (error rate, latency) | Performance validation of new version |
| A/B test | Fixed split (50/50) | Business metrics (conversion, revenue) | Feature experiment across user segments |
| Blue/Green | Instant switch | Pre-switch smoke tests | Zero-downtime deployment with instant rollback |
| Shadow | Mirrored (no user impact) | Comparison of request/response | Testing against production traffic without risk |

### A/B Testing Configuration

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: checkout-ab-test
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: checkout-service
  service:
    port: 8080
    headers:
      request:
        add:
          x-ab-experiment: "checkout-v2"
  analysis:
    interval: 1h
    threshold: 3
    iterations: 10
    match:
      # Route users in experiment group to canary
      - headers:
          x-user-segment:
            regex: "^(enterprise|premium)$"
    metrics:
      - name: conversion-rate
        templateRef:
          name: conversion-rate
          namespace: production
        thresholdRange:
          min: 3.5  # minimum 3.5% conversion rate
        interval: 1h
---
apiVersion: flagger.app/v1beta1
kind: MetricTemplate
metadata:
  name: conversion-rate
  namespace: production
spec:
  provider:
    type: prometheus
    address: http://prometheus-operated.monitoring.svc.cluster.local:9090
  query: |
    sum(
      rate(
        business_checkout_completed_total{
          namespace="{{ namespace }}",
          workload="{{ target }}"
        }[{{ interval }}]
      )
    )
    /
    sum(
      rate(
        business_checkout_initiated_total{
          namespace="{{ namespace }}",
          workload="{{ target }}"
        }[{{ interval }}]
      )
    ) * 100
```

## Shadow Deployment (Traffic Mirroring)

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: payment-processor-shadow
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payment-processor
  service:
    port: 8080
  analysis:
    interval: 1m
    threshold: 5
    mirror: true           # Enable traffic mirroring
    mirrorWeight: 100      # Mirror 100% of traffic (no weight to canary in response path)
    maxWeight: 0           # Never promote automatically — manual review required
    stepWeight: 0
    metrics:
      - name: error-rate
        templateRef:
          name: error-rate
          namespace: production
        thresholdRange:
          max: 0.5
        interval: 1m
```

## Observability for Canary Deployments

Flagger exposes Prometheus metrics for dashboards:

```promql
# Canary promotion phase (0=Initialized, 1=Waiting, 2=Progressing, 3=Promoting, 4=Finalising, 5=Succeeded, 6=Failed)
flagger_canary_status

# Current canary weight
flagger_canary_weight

# Duration of last successful analysis
flagger_canary_duration_seconds

# Number of rollbacks in the past hour
sum(increase(flagger_canary_total{phase="Failed"}[1h])) by (workload, namespace)
```

Grafana dashboard query for canary progress visualization:

```promql
# Traffic distribution over time
sum by (destination_workload, response_code_class) (
  rate(istio_requests_total{
    destination_workload_namespace="production",
    destination_workload=~"checkout-service.*"
  }[5m])
)
```

## Operational Checklist

Before enabling Flagger for a production service:

```bash
# 1. Verify Istio sidecar injection is enabled for the namespace
kubectl get namespace production -o jsonpath='{.metadata.labels.istio-injection}'

# 2. Verify Prometheus is scraping Istio metrics
curl -s http://prometheus:9090/api/v1/query \
  --data-urlencode 'query=istio_requests_total{destination_workload="checkout-service"}' | \
  jq '.data.result | length'

# 3. Verify the Deployment has enough replicas for safe canary (min 2)
kubectl get deployment checkout-service -n production -o jsonpath='{.spec.replicas}'

# 4. Verify PodDisruptionBudget exists
kubectl get pdb -n production | grep checkout-service

# 5. Check Flagger controller is ready
kubectl get pods -n istio-system -l app.kubernetes.io/name=flagger

# 6. Validate Canary resource
kubectl get canary checkout-service -n production
```

## Multi-Cluster Canary Deployment

For organizations running multiple Kubernetes clusters, Flagger can orchestrate canary deployments across cluster boundaries using an external load balancer such as AWS ALB or Cloudflare Workers.

### Cross-Cluster Traffic Shifting with Flagger and Argo Rollouts

When Flagger is not sufficient for multi-cluster scenarios, Argo Rollouts provides a complementary approach. The two tools can coexist in an organization — Flagger for per-service in-cluster canary automation and Argo Rollouts for cluster-level traffic shifting.

```yaml
# Argo Rollout for cross-cluster canary
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: checkout-service
  namespace: production
spec:
  replicas: 10
  strategy:
    canary:
      maxSurge: "25%"
      maxUnavailable: 0
      steps:
        - setWeight: 5
        - pause:
            duration: 5m
        - analysis:
            templates:
              - templateName: error-rate-check
            args:
              - name: service-name
                value: checkout-service
        - setWeight: 25
        - pause:
            duration: 10m
        - setWeight: 50
        - pause:
            duration: 10m
        - setWeight: 100
      analysis:
        startingStep: 2
      trafficRouting:
        istio:
          virtualService:
            name: checkout-service
            routes:
              - primary
          destinationRule:
            name: checkout-service
            canarySubsetName: canary
            stableSubsetName: stable
```

## Flagger with AWS App Mesh

For teams running on AWS, Flagger supports App Mesh as an alternative to Istio:

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: checkout-service
  namespace: production
spec:
  provider: appmesh
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: checkout-service
  service:
    port: 8080
    backends:
      - checkout-service
    meshName: global
    virtualService:
      annotations:
        appmesh.k8s.aws/virtualServiceRef: checkout-service
  analysis:
    interval: 1m
    threshold: 10
    maxWeight: 50
    stepWeight: 10
    metrics:
      - name: request-success-rate
        thresholdRange:
          min: 99
        interval: 1m
      - name: request-duration
        thresholdRange:
          max: 500
        interval: 1m
```

## Canary Deployment for Database Schema Changes

Canary deployments become more complex when the new version requires a database schema change. The standard approach is:

1. **Phase 1**: Deploy a migration that adds new columns/tables but does not remove old ones. Both old and new application versions read and write successfully.
2. **Phase 2**: Run the canary — new version uses new schema, old version uses old schema. Both work simultaneously.
3. **Phase 3**: After full promotion, run a cleanup migration removing deprecated columns.

```yaml
# Init container runs migration before new version starts
spec:
  initContainers:
    - name: migrate
      image: flyway/flyway:10-alpine
      command:
        - flyway
        - -url=jdbc:postgresql://postgres:5432/orders
        - -locations=filesystem:/migrations/backwards-compatible
        - migrate
      env:
        - name: FLYWAY_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-credentials
              key: password
```

## Configuring Flagger for Low-Traffic Services

Canary analysis requires sufficient traffic to generate statistically meaningful metrics. For low-traffic services, configure Flagger to use synthetic load:

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: admin-service
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: admin-service
  service:
    port: 8080
  analysis:
    interval: 2m
    threshold: 5
    maxWeight: 50
    stepWeight: 10
    # Generate synthetic traffic since real traffic is low
    webhooks:
      - name: synthetic-load
        type: rollout
        url: http://flagger-loadtester.test/
        timeout: 120s
        metadata:
          type: cmd
          cmd: |
            hey -z 2m -q 5 -c 2 \
              http://admin-service-canary.production:8080/api/v1/health
      - name: synthetic-functional-test
        type: rollout
        url: http://flagger-loadtester.test/
        timeout: 60s
        metadata:
          type: bash
          cmd: |
            for i in $(seq 1 10); do
              curl -sf http://admin-service-canary.production:8080/api/v1/status \
                -H "Authorization: Bearer ${ADMIN_TOKEN}" || exit 1
              sleep 5
            done
    metrics:
      - name: request-success-rate
        thresholdRange:
          min: 99
        interval: 2m
```

## Flagger Canary Pause and Resume

For manual gate checks (change advisory board approval, external audit), Flagger supports manual pause and resume:

```bash
# Pause a canary promotion for manual inspection
kubectl annotate canary checkout-service \
  -n production \
  flagger.app/manual-gate=halt \
  --overwrite

# Inspect metrics and logs manually
kubectl exec -n production \
  $(kubectl get pods -n production -l app=checkout-service,flagger.app/component=canary \
    -o jsonpath='{.items[0].metadata.name}') \
  -- curl -s http://localhost:9090/metrics | grep http_requests

# Resume after approval
kubectl annotate canary checkout-service \
  -n production \
  flagger.app/manual-gate=open \
  --overwrite
```

## Summary

Flagger transforms risky manual deployments into automated, metric-driven promotion workflows. The combination of Istio's fine-grained traffic management, Prometheus metric templates for SLI-based analysis, and webhook gates for integration test enforcement creates a system that can promote dozens of services per day while automatically protecting production from degraded versions. The A/B testing and shadow deployment modes extend this framework to business-metric experiments and production traffic validation without user impact. Cross-cluster scenarios, database migration coordination, and low-traffic service handling require additional patterns beyond the basic Flagger setup, but remain expressible within the same CRD-driven framework.
