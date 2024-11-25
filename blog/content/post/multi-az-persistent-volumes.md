---
title: "Solving Persistent Volume Issues in Multi-AZ Kubernetes Clusters"
date: 2025-04-30T10:00:00-05:00
draft: false
tags: ["Kubernetes", "Persistent Volumes", "AWS", "Multi-AZ", "DevOps"]
categories:
- Kubernetes
- Cloud
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to resolve Persistent Volume (PV) conflicts in Kubernetes multi-AZ clusters using nodeSelector and StorageClasses."
more_link: "yes"
url: "/multi-az-persistent-volumes/"
---

Managing Persistent Volumes (PVs) in a multi-AZ Kubernetes cluster can be a challenging task. If you're running your Kubernetes cluster on AWS with EBS volumes as PVs, you've likely encountered the dreaded issue of evicted pods when they are rescheduled to nodes in different availability zones (AZs).  

In this guide, we’ll dive into why this issue occurs, its impact, and how to resolve it using Kubernetes features like `nodeSelector` and `volumeBindingMode`.

<!--more-->

---

## The Problem with Persistent Volumes in Multi-AZ Clusters  

EBS volumes in AWS are tied to specific AZs. They are zone-specific resources that cannot be accessed outside their originating zone.  

When Kubernetes reschedules a pod to a node in a different AZ, the pod cannot access the EBS volume because it is restricted to the original zone. This results in pods stuck in a pending state with errors like:  

```plaintext
Warning: 1 node(s) had volume node affinity conflict
```

This behavior can disrupt your applications and lead to unnecessary downtime.

---

## The Solution: Zone-Aware Scheduling  

### Use `nodeSelector` for Zone Affinity  

Kubernetes allows you to use `nodeSelector` to constrain pods to specific nodes based on their labels. By adding zone labels, you can ensure that pods are always scheduled in the same AZ as their associated volumes.  

Here’s an example deployment YAML with a `nodeSelector`:  

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: example-app
spec:
  replicas: 1
  selector:
    matchLabels:
      app: example-app
  template:
    metadata:
      labels:
        app: example-app
    spec:
      nodeSelector:
        topology.kubernetes.io/zone: us-west-2a
      containers:
        - name: app
          image: nginx
```

### Use StorageClass with `volumeBindingMode`  

To prevent pre-binding PVs to specific nodes before pods are scheduled, set `volumeBindingMode` to `WaitForFirstConsumer`. This delays volume binding until the pod is scheduled, ensuring the PV is created in the same AZ as the pod.  

Here’s an example StorageClass definition for AWS:  

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ebs-sc
provisioner: ebs.csi.aws.com
volumeBindingMode: WaitForFirstConsumer
parameters:
  type: gp3
```

### Use PersistentVolumeClaim  

Reference the StorageClass in your PersistentVolumeClaim to ensure that the volume is dynamically provisioned in the correct AZ.  

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: example-pvc
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: ebs-sc
  resources:
    requests:
      storage: 10Gi
```

---

## Limitations and Future Considerations  

While the above setup works for single replicas, it doesn’t solve issues for workloads requiring multiple replicas across different AZs. For such scenarios, you might need to explore solutions like:  

- **Replication**: Using application-level or storage-layer replication to maintain data availability across AZs.  
- **Shared Storage**: Solutions like Amazon EFS or third-party storage providers that support multi-AZ access.  

I’ll cover these approaches in detail in an upcoming blog post.

---

## Key Takeaways  

1. **Node Affinity**: Use `nodeSelector` to bind pods to specific AZs, ensuring compatibility with their associated PVs.  
2. **StorageClass Configuration**: Leverage `volumeBindingMode: WaitForFirstConsumer` for dynamic provisioning that aligns with pod scheduling.  
3. **Testing**: Always test these configurations in staging environments before deploying to production to avoid surprises.  

---

For more insights, feel free to connect with me on [LinkedIn](https://www.linkedin.com/in/matthewmattox/), [GitHub](https://github.com/mattmattox), or [BlueSky](https://bsky.app/profile/cube8021.bsky.social).  

Let me know if you’d like to dive deeper into advanced multi-AZ strategies!