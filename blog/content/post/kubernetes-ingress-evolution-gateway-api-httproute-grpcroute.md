---
title: "Kubernetes Ingress Evolution: Gateway API, HTTPRoute, and GRPCRoute Implementation"
date: 2029-12-30T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Gateway API", "HTTPRoute", "GRPCRoute", "Ingress", "Networking", "TLS", "Traffic Management"]
categories:
- Kubernetes
- Networking
- Gateway API
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide covering Gateway API architecture, GatewayClass/Gateway/HTTPRoute, traffic splitting, header-based routing, TLS passthrough, and GRPCRoute implementation for modern Kubernetes networking."
more_link: "yes"
url: "/kubernetes-ingress-evolution-gateway-api-httproute-grpcroute/"
---

The Kubernetes Ingress API has been stable since 1.19 but was never designed for the full range of modern application routing requirements. Gateway API is its successor — a role-oriented, extensible routing API that expresses traffic management patterns that previously required custom Ingress annotations or separate service mesh configuration. This guide covers the full Gateway API architecture and its production implementation.

<!--more-->

## Section 1: The Problems Gateway API Solves

The original Ingress API had fundamental limitations:

- **Single role**: Ingress merges infrastructure concerns (load balancer provisioning) with application concerns (path routing) into one resource
- **Annotation sprawl**: Each controller invented its own annotations (`nginx.ingress.kubernetes.io/...`, `haproxy.router.openshift.io/...`) for features beyond basic path routing
- **No traffic splitting**: Canary deployments required non-standard annotations with no consistent behavior across controllers
- **No protocol awareness**: gRPC, WebSocket, and TCP routing required workarounds
- **Single namespace**: An Ingress object could only reference Services in the same namespace

Gateway API addresses all of these with a role-based model and first-class support for complex routing.

### Gateway API Roles

| Role | Resource | Managed By |
|---|---|---|
| Infrastructure Provider | GatewayClass | Cloud provider / cluster admin |
| Cluster Operator | Gateway | Platform team |
| Application Developer | HTTPRoute / GRPCRoute / TCPRoute | Development teams |

## Section 2: Installing Gateway API CRDs

Gateway API CRDs are not included in core Kubernetes. Install the standard channel:

```bash
# Install Gateway API CRDs (standard channel includes HTTPRoute, GRPCRoute, etc.)
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/standard-install.yaml

# Verify CRDs are installed.
kubectl get crd | grep gateway.networking.k8s.io

# Expected output includes:
# gatewayclasses.gateway.networking.k8s.io
# gateways.gateway.networking.k8s.io
# httproutes.gateway.networking.k8s.io
# grpcroutes.gateway.networking.k8s.io
# referencegrants.gateway.networking.k8s.io
```

### Choosing a Gateway Controller

Multiple controllers implement the Gateway API:

```bash
# Install Envoy Gateway (CNCF project backed by Envoy proxy).
helm install eg oci://docker.io/envoyproxy/gateway-helm \
    --version v1.3.0 \
    --namespace envoy-gateway-system \
    --create-namespace

# Alternatively, install Istio with Gateway API support.
istioctl install --set profile=minimal

# For bare-metal, install Cilium with Gateway API.
helm upgrade cilium cilium/cilium \
    --namespace kube-system \
    --reuse-values \
    --set gatewayAPI.enabled=true
```

## Section 3: GatewayClass and Gateway

### GatewayClass — Infrastructure Definition

A GatewayClass is cluster-scoped and defines which controller implements Gateways of that class:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: envoy-gateway
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
  description: "Envoy Gateway managed by the platform team"
  parametersRef:
    group: gateway.envoyproxy.io
    kind: EnvoyProxy
    name: default-proxy-config
    namespace: envoy-gateway-system
```

### Gateway — Listener Configuration

A Gateway defines the listeners (ports, protocols, TLS) that accept traffic:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: production-gateway
  namespace: gateway-infra
spec:
  gatewayClassName: envoy-gateway
  listeners:
    # HTTP listener that redirects to HTTPS.
    - name: http
      port: 80
      protocol: HTTP
      allowedRoutes:
        namespaces:
          from: All

    # HTTPS listener with TLS termination.
    - name: https
      port: 443
      protocol: HTTPS
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

    # TLS passthrough — for end-to-end TLS without termination.
    - name: tls-passthrough
      port: 8443
      protocol: TLS
      tls:
        mode: Passthrough
      allowedRoutes:
        namespaces:
          from: All

    # gRPC listener.
    - name: grpc
      port: 50051
      protocol: HTTP2
      tls:
        mode: Terminate
        certificateRefs:
          - name: grpc-tls-cert
            namespace: gateway-infra
      allowedRoutes:
        namespaces:
          from: All
```

### Checking Gateway Status

```bash
# Verify Gateway is programmed (has an external IP/hostname).
kubectl get gateway production-gateway -n gateway-infra -o wide

# Check conditions for readiness.
kubectl describe gateway production-gateway -n gateway-infra | grep -A 20 "Conditions:"

# Expected condition:
# Type: Programmed
# Status: True
# Reason: Programmed
```

## Section 4: HTTPRoute — Application Routing

HTTPRoute attaches to a Gateway listener and defines routing rules for HTTP/HTTPS traffic.

### Basic Path Routing

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-route
  namespace: team-payments
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-infra
      sectionName: https  # Attach to the HTTPS listener only.
  hostnames:
    - "api.example.com"
  rules:
    # Route /payments/v2 to the v2 service.
    - matches:
        - path:
            type: PathPrefix
            value: /payments/v2
      backendRefs:
        - name: payments-service-v2
          port: 8080

    # Route /payments to the v1 service (legacy).
    - matches:
        - path:
            type: PathPrefix
            value: /payments
      backendRefs:
        - name: payments-service-v1
          port: 8080

    # Default catch-all for this host.
    - backendRefs:
        - name: api-default-service
          port: 8080
```

### Header-Based Routing

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: header-routing
  namespace: team-frontend
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-infra
  hostnames:
    - "www.example.com"
  rules:
    # Route beta users to the canary service.
    - matches:
        - headers:
            - name: X-Beta-User
              value: "true"
      backendRefs:
        - name: frontend-canary
          port: 8080

    # Route by User-Agent for mobile vs desktop.
    - matches:
        - headers:
            - name: User-Agent
              type: RegularExpression
              value: ".*Mobile.*"
      backendRefs:
        - name: frontend-mobile
          port: 8080

    # Default route.
    - backendRefs:
        - name: frontend-stable
          port: 8080
```

### Query Parameter Routing

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: query-routing
  namespace: team-search
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-infra
  hostnames:
    - "search.example.com"
  rules:
    # Route v2 query parameter to new search service.
    - matches:
        - queryParams:
            - name: version
              value: "v2"
      backendRefs:
        - name: search-service-v2
          port: 8080

    - backendRefs:
        - name: search-service-v1
          port: 8080
```

## Section 5: Traffic Splitting for Canary Deployments

Gateway API natively supports weighted traffic splitting, making canary deployments a first-class citizen:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: checkout-canary
  namespace: team-checkout
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-infra
  hostnames:
    - "checkout.example.com"
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        # 90% to stable, 10% to canary.
        - name: checkout-stable
          port: 8080
          weight: 90
        - name: checkout-canary
          port: 8080
          weight: 10
```

### Progressive Traffic Shifting Script

```bash
#!/bin/bash
# canary-shift.sh — Gradually shift traffic to canary using kubectl patch.

NAMESPACE="team-checkout"
ROUTE_NAME="checkout-canary"
STABLE_NAME="checkout-stable"
CANARY_NAME="checkout-canary-svc"
MAX_CANARY=100
STEP=10
INTERVAL=300  # 5 minutes between steps

current_canary=10

while [ $current_canary -le $MAX_CANARY ]; do
    stable=$((100 - current_canary))
    echo "Setting traffic split: stable=${stable}% canary=${current_canary}%"

    kubectl patch httproute "$ROUTE_NAME" -n "$NAMESPACE" \
        --type=json \
        -p="[
            {\"op\": \"replace\",
             \"path\": \"/spec/rules/0/backendRefs/0/weight\",
             \"value\": ${stable}},
            {\"op\": \"replace\",
             \"path\": \"/spec/rules/0/backendRefs/1/weight\",
             \"value\": ${current_canary}}
        ]"

    if [ $current_canary -eq $MAX_CANARY ]; then
        echo "Canary fully promoted."
        break
    fi

    echo "Waiting ${INTERVAL}s before next shift..."
    sleep $INTERVAL

    # Check error rate before proceeding (requires Prometheus).
    ERROR_RATE=$(kubectl exec -n monitoring deploy/prometheus \
        -- promtool query instant \
        "rate(http_requests_total{service=\"${CANARY_NAME}\",status=~\"5..\"}[5m]) / rate(http_requests_total{service=\"${CANARY_NAME}\"}[5m]) * 100" \
        2>/dev/null | grep -oE '[0-9]+\.[0-9]+' | head -1)

    if [ -n "$ERROR_RATE" ] && (( $(echo "$ERROR_RATE > 1.0" | bc -l) )); then
        echo "ERROR: Canary error rate ${ERROR_RATE}% exceeds 1%. Rolling back."
        kubectl patch httproute "$ROUTE_NAME" -n "$NAMESPACE" \
            --type=json \
            -p='[
                {"op":"replace","path":"/spec/rules/0/backendRefs/0/weight","value":100},
                {"op":"replace","path":"/spec/rules/0/backendRefs/1/weight","value":0}
            ]'
        exit 1
    fi

    current_canary=$((current_canary + STEP))
done
```

## Section 6: HTTP Redirects and Rewrites

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: http-to-https-redirect
  namespace: gateway-infra
spec:
  parentRefs:
    - name: production-gateway
      sectionName: http  # Attach to HTTP listener.
  rules:
    - filters:
        - type: RequestRedirect
          requestRedirect:
            scheme: https
            statusCode: 301
```

### Path Rewriting

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-rewrite
  namespace: team-api
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-infra
  hostnames:
    - "api.example.com"
  rules:
    # Rewrite /v1/users to /users (strip the version prefix).
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
      backendRefs:
        - name: user-service
          port: 8080

    # Add request headers before forwarding.
    - filters:
        - type: RequestHeaderModifier
          requestHeaderModifier:
            add:
              - name: X-Gateway-Version
                value: "gateway-api-v1"
            remove:
              - X-Internal-Debug
      backendRefs:
        - name: api-service
          port: 8080
```

## Section 7: GRPCRoute Implementation

GRPCRoute provides native gRPC routing with service and method matching:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
metadata:
  name: grpc-user-service
  namespace: team-users
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-infra
      sectionName: grpc
  hostnames:
    - "grpc.example.com"
  rules:
    # Route all methods of the UserService to v2.
    - matches:
        - method:
            service: "example.users.v2.UserService"
      backendRefs:
        - name: user-service-grpc-v2
          port: 50051
          weight: 90
        - name: user-service-grpc-canary
          port: 50051
          weight: 10

    # Route only GetUser to a read replica.
    - matches:
        - method:
            service: "example.users.v1.UserService"
            method: "GetUser"
      backendRefs:
        - name: user-service-read-replica
          port: 50051

    # Catch-all for v1.
    - matches:
        - method:
            service: "example.users.v1.UserService"
      backendRefs:
        - name: user-service-grpc-v1
          port: 50051
```

### Testing GRPCRoute

```bash
# Test gRPC routing with grpcurl.
grpcurl -d '{"user_id": "123"}' \
    -H "Host: grpc.example.com" \
    grpc.example.com:50051 \
    example.users.v2.UserService/GetUser
```

## Section 8: Cross-Namespace References and ReferenceGrant

By default, HTTPRoutes can only reference Services in the same namespace. Use ReferenceGrant to allow cross-namespace Service references:

```yaml
# In the namespace that owns the Service (team-payments).
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-gateway-infra
  namespace: team-payments  # The namespace granting access.
spec:
  from:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      namespace: team-checkout  # The namespace allowed to reference.
  to:
    - group: ""
      kind: Service
      name: payments-internal  # Specific service, or omit name for all services.
```

## Section 9: TLS Passthrough for End-to-End Encryption

```yaml
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: TLSRoute
metadata:
  name: database-passthrough
  namespace: team-data
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-infra
      sectionName: tls-passthrough
  hostnames:
    - "db.example.com"
  rules:
    - backendRefs:
        - name: postgres-service
          port: 5432
```

## Section 10: Policy Attachment and Extension Points

Gateway API uses policy attachment for cross-cutting concerns like timeout, retry, and rate limiting:

```yaml
# Envoy Gateway extension: BackendTrafficPolicy for timeout and retry.
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendTrafficPolicy
metadata:
  name: api-traffic-policy
  namespace: team-api
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: api-route
  timeout:
    http:
      requestTimeout: 30s
      backendRequest: 25s
  retry:
    numRetries: 3
    retryOn:
      - "5xx"
      - "reset"
      - "connect-failure"
    perRetryPolicy:
      timeout: 8s
```

```bash
# Verify all routes are accepted and programmed.
kubectl get httproute -A
kubectl get grpcroute -A

# Check route status including parent gateway attachment.
kubectl describe httproute api-route -n team-api | grep -A 10 "Parents:"

# View all routing rules for a specific gateway.
kubectl get httproute -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{"\n"}{end}'
```

Gateway API represents a generational improvement over Ingress. The role separation between GatewayClass, Gateway, and Route types aligns perfectly with how platform teams and application teams actually divide responsibility. As controllers converge on the Gateway API specification, organizations gain the ability to switch between Envoy Gateway, Cilium, and Istio implementations without rewriting routing configuration.
