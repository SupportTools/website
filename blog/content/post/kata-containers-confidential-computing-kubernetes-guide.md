---
title: "Kata Containers: VM-Level Isolation for Kubernetes Workloads"
date: 2027-02-12T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Kata Containers", "Confidential Computing", "Security", "Isolation"]
categories: ["Kubernetes", "Security", "Containers"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to deploying Kata Containers in Kubernetes for VM-level workload isolation: architecture, RuntimeClass, hypervisor selection, Intel TDX, AMD SEV, performance trade-offs, and troubleshooting."
more_link: "yes"
url: "/kata-containers-confidential-computing-kubernetes-guide/"
---

Standard container isolation relies on Linux namespaces and cgroups to separate workloads from each other and from the host kernel. This model is efficient, but a vulnerability in the kernel—or a container escape—affects all co-located workloads. **Kata Containers** replaces this trust boundary with a hardware-backed virtual machine for each pod, giving each workload its own kernel, memory space, and CPU context. The result is a security posture comparable to a VM, at startup times measured in seconds rather than minutes.

<!--more-->

## Architecture Overview

### Core Components

A Kata Containers deployment consists of four main components working together beneath the Kubernetes CRI boundary:

**kata-runtime** is the OCI-compatible runtime shim. It implements the `containerd-shim-kata-v2` interface and is the entry point called by containerd when a pod with the Kata RuntimeClass is scheduled.

**kata-agent** is a small Go process that runs inside the guest VM. It listens on a virtio-serial or vsock channel and executes container lifecycle operations (start, exec, stop) on behalf of the shim running in the host.

**hypervisor** is the virtual machine manager. Kata supports multiple hypervisors:

| Hypervisor | Startup Time | Memory Overhead | Notes |
|---|---|---|---|
| QEMU | ~1.5 s | ~150 MB/pod | Most compatible; supports all features |
| Cloud Hypervisor | ~0.5 s | ~80 MB/pod | Rust-based; optimized for cloud workloads |
| Firecracker | ~0.3 s | ~50 MB/pod | AWS-developed; minimal device model; no GPU passthrough |
| ACRN | ~0.8 s | ~100 MB/pod | Embedded/edge focus; less commonly used in K8s |

**kata-shim (containerd-shim-kata-v2)** bridges containerd and the hypervisor. It receives OCI bundle information from containerd and translates it into VM creation and kata-agent calls.

### Request Flow

When Kubernetes schedules a pod with the Kata RuntimeClass, the sequence is:

1. kubelet calls containerd's CRI to create the pod sandbox
2. containerd identifies the RuntimeClass handler (`kata-qemu`, `kata-clh`, etc.) and invokes `containerd-shim-kata-v2`
3. The shim launches the hypervisor with a minimal kernel image (`vmlinuz`) and an initrd containing kata-agent
4. kata-agent starts inside the VM and signals readiness over the vsock channel
5. The shim calls kata-agent to create the container inside the VM using the OCI bundle
6. The container runs inside the guest VM; all syscalls go to the guest kernel

From Kubernetes' perspective, the pod behaves identically to a standard pod. Probes, resource enforcement, logging, and networking work the same way.

## Hardware Virtualization Requirements

### Checking Host Support

Kata Containers requires hardware virtualization support. Verify before deployment:

```bash
# Check for Intel VT-x or AMD-V
grep -E "vmx|svm" /proc/cpuinfo | head -5

# Check KVM availability
ls -la /dev/kvm

# Verify nested virtualization (required in cloud VMs)
cat /sys/module/kvm_intel/parameters/nested
# or for AMD:
cat /sys/module/kvm_amd/parameters/nested

# Run kata-runtime check
kata-runtime check
```

Expected output from `kata-runtime check` on a capable host:

```
PASS: CPU is capable of running Kata Containers
PASS: CPU supports nested virtualization
PASS: Kernel modules loaded (kvm, kvm_intel/kvm_amd)
PASS: /dev/kvm device present
PASS: cgroups enabled
```

### Nested Virtualization in Cloud Providers

Running Kata Containers inside cloud VMs (common in managed Kubernetes) requires nested virtualization:

| Provider | Bare-Metal | Nested Virt | Notes |
|---|---|---|---|
| AWS | EKS bare-metal (`*.metal`) instances | `.xlarge` Nitro instances | Most instance types support nested virt via Nitro |
| Azure | AKS `Standard_D*v3` and above | Most general-purpose VMs | Enable with `--enable-nested-virtualization` in AKS preview |
| GCP | GKE bare-metal | `n2` series and above | Enable on VM creation: `--enable-nested-virtualization` |

For AWS, the `i3.metal` and `c5.metal` families provide the best performance because Kata runs directly on bare metal KVM without nested virtualization overhead.

## Installing Kata Containers with kata-deploy

### Using the Official Operator

`kata-deploy` is a DaemonSet-based installer that places Kata binaries, kernels, and runtime configurations on nodes without requiring OS packages:

```bash
# Clone the Kata Containers repository for manifests
# or install directly from the release artifacts

# Create the kata-deploy namespace and RBAC
kubectl apply -f https://raw.githubusercontent.com/kata-containers/kata-containers/main/tools/packaging/kata-deploy/kata-rbac/base/kata-rbac.yaml

# Deploy kata-deploy DaemonSet
kubectl apply -f https://raw.githubusercontent.com/kata-containers/kata-containers/main/tools/packaging/kata-deploy/kata-deploy/base/kata-deploy.yaml

# Wait for installation to complete on all nodes
kubectl -n kube-system wait --timeout=10m \
  --for=condition=Ready -l name=kata-deploy pod

# Create RuntimeClass objects for each supported hypervisor
kubectl apply -f https://raw.githubusercontent.com/kata-containers/kata-containers/main/tools/packaging/kata-deploy/runtimeclasses/kata-runtimeClasses.yaml
```

### Targeting Specific Node Pools

In production, Kata should run only on nodes with hardware virtualization support. Use a node label to control which nodes receive the `kata-deploy` DaemonSet:

```yaml
# patch kata-deploy DaemonSet to run only on kata-capable nodes
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: kata-deploy
  namespace: kube-system
spec:
  selector:
    matchLabels:
      name: kata-deploy
  template:
    spec:
      nodeSelector:
        katacontainers.io/kata-runtime: "true"
      tolerations:
      - key: katacontainers.io/kata-runtime
        operator: Equal
        value: "true"
        effect: NoSchedule
```

Label nodes before deploying:

```bash
kubectl label node worker-01 katacontainers.io/kata-runtime=true
kubectl label node worker-02 katacontainers.io/kata-runtime=true
```

### Installed RuntimeClass Objects

After `kata-deploy` completes, the following RuntimeClass objects are available:

```yaml
# List all Kata RuntimeClasses
kubectl get runtimeclass | grep kata
# NAME               HANDLER              AGE
# kata               kata-qemu            5m
# kata-clh           kata-clh             5m
# kata-clh-snp       kata-clh-snp         5m
# kata-dragonball    kata-dragonball      5m
# kata-fc            kata-fc              5m
# kata-qemu          kata-qemu            5m
# kata-qemu-coco-dev kata-qemu-coco-dev   5m
# kata-qemu-sev      kata-qemu-sev        5m
# kata-qemu-snp      kata-qemu-snp        5m
# kata-qemu-tdx      kata-qemu-tdx        5m
```

## Using RuntimeClass in Pod Specifications

### Basic Kata Pod

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: kata-test
  namespace: sandboxed
spec:
  runtimeClassName: kata-qemu
  containers:
  - name: app
    image: nginx:1.27-alpine
    ports:
    - containerPort: 80
    resources:
      requests:
        cpu: "500m"
        memory: "256Mi"
      limits:
        cpu: "2"
        memory: "512Mi"
```

Verify that the pod is running in a VM:

```bash
# On the node, list running QEMU processes
ps aux | grep qemu

# Inside the pod, check the kernel
kubectl exec -it kata-test -n sandboxed -- uname -r
# Should show the Kata guest kernel, e.g.: 5.15.0-kata
```

### Deployment with Kata RuntimeClass

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sandboxed-api
  namespace: production
spec:
  replicas: 5
  selector:
    matchLabels:
      app: sandboxed-api
  template:
    metadata:
      labels:
        app: sandboxed-api
    spec:
      runtimeClassName: kata-clh
      # Schedule on kata-capable nodes
      nodeSelector:
        katacontainers.io/kata-runtime: "true"
      tolerations:
      - key: katacontainers.io/kata-runtime
        operator: Equal
        value: "true"
        effect: NoSchedule
      containers:
      - name: api
        image: registry.example.com/sandboxed-api:2.1.0
        ports:
        - containerPort: 8080
        resources:
          requests:
            cpu: "1"
            memory: "512Mi"
          limits:
            cpu: "4"
            memory: "2Gi"
        readinessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 5
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 15
          periodSeconds: 10
```

## Performance Overhead Trade-offs

### Startup Latency

Kata containers have higher startup latency than standard containers due to VM boot time:

| Runtime | Pod Startup (p50) | Pod Startup (p99) |
|---|---|---|
| runc (standard) | 0.3 s | 1.5 s |
| kata-qemu | 1.8 s | 4.0 s |
| kata-clh | 0.8 s | 2.0 s |
| kata-fc | 0.5 s | 1.5 s |

For stateless, burst-scalable workloads where 10–50 new pods start simultaneously, the aggregate startup delay may affect `HorizontalPodAutoscaler` response time. Firecracker mitigates this best.

### Memory Overhead

Each Kata pod boots a separate kernel and kata-agent process, consuming additional memory:

```
Effective memory available to app = container limit - VM overhead

Example with QEMU:
  Container limit: 1 GiB
  QEMU overhead:   ~150 MB
  Guest kernel:    ~50 MB
  kata-agent:      ~15 MB
  Available to app: ~785 MB
```

Size container memory limits with this overhead in mind. For Firecracker, the overhead is approximately 50–80 MB total.

### CPU Overhead

Kata introduces measurable CPU overhead for syscall-heavy workloads:

- **I/O-heavy workloads** (databases, file servers): ~5–15% throughput reduction due to virtio device emulation
- **CPU-bound workloads** (encoding, computation): ~1–3% overhead
- **Network-heavy workloads**: ~3–8% overhead with virtio-net; less with vhost-user networking

For most web application and API workloads, the overhead is below 10% and acceptable for the security benefit.

## Persistent Volumes with Kata Containers

### Direct Volume Assignment (DAX)

Kata Containers supports passing block devices directly into the VM using **DAX (Direct Access)** mode, which bypasses the virtio block device layer and exposes the block device directly to the guest kernel:

```yaml
# StorageClass using local block device with DAX
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: kata-local-storage
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: WaitForFirstConsumer
```

### CSI Volumes and virtiofs

For shared or network-backed volumes, Kata uses **virtiofs** to share host directories into the VM. Most CSI drivers work transparently with Kata because the volume is staged to the host by the CSI driver and then shared into the VM via virtiofs:

```yaml
# PVC example for Kata workload - uses standard CSI
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: kata-data
  namespace: production
spec:
  accessModes:
  - ReadWriteOnce
  storageClassName: gp3-encrypted
  resources:
    requests:
      storage: 20Gi
```

The virtiofs daemon (`virtiofsd`) runs on the host per VM and handles file I/O between the host mount and the guest filesystem. This adds I/O latency of approximately 10–20% compared to runc for file-intensive workloads.

## Confidential Computing: Intel TDX and AMD SEV

### Threat Model

Standard Kata Containers protect workloads from other co-tenant containers and container escapes, but the hypervisor and host kernel remain trusted. **Confidential VMs** extend this to protect workloads even from the hypervisor and host OS, addressing threats such as:

- Malicious or compromised hypervisor
- Host OS kernel exploit
- Physical memory inspection attacks
- Cloud provider staff with host access

### Intel TDX (Trust Domain Extensions)

Intel TDX creates hardware-encrypted **Trust Domains (TDs)** that encrypt VM memory using an on-chip key unavailable to the hypervisor or OS.

**Requirements:**
- 4th Generation Intel Xeon Scalable (Sapphire Rapids) or later
- TDX-enabled BIOS firmware
- Linux kernel 6.2+ with TDX patches
- QEMU with TDX support

```yaml
# RuntimeClass for Intel TDX
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: kata-qemu-tdx
handler: kata-qemu-tdx
overhead:
  podFixed:
    cpu: "500m"
    memory: "256Mi"
scheduling:
  nodeClassification:
    tolerations:
    - key: confidentialcomputing.io/tdx
      operator: Equal
      value: "true"
      effect: NoSchedule
```

```yaml
# Pod using TDX confidential runtime
apiVersion: v1
kind: Pod
metadata:
  name: confidential-workload
  namespace: regulated
spec:
  runtimeClassName: kata-qemu-tdx
  nodeSelector:
    confidentialcomputing.io/tdx: "true"
  tolerations:
  - key: confidentialcomputing.io/tdx
    operator: Equal
    value: "true"
    effect: NoSchedule
  containers:
  - name: regulated-app
    image: registry.example.com/regulated-app:1.0.0
    env:
    - name: ATTESTATION_ENDPOINT
      value: "https://attestation.example.com/v1/attest"
    resources:
      requests:
        cpu: "2"
        memory: "4Gi"
      limits:
        cpu: "8"
        memory: "8Gi"
```

### AMD SEV-SNP (Secure Encrypted Virtualization - Secure Nested Paging)

AMD SEV-SNP provides similar memory encryption for AMD EPYC processors and additionally supports VM integrity attestation via SNP certificates:

```yaml
# RuntimeClass for AMD SEV-SNP
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: kata-clh-snp
handler: kata-clh-snp
overhead:
  podFixed:
    cpu: "250m"
    memory: "128Mi"
```

The Cloud Hypervisor (`kata-clh-snp`) is preferred for AMD SEV-SNP because it has a smaller attack surface than QEMU.

### Remote Attestation

Confidential VMs should be verified before receiving sensitive data. The kata-agent can participate in remote attestation by providing TEE-signed quotes:

```bash
# Verify TDX attestation quote (conceptual flow)
# 1. Application requests quote from the kata-agent via vsock
# 2. kata-agent calls the TDX IOCTL to generate a hardware-signed quote
# 3. Application sends quote to attestation service
# 4. Attestation service verifies the quote against Intel's root CA
# 5. If valid, attestation service returns a short-lived token
# 6. Application uses token to access secrets vault

# The Intel Trust Authority CLI can be used for attestation verification:
# trustauthority-cli token --config ta-config.json
```

## Network Performance Considerations

### virtio-net vs vhost-user

Kata uses **virtio-net** by default for guest networking. In high-throughput scenarios, **vhost-user** provides better performance by moving packet processing to a user-space daemon:

```toml
# /etc/kata-containers/configuration-qemu.toml
[network]
# Use vhost-user for better network performance
# Requires DPDK or vhost-user-net daemon on the host
use_vsock = true
# Increase the number of virtual CPUs for network-heavy workloads
default_vcpus = 2
default_memory = 512
```

### CNI Compatibility

Most CNI plugins work with Kata Containers by placing the network namespace on the host side of the VM boundary (tap device). Tested combinations:

| CNI | Kata Compatibility | Notes |
|---|---|---|
| Calico (VXLAN) | Full | Recommended |
| Calico (BGP) | Full | Recommended |
| Cilium (eBPF) | Limited | eBPF programs run on host, not inside VM |
| Flannel | Full | Simple; suitable for development |
| AWS VPC CNI | Full | Tested on EKS bare-metal nodes |
| Azure CNI | Full | Tested on AKS |

## Monitoring Kata Workloads

### kata-monitor

Kata Containers provides a monitoring shim that exposes metrics about running VMs:

```bash
# kata-monitor exposes metrics on port 8090 by default
# Scrape it with Prometheus

# Check if kata-monitor is running on a node
ps aux | grep kata-monitor

# Metrics include:
# kata_hypervisor_count - number of running hypervisor instances
# kata_hypervisor_vcpu_time - CPU time consumed by VMs
# kata_hypervisor_memory_used_bytes - memory used by VMs
```

### Prometheus ServiceMonitor for kata-monitor

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: kata-monitor
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: kata-monitor
  endpoints:
  - port: metrics
    interval: 30s
    path: /metrics
```

### Key Metrics and Alerts

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kata-alerts
  namespace: monitoring
spec:
  groups:
  - name: kata.containers
    rules:
    - alert: KataVMStartupSlowness
      expr: |
        histogram_quantile(0.99, rate(kata_shim_pod_start_duration_seconds_bucket[5m])) > 10
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Kata VM startup p99 exceeds 10 seconds"
        description: "Kata VM startup slowness may indicate hypervisor resource pressure"

    - alert: KataVMHighMemoryOverhead
      expr: |
        (sum(kata_hypervisor_memory_used_bytes) by (node)) /
        (sum(node_memory_MemTotal_bytes) by (node)) > 0.3
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Kata VM overhead exceeds 30% of node memory"
        description: "Node {{ $labels.node }} has high Kata VM memory overhead"
```

## Production Sizing and Node Configuration

### Recommended Node Profiles

**For Kata-QEMU workloads:**
- Minimum: 8 vCPU, 32 GB RAM
- Recommended: 16 vCPU, 64 GB RAM
- Reason: Each QEMU process consumes ~150 MB + guest memory; at 20 pods/node, overhead is ~3 GB

**For Kata-Firecracker workloads:**
- Minimum: 4 vCPU, 16 GB RAM
- Recommended: 8 vCPU, 32 GB RAM
- Reason: Lower per-VM overhead (~80 MB) allows higher pod density

**For Confidential VMs (TDX/SEV-SNP):**
- Requires specific hardware; align with cloud provider's confidential computing instance types
- AKS: `Standard_DC*ads_v5` series (Intel TDX), `Standard_EC*ads_v5` (AMD SEV-SNP)
- GCP: `c3-confidential-*` (Intel TDX), `n2d-confidential-*` (AMD SEV-SNP)

### Node Taints for Kata-Only Scheduling

Prevent non-Kata workloads from landing on expensive confidential computing nodes:

```bash
# Taint kata-capable nodes
kubectl taint node kata-worker-01 katacontainers.io/kata-runtime=true:NoSchedule

# Taint confidential computing nodes
kubectl taint node tdx-worker-01 confidentialcomputing.io/tdx=true:NoSchedule
```

## Troubleshooting Kata Startup Failures

### Diagnosing VM Boot Failures

```bash
# Check containerd shim logs for kata
journalctl -u containerd -f | grep -i kata

# Check dmesg for KVM errors
dmesg | grep -E "kvm|qemu|vmx|svm" | tail -20

# Enable debug logging in kata configuration
# /etc/kata-containers/configuration-qemu.toml
# [hypervisor.qemu]
# enable_debug = true

# Check kata-runtime debug output
kata-runtime --log-level=debug check 2>&1 | tail -30
```

### Common Failure Modes

**Failure: `failed to create containerd task: failed to create shim: OCI runtime exec failed`**

Cause: The `containerd-shim-kata-v2` binary is not in the PATH or is not executable.

```bash
# Verify the shim binary
which containerd-shim-kata-v2
ls -la $(which containerd-shim-kata-v2)

# If kata-deploy was used, check the symlinks
ls -la /opt/kata/bin/
```

**Failure: `KVM: exiting vm, ret -22`**

Cause: Hardware virtualization is not available or nested virtualization is not enabled.

```bash
# Enable nested virtualization (Intel)
modprobe -r kvm_intel && modprobe kvm_intel nested=1
echo "options kvm_intel nested=1" > /etc/modprobe.d/kvm_intel.conf
```

**Failure: Pod stuck in `ContainerCreating` with kata RuntimeClass**

```bash
# Check the sandbox creation log - replace with the actual pod name
kubectl describe pod sandboxed-api-7f8b9c5d6-abc12 -n production
# Look for: "failed to create sandbox"

# Check kata-monitor metrics for in-progress VM boots
curl -s http://localhost:8090/metrics | grep kata_shim
```

**Failure: `error opening serial port: open /dev/pts/X: permission denied`**

Cause: The `containerd-shim-kata-v2` process lacks permissions to create PTY devices.

```bash
# Check containerd AppArmor profile
aa-status | grep containerd

# If AppArmor is blocking, add exceptions for kata-specific device paths
# or disable AppArmor for the containerd profile on kata nodes
```

### Verifying Isolation

After deploying a Kata pod, verify that it is actually running in a separate VM:

```bash
# List running QEMU or Cloud Hypervisor processes on the node
# (requires SSH access to the node)
pgrep -a qemu-system || pgrep -a cloud-hypervisor || pgrep -a firecracker

# The output should show one process per Kata pod

# From inside the pod, the kernel should be the Kata guest kernel
kubectl exec -it <kata-pod> -- uname -r
# Expected: something like 5.15.0-kata-containers or 6.1.62-kata

# The /proc/cpuinfo inside the pod should show a virtual CPU
kubectl exec -it <kata-pod> -- cat /proc/cpuinfo | grep "model name"
```

## Security Policy Enforcement with Kata

### Kata Guest Components Policy

Kata 3.x introduces a **guest policy** mechanism that enforces which OCI bundles the kata-agent will accept. This prevents the host (even a compromised hypervisor) from injecting arbitrary containers into the VM:

```toml
# Kata configuration: enable policy enforcement
[agent.kata]
enable_tracing = false
# Path to the Rego policy file
policy_path = "/etc/kata-containers/policy.rego"
```

```rego
# /etc/kata-containers/policy.rego
# Allow only containers matching a known digest
package agent_policy

default AllowRequestsFailingPolicy := false

CreateContainerRequest {
    input.OCI.Annotations["io.kubernetes.cri.image-name"] == "registry.example.com/regulated-app@sha256:abc123def456"
}
```

This policy model is foundational for workloads that require supply-chain integrity guarantees in confidential computing deployments.
