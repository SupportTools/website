---
title: "Custom Metrics with Prometheus Exporters: Building Production-Ready Exporters for Enterprise Systems"
date: 2026-06-03T00:00:00-05:00
draft: false
tags: ["Prometheus", "Exporters", "Metrics", "Observability", "Go", "Python", "Custom Metrics"]
categories: ["Observability", "Monitoring", "Development"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to building custom Prometheus exporters for enterprise systems, including best practices, performance optimization, and production deployment patterns."
more_link: "yes"
url: "/custom-prometheus-exporters-production-guide/"
---

While Prometheus provides hundreds of community exporters, enterprises often need custom exporters for proprietary systems, legacy applications, or specialized monitoring requirements. This guide covers building production-grade Prometheus exporters from scratch, including best practices, performance optimization, and deployment strategies.

<!--more-->

# Custom Metrics with Prometheus Exporters

## Executive Summary

Custom Prometheus exporters enable monitoring of any system by exposing metrics in Prometheus format. This guide demonstrates building exporters in Go and Python, implementing best practices for performance and reliability, and deploying them in production Kubernetes environments.

## Exporter Architecture

```
Target System → Custom Exporter → Prometheus
                  (exposes /metrics)
```

## Building a Go Exporter

```go
package main

import (
    "log"
    "net/http"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promhttp"
)

// Custom collector for database metrics
type DBCollector struct {
    connectionPool *prometheus.Desc
    queryLatency   *prometheus.Desc
    activeQueries  *prometheus.Desc
}

func NewDBCollector() *DBCollector {
    return &DBCollector{
        connectionPool: prometheus.NewDesc(
            "db_connection_pool_size",
            "Current connection pool size",
            []string{"database", "status"}, nil,
        ),
        queryLatency: prometheus.NewDesc(
            "db_query_duration_seconds",
            "Query execution duration",
            []string{"database", "query_type"}, nil,
        ),
        activeQueries: prometheus.NewDesc(
            "db_active_queries_total",
            "Number of active queries",
            []string{"database"}, nil,
        ),
    }
}

func (c *DBCollector) Describe(ch chan<- *prometheus.Desc) {
    ch <- c.connectionPool
    ch <- c.queryLatency
    ch <- c.activeQueries
}

func (c *DBCollector) Collect(ch chan<- prometheus.Metric) {
    // Collect metrics from target system
    start := time.Now()
    
    // Example: connection pool metrics
    ch <- prometheus.MustNewConstMetric(
        c.connectionPool,
        prometheus.GaugeValue,
        float64(getPoolSize("production")),
        "production", "active",
    )
    
    // Example: query latency
    ch <- prometheus.MustNewConstMetric(
        c.queryLatency,
        prometheus.GaugeValue,
        getAvgQueryLatency("production", "SELECT"),
        "production", "SELECT",
    )
    
    // Example: active queries
    ch <- prometheus.MustNewConstMetric(
        c.activeQueries,
        prometheus.GaugeValue,
        float64(getActiveQueries("production")),
        "production",
    )
    
    // Collection duration metric
    duration := time.Since(start).Seconds()
    log.Printf("Metrics collection took %.2fs", duration)
}

// Mock functions - replace with actual implementation
func getPoolSize(db string) int { return 20 }
func getAvgQueryLatency(db, qtype string) float64 { return 0.15 }
func getActiveQueries(db string) int { return 5 }

func main() {
    // Register custom collector
    collector := NewDBCollector()
    prometheus.MustRegister(collector)
    
    // Expose metrics endpoint
    http.Handle("/metrics", promhttp.Handler())
    http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
        w.Write([]byte("OK"))
    })
    
    log.Println("Starting exporter on :9090")
    log.Fatal(http.ListenAndServe(":9090", nil))
}
```

## Python Exporter Example

```python
from prometheus_client import start_http_server, Gauge, Counter, Histogram
import time
import random

# Define metrics
api_requests_total = Counter(
    'api_requests_total',
    'Total API requests',
    ['method', 'endpoint', 'status']
)

api_request_duration = Histogram(
    'api_request_duration_seconds',
    'API request duration',
    ['method', 'endpoint']
)

active_connections = Gauge(
    'active_connections',
    'Number of active connections'
)

queue_size = Gauge(
    'queue_size',
    'Current queue size',
    ['queue_name']
)

class CustomExporter:
    def __init__(self):
        self.setup_metrics()
    
    def setup_metrics(self):
        """Initialize metric collection"""
        pass
    
    def collect_metrics(self):
        """Collect metrics from target system"""
        while True:
            # Example: collect API metrics
            api_requests_total.labels(
                method='GET',
                endpoint='/api/users',
                status='200'
            ).inc()
            
            # Example: record request duration
            with api_request_duration.labels(
                method='GET',
                endpoint='/api/users'
            ).time():
                time.sleep(random.uniform(0.01, 0.1))
            
            # Example: update gauge metrics
            active_connections.set(random.randint(10, 100))
            queue_size.labels(queue_name='processing').set(
                random.randint(0, 50)
            )
            
            time.sleep(15)  # Collection interval

if __name__ == '__main__':
    # Start Prometheus metrics server
    start_http_server(9090)
    
    # Start metric collection
    exporter = CustomExporter()
    exporter.collect_metrics()
```

## Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: custom-exporter
  namespace: monitoring
spec:
  replicas: 2
  selector:
    matchLabels:
      app: custom-exporter
  template:
    metadata:
      labels:
        app: custom-exporter
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"
        prometheus.io/path: "/metrics"
    spec:
      containers:
      - name: exporter
        image: myregistry/custom-exporter:1.0
        ports:
        - containerPort: 9090
          name: metrics
        env:
        - name: TARGET_HOST
          value: "database.example.com"
        - name: SCRAPE_INTERVAL
          value: "30s"
        resources:
          requests:
            memory: "128Mi"
            cpu: "100m"
          limits:
            memory: "256Mi"
            cpu: "200m"
        livenessProbe:
          httpGet:
            path: /health
            port: 9090
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /metrics
            port: 9090
          initialDelaySeconds: 5
          periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: custom-exporter
  namespace: monitoring
  labels:
    app: custom-exporter
spec:
  selector:
    app: custom-exporter
  ports:
  - port: 9090
    targetPort: 9090
    name: metrics
```

## Best Practices

1. **Use appropriate metric types** (Counter, Gauge, Histogram)
2. **Implement caching** for expensive operations
3. **Set reasonable timeouts**
4. **Use consistent naming** conventions
5. **Add proper labels** for dimensionality
6. **Implement health endpoints**
7. **Handle errors gracefully**
8. **Document all metrics**
9. **Version your exporter**
10. **Test thoroughly** before production

## Conclusion

Custom Prometheus exporters enable monitoring of any system by exposing metrics in a standard format. Following best practices for implementation and deployment ensures reliable, performant exporters that integrate seamlessly with Prometheus infrastructure.
