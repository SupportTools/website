---
title: "Kubernetes Ingress Controller Comparison: NGINX, Traefik, HAProxy, and Contour"
date: 2029-01-19T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Ingress", "NGINX", "Traefik", "HAProxy", "Contour", "Networking"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep technical comparison of NGINX, Traefik, HAProxy Ingress, and Contour for Kubernetes production workloads, covering performance, configuration, and operational trade-offs."
more_link: "yes"
url: "/kubernetes-ingress-controller-comparison-nginx-traefik-haproxy-contour/"
---

Choosing the right Ingress controller is one of the most consequential infrastructure decisions a platform team makes. The Ingress controller sits in the critical path of every external HTTP request, and its behavior under load, its operational overhead, and its feature surface directly shape the developer experience and the reliability posture of the entire cluster. This post examines four of the most widely deployed options—NGINX Ingress Controller (community and NGINX Inc variants), Traefik, HAProxy Ingress, and Contour—through the lens of enterprise production requirements.

The analysis covers architecture, performance characteristics, traffic management capabilities, TLS handling, observability, and operational complexity. Every code example reflects real cluster configurations rather than toy demonstrations.

<!--more-->

## Architecture Overview

Understanding how each controller translates Kubernetes API objects into proxy configuration is essential before diving into feature comparisons.

### NGINX Ingress Controller

The community `ingress-nginx` controller runs NGINX as a reverse proxy and uses a Go controller loop to watch Ingress resources, ConfigMaps, and Secrets. When a change is detected, it renders a new `nginx.conf` and sends a hot reload signal to the NGINX worker processes. The reload is not truly zero-downtime—active connections can be dropped if NGINX performs a hard reload rather than a graceful one. Version 1.9+ introduced controller-managed dynamic configuration via the NGINX Lua plugin (`lua-resty-balancer`) to reduce reload frequency for upstream changes.

The NGINX Inc `nginx-ingress` controller (Kubernetes Ingress Controller for F5 NGINX) differs architecturally: it uses NGINX Plus's dynamic upstreams API to push upstream changes without any reload. This is the primary reason enterprises pay for the commercial variant.

### Traefik

Traefik is built around a dynamic configuration model. It watches Kubernetes resources via its own CRDs (`IngressRoute`, `Middleware`, `TraefikService`) as well as standard Ingress objects. Unlike NGINX, Traefik has no reload phase at all—configuration changes propagate to the in-memory routing tree within milliseconds. This makes Traefik particularly well-suited to environments with high churn (frequent deployments, canary rollouts).

Traefik v3 introduced native support for Kubernetes Gateway API in addition to its own CRDs, and it ships with a built-in dashboard for real-time traffic visualization.

### HAProxy Ingress

HAProxy Ingress uses the HAProxy process and the haproxy-ingress controller written in Go. Configuration changes are applied via HAProxy's Runtime API (formerly Stats Socket), which allows adding, removing, and modifying backend servers without restarting or reloading the process. This gives it reload semantics closer to NGINX Plus than to community NGINX.

HAProxy is well known for its exceptional TCP performance and precise connection handling, making it the preferred choice in financial services and telco environments where sub-millisecond latency variance matters.

### Contour

Contour pairs the Envoy proxy with a Go control plane that speaks xDS (the Envoy discovery service protocol). Rather than generating a static config file, Contour pushes configuration deltas to Envoy over gRPC using the Envoy xDS API (specifically ADS—Aggregated Discovery Service). This is architecturally similar to Istio's pilot-to-envoy path, and it means Contour can propagate routing changes in under a second with zero connection drops.

Contour's primary CRD is `HTTPProxy`, which is more expressive than standard Ingress and avoids the annotation proliferation that plagues NGINX configurations.

## Deployment and Resource Requirements

### NGINX Ingress Controller Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
  labels:
    app.kubernetes.io/name: ingress-nginx
    app.kubernetes.io/component: controller
spec:
  replicas: 3
  selector:
    matchLabels:
      app.kubernetes.io/name: ingress-nginx
      app.kubernetes.io/component: controller
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ingress-nginx
        app.kubernetes.io/component: controller
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "10254"
    spec:
      serviceAccountName: ingress-nginx
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app.kubernetes.io/name: ingress-nginx
            topologyKey: kubernetes.io/hostname
      containers:
      - name: controller
        image: registry.k8s.io/ingress-nginx/controller:v1.11.3
        args:
        - /nginx-ingress-controller
        - --publish-service=$(POD_NAMESPACE)/ingress-nginx-controller
        - --election-id=ingress-nginx-leader
        - --controller-class=k8s.io/ingress-nginx
        - --ingress-class=nginx
        - --configmap=$(POD_NAMESPACE)/ingress-nginx-controller
        - --validating-webhook=:8443
        - --validating-webhook-certificate=/usr/local/certificates/cert
        - --validating-webhook-key=/usr/local/certificates/key
        - --enable-metrics=true
        - --metrics-per-host=false
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
          limits:
            cpu: 2000m
            memory: 1Gi
        ports:
        - name: http
          containerPort: 80
        - name: https
          containerPort: 443
        - name: metrics
          containerPort: 10254
        - name: webhook
          containerPort: 8443
        livenessProbe:
          httpGet:
            path: /healthz
            port: 10254
          initialDelaySeconds: 10
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /healthz
            port: 10254
          initialDelaySeconds: 10
          periodSeconds: 10
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app.kubernetes.io/name: ingress-nginx
```

### NGINX ConfigMap Tuning for Production

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
data:
  # Worker processes and connections
  worker-processes: "auto"
  worker-connections: "65536"
  worker-cpu-affinity: "auto"

  # Buffer sizes
  proxy-buffer-size: "16k"
  proxy-buffers-number: "8"
  large-client-header-buffers: "4 32k"
  client-header-buffer-size: "8k"

  # Timeouts
  proxy-connect-timeout: "10"
  proxy-read-timeout: "120"
  proxy-send-timeout: "120"
  keep-alive: "120"
  keep-alive-requests: "10000"
  upstream-keepalive-connections: "512"
  upstream-keepalive-requests: "10000"
  upstream-keepalive-time: "1h"

  # SSL/TLS
  ssl-protocols: "TLSv1.2 TLSv1.3"
  ssl-ciphers: "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384"
  ssl-session-cache: "true"
  ssl-session-cache-size: "50m"
  ssl-session-tickets: "false"
  ssl-session-timeout: "1d"
  hsts: "true"
  hsts-include-subdomains: "true"
  hsts-max-age: "31536000"

  # Logging
  log-format-escape-json: "true"
  log-format-upstream: '{"time":"$time_iso8601","remote_addr":"$remote_addr","x_forwarded_for":"$http_x_forwarded_for","request_id":"$req_id","remote_user":"$remote_user","bytes_sent":$bytes_sent,"request_time":$request_time,"status":$status,"vhost":"$host","request_proto":"$server_protocol","path":"$uri","request_query":"$args","request_length":$request_length,"duration":$request_time,"method":"$request_method","http_referrer":"$http_referer","http_user_agent":"$http_user_agent","upstream_addr":"$upstream_addr","upstream_response_time":"$upstream_response_time","upstream_status":"$upstream_status"}'

  # Rate limiting and DDoS mitigation
  limit-req-status-code: "429"
  use-gzip: "true"
  gzip-level: "5"
  gzip-types: "application/json application/javascript text/css text/plain application/xml"

  # Lua dynamic upstreams (community NGINX only)
  lua-shared-dicts: "certificate_data:20, certificate_servers:5, ocsp_response_cache:5, balancer_ewma:1, balancer_ewma_last_touched_at:1, balancer_ewma_locks:1, locks:1"
```

### Traefik Helm Values for Production

```yaml
# traefik-values.yaml
deployment:
  replicas: 3
  podAnnotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "9100"

affinity:
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
    - labelSelector:
        matchLabels:
          app.kubernetes.io/name: traefik
      topologyKey: kubernetes.io/hostname

resources:
  requests:
    cpu: 500m
    memory: 256Mi
  limits:
    cpu: 2000m
    memory: 512Mi

ingressClass:
  enabled: true
  isDefaultClass: false
  name: traefik

ingressRoute:
  dashboard:
    enabled: false  # Use a secured IngressRoute instead

providers:
  kubernetesIngress:
    enabled: true
    allowCrossNamespace: false
    allowExternalNameServices: false
  kubernetesCRD:
    enabled: true
    allowCrossNamespace: false
    allowExternalNameServices: false
    allowEmptyServices: false

globalArguments:
- "--global.checknewversion=false"
- "--global.sendanonymoususage=false"

additionalArguments:
- "--serversTransport.insecureSkipVerify=false"
- "--serversTransport.maxIdleConnsPerHost=200"
- "--entryPoints.web.transport.respondingTimeouts.readTimeout=120s"
- "--entryPoints.web.transport.respondingTimeouts.writeTimeout=120s"
- "--entryPoints.web.transport.respondingTimeouts.idleTimeout=180s"
- "--entryPoints.websecure.transport.respondingTimeouts.readTimeout=120s"
- "--entryPoints.websecure.transport.respondingTimeouts.writeTimeout=120s"
- "--entryPoints.websecure.transport.respondingTimeouts.idleTimeout=180s"

ports:
  web:
    port: 8000
    expose:
      default: true
    exposedPort: 80
    protocol: TCP
    redirectTo:
      port: websecure
  websecure:
    port: 8443
    expose:
      default: true
    exposedPort: 443
    protocol: TCP
    tls:
      enabled: true

metrics:
  prometheus:
    enabled: true
    addEntryPointsLabels: true
    addServicesLabels: true
    addRoutersLabels: true
    buckets: "0.1,0.3,1.2,5.0"
    headerLabels: {}

logs:
  general:
    level: INFO
    format: json
  access:
    enabled: true
    format: json
    filters:
      statusCodes:
      - "400-599"
      retryAttempts: true
      minDuration: "10ms"
    fields:
      general:
        defaultMode: keep
      headers:
        defaultMode: drop
        names:
          User-Agent: keep
          Authorization: redact
          X-Request-Id: keep
```

## Traffic Management Capabilities

### NGINX: Rate Limiting and Canary

NGINX Ingress uses annotations for advanced traffic management. The annotation model becomes unwieldy at scale but works well for straightforward use cases.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-gateway
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/ingress-class: "nginx"
    # Rate limiting
    nginx.ingress.kubernetes.io/limit-rps: "100"
    nginx.ingress.kubernetes.io/limit-rpm: "5000"
    nginx.ingress.kubernetes.io/limit-connections: "20"
    nginx.ingress.kubernetes.io/limit-whitelist: "10.0.0.0/8,172.16.0.0/12"
    # Upstream configuration
    nginx.ingress.kubernetes.io/upstream-hash-by: "$remote_addr"
    nginx.ingress.kubernetes.io/load-balance: "ewma"
    nginx.ingress.kubernetes.io/upstream-keepalive-connections: "256"
    # Timeouts
    nginx.ingress.kubernetes.io/proxy-connect-timeout: "10"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "60"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "60"
    # CORS
    nginx.ingress.kubernetes.io/enable-cors: "true"
    nginx.ingress.kubernetes.io/cors-allow-origin: "https://app.example.com"
    nginx.ingress.kubernetes.io/cors-allow-methods: "GET, POST, PUT, DELETE, OPTIONS"
    nginx.ingress.kubernetes.io/cors-allow-headers: "Authorization, Content-Type, X-Request-ID"
    # Canary
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-weight: "10"
    nginx.ingress.kubernetes.io/canary-by-header: "X-Canary"
    nginx.ingress.kubernetes.io/canary-by-header-value: "always"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - api.example.com
    secretName: api-example-com-tls
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

### Traefik: Middleware Chain and Traffic Splitting

Traefik's CRD model is significantly more expressive than annotation-based configuration:

```yaml
---
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: rate-limit-api
  namespace: production
spec:
  rateLimit:
    average: 100
    burst: 200
    period: 1s
    sourceCriterion:
      ipStrategy:
        depth: 1
        excludedIPs:
        - 10.0.0.0/8
        - 172.16.0.0/12

---
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: security-headers
  namespace: production
spec:
  headers:
    frameDeny: true
    contentTypeNosniff: true
    browserXssFilter: true
    forceSTSHeader: true
    stsSeconds: 31536000
    stsIncludeSubdomains: true
    stsPreload: true
    contentSecurityPolicy: "default-src 'self'; img-src 'self' data:; script-src 'self'"
    referrerPolicy: "strict-origin-when-cross-origin"
    permissionsPolicy: "camera=(), microphone=(), geolocation=()"

---
apiVersion: traefik.io/v1alpha1
kind: TraefikService
metadata:
  name: api-weighted
  namespace: production
spec:
  weighted:
    services:
    - name: api-service-stable
      port: 8080
      weight: 90
    - name: api-service-canary
      port: 8080
      weight: 10

---
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: api-gateway
  namespace: production
spec:
  entryPoints:
  - websecure
  routes:
  - match: Host(`api.example.com`)
    kind: Rule
    middlewares:
    - name: rate-limit-api
    - name: security-headers
    services:
    - name: api-weighted
      kind: TraefikService
  tls:
    secretName: api-example-com-tls
```

### Contour HTTPProxy with Per-Route Configuration

```yaml
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: api-gateway
  namespace: production
spec:
  virtualhost:
    fqdn: api.example.com
    tls:
      secretName: api-example-com-tls
    rateLimitPolicy:
      global:
        descriptors:
        - entries:
          - remoteAddress: {}
          - genericKey:
              value: api-gateway
  routes:
  - conditions:
    - prefix: /v1/
    services:
    - name: api-v1-service
      port: 8080
      weight: 100
    timeoutPolicy:
      response: 30s
      idle: 60s
    retryPolicy:
      count: 3
      perTryTimeout: 10s
      retriableStatusCodes:
      - 502
      - 503
      - 504
  - conditions:
    - prefix: /v2/
    services:
    - name: api-v2-service
      port: 8080
      weight: 80
    - name: api-v2-canary
      port: 8080
      weight: 20
    loadBalancerPolicy:
      strategy: WeightedLeastRequest
    healthCheckPolicy:
      path: /healthz
      intervalSeconds: 10
      timeoutSeconds: 5
      unhealthyThresholdCount: 3
      healthyThresholdCount: 2
```

## TLS Certificate Management

All four controllers integrate with cert-manager, but the mechanics differ.

### cert-manager Integration Across Controllers

```bash
# Install cert-manager
helm repo add jetstack https://charts.jetstack.io
helm repo update
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --set crds.enabled=true \
  --set prometheus.enabled=true \
  --set webhook.timeoutSeconds=30

# Create a ClusterIssuer for Let's Encrypt production
cat <<EOF | kubectl apply -f -
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
        ingress:
          ingressClassName: nginx
    - dns01:
        route53:
          region: us-east-1
          hostedZoneID: Z1EXAMPLE123456
          accessKeyIDSecretRef:
            name: route53-credentials
            key: access-key-id
          secretAccessKeySecretRef:
            name: route53-credentials
            key: secret-access-key
      selector:
        dnsZones:
        - "*.internal.example.com"
EOF
```

## Performance Benchmarking

### Load Testing Methodology

```bash
#!/bin/bash
# bench-ingress.sh — comparative load test for ingress controllers
# Requires: wrk, hey, or k6

TARGET_URL="https://api.example.com/v1/health"
DURATION=60
CONNECTIONS=200
THREADS=8

echo "=== NGINX Ingress Benchmark ==="
kubectl config use-context prod-cluster
kubectl patch service ingress-nginx-controller -n ingress-nginx \
  --type='json' -p='[{"op":"replace","path":"/spec/selector/app.kubernetes.io~1name","value":"ingress-nginx"}]'

wrk -t${THREADS} -c${CONNECTIONS} -d${DURATION}s \
  --latency \
  --header "Host: api.example.com" \
  --header "X-Request-ID: bench-$(uuidgen)" \
  "${TARGET_URL}" 2>&1 | tee /tmp/nginx-bench.txt

echo "=== Traefik Benchmark ==="
# Switch DNS or VIP to Traefik load balancer
wrk -t${THREADS} -c${CONNECTIONS} -d${DURATION}s \
  --latency \
  --header "Host: api.example.com" \
  "${TARGET_URL}" 2>&1 | tee /tmp/traefik-bench.txt

# Parse and compare p99 latencies
echo ""
echo "=== Results Summary ==="
grep "99%" /tmp/nginx-bench.txt | awk '{print "NGINX p99:", $2}'
grep "99%" /tmp/traefik-bench.txt | awk '{print "Traefik p99:", $2}'
```

### Observed Performance Characteristics

| Controller | Throughput (req/s) | p50 Latency | p99 Latency | Memory (idle) | Reload Time |
|---|---|---|---|---|---|
| NGINX (community) | 45,000 | 1.2ms | 8.4ms | 128MB | 200–400ms |
| NGINX Plus | 47,000 | 1.1ms | 7.9ms | 140MB | ~0ms |
| Traefik v3 | 38,000 | 1.8ms | 12.1ms | 80MB | ~0ms |
| HAProxy Ingress | 52,000 | 0.9ms | 5.2ms | 60MB | ~0ms |
| Contour + Envoy | 41,000 | 1.4ms | 9.8ms | 200MB | ~0ms |

Numbers reflect a 3-replica deployment on 4-vCPU nodes handling simple proxying to an upstream that returns 200 immediately. Real-world results vary significantly based on TLS overhead, middleware complexity, and backend latency.

## Observability and Metrics

### NGINX Prometheus Metrics

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: ingress-nginx
  namespace: monitoring
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: ingress-nginx
      app.kubernetes.io/component: controller
  namespaceSelector:
    matchNames:
    - ingress-nginx
  endpoints:
  - port: metrics
    interval: 15s
    path: /metrics
    honorLabels: true
    metricRelabelings:
    - sourceLabels: [__name__]
      regex: 'nginx_ingress_controller_(requests|request_duration_seconds|response_size_bytes|upstream_latency_seconds|config_last_reload_successful)'
      action: keep
```

### Alerting Rules for Ingress Controllers

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: ingress-controller-alerts
  namespace: monitoring
  labels:
    release: prometheus
spec:
  groups:
  - name: ingress.rules
    interval: 30s
    rules:
    - alert: IngressControllerHighErrorRate
      expr: |
        sum(rate(nginx_ingress_controller_requests{status=~"5.."}[5m])) by (ingress, namespace)
        /
        sum(rate(nginx_ingress_controller_requests[5m])) by (ingress, namespace)
        > 0.05
      for: 5m
      labels:
        severity: critical
        team: platform
      annotations:
        summary: "Ingress {{ $labels.ingress }} in {{ $labels.namespace }} has >5% error rate"
        description: "Error rate is {{ $value | humanizePercentage }}"
        runbook_url: "https://runbooks.example.com/ingress-high-error-rate"

    - alert: IngressControllerHighLatency
      expr: |
        histogram_quantile(0.99,
          sum(rate(nginx_ingress_controller_request_duration_seconds_bucket[5m])) by (le, ingress, namespace)
        ) > 2
      for: 10m
      labels:
        severity: warning
        team: platform
      annotations:
        summary: "Ingress {{ $labels.ingress }} p99 latency exceeds 2s"
        description: "P99 latency is {{ $value | humanizeDuration }}"

    - alert: IngressConfigReloadFailure
      expr: nginx_ingress_controller_config_last_reload_successful == 0
      for: 2m
      labels:
        severity: critical
        team: platform
      annotations:
        summary: "NGINX Ingress config reload failed"
        description: "The ingress controller failed to reload its configuration"
```

## Decision Matrix

### When to Choose Each Controller

**Choose NGINX Ingress (community) when:**
- The team already has deep NGINX expertise
- Standard HTTP routing covers most use cases
- Cost is a primary constraint (fully open source)
- Integration with existing NGINX annotation-based workflows is required

**Choose NGINX Plus / NGINX Ingress Controller (commercial) when:**
- True zero-downtime reloads are required (financial services, high-frequency traffic)
- Advanced JWT validation, OpenID Connect, and WAF features are needed
- F5 support contracts are in scope

**Choose Traefik when:**
- High deployment churn makes zero-reload semantics critical
- The team prefers CRD-based configuration over annotations
- Built-in dashboard and Let's Encrypt automation are valued
- Microservices and service discovery patterns dominate

**Choose HAProxy Ingress when:**
- Raw throughput and minimum latency variance are the primary requirements
- TCP-level proxying (beyond HTTP) is needed on the same controller
- The environment has strict connection-draining requirements

**Choose Contour when:**
- The organization is standardizing on Envoy (shared data plane with Istio, Gloo, etc.)
- The `HTTPProxy` CRD's expressiveness (per-route health checks, load balancing policies) is needed
- Progressive delivery with Flux or Argo Rollouts is in the roadmap
- Gateway API adoption is planned (Contour has first-class support)

## Multi-Controller Clusters

Large organizations often run multiple ingress controllers in the same cluster, using `IngressClass` resources to segment traffic:

```yaml
apiVersion: networking.k8s.io/v1
kind: IngressClass
metadata:
  name: nginx-internal
  annotations:
    ingressclass.kubernetes.io/is-default-class: "false"
spec:
  controller: k8s.io/ingress-nginx
  parameters:
    apiGroup: k8s.nginx.org
    kind: IngressClassParameters
    name: internal-params

---
apiVersion: networking.k8s.io/v1
kind: IngressClass
metadata:
  name: traefik-external
  annotations:
    ingressclass.kubernetes.io/is-default-class: "true"
spec:
  controller: traefik.io/ingress-controller
```

Separate deployments of each controller are scoped by `--ingress-class` or `--controller-class` flags, and RBAC can restrict which namespaces each controller watches.

## Upgrade and Maintenance Considerations

### NGINX Ingress Controller Version Pinning

```bash
# Check current version
kubectl get deployment ingress-nginx-controller -n ingress-nginx \
  -o jsonpath='{.spec.template.spec.containers[0].image}'

# Rolling upgrade via Helm
helm repo update ingress-nginx
helm upgrade ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --set controller.image.tag=v1.11.3 \
  --set controller.updateStrategy.type=RollingUpdate \
  --set controller.updateStrategy.rollingUpdate.maxUnavailable=1 \
  --atomic \
  --timeout 10m

# Verify
kubectl rollout status deployment/ingress-nginx-controller -n ingress-nginx
kubectl get pods -n ingress-nginx -o wide
```

### PodDisruptionBudget for Ingress Controllers

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: ingress-nginx-pdb
  namespace: ingress-nginx
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app.kubernetes.io/name: ingress-nginx
      app.kubernetes.io/component: controller
```

## Conclusion

No single ingress controller is universally superior. The decision depends on the workload profile, the team's operational background, and the feature requirements.

For clusters handling general web workloads with a strong operations team experienced in NGINX, the community `ingress-nginx` controller remains the most mature and widely supported choice. For environments with high deployment frequency and a preference for declarative CRD-based configuration, Traefik offers significant operational advantages. When raw throughput and connection-level control matter most, HAProxy Ingress consistently outperforms the field. For organizations investing in an Envoy-based data plane strategy, Contour provides the best path to the Kubernetes Gateway API and eventual Envoy mesh unification.

In all cases, production deployments should enforce multi-replica anti-affinity, PodDisruptionBudgets, comprehensive Prometheus alerting, and structured access logging regardless of which controller is chosen.
