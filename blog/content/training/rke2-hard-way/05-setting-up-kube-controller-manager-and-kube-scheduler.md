---
title: "RKE2 the Hard Way: Part 5 - Setting up kube-controller-manager and kube-scheduler"
description: "Configuring and setting up the Kubernetes Controller Manager and Scheduler."
date: 2025-04-01
series: "RKE2 the Hard Way"
series_rank: 5
---

## Part 5 - Setting up kube-controller-manager and kube-scheduler

In this part of the "RKE2 the Hard Way" training series, we will configure and set up the Kubernetes Controller Manager (`kube-controller-manager`) and Scheduler (`kube-scheduler`). These are essential control plane components that manage cluster resources and schedule pods.

We will manually configure and start these components on one of our control plane nodes (node1 initially).

### 1. Create kube-controller-manager Configuration File

On control plane node1, create a kube-controller-manager configuration file named `kube-controller-manager.yaml` in `/etc/kubernetes/`.

```bash
sudo mkdir -p /etc/kubernetes/
```

Now, create `/etc/kubernetes/kube-controller-manager.yaml` on **node1** with the following content. **Replace the placeholders with the actual IP addresses and hostnames of your nodes.**

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: kube-controller-manager
  namespace: kube-system
spec:
  hostNetwork: true
  containers:
  - name: kube-controller-manager
    image: registry.k8s.io/kube-controller-manager:v1.29.2
    command:
    - kube-controller-manager
    - --bind-address=0.0.0.0
    - --client-ca-file=/etc/kubernetes/certs/ca.pem
    - --cluster-cidr=10.244.0.0/16
    - --cluster-signing-cert-file=/etc/kubernetes/certs/ca.pem
    - --cluster-signing-key-file=/etc/kubernetes/certs/ca-key.pem
    - --controllers=*, ডিজাবলইntrusionPreventionPolicyController, ডিজাবলইntrusionPreventionExemptPolicyController, ডিজাবলইntrusionPreventionProfilePolicyController, ডিজাবলইntrusionPreventionServerPolicyController, ডিজাবলইntrusionPreventionWorkloadPolicyController
    - --kubeconfig=/etc/kubernetes/config/kube-controller-manager.kubeconfig
    - --leader-elect=true
    - --port=10257
    - --requestheader-client-ca-file=/etc/kubernetes/certs/ca.pem
    - --root-ca-file=/etc/kubernetes/certs/ca.pem
    - --service-account-private-key-file=/etc/kubernetes/certs/service-account-key.pem
    - --service-cluster-ip-range=10.96.0.0/16
    - --use-service-account-credentials=true
    volumeMounts:
    - name: certs
      mountPath: /etc/kubernetes/certs
      readOnly: true
    - name: kubeconfig
      mountPath: /etc/kubernetes/config
      readOnly: true
  volumes:
  - name: certs
    hostPath:
      path: /etc/etcd/certs
      type: DirectoryOrCreate
  - name: kubeconfig
    hostPath:
      path: /etc/kubernetes/config
      type: DirectoryOrCreate
```

### 2. Create kube-scheduler Configuration File

On control plane node1, create a kube-scheduler configuration file named `kube-scheduler.yaml` in `/etc/kubernetes/`.

Now, create `/etc/kubernetes/kube-scheduler.yaml` on **node1** with the following content.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: kube-scheduler
  namespace: kube-system
spec:
  hostNetwork: true
  containers:
  - name: kube-scheduler
    image: registry.k8s.io/kube-scheduler:v1.29.2
    command:
    - kube-scheduler
    - --bind-address=0.0.0.0
    - --kubeconfig=/etc/kubernetes/config/kube-scheduler.kubeconfig
    - --leader-elect=true
    - --port=10259
  volumeMounts:
  - name: kubeconfig
    mountPath: /etc/kubernetes/config
    readOnly: true
  volumes:
  - name: kubeconfig
    hostPath:
      path: /etc/kubernetes/config
      type: DirectoryOrCreate
```

### 3. Create kubeconfig Files for Controller Manager and Scheduler

We need to create kubeconfig files for the controller manager and scheduler to securely connect to the kube-apiserver.

Create the directory for kubeconfig files:

```bash
sudo mkdir -p /etc/kubernetes/config
```

Create `/etc/kubernetes/config/kube-controller-manager.kubeconfig` on **node1**:

```yaml
apiVersion: v1
kind: Config
clusters:
- cluster:
    certificate-authority: /etc/kubernetes/certs/ca.pem
    server: https://kubernetes:6443
  name: kubernetes
contexts:
- context:
    cluster: kubernetes
    user: system:kube-controller-manager
  name: kube-controller-manager
current-context: kube-controller-manager
users:
- name: system:kube-controller-manager
  user:
    client-certificate: /etc/kubernetes/certs/kubernetes.pem
    client-key: /etc/kubernetes/certs/kubernetes-key.pem
```

Create `/etc/kubernetes/config/kube-scheduler.kubeconfig` on **node1**:

```yaml
apiVersion: v1
kind: Config
clusters:
- cluster:
    certificate-authority: /etc/kubernetes/certs/ca.pem
    server: https://kubernetes:6443
  name: kubernetes
contexts:
- context:
    cluster: kubernetes
    user: system:kube-scheduler
  name: kube-scheduler
current-context: kube-scheduler
users:
- name: system:kube-scheduler
  user:
    client-certificate: /etc/kubernetes/certs/kubernetes.pem
    client-key: /etc/kubernetes/certs/kubernetes-key.pem
```

**Note:**  These kubeconfig files specify:

*   `cluster.server`:  The address of the kube-apiserver (using the internal `kubernetes` DNS name which will resolve inside the cluster).
*   `user.client-certificate` and `user.client-key`: Paths to the Kubernetes API server certificate and key, which we are re-using for simplicity in this hard way guide. In a production setup, you would generate separate client certificates for controller-manager and scheduler.

### 4. Copy Certificates to Kubernetes Configuration Directory

Ensure the necessary certificates are in `/etc/kubernetes/certs` on **node1**:

```bash
sudo cp /etc/etcd/certs/ca.pem /etc/kubernetes/certs/ca.pem
sudo cp /etc/etcd/certs/kubernetes.pem /etc/kubernetes/certs/kubernetes.pem
sudo cp /etc/etcd/certs/kubernetes-key.pem /etc/kubernetes/certs/kubernetes-key.pem
sudo cp /etc/etcd/certs/service-account.pem /etc/kubernetes/certs/service-account.pem
sudo cp /etc/etcd/certs/service-account-key.pem /etc/kubernetes/certs/service-account-key.pem
```

### 5. Create kube-controller-manager Systemd Service

On control plane node1, create a systemd service file for kube-controller-manager to manage it as a service. Create `/etc/systemd/system/kube-controller-manager.service` with the following content:

```ini
[Unit]
Description=Kubernetes Controller Manager
Documentation=https://kubernetes.io/docs/reference/command-line-tools-reference/kube-controller-manager/
After=network-online.target kube-apiserver.service
Wants=kube-apiserver.service
Requires=kube-apiserver.service

[Service]
Type=notify
ExecStart=/usr/local/bin/kubectl apply -f /etc/kubernetes/kube-controller-manager.yaml
Restart=on-failure
RestartSec=5s
KillMode=process

[Install]
WantedBy=multi-user.target
```

### 6. Create kube-scheduler Systemd Service

On control plane node1, create a systemd service file for kube-scheduler to manage it as a service. Create `/etc/systemd/system/kube-scheduler.service` with the following content:

```ini
[Unit]
Description=Kubernetes Scheduler
Documentation=https://kubernetes.io/docs/reference/command-line-tools-reference/kube-scheduler/
After=network-online.target kube-apiserver.service
Wants=kube-apiserver.service
Requires=kube-apiserver.service

[Service]
Type=notify
ExecStart=/usr/local/bin/kubectl apply -f /etc/kubernetes/kube-scheduler.yaml
Restart=on-failure
RestartSec=5s
KillMode=process

[Install]
WantedBy=multi-user.target
```

### 7. Start and Enable kube-controller-manager and kube-scheduler Services

On control plane node1, start and enable the kube-controller-manager and kube-scheduler services:

```bash
sudo systemctl daemon-reload
sudo systemctl enable kube-controller-manager kube-scheduler
sudo systemctl start kube-controller-manager kube-scheduler
```

### 8. Verify kube-controller-manager and kube-scheduler

Check the status of the kube-controller-manager and kube-scheduler services on control plane node1:

```bash
sudo systemctl status kube-controller-manager kube-scheduler
```

You can also check the logs:

```bash
sudo journalctl -u kube-controller-manager -f
sudo journalctl -u kube-scheduler -f
```

At this stage, the core control plane components (etcd, kube-apiserver, kube-controller-manager, kube-scheduler) should be running on node1.  However, the cluster is still not fully functional as we haven't set up networking and worker nodes.

**Next Steps:**

In the next part, we will set up the kubelet and kube-proxy on our worker nodes (and control plane nodes as well, since all nodes will be workers in our setup).
