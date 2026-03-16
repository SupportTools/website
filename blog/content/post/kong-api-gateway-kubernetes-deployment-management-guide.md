---
title: "Kong API Gateway on Kubernetes: Enterprise Deployment and Management Guide"
date: 2026-08-20T00:00:00-05:00
draft: false
tags: ["Kong", "API Gateway", "Kubernetes", "Microservices", "API Management", "Enterprise"]
categories: ["Kubernetes", "API Management", "Microservices"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to deploying and managing Kong API Gateway on Kubernetes with advanced plugins, authentication, rate limiting, and enterprise-grade API management strategies."
more_link: "yes"
url: "/kong-api-gateway-kubernetes-deployment-management-guide/"
---

Kong API Gateway has emerged as the leading cloud-native API gateway, built on NGINX and designed specifically for microservices and distributed architectures. When deployed on Kubernetes, Kong provides a powerful platform for API management, authentication, rate limiting, traffic control, and observability with extensive plugin ecosystem and declarative configuration.

This comprehensive guide covers enterprise Kong deployment patterns, advanced plugin configurations, database and DB-less modes, authentication strategies, rate limiting, caching, and production-tested patterns for managing APIs at scale in Kubernetes environments.

<!--more-->

# Kong API Gateway on Kubernetes: Enterprise Deployment and Management

## Executive Summary

Kong Gateway transforms the way organizations manage their APIs in Kubernetes environments by providing a centralized, high-performance layer for traffic management, security, and observability. Built on the proven NGINX core, Kong extends functionality through a rich plugin ecosystem supporting authentication, rate limiting, transformations, logging, and custom business logic.

In this guide, we'll explore both Kong's traditional database-backed deployment and the newer DB-less (declarative) mode, advanced plugin configurations for enterprise scenarios, multi-tenancy patterns, and observability strategies that enable teams to operate APIs reliably at massive scale.

## Kong Architecture Overview

### Core Components

1. **Kong Gateway**: The proxy layer that handles API requests
2. **Kong Admin API**: RESTful API for configuration management
3. **Database**: PostgreSQL (traditional mode) or declarative config files (DB-less mode)
4. **Kong Manager**: Enterprise GUI for visual management
5. **Kong Ingress Controller**: Kubernetes-native integration

### Deployment Modes

**Database Mode (Traditional)**:
- Configuration stored in PostgreSQL
- Supports dynamic configuration changes via Admin API
- Required for certain enterprise plugins
- Better for large-scale, dynamic environments

**DB-less Mode (Declarative)**:
- Configuration stored in YAML files
- No database required
- Faster startup and lower resource usage
- Better for GitOps workflows and smaller deployments

## Installing Kong on Kubernetes

### Prerequisites

```bash
# Create namespace
kubectl create namespace kong

# Add Kong Helm repository
helm repo add kong https://charts.konghq.com
helm repo update
```

### Database Mode Deployment

#### PostgreSQL Setup

```yaml
# postgres-statefulset.yaml
apiVersion: v1
kind: Secret
metadata:
  name: postgres-secret
  namespace: kong
type: Opaque
stringData:
  password: "$(openssl rand -base64 32)"
---
apiVersion: v1
kind: Service
metadata:
  name: postgres
  namespace: kong
spec:
  ports:
    - port: 5432
      targetPort: 5432
  selector:
    app: postgres
  clusterIP: None
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: kong
spec:
  serviceName: postgres
  replicas: 1
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
        - name: postgres
          image: postgres:15
          ports:
            - containerPort: 5432
          env:
            - name: POSTGRES_USER
              value: kong
            - name: POSTGRES_DB
              value: kong
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: postgres-secret
                  key: password
          volumeMounts:
            - name: postgres-storage
              mountPath: /var/lib/postgresql/data
              subPath: postgres
  volumeClaimTemplates:
    - metadata:
        name: postgres-storage
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 100Gi
```

#### Kong with Database Helm Values

Create `kong-db-values.yaml`:

```yaml
# Kong Gateway Configuration
image:
  repository: kong/kong-gateway
  tag: "3.5"

# Environment variables
env:
  # Database configuration
  database: postgres
  pg_host: postgres.kong.svc.cluster.local
  pg_port: 5432
  pg_user: kong
  pg_database: kong
  pg_password:
    valueFrom:
      secretKeyRef:
        name: postgres-secret
        key: password

  # Kong configuration
  proxy_access_log: /dev/stdout
  admin_access_log: /dev/stdout
  admin_gui_access_log: /dev/stdout
  portal_api_access_log: /dev/stdout
  proxy_error_log: /dev/stderr
  admin_error_log: /dev/stderr
  admin_gui_error_log: /dev/stderr
  portal_api_error_log: /dev/stderr

  # Performance tuning
  nginx_worker_processes: "auto"
  nginx_worker_connections: "10240"
  mem_cache_size: "128m"
  db_cache_ttl: "3600"

  # SSL configuration
  ssl_cert: /etc/secrets/kong-cert/tls.crt
  ssl_cert_key: /etc/secrets/kong-cert/tls.key

  # Admin API
  admin_listen: "0.0.0.0:8001, 0.0.0.0:8444 ssl"
  admin_gui_listen: "0.0.0.0:8002, 0.0.0.0:8445 ssl"

  # Proxy configuration
  proxy_listen: "0.0.0.0:8000, 0.0.0.0:8443 http2 ssl"
  status_listen: "0.0.0.0:8100"

  # Enterprise features (if using Kong Enterprise)
  portal: "on"
  portal_gui_host: "portal.example.com"
  vitals: "on"
  rbac: "on"

# Replica configuration
replicaCount: 3

# Resources
resources:
  limits:
    cpu: "4000m"
    memory: "4Gi"
  requests:
    cpu: "2000m"
    memory: "2Gi"

# Autoscaling
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

# Affinity rules
affinity:
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchLabels:
            app: kong
        topologyKey: kubernetes.io/hostname
      - labelSelector:
          matchLabels:
            app: kong
        topologyKey: topology.kubernetes.io/zone

# Node selection
nodeSelector:
  node-role.kubernetes.io/api-gateway: "true"

tolerations:
  - key: "api-gateway"
    operator: "Equal"
    value: "true"
    effect: "NoSchedule"

# Service configuration
proxy:
  enabled: true
  type: LoadBalancer
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-type: "nlb"
    service.beta.kubernetes.io/aws-load-balancer-backend-protocol: "tcp"
  http:
    enabled: true
    servicePort: 80
    containerPort: 8000
  tls:
    enabled: true
    servicePort: 443
    containerPort: 8443

admin:
  enabled: true
  type: ClusterIP
  http:
    enabled: true
    servicePort: 8001
  tls:
    enabled: true
    servicePort: 8444

# Ingress for Admin API
ingressController:
  enabled: true
  installCRDs: true
  ingressClass: kong

# Metrics
metrics:
  enabled: true
  serviceMonitor:
    enabled: true
    namespace: monitoring

# Migration jobs
migrations:
  preUpgrade: true
  postUpgrade: true

# Security context
securityContext:
  runAsNonRoot: true
  runAsUser: 1000

# Init containers for database migrations
waitImage:
  enabled: true
  pullPolicy: IfNotPresent
```

Install Kong with database:

```bash
helm install kong kong/kong \
  --namespace kong \
  --values kong-db-values.yaml
```

### DB-less Mode Deployment

Create `kong-dbless-values.yaml`:

```yaml
# Kong Gateway Configuration (DB-less)
image:
  repository: kong
  tag: "3.5"

# Environment variables
env:
  # DB-less mode
  database: "off"
  declarative_config: /kong_dbless/kong.yml

  # Kong configuration
  proxy_access_log: /dev/stdout
  admin_access_log: /dev/stdout
  proxy_error_log: /dev/stderr
  admin_error_log: /dev/stderr

  # Performance tuning
  nginx_worker_processes: "auto"
  nginx_worker_connections: "10240"
  mem_cache_size: "128m"

  # Admin API (read-only in DB-less mode)
  admin_listen: "0.0.0.0:8001, 0.0.0.0:8444 ssl"

  # Proxy configuration
  proxy_listen: "0.0.0.0:8000, 0.0.0.0:8443 http2 ssl"
  status_listen: "0.0.0.0:8100"

# Replica configuration
replicaCount: 3

# Resources
resources:
  limits:
    cpu: "2000m"
    memory: "2Gi"
  requests:
    cpu: "1000m"
    memory: "1Gi"

# Autoscaling
autoscaling:
  enabled: true
  minReplicas: 3
  maxReplicas: 15
  targetCPUUtilizationPercentage: 70

# Declarative configuration
dblessConfig:
  configMap: kong-declarative-config

# Service configuration
proxy:
  enabled: true
  type: LoadBalancer
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-type: "nlb"

# Ingress Controller
ingressController:
  enabled: true
  installCRDs: true
  ingressClass: kong
  env:
    # Sync configuration from Kubernetes
    publish_service: kong/kong-proxy
```

Create declarative configuration:

```yaml
# kong-declarative-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kong-declarative-config
  namespace: kong
data:
  kong.yml: |
    _format_version: "3.0"
    _transform: true

    services:
      - name: example-service
        url: http://example-service.default.svc.cluster.local:8080
        routes:
          - name: example-route
            paths:
              - /api
            strip_path: false
        plugins:
          - name: rate-limiting
            config:
              minute: 100
              policy: local
          - name: correlation-id
            config:
              header_name: X-Request-ID
              generator: uuid

      - name: auth-service
        url: http://auth-service.default.svc.cluster.local:8080
        routes:
          - name: auth-route
            paths:
              - /auth
        plugins:
          - name: key-auth
            config:
              key_names:
                - apikey

    plugins:
      - name: prometheus
        config:
          per_consumer: true

    consumers:
      - username: demo-user
        keyauth_credentials:
          - key: demo-api-key-12345
```

Install Kong in DB-less mode:

```bash
kubectl apply -f kong-declarative-config.yaml

helm install kong kong/kong \
  --namespace kong \
  --values kong-dbless-values.yaml
```

## Kong Ingress Controller

### Basic Ingress Configuration

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: example-ingress
  namespace: default
  annotations:
    konghq.com/strip-path: "true"
    konghq.com/protocols: "https"
    konghq.com/https-redirect-status-code: "301"
spec:
  ingressClassName: kong
  tls:
    - hosts:
        - api.example.com
      secretName: api-tls-cert
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

### KongPlugin CRD

```yaml
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: rate-limiting-plugin
  namespace: default
plugin: rate-limiting
config:
  minute: 100
  hour: 10000
  policy: redis
  redis_host: redis.kong.svc.cluster.local
  redis_port: 6379
  redis_database: 0
  fault_tolerant: true
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: rate-limited-ingress
  namespace: default
  annotations:
    konghq.com/plugins: rate-limiting-plugin
spec:
  ingressClassName: kong
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

## Authentication and Authorization

### API Key Authentication

```yaml
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: key-auth
  namespace: default
plugin: key-auth
config:
  key_names:
    - apikey
    - X-API-Key
  key_in_body: false
  key_in_header: true
  key_in_query: true
  hide_credentials: true
---
apiVersion: configuration.konghq.com/v1
kind: KongConsumer
metadata:
  name: demo-consumer
  namespace: default
  annotations:
    kubernetes.io/ingress.class: kong
username: demo-user
credentials:
  - demo-api-key
---
apiVersion: v1
kind: Secret
metadata:
  name: demo-api-key
  namespace: default
  labels:
    konghq.com/credential: key-auth
stringData:
  key: demo-api-key-secret-value-12345
```

### JWT Authentication

```yaml
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: jwt-auth
  namespace: default
plugin: jwt
config:
  uri_param_names:
    - jwt
  header_names:
    - Authorization
  claims_to_verify:
    - exp
  key_claim_name: iss
  secret_is_base64: false
  maximum_expiration: 3600
  run_on_preflight: false
---
apiVersion: configuration.konghq.com/v1
kind: KongConsumer
metadata:
  name: jwt-consumer
  namespace: default
username: jwt-user
---
apiVersion: v1
kind: Secret
metadata:
  name: jwt-credential
  namespace: default
  labels:
    konghq.com/credential: jwt
stringData:
  key: jwt-issuer
  algorithm: HS256
  secret: super-secret-jwt-key-change-this
```

### OAuth 2.0 Authentication

```yaml
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: oauth2
  namespace: default
plugin: oauth2
config:
  scopes:
    - email
    - profile
    - read:api
    - write:api
  mandatory_scope: true
  enable_authorization_code: true
  enable_client_credentials: true
  enable_implicit_grant: false
  enable_password_grant: false
  token_expiration: 7200
  provision_key: oauth2_provision_key
  refresh_token_ttl: 1209600
  global_credentials: false
```

### OIDC Integration

```yaml
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: oidc
  namespace: default
plugin: openid-connect
config:
  issuer: "https://auth.example.com/realms/production"
  client_id:
    - kong-api-gateway
  client_secret:
    - "client-secret-value"
  redirect_uri:
    - "https://api.example.com/auth/callback"
  scopes:
    - openid
    - email
    - profile
  auth_methods:
    - authorization_code
  bearer_only: false
  ssl_verify: true
  session_secret: "session-secret-value-min-32-chars"
  token_endpoint_auth_method: client_secret_post
```

## Rate Limiting and Traffic Control

### Advanced Rate Limiting

```yaml
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: advanced-rate-limiting
  namespace: default
plugin: rate-limiting-advanced
config:
  limit:
    - 100
  window_size:
    - 60
  identifier: consumer
  sync_rate: 10
  namespace: kong_rate_limiting
  strategy: redis
  redis:
    host: redis-cluster.kong.svc.cluster.local
    port: 6379
    database: 0
    timeout: 2000
    password: redis-password
  hide_client_headers: false
  retry_after_jitter_max: 0
```

### Request Size Limiting

```yaml
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: request-size-limiting
  namespace: default
plugin: request-size-limiting
config:
  allowed_payload_size: 10  # megabytes
  size_unit: megabytes
  require_content_length: true
```

### Response Rate Limiting

```yaml
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: response-rate-limiting
  namespace: default
plugin: response-ratelimiting
config:
  limits:
    video:
      minute: 10
      hour: 100
  header_name: X-Rate-Limit
  block_on_first_violation: false
  hide_client_headers: false
  fault_tolerant: true
  redis_host: redis.kong.svc.cluster.local
  redis_port: 6379
  policy: redis
```

## Request/Response Transformation

### Request Transformer

```yaml
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: request-transformer
  namespace: default
plugin: request-transformer
config:
  add:
    headers:
      - "X-Service-Version: v1"
      - "X-Forwarded-By: Kong"
    querystring:
      - "source:kong"
  append:
    headers:
      - "X-Request-ID: $(uuid())"
  remove:
    headers:
      - "X-Internal-Token"
    querystring:
      - "debug"
  replace:
    headers:
      - "Host: api-backend.internal"
```

### Response Transformer

```yaml
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: response-transformer
  namespace: default
plugin: response-transformer
config:
  add:
    headers:
      - "X-Response-Time: $(latency)"
      - "X-Served-By: Kong"
  append:
    headers:
      - "X-Cache-Status: $(cache_status)"
  remove:
    headers:
      - "X-Internal-Header"
  replace:
    headers:
      - "Server: API Gateway"
```

### Correlation ID

```yaml
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: correlation-id
  namespace: default
plugin: correlation-id
config:
  header_name: X-Request-ID
  generator: uuid#counter
  echo_downstream: true
```

## Caching and Performance

### Proxy Cache

```yaml
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: proxy-cache
  namespace: default
plugin: proxy-cache
config:
  response_code:
    - 200
    - 301
    - 302
  request_method:
    - GET
    - HEAD
  content_type:
    - application/json
    - application/xml
  cache_ttl: 300
  strategy: redis
  redis:
    host: redis-cluster.kong.svc.cluster.local
    port: 6379
    database: 0
    timeout: 2000
  cache_control: true
  storage_ttl: 3600
  memory:
    dictionary_name: kong_cache
```

### Upstream Caching with Advanced Configuration

```yaml
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: proxy-cache-advanced
  namespace: default
plugin: proxy-cache-advanced
config:
  strategy: redis
  redis:
    host: redis-sentinel.kong.svc.cluster.local
    port: 26379
    sentinel_master: mymaster
    sentinel_role: master
    database: 1
  response_code:
    - 200
    - 301
    - 404
  vary_headers:
    - Accept
    - Accept-Language
  vary_query_params:
    - version
  cache_ttl: 300
  cache_control: true
  bypass_on_err: true
```

## Security Plugins

### IP Restriction

```yaml
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: ip-restriction
  namespace: default
plugin: ip-restriction
config:
  allow:
    - 10.0.0.0/8
    - 172.16.0.0/12
    - 192.168.0.0/16
  deny:
    - 0.0.0.0/0
  status: 403
  message: "Access denied from your IP"
```

### Bot Detection

```yaml
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: bot-detection
  namespace: default
plugin: bot-detection
config:
  allow:
    - Googlebot
    - Bingbot
  deny:
    - BadBot
    - Scrapy
  rules:
    user_agent:
      - pattern: "curl/*"
        action: deny
      - pattern: "wget/*"
        action: deny
```

### CORS Configuration

```yaml
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: cors
  namespace: default
plugin: cors
config:
  origins:
    - https://app.example.com
    - https://admin.example.com
  methods:
    - GET
    - POST
    - PUT
    - DELETE
    - OPTIONS
  headers:
    - Accept
    - Authorization
    - Content-Type
    - X-Request-ID
  exposed_headers:
    - X-Request-ID
    - X-Response-Time
  credentials: true
  max_age: 3600
  preflight_continue: false
```

## Monitoring and Observability

### Prometheus Metrics

```yaml
apiVersion: configuration.konghq.com/v1
kind: KongClusterPlugin
metadata:
  name: prometheus
  annotations:
    kubernetes.io/ingress.class: kong
plugin: prometheus
config:
  per_consumer: true
  status_code_metrics: true
  latency_metrics: true
  bandwidth_metrics: true
  upstream_health_metrics: true
```

### StatsD Metrics

```yaml
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: statsd
  namespace: default
plugin: statsd
config:
  host: statsd.monitoring.svc.cluster.local
  port: 8125
  metrics:
    - name: request_count
      stat_type: counter
      sample_rate: 1
    - name: latency
      stat_type: timer
    - name: request_size
      stat_type: histogram
    - name: response_size
      stat_type: histogram
  prefix: kong
```

### Datadog Integration

```yaml
apiVersion: configuration.konghq.com/v1
kind: KongClusterPlugin
metadata:
  name: datadog
plugin: datadog
config:
  host: datadog-agent.monitoring.svc.cluster.local
  port: 8125
  metrics:
    - name: request_count
      stat_type: counter
      tags:
        - environment:production
    - name: latency
      stat_type: gauge
      tags:
        - environment:production
  prefix: kong
  service_name_tag: service
  consumer_tag: consumer
```

### Request Logging

```yaml
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: http-log
  namespace: default
plugin: http-log
config:
  http_endpoint: https://log-collector.example.com/kong
  method: POST
  timeout: 10000
  keepalive: 60000
  flush_timeout: 2
  retry_count: 10
  queue_size: 1000
  content_type: application/json
  headers:
    Authorization: "Bearer log-collector-token"
```

## Traffic Management

### Canary Releases

```yaml
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: canary
  namespace: default
plugin: canary
config:
  start: 1640995200  # Unix timestamp
  duration: 3600      # Duration in seconds
  percentage: 10      # 10% of traffic to canary
  steps: 5            # Gradual rollout steps
  upstream_host: canary-service.default.svc.cluster.local
  upstream_port: 8080
  hash: consumer      # Hash based on consumer ID
```

### Request Termination

```yaml
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: request-termination
  namespace: default
plugin: request-termination
config:
  status_code: 503
  message: "Service temporarily unavailable"
  content_type: application/json
  body: |
    {
      "error": "Service maintenance in progress",
      "retry_after": 3600
    }
  trigger: "X-Maintenance-Mode"
```

### Circuit Breaker

```yaml
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: circuit-breaker
  namespace: default
plugin: circuit-breaker
config:
  failure_threshold: 10
  success_threshold: 5
  timeout: 60
  half_open_requests: 3
  window_size: 60
```

## Multi-Tenancy and Workspaces

### Workspace Configuration (Enterprise)

```yaml
apiVersion: configuration.konghq.com/v1
kind: KongWorkspace
metadata:
  name: team-a-workspace
spec:
  name: team-a
  comment: "Team A API workspace"
  meta:
    team: team-a
    environment: production
---
apiVersion: configuration.konghq.com/v1
kind: KongService
metadata:
  name: team-a-service
  namespace: team-a
  annotations:
    konghq.com/workspace: team-a
spec:
  host: team-a-backend.default.svc.cluster.local
  port: 8080
  protocol: http
```

## Troubleshooting and Debugging

### Kong Admin API Access

```bash
#!/bin/bash
# kong-admin-cli.sh - Kong Admin API helper script

KONG_ADMIN_URL="http://localhost:8001"

# Get all services
get_services() {
    curl -s "${KONG_ADMIN_URL}/services" | jq .
}

# Get all routes
get_routes() {
    curl -s "${KONG_ADMIN_URL}/routes" | jq .
}

# Get all plugins
get_plugins() {
    curl -s "${KONG_ADMIN_URL}/plugins" | jq .
}

# Get Kong status
get_status() {
    curl -s "${KONG_ADMIN_URL}/status" | jq .
}

# Test a route
test_route() {
    local host=$1
    local path=$2
    curl -v -H "Host: ${host}" "http://localhost:8000${path}"
}

# Show usage
case "$1" in
    services) get_services ;;
    routes) get_routes ;;
    plugins) get_plugins ;;
    status) get_status ;;
    test) test_route "$2" "$3" ;;
    *) echo "Usage: $0 {services|routes|plugins|status|test HOST PATH}" ;;
esac
```

### Debug Mode

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kong-debug-config
  namespace: kong
data:
  log_level: "debug"
  lua_ssl_trusted_certificate: "system"
  lua_ssl_verify_depth: "1"
```

## Production Best Practices

### High Availability Configuration

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: kong
  namespace: kong
spec:
  replicas: 5
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 2
      maxUnavailable: 1
  template:
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: kong
              topologyKey: kubernetes.io/hostname
            - labelSelector:
                matchLabels:
                  app: kong
              topologyKey: topology.kubernetes.io/zone
      terminationGracePeriodSeconds: 300
```

### Performance Tuning

```yaml
env:
  # Worker configuration
  nginx_worker_processes: "auto"
  nginx_worker_connections: "10240"

  # Memory settings
  mem_cache_size: "128m"
  db_cache_ttl: "3600"

  # Upstream settings
  nginx_http_upstream_keepalive: "320"
  nginx_http_upstream_keepalive_requests: "10000"
  nginx_http_upstream_keepalive_timeout: "60"

  # Lua settings
  lua_shared_dict: "kong 10m"
  lua_package_path: "/opt/?.lua;/opt/?/init.lua;;"
```

## Conclusion

Kong API Gateway provides a comprehensive, high-performance solution for managing APIs in Kubernetes environments. Its extensive plugin ecosystem, flexible deployment options (database and DB-less modes), and Kubernetes-native integration make it ideal for enterprises building microservices architectures.

Key advantages of Kong on Kubernetes:
- Rich plugin ecosystem for authentication, rate limiting, and transformations
- Native Kubernetes integration via Ingress Controller and CRDs
- Support for both database-backed and declarative (DB-less) modes
- Enterprise features including RBAC, workspaces, and Kong Manager
- Excellent performance and scalability
- Active community and commercial support options

By following the patterns and configurations in this guide, organizations can build robust, secure, and scalable API management platforms that support modern cloud-native architectures.