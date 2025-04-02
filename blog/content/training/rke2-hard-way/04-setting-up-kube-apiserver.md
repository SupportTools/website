---
title: "RKE2 the Hard Way: Part 4 - Setting up the kube-apiserver"
description: "Configuring and setting up the Kubernetes API server."
date: 2025-04-01
series: "RKE2 the Hard Way"
series_rank: 4
---

## Part 4 - Setting up the kube-apiserver

In this part of the "RKE2 the Hard Way" training series, we will configure and set up the Kubernetes API server (`kube-apiserver`). The API server is the central component of the Kubernetes control plane. It exposes the Kubernetes API, serving as the frontend to the cluster and handling requests from `kubectl`, controllers, and other components.

We will manually download, configure, and start the kube-apiserver on each of our control plane nodes.

### 1. Download kube-apiserver Binaries

On each of your control plane nodes (node1, node2, node3), download the Kubernetes server release binaries. We will download `kube-apiserver`, `kube-controller-manager`, `kube-scheduler` and `kubectl` binaries in this step as they are released together. You can find the latest release on the [Kubernetes releases page](https://github.com/kubernetes/kubernetes/releases). For this guide, we will use Kubernetes version `v1.29.2`.

```bash
KUBERNETES_VERSION=v1.29.2
wget https://github.com/kubernetes/kubernetes/releases/download/v${KUBERNETES_VERSION}/kubernetes-server-linux-amd64.tar.gz
tar xzf kubernetes-server-linux-amd64.tar.gz
cd kubernetes/server/bin
sudo mv kube-apiserver kube-controller-manager kube-scheduler kubectl /usr/local/bin/
cd ../../..
rm -rf kubernetes-server-linux-amd64.tar.gz kubernetes
```

These commands will:

*   Download the Kubernetes server binaries for Linux AMD64.
*   Extract the archive.
*   Move the `kube-apiserver`, `kube-controller-manager`, `kube-scheduler`, and `kubectl` binaries to `/usr/local/bin/` so they are in your system's PATH.
*   Remove the downloaded archive and extracted directory.

**Repeat these steps on all three control plane nodes (node1, node2, and node3).**

### 2. Create kube-apiserver Configuration File

On each control plane node, create a kube-apiserver configuration file named `kube-apiserver.yaml` in `/etc/kubernetes/`. You will use the same configuration file on all nodes for the API server in this guide.

First, create the directory:

```bash
sudo mkdir -p /etc/kubernetes/
```

Now, create `/etc/kubernetes/kube-apiserver.yaml` on **all control plane nodes** with the following content. **Replace the placeholders with the actual IP addresses and hostnames of your nodes.**

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: kube-apiserver
  namespace: kube-system
spec:
  hostNetwork: true
  containers:
  - name: kube-apiserver
    image: registry.k8s.io/kube-apiserver:v1.29.2
    command:
    - kube-apiserver
    - --advertise-address=<NODE_PRIVATE_IP>
    - --allow-privileged=true
    - --apiserver-count=3
    - --audit-log-path=/var/log/kubernetes/audit.log
    - --audit-policy-file=/etc/kubernetes/audit-policy.yaml
    - --authorization-mode=Node,RBAC
    - --bind-address=0.0.0.0
    - --client-ca-file=/etc/kubernetes/certs/ca.pem
    - --cluster-admission-plugins=NamespaceLifecycle,LimitRanger,ServiceAccount,DefaultStorageClass,DefaultTolerationSeconds,DefaultIngressClass,MutatingAdmissionWebhook,ValidatingAdmissionWebhook,ResourceQuota,PodNodeSelector,PodTolerationRestriction,Priority,ExtendedResourceToleration,PersistentVolumeClaimResize,RuntimeClass,CertificateApproval,CertificateSigning,CertificateSubjectRestriction,DefaultPodTopologySpread, ডিজাবলইntrusionPreventionPolicy, ডিজাবলইntrusionPreventionExemptPolicy, ডিজাবলইntrusionPreventionProfilePolicy, ডিজাবলইntrusionPreventionServerPolicy, ডিজাবলইntrusionPreventionWorkloadPolicy
    - --enable-admission-plugins=NamespaceLifecycle,LimitRanger,ServiceAccount,DefaultStorageClass,DefaultTolerationSeconds,DefaultIngressClass,MutatingAdmissionWebhook,ValidatingAdmissionWebhook,ResourceQuota,PodNodeSelector,PodTolerationRestriction,Priority,ExtendedResourceToleration,PersistentVolumeClaimResize,RuntimeClass,CertificateApproval,CertificateSigning,CertificateSubjectRestriction,DefaultPodTopologySpread, ডিজাবলইntrusionPreventionPolicy, ডিজাবলইntrusionPreventionExemptPolicy, ডিজাবলইntrusionPreventionProfilePolicy, ডিজাবলইntrusionPreventionServerPolicy, ডিজাবলইntrusionPreventionWorkloadPolicy
    - --enable-bootstrap-token-auth=true
    - --etcd-cafile=/etc/etcd/certs/ca.pem
    - --etcd-certfile=/etc/kubernetes/certs/kubernetes.pem
    - --etcd-keyfile=/etc/kubernetes/certs/kubernetes-key.pem
    - --etcd-servers=https://<NODE1_PRIVATE_IP>:2379,https://<NODE2_PRIVATE_IP>:2379,https://<NODE3_PRIVATE_IP>:2379
    - --event-ttl=1h
    - --kubelet-client-certificate=/etc/kubernetes/certs/kubernetes.pem
    - --kubelet-client-key=/etc/kubernetes/certs/kubernetes-key.pem
    - --kubelet-preferred-address-types=InternalIP,ExternalIP,Hostname
    - --kubernetes-service-addresses=10.96.0.1/16
    - --requestheader-allowed-names=
    - --requestheader-client-ca-file=/etc/kubernetes/certs/ca.pem
    - --requestheader-extra-headers-prefix=X-Remote-Extra-
    - --requestheader-group-headers=X-Remote-Group
    - --requestheader-username-headers=X-Remote-User
    - --secure-port=6443
    - --service-account-issuer=https://kubernetes.default.svc.cluster.local
    - --service-account-key-file=/etc/kubernetes/certs/service-account.pem
    - --service-account-signing-key-file=/etc/kubernetes/certs/service-account-key.pem
    - --service-cluster-ip-range=10.96.0.0/16
    - --proxy-client-cert-file=/etc/kubernetes/certs/kubernetes.pem
    - --proxy-client-key-file=/etc/kubernetes/certs/kubernetes-key.pem
    volumeMounts:
    - name: certs
      mountPath: /etc/kubernetes/certs
      readOnly: true
    - name: audit-logs
      mountPath: /var/log/kubernetes
      readOnly: false
    - name: audit-policy
      mountPath: /etc/kubernetes/audit-policy.yaml
      readOnly: true
  volumes:
  - name: certs
    hostPath:
      path: /etc/etcd/certs
      type: DirectoryOrCreate
  - name: audit-logs
    hostPath:
      path: /var/log/kubernetes
      type: DirectoryOrCreate
  - name: audit-policy
    hostPath:
      path: /etc/kubernetes/audit-policy.yaml
      type: FileOrCreate
```

**Replace `<NODE_PRIVATE_IP>` placeholder with the private IP address of the current node in each file.**
**Replace `<NODE*_PRIVATE_IP>` placeholders in `--etcd-servers` with the private IP addresses of all etcd nodes.**

**Note:**

*   `hostNetwork: true`:  The API server pod will use the host network namespace.
*   `--advertise-address`:  The IP address the API server will advertise to other components.
*   `--etcd-servers`:  The URLs of our etcd cluster.
*   `--client-ca-file`, `--kubelet-client-certificate`, `--kubelet-client-key`, `--requestheader-client-ca-file`, `--proxy-client-cert-file`, `--proxy-client-key-file`:  Paths to our generated certificates for TLS authentication.
*   `--service-cluster-ip-range`, `--service-account-*`, `--kubernetes-service-addresses`: Define service network ranges and service account settings.
*   `--allow-privileged=true`: Allows privileged pods in the cluster.
*   `--authorization-mode=Node,RBAC`: Enables Node and RBAC authorization.
*   `--enable-admission-plugins` and `--cluster-admission-plugins`: Enables a set of recommended admission plugins.
*   `--audit-log-path` and `--audit-policy-file`: Enables audit logging. We will create the audit policy file in the next step.

### 3. Create Kubernetes API Audit Policy File

Create an audit policy file for the Kubernetes API server at `/etc/kubernetes/audit-policy.yaml` on **all control plane nodes**:

```yaml
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
- level: Metadata
  resources:
  - groups: [""]
    resources: ["events"]
- level: RequestResponse
  resources:
  - verbs: ["get", "list", "watch"]
    groups: [""]
    resources: ["configmaps", "secrets"]
- level: Request
  resources:
  - verbs: ["create", "update", "patch", "delete"]
    groups: [""]
    resources: ["pods", "pods/log"]
- level: RequestResponse
  resources:
  - verbs: ["*"]
    groups: ["*"]
    resources: ["*"]
  excludedNamespaces: ["kube-system", "kube-public"]
```

This policy defines different audit levels for various resource types and namespaces.

### 4. Copy Certificates to Kubernetes API Server Configuration Directory

Create the `/etc/kubernetes/certs` directory and copy the certificates to it on **all control plane nodes**:

```bash
sudo mkdir -p /etc/kubernetes/certs
sudo cp /etc/etcd/certs/ca.pem /etc/kubernetes/certs/ca.pem
sudo cp /etc/etcd/certs/kubernetes.pem /etc/kubernetes/certs/kubernetes.pem
sudo cp /etc/etcd/certs/kubernetes-key.pem /etc/kubernetes/certs/kubernetes-key.pem
sudo cp /etc/etcd/certs/service-account.pem /etc/kubernetes/certs/service-account.pem
sudo cp /etc/etcd/certs/service-account-key.pem /etc/kubernetes/certs/service-account-key.pem
```

### 5. Create kube-apiserver Systemd Service

On each control plane node, create a systemd service file for kube-apiserver to manage it as a service. Create `/etc/systemd/system/kube-apiserver.service` with the following content:

```ini
[Unit]
Description=Kubernetes API Server
Documentation=https://kubernetes.io/docs/reference/command-line-tools-reference/kube-apiserver/
After=network-online.target etcd.service
Wants=etcd.service
Requires=etcd.service

[Service]
Type=notify
ExecStart=/usr/local/bin/kubectl apply -f /etc/kubernetes/kube-apiserver.yaml
Restart=on-failure
RestartSec=5s
KillMode=process
TimeoutStartSec=30s

[Install]
WantedBy=multi-user.target
```

### 6. Start and Enable kube-apiserver Service

On each control plane node, start and enable the kube-apiserver service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable kube-apiserver
sudo systemctl start kube-apiserver
```

### 7. Verify kube-apiserver

Check the status of the kube-apiserver service on each control plane node:

```bash
sudo systemctl status kube-apiserver
```

You can also check the logs:

```bash
sudo journalctl -u kube-apiserver -f
```

At this stage, the API server might be running, but the cluster will not be fully functional until we set up other control plane components and networking.

**Next Steps:**

In the next part, we will set up the `kube-controller-manager` and `kube-scheduler`.
