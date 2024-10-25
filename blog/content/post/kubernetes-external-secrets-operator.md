---
title: "Kubernetes Secrets Management: Level Up with External Secrets Operator"
date: 2024-10-28T10:00:00-05:00
draft: false
tags: ["Kubernetes", "Secrets Management", "External Secrets Operator", "AWS", "Helm"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to manage Kubernetes secrets efficiently using the External Secrets Operator, integrating external secret management systems like AWS Secrets Manager."
more_link: "yes"
url: "/kubernetes-external-secrets-operator/"
---

Managing **secrets**—such as API keys, passwords, and certificates—is essential for running **secure Kubernetes environments**. While Kubernetes provides built-in support for **Secrets**, these are limited when it comes to **multi-cluster deployments** or integrations with **external secret management systems**. This is where the **External Secrets Operator (ESO)** comes into play. 

ESO allows you to **synchronize secrets** from external systems like **AWS Secrets Manager** directly into **Kubernetes Secrets**, improving security and streamlining operations.

---

## Prerequisites  

Before you begin, ensure you have the following in place:
- **Kubernetes cluster** (version 1.19 or later)  
- **kubectl** configured for your cluster  
- **Helm 3 or later** installed locally  
- **AWS account** with access to **Secrets Manager**

---

## Step 1: Installing External Secrets Operator  

To get started, install the **External Secrets Operator** using Helm.

### 1.1 Add the External Secrets Helm Repository  

```bash
helm repo add external-secrets https://charts.external-secrets.io
helm repo update
```

### 1.2 Install External Secrets Operator  

```bash
helm install external-secrets \
  external-secrets/external-secrets \
  --namespace external-secrets \
  --create-namespace \
  --set installCRDs=true
```

This command creates a dedicated namespace and installs the operator along with the necessary **Custom Resource Definitions (CRDs)**.

---

## Step 2: Configuring IAM for AWS Integration  

### 2.1 Associate OIDC Provider  

If you’re using **EKS**, associate your cluster with the **OIDC provider**:

```bash
eksctl utils associate-iam-oidc-provider --cluster=your-cluster-name --approve
```

### 2.2 Create an IAM Role  

1. Go to the **AWS IAM Console** and create a **role** with the following:
   - **Trusted entity:** Web identity  
   - **Select OIDC provider:** Your cluster’s OIDC  
   - **Attach Secrets Manager access policies**

2. Name the role, create it, and **copy the role ARN**.

---

## Step 3: Create a Service Account for External Secrets Operator  

Create a **ServiceAccount** in Kubernetes to connect the cluster to your IAM role.

Create a file called `sa.yaml`:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: external-secrets-operator
  namespace: external-secrets
  annotations:
    eks.amazonaws.com/role-arn: your-iam-role-arn
```

Apply the configuration:

```bash
kubectl apply -f sa.yaml
```

---

## Step 4: Set Up a SecretStore for AWS  

Create a `ss.yaml` file to define the **SecretStore**, which tells ESO how to interact with AWS Secrets Manager.

```yaml
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: aws-secrets-manager
  namespace: external-secrets
spec:
  provider:
    aws:
      service: SecretsManager
      region: your-aws-region
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets-operator
```

Apply the configuration:

```bash
kubectl apply -f ss.yaml
```

---

## Step 5: Create and Synchronize External Secrets  

Define an **ExternalSecret** to fetch and synchronize a secret from AWS.

Create a file named `secret.yaml`:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: secret
  namespace: external-secrets
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secrets-manager
    kind: SecretStore
  target:
    name: secrets-manager-secret
    creationPolicy: Owner
  data:
    - secretKey: aws-secretsmanager
      remoteRef:
        key: your-secret-name
        property: your-secret-key
```

Apply the configuration:

```bash
kubectl apply -f secret.yaml
```

Verify the secret creation:

```bash
kubectl get secret secrets-manager-secret -n external-secrets
```

---

## Step 6: Use External Secrets in Deployments  

To utilize the managed secrets in your Kubernetes deployments, add the following block to your **Deployment manifest**:

```yaml
- name: AWS_SECRET
  valueFrom:
    secretKeyRef:
      name: secrets-manager-secret
      key: aws-secretsmanager
```

This block pulls the **AWS secret** into your deployment, ensuring your application can access it securely.

---

## Conclusion  

The **External Secrets Operator** is a powerful tool for **managing Kubernetes secrets** by integrating with external systems like AWS Secrets Manager. It automates the synchronization of secrets, ensuring your applications always have the latest credentials. By centralizing secret management and automating updates, ESO enhances **security** and simplifies **Kubernetes operations**. 

With ESO in place, your clusters remain secure, scalable, and easy to manage.
