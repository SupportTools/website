---
title: "Resolving the Cert-manager Bug: Unexpected EOF Lockup Issue"
date: 2023-10-13T23:15:00-05:00
draft: false
tags: ["cert-manager", "kubernetes", "bug"]
categories:
- kubernetes
- cert-manager
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn How to Resolve Cert-manager Bug #4685: Fixing Unexpected EOF Lockup Issue in Kubernetes."
more_link: "yes"
---

Cert-manager has had the unfortunate luck of having a bug that causes it to lock up. This blog post will discuss how to resolve this issue and provide a workaround solution for those experiencing the problem.

[GH Issue](https://github.com/cert-manager/cert-manager/issues/4685)

## [Resolving the Cert-manager Bug: Unexpected EOF Lockup Issue](#resolving-the-cert-manager-bug-unexpected-eof-lockup-issue)

Cert-manager is a popular Kubernetes add-on that helps manage SSL certificates for your applications running on Kubernetes clusters. However, like any software, it's not immune to bugs and issues. One such issue that users have encountered is [GitHub issue #4685](https://github.com/cert-manager/cert-manager/issues/4685), which causes Cert-manager to lock up with the following error message:

```bash
I1013 21:50:12.808243 1 streamwatcher.go:111] Unexpected EOF during watch stream event decoding: unexpected EOF
```

This error can be particularly frustrating as it can lead to Cert-manager becoming unresponsive and causing disruptions in certificate management for your applications. In this blog post, we will explore this issue and provide a workaround solution that can help you mitigate it.

### [Understanding the Issue](#understanding-the-issue)

The "Unexpected EOF" error typically occurs when the kube-apiserver, which Cert-manager relies on for communication with the Kubernetes cluster, is restarted multiple times. This can disrupt the connection between Cert-manager and the kube-apiserver, leading to the abovementioned lockup issue.

### [Workaround Solution](#workaround-solution)

We can implement a workaround using Kubernetes resources to address the Cert-manager lockup issue caused by the unexpected EOF error. Below is a YAML configuration that you can apply to your cluster to create a Kubernetes Deployment that monitors Cert-manager pods for the error and automatically deletes them if it occurs. This will help ensure that Cert-manager pods are restarted and can recover from the lockup.

```yaml
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: log-watcher-sa
  namespace: cert-manager
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: log-watcher-cluster-role
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list", "watch", "delete"]
- apiGroups: [""]
  resources: ["pods/log"]
  verbs: ["get", "list", "watch"]  
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: log-watcher-cluster-role-binding
subjects:
- kind: ServiceAccount
  name: log-watcher-sa
  namespace: cert-manager
roleRef:
  kind: ClusterRole
  name: log-watcher-cluster-role
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: log-watcher
  labels:
    app: log-watcher
spec:
  replicas: 1
  selector:
    matchLabels:
      app: log-watcher
  template:
    metadata:
      labels:
        app: log-watcher
    spec:
      serviceAccountName: log-watcher-sa
      containers:
      - name: log-watcher
        image: supporttools/kube-builder
        command: ["/bin/sh", "-c"]
        args:
        - >
          while true;
          do
            pod_list=$(kubectl -n cert-manager get pods -l app.kubernetes.io/component=controller,app.kubernetes.io/instance=cert-manager -o name);
            for pod in $pod_list;
            do
              if kubectl -n cert-manager logs $pod | grep -q "streamwatcher.go:111] Unexpected EOF during watch stream event decoding: unexpected EOF";
              then
                kubectl -n cert-manager delete $pod;
              fi;
            done;
            sleep 60;
          done;
---
```

You can apply this YAML configuration to your Kubernetes cluster using `kubectl apply -f https://gist.githubusercontent.com/mattmattox/33062e5434536cf3cc493feed651abd5/raw/6e79e6dc2bffb00f8993284e8089742076dacdd9/kick-cert-manager.yaml`. This will create a deployment named `log-watcher` in the `cert-manager` namespace that continuously monitors Cert-manager pods for the error and deletes them if it's detected.

### [Conclusion](#conclusion)

While the Cert-manager lockup issue caused by the unexpected EOF error can be frustrating, implementing the workaround solution described above can help mitigate the problem and ensure the smooth operation of Cert-manager in your Kubernetes cluster. Monitor the Cert-manager GitHub repository for updates and patches that may address this issue in future releases.
