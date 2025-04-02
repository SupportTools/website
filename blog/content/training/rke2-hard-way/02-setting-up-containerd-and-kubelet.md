---
title: "RKE2 the Hard Way: Part 2 - Setting up containerd and kubelet"
description: "Installing and configuring containerd and kubelet on nodes."
date: 2025-04-01T00:00:00-00:00
series: "RKE2 the Hard Way"
series_rank: 2
---

## Part 2 - Setting up containerd and kubelet

**IMPORTANT**: Part 2 has been reordered in the training series. Previously, Part 2 was about setting up Certificate Authority and TLS Certificates, but now Part 2 is about setting up containerd and kubelet. The Certificate Authority and TLS Certificates setup is now moved to Part 3.


In this part of the "RKE2 the Hard Way" training series, we will install and configure containerd, the container runtime, and kubelet, the node agent, on our nodes.

### 1. Install containerd

On each of your nodes (node01, node02, node03), install containerd. Follow the instructions on the [containerd documentation](https://containerd.io/docs/getting-started/).

For example, on Ubuntu 24.04:

```bash
sudo apt-get update
sudo apt-get install -y containerd
```

For SUSE Linux Enterprise Server 15 SP5:

```bash
sudo zypper install containerd
```

### 2. Configure containerd

Create a containerd configuration file named `config.toml` in `/etc/containerd/`.

```bash
sudo mkdir -p /etc/containerd/
sudo containerd config default > /etc/containerd/config.toml
```

Modify the `/etc/containerd/config.toml` file to set the cgroup driver to `systemd`. Open the file with a text editor:

```bash
sudo nano /etc/containerd/config.toml
```

Find the `[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]` section and change the `SystemdCgroup` value to `true`:

```toml
[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
  SystemdCgroup = true
```

Save and close the file.

### 3. Configure kubelet to use containerd

In Part 6, we will create the kubelet configuration file `kubelet.yaml`. In that file, we will configure kubelet to use containerd as the container runtime by setting the `containerRuntime: remote` and `containerRuntimeEndpoint: unix:///run/containerd/containerd.sock` parameters.

### 4. Start and Enable containerd Service

On each node, start and enable the containerd service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable containerd
sudo systemctl start containerd
```

### 5. Verify containerd Installation

Verify that containerd is running correctly:

```bash
sudo systemctl status containerd
```

You can also use the `crictl` command-line tool to check containerd status and container images/pods after kubelet is running.

### 6. Download kubelet and kube-proxy Binaries

Download the Kubernetes server release binaries. We will download `kubelet` and `kube-proxy` binaries in this step. You can find the latest release on the [Kubernetes releases page](https://github.com/kubernetes/kubernetes/releases). For this guide, we will use Kubernetes version `v1.32.0`.

```bash
KUBERNETES_VERSION=v1.32.0
wget https://github.com/kubernetes/kubernetes/releases/download/v${KUBERNETES_VERSION}/kubernetes-server-linux-amd64.tar.gz
tar xzf kubernetes-server-linux-amd64.tar.gz
cd kubernetes/server/bin
sudo mv kubelet kube-proxy /usr/local/bin/
cd ../../..
rm -rf kubernetes-server-linux-amd64.tar.gz kubernetes
```

These commands will:

*   Download the Kubernetes server binaries for Linux AMD64.
*   Extract the archive.
*   Move the `kubelet` and `kube-proxy` binaries to `/usr/local/bin/` so they are in your system's PATH.
*   Remove the downloaded archive and extracted directory.

**Repeat these steps on all three control plane nodes (node01, node02, and node03).**

### 7. Create kubelet Configuration File

On each node, create a kubelet configuration file named `kubelet.yaml` in `/etc/kubernetes/`.

```bash
sudo mkdir -p /etc/kubernetes/
```

Now, create `/etc/kubernetes/kubelet.yaml` on **all nodes** with the following content:

```yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
containerRuntime: remote
containerRuntimeEndpoint: unix:///run/containerd/containerd.sock
authentication:
  anonymous:
    enabled: false
  webhook:
    enabled: true
  x509:
    clientCAFile: /etc/kubernetes/certs/ca.pem
authorization:
  mode: Webhook
  webhook:
    cacheAuthorizedTTL: 5m0s
    cacheUnauthorizedTTL: 30s
cgroupDriver: systemd
clusterDNS:
- 10.96.0.10
clusterDomain: cluster.local
 HairpinMode: promiscuous-bridge
failSwapOn: false # set to false to allow swap to be used
```

### 8. Create kubelet Systemd Service

On each control plane node, create a systemd service file for kubelet to manage it as a service. Create `/etc/systemd/system/kubelet.service` with the following content:

```ini
[Unit]
Description=Kubernetes Kubelet
Documentation=https://kubernetes.io/docs/reference/command-line-tools-reference/kubelet/
After=network-online.target containerd.service
Requires=containerd.service

[Service]
Type=notify
ExecStart=/usr/local/bin/kubelet --config=/etc/kubernetes/kubelet.yaml --kubeconfig=/etc/kubernetes/config/kubelet.kubeconfig --v=2
Restart=on-failure
RestartSec=5s
KillMode=process

[Install]
WantedBy=multi-user.target
```

### 9. Start and Enable kubelet Service

On each control plane node, start and enable the kubelet service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable kubelet
sudo systemctl start kubelet
```

### 10. Verify kubelet Service

Check the status of the kubelet service on each control plane node:

```bash
sudo systemctl status kubelet
```

You can also check the logs:

```bash
sudo journalctl -u kubelet -f
```

**Next Steps:**

In the next part, Part 3, we will move to Part 3, Certificate Authority and TLS Certificates.
