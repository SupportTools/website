---
title: "Kubernetes Pod Security Context Best Practices"
date: 2025-02-19T09:08:30-06:00
draft: false
tags: ["Kubernetes", "DevOps", "Cloud", "Security", "PodSecurityContext", "Container Security"]
categories:
- Kubernetes
- DevOps
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to implementing and managing Pod Security Contexts in Kubernetes for enhanced container security"
more_link: "yes"
url: "/kubernetes-pod-security-context-best-practices/"
---

Learn how to enhance your Kubernetes cluster security by properly implementing Pod Security Contexts, including best practices and real-world examples.

<!--more-->

## Understanding Pod Security Context

Pod Security Context defines privilege and access control settings for Pods and containers. It includes settings for:

- User and group IDs
- Filesystem permissions
- Linux capabilities
- SELinux context
- Seccomp profiles
- AppArmor profiles

## Why Pod Security Context Matters

Security contexts are crucial for:

1. Preventing privilege escalation
2. Limiting container capabilities
3. Enforcing least privilege principle
4. Protecting host resources
5. Ensuring compliance requirements

## Basic Security Context Configuration

Here's a basic example of a Pod with security context:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: secure-pod
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 3000
    fsGroup: 2000
  containers:
  - name: secure-container
    image: nginx
    securityContext:
      allowPrivilegeEscalation: false
      capabilities:
        drop:
        - ALL
```

## Essential Security Context Settings

### 1. Run as Non-Root User

Always run containers as non-root users:

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  runAsGroup: 3000
```

### 2. Prevent Privilege Escalation

Disable privilege escalation:

```yaml
securityContext:
  allowPrivilegeEscalation: false
```

### 3. Drop Unnecessary Capabilities

Remove unnecessary Linux capabilities:

```yaml
securityContext:
  capabilities:
    drop:
    - ALL
    add:
    - NET_BIND_SERVICE  # Only if needed
```

### 4. Read-Only Root Filesystem

Enable read-only root filesystem:

```yaml
securityContext:
  readOnlyRootFilesystem: true
volumeMounts:
- name: tmp-volume
  mountPath: /tmp
volumes:
- name: tmp-volume
  emptyDir: {}
```

## Advanced Security Context Configurations

### 1. SELinux Options

Configure SELinux context:

```yaml
securityContext:
  seLinuxOptions:
    level: "s0:c123,c456"
```

### 2. Seccomp Profiles

Apply seccomp profiles:

```yaml
securityContext:
  seccompProfile:
    type: RuntimeDefault  # or Localhost
    localhostProfile: my-profiles/custom-seccomp.json
```

### 3. AppArmor Profiles

Enable AppArmor (via annotations):

```yaml
metadata:
  annotations:
    container.apparmor.security.beta.kubernetes.io/nginx: runtime/default
```

## Best Practices

### 1. Pod-level vs Container-level Security Context

Use Pod-level for shared settings:

```yaml
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
  containers:
  - name: container1
    securityContext:
      allowPrivilegeEscalation: false
  - name: container2
    securityContext:
      allowPrivilegeEscalation: false
```

### 2. Minimal Capabilities

Only add required capabilities:

```yaml
securityContext:
  capabilities:
    drop:
    - ALL
    add:
    - NET_BIND_SERVICE  # Only if needed for ports < 1024
```

### 3. File System Permissions

Set appropriate filesystem permissions:

```yaml
securityContext:
  fsGroup: 2000
  supplementalGroups: [3000, 4000]
```

## Security Context Templates

### 1. Web Application Template

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: secure-webapp
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 3000
    fsGroup: 2000
  containers:
  - name: webapp
    image: nginx
    securityContext:
      allowPrivilegeEscalation: false
      capabilities:
        drop:
        - ALL
        add:
        - NET_BIND_SERVICE
      readOnlyRootFilesystem: true
    volumeMounts:
    - name: tmp
      mountPath: /tmp
    - name: nginx-cache
      mountPath: /var/cache/nginx
  volumes:
  - name: tmp
    emptyDir: {}
  - name: nginx-cache
    emptyDir: {}
```

### 2. Database Template

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: secure-db
spec:
  securityContext:
    runAsUser: 999  # mysql user
    fsGroup: 999
  containers:
  - name: mysql
    image: mysql
    securityContext:
      allowPrivilegeEscalation: false
      capabilities:
        drop:
        - ALL
    volumeMounts:
    - name: data
      mountPath: /var/lib/mysql
  volumes:
  - name: data
    persistentVolumeClaim:
      claimName: mysql-pvc
```

## Common Issues and Solutions

### 1. Permission Denied Errors

Problem: Container can't write to filesystem
Solution: Configure appropriate fsGroup:

```yaml
securityContext:
  fsGroup: 2000
```

### 2. Capability Requirements

Problem: Application needs specific capabilities
Solution: Add only required capabilities:

```yaml
securityContext:
  capabilities:
    add:
    - NET_BIND_SERVICE
```

### 3. Volume Permission Issues

Problem: Container can't access mounted volumes
Solution: Configure volume permissions:

```yaml
securityContext:
  fsGroup: 2000
  supplementalGroups: [3000]
```

## Validation and Testing

### 1. Security Context Verification

```bash
# Check effective security context
kubectl exec pod-name -- id
kubectl exec pod-name -- ls -la /
```

### 2. Capability Testing

```bash
# Verify capabilities
kubectl exec pod-name -- capsh --print
```

### 3. Permission Testing

```bash
# Test filesystem permissions
kubectl exec pod-name -- touch /test-write
```

## Monitoring and Compliance

### 1. Pod Security Policy (PSP) Migration

With PSP deprecation, consider:
- Pod Security Admission
- OPA/Gatekeeper
- Custom admission controllers

### 2. Audit Logging

Enable audit logging for security events:

```yaml
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
- level: RequestResponse
  resources:
  - group: ""
    resources: ["pods"]
```

## Conclusion

Implementing proper Pod Security Contexts is crucial for maintaining a secure Kubernetes environment. Key takeaways:

- Always run containers as non-root
- Disable privilege escalation
- Drop unnecessary capabilities
- Use read-only root filesystems when possible
- Implement proper volume permissions
- Regular security audits

Remember to:
- Start with restrictive policies
- Test thoroughly in non-production
- Document security requirements
- Monitor for security violations
- Regularly review and update security contexts

For more information, refer to the [Kubernetes Security Context documentation](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/).
