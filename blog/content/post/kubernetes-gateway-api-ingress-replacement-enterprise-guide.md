---
title: "Kubernetes Gateway API: The Future of Traffic Management"
date: 2026-12-30T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Gateway API", "Networking", "Ingress", "Traffic Management"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to the Kubernetes Gateway API covering GatewayClass, Gateway, HTTPRoute, and TCPRoute resources with Envoy Gateway and Nginx Gateway Fabric implementations."
more_link: "yes"
url: "/kubernetes-gateway-api-ingress-replacement-enterprise-guide/"
---

The Kubernetes `Ingress` resource has served as the entry point for HTTP traffic since the early days of the ecosystem, but it was always a compromise. The specification exposed only the most basic routing primitives — host-based and path-based routing — leaving implementation-specific behavior to a proliferation of annotations that became the de facto configuration language. `nginx.ingress.kubernetes.io/rewrite-target`, `traefik.ingress.kubernetes.io/router.entrypoints`, `alb.ingress.kubernetes.io/scheme`: each annotation is controller-specific, non-portable, and undiscoverable through the Kubernetes API machinery.

The **Kubernetes Gateway API** is the official successor to `Ingress`. It graduated to GA in Kubernetes 1.31 and provides a structured, role-oriented API for HTTP, HTTPS, TCP, UDP, and gRPC routing. The design separates infrastructure concerns (which load balancer, which certificate authority) from application concerns (which routes, which backends), enabling platform teams and application developers to own their respective configuration domains without stepping on each other.

This guide covers the Gateway API resource model in depth, demonstrates production configurations with Envoy Gateway, walks through TLS termination, TCP/UDP routing, cross-namespace access control with `ReferenceGrant`, and provides a migration path from existing `Ingress` deployments.

<!--more-->

## Why Gateway API Replaces Ingress

### The Annotation Problem

The `Ingress` resource has a single standard field for routing: `spec.rules` with host and path matching. Everything else — timeouts, retries, rate limiting, authentication, traffic splitting — is expressed through annotations. A production Nginx Ingress object commonly carries 15 to 25 annotations that are tightly coupled to one controller implementation.

When an organization evaluates migrating from Nginx Ingress to another controller — say, for performance, cost, or feature reasons — the annotation vocabulary changes entirely. Migrating 200 `Ingress` objects requires rewriting all annotations, often without equivalent functionality in the target controller.

### The Role Separation Problem

The `Ingress` resource flattens infrastructure and application configuration into a single resource. Platform engineers controlling TLS certificate management, load balancer provisioning, and network policies share the same object with application developers who only need to define their route rules. This creates either excessive RBAC scope for developers or excessive toil for platform engineers who must own all `Ingress` objects.

### Gateway API Design Principles

The Gateway API decomposes the problem into four distinct resource types with explicit ownership:

| Resource | Owner | Scope |
|---|---|---|
| `GatewayClass` | Infrastructure provider | Cluster |
| `Gateway` | Platform engineer | Cluster or namespace |
| `HTTPRoute` / `TCPRoute` / `GRPCRoute` | Application developer | Namespace |
| `ReferenceGrant` | Namespace owner | Namespace |

This separation is enforced through Kubernetes RBAC. Application developers can create and modify `HTTPRoute` objects in their namespace without cluster-scoped permissions, and they cannot modify the `Gateway` that accepts their routes.

## API Model: GatewayClass, Gateway, and Route Resources

### GatewayClass

`GatewayClass` is the template for a class of Gateways. It identifies the controller responsible for provisioning Gateway infrastructure and carries default configuration parameters through `parametersRef`:

```yaml
# gatewayclass-envoy.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: envoy-gateway
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
  parametersRef:
    group: gateway.envoyproxy.io
    kind: EnvoyProxy
    name: production-proxy-config
    namespace: gateway-system
```

### Gateway

`Gateway` represents a specific instantiation of a load balancer. The `listeners` field defines ports, protocols, and TLS configuration. The `allowedRoutes` field controls which namespaces can attach routes to each listener:

```yaml
# gateway-production.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: production-gateway
  namespace: gateway-system
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
            gateway-access: production
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
            gateway-access: production
  - name: postgres
    protocol: TCP
    port: 5432
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchLabels:
            gateway-access: database
  - name: grpc
    protocol: HTTP2
    port: 9090
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
            gateway-access: production
```

Namespaces that should be able to attach routes need the label:

```bash
kubectl label namespace production gateway-access=production
kubectl label namespace database gateway-access=database
```

### HTTPRoute

`HTTPRoute` defines HTTP routing rules. A single `HTTPRoute` can match multiple hosts and define complex routing logic within a single object:

```yaml
# httproute-api.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-route
  namespace: production
spec:
  parentRefs:
  - name: production-gateway
    namespace: gateway-system
  hostnames:
  - api.example.com
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /api/v2
      headers:
      - name: x-api-version
        value: v2
    filters:
    - type: URLRewrite
      urlRewrite:
        path:
          type: ReplacePrefixMatch
          replacePrefixMatch: /api
    backendRefs:
    - name: api-v2-service
      port: 80
      weight: 100
  - matches:
    - path:
        type: PathPrefix
        value: /api
    backendRefs:
    - name: api-v1-service
      port: 80
      weight: 90
    - name: api-v2-service
      port: 80
      weight: 10
```

### TCPRoute

`TCPRoute` provides layer-4 routing for non-HTTP TCP protocols. This enables the same Gateway infrastructure to serve databases, message brokers, or custom protocols:

```yaml
# tcproute-postgres.yaml
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: TCPRoute
metadata:
  name: postgres-route
  namespace: database
spec:
  parentRefs:
  - name: production-gateway
    namespace: gateway-system
    sectionName: postgres
  rules:
  - backendRefs:
    - name: postgres-primary
      port: 5432
```

### GRPCRoute

`GRPCRoute` provides method-level routing for gRPC services, enabling fine-grained traffic control that HTTP path matching cannot express:

```yaml
# grpcroute-orders.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
metadata:
  name: order-grpc-route
  namespace: production
spec:
  parentRefs:
  - name: production-gateway
    namespace: gateway-system
    sectionName: grpc
  hostnames:
  - grpc.example.com
  rules:
  - matches:
    - method:
        service: orders.v1.OrderService
        method: CreateOrder
    filters:
    - type: RequestHeaderModifier
      requestHeaderModifier:
        add:
        - name: x-request-source
          value: gateway
    backendRefs:
    - name: order-service
      port: 9090
```

## Installing Envoy Gateway

**Envoy Gateway** is a CNCF project that provides an implementation of the Kubernetes Gateway API backed by Envoy Proxy. It is the recommended implementation for production environments that require advanced traffic management.

### Installation

```bash
helm repo add envoy-gateway https://charts.envoyproxy.io
helm repo update

helm upgrade --install envoy-gateway envoy-gateway/gateway-helm \
  --namespace envoy-gateway-system \
  --create-namespace \
  --version 1.1.0

kubectl -n envoy-gateway-system wait --for=condition=available \
  deployment/envoy-gateway --timeout=120s

kubectl get gatewayclass
```

### EnvoyProxy Configuration

`EnvoyProxy` allows customization of the Envoy proxy instances that Envoy Gateway provisions for each `Gateway`:

```yaml
# envoy-proxy-config.yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: production-proxy-config
  namespace: gateway-system
spec:
  provider:
    type: Kubernetes
    kubernetes:
      envoyDeployment:
        replicas: 3
        pod:
          annotations:
            prometheus.io/scrape: "true"
            prometheus.io/port: "19001"
          affinity:
            podAntiAffinity:
              requiredDuringSchedulingIgnoredDuringExecution:
              - labelSelector:
                  matchLabels:
                    gateway.envoyproxy.io/owning-gateway-name: production-gateway
                topologyKey: kubernetes.io/hostname
        container:
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 2Gi
      envoyService:
        type: LoadBalancer
        annotations:
          service.beta.kubernetes.io/aws-load-balancer-type: nlb
          service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "true"
  telemetry:
    accessLog:
      settings:
      - format:
          type: JSON
        sinks:
        - type: File
          file:
            path: /dev/stdout
    metrics:
      prometheus: {}
```

## HTTPRoute with Advanced Routing Patterns

### Header-Based Routing

Route traffic based on request headers for A/B testing or API versioning:

```yaml
# httproute-header-routing.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: checkout-route
  namespace: production
spec:
  parentRefs:
  - name: production-gateway
    namespace: gateway-system
  hostnames:
  - checkout.example.com
  rules:
  - matches:
    - headers:
      - name: x-beta-user
        value: "true"
    backendRefs:
    - name: checkout-v2-service
      port: 80
  - matches:
    - path:
        type: PathPrefix
        value: /
    backendRefs:
    - name: checkout-v1-service
      port: 80
```

### Path Rewriting

Path rewrites transform the request URL before forwarding to backends. This enables clean external URLs while preserving legacy internal API paths:

```yaml
# httproute-path-rewrite.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: legacy-api-route
  namespace: production
spec:
  parentRefs:
  - name: production-gateway
    namespace: gateway-system
  hostnames:
  - api.example.com
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /v3/users
    filters:
    - type: URLRewrite
      urlRewrite:
        path:
          type: ReplacePrefixMatch
          replacePrefixMatch: /api/v1/users
    backendRefs:
    - name: user-service
      port: 80
  - matches:
    - path:
        type: PathPrefix
        value: /v3/orders
    filters:
    - type: URLRewrite
      urlRewrite:
        hostname: orders-internal.production.svc.cluster.local
        path:
          type: ReplacePrefixMatch
          replacePrefixMatch: /orders
    backendRefs:
    - name: order-service
      port: 80
```

### Traffic Splitting for Canary Deployments

`HTTPRoute` backend weights enable canary traffic splitting without an additional controller:

```yaml
# httproute-canary.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: frontend-canary-route
  namespace: production
spec:
  parentRefs:
  - name: production-gateway
    namespace: gateway-system
  hostnames:
  - www.example.com
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /
    backendRefs:
    - name: frontend-stable
      port: 80
      weight: 95
    - name: frontend-canary
      port: 80
      weight: 5
```

### Request and Response Header Modification

```yaml
# httproute-headers.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-with-headers
  namespace: production
spec:
  parentRefs:
  - name: production-gateway
    namespace: gateway-system
  hostnames:
  - api.example.com
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /api
    filters:
    - type: RequestHeaderModifier
      requestHeaderModifier:
        add:
        - name: x-forwarded-host
          value: api.example.com
        - name: x-cluster
          value: production-us-east-1
        remove:
        - x-internal-debug
    - type: ResponseHeaderModifier
      responseHeaderModifier:
        add:
        - name: x-content-type-options
          value: nosniff
        - name: x-frame-options
          value: DENY
        - name: strict-transport-security
          value: "max-age=31536000; includeSubDomains"
    backendRefs:
    - name: api-service
      port: 80
```

## TLS Termination and Passthrough

### TLS Termination with cert-manager

Configure cert-manager to provision and rotate certificates automatically:

```yaml
# certificate-production.yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: production-tls
  namespace: gateway-system
spec:
  secretName: production-tls
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  dnsNames:
  - api.example.com
  - www.example.com
  - grpc.example.com
  duration: 2160h
  renewBefore: 360h
```

Reference the secret in the Gateway listener:

```yaml
listeners:
- name: https
  protocol: HTTPS
  port: 443
  tls:
    mode: Terminate
    certificateRefs:
    - name: production-tls
      kind: Secret
      group: ""
```

### TLS Passthrough

For services that perform their own TLS termination (mutual TLS databases, internal services requiring end-to-end encryption), the `TLSRoute` with passthrough mode forwards encrypted traffic without terminating it at the gateway:

```yaml
# tlsroute-passthrough.yaml
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: TLSRoute
metadata:
  name: mtls-service-route
  namespace: production
spec:
  parentRefs:
  - name: production-gateway
    namespace: gateway-system
    sectionName: tls-passthrough
  hostnames:
  - mtls.internal.example.com
  rules:
  - backendRefs:
    - name: mtls-service
      port: 8443
```

The Gateway listener for passthrough mode:

```yaml
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
          gateway-access: production
```

## ReferenceGrant for Cross-Namespace Access

By default, `HTTPRoute` objects can only reference `Service` backends in their own namespace. `ReferenceGrant` explicitly authorizes cross-namespace references, providing a clear audit trail of which routes can reach which services.

### Granting Route Access to Backend Services

```yaml
# referencegrant-production.yaml
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-production-routes-to-shared-services
  namespace: shared-services
spec:
  from:
  - group: gateway.networking.k8s.io
    kind: HTTPRoute
    namespace: production
  to:
  - group: ""
    kind: Service
```

With this grant, `HTTPRoute` objects in the `production` namespace can reference `Service` objects in the `shared-services` namespace:

```yaml
# httproute-cross-namespace.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: shared-auth-route
  namespace: production
spec:
  parentRefs:
  - name: production-gateway
    namespace: gateway-system
  hostnames:
  - api.example.com
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /auth
    backendRefs:
    - name: auth-service
      namespace: shared-services
      port: 80
```

### Granting Gateway Access to TLS Secrets

When the TLS certificate secret lives in a different namespace than the Gateway, a `ReferenceGrant` authorizes the Gateway to read it:

```yaml
# referencegrant-tls.yaml
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-gateway-system-tls-secrets
  namespace: cert-manager
spec:
  from:
  - group: gateway.networking.k8s.io
    kind: Gateway
    namespace: gateway-system
  to:
  - group: ""
    kind: Secret
```

## TCP and UDP Routing

### TCP Routing for Databases

Route database connections through the gateway layer for centralized access logging and policy enforcement:

```yaml
# gateway-with-db-listeners.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: database-gateway
  namespace: gateway-system
spec:
  gatewayClassName: envoy-gateway
  listeners:
  - name: mysql
    protocol: TCP
    port: 3306
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchLabels:
            gateway-access: database
  - name: redis
    protocol: TCP
    port: 6379
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchLabels:
            gateway-access: database
```

```yaml
# tcproutes-databases.yaml
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: TCPRoute
metadata:
  name: mysql-route
  namespace: database
spec:
  parentRefs:
  - name: database-gateway
    namespace: gateway-system
    sectionName: mysql
  rules:
  - backendRefs:
    - name: mysql-primary
      port: 3306
---
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: TCPRoute
metadata:
  name: redis-route
  namespace: database
spec:
  parentRefs:
  - name: database-gateway
    namespace: gateway-system
    sectionName: redis
  rules:
  - backendRefs:
    - name: redis-master
      port: 6379
```

## Migration Path from Ingress

### Assessing the Migration Scope

Before migrating, audit existing `Ingress` objects for annotation usage:

```bash
kubectl get ingress --all-namespaces -o json | \
  jq '.items[] | {name: .metadata.name, namespace: .metadata.namespace, annotations: (.metadata.annotations | keys)}'
```

Categorize annotations by capability:

```bash
kubectl get ingress --all-namespaces -o json | \
  jq -r '.items[].metadata.annotations | keys[]' | \
  sort | uniq -c | sort -rn | head -30
```

### Annotation-to-Resource Mapping

Common Nginx Ingress annotations and their Gateway API equivalents:

| Nginx Annotation | Gateway API Equivalent |
|---|---|
| `nginx.ingress.kubernetes.io/rewrite-target` | `HTTPRoute.spec.rules[].filters[].urlRewrite` |
| `nginx.ingress.kubernetes.io/proxy-read-timeout` | `BackendLBPolicy` or implementation extension |
| `nginx.ingress.kubernetes.io/canary-weight` | `HTTPRoute.spec.rules[].backendRefs[].weight` |
| `nginx.ingress.kubernetes.io/ssl-redirect` | `HTTPRoute` redirect filter |
| `nginx.ingress.kubernetes.io/auth-url` | `ExtensionRef` filter (implementation-specific) |

### HTTPS Redirect with HTTPRoute

The most common `Ingress` annotation — forcing HTTPS — translates to an explicit redirect rule:

```yaml
# httproute-https-redirect.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: https-redirect
  namespace: production
spec:
  parentRefs:
  - name: production-gateway
    namespace: gateway-system
    sectionName: http
  hostnames:
  - api.example.com
  rules:
  - filters:
    - type: RequestRedirect
      requestRedirect:
        scheme: https
        statusCode: 301
```

### Parallel Operation During Migration

Run Nginx Ingress and Gateway API simultaneously using a host-by-host migration strategy:

```bash
kubectl apply -f gateway-production.yaml
kubectl apply -f httproute-api-server.yaml

curl -H "Host: api.example.com" https://$(kubectl -n gateway-system \
  get gateway production-gateway \
  -o jsonpath='{.status.addresses[0].value}')/healthz

kubectl delete ingress api-server-ingress -n production
```

Migrate services one by one, validating each before proceeding. The old `Ingress` controller and the new Gateway can serve different hosts simultaneously during the transition period.

## Nginx Gateway Fabric as an Alternative Implementation

For organizations with existing investment in Nginx, **Nginx Gateway Fabric** provides a Gateway API implementation using Nginx as the data plane:

```bash
kubectl apply -f https://github.com/nginxinc/nginx-gateway-fabric/releases/download/v1.4.0/crds.yaml

helm upgrade --install ngf oci://ghcr.io/nginxinc/charts/nginx-gateway-fabric \
  --namespace nginx-gateway \
  --create-namespace \
  --version 1.4.0
```

The `GatewayClass` for Nginx Gateway Fabric:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: nginx
spec:
  controllerName: gateway.nginx.org/nginx-gateway-controller
```

The choice between Envoy Gateway and Nginx Gateway Fabric typically comes down to existing operational expertise and required features. Envoy Gateway has a broader roadmap for advanced traffic management features like circuit breaking and fault injection through `BackendTrafficPolicy`.

## Conclusion

The Kubernetes Gateway API represents a fundamental advancement in Kubernetes networking, addressing the annotation-sprawl and role-confusion problems that made `Ingress` difficult to operate at scale. Key takeaways:

- **Role separation is the primary architectural benefit**: The GatewayClass/Gateway/Route hierarchy allows platform engineers and application developers to own their respective configuration domains with explicit RBAC enforcement rather than annotation conventions.
- **`ReferenceGrant` is mandatory for multi-team architectures**: Any scenario where routes in one namespace reference services in another requires an explicit grant object in the target namespace, creating a clear audit trail for cross-namespace data flows.
- **Traffic splitting is a first-class feature**: Backend weights in `HTTPRoute` eliminate the need for a separate progressive delivery controller for simple canary scenarios, though Argo Rollouts remains the better choice for metric-gated automation.
- **Migration should be host-by-host**: Running Nginx Ingress and Gateway API simultaneously during migration is safe and recommended. Both can serve different hosts behind the same load balancer infrastructure.
- **GRPCRoute enables method-level traffic control**: For gRPC services, `GRPCRoute` provides service and method name matching that would require custom Lua or configuration snippets in Nginx Ingress.
