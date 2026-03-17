---
title: "Kubernetes Gateway API: Next-Generation Ingress with HTTPRoute and GRPCRoute"
date: 2030-11-24T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Gateway API", "HTTPRoute", "GRPCRoute", "Ingress", "Traffic Management", "TLS", "Service Mesh"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete production guide to Kubernetes Gateway API covering HTTPRoute, GRPCRoute, and TCPRoute resources, TLS termination, traffic splitting for canary deployments, cross-namespace reference grants, and migration strategies from existing Ingress controllers."
more_link: "yes"
url: "/kubernetes-gateway-api-httproute-grpcroute-next-generation-ingress/"
---

The Kubernetes Ingress API has served traffic routing needs since 2015, but its design limitations became increasingly apparent as microservice architectures grew more complex. Custom annotations for controller-specific features, no native traffic splitting, no gRPC support, no cross-namespace routing, and a flat permission model that mixed infrastructure and application concerns into a single object — these limitations drove the development of the Gateway API.

Gateway API graduated to GA in Kubernetes 1.28 with its core resources, providing a role-oriented, expressive, and extensible model for traffic management. This guide covers deploying Gateway API in production with Cilium as the implementation, configuring HTTPRoute and GRPCRoute resources, implementing canary deployments with traffic splitting, and migrating from existing NGINX Ingress configurations.

<!--more-->

# Kubernetes Gateway API: Next-Generation Ingress with HTTPRoute and GRPCRoute

## Section 1: Gateway API Architecture and Role Model

The Gateway API introduces a clear separation of concerns through three distinct resource types, each owned by a different persona:

```
Infrastructure Provider          Platform Team              Application Developer
        │                              │                              │
        ▼                              ▼                              ▼
  GatewayClass               Gateway (namespace: infra)     HTTPRoute (namespace: app)
  (cluster-scoped)           - listeners                    - rules
  - controllerName           - tls config                   - hostnames
  - parametersRef            - allowed routes               - filters
                             - allowed namespaces           - backendRefs
```

**GatewayClass**: Cluster-scoped resource that identifies a controller implementation (like `cilium` or `nginx`). Provisioned by the infrastructure provider.

**Gateway**: Namespace-scoped resource that defines listeners (port/protocol/TLS combinations) and the namespaces from which routes may attach. Provisioned by the platform team.

**HTTPRoute / GRPCRoute / TCPRoute**: Namespace-scoped resources that define routing rules from a Gateway to backend Services. Owned by application developers.

This separation means application developers can configure routing without access to infrastructure resources, while platform teams retain control over which applications can attach to which gateways.

## Section 2: Installing Gateway API CRDs

Gateway API is not bundled with Kubernetes — you install the CRDs from the upstream project:

```bash
# Install the standard channel CRDs (stable resources)
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/standard-install.yaml

# Verify CRDs are installed
kubectl get crd | grep gateway.networking.k8s.io
# gatewayclasses.gateway.networking.k8s.io
# gateways.gateway.networking.k8s.io
# grpcroutes.gateway.networking.k8s.io
# httproutes.gateway.networking.k8s.io
# referencegrants.gateway.networking.k8s.io

# Install experimental channel for TCPRoute, TLSRoute, UDPRoute
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/experimental-install.yaml
```

## Section 3: Installing Cilium as the Gateway API Implementation

Cilium 1.14+ supports Gateway API natively using eBPF-based data plane:

```bash
# Install Cilium with Gateway API enabled
helm repo add cilium https://helm.cilium.io/
helm repo update

helm install cilium cilium/cilium \
  --namespace kube-system \
  --version 1.16.0 \
  --set kubeProxyReplacement=true \
  --set gatewayAPI.enabled=true \
  --set gatewayAPI.secretsNamespace.create=true \
  --set envoy.enabled=true \
  --set hubble.enabled=true \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true

# Verify Cilium GatewayClass is created
kubectl get gatewayclass
# NAME     CONTROLLER                     ACCEPTED   AGE
# cilium   io.cilium/gateway-controller   True       2m
```

## Section 4: GatewayClass and Gateway Configuration

### GatewayClass (managed by Cilium automatically)

```yaml
# Cilium creates this GatewayClass automatically, but here's the definition for reference
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: cilium
spec:
  controllerName: io.cilium/gateway-controller
  description: "Cilium Gateway API implementation using eBPF"
```

### Production Gateway

```yaml
# gateway.yaml - deployed by platform/infrastructure team
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: production-gateway
  namespace: infra
  annotations:
    # Cilium-specific: set load balancer parameters
    service.beta.kubernetes.io/aws-load-balancer-type: "nlb"
    service.beta.kubernetes.io/aws-load-balancer-scheme: "internet-facing"
spec:
  gatewayClassName: cilium
  listeners:
  # HTTP listener - redirects to HTTPS
  - name: http
    port: 80
    protocol: HTTP
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchLabels:
            gateway-access: "allowed"
  # HTTPS listener with TLS termination
  - name: https
    port: 443
    protocol: HTTPS
    tls:
      mode: Terminate
      certificateRefs:
      - kind: Secret
        name: production-tls
        namespace: infra
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchLabels:
            gateway-access: "allowed"
  # gRPC over HTTPS listener
  - name: grpc
    port: 8443
    protocol: HTTPS
    tls:
      mode: Terminate
      certificateRefs:
      - kind: Secret
        name: production-tls
        namespace: infra
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchLabels:
            grpc-access: "allowed"
---
# Namespace label to allow routes to attach
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    gateway-access: "allowed"
    grpc-access: "allowed"
```

### TLS Certificate Management

```yaml
# cert-manager integration - automatic TLS certificate provisioning
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: production-tls
  namespace: infra
spec:
  secretName: production-tls
  duration: 2160h    # 90 days
  renewBefore: 360h  # Renew 15 days before expiry
  isCA: false
  privateKey:
    algorithm: RSA
    encoding: PKCS1
    size: 4096
  usages:
  - server auth
  - client auth
  dnsNames:
  - "api.example.com"
  - "*.api.example.com"
  - "grpc.example.com"
  issuerRef:
    name: letsencrypt-production
    kind: ClusterIssuer
    group: cert-manager.io
```

## Section 5: HTTPRoute Configuration

### Basic HTTPRoute

```yaml
# httproute-basic.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-route
  namespace: production
spec:
  # Attach to the production-gateway in the infra namespace
  parentRefs:
  - name: production-gateway
    namespace: infra
    sectionName: https  # Attach only to the https listener
  # Hostname matching
  hostnames:
  - "api.example.com"
  rules:
  # Health check endpoint - no auth required
  - matches:
    - path:
        type: PathPrefix
        value: /health
    backendRefs:
    - name: api-service
      port: 8080
      weight: 100
  # API v1 routing
  - matches:
    - path:
        type: PathPrefix
        value: /v1
    - headers:
      - name: "X-API-Version"
        value: "v1"
    backendRefs:
    - name: api-service-v1
      port: 8080
      weight: 100
  # Default route
  - matches:
    - path:
        type: PathPrefix
        value: /
    backendRefs:
    - name: api-service
      port: 8080
      weight: 100
```

### HTTP to HTTPS Redirect

```yaml
# httproute-redirect.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: http-to-https-redirect
  namespace: infra
spec:
  parentRefs:
  - name: production-gateway
    namespace: infra
    sectionName: http  # Attach to HTTP listener
  hostnames:
  - "api.example.com"
  rules:
  - filters:
    - type: RequestRedirect
      requestRedirect:
        scheme: https
        statusCode: 301
```

### Advanced Traffic Routing

```yaml
# httproute-advanced.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: advanced-routing
  namespace: production
spec:
  parentRefs:
  - name: production-gateway
    namespace: infra
    sectionName: https
  hostnames:
  - "api.example.com"
  rules:
  # Route based on header (A/B testing)
  - matches:
    - headers:
      - name: "X-Feature-Flag"
        value: "new-checkout"
    backendRefs:
    - name: checkout-service-v2
      port: 8080
      weight: 100

  # Canary deployment: 10% to v2
  - matches:
    - path:
        type: PathPrefix
        value: /checkout
    backendRefs:
    - name: checkout-service-v1
      port: 8080
      weight: 90
    - name: checkout-service-v2
      port: 8080
      weight: 10

  # Path rewrite: strip /api prefix before forwarding
  - matches:
    - path:
        type: PathPrefix
        value: /api/users
    filters:
    - type: URLRewrite
      urlRewrite:
        path:
          type: ReplacePrefixMatch
          replacePrefixMatch: /users
    backendRefs:
    - name: user-service
      port: 8080

  # Header modification
  - matches:
    - path:
        type: PathPrefix
        value: /internal
    filters:
    - type: RequestHeaderModifier
      requestHeaderModifier:
        set:
        - name: "X-Internal-Request"
          value: "true"
        add:
        - name: "X-Request-ID"
          value: "${request.id}"  # Cilium extension
        remove:
        - name: "X-External-Token"
    - type: ResponseHeaderModifier
      responseHeaderModifier:
        set:
        - name: "Cache-Control"
          value: "no-store"
    backendRefs:
    - name: internal-service
      port: 8080

  # Mirror traffic (for testing new version)
  - matches:
    - path:
        type: PathPrefix
        value: /orders
    filters:
    - type: RequestMirror
      requestMirror:
        backendRef:
          name: orders-service-v2-shadow
          port: 8080
    backendRefs:
    - name: orders-service-v1
      port: 8080
```

## Section 6: GRPCRoute Configuration

GRPCRoute provides native gRPC routing with method and header matching:

```yaml
# grpcroute.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
metadata:
  name: grpc-services
  namespace: production
spec:
  parentRefs:
  - name: production-gateway
    namespace: infra
    sectionName: grpc
  hostnames:
  - "grpc.example.com"
  rules:
  # Route UserService.* methods to user service
  - matches:
    - method:
        service: "com.example.UserService"
    backendRefs:
    - name: user-grpc-service
      port: 50051
      weight: 100

  # Route specific method with header match
  - matches:
    - method:
        service: "com.example.OrderService"
        method: "CreateOrder"
      headers:
      - name: "x-beta-tester"
        value: "true"
    backendRefs:
    - name: order-grpc-service-v2
      port: 50051
      weight: 100

  # Route all OrderService with traffic splitting
  - matches:
    - method:
        service: "com.example.OrderService"
    backendRefs:
    - name: order-grpc-service-v1
      port: 50051
      weight: 95
    - name: order-grpc-service-v2
      port: 50051
      weight: 5

  # Catch-all for payment service
  - matches:
    - method:
        service: "com.example.PaymentService"
    filters:
    - type: RequestHeaderModifier
      requestHeaderModifier:
        add:
        - name: "x-routed-by"
          value: "gateway"
    backendRefs:
    - name: payment-grpc-service
      port: 50051
```

### gRPC Service Definition (for reference)

```protobuf
// user_service.proto
syntax = "proto3";
package com.example;

option go_package = "github.com/example/api/user/v1";

service UserService {
  rpc GetUser(GetUserRequest) returns (GetUserResponse);
  rpc CreateUser(CreateUserRequest) returns (CreateUserResponse);
  rpc ListUsers(ListUsersRequest) returns (stream ListUsersResponse);
}

message GetUserRequest {
  string user_id = 1;
}

message GetUserResponse {
  User user = 1;
}

message User {
  string id = 1;
  string name = 2;
  string email = 3;
}
```

## Section 7: Cross-Namespace Routing with ReferenceGrant

By default, a Route in namespace `production` cannot reference a Service in namespace `database`. The ReferenceGrant resource allows cross-namespace references:

```yaml
# This scenario: HTTPRoute in 'production' namespace needs to reach
# a backend Service in 'shared-services' namespace

# Step 1: Create ReferenceGrant in the TARGET namespace (shared-services)
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-production-routes
  namespace: shared-services  # The namespace owning the Service
spec:
  from:
  - group: gateway.networking.k8s.io
    kind: HTTPRoute
    namespace: production  # The namespace owning the Route
  to:
  - group: ""
    kind: Service
    name: shared-cache-service  # Optional: specific Service name
---
# Also needed if Gateway is in a different namespace from the Route
# This grant allows Routes in 'production' to attach to Gateway in 'infra'
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-production-routes-to-gateway
  namespace: infra  # The namespace owning the Gateway
spec:
  from:
  - group: gateway.networking.k8s.io
    kind: HTTPRoute
    namespace: production
  to:
  - group: gateway.networking.k8s.io
    kind: Gateway
    name: production-gateway
---
# Step 2: HTTPRoute in 'production' can now reference Service in 'shared-services'
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: cross-namespace-route
  namespace: production
spec:
  parentRefs:
  - name: production-gateway
    namespace: infra
    sectionName: https
  hostnames:
  - "api.example.com"
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /cache
    backendRefs:
    - name: shared-cache-service
      namespace: shared-services  # Cross-namespace reference
      port: 6379
      weight: 100
```

## Section 8: Canary Deployment Pattern

The Gateway API's native traffic splitting enables progressive delivery without external tools:

```bash
# Canary deployment workflow script
# Assumes: v1 at 100%, v2 ready to receive traffic

GATEWAY_NAMESPACE="infra"
APP_NAMESPACE="production"
ROUTE_NAME="checkout-route"

# Step 1: Deploy v2 (already done - no traffic yet)
kubectl apply -f checkout-v2-deployment.yaml

# Step 2: Start with 5% canary
cat > /tmp/canary-5.yaml << 'EOF'
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: checkout-route
  namespace: production
spec:
  parentRefs:
  - name: production-gateway
    namespace: infra
    sectionName: https
  hostnames:
  - "api.example.com"
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /checkout
    backendRefs:
    - name: checkout-service-v1
      port: 8080
      weight: 95
    - name: checkout-service-v2
      port: 8080
      weight: 5
EOF
kubectl apply -f /tmp/canary-5.yaml

# Step 3: Progressive rollout function
promote_canary() {
    local v2_weight=$1
    local v1_weight=$(( 100 - v2_weight ))

    kubectl patch httproute "$ROUTE_NAME" \
      -n "$APP_NAMESPACE" \
      --type=json \
      -p="[
        {\"op\":\"replace\",\"path\":\"/spec/rules/0/backendRefs/0/weight\",\"value\":$v1_weight},
        {\"op\":\"replace\",\"path\":\"/spec/rules/0/backendRefs/1/weight\",\"value\":$v2_weight}
      ]"

    echo "Promoted: v1=${v1_weight}% v2=${v2_weight}%"

    # Wait and check error rate
    sleep 60
    ERROR_RATE=$(kubectl exec -n monitoring deploy/prometheus -- \
      curl -s 'http://localhost:9090/api/v1/query' \
      --data-urlencode 'query=rate(http_requests_total{status=~"5..",service="checkout-service-v2"}[5m]) / rate(http_requests_total{service="checkout-service-v2"}[5m])' \
      | jq '.data.result[0].value[1] // "0"' -r)

    if (( $(echo "$ERROR_RATE > 0.01" | bc -l) )); then
        echo "ERROR RATE TOO HIGH: $ERROR_RATE. Rolling back."
        kubectl patch httproute "$ROUTE_NAME" \
          -n "$APP_NAMESPACE" \
          --type=json \
          -p='[
            {"op":"replace","path":"/spec/rules/0/backendRefs/0/weight","value":100},
            {"op":"replace","path":"/spec/rules/0/backendRefs/1/weight","value":0}
          ]'
        exit 1
    fi
}

# Progressive stages: 5% -> 20% -> 50% -> 100%
for weight in 5 20 50 100; do
    promote_canary $weight
done

echo "Canary promotion complete"
```

## Section 9: Migration from NGINX Ingress

### Mapping Ingress to HTTPRoute

Most NGINX Ingress configurations have direct HTTPRoute equivalents:

```yaml
# BEFORE: NGINX Ingress
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-ingress
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /$2
    nginx.ingress.kubernetes.io/use-regex: "true"
    nginx.ingress.kubernetes.io/proxy-body-size: "50m"
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/configuration-snippet: |
      add_header X-Frame-Options "SAMEORIGIN";
      add_header X-Content-Type-Options "nosniff";
spec:
  tls:
  - hosts:
    - api.example.com
    secretName: api-tls
  rules:
  - host: api.example.com
    http:
      paths:
      - path: /api(/|$)(.*)
        pathType: ImplementationSpecific
        backend:
          service:
            name: api-service
            port:
              number: 8080
---
# AFTER: Gateway API HTTPRoute
# Note: security headers are typically added via a separate SecurityPolicy
# or ResponseHeaderModifier filter

apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-route
  namespace: production
spec:
  parentRefs:
  - name: production-gateway
    namespace: infra
    sectionName: https
  hostnames:
  - "api.example.com"
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
    - type: ResponseHeaderModifier
      responseHeaderModifier:
        set:
        - name: "X-Frame-Options"
          value: "SAMEORIGIN"
        - name: "X-Content-Type-Options"
          value: "nosniff"
    backendRefs:
    - name: api-service
      port: 8080
```

### Migration Script: Ingress to HTTPRoute

```bash
#!/bin/bash
# migrate-ingress.sh - Convert Ingress objects to HTTPRoute
# Usage: ./migrate-ingress.sh <namespace> <ingress-name> <gateway-name> <gateway-namespace>

set -euo pipefail

NAMESPACE="${1:-default}"
INGRESS_NAME="${2:?ingress name required}"
GATEWAY_NAME="${3:-production-gateway}"
GATEWAY_NAMESPACE="${4:-infra}"

echo "Converting Ingress $NAMESPACE/$INGRESS_NAME to HTTPRoute..."

# Extract Ingress spec
INGRESS_JSON=$(kubectl get ingress "$INGRESS_NAME" -n "$NAMESPACE" -o json)

HOST=$(echo "$INGRESS_JSON" | jq -r '.spec.rules[0].host // ""')
TLS_SECRET=$(echo "$INGRESS_JSON" | jq -r '.spec.tls[0].secretName // ""')

# Generate HTTPRoute skeleton
cat > /tmp/httproute-migrated.yaml << EOF
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: ${INGRESS_NAME}-migrated
  namespace: ${NAMESPACE}
  annotations:
    migrated-from: ingress/${INGRESS_NAME}
    migration-date: $(date -Iseconds)
spec:
  parentRefs:
  - name: ${GATEWAY_NAME}
    namespace: ${GATEWAY_NAMESPACE}
    sectionName: https
  hostnames:
  - "${HOST}"
  rules:
EOF

# Convert each path to a rule
RULE_COUNT=$(echo "$INGRESS_JSON" | jq '.spec.rules[0].http.paths | length')
for i in $(seq 0 $(( RULE_COUNT - 1 ))); do
    PATH=$(echo "$INGRESS_JSON" | jq -r ".spec.rules[0].http.paths[$i].path")
    PATH_TYPE=$(echo "$INGRESS_JSON" | jq -r ".spec.rules[0].http.paths[$i].pathType")
    SVC_NAME=$(echo "$INGRESS_JSON" | jq -r ".spec.rules[0].http.paths[$i].backend.service.name")
    SVC_PORT=$(echo "$INGRESS_JSON" | jq -r ".spec.rules[0].http.paths[$i].backend.service.port.number")

    # Convert PathType
    MATCH_TYPE="PathPrefix"
    case "$PATH_TYPE" in
        Exact) MATCH_TYPE="Exact" ;;
        Prefix) MATCH_TYPE="PathPrefix" ;;
        ImplementationSpecific)
            # Best effort conversion
            MATCH_TYPE="PathPrefix"
            PATH=$(echo "$PATH" | sed 's|(/|$)(.*)||g' | sed 's|/+$||')
            ;;
    esac

    cat >> /tmp/httproute-migrated.yaml << EOF
  - matches:
    - path:
        type: ${MATCH_TYPE}
        value: "${PATH}"
    backendRefs:
    - name: ${SVC_NAME}
      port: ${SVC_PORT}
      weight: 100
EOF
done

echo "Generated HTTPRoute:"
cat /tmp/httproute-migrated.yaml
echo ""
echo "Apply with: kubectl apply -f /tmp/httproute-migrated.yaml"
echo ""
echo "After verification, remove old Ingress:"
echo "  kubectl delete ingress $INGRESS_NAME -n $NAMESPACE"
```

## Section 10: Observability and Debugging

### Checking Route Status

```bash
# Check Gateway status (should show PROGRAMMED=True)
kubectl get gateway -n infra
# NAME                  CLASS    ADDRESS        PROGRAMMED   AGE
# production-gateway    cilium   203.0.113.10   True         24h

kubectl describe gateway production-gateway -n infra
# Status:
#   Addresses:
#     Type: IPAddress
#     Value: 203.0.113.10
#   Conditions:
#     Type: Accepted
#     Status: True
#     Reason: Accepted
#     Type: Programmed
#     Status: True
#     Reason: Programmed

# Check HTTPRoute status
kubectl get httproute -n production
# NAME          HOSTNAMES              AGE   ACCEPTED   PARENT
# api-route     ["api.example.com"]    2h    True       infra/production-gateway

kubectl describe httproute api-route -n production
# Status:
#   Parents:
#     Conditions:
#       Type: Accepted
#       Status: True
#       Reason: Accepted
#       Type: ResolvedRefs
#       Status: True
#       Reason: ResolvedRefs

# Common issues to check:
# Reason: NotAllowedByListeners - namespace selector doesn't match
# Reason: NoMatchingListenerHostname - hostname doesn't match gateway listener
# Reason: RefNotPermitted - missing ReferenceGrant for cross-namespace refs
# Reason: BackendNotFound - referenced Service doesn't exist
```

### Testing Routes

```bash
# Test HTTP to HTTPS redirect
curl -v -H "Host: api.example.com" http://<gateway-ip>/health
# Should see 301 redirect to https://

# Test HTTPS routing
curl -v --resolve api.example.com:443:<gateway-ip> \
  https://api.example.com/v1/users

# Test traffic splitting (run multiple times and observe which backend responds)
for i in $(seq 1 20); do
    curl -s --resolve api.example.com:443:<gateway-ip> \
      https://api.example.com/checkout \
      -o /dev/null \
      -w "%{http_code}\n"
done

# Test gRPC routing
grpcurl -insecure \
  -authority grpc.example.com \
  -proto user_service.proto \
  <gateway-ip>:8443 \
  com.example.UserService/GetUser

# Test header-based routing
curl -H "X-Feature-Flag: new-checkout" \
  https://api.example.com/checkout
```

### Prometheus Metrics for Gateway API

```yaml
# prometheus-rules-gateway.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: gateway-api-rules
  namespace: monitoring
spec:
  groups:
  - name: gateway-api
    rules:
    - alert: GatewayNotProgrammed
      expr: |
        gateway_programmed_status{status="False"} == 1
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Gateway {{ $labels.name }} is not programmed"
        description: "The Gateway {{ $labels.namespace }}/{{ $labels.name }} failed to program"

    - alert: HTTPRouteNotAccepted
      expr: |
        httproute_accepted_status{status="False"} == 1
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "HTTPRoute {{ $labels.name }} is not accepted"
        description: "HTTPRoute {{ $labels.namespace }}/{{ $labels.name }} was not accepted by its parent Gateway"

    - alert: GatewayHighErrorRate
      expr: |
        rate(cilium_http_requests_total{status=~"5.."}[5m]) /
        rate(cilium_http_requests_total[5m]) > 0.05
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "High error rate through gateway"
        description: "Error rate is {{ $value | humanizePercentage }} for the last 5 minutes"
```

## Conclusion

The Gateway API represents a significant improvement over the Kubernetes Ingress API for production traffic management. Its role-oriented design cleanly separates infrastructure concerns (GatewayClass, Gateway) from application routing (HTTPRoute, GRPCRoute), while native traffic splitting, header manipulation, path rewriting, and cross-namespace routing eliminate the need for controller-specific annotations.

The migration path from existing Ingress configurations is straightforward for most patterns, with the main investment required for cross-namespace scenarios that need ReferenceGrant resources and security headers that were previously handled via NGINX configuration snippets.

For new deployments, start with Gateway API from day one. For existing clusters, run Gateway API routes in parallel with existing Ingress resources during the transition period, verifying behavior against each route before removing the legacy Ingress objects.
