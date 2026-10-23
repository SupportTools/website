---
title: "Kubernetes v1.37 DRA: Extended Resources GA, Device Taints"
date: 2026-11-05T09:00:00-05:00
draft: false
tags: ["Kubernetes", "v1.37", "Dynamic Resource Allocation", "DRA", "GPU", "Device Management", "Scheduling"]
categories:
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "What changed for Dynamic Resource Allocation in Kubernetes v1.37: extended resource requests served by DRA (GA), device taints with DeviceTaintRule, and new betas."
more_link: "yes"
url: "/kubernetes-v1-37-dra-extended-resources-device-taints/"
---

Kubernetes v1.37 (released 2026-08-26) is the release where Dynamic Resource Allocation (DRA) can replace a device plugin without touching existing workloads: a Pod that asks for `example.com/gpu: 1` the old way can now be served by a DRA driver, and that path is GA. Device taints, the standard `numaNode` attribute and per-device status in ResourceClaims are stable too. This page shows the YAML for each, plus the betas and alphas worth tracking.

<!--more-->

## Quick answer

What is stable (on by default) in v1.37:

| Feature | What it gives you |
|---|---|
| DRA extended resource support | `DeviceClass.spec.extendedResourceName` lets Pods keep requesting `example.com/gpu` in `resources.limits`; the scheduler allocates a DRA device for them, no ResourceClaim in the workload |
| Device taints and tolerations | Drivers or admins taint devices (`DeviceTaintRule`); claims opt in with tolerations; `NoExecute` evicts Pods using a device |
| ResourceClaim device status | `status.devices[]` reports per-device conditions and network data (interface name, MAC, IPs) |
| Standard `numaNode` attribute | `resource.kubernetes.io/numaNode` is a shared attribute name, so devices from different drivers can be aligned on one NUMA node |

Map an extended resource name onto a DRA device class:

```yaml {filename="deviceclass.yaml"}
apiVersion: resource.k8s.io/v1
kind: DeviceClass
metadata:
  name: gpu.example.com
spec:
  selectors:
  - cel:
      expression: device.driver == "gpu.example.com"
  extendedResourceName: example.com/gpu
```

An unchanged Pod spec is then satisfied through DRA:

```yaml {filename="pod.yaml"}
apiVersion: v1
kind: Pod
metadata:
  name: trainer
spec:
  containers:
  - name: trainer
    image: registry.example.com/trainer:1.4
    resources:
      limits:
        example.com/gpu: 1
```

Take one GPU out of service for maintenance without draining the node:

```yaml {filename="devicetaintrule.yaml"}
apiVersion: resource.k8s.io/v1
kind: DeviceTaintRule
metadata:
  name: gpu-0-maintenance
spec:
  deviceSelector:
    driver: gpu.example.com
    pool: worker-07
    device: gpu-0
  taint:
    key: example.com/maintenance
    value: firmware-update
    effect: NoSchedule     # None, NoSchedule or NoExecute
```

`NoSchedule` stops new allocations; `NoExecute` also evicts running Pods whose claims do not tolerate the taint. `PreferNoSchedule` is not valid for devices.

This post supersedes the [Kubernetes v1.33 DRA guide](/kubernetes-v1-33-dynamic-resource-allocation/), which covers the API as it was before DRA's core went GA.

## Where DRA stands in v1.37

The core DRA API (`resource.k8s.io/v1`: DeviceClass, ResourceClaim, ResourceClaimTemplate, ResourceSlice) has been GA since v1.34, and the DRA concepts page lists DRA as stable since v1.35. v1.37 adds `DeviceTaintRule` to the `v1` API, and the only DRA kind left outside `v1` in the v1.37 API reference is `ResourcePoolStatusRequest` (`v1alpha3`).

## Extended resources served by DRA (GA)

This is the migration feature. Clusters with existing device plugins and thousands of manifests that say `nvidia.com/gpu: 1` or `example.com/gpu: 1` can move the allocation backend to a DRA driver while workloads keep their current requests.

How it works:

1. The DRA driver publishes devices in ResourceSlices as usual.
2. A cluster admin sets `spec.extendedResourceName` on the DeviceClass that selects those devices.
3. When a Pod requests that extended resource, kube-scheduler creates the ResourceClaim for it and allocates a matching device.

From the API reference: the name must follow the extended resource name format, and it should be unique across DeviceClasses. If two classes use the same name, the most recently created class wins; if they were created at the same time, the class whose name sorts first wins.

The feature was accepted in v1.34, alpha in v1.35, beta in v1.36 and GA in v1.37. Quota tools need to know about it: Kueue, for example, documents using `extendedResourceName` as the quota key so devices are not counted twice (once for the extended resource and once for the generated claim).

## Device taints and tolerations (stable)

Taints can come from two places:

- the DRA driver, inside the ResourceSlice it publishes (for example, a driver marking a device unhealthy), or
- an admin, through a cluster-scoped `DeviceTaintRule` like the one in the quick answer, without reconfiguring the driver.

`deviceSelector` matches on `driver`, `pool` and `device`; all set fields must match, an empty selector matches every device. The rule's `status.conditions` includes `EvictionInProgress`, so you can watch a `NoExecute` drain:

```bash
kubectl get devicetaintrule gpu-0-maintenance -o jsonpath='{.status.conditions}'
```

A workload that is allowed to keep using tainted devices declares tolerations on the request, the same way Pods tolerate node taints:

```yaml {filename="claimtemplate.yaml"}
apiVersion: resource.k8s.io/v1
kind: ResourceClaimTemplate
metadata:
  name: gpu-burn-in
spec:
  spec:
    devices:
      requests:
      - name: gpu
        exactly:
          deviceClassName: gpu.example.com
          tolerations:
          - key: example.com/maintenance
            operator: Exists
            effect: NoSchedule
```

Toleration fields are `key`, `operator` (`Equal` or `Exists`), `value`, `effect` and, for `NoExecute`, `tolerationSeconds`. A claim can carry up to 16 tolerations per request.

## ResourceClaim device status (stable)

Drivers can write per-device status into `status.devices[]`: `conditions` (a `Ready` condition when the device is configured), driver-specific `data` up to 10 KiB, and `networkData` with `interfaceName`, `hardwareAddress` and `ips` in CIDR form. For SR-IOV NICs and other network devices this means you can see which interface and address a Pod got without reading driver logs:

```bash
kubectl get resourceclaim -n ml trainer-gpu-abc12 \
  -o jsonpath='{range .status.devices[*]}{.device}{"\t"}{.networkData.interfaceName}{"\t"}{.networkData.ips}{"\n"}{end}'
```

## The numaNode attribute (stable)

`resource.kubernetes.io/numaNode` is now a standard attribute name. When both the GPU driver and the NIC driver publish it, one constraint keeps the pair on the same NUMA node:

```yaml
spec:
  devices:
    requests:
    - name: gpu
      exactly:
        deviceClassName: gpu.example.com
    - name: nic
      exactly:
        deviceClassName: nic.example.com
    constraints:
    - requests: ["gpu", "nic"]
      matchAttribute: resource.kubernetes.io/numaNode
```

For drivers that publish NUMA information under a different name, see derived attributes below.

## Beta in v1.37

- **ResourceClaims for workloads** (`DRAWorkloadResourceClaims`, still disabled by default): Workloads and PodGroups can reference a ResourceClaim directly, so one claim can be shared by a whole group of Pods instead of hitting the old limit of 256 Pods reserving one claim.
- **Device attributes downward API:** drivers attach metadata when preparing a claim, and the framework writes it to a JSON file mounted into the container via CDI, so a workload (for example a KubeVirt VM launcher) can read a device's PCI address or MAC address directly.
- **Fractional consumable capacity** (`DRAFractionalCapacityRange`, beta): capacity request ranges accept fractional values for devices that are shared by capacity.

## Alpha in v1.37

- **Derived attributes** (`DRADerivedAttributes`): CEL expressions in a request compute virtual attributes, such as a NUMA index extracted from a vendor topology string, that constraints can match on. Up to 32 per request, and each one must be used in a constraint.
- **List-type attributes** (second alpha): an attribute can hold several values, for example a CPU adjacent to more than one PCIe root.
- **Node allocatable resource requests** (second alpha): DRA-managed CPU and memory count against node allocatable, so you no longer duplicate the request in the claim and the Pod spec.
- **Resource availability visibility** (second alpha): create a `ResourcePoolStatusRequest` (`resource.k8s.io/v1alpha3`) for a point-in-time snapshot of pool availability; delete and recreate it to refresh.
- **Optional node operations:** drivers can skip kubelet prepare and unprepare calls for allocations that need no node setup.
- **Device compatibility groups** (`DRADeviceCompatibilityGroups`): drivers tag partitions such as MIG and vGPU profiles so the scheduler rejects incompatible combinations up front.
- **PreQueueingHint for DRA** (`SchedulerPreQueueingHints`): ResourceClaim events requeue only the affected Pods instead of scanning every unschedulable Pod, which roughly doubled scheduling throughput in early benchmarks.

## Upgrading from v1.33-era DRA manifests

If you followed the v1.33 guide, three things changed:

1. Use `apiVersion: resource.k8s.io/v1`. The `v1beta1` and `v1alpha3` versions used in v1.33 examples are older API versions; move manifests to `v1` before they are removed.
2. In `v1`, a request wraps its fields in `exactly:` (or `firstAvailable:` for a prioritized list). Flat requests with `deviceClassName` directly under the request are the old beta shape.
3. Device taints moved from alpha to stable, and `DeviceTaintRule` is in `resource.k8s.io/v1`.

Check what your cluster serves before applying anything:

```bash
kubectl api-versions | grep resource.k8s.io
kubectl api-resources --api-group=resource.k8s.io
```

Related guides on this site:

- [Kubernetes v1.33 Dynamic Resource Allocation](/kubernetes-v1-33-dynamic-resource-allocation/), the earlier state of DRA.
- [GPU scheduling with the NVIDIA GPU Operator](/gpu-scheduling-nvidia-operator-kubernetes-enterprise-guide/) for the device plugin setup that DRA extended resources can replace.
- [GPU cluster management for AI workloads](/gpu-cluster-management-ai-workloads-nvidia-operator/).

Sources: [Kubernetes v1.37: DRA Updates](https://kubernetes.io/blog/2026/09/03/kubernetes-v1-37-dra-updates/), the [v1.37 release announcement](https://kubernetes.io/blog/2026/08/26/kubernetes-v1-37-release/), the [DeviceTaintRule](https://kubernetes.io/docs/reference/kubernetes-api/resource/device-taint-rule-v1/) and [ResourceClaim](https://kubernetes.io/docs/reference/kubernetes-api/resource/resource-claim-v1/) API references, and [KEP-5004](https://www.kubernetes.dev/resources/keps/5004/).
