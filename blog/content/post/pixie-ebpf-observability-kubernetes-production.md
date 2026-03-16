---
title: "Pixie eBPF Observability Platform: Zero-Instrumentation Kubernetes Monitoring with Auto-Telemetry"
date: 2026-10-19T00:00:00-05:00
draft: false
tags: ["Pixie", "eBPF", "Kubernetes", "Observability", "Zero-Instrumentation", "Auto-Telemetry", "Performance"]
categories: ["Observability", "Kubernetes", "eBPF"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to deploying Pixie for zero-instrumentation Kubernetes observability using eBPF, providing automatic telemetry collection without code changes."
more_link: "yes"
url: "/pixie-ebpf-observability-kubernetes-production/"
---

Pixie leverages eBPF technology to provide zero-instrumentation observability for Kubernetes clusters, automatically collecting telemetry data without requiring code changes or manual instrumentation. This guide covers production deployment, use cases, and integration with existing observability stacks for comprehensive cluster visibility.

<!--more-->

# Pixie eBPF Observability Platform

## Executive Summary

Pixie uses eBPF (extended Berkeley Packet Filter) to provide instant, zero-instrumentation observability for Kubernetes applications. It automatically captures application-level metrics, distributed traces, and network traffic without requiring code changes, making it ideal for rapid troubleshooting and continuous monitoring.

## Pixie Installation

```bash
# Install Pixie CLI
bash -c "$(curl -fsSL https://withpixie.ai/install.sh)"

# Deploy to Kubernetes cluster
px deploy

# Or with specific configuration
px deploy --cluster_name=production --cloud_addr=withpixie.ai:443
```

## Production Deployment

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: pl
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: pixie-pem
  namespace: pl
spec:
  selector:
    matchLabels:
      name: pixie-pem
  template:
    metadata:
      labels:
        name: pixie-pem
    spec:
      hostNetwork: true
      hostPID: true
      tolerations:
      - effect: NoSchedule
        operator: Exists
      containers:
      - name: pem
        image: gcr.io/pixie-oss/pixie-prod/pem/pem_image:latest
        securityContext:
          privileged: true
          capabilities:
            add:
            - SYS_ADMIN
            - SYS_PTRACE
            - SYS_RESOURCE
        volumeMounts:
        - name: sys
          mountPath: /sys
          readOnly: true
        - name: cgroup
          mountPath: /sys/fs/cgroup
        resources:
          requests:
            memory: "2Gi"
            cpu: "1000m"
          limits:
            memory: "4Gi"
            cpu: "2000m"
      volumes:
      - name: sys
        hostPath:
          path: /sys
      - name: cgroup
        hostPath:
          path: /sys/fs/cgroup
```

## PxL Scripts for Observability

```python
# HTTP request latency by service
import px

df = px.DataFrame('http_events')
df = df[df.ctx['service'] != '']
df.latency_ms = df.latency_ns / 1000000
df = df.groupby(['service', 'req_path']).agg(
    latency_p50=('latency_ms', px.quantiles(0.50)),
    latency_p99=('latency_ms', px.quantiles(0.99)),
    requests=('latency_ms', px.count)
)
px.display(df, 'http_latency_table')

# Database query performance
df = px.DataFrame('mysql_events')
df.latency_ms = df.latency_ns / 1000000
df = df[df.latency_ms > 100]  # slow queries
df = df.groupby(['query_cmd', 'normalized_query']).agg(
    avg_latency=('latency_ms', px.mean),
    count=('latency_ms', px.count)
)
px.display(df, 'slow_queries')
```

## Integration with Prometheus

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-pixie-config
data:
  prometheus.yml: |
    scrape_configs:
    - job_name: 'pixie'
      kubernetes_sd_configs:
      - role: pod
        namespaces:
          names:
          - pl
      relabel_configs:
      - source_labels: [__meta_kubernetes_pod_label_name]
        action: keep
        regex: pixie-.*
      - source_labels: [__meta_kubernetes_pod_name]
        target_label: pod
```

## Use Cases

1. **Instant HTTP/gRPC tracing** without instrumentation
2. **Database query monitoring** (MySQL, PostgreSQL, Redis)
3. **Network flow analysis** and service maps
4. **DNS query monitoring**
5. **CPU/Memory profiling** at runtime
6. **SSL/TLS certificate monitoring**
7. **Kafka message tracing**

## Best Practices

1. **Monitor PEM resource usage** on nodes
2. **Configure appropriate data retention**
3. **Use PxL scripts** for custom analytics
4. **Integrate with existing observability**
5. **Implement RBAC** for access control
6. **Regular updates** for eBPF improvements
7. **Test in non-production** first
8. **Monitor kernel compatibility**
9. **Configure alerts** on anomalies
10. **Document custom scripts**

## Conclusion

Pixie provides powerful zero-instrumentation observability for Kubernetes using eBPF, enabling instant visibility into application behavior without code changes, making it ideal for rapid troubleshooting and continuous monitoring.
