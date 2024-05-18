---
title: "Installing Grafana on Kubernetes with k3s"
date: 2024-05-18T19:26:00-05:00
draft: true
tags: ["k3s", "Kubernetes", "Grafana", "Monitoring"]
categories:
- DevOps
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools."
description: "Learn how to install Grafana on Kubernetes using k3s, ArgoCD CLI, and configure it with an Ingress for secure access."
more_link: "yes"
url: "/installing-grafana-on-kubernetes-with-k3s/"
---

Learn how to install Grafana on Kubernetes using k3s, ArgoCD CLI, and configure it with an Ingress for secure access. This guide walks you through the deployment process, setting up persistent storage, and configuring an Ingress with TLS.

<!--more-->

# [Installing Grafana on Kubernetes with k3s](#installing-grafana-on-kubernetes-with-k3s)

Using ArgoCD CLI:

```bash
argocd app create grafana --repo https://git.k3s.differentpla.net/roger/grafana.git --path . --dest-server https://kubernetes.default.svc --dest-namespace grafana
```

Application 'grafana' created. The rest of this setup follows the [Grafana installation guide for Kubernetes](https://grafana.com/docs/grafana/latest/setup-grafana/installation/kubernetes/), with modifications to use an Ingress rather than a LoadBalancer.

## [Deployment Configuration](#deployment-configuration)

Create the `deployment.yaml` file:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app: grafana
  name: grafana
  namespace: grafana
spec:
  selector:
    matchLabels:
      app: grafana
  template:
    metadata:
      labels:
        app: grafana
    spec:
      securityContext:
        fsGroup: 472
        supplementalGroups:
          - 0
      containers:
        - name: grafana
          image: grafana/grafana:9.1.0
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 3000
              name: http-grafana
              protocol: TCP
          readinessProbe:
            failureThreshold: 3
            httpGet:
              path: /robots.txt
              port: 3000
              scheme: HTTP
            initialDelaySeconds: 10
            periodSeconds: 30
            successThreshold: 1
            timeoutSeconds: 2
          livenessProbe:
            failureThreshold: 3
            initialDelaySeconds: 30
            periodSeconds: 10
            successThreshold: 1
            tcpSocket:
              port: 3000
            timeoutSeconds: 1
          resources:
            requests:
              cpu: 250m
              memory: 750Mi
          volumeMounts:
            - mountPath: /var/lib/grafana
              name: grafana-pv
      volumes:
        - name: grafana-pv
          persistentVolumeClaim:
            claimName: grafana-pvc
```

## [PersistentVolumeClaim Configuration](#persistentvolumeclaim-configuration)

Create the `pvc.yaml` file with `storageClassName: longhorn`:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: grafana-pvc
  namespace: grafana
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
  storageClassName: longhorn
```

## [Service Configuration](#service-configuration)

Create the `service.yaml` file:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: grafana
  namespace: grafana
spec:
  ports:
    - port: 3000
      protocol: TCP
      name: http-grafana
      targetPort: http-grafana
  selector:
    app: grafana
```

## [Ingress Configuration](#ingress-configuration)

Create the `ingress.yaml` file:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: grafana
  namespace: grafana
  annotations:
    traefik.ingress.kubernetes.io/router.entrypoints: websecure
    traefik.ingress.kubernetes.io/router.tls: "true"
    cert-manager.io/cluster-issuer: k3s-ca-cluster-issuer
spec:
  tls:
  - hosts:
      - grafana.k3s.differentpla.net
    secretName: grafana-tls
  rules:
  - host: grafana.k3s.differentpla.net
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: grafana
            port:
              name: http-grafana
```

## [Configuring DNS](#configuring-dns)

Edit the ConfigMap for your custom CoreDNS to include the following:

```bash
kubectl --namespace k3s-dns edit configmap k3s-dns
```

Add the following entry to `NodeHosts`:

```yaml
data:
  NodeHosts: |
    192.168.28.10 grafana.k3s.differentpla.net
```

## [Conclusion](#conclusion)

That’s pretty much it. By following these steps, you can install Grafana on your Kubernetes cluster using k3s, configure persistent storage, and set up an Ingress for secure access. This setup ensures that your monitoring solution is robust and accessible.

Consider adding a controller that scans for Ingress and Service annotations to automate the DNS configuration process in the future.
