---
title: "Monitoring PostgreSQL Using PostgreSQL Exporter on Kubernetes"
date: 2025-06-15T18:15:00-05:00
draft: true
tags: ["Postgres", "Kubernetes", "Helm", "PostgreSQL", "Monitoring"]
categories:
- Postgres
- Kubernetes
- Monitoring
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to monitor PostgreSQL databases using PostgreSQL Exporter on Kubernetes for enhanced performance and reliability."
more_link: "yes"
url: "/monitoring-postgresql-exporter-kubernetes/"
---

Effective database monitoring is crucial for maintaining the performance, availability, and reliability of modern applications. **PostgreSQL**, a widely used open-source relational database, can be efficiently monitored using tools like **PostgreSQL Exporter**. In this guide, we'll walk you through setting up PostgreSQL monitoring using PostgreSQL Exporter on a Kubernetes cluster.

<!--more-->

# [Monitoring PostgreSQL Using PostgreSQL Exporter on Kubernetes](#monitoring-postgresql-using-postgresql-exporter-on-kubernetes)

## Section 1: Introduction

As applications scale, keeping an eye on your database metrics becomes increasingly important. PostgreSQL Exporter serves as a bridge between PostgreSQL and Prometheus, enabling you to collect and visualize database metrics seamlessly.

## Section 2: Prerequisites

Before we begin, ensure you have the following:

- **Kubernetes Cluster**: A running Kubernetes cluster.
- **kubectl**: Configured to interact with your cluster.
- **PostgreSQL Instance**: Running on your Kubernetes cluster.
- **Prometheus and Grafana**: Set up in your Kubernetes cluster for monitoring and visualization.

## Section 3: Deploying PostgreSQL Exporter

### Step 1: Create a ConfigMap for PostgreSQL Exporter Configuration

We'll start by creating a `ConfigMap` to store custom queries for the PostgreSQL Exporter.

**Create a file named `postgres-exporter-configmap.yaml` with the following content:**

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: postgres-exporter-config
data:
  queries.yaml: |
    pg_stat_activity:
      query: "SELECT * FROM pg_stat_activity;"
      metrics:
        - usage: "LABEL"
          description: "Name of the user connected to the database"
          key: "usename"
```

**Apply the ConfigMap:**

```bash
kubectl apply -f postgres-exporter-configmap.yaml
```

### Step 2: Deploy PostgreSQL Exporter as a Deployment

Next, we'll create a `Deployment` for the PostgreSQL Exporter.

**Create a file named `postgres-exporter-deployment.yaml` with the following content:**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres-exporter
spec:
  replicas: 1
  selector:
    matchLabels:
      app: postgres-exporter
  template:
    metadata:
      labels:
        app: postgres-exporter
    spec:
      containers:
        - name: postgres-exporter
          image: wrouesnel/postgres_exporter
          args:
            - "--extend.query-path=/etc/postgres_exporter/queries.yaml"
          env:
            - name: DATA_SOURCE_NAME
              value: "postgresql://postgres:yourpassword@your-postgres-service:5432/postgres?sslmode=disable"
          volumeMounts:
            - name: config-volume
              mountPath: /etc/postgres_exporter
      volumes:
        - name: config-volume
          configMap:
            name: postgres-exporter-config
```

**Replace the following placeholders:**

- `yourpassword`: Your PostgreSQL password.
- `your-postgres-service`: The service name of your PostgreSQL instance.

**Apply the Deployment:**

```bash
kubectl apply -f postgres-exporter-deployment.yaml
```

### Step 3: Expose PostgreSQL Exporter via a Service

We'll create a `Service` to expose the PostgreSQL Exporter metrics.

**Create a file named `postgres-exporter-service.yaml` with the following content:**

```yaml
apiVersion: v1
kind: Service
metadata:
  name: postgres-exporter
spec:
  ports:
    - port: 9187
      targetPort: 9187
  selector:
    app: postgres-exporter
```

**Apply the Service:**

```bash
kubectl apply -f postgres-exporter-service.yaml
```

## Section 4: Configuring Prometheus to Scrape Metrics

To collect the metrics exposed by PostgreSQL Exporter, we'll configure Prometheus to scrape them.

### Step 1: Update Prometheus ConfigMap

Edit your Prometheus `ConfigMap` to add the PostgreSQL Exporter as a scrape target.

**Add the following job definition:**

```yaml
- job_name: 'postgres-exporter'
  static_configs:
    - targets: ['postgres-exporter.default.svc.cluster.local:9187']
```

**Apply the updated ConfigMap:**

```bash
kubectl apply -f prometheus-configmap.yaml
```

### Step 2: Restart Prometheus

Restart the Prometheus pod to load the new configuration.

```bash
kubectl delete pod -l app=prometheus
```

## Section 5: Visualizing Metrics in Grafana

With the metrics being scraped by Prometheus, we can now visualize them using Grafana.

### Step 1: Import a PostgreSQL Dashboard

In the Grafana UI:

1. Navigate to **Dashboards > Import**.
2. Use a dashboard ID from Grafana's repository, such as **9628** for a PostgreSQL overview.
3. Select your Prometheus data source.
4. Click **Import**.

### Step 2: Explore the Dashboard

The imported dashboard will display various PostgreSQL metrics, such as:

- Active connections
- Query performance
- Cache hit ratios
- CPU and memory usage

## Section 6: Conclusion

By following this guide, you've set up a robust monitoring system for your PostgreSQL database on Kubernetes. Monitoring your database helps you proactively identify performance bottlenecks and ensure high availability for your applications.
