---
title: "Pyroscope: Continuous Profiling for Kubernetes Production Workloads"
date: 2027-01-02T00:00:00-05:00
draft: false
tags: ["Pyroscope", "Profiling", "Kubernetes", "Observability", "Performance"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide for deploying Grafana Pyroscope on Kubernetes for always-on continuous profiling of Go, Java, Python, and Ruby workloads with Grafana integration."
more_link: "yes"
url: "/pyroscope-continuous-profiling-kubernetes-production-guide/"
---

Production systems are difficult to debug because performance regressions rarely appear in staging. CPU spikes, memory bloat, and unexpected latency often manifest only under real traffic patterns with real data volumes. Traditional **continuous profiling** fills the gap between metrics (which tell you something is wrong) and traces (which show you which requests are slow) by revealing exactly which functions consume CPU and memory over time — not just during an incident, but always.

**Grafana Pyroscope** (formerly Phlare, merged with the original Pyroscope project) provides always-on, low-overhead profiling that integrates directly into the Grafana observability stack. Unlike point-in-time profilers attached during incidents, Pyroscope collects profiles continuously at a configurable sample rate, stores them efficiently with delta compression and columnar storage, and makes them queryable alongside metrics and traces in Grafana dashboards.

This guide covers a production-grade Pyroscope deployment on Kubernetes including S3-backed storage, auto-instrumentation via Grafana Alloy, native SDK integration for Go, Java, Python, and Ruby, and correlating profiles with distributed traces for root-cause analysis.

<!--more-->

## Why Continuous Profiling vs Point-in-Time Profilers

Traditional profilers (pprof, async-profiler, py-spy) are attached on demand when an issue is already known. This creates a fundamental problem: the act of attaching a profiler changes system behavior, the problematic workload pattern may not reproduce on demand, and critical evidence of what caused a past incident is gone.

Continuous profiling solves the **Heisenberg problem** by collecting at low constant overhead (typically 1-3% CPU) rather than at high overhead only when requested. The overhead model is fundamentally different: Pyroscope uses **sampling-based profiling** where stack traces are captured at a fixed rate (default: 100 Hz) rather than instrumenting every function call.

The resulting data model enables questions that traditional profilers cannot answer:

- "Which function was consuming the most CPU last Tuesday between 14:00 and 14:30 during the incident?"
- "Has our P99 CPU profile changed between version 2.1.4 and 2.1.5?"
- "Which service is responsible for the 40% CPU increase after the deployment at 09:15?"

### Pyroscope vs Competitors

**Pyroscope** stores profiles in a columnar format using Parquet-like encoding with delta compression, achieving 50-100x compression ratios over raw pprof files. Alternative solutions include Elastic APM profiling (requires Elastic stack), Datadog Continuous Profiler (SaaS, per-host pricing), and Google Cloud Profiler (GCP-only). Pyroscope's open-source model with S3 backend makes it cost-effective at scale.

## Pyroscope Architecture

Pyroscope follows a **monolithic-to-microservices** design similar to Grafana Loki and Mimir. In production, components run as separate deployments scaled independently; in small clusters, the all-in-one mode simplifies operations.

The key components are:

- **Distributor**: Receives profile writes from agents, validates, and fans out to ingesters
- **Ingester**: Buffers profiles in memory and flushes to object storage
- **Querier**: Executes read queries, merging data from ingesters and store-gateways
- **Store-Gateway**: Serves profiles from object storage with block caching
- **Compactor**: Merges and compacts blocks in object storage for efficient querying
- **Query-Frontend**: Splits and caches queries, provides HTTP API

Profile data flows through the write path: `Agent -> Distributor -> Ingester -> Object Storage (S3)`. Queries flow through: `Grafana -> Query-Frontend -> Querier -> (Ingester | Store-Gateway)`.

```
                    ┌─────────────┐
                    │   Grafana   │
                    └──────┬──────┘
                           │ HTTP
                    ┌──────▼──────┐
                    │Query-Frontend│
                    └──────┬──────┘
                           │
               ┌───────────▼───────────┐
               │        Querier        │
               └──────┬──────────┬─────┘
                      │          │
           ┌──────────▼──┐  ┌────▼──────────┐
           │  Ingester    │  │ Store-Gateway │
           └──────┬──────┘  └──────┬────────┘
                  │                │
           ┌──────▼────────────────▼──┐
           │         S3 / GCS         │
           └──────────────────────────┘
                      ▲
           ┌──────────┴──────────┐
           │      Distributor    │
           └──────────┬──────────┘
                      ▲
           ┌──────────┴──────────┐
           │   Grafana Alloy /   │
           │   Language SDKs     │
           └─────────────────────┘
```

## Helm Deployment with S3 Backend

The official Grafana Helm chart deploys Pyroscope in microservices mode. The following values configure a production deployment with S3-backed storage, appropriate resource requests, and anti-affinity rules.

First, add the Grafana Helm repository and create the namespace:

```bash
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update
kubectl create namespace pyroscope
```

Create the S3 credentials secret. Use IRSA in EKS rather than static credentials whenever possible:

```bash
kubectl create secret generic pyroscope-s3-credentials \
  --namespace pyroscope \
  --from-literal=AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE \
  --from-literal=AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
```

Create `pyroscope-values.yaml`:

```yaml
pyroscope:
  structuredConfig:
    storage:
      backend: s3
      s3:
        bucket_name: prod-pyroscope-profiles
        endpoint: s3.us-east-1.amazonaws.com
        region: us-east-1
        access_key_id: ""        # injected via envFrom
        secret_access_key: ""    # injected via envFrom
        insecure: false

    limits:
      max_query_lookback: 30d
      max_query_range: 7d
      ingestion_rate_limit_mb: 64
      ingestion_burst_size_mb: 128

    compactor:
      sharding_enabled: true
      ring:
        kvstore:
          store: memberlist

    ingester:
      lifecycler:
        ring:
          kvstore:
            store: memberlist
          replication_factor: 3

    distributor:
      ring:
        kvstore:
          store: memberlist

# Component-specific overrides
distributor:
  replicaCount: 2
  resources:
    requests:
      cpu: 250m
      memory: 256Mi
    limits:
      cpu: 1000m
      memory: 512Mi
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app.kubernetes.io/component: distributor
          topologyKey: kubernetes.io/hostname

ingester:
  replicaCount: 3
  resources:
    requests:
      cpu: 500m
      memory: 1Gi
    limits:
      cpu: 2000m
      memory: 4Gi
  persistence:
    enabled: true
    size: 20Gi
    storageClass: gp3
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app.kubernetes.io/component: ingester
          topologyKey: kubernetes.io/hostname

querier:
  replicaCount: 2
  resources:
    requests:
      cpu: 250m
      memory: 512Mi
    limits:
      cpu: 1000m
      memory: 2Gi

queryFrontend:
  replicaCount: 2
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 512Mi

storeGateway:
  replicaCount: 2
  resources:
    requests:
      cpu: 250m
      memory: 512Mi
    limits:
      cpu: 1000m
      memory: 2Gi
  persistence:
    enabled: true
    size: 10Gi
    storageClass: gp3

compactor:
  replicaCount: 1
  resources:
    requests:
      cpu: 250m
      memory: 512Mi
    limits:
      cpu: 1000m
      memory: 2Gi
  persistence:
    enabled: true
    size: 10Gi
    storageClass: gp3

serviceAccount:
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/pyroscope-s3-role

minio:
  enabled: false
```

Deploy with Helm:

```bash
helm upgrade --install pyroscope grafana/pyroscope \
  --namespace pyroscope \
  --version 1.7.0 \
  --values pyroscope-values.yaml \
  --wait \
  --timeout 10m
```

Verify all pods are running:

```bash
kubectl get pods -n pyroscope -l app.kubernetes.io/name=pyroscope
```

## Auto-Instrumentation via Grafana Alloy

**Grafana Alloy** (the successor to Grafana Agent) provides zero-code-change profiling through eBPF-based and language-specific profilers deployed as a DaemonSet. Alloy's `pyroscope.ebpf` component captures CPU profiles for any process without requiring application changes, while `pyroscope.java` attaches async-profiler to JVM processes.

The following Alloy configuration file (`alloy-config.alloy`) enables multi-language auto-discovery:

```hcl
// alloy-config.alloy — Grafana Alloy configuration for auto-profiling

// Discover all Kubernetes pods for profiling targets
discovery.kubernetes "pods" {
  role = "pod"
}

// Relabel discovered pods to extract useful metadata
discovery.relabel "profiling_targets" {
  targets = discovery.kubernetes.pods.targets

  // Drop pods that explicitly opt out of profiling
  rule {
    source_labels = ["__meta_kubernetes_pod_annotation_pyroscope_io_scrape"]
    regex         = "false"
    action        = "drop"
  }

  // Keep pod namespace and name as labels
  rule {
    source_labels = ["__meta_kubernetes_namespace"]
    target_label  = "namespace"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_name"]
    target_label  = "pod"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_label_app"]
    target_label  = "app"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_node_name"]
    target_label  = "node"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_container_name"]
    target_label  = "container"
  }
}

// eBPF-based CPU profiling — works for any language without code changes
pyroscope.ebpf "node_cpu" {
  forward_to     = [pyroscope.write.default.receiver]
  targets        = discovery.relabel.profiling_targets.output
  demangle       = "full"
  python_enabled = true
}

// Java async-profiler — attaches to JVM processes
pyroscope.java "java_workloads" {
  forward_to = [pyroscope.write.default.receiver]
  targets    = discovery.relabel.profiling_targets.output

  profiling_config {
    interval        = "60s"
    cpu             = true
    alloc           = "512k"
    lock            = "10ms"
    sample_rate     = 100
  }
}

// Write profiles to Pyroscope
pyroscope.write "default" {
  endpoint {
    url = "http://pyroscope-query-frontend.pyroscope.svc.cluster.local:4040"
  }

  external_labels = {
    cluster     = "prod-us-east-1",
    environment = "production",
  }
}
```

Deploy Alloy as a DaemonSet with the configuration:

```yaml
# alloy-daemonset-values.yaml
alloy:
  configMap:
    content: |
      // Paste the alloy-config.alloy content here

  securityContext:
    privileged: true     # Required for eBPF

  mounts:
    varlog:
      enabled: true
    dockercontainers:
      enabled: true

controller:
  type: daemonset
  tolerations:
    - effect: NoSchedule
      operator: Exists

serviceAccount:
  create: true
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/alloy-profiling-role
```

```bash
helm upgrade --install alloy grafana/alloy \
  --namespace monitoring \
  --values alloy-daemonset-values.yaml
```

## Go SDK Integration

For Go services, the **Pyroscope Go SDK** provides the most accurate profiling because it hooks directly into the Go runtime's profiling infrastructure (`runtime/pprof`). The SDK collects CPU, memory (heap), goroutine, mutex, and block profiles.

Install the SDK:

```bash
go get github.com/grafana/pyroscope-go
```

Integrate into the application entry point:

```go
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"runtime"

	pyroscope "github.com/grafana/pyroscope-go"
)

func initProfiling(serviceName, serviceVersion string) (*pyroscope.Profiler, error) {
	// Enable mutex and block profiling — off by default in Go runtime
	runtime.SetMutexProfileFraction(5)
	runtime.SetBlockProfileRate(5)

	pyroscopeURL := os.Getenv("PYROSCOPE_URL")
	if pyroscopeURL == "" {
		pyroscopeURL = "http://pyroscope-query-frontend.pyroscope.svc.cluster.local:4040"
	}

	profiler, err := pyroscope.Start(pyroscope.Config{
		ApplicationName: serviceName,
		ServerAddress:   pyroscopeURL,

		// Profile types to collect
		ProfileTypes: []pyroscope.ProfileType{
			pyroscope.ProfileCPU,
			pyroscope.ProfileAllocObjects,
			pyroscope.ProfileAllocSpace,
			pyroscope.ProfileInuseObjects,
			pyroscope.ProfileInuseSpace,
			pyroscope.ProfileGoroutines,
			pyroscope.ProfileMutexCount,
			pyroscope.ProfileMutexDuration,
			pyroscope.ProfileBlockCount,
			pyroscope.ProfileBlockDuration,
		},

		// Static labels attached to all profiles from this instance
		Tags: map[string]string{
			"version":     serviceVersion,
			"environment": os.Getenv("ENVIRONMENT"),
			"region":      os.Getenv("AWS_REGION"),
			"pod":         os.Getenv("POD_NAME"),     // from Kubernetes downward API
			"namespace":   os.Getenv("POD_NAMESPACE"),
		},

		Logger: pyroscope.StandardLogger,
	})
	if err != nil {
		return nil, fmt.Errorf("starting pyroscope profiler: %w", err)
	}

	return profiler, nil
}

func main() {
	profiler, err := initProfiling("order-service", "2.4.1")
	if err != nil {
		slog.Error("profiling initialization failed", "error", err)
		// Non-fatal: continue without profiling rather than failing the service
	}
	if profiler != nil {
		defer profiler.Stop()
	}

	http.ListenAndServe(":8080", buildRouter())
}
```

For dynamic labels (labeling profiles by request attributes), use the **tag wrapper**:

```go
import (
	"context"
	pyroscope "github.com/grafana/pyroscope-go"
)

// processOrder labels the CPU profile with the order type while this function runs.
// This enables filtering flame graphs by business dimension in Grafana.
func processOrder(ctx context.Context, orderID string, orderType string) error {
	return pyroscope.TagWrapper(ctx, pyroscope.Labels{
		"order_type": orderType,
		"handler":    "process_order",
	}, func(ctx context.Context) error {
		return doProcessOrder(ctx, orderID)
	})
}
```

The `TagWrapper` approach is particularly valuable for multi-tenant services where you want to understand which tenant drives CPU consumption without deploying separate instances.

## Java async-profiler Configuration

For JVM workloads, Pyroscope uses **async-profiler** under the hood, which is a low-overhead sampling profiler that does not require safepoints, avoiding the well-known JVM safepoint bias problem that afflicts older Java profilers.

The Java agent approach requires adding a JVM argument:

```bash
# Dockerfile or Kubernetes container args
JAVA_TOOL_OPTIONS="-javaagent:/opt/pyroscope/pyroscope.jar"
```

```yaml
# Kubernetes deployment environment variables for Java service
env:
  - name: PYROSCOPE_APPLICATION_NAME
    value: "payment-service"
  - name: PYROSCOPE_SERVER_ADDRESS
    value: "http://pyroscope-query-frontend.pyroscope.svc.cluster.local:4040"
  - name: PYROSCOPE_PROFILER_EVENT
    value: "cpu"
  - name: PYROSCOPE_PROFILER_ALLOC
    value: "512k"
  - name: PYROSCOPE_PROFILER_LOCK
    value: "10ms"
  - name: PYROSCOPE_FORMAT
    value: "jfr"
  - name: PYROSCOPE_LABELS
    value: "version=3.1.0,environment=production"
  - name: POD_NAME
    valueFrom:
      fieldRef:
        fieldPath: metadata.name
  - name: POD_NAMESPACE
    valueFrom:
      fieldRef:
        fieldPath: metadata.namespace
```

For Spring Boot applications, add the pyroscope starter which handles agent initialization and integrates with Spring's application context lifecycle:

```xml
<!-- pom.xml -->
<dependency>
    <groupId>io.pyroscope</groupId>
    <artifactId>agent</artifactId>
    <version>0.12.0</version>
</dependency>
```

```java
// PyroscopeConfiguration.java
package com.example.payment;

import io.pyroscope.javaagent.PyroscopeAgent;
import io.pyroscope.javaagent.config.Config;
import io.pyroscope.javaagent.EventType;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class PyroscopeConfiguration {

    @Value("${pyroscope.server.address:http://pyroscope-query-frontend.pyroscope.svc.cluster.local:4040}")
    private String serverAddress;

    @Value("${spring.application.name}")
    private String applicationName;

    @Bean
    public PyroscopeAgent.SessionSettings pyroscopeSettings() {
        Config config = Config.builder()
            .setApplicationName(applicationName)
            .setProfilingEvent(EventType.ITIMER)
            .setProfilingAlloc("512k")
            .setProfilingLock("10ms")
            .setServerAddress(serverAddress)
            .setLabels(Map.of(
                "version", BuildInfo.VERSION,
                "environment", System.getenv("ENVIRONMENT")
            ))
            .build();

        PyroscopeAgent.start(config);
        return PyroscopeAgent.getSessionSettings();
    }
}
```

## Python and Ruby SDKs

### Python Integration

The Python SDK uses `py-spy` under the hood for native thread profiling and also supports async profiling for `asyncio`-based workloads (FastAPI, aiohttp).

```bash
pip install pyroscope-io
```

```python
# profiling.py
import os
import pyroscope

def configure_profiling(app_name: str, version: str) -> None:
    """Configure Pyroscope continuous profiling for Python services."""
    pyroscope_url = os.environ.get(
        "PYROSCOPE_URL",
        "http://pyroscope-query-frontend.pyroscope.svc.cluster.local:4040"
    )

    pyroscope.configure(
        application_name=app_name,
        server_address=pyroscope_url,
        sample_rate=100,       # samples per second
        detect_subprocesses=False,
        oncpu=True,
        gil_only=False,        # profile threads blocked on I/O as well
        enable_logging=True,
        tags={
            "version": version,
            "environment": os.environ.get("ENVIRONMENT", "production"),
            "pod": os.environ.get("POD_NAME", "unknown"),
            "region": os.environ.get("AWS_REGION", "us-east-1"),
        }
    )
```

For FastAPI, initialize profiling at startup:

```python
# main.py
from contextlib import asynccontextmanager
from fastapi import FastAPI
import pyroscope
from profiling import configure_profiling

@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_profiling("recommendation-service", "1.8.3")
    yield
    pyroscope.shutdown()

app = FastAPI(lifespan=lifespan)

# Tag individual request handlers for drill-down
@app.get("/recommendations/{user_id}")
async def get_recommendations(user_id: str, category: str = "all"):
    with pyroscope.tag_wrapper({"handler": "get_recommendations", "category": category}):
        return await recommendation_engine.get(user_id, category)
```

### Ruby Integration

```bash
gem install pyroscope
```

```ruby
# config/initializers/pyroscope.rb
require 'pyroscope'

Pyroscope.configure do |config|
  config.application_name = 'catalog-service'
  config.server_address   = ENV.fetch(
    'PYROSCOPE_URL',
    'http://pyroscope-query-frontend.pyroscope.svc.cluster.local:4040'
  )
  config.log_level        = Logger::INFO
  config.tags             = {
    version:     ENV.fetch('APP_VERSION', 'unknown'),
    environment: ENV.fetch('RAILS_ENV', 'production'),
    pod:         ENV.fetch('POD_NAME', 'unknown'),
    region:      ENV.fetch('AWS_REGION', 'us-east-1'),
  }
end
```

Tag individual controller actions:

```ruby
# app/controllers/products_controller.rb
class ProductsController < ApplicationController
  def index
    Pyroscope.tag_wrapper({ handler: 'products#index', locale: I18n.locale.to_s }) do
      @products = Product.published.includes(:variants).page(params[:page])
    end
  end
end
```

## Flame Graph Interpretation

A **flame graph** represents stack traces where the x-axis is the percentage of samples (not time), the y-axis is stack depth (callee on top of caller), and width represents how much CPU time that frame consumed across all samples.

Key interpretation rules:

- **Wide frames at the top** of the call tree indicate hot leaf functions — the primary optimization targets
- **Wide frames in the middle** indicate a common ancestor for many different code paths — optimizing these has multiplicative effect
- **Plateaus** (flat tops) indicate functions that call many different callees — useful context, not a target
- **Narrow spikes** indicate infrequent but deep call paths — often not worth optimizing unless they appear in P99

When comparing two profiles (diff flame graphs), **red frames** indicate increased CPU consumption in the newer profile, and **blue frames** indicate decreased consumption. This is invaluable for deployment comparisons.

```
Example flame graph reading:
─────────────────────────────────────────────────────────────
main.processOrders [████████████████████████████████] 82%
  ├── db.QueryRows  [████████████████] 42%       <- HOT
  │     └── net/http.(*Transport).roundTrip [████████████] 38%
  ├── json.Marshal  [████████] 22%               <- HOT
  │     └── encoding/json.marshalValue [████████] 22%
  └── cache.Get     [████] 18%
        └── redis.(*Client).Get [████] 18%
─────────────────────────────────────────────────────────────
```

In this example, 42% of CPU is spent on database calls (network I/O), 22% on JSON marshaling, and 18% on cache lookups. The first optimization target is eliminating redundant database queries with application-level caching.

## Grafana Datasource and Dashboard

Configure the Pyroscope datasource in Grafana:

```yaml
# grafana-datasource-pyroscope.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-datasource-pyroscope
  namespace: monitoring
  labels:
    grafana_datasource: "1"
data:
  pyroscope-datasource.yaml: |
    apiVersion: 1
    datasources:
      - name: Pyroscope
        type: grafana-pyroscope-datasource
        uid: pyroscope
        url: http://pyroscope-query-frontend.pyroscope.svc.cluster.local:4040
        access: proxy
        editable: false
        jsonData:
          timeInterval: "60s"
          keepCookies: []
          httpMethod: GET
```

A minimal Grafana dashboard definition for CPU profiling overview:

```json
{
  "title": "Continuous Profiling Overview",
  "uid": "continuous-profiling",
  "panels": [
    {
      "type": "flamegraph",
      "title": "CPU Flame Graph — Last 15 Minutes",
      "datasource": { "type": "grafana-pyroscope-datasource", "uid": "pyroscope" },
      "targets": [
        {
          "datasource": { "uid": "pyroscope" },
          "labelSelector": "{environment=\"production\"}",
          "profileTypeId": "process_cpu:cpu:nanoseconds:cpu:nanoseconds",
          "queryType": "profile",
          "refId": "A"
        }
      ],
      "gridPos": { "h": 16, "w": 24, "x": 0, "y": 0 }
    },
    {
      "type": "table",
      "title": "Top CPU Consumers by Service",
      "datasource": { "type": "grafana-pyroscope-datasource", "uid": "pyroscope" },
      "targets": [
        {
          "datasource": { "uid": "pyroscope" },
          "labelSelector": "{environment=\"production\"}",
          "profileTypeId": "process_cpu:cpu:nanoseconds:cpu:nanoseconds",
          "queryType": "metrics",
          "groupBy": ["app"],
          "refId": "B"
        }
      ],
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 16 }
    }
  ]
}
```

## Correlating Profiles with Traces (Exemplars)

The most powerful feature of Pyroscope in the Grafana stack is **profile-trace correlation**. When a trace span ID is embedded in the profile labels, Grafana Tempo and Pyroscope can link directly between a specific slow trace and the CPU flame graph that explains why it was slow.

For Go services with OpenTelemetry tracing:

```go
package tracing

import (
	"context"

	"go.opentelemetry.io/otel/trace"
	pyroscope "github.com/grafana/pyroscope-go"
)

// ProfiledHandler wraps an HTTP handler to correlate profiles with traces.
// It extracts the active trace span and adds its ID as a profile label,
// enabling Grafana to link from a slow trace directly to its CPU flame graph.
func ProfiledHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		span := trace.SpanFromContext(r.Context())
		spanCtx := span.SpanContext()

		if spanCtx.IsValid() {
			pCtx := pyroscope.TagWrapper(r.Context(), pyroscope.Labels{
				"traceID": spanCtx.TraceID().String(),
				"spanID":  spanCtx.SpanID().String(),
			}, func(ctx context.Context) error {
				next.ServeHTTP(w, r.WithContext(ctx))
				return nil
			})
			_ = pCtx
		} else {
			next.ServeHTTP(w, r)
		}
	})
}
```

In Grafana, the Explore view in Tempo will show a "Profiles" button next to any trace that has matching profile data within the time window, allowing direct navigation from a slow trace to its CPU flame graph.

Configure the Tempo datasource to link to Pyroscope:

```yaml
# In the Tempo datasource configuration
jsonData:
  tracesToProfiles:
    datasourceUid: pyroscope
    profileTypeId: "process_cpu:cpu:nanoseconds:cpu:nanoseconds"
    customQuery: false
    tags:
      - key: service.name
        value: app
```

## Alerting on CPU Regressions

Pyroscope exposes metrics via its `/metrics` endpoint. Use these to alert on profile ingestion failures or storage issues:

```yaml
# prometheus-rules-pyroscope.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: pyroscope-alerts
  namespace: pyroscope
spec:
  groups:
    - name: pyroscope.rules
      interval: 60s
      rules:
        - alert: PyroscopeIngesterNotHealthy
          expr: |
            (
              count(up{job="pyroscope-ingester"} == 1)
              /
              count(up{job="pyroscope-ingester"})
            ) < 0.67
          for: 5m
          labels:
            severity: critical
            team: platform
          annotations:
            summary: "Less than 2/3 of Pyroscope ingesters are healthy"
            description: "{{ $value | humanizePercentage }} of ingesters are up. Profile data may be lost."

        - alert: PyroscopeHighProfileDropRate
          expr: |
            rate(pyroscope_distributor_received_samples_total{status="dropped"}[5m])
            /
            rate(pyroscope_distributor_received_samples_total[5m])
            > 0.05
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Pyroscope is dropping more than 5% of profiles"
            description: "Drop rate: {{ $value | humanizePercentage }}. Check rate limits."

        - alert: PyroscopeCompactorNotRunning
          expr: pyroscope_compactor_runs_completed_total == 0
          for: 1h
          labels:
            severity: warning
          annotations:
            summary: "Pyroscope compactor has not run in 1 hour"
```

## Conclusion

Grafana Pyroscope provides production teams with the final layer of the observability triangle — always-on profiling that reveals not just that a service is slow, but which specific functions are responsible. Key takeaways from this guide:

- Deploy Pyroscope in microservices mode with an S3 backend for production; the all-in-one mode is suitable only for development clusters with small data volumes
- Use Grafana Alloy's eBPF profiler for zero-code-change coverage across all languages, supplemented by native SDKs for richer profiling types (heap, goroutines, mutex)
- The Go SDK's `TagWrapper` and Python/Ruby equivalents enable business-dimension profiling that makes CPU attribution actionable (e.g., "tenant X consumes 60% of CPU")
- Profile-trace correlation via span ID labels is the highest-value integration — it eliminates the gap between "this trace was slow" and "this function caused it"
- Start with CPU profiling, then add allocation profiling once CPU hot paths are understood; allocation profiling is where GC pressure and memory leaks become visible
