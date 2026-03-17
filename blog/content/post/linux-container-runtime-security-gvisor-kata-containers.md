---
title: "Linux Container Runtime Security: gVisor and Kata Containers Sandboxing"
date: 2031-04-02T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Security", "gVisor", "Kata Containers", "Container Runtime", "Sandboxing"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to container runtime sandboxing with gVisor and Kata Containers. Covers architecture, syscall interception, RuntimeClass configuration, performance trade-offs, and multi-runtime Kubernetes cluster setup."
more_link: "yes"
url: "/linux-container-runtime-security-gvisor-kata-containers/"
---

The Linux kernel is the single largest attack surface shared by all containers on a host. Traditional container isolation uses namespaces and cgroups for resource separation but provides no protection against a container exploiting kernel vulnerabilities. gVisor and Kata Containers address this fundamental limitation through distinct architectures: gVisor interposes a user-space kernel, while Kata Containers runs each pod in a lightweight virtual machine. This guide examines both approaches in production-grade depth.

<!--more-->

# Linux Container Runtime Security: gVisor and Kata Containers Sandboxing

## The Container Security Gap

Standard containers share the host kernel. When a process inside a container calls `open()`, `read()`, or `socket()`, those system calls reach the host kernel directly. A kernel vulnerability—an exploit in the BPF subsystem, a net stack bug, a privilege escalation in a filesystem driver—allows a compromised container to escape isolation entirely.

The container escape threat model is not theoretical. Runc CVE-2019-5736 allowed a malicious container to overwrite the host's runc binary. Dirty Cow (CVE-2016-5195) allowed container escape on unpatched kernels. Namespace-based isolation was never designed as a security boundary.

Sandboxed runtimes intercept this kernel interface, providing an isolation layer between container processes and the host kernel.

## Section 1: gVisor Architecture and Syscall Interception

### How gVisor Works

gVisor implements a user-space kernel called the Sentry. When a containerized process issues a system call, ptrace or KVM interception redirects it to the Sentry rather than the host kernel. The Sentry implements the Linux syscall ABI in Go, performing the requested operation (file I/O, network, etc.) through a narrow set of host syscalls called from the Gofer process.

```
Container Process
       |
   System call (e.g., read())
       |
   [gVisor Sentry - user-space kernel]
       |
   [Gofer - file system proxy]
       |
   Host kernel (minimal surface)
```

The Sentry uses one of two platforms:
- **ptrace**: Uses Linux ptrace to intercept syscalls. Higher overhead (~50-100% performance penalty on syscall-heavy workloads), no hardware virtualization required.
- **KVM**: Uses `/dev/kvm` to run the Sentry in a KVM guest. Lower overhead (~10-30% penalty), requires KVM support.

### Installing gVisor (runsc)

```bash
# Install on Ubuntu 22.04 / Debian-based
sudo apt-get update
sudo apt-get install -y apt-transport-https ca-certificates curl gnupg

# Add gVisor package repository
curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] \
  https://storage.googleapis.com/gvisor/releases release main" | \
  sudo tee /etc/apt/sources.list.d/gvisor.list

sudo apt-get update
sudo apt-get install -y runsc

# Verify installation
runsc --version
```

### Configuring containerd for gVisor

```toml
# /etc/containerd/config.toml (additions for gVisor)
version = 2

[plugins."io.containerd.grpc.v1.cri".containerd]
  default_runtime_name = "runc"

  [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
    runtime_type = "io.containerd.runc.v2"

  # gVisor with ptrace backend
  [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc]
    runtime_type = "io.containerd.runsc.v1"
    [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc.options]
      TypeUrl = "io.containerd.runsc.v1.options"
      ConfigPath = "/etc/containerd/runsc.toml"

  # gVisor with KVM backend (requires /dev/kvm on node)
  [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc-kvm]
    runtime_type = "io.containerd.runsc.v1"
    [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc-kvm.options]
      TypeUrl = "io.containerd.runsc.v1.options"
      ConfigPath = "/etc/containerd/runsc-kvm.toml"
```

```toml
# /etc/containerd/runsc.toml
[runsc_config]
  platform = "ptrace"
  network = "sandbox"
  file-access = "exclusive"
  overlay = true
  watchdog-action = "LogWarning"
  strace = false
```

```toml
# /etc/containerd/runsc-kvm.toml
[runsc_config]
  platform = "kvm"
  network = "sandbox"
  file-access = "exclusive"
  overlay = true
  watchdog-action = "LogWarning"
```

```bash
# Restart containerd to apply changes
sudo systemctl restart containerd

# Verify runtimes are registered
sudo ctr run --rm --runtime io.containerd.runsc.v1 docker.io/library/alpine:latest test-runsc \
  uname -a
# Output will show Linux kernel version from Sentry, not host kernel
```

### Testing gVisor Isolation

```bash
# Compare kernel version: host vs gVisor container
uname -r
# 6.1.0-21-amd64 (or similar host kernel)

# gVisor container reports Sentry's kernel version
sudo ctr run --rm --runtime io.containerd.runsc.v1 \
  docker.io/library/ubuntu:22.04 gvisor-test uname -r
# 4.4.0 (gVisor reports this regardless of host)

# Verify syscall interception - this shows gVisor is intercepting
sudo ctr run --rm --runtime io.containerd.runsc.v1 \
  docker.io/library/ubuntu:22.04 gvisor-syscall-test \
  cat /proc/self/maps | head -5
```

## Section 2: Kata Containers Architecture

### How Kata Containers Works

Kata Containers runs each container inside a lightweight virtual machine using QEMU, Cloud Hypervisor, or Firecracker. A thin agent inside the VM (kata-agent, written in Rust) manages container lifecycle via a gRPC API, while the runtime shim (containerd-shim-kata-v2) on the host orchestrates the VM.

```
Container Process
       |
   [kata-agent (inside VM)]
       |
   [Guest Linux kernel]
       |
   [KVM/QEMU hypervisor]
       |
   [Host kernel (only VM hypercalls)]
```

This is stronger isolation than gVisor because each pod gets an entirely separate kernel instance. The attack surface is reduced to the hypervisor and the host kernel's KVM interface.

### Installing Kata Containers

```bash
# Install Kata Containers runtime
# Using the official Kata Containers install script
bash -c "$(curl -fsSL https://raw.githubusercontent.com/kata-containers/kata-containers/main/utils/kata-manager.sh)" \
  kata-manager.sh install-packages

# Or manual installation
KATA_VERSION="3.3.0"
ARCH=$(uname -m)
curl -fsSL \
  "https://github.com/kata-containers/kata-containers/releases/download/${KATA_VERSION}/kata-static-${KATA_VERSION}-${ARCH}.tar.xz" \
  -o kata-static.tar.xz
sudo tar -xJf kata-static.tar.xz -C /opt/kata
sudo ln -sf /opt/kata/bin/containerd-shim-kata-v2 \
  /usr/local/bin/containerd-shim-kata-v2

# Verify
kata-runtime check
# This checks for hardware virtualization support
```

### Configuring containerd for Kata

```toml
# /etc/containerd/config.toml (additions for Kata)
  # Kata with QEMU (default - stable)
  [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-qemu]
    runtime_type = "io.containerd.kata.v2"
    privileged_without_host_devices = true
    [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-qemu.options]
      ConfigPath = "/opt/kata/share/defaults/kata-containers/configuration-qemu.toml"

  # Kata with Cloud Hypervisor (better performance)
  [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-clh]
    runtime_type = "io.containerd.kata.v2"
    [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-clh.options]
      ConfigPath = "/opt/kata/share/defaults/kata-containers/configuration-clh.toml"

  # Kata with Firecracker (microVM, minimal footprint)
  [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-fc]
    runtime_type = "io.containerd.kata.v2"
    [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-fc.options]
      ConfigPath = "/opt/kata/share/defaults/kata-containers/configuration-fc.toml"
```

### Kata Configuration Tuning

```toml
# /opt/kata/share/defaults/kata-containers/configuration-qemu.toml (key settings)

[hypervisor.qemu]
  path = "/opt/kata/bin/qemu-system-x86_64"
  kernel = "/opt/kata/share/kata-containers/vmlinux.container"
  image = "/opt/kata/share/kata-containers/kata-containers.img"
  machine_type = "q35"
  default_vcpus = 1
  default_maxvcpus = 8
  default_memory = 2048
  default_maxmemory = 0
  # Enable memory hotplug for dynamic scaling
  enable_mem_hotplug = true
  # Use virtio-fs for container filesystem (better performance than 9p)
  shared_fs = "virtio-fs"
  virtio_fs_daemon = "/opt/kata/libexec/kata-qemu/virtiofsd"
  virtio_fs_cache = "auto"
  # Disable unnecessary devices
  disable_block_device_use = false
  enable_iothreads = true

[agent.kata]
  # Enable tracing for debugging
  enable_tracing = false
  # Kernel modules to load in guest
  kernel_modules = []
```

## Section 3: Kubernetes RuntimeClass Configuration

### Creating RuntimeClass Objects

```yaml
# runtimeclasses.yaml
# gVisor with ptrace
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: gvisor
handler: runsc
overhead:
  podFixed:
    memory: "50Mi"
    cpu: "50m"
scheduling:
  nodeSelector:
    runtime.gvisor/enabled: "true"
  tolerations:
    - key: runtime
      operator: Equal
      value: gvisor
      effect: NoSchedule
---
# gVisor with KVM
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: gvisor-kvm
handler: runsc-kvm
overhead:
  podFixed:
    memory: "50Mi"
    cpu: "50m"
scheduling:
  nodeSelector:
    runtime.gvisor.kvm/enabled: "true"
---
# Kata with QEMU
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: kata-qemu
handler: kata-qemu
overhead:
  podFixed:
    # VM overhead: guest kernel + agent + QEMU process
    memory: "350Mi"
    cpu: "250m"
scheduling:
  nodeSelector:
    runtime.kata/enabled: "true"
  tolerations:
    - key: runtime
      operator: Equal
      value: kata
      effect: NoSchedule
---
# Kata with Firecracker
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: kata-firecracker
handler: kata-fc
overhead:
  podFixed:
    memory: "150Mi"
    cpu: "100m"
scheduling:
  nodeSelector:
    runtime.kata/enabled: "true"
```

### Labeling Nodes for Runtime Scheduling

```bash
# Label nodes that support gVisor
kubectl label nodes worker-01 worker-02 runtime.gvisor/enabled=true

# Label nodes that support gVisor KVM
kubectl label nodes worker-01 worker-02 runtime.gvisor.kvm/enabled=true

# Label nodes that support Kata (require hardware virtualization)
kubectl label nodes worker-03 worker-04 runtime.kata/enabled=true

# Taint Kata nodes to avoid scheduling standard workloads there
# (optional - only if you want to dedicate nodes)
kubectl taint nodes worker-03 worker-04 runtime=kata:NoSchedule

kubectl apply -f runtimeclasses.yaml
```

### Using RuntimeClass in Pods

```yaml
# gvisor-pod.yaml
apiVersion: v1
kind: Pod
metadata:
  name: untrusted-workload
  labels:
    app: untrusted-workload
spec:
  runtimeClassName: gvisor
  containers:
    - name: app
      image: nginx:1.25-alpine
      resources:
        requests:
          memory: 128Mi
          cpu: 100m
        limits:
          memory: 256Mi
          cpu: 500m
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        runAsNonRoot: true
        runAsUser: 1000
        capabilities:
          drop: ["ALL"]
```

```yaml
# kata-pod.yaml
apiVersion: v1
kind: Pod
metadata:
  name: sensitive-workload
  labels:
    app: sensitive-workload
spec:
  runtimeClassName: kata-qemu
  containers:
    - name: app
      image: python:3.12-slim
      command: ["python", "-m", "http.server", "8080"]
      resources:
        requests:
          # Account for RuntimeClass overhead separately from container resources
          memory: 256Mi
          cpu: 200m
        limits:
          memory: 512Mi
          cpu: 1000m
---
# Deployment with Kata runtime
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-processor
  namespace: finance
spec:
  replicas: 3
  selector:
    matchLabels:
      app: payment-processor
  template:
    metadata:
      labels:
        app: payment-processor
    spec:
      runtimeClassName: kata-qemu
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: processor
          image: ghcr.io/myorg/payment-processor:1.2.0
          resources:
            requests:
              memory: 512Mi
              cpu: 500m
            limits:
              memory: 1Gi
              cpu: 2000m
```

### Enforcing RuntimeClass with OPA Gatekeeper

```yaml
# Require untrusted namespaces to use sandboxed runtimes
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequireRuntimeClass
metadata:
  name: require-sandbox-runtime
spec:
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Pod"]
    namespaceSelector:
      matchLabels:
        security-tier: untrusted
  parameters:
    allowedRuntimeClasses:
      - gvisor
      - gvisor-kvm
      - kata-qemu
      - kata-firecracker
```

```yaml
# gatekeeper-constraint-template.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequireruntimeclass
spec:
  crd:
    spec:
      names:
        kind: K8sRequireRuntimeClass
      validation:
        openAPIV3Schema:
          type: object
          properties:
            allowedRuntimeClasses:
              type: array
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8srequireruntimeclass

        violation[{"msg": msg}] {
          input.review.kind.kind == "Pod"
          rc := input.review.object.spec.runtimeClassName
          allowed := {r | r := input.parameters.allowedRuntimeClasses[_]}
          not allowed[rc]
          msg := sprintf("Pod must use one of the allowed runtime classes: %v, got: %v",
            [input.parameters.allowedRuntimeClasses, rc])
        }

        violation[{"msg": msg}] {
          input.review.kind.kind == "Pod"
          not input.review.object.spec.runtimeClassName
          msg := "Pod must specify a runtimeClassName"
        }
```

## Section 4: Performance Overhead Trade-offs

### Benchmarking Setup

```bash
# Run benchmarks to quantify overhead per workload type
# Tool: phoronix-test-suite or custom benchmarks

# CPU-bound workload (gVisor adds minimal overhead)
docker run --rm --runtime=runc alpine sh -c "time for i in \$(seq 1 100000); do echo x; done > /dev/null"
docker run --rm --runtime=runsc alpine sh -c "time for i in \$(seq 1 100000); do echo x; done > /dev/null"

# Syscall-heavy workload (gVisor shows more overhead)
# strace benchmark
docker run --rm --runtime=runc alpine sh -c "time find /usr -name '*.so'"
docker run --rm --runtime=runsc alpine sh -c "time find /usr -name '*.so'"

# Network throughput
docker run --rm --runtime=runc alpine sh -c "dd if=/dev/zero bs=1M count=1000 | nc -l 9999 &"
# Compare with runsc
```

### Measured Overhead Guidelines

Based on published benchmarks and production experience:

**gVisor (ptrace backend):**
- CPU-bound workloads: 5-15% overhead
- Syscall-heavy workloads: 50-100% overhead
- Network-heavy workloads: 20-40% overhead (network stack in Sentry)
- File I/O: 30-60% overhead

**gVisor (KVM backend):**
- CPU-bound workloads: 3-8% overhead
- Syscall-heavy workloads: 20-40% overhead
- Network-heavy workloads: 10-20% overhead
- File I/O: 15-30% overhead

**Kata Containers (QEMU):**
- Pod startup time: +1-3 seconds (VM boot)
- CPU-bound workloads: 5-10% overhead
- Syscall-heavy workloads: 10-20% overhead (direct to guest kernel)
- Network-heavy workloads: 5-15% overhead (virtio-net)
- Memory baseline: +200-400MB per pod

**Kata Containers (Cloud Hypervisor):**
- Pod startup time: +0.5-1.5 seconds
- Memory baseline: +150-300MB per pod
- CPU/network/IO similar to QEMU but 20-30% faster startup

### Resource Overhead Accounting in Kubernetes

The RuntimeClass `overhead` field ensures Kubernetes accounts for sandbox overhead in scheduling:

```yaml
# The pod's resource requests are what the container needs
# The overhead is added on top for scheduling calculations

# With kata-qemu overhead (350Mi memory, 250m CPU):
# Container requests: 256Mi memory, 200m CPU
# Total scheduled: 256Mi + 350Mi = 606Mi memory, 200m + 250m = 450m CPU
```

```bash
# Verify overhead is accounted for
kubectl describe pod payment-processor-xyz | grep -A5 "QoS\|Overhead"
```

## Section 5: Use Cases for Untrusted Workloads

### Multi-Tenant SaaS Platforms

When running user-submitted code (CI/CD runners, serverless functions, notebook execution):

```yaml
# user-code-runner.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: user-notebook-run-abc123
  namespace: user-workloads
spec:
  template:
    spec:
      runtimeClassName: kata-qemu
      serviceAccountName: restricted-user-runner
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        fsGroup: 65534
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: runner
          image: jupyter/base-notebook:lab-4.0.7
          command: ["jupyter", "nbconvert", "--to", "notebook",
                    "--execute", "/work/notebook.ipynb"]
          env:
            - name: HOME
              value: /tmp
          resources:
            requests:
              memory: 512Mi
              cpu: 500m
            limits:
              memory: 2Gi
              cpu: 2000m
              ephemeral-storage: 5Gi
          volumeMounts:
            - name: user-work
              mountPath: /work
              readOnly: false
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: false
            capabilities:
              drop: ["ALL"]
      volumes:
        - name: user-work
          emptyDir:
            sizeLimit: 5Gi
      restartPolicy: Never
  backoffLimit: 0
  activeDeadlineSeconds: 3600
```

### Compliance-Mandated Isolation

For workloads handling PCI-DSS, HIPAA, or financial data where regulatory requirements demand strong isolation boundaries:

```yaml
# hipaa-workload.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: hipaa-workloads
  labels:
    security-tier: untrusted
    compliance: hipaa
---
apiVersion: v1
kind: Pod
metadata:
  name: patient-data-processor
  namespace: hipaa-workloads
spec:
  runtimeClassName: kata-qemu
  # Prevent scheduled sharing with non-HIPAA workloads
  nodeSelector:
    compliance: hipaa-dedicated
  tolerations:
    - key: compliance
      operator: Equal
      value: hipaa
      effect: NoSchedule
  containers:
    - name: processor
      image: ghcr.io/myorg/patient-processor:2.1.0
      env:
        - name: DATABASE_DSN
          valueFrom:
            secretKeyRef:
              name: patient-db-credentials
              key: dsn
```

## Section 6: Multi-Runtime Cluster Setup

### Node Pool Architecture

```bash
# GKE example: creating node pools with different runtime support
gcloud container node-pools create standard-pool \
  --cluster my-cluster \
  --zone us-central1-a \
  --num-nodes 5 \
  --machine-type n2-standard-4 \
  --sandbox type=gvisor \
  --labels runtime=gvisor

gcloud container node-pools create kata-pool \
  --cluster my-cluster \
  --zone us-central1-a \
  --num-nodes 3 \
  --machine-type n2-standard-8 \
  --enable-nested-virtualization \
  --labels runtime=kata

# On-premises: use MachineConfig (OpenShift) or manual node configuration
```

### Admission Webhook for Automatic RuntimeClass Assignment

```go
// admission-webhook/main.go
package main

import (
    "encoding/json"
    "fmt"
    "log/slog"
    "net/http"
    "os"

    admissionv1 "k8s.io/api/admission/v1"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const (
    untrustedAnnotation = "security.myorg.com/untrusted"
    defaultSandboxClass = "gvisor"
)

func mutatePod(ar admissionv1.AdmissionReview) *admissionv1.AdmissionResponse {
    pod := &corev1.Pod{}
    if err := json.Unmarshal(ar.Request.Object.Raw, pod); err != nil {
        return &admissionv1.AdmissionResponse{
            Result: &metav1.Status{
                Message: fmt.Sprintf("failed to decode pod: %v", err),
            },
        }
    }

    // If pod already has a runtimeClassName, leave it alone
    if pod.Spec.RuntimeClassName != nil {
        return &admissionv1.AdmissionResponse{Allowed: true}
    }

    // Check if the namespace has the untrusted label
    // (In practice, look up the namespace object)
    nsLabels := ar.Request.UserInfo.Groups // simplified

    isUntrusted := false
    for _, label := range nsLabels {
        if label == "system:serviceaccounts:untrusted" {
            isUntrusted = true
            break
        }
    }

    if !isUntrusted {
        return &admissionv1.AdmissionResponse{Allowed: true}
    }

    // Inject runtimeClassName
    patch := []map[string]interface{}{
        {
            "op":    "add",
            "path":  "/spec/runtimeClassName",
            "value": defaultSandboxClass,
        },
    }
    patchBytes, _ := json.Marshal(patch)
    patchType := admissionv1.PatchTypeJSONPatch

    return &admissionv1.AdmissionResponse{
        Allowed:   true,
        Patch:     patchBytes,
        PatchType: &patchType,
    }
}

func handleMutate(w http.ResponseWriter, r *http.Request) {
    var body []byte
    if r.Body != nil {
        defer r.Body.Close()
        body = make([]byte, r.ContentLength)
        r.Body.Read(body)
    }

    var ar admissionv1.AdmissionReview
    if err := json.Unmarshal(body, &ar); err != nil {
        http.Error(w, fmt.Sprintf("decode error: %v", err), http.StatusBadRequest)
        return
    }

    resp := &admissionv1.AdmissionReview{
        TypeMeta: ar.TypeMeta,
        Response: mutatePod(ar),
    }
    resp.Response.UID = ar.Request.UID

    respBytes, _ := json.Marshal(resp)
    w.Header().Set("Content-Type", "application/json")
    w.Write(respBytes)
}

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
    slog.SetDefault(logger)

    mux := http.NewServeMux()
    mux.HandleFunc("/mutate", handleMutate)
    mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    })

    srv := &http.Server{
        Addr:    ":8443",
        Handler: mux,
    }

    slog.Info("Starting admission webhook", "addr", srv.Addr)
    if err := srv.ListenAndServeTLS("/tls/tls.crt", "/tls/tls.key"); err != nil {
        slog.Error("webhook server failed", "error", err)
        os.Exit(1)
    }
}
```

### Monitoring Sandbox Runtime Health

```yaml
# sandbox-runtime-monitor.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: sandbox-health-script
  namespace: monitoring
data:
  check.sh: |
    #!/bin/sh
    # Check gVisor health
    crictl runtimecheck 2>/dev/null
    if ! ctr run --rm --runtime io.containerd.runsc.v1 \
        docker.io/library/alpine:latest gvisor-health-check \
        echo "gvisor-ok" 2>/dev/null | grep -q "gvisor-ok"; then
      echo "CRITICAL: gVisor runtime is not functioning"
      exit 2
    fi
    echo "OK: gVisor runtime is healthy"
    exit 0
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: sandbox-health-monitor
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: sandbox-health-monitor
  template:
    metadata:
      labels:
        app: sandbox-health-monitor
    spec:
      nodeSelector:
        runtime.gvisor/enabled: "true"
      containers:
        - name: monitor
          image: alpine:3.19
          command:
            - sh
            - -c
            - |
              while true; do
                /scripts/check.sh || true
                sleep 60
              done
          volumeMounts:
            - name: scripts
              mountPath: /scripts
            - name: containerd-sock
              mountPath: /run/containerd/containerd.sock
          securityContext:
            privileged: true
      volumes:
        - name: scripts
          configMap:
            name: sandbox-health-script
            defaultMode: 0755
        - name: containerd-sock
          hostPath:
            path: /run/containerd/containerd.sock
            type: Socket
      tolerations:
        - operator: Exists
```

## Section 7: Debugging and Troubleshooting

### gVisor Debug Logging

```bash
# Enable strace-level debugging in gVisor
cat > /etc/containerd/runsc-debug.toml <<'EOF'
[runsc_config]
  platform = "ptrace"
  debug = true
  debug-log = /var/log/runsc/
  strace = true
  log-packets = true
EOF

# Check gVisor logs
ls /var/log/runsc/
# boot.log  gofer.log  sandbox.log

tail -f /var/log/runsc/sandbox.log

# Check for unsupported syscalls
grep "Unsupported" /var/log/runsc/sandbox.log
```

### Common gVisor Issues

```bash
# Issue: Application fails with "operation not supported"
# gVisor does not implement all syscalls
# Check which syscall is failing:
grep "ENOSYS\|not supported\|unimplemented" /var/log/runsc/sandbox.log

# Common unsupported: inotify watches on certain paths, iouring (io_uring)
# Workaround: check gVisor syscall compatibility at
# https://gvisor.dev/docs/user_guide/compatibility/linux/amd64/

# Issue: Performance degradation on file I/O
# Check if tmpfs overlay is working
runsc --root /run/containerd/runsc/k8s.io exec <sandbox-id> \
  -- cat /proc/mounts | grep overlay
```

### Kata Containers Debug

```bash
# Check Kata VM logs
journalctl -u containerd | grep kata

# Enable debug in Kata configuration
sudo sed -i 's/#enable_debug = true/enable_debug = true/' \
  /opt/kata/share/defaults/kata-containers/configuration-qemu.toml

# List running Kata VMs
sudo kata-runtime kata-env

# Connect to Kata guest shell (debugging only)
# Requires enable_debug = true
SANDBOX_ID=$(crictl pods --name <pod-name> -q)
kata-runtime exec "${SANDBOX_ID}"
```

## Conclusion

gVisor and Kata Containers solve the same problem—host kernel exposure—through fundamentally different approaches. gVisor trades some performance for a pure software solution that works on any Linux host, while Kata Containers provides near-native performance in exchange for hardware virtualization requirements and higher memory overhead. In practice, many enterprises deploy both: gVisor for syscall-light web services and CI runners where startup latency matters, and Kata Containers for high-security workloads where the VM boundary provides regulatory compliance assurance. The RuntimeClass API makes multi-runtime clusters operationally straightforward, and OPA Gatekeeper policies can enforce sandbox requirements automatically based on namespace labels.
