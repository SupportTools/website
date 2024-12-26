---
title: "Securing Kubernetes Workloads with Pod Security Admission"
date: 2024-12-27T01:00:00-05:00
draft: false
tags: ["Kubernetes", "Security", "Pod Security Admission"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to secure your Kubernetes workloads using Pod Security Admission policies, replacing PodSecurityPolicies in modern clusters."
more_link: "yes"
url: "/kubernetes-pod-security-admission/"
---

Kubernetes security begins at the pod level, and with the deprecation of PodSecurityPolicies, Pod Security Admission (PSA) has become the go-to feature for enforcing security policies. In this guide, we’ll cover how to use PSA to secure your workloads effectively.

<!--more-->

# [Securing Kubernetes Workloads with Pod Security Admission](#securing-kubernetes-workloads-with-pod-security-admission)

## What is Pod Security Admission?

Pod Security Admission (PSA) is a built-in Kubernetes admission controller introduced to enforce Pod Security Standards (PSS). These standards—Privileged, Baseline, and Restricted—define security profiles for workloads:
- **Privileged**: No restrictions; use only when necessary.  
- **Baseline**: Minimal viable security for apps.  
- **Restricted**: Best practices for hardened security.

PSA validates pod specifications against these profiles and enforces compliance before scheduling.

## Why Use Pod Security Admission?

### Benefits:
1. Simplifies security by adhering to predefined standards.
2. Replaces the deprecated PodSecurityPolicy.
3. Reduces attack surface by restricting risky configurations like host networking or privileged containers.
4. Provides namespace-level granularity for applying policies.

## Enabling Pod Security Admission

### Step 1: Check Kubernetes Version
PSA is available from Kubernetes **v1.23+**. Ensure your cluster is up-to-date:
```bash
kubectl version
```

### Step 2: Enable the Admission Plugin
Modify the `kube-apiserver` configuration to include the `PodSecurity` plugin:
```yaml
--enable-admission-plugins=PodSecurity,...
```

Restart the `kube-apiserver` to apply changes.

### Step 3: Annotate Namespaces
PSA works on a per-namespace basis. Annotate namespaces with the desired security profile:
```bash
kubectl annotate namespace <namespace-name> \
  pod-security.kubernetes.io/enforce=baseline \
  pod-security.kubernetes.io/audit=restricted \
  pod-security.kubernetes.io/warn=restricted
```

### Annotations Explained:
- **enforce**: Blocks non-compliant pods.  
- **audit**: Logs non-compliance without blocking.  
- **warn**: Warns users about non-compliance.

## Applying Pod Security Standards

### Example: Enforcing Restricted Profile
To enforce the **Restricted** profile in the `production` namespace:
```bash
kubectl annotate namespace production \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/enforce-version=v1.25
```
This ensures the `Restricted` profile is applied based on Kubernetes v1.25 standards.

### Testing Compliance
Attempt to deploy a non-compliant pod:
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: test-pod
spec:
  containers:
  - name: nginx
    image: nginx
    securityContext:
      privileged: true
```
You should see an error blocking the deployment.

## Combining PSA with Other Tools

1. **Network Policies**: Restrict pod communication for defense-in-depth.  
2. **OPA Gatekeeper**: Add custom policies for advanced use cases.  
3. **CI/CD Integration**: Test PSA compliance during build pipelines using tools like `kube-score` or `kubectl neat`.

## Best Practices for Using Pod Security Admission

1. **Start with Audit and Warn Modes**:
   - Gradually enforce policies to avoid disrupting workloads.

2. **Regularly Update Profiles**:
   - Keep annotations in sync with Kubernetes version updates.

3. **Use Least Privilege Principle**:
   - Restrict workloads to the minimum required permissions.

4. **Monitor and Adjust**:
   - Use logging and alerts to identify non-compliant workloads and refine policies.

## Conclusion

Pod Security Admission is a powerful tool for securing Kubernetes workloads without the complexity of PodSecurityPolicies. By leveraging PSA, you can enforce best practices, protect your cluster, and build a robust defense against common security threats.
