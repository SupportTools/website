---
title: "Kubernetes Gateway API: Migrating from Ingress to the New Standard"
date: 2028-12-10T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Gateway API", "Ingress", "Networking", "Service Mesh", "Enterprise"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to migrating from Kubernetes Ingress to the Gateway API, covering HTTPRoute, TLSRoute, GRPCRoute, multi-tenancy patterns, and production migration strategies."
more_link: "yes"
url: "/kubernetes-gateway-api-ingress-migration-enterprise-guide/"
---

The Kubernetes Gateway API represents the most significant evolution in Kubernetes networking since the original Ingress resource was introduced in 2015. While Ingress served well for simple HTTP routing, its limitations became apparent as organizations deployed increasingly complex microservices architectures. The Gateway API addresses these limitations through a role-oriented, expressive, and extensible design that separates infrastructure concerns from application routing logic.

This guide covers the complete migration path from Ingress to Gateway API in enterprise environments, including multi-tenancy patterns, advanced traffic management, TLS configuration, observability integration, and production cutover strategies with zero downtime.

<!--more-->

## Why the Gateway API Replaces Ingress

The Kubernetes Ingress resource, despite widespread adoption, has fundamental architectural limitations that drove the design of the Gateway API:

**Annotation sprawl**: Every ingress controller vendor invented proprietary annotations for features beyond basic routing. `nginx.ingress.kubernetes.io/proxy-body-size`, `haproxy.org/balance-algorithm`, and `traefik.ingress.kubernetes.io/router.middlewares` are all doing the same class of work with incompatible syntax. This makes configurations non-portable and tightly coupled to a specific implementation.

**Single-actor model**: The Ingress resource assumes one team controls both the infrastructure (load balancer, TLS certificates) and the application routing rules. In enterprise environments, these responsibilities belong to different teams with different permission boundaries.

**Limited expressiveness**: Ingress supports only HTTP/HTTPS with basic path and host matching. GRPC, TCP, UDP, and weighted routing required either CRDs or complex annotations.

The Gateway API introduces a layered model:

- `GatewayClass`: Defined by infrastructure providers, describes a class of gateways
- `Gateway`: Managed by infrastructure teams, describes listener configuration
- `HTTPRoute`, `GRPCRoute`, `TLSRoute`, `TCPRoute`: Managed by application teams, describe routing rules

### API Stability Status

As of Gateway API v1.2, the following resources are stable (GA):

| Resource | API Version | Status |
|----------|-------------|--------|
| GatewayClass | gateway.networking.k8s.io/v1 | GA |
| Gateway | gateway.networking.k8s.io/v1 | GA |
| HTTPRoute | gateway.networking.k8s.io/v1 | GA |
| GRPCRoute | gateway.networking.k8s.io/v1 | GA |
| ReferenceGrant | gateway.networking.k8s.io/v1beta1 | Beta |
| TLSRoute | gateway.networking.k8s.io/v1alpha2 | Alpha |
| TCPRoute | gateway.networking.k8s.io/v1alpha2 | Alpha |

## Installing the Gateway API CRDs

Before any Gateway API objects can be created, the CRDs must be installed. These are separate from any specific controller implementation:

```bash
# Install the standard channel CRDs (GA + Beta resources)
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/standard-install.yaml

# Install the experimental channel (includes Alpha resources like TLSRoute, TCPRoute)
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/experimental-install.yaml

# Verify CRD installation
kubectl get crd | grep gateway.networking.k8s.io
```

Expected output:
```
gatewayclasses.gateway.networking.k8s.io     2028-11-01T00:00:00Z
gateways.gateway.networking.k8s.io           2028-11-01T00:00:00Z
grpcroutes.gateway.networking.k8s.io         2028-11-01T00:00:00Z
httproutes.gateway.networking.k8s.io         2028-11-01T00:00:00Z
referencegrants.gateway.networking.k8s.io    2028-11-01T00:00:00Z
tcproutes.gateway.networking.k8s.io          2028-11-01T00:00:00Z
tlsroutes.gateway.networking.k8s.io          2028-11-01T00:00:00Z
```

## Choosing a Gateway Implementation

Multiple controllers implement the Gateway API. Selection depends on existing infrastructure and requirements:

| Controller | Backing Technology | Multi-tenancy | mTLS | WASM Plugins |
|------------|-------------------|---------------|------|--------------|
| Envoy Gateway | Envoy Proxy | Yes | Yes | Yes |
| Istio | Envoy Proxy | Yes | Yes | Yes |
| Cilium | eBPF + Envoy | Yes | Yes | Limited |
| Kong Gateway | Kong/Nginx | Yes | Yes | Yes |
| nginx-gateway-fabric | NGINX | Limited | No | No |
| Traefik | Traefik | Limited | No | No |

For this guide, Envoy Gateway (the CNCF project backed by the Gateway API SIG) is used as the reference implementation.

### Installing Envoy Gateway

```bash
# Add the Envoy Gateway Helm repository
helm repo add eg https://charts.gateway.envoyproxy.io
helm repo update

# Install Envoy Gateway into the envoy-gateway-system namespace
helm install eg eg/gateway-helm \
  --namespace envoy-gateway-system \
  --create-namespace \
  --version v1.2.0 \
  --set config.envoyGateway.logging.level.default=info

# Verify the controller is running
kubectl get pods -n envoy-gateway-system
```

## GatewayClass Configuration

A `GatewayClass` is a cluster-scoped resource that defines a template for `Gateway` instances. Infrastructure teams create and manage `GatewayClass` resources:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: envoy-external
  annotations:
    # Document who manages this class
    gateway.networking.k8s.io/managed-by: "platform-team"
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
  description: "External-facing load balancer with WAF and DDoS protection"
  parametersRef:
    group: gateway.envoyproxy.io
    kind: EnvoyProxy
    name: external-proxy-config
    namespace: envoy-gateway-system
---
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: external-proxy-config
  namespace: envoy-gateway-system
spec:
  provider:
    type: Kubernetes
    kubernetes:
      envoyService:
        type: LoadBalancer
        annotations:
          service.beta.kubernetes.io/aws-load-balancer-type: external
          service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: ip
          service.beta.kubernetes.io/aws-load-balancer-scheme: internet-facing
  telemetry:
    accessLog:
      settings:
      - format:
          type: JSON
        sinks:
        - type: File
          file:
            path: /dev/stdout
```

## Creating a Gateway

The `Gateway` resource is managed by the infrastructure team and defines listener ports, protocols, and TLS configuration. Application teams are granted permission to attach routes to specific gateways:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: production-external
  namespace: gateway-infra
  annotations:
    # Tracks the last change for audit purposes
    gateway.support.tools/last-modified-by: "platform-team"
    gateway.support.tools/ticket: "INFRA-4421"
spec:
  gatewayClassName: envoy-external
  listeners:
  - name: http
    protocol: HTTP
    port: 80
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchLabels:
            gateway.support.tools/allowed: "external"
  - name: https
    protocol: HTTPS
    port: 443
    tls:
      mode: Terminate
      certificateRefs:
      - kind: Secret
        name: wildcard-tls-cert
        namespace: gateway-infra
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchLabels:
            gateway.support.tools/allowed: "external"
```

The `allowedRoutes` field is critical for multi-tenancy. It restricts which namespaces can attach `HTTPRoute` resources to this gateway. Any application namespace that needs to expose services externally must carry the `gateway.support.tools/allowed: "external"` label.

### Labeling Application Namespaces

```bash
# Label the namespace to permit external route attachment
kubectl label namespace payments gateway.support.tools/allowed=external

# Verify the label
kubectl get namespace payments --show-labels
```

## HTTPRoute: The Core Routing Resource

The `HTTPRoute` replaces the Ingress resource for HTTP and HTTPS traffic. Application teams create `HTTPRoute` resources in their own namespaces:

### Basic HTTPRoute

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: payments-api
  namespace: payments
spec:
  parentRefs:
  - name: production-external
    namespace: gateway-infra
    sectionName: https
  hostnames:
  - "payments.example.com"
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /api/v1/
    filters:
    - type: RequestHeaderModifier
      requestHeaderModifier:
        add:
        - name: X-Forwarded-Service
          value: "payments-api"
        remove:
        - name: X-Internal-Debug
    backendRefs:
    - name: payments-api-service
      port: 8080
      weight: 100
  - matches:
    - path:
        type: Exact
        value: /health
    backendRefs:
    - name: payments-health-service
      port: 8081
```

### Traffic Splitting for Canary Deployments

The Gateway API natively supports weighted routing without annotations:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: checkout-canary
  namespace: checkout
spec:
  parentRefs:
  - name: production-external
    namespace: gateway-infra
    sectionName: https
  hostnames:
  - "checkout.example.com"
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /
    backendRefs:
    - name: checkout-stable
      port: 8080
      weight: 90
    - name: checkout-canary
      port: 8080
      weight: 10
```

This splits 10% of traffic to the canary deployment. The weight values are relative — they do not need to sum to 100, though doing so makes intent explicit.

### Header-Based Routing for A/B Testing

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: frontend-ab-test
  namespace: frontend
spec:
  parentRefs:
  - name: production-external
    namespace: gateway-infra
    sectionName: https
  hostnames:
  - "www.example.com"
  rules:
  # Route users with the beta header to the new version
  - matches:
    - path:
        type: PathPrefix
        value: /
      headers:
      - name: X-Beta-User
        value: "true"
    backendRefs:
    - name: frontend-v2
      port: 3000
  # Default: send to stable version
  - matches:
    - path:
        type: PathPrefix
        value: /
    backendRefs:
    - name: frontend-v1
      port: 3000
```

### URL Rewriting

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: legacy-api-rewrite
  namespace: legacy
spec:
  parentRefs:
  - name: production-external
    namespace: gateway-infra
    sectionName: https
  hostnames:
  - "api.example.com"
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /v1/users
    filters:
    - type: URLRewrite
      urlRewrite:
        path:
          type: ReplacePrefixMatch
          replacePrefixMatch: /api/users
    backendRefs:
    - name: users-service
      port: 8080
```

## GRPCRoute: Native gRPC Routing

The `GRPCRoute` resource provides first-class support for gRPC traffic, eliminating the need for Ingress annotations that attempted to handle gRPC over HTTP/2:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
metadata:
  name: order-service-grpc
  namespace: orders
spec:
  parentRefs:
  - name: production-external
    namespace: gateway-infra
    sectionName: https
  hostnames:
  - "grpc.example.com"
  rules:
  - matches:
    - method:
        service: orders.OrderService
        method: CreateOrder
    backendRefs:
    - name: orders-grpc-service
      port: 9090
  - matches:
    - method:
        service: orders.OrderService
    backendRefs:
    - name: orders-grpc-service
      port: 9090
```

## Cross-Namespace Route References with ReferenceGrant

By default, routes can only reference backends in the same namespace. The `ReferenceGrant` resource enables controlled cross-namespace backend references, critical for shared service architectures:

```yaml
# In the "shared-services" namespace, allow the "payments" namespace
# to reference backends here
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-payments-to-shared
  namespace: shared-services
spec:
  from:
  - group: gateway.networking.k8s.io
    kind: HTTPRoute
    namespace: payments
  to:
  - group: ""
    kind: Service
```

With this `ReferenceGrant` in place, an `HTTPRoute` in the `payments` namespace can route traffic to a `Service` in the `shared-services` namespace:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: payments-to-shared-auth
  namespace: payments
spec:
  parentRefs:
  - name: production-external
    namespace: gateway-infra
    sectionName: https
  hostnames:
  - "payments.example.com"
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /auth
    backendRefs:
    - name: auth-service
      namespace: shared-services  # Cross-namespace reference
      port: 8080
```

## Migrating from NGINX Ingress: A Practical Translation Guide

### Simple Host-Based Routing

**Before (Ingress):**
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-ingress
  namespace: api
  annotations:
    kubernetes.io/ingress.class: nginx
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "60"
spec:
  tls:
  - hosts:
    - api.example.com
    secretName: api-tls
  rules:
  - host: api.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: api-service
            port:
              number: 8080
```

**After (HTTPRoute + Gateway):**
```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-route
  namespace: api
spec:
  parentRefs:
  - name: production-external
    namespace: gateway-infra
    sectionName: https
  hostnames:
  - "api.example.com"
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /
    filters:
    # The proxy-body-size and timeout settings are handled via
    # BackendLBPolicy or HTTPRouteFilter extensions in Envoy Gateway
    - type: RequestHeaderModifier
      requestHeaderModifier:
        add:
        - name: X-Max-Body-Size
          value: "10485760"
    backendRefs:
    - name: api-service
      port: 8080
```

Note that implementation-specific features like `proxy-body-size` and `proxy-read-timeout` require vendor extension resources. In Envoy Gateway, these are configured via `BackendTrafficPolicy`:

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendTrafficPolicy
metadata:
  name: api-backend-policy
  namespace: api
spec:
  targetRefs:
  - group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: api-route
  timeout:
    http:
      responseTimeout: 60s
  connection:
    bufferLimit: "10Mi"
```

## HTTP-to-HTTPS Redirect

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: http-to-https-redirect
  namespace: gateway-infra
spec:
  parentRefs:
  - name: production-external
    namespace: gateway-infra
    sectionName: http
  rules:
  - filters:
    - type: RequestRedirect
      requestRedirect:
        scheme: https
        statusCode: 301
```

This route attaches to the HTTP (port 80) listener and returns a 301 redirect to HTTPS for all requests. Unlike Ingress implementations where this required controller-specific annotations, the Gateway API makes it a first-class, portable operation.

## Multi-Tenancy Patterns

### Namespace-per-Team with Shared Gateway

The recommended enterprise pattern separates infrastructure teams (who manage `Gateway` resources) from application teams (who manage `HTTPRoute` resources):

```
├── gateway-infra/            (managed by platform team)
│   ├── GatewayClass: envoy-external
│   ├── Gateway: production-external
│   └── Secrets: wildcard TLS certificates
├── payments/                 (managed by payments team)
│   └── HTTPRoute: payments-api
├── orders/                   (managed by orders team)
│   └── HTTPRoute: orders-api
└── frontend/                 (managed by frontend team)
    └── HTTPRoute: www-frontend
```

RBAC configuration to enforce this separation:

```yaml
# Allow the payments team to manage HTTPRoutes in their namespace
# but not Gateway or GatewayClass resources
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: route-manager
  namespace: payments
rules:
- apiGroups: ["gateway.networking.k8s.io"]
  resources: ["httproutes", "grpcroutes"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: ["gateway.networking.k8s.io"]
  resources: ["gateways", "gatewayclasses"]
  verbs: ["get", "list", "watch"]  # read-only
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: payments-team-routes
  namespace: payments
subjects:
- kind: Group
  name: payments-engineers
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: route-manager
  apiGroup: rbac.authorization.k8s.io
```

## Observability and Status Conditions

The Gateway API provides rich status conditions on all resources. Monitoring these conditions is essential for production operations:

```bash
# Check Gateway status
kubectl get gateway production-external -n gateway-infra -o yaml | \
  yq '.status.conditions[]'

# Check HTTPRoute attachment status
kubectl get httproute payments-api -n payments -o yaml | \
  yq '.status.parents[].conditions[]'
```

A healthy HTTPRoute shows:

```yaml
conditions:
- lastTransitionTime: "2028-12-10T10:00:00Z"
  message: Route is accepted
  observedGeneration: 3
  reason: Accepted
  status: "True"
  type: Accepted
- lastTransitionTime: "2028-12-10T10:00:00Z"
  message: Resolved all the Object references for the Route
  observedGeneration: 3
  reason: ResolvedRefs
  status: "True"
  type: ResolvedRefs
```

### Prometheus Metrics

Envoy Gateway exposes Prometheus metrics that can be scraped with a `ServiceMonitor`:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: envoy-gateway-metrics
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: envoy-gateway
  namespaceSelector:
    matchNames:
    - envoy-gateway-system
  endpoints:
  - port: metrics
    interval: 30s
    path: /metrics
```

Key metrics to alert on:
- `envoy_cluster_upstream_rq_xx{response_code_class="5"}` — 5xx error rate
- `envoy_cluster_upstream_rq_time_bucket` — upstream response latency
- `gateway_api_httproute_reconcile_total` — route reconciliation errors

## Production Migration Strategy

### Phase 1: Parallel Operation

Run both Ingress and Gateway API controllers simultaneously. Configure the same routes on both systems and use DNS weighted routing to shift a small percentage of traffic to the Gateway API backend:

```bash
# Deploy Gateway API controller alongside existing nginx-ingress
# Both controllers watch different IngressClass values

# Add HTTPRoute for a single low-risk service
kubectl apply -f httproute-static-assets.yaml

# Update DNS to send 5% of traffic to the Gateway API load balancer
# (using Route53 weighted routing or equivalent)
```

### Phase 2: Validation at Scale

```bash
# Compare error rates between old Ingress and new Gateway
kubectl exec -n monitoring -it prometheus-0 -- \
  promtool query instant \
  'sum(rate(nginx_ingress_controller_requests{status=~"5.."}[5m])) / sum(rate(nginx_ingress_controller_requests[5m]))'

# vs Gateway API equivalent
kubectl exec -n monitoring -it prometheus-0 -- \
  promtool query instant \
  'sum(rate(envoy_cluster_upstream_rq_xx{response_code_class="5"}[5m])) / sum(rate(envoy_cluster_upstream_rq_total[5m]))'
```

### Phase 3: Full Cutover

Once validation passes, shift 100% of DNS to the Gateway API load balancer endpoints and remove the legacy Ingress resources:

```bash
# Remove all Ingress resources after cutover is validated
kubectl get ingress --all-namespaces -o json | \
  jq -r '.items[] | .metadata.namespace + "/" + .metadata.name' | \
  while IFS='/' read ns name; do
    echo "Deleting Ingress $name in namespace $ns"
    kubectl delete ingress "$name" -n "$ns"
  done

# Uninstall the nginx-ingress controller
helm uninstall nginx-ingress -n ingress-nginx
```

## Troubleshooting Common Issues

### Route Not Attaching to Gateway

```bash
# Check the parentRef is pointing to the correct gateway and namespace
kubectl describe httproute payments-api -n payments

# Look for "Accepted: False" conditions
kubectl get httproute payments-api -n payments \
  -o jsonpath='{.status.parents[].conditions[?(@.type=="Accepted")].message}'
```

Common causes:
1. The application namespace does not have the required label for `allowedRoutes`
2. The `sectionName` in `parentRef` does not match any listener name in the Gateway
3. The Gateway is in a different namespace but `parentRef.namespace` was omitted

### Backend Service Not Found

```bash
# Verify the Service exists and has endpoints
kubectl get service payments-api-service -n payments
kubectl get endpoints payments-api-service -n payments

# For cross-namespace references, verify the ReferenceGrant exists
kubectl get referencegrant -n shared-services
```

### TLS Certificate Issues

```bash
# Check the certificate secret exists in the Gateway's namespace
kubectl get secret wildcard-tls-cert -n gateway-infra

# Verify certificate validity
kubectl get secret wildcard-tls-cert -n gateway-infra \
  -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -text -noout | \
  grep -E "Subject:|Not After"
```

## Summary

The Kubernetes Gateway API provides a portable, expressive, and role-oriented replacement for Ingress. Key advantages for enterprise deployments include:

- **Separation of concerns**: Infrastructure teams manage `Gateway` resources while application teams manage `HTTPRoute` resources
- **Native traffic management**: Weighted routing, redirects, and header manipulation without annotations
- **Multi-protocol support**: HTTP, HTTPS, gRPC, TLS, and TCP routing in a unified API
- **Portable configuration**: Route definitions work across any Gateway API-compliant controller
- **Rich status reporting**: Structured conditions on all resources simplify troubleshooting

The migration from Ingress to Gateway API should be approached incrementally: install the CRDs and a Gateway API controller, begin creating `HTTPRoute` resources for low-risk services, validate behavior with production traffic shadowing, then execute a full cutover with a clear rollback path.

## Additional Resources

- [Gateway API Official Documentation](https://gateway-api.sigs.k8s.io/)
- [Envoy Gateway Documentation](https://gateway.envoyproxy.io/docs/)
- [Gateway API Conformance Tests](https://gateway-api.sigs.k8s.io/concepts/conformance/)
- [GEP (Gateway Enhancement Proposals)](https://github.com/kubernetes-sigs/gateway-api/tree/main/geps)
