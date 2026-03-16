---
title: "Confidential Computing with Kata Containers: Enterprise Security Guide for Kubernetes"
date: 2026-05-16T00:00:00-05:00
draft: false
tags: ["Kata Containers", "Confidential Computing", "Security", "Kubernetes", "TEE", "SGX", "SEV", "Container Security"]
categories: ["Kubernetes", "Security", "Confidential Computing"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing confidential computing with Kata Containers in Kubernetes, including hardware-based isolation, encrypted memory, and secure enclave deployment patterns."
more_link: "yes"
url: "/confidential-computing-kata-containers-production-guide/"
---

Confidential computing represents the next frontier in cloud security, providing hardware-based protection for data in use. This comprehensive guide explores implementing confidential computing with Kata Containers in Kubernetes, leveraging technologies like Intel SGX, AMD SEV, and ARM TrustZone for enterprise-grade workload isolation and memory encryption.

<!--more-->

# Confidential Computing with Kata Containers: Production Implementation Guide

## Executive Summary

Confidential computing uses hardware-based Trusted Execution Environments (TEEs) to protect data during processing, addressing the final frontier of data security—data in use. Kata Containers provides lightweight VM isolation for Kubernetes workloads, and when combined with confidential computing technologies, offers unprecedented security guarantees. This guide provides comprehensive coverage of confidential computing concepts, Kata Containers deployment, TEE integration, and production operational patterns for enterprise environments processing sensitive data.

## Understanding Confidential Computing

### The Three States of Data Security

```
┌────────────────────────────────────────────────────────┐
│          Data Security Landscape                       │
├────────────────────────────────────────────────────────┤
│  1. Data at Rest                                       │
│     ├─ Full Disk Encryption (LUKS, dm-crypt)         │
│     ├─ Database Encryption (TDE)                      │
│     └─ File-level Encryption                          │
│                                                        │
│  2. Data in Transit                                    │
│     ├─ TLS/mTLS                                       │
│     ├─ VPN Tunnels                                    │
│     └─ IPsec                                          │
│                                                        │
│  3. Data in Use ← Confidential Computing              │
│     ├─ Memory Encryption                              │
│     ├─ Secure Enclaves                                │
│     └─ Hardware Isolation                             │
└────────────────────────────────────────────────────────┘
```

### Trusted Execution Environments (TEE)

**Intel SGX (Software Guard Extensions):**
```
┌───────────────────────────────────────────┐
│         Application Process               │
│  ┌─────────────────────────────────────┐ │
│  │      SGX Enclave (Protected)        │ │
│  │  ┌───────────────────────────────┐  │ │
│  │  │   Sensitive Data & Code       │  │ │
│  │  │   (Encrypted in Memory)       │  │ │
│  │  └───────────────────────────────┘  │ │
│  │         Isolated from:              │ │
│  │         • OS/Hypervisor             │ │
│  │         • Other Processes           │ │
│  │         • Physical Attacks          │ │
│  └─────────────────────────────────────┘ │
└───────────────────────────────────────────┘
```

**AMD SEV (Secure Encrypted Virtualization):**
```
┌────────────────────────────────────────────┐
│            Hypervisor                      │
│  ┌──────────────────────────────────────┐ │
│  │      Guest VM (Encrypted Memory)     │ │
│  │  ┌────────────────────────────────┐  │ │
│  │  │   Application Workload         │  │ │
│  │  │   Transparent Encryption       │  │ │
│  │  └────────────────────────────────┘  │ │
│  │  • Per-VM Encryption Key           │ │
│  │  • Isolated from Hypervisor        │ │
│  └──────────────────────────────────────┘ │
└────────────────────────────────────────────┘
```

### Kata Containers Architecture

```
┌────────────────────────────────────────────────────────┐
│                  Kubernetes Node                       │
│  ┌──────────────────────────────────────────────────┐ │
│  │            Container Runtime (containerd)         │ │
│  │  ┌────────────────────────────────────────────┐  │ │
│  │  │         Kata Runtime (kata-runtime)        │  │ │
│  │  │  ┌──────────────────────────────────────┐  │  │ │
│  │  │  │    Lightweight VM (QEMU/Firecracker) │  │  │ │
│  │  │  │  ┌────────────────────────────────┐  │  │  │ │
│  │  │  │  │    Guest Kernel              │  │  │  │ │
│  │  │  │  │  ┌──────────────────────┐    │  │  │  │ │
│  │  │  │  │  │  Container Workload   │    │  │  │  │ │
│  │  │  │  │  │  (Isolated in VM)     │    │  │  │  │ │
│  │  │  │  │  └──────────────────────┘    │  │  │  │ │
│  │  │  │  └────────────────────────────────┘  │  │  │ │
│  │  │  │      Hardware Isolation (TEE)        │  │  │ │
│  │  │  └──────────────────────────────────────┘  │  │ │
│  │  └────────────────────────────────────────────┘  │ │
│  └──────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────┘
```

## Hardware Requirements and Verification

### Checking TEE Support

```bash
#!/bin/bash
# check-tee-support.sh

set -euo pipefail

echo "=== Checking Trusted Execution Environment Support ==="

# Check for Intel SGX
echo -e "\n1. Intel SGX Support:"
if [ -f /dev/sgx_enclave ] || [ -f /dev/sgx/enclave ]; then
    echo "✓ SGX device found"

    # Check SGX capabilities
    if command -v sgx-detect &> /dev/null; then
        sgx-detect
    else
        echo "! sgx-detect not installed"
        echo "  Install: apt-get install cpuid"
    fi

    # Check for SGX driver
    lsmod | grep sgx || echo "! SGX driver not loaded"
else
    echo "✗ SGX device not found"
fi

# Check CPU features for SGX
if grep -q sgx /proc/cpuinfo; then
    echo "✓ CPU supports SGX"
else
    echo "✗ CPU does not support SGX"
fi

# Check for AMD SEV
echo -e "\n2. AMD SEV Support:"
if [ -f /dev/sev ]; then
    echo "✓ SEV device found"

    # Check SEV capabilities
    if [ -f /sys/module/kvm_amd/parameters/sev ]; then
        SEV_STATUS=$(cat /sys/module/kvm_amd/parameters/sev)
        if [ "$SEV_STATUS" = "1" ] || [ "$SEV_STATUS" = "Y" ]; then
            echo "✓ SEV enabled in KVM"
        else
            echo "✗ SEV not enabled in KVM"
        fi
    fi
else
    echo "✗ SEV device not found"
fi

# Check CPU features for SEV
if grep -q sev /proc/cpuinfo; then
    echo "✓ CPU supports SEV"
else
    echo "✗ CPU does not support SEV"
fi

# Check for SEV-SNP
if grep -q sev_snp /proc/cpuinfo; then
    echo "✓ CPU supports SEV-SNP (Secure Nested Paging)"
else
    echo "✗ CPU does not support SEV-SNP"
fi

# Check virtualization support
echo -e "\n3. Virtualization Support:"
if grep -E 'vmx|svm' /proc/cpuinfo > /dev/null; then
    echo "✓ Hardware virtualization supported"

    # Check if KVM is loaded
    if lsmod | grep -q kvm; then
        echo "✓ KVM module loaded"
    else
        echo "✗ KVM module not loaded"
    fi
else
    echo "✗ Hardware virtualization not supported"
fi

# Check IOMMU
echo -e "\n4. IOMMU Support:"
if dmesg | grep -E "DMAR|AMD-Vi" > /dev/null; then
    echo "✓ IOMMU detected"
else
    echo "✗ IOMMU not detected"
fi

# Check kernel parameters
echo -e "\n5. Kernel Parameters:"
if grep -q "intel_iommu=on" /proc/cmdline; then
    echo "✓ Intel IOMMU enabled"
elif grep -q "amd_iommu=on" /proc/cmdline; then
    echo "✓ AMD IOMMU enabled"
else
    echo "! IOMMU may not be enabled in kernel parameters"
fi

echo -e "\n=== TEE Support Check Complete ==="
```

### BIOS/UEFI Configuration

```bash
#!/bin/bash
# verify-bios-settings.sh

echo "Required BIOS/UEFI Settings for Confidential Computing:"
echo ""
echo "Intel Platforms:"
echo "  1. Enable Intel VT-x (Virtualization Technology)"
echo "  2. Enable Intel VT-d (Virtualization Technology for Directed I/O)"
echo "  3. Enable Intel SGX (Software Guard Extensions)"
echo "     - Set SGX to 'Enabled' or 'Software Controlled'"
echo "     - Allocate SGX EPC memory (recommended: 128MB+)"
echo "  4. Enable TPM 2.0"
echo ""
echo "AMD Platforms:"
echo "  1. Enable AMD-V (AMD Virtualization)"
echo "  2. Enable AMD IOMMU"
echo "  3. Enable SEV (Secure Encrypted Virtualization)"
echo "     - Enable SEV-ES (Encrypted State)"
echo "     - Enable SEV-SNP (Secure Nested Paging) if available"
echo "  4. Enable TPM 2.0"
echo ""
echo "After BIOS configuration, verify kernel boot parameters include:"
echo "  Intel: intel_iommu=on iommu=pt"
echo "  AMD: amd_iommu=on iommu=pt"
```

## Installing Kata Containers

### Prerequisites Installation

```bash
#!/bin/bash
# install-kata-prerequisites.sh

set -euo pipefail

echo "Installing Kata Containers prerequisites..."

# Update system
apt-get update
apt-get upgrade -y

# Install required packages
apt-get install -y \
    apt-transport-https \
    ca-certificates \
    curl \
    gnupg \
    lsb-release \
    qemu-kvm \
    qemu-utils \
    libvirt-daemon-system \
    libvirt-clients \
    bridge-utils \
    cloud-image-utils

# Install containerd
CONTAINERD_VERSION="1.7.13"
curl -LO https://github.com/containerd/containerd/releases/download/v${CONTAINERD_VERSION}/containerd-${CONTAINERD_VERSION}-linux-amd64.tar.gz
tar Cxzvf /usr/local containerd-${CONTAINERD_VERSION}-linux-amd64.tar.gz
rm containerd-${CONTAINERD_VERSION}-linux-amd64.tar.gz

# Create containerd systemd service
cat > /etc/systemd/system/containerd.service <<'EOF'
[Unit]
Description=containerd container runtime
Documentation=https://containerd.io
After=network.target local-fs.target

[Service]
ExecStartPre=-/sbin/modprobe overlay
ExecStart=/usr/local/bin/containerd
Type=notify
Delegate=yes
KillMode=process
Restart=always
RestartSec=5
LimitNPROC=infinity
LimitCORE=infinity
LimitNOFILE=infinity
TasksMax=infinity
OOMScoreAdjust=-999

[Install]
WantedBy=multi-user.target
EOF

# Enable and start containerd
systemctl daemon-reload
systemctl enable containerd
systemctl start containerd

# Verify installation
containerd --version

echo "✓ Prerequisites installed successfully"
```

### Kata Containers Installation

```bash
#!/bin/bash
# install-kata-containers.sh

set -euo pipefail

KATA_VERSION="3.2.0"
ARCH="amd64"

echo "Installing Kata Containers ${KATA_VERSION}..."

# Download Kata Containers
cd /tmp
curl -LO "https://github.com/kata-containers/kata-containers/releases/download/${KATA_VERSION}/kata-static-${KATA_VERSION}-${ARCH}.tar.xz"

# Extract to /opt/kata
mkdir -p /opt/kata
tar -xvf kata-static-${KATA_VERSION}-${ARCH}.tar.xz -C /opt/kata

# Create symlinks
ln -sf /opt/kata/bin/kata-runtime /usr/local/bin/kata-runtime
ln -sf /opt/kata/bin/kata-collect-data.sh /usr/local/bin/kata-collect-data.sh
ln -sf /opt/kata/bin/containerd-shim-kata-v2 /usr/local/bin/containerd-shim-kata-v2

# Create Kata configuration directory
mkdir -p /etc/kata-containers
mkdir -p /var/lib/kata-containers

# Copy default configuration
cp /opt/kata/share/defaults/kata-containers/configuration.toml /etc/kata-containers/

# Verify installation
kata-runtime --version
kata-runtime check

echo "✓ Kata Containers installed successfully"
```

### Containerd Configuration for Kata

```toml
# /etc/containerd/config.toml
version = 2

[plugins]
  [plugins."io.containerd.grpc.v1.cri"]
    [plugins."io.containerd.grpc.v1.cri".containerd]
      default_runtime_name = "runc"

      [plugins."io.containerd.grpc.v1.cri".containerd.runtimes]
        [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
          runtime_type = "io.containerd.runc.v2"
          [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
            SystemdCgroup = true

        # Kata Containers runtime
        [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata]
          runtime_type = "io.containerd.kata.v2"
          privileged_without_host_devices = true
          [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata.options]
            ConfigPath = "/etc/kata-containers/configuration.toml"

        # Kata with QEMU
        [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-qemu]
          runtime_type = "io.containerd.kata.v2"
          [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-qemu.options]
            ConfigPath = "/etc/kata-containers/configuration-qemu.toml"

        # Kata with Cloud Hypervisor
        [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-clh]
          runtime_type = "io.containerd.kata.v2"
          [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-clh.options]
            ConfigPath = "/etc/kata-containers/configuration-clh.toml"

        # Kata with Firecracker
        [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-fc]
          runtime_type = "io.containerd.kata.v2"
          [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-fc.options]
            ConfigPath = "/etc/kata-containers/configuration-fc.toml"

        # Kata with SEV support
        [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-qemu-sev]
          runtime_type = "io.containerd.kata.v2"
          [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-qemu-sev.options]
            ConfigPath = "/etc/kata-containers/configuration-qemu-sev.toml"

    [plugins."io.containerd.grpc.v1.cri".cni]
      bin_dir = "/opt/cni/bin"
      conf_dir = "/etc/cni/net.d"

  [plugins."io.containerd.runtime.v1.linux"]
    shim = "containerd-shim"
    runtime = "runc"

[metrics]
  address = "127.0.0.1:1338"
```

## Configuring Confidential Computing

### AMD SEV Configuration

```toml
# /etc/kata-containers/configuration-qemu-sev.toml
[hypervisor.qemu]
path = "/opt/kata/bin/qemu-system-x86_64"
kernel = "/opt/kata/share/kata-containers/vmlinuz.container"
image = "/opt/kata/share/kata-containers/kata-containers.img"
machine_type = "q35"

# SEV-specific configuration
machine_accelerators = "sev-guest,id=sev0,cbitpos=47,reduced-phys-bits=1"
confidential_guest = true

# Memory configuration for SEV
default_memory = 2048
memory_slots = 10
memory_offset = 0

# CPU configuration
default_vcpus = 2
default_maxvcpus = 4

# Enable memory prealloc and share for SEV
enable_mem_prealloc = true
mem_prealloc = true
file_mem_backend = "/dev/shm"
enable_hugepages = false

# Security features
enable_iommu = true
enable_iommu_platform = true

# SEV-specific kernel parameters
kernel_params = "console=hvc0 console=hvc1 agent.log=debug systemd.log_level=debug systemd.log_target=console no_timer_check"

# Firmware
firmware = "/opt/kata/share/kata-containers/OVMF_CODE.fd"
firmware_volume = "/opt/kata/share/kata-containers/OVMF_VARS.fd"

[agent.kata]
enable_tracing = true
kernel_modules = []

[runtime]
enable_pprof = false
internetworking_model = "tcfilter"
sandbox_cgroup_only = false
disable_new_netns = false
enable_pprof = false
```

### Intel SGX Configuration

```toml
# /etc/kata-containers/configuration-qemu-sgx.toml
[hypervisor.qemu]
path = "/opt/kata/bin/qemu-system-x86_64"
kernel = "/opt/kata/share/kata-containers/vmlinuz.container"
image = "/opt/kata/share/kata-containers/kata-containers.img"
machine_type = "q35"

# SGX-specific configuration
machine_accelerators = "sgx-epc,id=epc1,memdev=mem1"
confidential_guest = true

# Memory configuration for SGX
default_memory = 2048
memory_slots = 10

# CPU configuration - SGX requires specific CPU features
default_vcpus = 2
default_maxvcpus = 4
cpu_features = "sgx,sgx-exinfo,sgx-provision,sgx-tokenkey"

# Enable SGX device passthrough
enable_vhost_user_store = true
vhost_user_store_path = "/var/run/kata-containers/vhost-user"

# SGX EPC configuration
sgx_epc_size = 134217728  # 128MB in bytes

[factory]
enable_template = true

[agent.kata]
enable_tracing = true
kernel_modules = []

[runtime]
enable_pprof = false
internetworking_model = "tcfilter"
```

## Kubernetes Integration

### RuntimeClass Definitions

```yaml
# kata-runtimeclass.yaml
---
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: kata-qemu
handler: kata-qemu
overhead:
  podFixed:
    memory: "160Mi"
    cpu: "250m"
scheduling:
  nodeSelector:
    katacontainers.io/kata-runtime: "true"
---
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: kata-qemu-sev
handler: kata-qemu-sev
overhead:
  podFixed:
    memory: "256Mi"
    cpu: "350m"
scheduling:
  nodeSelector:
    katacontainers.io/kata-runtime: "true"
    feature.node.kubernetes.io/cpu-security.sev: "true"
---
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: kata-qemu-sgx
handler: kata-qemu-sgx
overhead:
  podFixed:
    memory: "256Mi"
    cpu: "350m"
scheduling:
  nodeSelector:
    katacontainers.io/kata-runtime: "true"
    feature.node.kubernetes.io/cpu-security.sgx: "true"
---
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: kata-fc
handler: kata-fc
overhead:
  podFixed:
    memory: "130Mi"
    cpu: "200m"
scheduling:
  nodeSelector:
    katacontainers.io/kata-runtime: "true"
---
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: kata-clh
handler: kata-clh
overhead:
  podFixed:
    memory: "130Mi"
    cpu: "200m"
scheduling:
  nodeSelector:
    katacontainers.io/kata-runtime: "true"
```

### Node Labeling

```bash
#!/bin/bash
# label-kata-nodes.sh

set -euo pipefail

echo "Labeling nodes for Kata Containers..."

# Label nodes with Kata support
for node in $(kubectl get nodes -o name); do
    echo "Checking $node..."

    # Check if Kata runtime is available
    if kubectl debug $node --image=busybox -it -- \
        test -f /usr/local/bin/kata-runtime 2>/dev/null; then

        kubectl label $node katacontainers.io/kata-runtime=true --overwrite
        echo "✓ Labeled $node for Kata runtime"

        # Check for SEV support
        if kubectl debug $node --image=busybox -it -- \
            test -f /dev/sev 2>/dev/null; then
            kubectl label $node feature.node.kubernetes.io/cpu-security.sev=true --overwrite
            echo "✓ Labeled $node for SEV support"
        fi

        # Check for SGX support
        if kubectl debug $node --image=busybox -it -- \
            test -f /dev/sgx_enclave 2>/dev/null; then
            kubectl label $node feature.node.kubernetes.io/cpu-security.sgx=true --overwrite
            echo "✓ Labeled $node for SGX support"
        fi
    fi
done

echo "✓ Node labeling complete"
```

## Deploying Confidential Workloads

### Basic Kata Container Deployment

```yaml
# kata-workload-basic.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: confidential-apps
  labels:
    security: confidential
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: confidential-app
  namespace: confidential-apps
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: secure-nginx
  namespace: confidential-apps
  labels:
    app: secure-nginx
spec:
  replicas: 3
  selector:
    matchLabels:
      app: secure-nginx
  template:
    metadata:
      labels:
        app: secure-nginx
        security: confidential
    spec:
      runtimeClassName: kata-qemu
      serviceAccountName: confidential-app
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
      - name: nginx
        image: nginx:1.25-alpine
        ports:
        - containerPort: 8080
          name: http
        resources:
          requests:
            memory: "128Mi"
            cpu: "100m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop:
            - ALL
          readOnlyRootFilesystem: true
        volumeMounts:
        - name: cache
          mountPath: /var/cache/nginx
        - name: run
          mountPath: /var/run
      volumes:
      - name: cache
        emptyDir: {}
      - name: run
        emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: secure-nginx
  namespace: confidential-apps
spec:
  selector:
    app: secure-nginx
  ports:
  - port: 80
    targetPort: http
  type: ClusterIP
```

### SEV-Encrypted Workload

```yaml
# kata-sev-workload.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: sev-app-config
  namespace: confidential-apps
data:
  app.conf: |
    # Confidential application configuration
    encryption: hardware
    attestation: enabled
    memory_encryption: sev
---
apiVersion: v1
kind: Secret
metadata:
  name: sev-app-secrets
  namespace: confidential-apps
type: Opaque
stringData:
  api-key: "super-secret-key"
  db-password: "encrypted-password"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sev-protected-app
  namespace: confidential-apps
  labels:
    app: sev-protected-app
    security: sev-encrypted
spec:
  replicas: 2
  selector:
    matchLabels:
      app: sev-protected-app
  template:
    metadata:
      labels:
        app: sev-protected-app
        security: sev-encrypted
      annotations:
        io.katacontainers.config.hypervisor.machine_accelerators: "sev-guest,id=sev0,cbitpos=47,reduced-phys-bits=1"
    spec:
      runtimeClassName: kata-qemu-sev
      serviceAccountName: confidential-app

      # Require SEV-capable nodes
      nodeSelector:
        feature.node.kubernetes.io/cpu-security.sev: "true"

      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault

      initContainers:
      - name: verify-sev
        image: alpine:latest
        command:
        - /bin/sh
        - -c
        - |
          echo "Verifying SEV environment..."
          # Check for SEV indicators
          if [ -f /.dockerenv ]; then
            echo "Running in container with Kata isolation"
          fi
          echo "SEV verification complete"
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop:
            - ALL

      containers:
      - name: app
        image: my-confidential-app:latest
        ports:
        - containerPort: 8443
          name: https
        env:
        - name: ENCRYPTION_MODE
          value: "hardware"
        - name: ATTESTATION_ENABLED
          value: "true"
        - name: API_KEY
          valueFrom:
            secretKeyRef:
              name: sev-app-secrets
              key: api-key
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "2Gi"
            cpu: "2000m"
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop:
            - ALL
          readOnlyRootFilesystem: true
        volumeMounts:
        - name: config
          mountPath: /etc/app
          readOnly: true
        - name: data
          mountPath: /var/lib/app
        - name: tmp
          mountPath: /tmp
        livenessProbe:
          httpGet:
            path: /healthz
            port: https
            scheme: HTTPS
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: https
            scheme: HTTPS
          initialDelaySeconds: 5
          periodSeconds: 5

      volumes:
      - name: config
        configMap:
          name: sev-app-config
      - name: data
        emptyDir:
          sizeLimit: 1Gi
      - name: tmp
        emptyDir:
          sizeLimit: 500Mi

      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchExpressions:
                - key: app
                  operator: In
                  values:
                  - sev-protected-app
              topologyKey: kubernetes.io/hostname
---
apiVersion: v1
kind: Service
metadata:
  name: sev-protected-app
  namespace: confidential-apps
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-backend-protocol: "https"
spec:
  selector:
    app: sev-protected-app
  ports:
  - port: 443
    targetPort: https
    protocol: TCP
  type: LoadBalancer
```

### SGX Enclave Application

```yaml
# kata-sgx-workload.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: sgx-app-config
  namespace: confidential-apps
data:
  enclave.conf: |
    # SGX Enclave configuration
    enclave_size: 134217728  # 128MB
    thread_num: 4
    heap_size: 67108864      # 64MB
    stack_size: 1048576      # 1MB
    tcs_num: 10
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sgx-enclave-app
  namespace: confidential-apps
  labels:
    app: sgx-enclave-app
    security: sgx-protected
spec:
  replicas: 2
  selector:
    matchLabels:
      app: sgx-enclave-app
  template:
    metadata:
      labels:
        app: sgx-enclave-app
        security: sgx-protected
    spec:
      runtimeClassName: kata-qemu-sgx
      serviceAccountName: confidential-app

      nodeSelector:
        feature.node.kubernetes.io/cpu-security.sgx: "true"

      containers:
      - name: sgx-app
        image: my-sgx-app:latest
        resources:
          requests:
            memory: "256Mi"
            cpu: "500m"
            sgx.intel.com/epc: "128Mi"
          limits:
            memory: "1Gi"
            cpu: "2000m"
            sgx.intel.com/epc: "128Mi"
        env:
        - name: SGX_MODE
          value: "HW"
        - name: SGX_ENCLAVE_SIZE
          value: "134217728"
        volumeMounts:
        - name: sgx-config
          mountPath: /etc/sgx
        - name: sgx-devices
          mountPath: /dev/sgx

      volumes:
      - name: sgx-config
        configMap:
          name: sgx-app-config
      - name: sgx-devices
        hostPath:
          path: /dev/sgx
          type: Directory
```

## Attestation and Verification

### Remote Attestation Service

```go
// attestation-service.go
package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"
)

type AttestationRequest struct {
	Nonce       string `json:"nonce"`
	Quote       string `json:"quote"`
	Measurement string `json:"measurement"`
	TEEType     string `json:"tee_type"` // "SGX" or "SEV"
}

type AttestationResponse struct {
	Verified  bool      `json:"verified"`
	Timestamp time.Time `json:"timestamp"`
	Token     string    `json:"token,omitempty"`
	Error     string    `json:"error,omitempty"`
}

type AttestationService struct {
	privateKey *rsa.PrivateKey
	publicKey  *rsa.PublicKey
}

func NewAttestationService() (*AttestationService, error) {
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, err
	}

	return &AttestationService{
		privateKey: privateKey,
		publicKey:  &privateKey.PublicKey,
	}, nil
}

func (as *AttestationService) VerifySGXQuote(quote []byte, nonce string) (bool, error) {
	// Implement SGX quote verification
	// This would use Intel Attestation Service (IAS) or DCAP
	log.Printf("Verifying SGX quote with nonce: %s", nonce)

	// Placeholder implementation
	// In production, verify:
	// 1. Quote signature
	// 2. Certificate chain
	// 3. Measurement values
	// 4. Nonce matches

	return true, nil
}

func (as *AttestationService) VerifySEVAttestation(attestation []byte, nonce string) (bool, error) {
	// Implement SEV attestation verification
	log.Printf("Verifying SEV attestation with nonce: %s", nonce)

	// Placeholder implementation
	// In production, verify:
	// 1. Launch measurement
	// 2. Platform certificate chain
	// 3. Firmware version
	// 4. Nonce matches

	return true, nil
}

func (as *AttestationService) generateAttestationToken(measurement string) (string, error) {
	token := map[string]interface{}{
		"measurement": measurement,
		"timestamp":   time.Now().Unix(),
		"valid_until": time.Now().Add(24 * time.Hour).Unix(),
	}

	tokenJSON, err := json.Marshal(token)
	if err != nil {
		return "", err
	}

	return base64.StdEncoding.EncodeToString(tokenJSON), nil
}

func (as *AttestationService) handleAttestation(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req AttestationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request", http.StatusBadRequest)
		return
	}

	resp := AttestationResponse{
		Timestamp: time.Now(),
	}

	// Decode quote/attestation
	quoteBytes, err := base64.StdEncoding.DecodeString(req.Quote)
	if err != nil {
		resp.Error = "Invalid quote encoding"
		json.NewEncoder(w).Encode(resp)
		return
	}

	// Verify based on TEE type
	var verified bool
	switch req.TEEType {
	case "SGX":
		verified, err = as.VerifySGXQuote(quoteBytes, req.Nonce)
	case "SEV":
		verified, err = as.VerifySEVAttestation(quoteBytes, req.Nonce)
	default:
		resp.Error = "Unsupported TEE type"
		json.NewEncoder(w).Encode(resp)
		return
	}

	if err != nil {
		resp.Error = fmt.Sprintf("Verification failed: %v", err)
		json.NewEncoder(w).Encode(resp)
		return
	}

	resp.Verified = verified
	if verified {
		token, err := as.generateAttestationToken(req.Measurement)
		if err != nil {
			resp.Error = "Failed to generate token"
		} else {
			resp.Token = token
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func main() {
	service, err := NewAttestationService()
	if err != nil {
		log.Fatal(err)
	}

	http.HandleFunc("/attest", service.handleAttestation)
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	})

	log.Println("Attestation service starting on :8443...")
	log.Fatal(http.ListenAndServeTLS(":8443", "server.crt", "server.key", nil))
}
```

## Monitoring and Observability

### Kata Containers Metrics

```yaml
# kata-metrics-exporter.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: kata-metrics-exporter
  namespace: kube-system
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: kata-metrics-exporter
  namespace: kube-system
  labels:
    app: kata-metrics-exporter
spec:
  selector:
    matchLabels:
      app: kata-metrics-exporter
  template:
    metadata:
      labels:
        app: kata-metrics-exporter
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"
    spec:
      serviceAccountName: kata-metrics-exporter
      hostNetwork: true
      hostPID: true
      tolerations:
      - key: node-role.kubernetes.io/master
        effect: NoSchedule
      - key: node-role.kubernetes.io/control-plane
        effect: NoSchedule
      containers:
      - name: exporter
        image: kata-metrics-exporter:latest
        ports:
        - containerPort: 9090
          name: metrics
        resources:
          requests:
            memory: "64Mi"
            cpu: "50m"
          limits:
            memory: "128Mi"
            cpu: "200m"
        securityContext:
          privileged: true
        volumeMounts:
        - name: kata-runtime
          mountPath: /var/lib/kata-containers
          readOnly: true
      volumes:
      - name: kata-runtime
        hostPath:
          path: /var/lib/kata-containers
---
apiVersion: v1
kind: Service
metadata:
  name: kata-metrics-exporter
  namespace: kube-system
  labels:
    app: kata-metrics-exporter
spec:
  clusterIP: None
  selector:
    app: kata-metrics-exporter
  ports:
  - name: metrics
    port: 9090
    targetPort: metrics
```

## Performance Optimization

### Kata Configuration Tuning

```bash
#!/bin/bash
# tune-kata-performance.sh

set -euo pipefail

echo "Tuning Kata Containers performance..."

# Enable huge pages
echo "Enabling huge pages..."
echo 1024 > /sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages

# Configure kernel parameters
cat >> /etc/sysctl.conf <<EOF
# Kata Containers performance tuning
vm.nr_hugepages = 1024
vm.hugetlb_shm_group = 0
vm.max_map_count = 262144
kernel.sched_migration_cost_ns = 5000000
kernel.sched_autogroup_enabled = 0
EOF

sysctl -p

# CPU governor
echo "Setting CPU governor to performance..."
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
    echo performance > $cpu
done

# Disable swap
echo "Disabling swap..."
swapoff -a

echo "✓ Performance tuning complete"
```

## Conclusion

Confidential computing with Kata Containers provides enterprise-grade security for sensitive workloads in Kubernetes by combining hardware-based trusted execution environments with lightweight VM isolation. Key benefits include:

- **Hardware-enforced isolation** protecting data in use
- **Memory encryption** via AMD SEV or Intel SGX
- **Attestation capabilities** for workload verification
- **Minimal performance overhead** compared to traditional VMs
- **Kubernetes-native** deployment and management

Organizations handling regulated data, processing sensitive information, or requiring multi-tenant isolation can leverage confidential computing to meet compliance requirements while maintaining cloud-native operational practices. As hardware support for TEEs becomes ubiquitous and tooling matures, confidential computing will become a standard security control for enterprise Kubernetes deployments.