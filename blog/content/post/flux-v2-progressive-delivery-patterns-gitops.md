---
title: "Flux v2 Progressive Delivery Patterns: Advanced GitOps Deployment Strategies"
date: 2026-07-09T00:00:00-05:00
draft: false
tags: ["Flux", "GitOps", "Progressive Delivery", "Kubernetes", "Flagger", "Canary Deployment", "CI/CD"]
categories: ["GitOps", "Kubernetes", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Master Flux v2 progressive delivery patterns including canary deployments, blue-green strategies, and automated rollbacks for production-grade Kubernetes deployments with Flagger integration."
more_link: "yes"
url: "/flux-v2-progressive-delivery-patterns-gitops/"
---

Flux v2 brings GitOps to the next level with native support for progressive delivery patterns through Flagger integration. This comprehensive guide explores advanced deployment strategies including canary analysis, blue-green deployments, A/B testing, and automated rollbacks for enterprise Kubernetes environments.

<!--more-->

# Flux v2 Progressive Delivery Patterns: Advanced GitOps Deployment Strategies

## Executive Summary

Progressive delivery extends continuous delivery with fine-grained control over the release process, reducing deployment risk through gradual rollouts and automated analysis. This guide covers Flux v2's integration with Flagger for implementing canary deployments, blue-green strategies, A/B testing, and automated rollback mechanisms in production environments.

## Flux v2 Architecture Overview

### Core Components

Flux v2 consists of specialized controllers working together:

```yaml
# Install Flux v2 with all controllers
apiVersion: v1
kind: Namespace
metadata:
  name: flux-system
---
# Source Controller - manages Git repositories and Helm repositories
apiVersion: apps/v1
kind: Deployment
metadata:
  name: source-controller
  namespace: flux-system
spec:
  replicas: 1
  selector:
    matchLabels:
      app: source-controller
  template:
    metadata:
      labels:
        app: source-controller
    spec:
      containers:
      - name: manager
        image: ghcr.io/fluxcd/source-controller:v1.2.0
        args:
        - --events-addr=http://notification-controller.flux-system.svc.cluster.local./
        - --watch-all-namespaces=true
        - --log-level=info
        - --log-encoding=json
        - --enable-leader-election
        # Storage configuration
        - --storage-path=/data
        - --storage-adv-addr=source-controller.$(RUNTIME_NAMESPACE).svc.cluster.local.
        # Performance tuning
        - --concurrent=10
        - --requeue-dependency=5s
        env:
        - name: RUNTIME_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace
        resources:
          requests:
            cpu: 100m
            memory: 64Mi
          limits:
            cpu: 1000m
            memory: 1Gi
        volumeMounts:
        - name: data
          mountPath: /data
        - name: tmp
          mountPath: /tmp
      volumes:
      - name: data
        emptyDir:
          sizeLimit: 10Gi
      - name: tmp
        emptyDir: {}
---
# Kustomize Controller - applies Kustomize manifests
apiVersion: apps/v1
kind: Deployment
metadata:
  name: kustomize-controller
  namespace: flux-system
spec:
  replicas: 1
  selector:
    matchLabels:
      app: kustomize-controller
  template:
    metadata:
      labels:
        app: kustomize-controller
    spec:
      containers:
      - name: manager
        image: ghcr.io/fluxcd/kustomize-controller:v1.2.0
        args:
        - --events-addr=http://notification-controller.flux-system.svc.cluster.local./
        - --watch-all-namespaces=true
        - --log-level=info
        - --log-encoding=json
        - --enable-leader-election
        # Performance tuning
        - --concurrent=10
        - --requeue-dependency=5s
        # Feature flags
        - --feature-gates=CacheSecretsAndConfigMaps=true
        - --kube-api-qps=500
        - --kube-api-burst=1000
        resources:
          requests:
            cpu: 100m
            memory: 64Mi
          limits:
            cpu: 1000m
            memory: 1Gi
---
# Helm Controller - manages Helm releases
apiVersion: apps/v1
kind: Deployment
metadata:
  name: helm-controller
  namespace: flux-system
spec:
  replicas: 1
  selector:
    matchLabels:
      app: helm-controller
  template:
    metadata:
      labels:
        app: helm-controller
    spec:
      containers:
      - name: manager
        image: ghcr.io/fluxcd/helm-controller:v0.37.0
        args:
        - --events-addr=http://notification-controller.flux-system.svc.cluster.local./
        - --watch-all-namespaces=true
        - --log-level=info
        - --log-encoding=json
        - --enable-leader-election
        # Performance tuning
        - --concurrent=10
        - --requeue-dependency=5s
        # Helm-specific settings
        - --http-retry-max=10
        resources:
          requests:
            cpu: 100m
            memory: 64Mi
          limits:
            cpu: 1000m
            memory: 1Gi
---
# Notification Controller - handles events and alerts
apiVersion: apps/v1
kind: Deployment
metadata:
  name: notification-controller
  namespace: flux-system
spec:
  replicas: 1
  selector:
    matchLabels:
      app: notification-controller
  template:
    metadata:
      labels:
        app: notification-controller
    spec:
      containers:
      - name: manager
        image: ghcr.io/fluxcd/notification-controller:v1.2.0
        args:
        - --watch-all-namespaces=true
        - --log-level=info
        - --log-encoding=json
        - --enable-leader-election
        resources:
          requests:
            cpu: 100m
            memory: 64Mi
          limits:
            cpu: 1000m
            memory: 1Gi
        ports:
        - containerPort: 9090
          name: http
        - containerPort: 9292
          name: http-webhook
        - containerPort: 9440
          name: healthz
```

### Git Source Configuration

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: production-apps
  namespace: flux-system
spec:
  interval: 1m
  url: https://github.com/example/production-apps
  ref:
    branch: main
  secretRef:
    name: git-credentials
  # Performance optimization
  timeout: 60s
  # Verify commits
  verify:
    mode: head
    secretRef:
      name: git-pgp-key
---
apiVersion: v1
kind: Secret
metadata:
  name: git-credentials
  namespace: flux-system
type: Opaque
stringData:
  username: git
  password: <github-token>
---
apiVersion: v1
kind: Secret
metadata:
  name: git-pgp-key
  namespace: flux-system
type: Opaque
stringData:
  identity: |
    -----BEGIN PGP PRIVATE KEY BLOCK-----
    ...
    -----END PGP PRIVATE KEY BLOCK-----
  identity.pub: |
    -----BEGIN PGP PUBLIC KEY BLOCK-----
    ...
    -----END PGP PUBLIC KEY BLOCK-----
```

## Flagger Integration

### Installing Flagger

```yaml
apiVersion: source.toolkit.fluxcd.io/v1beta2
kind: HelmRepository
metadata:
  name: flagger
  namespace: flux-system
spec:
  interval: 1h
  url: https://flagger.app
---
apiVersion: helm.toolkit.fluxcd.io/v2beta1
kind: HelmRelease
metadata:
  name: flagger
  namespace: flux-system
spec:
  interval: 10m
  chart:
    spec:
      chart: flagger
      version: '1.35.x'
      sourceRef:
        kind: HelmRepository
        name: flagger
        namespace: flux-system
  values:
    # Mesh provider configuration
    meshProvider: istio
    metricsServer: http://prometheus.monitoring:9090

    # Controller configuration
    podMonitor:
      enabled: true
      namespace: flux-system

    # Slack notifications
    slack:
      url: https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK
      channel: deployments
      user: flagger

    # Resource limits
    resources:
      limits:
        cpu: 1000m
        memory: 512Mi
      requests:
        cpu: 100m
        memory: 32Mi
---
# Install Flagger's Prometheus integration
apiVersion: helm.toolkit.fluxcd.io/v2beta1
kind: HelmRelease
metadata:
  name: flagger-grafana
  namespace: flux-system
spec:
  interval: 10m
  chart:
    spec:
      chart: grafana
      version: '7.0.x'
      sourceRef:
        kind: HelmRepository
        name: flagger
  values:
    datasources:
      datasources.yaml:
        apiVersion: 1
        datasources:
        - name: Prometheus
          type: prometheus
          url: http://prometheus.monitoring:9090
          isDefault: true

    dashboardProviders:
      dashboardproviders.yaml:
        apiVersion: 1
        providers:
        - name: 'default'
          orgId: 1
          folder: ''
          type: file
          disableDeletion: false
          editable: true
          options:
            path: /var/lib/grafana/dashboards/default
```

## Canary Deployment Patterns

### Basic Canary with Traffic Shifting

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: myapp
  namespace: production
spec:
  # Target deployment
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp

  # Progressive delivery service configuration
  service:
    port: 9898
    targetPort: 9898
    portDiscovery: true
    # Load balancer configuration
    apex:
      annotations:
        external-dns.alpha.kubernetes.io/hostname: myapp.example.com
    # Canary service annotations
    canary:
      annotations:
        external-dns.alpha.kubernetes.io/hostname: canary.myapp.example.com
    # Primary service annotations
    primary:
      annotations:
        external-dns.alpha.kubernetes.io/hostname: primary.myapp.example.com

  # Autoscaling configuration
  autoscalerRef:
    apiVersion: autoscaling/v2
    kind: HorizontalPodAutoscaler
    name: myapp
    primaryScalerReplicas:
      minReplicas: 2
      maxReplicas: 10
    canaryScalerReplicas:
      minReplicas: 1
      maxReplicas: 5

  # Canary analysis configuration
  analysis:
    # Schedule interval for canary analysis
    interval: 1m
    # Max number of failed checks before rollback
    threshold: 5
    # Max traffic percentage routed to canary
    maxWeight: 50
    # Traffic increment step
    stepWeight: 10
    # Duration to wait before scaling down canary
    stepWeightPromotion: 30

    # Metrics for canary analysis
    metrics:
    # Request success rate
    - name: request-success-rate
      templateRef:
        name: request-success-rate
        namespace: flux-system
      thresholdRange:
        min: 99
      interval: 1m

    # Request duration P99
    - name: request-duration
      templateRef:
        name: request-duration
        namespace: flux-system
      thresholdRange:
        max: 500
      interval: 1m

    # Custom business metric
    - name: error-rate
      templateRef:
        name: error-rate
        namespace: flux-system
      thresholdRange:
        max: 1
      interval: 1m

    # Webhooks for external validation
    webhooks:
    # Load testing
    - name: load-test
      type: pre-rollout
      url: http://flagger-loadtester.flux-system/
      timeout: 5s
      metadata:
        type: bash
        cmd: "curl -sd 'test' http://myapp-canary.production:9898/token | grep token"

    # Smoke tests
    - name: smoke-test
      type: pre-rollout
      url: http://flagger-loadtester.flux-system/
      timeout: 30s
      metadata:
        type: bash
        cmd: "./test/smoke-test.sh"

    # Integration tests
    - name: integration-test
      url: http://flagger-loadtester.flux-system/
      timeout: 60s
      metadata:
        type: cmd
        cmd: "hey -z 1m -q 10 -c 2 http://myapp-canary.production:9898/"

    # Approval gate
    - name: approval-gate
      type: confirm-rollout
      url: http://flagger-loadtester.flux-system/gate/approve

    # Rollback hook
    - name: rollback-notification
      type: rollback
      url: http://notification-service.flux-system/
      metadata:
        message: "Canary rollback for myapp"
---
# Metric templates
apiVersion: flagger.app/v1beta1
kind: MetricTemplate
metadata:
  name: request-success-rate
  namespace: flux-system
spec:
  provider:
    type: prometheus
    address: http://prometheus.monitoring:9090
  query: |
    sum(
      rate(
        http_requests_total{
          namespace="{{ namespace }}",
          deployment=~"{{ target }}",
          status!~"5.."
        }[{{ interval }}]
      )
    )
    /
    sum(
      rate(
        http_requests_total{
          namespace="{{ namespace }}",
          deployment=~"{{ target }}"
        }[{{ interval }}]
      )
    )
    * 100
---
apiVersion: flagger.app/v1beta1
kind: MetricTemplate
metadata:
  name: request-duration
  namespace: flux-system
spec:
  provider:
    type: prometheus
    address: http://prometheus.monitoring:9090
  query: |
    histogram_quantile(0.99,
      sum(
        rate(
          http_request_duration_seconds_bucket{
            namespace="{{ namespace }}",
            deployment=~"{{ target }}"
          }[{{ interval }}]
        )
      ) by (le)
    )
    * 1000
---
apiVersion: flagger.app/v1beta1
kind: MetricTemplate
metadata:
  name: error-rate
  namespace: flux-system
spec:
  provider:
    type: prometheus
    address: http://prometheus.monitoring:9090
  query: |
    sum(
      rate(
        app_errors_total{
          namespace="{{ namespace }}",
          deployment=~"{{ target }}"
        }[{{ interval }}]
      )
    )
```

### Advanced Canary with Session Affinity

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: myapp-sticky
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp

  service:
    port: 9898
    # Session affinity configuration
    sessionAffinity:
      cookieName: myapp-session
      maxAge: 86400
    # Gateway references for Istio
    gateways:
    - public-gateway.istio-system
    - private-gateway.istio-system
    hosts:
    - myapp.example.com
    - myapp.internal.example.com
    # Traffic policy
    trafficPolicy:
      tls:
        mode: ISTIO_MUTUAL
      connectionPool:
        http:
          http1MaxPendingRequests: 1024
          http2MaxRequests: 1024
          maxRequestsPerConnection: 100
      outlierDetection:
        consecutiveErrors: 5
        interval: 30s
        baseEjectionTime: 30s
        maxEjectionPercent: 50

  analysis:
    interval: 1m
    threshold: 10
    maxWeight: 50
    stepWeight: 5

    # Canary match conditions
    match:
    # Header-based routing
    - headers:
        x-canary:
          exact: "true"
    # Cookie-based routing
    - headers:
        cookie:
          regex: "^(.*?;)?(canary=true)(;.*)?$"

    metrics:
    - name: request-success-rate
      thresholdRange:
        min: 99
      interval: 1m
    - name: request-duration
      thresholdRange:
        max: 500
      interval: 1m

    # Session-aware analysis
    sessionAffinity:
      cookieName: myapp-session
      maxAge: 86400
```

### A/B Testing Pattern

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: myapp-ab-test
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp

  service:
    port: 9898
    gateways:
    - public-gateway.istio-system
    hosts:
    - myapp.example.com

  analysis:
    # A/B testing configuration
    interval: 1m
    threshold: 10
    iterations: 100
    match:
    # Route users with specific header to version B
    - headers:
        x-version:
          exact: "b"
      # Route 50% of matching traffic
      percentage: 50

    metrics:
    # Business metrics for A/B testing
    - name: conversion-rate
      templateRef:
        name: conversion-rate
      thresholdRange:
        min: 5.0
      interval: 1m

    - name: average-order-value
      templateRef:
        name: average-order-value
      thresholdRange:
        min: 100.0
      interval: 5m

    - name: user-engagement
      templateRef:
        name: user-engagement
      thresholdRange:
        min: 0.8
      interval: 1m

    webhooks:
    # Statistical significance test
    - name: ab-test-analysis
      url: http://ab-test-service.flux-system/analyze
      timeout: 30s
      metadata:
        minSampleSize: "1000"
        confidenceLevel: "0.95"
---
apiVersion: flagger.app/v1beta1
kind: MetricTemplate
metadata:
  name: conversion-rate
  namespace: flux-system
spec:
  provider:
    type: prometheus
    address: http://prometheus.monitoring:9090
  query: |
    sum(
      rate(
        app_conversions_total{
          namespace="{{ namespace }}",
          deployment=~"{{ target }}"
        }[{{ interval }}]
      )
    )
    /
    sum(
      rate(
        app_sessions_total{
          namespace="{{ namespace }}",
          deployment=~"{{ target }}"
        }[{{ interval }}]
      )
    )
    * 100
```

## Blue-Green Deployment Pattern

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: myapp-bluegreen
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp

  service:
    port: 9898
    gateways:
    - public-gateway.istio-system
    hosts:
    - myapp.example.com

  analysis:
    # Blue-green uses iterations instead of progressive traffic shifting
    interval: 1m
    threshold: 5
    # Number of iterations with green version before promotion
    iterations: 10

    # Mirror traffic to green for analysis
    mirror: true
    mirrorWeight: 100

    metrics:
    - name: request-success-rate
      thresholdRange:
        min: 99
      interval: 1m
    - name: request-duration
      thresholdRange:
        max: 500
      interval: 1m

    webhooks:
    # Pre-rollout validation
    - name: pre-rollout-tests
      type: pre-rollout
      url: http://flagger-loadtester.flux-system/
      metadata:
        type: bash
        cmd: "./test/validate-green.sh"

    # Load testing during mirroring
    - name: load-test
      url: http://flagger-loadtester.flux-system/
      timeout: 5s
      metadata:
        cmd: "hey -z 2m -q 10 -c 2 http://myapp-canary.production:9898/"

    # Manual approval before cutover
    - name: manual-approval
      type: confirm-promotion
      url: http://approval-service.flux-system/approve
      metadata:
        deployment: "myapp"
        environment: "production"
```

## Automated Rollback Strategies

### Health Check-Based Rollback

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: myapp-healthcheck
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp

  service:
    port: 9898

  analysis:
    interval: 30s
    threshold: 3
    maxWeight: 50
    stepWeight: 10

    metrics:
    # Built-in Kubernetes health checks
    - name: kubernetes-health
      templateRef:
        name: kubernetes-health
      thresholdRange:
        min: 100
      interval: 30s

    # Custom health endpoint
    - name: app-health
      templateRef:
        name: app-health
      thresholdRange:
        min: 100
      interval: 30s

    # Database connectivity
    - name: database-health
      templateRef:
        name: database-health
      thresholdRange:
        min: 100
      interval: 30s

    webhooks:
    # Immediate rollback on critical errors
    - name: critical-error-check
      url: http://flagger-loadtester.flux-system/
      timeout: 5s
      metadata:
        type: bash
        cmd: |
          #!/bin/bash
          ERRORS=$(curl -s http://myapp-canary.production:9898/metrics | \
            grep critical_errors_total | \
            awk '{print $2}')
          if [ "$ERRORS" -gt "0" ]; then
            exit 1
          fi
---
apiVersion: flagger.app/v1beta1
kind: MetricTemplate
metadata:
  name: kubernetes-health
  namespace: flux-system
spec:
  provider:
    type: prometheus
    address: http://prometheus.monitoring:9090
  query: |
    sum(
      up{
        namespace="{{ namespace }}",
        pod=~"{{ target }}-[a-z0-9]+-[a-z0-9]+"
      }
    )
    /
    count(
      up{
        namespace="{{ namespace }}",
        pod=~"{{ target }}-[a-z0-9]+-[a-z0-9]+"
      }
    )
    * 100
---
apiVersion: flagger.app/v1beta1
kind: MetricTemplate
metadata:
  name: app-health
  namespace: flux-system
spec:
  provider:
    type: prometheus
    address: http://prometheus.monitoring:9090
  query: |
    sum(
      probe_success{
        namespace="{{ namespace }}",
        deployment="{{ target }}"
      }
    )
    /
    count(
      probe_success{
        namespace="{{ namespace }}",
        deployment="{{ target }}"
      }
    )
    * 100
```

### Automatic Rollback on SLO Violation

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: myapp-slo
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp

  service:
    port: 9898

  analysis:
    interval: 1m
    threshold: 5
    maxWeight: 50
    stepWeight: 10

    # SLO-based metrics
    metrics:
    # Availability SLO (99.9%)
    - name: availability
      templateRef:
        name: availability-slo
      thresholdRange:
        min: 99.9
      interval: 1m

    # Latency SLO (P95 < 200ms)
    - name: latency-p95
      templateRef:
        name: latency-p95-slo
      thresholdRange:
        max: 200
      interval: 1m

    # Error budget depletion rate
    - name: error-budget
      templateRef:
        name: error-budget
      thresholdRange:
        min: 0.1
      interval: 5m

    webhooks:
    # SLO violation alert
    - name: slo-violation-alert
      type: rollback
      url: http://notification-service.flux-system/alert
      metadata:
        severity: "critical"
        message: "SLO violation detected during canary deployment"
---
apiVersion: flagger.app/v1beta1
kind: MetricTemplate
metadata:
  name: availability-slo
  namespace: flux-system
spec:
  provider:
    type: prometheus
    address: http://prometheus.monitoring:9090
  query: |
    (
      sum(rate(http_requests_total{namespace="{{ namespace }}",deployment=~"{{ target }}",status!~"5.."}[{{ interval }}]))
      /
      sum(rate(http_requests_total{namespace="{{ namespace }}",deployment=~"{{ target }}"}[{{ interval }}]))
    ) * 100
---
apiVersion: flagger.app/v1beta1
kind: MetricTemplate
metadata:
  name: latency-p95-slo
  namespace: flux-system
spec:
  provider:
    type: prometheus
    address: http://prometheus.monitoring:9090
  query: |
    histogram_quantile(0.95,
      sum(rate(http_request_duration_seconds_bucket{
        namespace="{{ namespace }}",
        deployment=~"{{ target }}"
      }[{{ interval }}])) by (le)
    ) * 1000
---
apiVersion: flagger.app/v1beta1
kind: MetricTemplate
metadata:
  name: error-budget
  namespace: flux-system
spec:
  provider:
    type: prometheus
    address: http://prometheus.monitoring:9090
  query: |
    (
      1 - (
        sum(rate(http_requests_total{namespace="{{ namespace }}",deployment=~"{{ target }}",status=~"5.."}[30d]))
        /
        sum(rate(http_requests_total{namespace="{{ namespace }}",deployment=~"{{ target }}"}[30d]))
      )
    ) * 100
```

## Multi-Cluster Progressive Delivery

### Cluster Sequencing Strategy

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: app-dev
  namespace: flux-system
spec:
  interval: 5m
  path: ./apps/myapp/overlays/dev
  prune: true
  sourceRef:
    kind: GitRepository
    name: production-apps
  healthChecks:
  - apiVersion: apps/v1
    kind: Deployment
    name: myapp
    namespace: myapp-dev
  timeout: 5m
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: app-staging
  namespace: flux-system
spec:
  # Deploy to staging only after dev succeeds
  dependsOn:
  - name: app-dev
  interval: 10m
  path: ./apps/myapp/overlays/staging
  prune: true
  sourceRef:
    kind: GitRepository
    name: production-apps
  healthChecks:
  - apiVersion: apps/v1
    kind: Deployment
    name: myapp
    namespace: myapp-staging
  # Additional validation for staging
  postBuild:
    substitute:
      CLUSTER_NAME: "staging"
    substituteFrom:
    - kind: ConfigMap
      name: staging-config
  timeout: 10m
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: app-prod-canary
  namespace: flux-system
spec:
  # Deploy to production only after staging succeeds
  dependsOn:
  - name: app-staging
  interval: 15m
  path: ./apps/myapp/overlays/production
  prune: true
  sourceRef:
    kind: GitRepository
    name: production-apps
  # Use canary deployment in production
  patches:
  - patch: |
      apiVersion: flagger.app/v1beta1
      kind: Canary
      metadata:
        name: myapp
      spec:
        analysis:
          interval: 1m
          threshold: 10
          maxWeight: 50
          stepWeight: 5
    target:
      kind: Canary
      name: myapp
  healthChecks:
  - apiVersion: flagger.app/v1beta1
    kind: Canary
    name: myapp
    namespace: production
  timeout: 30m
```

### Multi-Region Rollout

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: rollout-regions
  namespace: flux-system
data:
  regions.yaml: |
    regions:
    - name: us-east-1
      priority: 1
      canary:
        maxWeight: 25
        stepWeight: 5
    - name: us-west-2
      priority: 2
      canary:
        maxWeight: 50
        stepWeight: 10
    - name: eu-west-1
      priority: 3
      canary:
        maxWeight: 50
        stepWeight: 10
    - name: ap-southeast-1
      priority: 4
      canary:
        maxWeight: 100
        stepWeight: 20
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: app-us-east-1
  namespace: flux-system
spec:
  interval: 10m
  path: ./apps/myapp/overlays/us-east-1
  sourceRef:
    kind: GitRepository
    name: production-apps
  kubeConfig:
    secretRef:
      name: us-east-1-kubeconfig
  healthChecks:
  - apiVersion: flagger.app/v1beta1
    kind: Canary
    name: myapp
    namespace: production
  timeout: 30m
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: app-us-west-2
  namespace: flux-system
spec:
  # Deploy to us-west-2 after us-east-1
  dependsOn:
  - name: app-us-east-1
  interval: 10m
  path: ./apps/myapp/overlays/us-west-2
  sourceRef:
    kind: GitRepository
    name: production-apps
  kubeConfig:
    secretRef:
      name: us-west-2-kubeconfig
  timeout: 30m
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: app-eu-west-1
  namespace: flux-system
spec:
  # Deploy to eu-west-1 after us-west-2
  dependsOn:
  - name: app-us-west-2
  interval: 10m
  path: ./apps/myapp/overlays/eu-west-1
  sourceRef:
    kind: GitRepository
    name: production-apps
  kubeConfig:
    secretRef:
      name: eu-west-1-kubeconfig
  timeout: 30m
```

## Notification and Alerting

### Comprehensive Alert Configuration

```yaml
apiVersion: notification.toolkit.fluxcd.io/v1beta2
kind: Provider
metadata:
  name: slack
  namespace: flux-system
spec:
  type: slack
  channel: deployments
  username: Flux
  secretRef:
    name: slack-webhook
---
apiVersion: notification.toolkit.fluxcd.io/v1beta2
kind: Provider
metadata:
  name: pagerduty
  namespace: flux-system
spec:
  type: generic
  address: https://events.pagerduty.com/v2/enqueue
  secretRef:
    name: pagerduty-token
---
apiVersion: notification.toolkit.fluxcd.io/v1beta2
kind: Alert
metadata:
  name: canary-alerts
  namespace: flux-system
spec:
  providerRef:
    name: slack
  eventSeverity: info
  eventSources:
  - kind: Canary
    name: '*'
    namespace: production
  exclusionList:
  - ".*health check passed.*"
---
apiVersion: notification.toolkit.fluxcd.io/v1beta2
kind: Alert
metadata:
  name: critical-alerts
  namespace: flux-system
spec:
  providerRef:
    name: pagerduty
  eventSeverity: error
  eventSources:
  - kind: Canary
    name: '*'
    namespace: production
  inclusionList:
  - ".*rollback.*"
  - ".*failed.*"
---
apiVersion: v1
kind: Secret
metadata:
  name: slack-webhook
  namespace: flux-system
type: Opaque
stringData:
  address: https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK
---
apiVersion: v1
kind: Secret
metadata:
  name: pagerduty-token
  namespace: flux-system
type: Opaque
stringData:
  token: <pagerduty-integration-key>
```

## Monitoring and Observability

### Flagger Metrics Dashboard

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: flagger-dashboard
  namespace: flux-system
data:
  dashboard.json: |
    {
      "dashboard": {
        "title": "Flagger Progressive Delivery",
        "panels": [
          {
            "title": "Canary Status",
            "targets": [
              {
                "expr": "flagger_canary_status"
              }
            ]
          },
          {
            "title": "Canary Weight",
            "targets": [
              {
                "expr": "flagger_canary_weight"
              }
            ]
          },
          {
            "title": "Canary Duration",
            "targets": [
              {
                "expr": "flagger_canary_duration_seconds"
              }
            ]
          },
          {
            "title": "Success Rate Comparison",
            "targets": [
              {
                "expr": "sum(rate(http_requests_total{deployment=\"myapp-primary\",status!~\"5..\"}[1m])) / sum(rate(http_requests_total{deployment=\"myapp-primary\"}[1m])) * 100",
                "legendFormat": "Primary"
              },
              {
                "expr": "sum(rate(http_requests_total{deployment=\"myapp-canary\",status!~\"5..\"}[1m])) / sum(rate(http_requests_total{deployment=\"myapp-canary\"}[1m])) * 100",
                "legendFormat": "Canary"
              }
            ]
          },
          {
            "title": "Latency Comparison (P95)",
            "targets": [
              {
                "expr": "histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{deployment=\"myapp-primary\"}[1m])) by (le)) * 1000",
                "legendFormat": "Primary"
              },
              {
                "expr": "histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{deployment=\"myapp-canary\"}[1m])) by (le)) * 1000",
                "legendFormat": "Canary"
              }
            ]
          }
        ]
      }
    }
```

## Best Practices

### Deployment Strategy Selection

1. **Canary Deployments**: Gradual traffic shifting for most production workloads
2. **Blue-Green**: Instant cutover for services requiring all-or-nothing deployment
3. **A/B Testing**: Feature validation with specific user segments
4. **Progressive Rollout**: Multi-cluster deployment with staged regional rollout

### Performance Optimization

1. **Metric Queries**: Optimize Prometheus queries for fast analysis
2. **Analysis Intervals**: Balance safety with deployment speed
3. **Webhook Timeouts**: Set appropriate timeouts for validation webhooks
4. **Resource Limits**: Right-size Flux and Flagger controller resources

### Operational Excellence

1. **Monitoring**: Comprehensive dashboards for canary progress
2. **Alerting**: Multi-channel notifications for deployment events
3. **Testing**: Automated smoke and integration tests
4. **Documentation**: Document rollout strategies and rollback procedures
5. **Disaster Recovery**: Plan for GitOps infrastructure failure

## Conclusion

Flux v2 with Flagger provides enterprise-grade progressive delivery capabilities that significantly reduce deployment risk while maintaining deployment velocity. By implementing canary deployments, blue-green strategies, automated rollbacks, and multi-cluster orchestration, organizations can achieve safe, automated production deployments.

Key takeaways:
- Use canary deployments with automated analysis for gradual rollouts
- Implement comprehensive metrics and health checks for early issue detection
- Leverage blue-green deployments for instant cutover requirements
- Configure automated rollbacks based on SLO violations
- Orchestrate multi-cluster deployments with dependency management
- Monitor deployment progress with detailed metrics and alerts

With proper implementation of these patterns, teams can deploy confidently to production multiple times per day while maintaining high availability and reliability standards.