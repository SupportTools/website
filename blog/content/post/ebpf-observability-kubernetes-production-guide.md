---
title: "eBPF Observability on Kubernetes: Pixie, Hubble, and Tetragon"
date: 2028-01-07T00:00:00-05:00
draft: false
tags: ["eBPF", "Kubernetes", "Observability", "Pixie", "Hubble", "Tetragon", "Cilium", "Security"]
categories:
- Kubernetes
- Observability
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to eBPF-based observability on Kubernetes covering Pixie auto-instrumentation, Cilium Hubble network flow visibility, Tetragon runtime security enforcement, CO-RE portability, and production deployment patterns."
more_link: "yes"
url: "/ebpf-observability-kubernetes-production-guide/"
---

Extended Berkeley Packet Filter (eBPF) has fundamentally changed how operators observe and secure Kubernetes workloads. By running sandboxed programs in the Linux kernel without modifying kernel source code or loading kernel modules, eBPF enables zero-instrumentation observability, sub-microsecond network telemetry, and in-kernel security enforcement that would otherwise require intrusive application changes or heavy sidecar proxies. This guide examines the eBPF program lifecycle, CO-RE portability, and three production-grade tools built on eBPF: Pixie for auto-instrumentation, Cilium Hubble for network visibility, and Tetragon for security enforcement.

<!--more-->

# eBPF Observability on Kubernetes: Pixie, Hubble, and Tetragon

## Section 1: eBPF Fundamentals for Kubernetes Engineers

### The eBPF Program Lifecycle

An eBPF program goes through several stages before executing in the kernel:

1. **Write**: Program written in restricted C (or using libbpf helpers, Go with ebpf-go, or Rust with aya).
2. **Compile**: LLVM/Clang compiles to eBPF bytecode (`.o` ELF file).
3. **Load**: User-space program calls `bpf(BPF_PROG_LOAD, ...)` syscall.
4. **Verify**: Kernel verifier checks safety: no unbounded loops, bounded memory access, no null pointer dereferences, proper return types.
5. **JIT compile**: Kernel JIT compiler converts bytecode to native machine code.
6. **Attach**: Program attached to a hook point (kprobe, uprobe, tracepoint, network hook, etc.).
7. **Execute**: Kernel calls the eBPF program at the hook point.
8. **Communicate**: Program shares data with user space via maps or ring buffers.

```
                    ┌─────────────────────────────────┐
User Space          │  Load/Attach  │  Read Events   │
                    └──────┬────────┴───────┬─────────┘
                           │ BPF syscall    │ read/mmap
─────────────────────────────────────────────────────
Kernel Space        ┌──────▼────────────────▼──────┐
                    │  Verifier  ──▶  JIT  ──▶ Run │
                    │  at hook point                │
                    │  ┌──────────────────────┐     │
                    │  │  eBPF Maps (shared)  │     │
                    │  └──────────────────────┘     │
                    └───────────────────────────────┘
```

### Hook Points Relevant to Kubernetes Observability

| Hook Type | Use Case | Kernel Overhead |
|-----------|----------|-----------------|
| `kprobe/kretprobe` | Trace kernel function calls | Low-medium |
| `tracepoint` | Stable kernel tracepoints | Low |
| `uprobe/uretprobe` | Trace user-space function calls | Medium |
| `XDP` | Packet processing at driver level | Very low |
| `tc ingress/egress` | Traffic control hooks | Low |
| `cgroup/skb` | Per-cgroup socket operations | Low |
| `lsm` | Linux Security Module hooks | Low |
| `fentry/fexit` | Attach to kernel function entry/exit | Low |

### CO-RE: Compile Once Run Everywhere

A major historical limitation of eBPF was kernel version dependency: programs compiled against one kernel's header files would fail on a different kernel version due to structure layout changes. CO-RE solves this by embedding BTF (BPF Type Format) in the kernel, allowing programs to relocate field accesses at load time.

```c
// Without CO-RE: fragile, tied to specific kernel headers
struct task_struct *task = bpf_get_current_task();
pid_t pid = task->pid;  // Offset of pid may differ between kernel versions

// With CO-RE: relocatable field access
#include "vmlinux.h"  // Auto-generated from kernel BTF
#include <bpf/bpf_core_read.h>

struct task_struct *task = bpf_get_current_task_btf();
pid_t pid = BPF_CORE_READ(task, pid);  // Resolved at load time using BTF
```

### Checking Kernel BTF Support

```bash
# Verify kernel has BTF enabled
ls -la /sys/kernel/btf/vmlinux
# Expected: -r--r--r-- 1 root root <size> /sys/kernel/btf/vmlinux

# Check kernel version (CO-RE requires 5.8+, best on 5.15+)
uname -r

# Verify eBPF capabilities on a node
kubectl debug node/worker-1 \
  -it \
  --image=nicolaka/netshoot \
  -- bpftool prog list 2>/dev/null | head -20

# Check available BTF types
bpftool btf list
```

### eBPF Map Types and Performance Characteristics

```
Map Type            | Description                          | Use Case
--------------------|--------------------------------------|---------------------------
BPF_MAP_TYPE_HASH   | Hash map, O(1) lookup                | Connection tracking
BPF_MAP_TYPE_ARRAY  | Index-based, pre-allocated           | Per-CPU statistics
BPF_MAP_TYPE_PERF_EVENT_ARRAY | Perf ring buffer per CPU  | High-freq event streaming
BPF_MAP_TYPE_RINGBUF | Shared ring buffer (5.8+)          | Preferred for events
BPF_MAP_TYPE_LRU_HASH | LRU eviction, bounded memory     | Active connections
BPF_MAP_TYPE_PERCPU_HASH | Per-CPU hash, lock-free       | High-throughput counters
BPF_MAP_TYPE_PROG_ARRAY | Tail call dispatch table       | Modular eBPF programs
```

Ring buffers are preferred over perf event arrays for most observability use cases due to lower overhead and simpler user-space consumption:

```c
// Ring buffer output in eBPF program
struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 256 * 1024);  // 256KB ring buffer
} events SEC(".maps");

SEC("tracepoint/syscalls/sys_enter_execve")
int trace_execve(struct trace_event_raw_sys_enter *ctx) {
    struct event *e;

    e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
    if (!e)
        return 0;

    e->pid = bpf_get_current_pid_tgid() >> 32;
    bpf_get_current_comm(&e->comm, sizeof(e->comm));
    bpf_ringbuf_submit(e, 0);
    return 0;
}
```

## Section 2: Pixie Auto-Instrumentation

Pixie provides instant observability for Kubernetes applications using eBPF, requiring no code changes or sidecar injection. It captures L7 protocol data (HTTP, gRPC, MySQL, PostgreSQL, Kafka, DNS, Redis) by tracing SSL/TLS operations at the kernel level.

### Pixie Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     Kubernetes Cluster                    │
│                                                          │
│  ┌─────────────────────────────────────────────────┐    │
│  │          Pixie Vizier (per cluster)             │    │
│  │                                                 │    │
│  │  ┌──────────────┐    ┌──────────────────────┐  │    │
│  │  │  PEM Agent   │    │  Cloud Connector     │  │    │
│  │  │  (DaemonSet) │    │  (metadata proxy)    │  │    │
│  │  └──────┬───────┘    └──────────────────────┘  │    │
│  │         │ eBPF programs                         │    │
│  │         ▼                                       │    │
│  │  ┌──────────────────────────────────────────┐  │    │
│  │  │         Linux Kernel eBPF hooks          │  │    │
│  │  │  ssl_read/ssl_write | sys_enter_read...  │  │    │
│  │  └──────────────────────────────────────────┘  │    │
│  └─────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
```

### Installing Pixie

```bash
# Install Pixie CLI
bash -c "$(curl -fsSL https://withpixie.ai/install.sh)"

# Authenticate (requires Pixie account or self-hosted deployment)
px auth login

# Deploy Pixie to cluster
px deploy \
  --cluster-name prod-cluster \
  --deploy-key <your-deploy-key> \
  --pem-memory-limit 2Gi

# For self-hosted Pixie (open-source)
git clone https://github.com/pixie-io/pixie.git
cd pixie

# Build and deploy self-hosted cloud
# (detailed build instructions in repo README)
```

### Deploying Pixie via Helm

```bash
helm repo add pixie https://pixie-operator-charts.storage.googleapis.com
helm repo update

helm install pixie pixie/pixie-operator-chart \
  --namespace pl \
  --create-namespace \
  --set clusterName=prod-cluster \
  --set deployKey=<your-deploy-key> \
  --set pemMemoryLimit=2Gi \
  --set pemMemoryRequest=1Gi \
  --set pemCPULimit=2 \
  --set pemCPURequest=500m \
  --set dataAccess=Full \
  --set patches.pem="tolerations:\n- operator: Exists"
```

### Pixie Query Language (PxL) for HTTP Observability

```python
# http_latency_breakdown.pxl
# Pixie PxL script to analyze HTTP latency by service
import px

# Get HTTP events from the last 5 minutes
df = px.DataFrame(table='http_events', start_time='-5m')

# Filter out health checks and internal traffic
df = df[df.req_path != '/healthz']
df = df[df.req_path != '/readyz']
df = df[df.req_path != '/metrics']

# Add pod and service metadata
df.pod = df.ctx['pod']
df.namespace = df.ctx['namespace']
df.service = df.ctx['service']

# Calculate latency statistics per service
df = df.groupby(['service', 'req_method', 'resp_status']).agg(
    latency_p50=('latency', px.quantiles(0.50)),
    latency_p99=('latency', px.quantiles(0.99)),
    latency_max=('latency', px.max),
    request_count=('latency', px.count),
    error_count=('resp_status', lambda x: px.sum(x >= 400)),
)

df.error_rate = df.error_count / df.request_count * 100

# Sort by p99 latency
df = df.sort('latency_p99', ascending=False)

px.display(df, 'HTTP Latency by Service')
```

```python
# database_query_analysis.pxl
# Analyze slow MySQL queries without any application instrumentation
import px

df = px.DataFrame(table='mysql_events', start_time='-10m')

df.pod = df.ctx['pod']
df.service = df.ctx['service']

# Focus on slow queries
df = df[df.latency > 100 * px.MILLISECONDS]

df = df.groupby(['service', 'req_body']).agg(
    call_count=('latency', px.count),
    p50_latency=('latency', px.quantiles(0.50)),
    p99_latency=('latency', px.quantiles(0.99)),
    max_latency=('latency', px.max),
)

df = df.sort('p99_latency', ascending=False)
df = df.head(25)

px.display(df, 'Slow MySQL Queries')
```

### Running Pixie Scripts via CLI

```bash
# Run a built-in script for namespace overview
px run px/namespace_overview -- --namespace production

# Run custom PxL script
px run -f http_latency_breakdown.pxl -- --start_time -15m

# Get service map for a namespace
px run px/service_map -- --namespace production --start_time -5m

# Live tail HTTP errors
px run px/http_data_filtered -- \
  --namespace production \
  --start_time -1m \
  --resp_status 5
```

### Pixie Integration with Grafana

```yaml
# grafana-datasource-pixie.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-datasources
  namespace: monitoring
data:
  pixie-datasource.yaml: |
    apiVersion: 1
    datasources:
    - name: Pixie
      type: pixie-grafana-datasource
      url: https://work.withpixie.ai
      access: proxy
      jsonData:
        clusterId: <cluster-id>
        apiKey: <api-key>
      secureJsonData:
        apiKey: <api-key>
```

## Section 3: Cilium Hubble for Network Flow Visibility

Hubble is the observability layer built on top of Cilium. It leverages Cilium's eBPF dataplane to provide per-flow, per-connection network visibility without any packet sampling.

### Hubble Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     Kubernetes Node                          │
│                                                              │
│  ┌────────────────────────────────────────────────────┐     │
│  │  Cilium Agent                                      │     │
│  │  ┌─────────────────┐   ┌──────────────────────┐  │     │
│  │  │  eBPF Programs  │──▶│  Flow Ring Buffer    │  │     │
│  │  │  (XDP, tc, lsm) │   │  (in-memory flows)   │  │     │
│  │  └─────────────────┘   └──────────┬───────────┘  │     │
│  └────────────────────────────────────┼──────────────┘     │
│                                       │                      │
│  ┌────────────────────────────────────▼──────────────┐     │
│  │  Hubble Observer (per node)                       │     │
│  │  - Exports flows via gRPC                         │     │
│  └────────────────────────────────────┬──────────────┘     │
└───────────────────────────────────────┼────────────────────┘
                                        │
                         ┌──────────────▼──────────────┐
                         │  Hubble Relay (cluster-wide) │
                         │  - Aggregates all node flows │
                         └──────────────┬───────────────┘
                                        │
                    ┌───────────────────┼───────────────────┐
                    │                   │                   │
             ┌──────▼──────┐  ┌────────▼────────┐  ┌──────▼──────┐
             │ Hubble UI   │  │  hubble CLI      │  │  Prometheus │
             │ (web)       │  │  (observe flows) │  │  (metrics)  │
             └─────────────┘  └─────────────────┘  └─────────────┘
```

### Installing Cilium with Hubble

```bash
# Install Cilium CLI
CILIUM_CLI_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt)
curl -L --remote-name-all \
  https://github.com/cilium/cilium-cli/releases/download/${CILIUM_CLI_VERSION}/cilium-linux-amd64.tar.gz
sudo tar -xzf cilium-linux-amd64.tar.gz -C /usr/local/bin

# Install Cilium with Hubble enabled
cilium install \
  --version 1.15.0 \
  --set hubble.enabled=true \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true \
  --set hubble.metrics.enabled="{dns,drop,tcp,flow,port-distribution,icmp,httpV2}" \
  --set hubble.metrics.serviceMonitor.enabled=true \
  --set prometheus.enabled=true

# Verify Hubble is running
cilium status --wait
cilium hubble port-forward &
hubble status
```

### Hubble CLI Observation

```bash
# Install hubble CLI
export HUBBLE_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/hubble/master/stable.txt)
curl -L --remote-name-all \
  https://github.com/cilium/hubble/releases/download/${HUBBLE_VERSION}/hubble-linux-amd64.tar.gz
sudo tar -xzf hubble-linux-amd64.tar.gz -C /usr/local/bin

# Observe all flows in production namespace
hubble observe \
  --namespace production \
  --follow

# Observe only dropped flows (policy violations)
hubble observe \
  --namespace production \
  --verdict DROPPED \
  --follow

# Filter to specific service communications
hubble observe \
  --from-service production/frontend \
  --to-service production/api-server \
  --protocol TCP \
  --follow

# Observe DNS queries
hubble observe \
  --namespace production \
  --protocol DNS \
  --follow

# JSON output for processing
hubble observe \
  --namespace production \
  --verdict DROPPED \
  --output json \
  | jq 'select(.flow.l4.TCP != null) | {
      src: .flow.source.identity,
      dst: .flow.destination.identity,
      verdict: .flow.verdict,
      reason: .flow.drop_reason_desc
  }'
```

### Hubble Flow Visibility Configuration

```yaml
# cilium-configmap-hubble.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cilium-config
  namespace: kube-system
data:
  # Hubble configuration
  enable-hubble: "true"
  hubble-listen-address: ":4244"
  hubble-socket-path: "/var/run/cilium/hubble.sock"

  # Flow ring buffer size (flows retained in memory per node)
  hubble-flow-buffer-size: "4095"

  # Metrics to export
  hubble-metrics: >
    dns:query;ignoreAAAA,
    drop,
    tcp,
    flow:sourceContext=workload-name|reserved-identity;destinationContext=workload-name|reserved-identity,
    port-distribution,
    icmp,
    httpV2:exemplars=true;labelsContext=source_ip,source_namespace,source_workload,destination_ip,destination_namespace,destination_workload,traffic_direction

  # Enable TLS for Hubble relay
  hubble-tls-cert-file: /var/lib/cilium/tls/hubble/server.crt
  hubble-tls-key-file:  /var/lib/cilium/tls/hubble/server.key
  hubble-tls-client-ca-files: /var/lib/cilium/tls/hubble/client-ca.crt
```

### Hubble Network Policy Compliance Check

```bash
#!/bin/bash
# hubble-policy-audit.sh
# Check for inter-namespace communication that violates zero-trust policy

NAMESPACE="production"
DURATION="5m"

echo "Analyzing network flows for policy compliance in namespace: ${NAMESPACE}"
echo "Time window: last ${DURATION}"
echo ""

# Find all DROPPED flows
DROPPED_FLOWS=$(hubble observe \
  --namespace "${NAMESPACE}" \
  --verdict DROPPED \
  --since "${DURATION}" \
  --output json 2>/dev/null)

DROP_COUNT=$(echo "${DROPPED_FLOWS}" | jq -s 'length')
echo "Total dropped flows: ${DROP_COUNT}"

if [[ "${DROP_COUNT}" -gt 0 ]]; then
  echo ""
  echo "Top drop reasons:"
  echo "${DROPPED_FLOWS}" | \
    jq -r '.flow.drop_reason_desc' | \
    sort | uniq -c | sort -rn | head -10

  echo ""
  echo "Top blocked source/destination pairs:"
  echo "${DROPPED_FLOWS}" | \
    jq -r '"\(.flow.source.namespace)/\(.flow.source.workloads[0].name // "unknown") -> \(.flow.destination.namespace)/\(.flow.destination.workloads[0].name // "unknown")"' | \
    sort | uniq -c | sort -rn | head -10
fi
```

### CiliumNetworkPolicy with Hubble Visibility Labels

```yaml
# production-network-policy.yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: api-server-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: api-server
  ingress:
  # Allow frontend
  - fromEndpoints:
    - matchLabels:
        app: frontend
        k8s:io.kubernetes.pod.namespace: production
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
  # Allow Prometheus scraping
  - fromEndpoints:
    - matchLabels:
        app: prometheus
        k8s:io.kubernetes.pod.namespace: monitoring
    toPorts:
    - ports:
      - port: "9090"
        protocol: TCP
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
      - port: "53"
        protocol: TCP
  # Allow calls to database
  - toEndpoints:
    - matchLabels:
        app: postgresql
        k8s:io.kubernetes.pod.namespace: production
    toPorts:
    - ports:
      - port: "5432"
        protocol: TCP
```

## Section 4: Tetragon Runtime Security Enforcement

Tetragon extends Cilium's eBPF capabilities into the runtime security domain. Unlike detection-only tools, Tetragon can enforce policies at the kernel level, killing processes or blocking system calls before they complete.

### Tetragon Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Linux Kernel                           │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Tetragon eBPF Programs                             │   │
│  │                                                     │   │
│  │  lsm/bpf hooks → file_open, bprm_check_security,   │   │
│  │                   socket_connect, process_fork      │   │
│  │                                                     │   │
│  │  kprobe/tracepoint → execve, open, connect, kill    │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │ events + enforcement decisions
┌─────────────────────────────▼───────────────────────────────┐
│                  Tetragon Agent (DaemonSet)                  │
│                                                             │
│  - Policy evaluation engine                                 │
│  - Event enrichment (k8s metadata)                          │
│  - Export to SIEM/logging                                   │
└─────────────────────────────────────────────────────────────┘
```

### Installing Tetragon

```bash
helm repo add cilium https://helm.cilium.io
helm repo update

helm install tetragon cilium/tetragon \
  --namespace kube-system \
  --set tetragon.enabled=true \
  --set tetragon.exportFilename=/var/log/tetragon/tetragon.log \
  --set tetragonOperator.enabled=true \
  --set serviceMonitor.enabled=true

# Install tetra CLI
TETRA_VERSION="v1.0.0"
curl -sLO "https://github.com/cilium/tetragon/releases/download/${TETRA_VERSION}/tetra-linux-amd64.tar.gz"
sudo tar -xzf tetra-linux-amd64.tar.gz -C /usr/local/bin
```

### TracingPolicy for Process Execution Monitoring

```yaml
# tetragon-exec-policy.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: monitor-exec-in-containers
spec:
  kprobes:
  # Monitor execve syscall
  - call: "sys_execve"
    return: false
    syscall: true
    args:
    - index: 0
      type: "string"
    - index: 1
      type: "string_array"
    selectors:
    # Only capture in production namespace pods
    - matchNamespaces:
      - operator: In
        values:
        - production
      # Alert on suspicious process names
      matchArgs:
      - index: 0
        operator: Postfix
        values:
        - /bash
        - /sh
        - /dash
        - /ncat
        - /nc
        - /netcat
        - /socat
        - /wget
        - /curl
      matchActions:
      - action: Sigkill  # Kill the process immediately
```

### TracingPolicy for File System Monitoring

```yaml
# tetragon-file-policy.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: sensitive-file-access
spec:
  kprobes:
  - call: "security_file_open"
    return: false
    syscall: false
    args:
    - index: 0
      type: "file"
    selectors:
    # Alert on access to sensitive files
    - matchArgs:
      - index: 0
        operator: Prefix
        values:
        - /etc/passwd
        - /etc/shadow
        - /etc/ssh/
        - /proc/
        - /.aws/
        - /.kube/
      matchActions:
      - action: Post  # Generate event (no kill)
    # Block writes to /etc
    - matchArgs:
      - index: 0
        operator: Prefix
        values:
        - /etc/
      matchActions:
      - action: Override
        argError: -1  # Return EPERM
```

### TracingPolicy for Network Connection Monitoring

```yaml
# tetragon-network-policy.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: egress-connection-monitor
spec:
  kprobes:
  - call: "tcp_connect"
    return: false
    syscall: false
    args:
    - index: 0
      type: "sock"
    selectors:
    # Alert on connections to non-standard ports
    - matchNamespaces:
      - operator: In
        values:
        - production
      matchArgs:
      - index: 0
        operator: NotDAddr
        values:
        # Allowed destination CIDR ranges
        - 10.0.0.0/8
        - 172.16.0.0/12
        - 192.168.0.0/16
      matchActions:
      - action: Post
        rateLimit: "1/second"
```

### Observing Tetragon Events

```bash
# Stream all Tetragon events
kubectl exec -n kube-system ds/tetragon -- \
  tetra getevents -o compact

# Filter to specific namespace
kubectl exec -n kube-system ds/tetragon -- \
  tetra getevents \
  --namespace production \
  -o json \
  | jq 'select(.process_exec != null) | {
      time: .time,
      pod: .process_exec.process.pod.name,
      binary: .process_exec.process.binary,
      args: .process_exec.process.arguments,
      uid: .process_exec.process.uid
  }'

# Find kill events (policy enforcement)
kubectl exec -n kube-system ds/tetragon -- \
  tetra getevents \
  -o json \
  | jq 'select(.process_kprobe.action == "KPROBE_ACTION_SIGKILL")'

# Monitor specific process binary
kubectl exec -n kube-system ds/tetragon -- \
  tetra getevents \
  --process /bin/bash \
  --namespace production
```

### Tetragon SIEM Integration

```yaml
# tetragon-export-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: tetragon-config
  namespace: kube-system
data:
  config.yaml: |
    export-filename: /var/log/tetragon/tetragon.log
    export-file-max-size-mb: 10
    export-file-rotation-interval: 24h
    export-file-compress: true

    # Filter out noisy events
    export-allowlist:
    - event_set: ["PROCESS_EXEC", "PROCESS_KPROBE", "PROCESS_TRACEPOINT"]

    export-denylist:
    # Suppress health check processes
    - binary_regex:
      - ".*/coredns$"
      - ".*/kube-proxy$"
      event_set: ["PROCESS_EXEC"]

    # Rate limit to prevent log flooding
    rate-limit: 100

    # Add Kubernetes enrichment
    enable-k8s-api: true
    k8s-kubeconfig-path: ""
```

## Section 5: Perf Maps vs Ring Buffers

The choice of data transport from eBPF programs to user space significantly affects performance at scale.

### Perf Event Array (Legacy)

```
Architecture: Per-CPU ring buffers
Overhead: Higher (requires memory mapping per CPU)
Sampling: Optional
User-space API: epoll on perf fd per CPU

Pros:
- Supported on older kernels (4.3+)
- Per-CPU isolation prevents head-of-line blocking

Cons:
- Complex user-space consumption (poll each CPU separately)
- Memory not shared efficiently across CPUs
- Each CPU allocates its own buffer independently
```

### Ring Buffer (Preferred for Kubernetes 5.8+)

```
Architecture: Single shared ring buffer per map
Overhead: Lower (single mmap, producer-consumer atomic ops)
Sampling: N/A (all events captured or dropped if full)
User-space API: epoll on single ring buffer fd

Pros:
- Simpler user-space consumption
- Better memory utilization
- Atomic reserve/commit for multi-event consistency
- Supports variable-length records natively

Cons:
- Requires kernel 5.8+
- Contention if producers are extremely high-rate
```

### Benchmarking Event Transport

```bash
# On a production node, benchmark eBPF event throughput
# Install bpf_performance_tools
kubectl debug node/worker-1 -it --image=brendangregg/bpftools:latest

# Check current ring buffer utilization
bpftool map show | grep ringbuf

# Monitor drop rate (when ring buffer is full)
bpftool prog trace show | grep -i drop

# Using perf_event_array baseline comparison
cat /sys/kernel/debug/tracing/trace_pipe | head -1000 | wc -l &
# Compare throughput with ring buffer approach
```

## Section 6: Kernel Version Compatibility Matrix

```
Tool         | Min Kernel | Recommended | Key Feature Dependencies
-------------|------------|-------------|---------------------------
Pixie PEM    | 4.14       | 5.10+       | uprobe, kprobe, TLS tracing
Hubble       | 4.9        | 5.10+       | XDP, tc hooks, LPM trie
Tetragon     | 5.3        | 5.15+       | lsm hooks, bpf_for_each_map_elem
CO-RE        | 5.2        | 5.8+        | BTF, libbpf relocation
Ring Buffer  | 5.8        | 5.10+       | BPF_MAP_TYPE_RINGBUF
LSM hooks    | 5.7        | 5.15+       | CAP_BPF, bpf lsm attach
fentry/fexit | 5.5        | 5.10+       | trampolines, BTF-based
```

### Verifying Compatibility Before Deployment

```bash
#!/bin/bash
# check-ebpf-requirements.sh
# Run on each node before deploying eBPF tools

KERNEL_VERSION=$(uname -r)
KERNEL_MAJOR=$(echo "${KERNEL_VERSION}" | cut -d. -f1)
KERNEL_MINOR=$(echo "${KERNEL_VERSION}" | cut -d. -f2)

echo "Kernel version: ${KERNEL_VERSION}"

# Check BTF support
if [[ -f /sys/kernel/btf/vmlinux ]]; then
  echo "BTF: SUPPORTED"
else
  echo "BTF: NOT SUPPORTED - CO-RE will not work"
fi

# Check ring buffer support (5.8+)
if [[ "${KERNEL_MAJOR}" -gt 5 ]] || \
   [[ "${KERNEL_MAJOR}" -eq 5 && "${KERNEL_MINOR}" -ge 8 ]]; then
  echo "Ring Buffer: SUPPORTED"
else
  echo "Ring Buffer: NOT SUPPORTED - will use perf event array"
fi

# Check LSM BPF support (5.7+)
if [[ "${KERNEL_MAJOR}" -gt 5 ]] || \
   [[ "${KERNEL_MAJOR}" -eq 5 && "${KERNEL_MINOR}" -ge 7 ]]; then
  echo "LSM BPF hooks: SUPPORTED"
else
  echo "LSM BPF hooks: NOT SUPPORTED - Tetragon enforcement limited"
fi

# Check bpftool availability
if command -v bpftool &>/dev/null; then
  LOADED_PROGS=$(bpftool prog list 2>/dev/null | grep -c "^[0-9]")
  echo "Loaded eBPF programs: ${LOADED_PROGS}"
fi

# Check CONFIG options
for config in BPF BPF_SYSCALL BPF_JIT BPF_LSM DEBUG_INFO_BTF; do
  if [[ -f /boot/config-${KERNEL_VERSION} ]]; then
    VALUE=$(grep "CONFIG_${config}=" /boot/config-${KERNEL_VERSION} 2>/dev/null || echo "NOT_FOUND")
    echo "CONFIG_${config}: ${VALUE}"
  fi
done
```

## Section 7: Production Deployment Considerations

### Resource Requirements

```yaml
# tetragon-resources.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: tetragon
  namespace: kube-system
spec:
  template:
    spec:
      containers:
      - name: tetragon
        image: quay.io/cilium/tetragon:v1.0.0
        resources:
          requests:
            cpu: "100m"
            memory: "256Mi"
          limits:
            cpu: "500m"
            memory: "512Mi"
        securityContext:
          privileged: true  # Required for eBPF program loading
          capabilities:
            add:
            - SYS_ADMIN
            - NET_ADMIN
            - SYS_PTRACE
            - BPF         # Available on 5.8+
```

### Monitoring eBPF Tool Health

```yaml
# ebpf-observability-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: ebpf-tool-health
  namespace: monitoring
spec:
  groups:
  - name: ebpf.health
    rules:
    - alert: HubbleDroppedFlows
      expr: |
        rate(hubble_drop_total[5m]) > 100
      for: 2m
      labels:
        severity: warning
      annotations:
        summary: "Hubble dropping flows"
        description: "Hubble ring buffer is full, {{ $value }} drops/sec. Increase buffer size."

    - alert: TetragonPolicyViolation
      expr: |
        rate(tetragon_policy_audit_events_total{action="sigkill"}[5m]) > 0
      for: 0m
      labels:
        severity: critical
      annotations:
        summary: "Tetragon killed a process"
        description: "Tetragon policy enforcement killed a process in {{ $labels.namespace }}."

    - alert: PixiePEMHighMemory
      expr: |
        container_memory_working_set_bytes{
          pod=~"vizier-pem-.*",
          container="pem"
        } / 1024 / 1024 / 1024 > 2.5
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Pixie PEM memory usage high"
        description: "PEM on {{ $labels.node }} using {{ $value | humanize }}GB."
```

## Conclusion

eBPF has matured from a niche networking tool into the foundation of production Kubernetes observability and security. The three tools examined here—Pixie, Hubble, and Tetragon—each solve distinct problems that traditional approaches address poorly or not at all.

Pixie eliminates the instrumentation gap: services observed without code changes, protocol decoding happening at the TLS layer before encryption. Hubble provides the network flow visibility that was previously only available from expensive commercial appliances, now running in-kernel on every node. Tetragon closes the detection-to-enforcement gap that plagues agent-based security tools by executing enforcement decisions in the kernel before malicious operations complete.

The operational requirements are modest compared to the observability depth achieved: all three tools require privileged DaemonSets with BPF capabilities, kernel 5.8+ for optimal function, and BTF support. The return on investment—full protocol visibility, sub-millisecond enforcement latency, and zero application changes—makes eBPF-based observability the production standard for Kubernetes environments operating at scale.
