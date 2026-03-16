---
title: "Istio Ambient Mesh: Sidecar-Free Service Mesh for Kubernetes"
date: 2027-02-19T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Istio", "Service Mesh", "Ambient Mesh", "Networking"]
categories: ["Kubernetes", "Networking", "Service Mesh"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Istio Ambient Mesh, the sidecar-free architecture using ztunnel for L4 security and waypoint proxies for L7 traffic management, including installation, namespace enrollment, AuthorizationPolicy, HTTPRoute, migration from sidecar mode, and resource overhead comparison."
more_link: "yes"
url: "/istio-ambient-mesh-sidecarless-kubernetes-guide/"
---

Istio **Ambient Mesh** reached stable status in Istio 1.22 and resolves the two most common criticisms of the traditional sidecar model: operational complexity from per-pod injection and the CPU/memory overhead of running an Envoy proxy in every pod. Ambient mode separates the data plane into a **ztunnel** layer that handles Layer 4 mTLS and telemetry on each node, and an optional **waypoint proxy** layer that handles Layer 7 traffic management per namespace or service account. Applications enroll by labeling their namespace — no pod restarts, no annotations, no injection webhooks. This guide covers the full ambient stack from architecture through production hardening.

<!--more-->

## Architecture: Two Layers, No Sidecars

### Sidecar Mode vs. Ambient Mode

**Sidecar mode** (traditional):
```
Pod
 ├── App Container
 └── Envoy Sidecar (intercepts ALL traffic, L4 + L7)
      • ~50m CPU / ~50Mi memory per pod at idle
      • requires restart for injection
      • injection webhook adds latency to pod startup
```

**Ambient mode:**
```
Node
 └── ztunnel DaemonSet (L4 — one per node, shared by all pods on that node)
      • ~20m CPU / ~64Mi memory per node (not per pod)
      • no pod restart required for enrollment
      • enrolls by namespace label

Namespace (opt-in)
 └── Waypoint Proxy Deployment (L7 — one per namespace or service account)
      • only deployed when L7 features are needed
      • can be shared across many services
```

### Data Plane Components

**ztunnel (zero-trust tunnel)** runs as a DaemonSet. It:
- Intercepts pod traffic using eBPF and the HBONE (HTTP-Based Overlay Network Environment) tunneling protocol
- Terminates and initiates mTLS connections using SPIFFE certificates issued by istiod
- Reports L4 telemetry: byte counts, connection counts, connection duration
- Enforces L4 `AuthorizationPolicy` rules

**Waypoint Proxy** is a standalone Envoy proxy deployment:
- One waypoint per namespace (or per service account for fine-grained control)
- Handles all L7 concerns: HTTP routing, retries, circuit breaking, header manipulation, JWT validation
- Enforces L7 `AuthorizationPolicy` and `HTTPRoute` rules
- Reports full HTTP telemetry: request rates, latency histograms, error rates

**istiod** remains the control plane for both layers:
- Issues SPIFFE X.509 certificates to ztunnel and waypoint proxies
- Distributes xDS configuration to waypoint proxies
- Maintains the service registry

## Installation

### Installing Istio with the Ambient Profile

```bash
#!/bin/bash
set -euo pipefail

ISTIO_VERSION="1.22.0"

# Download the Istio CLI
curl -L https://istio.io/downloadIstio | ISTIO_VERSION="${ISTIO_VERSION}" sh -
export PATH="${PWD}/istio-${ISTIO_VERSION}/bin:${PATH}"

# Install Istio with the ambient profile
# This installs: istiod, ztunnel (DaemonSet), CNI plugin
istioctl install --set profile=ambient --set "values.cni.ambient.enabled=true" -y

# Verify installation
istioctl verify-install

kubectl get pods -n istio-system
kubectl get daemonset ztunnel -n istio-system
```

Helm-based installation for GitOps pipelines:

```bash
#!/bin/bash
set -euo pipefail

ISTIO_VERSION="1.22.0"

helm repo add istio https://istio-release.storage.googleapis.com/charts
helm repo update

# Install Istio base (CRDs)
helm upgrade --install istio-base istio/base \
  --namespace istio-system \
  --create-namespace \
  --version "${ISTIO_VERSION}" \
  --set defaultRevision=default \
  --wait

# Install istiod
helm upgrade --install istiod istio/istiod \
  --namespace istio-system \
  --version "${ISTIO_VERSION}" \
  --set profile=ambient \
  --set pilot.resources.requests.cpu=500m \
  --set pilot.resources.requests.memory=2Gi \
  --set pilot.resources.limits.cpu=2000m \
  --set pilot.resources.limits.memory=4Gi \
  --set pilot.autoscaleMin=2 \
  --set pilot.autoscaleMax=10 \
  --wait

# Install CNI plugin (required for ambient traffic interception)
helm upgrade --install istio-cni istio/cni \
  --namespace istio-system \
  --version "${ISTIO_VERSION}" \
  --set profile=ambient \
  --wait

# Install ztunnel
helm upgrade --install ztunnel istio/ztunnel \
  --namespace istio-system \
  --version "${ISTIO_VERSION}" \
  --set resources.requests.cpu=200m \
  --set resources.requests.memory=512Mi \
  --set resources.limits.cpu=2000m \
  --set resources.limits.memory=1Gi \
  --wait

echo "Ambient mesh installed"
kubectl get pods -n istio-system
```

## Enrolling Namespaces

Enrollment in ambient mode is a single label on the namespace — no pod restart required.

```bash
# Enroll a namespace in ambient mode
kubectl label namespace production istio.io/dataplane-mode=ambient

# Verify enrollment
kubectl get namespace production -o yaml | grep istio

# Check ztunnel has registered the pods
kubectl exec -n istio-system ds/ztunnel -- pilot-agent request GET /debug/ztunnelstate | \
  python3 -m json.tool | grep "name\|namespace" | head -40
```

```yaml
# Namespace with ambient enrollment
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    istio.io/dataplane-mode: ambient
    istio.io/use-waypoint: waypoint   # Route L7 traffic through the waypoint
```

To enroll only specific pods rather than an entire namespace, label individual pods:

```yaml
# Pod-level enrollment (override namespace setting)
apiVersion: v1
kind: Pod
metadata:
  name: order-service-xyz
  namespace: production
  labels:
    # Opt in
    istio.io/dataplane-mode: ambient
    # Or opt out of an enrolled namespace
    # istio.io/dataplane-mode: none
```

## Deploying and Configuring Waypoint Proxies

### Waypoint per Namespace

```bash
# Deploy a waypoint proxy for the production namespace
istioctl waypoint apply --namespace production --enroll-namespace

# Verify the waypoint is running
kubectl get gateway -n production
kubectl get pods -n production -l istio.io/gateway-name=waypoint

# Check waypoint status
istioctl waypoint status --namespace production
```

```yaml
# Explicit Gateway resource for the waypoint proxy
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: waypoint
  namespace: production
  labels:
    istio.io/waypoint-for: namespace
spec:
  gatewayClassName: istio-waypoint
  listeners:
    - name: mesh
      port: 15008
      protocol: HBONE
---
# Custom resource sizing for the waypoint
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
          averageUtilization: 70
```

### Per-Service-Account Waypoint for Fine-Grained Control

```bash
# Deploy a waypoint for a specific service account only
istioctl waypoint apply \
  --namespace production \
  --name payment-waypoint \
  --for serviceaccount \
  --service-account payment-service
```

## L4 Security with AuthorizationPolicy

At L4 (ztunnel level), `AuthorizationPolicy` rules apply to TCP connections identified by SPIFFE identity.

```yaml
# L4 AuthorizationPolicy — allow order-service to reach payment-service
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: allow-order-to-payment
  namespace: production
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: Service
    name: payment-service
  action: ALLOW
  rules:
    - from:
        - source:
            principals:
              - "cluster.local/ns/production/sa/order-service"
      to:
        - operation:
            ports:
              - "8080"
---
# L4 default-deny — deny all traffic to the namespace unless explicitly allowed
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: default-deny
  namespace: production
spec:
  action: DENY
  rules:
    - from:
        - source:
            notPrincipals:
              - "cluster.local/ns/production/sa/*"
              - "cluster.local/ns/istio-system/sa/ztunnel"
```

## L7 Traffic Management with HTTPRoute and AuthorizationPolicy

Once a waypoint proxy is deployed, Kubernetes **Gateway API** `HTTPRoute` resources and L7 `AuthorizationPolicy` rules take effect.

### HTTPRoute for Traffic Management

```yaml
# HTTPRoute — traffic splitting between service versions
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: order-service-route
  namespace: production
spec:
  parentRefs:
    - group: ""
      kind: Service
      name: order-service
      port: 80
  rules:
    # Canary: route requests with X-Canary header to v2
    - matches:
        - headers:
            - name: X-Canary
              value: "true"
      backendRefs:
        - name: order-service-v2
          port: 80
          weight: 100
    # Default: 90% v1, 10% v2
    - backendRefs:
        - name: order-service-v1
          port: 80
          weight: 90
        - name: order-service-v2
          port: 80
          weight: 10
---
# HTTPRoute — retry and timeout policy
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: payment-service-route
  namespace: production
spec:
  parentRefs:
    - group: ""
      kind: Service
      name: payment-service
      port: 8080
  rules:
    - backendRefs:
        - name: payment-service
          port: 8080
      timeouts:
        request: 10s
        backendRequest: 8s
      retry:
        attempts: 3
        perTryTimeout: 3s
        retryOn: "5xx,gateway-error,reset"
---
# HTTPRoute — path-based routing
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-gateway-route
  namespace: production
spec:
  parentRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: external-gateway
      namespace: istio-ingress
  hostnames:
    - "api.example.com"
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api/orders
      backendRefs:
        - name: order-service
          port: 80
          weight: 100
    - matches:
        - path:
            type: PathPrefix
            value: /api/payments
      backendRefs:
        - name: payment-service
          port: 8080
          weight: 100
    - matches:
        - path:
            type: PathPrefix
            value: /api/inventory
      backendRefs:
        - name: inventory-service
          port: 80
          weight: 100
```

### L7 AuthorizationPolicy with JWT Validation

```yaml
# L7 AuthorizationPolicy — allow only authenticated requests to payment-service
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: payment-service-authz
  namespace: production
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: Service
    name: payment-service
  action: ALLOW
  rules:
    # Service-to-service: allow order-service
    - from:
        - source:
            principals:
              - "cluster.local/ns/production/sa/order-service"
      to:
        - operation:
            methods: ["POST"]
            paths: ["/payments/process", "/payments/refund"]
    # User-facing: require JWT with payments:write scope
    - from:
        - source:
            requestPrincipals:
              - "https://auth.example.com/*"
      to:
        - operation:
            methods: ["GET"]
            paths: ["/payments/status/*"]
      when:
        - key: "request.auth.claims[scope]"
          values: ["payments:read"]
---
# RequestAuthentication — define the JWT issuer
apiVersion: security.istio.io/v1beta1
kind: RequestAuthentication
metadata:
  name: jwt-auth
  namespace: production
spec:
  selector:
    matchLabels:
      app: payment-service
  jwtRules:
    - issuer: "https://auth.example.com"
      jwksUri: "https://auth.example.com/.well-known/jwks.json"
      forwardOriginalToken: false
      outputClaimToHeaders:
        - header: x-auth-user-id
          claim: sub
        - header: x-auth-scopes
          claim: scope
```

### PeerAuthentication for mTLS Mode

```yaml
# PeerAuthentication — enforce STRICT mTLS in the production namespace
# In ambient mode this is applied at the ztunnel level
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: production
spec:
  mtls:
    mode: STRICT
---
# PeerAuthentication — allow both mTLS and plaintext during migration
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: permissive-during-migration
  namespace: staging
spec:
  mtls:
    mode: PERMISSIVE
```

## Observability with Prometheus and Kiali

Ambient mode emits the same Istio standard metrics from ztunnel (L4) and waypoint proxies (L7).

```yaml
# PodMonitor for ztunnel L4 metrics
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: ztunnel-metrics
  namespace: monitoring
  labels:
    release: kube-prometheus
spec:
  namespaceSelector:
    matchNames:
      - istio-system
  selector:
    matchLabels:
      app: ztunnel
  podMetricsEndpoints:
    - port: metrics
      path: /metrics
      interval: 15s
      relabelings:
        - sourceLabels: [__meta_kubernetes_pod_node_name]
          targetLabel: node
---
# ServiceMonitor for waypoint proxy L7 metrics
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: waypoint-metrics
  namespace: monitoring
  labels:
    release: kube-prometheus
spec:
  namespaceSelector:
    any: true
  selector:
    matchLabels:
      istio.io/gateway-name: waypoint
  endpoints:
    - port: metrics
      path: /metrics
      interval: 15s
```

Key PromQL queries:

```promql
# L4 connection rate per workload (from ztunnel)
sum(rate(istio_tcp_connections_opened_total{
  reporter="source",
  namespace="production"
}[5m])) by (source_workload, destination_service_name)

# L7 request rate per service (from waypoint)
sum(rate(istio_requests_total{
  reporter="waypoint",
  namespace="production"
}[5m])) by (destination_service_name, response_code)

# L7 p99 latency per service
histogram_quantile(0.99,
  sum(rate(istio_request_duration_milliseconds_bucket{
    reporter="waypoint",
    namespace="production"
  }[5m])) by (destination_service_name, le)
)

# mTLS verification failures
sum(rate(istio_tcp_connections_closed_total{
  security_policy="mutual_tls",
  response_flags="TLSv2"
}[5m])) by (source_workload, destination_service_name)
```

Kiali configuration for ambient mesh:

```bash
# Install Kiali for ambient mesh visualization
helm upgrade --install kiali-server kiali/kiali-server \
  --namespace istio-system \
  --set "auth.strategy=anonymous" \
  --set "external_services.prometheus.url=http://prometheus-stack-kube-prom-prometheus.monitoring.svc.cluster.local:9090" \
  --set "external_services.istio.root_namespace=istio-system" \
  --set "deployment.ingress_enabled=false" \
  --set "kiali_feature_flags.ambient_enabled=true" \
  --wait
```

## Migration from Sidecar Mesh

Migrating from sidecar mesh to ambient mode is incremental and non-disruptive.

```bash
#!/bin/bash
# Migration script: sidecar → ambient, namespace by namespace

NAMESPACE="production"

# Step 1: Ensure istiod is upgraded to a version supporting both modes
istioctl version

# Step 2: Install ambient components alongside sidecar components
# (they coexist in the same cluster)
istioctl install --set profile=ambient -y

# Step 3: Label the target namespace for ambient mode
# Existing sidecar pods continue to work; new pods get ambient
kubectl label namespace "${NAMESPACE}" istio.io/dataplane-mode=ambient

# Step 4: Deploy a waypoint proxy if L7 features are needed
istioctl waypoint apply --namespace "${NAMESPACE}" --enroll-namespace

# Step 5: Remove sidecar injection labels from the namespace
kubectl label namespace "${NAMESPACE}" istio-injection-

# Step 6: Perform a rolling restart to remove existing sidecars
kubectl rollout restart deployment -n "${NAMESPACE}"

# Step 7: Verify no sidecar containers remain
kubectl get pods -n "${NAMESPACE}" -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{range .spec.containers[*]}{.name}{","}{end}{"\n"}{end}'

# Step 8: Verify ztunnel has all pods registered
kubectl exec -n istio-system ds/ztunnel -- pilot-agent request GET /debug/ztunnelstate | \
  python3 -m json.tool | grep "\"namespace\": \"${NAMESPACE}\""

echo "Migration of ${NAMESPACE} to ambient mode complete"
```

## Resource Overhead Comparison

| Component | Sidecar Mode | Ambient Mode |
|---|---|---|
| Per-pod CPU idle | ~50m per pod | 0 (shared ztunnel) |
| Per-pod memory idle | ~50Mi per pod | 0 (shared ztunnel) |
| Per-node ztunnel CPU | n/a | ~20m |
| Per-node ztunnel memory | n/a | ~64Mi |
| Waypoint CPU (per namespace) | n/a | ~100m (shared) |
| Waypoint memory (per namespace) | n/a | ~256Mi (shared) |
| Pod startup overhead | +2–5s injection | 0 |
| Rolling restarts required | Yes (injection) | No |

For a namespace with 100 pods:
- **Sidecar mode**: 100 × 50m = 5,000m CPU, 100 × 50Mi = 5,000Mi memory
- **Ambient mode**: 20m (ztunnel) + 100m (waypoint) = 120m CPU, 64Mi + 256Mi = 320Mi memory

## Known Limitations in Ambient Mode

The following capabilities available in sidecar mode have limited or no support in ambient mode as of Istio 1.22:

- **VirtualService** resources are not supported; use `HTTPRoute` (Gateway API) instead
- **DestinationRule** traffic policies are not fully supported at the waypoint level; some fields are ignored
- **EnvoyFilter** patches to the ztunnel are not supported
- **ServiceEntry** for external services requires explicit waypoint enrollment
- **Multi-cluster** ambient mesh is experimental
- **IPv6** support is experimental
- **Windows nodes** are not supported

```bash
# Check if any deprecated VirtualService resources exist in ambient namespaces
kubectl get virtualservice -n production
# Replace with HTTPRoute equivalents before completing sidecar removal

# Check for DestinationRule fields that may not apply in ambient mode
kubectl get destinationrule -n production -o yaml | grep -i "trafficPolicy\|outlierDetection\|connectionPool"
```

## Advanced L7 Policies: Fault Injection and Circuit Breaking

Waypoint proxies support Istio's `VirtualService`-equivalent features through EnvoyFilter and Gateway API extensions.

```yaml
# EnvoyFilter — inject a 5% error rate on the order-service for chaos testing
apiVersion: networking.istio.io/v1alpha3
kind: EnvoyFilter
metadata:
  name: order-service-fault-injection
  namespace: production
spec:
  workloadSelector:
    labels:
      istio.io/gateway-name: waypoint
  configPatches:
    - applyTo: HTTP_ROUTE
      match:
        context: SIDECAR_OUTBOUND
        routeConfiguration:
          vhost:
            name: "order-service.production.svc.cluster.local:80"
            route:
              name: "default"
      patch:
        operation: MERGE
        value:
          route:
            retry_policy:
              retry_on: "5xx,gateway-error,reset,connect-failure,retriable-4xx"
              num_retries: 3
              per_try_timeout: 5s
              retry_back_off:
                base_interval: 0.25s
                max_interval: 10s
          fault:
            abort:
              http_status: 503
              percentage:
                numerator: 5
                denominator: HUNDRED
```

### ServiceEntry for External Services in Ambient Mode

External services must be explicitly registered to receive mesh treatment in ambient mode.

```yaml
# ServiceEntry — register an external database in the mesh
apiVersion: networking.istio.io/v1beta1
kind: ServiceEntry
metadata:
  name: external-postgres
  namespace: production
spec:
  hosts:
    - postgres.example.com
  ports:
    - number: 5432
      name: tcp-postgres
      protocol: TCP
  location: MESH_EXTERNAL
  resolution: DNS
---
# ServiceEntry — register an external REST API
apiVersion: networking.istio.io/v1beta1
kind: ServiceEntry
metadata:
  name: external-payment-api
  namespace: production
spec:
  hosts:
    - api.stripe.com
  ports:
    - number: 443
      name: https
      protocol: HTTPS
  location: MESH_EXTERNAL
  resolution: DNS
---
# AuthorizationPolicy — allow only payment-service to reach Stripe
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: allow-payment-to-stripe
  namespace: production
spec:
  targetRef:
    group: networking.istio.io
    kind: ServiceEntry
    name: external-payment-api
  action: ALLOW
  rules:
    - from:
        - source:
            principals:
              - "cluster.local/ns/production/sa/payment-service"
```

## Production Hardening

### Resource Limits for Control Plane Components

```yaml
# istiod HPA and resource sizing
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: istiod
  namespace: istio-system
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: istiod
  minReplicas: 2
  maxReplicas: 5
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 60
---
# PodDisruptionBudget for istiod
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: istiod
  namespace: istio-system
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: istiod
---
# PodDisruptionBudget for waypoint proxies
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: waypoint
  namespace: production
spec:
  minAvailable: 1
  selector:
    matchLabels:
      istio.io/gateway-name: waypoint
```

### Verifying mTLS Encryption

```bash
#!/bin/bash
# Verify that mTLS is enforced between two specific pods

SOURCE_POD="order-service-abc123"
DEST_SERVICE="payment-service"
NAMESPACE="production"

# Check the authentication policy status
istioctl x describe service "${DEST_SERVICE}" -n "${NAMESPACE}"

# Verify mTLS from the source pod perspective
istioctl x check-inject pod "${SOURCE_POD}" -n "${NAMESPACE}"

# Dump ztunnel state to see workload mTLS settings
kubectl exec -n istio-system ds/ztunnel -- \
  pilot-agent request GET /debug/ztunnelstate | python3 -m json.tool | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
workloads = data.get('workloads', {})
for name, w in workloads.items():
    if '${NAMESPACE}' in name:
        print(f\"{name}: mtls={w.get('workloadIPs')}\")
"

# Check the certificate details for a pod
istioctl proxy-config secret \
  -n "${NAMESPACE}" \
  "pod/${SOURCE_POD}" \
  --output json | python3 -m json.tool | grep -A 5 "cert_chain\|validity"
```

## Troubleshooting

```bash
#!/bin/bash
# Ambient mesh diagnostics

# Check ztunnel registration for all pods
istioctl ztunnel-config workload

# Check ztunnel proxy configuration for a specific pod
istioctl ztunnel-config all \
  --pod order-service-abc123 \
  -n production

# Verify waypoint proxy endpoints
istioctl proxy-config endpoint \
  -n production \
  deploy/waypoint

# Check AuthorizationPolicy status
istioctl authz check \
  -n production \
  pod/order-service-abc123

# Debug L7 traffic through the waypoint
kubectl exec -n istio-system ds/ztunnel -- \
  pilot-agent request GET /debug/config_dump | python3 -m json.tool | grep -A 5 "payment-service"

# Check ztunnel logs for connection errors
kubectl logs -n istio-system ds/ztunnel --tail 200 | grep -i "error\|failed\|denied"

# Check waypoint proxy logs
kubectl logs -n production deploy/waypoint --tail 200 | grep -i "error\|upstream_reset\|503"

# Verify mTLS is active between two pods
istioctl x describe pod order-service-abc123 -n production

# Check istiod logs for certificate issues
kubectl logs -n istio-system deploy/istiod --tail 200 | grep -i "cert\|spiffe\|error"
```

## Summary

Istio Ambient Mesh represents the most significant architecture change to Istio since the project's founding. By decoupling L4 (ztunnel) from L7 (waypoint) processing and eliminating per-pod sidecar injection, ambient mode slashes resource overhead, simplifies enrollment, and removes the need for pod restarts during mesh adoption. The data plane is now composable: teams opt into L7 features only when needed by deploying a waypoint, keeping the cost of baseline mTLS and telemetry at the node level. With `HTTPRoute`-based traffic management, `AuthorizationPolicy` at both L4 and L7, and Prometheus metrics emitted from both ztunnel and waypoints, ambient mode delivers the same security and observability guarantees as sidecar mode — at a fraction of the operational and resource cost.
