---
title: "eBPF for Security: Tetragon Runtime Enforcement and Policy"
date: 2029-01-15T00:00:00-05:00
draft: false
tags: ["eBPF", "Tetragon", "Kubernetes", "Security", "Runtime Security", "Cilium", "SIGKILL"]
categories:
- Security
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "An enterprise guide to Cilium Tetragon for eBPF-based runtime security enforcement in Kubernetes, covering TracingPolicy design, process execution controls, network enforcement, file system protection, and SIGKILL termination policies."
more_link: "yes"
url: "/ebpf-tetragon-runtime-security-enforcement/"
---

Cilium Tetragon provides kernel-level security observability and enforcement using eBPF programs that attach directly to Linux kernel functions. Unlike user-space security solutions that intercept system calls via ptrace or LD_PRELOAD, Tetragon operates inside the kernel with nanosecond-scale overhead, making it both more performant and harder to evade than traditional runtime security tools. This guide covers Tetragon's `TracingPolicy` CRD for defining security rules, enforcement modes, and production deployment patterns for enterprise Kubernetes security operations.

<!--more-->

## Tetragon Architecture

Tetragon consists of:

1. **tetragon daemon**: A DaemonSet pod that loads eBPF programs into the kernel and forwards events to userspace.
2. **TracingPolicy CRD**: Kubernetes objects that define which kernel events to observe and what actions to take.
3. **tetra CLI**: Command-line tool for querying events and managing policies.

Tetragon attaches eBPF programs to `kprobes`, `kretprobes`, `tracepoints`, and `LSM hooks`. This gives it visibility into every process execution, file open, network connection, and capability check — with the ability to terminate processes before they complete malicious operations.

### Enforcement vs. Observation

Tetragon supports three action modes:

- **Observe**: Record events and emit them as JSON; no enforcement
- **Override**: Modify return values (e.g., return EPERM for file opens)
- **Sigkill**: Send SIGKILL to the offending process immediately

## Installation

```bash
# Install Tetragon via Helm
helm repo add cilium https://helm.cilium.io
helm repo update

helm install tetragon cilium/tetragon \
  --namespace kube-system \
  --version 1.3.0 \
  --set tetragon.exportAllowList="{\"health_check\":true}" \
  --set tetragon.grpc.address="localhost:54321" \
  --set tetragon.btf="" \
  --set tetragon.enablePolicyFilter=true \
  --set tetragon.enablePolicyFilterDebug=false \
  --set tetragon.enableMsgHandlingLatency=true \
  --set export.stdout.enabledFields='{process_exec,process_exit,process_kprobe,process_tracing}' \
  --set daemonSetAnnotations."prometheus\.io/scrape"=true \
  --set daemonSetAnnotations."prometheus\.io/port"="2112"

# Verify installation
kubectl get pods -n kube-system -l app.kubernetes.io/name=tetragon
kubectl rollout status daemonset/tetragon -n kube-system

# Install tetra CLI
TETRAGON_VERSION=1.3.0
curl -Lo tetra https://github.com/cilium/tetragon/releases/download/v${TETRAGON_VERSION}/tetra-linux-amd64
chmod +x tetra
mv tetra /usr/local/bin/

# Stream events from all pods
kubectl exec -n kube-system ds/tetragon -- tetra getevents -o compact
```

## TracingPolicy: Core Policy Building Block

`TracingPolicy` is the primary Tetragon CRD. Each policy defines `kprobes`, `tracepoints`, or `uprobe` hooks with matching conditions and actions.

### Basic Structure

```yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: example-policy
spec:
  kprobes:
    - call: "sys_execve"          # Kernel function to hook
      syscall: true               # Is this a syscall?
      return: false               # Hook the return path?
      args:                       # Arguments to capture
        - index: 0
          type: "string"
      selectors:                  # Match conditions
        - matchNamespaces:
            - operator: In
              values: ["production"]
          matchArgs:
            - index: 0
              operator: NotEqual
              values: ["/bin/true"]
      actions:                    # What to do on match
        - action: Sigkill
```

## Process Execution Policies

### Block Execution of Unauthorized Binaries

```yaml
# tracingpolicies/block-shell-execution.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: block-shell-in-containers
  annotations:
    description: "Terminate any process that exec's a shell in production containers"
spec:
  kprobes:
    - call: "sys_execve"
      syscall: true
      args:
        - index: 0
          type: "string"    # argv[0]: the binary being executed
      selectors:
        - matchNamespaces:
            - operator: In
              values:
                - production
                - payments
                - identity
          matchArgs:
            - index: 0
              operator: In
              values:
                - "/bin/sh"
                - "/bin/bash"
                - "/bin/dash"
                - "/bin/zsh"
                - "/usr/bin/sh"
                - "/usr/bin/bash"
                - "/usr/bin/python3"
                - "/usr/bin/python"
                - "/usr/bin/perl"
                - "/usr/bin/ruby"
          matchCapabilities:
            - type: Effective
              operator: NotIn
              values: ["CAP_SYS_ADMIN"]    # Allow only if CAP_SYS_ADMIN (init containers)
          actions:
            - action: Sigkill
            - action: Post
              rateLimit: "1/minute"        # Log at most once per minute
```

### Audit All Process Executions

```yaml
# tracingpolicies/audit-process-exec.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: audit-process-executions
spec:
  kprobes:
    - call: "sys_execve"
      syscall: true
      args:
        - index: 0
          type: "string"    # Binary path
        - index: 1
          type: "string_array"  # Arguments
      selectors:
        - matchNamespaces:
            - operator: In
              values: ["production", "staging"]
          actions:
            - action: Post  # Emit event (observe mode)
              rateLimit: "100/minute"
```

### Prevent Privilege Escalation via SUID Binaries

```yaml
# tracingpolicies/block-suid-exec.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: block-setuid-execution
  annotations:
    description: "Block execution of setuid binaries in containers"
spec:
  kprobes:
    - call: "security_bprm_creds_from_file"
      syscall: false
      return: false
      args:
        - index: 0
          type: "linux_binprm"
      selectors:
        - matchNamespaces:
            - operator: NotIn
              values: ["kube-system"]
          matchArgs:
            - index: 0
              operator: Equal
              values: ["setuid"]    # Match files with setuid bit
          actions:
            - action: Override
              argError: -1          # Return -EPERM
            - action: Post
```

## Network Connection Policies

### Block Outbound Connections to Specific Hosts

```yaml
# tracingpolicies/block-egress-metadata.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: block-cloud-metadata-access
  annotations:
    description: "Block access to cloud instance metadata service from containers"
spec:
  kprobes:
    - call: "tcp_connect"
      syscall: false
      args:
        - index: 0
          type: "sock"
      selectors:
        - matchNamespaces:
            - operator: In
              values: ["production", "staging", "development"]
          matchArgs:
            - index: 0
              operator: Equal
              values: ["169.254.169.254/32"]   # AWS/GCP metadata endpoint
          matchCapabilities:
            - type: Effective
              operator: NotIn
              values: ["CAP_SYS_ADMIN"]
          actions:
            - action: Override
              argError: -110    # Return ETIMEDOUT
            - action: Post
              rateLimit: "10/minute"
```

### Detect Reverse Shell Connections

```yaml
# tracingpolicies/detect-reverse-shell.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: detect-reverse-shell
  annotations:
    description: "Detect processes that connect outbound and dup2 to stdin/stdout (reverse shell pattern)"
spec:
  kprobes:
    - call: "sys_dup2"
      syscall: true
      args:
        - index: 0
          type: "int"    # oldfd (socket descriptor)
        - index: 1
          type: "int"    # newfd (0=stdin, 1=stdout, 2=stderr)
      selectors:
        - matchNamespaces:
            - operator: In
              values: ["production"]
          matchArgs:
            - index: 1
              operator: In
              values: ["0", "1", "2"]     # Duplicating over stdin/stdout/stderr
          matchProcessParentNames:
            - operator: In
              values: ["/bin/sh", "/bin/bash"]  # Parent is a shell
          actions:
            - action: Sigkill
            - action: Post
```

## File System Protection Policies

### Protect Sensitive Configuration Files

```yaml
# tracingpolicies/protect-sensitive-files.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: protect-sensitive-file-writes
  annotations:
    description: "Block writes to sensitive paths in production containers"
spec:
  kprobes:
    - call: "sys_openat"
      syscall: true
      args:
        - index: 0
          type: "int"      # dirfd
        - index: 1
          type: "string"   # pathname
        - index: 2
          type: "int"      # flags
      selectors:
        - matchNamespaces:
            - operator: In
              values: ["production"]
          matchArgs:
            - index: 1
              operator: Prefix
              values:
                - "/etc/passwd"
                - "/etc/shadow"
                - "/etc/sudoers"
                - "/etc/cron"
                - "/var/spool/cron"
                - "/root/.ssh"
                - "/home/"
            - index: 2
              operator: Mask
              values: ["O_WRONLY", "O_RDWR", "O_CREAT", "O_TRUNC"]
          actions:
            - action: Override
              argError: -13    # Return EACCES
            - action: Post
              rateLimit: "5/minute"
```

### Container Escape Attempt Detection

```yaml
# tracingpolicies/detect-container-escape.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: detect-container-escape-attempts
spec:
  kprobes:
    # Detect namespace switching (common container escape technique)
    - call: "sys_setns"
      syscall: true
      args:
        - index: 0
          type: "int"    # fd (namespace file descriptor)
        - index: 1
          type: "int"    # nstype
      selectors:
        - matchNamespaces:
            - operator: In
              values: ["production", "payments"]
          matchCapabilities:
            - type: Effective
              operator: NotIn
              values: ["CAP_SYS_ADMIN"]
          actions:
            - action: Override
              argError: -1
            - action: Post
    # Detect /proc/1/root traversal (host filesystem access)
    - call: "sys_openat"
      syscall: true
      args:
        - index: 1
          type: "string"
      selectors:
        - matchArgs:
            - index: 1
              operator: Prefix
              values:
                - "/proc/1/root"
                - "/proc/1/ns"
          actions:
            - action: Override
              argError: -13
            - action: Post
```

## Namespace-Scoped vs. Cluster-Wide Policies

```yaml
# Cluster-wide policy applies to all namespaces
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: global-exec-audit
spec:
  # No matchNamespaces selector = cluster-wide
  kprobes:
    - call: "sys_execve"
      syscall: true
      args:
        - index: 0
          type: "string"
      selectors:
        - actions:
            - action: Post
              rateLimit: "1000/second"
---
# Namespace-scoped policy (TracingPolicyNamespaced)
apiVersion: cilium.io/v1alpha1
kind: TracingPolicyNamespaced
metadata:
  name: payment-strict-enforcement
  namespace: payments
spec:
  kprobes:
    - call: "sys_execve"
      syscall: true
      args:
        - index: 0
          type: "string"
      selectors:
        - matchArgs:
            - index: 0
              operator: NotIn
              values:
                - "/app/payment-server"
                - "/usr/local/bin/grpc_health_probe"
                - "/pause"
          actions:
            - action: Sigkill
```

## Observability: Consuming Tetragon Events

### Structured JSON Event Format

```bash
# Stream events with filtering
kubectl exec -n kube-system ds/tetragon -- \
  tetra getevents \
  --namespace production \
  --output json | \
  jq 'select(.process_exec != null) |
  {
    time: .time,
    pod: .process_exec.process.pod.name,
    binary: .process_exec.process.binary,
    args: .process_exec.process.arguments,
    uid: .process_exec.process.uid,
    tid: .process_exec.process.tid
  }'

# Filter for SIGKILL events only
kubectl exec -n kube-system ds/tetragon -- \
  tetra getevents -o json | \
  jq 'select(.process_kprobe != null and .process_kprobe.action == "KPROBE_ACTION_SIGKILL") |
  {
    time: .time,
    pod: .process_kprobe.process.pod.name,
    namespace: .process_kprobe.process.pod.namespace,
    binary: .process_kprobe.process.binary,
    policy: .process_kprobe.policy_name,
    function: .process_kprobe.function_name
  }'
```

### Forwarding Events to SIEM

```yaml
# tetragon-fluent-bit ConfigMap for SIEM forwarding
apiVersion: v1
kind: ConfigMap
metadata:
  name: tetragon-fluent-bit-config
  namespace: kube-system
data:
  fluent-bit.conf: |
    [SERVICE]
        Flush         5
        Log_Level     info
        Daemon        off
        Parsers_File  parsers.conf

    [INPUT]
        Name          tail
        Path          /var/run/cilium/tetragon/tetragon.log
        Tag           tetragon
        Parser        json
        Refresh_Interval  5

    [FILTER]
        Name          grep
        Match         tetragon
        Regex         process_kprobe .+

    [OUTPUT]
        Name          splunk
        Match         tetragon
        Host          splunk-hec.corp.example.com
        Port          8088
        TLS           On
        TLS.Verify    On
        Splunk_Token  ${SPLUNK_HEC_TOKEN}
        Splunk_Send_Raw On
        Event_Index   security-tetragon
        Event_Source  kubernetes-tetragon
```

### Prometheus Metrics

```bash
# Tetragon exposes Prometheus metrics on port 2112
kubectl port-forward -n kube-system ds/tetragon 2112:2112

curl -s localhost:2112/metrics | grep -E 'tetragon_'
# tetragon_events_total{namespace="production",type="PROCESS_EXEC"} 148293
# tetragon_events_total{namespace="production",type="PROCESS_KPROBE"} 8421
# tetragon_policy_enforcement_total{action="SIGKILL",policy="block-shell-in-containers"} 12
# tetragon_errors_total{type="map_write"} 0
```

## Tuning and Performance

### eBPF Map Size Tuning

```yaml
# For high-throughput environments, increase eBPF map sizes
# These are set via Helm values or environment variables on the tetragon DaemonSet
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
          env:
            # Process cache: increase for nodes running many short-lived processes
            - name: TETRAGON_PROCESS_CACHE_SIZE
              value: "65536"
            # Event buffer: increase for high-throughput workloads
            - name: TETRAGON_EVENT_QUEUE_SIZE
              value: "65536"
            # BPF map ring buffer size per CPU (in pages)
            - name: TETRAGON_RING_BUF_SIZE
              value: "131072"   # 512MB total on 4-CPU node
```

### Rate Limiting Enforcement

Overly broad policies can generate enormous event volumes. Use rate limiting in actions:

```yaml
selectors:
  - matchNamespaces:
      - operator: In
        values: ["production"]
    actions:
      - action: Post
        rateLimit: "100/minute"    # At most 100 events per minute for this selector
        rateLimitScope: "per-process"  # Rate limit applies per process, not globally
```

## Policy Testing and Validation

```bash
# Dry-run validation (observe mode before enabling enforcement)
# Step 1: Deploy policy in observe mode
kubectl apply -f - <<EOF
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: test-block-shells-observe
spec:
  kprobes:
    - call: "sys_execve"
      syscall: true
      args:
        - index: 0
          type: "string"
      selectors:
        - matchArgs:
            - index: 0
              operator: In
              values: ["/bin/bash", "/bin/sh"]
          actions:
            - action: Post    # Observe only
EOF

# Step 2: Trigger the behavior
kubectl exec -n production deploy/myapp -- /bin/bash -c 'echo test'

# Step 3: Verify events appear
kubectl exec -n kube-system ds/tetragon -- \
  tetra getevents --namespace production -o compact | grep bash

# Step 4: Once confirmed working, switch to enforcement
kubectl patch tracingpolicy test-block-shells-observe --type=json \
  -p='[{"op":"replace","path":"/spec/kprobes/0/selectors/0/actions/0/action","value":"Sigkill"}]'
```

## Summary

Tetragon provides deep, kernel-level security enforcement that is significantly harder to bypass than user-space alternatives. Key production guidance:

- Start policies in observe mode (`action: Post`) to establish baseline behavior before enabling enforcement (`action: Sigkill`)
- Use `TracingPolicyNamespaced` for per-team enforcement with namespace isolation; reserve cluster-wide `TracingPolicy` for universal controls
- Apply rate limiting to all observation policies; without limits, a single busy node can generate millions of events per minute
- Test enforcement policies in non-production environments with realistic workloads — a policy that blocks production processes will trigger SIGKILL under load
- Forward Tetragon events to a SIEM for retention and correlation with other security signals
- Monitor `tetragon_policy_enforcement_total` to detect unexpected enforcement events that may indicate attacker activity or policy misconfiguration

## Advanced: LSM (Linux Security Module) Hooks

Tetragon 1.1+ supports attaching to LSM hooks, providing Mandatory Access Control semantics without requiring AppArmor or SELinux profiles:

```yaml
# tracingpolicies/lsm-capability-enforce.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: lsm-restrict-capabilities
  annotations:
    description: "Use LSM hooks to prevent capability abuse in production"
spec:
  # LSM hook: runs inside the kernel's security framework
  # Faster than kprobe and harder to bypass
  lsmHooks:
    - hook: "capable"
      args:
        - index: 2
          type: "int"    # cap (capability number)
      selectors:
        - matchNamespaces:
            - operator: In
              values: ["production"]
          matchArgs:
            # Block CAP_SYS_ADMIN (0x15 = 21) in production containers
            - index: 2
              operator: Equal
              values: ["21"]
          matchCapabilities:
            - type: Effective
              operator: In
              values: ["CAP_SYS_ADMIN"]
          actions:
            - action: Override
              argError: -1
            - action: Post
              rateLimit: "5/minute"
```

## Tetragon with Falco Integration

Tetragon and Falco serve complementary roles: Tetragon handles enforcement (SIGKILL) while Falco provides rule-based detection with richer alert context. Forward Tetragon events to Falco's HTTP endpoint:

```yaml
# tetragon/falco-forward-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: tetragon-export-config
  namespace: kube-system
data:
  export-config.yaml: |
    exportFilePath: /var/run/cilium/tetragon/tetragon.log
    exportAllowList:
      - event_set:
          - PROCESS_EXEC
          - PROCESS_KPROBE
          - PROCESS_TRACING
    exportDenyList: []
    fieldFilters: []
    rateLimit: 100
    rateLimitFormat: minute
```

```bash
# Falco rule to consume Tetragon SIGKILL events forwarded as JSON
# /etc/falco/rules.d/tetragon-events.yaml
- rule: Tetragon Policy Enforcement
  desc: A Tetragon TracingPolicy enforcement action was triggered
  condition: >
    evt.type = < and
    json.value[process_kprobe.action] = "KPROBE_ACTION_SIGKILL"
  output: >
    Tetragon enforcement (policy=%json.value[process_kprobe.policy_name]
    binary=%json.value[process_kprobe.process.binary]
    pod=%json.value[process_kprobe.process.pod.name]
    ns=%json.value[process_kprobe.process.pod.namespace])
  priority: CRITICAL
  tags: [tetragon, enforcement, runtime]
```

## Process Tree Tracking and Parent Matching

Tetragon tracks the full process lineage, enabling policies that enforce based on the process hierarchy:

```yaml
# tracingpolicies/restrict-process-by-parent.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: restrict-execution-from-web-process
  annotations:
    description: "Block any process spawned by the web server binary — prevents RCE exploitation"
spec:
  kprobes:
    - call: "sys_execve"
      syscall: true
      args:
        - index: 0
          type: "string"
      selectors:
        - matchNamespaces:
            - operator: In
              values: ["production"]
          # Match if the parent process is the web server
          matchProcessParentNames:
            - operator: In
              values:
                - "/app/payment-server"
                - "/app/api-gateway"
          # But allow these legitimate child processes
          matchArgs:
            - index: 0
              operator: NotIn
              values:
                - "/usr/local/bin/grpc_health_probe"
                - "/pause"
          actions:
            - action: Sigkill
            - action: Post
              rateLimit: "1/minute"
```

## Tetragon Event Volume Management

High-throughput Kubernetes clusters can generate millions of Tetragon events per hour. Implement event aggregation and filtering at the collector:

```yaml
# Vector configuration for Tetragon event processing
# vector/tetragon-processing.yaml
sources:
  tetragon_logs:
    type: file
    include:
      - /var/run/cilium/tetragon/tetragon.log
    read_from: end

transforms:
  parse_tetragon:
    type: remap
    inputs: [tetragon_logs]
    source: |
      . = parse_json!(.message)

  filter_high_value:
    type: filter
    inputs: [parse_tetragon]
    condition: |
      # Only forward enforcement events and process executions
      # to the SIEM; drop observation-only events
      exists(.process_kprobe) ||
      (exists(.process_exec) &&
       .process_exec.process.pod.namespace == "production")

  deduplicate_events:
    type: dedupe
    inputs: [filter_high_value]
    fields:
      match:
        - process_exec.process.binary
        - process_exec.process.pod.name
    cache:
      num_events: 5000

sinks:
  splunk_hec:
    type: splunk_hec_logs
    inputs: [deduplicate_events]
    endpoint: https://splunk-hec.corp.example.com:8088
    token: "${SPLUNK_HEC_TOKEN}"
    index: security-runtime
    sourcetype: tetragon
    tls:
      verify_certificate: true
```

## Tetragon Upgrade and Policy Migration

```bash
# Upgrade Tetragon with zero downtime using Helm
# Step 1: Check current version
helm list -n kube-system | grep tetragon

# Step 2: Review policy compatibility for the new version
helm diff upgrade tetragon cilium/tetragon \
  --namespace kube-system \
  --version 1.4.0 \
  -f values.yaml

# Step 3: Upgrade (DaemonSet rolling update)
helm upgrade tetragon cilium/tetragon \
  --namespace kube-system \
  --version 1.4.0 \
  -f values.yaml \
  --wait \
  --timeout 10m

# Step 4: Verify all pods are updated
kubectl rollout status daemonset/tetragon -n kube-system

# Step 5: Validate policies still active
kubectl get tracingpolicies.cilium.io -A
tetra tracingpolicy list
```
