---
title: "Kubernetes Gateway API: Next-Generation Ingress and Traffic Management"
date: 2029-04-02T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Gateway API", "Ingress", "Networking", "Service Mesh", "Traffic Management"]
categories: ["Kubernetes", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Kubernetes Gateway API: Gateway API vs Ingress, HTTPRoute, GRPCRoute, TLSRoute, GAMMA service mesh integration, and multi-cluster traffic management patterns."
more_link: "yes"
url: "/kubernetes-gateway-api-next-generation-ingress-traffic-management/"
---

Kubernetes Ingress has served the community well for years, but its opaque annotation-based extensibility model created a proliferation of controller-specific hacks that made configurations non-portable. The Gateway API is the official successor: a formally specified, role-oriented, extensible API designed by the SIG-Network community. It reached Generally Available status for core features and is now the recommended approach for new Kubernetes networking configurations.

<!--more-->

# Kubernetes Gateway API: Next-Generation Ingress and Traffic Management

## Section 1: Gateway API vs Ingress

The fundamental architectural difference is role separation. The Ingress API conflates the concerns of infrastructure administrators (which load balancer to use) and application developers (which paths to route).

### Ingress Limitations

```yaml
# Traditional Ingress - everything in one object
# Who owns this? Infrastructure team? App team?
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-app
  annotations:
    # Controller-specific, not portable
    nginx.ingress.kubernetes.io/rewrite-target: /
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"
    nginx.ingress.kubernetes.io/rate-limiting: "100"
    # Completely different annotations on Traefik or HAProxy
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - myapp.example.com
      secretName: myapp-tls
  rules:
    - host: myapp.example.com
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: api-service
                port:
                  number: 8080
```

### Gateway API Role Model

```
Infrastructure Provider
    ├── GatewayClass (defines available infrastructure)

Cluster Operator
    ├── Gateway (provisions load balancer/proxy instance)
    └── ReferenceGrant (cross-namespace authorization)

Application Developer
    ├── HTTPRoute / GRPCRoute / TLSRoute / TCPRoute
    └── (attaches to Gateway, controls traffic to own services)
```

## Section 2: Installing Gateway API CRDs

```bash
# Install standard channel (stable features)
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/standard-install.yaml

# Install experimental channel (includes GRPCRoute, ParentReference, etc.)
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/experimental-install.yaml

# Verify CRDs
kubectl get crd | grep gateway.networking.k8s.io
```

### Installing an Implementation

Multiple implementations are available. We'll use Envoy Gateway as it follows the spec closely:

```bash
# Install Envoy Gateway
helm install eg oci://docker.io/envoyproxy/gateway-helm \
  --version v1.2.0 \
  -n envoy-gateway-system \
  --create-namespace

# Verify installation
kubectl get pods -n envoy-gateway-system
kubectl get gatewayclass
```

## Section 3: GatewayClass and Gateway

### GatewayClass - Infrastructure Template

```yaml
# Defined by infrastructure provider, not application teams
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: envoy-gateway
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
  description: "Envoy-based gateway for production traffic"
  parametersRef:
    group: gateway.envoyproxy.io
    kind: EnvoyProxy
    name: default
    namespace: envoy-gateway-system
```

### Gateway - Load Balancer Instance

```yaml
# Defined by cluster operators
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: production-gateway
  namespace: gateway-infra
spec:
  gatewayClassName: envoy-gateway
  listeners:
    # HTTP listener - will redirect to HTTPS
    - name: http
      protocol: HTTP
      port: 80
      allowedRoutes:
        namespaces:
          from: All

    # HTTPS listener with TLS termination
    - name: https
      protocol: HTTPS
      port: 443
      tls:
        mode: Terminate
        certificateRefs:
          - name: wildcard-tls-cert
            namespace: gateway-infra
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              gateway-access: "allowed"

    # Passthrough for mTLS applications
    - name: https-passthrough
      protocol: TLS
      port: 8443
      tls:
        mode: Passthrough
      allowedRoutes:
        namespaces:
          from: All

    # gRPC listener
    - name: grpc
      protocol: HTTPS
      port: 9443
      tls:
        mode: Terminate
        certificateRefs:
          - name: grpc-tls-cert
            namespace: gateway-infra
      allowedRoutes:
        namespaces:
          from: All
```

### Namespace Isolation with allowedRoutes

```yaml
# More restrictive: only specific namespaces can attach
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: team-a-gateway
  namespace: gateway-infra
spec:
  gatewayClassName: envoy-gateway
  listeners:
    - name: https
      protocol: HTTPS
      port: 443
      tls:
        mode: Terminate
        certificateRefs:
          - name: team-a-cert
            namespace: gateway-infra
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              team: team-a
        kinds:
          - group: gateway.networking.k8s.io
            kind: HTTPRoute
```

## Section 4: HTTPRoute - The Core Routing Primitive

HTTPRoute is the primary object application developers interact with:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-service-routes
  namespace: team-a-apps
spec:
  parentRefs:
    # Attach to the production gateway
    - name: production-gateway
      namespace: gateway-infra
      sectionName: https  # Attach to specific listener

  hostnames:
    - "api.example.com"
    - "api-v2.example.com"

  rules:
    # Route /v1 traffic to v1 backend
    - matches:
        - path:
            type: PathPrefix
            value: /v1
          headers:
            - name: X-API-Version
              value: "1"
              type: Exact
      backendRefs:
        - name: api-v1-service
          port: 8080
          weight: 100

    # Route /v2 traffic to v2 backend with header stripping
    - matches:
        - path:
            type: PathPrefix
            value: /v2
      filters:
        - type: RequestHeaderModifier
          requestHeaderModifier:
            set:
              - name: X-Forwarded-For-Real
                value: "{{ request.remoteAddr }}"
            add:
              - name: X-Request-ID
                value: "{{ uuid }}"
            remove:
              - X-Internal-Token
      backendRefs:
        - name: api-v2-service
          port: 8080
          weight: 100

    # Canary: 5% of /v3 traffic to canary, 95% to stable
    - matches:
        - path:
            type: PathPrefix
            value: /v3
      backendRefs:
        - name: api-v3-stable
          port: 8080
          weight: 95
        - name: api-v3-canary
          port: 8080
          weight: 5

    # Redirect HTTP to HTTPS
    - matches:
        - path:
            type: PathPrefix
            value: /
      filters:
        - type: RequestRedirect
          requestRedirect:
            scheme: https
            statusCode: 301

    # URL rewriting
    - matches:
        - path:
            type: PathPrefix
            value: /legacy
      filters:
        - type: URLRewrite
          urlRewrite:
            path:
              type: ReplacePrefixMatch
              replacePrefixMatch: /api/v1
      backendRefs:
        - name: api-v1-service
          port: 8080
```

### Advanced HTTPRoute Matching

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: advanced-routing
  namespace: my-app
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-infra

  hostnames:
    - "app.example.com"

  rules:
    # Match by header value (A/B testing)
    - matches:
        - headers:
            - name: X-Beta-User
              value: "true"
              type: Exact
      backendRefs:
        - name: beta-backend
          port: 8080

    # Match by query parameter
    - matches:
        - queryParams:
            - name: version
              value: "next"
              type: Exact
      backendRefs:
        - name: next-backend
          port: 8080

    # Match by HTTP method
    - matches:
        - method: POST
          path:
            type: PathPrefix
            value: /api/write
      backendRefs:
        - name: write-backend
          port: 8080

    - matches:
        - method: GET
          path:
            type: PathPrefix
            value: /api
      backendRefs:
        - name: read-backend
          port: 8080

    # Regular expression path matching (experimental)
    - matches:
        - path:
            type: RegularExpression
            value: "^/users/[0-9]+/profile$"
      backendRefs:
        - name: user-service
          port: 8080
```

## Section 5: GRPCRoute

GRPCRoute is purpose-built for gRPC traffic, providing service and method-level routing:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
metadata:
  name: grpc-routing
  namespace: grpc-services
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-infra
      sectionName: grpc

  hostnames:
    - "grpc.example.com"

  rules:
    # Route UserService to user microservice
    - matches:
        - method:
            type: Exact
            service: user.v1.UserService
      backendRefs:
        - name: user-grpc-service
          port: 9090

    # Route OrderService.CreateOrder to write replicas
    - matches:
        - method:
            type: Exact
            service: order.v1.OrderService
            method: CreateOrder
      backendRefs:
        - name: order-write-service
          port: 9090

    # Route all read methods to read replicas
    - matches:
        - method:
            type: Exact
            service: order.v1.OrderService
            method: GetOrder
        - method:
            type: Exact
            service: order.v1.OrderService
            method: ListOrders
      backendRefs:
        - name: order-read-service
          port: 9090

    # Header-based routing for internal vs external gRPC
    - matches:
        - headers:
            - name: x-internal-request
              value: "true"
              type: Exact
      backendRefs:
        - name: internal-grpc-backend
          port: 9090

    # Default: route all gRPC to general backend
    - backendRefs:
        - name: default-grpc-backend
          port: 9090
```

## Section 6: TLSRoute and TCPRoute

### TLSRoute - SNI-Based Passthrough

```yaml
# TLSRoute: SNI-based routing without TLS termination
# The backend receives the TLS traffic and handles termination itself
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: TLSRoute
metadata:
  name: tls-passthrough-routing
  namespace: tls-services
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-infra
      sectionName: https-passthrough

  hostnames:
    - "db.internal.example.com"
    - "cache.internal.example.com"

  rules:
    - backendRefs:
        - name: postgres-service
          port: 5432
```

### TCPRoute - L4 Routing

```yaml
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: TCPRoute
metadata:
  name: tcp-routing
  namespace: tcp-services
spec:
  parentRefs:
    - name: tcp-gateway
      namespace: gateway-infra

  rules:
    - backendRefs:
        - name: mysql-service
          port: 3306
          weight: 100
```

## Section 7: Cross-Namespace References and ReferenceGrant

Gateway API enforces namespace isolation. A route in namespace A cannot reference a service in namespace B without explicit authorization:

```yaml
# In namespace gateway-infra: allow the Gateway to reference certs
# in tls-certs namespace
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-gateway-tls-access
  namespace: tls-certs  # The namespace being accessed
spec:
  from:
    - group: gateway.networking.k8s.io
      kind: Gateway
      namespace: gateway-infra  # The namespace making the reference
  to:
    - group: ""
      kind: Secret

---
# In namespace backend-services: allow HTTPRoute in team-a-apps
# to reference services in backend-services
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-team-a-route-access
  namespace: backend-services
spec:
  from:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      namespace: team-a-apps
  to:
    - group: ""
      kind: Service
      name: shared-api-service  # Restrict to specific service
```

## Section 8: GAMMA - Service Mesh Integration

GAMMA (Gateway API for Mesh Management and Administration) extends Gateway API to manage east-west traffic within the mesh, not just north-south ingress:

```yaml
# HTTPRoute for mesh traffic (east-west)
# No parentRef to a Gateway - attaches to a Service instead
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: product-service-mesh-routing
  namespace: ecommerce
spec:
  parentRefs:
    # Reference the Service itself, not a Gateway
    # This controls how clients of this service are load balanced
    - group: ""
      kind: Service
      name: product-service
      port: 8080

  rules:
    # Canary deployment: 10% to new version
    - backendRefs:
        - name: product-service-v2
          port: 8080
          weight: 10
        - name: product-service-v1
          port: 8080
          weight: 90

---
# Session affinity via header-based routing in mesh
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: sticky-session-routing
  namespace: ecommerce
spec:
  parentRefs:
    - group: ""
      kind: Service
      name: cart-service
      port: 8080

  rules:
    # Route users with session cookie to specific backend
    - matches:
        - headers:
            - name: X-Session-Shard
              value: "shard-1"
      backendRefs:
        - name: cart-service-shard-1
          port: 8080

    - matches:
        - headers:
            - name: X-Session-Shard
              value: "shard-2"
      backendRefs:
        - name: cart-service-shard-2
          port: 8080
```

### Istio with Gateway API (GAMMA)

```yaml
# Istio supports Gateway API natively
# Install Istio with Gateway API support
istioctl install --set profile=minimal \
  --set values.pilot.env.PILOT_ENABLE_GATEWAY_API=true \
  --set values.pilot.env.PILOT_ENABLE_GATEWAY_API_DEPLOYMENT_CONTROLLER=true

---
# Use Gateway API for Istio ingress
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: istio-gateway
  namespace: istio-system
spec:
  gatewayClassName: istio
  listeners:
    - name: https
      protocol: HTTPS
      port: 443
      tls:
        mode: Terminate
        certificateRefs:
          - name: istio-gateway-cert
      allowedRoutes:
        namespaces:
          from: All

---
# Traffic policy with Istio-specific extension
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-route
  namespace: production
spec:
  parentRefs:
    - name: istio-gateway
      namespace: istio-system

  hostnames:
    - "api.example.com"

  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      filters:
        - type: RequestHeaderModifier
          requestHeaderModifier:
            add:
              - name: X-Forwarded-Host
                value: "api.example.com"
      backendRefs:
        - name: api-service
          port: 8080
```

## Section 9: Multi-Cluster Traffic Management

Gateway API is being extended for multi-cluster scenarios through the Multicluster Extension:

```yaml
# ServiceImport - represents a service imported from another cluster
# (part of multicluster-controller or Cilium Cluster Mesh)
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceImport
metadata:
  name: global-api-service
  namespace: production
spec:
  type: ClusterSetIP
  ports:
    - port: 8080
      protocol: TCP

---
# HTTPRoute routing to a multicluster ServiceImport
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: global-routing
  namespace: production
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-infra

  hostnames:
    - "api.global.example.com"

  rules:
    # Send 50% to each cluster
    - backendRefs:
        - group: multicluster.x-k8s.io
          kind: ServiceImport
          name: api-service-cluster-1
          port: 8080
          weight: 50
        - group: multicluster.x-k8s.io
          kind: ServiceImport
          name: api-service-cluster-2
          port: 8080
          weight: 50
```

## Section 10: Policy Attachments

Gateway API v1.1+ supports attaching policies to routes and gateways:

```yaml
# BackendLBPolicy - load balancing configuration per backend
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: BackendLBPolicy
metadata:
  name: api-lb-policy
  namespace: production
spec:
  targetRef:
    group: ""
    kind: Service
    name: api-service
  sessionPersistence:
    sessionName: api-session
    type: Cookie
    cookieConfig:
      lifetimeType: Session

---
# BackendTLSPolicy - mTLS to backend
apiVersion: gateway.networking.k8s.io/v1alpha3
kind: BackendTLSPolicy
metadata:
  name: backend-mtls
  namespace: production
spec:
  targetRef:
    group: ""
    kind: Service
    name: api-service
    namespace: production
  validation:
    caCertificateRefs:
      - name: backend-ca
        namespace: production
        group: ""
        kind: ConfigMap
    hostname: api-service.production.svc.cluster.local
    wellKnownCACertificates: System

---
# Implementation-specific policy via extension
# (Envoy Gateway-specific timeout policy)
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendTrafficPolicy
metadata:
  name: api-traffic-policy
  namespace: production
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: api-routes
  timeout:
    tcp:
      connectTimeout: 10s
    http:
      requestTimeout: 30s
      connectionIdleTimeout: 60s
  circuitBreaker:
    maxConnections: 1024
    maxParallelRequests: 1024
    maxParallelRetries: 3
  loadBalancer:
    type: ConsistentHash
    consistentHash:
      type: Header
      header:
        name: X-User-ID
```

## Section 11: Migration from Ingress

### Automated Migration Tool

```bash
# Use ingress2gateway tool for automated migration
go install sigs.k8s.io/ingress2gateway@latest

# Convert existing Ingress resources to Gateway API
ingress2gateway print \
  --input-file ./ingress.yaml \
  --providers nginx \
  --output-file ./gateway-api-resources.yaml

# Preview what would be generated
ingress2gateway print \
  --all-resources \
  --providers nginx
```

### Manual Migration Example

```yaml
# BEFORE: Ingress with nginx annotations
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-app
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /$2
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "30"
    nginx.ingress.kubernetes.io/rate-limit: "100"
spec:
  ingressClassName: nginx
  rules:
    - host: app.example.com
      http:
        paths:
          - path: /api(/|$)(.*)
            pathType: Prefix
            backend:
              service:
                name: api
                port:
                  number: 8080
```

```yaml
# AFTER: Gateway API equivalent
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: my-app
  namespace: production
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-infra
      sectionName: https

  hostnames:
    - "app.example.com"

  rules:
    # HTTP to HTTPS redirect (replaces ssl-redirect annotation)
    - matches:
        - path:
            type: PathPrefix
            value: /api
      filters:
        # URL rewrite (replaces rewrite-target annotation)
        - type: URLRewrite
          urlRewrite:
            path:
              type: ReplacePrefixMatch
              replacePrefixMatch: /
      backendRefs:
        - name: api
          port: 8080

# Timeout policy (replaces proxy-read-timeout annotation)
---
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendTrafficPolicy
metadata:
  name: my-app-timeout
  namespace: production
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: my-app
  timeout:
    http:
      requestTimeout: 30s
```

## Section 12: Observability Integration

### Prometheus Metrics for Envoy Gateway

```yaml
# EnvoyProxy configuration with metrics
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: default
  namespace: envoy-gateway-system
spec:
  telemetry:
    metrics:
      prometheus:
        disable: false
    tracing:
      provider:
        type: OpenTelemetry
        host: otel-collector.monitoring.svc.cluster.local
        port: 4317
    accessLog:
      settings:
        - text:
            format: |
              {"start_time":"%START_TIME%","method":"%REQ(:METHOD)%",
              "path":"%REQ(X-ENVOY-ORIGINAL-PATH?:PATH)%",
              "response_code":"%RESPONSE_CODE%","duration":"%DURATION%",
              "upstream_host":"%UPSTREAM_HOST%","route_name":"%ROUTE_NAME%"}
```

### ServiceMonitor for Gateway Metrics

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: envoy-gateway-metrics
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app.kubernetes.io/component: proxy
      app.kubernetes.io/managed-by: envoy-gateway
  namespaceSelector:
    any: true
  endpoints:
    - port: metrics
      interval: 30s
      path: /stats/prometheus
```

## Section 13: Troubleshooting Gateway API

```bash
# Check Gateway status - shows listener-level errors
kubectl get gateway production-gateway -n gateway-infra -o yaml | \
  yq '.status'

# Check HTTPRoute status - shows parent attachment and route acceptance
kubectl get httproute api-routes -n production -o yaml | \
  yq '.status'

# Check reason field for route rejection
kubectl describe httproute api-routes -n production

# Common status conditions:
# Accepted: true  - Route is accepted by the gateway
# ResolvedRefs: true - All backend refs are resolvable
# Programmed: true - Route is applied to the data plane

# Debug using gateway events
kubectl get events -n gateway-infra --field-selector involvedObject.kind=Gateway

# Check Envoy Gateway logs
kubectl logs -n envoy-gateway-system \
  -l app.kubernetes.io/name=envoy-gateway \
  --tail=100 -f

# Check if routes are programmed in Envoy
kubectl exec -n envoy-gateway-system \
  <envoy-pod> -- \
  curl -s http://localhost:19000/config_dump | \
  jq '.configs[] | select(.["@type"] | contains("RouteConfiguration"))'

# Verify ReferenceGrant is correct for cross-namespace refs
kubectl get referencegrant -A
```

### Common Errors and Solutions

```
Error: BackendNotFound
Cause: HTTPRoute references a service in another namespace without ReferenceGrant
Fix: Create ReferenceGrant in the target namespace

Error: ListenerNotFound
Cause: HTTPRoute parentRef sectionName doesn't match any listener
Fix: Check listener names in Gateway spec

Error: NoMatchingListenerHostname
Cause: HTTPRoute hostname doesn't match any listener's hostname filter
Fix: Ensure HTTPRoute hostname matches what the Gateway listener allows

Error: NotAllowedByListeners
Cause: HTTPRoute namespace not in allowedRoutes selector
Fix: Add label matching the Gateway's allowedRoutes selector to the namespace
```

## Summary

The Kubernetes Gateway API represents a significant maturation of the Kubernetes networking API surface. Its key advantages over Ingress are:

1. **Role separation**: Infrastructure owners control Gateway, application teams own Routes. Each layer is independently manageable.

2. **Portability**: Core routing features (HTTP path/header matching, TLS, redirects) work across all conformant implementations without annotation hacks.

3. **Expressiveness**: HTTPRoute supports traffic splitting, header manipulation, URL rewriting, and method-based matching in-spec rather than through annotations.

4. **Extensibility via policies**: Implementation-specific features (timeouts, circuit breakers, rate limiting) attach to routes via policy objects rather than polluting the core spec.

5. **Service mesh integration**: GAMMA enables the same API to manage both ingress and mesh-internal traffic routing.

Migration from Ingress is straightforward for most use cases, and the `ingress2gateway` tool automates the common patterns. New deployments should start with Gateway API directly.
