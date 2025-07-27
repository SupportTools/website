---
title: "CKS Practice Questions"  
date: 2024-10-04T19:26:00-05:00  
draft: false  
tags: ["CKS", "Kubernetes", "Certification", "Security", "Practice Questions"]  
categories:  
- Kubernetes  
- Certification  
- CKS  
author: "Matthew Mattox - mmattox@support.tools"  
description: "Prepare for the Certified Kubernetes Security Specialist (CKS) exam with these practice questions covering essential Kubernetes security concepts."  
more_link: "yes"  
url: "/cks-practice-questions/"  
---

The Certified Kubernetes Security Specialist (CKS) exam focuses on Kubernetes security and involves mastering topics such as cluster hardening, monitoring, networking policies, and securing workloads. To help you prepare, here’s a list of practice questions that cover key Kubernetes security topics you need to know for the CKS exam.

<!--more-->

### CKS Practice Questions

#### 1. **Secure a Kubernetes API Server**

Ensure that the Kubernetes API server only accepts TLS 1.3 connections by updating the `kube-apiserver` configuration.

```bash
--tls-min-version=VersionTLS13
```

You can also verify the change by running:

```bash
kubectl get pods -n kube-system
kubectl describe pod <apiserver-pod> -n kube-system
```

#### 2. **Implement Role-Based Access Control (RBAC)**

Create an RBAC role that allows read-only access to ConfigMaps in the `dev` namespace.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: dev
  name: configmap-reader
rules:
- apiGroups: [""]
  resources: ["configmaps"]
  verbs: ["get", "list"]
```

Then bind the role to a user or service account:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: read-configmaps
  namespace: dev
subjects:
- kind: User
  name: jane
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: configmap-reader
  apiGroup: rbac.authorization.k8s.io
```

#### 3. **Audit a Cluster for Security Compliance**

Use the `kube-bench` tool to audit your Kubernetes cluster for security compliance against the CIS Kubernetes Benchmark.

```bash
kube-bench
```

Review the results and take action to fix any issues reported by `kube-bench`.

#### 4. **Create a Network Policy**

Create a NetworkPolicy that denies all ingress traffic to pods in the `prod` namespace except traffic from pods with the label `app=frontend`.

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-all-ingress-except-frontend
  namespace: prod
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: frontend
```

#### 5. **Enable Pod Security Policies**

Create a PodSecurityPolicy that restricts privileged access and ensures containers run as non-root users.

```yaml
apiVersion: policy/v1beta1
kind: PodSecurityPolicy
metadata:
  name: restricted-psp
spec:
  privileged: false
  runAsUser:
    rule: MustRunAsNonRoot
  seLinux:
    rule: RunAsAny
  fsGroup:
    rule: MustRunAs
    ranges:
    - min: 1
      max: 65535
  volumes:
  - configMap
  - emptyDir
```

Then create an RBAC role to allow the use of this policy:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: dev
  name: use-psp
rules:
- apiGroups: ["policy"]
  resources: ["podsecuritypolicies"]
  verbs: ["use"]
  resourceNames: ["restricted-psp"]
```

#### 6. **Scan Container Images for Vulnerabilities**

Use `trivy` to scan a container image for vulnerabilities before deploying it to Kubernetes.

```bash
trivy image nginx:latest
```

Review the report and ensure no critical vulnerabilities are present before deploying the image.

#### 7. **Encrypt Kubernetes Secrets at Rest**

Ensure that Kubernetes secrets are encrypted at rest by configuring encryption in the `kube-apiserver`. Update the encryption configuration file and apply it.

```yaml
kind: EncryptionConfiguration
apiVersion: apiserver.config.k8s.io/v1
resources:
  - resources:
      - secrets
    providers:
      - aescbc:
          keys:
            - name: key1
              secret: <base64-encoded-key>
      - identity: {}
```

Update the `kube-apiserver` to use this encryption configuration:

```bash
--encryption-provider-config=/etc/kubernetes/encryption-config.yaml
```

#### 8. **Restrict API Access with RBAC**

Create a Role that grants read-only access to pods in the `production` namespace and binds it to the user `ops-user`.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: production
  name: pod-reader
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: pod-reader-binding
  namespace: production
subjects:
- kind: User
  name: ops-user
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: pod-reader
  apiGroup: rbac.authorization.k8s.io
```

#### 9. **Implement Network Segmentation with Cilium**

Use Cilium to implement network segmentation by enforcing eBPF-based security policies in Kubernetes. Install Cilium and create network policies using Cilium's CRDs.

```bash
helm install cilium cilium/cilium --version 1.10.2 --namespace kube-system
```

After installation, create a Cilium Network Policy:

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-frontend
  namespace: prod
spec:
  endpointSelector:
    matchLabels:
      app: frontend
  ingress:
  - fromEndpoints:
    - matchLabels:
        app: backend
```

#### 10. **Set Up Pod Security Admission Controller**

Enable the Pod Security Admission Controller in Kubernetes to enforce security profiles like `baseline` and `restricted`:

- Modify the `kube-apiserver` flags to enable Pod Security Admission:

```bash
--enable-admission-plugins=PodSecurity
```

- Apply a `PodSecurity` label to enforce a baseline security level on a namespace:

```bash
kubectl label namespace my-namespace pod-security.kubernetes.io/enforce=baseline
```

### Final Thoughts

The CKS exam focuses heavily on securing Kubernetes clusters, workloads, and operations. These practice questions cover essential Kubernetes security topics and provide hands-on experience with tools like `kube-bench`, `trivy`, and RBAC policies. By mastering these concepts and commands, you'll be well-prepared for the CKS exam and confident in securing Kubernetes environments.
