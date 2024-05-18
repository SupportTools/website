---
title: "How to Restrict Longhorn Access to Specific Nodes in K3s Cluster"
date: 2024-05-18
draft: false
tags: ["Kubernetes", "Longhorn"]
categories:
- Kubernetes
- Longhorn
author: "Matthew Mattox - mmattox@support.tools."
description: "Learn how to restrict Longhorn access to specific nodes in your K3s cluster to avoid replication issues."
more_link: "yes"
url: "/how-to-restrict-longhorn-in-k3s-cluster/"

## [How to Restrict Longhorn Access to Specific Nodes in K3s Cluster](#how-to-restrict-longhorn-access-to-specific-nodes-in-k3s-cluster)

After adding a Raspberry Pi node to your K3s cluster, you might want to restrict its participation in Longhorn replication to avoid any potential issues.

On a previous Raspberry Pi cluster, there were instances of corrupted Longhorn volumes possibly caused by network and storage performance limitations. Since upgrading to nodes with faster hardware, such as Core i3, Core i5, and AMD Ryzen 5500U, those issues have vanished. However, with the addition of the new Raspberry Pi node for your doorbell project, you'd like to prevent it from interacting with Longhorn.

The Longhorn documentation offers various methods to achieve this, including [taints and tolerations](https://longhorn.io/docs/1.5.2/advanced-resources/deploy/taint-toleration/) or instructing Longhorn to [utilize storage only on specific nodes](https://longhorn.io/kb/tip-only-use-storage-on-a-set-of-nodes/). One effective approach is through [node selectors](https://longhorn.io/docs/1.5.2/advanced-resources/deploy/node-selector/), allowing you to label and assign Longhorn workloads to chosen nodes.

## Detaching the Volumes

To implement this, start by detaching all Longhorn volumes, necessitating a restart. While there isn't a straightforward scripting method, accessing the Volumes page in the Longhorn UI enables scaling down the pertinent workloads manually.

For instance:

```sh
kubectl --namespace docker-registry scale deployment docker-registry --replicas 0
```

## Adding Node Labels

As the Longhorn documentation lacks explicit node label suggestions, creating custom labels becomes necessary.

```sh
kubectl label node roger-nuc0 differentpla.net/longhorn-storage-node=true
# ...and so on
```

## Configuring Node Selectors

Given the installation of Longhorn via Helm chart...

```sh
$ helm list -A | grep longhorn
```

...retrieve the values file for editing.

```sh
helm show values longhorn/longhorn > values.yaml
```

Subsequently, insert the desired `nodeSelector`s in the `values.yaml` file as per the instructions provided.

```yaml
# ...
longhornManager:
  # ...
  nodeSelector:
    differentpla.net/longhorn-storage-node: "true"
# ...
```

## Implementing the Changes

Apply the modified configuration using Helm to update Longhorn:

```sh
helm upgrade longhorn longhorn/longhorn --namespace longhorn-system --values values.yaml
```

This process might take some time but is crucial to ensure correct operation.

Upon completion, set the node selector for system-managed components via the Longhorn UI under `Settings > General > System Managed Components Node Selector`.

## Restoring Workloads

Afterward, scale up the workloads and wait for them to stabilize. If using ArgoCD for workload management, bring up the necessary services as needed.

```sh
kubectl --namespace gitea scale statefulset gitea-postgres --replicas 1
kubectl --namespace gitea scale statefulset gitea --replicas 1
```

For VictoriaMetrics, scaling up the vm-operator should automatically manage the agent and storage pods.

By following these steps, you can effectively restrict Longhorn access to specific nodes in your K3s cluster, optimizing performance and preventing potential issues.
