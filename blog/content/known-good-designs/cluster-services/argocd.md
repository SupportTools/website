---
title: "ArgoCD"
date: 2024-12-17T00:00:00-05:00
draft: false
tags: ["Known Good Designs", "Cluster Services", "ArgoCD", "GitOps"]
categories:
- Known Good Designs
- Cluster Services
author: "Matthew Mattox - mmattox@support.tools"
description: "Known good design for deploying ArgoCD in a Kubernetes cluster."
more_link: "yes"
url: "/known-good-designs/cluster-services/argocd/"
---

![ArgoCD Logo](https://cdn.support.tools/known-good-designs/cluster-services/argocd/logo.png)

This is the known good design for deploying ArgoCD in a Kubernetes cluster.

<!--more-->

# [Overview](#overview)

## [ArgoCD Overview](#argocd-overview)
ArgoCD is a declarative, GitOps continuous delivery tool for Kubernetes. It allows you to manage application deployments through Git repositories, ensuring your Kubernetes cluster state matches the desired state defined in your Git repositories.

### Key Features
- **GitOps Workflow:** Keeps cluster applications in sync with Git repositories.
- **Declarative Configuration:** Enables version control for application configurations.
- **Self-Healing:** Automatically detects and fixes configuration drifts.
- **Multi-Cluster Management:** Manage multiple clusters from a single control plane.

---

![Application of Applications](https://cdn.support.tools/known-good-designs/cluster-services/argocd/application-of-applications.webp)

---

## [Implementation Details](#implementation-details)

### [Step 1: Install ArgoCD](#step-1-install-argocd)
To install ArgoCD, use the official Helm chart for streamlined deployment:
```bash
helm repo add argo https://argoproj.github.io/argo-helm
helm repo update
helm install argocd argo/argo-cd --namespace argocd --create-namespace
```

For additional guidance, refer to the [Rancher Documentation](https://ranchermanager.docs.rancher.com/getting-started/installation-and-upgrade/install-upgrade-on-a-kubernetes-cluster#4-install-cert-manager) for installing GitOps tools like ArgoCD in Rancher-managed clusters.

---

### [Step 2: Access ArgoCD Locally via kubectl port-forward](#step-2-access-argocd-locally-via-kubectl-port-forward)

If you prefer not to expose ArgoCD externally, you can use `kubectl port-forward` to access the ArgoCD server from your local machine.

1. **Port-Forward the ArgoCD Server:**
   Run the following command to forward the local port 8080 to the ArgoCD server service in the `argocd` namespace:
   ```bash
   kubectl port-forward svc/argocd-server -n argocd 8080:443
   ```

2. **Access ArgoCD:**
   Open your browser and navigate to:
   ```
   https://localhost:8080
   ```

3. **Log In:**
   Retrieve the initial admin password:
   ```bash
   kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" | base64 --decode
   ```
   Use `admin` as the username and the retrieved password to log in.

---

![Example Dashboard](https://cdn.support.tools/known-good-designs/cluster-services/argocd/example-dashboard.png)

---

## [Configuring ArgoCD Applications](#configuring-argocd-applications)

### Example: Deploying an Application Using ArgoCD
```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: example-app
  namespace: argocd
spec:
  destination:
    namespace: example-namespace
    server: https://kubernetes.default.svc
  project: default
  source:
    repoURL: https://github.com/example/repo.git
    targetRevision: HEAD
    path: manifests
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

Apply the application manifest:
```bash
kubectl apply -f application.yaml
```

---

![Deploying an Application](https://cdn.support.tools/known-good-designs/cluster-services/argocd/How-to-deploy-an-application-in-Kubernetes-using-Argo-CD-with-GitHub.webp)

---

## [Monitoring and Troubleshooting](#monitoring-and-troubleshooting)

### [Monitoring ArgoCD](#monitoring-argocd)
ArgoCD exposes metrics compatible with Prometheus. To monitor ArgoCD:
1. Install Prometheus and Grafana in your cluster.
2. Create a `ServiceMonitor` for ArgoCD:
   ```yaml
   apiVersion: monitoring.coreos.com/v1
   kind: ServiceMonitor
   metadata:
     name: argocd
     namespace: argocd
   spec:
     selector:
       matchLabels:
         app.kubernetes.io/part-of: argocd
     endpoints:
     - port: http-metrics
   ```

### [Troubleshooting Common Issues](#troubleshooting-common-issues)
- **Sync Failures:** Check the logs for the ArgoCD application controller:
  ```bash
  kubectl logs -n argocd -l app.kubernetes.io/name=argocd-application-controller
  ```
- **Access Issues:** Ensure the ArgoCD server is exposed correctly via LoadBalancer or Ingress.
- **Permission Denied:** Verify that ArgoCD has sufficient RBAC permissions in the target namespace.

---

## [Considerations](#considerations)
- **Namespace Isolation:** Use ArgoCD projects to isolate applications by namespace and permissions.
- **RBAC Configuration:** Limit access to ArgoCD applications based on team roles.
- **Backup and Restore:** Regularly back up ArgoCD configurations and secrets to ensure recoverability in case of failure.
- **Cluster Scalability:** Test ArgoCD performance in large-scale clusters to ensure it meets your scaling requirements.
