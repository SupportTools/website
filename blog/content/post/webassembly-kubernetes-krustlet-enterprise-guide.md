---
title: "WebAssembly in Kubernetes with Krustlet: Production Implementation Guide"
date: 2026-12-14T00:00:00-05:00
draft: false
tags: ["WebAssembly", "Kubernetes", "Krustlet", "WASM", "Container Runtime", "Cloud Native", "Performance"]
categories: ["Kubernetes", "Emerging Technologies", "Cloud Native"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to deploying WebAssembly workloads in Kubernetes using Krustlet, including production patterns, performance optimization, and enterprise integration strategies."
more_link: "yes"
url: "/webassembly-kubernetes-krustlet-enterprise-guide/"
---

WebAssembly (WASM) represents a paradigm shift in how we think about application deployment in Kubernetes. This comprehensive guide explores production implementation of WebAssembly workloads using Krustlet, demonstrating how to leverage WASM's performance benefits, security model, and portability in enterprise Kubernetes environments.

<!--more-->

# WebAssembly in Kubernetes with Krustlet: Production Implementation Guide

## Executive Summary

WebAssembly has evolved from a browser technology to a compelling alternative for containerized workloads. Krustlet, a Kubernetes kubelet implementation written in Rust, enables running WebAssembly modules as first-class Kubernetes workloads. This guide provides a comprehensive approach to implementing WASM workloads in production Kubernetes clusters, covering architecture patterns, security considerations, performance optimization, and operational best practices.

## Understanding WebAssembly in Kubernetes Context

### Why WebAssembly for Kubernetes?

WebAssembly offers several advantages over traditional container workloads:

**Performance Benefits:**
- Near-native execution speed with minimal overhead
- Fast cold start times (milliseconds vs. seconds)
- Smaller artifact sizes (KB vs. MB)
- Efficient memory utilization

**Security Advantages:**
- Capability-based security model
- Sandboxed execution environment
- No system call access without explicit grants
- Reduced attack surface

**Portability:**
- True write-once-run-anywhere across architectures
- No OS dependencies
- Consistent behavior across platforms
- Simplified multi-architecture deployments

### Krustlet Architecture

Krustlet acts as a Kubelet replacement for WebAssembly workloads:

```
┌─────────────────────────────────────────┐
│         Kubernetes Control Plane        │
│  (API Server, Scheduler, Controllers)   │
└─────────────────┬───────────────────────┘
                  │
                  │ Kubernetes API
                  │
┌─────────────────┴───────────────────────┐
│            Krustlet Node                │
│  ┌─────────────────────────────────┐   │
│  │      Krustlet Process           │   │
│  │  ┌──────────────────────────┐   │   │
│  │  │   WASM Runtime Provider  │   │   │
│  │  │  (wasmtime/wasmer)       │   │   │
│  │  └──────────────────────────┘   │   │
│  │  ┌──────────────────────────┐   │   │
│  │  │   WASI Implementation    │   │   │
│  │  └──────────────────────────┘   │   │
│  │  ┌──────────────────────────┐   │   │
│  │  │   Volume Management      │   │   │
│  │  └──────────────────────────┘   │   │
│  └─────────────────────────────────┘   │
│                                         │
│  ┌─────────────────────────────────┐   │
│  │    WASM Module Instances        │   │
│  │  ┌────┐ ┌────┐ ┌────┐ ┌────┐   │   │
│  │  │Pod1│ │Pod2│ │Pod3│ │Pod4│   │   │
│  │  └────┘ └────┘ └────┘ └────┘   │   │
│  └─────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

## Production Krustlet Deployment

### Cluster Prerequisites

Before deploying Krustlet, ensure your Kubernetes cluster meets these requirements:

```yaml
# cluster-requirements.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: krustlet-requirements
  namespace: kube-system
data:
  kubernetes-version: ">=1.24.0"
  runtime-class-support: "enabled"
  node-labels-support: "enabled"
  tolerations-support: "enabled"
```

### Krustlet Installation with Helm

Create a comprehensive Helm chart for Krustlet deployment:

```yaml
# values.yaml
krustlet:
  image:
    repository: ghcr.io/krustlet/krustlet-wasi
    tag: v1.0.0-alpha.1
    pullPolicy: IfNotPresent

  # Node configuration
  node:
    name: krustlet-wasm-node
    labels:
      kubernetes.io/arch: wasm32-wasi
      kubernetes.io/os: wasi
      node.kubernetes.io/instance-type: wasm
      workload.type: webassembly
    taints:
      - key: kubernetes.io/arch
        value: wasm32-wasi
        effect: NoExecute
      - key: node.kubernetes.io/network
        value: host
        effect: NoSchedule

  # Runtime configuration
  runtime:
    provider: wasmtime
    wasmtime:
      cache:
        enabled: true
        directory: /var/lib/krustlet/cache
      pooling:
        enabled: true
        totalMemories: 1000
        totalInstances: 1000

  # Resource limits
  resources:
    limits:
      cpu: "4"
      memory: 8Gi
    requests:
      cpu: "2"
      memory: 4Gi

  # Storage configuration
  persistence:
    enabled: true
    storageClass: fast-ssd
    size: 50Gi
    volumePath: /var/lib/krustlet

  # Security context
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    fsGroup: 1000
    seccompProfile:
      type: RuntimeDefault
    capabilities:
      drop:
        - ALL

  # Service account
  serviceAccount:
    create: true
    name: krustlet
    annotations:
      eks.amazonaws.com/role-arn: arn:aws:iam::ACCOUNT:role/krustlet-role

  # Bootstrap configuration
  bootstrap:
    enabled: true
    server: https://kubernetes.default.svc
    certPath: /var/lib/krustlet/tls

  # Monitoring
  metrics:
    enabled: true
    port: 9090
    path: /metrics

  # Logging
  logging:
    level: info
    format: json
    output: stdout

  # Plugin configuration
  plugins:
    ociRegistry:
      enabled: true
      allowInsecure: false
      allowHttp: false
    volumePlugins:
      - configmap
      - secret
      - hostpath
      - pvc
```

### Helm Chart Templates

Create the main deployment template:

```yaml
# templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "krustlet.fullname" . }}
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "krustlet.labels" . | nindent 4 }}
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels:
      {{- include "krustlet.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
        prometheus.io/scrape: "true"
        prometheus.io/port: "{{ .Values.krustlet.metrics.port }}"
        prometheus.io/path: "{{ .Values.krustlet.metrics.path }}"
      labels:
        {{- include "krustlet.selectorLabels" . | nindent 8 }}
    spec:
      serviceAccountName: {{ include "krustlet.serviceAccountName" . }}
      securityContext:
        {{- toYaml .Values.krustlet.securityContext | nindent 8 }}
      hostNetwork: true
      dnsPolicy: ClusterFirstWithHostNet
      initContainers:
      - name: bootstrap
        image: {{ .Values.krustlet.image.repository }}:{{ .Values.krustlet.image.tag }}
        command:
        - /krustlet-wasi
        - bootstrap
        - --bootstrap-file=/var/lib/krustlet/bootstrap.conf
        - --cert-path=/var/lib/krustlet/tls
        volumeMounts:
        - name: krustlet-data
          mountPath: /var/lib/krustlet
        - name: krustlet-config
          mountPath: /etc/krustlet
        env:
        - name: KUBECONFIG
          value: /var/lib/krustlet/kubeconfig
      containers:
      - name: krustlet
        image: {{ .Values.krustlet.image.repository }}:{{ .Values.krustlet.image.tag }}
        imagePullPolicy: {{ .Values.krustlet.image.pullPolicy }}
        command:
        - /krustlet-wasi
        args:
        - --node-name={{ .Values.krustlet.node.name }}
        - --node-ip=$(NODE_IP)
        - --cert-path=/var/lib/krustlet/tls
        - --data-path=/var/lib/krustlet
        - --bootstrap-file=/var/lib/krustlet/bootstrap.conf
        - --insecure-registries={{ .Values.krustlet.plugins.ociRegistry.allowInsecure }}
        - --max-pods=110
        env:
        - name: NODE_IP
          valueFrom:
            fieldRef:
              fieldPath: status.hostIP
        - name: KUBECONFIG
          value: /var/lib/krustlet/kubeconfig
        - name: RUST_LOG
          value: {{ .Values.krustlet.logging.level }}
        - name: RUST_LOG_FORMAT
          value: {{ .Values.krustlet.logging.format }}
        ports:
        - name: http
          containerPort: 3000
          protocol: TCP
        - name: metrics
          containerPort: {{ .Values.krustlet.metrics.port }}
          protocol: TCP
        livenessProbe:
          httpGet:
            path: /healthz
            port: http
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: /readyz
            port: http
          initialDelaySeconds: 10
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 2
        resources:
          {{- toYaml .Values.krustlet.resources | nindent 10 }}
        volumeMounts:
        - name: krustlet-data
          mountPath: /var/lib/krustlet
        - name: krustlet-config
          mountPath: /etc/krustlet
        - name: krustlet-cache
          mountPath: /var/cache/krustlet
      volumes:
      - name: krustlet-data
        {{- if .Values.krustlet.persistence.enabled }}
        persistentVolumeClaim:
          claimName: {{ include "krustlet.fullname" . }}-data
        {{- else }}
        emptyDir: {}
        {{- end }}
      - name: krustlet-config
        configMap:
          name: {{ include "krustlet.fullname" . }}-config
      - name: krustlet-cache
        emptyDir:
          sizeLimit: 10Gi
      nodeSelector:
        {{- toYaml .Values.nodeSelector | nindent 8 }}
      affinity:
        {{- toYaml .Values.affinity | nindent 8 }}
      tolerations:
        {{- toYaml .Values.tolerations | nindent 8 }}
```

### RuntimeClass Configuration

Define RuntimeClass for WASM workloads:

```yaml
# runtime-class.yaml
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: wasmtime-wasi
handler: wasmtime-wasi
scheduling:
  nodeSelector:
    kubernetes.io/arch: wasm32-wasi
    workload.type: webassembly
  tolerations:
  - key: kubernetes.io/arch
    operator: Equal
    value: wasm32-wasi
    effect: NoExecute
  - key: node.kubernetes.io/network
    operator: Equal
    value: host
    effect: NoSchedule
overhead:
  podFixed:
    memory: "32Mi"
    cpu: "50m"
---
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: wasmer-wasi
handler: wasmer-wasi
scheduling:
  nodeSelector:
    kubernetes.io/arch: wasm32-wasi
    workload.type: webassembly
  tolerations:
  - key: kubernetes.io/arch
    operator: Equal
    value: wasm32-wasi
    effect: NoExecute
```

## Building WebAssembly Applications

### Rust Application Example

Create a production-ready Rust application compiled to WASM:

```rust
// src/main.rs
use std::io::{self, Write};
use std::env;
use std::fs;
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::Duration;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
struct HealthStatus {
    status: String,
    version: String,
    uptime_seconds: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct MetricsData {
    requests_total: u64,
    requests_success: u64,
    requests_failed: u64,
    response_time_ms: Vec<u64>,
}

static mut METRICS: MetricsData = MetricsData {
    requests_total: 0,
    requests_success: 0,
    requests_failed: 0,
    response_time_ms: Vec::new(),
};

fn main() -> io::Result<()> {
    println!("Starting WebAssembly HTTP server...");

    let port = env::var("PORT").unwrap_or_else(|_| "8080".to_string());
    let bind_addr = format!("0.0.0.0:{}", port);

    let listener = TcpListener::bind(&bind_addr)?;
    println!("Listening on {}", bind_addr);

    // Handle graceful shutdown
    let running = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let r = running.clone();

    ctrlc::set_handler(move || {
        r.store(false, std::sync::atomic::Ordering::SeqCst);
        println!("Received shutdown signal, stopping server...");
    }).expect("Error setting Ctrl-C handler");

    for stream in listener.incoming() {
        if !running.load(std::sync::atomic::Ordering::SeqCst) {
            break;
        }

        match stream {
            Ok(stream) => {
                thread::spawn(move || {
                    handle_client(stream);
                });
            }
            Err(e) => {
                eprintln!("Connection failed: {}", e);
            }
        }
    }

    println!("Server stopped");
    Ok(())
}

fn handle_client(mut stream: TcpStream) {
    let start_time = std::time::Instant::now();
    let mut buffer = [0; 4096];

    match stream.read(&mut buffer) {
        Ok(size) => {
            let request = String::from_utf8_lossy(&buffer[..size]);
            let response = route_request(&request);

            let duration = start_time.elapsed().as_millis() as u64;
            unsafe {
                METRICS.requests_total += 1;
                METRICS.response_time_ms.push(duration);
                if response.starts_with("HTTP/1.1 200") {
                    METRICS.requests_success += 1;
                } else {
                    METRICS.requests_failed += 1;
                }
            }

            stream.write_all(response.as_bytes()).unwrap();
            stream.flush().unwrap();
        }
        Err(e) => {
            eprintln!("Failed to read from stream: {}", e);
        }
    }
}

fn route_request(request: &str) -> String {
    let lines: Vec<&str> = request.lines().collect();
    if lines.is_empty() {
        return error_response(400, "Bad Request");
    }

    let request_line: Vec<&str> = lines[0].split_whitespace().collect();
    if request_line.len() < 2 {
        return error_response(400, "Bad Request");
    }

    let method = request_line[0];
    let path = request_line[1];

    match (method, path) {
        ("GET", "/") => hello_response(),
        ("GET", "/health") => health_response(),
        ("GET", "/healthz") => health_response(),
        ("GET", "/readyz") => ready_response(),
        ("GET", "/metrics") => metrics_response(),
        ("POST", path) if path.starts_with("/api/") => api_response(path),
        _ => error_response(404, "Not Found"),
    }
}

fn hello_response() -> String {
    let body = r#"{"message": "Hello from WebAssembly!", "runtime": "wasi"}"#;
    let response = format!(
        "HTTP/1.1 200 OK\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         \r\n\
         {}",
        body.len(),
        body
    );
    response
}

fn health_response() -> String {
    let health = HealthStatus {
        status: "healthy".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        uptime_seconds: 0, // In production, track actual uptime
    };

    let body = serde_json::to_string(&health).unwrap();
    let response = format!(
        "HTTP/1.1 200 OK\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         \r\n\
         {}",
        body.len(),
        body
    );
    response
}

fn ready_response() -> String {
    // Check if application is ready to serve traffic
    let body = r#"{"status": "ready"}"#;
    let response = format!(
        "HTTP/1.1 200 OK\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         \r\n\
         {}",
        body.len(),
        body
    );
    response
}

fn metrics_response() -> String {
    let metrics = unsafe {
        let avg_response_time = if !METRICS.response_time_ms.is_empty() {
            METRICS.response_time_ms.iter().sum::<u64>() / METRICS.response_time_ms.len() as u64
        } else {
            0
        };

        format!(
            "# HELP requests_total Total number of HTTP requests\n\
             # TYPE requests_total counter\n\
             requests_total {}\n\
             # HELP requests_success Total number of successful requests\n\
             # TYPE requests_success counter\n\
             requests_success {}\n\
             # HELP requests_failed Total number of failed requests\n\
             # TYPE requests_failed counter\n\
             requests_failed {}\n\
             # HELP response_time_avg_ms Average response time in milliseconds\n\
             # TYPE response_time_avg_ms gauge\n\
             response_time_avg_ms {}\n",
            METRICS.requests_total,
            METRICS.requests_success,
            METRICS.requests_failed,
            avg_response_time
        )
    };

    let response = format!(
        "HTTP/1.1 200 OK\r\n\
         Content-Type: text/plain; version=0.0.4\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         \r\n\
         {}",
        metrics.len(),
        metrics
    );
    response
}

fn api_response(path: &str) -> String {
    let body = format!(r#"{{"message": "API endpoint", "path": "{}"}}"#, path);
    let response = format!(
        "HTTP/1.1 200 OK\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         \r\n\
         {}",
        body.len(),
        body
    );
    response
}

fn error_response(code: u16, message: &str) -> String {
    let body = format!(r#"{{"error": "{}", "code": {}}}"#, message, code);
    let response = format!(
        "HTTP/1.1 {} {}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         \r\n\
         {}",
        code,
        message,
        body.len(),
        body
    );
    response
}
```

### Cargo Configuration

```toml
# Cargo.toml
[package]
name = "wasm-http-server"
version = "1.0.0"
edition = "2021"

[dependencies]
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
ctrlc = "3.2"

[profile.release]
opt-level = "z"
lto = true
codegen-units = 1
strip = true
panic = "abort"

[profile.release.package."*"]
opt-level = "z"
```

### Build and Package Script

```bash
#!/bin/bash
# build-wasm.sh

set -euo pipefail

PROJECT_NAME="wasm-http-server"
VERSION="${VERSION:-1.0.0}"
REGISTRY="${REGISTRY:-ghcr.io/myorg}"

echo "Building WASM module..."
cargo build --target wasm32-wasi --release

echo "Optimizing WASM module..."
wasm-opt -Oz \
  target/wasm32-wasi/release/${PROJECT_NAME}.wasm \
  -o target/wasm32-wasi/release/${PROJECT_NAME}-optimized.wasm

echo "Creating OCI artifact..."
cat > wasm-to-oci.yaml <<EOF
apiVersion: core.oam.dev/v1beta1
kind: ComponentDefinition
metadata:
  name: ${PROJECT_NAME}
spec:
  workload:
    definition:
      apiVersion: v1
      kind: Pod
  schematic:
    cue:
      template: |
        output: {
          apiVersion: "v1"
          kind: "Pod"
          spec: {
            containers: [{
              name: "wasm"
              image: "${REGISTRY}/${PROJECT_NAME}:${VERSION}"
            }]
          }
        }
EOF

# Push to OCI registry using wasm-to-oci
wasm-to-oci push \
  target/wasm32-wasi/release/${PROJECT_NAME}-optimized.wasm \
  ${REGISTRY}/${PROJECT_NAME}:${VERSION}

echo "WASM module built and pushed to ${REGISTRY}/${PROJECT_NAME}:${VERSION}"
```

## Deploying WebAssembly Workloads

### Basic WASM Pod Deployment

```yaml
# wasm-deployment.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: wasm-apps
  labels:
    runtime: webassembly
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: wasm-app
  namespace: wasm-apps
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: wasm-app-config
  namespace: wasm-apps
data:
  PORT: "8080"
  LOG_LEVEL: "info"
  ENVIRONMENT: "production"
---
apiVersion: v1
kind: Secret
metadata:
  name: wasm-app-secrets
  namespace: wasm-apps
type: Opaque
stringData:
  api-key: "your-api-key-here"
  database-url: "postgres://user:pass@db:5432/appdb"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: wasm-http-server
  namespace: wasm-apps
  labels:
    app: wasm-http-server
    version: v1
    runtime: webassembly
spec:
  replicas: 3
  selector:
    matchLabels:
      app: wasm-http-server
  template:
    metadata:
      labels:
        app: wasm-http-server
        version: v1
        runtime: webassembly
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8080"
        prometheus.io/path: "/metrics"
    spec:
      runtimeClassName: wasmtime-wasi
      serviceAccountName: wasm-app
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
      - name: wasm-app
        image: ghcr.io/myorg/wasm-http-server:1.0.0
        imagePullPolicy: IfNotPresent
        ports:
        - name: http
          containerPort: 8080
          protocol: TCP
        env:
        - name: PORT
          valueFrom:
            configMapKeyRef:
              name: wasm-app-config
              key: PORT
        - name: LOG_LEVEL
          valueFrom:
            configMapKeyRef:
              name: wasm-app-config
              key: LOG_LEVEL
        - name: API_KEY
          valueFrom:
            secretKeyRef:
              name: wasm-app-secrets
              key: api-key
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        - name: POD_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace
        - name: POD_IP
          valueFrom:
            fieldRef:
              fieldPath: status.podIP
        resources:
          requests:
            cpu: 50m
            memory: 64Mi
          limits:
            cpu: 200m
            memory: 128Mi
        livenessProbe:
          httpGet:
            path: /healthz
            port: http
          initialDelaySeconds: 5
          periodSeconds: 10
          timeoutSeconds: 2
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: /readyz
            port: http
          initialDelaySeconds: 2
          periodSeconds: 5
          timeoutSeconds: 1
          failureThreshold: 2
        startupProbe:
          httpGet:
            path: /healthz
            port: http
          initialDelaySeconds: 0
          periodSeconds: 1
          timeoutSeconds: 1
          failureThreshold: 30
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
                  - wasm-http-server
              topologyKey: kubernetes.io/hostname
      tolerations:
      - key: kubernetes.io/arch
        operator: Equal
        value: wasm32-wasi
        effect: NoExecute
---
apiVersion: v1
kind: Service
metadata:
  name: wasm-http-server
  namespace: wasm-apps
  labels:
    app: wasm-http-server
spec:
  type: ClusterIP
  selector:
    app: wasm-http-server
  ports:
  - name: http
    port: 80
    targetPort: http
    protocol: TCP
  sessionAffinity: ClientIP
  sessionAffinityConfig:
    clientIP:
      timeoutSeconds: 10800
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: wasm-http-server
  namespace: wasm-apps
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: wasm-http-server
  minReplicas: 3
  maxReplicas: 50
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 50
        periodSeconds: 15
      - type: Pods
        value: 2
        periodSeconds: 15
      selectPolicy: Min
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
      - type: Percent
        value: 100
        periodSeconds: 15
      - type: Pods
        value: 4
        periodSeconds: 15
      selectPolicy: Max
```

### Ingress Configuration

```yaml
# wasm-ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: wasm-http-server
  namespace: wasm-apps
  annotations:
    kubernetes.io/ingress.class: "nginx"
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"
    nginx.ingress.kubernetes.io/backend-protocol: "HTTP"
    nginx.ingress.kubernetes.io/rate-limit: "100"
    nginx.ingress.kubernetes.io/limit-rps: "10"
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"
    nginx.ingress.kubernetes.io/proxy-connect-timeout: "30"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "30"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "30"
spec:
  tls:
  - hosts:
    - wasm.example.com
    secretName: wasm-app-tls
  rules:
  - host: wasm.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: wasm-http-server
            port:
              name: http
```

## Advanced WASM Integration Patterns

### WASM with Service Mesh (Istio)

```yaml
# istio-wasm-integration.yaml
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: wasm-http-server
  namespace: wasm-apps
spec:
  hosts:
  - wasm-http-server
  - wasm.example.com
  gateways:
  - wasm-gateway
  http:
  - match:
    - uri:
        prefix: /api/v1
    route:
    - destination:
        host: wasm-http-server
        port:
          number: 80
        subset: v1
      weight: 90
    - destination:
        host: wasm-http-server
        port:
          number: 80
        subset: v2
      weight: 10
    timeout: 30s
    retries:
      attempts: 3
      perTryTimeout: 10s
      retryOn: 5xx,reset,connect-failure,refused-stream
  - match:
    - uri:
        prefix: /
    route:
    - destination:
        host: wasm-http-server
        port:
          number: 80
---
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: wasm-http-server
  namespace: wasm-apps
spec:
  host: wasm-http-server
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 100
      http:
        http1MaxPendingRequests: 50
        http2MaxRequests: 100
        maxRequestsPerConnection: 10
    loadBalancer:
      simple: LEAST_REQUEST
      localityLbSetting:
        enabled: true
        distribute:
        - from: us-east-1/*
          to:
            us-east-1/*: 90
            us-west-2/*: 10
    outlierDetection:
      consecutiveErrors: 5
      interval: 30s
      baseEjectionTime: 30s
      maxEjectionPercent: 50
      minHealthPercent: 40
  subsets:
  - name: v1
    labels:
      version: v1
  - name: v2
    labels:
      version: v2
```

### WASM with KEDA Autoscaling

```yaml
# keda-wasm-autoscaling.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: wasm-http-server-scaler
  namespace: wasm-apps
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: wasm-http-server
  pollingInterval: 15
  cooldownPeriod: 300
  minReplicaCount: 3
  maxReplicaCount: 100
  advanced:
    restoreToOriginalReplicaCount: false
    horizontalPodAutoscalerConfig:
      behavior:
        scaleDown:
          stabilizationWindowSeconds: 300
          policies:
          - type: Percent
            value: 50
            periodSeconds: 15
        scaleUp:
          stabilizationWindowSeconds: 0
          policies:
          - type: Percent
            value: 100
            periodSeconds: 15
          - type: Pods
            value: 10
            periodSeconds: 15
          selectPolicy: Max
  triggers:
  - type: prometheus
    metadata:
      serverAddress: http://prometheus.monitoring:9090
      metricName: http_requests_per_second
      threshold: '100'
      query: |
        sum(rate(requests_total{
          namespace="wasm-apps",
          pod=~"wasm-http-server-.*"
        }[1m]))
  - type: cpu
    metadataRef:
      averageUtilization: "70"
  - type: memory
    metadataRef:
      averageUtilization: "80"
```

## Monitoring and Observability

### Prometheus ServiceMonitor

```yaml
# prometheus-monitoring.yaml
apiVersion: v1
kind: Service
metadata:
  name: wasm-http-server-metrics
  namespace: wasm-apps
  labels:
    app: wasm-http-server
    monitoring: prometheus
spec:
  type: ClusterIP
  clusterIP: None
  selector:
    app: wasm-http-server
  ports:
  - name: metrics
    port: 8080
    targetPort: http
    protocol: TCP
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: wasm-http-server
  namespace: wasm-apps
  labels:
    app: wasm-http-server
    prometheus: kube-prometheus
spec:
  selector:
    matchLabels:
      app: wasm-http-server
      monitoring: prometheus
  endpoints:
  - port: metrics
    path: /metrics
    interval: 30s
    scrapeTimeout: 10s
    relabelings:
    - sourceLabels: [__meta_kubernetes_pod_name]
      targetLabel: pod
    - sourceLabels: [__meta_kubernetes_pod_node_name]
      targetLabel: node
    - sourceLabels: [__meta_kubernetes_namespace]
      targetLabel: namespace
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: wasm-http-server-alerts
  namespace: wasm-apps
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
  - name: wasm-http-server
    interval: 30s
    rules:
    - alert: WASMHighErrorRate
      expr: |
        sum(rate(requests_failed[5m])) by (namespace, pod)
        /
        sum(rate(requests_total[5m])) by (namespace, pod)
        > 0.05
      for: 5m
      labels:
        severity: warning
        component: wasm-app
      annotations:
        summary: "High error rate in WASM application"
        description: "Pod {{ $labels.pod }} has error rate above 5% (current: {{ $value | humanizePercentage }})"

    - alert: WASMHighLatency
      expr: |
        histogram_quantile(0.95,
          sum(rate(response_time_ms_bucket[5m])) by (le, namespace, pod)
        ) > 1000
      for: 10m
      labels:
        severity: warning
        component: wasm-app
      annotations:
        summary: "High latency in WASM application"
        description: "Pod {{ $labels.pod }} has 95th percentile latency above 1s (current: {{ $value }}ms)"

    - alert: WASMPodCrashLooping
      expr: |
        rate(kube_pod_container_status_restarts_total{
          namespace="wasm-apps",
          pod=~"wasm-http-server-.*"
        }[15m]) > 0
      for: 5m
      labels:
        severity: critical
        component: wasm-app
      annotations:
        summary: "WASM pod is crash looping"
        description: "Pod {{ $labels.pod }} is restarting frequently"

    - alert: WASMHighMemoryUsage
      expr: |
        sum(container_memory_working_set_bytes{
          namespace="wasm-apps",
          pod=~"wasm-http-server-.*"
        }) by (pod)
        /
        sum(container_spec_memory_limit_bytes{
          namespace="wasm-apps",
          pod=~"wasm-http-server-.*"
        }) by (pod)
        > 0.85
      for: 10m
      labels:
        severity: warning
        component: wasm-app
      annotations:
        summary: "WASM pod high memory usage"
        description: "Pod {{ $labels.pod }} is using more than 85% of memory limit"
```

### Grafana Dashboard

```json
{
  "dashboard": {
    "title": "WebAssembly Application Metrics",
    "tags": ["wasm", "kubernetes", "krustlet"],
    "timezone": "browser",
    "panels": [
      {
        "id": 1,
        "title": "Request Rate",
        "type": "graph",
        "targets": [
          {
            "expr": "sum(rate(requests_total{namespace=\"wasm-apps\"}[5m])) by (pod)",
            "legendFormat": "{{pod}}"
          }
        ]
      },
      {
        "id": 2,
        "title": "Error Rate",
        "type": "graph",
        "targets": [
          {
            "expr": "sum(rate(requests_failed{namespace=\"wasm-apps\"}[5m])) by (pod)",
            "legendFormat": "{{pod}}"
          }
        ]
      },
      {
        "id": 3,
        "title": "Response Time (p50, p95, p99)",
        "type": "graph",
        "targets": [
          {
            "expr": "histogram_quantile(0.50, sum(rate(response_time_ms_bucket{namespace=\"wasm-apps\"}[5m])) by (le, pod))",
            "legendFormat": "p50 - {{pod}}"
          },
          {
            "expr": "histogram_quantile(0.95, sum(rate(response_time_ms_bucket{namespace=\"wasm-apps\"}[5m])) by (le, pod))",
            "legendFormat": "p95 - {{pod}}"
          },
          {
            "expr": "histogram_quantile(0.99, sum(rate(response_time_ms_bucket{namespace=\"wasm-apps\"}[5m])) by (le, pod))",
            "legendFormat": "p99 - {{pod}}"
          }
        ]
      },
      {
        "id": 4,
        "title": "Memory Usage",
        "type": "graph",
        "targets": [
          {
            "expr": "sum(container_memory_working_set_bytes{namespace=\"wasm-apps\", pod=~\"wasm-http-server-.*\"}) by (pod)",
            "legendFormat": "{{pod}}"
          }
        ]
      },
      {
        "id": 5,
        "title": "CPU Usage",
        "type": "graph",
        "targets": [
          {
            "expr": "sum(rate(container_cpu_usage_seconds_total{namespace=\"wasm-apps\", pod=~\"wasm-http-server-.*\"}[5m])) by (pod)",
            "legendFormat": "{{pod}}"
          }
        ]
      },
      {
        "id": 6,
        "title": "Pod Count",
        "type": "stat",
        "targets": [
          {
            "expr": "count(kube_pod_info{namespace=\"wasm-apps\", pod=~\"wasm-http-server-.*\"})"
          }
        ]
      }
    ]
  }
}
```

## Performance Optimization

### WASM Module Optimization Script

```bash
#!/bin/bash
# optimize-wasm.sh

set -euo pipefail

WASM_FILE="$1"
OUTPUT_FILE="${2:-optimized.wasm}"

echo "Optimizing WASM module: $WASM_FILE"

# Step 1: Basic optimization with wasm-opt
echo "Running wasm-opt..."
wasm-opt -O3 \
  --enable-bulk-memory \
  --enable-sign-ext \
  --enable-simd \
  --enable-threads \
  -o temp1.wasm \
  "$WASM_FILE"

# Step 2: Aggressive size optimization
echo "Running aggressive optimization..."
wasm-opt -Oz \
  --strip-debug \
  --strip-dwarf \
  --strip-producers \
  --dce \
  --remove-unused-brs \
  --remove-unused-names \
  --merge-blocks \
  --coalesce-locals \
  --simplify-locals \
  --vacuum \
  -o temp2.wasm \
  temp1.wasm

# Step 3: Final polishing
echo "Final optimization pass..."
wasm-opt -O3 \
  --converge \
  -o "$OUTPUT_FILE" \
  temp2.wasm

# Cleanup
rm -f temp1.wasm temp2.wasm

# Compare sizes
ORIGINAL_SIZE=$(stat -f%z "$WASM_FILE" 2>/dev/null || stat -c%s "$WASM_FILE")
OPTIMIZED_SIZE=$(stat -f%z "$OUTPUT_FILE" 2>/dev/null || stat -c%s "$OUTPUT_FILE")
REDUCTION=$((100 - (OPTIMIZED_SIZE * 100 / ORIGINAL_SIZE)))

echo "Optimization complete!"
echo "Original size: $ORIGINAL_SIZE bytes"
echo "Optimized size: $OPTIMIZED_SIZE bytes"
echo "Size reduction: ${REDUCTION}%"
```

## Security Best Practices

### Pod Security Policy for WASM

```yaml
# wasm-psp.yaml
apiVersion: policy/v1beta1
kind: PodSecurityPolicy
metadata:
  name: wasm-restricted
  annotations:
    seccomp.security.alpha.kubernetes.io/allowedProfileNames: 'runtime/default'
    apparmor.security.beta.kubernetes.io/allowedProfileNames: 'runtime/default'
    seccomp.security.alpha.kubernetes.io/defaultProfileName:  'runtime/default'
    apparmor.security.beta.kubernetes.io/defaultProfileName:  'runtime/default'
spec:
  privileged: false
  allowPrivilegeEscalation: false
  requiredDropCapabilities:
    - ALL
  volumes:
    - 'configMap'
    - 'emptyDir'
    - 'projected'
    - 'secret'
    - 'downwardAPI'
    - 'persistentVolumeClaim'
  hostNetwork: false
  hostIPC: false
  hostPID: false
  runAsUser:
    rule: 'MustRunAsNonRoot'
  seLinux:
    rule: 'RunAsAny'
  supplementalGroups:
    rule: 'RunAsAny'
  fsGroup:
    rule: 'RunAsAny'
  readOnlyRootFilesystem: false
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: wasm-psp-user
rules:
- apiGroups:
  - policy
  resources:
  - podsecuritypolicies
  verbs:
  - use
  resourceNames:
  - wasm-restricted
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: wasm-psp-user
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: wasm-psp-user
subjects:
- kind: ServiceAccount
  name: wasm-app
  namespace: wasm-apps
```

### Network Policies

```yaml
# wasm-network-policy.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: wasm-app-network-policy
  namespace: wasm-apps
spec:
  podSelector:
    matchLabels:
      app: wasm-http-server
  policyTypes:
  - Ingress
  - Egress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          name: ingress-nginx
    - podSelector:
        matchLabels:
          app: monitoring
    ports:
    - protocol: TCP
      port: 8080
  egress:
  - to:
    - namespaceSelector:
        matchLabels:
          name: kube-system
    ports:
    - protocol: TCP
      port: 53
    - protocol: UDP
      port: 53
  - to:
    - podSelector:
        matchLabels:
          app: postgres
    ports:
    - protocol: TCP
      port: 5432
  - to:
    - podSelector:
        matchLabels:
          app: redis
    ports:
    - protocol: TCP
      port: 6379
```

## Troubleshooting Guide

### Common Issues and Solutions

```bash
#!/bin/bash
# wasm-troubleshooting.sh

# Function to check Krustlet node status
check_krustlet_node() {
    echo "Checking Krustlet node status..."
    kubectl get nodes -l kubernetes.io/arch=wasm32-wasi

    echo -e "\nNode details:"
    kubectl describe node -l kubernetes.io/arch=wasm32-wasi
}

# Function to check WASM pod status
check_wasm_pods() {
    echo "Checking WASM pod status..."
    kubectl get pods -n wasm-apps -o wide

    echo -e "\nPod events:"
    kubectl get events -n wasm-apps --sort-by='.lastTimestamp'
}

# Function to check WASM pod logs
check_wasm_logs() {
    local pod_name="$1"
    echo "Checking logs for pod: $pod_name"
    kubectl logs -n wasm-apps "$pod_name" --tail=100
}

# Function to verify RuntimeClass
check_runtime_class() {
    echo "Checking RuntimeClass configuration..."
    kubectl get runtimeclass
    kubectl describe runtimeclass wasmtime-wasi
}

# Function to test WASM application
test_wasm_app() {
    local service_name="$1"
    echo "Testing WASM application: $service_name"

    # Port forward to test locally
    kubectl port-forward -n wasm-apps svc/$service_name 8080:80 &
    PF_PID=$!
    sleep 2

    # Test endpoints
    echo "Testing health endpoint..."
    curl -f http://localhost:8080/health || echo "Health check failed"

    echo "Testing metrics endpoint..."
    curl -f http://localhost:8080/metrics || echo "Metrics endpoint failed"

    # Cleanup
    kill $PF_PID
}

# Main troubleshooting routine
main() {
    echo "=== WASM Troubleshooting Tool ==="
    echo ""

    check_krustlet_node
    echo ""

    check_runtime_class
    echo ""

    check_wasm_pods
    echo ""

    # Get first pod name for detailed checks
    POD_NAME=$(kubectl get pods -n wasm-apps -l app=wasm-http-server -o jsonpath='{.items[0].metadata.name}')
    if [ -n "$POD_NAME" ]; then
        check_wasm_logs "$POD_NAME"
        echo ""
    fi

    test_wasm_app "wasm-http-server"
}

main
```

## Conclusion

WebAssembly in Kubernetes with Krustlet represents a significant evolution in cloud-native application deployment. By combining WASM's performance characteristics, security model, and portability with Kubernetes' orchestration capabilities, organizations can achieve:

- **Faster startup times** (10-100x improvement over containers)
- **Smaller resource footprint** (50-90% reduction in memory usage)
- **Enhanced security** through capability-based sandboxing
- **True portability** across architectures and platforms
- **Simplified operations** with consistent deployment patterns

As the WebAssembly ecosystem matures and tooling improves, WASM workloads will become increasingly prevalent in production Kubernetes environments, particularly for edge computing, serverless functions, and microservices that require extreme performance and security.

This guide has provided the foundation for implementing WebAssembly workloads in production Kubernetes clusters using Krustlet, including deployment patterns, monitoring strategies, security configurations, and operational best practices. Organizations adopting this technology early will gain significant competitive advantages in performance, cost efficiency, and security posture.