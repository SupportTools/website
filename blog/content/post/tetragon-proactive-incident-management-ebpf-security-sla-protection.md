---
title: "Tetragon Proactive Incident Management: eBPF Security for SLA Protection"
date: 2026-12-02T00:00:00-05:00
draft: false
tags: ["Tetragon", "eBPF", "Security", "Observability", "Kubernetes", "Incident Prevention", "SLA Management"]
categories: ["Security", "Kubernetes", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing Tetragon eBPF-based security and observability for proactive incident detection, SLA protection, and kernel-level monitoring in production Kubernetes environments."
more_link: "yes"
url: "/tetragon-proactive-incident-management-ebpf-security-sla-protection/"
---

Production incidents often reveal themselves through subtle signals—anomalous system calls, unexpected file access patterns, or unusual network behavior—long before they cause customer-facing impact. Traditional monitoring tools operate at the application layer, missing these critical kernel-level indicators. Tetragon, Cilium's eBPF-based security and observability platform, provides kernel-level visibility that enables proactive incident detection and prevention. This comprehensive guide explores how to leverage Tetragon for proactive incident management and SLA protection in production Kubernetes environments.

<!--more-->

## Executive Summary

Tetragon represents a paradigm shift in production monitoring and security: from reactive alerting based on application metrics to proactive detection of anomalous behavior at the kernel level. By leveraging eBPF (Extended Berkeley Packet Filter), Tetragon can observe and enforce security policies on system calls, file operations, and network activity with minimal performance overhead. This post provides a complete implementation guide for using Tetragon to prevent production incidents, protect SLAs, and implement defense-in-depth security strategies.

## Understanding eBPF and Tetragon Architecture

### What is eBPF?

eBPF is a revolutionary technology that allows running sandboxed programs in the Linux kernel without changing kernel source code or loading kernel modules. It provides:

- **Kernel-level visibility** into system calls, network packets, and file operations
- **Minimal performance overhead** through Just-In-Time (JIT) compilation
- **Safety guarantees** via the eBPF verifier that ensures programs cannot crash the kernel
- **Dynamic instrumentation** without requiring kernel module compilation or installation

### Tetragon Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Kubernetes Cluster                          │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    Application Pods                        │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐                │  │
│  │  │  nginx   │  │ postgres │  │   api    │                │  │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘                │  │
│  └───────┼─────────────┼─────────────┼────────────────────────┘  │
│          │             │             │                            │
│          │             │             │ System Calls               │
│          │             │             │ File Operations            │
│          │             │             │ Network Activity           │
│          ▼             ▼             ▼                            │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │               Linux Kernel (eBPF Layer)                  │   │
│  │                                                           │   │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐        │   │
│  │  │  execve    │  │   open     │  │  connect   │        │   │
│  │  │   probe    │  │   probe    │  │   probe    │   ...  │   │
│  │  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘        │   │
│  └────────┼────────────────┼────────────────┼───────────────┘   │
│           │                │                │                    │
│           │                │                │ eBPF Events        │
│           ▼                ▼                ▼                    │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              Tetragon Agent (DaemonSet)                   │  │
│  │                                                            │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐ │  │
│  │  │   Event      │  │   Policy     │  │   Enforcement  │ │  │
│  │  │  Processing  │  │   Engine     │  │     Engine     │ │  │
│  │  └──────┬───────┘  └──────┬───────┘  └────────┬───────┘ │  │
│  └─────────┼──────────────────┼──────────────────┼──────────┘  │
│            │                  │                  │              │
│            ▼                  ▼                  ▼              │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              Tetragon Observability Layer                 │  │
│  │                                                            │  │
│  │  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐ │  │
│  │  │  gRPC   │  │Prometheus│  │   JSON   │  │  Alerts   │ │  │
│  │  │  API    │  │ Metrics  │  │   Logs   │  │           │ │  │
│  │  └────┬────┘  └────┬─────┘  └────┬─────┘  └─────┬─────┘ │  │
│  └───────┼────────────┼─────────────┼──────────────┼────────┘  │
│          │            │             │              │            │
└──────────┼────────────┼─────────────┼──────────────┼────────────┘
           │            │             │              │
           ▼            ▼             ▼              ▼
    ┌──────────┐ ┌──────────┐ ┌──────────┐  ┌──────────────┐
    │ tetra CLI│ │ Grafana  │ │   ELK    │  │ AlertManager │
    └──────────┘ └──────────┘ └──────────┘  └──────────────┘
```

## Installing Tetragon in Production

### Prerequisites

```bash
# Verify kernel version (minimum 4.19, recommended 5.10+)
uname -r

# Check if BPF is enabled
cat /boot/config-$(uname -r) | grep CONFIG_BPF

# Required kernel configs:
# CONFIG_BPF=y
# CONFIG_BPF_SYSCALL=y
# CONFIG_BPF_JIT=y
# CONFIG_HAVE_EBPF_JIT=y
# CONFIG_BPF_EVENTS=y
# CONFIG_DEBUG_INFO_BTF=y (for CO-RE support)
```

### Helm Installation

```yaml
# tetragon-values.yaml
# Production-grade Tetragon configuration

# Image configuration
image:
  repository: quay.io/cilium/tetragon
  tag: v1.0.0
  pullPolicy: IfNotPresent

# DaemonSet configuration - runs on every node
daemonSet:
  enabled: true

  # Resource allocation
  resources:
    limits:
      cpu: 1000m
      memory: 1Gi
    requests:
      cpu: 100m
      memory: 128Mi

  # Priority class for critical system component
  priorityClassName: system-node-critical

  # Node selector (optional - deploy to all nodes by default)
  nodeSelector: {}

  # Tolerations to ensure deployment on all nodes including control plane
  tolerations:
    - operator: Exists

  # Update strategy
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1

# Tetragon configuration
tetragon:
  # Enable process execution monitoring
  enableProcessExec: true

  # Enable process exit monitoring
  enableProcessExit: true

  # Enable network monitoring (requires specific kernel features)
  enableNetworkMonitoring: true

  # Enable file operation monitoring
  enableFileMonitoring: true

  # gRPC server configuration
  grpc:
    enabled: true
    address: "localhost:54321"

  # Export configuration
  export:
    # File path for JSON export
    filePath: "/var/run/tetragon/tetragon.log"

    # Stdout export
    stdout: false

    # Mode: aggregated or full
    mode: "aggregated"

    # Rate limiting
    rateLimit: 10000  # events per second

  # BTF (BPF Type Format) configuration
  btf: "/sys/kernel/btf/vmlinux"

# Operator configuration
tetragonOperator:
  enabled: true

  replicas: 1

  resources:
    limits:
      cpu: 500m
      memory: 512Mi
    requests:
      cpu: 100m
      memory: 128Mi

  # Pod security context
  securityContext:
    runAsNonRoot: true
    runAsUser: 10001

# Prometheus monitoring
prometheus:
  enabled: true
  port: 9090
  serviceMonitor:
    enabled: true
    interval: 30s
    scrapeTimeout: 10s

# Enable policy enforcement
policyEnforcement:
  enabled: true
  mode: "audit"  # Options: audit, enforce

# Security context for Tetragon pods
securityContext:
  privileged: true  # Required for eBPF
  capabilities:
    add:
      - SYS_ADMIN
      - SYS_RESOURCE
      - NET_ADMIN

# Service account configuration
serviceAccount:
  create: true
  name: tetragon

# RBAC configuration
rbac:
  create: true

# Log level
logLevel: "info"  # Options: trace, debug, info, warn, error
```

```bash
# Install Tetragon using Helm
helm repo add cilium https://helm.cilium.io
helm repo update

# Create namespace
kubectl create namespace tetragon-system

# Install with custom values
helm install tetragon cilium/tetragon \
  --namespace tetragon-system \
  --values tetragon-values.yaml

# Verify installation
kubectl get pods -n tetragon-system
kubectl logs -n tetragon-system -l app.kubernetes.io/name=tetragon

# Install tetra CLI for event inspection
GOOS=$(go env GOOS)
GOARCH=$(go env GOARCH)
curl -L https://github.com/cilium/tetragon/releases/latest/download/tetra-${GOOS}-${GOARCH}.tar.gz | \
  tar -xz && sudo mv tetra /usr/local/bin/
```

## Tracing Policy Development for Proactive Detection

Tetragon's power lies in its TracingPolicy CRDs that define what to monitor and how to respond:

### Storage Misconfiguration Detection

Based on real incidents where storage misconfigurations led to pod failures:

```yaml
# storage-monitoring-policy.yaml
# Detects dangerous storage operations that could lead to incidents

apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: storage-monitoring
  namespace: tetragon-system
spec:
  # Monitor file operations that could indicate storage issues
  kprobes:
  - call: "security_file_open"
    syscall: false
    return: true
    args:
    - index: 0
      type: "file"
    returnArg:
      type: "int"
    returnArgAction: "Post"
    selectors:
    - matchArgs:
      - index: 0
        operator: "Prefix"
        values:
        - "/var/lib/kubelet/pods"
        - "/var/lib/docker"
        - "/var/lib/containerd"
      matchActions:
      - action: "Post"
      matchReturnArgs:
      - index: 0
        operator: "LT"
        values:
        - "0"  # Negative return value indicates error

  # Monitor disk space issues
  - call: "vfs_write"
    syscall: false
    return: true
    args:
    - index: 0
      type: "file"
    - index: 2
      type: "size_t"
    returnArg:
      type: "size_t"
    returnArgAction: "Post"
    selectors:
    - matchActions:
      - action: "Post"
      matchReturnArgs:
      - index: 0
        operator: "Equal"
        values:
        - "-28"  # ENOSPC - No space left on device

  # Monitor for disk I/O errors
  - call: "generic_make_request"
    syscall: false
    return: false
    args:
    - index: 0
      type: "bio"
    selectors:
    - matchArgs:
      - index: 0
        operator: "Equal"
        values:
        - "bio_rw_error"
      matchActions:
      - action: "Sigkill"  # Kill process causing I/O errors
      - action: "Post"

---
# Alert configuration for storage issues
apiVersion: v1
kind: ConfigMap
metadata:
  name: tetragon-storage-alerts
  namespace: tetragon-system
data:
  alerts.yaml: |
    groups:
    - name: storage
      interval: 30s
      rules:
      - alert: PersistentStorageAccessFailure
        expr: |
          rate(tetragon_file_operation_errors_total{
            path=~"/var/lib/kubelet/pods/.*"
          }[5m]) > 0
        for: 2m
        labels:
          severity: critical
          component: storage
        annotations:
          summary: "Persistent storage access failures detected"
          description: "Pod {{ $labels.pod }} experiencing storage access failures"
          runbook: "https://support.tools/runbooks/storage-failures"

      - alert: DiskSpaceExhaustion
        expr: |
          rate(tetragon_syscall_errors_total{
            error="ENOSPC"
          }[5m]) > 0
        for: 1m
        labels:
          severity: critical
          component: storage
        annotations:
          summary: "Disk space exhaustion detected"
          description: "Node {{ $labels.node }} is out of disk space"
          runbook: "https://support.tools/runbooks/disk-space"
```

### Deployment Spike Detection

Monitor for abnormal deployment rates that could indicate issues:

```yaml
# deployment-spike-policy.yaml
# Detects unusual container start patterns

apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: deployment-spike-detection
  namespace: tetragon-system
spec:
  kprobes:
  # Monitor container runtime operations
  - call: "sys_clone"
    syscall: true
    return: true
    args:
    - index: 0
      type: "unsigned long"
    - index: 1
      type: "unsigned long"
    returnArg:
      type: "int"
    selectors:
    - matchPIDs:
      - operator: "In"
        followForks: true
        isNamespacePID: false
        values:
        - "containerd-shim"
        - "dockerd"
        - "cri-o"
      matchActions:
      - action: "Post"

  # Monitor exec syscalls for container starts
  - call: "sys_execve"
    syscall: true
    args:
    - index: 0
      type: "string"
    - index: 1
      type: "char_args"
    selectors:
    - matchBinaries:
      - operator: "In"
        values:
        - "/usr/bin/containerd-shim-runc-v2"
        - "/usr/bin/runc"
        - "/usr/bin/crun"
      matchActions:
      - action: "Post"
    - matchArgs:
      - index: 0
        operator: "Prefix"
        values:
        - "/pause"  # Kubernetes pause containers
      matchActions:
      - action: "Post"
      rateLimit:
        interval: "1m"
        count: 100  # Alert if more than 100 containers start per minute

---
# Prometheus rules for deployment spike detection
apiVersion: v1
kind: ConfigMap
metadata:
  name: tetragon-deployment-alerts
  namespace: tetragon-system
data:
  deployment-alerts.yaml: |
    groups:
    - name: deployments
      interval: 15s
      rules:
      - alert: DeploymentSpike
        expr: |
          rate(tetragon_process_exec_total{
            binary=~".*(containerd-shim|runc).*"
          }[1m]) > 10
        for: 2m
        labels:
          severity: warning
          component: orchestration
        annotations:
          summary: "Abnormal container start rate detected"
          description: "Container start rate: {{ $value }} per second on node {{ $labels.node }}"

      - alert: PodCrashLoop
        expr: |
          rate(tetragon_process_exit_total{
            signal="SIGKILL",
            pod!=""
          }[5m]) > 1
        for: 5m
        labels:
          severity: warning
          component: application
        annotations:
          summary: "Pod crash loop detected"
          description: "Pod {{ $labels.pod }} crashing repeatedly"
```

### Security Policy for Privilege Escalation Prevention

```yaml
# privilege-escalation-prevention.yaml
# Prevents and detects privilege escalation attempts

apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: privilege-escalation-prevention
  namespace: tetragon-system
spec:
  kprobes:
  # Monitor setuid/setgid system calls
  - call: "sys_setuid"
    syscall: true
    args:
    - index: 0
      type: "int"
    selectors:
    - matchArgs:
      - index: 0
        operator: "Equal"
        values:
        - "0"  # UID 0 = root
      matchActions:
      - action: "Sigkill"  # Kill process attempting to become root
      - action: "Post"
      matchCapabilities:
      - type: "Effective"
        operator: "NotIn"
        values:
        - "CAP_SETUID"

  - call: "sys_setgid"
    syscall: true
    args:
    - index: 0
      type: "int"
    selectors:
    - matchArgs:
      - index: 0
        operator: "Equal"
        values:
        - "0"  # GID 0 = root
      matchActions:
      - action: "Sigkill"
      - action: "Post"
      matchCapabilities:
      - type: "Effective"
        operator: "NotIn"
        values:
        - "CAP_SETGID"

  # Monitor capability changes
  - call: "cap_capable"
    syscall: false
    args:
    - index: 1
      type: "int"  # Capability being checked
    selectors:
    - matchArgs:
      - index: 1
        operator: "In"
        values:
        - "0"   # CAP_CHOWN
        - "1"   # CAP_DAC_OVERRIDE
        - "6"   # CAP_SETGID
        - "7"   # CAP_SETUID
        - "21"  # CAP_SYS_ADMIN
      matchNamespaces:
      - namespace: Pid
        operator: "NotIn"
        values:
        - "host"  # Alert on non-host namespace capability usage
      matchActions:
      - action: "Post"

  # Monitor /etc/shadow access
  - call: "security_file_open"
    syscall: false
    args:
    - index: 0
      type: "file"
    selectors:
    - matchArgs:
      - index: 0
        operator: "Equal"
        values:
        - "/etc/shadow"
        - "/etc/sudoers"
      matchActions:
      - action: "Sigkill"
      - action: "Post"
      matchCapabilities:
      - type: "Effective"
        operator: "NotIn"
        values:
        - "CAP_DAC_OVERRIDE"
```

### Network Anomaly Detection

```yaml
# network-anomaly-detection.yaml
# Monitors for suspicious network activity

apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: network-anomaly-detection
  namespace: tetragon-system
spec:
  kprobes:
  # Monitor outbound connections
  - call: "tcp_connect"
    syscall: false
    return: true
    args:
    - index: 0
      type: "sock"
    selectors:
    # Alert on connections to suspicious ports
    - matchArgs:
      - index: 0
        operator: "DPort"
        values:
        - "4444"  # Common reverse shell port
        - "5555"  # Common C2 port
        - "6666"  # Common backdoor port
        - "7777"  # Common malware port
        - "31337" # Leet speak port
      matchActions:
      - action: "Post"
      - action: "Sigkill"

    # Alert on connections to TOR network
    - matchArgs:
      - index: 0
        operator: "DPort"
        values:
        - "9001"  # TOR relay
        - "9030"  # TOR directory
        - "9050"  # TOR SOCKS
        - "9051"  # TOR control
      matchActions:
      - action: "Post"

    # Alert on excessive connection rate
    - matchActions:
      - action: "Post"
      rateLimit:
        interval: "10s"
        count: 100  # More than 100 connections per 10s

  # Monitor DNS queries for data exfiltration
  - call: "udp_sendmsg"
    syscall: false
    args:
    - index: 0
      type: "sock"
    - index: 2
      type: "size_t"
    selectors:
    # Monitor DNS queries (port 53)
    - matchArgs:
      - index: 0
        operator: "DPort"
        values:
        - "53"
      - index: 1
        operator: "GT"
        values:
        - "512"  # DNS query larger than normal
      matchActions:
      - action: "Post"

  # Monitor for port scanning activity
  - call: "tcp_v4_connect"
    syscall: false
    return: true
    args:
    - index: 0
      type: "sock"
    selectors:
    - matchActions:
      - action: "Post"
      rateLimit:
        interval: "60s"
        count: 50  # More than 50 unique connections per minute indicates scanning
```

## SLA Protection with Tetragon

Implement proactive SLA protection through early detection:

```yaml
# sla-protection-policy.yaml
# Monitors for conditions that could violate SLAs

apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: sla-protection
  namespace: tetragon-system
spec:
  kprobes:
  # Monitor for database connection pool exhaustion
  - call: "sys_connect"
    syscall: true
    return: true
    args:
    - index: 0
      type: "int"
    - index: 1
      type: "sockaddr"
    returnArg:
      type: "int"
    selectors:
    # Monitor PostgreSQL connections (port 5432)
    - matchArgs:
      - index: 1
        operator: "DPort"
        values:
        - "5432"
      matchActions:
      - action: "Post"
      matchReturnArgs:
      - index: 0
        operator: "Equal"
        values:
        - "-11"  # EAGAIN - resource temporarily unavailable

    # Monitor MySQL connections (port 3306)
    - matchArgs:
      - index: 1
        operator: "DPort"
        values:
        - "3306"
      matchActions:
      - action: "Post"
      matchReturnArgs:
      - index: 0
        operator: "LT"
        values:
        - "0"  # Any error

  # Monitor for CPU throttling
  - call: "cgroup_throttle_task"
    syscall: false
    args:
    - index: 0
      type: "task_struct"
    selectors:
    - matchActions:
      - action: "Post"
      matchNamespaces:
      - namespace: Cgroup
        operator: "Prefix"
        values:
        - "/kubepods/burstable"
        - "/kubepods/besteffort"

  # Monitor for OOM conditions before they kill pods
  - call: "mem_cgroup_out_of_memory"
    syscall: false
    args:
    - index: 0
      type: "mem_cgroup"
    selectors:
    - matchActions:
      - action: "Post"

  # Monitor API server response times
  - call: "sys_write"
    syscall: true
    return: true
    args:
    - index: 0
      type: "int"
    - index: 2
      type: "size_t"
    returnArg:
      type: "size_t"
    selectors:
    # Monitor writes to API server connections
    - matchBinaries:
      - operator: "In"
        values:
        - "/usr/bin/kube-apiserver"
      matchActions:
      - action: "Post"
      rateLimit:
        interval: "1s"
        count: 1000  # More than 1000 API calls/sec

---
# SLA violation alerting
apiVersion: v1
kind: ConfigMap
metadata:
  name: tetragon-sla-alerts
  namespace: tetragon-system
data:
  sla-alerts.yaml: |
    groups:
    - name: sla_protection
      interval: 30s
      rules:
      - alert: DatabaseConnectionPoolExhaustion
        expr: |
          rate(tetragon_syscall_errors_total{
            syscall="connect",
            error="EAGAIN",
            dport=~"5432|3306"
          }[2m]) > 0.1
        for: 1m
        labels:
          severity: critical
          component: database
          sla_impact: high
        annotations:
          summary: "Database connection pool exhaustion imminent"
          description: "Application {{ $labels.pod }} experiencing database connection failures"

      - alert: CPUThrottlingExcessive
        expr: |
          rate(tetragon_cpu_throttle_total[5m]) > 0.5
        for: 5m
        labels:
          severity: warning
          component: compute
          sla_impact: medium
        annotations:
          summary: "Excessive CPU throttling detected"
          description: "Pod {{ $labels.pod }} being throttled, may impact response times"

      - alert: MemoryPressureWarning
        expr: |
          rate(tetragon_oom_events_total[5m]) > 0
        for: 2m
        labels:
          severity: critical
          component: memory
          sla_impact: high
        annotations:
          summary: "Memory pressure detected, OOM imminent"
          description: "Pod {{ $labels.pod }} experiencing memory pressure"

      - alert: APIServerOverload
        expr: |
          rate(tetragon_process_write_total{
            binary="/usr/bin/kube-apiserver"
          }[1m]) > 10000
        for: 5m
        labels:
          severity: warning
          component: control_plane
          sla_impact: high
        annotations:
          summary: "API server request rate exceeding capacity"
          description: "API server under heavy load, {{ $value }} requests/sec"
```

## Tetragon Event Analysis with tetra CLI

```bash
# Real-time event monitoring
tetra getevents -o compact

# Filter by process name
tetra getevents --processes postgres -o compact

# Filter by namespace
tetra getevents --namespace production -o compact

# Filter by pod
tetra getevents --pod redis-master-0 -o compact

# Export events for analysis
tetra getevents -o json > /tmp/tetragon-events.json

# Monitor specific system calls
tetra getevents --syscalls connect,open,execve -o compact

# Real-time network connection monitoring
tetra getevents --syscalls connect -o json | \
  jq -r 'select(.process_kprobe != null) |
    "\(.time) \(.process_kprobe.process.pod.name) ->
    \(.process_kprobe.args[1].sock_arg.saddr):\(.process_kprobe.args[1].sock_arg.dport)"'

# Monitor file access in real-time
tetra getevents --syscalls open -o json | \
  jq -r 'select(.process_kprobe != null) |
    "\(.time) \(.process_kprobe.process.pod.name):
    \(.process_kprobe.args[0].file_arg.path)"'

# Detect privilege escalation attempts
tetra getevents --syscalls setuid,setgid,capset -o json | \
  jq -r 'select(.process_kprobe.process.cap.effective != null) |
    "\(.time) \(.process_kprobe.process.pod.name)
    CAP: \(.process_kprobe.process.cap.effective)"'
```

## Prometheus Integration and Dashboards

```yaml
# prometheus-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: tetragon
  namespace: monitoring
  labels:
    app: tetragon
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: tetragon
  namespaceSelector:
    matchNames:
      - tetragon-system
  endpoints:
  - port: metrics
    interval: 30s
    scrapeTimeout: 10s
    path: /metrics
    relabelings:
    - sourceLabels: [__meta_kubernetes_pod_node_name]
      targetLabel: node
    - sourceLabels: [__meta_kubernetes_pod_name]
      targetLabel: pod
```

## Grafana Dashboard for Tetragon

```json
{
  "dashboard": {
    "title": "Tetragon Security and Observability",
    "tags": ["tetragon", "security", "ebpf"],
    "timezone": "browser",
    "panels": [
      {
        "title": "Process Execution Rate",
        "type": "graph",
        "targets": [
          {
            "expr": "rate(tetragon_process_exec_total[5m])",
            "legendFormat": "{{ node }} - {{ binary }}"
          }
        ],
        "yaxes": [
          {
            "label": "Executions per second",
            "format": "short"
          }
        ]
      },
      {
        "title": "Security Policy Violations",
        "type": "stat",
        "targets": [
          {
            "expr": "sum(increase(tetragon_policy_violations_total[1h]))"
          }
        ],
        "fieldConfig": {
          "defaults": {
            "thresholds": {
              "mode": "absolute",
              "steps": [
                {"value": 0, "color": "green"},
                {"value": 1, "color": "yellow"},
                {"value": 10, "color": "red"}
              ]
            }
          }
        }
      },
      {
        "title": "Network Connections by Destination Port",
        "type": "piechart",
        "targets": [
          {
            "expr": "sum by (dport) (rate(tetragon_network_connect_total[5m]))",
            "legendFormat": "Port {{ dport }}"
          }
        ]
      },
      {
        "title": "File Access Patterns",
        "type": "table",
        "targets": [
          {
            "expr": "topk(20, sum by (path, pod) (rate(tetragon_file_open_total[5m])))",
            "format": "table",
            "instant": true
          }
        ]
      },
      {
        "title": "CPU Throttling Events",
        "type": "graph",
        "targets": [
          {
            "expr": "rate(tetragon_cpu_throttle_total[5m])",
            "legendFormat": "{{ pod }}"
          }
        ],
        "alert": {
          "conditions": [
            {
              "evaluator": {
                "type": "gt",
                "params": [0.5]
              }
            }
          ]
        }
      },
      {
        "title": "OOM Events",
        "type": "stat",
        "targets": [
          {
            "expr": "sum(increase(tetragon_oom_events_total[1h]))"
          }
        ],
        "fieldConfig": {
          "defaults": {
            "color": {
              "mode": "thresholds"
            },
            "thresholds": {
              "mode": "absolute",
              "steps": [
                {"value": 0, "color": "green"},
                {"value": 1, "color": "red"}
              ]
            }
          }
        }
      }
    ]
  }
}
```

## Performance Impact Analysis

Tetragon's performance overhead is minimal due to eBPF's efficiency:

```bash
#!/bin/bash
# tetragon-performance-test.sh
# Measures Tetragon's performance impact

set -euo pipefail

LOG_FILE="/tmp/tetragon-perf-$(date +%Y%m%d-%H%M%S).log"

log() {
  echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

# Baseline test without Tetragon
baseline_test() {
  log "Running baseline performance test..."

  # CPU benchmark
  log "CPU benchmark..."
  sysbench cpu --threads=4 --time=60 run | tee -a "$LOG_FILE"

  # File I/O benchmark
  log "File I/O benchmark..."
  sysbench fileio --file-test-mode=seqwr --time=60 prepare
  sysbench fileio --file-test-mode=seqwr --time=60 run | tee -a "$LOG_FILE"
  sysbench fileio --file-test-mode=seqwr cleanup

  # Network benchmark
  log "Network benchmark..."
  iperf3 -c target-host -t 60 | tee -a "$LOG_FILE"
}

# Test with Tetragon enabled
tetragon_test() {
  log "Running performance test with Tetragon..."

  # Same benchmarks as baseline
  log "CPU benchmark with Tetragon..."
  sysbench cpu --threads=4 --time=60 run | tee -a "$LOG_FILE"

  log "File I/O benchmark with Tetragon..."
  sysbench fileio --file-test-mode=seqwr --time=60 prepare
  sysbench fileio --file-test-mode=seqwr --time=60 run | tee -a "$LOG_FILE"
  sysbench fileio --file-test-mode=seqwr cleanup

  log "Network benchmark with Tetragon..."
  iperf3 -c target-host -t 60 | tee -a "$LOG_FILE"
}

# Measure Tetragon CPU usage
measure_tetragon_overhead() {
  log "Measuring Tetragon overhead..."

  # Get Tetragon pod CPU usage
  kubectl top pod -n tetragon-system | tee -a "$LOG_FILE"

  # Get Tetragon eBPF program statistics
  for pod in $(kubectl get pods -n tetragon-system -l app.kubernetes.io/name=tetragon -o name); do
    log "eBPF stats for $pod:"
    kubectl exec -n tetragon-system "$pod" -- bpftool prog show | tee -a "$LOG_FILE"
  done
}

log "Tetragon Performance Impact Analysis"
log "====================================="

baseline_test
sleep 30
tetragon_test
sleep 30
measure_tetragon_overhead

log "Performance analysis complete. Results in: $LOG_FILE"
```

Typical performance impact:
- **CPU overhead**: 1-3% per core
- **Memory overhead**: 50-150MB per node
- **Network overhead**: < 1% latency increase
- **Storage overhead**: Negligible

## Conclusion

Tetragon represents a fundamental shift in how we approach production monitoring and security. By leveraging eBPF for kernel-level visibility, it enables:

1. **Proactive Incident Detection**: Catch issues before they impact customers
2. **Zero-Trust Security**: Enforce security policies at the kernel level
3. **Deep Observability**: Understand system behavior at unprecedented detail
4. **Minimal Performance Impact**: eBPF efficiency enables always-on monitoring
5. **SLA Protection**: Detect conditions that threaten SLAs before violations occur

The real-world incidents prevented by Tetragon—storage misconfigurations, deployment spikes, privilege escalations—demonstrate its value in production environments. By implementing the policies and monitoring strategies outlined in this guide, organizations can significantly reduce incident frequency and severity while maintaining strong security postures.

Key takeaways:

- Start with audit mode before enforcing policies
- Tune policies based on your specific workload patterns
- Integrate with existing monitoring and alerting infrastructure
- Regularly review and update tracing policies
- Use Tetragon data for post-incident analysis and continuous improvement