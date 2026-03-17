---
title: "Kubernetes ArgoCD Progressive Delivery: Rollouts, Analysis Templates, and Automated Rollback"
date: 2028-07-08T00:00:00-05:00
draft: false
tags: ["Kubernetes", "ArgoCD", "Argo Rollouts", "GitOps", "Canary", "Blue-Green"]
categories:
- Kubernetes
- GitOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete production guide to implementing progressive delivery with Argo Rollouts and ArgoCD, covering canary deployments, blue-green strategies, analysis templates with Prometheus metrics, and automated rollback triggers."
more_link: "yes"
url: "/kubernetes-argocd-progressive-delivery-guide/"
---

Progressive delivery is the practice of rolling out software changes to subsets of users incrementally, using automated analysis to decide whether to continue or roll back. It transforms deployments from high-risk events to routine operations. Argo Rollouts, combined with ArgoCD's GitOps model, provides a production-ready progressive delivery platform that integrates with your existing Prometheus, Datadog, or New Relic metrics.

This guide builds a complete progressive delivery workflow from installation through production operations, covering canary deployments with automated promotion, blue-green deployments with traffic switching, and the analysis framework that makes automated rollback trustworthy.

<!--more-->

# Kubernetes ArgoCD Progressive Delivery: Production Guide

## Section 1: Installing Argo Rollouts

### Installation with Helm

```bash
# Add Argo helm repository
helm repo add argo https://argoproj.github.io/argo-helm
helm repo update

# Install Argo Rollouts
helm install argo-rollouts argo/argo-rollouts \
  --namespace argo-rollouts \
  --create-namespace \
  --set dashboard.enabled=true \
  --set dashboard.service.type=ClusterIP \
  --set controller.metrics.enabled=true \
  --set controller.metrics.serviceMonitor.enabled=true \
  --version 2.37.0

# Install the kubectl plugin
curl -LO https://github.com/argoproj/argo-rollouts/releases/latest/download/kubectl-argo-rollouts-linux-amd64
chmod +x kubectl-argo-rollouts-linux-amd64
mv kubectl-argo-rollouts-linux-amd64 /usr/local/bin/kubectl-argo-rollouts

# Verify installation
kubectl argo rollouts version
kubectl get pods -n argo-rollouts
```

### Install with ArgoCD ApplicationSet

For teams already using ArgoCD, manage Argo Rollouts itself as a GitOps application:

```yaml
# argocd/apps/argo-rollouts.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: argo-rollouts
  namespace: argocd
  finalizers:
  - resources-finalizer.argocd.argoproj.io
spec:
  project: platform
  source:
    repoURL: https://argoproj.github.io/argo-helm
    chart: argo-rollouts
    targetRevision: 2.37.0
    helm:
      values: |
        controller:
          replicas: 2
          metrics:
            enabled: true
            serviceMonitor:
              enabled: true
              namespace: monitoring
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
        dashboard:
          enabled: true
          service:
            type: ClusterIP
  destination:
    server: https://kubernetes.default.svc
    namespace: argo-rollouts
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
    - CreateNamespace=true
    - ServerSideApply=true
```

## Section 2: Canary Deployments

### Basic Canary Rollout

A Rollout replaces a Deployment and adds canary/blue-green strategy configuration:

```yaml
# rollouts/my-app-rollout.yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: my-app
  namespace: production
spec:
  replicas: 10
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
      - name: app
        image: my-app:1.2.3
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
            path: /health/ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
        livenessProbe:
          httpGet:
            path: /health/live
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 10
  strategy:
    canary:
      # Service to update during canary
      canaryService: my-app-canary
      stableService: my-app-stable
      # Traffic splitting via Istio
      trafficRouting:
        istio:
          virtualService:
            name: my-app
            routes:
            - primary
      steps:
      # Step 1: Route 5% traffic to canary, pause for manual verification
      - setWeight: 5
      - pause:
          duration: 5m
      # Step 2: Automated analysis begins
      - analysis:
          templates:
          - templateName: success-rate
          - templateName: latency-p99
          args:
          - name: service-name
            value: my-app-canary
      # Step 3: Increase to 20%
      - setWeight: 20
      - pause:
          duration: 10m
      - analysis:
          templates:
          - templateName: success-rate
          - templateName: latency-p99
          args:
          - name: service-name
            value: my-app-canary
      # Step 4: 50%
      - setWeight: 50
      - pause:
          duration: 10m
      - analysis:
          templates:
          - templateName: success-rate
          - templateName: latency-p99
          args:
          - name: service-name
            value: my-app-canary
      # Step 5: Full rollout
      - setWeight: 100
      maxSurge: "20%"
      maxUnavailable: 0
      # Background analysis runs throughout the rollout
      analysis:
        templates:
        - templateName: success-rate
        args:
        - name: service-name
          value: my-app-canary
        startingStep: 1  # Start after first step
```

### Services for Traffic Splitting

```yaml
# services.yaml
apiVersion: v1
kind: Service
metadata:
  name: my-app-stable
  namespace: production
spec:
  selector:
    app: my-app
  ports:
  - port: 80
    targetPort: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: my-app-canary
  namespace: production
spec:
  selector:
    app: my-app
  ports:
  - port: 80
    targetPort: 8080
---
# VirtualService managed by Argo Rollouts
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: my-app
  namespace: production
spec:
  hosts:
  - my-app
  http:
  - name: primary
    route:
    - destination:
        host: my-app-stable
      weight: 100
    - destination:
        host: my-app-canary
      weight: 0
```

## Section 3: Analysis Templates

Analysis Templates define how Argo Rollouts evaluates whether a rollout is safe to promote. They query metrics from Prometheus, Datadog, or web hooks.

### Prometheus-Based Analysis

```yaml
# analysis/success-rate.yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: success-rate
  namespace: production
spec:
  args:
  - name: service-name
  metrics:
  - name: success-rate
    interval: 1m
    # Fail if success rate drops below 95% for more than 3 consecutive measurements
    failureLimit: 3
    successCondition: result[0] >= 0.95
    failureCondition: result[0] < 0.90  # Immediate failure if below 90%
    provider:
      prometheus:
        address: http://prometheus.monitoring:9090
        query: |
          sum(rate(istio_requests_total{
            reporter="destination",
            destination_service_name="{{args.service-name}}",
            response_code!~"5.."
          }[5m]))
          /
          sum(rate(istio_requests_total{
            reporter="destination",
            destination_service_name="{{args.service-name}}"
          }[5m]))
---
# analysis/latency.yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: latency-p99
  namespace: production
spec:
  args:
  - name: service-name
  metrics:
  - name: p99-latency
    interval: 1m
    failureLimit: 3
    # Fail if p99 latency exceeds 500ms
    successCondition: result[0] <= 500
    failureCondition: result[0] > 1000
    provider:
      prometheus:
        address: http://prometheus.monitoring:9090
        query: |
          histogram_quantile(0.99,
            sum(rate(istio_request_duration_milliseconds_bucket{
              reporter="destination",
              destination_service_name="{{args.service-name}}"
            }[5m])) by (le)
          )
---
# analysis/error-rate-compound.yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: error-rate-compound
  namespace: production
spec:
  args:
  - name: service-name
  - name: baseline-service
    value: "my-app-stable"
  metrics:
  # Compare canary error rate to baseline
  - name: relative-error-rate
    interval: 2m
    successCondition: >
      result[0] <= result[1] * 1.1
    failureCondition: >
      result[0] > result[1] * 1.5
    provider:
      prometheus:
        address: http://prometheus.monitoring:9090
        query: |
          (
            sum(rate(istio_requests_total{
              destination_service_name="{{args.service-name}}",
              response_code=~"5.."
            }[5m]))
            /
            sum(rate(istio_requests_total{
              destination_service_name="{{args.service-name}}"
            }[5m]))
          )
          and
          (
            sum(rate(istio_requests_total{
              destination_service_name="{{args.baseline-service}}",
              response_code=~"5.."
            }[5m]))
            /
            sum(rate(istio_requests_total{
              destination_service_name="{{args.baseline-service}}"
            }[5m]))
          )
```

### Web Hook Analysis (for custom checks)

```yaml
# analysis/smoke-test.yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: smoke-test
  namespace: production
spec:
  args:
  - name: canary-url
  metrics:
  - name: smoke-test-pass
    count: 1
    failureLimit: 1
    provider:
      web:
        url: "{{args.canary-url}}/health/smoke"
        timeoutSeconds: 30
        successCondition: "result.status == 200 && result.body.healthy == true"
        headers:
        - key: Authorization
          value: "Bearer {{secrets.smoke-test-token}}"
---
# analysis/kayenta.yaml — Kayenta canary analysis
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: kayenta-analysis
  namespace: production
spec:
  args:
  - name: start-time
  - name: interval-time
  - name: application
  metrics:
  - name: mann-whitney
    provider:
      kayenta:
        address: https://kayenta.example.com
        application: "{{args.application}}"
        canaryConfigName: my-app-config
        metricsAccountName: prometheus-metrics
        storageAccountName: s3-storage
        threshold:
          pass: 90
          marginal: 75
        scopes:
        - name: default
          controlScope:
            scope: "app:my-app,role:stable"
            step: 60
            start: "{{args.start-time}}"
            end: "{{args.interval-time}}"
          experimentScope:
            scope: "app:my-app,role:canary"
            step: 60
            start: "{{args.start-time}}"
            end: "{{args.interval-time}}"
```

## Section 4: Blue-Green Deployments

Blue-green deployments maintain two identical environments and switch traffic instantaneously:

```yaml
# rollouts/my-app-bluegreen.yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: my-app-bluegreen
  namespace: production
spec:
  replicas: 5
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
      - name: app
        image: my-app:1.2.3
        ports:
        - containerPort: 8080
        resources:
          requests:
            cpu: "100m"
            memory: "128Mi"
          limits:
            cpu: "500m"
            memory: "512Mi"
  strategy:
    blueGreen:
      # Active service serves production traffic
      activeService: my-app-active
      # Preview service serves the new version before promotion
      previewService: my-app-preview
      # Don't auto-promote — wait for manual approval or analysis
      autoPromotionEnabled: false
      # Delete old version after promotion
      autoPromotionSeconds: 0
      scaleDownDelaySeconds: 30  # Wait before scaling down old version
      previewReplicaCount: 3     # Run 3 preview replicas
      # Run analysis before promotion
      prePromotionAnalysis:
        templates:
        - templateName: smoke-test
        args:
        - name: canary-url
          value: "http://my-app-preview.production"
      # Run analysis after promotion to validate
      postPromotionAnalysis:
        templates:
        - templateName: success-rate
        args:
        - name: service-name
          value: my-app-active
---
apiVersion: v1
kind: Service
metadata:
  name: my-app-active
  namespace: production
spec:
  selector:
    app: my-app
  ports:
  - port: 80
    targetPort: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: my-app-preview
  namespace: production
spec:
  selector:
    app: my-app
  ports:
  - port: 80
    targetPort: 8080
```

### Promoting and Aborting Blue-Green Deployments

```bash
# Check rollout status
kubectl argo rollouts get rollout my-app-bluegreen -n production

# Promote the preview to active
kubectl argo rollouts promote my-app-bluegreen -n production

# Abort and rollback
kubectl argo rollouts abort my-app-bluegreen -n production

# Undo to previous version
kubectl argo rollouts undo my-app-bluegreen -n production

# Watch status
kubectl argo rollouts status my-app-bluegreen -n production --watch
```

## Section 5: ArgoCD Integration

### Rollout-Aware ArgoCD Health Checks

ArgoCD needs a custom health check to understand Rollout resources:

```yaml
# argocd-cm ConfigMap addition
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  resource.customizations.health.argoproj.io_Rollout: |
    hs = {}
    if obj.status ~= nil then
      if obj.status.currentPodHash ~= nil then
        if obj.spec.replicas ~= nil then
          if obj.status.availableReplicas < obj.spec.replicas then
            hs.status = "Progressing"
            hs.message = "Waiting for rollout to finish: " .. obj.status.availableReplicas .. " out of " .. obj.spec.replicas .. " new replicas are available"
            return hs
          end
        end
      end
      if obj.status.phase == "Paused" then
        hs.status = "Suspended"
        hs.message = "Rollout is paused"
        return hs
      end
      if obj.status.phase == "Degraded" then
        hs.status = "Degraded"
        hs.message = obj.status.message
        return hs
      end
      hs.status = "Healthy"
      hs.message = "Rollout is healthy"
      return hs
    end
    hs.status = "Progressing"
    hs.message = "Waiting for rollout"
    return hs
```

### ArgoCD Application with Rollout

```yaml
# argocd/applications/my-app.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: my-app
  namespace: argocd
  annotations:
    # Notify on sync and health changes
    notifications.argoproj.io/subscribe.on-sync-succeeded.slack: deployments
    notifications.argoproj.io/subscribe.on-health-degraded.pagerduty: ""
    notifications.argoproj.io/subscribe.on-sync-failed.slack: alerts
spec:
  project: production
  source:
    repoURL: https://github.com/myorg/gitops-config.git
    targetRevision: HEAD
    path: apps/my-app/production
  destination:
    server: https://kubernetes.default.svc
    namespace: production
  syncPolicy:
    automated:
      prune: true
      selfHeal: false  # Don't auto-heal — allow manual rollout control
    syncOptions:
    - CreateNamespace=true
    - RespectIgnoreDifferences=true
    - ServerSideApply=true
  ignoreDifferences:
  # Ignore fields managed by Argo Rollouts controller
  - group: argoproj.io
    kind: Rollout
    jsonPointers:
    - /spec/paused
    - /spec/replicas
```

### ArgoCD Notifications for Rollout Events

```yaml
# argocd-notifications-cm
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-notifications-cm
  namespace: argocd
data:
  template.rollout-degraded: |
    message: |
      Application {{.app.metadata.name}} rollout degraded.
      Reason: {{.app.status.operationState.message}}
      Action: Check `kubectl argo rollouts get rollout {{.app.metadata.name}} -n {{.app.spec.destination.namespace}}`
    slack:
      attachments: |
        [{
          "title": "Rollout Degraded",
          "color": "danger",
          "fields": [
            {"title": "App", "value": "{{.app.metadata.name}}", "short": true},
            {"title": "Namespace", "value": "{{.app.spec.destination.namespace}}", "short": true}
          ]
        }]

  template.rollout-paused: |
    message: |
      Application {{.app.metadata.name}} rollout is paused — manual promotion required.
      Preview URL: https://preview.{{.app.metadata.name}}.example.com
    slack:
      attachments: |
        [{
          "title": "Rollout Paused - Action Required",
          "color": "warning",
          "actions": [
            {"type": "button", "text": "Promote", "url": "https://argocd.example.com/applications/{{.app.metadata.name}}"},
            {"type": "button", "text": "Rollback", "url": "https://argocd.example.com/applications/{{.app.metadata.name}}"}
          ]
        }]
```

## Section 6: Experiment API for A/B Testing

Argo Rollouts' Experiment resource runs multiple versions simultaneously:

```yaml
# experiment/ab-test.yaml
apiVersion: argoproj.io/v1alpha1
kind: Experiment
metadata:
  name: my-app-ab-test
  namespace: production
spec:
  duration: 1h
  templates:
  - name: control
    selector:
      matchLabels:
        app: my-app
        variant: control
    template:
      metadata:
        labels:
          app: my-app
          variant: control
      spec:
        containers:
        - name: app
          image: my-app:1.2.2  # Control version
          env:
          - name: FEATURE_X_ENABLED
            value: "false"
  - name: treatment
    selector:
      matchLabels:
        app: my-app
        variant: treatment
    template:
      metadata:
        labels:
          app: my-app
          variant: treatment
      spec:
        containers:
        - name: app
          image: my-app:1.2.3  # Treatment version
          env:
          - name: FEATURE_X_ENABLED
            value: "true"
  analyses:
  - name: conversion-rate
    templateName: conversion-rate-analysis
    args:
    - name: treatment
      value: treatment
    - name: control
      value: control
```

## Section 7: GitOps Workflow with Image Updater

Automate image updates using Argo CD Image Updater:

```yaml
# argocd/applications/my-app-image-updater.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: my-app
  namespace: argocd
  annotations:
    argocd-image-updater.argoproj.io/image-list: "app=myregistry/my-app:~1.2"
    argocd-image-updater.argoproj.io/app.update-strategy: semver
    argocd-image-updater.argoproj.io/app.helm.image-name: image.repository
    argocd-image-updater.argoproj.io/app.helm.image-tag: image.tag
    argocd-image-updater.argoproj.io/write-back-method: git
    argocd-image-updater.argoproj.io/git-branch: main
spec:
  project: production
  source:
    repoURL: https://github.com/myorg/gitops-config.git
    targetRevision: HEAD
    path: apps/my-app
    helm:
      values: |
        image:
          repository: myregistry/my-app
          tag: "1.2.3"
  destination:
    server: https://kubernetes.default.svc
    namespace: production
```

## Section 8: Multi-Cluster Progressive Delivery

For organizations deploying to multiple clusters, use ApplicationSets with progressive sync waves:

```yaml
# argocd/applicationsets/progressive-delivery.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: my-app-progressive
  namespace: argocd
spec:
  generators:
  - list:
      elements:
      - cluster: dev
        url: https://dev-cluster:6443
        wave: "1"
        canaryWeight: "100"  # Full rollout in dev
      - cluster: staging
        url: https://staging-cluster:6443
        wave: "2"
        canaryWeight: "50"
      - cluster: production-us-east
        url: https://prod-us-east:6443
        wave: "3"
        canaryWeight: "10"
      - cluster: production-us-west
        url: https://prod-us-west:6443
        wave: "4"
        canaryWeight: "10"
      - cluster: production-eu
        url: https://prod-eu:6443
        wave: "5"
        canaryWeight: "10"
  template:
    metadata:
      name: "my-app-{{cluster}}"
      namespace: argocd
      annotations:
        argocd.argoproj.io/sync-wave: "{{wave}}"
    spec:
      project: production
      source:
        repoURL: https://github.com/myorg/gitops-config.git
        targetRevision: HEAD
        path: apps/my-app
        helm:
          parameters:
          - name: rollout.canaryWeight
            value: "{{canaryWeight}}"
          - name: cluster.name
            value: "{{cluster}}"
      destination:
        server: "{{url}}"
        namespace: production
      syncPolicy:
        automated:
          prune: true
          selfHeal: false
```

## Section 9: Rollout Dashboard and Visualization

```yaml
# Expose the Argo Rollouts dashboard via Ingress
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: argo-rollouts-dashboard
  namespace: argo-rollouts
  annotations:
    nginx.ingress.kubernetes.io/auth-type: basic
    nginx.ingress.kubernetes.io/auth-secret: dashboard-auth
    nginx.ingress.kubernetes.io/auth-realm: "Argo Rollouts Dashboard"
spec:
  ingressClassName: nginx
  rules:
  - host: rollouts.internal.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: argo-rollouts-dashboard
            port:
              number: 3100
  tls:
  - hosts:
    - rollouts.internal.example.com
    secretName: rollouts-dashboard-tls
```

## Section 10: Automated Rollback Triggers

Configure automated rollback based on analysis results:

```yaml
# Complete rollout with automated rollback
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: my-app-auto-rollback
  namespace: production
spec:
  strategy:
    canary:
      canaryService: my-app-canary
      stableService: my-app-stable
      trafficRouting:
        istio:
          virtualService:
            name: my-app
            routes: [primary]
      # Background analysis with automatic rollback
      analysis:
        templates:
        - templateName: error-rate-compound
        - templateName: latency-p99
        args:
        - name: service-name
          value: my-app-canary
        # Fail the rollout if analysis fails
        # (triggers automatic rollback to stable)
      steps:
      - setWeight: 5
      - pause: {duration: 5m}
      - setWeight: 20
      - pause: {duration: 10m}
      - setWeight: 50
      - pause: {duration: 10m}
      - setWeight: 100
      # Rollback configuration
      maxSurge: "20%"
      maxUnavailable: 0
      abortScaleDownDelaySeconds: 30
```

### Custom Rollback Webhook

```go
// cmd/rollout-webhook/main.go
package main

import (
    "encoding/json"
    "io"
    "log/slog"
    "net/http"
    "os/exec"
    "time"
)

type WebhookRequest struct {
    Event       string `json:"event"`
    Application string `json:"application"`
    Namespace   string `json:"namespace"`
    Revision    string `json:"revision"`
}

func main() {
    http.HandleFunc("/webhook/rollout", handleRolloutWebhook)
    slog.Info("starting rollout webhook server on :8080")
    http.ListenAndServe(":8080", nil)
}

func handleRolloutWebhook(w http.ResponseWriter, r *http.Request) {
    body, err := io.ReadAll(r.Body)
    if err != nil {
        http.Error(w, "reading body", http.StatusBadRequest)
        return
    }

    var req WebhookRequest
    if err := json.Unmarshal(body, &req); err != nil {
        http.Error(w, "parsing JSON", http.StatusBadRequest)
        return
    }

    slog.Info("received rollout event",
        "event", req.Event,
        "app", req.Application,
        "namespace", req.Namespace,
    )

    switch req.Event {
    case "RolloutCompleted":
        go notifySlack(req, "Rollout completed successfully", "good")
    case "RolloutAborted":
        go notifySlack(req, "Rollout aborted — rollback in progress", "danger")
        go triggerRunbook(req)
    case "AnalysisFailed":
        go notifySlack(req, "Analysis failed — automated rollback triggered", "warning")
    }

    w.WriteHeader(http.StatusOK)
}

func triggerRunbook(req WebhookRequest) {
    // Execute automated remediation runbook
    cmd := exec.Command("kubectl", "argo", "rollouts",
        "undo", req.Application,
        "-n", req.Namespace,
    )
    if out, err := cmd.CombinedOutput(); err != nil {
        slog.Error("runbook failed",
            "app", req.Application,
            "error", err,
            "output", string(out),
        )
        return
    }
    slog.Info("rollback executed",
        "app", req.Application,
        "namespace", req.Namespace,
    )
}

func notifySlack(req WebhookRequest, message, color string) {
    // Slack notification implementation
    _ = req
    _ = message
    _ = color
}
```

## Section 11: Monitoring Rollout Health

```yaml
# PrometheusRule for rollout monitoring
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: argo-rollouts-alerts
  namespace: monitoring
spec:
  groups:
  - name: argo-rollouts
    rules:
    - alert: RolloutDegraded
      expr: |
        argo_rollout_phase{phase="Degraded"} == 1
      for: 1m
      labels:
        severity: critical
      annotations:
        summary: "Rollout {{ $labels.name }} in namespace {{ $labels.namespace }} is degraded"
        runbook: "https://wiki.example.com/runbooks/rollout-degraded"

    - alert: AnalysisRunFailed
      expr: |
        argo_analysis_run_phase{phase="Failed"} == 1
      for: 0m
      labels:
        severity: warning
      annotations:
        summary: "Analysis run failed for {{ $labels.name }}"

    - alert: RolloutStalled
      expr: |
        (time() - argo_rollout_updated_at) > 3600
        and argo_rollout_phase{phase="Progressing"} == 1
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Rollout {{ $labels.name }} has been progressing for over 1 hour"
```

## Conclusion

Progressive delivery with Argo Rollouts transforms deployments from discrete risky events into continuous, measurable processes. The key insight is that the analysis framework — particularly background analysis and comparison against the stable baseline — makes automated rollback decisions that are more reliable than human judgment during incidents. A deployment that triggers an automated rollback at 5% traffic with a clear metrics trail is far preferable to one that reaches 100% before anyone notices a problem.

The GitOps model with ArgoCD adds the accountability layer: every promotion is a git commit, every rollback is traceable to a specific analysis failure, and the entire deployment history is auditable. Combined with the multi-cluster ApplicationSet pattern, this scales progressive delivery from single environments to entire cloud regions with consistent policy.
