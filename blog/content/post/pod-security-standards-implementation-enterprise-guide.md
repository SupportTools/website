---
title: "Pod Security Standards Implementation Guide: Enforcing Container Security in Kubernetes Enterprise Environments"
date: 2026-10-21T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Security", "Pod Security", "PSS", "PSA", "Container Security", "Compliance"]
categories: ["Kubernetes", "Security", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing Pod Security Standards (PSS) and Pod Security Admission (PSA) in enterprise Kubernetes environments with practical examples, migration strategies, and enforcement patterns."
more_link: "yes"
url: "/pod-security-standards-implementation-enterprise-guide/"
---

Pod Security Standards (PSS) represent the modern approach to enforcing security policies in Kubernetes clusters, replacing the deprecated Pod Security Policies (PSP). This comprehensive guide provides enterprise teams with practical strategies for implementing PSS using Pod Security Admission (PSA), including migration from PSP, custom enforcement patterns, and production-ready configurations.

Understanding Pod Security Standards is critical for organizations running containerized workloads at scale. This guide covers everything from basic implementation to advanced multi-tenant enforcement scenarios, policy customization, and integration with existing security tooling.

<!--more-->

# Pod Security Standards Implementation Guide

## Understanding Pod Security Standards

### The Three Security Profiles

Pod Security Standards define three security profiles that cover a broad spectrum of security requirements:

**Privileged Profile**
- Unrestricted policy providing the widest possible permission set
- Allows known privilege escalations
- Used for system-level workloads and infrastructure components

**Baseline Profile**
- Minimally restrictive policy preventing known privilege escalations
- Blocks the most common container security issues
- Suitable for most applications with minimal restrictions

**Restricted Profile**
- Heavily restricted policy following current Pod hardening best practices
- Follows defense-in-depth principles
- Requires significant application modifications for compliance

### Pod Security Admission Controller

PSA is the built-in admission controller that enforces Pod Security Standards:

```yaml
# Pod Security Admission Configuration
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
      usernames: []
      runtimeClasses: []
      namespaces: ["kube-system", "kube-public", "kube-node-lease"]
```

## Implementing Pod Security Standards

### Namespace-Level Configuration

The primary method for enforcing Pod Security Standards is through namespace labels:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: production-apps
  labels:
    # Enforcement mode - blocks pod creation
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: v1.28

    # Audit mode - logs violations
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: v1.28

    # Warning mode - returns warnings to client
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: v1.28
---
apiVersion: v1
kind: Namespace
metadata:
  name: development-apps
  labels:
    pod-security.kubernetes.io/enforce: baseline
    pod-security.kubernetes.io/enforce-version: v1.28
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: v1.28
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: v1.28
---
apiVersion: v1
kind: Namespace
metadata:
  name: system-components
  labels:
    pod-security.kubernetes.io/enforce: privileged
    pod-security.kubernetes.io/enforce-version: v1.28
    pod-security.kubernetes.io/audit: privileged
    pod-security.kubernetes.io/audit-version: v1.28
```

### Restricted Profile Compliant Pod

Example of a pod that meets the restricted profile requirements:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: secure-app
  namespace: production-apps
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    fsGroup: 2000
    seccompProfile:
      type: RuntimeDefault
  containers:
  - name: app
    image: myapp:1.0
    securityContext:
      allowPrivilegeEscalation: false
      runAsNonRoot: true
      runAsUser: 1000
      capabilities:
        drop:
        - ALL
      seccompProfile:
        type: RuntimeDefault
    resources:
      requests:
        memory: "64Mi"
        cpu: "250m"
      limits:
        memory: "128Mi"
        cpu: "500m"
    volumeMounts:
    - name: data
      mountPath: /data
      readOnly: false
  volumes:
  - name: data
    emptyDir: {}
```

## Migration from Pod Security Policy

### Assessment and Planning

Before migrating from PSP to PSS, assess your current security posture:

```bash
#!/bin/bash
# audit-psp-usage.sh - Analyze current PSP usage

echo "=== Pod Security Policy Usage Analysis ==="
echo

echo "Current PSPs in cluster:"
kubectl get psp
echo

echo "Pods using each PSP:"
for psp in $(kubectl get psp -o name | cut -d/ -f2); do
    echo "PSP: $psp"
    kubectl get pods -A -o json | jq -r \
        ".items[] | select(.metadata.annotations.\"kubernetes.io/psp\" == \"$psp\") | \
        \"\(.metadata.namespace)/\(.metadata.name)\""
    echo
done

echo "Namespaces without explicit PSP bindings:"
kubectl get ns -o json | jq -r \
    '.items[] | select(.metadata.labels["pod-security.kubernetes.io/enforce"] == null) | .metadata.name'
echo

echo "Pods violating baseline standard:"
kubectl get pods -A -o json | jq -r '
    .items[] |
    select(
        .spec.securityContext.runAsNonRoot != true or
        .spec.containers[].securityContext.allowPrivilegeEscalation != false
    ) | "\(.metadata.namespace)/\(.metadata.name)"'
```

### Gradual Migration Strategy

Implement a phased approach to migration:

**Phase 1: Discovery and Warning**

```yaml
# Apply warning labels to all namespaces
apiVersion: v1
kind: Namespace
metadata:
  name: default
  labels:
    # No enforcement yet - just warn
    pod-security.kubernetes.io/warn: baseline
    pod-security.kubernetes.io/warn-version: v1.28
    pod-security.kubernetes.io/audit: baseline
    pod-security.kubernetes.io/audit-version: v1.28
```

**Phase 2: Baseline Enforcement**

```bash
#!/bin/bash
# apply-baseline-enforcement.sh

NAMESPACES=$(kubectl get ns -o name | grep -v "kube-")

for ns in $NAMESPACES; do
    echo "Applying baseline enforcement to $ns"
    kubectl label $ns \
        pod-security.kubernetes.io/enforce=baseline \
        pod-security.kubernetes.io/enforce-version=v1.28 \
        --overwrite
done
```

**Phase 3: Restricted Enforcement for Production**

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: v1.28
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: v1.28
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: v1.28
```

## Advanced Configuration Patterns

### Multi-Tenant Enforcement

Different enforcement levels for different teams:

```yaml
---
apiVersion: v1
kind: Namespace
metadata:
  name: team-alpha-prod
  labels:
    team: alpha
    environment: production
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: v1.28
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: v1.28
---
apiVersion: v1
kind: Namespace
metadata:
  name: team-alpha-dev
  labels:
    team: alpha
    environment: development
    pod-security.kubernetes.io/enforce: baseline
    pod-security.kubernetes.io/enforce-version: v1.28
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: v1.28
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: v1.28
---
apiVersion: v1
kind: Namespace
metadata:
  name: team-beta-prod
  labels:
    team: beta
    environment: production
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: v1.28
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: v1.28
```

### Custom Exemptions Configuration

Configure exemptions for specific use cases:

```yaml
apiVersion: apiserver.config.k8s.io/v1
kind: AdmissionConfiguration
plugins:
- name: PodSecurity
  configuration:
    apiVersion: pod-security.admission.config.k8s.io/v1
    kind: PodSecurityConfiguration
    defaults:
      enforce: "baseline"
      enforce-version: "v1.28"
      audit: "restricted"
      audit-version: "v1.28"
      warn: "restricted"
      warn-version: "v1.28"
    exemptions:
      # Exempt specific users
      usernames:
      - "system:serviceaccount:kube-system:replicaset-controller"
      - "system:serviceaccount:kube-system:daemon-set-controller"

      # Exempt specific runtime classes
      runtimeClasses:
      - "kata-containers"
      - "firecracker"

      # Exempt entire namespaces
      namespaces:
      - "kube-system"
      - "kube-public"
      - "kube-node-lease"
      - "monitoring"
      - "ingress-nginx"
      - "cert-manager"
```

## Deployment Automation

### Helm Chart Integration

Integrate PSS labels into Helm charts:

```yaml
# templates/namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: {{ .Values.namespace }}
  labels:
    {{- if .Values.podSecurity.enabled }}
    pod-security.kubernetes.io/enforce: {{ .Values.podSecurity.enforce }}
    pod-security.kubernetes.io/enforce-version: {{ .Values.podSecurity.version }}
    pod-security.kubernetes.io/audit: {{ .Values.podSecurity.audit }}
    pod-security.kubernetes.io/audit-version: {{ .Values.podSecurity.version }}
    pod-security.kubernetes.io/warn: {{ .Values.podSecurity.warn }}
    pod-security.kubernetes.io/warn-version: {{ .Values.podSecurity.version }}
    {{- end }}
```

```yaml
# values.yaml
namespace: my-app
podSecurity:
  enabled: true
  enforce: restricted
  audit: restricted
  warn: restricted
  version: v1.28
```

### GitOps Integration with ArgoCD

Configure ArgoCD to manage Pod Security Standards:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: namespace-security-config
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/myorg/k8s-config
    targetRevision: main
    path: security/pod-security-standards
  destination:
    server: https://kubernetes.default.svc
  syncPolicy:
    automated:
      prune: false
      selfHeal: true
    syncOptions:
    - CreateNamespace=true
    - ApplyOutOfSyncOnly=true
```

### Terraform Configuration

Manage namespaces with PSS using Terraform:

```hcl
# namespaces.tf
variable "namespaces" {
  type = map(object({
    enforce_level = string
    audit_level   = string
    warn_level    = string
  }))
  default = {
    production = {
      enforce_level = "restricted"
      audit_level   = "restricted"
      warn_level    = "restricted"
    }
    staging = {
      enforce_level = "baseline"
      audit_level   = "restricted"
      warn_level    = "restricted"
    }
    development = {
      enforce_level = "baseline"
      audit_level   = "baseline"
      warn_level    = "baseline"
    }
  }
}

resource "kubernetes_namespace" "app_namespaces" {
  for_each = var.namespaces

  metadata {
    name = each.key
    labels = {
      "pod-security.kubernetes.io/enforce"         = each.value.enforce_level
      "pod-security.kubernetes.io/enforce-version" = "v1.28"
      "pod-security.kubernetes.io/audit"           = each.value.audit_level
      "pod-security.kubernetes.io/audit-version"   = "v1.28"
      "pod-security.kubernetes.io/warn"            = each.value.warn_level
      "pod-security.kubernetes.io/warn-version"    = "v1.28"
    }
  }
}
```

## Compliance and Audit Tooling

### Automated Compliance Checking

Create a compliance checker for ongoing validation:

```python
#!/usr/bin/env python3
# pss-compliance-checker.py

import json
import subprocess
from typing import Dict, List, Set
from dataclasses import dataclass

@dataclass
class SecurityViolation:
    namespace: str
    pod: str
    violation_type: str
    details: str

class PodSecurityChecker:
    def __init__(self):
        self.violations: List[SecurityViolation] = []

    def check_namespace_labels(self) -> None:
        """Check that all namespaces have appropriate PSS labels"""
        result = subprocess.run(
            ["kubectl", "get", "ns", "-o", "json"],
            capture_output=True,
            text=True
        )
        namespaces = json.loads(result.stdout)

        exempt_namespaces = {"kube-system", "kube-public", "kube-node-lease"}

        for ns in namespaces["items"]:
            name = ns["metadata"]["name"]
            if name in exempt_namespaces:
                continue

            labels = ns["metadata"].get("labels", {})

            # Check for enforce label
            if "pod-security.kubernetes.io/enforce" not in labels:
                self.violations.append(SecurityViolation(
                    namespace=name,
                    pod="N/A",
                    violation_type="MISSING_ENFORCE_LABEL",
                    details="Namespace missing pod-security.kubernetes.io/enforce label"
                ))

            # Check for audit label
            if "pod-security.kubernetes.io/audit" not in labels:
                self.violations.append(SecurityViolation(
                    namespace=name,
                    pod="N/A",
                    violation_type="MISSING_AUDIT_LABEL",
                    details="Namespace missing pod-security.kubernetes.io/audit label"
                ))

    def check_pod_compliance(self, profile: str = "restricted") -> None:
        """Check pods for compliance with specified profile"""
        result = subprocess.run(
            ["kubectl", "get", "pods", "-A", "-o", "json"],
            capture_output=True,
            text=True
        )
        pods = json.loads(result.stdout)

        for pod in pods["items"]:
            namespace = pod["metadata"]["namespace"]
            name = pod["metadata"]["name"]
            spec = pod["spec"]

            if profile in ["baseline", "restricted"]:
                self._check_baseline_requirements(namespace, name, spec)

            if profile == "restricted":
                self._check_restricted_requirements(namespace, name, spec)

    def _check_baseline_requirements(self, namespace: str, name: str, spec: Dict) -> None:
        """Check baseline profile requirements"""
        # Check hostNetwork
        if spec.get("hostNetwork", False):
            self.violations.append(SecurityViolation(
                namespace=namespace,
                pod=name,
                violation_type="HOST_NETWORK",
                details="Pod uses hostNetwork"
            ))

        # Check hostPID
        if spec.get("hostPID", False):
            self.violations.append(SecurityViolation(
                namespace=namespace,
                pod=name,
                violation_type="HOST_PID",
                details="Pod uses hostPID"
            ))

        # Check hostIPC
        if spec.get("hostIPC", False):
            self.violations.append(SecurityViolation(
                namespace=namespace,
                pod=name,
                violation_type="HOST_IPC",
                details="Pod uses hostIPC"
            ))

        # Check privileged containers
        for container in spec.get("containers", []):
            sec_context = container.get("securityContext", {})
            if sec_context.get("privileged", False):
                self.violations.append(SecurityViolation(
                    namespace=namespace,
                    pod=name,
                    violation_type="PRIVILEGED_CONTAINER",
                    details=f"Container {container['name']} is privileged"
                ))

    def _check_restricted_requirements(self, namespace: str, name: str, spec: Dict) -> None:
        """Check restricted profile requirements"""
        # Check runAsNonRoot
        pod_security_context = spec.get("securityContext", {})
        if not pod_security_context.get("runAsNonRoot", False):
            self.violations.append(SecurityViolation(
                namespace=namespace,
                pod=name,
                violation_type="RUN_AS_ROOT",
                details="Pod does not set runAsNonRoot=true"
            ))

        # Check containers
        for container in spec.get("containers", []):
            sec_context = container.get("securityContext", {})

            # Check allowPrivilegeEscalation
            if sec_context.get("allowPrivilegeEscalation", True):
                self.violations.append(SecurityViolation(
                    namespace=namespace,
                    pod=name,
                    violation_type="PRIVILEGE_ESCALATION",
                    details=f"Container {container['name']} allows privilege escalation"
                ))

            # Check capabilities
            capabilities = sec_context.get("capabilities", {})
            drop = capabilities.get("drop", [])
            if "ALL" not in drop:
                self.violations.append(SecurityViolation(
                    namespace=namespace,
                    pod=name,
                    violation_type="CAPABILITIES",
                    details=f"Container {container['name']} does not drop ALL capabilities"
                ))

            # Check seccomp
            seccomp = sec_context.get("seccompProfile", {})
            if seccomp.get("type") not in ["RuntimeDefault", "Localhost"]:
                self.violations.append(SecurityViolation(
                    namespace=namespace,
                    pod=name,
                    violation_type="SECCOMP",
                    details=f"Container {container['name']} missing seccomp profile"
                ))

    def generate_report(self) -> str:
        """Generate compliance report"""
        report = ["=" * 80]
        report.append("POD SECURITY STANDARDS COMPLIANCE REPORT")
        report.append("=" * 80)
        report.append(f"\nTotal Violations: {len(self.violations)}\n")

        # Group by violation type
        violations_by_type: Dict[str, List[SecurityViolation]] = {}
        for violation in self.violations:
            if violation.violation_type not in violations_by_type:
                violations_by_type[violation.violation_type] = []
            violations_by_type[violation.violation_type].append(violation)

        for vtype, vlist in sorted(violations_by_type.items()):
            report.append(f"\n{vtype} ({len(vlist)} violations):")
            report.append("-" * 80)
            for v in vlist:
                report.append(f"  Namespace: {v.namespace}")
                report.append(f"  Pod: {v.pod}")
                report.append(f"  Details: {v.details}")
                report.append("")

        return "\n".join(report)

if __name__ == "__main__":
    checker = PodSecurityChecker()

    print("Checking namespace labels...")
    checker.check_namespace_labels()

    print("Checking pod compliance against restricted profile...")
    checker.check_pod_compliance("restricted")

    print("\n" + checker.generate_report())

    # Exit with error code if violations found
    exit(1 if checker.violations else 0)
```

### Continuous Monitoring with Prometheus

Monitor PSS violations using custom metrics:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: pss-exporter
  namespace: monitoring
data:
  exporter.py: |
    #!/usr/bin/env python3
    from prometheus_client import start_http_server, Gauge
    from kubernetes import client, config
    import time

    # Metrics
    namespace_without_labels = Gauge(
        'pss_namespaces_without_labels',
        'Number of namespaces without PSS labels'
    )

    pods_violating_baseline = Gauge(
        'pss_pods_violating_baseline',
        'Number of pods violating baseline profile',
        ['namespace']
    )

    pods_violating_restricted = Gauge(
        'pss_pods_violating_restricted',
        'Number of pods violating restricted profile',
        ['namespace']
    )

    def check_namespaces():
        config.load_incluster_config()
        v1 = client.CoreV1Api()

        namespaces = v1.list_namespace()
        count = 0

        exempt = {'kube-system', 'kube-public', 'kube-node-lease'}

        for ns in namespaces.items:
            if ns.metadata.name in exempt:
                continue

            labels = ns.metadata.labels or {}
            if 'pod-security.kubernetes.io/enforce' not in labels:
                count += 1

        namespace_without_labels.set(count)

    def check_pods():
        config.load_incluster_config()
        v1 = client.CoreV1Api()

        pods = v1.list_pod_for_all_namespaces()

        violations = {}

        for pod in pods.items:
            ns = pod.metadata.namespace
            if ns not in violations:
                violations[ns] = {'baseline': 0, 'restricted': 0}

            # Check baseline violations
            if (pod.spec.host_network or
                pod.spec.host_pid or
                pod.spec.host_ipc):
                violations[ns]['baseline'] += 1

            # Check restricted violations
            if pod.spec.security_context:
                if not pod.spec.security_context.run_as_non_root:
                    violations[ns]['restricted'] += 1

            for container in pod.spec.containers:
                if container.security_context:
                    if container.security_context.privileged:
                        violations[ns]['baseline'] += 1
                    if container.security_context.allow_privilege_escalation:
                        violations[ns]['restricted'] += 1

        for ns, counts in violations.items():
            pods_violating_baseline.labels(namespace=ns).set(counts['baseline'])
            pods_violating_restricted.labels(namespace=ns).set(counts['restricted'])

    if __name__ == '__main__':
        start_http_server(8000)
        while True:
            check_namespaces()
            check_pods()
            time.sleep(60)
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pss-exporter
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: pss-exporter
  template:
    metadata:
      labels:
        app: pss-exporter
    spec:
      serviceAccountName: pss-exporter
      containers:
      - name: exporter
        image: python:3.11-slim
        command:
        - python3
        - /scripts/exporter.py
        ports:
        - containerPort: 8000
          name: metrics
        volumeMounts:
        - name: scripts
          mountPath: /scripts
      volumes:
      - name: scripts
        configMap:
          name: pss-exporter
          defaultMode: 0755
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: pss-exporter
  namespace: monitoring
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: pss-exporter
rules:
- apiGroups: [""]
  resources: ["namespaces", "pods"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: pss-exporter
subjects:
- kind: ServiceAccount
  name: pss-exporter
  namespace: monitoring
roleRef:
  kind: ClusterRole
  name: pss-exporter
  apiGroup: rbac.authorization.k8s.io
```

## Troubleshooting Common Issues

### Issue 1: Pods Rejected After Migration

**Symptom**: Existing pods are rejected when enforcement is enabled.

**Solution**: Use audit mode first to identify violations:

```bash
# Apply audit labels
kubectl label namespace default \
    pod-security.kubernetes.io/audit=baseline \
    pod-security.kubernetes.io/audit-version=v1.28

# Check audit logs
kubectl logs -n kube-system -l component=kube-apiserver | \
    grep "pod-security"
```

### Issue 2: System Pods Blocked

**Symptom**: Essential system pods cannot start after enforcement.

**Solution**: Add namespace exemptions:

```yaml
apiVersion: apiserver.config.k8s.io/v1
kind: AdmissionConfiguration
plugins:
- name: PodSecurity
  configuration:
    apiVersion: pod-security.admission.config.k8s.io/v1
    kind: PodSecurityConfiguration
    exemptions:
      namespaces:
      - "kube-system"
      - "monitoring"
      - "ingress-nginx"
```

### Issue 3: Third-Party Applications

**Symptom**: Third-party Helm charts fail to deploy.

**Solution**: Create dedicated namespaces with appropriate levels:

```bash
# Create namespace with baseline for third-party apps
kubectl create namespace third-party-apps
kubectl label namespace third-party-apps \
    pod-security.kubernetes.io/enforce=baseline \
    pod-security.kubernetes.io/enforce-version=v1.28
```

## Best Practices and Recommendations

### Security Hardening

1. **Start with Warning Mode**: Begin with warning and audit modes before enforcement
2. **Gradual Rollout**: Apply restrictions progressively across environments
3. **Version Pinning**: Pin policy versions to prevent unexpected changes
4. **Regular Reviews**: Periodically review and update security profiles

### Production Deployment

```yaml
# Production namespace template
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    environment: production
    # Enforce restricted for production
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: v1.28
    # Audit at restricted level
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: v1.28
    # Warn at restricted level
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: v1.28
  annotations:
    description: "Production workloads with strict security requirements"
```

### Development and Staging

```yaml
# Development namespace template
apiVersion: v1
kind: Namespace
metadata:
  name: development
  labels:
    environment: development
    # Baseline enforcement for development
    pod-security.kubernetes.io/enforce: baseline
    pod-security.kubernetes.io/enforce-version: v1.28
    # Audit at restricted to identify improvements
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: v1.28
    # Warn at restricted
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: v1.28
```

## Integration with Policy Engines

### OPA Gatekeeper Complement

Combine PSS with OPA Gatekeeper for additional policies:

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8spssmaxversion
spec:
  crd:
    spec:
      names:
        kind: K8sPSSMaxVersion
      validation:
        openAPIV3Schema:
          type: object
          properties:
            maxVersion:
              type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8spssmaxversion

        violation[{"msg": msg}] {
          input.review.object.kind == "Namespace"
          labels := input.review.object.metadata.labels
          enforce_version := labels["pod-security.kubernetes.io/enforce-version"]
          enforce_version > input.parameters.maxVersion
          msg := sprintf("PSS enforce version %v exceeds maximum allowed %v", [enforce_version, input.parameters.maxVersion])
        }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sPSSMaxVersion
metadata:
  name: pss-max-version
spec:
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Namespace"]
  parameters:
    maxVersion: "v1.28"
```

### Kyverno Policy Enhancement

Use Kyverno to auto-label namespaces:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: add-pss-labels
spec:
  rules:
  - name: add-baseline-labels
    match:
      any:
      - resources:
          kinds:
          - Namespace
        clusterRoles:
        - cluster-admin
    exclude:
      any:
      - resources:
          namespaces:
          - kube-system
          - kube-public
          - kube-node-lease
    mutate:
      patchStrategicMerge:
        metadata:
          labels:
            +(pod-security.kubernetes.io/enforce): baseline
            +(pod-security.kubernetes.io/enforce-version): v1.28
            +(pod-security.kubernetes.io/audit): restricted
            +(pod-security.kubernetes.io/audit-version): v1.28
            +(pod-security.kubernetes.io/warn): restricted
            +(pod-security.kubernetes.io/warn-version): v1.28
```

## Conclusion

Pod Security Standards provide a modern, standardized approach to enforcing container security in Kubernetes. By following the implementation strategies outlined in this guide, organizations can:

- Establish consistent security baselines across clusters
- Migrate smoothly from deprecated Pod Security Policies
- Maintain compliance with security requirements
- Balance security with operational flexibility

The key to successful PSS implementation is gradual adoption, comprehensive testing, and continuous monitoring. Start with warning and audit modes, progressively enforce stricter profiles, and integrate PSS with your existing security tooling for defense-in-depth protection.

Remember that Pod Security Standards are just one layer of Kubernetes security. Combine PSS with network policies, RBAC, service mesh security, and runtime protection for comprehensive cluster security.