---
title: "Kubernetes Gateway API v1 Production Migration: HTTPRoute, TLSRoute, and Replacing Ingress at Scale"
date: 2031-10-09T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Gateway API", "Networking", "HTTPRoute", "Ingress", "Migration", "TLS"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to migrating production Kubernetes clusters from Ingress to Gateway API v1: GatewayClass selection, HTTPRoute advanced matching, TLSRoute configuration, canary routing, and zero-downtime migration strategies for enterprise workloads."
more_link: "yes"
url: "/kubernetes-gateway-api-v1-production-migration-httproute/"
---

The Kubernetes Gateway API graduated to v1 stable in Kubernetes 1.28 and has reached wide implementation support across Envoy-based, HAProxy-based, and cloud provider controllers. It addresses every significant limitation of the Ingress API: multi-tenancy, cross-namespace references, traffic splitting, header manipulation, and request mirroring are all first-class concepts. This guide covers the complete migration path from Ingress to Gateway API in a production cluster running hundreds of Ingress objects, with zero-downtime cutover strategies and validation tooling.

<!--more-->

# Kubernetes Gateway API v1 Production Migration

## Section 1: Why Gateway API Replaces Ingress

The Ingress API was designed in 2015 for a world where NGINX was the dominant Kubernetes ingress controller. It exposes a lowest-common-denominator surface: hostname routing and TLS termination. Everything else—rate limiting, header rewrites, traffic splitting, backend protocol selection—required controller-specific annotations that created tight coupling between workloads and infrastructure.

Gateway API separates concerns across three personas:

| Persona | Resource | Responsibility |
|---|---|---|
| Infrastructure Provider | `GatewayClass` | Defines available gateway implementations |
| Cluster Operator | `Gateway` | Provisions load balancer, certificates |
| Application Developer | `HTTPRoute`, `TLSRoute`, `GRPCRoute` | Defines routing rules per service |

This separation enables platform teams to manage `Gateway` objects while application teams own their `HTTPRoute` objects, with RBAC enforcing the boundary.

### API Group Versions

```bash
# Verify Gateway API CRDs are installed
kubectl get crd | grep gateway.networking.k8s.io

# Should show:
# gateways.gateway.networking.k8s.io                    v1
# gatewayclasses.gateway.networking.k8s.io              v1
# httproutes.gateway.networking.k8s.io                  v1
# grpcroutes.gateway.networking.k8s.io                  v1
# tlsroutes.gateway.networking.k8s.io                   v1alpha2
# tcproutes.gateway.networking.k8s.io                   v1alpha2
# referencegrants.gateway.networking.k8s.io             v1beta1
```

## Section 2: Installing Gateway API CRDs and a Controller

### Installing the Standard Channel CRDs

```bash
# Standard channel (v1 stable resources)
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/standard-install.yaml

# Experimental channel (adds TLSRoute, TCPRoute, GRPCRoute)
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/experimental-install.yaml
```

### Installing Envoy Gateway as the Controller

```bash
helm install eg oci://docker.io/envoyproxy/gateway-helm \
  --version v1.2.0 \
  --namespace envoy-gateway-system \
  --create-namespace

# Verify the controller is running
kubectl get pods -n envoy-gateway-system
# envoy-gateway-5d99c9...  1/1  Running

# Verify GatewayClass is accepted
kubectl get gatewayclass
# NAME            CONTROLLER                        ACCEPTED
# envoy           gateway.envoyproxy.io/gatewaycontroller  True
```

### Installing Cilium Gateway API Controller

```bash
# If using Cilium CNI >= 1.15
helm upgrade cilium cilium/cilium \
  --reuse-values \
  --set gatewayAPI.enabled=true \
  --set gatewayAPI.secretsNamespace.sync.enabled=true
```

## Section 3: GatewayClass and Gateway Configuration

### GatewayClass with Infrastructure Parameters

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: envoy-external
spec:
  controllerName: gateway.envoyproxy.io/gatewaycontroller
  parametersRef:
    group: gateway.envoyproxy.io
    kind: EnvoyProxy
    name: external-proxy-config
    namespace: envoy-gateway-system
---
# EnvoyProxy infrastructure configuration
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
              cpu: 200m
              memory: 256Mi
            limits:
              cpu: 1000m
              memory: 512Mi
```

### Gateway Resource with Multi-Listener TLS

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: prod-external
  namespace: infrastructure
spec:
  gatewayClassName: envoy-external
  listeners:
    - name: http
      port: 80
      protocol: HTTP
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              gateway: prod-external
    - name: https
      port: 443
      protocol: HTTPS
      tls:
        mode: Terminate
        certificateRefs:
          - name: prod-wildcard-tls
            namespace: infrastructure
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              gateway: prod-external
    - name: grpc
      port: 443
      protocol: HTTPS
      tls:
        mode: Terminate
        certificateRefs:
          - name: prod-wildcard-tls
            namespace: infrastructure
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              gateway: prod-external
```

## Section 4: HTTPRoute — Advanced Routing Rules

### Basic HTTPRoute with Path and Header Matching

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: payment-api
  namespace: production
spec:
  parentRefs:
    - name: prod-external
      namespace: infrastructure
      sectionName: https
  hostnames:
    - "api.example.com"
  rules:
    # Exact path match — high priority
    - matches:
        - path:
            type: Exact
            value: /v1/payments/healthz
      backendRefs:
        - name: payment-api-svc
          port: 8080
      filters:
        - type: ResponseHeaderModifier
          responseHeaderModifier:
            set:
              - name: Cache-Control
                value: "no-store"

    # Prefix match with header-based routing
    - matches:
        - path:
            type: PathPrefix
            value: /v1/payments
          headers:
            - name: X-API-Version
              value: "2"
      backendRefs:
        - name: payment-api-v2-svc
          port: 8080

    # Default: route all /v1/payments to v1
    - matches:
        - path:
            type: PathPrefix
            value: /v1/payments
      backendRefs:
        - name: payment-api-v1-svc
          port: 8080
      filters:
        - type: RequestHeaderModifier
          requestHeaderModifier:
            add:
              - name: X-Forwarded-For-Original
                value: "%REQ(X-FORWARDED-FOR)%"
            remove:
              - X-Internal-Debug
```

### HTTPRoute with Traffic Splitting (Canary)

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: user-service-canary
  namespace: production
  annotations:
    # Track which version is the canary
    deployment.kubernetes.io/canary-weight: "10"
spec:
  parentRefs:
    - name: prod-external
      namespace: infrastructure
      sectionName: https
  hostnames:
    - "api.example.com"
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /v2/users
      backendRefs:
        - name: user-service-stable
          port: 8080
          weight: 90
        - name: user-service-canary
          port: 8080
          weight: 10
      filters:
        - type: ResponseHeaderModifier
          responseHeaderModifier:
            add:
              - name: X-Backend-Version
                value: "canary-enabled"
```

### HTTPRoute URL Rewriting and Redirects

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: legacy-redirects
  namespace: production
spec:
  parentRefs:
    - name: prod-external
      namespace: infrastructure
      sectionName: https
  hostnames:
    - "api.example.com"
  rules:
    # Permanent redirect: /api/v1/* -> /v1/*
    - matches:
        - path:
            type: PathPrefix
            value: /api/v1
      filters:
        - type: RequestRedirect
          requestRedirect:
            path:
              type: ReplacePrefixMatch
              replacePrefixMatch: /v1
            statusCode: 301

    # HTTP -> HTTPS redirect
    - matches:
        - path:
            type: PathPrefix
            value: /
      filters:
        - type: RequestRedirect
          requestRedirect:
            scheme: https
            statusCode: 301

    # URL rewrite without redirect (transparent to client)
    - matches:
        - path:
            type: PathPrefix
            value: /legacy/reports
      filters:
        - type: URLRewrite
          urlRewrite:
            path:
              type: ReplacePrefixMatch
              replacePrefixMatch: /v2/analytics/reports
      backendRefs:
        - name: analytics-service
          port: 8080
```

### Request Mirroring for Traffic Analysis

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: search-with-shadow
  namespace: production
spec:
  parentRefs:
    - name: prod-external
      namespace: infrastructure
      sectionName: https
  hostnames:
    - "api.example.com"
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /v1/search
      backendRefs:
        - name: search-service-v1
          port: 8080
      filters:
        - type: RequestMirror
          requestMirror:
            backendRef:
              name: search-service-v2
              port: 8080
            # Mirror 25% of traffic (experimental feature)
            percent: 25
```

## Section 5: TLSRoute for Passthrough Mode

TLSRoute enables SNI-based routing without terminating TLS at the gateway. The backend handles TLS itself.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: prod-tls-passthrough
  namespace: infrastructure
spec:
  gatewayClassName: envoy-external
  listeners:
    - name: tls-passthrough
      port: 8443
      protocol: TLS
      tls:
        mode: Passthrough
      allowedRoutes:
        kinds:
          - kind: TLSRoute
        namespaces:
          from: All
---
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: TLSRoute
metadata:
  name: kafka-tls
  namespace: data-platform
spec:
  parentRefs:
    - name: prod-tls-passthrough
      namespace: infrastructure
  hostnames:
    - "kafka.internal.example.com"
  rules:
    - backendRefs:
        - name: kafka-bootstrap
          port: 9093
```

## Section 6: Cross-Namespace ReferenceGrant

Application teams can reference backend services in other namespaces only when the owning namespace grants permission via `ReferenceGrant`.

```yaml
# In the 'shared-services' namespace: allow 'production' to reference services here
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-production-routes
  namespace: shared-services
spec:
  from:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      namespace: production
  to:
    - group: ""
      kind: Service
---
# Now an HTTPRoute in 'production' can reference a service in 'shared-services'
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: auth-proxy
  namespace: production
spec:
  parentRefs:
    - name: prod-external
      namespace: infrastructure
      sectionName: https
  hostnames:
    - "app.example.com"
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /auth
      backendRefs:
        - name: keycloak
          namespace: shared-services  # cross-namespace reference
          port: 8080
```

## Section 7: GRPCRoute for gRPC Services

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
metadata:
  name: inventory-grpc
  namespace: production
spec:
  parentRefs:
    - name: prod-external
      namespace: infrastructure
      sectionName: grpc
  hostnames:
    - "grpc.example.com"
  rules:
    # Route specific gRPC service
    - matches:
        - method:
            service: inventory.v1.InventoryService
            method: GetItem
      backendRefs:
        - name: inventory-service
          port: 9090
    # Route all other methods to the same backend
    - matches:
        - method:
            service: inventory.v1.InventoryService
      backendRefs:
        - name: inventory-service
          port: 9090
      filters:
        - type: RequestHeaderModifier
          requestHeaderModifier:
            add:
              - name: x-envoy-retry-grpc-on
                value: "cancelled,deadline-exceeded,resource-exhausted"
```

## Section 8: Automating Ingress-to-HTTPRoute Migration

### Migration Script

```bash
#!/bin/bash
# ingress-to-httproute.sh
# Converts existing Ingress objects to HTTPRoute equivalents.
# Outputs YAML to stdout; does not apply automatically.

set -euo pipefail

GATEWAY_NAME="${GATEWAY_NAME:-prod-external}"
GATEWAY_NAMESPACE="${GATEWAY_NAMESPACE:-infrastructure}"
GATEWAY_SECTION="${GATEWAY_SECTION:-https}"

generate_httproute() {
  local namespace="$1"
  local ingress_name="$2"

  # Extract ingress data
  local data
  data=$(kubectl get ingress "${ingress_name}" -n "${namespace}" -o json)

  local hostname
  hostname=$(echo "${data}" | jq -r '.spec.rules[0].host // ""')

  if [[ -z "${hostname}" ]]; then
    echo "# SKIP: ${namespace}/${ingress_name} — no host defined" >&2
    return
  fi

  echo "---"
  echo "# Converted from Ingress ${namespace}/${ingress_name}"
  cat <<EOF
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: ${ingress_name}
  namespace: ${namespace}
  labels:
    migrated-from: ingress
    original-ingress: "${ingress_name}"
spec:
  parentRefs:
    - name: ${GATEWAY_NAME}
      namespace: ${GATEWAY_NAMESPACE}
      sectionName: ${GATEWAY_SECTION}
  hostnames:
    - "${hostname}"
  rules:
EOF

  # Convert each path rule
  echo "${data}" | jq -r '
    .spec.rules[0].http.paths[] |
    @base64' | while read -r encoded; do
    local path
    path=$(echo "${encoded}" | base64 -d)
    local path_value
    path_value=$(echo "${path}" | jq -r '.path // "/"')
    local path_type
    path_type=$(echo "${path}" | jq -r '.pathType // "Prefix"')
    local svc_name
    svc_name=$(echo "${path}" | jq -r '.backend.service.name')
    local svc_port
    svc_port=$(echo "${path}" | jq -r '.backend.service.port.number')

    # Map Ingress pathType to Gateway API pathType
    local gw_path_type
    case "${path_type}" in
      Exact)   gw_path_type="Exact" ;;
      Prefix)  gw_path_type="PathPrefix" ;;
      *)       gw_path_type="PathPrefix" ;;
    esac

    cat <<EOF
    - matches:
        - path:
            type: ${gw_path_type}
            value: "${path_value}"
      backendRefs:
        - name: ${svc_name}
          port: ${svc_port}
EOF
  done
}

# Process all ingresses in a namespace
migrate_namespace() {
  local namespace="$1"
  local ingresses
  ingresses=$(kubectl get ingress -n "${namespace}" \
    --no-headers -o jsonpath='{.items[*].metadata.name}')

  for ingress in ${ingresses}; do
    generate_httproute "${namespace}" "${ingress}"
  done
}

# Migrate all namespaces
for ns in $(kubectl get namespaces -o jsonpath='{.items[*].metadata.name}'); do
  count=$(kubectl get ingress -n "${ns}" --no-headers 2>/dev/null | wc -l)
  if [[ "${count}" -gt 0 ]]; then
    echo "# Namespace: ${ns} (${count} ingresses)" >&2
    migrate_namespace "${ns}"
  fi
done
```

### Validation After Migration

```bash
#!/bin/bash
# validate-httproutes.sh

ERRORS=0

validate_route() {
  local ns="$1" name="$2"
  local status
  status=$(kubectl get httproute "${name}" -n "${ns}" -o json)

  # Check if route is accepted by the parent gateway
  local accepted
  accepted=$(echo "${status}" | jq -r '
    .status.parents[0].conditions[] |
    select(.type=="Accepted") | .status')

  # Check if route has a resolved backend
  local resolved
  resolved=$(echo "${status}" | jq -r '
    .status.parents[0].conditions[] |
    select(.type=="ResolvedRefs") | .status')

  if [[ "${accepted}" != "True" || "${resolved}" != "True" ]]; then
    echo "FAIL: ${ns}/${name} — Accepted=${accepted} ResolvedRefs=${resolved}"
    kubectl get httproute "${name}" -n "${ns}" \
      -o jsonpath='{.status.parents[0].conditions}' | jq .
    ERRORS=$((ERRORS + 1))
  else
    echo "OK:   ${ns}/${name}"
  fi
}

# Validate all HTTPRoutes
while IFS='/' read -r ns name; do
  validate_route "${ns}" "${name}"
done < <(kubectl get httproute -A --no-headers \
  -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name' | \
  awk '{print $1"/"$2}')

echo ""
echo "Validation complete. Errors: ${ERRORS}"
exit ${ERRORS}
```

## Section 9: Zero-Downtime Cutover Strategy

The safest migration pattern runs both Ingress and HTTPRoute in parallel, then gradually shifts traffic.

### Phase 1: Deploy HTTPRoutes Alongside Ingresses

Both resources can coexist because they use different controllers. The Ingress controller continues handling traffic while HTTPRoutes are configured and validated.

```bash
# Apply all generated HTTPRoutes (dry-run first)
./ingress-to-httproute.sh | kubectl apply --dry-run=server -f -

# Apply for real
./ingress-to-httproute.sh | kubectl apply -f -

# Validate all routes are accepted
./validate-httproutes.sh
```

### Phase 2: DNS Cutover with Low TTL

```bash
# Lower TTL 24 hours before cutover
# api.example.com -> ingress LB IP, TTL 300

# After cutover:
# api.example.com -> gateway LB IP, TTL 300

# Get gateway IP
GATEWAY_IP=$(kubectl get gateway prod-external \
  -n infrastructure \
  -o jsonpath='{.status.addresses[0].value}')

echo "New gateway IP: ${GATEWAY_IP}"
```

### Phase 3: Cleanup

```bash
# After traffic has fully shifted, annotate ingresses for deletion
kubectl annotate ingress -A --all \
  migration.example.com/status=migrated \
  migration.example.com/migrated-date=$(date +%Y-%m-%d)

# After 7-day validation window, delete
kubectl delete ingress -A --all \
  --field-selector 'metadata.annotations.migration\.example\.com/status=migrated'
```

## Section 10: HTTPRoute Observability

### Prometheus Metrics from Envoy Gateway

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: envoy-gateway-proxy
  namespace: monitoring
spec:
  namespaceSelector:
    matchNames:
      - envoy-gateway-system
  selector:
    matchLabels:
      app.kubernetes.io/component: proxy
  endpoints:
    - port: metrics
      interval: 15s
      path: /stats/prometheus
```

Key Envoy metrics to alert on:

```yaml
# PrometheusRule for Gateway API health
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: gateway-api-alerts
  namespace: monitoring
spec:
  groups:
    - name: gateway.httproute
      rules:
        - alert: GatewayHTTPRouteHighErrorRate
          expr: |
            sum by (namespace, name) (
              rate(envoy_cluster_upstream_rq_xx{envoy_response_code_class="5"}[5m])
            ) /
            sum by (namespace, name) (
              rate(envoy_cluster_upstream_rq_total[5m])
            ) > 0.05
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "HTTPRoute {{ $labels.name }} error rate > 5%"

        - alert: GatewayHighP99Latency
          expr: |
            histogram_quantile(0.99,
              sum by (le, envoy_virtual_host) (
                rate(envoy_http_downstream_rq_time_bucket[5m])
              )
            ) > 2000
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Gateway p99 latency > 2s for {{ $labels.envoy_virtual_host }}"
```

## Section 11: Policy Attachment

Gateway API's policy attachment mechanism lets platform teams apply cross-cutting concerns (timeouts, retries, rate limiting) independently of application teams' routing rules.

```yaml
# BackendLBPolicy — configure load balancing algorithm per backend
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: BackendLBPolicy
metadata:
  name: payment-api-lb
  namespace: production
spec:
  targetRef:
    group: ""
    kind: Service
    name: payment-api-svc
  sessionPersistence:
    sessionName: payment-session
    type: Cookie
    cookieConfig:
      lifetimeType: Session
---
# HTTPRoute timeout configuration (built into spec, no separate policy needed in v1)
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: payment-api-with-timeouts
  namespace: production
spec:
  parentRefs:
    - name: prod-external
      namespace: infrastructure
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /v1/payments
      timeouts:
        request: 30s
        backendRequest: 25s
      backendRefs:
        - name: payment-api-svc
          port: 8080
      retry:
        codes:
          - 500
          - 502
          - 503
        attempts: 3
        backoff: 250ms
```

## Summary

The Kubernetes Gateway API v1 provides a clean, expressive routing model that supersedes Ingress across every dimension. The persona-based separation of `GatewayClass`, `Gateway`, and `HTTPRoute` aligns with enterprise RBAC structures, while features like traffic splitting, request mirroring, URL rewriting, and cross-namespace `ReferenceGrant` eliminate the need for controller-specific annotations. Migration at scale is achievable through automated conversion scripts, parallel operation of both APIs during the transition period, and DNS-based cutover with short TTLs. The result is a routing configuration that is version-controlled, observable, and governed by Kubernetes RBAC rather than annotation conventions.
