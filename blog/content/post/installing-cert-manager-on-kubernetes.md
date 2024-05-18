---
title: "Installing cert-manager on Kubernetes"
date: 2024-05-18T19:26:00-05:00
draft: true
tags: ["Kubernetes", "cert-manager", "TLS", "Certificates"]
categories:
- DevOps
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools."
description: "Simplify certificate management on Kubernetes by installing cert-manager. This guide covers installation, configuration, and usage."
more_link: "yes"
url: "/installing-cert-manager-on-kubernetes/"
---

Simplify certificate management on Kubernetes by installing cert-manager. This guide covers installation, configuration, and usage, helping you automate certificate issuance and management.

<!--more-->

# [Installing cert-manager on Kubernetes](#installing-cert-manager-on-kubernetes)

Up to this point, I’ve been creating and installing certificates manually. Let’s see if cert-manager will make that easier.

## [Installation](#installation)

Install cert-manager using the following command:

```bash
kubectl apply -f <https://github.com/cert-manager/cert-manager/releases/download/v1.7.1/cert-manager.yaml>
```

Verify the installation:

```bash
kubectl --namespace cert-manager get all
```

Example output:

```
NAME                                         READY   STATUS    RESTARTS   AGE
pod/cert-manager-6d8d6b5dbb-qfxr5            1/1     Running   0          7m4s
pod/cert-manager-webhook-85fb68c79b-gtj2z    1/1     Running   0          7m4s
pod/cert-manager-cainjector-d6cbc4d9-tw5pl   1/1     Running   0          7m4s

NAME                           TYPE        CLUSTER-IP      EXTERNAL-IP   PORT(S)    AGE
service/cert-manager           ClusterIP   10.43.43.27     <none>        9402/TCP   7m5s
service/cert-manager-webhook   ClusterIP   10.43.181.148   <none>        443/TCP    7m5s

NAME                                      READY   UP-TO-DATE   AVAILABLE   AGE
deployment.apps/cert-manager              1/1     1            1           7m5s
deployment.apps/cert-manager-webhook      1/1     1            1           7m5s
deployment.apps/cert-manager-cainjector   1/1     1            1           7m5s

NAME                                               DESIRED   CURRENT   READY   AGE
replicaset.apps/cert-manager-6d8d6b5dbb            1         1         1       7m5s
replicaset.apps/cert-manager-webhook-85fb68c79b    1         1         1       7m5s
replicaset.apps/cert-manager-cainjector-d6cbc4d9   1         1         1       7m5s
```

## [Creating a Certificate Issuer](#creating-a-certificate-issuer)

Before issuing any certificates, create an Issuer or ClusterIssuer resource. For this example, we will create a `ClusterIssuer`.

### ClusterIssuer Configuration

Create a `k3s-ca-cluster-issuer.yaml` file:

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: k3s-ca-cluster-issuer
spec:
  ca:
    secretName: k3s-ca-key-pair
```

Apply the configuration:

```bash
kubectl apply -f k3s-ca-cluster-issuer.yaml
```

Check the logs for any errors indicating missing secrets:

```bash
kubectl --namespace cert-manager logs -l app=cert-manager
```

Create the secret for the ClusterIssuer:

```bash
kubectl --namespace cert-manager create secret tls k3s-ca-key-pair --cert=k3s-ca.crt --key=k3s-ca.key
```

## [Issuing a Certificate](#issuing-a-certificate)

Create a `Certificate` resource. Here’s an example configuration:

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: example-k3s-differentpla-net
  namespace: default
spec:
  secretName: example-k3s-differentpla-net-tls
  issuerRef:
    name: k3s-ca-cluster-issuer
    kind: ClusterIssuer
  dnsNames:

- example.k3s.differentpla.net
```

Apply the manifest:

```bash
kubectl apply -f example-k3s-differentpla-net-certificate.yaml
```

Verify the secret was created:

```bash
kubectl --namespace default get secret example-k3s-differentpla-net-tls -o yaml
```

## [Inspecting the Key/Certificate](#inspecting-the-key-certificate)

Inspect the actual certificate and key:

```bash
kubectl --namespace default get secret example-k3s-differentpla-net-tls --template="{{index .data \"tls.key\" | base64decode}}" > example-k3s-differentpla-net.key
kubectl --namespace default get secret example-k3s-differentpla-net-tls --template="{{index .data \"tls.crt\" | base64decode}}" > example-k3s-differentpla-net.crt
```

Check the certificate details:

```bash
openssl x509 -in example-k3s-differentpla-net.crt -text -noout
```

## [Adjusting the Certificate Manifest](#adjusting-the-certificate-manifest)

Make adjustments to the `Certificate` manifest if necessary:

```yaml
spec:
  commonName: example.k3s.differentpla.net
  dnsNames:

- example.k3s.differentpla.net
  privateKey:
    algorithm: ECDSA
  usages:
  - server auth
  - client auth
```

To recreate the certificate, delete the secret, and cert-manager will recreate it:

```bash
kubectl delete secret example-k3s-differentpla-net-tls
```

## [Using Ingress](#using-ingress)

For Ingress resources, cert-manager can automatically issue certificates if annotated appropriately. Note that changing the private key algorithm via annotations is not supported.

## [Using IngressRoute](#using-ingressroute)

Cert-manager currently cannot interface directly with Traefik CRDs, but creating a fake Ingress alongside the real IngressRoute can serve as a workaround.

By following these steps, you can install cert-manager on Kubernetes and automate the management of your TLS certificates, simplifying the process of maintaining secure connections.
