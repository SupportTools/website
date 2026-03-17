---
title: "Kubernetes Debugging Techniques: Ephemeral Containers, kubectl-debug, and Core Dumps"
date: 2028-04-12T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Debugging", "Ephemeral Containers", "Profiling", "kubectl"]
categories: ["Kubernetes", "Debugging"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes debugging techniques covering ephemeral containers, kubectl debug, CPU and memory profiling in running pods, core dump collection, and network traffic analysis without restarting workloads."
more_link: "yes"
url: "/kubernetes-debugging-techniques-guide/"
---

Debugging production Kubernetes workloads requires techniques that minimize disruption. You cannot always restart a pod to add debugging tools, and many production images contain only the application binary with no shell. This guide covers the full toolkit for debugging live Kubernetes workloads: ephemeral containers, profile-based debugging, core dump collection, and network analysis.

<!--more-->

# Kubernetes Debugging Techniques: Ephemeral Containers, kubectl-debug, and Core Dumps

## The Production Debugging Challenge

Debugging in Kubernetes is harder than debugging on traditional servers for several reasons:

1. **Minimal images**: Distroless and scratch-based images contain no shell, no debugging tools
2. **Immutable containers**: You cannot `apt-get install gdb` into a running container
3. **Ephemeral pods**: The pod may be replaced before you finish debugging
4. **Distributed logs**: Events are spread across multiple pods and nodes
5. **Security constraints**: PodSecurityStandards may prevent privileged containers

Modern Kubernetes debugging tools address each of these challenges.

## Ephemeral Containers

Ephemeral containers (stable since Kubernetes 1.25) allow adding a debugging container to a running pod without restarting it.

### Basic Ephemeral Container Usage

```bash
# Add a debugging container to a running pod
kubectl debug -it \
    --image=nicolaka/netshoot \
    --target=app \
    pod/payment-service-7d4c9b-xk2nz

# --target=<container-name> shares the process namespace with the target container
# This lets you see the target's processes with ps, strace, etc.

# Without --target (isolated): debugging container has its own PID namespace
kubectl debug -it \
    --image=busybox:latest \
    pod/payment-service-7d4c9b-xk2nz
```

### Debugging a Distroless Container

```bash
# The application container has no shell — add one as ephemeral container
kubectl debug -it \
    --image=ubuntu:22.04 \
    --target=payment-service \
    pod/payment-service-7d4c9b-xk2nz \
    -- bash

# Inside the debugging container, you can see the app's processes:
ps aux
# PID   USER     COMMAND
# 1     nobody   /app/payment-service --config=/etc/config/config.yaml
# 45    nobody   bash (this is the ephemeral container)

# Trace system calls made by the application
strace -p 1 -e trace=network
```

### Creating a Debug Copy of a Pod

For situations where you need to modify the pod spec (e.g., override the command or add capabilities):

```bash
# Create a copy of the pod with modifications for debugging
kubectl debug payment-service-7d4c9b-xk2nz \
    --copy-to=debug-payment-service \
    --set-image=payment-service=ubuntu:22.04 \
    --share-processes \
    -it \
    -- bash

# Or debug a node directly
kubectl debug node/ip-10-0-1-42.us-east-1.compute.internal \
    -it \
    --image=ubuntu:22.04

# Node debugging mounts the host filesystem at /host
ls /host/var/log/
nsenter --target 1 --mount --uts --ipc --net -- bash  # Enter node's namespaces
```

## Shared Process Namespace Debugging

Sharing the process namespace allows one container to inspect another's processes:

```yaml
# debug-pod.yaml — enables cross-container process inspection
apiVersion: v1
kind: Pod
metadata:
  name: debug-shared-pid
spec:
  shareProcessNamespace: true  # All containers share PID namespace
  containers:
  - name: app
    image: payment-service:latest
  - name: debugger
    image: nicolaka/netshoot
    stdin: true
    tty: true
    securityContext:
      capabilities:
        add:
        - SYS_PTRACE  # Required for strace, gdb
```

## Go pprof Profiling in Production Pods

For Go applications, pprof provides CPU, memory, goroutine, and mutex profiling without stopping the application.

### Enabling pprof in Your Application

```go
// main.go
import (
    "net/http"
    _ "net/http/pprof"  // Side effect: registers pprof handlers
)

func main() {
    // Start pprof server on separate port (never expose publicly)
    go func() {
        log.Println(http.ListenAndServe("localhost:6060", nil))
    }()

    // ... rest of application
}
```

### Port-Forwarding to the pprof Endpoint

```bash
# Forward pprof port from pod to local machine
kubectl port-forward pod/payment-service-7d4c9b-xk2nz 6060:6060 &

# CPU profiling: sample for 30 seconds
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30

# Memory profiling
go tool pprof http://localhost:6060/debug/pprof/heap

# Goroutine stacks — invaluable for debugging leaks
go tool pprof http://localhost:6060/debug/pprof/goroutine

# Block profiling (where goroutines block on channel/mutex)
go tool pprof http://localhost:6060/debug/pprof/block

# Mutex contention profiling
go tool pprof http://localhost:6060/debug/pprof/mutex

# Interactive pprof: after running above commands
# Type 'web' to open flame graph in browser
# Type 'top20' to see top 20 CPU consumers
# Type 'list FunctionName' to see annotated source

# Download profile for offline analysis
wget -O cpu.prof http://localhost:6060/debug/pprof/profile?seconds=30
go tool pprof -http=:8080 cpu.prof
```

### Automated Profile Collection with kubectl exec

```bash
#!/bin/bash
# collect-go-profiles.sh
POD="${1:?Usage: $0 <pod-name> <namespace>}"
NS="${2:-default}"
OUTPUT_DIR="profiles-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUTPUT_DIR"

echo "Collecting profiles from $POD in namespace $NS"

# Port-forward in background
kubectl port-forward -n "$NS" "pod/$POD" 6060:6060 &
PF_PID=$!
sleep 2  # Wait for port-forward to establish

# Collect profiles
echo "Collecting CPU profile (30s)..."
curl -sS "http://localhost:6060/debug/pprof/profile?seconds=30" \
    -o "$OUTPUT_DIR/cpu.prof"

echo "Collecting heap profile..."
curl -sS "http://localhost:6060/debug/pprof/heap" \
    -o "$OUTPUT_DIR/heap.prof"

echo "Collecting goroutine profile..."
curl -sS "http://localhost:6060/debug/pprof/goroutine" \
    -o "$OUTPUT_DIR/goroutine.prof"

echo "Collecting trace (5s)..."
curl -sS "http://localhost:6060/debug/pprof/trace?seconds=5" \
    -o "$OUTPUT_DIR/trace.out"

kill $PF_PID

echo "Profiles saved to $OUTPUT_DIR/"
echo "Open CPU flame graph: go tool pprof -http=:8080 $OUTPUT_DIR/cpu.prof"
echo "Analyze trace: go tool trace $OUTPUT_DIR/trace.out"
```

## Core Dump Collection

Core dumps capture the full state of a process at the time of a crash, enabling post-mortem debugging.

### Configuring Core Dumps in Kubernetes

```bash
# On the node: ensure core dumps are enabled
ulimit -c unlimited
echo "/var/crash/core-%e-%p-%t" > /proc/sys/kernel/core_pattern

# Verify
cat /proc/sys/kernel/core_pattern
```

```yaml
# daemonset-core-dump-config.yaml
# Configure core dumps on all nodes via DaemonSet
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: core-dump-config
  namespace: kube-system
spec:
  selector:
    matchLabels:
      name: core-dump-config
  template:
    spec:
      hostPID: true
      tolerations:
      - operator: Exists
      initContainers:
      - name: configure-core-dumps
        image: busybox:latest
        securityContext:
          privileged: true
        command:
        - /bin/sh
        - -c
        - |
          sysctl -w kernel.core_pattern=/var/crash/core-%e-%p-%t
          ulimit -c unlimited
          mkdir -p /host/var/crash
          chmod 777 /host/var/crash
        volumeMounts:
        - name: proc
          mountPath: /proc
        - name: host-var
          mountPath: /host/var
      volumes:
      - name: proc
        hostPath:
          path: /proc
      - name: host-var
        hostPath:
          path: /var
      containers:
      - name: pause
        image: k8s.gcr.io/pause:3.9
```

```yaml
# Pod spec for core dump capture
apiVersion: v1
kind: Pod
metadata:
  name: payment-service-debug
spec:
  containers:
  - name: payment-service
    image: payment-service:latest
    securityContext:
      # Required for core dumps
      allowPrivilegeEscalation: true
    resources:
      limits:
        memory: 4Gi  # Ensure enough for a core dump
    volumeMounts:
    - name: crash-dir
      mountPath: /var/crash
  volumes:
  - name: crash-dir
    hostPath:
      path: /var/crash
      type: DirectoryOrCreate
```

### Analyzing Core Dumps

```bash
# Copy core dump from node to local machine
scp node-ip:/var/crash/core-payment-service-1234-1704067200 .

# Analyze with gdb (needs the exact binary)
gdb /app/payment-service core-payment-service-1234-1704067200

# In gdb:
(gdb) backtrace    # Full stack trace
(gdb) bt full      # With local variables
(gdb) info threads # All threads
(gdb) thread apply all bt  # Stack trace for all threads
(gdb) info registers  # CPU registers at crash time
(gdb) x/100x $sp   # Examine stack memory
```

## strace: System Call Tracing

```bash
# In an ephemeral container with SYS_PTRACE capability
kubectl debug -it \
    --image=ubuntu:22.04 \
    --target=payment-service \
    pod/payment-service-7d4c9b-xk2nz \
    -- bash

# Attach strace to the application process
PID=$(pgrep payment-service)
strace -p $PID -e trace=network,file 2>&1 | head -200

# Most useful strace filters for Kubernetes debugging:

# Network calls: connect, accept, send, recv
strace -p $PID -e trace=network

# File operations: open, read, write, close
strace -p $PID -e trace=file

# All system calls with timing
strace -p $PID -T -tt

# Count system calls (summary statistics)
strace -p $PID -c -f

# Follow forks/threads
strace -p $PID -f -e trace=network
```

## Network Debugging with Ephemeral Containers

```bash
# Use netshoot for comprehensive network debugging
kubectl debug -it \
    --image=nicolaka/netshoot \
    --target=payment-service \
    pod/payment-service-7d4c9b-xk2nz

# Inside netshoot: full networking toolkit available

# Check DNS resolution
nslookup order-service.team-orders.svc.cluster.local

# Test connectivity
nc -zv order-service.team-orders.svc.cluster.local 8080

# Trace route
traceroute order-service.team-orders.svc.cluster.local

# Capture traffic on the pod's network interface
tcpdump -i eth0 -w /tmp/capture.pcap &
# ... trigger the issue ...
kill %1

# Copy capture file locally for analysis
kubectl cp payment-service-7d4c9b-xk2nz:/tmp/capture.pcap ./capture.pcap

# Analyze with tshark or Wireshark
tshark -r capture.pcap -Y "http"
tshark -r capture.pcap -Y "tcp.flags.reset == 1"  # Find TCP resets
```

## Checking iptables and conntrack

```bash
# From a node debugger or privileged pod
kubectl debug node/ip-10-0-1-42.us-east-1.compute.internal \
    -it \
    --image=ubuntu:22.04

# Enter host namespaces
nsenter --target 1 --mount --uts --ipc --net -- bash

# View all iptables rules
iptables -L -n -v --line-numbers

# View specific chain (kube-proxy rules)
iptables -t nat -L KUBE-SERVICES -n -v
iptables -t nat -L KUBE-SVC-XXXXX -n -v

# Count conntrack entries by state
conntrack -L 2>/dev/null | awk '{print $4}' | sort | uniq -c

# Find conntrack entries for a specific connection
conntrack -L -d 10.96.0.10  # Kubernetes service IP

# Monitor conntrack events in real-time
conntrack -E -p tcp
```

## Memory Leak Detection

```bash
# Check container memory usage
kubectl top pod payment-service-7d4c9b-xk2nz --containers

# Monitor memory growth over time
watch -n5 'kubectl top pod -l app=payment-service'

# For Go apps: check pprof heap profile
kubectl port-forward pod/payment-service-7d4c9b-xk2nz 6060:6060 &

# Take baseline heap profile
curl http://localhost:6060/debug/pprof/heap -o heap-baseline.prof

# Wait 10 minutes
sleep 600

# Take second heap profile
curl http://localhost:6060/debug/pprof/heap -o heap-after.prof

# Compare allocations
go tool pprof -base heap-baseline.prof heap-after.prof
(pprof) top20  # Top 20 new allocations since baseline

# Or use allocs profile (shows total allocations, not just live objects)
curl http://localhost:6060/debug/pprof/allocs -o allocs.prof
go tool pprof -http=:8080 allocs.prof
```

## Debugging CrashLoopBackOff

```bash
# Check why the pod is crashing
kubectl describe pod payment-service-7d4c9b-xk2nz

# Get logs from the last run (before crash)
kubectl logs payment-service-7d4c9b-xk2nz --previous

# Copy files from a crashed container before it restarts
kubectl cp payment-service-7d4c9b-xk2nz:/var/log/app.log ./app.log

# Create a debug copy of the failing pod with command override
kubectl debug payment-service-7d4c9b-xk2nz \
    --copy-to=debug-crash \
    --set-image=payment-service=payment-service:latest \
    -- /bin/sh -c "sleep infinity"
    # Now exec into it and run the failing command manually

kubectl exec -it debug-crash -c payment-service -- /bin/sh
/app/payment-service --config=/etc/config/config.yaml 2>&1
```

## kubectl-debug Plugin

The `kubectl-debug` plugin (https://github.com/aylei/kubectl-debug) provides an enhanced debugging experience:

```bash
# Install kubectl-debug
curl -Lo kubectl-debug.tar.gz https://github.com/aylei/kubectl-debug/releases/latest/download/kubectl-debug_linux_amd64.tar.gz
tar -xzf kubectl-debug.tar.gz
mv kubectl-debug /usr/local/bin/kubectl-debug

# Debug a pod using a debug image with tools
kubectl debug pod/payment-service-7d4c9b-xk2nz \
    --agentless \
    --port-forward \
    -i node-inspector/node-inspector:latest

# Configure default debug image
cat ~/.kubectl-debug.yaml
```

## Timeout and Latency Debugging

```bash
# Install and use ksniff for packet capture without modifying pods
kubectl ksniff payment-service-7d4c9b-xk2nz -p -f "port 8080"

# Use kubectl-trace for eBPF-based tracing
kubectl trace run payment-service-7d4c9b-xk2nz \
    -e 'kprobe:do_sys_open { printf("%s %s\n", comm, str(arg1)); }'

# Check for DNS latency issues
kubectl exec -it payment-service-7d4c9b-xk2nz -- bash -c "
for i in \$(seq 1 20); do
    time nslookup order-service.team-orders.svc.cluster.local 2>&1 | tail -1
done
"
```

## Debugging OOMKilled Pods

```bash
# Identify OOMKilled pods
kubectl get pods --all-namespaces \
    -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}: {range .status.containerStatuses[*]}{.lastState.terminated.reason}{"\n"}{end}{end}' | \
    grep OOMKilled

# Check memory usage around OOM time
kubectl describe pod payment-service-7d4c9b-xk2nz | grep -A5 "OOMKilled"

# Check node memory pressure
kubectl describe node <node-name> | grep -A5 "MemoryPressure"
kubectl get events --field-selector=reason=OOMKilling

# Use ephemeral container to check /proc/meminfo
kubectl debug -it \
    --image=busybox \
    pod/payment-service-7d4c9b-xk2nz \
    -- cat /proc/meminfo

# Check container memory limit vs actual usage
kubectl get pod payment-service-7d4c9b-xk2nz \
    -o jsonpath='{.spec.containers[0].resources.limits.memory}'
kubectl top pod payment-service-7d4c9b-xk2nz --containers
```

## Creating a Debug Toolbox DaemonSet

For persistent on-node debugging capabilities:

```yaml
# toolbox-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: debug-toolbox
  namespace: kube-system
spec:
  selector:
    matchLabels:
      name: debug-toolbox
  template:
    metadata:
      labels:
        name: debug-toolbox
    spec:
      tolerations:
      - operator: Exists
      hostPID: true
      hostNetwork: true
      hostIPC: true
      volumes:
      - name: host-root
        hostPath:
          path: /
      containers:
      - name: toolbox
        image: nicolaka/netshoot
        command: ["sleep", "infinity"]
        securityContext:
          privileged: true
        volumeMounts:
        - name: host-root
          mountPath: /host
        resources:
          requests:
            cpu: 10m
            memory: 50Mi
          limits:
            cpu: 200m
            memory: 200Mi
```

```bash
# Use the toolbox
NODE="ip-10-0-1-42.us-east-1.compute.internal"
TOOLBOX_POD=$(kubectl get pods -n kube-system \
    -l name=debug-toolbox \
    --field-selector spec.nodeName=$NODE \
    -o jsonpath='{.items[0].metadata.name}')

kubectl exec -it -n kube-system "$TOOLBOX_POD" -- bash
```

## Audit Log Analysis

```bash
# Find audit events for a specific pod
kubectl get events --all-namespaces \
    --field-selector involvedObject.name=payment-service-7d4c9b-xk2nz \
    --sort-by='.lastTimestamp'

# Check audit logs on control plane nodes
# (location depends on cluster setup)
cat /var/log/kubernetes/audit.log | \
    jq 'select(.objectRef.name == "payment-service-7d4c9b-xk2nz")' | \
    jq '{verb, user: .user.username, time: .stageTimestamp}'

# Find who deleted a pod
cat /var/log/kubernetes/audit.log | \
    jq 'select(.verb == "delete" and .objectRef.resource == "pods") |
    {user: .user.username, pod: .objectRef.name, time: .requestReceivedTimestamp}'
```

## Conclusion

Effective Kubernetes debugging requires building a mental model of the full stack: from the Linux kernel and network namespaces up through container runtimes, the Kubernetes control plane, and application code. Ephemeral containers eliminate the need to restart workloads to add debugging tools. pprof provides deep insight into Go application behavior. strace and tcpdump work at the system and network level for language-agnostic debugging. For production incidents, the combination of ephemeral containers + port-forwarded pprof + structured logging analysis covers the majority of debugging scenarios without service disruption. Build your debugging toolkit before incidents occur by establishing access patterns, ensuring pprof endpoints are available on development ports, and documenting your debugging runbooks.
