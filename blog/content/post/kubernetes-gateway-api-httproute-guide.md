---
title: "Kubernetes Gateway API: HTTPRoute, TCPRoute, TLSRoute, and Multi-Cluster Traffic Routing"
date: 2028-08-02T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Gateway API", "HTTPRoute", "Service Mesh", "Traffic Management"]
categories:
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive deep dive into the Kubernetes Gateway API covering HTTPRoute, TCPRoute, TLSRoute resources, multi-cluster traffic routing, and migration from Ingress to Gateway API."
more_link: "yes"
url: "/kubernetes-gateway-api-httproute-guide/"
---

The Kubernetes Gateway API represents the next generation of traffic management for Kubernetes, superseding the aging Ingress resource with a far more expressive, extensible, and role-oriented API surface. If you are still running nginx-ingress or Traefik with hand-rolled annotations to express path rewrites, header mutations, and weighted traffic splits, Gateway API offers a standardized way to encode all of that in typed, validated Kubernetes resources.

This guide covers the full spectrum: Gateway and GatewayClass setup, HTTPRoute routing rules, TCPRoute and TLSRoute for layer-4 workloads, traffic splitting and header manipulation, multi-cluster routing patterns, and the operational considerations that matter in production.

<!--more-->

# Kubernetes Gateway API: HTTPRoute, TCPRoute, TLSRoute, and Multi-Cluster Traffic Routing

## Section 1: Why Gateway API Exists

The original `Ingress` resource was intentionally minimal. It expressed host-based and path-based routing to backend services and nothing else. Any real-world capability — SSL termination, timeouts, retries, canary weights, header injection — was expressed through non-standard annotations, creating a fragmented ecosystem where every controller spoke a different dialect.

Gateway API was designed from first principles by SIG Network to fix this. The key design decisions:

**Role-oriented model**: Three distinct personas interact with Gateway API resources, each with a defined scope of authority.

| Role | Resource | Responsibility |
|------|----------|----------------|
| Infrastructure provider | `GatewayClass` | Defines the controller implementation |
| Cluster operator | `Gateway` | Provisions listeners and certificates |
| Application developer | `HTTPRoute`, `TCPRoute`, `TLSRoute` | Defines routing rules |

**Typed, validated resources**: Unlike annotation-driven configuration, all route parameters are expressed in strongly typed fields with CRD-level validation.

**Extensibility without forking**: Controller-specific extensions live in well-defined extension points rather than annotations.

## Section 2: Installing Gateway API CRDs

Gateway API ships as a set of CRDs independent of Kubernetes itself. There are two channels: `standard` (stable resources) and `experimental` (includes TCPRoute, TLSRoute, UDPRoute, and other resources still maturing).

```bash
# Install the standard channel CRDs
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/standard-install.yaml

# Install the experimental channel CRDs (required for TCPRoute, TLSRoute, UDPRoute)
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/experimental-install.yaml

# Verify CRDs are installed
kubectl get crd | grep gateway.networking.k8s.io
```

Expected output:
```
gatewayclasses.gateway.networking.k8s.io
gateways.gateway.networking.k8s.io
grpcroutes.gateway.networking.k8s.io
httproutes.gateway.networking.k8s.io
referencegrants.gateway.networking.k8s.io
tcproutes.gateway.networking.k8s.io
tlsroutes.gateway.networking.k8s.io
```

## Section 3: GatewayClass and Gateway Setup

### GatewayClass

A `GatewayClass` names a controller implementation and optionally references a `ParametersReference` for controller-level configuration.

```yaml
# gatewayclass.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: cilium
spec:
  controllerName: io.cilium/gateway-controller
  description: "Cilium Gateway API implementation"
---
# Using Envoy Gateway as the controller
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: envoy
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
  parametersRef:
    group: gateway.envoyproxy.io
    kind: EnvoyProxy
    name: envoy-proxy-config
    namespace: envoy-gateway-system
```

### Gateway

The `Gateway` resource provisions the actual load balancer infrastructure. Each listener defines a port, protocol, and optional TLS configuration.

```yaml
# gateway.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: production-gateway
  namespace: gateway-infra
spec:
  gatewayClassName: envoy
  listeners:
    # HTTP listener — typically redirects to HTTPS
    - name: http
      port: 80
      protocol: HTTP
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              gateway-access: "true"

    # HTTPS listener with TLS termination
    - name: https
      port: 443
      protocol: HTTPS
      tls:
        mode: Terminate
        certificateRefs:
          - name: production-tls-cert
            kind: Secret
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              gateway-access: "true"

    # TCP passthrough listener for databases
    - name: postgres
      port: 5432
      protocol: TCP
      allowedRoutes:
        namespaces:
          from: Same

    # TLS passthrough (SNI routing without termination)
    - name: tls-passthrough
      port: 8443
      protocol: TLS
      tls:
        mode: Passthrough
      allowedRoutes:
        namespaces:
          from: All
```

Certificate management with cert-manager:

```yaml
# certificate.yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: production-tls-cert
  namespace: gateway-infra
spec:
  secretName: production-tls-cert
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  dnsNames:
    - "*.support.tools"
    - "support.tools"
  duration: 2160h   # 90 days
  renewBefore: 360h # 15 days
```

## Section 4: HTTPRoute Deep Dive

`HTTPRoute` is the primary resource for HTTP/HTTPS traffic routing. It replaces Ingress with a far richer rule model.

### Basic Path and Host Routing

```yaml
# httproute-basic.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-routes
  namespace: production
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-infra
      sectionName: https   # attach to specific listener
  hostnames:
    - "api.support.tools"
  rules:
    # Exact path match
    - matches:
        - path:
            type: Exact
            value: /healthz
      backendRefs:
        - name: health-service
          port: 8080

    # Prefix match
    - matches:
        - path:
            type: PathPrefix
            value: /v1/users
      backendRefs:
        - name: users-service
          port: 8080

    # Regular expression match (experimental)
    - matches:
        - path:
            type: RegularExpression
            value: "^/v[0-9]+/orders"
      backendRefs:
        - name: orders-service
          port: 8080

    # Header-based routing
    - matches:
        - headers:
            - name: X-API-Version
              value: "v2"
      backendRefs:
        - name: api-v2-service
          port: 8080

    # Query parameter routing
    - matches:
        - queryParams:
            - name: debug
              value: "true"
      backendRefs:
        - name: api-debug-service
          port: 8080
          weight: 100
```

### Traffic Splitting (Canary / Blue-Green)

One of the most requested features impossible to express in standard Ingress:

```yaml
# httproute-canary.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: frontend-canary
  namespace: production
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-infra
  hostnames:
    - "www.support.tools"
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        # 90% to stable
        - name: frontend-stable
          port: 3000
          weight: 90
        # 10% to canary
        - name: frontend-canary
          port: 3000
          weight: 10
```

Progressive canary rollout script:

```bash
#!/bin/bash
# canary-rollout.sh
# Progressively shift traffic from stable to canary

set -euo pipefail

NAMESPACE="production"
HTTPROUTE_NAME="frontend-canary"
STABLE_SVC="frontend-stable"
CANARY_SVC="frontend-canary"

rollout_weights=(10 25 50 75 90 100)

for canary_weight in "${rollout_weights[@]}"; do
  stable_weight=$((100 - canary_weight))
  echo "Shifting: stable=${stable_weight}% canary=${canary_weight}%"

  kubectl patch httproute "${HTTPROUTE_NAME}" -n "${NAMESPACE}" \
    --type='json' \
    -p="[
      {\"op\": \"replace\", \"path\": \"/spec/rules/0/backendRefs/0/weight\", \"value\": ${stable_weight}},
      {\"op\": \"replace\", \"path\": \"/spec/rules/0/backendRefs/1/weight\", \"value\": ${canary_weight}}
    ]"

  echo "Waiting 5 minutes for metrics to stabilize..."
  sleep 300

  # Check error rate (requires prometheus)
  ERROR_RATE=$(kubectl exec -n monitoring deploy/prometheus -- \
    promtool query instant \
    'sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))' \
    | grep -oP '\d+\.\d+' | head -1)

  if (( $(echo "$ERROR_RATE > 0.01" | bc -l) )); then
    echo "ERROR: Error rate ${ERROR_RATE} exceeds threshold. Rolling back."
    kubectl patch httproute "${HTTPROUTE_NAME}" -n "${NAMESPACE}" \
      --type='json' \
      -p='[
        {"op": "replace", "path": "/spec/rules/0/backendRefs/0/weight", "value": 100},
        {"op": "replace", "path": "/spec/rules/0/backendRefs/1/weight", "value": 0}
      ]'
    exit 1
  fi

  echo "Metrics healthy, proceeding to next step."
done

echo "Canary rollout complete. 100% traffic on canary."
```

### Request and Response Modification

```yaml
# httproute-filters.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-with-filters
  namespace: production
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-infra
  hostnames:
    - "api.support.tools"
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /legacy
      filters:
        # URL rewrite: strip /legacy prefix
        - type: URLRewrite
          urlRewrite:
            path:
              type: ReplacePrefixMatch
              replacePrefixMatch: /

        # Add request headers before forwarding upstream
        - type: RequestHeaderModifier
          requestHeaderModifier:
            add:
              - name: X-Forwarded-By
                value: "gateway"
              - name: X-Environment
                value: "production"
            remove:
              - X-Internal-Debug

        # Add response headers
        - type: ResponseHeaderModifier
          responseHeaderModifier:
            add:
              - name: Strict-Transport-Security
                value: "max-age=31536000; includeSubDomains"
              - name: X-Content-Type-Options
                value: "nosniff"
              - name: X-Frame-Options
                value: "DENY"

      backendRefs:
        - name: legacy-api
          port: 8080

    # HTTP to HTTPS redirect
    - matches:
        - path:
            type: PathPrefix
            value: /
      filters:
        - type: RequestRedirect
          requestRedirect:
            scheme: https
            statusCode: 301
```

### Timeouts and Retries

```yaml
# httproute-timeouts.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-with-timeouts
  namespace: production
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-infra
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api/reports
      timeouts:
        request: 30s        # Total request timeout
        backendRequest: 25s # Individual backend call timeout
      backendRefs:
        - name: reports-service
          port: 8080
```

## Section 5: TCPRoute

`TCPRoute` provides layer-4 routing based on the destination port. This is essential for databases, message brokers, and any protocol that doesn't speak HTTP.

```yaml
# tcproute.yaml
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: TCPRoute
metadata:
  name: postgres-route
  namespace: database
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-infra
      sectionName: postgres
  rules:
    - backendRefs:
        - name: postgres-primary
          port: 5432
```

Multi-backend TCP with weighted routing (for migration):

```yaml
# tcproute-weighted.yaml
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: TCPRoute
metadata:
  name: redis-migration
  namespace: cache
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-infra
      sectionName: redis
  rules:
    - backendRefs:
        - name: redis-old-cluster
          port: 6379
          weight: 20
        - name: redis-new-cluster
          port: 6379
          weight: 80
```

## Section 6: TLSRoute

`TLSRoute` enables TLS passthrough routing using SNI (Server Name Indication) without terminating the TLS session at the gateway.

```yaml
# tlsroute.yaml
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: TLSRoute
metadata:
  name: secure-service-route
  namespace: production
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-infra
      sectionName: tls-passthrough
  hostnames:
    - "secure.support.tools"
    - "mtls.support.tools"
  rules:
    - backendRefs:
        - name: secure-service
          port: 8443
          namespace: production
```

When to use TLSRoute vs HTTPRoute with TLS termination:

| Use Case | Approach |
|----------|----------|
| mTLS end-to-end (client cert reaches backend) | TLSRoute passthrough |
| Regulatory compliance (TLS termination must be at app) | TLSRoute passthrough |
| Header inspection, rewrites, auth | HTTPRoute (terminate at gateway) |
| Backend doesn't need to handle TLS | HTTPRoute (terminate at gateway) |

## Section 7: ReferenceGrant

When an HTTPRoute in namespace `production` references a backend Service in namespace `shared-services`, Kubernetes blocks the reference by default for security. `ReferenceGrant` is the mechanism to permit cross-namespace references.

```yaml
# referencegrant.yaml
# In the TARGET namespace (where the Service lives)
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-production-routes
  namespace: shared-services  # namespace being accessed
spec:
  from:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      namespace: production   # namespace making the reference
  to:
    - group: ""
      kind: Service
```

Multiple namespaces can be permitted:

```yaml
# referencegrant-multi.yaml
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-team-routes
  namespace: shared-services
spec:
  from:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      namespace: team-alpha
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      namespace: team-beta
    - group: gateway.networking.k8s.io
      kind: GRPCRoute
      namespace: grpc-services
  to:
    - group: ""
      kind: Service
    - group: ""
      kind: Secret  # for certificate references
```

## Section 8: Multi-Cluster Traffic Routing

Multi-cluster routing with Gateway API is achieved by combining the Gateway API with a multi-cluster service discovery mechanism such as Submariner, Cilium Cluster Mesh, or the Multi-Cluster Services API (MCS).

### Multi-Cluster Services API (MCS)

The MCS API introduces `ServiceImport` and `ServiceExport` resources:

```yaml
# serviceexport.yaml — in cluster A, namespace shared
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: inventory-service
  namespace: shared
```

```yaml
# serviceimport.yaml — auto-created in cluster B by MCS controller
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceImport
metadata:
  name: inventory-service
  namespace: shared
spec:
  type: ClusterSetIP
  ports:
    - protocol: TCP
      port: 8080
```

Route to a multi-cluster service:

```yaml
# httproute-multicluster.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: inventory-route
  namespace: production
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-infra
  hostnames:
    - "inventory.support.tools"
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        # Local service (cluster A)
        - group: ""
          kind: Service
          name: inventory-service-local
          port: 8080
          weight: 70
        # Remote service via ServiceImport (cluster B)
        - group: multicluster.x-k8s.io
          kind: ServiceImport
          name: inventory-service
          port: 8080
          weight: 30
```

### Failover Routing

```yaml
# httproute-failover.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-with-failover
  namespace: production
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-infra
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api
      backendRefs:
        # Primary (weight 100 normally)
        - name: api-primary
          port: 8080
          weight: 100
        # Failover (weight 0 normally, operator changes to non-zero on failure)
        - name: api-failover
          port: 8080
          weight: 0
```

Automated failover with a health-checking controller:

```go
// failover-controller.go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "time"

    "k8s.io/apimachinery/pkg/types"
    "sigs.k8s.io/controller-runtime/pkg/client"
    gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"
)

type FailoverController struct {
    k8sClient   client.Client
    primaryURL  string
    failoverURL string
}

func (f *FailoverController) healthCheck(url string) bool {
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url+"/healthz", nil)
    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        return false
    }
    defer resp.Body.Close()
    return resp.StatusCode == http.StatusOK
}

func (f *FailoverController) reconcile(ctx context.Context) error {
    primaryHealthy := f.healthCheck(f.primaryURL)

    route := &gatewayv1.HTTPRoute{}
    if err := f.k8sClient.Get(ctx, types.NamespacedName{
        Name:      "api-with-failover",
        Namespace: "production",
    }, route); err != nil {
        return err
    }

    var primaryWeight, failoverWeight int32
    if primaryHealthy {
        primaryWeight, failoverWeight = 100, 0
    } else {
        primaryWeight, failoverWeight = 0, 100
        fmt.Println("Primary unhealthy — routing to failover")
    }

    patch := []map[string]interface{}{
        {"op": "replace", "path": "/spec/rules/0/backendRefs/0/weight", "value": primaryWeight},
        {"op": "replace", "path": "/spec/rules/0/backendRefs/1/weight", "value": failoverWeight},
    }
    patchBytes, _ := json.Marshal(patch)

    return f.k8sClient.Patch(ctx, route,
        client.RawPatch(types.JSONPatchType, patchBytes))
}
```

## Section 9: Migration from Ingress to Gateway API

### Mapping Ingress to HTTPRoute

```yaml
# Before: nginx Ingress with annotations
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-ingress
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /$2
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/proxy-connect-timeout: "30"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "30"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "30"
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-weight: "10"
spec:
  tls:
    - hosts:
        - api.support.tools
      secretName: api-tls
  rules:
    - host: api.support.tools
      http:
        paths:
          - path: /v1(/|$)(.*)
            pathType: Prefix
            backend:
              service:
                name: api-service
                port:
                  number: 8080
```

```yaml
# After: HTTPRoute (no annotations needed)
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-httproute
  namespace: production
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-infra
      sectionName: https
  hostnames:
    - "api.support.tools"
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /v1
      filters:
        - type: URLRewrite
          urlRewrite:
            path:
              type: ReplacePrefixMatch
              replacePrefixMatch: /
      timeouts:
        request: 30s
        backendRequest: 30s
      backendRefs:
        - name: api-service
          port: 8080
          weight: 90
        - name: api-service-canary
          port: 8080
          weight: 10
```

### Migration Script

```bash
#!/bin/bash
# ingress-to-gateway-migration.sh
# Audit existing Ingresses and generate HTTPRoute equivalents

set -euo pipefail

NAMESPACE=${1:-"default"}
OUTPUT_DIR="./gateway-migration"
mkdir -p "${OUTPUT_DIR}"

echo "Auditing Ingresses in namespace: ${NAMESPACE}"
kubectl get ingress -n "${NAMESPACE}" -o json | jq -r '.items[].metadata.name' | while read -r ingress_name; do
  echo "Processing: ${ingress_name}"

  # Extract Ingress details
  kubectl get ingress "${ingress_name}" -n "${NAMESPACE}" -o json > "/tmp/${ingress_name}.json"

  hosts=$(jq -r '.spec.rules[].host' "/tmp/${ingress_name}.json" | sort -u)
  echo "  Hosts: ${hosts}"

  # Check for annotations that require attention
  annotations=$(jq -r '.metadata.annotations | keys[]' "/tmp/${ingress_name}.json" 2>/dev/null || echo "")
  if [ -n "${annotations}" ]; then
    echo "  WARNING: Found annotations requiring manual mapping:"
    echo "${annotations}" | sed 's/^/    - /'
  fi

  echo "  Generating HTTPRoute skeleton: ${OUTPUT_DIR}/${ingress_name}-httproute.yaml"
  cat > "${OUTPUT_DIR}/${ingress_name}-httproute.yaml" << EOF
# Generated from Ingress: ${ingress_name}
# REVIEW REQUIRED: annotations may require manual mapping to HTTPRoute filters
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: ${ingress_name}
  namespace: ${NAMESPACE}
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-infra
  # TODO: Fill in hostnames
  hostnames: []
  rules: []
EOF
done

echo "Migration skeletons generated in ${OUTPUT_DIR}/"
echo "Review each file and fill in routes before applying."
```

## Section 10: Observability and Debugging

### Checking Route Status

```bash
# Check Gateway status
kubectl get gateway production-gateway -n gateway-infra -o yaml | grep -A 20 status

# Check HTTPRoute status and conditions
kubectl get httproute api-routes -n production -o yaml | grep -A 30 status

# Watch route attachment status
kubectl get httproute -A -o custom-columns=\
'NAMESPACE:.metadata.namespace,NAME:.metadata.name,HOSTNAMES:.spec.hostnames,PARENT:.spec.parentRefs[*].name,ACCEPTED:.status.parents[*].conditions[?(@.type=="Accepted")].status'
```

Example status output showing successful attachment:

```yaml
status:
  parents:
    - conditions:
        - lastTransitionTime: "2028-08-01T12:00:00Z"
          message: Route is accepted
          observedGeneration: 3
          reason: Accepted
          status: "True"
          type: Accepted
        - lastTransitionTime: "2028-08-01T12:00:00Z"
          message: All references resolved
          observedGeneration: 3
          reason: ResolvedRefs
          status: "True"
          type: ResolvedRefs
      controllerName: gateway.envoyproxy.io/gatewayclass-controller
      parentRef:
        group: gateway.networking.k8s.io
        kind: Gateway
        name: production-gateway
        namespace: gateway-infra
        sectionName: https
```

### Common Issues and Fixes

```bash
# Issue: Route not accepted — check ReferenceGrant
kubectl get referencegrant -n shared-services

# Issue: Certificate not found
kubectl get secret -n gateway-infra production-tls-cert

# Issue: No addresses on Gateway
kubectl describe gateway production-gateway -n gateway-infra
# Look for: "No addresses have been assigned" -> controller may not be running

# Check controller pod
kubectl get pods -n envoy-gateway-system
kubectl logs -n envoy-gateway-system deploy/envoy-gateway -f

# Verify GatewayClass is accepted
kubectl get gatewayclass envoy -o jsonpath='{.status.conditions[?(@.type=="Accepted")].status}'
```

### Prometheus Metrics for Gateway API

```yaml
# servicemonitor for gateway metrics
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: gateway-api-metrics
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: envoy-gateway
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
```

Key metrics to monitor:

```promql
# Request rate per HTTPRoute
sum by (route_name) (rate(envoy_http_downstream_rq_total[5m]))

# Error rate per route
sum by (route_name) (rate(envoy_http_downstream_rq_5xx[5m])) /
sum by (route_name) (rate(envoy_http_downstream_rq_total[5m]))

# P99 latency
histogram_quantile(0.99,
  sum by (route_name, le) (rate(envoy_http_downstream_rq_time_bucket[5m])))

# Backend connection errors
sum by (cluster_name) (rate(envoy_cluster_upstream_cx_connect_fail[5m]))
```

## Section 11: Policy Attachment (BackendLBPolicy, BackendTLSPolicy)

Gateway API v1.1+ introduced Policy Attachment — typed resources that attach policies to Gateway API objects without forking route specs.

```yaml
# backendtlspolicy.yaml — enforce TLS to backend
apiVersion: gateway.networking.k8s.io/v1alpha3
kind: BackendTLSPolicy
metadata:
  name: enforce-backend-tls
  namespace: production
spec:
  targetRefs:
    - group: ""
      kind: Service
      name: secure-backend
  validation:
    caCertificateRefs:
      - name: backend-ca-cert
        group: ""
        kind: ConfigMap
    hostname: "secure-backend.production.svc.cluster.local"
```

```yaml
# backendlbpolicy.yaml — customize load balancing per backend
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: BackendLBPolicy
metadata:
  name: round-robin-lb
  namespace: production
spec:
  targetRefs:
    - group: ""
      kind: Service
      name: api-service
  sessionPersistence:
    sessionName: api-session
    absoluteTimeout: 1h
    idleTimeout: 30m
    type: Cookie
    cookieConfig:
      lifetimeType: Session
```

## Section 12: Production Checklist

Before promoting Gateway API to production:

```bash
#!/bin/bash
# gateway-api-preflight.sh
set -euo pipefail

echo "=== Gateway API Production Preflight ==="

echo "[1] Checking CRD versions..."
kubectl get crd gateways.gateway.networking.k8s.io -o jsonpath='{.spec.versions[*].name}'
echo ""

echo "[2] Checking GatewayClass acceptance..."
ACCEPTED=$(kubectl get gatewayclass -o jsonpath='{.items[*].status.conditions[?(@.type=="Accepted")].status}')
if echo "$ACCEPTED" | grep -q "False"; then
  echo "  ERROR: Some GatewayClasses are not accepted"
  kubectl get gatewayclass
  exit 1
fi
echo "  OK: All GatewayClasses accepted"

echo "[3] Checking Gateway addresses..."
GATEWAYS=$(kubectl get gateway -A -o jsonpath='{.items[*].metadata.name}')
for gw in $GATEWAYS; do
  ADDR=$(kubectl get gateway "$gw" -A -o jsonpath='{.items[0].status.addresses[0].value}' 2>/dev/null || echo "")
  if [ -z "$ADDR" ]; then
    echo "  WARNING: Gateway $gw has no assigned address"
  else
    echo "  OK: Gateway $gw -> $ADDR"
  fi
done

echo "[4] Checking HTTPRoute conditions..."
kubectl get httproute -A -o json | jq -r '
  .items[] |
  .metadata.namespace + "/" + .metadata.name + ": " +
  (.status.parents[0].conditions[] | select(.type == "Accepted") | .status)
'

echo "[5] Checking certificate expiry..."
kubectl get secrets -A -l app.kubernetes.io/managed-by=cert-manager \
  -o json | jq -r '
  .items[] |
  .metadata.namespace + "/" + .metadata.name
' | while read -r certref; do
  ns=$(echo "$certref" | cut -d/ -f1)
  name=$(echo "$certref" | cut -d/ -f2)
  EXPIRY=$(kubectl get secret "$name" -n "$ns" \
    -o jsonpath='{.data.tls\.crt}' | base64 -d | \
    openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2 || echo "unknown")
  echo "  $certref expires: $EXPIRY"
done

echo ""
echo "=== Preflight complete ==="
```

## Conclusion

The Kubernetes Gateway API is a mature, production-ready replacement for Ingress that solves the annotation chaos that has plagued the ecosystem for years. Key takeaways:

- **HTTPRoute** replaces Ingress with typed, validated rules for path routing, header modification, traffic splitting, redirects, and timeouts — all without controller-specific annotations.
- **TCPRoute** and **TLSRoute** extend the same role-oriented model to layer-4 workloads and TLS passthrough scenarios.
- **ReferenceGrant** provides secure cross-namespace access with explicit consent from the target namespace.
- **Multi-cluster routing** pairs naturally with the MCS API for geo-redundant or federated deployments.
- **Policy Attachment** resources (`BackendTLSPolicy`, `BackendLBPolicy`) cover advanced backend configuration without modifying route specs.

The migration from Ingress to Gateway API is incremental: both can coexist in the same cluster, and most controllers support both. Start with new workloads, then migrate existing Ingresses route by route, validating status conditions and metrics after each change.
