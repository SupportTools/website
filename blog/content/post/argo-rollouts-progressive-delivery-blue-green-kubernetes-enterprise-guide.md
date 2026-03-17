---
title: "Argo Rollouts: Progressive Delivery and Blue-Green Deployments on Kubernetes"
date: 2030-05-17T00:00:00-05:00
draft: false
tags: ["Argo Rollouts", "Kubernetes", "Progressive Delivery", "Blue-Green", "Canary", "Istio", "GitOps"]
categories:
- Kubernetes
- DevOps
- GitOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to Argo Rollouts for canary deployments, blue-green strategies, traffic management with Istio and NGINX, automated analysis with Prometheus metrics, and rollback automation."
more_link: "yes"
url: "/argo-rollouts-progressive-delivery-blue-green-kubernetes-enterprise-guide/"
---

Kubernetes Deployments perform rolling updates through a simplistic strategy: replace old ReplicaSets with new ones while monitoring pod readiness. This approach provides no traffic shifting capabilities, no metric-based progression gates, and no automated rollback based on application-level health signals. Argo Rollouts fills this gap by extending Kubernetes with sophisticated deployment strategies that integrate with service meshes, ingress controllers, and observability platforms to enable true progressive delivery.

<!--more-->

## Understanding the Rollouts Architecture

Argo Rollouts introduces a `Rollout` custom resource that replaces the standard `Deployment` for services requiring advanced delivery capabilities. The Rollouts controller manages the lifecycle of ReplicaSets, interacts with traffic management providers, and evaluates `AnalysisRun` results to make promotion or abort decisions.

### Core Components

```
Rollout Controller
├── ReplicaSet Management     (creates and scales blue/green ReplicaSets)
├── Traffic Router            (communicates with Istio/NGINX/ALB)
├── Analysis Controller       (runs AnalysisTemplates, evaluates metrics)
└── Notification Controller   (sends events to Slack, PagerDuty, etc.)
```

## Installation

```bash
# Install Argo Rollouts controller
kubectl create namespace argo-rollouts
kubectl apply -n argo-rollouts \
  -f https://github.com/argoproj/argo-rollouts/releases/latest/download/install.yaml

# Install the kubectl plugin
curl -LO https://github.com/argoproj/argo-rollouts/releases/latest/download/kubectl-argo-rollouts-linux-amd64
chmod +x kubectl-argo-rollouts-linux-amd64
sudo mv kubectl-argo-rollouts-linux-amd64 /usr/local/bin/kubectl-argo-rollouts

# Verify installation
kubectl argo rollouts version
```

## Canary Deployments with Traffic Management

### Basic Canary Rollout

```yaml
# rollout-canary-basic.yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: api-service
  namespace: production
spec:
  replicas: 10
  selector:
    matchLabels:
      app: api-service
  template:
    metadata:
      labels:
        app: api-service
        version: stable
    spec:
      containers:
        - name: api-service
          image: registry.example.com/api-service:2.1.0
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
              path: /healthz
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 5
  strategy:
    canary:
      maxSurge: 2
      maxUnavailable: 0
      steps:
        - setWeight: 5    # Send 5% of traffic to canary
        - pause: {duration: 5m}
        - setWeight: 20
        - pause: {duration: 10m}
        - setWeight: 50
        - pause: {duration: 10m}
        - setWeight: 80
        - pause: {duration: 5m}
        # Final step: setWeight 100 is implicit when steps complete
      canaryService: api-service-canary
      stableService: api-service-stable
```

### Services for Traffic Splitting

```yaml
# services.yaml
apiVersion: v1
kind: Service
metadata:
  name: api-service-stable
  namespace: production
spec:
  selector:
    app: api-service
  ports:
    - port: 80
      targetPort: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: api-service-canary
  namespace: production
spec:
  selector:
    app: api-service
  ports:
    - port: 80
      targetPort: 8080
# Note: Rollouts controller manages the pod selector modifications on these services
```

## Canary with Istio Traffic Management

Istio provides precise traffic splitting at the service mesh level, enabling percentage-based routing independent of replica counts.

### VirtualService-Based Traffic Splitting

```yaml
# rollout-canary-istio.yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: api-service
  namespace: production
spec:
  replicas: 10
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
          image: registry.example.com/api-service:2.1.0
          ports:
            - containerPort: 8080
  strategy:
    canary:
      trafficRouting:
        istio:
          virtualService:
            name: api-service-vsvc
            routes:
              - primary  # Must match the name in the VirtualService
      canaryService: api-service-canary
      stableService: api-service-stable
      steps:
        - setWeight: 5
        - pause:
            duration: 10m
        - analysis:
            templates:
              - templateName: api-success-rate
            args:
              - name: service-name
                value: api-service-canary
        - setWeight: 25
        - pause:
            duration: 10m
        - analysis:
            templates:
              - templateName: api-success-rate
              - templateName: api-latency-p99
        - setWeight: 50
        - pause:
            duration: 15m
        - setWeight: 100
---
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: api-service-vsvc
  namespace: production
spec:
  hosts:
    - api-service
  http:
    - name: primary
      route:
        - destination:
            host: api-service-stable
          weight: 100
        - destination:
            host: api-service-canary
          weight: 0
```

### DestinationRule for mTLS

```yaml
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: api-service-stable
  namespace: production
spec:
  host: api-service-stable
  trafficPolicy:
    tls:
      mode: ISTIO_MUTUAL
  subsets:
    - name: stable
      labels:
        rollouts-pod-template-hash: stable
---
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: api-service-canary
  namespace: production
spec:
  host: api-service-canary
  trafficPolicy:
    tls:
      mode: ISTIO_MUTUAL
```

## Canary with NGINX Ingress

```yaml
# rollout-canary-nginx.yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: api-service
  namespace: production
spec:
  replicas: 10
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
          image: registry.example.com/api-service:2.1.0
          ports:
            - containerPort: 8080
  strategy:
    canary:
      trafficRouting:
        nginx:
          stableIngress: api-service-ingress
          additionalIngressAnnotations:
            canary-by-header: X-Canary
            canary-by-header-value: "true"
      canaryService: api-service-canary
      stableService: api-service-stable
      steps:
        - setWeight: 10
        - pause:
            duration: 5m
        - setWeight: 30
        - pause:
            duration: 5m
        - setWeight: 60
        - pause:
            duration: 5m
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-service-ingress
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/proxy-connect-timeout: "10"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "30"
spec:
  ingressClassName: nginx
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: api-service-stable
                port:
                  number: 80
```

## Analysis Templates for Automated Promotion

### Prometheus-Based Analysis

```yaml
# analysis-templates.yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: api-success-rate
  namespace: production
spec:
  args:
    - name: service-name
    - name: namespace
      value: production
    - name: interval
      value: "5m"
  metrics:
    - name: success-rate
      interval: "2m"
      count: 5          # Run 5 measurements
      successCondition: result[0] >= 0.99
      failureLimit: 1   # Abort after 1 failure
      provider:
        prometheus:
          address: http://prometheus.monitoring.svc:9090
          query: |
            sum(
              rate(
                http_requests_total{
                  service="{{ args.service-name }}",
                  namespace="{{ args.namespace }}",
                  status!~"5.."
                }[{{ args.interval }}]
              )
            ) /
            sum(
              rate(
                http_requests_total{
                  service="{{ args.service-name }}",
                  namespace="{{ args.namespace }}"
                }[{{ args.interval }}]
              )
            )
---
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: api-latency-p99
  namespace: production
spec:
  args:
    - name: service-name
    - name: namespace
      value: production
  metrics:
    - name: p99-latency
      interval: "2m"
      count: 5
      successCondition: result[0] < 0.5   # p99 must be under 500ms
      failureLimit: 2
      provider:
        prometheus:
          address: http://prometheus.monitoring.svc:9090
          query: |
            histogram_quantile(
              0.99,
              sum(
                rate(
                  http_request_duration_seconds_bucket{
                    service="{{ args.service-name }}",
                    namespace="{{ args.namespace }}"
                  }[5m]
                )
              ) by (le)
            )
---
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: api-error-rate
  namespace: production
spec:
  args:
    - name: service-name
  metrics:
    - name: error-rate
      interval: "1m"
      count: 10
      successCondition: result[0] <= 0.01   # max 1% error rate
      failureLimit: 2
      inconclusiveLimit: 3
      provider:
        prometheus:
          address: http://prometheus.monitoring.svc:9090
          query: |
            sum(
              rate(
                http_requests_total{
                  service="{{ args.service-name }}",
                  status=~"5.."
                }[2m]
              )
            ) /
            sum(
              rate(
                http_requests_total{
                  service="{{ args.service-name }}"
                }[2m]
              )
            )
```

### Web Analysis (External Synthetic Tests)

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: synthetic-smoke-test
  namespace: production
spec:
  args:
    - name: canary-url
  metrics:
    - name: smoke-test
      count: 3
      interval: "1m"
      successCondition: result == "200"
      failureLimit: 1
      provider:
        web:
          url: "{{ args.canary-url }}/healthz"
          timeoutSeconds: 10
          successCondition: response.status == 200
```

### Kubernetes Job Analysis

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: integration-test-suite
  namespace: production
spec:
  args:
    - name: canary-image-tag
  metrics:
    - name: integration-tests
      count: 1
      failureLimit: 0
      provider:
        job:
          spec:
            backoffLimit: 0
            template:
              spec:
                restartPolicy: Never
                containers:
                  - name: integration-tests
                    image: registry.example.com/api-integration-tests:{{ args.canary-image-tag }}
                    env:
                      - name: TARGET_URL
                        value: http://api-service-canary.production.svc.cluster.local
                      - name: TEST_SUITE
                        value: smoke
                    resources:
                      requests:
                        cpu: 100m
                        memory: 128Mi
                      limits:
                        cpu: 500m
                        memory: 256Mi
```

## Blue-Green Deployments

Blue-green deployments maintain two complete environments. The green environment runs the current stable version while blue runs the new version. Traffic switches atomically when the blue environment is validated.

### Blue-Green Rollout Configuration

```yaml
# rollout-bluegreen.yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: payment-service
  namespace: production
spec:
  replicas: 5
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
          image: registry.example.com/payment-service:3.0.0
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 2Gi
          readinessProbe:
            httpGet:
              path: /readyz
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 5
            failureThreshold: 3
  strategy:
    blueGreen:
      activeService: payment-service-active       # receives production traffic
      previewService: payment-service-preview     # receives preview traffic only
      autoPromotionEnabled: false                 # require manual promotion
      autoPromotionSeconds: 0
      scaleDownDelaySeconds: 30                   # keep old pods briefly for in-flight requests
      previewReplicaCount: 2                      # run only 2 preview pods to save resources
      prePromotionAnalysis:
        templates:
          - templateName: integration-test-suite
        args:
          - name: canary-image-tag
            value: "3.0.0"
      postPromotionAnalysis:
        templates:
          - templateName: api-success-rate
        args:
          - name: service-name
            value: payment-service-active
      antiAffinity:
        requiredDuringSchedulingIgnoredDuringExecution: {}
---
apiVersion: v1
kind: Service
metadata:
  name: payment-service-active
  namespace: production
spec:
  selector:
    app: payment-service
  ports:
    - port: 80
      targetPort: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: payment-service-preview
  namespace: production
spec:
  selector:
    app: payment-service
  ports:
    - port: 80
      targetPort: 8080
```

### Blue-Green Promotion Workflow

```bash
# Watch the rollout status
kubectl argo rollouts get rollout payment-service -n production --watch

# Output shows current state:
# Name:            payment-service
# Namespace:       production
# Status:          ✔ Healthy
# Strategy:        BlueGreen
# Images:          registry.example.com/payment-service:2.9.0 (active)
#                  registry.example.com/payment-service:3.0.0 (preview)
# Replicas:
#   Desired:       5
#   Current:       7  (5 active + 2 preview)
#   Updated:       2
#   Ready:         7
#   Available:     5

# Validate the preview environment
curl http://payment-service-preview.production.svc.cluster.local/version
# {"version": "3.0.0", "build": "2030-05-17-a1b2c3d"}

# Manually promote to production (makes preview the active environment)
kubectl argo rollouts promote payment-service -n production

# Abort and roll back to previous version
kubectl argo rollouts abort payment-service -n production
```

## Notifications and Alerting

### Configuring Rollout Notifications

```yaml
# notification-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argo-rollouts-notification-configmap
  namespace: argo-rollouts
data:
  service.slack: |
    token: <slack-bot-token>
  template.rollout-started: |
    message: |
      Rollout *{{.rollout.metadata.name}}* has started in `{{.rollout.metadata.namespace}}`.
      Image: `{{range .rollout.spec.template.spec.containers}}{{.image}}{{end}}`
  template.rollout-completed: |
    message: |
      :white_check_mark: Rollout *{{.rollout.metadata.name}}* completed successfully.
  template.rollout-aborted: |
    message: |
      :x: Rollout *{{.rollout.metadata.name}}* was aborted.
      Reason: {{.rollout.status.message}}
  template.analysis-failed: |
    message: |
      :warning: Analysis for *{{.rollout.metadata.name}}* failed.
      Check metrics at http://grafana.monitoring.svc/d/rollouts
  trigger.on-rollout-started: |
    - send: [rollout-started]
      when: rollout.status.phase == "Progressing"
  trigger.on-rollout-completed: |
    - send: [rollout-completed]
      when: rollout.status.phase == "Healthy"
  trigger.on-rollout-aborted: |
    - send: [rollout-aborted]
      when: rollout.status.phase == "Degraded"
---
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: api-service
  namespace: production
  annotations:
    notifications.argoproj.io/subscribe.on-rollout-started.slack: "deployments"
    notifications.argoproj.io/subscribe.on-rollout-completed.slack: "deployments"
    notifications.argoproj.io/subscribe.on-rollout-aborted.slack: "incidents"
    notifications.argoproj.io/subscribe.on-analysis-failed.slack: "incidents"
```

## Operational Commands

### Managing Rollouts

```bash
# List all rollouts with status
kubectl argo rollouts list rollouts -n production

# Pause an in-progress rollout at the current step
kubectl argo rollouts pause api-service -n production

# Resume a paused rollout
kubectl argo rollouts resume api-service -n production

# Manually promote past a pause step without waiting
kubectl argo rollouts promote api-service -n production

# Promote all remaining steps immediately (skip remaining pauses and analyses)
kubectl argo rollouts promote api-service -n production --full

# Abort and roll back
kubectl argo rollouts abort api-service -n production

# Retry an aborted rollout
kubectl argo rollouts retry rollout api-service -n production

# Manually update the image
kubectl argo rollouts set image api-service \
  api-service=registry.example.com/api-service:2.2.0 -n production

# Get detailed analysis run results
kubectl argo rollouts get rollout api-service -n production
kubectl get analysisrun -n production --show-labels

# View analysis run logs
ANALYSIS_RUN=$(kubectl get analysisrun -n production \
  -l rollout.argoproj.io/rollout=api-service \
  -o jsonpath='{.items[-1].metadata.name}')
kubectl describe analysisrun "${ANALYSIS_RUN}" -n production
```

### Rollout Status Dashboard

```bash
# Terminal dashboard for all rollouts in a namespace
kubectl argo rollouts dashboard -n production

# This launches a web UI at http://localhost:3100
# showing real-time rollout status, replica counts, and analysis results
```

## GitOps Integration with Argo CD

### Application Set with Rollouts

```yaml
# applicationset-with-rollouts.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: api-service-envs
  namespace: argocd
spec:
  generators:
    - list:
        elements:
          - env: staging
            weight: "50"    # Canary gets 50% in staging
          - env: production
            weight: "10"    # Canary starts at 10% in production
  template:
    metadata:
      name: "api-service-{{env}}"
    spec:
      project: default
      source:
        repoURL: https://github.com/example/api-service-config
        targetRevision: HEAD
        path: "environments/{{env}}"
        helm:
          values: |
            rollout:
              strategy:
                canary:
                  steps:
                    - setWeight: {{weight}}
                    - pause: {duration: 10m}
      destination:
        server: https://kubernetes.default.svc
        namespace: "{{env}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

## Rollout Monitoring with Prometheus

### Key Metrics to Track

```yaml
# prometheus-rollout-rules.yaml
groups:
  - name: argo_rollouts
    rules:
      - alert: RolloutDegraded
        expr: argo_rollout_phase{phase="Degraded"} == 1
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Rollout {{ $labels.name }} is degraded"
          description: "Rollout {{ $labels.name }} in {{ $labels.namespace }} has been degraded for 5 minutes"

      - alert: AnalysisFailed
        expr: argo_analysis_run_phase{phase="Failed"} == 1
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "Analysis run failed for rollout {{ $labels.rollout }}"

      - alert: RolloutStuck
        expr: |
          (time() - argo_rollout_info{phase="Progressing"}) > 3600
        for: 0m
        labels:
          severity: warning
        annotations:
          summary: "Rollout {{ $labels.name }} has been progressing for over 1 hour"

      - record: job:rollout_success_rate:5m
        expr: |
          sum(rate(argo_rollout_info{phase="Healthy"}[5m])) by (namespace)
          /
          sum(rate(argo_rollout_info[5m])) by (namespace)
```

## Common Production Patterns

### Ephemeral Analysis with Experiment

Argo Rollouts Experiments allow testing a new version alongside the current stable without affecting traffic routing. This is valuable for performance or compatibility validation.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Experiment
metadata:
  name: api-service-experiment-v220
  namespace: production
spec:
  duration: 30m
  templates:
    - name: baseline
      replicas: 2
      selector:
        matchLabels:
          app: api-service-experiment
          variant: baseline
      template:
        metadata:
          labels:
            app: api-service-experiment
            variant: baseline
        spec:
          containers:
            - name: api-service
              image: registry.example.com/api-service:2.1.0
              ports:
                - containerPort: 8080
    - name: canary
      replicas: 2
      selector:
        matchLabels:
          app: api-service-experiment
          variant: canary
      template:
        metadata:
          labels:
            app: api-service-experiment
            variant: canary
        spec:
          containers:
            - name: api-service
              image: registry.example.com/api-service:2.2.0
              ports:
                - containerPort: 8080
  analyses:
    - name: compare-metrics
      templateName: compare-baseline-canary
      args:
        - name: baseline-service
          value: api-service-experiment-baseline
        - name: canary-service
          value: api-service-experiment-canary
```

### Rollout with Pre/Post-Sync Hooks

When using Argo CD with Argo Rollouts, resource hooks can run database migrations or cache warmup before traffic shifts.

```yaml
# pre-sync job for database migration
apiVersion: batch/v1
kind: Job
metadata:
  name: db-migration
  namespace: production
  annotations:
    argocd.argoproj.io/hook: PreSync
    argocd.argoproj.io/hook-delete-policy: HookSucceeded
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: registry.example.com/api-service:2.2.0
          command: ["./migrate", "--direction=up"]
          env:
            - name: DB_HOST
              valueFrom:
                secretKeyRef:
                  name: db-credentials
                  key: host
```

Argo Rollouts transforms Kubernetes deployments from a binary switch into a controlled, observable process with automatic safeguards. Combined with AnalysisTemplates that evaluate real production signals, teams can confidently ship changes knowing that the delivery system will halt and roll back automatically when quality thresholds are violated.
