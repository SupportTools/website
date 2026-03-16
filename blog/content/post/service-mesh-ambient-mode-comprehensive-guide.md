---
title: "Service Mesh Ambient Mode: Complete Guide to Istio Ambient Mesh Architecture"
date: 2026-11-16T00:00:00-05:00
draft: false
tags: ["Istio", "Service Mesh", "Ambient Mode", "Kubernetes", "Networking", "Sidecar-less", "eBPF"]
categories: ["Kubernetes", "Networking", "Service Mesh"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive exploration of Istio Ambient Mesh, the sidecar-less service mesh architecture using ztunnel and waypoint proxies for simplified operations and improved performance."
more_link: "yes"
url: "/service-mesh-ambient-mode-comprehensive-guide/"
---

Istio Ambient Mesh represents a revolutionary departure from traditional sidecar-based service mesh architectures. This comprehensive guide explores the ambient mode architecture, implementation patterns, migration strategies, and production deployment practices for enterprises seeking simplified service mesh operations with improved performance and resource efficiency.

<!--more-->

# Service Mesh Ambient Mode: Complete Implementation Guide

## Executive Summary

Istio Ambient Mesh introduces a sidecar-less architecture that dramatically simplifies service mesh deployment and operations while reducing resource overhead. By separating the data plane into two distinct layers—ztunnel for Layer 4 connectivity and waypoint proxies for Layer 7 processing—ambient mode provides flexible, incrementally adoptable mesh capabilities. This guide provides comprehensive coverage of ambient mesh architecture, deployment strategies, migration patterns, and operational best practices for production environments.

## Understanding Ambient Mesh Architecture

### Traditional Sidecar vs. Ambient Mode

**Traditional Sidecar Architecture:**
```
┌─────────────────────────────────────┐
│           Application Pod           │
│  ┌──────────────┐  ┌─────────────┐ │
│  │  Application │  │    Envoy    │ │
│  │  Container   │◄─┤   Sidecar   │ │
│  └──────────────┘  └──────┬──────┘ │
└────────────────────────────┼────────┘
                             │
                    Network Traffic
```

**Ambient Mode Architecture:**
```
┌─────────────────────────────────────┐
│           Application Pod           │
│  ┌──────────────────────────────┐   │
│  │    Application Container     │   │
│  │      (No Sidecar!)           │   │
│  └───────────────┬──────────────┘   │
└──────────────────┼───────────────────┘
                   │
    ┌──────────────┼──────────────┐
    │  Node-Level ztunnel (L4)    │
    │  • mTLS                      │
    │  • Telemetry                 │
    │  • Authentication            │
    └──────────────┬───────────────┘
                   │
    ┌──────────────┴───────────────┐
    │  Waypoint Proxy (L7)         │
    │  • Traffic Management        │
    │  • Advanced Routing          │
    │  • Request Inspection        │
    └──────────────────────────────┘
```

### Ambient Mesh Components

1. **ztunnel (Zero Trust Tunnel)**
   - Node-level DaemonSet providing L4 connectivity
   - Handles mTLS, authentication, and telemetry
   - Uses eBPF for transparent traffic interception
   - Minimal resource footprint per node

2. **Waypoint Proxy**
   - Optional L7 processing layer
   - Deployed per namespace or service account
   - Full Envoy proxy capabilities
   - Only used when L7 features needed

3. **Control Plane (istiod)**
   - Same as sidecar mode
   - Manages configuration and certificates
   - Pushes policies to ztunnel and waypoint proxies

## Prerequisites and Cluster Preparation

### System Requirements

```bash
#!/bin/bash
# check-ambient-requirements.sh

set -euo pipefail

echo "Checking Ambient Mesh Requirements..."

# Check Kubernetes version
K8S_VERSION=$(kubectl version --short | grep Server | awk '{print $3}' | sed 's/v//')
REQUIRED_VERSION="1.24.0"

if [ "$(printf '%s\n' "$REQUIRED_VERSION" "$K8S_VERSION" | sort -V | head -n1)" != "$REQUIRED_VERSION" ]; then
    echo "✗ Kubernetes version must be >= $REQUIRED_VERSION (current: $K8S_VERSION)"
    exit 1
fi
echo "✓ Kubernetes version: $K8S_VERSION"

# Check for CNI plugin support
echo "Checking CNI plugin..."
CNI_PLUGIN=$(kubectl get nodes -o jsonpath='{.items[0].status.nodeInfo.containerRuntimeVersion}')
echo "✓ CNI plugin: $CNI_PLUGIN"

# Check for required kernel version (for eBPF)
KERNEL_VERSION=$(kubectl get nodes -o jsonpath='{.items[0].status.nodeInfo.kernelVersion}' | awk '{print $1}')
echo "✓ Kernel version: $KERNEL_VERSION"

# Verify eBPF support
echo "Checking eBPF support..."
if kubectl debug node/$(kubectl get nodes -o jsonpath='{.items[0].metadata.name}') \
  --image=alpine -it -- sh -c 'test -f /sys/fs/bpf/bpf' 2>/dev/null; then
    echo "✓ eBPF filesystem mounted"
else
    echo "! eBPF filesystem not found (may need manual check)"
fi

# Check node resources
echo "Checking node resources..."
kubectl top nodes 2>/dev/null || echo "! Metrics server not available"

echo "✓ All requirements checked"
```

### Enable Required Features

```yaml
# enable-ambient-features.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: istio-cni-config
  namespace: istio-system
data:
  cni_conf_name: "istio-cni"
  exclude_namespaces: "istio-system,kube-system"
  log_level: "info"
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: ztunnel-config
  namespace: istio-system
data:
  mesh: |
    defaultConfig:
      proxyMetadata:
        ISTIO_META_ENABLE_HBONE: "true"
    trustDomain: cluster.local
    enableAutoMtls: true
```

## Installing Istio with Ambient Mode

### Installation Using istioctl

```bash
#!/bin/bash
# install-istio-ambient.sh

set -euo pipefail

ISTIO_VERSION="1.21.0"
CLUSTER_NAME="${CLUSTER_NAME:-production}"

echo "Installing Istio ${ISTIO_VERSION} with Ambient Mode..."

# Download istioctl
curl -L https://istio.io/downloadIstio | ISTIO_VERSION=${ISTIO_VERSION} sh -
cd istio-${ISTIO_VERSION}
export PATH=$PWD/bin:$PATH

# Create namespace
kubectl create namespace istio-system --dry-run=client -o yaml | kubectl apply -f -

# Install Istio base components
istioctl install -y -f - <<EOF
apiVersion: install.istio.io/v1alpha1
kind: IstioOperator
metadata:
  name: ambient-install
  namespace: istio-system
spec:
  profile: ambient

  components:
    base:
      enabled: true

    pilot:
      enabled: true
      k8s:
        replicaCount: 2
        resources:
          requests:
            cpu: 500m
            memory: 2Gi
          limits:
            cpu: 2000m
            memory: 4Gi
        hpaSpec:
          minReplicas: 2
          maxReplicas: 5
          metrics:
          - type: Resource
            resource:
              name: cpu
              targetAverageUtilization: 80
        env:
        - name: PILOT_ENABLE_AMBIENT
          value: "true"
        - name: PILOT_ENABLE_HBONE
          value: "true"

    cni:
      enabled: true
      namespace: istio-system
      k8s:
        daemonSet:
          updateStrategy:
            type: RollingUpdate
            rollingUpdate:
              maxUnavailable: 1

    ztunnel:
      enabled: true
      namespace: istio-system
      k8s:
        daemonSet:
          updateStrategy:
            type: RollingUpdate
            rollingUpdate:
              maxUnavailable: 1
        resources:
          requests:
            cpu: 200m
            memory: 512Mi
          limits:
            cpu: 1000m
            memory: 1Gi

  meshConfig:
    accessLogFile: /dev/stdout
    accessLogEncoding: JSON
    enableTracing: true
    defaultConfig:
      tracing:
        zipkin:
          address: jaeger-collector.istio-system:9411
      holdApplicationUntilProxyStarts: true
      proxyMetadata:
        ISTIO_META_DNS_CAPTURE: "true"
        ISTIO_META_DNS_AUTO_ALLOCATE: "true"

    trustDomain: ${CLUSTER_NAME}.local

    # Ambient-specific configuration
    defaultConfig:
      proxyMetadata:
        ISTIO_META_ENABLE_HBONE: "true"

    enableAutoMtls: true

    # Certificate configuration
    certificates:
    - secretName: dns.istio-system
      dnsNames:
      - istio-pilot.istio-system.svc
      - istiod.istio-system.svc

  values:
    global:
      istioNamespace: istio-system
      meshID: ${CLUSTER_NAME}-mesh
      multiCluster:
        clusterName: ${CLUSTER_NAME}
      network: ${CLUSTER_NAME}-network

    cni:
      excludeNamespaces:
      - istio-system
      - kube-system
      - kube-public
      - kube-node-lease

      logLevel: info

      # eBPF configuration
      ambient:
        enabled: true
        configDir: /etc/cni/net.d

    ztunnel:
      # Hub and tag are set automatically

      # Resource requirements
      resources:
        requests:
          cpu: 200m
          memory: 512Mi
        limits:
          cpu: 1000m
          memory: 1Gi

      # Environment variables
      env:
        L7_ENABLED: "false"
        RUST_LOG: "info"

      # Prometheus monitoring
      prometheusPort: 15020

    # Pilot configuration
    pilot:
      autoscaleEnabled: true
      autoscaleMin: 2
      autoscaleMax: 5

      env:
        PILOT_ENABLE_WORKLOAD_ENTRY_AUTOREGISTRATION: true
        PILOT_ENABLE_WORKLOAD_ENTRY_HEALTHCHECKS: true
        EXTERNAL_ISTIOD: false
EOF

echo "Waiting for Istio components to be ready..."
kubectl wait --for=condition=Ready pods --all -n istio-system --timeout=600s

echo "Verifying installation..."
istioctl verify-install

echo "✓ Istio Ambient Mode installation complete!"
```

### Helm-Based Installation

```yaml
# values-ambient.yaml
global:
  istioNamespace: istio-system
  platform: k8s

profile: ambient

base:
  enableCRDTemplates: false
  validationURL: ""

pilot:
  enabled: true

  autoscaleEnabled: true
  autoscaleMin: 2
  autoscaleMax: 5

  replicaCount: 2

  rollingMaxSurge: 100%
  rollingMaxUnavailable: 25%

  resources:
    requests:
      cpu: 500m
      memory: 2Gi
    limits:
      cpu: 2000m
      memory: 4Gi

  env:
    PILOT_ENABLE_AMBIENT: "true"
    PILOT_ENABLE_HBONE: "true"
    PILOT_TRACE_SAMPLING: "1.0"

  nodeSelector:
    kubernetes.io/os: linux

  tolerations:
  - key: node-role.kubernetes.io/control-plane
    effect: NoSchedule

cni:
  enabled: true

  cniBinDir: /opt/cni/bin
  cniConfDir: /etc/cni/net.d
  cniConfFileName: istio-cni.conf

  excludeNamespaces:
  - istio-system
  - kube-system

  logLevel: info

  ambient:
    enabled: true

  resource:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 512Mi

ztunnel:
  enabled: true

  resources:
    requests:
      cpu: 200m
      memory: 512Mi
    limits:
      cpu: 1000m
      memory: 1Gi

  env:
    L7_ENABLED: "false"
    RUST_LOG: "info"

  terminationGracePeriodSeconds: 30

  nodeSelector:
    kubernetes.io/os: linux

meshConfig:
  enableTracing: true
  enableAutoMtls: true
  accessLogFile: /dev/stdout
  accessLogEncoding: JSON

  defaultConfig:
    holdApplicationUntilProxyStarts: true
    proxyMetadata:
      ISTIO_META_ENABLE_HBONE: "true"
      ISTIO_META_DNS_CAPTURE: "true"
```

```bash
# Install using Helm
helm repo add istio https://istio-release.storage.googleapis.com/charts
helm repo update

helm install istio-base istio/base \
  -n istio-system \
  --create-namespace \
  --wait

helm install istiod istio/istiod \
  -n istio-system \
  --values values-ambient.yaml \
  --wait

helm install ztunnel istio/ztunnel \
  -n istio-system \
  --wait

helm install istio-cni istio/cni \
  -n istio-system \
  --wait
```

## Enabling Ambient Mode for Namespaces

### Labeling Namespaces for Ambient Mesh

```bash
#!/bin/bash
# enable-ambient-namespace.sh

NAMESPACE="$1"

if [ -z "$NAMESPACE" ]; then
    echo "Usage: $0 <namespace>"
    exit 1
fi

echo "Enabling ambient mode for namespace: $NAMESPACE"

# Label namespace for ambient mode
kubectl label namespace $NAMESPACE istio.io/dataplane-mode=ambient --overwrite

# Verify
kubectl get namespace $NAMESPACE -o jsonpath='{.metadata.labels.istio\.io/dataplane-mode}'
echo ""

# Check ztunnel connectivity
echo "Checking ztunnel status..."
kubectl get pods -n istio-system -l app=ztunnel

echo "✓ Ambient mode enabled for namespace: $NAMESPACE"
```

### Gradual Rollout Strategy

```yaml
# ambient-rollout-strategy.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ambient-rollout-config
  namespace: istio-system
data:
  rollout-strategy.yaml: |
    # Phase 1: Enable ambient for development namespace
    phase1:
      namespaces:
        - dev
      validation:
        - connectivity-tests
        - mTLS-verification
        - metrics-collection
      duration: 1week

    # Phase 2: Enable for staging
    phase2:
      namespaces:
        - staging
      validation:
        - load-testing
        - security-scanning
        - performance-benchmarks
      duration: 1week

    # Phase 3: Production rollout (canary)
    phase3:
      namespaces:
        - prod-canary
      validation:
        - traffic-shadowing
        - error-rate-monitoring
        - latency-analysis
      duration: 2weeks

    # Phase 4: Full production
    phase4:
      namespaces:
        - production
      validation:
        - full-traffic-migration
        - 24x7-monitoring
      duration: ongoing
```

## Deploying Waypoint Proxies

### Waypoint Proxy for Namespace

```bash
#!/bin/bash
# deploy-waypoint.sh

NAMESPACE="$1"
WAYPOINT_NAME="${2:-waypoint}"

echo "Deploying waypoint proxy for namespace: $NAMESPACE"

# Create waypoint using istioctl
istioctl x waypoint apply \
  --namespace=$NAMESPACE \
  --name=$WAYPOINT_NAME \
  --wait

# Verify deployment
kubectl get pods -n $NAMESPACE -l istio.io/gateway-name=$WAYPOINT_NAME

echo "✓ Waypoint proxy deployed: $WAYPOINT_NAME"
```

### Waypoint Proxy Configuration

```yaml
# waypoint-proxy-config.yaml
apiVersion: gateway.networking.k8s.io/v1beta1
kind: Gateway
metadata:
  name: waypoint
  namespace: production
  labels:
    istio.io/waypoint-for: service
spec:
  gatewayClassName: istio-waypoint
  listeners:
  - name: mesh
    port: 15008
    protocol: HBONE
    allowedRoutes:
      namespaces:
        from: Same
---
apiVersion: v1
kind: Service
metadata:
  name: waypoint
  namespace: production
  labels:
    istio.io/waypoint-for: service
spec:
  type: ClusterIP
  selector:
    istio.io/gateway-name: waypoint
  ports:
  - port: 15008
    targetPort: 15008
    protocol: TCP
    name: hbone
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: waypoint
  namespace: production
  labels:
    istio.io/gateway-name: waypoint
spec:
  replicas: 2
  selector:
    matchLabels:
      istio.io/gateway-name: waypoint
  template:
    metadata:
      labels:
        istio.io/gateway-name: waypoint
        sidecar.istio.io/inject: "false"
    spec:
      serviceAccountName: waypoint
      containers:
      - name: istio-proxy
        image: auto
        ports:
        - containerPort: 15008
          name: hbone
          protocol: TCP
        - containerPort: 15020
          name: metrics
          protocol: TCP
        - containerPort: 15021
          name: health
          protocol: TCP
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 2000m
            memory: 1Gi
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop:
            - ALL
          privileged: false
          readOnlyRootFilesystem: true
          runAsNonRoot: true
          runAsUser: 1337
        env:
        - name: ISTIO_META_WAYPOINT_FOR
          value: "service"
        - name: PILOT_CERT_PROVIDER
          value: istiod
        - name: CA_ADDR
          value: istiod.istio-system.svc:15012
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        - name: POD_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace
        - name: INSTANCE_IP
          valueFrom:
            fieldRef:
              fieldPath: status.podIP
        - name: SERVICE_ACCOUNT
          valueFrom:
            fieldRef:
              fieldPath: spec.serviceAccountName
        - name: HOST_IP
          valueFrom:
            fieldRef:
              fieldPath: status.hostIP
        - name: ISTIO_CPU_LIMIT
          valueFrom:
            resourceFieldRef:
              resource: limits.cpu
        - name: ISTIO_META_MESH_ID
          value: cluster.local
        - name: ISTIO_META_CLUSTER_ID
          value: Kubernetes
        volumeMounts:
        - name: workload-socket
          mountPath: /var/run/secrets/workload-spiffe-uds
        - name: workload-certs
          mountPath: /var/run/secrets/workload-spiffe-credentials
        - name: istio-envoy
          mountPath: /etc/istio/proxy
        - name: istio-data
          mountPath: /var/lib/istio/data
        - name: istio-podinfo
          mountPath: /etc/istio/pod
        - name: istio-token
          mountPath: /var/run/secrets/tokens
        - name: istiod-ca-cert
          mountPath: /var/run/secrets/istio
      volumes:
      - name: workload-socket
        emptyDir: {}
      - name: workload-certs
        emptyDir: {}
      - name: istio-envoy
        emptyDir: {}
      - name: istio-data
        emptyDir: {}
      - name: istio-podinfo
        downwardAPI:
          items:
          - path: labels
            fieldRef:
              fieldPath: metadata.labels
          - path: annotations
            fieldRef:
              fieldPath: metadata.annotations
      - name: istio-token
        projected:
          sources:
          - serviceAccountToken:
              path: istio-token
              expirationSeconds: 43200
              audience: istio-ca
      - name: istiod-ca-cert
        configMap:
          name: istio-ca-root-cert
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchLabels:
                  istio.io/gateway-name: waypoint
              topologyKey: kubernetes.io/hostname
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: waypoint
  namespace: production
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: waypoint
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: waypoint
  minReplicas: 2
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 80
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 50
        periodSeconds: 15
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
      - type: Percent
        value: 100
        periodSeconds: 15
      - type: Pods
        value: 4
        periodSeconds: 15
      selectPolicy: Max
```

## Traffic Management in Ambient Mode

### Virtual Service with Waypoint

```yaml
# traffic-management-ambient.yaml
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: reviews-route
  namespace: production
spec:
  hosts:
  - reviews.production.svc.cluster.local
  http:
  - match:
    - headers:
        end-user:
          exact: jason
    route:
    - destination:
        host: reviews.production.svc.cluster.local
        subset: v2
      weight: 100
  - route:
    - destination:
        host: reviews.production.svc.cluster.local
        subset: v1
      weight: 90
    - destination:
        host: reviews.production.svc.cluster.local
        subset: v2
      weight: 10
---
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: reviews
  namespace: production
spec:
  host: reviews.production.svc.cluster.local
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 100
      http:
        http1MaxPendingRequests: 50
        http2MaxRequests: 100
        maxRequestsPerConnection: 2
    loadBalancer:
      simple: LEAST_REQUEST
      localityLbSetting:
        enabled: true
    outlierDetection:
      consecutiveErrors: 5
      interval: 30s
      baseEjectionTime: 30s
      maxEjectionPercent: 50
      minHealthPercent: 40
  subsets:
  - name: v1
    labels:
      version: v1
  - name: v2
    labels:
      version: v2
    trafficPolicy:
      connectionPool:
        tcp:
          maxConnections: 200
---
apiVersion: networking.istio.io/v1beta1
kind: ServiceEntry
metadata:
  name: external-api
  namespace: production
spec:
  hosts:
  - api.external.com
  ports:
  - number: 443
    name: https
    protocol: HTTPS
  location: MESH_EXTERNAL
  resolution: DNS
```

### Authorization Policies

```yaml
# ambient-authz-policies.yaml
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: frontend-to-backend
  namespace: production
spec:
  selector:
    matchLabels:
      app: backend
  action: ALLOW
  rules:
  - from:
    - source:
        principals:
        - cluster.local/ns/production/sa/frontend
    to:
    - operation:
        methods: ["GET", "POST"]
        paths: ["/api/*"]
    when:
    - key: request.auth.claims[iss]
      values: ["https://issuer.example.com"]
---
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: deny-all-default
  namespace: production
spec:
  action: DENY
  rules:
  - from:
    - source:
        notNamespaces: ["production", "istio-system"]
---
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: production
spec:
  mtls:
    mode: STRICT
---
apiVersion: security.istio.io/v1beta1
kind: RequestAuthentication
metadata:
  name: jwt-auth
  namespace: production
spec:
  selector:
    matchLabels:
      app: backend
  jwtRules:
  - issuer: "https://issuer.example.com"
    jwksUri: "https://issuer.example.com/.well-known/jwks.json"
    audiences:
    - "backend-service"
    forwardOriginalToken: true
```

## Monitoring and Observability

### Prometheus Configuration

```yaml
# prometheus-ambient-scrape.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-config
  namespace: istio-system
data:
  prometheus.yml: |
    global:
      scrape_interval: 15s
      evaluation_interval: 15s
      external_labels:
        cluster: production
        mesh: ambient

    scrape_configs:
    # ztunnel metrics
    - job_name: 'ztunnel'
      kubernetes_sd_configs:
      - role: pod
        namespaces:
          names:
          - istio-system
      relabel_configs:
      - source_labels: [__meta_kubernetes_pod_label_app]
        action: keep
        regex: ztunnel
      - source_labels: [__meta_kubernetes_pod_name]
        target_label: pod
      - source_labels: [__meta_kubernetes_namespace]
        target_label: namespace
      - source_labels: [__meta_kubernetes_pod_node_name]
        target_label: node

    # Waypoint metrics
    - job_name: 'waypoint'
      kubernetes_sd_configs:
      - role: pod
        namespaces:
          names:
          - production
      relabel_configs:
      - source_labels: [__meta_kubernetes_pod_label_istio_io_gateway_name]
        action: keep
        regex: waypoint
      - source_labels: [__address__]
        action: replace
        regex: ([^:]+)(?::\d+)?
        replacement: $1:15020
        target_label: __address__
      - source_labels: [__meta_kubernetes_pod_name]
        target_label: pod
      - source_labels: [__meta_kubernetes_namespace]
        target_label: namespace

    # Istiod metrics
    - job_name: 'istiod'
      kubernetes_sd_configs:
      - role: pod
        namespaces:
          names:
          - istio-system
      relabel_configs:
      - source_labels: [__meta_kubernetes_pod_label_app]
        action: keep
        regex: istiod
      - source_labels: [__address__]
        action: replace
        regex: ([^:]+)(?::\d+)?
        replacement: $1:15014
        target_label: __address__
      - source_labels: [__meta_kubernetes_pod_name]
        target_label: pod
      - source_labels: [__meta_kubernetes_namespace]
        target_label: namespace
```

### Grafana Dashboards

```json
{
  "dashboard": {
    "title": "Istio Ambient Mesh Overview",
    "tags": ["istio", "ambient", "service-mesh"],
    "timezone": "browser",
    "panels": [
      {
        "id": 1,
        "title": "ztunnel Connection Rate",
        "type": "graph",
        "targets": [
          {
            "expr": "rate(istio_tcp_connections_opened_total{job=\"ztunnel\"}[5m])",
            "legendFormat": "{{pod}} - opened"
          },
          {
            "expr": "rate(istio_tcp_connections_closed_total{job=\"ztunnel\"}[5m])",
            "legendFormat": "{{pod}} - closed"
          }
        ]
      },
      {
        "id": 2,
        "title": "Waypoint Request Rate",
        "type": "graph",
        "targets": [
          {
            "expr": "sum(rate(istio_requests_total{job=\"waypoint\"}[5m])) by (destination_service)",
            "legendFormat": "{{destination_service}}"
          }
        ]
      },
      {
        "id": 3,
        "title": "mTLS Certificate Expiration",
        "type": "gauge",
        "targets": [
          {
            "expr": "(pilot_cert_expiry_seconds - time()) / 86400",
            "legendFormat": "Days until expiration"
          }
        ]
      },
      {
        "id": 4,
        "title": "Ambient vs Sidecar Resource Usage",
        "type": "graph",
        "targets": [
          {
            "expr": "sum(container_memory_working_set_bytes{pod=~\"ztunnel-.*\"}) / 1024 / 1024",
            "legendFormat": "ztunnel Memory (MB)"
          },
          {
            "expr": "sum(container_memory_working_set_bytes{container=\"istio-proxy\"}) / 1024 / 1024",
            "legendFormat": "Sidecar Memory (MB)"
          }
        ]
      }
    ]
  }
}
```

## Migration from Sidecar to Ambient

### Migration Strategy

```bash
#!/bin/bash
# migrate-to-ambient.sh

set -euo pipefail

NAMESPACE="$1"
DRY_RUN="${2:-false}"

echo "=== Migrating namespace $NAMESPACE to Ambient Mode ==="

# Step 1: Analyze current sidecar usage
echo "Step 1: Analyzing current configuration..."
kubectl get pods -n $NAMESPACE -o json | \
  jq -r '.items[] | select(.spec.containers[].name=="istio-proxy") | .metadata.name' | \
  tee sidecars.txt

SIDECAR_COUNT=$(wc -l < sidecars.txt)
echo "Found $SIDECAR_COUNT pods with sidecars"

# Step 2: Check for L7 features
echo "Step 2: Checking for L7 feature usage..."
kubectl get virtualservices,destinationrules -n $NAMESPACE -o yaml > l7-config.yaml

if grep -q "match:" l7-config.yaml || grep -q "rewrite:" l7-config.yaml; then
    echo "! L7 features detected - waypoint proxy will be required"
    NEEDS_WAYPOINT=true
else
    echo "✓ No L7 features detected"
    NEEDS_WAYPOINT=false
fi

# Step 3: Enable ambient mode
if [ "$DRY_RUN" = "false" ]; then
    echo "Step 3: Enabling ambient mode..."
    kubectl label namespace $NAMESPACE istio.io/dataplane-mode=ambient --overwrite

    # Step 4: Deploy waypoint if needed
    if [ "$NEEDS_WAYPOINT" = "true" ]; then
        echo "Step 4: Deploying waypoint proxy..."
        istioctl x waypoint apply --namespace=$NAMESPACE --wait
    fi

    # Step 5: Remove sidecar injection label
    echo "Step 5: Removing sidecar injection label..."
    kubectl label namespace $NAMESPACE istio-injection- --overwrite

    # Step 6: Rolling restart
    echo "Step 6: Performing rolling restart..."
    kubectl rollout restart deployment -n $NAMESPACE
    kubectl rollout status deployment -n $NAMESPACE --timeout=10m

    # Step 7: Verify migration
    echo "Step 7: Verifying migration..."
    sleep 30

    NEW_SIDECAR_COUNT=$(kubectl get pods -n $NAMESPACE -o json | \
      jq -r '.items[] | select(.spec.containers[].name=="istio-proxy") | .metadata.name' | \
      wc -l)

    if [ "$NEW_SIDECAR_COUNT" -eq "0" ]; then
        echo "✓ Migration successful - all sidecars removed"
    else
        echo "! Warning: $NEW_SIDECAR_COUNT pods still have sidecars"
    fi

    # Step 8: Validate connectivity
    echo "Step 8: Validating connectivity..."
    # Add connectivity tests here

else
    echo "DRY RUN: Would enable ambient mode for namespace $NAMESPACE"
    if [ "$NEEDS_WAYPOINT" = "true" ]; then
        echo "DRY RUN: Would deploy waypoint proxy"
    fi
fi

echo "✓ Migration process complete"
```

## Troubleshooting Guide

```bash
#!/bin/bash
# troubleshoot-ambient.sh

set -euo pipefail

echo "=== Istio Ambient Mesh Troubleshooting ==="

# Check ztunnel status
echo "1. Checking ztunnel status..."
kubectl get pods -n istio-system -l app=ztunnel -o wide

# Check ztunnel logs for errors
echo "2. Checking ztunnel logs..."
kubectl logs -n istio-system -l app=ztunnel --tail=50 | grep -i error || echo "No errors found"

# Check waypoint proxies
echo "3. Checking waypoint proxies..."
kubectl get gateways --all-namespaces

# Verify ambient labeling
echo "4. Verifying namespace labels..."
kubectl get namespaces -L istio.io/dataplane-mode

# Check mTLS status
echo "5. Checking mTLS configuration..."
kubectl get peerauthentication --all-namespaces

# Test connectivity
echo "6. Testing pod-to-pod connectivity..."
# Add connectivity tests

# Check istiod health
echo "7. Checking istiod health..."
kubectl exec -n istio-system deploy/istiod -- pilot-discovery request GET /ready

# Check CNI installation
echo "8. Checking CNI installation..."
kubectl get pods -n istio-system -l k8s-app=istio-cni-node -o wide

echo "✓ Troubleshooting complete"
```

## Conclusion

Istio Ambient Mesh represents a significant evolution in service mesh architecture, offering simplified operations, reduced resource consumption, and improved performance through its sidecar-less design. Key advantages include:

- **90% reduction** in proxy resource overhead through shared ztunnel
- **Simplified operations** with no sidecar injection or pod restarts
- **Incremental adoption** with namespace-level enablement
- **Flexible L7 processing** through optional waypoint proxies
- **Enhanced security** with transparent mTLS at the ztunnel layer

Organizations adopting ambient mode should follow a phased approach, starting with non-production environments, validating connectivity and performance, and gradually rolling out to production workloads. The combination of ztunnel for L4 functionality and waypoint proxies for L7 features provides an optimal balance of simplicity and capability for modern service mesh deployments.
