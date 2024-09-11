---
title: "Installing VictoriaMetrics on Kubernetes with k3s"
date: 2024-05-18T19:26:00-05:00
draft: false
tags: ["k3s", "Kubernetes", "VictoriaMetrics", "Monitoring"]
categories:
- DevOps
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools."
description: "Learn how to install and configure VictoriaMetrics on Kubernetes using k3s, and integrate it with Grafana for enhanced monitoring capabilities."
more_link: "yes"
url: "/installing-victoriametrics-on-kubernetes-with-k3s/"
---

Learn how to install and configure VictoriaMetrics on Kubernetes using k3s, and integrate it with Grafana for enhanced monitoring capabilities. This guide walks you through the process step-by-step.

<!--more-->

# [Installing VictoriaMetrics on Kubernetes with k3s](#installing-victoriametrics-on-kubernetes-with-k3s)

The documentation for VictoriaMetrics is a bit of a mess, so here’s what worked for me.

## [Install the Kubernetes Operator](#install-the-kubernetes-operator)

A Kubernetes Operator (usually):

- Adds a bunch of Kubernetes CRDs, so that you can define resources in YAML.
- Adds a controller that monitors those CRDs and either translates them into standard Kubernetes resources or applies them directly.

From [VictoriaMetrics Operator Quick Start](https://docs.victoriametrics.com/operator/quick-start.html):

```bash
VM_VERSION=`basename $(curl -fs -o/dev/null -w %{redirect_url} https://github.com/VictoriaMetrics/operator/releases/latest)`
wget https://github.com/VictoriaMetrics/operator/releases/download/$VM_VERSION/bundle_crd.zip
unzip bundle_crd.zip
kubectl apply -f release/crds
kubectl apply -f release/operator
```

Verify the installation:

```bash
kubectl --namespace monitoring-system get all
```

Example output:

```
NAME                                        READY   STATUS              RESTARTS   AGE
pod/vm-operator-55f666998d-rgn5v            1/1     Running             0          6m11s

NAME                                   READY   UP-TO-DATE   AVAILABLE   AGE
deployment.apps/vm-operator            1/1     1            1           6m11s

NAME                                              DESIRED   CURRENT   READY   AGE
replicaset.apps/vm-operator-55f666998d            1         1         1       6m11s
```

## [Define a VMSingle](#define-a-vmsingle)

Create a `VMSingle` resource. This configuration causes the operator to create a bunch of other resources, such as a deployment, a replicaset, a service, and a pod:

```yaml
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMSingle
metadata:
  name: vm-database
  namespace: monitoring-system
spec:
  retentionPeriod: 12w
```

Check the status of the resources:

```bash
kubectl --namespace monitoring-system get all
```

Example output:

```
NAME                                        READY   STATUS              RESTARTS   AGE
pod/vm-operator-55f666998d-rgn5v            1/1     Running             0          6m11s
pod/vmsingle-vm-database-8447df86cc-xgt55   0/1     ContainerCreating   0          15s

NAME                           TYPE        CLUSTER-IP     EXTERNAL-IP   PORT(S)    AGE
service/vmsingle-vm-database   ClusterIP   10.43.31.176   <none>        8429/TCP   15s

NAME                                   READY   UP-TO-DATE   AVAILABLE   AGE
deployment.apps/vm-operator            1/1     1            1           6m11s
deployment.apps/vmsingle-vm-database   0/1     1            0           15s

NAME                                              DESIRED   CURRENT   READY   AGE
replicaset.apps/vm-operator-55f666998d            1         1         1       6m11s
replicaset.apps/vmsingle-vm-database-8447df86cc   1         1         0       15s
```

If the pod crashes, inspect the logs:

```bash
kubectl --namespace monitoring-system describe pod vmsingle-vm-database-8447df86cc-xgt55
kubectl --namespace monitoring-system logs vmsingle-vm-database-8447df86cc-xgt55
```

Example error:

```
invalid value "" for flag -retentionPeriod: duration cannot be empty
```

Update the `VMSingle` configuration with a valid retention period:

```yaml
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMSingle
metadata:
  name: vm-database
  namespace: monitoring-system
spec:
  retentionPeriod: 12w
```

## [Add Persistent Storage](#add-persistent-storage)

Add persistent storage to the `VMSingle` configuration:

```yaml
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMSingle
metadata:
  name: vm-database
  namespace: monitoring-system
spec:
  retentionPeriod: 12w
  storage:
    accessModes:
      - ReadWriteOnce
    resources:
      requests:
        storage: 1Gi
    storageClassName: longhorn
```

## [Accessing the Service](#accessing-the-service)

Expose the service and access it via port-forwarding:

```bash
kubectl --namespace monitoring-system port-forward --address 0.0.0.0 service/vmsingle-vm-database 8429:8429
```

Visit `http://localhost:8429` to see the VictoriaMetrics home page.

## [Adding VictoriaMetrics to Grafana](#adding-victoriametrics-to-grafana)

In Grafana, go to Configuration / Data Sources and add a Prometheus data source. Use the following URL:

```
http://vmsingle-vm-database.monitoring-system.svc.cluster.local:8429
```

Save and test the configuration. Initially, there may be no data. Enable self-scraping by updating the `VMSingle` configuration:

```yaml
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMSingle
metadata:
  name: vm-database
  namespace: monitoring-system
spec:
  retentionPeriod: 90d
  extraArgs:
    selfScrapeInterval: 10s
  storage:
    accessModes:
      - ReadWriteOnce
    resources:
      requests:
        storage: 1Gi
    storageClassName: longhorn
```

This enables Grafana's metrics browser and allows you to explore metrics.

By following these steps, you can successfully install and configure VictoriaMetrics on Kubernetes using k3s and integrate it with Grafana for effective monitoring.
