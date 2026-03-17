---
title: "Kubernetes Pod Security Admission: Replacing PodSecurityPolicy"
date: 2029-05-07T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Security", "PSA", "Pod Security", "OPA Gatekeeper", "Kyverno", "PodSecurityPolicy"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes Pod Security Admission (PSA): privileged, baseline, and restricted levels, namespace labeling, dry-run mode, migration from PSP, OPA Gatekeeper as an alternative, and Kyverno policies."
more_link: "yes"
url: "/kubernetes-pod-security-admission-replacing-podsecuritypolicy/"
---

PodSecurityPolicy (PSP) was deprecated in Kubernetes 1.21 and removed in 1.25. Its replacement, Pod Security Admission (PSA), ships as a built-in admission controller with a simpler three-level model. For teams that relied on PSP's fine-grained controls, the transition requires understanding both what PSA provides and where it falls short — and knowing when to reach for OPA Gatekeeper or Kyverno to fill the gaps. This guide covers the complete migration path with production-ready configurations.

<!--more-->

# Kubernetes Pod Security Admission: Replacing PodSecurityPolicy

## Why PSP Was Removed

PodSecurityPolicy had fundamental design problems:

1. **Confusing authorization model**: PSP required a separate RBAC `use` verb, leading to administrators accidentally granting overly permissive policies.
2. **No dry-run mode**: You couldn't test a PSP before enforcing it.
3. **No per-namespace defaults**: All policies applied cluster-wide by default.
4. **Complex policy merging**: Multiple matching PSPs were merged in opaque ways.
5. **Maintenance burden**: The API was difficult to extend and had accumulated technical debt.

PSA addresses all of these with a simpler, namespace-scoped model.

## Pod Security Admission Levels

PSA defines three built-in policy levels based on the [Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/):

### Privileged

No restrictions. Equivalent to having no policy. Used for system namespaces (kube-system, monitoring, etc.).

### Baseline

Prevents the most obvious privilege escalations while allowing most typical workloads:

| Control | Allowed | Forbidden |
|---|---|---|
| Host namespaces | None | hostNetwork, hostPID, hostIPC |
| Privileged containers | No | `privileged: true` |
| Capabilities | NET_BIND_SERVICE only | Adding dangerous caps |
| HostPath volumes | No | Any hostPath |
| Host ports | No | Any hostPort |
| AppArmor | Default | Custom profiles that override restrictions |
| SELinux | Default | Custom SELinux options |
| /proc mount | Default | `procMount: Unmasked` |
| Seccomp | Default | Unconfined |
| Sysctls | Safe sysctls only | Unsafe sysctls |

### Restricted

Enforces current hardening best practices. Requires explicit configuration:

All Baseline restrictions plus:
- `allowPrivilegeEscalation: false` required
- `runAsNonRoot: true` required
- `seccompProfile.type` must be RuntimeDefault or Localhost
- Capabilities: must drop ALL; only NET_BIND_SERVICE may be added
- Volume types: limited to specific safe types (configMap, emptyDir, secret, downwardAPI, projected, PVC)
- Run as non-root user

## PSA Modes

Each level can operate in three modes per namespace:

- **enforce**: Policy violations reject the pod.
- **audit**: Policy violations are logged to the audit log but do not reject the pod.
- **warn**: Policy violations generate a warning in the API response but do not reject the pod.

You can mix modes for a gradual rollout:

```yaml
# Warn on restricted violations, audit on baseline violations
labels:
  pod-security.kubernetes.io/warn: restricted
  pod-security.kubernetes.io/warn-version: v1.28
  pod-security.kubernetes.io/audit: baseline
  pod-security.kubernetes.io/audit-version: v1.28
  pod-security.kubernetes.io/enforce: baseline
  pod-security.kubernetes.io/enforce-version: v1.28
```

## Namespace Labeling

PSA is configured entirely through namespace labels. No cluster-wide policy objects or RBAC is required.

### Enforce Baseline for an Application Namespace

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: my-app
  labels:
    pod-security.kubernetes.io/enforce: baseline
    pod-security.kubernetes.io/enforce-version: v1.28
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: v1.28
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: v1.28
```

The `-version` label pins the policy to a specific Kubernetes version's definition, preventing unexpected tightening when you upgrade Kubernetes.

### Enforce Restricted for High-Security Namespaces

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: payments
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: v1.28
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: v1.28
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: v1.28
```

### System Namespaces (Privileged)

```yaml
# kube-system, monitoring, ingress-nginx etc. need privileged level
apiVersion: v1
kind: Namespace
metadata:
  name: kube-system
  labels:
    pod-security.kubernetes.io/enforce: privileged
    pod-security.kubernetes.io/audit: privileged
    pod-security.kubernetes.io/warn: privileged
```

### Apply Labels to Existing Namespaces

```bash
# Apply baseline enforcement to a namespace
kubectl label namespace my-app \
  pod-security.kubernetes.io/enforce=baseline \
  pod-security.kubernetes.io/enforce-version=v1.28

# Apply in warn-only mode first (safe rollout)
kubectl label namespace my-app \
  pod-security.kubernetes.io/warn=restricted \
  pod-security.kubernetes.io/warn-version=v1.28

# Bulk label all application namespaces
kubectl get namespaces -l tier=application -o name | \
  xargs -I{} kubectl label {} \
    pod-security.kubernetes.io/enforce=baseline \
    pod-security.kubernetes.io/enforce-version=v1.28
```

## Dry-Run Mode: Testing Before Enforcing

Unlike PSP, PSA supports `--dry-run` to simulate policy impact without affecting running workloads:

```bash
# Simulate what would happen if you enforced 'restricted' on a namespace
kubectl label namespace my-app \
  pod-security.kubernetes.io/enforce=restricted \
  --dry-run=server

# Better: use kubectl's --dry-run with the namespace label
kubectl label namespace my-app \
  "pod-security.kubernetes.io/enforce=restricted" \
  --dry-run=server -o yaml 2>&1 | grep -A5 "Warning:"

# Check existing pods that would violate the new policy
kubectl -n my-app get pods -o json | \
  kubectl-psa verify -f - --policy=restricted 2>&1
```

### PSA Evaluation Tool

The `kubectl-psa` plugin (or `kubectl psa`) helps evaluate policy impact:

```bash
# Install plugin
kubectl krew install psa

# Check namespace against a policy level
kubectl psa check --namespace my-app --policy restricted

# Output:
# PASS: pod/my-app-5d4f9b8c-xkrqt
# FAIL: pod/legacy-app-7d8c4f6b-mnpqs
#   [restricted] allowPrivilegeEscalation != false
#   [restricted] runAsNonRoot not set
#   [restricted] seccompProfile not set
```

## Cluster-Wide Admission Configuration

Set cluster-wide defaults in the API server configuration:

```yaml
# /etc/kubernetes/admission-configuration.yaml
apiVersion: admissionregistration.k8s.io/v1
kind: AdmissionConfiguration
plugins:
- name: PodSecurity
  configuration:
    apiVersion: pod-security.admission.config.k8s.io/v1
    kind: PodSecurityConfiguration
    defaults:
      enforce: "baseline"          # Default enforce level for unlabeled namespaces
      enforce-version: "latest"
      audit: "restricted"          # Audit at restricted level everywhere
      audit-version: "latest"
      warn: "restricted"           # Warn on restricted violations everywhere
      warn-version: "latest"
    exemptions:
      # Exempt specific service accounts from PSA
      usernames: []
      runtimeClasses: []
      # These namespaces bypass PSA entirely
      namespaces:
        - kube-system
        - kube-node-lease
        - kube-public
```

```yaml
# kube-apiserver flag
--admission-control-config-file=/etc/kubernetes/admission-configuration.yaml
```

## Writing Compliant Pod Specs

### Baseline-Compliant Pod

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: baseline-compliant
spec:
  # No hostNetwork, hostPID, hostIPC
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    fsGroup: 2000
  containers:
  - name: app
    image: my-app:latest
    securityContext:
      allowPrivilegeEscalation: false
      # No privileged: true
      capabilities:
        drop: ["NET_ADMIN", "SYS_PTRACE"]  # Don't add dangerous capabilities
    # No hostPath volumes, no hostPort
    ports:
    - containerPort: 8080   # containerPort OK, no hostPort
```

### Restricted-Compliant Pod

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: restricted-compliant
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 65534           # nobody
    runAsGroup: 65534
    fsGroup: 65534
    seccompProfile:
      type: RuntimeDefault     # Required for restricted
  containers:
  - name: app
    image: my-app:latest
    securityContext:
      allowPrivilegeEscalation: false   # Required for restricted
      readOnlyRootFilesystem: true
      runAsNonRoot: true
      capabilities:
        drop: ["ALL"]           # Required for restricted
        add: ["NET_BIND_SERVICE"]  # Only allowed addition
      seccompProfile:
        type: RuntimeDefault
    volumeMounts:
    - name: tmp
      mountPath: /tmp
    - name: cache
      mountPath: /app/cache
  volumes:
  - name: tmp
    emptyDir: {}               # emptyDir, configMap, secret OK
  - name: cache
    emptyDir: {}
  # Only allowed volume types: configMap, csi, downwardAPI, emptyDir,
  # ephemeral, image, persistentVolumeClaim, projected, secret
```

### Adapting a Privileged Workload

Many workloads appear to require privileges but can be adapted:

```yaml
# BEFORE: privileged container (fails baseline)
securityContext:
  privileged: true
  runAsUser: 0

# AFTER: minimal capabilities instead of full privilege
securityContext:
  allowPrivilegeEscalation: false
  runAsNonRoot: true
  runAsUser: 1000
  capabilities:
    drop: ["ALL"]
    add: ["NET_ADMIN"]    # Only if actually needed

# For workloads that genuinely need root (node agents, DaemonSets):
# Place them in a namespace with enforce: privileged
# rather than polluting application namespaces
```

## Migration from PodSecurityPolicy

### Assessment Phase

```bash
# List all existing PSPs
kubectl get psp -o wide

# See which PSPs are in use (via RBAC)
for PSP in $(kubectl get psp -o name | cut -d/ -f2); do
  echo "=== PSP: $PSP ==="
  kubectl get clusterrolebinding,rolebinding -A -o json | \
    jq -r --arg psp "$PSP" \
    '.items[] | select(.roleRef.name | contains($psp)) |
    [.metadata.name, .metadata.namespace // "cluster-wide"] | @tsv'
done

# Find workloads using each PSP
kubectl get pods -A -o json | \
  jq -r '.items[] | [
    .metadata.namespace,
    .metadata.name,
    .metadata.annotations["kubernetes.io/psp"]
  ] | @tsv' | grep -v "null"
```

### Mapping PSP to PSA Levels

```bash
# PSP policy audit helper
cat > /tmp/check-psp-mapping.sh << 'EOF'
#!/bin/bash
# Analyze a namespace's running pods to determine
# which PSA level they would pass

NAMESPACE=$1

kubectl get pods -n "$NAMESPACE" -o json | \
jq -r '.items[] | .metadata.name as $name |
  .spec.securityContext as $psc |
  .spec.containers[] |
  [$name, .name,
   (if .securityContext.privileged == true then "PRIVILEGED" else "" end),
   (if .securityContext.runAsUser == 0 then "ROOT" else "" end),
   (if .securityContext.allowPrivilegeEscalation == false then "" else "ALLOW_PRIVESC" end)
  ] | @tsv'
EOF
chmod +x /tmp/check-psp-mapping.sh
/tmp/check-psp-mapping.sh my-namespace
```

### Step-by-Step Migration

```bash
# Step 1: Enable audit logging without enforcement
kubectl label namespace production \
  pod-security.kubernetes.io/audit=restricted \
  pod-security.kubernetes.io/audit-version=v1.28 \
  pod-security.kubernetes.io/warn=restricted \
  pod-security.kubernetes.io/warn-version=v1.28

# Step 2: Review audit log for violations
kubectl get events -n production | grep 'violates PodSecurity'

# Or check API server audit log
grep 'pod-security.admission' /var/log/kubernetes/audit.log | \
  jq -r 'select(.annotations["pod-security.kubernetes.io/audit-violations"] != null) |
  .objectRef.name + ": " + .annotations["pod-security.kubernetes.io/audit-violations"]'

# Step 3: Fix violations in application manifests
# Step 4: Add enforcement after violations are resolved
kubectl label namespace production \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/enforce-version=v1.28

# Step 5: Remove PSP RBAC bindings
# (after all namespaces have PSA labels and PSP is no longer needed)

# Step 6: Remove PodSecurityPolicy objects
kubectl delete psp --all
```

## OPA Gatekeeper: When PSA Is Not Enough

PSA's three-level model covers most security needs, but some organizations require custom policies that PSA cannot express. OPA Gatekeeper provides a policy framework based on Rego.

### Installation

```bash
helm install gatekeeper gatekeeper/gatekeeper \
  --namespace gatekeeper-system \
  --create-namespace \
  --set replicas=3 \
  --set auditInterval=60 \
  --set auditFromCache=true \
  --set constraintViolationsLimit=100
```

### Custom Constraint: Require Specific Labels

```yaml
# ConstraintTemplate defines the Rego policy
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequiredlabels
spec:
  crd:
    spec:
      names:
        kind: K8sRequiredLabels
      validation:
        openAPIV3Schema:
          type: object
          properties:
            labels:
              type: array
              items:
                type: string
  targets:
  - target: admission.k8s.gatekeeper.sh
    rego: |
      package k8srequiredlabels

      violation[{"msg": msg}] {
        provided := {label | input.review.object.metadata.labels[label]}
        required := {label | label := input.parameters.labels[_]}
        missing := required - provided
        count(missing) > 0
        msg := sprintf("Missing required labels: %v", [missing])
      }

---
# Constraint instance: require specific labels on all pods
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredLabels
metadata:
  name: require-app-labels
spec:
  match:
    kinds:
    - apiGroups: [""]
      kinds: ["Pod"]
    namespaces: ["production", "staging"]
  parameters:
    labels:
      - app
      - owner
      - version
```

### Gatekeeper Audit

Gatekeeper's audit controller periodically scans existing resources for violations:

```bash
# Check constraint violations in the cluster
kubectl get constraints -o json | \
  jq -r '.items[] | .metadata.name + ": " +
  (.status.totalViolations | tostring) + " violations"'

# Detail violations for a specific constraint
kubectl describe k8srequiredlabels require-app-labels
```

## Kyverno: Kubernetes-Native Policy Engine

Kyverno uses Kubernetes manifests for policy definition, making it more accessible than Rego.

### Installation

```bash
helm install kyverno kyverno/kyverno \
  --namespace kyverno \
  --create-namespace \
  --set replicaCount=3 \
  --set features.policyExceptions.enabled=true
```

### Kyverno Policy: Require Non-Root

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-non-root
spec:
  validationFailureAction: Enforce
  background: true
  rules:
  - name: check-runAsNonRoot
    match:
      any:
      - resources:
          kinds: ["Pod"]
          namespaces: ["production", "staging"]
    validate:
      message: "Containers must run as non-root"
      pattern:
        spec:
          securityContext:
            runAsNonRoot: true
          containers:
          - securityContext:
              runAsNonRoot: true
              allowPrivilegeEscalation: false
```

### Kyverno Policy: Mutate — Add Default Security Context

Kyverno can mutate resources, not just validate them:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: add-default-securitycontext
spec:
  rules:
  - name: add-securitycontext
    match:
      any:
      - resources:
          kinds: ["Pod"]
    mutate:
      patchStrategicMerge:
        spec:
          +(securityContext):
            runAsNonRoot: true
            seccompProfile:
              type: RuntimeDefault
          containers:
          - (name): "*"
            +(securityContext):
              allowPrivilegeEscalation: false
              capabilities:
                drop: ["ALL"]
```

### Kyverno Policy: Generate — Create NetworkPolicy for New Namespaces

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: create-default-networkpolicy
spec:
  rules:
  - name: default-deny
    match:
      any:
      - resources:
          kinds: ["Namespace"]
    generate:
      apiVersion: networking.k8s.io/v1
      kind: NetworkPolicy
      name: default-deny-all
      namespace: "{{request.object.metadata.name}}"
      data:
        spec:
          podSelector: {}
          policyTypes:
          - Ingress
          - Egress
```

### Kyverno Policy Exceptions

```yaml
apiVersion: kyverno.io/v2beta1
kind: PolicyException
metadata:
  name: allow-legacy-app
  namespace: legacy-namespace
spec:
  exceptions:
  - policyName: require-non-root
    ruleNames:
    - check-runAsNonRoot
  match:
    any:
    - resources:
        kinds: ["Pod"]
        names: ["legacy-app-*"]
        namespaces: ["legacy-namespace"]
```

## PSA vs Gatekeeper vs Kyverno Comparison

| Feature | PSA | OPA Gatekeeper | Kyverno |
|---|---|---|---|
| Built-in | Yes | No (external) | No (external) |
| Configuration | Namespace labels | Rego + CRDs | YAML + CRDs |
| Custom policies | No | Yes (Rego) | Yes (YAML/JMESPath) |
| Mutation | No | No (only validation) | Yes |
| Policy generation | No | No | Yes |
| Audit mode | Yes (warn/audit) | Yes (audit controller) | Yes |
| Policy exceptions | No | Yes | Yes |
| Learning curve | Low | High (Rego) | Medium |
| External data | No | Yes (OPA external data) | Yes |

### Recommended Combination

For most production clusters:

1. **PSA** as the foundation (enforce baseline everywhere, restricted for high-security namespaces)
2. **Kyverno** for mutation policies (default security contexts, label injection), custom validations that PSA can't express, and NetworkPolicy generation
3. **Gatekeeper** only when Rego-based policies are already in use (avoid both Kyverno and Gatekeeper in the same cluster)

This approach maximizes coverage while minimizing operational complexity. PSA handles the common cases with zero additional infrastructure, and Kyverno fills the gaps for teams that need more.
