---
title: "Running Elixir Livebook on k3s"
date: 2024-05-18T19:26:00-05:00
draft: false
tags: ["k3s", "Elixir", "Livebook", "Kubernetes"]
categories:
- DevOps
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to run Elixir Livebook on your k3s cluster with step-by-step instructions for deployment, PVC, service, and ingress setup."
more_link: "yes"
url: "/running-elixir-livebook-on-k3s/"
---

Learn how to run Elixir Livebook on your k3s cluster with step-by-step instructions for deployment, PVC, service, and ingress setup. This guide ensures a smooth setup process.

<!--more-->

# [Running Elixir Livebook on k3s](#running-elixir-livebook-on-k3s)

I’d like to run Livebook on my cluster. Here’s how I went about doing that.

## [Creating the Namespace](#creating-the-namespace)

```bash
kubectl create namespace livebook
```

## [Deployment Configuration](#deployment-configuration)

Create the `deployment.yaml` file:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app: livebook
  name: livebook
  namespace: livebook
spec:
  replicas: 1
  selector:
    matchLabels:
      app: livebook
  template:
    metadata:
      labels:
        app: livebook
    spec:
      containers:
      - name: livebook
        image: livebook/livebook:0.5.2
        env:
        - name: LIVEBOOK_PORT
          value: "8080"
        - name: LIVEBOOK_PASSWORD
          valueFrom:
            secretKeyRef:
              name: livebook-password
              key: password
        - name: LIVEBOOK_ROOT_PATH
          value: /var/lib/livebook
        volumeMounts:
        - name: livebook-data-vol
          mountPath: /var/lib/livebook
      volumes:
      - name: livebook-data-vol
        persistentVolumeClaim:
          claimName: livebook-data-pvc
```

## [Persistent Volume Claim](#persistent-volume-claim)

Create the `pvc.yaml` file:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: livebook-data-pvc
  namespace: livebook
spec:
  storageClassName: longhorn
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
```

## [Service Configuration](#service-configuration)

Create the `service.yaml` file:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: livebook
  namespace: livebook
spec:
  ports:
  - name: livebook-port
    port: 8080
  selector:
    app: livebook
```

## [Ingress Configuration](#ingress-configuration)

Create the `ingress.yaml` file:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: livebook
  namespace: livebook
  annotations:
    traefik.ingress.kubernetes.io/router.entrypoints: websecure
    traefik.ingress.kubernetes.io/router.tls: "true"
    cert-manager.io/cluster-issuer: k3s-ca-cluster-issuer
spec:
  tls:
  - hosts:
      - livebook.k3s.differentpla.net
    secretName: livebook-tls
  rules:
  - host: livebook.k3s.differentpla.net
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: livebook
            port:
              number: 8080
```

## [Creating the Secret for Password](#creating-the-secret-for-password)

Create the `password.yaml` file to hold the password, which must be at least 12 characters:

```yaml
apiVersion: v1
kind: Secret
metadata:
  namespace: livebook
  name: livebook-password
type: Opaque
data:
  password: bGl2ZWJvb2stcGFzc3dvcmQ=
```

## [Configuring DNS](#configuring-dns)

Edit your custom DNS configuration:

```bash
kubectl --namespace k3s-dns edit configmap k3s-dns
```

Add the following entry to `NodeHosts`:

```yaml
data:
  NodeHosts: |
    192.168.28.10 livebook.k3s.differentpla.net
```

## [Miscellaneous Notes](#miscellaneous-notes)

- Consider writing a controller to scan for LoadBalancer and Ingress objects and update the CoreDNS ConfigMap automatically.
- Using ArgoCD for this setup could streamline the process. Importing it into ArgoCD may be beneficial.
- Note that `LIVEBOOK_ROOT_PATH` changes between versions, so bear this in mind when upgrading.
- Plan for backups to ensure data safety.

By following these steps, you can successfully run Elixir Livebook on your k3s cluster, providing a powerful tool for interactive Elixir notebooks.
