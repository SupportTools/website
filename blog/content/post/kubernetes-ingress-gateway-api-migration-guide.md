---
title: "Migrating from Kubernetes Ingress to Gateway API: A Practical Guide"
date: 2028-03-25T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Gateway API", "Ingress", "Networking", "NGINX", "Envoy", "Traffic Management"]
categories: ["Kubernetes", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive migration guide from Kubernetes Ingress to Gateway API, covering resource hierarchy, traffic splitting, header-based routing, TLS configuration, and multi-team gateway ownership models with NGINX and Envoy Gateway implementations."
more_link: "yes"
url: "/kubernetes-ingress-gateway-api-migration-guide/"
---

Kubernetes Gateway API represents the next generation of traffic management in Kubernetes, moving beyond the limitations of the original Ingress resource. Where Ingress was designed for a single HTTP load balancer, Gateway API introduces a layered resource model that cleanly separates infrastructure provider concerns from application team routing decisions. This guide walks through a production migration path from Ingress to Gateway API, covering every resource type, traffic pattern, and TLS configuration required for a complete transition.

<!--more-->

## Why Gateway API Replaces Ingress

The Kubernetes Ingress resource served well for simple HTTP/HTTPS routing but accumulated a significant architectural debt over time. Capabilities that every production team needed — traffic splitting, header-based routing, TCP/UDP load balancing — were implemented through non-standard, vendor-specific annotations. A configuration that worked with the NGINX Ingress Controller required complete rewriting for Traefik, Istio, or AWS ALB.

Gateway API solves this through a role-oriented resource hierarchy:

- **GatewayClass**: Defined by infrastructure operators; identifies which controller implements the gateway.
- **Gateway**: Defined by cluster operators; specifies listener ports, protocols, and TLS configuration.
- **HTTPRoute / TCPRoute / TLSRoute**: Defined by application teams; attaches routing rules to a Gateway.

This separation is not cosmetic. A platform team can own all Gateway resources and grant application teams the ability to attach HTTPRoutes without giving them control over TLS certificates or listener configuration.

## Gateway API Resource Hierarchy

### GatewayClass

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: envoy-gateway
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
  description: "Production gateway managed by the platform team"
  parametersRef:
    group: gateway.envoyproxy.io
    kind: EnvoyProxy
    name: default-proxy-config
    namespace: envoy-gateway-system
```

The `controllerName` field is the critical link between a GatewayClass and its controller implementation. Only the controller matching this string will reconcile Gateway resources that reference this class. Multiple GatewayClass resources can exist in a cluster simultaneously — one for external traffic handled by Envoy Gateway, another for internal traffic handled by NGINX Gateway Fabric.

### Gateway

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: production-gateway
  namespace: gateway-system
  annotations:
    # Envoy Gateway specific: configure access logging
    gateway.envoyproxy.io/merge-gateways: "false"
spec:
  gatewayClassName: envoy-gateway
  listeners:
    - name: http
      protocol: HTTP
      port: 80
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              gateway-access: "allowed"
    - name: https
      protocol: HTTPS
      port: 443
      tls:
        mode: Terminate
        certificateRefs:
          - name: production-tls
            namespace: gateway-system
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              gateway-access: "allowed"
    - name: tcp-postgres
      protocol: TCP
      port: 5432
      allowedRoutes:
        namespaces:
          from: Same
```

The `allowedRoutes` section implements the multi-team ownership model. Application namespaces labeled `gateway-access: allowed` can attach HTTPRoutes to this Gateway. Namespaces without this label are blocked from attaching routes, preventing unauthorized traffic injection.

### HTTPRoute — Basic Host and Path Routing

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-service-route
  namespace: team-payments
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-system
      sectionName: https
  hostnames:
    - "api.example.com"
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /v1/payments
          headers:
            - name: X-API-Version
              value: "2024"
      backendRefs:
        - name: payments-service-v2
          port: 8080
          weight: 100
      filters:
        - type: RequestHeaderModifier
          requestHeaderModifier:
            add:
              - name: X-Forwarded-Team
                value: payments
            remove:
              - X-Internal-Debug
        - type: ResponseHeaderModifier
          responseHeaderModifier:
            add:
              - name: Cache-Control
                value: "no-store"
    - matches:
        - path:
            type: PathPrefix
            value: /v1/payments
      backendRefs:
        - name: payments-service-v1
          port: 8080
          weight: 100
```

## Migration Path from Ingress

### Step 1: Audit Existing Ingress Resources

Before migrating, catalogue all Ingress resources and their annotations:

```bash
#!/bin/bash
# inventory-ingress.sh - Generate migration inventory

echo "=== Ingress Resource Inventory ==="
kubectl get ingress --all-namespaces -o json | jq -r '
  .items[] |
  {
    namespace: .metadata.namespace,
    name: .metadata.name,
    class: (.metadata.annotations["kubernetes.io/ingress.class"] // .spec.ingressClassName // "default"),
    hosts: [.spec.rules[]?.host] | join(","),
    tls: (if .spec.tls then "yes" else "no" end),
    annotations: (.metadata.annotations | keys | map(select(startswith("nginx.ingress") or startswith("traefik"))) | join(","))
  } |
  [.namespace, .name, .class, .hosts, .tls, .annotations] |
  @tsv
' | column -t

echo ""
echo "=== Annotation Patterns Found ==="
kubectl get ingress --all-namespaces -o json | jq -r '
  .items[].metadata.annotations // {} | keys[]
' | sort | uniq -c | sort -rn | head -30
```

This produces a tabular view of all Ingress resources and identifies which vendor annotations need equivalent Gateway API configuration.

### Step 2: Common NGINX Annotation Translations

The following table maps the most frequently used NGINX Ingress annotations to their Gateway API equivalents:

| NGINX Annotation | Gateway API Equivalent |
|---|---|
| `nginx.ingress.kubernetes.io/rewrite-target` | HTTPRoute `URLRewrite` filter |
| `nginx.ingress.kubernetes.io/ssl-redirect` | HTTPRoute redirect rule on HTTP listener |
| `nginx.ingress.kubernetes.io/proxy-connect-timeout` | BackendLBPolicy or implementation-specific |
| `nginx.ingress.kubernetes.io/proxy-read-timeout` | BackendLBPolicy |
| `nginx.ingress.kubernetes.io/proxy-body-size` | HTTPRoute RequestMirror or implementation-specific |
| `nginx.ingress.kubernetes.io/canary` | HTTPRoute weights |
| `nginx.ingress.kubernetes.io/canary-weight` | HTTPRoute backend weights |
| `nginx.ingress.kubernetes.io/canary-by-header` | HTTPRoute header matches |
| `nginx.ingress.kubernetes.io/auth-url` | ExtensionRef filter (implementation-specific) |
| `nginx.ingress.kubernetes.io/rate-limit` | RateLimitPolicy (implementation-specific) |

### Step 3: Translate a Typical Ingress

Original Ingress with common annotations:

```yaml
# BEFORE: Ingress with NGINX annotations
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: frontend-ingress
  namespace: team-frontend
  annotations:
    kubernetes.io/ingress.class: nginx
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/rewrite-target: /$2
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-weight: "10"
    nginx.ingress.kubernetes.io/proxy-connect-timeout: "10"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "60"
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  tls:
    - hosts:
        - app.example.com
      secretName: app-tls
  rules:
    - host: app.example.com
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
```

Equivalent Gateway API configuration:

```yaml
# AFTER: Gateway API resources
---
# HTTP to HTTPS redirect (replaces ssl-redirect annotation)
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: frontend-http-redirect
  namespace: team-frontend
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-system
      sectionName: http
  hostnames:
    - "app.example.com"
  rules:
    - filters:
        - type: RequestRedirect
          requestRedirect:
            scheme: https
            statusCode: 301
---
# Main HTTPS routing
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: frontend-https-route
  namespace: team-frontend
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-system
      sectionName: https
  hostnames:
    - "app.example.com"
  rules:
    # API path with URL rewrite (replaces rewrite-target annotation)
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
        - name: api-service-canary
          port: 8080
          weight: 10
    # Frontend path
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: frontend-service
          port: 3000
```

The canary annotation pattern (10% traffic split) becomes explicit `weight` values on `backendRefs`. This is one area where Gateway API is strictly more readable than annotations.

## Traffic Splitting with HTTPRoute Weights

Traffic splitting is a first-class citizen in Gateway API. The weight field on each `backendRef` controls the proportion of traffic sent to each backend. Weights are relative to each other, not percentages — though using values that sum to 100 makes the intent obvious.

### Blue-Green Deployment Pattern

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: checkout-route
  namespace: team-checkout
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-system
      sectionName: https
  hostnames:
    - "checkout.example.com"
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: checkout-blue
          port: 8080
          weight: 100   # Initially: all traffic to blue
        - name: checkout-green
          port: 8080
          weight: 0     # Green receives no traffic yet
```

To shift traffic, patch the HTTPRoute:

```bash
# Shift 10% to green (canary phase)
kubectl patch httproute checkout-route -n team-checkout \
  --type='json' \
  -p='[
    {"op":"replace","path":"/spec/rules/0/backendRefs/0/weight","value":90},
    {"op":"replace","path":"/spec/rules/0/backendRefs/1/weight","value":10}
  ]'

# Verify the route
kubectl get httproute checkout-route -n team-checkout -o jsonpath='{.spec.rules[0].backendRefs}' | jq .

# Full cutover to green
kubectl patch httproute checkout-route -n team-checkout \
  --type='json' \
  -p='[
    {"op":"replace","path":"/spec/rules/0/backendRefs/0/weight","value":0},
    {"op":"replace","path":"/spec/rules/0/backendRefs/1/weight","value":100}
  ]'
```

### Header-Based Routing for Testing

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: user-service-route
  namespace: team-platform
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-system
      sectionName: https
  hostnames:
    - "users.example.com"
  rules:
    # Route QA team to new version via header
    - matches:
        - headers:
            - name: X-Deploy-Stage
              value: canary
      backendRefs:
        - name: user-service-v2
          port: 8080
    # Route traffic with specific user-agent to new version
    - matches:
        - headers:
            - name: User-Agent
              type: RegularExpression
              value: ".*InternalTestClient.*"
      backendRefs:
        - name: user-service-v2
          port: 8080
    # All other traffic to stable version
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: user-service-v1
          port: 8080
```

Rule precedence in HTTPRoute is first-match, top-to-bottom. More specific rules (header matches) must appear before catch-all path rules.

## TLS Termination and Passthrough

### TLS Termination at the Gateway

Standard TLS termination where the Gateway decrypts traffic:

```yaml
# TLS certificate (typically managed by cert-manager)
apiVersion: v1
kind: Secret
metadata:
  name: example-tls
  namespace: gateway-system
type: kubernetes.io/tls
data:
  tls.crt: <base64-encoded-cert>
  tls.key: <base64-encoded-key>
---
# Gateway listener with TLS termination
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: edge-gateway
  namespace: gateway-system
spec:
  gatewayClassName: envoy-gateway
  listeners:
    - name: https-external
      protocol: HTTPS
      port: 443
      hostname: "*.example.com"
      tls:
        mode: Terminate
        certificateRefs:
          - group: ""
            kind: Secret
            name: wildcard-tls
            namespace: gateway-system
      allowedRoutes:
        namespaces:
          from: All
```

### TLS Passthrough for End-to-End Encryption

When backend services require end-to-end TLS (databases, legacy services), use TLS passthrough mode with TLSRoute:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: edge-gateway
  namespace: gateway-system
spec:
  gatewayClassName: envoy-gateway
  listeners:
    - name: tls-passthrough
      protocol: TLS
      port: 8443
      tls:
        mode: Passthrough
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              tls-passthrough: "enabled"
---
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: TLSRoute
metadata:
  name: postgres-tls-route
  namespace: team-data
spec:
  parentRefs:
    - name: edge-gateway
      namespace: gateway-system
      sectionName: tls-passthrough
  hostnames:
    - "db.example.com"
  rules:
    - backendRefs:
        - name: postgres-primary
          port: 5432
```

In passthrough mode, the Gateway cannot inspect HTTP headers. Routing decisions are made on the SNI (Server Name Indication) hostname from the TLS handshake.

### Cross-Namespace Certificate References

When a Gateway in `gateway-system` needs to reference a certificate in another namespace, a `ReferenceGrant` is required:

```yaml
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-gateway-cert-access
  namespace: cert-storage
spec:
  from:
    - group: gateway.networking.k8s.io
      kind: Gateway
      namespace: gateway-system
  to:
    - group: ""
      kind: Secret
      name: production-wildcard-tls
```

This grant must exist in the namespace that owns the Secret (`cert-storage`), not in the namespace of the Gateway. This design ensures that certificate namespace owners explicitly authorize cross-namespace access.

## Multi-Team Gateway Ownership Model

### Namespace Labels and RBAC

```yaml
# Label namespaces that are permitted to attach routes
apiVersion: v1
kind: Namespace
metadata:
  name: team-payments
  labels:
    gateway-access: "allowed"
    team: "payments"
    environment: "production"
---
# RBAC: Allow application teams to manage HTTPRoutes in their namespace
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: httproute-manager
  namespace: team-payments
rules:
  - apiGroups: ["gateway.networking.k8s.io"]
    resources: ["httproutes"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["gateway.networking.k8s.io"]
    resources: ["httproutes/status"]
    verbs: ["get"]
---
# Application teams cannot modify Gateways or GatewayClasses
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: gateway-readonly
rules:
  - apiGroups: ["gateway.networking.k8s.io"]
    resources: ["gateways", "gatewayclasses"]
    verbs: ["get", "list", "watch"]
```

### Route Attachment Status

Check whether a route successfully attached to its Gateway:

```bash
# Check HTTPRoute status
kubectl get httproute api-service-route -n team-payments -o json | jq '
  .status.parents[] | {
    parentRef: .parentRef,
    conditions: .conditions | map({
      type: .type,
      status: .status,
      reason: .reason,
      message: .message
    })
  }
'

# Common status conditions:
# Accepted: true  -> Route matched and was accepted by the Gateway
# ResolvedRefs: true -> All backend services resolved
# Accepted: false, reason: NotAllowedByListeners -> Namespace label missing
# Accepted: false, reason: NoMatchingListenerHostname -> Hostname mismatch
```

## NGINX Gateway Fabric Implementation

NGINX Gateway Fabric is the official NGINX implementation of Gateway API, replacing the legacy NGINX Ingress Controller for new deployments.

### Installation

```bash
# Install NGINX Gateway Fabric via Helm
helm repo add nginx-stable https://helm.nginx.com/stable
helm repo update

# Install CRDs first
kubectl apply -f https://raw.githubusercontent.com/nginxinc/nginx-gateway-fabric/main/deploy/crds.yaml

# Install NGINX Gateway Fabric
helm install nginx-gateway-fabric nginx-stable/nginx-gateway-fabric \
  --namespace nginx-gateway \
  --create-namespace \
  --set service.type=LoadBalancer \
  --set nginxGateway.replicaCount=3 \
  --set nginx.replicaCount=3

# Verify installation
kubectl get pods -n nginx-gateway
kubectl get gatewayclass
```

### NGINX-Specific Policy Resources

```yaml
# ClientSettingsPolicy: Configure timeout and keepalive per route
apiVersion: gateway.nginx.org/v1alpha1
kind: ClientSettingsPolicy
metadata:
  name: api-client-settings
  namespace: team-api
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: api-route
  body:
    maxSize: 10m
  keepAlive:
    requests: 1000
    time: 1h
    timeout:
      header: 60s
      idle: 65s
---
# ObservabilityPolicy: Configure access logging and tracing per route
apiVersion: gateway.nginx.org/v1alpha1
kind: ObservabilityPolicy
metadata:
  name: api-observability
  namespace: team-api
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: api-route
  tracing:
    strategy: ratio
    ratio: 100
    spanName: "api-route"
    spanAttributes:
      - name: "deployment.environment"
        value: "production"
```

## Envoy Gateway Implementation

### Installation

```bash
# Install Envoy Gateway
helm install envoy-gateway oci://docker.io/envoyproxy/gateway-helm \
  --version v1.2.0 \
  --namespace envoy-gateway-system \
  --create-namespace

# Wait for Envoy Gateway to be ready
kubectl wait --timeout=5m \
  -n envoy-gateway-system \
  deployment/envoy-gateway \
  --for=condition=Available

# Verify GatewayClass was created
kubectl get gatewayclass envoy-gateway
```

### Envoy Gateway BackendTrafficPolicy

```yaml
# BackendTrafficPolicy: Circuit breaker and retry configuration
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendTrafficPolicy
metadata:
  name: payments-backend-policy
  namespace: team-payments
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: payments-route
  circuitBreaker:
    maxConnections: 1024
    maxPendingRequests: 1024
    maxParallelRequests: 1024
    maxParallelRetries: 3
  timeout:
    tcp:
      connectTimeout: 10s
    http:
      requestTimeout: 30s
      maxStreamDuration: 5m
  retry:
    numRetries: 3
    perRetry:
      timeout: 10s
    retryOn:
      triggers:
        - connect-failure
        - retriable-4xx
        - reset
      httpStatusCodes:
        - 503
        - 502
```

## Validation and Rollout Strategy

### Pre-Migration Validation Script

```bash
#!/bin/bash
# validate-gateway-api.sh - Validate Gateway API resources before cutover

set -euo pipefail

NAMESPACE=${1:-"default"}
HTTPROUTE=${2:-""}

echo "=== Gateway API Route Validation ==="

# Check Gateway status
echo "--- Gateway Status ---"
kubectl get gateways --all-namespaces -o json | jq -r '
  .items[] |
  [.metadata.namespace, .metadata.name,
   (.status.conditions // [] | map(select(.type == "Programmed")) | .[0].status // "Unknown")] |
  @tsv
' | column -t

# Check HTTPRoute attachment
echo ""
echo "--- HTTPRoute Attachment Status ---"
kubectl get httproutes --all-namespaces -o json | jq -r '
  .items[] |
  [.metadata.namespace, .metadata.name,
   (.status.parents // [] | .[0].conditions // [] | map(select(.type == "Accepted")) | .[0].status // "Unknown"),
   (.status.parents // [] | .[0].conditions // [] | map(select(.type == "ResolvedRefs")) | .[0].status // "Unknown")] |
  @tsv
' | column -t

# Check for routes with unresolved backends
echo ""
echo "--- Routes with Backend Resolution Issues ---"
kubectl get httproutes --all-namespaces -o json | jq -r '
  .items[] |
  select(.status.parents // [] | .[].conditions // [] | map(select(.type == "ResolvedRefs" and .status != "True")) | length > 0) |
  [.metadata.namespace, .metadata.name,
   (.status.parents[0].conditions | map(select(.type == "ResolvedRefs")) | .[0].message)] |
  @tsv
' | column -t

echo ""
echo "Validation complete."
```

### Parallel Running During Migration

Run Ingress and Gateway API in parallel during migration:

```bash
# Step 1: Deploy Gateway API resources (not yet receiving production traffic)
kubectl apply -f gateway-api/

# Step 2: Test via Gateway IP directly
GATEWAY_IP=$(kubectl get gateway production-gateway -n gateway-system -o jsonpath='{.status.addresses[0].value}')
curl -H "Host: api.example.com" -H "X-Deploy-Stage: canary" https://${GATEWAY_IP}/v1/users --insecure

# Step 3: Update DNS to weighted routing (10% to Gateway, 90% to Ingress)
# Handled by external DNS provider, not in Kubernetes

# Step 4: Monitor error rates, then shift 100% to Gateway
# Step 5: Delete Ingress resources
kubectl delete ingress --all -n team-payments
```

## Troubleshooting Common Issues

### Route Not Accepting

```bash
# Check the exact rejection reason
kubectl describe httproute <route-name> -n <namespace>

# Look for events
kubectl get events -n <namespace> --field-selector reason=Rejected

# Verify namespace label exists
kubectl get namespace <namespace> --show-labels
```

### Backend Not Resolving

```bash
# Verify service exists and port matches
kubectl get svc <service-name> -n <namespace>

# Check ReferenceGrant if service is in another namespace
kubectl get referencegrant -A

# Verify endpoints are populated
kubectl get endpoints <service-name> -n <namespace>
```

### Certificate Not Loading

```bash
# Check secret exists in correct namespace
kubectl get secret <cert-secret> -n gateway-system

# Verify ReferenceGrant for cross-namespace cert access
kubectl get referencegrant -n <cert-namespace> -o yaml

# Check Gateway condition
kubectl get gateway -n gateway-system -o json | jq '.items[].status.conditions'
```

## Summary

Gateway API resolves the fundamental tension in Kubernetes networking between infrastructure operators and application teams. The layered resource model makes responsibilities explicit, annotations become typed resources with schema validation, and traffic management patterns that previously required controller-specific expertise are now portable across implementations.

The migration path is incremental: run Ingress and Gateway API in parallel, validate routing behavior, then shift DNS. No big-bang cutovers are required. For teams running NGINX Ingress Controller, NGINX Gateway Fabric provides a natural migration target. For teams running Envoy-based proxies, Envoy Gateway provides the same Gateway API surface with Envoy's full feature set available through policy attachments.

The investment in migration pays dividends in operational clarity, reduced annotation sprawl, and the ability for application teams to manage their own routing rules without requiring platform team intervention for every deployment.
