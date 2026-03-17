---
title: "Kubernetes Gateway API Migration from Ingress: Enterprise Guide to HTTPRoute, GatewayClass, and Traffic Management Patterns"
date: 2031-06-08T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Gateway API", "Ingress", "HTTPRoute", "GatewayClass", "Networking", "Traffic Management"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to migrating from Kubernetes Ingress to the Gateway API, covering HTTPRoute, GatewayClass, ReferenceGrant, traffic splitting, and production migration patterns."
more_link: "yes"
url: "/kubernetes-gateway-api-migration-from-ingress-enterprise-guide/"
---

The Kubernetes Gateway API represents the most significant evolution in cluster networking since the original Ingress resource was introduced in Kubernetes 1.1. After years of Ingress API limitations frustrating platform teams — vendor-specific annotations, lack of role separation, no native traffic splitting — the Gateway API provides a structured, extensible, and role-aware replacement. This guide covers everything an enterprise platform team needs to plan and execute a production migration from Ingress to Gateway API, including HTTPRoute configuration, GatewayClass selection, multi-team isolation patterns, and advanced traffic management.

<!--more-->

# Kubernetes Gateway API Migration from Ingress

## Why the Gateway API Exists

The original Ingress resource was designed as a minimal abstraction. It handled basic HTTP routing — path-based and host-based — and left everything else to controller-specific annotations. This created an ecosystem where:

- Moving between ingress controllers (NGINX to Traefik, for example) required rewriting annotation-heavy configurations
- Platform administrators had no way to delegate routing control to application teams without granting overly broad permissions
- Advanced features like traffic splitting, header manipulation, request mirroring, and weighted routing required controller-specific workarounds
- The spec itself was frozen; adding new capabilities meant more annotations

The Gateway API was designed from the ground up to solve these problems. It introduces a clear role model, a rich set of routing primitives, and a stable extension point for controller-specific capabilities.

## Core Concepts and Role Model

The Gateway API is built around three roles with corresponding resource types:

**Infrastructure Provider**: Defines `GatewayClass` resources that describe available gateway implementations (analogous to StorageClass). The infrastructure provider or platform administrator owns these.

**Cluster Operator**: Creates `Gateway` resources that instantiate a gateway from a `GatewayClass`. The cluster operator controls which namespaces can attach routes and which listeners are exposed.

**Application Developer**: Creates `HTTPRoute`, `GRPCRoute`, `TCPRoute`, or `TLSRoute` resources in their own namespaces and attaches them to a `Gateway`. They control routing rules for their services without needing cluster-level access.

This role separation is fundamental. In the old Ingress world, a developer adding a new virtual host needed to either modify a cluster-scoped resource or convince a platform team to do it for them. With Gateway API, the attachment model allows application teams to self-service while the platform team retains control over gateway capacity and TLS termination.

## Installing the Gateway API CRDs

The Gateway API CRDs are not bundled with Kubernetes. Install the standard channel (stable) CRDs:

```bash
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/standard-install.yaml
```

For experimental features including `TCPRoute`, `TLSRoute`, and `GRPCRoute` (now stable in v1.2):

```bash
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/experimental-install.yaml
```

Verify the CRDs are installed:

```bash
kubectl get crd | grep gateway.networking.k8s.io
```

Expected output:

```
gatewayclasses.gateway.networking.k8s.io
gateways.gateway.networking.k8s.io
grpcroutes.gateway.networking.k8s.io
httproutes.gateway.networking.k8s.io
referencegrants.gateway.networking.k8s.io
tcproutes.gateway.networking.k8s.io
tlsroutes.gateway.networking.k8s.io
```

## Choosing a Gateway Controller

Several production-grade controllers implement the Gateway API. The choice affects available features and the `GatewayClass` name to use:

| Controller | GatewayClass | Notes |
|---|---|---|
| Envoy Gateway | `eg` | CNCF project, Envoy-based, strong xDS support |
| NGINX Gateway Fabric | `nginx` | F5/NGINX, familiar to NGINX Ingress users |
| Traefik | `traefik` | Good developer UX, dashboard included |
| HAProxy Ingress | `haproxy` | High performance, mature |
| Istio | `istio` | Full service mesh, Gateway API since v1.16 |
| Cilium | `cilium` | eBPF-based, excellent performance |
| Contour | `contour` | VMware, Envoy-based |

For this guide, examples use Envoy Gateway, but the HTTPRoute and GatewayClass YAML is portable across controllers.

### Installing Envoy Gateway

```bash
helm install eg oci://docker.io/envoyproxy/gateway-helm \
  --version v1.2.0 \
  --namespace envoy-gateway-system \
  --create-namespace
```

Wait for the controller to be ready:

```bash
kubectl wait --timeout=5m \
  -n envoy-gateway-system \
  deployment/envoy-gateway \
  --for=condition=Available
```

## GatewayClass Configuration

A `GatewayClass` is cluster-scoped and describes a class of gateways. For Envoy Gateway:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: eg
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
  description: "Envoy Gateway for production traffic"
  parametersRef:
    group: gateway.envoyproxy.io
    kind: EnvoyProxy
    name: production-proxy-config
    namespace: envoy-gateway-system
```

The optional `parametersRef` points to a controller-specific configuration object. For Envoy Gateway this is an `EnvoyProxy` resource:

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: production-proxy-config
  namespace: envoy-gateway-system
spec:
  provider:
    type: Kubernetes
    kubernetes:
      envoyService:
        type: LoadBalancer
        annotations:
          service.beta.kubernetes.io/aws-load-balancer-type: "external"
          service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: "ip"
          service.beta.kubernetes.io/aws-load-balancer-scheme: "internet-facing"
  logging:
    level:
      default: warn
  telemetry:
    metrics:
      prometheus:
        disable: false
```

## Gateway Resource

A `Gateway` instantiates a gateway from a class. This is a namespaced resource, typically owned by the platform team:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: production-gateway
  namespace: gateway-infra
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-production
spec:
  gatewayClassName: eg
  listeners:
  - name: http
    protocol: HTTP
    port: 80
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchLabels:
            gateway.networking.k8s.io/allow-http-routes: "true"
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
            gateway.networking.k8s.io/allow-https-routes: "true"
  - name: grpc
    protocol: HTTPS
    port: 8443
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
            gateway.networking.k8s.io/allow-grpc-routes: "true"
```

The `allowedRoutes` field is the key access control mechanism. The `from: Selector` mode allows routes only from namespaces with matching labels. Other options are `from: Same` (same namespace only) and `from: All` (any namespace, avoid in multi-tenant clusters).

Label the application namespaces accordingly:

```bash
kubectl label namespace team-alpha \
  gateway.networking.k8s.io/allow-https-routes=true

kubectl label namespace team-beta \
  gateway.networking.k8s.io/allow-https-routes=true
```

## HTTPRoute: Basic Configuration

The `HTTPRoute` replaces the `Ingress` resource. A basic routing configuration:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-service
  namespace: team-alpha
spec:
  parentRefs:
  - name: production-gateway
    namespace: gateway-infra
    sectionName: https
  hostnames:
  - "api.example.com"
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /v1/users
    backendRefs:
    - name: users-service
      port: 8080
  - matches:
    - path:
        type: PathPrefix
        value: /v1/orders
    backendRefs:
    - name: orders-service
      port: 8080
  - matches:
    - path:
        type: PathPrefix
        value: /
    backendRefs:
    - name: api-gateway-service
      port: 8080
```

The `parentRefs` field attaches this route to the `production-gateway` in the `gateway-infra` namespace. The `sectionName: https` targets only the HTTPS listener. If the application team's namespace is not labeled to allow HTTPS routes from that gateway, the attachment will fail and the route status will reflect the error.

Check route status:

```bash
kubectl get httproute api-service -n team-alpha -o yaml
```

Look for the `status.parents` field:

```yaml
status:
  parents:
  - conditions:
    - lastTransitionTime: "2031-06-08T10:00:00Z"
      message: Route is accepted
      reason: Accepted
      status: "True"
      type: Accepted
    - lastTransitionTime: "2031-06-08T10:00:00Z"
      message: Resolved all the Object references for the Route
      reason: ResolvedRefs
      status: "True"
      type: ResolvedRefs
    controllerName: gateway.envoyproxy.io/gatewayclass-controller
    parentRef:
      group: gateway.networking.k8s.io
      kind: Gateway
      name: production-gateway
      namespace: gateway-infra
      sectionName: https
```

## ReferenceGrant: Cross-Namespace Service References

A powerful feature absent from Ingress: `ReferenceGrant` allows an HTTPRoute in one namespace to reference a Service in another namespace. This is opt-in and controlled by the namespace owning the target Service.

Scenario: The `team-alpha` namespace has an HTTPRoute that needs to reference a shared authentication service in the `platform-services` namespace:

```yaml
# In the platform-services namespace (owned by platform team)
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-team-alpha-routes
  namespace: platform-services
spec:
  from:
  - group: gateway.networking.k8s.io
    kind: HTTPRoute
    namespace: team-alpha
  to:
  - group: ""
    kind: Service
    name: auth-service  # Optional: restrict to specific service
```

Without this `ReferenceGrant`, an HTTPRoute cannot reference services outside its own namespace. This prevents namespace escaping attacks in multi-tenant clusters.

The HTTPRoute in `team-alpha` can then reference `auth-service`:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: app-with-shared-auth
  namespace: team-alpha
spec:
  parentRefs:
  - name: production-gateway
    namespace: gateway-infra
    sectionName: https
  hostnames:
  - "app.example.com"
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /auth
    backendRefs:
    - name: auth-service
      namespace: platform-services
      port: 8080
  - matches:
    - path:
        type: PathPrefix
        value: /
    backendRefs:
    - name: app-service
      port: 8080
```

## Advanced Traffic Management Patterns

### Weighted Traffic Splitting for Canary Deployments

One of the most requested features missing from Ingress. With HTTPRoute, weighted traffic splitting is a first-class feature:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: canary-deployment
  namespace: team-alpha
spec:
  parentRefs:
  - name: production-gateway
    namespace: gateway-infra
    sectionName: https
  hostnames:
  - "api.example.com"
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /
    backendRefs:
    - name: api-stable
      port: 8080
      weight: 90
    - name: api-canary
      port: 8080
      weight: 10
```

Increase the canary weight progressively by editing the HTTPRoute. No annotation modifications, no controller-specific syntax.

### Header-Based Routing

Route requests to different backends based on request headers:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: header-routing
  namespace: team-alpha
spec:
  parentRefs:
  - name: production-gateway
    namespace: gateway-infra
    sectionName: https
  hostnames:
  - "api.example.com"
  rules:
  - matches:
    - headers:
      - name: X-Beta-User
        value: "true"
    backendRefs:
    - name: api-beta
      port: 8080
  - matches:
    - headers:
      - name: X-API-Version
        type: RegularExpression
        value: "v2\\..*"
    backendRefs:
    - name: api-v2
      port: 8080
  - backendRefs:
    - name: api-stable
      port: 8080
```

### Request/Response Header Modification

HTTPRoute filters allow header manipulation without controller-specific annotations:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: header-modification
  namespace: team-alpha
spec:
  parentRefs:
  - name: production-gateway
    namespace: gateway-infra
    sectionName: https
  hostnames:
  - "api.example.com"
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /api
    filters:
    - type: RequestHeaderModifier
      requestHeaderModifier:
        add:
        - name: X-Request-ID
          value: "generated"
        - name: X-Forwarded-For
          value: "client-ip"
        set:
        - name: X-Internal-Service
          value: "api-service"
        remove:
        - X-Debug-Token
    - type: ResponseHeaderModifier
      responseHeaderModifier:
        add:
        - name: X-Content-Type-Options
          value: nosniff
        - name: X-Frame-Options
          value: DENY
        set:
        - name: Cache-Control
          value: "no-store, max-age=0"
    backendRefs:
    - name: api-service
      port: 8080
```

### URL Rewriting

Path and hostname rewriting replaces the common NGINX `rewrite` annotation:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: path-rewrite
  namespace: team-alpha
spec:
  parentRefs:
  - name: production-gateway
    namespace: gateway-infra
    sectionName: https
  hostnames:
  - "api.example.com"
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /legacy/api/v1
    filters:
    - type: URLRewrite
      urlRewrite:
        path:
          type: ReplacePrefixMatch
          replacePrefixMatch: /api/v2
    backendRefs:
    - name: api-v2
      port: 8080
```

### Request Mirroring

Mirror traffic to a shadow deployment for testing without affecting the primary response:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: traffic-mirror
  namespace: team-alpha
spec:
  parentRefs:
  - name: production-gateway
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
    - type: RequestMirror
      requestMirror:
        backendRef:
          name: api-shadow
          port: 8080
    backendRefs:
    - name: api-production
      port: 8080
```

The client receives the response from `api-production`. The request is also sent to `api-shadow` but its response is discarded. This is invaluable for dark launches.

### HTTP to HTTPS Redirect

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: http-to-https-redirect
  namespace: gateway-infra
spec:
  parentRefs:
  - name: production-gateway
    namespace: gateway-infra
    sectionName: http
  hostnames:
  - "api.example.com"
  - "app.example.com"
  rules:
  - filters:
    - type: RequestRedirect
      requestRedirect:
        scheme: https
        statusCode: 301
```

## GRPCRoute Configuration

With Gateway API v1.2, `GRPCRoute` is stable. Routing gRPC traffic:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
metadata:
  name: grpc-service-route
  namespace: team-alpha
spec:
  parentRefs:
  - name: production-gateway
    namespace: gateway-infra
    sectionName: grpc
  hostnames:
  - "grpc.example.com"
  rules:
  - matches:
    - method:
        service: com.example.UserService
        method: GetUser
    backendRefs:
    - name: user-grpc-service
      port: 9090
  - matches:
    - method:
        service: com.example.OrderService
    backendRefs:
    - name: order-grpc-service
      port: 9090
```

## Migration Strategy from Ingress

### Phase 1: Inventory and Mapping

Before migration, inventory all existing Ingress resources and their controller-specific annotations:

```bash
# List all Ingress resources across namespaces
kubectl get ingress --all-namespaces -o json | \
  jq -r '.items[] | [.metadata.namespace, .metadata.name, .spec.ingressClassName // "default"] | @tsv'

# Extract all annotations used
kubectl get ingress --all-namespaces -o json | \
  jq -r '.items[].metadata.annotations | keys[]' | \
  sort | uniq -c | sort -rn
```

Create an annotation-to-HTTPRoute-filter mapping. Common NGINX annotations translate as follows:

| NGINX Annotation | Gateway API Equivalent |
|---|---|
| `nginx.ingress.kubernetes.io/rewrite-target` | `URLRewrite` filter |
| `nginx.ingress.kubernetes.io/ssl-redirect` | `RequestRedirect` filter |
| `nginx.ingress.kubernetes.io/proxy-body-size` | BackendLBPolicy or policy attachment |
| `nginx.ingress.kubernetes.io/canary` + weight | `weight` in `backendRefs` |
| `nginx.ingress.kubernetes.io/cors-allow-origin` | Custom filter or ExtensionRef |
| `nginx.ingress.kubernetes.io/auth-url` | ExtensionRef to auth filter |

### Phase 2: Parallel Operation

Run Gateway API alongside existing Ingress resources. Both can coexist. Migrate one application at a time:

```bash
# Create the Gateway and GatewayClass
kubectl apply -f gateway-infra/

# Deploy HTTPRoute for a single application (non-production subdomain first)
kubectl apply -f team-alpha/httproute-staging.yaml

# Verify the route is accepted and resolves correctly
kubectl get httproute -n team-alpha -o wide

# Test against the gateway's LoadBalancer IP
GATEWAY_IP=$(kubectl get gateway production-gateway -n gateway-infra \
  -o jsonpath='{.status.addresses[0].value}')

curl -H "Host: api.example.com" "https://$GATEWAY_IP/v1/users" -k
```

### Phase 3: DNS Cutover

Once validation is complete, update DNS to point to the new gateway's load balancer:

```bash
# Get the new gateway external IP or hostname
kubectl get service -n envoy-gateway-system \
  -l gateway.networking.k8s.io/gateway-name=production-gateway \
  -o jsonpath='{.items[0].status.loadBalancer.ingress[0].hostname}'
```

Use a low TTL (60 seconds) before the cutover and restore to a higher TTL afterward.

### Phase 4: Ingress Decommission

After all applications are migrated and the old ingress controller is no longer receiving traffic (verify via metrics), remove the old Ingress resources and eventually the ingress controller itself:

```bash
# Verify the old ingress controller has zero active connections
kubectl logs -n ingress-nginx \
  deployment/ingress-nginx-controller \
  --tail=100 | grep "connections_active"

# Delete old Ingress resources
kubectl delete ingress --all-namespaces --all

# Uninstall the old ingress controller
helm uninstall ingress-nginx -n ingress-nginx
```

## Policy Attachments

Gateway API supports policy resources that attach to gateways or routes. These are controller-specific but follow a standard pattern.

### BackendTLSPolicy

Enforce TLS from the gateway to the backend service (not just TLS termination at the gateway):

```yaml
apiVersion: gateway.networking.k8s.io/v1alpha3
kind: BackendTLSPolicy
metadata:
  name: backend-tls
  namespace: team-alpha
spec:
  targetRefs:
  - group: ""
    kind: Service
    name: api-service
  validation:
    caCertificateRefs:
    - name: internal-ca
      group: ""
      kind: ConfigMap
    hostname: api-service.team-alpha.svc.cluster.local
```

### BackendLBPolicy

Configure load balancing behavior for a backend service:

```yaml
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: BackendLBPolicy
metadata:
  name: api-lb-policy
  namespace: team-alpha
spec:
  targetRefs:
  - group: ""
    kind: Service
    name: api-service
  sessionPersistence:
    sessionName: STICKY_SESSION
    type: Cookie
    cookieConfig:
      lifetimeType: Session
```

## Observability and Monitoring

### Prometheus Metrics

Envoy Gateway exposes standard Envoy metrics. Key metrics for HTTPRoute monitoring:

```yaml
# prometheus-rules.yaml
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
    - alert: GatewayRouteHighErrorRate
      expr: |
        sum(rate(envoy_http_downstream_rq_5xx[5m])) by (envoy_http_conn_manager_prefix)
        /
        sum(rate(envoy_http_downstream_rq_total[5m])) by (envoy_http_conn_manager_prefix)
        > 0.05
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "High 5xx error rate on gateway route"
        description: "Route {{ $labels.envoy_http_conn_manager_prefix }} has >5% error rate"

    - alert: GatewayRouteNotAccepted
      expr: |
        gateway_api_route_accepted_total{status="false"} > 0
      for: 2m
      labels:
        severity: critical
      annotations:
        summary: "HTTPRoute not accepted by gateway"
        description: "One or more HTTPRoutes are not accepted"
```

### Checking Route Status Programmatically

```bash
# Check all HTTPRoutes and their acceptance status
kubectl get httproutes --all-namespaces -o json | \
  jq -r '
    .items[] |
    .metadata.namespace + "/" + .metadata.name + ": " +
    (.status.parents[0].conditions[] |
      select(.type == "Accepted") |
      .status + " (" + .reason + ")"
    )
  '
```

## RBAC for Multi-Team Environments

The Gateway API's role separation maps cleanly to Kubernetes RBAC:

```yaml
# Platform team role: manage Gateways
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: gateway-operator
rules:
- apiGroups: ["gateway.networking.k8s.io"]
  resources: ["gateways", "gatewayclasses"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: ["gateway.networking.k8s.io"]
  resources: ["httproutes", "grpcroutes"]
  verbs: ["get", "list", "watch"]

---
# Application team role: manage HTTPRoutes in their namespace
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: httproute-manager
  namespace: team-alpha
rules:
- apiGroups: ["gateway.networking.k8s.io"]
  resources: ["httproutes", "grpcroutes"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: ["gateway.networking.k8s.io"]
  resources: ["referencegrants"]
  verbs: ["get", "list", "watch"]
```

## Troubleshooting Common Migration Issues

### Route Not Accepted

**Symptom**: `kubectl get httproute` shows `False` for `Accepted` condition.

**Diagnosis**:
```bash
kubectl describe httproute <name> -n <namespace>
```

Common causes and resolutions:

1. **Namespace not labeled**: The gateway's `allowedRoutes` selector does not match the route's namespace labels. Add the required label to the namespace.

2. **Gateway not found**: The `parentRefs` namespace or name is incorrect. Verify the gateway exists: `kubectl get gateway -A`.

3. **Listener protocol mismatch**: A route using TLS-specific features attached to an HTTP listener.

### ResolvedRefs False

**Symptom**: Route is accepted but `ResolvedRefs` is `False`.

**Diagnosis**:
```bash
kubectl get httproute <name> -n <namespace> -o jsonpath='{.status.parents[0].conditions}'
```

Common causes:

1. **Service not found**: The `backendRefs` name or port does not match a real Service.
2. **Missing ReferenceGrant**: Cross-namespace service reference without a corresponding `ReferenceGrant`.
3. **TLS secret not found**: The certificateRef in a Gateway listener points to a non-existent Secret.

### Traffic Not Reaching Backend

```bash
# Check gateway pod logs
kubectl logs -n envoy-gateway-system \
  -l gateway.envoyproxy.io/owning-gateway-name=production-gateway \
  --tail=100

# Check Envoy xDS config for route rules
kubectl exec -n envoy-gateway-system \
  $(kubectl get pod -n envoy-gateway-system \
    -l gateway.envoyproxy.io/owning-gateway-name=production-gateway \
    -o jsonpath='{.items[0].metadata.name}') \
  -- curl -s localhost:19000/config_dump | \
  jq '.configs[] | select(.["@type"] | contains("RouteConfiguration"))'
```

## Production Readiness Checklist

Before completing a Gateway API migration:

- [ ] All Ingress resources have equivalent HTTPRoutes
- [ ] GatewayClass `status.conditions` shows `Accepted: True`
- [ ] All Gateway listeners show `Ready: True`
- [ ] All HTTPRoutes show `Accepted: True` and `ResolvedRefs: True`
- [ ] HTTPS redirect rules are in place for all HTTP listeners
- [ ] TLS certificates are managed by cert-manager with auto-renewal
- [ ] ReferenceGrants are documented and reviewed
- [ ] Namespace labels are part of namespace provisioning automation
- [ ] Prometheus alerts are configured for route acceptance failures
- [ ] Runbooks updated to replace Ingress-specific debugging steps
- [ ] Load testing completed against the new gateway
- [ ] Rollback plan documented (DNS TTL, parallel ingress readiness)

## Conclusion

The Kubernetes Gateway API provides a mature, portable, and operationally superior alternative to Ingress. The role-based model solves real multi-team problems, the portable HTTPRoute specification eliminates controller lock-in, and first-class support for traffic splitting, header manipulation, and request mirroring removes the need for annotation-based workarounds. Migration is straightforward when executed in phases: inventory annotations, stand up the Gateway API stack in parallel, validate routing behavior, cut over DNS, and decommission the old ingress controller. Platform teams that complete this migration will find that application teams can self-service their routing configuration safely and consistently across any compliant gateway controller.
