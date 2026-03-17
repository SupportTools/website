---
title: "Kubernetes OPA Gatekeeper Policies: Constraint Framework for Enterprise Compliance"
date: 2031-01-30T00:00:00-05:00
draft: false
tags: ["Kubernetes", "OPA", "Gatekeeper", "Policy-as-Code", "Compliance", "Rego", "GitOps"]
categories:
- Kubernetes
- Security
- Compliance
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to OPA Gatekeeper: writing ConstraintTemplate Rego policies, replacing PodSecurityPolicy, using audit mode, integrating external data providers, testing with conftest, and managing policy-as-code in GitOps workflows."
more_link: "yes"
url: "/kubernetes-opa-gatekeeper-constraint-framework-enterprise-compliance/"
---

Open Policy Agent (OPA) Gatekeeper is the de facto standard for policy enforcement in Kubernetes after the deprecation of PodSecurityPolicy. When implemented correctly, Gatekeeper transforms compliance from a manual audit exercise into a fully automated, GitOps-driven enforcement layer that prevents non-compliant workloads from ever entering your cluster. This guide covers everything an enterprise team needs — from writing your first ConstraintTemplate to running a full policy-as-code pipeline with conftest and ArgoCD.

<!--more-->

# Kubernetes OPA Gatekeeper Policies: Constraint Framework for Enterprise Compliance

## Section 1: Understanding the Gatekeeper Architecture

Gatekeeper extends Kubernetes through two mechanisms: a validating admission webhook that intercepts API server requests, and a set of Custom Resource Definitions that store policy definitions and audit results.

The architecture has three layers:

1. **ConstraintTemplate** — defines the Rego policy logic and the schema for the Constraint CRD it creates
2. **Constraint** — an instance of the ConstraintTemplate, specifying which resources to match and any parameters
3. **AuditController** — periodically scans existing resources against all active Constraints, reporting violations in `.status.violations`

```
kubectl apply -f ConstraintTemplate  →  Creates new CRD (e.g., K8sRequiredLabels)
kubectl apply -f K8sRequiredLabels   →  Enforcement begins (and audit runs)
```

### Installing Gatekeeper

Use the official Helm chart for production installations. Always pin to a specific version.

```bash
helm repo add gatekeeper https://open-policy-agent.github.io/gatekeeper/charts
helm repo update

helm install gatekeeper gatekeeper/gatekeeper \
  --namespace gatekeeper-system \
  --create-namespace \
  --version 3.17.1 \
  --set replicas=3 \
  --set auditInterval=60 \
  --set constraintViolationsLimit=100 \
  --set audit.matchKinds='[{"apiGroups":["*"],"kinds":["*"]}]' \
  --set logLevel=INFO \
  --set psp.enabled=false
```

Verify the installation:

```bash
kubectl get pods -n gatekeeper-system
# NAME                                             READY   STATUS    RESTARTS
# gatekeeper-audit-7d9b8c6f4-xk2lp                1/1     Running   0
# gatekeeper-controller-manager-6f8b9d7c5-4jqmn   1/1     Running   0
# gatekeeper-controller-manager-6f8b9d7c5-7prsw   1/1     Running   0
# gatekeeper-controller-manager-6f8b9d7c5-9vfxk   1/1     Running   0

kubectl get crd | grep constraints.gatekeeper.sh
```

## Section 2: Writing ConstraintTemplates in Rego

A ConstraintTemplate contains two parts: the OpenAPI schema for the Constraint parameters and the Rego policy logic.

### Basic ConstraintTemplate: Required Labels

```yaml
# templates/k8s-required-labels.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequiredlabels
  annotations:
    metadata.gatekeeper.sh/title: "Required Labels"
    metadata.gatekeeper.sh/version: "1.1.0"
    description: >-
      Requires resources to contain specified labels with values matching
      a provided regular expression.
spec:
  crd:
    spec:
      names:
        kind: K8sRequiredLabels
      validation:
        openAPIV3Schema:
          type: object
          properties:
            message:
              type: string
            labels:
              type: array
              description: A list of labels and allowed regex values.
              items:
                type: object
                properties:
                  key:
                    type: string
                    description: The required label key.
                  allowedRegex:
                    type: string
                    description: If specified, constrains the value to match this regex.
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8srequiredlabels

        violation[{"msg": msg, "details": {"missing_labels": missing}}] {
          provided := {label | input.review.object.metadata.labels[label]}
          required := {label | label := input.parameters.labels[_].key}
          missing := required - provided
          count(missing) > 0
          msg := sprintf("you must provide labels: %v", [missing])
        }

        violation[{"msg": msg}] {
          value := input.review.object.metadata.labels[key]
          expected := input.parameters.labels[_]
          expected.key == key
          expected.allowedRegex != ""
          not re_match(expected.allowedRegex, value)
          msg := sprintf("Label <%v: %v> does not satisfy allowed regex: %v",
            [key, value, expected.allowedRegex])
        }
```

### Advanced ConstraintTemplate: Privileged Container Denial

This template replicates the PodSecurityPolicy privileged container restriction:

```yaml
# templates/k8s-no-privileged-containers.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8snoprivilegedcontainer
  annotations:
    metadata.gatekeeper.sh/title: "No Privileged Containers"
    metadata.gatekeeper.sh/version: "1.0.0"
spec:
  crd:
    spec:
      names:
        kind: K8sNoPrivilegedContainer
      validation:
        openAPIV3Schema:
          type: object
          properties:
            exemptImages:
              description: >-
                Any container that uses an image that matches an entry in this list
                will be excluded from enforcement. Prefix-matching can be signified
                with `*`. For example: `my-exempt-image*` will match
                `my-exempt-image-controller`, `my-exempt-image-1:latest`.
              type: array
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8snoprivilegedcontainer

        import data.lib.exempt_container.is_exempt

        violation[{"msg": msg, "details": {}}] {
          c := input_containers[_]
          not is_exempt(c)
          c.securityContext.privileged
          msg := sprintf("Privileged container is not allowed: %v, securityContext: %v",
            [c.name, c.securityContext])
        }

        input_containers[c] {
          c := input.review.object.spec.containers[_]
        }

        input_containers[c] {
          c := input.review.object.spec.initContainers[_]
        }

        input_containers[c] {
          c := input.review.object.spec.ephemeralContainers[_]
        }
```

### Rego Library Functions

Gatekeeper supports shared Rego libraries via the `libs` field, eliminating code duplication:

```yaml
# templates/lib-exempt-container.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8slibs
spec:
  crd:
    spec:
      names:
        kind: K8sLibs
  targets:
    - target: admission.k8s.gatekeeper.sh
      libs:
        - |
          package lib.exempt_container

          is_exempt(container) {
            exempt_images := object.get(object.get(input, "parameters", {}), "exemptImages", [])
            img := container.image
            exemption := exempt_images[_]
            _matches_exemption(img, exemption)
          }

          _matches_exemption(img, exemption) {
            not endswith(exemption, "*")
            exemption == img
          }

          _matches_exemption(img, exemption) {
            endswith(exemption, "*")
            prefix := trim_suffix(exemption, "*")
            startswith(img, prefix)
          }
```

## Section 3: PSP Replacement Library Constraints

The Gatekeeper policy library at `github.com/open-policy-agent/gatekeeper-library` provides drop-in PSP replacements. Here is a complete PSP replacement configuration:

### Deploying the Full PSP Replacement Suite

```bash
# Clone the library
git clone https://github.com/open-policy-agent/gatekeeper-library.git
cd gatekeeper-library

# Apply all PSP-equivalent templates
kubectl apply -f library/pod-security-policy/
```

Key templates in the library:

| PSP Field | Gatekeeper Template |
|---|---|
| `privileged` | `K8sNoPrivilegedContainer` |
| `hostNetwork/hostPID/hostIPC` | `K8sPSPHostNamespace` |
| `hostPath` | `K8sPSPHostFilesystem` |
| `allowedCapabilities` | `K8sPSPCapabilities` |
| `runAsUser` | `K8sPSPAllowedUsers` |
| `seLinux` | `K8sPSPSELinux` |
| `seccompProfiles` | `K8sPSPSeccomp` |
| `volumes` | `K8sPSPVolumeTypes` |

### Complete Baseline Policy Constraint

```yaml
# constraints/baseline-policy.yaml
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sNoPrivilegedContainer
metadata:
  name: psp-privileged-container
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Pod"]
    excludedNamespaces:
      - kube-system
      - gatekeeper-system
      - cert-manager
  parameters:
    exemptImages:
      - "gcr.io/google_containers/pause*"
      - "registry.k8s.io/pause*"
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sPSPHostNamespace
metadata:
  name: psp-host-namespace
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Pod"]
    excludedNamespaces:
      - kube-system
      - gatekeeper-system
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sPSPCapabilities
metadata:
  name: psp-capabilities
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Pod"]
    excludedNamespaces:
      - kube-system
  parameters:
    allowedCapabilities: []
    requiredDropCapabilities:
      - "ALL"
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sPSPAllowedUsers
metadata:
  name: psp-pods-allowed-user-ranges
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Pod"]
    excludedNamespaces:
      - kube-system
  parameters:
    runAsUser:
      rule: MustRunAsNonRoot
    runAsGroup:
      rule: MustRunAs
      ranges:
        - min: 1
          max: 65535
    supplementalGroups:
      rule: MustRunAs
      ranges:
        - min: 1
          max: 65535
    fsGroup:
      rule: MustRunAs
      ranges:
        - min: 1
          max: 65535
```

## Section 4: Audit Mode vs. Enforcement Mode

Gatekeeper supports three enforcement actions per Constraint:

- **`deny`** — blocks the request at admission time
- **`warn`** — allows the request but surfaces a warning in `kubectl` output
- **`dryrun`** — allows all requests; violations only appear in audit results

### Phased Rollout Strategy

The recommended enterprise approach is to introduce policies in audit before enforcing:

```yaml
# Phase 1: Audit only — observe violations without blocking
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredLabels
metadata:
  name: require-team-label-audit
spec:
  enforcementAction: dryrun    # No blocking
  match:
    kinds:
      - apiGroups: ["apps"]
        kinds: ["Deployment", "StatefulSet", "DaemonSet"]
  parameters:
    message: "All workloads must have a 'team' label"
    labels:
      - key: team
        allowedRegex: "^[a-z][a-z0-9-]{1,30}$"
```

After a settling period, escalate to warn, then deny:

```yaml
# Phase 2: Warn — visible to operators, no blocking
spec:
  enforcementAction: warn

# Phase 3: Deny — full enforcement
spec:
  enforcementAction: deny
```

### Reading Audit Results

```bash
# Check violations for a specific constraint
kubectl describe k8srequiredlabels require-team-label-audit

# Example output excerpt:
# Status:
#   Audit Timestamp:  2031-01-30T12:00:00Z
#   By Pod:
#     Constraint UID:  abc123
#     Enforced:        true
#     Id:              gatekeeper-audit-xxx
#     Observed Generation:  1
#   Total Violations:  14
#   Violations:
#     Enforcement Action:  dryrun
#     Group:               apps
#     Kind:                Deployment
#     Message:             you must provide labels: {"team"}
#     Name:                my-app
#     Namespace:           production

# Export all violations to JSON for reporting
kubectl get constraints -o json | \
  jq '[.items[] | {
    name: .metadata.name,
    kind: .kind,
    violations: .status.violations
  }]' > audit-report.json
```

### Monitoring Constraint Violations with Prometheus

Gatekeeper exposes metrics on port 8888. Configure a ServiceMonitor:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: gatekeeper-metrics
  namespace: gatekeeper-system
spec:
  selector:
    matchLabels:
      app: gatekeeper
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
```

Key metrics to alert on:

```promql
# Total active constraint violations by constraint name
gatekeeper_violations{} > 0

# Admission denial rate over 5 minutes
rate(gatekeeper_request_count_total{status="denied"}[5m]) > 0

# Audit duration (alert if audit takes > 5 minutes)
gatekeeper_audit_duration_seconds > 300
```

## Section 5: External Data Provider Integration

For policies that require data outside the Kubernetes API — such as querying a CMDB, validating image digests against an allowlist, or checking CVE scores — Gatekeeper's External Data Provider framework allows Rego policies to make synchronous HTTP calls during admission.

### External Data Provider Server

The provider is a simple HTTPS server implementing the Gatekeeper ExternalData API:

```go
// main.go
package main

import (
    "crypto/tls"
    "encoding/json"
    "log"
    "net/http"
    "strings"
)

type ExternalDataRequest struct {
    APIVersion string   `json:"apiVersion"`
    Kind       string   `json:"kind"`
    Request    struct {
        Keys []string `json:"keys"`
    } `json:"request"`
}

type ExternalDataResponse struct {
    APIVersion string `json:"apiVersion"`
    Kind       string `json:"kind"`
    Response   struct {
        Idempotent bool              `json:"idempotent"`
        Items      []ResponseItem    `json:"items"`
        SystemError string           `json:"systemError,omitempty"`
    } `json:"response"`
}

type ResponseItem struct {
    Key   string `json:"key"`
    Value string `json:"value"`
    Error string `json:"error,omitempty"`
}

// allowedRegistries is loaded from a configmap/database in production
var allowedRegistries = map[string]bool{
    "registry.company.com":   true,
    "registry.k8s.io":        true,
    "gcr.io/google_containers": true,
}

func validateImages(w http.ResponseWriter, r *http.Request) {
    var req ExternalDataRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, err.Error(), http.StatusBadRequest)
        return
    }

    resp := ExternalDataResponse{
        APIVersion: "externaldata.gatekeeper.sh/v1beta1",
        Kind:       "ProviderResponse",
    }
    resp.Response.Idempotent = true

    for _, key := range req.Request.Keys {
        item := ResponseItem{Key: key}
        registry := extractRegistry(key)
        if allowedRegistries[registry] {
            item.Value = "allowed"
        } else {
            item.Error = "image registry not in approved list: " + registry
        }
        resp.Response.Items = append(resp.Response.Items, item)
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(resp)
}

func extractRegistry(image string) string {
    parts := strings.Split(image, "/")
    if len(parts) > 1 && strings.Contains(parts[0], ".") {
        return parts[0]
    }
    return "docker.io"
}

func main() {
    cert, err := tls.LoadX509KeyPair("/certs/tls.crt", "/certs/tls.key")
    if err != nil {
        log.Fatalf("failed to load TLS certs: %v", err)
    }

    server := &http.Server{
        Addr:    ":8443",
        Handler: http.HandlerFunc(validateImages),
        TLSConfig: &tls.Config{
            Certificates: []tls.Certificate{cert},
            MinVersion:   tls.VersionTLS13,
        },
    }

    log.Println("Starting external data provider on :8443")
    log.Fatal(server.ListenAndServeTLS("", ""))
}
```

### Provider Registration

```yaml
# provider.yaml
apiVersion: externaldata.gatekeeper.sh/v1beta1
kind: Provider
metadata:
  name: image-registry-validator
spec:
  url: https://image-validator.gatekeeper-system.svc:8443/validate
  timeout: 5
  caBundle: <base64-encoded-tls-certificate>
```

### Rego Policy Using External Data

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8sapprovedregistries
spec:
  crd:
    spec:
      names:
        kind: K8sApprovedRegistries
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8sapprovedregistries

        import future.keywords.in

        violation[{"msg": msg}] {
          container := input_containers[_]
          response := external_data({
            "provider": "image-registry-validator",
            "keys": [container.image]
          })
          result := response.items[_]
          result.key == container.image
          result.error != ""
          msg := sprintf("Container %v: %v", [container.name, result.error])
        }

        violation[{"msg": msg}] {
          response := external_data({
            "provider": "image-registry-validator",
            "keys": [input_containers[_].image]
          })
          response.systemError != ""
          msg := sprintf("External data provider error: %v", [response.systemError])
        }

        input_containers[c] {
          c := input.review.object.spec.containers[_]
        }

        input_containers[c] {
          c := input.review.object.spec.initContainers[_]
        }
```

## Section 6: Testing Policies with conftest

Conftest uses OPA/Rego to write tests for configuration files. You can test your Gatekeeper policies locally before committing them.

### Project Structure

```
policies/
├── templates/
│   ├── k8s-required-labels.yaml
│   └── k8s-no-privileged-containers.yaml
├── constraints/
│   ├── require-team-label.yaml
│   └── no-privileged.yaml
├── test/
│   ├── fixtures/
│   │   ├── valid-deployment.yaml
│   │   ├── invalid-no-labels.yaml
│   │   └── invalid-privileged-pod.yaml
│   └── policy_test.rego
└── conftest.yaml
```

### conftest.yaml

```yaml
# conftest.yaml
namespace: main

policy:
  - policies/

data:
  - test/fixtures/

output: tap
```

### Writing conftest Tests

```rego
# test/policy_test.rego
package main

# Test: valid deployment passes required labels check
test_valid_deployment_has_required_labels {
  count(deny) == 0 with input as {
    "review": {
      "object": {
        "kind": "Deployment",
        "metadata": {
          "name": "my-app",
          "namespace": "production",
          "labels": {
            "team": "platform",
            "app": "my-app"
          }
        }
      }
    },
    "parameters": {
      "labels": [{"key": "team", "allowedRegex": "^[a-z][a-z0-9-]{1,30}$"}]
    }
  }
}

# Test: deployment missing team label fails
test_deployment_missing_team_label {
  violations := deny with input as {
    "review": {
      "object": {
        "kind": "Deployment",
        "metadata": {
          "name": "unlabeled-app",
          "namespace": "production",
          "labels": {
            "app": "my-app"
          }
        }
      }
    },
    "parameters": {
      "labels": [{"key": "team", "allowedRegex": ""}]
    }
  }
  count(violations) == 1
}

# Test: privileged container is denied
test_privileged_container_denied {
  violations := deny with input as {
    "review": {
      "object": {
        "kind": "Pod",
        "metadata": {
          "name": "privileged-pod",
          "namespace": "default"
        },
        "spec": {
          "containers": [{
            "name": "test",
            "image": "nginx:latest",
            "securityContext": {
              "privileged": true
            }
          }]
        }
      }
    },
    "parameters": {
      "exemptImages": []
    }
  }
  count(violations) > 0
}

# Test: exempt image bypasses privileged check
test_exempt_image_allowed_when_privileged {
  count(deny) == 0 with input as {
    "review": {
      "object": {
        "kind": "Pod",
        "metadata": {
          "name": "exempt-pod",
          "namespace": "kube-system"
        },
        "spec": {
          "containers": [{
            "name": "pause",
            "image": "registry.k8s.io/pause:3.9",
            "securityContext": {
              "privileged": true
            }
          }]
        }
      }
    },
    "parameters": {
      "exemptImages": ["registry.k8s.io/pause*"]
    }
  }
}
```

### Running Tests

```bash
# Install conftest
curl -L https://github.com/open-policy-agent/conftest/releases/download/v0.56.0/conftest_0.56.0_Linux_x86_64.tar.gz \
  | tar xzf - -C /usr/local/bin conftest

# Run tests against your Rego files
conftest test test/fixtures/ --policy policies/templates/

# Verify actual Kubernetes manifests against constraints
conftest verify --policy policies/

# Test with trace output for debugging
conftest test test/fixtures/invalid-no-labels.yaml \
  --policy policies/templates/ \
  --trace

# Output example:
# PASS - test/fixtures/valid-deployment.yaml - data.k8srequiredlabels.violation
# FAIL - test/fixtures/invalid-no-labels.yaml - data.k8srequiredlabels.violation
#   msg: you must provide labels: {"team"}
```

### CI Pipeline Integration

```yaml
# .github/workflows/policy-tests.yaml
name: Gatekeeper Policy Tests

on:
  pull_request:
    paths:
      - 'policies/**'

jobs:
  test-policies:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install conftest
        run: |
          curl -L https://github.com/open-policy-agent/conftest/releases/download/v0.56.0/conftest_0.56.0_Linux_x86_64.tar.gz \
            | tar xzf - -C /usr/local/bin conftest
          conftest --version

      - name: Run Rego unit tests
        run: |
          conftest verify --policy policies/ --report tap

      - name: Test fixtures against policies
        run: |
          conftest test policies/test/fixtures/ \
            --policy policies/templates/ \
            --output tap

      - name: Validate constraint YAML syntax
        run: |
          conftest test policies/constraints/ \
            --policy policies/meta-policy/ \
            --output json | jq .
```

## Section 7: Managing Policy-as-Code in GitOps

### Repository Structure

```
infra/
└── gatekeeper/
    ├── base/
    │   ├── kustomization.yaml
    │   ├── templates/          # ConstraintTemplates
    │   └── config/             # Gatekeeper Config CRDs
    ├── constraints/
    │   ├── kustomization.yaml
    │   ├── baseline/           # Pod Security Baseline
    │   ├── restricted/         # Pod Security Restricted
    │   └── custom/             # Organization-specific
    └── overlays/
        ├── dev/
        │   └── kustomization.yaml   # enforcementAction: warn
        ├── staging/
        │   └── kustomization.yaml   # enforcementAction: deny
        └── production/
            └── kustomization.yaml   # enforcementAction: deny
```

### Kustomize Overlays for Per-Environment Enforcement

```yaml
# constraints/baseline/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - no-privileged.yaml
  - host-namespace.yaml
  - capabilities.yaml
  - allowed-users.yaml
```

```yaml
# overlays/dev/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

bases:
  - ../../constraints/baseline

patches:
  - patch: |-
      - op: replace
        path: /spec/enforcementAction
        value: warn
    target:
      group: constraints.gatekeeper.sh
      version: v1beta1
```

```yaml
# overlays/production/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

bases:
  - ../../constraints/baseline
  - ../../constraints/restricted
  - ../../constraints/custom

# No patches needed — default is deny
```

### ArgoCD Application for Gatekeeper Policies

```yaml
# argocd/gatekeeper-policies.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: gatekeeper-policies
  namespace: argocd
spec:
  project: infrastructure
  source:
    repoURL: https://github.com/company/infra-policies
    targetRevision: HEAD
    path: infra/gatekeeper/overlays/production
  destination:
    server: https://kubernetes.default.svc
    namespace: gatekeeper-system
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m
  # Ignore audit status fields — they change constantly
  ignoreDifferences:
    - group: constraints.gatekeeper.sh
      kind: "*"
      jsonPointers:
        - /status
```

### Gatekeeper Config: Syncing Resources for Rego Evaluation

For policies that need to reference other Kubernetes resources (e.g., checking if a NetworkPolicy exists), configure the Gatekeeper Config to sync those resources into OPA's data cache:

```yaml
# config/gatekeeper-config.yaml
apiVersion: config.gatekeeper.sh/v1alpha1
kind: Config
metadata:
  name: config
  namespace: gatekeeper-system
spec:
  sync:
    syncOnly:
      - group: ""
        version: "v1"
        kind: "Namespace"
      - group: ""
        version: "v1"
        kind: "Pod"
      - group: "networking.k8s.io"
        version: "v1"
        kind: "NetworkPolicy"
      - group: "apps"
        version: "v1"
        kind: "Deployment"
  validation:
    traces:
      - user: "debug@company.com"
        kind:
          group: ""
          version: "v1"
          kind: "Pod"
```

### Policy Using Synced Data

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequirenetworkpolicy
spec:
  crd:
    spec:
      names:
        kind: K8sRequireNetworkPolicy
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8srequirenetworkpolicy

        violation[{"msg": msg}] {
          input.review.kind.kind == "Namespace"
          ns := input.review.object.metadata.name
          not namespace_has_network_policy(ns)
          msg := sprintf("Namespace %v must have at least one NetworkPolicy", [ns])
        }

        namespace_has_network_policy(ns) {
          # data.inventory.namespace is populated from Config sync
          np := data.inventory.namespace[ns]["networking.k8s.io/v1"]["NetworkPolicy"][_]
          np.metadata.namespace == ns
        }
```

## Section 8: Exemption Patterns and Namespace Scoping

### Namespace-Level Exemptions

Use the `excludedNamespaces` field in Constraint `match` to exempt system namespaces:

```yaml
spec:
  match:
    excludedNamespaces:
      - kube-system
      - kube-public
      - kube-node-lease
      - gatekeeper-system
      - cert-manager
      - monitoring
    namespaceSelector:
      matchExpressions:
        - key: policy.company.com/exempt
          operator: NotIn
          values: ["true"]
```

Label a namespace to exempt it:

```bash
kubectl label namespace legacy-app policy.company.com/exempt=true
```

### Assign Config for Selective Webhook Targeting

```yaml
apiVersion: assign.mutations.gatekeeper.sh/v1alpha1
kind: AssignMetadata
metadata:
  name: add-policy-version-label
spec:
  match:
    scope: Namespaced
    kinds:
      - apiGroups: ["apps"]
        kinds: ["Deployment"]
    excludedNamespaces:
      - kube-system
  location: "metadata.labels.policy-version"
  parameters:
    assign:
      value: "v2"
```

## Section 9: Operational Best Practices

### High Availability Configuration

```yaml
# values for gatekeeper helm chart in production
controller:
  replicas: 3
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app: gatekeeper
              control-plane: controller-manager
          topologyKey: kubernetes.io/hostname
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: DoNotSchedule
      labelSelector:
        matchLabels:
          app: gatekeeper
          control-plane: controller-manager

audit:
  replicas: 1
  auditInterval: 60
  constraintViolationsLimit: 100

# Critical: disable fail-open to ensure the webhook is authoritative
# This means if Gatekeeper is unavailable, ALL requests are denied
# Set to Ignore only during initial rollout
webhook:
  failurePolicy: Fail

# Emergency bypass: temporarily disable enforcement
# kubectl label ns <ns> admission.gatekeeper.sh/ignore=no-self-managing
```

### Debugging Policy Violations

```bash
# Enable trace for a specific user/resource combination
cat <<EOF | kubectl apply -f -
apiVersion: config.gatekeeper.sh/v1alpha1
kind: Config
metadata:
  name: config
  namespace: gatekeeper-system
spec:
  validation:
    traces:
      - user: "system:serviceaccount:production:my-app"
        kind:
          group: ""
          version: "v1"
          kind: "Pod"
EOF

# Attempt the failing operation and check audit log
kubectl logs -n gatekeeper-system -l control-plane=controller-manager \
  | grep "admission" | jq .

# Use the OPA REPL to test policy locally
cat > test-input.json <<EOF
{
  "review": {
    "object": {
      "kind": "Pod",
      "metadata": {"name": "test", "namespace": "default"},
      "spec": {
        "containers": [{
          "name": "app",
          "image": "nginx:latest"
        }]
      }
    }
  },
  "parameters": {
    "labels": [{"key": "team", "allowedRegex": ""}]
  }
}
EOF

opa eval -d policies/templates/k8s-required-labels.rego \
  -i test-input.json \
  'data.k8srequiredlabels.violation'
```

### Constraint Status Monitoring Script

```bash
#!/bin/bash
# check-policy-violations.sh

set -euo pipefail

echo "=== Gatekeeper Policy Violation Summary ==="
echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# Get all constraint kinds
CONSTRAINT_KINDS=$(kubectl get crd -o jsonpath='{.items[*].metadata.name}' \
  | tr ' ' '\n' | grep 'constraints.gatekeeper.sh' \
  | sed 's/.constraints.gatekeeper.sh//')

TOTAL_VIOLATIONS=0

for KIND in $CONSTRAINT_KINDS; do
  CONSTRAINTS=$(kubectl get "$KIND" -o json 2>/dev/null || continue)

  COUNT=$(echo "$CONSTRAINTS" | jq '[.items[].status.totalViolations // 0] | add // 0')
  TOTAL_VIOLATIONS=$((TOTAL_VIOLATIONS + COUNT))

  if [ "$COUNT" -gt 0 ]; then
    echo "[$KIND] Total violations: $COUNT"
    echo "$CONSTRAINTS" | jq -r '
      .items[] |
      select(.status.totalViolations > 0) |
      "  Constraint: " + .metadata.name + " (" + (.status.totalViolations | tostring) + " violations)" +
      "\n  Sample: " + (.status.violations[0].namespace // "cluster") + "/" + .status.violations[0].name
    '
    echo ""
  fi
done

echo "=== Total Active Violations: $TOTAL_VIOLATIONS ==="

if [ "$TOTAL_VIOLATIONS" -gt 0 ]; then
  exit 1
fi
```

## Section 10: Troubleshooting Common Issues

### Issue: Webhook Timeout Causing Deployment Failures

```bash
# Symptom: kubectl apply hangs, then fails with:
# Error from server (InternalError): Internal error occurred: failed calling
# webhook "validation.gatekeeper.sh": Post "https://gatekeeper-webhook-service...":
# context deadline exceeded

# Diagnosis
kubectl describe validatingwebhookconfiguration gatekeeper-validating-webhook-configuration

# Check webhook pods health
kubectl get pods -n gatekeeper-system
kubectl top pods -n gatekeeper-system

# Temporary mitigation: set webhook to Ignore during incident
kubectl patch validatingwebhookconfiguration \
  gatekeeper-validating-webhook-configuration \
  --type='json' \
  -p='[{"op":"replace","path":"/webhooks/0/failurePolicy","value":"Ignore"}]'

# Long-term fix: ensure 3 replicas with proper resource limits
kubectl set resources deployment gatekeeper-controller-manager \
  -n gatekeeper-system \
  --requests=cpu=100m,memory=256Mi \
  --limits=cpu=1000m,memory=512Mi
```

### Issue: ConstraintTemplate Not Creating CRD

```bash
# Symptom: ConstraintTemplate is applied but the CRD doesn't appear
kubectl get constrainttemplate k8srequiredlabels -o yaml | \
  grep -A 20 status

# Common cause: Rego syntax error
# Look for status.byPod[*].errors

kubectl get constrainttemplate k8srequiredlabels \
  -o jsonpath='{.status.byPod[*].errors}' | jq .

# Validate Rego syntax locally before applying
opa check policies/templates/k8s-required-labels.rego
```

### Issue: Audit Not Running

```bash
# Verify audit pod is running and has the Config synced
kubectl logs -n gatekeeper-system \
  -l control-plane=audit-controller --tail=100

# Check if Config resource is healthy
kubectl get config -n gatekeeper-system config -o yaml | \
  grep -A 10 status

# Force immediate audit run by deleting and recreating audit pod
kubectl delete pod -n gatekeeper-system \
  -l control-plane=audit-controller
```

Gatekeeper transforms Kubernetes policy from tribal knowledge into auditable, version-controlled code. The combination of ConstraintTemplates, the policy library, conftest testing, and GitOps delivery gives enterprise teams a repeatable compliance system that scales from a handful of clusters to thousands.
