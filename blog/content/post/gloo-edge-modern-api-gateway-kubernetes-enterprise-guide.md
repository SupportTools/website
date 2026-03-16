---
title: "Gloo Edge: Modern Envoy-Based API Gateway for Kubernetes Enterprise Environments"
date: 2026-07-15T00:00:00-05:00
draft: false
tags: ["Gloo Edge", "Envoy", "API Gateway", "Kubernetes", "Service Mesh", "Enterprise"]
categories: ["Kubernetes", "API Management", "Microservices"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to deploying and managing Gloo Edge API Gateway on Kubernetes with advanced Envoy features, function-level routing, GraphQL, and enterprise-grade traffic management."
more_link: "yes"
url: "/gloo-edge-modern-api-gateway-kubernetes-enterprise-guide/"
---

Gloo Edge represents the next generation of API gateways, built on Envoy Proxy and designed specifically for modern cloud-native architectures. Unlike traditional API gateways, Gloo Edge provides function-level routing, GraphQL stitching, transformation capabilities, and advanced traffic management while maintaining the performance and extensibility of Envoy Proxy.

This comprehensive guide explores Gloo Edge's unique capabilities, enterprise deployment patterns, advanced routing configurations, authentication strategies, and production-tested approaches for building sophisticated API management platforms in Kubernetes environments.

<!--more-->

# Gloo Edge: Modern Envoy-Based API Gateway for Kubernetes

## Executive Summary

Gloo Edge differentiates itself from traditional API gateways by providing function-level routing capabilities that enable direct invocation of serverless functions (AWS Lambda, Google Cloud Functions, Azure Functions) alongside traditional microservices. Built on Envoy Proxy, Gloo Edge inherits Envoy's performance characteristics while adding powerful features like GraphQL schema stitching, request/response transformation, and advanced observability.

In this guide, we'll cover Gloo Edge's architecture, deployment strategies, advanced routing patterns including function-level routing, transformation capabilities, authentication and authorization, GraphQL integration, and enterprise patterns for managing complex API landscapes at scale.

## Gloo Edge Architecture

### Core Components

1. **Gloo Gateway**: Envoy-based proxy handling traffic
2. **Gloo Control Plane**: Configuration management and discovery
3. **Discovery Services**: Automatic service discovery for Kubernetes, Consul, AWS, etc.
4. **Gloo Federation**: Multi-cluster management (Enterprise)
5. **Gloo Portal**: Developer portal and API documentation (Enterprise)

### Key Differentiators

- **Function-Level Routing**: Route directly to serverless functions
- **Envoy-Native**: Leverages latest Envoy features and performance
- **Hybrid Architecture**: Unified gateway for VMs, containers, and serverless
- **GraphQL Native**: Built-in GraphQL schema stitching and resolution
- **Transformation Engine**: Powerful request/response transformation
- **Discovery-Based**: Automatic service and function discovery

## Installing Gloo Edge

### Prerequisites

```bash
# Install glooctl CLI
curl -sL https://run.solo.io/gloo/install | sh
export PATH=$HOME/.gloo/bin:$PATH

# Verify installation
glooctl version
```

### Open Source Installation

```bash
# Create namespace
kubectl create namespace gloo-system

# Install Gloo Edge (open source)
glooctl install gateway \
  --values gloo-values.yaml
```

### Enterprise Installation with Helm

Create `gloo-enterprise-values.yaml`:

```yaml
# Gloo Edge Enterprise Configuration
gloo:
  # Gloo deployment settings
  deployment:
    replicas: 3
    customEnv:
      - name: LOG_LEVEL
        value: "info"
    resources:
      requests:
        cpu: "500m"
        memory: "512Mi"
      limits:
        cpu: "2000m"
        memory: "2Gi"

  # Discovery configuration
  discovery:
    enabled: true
    fdsMode: WHITELIST

# Gateway Proxy configuration
gatewayProxies:
  gatewayProxy:
    # Deployment settings
    kind:
      deployment:
        replicas: 3

    # Pod Disruption Budget
    podDisruptionBudget:
      minAvailable: 2

    # Anti-affinity rules
    antiAffinity: true

    # Resources
    podTemplate:
      resources:
        requests:
          cpu: "1000m"
          memory: "1Gi"
        limits:
          cpu: "4000m"
          memory: "4Gi"

      # Node selection
      nodeSelector:
        node-role.kubernetes.io/gateway: "true"

      tolerations:
        - key: "gateway"
          operator: "Equal"
          value: "true"
          effect: "NoSchedule"

      # Graceful shutdown
      terminationGracePeriodSeconds: 300

      # Annotations
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8081"
        prometheus.io/path: "/metrics"

      # Custom Envoy configuration
      customEnvoyConfig:
        - name: ENVOY_CONCURRENCY
          value: "4"

    # Service configuration
    service:
      type: LoadBalancer
      httpPort: 80
      httpsPort: 443
      annotations:
        service.beta.kubernetes.io/aws-load-balancer-type: "nlb"
        service.beta.kubernetes.io/aws-load-balancer-backend-protocol: "tcp"
        service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "true"
      externalTrafficPolicy: Local

    # Horizontal Pod Autoscaling
    horizontalPodAutoscaler:
      maxReplicas: 20
      minReplicas: 3
      targetCPUUtilizationPercentage: 70

# Settings
settings:
  # Watch multiple namespaces
  watchNamespaces:
    - default
    - production
    - staging

  # Discovery options
  discovery:
    enabled: true

  # Rate limit configuration
  ratelimit:
    descriptors:
      - key: generic_key
        value: "per-minute"
        rateLimit:
          requestsPerUnit: 100
          unit: MINUTE

  # Integration settings
  integrations:
    knative:
      enabled: true
      proxy:
        image:
          tag: latest

# Observability
observability:
  enabled: true

  # Prometheus
  prometheus:
    enabled: true

  # Grafana
  grafana:
    enabled: true

# Enterprise features
license_key: "YOUR_LICENSE_KEY"

# RBAC
rbac:
  create: true
  namespaced: false

# Global settings
global:
  # Image configuration
  image:
    registry: quay.io/solo-io
    pullPolicy: IfNotPresent

  glooRbac:
    create: true
    namespaced: false
    nameSuffix: ""

  # Extension auth server
  extensions:
    extAuth:
      enabled: true
      deployment:
        replicas: 2
        resources:
          requests:
            cpu: "200m"
            memory: "256Mi"
          limits:
            cpu: "1000m"
            memory: "1Gi"

    # Rate limit server
    rateLimit:
      enabled: true
      deployment:
        replicas: 2
        resources:
          requests:
            cpu: "200m"
            memory: "256Mi"
          limits:
            cpu: "1000m"
            memory: "1Gi"
```

Install Gloo Edge Enterprise:

```bash
# Add Gloo Edge Enterprise Helm repository
helm repo add glooe https://storage.googleapis.com/gloo-ee-helm
helm repo update

# Install with license key
helm install gloo glooe/gloo-ee \
  --namespace gloo-system \
  --create-namespace \
  --set license_key=$GLOO_LICENSE_KEY \
  --values gloo-enterprise-values.yaml
```

## Basic Routing Configuration

### Virtual Service for HTTP Routing

```yaml
apiVersion: gateway.solo.io/v1
kind: VirtualService
metadata:
  name: basic-routing
  namespace: gloo-system
spec:
  virtualHost:
    domains:
      - "api.example.com"
    routes:
      - matchers:
          - prefix: /api/v1
        routeAction:
          single:
            upstream:
              name: api-service-default-8080
              namespace: gloo-system
        options:
          prefixRewrite: /v1

      - matchers:
          - prefix: /api/v2
        routeAction:
          single:
            upstream:
              name: api-v2-service-default-8080
              namespace: gloo-system
```

### Upstream Configuration

```yaml
apiVersion: gloo.solo.io/v1
kind: Upstream
metadata:
  name: api-service-default-8080
  namespace: gloo-system
spec:
  kube:
    serviceName: api-service
    serviceNamespace: default
    servicePort: 8080
  healthChecks:
    - timeout: 5s
      interval: 10s
      unhealthyThreshold: 3
      healthyThreshold: 2
      httpHealthCheck:
        path: /health
  circuitBreakers:
    maxConnections: 1024
    maxPendingRequests: 1024
    maxRequests: 1024
    maxRetries: 3
```

## Function-Level Routing

### AWS Lambda Integration

```yaml
apiVersion: gloo.solo.io/v1
kind: Upstream
metadata:
  name: lambda-upstream
  namespace: gloo-system
spec:
  aws:
    region: us-east-1
    secretRef:
      name: aws-credentials
      namespace: gloo-system
    lambdaFunctions:
      - lambdaFunctionName: user-authentication
        qualifier: $LATEST
      - lambdaFunctionName: data-processor
        qualifier: production
---
apiVersion: gateway.solo.io/v1
kind: VirtualService
metadata:
  name: lambda-routing
  namespace: gloo-system
spec:
  virtualHost:
    domains:
      - "lambda.example.com"
    routes:
      - matchers:
          - prefix: /auth
        routeAction:
          single:
            destinationSpec:
              aws:
                logicalName: user-authentication
                wrapAsApiGateway: true
            upstream:
              name: lambda-upstream
              namespace: gloo-system
        options:
          timeout: 30s

      - matchers:
          - prefix: /process
        routeAction:
          single:
            destinationSpec:
              aws:
                logicalName: data-processor
                invocationStyle: ASYNC
            upstream:
              name: lambda-upstream
              namespace: gloo-system
```

### Google Cloud Functions

```yaml
apiVersion: gloo.solo.io/v1
kind: Upstream
metadata:
  name: gcf-upstream
  namespace: gloo-system
spec:
  gcf:
    projectId: my-gcp-project
    region: us-central1
    secretRef:
      name: gcp-credentials
      namespace: gloo-system
    functions:
      - functionName: image-processor
      - functionName: text-analyzer
---
apiVersion: gateway.solo.io/v1
kind: VirtualService
metadata:
  name: gcf-routing
  namespace: gloo-system
spec:
  virtualHost:
    domains:
      - "gcf.example.com"
    routes:
      - matchers:
          - prefix: /image
        routeAction:
          single:
            destinationSpec:
              gcf:
                functionName: image-processor
            upstream:
              name: gcf-upstream
              namespace: gloo-system
```

### REST to Function Transformation

```yaml
apiVersion: gateway.solo.io/v1
kind: VirtualService
metadata:
  name: rest-to-function
  namespace: gloo-system
spec:
  virtualHost:
    domains:
      - "api.example.com"
    routes:
      - matchers:
          - prefix: /users
            methods:
              - GET
        routeAction:
          single:
            destinationSpec:
              aws:
                logicalName: get-users
                requestTransformation: true
            upstream:
              name: lambda-upstream
              namespace: gloo-system
        options:
          transformations:
            requestTransformation:
              transformationTemplate:
                headers:
                  content-type:
                    text: application/json
                body:
                  text: |
                    {
                      "action": "list",
                      "limit": {{ default(extractQuery("limit"), 100) }},
                      "offset": {{ default(extractQuery("offset"), 0) }}
                    }
            responseTransformation:
              transformationTemplate:
                headers:
                  content-type:
                    text: application/json
                body:
                  text: |
                    {
                      "users": {{ body.Items }},
                      "total": {{ body.Count }}
                    }
```

## GraphQL Gateway

### GraphQL Schema Stitching

```yaml
apiVersion: gateway.solo.io/v1
kind: VirtualService
metadata:
  name: graphql-gateway
  namespace: gloo-system
spec:
  virtualHost:
    domains:
      - "graphql.example.com"
    routes:
      - matchers:
          - prefix: /graphql
        routeAction:
          single:
            upstream:
              name: graphql-server
              namespace: gloo-system
        options:
          graphql:
            schema:
              inlineSchema: |
                type Query {
                  user(id: ID!): User
                  products: [Product]
                }

                type User {
                  id: ID!
                  name: String!
                  orders: [Order]
                }

                type Product {
                  id: ID!
                  name: String!
                  price: Float!
                }

                type Order {
                  id: ID!
                  userId: ID!
                  productId: ID!
                  quantity: Int!
                }

            executors:
              - upstream:
                  name: user-service-default-8080
                  namespace: gloo-system
                queries:
                  - fieldName: user
                    requestTransformation:
                      headers:
                        content-type:
                          text: application/json
                      body:
                        text: |
                          {
                            "userId": "{{ .Args.id }}"
                          }

              - upstream:
                  name: product-service-default-8080
                  namespace: gloo-system
                queries:
                  - fieldName: products
```

### GraphQL with Authentication

```yaml
apiVersion: gateway.solo.io/v1
kind: VirtualService
metadata:
  name: secure-graphql
  namespace: gloo-system
spec:
  virtualHost:
    domains:
      - "graphql.example.com"
    options:
      extauth:
        configRef:
          name: oauth-config
          namespace: gloo-system
    routes:
      - matchers:
          - prefix: /graphql
        routeAction:
          single:
            upstream:
              name: graphql-server
              namespace: gloo-system
        options:
          graphql:
            schema:
              graphqlSchemaRef:
                name: stitched-schema
                namespace: gloo-system
```

## Advanced Transformations

### Request Transformation

```yaml
apiVersion: gateway.solo.io/v1
kind: VirtualService
metadata:
  name: request-transform
  namespace: gloo-system
spec:
  virtualHost:
    domains:
      - "api.example.com"
    routes:
      - matchers:
          - prefix: /api
        routeAction:
          single:
            upstream:
              name: backend-service
              namespace: gloo-system
        options:
          transformations:
            requestTransformation:
              transformationTemplate:
                # Extract and transform headers
                headers:
                  x-user-id:
                    text: '{{ header("Authorization") | jwt("sub") }}'
                  x-request-id:
                    text: '{{ uuid() }}'
                  content-type:
                    text: application/json

                # Transform body
                body:
                  text: |
                    {
                      "requestId": "{{ uuid() }}",
                      "timestamp": "{{ now() }}",
                      "user": {
                        "id": "{{ header("Authorization") | jwt("sub") }}",
                        "email": "{{ header("Authorization") | jwt("email") }}"
                      },
                      "originalRequest": {{ body() }},
                      "metadata": {
                        "sourceIp": "{{ header("X-Forwarded-For") }}",
                        "userAgent": "{{ header("User-Agent") }}"
                      }
                    }

                # Passthrough query parameters
                passthrough: {}
```

### Response Transformation

```yaml
apiVersion: gateway.solo.io/v1
kind: VirtualService
metadata:
  name: response-transform
  namespace: gloo-system
spec:
  virtualHost:
    domains:
      - "api.example.com"
    routes:
      - matchers:
          - prefix: /api
        routeAction:
          single:
            upstream:
              name: backend-service
              namespace: gloo-system
        options:
          transformations:
            responseTransformation:
              transformationTemplate:
                headers:
                  x-response-time:
                    text: '{{ header("x-envoy-upstream-service-time") }}'
                  cache-control:
                    text: public, max-age=300

                body:
                  text: |
                    {
                      "status": "success",
                      "data": {{ body() }},
                      "metadata": {
                        "responseTime": "{{ header("x-envoy-upstream-service-time") }}ms",
                        "version": "v1"
                      }
                    }
```

## Authentication and Authorization

### API Key Authentication

```yaml
apiVersion: enterprise.gloo.solo.io/v1
kind: AuthConfig
metadata:
  name: api-key-auth
  namespace: gloo-system
spec:
  configs:
    - apiKeyAuth:
        headerName: X-API-Key
        headersFromMetadata:
          X-User-ID:
            name: user-id
        labelSelector:
          app: api-gateway
---
apiVersion: v1
kind: Secret
metadata:
  name: api-key-secret
  namespace: gloo-system
  labels:
    app: api-gateway
type: extauth.solo.io/apikey
stringData:
  api-key: "super-secret-key-12345"
  user-id: "user-123"
  metadata: |
    {
      "plan": "premium",
      "rateLimit": 10000
    }
```

### OAuth 2.0 / OIDC

```yaml
apiVersion: enterprise.gloo.solo.io/v1
kind: AuthConfig
metadata:
  name: oauth-config
  namespace: gloo-system
spec:
  configs:
    - oauth2:
        oidcAuthorizationCode:
          appUrl: "https://api.example.com"
          callbackPath: /callback
          clientId: gloo-api-gateway
          clientSecretRef:
            name: oauth-secret
            namespace: gloo-system
          issuerUrl: "https://auth.example.com"
          scopes:
            - openid
            - email
            - profile
          session:
            cookieOptions:
              maxAge: 3600
              secure: true
              httpOnly: true
              sameSite: Lax
            redis:
              options:
                host: redis.gloo-system.svc.cluster.local:6379
                db: 0
          headers:
            idTokenHeader: X-Id-Token
            accessTokenHeader: X-Access-Token
---
apiVersion: gateway.solo.io/v1
kind: VirtualService
metadata:
  name: oauth-protected
  namespace: gloo-system
spec:
  virtualHost:
    domains:
      - "api.example.com"
    options:
      extauth:
        configRef:
          name: oauth-config
          namespace: gloo-system
    routes:
      - matchers:
          - prefix: /
        routeAction:
          single:
            upstream:
              name: protected-service
              namespace: gloo-system
```

### JWT Validation

```yaml
apiVersion: enterprise.gloo.solo.io/v1
kind: AuthConfig
metadata:
  name: jwt-auth
  namespace: gloo-system
spec:
  configs:
    - jwt:
        providers:
          auth0:
            issuer: "https://auth.example.com/"
            audiences:
              - api.example.com
            jwks:
              remote:
                url: "https://auth.example.com/.well-known/jwks.json"
                cacheDuration: 300s
            tokenSource:
              headers:
                - header: Authorization
                  prefix: "Bearer "
            claimsToHeaders:
              - claim: sub
                header: X-User-ID
              - claim: email
                header: X-User-Email
```

### OPA (Open Policy Agent) Integration

```yaml
apiVersion: enterprise.gloo.solo.io/v1
kind: AuthConfig
metadata:
  name: opa-auth
  namespace: gloo-system
spec:
  configs:
    - opaAuth:
        modules:
          - name: main
            namespace: gloo-system
        query: "data.example.allow == true"
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: main
  namespace: gloo-system
data:
  main.rego: |
    package example

    import input.attributes.request.http as http_request

    default allow = false

    # Allow if user has admin role
    allow {
      http_request.headers["x-user-role"] == "admin"
    }

    # Allow read operations for authenticated users
    allow {
      http_request.method == "GET"
      http_request.headers["authorization"]
    }

    # Allow specific paths for all users
    allow {
      startswith(http_request.path, "/public")
    }
```

## Rate Limiting

### Per-User Rate Limiting

```yaml
apiVersion: ratelimit.solo.io/v1alpha1
kind: RateLimitConfig
metadata:
  name: user-rate-limit
  namespace: gloo-system
spec:
  raw:
    descriptors:
      - key: user_id
        value: "*"
        rateLimit:
          requestsPerUnit: 100
          unit: MINUTE

      - key: user_id
        value: "premium"
        rateLimit:
          requestsPerUnit: 10000
          unit: MINUTE
---
apiVersion: gateway.solo.io/v1
kind: VirtualService
metadata:
  name: rate-limited-api
  namespace: gloo-system
spec:
  virtualHost:
    domains:
      - "api.example.com"
    options:
      rateLimitConfigs:
        refs:
          - name: user-rate-limit
            namespace: gloo-system
    routes:
      - matchers:
          - prefix: /api
        routeAction:
          single:
            upstream:
              name: api-service
              namespace: gloo-system
        options:
          ratelimitBasic:
            anonymousLimits:
              requestsPerUnit: 10
              unit: MINUTE
            authorizedLimits:
              requestsPerUnit: 100
              unit: MINUTE
```

### Advanced Rate Limiting with Redis

```yaml
apiVersion: ratelimit.solo.io/v1alpha1
kind: RateLimitConfig
metadata:
  name: advanced-rate-limit
  namespace: gloo-system
spec:
  raw:
    rateLimits:
      - actions:
          - genericKey:
              descriptorValue: "per-minute"
          - requestHeaders:
              headerName: X-User-ID
              descriptorKey: user_id
    descriptors:
      - key: generic_key
        value: "per-minute"
        descriptors:
          - key: user_id
            rateLimit:
              requestsPerUnit: 100
              unit: MINUTE
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: rate-limit-server-config
  namespace: gloo-system
data:
  redis:
    url: redis://redis.gloo-system.svc.cluster.local:6379
    poolSize: 10
```

## Traffic Management

### Canary Deployments

```yaml
apiVersion: gateway.solo.io/v1
kind: VirtualService
metadata:
  name: canary-deployment
  namespace: gloo-system
spec:
  virtualHost:
    domains:
      - "app.example.com"
    routes:
      - matchers:
          - prefix: /
        routeAction:
          multi:
            destinations:
              - weight: 90
                destination:
                  upstream:
                    name: app-stable
                    namespace: gloo-system
              - weight: 10
                destination:
                  upstream:
                    name: app-canary
                    namespace: gloo-system
        options:
          headerManipulation:
            requestHeadersToAdd:
              - header:
                  key: X-Deployment-Version
                  value: "canary"
                appendAction: OVERWRITE_IF_EXISTS_OR_ADD
```

### Header-Based Routing

```yaml
apiVersion: gateway.solo.io/v1
kind: VirtualService
metadata:
  name: header-routing
  namespace: gloo-system
spec:
  virtualHost:
    domains:
      - "api.example.com"
    routes:
      # Beta users route
      - matchers:
          - prefix: /
            headers:
              - name: X-User-Group
                value: beta
        routeAction:
          single:
            upstream:
              name: api-beta
              namespace: gloo-system
        options:
          prefixRewrite: /

      # Default route
      - matchers:
          - prefix: /
        routeAction:
          single:
            upstream:
              name: api-stable
              namespace: gloo-system
```

### Circuit Breaking

```yaml
apiVersion: gloo.solo.io/v1
kind: Upstream
metadata:
  name: api-service
  namespace: gloo-system
spec:
  kube:
    serviceName: api-service
    serviceNamespace: default
    servicePort: 8080
  circuitBreakers:
    maxConnections: 1024
    maxPendingRequests: 1024
    maxRequests: 1024
    maxRetries: 3
  outlierDetection:
    consecutive5xx: 5
    interval: 10s
    baseEjectionTime: 30s
    maxEjectionPercent: 50
```

### Retry Policies

```yaml
apiVersion: gateway.solo.io/v1
kind: VirtualService
metadata:
  name: retry-policy
  namespace: gloo-system
spec:
  virtualHost:
    domains:
      - "api.example.com"
    routes:
      - matchers:
          - prefix: /api
        routeAction:
          single:
            upstream:
              name: api-service
              namespace: gloo-system
        options:
          retries:
            retryOn: "5xx,reset,connect-failure,refused-stream"
            numRetries: 3
            perTryTimeout: 5s
          timeout: 15s
```

## Observability and Monitoring

### Prometheus Metrics

```yaml
apiVersion: gloo.solo.io/v1
kind: Settings
metadata:
  name: default
  namespace: gloo-system
spec:
  observabilityOptions:
    grafanaIntegration:
      enabled: true
      defaultDashboardsEnabled: true
```

### Access Logging

```yaml
apiVersion: gateway.solo.io/v1
kind: VirtualService
metadata:
  name: access-logging
  namespace: gloo-system
spec:
  virtualHost:
    domains:
      - "api.example.com"
    options:
      accessLoggingService:
        accessLog:
          - fileSink:
              path: /dev/stdout
              jsonFormat:
                timestamp: "%START_TIME%"
                method: "%REQ(:METHOD)%"
                path: "%REQ(X-ENVOY-ORIGINAL-PATH?:PATH)%"
                status: "%RESPONSE_CODE%"
                duration: "%DURATION%"
                bytes_sent: "%BYTES_SENT%"
                bytes_received: "%BYTES_RECEIVED%"
                user_agent: "%REQ(USER-AGENT)%"
                request_id: "%REQ(X-REQUEST-ID)%"
                upstream_host: "%UPSTREAM_HOST%"
```

### Distributed Tracing

```yaml
apiVersion: gloo.solo.io/v1
kind: Settings
metadata:
  name: default
  namespace: gloo-system
spec:
  observabilityOptions:
    tracingOptions:
      provider:
        name: zipkin
        cluster:
          name: zipkin
          namespace: tracing
      verbose: true
```

## Troubleshooting

### Debug Mode

```bash
# Enable debug logging
glooctl debug logs --level debug

# Get gateway configuration
glooctl get proxy gateway-proxy -o yaml

# Check upstream status
glooctl get upstream

# View Envoy configuration
kubectl port-forward -n gloo-system deployment/gateway-proxy 19000:19000
curl http://localhost:19000/config_dump
```

### Common Issues Script

```bash
#!/bin/bash
# gloo-troubleshoot.sh

echo "=== Gloo Edge Troubleshooting ==="

# Check pod status
echo -e "\n1. Pod Status:"
kubectl get pods -n gloo-system

# Check virtual services
echo -e "\n2. Virtual Services:"
glooctl get virtualservice

# Check upstreams
echo -e "\n3. Upstreams:"
glooctl get upstream

# Check proxy status
echo -e "\n4. Proxy Status:"
glooctl get proxy

# Check logs
echo -e "\n5. Recent Gateway Logs:"
kubectl logs -n gloo-system deployment/gateway-proxy --tail=50

echo -e "\n6. Recent Controller Logs:"
kubectl logs -n gloo-system deployment/gloo --tail=50
```

## Production Best Practices

### High Availability Setup

```yaml
gatewayProxies:
  gatewayProxy:
    kind:
      deployment:
        replicas: 5
    antiAffinity: true
    podDisruptionBudget:
      minAvailable: 3
```

### Security Hardening

```yaml
gatewayProxies:
  gatewayProxy:
    podTemplate:
      securityContext:
        runAsNonRoot: true
        runAsUser: 10101
        fsGroup: 10101
      containerSecurityContext:
        allowPrivilegeEscalation: false
        capabilities:
          drop:
            - ALL
          add:
            - NET_BIND_SERVICE
```

## Conclusion

Gloo Edge represents a modern approach to API gateway architecture, combining Envoy Proxy's performance with powerful features like function-level routing, GraphQL stitching, and advanced transformations. Its cloud-native design and extensive integration capabilities make it ideal for enterprises building sophisticated API management platforms.

Key advantages of Gloo Edge:
- Function-level routing to serverless platforms
- Native GraphQL schema stitching
- Powerful transformation engine
- Envoy-based performance and extensibility
- Hybrid architecture support (VMs, containers, serverless)
- Enterprise features for multi-tenancy and observability

By leveraging the configurations in this guide, organizations can build next-generation API gateways that bridge traditional microservices with modern serverless architectures while maintaining enterprise-grade security and observability.