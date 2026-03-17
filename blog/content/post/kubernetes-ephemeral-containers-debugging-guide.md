---
title: "Kubernetes Ephemeral Containers: Live Debugging Without Restarting Pods"
date: 2028-01-26T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Debugging", "Ephemeral Containers", "Observability", "Security", "kubectl"]
categories: ["Kubernetes", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Kubernetes ephemeral containers for live debugging of distroless and minimal images, including process namespace sharing, netshoot toolkits, strace, tcpdump, and node-level debugging."
more_link: "yes"
url: "/kubernetes-ephemeral-containers-debugging-guide/"
---

Debugging production containers has historically meant one of three bad options: shipping debug tools in production images (increasing attack surface), exec-ing into a running container and hoping it has the tools you need, or killing and recreating the pod with a debug build. Kubernetes ephemeral containers, stable since 1.25, solve this problem elegantly. An ephemeral container injects a debug-capable sidecar into a running pod without restarting it, sharing the target container's filesystem, process namespace, and network namespace on demand.

<!--more-->

# Kubernetes Ephemeral Containers: Live Debugging Without Restarting Pods

## What Are Ephemeral Containers

Ephemeral containers differ from regular containers in several important ways:

- They have no ports, no readiness or liveness probes, and no resource guarantees
- They cannot be removed once added — the pod must be deleted
- They do not restart on failure
- They are intended for debugging only and should not run application workloads
- They share the pod's network namespace by default (same IP, same ports)
- With `shareProcessNamespace: true` on the pod spec, they share the process namespace

The kubectl debug command is the primary interface for creating ephemeral containers without writing raw YAML.

## Prerequisites and Version Requirements

```bash
# Verify the cluster supports ephemeral containers (requires 1.25+)
kubectl version --short

# Verify the kubelet feature gate is enabled (enabled by default since 1.25)
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.nodeInfo.kubeletVersion}{"\n"}{end}'

# Check if a specific pod already has ephemeral containers attached
kubectl get pod my-app-7d4b9c-xk2lm -o jsonpath='{.spec.ephemeralContainers}' | jq .
```

## Basic Ephemeral Container with kubectl debug

### Debugging a Running Pod

```bash
# Attach an ephemeral container using the busybox image
# This creates a shell session inside the running pod's network namespace
kubectl debug -it my-app-7d4b9c-xk2lm \
  --image=busybox:1.36 \
  --container=debugger \
  -- sh

# Use nicolaka/netshoot for comprehensive network debugging tools
# netshoot includes: tcpdump, curl, dig, nmap, iperf3, ss, ip, traceroute, and more
kubectl debug -it my-app-7d4b9c-xk2lm \
  --image=nicolaka/netshoot:latest \
  --container=netshoot \
  -- bash

# Profile a running process with specific debugging tools
kubectl debug -it my-app-7d4b9c-xk2lm \
  --image=ubuntu:22.04 \
  --container=debug-tools \
  -- bash
```

### Checking Ephemeral Container Status

```bash
# View the pod spec including ephemeral containers
kubectl describe pod my-app-7d4b9c-xk2lm | grep -A 20 "Ephemeral Containers:"

# Watch ephemeral container state changes
kubectl get pod my-app-7d4b9c-xk2lm -w -o custom-columns=\
NAME:.metadata.name,\
EPHEMERAL:.spec.ephemeralContainers[*].name,\
STATE:.status.ephemeralContainerStatuses[*].state

# Get ephemeral container logs
kubectl logs my-app-7d4b9c-xk2lm -c debugger
```

## Process Namespace Sharing

Without process namespace sharing, an ephemeral container cannot see the processes in other containers. For most debugging scenarios, the pod spec should have `shareProcessNamespace: true`. However, this setting cannot be retroactively added — it must be configured when the pod is created.

### Pods with shareProcessNamespace

```yaml
# deployment with process namespace sharing enabled for debugging
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      # Enable process namespace sharing so ephemeral containers
      # can see and interact with processes from other containers
      shareProcessNamespace: true
      containers:
        - name: app
          image: gcr.io/my-org/my-app:1.5.3
          ports:
            - containerPort: 8080
          # Distroless image — no shell, no tools, minimal attack surface
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            runAsNonRoot: true
            runAsUser: 65534
```

### Using strace with Process Namespace Sharing

```bash
# Attach an ephemeral container with strace capability
kubectl debug -it my-app-7d4b9c-xk2lm \
  --image=ubuntu:22.04 \
  --container=strace-debugger \
  -- bash

# Inside the ephemeral container:
# Install strace
apt-get update -qq && apt-get install -y -qq strace

# List all processes visible across the pod
ps aux

# Identify the target PID (e.g., the Go application)
# PID 1 in the app container is often the process of interest
ps aux | grep my-app

# Attach strace to the running process
# -p: attach to PID
# -f: follow forks
# -e trace=network: trace only network syscalls
strace -p 7 -f -e trace=network -s 1024 2>&1 | head -100

# Trace file system access to debug missing files
strace -p 7 -f -e trace=file 2>&1 | grep -v ENOENT | head -50

# Trace all syscalls with timestamps
strace -p 7 -f -T -tt 2>&1 | head -200
```

## Debugging Distroless Containers

Distroless containers contain only the application runtime and its dependencies — no shell, no package manager, no debugging tools. Ephemeral containers are the only viable debugging mechanism for these images in production.

### Accessing the Distroless Filesystem

```bash
# Attach an ephemeral container that targets the distroless container's filesystem
# The --target flag sets shareProcessNamespace implicitly for this container
kubectl debug -it my-app-7d4b9c-xk2lm \
  --image=ubuntu:22.04 \
  --container=fs-explorer \
  --target=app \
  -- bash

# Inside the ephemeral container, the target container's filesystem
# is visible at /proc/1/root (process 1 of the target container)
ls /proc/1/root/

# Alternatively, if shareProcessNamespace is true, use the /proc filesystem
# to read files from the target container's view
cat /proc/$(pgrep -f my-app)/root/etc/ssl/certs/ca-certificates.crt

# Read the application configuration without restarting
cat /proc/$(pgrep -f my-app)/root/app/config.yaml

# Check the application's environment variables
cat /proc/$(pgrep -f my-app)/environ | tr '\0' '\n'

# Check open file descriptors
ls -la /proc/$(pgrep -f my-app)/fd/

# Check memory maps to understand library loading
cat /proc/$(pgrep -f my-app)/maps | grep -v "\.so" | head -20
```

### Debugging Go Applications in Distroless

```bash
# Attach delve debugger to a running Go process
# Requires the application binary to include debug symbols (gcflags="-N -l")
kubectl debug -it my-app-7d4b9c-xk2lm \
  --image=golang:1.22 \
  --container=go-debugger \
  --target=app \
  -- bash

# Inside the container, install delve
go install github.com/go-delve/delve/cmd/dlv@latest

# Get the PID of the Go application
APP_PID=$(pgrep my-app)

# Attach delve to the running process
# --headless: run as a server for remote debugging
# --listen: bind to an address
dlv attach ${APP_PID} --headless --listen=:2345 --api-version=2

# In a separate terminal, forward the delve port
kubectl port-forward pod/my-app-7d4b9c-xk2lm 2345:2345

# Connect from a local IDE or dlv client
dlv connect localhost:2345
```

## Network Debugging with netshoot

The `nicolaka/netshoot` image is a purpose-built network debugging toolkit that includes virtually every network diagnostic tool available on Linux.

```bash
# Start a netshoot ephemeral container
kubectl debug -it my-app-7d4b9c-xk2lm \
  --image=nicolaka/netshoot:v0.13 \
  --container=netshoot \
  -- bash

# Inside netshoot:

# Check network interfaces and addresses
ip addr show
ip route show

# Test DNS resolution
dig my-service.production.svc.cluster.local
dig +trace my-service.production.svc.cluster.local
nslookup my-service.production.svc.cluster.local

# Check active connections and listening ports
ss -tulpn
ss -s  # Socket statistics summary

# Test connectivity to a service
curl -v http://my-service.production.svc.cluster.local/health

# Test with specific timeout and verbose TLS info
curl -v --max-time 5 --connect-timeout 2 \
  https://my-service.production.svc.cluster.local/api/v1/status

# Capture network traffic on the pod interface
# This captures all traffic — be mindful of sensitive data in production
tcpdump -i eth0 -nn -s 0 -w /tmp/capture.pcap &

# Run the application workload, then stop tcpdump
kill %1

# View capture summary
tcpdump -r /tmp/capture.pcap -nn | head -50

# Check HTTP traffic specifically
tcpdump -i eth0 -nn -A 'tcp port 8080 and (tcp[((tcp[12:1] & 0xf0) >> 2):4] = 0x47455420)' 2>&1 | head -50

# Bandwidth testing
iperf3 -c my-service.production.svc.cluster.local -p 5201 -t 10

# Trace route to diagnose routing issues
traceroute my-service.production.svc.cluster.local

# Check MTU and interface settings
ip link show eth0
ethtool eth0 2>/dev/null || true
```

### tcpdump in Ephemeral Container

```bash
# For more targeted packet capture, use an ephemeral container with tcpdump
kubectl debug -it my-app-7d4b9c-xk2lm \
  --image=corfr/tcpdump:latest \
  --container=packet-capture \
  -- tcpdump -i any -nn -s 0 -w - \
  'host 10.96.0.1 and port 443' | \
  tee /tmp/api-server-traffic.pcap | \
  tcpdump -r - -nn 2>/dev/null

# Or capture to a file and copy it out
kubectl debug -it my-app-7d4b9c-xk2lm \
  --image=nicolaka/netshoot \
  --container=tcpdump-session \
  -- tcpdump -i any -nn -s 65535 -c 1000 -w /tmp/capture.pcap

# Copy the capture file to the local machine for analysis
kubectl cp my-app-7d4b9c-xk2lm:/tmp/capture.pcap \
  -c tcpdump-session \
  ./capture-$(date +%Y%m%d%H%M%S).pcap

# Open with wireshark locally
wireshark ./capture-*.pcap
```

## Copy Pod for Debugging

When a pod's spec does not have `shareProcessNamespace: true`, or when a more invasive debug session is needed without affecting production traffic, the `kubectl debug --copy-to` pattern creates a copy of the pod with modifications.

### Copy with Modified Image

```bash
# Create a copy of the pod with a different image (e.g., a debug build)
# The original pod continues running and serving traffic
kubectl debug my-app-7d4b9c-xk2lm \
  --copy-to=my-app-debug \
  --image=gcr.io/my-org/my-app:debug-1.5.3 \
  --container=app \
  -it \
  -- bash

# The debug pod is created in the same namespace
kubectl get pod my-app-debug

# Clean up the debug pod when done
kubectl delete pod my-app-debug
```

### Copy with Process Namespace Sharing Added

```bash
# Copy the pod and add shareProcessNamespace for process-level debugging
kubectl debug my-app-7d4b9c-xk2lm \
  --copy-to=my-app-debug-shared \
  --share-processes \
  --image=ubuntu:22.04 \
  -it \
  -- bash

# The copied pod has all original containers PLUS the new debug container
# and shareProcessNamespace: true
kubectl get pod my-app-debug-shared -o jsonpath='{.spec.shareProcessNamespace}'
```

### Copy with Environment Variable Override

```bash
# Copy the pod with a debug environment variable to enable verbose logging
kubectl debug my-app-7d4b9c-xk2lm \
  --copy-to=my-app-debug-verbose \
  --env="LOG_LEVEL=debug" \
  --env="DEBUG=true" \
  -it \
  -- sh

# Note: the copied pod inherits all original containers, volumes, and service account
# Only the specified changes are applied
```

## Node-Level Debugging

Node debugging creates a privileged pod on a specific node with access to the node's filesystem, processes, and namespaces.

```bash
# Create a debugging pod on a specific node
# This mounts the node's filesystem at /host
kubectl debug node/worker-node-3 \
  --image=nicolaka/netshoot \
  -it \
  -- bash

# Inside the node debug pod:
# Access the node's filesystem
ls /host/etc/kubernetes/
cat /host/etc/kubernetes/kubelet.conf

# Check running processes on the node
nsenter -t 1 -m -u -i -n -p -- ps aux | grep kubelet

# Check node-level network configuration
nsenter -t 1 -n -- ip addr show
nsenter -t 1 -n -- iptables -L -n -v | head -50

# Check containerd state
nsenter -t 1 -m -- crictl ps
nsenter -t 1 -m -- crictl images

# Check systemd service status
nsenter -t 1 -m -- systemctl status kubelet
nsenter -t 1 -m -- journalctl -u kubelet -n 100

# Check disk usage on the node
nsenter -t 1 -m -- df -hT
nsenter -t 1 -m -- du -sh /var/lib/kubelet/pods/* 2>/dev/null | sort -rh | head -10

# Check kernel parameters
nsenter -t 1 -m -- sysctl -a | grep net.ipv4 | head -20
```

### Debugging Kubelet Certificate Issues at Node Level

```bash
kubectl debug node/worker-node-3 \
  --image=ubuntu:22.04 \
  -it \
  -- bash

# Inside the debug pod:
apt-get update -qq && apt-get install -y -qq openssl

# Check kubelet certificate expiry
nsenter -t 1 -m -- \
  openssl x509 -in /var/lib/kubelet/pki/kubelet-client-current.pem \
  -noout -dates

# Check all kubelet PKI certificates
for cert in /host/var/lib/kubelet/pki/*.pem; do
  echo "=== ${cert} ==="
  openssl x509 -in "${cert}" -noout -subject -dates 2>/dev/null || true
done

# Verify the kubelet can reach the API server
nsenter -t 1 -n -- curl -k https://$(cat /host/etc/kubernetes/kubelet.conf | grep server | awk '{print $2}')/healthz
```

## Security Implications

### RBAC for Ephemeral Container Access

Ephemeral container creation requires the `pods/ephemeralcontainers` subresource. This should be restricted to operations and security teams.

```yaml
# rbac/ephemeral-containers-role.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: ephemeral-container-user
rules:
  # Required to list and describe pods
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
  # Required to create ephemeral containers
  - apiGroups: [""]
    resources: ["pods/ephemeralcontainers"]
    verbs: ["update"]
  # Required to exec into ephemeral containers
  - apiGroups: [""]
    resources: ["pods/exec"]
    verbs: ["create"]
  # Required to copy files out of the pod
  - apiGroups: [""]
    resources: ["pods/attach"]
    verbs: ["create"]
  # Required for kubectl cp
  - apiGroups: [""]
    resources: ["pods/portforward"]
    verbs: ["create"]
---
# Bind to the operations team group
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ephemeral-container-operations
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: ephemeral-container-user
subjects:
  - kind: Group
    name: operations-team
    apiGroup: rbac.authorization.k8s.io
```

### Admission Policy to Control Debug Image Sources

```yaml
# Kyverno policy to ensure ephemeral containers use only approved debug images
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: restrict-ephemeral-container-images
spec:
  validationFailureAction: Enforce
  background: false
  rules:
    - name: check-ephemeral-image-registry
      match:
        any:
          - resources:
              kinds: ["Pod"]
              operations: ["UPDATE"]
      validate:
        message: "Ephemeral containers must use images from approved registries."
        foreach:
          - list: "request.object.spec.ephemeralContainers"
            deny:
              conditions:
                all:
                  - key: "{{ element.image }}"
                    operator: NotIn
                    value:
                      - "nicolaka/netshoot*"
                      - "ubuntu:22.04"
                      - "ubuntu:24.04"
                      - "busybox:*"
                      - "gcr.io/my-org/debug-tools:*"
```

### Audit Logging for Ephemeral Container Events

```yaml
# audit/policy.yaml — enhanced audit rules for ephemeral containers
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
  # Log all ephemeral container creations at the RequestResponse level
  - level: RequestResponse
    verbs: ["update"]
    resources:
      - group: ""
        resources: ["pods/ephemeralcontainers"]
    omitStages:
      - RequestReceived

  # Log exec into pods (includes ephemeral containers)
  - level: Metadata
    verbs: ["create"]
    resources:
      - group: ""
        resources: ["pods/exec", "pods/attach"]
```

## Automation: Debug Session Script

```bash
#!/bin/bash
# scripts/kdebug.sh — wrapper script for common debug scenarios
# Usage: ./kdebug.sh <pod-name> [namespace] [debug-type]

set -euo pipefail

POD_NAME="${1:?Pod name required}"
NAMESPACE="${2:-default}"
DEBUG_TYPE="${3:-netshoot}"

# Verify the pod exists
if ! kubectl get pod "${POD_NAME}" --namespace="${NAMESPACE}" &>/dev/null; then
  echo "ERROR: Pod ${POD_NAME} not found in namespace ${NAMESPACE}"
  exit 1
fi

# Generate a unique container name using a timestamp
CONTAINER_NAME="debug-$(date +%s)"

case "${DEBUG_TYPE}" in
  "netshoot")
    echo "Starting netshoot debug session on ${POD_NAME}..."
    kubectl debug -it "${POD_NAME}" \
      --namespace="${NAMESPACE}" \
      --image=nicolaka/netshoot:v0.13 \
      --container="${CONTAINER_NAME}" \
      -- bash
    ;;
  "strace")
    echo "Starting strace session on ${POD_NAME}..."
    kubectl debug -it "${POD_NAME}" \
      --namespace="${NAMESPACE}" \
      --image=ubuntu:22.04 \
      --container="${CONTAINER_NAME}" \
      --target="$(kubectl get pod ${POD_NAME} --namespace=${NAMESPACE} -o jsonpath='{.spec.containers[0].name}')" \
      -- bash -c 'apt-get update -qq && apt-get install -y -qq strace procps && bash'
    ;;
  "tcpdump")
    echo "Starting tcpdump session on ${POD_NAME}..."
    CAPTURE_FILE="capture-${POD_NAME}-$(date +%Y%m%d%H%M%S).pcap"
    kubectl debug -it "${POD_NAME}" \
      --namespace="${NAMESPACE}" \
      --image=nicolaka/netshoot:v0.13 \
      --container="${CONTAINER_NAME}" \
      -- tcpdump -i any -nn -s 65535 -w /tmp/capture.pcap
    echo "Copying capture file..."
    kubectl cp "${POD_NAME}:/tmp/capture.pcap" \
      --namespace="${NAMESPACE}" \
      -c "${CONTAINER_NAME}" \
      "./${CAPTURE_FILE}"
    echo "Capture saved to: ./${CAPTURE_FILE}"
    ;;
  "copy")
    echo "Creating debug copy of ${POD_NAME}..."
    kubectl debug "${POD_NAME}" \
      --namespace="${NAMESPACE}" \
      --copy-to="${POD_NAME}-debug" \
      --share-processes \
      --image=nicolaka/netshoot:v0.13 \
      -it \
      -- bash
    echo "Cleaning up debug pod..."
    kubectl delete pod "${POD_NAME}-debug" --namespace="${NAMESPACE}"
    ;;
  *)
    echo "Unknown debug type: ${DEBUG_TYPE}"
    echo "Valid types: netshoot, strace, tcpdump, copy"
    exit 1
    ;;
esac
```

## Common Debugging Scenarios

### Debugging a Service That Cannot Reach Its Dependency

```bash
# Attach netshoot to the pod experiencing connection issues
kubectl debug -it my-api-5c9d4b-xvk2m \
  --namespace production \
  --image=nicolaka/netshoot \
  --container=netdebug \
  -- bash

# Check if the service DNS resolves
dig +short my-database.production.svc.cluster.local

# Check if the port is reachable (TCP connect test)
nc -zv my-database.production.svc.cluster.local 5432

# Check the full TCP path with verbose output
curl -v --connect-timeout 5 \
  telnet://my-database.production.svc.cluster.local:5432

# Check network policy is not blocking the connection
# (by observing whether SYN packets are answered)
tcpdump -i eth0 -nn 'host 10.96.100.50 and port 5432' -c 10

# Verify the connection attempt in parallel
nc -zv 10.96.100.50 5432 &
```

### Debugging OOMKilled Containers

```bash
# Copy the pod to prevent it from being killed during investigation
kubectl debug my-app-7d4b9c-xk2lm \
  --copy-to=my-app-oom-debug \
  --share-processes \
  --image=ubuntu:22.04 \
  -it \
  -- bash

# Inside the debug container:
apt-get update -qq && apt-get install -y -qq procps

# Check current memory usage per process
cat /proc/$(pgrep my-app)/status | grep -i vmrss

# Watch memory usage over time
while true; do
  echo "$(date): $(cat /proc/$(pgrep my-app)/status | grep VmRSS)"
  sleep 1
done

# Check memory maps for memory leaks (anonymous mappings grow for heap leaks)
cat /proc/$(pgrep my-app)/smaps | \
  awk '/Anonymous/ {sum += $2} END {printf "Anonymous: %d kB\n", sum}'

# Trigger garbage collection in Go (if applicable via pprof endpoint)
curl -X POST http://localhost:6060/debug/pprof/
curl http://localhost:6060/debug/pprof/heap > heap.prof
go tool pprof heap.prof
```

## Summary

Ephemeral containers represent a fundamental shift in how production debugging works in Kubernetes. By attaching a debug-capable container to a running pod without restarting it, platform teams can diagnose issues in production-grade distroless images without expanding the attack surface of production workloads. The key patterns — direct ephemeral container attachment, process namespace sharing for strace access, netshoot for network diagnostics, and pod copy for non-disruptive deep inspection — cover the majority of production debugging scenarios. Node-level debugging extends this further, providing access to kubelet state, node networking, and containerd internals. Proper RBAC restricting the `pods/ephemeralcontainers` subresource, combined with admission policies controlling which debug images are permitted, ensures this powerful capability remains under appropriate governance.
