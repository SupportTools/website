---
title: "Kubernetes GitOps Security: Flux/ArgoCD RBAC, Image Signature Verification, Policy Enforcement, and Audit Trails"
date: 2031-12-21T00:00:00-05:00
draft: false
tags: ["GitOps", "Kubernetes", "Security", "ArgoCD", "Flux", "RBAC", "Cosign", "Policy", "Sigstore", "Audit"]
categories:
- Kubernetes
- Security
- GitOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to securing GitOps pipelines with Flux and ArgoCD, covering RBAC hardening, image signature verification with Cosign/Sigstore, OPA Gatekeeper policy enforcement, and immutable audit trail construction."
more_link: "yes"
url: "/kubernetes-gitops-security-flux-argocd-rbac-image-signing-policy-audit-trails/"
---

GitOps eliminates configuration drift and provides an auditable deployment history, but it also concentrates risk: whoever controls the Git repository and the GitOps controller controls every workload in the cluster. A misconfigured ArgoCD instance or an unprotected Flux source controller can become the highest-privilege attack surface in your Kubernetes environment.

This guide covers the complete security hardening of GitOps pipelines including fine-grained RBAC for ArgoCD and Flux, mandatory image signature verification with Cosign and Sigstore, OPA Gatekeeper policies that enforce supply chain requirements, and an audit trail architecture that provides evidence for compliance attestations.

<!--more-->

# Kubernetes GitOps Security: Flux/ArgoCD RBAC, Image Signing, Policy Enforcement, and Audit Trails

## Section 1: Threat Model for GitOps Pipelines

### 1.1 Attack Vectors

| Vector | Description | Mitigation |
|--------|-------------|------------|
| Compromised Git credentials | Attacker pushes malicious manifests | Branch protection, required reviews, signed commits |
| Compromised container registry | Attacker replaces images with malicious ones | Image signature verification (Cosign) |
| GitOps controller privilege escalation | Controller RBAC too broad | Least-privilege RBAC, namespace scoping |
| ArgoCD admin console access | Unauthenticated admin UI | SSO enforcement, network policies |
| Secrets in Git | Plaintext credentials in manifests | SOPS/Sealed Secrets, ESO |
| Malicious dependency updates | Transitive dependency compromise | Pinned image digests, SBOM validation |

### 1.2 Security Principles

1. **GitOps controllers should be unable to escalate beyond their RBAC grants** — the controller cannot do what a human operator cannot
2. **Every artifact deployed must be cryptographically attested** — images, Helm charts, OCI bundles
3. **Policy must be enforced at admission time**, not just in CI
4. **All deployment events must produce immutable audit records**

## Section 2: ArgoCD RBAC Hardening

### 2.1 ArgoCD RBAC Model

ArgoCD has two layers of access control:

- **Kubernetes RBAC** — governs what the ArgoCD controller can do to the cluster
- **ArgoCD RBAC** — governs what users can do through the ArgoCD UI and API

### 2.2 Kubernetes RBAC for ArgoCD Server

Restrict the `argocd-application-controller` service account to only the namespaces it needs:

```yaml
# argocd-controller-role.yaml
# Create a ClusterRole for read-only cluster resources
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: argocd-application-controller-read
rules:
  # Read cluster-scoped resources needed for sync status
  - apiGroups: [""]
    resources: [nodes, namespaces]
    verbs: [get, list, watch]
  - apiGroups: [apiextensions.k8s.io]
    resources: [customresourcedefinitions]
    verbs: [get, list, watch]
  - apiGroups: ["apps"]
    resources: [replicasets, deployments, statefulsets, daemonsets]
    verbs: [get, list, watch]

---
# Per-namespace write permissions
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: argocd-application-controller
  namespace: production
rules:
  - apiGroups: ["*"]
    resources: ["*"]
    verbs: [get, list, watch, create, update, patch, delete]
  # Explicitly deny the ability to modify RBAC
  # (No RBAC resources in rules = controller cannot modify RBAC)

---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: argocd-application-controller
  namespace: production
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: argocd-application-controller
subjects:
  - kind: ServiceAccount
    name: argocd-application-controller
    namespace: argocd
```

### 2.3 ArgoCD Project-Based RBAC

ArgoCD `AppProjects` scope controller permissions to specific namespaces and repositories:

```yaml
# project-production.yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: production
  namespace: argocd
spec:
  description: "Production environment applications"

  # Source repos allowed for this project
  sourceRepos:
    - "https://github.com/example-org/production-apps.git"
    - "registry.example.com/helm-charts/*"

  # Destination clusters and namespaces allowed
  destinations:
    - server: https://kubernetes.default.svc
      namespace: production
    - server: https://kubernetes.default.svc
      namespace: production-db

  # Cluster resources the project can manage
  clusterResourceWhitelist:
    - group: ""
      kind: Namespace

  # Namespace-scoped resources allowed (explicitly deny RBAC)
  namespaceResourceBlacklist:
    - group: rbac.authorization.k8s.io
      kind: Role
    - group: rbac.authorization.k8s.io
      kind: RoleBinding
    - group: rbac.authorization.k8s.io
      kind: ClusterRole
    - group: rbac.authorization.k8s.io
      kind: ClusterRoleBinding

  # Namespace resource whitelist (takes precedence over blacklist)
  namespaceResourceWhitelist:
    - group: "apps"
      kind: Deployment
    - group: "apps"
      kind: StatefulSet
    - group: ""
      kind: Service
    - group: ""
      kind: ConfigMap
    - group: networking.k8s.io
      kind: Ingress
    - group: policy
      kind: PodDisruptionBudget

  # Sync windows: prevent deployments outside approved windows
  syncWindows:
    - kind: allow
      schedule: "0 9 * * 1-5"    # Mon-Fri 9am
      duration: 8h
      applications:
        - "*"
      manualSync: true
    - kind: deny
      schedule: "0 0 * * 5"     # Block Friday 6pm deployments
      duration: 72h
      applications:
        - "critical-*"

  # Require approvals for sync (via ArgoCD notifications + Slack)
  roles:
    - name: developer
      description: "Developers can view and sync non-critical apps"
      policies:
        - p, proj:production:developer, applications, get, production/*, allow
        - p, proj:production:developer, applications, sync, production/*, allow
        - p, proj:production:developer, applications, create, production/*, deny
        - p, proj:production:developer, applications, delete, production/*, deny
      groups:
        - developer-team

    - name: ops
      description: "Ops can perform all operations on production"
      policies:
        - p, proj:production:ops, applications, *, production/*, allow
      groups:
        - sre-team
        - platform-team
```

### 2.4 ArgoCD OIDC Integration with Dex

```yaml
# argocd-cm ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  url: "https://argocd.internal.example.com"
  dex.config: |
    connectors:
      - type: github
        id: github
        name: GitHub
        config:
          clientID: <github-oauth-app-client-id>
          clientSecret: $argocd-secret:dex.github.clientSecret
          orgs:
            - name: example-org
              teams:
                - sre-team
                - developer-team
                - platform-team

  # RBAC policy
  policy.csv: |
    # Developers can view all apps and sync non-production
    p, role:developer, applications, get, */*, allow
    p, role:developer, applications, sync, staging/*, allow
    p, role:developer, applications, sync, dev/*, allow

    # SRE can do everything
    p, role:sre, applications, *, */*, allow
    p, role:sre, clusters, *, *, allow
    p, role:sre, repositories, *, *, allow

    # Map GitHub teams to ArgoCD roles
    g, example-org:developer-team, role:developer
    g, example-org:sre-team, role:sre

  admin.enabled: "false"  # Disable local admin account
  users.anonymous.enabled: "false"
  resource.customizations.ignoreDifferences.apps_StatefulSet: |
    jsonPointers:
      - /spec/volumeClaimTemplates
```

## Section 3: Flux v2 RBAC Hardening

### 3.1 Flux Source Controller Restriction

```yaml
# flux-system-rbac.yaml
# Restrict Flux's source controller to read-only access on specific secrets
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: flux-source-controller-secrets
  namespace: flux-system
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    resourceNames:
      - "github-ssh-key"
      - "registry-credentials"
      - "helm-repo-auth"
    verbs: [get, list, watch]

---
# Flux kustomize controller - per namespace
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: flux-kustomize-controller
  namespace: production
rules:
  - apiGroups: ["apps"]
    resources: [deployments, statefulsets, daemonsets, replicasets]
    verbs: ["*"]
  - apiGroups: [""]
    resources: [services, configmaps, serviceaccounts]
    verbs: ["*"]
  - apiGroups: [networking.k8s.io]
    resources: [ingresses]
    verbs: ["*"]
  # Explicitly NOT granting RBAC, secrets management, etc.
```

### 3.2 Flux Multi-Tenancy with Namespace Isolation

```yaml
# tenant-production.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    toolkit.fluxcd.io/tenant: "team-alpha"
---
# Each tenant gets their own GitRepository and Kustomization
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: team-alpha-production
  namespace: flux-system
spec:
  interval: 1m
  url: "ssh://git@github.com/example-org/team-alpha-production.git"
  ref:
    branch: main
  secretRef:
    name: team-alpha-ssh-key

---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: team-alpha-production
  namespace: flux-system
spec:
  interval: 5m
  path: "./production"
  prune: true
  sourceRef:
    kind: GitRepository
    name: team-alpha-production
  # Run as a specific service account in the target namespace
  serviceAccountName: flux-tenant-team-alpha
  targetNamespace: production
  # Validate against OpenAPI schema
  validation: client
  # Post-build substitutions
  postBuild:
    substitute:
      cluster_name: "production-us-east-1"
      registry: "registry.example.com"
  healthChecks:
    - apiVersion: apps/v1
      kind: Deployment
      name: ".*"
      namespace: production
  timeout: 5m
```

## Section 4: Image Signature Verification with Cosign

### 4.1 Signing Images in CI/CD

```bash
#!/bin/bash
# sign-and-push.sh

set -euo pipefail

IMAGE_REF="$1"
REGISTRY="registry.example.com"
SIGNING_KEY_REF="gcpkms://projects/myproject/locations/global/keyRings/cosign/cryptoKeyVersions/1"

# Build and push
docker build -t "${IMAGE_REF}" .
docker push "${IMAGE_REF}"

# Get the digest
DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' "${IMAGE_REF}")
echo "Image digest: ${DIGEST}"

# Sign with Cosign using KMS key
cosign sign \
  --key "${SIGNING_KEY_REF}" \
  --annotations "git-commit=${GIT_COMMIT}" \
  --annotations "git-branch=${GIT_BRANCH}" \
  --annotations "build-pipeline=${CI_PIPELINE_URL}" \
  --annotations "signed-by=${CI_USER}" \
  --tlog-upload=true \
  "${DIGEST}"

# Attach SBOM
syft "${DIGEST}" -o spdx-json > sbom.json
cosign attach sbom --sbom sbom.json "${DIGEST}"

# Sign the SBOM
cosign sign \
  --key "${SIGNING_KEY_REF}" \
  --attachment sbom \
  "${DIGEST}"

echo "Image signed and SBOM attached: ${DIGEST}"
```

### 4.2 Flux Image Verification with Policy

```yaml
# image-policy.yaml - Flux v2 image signature verification
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: order-service
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: order-service
    namespace: flux-system
  policy:
    semver:
      range: ">=1.0.0"

---
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: order-service
  namespace: flux-system
spec:
  image: "registry.example.com/order-service"
  interval: 5m
  secretRef:
    name: registry-credentials
  # Verify image signatures
  verify:
    provider: cosign
    secretRef:
      name: cosign-pub-key  # contains cosign.pub

---
# cosign-pub-key secret
apiVersion: v1
kind: Secret
metadata:
  name: cosign-pub-key
  namespace: flux-system
type: Opaque
stringData:
  cosign.pub: |
    -----BEGIN PUBLIC KEY-----
    <cosign-public-key-placeholder>
    -----END PUBLIC KEY-----
```

### 4.3 ArgoCD Image Signature Verification via Kyverno

```yaml
# kyverno-verify-image-policy.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-signed-images
  annotations:
    policies.kyverno.io/title: Require Signed Container Images
    policies.kyverno.io/category: Supply Chain Security
    policies.kyverno.io/severity: high
spec:
  validationFailureAction: Enforce
  background: false
  rules:
    - name: check-image-signature
      match:
        any:
          - resources:
              kinds:
                - Pod
              namespaces:
                - production
                - staging
      verifyImages:
        - imageReferences:
            - "registry.example.com/*"
          attestors:
            - count: 1
              entries:
                - keys:
                    publicKeys: |-
                      -----BEGIN PUBLIC KEY-----
                      <cosign-public-key-placeholder>
                      -----END PUBLIC KEY-----
                    rekor:
                      url: https://rekor.sigstore.dev
          attestations:
            - predicateType: https://slsa.dev/provenance/v0.2
              conditions:
                - all:
                    - key: "{{ builder.id }}"
                      operator: Equals
                      value: "https://github.com/example-org/actions/workflows/release.yml"
          mutateDigest: true  # Replace tag with immutable digest
          verifyDigest: true
          required: true
```

## Section 5: OPA Gatekeeper Policy Enforcement

### 5.1 Supply Chain Policies

```yaml
# constraint-template-image-registry.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequiredregistry
spec:
  crd:
    spec:
      names:
        kind: K8sRequiredRegistry
      validation:
        openAPIV3Schema:
          type: object
          properties:
            allowedRegistries:
              type: array
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8srequiredregistry

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          image := container.image
          not starts_with_allowed_registry(image)
          msg := sprintf(
            "Container '%v' uses image from disallowed registry: %v. Allowed: %v",
            [container.name, image, input.parameters.allowedRegistries]
          )
        }

        violation[{"msg": msg}] {
          container := input.review.object.spec.initContainers[_]
          image := container.image
          not starts_with_allowed_registry(image)
          msg := sprintf(
            "Init container '%v' uses image from disallowed registry: %v",
            [container.name, image]
          )
        }

        starts_with_allowed_registry(image) {
          registry := input.parameters.allowedRegistries[_]
          startswith(image, registry)
        }

---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredRegistry
metadata:
  name: production-registry-restriction
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Pod"]
    namespaces:
      - production
      - staging
  parameters:
    allowedRegistries:
      - "registry.example.com/"
      - "123456789012.dkr.ecr.us-east-1.amazonaws.com/"
```

### 5.2 Require Image Digest Pinning

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequiredimagedigest
spec:
  crd:
    spec:
      names:
        kind: K8sRequiredImageDigest
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8srequiredimagedigest

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          not image_has_digest(container.image)
          msg := sprintf(
            "Container '%v' image '%v' must use a digest (@sha256:...) not a tag",
            [container.name, container.image]
          )
        }

        image_has_digest(image) {
          contains(image, "@sha256:")
        }

---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredImageDigest
metadata:
  name: production-require-digest
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Pod"]
    namespaces:
      - production
```

### 5.3 GitOps-Only Deployment Enforcement

```yaml
# Prevent direct kubectl apply to production — only ArgoCD is allowed
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequiregitopslabel
spec:
  crd:
    spec:
      names:
        kind: K8sRequireGitOpsLabel
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8srequiregitopslabel

        violation[{"msg": msg}] {
          # Allow if the request is from an approved GitOps service account
          gitops_sa := {
            "system:serviceaccount:argocd:argocd-application-controller",
            "system:serviceaccount:flux-system:kustomize-controller"
          }
          not gitops_sa[input.review.userInfo.username]
          # Also block system:masters except break-glass users
          not input.review.userInfo.username == "break-glass-admin"
          msg := sprintf(
            "Direct deployments to production are not allowed. Use GitOps. (User: %v)",
            [input.review.userInfo.username]
          )
        }

---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequireGitOpsLabel
metadata:
  name: production-gitops-only
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: ["apps"]
        kinds: ["Deployment", "StatefulSet", "DaemonSet"]
    namespaces:
      - production
```

## Section 6: Audit Trail Architecture

### 6.1 Kubernetes Audit Policy for GitOps Events

```yaml
# audit-policy-gitops.yaml
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
  # Log all ArgoCD and Flux controller actions at RequestResponse level
  - level: RequestResponse
    users:
      - system:serviceaccount:argocd:argocd-application-controller
      - system:serviceaccount:flux-system:kustomize-controller
      - system:serviceaccount:flux-system:helm-controller
    verbs: [create, update, patch, delete]
    resources:
      - group: "apps"
        resources: ["deployments", "statefulsets", "daemonsets"]
      - group: ""
        resources: ["services", "configmaps"]

  # Log all Gatekeeper policy violations
  - level: RequestResponse
    resources:
      - group: constraints.gatekeeper.sh
        resources: ["*"]

  # Log any direct human deployments to production (should be blocked by policy)
  - level: RequestResponse
    verbs: [create, update, patch, delete]
    resources:
      - group: "apps"
        resources: ["deployments", "statefulsets"]
    namespaces:
      - production
      - staging
```

### 6.2 Structured Audit Event Enrichment

```go
// audit_enricher.go - enriches audit events with GitOps context
package auditpipeline

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    auditv1 "k8s.io/apiserver/pkg/apis/audit/v1"
)

type AuditEnricher struct {
    client    kubernetes.Interface
    gitClient GitClient
}

type EnrichedAuditEvent struct {
    *auditv1.Event

    // GitOps context
    GitCommit      string `json:"gitCommit,omitempty"`
    GitBranch      string `json:"gitBranch,omitempty"`
    GitAuthor      string `json:"gitAuthor,omitempty"`
    GitPullRequest string `json:"gitPullRequest,omitempty"`
    GitRepoURL     string `json:"gitRepoURL,omitempty"`

    // Image provenance
    ImageDigest    string `json:"imageDigest,omitempty"`
    ImageSignedBy  string `json:"imageSignedBy,omitempty"`
    ImageBuildTime string `json:"imageBuildTime,omitempty"`

    // Policy context
    PolicyViolations []string `json:"policyViolations,omitempty"`
    PolicyWaivers    []string `json:"policyWaivers,omitempty"`
}

func (e *AuditEnricher) Enrich(ctx context.Context, event *auditv1.Event) (*EnrichedAuditEvent, error) {
    enriched := &EnrichedAuditEvent{Event: event}

    // Extract ArgoCD application context from the user agent
    if isArgoCDAction(event.UserAgent) {
        if err := e.enrichFromArgoCDApp(ctx, enriched); err != nil {
            return enriched, nil // non-fatal
        }
    }

    // Extract Flux context
    if isFluxAction(event.UserAgent) {
        if err := e.enrichFromFluxSource(ctx, enriched); err != nil {
            return enriched, nil
        }
    }

    // Enrich with image provenance from annotations
    if event.ObjectRef != nil && event.ObjectRef.Resource == "pods" {
        e.enrichImageProvenance(ctx, enriched)
    }

    return enriched, nil
}

func (e *AuditEnricher) enrichFromArgoCDApp(ctx context.Context, event *EnrichedAuditEvent) error {
    // Look up the ArgoCD Application that triggered this deployment
    apps, err := e.client.RESTClient().Get().
        AbsPath("/apis/argoproj.io/v1alpha1/namespaces/argocd/applications").
        DoRaw(ctx)
    if err != nil {
        return err
    }

    // Parse and find the matching app by namespace/resource
    // (implementation abbreviated for clarity)
    _ = apps

    return nil
}

func isArgoCDAction(userAgent string) bool {
    return userAgent != "" &&
        (contains(userAgent, "argocd") || contains(userAgent, "argo-controller"))
}

func isFluxAction(userAgent string) bool {
    return userAgent != "" &&
        (contains(userAgent, "kustomize-controller") || contains(userAgent, "helm-controller"))
}

func contains(s, substr string) bool {
    return len(s) >= len(substr) && (s == substr ||
        len(s) > 0 && len(substr) > 0 &&
            (s[:len(substr)] == substr || s[len(s)-len(substr):] == substr))
}
```

### 6.3 Immutable Audit Storage

```yaml
# audit-log-pipeline.yaml
# Falco + Falcosidekick forwards audit events to immutable storage
apiVersion: v1
kind: ConfigMap
metadata:
  name: audit-shipping-config
  namespace: observability
data:
  # Ship audit events to S3 with WORM protection
  vector.toml: |
    [sources.kubernetes_audit]
    type = "file"
    include = ["/var/log/audit/kube-apiserver-audit.log"]
    read_from = "end"
    fingerprint.strategy = "checksum"

    [transforms.parse_audit]
    type = "remap"
    inputs = ["kubernetes_audit"]
    source = '''
    . = parse_json!(.message)
    .ingested_at = now()
    .cluster = "production-us-east-1"
    '''

    [transforms.filter_gitops]
    type = "filter"
    inputs = ["parse_audit"]
    condition = '''
    includes(["argocd-application-controller", "kustomize-controller", "helm-controller"],
             get!(.user.username))
    || exists(.annotations."authorization.k8s.io/decision") &&
       get!(.annotations."authorization.k8s.io/decision") == "deny"
    '''

    [sinks.s3_immutable]
    type = "aws_s3"
    inputs = ["filter_gitops"]
    bucket = "audit-logs-immutable"
    region = "us-east-1"
    key_prefix = "kubernetes/gitops/{{ strftime(now(), \"%Y/%m/%d\") }}/"
    compression = "gzip"
    encoding.codec = "ndjson"
    batch.max_bytes = 50000000
    batch.timeout_secs = 300
    auth.access_key_id = "<aws-access-key-id>"
    auth.secret_access_key = "<aws-secret-access-key-placeholder>"
```

### 6.4 ArgoCD Notification Audit Webhooks

```yaml
# argocd-notifications-cm.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-notifications-cm
  namespace: argocd
data:
  service.webhook.audit-siem: |
    url: https://siem.internal.example.com/api/v1/events
    headers:
    - name: Content-Type
      value: application/json
    - name: X-API-Key
      value: $argocd-notifications-secret:siem-api-key

  template.app-deployed: |
    webhook:
      audit-siem:
        method: POST
        body: |
          {
            "event_type": "gitops_deployment",
            "application": "{{.app.metadata.name}}",
            "project": "{{.app.spec.project}}",
            "source": {
              "repo": "{{.app.spec.source.repoURL}}",
              "path": "{{.app.spec.source.path}}",
              "target_revision": "{{.app.spec.source.targetRevision}}"
            },
            "sync_status": "{{.app.status.sync.status}}",
            "health_status": "{{.app.status.health.status}}",
            "revision": "{{.app.status.sync.revision}}",
            "destination": {
              "server": "{{.app.spec.destination.server}}",
              "namespace": "{{.app.spec.destination.namespace}}"
            },
            "timestamp": "{{now | date \"2006-01-02T15:04:05Z07:00\"}}",
            "operator": "argocd",
            "cluster": "production-us-east-1"
          }

  trigger.on-deployed: |
    - description: Application is synced and healthy
      send:
        - app-deployed
      when: app.status.operationState.phase in ['Succeeded'] and app.status.health.status == 'Healthy'
```

## Section 7: Git Repository Security

### 7.1 Branch Protection Rules

```yaml
# GitHub repository settings (via Terraform)
resource "github_branch_protection" "production" {
  repository_id = github_repository.production_apps.node_id
  pattern       = "main"

  required_status_checks {
    strict = true
    contexts = [
      "policy-validation",
      "image-signature-check",
      "gatekeeper-dry-run",
      "security-scan"
    ]
  }

  required_pull_request_reviews {
    required_approving_review_count = 2
    dismiss_stale_reviews           = true
    require_code_owner_reviews      = true
    require_last_push_approval      = true
  }

  require_signed_commits = true
  require_linear_history = true
  allows_force_pushes    = false
  allows_deletions       = false
}
```

### 7.2 SOPS Secret Encryption

```bash
# Initialize SOPS with AGE key
age-keygen -o age-key.txt
SOPS_AGE_KEY_FILE=age-key.txt

# Encrypt a secret file
sops --encrypt \
  --age <age-public-key-placeholder> \
  --encrypted-regex '^(data|stringData)$' \
  secret.yaml > secret.enc.yaml

# .sops.yaml configuration
cat > .sops.yaml << 'EOF'
creation_rules:
  - path_regex: .*/production/.*\.yaml
    age: <age-public-key-placeholder>
    encrypted_regex: '^(data|stringData)$'
  - path_regex: .*/staging/.*\.yaml
    age: <age-public-key-placeholder-staging>
    encrypted_regex: '^(data|stringData)$'
EOF

# Flux decryption provider
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: production-secrets
  namespace: flux-system
spec:
  decryption:
    provider: sops
    secretRef:
      name: sops-age-key
```

## Section 8: Compliance Reporting

### 8.1 Automated Compliance Report Generation

```bash
#!/bin/bash
# compliance-report.sh

set -euo pipefail

CLUSTER="production-us-east-1"
OUTPUT_DIR="/tmp/compliance-report-$(date +%Y%m%d)"
mkdir -p "$OUTPUT_DIR"

echo "Generating GitOps compliance report for cluster: $CLUSTER"

# 1. Check all production deployments have signed images
echo "=== Image Signature Compliance ===" > "$OUTPUT_DIR/image-compliance.txt"
kubectl get pods -n production -o json | jq -r '
  .items[] |
  .metadata.name as $pod |
  .spec.containers[] |
  select(.image | contains("@sha256:") | not) |
  "UNSIGNED: pod=\($pod) image=\(.image)"
' >> "$OUTPUT_DIR/image-compliance.txt" 2>/dev/null || true

# 2. Check all ArgoCD applications are healthy and synced
echo "=== ArgoCD Application Status ===" > "$OUTPUT_DIR/argocd-status.txt"
argocd app list -o json 2>/dev/null | jq -r '
  .[] |
  select(.spec.project == "production") |
  "\(.metadata.name) sync=\(.status.sync.status) health=\(.status.health.status) revision=\(.status.sync.revision[0:8])"
' >> "$OUTPUT_DIR/argocd-status.txt"

# 3. Check Gatekeeper constraint violations
echo "=== Policy Violations ===" > "$OUTPUT_DIR/policy-violations.txt"
kubectl get constraintviolation -A -o json 2>/dev/null | jq -r '
  .items[] |
  "VIOLATION: \(.metadata.name) resource=\(.status.resourceName) msg=\(.status.message)"
' >> "$OUTPUT_DIR/policy-violations.txt"

# 4. Check for direct (non-GitOps) modifications in the last 24 hours
echo "=== Direct Modification Attempts ===" > "$OUTPUT_DIR/direct-mods.txt"
kubectl get events -n production \
  --field-selector type=Warning \
  -o json | jq -r '
  .items[] |
  select(.reason == "PolicyViolation") |
  "\(.firstTimestamp) \(.message)"
' >> "$OUTPUT_DIR/direct-mods.txt"

# Bundle report
tar -czf "compliance-report-${CLUSTER}-$(date +%Y%m%d).tar.gz" -C "$OUTPUT_DIR" .
echo "Report generated: compliance-report-${CLUSTER}-$(date +%Y%m%d).tar.gz"
```

## Summary

Securing a GitOps pipeline requires defense in depth across all layers of the stack. The key controls deployed in this guide:

- Fine-grained Kubernetes RBAC that prevents ArgoCD and Flux from modifying RBAC, secrets, and cluster-scoped resources they do not own
- ArgoCD AppProjects with namespace and resource whitelists, sync windows, and OIDC integration
- Flux multi-tenancy with per-tenant service accounts and isolated source controllers
- Mandatory image signature verification with Cosign at both the Flux image automation layer and Kyverno admission control
- OPA Gatekeeper policies enforcing approved registries, digest pinning, and GitOps-only deployments
- SOPS-encrypted secrets that can safely reside in Git
- Kubernetes audit policies capturing all GitOps controller actions at RequestResponse level
- Structured audit event shipping to immutable S3 storage for compliance evidence

The combination of preventive controls (policies, signing), detective controls (audit logs, SIEM), and procedural controls (branch protection, required reviews) provides the layered security posture required for SOC2, PCI-DSS, and similar frameworks.
