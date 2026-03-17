---
title: "Kubernetes Ephemeral Containers: Live Debugging, Distroless Containers, and Debug Profiles"
date: 2030-05-07T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Debugging", "Ephemeral Containers", "Distroless", "kubectl debug", "Production"]
categories: ["Kubernetes", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Kubernetes ephemeral containers: debugging running pods without restart, attaching debug containers to distroless and scratch images, using debug profiles, and copying pods with debug sidecars for production incident response."
more_link: "yes"
url: "/kubernetes-ephemeral-containers-debug-profiles-distroless-guide/"
---

Debugging production containers has historically required either building debug tooling into production images (increasing attack surface and image size) or restarting pods with modified configurations (causing service disruption). Kubernetes ephemeral containers solve this by allowing you to inject a debug container into a running pod without restart, sharing the process namespace, filesystem, and network of the target container.

This capability is especially powerful for distroless and scratch-based containers that contain no shell, no package manager, and no diagnostic tools. With ephemeral containers, you attach a full debugging environment to these minimal images while they're running in production.

<!--more-->

## Ephemeral Container Architecture

### How Ephemeral Containers Work

Ephemeral containers differ from regular containers in several fundamental ways:

```
Regular Container:
  - Defined in pod spec before pod creation
  - Managed by controllers (Deployments, StatefulSets)
  - Can be restarted by kubelet
  - Participates in pod readiness/liveness

Ephemeral Container:
  - Added to running pod via API (no pod restart)
  - Never restarts on failure
  - Not included in pod spec after pod terminates
  - Does not participate in probe checks
  - Shares: network namespace, volumes, process namespace (if enabled)
  - Does NOT share: filesystem root (unless using volumeMount or process namespace)
```

### Enabling Process Namespace Sharing

For ephemeral containers to see and interact with processes in other containers, the pod must have `shareProcessNamespace: true`:

```yaml
# pod-with-shared-namespace.yaml
apiVersion: v1
kind: Pod
metadata:
  name: production-app
  namespace: production
spec:
  shareProcessNamespace: true  # Required for ephemeral container process inspection
  containers:
  - name: app
    image: gcr.io/distroless/static:nonroot
    command: ["/app/server"]
    ports:
    - containerPort: 8080
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        cpu: 500m
        memory: 256Mi
```

For pods without `shareProcessNamespace: true`, you can still debug via the network namespace and shared volumes, but you cannot use `strace`, `gdb`, or signal the target process from the ephemeral container.

## kubectl debug: Core Operations

### Attaching to a Running Pod

```bash
# Basic ephemeral container attach with busybox
kubectl debug -it <pod-name> \
    --image=busybox:1.36 \
    --target=<container-name>

# Using a more capable debug image
kubectl debug -it <pod-name> \
    --image=nicolaka/netshoot:v0.12 \
    --target=app \
    -n production

# Specify container name for the ephemeral container
kubectl debug -it <pod-name> \
    --image=nicolaka/netshoot:v0.12 \
    --target=app \
    -c debug-session \
    -n production

# After attaching, the debug container shares:
# - Network namespace: can run ss, netstat, tcpdump, curl
# - Volumes: can inspect mounted ConfigMaps, Secrets, PVCs
# - Process namespace (if enabled): can run ps, strace, gdb
```

### Debugging Distroless Containers

Distroless images contain only the application binary and its runtime dependencies — no shell, no package manager, no coreutils. A typical distroless Go application image is under 10 MB.

```bash
# Distroless container: no shell available
kubectl exec -it distroless-app -- /bin/sh
# Error: executable file not found in $PATH or OCI runtime exec failed

# Solution: attach ephemeral container that shares process namespace
kubectl debug -it distroless-app \
    --image=ubuntu:22.04 \
    --target=app \
    --share-processes \
    -n production

# Inside the ephemeral container, you can now:
# 1. List the target container's processes
ps aux

# 2. Inspect the application binary
ls -la /proc/1/exe
cat /proc/1/cmdline | tr '\0' ' '

# 3. Read the filesystem of the target container via /proc
ls /proc/1/root/

# 4. Attach strace to the running process
apt-get update -qq && apt-get install -y strace
strace -p 1 -e trace=network,file

# 5. Capture network traffic
tcpdump -i any -w /tmp/capture.pcap &
sleep 30
kill %1
# Copy capture back: kubectl cp production/distroless-app:/tmp/capture.pcap ./capture.pcap -c <ephemeral-name>
```

### Inspecting Container Filesystem via /proc

When `shareProcessNamespace: true` is set, the ephemeral container can access the target container's filesystem through `/proc/<pid>/root`:

```bash
# Find the target container's PID 1
TARGET_PID=$(cat /proc/1/status | grep PPid | awk '{print $2}')
# Or: look for the application process by name
TARGET_PID=$(ps aux | grep '/app/server' | grep -v grep | awk '{print $1}')

# Browse the target container's filesystem
ls -la /proc/$TARGET_PID/root/
ls -la /proc/$TARGET_PID/root/etc/
cat /proc/$TARGET_PID/root/etc/config.yaml

# Check open files
ls -la /proc/$TARGET_PID/fd/
cat /proc/$TARGET_PID/fdinfo/3  # File descriptor details

# Check memory maps
cat /proc/$TARGET_PID/maps

# Check environment variables
cat /proc/$TARGET_PID/environ | tr '\0' '\n'

# Check network connections (same as netstat -tunp)
ss -tunp | grep $TARGET_PID
```

## Debug Profiles

Kubernetes 1.27+ introduced debug profiles that configure the security context and capabilities of ephemeral containers according to predefined templates.

### Available Debug Profiles

```bash
# List available profiles (from kubectl documentation)
# --profile=restricted  - Minimal capabilities, non-root, read-only filesystem
# --profile=baseline    - Some capabilities, allows root, but no privileged
# --profile=general     - Broad capabilities for general debugging (default)
# --profile=sysadmin    - Full system administration capabilities
# --profile=netadmin    - Network administration capabilities
# --profile=auto        - Automatically sets profile based on target container

# Using the sysadmin profile for deep system debugging
kubectl debug -it <pod-name> \
    --image=ubuntu:22.04 \
    --target=app \
    --profile=sysadmin \
    -n production

# Sysadmin profile adds:
# - SYS_PTRACE capability (strace, gdb, perf)
# - SYS_ADMIN capability (mount, eBPF programs)
# - NET_ADMIN capability (iptables, tc, ip)
# - NET_RAW capability (tcpdump, ping)

# Network-specific debugging
kubectl debug -it <pod-name> \
    --image=nicolaka/netshoot:v0.12 \
    --target=app \
    --profile=netadmin \
    -n production
```

### Profile Security Contexts

```yaml
# What the sysadmin profile applies to the ephemeral container
# (equivalent manual spec)
ephemeralContainers:
- name: debug
  image: ubuntu:22.04
  targetContainerName: app
  securityContext:
    capabilities:
      add:
      - SYS_PTRACE
      - SYS_ADMIN
      - NET_ADMIN
      - NET_RAW
      - KILL
      - SETUID
      - SETGID
    runAsUser: 0  # root
    allowPrivilegeEscalation: true
  stdin: true
  tty: true
```

### Custom Debug Profile via YAML Patch

For scenarios requiring precise control over the ephemeral container configuration:

```bash
# Create ephemeral container via API patch for full control
PATCH=$(cat <<'EOF'
{
  "spec": {
    "ephemeralContainers": [
      {
        "name": "custom-debugger",
        "image": "ubuntu:22.04",
        "command": ["/bin/bash"],
        "stdin": true,
        "tty": true,
        "targetContainerName": "app",
        "securityContext": {
          "capabilities": {
            "add": ["SYS_PTRACE", "NET_ADMIN", "NET_RAW"]
          },
          "runAsUser": 0,
          "allowPrivilegeEscalation": true
        },
        "volumeMounts": [
          {
            "name": "app-data",
            "mountPath": "/mnt/app-data",
            "readOnly": true
          }
        ],
        "resources": {
          "requests": {
            "cpu": "100m",
            "memory": "128Mi"
          },
          "limits": {
            "cpu": "500m",
            "memory": "512Mi"
          }
        }
      }
    ]
  }
}
EOF
)

# Apply the patch
kubectl patch pod <pod-name> \
    -n production \
    --subresource=ephemeralcontainers \
    --type=merge \
    -p "$PATCH"

# Attach to the container
kubectl attach -it <pod-name> -c custom-debugger -n production
```

## Copying Pods for Non-Disruptive Debugging

### Pod Copy Pattern

When the running pod cannot have `shareProcessNamespace` enabled (it was not deployed that way), `kubectl debug` can create a copy of the pod with modified settings:

```bash
# Create a copy of the pod with a debug container and shared process namespace
kubectl debug <pod-name> \
    --image=ubuntu:22.04 \
    --share-processes \
    --copy-to=debug-copy \
    -n production \
    -it

# The copy has:
# - Same volumes, environment, service account
# - shareProcessNamespace: true (added by kubectl debug)
# - An additional debug container injected
# - Original container still running unchanged

# Specify which container's image to modify in the copy
# (useful for replacing crash-looping containers)
kubectl debug <pod-name> \
    --image=ubuntu:22.04 \
    --copy-to=debug-copy \
    --container=app \
    -n production \
    -it

# Replace the crash-looping container's command to prevent it from starting
# while allowing inspection of its filesystem
kubectl debug <pod-name> \
    --image=ubuntu:22.04 \
    --copy-to=debug-copy \
    --set-image=app=ubuntu:22.04 \
    -n production
# Then exec into the debug container to inspect what the app would see
```

### Replacing a Crash-Looping Container

When a container is crash-looping (CrashLoopBackOff), it restarts too quickly to attach. Use pod copy to replace the container's entrypoint:

```bash
# Create a copy with the app container replaced by a sleep command
# This lets you inspect the filesystem without the app crashing
kubectl debug <pod-name> \
    --copy-to=debug-copy \
    --set-image=app=ubuntu:22.04 \
    -n production

# Wait for the copy to be running
kubectl wait pod debug-copy \
    --for=condition=Ready \
    --timeout=60s \
    -n production

# Exec into the copied pod
kubectl exec -it debug-copy -c app -n production -- /bin/bash

# Inspect what the original container would have seen
ls -la /app/
cat /app/config.yaml
# Check for corrupted binaries
file /app/server
ldd /app/server 2>&1 | grep -i "not found"

# Check environment
env | sort

# Inspect startup script issues
strace -e trace=file /app/server 2>&1 | head -50

# Clean up the debug copy
kubectl delete pod debug-copy -n production
```

## Advanced Debugging Scenarios

### Live Performance Profiling

```bash
# Attach a Go profiling debug container to a Go application
kubectl debug -it go-service-pod \
    --image=golang:1.22 \
    --target=app \
    --profile=sysadmin \
    -n production

# Inside the debug container: enable pprof sampling on the running process
# (requires the Go application to have pprof HTTP endpoint)

# Method 1: pprof over network (if pprof endpoint is running)
# Forward the pprof port
# In another terminal:
kubectl port-forward pod/go-service-pod 6060:6060 -n production &

# Capture profiles
go tool pprof http://localhost:6060/debug/pprof/heap
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30

# Method 2: perf profiling with BPF (requires sysadmin profile)
# Inside the debug container:
apt-get update -qq && apt-get install -y linux-perf

# Find the target PID
TARGET_PID=$(cat /proc/1/status | grep Pid | head -1 | awk '{print $2}')

# CPU flame graph
perf record -g -p $TARGET_PID -o /tmp/perf.data sleep 30
perf report --stdio -i /tmp/perf.data | head -100
```

### Network Traffic Analysis

```bash
# Comprehensive network debugging with netshoot
kubectl debug -it <pod-name> \
    --image=nicolaka/netshoot:v0.12 \
    --target=app \
    --profile=netadmin \
    -n production

# Inside netshoot:
# 1. Active connections
ss -tunap

# 2. DNS resolution check
dig +short kubernetes.default.svc.cluster.local
dig +short payment-service.production.svc.cluster.local

# 3. Capture traffic to/from the pod
tcpdump -i eth0 -n -w /tmp/pod-traffic.pcap &
TCPDUMP_PID=$!
sleep 60
kill $TCPDUMP_PID

# 4. HTTP request tracing
curl -v http://downstream-service:8080/health 2>&1

# 5. Check iptables rules affecting the pod (requires NET_ADMIN)
iptables -L -n -v | grep -E "KUBE|DROP|REJECT"

# 6. Trace route to specific endpoint
traceroute -n payment-gateway.production.svc.cluster.local

# 7. Check network bandwidth
iperf3 -c bandwidth-test-server -p 5201 -t 10
```

### Memory Leak Investigation

```bash
# Debug Go memory leak with ephemeral container
kubectl debug -it leaking-service \
    --image=golang:1.22 \
    --target=app \
    --profile=sysadmin \
    -n production

# Inside debug container:
# Check /proc/meminfo for the target container context
cat /proc/1/status | grep -E "VmPeak|VmRSS|VmHWM|VmSize"

# Check goroutine dump via pprof
curl http://localhost:6060/debug/pprof/goroutine?debug=2 2>/dev/null | head -100

# Heap profile snapshot
curl -o /tmp/heap1.prof http://localhost:6060/debug/pprof/heap
sleep 60
curl -o /tmp/heap2.prof http://localhost:6060/debug/pprof/heap

# Compare heap profiles
go tool pprof -diff_base /tmp/heap1.prof /tmp/heap2.prof

# Check for fd leaks
ls /proc/1/fd | wc -l
ls -la /proc/1/fd | grep -v "socket\|pipe\|anon_inode" | head -30

# Check for memory-mapped files
grep -c "r--p" /proc/1/maps
```

## Building a Debug Container Image

### Production Debug Image

Rather than pulling `ubuntu:22.04` at incident time (slow, network-dependent), pre-build and cache a debug image that contains all necessary tools:

```dockerfile
# Dockerfile.debug
FROM ubuntu:22.04 AS debug-base

# Install debugging tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Network tools
    curl \
    wget \
    tcpdump \
    nmap \
    netcat-openbsd \
    dnsutils \
    iproute2 \
    iptables \
    iputils-ping \
    traceroute \
    # Process tools
    strace \
    ltrace \
    gdb \
    htop \
    procps \
    lsof \
    # Filesystem tools
    file \
    binutils \
    hexdump \
    # Performance tools
    linux-perf \
    sysstat \
    iotop \
    # Go tools
    golang-go \
    # Text tools
    jq \
    vim \
    less \
    && rm -rf /var/lib/apt/lists/*

# Install kubectl for cluster operations from within debug container
RUN curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" \
    && install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl \
    && rm kubectl

# Install useful Go diagnostic tools
RUN GOPATH=/usr/local go install github.com/google/gops@latest

# Default to bash
CMD ["/bin/bash"]
```

```bash
# Build and push to your registry
docker build -f Dockerfile.debug -t registry.example.com/debug-tools:v1.0 .
docker push registry.example.com/debug-tools:v1.0

# Usage
kubectl debug -it <pod-name> \
    --image=registry.example.com/debug-tools:v1.0 \
    --target=app \
    --profile=sysadmin \
    -n production
```

## RBAC for Ephemeral Container Access

### Restricting Ephemeral Container Usage

Ephemeral containers can read process memory and filesystem contents of production workloads. Access should be tightly controlled:

```yaml
# rbac-ephemeral-containers.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: ephemeral-container-debugger
rules:
# Allow reading pod specs to identify target containers
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list"]
# Allow creating ephemeral containers (the critical permission)
- apiGroups: [""]
  resources: ["pods/ephemeralcontainers"]
  verbs: ["update", "patch"]
# Allow attaching to containers (needed for interactive debugging)
- apiGroups: [""]
  resources: ["pods/attach", "pods/exec"]
  verbs: ["create", "get"]
# Allow port-forwarding for pprof access
- apiGroups: [""]
  resources: ["pods/portforward"]
  verbs: ["create"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: sre-team-ephemeral-debug
subjects:
- kind: Group
  name: sre-team
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: ephemeral-container-debugger
  apiGroup: rbac.authorization.k8s.io
---
# Audit policy to log all ephemeral container operations
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
- level: Request
  resources:
  - group: ""
    resources: ["pods/ephemeralcontainers"]
  verbs: ["update", "patch"]
  omitStages: ["RequestReceived"]
```

### Namespace-Scoped Debug Access

```yaml
# Allow debugging only in the staging namespace, not production
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: developer-ephemeral-debug
  namespace: staging  # Restricted to staging only
subjects:
- kind: Group
  name: developers
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: ephemeral-container-debugger
  apiGroup: rbac.authorization.k8s.io
```

## Automating Debug Sessions

### Debug Session Script

```bash
#!/usr/bin/env bash
# k8s-debug.sh - Automated ephemeral container debugging workflow

set -euo pipefail

POD_NAME="${1:-}"
NAMESPACE="${2:-default}"
TARGET_CONTAINER="${3:-}"
DEBUG_IMAGE="${DEBUG_IMAGE:-registry.example.com/debug-tools:v1.0}"
DEBUG_PROFILE="${DEBUG_PROFILE:-sysadmin}"

usage() {
    echo "Usage: $0 <pod-name> [namespace] [target-container]"
    echo "Environment: DEBUG_IMAGE, DEBUG_PROFILE"
    exit 1
}

[ -z "$POD_NAME" ] && usage

# If target container not specified, use first container
if [ -z "$TARGET_CONTAINER" ]; then
    TARGET_CONTAINER=$(kubectl get pod "$POD_NAME" \
        -n "$NAMESPACE" \
        -o jsonpath='{.spec.containers[0].name}')
    echo "Using target container: $TARGET_CONTAINER"
fi

# Check if pod has shareProcessNamespace enabled
SHARE_PROC=$(kubectl get pod "$POD_NAME" -n "$NAMESPACE" \
    -o jsonpath='{.spec.shareProcessNamespace}' 2>/dev/null || echo "false")

if [ "$SHARE_PROC" != "true" ]; then
    echo "WARNING: shareProcessNamespace is not enabled on this pod."
    echo "Process-level debugging (strace, gdb) will not be available."
    echo "For full process debugging, use: kubectl debug --copy-to=<name> --share-processes"
    read -p "Continue with limited debugging? [y/N] " -r
    [[ ! $REPLY =~ ^[Yy]$ ]] && exit 0
fi

# Log the debug session start
echo "Starting debug session:"
echo "  Pod: $POD_NAME"
echo "  Namespace: $NAMESPACE"
echo "  Target container: $TARGET_CONTAINER"
echo "  Debug image: $DEBUG_IMAGE"
echo "  Debug profile: $DEBUG_PROFILE"
echo "  Operator: ${USER:-unknown}"
echo "  Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Attach ephemeral container
kubectl debug -it "$POD_NAME" \
    --image="$DEBUG_IMAGE" \
    --target="$TARGET_CONTAINER" \
    --profile="$DEBUG_PROFILE" \
    -n "$NAMESPACE" \
    -c "debug-$(date +%s)"

echo "Debug session ended."
```

### Ephemeral Container Cleanup

Ephemeral containers remain in the pod spec as terminated containers after the session ends. While they don't consume resources, they clutter `kubectl describe pod` output. The only way to remove them is to delete and recreate the pod:

```bash
# List all pods with ephemeral containers
kubectl get pods -A -o json | jq -r '
    .items[] |
    select(.spec.ephemeralContainers != null and (.spec.ephemeralContainers | length) > 0) |
    "\(.metadata.namespace)/\(.metadata.name): \(.spec.ephemeralContainers | length) ephemeral container(s)"
'

# For stateless pods managed by Deployments: rolling restart clears ephemeral containers
kubectl rollout restart deployment/<name> -n production

# For StatefulSet pods: must delete pod (StatefulSet recreates it)
kubectl delete pod <pod-name> -n production
```

## Key Takeaways

Ephemeral containers represent a fundamental shift in Kubernetes debugging philosophy — from "build debugging tools into the image" to "attach debugging tools to the running container on demand."

**Distroless images and ephemeral containers are complementary**: Distroless images minimize your attack surface by eliminating shells and tools from production images. Ephemeral containers restore debugging capability when you need it, without permanently compromising the minimal image philosophy.

**Enable `shareProcessNamespace` on pods that may need debugging**: If you know a workload may need process-level debugging (Go applications, JVM services), enable `shareProcessNamespace: true` in the pod spec. This is a low-security-impact setting that enables ptrace, /proc access, and signal delivery from ephemeral containers.

**Use debug profiles to constrain capabilities**: The `--profile=netadmin` profile is sufficient for network debugging without granting full system administration capabilities. Match the profile to the minimum required capabilities for each debugging scenario.

**Pod copy is the safest production debugging technique**: Creating a copy of a production pod via `kubectl debug --copy-to` allows inspection with full debugging capabilities without affecting the live pod. This is the preferred approach for investigating issues that do not require live traffic.

**Audit all ephemeral container operations**: Ephemeral containers can read process memory, environment variables, and mounted secrets. Kubernetes audit logs should capture all `pods/ephemeralcontainers` update/patch operations with request-level detail for compliance and security monitoring.
