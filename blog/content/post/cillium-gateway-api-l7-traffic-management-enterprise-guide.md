---
title: "Cilium Gateway API: L7 Traffic Management with eBPF"
date: 2027-02-06T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cilium", "Gateway API", "eBPF", "Networking"]
categories: ["Kubernetes", "Networking", "Cloud Native"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to implementing Kubernetes Gateway API with Cilium and eBPF, covering GatewayClass setup, HTTPRoute L7 routing, traffic mirroring, load balancing algorithms, mTLS, rate limiting, and migration from nginx-ingress."
more_link: "yes"
url: "/cilium-gateway-api-l7-traffic-management-enterprise-guide/"
---

Cilium's implementation of the Kubernetes **Gateway API** delivers Layer 7 traffic management through eBPF and the integrated Envoy proxy, providing a standards-compliant alternative to Ingress that supports richer routing semantics, cross-namespace policy, and native observability via Hubble. This guide covers everything from initial GatewayClass setup through advanced traffic mirroring, circuit breaking, and production migration from nginx-ingress.

<!--more-->

## Architecture Overview

The Cilium Gateway API implementation rests on three runtime components: the Cilium agent translating Gateway API objects into eBPF programs and Envoy configuration, the per-node Envoy proxy handling L7 inspection and manipulation, and Hubble providing flow-level telemetry throughout. Unlike ingress controllers that run as a separate Deployment, Cilium embeds the data-plane logic directly into each node, eliminating an extra network hop for in-cluster traffic.

### Key differences from nginx-ingress

| Feature | nginx-ingress | Cilium Gateway API |
|---|---|---|
| Data plane | nginx process (userspace) | eBPF + per-node Envoy |
| Routing standard | Ingress (v1) | Gateway API (v1, v1beta1) |
| Cross-namespace routing | Annotation hacks | ReferenceGrant |
| Traffic mirroring | nginx-plus only | HTTPRoute mirror filter |
| Load balancing | round-robin | round-robin, least-request, Maglev |
| mTLS origination | external cert-manager | Gateway TLS mode |
| Observability | access logs | Hubble L7 flows + Prometheus |

### Component interaction

```
Client → LB Service (NodePort / ExternalIP)
           ↓
    Cilium eBPF (TC/XDP) → Envoy listener
                              ↓
                    HTTPRoute match engine
                              ↓
                    Backend Service endpoints
                    (direct BPF forwarding)
```

## Installing Cilium with Gateway API Support

Gateway API requires Cilium 1.13 or later with the `gatewayAPI` feature flag and the upstream Gateway API CRDs installed first.

```bash
#!/bin/bash
# Install Gateway API CRDs (standard channel v1.1.0)
GWAPI_VERSION="v1.1.0"
kubectl apply -f "https://github.com/kubernetes-sigs/gateway-api/releases/download/${GWAPI_VERSION}/standard-install.yaml"
kubectl apply -f "https://github.com/kubernetes-sigs/gateway-api/releases/download/${GWAPI_VERSION}/experimental-install.yaml"

# Verify CRDs
kubectl get crd gateways.gateway.networking.k8s.io \
              httproutes.gateway.networking.k8s.io \
              grpcroutes.gateway.networking.k8s.io \
              tlsroutes.gateway.networking.k8s.io

CILIUM_VERSION="1.15.6"

helm upgrade --install cilium cilium/cilium \
  --version "${CILIUM_VERSION}" \
  --namespace kube-system \
  --set gatewayAPI.enabled=true \
  --set gatewayAPI.secretsNamespace.name=cilium-secrets \
  --set gatewayAPI.secretsNamespace.sync.enabled=true \
  --set envoy.enabled=true \
  --set l7Proxy=true \
  --set kubeProxyReplacement=true \
  --set hubble.enabled=true \
  --set hubble.relay.enabled=true \
  --set hubble.metrics.enableOpenMetrics=true \
  --set hubble.metrics.enabled="{dns,drop,tcp,flow,icmp,http}" \
  --set prometheus.enabled=true \
  --set operator.prometheus.enabled=true \
  --wait

cilium status --wait
```

## GatewayClass and Gateway Setup

**GatewayClass** is the cluster-scoped resource that declares Cilium as the implementation. A single GatewayClass serves all namespaces; individual teams then create namespace-scoped **Gateway** objects that request listener capacity.

```yaml
# GatewayClass — cluster-scoped, created once
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: cilium
spec:
  controllerName: io.cilium/gateway-controller
---
# Production gateway with HTTP and HTTPS listeners
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: production-gateway
  namespace: gateway-infra
  annotations:
    # Request a specific IP from MetalLB or cloud LB
    io.cilium/lb-ipam-pool: "production-pool"
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
              gateway-access: "allowed"
    - name: https
      protocol: HTTPS
      port: 443
      tls:
        mode: Terminate
        certificateRefs:
          - kind: Secret
            name: wildcard-tls
            namespace: gateway-infra
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              gateway-access: "allowed"
---
# ReferenceGrant: allow gateway-infra to read secrets in cert-store
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: gateway-secret-access
  namespace: cert-store
spec:
  from:
    - group: gateway.networking.k8s.io
      kind: Gateway
      namespace: gateway-infra
  to:
    - group: ""
      kind: Secret
```

Label application namespaces to grant route attachment:

```bash
kubectl label namespace app-team-a gateway-access=allowed
kubectl label namespace app-team-b gateway-access=allowed
```

## HTTPRoute: L7 Routing with Header Manipulation

**HTTPRoute** is the primary L7 routing object. Routes are evaluated in order of precedence: more-specific path matches beat less-specific ones, and exact beats prefix beats regex.

### Basic path and header routing

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-routing
  namespace: app-team-a
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-infra
      sectionName: https
  hostnames:
    - "api.example.com"
  rules:
    # Version routing via path prefix
    - matches:
        - path:
            type: PathPrefix
            value: /v2/
      backendRefs:
        - name: api-v2-svc
          port: 8080
          weight: 100

    # Canary routing via header
    - matches:
        - path:
            type: PathPrefix
            value: /v1/
          headers:
            - name: X-Canary
              value: "true"
      backendRefs:
        - name: api-canary-svc
          port: 8080

    # Default v1 traffic
    - matches:
        - path:
            type: PathPrefix
            value: /v1/
      backendRefs:
        - name: api-v1-svc
          port: 8080
```

### Request and response header manipulation

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: header-manipulation
  namespace: app-team-a
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-infra
  hostnames:
    - "app.example.com"
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      filters:
        # Add request headers before forwarding
        - type: RequestHeaderModifier
          requestHeaderModifier:
            add:
              - name: X-Forwarded-Proto
                value: https
              - name: X-Real-IP
                value: "{{ .ClientAddress }}"
            set:
              - name: Host
                value: internal-backend.app-team-a.svc.cluster.local
            remove:
              - X-Debug-Token
        # Add response headers
        - type: ResponseHeaderModifier
          responseHeaderModifier:
            add:
              - name: Strict-Transport-Security
                value: "max-age=63072000; includeSubDomains; preload"
              - name: X-Content-Type-Options
                value: nosniff
              - name: X-Frame-Options
                value: DENY
            remove:
              - Server
              - X-Powered-By
      backendRefs:
        - name: app-backend-svc
          port: 8080
```

### URL rewriting

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: url-rewrite
  namespace: app-team-a
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-infra
  hostnames:
    - "legacy.example.com"
  rules:
    # Strip /api/v1 prefix before forwarding
    - matches:
        - path:
            type: PathPrefix
            value: /api/v1
      filters:
        - type: URLRewrite
          urlRewrite:
            path:
              type: ReplacePrefixMatch
              replacePrefixMatch: /
      backendRefs:
        - name: new-api-svc
          port: 8080

    # Rewrite hostname to internal name
    - matches:
        - path:
            type: PathPrefix
            value: /static/
      filters:
        - type: URLRewrite
          urlRewrite:
            hostname: cdn-origin.app-team-a.svc.cluster.local
      backendRefs:
        - name: cdn-origin-svc
          port: 8080
```

## Traffic Mirroring

Traffic mirroring (shadowing) sends a copy of live requests to a shadow backend without affecting the primary response path. This is invaluable for testing new service versions against production traffic.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: shadow-testing
  namespace: app-team-a
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-infra
  hostnames:
    - "checkout.example.com"
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /checkout/
      filters:
        # Mirror 100% of traffic to v2 shadow
        - type: RequestMirror
          requestMirror:
            backendRef:
              name: checkout-v2-shadow-svc
              port: 8080
      backendRefs:
        # Production still served by v1
        - name: checkout-v1-svc
          port: 8080
          weight: 100
```

Mirror responses are discarded; the client always receives the primary backend response. Compare latency and error rates in Hubble before promoting the shadow to production.

## GRPCRoute Support

**GRPCRoute** (experimental in Gateway API v1.1) routes gRPC traffic based on service and method names without requiring HTTP path tricks.

```yaml
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: GRPCRoute
metadata:
  name: grpc-routing
  namespace: grpc-services
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-infra
      sectionName: https
  hostnames:
    - "grpc.example.com"
  rules:
    # Route UserService to v2 backend
    - matches:
        - method:
            type: Exact
            service: "com.example.UserService"
            method: "GetUser"
      backendRefs:
        - name: user-service-v2
          port: 50051

    # Route all OrderService traffic
    - matches:
        - method:
            type: Exact
            service: "com.example.OrderService"
      backendRefs:
        - name: order-service
          port: 50051

    # Catch-all for remaining gRPC
    - backendRefs:
        - name: grpc-default-svc
          port: 50051
```

## TLSRoute for Passthrough

**TLSRoute** forwards TLS connections without termination, allowing backends to manage their own certificates. This is useful for database proxies and services requiring end-to-end mTLS.

```yaml
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: TLSRoute
metadata:
  name: database-passthrough
  namespace: data-plane
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-infra
      sectionName: tls-passthrough
  hostnames:
    - "postgres.example.com"
    - "mysql.example.com"
  rules:
    - backendRefs:
        - name: postgres-primary-svc
          port: 5432
---
# Gateway listener for TLS passthrough
# Add to the production-gateway listeners list
# - name: tls-passthrough
#   protocol: TLS
#   port: 5432
#   tls:
#     mode: Passthrough
#   allowedRoutes:
#     namespaces:
#       from: Selector
#       selector:
#         matchLabels:
#           gateway-access: "allowed"
```

## Load Balancing Algorithms

Cilium exposes per-service load balancing policy through **CiliumLoadBalancingPolicy** (experimental) or via `CiliumEnvoyConfig` for fine-grained Envoy upstream configuration.

### Least-request load balancing

```yaml
apiVersion: cilium.io/v2alpha1
kind: CiliumLoadBalancingPolicy
metadata:
  name: api-least-request
  namespace: app-team-a
spec:
  endpointSelector:
    matchLabels:
      app: api-backend
  frontends:
    - port: 8080
  algorithm: least_request
  leastRequest:
    choiceCount: 2
---
# Maglev consistent hashing for session affinity
apiVersion: cilium.io/v2alpha1
kind: CiliumLoadBalancingPolicy
metadata:
  name: session-affinity-maglev
  namespace: app-team-a
spec:
  endpointSelector:
    matchLabels:
      app: stateful-app
  frontends:
    - port: 8080
  algorithm: maglev
```

### EnvoyFilter for circuit breaking

**CiliumEnvoyConfig** injects raw Envoy xDS configuration, enabling features not yet surfaced as Gateway API extensions.

```yaml
apiVersion: cilium.io/v2
kind: CiliumEnvoyConfig
metadata:
  name: circuit-breaker-api
  namespace: app-team-a
spec:
  services:
    - name: api-backend-svc
      namespace: app-team-a
  resources:
    - "@type": type.googleapis.com/envoy.config.cluster.v3.Cluster
      name: app-team-a/api-backend-svc/8080
      connect_timeout: 5s
      circuit_breakers:
        thresholds:
          - priority: DEFAULT
            max_connections: 1000
            max_pending_requests: 500
            max_requests: 2000
            max_retries: 3
            track_remaining: true
          - priority: HIGH
            max_connections: 2000
            max_pending_requests: 1000
            max_requests: 4000
      outlier_detection:
        consecutive_5xx: 5
        consecutive_gateway_failure: 5
        interval: 10s
        base_ejection_time: 30s
        max_ejection_percent: 50
        enforcing_consecutive_5xx: 100
        enforcing_success_rate: 100
        success_rate_minimum_hosts: 5
        success_rate_request_volume: 100
        success_rate_stdev_factor: 1900
```

## Mutual TLS via Gateway

For service-to-service mTLS, configure the Gateway to present a client certificate when forwarding to backends, and require the backend to present a valid certificate.

```yaml
# BackendTLSPolicy (Gateway API experimental)
apiVersion: gateway.networking.k8s.io/v1alpha3
kind: BackendTLSPolicy
metadata:
  name: backend-mtls
  namespace: app-team-a
spec:
  targetRefs:
    - group: ""
      kind: Service
      name: api-backend-svc
  validation:
    caCertificateRefs:
      - kind: ConfigMap
        name: backend-ca-cert
    hostname: api-backend.app-team-a.svc.cluster.local
---
# ConfigMap holding the backend CA certificate
apiVersion: v1
kind: ConfigMap
metadata:
  name: backend-ca-cert
  namespace: app-team-a
data:
  ca.crt: |
    -----BEGIN CERTIFICATE-----
    MIIBwTCCAWagAwIBAgIRAIbRHZr3N5MeKMJJkXsIbfQwCgYIKoZIzj0EAwIwITEf
    MB0GA1UEAxMWaW50ZXJuYWwtY2EuZXhhbXBsZS5jb20wHhcNMjQwMTAxMDAwMDAw
    WhcNMjUwMTAxMDAwMDAwWjAhMR8wHQYDVQQDExZpbnRlcm5hbC1jYS5leGFtcGxl
    LmNvbTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABExamplePublicKeyDataHere
    ExamplePublicKeyDataHereExamplePublicKeyDataHereExABCD1234o0IwIDAQAB
    o0IwIDAOBgNVHQ8BAf8EBAMCAQYwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQU
    ExampleIssuerIDHere1234567890ABCDEFwCgYIKoZIzj0EAwIDSAAwRQIhAMexam
    pleSignatureHereForDemoOnlyNotRealCertABCDEFGHIJKLMNOPQRST==
    -----END CERTIFICATE-----
```

## Rate Limiting

Cilium implements rate limiting through **CiliumLocalRedirectPolicy** combined with Envoy local rate limit filters, or via the `CiliumEnvoyConfig` HTTP filter chain.

```yaml
apiVersion: cilium.io/v2
kind: CiliumEnvoyConfig
metadata:
  name: rate-limit-api
  namespace: app-team-a
spec:
  services:
    - name: api-gateway-svc
      namespace: gateway-infra
  resources:
    - "@type": type.googleapis.com/envoy.config.listener.v3.Listener
      name: rate-limit-listener
      filter_chains:
        - filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                http_filters:
                  - name: envoy.filters.http.local_ratelimit
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.local_ratelimit.v3.LocalRateLimit
                      stat_prefix: api_rate_limit
                      token_bucket:
                        max_tokens: 1000
                        tokens_per_fill: 1000
                        fill_interval: 1s
                      filter_enabled:
                        runtime_key: local_rate_limit_enabled
                        default_value:
                          numerator: 100
                          denominator: HUNDRED
                      filter_enforced:
                        runtime_key: local_rate_limit_enforced
                        default_value:
                          numerator: 100
                          denominator: HUNDRED
                      response_headers_to_add:
                        - append_action: OVERWRITE_IF_EXISTS_OR_ADD
                          header:
                            key: X-RateLimit-Limit
                            value: "1000"
                  - name: envoy.filters.http.router
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
```

## CORS Configuration

Cross-Origin Resource Sharing headers can be injected via HTTPRoute response header modification or through an Envoy CORS filter.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: cors-api
  namespace: app-team-a
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-infra
  hostnames:
    - "api.example.com"
  rules:
    - matches:
        - method: OPTIONS
          path:
            type: PathPrefix
            value: /
      filters:
        - type: ResponseHeaderModifier
          responseHeaderModifier:
            add:
              - name: Access-Control-Allow-Origin
                value: "https://app.example.com"
              - name: Access-Control-Allow-Methods
                value: "GET, POST, PUT, DELETE, OPTIONS"
              - name: Access-Control-Allow-Headers
                value: "Content-Type, Authorization, X-Request-ID"
              - name: Access-Control-Max-Age
                value: "86400"
      backendRefs:
        - name: api-backend-svc
          port: 8080
    - matches:
        - path:
            type: PathPrefix
            value: /
      filters:
        - type: ResponseHeaderModifier
          responseHeaderModifier:
            add:
              - name: Access-Control-Allow-Origin
                value: "https://app.example.com"
              - name: Vary
                value: Origin
      backendRefs:
        - name: api-backend-svc
          port: 8080
```

## WebSocket Support

WebSocket upgrades work transparently through Cilium Gateway since Envoy handles the HTTP/1.1 Upgrade handshake natively. The only required configuration is ensuring connection timeouts are generous enough to accommodate long-lived connections.

```yaml
apiVersion: cilium.io/v2
kind: CiliumEnvoyConfig
metadata:
  name: websocket-timeouts
  namespace: app-team-a
spec:
  services:
    - name: ws-backend-svc
      namespace: app-team-a
  resources:
    - "@type": type.googleapis.com/envoy.config.route.v3.RouteConfiguration
      name: ws-route-config
      virtual_hosts:
        - name: ws-backend
          domains:
            - "ws.example.com"
          routes:
            - match:
                prefix: /socket.io/
                headers:
                  - name: Upgrade
                    string_match:
                      exact: websocket
              route:
                cluster: app-team-a/ws-backend-svc/8080
                timeout: 0s
                idle_timeout: 3600s
                upgrade_configs:
                  - upgrade_type: websocket
```

## Monitoring with Hubble and Prometheus

### Hubble L7 flow inspection

```bash
# Watch HTTP flows for a specific service
hubble observe \
  --namespace app-team-a \
  --label "app=api-backend" \
  --protocol http \
  --follow

# Filter on HTTP status codes to spot errors
hubble observe \
  --namespace app-team-a \
  --http-status-code 5xx \
  --follow \
  --output json | jq '{
    src: .source.namespace + "/" + .source.pod_name,
    dst: .destination.namespace + "/" + .destination.pod_name,
    url: .l7.http.url,
    status: .l7.http.code,
    latency_ms: (.l7.latency_ns / 1000000)
  }'

# Check dropped traffic
hubble observe \
  --verdict DROPPED \
  --follow

# Per-service request rate (last 60s)
hubble observe \
  --namespace app-team-a \
  --since 60s \
  --protocol http \
  --output json \
  | jq -r '.destination.pod_name' \
  | sort | uniq -c | sort -rn
```

### Prometheus metrics and alerting

```yaml
# ServiceMonitor for Gateway API metrics
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: cilium-gateway-metrics
  namespace: monitoring
spec:
  selector:
    matchLabels:
      k8s-app: cilium
  namespaceSelector:
    matchNames:
      - kube-system
  endpoints:
    - port: metrics
      interval: 15s
      path: /metrics
      relabelings:
        - sourceLabels: [__meta_kubernetes_pod_node_name]
          targetLabel: node
---
# PrometheusRule for Gateway API SLOs
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: gateway-api-slos
  namespace: monitoring
spec:
  groups:
    - name: gateway-api-availability
      interval: 30s
      rules:
        - alert: GatewayHighErrorRate
          expr: |
            (
              sum(rate(hubble_http_requests_total{verdict="DROPPED"}[5m]))
              /
              sum(rate(hubble_http_requests_total[5m]))
            ) > 0.01
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Gateway error rate above 1%"
            description: "HTTP error rate is {{ $value | humanizePercentage }} over last 5m"

        - alert: GatewayHighLatencyP99
          expr: |
            histogram_quantile(0.99,
              sum(rate(hubble_http_request_duration_seconds_bucket[5m])) by (le, destination)
            ) > 1.0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Gateway p99 latency above 1s for {{ $labels.destination }}"

        - alert: GatewayBackendDown
          expr: |
            count(cilium_endpoint_state{endpoint_state="ready"} == 0) by (pod)
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Backend endpoint not ready: {{ $labels.pod }}"
```

### Grafana dashboard key panels

Track these metrics for Gateway API health:

```promql
# Request rate by HTTPRoute
sum(rate(hubble_http_requests_total[5m])) by (destination_namespace, destination_workload)

# Error rate
sum(rate(hubble_http_requests_total{verdict="DROPPED"}[5m])) by (destination)
/ sum(rate(hubble_http_requests_total[5m])) by (destination)

# p50/p95/p99 latency
histogram_quantile(0.99, sum(rate(hubble_http_request_duration_seconds_bucket[5m])) by (le, destination_workload))

# Active connections per backend
sum(cilium_forward_count_total) by (direction)
```

## Migration from nginx-ingress

A phased migration reduces risk by running both controllers in parallel before cutting over DNS.

### Phase 1: Parallel installation

```bash
# Verify both controllers are running
kubectl get pods -n ingress-nginx
kubectl get pods -n kube-system -l k8s-app=cilium-envoy

# Create a Gateway matching the nginx LoadBalancer IP
NGINX_IP=$(kubectl -n ingress-nginx get svc ingress-nginx-controller \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}')

kubectl annotate gateway production-gateway \
  -n gateway-infra \
  io.cilium/lb-ipam-sharing-key="nginx-migration" \
  --overwrite
```

### Phase 2: Translate Ingress to HTTPRoute

```bash
#!/bin/bash
# Script to convert a simple nginx Ingress to HTTPRoute
# Requires: kubectl, yq

NAMESPACE=${1:-default}
INGRESS_NAME=${2}

if [[ -z "${INGRESS_NAME}" ]]; then
  echo "Usage: $0 <namespace> <ingress-name>"
  exit 1
fi

# Extract ingress spec
INGRESS_JSON=$(kubectl -n "${NAMESPACE}" get ingress "${INGRESS_NAME}" -o json)

HOST=$(echo "${INGRESS_JSON}" | jq -r '.spec.rules[0].host')
PATHS=$(echo "${INGRESS_JSON}" | jq -c '.spec.rules[0].http.paths[]')

cat > "/tmp/${INGRESS_NAME}-httproute.yaml" <<EOF
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: ${INGRESS_NAME}
  namespace: ${NAMESPACE}
spec:
  parentRefs:
    - name: production-gateway
      namespace: gateway-infra
  hostnames:
    - "${HOST}"
  rules:
EOF

while IFS= read -r path_entry; do
  path_value=$(echo "${path_entry}" | jq -r '.path')
  svc_name=$(echo "${path_entry}"  | jq -r '.backend.service.name')
  svc_port=$(echo "${path_entry}"  | jq -r '.backend.service.port.number')

  cat >> "/tmp/${INGRESS_NAME}-httproute.yaml" <<EOF
    - matches:
        - path:
            type: PathPrefix
            value: "${path_value}"
      backendRefs:
        - name: ${svc_name}
          port: ${svc_port}
EOF
done <<< "${PATHS}"

echo "Generated /tmp/${INGRESS_NAME}-httproute.yaml"
cat "/tmp/${INGRESS_NAME}-httproute.yaml"
```

### Phase 3: Shadow validation and cutover

```bash
# Apply the HTTPRoute while nginx still handles production traffic
kubectl apply -f "/tmp/${INGRESS_NAME}-httproute.yaml"

# Test using the Cilium Gateway IP directly
GATEWAY_IP=$(kubectl -n gateway-infra get gateway production-gateway \
  -o jsonpath='{.status.addresses[0].value}')

curl -H "Host: api.example.com" \
     "http://${GATEWAY_IP}/v1/health"

# When satisfied, delete the old Ingress
kubectl delete ingress -n "${NAMESPACE}" "${INGRESS_NAME}"

# After all migrations complete, remove nginx-ingress
helm uninstall ingress-nginx -n ingress-nginx
```

## Troubleshooting

### Common issues and resolutions

```bash
# Check Gateway status and conditions
kubectl -n gateway-infra describe gateway production-gateway

# Look for unresolved certificate references
kubectl -n gateway-infra get gateway production-gateway \
  -o jsonpath='{.status.conditions}' | jq .

# Check HTTPRoute parent status
kubectl -n app-team-a describe httproute api-routing

# Verify Envoy is receiving xDS updates
kubectl -n kube-system exec -it ds/cilium -- \
  cilium envoy admin /config_dump | jq '.configs[] | select(.["@type"] | contains("ListenersConfigDump"))'

# Check Hubble for dropped traffic with reason
hubble observe \
  --verdict DROPPED \
  --namespace app-team-a \
  --follow \
  --output json | jq '{
    src: .source.pod_name,
    dst: .destination.pod_name,
    reason: .drop_reason_desc
  }'

# Validate ReferenceGrant is allowing cross-namespace secret access
kubectl -n cert-store describe referencegrant gateway-secret-access

# Force Cilium to re-reconcile a Gateway
kubectl -n gateway-infra annotate gateway production-gateway \
  cilium.io/reconcile="$(date +%s)" \
  --overwrite

# Dump Cilium endpoint map for a specific pod
CILIUM_POD=$(kubectl -n kube-system get pods -l k8s-app=cilium \
  --field-selector spec.nodeName=$(kubectl get pod -n app-team-a api-backend-xxx -o jsonpath='{.spec.nodeName}') \
  -o name | head -1)

kubectl -n kube-system exec "${CILIUM_POD}" -- \
  cilium endpoint list
```

### Known limitations

- **HTTPRoute regex path matching** requires the experimental channel CRDs (`experimental-install.yaml`).
- **TLSRoute passthrough** requires a separate Gateway listener using `protocol: TLS` with `mode: Passthrough`.
- **GRPCRoute** is still experimental in Gateway API v1.1; production use requires the experimental CRDs and Cilium 1.15+.
- **CiliumLoadBalancingPolicy** for per-service algorithm selection is alpha and may change between Cilium minor versions.
- **CiliumEnvoyConfig** changes take effect on the next reconciliation cycle (typically under 5 seconds); use `cilium monitor` to confirm Envoy is receiving updated configuration.

## Production Checklist

Before routing production traffic through a Cilium Gateway, verify each of the following:

```bash
# 1. Gateway reports Accepted and Programmed conditions
kubectl -n gateway-infra get gateway production-gateway \
  -o jsonpath='{.status.conditions[*].type}' | tr ' ' '\n'
# Expected: Accepted Programmed

# 2. All backend Services have at least one Ready endpoint
kubectl -n app-team-a get endpoints api-backend-svc

# 3. TLS certificate is valid and not expiring within 30 days
kubectl -n gateway-infra get secret wildcard-tls \
  -o jsonpath='{.data.tls\.crt}' | base64 -d \
  | openssl x509 -noout -dates

# 4. Hubble is collecting L7 metrics
curl -s http://localhost:9091/metrics | grep hubble_http

# 5. PrometheusRules are loaded
kubectl -n monitoring get prometheusrule gateway-api-slos

# 6. PodDisruptionBudget protects backend deployments
kubectl -n app-team-a get pdb
```

The Cilium Gateway API implementation provides a production-grade, standards-compliant L7 traffic management layer backed by the performance of eBPF. Combined with Hubble observability and native Prometheus integration, it offers full visibility into application traffic without the operational overhead of a separate ingress controller.
