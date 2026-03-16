---
title: "Kubernetes Pod Security Admission: Enforcing Security Standards at Scale"
date: 2027-04-12T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Pod Security", "PSA", "Security", "Compliance"]
categories: ["Kubernetes", "Security", "Compliance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to Kubernetes Pod Security Admission (PSA), covering restricted/baseline/privileged profiles, namespace-level enforcement modes (enforce/warn/audit), migration from PodSecurityPolicy, exemptions configuration, and integration with Kyverno for enhanced policy coverage."
more_link: "yes"
url: "/kubernetes-pod-security-admission-advanced-guide/"
---

Kubernetes 1.25 removed PodSecurityPolicy (PSP) after a multi-version deprecation cycle, replacing it with the Pod Security Admission (PSA) controller that ships as a built-in admission plugin in every Kubernetes cluster from 1.23 onward. PSA provides three standardized security profiles and three enforcement modes, making it far simpler to reason about than the sprawling PSP system — but the simplified surface area also means that more complex requirements still need supplemental tooling like Kyverno or OPA Gatekeeper. This guide covers the complete lifecycle: understanding profiles, configuring namespace labels, managing controller-level exemptions, migrating from PSP, and extending coverage with Kyverno.

<!--more-->

## PSA versus PodSecurityPolicy

### Why PSP Was Removed

PodSecurityPolicy had several fundamental problems. First, it used RBAC `use` verbs to grant access, which meant the policy that applied to a pod was determined by which service account the pod ran under, and this was frequently misconfigured. Cluster operators discovered that granting `use` on a permissive PSP to a system namespace service account inadvertently allowed workloads in that namespace to bypass stricter cluster-wide policies. Second, there was no warning mode — violations were silently allowed or hard-rejected with no middle ground. Third, PSP required cluster administrators to reason about policy mutation (PSPs could mutate pods) separately from validation, making audit trails ambiguous.

PSA fixes all three issues. Policies are bound at the namespace level via labels, not via RBAC. A warning mode gives operators a safe path for incremental tightening. PSA is purely validating — it never mutates pods.

### PSA Architecture

PSA ships as the `PodSecurity` admission plugin, enabled by default from Kubernetes 1.23. The plugin intercepts Pod and workload controller (Deployment, StatefulSet, DaemonSet, ReplicaSet, ReplicationController, Job, CronJob) creation and update requests. For workload controllers, PSA evaluates the pod template spec so violations surface at the Deployment level rather than at pod scheduling time, which is a major improvement over the PSP experience.

The plugin evaluates each pod against one of three profiles at one of three enforcement modes.

## The Three Security Profiles

### Profile Overview

| Profile | Intent | Example workloads |
|---|---|---|
| privileged | No restrictions | Node agents, CNI plugins, storage drivers |
| baseline | Prevents known privilege escalations | Web applications, API servers without special host access |
| restricted | Hardened, follows pod hardening best practices | All workloads where security posture is a priority |

### Privileged Profile

The privileged profile applies no restrictions at all. A pod running under this profile can set `hostPID: true`, mount host paths, use any capability, and disable seccomp. This profile is appropriate only for infrastructure workloads that genuinely need host-level access, such as Cilium, Calico node agents, or NVIDIA device plugins.

### Baseline Profile

The baseline profile prevents known privilege escalations while remaining broadly compatible with containerized applications. The restrictions are:

| Field | Forbidden values |
|---|---|
| `spec.hostProcess` | true |
| `spec.hostPID` | true |
| `spec.hostIPC` | true |
| `spec.hostNetwork` | true |
| `spec.hostPorts[*].hostPort` | Any value > 0 |
| `spec.volumes[*]` type | hostPath |
| `spec.containers[*].securityContext.privileged` | true |
| `spec.containers[*].securityContext.capabilities.add` | Anything beyond the default set |
| `spec.containers[*].securityContext.allowPrivilegeEscalation` | true (only restricted) |
| AppArmor annotations | Anything other than `runtime/default` or `localhost/*` |
| Seccomp | Any profile other than `RuntimeDefault`, `Localhost`, or unset |
| Sysctls | Any unsafe sysctl |

### Restricted Profile

The restricted profile includes everything from baseline and adds:

| Requirement | Details |
|---|---|
| Volume types | Only configMap, csi, downwardAPI, emptyDir, ephemeral, persistentVolumeClaim, projected, secret |
| Privilege escalation | `allowPrivilegeEscalation: false` required |
| Run as non-root | `runAsNonRoot: true` required |
| Run as user | Must not be 0 (root) |
| Seccomp | Must be `RuntimeDefault` or `Localhost` |
| Capabilities | Must drop ALL; may only add `NET_BIND_SERVICE` |

## Enforcement Modes

### Mode Semantics

Each namespace can have up to three independent mode/profile/version labels:

```text
pod-security.kubernetes.io/enforce: restricted
pod-security.kubernetes.io/enforce-version: v1.28
pod-security.kubernetes.io/warn: restricted
pod-security.kubernetes.io/warn-version: v1.28
pod-security.kubernetes.io/audit: restricted
pod-security.kubernetes.io/audit-version: v1.28
```

**enforce** — Violating pods are rejected. This is the hard gate.

**warn** — Violating pods are admitted but the API server returns a warning header that `kubectl` displays to the user. No rejection occurs.

**audit** — Violating pods are admitted and an audit annotation is added to the audit log entry. No user-visible warning is produced.

The version pin (`v1.28`, `latest`) controls which version of the profile standard is used for evaluation. Pinning to a specific version prevents unintentional tightening when you upgrade the cluster.

### Namespace Label Examples

```yaml
# namespace-baseline.yaml — baseline enforcement with restricted warning
apiVersion: v1
kind: Namespace
metadata:
  name: web-frontend
  labels:
    # Hard-reject any pod that violates baseline
    pod-security.kubernetes.io/enforce: baseline
    pod-security.kubernetes.io/enforce-version: v1.28
    # Warn on any pod that would violate restricted (progressive migration)
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: v1.28
    # Audit at restricted for compliance logging
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: v1.28
```

```yaml
# namespace-restricted.yaml — fully hardened namespace
apiVersion: v1
kind: Namespace
metadata:
  name: payments-api
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: v1.28
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: v1.28
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: v1.28
```

### Applying Labels at Scale with kubectl

```bash
# Label a single namespace
kubectl label namespace web-frontend \
  pod-security.kubernetes.io/enforce=baseline \
  pod-security.kubernetes.io/enforce-version=v1.28

# Dry-run to preview what would be rejected
kubectl label namespace web-frontend \
  pod-security.kubernetes.io/enforce=restricted \
  --dry-run=server

# Label all namespaces matching a selector
kubectl get namespace -l environment=production -o name | \
  xargs -I{} kubectl label {} \
    pod-security.kubernetes.io/enforce=restricted \
    pod-security.kubernetes.io/enforce-version=v1.28
```

## Controller-Level Exemptions

### AdmissionConfiguration

The `PodSecurity` plugin is configured via an `AdmissionConfiguration` file that is passed to the kube-apiserver via `--admission-control-config-file`. This file controls cluster-wide exemptions that bypass PSA entirely.

```yaml
# /etc/kubernetes/admission-configuration.yaml
apiVersion: apiserver.config.k8s.io/v1
kind: AdmissionConfiguration
plugins:
  - name: PodSecurity
    configuration:
      apiVersion: pod-security.admission.config.k8s.io/v1
      kind: PodSecurityConfiguration
      defaults:
        # Cluster-wide defaults applied to all namespaces
        # unless overridden by namespace labels
        enforce: baseline
        enforce-version: latest
        audit: restricted
        audit-version: latest
        warn: restricted
        warn-version: latest
      exemptions:
        # Kubernetes usernames to exempt (e.g., node bootstrap)
        usernames:
          - system:node:control-plane-01
          - system:node:control-plane-02
          - system:node:control-plane-03
        # RuntimeClass names to exempt
        runtimeClasses: []
        # Namespaces fully exempt from PSA evaluation
        namespaces:
          - kube-system
          - kube-public
          - kube-node-lease
          - cert-manager
          - monitoring
          - logging
```

### kube-apiserver Flag

```bash
# kube-apiserver static pod command (snippet)
# /etc/kubernetes/manifests/kube-apiserver.yaml
# - --admission-control-config-file=/etc/kubernetes/admission-configuration.yaml
# The file must be mounted into the apiserver pod via hostPath volume
```

```yaml
# Relevant snippet from kube-apiserver static pod manifest
spec:
  containers:
  - command:
    - kube-apiserver
    - --admission-control-config-file=/etc/kubernetes/psa-config.yaml
    # ... other flags
    volumeMounts:
    - mountPath: /etc/kubernetes/psa-config.yaml
      name: psa-config
      readOnly: true
  volumes:
  - hostPath:
      path: /etc/kubernetes/psa-config.yaml
      type: File
    name: psa-config
```

### Namespace-Level Exemption Pattern

For namespaces that need privileged access (infrastructure operators, CNI plugins), the cleanest approach is to exempt the namespace in the AdmissionConfiguration and document the reason:

```bash
# Document why kube-system is exempted
kubectl annotate namespace kube-system \
  security.support.tools/psa-exemption-reason="CNI, DNS, and node agents require host access" \
  security.support.tools/psa-exemption-approved-by="security-team" \
  security.support.tools/psa-exemption-review-date="2024-01-15"
```

## Migrating from PodSecurityPolicy to PSA

### Migration Strategy

The safest migration path follows three phases: audit, warn, enforce. Each phase can be run for a sprint (1–2 weeks) to allow application teams to remediate violations before enforcement begins.

```bash
#!/bin/bash
# migrate-psa.sh — phased PSA migration for a namespace
# Usage: ./migrate-psa.sh <namespace> <profile>
set -euo pipefail

NAMESPACE="${1:?Namespace required}"
PROFILE="${2:-restricted}"
VERSION="v1.28"

phase_audit() {
  echo "Phase 1: Audit mode — no rejections, log-only"
  kubectl label namespace "${NAMESPACE}" \
    pod-security.kubernetes.io/audit="${PROFILE}" \
    pod-security.kubernetes.io/audit-version="${VERSION}" \
    --overwrite
  echo "Run for 1-2 weeks. Check audit logs for violations."
  echo "Query: kubectl get events -n ${NAMESPACE} | grep PodSecurity"
}

phase_warn() {
  echo "Phase 2: Warn mode — violations visible in kubectl output"
  kubectl label namespace "${NAMESPACE}" \
    pod-security.kubernetes.io/warn="${PROFILE}" \
    pod-security.kubernetes.io/warn-version="${VERSION}" \
    --overwrite
  echo "Application teams will see warnings on every apply."
}

phase_enforce() {
  echo "Phase 3: Enforce mode — violations are rejected"
  kubectl label namespace "${NAMESPACE}" \
    pod-security.kubernetes.io/enforce="${PROFILE}" \
    pod-security.kubernetes.io/enforce-version="${VERSION}" \
    --overwrite
  echo "Enforcement active. Monitor for rejected pods."
}

case "${3:-audit}" in
  audit)   phase_audit ;;
  warn)    phase_warn ;;
  enforce) phase_enforce ;;
  *)       echo "Unknown phase: ${3}"; exit 1 ;;
esac
```

### Checking Existing Workloads Before Migration

```bash
#!/bin/bash
# check-psa-violations.sh — dry-run PSA label to see what would fail
# Requires kubectl 1.25+

NAMESPACE="${1:?Namespace required}"
PROFILE="${2:-restricted}"

echo "Checking namespace '${NAMESPACE}' against '${PROFILE}' profile..."

# Add label in dry-run=server mode; warnings appear in output
kubectl label namespace "${NAMESPACE}" \
  pod-security.kubernetes.io/enforce="${PROFILE}" \
  --dry-run=server \
  2>&1 | grep -i warning || echo "No violations detected"
```

### PSP Feature Mapping

| PSP feature | PSA equivalent | Notes |
|---|---|---|
| `privileged: false` | baseline profile | enforced automatically |
| `hostPID: false` | baseline profile | enforced automatically |
| `allowedCapabilities` | restricted profile drops ALL | use Kyverno for fine-grained capability allow-lists |
| `volumes` allowlist | restricted profile volume allowlist | Kyverno needed for custom volume type rules |
| `runAsUser` ranges | `restricted` requires non-root | exact UID ranges need Kyverno |
| `seLinux` options | Not in PSA | Use Kyverno or OPA |
| `mutateDefaults` (PSP mutation) | Not in PSA | Use a MutatingWebhook or Kyverno mutate rules |
| `readOnlyRootFilesystem` | Not in PSA | Use Kyverno |

## Common Restricted Profile Violations and Fixes

### Missing securityContext Fields

The most common source of restricted profile violations in pre-existing workloads is absent or incorrect `securityContext` settings.

```yaml
# BEFORE — violates restricted profile on multiple counts
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: payments-api
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api-server
  template:
    metadata:
      labels:
        app: api-server
    spec:
      containers:
      - name: api-server
        image: registry.support.tools/payments/api-server:2.4.1
        ports:
        - containerPort: 8080
        # No securityContext at all — multiple violations
```

```yaml
# AFTER — compliant with restricted profile
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: payments-api
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api-server
  template:
    metadata:
      labels:
        app: api-server
    spec:
      # Pod-level security context
      securityContext:
        runAsNonRoot: true       # restricted: required
        runAsUser: 1001          # restricted: must not be 0
        runAsGroup: 1001
        fsGroup: 1001
        seccompProfile:
          type: RuntimeDefault   # restricted: required
      containers:
      - name: api-server
        image: registry.support.tools/payments/api-server:2.4.1
        ports:
        - containerPort: 8080
        # Container-level security context
        securityContext:
          allowPrivilegeEscalation: false  # restricted: required
          readOnlyRootFilesystem: true     # best practice (not PSA, but good)
          capabilities:
            drop:
            - ALL                          # restricted: required
            # add: [NET_BIND_SERVICE]     # only if binding port < 1024
```

### Init Container Security Context

Init containers must also satisfy the restricted profile. A common mistake is forgetting to set the security context on init containers when they are added later.

```yaml
# init container with restricted-compliant security context
initContainers:
- name: db-migrate
  image: registry.support.tools/payments/api-server:2.4.1
  command: ["/app/migrate", "--up"]
  securityContext:
    runAsNonRoot: true
    runAsUser: 1001
    allowPrivilegeEscalation: false
    capabilities:
      drop:
      - ALL
    seccompProfile:
      type: RuntimeDefault
```

### Seccomp Profile Options

```yaml
# Option 1: RuntimeDefault — uses container runtime's default seccomp profile
securityContext:
  seccompProfile:
    type: RuntimeDefault

# Option 2: Localhost — use a custom profile stored on the node
securityContext:
  seccompProfile:
    type: Localhost
    localhostProfile: profiles/api-server-seccomp.json
    # Profile must exist at /var/lib/kubelet/seccomp/profiles/api-server-seccomp.json

# Option 3: Unconfined — ONLY valid under privileged profile
# securityContext:
#   seccompProfile:
#     type: Unconfined
```

### Capability Violations

```yaml
# Wrong — adds NET_ADMIN which violates baseline and restricted
securityContext:
  capabilities:
    add:
    - NET_ADMIN
    - SYS_PTRACE

# Correct — drop all, add only what is genuinely needed
# NET_BIND_SERVICE is the only capability allowed under restricted
securityContext:
  capabilities:
    drop:
    - ALL
    add:
    - NET_BIND_SERVICE  # only if the container binds a port < 1024
```

## Cluster-Wide Defaults

### Setting Sensible Defaults

The `AdmissionConfiguration` `defaults` block sets the baseline behavior for all namespaces that have no PSA labels. A recommended production default is to enforce `baseline` cluster-wide and audit/warn at `restricted`:

```yaml
# /etc/kubernetes/psa-config.yaml — production recommended defaults
apiVersion: apiserver.config.k8s.io/v1
kind: AdmissionConfiguration
plugins:
  - name: PodSecurity
    configuration:
      apiVersion: pod-security.admission.config.k8s.io/v1
      kind: PodSecurityConfiguration
      defaults:
        enforce: baseline        # Hard block on privilege escalation cluster-wide
        enforce-version: v1.28
        audit: restricted        # Log restricted violations for all namespaces
        audit-version: v1.28
        warn: restricted         # Warn on restricted violations during kubectl apply
        warn-version: v1.28
      exemptions:
        namespaces:
          - kube-system
          - kube-public
          - kube-node-lease
```

### Verifying Active Admission Plugins

```bash
# Check which admission plugins are active on the API server
kubectl exec -n kube-system kube-apiserver-control-plane-01 -- \
  kube-apiserver --help 2>&1 | grep -A5 "admission-plugins"

# Look for PodSecurity in the enabled plugins
kubectl get pod kube-apiserver-control-plane-01 -n kube-system -o yaml | \
  grep -A2 admission
```

## Integration with Kyverno

### Why Kyverno Is Needed

PSA is intentionally minimal. It covers the 20% of security controls that cause 80% of privilege escalation incidents. The remaining controls — image registry restrictions, required labels, resource limit requirements, network policy enforcement, and fine-grained capability lists — require a policy engine. Kyverno is a natural complement because it uses Kubernetes-native CRDs and integrates well with GitOps workflows.

### Installing Kyverno

```bash
# Install Kyverno using the official Helm chart
helm repo add kyverno https://kyverno.github.io/kyverno/
helm repo update

helm install kyverno kyverno/kyverno \
  --namespace kyverno \
  --create-namespace \
  --version 3.2.6 \
  --set admissionController.replicas=3 \
  --set backgroundController.replicas=2 \
  --set reportsController.replicas=2 \
  --set cleanupController.replicas=1
```

### Requiring Images from Approved Registries

```yaml
# kyverno-registry-policy.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: restrict-image-registries
  annotations:
    policies.kyverno.io/title: Restrict Image Registries
    policies.kyverno.io/description: >-
      All container images must come from approved registries.
      This prevents supply chain attacks via untrusted public images.
spec:
  validationFailureAction: Enforce
  background: true
  rules:
  - name: validate-registries
    match:
      any:
      - resources:
          kinds:
          - Pod
    validate:
      message: "Images must be from registry.support.tools or gcr.io/distroless"
      pattern:
        spec:
          containers:
          - image: "registry.support.tools/* | gcr.io/distroless/*"
          =(initContainers):
          - image: "registry.support.tools/* | gcr.io/distroless/*"
          =(ephemeralContainers):
          - image: "registry.support.tools/* | gcr.io/distroless/*"
```

### Requiring Resource Limits

```yaml
# kyverno-resource-limits-policy.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-resource-limits
  annotations:
    policies.kyverno.io/title: Require Resource Limits
    policies.kyverno.io/description: >-
      All containers must define CPU and memory limits to prevent
      resource starvation on the node.
spec:
  validationFailureAction: Enforce
  background: true
  rules:
  - name: validate-limits
    match:
      any:
      - resources:
          kinds:
          - Pod
    exclude:
      any:
      - resources:
          namespaces:
          - kube-system
    validate:
      message: "CPU and memory limits are required for all containers"
      pattern:
        spec:
          containers:
          - resources:
              limits:
                memory: "?*"
                cpu: "?*"
```

### Enforcing readOnlyRootFilesystem

PSA does not require `readOnlyRootFilesystem`, but it is a meaningful defense-in-depth control. Kyverno can enforce it:

```yaml
# kyverno-readonly-root-policy.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-readonly-rootfs
  annotations:
    policies.kyverno.io/title: Require Read-Only Root Filesystem
spec:
  validationFailureAction: Audit  # Start in Audit, move to Enforce after remediation
  background: true
  rules:
  - name: validate-readonly-rootfs
    match:
      any:
      - resources:
          kinds:
          - Pod
    exclude:
      any:
      - resources:
          namespaces:
          - kube-system
          - monitoring
    validate:
      message: "readOnlyRootFilesystem must be true. Use an emptyDir for writable scratch space."
      pattern:
        spec:
          containers:
          - securityContext:
              readOnlyRootFilesystem: true
```

### Mutating Policy: Auto-Apply Seccomp Profile

For gradual migration, a Kyverno mutating policy can automatically inject the RuntimeDefault seccomp profile into pods that do not already specify one:

```yaml
# kyverno-mutate-seccomp.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: add-default-seccomp-profile
  annotations:
    policies.kyverno.io/title: Add Default Seccomp Profile
    policies.kyverno.io/description: >-
      Automatically applies RuntimeDefault seccomp profile to all pods
      that do not explicitly configure a seccomp profile. This helps
      workloads pass the PSA restricted check without code changes.
spec:
  rules:
  - name: add-seccomp-profile
    match:
      any:
      - resources:
          kinds:
          - Pod
    exclude:
      any:
      - resources:
          namespaces:
          - kube-system
    mutate:
      patchStrategicMerge:
        spec:
          securityContext:
            +(seccompProfile):       # Only add if not already set
              type: RuntimeDefault
```

## Policy Testing and Validation

### Testing PSA Labels

```bash
# Test a pod spec against the current namespace PSA labels
cat <<'EOF' | kubectl apply --dry-run=server -f -
apiVersion: v1
kind: Pod
metadata:
  name: psa-test-pod
  namespace: payments-api
spec:
  containers:
  - name: test
    image: registry.support.tools/tools/debug:1.0.0
    securityContext:
      runAsNonRoot: true
      runAsUser: 1001
      allowPrivilegeEscalation: false
      capabilities:
        drop: [ALL]
      seccompProfile:
        type: RuntimeDefault
EOF
```

### Kyverno Policy Testing with kyverno-cli

```bash
# Install kyverno CLI
curl -LO https://github.com/kyverno/kyverno/releases/download/v1.12.3/kyverno_linux_amd64.tar.gz
tar xf kyverno_linux_amd64.tar.gz
install kyverno /usr/local/bin/kyverno

# Test a policy against a resource manifest
kyverno apply kyverno-registry-policy.yaml \
  --resource pod-manifest.yaml \
  --detailed-results
```

```yaml
# kyverno-policy-test.yaml — unit test for the registry policy
apiVersion: cli.kyverno.io/v1alpha1
kind: Test
metadata:
  name: test-registry-policy
policies:
  - kyverno-registry-policy.yaml
resources:
  - name: compliant-pod
    resource:
      apiVersion: v1
      kind: Pod
      metadata:
        name: compliant-pod
        namespace: default
      spec:
        containers:
        - name: app
          image: registry.support.tools/payments/api-server:2.4.1
  - name: non-compliant-pod
    resource:
      apiVersion: v1
      kind: Pod
      metadata:
        name: bad-pod
        namespace: default
      spec:
        containers:
        - name: app
          image: docker.io/library/nginx:latest  # Untrusted registry
results:
  - policy: restrict-image-registries
    rule: validate-registries
    resource: compliant-pod
    result: pass
  - policy: restrict-image-registries
    rule: validate-registries
    resource: non-compliant-pod
    result: fail
```

## Operational Considerations

### Monitoring PSA Violations

```bash
# Watch for PSA-related events across all namespaces
kubectl get events --all-namespaces \
  --field-selector reason=FailedCreate \
  | grep -i "violates PodSecurity"

# Check audit logs for PSA audit annotations (requires audit logging configured)
# Look for annotations with key: pod-security.kubernetes.io/audit-violations
```

### Helm Chart Security Context Template

For teams managing Helm charts, a common helper template enforces compliant security contexts:

```yaml
# templates/_helpers.tpl — Helm helper for restricted-compliant security context
{{/*
Restricted-compliant pod security context.
Override with .Values.podSecurityContext if needed.
*/}}
{{- define "app.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: {{ .Values.podSecurityContext.runAsUser | default 1001 }}
runAsGroup: {{ .Values.podSecurityContext.runAsGroup | default 1001 }}
fsGroup: {{ .Values.podSecurityContext.fsGroup | default 1001 }}
seccompProfile:
  type: RuntimeDefault
{{- end }}

{{/*
Restricted-compliant container security context.
*/}}
{{- define "app.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
runAsNonRoot: true
capabilities:
  drop:
  - ALL
{{- end }}
```

### Common Troubleshooting Commands

```bash
# Describe a failing pod to see PSA rejection reason
kubectl describe pod failing-pod -n payments-api

# Check what profile is active on a namespace
kubectl get namespace payments-api -o \
  jsonpath='{.metadata.labels}' | python3 -m json.tool | grep pod-security

# List all namespaces and their PSA labels
kubectl get namespaces -o custom-columns=\
'NAME:.metadata.name,ENFORCE:.metadata.labels.pod-security\.kubernetes\.io/enforce,\
WARN:.metadata.labels.pod-security\.kubernetes\.io/warn,\
AUDIT:.metadata.labels.pod-security\.kubernetes\.io/audit'

# Simulate applying restricted label across all non-system namespaces
kubectl get namespace \
  --selector='!kubernetes.io/metadata.name=kube-system' \
  -o name | \
  xargs -I{} kubectl label {} \
    pod-security.kubernetes.io/enforce=restricted \
    --dry-run=server 2>&1 | grep -i warning
```

## Summary

Pod Security Admission provides a built-in, zero-dependency mechanism for enforcing security profiles in Kubernetes. The recommended enterprise posture is:

1. Set cluster-wide defaults to `enforce: baseline` and `audit/warn: restricted` via `AdmissionConfiguration`.
2. Exempt only named infrastructure namespaces (kube-system, CNI namespace, monitoring namespace) with documented justification.
3. Progressively tighten application namespaces from baseline toward restricted using the audit → warn → enforce migration path.
4. Use Kyverno for controls PSA does not cover: image registry restrictions, resource limits, `readOnlyRootFilesystem`, label requirements, and mutating defaults for gradual adoption.
5. Test policies in CI using `kyverno apply` before pushing namespace label changes or policy updates.

The combination of PSA and Kyverno provides defense-in-depth that covers both the standardized security profiles (PSA) and organization-specific policy extensions (Kyverno), without the operational complexity that led to PSP's deprecation.
