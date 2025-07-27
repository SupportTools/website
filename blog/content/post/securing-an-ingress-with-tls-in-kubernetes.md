---
title: "Securing an Ingress with TLS in Kubernetes"
date: 2024-05-18T19:26:00-05:00
draft: false
tags: ["Ingress", "Kubernetes", "TLS"]
categories:
- DevOps
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to secure an Ingress with TLS in Kubernetes, including generating certificates and configuring the Ingress resource."
more_link: "yes"
url: "/securing-an-ingress-with-tls-in-kubernetes/"
---

Learn how to secure an Ingress with TLS in Kubernetes, including generating certificates and configuring the Ingress resource. This guide will help you enhance the security of your services.

<!--more-->

# [Securing an Ingress with TLS in Kubernetes](#securing-an-ingress-with-tls-in-kubernetes)

To enhance the security of my Gitea instance and Docker registry, I’ll replace the LoadBalancer with an Ingress, which will allow TLS termination. Let's use the whoami example from earlier and add a certificate.

## [Configuring the Ingress](#configuring-the-ingress)

Update the `ingress.yaml` file to the following:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: whoami
  namespace: whoami
  annotations:
    traefik.ingress.kubernetes.io/router.entrypoints: websecure
    traefik.ingress.kubernetes.io/router.tls: "true"
spec:
  tls:
  - hosts:
      - whoami.k3s.differentpla.net
    secretName: whoami-tls
  rules:
  - host: whoami.k3s.differentpla.net
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: whoami
            port:
              number: 80
```

Ensure the `traefik.ingress.kubernetes.io/router.tls: "true"` annotation uses a quoted string for "true" to avoid errors.

## [Creating the Server Certificate](#creating-the-server-certificate)

Generate the server certificate using an Elixir script:

```bash
./certs create-cert \
    --issuer-cert k3s-ca.crt --issuer-key k3s-ca.key \
    --out-cert whoami.crt --out-key whoami.key \
    --template server \
    --subject '/CN=whoami.k3s.differentpla.net'
base64 -w0 < whoami.crt
base64 -w0 < whoami.key
```

## [Creating the TLS Secret](#creating-the-tls-secret)

Create the `tls-secret.yaml` file:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: whoami-tls
  namespace: whoami
data:
  tls.crt: LS0tLS1...
  tls.key: LS0tLS1...
type: kubernetes.io/tls
```

## [Troubleshooting](#troubleshooting)

Ensure the secret exists. If not, Traefik uses its default certificate. Check the logs to confirm:

```bash
kubectl --namespace kube-system logs traefik-786ff64748-mx9pf
```

Example log entry:

```
time="2022-01-31T18:53:20Z" level=error msg="Error configuring TLS: secret whoami/whoami-tls does not exist" ingress=whoami providerName=kubernetes namespace=whoami
```

For more information, refer to the [Kubernetes documentation on Ingress TLS](https://kubernetes.io/docs/concepts/services-networking/ingress/#tls).

By following these steps, you can secure your Ingress with TLS in Kubernetes, ensuring secure access to your services.
