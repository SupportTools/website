---
title: "Getting Started with Cluster Autoscaling in Kubernetes Using Rancher"
date: 2024-10-27T09:30:00-05:00
draft: false
tags: ["Kubernetes", "Autoscaler", "Cluster Autoscaler", "Rancher"]
categories:
- Kubernetes
- Autoscaling
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to implement Cluster Autoscaler in Kubernetes using Rancher and optimize cluster performance through automated scaling."
more_link: "yes"
url: "/cluster-autoscaling-rancher/"
---

Autoscaling Kubernetes clusters is essential to **optimizing performance and reducing costs**. **Cluster Autoscaler (CA)** helps you dynamically scale nodes to meet changing workloads, reducing resource waste while keeping applications reliable. In this post, we’ll explore **how CA works**, how it compares with **Horizontal Pod Autoscaler (HPA)** and **Vertical Pod Autoscaler (VPA)**, and walk through implementing CA in Kubernetes using **Rancher**.

---

## Understanding the Different Types of Autoscaling in Kubernetes  

Kubernetes supports three key types of autoscaling:

1. **Vertical Pod Autoscaler (VPA)**:  
   Adjusts the **CPU and memory requests** for individual pods to optimize resource usage. It ensures your applications always get the resources they need to run efficiently.

2. **Horizontal Pod Autoscaler (HPA)**:  
   Increases or decreases the **number of pod replicas** based on metrics like CPU usage or custom metrics. HPA helps maintain application performance during sudden spikes in demand.

3. **Cluster Autoscaler (CA)**:  
   **Scales the number of nodes** in your Kubernetes cluster to ensure it can accommodate the workloads running inside it. CA adds or removes nodes based on resource demands, optimizing cluster utilization.

While **VPA and HPA** manage resources at the pod level, **CA scales the entire cluster** to meet your application's changing needs.

---

## Prerequisites for Setting Up Cluster Autoscaler  

You can use **Rancher** to easily manage CA for your Kubernetes clusters. For this tutorial, you’ll need:

- **Rancher installed** (via K3s, Docker, Rancher Desktop, or a cloud provider)
- A **Linode account** for deploying and testing Cluster Autoscaler on **Linode Kubernetes Engine (LKE)**
- A personal **access token** from Linode to authenticate with the LKE API

---

## Deploying a Kubernetes Cluster with Rancher  

Once Rancher is installed, follow these steps to deploy a Kubernetes cluster with **Cluster Autoscaler enabled**:

1. **Log in to Rancher** and go to **Cluster Management**.
2. Activate the **LKE cluster driver** by selecting **Drivers → Activate**.
3. Navigate to **Clusters → Create**, choose **Linode LKE**, and provide the required information such as cluster name and access token.
4. Select your **region and Kubernetes version**, then configure **node pools**:
   - Example: One node pool with **2GB nodes** and another with **4GB nodes**.
5. Click **Create** to provision your cluster.

Rancher uses **Cluster API** to deploy and manage your cluster, providing seamless automation for resource scaling.

---

## Configuring Cluster Autoscaler on Rancher  

### Step 1: Create a Namespace for CA  

1. In Rancher, go to **Projects/Namespaces → Create Namespace**.
2. Create a new namespace for **Cluster Autoscaler**.

### Step 2: Create a Secret for Node Group Configuration  

Use the following YAML to create a **secret** for your CA configuration:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: cluster-autoscaler-cloud-config
  namespace: autoscaler
type: Opaque
stringData:
  cloud-config: |-
    [global]
    linode-token=<PERSONAL_ACCESS_TOKEN>
    lke-cluster-id=88612
    default-min-size-per-linode-type=1
    default-max-size-per-linode-type=5

    [nodegroup "g6-standard-1"]
    min-size=1
    max-size=4

    [nodegroup "g6-standard-2"]
    min-size=1
    max-size=2
```

This configuration defines the **Linode node groups** and their scaling limits. Replace `<PERSONAL_ACCESS_TOKEN>` with your Linode token.

### Step 3: Deploy Cluster Autoscaler  

In Rancher, use the **import YAML feature** to deploy the following CA components:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cluster-autoscaler
  namespace: autoscaler
spec:
  replicas: 1
  template:
    metadata:
      labels:
        app: cluster-autoscaler
    spec:
      containers:
      - name: cluster-autoscaler
        image: k8s.gcr.io/autoscaling/cluster-autoscaler:v1.26.1
        command:
          - ./cluster-autoscaler
          - --cloud-provider=linode
          - --cloud-config=/config/cloud-config
        volumeMounts:
          - name: cloud-config
            mountPath: /config
        volumes:
          - name: cloud-config
            secret:
              secretName: cluster-autoscaler-cloud-config
```

This deployment will create the **Cluster Autoscaler** and link it to the **Linode node groups** you defined in the secret.

---

## Testing Cluster Autoscaler  

### Step 1: Scale Up with a Workload  

Deploy the following **busybox workload** with 600 replicas:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: busybox-workload
spec:
  replicas: 600
  template:
    spec:
      containers:
      - name: busybox
        image: busybox
        command: ['sh', '-c', 'echo Demo Workload ; sleep 600']
```

Watch as **Cluster Autoscaler** detects the increased demand and **adds nodes** to your cluster to accommodate the workload.

### Step 2: Scale Down  

Delete the workload from the Rancher UI. **Cluster Autoscaler** will automatically remove unused nodes after a few minutes, optimizing resource usage.

---

## Best Practices for Cluster Autoscaler  

1. **Define Node Groups Carefully:** Organize node groups by workload type to optimize scaling.
2. **Monitor with Prometheus:** Use **Prometheus and Grafana** to monitor CA’s performance and detect scaling issues.
3. **Test Scaling Regularly:** Ensure that CA can respond to workload changes by running periodic tests.
4. **Set Clear Limits:** Define **min and max limits** for each node group to control scaling behavior.

---

## Conclusion  

Cluster Autoscaler is an essential tool for managing **Kubernetes clusters efficiently**. With Rancher, setting up and managing CA becomes simple, providing **automatic node scaling** that ensures your clusters can handle any workload. 

By leveraging **CA, Rancher, and Cluster API**, you can create scalable, cost-efficient infrastructure that adapts to your organization’s needs. Implementing autoscaling with Rancher ensures that your applications remain performant, while reducing manual intervention and minimizing costs.
