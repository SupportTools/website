---
title: "Kubernetes OPA Gatekeeper v3.x: Rego Policies, Constraint Templates, Audit Mode, and External Data Providers"
date: 2031-11-04T00:00:00-05:00
draft: false
tags: ["Kubernetes", "OPA", "Gatekeeper", "Policy", "Rego", "Security", "Admission Control", "Compliance"]
categories:
- Kubernetes
- Security
- Policy
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to OPA Gatekeeper v3.x in Kubernetes: writing Rego policies with ConstraintTemplates, deploying constraints for policy enforcement, using audit mode to detect violations in existing resources, and integrating external data providers for dynamic policy decisions."
more_link: "yes"
url: "/kubernetes-opa-gatekeeper-v3-rego-policies-constraint-templates-audit/"
---

OPA Gatekeeper provides policy-as-code enforcement for Kubernetes admission control. Unlike simple webhook validators, Gatekeeper's Rego-based policies can express complex, context-aware constraints that check resource relationships, validate naming conventions, enforce label hierarchies, and consult external data sources. This guide covers production-grade Gatekeeper deployments with emphasis on writing maintainable Rego policies and understanding the audit system for continuous compliance validation.

<!--more-->

# Kubernetes OPA Gatekeeper v3.x: Production Policy Guide

## Gatekeeper Architecture

Gatekeeper operates as a Kubernetes admission webhook with several additional components:

- **Audit controller**: Periodically scans existing cluster resources for policy violations
- **Constraint Framework**: CRD-based policy configuration (no raw webhook configuration needed)
- **ConstraintTemplate**: Defines the Rego policy logic and the CRD schema for constraints
- **Constraint**: An instance of a ConstraintTemplate with specific parameters
- **External Data Provider**: Allows Rego policies to query external services

The admission flow:
1. Resource creation/update triggers webhook call
2. Gatekeeper evaluates all matching constraints
3. Any failing constraint results in policy denial with a helpful message
4. The resource is accepted only if all constraints pass

## Installation

```bash
# Install Gatekeeper v3.x via Helm
helm repo add gatekeeper https://open-policy-agent.github.io/gatekeeper/charts
helm repo update

# Production values
cat > gatekeeper-values.yaml << 'EOF'
replicas: 3

auditInterval: 60
constraintViolationsLimit: 20
auditFromCache: false
disableAudit: false

# Timeout for webhook calls
webhook:
  port: 8443
  timeoutSeconds: 5
  validatingWebhookFailurePolicy: Ignore  # Don't block on webhook failure
  # In strict mode: Fail (blocks admission if webhook unreachable)

resources:
  requests:
    cpu: 100m
    memory: 256Mi
  limits:
    cpu: 1000m
    memory: 512Mi

podDisruptionBudget:
  enabled: true
  minAvailable: 2

affinity:
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchLabels:
            control-plane: controller-manager
        topologyKey: kubernetes.io/hostname
EOF

helm install gatekeeper gatekeeper/gatekeeper \
  --namespace gatekeeper-system \
  --create-namespace \
  --version 3.15.0 \
  --values gatekeeper-values.yaml \
  --wait
```

## Writing Rego Policies

### Rego Fundamentals for Gatekeeper

Rego is a declarative language. For Gatekeeper, you write policies that evaluate to a violation when a constraint is violated:

```rego
# Constraint template structure:
# package: always "k8sconstraint<templatename>"
# violation[{"msg": message, "details": details}]:
#   condition1
#   condition2
#   ...
#   message := sprintf(...)
```

### ConstraintTemplate: Required Labels

```yaml
# ct-required-labels.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequiredlabels
  annotations:
    metadata.gatekeeper.sh/title: "Required Labels"
    metadata.gatekeeper.sh/version: "1.0.2"
    metadata.gatekeeper.sh/requiresSyncData: |
      "[{\"groups\":[\"*\"],\"versions\":[\"*\"],\"kinds\":[\"Namespace\"]}]"
    description: >-
      Requires resources to contain specified labels.
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
              description: A list of labels that must be present.
              type: array
              items:
                type: object
                properties:
                  key:
                    description: The required label key.
                    type: string
                  allowedRegex:
                    description: If set, the label value must match this regex.
                    type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8srequiredlabels

        get_message(parameters, _default) := _default {
          not parameters.message
        }

        get_message(parameters, _default) := parameters.message {
          parameters.message
        }

        violation[{"msg": msg, "details": {"missing_labels": missing}}] {
          provided := {label | input.review.object.metadata.labels[label]}
          required := {label | label := input.parameters.labels[_].key}
          missing := required - provided
          count(missing) > 0
          def_msg := sprintf("you must provide labels: %v", [missing])
          msg := get_message(input.parameters, def_msg)
        }

        violation[{"msg": msg}] {
          value := input.review.object.metadata.labels[key]
          expected := input.parameters.labels[_]
          expected.key == key
          expected.allowedRegex != ""
          not re_match(expected.allowedRegex, value)
          msg := sprintf("Label <%v: %v> does not satisfy allowed regex: %v", [key, value, expected.allowedRegex])
        }
```

### Constraint Instance

```yaml
# constraint-required-labels-production.yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredLabels
metadata:
  name: production-required-labels
spec:
  enforcementAction: deny   # Options: deny, dryrun, warn
  match:
    kinds:
      - apiGroups: ["apps"]
        kinds:
          - Deployment
          - StatefulSet
          - DaemonSet
    namespaceSelector:
      matchLabels:
        environment: production
    excludedNamespaces:
      - kube-system
      - gatekeeper-system
  parameters:
    labels:
      - key: app.kubernetes.io/name
      - key: app.kubernetes.io/version
        allowedRegex: "^v\\d+\\.\\d+\\.\\d+$"  # semver format
      - key: team
        allowedRegex: "^[a-z][a-z0-9-]*$"
      - key: cost-center
```

### Advanced ConstraintTemplate: Container Image Restrictions

```yaml
# ct-allowed-repos.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8sallowedrepos
  annotations:
    description: >-
      Requires container images to come from approved registries.
spec:
  crd:
    spec:
      names:
        kind: K8sAllowedRepos
      validation:
        openAPIV3Schema:
          type: object
          properties:
            repos:
              description: The list of allowed registry prefixes.
              type: array
              items:
                type: string
            exemptContainers:
              description: Container names exempted from this policy.
              type: array
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8sallowedrepos

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          not is_exempt(container)
          not starts_with_allowed_repo(container.image)
          msg := sprintf("Container <%v> uses disallowed image registry <%v>. Allowed: %v",
            [container.name, container.image, input.parameters.repos])
        }

        violation[{"msg": msg}] {
          container := input.review.object.spec.initContainers[_]
          not is_exempt(container)
          not starts_with_allowed_repo(container.image)
          msg := sprintf("Init container <%v> uses disallowed image registry <%v>. Allowed: %v",
            [container.name, container.image, input.parameters.repos])
        }

        violation[{"msg": msg}] {
          container := input.review.object.spec.ephemeralContainers[_]
          not is_exempt(container)
          not starts_with_allowed_repo(container.image)
          msg := sprintf("Ephemeral container <%v> uses disallowed image registry <%v>. Allowed: %v",
            [container.name, container.image, input.parameters.repos])
        }

        is_exempt(container) {
          exempt := input.parameters.exemptContainers[_]
          exempt == container.name
        }

        starts_with_allowed_repo(image) {
          repo := input.parameters.repos[_]
          startswith(image, repo)
        }
```

```yaml
# constraint-allowed-repos.yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sAllowedRepos
metadata:
  name: allowed-repos-production
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: ["*"]
        kinds:
          - Pod
    excludedNamespaces:
      - kube-system
      - gatekeeper-system
      - monitoring
  parameters:
    repos:
      - "registry.example.corp/"
      - "gcr.io/google-containers/"
      - "quay.io/prometheus/"
      - "docker.io/istio/"
    exemptContainers:
      - "istio-init"
      - "istio-proxy"
```

### Resource Limits Policy

```yaml
# ct-container-limits.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8scontainerlimits
  annotations:
    description: >-
      Requires all containers to have CPU and memory limits set.
      Optionally enforces minimum and maximum values.
spec:
  crd:
    spec:
      names:
        kind: K8sContainerLimits
      validation:
        openAPIV3Schema:
          type: object
          properties:
            exemptContainers:
              type: array
              items:
                type: string
            cpu:
              type: object
              properties:
                min:
                  type: string
                max:
                  type: string
            memory:
              type: object
              properties:
                min:
                  type: string
                max:
                  type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      libs:
        - |
          package lib.helpers

          # Parse quantity strings like "100m", "1.5", "2Gi"
          # Returns value in milli-units for CPU, bytes for memory
          missing_limits(container) {
            not container.resources.limits.cpu
          }

          missing_limits(container) {
            not container.resources.limits.memory
          }
      rego: |
        package k8scontainerlimits

        import data.lib.helpers

        violation[{"msg": msg}] {
          container := get_containers[_]
          not is_exempt(container)
          helpers.missing_limits(container)
          msg := sprintf("Container <%v> must have CPU and memory limits set", [container.name])
        }

        violation[{"msg": msg}] {
          container := get_containers[_]
          not is_exempt(container)
          cpu_limit := container.resources.limits.cpu
          not cpu_limit
          msg := sprintf("Container <%v> missing CPU limit", [container.name])
        }

        get_containers[container] {
          container := input.review.object.spec.containers[_]
        }

        get_containers[container] {
          container := input.review.object.spec.initContainers[_]
        }

        is_exempt(container) {
          exempt := input.parameters.exemptContainers[_]
          exempt == container.name
        }
```

### Namespace Label Propagation Policy

Enforce that workload labels match the namespace's team label:

```yaml
# ct-label-sync.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8slabelsync
  annotations:
    metadata.gatekeeper.sh/requiresSyncData: |
      "[{\"groups\":[\"*\"],\"versions\":[\"*\"],\"kinds\":[\"Namespace\"]}]"
spec:
  crd:
    spec:
      names:
        kind: K8sLabelSync
      validation:
        openAPIV3Schema:
          type: object
          properties:
            syncLabel:
              description: The label key that must match between namespace and workload.
              type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8slabelsync

        violation[{"msg": msg}] {
          # Get the namespace object from Gatekeeper's sync cache
          ns := data.inventory.cluster.v1.Namespace[input.review.object.metadata.namespace]

          sync_label := input.parameters.syncLabel

          # Get namespace label value
          ns_label_value := ns.metadata.labels[sync_label]

          # Get workload label value
          workload_label_value := input.review.object.metadata.labels[sync_label]

          # They must match
          ns_label_value != workload_label_value

          msg := sprintf(
            "Workload label <%v=%v> does not match namespace label <%v=%v>",
            [sync_label, workload_label_value, sync_label, ns_label_value]
          )
        }

        violation[{"msg": msg}] {
          ns := data.inventory.cluster.v1.Namespace[input.review.object.metadata.namespace]
          sync_label := input.parameters.syncLabel

          # Namespace has the label but workload doesn't
          ns.metadata.labels[sync_label]
          not input.review.object.metadata.labels[sync_label]

          msg := sprintf(
            "Workload missing required label <%v> which is present on namespace",
            [sync_label]
          )
        }
```

```yaml
# sync-config.yaml - Required for data.inventory to work
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
      - group: "apps"
        version: "v1"
        kind: "Deployment"
  validation:
    traces:
      - user: "system:serviceaccount:monitoring:prometheus"
        kind:
          group: ""
          version: "v1"
          kind: "Pod"
```

## Audit Mode

Audit mode scans existing cluster resources and reports violations without blocking operations. This is essential for:
1. Testing new policies before enabling enforcement
2. Continuous compliance monitoring
3. Detecting resources created before a policy was added

### Using Audit Mode

```yaml
# Start with dryrun mode (logs violations but allows resource)
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredLabels
metadata:
  name: prod-labels-audit
spec:
  enforcementAction: dryrun  # <-- no blocking
  match:
    kinds:
      - apiGroups: ["apps"]
        kinds: ["Deployment"]
  parameters:
    labels:
      - key: team
      - key: cost-center
```

### Reading Audit Results

```bash
# Check audit violations for a specific constraint
kubectl get constraint prod-labels-audit -o yaml | \
  python3 -c "
import sys, yaml
data = yaml.safe_load(sys.stdin)
violations = data.get('status', {}).get('violations', [])
print(f'Total violations: {len(violations)}')
print()
for v in violations[:20]:
    print(f\"  {v['kind']}/{v['namespace']}/{v['name']}: {v['message']}\")
"

# Watch audit results being populated
kubectl get constraints --all-namespaces -o wide

# Get all violations across all constraints
kubectl get constraints -A -o json | python3 -c "
import sys, json
data = json.load(sys.stdin)
total = 0
for item in data.get('items', []):
    violations = item.get('status', {}).get('violations', [])
    count = item.get('status', {}).get('totalViolations', 0)
    name = item['metadata']['name']
    kind = item['kind']
    if count > 0:
        total += count
        print(f'{kind}/{name}: {count} violations')
print(f'\nTotal violations: {total}')
"
```

### Automated Audit Report

```bash
#!/bin/bash
# gatekeeper-audit-report.sh

OUTPUT_FILE="/tmp/gatekeeper-audit-$(date +%Y%m%d).json"

# Collect all constraint violations
kubectl get constraints --all-namespaces -o json > "${OUTPUT_FILE}"

# Generate human-readable report
python3 << PYEOF
import json, datetime

with open('${OUTPUT_FILE}') as f:
    data = json.load(f)

print(f"Gatekeeper Audit Report")
print(f"Generated: {datetime.datetime.now().isoformat()}")
print("=" * 80)

total_violations = 0
critical_constraints = []

for item in sorted(data.get('items', []),
                   key=lambda x: x.get('status', {}).get('totalViolations', 0),
                   reverse=True):
    kind = item['kind']
    name = item['metadata']['name']
    action = item['spec'].get('enforcementAction', 'deny')
    total = item.get('status', {}).get('totalViolations', 0)
    violations = item.get('status', {}).get('violations', [])

    if total == 0:
        continue

    total_violations += total

    print(f"\n{kind}/{name}")
    print(f"  Enforcement: {action}")
    print(f"  Total violations: {total}")

    # Show first 5 violations
    for v in violations[:5]:
        ns = v.get('namespace', 'cluster-scoped')
        print(f"  - {v['kind']}/{ns}/{v['name']}")
        print(f"    {v['message'][:100]}")

    if total > 5:
        print(f"  ... and {total - 5} more")

print("\n" + "=" * 80)
print(f"TOTAL VIOLATIONS: {total_violations}")
PYEOF
```

## External Data Providers

External data providers allow Rego policies to query external services for dynamic data, enabling policies that can't be expressed with static configuration.

### Use Cases

- Checking image vulnerability scan results before admission
- Validating that a service is registered in a service catalog
- Looking up cost center codes from a CMDB
- Checking git repository metadata for compliance attributes

### Provider Implementation

```go
// cmd/gatekeeper-provider/main.go
package main

import (
    "encoding/json"
    "fmt"
    "log/slog"
    "net/http"
    "os"
    "time"
)

// Request structure from Gatekeeper
type ProviderRequest struct {
    APIVersion string          `json:"apiVersion"`
    Kind       string          `json:"kind"`
    Request    ProviderPayload `json:"request"`
}

type ProviderPayload struct {
    Keys []json.RawMessage `json:"keys"`
}

// Response structure expected by Gatekeeper
type ProviderResponse struct {
    APIVersion string         `json:"apiVersion"`
    Kind       string         `json:"kind"`
    Response   ProviderResult `json:"response"`
}

type ProviderResult struct {
    Idempotent bool                      `json:"idempotent"`
    Items      []ProviderItem            `json:"items"`
}

type ProviderItem struct {
    Key   json.RawMessage `json:"key"`
    Value interface{}     `json:"value,omitempty"`
    Error string          `json:"error,omitempty"`
}

// ImageScanResult from a vulnerability scanner
type ImageScanResult struct {
    ImageRef       string   `json:"imageRef"`
    Scanned        bool     `json:"scanned"`
    PassedPolicy   bool     `json:"passedPolicy"`
    CriticalCount  int      `json:"criticalCount"`
    HighCount      int      `json:"highCount"`
    LastScanned    string   `json:"lastScanned"`
}

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

    mux := http.NewServeMux()
    mux.HandleFunc("/validate/image", handleImageValidation)
    mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    })

    srv := &http.Server{
        Addr:         ":8090",
        Handler:      mux,
        ReadTimeout:  5 * time.Second,
        WriteTimeout: 5 * time.Second,
    }

    logger.Info("starting Gatekeeper external data provider", "addr", ":8090")
    if err := srv.ListenAndServeTLS("tls.crt", "tls.key"); err != nil {
        logger.Error("server error", "error", err)
        os.Exit(1)
    }
}

func handleImageValidation(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodPost {
        http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
        return
    }

    var req ProviderRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "invalid request", http.StatusBadRequest)
        return
    }

    items := make([]ProviderItem, 0, len(req.Request.Keys))

    for _, key := range req.Request.Keys {
        var imageRef string
        if err := json.Unmarshal(key, &imageRef); err != nil {
            items = append(items, ProviderItem{
                Key:   key,
                Error: fmt.Sprintf("invalid key: %v", err),
            })
            continue
        }

        // Query your vulnerability scanner API
        result, err := queryVulnerabilityScanner(imageRef)
        if err != nil {
            items = append(items, ProviderItem{
                Key:   key,
                Error: fmt.Sprintf("scanner query failed: %v", err),
            })
            continue
        }

        items = append(items, ProviderItem{
            Key:   key,
            Value: result,
        })
    }

    resp := ProviderResponse{
        APIVersion: "externaldata.gatekeeper.sh/v1alpha1",
        Kind:       "ProviderResponse",
        Response: ProviderResult{
            Idempotent: true,
            Items:      items,
        },
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(resp)
}

func queryVulnerabilityScanner(imageRef string) (*ImageScanResult, error) {
    // In production, query your actual scanner (Trivy, Grype, Anchore, etc.)
    // Example: querying a Trivy server
    client := &http.Client{Timeout: 3 * time.Second}

    resp, err := client.Get(fmt.Sprintf(
        "http://trivy-server.security.svc.cluster.local:4954/scanimage?image=%s",
        imageRef))
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    var result ImageScanResult
    if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
        return nil, err
    }

    return &result, nil
}
```

### Register the Provider

```yaml
# external-data-provider.yaml
apiVersion: externaldata.gatekeeper.sh/v1beta1
kind: Provider
metadata:
  name: vulnerability-scanner
spec:
  url: https://gatekeeper-provider.gatekeeper-system.svc.cluster.local:8090/validate/image
  timeout: 3
  caBundle: |
    -----BEGIN CERTIFICATE-----
    MIIC... (base64 encoded CA cert)
    -----END CERTIFICATE-----
```

### Using External Data in Rego

```yaml
# ct-image-scan-required.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8simagescancompliance
spec:
  crd:
    spec:
      names:
        kind: K8sImageScanCompliance
      validation:
        openAPIV3Schema:
          type: object
          properties:
            maxCritical:
              type: integer
              default: 0
            maxHigh:
              type: integer
              default: 5
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8simagescancompliance

        import future.keywords.if
        import future.keywords.in

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          image := container.image

          # Query external data provider
          response := external_data({
            "provider": "vulnerability-scanner",
            "keys": [image]
          })

          # Check for provider errors
          response.errors[_]
          msg := sprintf("Failed to get scan results for image <%v>: %v",
            [image, response.errors[_].msg])
        }

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          image := container.image

          response := external_data({
            "provider": "vulnerability-scanner",
            "keys": [image]
          })

          # Get scan result for this image
          result := response.items[_]
          result.key == image

          # Check if image was scanned
          not result.value.scanned

          msg := sprintf("Image <%v> has not been scanned for vulnerabilities", [image])
        }

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          image := container.image

          response := external_data({
            "provider": "vulnerability-scanner",
            "keys": [image]
          })

          result := response.items[_]
          result.key == image

          # Check critical vulnerabilities
          result.value.criticalCount > input.parameters.maxCritical

          msg := sprintf(
            "Image <%v> has %v critical vulnerabilities (max allowed: %v)",
            [image, result.value.criticalCount, input.parameters.maxCritical]
          )
        }

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          image := container.image

          response := external_data({
            "provider": "vulnerability-scanner",
            "keys": [image]
          })

          result := response.items[_]
          result.key == image

          # Check high vulnerabilities
          result.value.highCount > input.parameters.maxHigh

          msg := sprintf(
            "Image <%v> has %v high vulnerabilities (max allowed: %v)",
            [image, result.value.highCount, input.parameters.maxHigh]
          )
        }
```

## Testing Rego Policies

### Unit Testing with OPA CLI

```bash
# Install OPA CLI
curl -L -o opa https://openpolicyagent.org/downloads/v0.68.0/opa_linux_amd64_static
chmod +x opa
mv opa /usr/local/bin/

# Policy test file
cat > required_labels_test.rego << 'EOF'
package k8srequiredlabels

test_missing_team_label {
    violation[{"msg": _}] with input as {
        "review": {
            "object": {
                "metadata": {
                    "name": "test-deployment",
                    "namespace": "production",
                    "labels": {
                        "app.kubernetes.io/name": "test-app"
                        # "team" is missing!
                    }
                }
            }
        },
        "parameters": {
            "labels": [
                {"key": "team"},
                {"key": "app.kubernetes.io/name"}
            ]
        }
    }
}

test_all_labels_present {
    not violation[_] with input as {
        "review": {
            "object": {
                "metadata": {
                    "name": "test-deployment",
                    "namespace": "production",
                    "labels": {
                        "team": "platform",
                        "app.kubernetes.io/name": "test-app",
                        "app.kubernetes.io/version": "v1.2.3"
                    }
                }
            }
        },
        "parameters": {
            "labels": [
                {"key": "team"},
                {"key": "app.kubernetes.io/name"},
                {"key": "app.kubernetes.io/version",
                 "allowedRegex": "^v\\d+\\.\\d+\\.\\d+$"}
            ]
        }
    }
}

test_invalid_version_format {
    violation[{"msg": _}] with input as {
        "review": {
            "object": {
                "metadata": {
                    "labels": {
                        "team": "platform",
                        "app.kubernetes.io/name": "test-app",
                        "app.kubernetes.io/version": "1.2.3"  # missing v prefix
                    }
                }
            }
        },
        "parameters": {
            "labels": [
                {"key": "app.kubernetes.io/version",
                 "allowedRegex": "^v\\d+\\.\\d+\\.\\d+$"}
            ]
        }
    }
}
EOF

# Run tests
opa test -v required_labels_test.rego required_labels.rego
```

### Gatekeeper Policy Testing Framework

```bash
# Gatekeeper v3.14+ has built-in unit testing via the Test Suite CRD
cat > test-suite.yaml << 'EOF'
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
# ... template definition ...
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredLabels
# ... constraint ...
---
# Test suite
apiVersion: gatekeeper.sh/v1alpha1
kind: Suite
metadata:
  name: required-labels-tests
spec:
  tests:
    - name: missing-team-label
      template: k8srequiredlabels.yaml
      constraint: constraint-required-labels.yaml
      cases:
        - name: violation-missing-label
          object: test-objects/deployment-missing-team.yaml
          assertions:
            - violations: yes
        - name: no-violation-all-labels
          object: test-objects/deployment-all-labels.yaml
          assertions:
            - violations: no
EOF

# Run Gatekeeper tests
gator test -f test-suite.yaml
```

## Production Operations

### Constraint Status Monitoring

```bash
# Check overall Gatekeeper health
kubectl get pods -n gatekeeper-system
kubectl logs -n gatekeeper-system -l control-plane=controller-manager --tail=50

# List all constraints and their violation counts
kubectl get constraints --all-namespaces -o custom-columns=\
  'NAME:.metadata.name,KIND:.kind,ACTION:.spec.enforcementAction,VIOLATIONS:.status.totalViolations'

# Check audit results
kubectl describe constraint <constraint-name>
```

### Prometheus Metrics

```yaml
# Gatekeeper exposes Prometheus metrics
# Key metrics:
# gatekeeper_violations - Number of constraint violations
# gatekeeper_audit_last_run_time - When the last audit ran
# gatekeeper_request_count_total - Total admission requests processed
# gatekeeper_request_duration_seconds - Admission decision latency

# ServiceMonitor for Prometheus scraping
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: gatekeeper-metrics
  namespace: gatekeeper-system
spec:
  selector:
    matchLabels:
      control-plane: controller-manager
  endpoints:
    - port: metrics
      path: /metrics
      interval: 30s
```

### Alert Rules

```yaml
# prometheusrule-gatekeeper.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: gatekeeper-alerts
  namespace: monitoring
spec:
  groups:
    - name: gatekeeper.policy
      rules:
        - alert: GatekeeperHighViolationCount
          expr: |
            sum(gatekeeper_violations{
              enforcement_action="deny"
            }) by (constraint_kind) > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Active Gatekeeper violations for {{ $labels.constraint_kind }}"
            description: "{{ $value }} violations detected. Review with: kubectl get {{ $labels.constraint_kind }}"

        - alert: GatekeeperAuditStale
          expr: |
            time() - gatekeeper_audit_last_run_time > 600
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Gatekeeper audit has not run in > 10 minutes"

        - alert: GatekeeperHighAdmissionLatency
          expr: |
            histogram_quantile(0.99,
              rate(gatekeeper_request_duration_seconds_bucket[5m])
            ) > 1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Gatekeeper admission webhook P99 latency > 1s"
```

## Policy Library and Reuse

### Shared Rego Libraries

```rego
# lib/kubernetes.rego
# Common Kubernetes utility functions for Gatekeeper policies

package lib.kubernetes

# Get all containers (regular + init + ephemeral)
all_containers[container] {
    container := input.review.object.spec.containers[_]
}

all_containers[container] {
    container := input.review.object.spec.initContainers[_]
}

all_containers[container] {
    container := input.review.object.spec.ephemeralContainers[_]
}

# Check if a workload is a system workload
is_system_workload {
    input.review.object.metadata.namespace == "kube-system"
}

is_system_workload {
    input.review.object.metadata.namespace == "gatekeeper-system"
}

# Get the pod spec regardless of resource type
pod_spec := input.review.object.spec {
    input.review.kind.kind == "Pod"
}

pod_spec := input.review.object.spec.template.spec {
    input.review.kind.kind != "Pod"
}
```

### Constraint Template Library in Git

```
policies/
├── templates/
│   ├── k8srequiredlabels.yaml
│   ├── k8sallowedrepos.yaml
│   ├── k8scontainerlimits.yaml
│   ├── k8simagescancompliance.yaml
│   └── lib/
│       └── kubernetes.rego
├── constraints/
│   ├── production/
│   │   ├── required-labels.yaml
│   │   ├── allowed-repos.yaml
│   │   └── container-limits.yaml
│   └── development/
│       ├── required-labels-dryrun.yaml
│       └── allowed-repos-warn.yaml
└── tests/
    ├── required_labels_test.rego
    └── allowed_repos_test.rego
```

### ArgoCD Application for Policy Management

```yaml
# gatekeeper-policies-app.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: gatekeeper-policies
  namespace: argocd
spec:
  project: security
  source:
    repoURL: https://github.com/example/k8s-policies.git
    targetRevision: main
    path: policies
  destination:
    server: https://kubernetes.default.svc
    namespace: gatekeeper-system
  syncPolicy:
    automated:
      prune: false  # Never auto-delete policies
      selfHeal: true
    syncOptions:
      - CreateNamespace=false
      - ApplyOutOfSyncOnly=true
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m
```

## Conclusion

OPA Gatekeeper provides the policy enforcement layer that enterprises need to maintain security and operational standards across shared Kubernetes infrastructure. The ConstraintTemplate/Constraint pattern enables policy reuse across clusters while allowing environment-specific parameterization. Audit mode makes it possible to introduce new policies without disrupting existing workloads — discover violations first, communicate remediation timelines to teams, then enable enforcement. External data providers elevate policies from static rule evaluation to dynamic, context-aware decisions that integrate with your existing security and compliance toolchain.

The key to successful Gatekeeper adoption is gradual introduction: start all policies in `dryrun` mode, build dashboards showing violation counts, work with teams to remediate existing violations, then flip to `deny` enforcement once violation counts reach acceptable levels. This approach avoids the deployment disruptions that make engineers resist policy enforcement.
