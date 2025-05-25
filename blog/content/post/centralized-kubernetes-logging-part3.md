---
title: "Building a Centralized Multi-Tenant Kubernetes Logging Architecture: Part 3"
date: 2025-11-11T09:00:00-05:00
draft: false
tags: ["Kubernetes", "Logging", "Monitoring", "Prometheus", "Grafana", "OpenSearch", "FluentD", "FluentBit", "Observability"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Implementing comprehensive monitoring for your Kubernetes logging infrastructure with Prometheus and Grafana to ensure reliability and performance"
more_link: "yes"
url: "/centralized-kubernetes-logging-part3/"
---

In the [first part](/centralized-kubernetes-logging-part1/) of this series, we set up a centralized logging infrastructure using FluentBit, FluentD, and OpenSearch. In [part two](/centralized-kubernetes-logging-part2/), we optimized our architecture with shared indices and document-level security. Now, we'll complete our logging platform by implementing comprehensive monitoring to ensure we have full visibility into the health and performance of the entire system.

<!--more-->

## Why Monitor Your Logging Infrastructure?

A logging system is critical infrastructure - when it fails, you lose visibility into your applications and services. Without proper monitoring, issues in your logging pipeline can go undetected until they become critical:

- **Silent failures**: FluentBit might stop forwarding logs without obvious errors
- **Backpressure**: FluentD could be buffering logs due to OpenSearch performance issues
- **Resource contention**: OpenSearch might be running out of heap memory or disk space
- **Data loss**: Log records could be dropped somewhere in the pipeline

By monitoring each component of our logging stack, we can detect problems early, set up alerting, and ensure high reliability of our logging system.

## Monitoring Architecture Overview

We'll use the following monitoring stack:

1. **Prometheus**: For metrics collection and storage
2. **Grafana**: For visualization and dashboards
3. **AlertManager**: For alerting based on metrics

Our monitoring architecture will look like this:

```
┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐
│                     │  │                     │  │                     │
│  Tenant Cluster 1   │  │  Tenant Cluster 2   │  │  Tenant Cluster 3   │
│  ┌─────────────┐   │  │  ┌─────────────┐   │  │  ┌─────────────┐   │
│  │  FluentBit  │◄──┼──┼──│  FluentBit  │◄──┼──┼──│  FluentBit  │◄──┼──┐
│  └─────────────┘   │  │  └─────────────┘   │  │  └─────────────┘   │  │
│         ▲          │  │         ▲          │  │         ▲          │  │
│         │          │  │         │          │  │         │          │  │
└─────────┼──────────┘  └─────────┼──────────┘  └─────────┼──────────┘  │
          │                       │                       │             │
          │                       │                       │             │
          │                       │                       │             │
          │            ┌──────────┴───────────────────────┘             │
          │            │                                                │
          │            ▼                                                │
          │  ┌─────────────────────────────────────────────────────┐    │
          │  │                                                     │    │
          │  │             Central Logging Cluster                │    │
          │  │                                                     │    │
          │  │  ┌─────────────┐           ┌─────────────────┐     │    │
          │  │  │             │           │                 │     │    │
          └──┼─►│   FluentD   │──────────►│   OpenSearch   │     │    │
             │  │             │           │                 │     │    │
             │  └──────┬──────┘           └────────┬────────┘     │    │
             │         │                           │              │    │
             │         ▼                           ▼              │    │
             │  ┌─────────────┐           ┌─────────────────┐     │    │
             │  │  Prometheus │◄──────────┤ Prom Exporters  │     │    │
             │  │   Metrics   │           │                 │     │    │
             │  └──────┬──────┘           └─────────────────┘     │    │
             │         │                                          │    │
             │         ▼                                          │    │
             │  ┌─────────────┐                                   │    │
             │  │   Grafana   │◄──────────────────────────────────┘    │
             │  │ Dashboards  │◄───────────────────────────────────────┘
             │  └─────────────┘
             └────────────────►
```

We'll set up Prometheus to scrape metrics from:

1. FluentBit instances in tenant clusters
2. FluentD in the central logging cluster
3. OpenSearch in the central logging cluster

## Implementing Metrics Collection for FluentD

### FluentD Prometheus Plugin

In part 1, we already added a basic Prometheus configuration to FluentD:

```yaml
kind: ConfigMap
apiVersion: v1
metadata:
  name: fluentd-prometheus-config
  namespace: logging
data:
  prometheus.conf: |-
    <source>
      @type prometheus
      bind "#{ENV['FLUENTD_PROMETHEUS_BIND'] || '0.0.0.0'}"
      port "#{ENV['FLUENTD_PROMETHEUS_PORT'] || '24231'}"
      metrics_path "#{ENV['FLUENTD_PROMETHEUS_PATH'] || '/metrics'}"
    </source>

    <source>
      @type prometheus_output_monitor
      interval 10
    </source>

    <filter kube.**>
      @type prometheus
      <metric>
        name fluentd_input_status_num_records_total
        type counter
        desc The total number of incoming records
        <labels>
          tenant_id ${tenant_id}
        </labels>
      </metric>
    </filter>
```

Now, let's expand this configuration to collect more detailed metrics:

```yaml
kind: ConfigMap
apiVersion: v1
metadata:
  name: fluentd-prometheus-config
  namespace: logging
data:
  prometheus.conf: |-
    <source>
      @type prometheus
      bind "#{ENV['FLUENTD_PROMETHEUS_BIND'] || '0.0.0.0'}"
      port "#{ENV['FLUENTD_PROMETHEUS_PORT'] || '24231'}"
      metrics_path "#{ENV['FLUENTD_PROMETHEUS_PATH'] || '/metrics'}"
    </source>

    <source>
      @type prometheus_output_monitor
      interval 10
    </source>

    # Record incoming logs by tenant
    <filter kube.**>
      @type prometheus
      <metric>
        name fluentd_input_status_num_records_total
        type counter
        desc The total number of incoming records
        <labels>
          tenant_id ${tenant_id}
        </labels>
      </metric>
    </filter>

    # Monitor buffer performance
    <filter kube.**>
      @type prometheus
      <metric>
        name fluentd_buffer_queue_length
        type gauge
        desc Current buffer queue length
        <labels>
          tenant_id ${tenant_id}
          plugin_id ${plugin_id}
        </labels>
      </metric>
      <metric>
        name fluentd_buffer_total_queued_size
        type gauge
        desc Current total size of queued buffers
        <labels>
          tenant_id ${tenant_id}
          plugin_id ${plugin_id}
        </labels>
      </metric>
    </filter>

    # Monitor output performance
    <filter kube.**>
      @type prometheus
      <metric>
        name fluentd_output_status_retry_count
        type gauge
        desc Current retry counts per buffer
        <labels>
          tenant_id ${tenant_id}
          plugin_id ${plugin_id}
        </labels>
      </metric>
      <metric>
        name fluentd_output_status_num_errors
        type counter
        desc Total number of errors per plugin
        <labels>
          tenant_id ${tenant_id}
          plugin_id ${plugin_id}
        </labels>
      </metric>
    </filter>
```

### Configuring Prometheus to Scrape FluentD Metrics

Next, we need to tell Prometheus to scrape these metrics. We'll create a ServiceMonitor resource if you're using the Prometheus Operator:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: fluentd
  namespace: monitoring
  labels:
    app: fluentd
spec:
  selector:
    matchLabels:
      app: fluentd
  namespaceSelector:
    matchNames:
      - logging
  endpoints:
  - port: metrics
    interval: 15s
    path: /metrics
```

Make sure your FluentD service includes the `metrics` port and the appropriate labels:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: fluentd
  namespace: logging
  labels:
    app: fluentd
spec:
  selector:
    app: fluentd
  ports:
  - name: forward
    port: 24224
    protocol: TCP
  - name: metrics
    port: 24231
    protocol: TCP
```

## Setting Up OpenSearch Monitoring

OpenSearch doesn't include a Prometheus exporter by default, so we need to add one. The simplest approach is to use a sidecar container with the prometheus-exporter plugin.

### Building a Custom OpenSearch Image

We'll create a custom OpenSearch image with the prometheus-exporter plugin installed:

```dockerfile
FROM opensearchproject/opensearch:2.4.0

# Install the prometheus exporter plugin
RUN /usr/share/opensearch/bin/opensearch-plugin install -b \
    https://github.com/aiven/prometheus-exporter-plugin-for-opensearch/releases/download/2.4.0.0/prometheus-exporter-2.4.0.0.zip
```

### Configuring OpenSearch to Expose Metrics

Once the plugin is installed, we need to ensure that the Prometheus metrics endpoint is available. Update your OpenSearch configuration to include:

```yaml
plugins.prometheus.metrics.enabled: true
plugins.prometheus.metrics.path: /_prometheus/metrics
```

This enables the Prometheus endpoint at `/_prometheus/metrics`.

### Setting Up a ServiceMonitor for OpenSearch

Now, create a ServiceMonitor to tell Prometheus to scrape OpenSearch metrics:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: opensearch
  namespace: monitoring
  labels:
    app: opensearch
spec:
  selector:
    matchLabels:
      app: opensearch
  namespaceSelector:
    matchNames:
      - logging
  endpoints:
  - port: http
    interval: 30s
    scheme: https
    tlsConfig:
      insecureSkipVerify: true
    path: /_prometheus/metrics
    basicAuth:
      username:
        name: opensearch-monitoring-creds
        key: username
      password:
        name: opensearch-monitoring-creds
        key: password
```

Don't forget to create the secret for the basic auth credentials:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: opensearch-monitoring-creds
  namespace: monitoring
type: Opaque
data:
  username: <base64-encoded-username>
  password: <base64-encoded-password>
```

## Monitoring FluentBit in Tenant Clusters

FluentBit has built-in support for Prometheus metrics. We need to update our FluentBit configuration from part 1 to enable metrics:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluent-bit-config
  namespace: logging
  labels:
    k8s-app: fluent-bit
data:
  fluent-bit.conf: |
    [SERVICE]
        Flush         1
        Log_Level     info
        Daemon        off
        Parsers_File  parsers.conf
        HTTP_Server   On
        HTTP_Listen   0.0.0.0
        HTTP_Port     2020

    @INCLUDE input-kubernetes.conf
    @INCLUDE filter-kubernetes.conf
    @INCLUDE output-forward.conf

  # Rest of the configuration...
```

With `HTTP_Server` enabled on port 2020, FluentBit will expose metrics at `/api/v1/metrics/prometheus`.

Now, add a ServiceMonitor for FluentBit in each tenant cluster:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: fluent-bit
  namespace: monitoring
  labels:
    k8s-app: fluent-bit
spec:
  selector:
    matchLabels:
      k8s-app: fluent-bit
  namespaceSelector:
    matchNames:
      - logging
  endpoints:
  - port: http
    path: /api/v1/metrics/prometheus
    interval: 15s
```

Ensure your FluentBit service exposes the HTTP port:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: fluent-bit
  namespace: logging
  labels:
    k8s-app: fluent-bit
spec:
  selector:
    k8s-app: fluent-bit
  ports:
  - name: http
    port: 2020
    protocol: TCP
```

## Creating Comprehensive Grafana Dashboards

Let's create dashboards to visualize the metrics from all components of our logging infrastructure.

### FluentD Dashboard

First, here's a comprehensive FluentD monitoring dashboard:

```json
{
  "annotations": {
    "list": [
      {
        "builtIn": 1,
        "datasource": "-- Grafana --",
        "enable": true,
        "hide": true,
        "iconColor": "rgba(0, 211, 255, 1)",
        "name": "Annotations & Alerts",
        "type": "dashboard"
      }
    ]
  },
  "editable": true,
  "gnetId": null,
  "graphTooltip": 0,
  "id": 1,
  "links": [],
  "panels": [
    {
      "aliasColors": {},
      "bars": false,
      "dashLength": 10,
      "dashes": false,
      "datasource": "Prometheus",
      "fieldConfig": {
        "defaults": {
          "custom": {}
        },
        "overrides": []
      },
      "fill": 1,
      "fillGradient": 0,
      "gridPos": {
        "h": 8,
        "w": 12,
        "x": 0,
        "y": 0
      },
      "hiddenSeries": false,
      "id": 2,
      "legend": {
        "avg": false,
        "current": false,
        "max": false,
        "min": false,
        "show": true,
        "total": false,
        "values": false
      },
      "lines": true,
      "linewidth": 1,
      "nullPointMode": "null",
      "options": {
        "alertThreshold": true
      },
      "percentage": false,
      "pluginVersion": "7.4.5",
      "pointradius": 2,
      "points": false,
      "renderer": "flot",
      "seriesOverrides": [],
      "spaceLength": 10,
      "stack": false,
      "steppedLine": false,
      "targets": [
        {
          "expr": "sum(rate(fluentd_input_status_num_records_total[5m])) by (tenant_id)",
          "interval": "",
          "legendFormat": "{{tenant_id}}",
          "refId": "A"
        }
      ],
      "thresholds": [],
      "timeFrom": null,
      "timeRegions": [],
      "timeShift": null,
      "title": "Log Records Rate by Tenant",
      "tooltip": {
        "shared": true,
        "sort": 0,
        "value_type": "individual"
      },
      "type": "graph",
      "xaxis": {
        "buckets": null,
        "mode": "time",
        "name": null,
        "show": true,
        "values": []
      },
      "yaxes": [
        {
          "format": "short",
          "label": "Records / second",
          "logBase": 1,
          "max": null,
          "min": null,
          "show": true
        },
        {
          "format": "short",
          "label": null,
          "logBase": 1,
          "max": null,
          "min": null,
          "show": true
        }
      ],
      "yaxis": {
        "align": false,
        "alignLevel": null
      }
    },
    {
      "aliasColors": {},
      "bars": false,
      "dashLength": 10,
      "dashes": false,
      "datasource": "Prometheus",
      "fieldConfig": {
        "defaults": {
          "custom": {}
        },
        "overrides": []
      },
      "fill": 1,
      "fillGradient": 0,
      "gridPos": {
        "h": 8,
        "w": 12,
        "x": 12,
        "y": 0
      },
      "hiddenSeries": false,
      "id": 3,
      "legend": {
        "avg": false,
        "current": false,
        "max": false,
        "min": false,
        "show": true,
        "total": false,
        "values": false
      },
      "lines": true,
      "linewidth": 1,
      "nullPointMode": "null",
      "options": {
        "alertThreshold": true
      },
      "percentage": false,
      "pluginVersion": "7.4.5",
      "pointradius": 2,
      "points": false,
      "renderer": "flot",
      "seriesOverrides": [],
      "spaceLength": 10,
      "stack": false,
      "steppedLine": false,
      "targets": [
        {
          "expr": "sum(fluentd_buffer_queue_length) by (plugin_id)",
          "interval": "",
          "legendFormat": "{{plugin_id}}",
          "refId": "A"
        }
      ],
      "thresholds": [],
      "timeFrom": null,
      "timeRegions": [],
      "timeShift": null,
      "title": "Buffer Queue Length",
      "tooltip": {
        "shared": true,
        "sort": 0,
        "value_type": "individual"
      },
      "type": "graph",
      "xaxis": {
        "buckets": null,
        "mode": "time",
        "name": null,
        "show": true,
        "values": []
      },
      "yaxes": [
        {
          "format": "short",
          "label": "Queue Length",
          "logBase": 1,
          "max": null,
          "min": null,
          "show": true
        },
        {
          "format": "short",
          "label": null,
          "logBase": 1,
          "max": null,
          "min": null,
          "show": true
        }
      ],
      "yaxis": {
        "align": false,
        "alignLevel": null
      }
    },
    {
      "aliasColors": {},
      "bars": false,
      "dashLength": 10,
      "dashes": false,
      "datasource": "Prometheus",
      "fieldConfig": {
        "defaults": {
          "custom": {}
        },
        "overrides": []
      },
      "fill": 1,
      "fillGradient": 0,
      "gridPos": {
        "h": 8,
        "w": 12,
        "x": 0,
        "y": 8
      },
      "hiddenSeries": false,
      "id": 4,
      "legend": {
        "avg": false,
        "current": false,
        "max": false,
        "min": false,
        "show": true,
        "total": false,
        "values": false
      },
      "lines": true,
      "linewidth": 1,
      "nullPointMode": "null",
      "options": {
        "alertThreshold": true
      },
      "percentage": false,
      "pluginVersion": "7.4.5",
      "pointradius": 2,
      "points": false,
      "renderer": "flot",
      "seriesOverrides": [],
      "spaceLength": 10,
      "stack": false,
      "steppedLine": false,
      "targets": [
        {
          "expr": "sum(fluentd_output_status_retry_count) by (plugin_id)",
          "interval": "",
          "legendFormat": "{{plugin_id}}",
          "refId": "A"
        }
      ],
      "thresholds": [],
      "timeFrom": null,
      "timeRegions": [],
      "timeShift": null,
      "title": "Retry Count",
      "tooltip": {
        "shared": true,
        "sort": 0,
        "value_type": "individual"
      },
      "type": "graph",
      "xaxis": {
        "buckets": null,
        "mode": "time",
        "name": null,
        "show": true,
        "values": []
      },
      "yaxes": [
        {
          "format": "short",
          "label": "Retries",
          "logBase": 1,
          "max": null,
          "min": null,
          "show": true
        },
        {
          "format": "short",
          "label": null,
          "logBase": 1,
          "max": null,
          "min": null,
          "show": true
        }
      ],
      "yaxis": {
        "align": false,
        "alignLevel": null
      }
    },
    {
      "aliasColors": {},
      "bars": false,
      "dashLength": 10,
      "dashes": false,
      "datasource": "Prometheus",
      "fieldConfig": {
        "defaults": {
          "custom": {}
        },
        "overrides": []
      },
      "fill": 1,
      "fillGradient": 0,
      "gridPos": {
        "h": 8,
        "w": 12,
        "x": 12,
        "y": 8
      },
      "hiddenSeries": false,
      "id": 5,
      "legend": {
        "avg": false,
        "current": false,
        "max": false,
        "min": false,
        "show": true,
        "total": false,
        "values": false
      },
      "lines": true,
      "linewidth": 1,
      "nullPointMode": "null",
      "options": {
        "alertThreshold": true
      },
      "percentage": false,
      "pluginVersion": "7.4.5",
      "pointradius": 2,
      "points": false,
      "renderer": "flot",
      "seriesOverrides": [],
      "spaceLength": 10,
      "stack": false,
      "steppedLine": false,
      "targets": [
        {
          "expr": "rate(fluentd_output_status_num_errors[5m])",
          "interval": "",
          "legendFormat": "{{plugin_id}}",
          "refId": "A"
        }
      ],
      "thresholds": [],
      "timeFrom": null,
      "timeRegions": [],
      "timeShift": null,
      "title": "Error Rate",
      "tooltip": {
        "shared": true,
        "sort": 0,
        "value_type": "individual"
      },
      "type": "graph",
      "xaxis": {
        "buckets": null,
        "mode": "time",
        "name": null,
        "show": true,
        "values": []
      },
      "yaxes": [
        {
          "format": "short",
          "label": "Errors / second",
          "logBase": 1,
          "max": null,
          "min": null,
          "show": true
        },
        {
          "format": "short",
          "label": null,
          "logBase": 1,
          "max": null,
          "min": null,
          "show": true
        }
      ],
      "yaxis": {
        "align": false,
        "alignLevel": null
      }
    }
  ],
  "refresh": "10s",
  "schemaVersion": 27,
  "style": "dark",
  "tags": ["fluentd", "logging"],
  "templating": {
    "list": []
  },
  "time": {
    "from": "now-1h",
    "to": "now"
  },
  "timepicker": {},
  "timezone": "",
  "title": "FluentD Metrics",
  "uid": "fluentd-metrics",
  "version": 1
}
```

### OpenSearch Dashboard

Here's a dashboard for monitoring OpenSearch:

```json
{
  "annotations": {
    "list": [
      {
        "builtIn": 1,
        "datasource": "-- Grafana --",
        "enable": true,
        "hide": true,
        "iconColor": "rgba(0, 211, 255, 1)",
        "name": "Annotations & Alerts",
        "type": "dashboard"
      }
    ]
  },
  "editable": true,
  "gnetId": null,
  "graphTooltip": 0,
  "id": 2,
  "links": [],
  "panels": [
    {
      "datasource": "Prometheus",
      "fieldConfig": {
        "defaults": {
          "color": {
            "mode": "thresholds"
          },
          "mappings": [],
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {
                "color": "green",
                "value": null
              },
              {
                "color": "red",
                "value": 80
              }
            ]
          },
          "unit": "percentunit"
        },
        "overrides": []
      },
      "gridPos": {
        "h": 8,
        "w": 6,
        "x": 0,
        "y": 0
      },
      "id": 2,
      "options": {
        "orientation": "auto",
        "reduceOptions": {
          "calcs": [
            "lastNotNull"
          ],
          "fields": "",
          "values": false
        },
        "showThresholdLabels": false,
        "showThresholdMarkers": true,
        "text": {}
      },
      "pluginVersion": "7.5.7",
      "targets": [
        {
          "expr": "avg(opensearch_jvm_memory_used_percent)",
          "interval": "",
          "legendFormat": "",
          "refId": "A"
        }
      ],
      "title": "JVM Heap Usage",
      "type": "gauge"
    },
    {
      "datasource": "Prometheus",
      "fieldConfig": {
        "defaults": {
          "color": {
            "mode": "thresholds"
          },
          "mappings": [],
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {
                "color": "green",
                "value": null
              },
              {
                "color": "yellow",
                "value": 70
              },
              {
                "color": "red",
                "value": 85
              }
            ]
          },
          "unit": "percentunit"
        },
        "overrides": []
      },
      "gridPos": {
        "h": 8,
        "w": 6,
        "x": 6,
        "y": 0
      },
      "id": 3,
      "options": {
        "orientation": "auto",
        "reduceOptions": {
          "calcs": [
            "lastNotNull"
          ],
          "fields": "",
          "values": false
        },
        "showThresholdLabels": false,
        "showThresholdMarkers": true,
        "text": {}
      },
      "pluginVersion": "7.5.7",
      "targets": [
        {
          "expr": "opensearch_filesystem_data_available_bytes / opensearch_filesystem_data_total_bytes",
          "interval": "",
          "legendFormat": "",
          "refId": "A"
        }
      ],
      "title": "Disk Space Available",
      "type": "gauge"
    },
    {
      "datasource": "Prometheus",
      "fieldConfig": {
        "defaults": {
          "color": {
            "mode": "thresholds"
          },
          "mappings": [],
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {
                "color": "green",
                "value": null
              },
              {
                "color": "red",
                "value": 80
              }
            ]
          }
        },
        "overrides": []
      },
      "gridPos": {
        "h": 8,
        "w": 6,
        "x": 12,
        "y": 0
      },
      "id": 4,
      "options": {
        "colorMode": "value",
        "graphMode": "area",
        "justifyMode": "auto",
        "orientation": "auto",
        "reduceOptions": {
          "calcs": [
            "lastNotNull"
          ],
          "fields": "",
          "values": false
        },
        "text": {},
        "textMode": "auto"
      },
      "pluginVersion": "7.5.7",
      "targets": [
        {
          "expr": "sum(opensearch_cluster_health_active_shards)",
          "interval": "",
          "legendFormat": "",
          "refId": "A"
        }
      ],
      "title": "Active Shards",
      "type": "stat"
    },
    {
      "datasource": "Prometheus",
      "fieldConfig": {
        "defaults": {
          "color": {
            "mode": "thresholds"
          },
          "mappings": [
            {
              "from": "0",
              "id": 0,
              "text": "Green",
              "to": "0",
              "type": 1,
              "value": "0"
            },
            {
              "from": "1",
              "id": 1,
              "text": "Yellow",
              "to": "1",
              "type": 1,
              "value": "1"
            },
            {
              "from": "2",
              "id": 2,
              "text": "Red",
              "to": "2",
              "type": 1,
              "value": "2"
            }
          ],
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {
                "color": "green",
                "value": null
              },
              {
                "color": "yellow",
                "value": 1
              },
              {
                "color": "red",
                "value": 2
              }
            ]
          }
        },
        "overrides": []
      },
      "gridPos": {
        "h": 8,
        "w": 6,
        "x": 18,
        "y": 0
      },
      "id": 5,
      "options": {
        "colorMode": "value",
        "graphMode": "none",
        "justifyMode": "auto",
        "orientation": "auto",
        "reduceOptions": {
          "calcs": [
            "lastNotNull"
          ],
          "fields": "",
          "values": false
        },
        "text": {},
        "textMode": "auto"
      },
      "pluginVersion": "7.5.7",
      "targets": [
        {
          "expr": "opensearch_cluster_health_status",
          "interval": "",
          "legendFormat": "",
          "refId": "A"
        }
      ],
      "title": "Cluster Status",
      "type": "stat"
    },
    {
      "aliasColors": {},
      "bars": false,
      "dashLength": 10,
      "dashes": false,
      "datasource": "Prometheus",
      "fieldConfig": {
        "defaults": {
          "custom": {}
        },
        "overrides": []
      },
      "fill": 1,
      "fillGradient": 0,
      "gridPos": {
        "h": 8,
        "w": 12,
        "x": 0,
        "y": 8
      },
      "hiddenSeries": false,
      "id": 6,
      "legend": {
        "avg": false,
        "current": false,
        "max": false,
        "min": false,
        "show": true,
        "total": false,
        "values": false
      },
      "lines": true,
      "linewidth": 1,
      "nullPointMode": "null",
      "options": {
        "alertThreshold": true
      },
      "percentage": false,
      "pluginVersion": "7.5.7",
      "pointradius": 2,
      "points": false,
      "renderer": "flot",
      "seriesOverrides": [],
      "spaceLength": 10,
      "stack": false,
      "steppedLine": false,
      "targets": [
        {
          "expr": "rate(opensearch_indices_indexing_index_total[5m])",
          "interval": "",
          "legendFormat": "{{instance}}",
          "refId": "A"
        }
      ],
      "thresholds": [],
      "timeFrom": null,
      "timeRegions": [],
      "timeShift": null,
      "title": "Indexing Rate",
      "tooltip": {
        "shared": true,
        "sort": 0,
        "value_type": "individual"
      },
      "type": "graph",
      "xaxis": {
        "buckets": null,
        "mode": "time",
        "name": null,
        "show": true,
        "values": []
      },
      "yaxes": [
        {
          "format": "short",
          "label": "Documents/second",
          "logBase": 1,
          "max": null,
          "min": null,
          "show": true
        },
        {
          "format": "short",
          "label": null,
          "logBase": 1,
          "max": null,
          "min": null,
          "show": true
        }
      ],
      "yaxis": {
        "align": false,
        "alignLevel": null
      }
    },
    {
      "aliasColors": {},
      "bars": false,
      "dashLength": 10,
      "dashes": false,
      "datasource": "Prometheus",
      "fieldConfig": {
        "defaults": {
          "custom": {}
        },
        "overrides": []
      },
      "fill": 1,
      "fillGradient": 0,
      "gridPos": {
        "h": 8,
        "w": 12,
        "x": 12,
        "y": 8
      },
      "hiddenSeries": false,
      "id": 7,
      "legend": {
        "avg": false,
        "current": false,
        "max": false,
        "min": false,
        "show": true,
        "total": false,
        "values": false
      },
      "lines": true,
      "linewidth": 1,
      "nullPointMode": "null",
      "options": {
        "alertThreshold": true
      },
      "percentage": false,
      "pluginVersion": "7.5.7",
      "pointradius": 2,
      "points": false,
      "renderer": "flot",
      "seriesOverrides": [],
      "spaceLength": 10,
      "stack": false,
      "steppedLine": false,
      "targets": [
        {
          "expr": "rate(opensearch_indices_search_query_total[5m])",
          "interval": "",
          "legendFormat": "{{instance}}",
          "refId": "A"
        }
      ],
      "thresholds": [],
      "timeFrom": null,
      "timeRegions": [],
      "timeShift": null,
      "title": "Search Rate",
      "tooltip": {
        "shared": true,
        "sort": 0,
        "value_type": "individual"
      },
      "type": "graph",
      "xaxis": {
        "buckets": null,
        "mode": "time",
        "name": null,
        "show": true,
        "values": []
      },
      "yaxes": [
        {
          "format": "short",
          "label": "Queries/second",
          "logBase": 1,
          "max": null,
          "min": null,
          "show": true
        },
        {
          "format": "short",
          "label": null,
          "logBase": 1,
          "max": null,
          "min": null,
          "show": true
        }
      ],
      "yaxis": {
        "align": false,
        "alignLevel": null
      }
    }
  ],
  "refresh": "10s",
  "schemaVersion": 27,
  "style": "dark",
  "tags": ["opensearch", "elasticsearch", "logging"],
  "templating": {
    "list": []
  },
  "time": {
    "from": "now-1h",
    "to": "now"
  },
  "timepicker": {},
  "timezone": "",
  "title": "OpenSearch Metrics",
  "uid": "opensearch-metrics",
  "version": 1
}
```

### FluentBit Dashboard

Finally, here's a dashboard for FluentBit:

```json
{
  "annotations": {
    "list": [
      {
        "builtIn": 1,
        "datasource": "-- Grafana --",
        "enable": true,
        "hide": true,
        "iconColor": "rgba(0, 211, 255, 1)",
        "name": "Annotations & Alerts",
        "type": "dashboard"
      }
    ]
  },
  "editable": true,
  "gnetId": null,
  "graphTooltip": 0,
  "id": 3,
  "links": [],
  "panels": [
    {
      "aliasColors": {},
      "bars": false,
      "dashLength": 10,
      "dashes": false,
      "datasource": "Prometheus",
      "fieldConfig": {
        "defaults": {
          "custom": {}
        },
        "overrides": []
      },
      "fill": 1,
      "fillGradient": 0,
      "gridPos": {
        "h": 8,
        "w": 12,
        "x": 0,
        "y": 0
      },
      "hiddenSeries": false,
      "id": 2,
      "legend": {
        "avg": false,
        "current": false,
        "max": false,
        "min": false,
        "show": true,
        "total": false,
        "values": false
      },
      "lines": true,
      "linewidth": 1,
      "nullPointMode": "null",
      "options": {
        "alertThreshold": true
      },
      "percentage": false,
      "pluginVersion": "7.5.7",
      "pointradius": 2,
      "points": false,
      "renderer": "flot",
      "seriesOverrides": [],
      "spaceLength": 10,
      "stack": false,
      "steppedLine": false,
      "targets": [
        {
          "expr": "sum(rate(fluentbit_input_bytes_total[5m])) by (instance)",
          "interval": "",
          "legendFormat": "{{instance}}",
          "refId": "A"
        }
      ],
      "thresholds": [],
      "timeFrom": null,
      "timeRegions": [],
      "timeShift": null,
      "title": "Input Bytes Rate",
      "tooltip": {
        "shared": true,
        "sort": 0,
        "value_type": "individual"
      },
      "type": "graph",
      "xaxis": {
        "buckets": null,
        "mode": "time",
        "name": null,
        "show": true,
        "values": []
      },
      "yaxes": [
        {
          "format": "bytes",
          "label": null,
          "logBase": 1,
          "max": null,
          "min": null,
          "show": true
        },
        {
          "format": "short",
          "label": null,
          "logBase": 1,
          "max": null,
          "min": null,
          "show": true
        }
      ],
      "yaxis": {
        "align": false,
        "alignLevel": null
      }
    },
    {
      "aliasColors": {},
      "bars": false,
      "dashLength": 10,
      "dashes": false,
      "datasource": "Prometheus",
      "fieldConfig": {
        "defaults": {
          "custom": {}
        },
        "overrides": []
      },
      "fill": 1,
      "fillGradient": 0,
      "gridPos": {
        "h": 8,
        "w": 12,
        "x": 12,
        "y": 0
      },
      "hiddenSeries": false,
      "id": 3,
      "legend": {
        "avg": false,
        "current": false,
        "max": false,
        "min": false,
        "show": true,
        "total": false,
        "values": false
      },
      "lines": true,
      "linewidth": 1,
      "nullPointMode": "null",
      "options": {
        "alertThreshold": true
      },
      "percentage": false,
      "pluginVersion": "7.5.7",
      "pointradius": 2,
      "points": false,
      "renderer": "flot",
      "seriesOverrides": [],
      "spaceLength": 10,
      "stack": false,
      "steppedLine": false,
      "targets": [
        {
          "expr": "sum(rate(fluentbit_output_proc_bytes_total[5m])) by (instance)",
          "interval": "",
          "legendFormat": "{{instance}}",
          "refId": "A"
        }
      ],
      "thresholds": [],
      "timeFrom": null,
      "timeRegions": [],
      "timeShift": null,
      "title": "Output Bytes Rate",
      "tooltip": {
        "shared": true,
        "sort": 0,
        "value_type": "individual"
      },
      "type": "graph",
      "xaxis": {
        "buckets": null,
        "mode": "time",
        "name": null,
        "show": true,
        "values": []
      },
      "yaxes": [
        {
          "format": "bytes",
          "label": null,
          "logBase": 1,
          "max": null,
          "min": null,
          "show": true
        },
        {
          "format": "short",
          "label": null,
          "logBase": 1,
          "max": null,
          "min": null,
          "show": true
        }
      ],
      "yaxis": {
        "align": false,
        "alignLevel": null
      }
    },
    {
      "aliasColors": {},
      "bars": false,
      "dashLength": 10,
      "dashes": false,
      "datasource": "Prometheus",
      "fieldConfig": {
        "defaults": {
          "custom": {}
        },
        "overrides": []
      },
      "fill": 1,
      "fillGradient": 0,
      "gridPos": {
        "h": 8,
        "w": 12,
        "x": 0,
        "y": 8
      },
      "hiddenSeries": false,
      "id": 4,
      "legend": {
        "avg": false,
        "current": false,
        "max": false,
        "min": false,
        "show": true,
        "total": false,
        "values": false
      },
      "lines": true,
      "linewidth": 1,
      "nullPointMode": "null",
      "options": {
        "alertThreshold": true
      },
      "percentage": false,
      "pluginVersion": "7.5.7",
      "pointradius": 2,
      "points": false,
      "renderer": "flot",
      "seriesOverrides": [],
      "spaceLength": 10,
      "stack": false,
      "steppedLine": false,
      "targets": [
        {
          "expr": "sum(rate(fluentbit_output_errors_total[5m])) by (instance)",
          "interval": "",
          "legendFormat": "{{instance}}",
          "refId": "A"
        }
      ],
      "thresholds": [],
      "timeFrom": null,
      "timeRegions": [],
      "timeShift": null,
      "title": "Output Errors Rate",
      "tooltip": {
        "shared": true,
        "sort": 0,
        "value_type": "individual"
      },
      "type": "graph",
      "xaxis": {
        "buckets": null,
        "mode": "time",
        "name": null,
        "show": true,
        "values": []
      },
      "yaxes": [
        {
          "format": "short",
          "label": "Errors/second",
          "logBase": 1,
          "max": null,
          "min": null,
          "show": true
        },
        {
          "format": "short",
          "label": null,
          "logBase": 1,
          "max": null,
          "min": null,
          "show": true
        }
      ],
      "yaxis": {
        "align": false,
        "alignLevel": null
      }
    },
    {
      "aliasColors": {},
      "bars": false,
      "dashLength": 10,
      "dashes": false,
      "datasource": "Prometheus",
      "fieldConfig": {
        "defaults": {
          "custom": {}
        },
        "overrides": []
      },
      "fill": 1,
      "fillGradient": 0,
      "gridPos": {
        "h": 8,
        "w": 12,
        "x": 12,
        "y": 8
      },
      "hiddenSeries": false,
      "id": 5,
      "legend": {
        "avg": false,
        "current": false,
        "max": false,
        "min": false,
        "show": true,
        "total": false,
        "values": false
      },
      "lines": true,
      "linewidth": 1,
      "nullPointMode": "null",
      "options": {
        "alertThreshold": true
      },
      "percentage": false,
      "pluginVersion": "7.5.7",
      "pointradius": 2,
      "points": false,
      "renderer": "flot",
      "seriesOverrides": [],
      "spaceLength": 10,
      "stack": false,
      "steppedLine": false,
      "targets": [
        {
          "expr": "sum(rate(fluentbit_output_retries_total[5m])) by (instance)",
          "interval": "",
          "legendFormat": "{{instance}}",
          "refId": "A"
        }
      ],
      "thresholds": [],
      "timeFrom": null,
      "timeRegions": [],
      "timeShift": null,
      "title": "Output Retries Rate",
      "tooltip": {
        "shared": true,
        "sort": 0,
        "value_type": "individual"
      },
      "type": "graph",
      "xaxis": {
        "buckets": null,
        "mode": "time",
        "name": null,
        "show": true,
        "values": []
      },
      "yaxes": [
        {
          "format": "short",
          "label": "Retries/second",
          "logBase": 1,
          "max": null,
          "min": null,
          "show": true
        },
        {
          "format": "short",
          "label": null,
          "logBase": 1,
          "max": null,
          "min": null,
          "show": true
        }
      ],
      "yaxis": {
        "align": false,
        "alignLevel": null
      }
    }
  ],
  "refresh": "10s",
  "schemaVersion": 27,
  "style": "dark",
  "tags": ["fluent-bit", "logging"],
  "templating": {
    "list": []
  },
  "time": {
    "from": "now-1h",
    "to": "now"
  },
  "timepicker": {},
  "timezone": "",
  "title": "FluentBit Metrics",
  "uid": "fluentbit-metrics",
  "version": 1
}
```

## Setting Up Alerting

Finally, let's set up some alerts to notify us when the logging infrastructure has issues:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: logging-alerts
  namespace: monitoring
  labels:
    app: prometheus-operator
    release: prometheus
spec:
  groups:
  - name: logging.rules
    rules:
    - alert: FluentDHighRetryCount
      expr: sum(fluentd_output_status_retry_count) by (instance) > 10
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "FluentD high retry count on {{ $labels.instance }}"
        description: "FluentD on {{ $labels.instance }} has a high retry count, indicating problems forwarding logs to OpenSearch"
        
    - alert: OpenSearchClusterNotHealthy
      expr: opensearch_cluster_health_status > 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "OpenSearch cluster is not green"
        description: "The OpenSearch cluster health status is {{ $value }} (0=green, 1=yellow, 2=red)"
        
    - alert: OpenSearchHighJVMHeapUsage
      expr: opensearch_jvm_memory_used_percent > 85
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "High JVM heap usage on {{ $labels.instance }}"
        description: "OpenSearch node {{ $labels.instance }} has JVM heap usage of {{ $value }}%"
        
    - alert: FluentBitHighErrorRate
      expr: rate(fluentbit_output_errors_total[5m]) > 0.1
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "FluentBit high error rate on {{ $labels.instance }}"
        description: "FluentBit on {{ $labels.instance }} has a high output error rate of {{ $value }} errors/sec"
```

These alerts will notify you when:

- FluentD has trouble forwarding logs
- OpenSearch cluster health is degraded
- OpenSearch nodes have high JVM heap usage
- FluentBit instances have high error rates

## Best Practices for Monitoring Your Logging Infrastructure

Based on production experience, here are some best practices for monitoring your logging infrastructure:

### 1. Set Up a Dedicated Dashboard for Log Volume Monitoring

Create a dashboard that shows log volume by tenant, namespace, and application. This helps you:

- Identify abnormal spikes or drops in log volume
- Plan capacity based on actual usage patterns
- Charge back costs to tenant teams based on usage

### 2. Implement Multi-Level Alerting

Set up alerts with different severity levels:

- **Warning Alerts**: For early indications of potential issues (buffer filling up, increasing retry count)
- **Critical Alerts**: For immediate action items (node down, cluster red status)

### 3. Monitor Disk Usage Trends

Log storage can grow quickly. Set up monitoring for:

- Current disk usage
- Disk usage growth rate
- Projected time until capacity is reached

### 4. Track Performance Metrics

Monitor key performance indicators:

- Indexing throughput
- Query latency
- Buffer lag (time between log generation and indexing)

### 5. Audit Access Patterns

Track which users and tenants are using the logging system:

- Query frequency by tenant
- Heavy users of the system
- Common search patterns

## Operational Tips for Log Infrastructure Management

Here are some operational tips for maintaining your logging infrastructure:

### 1. Regular Index Maintenance

- Schedule regular index optimizations (force merge) during off-peak hours
- Delete or archive old indices according to your retention policy
- Monitor shard sizes to ensure they don't grow too large (keep under 50GB per shard)

### 2. Performance Tuning

- Adjust JVM heap size based on node memory (set to 50% of available RAM, up to 32GB)
- Optimize bulk request sizes in FluentD to balance throughput and latency
- Use appropriate refresh intervals for indices (less frequent refreshes improve indexing performance)

### 3. Scaling Strategies

As your log volume grows, consider:

- Horizontal scaling of FluentD for higher throughput
- Adding dedicated coordinating nodes to OpenSearch for query offloading
- Using hot-warm-cold architecture for cost-effective storage

### 4. Backup and Recovery

Implement a robust backup strategy:

- Regular snapshots of OpenSearch indices
- Backup verification procedures
- Documented recovery procedures

## Conclusion: Completing Your Logging Architecture

Throughout this three-part series, we've built a comprehensive multi-tenant logging solution for Kubernetes:

- In [Part 1](/centralized-kubernetes-logging-part1/), we established the foundational architecture with FluentBit, FluentD, and OpenSearch
- In [Part 2](/centralized-kubernetes-logging-part2/), we optimized the system with shared indices and document-level security
- In this final part, we've added comprehensive monitoring to ensure reliability and performance

With these components in place, you now have a robust, scalable, and secure logging infrastructure that can grow with your Kubernetes environment. This architecture provides:

- **Tenant Isolation**: Each tenant sees only their own logs
- **Efficiency**: Shared indices reduce resource consumption
- **Reliability**: Comprehensive monitoring prevents data loss
- **Scalability**: The system can grow to handle dozens or hundreds of tenant clusters

By implementing this architecture, you'll provide your development teams with the observability they need while maintaining operational efficiency and security.

I hope this series has provided valuable insights for your Kubernetes logging journey. Feel free to share your experiences or ask questions in the comments below!