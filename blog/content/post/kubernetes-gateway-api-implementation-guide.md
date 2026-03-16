---
title: "Kubernetes Gateway API: The Next Generation of Ingress"
date: 2027-05-06T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Gateway API", "Ingress", "Networking", "HTTPRoute", "GatewayClass"]
categories: ["Kubernetes", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Kubernetes Gateway API covering GatewayClass, Gateway, HTTPRoute, TCPRoute, and TLSRoute resources, traffic splitting, header manipulation, and migration from Ingress."
more_link: "yes"
url: "/kubernetes-gateway-api-implementation-guide/"
---

The Kubernetes Ingress API has served the community well since 2015, but its design reflects a simpler era. A single resource type—Ingress—must express every routing need, leading implementations to rely on a chaotic jungle of vendor-specific annotations. NGINX uses `nginx.ingress.kubernetes.io/rewrite-target`; Traefik uses `traefik.ingress.kubernetes.io/router.middlewares`; AWS ALB uses `alb.ingress.kubernetes.io/scheme`. These annotations are neither portable nor type-safe. Ingress also conflates infrastructure concerns (which load balancer to provision) with application concerns (how to route traffic), giving both platform teams and development teams the same object to fight over.

Gateway API addresses all of this. Released as GA in Kubernetes 1.28, it introduces a role-oriented, expressive, and extensible API that separates infrastructure provisioning from application routing—giving platform engineers, cluster operators, and application developers distinct resources they each own.

<!--more-->

## Executive Summary

Kubernetes Gateway API replaces Ingress with a structured hierarchy of resources: GatewayClass (infrastructure), Gateway (cluster operator), and Route objects (HTTPRoute, TCPRoute, TLSRoute, GRPCRoute) for application developers. This guide covers the full feature set including advanced HTTPRoute capabilities (header matching, weight-based canary splits, redirects, URL rewrites), TLS termination, cross-namespace routing, implementation options (Envoy Gateway and NGINX Gateway Fabric), and a concrete migration path from Ingress.

## Gateway API Resource Model

### The Role Hierarchy

Gateway API is designed around three user personas, each owning a specific set of resources:

```
Infrastructure Provider
  └── GatewayClass (cluster-scoped)
         "Which controller handles Gateways of this class?"

Cluster Operator
  └── Gateway (namespace-scoped)
         "Which ports/protocols does this load balancer expose?
          Which namespaces may attach routes?"

Application Developer
  └── HTTPRoute / TCPRoute / TLSRoute / GRPCRoute (namespace-scoped)
         "How should traffic be routed to my services?"
```

This separation is significant: a development team can deploy an HTTPRoute without needing cluster-admin access. The platform team controls the Gateway (and therefore the load balancer lifecycle) independently of application routing changes.

### Resource Relationships

```
GatewayClass: envoy-gateway
    │
    ▼
Gateway: prod-gateway (namespace: gateway-system)
    ├── Listener: HTTP  port 80
    ├── Listener: HTTPS port 443  ← TLS cert from Secret
    │
    ▼  (Route attaches via parentRef)
HTTPRoute: shop-routes (namespace: shop)
    ├── Match: /api/*  → backend: api-service:8080
    └── Match: /       → backend: frontend-service:3000

HTTPRoute: admin-routes (namespace: admin)
    └── Match: /admin/ → backend: admin-service:9090
```

## Installing Gateway API CRDs

Gateway API ships independently of Kubernetes core. Always install the CRDs before deploying an implementation.

```bash
# Install the standard channel CRDs (GA resources)
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/standard-install.yaml

# Install the experimental channel (includes TCPRoute, TLSRoute, GRPCRoute)
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/experimental-install.yaml

# Verify CRDs are available
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

## Implementation Options

### Envoy Gateway

Envoy Gateway is the CNCF-blessed implementation backed by the same community that maintains Envoy proxy and xDS. It supports the full standard channel and most experimental resources.

```bash
# Install Envoy Gateway
helm repo add eg https://charts.envoyproxy.io
helm repo update

helm upgrade --install eg eg/gateway-helm \
  --namespace envoy-gateway-system \
  --create-namespace \
  --version 1.1.0 \
  --wait

# Verify controller is running
kubectl get pods -n envoy-gateway-system
```

### NGINX Gateway Fabric

NGINX Gateway Fabric from F5 is an alternative backed by NGINX's OSS engine. Well-suited for teams already running NGINX Ingress Controller.

```bash
# Install NGINX Gateway Fabric
helm repo add nginx-gateway https://helm.nginx.com/stable
helm repo update

helm upgrade --install ngf nginx-gateway/nginx-gateway-fabric \
  --namespace nginx-gateway \
  --create-namespace \
  --version 1.4.0 \
  --set service.type=LoadBalancer \
  --wait
```

## GatewayClass Configuration

GatewayClass is the cluster-scoped resource that links a controller implementation to any number of Gateways.

```yaml
# GatewayClass for Envoy Gateway
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: envoy-gateway
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
  description: "Production Envoy-based gateway class"
  parametersRef:
    group: gateway.envoyproxy.io
    kind: EnvoyProxy
    name: production-proxy-config
    namespace: envoy-gateway-system
---
# EnvoyProxy configuration (Envoy Gateway extension)
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: production-proxy-config
  namespace: envoy-gateway-system
spec:
  provider:
    type: Kubernetes
    kubernetes:
      envoyDeployment:
        replicas: 3
        container:
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 1Gi
        pod:
          affinity:
            podAntiAffinity:
              requiredDuringSchedulingIgnoredDuringExecution:
              - labelSelector:
                  matchLabels:
                    app.kubernetes.io/component: proxy
                topologyKey: topology.kubernetes.io/zone
  telemetry:
    accessLog:
      settings:
      - format:
          type: Text
          text: |
            [%START_TIME%] "%REQ(:METHOD)% %REQ(X-ENVOY-ORIGINAL-PATH?:PATH)% %PROTOCOL%"
            %RESPONSE_CODE% %GRPC_STATUS% %RESPONSE_FLAGS%
            %BYTES_RECEIVED% %BYTES_SENT% %DURATION%
            "%REQ(USER-AGENT)%" "%REQ(X-FORWARDED-FOR)%"
      sinks:
      - type: File
        file:
          path: /dev/stdout
    metrics:
      prometheus: {}
    tracing:
      provider:
        host: jaeger-collector.observability.svc.cluster.local
        port: 4317
        type: OpenTelemetry
      samplingRate: 1
```

## Gateway Resource

The Gateway resource is owned by the cluster operator. It defines what the load balancer exposes and which namespaces may attach routes.

```yaml
# Production Gateway with HTTP and HTTPS listeners
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: prod-gateway
  namespace: gateway-system
  annotations:
    # Request a specific IP from MetalLB or cloud provider
    "service.beta.kubernetes.io/aws-load-balancer-type": "nlb"
spec:
  gatewayClassName: envoy-gateway
  listeners:
  # HTTP listener — redirects to HTTPS
  - name: http
    protocol: HTTP
    port: 80
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchLabels:
            gateway.networking.k8s.io/attach-allowed: "true"

  # HTTPS listener — TLS termination at gateway
  - name: https
    protocol: HTTPS
    port: 443
    tls:
      mode: Terminate
      certificateRefs:
      - name: wildcard-tls-cert
        namespace: gateway-system
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchLabels:
            gateway.networking.k8s.io/attach-allowed: "true"

  # HTTPS passthrough — TLS terminated at backend
  - name: https-passthrough
    protocol: TLS
    port: 8443
    tls:
      mode: Passthrough
    allowedRoutes:
      kinds:
      - kind: TLSRoute
      namespaces:
        from: All
---
# Label namespaces that may attach routes
kubectl label namespace shop gateway.networking.k8s.io/attach-allowed=true
kubectl label namespace api  gateway.networking.k8s.io/attach-allowed=true
```

### Multi-Listener Gateway for Different Environments

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: multi-env-gateway
  namespace: gateway-system
spec:
  gatewayClassName: envoy-gateway
  listeners:
  - name: prod-https
    hostname: "*.example.com"
    protocol: HTTPS
    port: 443
    tls:
      mode: Terminate
      certificateRefs:
      - name: example-com-tls
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchLabels:
            environment: production

  - name: staging-https
    hostname: "*.staging.example.com"
    protocol: HTTPS
    port: 443
    tls:
      mode: Terminate
      certificateRefs:
      - name: staging-example-com-tls
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchLabels:
            environment: staging

  - name: dev-http
    hostname: "*.dev.example.internal"
    protocol: HTTP
    port: 80
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchLabels:
            environment: development
```

## HTTPRoute Advanced Routing

HTTPRoute is the workhorse of Gateway API. It replaces Ingress for HTTP/HTTPS traffic and supports features that previously required annotations or custom resources.

### Basic Path-Based Routing

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: shop-routes
  namespace: shop
spec:
  parentRefs:
  - name: prod-gateway
    namespace: gateway-system
    sectionName: https    # attach to the HTTPS listener specifically
  hostnames:
  - "shop.example.com"
  rules:
  # Route /api/* to API backend
  - matches:
    - path:
        type: PathPrefix
        value: /api
    backendRefs:
    - name: api-service
      port: 8080
      weight: 100

  # Route /static/* to CDN origin
  - matches:
    - path:
        type: PathPrefix
        value: /static
    backendRefs:
    - name: static-assets-service
      port: 80

  # Default route to frontend
  - matches:
    - path:
        type: PathPrefix
        value: /
    backendRefs:
    - name: frontend-service
      port: 3000
```

### Header-Based Routing

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: ab-test-routes
  namespace: shop
spec:
  parentRefs:
  - name: prod-gateway
    namespace: gateway-system
    sectionName: https
  hostnames:
  - "shop.example.com"
  rules:
  # Route beta users to new frontend
  - matches:
    - headers:
      - type: Exact
        name: "X-Feature-Flag"
        value: "new-ui"
    backendRefs:
    - name: frontend-v2-service
      port: 3000

  # Route mobile clients to mobile-optimised backend
  - matches:
    - headers:
      - type: RegularExpression
        name: "User-Agent"
        value: ".*(iPhone|Android|Mobile).*"
    backendRefs:
    - name: mobile-api-service
      port: 8080

  # Route based on query parameter (experimental)
  - matches:
    - queryParams:
      - type: Exact
        name: "version"
        value: "2"
    backendRefs:
    - name: api-v2-service
      port: 8080

  # Default backend
  - backendRefs:
    - name: frontend-service
      port: 3000
```

### Weight-Based Traffic Splitting (Canary Deployments)

```yaml
# Canary deployment: 10% to v2, 90% to v1
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-canary
  namespace: api
spec:
  parentRefs:
  - name: prod-gateway
    namespace: gateway-system
    sectionName: https
  hostnames:
  - "api.example.com"
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /v1/orders
    backendRefs:
    - name: orders-service-v1
      port: 8080
      weight: 90        # 90% of traffic to stable
    - name: orders-service-v2
      port: 8080
      weight: 10        # 10% of traffic to canary
```

Progressive canary rollout script:

```bash
#!/bin/bash
# progressive-canary.sh — gradually shift traffic from v1 to v2

NAMESPACE="api"
ROUTE_NAME="api-canary"
SERVICE_V1="orders-service-v1"
SERVICE_V2="orders-service-v2"
PORT=8080

for WEIGHT_V2 in 10 25 50 75 90 100; do
  WEIGHT_V1=$((100 - WEIGHT_V2))

  echo "Shifting traffic: ${WEIGHT_V1}% -> v1, ${WEIGHT_V2}% -> v2"

  kubectl patch httproute "$ROUTE_NAME" -n "$NAMESPACE" \
    --type='json' \
    -p="[
      {
        \"op\": \"replace\",
        \"path\": \"/spec/rules/0/backendRefs/0/weight\",
        \"value\": ${WEIGHT_V1}
      },
      {
        \"op\": \"replace\",
        \"path\": \"/spec/rules/0/backendRefs/1/weight\",
        \"value\": ${WEIGHT_V2}
      }
    ]"

  echo "Waiting 5 minutes for metrics collection..."
  sleep 300

  # Check error rate before proceeding
  ERROR_RATE=$(kubectl exec -n monitoring deploy/prometheus \
    -- promtool query instant \
    'rate(http_requests_total{service="orders-service-v2",status=~"5.."}[2m])
     / rate(http_requests_total{service="orders-service-v2"}[2m])' \
    | grep 'value' | awk '{print $2}')

  if (( $(echo "$ERROR_RATE > 0.01" | bc -l) )); then
    echo "Error rate too high (${ERROR_RATE}). Rolling back."
    kubectl patch httproute "$ROUTE_NAME" -n "$NAMESPACE" \
      --type='json' \
      -p='[
        {"op": "replace", "path": "/spec/rules/0/backendRefs/0/weight", "value": 100},
        {"op": "replace", "path": "/spec/rules/0/backendRefs/1/weight", "value": 0}
      ]'
    exit 1
  fi

  echo "Error rate acceptable. Continuing rollout."
done

echo "Canary rollout complete. 100% traffic on v2."
```

### HTTP Redirects and URL Rewrites

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: redirect-and-rewrite
  namespace: shop
spec:
  parentRefs:
  - name: prod-gateway
    namespace: gateway-system
  hostnames:
  - "shop.example.com"
  rules:
  # Redirect HTTP to HTTPS (attach to HTTP listener)
  - matches:
    - path:
        type: PathPrefix
        value: /
    filters:
    - type: RequestRedirect
      requestRedirect:
        scheme: https
        statusCode: 301
---
# Separate HTTPRoute on HTTPS listener for URL rewriting
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-rewrite
  namespace: api
spec:
  parentRefs:
  - name: prod-gateway
    namespace: gateway-system
    sectionName: https
  hostnames:
  - "api.example.com"
  rules:
  # Rewrite /api/v1/* to /v1/* on backend
  - matches:
    - path:
        type: PathPrefix
        value: /api/v1
    filters:
    - type: URLRewrite
      urlRewrite:
        path:
          type: ReplacePrefixMatch
          replacePrefixMatch: /v1
    backendRefs:
    - name: api-service
      port: 8080

  # Redirect old API paths to new versioned paths
  - matches:
    - path:
        type: PathPrefix
        value: /rest/
    filters:
    - type: RequestRedirect
      requestRedirect:
        path:
          type: ReplacePrefixMatch
          replacePrefixMatch: /api/v2/
        statusCode: 301
```

### Header Manipulation

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: header-manipulation
  namespace: api
spec:
  parentRefs:
  - name: prod-gateway
    namespace: gateway-system
    sectionName: https
  hostnames:
  - "api.example.com"
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /
    filters:
    # Add headers before forwarding to backend
    - type: RequestHeaderModifier
      requestHeaderModifier:
        add:
        - name: "X-Gateway-Version"
          value: "2.0"
        - name: "X-Forwarded-Proto"
          value: "https"
        set:
        - name: "X-Real-IP"
          value: "%REQ(X-Forwarded-For)%"
        remove:
        - "X-Internal-Debug"

    # Add security headers in response
    - type: ResponseHeaderModifier
      responseHeaderModifier:
        add:
        - name: "Strict-Transport-Security"
          value: "max-age=31536000; includeSubDomains"
        - name: "X-Content-Type-Options"
          value: "nosniff"
        - name: "X-Frame-Options"
          value: "DENY"
        - name: "Cache-Control"
          value: "no-store"
        remove:
        - "Server"
        - "X-Powered-By"

    backendRefs:
    - name: api-service
      port: 8080
```

## TLS Configuration

### TLS Termination at the Gateway

```yaml
# Create TLS secret
kubectl create secret tls example-com-tls \
  --cert=./certs/example.com.crt \
  --key=./certs/example.com.key \
  -n gateway-system

# Or use cert-manager to manage certificates
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: example-com-tls
  namespace: gateway-system
spec:
  secretName: example-com-tls
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  dnsNames:
  - "example.com"
  - "*.example.com"
```

### TLS Passthrough

For workloads that must terminate TLS themselves (e.g., mutual TLS applications):

```yaml
# TLSRoute for passthrough
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: TLSRoute
metadata:
  name: database-tls-passthrough
  namespace: database
spec:
  parentRefs:
  - name: prod-gateway
    namespace: gateway-system
    sectionName: https-passthrough
  hostnames:
  - "db.internal.example.com"
  rules:
  - backendRefs:
    - name: postgres-service
      port: 5432
```

### Automatic HTTPS with cert-manager Integration

```yaml
# Gateway referencing cert-manager managed certificate
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: auto-tls-gateway
  namespace: gateway-system
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
spec:
  gatewayClassName: envoy-gateway
  listeners:
  - name: https
    port: 443
    protocol: HTTPS
    hostname: "*.example.com"
    tls:
      mode: Terminate
      certificateRefs:
      - kind: Secret
        name: wildcard-example-com-tls
    allowedRoutes:
      namespaces:
        from: All
```

## TCPRoute

TCPRoute enables L4 routing for non-HTTP protocols. Useful for databases, message brokers, and custom TCP applications.

```yaml
# Expose PostgreSQL via Gateway
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: TCPRoute
metadata:
  name: postgres-route
  namespace: database
spec:
  parentRefs:
  - name: tcp-gateway
    namespace: gateway-system
    sectionName: postgres
  rules:
  - backendRefs:
    - name: postgres-service
      port: 5432
---
# Gateway with dedicated TCP listener for PostgreSQL
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: tcp-gateway
  namespace: gateway-system
spec:
  gatewayClassName: envoy-gateway
  listeners:
  - name: postgres
    protocol: TCP
    port: 5432
    allowedRoutes:
      kinds:
      - group: gateway.networking.k8s.io
        kind: TCPRoute
      namespaces:
        from: Selector
        selector:
          matchLabels:
            allow-tcp-routes: "true"
```

## Cross-Namespace Routing

Gateway API uses ReferenceGrant to explicitly allow cross-namespace backend references. This is a critical security feature that prevents one namespace from arbitrarily accessing services in another.

```yaml
# In the 'api' namespace: allow routes in 'shop' namespace to reference services here
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-shop-to-api
  namespace: api            # grant lives in the target namespace
spec:
  from:
  - group: gateway.networking.k8s.io
    kind: HTTPRoute
    namespace: shop         # only routes from 'shop' may use this grant
  to:
  - group: ""
    kind: Service
---
# HTTPRoute in 'shop' namespace referencing service in 'api' namespace
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: cross-namespace-route
  namespace: shop
spec:
  parentRefs:
  - name: prod-gateway
    namespace: gateway-system
  hostnames:
  - "shop.example.com"
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /api/inventory
    backendRefs:
    - name: inventory-service
      namespace: api         # cross-namespace reference — requires ReferenceGrant
      port: 8080
```

## GRPCRoute

GRPCRoute (GA in 1.28) provides native routing for gRPC services without requiring HTTP/2 annotations.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
metadata:
  name: order-grpc-route
  namespace: orders
spec:
  parentRefs:
  - name: prod-gateway
    namespace: gateway-system
    sectionName: https
  hostnames:
  - "grpc.api.example.com"
  rules:
  # Route specific gRPC methods to new service
  - matches:
    - method:
        service: orders.v2.OrderService
        method: CreateOrder
    backendRefs:
    - name: orders-v2-service
      port: 9090
      weight: 20
    - name: orders-v1-service
      port: 9090
      weight: 80

  # All other gRPC calls to stable service
  - matches:
    - method:
        service: orders.v1.OrderService
    backendRefs:
    - name: orders-v1-service
      port: 9090
```

## Migrating from Ingress to Gateway API

### Side-by-Side Comparison

```yaml
# ─── BEFORE: Ingress ───────────────────────────────────────────────────────
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: shop-ingress
  namespace: shop
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/rewrite-target: /$2
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-weight: "10"
    nginx.ingress.kubernetes.io/proxy-connect-timeout: "30"
    nginx.ingress.kubernetes.io/add-base-url: "true"
spec:
  ingressClassName: nginx
  tls:
  - hosts: ["shop.example.com"]
    secretName: shop-tls
  rules:
  - host: shop.example.com
    http:
      paths:
      - path: /api(/|$)(.*)
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

# ─── AFTER: Gateway API ────────────────────────────────────────────────────
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: shop-routes
  namespace: shop
spec:
  parentRefs:
  - name: prod-gateway
    namespace: gateway-system
    sectionName: https    # TLS termination handled by Gateway
  hostnames:
  - "shop.example.com"
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /api
    filters:
    - type: URLRewrite
      urlRewrite:
        path:
          type: ReplacePrefixMatch
          replacePrefixMatch: /
    backendRefs:
    - name: api-service
      port: 8080
      weight: 90
    - name: api-service-v2
      port: 8080
      weight: 10        # canary is now first-class, not an annotation

  - matches:
    - path:
        type: PathPrefix
        value: /
    backendRefs:
    - name: frontend-service
      port: 3000
```

### Migration Script

```bash
#!/bin/bash
# ingress-to-gateway-audit.sh
# Audits all Ingress resources and outputs migration notes

echo "=== Gateway API Migration Audit ==="
echo ""

kubectl get ingress -A -o json | jq -r '
.items[] | {
  namespace: .metadata.namespace,
  name: .metadata.name,
  class: (.metadata.annotations["kubernetes.io/ingress.class"] // .spec.ingressClassName),
  annotations: (.metadata.annotations | keys | map(select(startswith("nginx.ingress") or startswith("traefik") or startswith("alb"))))
}' | while IFS= read -r LINE; do
  echo "$LINE"
done

echo ""
echo "=== Annotation Migration Reference ==="
cat <<'MIGRATION_TABLE'
NGINX Annotation                              → Gateway API Equivalent
───────────────────────────────────────────────────────────────────────
nginx.ingress.kubernetes.io/rewrite-target  → HTTPRoute.filters.URLRewrite
nginx.ingress.kubernetes.io/ssl-redirect    → HTTPRoute.filters.RequestRedirect (HTTP listener)
nginx.ingress.kubernetes.io/canary-weight   → HTTPRoute.backendRefs[].weight
nginx.ingress.kubernetes.io/proxy-*         → BackendLBPolicy (experimental)
nginx.ingress.kubernetes.io/configuration-snippet → HTTPRoute.filters.RequestHeaderModifier
nginx.ingress.kubernetes.io/server-snippet  → EnvoyProxy extensionRef (Envoy-specific)
MIGRATION_TABLE
```

### Gradual Migration with Both in Place

Both Ingress and Gateway API can run simultaneously. Migrate one route at a time and verify behaviour before removing old Ingress objects.

```bash
# Step 1: Deploy Gateway alongside existing Ingress controller
helm upgrade --install eg eg/gateway-helm \
  --namespace envoy-gateway-system \
  --create-namespace

# Step 2: Create Gateway with new DNS name initially
# e.g., new.shop.example.com while old shop.example.com still uses Ingress

# Step 3: Create HTTPRoute objects pointing at same backends
# Step 4: Test new routes thoroughly

# Step 5: Update DNS to point shop.example.com at Gateway IP
# Step 6: Monitor error rates for 24 hours

# Step 7: Remove old Ingress objects
kubectl delete ingress shop-ingress -n shop
```

## Monitoring Gateway API Resources

### Status Conditions

Gateway API provides rich status conditions. Always check these after creating/modifying resources.

```bash
# Check Gateway status
kubectl describe gateway prod-gateway -n gateway-system

# Check HTTPRoute status — look for "ResolvedRefs" and "Accepted" conditions
kubectl describe httproute shop-routes -n shop

# Quick health check across all routes
kubectl get httproutes -A -o json | jq '
.items[] | {
  name: .metadata.name,
  namespace: .metadata.namespace,
  conditions: (.status.parents[]?.conditions // []) | map({type: .type, status: .status, reason: .reason})
}'
```

### Prometheus Metrics

```yaml
# ServiceMonitor for Envoy Gateway metrics
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: envoy-gateway-metrics
  namespace: envoy-gateway-system
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: gateway-helm
  endpoints:
  - port: metrics
    interval: 15s
    path: /metrics
---
# PrometheusRule for Gateway API health
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: gateway-api-alerts
  namespace: monitoring
spec:
  groups:
  - name: gateway-api.rules
    rules:
    - alert: GatewayAPIHighErrorRate
      expr: |
        sum(rate(envoy_http_downstream_rq_5xx[5m])) by (namespace, name)
        /
        sum(rate(envoy_http_downstream_rq_total[5m])) by (namespace, name)
        > 0.05
      for: 2m
      labels:
        severity: warning
      annotations:
        summary: "High error rate on Gateway"
        description: "Gateway {{ $labels.name }} error rate is {{ $value | humanizePercentage }}"

    - alert: GatewayAPIHighLatency
      expr: |
        histogram_quantile(0.99,
          sum(rate(envoy_http_downstream_rq_time_bucket[5m])) by (le, namespace, name)
        ) > 1000
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "High p99 latency on Gateway"
        description: "p99 latency is {{ $value }}ms on {{ $labels.name }}"

    - alert: HTTPRouteNotAccepted
      expr: |
        kube_customresource_status_condition{
          customresource_kind="HTTPRoute",
          condition="Accepted",
          status="False"
        } == 1
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "HTTPRoute not accepted by Gateway"
        description: "{{ $labels.customresource_name }} in {{ $labels.namespace }} is not accepted"
```

## Policy Attachment (Advanced)

Gateway API supports attaching policies to Gateway or HTTPRoute resources to control timeouts, retries, and TLS settings declaratively.

```yaml
# BackendLBPolicy — configure load balancing for a backend service
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: BackendLBPolicy
metadata:
  name: api-lb-policy
  namespace: api
spec:
  targetRef:
    group: ""
    kind: Service
    name: api-service
  sessionPersistence:
    sessionName: "api-session"
    type: Cookie
    cookieConfig:
      lifetimeType: Session
---
# HTTPRouteFilter for timeout policy (Envoy Gateway extension)
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendTrafficPolicy
metadata:
  name: api-traffic-policy
  namespace: api
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: api-routes
  timeout:
    request: 30s
  retry:
    numRetries: 3
    retryOn:
    - gateway-error
    - connect-failure
    - retriable-4xx
    perRetry:
      timeout: 10s
      backOff:
        baseInterval: 1s
        maxInterval: 10s
  circuitBreaker:
    maxConnections: 1024
    maxPendingRequests: 512
    maxParallelRequests: 256
    maxParallelRetries: 10
```

Gateway API represents a fundamental shift in how Kubernetes networking is managed. By separating infrastructure concerns (GatewayClass, Gateway) from application routing (HTTPRoute, TCPRoute), it enables teams to operate at their appropriate level of abstraction while providing portable, type-safe configuration that works consistently across all conformant implementations.
