---
title: "Argo Rollouts: Progressive Delivery with Canary and Blue-Green Deployments on Kubernetes"
date: 2026-12-28T00:00:00-05:00
draft: false
tags: ["Argo Rollouts", "Kubernetes", "Progressive Delivery", "Canary", "Blue-Green"]
categories:
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to Argo Rollouts for automated canary and blue-green deployments with traffic splitting, analysis runs, and metric-based promotion on Kubernetes."
more_link: "yes"
url: "/argo-rollouts-progressive-delivery-canary-blue-green-guide/"
---

Kubernetes `Deployment` objects provide a reliable mechanism for rolling updates, but they lack the control surface that production-grade release engineering demands. A standard rolling update shifts 100% of traffic to new replicas over time without any awareness of application health, business metrics, or error rates. When a bad release reaches even 20% of production traffic, the blast radius can be enormous before automated rollback triggers — and native Kubernetes has no mechanism for metric-based promotion decisions.

**Argo Rollouts** fills that gap. It extends Kubernetes with a `Rollout` custom resource that replaces `Deployment` for workloads requiring progressive delivery. Combined with `AnalysisTemplate` resources, Rollouts can query Prometheus, Datadog, New Relic, or custom HTTP endpoints to make automated go/no-go decisions at each step of a canary progression. This removes the human bottleneck from release pipelines while simultaneously reducing blast radius.

This guide covers the full operational lifecycle of Argo Rollouts in enterprise environments: installation, canary configuration with Nginx and Istio traffic splitting, blue-green deployments with pre- and post-promotion hooks, automated analysis, notification integration, and multi-cluster operational patterns. Every example reflects real-world configurations used in high-traffic production systems.

<!--more-->

## Architecture and Core Concepts

Argo Rollouts ships as a single controller deployment that watches `Rollout`, `AnalysisRun`, `AnalysisTemplate`, `ClusterAnalysisTemplate`, and `Experiment` custom resources. The controller reconciles rollout state against the desired spec and interacts with the ingress or service mesh layer to manipulate traffic weights.

The key primitives are:

- **Rollout**: Drop-in replacement for `Deployment`, adds `.spec.strategy.canary` or `.spec.strategy.blueGreen`.
- **AnalysisTemplate**: Reusable metric query definitions that determine whether a rollout step passes or fails.
- **AnalysisRun**: An instantiated execution of an `AnalysisTemplate`, created automatically during rollout steps.
- **Experiment**: Runs multiple parallel `ReplicaSet` variants for A/B testing scenarios.

The controller does not replace `kube-controller-manager`; it runs alongside it and manages the `ReplicaSet` objects that the standard controller would normally own. This design means rollouts are non-destructive to the cluster control plane.

### Controller Deployment Model

The controller requires cluster-scoped RBAC permissions to manage `ReplicaSet`, `Service`, `Ingress`, and mesh-specific resources across namespaces. In multi-tenant clusters, the namespace-scoped installation mode restricts the controller to a single namespace, which limits cross-namespace analysis templates but provides better isolation.

```
Rollout CR
    |
    v
Argo Rollouts Controller
    |           |
    v           v
ReplicaSet   AnalysisRun
(stable)      (metrics)
    |
    v
ReplicaSet
(canary)
    |
    v
Ingress/VirtualService
(traffic weight)
```

## Installation and Initial Configuration

### Cluster-Wide Installation

The standard installation deploys the controller and all required CRDs into the `argo-rollouts` namespace:

```bash
kubectl create namespace argo-rollouts

kubectl apply -n argo-rollouts \
  -f https://github.com/argoproj/argo-rollouts/releases/download/v1.7.2/install.yaml

kubectl -n argo-rollouts wait --for=condition=available \
  deployment/argo-rollouts --timeout=120s

kubectl argo rollouts version
```

Install the `kubectl` plugin for CLI access:

```bash
curl -LO "https://github.com/argoproj/argo-rollouts/releases/download/v1.7.2/kubectl-argo-rollouts-linux-amd64"
chmod +x kubectl-argo-rollouts-linux-amd64
sudo mv kubectl-argo-rollouts-linux-amd64 /usr/local/bin/kubectl-argo-rollouts

kubectl argo rollouts version
```

### Helm-Based Installation for GitOps Workflows

For GitOps-managed clusters, the Helm chart provides full configuration control:

```yaml
# values-argo-rollouts.yaml
controller:
  replicas: 2
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 512Mi
  tolerations:
  - key: node-role
    operator: Equal
    value: infrastructure
    effect: NoSchedule
  nodeSelector:
    node-role: infrastructure
  metrics:
    enabled: true
    serviceMonitor:
      enabled: true
      namespace: monitoring
      interval: 30s

dashboard:
  enabled: true
  service:
    type: ClusterIP
    port: 3100

notifications:
  secret:
    create: true
    items:
      slack-token: ""
```

```bash
helm repo add argo https://argoproj.github.io/argo-helm
helm repo update

helm upgrade --install argo-rollouts argo/argo-rollouts \
  --namespace argo-rollouts \
  --create-namespace \
  --values values-argo-rollouts.yaml \
  --version 2.37.6
```

## Canary Deployments with Nginx Traffic Splitting

### Prerequisites: Dual Services

Canary deployments with traffic splitting require two `Service` objects pointing to the same pod selector, but with different names. The Argo Rollouts controller modifies their selectors dynamically during the rollout:

```yaml
# services.yaml
apiVersion: v1
kind: Service
metadata:
  name: api-server-stable
  namespace: production
spec:
  selector:
    app: api-server
  ports:
  - port: 80
    targetPort: 8080
    protocol: TCP
---
apiVersion: v1
kind: Service
metadata:
  name: api-server-canary
  namespace: production
spec:
  selector:
    app: api-server
  ports:
  - port: 80
    targetPort: 8080
    protocol: TCP
```

### Nginx Ingress Configuration

The stable `Ingress` must be annotated to enable canary weight management. Argo Rollouts creates a mirror canary ingress automatically:

```yaml
# ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-server-ingress
  namespace: production
  annotations:
    kubernetes.io/ingress.class: nginx
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "60"
spec:
  rules:
  - host: api.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: api-server-stable
            port:
              number: 80
  tls:
  - hosts:
    - api.example.com
    secretName: api-example-com-tls
```

### The Rollout Resource

The following `Rollout` implements a multi-step canary with automated metric-gated promotion:

```yaml
# rollout-api-server.yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: api-server
  namespace: production
  annotations:
    notifications.argoproj.io/subscribe.on-rollout-completed.slack: production-deployments
    notifications.argoproj.io/subscribe.on-rollout-aborted.slack: production-alerts
spec:
  replicas: 10
  selector:
    matchLabels:
      app: api-server
  template:
    metadata:
      labels:
        app: api-server
    spec:
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchExpressions:
                - key: app
                  operator: In
                  values:
                  - api-server
              topologyKey: kubernetes.io/hostname
      containers:
      - name: api-server
        image: registry.example.com/api-server:v2.1.0
        ports:
        - containerPort: 8080
        resources:
          requests:
            cpu: 250m
            memory: 256Mi
          limits:
            cpu: 500m
            memory: 512Mi
        readinessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 10
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 15
          periodSeconds: 20
  strategy:
    canary:
      canaryService: api-server-canary
      stableService: api-server-stable
      trafficRouting:
        nginx:
          stableIngress: api-server-ingress
      steps:
      - setWeight: 5
      - pause: {duration: 5m}
      - setWeight: 20
      - analysis:
          templates:
          - templateName: success-rate
          args:
          - name: service-name
            value: api-server-canary
      - setWeight: 40
      - pause: {duration: 5m}
      - setWeight: 60
      - analysis:
          templates:
          - templateName: success-rate
          - templateName: latency-p99
          args:
          - name: service-name
            value: api-server-canary
      - setWeight: 80
      - pause: {duration: 5m}
      maxSurge: "25%"
      maxUnavailable: 0
```

### Monitoring the Rollout Progress

```bash
kubectl argo rollouts get rollout api-server -n production --watch

kubectl argo rollouts status api-server -n production
```

The output shows each step, the current weight, and analysis run status in real time.

## Automated Analysis with AnalysisTemplates

### Prometheus-Based Success Rate Analysis

The `AnalysisTemplate` defines the metric query, evaluation frequency, success criteria, and failure tolerance. These templates are reusable across multiple rollouts:

```yaml
# analysis-success-rate.yaml
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
    count: 5
    successCondition: result[0] >= 0.95
    failureLimit: 2
    provider:
      prometheus:
        address: http://prometheus-operated.monitoring.svc.cluster.local:9090
        query: |
          sum(rate(http_requests_total{service="{{args.service-name}}",status!~"5.."}[2m]))
          /
          sum(rate(http_requests_total{service="{{args.service-name}}"}[2m]))
```

### P99 Latency Analysis

High latency under canary traffic is as damaging as elevated error rates. This template catches latency regressions before full promotion:

```yaml
# analysis-latency.yaml
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
    count: 5
    successCondition: result[0] <= 0.5
    failureLimit: 2
    provider:
      prometheus:
        address: http://prometheus-operated.monitoring.svc.cluster.local:9090
        query: |
          histogram_quantile(0.99,
            sum(rate(http_request_duration_seconds_bucket{service="{{args.service-name}}"}[2m])) by (le)
          )
```

### Job-Based Smoke Test Analysis

For integration tests that cannot be expressed as metric queries, job-based analysis executes a Kubernetes `Job` and uses its exit code as the pass/fail signal:

```yaml
# analysis-smoke-test.yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: smoke-test
  namespace: production
spec:
  args:
  - name: service-name
  - name: service-port
    value: "80"
  metrics:
  - name: smoke-test-job
    provider:
      job:
        spec:
          backoffLimit: 1
          template:
            spec:
              restartPolicy: Never
              containers:
              - name: smoke-test
                image: registry.example.com/integration-tests:latest
                command:
                - /bin/sh
                - -c
                - |
                  BASE_URL="http://{{args.service-name}}:{{args.service-port}}"
                  curl -sf "${BASE_URL}/healthz" || exit 1
                  curl -sf "${BASE_URL}/api/v1/status" || exit 1
                  echo "Smoke tests passed"
```

### ClusterAnalysisTemplate for Shared Templates

When the same analysis templates are needed across multiple namespaces, use `ClusterAnalysisTemplate`:

```yaml
# cluster-analysis-template.yaml
apiVersion: argoproj.io/v1alpha1
kind: ClusterAnalysisTemplate
metadata:
  name: global-success-rate
spec:
  args:
  - name: service-name
  - name: namespace
  metrics:
  - name: success-rate
    interval: 1m
    count: 5
    successCondition: result[0] >= 0.95
    failureLimit: 3
    provider:
      prometheus:
        address: http://prometheus-operated.monitoring.svc.cluster.local:9090
        query: |
          sum(rate(http_requests_total{namespace="{{args.namespace}}",service="{{args.service-name}}",status!~"5.."}[2m]))
          /
          sum(rate(http_requests_total{namespace="{{args.namespace}}",service="{{args.service-name}}"}[2m]))
```

Reference the `ClusterAnalysisTemplate` in a rollout using `clusterScope: true`:

```yaml
steps:
- analysis:
    templates:
    - templateName: global-success-rate
      clusterScope: true
    args:
    - name: service-name
      value: api-server-canary
    - name: namespace
      value: production
```

## Blue-Green Deployments with Promotion Hooks

Blue-green deployments maintain two full-capacity `ReplicaSet` objects simultaneously. The preview environment receives no production traffic until the promotion step. Pre-promotion analysis validates the preview environment, and post-promotion analysis confirms the newly active environment is healthy before the old `ReplicaSet` is scaled down.

### Blue-Green Rollout Configuration

```yaml
# rollout-payment-service.yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: payment-service
  namespace: production
  annotations:
    notifications.argoproj.io/subscribe.on-rollout-completed.slack: production-deployments
    notifications.argoproj.io/subscribe.on-rollout-aborted.slack: production-alerts
spec:
  replicas: 6
  selector:
    matchLabels:
      app: payment-service
  template:
    metadata:
      labels:
        app: payment-service
    spec:
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: payment-service
      containers:
      - name: payment-service
        image: registry.example.com/payment-service:v3.0.0
        ports:
        - containerPort: 8080
        env:
        - name: DB_HOST
          valueFrom:
            secretKeyRef:
              name: payment-db-secret
              key: host
        - name: DB_NAME
          value: payments
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
          limits:
            cpu: 1000m
            memory: 1Gi
  strategy:
    blueGreen:
      activeService: payment-service-active
      previewService: payment-service-preview
      autoPromotionEnabled: false
      scaleDownDelaySeconds: 30
      prePromotionAnalysis:
        templates:
        - templateName: smoke-test
        args:
        - name: service-name
          value: payment-service-preview
        - name: service-port
          value: "80"
      postPromotionAnalysis:
        templates:
        - templateName: success-rate
        - templateName: latency-p99
        args:
        - name: service-name
          value: payment-service-active
```

### Blue-Green Services

```yaml
# services-payment.yaml
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

### Manual Promotion Workflow

With `autoPromotionEnabled: false`, the rollout pauses indefinitely at the promotion gate. This supports manual QA validation before promotion:

```bash
kubectl argo rollouts get rollout payment-service -n production

kubectl argo rollouts promote payment-service -n production

kubectl argo rollouts abort payment-service -n production
```

To promote and skip post-promotion analysis (emergency use only):

```bash
kubectl argo rollouts promote payment-service --full -n production
```

## Istio Traffic Splitting for Fine-Grained Control

Istio's `VirtualService` provides header-based and weight-based routing that Nginx cannot match. The Argo Rollouts controller updates the `VirtualService` weights directly at each rollout step.

### Istio VirtualService Prerequisites

```yaml
# virtualservice-frontend.yaml
apiVersion: networking.istio.io/v1alpha3
kind: VirtualService
metadata:
  name: frontend-vs
  namespace: production
spec:
  hosts:
  - frontend.example.com
  gateways:
  - production/main-gateway
  http:
  - name: primary
    route:
    - destination:
        host: frontend-stable
        port:
          number: 80
      weight: 100
    - destination:
        host: frontend-canary
        port:
          number: 80
      weight: 0
```

### Rollout with Istio Traffic Routing

```yaml
# rollout-frontend.yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: frontend
  namespace: production
spec:
  replicas: 8
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
        image: registry.example.com/frontend:v4.2.0
        ports:
        - containerPort: 3000
        resources:
          requests:
            cpu: 200m
            memory: 256Mi
          limits:
            cpu: 400m
            memory: 512Mi
  strategy:
    canary:
      canaryService: frontend-canary
      stableService: frontend-stable
      trafficRouting:
        istio:
          virtualService:
            name: frontend-vs
            routes:
            - primary
      steps:
      - setWeight: 10
      - pause: {duration: 10m}
      - setWeight: 25
      - analysis:
          templates:
          - templateName: success-rate
          args:
          - name: service-name
            value: frontend-canary
      - setWeight: 50
      - pause: {duration: 10m}
      - setWeight: 75
      - analysis:
          templates:
          - templateName: success-rate
          - templateName: latency-p99
          args:
          - name: service-name
            value: frontend-canary
```

### Header-Based Canary Routing with Istio

For testing the canary with internal traffic before exposing it to any percentage of production users, add a header match to the `VirtualService`:

```yaml
# virtualservice-header-canary.yaml
apiVersion: networking.istio.io/v1alpha3
kind: VirtualService
metadata:
  name: frontend-vs
  namespace: production
spec:
  hosts:
  - frontend.example.com
  gateways:
  - production/main-gateway
  http:
  - name: canary-header
    match:
    - headers:
        x-canary:
          exact: "true"
    route:
    - destination:
        host: frontend-canary
        port:
          number: 80
      weight: 100
  - name: primary
    route:
    - destination:
        host: frontend-stable
        port:
          number: 80
      weight: 100
    - destination:
        host: frontend-canary
        port:
          number: 80
      weight: 0
```

## Notification Integration

### Slack and Webhook Notifications

The Argo Rollouts notifications engine reads from a `ConfigMap` and a `Secret` in the controller namespace:

```yaml
# notification-secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: argo-rollouts-notification-secret
  namespace: argo-rollouts
type: Opaque
stringData:
  slack-token: "xoxb-EXAMPLE_REPLACE_WITH_REAL_SLACK_TOKEN"
```

```yaml
# notification-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argo-rollouts-notification-cm
  namespace: argo-rollouts
data:
  service.slack: |
    token: $slack-token
  service.webhook.pagerduty: |
    url: https://events.pagerduty.com/v2/enqueue
    headers:
    - name: Content-Type
      value: application/json
  template.rollout-completed: |
    message: |
      :white_check_mark: Rollout *{{.rollout.metadata.name}}* completed in *{{.rollout.metadata.namespace}}*.
      New image: `{{(index .rollout.spec.template.spec.containers 0).image}}`
  template.rollout-aborted: |
    slack:
      color: danger
    message: |
      :x: Rollout *{{.rollout.metadata.name}}* was *aborted* in *{{.rollout.metadata.namespace}}*.
      Reason: {{.rollout.status.message}}
  template.analysis-run-failed: |
    slack:
      color: warning
    message: |
      :warning: Analysis run failed for rollout *{{.rollout.metadata.name}}*.
      Failed metric: {{range .analysisRun.status.metricResults}}{{if eq .phase "Failed"}}{{.name}}{{end}}{{end}}
  trigger.on-rollout-completed: |
    - condition: rollout.status.phase == "Healthy"
      send: [rollout-completed]
  trigger.on-rollout-aborted: |
    - condition: rollout.status.phase == "Degraded"
      send: [rollout-aborted]
  trigger.on-analysis-run-failed: |
    - condition: analysisRun.status.phase == "Failed"
      send: [analysis-run-failed]
```

Annotate individual rollouts to subscribe them to specific triggers and channels:

```yaml
metadata:
  annotations:
    notifications.argoproj.io/subscribe.on-rollout-completed.slack: production-deployments
    notifications.argoproj.io/subscribe.on-rollout-aborted.slack: production-alerts
    notifications.argoproj.io/subscribe.on-analysis-run-failed.slack: production-alerts
```

## Rollback Strategies and Abort Conditions

### Automatic Abort on Analysis Failure

When an `AnalysisRun` crosses the `failureLimit`, the rollout transitions to `Degraded` and automatically scales back to the last stable `ReplicaSet`. The controller does not require human intervention for automatic rollback.

Configure abort conditions directly in the rollout step for tighter control:

```yaml
strategy:
  canary:
    abortScaleDownDelaySeconds: 30
    steps:
    - setWeight: 10
    - pause: {duration: 2m}
    - analysis:
        templates:
        - templateName: success-rate
        args:
        - name: service-name
          value: api-server-canary
```

When the analysis fails, trigger a rollback:

```bash
kubectl argo rollouts abort api-server -n production

kubectl argo rollouts undo api-server -n production

kubectl argo rollouts get rollout api-server -n production --watch
```

### Retrying a Failed Rollout

After fixing the root cause of an analysis failure and pushing a corrected image:

```bash
kubectl argo rollouts set image api-server \
  api-server=registry.example.com/api-server:v2.1.1 \
  -n production

kubectl argo rollouts retry rollout api-server -n production
```

### Pinning the Stable ReplicaSet

In emergency scenarios where the canary has already received traffic and needs to be fully halted, scaling the canary `ReplicaSet` to zero while preserving the stable version is the safest path:

```bash
kubectl argo rollouts abort api-server -n production

kubectl argo rollouts get rollout api-server -n production
```

The stable `ReplicaSet` remains at full capacity while the canary `ReplicaSet` drains.

## Anti-Affinity and Traffic Weight Configuration

### Spreading Canary Pods Across Zones

Zone-aware scheduling prevents all canary replicas from landing on the same node or availability zone, which would make the canary sample non-representative:

```yaml
spec:
  template:
    spec:
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: ScheduleAnyway
        labelSelector:
          matchLabels:
            app: api-server
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchExpressions:
              - key: app
                operator: In
                values:
                - api-server
              - key: rollouts-pod-template-hash
                operator: In
                values:
                - canary
            topologyKey: kubernetes.io/hostname
```

The `rollouts-pod-template-hash` label is injected by the controller on both stable and canary pods, enabling hard anti-affinity between the two variants.

### Dynamic Weight Calculation

For high-replica-count services, the actual traffic percentage depends on the ratio of canary-to-stable pods when `setWeight` is not using a traffic routing integration. The formula is:

```
actual_weight = canary_replicas / (stable_replicas + canary_replicas)
```

With a traffic routing integration (Nginx, Istio), weights are enforced at the data plane regardless of pod count, making the behavior deterministic.

## Multi-Cluster Operational Patterns

### Argo CD Integration for GitOps

In GitOps workflows managed by Argo CD, the `Rollout` resource is stored in Git and Argo CD syncs it to the cluster. The rollout controller handles the progressive delivery while Argo CD handles the desired state.

Configure Argo CD to ignore differences in managed fields that the rollout controller modifies:

```yaml
# argocd-application.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: api-server
  namespace: argocd
spec:
  project: production
  source:
    repoURL: https://github.com/example/k8s-manifests.git
    targetRevision: main
    path: apps/api-server/production
  destination:
    server: https://kubernetes.default.svc
    namespace: production
  syncPolicy:
    automated:
      prune: true
      selfHeal: false
  ignoreDifferences:
  - group: argoproj.io
    kind: Rollout
    jsonPointers:
    - /spec/paused
    - /spec/replicas
```

Setting `selfHeal: false` prevents Argo CD from reverting mid-rollout weight changes that the controller makes. The controller owns the rollout lifecycle; Argo CD owns the initial deployment intent.

### Cross-Cluster Canary Coordination

For global services deployed across multiple clusters, coordinate canary progression by running the analysis in one cluster first:

```bash
for CLUSTER in us-east-1 eu-west-1 ap-southeast-1; do
  kubectl --context "k8s-${CLUSTER}" argo rollouts get rollout api-server \
    -n production --no-headers | awk '{print $1, $2, $3}'
done
```

A common pattern is to promote the canary in a low-traffic region first (for example, `ap-southeast-1`), observe for 24 hours, then promote in the primary regions sequentially.

## Conclusion

Argo Rollouts transforms Kubernetes release engineering from binary rolling updates into a programmable, metric-gated delivery pipeline. The key operational takeaways are:

- **AnalysisTemplates are the control surface**: Define success-rate and latency thresholds as code, version them in Git, and reuse them across all services. A failing release will abort automatically before reaching full traffic.
- **Blue-green is safer for stateful services**: The instantaneous traffic switch with pre-promotion smoke tests provides a clean rollback path that canary with gradual weight shifting cannot match when database schema changes are involved.
- **Traffic routing integrations are mandatory at scale**: Without Nginx or Istio, traffic splitting is pod-count-based, which is imprecise. Use a traffic routing integration for any service where exact percentages matter.
- **Istio enables header-based canary routing**: Internal QA teams can validate the canary via request headers before a single production user sees it, eliminating the risk of user-visible defects during early canary exposure.
- **GitOps requires careful Argo CD tuning**: The `ignoreDifferences` configuration for rollout-managed fields is non-negotiable in Argo CD environments to prevent sync loops during active rollouts.
