---
title: "Kubernetes Ephemeral Containers for Debugging: kubectl debug, shareProcessNamespace, Container Injection, and Profiles"
date: 2032-03-03T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Debugging", "Ephemeral Containers", "kubectl debug", "Troubleshooting", "Production"]
categories:
- Kubernetes
- Operations
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Kubernetes ephemeral containers and kubectl debug, covering container injection techniques, process namespace sharing, debug profiles, and patterns for debugging distroless and minimal container images."
more_link: "yes"
url: "/kubernetes-ephemeral-containers-debugging-kubectl-debug/"
---

Ephemeral containers solve a fundamental tension in modern Kubernetes deployments: minimal production images eliminate the debugging tools that operators need during incidents. A distroless container image might be 15 MB, have no shell, no curl, no strace, and no process list - exactly what you want for security and image size, and exactly what you do not want when debugging a production memory leak at 2 AM. Ephemeral containers let you inject a fully-featured debug environment into a running pod without restarting it, without modifying the original container, and without deploying a debug-mode image. This guide covers the complete feature set including process namespace sharing and debug profiles.

<!--more-->

# Kubernetes Ephemeral Containers for Debugging

## Feature Requirements

Ephemeral containers are stable as of Kubernetes 1.25. The full feature set requires:

```
Kubernetes >= 1.25    (stable EphemeralContainers feature gate)
kubectl >= 1.23       (kubectl debug support)
CRI runtime:          containerd 1.5+ or CRI-O 1.16+
```

Check if your cluster supports ephemeral containers:

```bash
# Verify feature is available
kubectl version --short
# Server Version: v1.29.x

# Check if ephemeralcontainers subresource is supported
kubectl get pods -o json | jq '.items[0].spec.ephemeralContainers' 2>/dev/null
# Returns null if no ephemeral containers exist, but no error means it's supported

# Alternatively
kubectl api-resources | grep pods
# Should show pods with subresources including ephemeralcontainers
```

## Section 1: Basic kubectl debug Usage

### Injecting a Debug Container

The simplest case: inject a debug container into a running pod.

```bash
# Inject a busybox debug container into a pod
kubectl debug -it pod/api-server-7d8f6b9c4-xkz9t \
    --image=busybox:latest \
    --target=api-server \
    -- sh

# Once inside:
# ps aux              (won't show other container processes yet - no shareProcessNamespace)
# cat /proc/net/tcp6  (can see network connections)
# cat /etc/hosts      (shares network namespace)
# ls /proc/1/fd       (see file descriptors of init process in this container)

# Using a full-featured image for network debugging
kubectl debug -it pod/api-server-7d8f6b9c4-xkz9t \
    --image=nicolaka/netshoot:latest \
    --target=api-server \
    -- bash

# Inside netshoot, available tools include:
# curl, wget, dig, nslookup, netstat, ss, tcpdump, iperf3, strace, ping

# Interactive bash with a custom command
kubectl debug -it pod/database-pod-xyz \
    --image=postgres:16-alpine \
    --target=postgres \
    -- bash -c "pg_isready -h localhost -p 5432; psql -h localhost -U postgres"
```

### Targeting a Specific Container in Multi-Container Pods

```bash
# List containers in a pod
kubectl get pod api-server-7d8f6b9c4-xkz9t \
    -o jsonpath='{.spec.containers[*].name}'
# api-server envoy-proxy

# Target the envoy sidecar specifically
kubectl debug -it pod/api-server-7d8f6b9c4-xkz9t \
    --image=curlimages/curl:latest \
    --target=envoy-proxy \
    -- sh

# You're now in the same network namespace as the pod, targeting envoy's process context
curl -s localhost:9901/stats | head  # Envoy admin interface
curl -s localhost:9901/clusters     # Envoy cluster state
```

### Debugging a Node

```bash
# Inject a privileged debug container onto a node
# Creates a pod with full host namespace access
kubectl debug node/worker-node-3 \
    -it \
    --image=nicolaka/netshoot:latest \
    -- bash

# Inside the debug session you have access to:
chroot /host  # enter the node's root filesystem
crictl ps     # list containers via CRI
ls /host/var/log/pods/  # access pod logs
nsenter -t 1 -m -u -i -n -p -- bash  # enter init's namespaces
```

## Section 2: Process Namespace Sharing

The most powerful debugging capability requires `shareProcessNamespace: true` on the pod. This lets the debug container see and interact with all processes in the pod.

### Enabling shareProcessNamespace

```yaml
# debug-enabled-pod.yaml
# Note: You cannot add shareProcessNamespace to a running pod
# It must be set at pod creation time
apiVersion: v1
kind: Pod
metadata:
  name: api-server-debug
  namespace: production
spec:
  # Critical: allows all containers in the pod to see each other's processes
  shareProcessNamespace: true

  containers:
    - name: api-server
      image: gcr.io/distroless/static:nonroot
      command: ["/app/server"]
      args: ["--port=8080"]
      resources:
        requests:
          cpu: 100m
          memory: 128Mi
        limits:
          cpu: 500m
          memory: 512Mi

    # The debug container - can be removed after incident is resolved
    - name: debug
      image: nicolaka/netshoot:latest
      command: ["sleep", "infinity"]
      stdin: true
      tty: true
      resources:
        requests:
          cpu: 10m
          memory: 32Mi
        limits:
          cpu: 200m
          memory: 256Mi
      # Debug container doesn't need elevated privileges usually
      securityContext:
        capabilities:
          add: ["SYS_PTRACE"]  # required for strace and gdb
```

### Using shareProcessNamespace with kubectl debug

You cannot directly add `shareProcessNamespace` to an existing pod via `kubectl debug`. Instead, create a copy of the pod with it enabled:

```bash
# Create a copy of a running pod with shareProcessNamespace enabled
kubectl debug pod/api-server-7d8f6b9c4-xkz9t \
    -it \
    --image=nicolaka/netshoot:latest \
    --share-processes \
    --copy-to=api-server-debug \
    -- bash

# Now inside the debug container:
ps aux
# Shows ALL processes including those in api-server container:
# PID   USER     COMMAND
# 1     root     /pause
# 7     nonroot  /app/server --port=8080
# 23    root     bash         <- your debug session

# Attach strace to the application process
strace -p 7 -e trace=network,file -s 1024

# Examine open file descriptors
ls -la /proc/7/fd

# Read the application's environment variables
cat /proc/7/environ | tr '\0' '\n'

# Access the application's filesystem root
ls /proc/7/root/

# Check what the application has mmap'd
cat /proc/7/maps

# Follow a specific system call for network issues
strace -p 7 -e trace=connect,accept,read,write -f 2>&1 | head -100
```

### Advanced Process Namespace Debugging

```bash
# Inside a debug container with shareProcessNamespace=true:

# 1. Find a stuck goroutine in a Go application
APP_PID=$(pgrep -x server)
cat /proc/${APP_PID}/stack   # kernel-level stack trace

# 2. Send SIGQUIT to dump Go goroutine stacks
kill -3 ${APP_PID}
# Output goes to the container's stderr - check logs

# 3. Attach gdb to a running process
gdb -p ${APP_PID}
# (gdb) bt     <- backtrace
# (gdb) info threads
# (gdb) thread apply all bt

# 4. Capture system call profile
strace -c -p ${APP_PID} -f &
STRACE_PID=$!
sleep 10
kill ${STRACE_PID}
# Summary of syscall counts and timing

# 5. Check for file descriptor leaks
FD_COUNT=$(ls /proc/${APP_PID}/fd | wc -l)
echo "Process ${APP_PID} has ${FD_COUNT} open file descriptors"
ls -la /proc/${APP_PID}/fd | tail -20

# Alert threshold (typical limit is 1024 FDs per process)
if [[ ${FD_COUNT} -gt 900 ]]; then
    echo "WARNING: FD leak suspected"
fi

# 6. Memory analysis
# Check for memory fragmentation
cat /proc/${APP_PID}/smaps | \
    awk '/^Rss:/ {rss+=$2} /^Size:/ {size+=$2} END {print "RSS:", rss, "KB; Size:", size, "KB"}'

# Check heap vs stack
cat /proc/${APP_PID}/maps | grep -E "\[heap\]|\[stack\]"
```

## Section 3: Debug Profiles

`kubectl debug` supports profiles that configure sets of defaults for common debugging scenarios.

### Built-in Profiles

```bash
# Default profile: minimal permissions
kubectl debug -it pod/my-pod \
    --image=busybox \
    --profile=default \
    -- sh

# General profile: includes standard debugging capabilities
kubectl debug -it pod/my-pod \
    --image=nicolaka/netshoot \
    --profile=general \
    -- bash

# Restricted profile: respects PodSecurityStandards Restricted policy
kubectl debug -it pod/my-pod \
    --image=busybox \
    --profile=restricted \
    -- sh

# Sysadmin profile: adds SYS_PTRACE, SYS_CHROOT, NET_RAW capabilities
kubectl debug -it pod/my-pod \
    --image=ubuntu:22.04 \
    --profile=sysadmin \
    -- bash

# Netadmin profile: adds NET_ADMIN, NET_RAW for network debugging
kubectl debug -it pod/my-pod \
    --image=nicolaka/netshoot \
    --profile=netadmin \
    -- bash

# Node debugging profile: for kubectl debug node/ commands
kubectl debug node/worker-1 \
    -it \
    --image=ubuntu:22.04 \
    --profile=sysadmin \
    -- bash
```

### Profile Details

The profiles set different securityContext configurations:

```yaml
# sysadmin profile adds:
securityContext:
  capabilities:
    add:
      - SYS_PTRACE   # strace, gdb
      - SYS_CHROOT   # chroot into container filesystem
      - NET_RAW      # raw socket access
      - NET_ADMIN    # network configuration
  privileged: false  # still not fully privileged
  runAsNonRoot: false

# netadmin profile adds:
securityContext:
  capabilities:
    add:
      - NET_ADMIN
      - NET_RAW
  runAsUser: 0  # root (needed for raw sockets)
```

## Section 4: Custom Debug Image Strategy

### Building a Production-Ready Debug Image

```dockerfile
# debug/Dockerfile
FROM ubuntu:22.04

# Network debugging
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl wget netcat-openbsd nmap \
    dnsutils net-tools iproute2 \
    tcpdump wireshark-common \
    iperf3 socat \
    && rm -rf /var/lib/apt/lists/*

# Process debugging
RUN apt-get update && apt-get install -y --no-install-recommends \
    procps lsof strace ltrace \
    gdb perf-tools-unstable \
    htop sysstat iotop \
    && rm -rf /var/lib/apt/lists/*

# Language-specific debuggers
# Go
RUN curl -Lo /usr/local/bin/dlv \
    "https://github.com/go-delve/delve/releases/download/v1.22.1/dlv_1.22.1_linux_amd64.tar.gz" | \
    tar xz -C /usr/local/bin/

# JVM tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    default-jdk-headless \
    && rm -rf /var/lib/apt/lists/*

# Filesystem debugging
RUN apt-get update && apt-get install -y --no-install-recommends \
    ncdu tree file binutils \
    && rm -rf /var/lib/apt/lists/*

# Scripting tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    jq yq python3 python3-pip \
    vim less bash-completion \
    && rm -rf /var/lib/apt/lists/*

# kubectl for cluster operations
RUN curl -Lo /usr/local/bin/kubectl \
    "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" && \
    chmod +x /usr/local/bin/kubectl

COPY debug-helpers.sh /usr/local/bin/debug-helpers
RUN chmod +x /usr/local/bin/debug-helpers

ENTRYPOINT ["/bin/bash"]
CMD ["-l"]
```

```bash
# debug/debug-helpers.sh - Common debugging functions

#!/bin/bash
# Functions available inside debug container

# Show top goroutines for a Go process
go_goroutines() {
    local pid="${1:-$(pgrep -x server || pgrep -x app)}"
    kill -3 "${pid}"
    echo "SIGQUIT sent to PID ${pid} - check container stderr for goroutine dump"
}

# Capture a network trace for 30 seconds
network_trace() {
    local iface="${1:-eth0}"
    local duration="${2:-30}"
    local output="${3:-/tmp/capture-$(date +%Y%m%d-%H%M%S).pcap}"
    tcpdump -i "${iface}" -w "${output}" -G "${duration}" -W 1
    echo "Capture saved to ${output}"
}

# Show all TCP connections by state
tcp_connections() {
    ss -tn state "$1" 2>/dev/null || netstat -tn | grep "$1"
}

# Memory usage breakdown
memory_breakdown() {
    local pid="${1:-$(pgrep -x server || pgrep -x app)}"
    echo "=== Memory breakdown for PID ${pid} ==="
    cat /proc/${pid}/status | grep -E "VmRSS|VmSize|VmHWM|VmSwap|Threads"
    echo ""
    echo "=== Top memory maps ==="
    cat /proc/${pid}/smaps | \
        awk '/^[0-9a-f]/ {map=$1} /^Rss:/ {rss=$2; print rss, map}' | \
        sort -rn | head -20
}

# DNS resolution debug
dns_debug() {
    local hostname="$1"
    echo "=== DNS resolution for ${hostname} ==="
    dig "${hostname}" A +short
    dig "${hostname}" AAAA +short
    echo "=== Cluster DNS resolver ==="
    cat /etc/resolv.conf
    echo "=== NXDOMAIN test ==="
    nslookup "${hostname}" 2>&1 | head -10
}

export -f go_goroutines network_trace tcp_connections memory_breakdown dns_debug
echo "Debug helpers loaded. Available: go_goroutines, network_trace, tcp_connections, memory_breakdown, dns_debug"
```

Build and push:

```bash
docker build -t registry.example.com/internal/debug-tools:latest debug/
docker push registry.example.com/internal/debug-tools:latest
```

### Using the Custom Debug Image

```bash
# Use custom debug image
kubectl debug -it pod/api-server-7d8f6b9c4-xkz9t \
    --image=registry.example.com/internal/debug-tools:latest \
    --profile=sysadmin \
    --target=api-server \
    -- bash

# Or with shareProcessNamespace copy
kubectl debug pod/api-server-7d8f6b9c4-xkz9t \
    -it \
    --image=registry.example.com/internal/debug-tools:latest \
    --profile=sysadmin \
    --share-processes \
    --copy-to=api-server-debug \
    -- bash -c "source /usr/local/bin/debug-helpers && bash"
```

## Section 5: Debugging Specific Production Scenarios

### Scenario 1: Debugging High Memory Usage in a Distroless Container

```bash
# Step 1: Create a debug copy with process namespace sharing
kubectl debug pod/go-app-75d9b6f84-n2kp7 \
    --image=registry.example.com/internal/debug-tools:latest \
    --profile=sysadmin \
    --share-processes \
    --copy-to=go-app-memdebug \
    -n production \
    -- bash

# Step 2: Inside the debug session
APP_PID=$(pgrep -f "go-app")
echo "Target PID: ${APP_PID}"

# Step 3: Check memory maps
cat /proc/${APP_PID}/smaps_rollup
# Output:
# Rss:            2048 MB  <- current RSS
# Pss:            2045 MB
# Shared_Clean:      3 MB
# Private_Dirty:  2045 MB  <- most memory is private dirty (heap)

# Step 4: Find largest heap allocations (Go pprof)
# If the app exposes pprof on :6060
curl -s http://localhost:6060/debug/pprof/heap > /tmp/heap.prof
# Transfer and analyze with go tool pprof

# Step 5: Use delve for live inspection
dlv attach ${APP_PID}
# (dlv) goroutines  <- list all goroutines
# (dlv) goroutine 5 bt  <- stack trace of goroutine 5

# Step 6: Clean up
kubectl delete pod go-app-memdebug -n production
```

### Scenario 2: Network Connectivity Investigation

```bash
# Pod can't connect to external service
kubectl debug -it pod/payment-service-xyz \
    --image=nicolaka/netshoot:latest \
    --profile=netadmin \
    --target=payment-service \
    -- bash

# Inside netshoot:
# 1. Check DNS resolution
dig api.payment-provider.com A
nslookup api.payment-provider.com

# 2. Check if the target IP is reachable
PAYMENT_IP=$(dig +short api.payment-provider.com A | head -1)
ping -c 3 "${PAYMENT_IP}"
traceroute "${PAYMENT_IP}"

# 3. Check TCP connectivity
nc -zv "${PAYMENT_IP}" 443
curl -v --max-time 5 "https://api.payment-provider.com/health"

# 4. Check network policy
# List current iptables rules (if no network policy, should be empty)
iptables -L -n | grep -E "REJECT|DROP"

# 5. Verify DNS search domain
cat /etc/resolv.conf
# Expected: search payment-service.svc.cluster.local svc.cluster.local cluster.local

# 6. Capture traffic
tcpdump -i eth0 -n host "${PAYMENT_IP}" -w /tmp/payment-traffic.pcap &
TCPDUMP_PID=$!
curl -v "https://api.payment-provider.com/health" 2>&1
kill ${TCPDUMP_PID}
# Copy pcap: kubectl cp payment-service-xyz:/tmp/payment-traffic.pcap ./
```

### Scenario 3: Debugging a CrashLooping Container

```bash
# The container is crashing before we can attach
# Strategy: create a copy with the entrypoint replaced

# Create a copy with sleep entrypoint to prevent crash loop
kubectl debug pod/crashing-app-xyz \
    -it \
    --image=busybox:latest \
    --share-processes \
    --copy-to=crashing-app-debug \
    -- sh

# Now the pod runs with our debug container
# We can inspect the original container's environment

# Check environment variables of the original container
# (if using shareProcessNamespace, check its /proc)
APP_PID=$(ps aux | grep app | grep -v grep | awk '{print $1}' | head -1)
if [[ -n "${APP_PID}" ]]; then
    cat /proc/${APP_PID}/environ | tr '\0' '\n'
fi

# Check mounted volumes
cat /proc/1/mountinfo | grep -v "^1 "

# Look for the config files
find /proc/1/root/ -name "*.yaml" -o -name "*.json" -o -name "*.conf" 2>/dev/null \
    | grep -v "^/proc/1/root/proc\|^/proc/1/root/sys"

# Manually run the application command to see what error occurs
/proc/1/root/app/server --config=/proc/1/root/etc/app/config.yaml 2>&1
```

### Scenario 4: Debugging Init Container Failures

```bash
# Check init container logs
kubectl logs pod/app-xyz --container=init-migration --previous

# If init container exits too fast to inspect, create a debug version
# Get the pod spec
kubectl get pod app-xyz -o yaml > /tmp/app-debug.yaml

# Edit to change init container command to sleep
# Change:
#   command: ["/app/migrate"]
# To:
#   command: ["sh", "-c", "sleep 3600"]

# Apply debug pod
kubectl apply -f /tmp/app-debug.yaml --dry-run=client
kubectl delete pod app-xyz
kubectl apply -f /tmp/app-debug.yaml

# Exec into the init container while it's sleeping
kubectl exec -it app-xyz --container=init-migration -- sh

# Manually run the migration command
/app/migrate --check-only
/app/migrate --verbose 2>&1 | tee /tmp/migration.log
```

## Section 6: Ephemeral Container Lifecycle Management

### Viewing Ephemeral Containers

```bash
# List ephemeral containers on a pod
kubectl get pod api-server-debug \
    -o jsonpath='{.spec.ephemeralContainers[*].name}'

# Full details of ephemeral containers
kubectl get pod api-server-debug \
    -o jsonpath='{.spec.ephemeralContainers}' | jq .

# Check ephemeral container status
kubectl get pod api-server-debug \
    -o jsonpath='{.status.ephemeralContainerStatuses}' | jq .
```

### Ephemeral Container Limitations

Understanding limitations prevents frustration:

```bash
# Ephemeral containers:
# - Cannot be deleted (only terminated by stopping the session)
# - Cannot specify resource limits (the pod's limit applies)
# - Cannot add volumes (can access existing volumes if target container mounts them)
# - Cannot be added to a pod that has no volumes configured
# - Cannot restart (if they exit, they're gone)
# - Are not included in pod restarts

# Check if an ephemeral container has exited
kubectl get pod api-server-debug \
    -o jsonpath='{.status.ephemeralContainerStatuses[?(@.name=="debug")].state}' | jq .

# Re-attach to an existing ephemeral container session (if it's still running)
kubectl attach -it api-server-debug --container=debug
```

### Cleanup After Debugging

```bash
# Since ephemeral containers can't be removed, restart the pod to clear them
# For Deployments (safe: creates replacement first)
kubectl rollout restart deployment/api-server -n production

# For standalone pods
kubectl delete pod api-server-debug
# Then recreate from your normal deployment

# For debug copies created with --copy-to
kubectl delete pod api-server-debug -n production

# Cleanup script
#!/bin/bash
# cleanup-debug-pods.sh
# Find and delete debug copy pods

NAMESPACE="${1:-default}"
kubectl get pods -n "${NAMESPACE}" \
    -l "app.kubernetes.io/component=debug-copy" \
    -o name | xargs kubectl delete -n "${NAMESPACE}"
```

## Section 7: RBAC for Debug Access

### Restricting kubectl debug

```yaml
# rbac-debug.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: pod-debugger
rules:
  # Required for kubectl debug
  - apiGroups: [""]
    resources: ["pods/ephemeralcontainers"]
    verbs: ["update", "patch"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods/attach", "pods/exec"]
    verbs: ["create"]
  # For kubectl debug --copy-to
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["create", "delete"]
  # For kubectl debug node/
  - apiGroups: [""]
    resources: ["nodes"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: node-debugger
rules:
  # For kubectl debug node/
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["create", "get", "list", "delete"]
  - apiGroups: [""]
    resources: ["pods/attach", "pods/exec"]
    verbs: ["create"]
  - apiGroups: [""]
    resources: ["nodes"]
    verbs: ["get", "list"]
---
# Grant to SRE team
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: sre-pod-debugger
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: pod-debugger
subjects:
  - kind: Group
    name: sre-team
    apiGroup: rbac.authorization.k8s.io
```

### Audit Logging for Debug Sessions

```yaml
# audit-policy.yaml - log all kubectl debug operations
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
  # Log debug container creation at RequestResponse level
  - level: RequestResponse
    resources:
      - group: ""
        resources: ["pods/ephemeralcontainers"]
    verbs: ["update", "patch"]
    stages: [ResponseComplete]

  # Log exec sessions
  - level: Metadata
    resources:
      - group: ""
        resources: ["pods/exec", "pods/attach"]
    stages: [RequestReceived]
```

## Section 8: Automation and Runbooks

### Automated Debug Pod for Incident Response

```bash
#!/bin/bash
# incident-debug.sh
# Quickly create a debug pod with the right tools for common incident types

INCIDENT_TYPE="${1:-general}"
TARGET_POD="${2}"
NAMESPACE="${3:-default}"

DEBUG_IMAGE="registry.example.com/internal/debug-tools:latest"

case "${INCIDENT_TYPE}" in
  network)
    IMAGE="nicolaka/netshoot:latest"
    PROFILE="netadmin"
    CMD="bash"
    ;;
  memory)
    IMAGE="${DEBUG_IMAGE}"
    PROFILE="sysadmin"
    CMD="bash -c 'source /usr/local/bin/debug-helpers && memory_breakdown && bash'"
    ;;
  cpu)
    IMAGE="${DEBUG_IMAGE}"
    PROFILE="sysadmin"
    CMD="bash"
    ;;
  general|*)
    IMAGE="${DEBUG_IMAGE}"
    PROFILE="general"
    CMD="bash"
    ;;
esac

if [[ -z "${TARGET_POD}" ]]; then
    echo "Usage: $0 <network|memory|cpu|general> <pod-name> [namespace]"
    exit 1
fi

echo "Starting ${INCIDENT_TYPE} debug session for ${NAMESPACE}/${TARGET_POD}"
echo "Image: ${IMAGE}"
echo "Profile: ${PROFILE}"

kubectl debug -it \
    "pod/${TARGET_POD}" \
    -n "${NAMESPACE}" \
    --image="${IMAGE}" \
    --profile="${PROFILE}" \
    --share-processes \
    --copy-to="${TARGET_POD}-debug-$(date +%s)" \
    -- ${CMD}

echo ""
echo "Debug session ended. Remember to clean up debug pod:"
echo "kubectl delete pod ${TARGET_POD}-debug-* -n ${NAMESPACE}"
```

### Pod Annotation-Based Debug Config

```yaml
# Annotate production pods with suggested debug image
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: production
spec:
  template:
    metadata:
      annotations:
        # Hint for operators: use this image for debugging
        debug.kubernetes.io/image: "registry.example.com/internal/debug-tools:latest"
        debug.kubernetes.io/profile: "sysadmin"
        debug.kubernetes.io/docs: "https://wiki.example.com/runbooks/api-server-debug"
```

```bash
# Script that reads the annotation
#!/bin/bash
# smart-debug.sh

POD="$1"
NAMESPACE="${2:-default}"

IMAGE=$(kubectl get pod "${POD}" -n "${NAMESPACE}" \
    -o jsonpath='{.metadata.annotations.debug\.kubernetes\.io/image}')
PROFILE=$(kubectl get pod "${POD}" -n "${NAMESPACE}" \
    -o jsonpath='{.metadata.annotations.debug\.kubernetes\.io/profile}')
DOCS=$(kubectl get pod "${POD}" -n "${NAMESPACE}" \
    -o jsonpath='{.metadata.annotations.debug\.kubernetes\.io/docs}')

IMAGE="${IMAGE:-nicolaka/netshoot:latest}"
PROFILE="${PROFILE:-general}"

if [[ -n "${DOCS}" ]]; then
    echo "Runbook: ${DOCS}"
fi

kubectl debug -it "pod/${POD}" \
    -n "${NAMESPACE}" \
    --image="${IMAGE}" \
    --profile="${PROFILE}" \
    --share-processes \
    --copy-to="${POD}-debug" \
    -- bash
```

## Conclusion

Ephemeral containers eliminate the architectural conflict between minimal production images and operational debuggability. The key patterns are: use `--share-processes` with `--copy-to` when you need to inspect running processes (most memory, CPU, and deadlock issues), use direct injection without process sharing for network and filesystem debugging, build a standard debug image with your team's preferred tools and store it in your internal registry, and annotate production deployments with the appropriate debug image so on-call engineers can immediately attach with the right toolset. RBAC control over `pods/ephemeralcontainers` ensures that debug access is audited and appropriately restricted in regulated environments.
