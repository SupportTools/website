---
title: "Kubernetes Ingress vs Gateway API: Migration Guide"
date: 2029-06-07T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Gateway API", "Ingress", "Migration", "Networking", "HTTPRoute", "Istio", "Envoy"]
categories: ["Kubernetes", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive migration guide from Kubernetes Ingress to the Gateway API, including a feature comparison matrix, parallel operation strategies, HTTPRoute equivalents for common Ingress patterns, TCPRoute and TLSRoute configuration, and provider support matrix for nginx-gateway, Istio, and Cilium."
more_link: "yes"
url: "/kubernetes-ingress-vs-gateway-api-migration-guide/"
---

The Kubernetes Ingress API has served as the primary HTTP routing mechanism since Kubernetes 1.1, but it was designed for simple use cases and has accumulated a significant problem: every controller extended it through non-standard annotations. The same capability — a canary deployment with 10% traffic split — requires completely different annotations depending on whether you use nginx-ingress, HAProxy, or Traefik. The Gateway API solves this by standardizing the advanced routing semantics that annotations previously handled, making configurations portable across providers. This guide covers the feature comparison, migration patterns, and production migration strategies.

<!--more-->

# Kubernetes Ingress vs Gateway API: Migration Guide

## Why the Ingress API Has Limitations

The core `networking.k8s.io/v1/Ingress` spec supports:
- Host-based routing
- Path-based routing
- TLS termination
- A backend service and port

Everything else — rate limiting, authentication, traffic splitting, timeouts, circuit breaking, header manipulation, canary deployments — is implemented as annotations with no standardized format.

```yaml
# nginx-ingress specific annotations for rate limiting
nginx.ingress.kubernetes.io/rate-limit: "100"
nginx.ingress.kubernetes.io/rate-limit-burst-multiplier: "5"
nginx.ingress.kubernetes.io/rate-limit-window: "1s"

# HAProxy equivalent (completely different format)
ingress.kubernetes.io/rate-limit-connections: "5"

# Traefik equivalent
traefik.ingress.kubernetes.io/rate-limit: "average=100,burst=50"
```

This annotation sprawl means Ingress configurations are not portable between controllers and cannot be validated by the Kubernetes API server (annotations are opaque strings).

## Gateway API Architecture

The Gateway API introduces a structured hierarchy:

```
GatewayClass  ←  Defines the controller (nginx, istio, cilium)
     ↓
  Gateway      ←  Defines the listener (port, protocol, TLS)
     ↓
HTTPRoute      ←  Defines routing rules (path, header, weight)
     ↓
  Service      ←  Backend destination
```

This separation of concerns allows cluster operators to manage the infrastructure (GatewayClass + Gateway) while application teams manage routing rules (HTTPRoute) — a much cleaner RBAC model than Ingress where both are mixed in one object.

### Gateway API Resources

| Resource | Stability (as of 2025) | Purpose |
|---|---|---|
| `GatewayClass` | GA (v1) | Defines the controller |
| `Gateway` | GA (v1) | Listener configuration |
| `HTTPRoute` | GA (v1) | HTTP/HTTPS routing |
| `ReferenceGrant` | GA (v1) | Cross-namespace service reference permission |
| `GRPCRoute` | GA (v1) | gRPC routing |
| `TCPRoute` | Experimental | Raw TCP routing |
| `TLSRoute` | Experimental | TLS SNI routing (passthrough) |
| `UDPRoute` | Experimental | UDP routing |
| `BackendLBPolicy` | Experimental | Backend load balancing |
| `BackendTLSPolicy` | Experimental | Backend TLS configuration |

## Feature Comparison Matrix

| Feature | Ingress | Gateway API |
|---|---|---|
| Host-based routing | Yes | Yes (HTTPRoute) |
| Path-based routing | Yes | Yes (HTTPRoute) |
| TLS termination | Yes | Yes (Gateway) |
| Traffic splitting | Annotation | HTTPRoute (weight) |
| Header matching | Annotation | HTTPRoute (headers) |
| Query param matching | Annotation | HTTPRoute (queryParams) |
| Header manipulation | Annotation | HTTPRoute (RequestHeaderModifier) |
| URL rewrite | Annotation | HTTPRoute (URLRewrite) |
| Redirect | Annotation | HTTPRoute (RequestRedirect) |
| Timeout | Annotation | HTTPRoute (Timeouts) |
| Retry | Annotation | HTTPRoute (Retry) |
| Mirror | Annotation | HTTPRoute (RequestMirror) |
| gRPC routing | Not standard | GRPCRoute |
| TCP routing | Not standard | TCPRoute |
| TLS passthrough | Not standard | TLSRoute / Gateway mode |
| Cross-namespace routing | Limited | ReferenceGrant |
| Multi-controller | Single annotation namespace | Multiple GatewayClasses |
| Backend TLS | Annotation | BackendTLSPolicy |
| RBAC separation | Limited | Operator/App separation |
| API validation | Limited | Full schema validation |

## Installing the Gateway API CRDs

```bash
# Install standard Gateway API CRDs (stable channel: GatewayClass, Gateway, HTTPRoute, etc.)
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/standard-install.yaml

# Install experimental channel (includes TCPRoute, TLSRoute, UDPRoute)
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/experimental-install.yaml

# Verify CRDs are installed
kubectl get crds | grep gateway.networking.k8s.io
```

## Provider Installation

### nginx Gateway Fabric (NGINX Inc.)

```bash
# Install nginx Gateway Fabric
helm repo add nginx-gateway https://helm.nginx.com/stable
helm repo update

helm install nginx-gateway nginx-gateway/nginx-gateway-fabric \
  --namespace nginx-gateway \
  --create-namespace \
  --set nginxGateway.replicaCount=2

# Create the GatewayClass
kubectl apply -f - <<EOF
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: nginx
spec:
  controllerName: gateway.nginx.org/nginx-gateway-controller
EOF
```

### Istio

```bash
# Istio's Gateway API support is built-in since Istio 1.16
# After istio install, create the GatewayClass
kubectl apply -f - <<EOF
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: istio
spec:
  controllerName: istio.io/gateway-controller
EOF
```

### Cilium

```bash
# Cilium Gateway API support enabled during installation
helm upgrade cilium cilium/cilium \
  --namespace kube-system \
  --set gatewayAPI.enabled=true

# GatewayClass is created automatically by Cilium
kubectl get gatewayclass
# cilium   cilium.io/gateway-controller   Accepted
```

### Envoy Gateway

```bash
# Install Envoy Gateway
helm install eg oci://docker.io/envoyproxy/gateway-helm \
  --version v1.1.0 \
  -n envoy-gateway-system \
  --create-namespace

# GatewayClass
kubectl apply -f - <<EOF
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: eg
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
EOF
```

## Provider Support Matrix

| Feature | nginx-gateway | Istio | Cilium | Envoy Gateway |
|---|---|---|---|---|
| HTTPRoute | Yes | Yes | Yes | Yes |
| GRPCRoute | Yes | Yes | Yes | Yes |
| TCPRoute | No | Yes | Yes | Yes |
| TLSRoute | No | Yes | Yes | Yes |
| UDPRoute | No | No | Yes | No |
| Traffic weight | Yes | Yes | Yes | Yes |
| Header matching | Yes | Yes | Yes | Yes |
| URL rewrite | Yes | Yes | Yes | Yes |
| Request mirror | Yes | Yes | Yes | Yes |
| Timeouts | Yes | Yes | Yes | Yes |
| Retries | Yes | Yes | Yes | Yes |
| BackendTLSPolicy | Yes | Yes | Partial | Yes |
| ReferenceGrant | Yes | Yes | Yes | Yes |

## Converting Ingress to HTTPRoute

### Basic Host/Path Routing

```yaml
# BEFORE: Ingress
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-ingress
  namespace: production
spec:
  ingressClassName: nginx
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /v1
            pathType: Prefix
            backend:
              service:
                name: api-v1
                port:
                  number: 8080
          - path: /v2
            pathType: Prefix
            backend:
              service:
                name: api-v2
                port:
                  number: 8080
  tls:
    - hosts:
        - api.example.com
      secretName: api-tls-secret
```

```yaml
# AFTER: Gateway + HTTPRoute
---
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: production-gateway
  namespace: production
spec:
  gatewayClassName: nginx
  listeners:
    - name: https
      protocol: HTTPS
      port: 443
      hostname: api.example.com
      tls:
        mode: Terminate
        certificateRefs:
          - name: api-tls-secret
    - name: http
      protocol: HTTP
      port: 80
      hostname: api.example.com
      # Optionally redirect HTTP to HTTPS at the gateway level
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-routes
  namespace: production
spec:
  parentRefs:
    - name: production-gateway
      sectionName: https
  hostnames:
    - api.example.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /v1
      backendRefs:
        - name: api-v1
          port: 8080
    - matches:
        - path:
            type: PathPrefix
            value: /v2
      backendRefs:
        - name: api-v2
          port: 8080
```

### Traffic Splitting (Canary Deployments)

```yaml
# BEFORE: nginx-ingress annotation for canary
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-canary
  annotations:
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-weight: "10"
spec:
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: api-v2
                port:
                  number: 8080
```

```yaml
# AFTER: HTTPRoute with weighted backends
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-canary
  namespace: production
spec:
  parentRefs:
    - name: production-gateway
      sectionName: https
  hostnames:
    - api.example.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        # 90% to stable
        - name: api-v1
          port: 8080
          weight: 90
        # 10% to canary
        - name: api-v2
          port: 8080
          weight: 10
```

### Header-Based Routing

```yaml
# BEFORE: nginx custom header routing (annotation + snippet)
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: header-routing
  annotations:
    nginx.ingress.kubernetes.io/server-snippet: |
      if ($http_x_version = "v2") {
        return 301 https://api-v2.example.com$request_uri;
      }
```

```yaml
# AFTER: HTTPRoute header matching (type-safe, validated)
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: header-routing
  namespace: production
spec:
  parentRefs:
    - name: production-gateway
      sectionName: https
  hostnames:
    - api.example.com
  rules:
    # Route requests with X-Version: v2 header to new service
    - matches:
        - headers:
            - name: X-Version
              value: v2
      backendRefs:
        - name: api-v2
          port: 8080
    # Route all other requests to v1
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: api-v1
          port: 8080
```

### URL Rewrite and Redirect

```yaml
# BEFORE: nginx rewrite annotation
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: rewrite-ingress
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /api/$1
    nginx.ingress.kubernetes.io/use-regex: "true"
spec:
  rules:
    - host: example.com
      http:
        paths:
          - path: /legacy/(.*)
            pathType: ImplementationSpecific
            backend:
              service:
                name: api
                port:
                  number: 8080
```

```yaml
# AFTER: HTTPRoute with URL rewrite filter
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: url-rewrite
  namespace: production
spec:
  parentRefs:
    - name: production-gateway
      sectionName: https
  hostnames:
    - example.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /legacy
      filters:
        - type: URLRewrite
          urlRewrite:
            path:
              type: ReplacePrefixMatch
              replacePrefixMatch: /api
      backendRefs:
        - name: api
          port: 8080
---
# HTTPS redirect
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: https-redirect
  namespace: production
spec:
  parentRefs:
    - name: production-gateway
      sectionName: http  # The HTTP listener
  hostnames:
    - example.com
  rules:
    - filters:
        - type: RequestRedirect
          requestRedirect:
            scheme: https
            statusCode: 301
```

### Header Manipulation

```yaml
# BEFORE: nginx header manipulation annotations
metadata:
  annotations:
    nginx.ingress.kubernetes.io/configuration-snippet: |
      add_header X-Request-ID $request_id;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

```yaml
# AFTER: HTTPRoute request/response header filters
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: header-manipulation
  namespace: production
spec:
  parentRefs:
    - name: production-gateway
      sectionName: https
  hostnames:
    - api.example.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      filters:
        # Add headers to request sent to backend
        - type: RequestHeaderModifier
          requestHeaderModifier:
            add:
              - name: X-Forwarded-Host
                value: "api.example.com"
            set:
              - name: X-Proxy-Version
                value: "v2"
            remove:
              - X-Internal-Debug-Flag
        # Add headers to response sent to client
        - type: ResponseHeaderModifier
          responseHeaderModifier:
            add:
              - name: X-Content-Type-Options
                value: nosniff
              - name: X-Frame-Options
                value: DENY
      backendRefs:
        - name: api
          port: 8080
```

### Timeouts and Retries

```yaml
# BEFORE: nginx timeout annotations
metadata:
  annotations:
    nginx.ingress.kubernetes.io/proxy-connect-timeout: "5"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "30"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "30"
```

```yaml
# AFTER: HTTPRoute timeouts (GA in Gateway API v1.1)
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-with-timeouts
  namespace: production
spec:
  parentRefs:
    - name: production-gateway
      sectionName: https
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api
      timeouts:
        request: 30s           # Total request timeout
        backendRequest: 25s    # Backend timeout (subset of request timeout)
      retry:
        attempts: 3
        backoff: 250ms
        codes: [500, 503]  # Retry only on these status codes
      backendRefs:
        - name: api
          port: 8080
```

## TCPRoute Configuration

TCPRoute routes raw TCP traffic by port:

```yaml
# Gateway with TCP listener
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: tcp-gateway
  namespace: production
spec:
  gatewayClassName: eg  # Envoy Gateway or Istio
  listeners:
    - name: postgres
      protocol: TCP
      port: 5432
    - name: redis
      protocol: TCP
      port: 6379
---
# TCPRoute for PostgreSQL
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: TCPRoute
metadata:
  name: postgres-route
  namespace: production
spec:
  parentRefs:
    - name: tcp-gateway
      sectionName: postgres
  rules:
    - backendRefs:
        - name: postgres
          port: 5432
---
# TCPRoute for Redis
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: TCPRoute
metadata:
  name: redis-route
  namespace: production
spec:
  parentRefs:
    - name: tcp-gateway
      sectionName: redis
  rules:
    - backendRefs:
        - name: redis
          port: 6379
```

## TLSRoute: SNI-Based Routing (Passthrough)

TLSRoute routes TLS traffic based on SNI without terminating it:

```yaml
# Gateway with TLS passthrough listener
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: tls-passthrough-gateway
  namespace: production
spec:
  gatewayClassName: istio
  listeners:
    - name: tls-passthrough
      protocol: TLS
      port: 443
      tls:
        mode: Passthrough  # Don't terminate TLS — pass to backend
---
# Route by SNI hostname
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: TLSRoute
metadata:
  name: tls-route
  namespace: production
spec:
  parentRefs:
    - name: tls-passthrough-gateway
      sectionName: tls-passthrough
  hostnames:
    - secure-api.example.com
  rules:
    - backendRefs:
        - name: secure-api
          port: 443
```

## Cross-Namespace Routing with ReferenceGrant

ReferenceGrant allows HTTPRoutes in one namespace to reference services in another — previously impossible with Ingress without hacks.

```yaml
# Scenario: HTTPRoute in 'apps' namespace routes to service in 'databases' namespace

# Step 1: Create ReferenceGrant in the target namespace
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-apps-to-databases
  namespace: databases     # Grant is in the target namespace
spec:
  from:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      namespace: apps      # Allow HTTPRoutes from this namespace
  to:
    - group: ""
      kind: Service
      name: postgres       # Optionally restrict to specific service name

# Step 2: HTTPRoute in 'apps' namespace references service in 'databases'
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-to-database
  namespace: apps
spec:
  parentRefs:
    - name: production-gateway
      namespace: production
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /db
      backendRefs:
        - name: postgres
          namespace: databases   # Cross-namespace reference
          port: 5432
          group: ""
          kind: Service
```

## Parallel Operation During Migration

The safest migration strategy runs Gateway API and Ingress in parallel:

```bash
#!/bin/bash
# migrate-ingress.sh — migrate a namespace from Ingress to Gateway API

NAMESPACE=$1
DRY_RUN=${2:-"--dry-run=client"}

echo "=== Migration Plan for namespace: $NAMESPACE ==="

# Step 1: Inventory existing Ingresses
echo "--- Existing Ingresses ---"
kubectl get ingress -n "$NAMESPACE" -o wide

# Step 2: Generate equivalent HTTPRoutes (using ingress2gateway tool)
# Install: go install sigs.k8s.io/ingress2gateway/cmd/ingress2gateway@latest
echo "--- Generated HTTPRoutes ---"
ingress2gateway print \
    --namespace "$NAMESPACE" \
    --providers nginx

# Step 3: Apply Gateway if not already present
echo "--- Applying Gateway ---"
kubectl apply $DRY_RUN -f - <<EOF
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: production-gateway
  namespace: $NAMESPACE
spec:
  gatewayClassName: nginx
  listeners:
    - name: http
      protocol: HTTP
      port: 80
    - name: https
      protocol: HTTPS
      port: 443
      tls:
        mode: Terminate
        certificateRefs:
          - name: wildcard-tls
EOF

# Step 4: Apply HTTPRoutes (keep Ingresses running in parallel)
echo "--- Applying HTTPRoutes ---"
ingress2gateway print \
    --namespace "$NAMESPACE" \
    --providers nginx | \
    kubectl apply $DRY_RUN -f -

# Step 5: Verify Gateway has external IP
echo "--- Gateway Status ---"
kubectl get gateway -n "$NAMESPACE"

# Step 6: Test HTTPRoutes with curl (using Gateway's IP)
GATEWAY_IP=$(kubectl get gateway production-gateway -n "$NAMESPACE" \
    -o jsonpath='{.status.addresses[0].value}')
echo "Gateway IP: $GATEWAY_IP"
echo "Test: curl -H 'Host: api.example.com' http://$GATEWAY_IP/v1/health"
```

### DNS Cutover Strategy

```bash
# After verifying HTTPRoutes work with direct IP:
# 1. Update DNS to point to the Gateway's load balancer IP/hostname
# 2. Monitor error rates and latency
# 3. Keep Ingresses in place for 24-48 hours
# 4. Remove Ingresses once confident

# Check that both Gateway and Ingress have the same external address
kubectl get ingress -n production -o wide
kubectl get gateway -n production

# Create a test: both should return the same response
curl -H "Host: api.example.com" http://<ingress-lb-ip>/health
curl -H "Host: api.example.com" http://<gateway-lb-ip>/health

# After successful cutover:
kubectl delete ingress --all -n production

# Optionally: remove the old IngressClass
kubectl delete ingressclass nginx-old
```

## ingress2gateway Tool

The Kubernetes SIG-Network provides `ingress2gateway` for automated conversion:

```bash
# Install
go install sigs.k8s.io/ingress2gateway/cmd/ingress2gateway@latest

# Convert Ingresses in a namespace to Gateway API resources
ingress2gateway print \
    --namespace production \
    --providers nginx,gce

# Print to a file
ingress2gateway print \
    --namespace production \
    --providers nginx \
    > gateway-api-resources.yaml

# Supported providers: nginx, gce, haproxy, traefik, istio
```

## Validation and Troubleshooting

```bash
# Check GatewayClass is accepted
kubectl get gatewayclass
# NAME    CONTROLLER                                    ACCEPTED
# nginx   gateway.nginx.org/nginx-gateway-controller   True

# Check Gateway is programmed
kubectl get gateway -n production
# NAME                  CLASS   ADDRESS        PROGRAMMED   AGE
# production-gateway    nginx   192.0.2.10     True         5m

kubectl describe gateway production-gateway -n production
# Conditions:
#   Type: Programmed, Status: True
#   Type: Accepted, Status: True

# Check HTTPRoute status
kubectl get httproute -n production
kubectl describe httproute api-routes -n production
# Status:
#   Parents:
#     Conditions:
#       Type: Accepted, Status: True
#       Type: ResolvedRefs, Status: True

# Common issues:
# ResolvedRefs=False: backend service not found or ReferenceGrant missing
# Accepted=False: Gateway not ready or listener not matching

# Debug with kubectl-gateway-api plugin
kubectl gateway-api describe httproute api-routes -n production
```

## Summary

The Gateway API supersedes Ingress for all new Kubernetes deployments. Its type-safe configuration, role-oriented design (GatewayClass for operators, HTTPRoute for developers), and standardized support for advanced routing features eliminates the annotation sprawl that makes Ingress configurations controller-specific. The migration path is safe: run Gateway API alongside existing Ingresses, validate with direct IP testing, then perform a DNS cutover with the old Ingresses as a fallback. The `ingress2gateway` tool automates the mechanical conversion for nginx, GCE, HAProxy, and Traefik. TCPRoute and TLSRoute extend the Gateway API beyond HTTP, providing a unified routing layer for all traffic types without resorting to controller-specific annotations or CRDs. As of 2025, all major Kubernetes networking providers — nginx-gateway, Istio, Cilium, and Envoy Gateway — support the full Gateway API v1 stable channel.
