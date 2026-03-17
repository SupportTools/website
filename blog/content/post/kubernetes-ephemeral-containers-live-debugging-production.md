---
title: "Kubernetes Ephemeral Containers: Live Debugging in Production"
date: 2029-05-24T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Debugging", "Ephemeral Containers", "kubectl debug", "Production", "Containers"]
categories: ["Kubernetes", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes ephemeral containers covering kubectl debug command, ephemeral container specs, debug images like nicolaka/netshoot, sidecar debugging patterns, and process namespace sharing for live production debugging."
more_link: "yes"
url: "/kubernetes-ephemeral-containers-live-debugging-production/"
---

Debugging production containers has historically required one of three bad options: shipping a fat image full of debugging tools, adding a sidecar container upfront (wasting resources), or exec-ing into the container and hoping the tools you need are there. Ephemeral containers solve all three problems: they inject a temporary debug container into a running pod on demand, with their own filesystem and toolset, without modifying the running application. This guide covers everything you need to know to debug production Kubernetes pods effectively.

<!--more-->

# Kubernetes Ephemeral Containers: Live Debugging in Production

## What Are Ephemeral Containers?

Ephemeral containers are a special type of container that can be added to a running pod after the pod has started. Unlike regular containers:

- They cannot have resource limits (they inherit pod limits)
- They cannot be removed once added (only terminated)
- They don't restart if they exit
- They don't appear in pod.spec.containers — they're in pod.spec.ephemeralContainers
- They can share the process namespace of other containers in the pod

Ephemeral containers graduated to stable in Kubernetes 1.25 and are enabled by default in all modern clusters.

## Section 1: The kubectl debug Command

### Basic Usage

```bash
# Attach a debug container to a running pod
kubectl debug -it my-pod --image=busybox -- sh

# Use a more capable debug image
kubectl debug -it my-pod --image=nicolaka/netshoot -- bash

# Specify a namespace
kubectl debug -it my-pod -n production --image=ubuntu:22.04 -- bash

# Specify container name (if pod has multiple containers)
kubectl debug -it my-pod -c app-container --image=busybox -- sh

# Share process namespace (see all processes in the pod)
kubectl debug -it my-pod --image=nicolaka/netshoot --share-processes -- bash
```

### Creating a Debug Copy of a Pod

Sometimes you want to debug a pod by creating a modified copy:

```bash
# Create a copy of the pod with all containers replaced by a debug image
kubectl debug my-pod -it --copy-to=my-pod-debug --image=ubuntu:22.04

# Create a copy with a specific container replaced
kubectl debug my-pod -it --copy-to=my-pod-debug \
  --image=ubuntu:22.04 \
  --container=app-container

# Create a copy with the original containers but add a debug sidecar
kubectl debug my-pod -it --copy-to=my-pod-debug \
  --image=nicolaka/netshoot \
  --share-processes

# Delete the debug pod when done
kubectl delete pod my-pod-debug
```

### Debugging Nodes

```bash
# Attach a privileged container to a node
kubectl debug node/worker-node-1 -it --image=ubuntu:22.04

# The node's filesystem is mounted at /host
ls /host/etc/
ls /host/var/log/

# Run nsenter to enter a container's namespaces
# Find container PID on the node
ps aux | grep my-container-process
nsenter -t <PID> -n -m -u -i -p -- bash
```

## Section 2: Ephemeral Container Specification

### Direct API Manipulation

While `kubectl debug` is the primary interface, you can also manipulate ephemeral containers directly:

```yaml
# ephemeral-container-patch.yaml
# This is the patch format for adding an ephemeral container
{
  "spec": {
    "ephemeralContainers": [
      {
        "name": "debugger",
        "image": "nicolaka/netshoot",
        "command": ["bash"],
        "stdin": true,
        "tty": true,
        "targetContainerName": "app",
        "securityContext": {
          "capabilities": {
            "add": ["NET_ADMIN", "SYS_PTRACE"]
          }
        },
        "env": [
          {
            "name": "DEBUG_TARGET",
            "value": "app-container"
          }
        ]
      }
    ]
  }
}
```

```bash
# Apply the patch
kubectl patch pod my-pod --subresource ephemeralcontainers \
  --type merge -p "$(cat ephemeral-container-patch.yaml)"

# Wait for the ephemeral container to start
kubectl wait pod my-pod --for=condition=ContainersReady

# Attach to it
kubectl attach -it my-pod -c debugger
```

### Full Ephemeral Container Spec

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: example-pod
spec:
  containers:
  - name: app
    image: my-app:latest

  # Ephemeral containers added at runtime — not in initial spec
  ephemeralContainers:
  - name: debugger
    image: nicolaka/netshoot:latest

    # Command to run in the ephemeral container
    command: ["bash"]
    args: []

    # I/O settings for interactive debugging
    stdin: true
    stdinOnce: true
    tty: true

    # Target container to share namespaces with (requires shareProcessNamespace)
    targetContainerName: app

    # Environment variables
    env:
    - name: TERM
      value: xterm-256color

    # Volume mounts — can mount the same volumes as the target container
    volumeMounts:
    - name: app-data
      mountPath: /data
      readOnly: true
    - name: app-logs
      mountPath: /logs
      readOnly: true

    # Security context for debugging capabilities
    securityContext:
      capabilities:
        add:
        - NET_ADMIN
        - SYS_PTRACE
        - SYS_ADMIN
      runAsNonRoot: false
      runAsUser: 0  # root for debugging

    # Resources (optional for ephemeral containers but can be set)
    # Note: these are advisory only in ephemeral containers
    resources:
      limits:
        cpu: "500m"
        memory: "256Mi"
```

## Section 3: Debug Images

### nicolaka/netshoot — Network Debugging

`netshoot` is the Swiss Army knife for Kubernetes network debugging. It includes:

```bash
# Networking tools
tcpdump         # Packet capture
nmap            # Network scanning
traceroute      # Route tracing
mtr             # Network diagnostic
iperf / iperf3  # Bandwidth testing
netstat / ss    # Socket statistics
ping / hping3   # Connectivity testing
curl / wget     # HTTP debugging
dig / nslookup  # DNS debugging
iptables        # Firewall rules
ip / ifconfig   # Interface configuration

# SSL/TLS tools
openssl         # Certificate debugging
ncat / netcat   # Raw TCP/UDP

# Performance tools
top / htop / ps  # Process monitoring
vmstat / iostat  # System stats
perf            # Performance counters (if kernel supports)

# Kubernetes tools
kubectl         # K8s API access
helm            # Helm chart management
```

```bash
# Debug a DNS issue in a pod
kubectl debug -it my-pod --image=nicolaka/netshoot --share-processes -- bash

# Inside the debug container:
# Test DNS resolution
nslookup kubernetes.default.svc.cluster.local
dig +short A my-service.my-namespace.svc.cluster.local

# Check CoreDNS
nslookup my-service.my-namespace.svc.cluster.local 10.96.0.10  # CoreDNS ClusterIP

# Trace the DNS resolution path
dig +trace my-service.my-namespace.svc.cluster.local

# Capture DNS traffic
tcpdump -i eth0 -n port 53 -w /tmp/dns_capture.pcap
# In another terminal: kubectl cp my-pod:/tmp/dns_capture.pcap ./dns_capture.pcap
```

### BusyBox for Minimal Footprint

```bash
# Quick and minimal
kubectl debug -it my-pod --image=busybox:1.36 -- sh

# Check basic connectivity
wget -qO- http://other-service.namespace.svc.cluster.local/health

# Look at environment variables (service discovery)
env | grep -E "SERVICE|PORT|HOST"

# Check mounted volumes
df -h
ls -la /var/run/secrets/
cat /var/run/secrets/kubernetes.io/serviceaccount/token
```

### Ubuntu for Full Package Management

```bash
# Full-featured debugging environment
kubectl debug -it my-pod --image=ubuntu:22.04 -- bash

# Install tools on demand
apt-get update && apt-get install -y \
  strace ltrace gdb \
  net-tools iproute2 \
  tcpdump wireshark-cli \
  curl wget jq \
  htop procps \
  lsof

# For Go binary debugging
apt-get install -y golang-go
go tool pprof http://localhost:6060/debug/pprof/heap
```

### Custom Debug Images

Build a standardized debug image for your organization:

```dockerfile
# debug-tools/Dockerfile
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    # Network tools
    curl wget net-tools iproute2 iputils-ping \
    dnsutils tcpdump nmap netcat-openbsd \
    traceroute mtr \
    # Process tools
    procps strace ltrace gdb \
    lsof htop \
    # Debugging utilities
    vim less jq python3 python3-pip \
    # Database clients
    postgresql-client mysql-client redis-tools \
    # Certificate tools
    openssl ca-certificates \
    # Compression
    zip unzip gzip \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install kubectl
RUN curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" \
    && install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl \
    && rm kubectl

# Install grpc_health_probe for gRPC debugging
RUN GRPC_HEALTH_PROBE_VERSION=v0.4.28 && \
    wget -qO/bin/grpc_health_probe https://github.com/grpc-ecosystem/grpc-health-probe/releases/download/${GRPC_HEALTH_PROBE_VERSION}/grpc_health_probe-linux-amd64 && \
    chmod +x /bin/grpc_health_probe

# Install go tools for Go application debugging
RUN wget -O go.tar.gz "https://go.dev/dl/go1.22.0.linux-amd64.tar.gz" \
    && tar -C /usr/local -xzf go.tar.gz \
    && rm go.tar.gz

ENV PATH="/usr/local/go/bin:${PATH}"

# Pre-install common Go debug tools
RUN go install github.com/google/pprof@latest
RUN go install golang.org/x/perf/cmd/benchstat@latest

CMD ["bash"]
```

```bash
# Build and push
docker build -t registry.example.com/debug-tools:latest debug-tools/
docker push registry.example.com/debug-tools:latest

# Use in debugging
kubectl debug -it my-pod --image=registry.example.com/debug-tools:latest -- bash
```

## Section 4: Process Namespace Sharing

Process namespace sharing is the most powerful ephemeral container feature. It lets your debug container see and interact with processes in the target container.

### Enabling Process Namespace Sharing

```yaml
# In the Pod spec (must be set before pod creation for all containers)
apiVersion: v1
kind: Pod
metadata:
  name: shared-namespace-pod
spec:
  shareProcessNamespace: true  # ← This enables process namespace sharing
  containers:
  - name: app
    image: my-app:latest
  - name: debug
    image: nicolaka/netshoot
    command: ["sleep", "infinity"]
```

```bash
# Or when using kubectl debug (adds ephemeral container with shared namespace)
kubectl debug -it my-pod --image=nicolaka/netshoot --share-processes -- bash

# Inside the debug container, you can now see ALL processes:
ps aux
# PID   USER     TIME  COMMAND
#     1 root      0:00 /pause  ← infra container
#    12 appuser   0:42 /app/my-application --config=/etc/app/config.yaml
#    45 root      0:00 bash  ← this debug container's shell
```

### Advanced Process Debugging

```bash
# Attach strace to a running process
kubectl debug -it my-pod --image=ubuntu:22.04 --share-processes -- bash

# Inside debug container:
# Find the application's PID
ps aux | grep my-application
# 12 appuser   /app/my-application

# Trace system calls
strace -p 12 -f -e trace=file 2>&1 | head -50

# Trace file system calls specifically
strace -p 12 -e trace=open,close,read,write,stat 2>&1

# Trace network calls
strace -p 12 -e trace=network 2>&1

# Read /proc filesystem for the target process
ls /proc/12/
cat /proc/12/cmdline | tr '\0' ' '
cat /proc/12/environ | tr '\0' '\n'
ls -la /proc/12/fd/          # Open file descriptors
cat /proc/12/net/tcp          # TCP connections
cat /proc/12/status           # Memory and status info

# Inspect memory maps
cat /proc/12/maps
cat /proc/12/smaps | grep -E "^[0-9a-f]|Size:|Rss:|Shared_Clean:|Private_Dirty:"
```

### Debugging Memory Issues

```bash
# Find memory usage breakdown
kubectl debug -it my-pod --image=ubuntu:22.04 --share-processes -- bash

APP_PID=$(pgrep -f my-application)

# Total memory consumption
cat /proc/${APP_PID}/status | grep -E "VmRSS|VmSize|VmPeak"

# Detailed memory map analysis
cat /proc/${APP_PID}/smaps | awk '
/^[0-9a-f]/ {addr=$1}
/^Private_Dirty/ {sum+=$2}
END {print "Private dirty pages (KB):", sum}
'

# Check for memory leaks over time
for i in $(seq 1 10); do
    RSS=$(cat /proc/${APP_PID}/status | grep VmRSS | awk '{print $2}')
    echo "$(date): RSS = ${RSS} kB"
    sleep 5
done

# Generate heap dump for Go applications (if pprof enabled)
curl http://localhost:6060/debug/pprof/heap > /tmp/heap.prof
# Copy out: kubectl cp my-pod:/tmp/heap.prof ./heap.prof
# Analyze: go tool pprof heap.prof
```

### Debugging CPU Issues

```bash
# Get CPU profile from a Go app
kubectl debug -it my-pod --image=nicolaka/netshoot --share-processes -- bash

# Inside debug container:
# CPU profile for 30 seconds
curl -o /tmp/cpu.prof http://localhost:6060/debug/pprof/profile?seconds=30

# Check CPU-bound processes
top -b -n 3

# Use perf for detailed CPU analysis (requires privileged container)
perf top -p ${APP_PID}
perf record -p ${APP_PID} -g sleep 30
perf report --stdio
```

## Section 5: Sidecar Debugging Patterns

Ephemeral containers are great for ad-hoc debugging, but sometimes you want a persistent debug sidecar for specific workloads.

### Debug Sidecar in Development Deployments

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: development
spec:
  replicas: 1
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      shareProcessNamespace: true
      containers:
      - name: app
        image: my-app:latest

      # Debug sidecar — only in development
      - name: debug
        image: registry.example.com/debug-tools:latest
        command: ["sleep", "infinity"]
        resources:
          requests:
            cpu: "50m"
            memory: "64Mi"
          limits:
            cpu: "200m"
            memory: "256Mi"
        securityContext:
          capabilities:
            add:
            - SYS_PTRACE
```

```bash
# Exec into the debug sidecar directly
kubectl exec -it my-app-pod-xyz -c debug -- bash

# Use ps to see app processes (thanks to shareProcessNamespace)
ps aux | grep my-app
```

### Conditional Debug Sidecar via Kustomize

```yaml
# kustomize/base/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  template:
    spec:
      containers:
      - name: app
        image: my-app:latest

---
# kustomize/overlays/debug/deployment-patch.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  template:
    spec:
      shareProcessNamespace: true
      containers:
      - name: debug
        image: registry.example.com/debug-tools:latest
        command: ["sleep", "infinity"]
```

```bash
# Deploy with debug sidecar in development
kubectl apply -k kustomize/overlays/debug/

# Deploy without debug sidecar in production
kubectl apply -k kustomize/base/
```

## Section 6: Security Considerations

### RBAC for Ephemeral Containers

Ephemeral containers require specific RBAC permissions:

```yaml
# rbac-ephemeral-debug.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: ephemeral-container-debug
rules:
# Permission to get/list pods (needed to identify target)
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list"]
# Permission to add ephemeral containers (note: uses update on pods/ephemeralcontainers)
- apiGroups: [""]
  resources: ["pods/ephemeralcontainers"]
  verbs: ["update", "get"]
# Permission to exec into pods (for kubectl debug -it)
- apiGroups: [""]
  resources: ["pods/exec"]
  verbs: ["create"]
# Permission to attach to pods
- apiGroups: [""]
  resources: ["pods/attach"]
  verbs: ["create"]
# Permission to see pod logs
- apiGroups: [""]
  resources: ["pods/log"]
  verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: platform-team-debug
subjects:
- kind: Group
  name: platform-engineers
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: ephemeral-container-debug
  apiGroup: rbac.authorization.k8s.io
```

### Restricting Debug Images with Admission Control

```yaml
# Only allow approved debug images in ephemeral containers
# OPA/Gatekeeper policy
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sAllowedEphemeralContainerImages
metadata:
  name: ephemeral-container-image-policy
spec:
  match:
    kinds:
    - apiGroups: [""]
      kinds: ["Pod"]
  parameters:
    allowedImages:
    - "registry.example.com/debug-tools:*"
    - "nicolaka/netshoot:*"
    - "busybox:*"
    - "ubuntu:*"
```

```rego
# opa-policy/ephemeral-images.rego
package kubernetes.admission

import future.keywords.in

deny[msg] {
    input.request.operation == "EPHEMERALCONTAINERS"
    container := input.request.object.spec.ephemeralContainers[_]
    not image_allowed(container.image)
    msg := sprintf("Ephemeral container image '%v' is not allowed", [container.image])
}

image_allowed(image) {
    allowed_prefixes := [
        "registry.example.com/debug-tools:",
        "nicolaka/netshoot:",
        "busybox:",
        "ubuntu:",
    ]
    prefix := allowed_prefixes[_]
    startswith(image, prefix)
}
```

### Audit Logging for Debug Sessions

```yaml
# audit-policy.yaml — log ephemeral container operations
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
# Log ephemeral container creations (high priority for security)
- level: Request
  resources:
  - group: ""
    resources: ["pods/ephemeralcontainers"]
  verbs: ["update"]
  namespaces: ["production", "staging"]

# Log pod exec operations (someone is debugging)
- level: RequestResponse
  resources:
  - group: ""
    resources: ["pods/exec", "pods/attach"]
  verbs: ["create"]
  namespaces: ["production"]

# Omit read-only and routine operations
- level: None
  resources:
  - group: ""
    resources: ["pods", "services"]
  verbs: ["get", "list", "watch"]
```

## Section 7: Practical Debugging Scenarios

### Scenario 1: Debugging a Crashlooping Container

```bash
# Pod is crashlooping — can't exec into it normally
kubectl get pod my-pod -n production
# NAME     READY   STATUS             RESTARTS   AGE
# my-pod   0/1     CrashLoopBackOff   23         1h

# Create a debug copy with the app container replaced
kubectl debug my-pod -n production \
  --copy-to=my-pod-debug \
  --image=ubuntu:22.04 \
  --container=app \
  -it -- bash

# Inside the debug container, with the original pod volumes mounted:
# Check what the application needs
cat /etc/app/config.yaml
ls -la /var/data/
env | sort

# Try running the application manually with debug flags
/app/my-application --config=/etc/app/config.yaml --log-level=debug 2>&1 | head -50

# Clean up
kubectl delete pod my-pod-debug -n production
```

### Scenario 2: Network Connectivity Issue

```bash
# App can't reach its database
kubectl debug -it my-app-pod -n production \
  --image=nicolaka/netshoot \
  --share-processes -- bash

# Inside debug container:
# Check DNS resolution
nslookup postgres.production.svc.cluster.local
dig A postgres.production.svc.cluster.local

# Check TCP connectivity
nc -zv postgres.production.svc.cluster.local 5432
# Connection to postgres.production.svc.cluster.local (10.96.0.100) 5432 port [tcp/postgresql] succeeded!

# Check if there's a network policy blocking traffic
# (we can see the routing from inside the pod's network namespace)
ip route
iptables -L -n | grep -E "REJECT|DROP" | head -20

# Trace the actual connection
tcpdump -i eth0 -n host 10.96.0.100 and port 5432 -c 20

# Try connecting with postgres client
PGPASSWORD=password psql -h postgres.production.svc.cluster.local -U app -d mydb -c "SELECT 1"
```

### Scenario 3: Debugging a Go Application with pprof

```bash
# App has memory leak — need to capture heap profile
kubectl debug -it my-go-app-pod -n production \
  --image=ubuntu:22.04 \
  --share-processes -- bash

# Inside debug container:
apt-get update -q && apt-get install -y -q golang-go curl

# Capture heap profile (requires pprof endpoint in the app)
curl -s http://localhost:6060/debug/pprof/heap -o /tmp/heap.prof

# Capture goroutine dump
curl -s http://localhost:6060/debug/pprof/goroutine -o /tmp/goroutine.prof

# Capture 30-second CPU profile
curl -s "http://localhost:6060/debug/pprof/profile?seconds=30" -o /tmp/cpu.prof

# Copy profiles out for analysis
# In another terminal:
kubectl cp production/my-go-app-pod:/tmp/heap.prof ./heap.prof
kubectl cp production/my-go-app-pod:/tmp/cpu.prof ./cpu.prof

# Analyze locally
go tool pprof -http=:8080 heap.prof
go tool pprof -http=:8081 cpu.prof
```

### Scenario 4: TLS Certificate Investigation

```bash
kubectl debug -it my-app-pod -n production \
  --image=nicolaka/netshoot -- bash

# Check what certificate the app is using
openssl s_client -connect api.example.com:443 -showcerts 2>/dev/null | \
  openssl x509 -noout -text | \
  grep -E "Subject:|Issuer:|Not After|DNS:"

# Check the certificate in a Kubernetes secret
# (from inside the pod we can still use kubectl if service account has permissions)
kubectl get secret app-tls -n production -o jsonpath='{.data.tls\.crt}' | \
  base64 -d | openssl x509 -noout -text

# Check certificate expiration
openssl s_client -connect internal-service.production.svc.cluster.local:8443 2>/dev/null | \
  openssl x509 -noout -enddate
```

## Section 8: Automating Debug Sessions

### Debug Session Script

```bash
#!/bin/bash
# kube-debug.sh — Automated ephemeral container debugging

set -euo pipefail

POD="${1:?Usage: $0 <pod-name> [namespace] [debug-image]}"
NAMESPACE="${2:-default}"
DEBUG_IMAGE="${3:-nicolaka/netshoot}"
CONTAINER_NAME="debugger-$(date +%s)"

echo "Attaching debug container to ${POD} in namespace ${NAMESPACE}"
echo "Debug image: ${DEBUG_IMAGE}"
echo ""

# Check if pod exists and is running
POD_STATUS=$(kubectl get pod "${POD}" -n "${NAMESPACE}" -o jsonpath='{.status.phase}' 2>/dev/null || echo "NotFound")

if [[ "${POD_STATUS}" == "NotFound" ]]; then
    echo "ERROR: Pod ${POD} not found in namespace ${NAMESPACE}"
    exit 1
fi

echo "Pod status: ${POD_STATUS}"
echo ""

# Determine if we need --share-processes
if [[ "${POD_STATUS}" == "Running" ]]; then
    echo "Adding ephemeral container..."
    kubectl debug -it "${POD}" -n "${NAMESPACE}" \
        --image="${DEBUG_IMAGE}" \
        --container="${CONTAINER_NAME}" \
        --share-processes \
        -- bash
else
    echo "Pod is not running, creating debug copy..."
    DEBUG_POD="${POD}-debug-$(date +%s)"

    kubectl debug "${POD}" -n "${NAMESPACE}" \
        --copy-to="${DEBUG_POD}" \
        --image="${DEBUG_IMAGE}" \
        -it -- bash

    echo ""
    echo "Cleaning up debug pod ${DEBUG_POD}..."
    kubectl delete pod "${DEBUG_POD}" -n "${NAMESPACE}" --ignore-not-found
fi
```

### Automated Health Check Debug

```bash
#!/bin/bash
# auto-debug.sh — Automatically debug failing pods

NAMESPACE="${1:-production}"

# Find pods with restarts > 5
FAILING_PODS=$(kubectl get pods -n "${NAMESPACE}" -o json | jq -r '
.items[] |
select(.status.containerStatuses[]? | .restartCount > 5) |
.metadata.name')

for POD in ${FAILING_PODS}; do
    echo "=== Debugging ${POD} ==="

    # Get last termination reason
    kubectl get pod "${POD}" -n "${NAMESPACE}" -o json | jq '
    .status.containerStatuses[] |
    {
        name: .name,
        restartCount: .restartCount,
        lastState: .lastState.terminated
    }'

    # Get recent logs
    echo "--- Recent Logs ---"
    kubectl logs "${POD}" -n "${NAMESPACE}" --tail=50 --previous 2>/dev/null || \
        kubectl logs "${POD}" -n "${NAMESPACE}" --tail=50

    echo ""
done
```

## Conclusion

Ephemeral containers represent a fundamental shift in how we debug Kubernetes workloads. They decouple the debugging toolset from the application image, allowing us to ship minimal production images while retaining full debugging capabilities on demand. The key patterns to internalize are: use `nicolaka/netshoot` for network debugging, use `--share-processes` to inspect target container processes, build a standardized organizational debug image, and implement RBAC controls to govern who can attach debug containers to production pods.

The process namespace sharing feature is particularly powerful — being able to run `strace -p <PID>`, inspect `/proc/<PID>/fd`, and read environment variables of the running application without modifying it is exactly the kind of surgical debugging that production incidents require.
