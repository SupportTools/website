---
title: "Fixing Longhorn Volumes That Refuse to Attach"
date: 2023-10-13T13:30:00-05:00
draft: false
tags: ["Longhorn", "Kubernetes", "Troubleshooting"]
categories:
- Kubernetes
- Storage
author: "Matthew Mattox - mattox@support.tools."
description: "Solutions to common issues with Longhorn volumes that won't attach."
more_link: "yes"
---

## Fixing Longhorn Volumes That Refuse to Attach

I've been using Longhorn for quite some time now, and while it's an impressive storage solution for Kubernetes, it's not without its quirks. If you've encountered issues with Longhorn volumes refusing to attach, you're not alone. Here are some common problems I've experienced and how to solve them.

### Volumes Get Detached Unexpectedly and Can't Reattach

- If you're using self-managed Kubernetes (constructing the cluster yourself), it's common to experience node "disruptions," primarily if your nodes are hosted in shared VPS environments like Hetzner Cloud.
- These disruptions can lead to all of your pods on a particular node being killed. Kubernetes won't create new pods in this situation but will instead restart the containers.
- The problem arises when the container restarts and the Container Storage Interface (CSI) doesn't reattach the volume, leaving you with containers in an invalid state that can't access the volumes. This results in a restart loop.

**How to Fix:**

- Manually restart the Deployment/StatefulSet. This action recreates the pods, and Longhorn will reattach the volume.
- Since Longhorn 1.2.0, a default behavior was implemented: if a volume detaches unexpectedly, the pods are recreated. You can modify this behavior by referring to the provided reference.

### Volumes Can't Attach Even After Pod Recreation

- Sometimes, even after recreating pods, volumes still can't attach. This issue may occur randomly when pods are moved to different nodes, typically due to eviction rules or when a node is cordoned/drained. Even if you recreate the pods multiple times, the event log indicates that it can't start the pod because it can't attach a set of volumes (it will specify which PVC can't be attached).

**How to Fix:**

- Identify the PVCs that can't be attached and trace down which PersistentVolume (PV) they are bound to. This problem occurs because Longhorn believes a different node still owns the volume attachment.
- To resolve this issue, you'll need to access the attachment process logs and understand how Longhorn works. When Longhorn attaches a volume, it attaches a Replica. You can obtain the replicas from the Longhorn Volume Custom Resource Definition (CRD). From the Longhorn Replica CRD, you can find the name of the instance manager. You'll need to tail the logs of the instance manager pod responsible for the attachment.
- Before proceeding, ensure that no one is actively accessing your volume. Scale down any pods that use the volume and provide the volumes are in a "Detached" state.
- Open the Longhorn Volume CRD (not the Kubernetes core PersistentVolume object). You can use tools like Rancher to view the YAML manifests, or you can use the equivalent kubectl command:

```bash
# If you don't know the full CRD name, list it using api-resources
kubectl get api-resources | grep longhorn
# You will see that the Longhorn Volume CRD is in volumes.longhorn.io API
# The Volume itself is stored in your Longhorn namespace, usually in the longhorn-system
kubectl -n longhorn-system edit volumes.longhorn.io <volume-name>
```

- Ensure that all the following fields are set to an empty string ("") to trigger Longhorn Manager to handle the detachment: spec.nodeID, status.currentNodeID, status.ownerID, and status.pendingNodeID.
- Apply the changes. Attach the volume again by running the pods or scaling up. If your pod still doesn't run, recheck the pod events, as more than one volume may be stuck.

### Volumes Can't Attach Because of Prior Volume Attachments

- Longhorn supports RWO (ReadWriteOnce) volumes, meaning they can only be attached to a single node but can be accessed by multiple pods on the same node.
- If you encounter an issue where the pod event states that the volume can't be attached because it has already been attached elsewhere, you only have a few options. With RWO volumes, you must schedule all pods that access the same volume to be on the same node. There is no other way.

**How to Fix:**

- To address this problem, you have several options. Refer to the Kubernetes documentation on how to schedule pods. Here are a few methods:
- In the Pod template spec of your workload, assign spec.nodeName directly to the node's name where the volume is currently attached.
- Use Pod Affinity so that one workload can decide where it will run, and other workloads' pods use Pod Affinity to be placed on the same node as the previous workload.
- Alternatively, Longhorn now supports (somewhat experimental) RWX (ReadWriteMany) volumes, which are regular Longhorn volumes exposed via NFS by the Longhorn Share Manager. You can migrate your data to this new volume type and mount the volume from any node in the cluster without using affinity rules.

### Volumes Can't Attach Due to Faulted Replicas

- While it's rare, it can happen if you have only one replica, limited disk space, and your node experiences disruptions. If you have enough space, Longhorn can attempt to make a snapshot and recover the replica, even with just one replica. But if there is more space, it will know what to do. This situation requires a "Salvage" operation by Longhorn.

**How to Fix:**

- You can try the "Salvage" button first from the Longhorn UI of the Volume. If that doesn't work, and you're sure it's a false-negative case (an error when it shouldn't be), or the pod can handle it gracefully, you can force-mount the volume. This is useful for scenarios like cache volumes where you can quickly regenerate content if the volume is corrupted.
- To force-mount the volume, you need to trick Longhorn into thinking that the volume is okay. First, find your Faulted replica's name from the Longhorn UI. Take note of the replica name.
- Now, edit the replica's resource YAML manifests using kubectl:

```bash
# If you don't know the full CRD name, list it using api-resources
kubectl get api-resources | grep longhorn
# You will see that the Longhorn Replica CRD is in replicas.longhorn.io API
# The Replica itself is stored in your Longhorn namespace, usually in the Longhorn system
kubectl -n longhorn-system edit replicas.longhorn.io <replica-name>
```

- In the resource YAML, look for the spec.failedAt field, which contains information about when the replica faulted. Replace the value with an empty string ("") to make Longhorn think the replica is no longer faulty and can be attached.
- This is a somewhat hacky solution. If you encounter this issue frequently and your data is critical, consider using multiple replicas to enhance reliability.

## Wrapping Up

- The issues mentioned above are the most common ones you may encounter when using Longhorn. Longhorn's snapshotting ability is crucial in such cases. Even with occasional faults, having snapshots can ensure your data remains safe. While Kubernetes defines alpha/beta volume snapshot specs, not all Container Storage Interface (CSI) drivers support them. Longhorn bridges this gap with a user-friendly UI and scheduled snapshot capabilities. This is why I continue to use Longhorn instead of the Hetzner CSI driver, as Hetzner volumes can't be snapshotted to the best of my knowledge.

## Conclusion

- Longhorn is an impressive storage solution for Kubernetes, and its stability has improved over time by adding valuable features.
- Despite its strengths, Longhorn users may encounter various issues, but many of these can be resolved with the proper knowledge and troubleshooting steps.
- By understanding how to address common problems like detached volumes, attachment issues, and faulted replicas, you can make the most of Longhorn's capabilities and ensure the reliability of your Kubernetes storage.

I hope you find this guide helpful for troubleshooting and resolving issues with Longhorn volumes. Feel free to ask if you have any further questions or need assistance with any other topics.
