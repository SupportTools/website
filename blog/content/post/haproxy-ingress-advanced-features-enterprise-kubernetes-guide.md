---
title: "HAProxy Ingress Advanced Features and Enterprise Deployment: Complete Kubernetes Guide"
date: 2026-07-28T00:00:00-05:00
draft: false
tags: ["HAProxy", "Ingress", "Kubernetes", "Load Balancing", "High Availability", "Enterprise"]
categories: ["Kubernetes", "Networking", "Load Balancing"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to deploying and optimizing HAProxy Ingress Controller in enterprise Kubernetes environments with advanced load balancing, SSL offloading, and high-availability configurations."
more_link: "yes"
url: "/haproxy-ingress-advanced-features-enterprise-kubernetes-guide/"
---

HAProxy Ingress Controller brings the battle-tested performance and flexibility of HAProxy to Kubernetes environments. Known for its exceptional performance in high-traffic scenarios, advanced load balancing algorithms, and granular control over traffic routing, HAProxy Ingress is the choice of enterprises requiring maximum throughput and fine-grained configuration capabilities.

This comprehensive guide explores advanced HAProxy Ingress features, enterprise deployment patterns, performance optimization techniques, and production-tested configurations for handling millions of requests per second across global infrastructure.

<!--more-->

# HAProxy Ingress Advanced Features and Enterprise Deployment

## Executive Summary

HAProxy has been the gold standard for high-performance load balancing for over two decades. The HAProxy Ingress Controller brings this proven technology to Kubernetes, offering superior performance characteristics, extensive protocol support, and enterprise-grade features that distinguish it from other ingress solutions.

In this guide, we'll cover advanced deployment strategies, sophisticated traffic routing patterns, SSL/TLS optimization, observability integration, and multi-cluster configurations that enable HAProxy Ingress to serve as the foundation for enterprise-scale Kubernetes networking.

## HAProxy vs Other Ingress Controllers

### Performance Characteristics

HAProxy Ingress typically achieves:
- **Throughput**: 100K-500K requests/second per instance
- **Latency**: P99 < 5ms for simple proxying
- **Connections**: 1M+ concurrent connections per instance
- **SSL/TLS**: 50K+ TLS handshakes/second

### Key Differentiators

1. **Advanced Load Balancing**: Sophisticated algorithms including least connection, source hash, URI hash, and custom header-based routing
2. **Health Checking**: Comprehensive health check options with customizable intervals and failure detection
3. **Traffic Shaping**: Precise control over traffic flow with rate limiting, connection limiting, and queue management
4. **Protocol Support**: Native support for HTTP/1.1, HTTP/2, WebSocket, gRPC, TCP, and custom protocols
5. **Dynamic Configuration**: Zero-downtime configuration updates with runtime API

## Installation and Initial Configuration

### Installing HAProxy Ingress Controller

```bash
# Add HAProxy Ingress Helm repository
helm repo add haproxy-ingress https://haproxy-ingress.github.io/charts
helm repo update

# Create namespace
kubectl create namespace haproxy-ingress

# Install with enterprise configuration
helm install haproxy-ingress haproxy-ingress/haproxy-ingress \
  --namespace haproxy-ingress \
  --version 0.14.4 \
  --values haproxy-ingress-values.yaml
```

### Enterprise-Grade Helm Values

Create `haproxy-ingress-values.yaml`:

```yaml
controller:
  # Resource allocation
  resources:
    limits:
      cpu: "8000m"
      memory: "8Gi"
    requests:
      cpu: "4000m"
      memory: "4Gi"

  # Replica configuration
  replicaCount: 3

  # Horizontal Pod Autoscaling
  autoscaling:
    enabled: true
    minReplicas: 3
    maxReplicas: 20
    targetCPUUtilizationPercentage: 70
    targetMemoryUtilizationPercentage: 80

  # Pod Disruption Budget
  podDisruptionBudget:
    enabled: true
    minAvailable: 2

  # High availability configuration
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchExpressions:
              - key: app.kubernetes.io/name
                operator: In
                values:
                  - haproxy-ingress
          topologyKey: kubernetes.io/hostname
        - labelSelector:
            matchExpressions:
              - key: app.kubernetes.io/name
                operator: In
                values:
                  - haproxy-ingress
          topologyKey: topology.kubernetes.io/zone

  # Node selection for dedicated ingress nodes
  nodeSelector:
    node-role.kubernetes.io/ingress: "true"

  tolerations:
    - key: "ingress"
      operator: "Equal"
      value: "true"
      effect: "NoSchedule"

  # Service configuration
  service:
    type: LoadBalancer
    externalTrafficPolicy: Local  # Preserve source IP
    annotations:
      service.beta.kubernetes.io/aws-load-balancer-type: "nlb"
      service.beta.kubernetes.io/aws-load-balancer-backend-protocol: "tcp"
      service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "true"
      service.beta.kubernetes.io/aws-load-balancer-proxy-protocol: "*"

  # Configuration options
  config:
    # Global HAProxy configuration
    backend-check-interval: "2s"
    backend-server-slots-increment: "32"
    bind-ip-addr-healthz: "0.0.0.0"
    bind-ip-addr-http: "0.0.0.0"
    bind-ip-addr-prometheus: "0.0.0.0"
    bind-ip-addr-stats: "0.0.0.0"
    bind-ip-addr-tcp: "0.0.0.0"

    # Connection settings
    max-connections: "1000000"
    nbthread: "8"
    timeout-client: "50s"
    timeout-client-fin: "50s"
    timeout-connect: "5s"
    timeout-http-request: "5s"
    timeout-keep-alive: "1m"
    timeout-queue: "5s"
    timeout-server: "50s"
    timeout-server-fin: "50s"
    timeout-stop: "10m"
    timeout-tunnel: "1h"

    # SSL/TLS configuration
    ssl-ciphers: "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305"
    ssl-dh-default-max-size: "2048"
    ssl-dh-param: "ssl-dh-param-2048"
    ssl-engine: "openssl"
    ssl-mode-async: "true"
    ssl-options: "no-sslv3 no-tlsv10 no-tlsv11 no-tls-tickets"
    ssl-redirect: "true"

    # Health check configuration
    health-check-addr: "0.0.0.0"
    health-check-fall-count: "3"
    health-check-interval: "2s"
    health-check-port: "10253"
    health-check-rise-count: "2"

    # Load balancing
    balance-algorithm: "leastconn"
    backend-protocol: "h1"

    # Rate limiting
    use-cpu-map: "true"

    # Stats and metrics
    stats: "true"
    stats-auth: "admin:$(openssl rand -base64 32)"
    stats-port: "1936"
    stats-ssl-cert: "/etc/haproxy/ssl/stats.pem"

    # Proxy protocol
    use-proxy-protocol: "true"

    # Dynamic configuration
    dynamic-scaling: "true"

    # Syslog
    syslog-endpoint: "127.0.0.1:514"
    syslog-format: "rfc5424"
    syslog-tag: "haproxy"

  # Logging
  logging:
    level: "info"

  # Metrics
  metrics:
    enabled: true
    port: 9101
    service:
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9101"
      type: ClusterIP

  # Stats
  stats:
    enabled: true
    port: 1936

  # Lifecycle management
  lifecycle:
    preStop:
      exec:
        command:
          - /bin/sh
          - -c
          - sleep 15
  terminationGracePeriodSeconds: 300

  # Security context
  securityContext:
    capabilities:
      add:
        - NET_BIND_SERVICE
      drop:
        - ALL
    runAsNonRoot: true
    runAsUser: 1000

# Default backend
defaultBackend:
  enabled: true
  replicaCount: 2
  resources:
    limits:
      cpu: "100m"
      memory: "128Mi"
    requests:
      cpu: "50m"
      memory: "64Mi"
```

## Advanced Load Balancing Configurations

### Least Connection Algorithm

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: least-conn-ingress
  namespace: production
  annotations:
    haproxy.org/load-balance: "leastconn"
    haproxy.org/check: "enabled"
    haproxy.org/check-interval: "2s"
spec:
  ingressClassName: haproxy
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

### Consistent Hash Load Balancing

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: consistent-hash-ingress
  namespace: production
  annotations:
    haproxy.org/load-balance: "uri"
    haproxy.org/hash-type: "consistent"
    haproxy.org/check: "enabled"
spec:
  ingressClassName: haproxy
  rules:
    - host: cache.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: cache-service
                port:
                  number: 8080
```

### Source IP Hash with Sticky Sessions

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: sticky-session-ingress
  namespace: production
  annotations:
    haproxy.org/load-balance: "source"
    haproxy.org/cookie-persistence: "SERVERID insert indirect nocache"
    haproxy.org/session-cookie-name: "HAPROXY_SESSION"
    haproxy.org/session-cookie-strategy: "insert"
    haproxy.org/session-cookie-keywords: "indirect nocache httponly secure"
spec:
  ingressClassName: haproxy
  rules:
    - host: app.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: app-service
                port:
                  number: 8080
```

### Custom Header-Based Routing

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: header-routing-ingress
  namespace: production
  annotations:
    haproxy.org/request-set-header: |
      X-Backend-Version stable
    haproxy.org/server-template: "web 10 _http._tcp.app-service.production.svc.cluster.local check resolvers coredns init-addr last,libc,none"
spec:
  ingressClassName: haproxy
  rules:
    - host: app.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: app-service
                port:
                  number: 8080
```

## Advanced Health Checking

### HTTP Health Checks with Custom Parameters

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: custom-health-check-ingress
  namespace: production
  annotations:
    haproxy.org/check: "enabled"
    haproxy.org/check-http: "/health"
    haproxy.org/check-interval: "2s"
    haproxy.org/check-timeout: "1s"
    haproxy.org/rise: "2"
    haproxy.org/fall: "3"
    haproxy.org/inter: "2s"
    haproxy.org/fastinter: "1s"
    haproxy.org/downinter: "5s"
spec:
  ingressClassName: haproxy
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

### TCP Health Checks

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: haproxy-tcp-services
  namespace: haproxy-ingress
data:
  "5432": "database/postgres-service:5432:check:check-send-proxy:send-proxy-v2:health-check-port:5432"
```

### Advanced Health Check with Expected Response

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: advanced-health-check
  namespace: production
  annotations:
    haproxy.org/check: "enabled"
    haproxy.org/check-http: "GET /health HTTP/1.1\\r\\nHost:\\ api.example.com"
    haproxy.org/check-expect: "status 200"
    haproxy.org/check-interval: "2s"
spec:
  ingressClassName: haproxy
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

## SSL/TLS Configuration and Optimization

### Multi-Certificate Configuration

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: multi-cert-ingress
  namespace: production
  annotations:
    haproxy.org/ssl-certificate: "production/app-tls-cert,production/api-tls-cert"
    haproxy.org/ssl-redirect: "true"
    haproxy.org/ssl-passthrough: "false"
spec:
  ingressClassName: haproxy
  tls:
    - hosts:
        - app.example.com
      secretName: app-tls-cert
    - hosts:
        - api.example.com
      secretName: api-tls-cert
  rules:
    - host: app.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: app-service
                port:
                  number: 8080
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

### SSL Passthrough Configuration

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ssl-passthrough-ingress
  namespace: production
  annotations:
    haproxy.org/ssl-passthrough: "true"
    haproxy.org/ssl-passthrough-http-port: "80"
spec:
  ingressClassName: haproxy
  rules:
    - host: secure.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: secure-service
                port:
                  number: 443
```

### OCSP Stapling Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: haproxy-ssl-config
  namespace: haproxy-ingress
data:
  ssl-options: "no-sslv3 no-tlsv10 no-tlsv11 no-tls-tickets"
  ssl-ciphers: "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384"
  ssl-dh-param: "ssl-dh-param-2048"
  ssl-engine: "openssl"
  ssl-mode-async: "true"
```

## Rate Limiting and Traffic Shaping

### Request Rate Limiting

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: rate-limited-ingress
  namespace: production
  annotations:
    haproxy.org/rate-limit: "100"
    haproxy.org/rate-limit-period: "1s"
    haproxy.org/rate-limit-status-code: "429"
spec:
  ingressClassName: haproxy
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /api/v1/public
            pathType: Prefix
            backend:
              service:
                name: api-service
                port:
                  number: 8080
```

### Connection Rate Limiting

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: conn-rate-limited-ingress
  namespace: production
  annotations:
    haproxy.org/connection-mode: "http-keep-alive"
    haproxy.org/maxconn: "1000"
    haproxy.org/rate-limit-connections: "50"
spec:
  ingressClassName: haproxy
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

### Bandwidth Limiting

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: bandwidth-limited-ingress
  namespace: production
  annotations:
    haproxy.org/request-capture: "req.hdr(User-Agent) len 128"
    haproxy.org/response-capture: "res.hdr(Content-Length) len 10"
    haproxy.org/timeout-server: "30s"
spec:
  ingressClassName: haproxy
  rules:
    - host: download.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: download-service
                port:
                  number: 8080
```

## Advanced Routing Patterns

### Blue-Green Deployment with Traffic Splitting

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: blue-green-ingress
  namespace: production
  annotations:
    haproxy.org/server-template: |
      blue 5 _http._tcp.app-blue.production.svc.cluster.local:8080 check weight 90 resolvers coredns
      green 5 _http._tcp.app-green.production.svc.cluster.local:8080 check weight 10 resolvers coredns
spec:
  ingressClassName: haproxy
  rules:
    - host: app.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: app-blue
                port:
                  number: 8080
```

### Canary Deployment with Header-Based Routing

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: canary-ingress
  namespace: production
  annotations:
    haproxy.org/request-set-header: |
      X-Canary-Weight 10
    haproxy.org/backend-config-snippet: |
      acl is_canary hdr(X-Canary) -i true
      use-server canary if is_canary
spec:
  ingressClassName: haproxy
  rules:
    - host: app.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: app-stable
                port:
                  number: 8080
```

### Path-Based Routing with Rewrites

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: path-rewrite-ingress
  namespace: production
  annotations:
    haproxy.org/path-rewrite: "/api/(.*) /\\1"
    haproxy.org/request-set-header: |
      X-Forwarded-Prefix /api
spec:
  ingressClassName: haproxy
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: api-service
                port:
                  number: 8080
          - path: /v2
            pathType: Prefix
            backend:
              service:
                name: api-v2-service
                port:
                  number: 8080
```

## TCP and UDP Load Balancing

### TCP Service Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: haproxy-tcp-services
  namespace: haproxy-ingress
data:
  # PostgreSQL
  "5432": "database/postgres-service:5432:check:send-proxy-v2"
  # Redis
  "6379": "cache/redis-service:6379:check"
  # MySQL
  "3306": "database/mysql-service:3306:check:check-interval:2s"
```

### UDP Service Configuration (HAProxy 2.3+)

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: haproxy-udp-services
  namespace: haproxy-ingress
data:
  # DNS
  "53": "dns/dns-service:53"
  # SNMP
  "161": "monitoring/snmp-service:161"
```

### Custom TCP Frontend Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: haproxy-custom-frontend
  namespace: haproxy-ingress
data:
  frontend-config-snippet: |
    frontend postgres_frontend
        bind *:5432
        mode tcp
        option tcplog
        default_backend postgres_backend

    backend postgres_backend
        mode tcp
        balance leastconn
        option tcp-check
        tcp-check connect port 5432
        server postgres1 postgres-1.database.svc.cluster.local:5432 check
        server postgres2 postgres-2.database.svc.cluster.local:5432 check
        server postgres3 postgres-3.database.svc.cluster.local:5432 check backup
```

## Monitoring and Observability

### Prometheus Metrics Configuration

```yaml
apiVersion: v1
kind: Service
metadata:
  name: haproxy-metrics
  namespace: haproxy-ingress
  labels:
    app: haproxy-ingress
  annotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "9101"
    prometheus.io/path: "/metrics"
spec:
  type: ClusterIP
  ports:
    - name: metrics
      port: 9101
      targetPort: 9101
      protocol: TCP
  selector:
    app.kubernetes.io/name: haproxy-ingress
```

### ServiceMonitor for Prometheus Operator

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: haproxy-ingress
  namespace: monitoring
  labels:
    app: haproxy-ingress
spec:
  jobLabel: haproxy-ingress
  selector:
    matchLabels:
      app: haproxy-ingress
  namespaceSelector:
    matchNames:
      - haproxy-ingress
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
      scheme: http
```

### HAProxy Stats Dashboard Access

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: haproxy-stats
  namespace: haproxy-ingress
  annotations:
    haproxy.org/whitelist: "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
    haproxy.org/auth-type: "basic-auth"
    haproxy.org/auth-secret: "haproxy-stats-auth"
spec:
  ingressClassName: haproxy
  rules:
    - host: haproxy-stats.internal.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: haproxy-ingress-stats
                port:
                  number: 1936
```

### Custom Logging Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: haproxy-logging-config
  namespace: haproxy-ingress
data:
  syslog-endpoint: "fluentd.logging.svc.cluster.local:514"
  syslog-format: "rfc5424"
  syslog-tag: "haproxy"
  log-format: "%ci:%cp [%tr] %ft %b/%s %TR/%Tw/%Tc/%Tr/%Ta %ST %B %CC %CS %tsc %ac/%fc/%bc/%sc/%rc %sq/%bq %hr %hs %{+Q}r"
```

## Multi-Cluster and Global Load Balancing

### External DNS Integration

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: global-app-ingress
  namespace: production
  annotations:
    external-dns.alpha.kubernetes.io/hostname: "app.example.com"
    external-dns.alpha.kubernetes.io/ttl: "60"
    haproxy.org/check: "enabled"
spec:
  ingressClassName: haproxy
  rules:
    - host: app.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: app-service
                port:
                  number: 8080
```

### Multi-Cluster Service Discovery

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: haproxy-multi-cluster
  namespace: haproxy-ingress
data:
  backend-config-snippet: |
    backend multi_cluster_backend
        balance roundrobin
        option httpchk GET /health HTTP/1.1\r\nHost:\ api.example.com
        http-check expect status 200

        # Cluster 1 servers
        server cluster1-srv1 cluster1-lb.example.com:443 check ssl verify required ca-file /etc/ssl/certs/ca-certificates.crt weight 100
        server cluster1-srv2 cluster1-lb-backup.example.com:443 check ssl verify required ca-file /etc/ssl/certs/ca-certificates.crt weight 100 backup

        # Cluster 2 servers
        server cluster2-srv1 cluster2-lb.example.com:443 check ssl verify required ca-file /etc/ssl/certs/ca-certificates.crt weight 100
        server cluster2-srv2 cluster2-lb-backup.example.com:443 check ssl verify required ca-file /etc/ssl/certs/ca-certificates.crt weight 100 backup
```

## Performance Tuning

### Kernel Optimization for HAProxy

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: haproxy-node-tuning
  namespace: haproxy-ingress
spec:
  selector:
    matchLabels:
      app: haproxy-node-tuning
  template:
    metadata:
      labels:
        app: haproxy-node-tuning
    spec:
      hostNetwork: true
      hostPID: true
      nodeSelector:
        node-role.kubernetes.io/ingress: "true"
      tolerations:
        - key: "ingress"
          operator: "Equal"
          value: "true"
          effect: "NoSchedule"
      initContainers:
        - name: sysctl-tuning
          image: busybox
          securityContext:
            privileged: true
          command:
            - sh
            - -c
            - |
              # TCP optimization
              sysctl -w net.core.somaxconn=65535
              sysctl -w net.core.netdev_max_backlog=65535
              sysctl -w net.ipv4.tcp_max_syn_backlog=65535
              sysctl -w net.ipv4.tcp_fin_timeout=15
              sysctl -w net.ipv4.tcp_tw_reuse=1
              sysctl -w net.ipv4.tcp_timestamps=1
              sysctl -w net.ipv4.tcp_window_scaling=1

              # Buffer sizes
              sysctl -w net.core.rmem_max=16777216
              sysctl -w net.core.wmem_max=16777216
              sysctl -w net.ipv4.tcp_rmem="4096 87380 16777216"
              sysctl -w net.ipv4.tcp_wmem="4096 65536 16777216"

              # Connection tracking
              sysctl -w net.netfilter.nf_conntrack_max=2097152
              sysctl -w net.nf_conntrack_max=2097152

              # File descriptors
              sysctl -w fs.file-max=2097152

              echo "HAProxy kernel tuning applied"
      containers:
        - name: pause
          image: gcr.io/google_containers/pause:3.2
```

### HAProxy Runtime API Access

```bash
#!/bin/bash
# haproxy-runtime-api.sh - Interact with HAProxy Runtime API

POD=$(kubectl get pods -n haproxy-ingress -l app.kubernetes.io/name=haproxy-ingress -o jsonpath='{.items[0].metadata.name}')

# Show current statistics
echo "=== HAProxy Statistics ==="
kubectl exec -n haproxy-ingress $POD -- sh -c 'echo "show stat" | socat stdio /var/lib/haproxy/run/admin.sock'

# Show backend servers
echo -e "\n=== Backend Servers ==="
kubectl exec -n haproxy-ingress $POD -- sh -c 'echo "show servers state" | socat stdio /var/lib/haproxy/run/admin.sock'

# Show current connections
echo -e "\n=== Current Connections ==="
kubectl exec -n haproxy-ingress $POD -- sh -c 'echo "show sess" | socat stdio /var/lib/haproxy/run/admin.sock'

# Show errors
echo -e "\n=== Error Statistics ==="
kubectl exec -n haproxy-ingress $POD -- sh -c 'echo "show errors" | socat stdio /var/lib/haproxy/run/admin.sock'
```

## Troubleshooting and Debugging

### Debug Mode Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: haproxy-debug-config
  namespace: haproxy-ingress
data:
  log-level: "debug"
  log-format: "%ci:%cp [%t] %ft %b/%s %Tq/%Tw/%Tc/%Tr/%Tt %ST %B %CC %CS %tsc %ac/%fc/%bc/%sc/%rc %sq/%bq %hr %hs %{+Q}r"
```

### Configuration Validation

```bash
#!/bin/bash
# haproxy-validate-config.sh

POD=$(kubectl get pods -n haproxy-ingress -l app.kubernetes.io/name=haproxy-ingress -o jsonpath='{.items[0].metadata.name}')

echo "=== Validating HAProxy Configuration ==="
kubectl exec -n haproxy-ingress $POD -- haproxy -c -f /etc/haproxy/haproxy.cfg

if [ $? -eq 0 ]; then
    echo "Configuration is valid"
else
    echo "Configuration has errors"
    exit 1
fi

echo -e "\n=== Current Configuration ==="
kubectl exec -n haproxy-ingress $POD -- cat /etc/haproxy/haproxy.cfg
```

### Common Issues and Solutions

```bash
#!/bin/bash
# haproxy-troubleshoot.sh

echo "=== HAProxy Ingress Troubleshooting ==="

# Check pod status
echo -e "\n1. Pod Status:"
kubectl get pods -n haproxy-ingress -l app.kubernetes.io/name=haproxy-ingress

# Check service endpoints
echo -e "\n2. Service Endpoints:"
kubectl get endpoints -n haproxy-ingress

# Check recent logs
echo -e "\n3. Recent Logs:"
kubectl logs -n haproxy-ingress -l app.kubernetes.io/name=haproxy-ingress --tail=50

# Check configuration
echo -e "\n4. Configuration Status:"
POD=$(kubectl get pods -n haproxy-ingress -l app.kubernetes.io/name=haproxy-ingress -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n haproxy-ingress $POD -- haproxy -vv

# Check resource usage
echo -e "\n5. Resource Usage:"
kubectl top pods -n haproxy-ingress

# Check ingress resources
echo -e "\n6. Ingress Resources:"
kubectl get ingress --all-namespaces -o wide
```

## Production Best Practices

### High Availability Configuration

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: haproxy-ingress
  namespace: haproxy-ingress
spec:
  replicas: 5
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 1
  template:
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchExpressions:
                  - key: app.kubernetes.io/name
                    operator: In
                    values:
                      - haproxy-ingress
              topologyKey: kubernetes.io/hostname
            - labelSelector:
                matchExpressions:
                  - key: app.kubernetes.io/name
                    operator: In
                    values:
                      - haproxy-ingress
              topologyKey: topology.kubernetes.io/zone
```

### Graceful Shutdown

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: haproxy-ingress
  namespace: haproxy-ingress
spec:
  template:
    spec:
      containers:
        - name: haproxy-ingress
          lifecycle:
            preStop:
              exec:
                command:
                  - /bin/sh
                  - -c
                  - sleep 30
      terminationGracePeriodSeconds: 300
```

## Conclusion

HAProxy Ingress Controller provides enterprise-grade performance and flexibility for Kubernetes networking. Its advanced load balancing algorithms, comprehensive health checking, sophisticated traffic routing, and extensive configuration options make it ideal for high-performance production environments.

Key advantages of HAProxy Ingress:
- Superior performance and throughput
- Advanced load balancing algorithms
- Comprehensive health checking capabilities
- Native TCP/UDP load balancing support
- Runtime configuration API
- Battle-tested stability and reliability

By leveraging the configurations and patterns in this guide, you can build robust, high-performance ingress infrastructure capable of handling enterprise-scale traffic while maintaining low latency and high availability.