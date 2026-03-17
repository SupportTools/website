---
title: "Kubernetes Ingress to Gateway API Migration: HTTPRoute, TLSRoute, and GRPCRoute"
date: 2030-01-23T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Gateway API", "HTTPRoute", "GRPCRoute", "TLSRoute", "Ingress", "Networking", "Envoy", "Cilium"]
categories: ["Kubernetes", "Networking", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete enterprise guide to migrating from Kubernetes Ingress to Gateway API: HTTPRoute advanced matching, TLSRoute passthrough, GRPCRoute service routing, multi-cluster patterns, and production migration strategies."
more_link: "yes"
url: "/kubernetes-gateway-api-httproute-tlsroute-grpcroute-migration/"
---

The Kubernetes Gateway API reached General Availability for its core resources in Kubernetes 1.28, signaling the community's commitment to replacing the Ingress API with a richer, role-oriented traffic management model. Organizations running production workloads at scale have been grappling with Ingress limitations for years: annotation proliferation, implementation-specific behavior, lack of first-class TCP/UDP support, and no clean separation between infrastructure ownership and application routing.

This guide provides a complete migration path from Ingress to Gateway API, covering HTTPRoute advanced traffic splitting and header manipulation, TLSRoute for TCP passthrough to backend TLS termination, GRPCRoute for gRPC-aware routing with method-level precision, and multi-cluster gateway patterns using GatewayClass cross-cluster federation. Every example targets production readiness with RBAC, health checks, and observability.

<!--more-->

## Why Gateway API Replaces Ingress

The Ingress API was never designed for the complexity of modern production systems. Its limitations have forced every implementation to invent custom annotation namespaces, creating a situation where `nginx.ingress.kubernetes.io/canary-weight` and `alb.ingress.kubernetes.io/target-group-attributes` solve similar problems in incompatible ways. Teams that switch from NGINX Ingress to AWS ALB Controller must rewrite every Ingress manifest.

Gateway API addresses these problems through four design principles.

**Role-oriented resource hierarchy.** Infrastructure providers define `GatewayClass` (the controller implementation). Platform teams manage `Gateway` (the deployed listener configuration). Application teams own `HTTPRoute`, `GRPCRoute`, and `TLSRoute` (the routing rules). This hierarchy maps cleanly to enterprise RBAC models where networking operations controls the load balancer fleet while application teams self-service their routing.

**Portable behavior.** Route matching semantics, header manipulation, and traffic weighting are standardized in the API spec. An `HTTPRoute` with weight-based traffic splitting works identically on Cilium, Envoy Gateway, and NGINX Gateway Fabric — the implementation handles the backend-specific translation.

**Expressive routing.** HTTPRoute supports multi-condition matching on method, path, headers, and query parameters in a single rule. TLSRoute provides SNI-based passthrough without terminating TLS at the gateway. GRPCRoute enables method-level routing for gRPC services, something Ingress could never express natively.

**Multi-cluster support.** `ReferenceGrant` allows cross-namespace backend references. Combined with multi-cluster implementations like Submariner or Skupper, Gateway API becomes the consistent control plane for federated traffic management.

## Gateway API Resource Taxonomy

Before writing any manifests, it is essential to understand the full resource hierarchy and how each layer is owned.

```
GatewayClass (cluster-scoped, owned by infrastructure)
  └── Gateway (namespace or cluster-scoped, owned by platform team)
        ├── HTTPRoute (namespace-scoped, owned by app team)
        ├── GRPCRoute (namespace-scoped, owned by app team)
        ├── TLSRoute (namespace-scoped, owned by app team)
        ├── TCPRoute (namespace-scoped, alpha)
        └── UDPRoute (namespace-scoped, alpha)
```

Cross-namespace routing requires `ReferenceGrant` in the backend's namespace authorizing the route's namespace to reference it.

```
namespace: platform (Gateway lives here)
  └── Gateway/prod-gateway
        └── allows routes from namespace: apps

namespace: apps (Routes live here)
  └── HTTPRoute/checkout-service → Service/checkout (also in apps)
  └── HTTPRoute/payment-service → Service/payment (also in apps)
```

## Installation and CRD Setup

### Installing Envoy Gateway

Envoy Gateway is the CNCF-sponsored Gateway API implementation built on Envoy proxy. It supports the full GA surface area including GRPCRoute and TLSRoute.

```bash
# Install Envoy Gateway using Helm
helm install eg oci://docker.io/envoyproxy/gateway-helm \
  --version v1.2.0 \
  --namespace envoy-gateway-system \
  --create-namespace \
  --set config.envoyGateway.provider.type=Kubernetes \
  --set config.envoyGateway.gateway.controllerName=gateway.envoyproxy.io/gatewayclass-controller

# Verify the controller is running
kubectl rollout status deployment/envoy-gateway \
  -n envoy-gateway-system \
  --timeout=120s

# Install Gateway API CRDs (if not already installed by Helm)
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/standard-install.yaml

# Install experimental channel CRDs (for TLSRoute and UDPRoute)
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/experimental-install.yaml

# Verify CRDs are installed
kubectl get crds | grep gateway.networking.k8s.io
```

Expected output:
```
gatewayclasses.gateway.networking.k8s.io          2024-01-15T10:00:00Z
gateways.gateway.networking.k8s.io                2024-01-15T10:00:00Z
grpcroutes.gateway.networking.k8s.io              2024-01-15T10:00:00Z
httproutes.gateway.networking.k8s.io              2024-01-15T10:00:00Z
referencegrants.gateway.networking.k8s.io         2024-01-15T10:00:00Z
tlsroutes.gateway.networking.k8s.io               2024-01-15T10:00:00Z
```

### Installing Cilium with Gateway API Support

Cilium's Gateway API implementation is Envoy-based and tightly integrated with eBPF networking.

```bash
# Install Cilium with Gateway API and Envoy enabled
helm upgrade --install cilium cilium/cilium \
  --version 1.15.0 \
  --namespace kube-system \
  --set gatewayAPI.enabled=true \
  --set envoy.enabled=true \
  --set kubeProxyReplacement=true \
  --set k8sServiceHost=<API_SERVER_IP> \
  --set k8sServicePort=6443

# Verify Cilium Gateway API support
cilium status --wait
kubectl get gatewayclass
```

## GatewayClass and Gateway Configuration

### Production GatewayClass

```yaml
# gatewayclass-envoy.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: envoy-production
  annotations:
    # Describe the capabilities for platform teams evaluating which class to use
    gateway.networking.k8s.io/description: |
      Production Envoy Gateway class with global load balancer provisioning,
      TLS certificate management via cert-manager, and Prometheus metrics.
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
  parametersRef:
    group: gateway.envoyproxy.io
    kind: EnvoyProxy
    name: production-proxy-config
    namespace: envoy-gateway-system
---
# Envoy-specific configuration via the parametersRef
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: production-proxy-config
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
                      app.kubernetes.io/name: envoy
                  topologyKey: kubernetes.io/hostname
          topologySpreadConstraints:
            - maxSkew: 1
              topologyKey: topology.kubernetes.io/zone
              whenUnsatisfiable: DoNotSchedule
              labelSelector:
                matchLabels:
                  app.kubernetes.io/name: envoy
          resources:
            requests:
              cpu: "500m"
              memory: "512Mi"
            limits:
              cpu: "2000m"
              memory: "2Gi"
  telemetry:
    metrics:
      prometheus:
        disable: false
    accessLog:
      settings:
        - format:
            type: JSON
          sinks:
            - type: File
              file:
                path: /dev/stdout
```

### Multi-Listener Production Gateway

```yaml
# gateway-production.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: prod-gateway
  namespace: platform
  annotations:
    # Cert-manager will provision certificates for HTTPS listeners
    cert-manager.io/cluster-issuer: letsencrypt-production
spec:
  gatewayClassName: envoy-production
  listeners:
    # HTTP listener — redirects all traffic to HTTPS
    - name: http
      protocol: HTTP
      port: 80
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              gateway.networking.k8s.io/allow-http: "true"

    # HTTPS listener — TLS terminated at the gateway
    - name: https
      protocol: HTTPS
      port: 443
      tls:
        mode: Terminate
        certificateRefs:
          - name: prod-wildcard-tls
            kind: Secret
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              gateway.networking.k8s.io/allow-https: "true"

    # TLS passthrough listener — SNI routing without decryption
    - name: tls-passthrough
      protocol: TLS
      port: 8443
      tls:
        mode: Passthrough
      allowedRoutes:
        kinds:
          - kind: TLSRoute
        namespaces:
          from: Selector
          selector:
            matchLabels:
              gateway.networking.k8s.io/allow-tls: "true"

    # gRPC listener — HTTP/2 with TLS
    - name: grpc
      protocol: HTTPS
      port: 9443
      tls:
        mode: Terminate
        certificateRefs:
          - name: prod-wildcard-tls
            kind: Secret
      allowedRoutes:
        kinds:
          - kind: GRPCRoute
        namespaces:
          from: Selector
          selector:
            matchLabels:
              gateway.networking.k8s.io/allow-grpc: "true"
```

### Namespace Labels for Route Attachment

```bash
# Label application namespaces to allow route attachment
kubectl label namespace apps \
  gateway.networking.k8s.io/allow-https=true \
  gateway.networking.k8s.io/allow-http=true \
  gateway.networking.k8s.io/allow-grpc=true

kubectl label namespace database-services \
  gateway.networking.k8s.io/allow-tls=true
```

## HTTPRoute: Advanced Traffic Management

### Basic Path-Based Routing

The simplest HTTPRoute migration replaces a path-based Ingress rule.

**Before — Nginx Ingress:**
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: app-ingress
  namespace: apps
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /$2
spec:
  ingressClassName: nginx
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /v1(/|$)(.*)
            pathType: Prefix
            backend:
              service:
                name: api-v1
                port:
                  number: 8080
          - path: /v2(/|$)(.*)
            pathType: Prefix
            backend:
              service:
                name: api-v2
                port:
                  number: 8080
```

**After — HTTPRoute:**
```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-routes
  namespace: apps
spec:
  parentRefs:
    - name: prod-gateway
      namespace: platform
      sectionName: https
  hostnames:
    - api.example.com
  rules:
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
        - name: api-v1
          port: 8080
    - matches:
        - path:
            type: PathPrefix
            value: /v2
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

### Multi-Condition Header-Based Routing

HTTPRoute supports AND-semantics within a single match object and OR-semantics across multiple match objects. This enables complex routing decisions without annotations.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: feature-flag-routing
  namespace: apps
spec:
  parentRefs:
    - name: prod-gateway
      namespace: platform
      sectionName: https
  hostnames:
    - checkout.example.com
  rules:
    # Route internal beta testers to v2 (header AND query param required)
    - matches:
        - headers:
            - name: X-Internal-User
              value: "true"
          queryParams:
            - name: beta
              value: "1"
      backendRefs:
        - name: checkout-v2
          port: 8080
          weight: 100

    # Route mobile app clients to mobile-optimized backend
    - matches:
        - headers:
            - name: X-Client-Type
              value: mobile
        - headers:
            - name: User-Agent
              type: RegularExpression
              value: ".*Mobile.*"
      backendRefs:
        - name: checkout-mobile
          port: 8080

    # Default — production traffic with canary split
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: checkout-v1
          port: 8080
          weight: 90
        - name: checkout-v2
          port: 8080
          weight: 10
```

### Canary Deployments with Traffic Splitting

HTTPRoute's native weight-based splitting replaces Nginx `canary-weight` annotations with a portable, spec-compliant approach.

```yaml
# Stage 1: Initial canary at 5% traffic
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: payment-canary
  namespace: apps
  annotations:
    # Track canary state for automated promotion
    canary.support.tools/current-weight: "5"
    canary.support.tools/target-weight: "100"
    canary.support.tools/step-size: "10"
    canary.support.tools/step-interval: "5m"
spec:
  parentRefs:
    - name: prod-gateway
      namespace: platform
      sectionName: https
  hostnames:
    - payment.example.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: payment-stable
          port: 8080
          weight: 95
        - name: payment-canary
          port: 8080
          weight: 5
```

Automated canary progression using a Go controller that patches the HTTPRoute:

```go
package canary

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

var httpRouteGVR = schema.GroupVersionResource{
	Group:    "gateway.networking.k8s.io",
	Version:  "v1",
	Resource: "httproutes",
}

type CanaryController struct {
	dynamicClient dynamic.Interface
	k8sClient     client.Client
	logger        *ctrl.Logger
}

// ProgressCanary increments the canary weight by stepSize, up to 100.
// It patches the HTTPRoute backendRefs weights atomically using a JSON merge patch.
func (c *CanaryController) ProgressCanary(ctx context.Context, namespace, name string) error {
	route, err := c.dynamicClient.Resource(httpRouteGVR).
		Namespace(namespace).
		Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return fmt.Errorf("get HTTPRoute %s/%s: %w", namespace, name, err)
	}

	annotations := route.GetAnnotations()
	currentWeight, err := strconv.Atoi(annotations["canary.support.tools/current-weight"])
	if err != nil {
		return fmt.Errorf("parse current-weight annotation: %w", err)
	}
	stepSize, err := strconv.Atoi(annotations["canary.support.tools/step-size"])
	if err != nil {
		return fmt.Errorf("parse step-size annotation: %w", err)
	}

	newCanaryWeight := currentWeight + stepSize
	if newCanaryWeight > 100 {
		newCanaryWeight = 100
	}
	newStableWeight := 100 - newCanaryWeight

	// JSON merge patch to update weights in the first rule's backendRefs
	patch := fmt.Sprintf(`{
		"metadata": {
			"annotations": {
				"canary.support.tools/current-weight": "%d"
			}
		},
		"spec": {
			"rules": [{
				"backendRefs": [
					{"name": "payment-stable", "port": 8080, "weight": %d},
					{"name": "payment-canary", "port": 8080, "weight": %d}
				]
			}]
		}
	}`, newCanaryWeight, newStableWeight, newCanaryWeight)

	_, err = c.dynamicClient.Resource(httpRouteGVR).
		Namespace(namespace).
		Patch(ctx, name, types.MergePatchType, []byte(patch), metav1.PatchOptions{})
	if err != nil {
		return fmt.Errorf("patch HTTPRoute weights: %w", err)
	}

	c.logger.Info("progressed canary",
		"namespace", namespace,
		"name", name,
		"canary_weight", newCanaryWeight,
		"stable_weight", newStableWeight,
	)

	if newCanaryWeight == 100 {
		c.logger.Info("canary promotion complete, stable traffic fully migrated",
			"namespace", namespace, "name", name)
	}

	return nil
}

// RollbackCanary resets canary weight to 0 and stable weight to 100.
func (c *CanaryController) RollbackCanary(ctx context.Context, namespace, name string) error {
	patch := `{
		"metadata": {
			"annotations": {
				"canary.support.tools/current-weight": "0"
			}
		},
		"spec": {
			"rules": [{
				"backendRefs": [
					{"name": "payment-stable", "port": 8080, "weight": 100},
					{"name": "payment-canary", "port": 8080, "weight": 0}
				]
			}]
		}
	}`

	_, err := c.dynamicClient.Resource(httpRouteGVR).
		Namespace(namespace).
		Patch(ctx, name, types.MergePatchType, []byte(patch), metav1.PatchOptions{})
	return err
}
```

### Request/Response Header Manipulation

HTTPRoute filters replace the `nginx.ingress.kubernetes.io/configuration-snippet` annotation with structured, validated configuration.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-header-manipulation
  namespace: apps
spec:
  parentRefs:
    - name: prod-gateway
      namespace: platform
      sectionName: https
  hostnames:
    - api.example.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api
      filters:
        # Add security headers to every request going to the backend
        - type: RequestHeaderModifier
          requestHeaderModifier:
            add:
              - name: X-Forwarded-Proto
                value: https
              - name: X-Request-Source
                value: gateway
            set:
              - name: X-Real-IP
                value: "{{ .ClientIP }}"
            remove:
              - X-Internal-Debug
              - X-Admin-Override

        # Add CORS and security headers to every response
        - type: ResponseHeaderModifier
          responseHeaderModifier:
            add:
              - name: Strict-Transport-Security
                value: "max-age=31536000; includeSubDomains; preload"
              - name: X-Content-Type-Options
                value: nosniff
              - name: X-Frame-Options
                value: DENY
              - name: Content-Security-Policy
                value: "default-src 'self'; script-src 'self'"
            remove:
              - X-Powered-By
              - Server

        # Rewrite the path before forwarding
        - type: URLRewrite
          urlRewrite:
            hostname: api-internal.cluster.local
            path:
              type: ReplacePrefixMatch
              replacePrefixMatch: /internal

      backendRefs:
        - name: api-service
          port: 8080
```

### HTTP to HTTPS Redirect

Replacing the Nginx `ssl-redirect` annotation with a portable redirect filter:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: https-redirect
  namespace: platform
spec:
  parentRefs:
    - name: prod-gateway
      namespace: platform
      sectionName: http
  hostnames:
    - "*.example.com"
  rules:
    - filters:
        - type: RequestRedirect
          requestRedirect:
            scheme: https
            statusCode: 301
```

### Mirror Traffic for Dark Testing

HTTPRoute supports mirroring requests to a secondary backend without affecting the primary response path. This enables safe testing of new service versions against production traffic.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: user-service-with-mirror
  namespace: apps
spec:
  parentRefs:
    - name: prod-gateway
      namespace: platform
      sectionName: https
  hostnames:
    - users.example.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      filters:
        # Mirror 10% of traffic to the shadow service
        # The client receives only the primary backend's response
        - type: RequestMirror
          requestMirror:
            backendRef:
              name: user-service-shadow
              port: 8080
            percent: 10
      backendRefs:
        - name: user-service
          port: 8080
```

## TLSRoute: SNI-Based Passthrough Routing

TLSRoute enables routing encrypted traffic based on the SNI (Server Name Indication) extension without decrypting it at the gateway. The backend service terminates TLS itself, preserving end-to-end encryption.

`★ Insight ─────────────────────────────────────`
TLSRoute passthrough is fundamentally different from HTTPS termination at the Gateway. With passthrough, the Gateway reads only the unencrypted TLS ClientHello header to extract the SNI hostname, then forwards the raw TCP stream to the backend. The backend's certificate identity is preserved, making this appropriate for mutual TLS scenarios, database connections, and services with hardware security module-backed keys.
`─────────────────────────────────────────────────`

### PostgreSQL with TLS Passthrough

```yaml
# Allow the apps namespace to reference services in database namespace
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-db-reference
  namespace: database
spec:
  from:
    - group: gateway.networking.k8s.io
      kind: TLSRoute
      namespace: apps
  to:
    - group: ""
      kind: Service
      name: postgres-primary
---
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: TLSRoute
metadata:
  name: postgres-tls
  namespace: apps
spec:
  parentRefs:
    - name: prod-gateway
      namespace: platform
      sectionName: tls-passthrough
  hostnames:
    - postgres.db.example.com
  rules:
    - backendRefs:
        - name: postgres-primary
          namespace: database
          port: 5432
```

### Multi-Tenant Database Routing

Route different SNI hostnames to different database clusters:

```yaml
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: TLSRoute
metadata:
  name: multi-tenant-db
  namespace: database
spec:
  parentRefs:
    - name: prod-gateway
      namespace: platform
      sectionName: tls-passthrough
  rules:
    # Tenant A routes to their dedicated Postgres cluster
    - matches:
        - snis:
            - tenant-a.postgres.example.com
      backendRefs:
        - name: postgres-tenant-a
          port: 5432

    # Tenant B routes to their dedicated Postgres cluster
    - matches:
        - snis:
            - tenant-b.postgres.example.com
      backendRefs:
        - name: postgres-tenant-b
          port: 5432

    # Shared analytics cluster
    - matches:
        - snis:
            - analytics.postgres.example.com
      backendRefs:
        - name: postgres-analytics
          port: 5432
```

### Mutual TLS with Certificate Pinning

For services requiring mTLS end-to-end (where the gateway should not terminate the outer TLS), TLSRoute passthrough preserves the full certificate chain. The backend validates the client certificate.

```yaml
# Backend service configured for mTLS
apiVersion: apps/v1
kind: Deployment
metadata:
  name: secure-api
  namespace: apps
spec:
  template:
    spec:
      containers:
        - name: secure-api
          image: secure-api:v2.0.0
          env:
            - name: TLS_CERT_FILE
              value: /certs/tls.crt
            - name: TLS_KEY_FILE
              value: /certs/tls.key
            - name: TLS_CLIENT_CA_FILE
              value: /certs/ca.crt
            - name: TLS_CLIENT_AUTH
              value: require  # RequireAndVerifyClientCert
          volumeMounts:
            - name: tls-certs
              mountPath: /certs
              readOnly: true
      volumes:
        - name: tls-certs
          secret:
            secretName: secure-api-tls
---
# TLSRoute passes through mTLS traffic to this backend
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: TLSRoute
metadata:
  name: secure-api-tls
  namespace: apps
spec:
  parentRefs:
    - name: prod-gateway
      namespace: platform
      sectionName: tls-passthrough
  hostnames:
    - secure.api.example.com
  rules:
    - backendRefs:
        - name: secure-api
          port: 8443
```

## GRPCRoute: Method-Level gRPC Routing

GRPCRoute reached GA status in Kubernetes 1.31. It provides gRPC-native routing based on service name and method, with header matching for per-method traffic policies.

`★ Insight ─────────────────────────────────────`
gRPC uses HTTP/2 with a specific URI format: `/<package>.<service>/<method>`. GRPCRoute understands this structure natively, enabling routing rules like "route all calls to the UserService.GetUser method to the read-replica fleet, but route UserService.CreateUser to the write-primary fleet." This is impossible to express cleanly in HTTPRoute without regex hacks.
`─────────────────────────────────────────────────`

### Basic gRPC Service Routing

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
metadata:
  name: user-service-grpc
  namespace: apps
spec:
  parentRefs:
    - name: prod-gateway
      namespace: platform
      sectionName: grpc
  hostnames:
    - grpc.example.com
  rules:
    # Route all UserService calls
    - matches:
        - method:
            service: com.example.user.UserService
      backendRefs:
        - name: user-service
          port: 9090

    # Route all OrderService calls
    - matches:
        - method:
            service: com.example.order.OrderService
      backendRefs:
        - name: order-service
          port: 9090
```

### Read/Write Splitting for gRPC Services

Route read methods to a read-replica fleet and write methods to the primary service:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
metadata:
  name: inventory-service-rw-split
  namespace: apps
spec:
  parentRefs:
    - name: prod-gateway
      namespace: platform
      sectionName: grpc
  hostnames:
    - grpc.example.com
  rules:
    # Read methods — route to read replicas (higher replica count)
    - matches:
        - method:
            service: com.example.inventory.InventoryService
            method: GetItem
        - method:
            service: com.example.inventory.InventoryService
            method: ListItems
        - method:
            service: com.example.inventory.InventoryService
            method: SearchItems
      backendRefs:
        - name: inventory-read
          port: 9090
          weight: 100

    # Write methods — route to primary (single source of truth)
    - matches:
        - method:
            service: com.example.inventory.InventoryService
            method: CreateItem
        - method:
            service: com.example.inventory.InventoryService
            method: UpdateItem
        - method:
            service: com.example.inventory.InventoryService
            method: DeleteItem
      backendRefs:
        - name: inventory-primary
          port: 9090

    # Health check and reflection — route to any replica
    - matches:
        - method:
            service: grpc.health.v1.Health
        - method:
            service: grpc.reflection.v1alpha.ServerReflection
      backendRefs:
        - name: inventory-read
          port: 9090
          weight: 50
        - name: inventory-primary
          port: 9090
          weight: 50
```

### Header-Based gRPC Routing

Route gRPC calls based on metadata headers for canary deployments:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
metadata:
  name: notification-service-canary
  namespace: apps
spec:
  parentRefs:
    - name: prod-gateway
      namespace: platform
      sectionName: grpc
  hostnames:
    - grpc.example.com
  rules:
    # Internal testers using x-canary-enabled metadata header
    - matches:
        - method:
            service: com.example.notification.NotificationService
          headers:
            - name: x-canary-enabled
              value: "true"
      backendRefs:
        - name: notification-v2
          port: 9090

    # Production traffic split (5% to v2)
    - matches:
        - method:
            service: com.example.notification.NotificationService
      backendRefs:
        - name: notification-v1
          port: 9090
          weight: 95
        - name: notification-v2
          port: 9090
          weight: 5
```

### gRPC Streaming with Timeout Policies

For long-lived streaming RPCs, configure timeouts at the GRPCRoute level using the experimental HTTPRoute timeout extension applied to GRPCRoute:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
metadata:
  name: streaming-service
  namespace: apps
spec:
  parentRefs:
    - name: prod-gateway
      namespace: platform
      sectionName: grpc
  hostnames:
    - grpc.example.com
  rules:
    # Unary RPCs with tight timeout
    - matches:
        - method:
            service: com.example.stream.DataService
            method: GetSnapshot
      timeouts:
        request: 10s
        backendRequest: 8s
      backendRefs:
        - name: data-service
          port: 9090

    # Server-streaming RPC — long timeout for stream duration
    - matches:
        - method:
            service: com.example.stream.DataService
            method: StreamUpdates
      timeouts:
        request: 3600s  # 1 hour for long-lived streams
        backendRequest: 3600s
      backendRefs:
        - name: data-service
          port: 9090
```

## Cross-Namespace Routing with ReferenceGrant

ReferenceGrant is the security boundary that prevents arbitrary cross-namespace backend references. Without it, a route in the `apps` namespace could reference services in `kube-system`.

### Application-to-Shared-Services Pattern

```yaml
# In the shared-services namespace: authorize apps to reference the auth service
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-auth-reference
  namespace: shared-services
spec:
  from:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      namespace: apps
    - group: gateway.networking.k8s.io
      kind: GRPCRoute
      namespace: apps
  to:
    - group: ""
      kind: Service
      name: auth-service
    - group: ""
      kind: Service
      name: session-service
---
# In the apps namespace: HTTPRoute referencing the shared auth service
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: auth-proxy
  namespace: apps
spec:
  parentRefs:
    - name: prod-gateway
      namespace: platform
      sectionName: https
  hostnames:
    - auth.example.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: auth-service
          namespace: shared-services  # Cross-namespace reference, authorized by ReferenceGrant
          port: 8080
```

### Multi-Gateway Pattern for Environment Isolation

```yaml
# Staging gateway in the staging namespace
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: staging-gateway
  namespace: staging
spec:
  gatewayClassName: envoy-production
  listeners:
    - name: https
      protocol: HTTPS
      port: 443
      hostname: "*.staging.example.com"
      tls:
        mode: Terminate
        certificateRefs:
          - name: staging-wildcard-tls
            kind: Secret
      allowedRoutes:
        namespaces:
          from: Same  # Only routes in the staging namespace
---
# Application route in staging — only the staging gateway
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: checkout-staging
  namespace: staging
spec:
  parentRefs:
    - name: staging-gateway
      namespace: staging
      sectionName: https
  hostnames:
    - checkout.staging.example.com
  rules:
    - backendRefs:
        - name: checkout-staging
          port: 8080
```

## Production Migration Strategy

### Phase 1: Parallel Operation

Run Gateway API routes alongside existing Ingress resources. Both serve the same hostnames via different IP addresses. Use DNS weighted routing (Route 53, Cloud DNS) to gradually shift traffic.

```bash
# Step 1: Deploy the Gateway and routes without DNS changes
kubectl apply -f gateway-production.yaml
kubectl apply -f httproutes-all-services.yaml

# Step 2: Verify Gateway is provisioned and routes are accepted
kubectl get gateway prod-gateway -n platform -o jsonpath='{.status.conditions}'
kubectl get httproute -n apps -o custom-columns=\
  'NAME:.metadata.name,ACCEPTED:.status.conditions[?(@.type=="Accepted")].status,RESOLVED:.status.conditions[?(@.type=="ResolvedRefs")].status'

# Expected output:
# NAME                     ACCEPTED   RESOLVED
# api-routes               True       True
# checkout-canary          True       True
# payment-canary           True       True

# Step 3: Get the Gateway's external IP
GATEWAY_IP=$(kubectl get gateway prod-gateway -n platform \
  -o jsonpath='{.status.addresses[0].value}')
echo "Gateway IP: $GATEWAY_IP"

# Step 4: Smoke test directly against gateway IP before DNS cutover
curl -H "Host: api.example.com" "https://$GATEWAY_IP/v1/health" \
  --resolve "api.example.com:443:$GATEWAY_IP" \
  -k -v
```

### Phase 2: DNS Weighted Cutover Script

```bash
#!/usr/bin/env bash
# gateway-api-dns-cutover.sh
# Gradually shifts DNS weight from Ingress IP to Gateway IP

set -euo pipefail

HOSTED_ZONE_ID="${HOSTED_ZONE_ID:?HOSTED_ZONE_ID required}"
INGRESS_IP="${INGRESS_IP:?INGRESS_IP required}"
GATEWAY_IP="${GATEWAY_IP:?GATEWAY_IP required}"
HOSTNAMES=("api.example.com" "checkout.example.com" "payment.example.com")
STEPS=(5 10 20 50 80 100)
STEP_INTERVAL_SECONDS=300  # 5 minutes between steps

wait_for_error_rate() {
  local hostname="$1"
  local max_error_rate="${2:-0.01}"  # 1% error rate threshold

  echo "Checking error rate for $hostname..."
  local error_rate
  # Query Prometheus for 5xx error rate over the last 2 minutes
  error_rate=$(curl -sf "http://prometheus:9090/api/v1/query" \
    --data-urlencode 'query=rate(envoy_cluster_upstream_rq_5xx[2m]) / rate(envoy_cluster_upstream_rq_total[2m])' \
    | jq -r '.data.result[0].value[1] // "0"')

  if (( $(echo "$error_rate > $max_error_rate" | bc -l) )); then
    echo "ERROR: Error rate $error_rate exceeds threshold $max_error_rate for $hostname"
    return 1
  fi
  echo "Error rate $error_rate is acceptable (<$max_error_rate)"
  return 0
}

shift_dns_weight() {
  local hostname="$1"
  local gateway_weight="$2"
  local ingress_weight=$((100 - gateway_weight))

  echo "Shifting $hostname: ingress=$ingress_weight%, gateway=$gateway_weight%"

  aws route53 change-resource-record-sets \
    --hosted-zone-id "$HOSTED_ZONE_ID" \
    --change-batch "{
      \"Changes\": [
        {
          \"Action\": \"UPSERT\",
          \"ResourceRecordSet\": {
            \"Name\": \"$hostname\",
            \"Type\": \"A\",
            \"SetIdentifier\": \"ingress\",
            \"Weight\": $ingress_weight,
            \"TTL\": 60,
            \"ResourceRecords\": [{\"Value\": \"$INGRESS_IP\"}]
          }
        },
        {
          \"Action\": \"UPSERT\",
          \"ResourceRecordSet\": {
            \"Name\": \"$hostname\",
            \"Type\": \"A\",
            \"SetIdentifier\": \"gateway\",
            \"Weight\": $gateway_weight,
            \"TTL\": 60,
            \"ResourceRecords\": [{\"Value\": \"$GATEWAY_IP\"}]
          }
        }
      ]
    }" > /dev/null
}

rollback() {
  echo "ROLLBACK: Shifting all traffic back to Ingress"
  for hostname in "${HOSTNAMES[@]}"; do
    shift_dns_weight "$hostname" 0
  done
  echo "Rollback complete. All traffic on Ingress."
  exit 1
}

trap rollback ERR

echo "Starting Gateway API DNS cutover"
echo "Ingress IP: $INGRESS_IP"
echo "Gateway IP: $GATEWAY_IP"

for step in "${STEPS[@]}"; do
  echo ""
  echo "=== Step: $step% traffic to Gateway API ==="

  for hostname in "${HOSTNAMES[@]}"; do
    shift_dns_weight "$hostname" "$step"
  done

  if [[ "$step" -lt 100 ]]; then
    echo "Waiting ${STEP_INTERVAL_SECONDS}s before error rate check..."
    sleep "$STEP_INTERVAL_SECONDS"

    for hostname in "${HOSTNAMES[@]}"; do
      wait_for_error_rate "$hostname" || rollback
    done
  fi
done

echo ""
echo "=== Cutover complete: 100% traffic on Gateway API ==="
echo "Ingress resources can be deleted after 24-hour observation period."
```

### Phase 3: Validation and Ingress Cleanup

```bash
#!/usr/bin/env bash
# validate-gateway-api-migration.sh

set -euo pipefail

NAMESPACE="${1:-apps}"
GATEWAY_NS="${2:-platform}"
GATEWAY_NAME="${3:-prod-gateway}"

echo "=== Gateway API Migration Validation ==="

# Check Gateway conditions
echo ""
echo "-- Gateway Status --"
kubectl get gateway "$GATEWAY_NAME" -n "$GATEWAY_NS" \
  -o jsonpath='{range .status.conditions[*]}{.type}{"\t"}{.status}{"\t"}{.message}{"\n"}{end}'

# Check all HTTPRoutes are Accepted and have Resolved backends
echo ""
echo "-- HTTPRoute Status --"
kubectl get httproutes -n "$NAMESPACE" \
  -o custom-columns='NAME:.metadata.name,ACCEPTED:.status.conditions[?(@.type=="Accepted")].status,RESOLVED:.status.conditions[?(@.type=="ResolvedRefs")].status,PARENTS:.status.parents[*].parentRef.name'

# Check all GRPCRoutes
echo ""
echo "-- GRPCRoute Status --"
kubectl get grpcroutes -n "$NAMESPACE" 2>/dev/null \
  -o custom-columns='NAME:.metadata.name,ACCEPTED:.status.conditions[?(@.type=="Accepted")].status,RESOLVED:.status.conditions[?(@.type=="ResolvedRefs")].status' || echo "No GRPCRoutes found"

# Check all TLSRoutes
echo ""
echo "-- TLSRoute Status --"
kubectl get tlsroutes -n "$NAMESPACE" 2>/dev/null \
  -o custom-columns='NAME:.metadata.name,ACCEPTED:.status.conditions[?(@.type=="Accepted")].status,RESOLVED:.status.conditions[?(@.type=="ResolvedRefs")].status' || echo "No TLSRoutes found"

# Smoke test all configured hostnames
echo ""
echo "-- Hostname Smoke Tests --"
GATEWAY_IP=$(kubectl get gateway "$GATEWAY_NAME" -n "$GATEWAY_NS" \
  -o jsonpath='{.status.addresses[0].value}')

HOSTNAMES=$(kubectl get httproutes -n "$NAMESPACE" \
  -o jsonpath='{range .items[*]}{.spec.hostnames[*]}{"\n"}{end}' | sort -u)

for hostname in $HOSTNAMES; do
  HTTP_STATUS=$(curl -o /dev/null -s -w "%{http_code}" \
    --resolve "$hostname:443:$GATEWAY_IP" \
    "https://$hostname/health" \
    --connect-timeout 5 \
    --max-time 10 \
    -k 2>/dev/null || echo "CONN_FAILED")

  if [[ "$HTTP_STATUS" =~ ^2 ]]; then
    echo "  PASS $hostname -> $HTTP_STATUS"
  else
    echo "  FAIL $hostname -> $HTTP_STATUS"
  fi
done

echo ""
echo "-- Listing Ingress resources that can be deleted --"
kubectl get ingress -n "$NAMESPACE" 2>/dev/null || echo "No Ingress resources found (migration complete)"
```

## Multi-Cluster Gateway Patterns

### Gateway API with Submariner for Cross-Cluster Routing

```yaml
# cluster-1: East region Gateway
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: east-gateway
  namespace: platform
  labels:
    cluster.kubernetes.io/region: us-east-1
spec:
  gatewayClassName: envoy-production
  listeners:
    - name: https
      protocol: HTTPS
      port: 443
      allowedRoutes:
        namespaces:
          from: All
---
# cluster-2: West region Gateway
# (same spec deployed to west cluster with region label change)
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: west-gateway
  namespace: platform
  labels:
    cluster.kubernetes.io/region: us-west-2
spec:
  gatewayClassName: envoy-production
  listeners:
    - name: https
      protocol: HTTPS
      port: 443
      allowedRoutes:
        namespaces:
          from: All
```

### Global Load Balancing with HTTPRoute Weights

When using a global load balancer (AWS Global Accelerator, Cloudflare, Fastly) in front of regional gateways, use HTTPRoute weights within each cluster to control per-region traffic distribution.

```yaml
# Deployed to each cluster with region-appropriate weights
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: user-service-global
  namespace: apps
  annotations:
    cluster.kubernetes.io/region: us-east-1
    cluster.kubernetes.io/traffic-weight: "60"  # 60% of global traffic to east
spec:
  parentRefs:
    - name: east-gateway
      namespace: platform
      sectionName: https
  hostnames:
    - users.example.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: user-service
          port: 8080
```

### Cross-Cluster Service References with ServiceImport

Using Kubernetes Multi-Cluster Services (MCS) API with Gateway API for cluster-to-cluster backend references:

```yaml
# On cluster-1: Export the auth service to the multi-cluster network
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: auth-service
  namespace: shared-services
---
# On cluster-2: Import the exported auth service
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceImport
metadata:
  name: auth-service
  namespace: shared-services
spec:
  type: ClusterSetIP
  ports:
    - port: 8080
      protocol: TCP
---
# On cluster-2: HTTPRoute references the imported service
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: app-with-remote-auth
  namespace: apps
spec:
  parentRefs:
    - name: west-gateway
      namespace: platform
      sectionName: https
  hostnames:
    - app.example.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /auth
      backendRefs:
        # ServiceImport reference — resolved to the remote cluster's auth-service
        - group: multicluster.x-k8s.io
          kind: ServiceImport
          name: auth-service
          namespace: shared-services
          port: 8080
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: app-service
          port: 8080
```

## RBAC and Policy Governance

### Role-Oriented RBAC

```yaml
# Platform team: can manage Gateways and GatewayClasses
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: gateway-admin
rules:
  - apiGroups: ["gateway.networking.k8s.io"]
    resources: ["gateways", "gatewayclasses"]
    verbs: ["*"]
  - apiGroups: ["gateway.networking.k8s.io"]
    resources: ["httproutes", "grpcroutes", "tlsroutes", "referencegrants"]
    verbs: ["get", "list", "watch"]
---
# Application team: can manage their Routes but not Gateways
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: route-manager
  namespace: apps
rules:
  - apiGroups: ["gateway.networking.k8s.io"]
    resources: ["httproutes", "grpcroutes", "tlsroutes"]
    verbs: ["*"]
  - apiGroups: ["gateway.networking.k8s.io"]
    resources: ["gateways"]
    verbs: ["get", "list"]
  # Application teams cannot create ReferenceGrants — requires explicit approval
---
# Security team: can manage ReferenceGrants (cross-namespace trust)
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: reference-grant-admin
rules:
  - apiGroups: ["gateway.networking.k8s.io"]
    resources: ["referencegrants"]
    verbs: ["*"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: gateway-admin-binding
subjects:
  - kind: Group
    name: platform-team
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: gateway-admin
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: route-manager-binding
  namespace: apps
subjects:
  - kind: Group
    name: app-team
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: route-manager
  apiGroup: rbac.authorization.k8s.io
```

### OPA Gatekeeper Policy for Route Governance

```yaml
# Enforce that all HTTPRoutes have required annotations
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredAnnotations
metadata:
  name: httproute-required-annotations
spec:
  match:
    kinds:
      - apiGroups: ["gateway.networking.k8s.io"]
        kinds: ["HTTPRoute"]
  parameters:
    annotations:
      - "support.tools/team-owner"
      - "support.tools/service-tier"
      - "support.tools/oncall-slack"
---
# Prevent HTTPRoutes from referencing the platform namespace services directly
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8shttproutebackendnamespace
spec:
  crd:
    spec:
      names:
        kind: K8sHTTPRouteBackendNamespace
      validation:
        openAPIV3Schema:
          type: object
          properties:
            forbiddenNamespaces:
              type: array
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8shttproutebackendnamespace

        violation[{"msg": msg}] {
          input.review.kind.kind == "HTTPRoute"
          rule := input.review.object.spec.rules[_]
          backend := rule.backendRefs[_]
          backend.namespace != null
          forbidden := input.parameters.forbiddenNamespaces[_]
          backend.namespace == forbidden
          msg := sprintf("HTTPRoute backend references forbidden namespace: %v", [backend.namespace])
        }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sHTTPRouteBackendNamespace
metadata:
  name: no-platform-backend-references
spec:
  match:
    kinds:
      - apiGroups: ["gateway.networking.k8s.io"]
        kinds: ["HTTPRoute"]
    namespaces:
      - apps
      - staging
  parameters:
    forbiddenNamespaces:
      - kube-system
      - kube-public
      - cert-manager
      - envoy-gateway-system
```

## Observability and Monitoring

### Prometheus Alerting for Gateway API

```yaml
# gateway-api-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: gateway-api-alerts
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
    - name: gateway-api
      interval: 30s
      rules:
        # Gateway is not accepting routes
        - alert: GatewayNotAcceptingRoutes
          expr: |
            kube_gateway_status_condition{condition="Accepted",status="True"} == 0
          for: 5m
          labels:
            severity: critical
            team: platform
          annotations:
            summary: "Gateway {{ $labels.name }} in {{ $labels.namespace }} is not accepting routes"
            description: "The Gateway has been in a non-accepting state for more than 5 minutes. New routes cannot be attached."
            runbook_url: "https://wiki.example.com/runbooks/gateway-not-accepting-routes"

        # HTTPRoute backend is unresolvable
        - alert: HTTPRouteBackendUnresolved
          expr: |
            kube_httproute_status_condition{condition="ResolvedRefs",status="True"} == 0
          for: 3m
          labels:
            severity: warning
            team: app
          annotations:
            summary: "HTTPRoute {{ $labels.name }} has unresolved backends"
            description: "One or more backend services referenced by HTTPRoute {{ $labels.name }} in namespace {{ $labels.namespace }} cannot be resolved."

        # High 5xx error rate on specific route
        - alert: HTTPRouteHighErrorRate
          expr: |
            (
              sum by (route, namespace) (
                rate(envoy_cluster_upstream_rq_5xx[5m])
              )
              /
              sum by (route, namespace) (
                rate(envoy_cluster_upstream_rq_total[5m])
              )
            ) > 0.05
          for: 2m
          labels:
            severity: critical
            team: app
          annotations:
            summary: "High 5xx error rate on route {{ $labels.route }}"
            description: "Route {{ $labels.route }} in namespace {{ $labels.namespace }} is experiencing {{ $value | humanizePercentage }} 5xx errors"
            runbook_url: "https://wiki.example.com/runbooks/high-error-rate"
            slack_channel: "https://hooks.slack.com/services/<WORKSPACE_ID>/<CHANNEL_ID>/<WEBHOOK_TOKEN>"

        # Gateway listener certificate expiring
        - alert: GatewayCertificateExpiringIn14Days
          expr: |
            (ssl_certificate_expiry_seconds - time()) / 86400 < 14
          for: 1h
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "TLS certificate for gateway listener expiring soon"
            description: "TLS certificate expires in {{ $value | humanizeDuration }}. Renew via cert-manager or manual process."

        # Canary weight stuck (not progressing)
        - alert: CanaryWeightStuck
          expr: |
            changes(
              kube_httproute_annotation{annotation="canary_support_tools_current_weight"}[30m]
            ) == 0
            and
            kube_httproute_annotation{annotation="canary_support_tools_current_weight"} > 0
            and
            kube_httproute_annotation{annotation="canary_support_tools_current_weight"} < 100
          for: 30m
          labels:
            severity: warning
            team: app
          annotations:
            summary: "Canary HTTPRoute {{ $labels.name }} weight has not progressed"
            description: "Canary deployment for {{ $labels.name }} in {{ $labels.namespace }} has been stuck at the same weight for 30 minutes."
```

### Grafana Dashboard for Gateway API

```go
package dashboards

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/grafana/grafana-foundation-sdk/go/dashboard"
	"github.com/grafana/grafana-foundation-sdk/go/timeseries"
	"github.com/grafana/grafana-foundation-sdk/go/stat"
)

// BuildGatewayAPIDashboard generates a Grafana dashboard for monitoring
// Kubernetes Gateway API resources using Envoy metrics.
func BuildGatewayAPIDashboard() (*dashboard.Dashboard, error) {
	builder := dashboard.NewDashboardBuilder("Kubernetes Gateway API Overview").
		Uid("k8s-gateway-api").
		Tags([]string{"kubernetes", "gateway-api", "envoy", "networking"}).
		Refresh("30s").
		Time("now-1h", "now").
		WithRow(dashboard.NewRowBuilder("Gateway Health"))

	// Gateway acceptance status
	acceptedGatewaysPanel, err := stat.NewPanelBuilder().
		Title("Gateways Accepted").
		Description("Number of Gateways in Accepted=True condition").
		WithTarget(prometheus.NewDataqueryBuilder().
			Expr(`sum(kube_gateway_status_condition{condition="Accepted",status="True"})`).
			LegendFormat("Accepted")).
		ColorMode("background").
		GraphMode("none").
		Build()
	if err != nil {
		return nil, fmt.Errorf("build accepted gateways panel: %w", err)
	}

	// HTTPRoute acceptance rate
	routeAcceptancePanel, err := stat.NewPanelBuilder().
		Title("HTTPRoutes Accepted").
		WithTarget(prometheus.NewDataqueryBuilder().
			Expr(`sum(kube_httproute_status_condition{condition="Accepted",status="True"})`).
			LegendFormat("Accepted")).
		Build()
	if err != nil {
		return nil, fmt.Errorf("build route acceptance panel: %w", err)
	}

	// Request rate by route
	requestRatePanel, err := timeseries.NewPanelBuilder().
		Title("Request Rate by HTTPRoute").
		WithTarget(prometheus.NewDataqueryBuilder().
			Expr(`sum by (envoy_http_conn_manager_prefix) (rate(envoy_http_downstream_rq_total[5m]))`).
			LegendFormat("{{envoy_http_conn_manager_prefix}}")).
		Unit("reqps").
		Build()
	if err != nil {
		return nil, fmt.Errorf("build request rate panel: %w", err)
	}

	// Error rate by route
	errorRatePanel, err := timeseries.NewPanelBuilder().
		Title("5xx Error Rate by Route").
		WithTarget(prometheus.NewDataqueryBuilder().
			Expr(`sum by (envoy_cluster_name) (rate(envoy_cluster_upstream_rq_5xx[5m])) / sum by (envoy_cluster_name) (rate(envoy_cluster_upstream_rq_total[5m]))`).
			LegendFormat("{{envoy_cluster_name}}")).
		Unit("percentunit").
		Thresholds(dashboard.NewThresholdsConfigBuilder().
			Mode("absolute").
			Steps([]dashboard.Threshold{
				{Color: "green"},
				{Color: "yellow", Value: dashboard.Float64Ptr(0.01)},
				{Color: "red", Value: dashboard.Float64Ptr(0.05)},
			})).
		Build()
	if err != nil {
		return nil, fmt.Errorf("build error rate panel: %w", err)
	}

	// P99 latency
	latencyPanel, err := timeseries.NewPanelBuilder().
		Title("P99 Request Latency by Route").
		WithTarget(prometheus.NewDataqueryBuilder().
			Expr(`histogram_quantile(0.99, sum by (le, envoy_cluster_name) (rate(envoy_cluster_upstream_rq_time_bucket[5m])))`).
			LegendFormat("p99 {{envoy_cluster_name}}")).
		Unit("ms").
		Build()
	if err != nil {
		return nil, fmt.Errorf("build latency panel: %w", err)
	}

	dash, err := builder.
		WithPanel(acceptedGatewaysPanel).
		WithPanel(routeAcceptancePanel).
		WithPanel(requestRatePanel).
		WithPanel(errorRatePanel).
		WithPanel(latencyPanel).
		Build()
	if err != nil {
		return nil, fmt.Errorf("build dashboard: %w", err)
	}

	return &dash, nil
}

func ExportDashboard(d *dashboard.Dashboard, path string) error {
	data, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal dashboard: %w", err)
	}
	return os.WriteFile(path, data, 0644)
}
```

## Ingress Feature Parity Reference

The following table maps common Nginx Ingress annotations to their Gateway API equivalents.

| Nginx Ingress Annotation | Gateway API Equivalent |
|--------------------------|------------------------|
| `nginx.ingress.kubernetes.io/rewrite-target` | `HTTPRoute.spec.rules[].filters[].urlRewrite.path` |
| `nginx.ingress.kubernetes.io/canary-weight` | `HTTPRoute.spec.rules[].backendRefs[].weight` |
| `nginx.ingress.kubernetes.io/ssl-redirect` | Separate HTTPRoute with `requestRedirect` filter on HTTP listener |
| `nginx.ingress.kubernetes.io/proxy-read-timeout` | `HTTPRoute.spec.rules[].timeouts.backendRequest` |
| `nginx.ingress.kubernetes.io/proxy-body-size` | Envoy-specific `BackendTrafficPolicy.spec.loadBalancer` (vendor extension) |
| `nginx.ingress.kubernetes.io/configuration-snippet` | `HTTPRoute.spec.rules[].filters[].requestHeaderModifier` or `responseHeaderModifier` |
| `nginx.ingress.kubernetes.io/auth-url` | External Authorization filter via vendor extension |
| `nginx.ingress.kubernetes.io/cors-allow-origin` | `HTTPRoute` `responseHeaderModifier` for CORS headers |
| `nginx.ingress.kubernetes.io/rate-limit` | Vendor extension (Envoy `BackendTrafficPolicy`, Cilium `CiliumNetworkPolicy`) |
| `nginx.ingress.kubernetes.io/whitelist-source-range` | Vendor extension (Envoy `SecurityPolicy.spec.ipAllowDeny`) |

### Annotations Not Yet in Gateway API Standard

Some functionality is not yet standardized and requires implementation-specific vendor extensions (CRDs):

- **Rate limiting**: Envoy Gateway uses `BackendTrafficPolicy`, Cilium uses `CiliumNetworkPolicy`
- **Authentication**: Envoy Gateway uses `SecurityPolicy` with OIDC/JWT, NGINX uses `auth-url` annotation
- **IP allowlisting**: Envoy Gateway uses `SecurityPolicy.spec.ipAllowDeny`
- **Custom timeout policies**: Envoy uses `BackendTrafficPolicy`, Cilium uses `CiliumEnvoyConfig`

Always check the Gateway API conformance report for your implementation:

```bash
# Run conformance tests against your implementation
go test ./conformance/... \
  -args \
  -gateway-class=envoy-production \
  -supported-features=HTTPRoute,HTTPRouteQueryParamMatching,HTTPRouteMethodMatching,HTTPRouteResponseHeaderModification,HTTPRouteRequestRedirect,HTTPRouteURLRewrite,GRPCRoute,TLSRoute
```

## Troubleshooting Common Issues

### Gateway Not Provisioning an IP

```bash
# Check the Gateway events
kubectl describe gateway prod-gateway -n platform

# Common causes:
# 1. GatewayClass controller not running
kubectl get gatewayclass
kubectl get pods -n envoy-gateway-system

# 2. Listener TLS Secret not found
kubectl get secret prod-wildcard-tls -n platform
# If missing, create it or wait for cert-manager to provision it

# 3. GatewayClass parametersRef not found
kubectl get envoyproxy production-proxy-config -n envoy-gateway-system
```

### HTTPRoute Not Attached to Gateway

```bash
# Check route conditions
kubectl get httproute api-routes -n apps -o yaml | yq '.status'

# Common condition messages:
# "Not accepted: no matching parent found" -> sectionName mismatch
# "Not resolved: Service not found"        -> backend service doesn't exist
# "Not attached: namespace not allowed"    -> namespace label missing on Gateway's allowedRoutes

# Check if the namespace is labeled correctly
kubectl get ns apps --show-labels | grep gateway

# Re-label if missing
kubectl label ns apps gateway.networking.k8s.io/allow-https=true
```

### GRPCRoute Traffic Not Routing

```bash
# gRPC requires HTTP/2 — verify the backend service supports it
kubectl run grpc-debug --image=fullstorydev/grpcurl:latest --rm -it -- \
  -plaintext grpc-service.apps.svc.cluster.local:9090 list

# Verify the Gateway listener is HTTP/2 capable
# HTTPS listeners automatically support HTTP/2 via ALPN negotiation
# HTTP listeners do NOT support HTTP/2 without a specific configuration

# Check that GRPCRoute is attached to the correct listener section
kubectl get grpcroute user-service-grpc -n apps \
  -o jsonpath='{.status.parents[*].conditions}'
```

### TLSRoute Passthrough Not Working

```bash
# Verify the Gateway listener is in Passthrough mode (not Terminate)
kubectl get gateway prod-gateway -n platform \
  -o jsonpath='{.spec.listeners[?(@.name=="tls-passthrough")].tls.mode}'
# Expected: Passthrough

# TLSRoute requires SNI in the TLS ClientHello
# Test with openssl verifying SNI is sent
openssl s_client -connect $GATEWAY_IP:8443 \
  -servername postgres.db.example.com \
  -verify_return_error

# Verify the ReferenceGrant exists if the TLSRoute references a cross-namespace service
kubectl get referencegrant -n database
```

## Implementation-Specific Extensions

### Envoy Gateway SecurityPolicy for JWT Authentication

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata:
  name: api-jwt-auth
  namespace: apps
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: api-routes
  jwt:
    providers:
      - name: auth0
        issuer: https://your-tenant.auth0.com/
        audiences:
          - api.example.com
        remoteJWKS:
          uri: https://your-tenant.auth0.com/.well-known/jwks.json
        claimToHeaders:
          - claim: sub
            header: X-User-ID
          - claim: email
            header: X-User-Email
```

### Cilium Network Policy with Gateway API

```yaml
# Apply Cilium L7 policies to HTTPRoute backends
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: checkout-service-policy
  namespace: apps
spec:
  endpointSelector:
    matchLabels:
      app: checkout-service
  ingress:
    # Allow traffic from the Envoy proxy (Gateway implementation)
    - fromEndpoints:
        - matchLabels:
            app.kubernetes.io/name: envoy
            app.kubernetes.io/component: proxy
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              # Only allow specific HTTP methods and paths
              - method: "GET"
                path: "/cart/.*"
              - method: "POST"
                path: "/cart/checkout"
              - method: "GET"
                path: "/health"
```

## Summary

The migration from Kubernetes Ingress to Gateway API is a multi-phase operational project, not a flag day. The key steps are:

1. **Install the Gateway API CRDs** (standard channel for HTTPRoute/GRPCRoute, experimental for TLSRoute) and deploy an implementation (Envoy Gateway or Cilium).

2. **Stand up a production Gateway** with separate listeners for HTTP redirect, HTTPS termination, TLS passthrough, and gRPC. Apply allowedRoutes policies to enforce namespace isolation.

3. **Migrate routes incrementally** starting with non-critical services. Translate Ingress annotations to HTTPRoute filters for header manipulation, URL rewrite, and redirect. Use native weight-based splitting instead of canary annotations.

4. **Adopt GRPCRoute** for gRPC services to gain method-level routing, read/write splitting, and header-based canary deployments without regex hacks.

5. **Use TLSRoute passthrough** for services requiring end-to-end TLS: database connections, mTLS services, and certificate-pinned APIs.

6. **Execute a DNS-weighted cutover** using weighted Route 53 records or equivalent, with automated rollback on error rate threshold breach.

7. **Apply RBAC and OPA policies** to enforce the role-oriented model: platform teams own Gateways, application teams own Routes, security teams control ReferenceGrants.

The Gateway API eliminates the annotation-proliferation problem, provides portable behavior across implementations, and unlocks first-class support for protocols that Ingress never handled well. For enterprise teams running microservice fleets with mixed HTTP, gRPC, and database traffic, it represents a substantial operational improvement over Ingress-based routing.
