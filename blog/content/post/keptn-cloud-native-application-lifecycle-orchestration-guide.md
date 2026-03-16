---
title: "Keptn Lifecycle Toolkit: Cloud-Native Deployment Observability and Quality Gates"
date: 2027-02-14T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Keptn", "SLO", "Deployment", "Observability"]
categories: ["Kubernetes", "Observability", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete production guide to the Keptn Lifecycle Toolkit: KeptnApp, pre/post deployment tasks, quality gates with SLO evaluation, DORA metrics, ArgoCD/Flux integration, and OpenTelemetry deployment tracing."
more_link: "yes"
url: "/keptn-cloud-native-application-lifecycle-orchestration-guide/"
---

Deploying an application to Kubernetes marks the beginning, not the end, of the deployment process. Verifying that the new version meets performance and reliability targets, executing pre-flight checks, notifying downstream systems, and collecting deployment telemetry are all part of a production deployment workflow. The **Keptn Lifecycle Toolkit (KLT)** instruments all of these activities natively within Kubernetes using standard CRDs, without requiring a separate orchestration pipeline. It instruments existing deployments by watching standard Kubernetes objects and adding lifecycle hooks around them.

<!--more-->

## KLT Architecture vs Legacy Keptn

The Keptn project underwent a major architectural redesign. Legacy Keptn (0.x series) was a microservices orchestration platform with a control plane, event broker, and integrations. The **Keptn Lifecycle Toolkit (1.x series)**, now the actively maintained project, takes a fundamentally different approach:

| Aspect | Legacy Keptn | Keptn Lifecycle Toolkit |
|---|---|---|
| Architecture | Centralized control plane + event broker | Kubernetes operators; no central control plane |
| Integration | Requires Keptn integration plugins | Watches standard Kubernetes objects |
| Deployment awareness | Requires Keptn service definitions | Detects deployments from labels |
| Configuration | Keptn project/service/stage YAML | Kubernetes CRDs |
| GitOps compatibility | Via Keptn GitOps bridge | Native; works with ArgoCD/Flux out of the box |

KLT consists of three main operators:

**Lifecycle Operator**: Watches Deployments, StatefulSets, and DaemonSets labeled for Keptn management. It creates `KeptnWorkloadVersion` objects as deployments progress and orchestrates pre/post deployment tasks and evaluations.

**Metrics Operator**: Manages `KeptnMetric` and `KeptnMetricsProvider` CRDs. It fetches metrics from external sources (Prometheus, Dynatrace, Datadog) and makes them available for evaluation.

**Certificate Operator**: Manages TLS certificates for the operator webhooks.

## Installing the Keptn Lifecycle Toolkit

### Helm Installation

```bash
helm repo add keptn https://charts.lifecycle.keptn.sh
helm repo update

helm install keptn keptn/keptn \
  --namespace keptn-system \
  --create-namespace \
  --version 2.3.0 \
  --set lifecycleOperator.resources.requests.cpu=200m \
  --set lifecycleOperator.resources.requests.memory=256Mi \
  --set metricsOperator.resources.requests.cpu=100m \
  --set metricsOperator.resources.requests.memory=128Mi
```

Verify the installation:

```bash
kubectl get pods -n keptn-system
# NAME                                              READY   STATUS    RESTARTS
# keptn-lifecycle-operator-5d8b6f9c4d-xk7rp        1/1     Running   0
# keptn-metrics-operator-7c9f4d5b8-mzr9q           1/1     Running   0
# keptn-cert-operator-6b7c8d9e5f-pk4lm             1/1     Running   0

kubectl get crd | grep keptn
# keptnappcontexts.lifecycle.keptn.sh
# keptnappversions.lifecycle.keptn.sh
# keptnapps.lifecycle.keptn.sh
# keptnevaluationdefinitions.lifecycle.keptn.sh
# keptnevaluations.lifecycle.keptn.sh
# keptnmetrics.metrics.keptn.sh
# keptnmetricsproviders.metrics.keptn.sh
# keptntaskdefinitions.lifecycle.keptn.sh
# keptntasks.lifecycle.keptn.sh
# keptnworkloadinstances.lifecycle.keptn.sh  (deprecated, use KeptnWorkloadVersion)
# keptnworkloadversions.lifecycle.keptn.sh
# keptnworkloads.lifecycle.keptn.sh
```

## KeptnApp CRD

### Defining an Application

A `KeptnApp` groups related workloads (Deployments, StatefulSets) into a logical application boundary. Pre-deployment tasks and evaluations run at the application level before any workload in the app is updated:

```yaml
apiVersion: lifecycle.keptn.sh/v1
kind: KeptnApp
metadata:
  name: payment-service
  namespace: production
spec:
  version: "2.4.0"
  workloads:
  - name: payment-api
    version: "2.4.0"
  - name: payment-worker
    version: "2.4.0"
  preDeploymentTasks:
  - notify-slack-pre-deploy
  - validate-dependencies
  postDeploymentTasks:
  - notify-slack-post-deploy
  - run-smoke-tests
  preDeploymentEvaluations:
  - evaluate-downstream-health
  postDeploymentEvaluations:
  - evaluate-error-rate
  - evaluate-latency-p99
```

### Automatic KeptnApp Creation

KLT can automatically create `KeptnApp` objects by discovering workloads that share an application label. Add the `keptn.sh/app` annotation to existing Deployments:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-api
  namespace: production
  annotations:
    # Keptn lifecycle management annotations
    keptn.sh/app: payment-service
    keptn.sh/workload: payment-api
    keptn.sh/version: "2.4.0"
    # Pre/post deployment hooks
    keptn.sh/pre-deployment-tasks: validate-dependencies
    keptn.sh/post-deployment-tasks: run-smoke-tests
    keptn.sh/post-deployment-evaluations: evaluate-error-rate,evaluate-latency-p99
spec:
  replicas: 3
  selector:
    matchLabels:
      app: payment-api
  template:
    metadata:
      labels:
        app: payment-api
        keptn.sh/app: payment-service
        keptn.sh/workload: payment-api
        keptn.sh/version: "2.4.0"
    spec:
      containers:
      - name: api
        image: registry.example.com/payment-api:2.4.0
        ports:
        - containerPort: 8080
        resources:
          requests:
            cpu: "500m"
            memory: "512Mi"
          limits:
            cpu: "2"
            memory: "1Gi"
```

When Kubernetes applies this Deployment, the Keptn Lifecycle Operator detects the `keptn.sh/app` label and automatically creates or updates the corresponding `KeptnApp` and `KeptnWorkload` objects.

## KeptnWorkloadVersion Automatic Detection

The Lifecycle Operator watches for changes to labeled Deployments and creates `KeptnWorkloadVersion` objects to track each deployment lifecycle:

```bash
# After deploying, watch KeptnWorkloadVersions
kubectl get keptnworkloadversions -n production -w

# NAME                                    APP              VERSION   PHASE
# payment-api-2.4.0-xyz123               payment-service  2.4.0     PreDeploymentTasks
# payment-api-2.4.0-xyz123               payment-service  2.4.0     PreDeploymentEvaluations
# payment-api-2.4.0-xyz123               payment-service  2.4.0     Deployment
# payment-api-2.4.0-xyz123               payment-service  2.4.0     PostDeploymentTasks
# payment-api-2.4.0-xyz123               payment-service  2.4.0     PostDeploymentEvaluations
# payment-api-2.4.0-xyz123               payment-service  2.4.0     Completed
```

The phase field tracks the workload through its lifecycle. If a pre-deployment task fails, the phase stays at `PreDeploymentTasksFailed` and the Deployment rollout is blocked.

## Pre/Post Deployment Tasks with KeptnTaskDefinition

### Deno Runtime Tasks

KLT uses **Deno** (TypeScript/JavaScript runtime) as the default task runtime. Tasks run as Kubernetes Jobs:

```yaml
# Slack notification task using Deno
apiVersion: lifecycle.keptn.sh/v1
kind: KeptnTaskDefinition
metadata:
  name: notify-slack-pre-deploy
  namespace: keptn-system
spec:
  deno:
    inline:
      code: |
        const slackWebhookUrl = Deno.env.get("SLACK_WEBHOOK_URL");
        const appName = Deno.env.get("KEPTN_APP");
        const appVersion = Deno.env.get("KEPTN_APP_VERSION");
        const namespace = Deno.env.get("KEPTN_NAMESPACE");

        const message = {
          text: `Deployment starting: *${appName}* version *${appVersion}* in namespace *${namespace}*`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `:rocket: Deployment starting\n*App:* ${appName}\n*Version:* ${appVersion}\n*Namespace:* ${namespace}`
              }
            }
          ]
        };

        const response = await fetch(slackWebhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(message)
        });

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Slack notification failed: ${error}`);
        }
        console.log("Slack notification sent successfully");
    envFrom:
    - secretRef:
        name: slack-webhook-secret
```

```yaml
# Secret for Slack webhook
apiVersion: v1
kind: Secret
metadata:
  name: slack-webhook-secret
  namespace: keptn-system
type: Opaque
stringData:
  SLACK_WEBHOOK_URL: "EXAMPLE_WEBHOOK_URL_REPLACE_ME"
```

### Python Runtime Tasks

KLT also supports Python tasks for teams more comfortable with that ecosystem:

```yaml
apiVersion: lifecycle.keptn.sh/v1
kind: KeptnTaskDefinition
metadata:
  name: validate-dependencies
  namespace: keptn-system
spec:
  python:
    inline:
      code: |
        import os
        import urllib.request
        import json
        import sys

        # Check that downstream services are healthy before deployment
        dependencies = [
            {"name": "database", "url": "http://postgres-primary.data.svc.cluster.local:5432"},
            {"name": "cache", "url": "http://redis-master.cache.svc.cluster.local:6379"},
            {"name": "message-bus", "url": "http://rabbitmq.messaging.svc.cluster.local:15672/api/healthchecks/node"}
        ]

        failed = []
        for dep in dependencies:
            try:
                req = urllib.request.Request(dep["url"])
                with urllib.request.urlopen(req, timeout=5) as resp:
                    if resp.status != 200:
                        failed.append(f"{dep['name']}: HTTP {resp.status}")
            except Exception as e:
                failed.append(f"{dep['name']}: {str(e)}")

        if failed:
            print(f"Dependency validation FAILED: {', '.join(failed)}")
            sys.exit(1)
        else:
            print("All dependencies healthy")
```

### Container-Based Tasks

For tasks requiring specific tools or languages, use a container image:

```yaml
apiVersion: lifecycle.keptn.sh/v1
kind: KeptnTaskDefinition
metadata:
  name: run-smoke-tests
  namespace: keptn-system
spec:
  container:
    name: smoke-tests
    image: registry.example.com/smoke-tests:1.2.0
    command: ["/bin/sh"]
    args:
    - -c
    - |
      APP_URL="http://${KEPTN_WORKLOAD}.${KEPTN_NAMESPACE}.svc.cluster.local"
      echo "Running smoke tests against ${APP_URL}"
      # Run k6 smoke test suite
      k6 run \
        --env TARGET_URL="${APP_URL}" \
        --out json=/tmp/results.json \
        /tests/smoke.js

      # Check error rate in results
      ERROR_RATE=$(cat /tmp/results.json | \
        jq '[.metrics.http_req_failed.values.rate] | add / length')
      if (( $(echo "$ERROR_RATE > 0.01" | bc -l) )); then
        echo "Smoke tests failed: error rate ${ERROR_RATE} exceeds 1%"
        exit 1
      fi
      echo "Smoke tests passed"
    env:
    - name: KEPTN_WORKLOAD
      valueFrom:
        fieldRef:
          fieldPath: metadata.labels['keptn.sh/workload']
    - name: KEPTN_NAMESPACE
      valueFrom:
        fieldRef:
          fieldPath: metadata.namespace
    resources:
      requests:
        cpu: "200m"
        memory: "256Mi"
```

## Deployment Quality Gates with Prometheus SLI Evaluation

### Configuring a KeptnMetricsProvider

First, configure the metrics source:

```yaml
apiVersion: metrics.keptn.sh/v1
kind: KeptnMetricsProvider
metadata:
  name: prometheus
  namespace: production
spec:
  type: prometheus
  targetServer: "http://prometheus-operated.monitoring.svc.cluster.local:9090"
```

### KeptnMetric CRDs for Custom Metrics

`KeptnMetric` objects fetch and cache metric values from providers, making them available for evaluation:

```yaml
# Error rate metric
apiVersion: metrics.keptn.sh/v1
kind: KeptnMetric
metadata:
  name: payment-api-error-rate
  namespace: production
spec:
  provider:
    name: prometheus
  query: |
    sum(rate(http_requests_total{job="payment-api",status=~"5.."}[5m]))
    /
    sum(rate(http_requests_total{job="payment-api"}[5m]))
  fetchIntervalSeconds: 30
---
# P99 latency metric
apiVersion: metrics.keptn.sh/v1
kind: KeptnMetric
metadata:
  name: payment-api-latency-p99
  namespace: production
spec:
  provider:
    name: prometheus
  query: |
    histogram_quantile(0.99,
      sum(rate(http_request_duration_seconds_bucket{job="payment-api"}[5m]))
      by (le)
    )
  fetchIntervalSeconds: 30
---
# Throughput metric
apiVersion: metrics.keptn.sh/v1
kind: KeptnMetric
metadata:
  name: payment-api-throughput
  namespace: production
spec:
  provider:
    name: prometheus
  query: |
    sum(rate(http_requests_total{job="payment-api",status!~"5.."}[5m]))
  fetchIntervalSeconds: 30
```

Check current metric values:

```bash
kubectl get keptnmetrics -n production
# NAME                           PROVIDER     QUERY                    VALUE   STATUS
# payment-api-error-rate         prometheus   sum(rate(...)...)        0.002   Available
# payment-api-latency-p99        prometheus   histogram_quantile(...)  0.145   Available
# payment-api-throughput         prometheus   sum(rate(...)...)        245.3   Available
```

### KeptnEvaluationDefinition for Pass/Fail Criteria

```yaml
# Post-deployment quality gate: error rate must be below 1%
apiVersion: lifecycle.keptn.sh/v1
kind: KeptnEvaluationDefinition
metadata:
  name: evaluate-error-rate
  namespace: production
spec:
  objectives:
  - keptnMetricRef:
      name: payment-api-error-rate
      namespace: production
    evaluationTarget: "<0.01"  # Error rate must be below 1%
---
# Post-deployment quality gate: P99 latency must be below 500ms
apiVersion: lifecycle.keptn.sh/v1
kind: KeptnEvaluationDefinition
metadata:
  name: evaluate-latency-p99
  namespace: production
spec:
  objectives:
  - keptnMetricRef:
      name: payment-api-latency-p99
      namespace: production
    evaluationTarget: "<0.5"  # P99 latency must be below 500ms (in seconds)
---
# Pre-deployment evaluation: downstream services must be healthy
apiVersion: lifecycle.keptn.sh/v1
kind: KeptnEvaluationDefinition
metadata:
  name: evaluate-downstream-health
  namespace: production
spec:
  objectives:
  - keptnMetricRef:
      name: database-availability
      namespace: production
    evaluationTarget: ">=0.999"  # 99.9% availability required
```

### Monitoring Evaluations

```bash
# Watch evaluation results
kubectl get keptnevaluations -n production -w

# NAME                                     APP              VERSION   STATUS   PASS   FAIL
# evaluate-error-rate-payment-2.4.0-abc   payment-service  2.4.0     Pass     1      0
# evaluate-latency-p99-payment-2.4.0-abc  payment-service  2.4.0     Pass     1      0

# Get detailed evaluation results
kubectl describe keptnevaluation evaluate-error-rate-payment-2.4.0-abc -n production
```

## Automatic Traffic Delay with Pre-Deployment Evaluations

When a `KeptnApp` has `preDeploymentEvaluations`, the Lifecycle Operator holds the Deployment rollout until all evaluations pass. This prevents deploying to a cluster that is already under stress:

```yaml
apiVersion: lifecycle.keptn.sh/v1
kind: KeptnApp
metadata:
  name: payment-service
  namespace: production
spec:
  version: "2.5.0"
  workloads:
  - name: payment-api
    version: "2.5.0"
  # These evaluations must pass before the Deployment rollout starts
  preDeploymentEvaluations:
  - evaluate-downstream-health
  # These tasks run after all evaluations pass
  preDeploymentTasks:
  - notify-slack-pre-deploy
  # These evaluations run after the rollout completes
  postDeploymentEvaluations:
  - evaluate-error-rate
  - evaluate-latency-p99
```

If `evaluate-downstream-health` fails, the `KeptnAppVersion` enters `PreDeploymentEvaluationsFailed` phase and the deployment does not proceed. This is enforced by an admission webhook that blocks the Deployment's pod template updates until the Keptn gate opens.

## DORA Metrics Collection

KLT automatically collects DORA (DevOps Research and Assessment) metrics for all managed workloads:

| DORA Metric | How KLT Measures It |
|---|---|
| Deployment Frequency | Count of `KeptnAppVersion` completions per time window |
| Lead Time for Changes | Duration from `KeptnAppVersion` creation to completion |
| Change Failure Rate | Percentage of `KeptnAppVersion` objects that end in `Failed` phase |
| Time to Restore | Duration of `KeptnAppVersion` rollback workflows |

These metrics are exported to Prometheus automatically:

```promql
# Deployment frequency (last 30 days)
count_over_time(
  keptn_app_deployment_count{namespace="production",app="payment-service"}[30d]
)

# Lead time for changes (average, in seconds)
avg(keptn_app_deployment_duration_seconds{namespace="production",app="payment-service"})

# Change failure rate
sum(keptn_app_deployment_failed_total{namespace="production"})
/
sum(keptn_app_deployment_total{namespace="production"})
```

### Grafana Dashboard for DORA Metrics

```json
{
  "title": "DORA Metrics - Keptn Lifecycle Toolkit",
  "panels": [
    {
      "title": "Deployment Frequency (per day)",
      "type": "stat",
      "targets": [
        {
          "expr": "sum(increase(keptn_app_deployment_count{namespace=\"production\"}[1d]))"
        }
      ]
    },
    {
      "title": "Mean Lead Time (minutes)",
      "type": "stat",
      "targets": [
        {
          "expr": "avg(keptn_app_deployment_duration_seconds{namespace=\"production\"}) / 60"
        }
      ]
    },
    {
      "title": "Change Failure Rate (%)",
      "type": "stat",
      "targets": [
        {
          "expr": "100 * sum(keptn_app_deployment_failed_total{namespace=\"production\"}) / sum(keptn_app_deployment_total{namespace=\"production\"})"
        }
      ]
    }
  ]
}
```

## Integration with ArgoCD and Flux

### ArgoCD Integration

KLT works natively with ArgoCD because it operates at the Kubernetes API level. When ArgoCD syncs an Application, the Lifecycle Operator detects the workload update through the Deployment watch and initiates the Keptn lifecycle.

The key requirement is that the Deployment manifest in the GitOps repository includes the Keptn annotations:

```yaml
# In the ArgoCD-managed Git repository
# apps/payment-service/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-api
  namespace: production
  annotations:
    keptn.sh/app: payment-service
    keptn.sh/workload: payment-api
    keptn.sh/version: "2.5.0"
    keptn.sh/pre-deployment-evaluations: evaluate-downstream-health
    keptn.sh/post-deployment-evaluations: evaluate-error-rate,evaluate-latency-p99
    keptn.sh/post-deployment-tasks: notify-slack-post-deploy
```

When ArgoCD syncs this, Keptn automatically intercepts the rollout.

### Blocking ArgoCD Sync with Keptn Gate

To prevent ArgoCD from considering a sync successful until Keptn quality gates pass, use the `argocd.argoproj.io/hook` annotation in a Keptn-aware resource health check:

```yaml
# ArgoCD Application resource health check for KeptnAppVersion
# Stored in ArgoCD ConfigMap: argocd-cm
resource.customizations.health.lifecycle.keptn.sh_KeptnAppVersion: |
  hs = {}
  if obj.status ~= nil then
    if obj.status.status == "Completed" then
      hs.status = "Healthy"
      hs.message = "Keptn deployment lifecycle completed"
    elseif obj.status.status == "Failed" or obj.status.status == "Deprecated" then
      hs.status = "Degraded"
      hs.message = obj.status.status
    else
      hs.status = "Progressing"
      hs.message = obj.status.status or "In progress"
    end
  end
  return hs
```

### Flux Integration

For Flux-managed clusters, the same annotation approach works. Keptn's webhook ensures the Deployment rollout is blocked until gates pass, regardless of whether Flux or another tool triggered the deployment:

```yaml
# Flux Kustomization that triggers Keptn lifecycle
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: payment-service
  namespace: flux-system
spec:
  interval: 5m
  path: ./apps/payment-service
  prune: true
  sourceRef:
    kind: GitRepository
    name: flux-system
  healthChecks:
  - apiVersion: lifecycle.keptn.sh/v1
    kind: KeptnAppVersion
    name: payment-service-2.5.0
    namespace: production
  timeout: 10m
```

The Flux `healthChecks` block causes Flux to wait for the `KeptnAppVersion` to reach a healthy state before marking the Kustomization as ready.

## OpenTelemetry Tracing for Deployments

KLT exports distributed traces for the entire deployment lifecycle using OpenTelemetry. Each phase (pre-task, evaluation, rollout, post-task) becomes a span within a deployment trace:

### Configuring OpenTelemetry Export

```yaml
# Configure KLT to export traces to an OTel collector
apiVersion: v1
kind: ConfigMap
metadata:
  name: keptn-config
  namespace: keptn-system
data:
  # OpenTelemetry collector endpoint
  otelCollectorUrl: "otel-collector.monitoring.svc.cluster.local:4317"
```

### Viewing Deployment Traces in Jaeger

With traces exported, each deployment appears in Jaeger as a trace spanning the full deployment lifecycle:

```
Trace: payment-service v2.5.0 deployment
├── Span: PreDeploymentEvaluations (2.3s)
│   └── Span: evaluate-downstream-health (2.1s) - PASS
├── Span: PreDeploymentTasks (5.8s)
│   └── Span: notify-slack-pre-deploy (0.9s) - Success
├── Span: Deployment (47.2s)
│   ├── Span: RollingUpdate pod 1/3 (14.8s)
│   ├── Span: RollingUpdate pod 2/3 (15.1s)
│   └── Span: RollingUpdate pod 3/3 (14.9s)
├── Span: PostDeploymentTasks (12.4s)
│   └── Span: run-smoke-tests (11.8s) - Success
└── Span: PostDeploymentEvaluations (3.1s)
    ├── Span: evaluate-error-rate (1.4s) - PASS (0.001 < 0.01)
    └── Span: evaluate-latency-p99 (1.5s) - PASS (0.142s < 0.5s)
```

## Monitoring the Lifecycle Operator Itself

### Key Metrics

The Lifecycle Operator exposes Prometheus metrics on port 8080:

```yaml
# ServiceMonitor for Keptn Lifecycle Operator
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: keptn-lifecycle-operator
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: lifecycle-operator
  namespaceSelector:
    matchNames:
    - keptn-system
  endpoints:
  - port: metrics
    interval: 30s
    path: /metrics
```

Key metrics to monitor:

```promql
# Task execution failures
rate(keptn_task_count{status="Failed"}[5m])

# Evaluation failures
rate(keptn_evaluation_count{status="Failed"}[5m])

# Active deployments in progress
keptn_app_active_count

# Gate hold duration (how long deployments are delayed by gates)
histogram_quantile(0.95, rate(keptn_deployment_duration_seconds_bucket[1h]))
```

### Alerting Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: keptn-alerts
  namespace: monitoring
spec:
  groups:
  - name: keptn.lifecycle
    rules:
    - alert: KeptnTasksFailingRepeatedly
      expr: |
        rate(keptn_task_count{status="Failed"}[30m]) > 0.1
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Keptn pre/post deployment tasks are failing"
        description: "Task failure rate is {{ $value | humanize }} per second over the last 30 minutes"

    - alert: KeptnQualityGateBlocking
      expr: |
        keptn_app_active_count{phase="PreDeploymentEvaluations"} > 0
      for: 30m
      labels:
        severity: warning
      annotations:
        summary: "Keptn quality gate has been blocking a deployment for 30+ minutes"
        description: "App {{ $labels.app }} in {{ $labels.namespace }} is blocked at pre-deployment evaluations"

    - alert: KeptnOperatorUnhealthy
      expr: |
        up{job="keptn-lifecycle-operator"} == 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Keptn Lifecycle Operator is down"
        description: "The Keptn Lifecycle Operator has been unavailable for 5+ minutes; deployment lifecycle management is disabled"
```

## Production Best Practices

### Version Consistency

The `keptn.sh/version` annotation on the Deployment must be updated with each release. If the version annotation stays the same across two deployments (same image, same tag, different environment), Keptn treats them as the same workload version and skips lifecycle management. Use the image digest or a semantic version tied to your release process:

```bash
# In a CI/CD pipeline, extract the image digest and use it as the version
IMAGE_DIGEST=$(docker inspect \
  registry.example.com/payment-api:2.5.0 \
  --format='{{index .RepoDigests 0}}' | cut -d@ -f2 | cut -c1-12)

kubectl set annotation deployment payment-api \
  keptn.sh/version="2.5.0-${IMAGE_DIGEST}" \
  -n production
```

### Timeout Configuration for Tasks and Evaluations

Tasks and evaluations that run indefinitely can block deployments. Configure timeouts:

```yaml
apiVersion: lifecycle.keptn.sh/v1
kind: KeptnTaskDefinition
metadata:
  name: run-smoke-tests
  namespace: keptn-system
spec:
  # Fail if the task does not complete within 5 minutes
  timeout: 5m
  retries: 2
  container:
    name: smoke-tests
    image: registry.example.com/smoke-tests:1.2.0
```

### Namespace-Level Task Definitions

`KeptnTaskDefinition` objects can be created in the `keptn-system` namespace (cluster-wide) or in the application namespace (namespace-scoped). Namespace-scoped definitions override cluster-wide ones, allowing teams to customize behavior without cluster-admin access:

```yaml
# Team-specific override in production namespace
apiVersion: lifecycle.keptn.sh/v1
kind: KeptnTaskDefinition
metadata:
  name: notify-slack-post-deploy
  namespace: production  # Overrides the keptn-system version
spec:
  deno:
    inline:
      code: |
        const channel = "#payments-deploys";  # Team-specific channel
        // ... rest of notification code
```
