---
title: "CKA Practice Questions"  
date: 2024-10-02T19:26:00-05:00  
draft: false  
tags: ["CKA", "Kubernetes", "Certification", "Practice Questions", "DevOps"]  
categories:  
- Kubernetes  
- Certification  
- CKA  
author: "Matthew Mattox - mmattox@support.tools."  
description: "Prepare for the Certified Kubernetes Administrator (CKA) exam with these practice questions covering essential Kubernetes concepts."  
more_link: "yes"  
url: "/cka-practice-questions/"  
---

Preparing for the Certified Kubernetes Administrator (CKA) exam requires a solid understanding of Kubernetes concepts, practical hands-on experience, and familiarity with the Kubernetes command-line interface. In this post, we’ll provide a series of practice questions designed to help you prepare for the CKA exam by covering key topics such as cluster setup, resource management, troubleshooting, and networking.

<!--more-->

### CKA Practice Questions

#### 1. **Create a Pod**

Create a pod named `nginx-pod` running the `nginx` container image in the default namespace.

```bash
kubectl run nginx-pod --image=nginx
```

#### 2. **Expose a Deployment as a Service**

You have a deployment named `webapp` with 3 replicas. Expose it as a service on port 80.

```bash
kubectl expose deployment webapp --type=ClusterIP --port=80
```

#### 3. **Set a Resource Request and Limit**

Create a pod named `busybox` with a container running the `busybox` image. Ensure it has a CPU request of `100m` and a memory limit of `64Mi`.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: busybox
spec:
  containers:
  - name: busybox
    image: busybox
    resources:
      requests:
        cpu: "100m"
      limits:
        memory: "64Mi"
```

#### 4. **Get the Logs of a Pod**

Retrieve the logs of a pod named `frontend`.

```bash
kubectl logs frontend
```

#### 5. **Create a Namespace**

Create a namespace named `dev`.

```bash
kubectl create namespace dev
```

#### 6. **Troubleshoot a Failing Pod**

A pod named `mysql` is failing to start. Check its status and identify the issue.

```bash
kubectl describe pod mysql
kubectl logs mysql
```

#### 7. **Scale a Deployment**

Scale a deployment named `api` to 5 replicas.

```bash
kubectl scale deployment api --replicas=5
```

#### 8. **Create a ConfigMap**

Create a ConfigMap named `app-config` with the key `app-name` set to `my-app`.

```bash
kubectl create configmap app-config --from-literal=app-name=my-app
```

#### 9. **Apply a Network Policy**

Create a NetworkPolicy that allows traffic to a pod labeled `app=frontend` only from pods in the same namespace labeled `app=backend`.

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-backend
spec:
  podSelector:
    matchLabels:
      app: frontend
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: backend
```

#### 10. **Backup and Restore ETCD**

Back up the ETCD cluster data and restore it from a backup.

- **Backup**:

```bash
ETCDCTL_API=3 etcdctl snapshot save /path/to/backup.db \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key
```

- **Restore**:

```bash
ETCDCTL_API=3 etcdctl snapshot restore /path/to/backup.db
```

#### 11. **Create a PersistentVolumeClaim**

Create a PersistentVolumeClaim (PVC) named `my-pvc` that requests `1Gi` of storage from the default storage class.

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-pvc
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
```

#### 12. **Set Cluster Autoscaling**

Enable horizontal pod autoscaling for a deployment named `backend` based on CPU usage, setting the target CPU utilization to 75%.

```bash
kubectl autoscale deployment backend --cpu-percent=75 --min=1 --max=10
```

#### 13. **Upgrade a Cluster**

Simulate upgrading a cluster’s control plane node. Drain the node, perform the upgrade, and mark the node as schedulable.

```bash
kubectl drain <node-name> --ignore-daemonsets
# Perform the upgrade
kubectl uncordon <node-name>
```

#### 14. **Debug a Failing Container**

Debug a pod named `debug-pod` that’s stuck in a crash loop by starting a shell in the pod.

```bash
kubectl exec -it debug-pod -- /bin/sh
```

#### 15. **Check Node Resources**

Get a detailed overview of CPU and memory usage for all nodes in the cluster.

```bash
kubectl top nodes
```

### Final Thoughts

These CKA practice questions cover some of the essential tasks you’ll need to master to pass the CKA exam. Practicing these tasks in a real Kubernetes environment will help you gain the confidence and expertise needed to manage Kubernetes clusters effectively. Remember to focus on both understanding the theory behind Kubernetes and getting hands-on experience with cluster management.
