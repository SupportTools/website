---
title: "Operator SDK Scorecard: Testing and Validating Kubernetes Operators"
date: 2027-03-02T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Operator SDK", "Scorecard", "Testing", "Operators"]
categories: ["Kubernetes", "DevOps", "Testing"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Operator SDK Scorecard for testing and validating Kubernetes operators, covering built-in test suites, custom tests, OLM bundle validation, CI/CD integration, and OperatorHub submission requirements."
more_link: "yes"
url: "/scorecard-operator-sdk-testing-kubernetes-guide/"
---

Publishing a Kubernetes operator to **OperatorHub** or distributing it inside an enterprise requires more than functional testing. **Operator SDK Scorecard** provides a structured validation framework that checks operator bundles against Kubernetes best practices, OLM compatibility requirements, and custom organisation policies — all within the operator's bundle image, without modifying the cluster under test.

This guide covers Scorecard's architecture, built-in test suites, custom test development, OLM bundle validation, CI/CD integration, and comparison with kuttl for end-to-end operator testing.

<!--more-->

## Executive Summary

Scorecard runs a configurable set of tests against an OLM bundle and reports structured pass/fail results. Each test executes as a pod inside the target cluster, allowing tests to interact with the live Kubernetes API while remaining isolated from the operator's production workloads.

The key scenarios Scorecard addresses:

- **OLM bundle validation**: Checks that CSV, CRD, and RBAC manifests meet OLM's expectations before submission to OperatorHub
- **Best-practice checks**: Validates that CRD specs include descriptions, that the operator does not request excessive RBAC permissions, and that resources are properly labelled
- **Custom policy enforcement**: Organisation-specific rules (naming conventions, resource limits, security contexts) can be added as custom test images
- **CI gate**: The `operator-sdk scorecard` command returns a non-zero exit code on any failure, making it straightforward to block PRs that introduce bundle regressions

---

## Scorecard Architecture

Scorecard runs as a thin orchestrator that:

1. Reads a `scorecard/config.yaml` from the bundle directory
2. For each configured test stage, creates a pod in the target namespace
3. Passes the bundle contents as a mounted volume into the test pod
4. Collects the pod's stdout (a JSON-encoded `TestStatus` object) after completion
5. Aggregates results across all tests and reports them with pass/fail indicators

```
operator-sdk scorecard
         │
         │  reads
         ▼
 scorecard/config.yaml
         │
         │  for each test
         ▼
 creates Pod in cluster
         │
         │  mounts bundle
         ▼
 Test container runs
   + accesses bundle YAML
   + optionally calls Kubernetes API
         │
         │  stdout = JSON TestStatus
         ▼
 Scorecard collects + formats results
```

Test containers are just container images. The built-in suites ship with Operator SDK. Custom tests are any image that can read bundle files and emit the correct JSON structure.

---

## Bundle Structure

Before running Scorecard, ensure the bundle follows the OLM structure:

```
bundle/
├── metadata/
│   └── annotations.yaml      # bundle metadata (channels, package name)
├── manifests/
│   ├── myoperator.v0.1.0.clusterserviceversion.yaml  # CSV
│   ├── myoperator.crd.yaml                           # CRD(s)
│   └── myoperator-controller-manager_rbac.yaml       # RBAC
└── scorecard/
    └── config.yaml           # Scorecard test configuration
```

Build the bundle image:

```bash
# Generate bundle manifests
operator-sdk generate bundle \
  --input-dir config/ \
  --output-dir bundle/ \
  --package myoperator \
  --channels stable \
  --default-channel stable \
  --version 0.1.0

# Build bundle image
docker build -f bundle.Dockerfile -t registry.example.com/myoperator-bundle:v0.1.0 bundle/
docker push registry.example.com/myoperator-bundle:v0.1.0
```

---

## scorecard/config.yaml Structure

The Scorecard configuration defines **stages** (which run sequentially) and within each stage, **tests** (which run concurrently by default).

```yaml
# bundle/scorecard/config.yaml
apiVersion: scorecard.operatorframework.io/v1alpha3
kind: Configuration
metadata:
  name: config
stages:
  # Stage 1: Basic Kubernetes best practice checks
  - parallel: true
    tests:
      - image: quay.io/operator-framework/scorecard-test:v1.38.0
        entrypoint:
          - scorecard-test
          - basic-check-spec
        labels:
          suite: basic
          test: basic-check-spec

      - image: quay.io/operator-framework/scorecard-test:v1.38.0
        entrypoint:
          - scorecard-test
          - basic-check-status
        labels:
          suite: basic
          test: basic-check-status

  # Stage 2: OLM-specific checks (run after basic checks pass)
  - parallel: true
    tests:
      - image: quay.io/operator-framework/scorecard-test:v1.38.0
        entrypoint:
          - scorecard-test
          - olm-bundle-validation
        labels:
          suite: olm
          test: olm-bundle-validation

      - image: quay.io/operator-framework/scorecard-test:v1.38.0
        entrypoint:
          - scorecard-test
          - olm-crds-have-validation
        labels:
          suite: olm
          test: olm-crds-have-validation

      - image: quay.io/operator-framework/scorecard-test:v1.38.0
        entrypoint:
          - scorecard-test
          - olm-crds-have-resources
        labels:
          suite: olm
          test: olm-crds-have-resources

      - image: quay.io/operator-framework/scorecard-test:v1.38.0
        entrypoint:
          - scorecard-test
          - olm-spec-descriptors
        labels:
          suite: olm
          test: olm-spec-descriptors

      - image: quay.io/operator-framework/scorecard-test:v1.38.0
        entrypoint:
          - scorecard-test
          - olm-status-descriptors
        labels:
          suite: olm
          test: olm-status-descriptors

  # Stage 3: Custom organisation policy checks
  - parallel: true
    tests:
      - image: registry.example.com/scorecard-custom-tests:v1.0.0
        entrypoint:
          - custom-scorecard-test
          - check-resource-limits
        labels:
          suite: custom
          test: check-resource-limits

      - image: registry.example.com/scorecard-custom-tests:v1.0.0
        entrypoint:
          - custom-scorecard-test
          - check-security-context
        labels:
          suite: custom
          test: check-security-context
```

---

## Running Scorecard

### Against a Bundle Directory

```bash
# Run all configured tests against a local bundle directory
operator-sdk scorecard bundle/ \
  --config bundle/scorecard/config.yaml \
  --namespace operator-testing \
  --wait-time 120s

# Output:
# --------------------------------------------------------------------------------
# Image:      quay.io/operator-framework/scorecard-test:v1.38.0
# Entrypoint: [scorecard-test basic-check-spec]
# Labels:
#   "suite":"basic"
#   "test":"basic-check-spec"
# Results:
#   Name: basic-check-spec
#   State: pass
#
# Image:      quay.io/operator-framework/scorecard-test:v1.38.0
# Entrypoint: [scorecard-test olm-bundle-validation]
# Labels:
#   "suite":"olm"
#   "test":"olm-bundle-validation"
# Results:
#   Name: olm-bundle-validation
#   State: pass
```

### Against a Bundle Image

```bash
# Run against a pre-built bundle image
operator-sdk scorecard registry.example.com/myoperator-bundle:v0.1.0 \
  --namespace operator-testing \
  --wait-time 120s \
  --output text
```

### Filtering by Label

```bash
# Run only OLM suite tests
operator-sdk scorecard bundle/ \
  --selector "suite=olm" \
  --namespace operator-testing

# Run a single test
operator-sdk scorecard bundle/ \
  --selector "test=olm-bundle-validation" \
  --namespace operator-testing

# Run all non-custom tests
operator-sdk scorecard bundle/ \
  --selector "suite in (basic, olm)" \
  --namespace operator-testing
```

### JSON Output for CI Parsing

```bash
operator-sdk scorecard bundle/ \
  --output json \
  --namespace operator-testing \
  | tee scorecard-results.json \
  | jq '.items[].status.results[] | select(.state == "fail") | .name'
```

---

## Built-in Test Suites

### Basic Suite

| Test | Checks |
|---|---|
| `basic-check-spec` | Custom resources have a `spec` field; Kubernetes resource creation succeeds |
| `basic-check-status` | Custom resources have a `status` field; status is updated by the controller |

These tests create a CR instance, wait for reconciliation, and verify the spec and status fields are populated. They require the operator to be deployed and running in the test namespace.

### OLM Suite

| Test | Checks |
|---|---|
| `olm-bundle-validation` | Bundle metadata, CSV structure, and annotation format against OLM schema |
| `olm-crds-have-validation` | CRD spec fields have OpenAPI v3 schema validation with descriptions |
| `olm-crds-have-resources` | CSV `owned CRDs` section lists the resources the operator manages |
| `olm-spec-descriptors` | `specDescriptors` in CSV match actual CRD spec fields |
| `olm-status-descriptors` | `statusDescriptors` in CSV match actual CRD status fields |

---

## Interpreting Results

### Pass

```json
{
  "name": "olm-bundle-validation",
  "state": "pass",
  "log": "Validated successfully"
}
```

No action required.

### Fail

```json
{
  "name": "olm-crds-have-validation",
  "state": "fail",
  "errors": [
    "owned CRD 'databases.app.example.com' does not have resources specified",
    "field 'spec.size' missing description in CRD openAPIV3Schema"
  ],
  "suggestions": [
    "Add a 'resources' list to the CSV owned CRDs entry",
    "Add 'description' to each field in the CRD spec validation schema"
  ]
}
```

The `errors` and `suggestions` fields provide actionable remediation steps.

### Pass with Suggestions

```json
{
  "name": "basic-check-spec",
  "state": "pass",
  "suggestions": [
    "Operator may not be compliant with best practices: spec.replicas has no validation constraints"
  ]
}
```

Suggestions do not fail the test but indicate improvement opportunities.

---

## OLM Bundle Validation Deep Dive

### CSV Spec Descriptor Requirements

The CSV (ClusterServiceVersion) must declare `specDescriptors` and `statusDescriptors` that match the CRD schema. This is what surfaces in the OperatorHub UI.

```yaml
# bundle/manifests/myoperator.v0.1.0.clusterserviceversion.yaml (excerpt)
spec:
  customresourcedefinitions:
    owned:
      - name: databases.app.example.com
        version: v1alpha1
        kind: Database
        description: "Manages a PostgreSQL database cluster"
        resources:
          - version: v1
            kind: Deployment
          - version: v1
            kind: Service
          - version: v1
            kind: PersistentVolumeClaim
        specDescriptors:
          - path: size
            description: "Number of database replicas"
            displayName: "Database Size"
            x-descriptors:
              - "urn:alm:descriptor:com.tectonic.ui:number"
          - path: storageClassName
            description: "StorageClass for database PersistentVolumeClaims"
            displayName: "Storage Class"
            x-descriptors:
              - "urn:alm:descriptor:io.kubernetes:StorageClass"
          - path: version
            description: "PostgreSQL version to deploy"
            displayName: "PostgreSQL Version"
            x-descriptors:
              - "urn:alm:descriptor:com.tectonic.ui:select:14"
              - "urn:alm:descriptor:com.tectonic.ui:select:15"
              - "urn:alm:descriptor:com.tectonic.ui:select:16"
        statusDescriptors:
          - path: conditions
            description: "Conditions represent the latest available observations"
            displayName: "Conditions"
            x-descriptors:
              - "urn:alm:descriptor:io.kubernetes.conditions"
          - path: phase
            description: "Current lifecycle phase of the database"
            displayName: "Phase"
            x-descriptors:
              - "urn:alm:descriptor:com.tectonic.ui:text"
```

### CRD Schema Validation

Every CRD spec and status field requires a description and type for `olm-crds-have-validation` to pass:

```yaml
# bundle/manifests/databases.app.example.com_databases.yaml (excerpt)
spec:
  versions:
    - name: v1alpha1
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              description: "DatabaseSpec defines the desired state of Database"
              properties:
                size:
                  type: integer
                  description: "Number of database replicas. Must be 1 (standalone) or 3 (HA)."
                  minimum: 1
                  maximum: 5
                version:
                  type: string
                  description: "PostgreSQL version (14, 15, or 16)"
                  enum: ["14", "15", "16"]
                storageClassName:
                  type: string
                  description: "StorageClass name for PVC provisioning"
              required:
                - size
                - version
            status:
              type: object
              description: "DatabaseStatus defines the observed state of Database"
              properties:
                phase:
                  type: string
                  description: "Current phase: Pending, Running, Degraded, or Failed"
                conditions:
                  type: array
                  description: "Conditions represent the latest available observations"
                  items:
                    type: object
                    properties:
                      type:
                        type: string
                        description: "Condition type"
                      status:
                        type: string
                        description: "Condition status: True, False, or Unknown"
```

---

## Custom Scorecard Tests

### Test Output Format

Custom tests must write a JSON-encoded `TestStatus` object to stdout and exit with code 0 (even on test failure — the failure is communicated through the JSON, not the exit code):

```go
// internal/scorecard/test_output.go
package main

import (
	"encoding/json"
	"fmt"
	"os"

	scapiv1alpha3 "github.com/operator-framework/api/pkg/apis/scorecard/v1alpha3"
	apimanifests "github.com/operator-framework/api/pkg/manifests"
)

func main() {
	// Scorecard passes the bundle path via environment variable
	bundleDir := os.Getenv("SCORECARD_BUNDLE_DIR")
	if bundleDir == "" {
		bundleDir = "/bundle"
	}

	// Load the bundle
	bundle, err := apimanifests.GetBundleFromDir(bundleDir)
	if err != nil {
		writeFailResult("check-resource-limits", fmt.Sprintf("failed to load bundle: %v", err))
		return
	}

	// Run the test
	result := checkResourceLimits(bundle)
	writeResult(result)
}

func checkResourceLimits(bundle *apimanifests.Bundle) scapiv1alpha3.TestResult {
	result := scapiv1alpha3.TestResult{
		Name:  "check-resource-limits",
		State: scapiv1alpha3.PassState,
	}

	csv := bundle.CSV
	if csv == nil {
		result.State = scapiv1alpha3.FailState
		result.Errors = append(result.Errors, "CSV not found in bundle")
		return result
	}

	// Check that all containers in the CSV deployments have resource limits
	for _, depSpec := range csv.Spec.InstallStrategy.StrategySpec.DeploymentSpecs {
		for _, container := range depSpec.Spec.Template.Spec.Containers {
			if container.Resources.Limits == nil {
				result.State = scapiv1alpha3.FailState
				result.Errors = append(result.Errors,
					fmt.Sprintf("container '%s' in deployment '%s' has no resource limits",
						container.Name, depSpec.Name))
			}
		}
	}

	if result.State == scapiv1alpha3.PassState {
		result.Log = "All containers have resource limits defined"
	}

	return result
}

func writeResult(result scapiv1alpha3.TestResult) {
	output := scapiv1alpha3.TestStatus{
		Results: []scapiv1alpha3.TestResult{result},
	}
	data, _ := json.Marshal(output)
	fmt.Println(string(data))
}

func writeFailResult(name, message string) {
	writeResult(scapiv1alpha3.TestResult{
		Name:   name,
		State:  scapiv1alpha3.FailState,
		Errors: []string{message},
	})
}
```

### Custom Test: Security Context Check

```go
func checkSecurityContext(bundle *apimanifests.Bundle) scapiv1alpha3.TestResult {
	result := scapiv1alpha3.TestResult{
		Name:  "check-security-context",
		State: scapiv1alpha3.PassState,
	}

	for _, depSpec := range bundle.CSV.Spec.InstallStrategy.StrategySpec.DeploymentSpecs {
		podSpec := depSpec.Spec.Template.Spec

		// Check pod-level security context
		if podSpec.SecurityContext == nil || podSpec.SecurityContext.RunAsNonRoot == nil ||
			!*podSpec.SecurityContext.RunAsNonRoot {
			result.State = scapiv1alpha3.FailState
			result.Errors = append(result.Errors,
				fmt.Sprintf("deployment '%s': pod securityContext.runAsNonRoot is not set to true",
					depSpec.Name))
		}

		// Check each container
		for _, c := range podSpec.Containers {
			if c.SecurityContext == nil {
				result.State = scapiv1alpha3.FailState
				result.Errors = append(result.Errors,
					fmt.Sprintf("container '%s': no securityContext defined", c.Name))
				continue
			}

			if c.SecurityContext.AllowPrivilegeEscalation == nil ||
				*c.SecurityContext.AllowPrivilegeEscalation {
				result.State = scapiv1alpha3.FailState
				result.Errors = append(result.Errors,
					fmt.Sprintf("container '%s': allowPrivilegeEscalation must be false", c.Name))
			}

			if c.SecurityContext.ReadOnlyRootFilesystem == nil ||
				!*c.SecurityContext.ReadOnlyRootFilesystem {
				result.Suggestions = append(result.Suggestions,
					fmt.Sprintf("container '%s': consider setting readOnlyRootFilesystem: true", c.Name))
			}
		}
	}

	return result
}
```

### Building the Custom Test Image

```dockerfile
# Dockerfile
FROM golang:1.22-alpine AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o /custom-scorecard-test ./cmd/scorecard/

FROM gcr.io/distroless/static:nonroot
COPY --from=builder /custom-scorecard-test /custom-scorecard-test
ENTRYPOINT ["/custom-scorecard-test"]
```

```bash
docker build -t registry.example.com/scorecard-custom-tests:v1.0.0 .
docker push registry.example.com/scorecard-custom-tests:v1.0.0
```

### Dispatching Named Tests from a Single Binary

```go
// cmd/scorecard/main.go
func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: custom-scorecard-test <test-name>")
		os.Exit(1)
	}

	bundleDir := os.Getenv("SCORECARD_BUNDLE_DIR")
	if bundleDir == "" {
		bundleDir = "/bundle"
	}

	bundle, err := apimanifests.GetBundleFromDir(bundleDir)
	if err != nil {
		writeFailResult(os.Args[1], fmt.Sprintf("failed to load bundle: %v", err))
		return
	}

	var result scapiv1alpha3.TestResult
	switch os.Args[1] {
	case "check-resource-limits":
		result = checkResourceLimits(bundle)
	case "check-security-context":
		result = checkSecurityContext(bundle)
	case "check-rbac-permissions":
		result = checkRBACPermissions(bundle)
	default:
		writeFailResult(os.Args[1], fmt.Sprintf("unknown test: %s", os.Args[1]))
		return
	}

	writeResult(result)
}
```

---

## Bundle Image Testing in CI/CD

### GitHub Actions Integration

```yaml
# .github/workflows/scorecard.yaml
name: Operator Scorecard

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  bundle-validate:
    name: Bundle Validation
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: "1.22"

      - name: Install Operator SDK
        run: |
          curl -fsSL https://github.com/operator-framework/operator-sdk/releases/download/v1.38.0/operator-sdk_linux_amd64 \
            -o /usr/local/bin/operator-sdk
          chmod +x /usr/local/bin/operator-sdk

      - name: Generate bundle
        run: |
          make bundle IMG=registry.example.com/myoperator:${{ github.sha }}

      - name: Validate bundle format
        run: operator-sdk bundle validate ./bundle

      - name: Create kind cluster
        uses: helm/kind-action@v1
        with:
          cluster_name: scorecard-test

      - name: Install OLM
        run: operator-sdk olm install --version v0.28.0

      - name: Build and load custom test image
        run: |
          docker build -t registry.example.com/scorecard-custom-tests:ci ./scorecard-tests/
          kind load docker-image registry.example.com/scorecard-custom-tests:ci \
            --name scorecard-test

      - name: Deploy operator for basic tests
        run: |
          make deploy IMG=registry.example.com/myoperator:${{ github.sha }}
          kubectl wait --for=condition=available deployment/myoperator-controller-manager \
            -n myoperator-system --timeout=120s

      - name: Run Scorecard basic suite
        run: |
          operator-sdk scorecard bundle/ \
            --selector "suite=basic" \
            --namespace default \
            --wait-time 120s \
            --output json \
            | tee scorecard-basic.json
          # Fail the step if any test failed
          jq -e '[.items[].status.results[] | select(.state == "fail")] | length == 0' \
            scorecard-basic.json

      - name: Run Scorecard OLM suite
        run: |
          operator-sdk scorecard bundle/ \
            --selector "suite=olm" \
            --namespace default \
            --wait-time 120s \
            --output json \
            | tee scorecard-olm.json
          jq -e '[.items[].status.results[] | select(.state == "fail")] | length == 0' \
            scorecard-olm.json

      - name: Run custom checks
        run: |
          operator-sdk scorecard bundle/ \
            --selector "suite=custom" \
            --namespace default \
            --wait-time 120s \
            --output json \
            | tee scorecard-custom.json
          jq -e '[.items[].status.results[] | select(.state == "fail")] | length == 0' \
            scorecard-custom.json

      - name: Upload scorecard results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: scorecard-results
          path: scorecard-*.json
```

---

## Comparison: Scorecard vs kuttl

**kuttl** (Kubernetes Test Utility) is a declarative end-to-end testing framework. The two tools are complementary rather than competing.

| Dimension | Scorecard | kuttl |
|---|---|---|
| Primary purpose | Bundle validation, OLM compatibility | End-to-end functional operator testing |
| Test definition | Container images with JSON output | YAML test steps |
| OperatorHub requirement | Required for submission | Not required |
| Runtime interaction | Optional (some tests call Kubernetes API) | Full cluster interaction |
| CR lifecycle testing | Basic (creates CR, checks spec/status) | Full (create → update → delete with assertions) |
| Custom test language | Any (Go, Python, shell) | YAML assertions + kubectl/krew plugins |
| CI complexity | Low (single command) | Medium (cluster with operator installed) |
| Test speed | Fast (bundle checks run in seconds) | Slower (requires full reconciliation cycles) |

**Recommended approach**: run Scorecard in CI for bundle validation (fast, lightweight), and kuttl for deep functional testing (slower, requires deployed operator).

### kuttl Test Complement Example

```yaml
# tests/e2e/database-lifecycle/00-install.yaml
apiVersion: kuttl.dev/v1beta1
kind: TestStep
apply:
  - database-cr.yaml
---
# tests/e2e/database-lifecycle/01-assert.yaml
apiVersion: app.example.com/v1alpha1
kind: Database
metadata:
  name: test-db
status:
  phase: Running
---
# tests/e2e/database-lifecycle/02-update.yaml
apiVersion: kuttl.dev/v1beta1
kind: TestStep
apply:
  - database-cr-updated.yaml   # Changes size from 1 to 3
---
# tests/e2e/database-lifecycle/03-assert.yaml
apiVersion: app.example.com/v1alpha1
kind: Database
metadata:
  name: test-db
status:
  phase: Running
spec:
  size: 3
```

```bash
# Run kuttl tests
kubectl kuttl test tests/e2e/ \
  --namespace default \
  --timeout 300
```

---

## OperatorHub Submission Requirements

Before submitting to OperatorHub, all of the following Scorecard checks must pass:

**Basic suite (all tests):**
- `basic-check-spec`
- `basic-check-status`

**OLM suite (all tests):**
- `olm-bundle-validation`
- `olm-crds-have-validation`
- `olm-crds-have-resources`
- `olm-spec-descriptors`
- `olm-status-descriptors`

Additional OperatorHub requirements (verified during PR review, not by Scorecard):

- Operator must support `AllNamespaces`, `SingleNamespace`, or `OwnNamespace` install mode
- CSV must include `metadata.annotations.capabilities` (Basic Install → Full Lifecycle)
- CSV must include `metadata.annotations.containerImage`
- Bundle must be published to a publicly accessible registry
- Operator must not require `cluster-admin` ClusterRole

```yaml
# CSV annotations required for OperatorHub
metadata:
  annotations:
    capabilities: "Full Lifecycle"
    categories: "Database"
    containerImage: "registry.example.com/myoperator:v0.1.0"
    description: "Manages PostgreSQL database clusters on Kubernetes"
    repository: "https://github.com/acme-corp/myoperator"
    support: "Acme Corp"
    alm-examples: |
      [
        {
          "apiVersion": "app.example.com/v1alpha1",
          "kind": "Database",
          "metadata": { "name": "example-db" },
          "spec": { "size": 1, "version": "16" }
        }
      ]
```

---

## Production Operator Validation Checklist

Use this checklist when releasing a new operator version:

### Bundle Structure

```bash
# Validate bundle structure and annotations
operator-sdk bundle validate ./bundle

# Check bundle metadata
cat bundle/metadata/annotations.yaml
# Must contain: operators.operatorframework.io.bundle.package.v1
# Must contain: operators.operatorframework.io.bundle.channels.v1
```

### Scorecard Gates

```bash
# Run full scorecard suite
operator-sdk scorecard bundle/ \
  --namespace operator-testing \
  --wait-time 120s \
  --output json \
  | jq -e '[.items[].status.results[] | select(.state == "fail")] | length == 0'
```

### RBAC Review

```bash
# Inspect all RBAC rules in the bundle
kubectl krew install rbac-lookup 2>/dev/null || true
grep -A50 "rules:" bundle/manifests/*rbac*.yaml

# Ensure no wildcard verbs on cluster-scoped resources
grep -r '"\*"' bundle/manifests/ | grep -v "^Binary"
```

### CRD Validation Coverage

```bash
# Check that all spec fields have descriptions
python3 -c "
import yaml, sys
with open('bundle/manifests/databases.app.example.com_databases.yaml') as f:
    crd = yaml.safe_load(f)
for ver in crd['spec']['versions']:
    schema = ver.get('schema', {}).get('openAPIV3Schema', {})
    props = schema.get('properties', {}).get('spec', {}).get('properties', {})
    missing = [k for k, v in props.items() if 'description' not in v]
    if missing:
        print(f'Missing descriptions: {missing}')
        sys.exit(1)
print('All spec fields have descriptions')
"
```

### Image Security

```bash
# Scan operator and bundle images
trivy image registry.example.com/myoperator:v0.1.0 \
  --exit-code 1 --severity CRITICAL,HIGH

trivy image registry.example.com/myoperator-bundle:v0.1.0 \
  --exit-code 1 --severity CRITICAL,HIGH
```

### Upgrade Path Validation

```bash
# Verify upgrade graph is valid (new version lists previous as replaces)
grep "replaces:" bundle/manifests/*.clusterserviceversion.yaml

# Use operator-framework/community-operators to test upgrade graph
operator-sdk bundle validate ./bundle \
  --select-optional name=operatorhub \
  --optional-values k8s-version=1.29
```

---

## Troubleshooting

### Scorecard Pod Fails to Start

```bash
# Check pod events in the test namespace
kubectl describe pods -l app.kubernetes.io/name=operator-sdk-scorecard -n operator-testing

# Common cause: image pull failure
kubectl get events -n operator-testing --field-selector reason=Failed

# Solution: pre-pull test images or use a local registry
kind load docker-image quay.io/operator-framework/scorecard-test:v1.38.0 --name test-cluster
```

### Test Hangs and Times Out

```bash
# Increase wait-time for slow clusters
operator-sdk scorecard bundle/ --wait-time 300s

# Check if test pod is actually running
kubectl get pods -n operator-testing -w
```

### `olm-bundle-validation` Fails with Schema Error

```bash
# Run OLM bundle validator directly for detailed errors
operator-sdk bundle validate ./bundle \
  --select-optional name=operatorhub \
  2>&1 | head -50

# Most common cause: missing required CSV fields
# Check that spec.description, spec.icon, and spec.maintainers are populated
```

### Custom Test Exits Non-Zero

Custom tests should exit 0 even when tests fail. The failure must be communicated through the JSON output. A non-zero exit causes Scorecard to report the test as errored rather than failed:

```go
// Correct: always exit 0, report failures in JSON
func main() {
	result := runTest()
	writeResult(result)
	os.Exit(0)  // Always exit 0
}
```

### `basic-check-spec` Fails with "No spec field"

The CR instance created by the basic test uses the first example from `alm-examples`. Ensure the example CR has a populated `spec`:

```yaml
# CSV metadata annotation
alm-examples: |
  [
    {
      "apiVersion": "app.example.com/v1alpha1",
      "kind": "Database",
      "metadata": { "name": "example-db" },
      "spec": {
        "size": 1,
        "version": "16"
      }
    }
  ]
```

---

## Summary

Operator SDK Scorecard provides a structured, automatable validation layer for Kubernetes operators that bridges the gap between functional testing and OperatorHub compliance. The built-in basic and OLM test suites catch the most common bundle mistakes — missing CRD descriptions, absent resource declarations, mismatched spec/status descriptors — before they reach reviewers or production clusters.

Custom test images extend Scorecard to organisation-specific policies, giving platform teams a single `operator-sdk scorecard` invocation that validates both community standards and internal requirements. Combined with kuttl for functional end-to-end testing and a CI pipeline that blocks PRs on any Scorecard failure, teams can maintain a consistently high standard of operator quality across versions and releases.
