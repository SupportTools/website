---
title: "Cert Manager"
date: 2024-12-17T00:00:00-05:00
draft: false
tags: ["Known Good Designs", "Cluster Services", "Cert Manager"]
categories:
- Known Good Designs
- Cluster Services
author: "Matthew Mattox - mmattox@support.tools"
description: "Known good design for deploying Cert Manager in a Kubernetes cluster."
more_link: "yes"
url: "/known-good-designs/cluster-services/cert-manager/"
---

![Cert Manager Logo](https://cdn.support.tools/known-good-designs/cluster-services/cert-manager/certmanager.png)

This is the known good design for Cert Manager using Helm or ArgoCD.

<!--more-->

# [Overview](#overview)

## [Cert Manager Overview](#cert-manager-overview)
Cert Manager is a Kubernetes-native tool that automates the management and issuance of TLS certificates. It integrates seamlessly with certificate authorities like Let's Encrypt and HashiCorp Vault, making it a vital component for securing Kubernetes workloads. Cert Manager handles certificate lifecycle management, including issuance, renewal, and revocation, ensuring your clusters remain compliant with security standards.

### Key Features
- **Automated Certificate Renewal:** Avoid downtime caused by expired certificates.
- **Support for Multiple Certificate Authorities:** Flexible configuration for various environments.
- **Built-in Validation Mechanisms:** Includes HTTP-01, DNS-01, and TLS-ALPN-01 challenges.
- **Custom Resource Definitions (CRDs):** Extends Kubernetes functionality with Certificate and Issuer resources.

---

![Cert Manager Diagram](https://cdn.support.tools/known-good-designs/cluster-services/cert-manager/diagram.png)

---

## [Implementation Details](#implementation-details)

### [Option A: Helm Installation](#option-a-helm-installation)

#### [Step 1: Install Cert Manager](#step-1-install-cert-manager)
Install Cert Manager using Helm to manage the CRDs and its deployment:
```bash
helm repo add jetstack https://charts.jetstack.io
helm repo update
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --version v1.9.1 \
  --set installCRDs=true
```

For more detailed steps on using ArgoCD to install applications like Cert Manager, refer to the [ArgoCD Post](../argocd/).

You can also refer to the [Rancher Documentation](https://ranchermanager.docs.rancher.com/getting-started/installation-and-upgrade/install-upgrade-on-a-kubernetes-cluster#4-install-cert-manager) for specific guidance on installing Cert Manager for Rancher.

#### [Step 2: Verify Installation](#step-2-verify-installation)
Check if the Cert Manager pods are running:
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

#### [Step 3: Create a ClusterIssuer](#step-3-create-a-clusterissuer)
The `ClusterIssuer` defines the certificate authority used for issuing certificates. For Let's Encrypt, use the following configuration:
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
          class: nginx
```
Apply the ClusterIssuer:
```bash
kubectl apply -f cluster-issuer.yaml
```

---

### [Option B: ArgoCD Installation](#option-b-argocd-installation)

#### [Step 1: Install Cert Manager](#step-1-install-cert-manager)

To automate Cert Manager deployment using ArgoCD, create the following `Application` resource:

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
    targetRevision: v1.16.2
    helm:
      parameters:
        - name: installCRDs
          value: 'true'
        - name: prometheus.enabled
          value: 'true'
        - name: prometheus.serviceMonitor.enabled
          value: 'true'
        - name: prometheus.serviceMonitor.namespace
          value: monitoring
        - name: featureGates
          value: ServerSideApply=true
        - name: extraArgs
          value: '{--dns01-recursive-nameservers=1.1.1.1:53}'
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

Apply this configuration to ArgoCD:
```bash
kubectl apply -f cert-manager-argocd.yaml
```

---

## [Monitoring and Troubleshooting](#monitoring-and-troubleshooting)

### [Monitoring Certificates](#monitoring-certificates)
Cert Manager exposes metrics compatible with Prometheus:
1. Install Prometheus Operator in your cluster.
2. Configure a `ServiceMonitor` for Cert Manager:
   ```yaml
   apiVersion: monitoring.coreos.com/v1
   kind: ServiceMonitor
   metadata:
     name: cert-manager
     namespace: cert-manager
   spec:
     selector:
       matchLabels:
         app: cert-manager
     endpoints:
     - port: http-metrics
   ```

## [Common Issues](#common-issues)
- **Challenge Validation Failure:** Check the DNS records or Ingress configuration to ensure the challenge is reachable.
- **Rate Limits:** Use staging servers for testing to avoid hitting Let's Encrypt's rate limits.

---

## [Considerations](#considerations)
- **Resource Allocation:** Cert Manager's webhook can be resource-intensive. Ensure your cluster has adequate resources.
- **Namespace Scope:** Use `Issuer` for certificates within a namespace and `ClusterIssuer` for cluster-wide certificates.
- **Backup Certificates:** Regularly back up secrets containing certificate keys to avoid downtime in case of data loss.
- **RBAC Permissions:** Ensure the `cert-manager` service account has sufficient permissions in all relevant namespaces.
