---
title: "Setting Up the Linode (Akamai) Cloud Provider for RKE2"
date: 2026-10-26T00:00:00-05:00
draft: false
tags: ["kubernetes", "rke2", "cloud controller manager", "csi"]
categories: ["RKE2 Training"]
author: "Matthew Mattox"
description: "Run RKE2 on Linode (Akamai Cloud) with the Linode Cloud Controller Manager for NodeBalancer LoadBalancers and the Linode Block Storage CSI driver for persistent volumes."
url: "/training/rke2/linode-cloud-provider-rke2/"
---

## Introduction

RKE2 runs fine on plain Linode instances, but without a cloud provider the cluster knows nothing about the platform underneath it. `Service type=LoadBalancer` stays `<pending>` forever, nodes have no provider ID or region labels, and there is no way to get a Block Storage Volume attached to a pod.

Two upstream projects fill that gap:

- **Linode Cloud Controller Manager (CCM)**: sets node addresses and region/zone labels, and turns `LoadBalancer` services into **NodeBalancers**.
- **Linode Block Storage CSI driver**: provisions, attaches and resizes **Block Storage Volumes** for `PersistentVolumeClaims`.

This guide covers:

- Preparing the Linode instances (and the `localhost` hostname trap)
- Configuring RKE2 for an external cloud provider
- Installing the CCM with Helm
- Using NodeBalancer annotations
- Installing the CSI driver and using its StorageClasses

---

## Prerequisites

- Linode instances in a single region for the RKE2 nodes.
- A **Linode APIv4 Personal Access Token**. The CCM chart documents the token as needing all permissions. Treat it like a root credential for the account and keep it out of Git.
- `kubectl` and `helm` on your workstation.
- Kubernetes 1.22 or newer (the CCM's documented minimum; any current RKE2 release qualifies).

Note the region ID (for example `us-east`), since both charts need it:

```bash
linode-cli regions list --text --format id,label
```

---

## Step 1: Fix Node Hostnames Before Installing RKE2

Some Linode images boot with the hostname `localhost`. The RKE2 docs call this out specifically for Linode: every node registering as `localhost` collides, and the CCM cannot match nodes to instances.

Either set a real hostname on each instance:

```bash
hostnamectl set-hostname rke2-cp-1
```

or pin the node name in the RKE2 config (Step 2). Name the Kubernetes node the same as the Linode label. The CCM looks up instances by name, so a mismatch leaves nodes uninitialized.

---

## Step 2: Configure RKE2 for an External Cloud Provider

Disable RKE2's built-in cloud controller and tell every Kubernetes component that an external provider is in charge.

### Standalone RKE2 (`/etc/rancher/rke2/config.yaml`)

On server (control plane) nodes:

```yaml
node-name: rke2-cp-1
disable-cloud-controller: true
kube-apiserver-arg:
  - cloud-provider=external
kube-controller-manager-arg:
  - cloud-provider=external
kubelet-arg:
  - cloud-provider=external
```

On agent (worker) nodes:

```yaml
node-name: rke2-worker-1
kubelet-arg:
  - cloud-provider=external
```

### Rancher-provisioned clusters

In the cluster YAML, use `machineSelectorConfig` to apply the same settings by role:

```yaml
spec:
  rkeConfig:
    machineSelectorConfig:
      - config:
          disable-cloud-controller: true
          kube-apiserver-arg:
            - cloud-provider=external
          kube-controller-manager-arg:
            - cloud-provider=external
          kubelet-arg:
            - cloud-provider=external
        machineLabelSelector:
          matchExpressions:
            - key: rke.cattle.io/control-plane-role
              operator: In
              values:
                - 'true'
      - config:
          kubelet-arg:
            - cloud-provider=external
        machineLabelSelector:
          matchExpressions:
            - key: rke.cattle.io/worker-role
              operator: In
              values:
                - 'true'
```

With `cloud-provider=external`, the kubelet registers each node with the taint `node.cloudprovider.kubernetes.io/uninitialized=true:NoSchedule`. Ordinary workloads will not schedule until the CCM initializes the node, so install the CCM next.

---

## Step 3: Install the Linode Cloud Controller Manager

Add the chart repository:

```bash
helm repo add ccm-linode https://linode.github.io/linode-cloud-controller-manager/
helm repo update ccm-linode
```

Create `ccm-values.yaml`. Keep this file out of version control, or use a Secret you manage elsewhere (see the note below):

```yaml
apiToken: "<your-linode-api-token>"
region: "us-east"
```

Install into `kube-system`:

```bash
helm install ccm-linode \
  --namespace kube-system \
  -f ccm-values.yaml \
  ccm-linode/ccm-linode
```

The chart's default tolerations already cover the control-plane taint, `CriticalAddonsOnly`, and `node.cloudprovider.kubernetes.io/uninitialized`. It schedules on a fresh RKE2 cluster without extra values.

**Managing the token as a Secret:** the chart can read the token and region from an existing Secret through `secretRef` (defaults: name `ccm-linode`, keys `apiToken` and `region`). That fits clusters where secrets come from External Secrets, Sealed Secrets or Vault rather than Helm values. The Secret must live in the same namespace as the release.

### Verify

```bash
kubectl -n kube-system get pods -l app=ccm-linode
kubectl get nodes -o custom-columns=NAME:.metadata.name,PROVIDER:.spec.providerID,REGION:.metadata.labels.topology\.kubernetes\.io/region
kubectl describe nodes | grep -i taints
```

Every node should show a `linode://` provider ID and the region label, and the `uninitialized` taint should be gone. If a node keeps the taint, check the CCM logs (`kubectl -n kube-system logs -l app=ccm-linode`). The usual cause is a node name that does not match the Linode label (Step 1).

---

## Step 4: Expose Services with NodeBalancers

Any `Service` of `type: LoadBalancer` now gets a NodeBalancer:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: web
  annotations:
    service.beta.kubernetes.io/linode-loadbalancer-default-protocol: "http"
    service.beta.kubernetes.io/linode-loadbalancer-check-type: "http"
    service.beta.kubernetes.io/linode-loadbalancer-check-path: "/healthz"
spec:
  type: LoadBalancer
  selector:
    app: web
  ports:
    - port: 80
      targetPort: 8080
```

```bash
kubectl get svc web -w
```

The useful annotations, all prefixed `service.beta.kubernetes.io/linode-loadbalancer-`:

| Annotation | Default | Use |
|---|---|---|
| `default-protocol` | `tcp` | `tcp`, `udp`, `http` or `https` |
| `default-proxy-protocol` | `none` | `v1` or `v2` to pass client IPs to an ingress controller |
| `check-type` | `connection` (`none` for UDP) | `none`, `connection`, `http`, `http_body` |
| `check-path` / `check-body` | none | Path and expected body for HTTP checks |
| `throttle` | `0` | Connection throttle per client IP, `0` to `20` (`0` disables) |
| `firewall-id` | none | Attach an existing Cloud Firewall |
| `firewall-acl` | none | Have the CCM manage a firewall from a JSON `allowList` or `denyList` (not both) |
| `preserve` | `false` | Keep the NodeBalancer when the Service is deleted |
| `nodebalancer-id` | none | Adopt an existing NodeBalancer instead of creating one |
| `reserved-ipv4` | none | Use a reserved IPv4 address |
| `backend-vpc-name` / `backend-subnet-name` | none | Send backend traffic over a VPC subnet |
| `tags` | none | Comma-separated Linode tags for the NodeBalancer |

Two details trip people up:

- **Annotation values must be strings.** Quote numbers and booleans (`"true"`, `"20"`), or the API server rejects the manifest.
- **Proxy protocol must match on both ends.** If you set `default-proxy-protocol: "v2"` on the Service in front of ingress-nginx, enable `use-proxy-protocol` in the ingress controller too. Otherwise every request fails with a bad request or a broken connection.

For an ingress controller, `preserve: "true"` combined with `reserved-ipv4` keeps the public IP (and your DNS records) stable across reinstalls.

---

## Step 5: Install the Linode Block Storage CSI Driver

Add the repository and install, passing the same token and region:

```bash
helm repo add linode-csi https://linode.github.io/linode-blockstorage-csi-driver/
helm repo update linode-csi

helm install linode-csi-driver \
  --namespace kube-system \
  --set apiToken="${LINODE_API_TOKEN}" \
  --set region="${REGION}" \
  linode-csi/linode-blockstorage-csi-driver
```

```bash
kubectl -n kube-system get pods | grep csi-linode
kubectl get storageclass
```

The driver creates two StorageClasses with provisioner `linodebs.csi.linode.com`:

| StorageClass | Reclaim policy | Notes |
|---|---|---|
| `linode-block-storage-retain` | `Retain` | Cluster default |
| `linode-block-storage` | `Delete` | Volume is destroyed with the PVC |

The default is `Retain`, so deleting a PVC leaves the Volume in your account, and on your bill. That is the safe choice for databases. For scratch or CI workloads, request `linode-block-storage` explicitly, or clean up released PVs on a schedule.

Test with a claim. Block Storage has a **10Gi minimum**, so smaller requests are rounded up:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: linode-block-storage-retain
  resources:
    requests:
      storage: 10Gi
```

To grow a volume, raise `spec.resources.requests.storage` on the PVC. The StorageClasses allow expansion.

### Encrypted volumes

For encryption at rest, create your own StorageClass with the Block Storage encryption parameter:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: linode-block-storage-retain-encrypted
provisioner: linodebs.csi.linode.com
reclaimPolicy: Retain
allowVolumeExpansion: true
parameters:
  linodebs.csi.linode.com/encrypted: "true"
```

Encryption applies only to new, empty volumes, and not every region offers it. The driver returns an error rather than silently creating an unencrypted volume. The driver also supports LUKS encryption with a key from a Kubernetes Secret (`linodebs.csi.linode.com/luks-encrypted`), but then key rotation is your job.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Nodes stuck with `node.cloudprovider.kubernetes.io/uninitialized` | CCM not running, or node name differs from the Linode label |
| Several nodes named `localhost` | Hostname never set; see Step 1 |
| `LoadBalancer` stays `<pending>` | Token lacks permissions, wrong `region`, or CCM crashlooping; check `kubectl -n kube-system logs -l app=ccm-linode` |
| NodeBalancer shows all backends down | Health check type or path does not match the app; try `check-type: "connection"` first |
| PVC stays `Pending` | CSI controller cannot reach the API, or the region does not match the nodes |
| Volume will not attach | Volume and instance are in different regions, or the instance hit its attachment limit |

---

## Conclusion

With the CCM and the CSI driver installed, RKE2 on Linode behaves like a managed cluster: `LoadBalancer` services get NodeBalancers with real health checks and firewalls, and `PersistentVolumeClaims` get Block Storage Volumes that survive pod and node replacement.

The upstream projects are [linode-cloud-controller-manager](https://github.com/linode/linode-cloud-controller-manager) and [linode-blockstorage-csi-driver](https://github.com/linode/linode-blockstorage-csi-driver). Their `docs/` directories have the full annotation and parameter reference.

---

*Want more Kubernetes insights? Browse the [RKE2 Training](https://support.tools/categories/rke2-training/) series for expert insights!*
