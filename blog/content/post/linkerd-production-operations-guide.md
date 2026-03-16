---
title: "Linkerd Production Operations: mTLS, Traffic Policies, and Observability"
date: 2027-07-01T00:00:00-05:00
draft: false
tags: ["Linkerd", "Service Mesh", "Kubernetes", "mTLS", "Observability", "Performance"]
categories:
- Kubernetes
- Service Mesh
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive production guide to Linkerd: Rust micro-proxy architecture, automatic mTLS, ServiceProfile for per-route metrics, HTTPRoute traffic splitting for canary deployments, Server/ServerAuthorization policy, and multicluster service mirroring."
more_link: "yes"
url: "/linkerd-production-operations-guide/"
---

Linkerd offers a compelling alternative to Istio for teams that prioritize operational simplicity, low resource overhead, and transparent default-secure behavior. Built with a Rust micro-proxy (the linkerd2-proxy) instead of Envoy, Linkerd's data plane consumes significantly less CPU and memory per pod while providing the core service mesh primitives: automatic mTLS with SPIFFE identities, per-route metrics, traffic splitting for canary deployments, retry and timeout policies, and server-side access control. This guide covers Linkerd's architecture, installation, security model, traffic policies, multicluster connectivity, and common production edge cases including gRPC and WebSocket handling.

<!--more-->

## Linkerd Architecture

### Control Plane Components

**destination** is the most critical control plane service. Proxies query destination via gRPC to resolve service endpoints, load balancing weights, and traffic policies. Destination watches Kubernetes Services, Endpoints, and Linkerd CRDs (ServiceProfile, Server, HTTPRoute) and returns a continuous stream of updates to proxies.

**identity** acts as the certificate authority for the mesh. It issues short-lived X.509 certificates (default TTL: 24 hours) to each proxy using SPIFFE-style identities formatted as `<service-account>.<namespace>.serviceaccount.identity.<trustdomain>`. The identity component itself is bootstrapped with a root trust anchor (typically managed externally via cert-manager for production deployments).

**proxy-injector** is a mutating admission webhook that injects the linkerd2-proxy sidecar and an init container into pods labeled for injection. It reads the `linkerd.io/inject: enabled` annotation at the namespace or pod level.

### Data Plane: The linkerd2-proxy

The linkerd2-proxy is written in Rust using the Tokio async runtime. Key design decisions:

- **Zero-configuration protocol detection**: The proxy automatically detects HTTP/1.1, HTTP/2, and gRPC protocols by inspecting the first bytes of a connection. Non-HTTP TCP traffic is proxied transparently but without L7 features.
- **Transparent proxying via iptables**: An init container installs iptables rules that redirect all inbound and outbound traffic through the proxy ports (4143 inbound, 4140 outbound).
- **SPIFFE mTLS**: Every connection between two injected proxies is automatically encrypted with mTLS using certificates from the identity component. No configuration is required.
- **Resource efficiency**: A typical linkerd2-proxy instance under moderate load consumes 10-30m CPU and 25-50Mi memory, compared to 100m+ CPU for Envoy in a similar scenario.

---

## Installation

### Installing the CLI

```bash
curl --proto '=https' --tlsv1.2 -sSfL https://run.linkerd.io/install | sh
export PATH=$PATH:$HOME/.linkerd2/bin
linkerd version
```

### Production Trust Anchor with cert-manager

For production deployments, the trust anchor (root CA) must be external to Linkerd so it can survive control plane reinstallation without rotating the root certificate across all proxies.

```bash
# Install cert-manager if not already present
helm upgrade --install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --set installCRDs=true

# Create the Linkerd trust anchor issuer
kubectl apply -f - <<'EOF'
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: linkerd-trust-anchor
spec:
  selfSigned: {}

---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: linkerd-trust-anchor
  namespace: cert-manager
spec:
  isCA: true
  commonName: root.linkerd.cluster.local
  secretName: linkerd-trust-anchor
  privateKey:
    algorithm: ECDSA
    size: 256
  issuerRef:
    name: linkerd-trust-anchor
    kind: ClusterIssuer
  duration: 87600h    # 10 years - root CA
  renewBefore: 8760h
EOF
```

```bash
# Create the issuer in the linkerd namespace
kubectl create namespace linkerd

kubectl apply -f - <<'EOF'
apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: linkerd-identity-issuer
  namespace: linkerd
spec:
  ca:
    secretName: linkerd-trust-anchor

---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: linkerd-identity-issuer
  namespace: linkerd
spec:
  isCA: true
  commonName: identity.linkerd.cluster.local
  secretName: linkerd-identity-issuer
  issuerRef:
    name: linkerd-identity-issuer
    kind: Issuer
  duration: 8760h    # 1 year - intermediate CA
  renewBefore: 720h  # Renew 30 days before expiry
  dnsNames:
    - identity.linkerd.cluster.local
  privateKey:
    algorithm: ECDSA
    size: 256
EOF
```

### Helm Installation with External Trust Anchor

```bash
helm repo add linkerd https://helm.linkerd.io/stable
helm repo update

# Get the trust anchor certificate
export TRUST_ANCHOR=$(kubectl -n cert-manager \
  get secret linkerd-trust-anchor \
  -o jsonpath='{.data.tls\.crt}' | base64 -d)

helm install linkerd-crds linkerd/linkerd-crds \
  --namespace linkerd \
  --create-namespace

helm install linkerd-control-plane linkerd/linkerd-control-plane \
  --namespace linkerd \
  --set-file identityTrustAnchorsPEM=<(echo "${TRUST_ANCHOR}") \
  --set identity.issuer.scheme=kubernetes.io/tls \
  --values linkerd-values.yaml
```

### Production Values

```yaml
# linkerd-values.yaml
controllerReplicas: 3
controllerLogLevel: info
controllerResources:
  cpu:
    request: 100m
    limit: "1"
  memory:
    request: 50Mi
    limit: 512Mi

destinationResources:
  cpu:
    request: 100m
    limit: "1"
  memory:
    request: 50Mi
    limit: 512Mi

identityResources:
  cpu:
    request: 100m
    limit: "1"
  memory:
    request: 10Mi
    limit: 256Mi

proxy:
  resources:
    cpu:
      request: 10m
      limit: "1"
    memory:
      request: 20Mi
      limit: 250Mi
  logLevel: warn,linkerd=info
  image:
    version: stable-2.14.10

proxyInit:
  resources:
    cpu:
      request: 10m
      limit: 100m
    memory:
      request: 10Mi
      limit: 50Mi

enableH2Upgrade: true
disableHeartBeat: false

podAnnotations:
  cluster-autoscaler.kubernetes.io/safe-to-evict: "true"

priorityClassName: system-cluster-critical
```

### Verify Installation

```bash
linkerd check
linkerd check --proxy   # After injecting workloads
```

---

## Enabling mTLS: Namespace and Pod Injection

### Namespace-Level Injection

```bash
# Enable Linkerd injection for a namespace
kubectl annotate namespace production \
  linkerd.io/inject=enabled

# Restart all deployments to inject the proxy
kubectl rollout restart deployment -n production
```

### Verifying mTLS is Active

```bash
# Show proxy status including TLS for all pods in namespace
linkerd viz stat pod -n production

# Check a specific deployment
linkerd viz stat deploy/checkout -n production

# Verify mTLS is active for a specific connection
linkerd viz tap deploy/frontend -n production \
  | grep -E "(tls|secure)"
```

Expected output from `linkerd viz stat`:

```
NAME              MESHED  SUCCESS   RPS   LATENCY_P50   LATENCY_P95   LATENCY_P99   TCP_CONN
checkout          2/2     99.97%    42.3  4ms           18ms          45ms          8
payment           3/3     99.95%    18.1  12ms          55ms          120ms         6
```

---

## ServiceProfile: Per-Route Metrics and Retry Policy

ServiceProfile is Linkerd's primary mechanism for configuring per-route behavior: retries, timeouts, and metric labeling.

### Basic ServiceProfile

```yaml
apiVersion: linkerd.io/v1alpha2
kind: ServiceProfile
metadata:
  name: payment-service.production.svc.cluster.local
  namespace: production
spec:
  routes:
    - name: POST /api/v1/charge
      condition:
        method: POST
        pathRegex: /api/v1/charge
      timeout: 30s
      isRetryable: false    # Payment charges must not be retried

    - name: GET /api/v1/status/{id}
      condition:
        method: GET
        pathRegex: /api/v1/status/[^/]*
      timeout: 5s
      isRetryable: true     # Read operations are safe to retry

    - name: GET /api/v1/transactions
      condition:
        method: GET
        pathRegex: /api/v1/transactions
      timeout: 15s
      isRetryable: true
      retryBudget:
        retryRatio: 0.2        # Allow up to 20% of requests to be retries
        minRetriesPerSecond: 5 # Always allow at least 5 retries/sec
        ttl: 10s               # Cache retry budget window
```

### Generating ServiceProfile from OpenAPI Spec

If the service exposes an OpenAPI spec, generate the ServiceProfile automatically:

```bash
# From a running service
linkerd profile --open-api /path/to/openapi.yaml \
  payment-service.production.svc.cluster.local \
  -n production \
  | kubectl apply -f -

# From the cluster (fetches spec from the service)
linkerd profile --template \
  --name payment-service.production.svc.cluster.local \
  -n production
```

### Per-Route Metrics with Linkerd Viz

Once a ServiceProfile is applied, route-level metrics become available:

```bash
# Show per-route success rates and latency
linkerd viz routes deploy/checkout -n production

# Output:
# ROUTE                        SERVICE   SUCCESS     RPS   LATENCY_P50   LATENCY_P95
# POST /api/v1/charge          payment   99.95%    12.3          45ms         120ms
# GET /api/v1/status/{id}      payment   100.0%    22.1           4ms          12ms
# GET /api/v1/transactions     payment   99.80%     7.9          18ms          55ms
# [DEFAULT]                    payment   100.0%     0.1           2ms           3ms

# Observe live route traffic
linkerd viz routes deploy/checkout -n production --watch
```

---

## HTTPRoute: Traffic Splitting for Canary Deployments

HTTPRoute (from the Kubernetes Gateway API, supported in Linkerd 2.13+) replaces the older TrafficSplit resource for canary deployments.

### Canary Deployment Setup

```yaml
# Deploy two versions of the service
# checkout-v1: existing stable version
# checkout-v2: new canary version (separate Deployment, same Service selector variant)

apiVersion: policy.linkerd.io/v1beta3
kind: HTTPRoute
metadata:
  name: checkout-canary
  namespace: production
spec:
  parentRefs:
    - name: checkout
      kind: Service
      group: core
      port: 8080
  rules:
    - backendRefs:
        - name: checkout-v1
          port: 8080
          weight: 90
        - name: checkout-v2
          port: 8080
          weight: 10
```

Progressive rollout - update weights incrementally:

```bash
# Progress to 50/50
kubectl patch httproute checkout-canary -n production \
  --type json \
  -p '[
    {"op": "replace", "path": "/spec/rules/0/backendRefs/0/weight", "value": 50},
    {"op": "replace", "path": "/spec/rules/0/backendRefs/1/weight", "value": 50}
  ]'

# Monitor metrics for both versions during rollout
linkerd viz stat deploy/checkout-v2 -n production --watch

# Full cutover
kubectl patch httproute checkout-canary -n production \
  --type json \
  -p '[
    {"op": "replace", "path": "/spec/rules/0/backendRefs/0/weight", "value": 0},
    {"op": "replace", "path": "/spec/rules/0/backendRefs/1/weight", "value": 100}
  ]'
```

### Header-Based Routing

```yaml
apiVersion: policy.linkerd.io/v1beta3
kind: HTTPRoute
metadata:
  name: checkout-header-route
  namespace: production
spec:
  parentRefs:
    - name: checkout
      kind: Service
      group: core
      port: 8080
  rules:
    # Route canary header requests to v2
    - matches:
        - headers:
            - name: x-canary
              value: "true"
      backendRefs:
        - name: checkout-v2
          port: 8080
          weight: 100
    # All other traffic to v1
    - backendRefs:
        - name: checkout-v1
          port: 8080
          weight: 100
```

---

## Server and ServerAuthorization: Access Policy

### Server Resource

A Server defines an opaque port or protocol-aware port on a set of pods. Servers are the attachment point for AuthorizationPolicy.

```yaml
apiVersion: policy.linkerd.io/v1beta3
kind: Server
metadata:
  name: payment-grpc
  namespace: production
spec:
  selector:
    matchLabels:
      app: payment-service
  port:
    name: grpc
  proxyProtocol: gRPC       # Options: unknown, HTTP/1, HTTP/2, gRPC, opaque, TLS
```

### AuthorizationPolicy and MeshTLSAuthentication

```yaml
# Allow only meshed (mTLS) connections from specific service accounts
apiVersion: policy.linkerd.io/v1beta3
kind: MeshTLSAuthentication
metadata:
  name: checkout-can-call-payment
  namespace: production
spec:
  identities:
    - "checkout.production.serviceaccount.identity.linkerd.cluster.local"

---
apiVersion: policy.linkerd.io/v1beta3
kind: AuthorizationPolicy
metadata:
  name: payment-grpc-access
  namespace: production
spec:
  targetRef:
    group: policy.linkerd.io
    kind: Server
    name: payment-grpc
  requiredAuthenticationRefs:
    - name: checkout-can-call-payment
      kind: MeshTLSAuthentication
      group: policy.linkerd.io
```

### NetworkAuthentication for Non-Mesh Sources

When an external client (outside the mesh) needs to reach a meshed service:

```yaml
apiVersion: policy.linkerd.io/v1beta3
kind: NetworkAuthentication
metadata:
  name: allow-from-monitoring
  namespace: production
spec:
  networks:
    - cidr: "10.100.0.0/24"    # Prometheus scrape subnet
      except:
        - "10.100.0.1/32"

---
apiVersion: policy.linkerd.io/v1beta3
kind: AuthorizationPolicy
metadata:
  name: payment-metrics-access
  namespace: production
spec:
  targetRef:
    group: policy.linkerd.io
    kind: Server
    name: payment-metrics
  requiredAuthenticationRefs:
    - name: allow-from-monitoring
      kind: NetworkAuthentication
      group: policy.linkerd.io
```

### Default Policy (Deny Unauthenticated Access)

Set cluster-wide default policy to deny unauthenticated connections:

```bash
helm upgrade linkerd-control-plane linkerd/linkerd-control-plane \
  --namespace linkerd \
  --set policyController.defaultAllowPolicy=deny \
  --reuse-values
```

With this setting, all traffic to Servers without an AuthorizationPolicy is denied. Unannotated services (without Server resources) are still accessible; Server resources opt ports into policy enforcement.

---

## Linkerd Viz: Dashboard, Tap, and Metrics

### Installing Linkerd Viz

```bash
helm install linkerd-viz linkerd/linkerd-viz \
  --namespace linkerd-viz \
  --create-namespace \
  --values linkerd-viz-values.yaml
```

```yaml
# linkerd-viz-values.yaml
dashboard:
  replicas: 2
  resources:
    cpu:
      request: 10m
      limit: 250m
    memory:
      request: 10Mi
      limit: 250Mi

tap:
  replicas: 1
  resources:
    cpu:
      request: 10m
      limit: 250m
    memory:
      request: 50Mi
      limit: 250Mi

prometheus:
  enabled: false    # Use external Prometheus

prometheusUrl: http://prometheus-operated.monitoring.svc.cluster.local:9090

metricsAPI:
  resources:
    cpu:
      request: 10m
      limit: 250m
    memory:
      request: 50Mi
      limit: 250Mi
```

### Accessing the Dashboard

```bash
linkerd viz dashboard &
```

### Tap: Real-Time Traffic Inspection

```bash
# Tap all traffic to the payment service
linkerd viz tap deploy/payment -n production

# Tap with filters
linkerd viz tap deploy/checkout -n production \
  --to deploy/payment \
  --method POST \
  --path /api/v1/charge

# Example output:
# req id=0:1 proxy=out src=10.244.3.12:48234 dst=10.244.5.8:8080 \
#   tls=true :method=POST :authority=payment.production.svc.cluster.local \
#   :path=/api/v1/charge
# rsp id=0:1 proxy=out src=10.244.3.12:48234 dst=10.244.5.8:8080 \
#   tls=true :status=200 latency=142ms
```

### Grafana Integration

Linkerd ships pre-built Grafana dashboards. Import them when using an external Grafana:

```bash
# Export dashboard JSON files
linkerd viz install --ignore-cluster \
  | yq e 'select(.kind=="ConfigMap" and .metadata.name=="grafana-dashboard-*")' \
  | kubectl apply -n monitoring -f -
```

Key Linkerd Grafana dashboards:
- **Linkerd Top Line**: Cluster-wide success rate, RPS, and latency
- **Linkerd Deployment**: Per-deployment golden signals
- **Linkerd Route**: Per-route metrics from ServiceProfile
- **Linkerd Health**: Control plane component health

---

## Multicluster: Service Mirroring

Linkerd's multicluster extension connects clusters through a service mirroring model. Services exported from a remote cluster appear as local Services in the local cluster, with cross-cluster traffic automatically secured by mTLS between the gateway proxies.

### Installing Multicluster Extension

```bash
# Install on both clusters
helm install linkerd-multicluster linkerd/linkerd-multicluster \
  --namespace linkerd-multicluster \
  --create-namespace

linkerd multicluster check
```

### Linking Clusters

```bash
# Generate the credentials from the east cluster
linkerd multicluster link \
  --cluster-name east \
  --context east-cluster \
  | kubectl apply -f - --context west-cluster

# Verify the link
linkerd multicluster check --context west-cluster
linkerd multicluster gateways --context west-cluster
```

### Exporting Services

Services must be labeled for export in the source cluster:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: payment-service
  namespace: production
  labels:
    mirror.linkerd.io/exported: "true"
spec:
  selector:
    app: payment
  ports:
    - port: 8080
      targetPort: 8080
```

In the destination cluster, a mirrored service appears automatically:

```bash
kubectl get svc -n production --context west-cluster \
  | grep payment
# payment-service-east    ClusterIP    10.96.45.12    ...    8080/TCP
```

### Failover with HTTPRoute

Combine multicluster with HTTPRoute for cross-cluster failover:

```yaml
apiVersion: policy.linkerd.io/v1beta3
kind: HTTPRoute
metadata:
  name: payment-failover
  namespace: production
spec:
  parentRefs:
    - name: payment-service
      kind: Service
      group: core
      port: 8080
  rules:
    - backendRefs:
        # Primary: local cluster
        - name: payment-service
          port: 8080
          weight: 100
        # Failover: east cluster mirror
        - name: payment-service-east
          port: 8080
          weight: 0    # Only used when local becomes unavailable
```

---

## Edge Cases: gRPC and WebSocket

### gRPC Load Balancing

HTTP/2 multiplexes multiple requests over a single connection. Without per-request load balancing, a single gRPC connection would sticky to one upstream pod. Linkerd handles this correctly: it uses the Kubernetes Endpoint API to discover upstream pods and load balances individual gRPC requests across them using exponentially weighted moving average (EWMA) load balancing.

Verify gRPC is being load balanced:

```bash
# gRPC requests should show tls=true and the protocol auto-detected
linkerd viz tap deploy/checkout -n production \
  --to deploy/payment \
  | grep -E "(grpc|proto)"
```

No additional configuration is required for gRPC if the service port is named `grpc` or `h2` in the Kubernetes Service:

```yaml
spec:
  ports:
    - name: grpc       # Linkerd detects this as gRPC
      port: 50051
      targetPort: 50051
```

### WebSocket Handling

WebSocket connections begin as HTTP/1.1 Upgrade requests, then transition to a bidirectional TCP tunnel. Linkerd handles WebSocket transparently in opaque mode after the upgrade:

- The initial HTTP handshake is proxied at L7.
- After the `101 Switching Protocols` response, the connection becomes opaque TCP.
- mTLS remains active for the duration of the WebSocket connection.
- Load balancing applies only at connection establishment, not per-message.

No special configuration is required for WebSocket support.

### Excluding Ports from Proxying

Some traffic should bypass the Linkerd proxy entirely (e.g., node-local agents, direct database connections that cannot tolerate proxy overhead):

```yaml
apiVersion: v1
kind: Pod
metadata:
  annotations:
    config.linkerd.io/skip-outbound-ports: "3306,5432"  # Skip DB ports
    config.linkerd.io/skip-inbound-ports: "9100"        # Skip node exporter
```

---

## Upgrade Procedures

### CLI and Control Plane Upgrade

```bash
# Download new CLI version
curl --proto '=https' --tlsv1.2 -sSfL https://run.linkerd.io/install \
  | LINKERD2_VERSION=stable-2.15.0 sh -

# Pre-upgrade check
linkerd check --pre

# Upgrade CRDs first
helm upgrade linkerd-crds linkerd/linkerd-crds \
  --namespace linkerd \
  --version 2.15.0

# Upgrade control plane
helm upgrade linkerd-control-plane linkerd/linkerd-control-plane \
  --namespace linkerd \
  --version 2.15.0 \
  --reuse-values

# Verify control plane
linkerd check

# Upgrade Viz extension
helm upgrade linkerd-viz linkerd/linkerd-viz \
  --namespace linkerd-viz \
  --version 2.15.0 \
  --reuse-values
```

### Proxy Upgrade (Data Plane)

After upgrading the control plane, restart workloads to update sidecar proxy versions:

```bash
# Check which deployments are running outdated proxies
linkerd check --proxy

# Rolling restart all deployments in a namespace
kubectl rollout restart deployment -n production

# Monitor proxy versions
linkerd viz stat deploy -n production \
  | awk '{print $1, $2}'
```

The control plane maintains backward compatibility with N-2 proxy versions, so an in-place rolling restart is safe.

---

## Production Checklist

### Security
- Deploy with cert-manager-managed trust anchor (external to Linkerd).
- Set `policyController.defaultAllowPolicy=deny` for zero-trust posture.
- Define Server and AuthorizationPolicy for all services receiving traffic.
- Use MeshTLSAuthentication (not NetworkAuthentication) for in-mesh communication.
- Monitor certificate expiry with `linkerd check --proxy` in CI/CD.

### Performance
- Set proxy resource requests/limits based on actual traffic profiles.
- Reduce proxy log level to `warn` in production.
- Use `config.linkerd.io/skip-outbound-ports` for latency-sensitive non-HTTP connections.
- Deploy Viz with external Prometheus (not the bundled instance) for production scale.

### Reliability
- Run control plane components with `controllerReplicas: 3` for HA.
- Set `priorityClassName: system-cluster-critical` on control plane components.
- Configure PodDisruptionBudgets for control plane deployments.
- Test certificate rotation annually using cert-manager rotation triggers.

### Observability
- Configure ServiceProfile for all services with defined routes.
- Import Linkerd Grafana dashboards into the shared Grafana instance.
- Alert on success rate dropping below SLO for any deployment.
- Alert on P99 latency exceeding SLO thresholds.

---

## Summary

Linkerd's Rust micro-proxy delivers a fundamentally lower resource overhead than Envoy-based meshes, making it well-suited for clusters where proxy resource costs are a concern or where workload density is high. Automatic mTLS with zero-configuration certificate rotation eliminates a common operational burden. ServiceProfile provides the mechanism for per-route retry policies and metrics without requiring application code changes. The Server/AuthorizationPolicy model delivers a clean, enforceable access control layer. For teams that have been deterred by Istio's operational complexity, Linkerd offers a gradual on-ramp: start with injection and mTLS, add ServiceProfiles and AuthorizationPolicies incrementally, and adopt multicluster connectivity when cross-cluster requirements emerge.
