---
title: "Kubernetes Gateway API Advanced: HTTPRoute, GRPCRoute, and Multi-Cluster Patterns"
date: 2027-08-07T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Gateway API", "Networking", "Service Mesh", "Traffic Management"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "An advanced guide to Kubernetes Gateway API v1 covering GatewayClass, HTTPRoute matching and traffic splitting, GRPCRoute, ReferenceGrant, TLSRoute, Envoy Gateway, Cilium Gateway API support, and migration patterns from Ingress."
more_link: "yes"
url: "/kubernetes-gateway-api-advanced-guide/"
---

The Kubernetes Gateway API reached v1 stable status and has become the standard for advanced ingress and traffic management in Kubernetes. Unlike the Ingress resource, which was designed for simple HTTP routing and extended through opaque annotations, the Gateway API provides a role-oriented, extensible model that supports HTTP, HTTPS, gRPC, TLS passthrough, and TCP routing through native Kubernetes resources. This guide covers every major feature with production-ready configurations.

<!--more-->

# [Kubernetes Gateway API Advanced](#kubernetes-gateway-api-advanced)

## Section 1: Gateway API Architecture and Concepts

### Role-Oriented Design

The Gateway API separates concerns across three user roles:

- **Infrastructure Provider** manages GatewayClass resources, which define the controller implementing the gateway.
- **Cluster Operator** creates Gateway resources, which provision actual load balancers or proxies.
- **Application Developer** creates Route resources (HTTPRoute, GRPCRoute, etc.) that attach to Gateways and define routing rules.

This separation enables multi-tenant clusters where developers can manage their own routing without cluster-admin access.

### Core Resources

```
GatewayClass (cluster-scoped)
  └── Gateway (namespaced)
        ├── HTTPRoute (namespaced, may cross namespaces via ReferenceGrant)
        ├── GRPCRoute (namespaced)
        ├── TLSRoute (namespaced)
        └── TCPRoute (namespaced)
```

### Installing Gateway API CRDs

```bash
# Install Gateway API CRDs (standard channel - stable features)
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/standard-install.yaml

# Install experimental channel (includes TCPRoute, TLSRoute, GRPCRoute additions)
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/experimental-install.yaml

# Verify CRDs
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

## Section 2: GatewayClass and Gateway Resources

### GatewayClass

```yaml
# GatewayClass managed by Envoy Gateway
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: envoy-gateway
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
  parametersRef:
    group: gateway.envoyproxy.io
    kind: EnvoyProxy
    name: envoy-proxy-config
    namespace: envoy-gateway-system
  description: "Production Envoy Gateway for external traffic"
```

### Envoy Gateway Configuration

```yaml
# EnvoyProxy configuration for Envoy Gateway
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: envoy-proxy-config
  namespace: envoy-gateway-system
spec:
  provider:
    type: Kubernetes
    kubernetes:
      envoyDeployment:
        replicas: 3
        pod:
          affinity:
            podAntiAffinity:
              requiredDuringSchedulingIgnoredDuringExecution:
                - labelSelector:
                    matchLabels:
                      app.kubernetes.io/component: proxy
                  topologyKey: kubernetes.io/hostname
          topologySpreadConstraints:
            - maxSkew: 1
              topologyKey: topology.kubernetes.io/zone
              whenUnsatisfiable: DoNotSchedule
              labelSelector:
                matchLabels:
                  app.kubernetes.io/component: proxy
        container:
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
            limits:
              cpu: 2
              memory: 2Gi
      envoyService:
        type: LoadBalancer
        annotations:
          service.beta.kubernetes.io/aws-load-balancer-type: external
          service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: ip
          service.beta.kubernetes.io/aws-load-balancer-scheme: internet-facing
  logging:
    level:
      default: warn
```

### Gateway Resource

```yaml
# Gateway for production traffic
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: prod-gateway
  namespace: gateway-system
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  gatewayClassName: envoy-gateway
  listeners:
    - name: http
      port: 80
      protocol: HTTP
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              kubernetes.io/metadata.name: production
    - name: https
      port: 443
      protocol: HTTPS
      tls:
        mode: Terminate
        certificateRefs:
          - name: prod-tls-cert
            namespace: gateway-system
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              gateway-access: allowed
    - name: internal
      port: 8443
      protocol: HTTPS
      tls:
        mode: Terminate
        certificateRefs:
          - name: internal-tls-cert
            namespace: gateway-system
      allowedRoutes:
        namespaces:
          from: All
```

## Section 3: HTTPRoute Advanced Matching

### Path, Header, and Method Matching

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-route
  namespace: production
spec:
  parentRefs:
    - name: prod-gateway
      namespace: gateway-system
      sectionName: https
  hostnames:
    - "api.example.com"
  rules:
    # Exact path match for health endpoint
    - matches:
        - path:
            type: Exact
            value: /healthz
      backendRefs:
        - name: api-service
          port: 8080

    # Prefix path with header matching for v2 API
    - matches:
        - path:
            type: PathPrefix
            value: /api
          headers:
            - name: X-API-Version
              value: "v2"
      backendRefs:
        - name: api-v2-service
          port: 8080

    # Method-based routing for webhooks
    - matches:
        - path:
            type: PathPrefix
            value: /webhooks
          method: POST
      backendRefs:
        - name: webhook-handler
          port: 9000

    # Query parameter matching
    - matches:
        - path:
            type: PathPrefix
            value: /search
          queryParams:
            - name: format
              value: json
      backendRefs:
        - name: search-service
          port: 8080

    # Default rule - catch all
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: api-service
          port: 8080
```

### Request and Response Modification

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-with-filters
  namespace: production
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
            value: /api/v1
      filters:
        # Add headers to upstream request
        - type: RequestHeaderModifier
          requestHeaderModifier:
            add:
              - name: X-Forwarded-For-Custom
                value: "%{req.headers['X-Real-IP']}"
            set:
              - name: X-Cluster-Name
                value: prod-cluster
            remove:
              - X-Internal-Debug

        # Modify response headers
        - type: ResponseHeaderModifier
          responseHeaderModifier:
            add:
              - name: X-Content-Type-Options
                value: nosniff
              - name: X-Frame-Options
                value: DENY
              - name: Strict-Transport-Security
                value: max-age=31536000; includeSubDomains

        # URL rewrite - strip prefix before forwarding
        - type: URLRewrite
          urlRewrite:
            path:
              type: ReplacePrefixMatch
              replacePrefixMatch: /

      backendRefs:
        - name: api-service
          port: 8080

    # HTTP to HTTPS redirect at route level
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

## Section 4: Traffic Splitting for Canary Deployments

### Weighted Canary Deployment

```yaml
# HTTPRoute with weighted traffic splitting for canary
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-canary
  namespace: production
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
      backendRefs:
        # 90% traffic to stable version
        - name: api-stable
          port: 8080
          weight: 90
        # 10% traffic to canary version
        - name: api-canary
          port: 8080
          weight: 10
```

### Header-Based Canary Routing

Route a specific subset of users to the canary based on a header:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-header-canary
  namespace: production
spec:
  parentRefs:
    - name: prod-gateway
      namespace: gateway-system
      sectionName: https
  hostnames:
    - "api.example.com"
  rules:
    # Canary cohort via X-Canary-User header
    - matches:
        - path:
            type: PathPrefix
            value: /
          headers:
            - name: X-Canary-User
              value: "true"
      backendRefs:
        - name: api-canary
          port: 8080
          weight: 100

    # Default stable route
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: api-stable
          port: 8080
          weight: 100
```

### Gradual Canary Progression Script

```bash
#!/bin/bash
# Gradually shift traffic from stable to canary
ROUTE_NAME="api-canary"
NAMESPACE="production"

for CANARY_WEIGHT in 10 25 50 75 100; do
  STABLE_WEIGHT=$((100 - CANARY_WEIGHT))
  echo "Setting canary weight: ${CANARY_WEIGHT}%, stable: ${STABLE_WEIGHT}%"

  kubectl patch httproute "${ROUTE_NAME}" \
    -n "${NAMESPACE}" \
    --type=json \
    -p="[
      {\"op\":\"replace\",\"path\":\"/spec/rules/0/backendRefs/0/weight\",\"value\":${STABLE_WEIGHT}},
      {\"op\":\"replace\",\"path\":\"/spec/rules/0/backendRefs/1/weight\",\"value\":${CANARY_WEIGHT}}
    ]"

  # Wait and check error rates before continuing
  sleep 300

  ERROR_RATE=$(kubectl exec -n monitoring prometheus-0 -- \
    promtool query instant \
    'rate(http_requests_total{status=~"5..",backend="api-canary"}[5m]) / rate(http_requests_total{backend="api-canary"}[5m])' \
    2>/dev/null | grep -oP '\d+\.\d+' | head -1)

  if (( $(echo "${ERROR_RATE:-0} > 0.01" | bc -l) )); then
    echo "Error rate ${ERROR_RATE} exceeds 1%, rolling back canary"
    kubectl patch httproute "${ROUTE_NAME}" \
      -n "${NAMESPACE}" \
      --type=json \
      -p='[
        {"op":"replace","path":"/spec/rules/0/backendRefs/0/weight","value":100},
        {"op":"replace","path":"/spec/rules/0/backendRefs/1/weight","value":0}
      ]'
    exit 1
  fi

  echo "Canary healthy at ${CANARY_WEIGHT}%, proceeding..."
done

echo "Canary promotion complete"
```

## Section 5: GRPCRoute for gRPC Traffic

### GRPCRoute Configuration

GRPCRoute provides first-class routing for gRPC services, supporting service and method matching without needing to encode gRPC routing in HTTP path rules.

```yaml
# Gateway with HTTP/2 listener for gRPC
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: grpc-gateway
  namespace: gateway-system
spec:
  gatewayClassName: envoy-gateway
  listeners:
    - name: grpc
      port: 443
      protocol: HTTPS
      tls:
        mode: Terminate
        certificateRefs:
          - name: grpc-tls-cert
            namespace: gateway-system
      allowedRoutes:
        namespaces:
          from: All
        kinds:
          - group: gateway.networking.k8s.io
            kind: GRPCRoute
```

```yaml
# GRPCRoute for service routing
apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
metadata:
  name: user-service-route
  namespace: production
spec:
  parentRefs:
    - name: grpc-gateway
      namespace: gateway-system
  hostnames:
    - "grpc.example.com"
  rules:
    # Route all UserService methods to user-service
    - matches:
        - method:
            service: user.v1.UserService
      backendRefs:
        - name: user-service
          port: 9090
          weight: 100

    # Route only GetUser method to a specialized handler
    - matches:
        - method:
            service: user.v1.UserService
            method: GetUser
      filters:
        - type: RequestHeaderModifier
          requestHeaderModifier:
            add:
              - name: x-route
                value: get-user-handler
      backendRefs:
        - name: user-cache-service
          port: 9090
          weight: 80
        - name: user-service
          port: 9090
          weight: 20

    # Route all other RPC calls to general backend
    - backendRefs:
        - name: general-grpc-backend
          port: 9090
```

### gRPC Traffic Splitting

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
metadata:
  name: order-service-canary
  namespace: production
spec:
  parentRefs:
    - name: grpc-gateway
      namespace: gateway-system
  hostnames:
    - "grpc.example.com"
  rules:
    - matches:
        - method:
            service: order.v2.OrderService
      backendRefs:
        - name: order-service-stable
          port: 9090
          weight: 95
        - name: order-service-canary
          port: 9090
          weight: 5
```

## Section 6: ReferenceGrant for Cross-Namespace Routing

### Overview

By default, a Route resource can only reference backends in the same namespace. ReferenceGrant allows cluster operators to explicitly permit cross-namespace references, enabling centralized gateways that serve multiple application namespaces.

### Central Gateway Serving Multiple Namespaces

```yaml
# Gateway in dedicated gateway-system namespace
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: central-gateway
  namespace: gateway-system
spec:
  gatewayClassName: envoy-gateway
  listeners:
    - name: https
      port: 443
      protocol: HTTPS
      tls:
        mode: Terminate
        certificateRefs:
          - name: wildcard-tls-cert
            namespace: gateway-system
      allowedRoutes:
        namespaces:
          from: All
```

```yaml
# ReferenceGrant in the target namespace allowing gateway-system to reference services
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-gateway-system
  namespace: production
spec:
  from:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      namespace: gateway-system
  to:
    - group: ""
      kind: Service
---
# Or grant from the production namespace where routes live
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-cross-ns-backend
  namespace: backend-services
spec:
  from:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      namespace: production
  to:
    - group: ""
      kind: Service
      name: shared-auth-service
```

```yaml
# HTTPRoute in production namespace referencing backend in backend-services
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: cross-namespace-route
  namespace: production
spec:
  parentRefs:
    - name: central-gateway
      namespace: gateway-system
  hostnames:
    - "api.example.com"
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /auth
      backendRefs:
        - name: shared-auth-service
          namespace: backend-services
          port: 8080
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: api-service
          port: 8080
```

## Section 7: TLSRoute and TCPRoute

### TLSRoute for Passthrough Mode

TLSRoute is used when the gateway should pass through TLS traffic without terminating it, allowing the backend service to handle TLS directly (useful for databases, MQTT brokers, and services requiring end-to-end encryption).

```yaml
# Gateway listener in passthrough mode
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: passthrough-gateway
  namespace: gateway-system
spec:
  gatewayClassName: envoy-gateway
  listeners:
    - name: postgres
      port: 5432
      protocol: TLS
      tls:
        mode: Passthrough
      allowedRoutes:
        namespaces:
          from: All
        kinds:
          - group: gateway.networking.k8s.io
            kind: TLSRoute
```

```yaml
# TLSRoute for PostgreSQL passthrough
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: TLSRoute
metadata:
  name: postgres-route
  namespace: production
spec:
  parentRefs:
    - name: passthrough-gateway
      namespace: gateway-system
      sectionName: postgres
  hostnames:
    - db.internal.example.com
  rules:
    - backendRefs:
        - name: postgresql-primary
          port: 5432
```

### TCPRoute for Raw TCP

```yaml
# Gateway for TCP traffic
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: tcp-gateway
  namespace: gateway-system
spec:
  gatewayClassName: envoy-gateway
  listeners:
    - name: redis
      port: 6379
      protocol: TCP
      allowedRoutes:
        namespaces:
          from: All
        kinds:
          - group: gateway.networking.k8s.io
            kind: TCPRoute
```

```yaml
# TCPRoute for Redis
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: TCPRoute
metadata:
  name: redis-route
  namespace: production
spec:
  parentRefs:
    - name: tcp-gateway
      namespace: gateway-system
      sectionName: redis
  rules:
    - backendRefs:
        - name: redis-master
          port: 6379
```

## Section 8: Envoy Gateway Implementation

### Installing Envoy Gateway

```bash
# Install Envoy Gateway
helm install eg oci://docker.io/envoyproxy/gateway-helm \
  --version v1.2.0 \
  --namespace envoy-gateway-system \
  --create-namespace \
  --set deployment.replicas=2 \
  --set config.envoyGateway.gateway.controllerName=gateway.envoyproxy.io/gatewayclass-controller \
  --set config.envoyGateway.logging.level.default=warn

# Verify installation
kubectl get pods -n envoy-gateway-system
kubectl get gatewayclass envoy-gateway
```

### Envoy Gateway Extension Policies

Envoy Gateway provides extension resources for features not yet in the upstream Gateway API specification.

```yaml
# BackendTrafficPolicy for connection pool settings
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendTrafficPolicy
metadata:
  name: api-backend-policy
  namespace: production
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: api-route
  circuitBreaker:
    maxConnections: 1024
    maxPendingRequests: 1024
    maxParallelRequests: 1024
    maxParallelRetries: 3
    maxRequestsPerConnection: 0
  timeout:
    http:
      connectionIdleTimeout: 60s
      maxConnectionDuration: 0s
    tcp:
      connectTimeout: 10s
  loadBalancer:
    type: LeastRequest
  proxyProtocol:
    version: V2
---
# ClientTrafficPolicy for connection limits and TLS settings
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: ClientTrafficPolicy
metadata:
  name: prod-client-policy
  namespace: gateway-system
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: Gateway
    name: prod-gateway
  connection:
    connectionLimit:
      value: 10000
      closeDelay: 5s
  tls:
    minVersion: "1.2"
    maxVersion: "1.3"
    ciphers:
      - ECDHE-ECDSA-AES128-GCM-SHA256
      - ECDHE-RSA-AES128-GCM-SHA256
      - ECDHE-ECDSA-AES256-GCM-SHA384
      - ECDHE-RSA-AES256-GCM-SHA384
    ecdhCurves:
      - X25519
      - P-256
  headers:
    xForwardedClientCert:
      mode: AppendForward
      certDetailsToAdd:
        - Subject
        - URI
```

### Rate Limiting with Envoy Gateway

```yaml
# Global rate limit policy
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendTrafficPolicy
metadata:
  name: api-rate-limit
  namespace: production
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: api-route
  rateLimit:
    type: Global
    global:
      rules:
        - clientSelectors:
            - headers:
                - name: X-API-Key
                  type: Distinct
          limit:
            requests: 1000
            unit: Hour
        - clientSelectors:
            - sourceCIDR:
                type: Remote
                value: 0.0.0.0/0
          limit:
            requests: 100
            unit: Minute
```

## Section 9: Cilium Gateway API Support

### Enabling Cilium Gateway API

Cilium provides a high-performance Gateway API implementation that uses eBPF for traffic management without requiring a separate reverse proxy.

```bash
# Install Cilium with Gateway API support
helm install cilium cilium/cilium \
  --namespace kube-system \
  --set kubeProxyReplacement=true \
  --set gatewayAPI.enabled=true \
  --set gatewayAPI.secretsNamespace.name=gateway-system \
  --set ingressController.enabled=false \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true

# Verify GatewayClass created by Cilium
kubectl get gatewayclass cilium -o yaml
```

### Cilium Gateway Configuration

```yaml
# GatewayClass for Cilium
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: cilium
spec:
  controllerName: io.cilium/gateway-controller
---
# Gateway using Cilium
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: cilium-gateway
  namespace: gateway-system
  annotations:
    io.cilium/lb-ipam-ips: "10.10.0.100"
spec:
  gatewayClassName: cilium
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
          - name: wildcard-tls
            namespace: gateway-system
      allowedRoutes:
        namespaces:
          from: All
```

### Cilium L7 Traffic Management

Cilium's eBPF-based implementation enables L7-aware load balancing and observability through Hubble:

```bash
# Observe Gateway API traffic via Hubble
hubble observe \
  --namespace production \
  --protocol http \
  --verdict FORWARDED \
  -f

# Flow summary for a specific route
hubble observe \
  --namespace production \
  --from-label "app=api" \
  --to-label "app=backend" \
  -o json | jq '.flow.l7.http | {method, url, status_code}'
```

## Section 10: Comparison with Ingress Resources

### Feature Comparison

| Feature | Ingress | Gateway API |
|---|---|---|
| HTTP routing | Basic | Full (path, header, method, query) |
| Traffic splitting | Annotation-only | Native weighted backendRefs |
| gRPC routing | Not supported | GRPCRoute (native) |
| TCP/TLS passthrough | Controller-specific | TCPRoute/TLSRoute |
| Multi-tenancy | Single resource model | Role-oriented (GatewayClass/Gateway/Route) |
| Cross-namespace backends | Not supported | ReferenceGrant |
| Request/response filters | Annotations | Native filter types |
| Portability | Controller-specific annotations | Standard spec across controllers |
| Extensibility | Annotations | Policy attachment API |

### Why Migrate to Gateway API

Ingress resources accumulate controller-specific annotations that make configurations non-portable. A configuration for nginx-ingress looks completely different from one for the AWS Load Balancer Controller or Traefik. Gateway API standardizes these features, making configurations portable across implementations.

## Section 11: Migration from Ingress to Gateway API

### Audit Existing Ingress Resources

```bash
# List all Ingress resources and their annotations
kubectl get ingress --all-namespaces -o json | \
  jq -r '.items[] | "\(.metadata.namespace)/\(.metadata.name): \(.metadata.annotations | keys | join(","))"'

# Check which ingress class is in use
kubectl get ingress --all-namespaces -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}: {.spec.ingressClassName}{"\n"}{end}'
```

### Translating an Ingress to Gateway API

Before (Ingress with nginx annotations):

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: old-ingress
  namespace: production
  annotations:
    kubernetes.io/ingress.class: nginx
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/use-regex: "true"
    nginx.ingress.kubernetes.io/rewrite-target: /$2
    nginx.ingress.kubernetes.io/proxy-connect-timeout: "30"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "30"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "30"
    nginx.ingress.kubernetes.io/rate-limit: "100"
    nginx.ingress.kubernetes.io/rate-limit-window: "1m"
spec:
  tls:
    - hosts:
        - api.example.com
      secretName: api-tls
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /api/v1(/|$)(.*)
            pathType: Prefix
            backend:
              service:
                name: api-v1
                port:
                  number: 8080
          - path: /api/v2(/|$)(.*)
            pathType: Prefix
            backend:
              service:
                name: api-v2
                port:
                  number: 8080
```

After (Gateway API):

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-route
  namespace: production
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
            value: /api/v1
      filters:
        - type: URLRewrite
          urlRewrite:
            path:
              type: ReplacePrefixMatch
              replacePrefixMatch: /
        - type: ResponseHeaderModifier
          responseHeaderModifier:
            add:
              - name: Strict-Transport-Security
                value: max-age=31536000; includeSubDomains
      backendRefs:
        - name: api-v1
          port: 8080
    - matches:
        - path:
            type: PathPrefix
            value: /api/v2
      filters:
        - type: URLRewrite
          urlRewrite:
            path:
              type: ReplacePrefixMatch
              replacePrefixMatch: /
      backendRefs:
        - name: api-v2
          port: 8080
```

### Migration Tooling

The `ingress2gateway` tool from the Kubernetes SIG-Network team converts Ingress resources to Gateway API equivalents:

```bash
# Install ingress2gateway
go install sigs.k8s.io/ingress2gateway@latest

# Convert all Ingress resources in a namespace
ingress2gateway print \
  --namespace production \
  --providers nginx \
  --gateway-class-name envoy-gateway \
  --gateway-name prod-gateway \
  --all-resources \
  > gateway-api-converted.yaml

# Review and apply
kubectl apply -f gateway-api-converted.yaml --dry-run=client
kubectl apply -f gateway-api-converted.yaml
```

### Side-by-Side Migration

For zero-downtime migration, run both Ingress and Gateway API routes in parallel:

```bash
# Step 1: Deploy new HTTPRoute alongside existing Ingress
kubectl apply -f gateway-api-route.yaml

# Step 2: Test new route using Host header override
curl -H "Host: api.example.com" \
  --resolve "api.example.com:443:${GATEWAY_IP}" \
  https://api.example.com/healthz

# Step 3: Shift DNS to new Gateway IP (low TTL first)
# dns_record api.example.com TTL=60 -> ${GATEWAY_IP}

# Step 4: After validation, delete old Ingress
kubectl delete ingress old-ingress -n production
```

## Section 12: Multi-Cluster Gateway Patterns

### Shared Gateway with Cluster-Specific Routes

In a multi-cluster setup, a central Gateway (potentially running on a dedicated gateway cluster) can route traffic to services across multiple clusters using service mesh federation or multi-cluster service discovery.

```yaml
# Gateway that routes to multi-cluster services
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: multi-cluster-api
  namespace: gateway-system
spec:
  parentRefs:
    - name: global-gateway
      namespace: gateway-system
  hostnames:
    - "api.global.example.com"
  rules:
    # Route US traffic to US cluster
    - matches:
        - headers:
            - name: X-Region
              value: us
      backendRefs:
        - group: multicluster.x-k8s.io
          kind: ServiceImport
          name: api-service-us
          port: 8080

    # Route EU traffic to EU cluster
    - matches:
        - headers:
            - name: X-Region
              value: eu
      backendRefs:
        - group: multicluster.x-k8s.io
          kind: ServiceImport
          name: api-service-eu
          port: 8080

    # Default to US
    - backendRefs:
        - group: multicluster.x-k8s.io
          kind: ServiceImport
          name: api-service-us
          port: 8080
```

## Section 13: Observability and Debugging

### Gateway API Status Inspection

```bash
# Check HTTPRoute attachment and resolution status
kubectl describe httproute api-route -n production

# Check Gateway listener status
kubectl get gateway prod-gateway -n gateway-system -o yaml | \
  yq '.status.listeners'

# List all routes attached to a gateway
kubectl get httproute,grpcroute,tcproute,tlsroute \
  --all-namespaces \
  -o custom-columns=\
"NAMESPACE:.metadata.namespace,\
NAME:.metadata.name,\
HOSTNAMES:.spec.hostnames,\
PARENT:.spec.parentRefs[0].name"
```

### Verifying Route Conditions

```bash
# HTTPRoute conditions show resolution errors
kubectl get httproute api-route -n production \
  -o jsonpath='{.status.parents[0].conditions}' | jq .
```

Expected healthy output:
```json
[
  {
    "lastTransitionTime": "2027-08-07T10:00:00Z",
    "message": "Route is accepted",
    "observedGeneration": 1,
    "reason": "Accepted",
    "status": "True",
    "type": "Accepted"
  },
  {
    "lastTransitionTime": "2027-08-07T10:00:00Z",
    "message": "All references are resolved",
    "observedGeneration": 1,
    "reason": "ResolvedRefs",
    "status": "True",
    "type": "ResolvedRefs"
  }
]
```

### Envoy Gateway Metrics

```bash
# Envoy Gateway exposes Prometheus metrics
kubectl port-forward svc/envoy-envoy-gateway -n envoy-gateway-system 19000:19000

# View stats
curl -s http://localhost:19000/stats/prometheus | grep -E \
  "envoy_cluster_upstream_rq_total|envoy_http_downstream_rq"

# Envoy admin interface
curl -s http://localhost:19000/clusters | head -50
curl -s http://localhost:19000/config_dump | jq '.configs | length'
```

## Section 14: Security Patterns

### TLS Certificate Management with cert-manager

```yaml
# Certificate for Gateway (issued by cert-manager)
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: prod-tls-cert
  namespace: gateway-system
spec:
  secretName: prod-tls-cert
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  dnsNames:
    - "api.example.com"
    - "*.api.example.com"
  privateKey:
    rotationPolicy: Always
    algorithm: ECDSA
    size: 256
```

### mTLS with Gateway API

```yaml
# Configure mTLS on a Gateway listener
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: mtls-gateway
  namespace: gateway-system
spec:
  gatewayClassName: envoy-gateway
  listeners:
    - name: mtls
      port: 8443
      protocol: HTTPS
      tls:
        mode: Terminate
        certificateRefs:
          - name: server-cert
            namespace: gateway-system
        options:
          gateway.envoyproxy.io/tls-min-protocol-version: TLSv1.3
          gateway.envoyproxy.io/tls-client-cert-validation: Required
          gateway.envoyproxy.io/tls-client-cert-authority: client-ca
```

## Section 15: Production Readiness Summary

**Gateway Resource Design:**
- Use dedicated `gateway-system` namespace for Gateway and GatewayClass resources
- Configure `allowedRoutes` with namespace selectors rather than `All` for multi-tenant clusters
- Use `ReferenceGrant` to explicitly permit cross-namespace backend references
- Configure multiple listeners on a single Gateway rather than deploying multiple Gateway instances

**Traffic Management:**
- Use `backendRefs` with `weight` for canary and blue-green deployments instead of DNS-based traffic splitting
- Apply `URLRewrite` filters to strip path prefixes before forwarding to services
- Configure request/response header modification for security headers at the Gateway layer
- Use `GRPCRoute` for gRPC workloads instead of encoding gRPC routing in HTTP path rules

**Security:**
- Integrate cert-manager for automated TLS certificate provisioning for Gateway listeners
- Apply `ClientTrafficPolicy` to enforce minimum TLS version and cipher suites
- Use `BackendTrafficPolicy` with circuit breaker and rate limiting for backend protection
- Avoid wildcards in `allowedRoutes`; specify exact namespace selectors

**Observability:**
- Monitor `HTTPRoute` and `Gateway` status conditions for route acceptance errors
- Deploy Envoy Gateway metrics to Prometheus for connection pool and request rate monitoring
- Use Hubble (with Cilium) for L7 flow observability on Gateway-managed traffic
