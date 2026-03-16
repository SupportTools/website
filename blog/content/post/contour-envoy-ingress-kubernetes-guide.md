---
title: "Contour and Envoy: Modern Ingress Controller for Production Kubernetes"
date: 2027-04-22T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Contour", "Envoy", "Ingress", "HTTPProxy", "Load Balancing"]
categories: ["Kubernetes", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to deploying Contour as a Kubernetes ingress controller with Envoy proxy backend, covering HTTPProxy CRD, TLS termination, rate limiting, traffic weighting, and production operations."
more_link: "yes"
url: "/contour-envoy-ingress-kubernetes-guide/"
---

Contour is a high-performance Kubernetes ingress controller that uses Envoy as its data plane, providing advanced traffic management capabilities that far exceed what the standard Ingress API offers. The HTTPProxy CRD gives platform teams fine-grained control over TLS, virtual hosting, traffic weighting, rate limiting, circuit breaking, and health checking — all in a Kubernetes-native configuration model. This guide covers Contour installation, HTTPProxy configuration, TLS with cert-manager, canary deployments, rate limiting, and production monitoring.

<!--more-->

## Contour Architecture Overview

Contour operates as two tightly coupled components: the Contour control plane that watches Kubernetes objects and translates them into Envoy xDS configuration, and the Envoy data plane that handles actual traffic.

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Contour Architecture                            │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │               Kubernetes API Server                         │   │
│  │  Ingress / HTTPProxy / TLSCertificateDelegation objects     │   │
│  └─────────────────────┬───────────────────────────────────────┘   │
│                         │ Watch                                     │
│  ┌──────────────────────▼─────────────────────────────────────┐    │
│  │                 Contour (control plane)                    │    │
│  │  - Translates HTTPProxy → Envoy xDS config                 │    │
│  │  - Validates HTTPProxy configuration                       │    │
│  │  - Manages TLS certificate secrets                         │    │
│  │  - Exposes xDS gRPC API to Envoy                           │    │
│  └──────────────────────┬─────────────────────────────────────┘    │
│                         │ xDS (gRPC)                               │
│  ┌──────────────────────▼─────────────────────────────────────┐    │
│  │                 Envoy (data plane)                         │    │
│  │  DaemonSet or Deployment on node/edge nodes                │    │
│  │  - L7 HTTP/HTTPS routing                                   │    │
│  │  - TLS termination and passthrough                         │    │
│  │  - Load balancing, retries, circuit breaking               │    │
│  │  - Rate limiting, compression, gzip                        │    │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### Installing Contour

```bash
# Install Contour via Helm
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update

helm upgrade --install contour bitnami/contour \
  --namespace projectcontour \
  --create-namespace \
  --version 17.0.0 \
  --set envoy.kind=DaemonSet \
  --set envoy.hostPorts.enable=false \
  --set envoy.service.type=LoadBalancer \
  --set envoy.service.annotations."service\.beta\.kubernetes\.io/aws-load-balancer-type"=nlb \
  --set envoy.service.annotations."service\.beta\.kubernetes\.io/aws-load-balancer-scheme"=internet-facing \
  --set contour.replicas=2 \
  --set contour.resources.requests.cpu=100m \
  --set contour.resources.requests.memory=128Mi \
  --set contour.resources.limits.cpu=500m \
  --set contour.resources.limits.memory=512Mi \
  --set metrics.serviceMonitor.enabled=true \
  --set metrics.serviceMonitor.namespace=monitoring \
  --wait
```

```yaml
# contour-values-production.yaml
contour:
  replicas: 2
  podDisruptionBudget:
    enabled: true
    minAvailable: 1
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchExpressions:
              - key: app.kubernetes.io/component
                operator: In
                values:
                  - contour
          topologyKey: kubernetes.io/hostname
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: DoNotSchedule
  resources:
    requests:
      cpu: 100m
      memory: 256Mi
    limits:
      cpu: 1000m
      memory: 512Mi
  livenessProbe:
    initialDelaySeconds: 30
  readinessProbe:
    initialDelaySeconds: 10

envoy:
  kind: DaemonSet
  nodeSelector:
    node-role.kubernetes.io/ingress: ""
  tolerations:
    - key: node-role.kubernetes.io/ingress
      operator: Equal
      value: "true"
      effect: NoSchedule
  resources:
    requests:
      cpu: 250m
      memory: 256Mi
    limits:
      cpu: 2000m
      memory: 1Gi
  service:
    type: LoadBalancer
    externalTrafficPolicy: Local
    annotations:
      service.beta.kubernetes.io/aws-load-balancer-type: nlb
      service.beta.kubernetes.io/aws-load-balancer-scheme: internet-facing
      service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "true"
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1

metrics:
  serviceMonitor:
    enabled: true
    namespace: monitoring
    interval: 30s
    scrapeTimeout: 10s
```

### Contour Global Configuration

```yaml
# contour-config.yaml
apiVersion: projectcontour.io/v1alpha1
kind: ContourConfiguration
metadata:
  name: contour
  namespace: projectcontour
spec:
  ingress:
    classNames:
      - contour
  enableExternalNameService: false
  policy:
    requestHeadersPolicy:
      set:
        - name: X-Forwarded-Proto
          value: https
      remove:
        - X-Real-IP
    responseHeadersPolicy:
      set:
        - name: Strict-Transport-Security
          value: "max-age=63072000; includeSubDomains"
        - name: X-Content-Type-Options
          value: nosniff
        - name: X-Frame-Options
          value: SAMEORIGIN
        - name: X-XSS-Protection
          value: "1; mode=block"
  gateway:
    controllerName: projectcontour.io/contour
  envoy:
    listener:
      useProxyProto: false
      disableAllowChunkedLength: false
      connectionBalancer: exact
      socketOptions:
        tcpKeepalive:
          value: 1
          idle: 30
          interval: 10
          count: 5
    defaultHTTPVersions:
      - HTTP/2
      - HTTP/1.1
    metrics:
      address: 0.0.0.0
      port: 8002
    health:
      address: 0.0.0.0
      port: 8002
    http:
      address: 0.0.0.0
      port: 8080
      accessLog: /dev/stdout
    https:
      address: 0.0.0.0
      port: 8443
      accessLog: /dev/stdout
    accessLog:
      format: json
      fields:
        Content-Type: '%REQ(CONTENT-TYPE)%'
        Duration: '%DURATION%'
        ForwardedFor: '%REQ(X-FORWARDED-FOR)%'
        Method: '%REQ(:METHOD)%'
        Protocol: '%PROTOCOL%'
        RequestId: '%REQ(X-REQUEST-ID)%'
        ResponseCode: '%RESPONSE_CODE%'
        ResponseFlags: '%RESPONSE_FLAGS%'
        StartTime: '%START_TIME%'
        UpstreamHost: '%UPSTREAM_HOST%'
        UpstreamService: '%REQ(:AUTHORITY)%'
        UserAgent: '%REQ(USER-AGENT)%'
    cluster:
      dnsLookupFamily: auto
      maxRequestsPerConnection: 0
  enableExternalNameService: false
  rateLimitService:
    extensionService: projectcontour/rate-limit-service
    domain: contour
    failOpen: false
    enableXRateLimitHeaders: true
  tracing:
    includePodDetail: true
    serviceName: contour
    overallSampling: 100
    maxPathTagLength: 256
    customTags:
      - tagName: customer_id
        requestHeaderName: X-Customer-ID
  xdsServer:
    type: contour
    address: 0.0.0.0
    port: 8001
    tls:
      caFile: /certs/ca.crt
      certFile: /certs/tls.crt
      keyFile: /certs/tls.key
      insecureSkipVerify: false
```

## HTTPProxy CRD: Beyond Standard Ingress

HTTPProxy is Contour's custom resource that replaces Kubernetes Ingress with a safer, more expressive API.

### Basic HTTPProxy

```yaml
# basic-httpproxy.yaml
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: example-app
  namespace: production
spec:
  virtualhost:
    fqdn: app.company.com
  routes:
    - conditions:
        - prefix: /
      services:
        - name: app-service
          port: 8080
      responseHeadersPolicy:
        set:
          - name: Cache-Control
            value: "no-store"
      requestHeadersPolicy:
        set:
          - name: X-Real-IP
            value: "%DOWNSTREAM_REMOTE_ADDRESS_WITHOUT_PORT%"
```

### TLS Termination with cert-manager

```yaml
# tls-httpproxy.yaml
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: app-tls
  namespace: production
spec:
  secretName: app-tls-secret
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  dnsNames:
    - app.company.com
    - api.company.com
  duration: 2160h   # 90 days
  renewBefore: 360h  # 15 days before expiry
---
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: app-tls
  namespace: production
spec:
  virtualhost:
    fqdn: app.company.com
    tls:
      secretName: app-tls-secret
      minimumProtocolVersion: "1.2"
      maximumProtocolVersion: "1.3"
      cipherSuites:
        - "[ECDHE-ECDSA-AES128-GCM-SHA256|ECDHE-ECDSA-CHACHA20-POLY1305]"
        - "[ECDHE-RSA-AES128-GCM-SHA256|ECDHE-RSA-CHACHA20-POLY1305]"
        - "ECDHE-ECDSA-AES256-GCM-SHA384"
        - "ECDHE-RSA-AES256-GCM-SHA384"
  routes:
    - conditions:
        - prefix: /
      services:
        - name: app-service
          port: 8080
      enableWebsockets: true
      permitInsecure: false
      timeoutPolicy:
        response: 30s
        idle: 60s
      retryPolicy:
        count: 3
        perTryTimeout: 10s
        retryOn:
          - "retriable-status-codes"
          - "connect-failure"
          - "retriable-4xx"
      loadBalancerPolicy:
        strategy: Cookie
        cookieRebalancePercent: 25
```

### TLS Certificate Delegation

```yaml
# tls-certificate-delegation.yaml
# Allow production namespace to use a wildcard cert stored in tls-common
apiVersion: projectcontour.io/v1
kind: TLSCertificateDelegation
metadata:
  name: wildcard-delegation
  namespace: tls-common
spec:
  delegations:
    - secretName: wildcard-company-com
      targetNamespaces:
        - production
        - staging
        - development
```

```yaml
# use-delegated-cert.yaml
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: service-a
  namespace: production
spec:
  virtualhost:
    fqdn: service-a.company.com
    tls:
      secretName: tls-common/wildcard-company-com  # namespace/secret format
  routes:
    - conditions:
        - prefix: /
      services:
        - name: service-a
          port: 8080
```

### TLS Passthrough for mTLS Workloads

```yaml
# tls-passthrough.yaml
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: mtls-service
  namespace: secure-services
spec:
  virtualhost:
    fqdn: mtls.company.com
    tls:
      passthrough: true
  tcpproxy:
    services:
      - name: mtls-backend
        port: 443
```

## Virtual Hosting and Path Routing

### Multiple Services Under One Domain

```yaml
# multi-service-httpproxy.yaml
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: api-gateway
  namespace: production
spec:
  virtualhost:
    fqdn: api.company.com
    tls:
      secretName: api-tls
  routes:
    - conditions:
        - prefix: /api/v1/users
      services:
        - name: users-service
          port: 8080
      timeoutPolicy:
        response: 15s
        idle: 30s
      corsPolicy:
        allowCredentials: true
        allowOrigin:
          - "https://app.company.com"
          - "https://admin.company.com"
        allowMethods:
          - GET
          - POST
          - PUT
          - DELETE
          - OPTIONS
        allowHeaders:
          - Authorization
          - Content-Type
          - X-Request-ID
        exposeHeaders:
          - X-RateLimit-Limit
          - X-RateLimit-Remaining
        maxAge: "24h"
    - conditions:
        - prefix: /api/v1/orders
      services:
        - name: orders-service
          port: 8080
      timeoutPolicy:
        response: 60s
        idle: 120s
    - conditions:
        - prefix: /api/v1/payments
      services:
        - name: payments-service
          port: 8443
          protocol: tls
          validation:
            caSecret: payments-ca
            subjectName: payments.production.svc.cluster.local
    - conditions:
        - prefix: /api/v2
      services:
        - name: api-v2-service
          port: 8080
      responseHeadersPolicy:
        set:
          - name: API-Version
            value: "v2"
    - conditions:
        - prefix: /health
      services:
        - name: health-aggregator
          port: 8080
      retryPolicy: {}  # No retries for health checks
```

### Include-Based HTTPProxy Delegation

Delegation allows different teams to own routing within their own namespace.

```yaml
# root-httpproxy.yaml - managed by platform team
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: root-proxy
  namespace: ingress
spec:
  virtualhost:
    fqdn: platform.company.com
    tls:
      secretName: ingress/platform-tls
  includes:
    - name: team-a-routes
      namespace: team-a
      conditions:
        - prefix: /team-a
    - name: team-b-routes
      namespace: team-b
      conditions:
        - prefix: /team-b
    - name: shared-services
      namespace: shared
      conditions:
        - prefix: /shared
```

```yaml
# team-a-httpproxy.yaml - managed by team-a (in team-a namespace)
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: team-a-routes
  namespace: team-a
spec:
  # No virtualhost here - this is an included proxy
  routes:
    - conditions:
        - prefix: /team-a/api
      services:
        - name: team-a-api
          port: 8080
    - conditions:
        - prefix: /team-a/web
      services:
        - name: team-a-frontend
          port: 3000
```

## Traffic Weighting and Canary Deployments

```yaml
# canary-httpproxy.yaml
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: app-canary
  namespace: production
spec:
  virtualhost:
    fqdn: app.company.com
    tls:
      secretName: app-tls
  routes:
    # Canary routing: 10% of traffic to v2
    - conditions:
        - prefix: /
      services:
        - name: app-v1
          port: 8080
          weight: 90
        - name: app-v2
          port: 8080
          weight: 10
      timeoutPolicy:
        response: 30s
      loadBalancerPolicy:
        strategy: RoundRobin
```

### Header-Based Canary Routing

```yaml
# header-canary-httpproxy.yaml
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: header-canary
  namespace: production
spec:
  virtualhost:
    fqdn: app.company.com
    tls:
      secretName: app-tls
  routes:
    # Route canary users via header
    - conditions:
        - prefix: /
        - header:
            name: X-Canary
            exact: "true"
      services:
        - name: app-v2
          port: 8080
      responseHeadersPolicy:
        set:
          - name: X-Served-By
            value: canary
    # Route cookie-based canary users
    - conditions:
        - prefix: /
        - header:
            name: Cookie
            contains: "canary=true"
      services:
        - name: app-v2
          port: 8080
    # Default: stable version
    - conditions:
        - prefix: /
      services:
        - name: app-v1
          port: 8080
```

## Rate Limiting

Contour integrates with an external rate limit service (such as envoy/ratelimit) for global and per-host rate limiting.

### Rate Limit Service Deployment

```yaml
# ratelimit-deployment.yaml
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ratelimit
  namespace: projectcontour
spec:
  replicas: 2
  selector:
    matchLabels:
      app: ratelimit
  template:
    metadata:
      labels:
        app: ratelimit
    spec:
      containers:
        - name: ratelimit
          image: envoyproxy/ratelimit:v1.4.0
          command:
            - /bin/ratelimit
          env:
            - name: LOG_LEVEL
              value: warn
            - name: REDIS_SOCKET_TYPE
              value: tcp
            - name: REDIS_URL
              value: redis:6379
            - name: USE_STATSD
              value: "false"
            - name: RUNTIME_ROOT
              value: /data
            - name: RUNTIME_SUBDIRECTORY
              value: ratelimit
            - name: RUNTIME_WATCH_ROOT
              value: "false"
            - name: RUNTIME_IGNOREDOTFILES
              value: "true"
          ports:
            - name: grpc
              containerPort: 8081
            - name: http
              containerPort: 8080
            - name: debug
              containerPort: 6070
          resources:
            requests:
              cpu: 100m
              memory: 64Mi
            limits:
              cpu: 500m
              memory: 128Mi
          volumeMounts:
            - name: config
              mountPath: /data/ratelimit/config
      volumes:
        - name: config
          configMap:
            name: ratelimit-config
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: ratelimit-config
  namespace: projectcontour
data:
  config.yaml: |
    domain: contour
    descriptors:
      # Per-IP rate limit for API endpoints
      - key: remote_address
        rate_limit:
          unit: minute
          requests_per_unit: 60
      # Per-user rate limit using Authorization header
      - key: header_match
        value: authorization
        rate_limit:
          unit: minute
          requests_per_unit: 1000
      # Stricter limits for login endpoint
      - key: header_match
        value: login
        rate_limit:
          unit: minute
          requests_per_unit: 5
      # Global rate limit for a specific path
      - key: generic_key
        value: api_v1
        rate_limit:
          unit: second
          requests_per_unit: 100
---
apiVersion: v1
kind: Service
metadata:
  name: ratelimit
  namespace: projectcontour
spec:
  selector:
    app: ratelimit
  ports:
    - name: grpc
      port: 8081
      targetPort: 8081
    - name: http
      port: 8080
      targetPort: 8080
```

### HTTPProxy with Rate Limiting

```yaml
# rate-limited-httpproxy.yaml
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: rate-limited-api
  namespace: production
spec:
  virtualhost:
    fqdn: api.company.com
    tls:
      secretName: api-tls
    rateLimitPolicy:
      global:
        descriptors:
          # Global rate limit on all requests
          - entries:
              - remoteAddress: {}
    corsPolicy:
      allowOrigin:
        - "*"
      allowMethods:
        - GET
        - POST
  routes:
    - conditions:
        - prefix: /api
      services:
        - name: api-service
          port: 8080
      rateLimitPolicy:
        global:
          descriptors:
            - entries:
                - remoteAddress: {}
            - entries:
                - genericKey:
                    value: api_v1
        local:
          requests: 100
          unit: second
          burst: 200
      responseHeadersPolicy:
        set:
          - name: X-RateLimit-Limit
            value: "100"
    - conditions:
        - prefix: /auth/login
      services:
        - name: auth-service
          port: 8080
      rateLimitPolicy:
        global:
          descriptors:
            - entries:
                - remoteAddress: {}
              entries:
                - genericKey:
                    value: login
        local:
          requests: 5
          unit: minute
          burst: 10
```

## Health Checking and Circuit Breaking

```yaml
# health-circuit-httpproxy.yaml
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: resilient-service
  namespace: production
spec:
  virtualhost:
    fqdn: resilient.company.com
    tls:
      secretName: resilient-tls
  routes:
    - conditions:
        - prefix: /
      services:
        - name: backend
          port: 8080
          healthPort: 8081
          protocol: h2c
          # Upstream health check
          healthCheckPolicy:
            path: /healthz
            intervalSeconds: 10
            timeoutSeconds: 5
            unhealthyThresholdCount: 3
            healthyThresholdCount: 2
      # Circuit breaker via timeouts
      timeoutPolicy:
        response: 10s
        idle: 60s
        idleConnection: 90s
      retryPolicy:
        count: 2
        perTryTimeout: 5s
        retryOn:
          - "reset"
          - "connect-failure"
          - "retriable-4xx"
          - "retriable-status-codes"
        retriableStatusCodes:
          - 503
          - 502
      loadBalancerPolicy:
        strategy: LeastRequest
```

## External Name Services and Service ExternalName

```yaml
# external-service-httpproxy.yaml
---
# Route traffic to an external S3-compatible endpoint
apiVersion: v1
kind: Service
metadata:
  name: external-api
  namespace: production
spec:
  type: ExternalName
  externalName: external-api.partner.com
  ports:
    - name: https
      port: 443
      targetPort: 443
---
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: external-api-proxy
  namespace: production
spec:
  virtualhost:
    fqdn: partner-api.company.com
    tls:
      secretName: partner-tls
  routes:
    - conditions:
        - prefix: /
      services:
        - name: external-api
          port: 443
          protocol: tls
          validation:
            skipClientCertValidation: true
      requestHeadersPolicy:
        set:
          - name: Host
            value: external-api.partner.com
```

## Monitoring with Prometheus

```yaml
# contour-prometheus-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: contour-alerts
  namespace: monitoring
spec:
  groups:
    - name: contour.rules
      rules:
        - alert: ContourHTTPProxy5xxErrors
          expr: |
            sum(rate(envoy_cluster_upstream_rq_5xx[5m])) by (envoy_cluster_name) > 0.05
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High 5xx error rate on Contour cluster"
            description: "Cluster {{ $labels.envoy_cluster_name }} has a 5xx error rate of {{ $value | humanizePercentage }}."
        - alert: ContourEnvoyNotHealthy
          expr: |
            envoy_server_live == 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Envoy instance is not healthy"
            description: "Envoy pod {{ $labels.pod }} in namespace {{ $labels.namespace }} is not live."
        - alert: ContourHTTPProxyInvalid
          expr: |
            contour_httpproxy_invalid_total > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Invalid HTTPProxy objects detected"
            description: "{{ $value }} HTTPProxy objects in namespace {{ $labels.namespace }} are in an invalid state."
        - alert: ContourHighConnectionCount
          expr: |
            envoy_listener_downstream_cx_active > 10000
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High active connection count on Envoy listener"
            description: "Envoy listener {{ $labels.envoy_listener_address }} has {{ $value }} active connections."
        - alert: ContourHighP99Latency
          expr: |
            histogram_quantile(0.99,
              sum(rate(envoy_cluster_upstream_rq_time_bucket[5m])) by (le, envoy_cluster_name)
            ) > 2000
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "High P99 upstream latency"
            description: "Cluster {{ $labels.envoy_cluster_name }} P99 latency is {{ $value }}ms."
```

```yaml
# contour-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: contour
  namespace: monitoring
spec:
  namespaceSelector:
    matchNames:
      - projectcontour
  selector:
    matchLabels:
      app.kubernetes.io/name: contour
      app.kubernetes.io/component: contour
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: envoy
  namespace: monitoring
spec:
  namespaceSelector:
    matchNames:
      - projectcontour
  selector:
    matchLabels:
      app.kubernetes.io/name: contour
      app.kubernetes.io/component: envoy
  endpoints:
    - port: metrics
      interval: 15s
      path: /stats/prometheus
```

## HTTPProxy Status and Validation

```bash
# Check HTTPProxy status across all namespaces
kubectl get httpproxy -A

# Check for invalid HTTPProxies
kubectl get httpproxy -A \
  -o jsonpath='{range .items[?(@.status.currentStatus!="valid")]}{.metadata.namespace}/{.metadata.name}: {.status.currentStatus} - {.status.description}{"\n"}{end}'

# Describe a specific HTTPProxy to see route conditions
kubectl -n production describe httpproxy app-tls

# Verify Envoy is loading the correct configuration
kubectl -n projectcontour exec -it $(kubectl -n projectcontour get pod -l app.kubernetes.io/component=envoy -o name | head -1) -- \
  curl -s localhost:9001/config_dump | python3 -m json.tool | less

# Check Envoy clusters
kubectl -n projectcontour exec -it $(kubectl -n projectcontour get pod -l app.kubernetes.io/component=envoy -o name | head -1) -- \
  curl -s localhost:9001/clusters | grep -E "health_flags|cx_active|rq_active"

# Check Envoy listeners
kubectl -n projectcontour exec -it $(kubectl -n projectcontour get pod -l app.kubernetes.io/component=envoy -o name | head -1) -- \
  curl -s localhost:9001/listeners

# Check Contour xDS server state
kubectl -n projectcontour exec -it $(kubectl -n projectcontour get pod -l app.kubernetes.io/component=contour -o name | head -1) -- \
  contour debug dump-debug-config
```

## Upgrading Contour

```bash
# Check current Contour version
kubectl -n projectcontour get deploy contour \
  -o jsonpath='{.spec.template.spec.containers[0].image}'

# Review the upgrade notes for the target version
# https://projectcontour.io/resources/upgrading/

# Upgrade via Helm
helm upgrade contour bitnami/contour \
  --namespace projectcontour \
  --version 18.0.0 \
  --reuse-values \
  --wait

# Verify after upgrade
kubectl -n projectcontour rollout status deploy/contour
kubectl -n projectcontour get pods
kubectl get httpproxy -A | grep -v valid
```

## Troubleshooting Common Issues

```bash
# HTTPProxy shows "Orphaned" status
# Cause: The HTTPProxy is an include but the root proxy does not reference it
kubectl get httpproxy -A -o wide | grep Orphaned

# Fix: Ensure root HTTPProxy includes this proxy
kubectl -n production describe httpproxy root-proxy

# HTTPProxy shows "InvalidRouteCondition"
# Cause: Invalid header match, service not found, or misconfigured TLS
kubectl -n production describe httpproxy app-tls | grep -A 5 "Current Status"

# Envoy not picking up new certificates
# Force cert reload by triggering Contour reconciliation
kubectl -n production annotate httpproxy app-tls \
  contour.heptio.com/force-reconcile="$(date +%s)" --overwrite

# 503 errors on a specific service
# Check that the service port name matches what HTTPProxy expects
kubectl -n production get svc app-service -o yaml | yq '.spec.ports'

# Verify endpoints are ready
kubectl -n production get endpoints app-service

# Test routing from inside the cluster
kubectl -n projectcontour exec -it \
  $(kubectl -n projectcontour get pod -l app.kubernetes.io/component=envoy -o name | head -1) -- \
  curl -v -H "Host: app.company.com" http://localhost:8080/api/health
```

## Production Hardening

```yaml
# contour-network-policy.yaml
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: contour-allow-ingress
  namespace: projectcontour
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/component: envoy
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - ports:
        - protocol: TCP
          port: 8080
        - protocol: TCP
          port: 8443
  egress:
    - {}   # Allow all egress for Envoy to reach backends
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: contour-controller-policy
  namespace: projectcontour
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/component: contour
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app.kubernetes.io/component: envoy
      ports:
        - protocol: TCP
          port: 8001   # xDS gRPC
  egress:
    - to:
        - namespaceSelector: {}
      ports:
        - protocol: TCP
          port: 443   # Kubernetes API
```

## Summary

Contour with Envoy provides enterprise-grade ingress capabilities that go far beyond the standard Kubernetes Ingress API. The HTTPProxy CRD's delegate model enables safe multi-team self-service routing within a single ingress layer. Traffic weighting and header-based routing deliver zero-risk canary deployments without requiring a service mesh. The combination of TLS certificate delegation, external rate limiting via the ratelimit service, and upstream health checking makes Contour a solid foundation for production API gateways. Monitor Envoy via Prometheus using the `/stats/prometheus` endpoint, and always validate HTTPProxy status regularly to catch invalid configurations before they silently affect traffic.
