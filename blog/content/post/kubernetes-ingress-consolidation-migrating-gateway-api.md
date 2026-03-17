---
title: "Kubernetes Ingress Consolidation: Migrating from Multiple Controllers to Gateway API"
date: 2030-08-08T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Gateway API", "Ingress", "Networking", "Migration", "nginx", "Envoy"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise migration guide for Kubernetes Ingress to Gateway API: auditing existing resources, mapping annotations to Gateway API equivalents, phased migration strategy, traffic validation with shadow routing, and running Gateway API alongside legacy Ingress during transition."
more_link: "yes"
url: "/kubernetes-ingress-consolidation-migrating-gateway-api/"
---

Gateway API has graduated to stable (v1) and is now the recommended path for Kubernetes traffic management. Organizations that accumulated multiple Ingress controllers—often one per team or one per feature set—now face the opportunity to consolidate onto Gateway API's richer, role-oriented model. The migration is not a lift-and-shift; it requires understanding the model differences and executing a phased transition that maintains availability throughout.

<!--more-->

## Overview

This guide covers the complete migration journey from legacy Kubernetes Ingress to Gateway API: auditing existing Ingress resources, understanding Gateway API's object model, mapping common annotations to HTTPRoute and GatewayClass equivalents, designing a phased migration, validating traffic with shadow routing, and managing the coexistence period.

## Understanding the Model Difference

### Ingress vs Gateway API Object Hierarchy

```
Legacy Ingress Model:
┌─────────────────────────────────────┐
│  Ingress                            │
│  (all routing, TLS, backends in     │
│   one resource + annotations)       │
└─────────────────────────────────────┘

Gateway API Model (Role-Oriented):
┌─────────────────────────────────────────────────────┐
│  GatewayClass (cluster admin)                       │
│  Defines implementation: nginx-gateway, envoy, etc. │
└─────────────────┬───────────────────────────────────┘
                  │
┌─────────────────▼───────────────────────────────────┐
│  Gateway (infrastructure team)                      │
│  Defines listeners, TLS, ports                      │
│  Controls which routes can attach                   │
└────────────┬────────────┬──────────────────────────┘
             │            │
┌────────────▼──┐  ┌──────▼────────────────────────┐
│  HTTPRoute    │  │  TCPRoute / TLSRoute / GRPCRoute│
│  (app team)   │  │  (app team)                    │
│  URL routing, │  │  Protocol-specific routing      │
│  filters,     │  │                                │
│  backends     │  │                                │
└───────────────┘  └────────────────────────────────┘
```

### Key Benefits of Gateway API

- **Role separation**: Infrastructure teams manage GatewayClass and Gateway; application teams manage HTTPRoute independently
- **Cross-namespace routing**: Routes in any namespace can attach to shared Gateways
- **Richer matching**: Path, header, query param, and method matching with precise control
- **Traffic splitting**: Built-in weighted traffic splitting for canary deployments
- **Request/response modification**: Header manipulation, redirects, and URL rewrites without controller-specific annotations
- **Portability**: Standard API works across NGINX, Envoy, HAProxy, and cloud-native gateway implementations

## Step 1: Audit Existing Ingress Resources

### Discovery Script

```bash
#!/bin/bash
# audit-ingress.sh - comprehensive Ingress resource inventory

echo "=== Ingress Controller Inventory ==="
kubectl get pods -A -l 'app in (ingress-nginx,nginx-ingress,traefik,kong,haproxy)' \
  --no-headers -o custom-columns="NAMESPACE:.metadata.namespace,NAME:.metadata.name,NODE:.spec.nodeName"

echo ""
echo "=== IngressClass Resources ==="
kubectl get ingressclass -o wide

echo ""
echo "=== All Ingress Resources by Namespace ==="
kubectl get ingress -A -o wide

echo ""
echo "=== Ingress Annotation Summary ==="
kubectl get ingress -A -o json | jq -r '
  .items[] |
  "\(.metadata.namespace)/\(.metadata.name)":
    (.metadata.annotations | keys | join(", "))
' | sort

echo ""
echo "=== TLS Configuration ==="
kubectl get ingress -A -o json | jq -r '
  .items[] |
  select(.spec.tls != null) |
  "\(.metadata.namespace)/\(.metadata.name): " +
  (.spec.tls | map(.secretName) | join(", "))
'

echo ""
echo "=== Backend Services ==="
kubectl get ingress -A -o json | jq -r '
  .items[] |
  . as $ing |
  .spec.rules[]? |
  . as $rule |
  .http.paths[]? |
  "\($ing.metadata.namespace)/\($ing.metadata.name) -> \($rule.host // "*")\(.path) -> \(.backend.service.name):\(.backend.service.port.number // .backend.service.port.name)"
'
```

### Export Ingress Manifest Inventory

```bash
# Export all Ingress resources in a structured format for analysis
kubectl get ingress -A -o yaml > ingress-inventory.yaml

# Count unique annotation keys in use
kubectl get ingress -A -o json | \
  jq -r '.items[].metadata.annotations | keys[]' | \
  sort | uniq -c | sort -rn | head -30
```

Example annotation inventory output:

```
  47 nginx.ingress.kubernetes.io/rewrite-target
  31 nginx.ingress.kubernetes.io/ssl-redirect
  28 nginx.ingress.kubernetes.io/proxy-body-size
  22 nginx.ingress.kubernetes.io/use-regex
  19 nginx.ingress.kubernetes.io/proxy-read-timeout
  15 nginx.ingress.kubernetes.io/proxy-connect-timeout
  12 nginx.ingress.kubernetes.io/auth-url
  11 nginx.ingress.kubernetes.io/rate-limit
   8 nginx.ingress.kubernetes.io/canary
   7 nginx.ingress.kubernetes.io/canary-weight
```

## Step 2: Install Gateway API CRDs and Implementation

### Install Gateway API CRDs

```bash
# Install the stable Gateway API CRDs
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.1.0/standard-install.yaml

# Verify CRDs are installed
kubectl get crd | grep gateway.networking.k8s.io
# Expected:
# gatewayclasses.gateway.networking.k8s.io
# gateways.gateway.networking.k8s.io
# httproutes.gateway.networking.k8s.io
# grpcroutes.gateway.networking.k8s.io
# referencegrants.gateway.networking.k8s.io

# For experimental features (TCPRoute, TLSRoute, UDPRoute):
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.1.0/experimental-install.yaml
```

### Deploy NGINX Gateway Fabric (Production Implementation)

```bash
helm repo add nginx-stable https://helm.nginx.com/stable
helm repo update

helm install nginx-gateway nginx-stable/nginx-gateway-fabric \
  --namespace nginx-gateway \
  --create-namespace \
  --set service.type=LoadBalancer \
  --set service.annotations."service\.beta\.kubernetes\.io/aws-load-balancer-type"=nlb \
  --set nginxGateway.replicaCount=3 \
  --set nginxGateway.resources.requests.cpu=500m \
  --set nginxGateway.resources.requests.memory=256Mi \
  --set nginxGateway.resources.limits.cpu=2000m \
  --set nginxGateway.resources.limits.memory=512Mi
```

### GatewayClass Definition

```yaml
# gatewayclass.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: nginx-production
  annotations:
    description: "Production NGINX Gateway Fabric"
spec:
  controllerName: gateway.nginx.org/nginx-gateway-controller
  parametersRef:
    group: gateway.nginx.org
    kind: NginxGateway
    name: nginx-gateway-config
    namespace: nginx-gateway
---
apiVersion: gateway.nginx.org/v1alpha1
kind: NginxGateway
metadata:
  name: nginx-gateway-config
  namespace: nginx-gateway
spec:
  logging:
    level: info
```

## Step 3: Map Ingress Annotations to Gateway API Equivalents

### Core HTTP Routing

**Legacy Ingress:**
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: webapp
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - app.support.tools
    secretName: app-tls
  rules:
  - host: app.support.tools
    http:
      paths:
      - path: /api
        pathType: Prefix
        backend:
          service:
            name: api-service
            port:
              number: 8080
      - path: /
        pathType: Prefix
        backend:
          service:
            name: frontend-service
            port:
              number: 3000
```

**Gateway API equivalent:**
```yaml
# Gateway definition (created once by infra team, shared across teams)
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: production-gateway
  namespace: gateway-system
spec:
  gatewayClassName: nginx-production
  listeners:
  - name: https
    port: 443
    protocol: HTTPS
    hostname: "*.support.tools"
    tls:
      mode: Terminate
      certificateRefs:
      - name: wildcard-support-tools-tls
        namespace: gateway-system
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchLabels:
            gateway-access: "true"
  - name: http
    port: 80
    protocol: HTTP
    hostname: "*.support.tools"
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchLabels:
            gateway-access: "true"
---
# HTTPRoute (created by app team in their namespace)
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: webapp
  namespace: production
spec:
  parentRefs:
  - name: production-gateway
    namespace: gateway-system
    sectionName: https
  hostnames:
  - "app.support.tools"
  rules:
  # HTTP-to-HTTPS redirect (replaces ssl-redirect annotation)
  - matches:
    - path:
        type: PathPrefix
        value: /api
    backendRefs:
    - name: api-service
      port: 8080
  - matches:
    - path:
        type: PathPrefix
        value: /
    backendRefs:
    - name: frontend-service
      port: 3000
---
# HTTP redirect to HTTPS
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: webapp-http-redirect
  namespace: production
spec:
  parentRefs:
  - name: production-gateway
    namespace: gateway-system
    sectionName: http
  hostnames:
  - "app.support.tools"
  rules:
  - filters:
    - type: RequestRedirect
      requestRedirect:
        scheme: https
        statusCode: 301
```

### Annotation Migration Reference Table

| nginx Ingress Annotation | Gateway API Equivalent |
|--------------------------|----------------------|
| `rewrite-target: /` | `URLRewrite` filter with `ReplacePrefixMatch` |
| `ssl-redirect: true` | Separate HTTPRoute on port 80 with `RequestRedirect` filter |
| `proxy-body-size: 100m` | Implementation-specific policy or `RequestHeaderModifier` |
| `proxy-read-timeout: 60` | `BackendLBPolicy` or implementation extension |
| `canary: true` + `canary-weight: 20` | `backendRefs` with `weight` field |
| `auth-url: ...` | `ExtensionRef` filter to auth policy |
| `rate-limit-rps: 10` | `LocalRateLimitPolicy` (implementation-specific) |
| `add-base-url: true` | `URLRewrite` filter |
| `use-regex: true` | `RegularExpression` path type |
| `cors-allow-origin: *` | `ResponseHeaderModifier` filter |

### Traffic Splitting (Canary Migration)

```yaml
# Canary deployment with weighted traffic splitting
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-canary
  namespace: production
spec:
  parentRefs:
  - name: production-gateway
    namespace: gateway-system
    sectionName: https
  hostnames:
  - "api.support.tools"
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /v2
    backendRefs:
    # 90% to stable, 10% to canary
    - name: api-service-stable
      port: 8080
      weight: 90
    - name: api-service-canary
      port: 8080
      weight: 10
```

### Header-Based Routing (Replace Canary Annotations)

```yaml
# Route canary traffic based on header (for A/B testing)
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-ab-test
  namespace: production
spec:
  parentRefs:
  - name: production-gateway
    namespace: gateway-system
    sectionName: https
  hostnames:
  - "api.support.tools"
  rules:
  # Canary: requests with X-Canary: true header
  - matches:
    - path:
        type: PathPrefix
        value: /
      headers:
      - name: X-Canary
        value: "true"
    backendRefs:
    - name: api-service-canary
      port: 8080
  # Stable: all other requests
  - matches:
    - path:
        type: PathPrefix
        value: /
    backendRefs:
    - name: api-service-stable
      port: 8080
```

### URL Rewriting

```yaml
# Replace nginx rewrite-target annotation
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-rewrite
  namespace: production
spec:
  parentRefs:
  - name: production-gateway
    namespace: gateway-system
  hostnames:
  - "app.support.tools"
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /legacy-api
    filters:
    - type: URLRewrite
      urlRewrite:
        path:
          type: ReplacePrefixMatch
          replacePrefixMatch: /api/v1
    backendRefs:
    - name: api-service
      port: 8080
```

## Step 4: Phased Migration Strategy

### Phase 1: Deploy Gateway API Infrastructure (Week 1-2)

```bash
# Install Gateway API CRDs and implementation without touching existing Ingress
kubectl apply -f gatewayclass.yaml
kubectl apply -f gateway-production.yaml

# Label namespaces that will be migrated
kubectl label namespace production gateway-access=true
kubectl label namespace staging gateway-access=true

# Verify Gateway is ready
kubectl -n gateway-system get gateway production-gateway
# Expected: PROGRAMMED=True, READY=True
```

### Phase 2: Migrate Non-Production Namespaces (Week 3-4)

Start with development and staging environments to validate behavior:

```bash
# Migrate staging namespace
for ingress in $(kubectl -n staging get ingress -o name); do
    name=$(echo $ingress | cut -d/ -f2)
    # Convert using migration tool or manually
    echo "Migrating $name in staging..."
    # Apply equivalent HTTPRoute
done

# Verify traffic reaches backends correctly
kubectl -n staging run test-pod --image=curlimages/curl --rm -it -- \
  curl -H "Host: staging-app.support.tools" http://production-gateway.gateway-system.svc.cluster.local/health
```

### Phase 3: Shadow Traffic in Production (Week 5-6)

Mirror production traffic to the new gateway without impacting existing Ingress:

```yaml
# Request mirroring to validate new gateway behavior
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-shadow
  namespace: production
spec:
  parentRefs:
  - name: production-gateway  # New Gateway API gateway
    namespace: gateway-system
  hostnames:
  - "api-shadow.support.tools"  # Temporary shadow hostname
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /
    filters:
    - type: RequestMirror
      requestMirror:
        backendRef:
          name: api-shadow-sink  # Log and discard mirror traffic
          port: 8080
    backendRefs:
    - name: api-service
      port: 8080
```

Route production traffic to the shadow hostname via DNS CNAME pointing at the new gateway's LoadBalancer IP, while the main hostname still points at the legacy Ingress controller. Compare response codes, latency, and error rates.

### Phase 4: Cut Over Production (Week 7-8)

Migrate production namespaces one service at a time:

```bash
# Script to cut over a single service
#!/bin/bash
SERVICE_NAME="$1"
NAMESPACE="$2"

# 1. Verify HTTPRoute exists and is accepted
ROUTE_STATUS=$(kubectl -n "$NAMESPACE" get httproute "$SERVICE_NAME" \
  -o jsonpath='{.status.parents[0].conditions[?(@.type=="Accepted")].status}')
if [[ "$ROUTE_STATUS" != "True" ]]; then
    echo "ERROR: HTTPRoute $SERVICE_NAME not accepted"
    exit 1
fi

# 2. Update DNS to point at new Gateway (or update LoadBalancer annotation)
NEW_GW_IP=$(kubectl -n gateway-system get svc nginx-gateway-nginx-gateway-fabric \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
echo "New gateway IP: $NEW_GW_IP"
echo "Update DNS $SERVICE_NAME.support.tools -> $NEW_GW_IP"

# 3. Monitor for 30 minutes before deleting old Ingress
echo "Monitoring for 30 minutes..."
sleep 1800

# 4. Check error rate
ERROR_COUNT=$(kubectl -n "$NAMESPACE" logs deploy/"$SERVICE_NAME" --since=30m | grep -c "ERROR" || true)
if [[ "$ERROR_COUNT" -gt 10 ]]; then
    echo "ERROR: Too many errors after migration, rolling back DNS"
    exit 1
fi

# 5. Delete old Ingress
kubectl -n "$NAMESPACE" delete ingress "$SERVICE_NAME"
echo "Migration complete for $SERVICE_NAME"
```

## Step 5: Cross-Namespace Reference Grants

Gateway API requires explicit permission for cross-namespace references to prevent namespace-hopping attacks:

```yaml
# ReferenceGrant: allow Gateway in gateway-system to reference
# TLS secrets in cert-manager namespace
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-gateway-tls
  namespace: cert-manager
spec:
  from:
  - group: gateway.networking.k8s.io
    kind: Gateway
    namespace: gateway-system
  to:
  - group: ""
    kind: Secret
---
# ReferenceGrant: allow HTTPRoutes in production to reference
# services in shared-services namespace
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-production-routes
  namespace: shared-services
spec:
  from:
  - group: gateway.networking.k8s.io
    kind: HTTPRoute
    namespace: production
  to:
  - group: ""
    kind: Service
```

## Step 6: TLS Certificate Management

### cert-manager Integration with Gateway API

```yaml
# Certificate managed by cert-manager, referenced by Gateway
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: wildcard-support-tools
  namespace: gateway-system
spec:
  secretName: wildcard-support-tools-tls
  issuerRef:
    name: letsencrypt-production
    kind: ClusterIssuer
  dnsNames:
  - "*.support.tools"
  - "support.tools"
---
# Gateway references the cert-manager-managed secret
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: production-gateway
  namespace: gateway-system
  annotations:
    cert-manager.io/issuer: letsencrypt-production  # Auto-provision certs
spec:
  gatewayClassName: nginx-production
  listeners:
  - name: https
    port: 443
    protocol: HTTPS
    tls:
      mode: Terminate
      certificateRefs:
      - name: wildcard-support-tools-tls
        kind: Secret
        group: ""
```

## Monitoring the Migration

### HTTPRoute Status Checking

```bash
# Check all HTTPRoute statuses
kubectl get httproute -A -o json | jq -r '
  .items[] |
  "\(.metadata.namespace)/\(.metadata.name): " +
  (.status.parents[0].conditions[] | select(.type == "Accepted") | "\(.type)=\(.status) \(.message)")
'

# Check for any routes not accepted
kubectl get httproute -A -o json | jq -r '
  .items[] |
  select(.status.parents[0].conditions[] | select(.type == "Accepted" and .status != "True")) |
  "\(.metadata.namespace)/\(.metadata.name): NOT ACCEPTED"
'
```

### Gateway Status Checking

```bash
# Check Gateway listener status
kubectl -n gateway-system get gateway production-gateway -o yaml | \
  yq '.status.listeners[] | {"name": .name, "attachedRoutes": .attachedRoutes, "conditions": .conditions}'
```

### Prometheus Metrics for Migration Validation

Key metrics to compare between old Ingress and new Gateway API during cutover:

```promql
# Request success rate comparison (nginx Ingress)
sum(rate(nginx_ingress_controller_requests{status!~"5.."}[5m]))
/
sum(rate(nginx_ingress_controller_requests[5m]))

# Request success rate (NGINX Gateway Fabric)
sum(rate(nginx_gateway_fabric_http_upstream_server_requests_total{outcome="PASSED"}[5m]))
/
sum(rate(nginx_gateway_fabric_http_upstream_server_requests_total[5m]))

# P99 latency comparison
histogram_quantile(0.99,
  sum(rate(nginx_ingress_controller_request_duration_seconds_bucket[5m])) by (le, ingress))

histogram_quantile(0.99,
  sum(rate(nginx_gateway_fabric_http_request_duration_seconds_bucket[5m])) by (le, route))
```

## Coexistence Period Best Practices

During the migration period, both Ingress and Gateway API resources coexist. Key rules:

1. **Never have both an Ingress and HTTPRoute serving the same hostname and path** - traffic will split unpredictably between controllers
2. **Use separate LoadBalancer IPs** for old Ingress controller and new Gateway; update DNS record by record
3. **Maintain rollback DNS TTLs** - lower TTL to 60 seconds before cutover, restore to 300 after validation
4. **Log correlation** - ensure access logs from both controllers include a common request ID header for comparison

```bash
# Find any conflicting hostname coverage
kubectl get ingress -A -o json | jq -r '.items[] | .spec.rules[].host' | sort > ingress-hosts.txt
kubectl get httproute -A -o json | jq -r '.items[] | .spec.hostnames[]' | sort > gateway-hosts.txt
comm -12 ingress-hosts.txt gateway-hosts.txt  # Shows conflicts
```

## Summary

Migrating from Kubernetes Ingress to Gateway API is a structured process that pays dividends in operational clarity and capability. The role-oriented model separates infrastructure concerns from application routing concerns. Annotation-heavy Ingress manifests become explicit, portable HTTPRoute objects that work across Gateway implementations. The phased approach—infrastructure first, non-production validation, shadow traffic, and service-by-service production cutover—manages risk without requiring a big-bang migration that could impact availability. Once fully migrated, teams gain native traffic splitting, header-based routing, and URL rewriting without controller-specific annotation dialects.
