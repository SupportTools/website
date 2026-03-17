---
title: "Kubernetes GitOps: ArgoCD ApplicationSet Controller and Progressive Delivery"
date: 2029-12-14T00:00:00-05:00
draft: false
tags: ["Kubernetes", "GitOps", "ArgoCD", "ApplicationSet", "Progressive Delivery", "Argo Rollouts", "Multi-environment"]
categories:
- Kubernetes
- GitOps
- Deployment
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide covering ArgoCD ApplicationSet generators (cluster, git, matrix, merge), rollout strategies, Argo Rollouts integration, and multi-environment progressive delivery for production GitOps platforms."
more_link: "yes"
url: "/kubernetes-gitops-argocd-applicationset-progressive-delivery/"
---

Managing ArgoCD Applications at scale — dozens of microservices across five environments on fifteen clusters — requires more than manually creating Application objects. The ApplicationSet controller automates Application generation from templates, eliminating the toil of maintaining hundreds of nearly-identical Application definitions. Combined with Argo Rollouts for progressive delivery, you get a GitOps platform that can deploy to multiple clusters simultaneously with automatic canary promotion, metric-based rollback, and full audit trails. This guide covers the complete enterprise ApplicationSet and progressive delivery architecture.

<!--more-->

## ApplicationSet Architecture

The ApplicationSet controller runs alongside ArgoCD and watches `ApplicationSet` objects. Each ApplicationSet generates one or more ArgoCD `Application` objects using a template and a set of generators that produce the variable substitutions for the template.

```
ApplicationSet
     │
     ├── Generator 1 (e.g., cluster generator)
     │    └── Produces: [{cluster: "prod-us"}, {cluster: "prod-eu"}, ...]
     │
     └── Template
          └── One Application per generator output
```

## Core Generators

### Cluster Generator

The cluster generator iterates over all clusters registered with ArgoCD:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: nginx-ingress
  namespace: argocd
spec:
  generators:
  - clusters:
      selector:
        matchLabels:
          environment: production
          region: us-east-1
      # Values injected from cluster Secret annotations
      values:
        revision: HEAD
  template:
    metadata:
      name: "{{name}}-nginx-ingress"
      annotations:
        notifications.argoproj.io/subscribe.on-sync-succeeded.slack: deployments
    spec:
      project: infrastructure
      source:
        repoURL: https://github.com/myorg/infra-charts.git
        targetRevision: "{{values.revision}}"
        path: charts/nginx-ingress
        helm:
          valueFiles:
          - "../../environments/{{metadata.labels.environment}}/nginx-ingress.yaml"
      destination:
        server: "{{server}}"
        namespace: ingress-nginx
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
        - CreateNamespace=true
        - ServerSideApply=true
        retry:
          limit: 3
          backoff:
            duration: 5s
            factor: 2
            maxDuration: 3m
```

### Git Generator

The git generator iterates over directories or files in a git repository, enabling dynamic application discovery:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: microservices-autopilot
  namespace: argocd
spec:
  generators:
  - git:
      repoURL: https://github.com/myorg/services.git
      revision: HEAD
      # One application per directory that contains an app-config.yaml
      directories:
      - path: "services/*/deploy"
      # Exclude infra directories
      - path: "services/legacy/*"
        exclude: true
  template:
    metadata:
      name: "{{path.basename}}"
    spec:
      project: microservices
      source:
        repoURL: https://github.com/myorg/services.git
        targetRevision: HEAD
        path: "{{path}}"
      destination:
        server: https://kubernetes.default.svc
        namespace: "{{path.basename}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

#### Git Generator with Config Files

```yaml
# services/payment-service/deploy/app-config.yaml
# This file drives the ApplicationSet template
appName: payment-service
namespace: payment
minReplicas: "3"
maxReplicas: "20"
helmChart: microservice-chart
helmChartVersion: "2.1.0"
alertRecipients: "payment-team"
```

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: services-from-config
  namespace: argocd
spec:
  generators:
  - git:
      repoURL: https://github.com/myorg/services.git
      revision: HEAD
      files:
      - path: "services/*/deploy/app-config.yaml"
  template:
    metadata:
      name: "{{appName}}"
      annotations:
        argocd.argoproj.io/manifest-generate-paths: "{{path}}"
    spec:
      project: microservices
      source:
        repoURL: https://github.com/myorg/helm-charts.git
        targetRevision: HEAD
        chart: "{{helmChart}}"
        helm:
          releaseName: "{{appName}}"
          parameters:
          - name: replicaCount.min
            value: "{{minReplicas}}"
          - name: replicaCount.max
            value: "{{maxReplicas}}"
          - name: image.tag
            value: latest
      destination:
        server: https://kubernetes.default.svc
        namespace: "{{namespace}}"
```

### Matrix Generator

The matrix generator computes the Cartesian product of two generators, enabling "every service × every cluster" deployments:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: services-all-clusters
  namespace: argocd
spec:
  generators:
  - matrix:
      generators:
      # First generator: all production clusters
      - clusters:
          selector:
            matchLabels:
              tier: production
      # Second generator: all service configs
      - git:
          repoURL: https://github.com/myorg/services.git
          revision: HEAD
          files:
          - path: "services/*/config.yaml"
  template:
    metadata:
      name: "{{appName}}-{{name}}"  # service-name + cluster-name
    spec:
      project: production
      source:
        repoURL: https://github.com/myorg/services.git
        targetRevision: HEAD
        path: "{{path}}"
        helm:
          valueFiles:
          - "values/{{metadata.labels.region}}.yaml"
      destination:
        server: "{{server}}"
        namespace: "{{appName}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

### Merge Generator

The merge generator combines output from multiple generators, allowing base defaults to be overridden by per-cluster or per-environment values:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: service-with-overrides
  namespace: argocd
spec:
  generators:
  - merge:
      mergeKeys:
      - clusterName  # Key used to match and merge records
      generators:
      # Base: all clusters with defaults
      - clusters:
          selector:
            matchLabels:
              managed: "true"
          values:
            replicaCount: "2"
            resourceTier: standard
            enableDebug: "false"
      # Overrides for production clusters
      - list:
          elements:
          - clusterName: prod-us-east
            replicaCount: "10"
            resourceTier: premium
          - clusterName: prod-eu-west
            replicaCount: "8"
            resourceTier: premium
  template:
    metadata:
      name: "myapp-{{clusterName}}"
    spec:
      source:
        helm:
          parameters:
          - name: replicaCount
            value: "{{values.replicaCount}}"
          - name: resources.tier
            value: "{{values.resourceTier}}"
```

## Progressive Delivery with Argo Rollouts

Argo Rollouts extends Kubernetes Deployments with canary and blue-green deployment strategies, integrated with analysis providers (Prometheus, Datadog, CloudWatch) for automated promotion and rollback.

### Canary Rollout

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: payment-service
  namespace: payment
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
        image: myregistry.io/payment-service:1.2.3
        ports:
        - containerPort: 8080
        resources:
          requests:
            cpu: "500m"
            memory: "512Mi"
          limits:
            cpu: "2"
            memory: "2Gi"
  strategy:
    canary:
      # Traffic management via Nginx ingress
      trafficRouting:
        nginx:
          stableIngress: payment-service-stable
          annotationPrefix: nginx.ingress.kubernetes.io
          additionalIngressAnnotations:
            canary-by-header: "X-Canary"
      steps:
      # Step 1: 5% traffic for 2 minutes, then analyze
      - setWeight: 5
      - pause:
          duration: 2m
      - analysis:
          templates:
          - templateName: error-rate-analysis
          - templateName: latency-analysis
      # Step 2: 25% traffic for 5 minutes
      - setWeight: 25
      - pause:
          duration: 5m
      - analysis:
          templates:
          - templateName: error-rate-analysis
      # Step 3: 50% traffic for 5 minutes
      - setWeight: 50
      - pause:
          duration: 5m
      # Step 4: full rollout
      - setWeight: 100
      canaryService: payment-service-canary
      stableService: payment-service-stable
      maxSurge: "20%"
      maxUnavailable: 0
```

### AnalysisTemplate: Automated Rollback on Bad Metrics

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: error-rate-analysis
  namespace: payment
spec:
  args:
  - name: service-name
  - name: namespace
    value: payment
  metrics:
  - name: error-rate
    interval: 1m
    count: 3
    successCondition: result[0] < 0.05  # Less than 5% error rate
    failureLimit: 1
    provider:
      prometheus:
        address: http://prometheus.monitoring.svc.cluster.local:9090
        query: |
          sum(rate(http_requests_total{
            service="{{args.service-name}}",
            namespace="{{args.namespace}}",
            status=~"5.."
          }[2m]))
          /
          sum(rate(http_requests_total{
            service="{{args.service-name}}",
            namespace="{{args.namespace}}"
          }[2m]))

  - name: p99-latency
    interval: 1m
    count: 3
    successCondition: result[0] < 500  # Less than 500ms p99
    failureLimit: 1
    provider:
      prometheus:
        address: http://prometheus.monitoring.svc.cluster.local:9090
        query: |
          histogram_quantile(0.99,
            sum(rate(http_request_duration_seconds_bucket{
              service="{{args.service-name}}",
              namespace="{{args.namespace}}"
            }[2m])) by (le)
          ) * 1000
```

### Blue-Green Rollout

```yaml
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
        image: myregistry.io/api-gateway:2.0.0
  strategy:
    blueGreen:
      activeService: api-gateway-active
      previewService: api-gateway-preview
      # Automatically promote after 10 minutes if healthy
      autoPromotionEnabled: true
      autoPromotionSeconds: 600
      # Keep old (blue) ReplicaSet alive for 5 minutes post-switch
      scaleDownDelaySeconds: 300
      prePromotionAnalysis:
        templates:
        - templateName: smoke-test
        args:
        - name: service-url
          value: "http://api-gateway-preview.production.svc.cluster.local"
      postPromotionAnalysis:
        templates:
        - templateName: error-rate-analysis
        args:
        - name: service-name
          value: api-gateway
```

## ApplicationSet + Rollouts: The Full Pipeline

Connecting ApplicationSet-generated apps with Rollouts enables a fully automated progressive delivery pipeline:

```yaml
# ApplicationSet generates apps per cluster
# Each app points to a Helm chart that contains the Rollout object

# ArgoCD Application generated by ApplicationSet:
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: payment-service-prod-us
  namespace: argocd
  # Image Updater annotation: auto-update when new image is pushed
  annotations:
    argocd-image-updater.argoproj.io/image-list: "payment=myregistry.io/payment-service"
    argocd-image-updater.argoproj.io/payment.update-strategy: semver
    argocd-image-updater.argoproj.io/payment.allow-tags: "regexp:^[0-9]+\\.[0-9]+\\.[0-9]+$"
    argocd-image-updater.argoproj.io/write-back-method: git
    argocd-image-updater.argoproj.io/git-branch: main
spec:
  project: production
  source:
    repoURL: https://github.com/myorg/services.git
    targetRevision: HEAD
    path: services/payment-service/deploy
    helm:
      valueFiles:
      - values-prod-us.yaml
  destination:
    server: https://prod-us.k8s.example.com
    namespace: payment
  syncPolicy:
    automated:
      prune: false  # Don't auto-prune — Rollouts manages replica sets
      selfHeal: true
    syncOptions:
    - RespectIgnoreDifferences=true
  ignoreDifferences:
  # Ignore fields managed by Argo Rollouts controller
  - group: argoproj.io
    kind: Rollout
    jsonPointers:
    - /spec/replicas
    - /status
```

## Multi-Environment Promotion Pattern

```yaml
# environment-promotion-appset.yaml
# Promotes from dev -> staging -> production in sequence

apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: payment-service-environments
  namespace: argocd
spec:
  generators:
  - list:
      elements:
      - env: dev
        cluster: https://dev.k8s.example.com
        imageTag: latest
        syncWave: "0"
        autoSync: "true"
      - env: staging
        cluster: https://staging.k8s.example.com
        imageTag: "{{appVersion}}"
        syncWave: "10"
        autoSync: "true"
      - env: production
        cluster: https://prod.k8s.example.com
        imageTag: "{{appVersion}}"
        syncWave: "20"
        autoSync: "false"  # Production requires manual sync
  template:
    metadata:
      name: "payment-service-{{env}}"
      annotations:
        argocd.argoproj.io/sync-wave: "{{syncWave}}"
    spec:
      project: payment
      source:
        repoURL: https://github.com/myorg/services.git
        targetRevision: HEAD
        path: services/payment-service
        helm:
          valueFiles:
          - "values/{{env}}.yaml"
          parameters:
          - name: image.tag
            value: "{{imageTag}}"
      destination:
        server: "{{cluster}}"
        namespace: payment
      syncPolicy:
        automated:
          prune: true
          selfHeal: "{{autoSync}}" == "true"
```

## Operational Monitoring

Monitor the ApplicationSet and Rollouts health via Prometheus:

```yaml
# PrometheusRule for ArgoCD health
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: argocd-applicationset-alerts
  namespace: monitoring
spec:
  groups:
  - name: argocd-applicationset
    interval: 30s
    rules:
    - alert: ArgoCDApplicationOutOfSync
      expr: |
        argocd_app_info{sync_status="OutOfSync"} > 0
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "ArgoCD application {{ $labels.name }} is out of sync"
        description: "{{ $labels.name }} in project {{ $labels.project }} has been OutOfSync for 10 minutes"

    - alert: ArgoCDRolloutDegraded
      expr: |
        rollout_info{phase!="Healthy"} > 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Argo Rollout {{ $labels.rollout }} is degraded"
        description: "Rollout {{ $labels.rollout }} in namespace {{ $labels.namespace }} has phase {{ $labels.phase }}"

    - alert: ArgoCDApplicationSyncFailed
      expr: |
        argocd_app_info{health_status="Degraded"} > 0
      for: 5m
      labels:
        severity: critical
```

The ApplicationSet controller eliminates the most painful GitOps anti-pattern: manually duplicating Application objects for each environment or cluster. With matrix generators, a single ApplicationSet definition manages the complete cross-product of services × environments × clusters, and the progressive delivery integration with Argo Rollouts ensures that each generated application deploys safely with automated analysis and rollback. The result is a GitOps platform that scales to enterprise complexity without sacrificing the safety guarantees that make GitOps worth adopting in the first place.
