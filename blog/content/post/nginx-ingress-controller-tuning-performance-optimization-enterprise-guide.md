---
title: "NGINX Ingress Controller Performance Tuning and Optimization: Enterprise Production Guide"
date: 2026-10-11T00:00:00-05:00
draft: false
tags: ["NGINX", "Ingress", "Kubernetes", "Load Balancing", "Performance", "Optimization", "Enterprise"]
categories: ["Kubernetes", "Networking", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to optimizing NGINX Ingress Controller for enterprise Kubernetes environments with advanced tuning, performance optimization, and production best practices."
more_link: "yes"
url: "/nginx-ingress-controller-tuning-performance-optimization-enterprise-guide/"
---

NGINX Ingress Controller is the most widely deployed ingress solution for Kubernetes, powering millions of applications worldwide. However, default configurations rarely meet enterprise performance requirements. This comprehensive guide covers advanced tuning techniques, performance optimization strategies, and production best practices for maximizing NGINX Ingress Controller efficiency in large-scale deployments.

In this guide, we'll explore enterprise-grade configuration patterns, connection pooling strategies, SSL/TLS optimization, rate limiting, caching mechanisms, and monitoring approaches that ensure your ingress layer can handle production traffic at scale.

<!--more-->

# NGINX Ingress Controller Performance Tuning and Optimization

## Executive Summary

The NGINX Ingress Controller serves as the critical entry point for external traffic into Kubernetes clusters. While NGINX is renowned for its performance and reliability, achieving optimal results requires careful tuning of numerous parameters across multiple layers: kernel settings, NGINX configuration, Kubernetes resources, and application-specific optimizations.

This guide provides production-tested configurations for handling high-throughput scenarios (>100K requests/second), low-latency requirements (<10ms P99), and enterprise-scale deployments with thousands of services and ingress rules.

## Understanding NGINX Ingress Architecture

### Core Components

The NGINX Ingress Controller consists of several key components:

1. **Controller Pod**: Watches Kubernetes API for Ingress resources and updates NGINX configuration
2. **NGINX Process**: Handles actual HTTP/HTTPS traffic routing
3. **ConfigMaps**: Store global and per-ingress configurations
4. **Services**: Expose the ingress controller (LoadBalancer, NodePort, or HostNetwork)

### Traffic Flow

```
External Request → LoadBalancer/NodePort → NGINX Pod → Service → Backend Pods
```

Understanding this flow is critical for optimization at each layer.

## Installing NGINX Ingress Controller

### Helm Installation with Performance Optimizations

```bash
# Add the NGINX Ingress Helm repository
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update

# Create namespace
kubectl create namespace ingress-nginx

# Install with optimized values
helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --version 4.8.3 \
  --values nginx-ingress-values.yaml
```

### Optimized Helm Values Configuration

Create `nginx-ingress-values.yaml`:

```yaml
controller:
  # Resource allocation for high-traffic scenarios
  resources:
    limits:
      cpu: "4000m"
      memory: "4Gi"
    requests:
      cpu: "2000m"
      memory: "2Gi"

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

  # Anti-affinity for high availability
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchExpressions:
              - key: app.kubernetes.io/name
                operator: In
                values:
                  - ingress-nginx
          topologyKey: kubernetes.io/hostname

  # Node selection for dedicated ingress nodes
  nodeSelector:
    node-role.kubernetes.io/ingress: "true"

  # Tolerations for dedicated nodes
  tolerations:
    - key: "ingress"
      operator: "Equal"
      value: "true"
      effect: "NoSchedule"

  # Use host network for better performance
  hostNetwork: false
  dnsPolicy: ClusterFirstWithHostNet

  # Service configuration
  service:
    enabled: true
    type: LoadBalancer
    externalTrafficPolicy: Local  # Preserve source IP
    annotations:
      service.beta.kubernetes.io/aws-load-balancer-type: "nlb"
      service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "true"
      service.beta.kubernetes.io/aws-load-balancer-backend-protocol: "tcp"

  # Performance-critical configurations
  config:
    # Worker processes and connections
    worker-processes: "auto"
    worker-connections: "65536"
    worker-rlimit-nofile: "131072"

    # Connection optimization
    keepalive-requests: "10000"
    keepalive-timeout: "75"
    upstream-keepalive-connections: "320"
    upstream-keepalive-requests: "10000"
    upstream-keepalive-timeout: "60"

    # Buffer optimization
    client-body-buffer-size: "128k"
    client-header-buffer-size: "8k"
    large-client-header-buffers: "4 32k"
    proxy-body-size: "50m"
    proxy-buffer-size: "16k"
    proxy-buffers: "8 16k"

    # Timeout optimization
    proxy-connect-timeout: "10"
    proxy-send-timeout: "60"
    proxy-read-timeout: "60"
    client-body-timeout: "60"
    client-header-timeout: "60"

    # SSL/TLS optimization
    ssl-protocols: "TLSv1.2 TLSv1.3"
    ssl-ciphers: "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384"
    ssl-prefer-server-ciphers: "on"
    ssl-session-cache: "shared:SSL:50m"
    ssl-session-timeout: "1d"
    ssl-session-tickets: "false"
    ssl-buffer-size: "4k"

    # Enable HTTP/2
    use-http2: "true"
    http2-max-field-size: "16k"
    http2-max-header-size: "32k"

    # Compression
    use-gzip: "true"
    gzip-level: "5"
    gzip-types: "application/atom+xml application/javascript application/json application/rss+xml application/vnd.ms-fontobject application/x-font-ttf application/x-web-app-manifest+json application/xhtml+xml application/xml font/opentype image/svg+xml image/x-icon text/css text/plain text/x-component"

    # Rate limiting
    limit-req-status-code: "429"
    limit-conn-status-code: "429"

    # Security headers
    hide-headers: "X-Powered-By,Server"
    add-headers: "ingress-nginx/custom-headers"

    # Logging
    log-format-upstream: '$remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent "$http_referer" "$http_user_agent" $request_length $request_time [$proxy_upstream_name] [$proxy_alternative_upstream_name] $upstream_addr $upstream_response_length $upstream_response_time $upstream_status $req_id'
    access-log-path: /var/log/nginx/access.log
    error-log-path: /var/log/nginx/error.log

    # Performance features
    enable-real-ip: "true"
    proxy-real-ip-cidr: "0.0.0.0/0"
    use-forwarded-headers: "true"
    compute-full-forwarded-for: "true"
    use-proxy-protocol: "false"

    # Optimization flags
    server-tokens: "false"
    enable-underscores-in-headers: "true"
    ignore-invalid-headers: "true"

    # Load balancing
    load-balance: "ewma"  # Exponentially weighted moving average

  # Metrics and monitoring
  metrics:
    enabled: true
    service:
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "10254"
    serviceMonitor:
      enabled: true
      namespace: monitoring

  # Admission webhooks
  admissionWebhooks:
    enabled: true
    failurePolicy: Fail
    port: 8443

  # Lifecycle hooks for graceful shutdown
  lifecycle:
    preStop:
      exec:
        command:
          - /wait-shutdown

  terminationGracePeriodSeconds: 300

# Default backend
defaultBackend:
  enabled: true
  resources:
    limits:
      cpu: "100m"
      memory: "128Mi"
    requests:
      cpu: "50m"
      memory: "64Mi"
```

## Kernel-Level Optimizations

### Sysctl Tuning for High Performance

Create a DaemonSet to apply kernel tuning on ingress nodes:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: ingress-node-tuning
  namespace: ingress-nginx
spec:
  selector:
    matchLabels:
      app: ingress-node-tuning
  template:
    metadata:
      labels:
        app: ingress-node-tuning
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
              sysctl -w net.ipv4.tcp_tw_recycle=0
              sysctl -w net.ipv4.tcp_keepalive_time=300
              sysctl -w net.ipv4.tcp_keepalive_probes=5
              sysctl -w net.ipv4.tcp_keepalive_intvl=15
              sysctl -w net.ipv4.tcp_slow_start_after_idle=0
              sysctl -w net.ipv4.tcp_timestamps=1
              sysctl -w net.ipv4.tcp_sack=1
              sysctl -w net.ipv4.tcp_window_scaling=1

              # Buffer sizes
              sysctl -w net.core.rmem_default=262144
              sysctl -w net.core.rmem_max=16777216
              sysctl -w net.core.wmem_default=262144
              sysctl -w net.core.wmem_max=16777216
              sysctl -w net.ipv4.tcp_rmem="4096 87380 16777216"
              sysctl -w net.ipv4.tcp_wmem="4096 65536 16777216"

              # Connection tracking
              sysctl -w net.netfilter.nf_conntrack_max=1048576
              sysctl -w net.nf_conntrack_max=1048576

              # File descriptors
              sysctl -w fs.file-max=2097152
              sysctl -w fs.nr_open=2097152

              # IP local port range
              sysctl -w net.ipv4.ip_local_port_range="1024 65535"

              echo "Kernel tuning applied successfully"
      containers:
        - name: pause
          image: gcr.io/google_containers/pause:3.2
```

## Advanced Ingress Configurations

### High-Performance Ingress Resource

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: high-performance-app
  namespace: production
  annotations:
    # Connection management
    nginx.ingress.kubernetes.io/upstream-keepalive-connections: "320"
    nginx.ingress.kubernetes.io/upstream-keepalive-timeout: "60"
    nginx.ingress.kubernetes.io/upstream-keepalive-requests: "10000"

    # Load balancing
    nginx.ingress.kubernetes.io/load-balance: "ewma"
    nginx.ingress.kubernetes.io/upstream-hash-by: "$binary_remote_addr"

    # Timeouts
    nginx.ingress.kubernetes.io/proxy-connect-timeout: "10"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "60"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "60"
    nginx.ingress.kubernetes.io/proxy-body-size: "50m"

    # SSL/TLS
    nginx.ingress.kubernetes.io/ssl-protocols: "TLSv1.2 TLSv1.3"
    nginx.ingress.kubernetes.io/ssl-ciphers: "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256"
    nginx.ingress.kubernetes.io/ssl-prefer-server-ciphers: "on"
    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"

    # Rate limiting (per IP)
    nginx.ingress.kubernetes.io/limit-rps: "100"
    nginx.ingress.kubernetes.io/limit-burst-multiplier: "5"

    # Connection limiting
    nginx.ingress.kubernetes.io/limit-connections: "20"

    # Caching
    nginx.ingress.kubernetes.io/proxy-buffering: "on"
    nginx.ingress.kubernetes.io/proxy-buffer-size: "16k"
    nginx.ingress.kubernetes.io/proxy-buffers-number: "8"

    # Security headers
    nginx.ingress.kubernetes.io/configuration-snippet: |
      more_set_headers "X-Frame-Options: DENY";
      more_set_headers "X-Content-Type-Options: nosniff";
      more_set_headers "X-XSS-Protection: 1; mode=block";
      more_set_headers "Strict-Transport-Security: max-age=31536000; includeSubDomains";
      more_set_headers "Content-Security-Policy: default-src 'self'";

    # Enable HTTP/2
    nginx.ingress.kubernetes.io/http2-push-preload: "true"

    # Monitoring
    nginx.ingress.kubernetes.io/enable-opentracing: "true"

spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - api.example.com
      secretName: api-tls-cert
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

### Advanced Rate Limiting Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: nginx-rate-limit-config
  namespace: ingress-nginx
data:
  # Global rate limiting zones
  http-snippet: |
    # Define rate limit zones
    limit_req_zone $binary_remote_addr zone=global_limit:10m rate=100r/s;
    limit_req_zone $server_name zone=per_vhost:10m rate=1000r/s;
    limit_req_zone $uri zone=per_uri:10m rate=50r/s;
    limit_conn_zone $binary_remote_addr zone=conn_limit:10m;

    # Geo-based rate limiting
    geo $rate_limit_key {
        default $binary_remote_addr;
        # Whitelist internal networks
        10.0.0.0/8 "";
        172.16.0.0/12 "";
        192.168.0.0/16 "";
    }

    limit_req_zone $rate_limit_key zone=geo_limit:10m rate=200r/s;

    # Define cache zones
    proxy_cache_path /var/cache/nginx/api levels=1:2 keys_zone=api_cache:100m max_size=10g inactive=60m use_temp_path=off;
    proxy_cache_path /var/cache/nginx/static levels=1:2 keys_zone=static_cache:100m max_size=1g inactive=7d use_temp_path=off;
```

### Per-Path Rate Limiting Ingress

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-with-rate-limits
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/server-snippet: |
      # Apply different rate limits per path
      location /api/v1/public {
          limit_req zone=global_limit burst=50 nodelay;
          limit_conn conn_limit 10;
          proxy_pass http://upstream_balancer;
      }

      location /api/v1/premium {
          limit_req zone=global_limit burst=200 nodelay;
          limit_conn conn_limit 50;
          proxy_pass http://upstream_balancer;
      }

      location /api/v1/internal {
          # No rate limiting for internal APIs
          allow 10.0.0.0/8;
          deny all;
          proxy_pass http://upstream_balancer;
      }
spec:
  ingressClassName: nginx
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
```

## SSL/TLS Optimization

### Certificate Management with cert-manager

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: admin@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-key
    solvers:
      - http01:
          ingress:
            class: nginx
```

### Wildcard Certificate Configuration

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: wildcard-cert
  namespace: ingress-nginx
spec:
  secretName: wildcard-tls-cert
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  commonName: "*.example.com"
  dnsNames:
    - "*.example.com"
    - "example.com"
  privateKey:
    algorithm: ECDSA
    size: 256
```

### SSL Session Caching

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: nginx-ssl-config
  namespace: ingress-nginx
data:
  ssl-session-cache: "shared:SSL:50m"
  ssl-session-timeout: "1d"
  ssl-session-tickets: "false"
  ssl-protocols: "TLSv1.2 TLSv1.3"
  ssl-ciphers: "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305"
  ssl-prefer-server-ciphers: "on"
  ssl-ecdh-curve: "X25519:P-256:P-384"
  ssl-buffer-size: "4k"
  enable-ocsp: "true"
  hsts: "true"
  hsts-max-age: "31536000"
  hsts-include-subdomains: "true"
  hsts-preload: "true"
```

## Caching Strategies

### Static Content Caching

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: static-content-ingress
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/configuration-snippet: |
      # Cache static content
      location ~* \.(jpg|jpeg|png|gif|ico|css|js|svg|woff|woff2|ttf|eot)$ {
          proxy_cache static_cache;
          proxy_cache_valid 200 7d;
          proxy_cache_valid 404 1m;
          proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
          proxy_cache_background_update on;
          proxy_cache_lock on;
          add_header X-Cache-Status $upstream_cache_status;
          expires 7d;
          add_header Cache-Control "public, immutable";
      }
spec:
  ingressClassName: nginx
  rules:
    - host: cdn.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: cdn-service
                port:
                  number: 8080
```

### API Response Caching

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-cache-ingress
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/configuration-snippet: |
      # Cache GET requests
      proxy_cache api_cache;
      proxy_cache_methods GET HEAD;
      proxy_cache_key "$scheme$request_method$host$request_uri";
      proxy_cache_valid 200 5m;
      proxy_cache_valid 404 1m;
      proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
      proxy_cache_background_update on;
      proxy_cache_lock on;
      proxy_cache_bypass $http_cache_control;
      proxy_no_cache $http_pragma $http_authorization;
      add_header X-Cache-Status $upstream_cache_status;
      add_header X-Cache-Key "$scheme$request_method$host$request_uri";
spec:
  ingressClassName: nginx
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /api/v1/data
            pathType: Prefix
            backend:
              service:
                name: api-service
                port:
                  number: 8080
```

## Load Balancing Algorithms

### Consistent Hashing Configuration

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: consistent-hash-ingress
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/upstream-hash-by: "$request_uri$http_x_session_id"
    nginx.ingress.kubernetes.io/upstream-hash-by-subset: "true"
    nginx.ingress.kubernetes.io/upstream-hash-by-subset-size: "3"
spec:
  ingressClassName: nginx
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

### EWMA Load Balancing

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: nginx-load-balancing
  namespace: ingress-nginx
data:
  load-balance: "ewma"  # Exponentially Weighted Moving Average
  upstream-keepalive-connections: "320"
  upstream-keepalive-timeout: "60"
  upstream-keepalive-requests: "10000"
```

## Monitoring and Observability

### Prometheus Metrics Exposition

```yaml
apiVersion: v1
kind: Service
metadata:
  name: ingress-nginx-metrics
  namespace: ingress-nginx
  labels:
    app.kubernetes.io/name: ingress-nginx
  annotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "10254"
    prometheus.io/path: "/metrics"
spec:
  type: ClusterIP
  ports:
    - name: metrics
      port: 10254
      targetPort: metrics
      protocol: TCP
  selector:
    app.kubernetes.io/name: ingress-nginx
```

### ServiceMonitor for Prometheus Operator

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: ingress-nginx
  namespace: monitoring
  labels:
    app: ingress-nginx
spec:
  jobLabel: ingress-nginx
  selector:
    matchLabels:
      app.kubernetes.io/name: ingress-nginx
  namespaceSelector:
    matchNames:
      - ingress-nginx
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
```

### Grafana Dashboard

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: nginx-ingress-dashboard
  namespace: monitoring
  labels:
    grafana_dashboard: "1"
data:
  nginx-ingress.json: |
    {
      "annotations": {
        "list": []
      },
      "editable": true,
      "gnetId": 9614,
      "graphTooltip": 0,
      "id": null,
      "links": [],
      "panels": [
        {
          "aliasColors": {},
          "bars": false,
          "dashLength": 10,
          "dashes": false,
          "datasource": "Prometheus",
          "fill": 1,
          "gridPos": {
            "h": 8,
            "w": 12,
            "x": 0,
            "y": 0
          },
          "id": 1,
          "legend": {
            "avg": false,
            "current": false,
            "max": false,
            "min": false,
            "show": true,
            "total": false,
            "values": false
          },
          "lines": true,
          "linewidth": 1,
          "nullPointMode": "null",
          "percentage": false,
          "pointradius": 2,
          "points": false,
          "renderer": "flot",
          "seriesOverrides": [],
          "spaceLength": 10,
          "stack": false,
          "steppedLine": false,
          "targets": [
            {
              "expr": "rate(nginx_ingress_controller_requests[5m])",
              "legendFormat": "{{ingress}} {{status}}",
              "refId": "A"
            }
          ],
          "thresholds": [],
          "timeFrom": null,
          "timeRegions": [],
          "timeShift": null,
          "title": "Request Rate",
          "tooltip": {
            "shared": true,
            "sort": 0,
            "value_type": "individual"
          },
          "type": "graph",
          "xaxis": {
            "buckets": null,
            "mode": "time",
            "name": null,
            "show": true,
            "values": []
          },
          "yaxes": [
            {
              "format": "reqps",
              "label": null,
              "logBase": 1,
              "max": null,
              "min": null,
              "show": true
            }
          ]
        }
      ],
      "title": "NGINX Ingress Controller",
      "uid": "nginx-ingress",
      "version": 1
    }
```

### Custom Metrics Script

```bash
#!/bin/bash
# nginx-ingress-metrics.sh - Collect and analyze NGINX Ingress metrics

NAMESPACE="ingress-nginx"
PROMETHEUS_URL="http://prometheus.monitoring.svc.cluster.local:9090"

# Function to query Prometheus
query_prometheus() {
    local query=$1
    curl -s -G --data-urlencode "query=$query" "${PROMETHEUS_URL}/api/v1/query" | jq -r '.data.result[0].value[1]'
}

# Request rate
echo "=== Request Rate ==="
query_prometheus 'sum(rate(nginx_ingress_controller_requests[5m]))'

# P50, P95, P99 latency
echo -e "\n=== Latency Percentiles ==="
echo "P50: $(query_prometheus 'histogram_quantile(0.50, sum(rate(nginx_ingress_controller_request_duration_seconds_bucket[5m])) by (le))')"
echo "P95: $(query_prometheus 'histogram_quantile(0.95, sum(rate(nginx_ingress_controller_request_duration_seconds_bucket[5m])) by (le))')"
echo "P99: $(query_prometheus 'histogram_quantile(0.99, sum(rate(nginx_ingress_controller_request_duration_seconds_bucket[5m])) by (le))')"

# Success rate
echo -e "\n=== Success Rate ==="
query_prometheus 'sum(rate(nginx_ingress_controller_requests{status=~"2.."}[5m])) / sum(rate(nginx_ingress_controller_requests[5m])) * 100'

# Connection statistics
echo -e "\n=== Connection Statistics ==="
echo "Active: $(query_prometheus 'nginx_ingress_controller_nginx_process_connections{state="active"}')"
echo "Reading: $(query_prometheus 'nginx_ingress_controller_nginx_process_connections{state="reading"}')"
echo "Writing: $(query_prometheus 'nginx_ingress_controller_nginx_process_connections{state="writing"}')"
echo "Waiting: $(query_prometheus 'nginx_ingress_controller_nginx_process_connections{state="waiting"}')"
```

## Performance Testing

### Load Testing with k6

```javascript
// k6-nginx-ingress-test.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const errorRate = new Rate('errors');

export let options = {
    stages: [
        { duration: '2m', target: 100 },   // Ramp up to 100 users
        { duration: '5m', target: 100 },   // Stay at 100 users
        { duration: '2m', target: 200 },   // Ramp up to 200 users
        { duration: '5m', target: 200 },   // Stay at 200 users
        { duration: '2m', target: 500 },   // Ramp up to 500 users
        { duration: '5m', target: 500 },   // Stay at 500 users
        { duration: '2m', target: 0 },     // Ramp down to 0 users
    ],
    thresholds: {
        'http_req_duration': ['p(95)<500', 'p(99)<1000'],
        'http_req_failed': ['rate<0.01'],
        'errors': ['rate<0.01'],
    },
};

export default function() {
    const url = 'https://api.example.com/api/v1/health';

    const params = {
        headers: {
            'Content-Type': 'application/json',
            'X-Test-ID': `${__VU}-${__ITER}`,
        },
        tags: {
            name: 'HealthCheck',
        },
    };

    let response = http.get(url, params);

    check(response, {
        'status is 200': (r) => r.status === 200,
        'response time < 500ms': (r) => r.timings.duration < 500,
    }) || errorRate.add(1);

    sleep(1);
}
```

Run the test:

```bash
k6 run --out json=results.json k6-nginx-ingress-test.js
```

## Troubleshooting and Debugging

### Debug Logging Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: nginx-debug-config
  namespace: ingress-nginx
data:
  error-log-level: "debug"
  enable-access-log-for-default-backend: "true"
  log-format-escape-json: "true"
  log-format-upstream: '{"time": "$time_iso8601", "remote_addr": "$proxy_protocol_addr", "x_forward_for": "$proxy_add_x_forwarded_for", "request_id": "$req_id", "remote_user": "$remote_user", "bytes_sent": $bytes_sent, "request_time": $request_time, "status": $status, "vhost": "$host", "request_proto": "$server_protocol", "path": "$uri", "request_query": "$args", "request_length": $request_length, "duration": $request_time, "method": "$request_method", "http_referrer": "$http_referer", "http_user_agent": "$http_user_agent", "upstream_addr": "$upstream_addr", "upstream_status": "$upstream_status", "upstream_response_time": "$upstream_response_time", "upstream_response_length": "$upstream_response_length"}'
```

### Viewing NGINX Configuration

```bash
# Get the generated NGINX configuration
kubectl exec -n ingress-nginx $(kubectl get pods -n ingress-nginx -l app.kubernetes.io/name=ingress-nginx -o jsonpath='{.items[0].metadata.name}') -- cat /etc/nginx/nginx.conf

# Test NGINX configuration
kubectl exec -n ingress-nginx $(kubectl get pods -n ingress-nginx -l app.kubernetes.io/name=ingress-nginx -o jsonpath='{.items[0].metadata.name}') -- nginx -t

# Reload NGINX without downtime
kubectl exec -n ingress-nginx $(kubectl get pods -n ingress-nginx -l app.kubernetes.io/name=ingress-nginx -o jsonpath='{.items[0].metadata.name}') -- nginx -s reload
```

### Common Issues and Solutions

```bash
#!/bin/bash
# nginx-ingress-troubleshoot.sh

echo "=== NGINX Ingress Controller Health Check ==="

# Check pod status
echo -e "\n1. Pod Status:"
kubectl get pods -n ingress-nginx -l app.kubernetes.io/name=ingress-nginx

# Check service endpoints
echo -e "\n2. Service Endpoints:"
kubectl get endpoints -n ingress-nginx

# Check ingress resources
echo -e "\n3. Ingress Resources:"
kubectl get ingress --all-namespaces

# Check controller logs for errors
echo -e "\n4. Recent Errors in Controller Logs:"
kubectl logs -n ingress-nginx -l app.kubernetes.io/name=ingress-nginx --tail=50 | grep -i error

# Check backend connectivity
echo -e "\n5. Backend Service Health:"
for pod in $(kubectl get pods -n ingress-nginx -l app.kubernetes.io/name=ingress-nginx -o jsonpath='{.items[*].metadata.name}'); do
    echo "Checking connectivity from $pod:"
    kubectl exec -n ingress-nginx $pod -- curl -s -o /dev/null -w "%{http_code}\n" http://localhost:10254/healthz
done

# Check certificate expiration
echo -e "\n6. Certificate Expiration:"
kubectl get certificates --all-namespaces -o json | jq -r '.items[] | "\(.metadata.namespace)/\(.metadata.name): \(.status.notAfter)"'

# Check resource usage
echo -e "\n7. Resource Usage:"
kubectl top pods -n ingress-nginx
```

## Production Best Practices

### Multi-Zone Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
spec:
  replicas: 6
  selector:
    matchLabels:
      app.kubernetes.io/name: ingress-nginx
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ingress-nginx
    spec:
      affinity:
        # Spread across availability zones
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchExpressions:
                    - key: app.kubernetes.io/name
                      operator: In
                      values:
                        - ingress-nginx
                topologyKey: topology.kubernetes.io/zone
            - weight: 50
              podAffinityTerm:
                labelSelector:
                  matchExpressions:
                    - key: app.kubernetes.io/name
                      operator: In
                      values:
                        - ingress-nginx
                topologyKey: kubernetes.io/hostname
      containers:
        - name: controller
          image: registry.k8s.io/ingress-nginx/controller:v1.9.4
          # ... rest of container spec
```

### Graceful Shutdown Configuration

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
spec:
  template:
    spec:
      containers:
        - name: controller
          lifecycle:
            preStop:
              exec:
                command:
                  - /wait-shutdown
      terminationGracePeriodSeconds: 300
```

### Security Hardening

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: nginx-security-config
  namespace: ingress-nginx
data:
  # Hide version information
  server-tokens: "false"

  # Block common attacks
  block-user-agents: "~*curl,~*wget,~*nikto,~*scanner"
  block-referers: "~*spam,~*malware"

  # Enable ModSecurity WAF
  enable-modsecurity: "true"
  enable-owasp-modsecurity-crs: "true"

  # SSL security
  ssl-protocols: "TLSv1.2 TLSv1.3"
  ssl-prefer-server-ciphers: "on"

  # Request filtering
  client-header-buffer-size: "1k"
  large-client-header-buffers: "2 1k"

  # DDoS protection
  limit-req-status-code: "429"
  limit-conn-status-code: "429"
```

## Conclusion

Optimizing NGINX Ingress Controller for enterprise production environments requires a comprehensive approach spanning kernel tuning, NGINX configuration, Kubernetes resource management, and application-level optimization. The configurations presented in this guide provide a solid foundation for handling high-throughput scenarios while maintaining low latency and high availability.

Key takeaways:
- Start with kernel-level optimizations on ingress nodes
- Configure appropriate resource limits and horizontal autoscaling
- Implement effective rate limiting and caching strategies
- Monitor performance metrics continuously
- Use load testing to validate configurations under realistic conditions
- Plan for graceful degradation and failure scenarios

Regular performance testing, monitoring, and iterative optimization ensure your ingress layer scales effectively with your application demands while providing the reliability required for production systems.