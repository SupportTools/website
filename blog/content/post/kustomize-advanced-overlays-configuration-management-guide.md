---
title: "Kustomize Advanced Overlays: Production Kubernetes Configuration Management Guide"
date: 2026-09-13T00:00:00-05:00
draft: false
tags: ["Kustomize", "Kubernetes", "GitOps", "Configuration Management", "DevOps", "IaC"]
categories: ["Kubernetes", "DevOps", "GitOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Master advanced Kustomize overlay patterns, component architecture, strategic merge patches, and production-ready configuration management for enterprise Kubernetes deployments."
more_link: "yes"
url: "/kustomize-advanced-overlays-configuration-management-guide/"
---

Learn advanced Kustomize techniques including sophisticated overlay strategies, component composition, strategic merge patches, generator plugins, and production-ready patterns for managing complex Kubernetes configurations at scale.

<!--more-->

# Kustomize Advanced Overlays: Production Kubernetes Configuration Management Guide

## Executive Summary

Kustomize provides a template-free way to customize Kubernetes configurations through declarative overlays and patches. This comprehensive guide covers advanced Kustomize patterns including multi-environment overlays, component architecture, strategic merge patches, and production-ready configuration management strategies for enterprise Kubernetes deployments.

## Table of Contents

1. [Kustomize Fundamentals](#fundamentals)
2. [Advanced Overlay Patterns](#overlay-patterns)
3. [Component Architecture](#component-architecture)
4. [Strategic Merge Patches](#strategic-merge)
5. [JSON Patches and Transformers](#json-patches)
6. [Generator Plugins](#generators)
7. [Multi-Environment Management](#multi-environment)
8. [Security and Secrets](#security-secrets)
9. [GitOps Integration](#gitops-integration)
10. [Testing and Validation](#testing-validation)

## Kustomize Fundamentals {#fundamentals}

### Core Concepts

```yaml
# Directory structure overview
kustomize-project/
├── base/                          # Base configurations
│   ├── kustomization.yaml        # Base kustomization
│   ├── deployment.yaml           # Base deployment
│   ├── service.yaml              # Base service
│   └── configmap.yaml            # Base config
│
├── components/                    # Reusable components
│   ├── monitoring/               # Monitoring component
│   │   ├── kustomization.yaml
│   │   └── servicemonitor.yaml
│   └── security/                 # Security component
│       ├── kustomization.yaml
│       └── networkpolicy.yaml
│
└── overlays/                      # Environment overlays
    ├── development/
    │   ├── kustomization.yaml
    │   └── patches/
    ├── staging/
    │   ├── kustomization.yaml
    │   └── patches/
    └── production/
        ├── kustomization.yaml
        └── patches/
```

### Basic Kustomization File

```yaml
# base/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

metadata:
  name: myapp-base

# Resources
resources:
- deployment.yaml
- service.yaml
- configmap.yaml

# Common labels
commonLabels:
  app: myapp
  managed-by: kustomize

# Common annotations
commonAnnotations:
  description: "Base configuration for myapp"
  documentation: "https://wiki.example.com/myapp"

# Name prefix/suffix
namePrefix: myapp-
nameSuffix: -v1

# Namespace
namespace: default

# Images
images:
- name: myapp
  newName: gcr.io/my-project/myapp
  newTag: latest

# ConfigMap generator
configMapGenerator:
- name: app-config
  literals:
  - LOG_LEVEL=info
  - FEATURE_FLAG_A=false

# Secret generator
secretGenerator:
- name: app-secrets
  literals:
  - DB_PASSWORD=changeme
  type: Opaque

# Replicas
replicas:
- name: myapp-deployment
  count: 3
```

## Advanced Overlay Patterns {#overlay-patterns}

### Hierarchical Overlay Structure

```yaml
# Production overlay with multiple layers
overlays/
└── production/
    ├── kustomization.yaml              # Main overlay
    ├── patches/
    │   ├── deployment-patch.yaml       # Deployment modifications
    │   ├── hpa-patch.yaml              # HPA settings
    │   └── resources-patch.yaml        # Resource adjustments
    ├── configs/
    │   ├── app-config.properties       # Application config
    │   └── logging-config.yaml         # Logging config
    ├── us-east-1/                      # Region-specific
    │   ├── kustomization.yaml
    │   └── patches/
    │       └── region-patch.yaml
    ├── us-west-2/
    │   ├── kustomization.yaml
    │   └── patches/
    │       └── region-patch.yaml
    └── eu-west-1/
        ├── kustomization.yaml
        └── patches/
            └── region-patch.yaml
```

### Multi-Layer Overlay

```yaml
# overlays/production/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

# Reference base
bases:
- ../../base

# Include components
components:
- ../../components/monitoring
- ../../components/security
- ../../components/istio-ingress

# Production namespace
namespace: production

# Common labels for production
commonLabels:
  environment: production
  tier: frontend
  cost-center: engineering

# Production-specific annotations
commonAnnotations:
  deployed-by: "GitOps Pipeline"
  contacts: "sre-team@example.com"

# Image overrides
images:
- name: myapp
  newName: gcr.io/my-project/myapp
  newTag: v2.3.4

# Replica count
replicas:
- name: myapp-deployment
  count: 10

# Resource patches
patches:
- path: patches/deployment-patch.yaml
  target:
    kind: Deployment
    name: myapp-deployment

- path: patches/hpa-patch.yaml
  target:
    kind: HorizontalPodAutoscaler

# ConfigMap from file
configMapGenerator:
- name: app-config
  files:
  - configs/app-config.properties
  behavior: merge

- name: logging-config
  files:
  - configs/logging-config.yaml
  behavior: replace

# Secrets from external source
secretGenerator:
- name: database-credentials
  literals:
  - username=produser
  envs:
  - .env.production

# Strategic merge patches
patchesStrategicMerge:
- patches/resources-patch.yaml

# JSON patches
patchesJson6902:
- target:
    version: v1
    kind: Service
    name: myapp-service
  path: patches/service-patch.json
```

### Regional Overlay Extension

```yaml
# overlays/production/us-east-1/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

# Reference production base
bases:
- ../

# Region-specific labels
commonLabels:
  region: us-east-1
  availability-zone: multi

# Region-specific annotations
commonAnnotations:
  aws-region: "us-east-1"
  backup-region: "us-west-2"

# Region-specific patches
patches:
- path: patches/region-patch.yaml
  target:
    kind: Deployment

- path: patches/storage-class-patch.yaml
  target:
    kind: PersistentVolumeClaim

# Region-specific config
configMapGenerator:
- name: region-config
  literals:
  - REGION=us-east-1
  - AVAILABILITY_ZONES=us-east-1a,us-east-1b,us-east-1c
  - S3_BUCKET=myapp-prod-us-east-1
  - DYNAMODB_TABLE=myapp-prod-us-east-1
```

## Component Architecture {#component-architecture}

### Monitoring Component

```yaml
# components/monitoring/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1alpha1
kind: Component

# Component resources
resources:
- servicemonitor.yaml
- prometheusrule.yaml
- grafana-dashboard.yaml

# Labels for monitoring
commonLabels:
  monitoring: enabled
  prometheus: scraped

# Annotations
commonAnnotations:
  monitoring-tier: "application"
```

```yaml
# components/monitoring/servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: app-metrics
spec:
  selector:
    matchLabels:
      app: myapp
  endpoints:
  - port: metrics
    interval: 30s
    path: /metrics
    scheme: http
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: app-alerts
spec:
  groups:
  - name: application
    interval: 30s
    rules:
    - alert: HighErrorRate
      expr: |
        sum(rate(http_requests_total{status=~"5.."}[5m]))
        /
        sum(rate(http_requests_total[5m]))
        > 0.05
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "High error rate detected"
        description: "Error rate is {{ $value | humanizePercentage }}"

    - alert: HighLatency
      expr: |
        histogram_quantile(0.95,
          sum(rate(http_request_duration_seconds_bucket[5m])) by (le)
        ) > 1
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "High latency detected"
        description: "P95 latency is {{ $value }}s"
```

### Security Component

```yaml
# components/security/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1alpha1
kind: Component

resources:
- networkpolicy.yaml
- podsecuritypolicy.yaml
- serviceaccount.yaml
- rbac.yaml

commonLabels:
  security: enabled

patches:
- path: security-context-patch.yaml
  target:
    kind: Deployment
```

```yaml
# components/security/networkpolicy.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: app-netpol
spec:
  podSelector:
    matchLabels:
      app: myapp
  policyTypes:
  - Ingress
  - Egress

  ingress:
  # Allow from ingress controller
  - from:
    - namespaceSelector:
        matchLabels:
          name: ingress-nginx
    ports:
    - protocol: TCP
      port: 8080

  # Allow from monitoring
  - from:
    - namespaceSelector:
        matchLabels:
          name: monitoring
    ports:
    - protocol: TCP
      port: 9090

  egress:
  # Allow DNS
  - to:
    - namespaceSelector:
        matchLabels:
          name: kube-system
    ports:
    - protocol: UDP
      port: 53

  # Allow external HTTPS
  - to:
    - namespaceSelector: {}
    ports:
    - protocol: TCP
      port: 443

  # Allow database
  - to:
    - namespaceSelector:
        matchLabels:
          name: database
    ports:
    - protocol: TCP
      port: 5432
---
apiVersion: policy/v1beta1
kind: PodSecurityPolicy
metadata:
  name: app-psp
spec:
  privileged: false
  allowPrivilegeEscalation: false
  requiredDropCapabilities:
  - ALL
  volumes:
  - 'configMap'
  - 'emptyDir'
  - 'projected'
  - 'secret'
  - 'downwardAPI'
  - 'persistentVolumeClaim'
  hostNetwork: false
  hostIPC: false
  hostPID: false
  runAsUser:
    rule: 'MustRunAsNonRoot'
  seLinux:
    rule: 'RunAsAny'
  fsGroup:
    rule: 'RunAsAny'
  readOnlyRootFilesystem: true
```

```yaml
# components/security/security-context-patch.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: not-important
spec:
  template:
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault

      containers:
      - name: myapp
        securityContext:
          allowPrivilegeEscalation: false
          runAsNonRoot: true
          runAsUser: 1000
          capabilities:
            drop:
            - ALL
          readOnlyRootFilesystem: true
```

## Strategic Merge Patches {#strategic-merge}

### Resource Modification Patch

```yaml
# overlays/production/patches/resources-patch.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp-deployment
spec:
  template:
    spec:
      containers:
      - name: myapp
        resources:
          requests:
            cpu: 1000m
            memory: 2Gi
            ephemeral-storage: 1Gi
          limits:
            cpu: 2000m
            memory: 4Gi
            ephemeral-storage: 2Gi

        env:
        # Add production environment variables
        - name: ENVIRONMENT
          value: production
        - name: LOG_LEVEL
          value: warn
        - name: ENABLE_PROFILING
          value: "true"

        # Liveness probe adjustments
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 60
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3

        # Readiness probe adjustments
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 3

      # Add init container
      initContainers:
      - name: migration
        image: gcr.io/my-project/myapp:v2.3.4
        command: ["/app/migrate"]
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: database-credentials
              key: url

      # Topology spread
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: myapp

      # Affinity rules
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: myapp
            topologyKey: kubernetes.io/hostname
```

### HPA Configuration Patch

```yaml
# overlays/production/patches/hpa-patch.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: myapp-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp-deployment

  minReplicas: 10
  maxReplicas: 100

  metrics:
  # CPU-based scaling
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70

  # Memory-based scaling
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80

  # Custom metrics
  - type: Pods
    pods:
      metric:
        name: http_requests_per_second
      target:
        type: AverageValue
        averageValue: "1000"

  - type: Pods
    pods:
      metric:
        name: queue_depth
      target:
        type: AverageValue
        averageValue: "100"

  # External metrics
  - type: External
    external:
      metric:
        name: pubsub_queue_length
        selector:
          matchLabels:
            queue: myapp-tasks
      target:
        type: AverageValue
        averageValue: "50"

  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 50
        periodSeconds: 60
      - type: Pods
        value: 5
        periodSeconds: 60
      selectPolicy: Min

    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
      - type: Percent
        value: 100
        periodSeconds: 30
      - type: Pods
        value: 10
        periodSeconds: 30
      selectPolicy: Max
```

## JSON Patches and Transformers {#json-patches}

### JSON6902 Patch

```yaml
# overlays/production/kustomization.yaml
patchesJson6902:
- target:
    version: v1
    kind: Service
    name: myapp-service
  path: patches/service-patch.json

- target:
    version: v1
    kind: ConfigMap
    name: app-config
  patch: |-
    - op: add
      path: /data/NEW_FEATURE
      value: "enabled"
    - op: replace
      path: /data/MAX_CONNECTIONS
      value: "1000"
    - op: remove
      path: /data/DEPRECATED_SETTING
```

```json
// patches/service-patch.json
[
  {
    "op": "add",
    "path": "/spec/ports/-",
    "value": {
      "name": "metrics",
      "port": 9090,
      "targetPort": 9090,
      "protocol": "TCP"
    }
  },
  {
    "op": "add",
    "path": "/metadata/annotations",
    "value": {
      "service.beta.kubernetes.io/aws-load-balancer-type": "nlb",
      "service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled": "true",
      "service.beta.kubernetes.io/aws-load-balancer-backend-protocol": "http"
    }
  },
  {
    "op": "replace",
    "path": "/spec/sessionAffinity",
    "value": "ClientIP"
  },
  {
    "op": "add",
    "path": "/spec/sessionAffinityConfig",
    "value": {
      "clientIP": {
        "timeoutSeconds": 10800
      }
    }
  }
]
```

### Custom Transformers

```yaml
# transformers/add-prometheus-annotations.yaml
apiVersion: builtin
kind: AnnotationsTransformer
metadata:
  name: add-prometheus-annotations
annotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "9090"
  prometheus.io/path: "/metrics"
fieldSpecs:
- path: spec/template/metadata/annotations
  kind: Deployment
- path: spec/template/metadata/annotations
  kind: StatefulSet
- path: spec/template/metadata/annotations
  kind: DaemonSet
```

```yaml
# transformers/add-common-env.yaml
apiVersion: builtin
kind: PatchTransformer
metadata:
  name: add-common-env
patch: |-
  - op: add
    path: /spec/template/spec/containers/0/env/-
    value:
      name: CLUSTER_NAME
      value: production-us-east-1
  - op: add
    path: /spec/template/spec/containers/0/env/-
    value:
      name: NAMESPACE
      valueFrom:
        fieldRef:
          fieldPath: metadata.namespace
target:
  kind: Deployment
```

```yaml
# Use transformers in kustomization
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

transformers:
- transformers/add-prometheus-annotations.yaml
- transformers/add-common-env.yaml
```

## Generator Plugins {#generators}

### ConfigMap from Multiple Sources

```yaml
# overlays/production/kustomization.yaml
configMapGenerator:
# From literals
- name: app-config
  literals:
  - ENVIRONMENT=production
  - LOG_LEVEL=warn
  - METRICS_ENABLED=true
  behavior: merge

# From files
- name: app-properties
  files:
  - configs/application.properties
  - configs/database.properties
  behavior: create

# From env file
- name: app-env
  envs:
  - configs/.env.production
  behavior: replace

# From command output (requires plugin)
- name: build-info
  literals:
  - BUILD_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  - GIT_COMMIT=$(git rev-parse HEAD)
  - GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

# Disable name suffix hash
  options:
    disableNameSuffixHash: false
    labels:
      config-type: application
    annotations:
      generated-by: kustomize
```

### Secret Generator with External Sources

```yaml
# Using sealed-secrets generator
# Install: kubectl apply -f https://github.com/bitnami-labs/sealed-secrets/releases/download/v0.18.0/controller.yaml

secretGenerator:
# Basic secret from literals
- name: api-keys
  literals:
  - API_KEY=secret-value
  type: Opaque

# Secret from files
- name: tls-cert
  files:
  - tls.crt=certs/server.crt
  - tls.key=certs/server.key
  type: kubernetes.io/tls

# Using external secrets operator
# Note: This requires External Secrets Operator installed
---
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: database-credentials
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secrets-manager
    kind: SecretStore

  target:
    name: database-credentials
    creationPolicy: Owner

  data:
  - secretKey: username
    remoteRef:
      key: prod/database
      property: username

  - secretKey: password
    remoteRef:
      key: prod/database
      property: password

  - secretKey: connection-string
    remoteRef:
      key: prod/database
      property: connection_string
```

### Custom Generator Plugin

```bash
#!/bin/bash
# generators/git-info-generator.sh - Custom generator plugin

cat <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: git-info
data:
  GIT_COMMIT: "$(git rev-parse HEAD)"
  GIT_SHORT_COMMIT: "$(git rev-parse --short HEAD)"
  GIT_BRANCH: "$(git rev-parse --abbrev-ref HEAD)"
  GIT_TAG: "$(git describe --tags --always)"
  BUILD_DATE: "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  BUILD_USER: "$(whoami)@$(hostname)"
EOF
```

```yaml
# Use custom generator
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

generators:
- generators/git-info-generator.sh
```

## Multi-Environment Management {#multi-environment}

### Environment Matrix

```bash
#!/bin/bash
# deploy-all-environments.sh - Deploy to multiple environments

set -euo pipefail

ENVIRONMENTS=(
  "development"
  "qa"
  "staging"
  "production/us-east-1"
  "production/us-west-2"
  "production/eu-west-1"
)

for env in "${ENVIRONMENTS[@]}"; do
  echo "Deploying to $env..."

  # Build with kustomize
  kubectl kustomize "overlays/$env" > "/tmp/manifests-${env//\//-}.yaml"

  # Validate
  kubeval --strict "/tmp/manifests-${env//\//-}.yaml"

  # Dry-run
  kubectl apply --dry-run=server -f "/tmp/manifests-${env//\//-}.yaml"

  # Apply with confirmation
  read -p "Deploy to $env? (y/n) " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    kubectl apply -f "/tmp/manifests-${env//\//-}.yaml"
    echo "✓ Deployed to $env"
  else
    echo "✗ Skipped $env"
  fi
done
```

### Environment Configuration Matrix

```yaml
# environments.yaml - Centralized environment configuration
environments:
  development:
    namespace: dev
    replicas: 1
    resources:
      cpu: "100m"
      memory: "128Mi"
    image_tag: "latest"
    autoscaling: false
    monitoring: false

  qa:
    namespace: qa
    replicas: 2
    resources:
      cpu: "250m"
      memory: "256Mi"
    image_tag: "qa-latest"
    autoscaling: false
    monitoring: true

  staging:
    namespace: staging
    replicas: 3
    resources:
      cpu: "500m"
      memory: "512Mi"
    image_tag: "staging"
    autoscaling: true
    monitoring: true
    min_replicas: 3
    max_replicas: 10

  production:
    namespace: production
    replicas: 10
    resources:
      cpu: "1000m"
      memory: "2Gi"
    image_tag: "v2.3.4"
    autoscaling: true
    monitoring: true
    min_replicas: 10
    max_replicas: 100

    regions:
      us-east-1:
        node_selector:
          topology.kubernetes.io/region: us-east-1
        storage_class: gp3
        availability_zones:
        - us-east-1a
        - us-east-1b
        - us-east-1c

      us-west-2:
        node_selector:
          topology.kubernetes.io/region: us-west-2
        storage_class: gp3
        availability_zones:
        - us-west-2a
        - us-west-2b
        - us-west-2c

      eu-west-1:
        node_selector:
          topology.kubernetes.io/region: eu-west-1
        storage_class: gp3
        availability_zones:
        - eu-west-1a
        - eu-west-1b
        - eu-west-1c
```

## Security and Secrets {#security-secrets}

### Sealed Secrets Integration

```yaml
# Generate sealed secret
kubectl create secret generic my-secret \
  --from-literal=password=supersecret \
  --dry-run=client -o yaml | \
kubeseal --format yaml > sealed-secret.yaml

# overlays/production/sealed-secret.yaml
apiVersion: bitnami.com/v1alpha1
kind: SealedSecret
metadata:
  name: database-credentials
  namespace: production
spec:
  encryptedData:
    username: AgCQC5fqZ... (encrypted)
    password: AgBpQx3fL... (encrypted)
    connection-string: AgDLmN8hW... (encrypted)
  template:
    metadata:
      name: database-credentials
      labels:
        app: myapp
    type: Opaque
```

```yaml
# Reference in kustomization
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
- sealed-secret.yaml
```

### External Secrets Operator

```yaml
# components/external-secrets/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1alpha1
kind: Component

resources:
- secretstore.yaml
- externalsecret.yaml
```

```yaml
# components/external-secrets/secretstore.yaml
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: aws-secrets-manager
spec:
  provider:
    aws:
      service: SecretsManager
      region: us-east-1
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets-sa
---
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: vault
spec:
  provider:
    vault:
      server: "https://vault.example.com"
      path: "secret"
      version: "v2"
      auth:
        kubernetes:
          mountPath: "kubernetes"
          role: "myapp"
          serviceAccountRef:
            name: external-secrets-sa
```

```yaml
# components/external-secrets/externalsecret.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: app-secrets
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secrets-manager
    kind: SecretStore

  target:
    name: app-secrets
    creationPolicy: Owner
    template:
      engineVersion: v2
      data:
        config.yaml: |
          database:
            host: {{ .db_host }}
            port: {{ .db_port }}
            username: {{ .db_username }}
            password: {{ .db_password }}
          api:
            key: {{ .api_key }}
            secret: {{ .api_secret }}

  dataFrom:
  - extract:
      key: prod/myapp/database
  - extract:
      key: prod/myapp/api

  data:
  - secretKey: special-key
    remoteRef:
      key: prod/myapp/special
      property: value
```

## GitOps Integration {#gitops-integration}

### ArgoCD Integration

```yaml
# argocd/application.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: myapp-production
  namespace: argocd
spec:
  project: default

  source:
    repoURL: https://github.com/myorg/myapp-config.git
    targetRevision: main
    path: overlays/production

  destination:
    server: https://kubernetes.default.svc
    namespace: production

  syncPolicy:
    automated:
      prune: true
      selfHeal: true
      allowEmpty: false

    syncOptions:
    - CreateNamespace=true
    - PrunePropagationPolicy=foreground
    - PruneLast=true

    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m

  # Health assessment
  ignoreDifferences:
  - group: apps
    kind: Deployment
    jsonPointers:
    - /spec/replicas

  # Kustomize-specific options
  source:
    kustomize:
      namePrefix: prod-
      nameSuffix: -v2
      images:
      - gcr.io/my-project/myapp:v2.3.4
      commonLabels:
        deployed-by: argocd
      commonAnnotations:
        argocd.argoproj.io/sync-wave: "1"
```

### Flux CD Integration

```yaml
# flux/kustomization.yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1beta2
kind: Kustomization
metadata:
  name: myapp-production
  namespace: flux-system
spec:
  interval: 10m0s
  retryInterval: 1m0s
  timeout: 5m0s

  sourceRef:
    kind: GitRepository
    name: myapp-config

  path: ./overlays/production

  prune: true
  wait: true
  force: false

  # Health checks
  healthChecks:
  - apiVersion: apps/v1
    kind: Deployment
    name: myapp-deployment
    namespace: production

  # Post-build substitutions
  postBuild:
    substitute:
      cluster_name: "production-us-east-1"
      region: "us-east-1"

    substituteFrom:
    - kind: ConfigMap
      name: cluster-vars

  # Decryption
  decryption:
    provider: sops
    secretRef:
      name: sops-gpg

  # Patches
  patches:
  - patch: |
      - op: replace
        path: /spec/replicas
        value: 10
    target:
      kind: Deployment
      name: myapp-deployment
```

## Testing and Validation {#testing-validation}

### Automated Testing Script

```bash
#!/bin/bash
# test-kustomize.sh - Comprehensive testing script

set -euo pipefail

export TEST_DIR="$(mktemp -d)"
trap "rm -rf ${TEST_DIR}" EXIT

echo "=== Kustomize Configuration Testing ==="

# Test 1: Build validation
echo -e "\n--- Test 1: Build Validation ---"
for overlay in overlays/*/; do
  env=$(basename "$overlay")
  echo "Testing $env..."

  if kubectl kustomize "$overlay" > "${TEST_DIR}/${env}.yaml"; then
    echo "✓ $env build successful"
  else
    echo "✗ $env build failed"
    exit 1
  fi
done

# Test 2: YAML validation
echo -e "\n--- Test 2: YAML Validation ---"
for file in "${TEST_DIR}"/*.yaml; do
  env=$(basename "$file" .yaml)
  echo "Validating $env..."

  if yamllint -c .yamllint "$file"; then
    echo "✓ $env YAML valid"
  else
    echo "✗ $env YAML invalid"
    exit 1
  fi
done

# Test 3: Kubernetes API validation
echo -e "\n--- Test 3: Kubernetes API Validation ---"
for file in "${TEST_DIR}"/*.yaml; do
  env=$(basename "$file" .yaml)
  echo "Validating $env against Kubernetes API..."

  if kubectl apply --dry-run=server -f "$file" &>/dev/null; then
    echo "✓ $env API validation passed"
  else
    echo "✗ $env API validation failed"
    exit 1
  fi
done

# Test 4: Schema validation with kubeval
echo -e "\n--- Test 4: Schema Validation ---"
for file in "${TEST_DIR}"/*.yaml; do
  env=$(basename "$file" .yaml)
  echo "Schema validation for $env..."

  if kubeval --strict --ignore-missing-schemas "$file"; then
    echo "✓ $env schema valid"
  else
    echo "✗ $env schema invalid"
    exit 1
  fi
done

# Test 5: Policy validation with OPA
echo -e "\n--- Test 5: Policy Validation ---"
for file in "${TEST_DIR}"/*.yaml; do
  env=$(basename "$file" .yaml)
  echo "Policy validation for $env..."

  if conftest test "$file"; then
    echo "✓ $env policies passed"
  else
    echo "✗ $env policies failed"
    exit 1
  fi
done

# Test 6: Security scanning with kubesec
echo -e "\n--- Test 6: Security Scanning ---"
for file in "${TEST_DIR}"/*.yaml; do
  env=$(basename "$file" .yaml)
  echo "Security scan for $env..."

  score=$(kubesec scan "$file" | jq '.[0].score')
  if [ "$score" -ge 5 ]; then
    echo "✓ $env security score: $score"
  else
    echo "✗ $env security score too low: $score"
    exit 1
  fi
done

# Test 7: Diff between environments
echo -e "\n--- Test 7: Environment Diff Analysis ---"
echo "Comparing staging vs production..."
diff -u "${TEST_DIR}/staging.yaml" "${TEST_DIR}/production.yaml" || true

echo -e "\n=== All Tests Passed ==="
```

### OPA Policy Testing

```rego
# policies/required-labels.rego
package main

deny[msg] {
  input.kind == "Deployment"
  not input.metadata.labels.app
  msg = "Deployment must have 'app' label"
}

deny[msg] {
  input.kind == "Deployment"
  not input.metadata.labels.environment
  msg = "Deployment must have 'environment' label"
}

deny[msg] {
  input.kind == "Deployment"
  not input.spec.template.spec.securityContext.runAsNonRoot
  msg = "Deployment must run as non-root user"
}

deny[msg] {
  input.kind == "Deployment"
  container := input.spec.template.spec.containers[_]
  not container.resources.limits.cpu
  msg = sprintf("Container %s must have CPU limits", [container.name])
}

deny[msg] {
  input.kind == "Deployment"
  container := input.spec.template.spec.containers[_]
  not container.resources.limits.memory
  msg = sprintf("Container %s must have memory limits", [container.name])
}
```

```yaml
# conftest configuration
# .conftest.yaml
policy:
  - policies/

namespace: main

# Ignore certain kinds
ignore:
  - kustomize.config.k8s.io/v1beta1/Kustomization
```

## Conclusion

Kustomize provides a powerful, template-free approach to Kubernetes configuration management through sophisticated overlay patterns, component composition, and declarative transformations. This guide has covered advanced techniques including strategic merge patches, JSON patches, custom generators, multi-environment management, and GitOps integration.

Key takeaways:

1. **Overlay Architecture**: Hierarchical overlays enable environment-specific customizations while maintaining DRY principles
2. **Components**: Reusable components promote consistency across applications
3. **Patch Strategies**: Multiple patch types provide flexibility for different modification scenarios
4. **Security**: Integration with sealed secrets and external secrets operators ensures secure credential management
5. **GitOps**: Native integration with ArgoCD and Flux CD enables automated deployment workflows
6. **Testing**: Comprehensive validation ensures configuration correctness before deployment

For more information on Kubernetes configuration and GitOps, see our guides on [Advanced GitOps implementation](/advanced-gitops-implementation-argocd-flux-enterprise-guide/) and [Helm chart testing strategies](/helm-chart-testing-strategies-enterprise-guide/).