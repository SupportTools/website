---
title: "Linux cgroups v1 to v2 Migration: systemd Integration and Container Runtime Compatibility"
date: 2031-09-08T00:00:00-05:00
draft: false
tags: ["Linux", "cgroups", "systemd", "Kubernetes", "Container Runtime", "containerd", "Performance"]
categories:
- Linux
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-focused guide to migrating from Linux cgroups v1 to cgroups v2, covering systemd integration, container runtime compatibility with containerd and Docker, and Kubernetes node configuration."
more_link: "yes"
url: "/linux-cgroups-v1-v2-migration-systemd-container-runtime-compatibility/"
---

cgroups v2 has been the default in major Linux distributions since Ubuntu 22.04, Fedora 31, and RHEL 9. Despite this, many production Kubernetes nodes still run on cgroups v1 due to compatibility concerns with older container runtimes, eBPF tools, and monitoring agents. The migration is now well-understood and the benefits — unified hierarchy, improved memory accounting, PSI (Pressure Stall Information) metrics, and better systemd integration — make it worth the effort.

This guide covers everything an infrastructure team needs to plan and execute a cgroups v1 to v2 migration on Kubernetes nodes: understanding the architectural differences, configuring systemd delegation, ensuring containerd and other runtimes are compatible, and validating that your workloads behave correctly after the transition.

<!--more-->

# Linux cgroups v1 to v2 Migration

## Understanding the Architecture Differences

### cgroups v1: The Legacy Hierarchy

cgroups v1 uses multiple independent hierarchies, one per subsystem (controller). Each subsystem — `cpu`, `memory`, `blkio`, `net_cls`, `pids`, etc. — has its own tree:

```
/sys/fs/cgroup/
├── blkio/
│   └── system.slice/
│       └── containerd.service/
│           └── docker-<id>.scope/
├── cpu,cpuacct/
│   └── system.slice/
│       └── containerd.service/
│           └── docker-<id>.scope/
├── memory/
│   └── system.slice/
│       └── containerd.service/
│           └── docker-<id>.scope/
└── pids/
    └── system.slice/
        ...
```

Problems with v1:
- No unified hierarchy: a process can be in different parts of different trees
- Root-only writes to most controllers (systemd partially solved this with delegation but it is complex)
- Memory accounting bugs: `rss` vs `rss+swap` confusion, kernel memory not always charged
- No memory.low (soft guarantee) semantics
- No Pressure Stall Information (PSI)
- Thread group / task count inconsistencies

### cgroups v2: The Unified Hierarchy

cgroups v2 uses a single tree with all controllers:

```
/sys/fs/cgroup/
├── cgroup.controllers          # Available controllers at root
├── cgroup.subtree_control      # Controllers enabled for children
├── cgroup.procs                # Processes in root cgroup
├── system.slice/
│   ├── cgroup.controllers
│   ├── cgroup.subtree_control
│   └── containerd.service/
│       ├── cgroup.controllers
│       ├── cgroup.procs
│       ├── memory.current
│       ├── memory.max
│       ├── cpu.stat
│       ├── cpu.max
│       └── pids.max
└── user.slice/
    ...
```

Benefits:
- Single unified hierarchy: a process is in exactly one place in the tree
- Thread-level granularity with the `threaded` mode
- `memory.low` for soft memory guarantees (Kubernetes requests map to this)
- `memory.high` for gradual throttling before hard kill
- PSI (Pressure Stall Information) for I/O, CPU, and memory pressure metrics
- Proper unified cgroup delegation to unprivileged users

## Checking Current cgroups Version

```bash
# Check which version is mounted
mount | grep cgroup
# cgroup v2: "cgroup2 on /sys/fs/cgroup type cgroup2"
# cgroup v1: "tmpfs on /sys/fs/cgroup type tmpfs" + multiple "cgroup on ..."

# Check kernel parameter
cat /proc/cmdline | grep -o 'cgroup_no_v1=[^ ]*'
# or
cat /sys/fs/cgroup/cgroup.controllers  # Exists only on v2

# Check systemd's view
systemctl status --no-pager | head -5
# Look for: "CGroup: /init.scope" (v2) vs multiple subsystems (v1)

# Check with systemd-cgls
systemd-cgls /
```

## Pre-Migration Compatibility Assessment

Before migrating, audit your stack for v2 compatibility issues:

### Kernel Version Requirements

```bash
uname -r
# Minimum: 4.15 for basic v2
# Recommended: 5.8+ for full feature set including io controller
# Required for Kubernetes MemoryQoS: 5.8+
```

### Container Runtime Version Requirements

| Runtime | Minimum Version for cgroupsv2 |
|---------|-------------------------------|
| containerd | 1.4.0+ |
| CRI-O | 1.20+ |
| Docker Engine | 20.10+ |
| runc | 1.0.0-rc91+ |

```bash
# Check containerd version
containerd --version

# Check runc version
runc --version

# Check crun version (alternative OCI runtime used by CRI-O/Podman)
crun --version
```

### Kubernetes Version Requirements

| Feature | Minimum k8s Version |
|---------|---------------------|
| cgroups v2 support | 1.19 |
| cgroups v2 GA | 1.25 |
| MemoryQoS (alpha) | 1.22 |
| MemoryQoS (beta) | 1.27 |

```bash
kubectl version --short
```

### Checking Workload Compatibility

Some workloads have compatibility issues:

```bash
# Check for containers that might use systemd inside the container
# These require cgroup delegation which is better in v2 but
# may need explicit security context settings

# Containers using cgroup namespaces
kubectl get pods -A -o json | \
  jq -r '.items[] | select(.spec.hostIPC == true or .spec.hostPID == true) | .metadata.namespace + "/" + .metadata.name'

# Containers with privileged access that write to /sys/fs/cgroup
kubectl get pods -A -o json | \
  jq -r '.items[] | select(.spec.containers[].securityContext.privileged == true) | .metadata.namespace + "/" + .metadata.name'
```

## Enabling cgroups v2

### Method 1: GRUB Configuration (Persistent)

```bash
# On Ubuntu/Debian
sudo sed -i 's/GRUB_CMDLINE_LINUX="/GRUB_CMDLINE_LINUX="systemd.unified_cgroup_hierarchy=1 /' /etc/default/grub
sudo update-grub

# On RHEL/CentOS
sudo grubby --update-kernel=ALL --args="systemd.unified_cgroup_hierarchy=1"

# Or directly in /etc/default/grub:
GRUB_CMDLINE_LINUX="... systemd.unified_cgroup_hierarchy=1"
```

### Method 2: systemd Boot Parameter

```bash
# For Systemd-boot (modern systems)
cat /boot/efi/loader/entries/$(bootctl list --no-pager | grep "default" | awk '{print $2}')
# Add systemd.unified_cgroup_hierarchy=1 to options line
```

### Disabling v1 Controllers Completely (Optional but Recommended)

To prevent hybrid mode (v1 and v2 both active):

```bash
# Add to kernel cmdline
cgroup_no_v1=all

# Or disable specific controllers
cgroup_no_v1=memory,blkio
```

After changing kernel parameters, reboot. Verify:

```bash
cat /sys/fs/cgroup/cgroup.controllers
# Expected: cpuset cpu io memory hugetlb pids rdma misc
```

## systemd Integration and Configuration

### systemd Delegation for Container Runtimes

systemd is the init system and manages cgroup delegation. On v2, systemd becomes the authoritative manager of the cgroup tree, and container runtimes must operate within delegated subtrees.

Configure systemd to delegate the full set of controllers to containerd:

```bash
# Create containerd systemd override
sudo mkdir -p /etc/systemd/system/containerd.service.d/
cat << 'EOF' | sudo tee /etc/systemd/system/containerd.service.d/override.conf
[Service]
Delegate=yes
KillMode=process
OOMScoreAdjust=-999

# Ensure the containerd service has its own cgroup
CPUAccounting=yes
MemoryAccounting=yes
IOAccounting=yes
TasksAccounting=yes
EOF

sudo systemctl daemon-reload
sudo systemctl restart containerd
```

### Verifying Delegation

```bash
# Check that containerd's cgroup has controllers enabled
cat /sys/fs/cgroup/system.slice/containerd.service/cgroup.controllers
# Expected: cpuset cpu io memory hugetlb pids

# Check that delegation is enabled in systemd
systemctl show containerd | grep Delegate
# Expected: Delegate=yes
```

### systemd Slice Configuration for Kubernetes

Kubernetes uses systemd cgroup driver with a specific slice structure. Configure the kubelet to use systemd cgroup driver:

```bash
# /var/lib/kubelet/config.yaml
cat << 'EOF' | sudo tee /var/lib/kubelet/config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cgroupDriver: systemd
cgroupsPerQOS: true
cgroupRoot: /
systemReserved:
  cpu: 200m
  memory: 200Mi
  ephemeral-storage: 1Gi
kubeReserved:
  cpu: 200m
  memory: 200Mi
  ephemeral-storage: 1Gi
evictionHard:
  memory.available: 200Mi
  nodefs.available: 10%
  nodefs.inodesFree: 5%
  imagefs.available: 10%
EOF
```

### Understanding the Kubernetes cgroup Hierarchy on v2

With systemd cgroup driver, Kubernetes creates this structure:

```
/sys/fs/cgroup/
└── kubepods.slice/                    # All Kubernetes pods
    ├── kubepods-burstable.slice/      # Burstable QoS
    │   └── kubepods-burstable-pod<uid>.slice/
    │       └── <container-id>.scope/
    ├── kubepods-besteffort.slice/     # BestEffort QoS
    │   └── kubepods-besteffort-pod<uid>.slice/
    │       └── <container-id>.scope/
    └── pod<uid>.slice/                # Guaranteed QoS (no class prefix)
        └── <container-id>.scope/
```

## containerd Configuration for cgroups v2

### containerd config.toml

```toml
# /etc/containerd/config.toml
version = 2

[plugins."io.containerd.grpc.v1.cri"]
  [plugins."io.containerd.grpc.v1.cri".containerd]
    default_runtime_name = "runc"

    [plugins."io.containerd.grpc.v1.cri".containerd.runtimes]
      [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
        runtime_type = "io.containerd.runc.v2"
        [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
          SystemdCgroup = true   # CRITICAL: must be true for cgroups v2

  [plugins."io.containerd.grpc.v1.cri".cni]
    bin_dir = "/opt/cni/bin"
    conf_dir = "/etc/cni/net.d"

[plugins."io.containerd.internal.v1.opt"]
  path = "/opt/containerd"
```

The `SystemdCgroup = true` setting tells runc to use the systemd cgroup driver instead of cgroupfs. This is **required** for cgroups v2 with Kubernetes.

```bash
sudo systemctl restart containerd

# Verify
containerd config dump | grep -A2 "SystemdCgroup"
```

### Configuring Docker for cgroups v2

If Docker is used directly (non-Kubernetes nodes):

```json
// /etc/docker/daemon.json
{
  "exec-opts": ["native.cgroupdriver=systemd"],
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "100m",
    "max-file": "5"
  },
  "storage-driver": "overlay2",
  "features": {
    "buildkit": true
  }
}
```

```bash
sudo systemctl daemon-reload
sudo systemctl restart docker

# Verify
docker info | grep "Cgroup Driver"
# Expected: Cgroup Driver: systemd
docker info | grep "Cgroup Version"
# Expected: Cgroup Version: 2
```

## Kubernetes Node Migration Process

### Step 1: Cordon the Node

```bash
kubectl cordon <node-name>
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data
```

### Step 2: Update Kernel Parameters

```bash
# On the node
sudo grubby --update-kernel=ALL --args="systemd.unified_cgroup_hierarchy=1 cgroup_no_v1=all"
```

### Step 3: Update containerd Configuration

Apply the `config.toml` changes above with `SystemdCgroup = true`.

### Step 4: Update kubelet Configuration

```bash
# Verify kubelet cgroupDriver setting
cat /var/lib/kubelet/config.yaml | grep cgroupDriver
# Must be: cgroupDriver: systemd
```

### Step 5: Reboot the Node

```bash
sudo reboot
```

### Step 6: Validate Post-Reboot

```bash
# Verify cgroup v2 is active
cat /sys/fs/cgroup/cgroup.controllers

# Check containerd is running and using systemd driver
systemctl status containerd
crictl info | jq '.config.cgroupDriver'
# Expected: "systemd"

# Verify kubelet reports healthy
kubectl get node <node-name>
kubectl describe node <node-name> | grep -A5 "Conditions:"
```

### Step 7: Uncordon the Node

```bash
kubectl uncordon <node-name>
```

Monitor the node for 24 hours before migrating the next node. Watch for:

```bash
# Check for OOMKilled pods
kubectl get pods -A | grep OOMKilled

# Check kubelet logs for cgroup-related errors
journalctl -u kubelet -f --since "1 hour ago" | grep -i cgroup

# Monitor memory.events for unexpected kills
for cg in /sys/fs/cgroup/kubepods.slice/**/*.scope; do
    count=$(cat "$cg/memory.events" 2>/dev/null | grep -c "oom_kill [^0]")
    [ "$count" -gt "0" ] && echo "$cg: $count OOM kills"
done
```

## cgroups v2 Features and Kubernetes Integration

### PSI Metrics

PSI (Pressure Stall Information) is one of the most valuable new features. It measures how much time tasks are stalled waiting for CPU, memory, or I/O:

```bash
# Node-level pressure
cat /sys/fs/cgroup/cpu.pressure
# some avg10=0.12 avg60=0.04 avg300=0.01 total=1234567
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0

cat /sys/fs/cgroup/memory.pressure
# some avg10=1.24 avg60=0.87 avg300=0.23 total=987654
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0

# Pod-level pressure
POD_CGROUP="/sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod<uid>.slice"
cat "$POD_CGROUP/memory.pressure"
```

PSI is exposed via `node_exporter` with the `--collector.pressure` flag:

```yaml
# Node exporter DaemonSet args
args:
  - "--collector.pressure"
  - "--path.sysfs=/host/sys"
  - "--path.procfs=/host/proc"
  - "--path.rootfs=/rootfs"
```

Alert on PSI in Prometheus:

```promql
# Alert when memory pressure stall time exceeds 10% over 5 minutes
node_pressure_memory_stalled_seconds_total
  rate(node_pressure_memory_stalled_seconds_total[5m]) > 0.1
```

### Memory QoS in Kubernetes (MemoryQoS)

With cgroups v2, Kubernetes can use `memory.min`, `memory.low`, and `memory.high` for better memory management:

```yaml
# Enable MemoryQoS feature gate on kubelet
# /var/lib/kubelet/config.yaml
featureGates:
  MemoryQoS: true
```

When enabled, Kubernetes maps pod resources:

| cgroup v2 file | Kubernetes mapping |
|----------------|-------------------|
| `memory.min` | Guaranteed QoS: `requests.memory` |
| `memory.low` | Burstable QoS: `requests.memory` |
| `memory.max` | All QoS: `limits.memory` |
| `memory.high` | Calculated: 80% of `limits.memory` |

### Enhanced CPU Accounting

cgroups v2 `cpu.stat` provides more detailed CPU accounting:

```bash
cat /sys/fs/cgroup/kubepods.slice/cpu.stat
# usage_usec 1234567890
# user_usec 987654321
# system_usec 246913579
# nr_periods 12345
# nr_throttled 123
# throttled_usec 45678
# nr_bursts 0
# burst_usec 0
```

This `throttled_usec` metric is the most actionable: it shows CPU-throttled time even when CPU usage appears low.

## Monitoring and Alerting After Migration

### Key cgroup v2 Metrics

```bash
# Check if containers are CPU throttled
cat /sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod<uid>.slice/<container>.scope/cpu.stat | grep throttled

# Container memory accounting
cat /sys/fs/cgroup/kubepods.slice/.../memory.stat
# anon: 45678912
# file: 123456789
# sock: 1234
# shmem: 0
# ...
# pgfault: 1234567
# pgmajfault: 123   # Major page faults indicate swap/disk pressure
```

### Grafana Dashboard Queries for cgroup v2

```promql
# CPU throttling ratio per container
rate(container_cpu_cfs_throttled_seconds_total[5m])
  / rate(container_cpu_usage_seconds_total[5m])

# Memory usage vs limits with v2 breakdown
container_memory_working_set_bytes{container!=""}
  / container_spec_memory_limit_bytes{container!=""} * 100

# PSI memory pressure per node
rate(node_pressure_memory_waiting_seconds_total[5m])
```

## Troubleshooting Common Issues

### Issue: Pods OOMKilled After Migration

Symptom: Pods that were stable on v1 are OOMKilled on v2.

Root cause: cgroups v2 has more accurate memory accounting. Kernel page cache and reclaimable memory that was not charged in v1 now counts toward the limit.

Fix options:
1. Increase memory limits by 10-20% initially, then profile actual usage
2. Enable `MemoryQoS` to use `memory.high` for soft throttling before OOM
3. Investigate kernel slab cache: `kubectl exec pod -- cat /sys/fs/cgroup/memory.stat | grep slab`

### Issue: containerd Fails to Start After Migration

```bash
journalctl -u containerd -n 50

# Common error: "failed to create containerd-shim-runc-v2 task"
# Fix: ensure SystemdCgroup = true in containerd config
# And restart containerd after config change

sudo systemctl restart containerd
```

### Issue: kubelet Reports cgroup Error

```bash
journalctl -u kubelet -n 50 | grep -i "cgroup"
# Common: "cgroup v1 and v2 are both not enabled"
# This usually means the kernel parameter did not take effect

# Verify kernel parameters
cat /proc/cmdline | grep cgroup

# Check if hybrid mode is active (both v1 and v2 mounted)
mount | grep cgroup
```

### Issue: cgroupsv2 Not Detected by Kubernetes

```bash
# Check kubelet sees cgroups v2
kubectl get node <node> -o json | jq '.status.nodeInfo.kernelVersion'
kubectl get node <node> -o json | jq '.metadata.annotations'

# Kubelet condition
kubectl describe node <node> | grep -A2 "KernelHasNoUnifiedCgroupHierarchy"
```

### Issue: eBPF Tools Not Working

Some eBPF tools (older versions of bpftrace, BCC) may not support v2's unified hierarchy. Upgrade them:

```bash
# For bcc
apt-get install bpfcc-tools

# For bpftrace
apt-get install bpftrace

# Check kernel BPF support
bpftool feature
```

## Summary

Migrating from cgroups v1 to v2 is a well-defined process with clear benefits for Kubernetes workloads:

1. **Assess compatibility** first: kernel version, container runtime versions, workload requirements
2. **Update containerd** with `SystemdCgroup = true` — this is the most critical configuration change
3. **Migrate nodes one at a time** using the cordon/drain/reboot/validate/uncordon pattern
4. **Enable PSI metrics** via node_exporter immediately after migration — this is a significant new observability capability
5. **Consider enabling MemoryQoS** for better handling of burstable workloads
6. **Increase memory limits** temporarily until you can measure actual v2 accounting overhead

The migration pays dividends through better memory pressure visibility, more accurate accounting, improved systemd integration, and access to modern Linux kernel memory management features that Kubernetes continues to build on.
