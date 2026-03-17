---
title: "Kubernetes Canary Deployments with Flagger: Automated Analysis, Traffic Shifting, and Rollback"
date: 2031-09-15T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Flagger", "Canary Deployments", "Progressive Delivery", "Istio", "Service Mesh", "GitOps"]
categories:
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to implementing automated canary deployments with Flagger, covering traffic shifting strategies, metric analysis, webhook integration, and rollback automation with Istio and NGINX Ingress."
more_link: "yes"
url: "/kubernetes-canary-deployments-flagger-automated-analysis-traffic-shifting-rollback/"
---

Canary deployments reduce deployment risk by routing a small percentage of production traffic to the new version before promoting it fully. Done manually, this is error-prone and requires constant attention. Flagger automates the entire lifecycle: it shifts traffic incrementally, evaluates metrics at each step using configurable analysis thresholds, and automatically rolls back if the canary fails — all without human intervention.

This guide covers Flagger's architecture and installation, canary configuration for both Istio and NGINX Ingress, metric analysis with Prometheus, webhook integration for testing gates, and the operational patterns that make automated canary releases reliable at scale.

<!--more-->

# Kubernetes Canary Deployments with Flagger

## Why Automated Canary Deployments

Traditional rolling deployments switch 100% of traffic to the new version as pods are replaced. If the new version has a subtle bug — a memory leak, a degraded API, a slow database query — it affects all users before anyone can react.

Canary deployments route only a fraction of traffic (e.g., 5%) to the new version. If the new version performs identically to the old one across key metrics (error rate, latency), traffic is gradually shifted until 100% of traffic goes to the new version. At any point, if metrics degrade, traffic shifts back to the old version automatically.

Flagger extends this with:
- **Multiple traffic providers**: Istio, Linkerd, App Mesh, NGINX Ingress, Contour, Gloo
- **Multiple metric providers**: Prometheus, Datadog, New Relic, CloudWatch
- **Conformance testing webhooks**: run load tests or integration tests during the canary
- **A/B testing and Blue/Green**: not just canary; Flagger supports multiple deployment strategies

## Architecture

```
                    Flagger Controller
                           │
                           │ watches
                           ▼
                    [ Canary CRD ]
                           │
                    ┌──────┴──────┐
                    │             │
               primary        canary
             [ Deployment ] [ Deployment ]   ← Flagger manages both
                    │             │
                    └──────┬──────┘
                           │
                    [ VirtualService ]        ← Traffic weight
                    [ DestinationRule ]       ← (Istio)
                           │
                    ┌──────┴──────┐
                    │             │
              Primary Pods    Canary Pods     ← Traffic split
              (90% traffic)  (10% traffic)
```

Flagger does not modify your original Deployment. Instead, it creates a mirrored "primary" Deployment (the stable version) and manages traffic weight between primary and canary (your original Deployment which Flagger drives to 0 replicas when not in use).

## Installation

### With Istio

```bash
# Add Flagger Helm repository
helm repo add flagger https://flagger.app
helm repo update

# Install Flagger in istio-system namespace
helm upgrade -i flagger flagger/flagger \
    --namespace=istio-system \
    --set crd.create=true \
    --set meshProvider=istio \
    --set metricsServer=http://prometheus.istio-system.svc:9090

# Install Flagger load tester (for conformance testing webhooks)
helm upgrade -i flagger-loadtester flagger/loadtester \
    --namespace=test \
    --set cmd.timeout=1h
```

### With NGINX Ingress

```bash
# Install Flagger with NGINX provider
helm upgrade -i flagger flagger/flagger \
    --namespace=ingress-nginx \
    --set crd.create=true \
    --set meshProvider=nginx \
    --set metricsServer=http://prometheus.monitoring.svc:9090

# Install Flagger Grafana dashboards
helm upgrade -i flagger-grafana flagger/grafana \
    --namespace=monitoring \
    --set url=http://prometheus.monitoring.svc:9090
```

### RBAC Requirements

```yaml
# ClusterRole for Flagger
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: flagger
rules:
  - apiGroups: [""]
    resources:
      - events
      - configmaps
      - secrets
      - services
    verbs: ["*"]
  - apiGroups: ["apps"]
    resources:
      - deployments
    verbs: ["*"]
  - apiGroups: ["flagger.app"]
    resources:
      - canaries
      - canaries/status
      - metrictemplates
      - alertproviders
    verbs: ["*"]
  - apiGroups: ["networking.istio.io"]
    resources:
      - virtualservices
      - destinationrules
    verbs: ["*"]
```

## Basic Canary Configuration

### Minimal Canary with Istio

First, your application Deployment:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  namespace: payments
  labels:
    app: payment-service
spec:
  replicas: 2  # Flagger will manage this; keep replicas here as desired pod count
  selector:
    matchLabels:
      app: payment-service
  template:
    metadata:
      labels:
        app: payment-service
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"
    spec:
      containers:
        - name: payment-service
          image: registry.example.com/payment-service:v1.2.3
          ports:
            - containerPort: 8080
            - containerPort: 9090  # Metrics
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 256Mi
          readinessProbe:
            httpGet:
              path: /ready
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 5
```

The Canary CRD:

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: payment-service
  namespace: payments
spec:
  # Target deployment to canary
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payment-service

  # Ingress/Service reference for traffic routing
  service:
    port: 80
    targetPort: 8080
    # Istio traffic management
    gateways:
      - istio-system/public-gateway
    hosts:
      - payments.example.com
    trafficPolicy:
      connectionPool:
        http:
          h2UpgradePolicy: UPGRADE
      outlierDetection:
        consecutive5xxErrors: 5
        interval: 30s
        baseEjectionTime: 1m

  # Canary analysis configuration
  analysis:
    # Run analysis every 60 seconds
    interval: 1m
    # Promote after 10 successful iterations (10 minutes)
    threshold: 10
    # Max failed metric checks before rollback
    maxWeight: 50
    # Weight increment per iteration
    stepWeight: 5
    # Initial canary weight before first analysis step
    stepWeightPromotion: 0

    # Metrics to evaluate at each iteration
    metrics:
      - name: request-success-rate
        # Threshold: >= 99% of requests must succeed
        thresholdRange:
          min: 99
        interval: 1m

      - name: request-duration
        # Threshold: p99 latency must be < 500ms
        thresholdRange:
          max: 500
        interval: 1m

    # Webhooks: called at each analysis step
    webhooks:
      - name: acceptance-test
        type: pre-rollout
        url: http://flagger-loadtester.test/
        timeout: 30s
        metadata:
          type: bash
          cmd: "curl -sd 'test' http://payment-service-canary.payments/api/health | grep -q 'ok'"

      - name: load-test
        url: http://flagger-loadtester.test/
        timeout: 5s
        metadata:
          type: cmd
          cmd: "hey -z 1m -q 10 -c 2 http://payment-service-canary.payments/api/payments"
          logCmdOutput: "true"
```

### Understanding the Analysis Loop

Flagger's analysis loop runs every `interval`. At each step:

1. Evaluate all `metrics` — if any fail, increment the failure counter
2. If failures exceed `threshold`, automatically roll back
3. If all metrics pass, increase canary traffic weight by `stepWeight`
4. When canary reaches `maxWeight` with all metrics passing for `threshold` iterations, promote

```
Traffic weight progression with stepWeight=5:
iteration 1:  5% canary,  95% primary
iteration 2: 10% canary,  90% primary
iteration 3: 15% canary,  85% primary
...
iteration 10: 50% canary, 50% primary → PROMOTE
             100% canary,  0% primary
```

## Custom Metric Templates

For metrics not built into Flagger, define custom Prometheus queries:

```yaml
apiVersion: flagger.app/v1beta1
kind: MetricTemplate
metadata:
  name: payment-success-rate
  namespace: payments
spec:
  provider:
    type: prometheus
    address: http://prometheus.monitoring.svc:9090
  query: |
    sum(
      rate(
        http_requests_total{
          namespace="{{ namespace }}",
          pod=~"{{ target }}-[0-9a-zA-Z]+(-[0-9a-zA-Z]+)",
          status!~"5.."
        }[{{ interval }}]
      )
    )
    /
    sum(
      rate(
        http_requests_total{
          namespace="{{ namespace }}",
          pod=~"{{ target }}-[0-9a-zA-Z]+(-[0-9a-zA-Z]+)"
        }[{{ interval }}]
      )
    )
    * 100
```

Reference in the Canary:

```yaml
analysis:
  metrics:
    - name: payment-success-rate
      templateRef:
        name: payment-success-rate
        namespace: payments
      thresholdRange:
        min: 99.5
      interval: 1m
```

### Database Error Rate Template

```yaml
apiVersion: flagger.app/v1beta1
kind: MetricTemplate
metadata:
  name: database-error-rate
  namespace: payments
spec:
  provider:
    type: prometheus
    address: http://prometheus.monitoring.svc:9090
  query: |
    sum(
      rate(
        database_errors_total{
          namespace="{{ namespace }}",
          pod=~"{{ target }}-[0-9a-zA-Z]+(-[0-9a-zA-Z]+)"
        }[{{ interval }}]
      )
    ) or vector(0)
```

## NGINX Ingress Provider

For teams without a service mesh, Flagger supports NGINX Ingress Controller:

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: payment-service
  namespace: payments
spec:
  # Use NGINX ingress provider
  provider: nginx

  ingressRef:
    apiVersion: networking.k8s.io/v1
    kind: Ingress
    name: payment-service

  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payment-service

  service:
    port: 80
    targetPort: 8080

  analysis:
    interval: 1m
    threshold: 10
    maxWeight: 50
    stepWeight: 5
    metrics:
      - name: request-success-rate
        thresholdRange:
          min: 99
        interval: 1m
      - name: request-duration
        thresholdRange:
          max: 500
        interval: 1m
---
# Original Ingress (Flagger will create a canary variant)
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: payment-service
  namespace: payments
  annotations:
    kubernetes.io/ingress.class: nginx
spec:
  rules:
    - host: payments.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: payment-service
                port:
                  number: 80
```

Flagger creates a second Ingress (payment-service-canary) with a canary annotation and weight. NGINX Ingress's built-in canary support handles the traffic splitting:

```yaml
# Flagger-generated canary Ingress
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: payment-service-canary
  annotations:
    kubernetes.io/ingress.class: nginx
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-weight: "10"  # Updated each iteration
```

## Advanced Webhook Patterns

### Pre-Rollout Acceptance Tests

Run integration tests against the canary before any traffic is shifted:

```yaml
webhooks:
  - name: acceptance-test
    type: pre-rollout
    url: http://flagger-loadtester.test/
    timeout: 5m
    metadata:
      type: bash
      cmd: |
        # Run integration test suite against canary endpoint
        curl -sf http://payment-service-canary.payments/api/health && \
        python3 /tests/integration_test.py \
            --endpoint=http://payment-service-canary.payments \
            --suite=smoke
```

### Load Testing During Analysis

Generate realistic traffic to the canary during analysis to ensure metrics are statistically significant:

```yaml
webhooks:
  - name: load-test
    url: http://flagger-loadtester.test/
    timeout: 5s
    metadata:
      type: cmd
      cmd: >
        hey
          -z 2m
          -q 50
          -c 10
          -H "Accept: application/json"
          http://payment-service-canary.payments/api/payments
      logCmdOutput: "true"
```

### Slack Notifications

```yaml
apiVersion: flagger.app/v1beta1
kind: AlertProvider
metadata:
  name: slack
  namespace: payments
spec:
  type: slack
  channel: "#deployments"
  username: "flagger"
  secretRef:
    name: slack-webhook-secret
---
# The secret holds the webhook URL
apiVersion: v1
kind: Secret
metadata:
  name: slack-webhook-secret
  namespace: payments
type: Opaque
stringData:
  address: "https://hooks.slack.com/services/<your-webhook-path>"
```

Reference in the Canary:

```yaml
analysis:
  alerts:
    - name: "slack-notification"
      severity: error
      providerRef:
        name: slack
        namespace: payments
```

### Confirm Promotion Webhook (Manual Gate)

Add a human approval step before final promotion:

```yaml
webhooks:
  - name: manual-approval
    type: confirm-promotion
    url: http://flagger-loadtester.test/gate/check
    timeout: 1h  # Wait up to 1 hour for approval
    metadata:
      # This endpoint returns 200 only after a human approves
      # Integrate with PagerDuty, Slack slash commands, or an approval portal
      type: bash
      cmd: "curl -f http://approval-service.ops/gate/payment-service?sha=$(cat /tmp/canary-sha)"
```

## Blue/Green Deployment Strategy

For services that cannot accept partial traffic splits (stateful protocols, streaming):

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: payment-service
  namespace: payments
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payment-service

  progressDeadlineSeconds: 120

  service:
    port: 80
    targetPort: 8080

  # Blue/Green: no gradual traffic shifting, all-or-nothing promotion
  analysis:
    interval: 30s
    iterations: 10   # Run 10 analysis iterations before promoting
    threshold: 1     # 0 failures allowed

    metrics:
      - name: request-success-rate
        thresholdRange:
          min: 99
        interval: 30s
      - name: request-duration
        thresholdRange:
          max: 300
        interval: 30s

    webhooks:
      - name: acceptance-test
        type: pre-rollout
        url: http://flagger-loadtester.test/
        timeout: 2m
        metadata:
          type: bash
          cmd: "curl -sf http://payment-service-canary.payments/api/health"
      - name: load-test
        url: http://flagger-loadtester.test/
        timeout: 5s
        metadata:
          type: cmd
          cmd: "hey -z 1m -q 10 -c 2 http://payment-service-canary.payments/"
```

## Observability and Monitoring

### Flagger Events

Flagger records all analysis steps as Kubernetes events and optionally as metrics:

```bash
# Watch canary events in real time
kubectl get events -n payments --field-selector involvedObject.name=payment-service -w

# Canary status
kubectl describe canary payment-service -n payments

# Example status output:
# Status:
#   Canary Weight:  30
#   Failed Checks:  0
#   Phase:          Progressing
#   Iterations:     6
#   Tracked Configs:
#     Deployment:  payment-service.payments
```

### Prometheus Metrics

Flagger exposes metrics for monitoring the analysis:

```promql
# Canary weight over time (should increase steadily during promotion)
flagger_canary_weight{namespace="payments", name="payment-service"}

# Failed metric checks
flagger_canary_status{namespace="payments", name="payment-service", phase="Failed"}

# Duration of last promotion
flagger_canary_duration_seconds{namespace="payments"}
```

Grafana dashboard queries:

```promql
# Deployment frequency (how many canary promotions per day)
increase(flagger_canary_status{phase="Succeeded"}[1d])

# Rollback rate (failed canaries / total canaries)
increase(flagger_canary_status{phase="Failed"}[7d])
  / increase(flagger_canary_status[7d])

# Average promotion time
avg_over_time(flagger_canary_duration_seconds[30d])
```

## GitOps Workflow with Flagger

Flagger integrates naturally with ArgoCD and Flux:

```yaml
# ArgoCD Application managing the payment service
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: payment-service
  namespace: argocd
spec:
  project: production
  source:
    repoURL: https://git.example.com/platform/k8s-configs
    targetRevision: main
    path: services/payments
  destination:
    server: https://kubernetes.default.svc
    namespace: payments
  syncPolicy:
    automated:
      prune: false  # Don't prune: Flagger creates primary/canary resources
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
    retry:
      limit: 3
      backoff:
        duration: 5s
        maxDuration: 3m
```

Deployment workflow:
1. Developer updates the image tag in Git
2. ArgoCD detects the change and syncs the Deployment
3. Flagger detects the image change and begins the canary analysis
4. If analysis passes, Flagger promotes the canary; the primary now runs the new image
5. ArgoCD observes the desired state matches the actual state

Note: configure ArgoCD to ignore the `spec.replicas` field managed by Flagger:

```yaml
spec:
  ignoreDifferences:
    - group: apps
      kind: Deployment
      jsonPointers:
        - /spec/replicas
```

## Troubleshooting Common Issues

### Issue: Canary Stuck in "Initializing"

```bash
kubectl describe canary payment-service -n payments
# Look for: "waiting for primary to be ready"

# Check primary Deployment (created by Flagger)
kubectl get deployment payment-service-primary -n payments
kubectl describe deployment payment-service-primary -n payments

# Check for ImagePullBackOff on primary pods
kubectl get pods -n payments -l app=payment-service-primary
```

### Issue: Canary Failing Immediately

```bash
# Check metric queries are returning data
kubectl exec -it prometheus-0 -n monitoring -- \
    promtool query instant \
    'rate(http_requests_total{namespace="payments"}[1m])'

# Check Flagger logs
kubectl logs -n istio-system -l app.kubernetes.io/name=flagger -f | grep payment-service

# Temporarily lower thresholds for debugging
kubectl patch canary payment-service -n payments --type=merge \
    -p '{"spec":{"analysis":{"metrics":[{"name":"request-success-rate","thresholdRange":{"min":50},"interval":"1m"}]}}}'
```

### Issue: Traffic Not Shifting (Stuck at 0%)

```bash
# Check VirtualService (Istio)
kubectl get virtualservice payment-service -n payments -o yaml | grep weight

# Check NGINX Ingress canary annotations
kubectl get ingress payment-service-canary -n payments -o yaml | grep canary-weight

# Check that the canary pod is running and passing readiness
kubectl get pods -n payments -l app=payment-service
kubectl describe pod <canary-pod> -n payments
```

### Issue: Canary Not Progressing After Promotion

After a successful promotion, Flagger scales the canary Deployment to 0 and the primary runs 100% of traffic. On the next deploy:

```bash
# Verify primary is running the new image
kubectl get deployment payment-service-primary -n payments \
    -o jsonpath='{.spec.template.spec.containers[0].image}'

# If the primary image is stale, Flagger may need a force reconcile
kubectl annotate canary payment-service -n payments \
    flagger.app/force-reconcile="$(date +%s)"
```

## Summary

Flagger transforms canary deployments from a manual, attention-intensive process to a fully automated, metrics-driven one:

1. **Define success criteria** in the Canary CRD using Prometheus metrics, not subjective human judgment
2. **Start with conservative settings**: small `stepWeight` (5%), many iterations (10+), tight thresholds (99% success rate)
3. **Use pre-rollout webhooks** for smoke tests that validate the canary is functionally correct before shifting any traffic
4. **Generate synthetic traffic** during analysis so metrics are statistically meaningful even at low canary weights
5. **Integrate with Slack** for visibility into promotions and rollbacks
6. **Add manual approval gates** for high-risk changes that need human sign-off before final promotion

The combination of Flagger with Prometheus metrics and your existing CI/CD pipeline provides a production-grade progressive delivery platform that catches regressions before they affect all users.
