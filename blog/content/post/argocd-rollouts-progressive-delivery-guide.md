---
title: "Argo Rollouts: Progressive Delivery with Canary and Blue/Green Strategies"
date: 2028-01-01T00:00:00-05:00
draft: false
tags: ["Argo Rollouts", "Progressive Delivery", "Canary", "Blue/Green", "Kubernetes", "GitOps"]
categories: ["Kubernetes", "CI/CD"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Argo Rollouts covering the Rollout CRD, canary deployment steps, blue/green promotion, AnalysisTemplate with Prometheus, traffic splitting with Nginx/Istio/ALB, automated rollbacks, and kubectl argo plugin operations."
more_link: "yes"
url: "/argocd-rollouts-progressive-delivery-guide/"
---

Progressive delivery extends continuous deployment with risk-managed rollout strategies. Argo Rollouts replaces the standard Kubernetes Deployment controller with a Rollout CRD that natively supports canary deployments with configurable traffic weights, blue/green promotions with analysis gates, and automated rollback when metrics degrade below thresholds.

This guide covers the complete Argo Rollouts operational model: installing and configuring the controller, defining canary and blue/green Rollout strategies, integrating with Nginx Ingress, Istio, and AWS ALB for traffic splitting, implementing AnalysisTemplates that query Prometheus for automated go/no-go decisions, and using the kubectl argo plugin for deployment management.

<!--more-->

# Argo Rollouts: Progressive Delivery with Canary and Blue/Green Strategies

## Section 1: Architecture and Installation

### Argo Rollouts Components

```
Argo Rollouts
├── rollouts-controller    - Reconciles Rollout CRDs, manages ReplicaSets
├── rollouts-dashboard     - Web UI for rollout visualization
└── kubectl-argo-rollouts  - CLI plugin for rollout management

Integrations:
├── TrafficRouting         - Nginx, Istio, AWS ALB, GCP LB, APISIX, SMI
├── MetricsProviders       - Prometheus, Datadog, New Relic, Wavefront, CloudWatch
└── Notification           - Slack, PagerDuty, webhook
```

### Installation

```bash
# Install Argo Rollouts controller
kubectl create namespace argo-rollouts
kubectl apply -n argo-rollouts \
  -f https://github.com/argoproj/argo-rollouts/releases/latest/download/install.yaml

# Verify installation
kubectl get pods -n argo-rollouts

# Install kubectl plugin
curl -LO https://github.com/argoproj/argo-rollouts/releases/latest/download/kubectl-argo-rollouts-linux-amd64
chmod +x kubectl-argo-rollouts-linux-amd64
sudo install kubectl-argo-rollouts-linux-amd64 /usr/local/bin/kubectl-argo-rollouts

# Verify plugin
kubectl argo rollouts version

# Deploy Rollouts Dashboard
kubectl apply -n argo-rollouts \
  -f https://github.com/argoproj/argo-rollouts/releases/latest/download/dashboard-install.yaml

kubectl port-forward -n argo-rollouts svc/argo-rollouts-dashboard 3100:3100 &
# Access: http://localhost:3100/rollouts
```

## Section 2: Migrating from Deployment to Rollout

### Converting an Existing Deployment

```yaml
# BEFORE: Standard Kubernetes Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  namespace: production
spec:
  replicas: 10
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
          image: gcr.io/corp-registry/payment-service:v2.0.0
```

```yaml
# AFTER: Argo Rollout (drop-in replacement with progressive delivery)
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: payment-service
  namespace: production
spec:
  replicas: 10
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
          image: gcr.io/corp-registry/payment-service:v2.0.0
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
            limits:
              cpu: 1000m
              memory: 512Mi
  strategy:
    canary:
      # Traffic routing configuration (see Section 3)
      canaryService: payment-service-canary
      stableService: payment-service-stable
      trafficRouting:
        nginx:
          stableIngress: payment-service-ingress
      steps:
        - setWeight: 5      # 5% traffic to canary
        - pause: {duration: 2m}
        - setWeight: 20
        - pause: {duration: 5m}
        - analysis:
            templates:
              - templateName: success-rate-analysis
            args:
              - name: service-name
                value: payment-service-canary
        - setWeight: 50
        - pause: {duration: 10m}
        - analysis:
            templates:
              - templateName: success-rate-analysis
              - templateName: latency-analysis
        - setWeight: 100
      # Abort canary on analysis failure
      maxSurge: "25%"
      maxUnavailable: 0
```

## Section 3: Canary with Nginx Ingress Traffic Splitting

### Service and Ingress Configuration

```yaml
# services.yaml
---
# Stable service — routes to current (stable) ReplicaSet
apiVersion: v1
kind: Service
metadata:
  name: payment-service-stable
  namespace: production
spec:
  selector:
    app: payment-service
  ports:
    - port: 80
      targetPort: 8080
      protocol: TCP
---
# Canary service — routes to new (canary) ReplicaSet
apiVersion: v1
kind: Service
metadata:
  name: payment-service-canary
  namespace: production
spec:
  selector:
    app: payment-service
  ports:
    - port: 80
      targetPort: 8080
      protocol: TCP
---
# Ingress — Argo Rollouts modifies canary-weight annotation
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: payment-service-ingress
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/proxy-connect-timeout: "60"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "60"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - payment.corp.example.com
      secretName: payment-service-tls
  rules:
    - host: payment.corp.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: payment-service-stable  # Initially points to stable
                port:
                  number: 80
```

### Full Canary Rollout with Steps

```yaml
# rollout-canary-nginx.yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: payment-service
  namespace: production
spec:
  replicas: 10
  revisionHistoryLimit: 5
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
          image: gcr.io/corp-registry/payment-service:v3.0.0
          readinessProbe:
            httpGet:
              path: /health/ready
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
  strategy:
    canary:
      stableService: payment-service-stable
      canaryService: payment-service-canary
      trafficRouting:
        nginx:
          stableIngress: payment-service-ingress
          additionalIngressAnnotations:
            canary-by-header: X-Canary
            canary-by-header-value: "true"
      steps:
        # Phase 1: Probe canary with small traffic slice
        - setWeight: 5
        - pause:
            duration: 3m
        # Phase 2: Automated analysis at 5% traffic
        - analysis:
            templates:
              - templateName: success-rate-analysis
              - templateName: p99-latency-analysis
            args:
              - name: service-name
                value: payment-service-canary
              - name: namespace
                value: production

        # Phase 3: Expand if analysis passed
        - setWeight: 25
        - pause:
            duration: 5m
        - analysis:
            templates:
              - templateName: success-rate-analysis
            args:
              - name: service-name
                value: payment-service-canary
              - name: namespace
                value: production

        # Phase 4: Manual gate for critical services
        - setWeight: 50
        - pause: {}  # Infinite pause — requires manual promotion

        # Phase 5: Full rollout
        - setWeight: 100

      # Anti-affinity: don't schedule canary on same node as stable
      antiAffinity:
        requiredDuringSchedulingIgnoredDuringExecution: {}
        preferredDuringSchedulingIgnoredDuringExecution:
          weight: 1

      maxSurge: "25%"
      maxUnavailable: 0

      # Automatic rollback on analysis failure
      abortScaleDownDelaySeconds: 30
```

## Section 4: AnalysisTemplate with Prometheus Metrics

### Success Rate Analysis

```yaml
# analysis-success-rate.yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: success-rate-analysis
  namespace: production
spec:
  args:
    - name: service-name
    - name: namespace
  metrics:
    - name: success-rate
      interval: 1m
      # Require at least 5 consecutive successful measurements
      count: 5
      successCondition: result[0] >= 0.99
      failureCondition: result[0] < 0.95
      failureLimit: 3
      provider:
        prometheus:
          address: http://prometheus.monitoring.svc.cluster.local:9090
          query: |
            sum(
              rate(
                http_requests_total{
                  service="{{args.service-name}}",
                  namespace="{{args.namespace}}",
                  status_code!~"5.."
                }[2m]
              )
            ) /
            sum(
              rate(
                http_requests_total{
                  service="{{args.service-name}}",
                  namespace="{{args.namespace}}"
                }[2m]
              )
            )
```

### P99 Latency Analysis

```yaml
# analysis-latency.yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: p99-latency-analysis
  namespace: production
spec:
  args:
    - name: service-name
    - name: namespace
  metrics:
    - name: p99-latency
      interval: 1m
      count: 5
      # P99 latency must be below 500ms
      successCondition: result[0] <= 0.5
      failureCondition: result[0] > 1.0
      failureLimit: 2
      provider:
        prometheus:
          address: http://prometheus.monitoring.svc.cluster.local:9090
          query: |
            histogram_quantile(0.99,
              sum(
                rate(
                  http_request_duration_seconds_bucket{
                    service="{{args.service-name}}",
                    namespace="{{args.namespace}}"
                  }[2m]
                )
              ) by (le)
            )
    - name: error-rate-db
      interval: 1m
      count: 5
      successCondition: result[0] < 0.01
      failureLimit: 2
      provider:
        prometheus:
          address: http://prometheus.monitoring.svc.cluster.local:9090
          query: |
            sum(
              rate(
                db_query_errors_total{
                  service="{{args.service-name}}"
                }[2m]
              )
            )
```

### Datadog Analysis Provider

```yaml
# analysis-datadog.yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: datadog-success-rate
  namespace: production
spec:
  args:
    - name: service-name
  metrics:
    - name: error-rate-dd
      interval: 2m
      count: 3
      successCondition: result[0] < 1.0
      failureLimit: 2
      provider:
        datadog:
          apiVersion: v2
          interval: 5m
          query: |
            sum:trace.payment.request.errors{service:{{args.service-name}},env:production}.as_rate() /
            sum:trace.payment.request.hits{service:{{args.service-name}},env:production}.as_rate() * 100
```

## Section 5: Blue/Green Strategy

```yaml
# rollout-bluegreen.yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: checkout-service
  namespace: production
spec:
  replicas: 8
  selector:
    matchLabels:
      app: checkout-service
  template:
    metadata:
      labels:
        app: checkout-service
    spec:
      containers:
        - name: checkout-service
          image: gcr.io/corp-registry/checkout-service:v4.0.0
          ports:
            - containerPort: 8080
          readinessProbe:
            httpGet:
              path: /health/ready
              port: 8080
            periodSeconds: 5
            failureThreshold: 3
  strategy:
    blueGreen:
      # Active service receives production traffic
      activeService: checkout-service-active
      # Preview service receives non-production traffic (for testing)
      previewService: checkout-service-preview
      # Require manual promotion (safety gate)
      autoPromotionEnabled: false
      autoPromotionSeconds: 0

      # Pre-promotion analysis before switching active traffic
      prePromotionAnalysis:
        templates:
          - templateName: success-rate-analysis
        args:
          - name: service-name
            value: checkout-service-preview
          - name: namespace
            value: production

      # Post-promotion analysis — if this fails, rollback
      postPromotionAnalysis:
        templates:
          - templateName: success-rate-analysis
          - templateName: p99-latency-analysis
        args:
          - name: service-name
            value: checkout-service-active
          - name: namespace
            value: production

      # Delay before scaling down old ReplicaSet (allows time for post-promotion analysis)
      scaleDownDelaySeconds: 300
      scaleDownDelayRevisionLimit: 2

      # Preview replica count (run full replica count for realistic testing)
      previewReplicaCount: 8

      # Auto-rollback if post-promotion analysis fails
      abortScaleDownDelaySeconds: 30
```

### Blue/Green Services

```yaml
# bluegreen-services.yaml
---
apiVersion: v1
kind: Service
metadata:
  name: checkout-service-active
  namespace: production
spec:
  selector:
    app: checkout-service
  ports:
    - port: 80
      targetPort: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: checkout-service-preview
  namespace: production
spec:
  selector:
    app: checkout-service
  ports:
    - port: 80
      targetPort: 8080
```

## Section 6: Istio Traffic Management

```yaml
# rollout-canary-istio.yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: api-gateway
  namespace: production
spec:
  replicas: 6
  selector:
    matchLabels:
      app: api-gateway
  template:
    metadata:
      labels:
        app: api-gateway
    spec:
      containers:
        - name: api-gateway
          image: gcr.io/corp-registry/api-gateway:v5.0.0
  strategy:
    canary:
      stableService: api-gateway-stable
      canaryService: api-gateway-canary
      trafficRouting:
        istio:
          virtualService:
            name: api-gateway-vsvc
            routes:
              - primary  # Name of the HTTPRoute in the VirtualService
          destinationRule:
            name: api-gateway-destrule
            stableSubsetName: stable
            canarySubsetName: canary
      steps:
        - setWeight: 10
        - pause: {duration: 5m}
        - analysis:
            templates:
              - templateName: success-rate-analysis
        - setWeight: 30
        - pause: {duration: 10m}
        - setWeight: 60
        - pause: {duration: 10m}
        - setWeight: 100
---
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: api-gateway-vsvc
  namespace: production
spec:
  hosts:
    - api-gateway
  http:
    - name: primary
      route:
        - destination:
            host: api-gateway-stable
            port:
              number: 80
          weight: 100
        - destination:
            host: api-gateway-canary
            port:
              number: 80
          weight: 0
---
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: api-gateway-destrule
  namespace: production
spec:
  host: api-gateway
  subsets:
    - name: stable
      labels:
        app: api-gateway
    - name: canary
      labels:
        app: api-gateway
```

## Section 7: AWS ALB Traffic Routing

```yaml
# rollout-canary-alb.yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: order-service
  namespace: production
spec:
  replicas: 10
  selector:
    matchLabels:
      app: order-service
  template:
    metadata:
      labels:
        app: order-service
    spec:
      containers:
        - name: order-service
          image: gcr.io/corp-registry/order-service:v2.5.0
  strategy:
    canary:
      stableService: order-service-stable
      canaryService: order-service-canary
      trafficRouting:
        alb:
          ingress: order-service-ingress
          servicePort: 80
          # Route specific headers to canary for targeted testing
          stickyConfig:
            stickyType: Cookie
            cookieDuration: 86400
      steps:
        - setWeight: 5
        - pause:
            duration: 10m
        - analysis:
            templates:
              - templateName: success-rate-analysis
        - setWeight: 20
        - pause:
            duration: 20m
        - setWeight: 50
        - pause: {}
        - setWeight: 100
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: order-service-ingress
  namespace: production
  annotations:
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTPS":443}]'
    alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:us-east-1:123456789012:certificate/xxx
spec:
  rules:
    - http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: order-service-stable
                port:
                  number: 80
```

## Section 8: kubectl-argo-rollouts Plugin Operations

```bash
# Watch rollout progress in real-time
kubectl argo rollouts get rollout payment-service -n production --watch

# Promote a paused canary (manual gate)
kubectl argo rollouts promote payment-service -n production

# Promote and skip all remaining steps (emergency rollout)
kubectl argo rollouts promote payment-service -n production --full

# Abort a canary rollout (rollback to stable)
kubectl argo rollouts abort payment-service -n production

# Retry an aborted rollout (attempt again after fixing the issue)
kubectl argo rollouts retry rollout payment-service -n production

# Pin canary at current weight (pause indefinitely)
kubectl argo rollouts pause payment-service -n production

# Resume from pause
kubectl argo rollouts resume payment-service -n production

# Set image (triggers new rollout)
kubectl argo rollouts set image payment-service \
  payment-service=gcr.io/corp-registry/payment-service:v3.1.0 \
  -n production

# Scale a rollout
kubectl argo rollouts scale payment-service --replicas 15 -n production

# List all rollouts with status
kubectl argo rollouts list rollouts -n production

# View rollout history
kubectl argo rollouts history payment-service -n production

# Rollback to previous revision
kubectl argo rollouts undo payment-service -n production

# Rollback to specific revision
kubectl argo rollouts undo payment-service --to-revision 3 -n production

# Dashboard
kubectl argo rollouts dashboard -n production
```

## Section 9: Automated Rollback Configuration

### Rollout-Level Abort Conditions

```yaml
# rollout-with-abort-config.yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: critical-service
  namespace: production
spec:
  strategy:
    canary:
      steps:
        - setWeight: 10
        - pause: {duration: 5m}
        - analysis:
            templates:
              - templateName: comprehensive-analysis
            args:
              - name: service-name
                value: critical-service-canary
      # Immediately scale down canary when aborted
      abortScaleDownDelaySeconds: 0
      # On abort, return to 100% stable immediately
      dynamicStableScale: true
```

### Cluster-Wide Analysis Run (Background)

```yaml
# cluster-analysis-template.yaml
apiVersion: argoproj.io/v1alpha1
kind: ClusterAnalysisTemplate
metadata:
  name: cluster-wide-error-rate
spec:
  metrics:
    - name: cluster-error-rate
      interval: 5m
      successCondition: result[0] < 0.005
      failureLimit: 1
      provider:
        prometheus:
          address: http://prometheus.monitoring.svc.cluster.local:9090
          query: |
            sum(rate(http_requests_total{status_code=~"5.."}[5m])) /
            sum(rate(http_requests_total[5m]))
```

## Section 10: Notifications Integration

```yaml
# notifications-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argo-rollouts-notification-configmap
  namespace: argo-rollouts
data:
  trigger.on-rollout-completed: |
    - send: [rollout-completed]
      when: rollout.status.phase == 'Healthy'
  trigger.on-rollout-aborted: |
    - send: [rollout-aborted]
      when: rollout.status.phase == 'Degraded'
  trigger.on-analysis-running: |
    - send: [analysis-running]
      when: rollout.status.phase == 'Progressing'
  template.rollout-completed: |
    message: |
      Rollout {{.rollout.metadata.name}} in {{.rollout.metadata.namespace}} completed successfully.
      Image: {{index .rollout.spec.template.spec.containers 0 "image"}}
  template.rollout-aborted: |
    message: |
      ALERT: Rollout {{.rollout.metadata.name}} was aborted.
      Namespace: {{.rollout.metadata.namespace}}
      Reason: Analysis failed or manual abort triggered.
  service.slack: |
    token: $slack-token
    channels: "#deployments"
```

This guide provides the complete operational framework for progressive delivery with Argo Rollouts. The combination of automated analysis gates, traffic splitting integration with multiple ingress controllers, and manual promotion checkpoints creates a deployment process that safely exposes new versions to production traffic while maintaining the ability to automatically roll back on metric degradation.
