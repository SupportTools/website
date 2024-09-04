---
title: "How to Use One Helm Chart for EKS and GKE"  
date: 2024-10-17T19:26:00-05:00  
draft: false  
tags: ["Kubernetes", "Helm", "EKS", "GKE", "Cloud"]  
categories:  
- Kubernetes  
- Helm  
- Cloud  
author: "Matthew Mattox - mmattox@support.tools."  
description: "Learn how to use a single Helm chart to deploy applications on both EKS and GKE with cloud-specific configurations."  
more_link: "yes"  
url: "/use-one-helm-chart-eks-gke/"  
---

As Kubernetes grows in popularity, many organizations are deploying clusters across multiple cloud providers like **Amazon EKS (Elastic Kubernetes Service)** and **Google GKE (Google Kubernetes Engine)**. Managing applications across these environments can become complex, especially when dealing with cloud-specific configurations. **Helm** provides an excellent way to standardize deployments, but how can you create a single Helm chart that works for both EKS and GKE?

In this post, we’ll explore how to configure one Helm chart to deploy your applications on both **EKS** and **GKE** by using cloud-specific values and conditionals.

<!--more-->

### Why Use One Helm Chart for EKS and GKE?

Using a single Helm chart for both EKS and GKE brings several benefits:

- **Consistency**: You avoid managing separate Helm charts for each platform, reducing duplication and inconsistencies.
- **Scalability**: Managing one chart allows for easier scaling across environments.
- **Maintainability**: Centralizing changes in a single Helm chart simplifies version control and reduces maintenance efforts.

### Step 1: Identify Cloud-Specific Differences

First, identify the cloud-specific configurations that differ between EKS and GKE. Here are some common areas that typically require adjustments:

- **LoadBalancer Services**: EKS and GKE handle LoadBalancer services differently. EKS uses AWS ELB, while GKE uses Google Cloud Load Balancers.
- **IAM Roles**: EKS uses AWS-specific IAM roles, whereas GKE uses Google Cloud IAM.
- **Storage Classes**: EKS and GKE have different default storage classes.
- **Node Labels and Taints**: Node labels and taints can vary based on the cloud provider.

### Step 2: Create Conditional Logic in the Helm Chart

The key to using one Helm chart for both EKS and GKE is to implement **conditional logic** based on the target environment. You can define variables in your Helm chart’s `values.yaml` file to differentiate between EKS and GKE, and then apply them in your templates.

Here’s an example `values.yaml` file that defines cloud-specific settings:

```yaml
cloudProvider: eks  # Set to either "eks" or "gke"

eks:
  service:
    type: LoadBalancer
    annotations:
      service.beta.kubernetes.io/aws-load-balancer-type: "nlb"

gke:
  service:
    type: LoadBalancer
    annotations:
      cloud.google.com/load-balancer-type: "Internal"
```

### Step 3: Use `if` Statements in Your Helm Templates

In the templates, you can use `if` statements to apply the appropriate configurations based on the `cloudProvider` value.

For example, to handle the **LoadBalancer** service annotations:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: my-service
  annotations:
    {{- if eq .Values.cloudProvider "eks" }}
    service.beta.kubernetes.io/aws-load-balancer-type: {{ .Values.eks.service.annotations["service.beta.kubernetes.io/aws-load-balancer-type"] }}
    {{- else if eq .Values.cloudProvider "gke" }}
    cloud.google.com/load-balancer-type: {{ .Values.gke.service.annotations["cloud.google.com/load-balancer-type"] }}
    {{- end }}
spec:
  type: {{ .Values.cloudProvider | default "ClusterIP" }}
  ports:
    - port: 80
      targetPort: 8080
```

This template sets the **LoadBalancer** type and applies cloud-specific annotations depending on whether the deployment is targeting EKS or GKE.

### Step 4: Configure Storage Classes

If you are using cloud-specific **StorageClasses**, you can define them in your `values.yaml` and apply conditionals in the templates.

For example:

```yaml
eks:
  storageClass: "gp2"  # EKS uses AWS gp2 storage class

gke:
  storageClass: "standard"  # GKE uses Google Cloud standard storage class
```

In the PersistentVolumeClaim template:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-pvc
spec:
  storageClassName: {{ if eq .Values.cloudProvider "eks" }}{{ .Values.eks.storageClass }}{{ else if eq .Values.cloudProvider "gke" }}{{ .Values.gke.storageClass }}{{ end }}
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi
```

### Step 5: Define Cloud-Specific Node Selectors and Taints

Cloud providers may use different node labels and taints. You can set cloud-specific node selectors in the `values.yaml` file and add logic to your **Deployment** template to apply the correct configuration:

```yaml
eks:
  nodeSelector:
    node-role.kubernetes.io/worker: "true"

gke:
  nodeSelector:
    cloud.google.com/gke-nodepool: "default-pool"
```

In your **Deployment** template:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  template:
    spec:
      nodeSelector:
        {{ if eq .Values.cloudProvider "eks" }}
        {{ toYaml .Values.eks.nodeSelector | indent 8 }}
        {{ else if eq .Values.cloudProvider "gke" }}
        {{ toYaml .Values.gke.nodeSelector | indent 8 }}
        {{ end }}
```

### Step 6: Pass Cloud-Specific Values During Helm Deployment

When deploying the Helm chart to either EKS or GKE, you can override the default cloud provider setting by passing the appropriate `cloudProvider` value using the `--set` flag.

#### Deploy to EKS

```bash
helm install my-app ./my-helm-chart --set cloudProvider=eks
```

#### Deploy to GKE

```bash
helm install my-app ./my-helm-chart --set cloudProvider=gke
```

### Conclusion

Using a single Helm chart for both **EKS** and **GKE** is not only possible but highly beneficial for maintaining consistency and reducing complexity in multi-cloud environments. By using conditional logic in your Helm templates and providing cloud-specific values, you can create a flexible deployment strategy that works across different cloud providers.

This approach ensures that you only need to manage one Helm chart, simplifying version control, maintenance, and scaling across environments.
