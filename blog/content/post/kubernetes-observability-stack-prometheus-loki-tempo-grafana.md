---
title: "Kubernetes Observability Stack: Prometheus, Loki, Tempo, and Grafana"
date: 2029-02-26T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Prometheus", "Loki", "Tempo", "Grafana", "Observability"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A production deployment guide for the Grafana observability stack on Kubernetes — integrating Prometheus metrics, Loki log aggregation, Tempo distributed tracing, and Grafana dashboards with correlation across all three signal types."
more_link: "yes"
url: "/kubernetes-observability-stack-prometheus-loki-tempo-grafana/"
---

The three pillars of observability — metrics, logs, and traces — each answer a different class of operational question. Metrics reveal what is happening at scale. Logs reveal what specific events occurred. Traces reveal why a specific request took the path it did. Correlating all three is where the real diagnostic power lies: jumping from a latency metric spike to the traces from that time window, and then to the logs from the specific services that appear in those traces.

The Grafana observability stack — Prometheus, Loki, Tempo, and Grafana — implements all three pillars with native correlation built in. This guide covers production deployment of the full stack on Kubernetes, configuration for correlation between signal types, and the operational practices that keep the stack healthy under load.

<!--more-->

## Architecture Overview

The stack architecture maps signal types to components:

- **Prometheus** scrapes metrics from applications and Kubernetes components, evaluates alerting rules, and stores time-series data.
- **Loki** receives log streams from applications via Promtail or the OpenTelemetry Collector, indexes log metadata (labels), and stores log content in object storage.
- **Tempo** receives distributed traces in multiple formats (OTLP, Jaeger, Zipkin), stores trace data, and provides trace-by-ID lookup and search.
- **Grafana** provides unified dashboards, alert management, and cross-signal correlation through the Explore view.

All four components are deployed via the `kube-prometheus-stack` and `grafana` Helm charts, plus separate Loki and Tempo stacks.

## kube-prometheus-stack Installation

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update

# Install the kube-prometheus-stack, which includes:
# - Prometheus Operator
# - Prometheus instance
# - Alertmanager
# - Grafana (we'll use the grafana chart instead for more control)
# - Node exporter
# - kube-state-metrics
helm upgrade --install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace \
  --version 56.21.4 \
  --values - <<'EOF'
prometheus:
  prometheusSpec:
    retention: 15d
    retentionSize: "50GB"
    # External labels applied to all time series from this Prometheus instance.
    # Critical for multi-cluster setups where Thanos or Cortex aggregates data.
    externalLabels:
      cluster: production-us-east-1
      region: us-east-1
    # Remote write to Thanos Receive for long-term storage.
    remoteWrite:
    - url: http://thanos-receive.monitoring:19291/api/v1/receive
      queueConfig:
        maxSamplesPerSend: 5000
        batchSendDeadline: 10s
    storageSpec:
      volumeClaimTemplate:
        spec:
          storageClassName: gp3
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 100Gi
    resources:
      requests:
        cpu: "2"
        memory: "8Gi"
      limits:
        cpu: "4"
        memory: "16Gi"

alertmanager:
  alertmanagerSpec:
    storage:
      volumeClaimTemplate:
        spec:
          storageClassName: gp3
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 10Gi

# Disable bundled Grafana — we install it separately.
grafana:
  enabled: false

kube-state-metrics:
  resources:
    requests:
      cpu: "100m"
      memory: "128Mi"
    limits:
      cpu: "500m"
      memory: "256Mi"
EOF
```

## Loki Deployment

```bash
helm upgrade --install loki grafana/loki \
  --namespace monitoring \
  --version 5.47.2 \
  --values - <<'EOF'
# Microservices mode for production scalability.
deploymentMode: SimpleScalable

loki:
  auth_enabled: true
  commonConfig:
    replication_factor: 3
  storage:
    type: s3
    s3:
      endpoint: s3.us-east-1.amazonaws.com
      region: us-east-1
      bucketnames: company-loki-chunks
      insecure: false
  schemaConfig:
    configs:
    - from: "2024-01-01"
      store: tsdb
      object_store: s3
      schema: v13
      index:
        prefix: loki_
        period: 24h
  limits_config:
    retention_period: 30d
    ingestion_rate_mb: 50
    ingestion_burst_size_mb: 100
    max_query_series: 100000
    max_streams_per_user: 0  # No limit for production.
    max_label_names_per_series: 30

read:
  replicas: 3
  resources:
    requests:
      cpu: "500m"
      memory: "1Gi"
    limits:
      cpu: "2"
      memory: "4Gi"

write:
  replicas: 3
  resources:
    requests:
      cpu: "500m"
      memory: "1Gi"
    limits:
      cpu: "2"
      memory: "4Gi"

backend:
  replicas: 3

singleBinary:
  replicas: 0
EOF
```

## Promtail: Shipping Logs from Kubernetes

```yaml
# promtail-config.yaml — DaemonSet configuration for log collection.
apiVersion: v1
kind: ConfigMap
metadata:
  name: promtail-config
  namespace: monitoring
data:
  promtail.yaml: |
    server:
      http_listen_port: 3101
      grpc_listen_port: 9095
      log_level: warn

    clients:
    - url: http://loki-gateway.monitoring:80/loki/api/v1/push
      tenant_id: production
      backoff_config:
        min_period: 500ms
        max_period: 5m
        max_retries: 10
      timeout: 10s

    positions:
      filename: /tmp/positions.yaml

    scrape_configs:
    # Collect all container logs.
    - job_name: kubernetes-pods
      kubernetes_sd_configs:
      - role: pod
      pipeline_stages:
      # Parse JSON logs.
      - json:
          expressions:
            level: level
            msg: msg
            ts: ts
            trace_id: trace_id
            span_id: span_id
      # Map the trace_id to Tempo's trace correlation label.
      - labels:
          level:
          trace_id:
      # Drop debug logs in non-debug namespaces.
      - drop:
          source: level
          expression: "debug"
          drop_counter_reason: "debug_log_dropped"
      relabel_configs:
      - source_labels: [__meta_kubernetes_pod_label_app_kubernetes_io_name]
        target_label: app
      - source_labels: [__meta_kubernetes_namespace]
        target_label: namespace
      - source_labels: [__meta_kubernetes_pod_name]
        target_label: pod
      - source_labels: [__meta_kubernetes_container_name]
        target_label: container
      - source_labels: [__meta_kubernetes_node_name]
        target_label: node
      # Exclude monitoring namespace logs to prevent feedback loops.
      - source_labels: [__meta_kubernetes_namespace]
        action: drop
        regex: monitoring
```

## Tempo Deployment

```bash
helm upgrade --install tempo grafana/tempo-distributed \
  --namespace monitoring \
  --version 1.9.10 \
  --values - <<'EOF'
storage:
  trace:
    backend: s3
    s3:
      bucket: company-tempo-traces
      endpoint: s3.amazonaws.com
      region: us-east-1

traces:
  otlp:
    http:
      enabled: true
    grpc:
      enabled: true
  jaeger:
    grpcPlugin:
      enabled: true
  zipkin:
    enabled: false

metricsGenerator:
  enabled: true
  config:
    storage:
      path: /var/tempo/generator/wal
    registry:
      external_labels:
        cluster: production-us-east-1
    traces_storage:
      path: /var/tempo/generator/traces
    processor:
      service_graphs:
        enabled: true
        max_items: 10000
        wait: 10s
      span_metrics:
        enabled: true
        dimensions:
        - http.method
        - http.status_code
        - service.name

ingester:
  replicas: 3
  resources:
    requests:
      cpu: "500m"
      memory: "2Gi"
    limits:
      cpu: "2"
      memory: "8Gi"

querier:
  replicas: 3

distributor:
  replicas: 3
EOF
```

## Grafana Deployment with Data Source Configuration

```bash
helm upgrade --install grafana grafana/grafana \
  --namespace monitoring \
  --version 7.3.12 \
  --values - <<'EOF'
replicas: 2

resources:
  requests:
    cpu: "500m"
    memory: "512Mi"
  limits:
    cpu: "2"
    memory: "2Gi"

persistence:
  enabled: true
  storageClassName: gp3
  size: 10Gi

grafana.ini:
  server:
    root_url: https://grafana.monitoring.example.com
  auth:
    oauth_auto_login: true
  auth.generic_oauth:
    enabled: true
    name: "Okta SSO"
    allow_sign_up: true
    client_id: grafana-client-id
    client_secret: "${OAUTH_CLIENT_SECRET}"
    scopes: openid profile email groups
    auth_url: https://company.okta.com/oauth2/v1/authorize
    token_url: https://company.okta.com/oauth2/v1/token
    api_url: https://company.okta.com/oauth2/v1/userinfo
    role_attribute_path: contains(groups[*], 'grafana-admins') && 'Admin' || contains(groups[*], 'grafana-editors') && 'Editor' || 'Viewer'
  feature_toggles:
    enable: traceToMetrics correlations

datasources:
  datasources.yaml:
    apiVersion: 1
    datasources:
    - name: Prometheus
      type: prometheus
      uid: prometheus
      url: http://kube-prometheus-stack-prometheus.monitoring:9090
      isDefault: true
      jsonData:
        timeInterval: 30s
        exemplarTraceIdDestinations:
        - name: trace_id
          datasourceUid: tempo

    - name: Loki
      type: loki
      uid: loki
      url: http://loki-gateway.monitoring:80
      jsonData:
        httpHeaderName1: X-Scope-OrgID
        derivedFields:
        # Automatically link trace_id fields in logs to Tempo traces.
        - name: TraceID
          matcherRegex: '"trace_id":"(\w+)"'
          url: "$${__value.raw}"
          datasourceUid: tempo

    - name: Tempo
      type: tempo
      uid: tempo
      url: http://tempo-query-frontend.monitoring:3100
      jsonData:
        tracesToLogsV2:
          datasourceUid: loki
          filterByTraceID: true
          filterBySpanID: false
          customQuery: true
          query: '{namespace="${__span.tags.namespace}", app="${__span.tags.service_name}"} | json | trace_id="${__trace.traceId}"'
        tracesToMetrics:
          datasourceUid: prometheus
          queries:
          - name: Request Rate
            query: 'rate(traces_spanmetrics_calls_total{service_name="${__span.tags.service_name}"}[$__rate_interval])'
        serviceMap:
          datasourceUid: prometheus
        nodeGraph:
          enabled: true
        lokiSearch:
          datasourceUid: loki
EOF
```

## OpenTelemetry Instrumentation

Applications must emit structured logs with trace IDs to enable log-trace correlation.

```go
package observability

import (
    "context"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.21.0"
    "go.opentelemetry.io/otel/trace"
    "log/slog"
)

func InitTracing(ctx context.Context, serviceName, version string) (func(), error) {
    exporter, err := otlptracegrpc.New(ctx,
        otlptracegrpc.WithEndpoint("tempo-distributor.monitoring:4317"),
        otlptracegrpc.WithInsecure(),
    )
    if err != nil {
        return nil, fmt.Errorf("creating OTLP exporter: %w", err)
    }

    res, err := resource.Merge(
        resource.Default(),
        resource.NewWithAttributes(
            semconv.SchemaURL,
            semconv.ServiceName(serviceName),
            semconv.ServiceVersion(version),
        ),
    )
    if err != nil {
        return nil, fmt.Errorf("creating resource: %w", err)
    }

    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter),
        sdktrace.WithResource(res),
        sdktrace.WithSampler(sdktrace.ParentBased(
            sdktrace.TraceIDRatioBased(0.1), // Sample 10% of traces.
        )),
    )

    otel.SetTracerProvider(tp)
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    ))

    return func() { tp.Shutdown(context.Background()) }, nil
}

// TracingLogger adds trace context to structured log entries.
// When Grafana Loki shows a log line, clicking the trace_id will
// open the corresponding trace in Tempo.
type TracingLogger struct {
    base *slog.Logger
}

func (l *TracingLogger) InfoCtx(ctx context.Context, msg string, attrs ...slog.Attr) {
    span := trace.SpanFromContext(ctx)
    if span.IsRecording() {
        sc := span.SpanContext()
        attrs = append(attrs,
            slog.String("trace_id", sc.TraceID().String()),
            slog.String("span_id", sc.SpanID().String()),
        )
    }
    l.base.LogAttrs(ctx, slog.LevelInfo, msg, attrs...)
}
```

## Alertmanager Configuration for PagerDuty and Slack

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: alertmanager-config
  namespace: monitoring
stringData:
  alertmanager.yaml: |
    global:
      resolve_timeout: 5m
      pagerduty_url: https://events.pagerduty.com/v2/enqueue

    templates:
    - /etc/alertmanager/templates/*.tmpl

    route:
      receiver: slack-general
      group_by: [alertname, namespace, severity]
      group_wait: 30s
      group_interval: 5m
      repeat_interval: 4h
      routes:
      - matchers:
        - severity=critical
        receiver: pagerduty-production
        continue: true
      - matchers:
        - severity=critical
        receiver: slack-critical

    receivers:
    - name: slack-general
      slack_configs:
      - api_url: https://hooks.slack.com/services/<WORKSPACE_ID>/<CHANNEL_ID>/<WEBHOOK_TOKEN>
        channel: '#alerts'
        title: '{{ template "slack.title" . }}'
        text: '{{ template "slack.text" . }}'
        send_resolved: true

    - name: slack-critical
      slack_configs:
      - api_url: https://hooks.slack.com/services/<WORKSPACE_ID>/<CHANNEL_ID>/<WEBHOOK_TOKEN>
        channel: '#incidents'
        title: ':red_circle: CRITICAL: {{ .GroupLabels.alertname }}'
        text: |
          *Environment:* production
          *Namespace:* {{ .GroupLabels.namespace }}
          *Summary:* {{ range .Alerts }}{{ .Annotations.summary }}{{ end }}
          *Runbook:* {{ range .Alerts }}{{ .Annotations.runbook_url }}{{ end }}

    - name: pagerduty-production
      pagerduty_configs:
      - routing_key: rk_prod_xxxxxxxxxxxxxxxxxxxx
        severity: '{{ if eq .GroupLabels.severity "critical" }}critical{{ else }}warning{{ end }}'
        description: '{{ range .Alerts }}{{ .Annotations.summary }}{{ end }}'
        details:
          cluster: production-us-east-1
          namespace: '{{ .GroupLabels.namespace }}'
```

## SLO Recording Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: slo-rules
  namespace: monitoring
spec:
  groups:
  - name: slo-availability
    interval: 30s
    rules:
    # 5-minute error rate for the payment API.
    - record: slo:request_error_rate:5m
      expr: |
        sum(rate(http_requests_total{
          namespace="production",
          service="payment-api",
          code=~"5.."
        }[5m]))
        /
        sum(rate(http_requests_total{
          namespace="production",
          service="payment-api"
        }[5m]))
      labels:
        service: payment-api

    # 99.9% availability SLO alert.
    - alert: SLOAvailabilityBurnRateCritical
      expr: |
        slo:request_error_rate:5m{service="payment-api"} > (1 - 0.999) * 14.4
      for: 2m
      labels:
        severity: critical
        service: payment-api
      annotations:
        summary: "Payment API fast burn rate: SLO error budget burning 14.4x faster than expected"
        runbook_url: "https://runbooks.example.com/payment-api/slo-burn-rate"
        dashboard_url: "https://grafana.monitoring.example.com/d/payment-api-slo"
```

The Grafana observability stack provides a unified lens into application behavior. The correlation between metrics, logs, and traces — jumping from a P99 latency spike in Prometheus to the traces during that window in Tempo, and then to the structured logs for those trace IDs in Loki — compresses the mean time to diagnosis significantly compared to using disconnected tools.
