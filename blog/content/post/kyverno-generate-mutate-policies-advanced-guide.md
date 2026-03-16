---
title: "Kyverno Advanced Policies: Generate, Mutate, and VerifyImages at Scale"
date: 2027-04-09T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Kyverno", "Policy", "Security", "Admission Control"]
categories: ["Kubernetes", "Security", "Policy Enforcement"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Advanced Kyverno policy guide covering generate rules for automatic ConfigMap/NetworkPolicy creation, mutate rules for default annotations and resource injection, image signature verification with Cosign keyless and key-based, custom CEL expressions, PolicyException management, and policy testing with the Kyverno CLI."
more_link: "yes"
url: "/kyverno-generate-mutate-policies-advanced-guide/"
---

Kyverno's three main policy rule types — validate, generate, and mutate — work together to enforce, create, and modify Kubernetes resources automatically. Validate rules catch policy violations at admission time. Generate rules provision supporting resources when new objects appear. Mutate rules correct or augment resources before they reach etcd. Together, they can automate what previously required custom controllers or heavy manual effort from platform teams.

This guide focuses on the advanced use cases: propagating ConfigMaps across namespaces with synchronization, auto-creating NetworkPolicies on namespace creation, mutating resource limits and annotations, and verifying container image signatures with Cosign — all at the scale needed for multi-team production clusters.

<!--more-->

## Generate Rules

### ConfigMap Propagation with cloneFrom

Generate rules with `cloneFrom` copy an existing resource into new namespaces and optionally keep the copies synchronized when the source changes.

```yaml
# policies/generate-shared-configmap.yaml
# Copies a central CA bundle ConfigMap into every new namespace

apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: propagate-ca-bundle
  annotations:
    policies.kyverno.io/title: "Propagate CA Bundle to New Namespaces"
    policies.kyverno.io/category: "Security"
    policies.kyverno.io/severity: high
    policies.kyverno.io/description: >-
      Copies the corporate CA bundle ConfigMap from the cert-management namespace
      into every new namespace. Enables applications to trust internal certificates
      without manual ConfigMap creation.
spec:
  rules:
    - name: copy-ca-bundle
      match:
        any:
          - resources:
              kinds:
                - Namespace
              # Apply only to application namespaces, not system namespaces
              selector:
                matchLabels:
                  support.tools/managed: "true"
      generate:
        apiVersion: v1
        kind: ConfigMap
        name: corporate-ca-bundle
        namespace: "{{request.object.metadata.name}}"
        # Clone from an existing source ConfigMap
        clone:
          namespace: cert-management
          name: corporate-ca-bundle
        # synchronize: true means updates to the source propagate to all copies
        # Setting this to false means the copy is taken once at namespace creation
        synchronize: true
```

```yaml
# policies/generate-namespace-network-policy.yaml
# Automatically creates a default-deny NetworkPolicy in every new namespace

apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: default-deny-network-policy
  annotations:
    policies.kyverno.io/title: "Auto-Create Default-Deny NetworkPolicy"
    policies.kyverno.io/category: "Networking"
    policies.kyverno.io/severity: medium
    policies.kyverno.io/description: >-
      Creates a default-deny-all NetworkPolicy in every new namespace to enforce
      zero-trust network posture. Teams must explicitly allow ingress and egress.
spec:
  rules:
    - name: create-default-deny
      match:
        any:
          - resources:
              kinds:
                - Namespace
      exclude:
        any:
          - resources:
              namespaces:
                - kube-system
                - kube-public
                - kube-node-lease
                - cert-manager
                - monitoring
                - logging
      generate:
        apiVersion: networking.k8s.io/v1
        kind: NetworkPolicy
        name: default-deny-all
        namespace: "{{request.object.metadata.name}}"
        # synchronize: false — teams may delete this after creating allow rules
        # Set to true if you want to prevent teams from removing it
        synchronize: false
        data:
          metadata:
            labels:
              app.kubernetes.io/managed-by: kyverno
          spec:
            podSelector: {}
            policyTypes:
              - Ingress
              - Egress
```

### Generating Resources with Data and Context

```yaml
# policies/generate-resource-quota.yaml
# Creates ResourceQuota based on namespace tier label

apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: namespace-resource-quota
  annotations:
    policies.kyverno.io/title: "Auto-Create Resource Quota by Tier"
    policies.kyverno.io/category: "Resource Management"
spec:
  rules:
    - name: create-quota-standard
      match:
        any:
          - resources:
              kinds:
                - Namespace
              selector:
                matchLabels:
                  support.tools/tier: standard
      generate:
        apiVersion: v1
        kind: ResourceQuota
        name: default-quota
        namespace: "{{request.object.metadata.name}}"
        synchronize: true
        data:
          spec:
            hard:
              requests.cpu: "4"
              requests.memory: "8Gi"
              limits.cpu: "8"
              limits.memory: "16Gi"
              pods: "50"
              services.nodeports: "0"  # Prohibit NodePort services

    - name: create-quota-premium
      match:
        any:
          - resources:
              kinds:
                - Namespace
              selector:
                matchLabels:
                  support.tools/tier: premium
      generate:
        apiVersion: v1
        kind: ResourceQuota
        name: default-quota
        namespace: "{{request.object.metadata.name}}"
        synchronize: true
        data:
          spec:
            hard:
              requests.cpu: "20"
              requests.memory: "40Gi"
              limits.cpu: "40"
              limits.memory: "80Gi"
              pods: "200"
              services.nodeports: "0"
```

```yaml
# policies/generate-monitoring-config.yaml
# Generate ServiceMonitor and PrometheusRule when a namespace gets monitoring label

apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: generate-monitoring-resources
spec:
  rules:
    - name: create-service-monitor-rbac
      match:
        any:
          - resources:
              kinds:
                - Namespace
              selector:
                matchLabels:
                  support.tools/monitoring: enabled
      generate:
        apiVersion: rbac.authorization.k8s.io/v1
        kind: Role
        name: prometheus-scraper
        namespace: "{{request.object.metadata.name}}"
        synchronize: true
        data:
          rules:
            - apiGroups: [""]
              resources: ["pods", "services", "endpoints"]
              verbs: ["get", "list", "watch"]

    - name: create-prometheus-role-binding
      match:
        any:
          - resources:
              kinds:
                - Namespace
              selector:
                matchLabels:
                  support.tools/monitoring: enabled
      generate:
        apiVersion: rbac.authorization.k8s.io/v1
        kind: RoleBinding
        name: prometheus-scraper
        namespace: "{{request.object.metadata.name}}"
        synchronize: true
        data:
          roleRef:
            apiGroup: rbac.authorization.k8s.io
            kind: Role
            name: prometheus-scraper
          subjects:
            - kind: ServiceAccount
              name: prometheus
              namespace: monitoring
```

## Mutate Rules

### Default Resource Limits Injection

```yaml
# policies/mutate-resource-limits.yaml
# Inject default resource requests and limits when missing

apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: add-default-resource-limits
  annotations:
    policies.kyverno.io/title: "Add Default Resource Limits"
    policies.kyverno.io/category: "Resource Management"
    policies.kyverno.io/severity: medium
    policies.kyverno.io/description: >-
      Injects default CPU and memory requests and limits for containers that do
      not specify them. Prevents unbounded resource consumption from misconfigured
      applications.
spec:
  rules:
    - name: set-container-defaults
      match:
        any:
          - resources:
              kinds:
                - Pod
              namespaces:
                - "!kube-system"
                - "!kube-public"
      mutate:
        # Strategic merge patch — merges with existing spec
        patchStrategicMerge:
          spec:
            containers:
              # =(name) is a conditional anchor — only patches if name exists
              # This iterates over all containers
              - (name): "?*"
                resources:
                  requests:
                    # +(...) is a default anchor — only sets if field is absent
                    +(cpu): "100m"
                    +(memory): "128Mi"
                  limits:
                    +(cpu): "500m"
                    +(memory): "512Mi"

    - name: set-init-container-defaults
      match:
        any:
          - resources:
              kinds:
                - Pod
              namespaces:
                - "!kube-system"
      mutate:
        patchStrategicMerge:
          spec:
            initContainers:
              - (name): "?*"
                resources:
                  requests:
                    +(cpu): "50m"
                    +(memory): "64Mi"
                  limits:
                    +(cpu): "200m"
                    +(memory): "256Mi"
```

### Annotation Stamping with foreach

```yaml
# policies/mutate-add-annotations.yaml
# Add standard annotations to all Deployments and StatefulSets

apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: stamp-deployment-annotations
spec:
  rules:
    - name: add-owner-annotations
      match:
        any:
          - resources:
              kinds:
                - Deployment
                - StatefulSet
                - DaemonSet
      mutate:
        patchStrategicMerge:
          metadata:
            annotations:
              # Stamp with the requesting user's identity
              +(support.tools/last-applied-by): "{{request.userInfo.username}}"
              +(support.tools/last-applied-time): "{{request.object.metadata.creationTimestamp}}"
              # Add cost allocation annotation based on namespace label
              # Uses context lookup — see context section below

    - name: add-pod-template-labels
      match:
        any:
          - resources:
              kinds:
                - Deployment
      mutate:
        patchStrategicMerge:
          spec:
            template:
              metadata:
                labels:
                  # Ensure pods always have the app label for service selectors
                  +(app.kubernetes.io/name): "{{request.object.metadata.name}}"
                  +(app.kubernetes.io/managed-by): "{{request.userInfo.username}}"
```

### JSON 6902 Patch for Precise Mutations

```yaml
# policies/mutate-security-context.yaml
# Use JSON6902 patch to add security context fields precisely

apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: add-pod-security-context
  annotations:
    policies.kyverno.io/title: "Add Pod Security Context"
    policies.kyverno.io/category: "Security"
spec:
  rules:
    - name: add-security-context
      match:
        any:
          - resources:
              kinds:
                - Pod
      # Only apply if securityContext is absent
      preconditions:
        any:
          - key: "{{request.object.spec.securityContext | length(@)}}"
            operator: Equals
            value: "0"
      mutate:
        patchesJson6902: |-
          - path: "/spec/securityContext"
            op: add
            value:
              runAsNonRoot: true
              runAsUser: 1000
              fsGroup: 1000
              seccompProfile:
                type: RuntimeDefault

    - name: add-container-security-context
      match:
        any:
          - resources:
              kinds:
                - Pod
      mutate:
        foreach:
          # Iterate over each container
          - list: "request.object.spec.containers"
            preconditions:
              any:
                # Only mutate containers without allowPrivilegeEscalation set
                - key: "{{element.securityContext.allowPrivilegeEscalation}}"
                  operator: AnyNotIn
                  value:
                    - true
                    - false
            patchesJson6902: |-
              - path: "/spec/containers/{{elementIndex}}/securityContext"
                op: add
                value:
                  allowPrivilegeEscalation: false
                  readOnlyRootFilesystem: true
                  capabilities:
                    drop:
                      - ALL
```

### Mutate with Context Lookup

```yaml
# policies/mutate-with-context.yaml
# Look up namespace labels to set cost center annotation on pods

apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: stamp-cost-center
spec:
  rules:
    - name: add-cost-center
      match:
        any:
          - resources:
              kinds:
                - Pod
      context:
        # Fetch the namespace object to get its labels
        - name: namespaceObj
          apiCall:
            urlPath: "/api/v1/namespaces/{{request.namespace}}"
            jmesPath: "metadata.labels"

        # Fetch from a ConfigMap containing cost center mappings
        - name: costCenterMap
          configMap:
            name: team-cost-centers
            namespace: platform
      mutate:
        patchStrategicMerge:
          metadata:
            labels:
              # Set cost center from namespace label if present
              +(support.tools/cost-center): "{{namespaceObj.\"support.tools/cost-center\" || 'unallocated'}}"
              +(support.tools/team): "{{namespaceObj.\"support.tools/team\" || 'unknown'}}"
```

## VerifyImages with Cosign

### Keyless OIDC-Based Verification (GitHub Actions)

```yaml
# policies/verify-images-keyless.yaml
# Verify images signed by GitHub Actions using Cosign keyless signing

apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-image-signatures-keyless
  annotations:
    policies.kyverno.io/title: "Verify Container Image Signatures (Keyless)"
    policies.kyverno.io/category: "Supply Chain Security"
    policies.kyverno.io/severity: high
    policies.kyverno.io/description: >-
      Requires that all container images are signed using Cosign keyless signing
      via GitHub Actions OIDC. Images without valid signatures are rejected.
spec:
  # validationFailureAction: Enforce rejects unsigned images
  # Use Audit first to discover what is unsigned before enforcing
  validationFailureAction: Enforce

  rules:
    - name: verify-signature-keyless
      match:
        any:
          - resources:
              kinds:
                - Pod
              namespaces:
                # Enforce only in production and staging namespaces
                - prod-*
                - staging-*
      verifyImages:
        - imageReferences:
            # Match all images from the organization registry
            - "123456789012.dkr.ecr.us-east-1.amazonaws.com/acme-corp/*"
          attestors:
            - entries:
                - keyless:
                    # The Fulcio OIDC issuer used during signing
                    issuer: "https://token.actions.githubusercontent.com"
                    # The subject — the GitHub Actions workflow that signed the image
                    # Use a wildcard to match any workflow in the organization
                    subject: "https://github.com/acme-corp/*"
                    # Rekor transparency log for certificate verification
                    rekor:
                      url: https://rekor.sigstore.dev
                  ctlog:
                    url: https://ctfe.sigstore.dev
                    pubKey: |-
                      -----BEGIN PUBLIC KEY-----
                      MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEbfwR+RJudXscgRBRpKX1XFDy3Py
                      EJiMEgVIiJAmyKSXOLfBagRs6JnKRb7OsF4Y/SzFjBF4V2fI50OC1LmNTQ==
                      -----END PUBLIC KEY-----
```

### Key-Based Image Verification

```yaml
# policies/verify-images-keyed.yaml
# Verify images signed with a specific Cosign private key

apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-image-signatures-keyed
  annotations:
    policies.kyverno.io/title: "Verify Container Image Signatures (Key-Based)"
    policies.kyverno.io/category: "Supply Chain Security"
spec:
  validationFailureAction: Enforce

  rules:
    - name: verify-platform-images
      match:
        any:
          - resources:
              kinds:
                - Pod
      verifyImages:
        - imageReferences:
            - "ghcr.io/acme-corp/*"
          attestors:
            - entries:
                - keys:
                    # Public key stored in a ConfigMap — not a secret
                    # The public key verifies but cannot sign
                    publicKeys: |-
                      -----BEGIN PUBLIC KEY-----
                      MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEyQfmL6ZoJ8X3GKPaGi7rSI6U3g
                      5J7VlOvhMXlbZrGq0bBq9hV/5I4L8Q/m3pXZjhGxP7K9Z/vNJyS5hVR8dQ==
                      -----END PUBLIC KEY-----
                    # Use a rekor log for transparency
                    rekor:
                      url: https://rekor.sigstore.dev

        # Additionally verify attestation presence (SBOM)
        - imageReferences:
            - "ghcr.io/acme-corp/*"
          attestations:
            - predicateType: https://spdx.dev/Document
              attestors:
                - entries:
                    - keys:
                        publicKeys: |-
                          -----BEGIN PUBLIC KEY-----
                          MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEyQfmL6ZoJ8X3GKPaGi7rSI6U3g
                          5J7VlOvhMXlbZrGq0bBq9hV/5I4L8Q/m3pXZjhGxP7K9Z/vNJyS5hVR8dQ==
                          -----END PUBLIC KEY-----
```

### SLSA Provenance Attestation Verification

```yaml
# policies/verify-slsa-provenance.yaml
# Require SLSA provenance attestation for all production images

apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-slsa-provenance
  annotations:
    policies.kyverno.io/title: "Require SLSA Build Provenance"
    policies.kyverno.io/category: "Supply Chain Security"
    policies.kyverno.io/severity: high
spec:
  validationFailureAction: Enforce

  rules:
    - name: verify-slsa-provenance
      match:
        any:
          - resources:
              kinds:
                - Pod
              namespaces:
                - prod-*
      verifyImages:
        - imageReferences:
            - "123456789012.dkr.ecr.us-east-1.amazonaws.com/acme-corp/*"
          attestations:
            - predicateType: https://slsa.dev/provenance/v0.2
              conditions:
                all:
                  # Verify the build came from the expected workflow
                  - key: "{{attestation.predicate.builder.id}}"
                    operator: Equals
                    value: "https://github.com/slsa-framework/slsa-github-generator/.github/workflows/builder_go_slsa3.yml@refs/tags/v1.9.0"
                  # Verify the source repository
                  - key: "{{attestation.predicate.invocation.configSource.uri}}"
                    operator: Equals
                    value: "git+https://github.com/acme-corp/platform-service@refs/heads/main"
              attestors:
                - entries:
                    - keyless:
                        issuer: "https://token.actions.githubusercontent.com"
                        subject: "https://github.com/slsa-framework/slsa-github-generator/.github/workflows/builder_go_slsa3.yml@refs/tags/v1.9.0"
```

## CEL Expressions for Complex Validation

### Custom CEL Validation Rules

```yaml
# policies/validate-cel-expressions.yaml
# Use CEL for complex validation logic

apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: validate-with-cel
  annotations:
    policies.kyverno.io/title: "CEL-Based Resource Validation"
    policies.kyverno.io/category: "Best Practices"
spec:
  validationFailureAction: Enforce

  rules:
    - name: validate-deployment-replicas
      match:
        any:
          - resources:
              kinds:
                - Deployment
              namespaces:
                - prod-*
      validate:
        cel:
          expressions:
            # Production deployments must have at least 2 replicas
            - expression: "object.spec.replicas >= 2"
              message: "Production deployments must have at least 2 replicas for HA"

            # Pod disruption budget is required for multi-replica deployments
            # This checks for the label that triggers PDB generation
            - expression: >-
                object.spec.replicas < 2 ||
                has(object.metadata.labels) &&
                "support.tools/pdb-enabled" in object.metadata.labels
              message: >-
                Deployments with 2+ replicas must have the support.tools/pdb-enabled label
                to trigger PodDisruptionBudget creation

            # Container images must come from the approved registry
            - expression: >-
                object.spec.template.spec.containers.all(c,
                  c.image.startsWith("123456789012.dkr.ecr.us-east-1.amazonaws.com/") ||
                  c.image.startsWith("ghcr.io/acme-corp/")
                )
              message: "All container images must come from approved registries"

    - name: validate-service-type
      match:
        any:
          - resources:
              kinds:
                - Service
              namespaces:
                - prod-*
                - staging-*
      validate:
        cel:
          expressions:
            # Only ClusterIP and LoadBalancer services — no NodePort
            - expression: >-
                !has(object.spec.type) ||
                object.spec.type in ["ClusterIP", "LoadBalancer", "ExternalName"]
              message: "NodePort services are not permitted in production namespaces"

            # LoadBalancer services require specific annotations
            - expression: >-
                object.spec.type != "LoadBalancer" ||
                (has(object.metadata.annotations) &&
                "service.beta.kubernetes.io/aws-load-balancer-type" in object.metadata.annotations)
              message: "LoadBalancer services must specify the aws-load-balancer-type annotation"
```

## PolicyException Management

### Creating PolicyExceptions for Selective Bypass

```yaml
# exceptions/legacy-app-exception.yaml
# Grant exceptions for legacy applications that cannot comply immediately

apiVersion: kyverno.io/v2
kind: PolicyException
metadata:
  name: legacy-payment-processor-exception
  namespace: payments
  annotations:
    support.tools/exception-reason: "Legacy application pending containerization refactor"
    support.tools/exception-owner: "payments-team@acme-corp.example.com"
    support.tools/exception-expires: "2027-12-31"
    support.tools/jira-ticket: "PLAT-4821"
spec:
  exceptions:
    # Reference the policies and rules to bypass
    - policyName: add-pod-security-context
      ruleNames:
        - add-security-context
        - add-container-security-context

    - policyName: verify-image-signatures-keyless
      ruleNames:
        - verify-signature-keyless

  match:
    any:
      - resources:
          kinds:
            - Pod
          namespaces:
            - payments
          selector:
            matchLabels:
              # Only the specific legacy application — not all pods in namespace
              app.kubernetes.io/name: legacy-payment-processor
              support.tools/exception: legacy-payment-processor
```

```yaml
# exceptions/monitoring-exception.yaml
# Exception for privileged monitoring components

apiVersion: kyverno.io/v2
kind: PolicyException
metadata:
  name: node-exporter-exception
  namespace: monitoring
  annotations:
    support.tools/exception-reason: "Node exporter requires host network and PID namespace access"
    support.tools/exception-owner: "platform-engineering@acme-corp.example.com"
spec:
  exceptions:
    - policyName: disallow-privileged-containers
      ruleNames:
        - check-privileged

    - policyName: require-pod-requests-limits
      ruleNames:
        - validate-resources

  match:
    any:
      - resources:
          kinds:
            - Pod
          namespaces:
            - monitoring
          selector:
            matchLabels:
              app.kubernetes.io/name: node-exporter
```

## Kyverno CLI Testing

### Test File Structure

```yaml
# kyverno-tests/test-generate-network-policy.yaml
# Test the generate rule for NetworkPolicy creation

apiVersion: cli.kyverno.io/v1alpha1
kind: Test
metadata:
  name: test-default-deny-network-policy
spec:
  policies:
    - ../policies/generate-namespace-network-policy.yaml

  resources:
    - resources/namespaces.yaml

  # Expected results for each test case
  results:
    - policy: default-deny-network-policy
      rule: create-default-deny
      resource: test-app-namespace  # Resource name from resources file
      kind: Namespace
      result: pass

    - policy: default-deny-network-policy
      rule: create-default-deny
      resource: kube-system  # Should be excluded
      kind: Namespace
      result: skip
```

```yaml
# kyverno-tests/resources/namespaces.yaml

apiVersion: v1
kind: Namespace
metadata:
  name: test-app-namespace
  labels:
    support.tools/managed: "true"

---
apiVersion: v1
kind: Namespace
metadata:
  name: kube-system
```

```yaml
# kyverno-tests/test-mutate-resource-limits.yaml
# Test that resource limits are injected correctly

apiVersion: cli.kyverno.io/v1alpha1
kind: Test
metadata:
  name: test-add-default-resource-limits
spec:
  policies:
    - ../policies/mutate-resource-limits.yaml

  resources:
    - resources/pods-no-limits.yaml

  # Specify the expected patched resource
  results:
    - policy: add-default-resource-limits
      rule: set-container-defaults
      resource: pod-no-limits
      kind: Pod
      # patchedResource contains the expected output after mutation
      patchedResource: patched/pod-with-defaults.yaml
      result: pass
```

```yaml
# kyverno-tests/resources/pods-no-limits.yaml

apiVersion: v1
kind: Pod
metadata:
  name: pod-no-limits
  namespace: default
spec:
  containers:
    - name: app
      image: "123456789012.dkr.ecr.us-east-1.amazonaws.com/acme-corp/myapp:1.0.0"
      # No resources specified — should be mutated
```

```yaml
# kyverno-tests/patched/pod-with-defaults.yaml
# Expected output after mutation

apiVersion: v1
kind: Pod
metadata:
  name: pod-no-limits
  namespace: default
spec:
  containers:
    - name: app
      image: "123456789012.dkr.ecr.us-east-1.amazonaws.com/acme-corp/myapp:1.0.0"
      resources:
        requests:
          cpu: "100m"
          memory: "128Mi"
        limits:
          cpu: "500m"
          memory: "512Mi"
```

### Running CLI Tests

```bash
# Install the Kyverno CLI
# Using Homebrew on macOS
brew install kyverno

# Using curl on Linux
curl -LO "https://github.com/kyverno/kyverno/releases/download/v1.12.0/kyverno-cli_v1.12.0_linux_x86_64.tar.gz"
tar -xzf kyverno-cli_v1.12.0_linux_x86_64.tar.gz
sudo mv kyverno /usr/local/bin/

# Run all tests in the tests directory
kyverno test kyverno-tests/

# Run tests with verbose output to see details on each result
kyverno test kyverno-tests/ --detailed-results

# Test a specific policy file against sample resources
kyverno test kyverno-tests/test-generate-network-policy.yaml

# Validate a policy YAML for syntax errors before applying
kyverno validate policies/generate-namespace-network-policy.yaml

# Apply a policy in dry-run mode against existing cluster resources
# This checks what would change without modifying anything
kyverno apply policies/mutate-resource-limits.yaml \
  --resource=<(kubectl get pods --all-namespaces -o yaml)
```

## Background Scan Reports

### Viewing and Acting on Scan Results

```bash
# PolicyReport contains per-namespace results
# ClusterPolicyReport contains cluster-scoped results

# List all policy reports in a namespace
kubectl get policyreports --namespace payments

# Detailed view of a policy report
kubectl describe policyreport cpol-default-deny-network-policy --namespace payments

# Find all failing resources across all namespaces
kubectl get policyreports \
  --all-namespaces \
  -o jsonpath='{range .items[*]}{.metadata.namespace}{"\t"}{.status.summary.fail}{"\n"}{end}' \
  | sort -k2 -rn \
  | head -20

# Export all violations for reporting
kubectl get policyreports --all-namespaces -o json | \
  jq '.items[].results[] | select(.result == "fail") | {
    namespace: .resources[0].namespace,
    resource: .resources[0].name,
    policy: .policy,
    rule: .rule,
    message: .message
  }' > policy-violations.json

# Count violations by policy
kubectl get policyreports --all-namespaces -o json | \
  jq -r '.items[].results[] | select(.result == "fail") | .policy' | \
  sort | uniq -c | sort -rn
```

```yaml
# monitoring/kyverno-policy-alerts.yaml
# Alert when policy violations are detected

apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kyverno-policy-alerts
  namespace: monitoring
  labels:
    release: prometheus
spec:
  groups:
    - name: kyverno
      rules:
        # Alert when high-severity policy violations increase
        - alert: KyvernoPolicyViolationHigh
          expr: |
            kyverno_policy_results_total{
              rule_type="validate",
              policy_background_mode="true",
              resource_request_operation="background_scan",
              main_response="fail"
            } > 0
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Kyverno policy violations detected"
            description: >-
              Policy {{ $labels.policy_name }} rule {{ $labels.rule_name }}
              has {{ $value }} violations in background scan.
```

The combination of generate, mutate, and verifyImages policies creates a self-healing policy framework: namespaces get the right NetworkPolicies, ResourceQuotas, and CA bundles automatically; pods get security contexts and resource limits even when developers forget to set them; and no unsigned image can reach production. PolicyExceptions provide the controlled escape valve for legacy workloads, while the Kyverno CLI makes the entire policy suite testable in CI before any rule reaches the cluster.
