---
title: "Kubernetes Gateway API with Envoy: EnvoyProxy CRD, BackendTrafficPolicy, and SecurityPolicy Implementation"
date: 2032-02-02T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Gateway API", "Envoy", "EnvoyGateway", "Security", "Networking", "Ingress"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Production implementation guide for Kubernetes Gateway API with Envoy Gateway. Covers GatewayClass, Gateway, HTTPRoute, EnvoyProxy CRD for custom Envoy configuration, BackendTrafficPolicy for circuit breaking and retries, SecurityPolicy for JWT/OAuth2 and IP allow/deny, and TLSPolicy for certificate management."
more_link: "yes"
url: "/kubernetes-gateway-api-envoy-proxy-backend-traffic-security-policy/"
---

The Kubernetes Gateway API (GA in v1.0) supersedes the Ingress resource with a role-oriented, expressive API for routing, TLS, and traffic management. Envoy Gateway (the CNCF project) implements Gateway API using Envoy Proxy as the data plane. Its Extended API — EnvoyProxy CRD, BackendTrafficPolicy, SecurityPolicy, TLSPolicy, and ClientTrafficPolicy — provides enterprise-grade traffic management without requiring custom Envoy configuration.

<!--more-->

# Kubernetes Gateway API with Envoy: Production Guide

## Gateway API Architecture

The Gateway API separates concerns across three personas:

```
Infrastructure Provider: defines GatewayClass (cluster-wide)
Cluster Operator: creates Gateway (namespace-level or cluster-level)
Application Developer: creates HTTPRoute, GRPCRoute, TCPRoute (namespace-level)
```

```
GatewayClass (cluster-scoped)
  └── Gateway (defines listeners: ports, protocols, TLS)
        └── HTTPRoute (routing rules: paths, headers, methods)
              └── Backend Services
```

## Envoy Gateway Installation

```bash
# Install Envoy Gateway with Helm
helm install eg oci://docker.io/envoyproxy/gateway-helm \
  --version v1.2.0 \
  --namespace envoy-gateway-system \
  --create-namespace \
  --set config.envoyGateway.provider.type=Kubernetes \
  --set config.envoyGateway.gateway.controllerName=gateway.envoyproxy.io/gatewayclass-controller

# Verify installation
kubectl get pods -n envoy-gateway-system
# NAME                                   READY   STATUS    RESTARTS   AGE
# envoy-gateway-5d9f8b4c7-xxxxx          1/1     Running   0          30s

# Install Gateway API CRDs (if not already installed)
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/standard-install.yaml
# Plus experimental CRDs for GRPCRoute, TCPRoute:
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/experimental-install.yaml
```

## GatewayClass and Gateway

```yaml
# GatewayClass: references Envoy Gateway controller
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: envoy
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
  parametersRef:
    group: gateway.envoyproxy.io
    kind: EnvoyProxy
    name: production-proxy-config
    namespace: envoy-gateway-system
---
# Gateway: defines what ports/protocols to listen on
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: production-gateway
  namespace: production
spec:
  gatewayClassName: envoy
  listeners:
  - name: http
    protocol: HTTP
    port: 80
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchLabels:
            gateway-allowed: "true"
  - name: https
    protocol: HTTPS
    port: 443
    tls:
      mode: Terminate
      certificateRefs:
      - kind: Secret
        name: production-tls-cert
        namespace: production
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchLabels:
            gateway-allowed: "true"
  - name: grpc
    protocol: HTTPS
    port: 8443
    tls:
      mode: Terminate
      certificateRefs:
      - kind: Secret
        name: production-tls-cert
    allowedRoutes:
      namespaces:
        from: Same
```

## EnvoyProxy CRD: Custom Envoy Configuration

The `EnvoyProxy` CRD customizes the Envoy deployment created by Envoy Gateway:

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: production-proxy-config
  namespace: envoy-gateway-system
spec:
  # Kubernetes-specific deployment configuration
  provider:
    type: Kubernetes
    kubernetes:
      envoyDeployment:
        replicas: 3
        strategy:
          type: RollingUpdate
          rollingUpdate:
            maxSurge: 1
            maxUnavailable: 0
        pod:
          affinity:
            podAntiAffinity:
              requiredDuringSchedulingIgnoredDuringExecution:
              - labelSelector:
                  matchLabels:
                    app.kubernetes.io/component: proxy
                topologyKey: kubernetes.io/hostname
          tolerations:
          - key: node-role/gateway
            operator: Exists
          topologySpreadConstraints:
          - maxSkew: 1
            topologyKey: topology.kubernetes.io/zone
            whenUnsatisfiable: DoNotSchedule
            labelSelector:
              matchLabels:
                app.kubernetes.io/component: proxy
          securityContext:
            runAsNonRoot: true
            runAsUser: 65534
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
            limits:
              cpu: 2000m
              memory: 1Gi
          annotations:
            prometheus.io/scrape: "true"
            prometheus.io/port: "19001"
        container:
          env:
          - name: GOGC
            value: "80"
      envoyService:
        type: LoadBalancer
        annotations:
          service.beta.kubernetes.io/aws-load-balancer-type: "external"
          service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: "ip"
          service.beta.kubernetes.io/aws-load-balancer-scheme: "internet-facing"
          service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "true"

  # Envoy-specific configuration
  logging:
    level:
      default: warn
      upstream: warn
      connection: warn
      admin: warn

  # Telemetry: metrics, access logging, tracing
  telemetry:
    metrics:
      prometheus:
        disable: false
      sinks:
      - type: OpenTelemetry
        openTelemetry:
          backendRefs:
          - name: otel-collector
            namespace: monitoring
            port: 4317
    accessLog:
      settings:
      - format:
          type: JSON
          json:
            start_time: "%START_TIME%"
            method: "%REQ(:METHOD)%"
            path: "%REQ(X-ENVOY-ORIGINAL-PATH?:PATH)%"
            status: "%RESPONSE_CODE%"
            duration: "%DURATION%"
            upstream_host: "%UPSTREAM_HOST%"
            request_id: "%REQ(X-REQUEST-ID)%"
            trace_id: "%REQ(X-B3-TRACEID)%"
        sinks:
        - type: File
          file:
            path: /dev/stdout
        - type: OpenTelemetry
          openTelemetry:
            backendRefs:
            - name: otel-collector
              namespace: monitoring
              port: 4317
    tracing:
      samplingRate: 5  # 5% sampling rate
      provider:
        host: otel-collector.monitoring
        port: 4317
        type: OpenTelemetry
      customTags:
        cluster_name:
          type: Environment
          environment:
            name: CLUSTER_NAME
            defaultValue: "unknown"

  # Pass custom Envoy bootstrap config
  bootstrap:
    type: Merge
    value: |
      admin:
        access_log:
          - name: envoy.access_loggers.file
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.access_loggers.file.v3.FileAccessLog
              path: /dev/null
        address:
          socket_address:
            address: 127.0.0.1
            port_value: 19000
      layered_runtime:
        layers:
          - name: runtime-0
            rtds_layer:
              rtds_config:
                resource_api_version: V3
                api_config_source:
                  api_type: GRPC
                  transport_api_version: V3
                  grpc_services:
                    envoy_grpc:
                      cluster_name: xds_cluster
              name: runtime-0
```

## HTTPRoute: Request Routing

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-routes
  namespace: production
spec:
  parentRefs:
  - name: production-gateway
    namespace: production
    sectionName: https
  hostnames:
  - "api.example.com"
  rules:
  # Route by path prefix
  - matches:
    - path:
        type: PathPrefix
        value: /v1/users
    backendRefs:
    - name: user-service
      port: 8080
      weight: 100
    filters:
    - type: RequestHeaderModifier
      requestHeaderModifier:
        add:
        - name: X-Service
          value: user-service
        remove:
        - Authorization  # Strip before forwarding (JWT validated at gateway)

  # Route by path + method
  - matches:
    - path:
        type: PathPrefix
        value: /v1/orders
      method: GET
    - path:
        type: PathPrefix
        value: /v1/orders
      method: POST
    backendRefs:
    - name: order-service
      port: 8080

  # Header-based routing (A/B test)
  - matches:
    - headers:
      - name: X-Canary
        value: "true"
    backendRefs:
    - name: api-canary
      port: 8080

  # Traffic split (weighted routing)
  - matches:
    - path:
        type: PathPrefix
        value: /v2/
    backendRefs:
    - name: api-v2-stable
      port: 8080
      weight: 90
    - name: api-v2-canary
      port: 8080
      weight: 10

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

  # URL rewrite
  - matches:
    - path:
        type: PathPrefix
        value: /legacy/api
    filters:
    - type: URLRewrite
      urlRewrite:
        path:
          type: ReplacePrefixMatch
          replacePrefixMatch: /v1
    backendRefs:
    - name: api-service
      port: 8080
```

## BackendTrafficPolicy: Circuit Breaking and Retries

The `BackendTrafficPolicy` CRD (Envoy Gateway extension) applies traffic management policies to backend services:

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendTrafficPolicy
metadata:
  name: api-service-traffic-policy
  namespace: production
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: api-routes
    namespace: production

  # Circuit breaker configuration
  circuitBreaker:
    maxConnections: 1024
    maxPendingRequests: 64
    maxParallelRequests: 1024
    maxParallelRetries: 4
    maxRequestsPerConnection: 1000

  # Retry policy
  retry:
    numRetries: 3
    retryOn:
    - "5xx"
    - "reset"
    - "connect-failure"
    - "retriable-4xx"  # 429 Too Many Requests
    perRetry:
      timeout: "5s"
      backOff:
        baseInterval: "100ms"
        maxInterval: "2s"
    # Retry host predicate: don't retry on same host
    retryHostPredicate:
    - name: envoy.retry_host_predicates.previous_hosts
    hostSelectionRetryMaxAttempts: 3

  # Timeout configuration
  timeout:
    http:
      requestTimeout: "30s"
      connectionIdleTimeout: "300s"
      maxConnectionDuration: "0s"  # 0 = unlimited
    tcp:
      connectTimeout: "10s"

  # Load balancing
  loadBalancer:
    type: LeastRequest
    leastRequest:
      slowStartConfig:
        window: "30s"
        aggression: "1.0"
        minWeightPercent: 10

  # Connection health checking (active health check)
  healthCheck:
    active:
      timeout: "5s"
      interval: "10s"
      unhealthyThreshold: 3
      healthyThreshold: 2
      type: HTTP
      http:
        path: "/healthz"
        method: "GET"
        expectedStatuses:
        - start: 200
          end: 299
    passive:
      baseEjectionTime: "30s"
      interval: "10s"
      maxEjectionPercent: 50
      consecutive5xxErrors: 5
      consecutiveGatewayErrors: 5
      consecutiveLocalOriginFailures: 5
      splitExternalLocalOriginErrors: false

  # Proxy protocol for upstream
  proxyProtocol:
    version: V2
```

### BackendTrafficPolicy for gRPC

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendTrafficPolicy
metadata:
  name: grpc-service-policy
  namespace: production
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: GRPCRoute
    name: grpc-routes
  retry:
    numRetries: 2
    retryOn:
    - "5xx"
    - "reset"
    - "cancelled"
    - "unavailable"
    - "resource-exhausted"
    perRetry:
      timeout: "10s"
  timeout:
    http:
      requestTimeout: "60s"  # Long for streaming RPCs
  circuitBreaker:
    maxConnections: 512
    maxParallelRequests: 256
```

## SecurityPolicy: JWT, OAuth2, and IP Filtering

The `SecurityPolicy` CRD handles authentication and authorization at the gateway:

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata:
  name: api-security-policy
  namespace: production
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: api-routes

  # JWT authentication
  jwt:
    providers:
    - name: auth0
      issuer: "https://mycompany.auth0.com/"
      audiences:
      - "api.example.com"
      remoteJWKS:
        uri: "https://mycompany.auth0.com/.well-known/jwks.json"
        cacheDuration: "5m"
      claimToHeaders:
      - claim: sub
        header: X-User-ID
      - claim: "https://mycompany.com/tenant_id"
        header: X-Tenant-ID
      - claim: scope
        header: X-Token-Scopes
      extractFrom:
        headers:
        - name: Authorization
          valuePrefix: "Bearer "
        cookies:
        - name: access_token
      # Optional: re-validate on every request (default: cache validation)
    - name: internal-auth
      issuer: "https://internal-auth.cluster.local/"
      audiences:
      - "internal-api"
      localJWKS:
        inline: |
          {
            "keys": [
              {
                "kty": "EC",
                "crv": "P-256",
                "x": "<public-key-x>",
                "y": "<public-key-y>",
                "kid": "internal-key-1",
                "use": "sig"
              }
            ]
          }

  # OIDC (OAuth2 Code Flow) for browser clients
  oidc:
    provider:
      issuer: "https://mycompany.auth0.com/"
      # JWKS inferred from issuer /.well-known/openid-configuration
    clientID: "<oauth2-client-id>"
    clientSecret:
      name: oidc-client-secret
      namespace: production
    scopes:
    - openid
    - profile
    - email
    - "api:read"
    redirectURL: "https://app.example.com/oauth2/callback"
    logoutPath: "/logout"
    forwardAccessToken: true
    defaultTokenTTL: "1h"
    cookieSuffix: "production"

  # Basic auth (for admin endpoints)
  basicAuth:
    users:
      name: basic-auth-users  # Secret with .htpasswd format

  # IP allow/deny (CORS-style IP filtering)
  authorization:
    defaultAction: Deny
    rules:
    # Allow internal networks
    - action: Allow
      principal:
        clientCIDRs:
        - "10.0.0.0/8"
        - "172.16.0.0/12"
        - "192.168.0.0/16"
    # Allow specific external IPs (office, CI)
    - action: Allow
      principal:
        clientCIDRs:
        - "203.0.113.0/24"  # Office CIDR
        - "198.51.100.50/32"  # CI IP
    # Explicitly deny known bad actors
    - action: Deny
      principal:
        clientCIDRs:
        - "192.0.2.0/24"  # Bad actor range

  # CORS policy
  cors:
    allowOrigins:
    - type: RegularExpression
      value: "https://.*\\.example\\.com"
    - type: Exact
      value: "https://app.example.com"
    allowMethods:
    - GET
    - POST
    - PUT
    - DELETE
    - OPTIONS
    allowHeaders:
    - Content-Type
    - Authorization
    - X-Requested-With
    - X-Request-ID
    exposeHeaders:
    - X-Request-ID
    - X-Rate-Limit-Remaining
    maxAge: 86400
    allowCredentials: true

  # ExtAuth: delegate auth to an external service
  extAuth:
    grpc:
      backendRefs:
      - name: auth-service
        namespace: production
        port: 9001
    headersToExtAuth:
    - Authorization
    - X-API-Key
    - Cookie
    headersToBackend:
    - X-User-ID
    - X-Tenant-ID
    - X-User-Roles
    failOpen: false  # Deny if auth service is unavailable
```

## TLSPolicy: Certificate Management

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: TLSPolicy
metadata:
  name: production-tls-policy
  namespace: production
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: Gateway
    name: production-gateway
    sectionName: https

  # TLS configuration
  config:
    minVersion: "1.2"
    maxVersion: "1.3"
    ciphers:
    # TLS 1.2 ciphers (TLS 1.3 has fixed ciphersuites)
    - TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256
    - TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384
    - TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256
    - TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384
    ecdhCurves:
    - P-256
    - P-384
    - X25519
    signatureAlgorithms:
    - RSA-PSS-RSAE-SHA256
    - ECDSA-SECP256R1-SHA256
    - RSA-PKCS1-SHA256
    alpnProtocols:
    - h2
    - http/1.1
    clientValidation:
      optional: false
      caCertificateRefs:
      - kind: ConfigMap
        name: client-ca-cert
        namespace: production
```

## ClientTrafficPolicy: Inbound Connection Settings

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: ClientTrafficPolicy
metadata:
  name: production-client-policy
  namespace: production
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: Gateway
    name: production-gateway

  # TCP settings for client connections
  connection:
    connectionLimit:
      value: 50000
    socketBufferLimitBytes: 1048576  # 1MB

  # HTTP settings
  http:
    preserveXForwardedFor: false  # Override XFF header
    xForwardedForNumTrustedHops: 2
    enableTrailers: false
    # HTTP/1.1 settings
    http1:
      enableTrailers: false
      preserveHeaderCase: false
    # HTTP/2 settings
    http2:
      initialStreamWindowSize: 65536
      initialConnectionWindowSize: 1048576
      maxConcurrentStreams: 1000

  # Path normalization
  path:
    disableMergeSlashes: false
    escapeDoubleSlash: true

  # Header settings
  headers:
    enableEnvoyHeaders: false
    withUnderscoresAction: RejectRequest

  # Client timeout
  timeout:
    http:
      requestReceivedTimeout: "10s"  # Time to receive full request headers

  # Health check endpoint (respond directly without upstream)
  healthCheck:
    path: /healthz

  # PROXY protocol support from load balancers
  enableProxyProtocol: true
```

## Advanced HTTPRoute: Header Transformation

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: advanced-routes
  namespace: production
spec:
  parentRefs:
  - name: production-gateway
    sectionName: https
  hostnames:
  - "api.example.com"
  rules:
  # Mirror traffic to analytics service
  - matches:
    - path:
        type: PathPrefix
        value: /v1/events
    filters:
    - type: RequestMirror
      requestMirror:
        backendRef:
          name: analytics-service
          port: 8080
        percent: 100  # Mirror 100% of traffic
    backendRefs:
    - name: event-service
      port: 8080

  # Response header manipulation
  - matches:
    - path:
        type: PathPrefix
        value: /v1/public
    filters:
    - type: ResponseHeaderModifier
      responseHeaderModifier:
        add:
        - name: Cache-Control
          value: "public, max-age=300"
        - name: X-Content-Type-Options
          value: nosniff
        - name: X-Frame-Options
          value: DENY
        - name: X-XSS-Protection
          value: "1; mode=block"
        remove:
        - Server
        - X-Powered-By
    backendRefs:
    - name: public-api
      port: 8080
```

## GRPCRoute

```yaml
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: GRPCRoute
metadata:
  name: grpc-services
  namespace: production
spec:
  parentRefs:
  - name: production-gateway
    sectionName: grpc
  hostnames:
  - "grpc.example.com"
  rules:
  # Route by service name
  - matches:
    - method:
        type: Exact
        service: myorg.UserService
    backendRefs:
    - name: user-grpc-service
      port: 9090

  # Route by method
  - matches:
    - method:
        type: Exact
        service: myorg.OrderService
        method: CreateOrder
    backendRefs:
    - name: order-grpc-service
      port: 9090

  # Catch-all for other gRPC services
  - backendRefs:
    - name: grpc-gateway
      port: 9090
```

## Monitoring and Observability

```yaml
# ServiceMonitor for Envoy metrics
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: envoy-gateway
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app.kubernetes.io/component: proxy
  namespaceSelector:
    matchNames:
    - envoy-gateway-system
  endpoints:
  - port: metrics
    path: /stats/prometheus
    interval: 15s
    relabelings:
    - sourceLabels: [__meta_kubernetes_pod_label_gateway_name]
      targetLabel: gateway
```

```promql
# Key Envoy metrics (with Prometheus)

# Request rate per route
rate(envoy_cluster_upstream_rq_total{envoy_cluster_name=~".*"}[5m])

# Error rate
rate(envoy_cluster_upstream_rq_5xx[5m])
  /
rate(envoy_cluster_upstream_rq_total[5m])

# P99 latency
histogram_quantile(0.99,
  rate(envoy_cluster_upstream_rq_time_bucket[5m])
)

# Circuit breaker open
envoy_cluster_circuit_breakers_default_cx_open > 0

# Active connections
envoy_cluster_upstream_cx_active

# Retry rate
rate(envoy_cluster_upstream_rq_retry[5m])
  /
rate(envoy_cluster_upstream_rq_total[5m])
```

## Troubleshooting

```bash
# Check Gateway status
kubectl describe gateway production-gateway -n production
# Look for: Programmed: True, Accepted: True

# Check HTTPRoute status
kubectl describe httproute api-routes -n production
# Look for: Accepted: True, ResolvedRefs: True

# Check SecurityPolicy status
kubectl describe securitypolicy api-security-policy -n production

# View Envoy config dump
ENVOY_POD=$(kubectl get pods -n envoy-gateway-system \
  -l app.kubernetes.io/component=proxy \
  -o jsonpath='{.items[0].metadata.name}')

kubectl exec -n envoy-gateway-system "$ENVOY_POD" -- \
  curl -s http://localhost:19000/config_dump | \
  python3 -m json.tool | \
  grep -A 10 "route_config"

# View Envoy clusters
kubectl exec -n envoy-gateway-system "$ENVOY_POD" -- \
  curl -s http://localhost:19000/clusters | grep "cx_active"

# Check circuit breaker state
kubectl exec -n envoy-gateway-system "$ENVOY_POD" -- \
  curl -s "http://localhost:19000/stats?filter=circuit_breaker"

# View access logs
kubectl logs -n envoy-gateway-system "$ENVOY_POD" --tail=50 | \
  python3 -m json.tool

# Debug routing for a specific request
kubectl exec -n envoy-gateway-system "$ENVOY_POD" -- \
  curl -sv http://localhost:19000/api/v1/clusters

# Check JWT validation
curl -sv https://api.example.com/v1/users \
  -H "Authorization: Bearer <test-token>" \
  -H "X-Request-ID: test-$(date +%s)"
# Should see X-User-ID and X-Tenant-ID in request headers to backend
```

## Production Deployment Checklist

```bash
# 1. Verify GatewayClass is accepted
kubectl get gatewayclass envoy \
  -o jsonpath='{.status.conditions[?(@.type=="Accepted")].status}'
# True

# 2. Verify Gateway is programmed
kubectl get gateway production-gateway -n production \
  -o jsonpath='{.status.conditions[?(@.type=="Programmed")].status}'
# True

# 3. Check the LoadBalancer IP is assigned
kubectl get gateway production-gateway -n production \
  -o jsonpath='{.status.addresses}'

# 4. Verify all HTTPRoutes are accepted
kubectl get httproute -n production \
  -o custom-columns='NAME:.metadata.name,ACCEPTED:.status.parents[0].conditions[?(@.type=="Accepted")].status'

# 5. Test health endpoint
GATEWAY_IP=$(kubectl get gateway production-gateway -n production \
  -o jsonpath='{.status.addresses[0].value}')
curl -k https://$GATEWAY_IP/healthz

# 6. Check certificate expiry
kubectl get secret production-tls-cert -n production \
  -o jsonpath='{.data.tls\.crt}' | \
  base64 -d | \
  openssl x509 -noout -dates
```

The Gateway API with Envoy Gateway provides a robust, extensible foundation for Kubernetes ingress that scales from simple HTTP routing to complex multi-tenant environments with fine-grained security policies. The separation of concerns between GatewayClass, Gateway, HTTPRoute, and policy objects enables platform teams to own infrastructure configuration while application teams own routing logic — a clean operational boundary that reduces friction and improves reliability.
