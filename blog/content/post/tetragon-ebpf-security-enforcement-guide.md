---
title: "Tetragon: eBPF-Based Security Enforcement in Kubernetes"
date: 2027-10-02T00:00:00-05:00
draft: false
tags: ["Tetragon", "eBPF", "Security", "Kubernetes", "Cilium"]
categories:
- Security
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Tetragon eBPF security enforcement for Kubernetes — TracingPolicy CRDs, process execution controls, network enforcement, file access monitoring, kill and override actions, Cilium integration, SIEM export, and performance analysis."
more_link: "yes"
url: "/tetragon-ebpf-security-enforcement-guide/"
---

Tetragon moves security enforcement from userspace (where attackers can hide) into the Linux kernel via eBPF. Unlike Falco, which observes and alerts, Tetragon can enforce — it can kill processes, block network connections, and override system calls before they complete. This makes Tetragon a proactive security layer rather than a reactive one. This guide covers Tetragon's TracingPolicy CRD design, enforcement actions, integration with Cilium for combined network and runtime security, structured JSON event export for SIEM platforms, and a honest performance impact analysis compared to userspace alternatives.

<!--more-->

# Tetragon: eBPF-Based Security Enforcement in Kubernetes

## Section 1: Tetragon vs Falco — Architectural Comparison

Both Tetragon and Falco use eBPF to observe kernel events, but their enforcement models differ fundamentally.

### Capability Comparison

```
Feature                    Tetragon          Falco
──────────────────────────────────────────────────────
Observation                Yes               Yes
Process kill/override      Yes (in-kernel)   No (external)
Network blocking           Yes (in-kernel)   No
File access prevention     Yes               No
Alert latency              Microseconds      Milliseconds
Custom policy format       TracingPolicy CRD YAML rules
Enforcement model          eBPF return codes Alerts only
K8s-native integration     Full              Partial
Performance overhead       ~1-3% CPU         ~2-5% CPU
SIEM export                JSON gRPC stream  Multiple outputs
```

### Tetragon Architecture

```
┌──────────────────────────────────────────────────────┐
│                  Linux Kernel                         │
│                                                       │
│  kprobes → eBPF Programs → Actions (kill/override)   │
│  ├── sys_execve          ├── SIGKILL process          │
│  ├── sys_connect         ├── OVERRIDE return code     │
│  ├── sys_open            ├── Follow subprocess tree   │
│  └── capabilities        └── Generate audit event     │
└──────────────────────────────┬───────────────────────┘
                               │ gRPC event stream
┌──────────────────────────────▼───────────────────────┐
│             Tetragon Agent (DaemonSet)                │
│  Policy Engine → Event Enrichment → Export            │
│  ├── TracingPolicy evaluation                         │
│  ├── K8s metadata enrichment (pod, ns, labels)        │
│  └── gRPC/JSON export to Sidekick/SIEM               │
└──────────────────────────────────────────────────────┘
```

## Section 2: Installing Tetragon

### Helm Installation

```bash
helm repo add cilium https://helm.cilium.io
helm repo update

helm upgrade --install tetragon cilium/tetragon \
  --namespace kube-system \
  --set tetragon.enableProcessCred=true \
  --set tetragon.enableProcessNs=true \
  --set tetragon.enableK8sAPI=true \
  --set exportFilename=/var/run/cilium/tetragon/tetragon.log \
  --set serviceMonitor.enabled=true \
  --version 1.2.0 \
  --wait
```

### Verify Installation

```bash
# Check Tetragon DaemonSet
kubectl get pods -n kube-system -l app.kubernetes.io/name=tetragon

# Install tetra CLI
GOOS=$(uname -s | tr '[:upper:]' '[:lower:]')
GOARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
curl -Lo tetra.tar.gz \
  "https://github.com/cilium/tetragon/releases/download/v1.2.0/tetra-${GOOS}-${GOARCH}.tar.gz"
tar xzf tetra.tar.gz
sudo mv tetra /usr/local/bin/

# Stream live events
kubectl exec -n kube-system \
  $(kubectl get pods -n kube-system -l app.kubernetes.io/name=tetragon -o jsonpath='{.items[0].metadata.name}') \
  -- tetra getevents | head -20
```

## Section 3: TracingPolicy CRD Design

TracingPolicy is Tetragon's policy language. Each policy attaches eBPF programs to kernel functions (kprobes/tracepoints) and defines selectors to match events and actions to take.

### Policy Structure

```yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: policy-name
spec:
  kprobes:
    - call: "kernel_function_name"      # Kernel function to hook
      syscall: true                     # Is this a syscall?
      return: false                     # Hook on return?
      args:                             # Arguments to capture
        - index: 0
          type: "int"
      selectors:                        # Match conditions
        - matchArgs:
            - index: 0
              operator: "Equal"
              values:
                - "value"
          matchActions:
            - action: Sigkill           # SIGKILL the process
```

### Available Actions

```yaml
# Action types in TracingPolicy
actions:
  - action: Sigkill        # Send SIGKILL to the process
  - action: Signal         # Send configurable signal
    argSig: 15             # Signal number (15 = SIGTERM)
  - action: Override       # Override syscall return value
    argError: -1           # Error code to return (e.g., -EPERM = -1)
  - action: FollowFD       # Track file descriptor across syscalls
    argFd: 0               # FD argument index
    argName: 1             # Name argument index
  - action: UnfollowFD     # Stop tracking file descriptor
  - action: CopyFD         # Duplicate tracked FD
  - action: Post           # Generate an event (default)
  - action: GetUrl         # HTTP callback (for external enforcement)
    argUrl: "http://enforcer/decide"
  - action: DnsLookup      # Perform DNS lookup and attach result
    argFqdn: 0
  - action: NoPost         # Suppress the event (whitelist)
```

## Section 4: Process Execution Control

### Block Execution of Specific Binaries

```yaml
# tetragon-block-exec.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: block-dangerous-binaries
  namespace: ""  # Cluster-scoped
spec:
  kprobes:
    - call: "sys_execve"
      syscall: true
      args:
        - index: 0
          type: "string"
      selectors:
        # Block netcat in production namespaces
        - matchArgs:
            - index: 0
              operator: "Postfix"
              values:
                - "/nc"
                - "/netcat"
                - "/ncat"
          matchNamespaces:
            - namespace: Kube
              operator: In
              values:
                - payments
                - orders
                - checkout
                - api-gateway
          matchActions:
            - action: Sigkill
        # Block package managers in production
        - matchArgs:
            - index: 0
              operator: "Postfix"
              values:
                - "/apt"
                - "/apt-get"
                - "/yum"
                - "/dnf"
                - "/apk"
          matchNamespaces:
            - namespace: Kube
              operator: In
              values:
                - payments
                - orders
                - checkout
          matchActions:
            - action: Sigkill
        # Kill crypto miners anywhere
        - matchArgs:
            - index: 0
              operator: "Postfix"
              values:
                - "/xmrig"
                - "/minerd"
                - "/cpuminer"
          matchActions:
            - action: Sigkill
```

### Audit Privileged Binary Execution

```yaml
# tetragon-audit-setuid.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: audit-privileged-execution
spec:
  kprobes:
    - call: "sys_execve"
      syscall: true
      args:
        - index: 0
          type: "string"
      selectors:
        # Log execution from privileged containers only
        - matchCapabilities:
            - operator: In
              isNamespaceCapability: false
              values:
                - "CAP_SYS_ADMIN"
                - "CAP_SYS_PTRACE"
                - "CAP_NET_ADMIN"
          matchActions:
            - action: Post
        # Kill ptrace from non-debugger pods
        - matchArgs:
            - index: 0
              operator: "Postfix"
              values:
                - "/strace"
                - "/ltrace"
                - "/gdb"
          matchNamespaces:
            - namespace: Kube
              operator: NotIn
              values:
                - debugging
                - monitoring
          matchActions:
            - action: Sigkill
```

### Detect Reverse Shell Execution

```yaml
# tetragon-reverse-shell.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: detect-reverse-shell
spec:
  kprobes:
    - call: "sys_execve"
      syscall: true
      args:
        - index: 0
          type: "string"
        - index: 1
          type: "string_array"
      selectors:
        # bash/sh with network redirection
        - matchArgs:
            - index: 0
              operator: "Postfix"
              values:
                - "/bash"
                - "/sh"
                - "/zsh"
          matchActions:
            - action: Post
        # Any shell spawned from network daemon
        - matchPids:
            - operator: NotIn
              followForks: true
              isNamespacePID: false
              values:
                - 1  # Init — shells not spawned by PID 1 in containers are suspicious
          matchArgs:
            - index: 0
              operator: "Postfix"
              values:
                - "/bash"
                - "/sh"
          matchActions:
            - action: Post  # Alert, don't kill — needs tuning before enforcement
```

## Section 5: Network Policy Enforcement at Kernel Level

### Block Outbound Connections to Specific Ports

```yaml
# tetragon-network-enforcement.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: network-enforcement-production
spec:
  kprobes:
    - call: "tcp_connect"
      syscall: false
      args:
        - index: 0
          type: "sock"
      selectors:
        # Block connections to metadata service from non-system pods
        - matchArgs:
            - index: 0
              operator: "DAddr"
              values:
                - "169.254.169.254/32"  # AWS/GCP metadata service
          matchNamespaces:
            - namespace: Kube
              operator: NotIn
              values:
                - kube-system
                - monitoring
                - cert-manager
          matchActions:
            - action: Override
              argError: -111  # ECONNREFUSED
        # Kill connections to known C2 ports from production
        - matchArgs:
            - index: 0
              operator: "DPort"
              values:
                - "4444"  # Common Metasploit listener
                - "1234"  # Common backdoor port
                - "31337" # Classic hacker port
          matchActions:
            - action: Sigkill
```

### Monitor All Outbound Connections

```yaml
# tetragon-network-audit.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: audit-outbound-connections
spec:
  kprobes:
    - call: "sys_connect"
      syscall: true
      args:
        - index: 0
          type: "int"
        - index: 1
          type: "sockaddr"
      selectors:
        - matchNamespaces:
            - namespace: Kube
              operator: In
              values:
                - payments
                - orders
                - checkout
          matchActions:
            - action: Post
```

## Section 6: File Access Control

### Protect Sensitive Files

```yaml
# tetragon-file-protection.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: protect-sensitive-files
spec:
  kprobes:
    # Monitor writes to /etc
    - call: "sys_openat"
      syscall: true
      args:
        - index: 0
          type: "int"
        - index: 1
          type: "string"
        - index: 2
          type: "int"
      selectors:
        # Block writes to /etc from containers
        - matchArgs:
            - index: 1
              operator: "Prefix"
              values:
                - "/etc/passwd"
                - "/etc/shadow"
                - "/etc/sudoers"
                - "/etc/crontab"
                - "/etc/cron.d"
                - "/root/.ssh"
                - "/home/ubuntu/.ssh"
            - index: 2
              operator: "Mask"
              values:
                - "2"  # O_WRONLY
                - "1026"  # O_WRONLY|O_CREAT
          matchActions:
            - action: Override
              argError: -13  # EACCES

    # Monitor reads of secrets from containers
    - call: "sys_openat"
      syscall: true
      args:
        - index: 1
          type: "string"
      selectors:
        - matchArgs:
            - index: 1
              operator: "Prefix"
              values:
                - "/var/run/secrets/kubernetes.io/serviceaccount/token"
                - "/proc/1/environ"
                - "/proc/1/cmdline"
          matchNamespaces:
            - namespace: Kube
              operator: NotIn
              values:
                - kube-system
                - monitoring
          matchActions:
            - action: Post

    # Detect writes to /tmp followed by execution
    - call: "sys_openat"
      syscall: true
      args:
        - index: 1
          type: "string"
        - index: 2
          type: "int"
      selectors:
        - matchArgs:
            - index: 1
              operator: "Prefix"
              values:
                - "/tmp/"
            - index: 2
              operator: "Mask"
              values:
                - "65"  # O_WRONLY|O_CREAT — write new file to /tmp
          matchActions:
            - action: Post
```

## Section 7: Capability Monitoring and Enforcement

```yaml
# tetragon-capability-policy.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: capability-monitoring
spec:
  kprobes:
    # Monitor capability checks — catches privilege escalation attempts
    - call: "cap_capable"
      syscall: false
      args:
        - index: 0
          type: "int"  # user namespace
        - index: 1
          type: "int"  # capability number
        - index: 2
          type: "int"  # options
      return: true
      returnArg:
        index: 0
        type: "int"
      selectors:
        # Alert when CAP_SYS_ADMIN is requested
        - matchArgs:
            - index: 1
              operator: "Equal"
              values:
                - "21"  # CAP_SYS_ADMIN
          matchNamespaces:
            - namespace: Kube
              operator: In
              values:
                - payments
                - orders
          matchActions:
            - action: Post

    # Kill processes that try to use SYS_PTRACE against other processes
    - call: "sys_ptrace"
      syscall: true
      args:
        - index: 0
          type: "int"  # request type
      selectors:
        - matchArgs:
            - index: 0
              operator: "Equal"
              values:
                - "16"  # PTRACE_ATTACH
          matchNamespaces:
            - namespace: Kube
              operator: NotIn
              values:
                - debugging
                - monitoring
          matchActions:
            - action: Sigkill
```

## Section 8: Integration with Cilium

When Tetragon runs alongside Cilium, both tools share the same agent and can coordinate network and runtime policies.

### Joint Network + Runtime Enforcement

```yaml
# cilium-network-policy-plus-tetragon.yaml
# Cilium L7 policy: only allow GET/POST to /api
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: payment-service-l7
  namespace: payments
spec:
  endpointSelector:
    matchLabels:
      app: payment-service
  ingress:
    - fromEndpoints:
        - matchLabels:
            app: api-gateway
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              - method: GET
                path: /api/v1/.*
              - method: POST
                path: /api/v1/payments
              - method: GET
                path: /health
---
# Tetragon monitors runtime behavior of allowed endpoints
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: payment-service-runtime
  namespace: payments
spec:
  podSelector:
    matchLabels:
      app: payment-service
  kprobes:
    - call: "sys_execve"
      syscall: true
      args:
        - index: 0
          type: "string"
      selectors:
        # Only allow the payment service binary and essential tools
        - matchArgs:
            - index: 0
              operator: "NotPostfix"
              values:
                - "/payment-service"
                - "/sh"
                - "/bash"
          matchActions:
            - action: Sigkill
```

### Hubble Integration for Network Visibility

```bash
# View network flows enriched with process information
kubectl exec -n kube-system \
  $(kubectl get pods -n kube-system -l k8s-app=hubble-relay -o jsonpath='{.items[0].metadata.name}') \
  -- hubble observe \
    --namespace payments \
    --output json | \
  python3 -c "
import json, sys
for line in sys.stdin:
    try:
        flow = json.loads(line)
        src = flow.get('source', {})
        dst = flow.get('destination', {})
        verdict = flow.get('verdict', 'UNKNOWN')
        print(f\"{verdict}: {src.get('namespace','?')}/{src.get('pod_name','?')} -> {dst.get('namespace','?')}/{dst.get('pod_name','?')}\")
    except json.JSONDecodeError:
        pass
"
```

## Section 9: Export to SIEM

Tetragon exports structured JSON events via gRPC and stdout. Tetragon Sidekick or direct log collection routes events to SIEM platforms.

### Event Structure

```json
{
  "process_exec": {
    "process": {
      "exec_id": "aHR0cHM6Ly9leGFtcGxlLmNvbQo=",
      "pid": 12345,
      "uid": 0,
      "cwd": "/",
      "binary": "/usr/bin/bash",
      "arguments": "-c echo malicious",
      "flags": "execve",
      "start_time": "2027-10-02T14:32:00.000Z",
      "auid": 4294967295,
      "pod": {
        "namespace": "payments",
        "name": "payment-service-abc123",
        "labels": {
          "app": "payment-service",
          "team": "payments-team"
        },
        "container": {
          "id": "containerd://abc123",
          "name": "payment-service",
          "image": {
            "id": "sha256:abc123",
            "name": "registry.acme.internal/payment-service:1.2.3"
          },
          "start_time": "2027-10-02T12:00:00.000Z",
          "pid": 1
        }
      },
      "docker": "abc123def456",
      "parent_exec_id": "aHR0cHM6Ly9leGFtcGxlLmNvbQo=",
      "capabilities": {
        "permitted": ["CAP_NET_BIND_SERVICE"],
        "effective": ["CAP_NET_BIND_SERVICE"]
      }
    }
  },
  "time": "2027-10-02T14:32:00.000Z",
  "node_name": "k8s-node-01",
  "cluster_name": "production"
}
```

### Fluentd Configuration for Tetragon Events

```yaml
# tetragon-fluentd-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: tetragon-fluentd-config
  namespace: logging
data:
  fluent.conf: |
    <source>
      @type tail
      path /var/run/cilium/tetragon/tetragon.log
      pos_file /var/log/tetragon.pos
      tag tetragon
      read_from_head false
      <parse>
        @type json
        time_key time
        time_format %Y-%m-%dT%H:%M:%S.%NZ
      </parse>
    </source>

    <filter tetragon>
      @type record_transformer
      enable_ruby true
      <record>
        source tetragon
        cluster_name production
        environment production
        # Extract key fields for indexing
        event_type ${record.dig('process_exec') ? 'exec' : record.dig('process_kprobe') ? 'kprobe' : record.dig('process_exit') ? 'exit' : 'unknown'}
        pod_name ${record.dig('process_exec', 'process', 'pod', 'name') || record.dig('process_kprobe', 'process', 'pod', 'name') || 'unknown'}
        namespace ${record.dig('process_exec', 'process', 'pod', 'namespace') || record.dig('process_kprobe', 'process', 'pod', 'namespace') || 'unknown'}
        binary ${record.dig('process_exec', 'process', 'binary') || record.dig('process_kprobe', 'process', 'binary') || 'unknown'}
      </record>
    </filter>

    <match tetragon>
      @type elasticsearch
      host elasticsearch-master.logging.svc.cluster.local
      port 9200
      index_name tetragon
      type_name _doc
      include_timestamp true
      logstash_format true
      logstash_prefix tetragon
      <buffer>
        @type memory
        flush_interval 5s
        chunk_limit_size 32MB
        queue_limit_length 256
        overflow_action block
      </buffer>
    </match>
```

### tetra CLI for Real-Time Monitoring

```bash
# Monitor all exec events with JSON output
kubectl exec -n kube-system \
  $(kubectl get pods -n kube-system -l app.kubernetes.io/name=tetragon -o jsonpath='{.items[0].metadata.name}') \
  -- tetra getevents -o json \
  --namespace payments \
  --event-types PROCESS_EXEC | \
  python3 -c "
import json, sys, datetime
for line in sys.stdin:
    try:
        event = json.loads(line)
        proc = event.get('process_exec', {}).get('process', {})
        if not proc:
            continue
        ts = event.get('time', '')[:19]
        pid = proc.get('pid', '?')
        binary = proc.get('binary', '?')
        args = proc.get('arguments', '')[:80]
        pod = proc.get('pod', {}).get('name', 'host')
        ns = proc.get('pod', {}).get('namespace', 'host')
        print(f'{ts} [{ns}/{pod}] pid={pid} {binary} {args}')
    except json.JSONDecodeError:
        pass
"
```

## Section 10: Performance Impact Analysis

### Benchmark Setup

```bash
#!/bin/bash
# tetragon-perf-benchmark.sh
# Measure CPU overhead of Tetragon with various policy counts

BENCHMARK_NS="perf-test"
kubectl create ns "${BENCHMARK_NS}" 2>/dev/null || true

# Deploy stress test workload
kubectl run stress-test \
  --image=progrium/stress:latest \
  --namespace="${BENCHMARK_NS}" \
  --restart=Never \
  -- --cpu 4 --io 4 --vm 2 --vm-bytes 512M --timeout 120s &

# Baseline CPU usage without policies
echo "=== Baseline CPU (no Tetragon policies) ==="
sleep 5
kubectl top pods -n kube-system | grep tetragon
kubectl top nodes

# Apply 5 TracingPolicies
for i in $(seq 1 5); do
kubectl apply -f - <<EOF
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: perf-test-policy-${i}
spec:
  kprobes:
    - call: "sys_openat"
      syscall: true
      args:
        - index: 1
          type: "string"
      selectors:
        - matchNamespaces:
            - namespace: Kube
              operator: In
              values:
                - "${BENCHMARK_NS}"
          matchActions:
            - action: Post
EOF
done

echo "=== CPU with 5 policies ==="
sleep 10
kubectl top pods -n kube-system | grep tetragon
kubectl top nodes

# Cleanup
for i in $(seq 1 5); do
  kubectl delete tracingpolicy "perf-test-policy-${i}" 2>/dev/null || true
done
kubectl delete ns "${BENCHMARK_NS}" 2>/dev/null || true
```

### Expected Performance Profile

```
Policy Count    Additional CPU    Memory      Event Rate
────────────────────────────────────────────────────────
0 (disabled)    0%                50Mi        0
5 policies      1-2%              80Mi        5k events/s
20 policies     3-5%              120Mi       15k events/s
50 policies     5-10%             200Mi       30k events/s
100 policies    10-20%            350Mi       50k events/s

Notes:
- Overhead scales with event frequency, not policy count
- Kill actions add ~50μs per killed process
- Override actions add ~5μs per syscall
- Recommendation: < 20 active policies per node for < 5% overhead
```

### Optimizing Policy Performance

```yaml
# Use matchNamespaces to reduce events processed
selectors:
  - matchNamespaces:
      - namespace: Kube
        operator: In
        values:
          - production-only-namespace
  # Use matchBinaries to filter early
  - matchBinaries:
      - operator: In
        values:
          - "/bin/bash"
          - "/usr/bin/python3"
  # Avoid broad "Post" actions on high-frequency syscalls
  # sys_read, sys_write, sys_poll — very high frequency, avoid hooking
  # sys_execve, sys_connect, sys_openat — moderate frequency, safe to hook
```

## Section 11: Production Policy Lifecycle

### GitOps Policy Management

```yaml
# argocd-tetragon-policies.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: tetragon-policies
  namespace: argocd
spec:
  project: security
  source:
    repoURL: https://github.com/acme-org/security-policies.git
    targetRevision: main
    path: tetragon/
  destination:
    server: https://kubernetes.default.svc
    namespace: kube-system
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=false
      - PrunePropagationPolicy=foreground
```

### Policy Testing in Staging

```bash
#!/bin/bash
# test-tetragon-policy.sh
set -euo pipefail

POLICY_FILE="${1}"
TEST_NS="policy-test-$(date +%s)"

echo "Testing policy: ${POLICY_FILE}"

# Create test namespace
kubectl create ns "${TEST_NS}"

# Apply policy with namespace restriction
sed "s/production/${TEST_NS}/g" "${POLICY_FILE}" | kubectl apply -f -

# Run test commands
echo "Test: binary execution that should be blocked"
kubectl run test-pod --image=alpine:3.19 --restart=Never \
  --namespace="${TEST_NS}" \
  -- /bin/sh -c "apk update 2>&1; echo exitcode=$?" || true

kubectl logs -n "${TEST_NS}" test-pod --tail=5

# Check tetragon events for the test namespace
kubectl exec -n kube-system \
  $(kubectl get pods -n kube-system -l app.kubernetes.io/name=tetragon -o jsonpath='{.items[0].metadata.name}') \
  -- tetra getevents -o json \
  --namespace "${TEST_NS}" | head -20

# Cleanup
kubectl delete ns "${TEST_NS}"
sed "s/production/${TEST_NS}/g" "${POLICY_FILE}" | kubectl delete -f - 2>/dev/null || true
echo "Policy test complete"
```

## Summary

Tetragon's kernel-level enforcement closes a critical gap in the Kubernetes security stack. While admission controllers prevent non-compliant workloads from being scheduled and Falco detects suspicious runtime behavior, Tetragon actively prevents the harmful actions themselves — killing processes before they complete, overriding system call return codes to deny access, and blocking network connections at the kernel before a single packet leaves the node.

The performance overhead is real but manageable: limit active TracingPolicies to fewer than 20 per node, avoid hooking high-frequency syscalls like `sys_read` and `sys_write`, and use `matchNamespaces` selectors to reduce the volume of events processed. For production hardening, start with audit-only (`Post` action) policies for two weeks before enabling `Sigkill` enforcement to tune false positives without impacting workloads.
