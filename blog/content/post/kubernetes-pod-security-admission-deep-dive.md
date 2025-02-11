---
title: "Deep Dive into Kubernetes Pod Security Admission"
date: 2025-02-11T08:29:00-06:00
draft: false
tags: ["Kubernetes", "Security", "PSA", "PodSecurityAdmission", "K8s"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to implementing and managing Pod Security Admission in Kubernetes"
more_link: "yes"
url: "/kubernetes-pod-security-admission-deep-dive/"
---

Learn how to effectively implement and manage Pod Security Admission in Kubernetes to enhance your cluster's security posture.

<!--more-->

# Table of Contents
- [Introduction](#introduction)
- [Understanding Pod Security Standards](#standards)
- [Pod Security Admission Modes](#modes)
- [Implementation Strategies](#implementation)
- [Migration from PodSecurityPolicies](#migration)
- [Real-world Examples](#examples)
- [Troubleshooting](#troubleshooting)
- [Best Practices](#best-practices)

# [Introduction](#introduction)
Pod Security Admission (PSA) is the built-in solution for enforcing security standards in Kubernetes clusters. It replaced PodSecurityPolicies (PSP) in Kubernetes 1.25, offering a more streamlined approach to pod security.

## Why Pod Security Admission?
- Native Kubernetes integration
- Simplified configuration compared to PSP
- Standardized security levels
- Namespace-level enforcement
- Better maintainability and consistency

# [Understanding Pod Security Standards](#standards)

## Three Security Levels

### 1. Privileged
- No restrictions
- Typically used for system and infrastructure workloads
- Example use cases:
  * Storage drivers
  * CNI plugins
  * Monitoring agents

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: kube-system
  labels:
    pod-security.kubernetes.io/enforce: privileged
```

### 2. Baseline
- Prevents known privilege escalation
- Suitable for most application workloads
- Key restrictions:
  * No privileged containers
  * No host namespace sharing
  * No privileged ports (<1024)

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: default
  labels:
    pod-security.kubernetes.io/enforce: baseline
    pod-security.kubernetes.io/warn: restricted
```

### 3. Restricted
- Highly-constrained policy
- Follows security best practices
- Enforces:
  * Running as non-root
  * Read-only root filesystem
  * Strict SecurityContext settings

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: secure-apps
  labels:
    pod-security.kubernetes.io/enforce: restricted
```

# [Pod Security Admission Modes](#modes)

## Enforce Mode
Mandatory policy enforcement:
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    pod-security.kubernetes.io/enforce: restricted
```

## Audit Mode
Logs violations without blocking:
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: development
  labels:
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: latest
```

## Warn Mode
Warns users about violations:
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: staging
  labels:
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: latest
```

# [Implementation Strategies](#implementation)

## Gradual Rollout Strategy

1. Start with Warn Mode:
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: my-application
  labels:
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/audit: restricted
```

2. Monitor and Fix Issues:
```bash
kubectl get events --field-selector reason=FailedCreate
```

3. Enforce Restrictions:
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: my-application
  labels:
    pod-security.kubernetes.io/enforce: restricted
```

## Version-specific Controls
Control policy versions per namespace:
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: version-specific
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: v1.25
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: latest
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: latest
```

# [Migration from PodSecurityPolicies](#migration)

## Step-by-Step Migration

1. Audit Existing PSPs:
```bash
kubectl get psp -o yaml > existing-psps.yaml
```

2. Map PSP to PSA Levels:
```yaml
# Example PSP to PSA mapping
apiVersion: v1
kind: Namespace
metadata:
  name: legacy-namespace
  labels:
    # Equivalent to restrictive PSP
    pod-security.kubernetes.io/enforce: restricted
```

3. Implement Parallel Policies:
Run both PSP and PSA during migration:
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: migration-namespace
  labels:
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/audit: restricted
```

4. Validate and Switch:
```bash
# Check for violations
kubectl get events --field-selector reason=FailedCreate

# Remove PSP when ready
kubectl delete psp <psp-name>
```

# [Real-world Examples](#examples)

## Secure Web Application
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: web-application
  labels:
    pod-security.kubernetes.io/enforce: restricted
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: secure-web-app
  namespace: web-application
spec:
  template:
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 2000
      containers:
      - name: web-app
        image: nginx:alpine
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop: ["ALL"]
          readOnlyRootFilesystem: true
```

## Database with Storage Requirements
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: database
  labels:
    pod-security.kubernetes.io/enforce: baseline
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: database
spec:
  template:
    spec:
      securityContext:
        fsGroup: 999
      containers:
      - name: postgres
        image: postgres:14
        securityContext:
          allowPrivilegeEscalation: false
          runAsUser: 999
```

# [Troubleshooting](#troubleshooting)

## Common Issues and Solutions

### 1. Pod Creation Failures
```bash
# Check events for PSA violations
kubectl get events -n <namespace> --field-selector reason=FailedCreate

# Get detailed pod security violations
kubectl describe pod <pod-name> -n <namespace>
```

### 2. SecurityContext Issues
```yaml
# Fix common SecurityContext problems
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
  containers:
  - name: app
    securityContext:
      allowPrivilegeEscalation: false
      capabilities:
        drop: ["ALL"]
```

### 3. Version Mismatches
```yaml
# Align versions across modes
metadata:
  labels:
    pod-security.kubernetes.io/enforce-version: latest
    pod-security.kubernetes.io/audit-version: latest
    pod-security.kubernetes.io/warn-version: latest
```

# [Best Practices](#best-practices)

## 1. Namespace Organization
Group workloads by security requirements:
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: critical-apps
  labels:
    pod-security.kubernetes.io/enforce: restricted
---
apiVersion: v1
kind: Namespace
metadata:
  name: internal-tools
  labels:
    pod-security.kubernetes.io/enforce: baseline
```

## 2. Monitoring and Alerting
Set up alerts for PSA violations:
```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: psa-alerts
spec:
  groups:
  - name: psa.rules
    rules:
    - alert: PodSecurityViolation
      expr: |
        sum(increase(pod_security_violations_total{reason="FailedCreate"}[1h])) > 0
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Pod Security violations detected"
```

## 3. Documentation and Standards
Maintain clear security standards:
```yaml
# Example security baseline template
apiVersion: v1
kind: Namespace
metadata:
  name: new-project
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
  annotations:
    security.company.io/standard: "v1.0"
    security.company.io/review-date: "2025-02-11"
```

## 4. Regular Security Reviews
Implement periodic security assessments:
```bash
# Audit script example
#!/bin/bash
echo "Pod Security Admission Audit Report"
echo "=================================="
kubectl get ns -o json | jq -r '.items[] | select(.metadata.labels | has("pod-security.kubernetes.io/enforce")) | "\(.metadata.name): \(.metadata.labels."pod-security.kubernetes.io/enforce")"'
```

# Conclusion
Pod Security Admission is a crucial component in Kubernetes security. By understanding and properly implementing PSA, you can significantly improve your cluster's security posture. Remember to:

- Start with less restrictive policies and gradually increase security
- Use audit and warn modes before enforcing
- Regularly monitor and review security configurations
- Keep policies consistent across similar workloads
- Document and maintain security standards

These practices will help ensure a secure and maintainable Kubernetes environment.
