---
title: "Kubernetes Pod Security Admission: Migrating from PSP to Pod Security Standards"
date: 2027-08-26T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Security", "Pod Security"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Kubernetes Pod Security Admission covering the three security profiles, namespace labeling strategy, migrating from deprecated PodSecurityPolicy, and integrating with Kyverno for extended enforcement."
more_link: "yes"
url: "/kubernetes-pod-security-admission-guide/"
---

PodSecurityPolicy was removed in Kubernetes 1.25, replaced by Pod Security Admission (PSA) — a built-in admission controller that enforces the Pod Security Standards. Migrating clusters to PSA requires understanding the three security levels, planning namespace labeling strategy to minimize disruption, handling the inevitable privileged workloads in system namespaces, and extending PSA with Kyverno for requirements that fall outside the three-profile model.

<!--more-->

## Pod Security Standards Overview

### The Three Profiles

| Profile | Target Workloads | Restrictions |
|---------|-----------------|-------------|
| `privileged` | System components, infrastructure | No restrictions — all capabilities allowed |
| `baseline` | Standard applications | Blocks known privilege escalation vectors |
| `restricted` | Security-sensitive apps | Hardened; requires non-root, no privilege escalation |

### Baseline Profile Controls

The `baseline` profile blocks:
- Privileged containers (`securityContext.privileged: true`)
- Host namespace sharing (`hostPID`, `hostIPC`, `hostNetwork: true`)
- Dangerous volume types (`hostPath`, `hostPath` with write access)
- Host port binding
- Non-default capabilities (`CAP_NET_RAW` and others)
- AppArmor and seccomp overrides

### Restricted Profile Additional Controls

In addition to baseline, `restricted` requires:
- `runAsNonRoot: true`
- `allowPrivilegeEscalation: false`
- `seccompProfile.type: RuntimeDefault` or `Localhost`
- Only `volumes` from the allowed set (configMap, secret, emptyDir, projected, csi, ephemeral, downwardAPI, persistentVolumeClaim)
- Dropping ALL capabilities (`capabilities.drop: ["ALL"]`)

## PSA Modes

Each namespace can enforce each profile in three independent modes:

| Mode | Behavior |
|------|----------|
| `enforce` | Rejects non-conforming pods |
| `audit` | Allows pods but records violations in audit log |
| `warn` | Allows pods but shows warning in API response |

The modes are independent. A common progressive adoption pattern:

```
Phase 1: warn=baseline, audit=baseline
Phase 2: warn=restricted, audit=restricted, enforce=baseline
Phase 3: enforce=restricted (for applications that pass)
```

## Namespace Labeling

### Label Format

```bash
# Single mode: enforce baseline
kubectl label namespace production \
  pod-security.kubernetes.io/enforce=baseline \
  pod-security.kubernetes.io/enforce-version=v1.30

# Full triple-mode configuration
kubectl label namespace production \
  pod-security.kubernetes.io/enforce=baseline \
  pod-security.kubernetes.io/enforce-version=v1.30 \
  pod-security.kubernetes.io/audit=restricted \
  pod-security.kubernetes.io/audit-version=v1.30 \
  pod-security.kubernetes.io/warn=restricted \
  pod-security.kubernetes.io/warn-version=v1.30
```

The version label pins behavior to a specific Kubernetes version's definition of the profile. Using `latest` ties enforcement to the running version, which may tighten controls on upgrade.

### Namespace Label Strategy by Environment

```bash
# Development namespaces: warn only (no blocking)
for NS in dev-team-a dev-team-b dev-team-c; do
  kubectl label namespace $NS \
    pod-security.kubernetes.io/warn=baseline \
    pod-security.kubernetes.io/warn-version=v1.30 \
    pod-security.kubernetes.io/audit=restricted \
    pod-security.kubernetes.io/audit-version=v1.30
done

# Staging: enforce baseline, warn restricted
for NS in staging-api staging-worker; do
  kubectl label namespace $NS \
    pod-security.kubernetes.io/enforce=baseline \
    pod-security.kubernetes.io/enforce-version=v1.30 \
    pod-security.kubernetes.io/warn=restricted \
    pod-security.kubernetes.io/warn-version=v1.30 \
    pod-security.kubernetes.io/audit=restricted \
    pod-security.kubernetes.io/audit-version=v1.30
done

# Production: enforce restricted
for NS in production-api production-worker; do
  kubectl label namespace $NS \
    pod-security.kubernetes.io/enforce=restricted \
    pod-security.kubernetes.io/enforce-version=v1.30
done

# System namespaces: privileged (no restrictions)
for NS in kube-system kyverno monitoring longhorn-system; do
  kubectl label namespace $NS \
    pod-security.kubernetes.io/enforce=privileged \
    --overwrite
done
```

### Admission Configuration for Cluster-Wide Defaults

Set cluster-wide defaults via the admission configuration file:

```yaml
# /etc/kubernetes/admission-config.yaml
apiVersion: apiserver.config.k8s.io/v1
kind: AdmissionConfiguration
plugins:
  - name: PodSecurity
    configuration:
      apiVersion: pod-security.admission.config.k8s.io/v1
      kind: PodSecurityConfiguration
      defaults:
        enforce: "baseline"
        enforce-version: "latest"
        audit: "restricted"
        audit-version: "latest"
        warn: "restricted"
        warn-version: "latest"
      exemptions:
        # Usernames that bypass PSA (human operators, CI systems)
        usernames: []
        # RuntimeClasses to exempt (e.g., kata-containers)
        runtimeClasses: []
        # Namespaces permanently exempt from all PSA checks
        namespaces:
          - kube-system
          - kube-public
          - kube-node-lease
```

Reference in kube-apiserver:

```yaml
# kube-apiserver.yaml
- --admission-control-config-file=/etc/kubernetes/admission-config.yaml
- --enable-admission-plugins=NodeRestriction,PodSecurity
```

## Migrating from PodSecurityPolicy

### PSP to PSA Migration Methodology

**Step 1: Audit existing PSP bindings**

```bash
# List all PSPs
kubectl get psp

# Find which ServiceAccounts bind to which PSPs
kubectl get clusterrolebindings -o json | jq -r '
  .items[] |
  select(.roleRef.kind == "ClusterRole") |
  {
    binding: .metadata.name,
    subjects: [.subjects[]? | {kind, name, namespace}]
  }
'

# Find which PSPs allow privileged
kubectl get psp -o json | jq -r '
  .items[] |
  select(.spec.privileged == true) |
  .metadata.name
'
```

**Step 2: Map PSP to PSA profile**

| PSP Capability | PSA Equivalent |
|----------------|---------------|
| `privileged: false` | baseline/restricted |
| `hostPID: false, hostIPC: false, hostNetwork: false` | baseline/restricted |
| `runAsNonRoot: true` | restricted |
| `allowPrivilegeEscalation: false` | restricted |
| `requiredDropCapabilities: [ALL]` | restricted |
| `seccompProfiles: runtime/default` | restricted |

**Step 3: Enable PSA in warn+audit mode while PSP is still active**

```bash
# Enable PSA without disabling PSP yet
# This surfaces violations before enforcement begins
kubectl label namespace production \
  pod-security.kubernetes.io/warn=baseline \
  pod-security.kubernetes.io/audit=baseline

# Watch for warnings in kubectl output and audit logs for 1-2 weeks
kubectl get pods -n production  # Shows inline warnings
```

**Step 4: Fix non-compliant workloads**

```yaml
# Example: Fix a deployment to meet restricted profile
spec:
  template:
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 2000
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: app
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            runAsNonRoot: true
            capabilities:
              drop:
                - ALL
```

**Step 5: Disable PSP controller**

Remove `PodSecurityPolicy` from `--enable-admission-plugins` after all workloads are compliant:

```yaml
# kube-apiserver.yaml — remove PodSecurityPolicy from admission plugins
# Before: --enable-admission-plugins=NodeRestriction,PodSecurity,PodSecurityPolicy
# After:  --enable-admission-plugins=NodeRestriction,PodSecurity
```

### Privileged Workload Handling

Some legitimate workloads require privileged access. Manage them explicitly:

```yaml
# privileged-namespace-policy.yaml
# For DaemonSets that need hostNetwork/hostPID (e.g., network agents, monitoring)

# Option 1: Use a dedicated privileged namespace
kubectl create namespace privileged-system
kubectl label namespace privileged-system \
  pod-security.kubernetes.io/enforce=privileged \
  pod-security.kubernetes.io/audit=privileged

# Option 2: Exempt specific RuntimeClasses
# (useful for hypervisor-isolated workloads via kata-containers)
```

## Extending PSA with Kyverno

PSA's three-profile model covers the majority of security requirements but lacks fine-grained control. Kyverno fills the gaps:

### Requiring Specific seccomp Profiles

PSA `restricted` accepts `RuntimeDefault` or `Localhost`. Kyverno enforces a specific profile:

```yaml
# require-specific-seccomp.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-runtime-default-seccomp
spec:
  validationFailureAction: Enforce
  rules:
    - name: check-seccomp
      match:
        any:
          - resources:
              kinds: ["Pod"]
              namespaces: ["production"]
      validate:
        message: "seccompProfile.type must be RuntimeDefault"
        pattern:
          spec:
            securityContext:
              seccompProfile:
                type: RuntimeDefault
```

### Restricting Image Registries

PSA does not control image source. Kyverno fills this gap:

```yaml
# restrict-image-registries.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: restrict-image-registries
spec:
  validationFailureAction: Enforce
  background: true
  rules:
    - name: check-image-registry
      match:
        any:
          - resources:
              kinds: ["Pod"]
              namespaces: ["production", "staging"]
      validate:
        message: "Images must be pulled from registry.example.com or gcr.io/distroless"
        foreach:
          - list: "request.object.spec.containers"
            deny:
              conditions:
                all:
                  - key: "{{ element.image }}"
                    operator: NotMatches
                    value: "^(registry\\.example\\.com/|gcr\\.io/distroless/)"
```

### PSA + Kyverno Combined Enforcement

```yaml
# Combined enforcement per namespace:
# PSA handles: runtime security context validation (fast, built-in)
# Kyverno handles: image source, label requirements, resource limits (flexible)

# Namespace label setup
kubectl label namespace production \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/enforce-version=v1.30

# Kyverno ClusterPolicies augment PSA:
# - require-resource-limits: CPU/memory limits
# - restrict-image-registries: approved registries only
# - require-labels: mandatory organizational labels
# - verify-image-signatures: Cosign signature verification
```

## Checking Compliance

### PSA Dry-Run Against Namespace

```bash
# Check if a manifest would pass PSA before applying
kubectl apply --dry-run=server -f deployment.yaml -n production

# If PSA would block it, the error appears in the dry-run output:
# Error from server (Forbidden): error when creating "deployment.yaml":
# pods "my-app" is forbidden: violates PodSecurity "restricted:v1.30":
# allowPrivilegeEscalation != false (container "app" must set securityContext.allowPrivilegeEscalation=false)

# Simulate PSA profile against existing workloads
kubectl label --dry-run=server --overwrite namespace production \
  pod-security.kubernetes.io/enforce=restricted

# This output shows which existing pods would fail enforcement
```

### Audit Log Analysis for PSA Violations

```bash
# Find PSA audit events in the audit log
grep "pod-security" /var/log/kubernetes/audit.log | \
  jq 'select(.annotations["pod-security.kubernetes.io/audit-violations"] != null) | {
    namespace: .objectRef.namespace,
    resource: .objectRef.name,
    violation: .annotations["pod-security.kubernetes.io/audit-violations"]
  }'
```

### Policy Gap Analysis Script

```bash
#!/usr/bin/env bash
# psa-compliance-check.sh
# Check all namespaces for PSA labeling and compliance

echo "=== Namespace PSA Labels ==="
kubectl get namespaces -o json | jq -r '
  .items[] | {
    name: .metadata.name,
    enforce: (.metadata.labels["pod-security.kubernetes.io/enforce"] // "NOT SET"),
    warn: (.metadata.labels["pod-security.kubernetes.io/warn"] // "NOT SET"),
    audit: (.metadata.labels["pod-security.kubernetes.io/audit"] // "NOT SET")
  }
' | jq -r '[.name, .enforce, .warn, .audit] | @tsv' | \
  column -t -s $'\t' -N "NAMESPACE,ENFORCE,WARN,AUDIT"

echo ""
echo "=== Namespaces Without PSA Enforcement ==="
kubectl get namespaces -o json | jq -r '
  .items[] |
  select(
    (.metadata.labels["pod-security.kubernetes.io/enforce"] == null) and
    (.metadata.name | test("kube-|default") | not)
  ) | .metadata.name
'
```

The migration from PSP to PSA is straightforward when approached as a gradual process: warn mode surfaces violations without disrupting operations, allowing teams to fix workloads at their own pace before enforcement is enabled. The combination of PSA for runtime security context enforcement and Kyverno for organizational policy (image registries, labels, resource limits) provides comprehensive protection without duplicating enforcement logic between the two systems.
