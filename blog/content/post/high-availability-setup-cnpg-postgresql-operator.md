---
title: "High Availability Setup with CNPG PostgreSQL Operator"
date: 2025-01-15T22:45:00-05:00
draft: true
tags: ["Postgres", "High Availability", "Kubernetes", "CNPG"]
categories:
- Postgres
- Kubernetes
- High Availability
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to set up a highly available PostgreSQL cluster using the CloudNativePG (CNPG) PostgreSQL Operator in Kubernetes."
more_link: "yes"
url: "/high-availability-setup-cnpg-postgresql-operator/"
---

Ensuring high availability (HA) for your databases is crucial in modern production environments. PostgreSQL, a powerful open-source relational database, can achieve HA through various methods. In this guide, we'll walk you through setting up a highly available PostgreSQL cluster using the **CloudNativePG (CNPG) PostgreSQL Operator** in a Kubernetes environment.

<!--more-->

# [High Availability Setup with CNPG PostgreSQL Operator](#high-availability-setup-with-cnpg-postgresql-operator)

## Section 1: Introduction to CNPG PostgreSQL Operator

The **CloudNativePG (CNPG) PostgreSQL Operator** is a Kubernetes operator designed to manage PostgreSQL clusters efficiently. It automates essential tasks such as:

- **Provisioning**: Easy deployment of PostgreSQL clusters.
- **Scaling**: Seamless horizontal and vertical scaling.
- **Backup and Recovery**: Automated backups and disaster recovery solutions.
- **High Availability**: Ensures minimal downtime with failover capabilities.
- **Kubernetes Integration**: Natively integrates with Kubernetes resources and workflows.

## Section 2: Prerequisites

Before we begin, make sure you have the following:

- **Kubernetes Cluster**: Version 1.16 or higher.
- **kubectl**: Configured to interact with your Kubernetes cluster.
- **Helm**: The package manager for Kubernetes installed.

## Section 3: Installing the CNPG Operator

### Step 1: Add the CNPG Helm Repository

First, add the CNPG Helm repository to your Helm client and update it:

```bash
helm repo add cnpg https://cloudnative-pg.github.io/charts
helm repo update
```

### Step 2: Install the Operator

Install the CNPG Operator in a dedicated namespace (`cnpg-system`):

```bash
helm install cnpg cnpg/cloudnative-pg --namespace cnpg-system --create-namespace
```

## Section 4: Creating a Highly Available PostgreSQL Cluster

### Step 1: Define the Cluster Configuration

Create a YAML file named `postgres-cluster.yaml` with the following content:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: my-postgres-cluster
  namespace: default
spec:
  instances: 3
  primaryUpdateStrategy: unsupervised
  storage:
    size: 1Gi
  imageName: ghcr.io/cloudnative-pg/postgresql:13
  bootstrap:
    initdb:
      database: app_db
      owner: app_user
      secret:
        name: my-postgres-secret
  superuserSecret:
    name: my-postgres-secret
  monitoring:
    enabled: true
```

**Explanation:**

- **instances**: Specifies three instances for high availability.
- **primaryUpdateStrategy**: Set to `unsupervised` for automatic failover.
- **storage**: Defines storage size for each instance.
- **bootstrap**: Initializes the database with a specified name and owner.
- **superuserSecret**: References the secret containing superuser credentials.
- **monitoring**: Enables monitoring features.

### Step 2: Apply the Configuration

Deploy the PostgreSQL cluster:

```bash
kubectl apply -f postgres-cluster.yaml
```

## Section 5: Creating Secrets for PostgreSQL

Create a Kubernetes secret to store the PostgreSQL superuser credentials:

```bash
kubectl create secret generic my-postgres-secret \
  --from-literal=username=postgres \
  --from-literal=password=yourpassword
```

> **Note:** Replace `yourpassword` with a strong password.

## Section 6: Verifying the Deployment

### Check the Cluster Status

List the PostgreSQL clusters:

```bash
kubectl get clusters
```

You should see `my-postgres-cluster` listed.

### Check the Pods

List the pods to ensure all instances are running:

```bash
kubectl get pods
```

Expected output:

```
NAME                                     READY   STATUS    RESTARTS   AGE
my-postgres-cluster-1                    1/1     Running   0          2m
my-postgres-cluster-2                    1/1     Running   0          2m
my-postgres-cluster-3                    1/1     Running   0          2m
```

## Section 7: Accessing the PostgreSQL Cluster

### Step 1: Create a Service

Create a `Service` to expose the PostgreSQL instances. Save the following as `postgres-service.yaml`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: my-postgres-service
  namespace: default
spec:
  type: LoadBalancer
  ports:
    - port: 5432
      targetPort: 5432
  selector:
    cnpg.io/cluster: my-postgres-cluster
```

### Step 2: Apply the Service Configuration

Deploy the service:

```bash
kubectl apply -f postgres-service.yaml
```

### Step 3: Retrieve the Service IP

Get the external IP address:

```bash
kubectl get service my-postgres-service
```

Connect to the PostgreSQL cluster using the external IP and port `5432`.

## Section 8: Configuring Backup and Restore

The CNPG Operator supports automated backups. You can configure backups using object storage like S3.

### Step 1: Create S3 Credentials Secret

```bash
kubectl create secret generic my-s3-creds \
  --from-literal=accessKey=YOUR_ACCESS_KEY \
  --from-literal=secretKey=YOUR_SECRET_KEY
```

### Step 2: Update the Cluster Configuration

Modify `postgres-cluster.yaml` to include backup settings:

```yaml
backup:
  barmanObjectStore:
    destinationPath: s3://my-bucket/backups/
    s3Credentials:
      accessKeyId:
        name: my-s3-creds
        key: accessKey
      secretAccessKey:
        name: my-s3-creds
        key: secretKey
```

### Step 3: Apply the Updated Configuration

```bash
kubectl apply -f postgres-cluster.yaml
```

## Section 9: Monitoring and Maintenance

The operator enables monitoring features by default. You can integrate with Prometheus and Grafana for enhanced monitoring.

- **Check Cluster Events**:

  ```bash
  kubectl describe cluster my-postgres-cluster
  ```

- **View Logs**:

  ```bash
  kubectl logs my-postgres-cluster-1
  ```

## Section 10: Conclusion

By following this guide, you've set up a highly available PostgreSQL cluster in Kubernetes using the CNPG PostgreSQL Operator. This setup ensures:

- **Automatic Failover**: Minimal downtime in case of instance failure.
- **Scalability**: Easy to scale instances up or down.
- **Automated Backups**: Secure data with regular backups.
- **Ease of Management**: Simplified operations with Kubernetes-native tools.

