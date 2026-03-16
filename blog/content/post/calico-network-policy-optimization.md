---
title: "Calico Network Policy Optimization: Advanced Security and Performance Tuning"
date: 2026-05-07T00:00:00-05:00
draft: false
tags: ["Calico", "Kubernetes", "Network Policy", "Security", "CNI", "eBPF", "Performance"]
categories: ["Kubernetes", "Networking", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to optimizing Calico network policies for Kubernetes, including advanced security patterns, eBPF dataplane, policy tiering, and performance tuning for enterprise production environments."
more_link: "yes"
url: "/calico-network-policy-optimization/"
---

Calico has become the de facto standard for Kubernetes network policy enforcement, offering powerful security controls combined with high-performance networking. This comprehensive guide explores advanced Calico optimization techniques, including policy tiering, eBPF dataplane configuration, and enterprise-grade security patterns for production environments.

<!--more-->

## Calico Architecture and Dataplane Options

Calico provides multiple dataplane options, each with distinct performance characteristics and capabilities. Understanding these options is crucial for optimizing your Kubernetes networking stack.

### eBPF Dataplane Configuration

The eBPF dataplane offers significant performance improvements over traditional iptables-based enforcement:

```yaml
# Advanced Calico installation with eBPF dataplane
apiVersion: operator.tigera.io/v1
kind: Installation
metadata:
  name: default
spec:
  # Variant controls which dataplane to use
  variant: Calico

  # CNI configuration
  cni:
    type: Calico
    ipam:
      type: Calico

  # Enable eBPF dataplane for maximum performance
  calicoNetwork:
    bgp: Enabled
    hostPorts: Enabled
    multiInterfaceMode: None

    # IP pools configuration
    ipPools:
      - name: default-ipv4-ippool
        blockSize: 26
        cidr: 10.244.0.0/16
        encapsulation: VXLAN
        natOutgoing: Enabled
        nodeSelector: all()

      - name: high-performance-pool
        blockSize: 26
        cidr: 10.245.0.0/16
        encapsulation: None
        natOutgoing: Enabled
        nodeSelector: has(node.performance-tier) && node.performance-tier == 'high'

    # Node address detection
    nodeAddressAutodetectionV4:
      firstFound: true
      interface: eth0

  # eBPF specific configuration
  linuxDataplane: BPF
  bpfDataplaneLogLevel: Info
  bpfKubeProxyIptablesCleanupEnabled: true
  bpfExternalServiceMode: Tunnel
  bpfLogLevel: Info
  bpfCTLBLogFilter: all()

  # Felix configuration for eBPF
  felixConfiguration:
    # eBPF mode settings
    bpfEnabled: true
    bpfDisableUnprivileged: true
    bpfLogLevel: Info
    bpfDataIfacePattern: ^(eth|ens|eno|enp).*
    bpfConnectTimeLoadBalancingEnabled: true
    bpfHostNetworkedNATWithoutCTLB: Enabled
    bpfExternalServiceMode: Tunnel
    bpfKubeProxyIptablesCleanupEnabled: true
    bpfKubeProxyMinSyncPeriod: 1s
    bpfKubeProxyEndpointSlicesEnabled: true

    # Performance tuning
    chainInsertMode: Insert
    defaultEndpointToHostAction: Accept
    deviceRouteSourceAddress: UseDeviceIP

    # Logging and monitoring
    flowLogsFileEnabled: true
    flowLogsFlushInterval: 300s
    flowLogsFileIncludeLabels: true
    flowLogsFileIncludePolicies: true
    dnsLogsFileEnabled: true

    # Connection tracking
    iptablesMarkMask: "0xffff0000"
    iptablesPostWriteCheckIntervalSecs: 1
    iptablesRefreshInterval: 60s

    # Resource optimization
    iptablesFilterAllowAction: Accept
    iptabksLockFilePath: /run/xtables.lock
    iptablesLockProbeIntervalMillis: 50
    iptablesLockTimeoutSecs: 0

    # Policy sync
    policySyncPathPrefix: /var/run/nodeagent
    routeRefreshInterval: 60s

    # Performance settings
    usageReportingEnabled: false
    wireguardEnabled: true
    wireguardListeningPort: 51820
    wireguardMTU: 1420
---
# Felix configuration for advanced tuning
apiVersion: projectcalico.org/v3
kind: FelixConfiguration
metadata:
  name: default
spec:
  # BPF settings
  bpfEnabled: true
  bpfLogLevel: Info
  bpfDataIfacePattern: ^(eth|ens|eno|enp).*
  bpfConnectTimeLoadBalancingEnabled: true
  bpfExternalServiceMode: Tunnel

  # Policy enforcement
  defaultEndpointToHostAction: Return
  policySyncPathPrefix: /var/run/nodeagent

  # Performance optimization
  chainInsertMode: Insert
  iptablesMarkMask: "0xffff0000"
  iptablesRefreshInterval: 60s
  routeRefreshInterval: 60s

  # Connection tracking tuning
  natPortRange: 32768:60999
  natOutgoingAddress: ""

  # Logging configuration
  logSeverityScreen: Info
  logFilePath: /var/log/calico/felix.log
  flowLogsFileEnabled: true
  flowLogsFlushInterval: 300s
  flowLogsFileIncludeLabels: true
  flowLogsFileIncludePolicies: true
  dnsLogsFileEnabled: true
  dnsLogsFlushInterval: 300s

  # Health and monitoring
  healthEnabled: true
  healthPort: 9099
  prometheusMetricsEnabled: true
  prometheusMetricsPort: 9091

  # WireGuard encryption
  wireguardEnabled: true
  wireguardListeningPort: 51820
  wireguardRoutingRulePriority: 99
  wireguardInterfaceName: wg-v4.calico
  wireguardMTU: 1420

  # Fail-safe ports (always allow)
  failsafeInboundHostPorts:
    - protocol: tcp
      port: 22
    - protocol: tcp
      port: 6443
    - protocol: udp
      port: 51820

  failsafeOutboundHostPorts:
    - protocol: tcp
      port: 2379
    - protocol: tcp
      port: 2380
    - protocol: tcp
      port: 6443
    - protocol: udp
      port: 53
```

### Installation Script with Performance Optimization

```bash
#!/bin/bash
# Production-grade Calico installation with optimization

set -euo pipefail

CALICO_VERSION="v3.27.0"
OPERATOR_VERSION="v1.32.0"

echo "Installing Calico Operator..."
kubectl create -f https://raw.githubusercontent.com/projectcalico/calico/${CALICO_VERSION}/manifests/tigera-operator.yaml

echo "Waiting for operator to be ready..."
kubectl wait --for=condition=available --timeout=300s deployment/tigera-operator -n tigera-operator

# Create custom resources for optimized installation
cat <<EOF | kubectl apply -f -
apiVersion: operator.tigera.io/v1
kind: Installation
metadata:
  name: default
spec:
  variant: Calico
  registry: quay.io/
  imagePullSecrets:
    - name: tigera-pull-secret

  # CNI configuration
  cni:
    type: Calico
    ipam:
      type: Calico

  # eBPF dataplane
  linuxDataplane: BPF

  # Network configuration
  calicoNetwork:
    bgp: Enabled
    hostPorts: Enabled
    ipPools:
      - name: default-ipv4-ippool
        blockSize: 26
        cidr: 10.244.0.0/16
        encapsulation: VXLAN
        natOutgoing: Enabled
        nodeSelector: all()
    nodeAddressAutodetectionV4:
      interface: eth0

  # Component resources
  controlPlaneReplicas: 3

  calicoNodeDaemonSet:
    spec:
      template:
        spec:
          containers:
            - name: calico-node
              resources:
                limits:
                  cpu: 2000m
                  memory: 2Gi
                requests:
                  cpu: 200m
                  memory: 256Mi

  typhaDeployment:
    spec:
      template:
        spec:
          containers:
            - name: calico-typha
              resources:
                limits:
                  cpu: 1000m
                  memory: 1Gi
                requests:
                  cpu: 100m
                  memory: 128Mi

  calicoKubeControllersDeployment:
    spec:
      template:
        spec:
          containers:
            - name: calico-kube-controllers
              resources:
                limits:
                  cpu: 500m
                  memory: 512Mi
                requests:
                  cpu: 50m
                  memory: 64Mi
EOF

# Wait for Calico to be ready
echo "Waiting for Calico to be ready..."
kubectl wait --for=condition=available --timeout=600s deployment/calico-kube-controllers -n calico-system
kubectl wait --for=condition=ready --timeout=600s pod -l k8s-app=calico-node -n calico-system

# Apply Felix configuration
cat <<EOF | kubectl apply -f -
apiVersion: projectcalico.org/v3
kind: FelixConfiguration
metadata:
  name: default
spec:
  bpfEnabled: true
  bpfLogLevel: Info
  bpfConnectTimeLoadBalancingEnabled: true
  wireguardEnabled: true
  prometheusMetricsEnabled: true
  flowLogsFileEnabled: true
  dnsLogsFileEnabled: true
EOF

# Optimize kernel parameters on all nodes
cat > /tmp/calico-node-optimization.sh <<'SCRIPT'
#!/bin/bash
# Kernel optimization for Calico

cat > /etc/sysctl.d/90-calico.conf <<EOF
# Conntrack settings
net.netfilter.nf_conntrack_max = 1000000
net.netfilter.nf_conntrack_tcp_timeout_established = 86400
net.netfilter.nf_conntrack_tcp_timeout_close_wait = 3600

# Network buffers
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216

# BPF settings
net.core.bpf_jit_enable = 1
net.core.bpf_jit_harden = 2
net.core.bpf_jit_kallsyms = 1

# Routing
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1

# Performance
net.ipv4.tcp_congestion_control = bbr
net.core.netdev_max_backlog = 5000
net.ipv4.tcp_max_syn_backlog = 8096
EOF

sysctl -p /etc/sysctl.d/90-calico.conf
SCRIPT

# Deploy optimization script as DaemonSet
kubectl apply -f - <<EOF
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: calico-node-optimizer
  namespace: kube-system
spec:
  selector:
    matchLabels:
      name: calico-node-optimizer
  template:
    metadata:
      labels:
        name: calico-node-optimizer
    spec:
      hostNetwork: true
      hostPID: true
      initContainers:
        - name: optimizer
          image: alpine:latest
          command:
            - sh
            - -c
            - |
              cat > /host/tmp/optimize.sh <<'SCRIPT'
              $(cat /tmp/calico-node-optimization.sh)
              SCRIPT
              chmod +x /host/tmp/optimize.sh
              chroot /host /tmp/optimize.sh
          securityContext:
            privileged: true
          volumeMounts:
            - name: host
              mountPath: /host
      containers:
        - name: pause
          image: k8s.gcr.io/pause:3.9
      volumes:
        - name: host
          hostPath:
            path: /
      tolerations:
        - operator: Exists
EOF

echo "Calico installation and optimization completed!"
echo "Verifying installation..."
kubectl get tigerastatus
calicoctl node status
```

## Advanced Policy Tiering and Hierarchical Security

Calico Enterprise features include policy tiering for implementing defense-in-depth security:

```yaml
# Global default deny policy (Platform tier)
apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: platform.default-deny
spec:
  tier: platform
  order: 1000
  selector: all()
  types:
    - Ingress
    - Egress
  # No rules means deny all by default
---
# Security baseline policies (Security tier)
apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: security.allow-dns
spec:
  tier: security
  order: 100
  selector: all()
  types:
    - Egress
  egress:
    # Allow DNS to kube-dns
    - action: Allow
      protocol: UDP
      destination:
        selector: k8s-app == "kube-dns"
        ports:
          - 53
    # Allow DNS to CoreDNS
    - action: Allow
      protocol: UDP
      destination:
        selector: k8s-app == "coredns"
        ports:
          - 53
---
apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: security.allow-health-checks
spec:
  tier: security
  order: 110
  selector: all()
  types:
    - Ingress
  ingress:
    # Allow health checks from load balancers
    - action: Allow
      protocol: TCP
      source:
        nets:
          - 10.0.0.0/8
      destination:
        ports:
          - 8080  # Health check port
          - 9090  # Metrics port
---
# Application-specific policies (Application tier)
apiVersion: projectcalico.org/v3
kind: NetworkPolicy
metadata:
  name: frontend-policy
  namespace: production
spec:
  tier: application
  order: 100
  selector: app == "frontend"
  types:
    - Ingress
    - Egress

  ingress:
    # Allow from ingress controller
    - action: Allow
      protocol: TCP
      source:
        selector: app == "ingress-nginx"
      destination:
        ports:
          - 3000

    # Allow Prometheus scraping
    - action: Allow
      protocol: TCP
      source:
        namespaceSelector: name == "monitoring"
        selector: app == "prometheus"
      destination:
        ports:
          - 9090

  egress:
    # Pass to DNS (handled by security tier)
    - action: Pass
      protocol: UDP
      destination:
        ports:
          - 53

    # Allow to backend API
    - action: Allow
      protocol: TCP
      destination:
        selector: app == "backend" && tier == "api"
        ports:
          - 8080

    # Allow to Redis cache
    - action: Allow
      protocol: TCP
      destination:
        selector: app == "redis" && tier == "cache"
        ports:
          - 6379

    # Allow specific external APIs
    - action: Allow
      protocol: TCP
      destination:
        nets:
          - 203.0.113.0/24  # External API subnet
        ports:
          - 443
---
# Backend API policy with rate limiting and logging
apiVersion: projectcalico.org/v3
kind: NetworkPolicy
metadata:
  name: backend-api-policy
  namespace: production
spec:
  tier: application
  order: 200
  selector: app == "backend" && tier == "api"
  types:
    - Ingress
    - Egress

  ingress:
    # Allow from frontend with logging
    - action: Allow
      protocol: TCP
      source:
        selector: app == "frontend"
      destination:
        ports:
          - 8080
      metadata:
        annotations:
          logs: "enabled"
          rate-limit: "1000req/s"

    # Allow from other backend services
    - action: Allow
      protocol: TCP
      source:
        selector: tier == "api"
      destination:
        ports:
          - 8080

  egress:
    # Pass DNS queries
    - action: Pass
      protocol: UDP
      destination:
        ports:
          - 53

    # Allow to database
    - action: Allow
      protocol: TCP
      destination:
        selector: app == "postgresql" && tier == "database"
        ports:
          - 5432

    # Allow to message queue
    - action: Allow
      protocol: TCP
      destination:
        selector: app == "rabbitmq"
        ports:
          - 5672

    # Log and allow HTTPS to external services
    - action: Log
    - action: Allow
      protocol: TCP
      destination:
        nets:
          - 0.0.0.0/0
        ports:
          - 443
      metadata:
        annotations:
          description: "External HTTPS traffic"
---
# Database policy with strict access control
apiVersion: projectcalico.org/v3
kind: NetworkPolicy
metadata:
  name: database-policy
  namespace: production
spec:
  tier: application
  order: 300
  selector: app == "postgresql" && tier == "database"
  types:
    - Ingress
    - Egress

  ingress:
    # Only allow from authorized backend services
    - action: Allow
      protocol: TCP
      source:
        selector: app == "backend" && tier == "api"
      destination:
        ports:
          - 5432
      metadata:
        annotations:
          logs: "enabled"
          alert: "enabled"

    # Allow from backup services
    - action: Allow
      protocol: TCP
      source:
        selector: app == "backup"
      destination:
        ports:
          - 5432

  egress:
    # Only allow DNS, deny everything else
    - action: Pass
      protocol: UDP
      destination:
        ports:
          - 53

    # Explicit deny for documentation
    - action: Log
    - action: Deny
      metadata:
        annotations:
          description: "Database should not initiate outbound connections"
---
# Policy for encrypted traffic only
apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: security.enforce-encryption
spec:
  tier: security
  order: 50
  selector: encryption-required == "true"
  types:
    - Ingress
    - Egress

  ingress:
    # Only allow TLS traffic
    - action: Allow
      protocol: TCP
      destination:
        ports:
          - 443
          - 8443

    # Log and deny non-encrypted
    - action: Log
    - action: Deny
      protocol: TCP
      metadata:
        annotations:
          alert: "Non-encrypted traffic blocked"

  egress:
    - action: Allow
      protocol: TCP
      destination:
        ports:
          - 443
          - 8443

    - action: Log
    - action: Deny
      protocol: TCP
```

### Policy Tier Management

```bash
#!/bin/bash
# Script to manage Calico policy tiers

# Create policy tiers in order of precedence
create_tiers() {
    echo "Creating policy tiers..."

    # Platform tier (highest priority)
    calicoctl create -f - <<EOF
apiVersion: projectcalico.org/v3
kind: Tier
metadata:
  name: platform
spec:
  order: 0
EOF

    # Security tier
    calicoctl create -f - <<EOF
apiVersion: projectcalico.org/v3
kind: Tier
metadata:
  name: security
spec:
  order: 100
EOF

    # Compliance tier
    calicoctl create -f - <<EOF
apiVersion: projectcalico.org/v3
kind: Tier
metadata:
  name: compliance
spec:
  order: 200
EOF

    # Application tier
    calicoctl create -f - <<EOF
apiVersion: projectcalico.org/v3
kind: Tier
metadata:
  name: application
spec:
  order: 300
EOF

    echo "Policy tiers created successfully"
}

# Validate policy configuration
validate_policies() {
    echo "Validating policy configuration..."

    # Check for conflicting policies
    calicoctl get globalnetworkpolicy -o yaml | grep -A 20 "selector:"

    # Verify tier order
    calicoctl get tier

    # Check policy counts per tier
    for tier in platform security compliance application; do
        count=$(calicoctl get networkpolicy,globalnetworkpolicy --all-namespaces -o json | \
                jq "[.items[] | select(.spec.tier == \"$tier\")] | length")
        echo "Tier $tier: $count policies"
    done
}

# Test policy enforcement
test_policy() {
    local source_pod=$1
    local dest_pod=$2
    local port=$3

    echo "Testing connectivity from $source_pod to $dest_pod:$port"

    kubectl exec -it $source_pod -- nc -zv $dest_pod $port

    # Check flow logs
    calicoctl get flowlog --context $source_pod
}

# Export policies for backup
backup_policies() {
    local backup_dir="calico-policies-backup-$(date +%Y%m%d-%H%M%S)"
    mkdir -p $backup_dir

    echo "Backing up policies to $backup_dir..."

    calicoctl get globalnetworkpolicy -o yaml > $backup_dir/global-policies.yaml
    calicoctl get networkpolicy --all-namespaces -o yaml > $backup_dir/namespace-policies.yaml
    calicoctl get tier -o yaml > $backup_dir/tiers.yaml
    calicoctl get felixconfiguration -o yaml > $backup_dir/felix-config.yaml

    tar czf $backup_dir.tar.gz $backup_dir
    echo "Backup created: $backup_dir.tar.gz"
}

# Main execution
case "${1:-help}" in
    create-tiers)
        create_tiers
        ;;
    validate)
        validate_policies
        ;;
    test)
        test_policy "$2" "$3" "$4"
        ;;
    backup)
        backup_policies
        ;;
    *)
        echo "Usage: $0 {create-tiers|validate|test|backup}"
        echo ""
        echo "Commands:"
        echo "  create-tiers           - Create policy tier hierarchy"
        echo "  validate               - Validate policy configuration"
        echo "  test <src> <dst> <port> - Test policy enforcement"
        echo "  backup                 - Backup all policies"
        exit 1
        ;;
esac
```

## Performance Monitoring and Optimization

```yaml
# Prometheus ServiceMonitor for Calico metrics
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: calico-node
  namespace: calico-system
  labels:
    app: calico-node
spec:
  selector:
    matchLabels:
      k8s-app: calico-node
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
      relabelings:
        - sourceLabels: [__meta_kubernetes_pod_node_name]
          targetLabel: node
        - sourceLabels: [__meta_kubernetes_namespace]
          targetLabel: namespace
---
# Grafana dashboard ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: calico-dashboard
  namespace: monitoring
data:
  calico-network-performance.json: |
    {
      "dashboard": {
        "title": "Calico Network Performance",
        "panels": [
          {
            "title": "Policy Evaluation Rate",
            "targets": [
              {
                "expr": "rate(felix_policy_update_time_seconds_count[5m])"
              }
            ]
          },
          {
            "title": "Flow Log Rate",
            "targets": [
              {
                "expr": "rate(felix_logs_dropped_total[5m])"
              }
            ]
          },
          {
            "title": "Connection Tracking",
            "targets": [
              {
                "expr": "felix_conntrack_entries"
              }
            ]
          },
          {
            "title": "BPF Program Performance",
            "targets": [
              {
                "expr": "rate(felix_bpf_dataplane_errors_total[5m])"
              }
            ]
          }
        ]
      }
    }
```

### Advanced Troubleshooting Commands

```bash
#!/bin/bash
# Comprehensive Calico troubleshooting toolkit

# Check policy enforcement for a pod
check_pod_policy() {
    local namespace=$1
    local pod=$2

    echo "=== Checking policy for $namespace/$pod ==="

    # Get pod endpoint
    endpoint=$(calicoctl get workloadendpoint --namespace=$namespace -o json | \
               jq -r ".items[] | select(.metadata.labels.\"projectcalico.org/pod\" == \"$pod\") | .metadata.name")

    if [ -z "$endpoint" ]; then
        echo "Error: Could not find endpoint for pod $pod"
        return 1
    fi

    echo "Endpoint: $endpoint"

    # Show endpoint details
    calicoctl get workloadendpoint $endpoint --namespace=$namespace -o yaml

    # Show applied policies
    calicoctl get networkpolicy --namespace=$namespace -o yaml | \
        yq eval ".items[] | select(.spec.selector | contains(\"app\"))" -

    # Show flow logs for this endpoint
    echo "Recent flow logs:"
    calicoctl get flowlog --context $endpoint | tail -20
}

# Monitor real-time connections
monitor_connections() {
    local node=$1

    echo "=== Monitoring connections on $node ==="

    kubectl exec -n calico-system calico-node-$node -- \
        calico-node -felix-live-conntrack
}

# Check BPF program status
check_bpf_status() {
    echo "=== Checking BPF Status ==="

    for node in $(kubectl get nodes -o name | cut -d/ -f2); do
        echo "Node: $node"
        kubectl exec -n calico-system -c calico-node calico-node-$(echo $node | tr '.' '-') -- \
            calico-node -bpf stats
    done
}

# Analyze policy performance
analyze_policy_performance() {
    echo "=== Policy Performance Analysis ==="

    # Get policy update metrics
    kubectl exec -n calico-system -c calico-node ds/calico-node -- \
        wget -qO- localhost:9091/metrics | grep felix_policy

    # Check for policy conflicts
    calicoctl get globalnetworkpolicy,networkpolicy --all-namespaces -o json | \
        jq '.items[] | {name: .metadata.name, tier: .spec.tier, order: .spec.order, selector: .spec.selector}'
}

# Test connectivity between pods
test_connectivity() {
    local source_ns=$1
    local source_pod=$2
    local dest_ns=$3
    local dest_pod=$4
    local port=$5

    echo "=== Testing connectivity ==="
    echo "From: $source_ns/$source_pod"
    echo "To: $dest_ns/$dest_pod:$port"

    # Get destination IP
    dest_ip=$(kubectl get pod -n $dest_ns $dest_pod -o jsonpath='{.status.podIP}')

    # Test connectivity
    kubectl exec -n $source_ns $source_pod -- nc -zv $dest_ip $port

    # Check flow logs
    echo "Checking flow logs..."
    source_endpoint=$(calicoctl get workloadendpoint --namespace=$source_ns -o json | \
                      jq -r ".items[] | select(.metadata.labels.\"projectcalico.org/pod\" == \"$source_pod\") | .metadata.name")

    calicoctl get flowlog --context $source_endpoint | grep $dest_ip
}

# Collect diagnostics
collect_diagnostics() {
    local output_dir="calico-diagnostics-$(date +%Y%m%d-%H%M%S)"
    mkdir -p $output_dir

    echo "Collecting Calico diagnostics to $output_dir..."

    # Collect node status
    kubectl get nodes -o yaml > $output_dir/nodes.yaml

    # Collect Calico resources
    calicoctl get nodes -o yaml > $output_dir/calico-nodes.yaml
    calicoctl get ippool -o yaml > $output_dir/ippools.yaml
    calicoctl get bgppeers -o yaml > $output_dir/bgppeers.yaml
    calicoctl get felixconfiguration -o yaml > $output_dir/felix-config.yaml

    # Collect policies
    calicoctl get globalnetworkpolicy -o yaml > $output_dir/global-policies.yaml
    calicoctl get networkpolicy --all-namespaces -o yaml > $output_dir/namespace-policies.yaml
    calicoctl get tier -o yaml > $output_dir/tiers.yaml

    # Collect logs
    kubectl logs -n calico-system -l k8s-app=calico-node --tail=10000 > $output_dir/calico-node-logs.txt
    kubectl logs -n calico-system -l k8s-app=calico-typha --tail=10000 > $output_dir/calico-typha-logs.txt
    kubectl logs -n calico-system -l k8s-app=calico-kube-controllers --tail=10000 > $output_dir/calico-controllers-logs.txt

    # Collect metrics
    kubectl exec -n calico-system ds/calico-node -- wget -qO- localhost:9091/metrics > $output_dir/node-metrics.txt

    # Create archive
    tar czf $output_dir.tar.gz $output_dir
    echo "Diagnostics archive created: $output_dir.tar.gz"
}

# Main menu
case "${1:-help}" in
    pod-policy)
        check_pod_policy "$2" "$3"
        ;;
    monitor)
        monitor_connections "$2"
        ;;
    bpf-status)
        check_bpf_status
        ;;
    performance)
        analyze_policy_performance
        ;;
    test)
        test_connectivity "$2" "$3" "$4" "$5" "$6"
        ;;
    diagnostics)
        collect_diagnostics
        ;;
    *)
        echo "Usage: $0 {pod-policy|monitor|bpf-status|performance|test|diagnostics}"
        echo ""
        echo "Commands:"
        echo "  pod-policy <ns> <pod>                    - Check policy for pod"
        echo "  monitor <node>                           - Monitor connections"
        echo "  bpf-status                               - Check BPF status"
        echo "  performance                              - Analyze policy performance"
        echo "  test <src-ns> <src-pod> <dst-ns> <dst-pod> <port> - Test connectivity"
        echo "  diagnostics                              - Collect diagnostics"
        exit 1
        ;;
esac
```

## BGP Configuration and Peering

```yaml
# BGP peering configuration
apiVersion: projectcalico.org/v3
kind: BGPConfiguration
metadata:
  name: default
spec:
  logSeverityScreen: Info
  nodeToNodeMeshEnabled: true
  asNumber: 64512
  serviceClusterIPs:
    - cidr: 10.96.0.0/12
  serviceExternalIPs:
    - cidr: 10.100.0.0/16
  listenPort: 179
  bindMode: NodeIP
  communities:
    - name: bgp-large-community
      value: 64512:120:1
    - name: bgp-standard-community
      value: 64512:100
---
# BGP peer configuration
apiVersion: projectcalico.org/v3
kind: BGPPeer
metadata:
  name: rack1-tor
spec:
  peerIP: 192.168.1.1
  asNumber: 65001
  nodeSelector: rack == 'rack1'
  keepOriginalNextHop: true
  password:
    secretKeyRef:
      name: bgp-secrets
      key: rackPassword
---
apiVersion: projectcalico.org/v3
kind: BGPPeer
metadata:
  name: rack2-tor
spec:
  peerIP: 192.168.1.2
  asNumber: 65001
  nodeSelector: rack == 'rack2'
  keepOriginalNextHop: true
  password:
    secretKeyRef:
      name: bgp-secrets
      key: rackPassword
```

## Conclusion

Calico provides enterprise-grade network policy enforcement with powerful optimization options through eBPF dataplane, policy tiering, and comprehensive observability. By implementing hierarchical security policies, enabling eBPF mode, and following performance best practices, organizations can build highly secure and performant Kubernetes networking infrastructure.

The key to successful Calico deployment lies in proper policy organization through tiers, continuous monitoring of performance metrics, and regular validation of security controls. With WireGuard encryption, BGP routing, and advanced policy capabilities, Calico delivers complete network security for production Kubernetes environments.