---
title: "Cilium eBPF Networking Deep Dive: Advanced Kubernetes CNI Implementation"
date: 2026-05-12T00:00:00-05:00
draft: false
tags: ["Cilium", "eBPF", "Kubernetes", "CNI", "Networking", "Service Mesh", "Linux"]
categories: ["Kubernetes", "Networking", "Cloud Native"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing and optimizing Cilium eBPF-based networking in Kubernetes, including advanced network policies, service mesh features, and performance tuning for enterprise environments."
more_link: "yes"
url: "/cilium-ebpf-networking-deep-dive/"
---

Cilium represents a paradigm shift in Kubernetes networking by leveraging eBPF (extended Berkeley Packet Filter) technology to provide high-performance, secure, and observable networking capabilities. This comprehensive guide explores advanced Cilium implementation patterns, performance optimization techniques, and enterprise-grade configurations for production Kubernetes clusters.

<!--more-->

## Understanding Cilium Architecture

Cilium fundamentally transforms how Kubernetes handles networking by moving packet processing logic from iptables to eBPF programs running directly in the Linux kernel. This architectural change provides dramatic performance improvements while enabling advanced features like identity-based security, transparent encryption, and API-aware network policies.

### Core Components and Their Interactions

The Cilium architecture consists of several interconnected components that work together to provide comprehensive networking capabilities:

```yaml
# Advanced Cilium deployment with full feature set
apiVersion: v1
kind: ConfigMap
metadata:
  name: cilium-config
  namespace: kube-system
data:
  # Identity management and allocation
  identity-allocation-mode: "kvstore"
  kvstore: "etcd"
  kvstore-opt: '{"etcd.config": "/var/lib/etcd-config/etcd.config"}'

  # Enable native routing mode for maximum performance
  tunnel: "disabled"
  enable-ipv4: "true"
  enable-ipv6: "true"
  ipam: "kubernetes"
  auto-direct-node-routes: "true"
  enable-endpoint-routes: "true"

  # Enable advanced networking features
  enable-host-reachable-services: "true"
  enable-external-ips: "true"
  enable-node-port: "true"
  enable-host-port: "true"

  # Service mesh capabilities
  enable-envoy-config: "true"
  enable-l7-proxy: "true"

  # Security and encryption
  enable-encryption: "true"
  encryption-type: "wireguard"
  enable-wireguard: "true"

  # Observability
  enable-hubble: "true"
  hubble-listen-address: ":4244"
  hubble-metrics-server: ":9091"
  hubble-metrics: "dns:query;ignoreAAAA,drop,tcp,flow,icmp,http"

  # Performance optimization
  enable-bpf-masquerade: "true"
  enable-xt-socket-fallback: "true"
  install-iptables-rules: "true"
  enable-bandwidth-manager: "true"
  enable-bbr: "true"

  # Policy enforcement
  enable-policy: "default"
  policy-enforcement-mode: "default"
  enable-remote-node-identity: "true"

  # Advanced features
  enable-ipv4-fragment-tracking: "true"
  enable-session-affinity: "true"
  enable-endpoint-health-checking: "true"
  endpoint-gc-interval: "5m"

  # Datapath mode
  datapath-mode: "veth"
  ipvlan-master-device: "eth0"

  # BGP configuration
  enable-bgp-control-plane: "true"

  # Resource limits
  bpf-map-dynamic-size-ratio: "0.25"
  bpf-ct-global-tcp-max: "524288"
  bpf-ct-global-any-max: "262144"
  bpf-nat-global-max: "524288"
  bpf-neigh-global-max: "524288"
  bpf-policy-map-max: "16384"
```

### Advanced Installation with High Availability

For production environments, deploy Cilium with full high availability and redundancy:

```bash
#!/bin/bash
# Advanced Cilium installation script for production environments

set -euo pipefail

CILIUM_VERSION="1.15.0"
CLUSTER_NAME="production-k8s"
CLUSTER_ID="1"

# Install Cilium CLI
CILIUM_CLI_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt)
CLI_ARCH=amd64
if [ "$(uname -m)" = "aarch64" ]; then CLI_ARCH=arm64; fi
curl -L --fail --remote-name-all https://github.com/cilium/cilium-cli/releases/download/${CILIUM_CLI_VERSION}/cilium-linux-${CLI_ARCH}.tar.gz{,.sha256sum}
sha256sum --check cilium-linux-${CLI_ARCH}.tar.gz.sha256sum
sudo tar xzvfC cilium-linux-${CLI_ARCH}.tar.gz /usr/local/bin
rm cilium-linux-${CLI_ARCH}.tar.gz{,.sha256sum}

# Install Hubble CLI
HUBBLE_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/hubble/master/stable.txt)
HUBBLE_ARCH=amd64
if [ "$(uname -m)" = "aarch64" ]; then HUBBLE_ARCH=arm64; fi
curl -L --fail --remote-name-all https://github.com/cilium/hubble/releases/download/$HUBBLE_VERSION/hubble-linux-${HUBBLE_ARCH}.tar.gz{,.sha256sum}
sha256sum --check hubble-linux-${HUBBLE_ARCH}.tar.gz.sha256sum
sudo tar xzvfC hubble-linux-${HUBBLE_ARCH}.tar.gz /usr/local/bin
rm hubble-linux-${HUBBLE_ARCH}.tar.gz{,.sha256sum}

# Create Cilium configuration values
cat > cilium-values.yaml <<EOF
cluster:
  name: ${CLUSTER_NAME}
  id: ${CLUSTER_ID}

# High availability configuration
operator:
  replicas: 3
  rollOutPods: true
  resources:
    limits:
      cpu: 1000m
      memory: 1Gi
    requests:
      cpu: 100m
      memory: 128Mi
  podDisruptionBudget:
    enabled: true
    minAvailable: 2

# Agent configuration
agent:
  rollOutPods: true
  resources:
    limits:
      cpu: 2000m
      memory: 2Gi
    requests:
      cpu: 200m
      memory: 256Mi

# Networking configuration
ipam:
  mode: kubernetes
  operator:
    clusterPoolIPv4PodCIDRList: ["10.244.0.0/16"]
    clusterPoolIPv4MaskSize: 24

tunnel: disabled
autoDirectNodeRoutes: true
endpointRoutes:
  enabled: true
ipv4NativeRoutingCIDR: "10.244.0.0/16"

# Enable advanced features
kubeProxyReplacement: strict
k8sServiceHost: api.production.example.com
k8sServicePort: 6443

# Security
encryption:
  enabled: true
  type: wireguard
  nodeEncryption: true

# Hubble observability
hubble:
  enabled: true
  listenAddress: ":4244"
  relay:
    enabled: true
    replicas: 3
    resources:
      limits:
        cpu: 1000m
        memory: 1Gi
      requests:
        cpu: 100m
        memory: 128Mi
  ui:
    enabled: true
    replicas: 2
    ingress:
      enabled: true
      hosts:
        - hubble.production.example.com
      tls:
        - secretName: hubble-tls
          hosts:
            - hubble.production.example.com
  metrics:
    enabled:
      - dns:query;ignoreAAAA
      - drop
      - tcp
      - flow
      - icmp
      - http
    serviceMonitor:
      enabled: true
    dashboards:
      enabled: true

# Prometheus integration
prometheus:
  enabled: true
  serviceMonitor:
    enabled: true
    labels:
      prometheus: kube-prometheus

# Performance optimization
bpf:
  masquerade: true
  hostRouting: true
  tproxy: true

bandwidthManager:
  enabled: true
  bbr: true

# BGP control plane
bgpControlPlane:
  enabled: true

# Policy enforcement
policyEnforcementMode: default
policyAuditMode: false

# Resource optimization
bpfMapDynamicSizeRatio: 0.25
bpfCtGlobalTcpMax: 524288
bpfCtGlobalAnyMax: 262144
bpfNatGlobalMax: 524288
bpfNeighGlobalMax: 524288
bpfPolicyMapMax: 16384

# Envoy configuration for L7 features
envoy:
  enabled: true
  resources:
    limits:
      cpu: 2000m
      memory: 2Gi
    requests:
      cpu: 200m
      memory: 256Mi

# Health checking
healthChecking: true
healthPort: 9879

# Enable session affinity
sessionAffinity: true

# Node initialization
nodeinit:
  enabled: true
  resources:
    requests:
      cpu: 100m
      memory: 100Mi

# Preflight validation
preflight:
  enabled: true
  resources:
    requests:
      cpu: 100m
      memory: 100Mi
EOF

# Install Cilium with Helm
helm repo add cilium https://helm.cilium.io/
helm repo update

helm upgrade --install cilium cilium/cilium \
  --version ${CILIUM_VERSION} \
  --namespace kube-system \
  --values cilium-values.yaml \
  --wait

# Wait for Cilium to be ready
echo "Waiting for Cilium to be ready..."
cilium status --wait

# Enable Hubble
echo "Enabling Hubble observability..."
cilium hubble enable --ui

# Verify installation
echo "Verifying Cilium installation..."
cilium connectivity test

echo "Cilium installation completed successfully!"
```

## Advanced Network Policy Configuration

Cilium's network policies extend beyond basic Kubernetes NetworkPolicy capabilities by supporting L7-aware policies, DNS-based rules, and identity-based security.

### Identity-Based Security Policies

```yaml
# Layer 7 HTTP policy with identity-based rules
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: frontend-policy
  namespace: production
spec:
  description: "Secure frontend to backend communication with L7 policies"
  endpointSelector:
    matchLabels:
      app: frontend
      tier: web

  # Egress rules for outbound traffic
  egress:
    # Allow DNS queries
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
            k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
          rules:
            dns:
              - matchPattern: "*"

    # Allow specific HTTP APIs to backend service
    - toEndpoints:
        - matchLabels:
            app: backend
            tier: api
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              - method: "GET"
                path: "/api/v1/users"
              - method: "POST"
                path: "/api/v1/users"
              - method: "GET"
                path: "/api/v1/products"
                headers:
                  - "X-Api-Key: .*"

    # Allow HTTPS to external services
    - toFQDNs:
        - matchName: "api.stripe.com"
        - matchName: "api.sendgrid.com"
        - matchPattern: "*.aws.amazon.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP

    # Allow connection to PostgreSQL
    - toEndpoints:
        - matchLabels:
            app: postgresql
            tier: database
      toPorts:
        - ports:
            - port: "5432"
              protocol: TCP

    # Allow connection to Redis
    - toEndpoints:
        - matchLabels:
            app: redis
            tier: cache
      toPorts:
        - ports:
            - port: "6379"
              protocol: TCP

  # Ingress rules for inbound traffic
  ingress:
    # Allow traffic from ingress controller
    - fromEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: ingress-nginx
            app.kubernetes.io/name: ingress-nginx
      toPorts:
        - ports:
            - port: "3000"
              protocol: TCP

    # Allow health checks from load balancer
    - fromCIDR:
        - "10.0.0.0/8"
      toPorts:
        - ports:
            - port: "3000"
              protocol: TCP
          rules:
            http:
              - method: "GET"
                path: "/health"
---
# Backend API policy with rate limiting
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: backend-api-policy
  namespace: production
spec:
  description: "Backend API security with rate limiting"
  endpointSelector:
    matchLabels:
      app: backend
      tier: api

  egress:
    # Allow DNS
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
            k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
          rules:
            dns:
              - matchPattern: "*"

    # Database access with connection limits
    - toEndpoints:
        - matchLabels:
            app: postgresql
            tier: database
      toPorts:
        - ports:
            - port: "5432"
              protocol: TCP

    # External API calls
    - toFQDNs:
        - matchPattern: "*.googleapis.com"
        - matchName: "api.github.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP

  ingress:
    # Allow from frontend with L7 inspection
    - fromEndpoints:
        - matchLabels:
            app: frontend
            tier: web
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              - method: "GET"
                path: "/api/v1/.*"
              - method: "POST"
                path: "/api/v1/.*"
              - method: "PUT"
                path: "/api/v1/.*"
              - method: "DELETE"
                path: "/api/v1/.*"

    # Allow from internal services
    - fromEndpoints:
        - matchLabels:
            tier: internal
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
---
# Database policy with strict access control
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: postgresql-policy
  namespace: production
spec:
  description: "PostgreSQL strict access control"
  endpointSelector:
    matchLabels:
      app: postgresql
      tier: database

  ingress:
    # Only allow from backend services
    - fromEndpoints:
        - matchLabels:
            app: backend
            tier: api
        - matchLabels:
            app: reporting
            tier: analytics
      toPorts:
        - ports:
            - port: "5432"
              protocol: TCP

    # Allow from backup services
    - fromEndpoints:
        - matchLabels:
            app: backup
            tier: management
      toPorts:
        - ports:
            - port: "5432"
              protocol: TCP

  egress:
    # Allow DNS only
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
            k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
---
# Cluster-wide default deny policy
apiVersion: cilium.io/v2
kind: CiliumClusterwideNetworkPolicy
metadata:
  name: default-deny-all
spec:
  description: "Default deny all traffic cluster-wide"
  endpointSelector: {}

  ingress:
    - fromEntities:
        - health
        - kube-apiserver

  egress:
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
            k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
          rules:
            dns:
              - matchPattern: "*"
```

### DNS-Based Security Policies

```yaml
# Advanced DNS-based policy with caching and TTL
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: external-api-access
  namespace: production
spec:
  description: "Control external API access with DNS policies"
  endpointSelector:
    matchLabels:
      role: api-client

  egress:
    # Allow DNS queries
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
            k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
          rules:
            dns:
              - matchPattern: "*"

    # Allow specific cloud provider services
    - toFQDNs:
        - matchPattern: "*.s3.amazonaws.com"
        - matchPattern: "*.dynamodb.*.amazonaws.com"
        - matchPattern: "sqs.*.amazonaws.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP

    # Allow specific SaaS providers
    - toFQDNs:
        - matchName: "api.stripe.com"
        - matchName: "api.twilio.com"
        - matchName: "api.sendgrid.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP

    # Allow container registries
    - toFQDNs:
        - matchPattern: "*.docker.io"
        - matchPattern: "*.gcr.io"
        - matchPattern: "*.azurecr.io"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP
---
# DNS policy with selective logging
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: dns-monitoring-policy
  namespace: security
spec:
  description: "Monitor and log DNS queries"
  endpointSelector: {}

  egress:
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
            k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
          rules:
            dns:
              - matchPattern: "*"
                # Log all DNS queries
                audit: true
```

## Performance Optimization and Tuning

### Kernel Parameter Optimization

```bash
#!/bin/bash
# Optimize kernel parameters for Cilium eBPF

cat > /etc/sysctl.d/99-cilium.conf <<EOF
# Increase netfilter connection tracking
net.netfilter.nf_conntrack_max = 1000000
net.netfilter.nf_conntrack_tcp_timeout_established = 86400
net.netfilter.nf_conntrack_tcp_timeout_close_wait = 3600

# Optimize network buffers
net.core.rmem_max = 134217728
net.core.wmem_max = 134217728
net.core.rmem_default = 16777216
net.core.wmem_default = 16777216
net.ipv4.tcp_rmem = 4096 87380 67108864
net.ipv4.tcp_wmem = 4096 65536 67108864
net.core.netdev_max_backlog = 300000
net.core.netdev_budget = 600
net.core.netdev_budget_usecs = 8000

# Enable TCP optimizations
net.ipv4.tcp_congestion_control = bbr
net.ipv4.tcp_notsent_lowat = 16384
net.ipv4.tcp_slow_start_after_idle = 0
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_max_syn_backlog = 8192

# Increase local port range
net.ipv4.ip_local_port_range = 10000 65535

# Optimize routing
net.ipv4.conf.all.rp_filter = 0
net.ipv4.conf.default.rp_filter = 0
net.ipv4.conf.all.forwarding = 1
net.ipv6.conf.all.forwarding = 1

# Increase max file descriptors
fs.file-max = 2097152
fs.inotify.max_user_instances = 8192
fs.inotify.max_user_watches = 524288

# Kernel memory optimization
vm.swappiness = 10
vm.dirty_ratio = 40
vm.dirty_background_ratio = 10

# eBPF specific optimizations
kernel.unprivileged_bpf_disabled = 1
kernel.bpf_stats_enabled = 1
EOF

# Apply settings
sysctl -p /etc/sysctl.d/99-cilium.conf

# Verify eBPF JIT compiler is enabled
if [ "$(sysctl -n net.core.bpf_jit_enable)" != "1" ]; then
    echo "Enabling eBPF JIT compiler..."
    sysctl -w net.core.bpf_jit_enable=1
    echo "net.core.bpf_jit_enable = 1" >> /etc/sysctl.d/99-cilium.conf
fi

# Enable BPF JIT harden for security
sysctl -w net.core.bpf_jit_harden=1
echo "net.core.bpf_jit_harden = 1" >> /etc/sysctl.d/99-cilium.conf
```

### Monitoring and Observability with Hubble

```yaml
# Advanced Hubble configuration for comprehensive observability
apiVersion: v1
kind: ConfigMap
metadata:
  name: hubble-config
  namespace: kube-system
data:
  config.yaml: |
    # Metrics configuration
    metrics:
      - name: dns
        config:
          query: true
          ignoreAAAA: true
      - name: drop
        config:
          reasons: true
      - name: tcp
        config:
          flags: true
      - name: flow
        config:
          sourceContext: namespace|workload-name
          destinationContext: namespace|workload-name
      - name: http
        config:
          exemplars: true
          labelsContext: source_namespace,source_workload,destination_namespace,destination_workload
      - name: icmp
      - name: port-distribution
        config:
          context: namespace

    # Flow export configuration
    export:
      - name: prometheus
        enabled: true
        port: 9091
      - name: json
        enabled: true
        filePath: /var/run/cilium/hubble/events.log
        fieldMask:
          - time
          - source
          - destination
          - verdict
          - drop_reason
          - traffic_direction
          - l7

    # UI configuration
    ui:
      backend:
        port: 8081
      frontend:
        port: 12000

    # Rate limiting
    rateLimiting:
      enabled: true
      rate: 1000
      burst: 2000
---
# Hubble Relay deployment for multi-cluster observability
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hubble-relay
  namespace: kube-system
spec:
  replicas: 3
  selector:
    matchLabels:
      app: hubble-relay
  template:
    metadata:
      labels:
        app: hubble-relay
    spec:
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    app: hubble-relay
                topologyKey: kubernetes.io/hostname
      containers:
        - name: hubble-relay
          image: quay.io/cilium/hubble-relay:v1.15.0
          args:
            - serve
            - --listen-address=:4245
            - --peer-service=unix:///var/run/cilium/hubble.sock
            - --retry-timeout=30s
            - --dial-timeout=10s
            - --tls-hubble-server-ca-files=/var/lib/cilium/tls/hubble/server-ca.crt
            - --tls-client-cert-file=/var/lib/cilium/tls/hubble-relay/client.crt
            - --tls-client-key-file=/var/lib/cilium/tls/hubble-relay/client.key
            - --disable-server-tls=false
            - --enable-metrics
            - --metrics-listen-address=:9092
          ports:
            - name: grpc
              containerPort: 4245
            - name: metrics
              containerPort: 9092
          livenessProbe:
            tcpSocket:
              port: grpc
            initialDelaySeconds: 30
            periodSeconds: 10
          readinessProbe:
            tcpSocket:
              port: grpc
            initialDelaySeconds: 5
            periodSeconds: 5
          resources:
            limits:
              cpu: 1000m
              memory: 1Gi
            requests:
              cpu: 100m
              memory: 128Mi
          volumeMounts:
            - name: hubble-sock
              mountPath: /var/run/cilium
              readOnly: true
            - name: tls
              mountPath: /var/lib/cilium/tls
              readOnly: true
      volumes:
        - name: hubble-sock
          hostPath:
            path: /var/run/cilium
            type: Directory
        - name: tls
          projected:
            sources:
              - secret:
                  name: hubble-relay-client-certs
              - configMap:
                  name: hubble-ca-cert
---
# ServiceMonitor for Prometheus integration
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: hubble-metrics
  namespace: kube-system
  labels:
    app: hubble
spec:
  selector:
    matchLabels:
      app: hubble
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
      relabelings:
        - sourceLabels: [__meta_kubernetes_pod_node_name]
          targetLabel: node
        - sourceLabels: [__meta_kubernetes_namespace]
          targetLabel: namespace
```

### Advanced Troubleshooting Commands

```bash
#!/bin/bash
# Comprehensive Cilium troubleshooting toolkit

# Function to check Cilium agent status
check_cilium_status() {
    echo "=== Checking Cilium Agent Status ==="
    kubectl -n kube-system exec -it ds/cilium -- cilium status --all-addresses
    echo ""
}

# Function to check BPF maps
check_bpf_maps() {
    echo "=== Checking BPF Maps ==="
    kubectl -n kube-system exec -it ds/cilium -- cilium bpf ct list global
    kubectl -n kube-system exec -it ds/cilium -- cilium bpf nat list
    kubectl -n kube-system exec -it ds/cilium -- cilium bpf policy get --all
    echo ""
}

# Function to check endpoint connectivity
check_endpoint_connectivity() {
    local endpoint_id=$1
    echo "=== Checking Endpoint ${endpoint_id} Connectivity ==="
    kubectl -n kube-system exec -it ds/cilium -- cilium endpoint get ${endpoint_id}
    kubectl -n kube-system exec -it ds/cilium -- cilium endpoint health ${endpoint_id}
    kubectl -n kube-system exec -it ds/cilium -- cilium endpoint log ${endpoint_id}
    echo ""
}

# Function to monitor network flows with Hubble
monitor_flows() {
    local namespace=$1
    local pod=$2
    echo "=== Monitoring Flows for ${namespace}/${pod} ==="
    hubble observe --namespace ${namespace} --pod ${pod} --follow --protocol tcp,udp,icmp
}

# Function to check network policy
check_network_policy() {
    local namespace=$1
    local pod=$2
    echo "=== Checking Network Policy for ${namespace}/${pod} ==="
    kubectl -n kube-system exec -it ds/cilium -- cilium endpoint list | grep -A 5 "${pod}"
    kubectl get ciliumnetworkpolicy,networkpolicy -n ${namespace}
    echo ""
}

# Function to verify encryption status
check_encryption() {
    echo "=== Checking Encryption Status ==="
    kubectl -n kube-system exec -it ds/cilium -- cilium encrypt status
    kubectl -n kube-system exec -it ds/cilium -- cilium encrypt flush
    echo ""
}

# Function to collect diagnostic information
collect_diagnostics() {
    local output_dir="cilium-diagnostics-$(date +%Y%m%d-%H%M%S)"
    mkdir -p ${output_dir}

    echo "Collecting Cilium diagnostics to ${output_dir}..."

    # Collect Cilium agent logs
    kubectl -n kube-system logs -l k8s-app=cilium --tail=10000 > ${output_dir}/cilium-agent-logs.txt

    # Collect Cilium operator logs
    kubectl -n kube-system logs -l name=cilium-operator --tail=10000 > ${output_dir}/cilium-operator-logs.txt

    # Collect Hubble relay logs
    kubectl -n kube-system logs -l app=hubble-relay --tail=10000 > ${output_dir}/hubble-relay-logs.txt

    # Collect Cilium status
    kubectl -n kube-system exec ds/cilium -- cilium status --all-addresses > ${output_dir}/cilium-status.txt

    # Collect BPF information
    kubectl -n kube-system exec ds/cilium -- cilium bpf metrics list > ${output_dir}/bpf-metrics.txt

    # Collect endpoint information
    kubectl -n kube-system exec ds/cilium -- cilium endpoint list -o json > ${output_dir}/endpoints.json

    # Collect network policies
    kubectl get ciliumnetworkpolicy,networkpolicy --all-namespaces -o yaml > ${output_dir}/network-policies.yaml

    # Collect node information
    kubectl get nodes -o yaml > ${output_dir}/nodes.yaml

    # Run connectivity test
    cilium connectivity test --test-concurrency=1 > ${output_dir}/connectivity-test.txt 2>&1

    echo "Diagnostics collected in ${output_dir}/"
    tar czf ${output_dir}.tar.gz ${output_dir}
    echo "Archive created: ${output_dir}.tar.gz"
}

# Main menu
case "${1:-status}" in
    status)
        check_cilium_status
        ;;
    bpf)
        check_bpf_maps
        ;;
    endpoint)
        check_endpoint_connectivity "$2"
        ;;
    flows)
        monitor_flows "$2" "$3"
        ;;
    policy)
        check_network_policy "$2" "$3"
        ;;
    encryption)
        check_encryption
        ;;
    diagnostics)
        collect_diagnostics
        ;;
    *)
        echo "Usage: $0 {status|bpf|endpoint|flows|policy|encryption|diagnostics}"
        echo ""
        echo "Commands:"
        echo "  status              - Check Cilium agent status"
        echo "  bpf                 - Check BPF maps"
        echo "  endpoint <id>       - Check endpoint connectivity"
        echo "  flows <ns> <pod>    - Monitor network flows"
        echo "  policy <ns> <pod>   - Check network policy"
        echo "  encryption          - Check encryption status"
        echo "  diagnostics         - Collect full diagnostics"
        exit 1
        ;;
esac
```

## BGP Integration for Advanced Routing

```yaml
# Cilium BGP peering configuration
apiVersion: cilium.io/v2alpha1
kind: CiliumBGPPeeringPolicy
metadata:
  name: datacenter-bgp-peering
spec:
  nodeSelector:
    matchLabels:
      bgp-peering: enabled

  virtualRouters:
    - localASN: 64512
      exportPodCIDR: true
      neighbors:
        # Peer with ToR switches
        - peerAddress: 192.168.1.1/32
          peerASN: 65001
          connectRetryTimeSeconds: 120
          holdTimeSeconds: 90
          keepAliveTimeSeconds: 30
          gracefulRestart:
            enabled: true
            restartTimeSeconds: 120

        - peerAddress: 192.168.1.2/32
          peerASN: 65001
          connectRetryTimeSeconds: 120
          holdTimeSeconds: 90
          keepAliveTimeSeconds: 30
          gracefulRestart:
            enabled: true
            restartTimeSeconds: 120

      # Service advertisement
      serviceAdvertisements:
        - LoadBalancerIP

      # Pod CIDR advertisement
      podIPPoolSelector:
        matchLabels:
          advertise: bgp
---
# IP pool configuration for BGP advertisement
apiVersion: cilium.io/v2alpha1
kind: CiliumLoadBalancerIPPool
metadata:
  name: production-pool
spec:
  cidrs:
    - cidr: 10.100.0.0/16
  serviceSelector:
    matchLabels:
      bgp-advertise: "true"
```

## Production Best Practices

### Resource Limits and Quality of Service

```yaml
# Production-grade Cilium agent configuration
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: cilium
  namespace: kube-system
spec:
  selector:
    matchLabels:
      k8s-app: cilium
  template:
    metadata:
      labels:
        k8s-app: cilium
    spec:
      priorityClassName: system-node-critical
      hostNetwork: true
      containers:
        - name: cilium-agent
          image: quay.io/cilium/cilium:v1.15.0
          command:
            - cilium-agent
          args:
            - --config-dir=/tmp/cilium/config-map
            - --enable-ipv4=true
            - --enable-ipv6=true
          env:
            - name: K8S_NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
            - name: CILIUM_K8S_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
            - name: CILIUM_CLUSTERMESH_CONFIG
              value: /var/lib/cilium/clustermesh/
            - name: GOMEMLIMIT
              valueFrom:
                resourceFieldRef:
                  resource: limits.memory
                  divisor: "1"
          resources:
            limits:
              cpu: 4000m
              memory: 4Gi
            requests:
              cpu: 500m
              memory: 512Mi
          securityContext:
            privileged: true
            capabilities:
              add:
                - NET_ADMIN
                - SYS_MODULE
                - SYS_ADMIN
                - SYS_RESOURCE
          volumeMounts:
            - name: bpf-maps
              mountPath: /sys/fs/bpf
              mountPropagation: HostToContainer
            - name: cilium-run
              mountPath: /var/run/cilium
            - name: cilium-cgroup
              mountPath: /run/cilium/cgroupv2
              mountPropagation: HostToContainer
            - name: lib-modules
              mountPath: /lib/modules
              readOnly: true
            - name: xtables-lock
              mountPath: /run/xtables.lock
      volumes:
        - name: bpf-maps
          hostPath:
            path: /sys/fs/bpf
            type: DirectoryOrCreate
        - name: cilium-run
          hostPath:
            path: /var/run/cilium
            type: DirectoryOrCreate
        - name: cilium-cgroup
          hostPath:
            path: /run/cilium/cgroupv2
            type: DirectoryOrCreate
        - name: lib-modules
          hostPath:
            path: /lib/modules
        - name: xtables-lock
          hostPath:
            path: /run/xtables.lock
            type: FileOrCreate
```

## Conclusion

Cilium's eBPF-based networking provides unparalleled performance, security, and observability for Kubernetes environments. By leveraging kernel-level packet processing, identity-based security, and advanced L7 policies, Cilium enables enterprise organizations to build highly secure and performant cloud-native infrastructure.

The key to successful Cilium deployment lies in proper configuration of eBPF parameters, comprehensive network policies, integration with observability tools like Hubble, and continuous monitoring of performance metrics. With native routing, WireGuard encryption, and BGP integration, Cilium provides a complete networking solution that scales from small clusters to large multi-tenant environments.