---
title: "(Not) Upgrading ArgoCD on Kubernetes"
date: 2024-05-18T19:26:00-05:00
draft: true
tags: ["ArgoCD", "Kubernetes", "Upgrade", "Deployment"]
categories:
- DevOps
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools."
description: "Documenting the challenges and solutions encountered while attempting to upgrade ArgoCD on Kubernetes to address a security fix."
more_link: "yes"
url: "/not-upgrading-argocd-on-kubernetes/"
---

Documenting the challenges and solutions encountered while attempting to upgrade ArgoCD on Kubernetes to address a security fix. Learn from this experience to manage your ArgoCD upgrades more effectively.

<!--more-->

# [(Not) Upgrading ArgoCD on Kubernetes](#not-upgrading-argocd-on-kubernetes)

There’s a security fix that needs to be applied; there’s an arm64 release candidate. Time to upgrade ArgoCD.

## [Upgrade Attempt](#upgrade-attempt)

The upgrade process should have been straightforward:

```bash
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/v2.3.0-rc5/manifests/install.yaml
```

However, it mostly was, except for this issue:

```
pod/argocd-applicationset-controller-9488fc486-jjt98   0/1     CrashLoopBackOff   4 (61s ago)   4m6s
```

### [Inspecting the Logs](#inspecting-the-logs)

Inspect the logs of the crashing pod:

```bash
kubectl --namespace argocd logs argocd-applicationset-controller-9488fc486-jjt98
```

Output:

```
standard_init_linux.go:228: exec user process caused: exec format error
```

Filed a bug report: [argo-cd#8394](https://github.com/argoproj/argo-cd/issues/8394).

## [Rolling Back the Upgrade](#rolling-back-the-upgrade)

Attempted to roll back the deployments:

```bash
kubectl --namespace argocd rollout undo deployment/argocd-redis
kubectl --namespace argocd rollout undo deployment/argocd-repo-server
kubectl --namespace argocd rollout undo deployment/argocd-server
kubectl --namespace argocd rollout undo deployment/argocd-notifications-controller
kubectl --namespace argocd rollout undo deployment/argocd-dex-server
kubectl --namespace argocd rollout undo deployment/argocd-applicationset-controller
kubectl --namespace argocd rollout undo statefulset/argocd-application-controller
```

### [Deleting Deployments and Stateful Sets](#deleting-deployments-and-stateful-sets)

Since rolling back didn't work, I deleted all the deployments and stateful sets:

```bash
kubectl --namespace argocd delete statefulset argocd-application-controller
kubectl --namespace argocd delete deployment argocd-notifications-controller
kubectl --namespace argocd delete deployment argocd-redis
kubectl --namespace argocd delete deployment argocd-repo-server
kubectl --namespace argocd delete deployment argocd-dex-server
kubectl --namespace argocd delete deployment argocd-applicationset-controller
kubectl --namespace argocd delete deployment argocd-server
```

Reapplied the previous install manifest to restore a working state.

## [Conclusion](#conclusion)

Upgrading ArgoCD on Kubernetes can be challenging, especially when dealing with architecture-specific issues. By documenting the problems encountered and the steps taken to resolve them, you can better prepare for similar situations in the future.

Keep an eye on the progress of the [argo-cd#8394](https://github.com/argoproj/argo-cd/issues/8394) issue to stay informed about potential fixes and improvements.

By following these steps and learning from this experience, you can manage your ArgoCD upgrades more effectively, ensuring minimal downtime and disruption to your services.
