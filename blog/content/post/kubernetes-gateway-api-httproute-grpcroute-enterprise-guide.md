---
title: "Kubernetes Gateway API: Next-Generation Ingress with HTTPRoute and GRPCRoute"
date: 2030-06-20T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Gateway API", "Ingress", "HTTPRoute", "GRPCRoute", "Networking"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise Gateway API guide: Gateway, HTTPRoute, GRPCRoute resources, traffic splitting, header matching, TLS termination, backend policies, and migration from Ingress resources."
more_link: "yes"
url: "/kubernetes-gateway-api-httproute-grpcroute-enterprise-guide/"
---

The Kubernetes Gateway API (GA in Kubernetes 1.31) represents a comprehensive redesign of how ingress traffic is configured in Kubernetes. Where the Ingress API is limited to basic path and host routing with implementation-specific annotations, the Gateway API provides a rich, expressive resource model with first-class support for traffic splitting, header manipulation, gRPC routing, backend policies, and multi-tenant access control. This guide covers the complete Gateway API resource hierarchy, production routing patterns, TLS configuration, and migration from Ingress.

<!--more-->

## Gateway API Resource Hierarchy

The Gateway API introduces four primary resource types that form a clear ownership and responsibility hierarchy:

```
GatewayClass (cluster-scoped)
    ↓ defines
Gateway (namespace or cluster-scoped)
    ↓ accepts routes from
HTTPRoute / GRPCRoute / TCPRoute (namespace-scoped)
    ↓ routes to
Service → Pods
```

**GatewayClass**: Defines the type of Gateway controller (Envoy Gateway, Istio, Nginx, Kong). Created by cluster infrastructure teams. Analogous to IngressClass.

**Gateway**: A specific gateway instance with defined listeners. Created by cluster or network teams. Defines which ports, protocols, and TLS certificates are exposed.

**HTTPRoute / GRPCRoute**: Define routing rules from gateway to backend services. Created by application teams. No cluster-admin permissions required.

This separation of concerns is the primary advantage over the Ingress API, where infrastructure configuration (TLS, load balancing) and application routing are mixed in the same resource.

## GatewayClass

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: envoy-gateway
spec:
  # Reference to the gateway controller deployment
  controllerName: gateway.envoyproxy.io/gatewayclass-controller

  # Optional parameters customizing the gateway class behavior
  parametersRef:
    group: gateway.envoyproxy.io
    kind: EnvoyProxy
    name: production-envoy-config
    namespace: envoy-gateway-system
```

## Gateway Configuration

### HTTP and HTTPS Listeners

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: production-gateway
  namespace: networking
spec:
  gatewayClassName: envoy-gateway

  listeners:
    # HTTP listener: redirects to HTTPS
    - name: http
      protocol: HTTP
      port: 80
      allowedRoutes:
        namespaces:
          from: All

    # HTTPS listener: TLS termination
    - name: https
      protocol: HTTPS
      port: 443
      tls:
        mode: Terminate
        certificateRefs:
          # Wildcard certificate in the same namespace
          - name: wildcard-example-com-tls
            namespace: networking
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              gateway-access: allowed

    # Separate listener for internal APIs (different certificate)
    - name: internal-https
      protocol: HTTPS
      port: 8443
      hostname: "*.internal.example.com"
      tls:
        mode: Terminate
        certificateRefs:
          - name: wildcard-internal-example-com-tls
            namespace: networking
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              environment: production
```

### Multi-Tenant Gateway with Namespace Isolation

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: shared-gateway
  namespace: networking
spec:
  gatewayClassName: envoy-gateway

  listeners:
    - name: team-alpha-https
      protocol: HTTPS
      port: 443
      hostname: "*.alpha.example.com"
      tls:
        mode: Terminate
        certificateRefs:
          - name: alpha-example-com-tls
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              team: alpha

    - name: team-beta-https
      protocol: HTTPS
      port: 443
      hostname: "*.beta.example.com"
      tls:
        mode: Terminate
        certificateRefs:
          - name: beta-example-com-tls
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              team: beta
```

## HTTPRoute

### Basic Path Routing

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-service-routes
  namespace: production
spec:
  parentRefs:
    # Attach to the production gateway
    - name: production-gateway
      namespace: networking
      sectionName: https  # Specific listener

  hostnames:
    - "api.example.com"

  rules:
    # Route /v1 API to v1 service
    - matches:
        - path:
            type: PathPrefix
            value: /v1
      backendRefs:
        - name: api-service-v1
          port: 8080
          weight: 100

    # Route /v2 API to v2 service
    - matches:
        - path:
            type: PathPrefix
            value: /v2
      backendRefs:
        - name: api-service-v2
          port: 8080

    # Route /health to dedicated health service
    - matches:
        - path:
            type: Exact
            value: /health
      backendRefs:
        - name: api-health-service
          port: 8080
```

### Traffic Splitting for Canary Deployments

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-canary-route
  namespace: production
spec:
  parentRefs:
    - name: production-gateway
      namespace: networking
      sectionName: https

  hostnames:
    - "api.example.com"

  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        # 90% to stable version
        - name: api-service-stable
          port: 8080
          weight: 90
        # 10% to canary version
        - name: api-service-canary
          port: 8080
          weight: 10
```

### Header-Based Routing

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: header-based-routing
  namespace: production
spec:
  parentRefs:
    - name: production-gateway
      namespace: networking
      sectionName: https

  hostnames:
    - "api.example.com"

  rules:
    # Route beta users to canary (header: X-Beta-User: true)
    - matches:
        - path:
            type: PathPrefix
            value: /
          headers:
            - name: X-Beta-User
              value: "true"
      backendRefs:
        - name: api-service-canary
          port: 8080

    # Route internal traffic by User-Agent
    - matches:
        - path:
            type: PathPrefix
            value: /
          headers:
            - name: User-Agent
              type: RegularExpression
              value: "InternalMonitor/.*"
      backendRefs:
        - name: api-service-internal
          port: 8080

    # Default route
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: api-service-stable
          port: 8080
```

### HTTP to HTTPS Redirect

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: http-redirect
  namespace: networking
spec:
  parentRefs:
    - name: production-gateway
      namespace: networking
      sectionName: http  # HTTP listener on port 80

  hostnames:
    - "*.example.com"

  rules:
    - filters:
        - type: RequestRedirect
          requestRedirect:
            scheme: https
            statusCode: 301
```

### Request/Response Header Manipulation

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: header-manipulation
  namespace: production
spec:
  parentRefs:
    - name: production-gateway
      namespace: networking
      sectionName: https

  hostnames:
    - "api.example.com"

  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api
      filters:
        # Add request headers before forwarding to backend
        - type: RequestHeaderModifier
          requestHeaderModifier:
            add:
              - name: X-Request-Source
                value: gateway
              - name: X-Environment
                value: production
            set:
              - name: X-Forwarded-Proto
                value: https
            remove:
              - X-Internal-Debug-Token

        # Modify response headers from backend
        - type: ResponseHeaderModifier
          responseHeaderModifier:
            add:
              - name: X-Content-Type-Options
                value: nosniff
              - name: X-Frame-Options
                value: DENY
              - name: Strict-Transport-Security
                value: "max-age=31536000; includeSubDomains"
            remove:
              - Server
              - X-Powered-By

      backendRefs:
        - name: api-service
          port: 8080
```

### URL Rewriting

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: path-rewrite
  namespace: production
spec:
  parentRefs:
    - name: production-gateway
      namespace: networking
      sectionName: https

  hostnames:
    - "api.example.com"

  rules:
    # Rewrite /legacy/v1 to /v1 for backward compatibility
    - matches:
        - path:
            type: PathPrefix
            value: /legacy
      filters:
        - type: URLRewrite
          urlRewrite:
            path:
              type: ReplacePrefixMatch
              replacePrefixMatch: /
      backendRefs:
        - name: api-service
          port: 8080

    # Rewrite hostname for internal routing
    - matches:
        - path:
            type: PathPrefix
            value: /external-api
      filters:
        - type: URLRewrite
          urlRewrite:
            hostname: internal-api.production.svc.cluster.local
            path:
              type: ReplacePrefixMatch
              replacePrefixMatch: /
      backendRefs:
        - name: internal-api
          port: 8080
```

## GRPCRoute

GRPCRoute (GA in Kubernetes 1.31) provides first-class routing for gRPC traffic:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
metadata:
  name: inventory-grpc-route
  namespace: production
spec:
  parentRefs:
    - name: production-gateway
      namespace: networking
      sectionName: https

  hostnames:
    - "grpc.example.com"

  rules:
    # Route all InventoryService calls to the inventory service
    - matches:
        - method:
            type: Exact
            service: inventory.v1.InventoryService
      backendRefs:
        - name: inventory-service
          port: 50051

    # Route UserService calls to user service
    - matches:
        - method:
            type: Exact
            service: user.v1.UserService
      backendRefs:
        - name: user-service
          port: 50051

    # Route a specific method to a different backend
    - matches:
        - method:
            type: Exact
            service: inventory.v1.InventoryService
            method: BulkUpdateStock
      backendRefs:
        # Bulk operations go to high-memory backend
        - name: inventory-service-bulk
          port: 50051
```

### gRPC Traffic Splitting

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
metadata:
  name: inventory-grpc-canary
  namespace: production
spec:
  parentRefs:
    - name: production-gateway
      namespace: networking
      sectionName: https

  hostnames:
    - "grpc.example.com"

  rules:
    - matches:
        - method:
            type: Exact
            service: inventory.v1.InventoryService
      backendRefs:
        - name: inventory-service-v2
          port: 50051
          weight: 95
        - name: inventory-service-v3-canary
          port: 50051
          weight: 5
```

### gRPC Header-Based Routing

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
metadata:
  name: grpc-header-routing
  namespace: production
spec:
  parentRefs:
    - name: production-gateway
      namespace: networking
      sectionName: https

  rules:
    # Route test traffic to staging backend
    - matches:
        - method:
            type: Exact
            service: inventory.v1.InventoryService
          headers:
            - name: x-routing-tag
              value: staging
      backendRefs:
        - name: inventory-service-staging
          port: 50051

    # Default route
    - matches:
        - method:
            type: Exact
            service: inventory.v1.InventoryService
      backendRefs:
        - name: inventory-service
          port: 50051
```

## Backend Policies

### BackendTLSPolicy

Configure TLS for backend connections (useful for services that require TLS between gateway and pod):

```yaml
apiVersion: gateway.networking.k8s.io/v1alpha3
kind: BackendTLSPolicy
metadata:
  name: inventory-service-tls
  namespace: production
spec:
  targetRefs:
    - group: ""
      kind: Service
      name: inventory-service
  validation:
    caCertificateRefs:
      - group: ""
        kind: ConfigMap
        name: inventory-service-ca
    hostname: inventory-service.production.svc.cluster.local
```

### BackendLBPolicy

Configure load balancing algorithm for backend:

```yaml
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: BackendLBPolicy
metadata:
  name: least-connection-lb
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

## ReferenceGrant for Cross-Namespace Routing

Cross-namespace route attachment requires explicit authorization via `ReferenceGrant`:

```yaml
# In the 'networking' namespace (where the Gateway lives)
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-production-routes
  namespace: networking
spec:
  from:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      namespace: production
  to:
    - group: ""
      kind: Service

---
# In the 'networking' namespace: allow TLS cert reference from networking namespace
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-tls-cert-reference
  namespace: cert-manager
spec:
  from:
    - group: gateway.networking.k8s.io
      kind: Gateway
      namespace: networking
  to:
    - group: ""
      kind: Secret
```

## Observability: Status Conditions

Gateway API resources expose detailed status conditions:

```bash
# Check Gateway status
kubectl get gateway production-gateway -n networking -o yaml | \
  yq '.status.conditions'

# Expected output shows:
# - type: Accepted
#   status: "True"
# - type: Programmed
#   status: "True"

# Check HTTPRoute status
kubectl get httproute api-service-routes -n production -o yaml | \
  yq '.status.parents'

# Expected:
# - parentRef:
#     name: production-gateway
#     namespace: networking
#   conditions:
#   - type: Accepted
#     status: "True"
#   - type: ResolvedRefs
#     status: "True"
```

## Migration from Ingress

### Ingress to HTTPRoute Mapping

Most Ingress configurations have direct HTTPRoute equivalents:

**Before (Ingress)**:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-ingress
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/backend-protocol: "HTTP"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "60"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - api.example.com
      secretName: api-example-com-tls
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /v1
            pathType: Prefix
            backend:
              service:
                name: api-service-v1
                port:
                  number: 8080
          - path: /v2
            pathType: Prefix
            backend:
              service:
                name: api-service-v2
                port:
                  number: 8080
```

**After (Gateway API)**:

```yaml
# Gateway (created once by platform team)
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: production-gateway
  namespace: networking
spec:
  gatewayClassName: envoy-gateway
  listeners:
    - name: http
      port: 80
      protocol: HTTP
      allowedRoutes:
        namespaces:
          from: All
    - name: https
      port: 443
      protocol: HTTPS
      tls:
        mode: Terminate
        certificateRefs:
          - name: api-example-com-tls
            namespace: cert-manager
      allowedRoutes:
        namespaces:
          from: All

---
# HTTPRoute (created by application team, no cluster-admin required)
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-routes
  namespace: production
spec:
  parentRefs:
    - name: production-gateway
      namespace: networking
      sectionName: https

  hostnames:
    - api.example.com

  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /v1
      backendRefs:
        - name: api-service-v1
          port: 8080

    - matches:
        - path:
            type: PathPrefix
            value: /v2
      backendRefs:
        - name: api-service-v2
          port: 8080

---
# HTTP to HTTPS redirect (separate from application team's concern)
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: http-redirect
  namespace: networking
spec:
  parentRefs:
    - name: production-gateway
      namespace: networking
      sectionName: http
  hostnames:
    - api.example.com
  rules:
    - filters:
        - type: RequestRedirect
          requestRedirect:
            scheme: https
            statusCode: 301
```

### Migration Checklist

```bash
#!/bin/bash
# migrate-ingress-to-gateway.sh
# Inventory all Ingress resources for migration

echo "=== Ingress Resources to Migrate ==="
kubectl get ingress --all-namespaces -o json | \
  jq -r '.items[] | [.metadata.namespace, .metadata.name, .spec.ingressClassName // "no-class"] | @tsv' | \
  column -t

echo ""
echo "=== Annotations Requiring Translation ==="
kubectl get ingress --all-namespaces -o json | \
  jq -r '.items[] | select(.metadata.annotations | length > 0) |
    [.metadata.namespace, .metadata.name, (.metadata.annotations | keys | join(","))] | @tsv' | \
  column -t

echo ""
echo "=== TLS Configurations ==="
kubectl get ingress --all-namespaces -o json | \
  jq -r '.items[] | select(.spec.tls) |
    [.metadata.namespace, .metadata.name, (.spec.tls[].secretName)] | @tsv' | \
  column -t
```

### Parallel Running During Migration

Run Ingress and HTTPRoute in parallel during transition. Traffic is served by whichever implementation handles the matching hostname:

```yaml
# Phase 1: Deploy Gateway and HTTPRoute
# Both Ingress and HTTPRoute serve traffic (A/B test for validation)

# Phase 2: Monitor Gateway API error rates
# Verify routing behavior matches Ingress

# Phase 3: Remove Ingress resources
kubectl delete ingress api-ingress -n production

# Phase 4: Remove Ingress controller (after all Ingress resources deleted)
```

## RBAC for Gateway API

```yaml
# Role allowing application teams to manage their own HTTPRoutes
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: gateway-route-manager
  namespace: production
rules:
  - apiGroups: ["gateway.networking.k8s.io"]
    resources: ["httproutes", "grpcroutes"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["gateway.networking.k8s.io"]
    resources: ["gateways"]
    verbs: ["get", "list", "watch"]  # Read-only for Gateways

---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: team-alpha-route-manager
  namespace: production
subjects:
  - kind: Group
    name: team-alpha
    apiGroup: rbac.authorization.k8s.io
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: gateway-route-manager
```

## Alerting for Gateway API

```yaml
groups:
  - name: gateway_api_alerts
    rules:
      - alert: GatewayNotProgrammed
        expr: |
          gatewayapi_gateway_status_condition{type="Programmed",status="False"} == 1
        for: 5m
        labels:
          severity: critical
          team: platform
        annotations:
          summary: "Gateway {{ $labels.name }} is not programmed"
          description: |
            Gateway {{ $labels.namespace }}/{{ $labels.name }} has Programmed=False.
            Check gateway controller logs and GatewayClass status.

      - alert: HTTPRouteNotAccepted
        expr: |
          gatewayapi_httproute_status_condition{type="Accepted",status="False"} == 1
        for: 5m
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "HTTPRoute {{ $labels.name }} not accepted by Gateway"
          description: |
            HTTPRoute {{ $labels.namespace }}/{{ $labels.name }} has Accepted=False.
            Verify parentRef configuration and ReferenceGrant if cross-namespace.
```

## Summary

The Kubernetes Gateway API provides a production-grade, extensible traffic management layer that addresses all major limitations of the Ingress API. The key advantages in enterprise environments:

- **Role separation**: Infrastructure teams manage Gateway resources; application teams manage Route resources without cluster-admin permissions
- **Expressive routing**: HTTPRoute and GRPCRoute support traffic splitting, header manipulation, URL rewriting, and method-level gRPC routing natively
- **Cross-namespace safety**: ReferenceGrant provides explicit authorization for cross-namespace resource references
- **Status observability**: Every resource exposes structured status conditions that reflect controller state
- **Portability**: Gateway API implementations are standardized; migrating between implementations requires only GatewayClass changes

Migration from Ingress should be incremental: deploy Gateway API resources in parallel, validate routing equivalence, then remove Ingress resources. The improved role model and feature set make Gateway API the recommended long-term standard for all Kubernetes ingress configuration.
