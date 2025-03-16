---
title: "Advanced Cilium Troubleshooting Guide for 2025"
date: 2025-03-14T14:00:00-05:00
draft: false
tags: ["Cilium", "Kubernetes", "Networking", "eBPF", "Troubleshooting"]
categories:
- Networking
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive, in-depth guide for troubleshooting Cilium issues within Kubernetes clusters in 2025 with advanced diagnostic techniques."
more_link: "yes"
---

Troubleshooting Cilium in Kubernetes environments remains challenging, especially as Cilium continues to evolve with more features and capabilities. This advanced guide expands on our [previous troubleshooting guide](../cilium-troubleshooting) with deeper insights, more detailed diagnostic approaches, and comprehensive resolution paths for complex Cilium issues in 2025.

<!--more-->

## Introduction and Cilium Architecture Review

Before diving into specific troubleshooting techniques, it's essential to understand Cilium's architecture and how its components interact. Cilium operates as a CNI plugin for Kubernetes and leverages eBPF technology to provide networking, security, and observability functions.

### Key Components

- **Cilium Agent**: Runs on each node, responsible for programming eBPF programs
- **Cilium Operator**: Cluster-scoped component that handles tasks requiring cluster-wide knowledge
- **eBPF Programs**: The core of Cilium's functionality, injected into the kernel
- **Hubble**: Optional observability layer for network traffic visualization
- **Cilium CLI**: Command-line interface for interacting with Cilium components

### Network Flow Paths

Understanding how packets flow through a Cilium-enabled cluster is crucial for troubleshooting:

1. **Pod Egress**: Pod → veth pair → eBPF TC hook → routing decision → destination
2. **Pod Ingress**: Source → node network interface → eBPF TC hook → veth pair → pod
3. **Service Access**: Pod → eBPF service lookup → endpoint selection → destination pod

This knowledge helps identify where in the path issues might be occurring.

## Diagnostic Foundations

### Setting Proper Logging Levels

Cilium's default logging level might not provide enough information for advanced troubleshooting. Modify it using:

```bash
# Check current logging configuration
kubectl -n kube-system exec -it ds/cilium -- cilium config get debug

# Enable more verbose logging
kubectl -n kube-system exec -it ds/cilium -- cilium config set debug true
```

For even more granular control:

```bash
# Set specific logging levels for components
kubectl -n kube-system exec -it ds/cilium -- cilium config set debug-verbose map[datapath:true policy:true]
```

### Understanding Cilium Logs

Cilium logs contain valuable diagnostic information. Key patterns to look for:

- `level=info msg="Initializing Cilium"`: Startup sequence
- `level=debug msg="Endpoint starting regeneration"`: Endpoint configuration changes
- `level=warning msg="Failed to"`: Indication of issues 
- `level=error`: Critical issues requiring attention

When analyzing logs, use a structured approach:

```bash
# Extract error messages
kubectl -n kube-system logs ds/cilium | grep "level=error"

# Look for policy-related messages
kubectl -n kube-system logs ds/cilium | grep "level=debug.*policy"

# Examine startup sequence
kubectl -n kube-system logs ds/cilium | grep "Initializing"
```

### Establishing Baseline Metrics

Before troubleshooting, establish performance baselines:

```bash
# Get current Cilium agent metrics
kubectl -n kube-system exec -it ds/cilium -- cilium metrics list

# Focus on key performance indicators
kubectl -n kube-system exec -it ds/cilium -- cilium metrics list | grep "datapath\|endpoint\|policy"
```

Important metrics to monitor include:
- `cilium_endpoint_regenerations_total`: Frequency of endpoint regenerations
- `cilium_datapath_errors_total`: Datapath programming failures
- `cilium_policy_import_errors_total`: Policy import issues
- `cilium_datapath_conntrack_gc_duration_seconds`: Connection tracking garbage collection time

## Cluster-Level Diagnostics

### Agent Health Verification

A thorough health check should be your first step:

```bash
# Get all Cilium pods and their status
kubectl -n kube-system get pods -l k8s-app=cilium -o wide

# Check Cilium status on each node
for pod in $(kubectl -n kube-system get pods -l k8s-app=cilium -o name); do
  echo "Checking $pod..."
  kubectl -n kube-system exec -it $pod -- cilium status --verbose
done
```

The status output reveals critical information:
- KVStore connectivity
- Kubernetes API server connectivity
- Controller status (should show "0/X failing")
- Proxy status
- Cluster health

Any failing controllers warrant investigation:

```bash
# List failing controllers with details
kubectl -n kube-system exec -it ds/cilium -- cilium status --verbose | grep -A 5 "Controller Status"
```

### Cilium Operator Troubleshooting

The Cilium Operator handles cluster-wide resources like CiliumNetworkPolicies:

```bash
# Check operator logs
kubectl -n kube-system logs -l name=cilium-operator

# Check operator status
kubectl -n kube-system get deployment cilium-operator
```

Common operator issues include:
- CRD synchronization failures
- Webhook configuration problems
- Resource exhaustion (check for OOMKilled in pod events)

### Control Plane to Data Plane Synchronization

Verify synchronization between Kubernetes and Cilium:

```bash
# Get all Kubernetes services
kubectl get svc --all-namespaces

# Compare with Cilium's service list on a node
kubectl -n kube-system exec -it ds/cilium -- cilium service list
```

Any discrepancies indicate synchronization issues. Check for:
- Services in Kubernetes not appearing in Cilium
- Endpoints missing in Cilium's service backends

### Kernel Compatibility Verification

Cilium requires specific kernel features. Verify compatibility:

```bash
# Run compatibility check
kubectl -n kube-system exec -it ds/cilium -- cilium kernel-check
```

Issues like missing eBPF maps or programs may indicate kernel incompatibility.

### eBPF Map Diagnostics

eBPF maps are key-value stores used by Cilium. Examine them:

```bash
# List available maps
kubectl -n kube-system exec -it ds/cilium -- cilium bpf maps list

# Check specific map details
kubectl -n kube-system exec -it ds/cilium -- cilium bpf ct list global
```

Watch for these issues:
- Maps at capacity (size vs max entries)
- Stale entries
- Unexpected entries

## Pod Connectivity Troubleshooting

### Pod-to-Pod Communication Path Analysis

When pods can't communicate, trace the path:

```bash
# Identify the Cilium endpoint IDs
kubectl -n kube-system exec -it ds/cilium -- cilium endpoint list

# Examine specific endpoints
kubectl -n kube-system exec -it ds/cilium -- cilium endpoint get <id>

# Trace traffic between endpoints
kubectl -n kube-system exec -it ds/cilium -- cilium monitor --to-endpoint <destination-id> --from-endpoint <source-id>
```

This traces live traffic between endpoints. Look for:
- `DROP_POLICY`: Policy violations
- `DROP_CT_INVALID`: Connection tracking issues
- `Packet dropped`: Generic drops with reasons

### Advanced Connectivity Testing

For more structured testing:

```bash
# Deploy the connectivity test
kubectl create ns cilium-test
kubectl apply -n cilium-test -f https://raw.githubusercontent.com/cilium/cilium/v1.15.x/examples/kubernetes/connectivity-check/connectivity-check.yaml

# Verify all pods are running
kubectl -n cilium-test get pods
```

Analyze any failing pods:

```bash
# Get details on failing pods
kubectl -n cilium-test describe pod <failing-pod>

# Check logs
kubectl -n cilium-test logs <failing-pod>
```

### DNS Resolution Issues

Cilium can act as a DNS proxy. Check for DNS issues:

```bash
# Verify DNS proxy status
kubectl -n kube-system exec -it ds/cilium -- cilium status | grep DNS

# Check DNS cache entries
kubectl -n kube-system exec -it ds/cilium -- cilium fqdn cache list
```

Common DNS troubleshooting steps:
1. Verify CoreDNS/kube-dns is functioning
2. Check Cilium's DNS proxy configuration
3. Examine DNS policies if FQDN policies are in use
4. Monitor DNS traffic:

```bash
# Monitor DNS traffic
kubectl -n kube-system exec -it ds/cilium -- cilium monitor --type L7 | grep DNS
```

### Packet Capture and Analysis

For deeper analysis, capture packets at the endpoint:

```bash
# Find the endpoint ID and security ID
kubectl -n kube-system exec -it ds/cilium -- cilium endpoint list

# Capture traffic for a specific endpoint
kubectl -n kube-system exec -it ds/cilium -- cilium monitor --type drop -n <namespace> -o json

# Export to pcap for Wireshark analysis
kubectl -n kube-system exec -it ds/cilium -- cilium monitor --type drop -n <namespace> --hexdump | cilium-monitor-format > capture.pcap
```

This provides visibility into:
- Exactly which packets are being dropped
- The drop reason coded in the eBPF programs
- Packet contents for deeper inspection

### Traffic Flow Visualization with Hubble

Hubble provides powerful visualization for Cilium traffic:

```bash
# Check if Hubble is enabled
kubectl -n kube-system get pods -l k8s-app=hubble

# Enable Hubble if needed (example with Helm)
helm upgrade cilium cilium/cilium --namespace kube-system --reuse-values --set hubble.enabled=true --set hubble.metrics.enabled="{dns,drop,tcp,flow,icmp,http}"

# Access Hubble UI or CLI
export POD_NAME=$(kubectl get pods -n kube-system -l k8s-app=hubble-relay -o name | head -n 1)
kubectl -n kube-system port-forward $POD_NAME 4245:4245 &
hubble status
hubble observe
```

Hubble provides key insights:
- Visual traffic flow between services and pods
- Policy decision points
- Drop reasons with rich context
- L7 protocol insights (HTTP, gRPC, etc.)

## Advanced Policy Troubleshooting

### Policy Audit Mode Usage

Audit mode allows testing policies without enforcing them:

```bash
# Enable policy audit mode
kubectl -n kube-system exec -it ds/cilium -- cilium config set policy-audit-mode true

# Check policy violations in audit mode
kubectl -n kube-system logs ds/cilium | grep "would be denied by policy"
```

This helps debug policy issues before enforcement.

### Analyzing Policy Enforcement Logs

When policies block traffic, analyze the logs:

```bash
# Monitor policy drops
kubectl -n kube-system exec -it ds/cilium -- cilium monitor --type drop | grep "Policy denied"

# Check specific policy status
kubectl -n kube-system exec -it ds/cilium -- cilium policy get
```

Important details to extract:
- Source and destination identity
- Layer 3/4 information (IP, port, protocol)
- Missing policy rule patterns

### Step-by-Step Policy Debugging Workflow

1. **Identify affected pods**:
```bash
# Get labels for source and destination pods
kubectl get pod <source-pod> -o json | jq .metadata.labels
kubectl get pod <destination-pod> -o json | jq .metadata.labels
```

2. **Check identity mapping**:
```bash
# Map labels to Cilium identities
kubectl -n kube-system exec -it ds/cilium -- cilium identity list
```

3. **Verify policy rules**:
```bash
# Get policy for destination namespace
kubectl get cnp,cclp -n <namespace> -o yaml
```

4. **Test with temporary allow policy**:
```bash
# Create a temporary allow policy
cat <<EOF | kubectl apply -f -
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: temp-allow
  namespace: <namespace>
spec:
  endpointSelector:
    matchLabels:
      app: <destination-app>
  ingress:
  - fromEndpoints:
    - matchLabels:
        app: <source-app>
EOF
```

5. **Monitor policy resolution**:
```bash
# Watch policy computation
kubectl -n kube-system exec -it ds/cilium -- cilium monitor --type policy
```

### Policy Test Frameworks

For automated policy testing, use the Cilium policy test framework:

```bash
# Clone Cilium repository for the test framework
git clone https://github.com/cilium/cilium.git
cd cilium/test/k8s/manifests

# Deploy test pods
kubectl apply -f policy-test/

# Run connectivity tests
cd ../../..
go test ./test/k8s/policy_test.go -run TestPolicyEnforcement
```

## Performance Diagnostics

### Identifying eBPF Program Bottlenecks

Performance issues might stem from eBPF programs:

```bash
# Check eBPF program performance
kubectl -n kube-system exec -it ds/cilium -- cilium bpf program list

# Get detailed map information
kubectl -n kube-system exec -it ds/cilium -- cilium bpf map list
```

Look for:
- High iteration counts in maps
- Programs with significant runtime
- Map sizes approaching limits

### Connection Tracking Table Troubleshooting

Connection tracking (CT) tables can cause performance issues:

```bash
# Check CT table statistics
kubectl -n kube-system exec -it ds/cilium -- cilium bpf ct list global | wc -l

# Get CT timeouts
kubectl -n kube-system exec -it ds/cilium -- cilium config | grep "conntrack-"
```

Common issues:
- CT table at max capacity
- Stale connections not being pruned
- Aggressive timeout settings

```bash
# Manually trigger garbage collection
kubectl -n kube-system exec -it ds/cilium -- cilium bpf ct flush global
```

### CPU and Memory Resource Constraints Analysis

Resource constraints often manifest as performance issues:

```bash
# Check Cilium pod resource usage
kubectl -n kube-system top pod -l k8s-app=cilium

# Examine node capacity
kubectl -n kube-system describe node <node-name> | grep -A 5 "Capacity"
```

Look for:
- CPU throttling
- Memory pressure
- OOMKilled events in pod logs

## Service Mesh Integration Issues

### Envoy Proxy Configuration Troubleshooting

When using Cilium's Envoy integration:

```bash
# Check Envoy status
kubectl -n kube-system exec -it ds/cilium -- cilium status --verbose | grep -A 10 Proxy

# Get Envoy config
kubectl -n kube-system exec -it ds/cilium -- cilium bpf proxy list

# View Envoy access logs
kubectl -n kube-system exec -it ds/cilium -- cilium proxy get access-log
```

Common issues:
- Certificate problems
- XDS configuration failures
- Listener configuration errors

### L7 Policy Enforcement Debugging

L7 policies require special troubleshooting:

```bash
# Monitor L7 traffic
kubectl -n kube-system exec -it ds/cilium -- cilium monitor --type l7

# Check specific L7 policy
kubectl -n kube-system exec -it ds/cilium -- cilium policy selectors | grep "L7"
```

For HTTP policy issues:
1. Check if traffic is reaching Envoy
2. Verify HTTP headers match policy requirements
3. Examine Envoy logs for policy decisions

## Upgrade and Migration Troubles

### Pre-flight Checks for Upgrades

Before upgrading Cilium:

```bash
# Verify cluster health
kubectl -n kube-system exec -it ds/cilium -- cilium status
kubectl -n kube-system exec -it ds/cilium -- cilium connectivity test

# Check for blocking issues
kubectl -n kube-system exec -it ds/cilium -- cilium preflight verify --validate-cnp
```

### Common Upgrade Failure Patterns

During upgrades, watch for:
- Configuration option deprecations
- CRD version incompatibilities
- Kernel feature requirements
- IPAM mode migration issues

If an upgrade fails:

```bash
# Check failed pods
kubectl -n kube-system describe pod -l k8s-app=cilium | grep -A 10 "Events:"

# Look for compatibility issues
kubectl -n kube-system logs -l k8s-app=cilium | grep "incompatible"
```

### Rollback Procedures

If rollback is necessary:

1. Restore the previous Cilium version:
```bash
# Example with Helm
helm rollback cilium <previous-revision> -n kube-system
```

2. Verify post-rollback:
```bash
kubectl -n kube-system wait --for=condition=ready pods -l k8s-app=cilium
kubectl -n kube-system exec -it ds/cilium -- cilium status
```

## Advanced CLI Techniques

### Deep Dive into Cilium Status Output

The `cilium status` command provides extensive diagnostic information:

```bash
kubectl -n kube-system exec -it ds/cilium -- cilium status --verbose
```

Key sections to analyze:
- **KVStore**: Must show "Connected" for proper operation
- **Controllers**: Should show 0 failing controllers
- **Proxy Status**: Should be "OK" if L7 policies are used
- **IPAM**: Shows IP address allocation stats
- **Encryption**: Shows encryption status if enabled

### Advanced Cilium Monitor Usage with Filters

`cilium monitor` is a powerful tool with filtering capabilities:

```bash
# Monitor specific endpoints
kubectl -n kube-system exec -it ds/cilium -- cilium monitor --from-endpoint <id>

# Filter by verdict
kubectl -n kube-system exec -it ds/cilium -- cilium monitor --type drop

# Filter by policy verdict
kubectl -n kube-system exec -it ds/cilium -- cilium monitor --type policy-verdict

# Filter by protocol
kubectl -n kube-system exec -it ds/cilium -- cilium monitor --type capture -n <namespace> | grep TCP
```

For complex filtering, use the format option with jq:

```bash
kubectl -n kube-system exec -it ds/cilium -- cilium monitor -o json | jq 'select(.summary.verdict == "DROPPED") | {source: .source, destination: .destination, drop_reason: .summary.reason}'
```

### BPF Map Inspection and Manipulation

Advanced map troubleshooting techniques:

```bash
# List all maps
kubectl -n kube-system exec -it ds/cilium -- cilium bpf maps list

# Examine neighbors table
kubectl -n kube-system exec -it ds/cilium -- cilium bpf neighbor list

# Check policy maps
kubectl -n kube-system exec -it ds/cilium -- cilium bpf policy get <endpoint-id>

# Inspect routing table
kubectl -n kube-system exec -it ds/cilium -- cilium bpf lb list
```

For detailed policy analysis:

```bash
# Get endpoint policy by ID
kubectl -n kube-system exec -it ds/cilium -- cilium bpf policy get <endpoint-id> -n <namespace> --all-layers
```

## Automated Troubleshooting

### Building Diagnostic Automation

Create scripts for common diagnostic tasks:

```bash
# Example bash script for comprehensive Cilium diagnostics
cat > cilium-diag.sh << 'EOF'
#!/bin/bash
echo "===== Cilium Agent Status ====="
kubectl -n kube-system exec -it ds/cilium -- cilium status --verbose

echo "===== Controller Status ====="
kubectl -n kube-system exec -it ds/cilium -- cilium status --verbose | grep -A 20 "Controller Status"

echo "===== Policy Status ====="
kubectl -n kube-system exec -it ds/cilium -- cilium policy get

echo "===== Endpoint Status ====="
kubectl -n kube-system exec -it ds/cilium -- cilium endpoint list

echo "===== Service Status ====="
kubectl -n kube-system exec -it ds/cilium -- cilium service list

echo "===== BPF Maps ====="
kubectl -n kube-system exec -it ds/cilium -- cilium bpf maps list

echo "===== Recent Policy Drops ====="
kubectl -n kube-system logs -l k8s-app=cilium --tail=50 | grep "Policy denied"
EOF
chmod +x cilium-diag.sh
```

### Continuous Verification Techniques

Implement regular health checks:

```bash
# Kubernetes CronJob for regular Cilium health checks
cat << EOF | kubectl apply -f -
apiVersion: batch/v1
kind: CronJob
metadata:
  name: cilium-health-check
  namespace: kube-system
spec:
  schedule: "*/30 * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: cilium
          containers:
          - name: cilium-health
            image: cilium/cilium:latest
            command: 
            - /bin/sh
            - -c
            - |
              cilium status --verbose
              cilium connectivity test
          restartPolicy: OnFailure
EOF
```

## Case Studies with Resolution Paths

### Case 1: Intermittent Pod Connectivity

**Symptoms**: Pods occasionally unable to communicate, with intermittent timeouts

**Diagnostic Steps**:
1. Check endpoint status:
```bash
kubectl -n kube-system exec -it ds/cilium -- cilium endpoint list
```

2. Look for "not-ready" or unhealthy endpoints:
```bash
kubectl -n kube-system exec -it ds/cilium -- cilium endpoint list | grep -v "ready"
```

3. Monitor for drops during connectivity attempts:
```bash
kubectl -n kube-system exec -it ds/cilium -- cilium monitor --type drop
```

4. Check for controller failures:
```bash
kubectl -n kube-system exec -it ds/cilium -- cilium status | grep "controller"
```

**Common Causes and Resolutions**:
- **Connection tracking table full**: Increase CT table size or adjust timeouts
- **Identity resolution failures**: Check kvstore connectivity
- **Endpoint regeneration failures**: Examine agent logs for specific errors
- **Network policy conflicts**: Audit policies and simplify where possible

### Case 2: Service Load Balancing Failures

**Symptoms**: Service backends unreachable or load balancing uneven

**Diagnostic Steps**:
1. Verify service is properly defined in Cilium:
```bash
kubectl -n kube-system exec -it ds/cilium -- cilium service list
```

2. Check backend selection:
```bash
kubectl -n kube-system exec -it ds/cilium -- cilium bpf lb list
```

3. Monitor service access attempts:
```bash
kubectl -n kube-system exec -it ds/cilium -- cilium monitor --type trace | grep <service-ip>
```

**Common Causes and Resolutions**:
- **Backend sync issues**: Restart Cilium agent to force resync
- **Selector issues**: Verify pod labels match service selectors
- **BPF map limits**: Check if BPF LB map is at capacity
- **Health checks failing**: Check readiness probe configuration

### Case 3: Policy Enforcement Inconsistencies

**Symptoms**: Unexpected traffic blocks or allowances across the cluster

**Diagnostic Steps**:
1. Check policy status and compute resources:
```bash
kubectl -n kube-system exec -it ds/cilium -- cilium policy get
```

2. Verify policy selectors match intended pods:
```bash
kubectl -n kube-system exec -it ds/cilium -- cilium policy selectors
```

3. Monitor policy verdicts during traffic:
```bash
kubectl -n kube-system exec -it ds/cilium -- cilium monitor --type policy-verdict
```

**Common Causes and Resolutions**:
- **Policy ordering issues**: Check policy priorities and CRD evaluation order
- **Selector mismatches**: Verify label selectors match intended pods
- **Reserved labels conflicts**: Avoid conflicts with Cilium's reserved labels
- **Stale identities**: Restart affected endpoints to refresh identity

## Toolbox

### Enhanced Collection Scripts

For comprehensive diagnostics, use the Cilium sysdump tool:

```bash
# Download the latest sysdump
curl -sLO https://github.com/cilium/cilium-sysdump/releases/latest/download/cilium-sysdump.zip
python cilium-sysdump.zip --collector-params 'pod-logs=true' --since 1h
```

This collects:
- Pod logs
- Endpoint and service information
- Controller status
- BPF maps and programs
- Kubernetes resources

### Custom Debugging Environments

For complex issues, create a debug pod with advanced tools:

```bash
# Deploy a debug pod
cat << EOF | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cilium-debug
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: cilium-debug
  template:
    metadata:
      labels:
        app: cilium-debug
    spec:
      hostNetwork: true
      containers:
      - name: debug
        image: cilium/cilium:latest
        command: ["sleep", "1000000"]
        securityContext:
          privileged: true
      nodeSelector:
        kubernetes.io/hostname: <problematic-node>
EOF

# Access the debug pod
kubectl -n kube-system exec -it $(kubectl -n kube-system get pod -l app=cilium-debug -o name) -- bash
```

This provides a full Cilium environment for debugging directly on the problematic node.

## Conclusion

Cilium troubleshooting in 2025 requires a methodical approach and understanding of its internal architecture. By following the diagnostic techniques in this guide, you can effectively identify and resolve even the most complex Cilium issues.

Remember these key principles:
1. Start with a systematic approach to narrow down the problem area
2. Use the right diagnostic tools for each layer of the stack
3. When in doubt, increase logging verbosity and use packet captures
4. Leverage Hubble for visual traffic analysis when available
5. For persistent issues, collect comprehensive diagnostics with sysdump

For the latest updates and detailed documentation, always refer to the [official Cilium documentation](https://docs.cilium.io/).
