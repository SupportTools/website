---
title: "Monitoring RKE2 Certs with x509-certificate-exporter"
date: 2024-02-08T03:24:00-05:00
draft: false
tags: ["RKE2", "Prometheus", "Grafana"]
categories:
  - RKE2
  - Prometheus
  - Grafana
author: "Matthew Mattox"
description: "Monitor the expiration of RKE2 certificates with x509-certificate-exporter, including TLS secrets stored as Kubernetes secrets."
more_link: "yes"
---

Monitoring SSL/TLS certificate validity is crucial to maintaining the security and reliability of any Kubernetes cluster. For Rancher Kubernetes Engine (RKE2) clusters, tracking certificate expiration helps prevent unexpected outages and ensures your applications run smoothly.

In this post, we'll guide you through deploying the **x509-certificate-exporter** using Helm to monitor your RKE2 certificates effectively. We'll also demonstrate how to monitor the expiration of TLS secrets stored as Kubernetes secrets, including cert-manager and imported certificates.

<!--more-->

## x509-certificate-exporter

The **x509-certificate-exporter** is a lightweight and easy-to-install Prometheus exporter designed for monitoring certificate expiration. It supports:

- Watching TLS Secrets in Kubernetes clusters
- Monitoring host certificate files (e.g., for control plane and etcd nodes)
- Running on any server to monitor PEM files

---

## Prerequisites

To follow this guide, ensure you have:

- A running **RKE2 cluster**
- `kubectl` access to the cluster
- **Helm v3** installed

---

## Deploying x509-certificate-exporter

First, add the Helm repository for the x509-certificate-exporter:

```bash
helm repo add enix https://charts.enix.io
```

Next, create a `values.yaml` file with the following configuration:

```yaml
exposePerCertificateErrorMetrics: true
exposeRelativeMetrics: true
grafana:
  createDashboard: false
  sidecarLabel: grafana_dashboard
  sidecarLabelValue: '1'
hostNetwork: false
hostPathsExporter:
  daemonSets:
    cp:
      nodeSelector:
        kubernetes.io/os: linux
        node-role.kubernetes.io/control-plane: 'true'
      tolerations:
        - effect: NoSchedule
          key: cattle.io/os
          operator: Equal
          value: linux
        - effect: NoExecute
          operator: Exists
        - effect: NoSchedule
          operator: Exists
      watchFiles:
        - /var/lib/rancher/rke2/server/tls/client-admin.crt
        - /var/lib/rancher/rke2/server/tls/client-kube-apiserver.crt
        - /var/lib/rancher/rke2/server/tls/server-ca.crt
        - /var/lib/rancher/rke2/server/tls/serving-kube-apiserver.crt
    etcd:
      nodeSelector:
        kubernetes.io/os: linux
        node-role.kubernetes.io/etcd: 'true'
      tolerations:
        - effect: NoSchedule
          key: cattle.io/os
          operator: Equal
          value: linux
        - effect: NoExecute
          operator: Exists
        - effect: NoSchedule
          operator: Exists
      watchFiles:
        - /var/lib/rancher/rke2/server/tls/etcd/server-client.crt
        - /var/lib/rancher/rke2/server/tls/etcd/server-ca.crt
    worker:
      nodeSelector:
        kubernetes.io/os: linux
        node-role.kubernetes.io/worker: 'true'
      tolerations:
        - effect: NoSchedule
          key: cattle.io/os
          operator: Equal
          value: linux
        - effect: NoExecute
          operator: Exists
        - effect: NoSchedule
          operator: Exists
      watchFiles:
        - /var/lib/rancher/rke2/agent/serving-kubelet.crt
secretsExporter:
  enabled: true
prometheusPodMonitor:
  create: true
prometheusRules:
  create: true
prometheusServiceMonitor:
  create: true
```

Then, install the chart using the `values.yaml` file:

```bash
helm install x509-certificate-exporter enix/x509-certificate-exporter \
  --create-namespace \
  --namespace rke2-cert-monitoring \
  -f values.yaml
```

---

## Accessing Metrics

Once deployed, the exporter will be available at:

```
http://x509-certificate-exporter.rke2-cert-monitoring.svc.cluster.local:8080/metrics
```

You can scrape this endpoint using Prometheus to monitor certificate expiration.

---

## Grafana Dashboard

A ready-made Grafana dashboard for x509-certificate-exporter is available [here](https://grafana.com/grafana/dashboards/13922-certificates-expiration-x509-certificate-exporter/).

> **Note**: You may encounter an error about a missing Pie Chart plugin. If this happens, edit the dashboard and update the `grafana-piechart-panel` to the built-in `pie` panel.

---

## Conclusion

Deploying the x509-certificate-exporter in your RKE2 cluster provides peace of mind by ensuring you're always aware of the state of your certificates. By integrating with Prometheus and Grafana, you can set up alerts to notify you well before any certificates expire, keeping your applications secure and running smoothly.

For more advanced configurations, visit the [x509-certificate-exporter GitHub repository](https://github.com/enix/x509-certificate-exporter).

Happy monitoring!