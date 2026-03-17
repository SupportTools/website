---
title: "Kubernetes Kubelet Configuration Tuning: Eviction Thresholds, Image GC, CPU Manager, and cgroup v2 Migration"
date: 2028-06-20T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Kubelet", "Node Configuration", "Eviction", "CPU Manager", "cgroup", "Production"]
categories: ["Kubernetes", "Node Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to kubelet configuration tuning: eviction threshold calibration, image garbage collection policies, CPU and memory manager configuration, container log rotation, systemd cgroup driver migration, and pod max per node tuning."
more_link: "yes"
url: "/kubernetes-kubelet-configuration-tuning-guide/"
---

The kubelet is the primary node agent in Kubernetes, responsible for Pod lifecycle management, resource monitoring, container log rotation, node condition reporting, and garbage collection. Its default configuration is tuned for generic workloads that may not match production requirements. Clusters running memory-intensive databases need different eviction thresholds than clusters running many small microservices. High-frequency batch clusters need aggressive image GC policies. Performance-sensitive workloads require CPU manager integration.

This guide covers kubelet configuration in depth: the KubeletConfiguration object, eviction signal calibration, image and container GC, CPU and memory manager setup, log rotation, and the systemd vs cgroupfs driver decision.

<!--more-->

## KubeletConfiguration Object

Starting with Kubernetes 1.22, kubelet configuration is managed through a `KubeletConfiguration` object rather than command-line flags. This enables version-controlled configuration and validation.

### Creating the Configuration File

```yaml
# /etc/kubernetes/kubelet-config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration

# Node address configuration
address: "0.0.0.0"
port: 10250

# Authentication
authentication:
  anonymous:
    enabled: false
  webhook:
    enabled: true
    cacheTTL: "2m"
  x509:
    clientCAFile: "/etc/kubernetes/pki/ca.crt"

# Authorization
authorization:
  mode: Webhook
  webhook:
    cacheAuthorizedTTL: "5m"
    cacheUnauthorizedTTL: "30s"

# cgroup configuration — MUST match container runtime
cgroupDriver: "systemd"  # or "cgroupfs"
cgroupsPerQOS: true

# Cluster DNS
clusterDNS:
  - "10.96.0.10"
clusterDomain: "cluster.local"

# Pod configuration
maxPods: 110
podPidsLimit: 4096
podLogsDir: "/var/log/pods"

# Container runtime
containerRuntimeEndpoint: "unix:///run/containerd/containerd.sock"

# Shutdown grace period (allows graceful workload termination on node shutdown)
shutdownGracePeriod: "30s"
shutdownGracePeriodCriticalPods: "10s"

# Feature gates
featureGates:
  GracefulNodeShutdown: true
  GracefulNodeShutdownBasedOnPodPriority: true
  TopologyManager: true
  CPUManager: true
  MemoryManager: true
```

### Applying the Configuration

```bash
# On systemd-based systems, kubelet reads this via:
# /etc/systemd/system/kubelet.service.d/10-kubeadm.conf
# ExecStart=... --config=/etc/kubernetes/kubelet-config.yaml

# After updating:
systemctl daemon-reload
systemctl restart kubelet

# Verify the configuration was applied
kubectl get --raw "/api/v1/nodes/$(hostname)/proxy/configz" | \
  python3 -m json.tool | grep -A5 "kubeletconfig"
```

## Eviction Threshold Configuration

### Understanding Eviction Signals

Kubelet monitors node resources and evicts Pods when resources drop below configured thresholds. Two types of thresholds exist:

**Soft thresholds**: Resource below threshold for `evictionSoftGracePeriod` → Pod eviction begins with graceful termination
**Hard thresholds**: Resource below threshold immediately → Pod eviction without grace period

Available eviction signals:

| Signal | Description |
|--------|-------------|
| `memory.available` | Node memory available |
| `nodefs.available` | Available bytes on node's main filesystem |
| `nodefs.inodesFree` | Available inodes on node's main filesystem |
| `imagefs.available` | Available bytes on image filesystem |
| `imagefs.inodesFree` | Available inodes on image filesystem |
| `pid.available` | Available PIDs in the node |

### Production Eviction Configuration

```yaml
# Eviction thresholds — tune based on workload characteristics
evictionHard:
  # Evict Pods immediately when memory is critically low
  # Set based on: what's the minimum needed for kubelet + OS?
  # Rule of thumb: max(1Gi, node_memory * 0.02)
  memory.available: "500Mi"

  # Evict when disk is low — containers need space to write logs
  # nodefs = / or the partition where container data lives
  nodefs.available: "10%"
  nodefs.inodesFree: "5%"

  # imagefs = partition where images are stored (often /var/lib/containerd)
  imagefs.available: "15%"
  imagefs.inodesFree: "5%"

  # PID pressure — prevents fork bombs from affecting other containers
  pid.available: "5%"

evictionSoft:
  # Start graceful eviction before hitting hard limits
  memory.available: "1Gi"
  nodefs.available: "15%"
  nodefs.inodesFree: "10%"
  imagefs.available: "20%"

evictionSoftGracePeriod:
  # How long a resource must be below soft threshold before eviction starts
  memory.available: "2m"
  nodefs.available: "5m"
  nodefs.inodesFree: "5m"
  imagefs.available: "5m"

# How long to wait between eviction rounds
evictionPressureTransitionPeriod: "5m"

# Evict this many bytes beyond the threshold to provide breathing room
evictionMinimumReclaim:
  memory.available: "200Mi"
  nodefs.available: "2Gi"
  imagefs.available: "2Gi"
```

### Calculating Eviction Thresholds for Specific Workloads

```bash
#!/bin/bash
# calculate-eviction-thresholds.sh
# Recommends eviction thresholds based on node characteristics

NODE=${1:-$(hostname)}

# Get node total memory
TOTAL_MEM=$(kubectl get node ${NODE} \
  -o jsonpath='{.status.capacity.memory}' | \
  sed 's/Ki//' | awk '{printf "%.0f", $1/1024/1024}')

echo "=== Node ${NODE} ==="
echo "Total Memory: ${TOTAL_MEM} GiB"

# Calculate recommended thresholds
# System reserved + kubelet overhead
SYSTEM_RESERVED_GIB=2

HARD_THRESHOLD_MI=$(echo "scale=0; ${SYSTEM_RESERVED_GIB} * 512" | bc)
SOFT_THRESHOLD_MI=$(echo "scale=0; ${SYSTEM_RESERVED_GIB} * 1024" | bc)

echo ""
echo "Recommended eviction thresholds:"
echo "  evictionHard.memory.available: ${HARD_THRESHOLD_MI}Mi"
echo "  evictionSoft.memory.available: ${SOFT_THRESHOLD_MI}Mi"
echo ""
echo "Disk thresholds (adjust based on disk size):"
echo "  evictionHard.nodefs.available: 10%  (or 5Gi minimum)"
echo "  evictionSoft.nodefs.available: 15%  (or 10Gi minimum)"

# Check current memory pressure
kubectl describe node ${NODE} | grep -A5 "Conditions:"
```

### Reserved Resources

Kubelet can reserve CPU and memory for system processes and kubelet itself:

```yaml
# Reserve resources for OS and kubernetes system processes
# These resources are subtracted from node's allocatable capacity
kubeReserved:
  cpu: "250m"
  memory: "1Gi"
  ephemeral-storage: "1Gi"
  pid: "500"

systemReserved:
  cpu: "250m"
  memory: "512Mi"
  ephemeral-storage: "1Gi"

# Enforcement mode: 'system-reserved' enforces via cgroups
kubeReservedCgroup: "/system.slice/kubelet.service"
systemReservedCgroup: "/system.slice"
enforceNodeAllocatable:
  - "pods"
  - "system-reserved"
  - "kube-reserved"
```

```bash
# Verify allocatable resources after reservations
kubectl get node -o custom-columns=\
'NAME:.metadata.name,CPU:.status.allocatable.cpu,MEM:.status.allocatable.memory'
```

## Image Garbage Collection

### GC Policy Configuration

```yaml
# Image garbage collection configuration
imageGCHighThresholdPercent: 85  # Start GC when disk usage exceeds 85%
imageGCLowThresholdPercent: 80   # GC until disk usage drops below 80%
imageMinimumGCAge: "2m"          # Images newer than 2m are never GC'd

# Container log rotation
containerLogMaxSize: "50Mi"   # Max size per log file before rotation
containerLogMaxFiles: 5        # Number of log files to keep
```

### Understanding GC Behavior

When image filesystem exceeds `imageGCHighThresholdPercent`:

1. Kubelet collects list of unused images (not referenced by any container)
2. Sorts by last-used time (oldest first)
3. Deletes images until usage drops below `imageGCLowThresholdPercent`
4. Never deletes images younger than `imageMinimumGCAge`

```bash
# Monitor image storage usage
df -h /var/lib/containerd

# List images sorted by size
crictl images --output json | \
  jq '.images | sort_by(.size) | reverse | .[] | {id: .id, tags: .repoTags, sizeMB: (.size/1024/1024)}' | \
  head -40

# Manual image pruning (equivalent to what kubelet GC does)
crictl rmi $(crictl images -q --no-trunc | grep "^sha256:" | \
  # Exclude images currently used by pods
  comm -23 \
    <(crictl images -q --no-trunc | sort) \
    <(crictl ps -a -q --no-trunc | xargs -I{} crictl inspect {} | \
      jq -r '.status.image.ref' | sort)
)

# Watch GC events
kubectl get events -n kube-system \
  --field-selector reason=ImageGarbageCollected | \
  tail -20
```

## CPU Manager

### When to Enable CPU Manager

The CPU Manager (`policy: static`) pins CPUs to specific cores for containers with `Guaranteed` QoS class (requests == limits). This eliminates CPU migration overhead and improves performance for CPU-sensitive workloads:

- Database servers (PostgreSQL, MySQL)
- Real-time processing services
- ML inference containers
- Latency-sensitive APIs

### CPU Manager Configuration

```yaml
# Enable CPU Manager
cpuManagerPolicy: "static"
cpuManagerReconcilePeriod: "10s"

# Reserve CPUs for OS and kubelet — these are NOT available to containers
# Format: comma-separated CPU IDs or ranges
cpuManagerPolicyOptions:
  full-pcpus-only: "true"  # Only assign full physical CPUs (no hyperthreading splits)
```

```bash
# Configure reserved CPUs — must be set BEFORE kubelet starts
# On the kubelet command line or in KubeletConfiguration:
# reservedCPUs: "0-1"   (reserve CPU 0 and 1 for system)

# Verify CPU manager state
cat /var/lib/kubelet/cpu_manager_state | python3 -m json.tool

# Check which CPUs are allocated to containers
cat /var/lib/kubelet/cpu_manager_state | \
  jq '.entries | to_entries[] | {
    containerID: .key,
    cpus: .value
  }'
```

### Pod Configuration for CPU Pinning

For CPU pinning to take effect, the Pod must be in `Guaranteed` QoS class:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: database-server
  namespace: production
spec:
  containers:
  - name: postgres
    image: postgres:16.2
    resources:
      # requests == limits → Guaranteed QoS → CPU pinning eligible
      requests:
        cpu: "4"           # 4 full CPUs pinned
        memory: "16Gi"
      limits:
        cpu: "4"
        memory: "16Gi"
```

```bash
# Verify CPU pinning is working
CONTAINER_ID=$(crictl ps --name postgres -q)
PID=$(crictl inspect ${CONTAINER_ID} | jq '.info.pid')

# Check CPU affinity mask
taskset -p ${PID}
# Example: pid 12345's current affinity mask: f0  (CPUs 4-7)

# Confirm CPUs are exclusive (not shared with other containers)
cat /sys/fs/cgroup/cpuset/kubepods/guaranteed/$(
  crictl inspect ${CONTAINER_ID} | jq -r '.info.cgroupPath'
)/cpuset.cpus
```

## Memory Manager

### Topology-Aware Memory Allocation

The Memory Manager allocates NUMA-local memory pages for Guaranteed QoS Pods:

```yaml
# Enable Memory Manager (requires CPU Manager static policy)
memoryManagerPolicy: "Static"

# Reserve memory that will never be allocated to containers
reservedMemory:
  - numaNode: 0
    limits:
      memory: "2Gi"          # 2GiB reserved on NUMA node 0
      hugepages-1Gi: "512Mi" # 512MiB 1GiB hugepages reserved
  - numaNode: 1
    limits:
      memory: "2Gi"
      hugepages-1Gi: "512Mi"
```

```yaml
# Pod that benefits from NUMA-aware memory allocation
apiVersion: v1
kind: Pod
metadata:
  name: memory-intensive-app
spec:
  containers:
  - name: app
    image: myapp:v1.0.0
    resources:
      requests:
        cpu: "4"
        memory: "32Gi"
        hugepages-1Gi: "8Gi"
      limits:
        cpu: "4"
        memory: "32Gi"
        hugepages-1Gi: "8Gi"
    volumeMounts:
    - name: hugepages
      mountPath: /hugepages
  volumes:
  - name: hugepages
    emptyDir:
      medium: HugePages-1Gi
```

## Container Log Rotation

### Log Rotation Configuration

```yaml
# Log rotation settings
containerLogMaxSize: "50Mi"    # Rotate when log file exceeds 50MB
containerLogMaxFiles: 5        # Keep 5 rotated files (total: 5 * 50MB = 250MB per container)
```

The kubelet rotates logs based on size, not time. For time-based rotation, use a log agent (Fluent Bit, Vector) with rotation configuration.

### Understanding Log File Layout

```bash
# Container logs are stored at:
# /var/log/pods/<namespace>_<pod>_<uid>/<container>/0.log
# /var/log/pods/<namespace>_<pod>_<uid>/<container>/1.log (rotated)
# ...

# Find logs for a specific pod
ls -lh /var/log/pods/production_payment-api-7d4f9b6c8-xkj2p_*/

# Total log space consumed
du -sh /var/log/pods/

# Find containers consuming most log space
du -sh /var/log/pods/*/* | sort -rh | head -20
```

### Monitoring Log Storage

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: log-storage-alerts
  namespace: monitoring
spec:
  groups:
  - name: log-storage
    rules:
    - alert: NodeLogStorageHigh
      expr: |
        (
          node_filesystem_size_bytes{mountpoint="/var/log"} -
          node_filesystem_avail_bytes{mountpoint="/var/log"}
        ) / node_filesystem_size_bytes{mountpoint="/var/log"} > 0.8
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Log storage >80% full on {{ $labels.instance }}"
```

## Pod Max Per Node Tuning

### Setting maxPods

The default `maxPods: 110` is conservative for many node sizes:

```yaml
# Calculate maxPods based on node size
# Large nodes (32+ vCPU, 128GB+): up to 250 Pods
# Medium nodes (8-16 vCPU, 32-64GB): 110-150 Pods
# Small nodes (2-4 vCPU, 8-16GB): 50-110 Pods

maxPods: 250  # For large nodes

# Also configure podLogsDir if /var partition is separate
podLogsDir: "/var/log/pods"
```

### IP Address Requirements

Increasing `maxPods` requires the CNI to support the additional IP addresses. For AWS VPC CNI:

```bash
# Check current WARM_ENI_TARGET and other CNI settings
kubectl get daemonset aws-node -n kube-system \
  -o jsonpath='{.spec.template.spec.containers[0].env}' | \
  jq '.[] | select(.name | test("WARM|MAX|MIN"))'

# AWS VPC CNI: calculate IPs per node
# IPs_available = (interfaces - 1) * (IPs_per_interface - 1) + IPs_per_interface
# For c5.4xlarge: (8-1)*(30-1)+30 = 233 IPs
```

## systemd cgroup Driver Migration

### cgroupfs vs systemd

**cgroupfs driver**: Kubelet creates cgroup directories directly in `/sys/fs/cgroup`. Does not integrate with systemd's cgroup hierarchy. May cause conflicts in systemd environments.

**systemd driver**: Kubelet creates systemd slices, which are managed by systemd. Required for cgroup v2. Recommended for all modern Linux distributions.

### Migrating from cgroupfs to systemd

This migration requires a rolling node restart:

```bash
#!/bin/bash
# migrate-cgroup-driver.sh
# Run on each node one at a time to avoid cluster disruption

NODE_NAME=${1:-$(hostname)}

echo "Migrating ${NODE_NAME} to systemd cgroup driver"

# Step 1: Drain the node
kubectl drain ${NODE_NAME} \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --grace-period=60 \
  --timeout=300s

# Step 2: Update kubelet config
sed -i 's/cgroupDriver: cgroupfs/cgroupDriver: systemd/' \
  /etc/kubernetes/kubelet-config.yaml

# Step 3: Update containerd config
# /etc/containerd/config.toml
sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' \
  /etc/containerd/config.toml

# Step 4: Restart services
systemctl restart containerd
systemctl restart kubelet

# Wait for node to become Ready
timeout 120 kubectl wait node/${NODE_NAME} --for=condition=Ready

# Step 5: Uncordon
kubectl uncordon ${NODE_NAME}

echo "Migration complete for ${NODE_NAME}"
```

### Verifying cgroup v2

```bash
# Check if cgroup v2 is active
stat -f /sys/fs/cgroup | grep "Type"
# Type: cgroup2fs  ← cgroup v2

# Or:
cat /proc/filesystems | grep cgroup
# nodev   cgroup
# nodev   cgroup2   ← cgroup v2 available

# Check which version is mounted
mount | grep cgroup
# cgroup2 on /sys/fs/cgroup type cgroup2  ← unified hierarchy (v2)

# Verify kubelet is using systemd driver
curl -s --unix-socket /var/run/containerd/containerd.sock \
  http://localhost/api/v1/nodes/$(hostname)/proxy/configz 2>/dev/null | \
  python3 -m json.tool | grep cgroupDriver
```

## Complete KubeletConfiguration Reference

```yaml
# /etc/kubernetes/kubelet-config.yaml
# Production-ready configuration for a standard worker node

apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration

# cgroup configuration
cgroupDriver: "systemd"
cgroupsPerQOS: true
cgroupRoot: "/"

# Authentication and TLS
authentication:
  anonymous:
    enabled: false
  webhook:
    cacheTTL: "2m0s"
    enabled: true
  x509:
    clientCAFile: "/etc/kubernetes/pki/ca.crt"
authorization:
  mode: Webhook
  webhook:
    cacheAuthorizedTTL: "5m0s"
    cacheUnauthorizedTTL: "30s"
tlsCertFile: "/var/lib/kubelet/pki/kubelet.crt"
tlsPrivateKeyFile: "/var/lib/kubelet/pki/kubelet.key"

# Cluster configuration
clusterDNS:
  - "10.96.0.10"
clusterDomain: "cluster.local"
containerRuntimeEndpoint: "unix:///run/containerd/containerd.sock"

# Pod configuration
maxPods: 110
podPidsLimit: 4096
podLogsDir: "/var/log/pods"
containerLogMaxSize: "50Mi"
containerLogMaxFiles: 5

# Resource management
cpuManagerPolicy: "none"           # or "static" for CPU pinning
memoryManagerPolicy: "None"        # or "Static" for NUMA memory

# System reservations
kubeReserved:
  cpu: "250m"
  memory: "1Gi"
systemReserved:
  cpu: "250m"
  memory: "512Mi"
enforceNodeAllocatable:
  - "pods"

# Eviction
evictionHard:
  memory.available: "500Mi"
  nodefs.available: "10%"
  nodefs.inodesFree: "5%"
  imagefs.available: "15%"
evictionSoft:
  memory.available: "1Gi"
  nodefs.available: "15%"
  imagefs.available: "20%"
evictionSoftGracePeriod:
  memory.available: "2m"
  nodefs.available: "5m"
  imagefs.available: "5m"
evictionPressureTransitionPeriod: "5m"
evictionMinimumReclaim:
  memory.available: "200Mi"
  nodefs.available: "2Gi"

# Image garbage collection
imageGCHighThresholdPercent: 85
imageGCLowThresholdPercent: 80
imageMinimumGCAge: "2m"

# Graceful shutdown
shutdownGracePeriod: "30s"
shutdownGracePeriodCriticalPods: "10s"

# Node status
nodeStatusUpdateFrequency: "10s"
nodeStatusReportFrequency: "1m"
nodeLeaseDurationSeconds: 40

# Housekeeping
syncFrequency: "1m"
fileCheckFrequency: "20s"
httpCheckFrequency: "20s"

# Feature gates
featureGates:
  GracefulNodeShutdown: true
  GracefulNodeShutdownBasedOnPodPriority: true
  CSIStorageCapacity: true
  ExpandCSIVolumes: true
  RotateKubeletServerCertificate: true
```

## Verifying Configuration

```bash
# Check current kubelet configuration
kubectl get --raw \
  "/api/v1/nodes/$(hostname)/proxy/configz" | \
  python3 -m json.tool | head -100

# Check eviction thresholds are applied
kubectl describe node $(hostname) | \
  grep -A10 "Conditions:"

# Check allocatable resources (should reflect reservations)
kubectl get node $(hostname) -o yaml | \
  grep -A10 "allocatable:"

# Monitor eviction events
kubectl get events -A \
  --field-selector reason=Evicted \
  --sort-by=.metadata.creationTimestamp | \
  tail -20

# Check CPU manager state
cat /var/lib/kubelet/cpu_manager_state

# Check memory manager state
cat /var/lib/kubelet/memory_manager_state
```

Kubelet configuration changes require a service restart. For production clusters, always apply changes through a rolling update: drain, reconfigure, restart, validate, uncordon — one node at a time. Critical configuration mistakes (wrong cgroupDriver, incorrect DNS) can render nodes `NotReady` and require out-of-band access to correct.
