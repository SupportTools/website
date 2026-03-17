---
title: "Kubernetes Argo Rollouts: Canary Analysis with Prometheus and Datadog Metrics"
date: 2031-03-27T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Argo Rollouts", "Canary", "Prometheus", "Datadog", "Progressive Delivery", "Istio"]
categories:
- Kubernetes
- CI/CD
- Progressive Delivery
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Argo Rollouts canary deployments with automated metric-based analysis using Prometheus, Datadog, and New Relic providers, including blue-green with AnalysisRun, automated rollback, and Istio traffic shifting integration."
more_link: "yes"
url: "/kubernetes-argo-rollouts-canary-analysis-prometheus-datadog/"
---

Argo Rollouts transforms Kubernetes deployments from binary switch-overs into progressive delivery pipelines where metric-based analysis gates each traffic increment. Instead of hoping a new version works, the system automatically queries your observability stack — Prometheus, Datadog, New Relic — and rolls back if error rates or latency thresholds are breached.

This guide covers the full implementation: AnalysisTemplate configuration for each metrics provider, canary step progression logic, automated rollback triggers, blue-green deployment with AnalysisRun, and the Istio service mesh integration for precise traffic weight control at the VirtualService level.

<!--more-->

# Kubernetes Argo Rollouts: Canary Analysis with Prometheus and Datadog Metrics

## Section 1: Installation and Architecture

### Deploying Argo Rollouts

```bash
# Install Argo Rollouts controller
kubectl create namespace argo-rollouts

kubectl apply -n argo-rollouts \
  -f https://github.com/argoproj/argo-rollouts/releases/latest/download/install.yaml

# Verify installation
kubectl get pods -n argo-rollouts

# Install kubectl argo rollouts plugin
curl -LO https://github.com/argoproj/argo-rollouts/releases/latest/download/kubectl-argo-rollouts-linux-amd64
chmod +x ./kubectl-argo-rollouts-linux-amd64
sudo mv ./kubectl-argo-rollouts-linux-amd64 /usr/local/bin/kubectl-argo-rollouts

# Verify plugin
kubectl argo rollouts version
```

### Architecture Overview

Argo Rollouts extends Kubernetes with a `Rollout` resource that replaces `Deployment`. During a canary deployment:

1. A new ReplicaSet is created for the canary version
2. Traffic splits between stable and canary ReplicaSets according to configured steps
3. `AnalysisRun` objects query metrics providers at each step
4. On success: the next step executes (more traffic to canary)
5. On failure: automatic rollback restores stable version

Traffic splitting uses one of:
- **Native ReplicaSet splitting**: approximate splits based on replica count ratio
- **Istio VirtualService**: precise weight-based routing at L7
- **AWS ALB/NGINX**: annotation-based traffic splitting

## Section 2: AnalysisTemplate Configuration

### Prometheus AnalysisTemplate

```yaml
# prometheus-analysis-template.yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: prometheus-success-rate
  namespace: production
spec:
  args:
    - name: service-name
    - name: canary-hash
    - name: namespace
      value: production
  metrics:
    - name: success-rate
      interval: 60s
      # Number of consecutive successes required to pass
      successCondition: result[0] >= 0.95
      failureCondition: result[0] < 0.90
      # Number of consecutive failures before marking as failed
      failureLimit: 3
      # Provider configuration
      provider:
        prometheus:
          address: http://prometheus-operated.monitoring.svc.cluster.local:9090
          query: |
            sum(
              rate(
                http_requests_total{
                  app="{{ args.service-name }}",
                  pod_template_hash="{{ args.canary-hash }}",
                  status!~"5.."
                }[5m]
              )
            )
            /
            sum(
              rate(
                http_requests_total{
                  app="{{ args.service-name }}",
                  pod_template_hash="{{ args.canary-hash }}"
                }[5m]
              )
            )

    - name: error-rate
      interval: 60s
      successCondition: result[0] < 0.01
      failureCondition: result[0] > 0.05
      failureLimit: 2
      provider:
        prometheus:
          address: http://prometheus-operated.monitoring.svc.cluster.local:9090
          query: |
            sum(
              rate(
                http_requests_total{
                  app="{{ args.service-name }}",
                  pod_template_hash="{{ args.canary-hash }}",
                  status=~"5.."
                }[5m]
              )
            )
            /
            sum(
              rate(
                http_requests_total{
                  app="{{ args.service-name }}",
                  pod_template_hash="{{ args.canary-hash }}"
                }[5m]
              )
            ) or vector(0)

    - name: p99-latency
      interval: 60s
      # P99 latency must be below 500ms
      successCondition: result[0] < 0.5
      failureCondition: result[0] > 1.0
      failureLimit: 2
      provider:
        prometheus:
          address: http://prometheus-operated.monitoring.svc.cluster.local:9090
          query: |
            histogram_quantile(
              0.99,
              sum by(le) (
                rate(
                  http_request_duration_seconds_bucket{
                    app="{{ args.service-name }}",
                    pod_template_hash="{{ args.canary-hash }}"
                  }[5m]
                )
              )
            )
```

### Datadog AnalysisTemplate

```yaml
# datadog-analysis-template.yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: datadog-canary-analysis
  namespace: production
spec:
  args:
    - name: service-name
    - name: env
      value: production
  metrics:
    - name: error-rate-dd
      interval: 2m
      count: 5
      successCondition: result[0] < 0.02
      failureCondition: result[0] > 0.05
      provider:
        datadog:
          # Datadog API/App keys from cluster secret
          apiVersion: v2
          interval: 5m
          query: |
            avg:trace.http.request.errors{service:{{ args.service-name }},
            env:{{ args.env }},version:canary}
            /
            avg:trace.http.request.hits{service:{{ args.service-name }},
            env:{{ args.env }},version:canary}

    - name: p95-latency-dd
      interval: 2m
      count: 5
      successCondition: result[0] < 0.3
      failureCondition: result[0] > 0.8
      provider:
        datadog:
          apiVersion: v2
          interval: 5m
          query: |
            p95:trace.http.request.duration{service:{{ args.service-name }},
            env:{{ args.env }},version:canary}

    - name: apdex-score
      interval: 2m
      count: 5
      # Apdex score between 0-1, require >0.90
      successCondition: result[0] >= 0.90
      failureCondition: result[0] < 0.75
      provider:
        datadog:
          apiVersion: v2
          interval: 5m
          query: |
            apm_stats_count:hits{service:{{ args.service-name }},
            env:{{ args.env }},resource_name:GET /api,version:canary}.as_count()
```

### Configuring Datadog Credentials Secret

```yaml
# datadog-credentials-secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: datadog-api-credentials
  namespace: argo-rollouts
type: Opaque
stringData:
  address: https://api.datadoghq.com
  api-key: <datadog-api-key>
  app-key: <datadog-app-key>
```

```yaml
# Configure Argo Rollouts to use Datadog credentials
# In rollouts-config ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: argo-rollouts-config
  namespace: argo-rollouts
data:
  metricProviders: |
    datadog:
      apiVersion: v2
      secretRef:
        name: datadog-api-credentials
```

### New Relic AnalysisTemplate

```yaml
# newrelic-analysis-template.yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: newrelic-canary-analysis
  namespace: production
spec:
  args:
    - name: app-name
    - name: account-id
  metrics:
    - name: error-rate-nr
      interval: 2m
      count: 5
      successCondition: result[0] < 1.0
      failureCondition: result[0] > 2.0
      provider:
        newRelic:
          profile: default
          query: |
            SELECT percentage(count(*), WHERE error IS true)
            FROM Transaction
            WHERE appName = '{{ args.app-name }}'
            AND request.headers.X-Canary = 'true'
            SINCE 5 minutes ago
```

## Section 3: Complete Canary Rollout Configuration

### Canary Rollout with Step-Based Progression

```yaml
# production-rollout.yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: production-service
  namespace: production
spec:
  replicas: 10
  selector:
    matchLabels:
      app: production-service
  template:
    metadata:
      labels:
        app: production-service
    spec:
      containers:
        - name: service
          image: myregistry/service:stable
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: "500m"
              memory: 512Mi
            limits:
              cpu: "2"
              memory: 1Gi
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 30
            periodSeconds: 10

  strategy:
    canary:
      # Maximum number of pods that can be unavailable during update
      maxUnavailable: 1
      # Maximum number of extra pods during update
      maxSurge: 2

      # Canary steps with traffic percentages and analysis
      steps:
        # Step 1: Route 5% traffic to canary, wait 5 minutes, run quick checks
        - setWeight: 5
        - pause: {duration: 5m}
        - analysis:
            templates:
              - templateName: prometheus-success-rate
            args:
              - name: service-name
                value: production-service
              - name: canary-hash
                valueFrom:
                  podTemplateHashValue: Latest

        # Step 2: Increase to 20%, run analysis for 10 minutes
        - setWeight: 20
        - pause: {duration: 2m}
        - analysis:
            templates:
              - templateName: prometheus-success-rate
              - templateName: datadog-canary-analysis
            args:
              - name: service-name
                value: production-service
              - name: app-name
                value: production-service
              - name: canary-hash
                valueFrom:
                  podTemplateHashValue: Latest

        # Step 3: 50% with extended analysis
        - setWeight: 50
        - pause: {duration: 5m}
        - analysis:
            templates:
              - templateName: prometheus-success-rate
            args:
              - name: service-name
                value: production-service
              - name: canary-hash
                valueFrom:
                  podTemplateHashValue: Latest

        # Step 4: 80% - almost full rollout
        - setWeight: 80
        - pause: {duration: 5m}

        # Step 5: Require manual approval at 80% before going to 100%
        - pause: {}  # Indefinite pause = requires manual promotion

      # Run background analysis throughout the entire rollout
      analysis:
        templates:
          - templateName: prometheus-success-rate
        args:
          - name: service-name
            value: production-service
          - name: canary-hash
            valueFrom:
              podTemplateHashValue: Latest
        startingStep: 1  # Start from step index 1 (after first setWeight)

      # Anti-affinity to spread canary pods across nodes
      antiAffinity:
        requiredDuringSchedulingIgnoredDuringExecution:
          labelSelector:
            matchLabels:
              app: production-service
```

### Service Configuration for Rollouts

```yaml
# rollout-services.yaml
# Stable service: routes to stable ReplicaSet
apiVersion: v1
kind: Service
metadata:
  name: production-service-stable
  namespace: production
spec:
  selector:
    app: production-service
  ports:
    - port: 80
      targetPort: 8080
---
# Canary service: routes only to canary ReplicaSet
apiVersion: v1
kind: Service
metadata:
  name: production-service-canary
  namespace: production
spec:
  selector:
    app: production-service
  ports:
    - port: 80
      targetPort: 8080
```

## Section 4: Istio Traffic Shifting Integration

### Istio-Based Canary with VirtualService

Using Istio enables precise traffic splitting at the service mesh level, independent of replica count:

```yaml
# istio-rollout.yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: production-service-istio
  namespace: production
spec:
  replicas: 10
  selector:
    matchLabels:
      app: production-service
  template:
    metadata:
      labels:
        app: production-service
    spec:
      containers:
        - name: service
          image: myregistry/service:stable
          ports:
            - containerPort: 8080

  strategy:
    canary:
      # Reference the canary and stable services
      canaryService: production-service-canary
      stableService: production-service-stable

      # Istio traffic management
      trafficRouting:
        istio:
          virtualService:
            name: production-service-vsvc
            routes:
              - primary  # must match route name in VirtualService

      steps:
        - setWeight: 5
        - pause: {duration: 5m}
        - analysis:
            templates:
              - templateName: prometheus-success-rate
            args:
              - name: service-name
                value: production-service
              - name: canary-hash
                valueFrom:
                  podTemplateHashValue: Latest
        - setWeight: 20
        - pause: {duration: 10m}
        - analysis:
            templates:
              - templateName: prometheus-success-rate
              - templateName: datadog-canary-analysis
            args:
              - name: service-name
                value: production-service
              - name: app-name
                value: production-service
              - name: canary-hash
                valueFrom:
                  podTemplateHashValue: Latest
        - setWeight: 50
        - pause: {duration: 5m}
        - setWeight: 100
```

```yaml
# istio-virtualservice.yaml
# Argo Rollouts will modify the weights in this VirtualService
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: production-service-vsvc
  namespace: production
spec:
  hosts:
    - production-service
  http:
    - name: primary  # Must match trafficRouting.istio.virtualService.routes
      route:
        - destination:
            host: production-service-stable
            port:
              number: 80
          weight: 100
        - destination:
            host: production-service-canary
            port:
              number: 80
          weight: 0  # Argo Rollouts manages this weight
```

### Header-Based Canary Routing

For testing with specific users before percentage-based rollout:

```yaml
# istio-header-canary.yaml
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: production-service-vsvc
  namespace: production
spec:
  hosts:
    - production-service
  http:
    # Route users with X-Canary header to canary service
    - match:
        - headers:
            x-canary:
              exact: "true"
      route:
        - destination:
            host: production-service-canary
            port:
              number: 80
    # Everyone else goes to stable
    - name: primary
      route:
        - destination:
            host: production-service-stable
            port:
              number: 80
          weight: 100
        - destination:
            host: production-service-canary
            port:
              number: 80
          weight: 0
```

## Section 5: Blue-Green with AnalysisRun

### Blue-Green Rollout Configuration

```yaml
# blue-green-rollout.yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: critical-service-bluegreen
  namespace: production
spec:
  replicas: 5
  selector:
    matchLabels:
      app: critical-service
  template:
    metadata:
      labels:
        app: critical-service
    spec:
      containers:
        - name: service
          image: myregistry/critical-service:v2
          ports:
            - containerPort: 8080

  strategy:
    blueGreen:
      # Active service: receives production traffic
      activeService: critical-service-active
      # Preview service: receives test traffic to the new version
      previewService: critical-service-preview

      # Wait before auto-promotion (allows manual inspection)
      autoPromotionEnabled: false

      # Pre-promotion analysis: must pass before going active
      prePromotionAnalysis:
        templates:
          - templateName: prometheus-success-rate
        args:
          - name: service-name
            value: critical-service
          - name: canary-hash
            valueFrom:
              podTemplateHashValue: Latest
        # Run analysis for 10 minutes before allowing promotion
        analysisRunMetadata:
          labels:
            deployment: critical-service
            phase: pre-promotion

      # Post-promotion analysis: runs after traffic shifts to new version
      postPromotionAnalysis:
        templates:
          - templateName: prometheus-success-rate
        args:
          - name: service-name
            value: critical-service
          - name: canary-hash
            valueFrom:
              podTemplateHashValue: Latest

      # Scale down old version 5 minutes after promotion
      scaleDownDelaySeconds: 300

      # Number of old ReplicaSets to keep
      scaleDownDelayRevisionLimit: 2
```

```yaml
# blue-green-services.yaml
apiVersion: v1
kind: Service
metadata:
  name: critical-service-active
  namespace: production
  labels:
    app: critical-service
    role: active
spec:
  selector:
    app: critical-service
  ports:
    - port: 80
      targetPort: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: critical-service-preview
  namespace: production
  labels:
    app: critical-service
    role: preview
spec:
  selector:
    app: critical-service
  ports:
    - port: 80
      targetPort: 8080
```

### Manual Blue-Green Workflow

```bash
# Initiate blue-green deployment
kubectl argo rollouts set image critical-service-bluegreen \
  service=myregistry/critical-service:v3 \
  -n production

# Watch the rollout progress
kubectl argo rollouts get rollout critical-service-bluegreen \
  --watch \
  -n production

# Check pre-promotion analysis status
kubectl argo rollouts get rollout critical-service-bluegreen \
  -n production | grep -A10 "Pre-Promotion Analysis"

# Run a test against the preview service
kubectl run test-runner --rm -it --image=curlimages/curl -- \
  curl -s http://critical-service-preview.production.svc.cluster.local/api/v1/health

# Manually promote if analysis passes and manual review is complete
kubectl argo rollouts promote critical-service-bluegreen \
  -n production

# Abort if issues found
kubectl argo rollouts abort critical-service-bluegreen \
  -n production
```

## Section 6: Automated Rollback Configuration

### Rollback Triggers and Thresholds

Rollback is triggered when:
1. An analysis metric exceeds `failureCondition` for `failureLimit` consecutive measurements
2. An AnalysisRun reaches the `Failed` phase
3. The number of failed metrics exceeds the `failureLimit` at the template level

```yaml
# Conservative analysis template with quick rollback
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: strict-canary-analysis
  namespace: production
spec:
  metrics:
    - name: critical-error-rate
      interval: 30s
      count: 3          # Check 3 times (90 seconds total)
      successCondition: result[0] < 0.001  # <0.1% error rate required
      failureCondition: result[0] > 0.01   # >1% triggers immediate failure
      failureLimit: 1   # ONE failure = rollback (zero tolerance)
      provider:
        prometheus:
          address: http://prometheus-operated.monitoring.svc.cluster.local:9090
          query: |
            sum(rate(http_requests_total{status=~"5..",app="{{ args.service-name }}"}[1m]))
            /
            sum(rate(http_requests_total{app="{{ args.service-name }}"}[1m]))
            or vector(0)

    - name: canary-pod-ready
      interval: 30s
      successCondition: result[0] == 1
      failureCondition: result[0] < 0.8
      failureLimit: 3
      provider:
        prometheus:
          address: http://prometheus-operated.monitoring.svc.cluster.local:9090
          query: |
            min(
              kube_pod_container_status_ready{
                namespace="{{ args.namespace }}",
                pod=~".*{{ args.service-name }}.*"
              }
            ) or vector(0)
```

### Rollback Notification Hooks

```yaml
# notification-analysis-template.yaml
# Sends Slack notification when analysis completes
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: notify-on-failure
  namespace: production
spec:
  metrics:
    - name: slack-notify
      # Always runs, reports status
      count: 1
      successCondition: result == "ok"
      provider:
        web:
          url: https://hooks.slack.com/services/<webhook-placeholder>
          method: POST
          headers:
            - key: Content-Type
              value: application/json
          body: |
            {
              "text": "Canary analysis completed for {{ args.service-name }}",
              "attachments": [{"color": "good", "text": "All metrics passing"}]
            }
          successCondition: response.statusCode == 200
          jsonPath: "{$.ok}"
```

### AnalysisRun Status Monitoring

```bash
# Monitor all active AnalysisRuns
kubectl get analysisruns -n production -w

# Get detailed status of a specific AnalysisRun
kubectl argo rollouts get rollout production-service -n production

# Check metrics in an AnalysisRun
kubectl describe analysisrun \
  production-service-canary-<hash>-<timestamp> \
  -n production | grep -A50 "Measurements"

# Query AnalysisRun history
kubectl get analysisruns -n production \
  -o custom-columns=\
"NAME:.metadata.name,\
STATUS:.status.phase,\
STARTED:.metadata.creationTimestamp,\
METRICS:.status.metricResults[*].name"
```

## Section 7: Multi-Cluster Canary with ApplicationSet

### GitOps-Driven Rollouts via ArgoCD

```yaml
# applicationset-rollouts.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: production-service-rollouts
  namespace: argocd
spec:
  generators:
    - clusters:
        selector:
          matchLabels:
            environment: production
  template:
    metadata:
      name: "production-service-{{name}}"
    spec:
      project: production
      source:
        repoURL: https://github.com/mycompany/deployments
        targetRevision: HEAD
        path: services/production-service/{{name}}
      destination:
        server: "{{server}}"
        namespace: production
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
```

## Section 8: Dashboard and Operational Tooling

### Argo Rollouts Dashboard

```bash
# Start the Argo Rollouts dashboard locally
kubectl argo rollouts dashboard

# Or deploy it as a service in the cluster
kubectl apply -f - << 'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: argo-rollouts-dashboard
  namespace: argo-rollouts
spec:
  replicas: 1
  selector:
    matchLabels:
      app: argo-rollouts-dashboard
  template:
    metadata:
      labels:
        app: argo-rollouts-dashboard
    spec:
      serviceAccountName: argo-rollouts-dashboard
      containers:
        - name: dashboard
          image: quay.io/argoproj/kubectl-argo-rollouts:latest
          args: ["dashboard", "--port", "3100"]
          ports:
            - containerPort: 3100
EOF
```

### Prometheus Alerts for Rollout State

```yaml
# prometheus-rollout-alerts.yaml
groups:
  - name: argo.rollouts
    rules:
      - alert: RolloutDegraded
        expr: |
          rollout_info{phase="Degraded"} == 1
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Rollout {{ $labels.name }} is degraded"
          description: "Rollout {{ $labels.namespace }}/{{ $labels.name }} is in Degraded state"

      - alert: RolloutAnalysisFailed
        expr: |
          analysisrun_info{phase="Failed"} == 1
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "AnalysisRun failed for {{ $labels.rollout }}"
          description: "Automated rollback may be in progress"

      - alert: CanaryPaused
        expr: |
          rollout_info{phase="Paused"} == 1
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "Rollout {{ $labels.name }} has been paused for >30 minutes"
          description: "Manual promotion may be required: kubectl argo rollouts promote {{ $labels.name }} -n {{ $labels.namespace }}"
```

### Rollout CLI Reference

```bash
# Common Argo Rollouts operations

# Get all rollouts in a namespace
kubectl argo rollouts list rollouts -n production

# Watch live rollout status
kubectl argo rollouts get rollout my-rollout --watch -n production

# Trigger a new deployment (change image)
kubectl argo rollouts set image my-rollout \
  container=myregistry/myapp:v2 \
  -n production

# Manually advance to next step
kubectl argo rollouts promote my-rollout -n production

# Skip all remaining steps and go directly to 100%
kubectl argo rollouts promote my-rollout --full -n production

# Abort and rollback to stable
kubectl argo rollouts abort my-rollout -n production

# Retry a failed rollout
kubectl argo rollouts retry rollout my-rollout -n production

# Undo the last rollout (go back to previous version)
kubectl argo rollouts undo my-rollout -n production
```

## Section 9: Testing and Validation

### Dry-Run Analysis Validation

```bash
# Validate AnalysisTemplate without running a rollout
kubectl argo rollouts get analysistemplate prometheus-success-rate -n production

# Create a standalone AnalysisRun for testing
kubectl apply -f - << 'EOF'
apiVersion: argoproj.io/v1alpha1
kind: AnalysisRun
metadata:
  name: test-analysis-run
  namespace: production
spec:
  templates:
    - templateName: prometheus-success-rate
  args:
    - name: service-name
      value: production-service
    - name: canary-hash
      value: test-hash
    - name: namespace
      value: production
EOF

# Watch the AnalysisRun
kubectl argo rollouts get analysisrun test-analysis-run -n production --watch

# Clean up
kubectl delete analysisrun test-analysis-run -n production
```

### Integration Test for Canary Pipeline

```bash
#!/bin/bash
# test-canary-pipeline.sh
# Integration test for the canary deployment pipeline

set -euo pipefail

ROLLOUT_NAME="${1:-production-service}"
NAMESPACE="${2:-production}"
TEST_IMAGE="${3:-myregistry/service:test-$(git rev-parse --short HEAD)}"
TIMEOUT=600

echo "Testing canary pipeline for ${ROLLOUT_NAME}"

# Step 1: Deploy test image
kubectl argo rollouts set image "${ROLLOUT_NAME}" \
  service="${TEST_IMAGE}" \
  -n "${NAMESPACE}"

# Step 2: Wait for rollout to start
sleep 10

# Step 3: Monitor progress with timeout
DEADLINE=$(($(date +%s) + TIMEOUT))
while [[ $(date +%s) -lt ${DEADLINE} ]]; do
  STATUS=$(kubectl argo rollouts get rollout "${ROLLOUT_NAME}" \
    -n "${NAMESPACE}" \
    -o json 2>/dev/null | jq -r '.status.phase' || echo "Unknown")

  echo "Rollout status: ${STATUS}"

  case "${STATUS}" in
    "Healthy")
      echo "SUCCESS: Rollout completed successfully"
      exit 0
      ;;
    "Degraded")
      echo "FAILURE: Rollout degraded"
      kubectl argo rollouts get rollout "${ROLLOUT_NAME}" -n "${NAMESPACE}"
      exit 1
      ;;
    "Paused")
      echo "Rollout paused at manual approval step"
      # In CI, promote automatically
      kubectl argo rollouts promote "${ROLLOUT_NAME}" -n "${NAMESPACE}"
      ;;
  esac

  sleep 15
done

echo "TIMEOUT: Rollout did not complete within ${TIMEOUT}s"
kubectl argo rollouts abort "${ROLLOUT_NAME}" -n "${NAMESPACE}"
exit 1
```

## Conclusion

Argo Rollouts transforms the deployment lifecycle from a binary risk into a data-driven, automatically validated process. The combination of Prometheus queries for your internal SLI metrics and Datadog for APM-level analysis provides defense in depth — internal error rates catch service-level problems while Datadog's distributed traces catch latency regressions in specific service interactions.

The most impactful configuration choice is `failureLimit`: setting it to 1 for critical services means the first measurement showing degradation triggers rollback, while setting it to 3-5 prevents false positives from transient metric collection issues. Tuning this parameter to your metric collection frequency and acceptable detection time is the difference between a system that's too sensitive (rolling back on noise) and one that's not sensitive enough (letting degraded canaries run too long).
