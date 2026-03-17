---
title: "Kubernetes Gateway API: Production Migration from Ingress to Gateway API"
date: 2028-05-14T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Gateway API", "Ingress", "HTTPRoute", "GRPCRoute", "Networking", "Multi-cluster"]
categories: ["Kubernetes", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete production guide for migrating from Kubernetes Ingress to Gateway API, covering HTTPRoute, GRPCRoute, TCPRoute, multi-cluster gateways, and enterprise traffic management patterns."
more_link: "yes"
url: "/kubernetes-gateway-api-production-guide-advanced/"
---

The Kubernetes Gateway API represents a fundamental shift in how traffic is managed within and into Kubernetes clusters. After years of fragmented Ingress controller annotations and provider-specific workarounds, Gateway API delivers a standardized, role-oriented model that scales from single-cluster ingress to complex multi-cluster federation. This guide covers production migration strategies, advanced routing configurations, and operational patterns for engineering teams ready to move beyond Ingress.

<!--more-->

## Why Gateway API Replaces Ingress

The Ingress resource has served Kubernetes users for nearly a decade, but its design shows its age. The core problems are well-documented in the community:

**Annotation sprawl**: Every Ingress controller implements features through non-portable annotations. NGINX, Traefik, HAProxy, and cloud-specific controllers each have hundreds of unique annotations. Moving between controllers requires significant configuration rewrites.

**Limited expressiveness**: Ingress only handles HTTP/HTTPS routing. TCP, UDP, and gRPC traffic require controller-specific CRDs or workarounds. Header-based routing, traffic weighting, and request transformation are all vendor extensions.

**Single-role model**: The Ingress resource conflates infrastructure provisioning (who creates the load balancer) with routing configuration (who defines the routes). This creates operational friction in multi-team environments.

Gateway API addresses all three with a layered resource model:

- **GatewayClass**: Cluster-scoped, managed by infrastructure operators. Defines the controller implementation.
- **Gateway**: Namespace or cluster-scoped. Defines listeners (ports, protocols, TLS). Managed by platform teams.
- **Routes (HTTPRoute, GRPCRoute, TCPRoute, TLSRoute)**: Namespace-scoped. Managed by application teams.

This separation allows platform teams to provision load balancers while application teams independently manage their routing rules, without either needing elevated privileges in the other's domain.

## Current State and Stability Matrix

As of Gateway API v1.2, the stability matrix is:

| Resource | Channel | Status |
|----------|---------|--------|
| GatewayClass | Standard | GA (v1) |
| Gateway | Standard | GA (v1) |
| HTTPRoute | Standard | GA (v1) |
| ReferenceGrant | Standard | GA (v1) |
| GRPCRoute | Standard | GA (v1) |
| TCPRoute | Experimental | Beta |
| TLSRoute | Experimental | Beta |
| UDPRoute | Experimental | Alpha |
| BackendTLSPolicy | Standard | GA (v1) |
| BackendLBPolicy | Experimental | Alpha |

For production deployments, the Standard channel resources are suitable. Experimental channel resources require explicit opt-in and may change between releases.

## Installing Gateway API CRDs

Gateway API CRDs are not bundled with Kubernetes. Install them independently of any specific controller:

```bash
# Install Standard channel CRDs (production-recommended)
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.1/standard-install.yaml

# Install Experimental channel CRDs (for TCPRoute, UDPRoute, etc.)
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.1/experimental-install.yaml

# Verify CRD installation
kubectl get crd | grep gateway.networking.k8s.io
```

Expected output:
```
gatewayclasses.gateway.networking.k8s.io    2024-01-15T10:00:00Z
gateways.gateway.networking.k8s.io          2024-01-15T10:00:00Z
grpcroutes.gateway.networking.k8s.io        2024-01-15T10:00:00Z
httproutes.gateway.networking.k8s.io        2024-01-15T10:00:00Z
referencegrants.gateway.networking.k8s.io   2024-01-15T10:00:00Z
tcproutes.gateway.networking.k8s.io         2024-01-15T10:00:00Z
```

## Choosing a Gateway API Implementation

Multiple controllers implement Gateway API. Selection criteria depend on existing infrastructure:

### Cilium Gateway API

Cilium provides native Gateway API support without an additional ingress controller. If Cilium is already the CNI, this eliminates a component:

```bash
helm upgrade cilium cilium/cilium \
  --namespace kube-system \
  --reuse-values \
  --set gatewayAPI.enabled=true \
  --set gatewayAPI.secretsNamespace.name=kube-system
```

### Envoy Gateway

Envoy Gateway is the CNCF-sponsored implementation built on Envoy Proxy. Suitable for teams already using Envoy-based infrastructure:

```bash
helm install eg oci://docker.io/envoyproxy/gateway-helm \
  --version v1.2.3 \
  --namespace envoy-gateway-system \
  --create-namespace
```

### NGINX Gateway Fabric

For teams with NGINX operational experience:

```bash
helm install ngf oci://ghcr.io/nginxinc/charts/nginx-gateway-fabric \
  --namespace nginx-gateway \
  --create-namespace \
  --version 1.4.0
```

### Istio Gateway API Integration

If Istio is already deployed as a service mesh, it supports Gateway API natively:

```bash
# Istio automatically creates GatewayClass when deployed
kubectl get gatewayclass
# NAME    CONTROLLER                    ACCEPTED   AGE
# istio   istio.io/gateway-controller   True       5m
```

## GatewayClass Configuration

The GatewayClass is the cluster-scoped entry point. Platform administrators create it once:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: envoy-internal
  annotations:
    description: "Internal load balancer using Envoy Gateway"
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
  parametersRef:
    group: gateway.envoyproxy.io
    kind: EnvoyProxy
    name: default-proxy-config
    namespace: envoy-gateway-system
---
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: default-proxy-config
  namespace: envoy-gateway-system
spec:
  provider:
    type: Kubernetes
    kubernetes:
      envoyService:
        type: LoadBalancer
        loadBalancerIP: 10.100.10.50
        annotations:
          service.beta.kubernetes.io/aws-load-balancer-type: nlb
          service.beta.kubernetes.io/aws-load-balancer-internal: "true"
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
          tolerations:
          - key: "gateway"
            operator: "Equal"
            value: "true"
            effect: "NoSchedule"
        container:
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 2Gi
```

## Gateway Resource Configuration

The Gateway resource defines listeners. Platform teams own this resource:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: production-gateway
  namespace: gateway-infra
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  gatewayClassName: envoy-internal
  listeners:
  - name: http
    protocol: HTTP
    port: 80
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchLabels:
            gateway.networking.k8s.io/route-allowed: "true"
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
            gateway.networking.k8s.io/route-allowed: "true"
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
            gateway.networking.k8s.io/grpc-allowed: "true"
```

Label namespaces to permit route attachment:

```bash
kubectl label namespace payments gateway.networking.k8s.io/route-allowed=true
kubectl label namespace api-services gateway.networking.k8s.io/route-allowed=true
kubectl label namespace grpc-services gateway.networking.k8s.io/grpc-allowed=true
```

## HTTPRoute: Production Patterns

### Basic Service Routing

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: payments-api
  namespace: payments
spec:
  parentRefs:
  - name: production-gateway
    namespace: gateway-infra
    sectionName: https
  hostnames:
  - "payments.example.com"
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /api/v1
      headers:
      - name: Content-Type
        value: application/json
    backendRefs:
    - name: payments-service
      port: 8080
      weight: 100
  - matches:
    - path:
        type: PathPrefix
        value: /api/v2
    backendRefs:
    - name: payments-service-v2
      port: 8080
      weight: 100
```

### Canary Deployments with Traffic Weighting

Traffic splitting for gradual rollouts is a first-class feature in Gateway API, not an annotation hack:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: order-service-canary
  namespace: commerce
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
        value: /orders
    backendRefs:
    - name: order-service-stable
      port: 8080
      weight: 90
    - name: order-service-canary
      port: 8080
      weight: 10
```

Shift traffic programmatically:

```bash
# Increase canary to 25%
kubectl patch httproute order-service-canary -n commerce --type='json' \
  -p='[
    {"op": "replace", "path": "/spec/rules/0/backendRefs/0/weight", "value": 75},
    {"op": "replace", "path": "/spec/rules/0/backendRefs/1/weight", "value": 25}
  ]'
```

### Request/Response Header Manipulation

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-with-headers
  namespace: api-services
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
        value: /v1
    filters:
    - type: RequestHeaderModifier
      requestHeaderModifier:
        add:
        - name: X-Forwarded-For-Original
          value: "true"
        - name: X-Request-ID
          value: "${request.id}"
        set:
        - name: X-API-Version
          value: "v1"
        remove:
        - X-Internal-Token
    - type: ResponseHeaderModifier
      responseHeaderModifier:
        add:
        - name: X-Content-Type-Options
          value: nosniff
        - name: X-Frame-Options
          value: DENY
        - name: Strict-Transport-Security
          value: "max-age=31536000; includeSubDomains"
    backendRefs:
    - name: api-service
      port: 8080
```

### URL Rewriting

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: legacy-api-rewrite
  namespace: api-services
spec:
  parentRefs:
  - name: production-gateway
    namespace: gateway-infra
    sectionName: https
  hostnames:
  - "api.example.com"
  rules:
  # Rewrite /api/v1/* to /v1/*
  - matches:
    - path:
        type: PathPrefix
        value: /api/v1
    filters:
    - type: URLRewrite
      urlRewrite:
        path:
          type: ReplacePrefixMatch
          replacePrefixMatch: /v1
    backendRefs:
    - name: api-service
      port: 8080
  # Redirect HTTP to HTTPS
  - matches:
    - path:
        type: PathPrefix
        value: /
    filters:
    - type: RequestRedirect
      requestRedirect:
        scheme: https
        statusCode: 301
```

### Mirror Traffic for Shadow Testing

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-with-mirror
  namespace: api-services
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
        value: /users
    filters:
    - type: RequestMirror
      requestMirror:
        backendRef:
          name: users-service-shadow
          port: 8080
    backendRefs:
    - name: users-service
      port: 8080
```

## GRPCRoute: Native gRPC Routing

GRPCRoute provides first-class gRPC support without HTTP routing workarounds:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
metadata:
  name: grpc-user-service
  namespace: grpc-services
spec:
  parentRefs:
  - name: production-gateway
    namespace: gateway-infra
    sectionName: grpc
  hostnames:
  - "grpc.example.com"
  rules:
  # Route all methods of UserService to users backend
  - matches:
    - method:
        service: com.example.UserService
        type: Exact
    backendRefs:
    - name: user-service-grpc
      port: 9090
  # Route specific method
  - matches:
    - method:
        service: com.example.OrderService
        method: GetOrder
        type: Exact
      headers:
      - name: x-region
        value: us-east-1
        type: Exact
    backendRefs:
    - name: order-service-grpc-us-east
      port: 9090
  # Default route for OrderService
  - matches:
    - method:
        service: com.example.OrderService
        type: Exact
    backendRefs:
    - name: order-service-grpc
      port: 9090
      weight: 85
    - name: order-service-grpc-v2
      port: 9090
      weight: 15
```

## TCPRoute: Layer 4 Routing

TCPRoute (experimental) handles non-HTTP protocols:

```yaml
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: TCPRoute
metadata:
  name: postgres-route
  namespace: database
spec:
  parentRefs:
  - name: tcp-gateway
    namespace: gateway-infra
    sectionName: postgres
  rules:
  - backendRefs:
    - name: postgres-primary
      port: 5432
---
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: tcp-gateway
  namespace: gateway-infra
spec:
  gatewayClassName: envoy-internal
  listeners:
  - name: postgres
    protocol: TCP
    port: 5432
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchLabels:
            database-access: "true"
      kinds:
      - group: gateway.networking.k8s.io
        kind: TCPRoute
```

## Cross-Namespace References with ReferenceGrant

By default, routes cannot reference backends in other namespaces. ReferenceGrant explicitly permits cross-namespace references:

```yaml
# In the backend's namespace (shared-services)
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
  - group: gateway.networking.k8s.io
    kind: HTTPRoute
    namespace: commerce
  to:
  - group: ""
    kind: Service
```

```yaml
# In payments namespace - can now reference shared-services backend
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: payments-to-shared-auth
  namespace: payments
spec:
  parentRefs:
  - name: production-gateway
    namespace: gateway-infra
    sectionName: https
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /auth
    backendRefs:
    - name: auth-service
      namespace: shared-services
      port: 8080
```

## BackendTLSPolicy: mTLS to Backends

BackendTLSPolicy configures TLS from the gateway to backend services:

```yaml
apiVersion: gateway.networking.k8s.io/v1alpha3
kind: BackendTLSPolicy
metadata:
  name: payments-backend-tls
  namespace: payments
spec:
  targetRefs:
  - group: ""
    kind: Service
    name: payments-service
    sectionName: https
  validation:
    caCertificateRefs:
    - name: internal-ca-cert
      group: ""
      kind: ConfigMap
    hostname: payments-service.payments.svc.cluster.local
    wellKnownCACertificates: ""
```

## Multi-Cluster Gateway with MCS

Gateway API integrates with Multi-Cluster Services (MCS) for federated routing:

```yaml
# Install MCS CRDs
kubectl apply -f https://raw.githubusercontent.com/kubernetes-sigs/mcs-api/master/config/crd/multicluster.x-k8s.io_serviceimports.yaml

# ServiceExport in cluster-1 (us-east)
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: catalog-service
  namespace: commerce
  annotations:
    multicluster.x-k8s.io/cluster: cluster-1
```

```yaml
# HTTPRoute in control-plane cluster referencing multi-cluster service
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: catalog-multicluster
  namespace: commerce
spec:
  parentRefs:
  - name: global-gateway
    namespace: gateway-infra
  hostnames:
  - "catalog.example.com"
  rules:
  - matches:
    - headers:
      - name: x-preferred-region
        value: us-east
    backendRefs:
    - group: multicluster.x-k8s.io
      kind: ServiceImport
      name: catalog-service
      namespace: commerce-us-east
      port: 8080
      weight: 100
  - backendRefs:
    - group: multicluster.x-k8s.io
      kind: ServiceImport
      name: catalog-service
      namespace: commerce
      port: 8080
```

## Migrating from NGINX Ingress

A systematic migration approach minimizes risk. Run both Ingress and Gateway API in parallel during transition:

### Phase 1: Audit Existing Ingress Resources

```bash
# List all Ingress resources with annotations
kubectl get ingress -A -o json | jq -r '
  .items[] |
  "\(.metadata.namespace)/\(.metadata.name): " +
  (.metadata.annotations | to_entries |
   map(select(.key | startswith("nginx.ingress.kubernetes.io"))) |
   map(.key + "=" + .value) |
   join(", "))
'
```

### Phase 2: Map Annotations to Gateway API Features

Common NGINX annotations and their Gateway API equivalents:

| NGINX Annotation | Gateway API Resource |
|-----------------|---------------------|
| `nginx.ingress.kubernetes.io/rewrite-target` | HTTPRoute URLRewrite filter |
| `nginx.ingress.kubernetes.io/ssl-redirect` | HTTPRoute RequestRedirect filter |
| `nginx.ingress.kubernetes.io/proxy-body-size` | HTTPRoute extensionRef |
| `nginx.ingress.kubernetes.io/canary-weight` | HTTPRoute backend weight |
| `nginx.ingress.kubernetes.io/backend-protocol: GRPC` | GRPCRoute |
| `nginx.ingress.kubernetes.io/auth-url` | ExtensionRef to external auth |

### Phase 3: Create Parallel Gateway API Configuration

```bash
# Install migration helper (ingress2gateway)
go install sigs.k8s.io/ingress2gateway@latest

# Convert Ingress resources to Gateway API
ingress2gateway print \
  --provider nginx \
  --namespace payments \
  --input-file <(kubectl get ingress -n payments -o yaml) \
  > payments-gateway-routes.yaml

# Review the output
cat payments-gateway-routes.yaml
```

### Phase 4: Validate with Feature Flags

Use admission webhooks to validate routes before applying:

```bash
# Apply with dry-run first
kubectl apply --dry-run=server -f payments-gateway-routes.yaml

# Apply and monitor
kubectl apply -f payments-gateway-routes.yaml

# Check route status
kubectl describe httproute payments-api -n payments
```

### Phase 5: DNS Cutover

Once Gateway API routes are validated, perform DNS cutover:

```bash
# Get Gateway address
GATEWAY_IP=$(kubectl get gateway production-gateway -n gateway-infra \
  -o jsonpath='{.status.addresses[0].value}')

echo "Gateway IP: $GATEWAY_IP"

# Update DNS (example using AWS Route53 CLI)
aws route53 change-resource-record-sets \
  --hosted-zone-id Z1234567890ABC \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "payments.example.com",
        "Type": "A",
        "TTL": 60,
        "ResourceRecords": [{"Value": "'$GATEWAY_IP'"}]
      }
    }]
  }'
```

## Policy Attachment

Gateway API v1.1 introduced Policy Attachment for extending routing behavior:

```yaml
# Rate limiting policy (implementation-specific)
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendTrafficPolicy
metadata:
  name: payments-rate-limit
  namespace: payments
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: payments-api
  rateLimit:
    type: Local
    local:
      rules:
      - limit:
          requests: 1000
          unit: Second
        clientSelectors:
        - headers:
          - name: x-api-key
            type: Distinct
```

```yaml
# Timeout policy
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendTrafficPolicy
metadata:
  name: api-timeouts
  namespace: api-services
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: Gateway
    name: production-gateway
    namespace: gateway-infra
  timeout:
    tcp:
      connectTimeout: 5s
    http:
      requestReceivedTimeout: 30s
      idleTimeout: 120s
```

## Observability and Monitoring

### Gateway Status Conditions

```bash
# Check Gateway readiness
kubectl get gateway production-gateway -n gateway-infra -o yaml | \
  yq '.status.conditions'

# Check listener status
kubectl get gateway production-gateway -n gateway-infra \
  -o jsonpath='{.status.listeners[*].conditions}' | jq .
```

Expected healthy status:
```yaml
conditions:
- lastTransitionTime: "2024-01-15T10:05:00Z"
  message: ""
  observedGeneration: 1
  reason: Accepted
  status: "True"
  type: Accepted
- lastTransitionTime: "2024-01-15T10:05:00Z"
  message: ""
  observedGeneration: 1
  reason: Programmed
  status: "True"
  type: Programmed
```

### Prometheus Metrics for Envoy Gateway

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: envoy-gateway-metrics
  namespace: envoy-gateway-system
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: envoy-gateway
  endpoints:
  - port: metrics
    interval: 15s
    path: /metrics
```

Key metrics to alert on:

```yaml
# Prometheus alert rules
groups:
- name: gateway-api-alerts
  rules:
  - alert: GatewayHighErrorRate
    expr: |
      sum(rate(envoy_cluster_upstream_rq_5xx[5m])) by (envoy_cluster_name)
      /
      sum(rate(envoy_cluster_upstream_rq_total[5m])) by (envoy_cluster_name)
      > 0.05
    for: 2m
    labels:
      severity: critical
    annotations:
      summary: "Gateway error rate >5% for cluster {{ $labels.envoy_cluster_name }}"

  - alert: GatewayP99LatencyHigh
    expr: |
      histogram_quantile(0.99,
        sum(rate(envoy_cluster_upstream_rq_time_bucket[5m])) by (le, envoy_cluster_name)
      ) > 2000
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "P99 latency >2s for {{ $labels.envoy_cluster_name }}"
```

## Production Checklist

Before promoting Gateway API routes to production:

```bash
#!/bin/bash
# gateway-api-validation.sh

NAMESPACE=$1
ROUTE_NAME=$2

echo "=== Validating HTTPRoute: $NAMESPACE/$ROUTE_NAME ==="

# Check route status
STATUS=$(kubectl get httproute $ROUTE_NAME -n $NAMESPACE \
  -o jsonpath='{.status.parents[0].conditions[?(@.type=="Accepted")].status}')

if [[ "$STATUS" != "True" ]]; then
  echo "ERROR: Route not accepted by gateway"
  kubectl get httproute $ROUTE_NAME -n $NAMESPACE -o yaml
  exit 1
fi

echo "OK: Route accepted"

# Check resolved refs
RESOLVED=$(kubectl get httproute $ROUTE_NAME -n $NAMESPACE \
  -o jsonpath='{.status.parents[0].conditions[?(@.type=="ResolvedRefs")].status}')

if [[ "$RESOLVED" != "True" ]]; then
  echo "ERROR: Backend references not resolved"
  kubectl describe httproute $ROUTE_NAME -n $NAMESPACE
  exit 1
fi

echo "OK: Backend refs resolved"

# Check backend endpoints exist
BACKENDS=$(kubectl get httproute $ROUTE_NAME -n $NAMESPACE \
  -o jsonpath='{.spec.rules[*].backendRefs[*].name}')

for BACKEND in $BACKENDS; do
  ENDPOINTS=$(kubectl get endpoints $BACKEND -n $NAMESPACE \
    -o jsonpath='{.subsets[*].addresses}' 2>/dev/null)
  if [[ -z "$ENDPOINTS" ]]; then
    echo "WARNING: No endpoints for backend $BACKEND"
  else
    echo "OK: Backend $BACKEND has endpoints"
  fi
done

echo "=== Validation complete ==="
```

## Troubleshooting Common Issues

### Route Not Accepted

```bash
# Check if namespace is labeled for the gateway
kubectl get namespace payments --show-labels

# Verify GatewayClass controller is running
kubectl get gatewayclass
kubectl get pods -n envoy-gateway-system

# Check route conditions
kubectl get httproute -A -o json | jq '
  .items[] |
  select(.status.parents[0].conditions[] |
    select(.type == "Accepted" and .status == "False")) |
  {name: .metadata.name, namespace: .metadata.namespace,
   reason: .status.parents[0].conditions[] |
     select(.type == "Accepted").message}
'
```

### TLS Certificate Issues

```bash
# Check cert-manager certificate for gateway
kubectl get certificate -n gateway-infra
kubectl describe certificate wildcard-tls-cert -n gateway-infra

# Verify secret exists and is valid
kubectl get secret wildcard-tls-cert -n gateway-infra -o json | \
  jq -r '.data["tls.crt"]' | base64 -d | openssl x509 -noout -dates -subject
```

### Backend Connection Failures

```bash
# Test connectivity from envoy pod to backend
ENVOY_POD=$(kubectl get pod -n envoy-gateway-system -l app=envoy -o name | head -1)

kubectl exec -n envoy-gateway-system $ENVOY_POD -- \
  curl -v http://payments-service.payments.svc.cluster.local:8080/health

# Check envoy cluster status
kubectl exec -n envoy-gateway-system $ENVOY_POD -- \
  curl -s http://localhost:9901/clusters | grep payments
```

## Summary

Gateway API represents a mature, production-ready replacement for Kubernetes Ingress. The role-oriented model separates infrastructure and application concerns cleanly. HTTPRoute covers the vast majority of HTTP use cases natively; GRPCRoute eliminates annotation-based gRPC workarounds; TCPRoute handles layer-4 protocols. The migration from Ingress is methodical and can be executed incrementally with zero downtime using parallel operation and DNS cutover. Teams investing in Gateway API today gain a portable, standards-based foundation that works consistently across every major cloud provider and open-source implementation.
