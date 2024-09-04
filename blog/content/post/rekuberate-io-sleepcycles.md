---
title: "Reclaim Your Unused Kubernetes Resources with rekuberate-io/sleepcycles"  
date: 2024-10-06T19:26:00-05:00  
draft: false  
tags: ["Kubernetes", "Rekuberate", "Cost Optimization", "Resource Management", "DevOps"]  
categories:  
- Kubernetes  
- DevOps  
- Sustainability  
author: "Matthew Mattox - mmattox@support.tools."  
description: "Learn how rekuberate-io/sleepcycles can optimize your Kubernetes workloads by automatically scheduling shutdowns and wake-ups, reducing resource costs, and lowering your carbon footprint."  
more_link: "yes"  
url: "/rekuberate-io-sleepcycles/"  
---

In a world where efficient resource management is key to running modern cloud-native applications, **rekuberate-io/sleepcycles** provides a sophisticated solution to reclaim unused Kubernetes resources. By defining **sleep and wake-up cycles** for your Kubernetes workloads, you can automatically schedule resource shutdowns and wake-ups, optimizing cluster utilization, reducing costs, and contributing to a greener IT infrastructure.

<!--more-->

### What is rekuberate-io/sleepcycles?

The **rekuberate-io/sleepcycles** project is a custom Kubernetes controller that automates the shutdown and wake-up of various Kubernetes resources, such as **Deployments**, **StatefulSets**, **CronJobs**, and **HorizontalPodAutoscalers**. This allows organizations to:

- **Optimize Resource Usage**: Schedule non-essential workloads during off-peak hours, reducing unnecessary resource consumption.
- **Lower Operational Costs**: By reducing the active hours of workloads, users can save up to 368 hours of resource usage per month.
- **Reduce Power Consumption and Carbon Footprint**: Cutting down active workloads helps reduce energy usage, making your Kubernetes cluster more environmentally friendly.

### Why You Need rekuberate-io/sleepcycles

Kubernetes is an efficient container orchestrator, but managing the power and resource consumption of workloads is still a challenge. For organizations looking to **reduce costs** while **lowering their environmental impact**, rekuberate-io/sleepcycles offers a simple and effective solution.

Imagine shutting down non-essential workloads during nights and weekends, automatically resuming them during business hours. This automated management of Kubernetes resources can help **depressurize your cluster**, **schedule resource-hungry tasks** at times that won't disrupt daily operations, and provide significant cost savings by scaling resources dynamically.

### How rekuberate-io/sleepcycles Works

At the heart of rekuberate-io/sleepcycles is the **SleepCycle Custom Resource (CR)**, which defines schedules for shutting down and waking up Kubernetes resources. Each **SleepCycle** has the following key properties:

- **shutdown**: The cron expression defining when to scale down the resource.
- **enabled**: A flag to enable or disable the SleepCycle.
- **wakeup**: The cron expression defining when to scale the resource back up.

Here’s an example **SleepCycle** configuration:

```yaml
apiVersion: core.rekuberate.io/v1alpha1
kind: SleepCycle
metadata:
  name: sleepcycle-app-1
  namespace: app-1
spec:
  shutdown: "1/2 * * * *"
  shutdownTimeZone: "Europe/Athens"
  wakeup: "*/2 * * * *"
  wakeupTimeZone: "Europe/Dublin"
  enabled: true
```

In this example, the workload is scheduled to shut down on odd minutes and wake up on even minutes, providing a simple way to test and demo the process.

#### Key Features

1. **Automatic Scheduling**: The **sleepcycle-controller** watches all SleepCycle resources and provisions Kubernetes CronJobs to automate shutdowns and wake-ups.
2. **Scale Kubernetes Workloads**: It scales **Deployments** and **StatefulSets** down to zero replicas when shutting down, and restores their previous state during wake-up. **HorizontalPodAutoscalers** are scaled down to one replica.
3. **Easy Integration**: Any Kubernetes resource can be managed by adding a simple label (`rekuberate.io/sleepcycle`) to the workload. For example:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-1
  namespace: app-1
  labels:
    rekuberate.io/sleepcycle: sleepcycle-app-1
spec:
  replicas: 9
  template:
    spec:
      containers:
        - name: app-1
          image: traefik/whoami
```

### Integration with ArgoCD

If you use GitOps tools like **ArgoCD** to manage Kubernetes resources, **rekuberate-io/sleepcycles** can integrate seamlessly. However, to avoid conflicts, you’ll need to **disable self-healing** in ArgoCD’s sync policies. This prevents ArgoCD from automatically reverting the changes made by SleepCycles. You can still use manual or automatic sync policies without self-healing to keep the systems in harmony.

### Future Developments: rekuberate-io/carbon

A future addition to the rekuberate ecosystem is **rekuberate-io/carbon**, a custom Kubernetes controller that will measure the power consumption of individual Pods and calculate their carbon footprint. By correlating this data with carbon intensity metrics from the data center, the platform will help optimize workload scheduling for **carbon-aware computing**.

This tool will enable Kubernetes clusters to not only be cost-effective but also environmentally conscious, helping organizations reduce their carbon emissions over time.

### How to Get Started

To start using **rekuberate-io/sleepcycles**, you’ll need a Kubernetes cluster. You can set up a local cluster using [KIND](https://sigs.k8s.io/kind) or [K3D](https://k3d.io), or deploy it to a remote cluster. The project offers a Helm chart for easy deployment, and sample workloads are provided to help you test SleepCycles in your environment.

#### Installation via Helm

```bash
helm repo add sleepcycles https://rekuberate-io.github.io/sleepcycles/
helm repo update
helm install sleepcycles sleepcycles/sleepcycles -n rekuberate-system --create-namespace
```

Once installed, you can create namespaces, apply the provided sample manifests, and start reclaiming your unused Kubernetes resources.

```bash
kubectl create namespace app-1
kubectl create namespace app-2
kubectl apply -f config/samples
```

### Conclusion

**rekuberate-io/sleepcycles** is a powerful and flexible tool that allows you to automate the management of Kubernetes resources, helping you reduce costs, improve efficiency, and lower your carbon footprint. By integrating with your existing Kubernetes infrastructure and tools like ArgoCD, it offers a seamless way to manage resource-heavy workloads during off-peak times, ensuring your cluster runs optimally without manual intervention.

For organizations looking to optimize their cloud-native environments, rekuberate-io/sleepcycles provides a cutting-edge solution that balances resource efficiency and environmental sustainability.
