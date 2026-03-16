---
title: "Consul Connect Service Mesh: Multi-Platform Service Networking"
date: 2026-05-18T00:00:00-05:00
draft: false
tags: ["Consul", "Service Mesh", "Kubernetes", "HashiCorp", "Service Discovery", "mTLS"]
categories: ["Kubernetes", "Service Mesh", "Cloud Native"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Consul Connect service mesh implementation including service discovery, mTLS, intentions-based access control, and multi-platform integration for enterprise Kubernetes and VM workloads."
more_link: "yes"
url: "/consul-connect-service-mesh/"
---

Consul Connect extends HashiCorp Consul's service discovery capabilities into a full-featured service mesh that spans Kubernetes, VMs, and cloud platforms. This comprehensive guide explores advanced Consul Connect patterns, including intentions-based security, multi-datacenter federation, and hybrid cloud deployments.

<!--more-->

## Consul Architecture and Deployment Models

Consul provides service mesh capabilities across heterogeneous environments, making it ideal for organizations migrating to Kubernetes or running hybrid architectures.

### Production Consul Installation on Kubernetes

```yaml
# Consul Helm values for production deployment
global:
  name: consul
  datacenter: dc1
  image: hashicorp/consul:1.17.0
  imageK8S: hashicorp/consul-k8s-control-plane:1.3.0
  imageConsulDataplane: hashicorp/consul-dataplane:1.3.0

  # Enable service mesh
  enabled: true

  # TLS configuration
  tls:
    enabled: true
    enableAutoEncrypt: true
    httpsOnly: true
    verify: true
    serverAdditionalDNSSANs:
      - consul.example.com

  # Gossip encryption
  gossipEncryption:
    secretName: consul-gossip-encryption-key
    secretKey: key

  # ACL configuration
  acls:
    manageSystemACLs: true
    bootstrapToken:
      secretName: consul-bootstrap-token
      secretKey: token

  # Federation
  federation:
    enabled: true
    createFederationSecret: true

  # Metrics
  metrics:
    enabled: true
    enableAgentMetrics: true
    enableGatewayMetrics: true

# Server configuration
server:
  enabled: true
  replicas: 5
  bootstrapExpect: 5

  # Storage
  storage: 10Gi
  storageClass: fast-ssd

  # Resources
  resources:
    requests:
      cpu: 500m
      memory: 1Gi
    limits:
      cpu: 2000m
      memory: 4Gi

  # Affinity
  affinity: |
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app: {{ template "consul.name" . }}
              component: server
          topologyKey: kubernetes.io/hostname

  # Update strategy
  updatePartition: 0

  # Disruption budget
  disruptionBudget:
    enabled: true
    maxUnavailable: 1

  # Extra configuration
  extraConfig: |
    {
      "log_level": "INFO",
      "server": true,
      "ui": true,
      "enable_script_checks": false,
      "disable_remote_exec": true,
      "performance": {
        "raft_multiplier": 1
      },
      "autopilot": {
        "cleanup_dead_servers": true,
        "last_contact_threshold": "200ms",
        "max_trailing_logs": 250,
        "server_stabilization_time": "10s"
      }
    }

# Client configuration
client:
  enabled: true
  grpc: true

  resources:
    requests:
      cpu: 200m
      memory: 256Mi
    limits:
      cpu: 1000m
      memory: 512Mi

  # Extra configuration
  extraConfig: |
    {
      "log_level": "INFO"
    }

# Connect Inject
connectInject:
  enabled: true
  default: false  # Opt-in annotation required

  # Resources for sidecar
  sidecarProxy:
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        cpu: 500m
        memory: 256Mi

  # Init container
  initContainer:
    resources:
      requests:
        cpu: 50m
        memory: 64Mi
      limits:
        cpu: 100m
        memory: 128Mi

  # Central config
  centralConfig:
    enabled: true
    defaultProtocol: http
    proxyDefaults: |
      {
        "protocol": "http",
        "config": {
          "connect_timeout_ms": 5000,
          "envoy_prometheus_bind_addr": "0.0.0.0:9102"
        }
      }

# Controller
controller:
  enabled: true
  replicas: 2

  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 256Mi

# Mesh Gateway
meshGateway:
  enabled: true
  replicas: 3

  service:
    type: LoadBalancer
    port: 443
    nodePort: null
    annotations: |
      service.beta.kubernetes.io/aws-load-balancer-type: "nlb"

  resources:
    requests:
      cpu: 200m
      memory: 256Mi
    limits:
      cpu: 1000m
      memory: 512Mi

  affinity: |
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app: {{ template "consul.name" . }}
              component: mesh-gateway
          topologyKey: kubernetes.io/hostname

# Ingress Gateway
ingressGateways:
  enabled: true
  defaults:
    replicas: 3

    service:
      type: LoadBalancer
      ports:
        - port: 8080
        - port: 8443

    resources:
      requests:
        cpu: 200m
        memory: 256Mi
      limits:
        cpu: 1000m
        memory: 512Mi

  gateways:
    - name: api-gateway
      replicas: 3
      service:
        type: LoadBalancer
        ports:
          - port: 80
            nodePort: null
          - port: 443
            nodePort: null

# Terminating Gateway
terminatingGateways:
  enabled: true
  defaults:
    replicas: 2

    resources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        cpu: 500m
        memory: 256Mi

  gateways:
    - name: external-services
      replicas: 2

# Prometheus
prometheus:
  enabled: true

# UI
ui:
  enabled: true
  service:
    enabled: true
    type: LoadBalancer
  ingress:
    enabled: true
    hosts:
      - host: consul.example.com
        paths:
          - /
    tls:
      - secretName: consul-tls
        hosts:
          - consul.example.com

# Sync Catalog
syncCatalog:
  enabled: true
  default: true
  toConsul: true
  toK8S: true
  k8sPrefix: ""
  k8sAllowNamespaces: ["*"]
  k8sDenyNamespaces: ["kube-system", "kube-public"]
  k8sSourceNamespace: ""
  consulNamespaces:
    consulDestinationNamespace: "default"
    mirroringK8S: true
    mirroringK8SPrefix: ""
```

### Installation Script

```bash
#!/bin/bash
# Production Consul installation script

set -euo pipefail

CONSUL_VERSION="1.17.0"
CONSUL_HELM_VERSION="1.3.0"

echo "Installing Consul ${CONSUL_VERSION}..."

# Add Consul Helm repo
helm repo add hashicorp https://helm.releases.hashicorp.com
helm repo update

# Create namespace
kubectl create namespace consul || true

# Generate gossip encryption key
kubectl create secret generic consul-gossip-encryption-key \
  --from-literal=key=$(consul keygen) \
  -n consul || true

# Generate bootstrap token
kubectl create secret generic consul-bootstrap-token \
  --from-literal=token=$(uuidgen) \
  -n consul || true

# Install Consul
helm upgrade --install consul hashicorp/consul \
  --namespace consul \
  --version ${CONSUL_HELM_VERSION} \
  --values consul-values.yaml \
  --wait

# Wait for Consul to be ready
echo "Waiting for Consul to be ready..."
kubectl wait --for=condition=available --timeout=600s \
  deployment/consul-connect-injector -n consul
kubectl wait --for=condition=ready --timeout=600s \
  pod -l app=consul -n consul

# Configure Consul CLI
export CONSUL_HTTP_ADDR=https://consul.example.com
export CONSUL_HTTP_TOKEN=$(kubectl get secret consul-bootstrap-token \
  -n consul -o jsonpath='{.data.token}' | base64 -d)

echo "Consul installation completed!"
consul members
```

## Service Registration and Configuration

```yaml
# Service definition with Connect enabled
apiVersion: v1
kind: Service
metadata:
  name: backend-api
  namespace: production
  annotations:
    # Enable service mesh
    consul.hashicorp.com/connect-inject: "true"
    # Service protocol
    consul.hashicorp.com/service-protocol: "http"
    # Service port
    consul.hashicorp.com/service-port: "8080"
    # Metrics configuration
    consul.hashicorp.com/service-metrics-port: "9102"
    consul.hashicorp.com/service-metrics-path: "/metrics"
spec:
  selector:
    app: backend-api
  ports:
    - name: http
      port: 8080
      targetPort: 8080
    - name: metrics
      port: 9102
      targetPort: 9102
---
# Deployment with Connect sidecar
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backend-api
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: backend-api
  template:
    metadata:
      labels:
        app: backend-api
      annotations:
        # Enable Connect injection
        consul.hashicorp.com/connect-inject: "true"

        # Service configuration
        consul.hashicorp.com/service-tags: "api,backend,production"
        consul.hashicorp.com/service-meta-version: "v1.0.0"
        consul.hashicorp.com/service-meta-environment: "production"

        # Upstream services
        consul.hashicorp.com/connect-service-upstreams: "database:5432,redis:6379,payment-service:8080"

        # Proxy configuration
        consul.hashicorp.com/connect-service-protocol: "http"
        consul.hashicorp.com/envoy-extra-args: "--log-level debug"

        # Resource limits
        consul.hashicorp.com/sidecar-proxy-cpu-request: "100m"
        consul.hashicorp.com/sidecar-proxy-cpu-limit: "500m"
        consul.hashicorp.com/sidecar-proxy-memory-request: "128Mi"
        consul.hashicorp.com/sidecar-proxy-memory-limit: "256Mi"
    spec:
      serviceAccountName: backend-api
      containers:
        - name: api
          image: backend-api:v1.0.0
          ports:
            - containerPort: 8080
              name: http
            - containerPort: 9102
              name: metrics
          env:
            # Upstream addresses (localhost because of proxy)
            - name: DATABASE_HOST
              value: "127.0.0.1"
            - name: DATABASE_PORT
              value: "5432"
            - name: REDIS_HOST
              value: "127.0.0.1"
            - name: REDIS_PORT
              value: "6379"
            - name: PAYMENT_SERVICE_URL
              value: "http://127.0.0.1:8080"
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
            limits:
              cpu: 1000m
              memory: 512Mi
---
# ServiceAccount for ACLs
apiVersion: v1
kind: ServiceAccount
metadata:
  name: backend-api
  namespace: production
```

## Service Intentions for Access Control

```yaml
# ServiceIntentions for allowed connections
apiVersion: consul.hashicorp.com/v1alpha1
kind: ServiceIntentions
metadata:
  name: backend-api
  namespace: production
spec:
  destination:
    name: backend-api
  sources:
    # Allow from frontend
    - name: frontend
      namespace: production
      action: allow
      permissions:
        - http:
            pathPrefix: /api/
            methods:
              - GET
              - POST
              - PUT
              - DELETE

    # Allow from internal services
    - name: order-service
      namespace: production
      action: allow

    - name: user-service
      namespace: production
      action: allow
      permissions:
        - http:
            pathPrefix: /api/users
            methods:
              - GET
              - POST

    # Deny from untrusted namespaces
    - name: "*"
      namespace: untrusted
      action: deny

    # Allow metrics scraping
    - name: prometheus
      namespace: monitoring
      action: allow
      permissions:
        - http:
            pathExact: /metrics
            methods:
              - GET
---
# Database access intentions
apiVersion: consul.hashicorp.com/v1alpha1
kind: ServiceIntentions
metadata:
  name: database
  namespace: production
spec:
  destination:
    name: database
  sources:
    # Only allow from backend services
    - name: backend-api
      namespace: production
      action: allow

    - name: reporting-service
      namespace: production
      action: allow

    # Deny everything else
    - name: "*"
      action: deny
---
# External service intentions
apiVersion: consul.hashicorp.com/v1alpha1
kind: ServiceIntentions
metadata:
  name: external-payment-api
  namespace: production
spec:
  destination:
    name: external-payment-api
  sources:
    # Only allow from payment service
    - name: payment-service
      namespace: production
      action: allow
      permissions:
        - http:
            pathPrefix: /v1/
            methods:
              - POST
            header:
              - name: X-API-Key
                present: true

    # Log and deny others
    - name: "*"
      action: deny
```

## Service Router and Splitter

```yaml
# ServiceRouter for request routing
apiVersion: consul.hashicorp.com/v1alpha1
kind: ServiceRouter
metadata:
  name: backend-api
  namespace: production
spec:
  routes:
    # Route v2 API to canary
    - match:
        http:
          pathPrefix: /api/v2/
      destination:
        service: backend-api
        serviceSubset: canary
        retryOn: "connect-failure,refused-stream,unavailable,cancelled"
        numRetries: 3
        retryOnConnectFailure: true
        retryOnStatusCodes:
          - 500
          - 502
          - 503

    # Route based on headers
    - match:
        http:
          header:
            - name: X-Canary-Test
              exact: "true"
      destination:
        service: backend-api
        serviceSubset: canary

    # Default route to stable
    - destination:
        service: backend-api
        serviceSubset: stable
---
# ServiceSplitter for traffic splitting
apiVersion: consul.hashicorp.com/v1alpha1
kind: ServiceSplitter
metadata:
  name: backend-api
  namespace: production
spec:
  splits:
    - weight: 90
      serviceSubset: stable
    - weight: 10
      serviceSubset: canary
---
# ServiceResolver for subset definition
apiVersion: consul.hashicorp.com/v1alpha1
kind: ServiceResolver
metadata:
  name: backend-api
  namespace: production
spec:
  defaultSubset: stable

  subsets:
    stable:
      filter: "Service.Meta.version == v1.0.0"
      onlyPassing: true

    canary:
      filter: "Service.Meta.version == v2.0.0"
      onlyPassing: true

  # Failover configuration
  failover:
    "*":
      service: backend-api-fallback
      datacenters:
        - dc2
        - dc3

  # Load balancer configuration
  loadBalancer:
    policy: least_request
    leastRequestConfig:
      choiceCount: 2

  # Connection timeout
  connectTimeout: 5s
```

## Proxy Defaults and Configuration

```yaml
# ProxyDefaults for global configuration
apiVersion: consul.hashicorp.com/v1alpha1
kind: ProxyDefaults
metadata:
  name: global
  namespace: consul
spec:
  config:
    protocol: http
    connect_timeout_ms: 5000

    # Envoy configuration
    envoy_prometheus_bind_addr: "0.0.0.0:9102"
    envoy_stats_bind_addr: "0.0.0.0:9103"

    # Tracing configuration
    envoy_tracing_json: |
      {
        "http": {
          "name": "envoy.tracers.zipkin",
          "typedConfig": {
            "@type": "type.googleapis.com/envoy.config.trace.v3.ZipkinConfig",
            "collector_cluster": "jaeger",
            "collector_endpoint": "/api/v2/spans",
            "collector_endpoint_version": "HTTP_JSON"
          }
        }
      }

  # Mesh gateway mode
  meshGateway:
    mode: local

  # Transparent proxy
  transparentProxy:
    outboundListenerPort: 15001
    dialed directly: false

  # Access logs
  accessLogs:
    enabled: true
    disableListenerLogs: false
    type: stdout
    jsonFormat: '{"start_time": "%START_TIME%", "method": "%REQ(:METHOD)%", "path": "%REQ(X-ENVOY-ORIGINAL-PATH?:PATH)%", "protocol": "%PROTOCOL%", "response_code": "%RESPONSE_CODE%", "duration": "%DURATION%"}'
---
# ServiceDefaults for specific service
apiVersion: consul.hashicorp.com/v1alpha1
kind: ServiceDefaults
metadata:
  name: backend-api
  namespace: production
spec:
  protocol: http

  # External service configuration
  externalSNI: backend-api.example.com

  # Mesh gateway
  meshGateway:
    mode: local

  # Transparent proxy
  transparentProxy:
    outboundListenerPort: 15001
    dialedDirectly: false

  # Upstream configuration
  upstreamConfig:
    overrides:
      - name: database
        passiveHealthCheck:
          maxFailures: 3
          interval: 10s

      - name: redis
        protocol: tcp
        connectTimeoutMs: 1000

  # Rate limiting
  rateLimits:
    instanceLevel:
      requestsPerSecond: 1000
      requestsMaxBurst: 2000
---
# IngressGateway configuration
apiVersion: consul.hashicorp.com/v1alpha1
kind: IngressGateway
metadata:
  name: api-gateway
  namespace: consul
spec:
  tls:
    enabled: true
    tlsMinVersion: TLSv1_2
    tlsMaxVersion: TLSv1_3
    cipherSuites:
      - TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256
      - TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384

  listeners:
    - port: 8080
      protocol: http
      services:
        - name: backend-api
          namespace: production
          hosts:
            - api.example.com
          requestHeaders:
            add:
              x-gateway: consul-ingress
            remove:
              - x-internal-header
          responseHeaders:
            add:
              x-response-time: "%RESP(X-ENVOY-UPSTREAM-SERVICE-TIME)%"

    - port: 8443
      protocol: https
      tls:
        enabled: true
        sds:
          clusterName: backend-api
          certResource: backend-api-cert
      services:
        - name: frontend
          namespace: production
          hosts:
            - www.example.com
---
# TerminatingGateway for external services
apiVersion: consul.hashicorp.com/v1alpha1
kind: TerminatingGateway
metadata:
  name: external-services
  namespace: consul
spec:
  services:
    - name: external-payment-api
      caFile: /etc/ssl/certs/payment-api-ca.pem
      certFile: /etc/ssl/certs/client-cert.pem
      keyFile: /etc/ssl/private/client-key.pem
      sni: payment-api.external.com

    - name: external-email-service
      caFile: /etc/ssl/certs/email-ca.pem
```

## Multi-Datacenter Federation

```bash
#!/bin/bash
# Configure Consul federation

# Create federation secret in primary datacenter
kubectl --context=dc1 get secret consul-federation -n consul -o yaml > federation-secret.yaml

# Apply federation secret in secondary datacenter
kubectl --context=dc2 apply -f federation-secret.yaml

# Install Consul in secondary datacenter with federation
helm upgrade --install consul hashicorp/consul \
  --namespace consul \
  --set global.federation.enabled=true \
  --set global.federation.primaryDatacenter=dc1 \
  --set global.datacenter=dc2 \
  --values consul-values-dc2.yaml \
  --wait

# Verify federation
consul catalog datacenters
```

## Observability and Monitoring

```yaml
# ServiceMonitor for Prometheus
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: consul-connect-envoy
  namespace: production
spec:
  selector:
    matchExpressions:
      - key: consul.hashicorp.com/connect-inject-status
        operator: Exists
  endpoints:
    - port: metrics
      interval: 30s
      path: /stats/prometheus
```

## Troubleshooting Commands

```bash
#!/bin/bash
# Consul Connect troubleshooting

# Check service health
check_service() {
    consul catalog services
    consul catalog nodes -service backend-api
}

# Check intentions
check_intentions() {
    consul intention list
    consul intention check frontend backend-api
}

# Debug proxy
debug_proxy() {
    local pod=$1
    kubectl exec -it $pod -c consul-dataplane -- \
        wget -qO- localhost:19000/config_dump
}

# Check service mesh connectivity
test_connectivity() {
    local source=$1
    local dest=$2
    consul intention check $source $dest
}

case "${1:-help}" in
    service) check_service ;;
    intentions) check_intentions ;;
    proxy) debug_proxy "$2" ;;
    test) test_connectivity "$2" "$3" ;;
    *)
        echo "Usage: $0 {service|intentions|proxy|test}"
        exit 1
        ;;
esac
```

## Conclusion

Consul Connect provides a comprehensive service mesh solution that extends beyond Kubernetes to support VMs and multi-cloud environments. With intentions-based access control, flexible routing, and multi-datacenter federation, Consul enables secure service-to-service communication across heterogeneous infrastructure while maintaining HashiCorp's focus on operational simplicity.