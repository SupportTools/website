---
title: "Fix Longhorn Volumes That Won't Attach (Longhorn 1.5+)"
date: 2023-10-13T13:30:00-05:00
lastmod: 2026-10-23
draft: false
tags: ["Longhorn", "Kubernetes", "Troubleshooting"]
categories:
- Kubernetes
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "Longhorn volume stuck attaching, detaching or faulted? Check attachment tickets, stale VolumeAttachments, Multi-Attach errors and salvage (Longhorn 1.5+)."
more_link: "yes"
quick_fix: |
  First find out who holds the volume: `kubectl -n longhorn-system get volumes.longhorn.io <pv-name> -o wide` and
  `kubectl -n longhorn-system get volumeattachments.longhorn.io <pv-name> -o yaml` (Longhorn 1.5+ tracks every attach request as a ticket there).
  Then check Kubernetes' own attachment: `kubectl get volumeattachments.storage.k8s.io | grep <pv-name>`.
  A stale ticket or VolumeAttachment pointing at a dead node is the usual cause. Scale the workload down, remove only the stale entry, then scale back up.
---

Longhorn is a solid distributed block storage system for Kubernetes, but a volume that will not attach stops a workload cold. This guide covers the common causes and fixes, updated for how attachment works in Longhorn 1.5 and later (current release: v1.13.0).

<!--more-->

## Fixing Longhorn Volumes That Refuse to Attach

### First: how attachment works in Longhorn 1.5 and later

Longhorn 1.5 introduced a `VolumeAttachment` custom resource (`volumeattachments.longhorn.io`, one per volume, named after the volume) that lists **attachment tickets**: one for each requester, such as the CSI driver for a pod (`csi-attacher` type), the UI or API, backups and snapshot operations. The volume attaches to a node only when a ticket asks for it, and detaches when no ticket needs it.

Older advice to edit `spec.nodeID` on the Longhorn `Volume` object predates this design. On current versions, look at tickets first.

Useful commands:

```bash
# List the Longhorn CRDs (note: it is "kubectl api-resources", not "kubectl get api-resources")
kubectl api-resources --api-group=longhorn.io

# Volume state, node and robustness
kubectl -n longhorn-system get volumes.longhorn.io <pv-name> -o wide

# Who is asking for the volume to be attached, and where
kubectl -n longhorn-system get volumeattachments.longhorn.io <pv-name> -o yaml

# Kubernetes' view of the CSI attachment
kubectl get volumeattachments.storage.k8s.io | grep <pv-name>

# Pod events usually name the failing PVC
kubectl describe pod <pod-name> -n <namespace>
```

The Longhorn volume name is the PV name (`pvc-...`), not the PVC name.

### Volumes get detached unexpectedly and can't reattach

- Node "disruptions" (a short network partition, a VPS host hiccup, kubelet restarts) can make Longhorn lose the connection between the engine and the node.
- Kubernetes then restarts the containers in place, but the block device underneath is gone, so the containers crash loop with I/O errors.

**How to fix:**

- Longhorn has handled this automatically since v1.2.0 with the setting **Automatically Delete Workload Pod when The Volume Is Detached Unexpectedly** (`auto-delete-pod-when-volume-detached-unexpectedly`, default `true`). It deletes pods managed by a controller (Deployment, StatefulSet, and so on) so they are recreated and the volume reattaches. Make sure it has not been turned off.
- Bare pods without a controller are not recreated; delete and recreate them, or restart the workload with `kubectl rollout restart`.

### Volumes can't attach even after the pod is recreated

This happens most often after a node is drained, fails, or is removed: pod events say the volume cannot be attached, and the volume stays `attaching` or `detaching`.

**How to fix:**

1. Scale down every workload that uses the volume and wait until no pod references the PVC.
2. Inspect the Longhorn attachment tickets:

   ```bash
   kubectl -n longhorn-system get volumeattachments.longhorn.io <pv-name> -o yaml
   ```

   Look under `spec.attachmentTickets` for tickets whose `nodeID` is a node that no longer exists or whose pod is gone. Remove only those entries with `kubectl -n longhorn-system edit volumeattachments.longhorn.io <pv-name>`. A ticket with `id: longhorn-ui` and `type: longhorn-api` that you did not create is a known leftover documented in the [Longhorn KB](https://longhorn.io/kb/troubleshooting-volume-cannot-attach-due-to-orphan-pending-node-id-or-longhorn-ui-ad-ticket); remove that block.
3. After an upgrade from 1.4.x to 1.5.0 through 1.5.4, a leftover `status.pendingNodeID` can also block attachment. Clear it through the status subresource:

   ```bash
   kubectl -n longhorn-system edit volumes.longhorn.io <pv-name> --subresource=status
   ```

   Set `pendingNodeID` to `""`. That bug is fixed in 1.5.5 and later.
4. Check the Kubernetes `VolumeAttachment` for the PV. If it still points at a dead node, see the next section.
5. Check the `instance-manager` pod on the target node (`kubectl -n longhorn-system get pods -o wide | grep instance-manager`) and its logs. For v1 volumes, also confirm `iscsid` is running and the `iscsi_tcp` module is loaded on the node.
6. Scale the workload back up.

Do not remove tickets while the volume is in use. Removing a valid ticket detaches a volume under a running workload.

### "Multi-Attach error": the volume is attached to another node

- RWO (ReadWriteOnce) volumes attach to one node at a time; several pods can share them only if they run on that node.
- After a node goes down, Kubernetes keeps the old `VolumeAttachment` until the attach/detach controller's force-detach timeout (about 6 minutes) or until the node is marked out of service, and new pods on other nodes report `Multi-Attach error for volume ... Volume is already exclusively attached to one node`.

**How to fix:**

- If the node is really gone, mark it out of service so Kubernetes can force-detach (non-graceful node shutdown, stable since Kubernetes v1.28):

  ```bash
  kubectl taint nodes <node-name> node.kubernetes.io/out-of-service=nodeshutdown:NoExecute
  ```

  Remove the taint after the node is repaired and rejoined.
- Set **Pod Deletion Policy When Node is Down** (`node-down-pod-deletion-policy`, default `do-nothing`) to `delete-both-statefulset-and-deployment-pod` so Longhorn deletes stuck pods on a down node and the volume can move.
- If several workloads must share the data from different nodes, use a **RWX** volume (`accessModes: [ReadWriteMany]`). Longhorn serves RWX volumes over NFSv4 through a share-manager pod; nodes need an NFSv4 client (`nfs-common` or `nfs-utils`) installed.
- Otherwise keep pods that share an RWO volume on the same node with pod affinity.

### Volumes can't attach because all replicas are faulted

- This is most likely with a single replica, a full disk, or repeated node disruptions.
- **Automatic Salvage** (`auto-salvage`, default `true`) tries to recover a volume when all replicas become faulty by picking the most recent usable replica.

**How to fix:**

- If automatic salvage did not run or failed, use **Salvage** on the volume in the Longhorn UI.
- Check node disk space and the replica logs in the `instance-manager` pods before forcing anything.
- As a last resort for disposable data (for example a cache volume), you can make Longhorn treat a faulted replica as usable. Scale the workload down, then edit the replica and clear `spec.failedAt`:

  ```bash
  kubectl -n longhorn-system get replicas.longhorn.io -l longhornvolume=<pv-name>
  kubectl -n longhorn-system edit replicas.longhorn.io <replica-name>
  ```

  This can bring up stale or corrupted data. Do not do it for data you cannot afford to lose; restore from a backup instead.

## Prevent it next time

- Run at least 2, ideally 3 replicas on different nodes for anything important.
- Configure a backup target and recurring backups, not only snapshots: snapshots live on the same replicas as the data.
- Keep node clocks, kernels and `open-iscsi` consistent across nodes, and keep Longhorn on a supported release (v1.13.0 at the time of this update).
- Restrict Longhorn to storage nodes if not every node should hold replicas; see [How to Restrict Longhorn to Specific Nodes in K3s](/how-to-restrict-longhorn-in-k3s-cluster/).
- Make sure the CNI is healthy and MTU is consistent; replica traffic between nodes fails in ways that look like storage problems. See the [Cilium Troubleshooting Guide](/post/cilium-troubleshooting-2025/) if you run Cilium.

## FAQ

### Why is my Longhorn volume stuck in "attaching"?

Usually a stale attachment ticket, a Kubernetes VolumeAttachment still bound to a dead node, an instance-manager pod that is not running on the target node, or missing `iscsid` on that node. Work through the checks above in that order.

### Can I just delete the Kubernetes VolumeAttachment object?

Only if you are sure the old node is gone or the volume is no longer mounted there. The safer route is the `node.kubernetes.io/out-of-service` taint, which lets Kubernetes clean up for you.

### Is Longhorn RWX still experimental?

No. RWX volumes have been a supported feature for several releases. They are NFSv4 exports of a regular Longhorn volume through a share-manager pod.

## Related guides

- [How to Restrict Longhorn to Specific Nodes in K3s](/how-to-restrict-longhorn-in-k3s-cluster/)
- [Cilium Troubleshooting Guide](/post/cilium-troubleshooting-2025/)
