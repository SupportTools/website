---
title: "Kubernetes Gateway API: Replacing Ingress for Production Traffic Management"
date: 2027-12-06T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Gateway API", "Networking", "HTTPRoute", "GRPCRoute", "TLSRoute", "Ingress", "cert-manager"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive production guide to Kubernetes Gateway API covering HTTPRoute, GRPCRoute, TLSRoute, ReferenceGrant, migration from nginx-ingress, multi-cluster routing, and cert-manager integration."
more_link: "yes"
url: /kubernetes-gateway-api-advanced-production-guide/
---

The Kubernetes Gateway API represents the most significant evolution in cluster traffic management since Ingress was introduced. Where Ingress left most configuration to provider-specific annotations, Gateway API provides a structured, role-oriented model that separates infrastructure concerns from application routing concerns. This guide covers everything required to deploy Gateway API in production, migrate from nginx-ingress, configure advanced routing patterns, and integrate with cert-manager for automated TLS.

<!--more-->

# Kubernetes Gateway API: Replacing Ingress for Production Traffic Management

## The Problem With Ingress

Kubernetes Ingress has served the community for years, but its design shows its age. The spec was intentionally minimal, leaving L7 routing features to implementation-specific annotations. A team running nginx-ingress uses `nginx.ingress.kubernetes.io/` annotations; a team running Traefik uses `traefik.ingress.kubernetes.io/` annotations. Neither annotation set is portable. When an organization switches controllers, every Ingress manifest must be rewritten.

Beyond portability, Ingress has a role model problem. The spec conflates two distinct concerns:

1. **Infrastructure configuration** - which load balancer IP to bind, which TLS termination certificates to use at the gateway level
2. **Application routing** - which URL paths map to which backend services

In large organizations, the platform team owns the first concern and application teams own the second. Ingress forces both into a single resource, creating either excessive RBAC grants or operational friction.

Gateway API solves both problems with a tiered resource model and a first-class spec for every routing concern.

## Gateway API Resource Model

Gateway API introduces four primary resource types organized into two tiers:

```
GatewayClass (cluster-scoped, owned by infrastructure team)
    └── Gateway (namespace or cluster-scoped, owned by platform team)
            └── HTTPRoute / GRPCRoute / TLSRoute / TCPRoute / UDPRoute
                    (namespace-scoped, owned by application teams)
```

### GatewayClass

`GatewayClass` is the cluster-scoped resource that identifies a Gateway controller implementation. It mirrors the relationship between `StorageClass` and a CSI driver.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: cilium
spec:
  controllerName: io.cilium/gateway-controller
  description: "Cilium Gateway API implementation for production clusters"
```

### Gateway

`Gateway` represents a deployed load balancer instance with specific listener configurations. The platform team creates and owns this resource.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: prod-gateway
  namespace: gateway-system
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
spec:
  gatewayClassName: cilium
  listeners:
    - name: http
      protocol: HTTP
      port: 80
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              gateway-access: "true"
    - name: https
      protocol: HTTPS
      port: 443
      tls:
        mode: Terminate
        certificateRefs:
          - name: wildcard-tls
            namespace: gateway-system
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              gateway-access: "true"
    - name: grpc
      protocol: HTTPS
      port: 9443
      tls:
        mode: Terminate
        certificateRefs:
          - name: grpc-tls
            namespace: gateway-system
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              grpc-access: "true"
```

The `allowedRoutes` field is the key security boundary. It controls which namespaces can attach routes to this Gateway, enforcing the separation between infrastructure and application teams.

## Installing the Gateway API CRDs

Gateway API CRDs must be installed separately from any controller. The CRDs are versioned independently of Kubernetes itself.

```bash
# Install the standard channel CRDs (v1 resources: HTTPRoute, Gateway, GatewayClass)
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/standard-install.yaml

# Install the experimental channel CRDs (GRPCRoute, TCPRoute, UDPRoute, TLSRoute)
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/experimental-install.yaml

# Verify CRD installation
kubectl get crds | grep gateway.networking.k8s.io
```

Expected output:

```
gatewayclasses.gateway.networking.k8s.io        2024-01-15T00:00:00Z
gateways.gateway.networking.k8s.io              2024-01-15T00:00:00Z
grpcroutes.gateway.networking.k8s.io            2024-01-15T00:00:00Z
httproutes.gateway.networking.k8s.io            2024-01-15T00:00:00Z
referencegrants.gateway.networking.k8s.io       2024-01-15T00:00:00Z
tcproutes.gateway.networking.k8s.io             2024-01-15T00:00:00Z
tlsroutes.gateway.networking.k8s.io             2024-01-15T00:00:00Z
```

## Installing Cilium as a Gateway Controller

Cilium is a recommended Gateway API implementation for production clusters due to its eBPF-based data plane and native Kubernetes network policy integration.

```bash
# Install Cilium with Gateway API support enabled
helm repo add cilium https://helm.cilium.io/
helm repo update

helm install cilium cilium/cilium \
  --version 1.16.0 \
  --namespace kube-system \
  --set kubeProxyReplacement=true \
  --set gatewayAPI.enabled=true \
  --set gatewayAPI.enableAlpn=true \
  --set gatewayAPI.enableAppProtocol=true \
  --set loadBalancer.l7.backend=envoy \
  --set envoy.enabled=true
```

Verify the GatewayClass is accepted:

```bash
kubectl get gatewayclass
# NAME     CONTROLLER                      ACCEPTED   AGE
# cilium   io.cilium/gateway-controller    True       2m
```

## HTTPRoute: Application Traffic Routing

`HTTPRoute` is the primary resource application teams use to configure HTTP/HTTPS routing.

### Basic HTTPRoute

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-route
  namespace: api-team
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
            value: /v1
      backendRefs:
        - name: api-v1-service
          port: 8080
          weight: 100
    - matches:
        - path:
            type: PathPrefix
            value: /v2
      backendRefs:
        - name: api-v2-service
          port: 8080
          weight: 100
```

### Traffic Splitting for Canary Deployments

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: frontend-canary
  namespace: frontend-team
spec:
  parentRefs:
    - name: prod-gateway
      namespace: gateway-system
      sectionName: https
  hostnames:
    - "app.example.com"
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: frontend-stable
          port: 80
          weight: 90
        - name: frontend-canary
          port: 80
          weight: 10
```

### Header-Based Routing

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: header-routing
  namespace: platform-team
spec:
  parentRefs:
    - name: prod-gateway
      namespace: gateway-system
      sectionName: https
  hostnames:
    - "platform.example.com"
  rules:
    - matches:
        - headers:
            - name: "x-env"
              value: "canary"
      backendRefs:
        - name: platform-canary
          port: 8080
    - matches:
        - headers:
            - name: "x-region"
              value: "us-east-1"
      backendRefs:
        - name: platform-us-east
          port: 8080
    - backendRefs:
        - name: platform-default
          port: 8080
```

### HTTP-to-HTTPS Redirect

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: http-redirect
  namespace: gateway-system
spec:
  parentRefs:
    - name: prod-gateway
      namespace: gateway-system
      sectionName: http
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
  namespace: api-team
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
            value: /internal
      filters:
        - type: RequestHeaderModifier
          requestHeaderModifier:
            add:
              - name: X-Internal-Request
                value: "true"
              - name: X-Request-Source
                value: "gateway"
            remove:
              - X-Forwarded-For
        - type: ResponseHeaderModifier
          responseHeaderModifier:
            add:
              - name: X-Response-Time
                value: "cached"
            remove:
              - Server
      backendRefs:
        - name: internal-api
          port: 8080
```

## GRPCRoute: Native gRPC Routing

`GRPCRoute` provides first-class support for gRPC traffic, eliminating the need for annotation workarounds.

```yaml
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: GRPCRoute
metadata:
  name: grpc-service-route
  namespace: grpc-team
spec:
  parentRefs:
    - name: prod-gateway
      namespace: gateway-system
      sectionName: grpc
  hostnames:
    - "grpc.example.com"
  rules:
    - matches:
        - method:
            service: "com.example.UserService"
            method: "GetUser"
      backendRefs:
        - name: user-service
          port: 9090
    - matches:
        - method:
            service: "com.example.OrderService"
      backendRefs:
        - name: order-service
          port: 9090
          weight: 80
        - name: order-service-v2
          port: 9090
          weight: 20
```

## TLSRoute: Passthrough TLS Routing

`TLSRoute` handles TLS passthrough scenarios where the gateway should not terminate TLS but route based on SNI.

```yaml
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: TLSRoute
metadata:
  name: database-tls-route
  namespace: data-team
spec:
  parentRefs:
    - name: prod-gateway
      namespace: gateway-system
      sectionName: tls-passthrough
  rules:
    - backendRefs:
        - name: postgres-primary
          port: 5432
```

The corresponding Gateway listener for TLS passthrough:

```yaml
- name: tls-passthrough
  protocol: TLS
  port: 5432
  tls:
    mode: Passthrough
  allowedRoutes:
    namespaces:
      from: Selector
      selector:
        matchLabels:
          database-access: "true"
```

## ReferenceGrant: Cross-Namespace Backend References

By default, routes can only reference backends in the same namespace. `ReferenceGrant` explicitly permits cross-namespace references.

```yaml
# In the namespace that OWNS the service (e.g., shared-services)
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-api-team-access
  namespace: shared-services
spec:
  from:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      namespace: api-team
  to:
    - group: ""
      kind: Service
      name: shared-api-service
```

With this grant in place, the api-team namespace can reference the service:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: shared-service-route
  namespace: api-team
spec:
  parentRefs:
    - name: prod-gateway
      namespace: gateway-system
      sectionName: https
  rules:
    - backendRefs:
        - name: shared-api-service
          namespace: shared-services
          port: 8080
```

Without the `ReferenceGrant`, the cross-namespace reference is rejected by the controller with a status condition indicating the missing grant.

## cert-manager Integration

cert-manager 1.14+ supports Gateway API natively. Certificates can be automatically provisioned and renewed for Gateway listeners.

### ClusterIssuer for Let's Encrypt

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: platform@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-key
    solvers:
      - dns01:
          route53:
            region: us-east-1
            hostedZoneID: Z1234567890ABC
            accessKeyIDSecretRef:
              name: route53-credentials
              key: access-key-id
            secretAccessKeySecretRef:
              name: route53-credentials
              key: secret-access-key
```

### Certificate Resource for Gateway

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: gateway-wildcard-cert
  namespace: gateway-system
spec:
  secretName: wildcard-tls
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  dnsNames:
    - "*.example.com"
    - "example.com"
  duration: 2160h   # 90 days
  renewBefore: 360h # 15 days before expiry
  privateKey:
    algorithm: ECDSA
    size: 256
```

### Automatic Gateway TLS via Annotation

cert-manager can also watch Gateway resources directly when the annotation is present:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: prod-gateway
  namespace: gateway-system
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
spec:
  gatewayClassName: cilium
  listeners:
    - name: https
      protocol: HTTPS
      port: 443
      hostname: "*.example.com"
      tls:
        mode: Terminate
        certificateRefs:
          - name: gateway-wildcard-cert
            namespace: gateway-system
```

cert-manager detects the Gateway and automatically creates a `CertificateRequest`, provisions the certificate, and stores it in the referenced Secret.

## Migrating from nginx-ingress

Migration from nginx-ingress to Gateway API requires translating annotations into structured route filters and backend policies.

### Migration Mapping Reference

| nginx-ingress annotation | Gateway API equivalent |
|---|---|
| `nginx.ingress.kubernetes.io/rewrite-target` | `HTTPRoute` URLRewrite filter |
| `nginx.ingress.kubernetes.io/ssl-redirect` | Separate HTTPRoute with RequestRedirect |
| `nginx.ingress.kubernetes.io/proxy-body-size` | BackendLBPolicy or implementation-specific |
| `nginx.ingress.kubernetes.io/rate-limit` | Implementation-specific BackendPolicy |
| `nginx.ingress.kubernetes.io/auth-url` | External auth via ExtensionRef filter |
| `nginx.ingress.kubernetes.io/canary` | Native weight-based backendRefs |
| `nginx.ingress.kubernetes.io/configuration-snippet` | HTTPRoute filters |

### Rewrite Target Migration

nginx-ingress annotation approach:

```yaml
# Old: nginx-ingress with rewrite
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /$2
spec:
  rules:
    - host: example.com
      http:
        paths:
          - path: /api(/|$)(.*)
            pathType: Prefix
            backend:
              service:
                name: api-service
                port:
                  number: 8080
```

Gateway API equivalent:

```yaml
# New: HTTPRoute with URLRewrite filter
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-rewrite
spec:
  parentRefs:
    - name: prod-gateway
      namespace: gateway-system
      sectionName: https
  hostnames:
    - "example.com"
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
```

### Migration Script

The following script automates identification of Ingress resources ready for migration:

```bash
#!/bin/bash
# identify-ingress-for-migration.sh
# Scans all Ingress resources and reports migration complexity

set -euo pipefail

echo "=== Ingress Migration Analysis ==="
echo ""

echo "Total Ingress resources:"
kubectl get ingress -A --no-headers 2>/dev/null | wc -l

echo ""
echo "Ingress resources with complex annotations:"
kubectl get ingress -A -o json | jq -r '
  .items[] |
  select(.metadata.annotations // {} | keys | map(select(startswith("nginx.ingress.kubernetes.io/"))) | length > 0) |
  "\(.metadata.namespace)/\(.metadata.name): \(.metadata.annotations | keys | map(select(startswith("nginx.ingress.kubernetes.io/"))) | length) annotations"
'

echo ""
echo "Hosts currently served by Ingress:"
kubectl get ingress -A -o jsonpath='{range .items[*]}{.spec.rules[*].host}{"\n"}{end}' | sort -u
```

### Parallel Running Strategy

During migration, run both nginx-ingress and Gateway API simultaneously. Use DNS-based traffic shifting to gradually move traffic:

```bash
# Phase 1: Deploy Gateway API alongside nginx-ingress
# Both process the same hostnames - DNS controls which receives traffic

# Phase 2: Shift 10% of traffic to Gateway API via weighted DNS

# Phase 3: Monitor error rates on both paths
kubectl get httproute -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}: {.status.conditions[?(@.type=="Accepted")].status}{"\n"}{end}'

# Phase 4: Complete cutover by removing nginx-ingress resources
kubectl delete ingress -A -l migration-phase=complete
```

## Multi-Cluster Routing

For organizations operating multiple clusters, Gateway API enables consistent routing configuration that can be templated across environments.

### Environment-Specific Gateway Configuration with Kustomize

```yaml
# base/gateway.yaml - shared configuration
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: prod-gateway
  namespace: gateway-system
spec:
  gatewayClassName: cilium
  listeners:
    - name: https
      protocol: HTTPS
      port: 443
      tls:
        mode: Terminate
        certificateRefs:
          - name: tls-cert
            namespace: gateway-system
      allowedRoutes:
        namespaces:
          from: All
```

```yaml
# overlays/us-east-1/gateway-patch.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: prod-gateway
  namespace: gateway-system
spec:
  addresses:
    - type: IPAddress
      value: "203.0.113.10"
```

## Backend Policies: Timeouts and Retry

Gateway API v1.1 introduced `BackendLBPolicy` and `BackendTLSPolicy`. Many controllers also support implementation-specific policies.

### Timeout Configuration via HTTPRoute

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-with-timeouts
  namespace: api-team
spec:
  parentRefs:
    - name: prod-gateway
      namespace: gateway-system
      sectionName: https
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /slow-endpoint
      timeouts:
        request: 30s
        backendRequest: 25s
      backendRefs:
        - name: slow-service
          port: 8080
```

### Backend TLS Policy

```yaml
apiVersion: gateway.networking.k8s.io/v1alpha3
kind: BackendTLSPolicy
metadata:
  name: backend-tls
  namespace: api-team
spec:
  targetRefs:
    - group: ""
      kind: Service
      name: secure-backend
  validation:
    caCertificateRefs:
      - name: internal-ca-cert
        group: ""
        kind: ConfigMap
    hostname: secure-backend.api-team.svc.cluster.local
```

## Monitoring Gateway API Resources

### Prometheus Metrics for Cilium Gateway

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: cilium-gateway-metrics
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: cilium-agent
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
```

### Useful Gateway API Status Queries

```bash
# Check all Gateway status conditions
kubectl get gateway -A -o custom-columns=\
'NAMESPACE:.metadata.namespace,NAME:.metadata.name,CLASS:.spec.gatewayClassName,READY:.status.conditions[?(@.type=="Ready")].status,ADDRESS:.status.addresses[0].value'

# Check HTTPRoute attachment status
kubectl get httproute -A -o custom-columns=\
'NAMESPACE:.metadata.namespace,NAME:.metadata.name,HOSTNAMES:.spec.hostnames[*],PARENT:.spec.parentRefs[0].name,ACCEPTED:.status.parents[0].conditions[?(@.type=="Accepted")].status'

# Identify routes with errors
kubectl get httproute -A -o json | jq '
  .items[] |
  select(
    .status.parents[]?.conditions[]? |
    select(.type == "ResolvedRefs" and .status != "True")
  ) |
  "\(.metadata.namespace)/\(.metadata.name)"
'
```

### Alert Rules for Gateway Health

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: gateway-api-alerts
  namespace: monitoring
spec:
  groups:
    - name: gateway-api
      interval: 30s
      rules:
        - alert: GatewayNotReady
          expr: |
            kube_gateway_status_condition{condition="Ready",status="False"} == 1
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Gateway {{ $labels.namespace }}/{{ $labels.name }} is not ready"
            description: "Gateway has been not ready for more than 5 minutes"
        - alert: HTTPRouteNotAccepted
          expr: |
            kube_httproute_status_parent_condition{condition="Accepted",status="False"} == 1
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "HTTPRoute {{ $labels.namespace }}/{{ $labels.name }} not accepted"
```

## RBAC Configuration

Gateway API's role-based design maps naturally to Kubernetes RBAC.

### Platform Team Role (Gateway Management)

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: gateway-admin
rules:
  - apiGroups: ["gateway.networking.k8s.io"]
    resources: ["gateways", "gatewayclasses"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["gateway.networking.k8s.io"]
    resources: ["referencegrants"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: gateway-admin-binding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: gateway-admin
subjects:
  - kind: Group
    name: platform-team
    apiGroup: rbac.authorization.k8s.io
```

### Application Team Role (Route Management)

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: route-manager
  namespace: api-team
rules:
  - apiGroups: ["gateway.networking.k8s.io"]
    resources: ["httproutes", "grpcroutes", "tlsroutes", "tcproutes"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: route-manager-binding
  namespace: api-team
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: route-manager
subjects:
  - kind: Group
    name: api-team-developers
    apiGroup: rbac.authorization.k8s.io
```

## Conformance Testing

The Gateway API project maintains a conformance test suite. Before adopting a controller implementation in production, run the suite to verify compliance:

```bash
# Run conformance tests against the installed implementation
go test ./conformance/... \
  -gateway-class=cilium \
  -supported-features=HTTPRoute,GRPCRoute,TLSRoute \
  -run TestConformance \
  -v 2>&1 | tee conformance-results.txt

# Check conformance report
grep -E "PASS|FAIL|SKIP" conformance-results.txt
```

## Production Checklist

Before promoting Gateway API to production, verify the following:

```bash
#!/bin/bash
# gateway-api-production-check.sh

set -euo pipefail

ERRORS=0

echo "=== Gateway API Production Readiness Check ==="

# 1. Verify CRD versions
echo -n "Checking Gateway API CRD versions... "
INSTALLED=$(kubectl get crd gateways.gateway.networking.k8s.io -o jsonpath='{.spec.versions[*].name}')
if echo "$INSTALLED" | grep -q "v1"; then
  echo "OK (v1 CRDs present)"
else
  echo "FAIL - v1 CRDs not installed"
  ERRORS=$((ERRORS + 1))
fi

# 2. Verify GatewayClass accepted
echo -n "Checking GatewayClass status... "
ACCEPTED=$(kubectl get gatewayclass -o jsonpath='{.items[*].status.conditions[?(@.type=="Accepted")].status}')
if echo "$ACCEPTED" | grep -q "True"; then
  echo "OK"
else
  echo "FAIL - No accepted GatewayClass found"
  ERRORS=$((ERRORS + 1))
fi

# 3. Verify all Gateways ready
echo -n "Checking Gateway readiness... "
NOT_READY=$(kubectl get gateway -A -o json | jq '[.items[] | select(.status.conditions[]? | select(.type == "Ready" and .status != "True"))] | length')
if [ "$NOT_READY" -eq 0 ]; then
  echo "OK"
else
  echo "FAIL - $NOT_READY Gateway(s) not ready"
  ERRORS=$((ERRORS + 1))
fi

# 4. Check for unresolved HTTPRoutes
echo -n "Checking HTTPRoute resolution... "
UNRESOLVED=$(kubectl get httproute -A -o json | jq '[.items[] | select(.status.parents[]?.conditions[]? | select(.type == "ResolvedRefs" and .status != "True"))] | length')
if [ "$UNRESOLVED" -eq 0 ]; then
  echo "OK"
else
  echo "WARN - $UNRESOLVED HTTPRoute(s) with unresolved refs"
fi

echo ""
if [ "$ERRORS" -eq 0 ]; then
  echo "All checks passed. Gateway API is production-ready."
else
  echo "$ERRORS check(s) failed. Review errors before proceeding."
  exit 1
fi
```

## Troubleshooting Common Issues

### Route Not Attached to Gateway

Symptom: `HTTPRoute` status shows `status.parents` with `Accepted: False`.

```bash
# Inspect route status
kubectl describe httproute <route-name> -n <namespace>

# Common causes:
# 1. Gateway namespace label missing
kubectl label namespace api-team gateway-access=true

# 2. sectionName typo in parentRef
kubectl get gateway prod-gateway -n gateway-system -o jsonpath='{.spec.listeners[*].name}'

# 3. No matching allowedRoutes selector
kubectl get gateway prod-gateway -n gateway-system -o yaml | grep -A 10 allowedRoutes
```

### Backend Service Not Found

Symptom: `ResolvedRefs` condition is `False` with message indicating service not found.

```bash
# Verify service exists
kubectl get service <service-name> -n <namespace>

# For cross-namespace references, verify ReferenceGrant
kubectl get referencegrant -n <service-namespace>

# Check controller logs
kubectl logs -n kube-system -l app.kubernetes.io/name=cilium-operator --tail=50 \
  | grep -i "httproute\|gateway"
```

### TLS Certificate Not Provisioned

```bash
# Check Certificate resource status
kubectl describe certificate gateway-wildcard-cert -n gateway-system

# Check CertificateRequest
kubectl get certificaterequest -n gateway-system

# Check cert-manager logs
kubectl logs -n cert-manager -l app=cert-manager --tail=100 \
  | grep -i "error\|gateway"
```

## Summary

Kubernetes Gateway API resolves the fundamental limitations of Ingress by providing a structured, role-oriented model that cleanly separates infrastructure configuration from application routing. The tiered resource hierarchy (GatewayClass, Gateway, Routes) maps directly to organizational ownership boundaries. Features that previously required controller-specific annotations are now first-class API constructs: traffic splitting, header manipulation, URL rewriting, gRPC routing, and TLS passthrough all have dedicated spec fields.

For organizations ready to migrate from nginx-ingress, the parallel-running strategy enables a low-risk transition. The key steps are: install Gateway API CRDs, deploy a conformant controller alongside the existing nginx-ingress, create equivalent HTTPRoute resources, validate routing behavior, then shift DNS traffic. The `ReferenceGrant` mechanism provides a clear security model for cross-namespace service references that Ingress never addressed.

Gateway API is stable at v1 for `HTTPRoute`, `Gateway`, and `GatewayClass`. Production adoption is appropriate for organizations that value the structured API model and need features beyond what basic Ingress provides.
