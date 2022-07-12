---
title: "How to install kube-prometheus-stack"
date: 2022-07-12T00:21:00-05:00
draft: true
tags: ["Kubernetes", "prometheus", "kube-prometheus-stack"]
categories:
- Kubernetes
- Prometheus
- Monitoring
author: "Matthew Mattox - mmattox@support.tools."
description: "How to install kube-prometheus-stack"
more_link: "yes"
---

kube-prometheus-stack is a collection of Kubernetes manifests that includes the following:

The Prometheus operator
- Prometheus
- Alertmanager
- Prometheus node-exporter
- The Prometheus Adapter
- kube-state-metrics
- Grafana
- Preconfigured to collect metrics from every Kubernetes component
- Provides a set of default dashboards and alerts

<!--more-->
# [Install](#install)

## Setup the helm repo

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
```

## Create a namespace

```bash
kubectl create ns monitoring --dry-run=client -o yaml | kubectl apply -f -
```

Note: This command will create a namespace called monitoring and it is designed to be run multiple times IE as part of a CI/CD pipeline.

## Customize the Helm values

In this step, we will customize the Helm values file for the defaults. Below are recommend changes that you can make to the values file.

### Download the values file

```bash
wget https://raw.githubusercontent.com/prometheus-community/helm-charts/main/charts/kube-prometheus-stack/values.yaml
```

### Edit the values file

```bash
vi values.yaml
```

#### Configure the external URL for alerts

```yaml
alertmanager:
  externalUrl: https://alertmanager.yourcluster.example.com
```

Note: This is the URL is used when sending alerts from Alertmanager to services like Slack, PagerDuty, etc.

#### Enabling the ingress rule for the alertmanager service

```yaml
alertmanager:
  ingress:
    enabled: true
    hosts:
    - alertmanager.yourcluster.example.com
    tls:
      - secretName: alertmanager-tls
        hosts:
        - alertmanager.yourcluster.example.com
```

#### Enabling the ingress rule for the prometheus service

```yaml
prometheus:
  ingress:
    enabled: true
    hosts:
    - prometheus.yourcluster.example.com
    tls:
      - secretName: prometheus-tls
        hosts:
        - prometheus.yourcluster.example.com
```

#### Enabling the ingress rule for the grafana service

```yaml
grafana:
  ingress:
    enabled: true
    hosts:
    - grafana.yourcluster.example.com
    tls:
      - secretName: grafana-tls
        hosts:
        - grafana.yourcluster.example.com
```

#### Configure the storage class for the alertmanager service

```yaml
alertmanager:
  alertmanagerspec:
    volumeClaimTemplate:
      spec:
        storageClassName: longhorn
```
Note: This volume is a RWO volume and doesn't need to be high speed.

#### Configure the storage class for the prometheus service

```yaml
prometheus:
  prometheusspec:
    volumeClaimTemplate:
      spec:
        storageClassName: longhorn
```
Note: This volume is a RWO volume but should be high speed.

#### Configure the storage class for the grafana service

```yaml
grafana:
  grafanaspec:
    volumeClaimTemplate:
      spec:
        storageClassName: longhorn
```
Note: This volume is a RWO volume and doesn't need to be high speed.


## Install the kube-prometheus-stack helm with default values

```bash
helm upgrade --install prometheus-community/kube-prometheus-stack -n monitoring --name kube-prometheus-stack -f values.yaml
```

## Verify the installation

```bash
kubectl -n monitoring get pods
```

Note: It will take a few minutes for the pods to be ready.

## Access the kube-prometheus-stack dashboards

If you have configured the ingress rules you can access the dashboards by pointing your browser to the URLs. But if you have not, then you can access the dashboards by using kubectl port-forward.


### Prometheus

```bash
kubectl -n monitoring port-forward prometheus-prom-kube-prometheus-stack-prometheus-0 9090 &
```

Open your browser to http://localhost:9090/

### Alertmanager

```bash
kubectl -n monitoring port-forward alertmanager-prom-kube-prometheus-stack-alertmanager-0 9093 &
```

Open your browser to http://localhost:9093/

### Grafana

```bash
kubectl -n monitoring port-forward grafana-prom-kube-prometheus-stack-grafana-0 3000 &
```

Open your browser to http://localhost:3000/

Note: The default username is admin and the default password is prom-operator. You can customize this in the values.yaml file.