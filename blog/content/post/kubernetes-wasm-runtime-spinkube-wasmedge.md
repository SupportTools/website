---
title: "Kubernetes Wasm Runtime: SpinKube and WasmEdge on Kubernetes"
date: 2029-08-12T00:00:00-05:00
draft: false
tags: ["Kubernetes", "WebAssembly", "Wasm", "SpinKube", "WasmEdge", "containerd", "Security"]
categories: ["Kubernetes", "WebAssembly"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to running WebAssembly workloads on Kubernetes: wasmtime and WasmEdge runtimes, containerd-wasm-shims, SpinKube operator, the Wasm vs container security model, and the component model."
more_link: "yes"
url: "/kubernetes-wasm-runtime-spinkube-wasmedge/"
---

WebAssembly (Wasm) on the server side is no longer experimental. Production deployments are running Wasm modules on Kubernetes nodes today — not to replace containers, but to complement them for specific workloads where near-instant startup, sub-millisecond cold starts, and hardware-level sandboxing matter. This post covers the entire stack: containerd-wasm-shims, WasmEdge and wasmtime runtimes, the SpinKube operator, the security model, and the emerging component model.

<!--more-->

# Kubernetes Wasm Runtime: SpinKube and WasmEdge on Kubernetes

## Section 1: Why Wasm on Kubernetes?

Container startup time is measured in milliseconds to seconds. Wasm module startup is measured in microseconds. This matters for:

- **Serverless/FaaS workloads** — cold starts that feel warm
- **Edge computing** — tiny footprint (Wasm modules are often less than 1MB vs containers over 100MB)
- **Security-sensitive workloads** — Wasm capability-based security is stricter than containers
- **Multi-tenant platforms** — run untrusted code safely without VM overhead

### Wasm vs Container Security Model

| Property | Container (Linux Namespaces) | Wasm (Sandbox) |
|---|---|---|
| Isolation mechanism | Linux kernel namespaces + cgroups | Wasm virtual machine |
| System call access | Filtered via seccomp | No direct syscalls — only WASI imports |
| Memory access | Namespace-isolated | Strict linear memory bounds |
| File system access | Bind mounts | Declared WASI pre-opened directories only |
| Network access | veth pairs + iptables | Explicit import (wasi:sockets) |
| Startup time | 100ms - 2s | 1-100 microseconds |
| Runtime footprint | ~100MB base layer | ~1MB module |

Wasm cannot make a syscall that was not declared as an import. A module compiled from Go or Rust cannot read `/etc/passwd`, open a raw socket, or call `mmap` unless the host runtime explicitly provides those capabilities. This is stronger than seccomp: instead of filtering a large syscall table, you start with nothing and add capabilities explicitly.

## Section 2: Wasm Runtimes

### wasmtime

wasmtime is a W3C-compliant Wasm runtime from the Bytecode Alliance. It implements WASI and the component model.

```bash
# Install wasmtime
curl https://wasmtime.dev/install.sh -sSf | bash
wasmtime --version

# Run a Wasm module
wasmtime module.wasm

# Run with WASI capabilities
wasmtime \
    --dir /tmp/data::/ \
    --env HOME=/home \
    --env APP_PORT=8080 \
    server.wasm

# Ahead-of-time compilation for faster startup
wasmtime compile -o server.cwasm server.wasm
wasmtime run server.cwasm
```

### WasmEdge

WasmEdge is a high-performance runtime with cloud-native extensions: HTTP server, TLS, database connections, and AI inference.

```bash
# Install WasmEdge
curl -sSf https://raw.githubusercontent.com/WasmEdge/WasmEdge/master/utils/install.sh | bash
source "$HOME/.wasmedge/env"
wasmedge --version

# Run a WASI module
wasmedge module.wasm

# Run with WasmEdge networking
wasmedge --net-address 0.0.0.0:8080 server.wasm

# Run with restricted directory access
wasmedge \
    --dir /data::/tmp/sandbox \
    app.wasm
```

## Section 3: containerd-wasm-shims

The bridge between Kubernetes/containerd and Wasm runtimes is the containerd-wasm-shims project. It implements the containerd shim API (shimv2) and dispatches to wasmtime, WasmEdge, or spin.

### Architecture

```
kubelet
  └── CRI request: RunPodSandbox, CreateContainer
      └── containerd
          └── RuntimeClass selector → containerd-shim-wasmtime-v1
              └── containerd-shim-wasmtime-v1
                  └── wasmtime module.wasm
```

The `RuntimeClass` Kubernetes object maps a class name to a specific containerd shim binary.

### Installing containerd-wasm-shims

```bash
# On each Kubernetes node
SHIM_VERSION=v0.14.0

# Download shims
curl -LO "https://github.com/containerd/containerd-wasm-shims/releases/download/${SHIM_VERSION}/containerd-shim-wasmtime-v1-linux-amd64.tar.gz"
curl -LO "https://github.com/containerd/containerd-wasm-shims/releases/download/${SHIM_VERSION}/containerd-shim-wasmedge-v1-linux-amd64.tar.gz"
curl -LO "https://github.com/containerd/containerd-wasm-shims/releases/download/${SHIM_VERSION}/containerd-shim-spin-v2-linux-amd64.tar.gz"

# Install shims
tar xzf containerd-shim-wasmtime-v1-linux-amd64.tar.gz -C /usr/local/bin
tar xzf containerd-shim-wasmedge-v1-linux-amd64.tar.gz -C /usr/local/bin
tar xzf containerd-shim-spin-v2-linux-amd64.tar.gz -C /usr/local/bin

# Configure containerd
cat >> /etc/containerd/config.toml << 'EOF'

[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.wasmtime]
  runtime_type = "io.containerd.wasmtime.v1"

[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.wasmedge]
  runtime_type = "io.containerd.wasmedge.v1"

[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.spin]
  runtime_type = "io.containerd.spin.v2"
EOF

systemctl restart containerd
```

### Creating RuntimeClass Objects

```yaml
# runtime-classes.yaml
---
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: wasmtime
handler: wasmtime
scheduling:
  nodeSelector:
    kubernetes.io/wasm: "true"

---
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: wasmedge
handler: wasmedge
scheduling:
  nodeSelector:
    kubernetes.io/wasm: "true"

---
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: spin
handler: spin
scheduling:
  nodeSelector:
    kubernetes.io/wasm: "true"
```

```bash
kubectl apply -f runtime-classes.yaml

# Label nodes that have the shims installed
kubectl label node worker-1 worker-2 kubernetes.io/wasm=true
```

### Packaging Wasm Modules as OCI Images

Wasm modules are distributed as OCI images — but they do not contain a Linux filesystem.

```dockerfile
# Dockerfile for a Wasm module
FROM scratch
COPY --chmod=755 target/wasm32-wasi/release/server.wasm /
CMD ["/server.wasm"]
```

```bash
# Build and push a Wasm OCI image
docker buildx build \
    --platform wasi/wasm \
    -t registry.internal/myapp-wasm:v1.0 \
    --push \
    .

# Or use wasm-to-oci for existing modules
wasm-to-oci push server.wasm registry.internal/myapp-wasm:v1.0
```

### Deploying a Wasm Workload

```yaml
# wasm-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: wasm-api
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: wasm-api
  template:
    metadata:
      labels:
        app: wasm-api
    spec:
      runtimeClassName: wasmtime
      containers:
        - name: wasm-api
          image: registry.internal/myapp-wasm:v1.0
          ports:
            - containerPort: 8080
          resources:
            limits:
              cpu: 100m
              memory: 64Mi
            requests:
              cpu: 10m
              memory: 16Mi
---
apiVersion: v1
kind: Service
metadata:
  name: wasm-api
spec:
  selector:
    app: wasm-api
  ports:
    - port: 80
      targetPort: 8080
```

## Section 4: SpinKube — Kubernetes-Native Wasm with Spin

SpinKube is a Kubernetes operator that provides first-class support for Spin applications (the Fermyon framework for Wasm-based microservices).

### Installing SpinKube

```bash
helm repo add spinoperator https://spinoperator.fermyon.com/helm
helm repo update

helm upgrade --install spin-operator spinoperator/spin-operator \
    --namespace spin-operator \
    --create-namespace \
    --version 0.3.0 \
    --wait

kubectl apply -f https://github.com/spinkube/spin-operator/releases/download/v0.3.0/spin-shim-executor.yaml

kubectl get pods -n spin-operator
kubectl get crd spinapps.core.spinkube.dev
```

### spin.toml — Application Manifest

```toml
spin_manifest_version = 2

[application]
name = "my-api"
version = "1.0.0"

[[trigger.http]]
route = "/api/..."
component = "api-handler"

[component.api-handler]
source = "target/wasm32-wasi/release/my_api.wasm"
allowed_outbound_hosts = ["https://external-api.example.com"]

[component.api-handler.build]
command = "tinygo build -target=wasi -gc=leaking -no-debug -o target/wasm32-wasi/release/my_api.wasm ."
```

### SpinApp CRD

```yaml
# spinapp.yaml
apiVersion: core.spinkube.dev/v1alpha1
kind: SpinApp
metadata:
  name: my-api
  namespace: production
spec:
  image: registry.internal/my-api:v1.0
  replicas: 3
  executor: containerd-shim-spin

  resources:
    limits:
      cpu: 100m
      memory: 128Mi
    requests:
      cpu: 10m
      memory: 32Mi

  variables:
    - name: LOG_LEVEL
      value: "info"
    - name: DATABASE_URL
      valueFrom:
        secretKeyRef:
          name: db-credentials
          key: url

  enableAutoscaling: true
  podAnnotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "9090"
```

```bash
kubectl apply -f spinapp.yaml

kubectl get spinapp -n production
kubectl get deployment my-api -n production
kubectl get service my-api -n production

# Scale
kubectl scale spinapp my-api --replicas=5 -n production
```

### Autoscaling SpinApp with KEDA

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: my-api-scaler
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: core.spinkube.dev/v1alpha1
    kind: SpinApp
    name: my-api
  minReplicaCount: 1
  maxReplicaCount: 50
  triggers:
    - type: prometheus
      metadata:
        serverAddress: http://prometheus.monitoring.svc:9090
        metricName: http_requests_total
        query: sum(rate(http_requests_total{app="my-api"}[1m]))
        threshold: "100"
```

## Section 5: Writing Go for Wasm/WASI

### Go + TinyGo for Wasm

```go
// main.go — HTTP handler compiled to Wasm with TinyGo + Spin SDK
package main

import (
    "encoding/json"
    "fmt"
    "net/http"

    spinhttp "github.com/fermyon/spin-go-sdk/http"
)

type Response struct {
    Message string `json:"message"`
    Version string `json:"version"`
}

func init() {
    spinhttp.Handle(func(w http.ResponseWriter, r *http.Request) {
        if r.Method != http.MethodGet {
            http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
            return
        }

        resp := Response{
            Message: "Hello from Wasm!",
            Version: "1.0.0",
        }
        w.Header().Set("Content-Type", "application/json")
        if err := json.NewEncoder(w).Encode(resp); err != nil {
            http.Error(w, fmt.Sprintf("encode error: %v", err), http.StatusInternalServerError)
        }
    })
}

func main() {}
```

```bash
# Build with TinyGo
tinygo build \
    -target=wasi \
    -gc=leaking \
    -no-debug \
    -o server.wasm \
    .

ls -lh server.wasm
# -rw-r--r-- 287K server.wasm  (vs ~6MB for a stdlib Go binary)
```

### Standard Go (GOOS=wasip1)

```go
// Go 1.21+ supports GOOS=wasip1 for WASI modules
package main

import (
    "fmt"
    "io"
    "net"
    "net/http"
    "os"
)

func main() {
    addr := os.Getenv("LISTEN_ADDR")
    if addr == "" {
        addr = "0.0.0.0:8080"
    }
    listener, err := net.Listen("tcp", addr)
    if err != nil {
        fmt.Fprintf(os.Stderr, "listen: %v\n", err)
        os.Exit(1)
    }

    http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        io.WriteString(w, "Hello from Go Wasm!")
    })

    if err := http.Serve(listener, nil); err != nil {
        fmt.Fprintf(os.Stderr, "serve: %v\n", err)
        os.Exit(1)
    }
}
```

```bash
GOOS=wasip1 GOARCH=wasm go build -o server.wasm .

wasmtime \
    --env LISTEN_ADDR=0.0.0.0:8080 \
    server.wasm
```

## Section 6: The Component Model

The WebAssembly Component Model is the next evolution beyond modules. It defines:

- **WIT (Wasm Interface Types)** — typed function signatures for imports and exports
- **Components** — modules with interface implementations and composition rules
- **WASI 0.2** — WASI rebuilt on the component model

```wit
// api.wit — WebAssembly Interface Type definition
package myorg:api@1.0.0;

interface http-handler {
    record request {
        method: string,
        path: string,
        headers: list<tuple<string, string>>,
        body: option<list<u8>>,
    }

    record response {
        status: u32,
        headers: list<tuple<string, string>>,
        body: option<list<u8>>,
    }

    handle-request: func(req: request) -> response;
}

world my-api {
    export http-handler;
    import wasi:http/outgoing-handler@0.2.0;
    import wasi:keyvalue/store@0.2.0;
}
```

```bash
# Build a component from a module
wasm-tools component new server.wasm -o server-component.wasm

# Compose two components
wasm-tools compose server-component.wasm \
    --adapter wasi-http-adapter.wasm \
    -o composed.wasm

# Validate component
wasm-tools validate --features component-model composed.wasm
```

## Section 7: Monitoring and Observability

```yaml
# Prometheus ServiceMonitor for Wasm workloads
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: wasm-apps
  namespace: monitoring
spec:
  selector:
    matchLabels:
      runtime: wasm
  namespaceSelector:
    matchNames: [production]
  endpoints:
    - port: metrics
      interval: 15s
      path: /metrics
```

```bash
# SpinKube metrics are exposed automatically
kubectl port-forward svc/my-api -n production 9090:9090
curl http://localhost:9090/metrics

# Key Wasm-specific metrics:
# spin_request_duration_ms_bucket  — request latency histogram
# spin_request_count_total         — total requests by route
# wasmedge_module_init_duration_us — module initialization time
# containerd_shim_start_time_ms    — shim startup time
```

## Section 8: Networking Considerations

```yaml
# Spin apps are exposed via Kubernetes Service identically to container workloads
apiVersion: v1
kind: Service
metadata:
  name: my-api
  namespace: production
  labels:
    runtime: wasm
spec:
  selector:
    app: my-api
  ports:
    - name: http
      port: 80
      targetPort: 80
    - name: metrics
      port: 9090
      targetPort: 9090
  type: ClusterIP

---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-api
  namespace: production
spec:
  ingressClassName: nginx
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: my-api
                port:
                  number: 80
```

## Section 9: Limitations and When Not to Use Wasm

### Current Limitations

```text
1. No fork/exec — cannot spawn subprocesses
   Wasm modules cannot call fork(), exec(), or posix_spawn()
   This means: no shell commands, no subprocess-based tools

2. Limited threading support
   WASI threads proposal is in progress but not universally available
   Most production runtimes offer single-threaded execution per module

3. No dynamic linking
   All dependencies must be compiled into the .wasm binary
   Result: larger modules that include all their dependencies statically

4. 4 GB memory limit (Wasm32)
   Linear memory is indexed by a 32-bit integer = 4 GB maximum
   Wasm64 exists but is not widely supported in runtimes yet

5. Limited debugging tooling
   Standard debuggers (GDB/delve) do not attach to Wasm modules
   Use DWARF debug info emitted by wasmtime/WasmEdge with Wasm-specific tools
```

### When to Use Wasm vs Containers

| Use Case | Recommendation |
|---|---|
| HTTP microservices with fast cold starts | Wasm (SpinKube/wasmtime) |
| Stateless FaaS handlers | Wasm |
| Plugins/extensions in multi-tenant platforms | Wasm (capability safety) |
| Stateful services needing complex I/O | Containers |
| Services with native library dependencies | Containers |
| AI/ML inference workloads | WasmEdge (GGML plugin) or GPU containers |
| Long-running background workers | Containers |
| Services requiring more than 4 GB memory | Containers |

## Section 10: Production Checklist

- [ ] containerd-wasm-shims installed on designated Wasm worker nodes
- [ ] RuntimeClass objects created for wasmtime, wasmedge, and spin
- [ ] Nodes labeled with `kubernetes.io/wasm: "true"` for scheduling
- [ ] SpinKube operator installed if using Spin-based applications
- [ ] OCI images pushed using `wasm/wasi` platform or wasm-to-oci tool
- [ ] WASI capabilities minimally declared in spin.toml (no unnecessary access)
- [ ] TinyGo or GOOS=wasip1 build pipeline configured
- [ ] Component Model WIT interfaces defined for cross-component contracts
- [ ] Prometheus ServiceMonitor deployed for Wasm workload metrics
- [ ] Resource requests sized appropriately (Wasm uses far less memory)
- [ ] KEDA ScaledObject configured for HTTP-based autoscaling
- [ ] Limitation checklist reviewed: no subprocess, threading restrictions, no dynamic linking

## Conclusion

Wasm on Kubernetes is not a replacement for containers — it is a complement for specific workloads. Where containers excel at running complex stateful services with arbitrary system dependencies, Wasm excels at running simple, stateless, security-critical handlers with microsecond startup times and minimal footprint.

SpinKube is the most production-ready path today: it provides a CRD-based deployment model, autoscaling integration, and a mature Spin framework for building the application. WasmEdge is the choice when you need extensions like AI inference, TLS, or database connectivity beyond basic WASI. The component model is the future of Wasm composition — invest in learning WIT interfaces now to be ready when the ecosystem matures.
