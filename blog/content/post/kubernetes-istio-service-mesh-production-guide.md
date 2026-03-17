---
title: "Kubernetes Istio Service Mesh: mTLS, Traffic Management, Circuit Breaking, and Observability"
date: 2028-07-05T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Istio", "Service Mesh", "mTLS", "Traffic Management"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-focused guide to deploying and operating Istio service mesh on Kubernetes, covering mTLS configuration, advanced traffic management, circuit breaking, and deep observability integration."
more_link: "yes"
url: "/kubernetes-istio-service-mesh-production-guide/"
---

Istio is one of the most powerful and controversial tools in the Kubernetes ecosystem. When implemented well, it delivers automatic mTLS, granular traffic control, deep observability, and zero-code security enforcement. When implemented poorly, it introduces latency spikes, mysterious connection failures, and operational complexity that overwhelms teams not prepared for it. This guide is for the teams who want the former.

We will cover Istio installation, mTLS architecture and configuration, real-world traffic management patterns including weighted routing and header-based routing, circuit breaking with outlier detection, and the full observability stack with Prometheus, Jaeger, and Kiali. Every section includes troubleshooting guidance drawn from production incidents.

<!--more-->

# Kubernetes Istio Service Mesh: Production Guide

## Section 1: Architecture and Installation

### Understanding the Data Plane and Control Plane

Istio consists of two planes:

- **Control plane (istiod)**: Manages configuration, certificate issuance, and service discovery. Watches Kubernetes resources and translates them to Envoy xDS configuration.
- **Data plane**: Envoy sidecar proxies injected into each pod. They intercept all inbound and outbound traffic without application changes.

The sidecar proxy intercepts traffic at the network level using `iptables` rules injected by the `istio-init` init container (or CNI plugin in newer versions). All TCP traffic on all ports is redirected through the proxy before reaching the application container.

### Installing Istio with istioctl

Always use `istioctl` for production installations rather than Helm directly:

```bash
# Download the latest stable release
curl -L https://istio.io/downloadIstio | ISTIO_VERSION=1.21.0 sh -
export PATH=$PWD/istio-1.21.0/bin:$PATH

# Verify the installation prerequisites
istioctl x precheck

# Install with a production profile
istioctl install --set profile=default \
  --set values.global.proxy.resources.requests.cpu=100m \
  --set values.global.proxy.resources.requests.memory=128Mi \
  --set values.global.proxy.resources.limits.cpu=500m \
  --set values.global.proxy.resources.limits.memory=512Mi \
  -y

# Verify the installation
istioctl verify-install
kubectl get pods -n istio-system
```

For production, use an `IstioOperator` manifest for reproducibility:

```yaml
# istio-operator.yaml
apiVersion: install.istio.io/v1alpha1
kind: IstioOperator
metadata:
  name: production
  namespace: istio-system
spec:
  profile: default
  meshConfig:
    accessLogFile: /dev/stdout
    accessLogEncoding: JSON
    enableTracing: true
    defaultConfig:
      tracing:
        sampling: 1.0  # 100% in staging, reduce to 0.1 in production
        zipkin:
          address: jaeger-collector.observability:9411
    outboundTrafficPolicy:
      mode: REGISTRY_ONLY  # Block traffic to unregistered services
  components:
    pilot:
      k8s:
        resources:
          requests:
            cpu: 500m
            memory: 2048Mi
          limits:
            cpu: 1000m
            memory: 4096Mi
        hpaSpec:
          minReplicas: 2
          maxReplicas: 5
    ingressGateways:
    - name: istio-ingressgateway
      enabled: true
      k8s:
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 2000m
            memory: 1024Mi
        hpaSpec:
          minReplicas: 2
          maxReplicas: 10
        service:
          type: LoadBalancer
  values:
    global:
      proxy:
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
        holdApplicationUntilProxyStarts: true  # Prevent race conditions
```

```bash
istioctl install -f istio-operator.yaml -y
```

### Enabling Sidecar Injection

```bash
# Enable auto-injection for a namespace
kubectl label namespace production istio-injection=enabled

# Verify the label
kubectl get namespace production --show-labels

# Inject manually into an existing deployment
kubectl get deployment my-app -n production -o yaml | \
  istioctl kube-inject -f - | \
  kubectl apply -f -

# Disable injection for a specific pod
kubectl annotate pod my-app-pod sidecar.istio.io/inject=false
```

## Section 2: Mutual TLS Configuration

### Understanding Istio mTLS Modes

Istio has three mTLS modes:

- **PERMISSIVE**: Accepts both plain text and mTLS traffic. Used during migration.
- **STRICT**: Requires mTLS for all traffic. Production setting for zero-trust networks.
- **DISABLE**: No mTLS. Only for debugging.

### Mesh-Wide STRICT mTLS

The recommended production configuration enables strict mTLS mesh-wide:

```yaml
# peer-authentication-strict.yaml
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: istio-system  # Applies to all namespaces
spec:
  mtls:
    mode: STRICT
```

```bash
kubectl apply -f peer-authentication-strict.yaml

# Verify the policy
kubectl get peerauthentication -A
istioctl authn tls-check my-app-pod.production
```

### Namespace-Scoped mTLS with Per-Port Overrides

Some workloads (like Prometheus scraping, databases) need different mTLS configurations:

```yaml
# production-mtls.yaml
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: production-default
  namespace: production
spec:
  mtls:
    mode: STRICT
---
# Allow plain text on metrics port for Prometheus
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: allow-plaintext-metrics
  namespace: production
spec:
  selector:
    matchLabels:
      app: my-app
  mtls:
    mode: STRICT
  portLevelMtls:
    9090:  # metrics port
      mode: PERMISSIVE
```

### Certificate Management

Istio uses its own CA (citadel) by default. For production, integrate with your organization's PKI:

```yaml
# external-ca-istio-operator.yaml
apiVersion: install.istio.io/v1alpha1
kind: IstioOperator
metadata:
  name: production
  namespace: istio-system
spec:
  components:
    pilot:
      k8s:
        env:
        - name: EXTERNAL_CA
          value: "true"
        - name: K8S_SIGNER
          value: "kubernetes.io/kube-apiserver-client"
```

Or use cert-manager with Istio:

```yaml
# Create an issuer for Istio CA
apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: istio-ca
  namespace: istio-system
spec:
  ca:
    secretName: istio-ca-secret
```

Check certificate expiration:

```bash
# Check cert validity for a specific workload
istioctl proxy-config secret my-app-pod.production

# Get detailed cert info
kubectl exec my-app-pod -n production -c istio-proxy -- \
  openssl x509 -in /var/run/secrets/workload-spiffe-credentials/certificates.pem \
  -noout -text | grep -A2 "Validity"
```

## Section 3: Traffic Management

### VirtualService and DestinationRule

These are the two core traffic management resources:

```yaml
# virtualservice.yaml
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: my-app
  namespace: production
spec:
  hosts:
  - my-app  # Kubernetes service name
  http:
  - match:
    - headers:
        x-canary:
          exact: "true"
    route:
    - destination:
        host: my-app
        subset: canary
      weight: 100
  - route:
    - destination:
        host: my-app
        subset: stable
      weight: 90
    - destination:
        host: my-app
        subset: canary
      weight: 10
    timeout: 30s
    retries:
      attempts: 3
      perTryTimeout: 10s
      retryOn: "5xx,reset,connect-failure,retriable-4xx"
---
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: my-app
  namespace: production
spec:
  host: my-app
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 100
        connectTimeout: 30ms
      http:
        http1MaxPendingRequests: 100
        http2MaxRequests: 1000
        maxRequestsPerConnection: 10
    outlierDetection:
      consecutiveGatewayErrors: 5
      consecutive5xxErrors: 5
      interval: 10s
      baseEjectionTime: 30s
      maxEjectionPercent: 50
      minHealthPercent: 30
    loadBalancer:
      simple: LEAST_CONN
  subsets:
  - name: stable
    labels:
      version: stable
    trafficPolicy:
      connectionPool:
        http:
          http2MaxRequests: 1000
  - name: canary
    labels:
      version: canary
    trafficPolicy:
      connectionPool:
        http:
          http2MaxRequests: 200
```

### Ingress Gateway Configuration

```yaml
# gateway.yaml
apiVersion: networking.istio.io/v1beta1
kind: Gateway
metadata:
  name: main-gateway
  namespace: production
spec:
  selector:
    istio: ingressgateway
  servers:
  - port:
      number: 443
      name: https
      protocol: HTTPS
    tls:
      mode: SIMPLE
      credentialName: my-app-tls  # Kubernetes TLS secret
    hosts:
    - "app.example.com"
  - port:
      number: 80
      name: http
      protocol: HTTP
    tls:
      httpsRedirect: true  # Redirect HTTP to HTTPS
    hosts:
    - "app.example.com"
---
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: my-app-ingress
  namespace: production
spec:
  hosts:
  - "app.example.com"
  gateways:
  - main-gateway
  http:
  - match:
    - uri:
        prefix: /api/
    route:
    - destination:
        host: api-service
        port:
          number: 8080
    corsPolicy:
      allowOrigins:
      - exact: "https://app.example.com"
      allowMethods:
      - GET
      - POST
      - PUT
      - DELETE
      allowHeaders:
      - Authorization
      - Content-Type
      maxAge: "24h"
  - route:
    - destination:
        host: frontend-service
        port:
          number: 80
```

### Advanced Traffic Shifting: Blue-Green Deployment

```yaml
# During deployment: shift all traffic to new version
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: my-app
  namespace: production
spec:
  hosts:
  - my-app
  http:
  - route:
    - destination:
        host: my-app
        subset: v2
      weight: 100
    - destination:
        host: my-app
        subset: v1
      weight: 0
```

Script the transition:

```bash
#!/bin/bash
# blue-green-shift.sh

NAMESPACE="production"
VS_NAME="my-app"
NEW_WEIGHT=${1:-10}  # Start with 10% by default

shift_traffic() {
    local new_weight=$1
    local old_weight=$((100 - new_weight))

    kubectl patch virtualservice ${VS_NAME} -n ${NAMESPACE} \
        --type=json \
        -p="[
            {\"op\": \"replace\", \"path\": \"/spec/http/0/route/0/weight\", \"value\": ${old_weight}},
            {\"op\": \"replace\", \"path\": \"/spec/http/0/route/1/weight\", \"value\": ${new_weight}}
        ]"

    echo "Traffic shifted: v1=${old_weight}% v2=${new_weight}%"
}

# Progressive rollout: 10% -> 25% -> 50% -> 100%
for weight in 10 25 50 100; do
    shift_traffic $weight
    echo "Monitoring for 5 minutes at ${weight}%..."
    sleep 300

    # Check error rate
    ERROR_RATE=$(kubectl exec -n monitoring prometheus-0 -- \
        wget -qO- "http://localhost:9090/api/v1/query" \
        --post-data='query=sum(rate(istio_requests_total{destination_service="my-app.production.svc.cluster.local",response_code=~"5.."}[5m]))/sum(rate(istio_requests_total{destination_service="my-app.production.svc.cluster.local"}[5m]))' | \
        jq -r '.data.result[0].value[1]')

    if (( $(echo "$ERROR_RATE > 0.01" | bc -l) )); then
        echo "Error rate too high (${ERROR_RATE}), rolling back"
        shift_traffic 0
        exit 1
    fi
done

echo "Deployment complete"
```

### Fault Injection for Chaos Testing

```yaml
# Inject 5% HTTP 500 errors
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: my-app-fault-test
  namespace: staging
spec:
  hosts:
  - my-app
  http:
  - fault:
      abort:
        percentage:
          value: 5.0
        httpStatus: 500
      delay:
        percentage:
          value: 10.0
        fixedDelay: 2s
    route:
    - destination:
        host: my-app
        subset: stable
```

## Section 4: Circuit Breaking with Outlier Detection

Circuit breaking in Istio is implemented via `outlierDetection` in `DestinationRule`. Unlike application-level circuit breakers (Hystrix, resilience4j), Istio's circuit breaker operates at the proxy layer and requires no code changes:

```yaml
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: circuit-breaker-example
  namespace: production
spec:
  host: payment-service
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 50
      http:
        http1MaxPendingRequests: 50
        http2MaxRequests: 500
        maxRetries: 3
    outlierDetection:
      # Eject after 5 consecutive gateway errors
      consecutiveGatewayErrors: 5
      # Eject after 5 consecutive 5xx errors
      consecutive5xxErrors: 5
      # Check interval
      interval: 5s
      # Base ejection time (doubles with each ejection)
      baseEjectionTime: 30s
      # Maximum percentage of hosts that can be ejected
      maxEjectionPercent: 100
      # Minimum percentage of healthy hosts to keep active
      minHealthPercent: 0
      # Split external (5xx) from local (reset, connect-failure)
      splitExternalLocalOriginErrors: true
      consecutiveLocalOriginFailures: 3
```

Test the circuit breaker:

```bash
# Install fortio for load testing
kubectl apply -f https://raw.githubusercontent.com/istio/istio/release-1.21/samples/httpbin/httpbin.yaml -n production

# Generate traffic and observe circuit breaking
kubectl exec -it fortio-pod -n production -- \
  fortio load -c 10 -qps 100 -n 1000 \
  http://payment-service:8080/checkout

# Watch outlier detection events
kubectl logs -n istio-system -l app=istiod --since=5m | grep -i outlier
```

## Section 5: Authorization Policies

Istio's `AuthorizationPolicy` implements zero-trust access control at L7:

```yaml
# Default deny all in production namespace
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: deny-all
  namespace: production
spec: {}  # Empty spec = deny all
---
# Allow frontend to reach API service
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: allow-frontend-to-api
  namespace: production
spec:
  selector:
    matchLabels:
      app: api-service
  action: ALLOW
  rules:
  - from:
    - source:
        principals:
        - "cluster.local/ns/production/sa/frontend"
    to:
    - operation:
        methods: ["GET", "POST"]
        paths: ["/api/*"]
---
# Allow API to reach database
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: allow-api-to-db
  namespace: production
spec:
  selector:
    matchLabels:
      app: postgres
  action: ALLOW
  rules:
  - from:
    - source:
        principals:
        - "cluster.local/ns/production/sa/api-service"
    to:
    - operation:
        ports: ["5432"]
---
# Allow Prometheus scraping from monitoring namespace
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: allow-prometheus
  namespace: production
spec:
  action: ALLOW
  rules:
  - from:
    - source:
        namespaces: ["monitoring"]
    to:
    - operation:
        methods: ["GET"]
        paths: ["/metrics"]
```

### JWT Validation at the Ingress

```yaml
# Validate JWTs at the ingress gateway
apiVersion: security.istio.io/v1beta1
kind: RequestAuthentication
metadata:
  name: jwt-validation
  namespace: production
spec:
  selector:
    matchLabels:
      app: api-service
  jwtRules:
  - issuer: "https://auth.example.com"
    jwksUri: "https://auth.example.com/.well-known/jwks.json"
    audiences:
    - "api.example.com"
    forwardOriginalToken: true
---
# Require valid JWT for API endpoints
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: require-jwt
  namespace: production
spec:
  selector:
    matchLabels:
      app: api-service
  action: ALLOW
  rules:
  - from:
    - source:
        requestPrincipals: ["https://auth.example.com/*"]
    to:
    - operation:
        paths: ["/api/*"]
        methods: ["GET", "POST", "PUT", "DELETE"]
    when:
    - key: request.auth.claims[role]
      values: ["admin", "user"]
```

## Section 6: Observability Integration

### Prometheus and Grafana

Istio exposes rich metrics from the Envoy proxy:

```yaml
# PodMonitor for Istio proxy metrics
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: istio-proxy
  namespace: monitoring
spec:
  selector:
    matchLabels:
      security.istio.io/tlsMode: istio
  podMetricsEndpoints:
  - path: /stats/prometheus
    port: "15020"
    interval: 15s
  namespaceSelector:
    any: true
```

Key Istio metrics to alert on:

```yaml
# PrometheusRule for Istio
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: istio-alerts
  namespace: monitoring
spec:
  groups:
  - name: istio.service
    rules:
    - alert: IstioHighRequestLatency
      expr: |
        histogram_quantile(0.99,
          sum(rate(istio_request_duration_milliseconds_bucket{
            reporter="destination"
          }[5m])) by (destination_service_name, destination_service_namespace, le)
        ) > 1000
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "High p99 latency for {{ $labels.destination_service_name }}"
        description: "p99 latency is {{ $value }}ms"

    - alert: IstioHighErrorRate
      expr: |
        sum(rate(istio_requests_total{
          reporter="destination",
          response_code=~"5.."
        }[5m])) by (destination_service_name, destination_service_namespace)
        /
        sum(rate(istio_requests_total{
          reporter="destination"
        }[5m])) by (destination_service_name, destination_service_namespace)
        > 0.05
      for: 5m
      labels:
        severity: critical

    - alert: IstioCircuitBreakerOpen
      expr: |
        sum(envoy_cluster_outlier_detection_ejections_active) by (cluster_name) > 0
      for: 1m
      labels:
        severity: warning
      annotations:
        summary: "Circuit breaker active for {{ $labels.cluster_name }}"
```

### Distributed Tracing with Jaeger

```yaml
# Install Jaeger operator
kubectl create namespace observability
kubectl apply -f https://github.com/jaegertracing/jaeger-operator/releases/download/v1.55.0/jaeger-operator.yaml -n observability

# Deploy a production Jaeger instance with Elasticsearch backend
apiVersion: jaegertracing.io/v1
kind: Jaeger
metadata:
  name: production
  namespace: observability
spec:
  strategy: production
  collector:
    replicas: 2
    resources:
      requests:
        cpu: 200m
        memory: 256Mi
      limits:
        cpu: 1000m
        memory: 512Mi
  query:
    replicas: 2
  storage:
    type: elasticsearch
    elasticsearch:
      nodeCount: 3
      resources:
        requests:
          cpu: 1
          memory: 2Gi
        limits:
          cpu: 2
          memory: 4Gi
```

Configure Istio to send traces to Jaeger:

```bash
# Update the mesh config
kubectl edit configmap istio -n istio-system

# Add/update tracing config:
# defaultConfig:
#   tracing:
#     sampling: 10  # 10% sampling rate in production
#     zipkin:
#       address: "jaeger-collector.observability.svc.cluster.local:9411"
```

### Custom Access Log Format

```yaml
apiVersion: install.istio.io/v1alpha1
kind: IstioOperator
spec:
  meshConfig:
    accessLogFile: /dev/stdout
    accessLogEncoding: JSON
    accessLogFormat: |
      {
        "start_time": "%START_TIME%",
        "method": "%REQ(:METHOD)%",
        "path": "%REQ(X-ENVOY-ORIGINAL-PATH?:PATH)%",
        "protocol": "%PROTOCOL%",
        "response_code": "%RESPONSE_CODE%",
        "response_flags": "%RESPONSE_FLAGS%",
        "bytes_received": "%BYTES_RECEIVED%",
        "bytes_sent": "%BYTES_SENT%",
        "duration": "%DURATION%",
        "upstream_service_time": "%RESP(X-ENVOY-UPSTREAM-SERVICE-TIME)%",
        "x_forwarded_for": "%REQ(X-FORWARDED-FOR)%",
        "user_agent": "%REQ(USER-AGENT)%",
        "request_id": "%REQ(X-REQUEST-ID)%",
        "trace_id": "%REQ(X-B3-TRACEID)%",
        "authority": "%REQ(:AUTHORITY)%",
        "upstream_host": "%UPSTREAM_HOST%",
        "upstream_cluster": "%UPSTREAM_CLUSTER%",
        "upstream_local_address": "%UPSTREAM_LOCAL_ADDRESS%",
        "downstream_local_address": "%DOWNSTREAM_LOCAL_ADDRESS%",
        "downstream_remote_address": "%DOWNSTREAM_REMOTE_ADDRESS%",
        "requested_server_name": "%REQUESTED_SERVER_NAME%"
      }
```

## Section 7: Service Entries for External Services

Istio's `REGISTRY_ONLY` egress mode blocks all traffic to unregistered services. Register external services explicitly:

```yaml
# Allow access to AWS S3
apiVersion: networking.istio.io/v1beta1
kind: ServiceEntry
metadata:
  name: aws-s3
  namespace: production
spec:
  hosts:
  - "*.s3.amazonaws.com"
  - "*.s3.us-east-1.amazonaws.com"
  ports:
  - number: 443
    name: https
    protocol: HTTPS
  location: MESH_EXTERNAL
  resolution: DNS
---
# Allow access to a specific external API
apiVersion: networking.istio.io/v1beta1
kind: ServiceEntry
metadata:
  name: stripe-api
  namespace: production
spec:
  hosts:
  - api.stripe.com
  ports:
  - number: 443
    name: https
    protocol: HTTPS
  location: MESH_EXTERNAL
  resolution: DNS
---
# Apply traffic policy to external service
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: stripe-api
  namespace: production
spec:
  host: api.stripe.com
  trafficPolicy:
    tls:
      mode: SIMPLE  # originate TLS to external service
    connectionPool:
      http:
        h2UpgradePolicy: UPGRADE
    outlierDetection:
      consecutiveGatewayErrors: 3
      interval: 30s
      baseEjectionTime: 60s
```

## Section 8: Troubleshooting

### Proxy Configuration Debugging

```bash
# Check the effective proxy configuration
istioctl proxy-config all my-app-pod.production

# Check routes
istioctl proxy-config routes my-app-pod.production

# Check clusters
istioctl proxy-config clusters my-app-pod.production

# Check listeners
istioctl proxy-config listeners my-app-pod.production

# Check endpoints
istioctl proxy-config endpoints my-app-pod.production

# Analyze configuration for issues
istioctl analyze -n production

# Check the sync status between istiod and proxy
istioctl proxy-status
```

### Common Issues and Solutions

Issue: Pod cannot reach external service with REGISTRY_ONLY mode

```bash
# Check if the service entry exists
kubectl get serviceentry -n production

# Look at the proxy logs for blocked traffic
kubectl logs my-app-pod -n production -c istio-proxy | \
  grep "BlackHoleCluster\|PassthroughCluster"

# Temporarily allow all egress (debug only)
kubectl apply -f - <<EOF
apiVersion: networking.istio.io/v1beta1
kind: Sidecar
metadata:
  name: debug-egress
  namespace: production
spec:
  egress:
  - hosts:
    - "./*"
    - "istio-system/*"
EOF
```

Issue: mTLS breaking non-Istio workloads

```bash
# Check which workloads lack sidecars
kubectl get pods -n production -o json | \
  jq -r '.items[] | select(.spec.containers | map(.name) | contains(["istio-proxy"]) | not) | .metadata.name'

# Set PERMISSIVE mode for a specific service
kubectl apply -f - <<EOF
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: legacy-app-permissive
  namespace: production
spec:
  selector:
    matchLabels:
      app: legacy-app
  mtls:
    mode: PERMISSIVE
EOF
```

Issue: 503 errors after deployment

```bash
# Check outlier detection ejections
istioctl proxy-config clusters my-app-pod.production | grep -i outlier

# Check the Envoy admin endpoint
kubectl exec my-app-pod -n production -c istio-proxy -- \
  curl -s http://localhost:15000/stats | grep outlier_detection

# View recent rejected connections
kubectl exec my-app-pod -n production -c istio-proxy -- \
  curl -s http://localhost:15000/stats | grep upstream_cx_connect_fail

# Reset outlier detection
kubectl exec my-app-pod -n production -c istio-proxy -- \
  curl -s -X POST http://localhost:15000/reset_counters
```

### Debugging with Kiali

Kiali provides a visual service graph that is invaluable for troubleshooting:

```bash
# Install Kiali
kubectl apply -f https://raw.githubusercontent.com/istio/istio/release-1.21/samples/addons/kiali.yaml

# Port-forward to access Kiali
kubectl port-forward svc/kiali 20001:20001 -n istio-system

# Or create an ingress route
kubectl apply -f - <<EOF
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: kiali
  namespace: istio-system
spec:
  hosts:
  - kiali.example.com
  gateways:
  - main-gateway
  http:
  - route:
    - destination:
        host: kiali
        port:
          number: 20001
EOF
```

## Section 9: Performance Tuning

### Reducing Sidecar Overhead

The Envoy sidecar adds latency. Production tuning:

```yaml
# Tune proxy concurrency (default: 2)
apiVersion: networking.istio.io/v1beta1
kind: Sidecar
metadata:
  name: high-throughput-app
  namespace: production
spec:
  workloadSelector:
    labels:
      app: high-throughput-app
  ingress:
  - port:
      number: 8080
      protocol: HTTP
      name: http
    defaultEndpoint: 127.0.0.1:8080
  egress:
  - hosts:
    - "./database-service.production.svc.cluster.local"
    - "./cache-service.production.svc.cluster.local"
    - "istio-system/*"
```

Limiting the egress hosts in `Sidecar` resources significantly reduces the xDS configuration size pushed to each proxy.

```bash
# Check proxy configuration size
kubectl exec my-app-pod -n production -c istio-proxy -- \
  curl -s http://localhost:15000/config_dump | wc -c

# With Sidecar resource scoping, this should drop from MBs to KBs
```

### Connection Pool Tuning

```yaml
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: high-traffic-service
  namespace: production
spec:
  host: high-traffic-service
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 1000
        tcpKeepalive:
          time: 7200s
          interval: 75s
          probes: 9
      http:
        http1MaxPendingRequests: 1000
        http2MaxRequests: 10000
        maxRequestsPerConnection: 100  # Prevent connection monopolization
        maxRetries: 3
        consecutiveGatewayErrors: 5
        h2UpgradePolicy: UPGRADE  # Use HTTP/2 where possible
```

## Section 10: Upgrade Strategy

Upgrading Istio in production requires a canary approach using revision-based upgrades:

```bash
# Install new version with a revision label
istioctl install \
  --set revision=1-21 \
  --set values.global.proxy.holdApplicationUntilProxyStarts=true \
  -y

# Verify new control plane is running
kubectl get pods -n istio-system -l app=istiod,istio.io/rev=1-21

# Migrate namespaces one at a time
# Remove old injection label and add revision label
kubectl label namespace staging istio-injection- istio.io/rev=1-21

# Restart pods in the namespace to use new proxy
kubectl rollout restart deployment -n staging

# Verify pods are using new proxy version
istioctl proxy-status -i 1-21 | grep staging

# After validating, migrate production
kubectl label namespace production istio-injection- istio.io/rev=1-21
kubectl rollout restart deployment -n production

# Remove old revision after all namespaces migrated
istioctl uninstall --revision 1-20 -y
```

## Conclusion

Istio's value is proportional to the investment in understanding its configuration model. The teams that succeed with Istio treat it as a platform concern rather than a development concern — a dedicated mesh operations team owns VirtualServices and DestinationRules as infrastructure, not individual development teams. The authorization policy model, when applied systematically with a default-deny posture, delivers the kind of fine-grained network security that was previously only achievable with complex firewall rules. The observability stack — Prometheus, Jaeger, Kiali — provides immediate insight into service-to-service communication that is otherwise invisible.

The production patterns here — revision-based upgrades, Sidecar scoping for performance, structured access logs, and progressive traffic shifting — represent the difference between a successful Istio deployment and one that gets ripped out after the first incident.
