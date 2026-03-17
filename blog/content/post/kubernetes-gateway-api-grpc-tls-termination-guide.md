---
title: "Kubernetes Gateway API: gRPC Routing and TLS Termination Patterns"
date: 2028-11-01T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Gateway API", "gRPC", "TLS", "Networking"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Kubernetes Gateway API for gRPC workloads: GRPCRoute configuration, TLS termination at the Gateway, cert-manager integration, backend TLS verification, and migrating from Ingress to Gateway API."
more_link: "yes"
url: "/kubernetes-gateway-api-grpc-tls-termination-guide/"
---

The Kubernetes Gateway API reached GA for its core resources in late 2023 and has steadily expanded to cover gRPC routing, TLS passthrough, and backend TLS verification — use cases that Ingress could never address cleanly. If you are running gRPC microservices on Kubernetes and managing TLS through a patchwork of ingress annotations, the Gateway API offers a structured, role-oriented alternative that separates infrastructure concerns from application routing.

This guide covers the complete picture: deploying a Gateway with TLS termination, configuring GRPCRoute for method and header-based routing, integrating cert-manager for automated certificate provisioning, verifying backend TLS, and migrating existing Ingress resources.

<!--more-->

# Kubernetes Gateway API: gRPC Routing and TLS Termination Patterns

## Gateway API Architecture Overview

The Gateway API models network traffic in three layers corresponding to organizational roles:

```
┌─────────────────────────────────────────────────────────┐
│  GatewayClass  (Infrastructure Provider)                 │
│  ├── Defines the controller implementation               │
│  └── Configures global parameters (infrastructure team)  │
├─────────────────────────────────────────────────────────┤
│  Gateway  (Cluster Operator)                             │
│  ├── Binds to one GatewayClass                          │
│  ├── Defines listeners (ports, protocols, TLS certs)    │
│  └── Controls which namespaces can attach routes        │
├─────────────────────────────────────────────────────────┤
│  HTTPRoute / GRPCRoute / TLSRoute  (Application Dev)    │
│  ├── Defines routing rules (methods, headers, paths)    │
│  └── References backend Services                        │
└─────────────────────────────────────────────────────────┘
```

This separation means your platform team controls the Gateway (TLS certificates, listener ports, allowed namespaces), while application teams control their own routes — no more cluster-wide Ingress controller annotations or coordination across teams.

## Installing the Gateway API CRDs

The Gateway API CRDs are not bundled with Kubernetes. Install the standard channel:

```bash
# Standard channel (GA resources: GatewayClass, Gateway, HTTPRoute, GRPCRoute)
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/standard-install.yaml

# Experimental channel adds TCPRoute, TLSRoute, UDPRoute, and BackendTLSPolicy
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/experimental-install.yaml

# Verify CRDs installed
kubectl get crd | grep gateway.networking.k8s.io
```

## Deploying an Implementation (Envoy Gateway)

You need a Gateway API implementation. Envoy Gateway is the CNCF-hosted reference implementation backed by Envoy Proxy:

```bash
# Install Envoy Gateway
helm install eg oci://docker.io/envoyproxy/gateway-helm \
  --version v1.2.0 \
  --namespace envoy-gateway-system \
  --create-namespace

# Wait for Envoy Gateway to be ready
kubectl wait --timeout=5m -n envoy-gateway-system \
  deployment/envoy-gateway --for=condition=Available
```

Other production-ready implementations include Istio, Cilium, NGINX Gateway Fabric, Kong Ingress Controller, and Traefik.

## GatewayClass and Gateway with TLS

Create the GatewayClass (usually done once by the platform team) and then a Gateway for your workloads:

```yaml
# gateway-class.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: envoy-gateway
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
---
# gateway-tls.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: prod-gateway
  namespace: gateway-infra
spec:
  gatewayClassName: envoy-gateway
  listeners:
    # HTTPS listener for REST/HTTP services
    - name: https
      protocol: HTTPS
      port: 443
      tls:
        mode: Terminate
        certificateRefs:
          # cert-manager will provision and renew this secret automatically
          - name: prod-gateway-tls
            namespace: gateway-infra
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              gateway-access: "true"

    # HTTPS listener specifically for gRPC (same port, different route type)
    - name: grpc-tls
      protocol: HTTPS
      port: 8443
      tls:
        mode: Terminate
        certificateRefs:
          - name: prod-gateway-tls
            namespace: gateway-infra
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              gateway-access: "true"

    # Plain gRPC (gRPC without TLS — for internal cluster routing only)
    - name: grpc-plaintext
      protocol: HTTP
      port: 50051
      allowedRoutes:
        namespaces:
          from: Same
```

## cert-manager Integration for Automatic TLS

Provision TLS certificates using cert-manager. The Gateway API integration lets cert-manager watch Gateways and provision certificates automatically:

```yaml
# cert-manager-issuer.yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ops@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-key
    solvers:
      - http01:
          gatewayHTTPRoute:
            # cert-manager creates a temporary HTTPRoute for ACME challenges
            parentRefs:
              - name: prod-gateway
                namespace: gateway-infra
                sectionName: https
---
# Certificate resource — cert-manager watches this and provisions the secret.
# With the gateway.cert-manager.io annotations, you can also use
# the Gateway's TLS spec directly (gateway shim mode).
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: prod-gateway-tls
  namespace: gateway-infra
spec:
  secretName: prod-gateway-tls
  duration: 2160h   # 90 days
  renewBefore: 360h # Renew 15 days before expiry
  dnsNames:
    - api.example.com
    - grpc.example.com
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
```

For the cert-manager Gateway API integration (experimental feature in cert-manager v1.15+), annotate the Gateway and cert-manager provisions certificates automatically from the listener TLS spec:

```yaml
# Gateway with cert-manager annotation for automatic certificate management
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: prod-gateway
  namespace: gateway-infra
  annotations:
    # cert-manager watches Gateways with this annotation
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
spec:
  gatewayClassName: envoy-gateway
  listeners:
    - name: grpc-tls
      protocol: HTTPS
      port: 8443
      hostname: grpc.example.com
      tls:
        mode: Terminate
        certificateRefs:
          - name: grpc-example-com-tls  # cert-manager creates this Secret
            namespace: gateway-infra
```

## GRPCRoute: The Core Resource

`GRPCRoute` is the Gateway API resource purpose-built for gRPC. It understands gRPC semantics: service names, method names, and gRPC-specific headers:

```yaml
# grpcroute-inventory.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
metadata:
  name: inventory-service
  namespace: services
spec:
  parentRefs:
    - name: prod-gateway
      namespace: gateway-infra
      sectionName: grpc-tls  # Attach to the gRPC listener specifically
  hostnames:
    - grpc.example.com
  rules:
    # Route all methods in the inventory.v1.InventoryService to the backend.
    - matches:
        - method:
            service: inventory.v1.InventoryService
      backendRefs:
        - name: inventory-service
          port: 50051

    # Route v2 traffic (identified by custom header) to the v2 backend.
    # Useful for blue/green gRPC deployments.
    - matches:
        - method:
            service: inventory.v1.InventoryService
          headers:
            - name: x-api-version
              value: "v2"
      backendRefs:
        - name: inventory-service-v2
          port: 50051
```

## GRPCRoute Method-Level Routing

Route specific gRPC methods to different backends — useful when you have expensive streaming RPCs that should go to high-memory instances:

```yaml
# grpcroute-method-routing.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
metadata:
  name: order-service-routing
  namespace: services
spec:
  parentRefs:
    - name: prod-gateway
      namespace: gateway-infra
      sectionName: grpc-tls
  hostnames:
    - grpc.example.com
  rules:
    # Streaming bulk import method — route to high-memory instances
    - matches:
        - method:
            service: orders.v1.OrderService
            method: BulkImportOrders
      backendRefs:
        - name: order-service-bulk
          port: 50051

    # Standard unary methods — route to regular instances with weights
    - matches:
        - method:
            service: orders.v1.OrderService
            method: CreateOrder
        - method:
            service: orders.v1.OrderService
            method: GetOrder
        - method:
            service: orders.v1.OrderService
            method: ListOrders
      backendRefs:
        - name: order-service
          port: 50051
          weight: 90
        - name: order-service-canary
          port: 50051
          weight: 10

    # Health check method — serve from a lightweight sidecar
    - matches:
        - method:
            service: grpc.health.v1.Health
            method: Check
      backendRefs:
        - name: grpc-health-proxy
          port: 8086
```

## TLS Passthrough for End-to-End Encryption

When your gRPC services perform mutual TLS (mTLS) and you do not want the Gateway to terminate TLS, use TLS passthrough mode with a `TLSRoute`:

```yaml
# tls-passthrough.yaml
# Requires experimental channel CRDs
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: passthrough-gateway
  namespace: gateway-infra
spec:
  gatewayClassName: envoy-gateway
  listeners:
    - name: grpc-passthrough
      protocol: TLS
      port: 50051
      tls:
        mode: Passthrough  # Do not terminate — forward encrypted traffic
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
  name: payment-service-passthrough
  namespace: services
spec:
  parentRefs:
    - name: passthrough-gateway
      namespace: gateway-infra
  hostnames:
    - payment.internal.example.com
  rules:
    - backendRefs:
        - name: payment-service
          port: 50051
```

## Backend TLS Verification (BackendTLSPolicy)

When your Gateway terminates external TLS but needs to re-encrypt traffic to the backend (TLS from Gateway to Pod), use `BackendTLSPolicy`:

```yaml
# backend-tls-policy.yaml
# Requires experimental channel CRDs
apiVersion: gateway.networking.k8s.io/v1alpha3
kind: BackendTLSPolicy
metadata:
  name: inventory-backend-tls
  namespace: services
spec:
  targetRefs:
    - group: ""
      kind: Service
      name: inventory-service
  validation:
    # The CA certificate to verify the backend's TLS certificate
    caCertificateRefs:
      - name: internal-ca-cert
        group: ""
        kind: ConfigMap
    # The hostname used in the TLS SNI extension when connecting to the backend
    hostname: inventory-service.services.svc.cluster.local
---
# ConfigMap holding the internal CA certificate
apiVersion: v1
kind: ConfigMap
metadata:
  name: internal-ca-cert
  namespace: services
data:
  ca.crt: |
    -----BEGIN CERTIFICATE-----
    # Your internal CA certificate here
    # In production, use cert-manager to manage this CA.
    -----END CERTIFICATE-----
```

## Multi-Cluster gRPC Routing with Traffic Splitting

For gradual rollouts across clusters, combine weights on `GRPCRoute` backends. When using a multi-cluster service mesh (like Istio's ServiceEntry or Cilium's ClusterMesh), the backend Services can reference endpoints across clusters:

```yaml
# grpcroute-traffic-split.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
metadata:
  name: catalog-service-split
  namespace: services
spec:
  parentRefs:
    - name: prod-gateway
      namespace: gateway-infra
      sectionName: grpc-tls
  hostnames:
    - grpc.example.com
  rules:
    - matches:
        - method:
            service: catalog.v1.CatalogService
      backendRefs:
        # 95% to stable version in primary cluster
        - name: catalog-service-stable
          port: 50051
          weight: 95
        # 5% to canary version for validation
        - name: catalog-service-canary
          port: 50051
          weight: 5
      filters:
        # Add a response header to identify which backend served the request
        - type: ResponseHeaderModifier
          responseHeaderModifier:
            add:
              - name: x-served-by
                value: "catalog-service"
```

## Migrating from Ingress with nginx.org/grpc-service Annotations

If you are currently using the NGINX Ingress Controller with gRPC annotations, here is the migration path:

```yaml
# BEFORE: NGINX Ingress Controller with gRPC annotation
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: grpc-ingress
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/backend-protocol: "GRPC"
    nginx.ingress.kubernetes.io/grpc-backend: "true"
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - grpc.example.com
      secretName: grpc-tls
  rules:
    - host: grpc.example.com
      http:
        paths:
          - path: /inventory.v1.InventoryService
            pathType: Prefix
            backend:
              service:
                name: inventory-service
                port:
                  number: 50051
```

```yaml
# AFTER: Gateway API GRPCRoute (cleaner, no annotations needed)
apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
metadata:
  name: inventory-grpcroute
  namespace: services
spec:
  parentRefs:
    - name: prod-gateway
      namespace: gateway-infra
      sectionName: grpc-tls
  hostnames:
    - grpc.example.com
  rules:
    - matches:
        - method:
            service: inventory.v1.InventoryService
      backendRefs:
        - name: inventory-service
          port: 50051
```

The migration eliminates annotation sprawl and provides explicit, typed routing rules rather than path-prefix hacks for gRPC service names.

## Gateway API Conformance Testing

Before relying on a Gateway API implementation in production, run the conformance test suite to verify it supports the features you need:

```bash
# Clone the gateway-api repository
git clone https://github.com/kubernetes-sigs/gateway-api.git
cd gateway-api

# Run conformance tests against your cluster
# (assumes kubectl is configured for your cluster)
go test ./conformance/... \
  -args \
  -gateway-class=envoy-gateway \
  -supported-features=GRPCRoute,HTTPRoute,TLSRoute \
  -v

# Or use the pre-built conformance test binary
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/conformance-test-suite.yaml
```

Check the conformance profile for your implementation — not all features are mandatory:

```bash
# Envoy Gateway conformance status
# Check https://gateway.envoyproxy.io/docs/conformance/ for the full matrix

# Features to verify for gRPC workloads:
# - GRPCRoute (GA in Gateway API v1.2)
# - GRPCRoute method matching
# - GRPCRoute header matching
# - TLS termination at Gateway
# - BackendTLSPolicy (experimental)
```

## Namespace Isolation and ReferenceGrant

The Gateway API enforces namespace boundaries. A GRPCRoute in the `services` namespace cannot reference a backend in `payments` without a `ReferenceGrant`:

```yaml
# reference-grant.yaml
# In the payments namespace, grant permission for routes in services namespace
# to reference Services in payments namespace.
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-services-to-payments
  namespace: payments
spec:
  from:
    - group: gateway.networking.k8s.io
      kind: GRPCRoute
      namespace: services
  to:
    - group: ""
      kind: Service
```

This is a deliberate security control — backend teams can prevent other teams from routing traffic to their services without explicit consent.

## Observability: Status Conditions

The Gateway API resources report their state through `.status.conditions`. Always check these when troubleshooting:

```bash
# Check Gateway attachment status
kubectl get gateway prod-gateway -n gateway-infra -o yaml | yq '.status'

# Check GRPCRoute parent binding status
kubectl get grpcroute inventory-service -n services -o yaml | yq '.status'

# Example healthy GRPCRoute status:
# parents:
# - conditions:
#   - lastTransitionTime: "2028-11-01T12:00:00Z"
#     message: Route is accepted
#     reason: Accepted
#     status: "True"
#     type: Accepted
#   - lastTransitionTime: "2028-11-01T12:00:00Z"
#     message: Resolved all the Object references for the Route
#     reason: ResolvedRefs
#     status: "True"
#     type: ResolvedRefs
```

## Full Production Deployment Example

Here is a complete working example for a gRPC service with TLS termination:

```bash
# 1. Create the application namespace with gateway access label
kubectl create namespace grpc-services
kubectl label namespace grpc-services gateway-access=true

# 2. Deploy a sample gRPC service
kubectl apply -f - <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: greeter
  namespace: grpc-services
spec:
  replicas: 2
  selector:
    matchLabels:
      app: greeter
  template:
    metadata:
      labels:
        app: greeter
    spec:
      containers:
        - name: greeter
          image: ghcr.io/grpc/grpc-go/helloworld-server:latest
          ports:
            - containerPort: 50051
              name: grpc
---
apiVersion: v1
kind: Service
metadata:
  name: greeter
  namespace: grpc-services
spec:
  selector:
    app: greeter
  ports:
    - name: grpc
      port: 50051
      targetPort: 50051
      appProtocol: kubernetes.io/h2c  # Hint that this is HTTP/2 cleartext
EOF

# 3. Create the GRPCRoute
kubectl apply -f - <<'EOF'
apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
metadata:
  name: greeter
  namespace: grpc-services
spec:
  parentRefs:
    - name: prod-gateway
      namespace: gateway-infra
      sectionName: grpc-tls
  hostnames:
    - grpc.example.com
  rules:
    - matches:
        - method:
            service: helloworld.Greeter
      backendRefs:
        - name: greeter
          port: 50051
EOF

# 4. Test with grpcurl
grpcurl -proto helloworld.proto grpc.example.com:8443 helloworld.Greeter/SayHello
```

## Summary

The Gateway API solves the fundamental problems with Kubernetes Ingress for gRPC workloads:

1. **GRPCRoute** replaces path-prefix hacks with proper service and method matching
2. **TLS termination** is first-class in the Gateway spec, not an annotation patchwork
3. **cert-manager integration** provisions and renews certificates automatically
4. **BackendTLSPolicy** enables end-to-end encryption with verification
5. **ReferenceGrant** enforces namespace isolation as a security control
6. **Role separation** lets platform teams control infrastructure while application teams own routing

For new gRPC deployments, start with Gateway API from day one. For existing Ingress-based gRPC deployments, the migration is mostly mechanical: replace path prefixes with GRPCRoute service/method matches and eliminate the `nginx.org/backend-protocol: GRPC` annotation.
