---
title: "Installing ArgoCD on k3s"
date: 2024-05-18T19:26:00-05:00
draft: false
tags: ["ArgoCD", "Kubernetes", "k3s"]
categories:
- DevOps
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools."
description: "Learn how to install ArgoCD on a k3s cluster, including setting up TLS ingress and handling common issues."
more_link: "yes"
url: "/installing-argocd-on-k3s/"
---

Learn how to install ArgoCD on a k3s cluster, including setting up TLS ingress and handling common issues. This guide provides step-by-step instructions for getting ArgoCD up and running.

<!--more-->

# [Installing ArgoCD on k3s](#installing-argocd-on-k3s)

We’re using ArgoCD at work; time to play with it.

## [Challenges with arm64 Images](#challenges-with-arm64-images)

The lack of arm64 images is a challenge. While they’re in the v2.3 milestone for ArgoCD, we can use community-built images in the meantime:

## [Setting Up ArgoCD](#setting-up-argocd)

### Create the Namespace

```bash
kubectl create namespace argocd
```

### Download the Official Install Manifest

```bash
wget https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml -O install.yaml
```

### Patch the Image Names

```bash
sed -i 's,quay.io/argoproj/argocd,alinbalutoiu/argocd,g' install.yaml
```

### Apply the Manifest

```bash
kubectl apply --namespace argocd -f install.yaml
```

### Verify the Installation

```bash
kubectl --namespace argocd get all
```

Example output:

```
NAME                                      READY   STATUS    RESTARTS   AGE
pod/argocd-redis-5b6967fdfc-pfwxf         1/1     Running   0          8m25s
pod/argocd-dex-server-74684fccc8-rxhxv    1/1     Running   0          8m25s
pod/argocd-application-controller-0       1/1     Running   0          8m24s
pod/argocd-repo-server-588df66c7c-wsg6s   1/1     Running   0          8m25s
pod/argocd-server-756d58b6fb-hpzsg        1/1     Running   0          8m25s

NAME                            TYPE        CLUSTER-IP      EXTERNAL-IP   PORT(S)                      AGE
service/argocd-dex-server       ClusterIP   10.43.114.31    <none>        5556/TCP,5557/TCP,5558/TCP   8m26s
service/argocd-metrics          ClusterIP   10.43.123.47    <none>        8082/TCP                     8m26s
service/argocd-redis            ClusterIP   10.43.175.34    <none>        6379/TCP                     8m25s
service/argocd-repo-server      ClusterIP   10.43.109.191   <none>        8081/TCP,8084/TCP            8m25s
service/argocd-server           ClusterIP   10.43.147.196   <none>        80/TCP,443/TCP               8m25s
service/argocd-server-metrics   ClusterIP   10.43.120.40    <none>        8083/TCP                     8m25s

NAME                                 READY   UP-TO-DATE   AVAILABLE   AGE
deployment.apps/argocd-redis         1/1     1            1           8m25s
deployment.apps/argocd-dex-server    1/1     1            1           8m25s
deployment.apps/argocd-repo-server   1/1     1            1           8m25s
deployment.apps/argocd-server        1/1     1            1           8m25s

NAME                                            DESIRED   CURRENT   READY   AGE
replicaset.apps/argocd-redis-5b6967fdfc         1         1         1       8m25s
replicaset.apps/argocd-dex-server-74684fccc8    1         1         1       8m25s
replicaset.apps/argocd-repo-server-588df66c7c   1         1         1       8m25s
replicaset.apps/argocd-server-756d58b6fb        1         1         1       8m25s

NAME                                             READY   AGE
statefulset.apps/argocd-application-controller   1/1     8m25s
```

## [Adding a TLS Ingress](#adding-a-tls-ingress)

Since k3s uses Traefik, we need to add an IngressRoute:

### IngressRoute YAML

```yaml
apiVersion: traefik.containo.us/v1alpha1
kind: IngressRoute
metadata:
  name: argocd-server
  namespace: argocd
spec:
  entryPoints:
    - websecure
  routes:
    - kind: Rule
      match: Host(`argocd.k3s.differentpla.net`)
      priority: 10
      services:
        - name: argocd-server
          port: 80
    - kind: Rule
      match: Host(`argocd.k3s.differentpla.net`) && Headers(`Content-Type`, `application/grpc`)
      priority: 11
      services:
        - name: argocd-server
          port: 80
          scheme: h2c
  tls:
    secretName: argocd-tls
```

## [Updating the Custom DNS ConfigMap](#updating-the-custom-dns-configmap)

Edit the custom DNS ConfigMap:

```bash
kubectl --namespace k3s-dns edit configmap k3s-dns
```

Add the following:

```yaml
data:
  NodeHosts: |
    192.168.28.10 argocd.k3s.differentpla.net
```

## [Creating a Server Certificate](#creating-a-server-certificate)

Use the Elixir script:

```bash
./certs create-cert \
    --issuer-cert k3s-ca.crt --issuer-key k3s-ca.key \
    --out-cert argocd.crt --out-key argocd.key \
    --template server \
    --subject '/CN=argocd.k3s.differentpla.net'
base64 -w0 < argocd.crt
base64 -w0 < argocd.key
```

### TLS Secret YAML

```yaml
apiVersion: v1
kind: Secret
type: kubernetes.io/tls
metadata:
  name: argocd-tls
  namespace: argocd
data:
  tls.crt: LS0tLS1...
  tls.key: LS0tLS1...
```

## [Handling ERR_TOO_MANY_REDIRECTS](#handling-err_too_many_redirects)

You need to run the API server with TLS disabled. Edit the `argocd-server` deployment to add the `--insecure` flag:

Instead of directly editing the deployment, update the `argocd-cmd-params-cm` ConfigMap:

### ConfigMap YAML

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cmd-params-cm
  namespace: argocd
  labels:
    app.kubernetes.io/name: argocd-cmd-params-cm
    app.kubernetes.io/part-of: argocd
data:
  server.insecure: "true"
```

## [Restarting the argocd-server Pod](#restarting-the-argocd-server-pod)

Restart the pod to apply the changes:

```bash
kubectl --namespace argocd rollout restart deployment argocd-server
```

## [Logging In](#logging-in)

At this point, you should be able to browse to the ArgoCD website and see a login screen. To get the initial admin password:

```bash
kubectl --namespace argocd get secret argocd-initial-admin-secret -o json | jq -r '.data.password' | base64 -d
```

Bingo! You are now ready to use ArgoCD on your k3s cluster.
