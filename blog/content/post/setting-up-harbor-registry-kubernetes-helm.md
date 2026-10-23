---
title: "Install Harbor on Kubernetes with Helm (2026 Guide)"
date: 2025-02-19T18:30:00-05:00
lastmod: 2026-10-23
draft: false
tags: ["Harbor", "Kubernetes", "Registry", "Helm", "Containers"]
categories:
- Harbor
- Kubernetes
- Helm
author: "Matthew Mattox - mmattox@support.tools"
description: "Install Harbor 2.15 on Kubernetes with the official Helm chart: ingress, TLS, admin password, storage, docker login and push. Notary values removed."
more_link: "yes"
url: "/setting-up-harbor-registry-kubernetes-helm/"
quick_fix: |
  `helm repo add harbor https://helm.goharbor.io && helm repo update`, then
  `helm upgrade --install harbor harbor/harbor -n harbor --create-namespace -f values.yaml`
  with at least `expose.ingress.hosts.core`, `expose.ingress.className`, `expose.tls.certSource: secret` plus `expose.tls.secret.secretName`, `externalURL` and a non-default admin password.
  Remove any `notary` keys from old values files: Notary was dropped in Harbor 2.9.
---

**Harbor** is an open-source container registry with role-based access control, vulnerability scanning with Trivy, replication and image signature verification. This guide deploys it on Kubernetes with the official Helm chart, using values that work with the current chart (v1.19.x, Harbor v2.15.x at the time of this update).

<!--more-->

# Setting Up Harbor Registry on Kubernetes Using Helm

## What changed since older Harbor guides

If you are following an older tutorial, these are the differences that break installs:

- **Notary is gone.** Harbor removed Notary v1 in v2.9, so `expose.ingress.hosts.notary`, `expose.tls.secret.notarySecretName` and `notary.*` values no longer exist. Sign images with [Cosign or Notation](https://goharbor.io/docs/main/working-with-projects/working-with-images/sign-images/) instead; Harbor stores the signatures as OCI artifacts next to the image.
- **ChartMuseum is gone.** It was removed in Harbor v2.8. Push Helm charts as OCI artifacts with `helm push`.
- **Ingress class.** Set `expose.ingress.className` explicitly. If your cluster runs Traefik (the default on new RKE2 v1.36+ clusters) or several controllers, the default annotations aimed at ingress-nginx are ignored.
- **Kubernetes and Helm versions.** The chart README lists Kubernetes 1.20+ and Helm v3.2.0+ as the minimum.

## Section 1: Prerequisites

- **Kubernetes cluster** 1.20 or later, with a default StorageClass for persistent volumes.
- **Helm** v3.2.0 or later (Helm 3 or 4).
- **kubectl** configured for the cluster.
- **An ingress controller** (Traefik, ingress-nginx, HAProxy or another) or a LoadBalancer implementation.
- **A DNS name** such as `harbor.example.com` that points at the ingress or load balancer.

## Section 2: Add the Harbor Helm repository

```bash
helm repo add harbor https://helm.goharbor.io
helm repo update
helm search repo harbor/harbor --versions | head -5
```

## Section 3: Create the namespace and TLS secret

```bash
kubectl create namespace harbor
```

Harbor should always be served over TLS; Docker and containerd refuse plain HTTP registries unless you mark them insecure on every node. Use a certificate from your CA or cert-manager and store it as a TLS secret:

```bash
kubectl create secret tls harbor-tls --cert=tls.crt --key=tls.key -n harbor
```

If you use cert-manager, you can instead add a `cert-manager.io/cluster-issuer` annotation under `expose.ingress.annotations` and let it create the `harbor-tls` secret.

## Section 4: Create a values file

Store the admin password in a secret instead of the values file:

```bash
kubectl -n harbor create secret generic harbor-admin \
  --from-literal=HARBOR_ADMIN_PASSWORD='YourStrongPassword'
```

```yaml
# values.yaml
expose:
  type: ingress
  tls:
    enabled: true
    certSource: secret
    secret:
      secretName: harbor-tls
  ingress:
    className: nginx            # or traefik, haproxy, ...
    hosts:
      core: harbor.example.com
    annotations:
      # Large image layers: ingress-nginx defaults to a 1m body limit.
      nginx.ingress.kubernetes.io/proxy-body-size: "0"
      nginx.ingress.kubernetes.io/ssl-redirect: "true"

externalURL: https://harbor.example.com

existingSecretAdminPassword: harbor-admin
existingSecretAdminPasswordKey: HARBOR_ADMIN_PASSWORD

persistence:
  enabled: true
  resourcePolicy: "keep"
  persistentVolumeClaim:
    registry:
      size: 100Gi
    database:
      size: 5Gi
```

- **`expose.type`**: `ingress` here; `clusterIP`, `nodePort`, `loadBalancer` and `route` (a Gateway API HTTPRoute) are the other options.
- **`expose.tls.certSource`**: `secret` uses your certificate. The default `auto` generates a self-signed certificate, which clients will not trust.
- **`expose.ingress.className`**: the IngressClass of your controller (`kubectl get ingressclass`).
- **`externalURL`**: must match the hostname clients use, or `docker login` and token redirects fail.
- **`existingSecretAdminPassword`**: the initial admin password. If you set `harborAdminPassword` directly instead, never leave the default `Harbor12345`.
- **`persistence.resourcePolicy: keep`**: keeps the PVCs if the release is deleted, so a `helm uninstall` does not delete your images.

### Using Gateway API instead of Ingress

Current charts can create an `HTTPRoute` instead of an `Ingress`. Set `expose.type: route` and attach it to an existing Gateway with `expose.route.parentRefs`, and list the hostname under `expose.route.hosts`. TLS is then terminated on the Gateway listener, so set `expose.tls.enabled` to match your Gateway setup. Check `helm show values harbor/harbor --version 1.19.4` for the exact keys in your chart version.

For production, also consider `persistence.imageChartStorage.type: s3` (or another object store) for registry blobs, and external PostgreSQL and Redis via `database.type: external` and `redis.type: external`.

## Section 5: Install Harbor

```bash
helm upgrade --install harbor harbor/harbor \
  --namespace harbor \
  --version 1.19.4 \
  -f values.yaml
```

Pin `--version` so upgrades are deliberate. Chart v1.19.4 deploys Harbor v2.15.4. The chart maintainers flagged v1.19.3 as a release to skip because of a regression.

## Section 6: Verify the installation

```bash
helm status harbor -n harbor
kubectl get pods -n harbor
kubectl get ingress -n harbor
```

Expect pods for `harbor-core`, `harbor-portal`, `harbor-registry`, `harbor-jobservice`, `harbor-database`, `harbor-redis` and `harbor-trivy`, all `Running`. Then check the API:

```bash
curl -s https://harbor.example.com/api/v2.0/health | jq .
```

If a pod is crash looping, `kubectl logs -n harbor <pod> --previous` usually names the cause. A crash looping Redis pod is a common one; see [Harbor Redis Crashlooping](/post/harbor-redis-crashlooping/).

## Section 7: Log in and push an image

Open `https://harbor.example.com` and log in as `admin`. Then from a client:

```bash
docker login harbor.example.com
docker tag your-image:latest harbor.example.com/library/your-image:latest
docker push harbor.example.com/library/your-image:latest
```

Push a Helm chart as an OCI artifact:

```bash
helm registry login harbor.example.com
helm push mychart-0.1.0.tgz oci://harbor.example.com/library
```

For Kubernetes to pull from a private project, create an image pull secret:

```bash
kubectl create secret docker-registry harbor-pull \
  --docker-server=harbor.example.com \
  --docker-username='robot$myproject+puller' \
  --docker-password='<robot-token>' \
  -n <app-namespace>
```

Use a robot account rather than a personal login for cluster pulls.

## Section 8: Production checklist

- **Object storage** for registry blobs instead of a single RWO volume, so the registry can run more than one replica.
- **External PostgreSQL and Redis** for high availability and easier backups.
- **Backups** of the database and the blob store, tested by restoring.
- **Trivy** database updates: the scanner downloads its vulnerability DB, so allow that egress or configure an offline mirror.
- **Garbage collection** scheduled under **Administration > Clean Up**, and tag retention rules per project.
- **Proxy cache projects** for Docker Hub and other upstream registries to avoid pull rate limits.

## FAQ

### Why does `docker push` fail with "413 Request Entity Too Large"?

The ingress controller is limiting the request body. On ingress-nginx set `nginx.ingress.kubernetes.io/proxy-body-size: "0"`. Other controllers have their own setting; check that a buffering or body size middleware is not applied.

### Can I still enable Notary or ChartMuseum?

No. Both were removed (ChartMuseum in v2.8, Notary in v2.9). Use OCI Helm charts and Cosign or Notation signatures.

### Which ingress controller should I use for Harbor now that ingress-nginx is retired?

Any maintained controller works because Harbor only needs host-based routing and TLS. On RKE2 the default is now Traefik; see [Ingress-NGINX Retirement on RKE2](/ingress-nginx-retirement-rke2-migrating-traefik-without-downtime/) and [RKE2 Ingress-NGINX](/rke2-ingress-nginx/) for the background.

### What is the default Harbor admin password?

`Harbor12345` if you do not set one. Change it in the values before installing, or immediately after first login.

## Related guides

- [Harbor Redis Crashlooping](/post/harbor-redis-crashlooping/)
- [RKE2 Ingress-NGINX: Troubleshooting and 2026 Retirement](/rke2-ingress-nginx/)
- [Ingress-NGINX Retirement on RKE2: Migrating to Traefik Without Downtime](/ingress-nginx-retirement-rke2-migrating-traefik-without-downtime/)
