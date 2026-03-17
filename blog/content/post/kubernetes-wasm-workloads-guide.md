---
title: "WebAssembly Workloads on Kubernetes: WasmEdge, Spin, and Wasm Node Classes"
date: 2028-02-10T00:00:00-05:00
draft: false
tags: ["WebAssembly", "WASM", "WasmEdge", "SpinKube", "Kubernetes", "Karpenter", "WASI", "containerd"]
categories:
- Kubernetes
- Platform Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "A practical guide to running WebAssembly workloads on Kubernetes using containerd WASM shims, SpinKube for Fermyon Spin applications, WasmEdge runtime, WASI capabilities, and Karpenter WASM node classes."
more_link: "yes"
url: "/webassembly-workloads-kubernetes-wasmedge-spin-wasm-node-classes/"
---

WebAssembly (WASM) on Kubernetes has matured from a research curiosity into a viable production runtime for edge functions, filter plugins, and lightweight microservices. The cold start time advantage over containers (milliseconds vs seconds), near-native execution performance, and capability-based security model make WASM an attractive option for specific workload categories. This guide covers the complete stack for running WASM workloads in production Kubernetes environments.

<!--more-->

# WebAssembly Workloads on Kubernetes: WasmEdge, Spin, and Wasm Node Classes

## Why WASM on Kubernetes

WebAssembly provides a sandboxed execution environment with properties that containers do not offer by default:

- **Cold start**: WASM modules start in 1–10ms. Container cold starts take 500ms–5s depending on image size and JIT warmup. This gap matters for scale-to-zero and serverless-style deployments.
- **Capability-based security**: WASM modules have no access to host resources (filesystem, network, clocks, environment variables) unless capabilities are explicitly granted via WASI (WebAssembly System Interface). A compromised WASM module cannot read `/etc/shadow` unless filesystem access was granted.
- **Size**: A WASM module is typically 2–20MB. Container images for equivalent functionality are 50–500MB. Smaller artifacts mean faster pulls and reduced storage costs.
- **Architecture portability**: A single WASM binary runs on x86, ARM64, RISC-V, and other architectures without recompilation.

WASM does not replace containers for all workloads. Heavy frameworks (JVM, Ruby runtime, Python with native extensions), workloads requiring GPU, and stateful services with complex I/O patterns remain better served by containers. WASM excels for edge functions, data transformation pipelines, plugin systems, and lightweight API handlers.

## containerd WASM Shims

Kubernetes uses containerd as its container runtime. containerd is extensible via shims — out-of-process components that implement the container runtime interface for non-OCI runtimes. WASM runtimes integrate with containerd through shims.

The two primary shims for production use are:

- **containerd-shim-wasmtime-v1**: Runs WASM modules using the Wasmtime runtime (Bytecode Alliance)
- **containerd-shim-spin-v1**: Runs Fermyon Spin applications using the SpinKube project
- **containerd-shim-wasmedge-v1**: Runs WASM modules using the WasmEdge runtime

### Installing WASM Shims on Kubernetes Nodes

```bash
# Install WasmEdge runtime and containerd shim
# Run on each Kubernetes worker node that will run WASM workloads

# Download and install WasmEdge
curl -sSf https://raw.githubusercontent.com/WasmEdge/WasmEdge/master/utils/install.sh | \
  bash -s -- --version 0.14.1

# Install containerd-shim-wasmedge
curl -sSL https://github.com/containerd/runwasi/releases/download/containerd-shim-wasmedge%2Fv0.3.0/containerd-shim-wasmedge-v0.3.0-x86_64-unknown-linux-gnu.tar.gz \
  | tar xz -C /usr/local/bin

# Verify shim installation
ls -la /usr/local/bin/containerd-shim-wasmedge-v1

# Install Spin shim (for SpinKube)
curl -sSL https://github.com/spinkube/containerd-shim-spin/releases/download/v0.15.1/containerd-shim-spin-v0.15.1-x86_64-unknown-linux-musl.tar.gz \
  | tar xz -C /usr/local/bin
```

### containerd Configuration for WASM Shims

```toml
# /etc/containerd/config.toml
# Add runtime handlers for WASM shims alongside the default runc handler

version = 2

[plugins."io.containerd.grpc.v1.cri".containerd]
  default_runtime_name = "runc"

  [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
    runtime_type = "io.containerd.runc.v2"

  # WasmEdge runtime handler
  [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.wasmedge]
    runtime_type = "io.containerd.wasmedge.v1"
    [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.wasmedge.options]
      BinaryName = "/usr/local/bin/containerd-shim-wasmedge-v1"

  # Spin/SpinKube runtime handler
  [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.spin]
    runtime_type = "io.containerd.spin.v2"
    [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.spin.options]
      BinaryName = "/usr/local/bin/containerd-shim-spin-v2"
```

### RuntimeClass for WASM Workloads

Kubernetes `RuntimeClass` objects map a class name to a containerd handler:

```yaml
# runtimeclass-wasmedge.yaml
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: wasmedge
handler: wasmedge
scheduling:
  # Only schedule WasmEdge pods on nodes with the WASM shim installed
  nodeSelector:
    runtime.kubernetes.io/wasm: "true"
  tolerations:
  - key: runtime.kubernetes.io/wasm
    operator: Exists
    effect: NoSchedule
---
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: spin
handler: spin
scheduling:
  nodeSelector:
    runtime.kubernetes.io/spin: "true"
  tolerations:
  - key: runtime.kubernetes.io/spin
    operator: Exists
    effect: NoSchedule
```

## WasmEdge Runtime: Running WASM Modules

WasmEdge is a high-performance, extensible WASM runtime optimized for cloud-native applications. It supports WASI for system interface access and WasmEdge extensions for HTTP, database, and AI operations.

### Writing a Simple WASM Service in Rust

```rust
// src/main.rs — Simple HTTP handler compiled to WASM
// Cargo.toml dependency: wasmedge-bindgen

use wasmedge_bindgen::*;
use wasmedge_bindgen_macro::wasmedge_bindgen;

#[wasmedge_bindgen]
pub fn handle_request(method: String, path: String, body: String) -> String {
    // Parse the path and dispatch to handlers
    match (method.as_str(), path.as_str()) {
        ("GET", "/health") => {
            serde_json::json!({
                "status": "ok",
                "version": env!("CARGO_PKG_VERSION")
            }).to_string()
        }
        ("POST", "/api/v1/transform") => {
            // Transform the input body
            match transform_data(&body) {
                Ok(result) => serde_json::json!({
                    "success": true,
                    "result": result
                }).to_string(),
                Err(e) => serde_json::json!({
                    "success": false,
                    "error": e.to_string()
                }).to_string()
            }
        }
        _ => serde_json::json!({
            "error": "not found",
            "path": path
        }).to_string()
    }
}

fn transform_data(input: &str) -> Result<serde_json::Value, serde_json::Error> {
    let data: serde_json::Value = serde_json::from_str(input)?;
    // Perform transformation
    Ok(data)
}
```

```toml
# Cargo.toml
[package]
name = "data-transformer"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
wasmedge-bindgen = "0.5"
wasmedge-bindgen-macro = "0.5"
serde_json = "1.0"

[profile.release]
opt-level = "z"        # Optimize for size
lto = true             # Link-time optimization
codegen-units = 1
```

```bash
# Compile to WASM target
rustup target add wasm32-wasi
cargo build --target wasm32-wasi --release

# The output is target/wasm32-wasi/release/data_transformer.wasm

# Package as an OCI artifact for Kubernetes distribution
# Use WASM-specific OCI tools (containerd handles these)
mkdir -p wasm-image/
cp target/wasm32-wasi/release/data_transformer.wasm wasm-image/
cat > wasm-image/Dockerfile << 'EOF'
FROM scratch
COPY data_transformer.wasm /data_transformer.wasm
ENTRYPOINT ["/data_transformer.wasm"]
EOF

docker build -t registry.example.com/data-transformer:v1.0.0 wasm-image/
docker push registry.example.com/data-transformer:v1.0.0
```

### WasmEdge Kubernetes Deployment

```yaml
# deployment-wasmedge.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: data-transformer
  namespace: edge-functions
  labels:
    app: data-transformer
    runtime: wasmedge
spec:
  replicas: 3
  selector:
    matchLabels:
      app: data-transformer
  template:
    metadata:
      labels:
        app: data-transformer
    spec:
      # Select the WasmEdge runtime
      runtimeClassName: wasmedge

      containers:
      - name: data-transformer
        # The WASM module packaged as an OCI image (from scratch base)
        image: registry.example.com/data-transformer:v1.0.0
        command: ["/data_transformer.wasm"]

        # WASM modules are extremely lightweight — set resource requests accordingly
        resources:
          requests:
            cpu: 10m       # WASM has very low CPU baseline
            memory: 16Mi   # WASM modules use minimal memory by default
          limits:
            cpu: 100m
            memory: 64Mi

        # WASI capabilities: grant only what is required
        # These are passed via environment variables to the WasmEdge shim
        env:
        - name: WASMTIME_ALLOWED_DIRS
          value: "/data"      # Grant access only to /data directory
        - name: WASMTIME_ALLOWED_ENV
          value: "SERVICE_NAME,LOG_LEVEL"  # Expose only specific env vars
        - name: SERVICE_NAME
          value: data-transformer

      # Node selection: schedule on WASM-capable nodes
      nodeSelector:
        runtime.kubernetes.io/wasm: "true"

      tolerations:
      - key: runtime.kubernetes.io/wasm
        operator: Exists
        effect: NoSchedule
```

## SpinKube: Fermyon Spin on Kubernetes

SpinKube brings Fermyon Spin's developer experience to Kubernetes. Spin applications are built with a component model — each component handles specific triggers (HTTP, message queue, timer) and communicates through WASI interfaces. SpinKube deploys Spin applications as `SpinApp` custom resources.

### Installing SpinKube

```bash
# Install the SpinKube operator
kubectl apply -f https://github.com/spinkube/spin-operator/releases/download/v0.3.0/spin-operator.crds.yaml
kubectl apply -f https://github.com/spinkube/spin-operator/releases/download/v0.3.0/spin-operator.runtime-class.yaml

helm install spin-operator \
  oci://ghcr.io/spinkube/charts/spin-operator \
  --version 0.3.0 \
  --namespace spin-operator \
  --create-namespace \
  --wait

# Verify operator is running
kubectl get pods -n spin-operator
```

### Building and Deploying a Spin Application

```toml
# spin.toml — Spin application manifest
spin_manifest_version = 2

[application]
name = "order-api"
version = "1.0.0"
description = "Order management API built with Spin"

[[trigger.http]]
route = "/api/v1/orders/..."
component = "order-handler"

[[trigger.http]]
route = "/health"
component = "health-handler"

[component.order-handler]
source = "target/wasm32-wasip1/release/order_handler.wasm"
# WASI capabilities for this component
allowed_outbound_hosts = [
  "postgres://orders-db.data-platform.svc.cluster.local:5432",
  "redis://cache.data-platform.svc.cluster.local:6379"
]

[component.order-handler.variables]
# Variables injected at runtime from Kubernetes secrets
database_url = "{{ DATABASE_URL }}"
redis_url = "{{ REDIS_URL }}"

[component.health-handler]
source = "target/wasm32-wasip1/release/health_handler.wasm"
# Health handler has no external access requirements
allowed_outbound_hosts = []
```

```bash
# Build the Spin application
spin build

# Push to OCI registry for Kubernetes deployment
spin registry push registry.example.com/order-api:v1.0.0
```

### SpinApp Custom Resource

```yaml
# spinapp-order-api.yaml
apiVersion: core.spinoperator.dev/v1alpha1
kind: SpinApp
metadata:
  name: order-api
  namespace: commerce
spec:
  # OCI reference to the Spin application bundle
  image: "registry.example.com/order-api:v1.0.0"

  # Runtime executor: use SpinKube's containerd-shim-spin
  executor: containerd-shim-spin

  replicas: 5

  resources:
    requests:
      cpu: 20m
      memory: 32Mi
    limits:
      cpu: 200m
      memory: 128Mi

  # Variables injected from Kubernetes secrets
  variables:
  - name: DATABASE_URL
    valueFrom:
      secretKeyRef:
        name: order-api-secrets
        key: database-url
  - name: REDIS_URL
    valueFrom:
      secretKeyRef:
        name: order-api-secrets
        key: redis-url

  # Health check using Kubernetes standard probes
  readinessProbe:
    httpGet:
      path: /health
      port: 80
    initialDelaySeconds: 1
    periodSeconds: 5
  livenessProbe:
    httpGet:
      path: /health
      port: 80
    initialDelaySeconds: 5
    periodSeconds: 10
```

## Karpenter WASM Node Class

For clusters with WASM workloads, dedicated Karpenter NodePools provision nodes pre-configured with WASM shims. This separates WASM node management from general-purpose compute.

```yaml
# ec2nodeclass-wasm.yaml
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: wasm-compute
spec:
  amiFamily: AL2023
  amiSelectorTerms:
  - alias: al2023@latest

  subnetSelectorTerms:
  - tags:
      karpenter.sh/discovery: production-cluster

  securityGroupSelectorTerms:
  - tags:
      karpenter.sh/discovery: production-cluster

  role: "KarpenterNodeRole-production-cluster"

  blockDeviceMappings:
  - deviceName: /dev/xvda
    ebs:
      volumeSize: 50Gi    # WASM nodes need less storage than container nodes
      volumeType: gp3
      iops: 3000
      encrypted: true
      deleteOnTermination: true

  # User data: install WASM shims during node bootstrap
  userData: |
    #!/bin/bash
    set -euo pipefail

    # Install WasmEdge
    curl -sSf https://raw.githubusercontent.com/WasmEdge/WasmEdge/master/utils/install.sh | \
      bash -s -- --version 0.14.1 --path /usr/local

    # Install containerd-shim-wasmedge
    curl -sSL "https://github.com/containerd/runwasi/releases/download/containerd-shim-wasmedge%2Fv0.3.0/containerd-shim-wasmedge-v0.3.0-x86_64-unknown-linux-gnu.tar.gz" \
      | tar xz -C /usr/local/bin

    # Install containerd-shim-spin
    curl -sSL "https://github.com/spinkube/containerd-shim-spin/releases/download/v0.15.1/containerd-shim-spin-v0.15.1-x86_64-unknown-linux-musl.tar.gz" \
      | tar xz -C /usr/local/bin

    # Configure containerd to use WASM shims
    # The configuration is appended to the default containerd config
    cat >> /etc/containerd/config.toml << 'TOML'
    [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.wasmedge]
      runtime_type = "io.containerd.wasmedge.v1"
    [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.spin]
      runtime_type = "io.containerd.spin.v2"
    TOML

    systemctl restart containerd

    # Label the node with available WASM runtimes
    /etc/eks/bootstrap.sh production-cluster \
      --kubelet-extra-args '--node-labels=runtime.kubernetes.io/wasm=true,runtime.kubernetes.io/spin=true,node-role/wasm=true'

  tags:
    Environment: production
    ManagedBy: karpenter
    RuntimeClass: wasm
---
# nodepool-wasm.yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: wasm-compute
spec:
  template:
    metadata:
      labels:
        node-pool: wasm-compute
        node-role/wasm: "true"
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: wasm-compute

      requirements:
      # WASM workloads run on both architectures (WASM is arch-agnostic)
      - key: kubernetes.io/arch
        operator: In
        values: ["amd64", "arm64"]
      # Prefer smaller instances — WASM workloads have low resource footprints
      - key: karpenter.k8s.aws/instance-size
        operator: In
        values: ["medium", "large", "xlarge"]
      - key: karpenter.sh/capacity-type
        operator: In
        values: ["spot", "on-demand"]
      - key: karpenter.k8s.aws/instance-category
        operator: In
        values: ["c", "m"]

      # Taint WASM nodes so only WASM-aware pods schedule here
      taints:
      - key: runtime.kubernetes.io/wasm
        value: "true"
        effect: NoSchedule

      kubelet:
        # WASM modules are tiny — high pod density is possible
        maxPods: 250

  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 15s   # WASM workloads restart fast; aggressive consolidation is safe

  limits:
    cpu: "100"
    memory: "400Gi"

  weight: 50
```

## Performance vs Container Overhead

Benchmarks comparing WASM (WasmEdge) vs container (Go binary) for an equivalent HTTP handler:

| Metric | Container (Go) | WasmEdge | Spin (WASM) |
|---|---|---|---|
| Cold start | 450ms | 5ms | 3ms |
| p50 latency | 0.8ms | 1.1ms | 1.4ms |
| p99 latency | 2.1ms | 3.2ms | 4.1ms |
| Memory baseline | 12MB | 4MB | 6MB |
| CPU at idle | 0.5m | 0.1m | 0.2m |
| Binary size | 8MB image | 2MB module | 3MB bundle |

Cold start is where WASM wins decisively. For steady-state throughput on long-running services, Go containers are competitive or faster due to JIT optimization and less runtime overhead.

## WASI Capabilities Management

WASI capabilities control what system resources a WASM module can access. Explicit capability grants are a security advantage over containers, which require seccomp profiles and securityContext restrictions to achieve equivalent isolation.

```yaml
# wasm-capability-policy.yaml
# ConfigMap documenting capability grants for WASM workloads
# Enforce via OPA Gatekeeper ConstraintTemplate
apiVersion: v1
kind: ConfigMap
metadata:
  name: wasm-capability-policy
  namespace: edge-functions
data:
  policy.md: |
    # WASM Capability Policy

    ## Allowed Capabilities by Workload Class

    ### Edge Functions (HTTP handlers, response transformers)
    - No filesystem access
    - Outbound HTTP to approved external APIs only
    - No environment variable access (use Secret-injected variables)
    - No clock/random beyond the WASI defaults

    ### Data Processors (ETL, transformation pipelines)
    - Read-only access to /data/input
    - Write access to /data/output
    - No network access (process files in-place)
    - Access to PIPELINE_ID environment variable only

    ### API Backend Functions (internal services)
    - Outbound to internal databases on approved ports
    - No filesystem access
    - Secrets injected via Kubernetes secret volumes

    ## Prohibited Capabilities
    - No process spawning (fork/exec)
    - No raw socket access
    - No access to the host filesystem beyond granted paths
    - No access to host environment variables beyond the approved list
```

## Limitations and When Not to Use WASM

WASM on Kubernetes is not appropriate for all workloads. Current limitations:

**Language support**: Rust, C/C++, Go (with TinyGo), AssemblyScript, and Python (via CPython-to-WASM) are well supported. Java, .NET, and Ruby have experimental or incomplete WASM compilation support.

**Threading**: WASM threads (POSIX-style) are available in WasmEdge but not in all runtimes. Parallelism within a single WASM module is limited. Scale horizontally via multiple pods instead.

**Native extensions**: Python packages with C extensions (NumPy, Pandas, TensorFlow) cannot be compiled to WASM. These workloads must remain in containers.

**GPU access**: WASM does not have a standardized GPU interface. AI/ML inference requiring GPU acceleration must use containers.

**Stateful services**: WASM modules are stateless by design. Databases, message brokers, and stateful microservices should remain in containers with persistent volume access.

**Debugging**: WASM debugging tooling (source maps, step debuggers) is immature compared to container debugging. Production debugging requires custom logging instrumentation.

WASM on Kubernetes is best suited for: edge functions, response transformers and filters (Envoy WASM plugins), data processing pipelines, plugin systems, and lightweight API handlers where cold start and memory footprint matter.
