---
title: "Install Kube State Metrics on Kubernetes"  
date: 2024-09-24T19:26:00-05:00  
draft: false  
tags: ["Kubernetes", "Monitoring", "Kube State Metrics", "Prometheus"]  
categories:  
- Kubernetes  
- Monitoring  
author: "Matthew Mattox - mmattox@support.tools"  
description: "Learn how to install and configure Kube State Metrics on Kubernetes to monitor resource states and enhance cluster visibility."  
more_link: "yes"  
url: "/install-kube-state-metrics-kubernetes/"  
---

Kube State Metrics is a powerful tool that exposes resource state metrics from Kubernetes objects, making it easier to monitor and gain insights into your cluster’s health and resource usage. It integrates seamlessly with Prometheus and helps track resource states such as pods, deployments, nodes, and more. In this guide, we’ll walk you through installing Kube State Metrics on Kubernetes.

<!--more-->

### Why Use Kube State Metrics?

Kube State Metrics provides detailed visibility into the state of Kubernetes objects, including pods, nodes, deployments, and services. It focuses on the current state of these resources rather than their performance, allowing you to monitor the desired vs. current state of your cluster objects. By combining Kube State Metrics with Prometheus, you can create dashboards in Grafana to visualize cluster health and resource states effectively.

### Step 1: Install Kube State Metrics Using Helm

The easiest way to install Kube State Metrics is via Helm, a popular Kubernetes package manager. If Helm is not installed, you can set it up by following these steps:

#### Install Helm

```bash
curl https://raw.githubusercontent.com/helm/helm/master/scripts/get-helm-3 | bash
```

Once Helm is installed, you can add the Prometheus community chart repository:

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
```

#### Install Kube State Metrics

Run the following command to install Kube State Metrics on your Kubernetes cluster:

```bash
helm install kube-state-metrics prometheus-community/kube-state-metrics
```

This installs Kube State Metrics and deploys it in the default namespace. You can specify a different namespace by adding the `--namespace <namespace>` flag to the command.

### Step 2: Verify the Installation

To ensure that Kube State Metrics is running correctly, you can check the pods and services created by the Helm chart:

```bash
kubectl get pods
kubectl get svc
```

Look for the `kube-state-metrics` pod and service in the output. The pod should be in a `Running` state, and the service should be exposed on port 8080.

### Step 3: Configure Prometheus to Scrape Kube State Metrics

Now that Kube State Metrics is running, you need to configure Prometheus to scrape the metrics. Edit your `prometheus.yml` configuration file to add a new scrape job for Kube State Metrics:

```yaml
scrape_configs:
  - job_name: 'kube-state-metrics'
    static_configs:
      - targets: ['kube-state-metrics.default.svc:8080']
```

Replace `default` with the namespace where Kube State Metrics is deployed if necessary. After making these changes, reload Prometheus to apply the new configuration:

```bash
kubectl rollout restart deployment prometheus-server
```

### Step 4: Visualize Kube State Metrics in Grafana

Once Prometheus starts scraping the Kube State Metrics data, you can visualize it in Grafana. Here's how:

1. **Add Prometheus as a data source in Grafana**:
   - Go to **Configuration > Data Sources** in Grafana.
   - Click **Add data source**, select **Prometheus**, and enter the Prometheus server URL (e.g., `http://prometheus-server:9090`).
   - Click **Save & Test** to verify the connection.

2. **Import a Kube State Metrics dashboard**:
   - Go to **Dashboards > Manage > Import** in Grafana.
   - Enter dashboard ID `13332` (or search for "Kubernetes cluster monitoring" in Grafana's dashboard library).
   - Click **Load**, select your Prometheus data source, and click **Import**.

This dashboard provides detailed insights into the state of various Kubernetes resources, such as pods, deployments, and nodes.

### Step 5: Set Up Alerts (Optional)

To stay proactive about cluster health, you can set up alerts based on Kube State Metrics data in Prometheus or Grafana.

1. **Create an alert rule** in Prometheus:
   - For example, to alert when pod restarts exceed a threshold:

   ```yaml
   groups:
     - name: kubernetes-pod-alerts
       rules:
         - alert: PodHighRestarts
           expr: rate(kube_pod_container_status_restarts_total[5m]) > 0.1
           for: 5m
           labels:
             severity: warning
           annotations:
             summary: "Pod has high restarts"
             description: "Pod {{ $labels.pod }} in namespace {{ $labels.namespace }} has restarted more than 0.1 times per second."
   ```

2. **Configure notification channels** in Grafana:
   - Go to **Alerting > Notification Channels** and add your preferred alerting method (email, Slack, etc.).

### Final Thoughts

Installing Kube State Metrics on Kubernetes is a straightforward process that provides deep insights into the state of your cluster resources. By integrating Kube State Metrics with Prometheus and Grafana, you can effectively monitor your cluster, detect issues, and optimize resource usage. With this setup, you’re well on your way to enhancing visibility into your Kubernetes environment.
