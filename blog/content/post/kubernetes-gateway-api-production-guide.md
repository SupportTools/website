---
title: "Kubernetes Gateway API: Production Implementation with HTTPRoute, GRPCRoute, and Traffic Policies"
date: 2027-05-06T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Gateway API", "Ingress", "Networking", "HTTPRoute", "Envoy"]
categories: ["Kubernetes", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive production guide to the Kubernetes Gateway API covering GatewayClass, Gateway, HTTPRoute, GRPCRoute, traffic splitting, TLS termination, cross-namespace reference grants, and migration from legacy Ingress resources."
more_link: "yes"
url: "/kubernetes-gateway-api-production-guide/"
---

The Kubernetes Gateway API represents the most significant evolution in cluster ingress since the original `Ingress` resource was introduced. Where the legacy Ingress API forced routing configuration into a single flat resource with implementation-specific annotations, the Gateway API provides a role-oriented, expressive, and extensible model that maps cleanly to how platform teams and application teams actually operate. As of 2027, the Gateway API has reached GA status for its core resources and is the recommended approach for all new Kubernetes networking deployments.

This guide covers every aspect of a production Gateway API deployment: the conceptual model, each resource type, traffic splitting for canary and A/B deployments, header-based routing, URL rewriting, TLS termination, cross-namespace reference grants, and a structured migration path from legacy Ingress resources.

<!--more-->

## Why the Gateway API Replaces Ingress

The original `Ingress` resource was designed for the simplest case: HTTP/HTTPS routing to backend services. Anything beyond that required vendor-specific annotations. A production NGINX Ingress controller configuration might accumulate dozens of annotations to enable rate limiting, authentication offload, custom timeouts, canary splits, header manipulation, and WebSocket support. None of those annotations transferred to any other controller.

The Gateway API addresses this through three design principles.

**Role orientation.** Infrastructure operators manage `GatewayClass` and `Gateway` resources. Application developers manage `HTTPRoute`, `GRPCRoute`, and `TCPRoute` resources. Each role has appropriate RBAC scope, and resources in different namespaces can be composed together safely.

**Expressiveness.** Traffic splitting, header matching, query parameter matching, URL rewriting, request mirroring, and policy attachment are first-class API constructs — not annotations.

**Extensibility.** Implementations extend the API through custom policy resources attached to Gateway or Route objects, rather than through annotation proliferation.

## Gateway API Resource Hierarchy

The API is organized into four primary resource types with a clear ownership hierarchy.

### GatewayClass

`GatewayClass` is a cluster-scoped resource that defines an available gateway implementation. It maps to a controller binary (Envoy Gateway, Contour, NGINX Gateway Fabric, Istio, Cilium, etc.) and holds infrastructure-level defaults.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: envoy-gateway
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
  parametersRef:
    group: gateway.envoyproxy.io
    kind: EnvoyProxy
    name: default-proxy-config
    namespace: envoy-gateway-system
  description: "Envoy Gateway - production tier"
```

The `controllerName` is a well-known string that the controller process watches for. The `parametersRef` allows attaching an implementation-specific configuration object. Only the infrastructure operator should manage `GatewayClass` resources.

### Gateway

`Gateway` represents a deployed instance of a load balancer or proxy bound to one or more `GatewayClass`. Each `Gateway` declares its listeners — the ports, protocols, and optional TLS configuration it accepts.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: production-gateway
  namespace: ingress-system
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
              gateway-access: "true"
    - name: https
      protocol: HTTPS
      port: 443
      tls:
        mode: Terminate
        certificateRefs:
          - name: wildcard-tls-cert
            namespace: ingress-system
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              gateway-access: "true"
    - name: grpc
      protocol: HTTPS
      port: 8443
      tls:
        mode: Terminate
        certificateRefs:
          - name: grpc-tls-cert
            namespace: ingress-system
      allowedRoutes:
        namespaces:
          from: All
```

The `allowedRoutes` field is the trust boundary control. Setting `from: All` allows any namespace to attach routes to this listener. Setting `from: Same` restricts attachment to the Gateway's own namespace. Setting `from: Selector` restricts to namespaces matching a label selector, which is the recommended production pattern.

Label the application namespaces that should be allowed to attach routes:

```bash
kubectl label namespace payments gateway-access=true
kubectl label namespace checkout gateway-access=true
kubectl label namespace catalog gateway-access=true
```

### HTTPRoute

`HTTPRoute` is the primary resource for HTTP and HTTPS routing. It attaches to one or more Gateway listeners and defines match conditions and backend references.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: catalog-routes
  namespace: catalog
spec:
  parentRefs:
    - name: production-gateway
      namespace: ingress-system
      sectionName: https
  hostnames:
    - "catalog.example.com"
    - "api.example.com"
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api/v2/products
          headers:
            - name: X-API-Version
              value: "2"
      backendRefs:
        - name: catalog-api-v2
          port: 8080
          weight: 100
      filters:
        - type: RequestHeaderModifier
          requestHeaderModifier:
            add:
              - name: X-Forwarded-API
                value: "gateway"
            remove:
              - X-Internal-Debug
    - matches:
        - path:
            type: PathPrefix
            value: /api/v1/products
      backendRefs:
        - name: catalog-api-v1
          port: 8080
      filters:
        - type: URLRewrite
          urlRewrite:
            path:
              type: ReplacePrefixMatch
              replacePrefixMatch: /products
```

The `parentRefs` field establishes the attachment. The `sectionName` field targets a specific named listener on the Gateway. This allows a single `HTTPRoute` to attach to only the HTTPS listener even if the Gateway has multiple listeners.

## Traffic Splitting for Canary Deployments

The Gateway API expresses traffic splitting directly in the `HTTPRoute` spec through weighted backend references. No annotations or supplementary resources are required.

### Basic Canary Split

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: payments-canary
  namespace: payments
spec:
  parentRefs:
    - name: production-gateway
      namespace: ingress-system
      sectionName: https
  hostnames:
    - "payments.example.com"
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: payments-stable
          port: 8080
          weight: 90
        - name: payments-canary
          port: 8080
          weight: 10
```

Weights are relative values. A weight of 90 and 10 means 90% of traffic goes to stable and 10% to canary. To shift the canary to 25%, change the weights to 75 and 25. The total does not need to equal 100 but the proportions are calculated from the total.

### Header-Based Canary Routing

For internal testing or opt-in canary access, header-based routing sends specific users to the new version:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: payments-header-canary
  namespace: payments
spec:
  parentRefs:
    - name: production-gateway
      namespace: ingress-system
      sectionName: https
  hostnames:
    - "payments.example.com"
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
          headers:
            - name: X-Canary-User
              value: "true"
      backendRefs:
        - name: payments-canary
          port: 8080
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: payments-stable
          port: 8080
```

Rules are evaluated in order. The first matching rule wins. Header-based routing rules should always precede the catch-all rule.

### Query Parameter-Based Routing

```yaml
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /search
          queryParams:
            - name: experiment
              value: new-ranking
      backendRefs:
        - name: search-experimental
          port: 8080
    - matches:
        - path:
            type: PathPrefix
            value: /search
      backendRefs:
        - name: search-stable
          port: 8080
```

## URL Rewriting and Path Manipulation

URL rewrites in the Gateway API use the `URLRewrite` filter type. Two rewrite modes are available: replacing the full path or replacing a path prefix.

### Full Path Replacement

```yaml
  rules:
    - matches:
        - path:
            type: Exact
            value: /healthz
      filters:
        - type: URLRewrite
          urlRewrite:
            path:
              type: ReplaceFullPath
              replaceFullPath: /health/live
      backendRefs:
        - name: backend-service
          port: 8080
```

### Prefix Strip (API versioning migration)

Backends often expose paths without version prefixes while the gateway presents versioned paths to clients:

```yaml
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api/v3
      filters:
        - type: URLRewrite
          urlRewrite:
            path:
              type: ReplacePrefixMatch
              replacePrefixMatch: /
      backendRefs:
        - name: api-backend
          port: 8080
```

A request to `/api/v3/users/123` reaches the backend as `/users/123`.

### Hostname Rewriting

When routing to backends that expect a specific `Host` header:

```yaml
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /legacy
      filters:
        - type: URLRewrite
          urlRewrite:
            hostname: legacy-backend.internal.cluster.local
      backendRefs:
        - name: legacy-service
          port: 8080
```

## Request and Response Header Manipulation

Header manipulation is a first-class filter in the Gateway API, covering add, set, and remove operations for both request and response headers.

```yaml
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api
      filters:
        - type: RequestHeaderModifier
          requestHeaderModifier:
            add:
              - name: X-Request-Source
                value: "gateway-prod"
              - name: X-Cluster-Region
                value: "us-east-1"
            set:
              - name: X-Forwarded-Proto
                value: "https"
            remove:
              - X-Debug-Token
              - X-Internal-Trace
        - type: ResponseHeaderModifier
          responseHeaderModifier:
            add:
              - name: X-Content-Type-Options
                value: "nosniff"
              - name: X-Frame-Options
                value: "DENY"
              - name: Strict-Transport-Security
                value: "max-age=31536000; includeSubDomains"
            remove:
              - X-Powered-By
              - Server
      backendRefs:
        - name: api-service
          port: 8080
```

## TLS Termination and Certificate Management

### Certificate Secret Format

Gateway API TLS certificates reference Kubernetes `Secret` objects of type `kubernetes.io/tls`:

```bash
kubectl create secret tls wildcard-tls-cert \
  --cert=wildcard.example.com.crt \
  --key=wildcard.example.com.key \
  --namespace=ingress-system
```

For cert-manager integration, use a `Certificate` resource:

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: wildcard-tls-cert
  namespace: ingress-system
spec:
  secretName: wildcard-tls-cert
  issuerRef:
    name: letsencrypt-production
    kind: ClusterIssuer
  dnsNames:
    - "*.example.com"
    - "example.com"
  usages:
    - digital signature
    - key encipherment
```

### TLS Passthrough

For workloads that require end-to-end TLS (databases, LDAP, custom TLS apps), use `TLSRoute` with passthrough mode:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: tls-passthrough-gateway
  namespace: ingress-system
spec:
  gatewayClassName: envoy-gateway
  listeners:
    - name: tls-passthrough
      protocol: TLS
      port: 5432
      tls:
        mode: Passthrough
      allowedRoutes:
        kinds:
          - kind: TLSRoute
        namespaces:
          from: Selector
          selector:
            matchLabels:
              gateway-access: "true"
---
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: TLSRoute
metadata:
  name: postgres-tls
  namespace: databases
spec:
  parentRefs:
    - name: tls-passthrough-gateway
      namespace: ingress-system
      sectionName: tls-passthrough
  rules:
    - backendRefs:
        - name: postgres-primary
          port: 5432
```

### HTTPS Redirect

Redirecting HTTP to HTTPS uses the `RequestRedirect` filter:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: http-redirect
  namespace: ingress-system
spec:
  parentRefs:
    - name: production-gateway
      namespace: ingress-system
      sectionName: http
  rules:
    - filters:
        - type: RequestRedirect
          requestRedirect:
            scheme: https
            statusCode: 301
```

This catch-all rule on the HTTP listener redirects all HTTP traffic to HTTPS with a permanent redirect.

## GRPCRoute for gRPC Services

The `GRPCRoute` resource was promoted to GA in Gateway API v1.1. It provides gRPC-native routing with method-level granularity.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
metadata:
  name: user-service-grpc
  namespace: user-service
spec:
  parentRefs:
    - name: production-gateway
      namespace: ingress-system
      sectionName: grpc
  hostnames:
    - "grpc.example.com"
  rules:
    - matches:
        - method:
            service: com.example.UserService
            method: GetUser
      backendRefs:
        - name: user-service-v2
          port: 9090
          weight: 80
        - name: user-service-v1
          port: 9090
          weight: 20
    - matches:
        - method:
            service: com.example.UserService
      backendRefs:
        - name: user-service-v1
          port: 9090
    - matches:
        - method:
            service: com.example.AdminService
          headers:
            - name: x-admin-token
              type: RegularExpression
              value: "^admin-[a-z0-9]{32}$"
      backendRefs:
        - name: admin-service
          port: 9090
```

gRPC header matching supports the same types as HTTPRoute: `Exact`, `RegularExpression`, and `Present`. Method matching can be at the service level (matches all methods in the service) or method level (exact method name).

## Cross-Namespace Reference Grants

One of the security innovations in the Gateway API is the `ReferenceGrant` resource. By default, a resource in namespace A cannot reference a resource in namespace B. `ReferenceGrant` makes cross-namespace references explicit and requires the namespace owning the target resource to grant access.

### HTTPRoute Referencing Backend in Another Namespace

The `HTTPRoute` in the `frontend` namespace wants to route to a service in the `backend` namespace:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: frontend-to-backend
  namespace: frontend
spec:
  parentRefs:
    - name: production-gateway
      namespace: ingress-system
      sectionName: https
  hostnames:
    - "app.example.com"
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api
      backendRefs:
        - name: backend-api
          namespace: backend
          port: 8080
```

Without a `ReferenceGrant`, this will fail with a `RefNotPermitted` condition. The `backend` namespace must create a grant:

```yaml
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-frontend-to-backend-svc
  namespace: backend
spec:
  from:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      namespace: frontend
  to:
    - group: ""
      kind: Service
```

This grant says: allow `HTTPRoute` objects from the `frontend` namespace to reference `Service` objects in the `backend` namespace.

### Gateway Referencing TLS Certificates in Another Namespace

Similarly, a Gateway referencing a certificate secret in a centralized secrets namespace requires a grant from that namespace:

```yaml
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-gateway-to-tls-secrets
  namespace: cert-store
spec:
  from:
    - group: gateway.networking.k8s.io
      kind: Gateway
      namespace: ingress-system
  to:
    - group: ""
      kind: Secret
```

## Policy Attachments and Extensibility

Implementations extend the Gateway API by defining custom policy resources that attach to Gateway API objects. The attachment mechanism is standardized even when the policy content is implementation-specific.

### Envoy Gateway BackendTrafficPolicy

Envoy Gateway adds a `BackendTrafficPolicy` resource for circuit breaking and load balancing configuration:

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendTrafficPolicy
metadata:
  name: payments-circuit-breaker
  namespace: payments
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: payments-routes
  circuitBreaker:
    maxConnections: 1000
    maxPendingRequests: 500
    maxParallelRequests: 200
    maxParallelRetries: 10
  loadBalancer:
    type: LeastRequest
  proxyProtocol:
    version: V2
```

### Envoy Gateway SecurityPolicy

TLS client authentication and JWT validation:

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata:
  name: api-jwt-auth
  namespace: api
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: api-routes
  jwt:
    providers:
      - name: auth0
        issuer: "https://tenant.auth0.com/"
        audiences:
          - "api.example.com"
        remoteJWKS:
          uri: "https://tenant.auth0.com/.well-known/jwks.json"
        claimToHeaders:
          - claim: sub
            header: X-User-ID
          - claim: email
            header: X-User-Email
```

### Timeout Policy

A standardized `BackendLBPolicy` (or implementation-specific policy) can attach timeout configuration. Envoy Gateway uses `BackendTrafficPolicy` for timeouts:

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendTrafficPolicy
metadata:
  name: api-timeouts
  namespace: api
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: api-routes
  timeout:
    http:
      requestTimeout: "30s"
      idleTimeout: "300s"
  retry:
    retryOn:
      httpStatusCodes:
        - 502
        - 503
        - 504
    numRetries: 3
    perRetryPolicy:
      timeout: "5s"
      backOff:
        baseInterval: "250ms"
        maxInterval: "5s"
```

## Gateway API Implementations

### Envoy Gateway

Envoy Gateway is the CNCF-maintained reference implementation built on Envoy Proxy. It is the recommended choice for new deployments when Envoy's ecosystem is acceptable.

```bash
helm install eg oci://docker.io/envoyproxy/gateway-helm \
  --version v1.3.0 \
  --namespace envoy-gateway-system \
  --create-namespace
```

Verify installation:

```bash
kubectl get gatewayclass
# NAME            CONTROLLER                                      ACCEPTED   AGE
# envoy-gateway   gateway.envoyproxy.io/gatewayclass-controller   True       2m
```

### Contour

Contour (VMware/Broadcom) uses Envoy as its data plane but presents a simpler operator model. It is a good choice for organizations already using Contour's `HTTPProxy` resources.

```bash
helm install contour bitnami/contour \
  --namespace projectcontour \
  --create-namespace \
  --set gateway.enabled=true
```

### NGINX Gateway Fabric

The F5/NGINX implementation provides a familiar operational model for teams already running NGINX Ingress:

```bash
helm install ngf oci://ghcr.io/nginxinc/charts/nginx-gateway-fabric \
  --namespace nginx-gateway \
  --create-namespace
```

### Istio

Istio has supported the Gateway API since v1.13 and is the recommended way to use Istio's L7 capabilities. It exposes the same `GatewayClass`:

```bash
kubectl get gatewayclass
# NAME    CONTROLLER                    ACCEPTED   AGE
# istio   istio.io/gateway-controller   True       5m
```

Istio respects standard Gateway API semantics while extending it with `AuthorizationPolicy`, `RequestAuthentication`, and `Telemetry` resources attached via `targetRef`.

### Cilium

Cilium's Gateway API implementation uses eBPF at L4 and Envoy at L7:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: cilium
spec:
  controllerName: io.cilium/gateway-controller
```

## Inspecting Gateway API Status

All Gateway API resources report their status through standard conditions. The key conditions to monitor are:

```bash
# Check Gateway acceptance and programmed status
kubectl get gateway production-gateway -n ingress-system -o yaml | \
  yq '.status.conditions'

# Check HTTPRoute parent attachment
kubectl get httproute catalog-routes -n catalog -o yaml | \
  yq '.status.parents'

# Get addresses assigned to the Gateway
kubectl get gateway production-gateway -n ingress-system \
  -o jsonpath='{.status.addresses[*].value}'
```

Key conditions on `Gateway`:

| Condition | Meaning |
|-----------|---------|
| `Accepted` | The GatewayClass controller has accepted this Gateway |
| `Programmed` | The underlying infrastructure (load balancer, proxy) is configured |
| `Ready` (deprecated) | Legacy condition, replaced by `Programmed` |

Key conditions on `HTTPRoute`:

| Condition | Meaning |
|-----------|---------|
| `Accepted` | The route is accepted by the parent Gateway |
| `ResolvedRefs` | All backend Service and Secret references are valid |
| `PartiallyInvalid` | Some rules are invalid but others are programmed |

## Migrating from Ingress to Gateway API

Migration is additive — the Gateway API and Ingress can coexist in the same cluster, even for the same hostnames, as long as they attach to different controllers.

### Step 1: Audit existing Ingress resources

```bash
kubectl get ingress --all-namespaces -o json | \
  jq -r '.items[] | [.metadata.namespace, .metadata.name,
    (.metadata.annotations | keys[] | select(startswith("nginx.ingress.kubernetes.io")))] |
    @csv' | sort
```

Categorize annotations by their Gateway API equivalent:

| NGINX Annotation | Gateway API Equivalent |
|-----------------|----------------------|
| `nginx.ingress.kubernetes.io/rewrite-target` | `URLRewrite` filter |
| `nginx.ingress.kubernetes.io/canary-weight` | Weighted `backendRefs` |
| `nginx.ingress.kubernetes.io/proxy-read-timeout` | `BackendTrafficPolicy` timeout |
| `nginx.ingress.kubernetes.io/ssl-redirect` | `RequestRedirect` filter |
| `nginx.ingress.kubernetes.io/auth-url` | `SecurityPolicy` |
| `nginx.ingress.kubernetes.io/configuration-snippet` | Implementation policy attachment |

### Step 2: Deploy Gateway API infrastructure

Install the Gateway API CRDs before deploying an implementation:

```bash
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.3.0/standard-install.yaml

# For experimental features (GRPCRoute, TCPRoute, TLSRoute):
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.3.0/experimental-install.yaml
```

### Step 3: Create GatewayClass and Gateway

Create the infrastructure resources before migrating routes. The Gateway should listen on the same ports as the existing Ingress controller.

### Step 4: Migrate routes namespace by namespace

Start with low-criticality namespaces. Run the old Ingress and new HTTPRoute in parallel — they will both serve traffic if both controllers are active.

```yaml
# Old ingress (keep running)
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: catalog-ingress
  namespace: catalog
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /$2
spec:
  rules:
    - host: catalog.example.com
      http:
        paths:
          - path: /api(/|$)(.*)
            pathType: Prefix
            backend:
              service:
                name: catalog-api
                port:
                  number: 8080
---
# New HTTPRoute (add alongside)
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: catalog-routes
  namespace: catalog
spec:
  parentRefs:
    - name: production-gateway
      namespace: ingress-system
      sectionName: https
  hostnames:
    - "catalog.example.com"
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
        - name: catalog-api
          port: 8080
```

### Step 5: Update DNS and validate

Once the HTTPRoute is validated, update the DNS record for the hostname from the Ingress controller's IP/hostname to the Gateway's address. Monitor error rates during the transition window before deleting the old Ingress resource.

### Step 6: Remove Ingress resources

After validation, remove the old Ingress resources:

```bash
kubectl delete ingress catalog-ingress -n catalog
```

## Production Operational Considerations

### Multi-tenant Gateway isolation

For strict multi-tenant clusters, deploy separate `Gateway` instances per tenant in tenant-owned namespaces rather than sharing a single Gateway. This provides hard isolation at the infrastructure level:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: tenant-a-gateway
  namespace: tenant-a
spec:
  gatewayClassName: envoy-gateway
  listeners:
    - name: https
      protocol: HTTPS
      port: 443
      tls:
        mode: Terminate
        certificateRefs:
          - name: tenant-a-cert
      allowedRoutes:
        namespaces:
          from: Same
```

### Gateway resource scaling

For high-traffic deployments, configure the implementation's scaling parameters. For Envoy Gateway:

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: default-proxy-config
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
          resources:
            requests:
              cpu: "1"
              memory: "512Mi"
            limits:
              cpu: "2"
              memory: "1Gi"
        container:
          env:
            - name: GOMAXPROCS
              value: "2"
```

### Monitoring Gateway API resources

Configure Prometheus alerts for unhealthy Gateway conditions:

```yaml
groups:
  - name: gateway-api
    rules:
      - alert: GatewayNotProgrammed
        expr: |
          kube_gateway_status_condition{condition="Programmed", status="true"} == 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Gateway {{ $labels.name }} in {{ $labels.namespace }} is not programmed"
          description: "The Gateway has not been successfully programmed for more than 5 minutes. Check the controller logs."

      - alert: HTTPRouteRefNotPermitted
        expr: |
          kube_httproute_status_condition{condition="ResolvedRefs", status="true"} == 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "HTTPRoute {{ $labels.name }} has unresolved references"
          description: "Check for missing ReferenceGrants or invalid Service names."

      - alert: HTTPRouteNotAccepted
        expr: |
          kube_httproute_status_condition{condition="Accepted", status="true"} == 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "HTTPRoute {{ $labels.name }} is not accepted by its parent"
          description: "Verify parentRefs, sectionName, and namespace allowedRoutes configuration."
```

### Request mirroring for dark launches

The `RequestMirror` filter sends a copy of requests to a mirror backend without affecting the primary response. This is useful for testing new services under production load:

```yaml
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /checkout
      filters:
        - type: RequestMirror
          requestMirror:
            backendRef:
              name: checkout-v2-shadow
              port: 8080
              percent: 100
      backendRefs:
        - name: checkout-v1
          port: 8080
```

The mirror backend receives identical requests but its responses are discarded. This allows load testing and behavior comparison without risking production traffic.

## Troubleshooting Gateway API

### Route not receiving traffic

Check the route status conditions first:

```bash
kubectl describe httproute <route-name> -n <namespace>
```

Common failure modes and their causes:

**`Accepted: False` with reason `NotAllowedByParent`**: The namespace label does not match the Gateway's `allowedRoutes` selector, or the `parentRefs` namespace/name is wrong.

**`ResolvedRefs: False` with reason `BackendNotFound`**: The referenced Service does not exist or the port number is wrong. Check if a `ReferenceGrant` is needed for cross-namespace references.

**`ResolvedRefs: False` with reason `RefNotPermitted`**: A `ReferenceGrant` is required but missing. Create the grant in the target namespace.

**Traffic routing to wrong backend**: Check rule ordering. Rules are evaluated top-to-bottom and the first match wins. More specific rules (exact path, header match) should precede less specific rules (prefix match).

### Gateway not getting an address

```bash
kubectl get gateway production-gateway -n ingress-system
# NAME                  CLASS           ADDRESS   PROGRAMMED   AGE
# production-gateway    envoy-gateway             False        5m
```

If `ADDRESS` is empty and `PROGRAMMED` is False, check the controller pods:

```bash
kubectl logs -n envoy-gateway-system \
  -l app.kubernetes.io/name=gateway-helm \
  --tail=100
```

Common causes: the `GatewayClass` controller name does not match any running controller; the controller lacks RBAC permissions; cloud load balancer quota exhausted.

### Checking implemented routes on the proxy

For Envoy Gateway, inspect the Envoy admin interface to verify route configuration:

```bash
# Port-forward to the Envoy admin port
kubectl port-forward -n envoy-gateway-system \
  $(kubectl get pod -n envoy-gateway-system -l app=envoy -o jsonpath='{.items[0].metadata.name}') \
  19000:19000

# Check route configuration
curl -s http://localhost:19000/config_dump | \
  jq '.configs[] | select(.["@type"] | contains("RouteConfiguration"))'
```

## Summary

The Kubernetes Gateway API delivers on the promise of expressive, role-oriented, implementation-portable routing. The core resource model — `GatewayClass`, `Gateway`, `HTTPRoute`, `GRPCRoute` — maps directly to how organizations structure responsibility between infrastructure teams and application teams. Features that previously required controller-specific annotations (traffic splitting, URL rewriting, header manipulation, TLS management) are now first-class API constructs. `ReferenceGrant` provides explicit cross-namespace trust without requiring permissive RBAC. The extensibility model through policy attachments maintains the core API's portability while allowing implementations to expose their unique capabilities.

Production adoption should follow a gradual migration path: audit existing annotations, deploy Gateway API infrastructure alongside existing controllers, migrate routes namespace by namespace with parallel validation, and remove legacy Ingress resources only after confirming correctness.
