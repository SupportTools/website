---
title: "Cert Manager"
date: 2024-12-17T00:00:00-05:00
lastmod: 2026-10-23
draft: false
tags: ["Known Good Designs", "Cluster Services", "Cert Manager"]
categories:
- Known Good Designs
author: "Matthew Mattox - mmattox@support.tools"
description: "Known good design for deploying cert-manager v1.21 in a Kubernetes cluster with Helm or Argo CD, including Let's Encrypt issuers for Traefik ingress and Gateway API."
more_link: "yes"
url: "/known-good-designs/cluster-services/cert-manager/"
---

![Cert Manager Logo](https://cdn.support.tools/known-good-designs/cluster-services/cert-manager/certmanager.png)

This is the known good design for cert-manager using Helm or Argo CD.

<!--more-->

## [Overview](#overview)

### [Cert Manager Overview](#cert-manager-overview)
cert-manager is a Kubernetes-native controller that automates issuing and renewing TLS certificates. It integrates with certificate authorities such as Let's Encrypt (ACME), HashiCorp Vault, and private CAs, and stores the resulting certificates in Kubernetes Secrets. Rancher depends on it for Rancher-generated and Let's Encrypt certificates.

#### Key Features
- **Automated Certificate Renewal:** Renews certificates before they expire.
- **Support for Multiple Certificate Authorities:** ACME, Vault, CA, and self-signed issuers, plus external issuers.
- **ACME Challenge Types:** HTTP-01 (through an Ingress or a Gateway API HTTPRoute) and DNS-01.
- **Custom Resource Definitions (CRDs):** `Certificate`, `Issuer`, `ClusterIssuer`, and related resources.
- **Ingress and Gateway Integration:** Annotate an Ingress or a Gateway with an issuer and cert-manager creates the certificate.

### [Supported Versions](#supported-versions)

As of October 2026, the [cert-manager supported releases page](https://cert-manager.io/docs/releases/) lists **1.21** (released July 8, 2026) and **1.20** (March 10, 2026) as supported; 1.22 is expected around November 2026. The latest patch is **v1.21.2**. Older examples that pin v1.9 or v1.16 are end of life: v1.9 reached EOL on January 11, 2023 and v1.16 on June 10, 2025.

---

![Cert Manager Diagram](https://cdn.support.tools/known-good-designs/cluster-services/cert-manager/diagram.png)

---

### [Implementation Details](#implementation-details)

#### [Option A: Helm Installation](#option-a-helm-installation)

##### [Step 1: Install Cert Manager](#step-1-install-cert-manager)
The [cert-manager Helm guide](https://cert-manager.io/docs/installation/helm/) recommends the OCI chart:
```bash
helm install cert-manager oci://quay.io/jetstack/charts/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --version v1.21.2 \
  --set crds.enabled=true
```

The legacy repository still works and is updated a few hours after the OCI chart:
```bash
helm repo add jetstack https://charts.jetstack.io --force-update
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --version v1.21.2 \
  --set crds.enabled=true
```

`crds.enabled=true` replaces the deprecated `installCRDs=true`. The chart also defaults `crds.keep=true`, which keeps the CRDs (and therefore your certificates) if the Helm release is uninstalled.

For deploying cert-manager through Argo CD, see Option B below and the [Argo CD design](../argocd/).

For Rancher-specific guidance, see the cert-manager step in the [Rancher Helm install guide](https://ranchermanager.docs.rancher.com/getting-started/installation-and-upgrade/install-upgrade-on-a-kubernetes-cluster).

##### [Step 2: Verify Installation](#step-2-verify-installation)
Check if the cert-manager pods are running:
```bash
kubectl get pods -n cert-manager
```

Expected output:
```plaintext
NAME                                       READY   STATUS    RESTARTS   AGE
cert-manager-xxxxxxx-xxxxx                 1/1     Running   0          1m
cert-manager-cainjector-xxxxxxx-xxxxx      1/1     Running   0          1m
cert-manager-webhook-xxxxxxx-xxxxx         1/1     Running   0          1m
```

##### [Step 3: Create a ClusterIssuer](#step-3-create-a-clusterissuer)
The `ClusterIssuer` defines the certificate authority used for issuing certificates. For Let's Encrypt with an Ingress controller, use `ingressClassName`, which the [cert-manager HTTP-01 docs](https://cert-manager.io/docs/configuration/acme/http01/) call the recommended way to select the controller (since v1.12). The older `class` field is only recommended for ingress-gce.

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: your-email@example.com
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
    - http01:
        ingress:
          ingressClassName: traefik
```

Use the IngressClass of your controller. `traefik` is the class on RKE2 v1.36 and later and in the Traefik designs on this site. Do not build new issuers around `nginx`: the Kubernetes Ingress NGINX project was retired in March 2026 ([announcement](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/)).

Apply the ClusterIssuer:
```bash
kubectl apply -f cluster-issuer.yaml
```

##### [Optional: Gateway API](#optional-gateway-api)
cert-manager can solve HTTP-01 challenges through a Gateway API HTTPRoute and issue certificates for Gateway listeners. Per the [cert-manager Gateway docs](https://cert-manager.io/docs/usage/gateway/), enable it with the `config.gatewayAPI.enabled` value, and install the Gateway API CRDs before cert-manager starts (restart cert-manager if you add them later):

```bash
helm upgrade --install cert-manager oci://quay.io/jetstack/charts/cert-manager \
  --namespace cert-manager \
  --version v1.21.2 \
  --set crds.enabled=true \
  --set config.gatewayAPI.enabled=true
```

A solver that uses an existing Gateway (it needs a listener on port 80):

```yaml
solvers:
- http01:
    gatewayHTTPRoute:
      parentRefs:
      - name: <gateway-name>      # find it with: kubectl get gateway -A
        namespace: <gateway-namespace>
        kind: Gateway
```

Then annotate the Gateway with `cert-manager.io/cluster-issuer: letsencrypt-prod` to have cert-manager create certificates for its HTTPS listeners.

---

#### [Option B: ArgoCD Installation](#option-b-argocd-installation)

##### [Step 1: Install Cert Manager](#step-1-install-cert-manager)

To automate cert-manager deployment using Argo CD, create the following `Application` resource:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: cert-manager
  namespace: argocd
spec:
  destination:
    namespace: cert-manager
    server: https://kubernetes.default.svc
  project: cluster-services
  source:
    chart: cert-manager
    repoURL: https://charts.jetstack.io
    targetRevision: v1.21.2
    helm:
      valuesObject:
        crds:
          enabled: true
          keep: true
        prometheus:
          enabled: true
          servicemonitor:
            enabled: true
        dns01RecursiveNameservers: "1.1.1.1:53,8.8.8.8:53"
        dns01RecursiveNameserversOnly: true
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

Notes on these values (all from the v1.21.2 chart `values.yaml`):

- `prometheus.servicemonitor.enabled` is lowercase `servicemonitor`. It creates a ServiceMonitor and requires the Prometheus Operator CRDs. The ServiceMonitor is created in the cert-manager namespace unless you set `prometheus.servicemonitor.namespace`.
- `dns01RecursiveNameservers` is the chart value for the DNS-01 self-check nameservers. It replaces passing `--dns01-recursive-nameservers` through `extraArgs`.
- The `ServerSideApply` feature gate is alpha and off by default in v1.21, so it is not set here.

Apply this configuration to Argo CD:
```bash
kubectl apply -f cert-manager-argocd.yaml
```

---

### [Monitoring and Troubleshooting](#monitoring-and-troubleshooting)

#### [Monitoring Certificates](#monitoring-certificates)
cert-manager exposes Prometheus metrics, including certificate expiry timestamps. With the Prometheus Operator installed, let the chart create the ServiceMonitor (`prometheus.servicemonitor.enabled=true`) rather than writing one by hand; the chart sets the correct selector and port. Alert on `certmanager_certificate_expiration_timestamp_seconds` approaching the current time and on `certmanager_certificate_ready_status{condition="False"}`.

### [Common Issues](#common-issues)
- **Challenge Validation Failure:** Check that DNS points at your load balancer, that port 80 is reachable from the internet for HTTP-01, and that the solver's `ingressClassName` (or Gateway `parentRefs`) matches a controller that is actually running. `kubectl describe challenge -A` shows the reason.
- **Rate Limits:** Use the Let's Encrypt staging server (`https://acme-staging-v02.api.letsencrypt.org/directory`) while testing.

---

### [Considerations](#considerations)
- **High Availability:** The chart runs one replica of each component by default. For more, raise `replicaCount`, `webhook.replicaCount`, and `cainjector.replicaCount`, and enable the matching `podDisruptionBudget.enabled` values, as the chart comments advise.
- **Namespace Scope:** Use `Issuer` for certificates within a namespace and `ClusterIssuer` for cluster-wide certificates.
- **Backup Certificates:** Back up the ACME account key Secret and important certificate Secrets so a restore does not trigger mass reissuance and rate limits.
- **Upgrades:** Only the two most recent minor releases receive fixes, so plan to upgrade at least every few months and read the release notes first.
