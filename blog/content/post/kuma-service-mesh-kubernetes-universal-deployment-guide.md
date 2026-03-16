---
title: "Kuma Service Mesh: Universal Control Plane for Kubernetes and VMs"
date: 2027-01-09T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Kuma", "Service Mesh", "Networking"]
categories: ["Kubernetes", "Service Mesh", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Kuma service mesh covering standalone and multi-zone control plane modes, mTLS, traffic policies, observability, and day-2 operations for platform teams evaluating Istio alternatives."
more_link: "yes"
url: "/kuma-service-mesh-kubernetes-universal-deployment-guide/"
---

Service mesh adoption has historically stalled on operational complexity. **Kuma**, the CNCF-graduated service mesh built on Envoy and developed by Kong, prioritises operational simplicity without sacrificing the capabilities enterprise teams need: mTLS, traffic management, circuit breaking, distributed tracing, and multi-zone federation. Its unified data plane runs identically on Kubernetes pods and on-premise VMs, making it well-suited for organisations in the middle of a cloud migration.

This guide covers Kuma's control plane modes, core policy CRDs, observability integration, multi-zone deployments, and the operational patterns that matter after the initial installation.

<!--more-->

## Kuma Architecture

### Control Plane Modes

Kuma ships in two control plane modes chosen at installation time.

**Standalone mode** deploys a single control plane that manages one zone — typically one Kubernetes cluster. This is the correct starting point for most organisations. The control plane consists of a Deployment and a backing PostgreSQL or CockroachDB database (or SQLite for small clusters).

**Multi-zone mode** deploys a **global control plane** that federates multiple **zone control planes**. Each zone control plane manages a single Kubernetes cluster or Universal (VM) environment. The global control plane synchronises policies and service discovery across zones. Cross-zone traffic flows through **zone ingress** and **zone egress** proxies.

```
Multi-Zone Architecture

Global Control Plane (dedicated cluster)
    │
    ├── Zone Control Plane: us-east-1 (Kubernetes)
    │     └── dataplanes: app pods with Envoy sidecars
    │
    ├── Zone Control Plane: eu-west-1 (Kubernetes)
    │     └── dataplanes: app pods with Envoy sidecars
    │
    └── Zone Control Plane: dc-berlin (Universal / VMs)
          └── dataplanes: kumactl-registered VM agents
```

### The Mesh Resource

Every policy in Kuma scopes to a **Mesh** resource. A mesh defines the mTLS configuration, the default logging and tracing backends, and the traffic permission baseline for all services within it.

```yaml
apiVersion: kuma.io/v1alpha1
kind: Mesh
metadata:
  name: production
spec:
  mtls:
    enabledBackend: ca-1
    backends:
      - name: ca-1
        type: builtin
        dpCert:
          rotation:
            expiration: 24h
        conf:
          caCert:
            RSAbits: 2048
            expiration: 87600h   # 10 years
  logging:
    defaultBackend: loki
    backends:
      - name: loki
        type: tcp
        conf:
          address: loki.observability.svc.cluster.local:9095
  tracing:
    defaultBackend: jaeger
    backends:
      - name: jaeger
        type: zipkin
        conf:
          url: http://jaeger-collector.observability.svc.cluster.local:9411/api/v2/spans
  metrics:
    enabledBackend: prometheus-1
    backends:
      - name: prometheus-1
        type: prometheus
        conf:
          port: 5670
          path: /metrics
          skipMTLS: false
          tags:
            kuma.io/service: dataplane-prometheus
```

## Installation (Standalone Mode)

### Helm Installation

```bash
helm repo add kuma https://kumahq.github.io/charts
helm repo update

# Create the system namespace
kubectl create namespace kuma-system

# Install the control plane
helm upgrade --install kuma kuma/kuma \
  --namespace kuma-system \
  --version 2.7.3 \
  --set controlPlane.mode=Standalone \
  --set controlPlane.replicas=2 \
  --set controlPlane.resources.requests.cpu=100m \
  --set controlPlane.resources.requests.memory=256Mi \
  --set controlPlane.resources.limits.cpu="2" \
  --set controlPlane.resources.limits.memory=1Gi \
  --set "controlPlane.envVars.KUMA_STORE_TYPE=postgres" \
  --set "controlPlane.envVars.KUMA_STORE_POSTGRES_HOST=postgres.kuma-system.svc.cluster.local" \
  --set "controlPlane.envVars.KUMA_STORE_POSTGRES_PORT=5432" \
  --set "controlPlane.envVars.KUMA_STORE_POSTGRES_DB_NAME=kuma" \
  --set "controlPlane.envVars.KUMA_STORE_POSTGRES_USER=kuma" \
  --set "controlPlane.envVars.KUMA_STORE_POSTGRES_PASSWORD=EXAMPLE_TOKEN" \
  --set ingress.enabled=true \
  --set egress.enabled=true \
  --wait

# Install the kumactl CLI
curl -L https://kuma.io/installer.sh | VERSION=2.7.3 sh -
export PATH="${PATH}:${PWD}/kuma-2.7.3/bin"

# Verify the control plane
kumactl get meshes
```

### Create the Default Mesh

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: kuma.io/v1alpha1
kind: Mesh
metadata:
  name: default
spec:
  mtls:
    enabledBackend: builtin-ca
    backends:
      - name: builtin-ca
        type: builtin
        dpCert:
          rotation:
            expiration: 24h
        conf:
          caCert:
            RSAbits: 2048
            expiration: 87600h
EOF
```

### Enable Sidecar Injection

Annotate namespaces to opt in to automatic sidecar injection:

```bash
kubectl label namespace production kuma.io/sidecar-injection=enabled
kubectl label namespace staging kuma.io/sidecar-injection=enabled
```

Verify injection is working:

```bash
# Deploy a test workload
kubectl -n production run test-pod \
  --image=nginx:1.27 \
  --labels="app=test"

# Confirm the Envoy sidecar is present
kubectl -n production get pod test-pod \
  -o jsonpath='{.spec.containers[*].name}'
# Expected output: test-pod kuma-sidecar
```

## mTLS with MeshTrafficPermission

By default after enabling mTLS, Kuma runs in **permissive mode** — it adds mTLS but also allows plain-text connections. Switch to **strict mode** and then grant permissions explicitly.

### Set Strict mTLS on the Mesh

```yaml
apiVersion: kuma.io/v1alpha1
kind: Mesh
metadata:
  name: production
spec:
  mtls:
    enabledBackend: builtin-ca
    backends:
      - name: builtin-ca
        type: builtin
        dpCert:
          rotation:
            expiration: 24h
        conf:
          caCert:
            RSAbits: 2048
            expiration: 87600h
```

### Grant Traffic Permissions

```yaml
# Allow the API service to receive traffic from the frontend
apiVersion: kuma.io/v1alpha1
kind: MeshTrafficPermission
metadata:
  name: allow-frontend-to-api
  namespace: kuma-system
  labels:
    kuma.io/mesh: production
spec:
  targetRef:
    kind: MeshService
    name: api_production_svc_8080
  from:
    - targetRef:
        kind: MeshSubset
        tags:
          app: frontend
      default:
        action: Allow
---
# Allow prometheus scraping from the observability namespace
apiVersion: kuma.io/v1alpha1
kind: MeshTrafficPermission
metadata:
  name: allow-prometheus-scrape
  namespace: kuma-system
  labels:
    kuma.io/mesh: production
spec:
  targetRef:
    kind: Mesh
    name: production
  from:
    - targetRef:
        kind: MeshSubset
        tags:
          k8s.kuma.io/namespace: observability
      default:
        action: Allow
---
# Deny-all fallback — applied after more specific allow rules
apiVersion: kuma.io/v1alpha1
kind: MeshTrafficPermission
metadata:
  name: deny-all
  namespace: kuma-system
  labels:
    kuma.io/mesh: production
spec:
  targetRef:
    kind: Mesh
    name: production
  from:
    - targetRef:
        kind: Mesh
        name: production
      default:
        action: Deny
```

## Traffic Management Policies

### MeshHTTPRoute

```yaml
# Canary deployment: send 10% of traffic to v2
apiVersion: gateway.networking.k8s.io/v1
kind: MeshHTTPRoute
metadata:
  name: api-canary
  namespace: production
  labels:
    kuma.io/mesh: production
spec:
  targetRef:
    kind: MeshService
    name: api_production_svc_8080
  to:
    - targetRef:
        kind: MeshService
        name: api_production_svc_8080
      rules:
        - matches:
            - path:
                type: PathPrefix
                value: /
          default:
            backendRefs:
              - kind: MeshServiceSubset
                name: api_production_svc_8080
                tags:
                  version: v1
                weight: 90
              - kind: MeshServiceSubset
                name: api_production_svc_8080
                tags:
                  version: v2
                weight: 10
---
# Header-based routing for internal beta testing
apiVersion: gateway.networking.k8s.io/v1
kind: MeshHTTPRoute
metadata:
  name: api-header-route
  namespace: production
  labels:
    kuma.io/mesh: production
spec:
  targetRef:
    kind: MeshService
    name: api_production_svc_8080
  to:
    - targetRef:
        kind: MeshService
        name: api_production_svc_8080
      rules:
        - matches:
            - headers:
                - name: X-Beta-User
                  type: Exact
                  value: "true"
          default:
            backendRefs:
              - kind: MeshServiceSubset
                name: api_production_svc_8080
                tags:
                  version: v2
                weight: 100
        - matches:
            - path:
                type: PathPrefix
                value: /
          default:
            backendRefs:
              - kind: MeshServiceSubset
                name: api_production_svc_8080
                tags:
                  version: v1
                weight: 100
```

### MeshRetry

```yaml
apiVersion: kuma.io/v1alpha1
kind: MeshRetry
metadata:
  name: api-retry-policy
  namespace: kuma-system
  labels:
    kuma.io/mesh: production
spec:
  targetRef:
    kind: MeshService
    name: api_production_svc_8080
  to:
    - targetRef:
        kind: MeshService
        name: api_production_svc_8080
      default:
        http:
          numRetries: 3
          perTryTimeout: 5s
          retryOn:
            - "5xx"
            - "retriable-4xx"
            - "reset"
            - "connect-failure"
          retriableRequestHeaders:
            - name: X-Retry-Allowed
              value:
                type: Exact
                value: "true"
        tcp:
          maxConnectAttempts: 3
```

### MeshTimeout

```yaml
apiVersion: kuma.io/v1alpha1
kind: MeshTimeout
metadata:
  name: api-timeouts
  namespace: kuma-system
  labels:
    kuma.io/mesh: production
spec:
  targetRef:
    kind: MeshService
    name: api_production_svc_8080
  to:
    - targetRef:
        kind: MeshService
        name: api_production_svc_8080
      default:
        connectionTimeout: 5s
        idleTimeout: 1h
        http:
          requestTimeout: 30s
          streamIdleTimeout: 5m
          maxStreamDuration: 0s
---
# Tighter timeouts for downstream database queries
apiVersion: kuma.io/v1alpha1
kind: MeshTimeout
metadata:
  name: db-timeouts
  namespace: kuma-system
  labels:
    kuma.io/mesh: production
spec:
  targetRef:
    kind: MeshService
    name: postgres_production_svc_5432
  from:
    - targetRef:
        kind: MeshService
        name: api_production_svc_8080
      default:
        connectionTimeout: 3s
        idleTimeout: 10m
        http:
          requestTimeout: 10s
```

### MeshCircuitBreaker

```yaml
apiVersion: kuma.io/v1alpha1
kind: MeshCircuitBreaker
metadata:
  name: api-circuit-breaker
  namespace: kuma-system
  labels:
    kuma.io/mesh: production
spec:
  targetRef:
    kind: MeshService
    name: api_production_svc_8080
  to:
    - targetRef:
        kind: MeshService
        name: api_production_svc_8080
      default:
        connectionLimits:
          maxConnections: 1024
          maxPendingRequests: 512
          maxRetries: 3
          maxRequests: 1024
        outlierDetection:
          disabled: false
          interval: 10s
          baseEjectionTime: 30s
          maxEjectionPercent: 50
          splitExternalAndLocalErrors: true
          consecutive5xx: 5
          consecutiveGatewayFailures: 5
          successRateMinimumHosts: 5
          successRateRequestVolume: 100
          successRateStdevFactor: 1900
```

## Observability: MeshMetric and MeshTrace

### MeshMetric

```yaml
apiVersion: kuma.io/v1alpha1
kind: MeshMetric
metadata:
  name: production-metrics
  namespace: kuma-system
  labels:
    kuma.io/mesh: production
spec:
  targetRef:
    kind: Mesh
    name: production
  default:
    skipMTLS: false
    port: 5670
    path: /metrics
    backends:
      - type: Prometheus
        prometheus:
          clientId: main-prometheus
          port: 5670
          path: /metrics
          tls:
            mode: ProvidedTLS
```

Create the corresponding ServiceMonitor:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: kuma-dataplanes
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
spec:
  namespaceSelector:
    any: true
  selector:
    matchLabels:
      kuma.io/service: ""
  endpoints:
    - port: "5670"
      path: /metrics
      scheme: https
      tlsConfig:
        caFile: /etc/prometheus/secrets/kuma-ca/ca.crt
        certFile: /etc/prometheus/secrets/kuma-client/tls.crt
        keyFile: /etc/prometheus/secrets/kuma-client/tls.key
        insecureSkipVerify: false
      interval: 30s
```

### MeshTrace

```yaml
apiVersion: kuma.io/v1alpha1
kind: MeshTrace
metadata:
  name: production-tracing
  namespace: kuma-system
  labels:
    kuma.io/mesh: production
spec:
  targetRef:
    kind: Mesh
    name: production
  default:
    sampling:
      overall: 100
      random: 100
      client: 100
    tags:
      - name: team
        literal: platform
    backends:
      - type: Zipkin
        zipkin:
          url: http://jaeger-collector.observability.svc.cluster.local:9411/api/v2/spans
          traceId128bit: true
          apiVersion: httpJsonV2
```

## Multi-Zone Deployment

### Install the Global Control Plane

```bash
helm upgrade --install kuma kuma/kuma \
  --namespace kuma-system \
  --set controlPlane.mode=global \
  --set controlPlane.replicas=2 \
  --wait
```

### Install a Zone Control Plane

```bash
# On the zone cluster
helm upgrade --install kuma kuma/kuma \
  --namespace kuma-system \
  --set controlPlane.mode=zone \
  --set controlPlane.zone=us-east-1 \
  --set "kds.global.address=grpcs://global-kuma.example.com:5685" \
  --set ingress.enabled=true \
  --set egress.enabled=true \
  --wait
```

### Zone Ingress and Egress Configuration

```yaml
# ZoneIngress — receives traffic from other zones
apiVersion: kuma.io/v1alpha1
kind: ZoneIngress
metadata:
  name: us-east-1-ingress
  namespace: kuma-system
spec:
  zone: us-east-1
  networking:
    port: 10001
    advertisedAddress: zone-ingress.us-east-1.example.com
    advertisedPort: 10001
---
# ZoneEgress — sends traffic to other zones
# This is a built-in DaemonSet; configure via Helm values:
# egress.enabled=true
# egress.resources.requests.cpu=50m
# egress.resources.requests.memory=64Mi
```

Cross-zone traffic uses mTLS end-to-end. The global control plane distributes zone certificates; the zone ingress and egress proxies handle cross-zone encryption transparently.

## Kuma GUI

Kuma ships a built-in GUI that provides a live topology view, data plane health status, and policy inspection. Expose it through an Ingress for team-wide access:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: kuma-gui
  namespace: kuma-system
  annotations:
    nginx.ingress.kubernetes.io/auth-type: basic
    nginx.ingress.kubernetes.io/auth-secret: kuma-gui-auth
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - kuma-gui.internal.example.com
      secretName: kuma-gui-tls
  rules:
    - host: kuma-gui.internal.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: kuma-control-plane
                port:
                  number: 5681
```

Access the GUI directly during development:

```bash
kubectl port-forward svc/kuma-control-plane \
  -n kuma-system 5681:5681

# Open http://localhost:5681/gui
```

## Comparison with Istio for Smaller Teams

| Dimension | Kuma | Istio |
|---|---|---|
| Installation complexity | Single Helm chart, ~2 min | Multiple components, 5–15 min |
| Policy CRD count | ~15 focused CRDs | 30+ CRDs |
| Resource overhead per pod | ~50 MB (Envoy sidecar) | ~100–150 MB (Envoy + pilot-agent) |
| Universal (VM) support | First-class, same control plane | Requires additional configuration |
| Multi-cluster | Built-in multi-zone mode | Istio multi-cluster (more complex) |
| GUI | Built-in, no extra install | Kiali (separate install) |
| Learning curve | Lower — fewer abstractions | Higher — many interacting resources |
| Ecosystem maturity | Growing, CNCF graduated | Mature, large ecosystem |
| WASM extensions | Supported via Envoy | Supported via EnvoyFilter |

Kuma is particularly compelling for teams that need service mesh across both Kubernetes and legacy VMs without running two separate mesh solutions. For pure Kubernetes environments with teams already experienced in Istio, the migration cost may not justify the switch.

## Day-2 Operations

### Inspecting Data Plane Health

```bash
# List all data planes across all meshes
kumactl get dataplanes --mesh production

# Get detailed status of a specific data plane
kumactl get dataplane frontend-abc123-xyz \
  --mesh production \
  -o yaml

# Check which policies apply to a data plane
kumactl inspect dataplane frontend-abc123-xyz \
  --mesh production \
  --type=policies
```

### Certificate Rotation

Kuma rotates data plane certificates automatically based on the `dpCert.rotation.expiration` setting in the Mesh resource. The control plane monitors certificate expiry and triggers rotation before expiry. Monitor rotation events:

```bash
# Check certificate expiry for all data planes
kumactl get dataplanes --mesh production \
  -o json | jq -r '.items[] |
    "\(.name): expires \(.status.mTLS.certificateExpirationTime)"'

# Force immediate rotation
kumactl rotate-dataplane-certs \
  --mesh production \
  --selector app=frontend
```

### Policy Inspection and Debugging

```bash
# View the Envoy configuration pushed to a data plane (for debugging)
kumactl inspect dataplane frontend-abc123-xyz \
  --mesh production \
  --type=config \
  --shadow=false > /tmp/envoy-config.json

# Check effective traffic permissions
kumactl inspect dataplane api-xyz \
  --mesh production \
  --type=policies | jq '.policies.MeshTrafficPermission'

# Watch data plane connection events in real time
kubectl -n kuma-system logs \
  -l app=kuma-control-plane \
  --follow | grep "dataplane connected"
```

### Upgrading Kuma

```bash
# Review the changelog before upgrading
helm search repo kuma/kuma --versions | head -5

# Upgrade the control plane — data planes continue running
helm upgrade kuma kuma/kuma \
  --namespace kuma-system \
  --version 2.8.0 \
  --reuse-values \
  --wait

# Roll out new sidecar version by restarting pods gradually
kubectl -n production rollout restart deployment/frontend
kubectl -n production rollout status deployment/frontend

# Verify all data planes reconnected
kumactl get dataplanes --mesh production | grep -v Online
```

Data plane upgrades are rolling — each pod restart picks up the new sidecar image. No traffic interruption is required if pods are running with multiple replicas and appropriate PodDisruptionBudgets.

Kuma occupies an important niche in the service mesh landscape: a platform-team-friendly, operationally approachable mesh that does not sacrifice the core capabilities required for production-grade service communication. Its universal deployment model and built-in multi-zone federation make it the strongest choice when the environment spans Kubernetes and non-containerised workloads simultaneously.
