---
title: "Monitor Etcd Cluster with Grafana and Prometheus in RKE2"  
date: 2024-09-17T19:26:00-05:00  
draft: false  
tags: ["Etcd", "Grafana", "Prometheus", "RKE2", "Monitoring"]  
categories:  
- Kubernetes  
- RKE2  
- Monitoring  
author: "Matthew Mattox - mmattox@support.tools"  
description: "Learn how to monitor an Etcd cluster in RKE2 using Grafana and Prometheus for real-time insights and alerting."  
more_link: "yes"  
url: "/monitor-etcd-cluster-grafana-prometheus-rke2/"  
---

Monitoring your Etcd cluster is critical to ensure the health of your Kubernetes infrastructure, especially in an RKE2 environment. In this post, we’ll explore how to monitor an Etcd cluster using Grafana and Prometheus, giving you real-time insights and alerting capabilities to prevent issues before they impact your cluster’s availability.

<!--more-->

### Why Monitor Etcd?

Etcd is the key-value store that backs Kubernetes, and its health is directly tied to the stability of your cluster. Monitoring Etcd helps you track important metrics like leader elections, data syncs, and storage usage. With Prometheus and Grafana, you can visualize these metrics and set up alerts for critical conditions like high disk space usage or performance bottlenecks.

### Pre-requisites

Before setting up Etcd monitoring with Prometheus and Grafana, ensure the following:

- You have an RKE2 cluster running with Prometheus and Grafana already installed.
- `kubectl` is configured and working for your RKE2 cluster.
- Etcd is running in your Kubernetes cluster as part of the control plane.

### Step 1: Install Prometheus Operator

The Prometheus Operator simplifies the deployment of Prometheus and its components. Use Helm to install the Prometheus Operator:

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm install prometheus-operator prometheus-community/kube-prometheus-stack
```

This installs Prometheus, Alertmanager, and Grafana, along with default configurations for Kubernetes metrics scraping.

### Step 2: Configure Prometheus to Monitor Etcd

By default, Prometheus may not be configured to scrape Etcd metrics. We need to update the `prometheus` configuration to scrape Etcd metrics.

- Add a `ServiceMonitor` for Etcd. Create a YAML file named `etcd-servicemonitor.yaml`:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: etcd-monitor
  namespace: monitoring
spec:
  selector:
    matchLabels:
      component: etcd
  endpoints:
  - port: etcd-metrics
    interval: 15s
  namespaceSelector:
    matchNames:
    - kube-system
```

- Apply the ServiceMonitor:

```bash
kubectl apply -f etcd-servicemonitor.yaml
```

This tells Prometheus to scrape the Etcd metrics endpoint at regular intervals.

### Step 3: Expose Etcd Metrics

For Prometheus to scrape Etcd metrics, we need to ensure that Etcd exposes its metrics on an accessible endpoint. Add the following argument to the Etcd pod configuration (usually found in your RKE2 `config.yaml` or cluster configuration):

```yaml
--listen-metrics-urls=http://0.0.0.0:2379
```

Restart the Etcd pods to apply the changes:

```bash
kubectl delete pod -l component=etcd -n kube-system
```

### Step 4: Create Grafana Dashboards for Etcd

Now that Prometheus is scraping Etcd metrics, you can create dashboards in Grafana to visualize them. Grafana comes pre-installed with some default Prometheus metrics dashboards, but you can import an Etcd-specific dashboard.

1. Open Grafana in your browser.
2. Log in using the credentials set during installation (default is `admin/admin`).
3. Go to **Dashboards > Manage** and click **Import**.
4. Import the official Etcd Grafana dashboard by entering the dashboard ID `3070` (available from the Grafana dashboard library).

This dashboard will display key metrics such as leader status, WAL (write-ahead log) size, snapshot size, and more.

### Step 5: Set Up Alerts

Using Prometheus and Alertmanager, you can set up alerts to notify you of critical issues in your Etcd cluster. For example, you can configure alerts for low disk space, slow read/write operations, or frequent leader elections.

Create a rule in Prometheus for Etcd disk usage:

```yaml
groups:
- name: etcd-alerts
  rules:
  - alert: EtcdHighDiskUsage
    expr: etcd_debugging_mvcc_db_total_size_in_bytes > 8e+9
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "High disk usage on Etcd"
      description: "Etcd data directory is using more than 8GB."
```

Apply the alert rule to Prometheus:

```bash
kubectl apply -f etcd-alerts.yaml
```

### Final Thoughts

Monitoring your Etcd cluster with Grafana and Prometheus in RKE2 ensures you have real-time insights into your cluster's health. By tracking important metrics, visualizing them in Grafana, and setting up alerting rules, you can quickly identify and resolve issues before they impact your Kubernetes environment.
