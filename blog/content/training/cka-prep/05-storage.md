---
title: "CKA Prep: Part 5 – Storage"
description: "Understanding Kubernetes storage concepts, persistent volumes, and storage classes for the CKA exam."
date: 2025-04-04T00:00:00-00:00
series: "CKA Exam Preparation Guide"
series_rank: 5
draft: false
tags: ["kubernetes", "cka", "storage", "k8s", "exam-prep", "volumes", "persistent-volumes"]
categories: ["Training", "Kubernetes Certification"]
author: "Matthew Mattox"
more_link: ""
---

## Kubernetes Storage Concepts

Storage is a critical component in Kubernetes clusters, especially for stateful applications. The CKA exam tests your understanding of different storage options and how to configure them.

### Key Storage Challenges in Kubernetes

1. **Data Persistence**: Container storage is ephemeral by default; when a pod dies, its data is lost
2. **Data Sharing**: Containers within a pod or across pods may need to share data
3. **Performance**: Different applications have different storage performance requirements
4. **Portability**: Storage solutions need to work consistently across different environments

## Volume Types

Kubernetes offers several volume types to address various storage needs. Here are the most important ones to understand for the CKA exam:

### emptyDir

An `emptyDir` volume is created when a pod is assigned to a node and exists as long as the pod runs on that node. It's initially empty and all containers in the pod can read and write files in it.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: shared-data-pod
spec:
  containers:
  - name: container-1
    image: nginx
    volumeMounts:
    - name: shared-data
      mountPath: /usr/share/nginx/html
  - name: container-2
    image: busybox
    command: ["/bin/sh", "-c", "while true; do date >> /data/date.log; sleep 5; done"]
    volumeMounts:
    - name: shared-data
      mountPath: /data
  volumes:
  - name: shared-data
    emptyDir: {}
```

**Use cases**:
- Scratch space (temporary storage)
- Checkpoint storage for long computations
- Sharing files between containers in a pod

### hostPath

A `hostPath` volume mounts a file or directory from the host node's filesystem into your pod.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: hostpath-pod
spec:
  containers:
  - name: test-container
    image: nginx
    volumeMounts:
    - name: host-data
      mountPath: /test-data
  volumes:
  - name: host-data
    hostPath:
      path: /data
      type: Directory
```

**Use cases**:
- Accessing Docker internals (e.g. `/var/lib/docker`)
- Running a container that needs access to node's storage
- Persistent storage on a single node

**Note**: `hostPath` volumes are generally discouraged in production as they:
- Break pod isolation
- Create node dependencies
- Can pose security risks

### configMap and secret

`configMap` and `secret` volumes mount these Kubernetes objects into pods:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: config-pod
spec:
  containers:
  - name: test-container
    image: nginx
    volumeMounts:
    - name: config-volume
      mountPath: /etc/config
    - name: secret-volume
      mountPath: /etc/secret
      readOnly: true
  volumes:
  - name: config-volume
    configMap:
      name: app-config
  - name: secret-volume
    secret:
      secretName: app-secrets
```

**Use cases**:
- Mounting configuration files
- Providing credentials to applications
- Storing certificates

### nfs

NFS volumes allow a pod to mount an NFS (Network File System) share:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: nfs-pod
spec:
  containers:
  - name: app
    image: nginx
    volumeMounts:
    - name: nfs-data
      mountPath: /usr/share/nginx/html
  volumes:
  - name: nfs-data
    nfs:
      server: nfs-server.example.com
      path: /shared
```

**Use cases**:
- Sharing data across pods on different nodes
- Accessing existing network storage

## Persistent Volumes and Claims

Kubernetes provides an abstraction for storage management through the Persistent Volume (PV) and Persistent Volume Claim (PVC) system.

### Persistent Volumes (PV)

A PV is a piece of storage in the cluster provisioned by an administrator or dynamically provisioned using Storage Classes.

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: pv-example
spec:
  capacity:
    storage: 10Gi
  volumeMode: Filesystem
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: standard
  nfs:
    server: nfs-server.example.com
    path: /shared
```

**Key PV Attributes**:

- **Capacity**: How much storage is available
- **Access Modes**:
  - `ReadWriteOnce` (RWO): Volume can be mounted as read-write by a single node
  - `ReadOnlyMany` (ROX): Volume can be mounted read-only by many nodes
  - `ReadWriteMany` (RWX): Volume can be mounted as read-write by many nodes
- **Reclaim Policy**:
  - `Retain`: Manual reclamation
  - `Delete`: Automatically delete the storage asset
  - `Recycle`: Basic scrub (deprecated)
- **Storage Class**: Name of StorageClass to which this PV belongs

### Persistent Volume Claims (PVC)

A PVC is a request for storage by a user. It's similar to a pod in that pods consume node resources and PVCs consume PV resources.

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: pvc-example
spec:
  storageClassName: standard
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 5Gi
```

**PVC Binding Process**:
1. User creates a PVC requesting a specific size and access mode
2. Kubernetes control plane finds a PV that satisfies the claim
3. The PV is bound to the PVC
4. The PVC can now be used by pods

### Using PVCs in Pods

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: pvc-pod
spec:
  containers:
  - name: app
    image: nginx
    volumeMounts:
    - name: data-volume
      mountPath: /usr/share/nginx/html
  volumes:
  - name: data-volume
    persistentVolumeClaim:
      claimName: pvc-example
```

### Common PV/PVC Commands

```bash
# List all persistent volumes
kubectl get pv

# List all persistent volume claims
kubectl get pvc

# Describe a persistent volume
kubectl describe pv pv-example

# Create a persistent volume claim
kubectl apply -f pvc.yaml

# Delete a persistent volume claim
kubectl delete pvc pvc-example

# Get PVCs in a specific namespace
kubectl get pvc -n development
```

## Storage Classes

StorageClasses allow dynamic provisioning of Persistent Volumes when a PVC is created. They abstract the underlying storage provider and configuration details.

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast
provisioner: kubernetes.io/aws-ebs
parameters:
  type: gp3
  fsType: ext4
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: Immediate
```

**Key StorageClass Attributes**:
- **Provisioner**: Plugin that provisions PVs (e.g., aws-ebs, azure-disk, gce-pd)
- **Parameters**: Provider-specific parameters for the provisioner
- **ReclaimPolicy**: What happens to PVs when PVCs are deleted
- **VolumeBindingMode**: When volume binding and dynamic provisioning occur
  - `Immediate`: Binding and provisioning happen immediately
  - `WaitForFirstConsumer`: Binding and provisioning are delayed until a pod using the PVC is created

### Using StorageClasses with PVCs

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: fast-storage-claim
spec:
  storageClassName: fast
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 100Gi
```

### Common StorageClass Commands

```bash
# List all storage classes
kubectl get storageclass

# Set a default storage class
kubectl patch storageclass standard -p '{"metadata": {"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'

# Describe a storage class
kubectl describe storageclass fast
```

## Volume Snapshots

VolumeSnapshots allow creating snapshots of PVCs. This is an alpha feature in Kubernetes and requires a supported CSI driver.

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: data-snapshot
spec:
  volumeSnapshotClassName: csi-hostpath-snapclass
  source:
    persistentVolumeClaimName: data-pvc
```

## Volume Expansion

Some storage providers allow PVCs to be expanded after creation:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: expandable-pvc
spec:
  storageClassName: expandable-storage
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi
```

To expand an existing PVC, edit it and increase the storage request:

```bash
kubectl edit pvc expandable-pvc
```

And change the `spec.resources.requests.storage` field to a larger value.

## Storage Configuration and Troubleshooting

### PVC in Pending State

If a PVC remains in a `Pending` state, check:

1. If there's a matching PV available
2. If the storage class exists and has a provisioner
3. If the provisioner can create storage with the requested access mode
4. If there are sufficient resources in the underlying storage system

```bash
# Check PV/PVC status
kubectl get pvc
kubectl get pv

# Check for events related to the PVC
kubectl describe pvc <pvc-name>

# Verify storage class
kubectl get storageclass

# Check provisioner pods (if applicable)
kubectl get pods -n kube-system | grep provisioner
```

### Pod Stuck in ContainerCreating

If a pod using a PVC is stuck in `ContainerCreating`, check:

1. If the PVC is bound
2. If the volume can be mounted on the node
3. If there are any errors in the events

```bash
# Check pod status
kubectl describe pod <pod-name>

# Check mount issues on the node (requires SSH access)
journalctl -u kubelet | grep volume
```

## Sample Exam Questions

### Question 1: Create a PVC and Pod

**Task**: Create a PersistentVolumeClaim named `data-claim` that requests 2Gi of storage with ReadWriteOnce access. Then create a pod named `data-pod` using the Nginx image that mounts this claim at `/usr/share/nginx/html`.

**Solution**:

```bash
# Create the PVC
cat << EOF | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data-claim
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 2Gi
EOF

# Create the Pod
cat << EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: data-pod
spec:
  containers:
  - name: nginx
    image: nginx
    volumeMounts:
    - name: data-volume
      mountPath: /usr/share/nginx/html
  volumes:
  - name: data-volume
    persistentVolumeClaim:
      claimName: data-claim
EOF
```

### Question 2: Create a StorageClass

**Task**: Create a StorageClass named `fast-storage` using the `kubernetes.io/gce-pd` provisioner (or appropriate provisioner for your environment). Configure it to use SSD persistent disks, with a filesystem type of ext4.

**Solution**:

```bash
cat << EOF | kubectl apply -f -
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast-storage
provisioner: kubernetes.io/gce-pd
parameters:
  type: pd-ssd
  fsType: ext4
reclaimPolicy: Delete
allowVolumeExpansion: true
EOF
```

### Question 3: Configure EmptyDir with Memory Medium

**Task**: Create a pod named `memory-pod` using the Busybox image that sleeps for 3600 seconds. Mount an emptyDir volume at `/cache` that uses memory as its storage medium.

**Solution**:

```bash
cat << EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: memory-pod
spec:
  containers:
  - name: busybox
    image: busybox
    command: ["sleep", "3600"]
    volumeMounts:
    - name: cache-volume
      mountPath: /cache
  volumes:
  - name: cache-volume
    emptyDir:
      medium: Memory
EOF
```

### Question 4: Expand a PVC

**Task**: Expand an existing PVC named `data-storage` from 5Gi to 10Gi.

**Solution**:

```bash
# Using kubectl edit
kubectl edit pvc data-storage
# Change spec.resources.requests.storage from 5Gi to 10Gi

# Alternatively, with a patch
kubectl patch pvc data-storage -p '{"spec":{"resources":{"requests":{"storage":"10Gi"}}}}'
```

## Key Tips for Storage

1. **Understand different volume types**:
   - Know when to use emptyDir vs hostPath vs PV/PVC
   - Understand the lifecycle of different volume types

2. **Master PV and PVC management**:
   - Know how to create, bind, and troubleshoot PVs and PVCs
   - Understand the PV binding process

3. **Storage Classes**:
   - Know how to create and use StorageClasses
   - Understand dynamic provisioning

4. **Access Modes**:
   - Remember what ReadWriteOnce, ReadOnlyMany, and ReadWriteMany mean
   - Know which access modes are supported by which volume types

5. **Troubleshooting**:
   - Develop a systematic approach to debug storage issues
   - Know common storage-related errors and their solutions

## Practice Exercises

To reinforce your understanding, try these exercises in your practice environment:

1. Create a PV manually, then a PVC that binds to it
2. Create a StorageClass and verify dynamic provisioning with a PVC
3. Create a pod with multiple volume types (emptyDir, configMap, secret)
4. Test expanding a PVC that uses a StorageClass with allowVolumeExpansion=true
5. Simulate and troubleshoot common storage issues
6. Create a multi-container pod that shares data through an emptyDir volume
7. Configure a deployment that uses persistent storage

## What's Next

In the next part, we'll explore Kubernetes Security concepts, covering:
- Authentication and Authorization
- Role-Based Access Control (RBAC)
- Service Accounts
- Security Contexts
- Pod Security Policies
- Network Policies
- Secrets Management

👉 Continue to **[Part 6: Security](/training/cka-prep/06-security/)**
