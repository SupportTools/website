---
title: "Building a Comprehensive Container Monitoring Infrastructure in 2025"
date: 2025-12-09T09:00:00-05:00
draft: false
tags: ["Containers", "Monitoring", "Prometheus", "Grafana", "Elasticsearch", "Kubernetes", "Observability", "DevOps"]
categories:
- Monitoring
- DevOps
- Containers
author: "Matthew Mattox - mmattox@support.tools"
description: "A step-by-step guide to creating a robust, scalable monitoring infrastructure for containerized applications using modern observability tools and best practices"
more_link: "yes"
url: "/comprehensive-container-monitoring-infrastructure/"
---

Effective monitoring is critical in containerized environments where systems are distributed, dynamic, and ephemeral. This guide walks through building a complete monitoring infrastructure using modern tools and techniques to provide full visibility into your container ecosystem.

<!--more-->

# Building a Comprehensive Container Monitoring Infrastructure in 2025

## The Observability Challenge in Container Environments

Containerized infrastructures present unique monitoring challenges:

1. **Ephemeral Workloads**: Containers start, stop, and reschedule frequently
2. **Dynamic Addressing**: IP addresses and ports change constantly
3. **Distributed Systems**: Applications are spread across multiple nodes
4. **Resource Sharing**: Multiple containers share underlying resources
5. **Layered Dependencies**: Issues can originate at the container, host, or orchestration layer

Modern observability requires capturing three core types of telemetry:

1. **Metrics**: Numerical time-series data (CPU, memory, request rates, etc.)
2. **Logs**: Textual records of events and application output
3. **Traces**: The flow of requests through distributed services

In this guide, we'll build a complete monitoring stack that addresses all three pillars of observability.

## Architecture Overview

Our monitoring infrastructure consists of these components:

![Monitoring Infrastructure Architecture](/images/posts/container-monitoring-architecture.png)

### Metrics Collection and Analysis

- **Prometheus**: Time-series database that scrapes and stores metrics
- **Grafana**: Dashboard and visualization platform
- **Node Exporter**: Collects host-level metrics
- **cAdvisor**: Gathers container metrics
- **Alertmanager**: Handles alerting based on metric thresholds

### Log Collection and Analysis

- **Elasticsearch**: Distributed search and analytics engine
- **Fluentd**: Log collection, processing, and forwarding
- **Kibana**: Log visualization and exploration

### Distributed Tracing

- **OpenTelemetry Collector**: Collects and processes trace data
- **Jaeger**: Distributed tracing platform
- **Tempo**: Grafana's trace backend for unified observability

## Implementation Guide

### Prerequisites

- Docker and Docker Compose (or Kubernetes cluster)
- At least 8GB of RAM available for the monitoring stack
- Basic familiarity with containerization concepts

### Step 1: Create the Project Structure

Start by creating a directory structure for our monitoring infrastructure:

```bash
mkdir container-monitoring
cd container-monitoring
mkdir -p prometheus/config grafana/provisioning/{datasources,dashboards} \
  elasticsearch/config kibana/config fluentd/config \
  jaeger opentelemetry/config sample-app
```

Create a base `docker-compose.yml` file:

```bash
touch docker-compose.yml
touch .env
```

### Step 2: Set Up Prometheus and Node Exporter

First, let's create the Prometheus configuration:

```bash
cat > prometheus/config/prometheus.yml << EOF
global:
  scrape_interval: 15s
  evaluation_interval: 15s

alerting:
  alertmanagers:
    - static_configs:
        - targets: ['alertmanager:9093']

rule_files:
  - "rules/*.yml"

scrape_configs:
  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']

  - job_name: 'node-exporter'
    static_configs:
      - targets: ['node-exporter:9100']

  - job_name: 'cadvisor'
    static_configs:
      - targets: ['cadvisor:8080']

  - job_name: 'sample-app'
    static_configs:
      - targets: ['sample-app:8080']
EOF
```

Add Prometheus and Node Exporter to the Docker Compose file:

```yaml
version: '3.8'

services:
  prometheus:
    image: prom/prometheus:v2.49.0
    volumes:
      - ./prometheus/config:/etc/prometheus
      - prometheus_data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
      - '--web.console.libraries=/etc/prometheus/console_libraries'
      - '--web.console.templates=/etc/prometheus/consoles'
      - '--web.enable-lifecycle'
    ports:
      - "9090:9090"
    restart: unless-stopped
    networks:
      - monitoring

  node-exporter:
    image: prom/node-exporter:v1.7.0
    volumes:
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro
      - /:/rootfs:ro
    command:
      - '--path.procfs=/host/proc'
      - '--path.rootfs=/rootfs'
      - '--path.sysfs=/host/sys'
      - '--collector.filesystem.mount-points-exclude=^/(sys|proc|dev|host|etc)($$|/)'
    ports:
      - "9100:9100"
    restart: unless-stopped
    networks:
      - monitoring

  cadvisor:
    image: gcr.io/cadvisor/cadvisor:v0.47.2
    volumes:
      - /:/rootfs:ro
      - /var/run:/var/run:ro
      - /sys:/sys:ro
      - /var/lib/docker/:/var/lib/docker:ro
      - /dev/disk/:/dev/disk:ro
    ports:
      - "8080:8080"
    restart: unless-stopped
    privileged: true
    networks:
      - monitoring

networks:
  monitoring:
    driver: bridge

volumes:
  prometheus_data:
```

### Step 3: Configure Grafana

Create Grafana datasource configuration:

```bash
cat > grafana/provisioning/datasources/datasource.yml << EOF
apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    editable: false

  - name: Elasticsearch
    type: elasticsearch
    access: proxy
    database: "[logstash-]YYYY.MM.DD"
    url: http://elasticsearch:9200
    jsonData:
      esVersion: 8.0.0
      timeField: "@timestamp"
    editable: false

  - name: Tempo
    type: tempo
    access: proxy
    url: http://tempo:3200
    editable: false
EOF
```

Create a Grafana dashboard configuration:

```bash
cat > grafana/provisioning/dashboards/dashboard.yml << EOF
apiVersion: 1

providers:
  - name: 'Default'
    orgId: 1
    folder: ''
    type: file
    disableDeletion: false
    editable: true
    options:
      path: /etc/grafana/provisioning/dashboards
EOF
```

Add Grafana to the Docker Compose file:

```yaml
  grafana:
    image: grafana/grafana:10.2.0
    volumes:
      - ./grafana/provisioning:/etc/grafana/provisioning
      - grafana_data:/var/lib/grafana
    environment:
      - GF_SECURITY_ADMIN_USER=admin
      - GF_SECURITY_ADMIN_PASSWORD=admin
      - GF_USERS_ALLOW_SIGN_UP=false
    ports:
      - "3000:3000"
    restart: unless-stopped
    networks:
      - monitoring

volumes:
  grafana_data:
```

### Step 4: Set Up Alertmanager

Create an Alertmanager configuration:

```bash
mkdir -p prometheus/config/alertmanager
cat > prometheus/config/alertmanager/alertmanager.yml << EOF
global:
  resolve_timeout: 5m

route:
  group_by: ['alertname', 'job']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  receiver: 'default-receiver'

receivers:
  - name: 'default-receiver'
    webhook_configs:
      - url: 'http://alertmanager-webhook:9095'
EOF
```

Add Alertmanager to the Docker Compose file:

```yaml
  alertmanager:
    image: prom/alertmanager:v0.26.0
    volumes:
      - ./prometheus/config/alertmanager:/etc/alertmanager
    command:
      - '--config.file=/etc/alertmanager/alertmanager.yml'
      - '--storage.path=/alertmanager'
    ports:
      - "9093:9093"
    restart: unless-stopped
    networks:
      - monitoring
```

Create alert rules:

```bash
mkdir -p prometheus/config/rules
cat > prometheus/config/rules/alerts.yml << EOF
groups:
  - name: example
    rules:
      - alert: HighCPULoad
        expr: 100 - (avg by(instance) (irate(node_cpu_seconds_total{mode="idle"}[5m])) * 100) > 80
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High CPU load (instance {{ \$labels.instance }})"
          description: "CPU load is > 80%\n  VALUE = {{ \$value }}\n  LABELS: {{ \$labels }}"

      - alert: MemoryUsageHigh
        expr: (node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes) / node_memory_MemTotal_bytes * 100 > 80
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High memory usage (instance {{ \$labels.instance }})"
          description: "Memory usage is > 80%\n  VALUE = {{ \$value }}\n  LABELS: {{ \$labels }}"
EOF
```

### Step 5: Set Up Elasticsearch, Fluentd, and Kibana (EFK Stack)

Create Fluentd configuration:

```bash
cat > fluentd/config/fluent.conf << EOF
<source>
  @type forward
  port 24224
  bind 0.0.0.0
</source>

<match *.**>
  @type copy
  <store>
    @type elasticsearch
    host elasticsearch
    port 9200
    logstash_format true
    logstash_prefix fluentd
    logstash_dateformat %Y%m%d
    include_tag_key true
    type_name access_log
    tag_key @log_name
    flush_interval 1s
  </store>
  <store>
    @type stdout
  </store>
</match>
EOF
```

Create a Fluentd Dockerfile:

```bash
cat > fluentd/Dockerfile << EOF
FROM fluent/fluentd:v1.16-1

USER root

RUN apk add --no-cache --update --virtual .build-deps \
    sudo build-base ruby-dev \
    && sudo gem install fluent-plugin-elasticsearch \
    && sudo gem sources --clear-all \
    && apk del .build-deps \
    && rm -rf /tmp/* /var/tmp/* /usr/lib/ruby/gems/*/cache/*.gem

USER fluent
EOF
```

Add EFK stack to the Docker Compose file:

```yaml
  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:8.11.0
    environment:
      - discovery.type=single-node
      - bootstrap.memory_lock=true
      - "ES_JAVA_OPTS=-Xms512m -Xmx512m"
      - xpack.security.enabled=false
    ulimits:
      memlock:
        soft: -1
        hard: -1
    volumes:
      - es_data:/usr/share/elasticsearch/data
    ports:
      - "9200:9200"
    networks:
      - monitoring

  kibana:
    image: docker.elastic.co/kibana/kibana:8.11.0
    environment:
      - ELASTICSEARCH_HOSTS=http://elasticsearch:9200
    ports:
      - "5601:5601"
    depends_on:
      - elasticsearch
    networks:
      - monitoring

  fluentd:
    build: ./fluentd
    volumes:
      - ./fluentd/config:/fluentd/etc
    ports:
      - "24224:24224"
      - "24224:24224/udp"
    depends_on:
      - elasticsearch
    networks:
      - monitoring

volumes:
  es_data:
```

### Step 6: Set Up Distributed Tracing with OpenTelemetry, Jaeger, and Tempo

Create OpenTelemetry Collector configuration:

```bash
cat > opentelemetry/config/otel-collector-config.yaml << EOF
receivers:
  otlp:
    protocols:
      grpc:
      http:

processors:
  batch:

exporters:
  jaeger:
    endpoint: jaeger:14250
    tls:
      insecure: true
  prometheus:
    endpoint: "0.0.0.0:8889"
  tempo:
    endpoint: tempo:4317
    insecure: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [jaeger, tempo]
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [prometheus]
EOF
```

Add tracing components to the Docker Compose file:

```yaml
  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.91.0
    command: ["--config=/etc/otel-collector-config.yaml"]
    volumes:
      - ./opentelemetry/config/otel-collector-config.yaml:/etc/otel-collector-config.yaml
    ports:
      - "4317:4317"   # OTLP gRPC
      - "4318:4318"   # OTLP HTTP
      - "8889:8889"   # Prometheus metrics
    networks:
      - monitoring

  jaeger:
    image: jaegertracing/all-in-one:1.47
    environment:
      - COLLECTOR_OTLP_ENABLED=true
    ports:
      - "16686:16686"  # Jaeger UI
      - "14250:14250"  # Collector
    networks:
      - monitoring

  tempo:
    image: grafana/tempo:2.3.0
    command: ["-config.file=/etc/tempo.yaml"]
    volumes:
      - ./tempo-data:/tmp/tempo
    ports:
      - "3200:3200"  # Tempo UI
      - "4317:4317"  # OTLP gRPC
    networks:
      - monitoring

volumes:
  tempo-data:
```

Create a simple Tempo configuration file:

```bash
mkdir -p tempo
cat > tempo/tempo.yaml << EOF
server:
  http_listen_port: 3200

distributor:
  receivers:
    otlp:
      protocols:
        grpc:

storage:
  trace:
    backend: local
    local:
      path: /tmp/tempo/traces

EOF
```

### Step 7: Create a Sample Application with Instrumentation

Create a simple Go application with metrics, logging, and tracing:

```bash
cat > sample-app/main.go << EOF
package main

import (
	"context"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.4.0"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Define Prometheus metrics
var (
	requestCounter = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "sample_app_requests_total",
			Help: "Total number of requests",
		},
		[]string{"path", "status"},
	)
	
	requestDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "sample_app_request_duration_seconds",
			Help:    "Duration of HTTP requests",
			Buckets: prometheus.DefBuckets,
		},
		[]string{"path"},
	)
)

func initTracer() func() {
	ctx := context.Background()

	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceNameKey.String("sample-app"),
		),
	)
	if err != nil {
		log.Fatalf("Failed to create resource: %v", err)
	}

	// Set up a connection to the OTLP collector
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	conn, err := otlptracegrpc.DialContext(ctx, "otel-collector:4317")
	if err != nil {
		log.Fatalf("Failed to create gRPC connection: %v", err)
	}

	// Set up a trace exporter
	traceExporter, err := otlptrace.New(ctx, otlptracegrpc.NewClient(
		otlptracegrpc.WithGRPCConn(conn),
	))
	if err != nil {
		log.Fatalf("Failed to create trace exporter: %v", err)
	}

	// Register the trace exporter with a TracerProvider
	bsp := sdktrace.NewBatchSpanProcessor(traceExporter)
	tracerProvider := sdktrace.NewTracerProvider(
		sdktrace.WithSampler(sdktrace.AlwaysSample()),
		sdktrace.WithResource(res),
		sdktrace.WithSpanProcessor(bsp),
	)
	otel.SetTracerProvider(tracerProvider)

	return func() {
		// Shutdown will flush any remaining spans
		if err := tracerProvider.Shutdown(ctx); err != nil {
			log.Fatalf("Failed to shutdown TracerProvider: %v", err)
		}
	}
}

func handler(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	path := r.URL.Path
	
	// Add artificial delay to simulate processing time
	delay := time.Duration(rand.Intn(100)) * time.Millisecond
	time.Sleep(delay)
	
	status := http.StatusOK
	if rand.Intn(10) == 0 {
		status = http.StatusInternalServerError
		w.WriteHeader(status)
		fmt.Fprintf(w, "Error occurred")
		log.Printf("ERROR: Request to %s failed with status %d", path, status)
	} else {
		fmt.Fprintf(w, "Hello, World!")
		log.Printf("INFO: Request to %s completed successfully", path)
	}
	
	// Update metrics
	requestCounter.WithLabelValues(path, fmt.Sprintf("%d", status)).Inc()
	requestDuration.WithLabelValues(path).Observe(time.Since(start).Seconds())
}

func main() {
	// Initialize tracing
	shutdown := initTracer()
	defer shutdown()
	
	// Set up HTTP server with OpenTelemetry instrumentation
	http.Handle("/", otelhttp.NewHandler(http.HandlerFunc(handler), "hello"))
	http.Handle("/metrics", promhttp.Handler())
	
	log.Println("Starting server on :8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}
EOF
```

Create a Dockerfile for the sample application:

```bash
cat > sample-app/Dockerfile << EOF
FROM golang:1.21 AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o app .

FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /app
COPY --from=builder /app/app .
EXPOSE 8080
CMD ["./app"]
EOF
```

Create a go.mod file:

```bash
cat > sample-app/go.mod << EOF
module sample-app

go 1.21

require (
	github.com/prometheus/client_golang v1.17.0
	go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp v0.45.0
	go.opentelemetry.io/otel v1.19.0
	go.opentelemetry.io/otel/exporters/otlp/otlptrace v1.19.0
	go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc v1.19.0
	go.opentelemetry.io/otel/sdk v1.19.0
)
EOF
```

Create an empty go.sum file:

```bash
touch sample-app/go.sum
```

Add the sample app to the Docker Compose file:

```yaml
  sample-app:
    build: ./sample-app
    ports:
      - "8081:8080"
    logging:
      driver: "fluentd"
      options:
        fluentd-address: localhost:24224
        tag: sample-app
    depends_on:
      - fluentd
      - otel-collector
    networks:
      - monitoring
```

### Step 8: Launch the Monitoring Infrastructure

Create an environment file:

```bash
cat > .env << EOF
# Grafana settings
GF_SECURITY_ADMIN_USER=admin
GF_SECURITY_ADMIN_PASSWORD=admin
GF_USERS_ALLOW_SIGN_UP=false

# Elasticsearch settings
ES_JAVA_OPTS=-Xms512m -Xmx512m
ELASTIC_PASSWORD=changeme

# Sample app settings
OTEL_EXPORTER_OTLP_ENDPOINT=otel-collector:4317
OTEL_RESOURCE_ATTRIBUTES=service.name=sample-app
EOF
```

Start the entire stack:

```bash
docker-compose up -d
```

### Step 9: Access and Configure the Monitoring Tools

Once everything is up and running, you can access:

- **Prometheus**: http://localhost:9090
- **Grafana**: http://localhost:3000 (admin/admin)
- **Kibana**: http://localhost:5601
- **Jaeger UI**: http://localhost:16686
- **Sample App**: http://localhost:8081

### Creating a Complete Dashboard in Grafana

Let's create a comprehensive dashboard that includes metrics, logs, and traces:

1. Log in to Grafana (http://localhost:3000) with admin/admin
2. Navigate to Dashboards → New → New Dashboard
3. Click "Add visualization"
4. Select the Prometheus data source
5. Add panels for:
   - Container CPU Usage: `sum by (name) (rate(container_cpu_usage_seconds_total{image!=""}[5m]))`
   - Container Memory Usage: `sum by (name) (container_memory_usage_bytes{image!=""})`
   - Application Request Rate: `rate(sample_app_requests_total[5m])`
   - Application Error Rate: `sum(rate(sample_app_requests_total{status=~"5.."}[5m])) / sum(rate(sample_app_requests_total[5m]))`
   - Application Latency: `histogram_quantile(0.95, sum(rate(sample_app_request_duration_seconds_bucket[5m])) by (le))`

6. Add a Logs panel connecting to Elasticsearch with the query:
   ```
   {
     "query": {
       "match_all": {}
     },
     "sort": [
       {
         "@timestamp": {
           "order": "desc"
         }
       }
     ]
   }
   ```

7. Add a Traces panel connecting to Tempo

## Best Practices for Production Deployments

When transitioning this monitoring stack to production, consider these best practices:

### High Availability

- Deploy Prometheus with high availability using Thanos or Prometheus Operator
- Use an Elasticsearch cluster with at least 3 nodes
- Deploy Fluentd as a DaemonSet in Kubernetes
- Consider managed solutions for reduced operational overhead

### Security

- Enable TLS for all services
- Use proper authentication and authorization
- Implement network segmentation
- Rotate credentials regularly
- Apply the principle of least privilege

### Performance Tuning

- Optimize Prometheus storage retention and compaction
- Configure appropriate JVM heap size for Elasticsearch
- Use efficient log sampling and filtering
- Implement metric cardinality controls

### Resource Management

- Set resource limits and requests for all containers
- Implement horizontal pod autoscaling
- Monitor the monitoring infrastructure itself
- Consider storage requirements and implement appropriate retention policies

### Alerting Strategy

- Define meaningful alerts with clear thresholds
- Implement alert aggregation and deduplication
- Create escalation policies
- Document alert meaning and resolution steps
- Avoid alert fatigue through proper tuning

## Advanced Monitoring Techniques

### Service Level Objectives (SLOs) and Error Budgets

Implement SLOs to define reliability targets:

```yaml
# Prometheus recording rules for SLOs
groups:
- name: slo_rules
  rules:
  - record: slo:request_availability:ratio
    expr: sum(rate(sample_app_requests_total{status!~"5.."}[5m])) / sum(rate(sample_app_requests_total[5m]))

  - record: slo:request_latency:ratio
    expr: sum(rate(sample_app_request_duration_seconds_bucket{le="0.1"}[5m])) / sum(rate(sample_app_request_duration_seconds_count[5m]))
```

### Anomaly Detection

Use Prometheus Alertmanager for anomaly detection:

```yaml
groups:
- name: anomaly_detection
  rules:
  - alert: AbnormalRequestPattern
    expr: abs(rate(sample_app_requests_total[5m]) - avg_over_time(rate(sample_app_requests_total[5m])[1h:5m])) > 3 * stddev_over_time(rate(sample_app_requests_total[5m])[1h:5m])
    for: 15m
    labels:
      severity: warning
    annotations:
      summary: "Abnormal request pattern detected"
      description: "Current request rate deviates significantly from historical patterns"
```

### Synthetic Monitoring

Add synthetic monitoring to test end-to-end functionality:

1. Install the Prometheus Blackbox Exporter
2. Configure HTTP checks:

```yaml
modules:
  http_2xx:
    prober: http
    timeout: 5s
    http:
      valid_http_versions: ["HTTP/1.1", "HTTP/2.0"]
      valid_status_codes: [200]
      method: GET
```

3. Add the synthetic monitoring to Prometheus configuration:

```yaml
scrape_configs:
  - job_name: 'blackbox'
    metrics_path: /probe
    params:
      module: [http_2xx]
    static_configs:
      - targets:
        - http://sample-app:8080/
    relabel_configs:
      - source_labels: [__address__]
        target_label: __param_target
      - source_labels: [__param_target]
        target_label: instance
      - target_label: __address__
        replacement: blackbox-exporter:9115
```

## Conclusion

A well-designed monitoring infrastructure provides essential visibility into containerized applications. By combining metrics, logs, and traces into a unified observability platform, you gain the ability to:

1. **Detect issues quickly** before they impact users
2. **Diagnose root causes** across complex distributed systems
3. **Optimize application performance** based on real-world data
4. **Plan capacity** with accurate usage patterns
5. **Demonstrate compliance** with service level objectives

This monitoring stack serves as a foundation that can be extended and customized to meet your specific needs. As your containerized infrastructure grows, your monitoring capabilities can evolve with it, providing continuous insight into your systems' health and performance.

Remember that monitoring is not just about collecting data—it's about deriving actionable insights that help you build more reliable, efficient, and user-friendly applications.

The complete code for this monitoring infrastructure is available on [GitHub](https://github.com/supporttools/container-monitoring-stack).