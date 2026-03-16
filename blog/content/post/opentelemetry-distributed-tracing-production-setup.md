---
title: "OpenTelemetry Distributed Tracing: Production Setup and Best Practices for Enterprise Microservices"
date: 2026-10-17T00:00:00-05:00
draft: false
tags: ["OpenTelemetry", "Distributed Tracing", "Observability", "Microservices", "Kubernetes", "Performance", "Monitoring"]
categories: ["Observability", "Monitoring", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to implementing OpenTelemetry distributed tracing in production environments with Kubernetes, including auto-instrumentation, sampling strategies, and performance optimization."
more_link: "yes"
url: "/opentelemetry-distributed-tracing-production-setup/"
---

Implementing distributed tracing in complex microservices environments requires a robust, vendor-neutral solution that can scale with your infrastructure. OpenTelemetry has emerged as the industry standard for observability, providing a unified approach to traces, metrics, and logs. This comprehensive guide covers production-grade OpenTelemetry deployment strategies for enterprise Kubernetes environments.

<!--more-->

# OpenTelemetry Distributed Tracing: Production Setup and Best Practices

## Executive Summary

OpenTelemetry (OTel) is the CNCF's observability framework that provides vendor-neutral instrumentation for distributed tracing, metrics, and logs. This guide demonstrates how to deploy and configure OpenTelemetry in production Kubernetes clusters, covering collector architecture, auto-instrumentation, sampling strategies, and performance optimization for enterprise-scale deployments.

## Understanding OpenTelemetry Architecture

### Core Components

OpenTelemetry consists of several key components that work together to provide comprehensive observability:

1. **Instrumentation Libraries**: SDKs for various programming languages
2. **OpenTelemetry Collector**: Receives, processes, and exports telemetry data
3. **Exporters**: Send data to observability backends (Jaeger, Zipkin, Prometheus, etc.)
4. **Context Propagation**: Maintains trace context across service boundaries
5. **Auto-instrumentation**: Automatic instrumentation for supported frameworks

### Collector Architecture Patterns

**Agent Pattern (Sidecar)**:
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: otel-agent-config
  namespace: observability
data:
  otel-agent-config.yaml: |
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
          http:
            endpoint: 0.0.0.0:4318

      # Collect host metrics
      hostmetrics:
        collection_interval: 30s
        scrapers:
          cpu:
          memory:
          disk:
          network:
          filesystem:

      # Kubernetes attributes
      k8s_cluster:
        auth_type: serviceAccount
        node: ${K8S_NODE_NAME}

    processors:
      # Batch processor for efficiency
      batch:
        timeout: 10s
        send_batch_size: 1024
        send_batch_max_size: 2048

      # Memory limiter to prevent OOM
      memory_limiter:
        check_interval: 1s
        limit_mib: 512
        spike_limit_mib: 128

      # Resource detection
      resourcedetection/docker:
        detectors: [env, docker]
        timeout: 5s
        override: false

      # K8s attributes processor
      k8sattributes:
        auth_type: "serviceAccount"
        passthrough: false
        extract:
          metadata:
            - k8s.namespace.name
            - k8s.deployment.name
            - k8s.statefulset.name
            - k8s.daemonset.name
            - k8s.cronjob.name
            - k8s.job.name
            - k8s.node.name
            - k8s.pod.name
            - k8s.pod.uid
            - k8s.pod.start_time
          labels:
            - tag_name: app.label.component
              key: app.kubernetes.io/component
              from: pod
        pod_association:
          - sources:
              - from: resource_attribute
                name: k8s.pod.ip
          - sources:
              - from: resource_attribute
                name: k8s.pod.uid
          - sources:
              - from: connection

      # Tail sampling decisions
      probabilistic_sampler:
        sampling_percentage: 10

      # Span metrics generation
      spanmetrics:
        metrics_exporter: prometheus
        latency_histogram_buckets: [2ms, 4ms, 6ms, 8ms, 10ms, 50ms, 100ms, 200ms, 400ms, 800ms, 1s, 1400ms, 2s, 5s, 10s, 15s]
        dimensions:
          - name: http.method
            default: GET
          - name: http.status_code
        dimensions_cache_size: 1000
        aggregation_temporality: "AGGREGATION_TEMPORALITY_CUMULATIVE"

    exporters:
      # Send to collector gateway
      otlp:
        endpoint: otel-collector.observability.svc.cluster.local:4317
        tls:
          insecure: false
          ca_file: /etc/otel/certs/ca.crt
          cert_file: /etc/otel/certs/tls.crt
          key_file: /etc/otel/certs/tls.key
        sending_queue:
          enabled: true
          num_consumers: 10
          queue_size: 5000
        retry_on_failure:
          enabled: true
          initial_interval: 5s
          max_interval: 30s
          max_elapsed_time: 300s

      # Debug logging
      logging:
        loglevel: info
        sampling_initial: 5
        sampling_thereafter: 200

    extensions:
      health_check:
        endpoint: :13133
      pprof:
        endpoint: :1777
      zpages:
        endpoint: :55679

    service:
      extensions: [health_check, pprof, zpages]
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, resourcedetection/docker, k8sattributes, spanmetrics, probabilistic_sampler, batch]
          exporters: [otlp, logging]
        metrics:
          receivers: [otlp, hostmetrics]
          processors: [memory_limiter, resourcedetection/docker, k8sattributes, batch]
          exporters: [otlp]
      telemetry:
        logs:
          level: info
        metrics:
          address: :8888
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: otel-agent
  namespace: observability
  labels:
    app: otel-agent
spec:
  selector:
    matchLabels:
      app: otel-agent
  template:
    metadata:
      labels:
        app: otel-agent
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8888"
        prometheus.io/path: "/metrics"
    spec:
      serviceAccountName: otel-agent
      containers:
      - name: otel-agent
        image: otel/opentelemetry-collector-contrib:0.91.0
        args:
          - --config=/conf/otel-agent-config.yaml
        env:
        - name: K8S_NODE_NAME
          valueFrom:
            fieldRef:
              fieldPath: spec.nodeName
        - name: POD_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace
        - name: GOMEMLIMIT
          value: "460MiB"
        ports:
        - containerPort: 4317
          name: otlp-grpc
          protocol: TCP
        - containerPort: 4318
          name: otlp-http
          protocol: TCP
        - containerPort: 8888
          name: metrics
          protocol: TCP
        - containerPort: 13133
          name: health
          protocol: TCP
        volumeMounts:
        - name: otel-agent-config
          mountPath: /conf
        - name: otel-certs
          mountPath: /etc/otel/certs
          readOnly: true
        resources:
          requests:
            memory: "256Mi"
            cpu: "100m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /
            port: 13133
          initialDelaySeconds: 10
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /
            port: 13133
          initialDelaySeconds: 5
          periodSeconds: 5
      volumes:
      - name: otel-agent-config
        configMap:
          name: otel-agent-config
          items:
          - key: otel-agent-config.yaml
            path: otel-agent-config.yaml
      - name: otel-certs
        secret:
          secretName: otel-tls-certs
```

**Gateway Pattern (Deployment)**:
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: otel-collector-config
  namespace: observability
data:
  otel-collector-config.yaml: |
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
            max_recv_msg_size_mib: 32
            max_concurrent_streams: 100
            read_buffer_size: 512
            write_buffer_size: 512
            keepalive:
              server_parameters:
                max_connection_idle: 11s
                max_connection_age: 12s
                max_connection_age_grace: 13s
                time: 30s
                timeout: 5s
              enforcement_policy:
                min_time: 10s
                permit_without_stream: true
          http:
            endpoint: 0.0.0.0:4318
            cors:
              allowed_origins:
                - http://*
                - https://*

    processors:
      batch:
        timeout: 10s
        send_batch_size: 2048
        send_batch_max_size: 4096

      memory_limiter:
        check_interval: 1s
        limit_percentage: 75
        spike_limit_percentage: 20

      # Tail-based sampling for intelligent trace sampling
      tail_sampling:
        decision_wait: 10s
        num_traces: 100000
        expected_new_traces_per_sec: 1000
        policies:
          # Always sample errors
          - name: errors-policy
            type: status_code
            status_code:
              status_codes: [ERROR]

          # Sample slow traces
          - name: slow-traces-policy
            type: latency
            latency:
              threshold_ms: 1000

          # Sample specific services at higher rate
          - name: critical-services-policy
            type: and
            and:
              and_sub_policy:
                - name: service-name-policy
                  type: string_attribute
                  string_attribute:
                    key: service.name
                    values: [payment-service, auth-service]
                    enabled_regex_matching: true
                - name: probabilistic-policy
                  type: probabilistic
                  probabilistic:
                    sampling_percentage: 50

          # Default sampling for everything else
          - name: default-policy
            type: probabilistic
            probabilistic:
              sampling_percentage: 5

      # Resource attributes
      resource:
        attributes:
          - key: cluster.name
            value: production-us-east-1
            action: upsert
          - key: environment
            value: production
            action: upsert

      # Transform and filter spans
      transform:
        trace_statements:
          - context: span
            statements:
              # Mask sensitive data in URLs
              - replace_pattern(attributes["http.url"], "password=([^&]*)", "password=***")
              - replace_pattern(attributes["http.url"], "token=([^&]*)", "token=***")
              # Add custom attributes
              - set(attributes["processed_by"], "otel-collector")

      # Group by trace ID for tail sampling
      groupbytrace:
        wait_duration: 10s
        num_traces: 100000
        num_workers: 10

    exporters:
      # Export to Jaeger
      otlp/jaeger:
        endpoint: jaeger-collector.observability.svc.cluster.local:4317
        tls:
          insecure: false
        sending_queue:
          enabled: true
          num_consumers: 20
          queue_size: 10000
        retry_on_failure:
          enabled: true
          initial_interval: 5s
          max_interval: 30s
          max_elapsed_time: 300s

      # Export to Tempo
      otlp/tempo:
        endpoint: tempo-distributor.observability.svc.cluster.local:4317
        tls:
          insecure: true
        sending_queue:
          enabled: true
          num_consumers: 20
          queue_size: 10000

      # Export metrics to Prometheus
      prometheusremotewrite:
        endpoint: http://prometheus.observability.svc.cluster.local:9090/api/v1/write
        resource_to_telemetry_conversion:
          enabled: true
        tls:
          insecure: true

      # Export to S3 for long-term storage
      awss3:
        s3uploader:
          region: us-east-1
          s3_bucket: traces-archive-prod
          s3_prefix: year=%Y/month=%m/day=%d/
          s3_partition: hour
          compression: gzip
        marshaler: otlp_proto

      # Logging for debugging
      logging:
        loglevel: info
        sampling_initial: 5
        sampling_thereafter: 500

    extensions:
      health_check:
        endpoint: :13133
      pprof:
        endpoint: :1777
      zpages:
        endpoint: :55679

    service:
      extensions: [health_check, pprof, zpages]
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, resource, groupbytrace, tail_sampling, transform, batch]
          exporters: [otlp/jaeger, otlp/tempo, awss3, logging]
        metrics:
          receivers: [otlp]
          processors: [memory_limiter, resource, batch]
          exporters: [prometheusremotewrite]
      telemetry:
        logs:
          level: info
        metrics:
          address: :8888
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: otel-collector
  namespace: observability
  labels:
    app: otel-collector
spec:
  replicas: 3
  selector:
    matchLabels:
      app: otel-collector
  template:
    metadata:
      labels:
        app: otel-collector
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8888"
    spec:
      serviceAccountName: otel-collector
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
                  - otel-collector
              topologyKey: kubernetes.io/hostname
      containers:
      - name: otel-collector
        image: otel/opentelemetry-collector-contrib:0.91.0
        args:
          - --config=/conf/otel-collector-config.yaml
        env:
        - name: GOMEMLIMIT
          value: "1920MiB"
        ports:
        - containerPort: 4317
          name: otlp-grpc
        - containerPort: 4318
          name: otlp-http
        - containerPort: 8888
          name: metrics
        - containerPort: 13133
          name: health
        volumeMounts:
        - name: otel-collector-config
          mountPath: /conf
        resources:
          requests:
            memory: "1Gi"
            cpu: "500m"
          limits:
            memory: "2Gi"
            cpu: "2000m"
        livenessProbe:
          httpGet:
            path: /
            port: 13133
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /
            port: 13133
          initialDelaySeconds: 10
          periodSeconds: 5
      volumes:
      - name: otel-collector-config
        configMap:
          name: otel-collector-config
---
apiVersion: v1
kind: Service
metadata:
  name: otel-collector
  namespace: observability
  labels:
    app: otel-collector
spec:
  type: ClusterIP
  selector:
    app: otel-collector
  ports:
  - name: otlp-grpc
    port: 4317
    targetPort: 4317
    protocol: TCP
  - name: otlp-http
    port: 4318
    targetPort: 4318
    protocol: TCP
  - name: metrics
    port: 8888
    targetPort: 8888
    protocol: TCP
```

## Auto-Instrumentation with OpenTelemetry Operator

### Operator Deployment

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: opentelemetry-operator-system
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: opentelemetry-operator
  namespace: opentelemetry-operator-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: opentelemetry-operator
rules:
- apiGroups: [""]
  resources: [configmaps, pods, namespaces, services]
  verbs: [get, list, watch, create, update, patch, delete]
- apiGroups: [apps]
  resources: [deployments, daemonsets, statefulsets, replicasets]
  verbs: [get, list, watch, create, update, patch, delete]
- apiGroups: [opentelemetry.io]
  resources: [opentelemetrycollectors, instrumentations]
  verbs: [get, list, watch, create, update, patch, delete]
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: opentelemetry-operator
  namespace: opentelemetry-operator-system
spec:
  replicas: 1
  selector:
    matchLabels:
      app: opentelemetry-operator
  template:
    metadata:
      labels:
        app: opentelemetry-operator
    spec:
      serviceAccountName: opentelemetry-operator
      containers:
      - name: operator
        image: ghcr.io/open-telemetry/opentelemetry-operator/opentelemetry-operator:0.91.0
        args:
          - --metrics-addr=:8080
          - --enable-leader-election
          - --zap-log-level=info
        ports:
        - containerPort: 8080
          name: metrics
        - containerPort: 8081
          name: health
        resources:
          requests:
            memory: "128Mi"
            cpu: "100m"
          limits:
            memory: "256Mi"
            cpu: "200m"
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8081
        readinessProbe:
          httpGet:
            path: /readyz
            port: 8081
```

### Auto-Instrumentation Configuration

**Java Applications**:
```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: java-instrumentation
  namespace: production
spec:
  exporter:
    endpoint: http://otel-collector.observability.svc.cluster.local:4318
  propagators:
    - tracecontext
    - baggage
    - b3
  sampler:
    type: parentbased_traceidratio
    argument: "0.25"
  java:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-java:1.32.0
    env:
      - name: OTEL_INSTRUMENTATION_COMMON_EXPERIMENTAL_CONTROLLER_TELEMETRY_ENABLED
        value: "true"
      - name: OTEL_INSTRUMENTATION_COMMON_EXPERIMENTAL_VIEW_TELEMETRY_ENABLED
        value: "true"
      - name: OTEL_INSTRUMENTATION_JDBC_ENABLED
        value: "true"
      - name: OTEL_INSTRUMENTATION_KAFKA_ENABLED
        value: "true"
      - name: OTEL_INSTRUMENTATION_REDIS_ENABLED
        value: "true"
      - name: OTEL_INSTRUMENTATION_SPRING_WEB_ENABLED
        value: "true"
      - name: OTEL_INSTRUMENTATION_SPRING_WEBFLUX_ENABLED
        value: "true"
      - name: OTEL_METRICS_EXPORTER
        value: "otlp"
      - name: OTEL_LOGS_EXPORTER
        value: "otlp"
      - name: OTEL_EXPORTER_OTLP_PROTOCOL
        value: "http/protobuf"
      - name: OTEL_EXPORTER_OTLP_TIMEOUT
        value: "10000"
      - name: OTEL_EXPORTER_OTLP_COMPRESSION
        value: "gzip"
      - name: OTEL_BSP_MAX_QUEUE_SIZE
        value: "2048"
      - name: OTEL_BSP_MAX_EXPORT_BATCH_SIZE
        value: "512"
      - name: OTEL_BSP_SCHEDULE_DELAY
        value: "5000"
      - name: OTEL_RESOURCE_ATTRIBUTES
        value: "service.namespace=production,deployment.environment=production"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: spring-boot-app
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: spring-boot-app
  template:
    metadata:
      labels:
        app: spring-boot-app
      annotations:
        instrumentation.opentelemetry.io/inject-java: "true"
        sidecar.opentelemetry.io/inject: "true"
    spec:
      containers:
      - name: app
        image: myregistry/spring-boot-app:latest
        env:
        - name: JAVA_TOOL_OPTIONS
          value: "-javaagent:/otel-auto-instrumentation/javaagent.jar"
        - name: OTEL_SERVICE_NAME
          value: "spring-boot-app"
        - name: OTEL_RESOURCE_ATTRIBUTES_POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        - name: OTEL_RESOURCE_ATTRIBUTES_NODE_NAME
          valueFrom:
            fieldRef:
              fieldPath: spec.nodeName
        ports:
        - containerPort: 8080
        resources:
          requests:
            memory: "512Mi"
            cpu: "250m"
          limits:
            memory: "1Gi"
            cpu: "1000m"
```

**Python Applications**:
```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: python-instrumentation
  namespace: production
spec:
  exporter:
    endpoint: http://otel-collector.observability.svc.cluster.local:4318
  propagators:
    - tracecontext
    - baggage
  python:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-python:0.43b0
    env:
      - name: OTEL_TRACES_EXPORTER
        value: "otlp"
      - name: OTEL_METRICS_EXPORTER
        value: "otlp"
      - name: OTEL_LOGS_EXPORTER
        value: "otlp"
      - name: OTEL_EXPORTER_OTLP_PROTOCOL
        value: "http/protobuf"
      - name: OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED
        value: "true"
      - name: OTEL_PYTHON_LOG_CORRELATION
        value: "true"
      - name: OTEL_PYTHON_FLASK_EXCLUDED_URLS
        value: "/health,/readiness,/metrics"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fastapi-app
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: fastapi-app
  template:
    metadata:
      labels:
        app: fastapi-app
      annotations:
        instrumentation.opentelemetry.io/inject-python: "true"
    spec:
      containers:
      - name: app
        image: myregistry/fastapi-app:latest
        env:
        - name: OTEL_SERVICE_NAME
          value: "fastapi-app"
        - name: OTEL_RESOURCE_ATTRIBUTES
          value: "service.namespace=production"
        ports:
        - containerPort: 8000
```

**Node.js Applications**:
```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: nodejs-instrumentation
  namespace: production
spec:
  exporter:
    endpoint: http://otel-collector.observability.svc.cluster.local:4318
  propagators:
    - tracecontext
    - baggage
  nodejs:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-nodejs:0.45.0
    env:
      - name: OTEL_TRACES_EXPORTER
        value: "otlp"
      - name: OTEL_METRICS_EXPORTER
        value: "otlp"
      - name: OTEL_LOGS_EXPORTER
        value: "otlp"
      - name: OTEL_EXPORTER_OTLP_PROTOCOL
        value: "http/protobuf"
      - name: OTEL_NODE_RESOURCE_DETECTORS
        value: "env,host,os,serviceinstance"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: express-app
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: express-app
  template:
    metadata:
      labels:
        app: express-app
      annotations:
        instrumentation.opentelemetry.io/inject-nodejs: "true"
    spec:
      containers:
      - name: app
        image: myregistry/express-app:latest
        env:
        - name: OTEL_SERVICE_NAME
          value: "express-app"
        - name: NODE_OPTIONS
          value: "--require /otel-auto-instrumentation/autoinstrumentation.js"
        ports:
        - containerPort: 3000
```

## Manual Instrumentation Examples

### Go Application with OpenTelemetry

```go
package main

import (
    "context"
    "fmt"
    "log"
    "net/http"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.21.0"
    "go.opentelemetry.io/otel/trace"
    "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
)

// initTracer initializes the OpenTelemetry tracer
func initTracer(ctx context.Context, serviceName, collectorURL string) (*sdktrace.TracerProvider, error) {
    // Create OTLP exporter
    conn, err := grpc.DialContext(ctx, collectorURL,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithBlock(),
    )
    if err != nil {
        return nil, fmt.Errorf("failed to create gRPC connection: %w", err)
    }

    exporter, err := otlptracegrpc.New(ctx, otlptracegrpc.WithGRPCConn(conn))
    if err != nil {
        return nil, fmt.Errorf("failed to create trace exporter: %w", err)
    }

    // Create resource with service information
    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName(serviceName),
            semconv.ServiceVersion("1.0.0"),
            semconv.DeploymentEnvironment("production"),
            attribute.String("service.namespace", "production"),
        ),
        resource.WithHost(),
        resource.WithOS(),
        resource.WithProcess(),
        resource.WithContainer(),
    )
    if err != nil {
        return nil, fmt.Errorf("failed to create resource: %w", err)
    }

    // Create tracer provider with batch span processor
    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter,
            sdktrace.WithBatchTimeout(5*time.Second),
            sdktrace.WithMaxExportBatchSize(512),
            sdktrace.WithMaxQueueSize(2048),
        ),
        sdktrace.WithResource(res),
        sdktrace.WithSampler(sdktrace.ParentBased(
            sdktrace.TraceIDRatioBased(0.1), // 10% sampling
        )),
    )

    // Set global tracer provider
    otel.SetTracerProvider(tp)

    // Set global propagator for context propagation
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    ))

    return tp, nil
}

// businessLogic simulates a business operation with tracing
func businessLogic(ctx context.Context, tracer trace.Tracer) error {
    ctx, span := tracer.Start(ctx, "business-logic",
        trace.WithAttributes(
            attribute.String("operation", "process-order"),
            attribute.Int("order.id", 12345),
        ),
    )
    defer span.End()

    // Simulate database query
    if err := queryDatabase(ctx, tracer); err != nil {
        span.RecordError(err)
        span.SetAttributes(attribute.Bool("error", true))
        return err
    }

    // Simulate external API call
    if err := callExternalAPI(ctx, tracer); err != nil {
        span.RecordError(err)
        span.SetAttributes(attribute.Bool("error", true))
        return err
    }

    span.SetAttributes(
        attribute.Bool("success", true),
        attribute.String("result", "order-processed"),
    )

    return nil
}

func queryDatabase(ctx context.Context, tracer trace.Tracer) error {
    ctx, span := tracer.Start(ctx, "database-query",
        trace.WithAttributes(
            attribute.String("db.system", "postgresql"),
            attribute.String("db.name", "orders"),
            attribute.String("db.statement", "SELECT * FROM orders WHERE id = $1"),
        ),
    )
    defer span.End()

    // Simulate database query
    time.Sleep(50 * time.Millisecond)

    span.SetAttributes(
        attribute.Int("db.rows_affected", 1),
        attribute.String("db.operation", "SELECT"),
    )

    return nil
}

func callExternalAPI(ctx context.Context, tracer trace.Tracer) error {
    ctx, span := tracer.Start(ctx, "external-api-call",
        trace.WithAttributes(
            attribute.String("http.method", "POST"),
            attribute.String("http.url", "https://api.example.com/process"),
        ),
    )
    defer span.End()

    // Create HTTP client with tracing
    client := http.Client{
        Transport: otelhttp.NewTransport(http.DefaultTransport),
        Timeout:   10 * time.Second,
    }

    req, err := http.NewRequestWithContext(ctx, "POST", "https://api.example.com/process", nil)
    if err != nil {
        return err
    }

    resp, err := client.Do(req)
    if err != nil {
        return err
    }
    defer resp.Body.Close()

    span.SetAttributes(
        attribute.Int("http.status_code", resp.StatusCode),
        attribute.String("http.status_text", resp.Status),
    )

    return nil
}

func main() {
    ctx := context.Background()

    // Initialize tracer
    tp, err := initTracer(ctx, "order-service", "otel-collector.observability.svc.cluster.local:4317")
    if err != nil {
        log.Fatalf("Failed to initialize tracer: %v", err)
    }
    defer func() {
        if err := tp.Shutdown(ctx); err != nil {
            log.Printf("Error shutting down tracer provider: %v", err)
        }
    }()

    tracer := tp.Tracer("order-service")

    // Create HTTP server with tracing
    mux := http.NewServeMux()

    mux.HandleFunc("/orders", func(w http.ResponseWriter, r *http.Request) {
        ctx := r.Context()

        if err := businessLogic(ctx, tracer); err != nil {
            http.Error(w, err.Error(), http.StatusInternalServerError)
            return
        }

        w.WriteHeader(http.StatusOK)
        fmt.Fprintf(w, "Order processed successfully")
    })

    // Wrap handler with OpenTelemetry middleware
    handler := otelhttp.NewHandler(mux, "order-service")

    log.Println("Starting server on :8080")
    if err := http.ListenAndServe(":8080", handler); err != nil {
        log.Fatalf("Failed to start server: %v", err)
    }
}
```

## Advanced Sampling Strategies

### Adaptive Sampling Configuration

```yaml
# Advanced tail sampling with multiple policies
processors:
  tail_sampling:
    decision_wait: 10s
    num_traces: 100000
    expected_new_traces_per_sec: 1000
    policies:
      # Policy 1: Always sample errors
      - name: always-sample-errors
        type: status_code
        status_code:
          status_codes: [ERROR]

      # Policy 2: Sample slow requests
      - name: slow-requests
        type: latency
        latency:
          threshold_ms: 1000

      # Policy 3: Sample requests with specific attributes
      - name: important-users
        type: string_attribute
        string_attribute:
          key: user.tier
          values: [premium, enterprise]
          enabled_regex_matching: false
          invert_match: false

      # Policy 4: Sample specific endpoints at higher rate
      - name: critical-endpoints
        type: and
        and:
          and_sub_policy:
            - name: endpoint-filter
              type: string_attribute
              string_attribute:
                key: http.route
                values: ["/api/payment", "/api/auth"]
                enabled_regex_matching: false
            - name: endpoint-sampling
              type: probabilistic
              probabilistic:
                sampling_percentage: 50

      # Policy 5: Rate limiting per service
      - name: rate-limiting
        type: rate_limiting
        rate_limiting:
          spans_per_second: 100

      # Policy 6: Composite policy for complex logic
      - name: complex-sampling
        type: composite
        composite:
          max_total_spans_per_second: 1000
          policy_order: [always-sample-errors, slow-requests, important-users]
          composite_sub_policy:
            - name: test-composite-policy-1
              type: numeric_attribute
              numeric_attribute:
                key: http.status_code
                min_value: 500
                max_value: 599
            - name: test-composite-policy-2
              type: probabilistic
              probabilistic:
                sampling_percentage: 10
          rate_allocation:
            - policy: always-sample-errors
              percent: 50
            - policy: slow-requests
              percent: 25
            - policy: important-users
              percent: 25

      # Policy 7: Default fallback policy
      - name: default-policy
        type: probabilistic
        probabilistic:
          sampling_percentage: 5
```

## Performance Optimization

### Collector Scaling and Resource Management

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: otel-collector-hpa
  namespace: observability
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: otel-collector
  minReplicas: 3
  maxReplicas: 20
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
  - type: Pods
    pods:
      metric:
        name: otelcol_receiver_accepted_spans
      target:
        type: AverageValue
        averageValue: "10000"
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 50
        periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
      - type: Percent
        value: 100
        periodSeconds: 30
      - type: Pods
        value: 2
        periodSeconds: 30
      selectPolicy: Max
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: otel-collector-pdb
  namespace: observability
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: otel-collector
```

### Memory and CPU Optimization

```yaml
# Optimized collector configuration for high throughput
processors:
  batch:
    timeout: 5s
    send_batch_size: 8192
    send_batch_max_size: 16384

  memory_limiter:
    check_interval: 1s
    limit_percentage: 75
    spike_limit_percentage: 15

  # Use queued retry for better throughput
  queued_retry:
    enabled: true
    num_consumers: 20
    num_workers: 10
    queue_size: 10000
    retry_on_failure: true

exporters:
  otlp/optimized:
    endpoint: backend:4317
    sending_queue:
      enabled: true
      num_consumers: 50
      queue_size: 20000
    retry_on_failure:
      enabled: true
      initial_interval: 1s
      max_interval: 10s
      max_elapsed_time: 60s
    compression: gzip
    timeout: 30s
```

## Monitoring OpenTelemetry Collector

### Prometheus Metrics

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-config
  namespace: observability
data:
  prometheus.yml: |
    global:
      scrape_interval: 15s
      evaluation_interval: 15s

    scrape_configs:
      - job_name: 'otel-collector'
        kubernetes_sd_configs:
          - role: pod
            namespaces:
              names:
                - observability
        relabel_configs:
          - source_labels: [__meta_kubernetes_pod_label_app]
            action: keep
            regex: otel-collector
          - source_labels: [__meta_kubernetes_pod_name]
            action: replace
            target_label: pod
          - source_labels: [__meta_kubernetes_namespace]
            action: replace
            target_label: namespace

      - job_name: 'otel-agent'
        kubernetes_sd_configs:
          - role: pod
        relabel_configs:
          - source_labels: [__meta_kubernetes_pod_label_app]
            action: keep
            regex: otel-agent
```

### Key Metrics to Monitor

```promql
# Spans received per second
rate(otelcol_receiver_accepted_spans[5m])

# Spans dropped per second
rate(otelcol_processor_dropped_spans[5m])

# Exporter queue size
otelcol_exporter_queue_size

# Exporter send failures
rate(otelcol_exporter_send_failed_spans[5m])

# Memory usage
process_resident_memory_bytes{job="otel-collector"}

# CPU usage
rate(process_cpu_seconds_total{job="otel-collector"}[5m])

# Batch processor metrics
rate(otelcol_processor_batch_batch_send_size_sum[5m])
/ rate(otelcol_processor_batch_batch_send_size_count[5m])

# Queue capacity utilization
(otelcol_exporter_queue_size / otelcol_exporter_queue_capacity) * 100
```

### Grafana Dashboard

```json
{
  "dashboard": {
    "title": "OpenTelemetry Collector Metrics",
    "panels": [
      {
        "title": "Spans Received Rate",
        "targets": [
          {
            "expr": "sum(rate(otelcol_receiver_accepted_spans[5m])) by (receiver)"
          }
        ]
      },
      {
        "title": "Spans Dropped Rate",
        "targets": [
          {
            "expr": "sum(rate(otelcol_processor_dropped_spans[5m])) by (processor)"
          }
        ]
      },
      {
        "title": "Exporter Queue Size",
        "targets": [
          {
            "expr": "otelcol_exporter_queue_size"
          }
        ]
      },
      {
        "title": "Memory Usage",
        "targets": [
          {
            "expr": "process_resident_memory_bytes{job='otel-collector'}"
          }
        ]
      }
    ]
  }
}
```

## Troubleshooting Guide

### Common Issues and Solutions

**High Memory Usage**:
```yaml
# Solution: Adjust memory limiter and batch settings
processors:
  memory_limiter:
    check_interval: 1s
    limit_percentage: 70
    spike_limit_percentage: 20

  batch:
    timeout: 5s
    send_batch_size: 4096  # Reduce batch size
```

**Spans Being Dropped**:
```bash
# Check collector logs
kubectl logs -n observability -l app=otel-collector --tail=100

# Check metrics
kubectl port-forward -n observability svc/otel-collector 8888:8888
curl http://localhost:8888/metrics | grep dropped
```

**High Latency**:
```yaml
# Optimize exporter configuration
exporters:
  otlp:
    endpoint: backend:4317
    sending_queue:
      num_consumers: 20  # Increase consumers
      queue_size: 10000  # Increase queue size
    compression: gzip  # Enable compression
```

## Best Practices

1. **Use appropriate sampling strategies** for your scale
2. **Monitor collector health** with Prometheus metrics
3. **Implement tail-based sampling** for intelligent trace collection
4. **Use batch processing** to optimize performance
5. **Enable compression** for network efficiency
6. **Set memory limits** to prevent OOM issues
7. **Use DaemonSet pattern** for node-level collection
8. **Implement proper RBAC** for security
9. **Configure proper resource requests/limits**
10. **Enable TLS** for secure communication

## Conclusion

OpenTelemetry provides a comprehensive, vendor-neutral solution for distributed tracing in modern microservices architectures. By implementing proper collector architecture, intelligent sampling strategies, and performance optimizations, you can achieve production-grade observability at enterprise scale. The auto-instrumentation capabilities significantly reduce the operational burden while maintaining comprehensive trace coverage across your infrastructure.

The key to successful OpenTelemetry deployment is balancing data collection granularity with system performance, implementing appropriate sampling strategies, and maintaining proper monitoring of the observability infrastructure itself.