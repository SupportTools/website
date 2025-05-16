---
title: "How to Monitor External Services with Prometheus from Kubernetes"
date: 2025-06-07T00:00:00-05:00
draft: false
tags: ["prometheus", "kubernetes", "servicemonitor", "node-exporter", "nginx-exporter", "metrics", "observability", "external monitoring"]
categories:
- Monitoring
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Use Kubernetes-native Prometheus to monitor external services like VMs, NGINX, and APIs using ServiceMonitor and manually defined Endpoints. Includes Node Exporter and TLS tips."
more_link: "yes"
url: "/prometheus-monitor-external-services/"
---

Monitoring external systems—like bare-metal servers, APIs, or other cloud services—from within Kubernetes can help unify your observability pipeline. With **Prometheus Operator**, you don’t need to deploy a second Prometheus instance. Instead, you can expose external targets using Kubernetes-native manifests: `Service`, `Endpoints`, and `ServiceMonitor`.

In this guide, we’ll walk through:

- Monitoring a **VM with Node Exporter**
- Monitoring a **remote NGINX server**
- Scraping a **custom REST API**
- Tips on **TLS and firewalling** external exporters

<!--more-->

# [How to Monitor External Services with Prometheus from Kubernetes](#how-to-monitor-external-services-with-prometheus-from-kubernetes)

## [Why Monitor External Services from Kubernetes](#why-monitor-external-services-from-kubernetes)

Monitoring external systems—like bare-metal servers, APIs, or other cloud services—from within Kubernetes can help unify your observability pipeline. With **Prometheus Operator**, you don’t need to deploy a second Prometheus instance. Instead, you can expose external targets using Kubernetes-native manifests: `Service`, `Endpoints`, and `ServiceMonitor`.

Prometheus Operator simplifies Prometheus management in Kubernetes by automating tasks like configuration, scaling, and high availability. By leveraging these Kubernetes resources, you can monitor external services seamlessly within your existing Kubernetes cluster, reducing operational complexity and costs.


- A `Service` without a selector.
- A `Endpoints` resource pointing to real IPs.
- A `ServiceMonitor` that ties it all together.

## [Example 1: Monitor a VM with Node Exporter](#example-1-monitor-a-vm-with-node-exporter)

### Step 1: Install Node Exporter on the VM

Install Node Exporter using the latest release:

```bash
wget https://github.com/prometheus/node_exporter/releases/latest/download/node_exporter-*.tar.gz
tar xvfz node_exporter-*.tar.gz
sudo mv node_exporter-*/node_exporter /usr/local/bin/
sudo useradd -rs /bin/false node_exporter
```

Enable and start the service with systemd:

```bash
sudo tee /etc/systemd/system/node_exporter.service <<EOF
[Unit]
Description=Node Exporter
After=network.target

[Service]
User=node_exporter
Group=node_exporter
ExecStart=/usr/local/bin/node_exporter

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload && sudo systemctl start node_exporter && sudo systemctl enable node_exporter
```

Ensure port `9100` is open:

```bash
sudo firewall-cmd --add-port=9100/tcp --permanent && sudo firewall-cmd --reload
```

### Step 2: Create the Kubernetes Resources

#### Service (no selector):

```yaml
apiVersion: v1
kind: Service
metadata:
  name: node-vm-metrics
  namespace: monitoring
  labels:
    app: node-vm
spec:
  ports:
    - name: metrics
      port: 9100
      targetPort: 9100
```

#### Endpoints:

```yaml
apiVersion: v1
kind: Endpoints
metadata:
  name: node-vm-metrics
  namespace: monitoring
subsets:
  - addresses:
      - ip: 192.168.1.100
    ports:
      - name: metrics
        port: 9100
```

#### ServiceMonitor:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: node-vm
  namespace: monitoring
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      app: node-vm
  namespaceSelector:
    matchNames:
      - monitoring
  endpoints:
    - port: metrics
      interval: 10s
```

## [Example 2: Monitor an NGINX Instance with Exporter](#example-2-monitor-an-nginx-instance-with-exporter)

Let’s say you’ve installed the official [nginx-prometheus-exporter](https://github.com/nginxinc/nginx-prometheus-exporter) on a bare-metal host.

The NGINX exporter runs on `:9113` and scrapes metrics from `http://localhost/status`.

### Step 1: Install NGINX Prometheus Exporter

Install the NGINX Prometheus Exporter on your bare-metal server using the latest release:

```bash
wget https://github.com/nginxinc/nginx-prometheus-exporter/releases/latest/download/nginx-prometheus-exporter-*.tar.gz
tar xvfz nginx-prometheus-exporter-*.tar.gz
sudo mv nginx-prometheus-exporter-* /usr/local/bin/nginx-prometheus-exporter
```

Enable and start the service with systemd:

```bash
sudo tee /etc/systemd/system/nginx-prometheus-exporter.service <<EOF
[Unit]
Description=NGINX Prometheus Exporter
After=network.target

[Service]
ExecStart=/usr/local/bin/nginx-prometheus-exporter \
  --nginx.status.addr=localhost:8080 \
  --web.listen-address=0.0.0.0:9113

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload && sudo systemctl start nginx-prometheus-exporter && sudo systemctl enable nginx-prometheus-exporter
```

Ensure port `9113` is open:

```bash
sudo firewall-cmd --add-port=9113/tcp --permanent && sudo firewall-cmd --reload
```

### Step 2: Create the Kubernetes Resources

#### Endpoints:

```yaml
apiVersion: v1
kind: Endpoints
metadata:
  name: nginx-ext
  namespace: monitoring
subsets:
  - addresses:
      - ip: 10.20.0.5
    ports:
      - name: metrics
        port: 9113
```

#### Service:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: nginx-ext
  namespace: monitoring
  labels:
    app: nginx-ext
spec:
  ports:
    - name: metrics
      port: 9113
```

#### ServiceMonitor:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: nginx-ext
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: nginx-ext
  namespaceSelector:
    matchNames:
      - monitoring
  endpoints:
    - port: metrics
      path: /metrics
      interval: 15s
```

## [Example 3: Scraping a Custom REST API](#example-3-scraping-a-custom-rest-api)

Some internal apps may expose custom metrics under `/metrics` in Prometheus format.

As long as the app binds to a known IP and port, and outputs valid Prometheus text format, the pattern is the same.

```yaml
apiVersion: v1
kind: Endpoints
metadata:
  name: custom-api-metrics
  namespace: monitoring
subsets:
  - addresses:
      - ip: 172.16.100.5
    ports:
      - name: http
        port: 9200
---
apiVersion: v1
kind: Service
metadata:
  name: custom-api-metrics
  namespace: monitoring
  labels:
    app: custom-api
spec:
  ports:
    - name: http
      port: 9200
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: custom-api
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: custom-api
  namespaceSelector:
    matchNames:
      - monitoring
  endpoints:
    - port: http
      path: /metrics
      interval: 10s
```

## [Security Tips: TLS, Network, and Relabeling](#security-tips-tls-network-and-relabeling)

- **Restrict access**: Use firewall rules or VPNs to restrict which IPs can scrape metrics.
- **TLS endpoints**: If your external exporter supports HTTPS, set `scheme: https` in the ServiceMonitor and configure certificates as needed.
- **Relabeling**: Add `metricRelabelings` or `relabelings` if you want to clean up labels or add context (e.g., VM name, region, etc.).

Example:

```yaml
relabelings:
  - sourceLabels: [__address__]
    targetLabel: instance
    regex: "(.*):.*"
    replacement: "$1"
    action: replace
```

## [Final Thoughts](#final-thoughts)

Prometheus inside Kubernetes can scrape far more than just in-cluster Pods. Whether you're monitoring VMs, physical servers, IoT nodes, or APIs, this approach lets you manage external targets with the same tooling and alerting infrastructure you already rely on.

This model scales beautifully—and keeps your observability stack clean, unified, and Kubernetes-native.
