---
title: "RKE2 the Hard Way: Part 6 - Setting up kubelet and kube-proxy on Worker Nodes"
description: "Configuring and setting up kubelet and kube-proxy on worker nodes."
date: 2025-04-01
series: "RKE2 the Hard Way"
series_rank: 6
---

## Part 6 - Setting up kubelet and kube-proxy on Worker Nodes

In this part of the "RKE2 the Hard Way" training series, we will configure and set up the kubelet and kube-proxy on our worker nodes (and control plane nodes as well, since all nodes will be workers in our setup).

*   **kubelet**: The primary node agent that runs on each node. It registers the node with the API server, watches for PodSpecs, creates pods, and reports node and pod status back to the control plane.
*   **kube-proxy**: A network proxy that runs on each node. It implements part of the Kubernetes Service concept by maintaining network rules on the node and performing connection forwarding or load balancing.

We will manually configure and start kubelet and kube-proxy on all three nodes.

### 1. Download kubelet and kube-proxy Binaries

We already downloaded the `kubelet` and `kube-proxy` binaries in Part 4 when we downloaded the Kubernetes server release binaries. They are located in `/usr/local/bin/`.

If you skipped Part 4, you need to download the Kubernetes server release binaries and extract `kubelet` and `kube-proxy` to `/usr/local/bin/` on each node as described in Part 4, Step 1.

### 2. Create kubelet Configuration File

On each node (node1, node2, node3), create a kubelet configuration file named `kubelet.yaml` in `/etc/kubernetes/`.

```bash
sudo mkdir -p /etc/kubernetes/
```

Now, create `/etc/kubernetes/kubelet.yaml` on **all nodes** with the following content:

```yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
authentication:
  anonymous:
    enabled: false
  webhook:
    cacheTTL: 2m0s
    enabled: true
  x509:
    clientCAFile: /etc/kubernetes/certs/ca.pem
authorization:
  mode: Webhook
  webhook:
    cacheAuthorizedTTL: 5m0s
    cacheUnauthorizedTTL: 30s
cgroupDriver: systemd
cgroupsPerQOS: true
clusterDNS:
- 10.96.0.10
clusterDomain: cluster.local
cpuManagerPolicy: none
cpuReserved: {}
eventRecordQPS: 0
evictionHard:
  imagefs.available: 15%
  memory.available: 100Mi
  nodefs.available: 10%
  nodefs.inodesFree: 5%
evictionPressureTransitionPeriod: 5m0s
failSwapOn: true
fileCheckFrequency: 20s
hairpinMode: promiscuous-bridge
healthzBindAddress: 127.0.0.1
healthzPort: 10248
httpCheckFrequency: 20s
imageGCHighThresholdPercent: 85
imageGCLowThresholdPercent: 80
imagePullProgressDeadline: 1m0s
loggingSeverity: 4
maxPods: 110
nodeLeaseDurationSeconds: 40
nodeStatusReportFrequency: 5m0s
nodeStatusUpdateFrequency: 10s
plegCacheExpiryDuration: 5m0s
podPidsLimit: -1
port: 10250
readOnlyPort: 0
registryBurst: 10
registryPullQPS: 5
resolvConf: /etc/resolv.conf
rotateCertificates: true
runtimeRequestTimeout: 2m0s
serializeImagePulls: true
serverTLSBootstrap: true
staticPodPath: /etc/kubernetes/manifests
streamingConnectionIdleTimeout: 4h0m0s
syncFrequency: 1m0s
volumeStats ক্যালকুলেশনFrequency: 1m0s
