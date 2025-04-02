---
title: "RKE2 the Hard Way: Part 6 – Setting up kube-controller-manager and kube-scheduler as Static Pods"
description: "Configuring and deploying the Kubernetes Controller Manager and Scheduler as static pods managed by kubelet."
date: 2025-04-01T00:00:00-00:00
series: "RKE2 the Hard Way"
series_rank: 6
draft: false
tags: ["kubernetes", "rke2", "kube-controller-manager", "kube-scheduler", "static-pods"]
categories: ["Training", "RKE2"]
author: "Matthew Mattox"
description: "In Part 6 of RKE2 the Hard Way, we configure and deploy the Kubernetes Controller Manager and Scheduler as static pods managed by kubelet."
more_link: ""
---

## Part 6 – Setting up kube-controller-manager and kube-scheduler as Static Pods

In this part of the **"RKE2 the Hard Way"** training series, we will set up the **Kubernetes Controller Manager** (`kube-controller-manager`) and **Scheduler** (`kube-scheduler`) as static pods managed by kubelet on each of our nodes. 

- The Controller Manager runs controller processes that regulate the state of the cluster (such as replication controllers, node controllers, and service account controllers)
- The Scheduler is responsible for watching for newly created pods and assigning them to nodes

Using static pods for these components is a key design principle in RKE2, just like we did for etcd and kube-apiserver. This approach ensures high availability and automatic recovery in case of failures.

> ✅ **Assumption:** We've already set up etcd and kube-apiserver as static pods in [Part 4](/training/rke2-hard-way/04-setting-up-etcd-cluster/) and [Part 5](/training/rke2-hard-way/05-setting-up-kube-apiserver/).

---

### 1. Set Kubernetes Version

First, let's set the Kubernetes version to use in our pod manifests:

```bash
# Set Kubernetes version
KUBERNETES_VERSION="v1.32.3"
```

Unlike with kubelet, we don't need to download the actual binaries for kube-controller-manager and kube-scheduler since we'll be running them as containers within pods. The container images already include the necessary binaries.

---

### 2. Create Controller Manager Static Pod Manifest

Create the static pod manifest for the controller manager:

```bash
# Create kube-controller-manager static pod manifest
cat > /etc/kubernetes/manifests/kube-controller-manager.yaml << EOF
apiVersion: v1
kind: Pod
metadata:
  name: kube-controller-manager
  namespace: kube-system
  labels:
    component: kube-controller-manager
    tier: control-plane
spec:
  priorityClassName: system-node-critical
  hostNetwork: true
  containers:
  - name: kube-controller-manager
    image: registry.k8s.io/kube-controller-manager:${KUBERNETES_VERSION}
    command:
    - kube-controller-manager
    - --allocate-node-cidrs=true
    - --authentication-kubeconfig=/etc/kubernetes/controller-manager.kubeconfig
    - --authorization-kubeconfig=/etc/kubernetes/controller-manager.kubeconfig
    - --bind-address=0.0.0.0
    - --client-ca-file=/etc/kubernetes/ssl/ca.pem
    - --cluster-cidr=10.42.0.0/16
    - --cluster-name=kubernetes
    # Comment out the cluster-signing flags since we don't have the CA key file
    # - --cluster-signing-cert-file=/etc/kubernetes/ssl/ca.pem
    # - --cluster-signing-key-file=/etc/kubernetes/ssl/ca-key.pem
    - --controllers=*,bootstrapsigner,tokencleaner
    - --kubeconfig=/etc/kubernetes/controller-manager.kubeconfig
    - --leader-elect=true
    - --root-ca-file=/etc/kubernetes/ssl/ca.pem
    # We have service-account-key.pem, so we can use it
    - --service-account-private-key-file=/etc/kubernetes/ssl/service-account-key.pem
    - --service-cluster-ip-range=10.43.0.0/16
    - --use-service-account-credentials=true
    resources:
      requests:
        cpu: 200m
    volumeMounts:
    - name: k8s-certs
      mountPath: /etc/kubernetes/ssl
      readOnly: true
    - name: kubeconfig
      mountPath: /etc/kubernetes/controller-manager.kubeconfig
      readOnly: true
    livenessProbe:
      httpGet:
        host: 127.0.0.1
        path: /healthz
        port: 10257
        scheme: HTTPS
      initialDelaySeconds: 15
      timeoutSeconds: 15
  volumes:
  - name: k8s-certs
    hostPath:
      path: /etc/kubernetes/ssl
      type: DirectoryOrCreate
  - name: kubeconfig
    hostPath:
      path: /etc/kubernetes/controller-manager.kubeconfig
      type: FileOrCreate
EOF
```

---

### 3. Create Scheduler Static Pod Manifest

Create the static pod manifest for the scheduler:

```bash
# Create kube-scheduler static pod manifest
cat > /etc/kubernetes/manifests/kube-scheduler.yaml << EOF
apiVersion: v1
kind: Pod
metadata:
  name: kube-scheduler
  namespace: kube-system
  labels:
    component: kube-scheduler
    tier: control-plane
spec:
  priorityClassName: system-node-critical
  hostNetwork: true
  containers:
  - name: kube-scheduler
    image: registry.k8s.io/kube-scheduler:${KUBERNETES_VERSION}
    command:
    - kube-scheduler
    - --authentication-kubeconfig=/etc/kubernetes/scheduler.kubeconfig
    - --authorization-kubeconfig=/etc/kubernetes/scheduler.kubeconfig
    - --bind-address=0.0.0.0
    - --kubeconfig=/etc/kubernetes/scheduler.kubeconfig
    - --leader-elect=true
    - --secure-port=10259
    resources:
      requests:
        cpu: 100m
    volumeMounts:
    - name: kubeconfig
      mountPath: /etc/kubernetes/scheduler.kubeconfig
      readOnly: true
    - name: k8s-certs
      mountPath: /etc/kubernetes/ssl
      readOnly: true
    livenessProbe:
      httpGet:
        host: 127.0.0.1
        path: /healthz
        port: 10259
        scheme: HTTPS
      initialDelaySeconds: 15
      timeoutSeconds: 15
  volumes:
  - name: kubeconfig
    hostPath:
      path: /etc/kubernetes/scheduler.kubeconfig
      type: FileOrCreate
  - name: k8s-certs
    hostPath:
      path: /etc/kubernetes/ssl
      type: DirectoryOrCreate
EOF
```

---

### 4. Create the kubeconfig Files

Now, create the necessary kubeconfig files for the controller manager and scheduler:

```bash
# Note: We've commented out the controller-manager's cluster-signing flags
# since we don't have access to the CA key file in this setup. In a production
# environment, you would need to ensure the CA key is available for signing
# certificates.

# Generate controller manager kubeconfig using the kubernetes certificate
# (We're reusing the existing kubernetes certificate for simplicity)
kubectl config set-cluster kubernetes-the-hard-way \
  --certificate-authority=/etc/kubernetes/ssl/ca.pem \
  --embed-certs=true \
  --server=https://127.0.0.1:6443 \
  --kubeconfig=controller-manager.kubeconfig

kubectl config set-credentials system:kube-controller-manager \
  --client-certificate=/etc/kubernetes/ssl/kubernetes.pem \
  --client-key=/etc/kubernetes/ssl/kubernetes-key.pem \
  --embed-certs=true \
  --kubeconfig=controller-manager.kubeconfig

kubectl config set-context default \
  --cluster=kubernetes-the-hard-way \
  --user=system:kube-controller-manager \
  --kubeconfig=controller-manager.kubeconfig

kubectl config use-context default --kubeconfig=controller-manager.kubeconfig

# Set proper permissions on controller-manager kubeconfig
sudo chmod 644 controller-manager.kubeconfig
sudo mv controller-manager.kubeconfig /etc/kubernetes/

# Generate scheduler kubeconfig using the kubernetes certificate
# (We're reusing the existing kubernetes certificate for simplicity)
kubectl config set-cluster kubernetes-the-hard-way \
  --certificate-authority=/etc/kubernetes/ssl/ca.pem \
  --embed-certs=true \
  --server=https://127.0.0.1:6443 \
  --kubeconfig=scheduler.kubeconfig

kubectl config set-credentials system:kube-scheduler \
  --client-certificate=/etc/kubernetes/ssl/kubernetes.pem \
  --client-key=/etc/kubernetes/ssl/kubernetes-key.pem \
  --embed-certs=true \
  --kubeconfig=scheduler.kubeconfig

kubectl config set-context default \
  --cluster=kubernetes-the-hard-way \
  --user=system:kube-scheduler \
  --kubeconfig=scheduler.kubeconfig

kubectl config use-context default --kubeconfig=scheduler.kubeconfig

# Set proper permissions on scheduler kubeconfig
sudo chmod 644 scheduler.kubeconfig
sudo mv scheduler.kubeconfig /etc/kubernetes/
```

---

### 5. Verify the Components are Running

After placing these manifests in the `/etc/kubernetes/manifests/` directory, kubelet will automatically create the pods. Verify that they're running:

```bash
# Check that the pods are running
sudo crictl pods | grep -E 'kube-controller-manager|kube-scheduler'
sudo crictl ps | grep -E 'kube-controller-manager|kube-scheduler'
```

You can also check the logs using crictl (which doesn't require RBAC permissions):

```bash
# Find the container IDs
CONTROLLER_ID=$(sudo crictl ps | grep kube-controller-manager | awk '{print $1}')
SCHEDULER_ID=$(sudo crictl ps | grep kube-scheduler | awk '{print $1}')

# View the logs (if controller-manager is crashing, these logs will help diagnose)
sudo crictl logs $CONTROLLER_ID
sudo crictl logs $SCHEDULER_ID
```

If controller-manager is crashing, it's often due to authentication issues. Let's check the controller-manager's kubeconfig file to make sure it's properly configured:

```bash
# Check if the kubeconfig is properly set up
cat /etc/kubernetes/controller-manager.kubeconfig

# Make sure controller-manager is using the right credentials
# Verify that the cluster certificate is embedded in the kubeconfig
# Verify the controller-manager is using the system:kube-controller-manager user
```

---

### 6. Verify Controller Manager and Scheduler Functionality

Now that we have the controller manager and scheduler running, let's verify they're working correctly. First, we need to wait a few moments for them to become fully operational. Then we can run:

```bash
# Check the component statuses
kubectl get componentstatuses
```

You should see entries for the controller-manager and scheduler showing as "Healthy".

---

## Next Steps

Now that we have set up all the control plane components (etcd, kube-apiserver, kube-controller-manager, and kube-scheduler) as static pods managed by kubelet, we'll proceed to **Part 7** where we'll set up **kubelet and kube-proxy on worker nodes**.

👉 Continue to **[Part 7: Setting up kubelet and kube-proxy on Worker Nodes](/training/rke2-hard-way/07-setting-up-kubelet-and-kube-proxy/)**
