---
title: "Setting Up Static Persistent Volumes in k3s on Raspberry Pi"
date: 2024-05-18T19:26:00-05:00
draft: true
tags: ["k3s", "Raspberry Pi", "Persistent Volumes", "Kubernetes"]
categories:
- DevOps
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools."
description: "Learn how to set up static persistent volumes in k3s on Raspberry Pi for better control over storage provisioning."
more_link: "yes"
url: "/setting-up-static-persistent-volumes-in-k3s-on-raspberry-pi/"
---

Learn how to set up static persistent volumes in k3s on Raspberry Pi for better control over storage provisioning. This guide covers the steps to create and manage static persistent volumes.

<!--more-->

# [Setting Up Static Persistent Volumes in k3s on Raspberry Pi](#setting-up-static-persistent-volumes-in-k3s-on-raspberry-pi)

In the previous post, we gave our Docker registry some persistent storage using dynamic provisioning. This time, we'll explore static provisioning for more control over where the storage is provisioned.

## [The Local-Path Storage Class](#the-local-path-storage-class)

Previously, we created a PersistentVolumeClaim:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: docker-registry-pvc
  namespace: docker-registry
spec:
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
```

And attached it to our container:

```yaml
...
      volumes:
      - name: docker-registry-vol
        persistentVolumeClaim:
          claimName: docker-registry-pvc
```

Without specifying anything in the claim, the default storage class `local-path` is used:

```bash
kubectl get storageclass
```

Example output:

```
NAME                   PROVISIONER             RECLAIMPOLICY   VOLUMEBINDINGMODE      ALLOWVOLUMEEXPANSION   AGE
local-path (default)   rancher.io/local-path   Delete          WaitForFirstConsumer   false                  161d
```

This provisions storage in the `/var/lib/rancher/k3s/storage` directory on the local filesystem of each node. To provision storage on a different filesystem, we can edit the ConfigMap.

## [Static Provisioning](#static-provisioning)

Static provisioning involves explicitly creating a PersistentVolume and specifying it in our PersistentVolumeClaim.

### Example Configuration

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: docker-repo-pv
spec:
  capacity:
    storage: 1Gi
  accessModes:
  - ReadWriteOnce
  hostPath:
    path: /tmp/repository
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: docker-repo
spec:
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
```

Applying this results in a dynamic PVC and an unused static PV:

```bash
kubectl get pvc
kubectl get pv
```

For proper usage, the claim and volume need an association. Using labels and selectors can achieve this.

### Using Labels and Selectors

Add labels to the PV and use a matching selector in the PVC:

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: testing-vol-pv
  labels:
    app: testing
spec:
  capacity:
    storage: 1Gi
  accessModes:
  - ReadWriteOnce
  iscsi:
    targetPortal: 192.168.28.124:3260
    iqn: iqn.2000-01.com.synology:ds211.testing.25e6c0dc53
    lun: 1
    readOnly: false
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: testing-vol-pvc
spec:
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
  selector:
    matchLabels:
      app: testing
```

Apply the configuration:

```bash
kubectl apply -f testing-ubuntu-pv.yml
kubectl get pv
kubectl get pvc
```

If the PVC remains pending, create a consumer and ensure a storageClassName is specified:

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: testing-vol-pv
  labels:
    app: testing
spec:
  storageClassName: iscsi
  capacity:
    storage: 1Gi
  accessModes:
  - ReadWriteOnce
  iscsi:
    targetPortal: 192.168.28.124:3260
    iqn: iqn.2000-01.com.synology:ds211.testing.25e6c0dc53
    lun: 1
    readOnly: false
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: testing-vol-pvc
spec:
  storageClassName: iscsi
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
  selector:
    matchLabels:
      app: testing
```

Reapply the configurations:

```bash
kubectl apply -f testing-ubuntu-pv.yml
kubectl apply -f testing-ubuntu.yml
```

## [Verifying Persistence](#verifying-persistence)

Check if the volume is persistent across nodes:

```bash
kubectl exec --stdin --tty testing-5d4458cc68-jffcx -- /bin/bash
# ls /var/lib/testing
```

To force the pod to move:

```bash
kubectl cordon rpi405
kubectl delete pod testing-5cb897dd66-sk5zs
kubectl get pods -o wide
```

Verify the content:

```bash
kubectl exec --stdin --tty testing-5cb897dd66-xmjt5 -- /bin/bash
# ls /var/lib/testing/
```

## [Conclusion](#conclusion)

Static provisioning allows more control over storage provisioning, enabling better flexibility in managing persistent volumes. While it may seem like extra effort, it provides abstraction and flexibility, particularly useful for larger or more complex deployments.

By following these steps, you can set up static persistent volumes in k3s on Raspberry Pi, ensuring reliable and flexible storage management.
