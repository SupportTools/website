---
title: "Kubernetes Monitoring with Prometheus and Grafana"
date: 2024-10-24T10:15:00-05:00
draft: false
tags: ["Kubernetes", "Monitoring", "Prometheus", "Grafana"]
categories:
- Kubernetes
- Monitoring
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to monitor Kubernetes clusters with Prometheus and visualize metrics using Grafana."
more_link: "yes"
url: "/kubernetes-monitoring-prometheus-grafana/"
---

**Monitoring** is essential for operating Kubernetes clusters effectively. **Prometheus** and **Grafana** are two of the most popular open-source tools used to **collect, query, and visualize metrics** in Kubernetes environments. This post will walk you through how to set up **Prometheus and Grafana** for cluster monitoring and provide best practices for getting the most out of your metrics.

---

## Why Monitoring is Critical in Kubernetes

Kubernetes environments are highly dynamic, and monitoring ensures:
- **Cluster Health Visibility:** Keep track of nodes, pods, and services.
- **Resource Optimization:** Identify bottlenecks and right-size your resources.
- **Incident Detection:** Detect failures early with alerts.
- **Performance Tuning:** Use metrics to tune workloads for better performance.

---

## Installing Prometheus and Grafana

Prometheus and Grafana can be installed using Helm to simplify the deployment.

### 1. Install Prometheus

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
helm install prometheus prometheus-community/kube-prometheus-stack --namespace monitoring --create-namespace
```

Prometheus will start collecting metrics from Kubernetes components and services.

---

### 2. Install Grafana

```bash
helm install grafana grafana/grafana --namespace monitoring
```

Once Grafana is installed, access it via port-forward:

```bash
kubectl port-forward svc/grafana 3000:80 -n monitoring
```

Login with the default credentials:
- **Username:** `admin`
- **Password:** `prom-operator`

---

## Setting Up Dashboards

Grafana provides **pre-built dashboards** for Kubernetes monitoring. To import a Kubernetes dashboard:
1. Go to Grafana → **Dashboards → Import**.
2. Enter Dashboard ID: `6417` (or other relevant dashboard).
3. Select Prometheus as the data source.

You’ll now have a detailed view of **CPU, memory, pod status, and node health**.

---

## Alerting with Prometheus

Use **Prometheus AlertManager** to configure alerts for critical metrics.

### Example Alert Rule

```yaml
groups:
- name: kubernetes.rules
  rules:
  - alert: HighCPUUsage
    expr: node_cpu_seconds_total{mode="idle"} < 10
    for: 1m
    labels:
      severity: critical
    annotations:
      summary: "High CPU usage detected"
```

With this rule, if idle CPU drops below 10% for 1 minute, you’ll get a **critical alert**.

---

## Best Practices for Monitoring

1. **Right-size Metrics Retention:** Keep only necessary metrics to reduce storage usage.
2. **Set Up Alerts:** Configure **Prometheus AlertManager** to catch issues early.
3. **Use Dashboards Wisely:** Avoid cluttering Grafana with too many dashboards—focus on the most relevant ones.
4. **Monitor Cluster Bottlenecks:** Pay attention to **CPU, memory, and disk I/O**.
5. **Integrate with Slack:** Send alerts to **Slack** or other communication tools for quicker incident response.

---

## Conclusion

By using **Prometheus and Grafana**, you gain full visibility into your Kubernetes cluster’s health and performance. **Dashboards and alerts** provide actionable insights that allow you to **resolve issues proactively** and optimize workloads. 
