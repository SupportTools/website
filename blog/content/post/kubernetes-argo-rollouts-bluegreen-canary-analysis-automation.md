---
title: "Kubernetes Argo Rollouts Advanced: BlueGreen with Analysis, Canary with Header Routing, and Pause/Promote Automation"
date: 2031-11-01T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Argo Rollouts", "BlueGreen", "Canary", "Progressive Delivery", "GitOps", "Deployment"]
categories:
- Kubernetes
- DevOps
- Progressive Delivery
author: "Matthew Mattox - mmattox@support.tools"
description: "Advanced guide to Argo Rollouts for progressive delivery: configuring BlueGreen deployments with automated analysis, implementing canary releases with header-based routing, and building automated pause/promote pipelines with Prometheus-driven quality gates."
more_link: "yes"
url: "/kubernetes-argo-rollouts-bluegreen-canary-analysis-automation/"
---

Argo Rollouts extends Kubernetes with sophisticated deployment strategies that go far beyond what standard Deployments support. BlueGreen deployments with automated traffic switching based on analysis runs, canary releases with per-request routing via headers, and automated promotion pipelines driven by real-time metrics create a production deployment process that is both safe and efficient. This guide covers production-grade Argo Rollouts configurations used in enterprise environments.

<!--more-->

# Kubernetes Argo Rollouts: Advanced Progressive Delivery

## Why Argo Rollouts Over Standard Deployments

Standard Kubernetes Deployments provide rolling updates but lack:
- Traffic-weighted routing (requires service mesh or Ingress changes)
- Automated rollback based on metrics
- Header-based test traffic routing
- Pause gates with manual approval workflows
- Integration with analysis providers (Prometheus, Datadog, Wavefront)

Argo Rollouts adds a `Rollout` CRD that provides all these capabilities while remaining GitOps-compatible.

## Installation

```bash
# Create namespace
kubectl create namespace argo-rollouts

# Install Argo Rollouts
kubectl apply -n argo-rollouts \
  -f https://github.com/argoproj/argo-rollouts/releases/download/v1.7.0/install.yaml

# Install kubectl plugin
curl -LO https://github.com/argoproj/argo-rollouts/releases/download/v1.7.0/kubectl-argo-rollouts-linux-amd64
chmod +x kubectl-argo-rollouts-linux-amd64
mv kubectl-argo-rollouts-linux-amd64 /usr/local/bin/kubectl-argo-rollouts

# Verify
kubectl argo rollouts version
```

## BlueGreen Deployment with Analysis

### Understanding BlueGreen in Argo Rollouts

Argo Rollouts BlueGreen works differently from traditional approaches:
- **Active service**: Always points to the currently live (blue) deployment
- **Preview service**: Points to the new (green) deployment for testing
- **Analysis runs**: Automated tests that run against the preview before promotion
- **Auto-promotion**: Optional automatic cutover after analysis passes

### AnalysisTemplate for Quality Gates

Define the metrics that gate promotion:

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
      value: production
    - name: prometheus-url
      value: http://prometheus-operated.monitoring.svc.cluster.local:9090
  metrics:
    - name: success-rate
      interval: 60s
      successCondition: result[0] >= 0.95
      failureCondition: result[0] < 0.90
      failureLimit: 3
      count: 10
      provider:
        prometheus:
          address: "{{args.prometheus-url}}"
          query: |
            sum(
              rate(
                http_requests_total{
                  job="{{args.service-name}}",
                  namespace="{{args.namespace}}",
                  status=~"2..|3.."
                }[5m]
              )
            )
            /
            sum(
              rate(
                http_requests_total{
                  job="{{args.service-name}}",
                  namespace="{{args.namespace}}"
                }[5m]
              )
            )

    - name: p99-latency
      interval: 60s
      successCondition: result[0] <= 200
      failureCondition: result[0] > 500
      failureLimit: 2
      count: 10
      provider:
        prometheus:
          address: "{{args.prometheus-url}}"
          query: |
            histogram_quantile(
              0.99,
              sum(
                rate(
                  http_request_duration_seconds_bucket{
                    job="{{args.service-name}}",
                    namespace="{{args.namespace}}"
                  }[5m]
                )
              ) by (le)
            ) * 1000

    - name: error-rate
      interval: 60s
      successCondition: result[0] <= 0.01
      failureCondition: result[0] > 0.05
      failureLimit: 1
      count: 10
      provider:
        prometheus:
          address: "{{args.prometheus-url}}"
          query: |
            sum(
              rate(
                http_requests_total{
                  job="{{args.service-name}}",
                  namespace="{{args.namespace}}",
                  status=~"5.."
                }[5m]
              )
            )
            /
            sum(
              rate(
                http_requests_total{
                  job="{{args.service-name}}",
                  namespace="{{args.namespace}}"
                }[5m]
              )
            )
```

### BlueGreen Rollout with Pre-Promotion Analysis

```yaml
# rollout-bluegreen.yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: api-service
  namespace: production
spec:
  replicas: 6
  revisionHistoryLimit: 3
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
          image: registry.example.corp/api-service:v2.1.0
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
            limits:
              cpu: 1000m
              memory: 512Mi
          readinessProbe:
            httpGet:
              path: /healthz/ready
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 5
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /healthz/live
              port: 8080
            initialDelaySeconds: 30
            periodSeconds: 10

  strategy:
    blueGreen:
      # Service that receives production traffic
      activeService: api-service-active
      # Service for the new version being tested
      previewService: api-service-preview

      # Don't automatically switch to new version
      autoPromotionEnabled: false

      # Time to wait before auto-promotion (if enabled)
      # autoPromotionSeconds: 300

      # Scale down old version after this many seconds post-promotion
      scaleDownDelaySeconds: 30

      # Anti-affinity to ensure blue and green are on different nodes
      antiAffinity:
        requiredDuringSchedulingIgnoredDuringExecution: {}
        preferredDuringSchedulingIgnoredDuringExecution:
          weight: 1

      # Run analysis against preview before promoting
      prePromotionAnalysis:
        templates:
          - templateName: success-rate
        args:
          - name: service-name
            value: api-service-preview
          - name: namespace
            value: production

      # Run analysis after promotion to catch issues
      postPromotionAnalysis:
        templates:
          - templateName: success-rate
        args:
          - name: service-name
            value: api-service-active
          - name: namespace
            value: production
---
# Active service (production traffic)
apiVersion: v1
kind: Service
metadata:
  name: api-service-active
  namespace: production
spec:
  selector:
    app: api-service
  ports:
    - port: 80
      targetPort: 8080
      name: http
---
# Preview service (new version testing)
apiVersion: v1
kind: Service
metadata:
  name: api-service-preview
  namespace: production
spec:
  selector:
    app: api-service
  ports:
    - port: 80
      targetPort: 8080
      name: http
```

### Monitoring BlueGreen Progress

```bash
# Watch rollout progress
kubectl argo rollouts get rollout api-service -n production --watch

# Example output:
# Name:            api-service
# Namespace:       production
# Status:          ॥ Paused
# Message:         BlueGreenPause
# Strategy:        BlueGreen
# ...
# REVISION  STATUS     STABLE  READY  DESIRED  UP-TO-DATE  AVAILABLE
# 2         Paused     True    6      6        6           6
# 1         Healthy    True    6      6        6           6

# Check analysis run status
kubectl get analysisrun -n production -l rollout=api-service

# View analysis details
kubectl describe analysisrun api-service-5d7f8c9b4-12345 -n production

# Promote manually after verification
kubectl argo rollouts promote api-service -n production

# Force abort if issues found
kubectl argo rollouts abort api-service -n production

# Rollback to previous version
kubectl argo rollouts undo api-service -n production
```

## Canary with Header-Based Routing

### Nginx Ingress-Based Canary

```yaml
# rollout-canary-nginx.yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: frontend
  namespace: production
spec:
  replicas: 10
  revisionHistoryLimit: 3
  selector:
    matchLabels:
      app: frontend
  template:
    metadata:
      labels:
        app: frontend
    spec:
      containers:
        - name: frontend
          image: registry.example.corp/frontend:v3.2.0
          ports:
            - containerPort: 3000
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 256Mi

  strategy:
    canary:
      # Stable service receives production traffic
      stableService: frontend-stable
      # Canary service receives new version traffic
      canaryService: frontend-canary

      # Configure Nginx Ingress for traffic splitting and header routing
      trafficRouting:
        nginx:
          stableIngress: frontend-ingress
          additionalIngressAnnotations:
            # Route requests with canary header to canary regardless of weight
            nginx.ingress.kubernetes.io/canary-by-header: x-canary
            nginx.ingress.kubernetes.io/canary-by-header-value: "true"

      # Progressive traffic shifting steps
      steps:
        # Start with header-only routing (no production traffic to canary)
        - setCanaryScale:
            replicas: 1
        - pause:
            duration: 2m
        # 5% traffic to canary
        - setWeight: 5
        - analysis:
            templates:
              - templateName: canary-analysis
            args:
              - name: service-name
                value: frontend-canary
        - pause:
            duration: 10m
        # 10% traffic
        - setWeight: 10
        - pause:
            duration: 10m
        # 25% traffic
        - setWeight: 25
        - analysis:
            templates:
              - templateName: canary-analysis
            args:
              - name: service-name
                value: frontend-canary
        - pause:
            duration: 20m
        # 50% traffic
        - setWeight: 50
        - analysis:
            templates:
              - templateName: canary-analysis
            args:
              - name: service-name
                value: frontend-canary
        - pause:
            duration: 20m
        # 100% - full promotion
        - setWeight: 100
---
apiVersion: v1
kind: Service
metadata:
  name: frontend-stable
  namespace: production
spec:
  selector:
    app: frontend
  ports:
    - port: 80
      targetPort: 3000
      name: http
---
apiVersion: v1
kind: Service
metadata:
  name: frontend-canary
  namespace: production
spec:
  selector:
    app: frontend
  ports:
    - port: 80
      targetPort: 3000
      name: http
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: frontend-ingress
  namespace: production
  annotations:
    kubernetes.io/ingress.class: nginx
spec:
  rules:
    - host: frontend.example.corp
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: frontend-stable
                port:
                  number: 80
```

### Istio-Based Canary with Header Routing

```yaml
# rollout-canary-istio.yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: payment-service
  namespace: production
spec:
  replicas: 8
  revisionHistoryLimit: 3
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
          image: registry.example.corp/payment-service:v4.0.0
          ports:
            - containerPort: 8080

  strategy:
    canary:
      stableService: payment-service-stable
      canaryService: payment-service-canary
      trafficRouting:
        istio:
          virtualService:
            name: payment-service-vsvc
            routes:
              - primary
          destinationRule:
            name: payment-service-destrule
            stableSubsetName: stable
            canarySubsetName: canary

      steps:
        # Internal header routing only (no weight-based traffic)
        - setHeaderRoute:
            name: header-route
            match:
              - headerName: x-payment-version
                headerValue:
                  exact: v4
        - pause:
            duration: 5m
        - setWeight: 5
        - analysis:
            templates:
              - templateName: payment-analysis
        - pause:
            duration: 15m
        - setWeight: 20
        - pause:
            duration: 15m
        - setWeight: 50
        - analysis:
            templates:
              - templateName: payment-analysis
        - pause:
            duration: 30m
        - setWeight: 100
---
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: payment-service-vsvc
  namespace: production
spec:
  hosts:
    - payment-service
  http:
    # Header-based route (managed by Argo Rollouts)
    - name: header-route
      match:
        - headers:
            x-payment-version:
              exact: v4
      route:
        - destination:
            host: payment-service-canary
            port:
              number: 8080
          weight: 100
    # Weight-based route (managed by Argo Rollouts)
    - name: primary
      route:
        - destination:
            host: payment-service-stable
            port:
              number: 8080
          weight: 100
        - destination:
            host: payment-service-canary
            port:
              number: 8080
          weight: 0
---
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: payment-service-destrule
  namespace: production
spec:
  host: payment-service
  subsets:
    - name: stable
      labels:
        app: payment-service
    - name: canary
      labels:
        app: payment-service
```

### Canary AnalysisTemplate with Web Metrics

```yaml
# analysis-template-canary.yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: payment-analysis
  namespace: production
spec:
  args:
    - name: service-name
    - name: canary-hash
  metrics:
    - name: payment-success-rate
      interval: 2m
      successCondition: result[0] >= 0.999
      failureCondition: result[0] < 0.995
      failureLimit: 2
      count: 15
      provider:
        prometheus:
          address: http://prometheus-operated.monitoring.svc.cluster.local:9090
          query: |
            sum(
              rate(
                payment_transactions_total{
                  service="{{args.service-name}}",
                  status="success"
                }[5m]
              )
            )
            /
            sum(
              rate(
                payment_transactions_total{
                  service="{{args.service-name}}"
                }[5m]
              )
            )

    - name: payment-latency-p95
      interval: 2m
      successCondition: result[0] <= 100
      failureCondition: result[0] > 300
      failureLimit: 2
      count: 15
      provider:
        prometheus:
          address: http://prometheus-operated.monitoring.svc.cluster.local:9090
          query: |
            histogram_quantile(
              0.95,
              sum(
                rate(
                  payment_duration_seconds_bucket{
                    service="{{args.service-name}}"
                  }[5m]
                )
              ) by (le)
            ) * 1000

    # Kubernetes Job-based analysis (smoke test)
    - name: payment-smoke-test
      count: 1
      provider:
        job:
          spec:
            template:
              spec:
                containers:
                  - name: smoke-test
                    image: registry.example.corp/tools/smoketest:latest
                    command:
                      - /bin/sh
                      - -c
                      - |
                        set -e
                        # Run smoke test against canary service
                        RESPONSE=$(curl -sf \
                          -H "x-payment-version: v4" \
                          "http://payment-service.production.svc.cluster.local:8080/health/smoke" \
                          -w "\n%{http_code}")
                        HTTP_CODE=$(echo "$RESPONSE" | tail -1)
                        BODY=$(echo "$RESPONSE" | head -1)

                        if [ "$HTTP_CODE" != "200" ]; then
                          echo "Smoke test failed: HTTP ${HTTP_CODE}"
                          exit 1
                        fi

                        echo "Smoke test passed: ${BODY}"
                restartPolicy: Never
            backoffLimit: 0
```

## Automated Pause and Promote Pipeline

### GitHub Actions Integration

```yaml
# .github/workflows/progressive-deploy.yml
name: Progressive Deployment

on:
  push:
    branches:
      - main
    paths:
      - 'src/**'
      - 'Dockerfile'

env:
  REGISTRY: registry.example.corp
  IMAGE_NAME: api-service
  ROLLOUT_NAMESPACE: production

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    outputs:
      image-tag: ${{ steps.meta.outputs.version }}
    steps:
      - uses: actions/checkout@v4

      - name: Docker meta
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=sha,format=long

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          push: true
          tags: ${{ steps.meta.outputs.tags }}

  deploy-canary:
    needs: build-and-push
    runs-on: ubuntu-latest
    environment: production
    steps:
      - name: Configure kubectl
        uses: azure/k8s-set-context@v3
        with:
          method: kubeconfig
          kubeconfig: ${{ secrets.KUBECONFIG_PRODUCTION }}

      - name: Update rollout image
        run: |
          kubectl argo rollouts set image api-service \
            api-service=${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ needs.build-and-push.outputs.image-tag }} \
            -n ${{ env.ROLLOUT_NAMESPACE }}

      - name: Wait for analysis to complete first step
        run: |
          # Wait for rollout to reach first pause point
          timeout 600 kubectl argo rollouts status api-service \
            -n ${{ env.ROLLOUT_NAMESPACE }} \
            --timeout 600s || true

          # Check if we're paused (expected state at step boundary)
          STATUS=$(kubectl argo rollouts get rollout api-service \
            -n ${{ env.ROLLOUT_NAMESPACE }} \
            -o jsonpath='{.status.phase}')

          if [ "${STATUS}" != "Paused" ] && [ "${STATUS}" != "Healthy" ]; then
            echo "Unexpected rollout status: ${STATUS}"
            kubectl argo rollouts abort api-service -n ${{ env.ROLLOUT_NAMESPACE }}
            exit 1
          fi

          echo "Rollout status: ${STATUS}"

      - name: Run integration tests against canary
        run: |
          # Run integration tests against preview/canary endpoint
          curl -sf -H "x-canary: true" \
            "https://api.example.corp/api/v1/health" | \
            python3 -c "import sys, json; d=json.load(sys.stdin); sys.exit(0 if d.get('status') == 'ok' else 1)"

      - name: Promote rollout
        run: |
          kubectl argo rollouts promote api-service \
            -n ${{ env.ROLLOUT_NAMESPACE }}

      - name: Monitor promotion
        run: |
          kubectl argo rollouts status api-service \
            -n ${{ env.ROLLOUT_NAMESPACE }} \
            --timeout 900s

      - name: Rollback on failure
        if: failure()
        run: |
          kubectl argo rollouts abort api-service \
            -n ${{ env.ROLLOUT_NAMESPACE }}
          kubectl argo rollouts undo api-service \
            -n ${{ env.ROLLOUT_NAMESPACE }}
```

### Automated Promotion Webhook

Deploy a small service that listens for rollout events and handles promotion decisions:

```go
// cmd/rollout-controller/main.go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "log/slog"
    "net/http"
    "os"
    "time"
)

type RolloutEvent struct {
    Name      string `json:"name"`
    Namespace string `json:"namespace"`
    Phase     string `json:"phase"`
    Step      int    `json:"step"`
    Message   string `json:"message"`
}

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

    http.HandleFunc("/webhook/rollout", func(w http.ResponseWriter, r *http.Request) {
        var event RolloutEvent
        if err := json.NewDecoder(r.Body).Decode(&event); err != nil {
            http.Error(w, "invalid payload", http.StatusBadRequest)
            return
        }

        logger.Info("received rollout event",
            "name", event.Name,
            "namespace", event.Namespace,
            "phase", event.Phase,
            "step", event.Step)

        if event.Phase == "Paused" {
            go func() {
                // Run custom validation
                ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
                defer cancel()

                if err := runValidation(ctx, event, logger); err != nil {
                    logger.Error("validation failed, aborting rollout",
                        "error", err,
                        "rollout", event.Name)
                    abortRollout(event.Namespace, event.Name, logger)
                    return
                }

                logger.Info("validation passed, promoting rollout",
                    "rollout", event.Name)
                promoteRollout(event.Namespace, event.Name, logger)
            }()
        }

        w.WriteHeader(http.StatusOK)
    })

    logger.Info("starting rollout controller webhook", "port", "8080")
    http.ListenAndServe(":8080", nil)
}

func runValidation(ctx context.Context, event RolloutEvent, logger *slog.Logger) error {
    // Custom validation logic: check business metrics, run smoke tests, etc.
    client := &http.Client{Timeout: 30 * time.Second}

    resp, err := client.Get(fmt.Sprintf(
        "http://api-service-preview.%s.svc.cluster.local/api/v1/health",
        event.Namespace))
    if err != nil {
        return fmt.Errorf("health check failed: %w", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        return fmt.Errorf("health check returned %d", resp.StatusCode)
    }

    return nil
}

func promoteRollout(namespace, name string, logger *slog.Logger) {
    // Use kubectl via exec or kubernetes client
    // In production, use the official Argo Rollouts Go client
    logger.Info("promoting rollout", "namespace", namespace, "name", name)
}

func abortRollout(namespace, name string, logger *slog.Logger) {
    logger.Info("aborting rollout", "namespace", namespace, "name", name)
}
```

## Multi-Analysis with Weighted Verdict

For complex promotion criteria:

```yaml
# analysis-template-weighted.yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: weighted-analysis
  namespace: production
spec:
  args:
    - name: service-name
    - name: baseline-service
  metrics:
    # Compare canary vs baseline (A/B style comparison)
    - name: error-rate-comparison
      interval: 2m
      successCondition: result[0] <= result[1] * 1.1  # Canary error rate <= 110% of baseline
      failureCondition: result[0] > result[1] * 2.0   # Canary error rate > 200% of baseline
      count: 10
      provider:
        prometheus:
          address: http://prometheus-operated.monitoring.svc.cluster.local:9090
          query: |
            [
              scalar(
                sum(rate(http_requests_total{service="{{args.service-name}}",status=~"5.."}[5m]))
                /
                sum(rate(http_requests_total{service="{{args.service-name}}"}[5m]))
              ),
              scalar(
                sum(rate(http_requests_total{service="{{args.baseline-service}}",status=~"5.."}[5m]))
                /
                sum(rate(http_requests_total{service="{{args.baseline-service}}"}[5m]))
              )
            ]

    # Datadog integration for business metrics
    - name: conversion-rate
      interval: 5m
      successCondition: result[0] >= 0.035
      failureCondition: result[0] < 0.025
      count: 5
      provider:
        datadog:
          apiVersion: v2
          interval: 5m
          query: "avg:frontend.conversion_rate{service:{{args.service-name}}}"
```

## Notification Integration

```yaml
# rollout-notification-cm.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argo-rollouts-notification-cm
  namespace: argo-rollouts
data:
  # Slack notification template
  template.rollout-analysis-error: |
    slack:
      attachments: |
        [{
          "title": "Rollout Analysis Failed",
          "color": "danger",
          "fields": [{
            "title": "Rollout",
            "value": "{{.rollout.metadata.name}}",
            "short": true
          }, {
            "title": "Namespace",
            "value": "{{.rollout.metadata.namespace}}",
            "short": true
          }, {
            "title": "Message",
            "value": "{{.rollout.status.message}}",
            "short": false
          }]
        }]

  template.rollout-promoted: |
    slack:
      attachments: |
        [{
          "title": "Rollout Promoted",
          "color": "good",
          "fields": [{
            "title": "Rollout",
            "value": "{{.rollout.metadata.name}}",
            "short": true
          }, {
            "title": "Revision",
            "value": "{{.rollout.status.currentPodHash}}",
            "short": true
          }]
        }]

  trigger.on-analysis-error: |
    - send: [rollout-analysis-error]
      when: rollout.status.phase == 'Degraded'

  trigger.on-promoted: |
    - send: [rollout-promoted]
      when: rollout.status.phase == 'Healthy' and rollout.status.stableRS == rollout.status.currentPodHash

  subscriptions: |
    - recipients:
        - slack:C04XYZ12345
      triggers:
        - on-analysis-error
        - on-promoted
---
apiVersion: v1
kind: Secret
metadata:
  name: argo-rollouts-notification-secret
  namespace: argo-rollouts
stringData:
  slack-token: "xoxb-notification-token-replace-me"
```

## Observability for Rollouts

### Prometheus Metrics

```yaml
# prometheusrule-rollouts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: argo-rollouts-alerts
  namespace: monitoring
spec:
  groups:
    - name: argo.rollouts
      rules:
        - alert: RolloutDegraded
          expr: argo_rollout_phase{phase="Degraded"} == 1
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Rollout {{ $labels.name }} in namespace {{ $labels.namespace }} is degraded"

        - alert: RolloutAnalysisFailed
          expr: argo_analysis_run_phase{phase="Failed"} == 1
          for: 0m
          labels:
            severity: warning
          annotations:
            summary: "Analysis run {{ $labels.name }} failed"

        - alert: RolloutPausedTooLong
          expr: |
            (time() - argo_rollout_phase_transition_time{phase="Paused"}) > 3600
          for: 0m
          labels:
            severity: warning
          annotations:
            summary: "Rollout {{ $labels.name }} has been paused for > 1 hour"
```

### Dashboard Queries

```promql
# Active rollouts by phase
count by (phase) (argo_rollout_phase == 1)

# Canary weight progression over time
argo_rollout_info{strategy="canary"}

# Analysis run success rate
sum(argo_analysis_run_phase{phase="Successful"}) /
sum(argo_analysis_run_phase{phase=~"Successful|Failed"})

# Rollout duration histogram
histogram_quantile(0.99, rate(argo_rollout_reconcile_duration_seconds_bucket[5m]))
```

## Production Best Practices

### Resource Requirements for Rollouts

```yaml
# Ensure sufficient capacity for both versions during BlueGreen
# requests.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: production-quota
  namespace: production
spec:
  hard:
    # Allow 2x normal capacity for BlueGreen
    requests.cpu: "100"
    requests.memory: "200Gi"
    pods: "500"
```

### Canary Step Configuration Guidelines

For high-traffic production services, follow this progression:
1. 1% canary traffic for 10 minutes (catches hard failures)
2. 5% for 15 minutes (validates traffic patterns)
3. 10% for 20 minutes (run full analysis)
4. 25% for 30 minutes (broader exposure)
5. 50% for 30 minutes (near-parity with stable)
6. 100% (full promotion)

Each step should trigger an analysis run. Total promotion time: ~2 hours for critical services.

### Emergency Rollback Procedure

```bash
#!/bin/bash
# emergency-rollback.sh

ROLLOUT_NAME="${1:?rollout name required}"
NAMESPACE="${2:-production}"

echo "=== EMERGENCY ROLLBACK: ${NAMESPACE}/${ROLLOUT_NAME} ==="
echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Immediately abort current rollout
kubectl argo rollouts abort "${ROLLOUT_NAME}" -n "${NAMESPACE}"

# Roll back to previous stable revision
kubectl argo rollouts undo "${ROLLOUT_NAME}" -n "${NAMESPACE}"

# Monitor rollback progress
kubectl argo rollouts status "${ROLLOUT_NAME}" \
  -n "${NAMESPACE}" \
  --timeout 300s

echo "Rollback complete. Current state:"
kubectl argo rollouts get rollout "${ROLLOUT_NAME}" -n "${NAMESPACE}"
```

## Conclusion

Argo Rollouts provides enterprise-grade progressive delivery capabilities that make production deployments measurably safer. BlueGreen with pre-promotion analysis eliminates the risk of full traffic exposure to untested code. Canary with header routing enables engineers to test against real production infrastructure without risking production users. The combination of Prometheus-driven analysis, automated pause gates, and notification integration creates a deployment pipeline that balances velocity with stability — the core challenge of modern DevOps practice.
