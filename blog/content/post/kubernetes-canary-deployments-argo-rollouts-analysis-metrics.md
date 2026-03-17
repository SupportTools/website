---
title: "Kubernetes Canary Deployments: Argo Rollouts Analysis and Metrics"
date: 2029-09-21T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Argo Rollouts", "Canary Deployments", "Progressive Delivery", "Prometheus", "GitOps"]
categories: ["Kubernetes", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to automated canary deployments with Argo Rollouts: AnalysisTemplate and AnalysisRun resources, metric providers (Prometheus, Datadog, Wavefront), automated pass/fail criteria, and manual promotion gates."
more_link: "yes"
url: "/kubernetes-canary-deployments-argo-rollouts-analysis-metrics/"
---

Canary deployments give you a surgical way to validate a new version against real production traffic before committing to a full rollout. But manually monitoring dashboards and deciding when to proceed is error-prone and requires engineers on-call for every release. Argo Rollouts automates this loop: it defines the traffic split, queries your observability stack for success metrics, and either promotes the canary automatically or rolls back without human intervention. This post covers the complete Argo Rollouts setup from installation through AnalysisTemplate configuration, multi-provider metric queries, and manual promotion gates.

<!--more-->

# Kubernetes Canary Deployments: Argo Rollouts Analysis and Metrics

## Argo Rollouts Architecture

Argo Rollouts extends Kubernetes with two CRDs that replace the standard Deployment for services requiring progressive delivery:

- **Rollout**: A drop-in replacement for Deployment with canary and blue-green strategy fields.
- **AnalysisTemplate**: A reusable template defining the queries and success criteria for automated analysis.
- **AnalysisRun**: A concrete execution of an AnalysisTemplate, created during a Rollout and evaluated against live metrics.
- **Experiment**: Allows running multiple versions simultaneously with defined traffic splits for comparison.

The Argo Rollouts controller watches Rollout objects and orchestrates the step-based progression: increase traffic to canary, wait, analyze, increase again, or abort.

## Installation

```bash
# Install Argo Rollouts controller
kubectl create namespace argo-rollouts
kubectl apply -n argo-rollouts \
  -f https://github.com/argoproj/argo-rollouts/releases/latest/download/install.yaml

# Install the kubectl plugin
curl -LO https://github.com/argoproj/argo-rollouts/releases/latest/download/kubectl-argo-rollouts-linux-amd64
chmod +x kubectl-argo-rollouts-linux-amd64
mv kubectl-argo-rollouts-linux-amd64 /usr/local/bin/kubectl-argo-rollouts

# Verify installation
kubectl argo rollouts version
```

## Basic Canary Rollout

A minimal Rollout resource with a 10-step canary progression:

```yaml
# rollout-basic.yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: my-api
  namespace: production
spec:
  replicas: 10
  selector:
    matchLabels:
      app: my-api
  template:
    metadata:
      labels:
        app: my-api
    spec:
      containers:
        - name: api
          image: registry.example.com/my-api:v1.2.3
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: "100m"
              memory: "128Mi"
            limits:
              cpu: "500m"
              memory: "512Mi"
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 5
  strategy:
    canary:
      # Traffic steps: each step sets the canary traffic weight
      steps:
        # Step 1: Route 5% of traffic to canary, then analyze for 5 minutes
        - setWeight: 5
        - analysis:
            templates:
              - templateName: success-rate-check
              - templateName: latency-check
            args:
              - name: service-name
                value: my-api
        # Step 2: If analysis passed, increase to 20%
        - setWeight: 20
        - pause:
            duration: 10m  # soak for 10 minutes
        - analysis:
            templates:
              - templateName: success-rate-check
            args:
              - name: service-name
                value: my-api
        # Step 3: Manual gate — a human must promote
        - pause: {}  # pause indefinitely until manually promoted
        # Step 4: 50% canary
        - setWeight: 50
        - pause:
            duration: 5m
        # Step 5: Full rollout (100%)
        - setWeight: 100
      # Anti-affinity: spread canary pods across nodes
      antiAffinity:
        requiredDuringSchedulingIgnoredDuringExecution: {}
        preferredDuringSchedulingIgnoredDuringExecution:
          weight: 1
      # Maximum number of unavailable pods during canary (as fraction of desired)
      maxUnavailable: 0
      maxSurge: "20%"
```

## AnalysisTemplate: Defining Success Criteria

`AnalysisTemplate` is where you define what "success" means for your service. It supports multiple metric providers and complex pass/fail logic.

### Prometheus Analysis Template

```yaml
# analysis-template-prometheus.yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: success-rate-check
  namespace: production
spec:
  args:
    # Arguments let you parameterize templates for reuse across services
    - name: service-name
    - name: namespace
      value: production
    - name: threshold
      value: "0.95"  # 95% success rate required

  metrics:
    - name: success-rate
      # Interval: how often to re-evaluate the metric
      interval: 1m
      # Count: how many measurements to take before concluding
      count: 5
      # SuccessCondition: PromQL expression must evaluate to this
      successCondition: result[0] >= 0.95
      failureCondition: result[0] < 0.90
      failureLimit: 2  # fail AnalysisRun after 2 consecutive failures
      provider:
        prometheus:
          address: http://prometheus-operated.monitoring.svc.cluster.local:9090
          query: |
            sum(
              rate(
                http_requests_total{
                  service="{{args.service-name}}",
                  namespace="{{args.namespace}}",
                  status_class="2xx"
                }[5m]
              )
            )
            /
            sum(
              rate(
                http_requests_total{
                  service="{{args.service-name}}",
                  namespace="{{args.namespace}}"
                }[5m]
              )
            )

    - name: canary-error-rate
      interval: 2m
      count: 3
      successCondition: result[0] < 0.05
      failureCondition: result[0] >= 0.10
      provider:
        prometheus:
          address: http://prometheus-operated.monitoring.svc.cluster.local:9090
          query: |
            sum(
              rate(
                http_requests_total{
                  service="{{args.service-name}}-canary",
                  status_class=~"4xx|5xx"
                }[5m]
              )
            )
            /
            sum(
              rate(
                http_requests_total{
                  service="{{args.service-name}}-canary"
                }[5m]
              )
            )
---
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: latency-check
  namespace: production
spec:
  args:
    - name: service-name
    - name: percentile
      value: "0.99"
    - name: max-latency-ms
      value: "200"

  metrics:
    - name: p99-latency
      interval: 1m
      count: 5
      # Compare canary p99 to stable p99 — allows for absolute increases
      # but catches significant regressions
      successCondition: result[0] <= 200
      failureCondition: result[0] > 500
      provider:
        prometheus:
          address: http://prometheus-operated.monitoring.svc.cluster.local:9090
          query: |
            histogram_quantile(0.99,
              sum by (le) (
                rate(
                  http_request_duration_seconds_bucket{
                    service="{{args.service-name}}"
                  }[5m]
                )
              )
            ) * 1000

    - name: canary-vs-stable-latency-ratio
      interval: 2m
      count: 3
      # Canary should not be more than 20% slower than stable
      successCondition: result[0] <= 1.2
      failureCondition: result[0] > 1.5
      provider:
        prometheus:
          address: http://prometheus-operated.monitoring.svc.cluster.local:9090
          query: |
            histogram_quantile(0.95,
              sum by (le) (
                rate(http_request_duration_seconds_bucket{
                  service="{{args.service-name}}-canary"
                }[5m])
              )
            )
            /
            histogram_quantile(0.95,
              sum by (le) (
                rate(http_request_duration_seconds_bucket{
                  service="{{args.service-name}}-stable"
                }[5m])
              )
            )
```

### Datadog Analysis Template

```yaml
# analysis-template-datadog.yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: datadog-success-rate
  namespace: production
spec:
  args:
    - name: service-name
    - name: env
      value: production

  metrics:
    - name: datadog-error-rate
      interval: 1m
      count: 5
      successCondition: result[0] < 0.01
      failureCondition: result[0] >= 0.05
      provider:
        datadog:
          # API credentials from Kubernetes secret
          apiVersion: v2
          query: |
            sum:trace.web.request.errors{
              service:{{args.service-name}},
              env:{{args.env}}
            }.as_rate()
            /
            sum:trace.web.request.hits{
              service:{{args.service-name}},
              env:{{args.env}}
            }.as_rate()
          # Secret containing DATADOG_API_KEY and DATADOG_APP_KEY
          apiVersionSecretRef:
            name: datadog-api-credentials

    - name: canary-apdex-score
      interval: 2m
      count: 3
      successCondition: result[0] >= 0.9
      failureCondition: result[0] < 0.7
      provider:
        datadog:
          apiVersion: v2
          query: |
            avg:trace.web.request.apdex{
              service:{{args.service-name}}-canary,
              env:{{args.env}}
            }
          apiVersionSecretRef:
            name: datadog-api-credentials
---
# Secret for Datadog credentials
apiVersion: v1
kind: Secret
metadata:
  name: datadog-api-credentials
  namespace: production
type: Opaque
stringData:
  api-key: "<DD_API_KEY_FROM_VAULT>"
  app-key: "<DD_APP_KEY_FROM_VAULT>"
```

### Wavefront Analysis Template

```yaml
# analysis-template-wavefront.yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: wavefront-analysis
  namespace: production
spec:
  args:
    - name: service-name

  metrics:
    - name: wavefront-error-rate
      interval: 90s
      count: 4
      successCondition: result[0] < 0.01
      provider:
        wavefront:
          address: https://wavefront.example.com
          query: |
            ts(
              "request.errors.rate",
              service={{args.service-name}} and env=production
            )
          secretRef:
            name: wavefront-token
```

### Web (HTTP) Analysis — Custom Health Endpoints

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: http-healthcheck
  namespace: production
spec:
  args:
    - name: canary-url

  metrics:
    - name: canary-health
      interval: 30s
      count: 10
      successCondition: result == 200
      failureCondition: result >= 500
      provider:
        web:
          url: "{{args.canary-url}}/healthz"
          timeoutSeconds: 10
          headers:
            - key: X-Internal-Check
              value: argo-rollouts

    - name: canary-readiness
      interval: 30s
      count: 5
      successCondition: result == 200
      provider:
        web:
          url: "{{args.canary-url}}/readyz"
          timeoutSeconds: 5
          jsonPath: "$.status"  # evaluate specific JSON field
```

## AnalysisRun: Observing Active Analysis

AnalysisRuns are created automatically by the Rollouts controller when an analysis step is reached. You can also create them manually for testing.

```bash
# Observe an active AnalysisRun
kubectl argo rollouts get rollout my-api -n production
kubectl get analysisrun -n production

# Detailed analysis output
kubectl describe analysisrun my-api-5d9f4b7c8-success-rate-check -n production

# Watch in real time
kubectl argo rollouts get rollout my-api -n production --watch
```

```bash
# Sample kubectl argo rollouts get output
Name:            my-api
Namespace:       production
Status:          ॅ Paused
Message:         CanaryPauseStep
Strategy:        Canary
  Step:          4/7
  SetWeight:     20
  ActualWeight:  20
Replicas:
  Desired:       10
  Current:       10
  Updated:       2
  Ready:         10
  Available:     10

NAME                                   KIND        STATUS     AGE    INFO
⟳ my-api                               Rollout     ॅ Paused   23m
├──# revision:2                                               23m
│  ├──⧉ my-api-canary-7d94f6b9df       ReplicaSet  ✔ Healthy  23m    canary,2/2 replicas
│  └──# AnalysisRun/my-api-a2-success  AnalysisRun ✔ Running  20m    ✔ 3/5
└──# revision:1
   └──⧉ my-api-stable-6c8f4b7f9d       ReplicaSet  ✔ Healthy  45m    stable,8/10 replicas
```

## Manual Promotion and Abort

The manual pause step (`pause: {}`) holds the rollout until an operator explicitly promotes or aborts.

```bash
# Promote — advance past the current pause step
kubectl argo rollouts promote my-api -n production

# Full promotion — skip all remaining steps and complete rollout immediately
kubectl argo rollouts promote my-api -n production --full

# Abort — roll back to stable
kubectl argo rollouts abort my-api -n production

# Retry after fixing an issue
kubectl argo rollouts retry rollout my-api -n production

# Undo a completed rollout (roll back to previous revision)
kubectl argo rollouts undo my-api -n production
```

## GitOps Integration with Argo CD

Argo Rollouts integrates naturally with Argo CD for GitOps-driven canary deployments.

```yaml
# argocd-application.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: my-api
  namespace: argocd
spec:
  project: production
  source:
    repoURL: https://git.example.com/my-org/my-api.git
    targetRevision: HEAD
    path: deploy/production
  destination:
    server: https://kubernetes.default.svc
    namespace: production
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
  # Respect Rollout pause steps — don't force-sync past pauses
  ignoreDifferences:
    - group: argoproj.io
      kind: Rollout
      jsonPointers:
        - /spec/paused
```

## Notifications and Alerting

Configure Argo Rollouts to send notifications when analysis fails or a rollout is paused waiting for human approval.

```yaml
# rollout-with-notifications.yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: my-api
  namespace: production
  annotations:
    # Argo CD Notifications integration
    notifications.argoproj.io/subscribe.on-rollout-paused.slack: canary-approvals
    notifications.argoproj.io/subscribe.on-analysis-error.slack: platform-alerts
    notifications.argoproj.io/subscribe.on-rollout-aborted.pagerduty: platform-oncall
spec:
  # ... same as before ...
```

```yaml
# notification-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argo-rollouts-notification-cm
  namespace: argo-rollouts
data:
  # Slack notification template
  template.rollout-paused: |
    message: |
      :pause_button: Rollout *{{.rollout.metadata.name}}* is paused waiting for approval.
      Namespace: `{{.rollout.metadata.namespace}}`
      Current weight: {{.rollout.status.canary.currentStepWeight}}%
      Promote command:
      ```
      kubectl argo rollouts promote {{.rollout.metadata.name}} -n {{.rollout.metadata.namespace}}
      ```
  template.analysis-error: |
    message: |
      :x: Analysis failed for *{{.rollout.metadata.name}}*
      Metric: {{.context.metricName}}
      Value: {{.context.metricValue}}
      Rollout will abort automatically.

  # Service configuration
  service.slack: |
    token: $SLACK_TOKEN
  service.pagerduty: |
    serviceKeys:
      platform-oncall: $PAGERDUTY_SERVICE_KEY
```

## Advanced: Background Analysis

Background analysis runs continuously throughout the entire rollout, not just at specific steps. This is useful for detecting slow degradation that step-based analysis might miss.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: my-api
  namespace: production
spec:
  strategy:
    canary:
      # Background analysis runs alongside all steps
      analysis:
        templates:
          - templateName: background-continuous-check
        args:
          - name: service-name
            value: my-api
        # Start analysis after the canary reaches at least 5% traffic
        startingStep: 1
      steps:
        - setWeight: 5
        - pause:
            duration: 5m
        - setWeight: 25
        - pause:
            duration: 10m
        - setWeight: 50
        - pause: {}
        - setWeight: 100
---
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: background-continuous-check
  namespace: production
spec:
  args:
    - name: service-name

  metrics:
    - name: continuous-error-rate
      # Run every 2 minutes indefinitely
      interval: 2m
      # No count limit — runs for the entire rollout duration
      successCondition: result[0] < 0.02
      failureCondition: result[0] >= 0.10
      failureLimit: 3  # 3 consecutive failures before aborting
      provider:
        prometheus:
          address: http://prometheus-operated.monitoring.svc.cluster.local:9090
          query: |
            sum(rate(http_requests_total{
              service="{{args.service-name}}", status_class=~"5xx"
            }[5m]))
            /
            sum(rate(http_requests_total{
              service="{{args.service-name}}"
            }[5m]))

    - name: canary-pod-restarts
      interval: 5m
      successCondition: result[0] == 0
      failureCondition: result[0] > 2
      failureLimit: 1
      provider:
        prometheus:
          address: http://prometheus-operated.monitoring.svc.cluster.local:9090
          query: |
            increase(
              kube_pod_container_status_restarts_total{
                pod=~"{{args.service-name}}-canary.*"
              }[10m]
            )
```

## Rollout with Istio Traffic Management

Argo Rollouts integrates with Istio to use weighted VirtualService rules for precise traffic splitting (not replica-count-based):

```yaml
# rollout-istio.yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: my-api
  namespace: production
spec:
  strategy:
    canary:
      canaryService: my-api-canary   # Service pointing to canary pods
      stableService: my-api-stable   # Service pointing to stable pods
      trafficRouting:
        istio:
          virtualServices:
            - name: my-api-vsvc
              routes:
                - primary
      steps:
        - setWeight: 5
        - analysis:
            templates:
              - templateName: success-rate-check
            args:
              - name: service-name
                value: my-api
        - setWeight: 25
        - pause:
            duration: 10m
        - setWeight: 50
        - pause: {}
---
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: my-api-vsvc
  namespace: production
spec:
  hosts:
    - my-api
  http:
    - name: primary
      route:
        - destination:
            host: my-api-stable
          weight: 100
        - destination:
            host: my-api-canary
          weight: 0  # Argo Rollouts will update these weights
```

## Testing AnalysisTemplates Locally

Before deploying, validate your PromQL queries return sensible values:

```bash
# Test a PromQL query directly
curl -s 'http://prometheus.example.com/api/v1/query?query=sum(rate(http_requests_total{service="my-api",status_class="2xx"}[5m]))/sum(rate(http_requests_total{service="my-api"}[5m]))' \
  | jq '.data.result[0].value[1]'

# Create an AnalysisRun manually to test the template
kubectl create -f - <<EOF
apiVersion: argoproj.io/v1alpha1
kind: AnalysisRun
metadata:
  generateName: manual-test-
  namespace: production
spec:
  templates:
    - templateName: success-rate-check
  args:
    - name: service-name
      value: my-api
EOF

# Watch the run
kubectl get analysisrun -n production -w
kubectl describe analysisrun manual-test-xxxxx -n production
```

## Summary

Argo Rollouts provides a complete platform for automated canary delivery:

- **Rollout steps** define the traffic progression with explicit weights, pauses, and analysis checkpoints.
- **AnalysisTemplate** encodes your SLOs as pass/fail conditions queried from Prometheus, Datadog, Wavefront, or custom HTTP endpoints.
- **Background analysis** catches gradual degradation that step-based checks might miss.
- **Manual promotion gates** preserve human oversight at critical thresholds while automating the routine verification work.
- **Istio integration** provides sub-1% traffic splitting accuracy independent of replica count.

The key discipline is writing AnalysisTemplates that match your actual SLOs — not generic percentage thresholds, but the specific latency and error rate targets your team has committed to. Templates that reflect real SLOs make automated pass/fail decisions trustworthy, which is the prerequisite for removing manual approval steps from routine deployments.
