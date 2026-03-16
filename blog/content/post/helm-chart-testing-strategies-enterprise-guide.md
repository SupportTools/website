---
title: "Helm Chart Testing Strategies: Enterprise Production Validation Guide"
date: 2026-07-29T00:00:00-05:00
draft: false
tags: ["Helm", "Kubernetes", "Testing", "CI/CD", "DevOps", "Quality Assurance"]
categories: ["Kubernetes", "DevOps", "Testing"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive Helm chart testing strategies including unit tests, integration tests, security scanning, and production-ready validation frameworks for enterprise Kubernetes deployments."
more_link: "yes"
url: "/helm-chart-testing-strategies-enterprise-guide/"
---

Master comprehensive Helm chart testing with unit tests, integration tests, security validation, automated testing pipelines, and production-ready quality assurance strategies for enterprise Kubernetes environments.

<!--more-->

# Helm Chart Testing Strategies: Enterprise Production Validation Guide

## Executive Summary

Helm chart testing is critical for ensuring reliable Kubernetes deployments at scale. This comprehensive guide covers enterprise-grade testing strategies including unit testing with helm unittest, integration testing with kind/k3s, security scanning with multiple tools, automated CI/CD pipelines, and production validation frameworks that ensure chart quality before deployment.

## Table of Contents

1. [Testing Philosophy](#testing-philosophy)
2. [Unit Testing with helm-unittest](#unit-testing)
3. [Template Validation](#template-validation)
4. [Integration Testing](#integration-testing)
5. [Security Scanning](#security-scanning)
6. [Chart Linting](#chart-linting)
7. [End-to-End Testing](#e2e-testing)
8. [CI/CD Pipeline Integration](#cicd-integration)
9. [Production Validation](#production-validation)
10. [Best Practices and Patterns](#best-practices)

## Testing Philosophy {#testing-philosophy}

### Testing Pyramid for Helm Charts

```yaml
testing_pyramid:
  unit_tests:
    percentage: 70%
    speed: "Fast (seconds)"
    scope: "Template rendering, values, logic"
    tools: ["helm-unittest", "YAML validation"]

  integration_tests:
    percentage: 20%
    speed: "Medium (minutes)"
    scope: "Chart installation, upgrades, rollbacks"
    tools: ["kind", "k3s", "ct (chart-testing)"]

  e2e_tests:
    percentage: 10%
    speed: "Slow (minutes to hours)"
    scope: "Full application functionality"
    tools: ["Cypress", "Selenium", "custom scripts"]
```

### Test Coverage Goals

```yaml
coverage_requirements:
  template_coverage:
    target: 100%
    includes:
      - All YAML templates
      - Conditional blocks
      - Helper functions
      - Value combinations

  values_coverage:
    target: 95%
    includes:
      - Default values
      - Common configurations
      - Edge cases
      - Invalid inputs

  upgrade_scenarios:
    target: 90%
    includes:
      - Version upgrades
      - Configuration changes
      - Resource modifications
      - Rollback procedures
```

## Unit Testing with helm-unittest {#unit-testing}

### Installation and Setup

```bash
#!/bin/bash
# install-helm-unittest.sh

# Install helm-unittest plugin
helm plugin install https://github.com/helm-unittest/helm-unittest

# Verify installation
helm unittest --help
```

### Basic Unit Test Structure

```yaml
# charts/myapp/tests/deployment_test.yaml
suite: test deployment
templates:
  - deployment.yaml
tests:
  - it: should create a deployment
    asserts:
      - isKind:
          of: Deployment
      - equal:
          path: metadata.name
          value: RELEASE-NAME-myapp

  - it: should use the correct image
    set:
      image.repository: myapp
      image.tag: v1.2.3
    asserts:
      - equal:
          path: spec.template.spec.containers[0].image
          value: myapp:v1.2.3

  - it: should set resource limits
    set:
      resources.limits.cpu: 1000m
      resources.limits.memory: 1Gi
    asserts:
      - equal:
          path: spec.template.spec.containers[0].resources.limits.cpu
          value: 1000m
      - equal:
          path: spec.template.spec.containers[0].resources.limits.memory
          value: 1Gi

  - it: should enable autoscaling when set
    set:
      autoscaling.enabled: true
      autoscaling.minReplicas: 2
      autoscaling.maxReplicas: 10
    asserts:
      - hasDocuments:
          count: 1
      - isKind:
          of: Deployment
```

### Advanced Unit Tests

```yaml
# charts/myapp/tests/advanced_test.yaml
suite: advanced deployment tests
templates:
  - deployment.yaml
  - service.yaml
  - ingress.yaml
tests:
  - it: should configure multiple containers when sidecars enabled
    set:
      sidecars:
        - name: nginx
          image: nginx:1.21
          ports:
            - containerPort: 80
        - name: envoy
          image: envoyproxy/envoy:v1.24
          ports:
            - containerPort: 9901
    asserts:
      - hasDocuments:
          count: 1
      - isKind:
          of: Deployment
      - equal:
          path: spec.template.spec.containers
          value:
            - name: myapp
              image: myapp:latest
            - name: nginx
              image: nginx:1.21
              ports:
                - containerPort: 80
            - name: envoy
              image: envoyproxy/envoy:v1.24
              ports:
                - containerPort: 9901

  - it: should create service with correct type
    template: service.yaml
    set:
      service.type: LoadBalancer
      service.port: 8080
    asserts:
      - equal:
          path: spec.type
          value: LoadBalancer
      - equal:
          path: spec.ports[0].port
          value: 8080

  - it: should configure ingress when enabled
    template: ingress.yaml
    set:
      ingress.enabled: true
      ingress.className: nginx
      ingress.hosts:
        - host: myapp.example.com
          paths:
            - path: /
              pathType: Prefix
    asserts:
      - isKind:
          of: Ingress
      - equal:
          path: spec.ingressClassName
          value: nginx
      - contains:
          path: spec.rules
          content:
            host: myapp.example.com

  - it: should not create ingress when disabled
    template: ingress.yaml
    set:
      ingress.enabled: false
    asserts:
      - hasDocuments:
          count: 0

  - it: should fail with invalid replica count
    set:
      replicaCount: -1
    asserts:
      - failedTemplate:
          errorMessage: "replicaCount must be positive"
```

### Testing Helper Functions

```yaml
# charts/myapp/tests/helpers_test.yaml
suite: test helper functions
templates:
  - deployment.yaml
tests:
  - it: should generate correct fullname
    set:
      nameOverride: "custom-name"
    asserts:
      - matchRegex:
          path: metadata.name
          pattern: ^.*-custom-name$

  - it: should use fullnameOverride when provided
    set:
      fullnameOverride: "completely-custom"
    asserts:
      - equal:
          path: metadata.name
          value: completely-custom

  - it: should include common labels
    asserts:
      - isNotEmpty:
          path: metadata.labels
      - isNotNull:
          path: metadata.labels["app.kubernetes.io/name"]
      - isNotNull:
          path: metadata.labels["app.kubernetes.io/instance"]
      - isNotNull:
          path: metadata.labels["app.kubernetes.io/version"]

  - it: should merge custom labels
    set:
      labels:
        custom-label: custom-value
        environment: production
    asserts:
      - equal:
          path: metadata.labels["custom-label"]
          value: custom-value
      - equal:
          path: metadata.labels.environment
          value: production
```

### Snapshot Testing

```yaml
# charts/myapp/tests/snapshot_test.yaml
suite: snapshot tests
templates:
  - deployment.yaml
tests:
  - it: should match deployment snapshot
    set:
      replicaCount: 3
      image:
        repository: myapp
        tag: v1.2.3
      resources:
        limits:
          cpu: 1000m
          memory: 1Gi
        requests:
          cpu: 500m
          memory: 512Mi
    asserts:
      - matchSnapshot: {}

  - it: should match snapshot with autoscaling
    set:
      autoscaling:
        enabled: true
        minReplicas: 2
        maxReplicas: 10
    asserts:
      - matchSnapshot:
          path: spec
```

## Template Validation {#template-validation}

### Schema Validation

```yaml
# charts/myapp/values.schema.json
{
  "$schema": "https://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["image", "service"],
  "properties": {
    "replicaCount": {
      "type": "integer",
      "minimum": 0,
      "maximum": 100,
      "description": "Number of replicas"
    },
    "image": {
      "type": "object",
      "required": ["repository", "tag"],
      "properties": {
        "repository": {
          "type": "string",
          "pattern": "^[a-z0-9.-]+(/[a-z0-9.-]+)*$"
        },
        "tag": {
          "type": "string",
          "pattern": "^[a-zA-Z0-9._-]+$"
        },
        "pullPolicy": {
          "type": "string",
          "enum": ["Always", "IfNotPresent", "Never"]
        }
      }
    },
    "service": {
      "type": "object",
      "required": ["type", "port"],
      "properties": {
        "type": {
          "type": "string",
          "enum": ["ClusterIP", "NodePort", "LoadBalancer"]
        },
        "port": {
          "type": "integer",
          "minimum": 1,
          "maximum": 65535
        }
      }
    },
    "resources": {
      "type": "object",
      "properties": {
        "limits": {
          "$ref": "#/definitions/resourceList"
        },
        "requests": {
          "$ref": "#/definitions/resourceList"
        }
      }
    },
    "autoscaling": {
      "type": "object",
      "properties": {
        "enabled": {
          "type": "boolean"
        },
        "minReplicas": {
          "type": "integer",
          "minimum": 1
        },
        "maxReplicas": {
          "type": "integer",
          "minimum": 1
        },
        "targetCPUUtilizationPercentage": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100
        }
      }
    }
  },
  "definitions": {
    "resourceList": {
      "type": "object",
      "properties": {
        "cpu": {
          "type": "string",
          "pattern": "^[0-9]+m?$"
        },
        "memory": {
          "type": "string",
          "pattern": "^[0-9]+(Mi|Gi)$"
        }
      }
    }
  }
}
```

### Validation Script

```bash
#!/bin/bash
# validate-chart.sh - Comprehensive chart validation

set -euo pipefail

export CHART_DIR="${1:-.}"
export VALUES_FILE="${2:-values.yaml}"

echo "=== Helm Chart Validation ==="

# Test 1: Helm lint
echo -e "\n--- Helm Lint ---"
helm lint "$CHART_DIR" --values "$CHART_DIR/$VALUES_FILE" --strict

# Test 2: Template rendering
echo -e "\n--- Template Rendering ---"
helm template test "$CHART_DIR" --values "$CHART_DIR/$VALUES_FILE" > /tmp/rendered.yaml

# Test 3: YAML validation
echo -e "\n--- YAML Validation ---"
yamllint /tmp/rendered.yaml

# Test 4: Kubernetes schema validation
echo -e "\n--- Kubernetes Schema Validation ---"
kubeval --strict --kubernetes-version 1.28.0 /tmp/rendered.yaml

# Test 5: Values schema validation
echo -e "\n--- Values Schema Validation ---"
if [ -f "$CHART_DIR/values.schema.json" ]; then
  helm lint "$CHART_DIR" --values "$CHART_DIR/$VALUES_FILE"
  echo "✓ Values schema validation passed"
else
  echo "⚠ No values.schema.json found"
fi

# Test 6: Chart version validation
echo -e "\n--- Chart Version Validation ---"
chart_version=$(yq eval '.version' "$CHART_DIR/Chart.yaml")
app_version=$(yq eval '.appVersion' "$CHART_DIR/Chart.yaml")

if [[ ! "$chart_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "✗ Invalid chart version: $chart_version"
  exit 1
fi

echo "✓ Chart version: $chart_version"
echo "✓ App version: $app_version"

# Test 7: Required files check
echo -e "\n--- Required Files Check ---"
required_files=(
  "Chart.yaml"
  "values.yaml"
  "README.md"
  "templates/NOTES.txt"
)

for file in "${required_files[@]}"; do
  if [ -f "$CHART_DIR/$file" ]; then
    echo "✓ $file exists"
  else
    echo "✗ $file missing"
    exit 1
  fi
done

echo -e "\n✓ All validation checks passed"
```

## Integration Testing {#integration-testing}

### Chart Testing with ct (chart-testing)

```bash
#!/bin/bash
# install-ct.sh - Install chart-testing tool

# Install ct
curl -sSL https://github.com/helm/chart-testing/releases/download/v3.10.0/chart-testing_3.10.0_linux_amd64.tar.gz | \
  tar xz -C /usr/local/bin ct

# Configure ct
mkdir -p ~/.ct
cat > ~/.ct/ct.yaml <<EOF
remote: origin
target-branch: main
chart-dirs:
  - charts
chart-repos:
  - bitnami=https://charts.bitnami.com/bitnami
helm-extra-args: --timeout 600s
check-version-increment: true
debug: true
EOF
```

```yaml
# ct.yaml - Chart testing configuration
remote: origin
target-branch: main
chart-dirs:
  - charts
chart-repos:
  - bitnami=https://charts.bitnami.com/bitnami
  - prometheus-community=https://prometheus-community.github.io/helm-charts
helm-extra-args: --timeout 600s
check-version-increment: true
validate-maintainers: true
validate-chart-schema: true
validate-yaml: true
debug: true

# Linting configuration
lint-conf: lintconf.yaml

# Test value files
test-value-files:
  - test-values.yaml
  - production-values.yaml
```

```bash
#!/bin/bash
# run-chart-tests.sh - Run chart-testing

set -euo pipefail

echo "=== Chart Testing with ct ==="

# Create kind cluster
echo -e "\n--- Creating kind cluster ---"
kind create cluster --name chart-testing --wait 5m

# Install dependencies
echo -e "\n--- Installing chart dependencies ---"
ct install --charts charts/myapp \
  --helm-extra-args "--timeout 10m" \
  --debug

# Cleanup
kind delete cluster --name chart-testing
```

### Integration Tests with Kind

```bash
#!/bin/bash
# integration-test-kind.sh - Full integration test with kind

set -euo pipefail

export CLUSTER_NAME="helm-test-$$"
export CHART_DIR="charts/myapp"
export NAMESPACE="test"

cleanup() {
  echo "Cleaning up..."
  kind delete cluster --name "$CLUSTER_NAME" || true
}
trap cleanup EXIT

echo "=== Helm Chart Integration Tests ==="

# Create kind cluster
echo -e "\n--- Creating kind cluster ---"
cat <<EOF | kind create cluster --name "$CLUSTER_NAME" --config=-
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
- role: control-plane
  kubeadmConfigPatches:
  - |
    kind: InitConfiguration
    nodeRegistration:
      kubeletExtraArgs:
        node-labels: "ingress-ready=true"
  extraPortMappings:
  - containerPort: 80
    hostPort: 80
    protocol: TCP
  - containerPort: 443
    hostPort: 443
    protocol: TCP
- role: worker
- role: worker
EOF

# Wait for cluster to be ready
kubectl wait --for=condition=Ready nodes --all --timeout=300s

# Create namespace
kubectl create namespace "$NAMESPACE"

# Test 1: Install chart
echo -e "\n--- Test 1: Installing chart ---"
helm install myapp "$CHART_DIR" \
  --namespace "$NAMESPACE" \
  --wait \
  --timeout 5m \
  --set image.tag=test

# Verify installation
kubectl get all -n "$NAMESPACE"

# Test 2: Check pod status
echo -e "\n--- Test 2: Checking pod status ---"
kubectl wait --for=condition=Ready pods \
  --selector app.kubernetes.io/name=myapp \
  --namespace "$NAMESPACE" \
  --timeout=300s

# Test 3: Service connectivity
echo -e "\n--- Test 3: Testing service connectivity ---"
kubectl run curl-test \
  --image=curlimages/curl:latest \
  --namespace "$NAMESPACE" \
  --rm -it --restart=Never \
  -- curl -f http://myapp-service:8080/health

# Test 4: Upgrade chart
echo -e "\n--- Test 4: Upgrading chart ---"
helm upgrade myapp "$CHART_DIR" \
  --namespace "$NAMESPACE" \
  --wait \
  --timeout 5m \
  --set replicaCount=3 \
  --set image.tag=test-v2

# Verify upgrade
kubectl rollout status deployment/myapp -n "$NAMESPACE"

# Test 5: Rollback
echo -e "\n--- Test 5: Rolling back ---"
helm rollback myapp --namespace "$NAMESPACE" --wait

# Verify rollback
kubectl rollout status deployment/myapp -n "$NAMESPACE"

# Test 6: Uninstall
echo -e "\n--- Test 6: Uninstalling chart ---"
helm uninstall myapp --namespace "$NAMESPACE" --wait

# Verify uninstall
if kubectl get deployment myapp -n "$NAMESPACE" 2>/dev/null; then
  echo "✗ Deployment still exists after uninstall"
  exit 1
else
  echo "✓ Deployment successfully removed"
fi

echo -e "\n✓ All integration tests passed"
```

## Security Scanning {#security-scanning}

### Multi-Tool Security Pipeline

```bash
#!/bin/bash
# security-scan.sh - Comprehensive security scanning

set -euo pipefail

export CHART_DIR="${1:-.}"
export OUTPUT_DIR="security-reports"

mkdir -p "$OUTPUT_DIR"

echo "=== Helm Chart Security Scanning ==="

# Render templates
helm template test "$CHART_DIR" > "$OUTPUT_DIR/rendered.yaml"

# Scan 1: Kubesec
echo -e "\n--- Kubesec Scan ---"
kubesec scan "$OUTPUT_DIR/rendered.yaml" > "$OUTPUT_DIR/kubesec-report.json"

score=$(jq '[.[].score] | add / length' "$OUTPUT_DIR/kubesec-report.json")
echo "Kubesec score: $score"

if (( $(echo "$score < 5" | bc -l) )); then
  echo "✗ Kubesec score too low"
  jq '.[] | select(.score < 5) | .scoring.advise' "$OUTPUT_DIR/kubesec-report.json"
  exit 1
fi

# Scan 2: Checkov
echo -e "\n--- Checkov Scan ---"
checkov -f "$OUTPUT_DIR/rendered.yaml" \
  --framework kubernetes \
  --output json \
  --output-file "$OUTPUT_DIR/checkov-report.json"

# Scan 3: Polaris
echo -e "\n--- Polaris Scan ---"
polaris audit --audit-path "$OUTPUT_DIR/rendered.yaml" \
  --format json \
  --output-file "$OUTPUT_DIR/polaris-report.json"

# Scan 4: Trivy
echo -e "\n--- Trivy Configuration Scan ---"
trivy config "$CHART_DIR" \
  --format json \
  --output "$OUTPUT_DIR/trivy-config-report.json"

# Extract image names and scan
echo -e "\n--- Trivy Image Scan ---"
images=$(yq eval '.. | select(has("image")) | .image' "$OUTPUT_DIR/rendered.yaml" | sort -u)

for image in $images; do
  echo "Scanning image: $image"
  trivy image "$image" \
    --severity HIGH,CRITICAL \
    --format json \
    --output "$OUTPUT_DIR/trivy-$(echo $image | tr '/:' '-')-report.json"
done

# Scan 5: Snyk
echo -e "\n--- Snyk Scan ---"
snyk iac test "$OUTPUT_DIR/rendered.yaml" \
  --json \
  --json-file-output="$OUTPUT_DIR/snyk-report.json" || true

# Generate summary report
echo -e "\n--- Security Scan Summary ---"
cat > "$OUTPUT_DIR/summary.md" <<EOF
# Security Scan Summary

## Kubesec
Score: $(jq '[.[].score] | add / length' "$OUTPUT_DIR/kubesec-report.json")

## Checkov
- Passed: $(jq '.summary.passed' "$OUTPUT_DIR/checkov-report.json")
- Failed: $(jq '.summary.failed' "$OUTPUT_DIR/checkov-report.json")
- Skipped: $(jq '.summary.skipped' "$OUTPUT_DIR/checkov-report.json")

## Polaris
- Score: $(jq '.score' "$OUTPUT_DIR/polaris-report.json")

## Trivy
- Config Issues: $(jq '[.Results[].Misconfigurations[]? | select(.Severity == "HIGH" or .Severity == "CRITICAL")] | length' "$OUTPUT_DIR/trivy-config-report.json")

## Snyk
- Issues: $(jq '[.infrastructureAsCodeIssues[]? | select(.severity == "high" or .severity == "critical")] | length' "$OUTPUT_DIR/snyk-report.json" || echo "0")
EOF

cat "$OUTPUT_DIR/summary.md"

echo -e "\n✓ Security scanning complete"
echo "Reports saved to $OUTPUT_DIR/"
```

### OPA Policy Validation

```rego
# policies/helm-chart.rego
package helm

# Deny if container runs as root
deny[msg] {
  input.kind == "Deployment"
  container := input.spec.template.spec.containers[_]
  not container.securityContext.runAsNonRoot
  msg = sprintf("Container %s must run as non-root", [container.name])
}

# Deny if no resource limits
deny[msg] {
  input.kind == "Deployment"
  container := input.spec.template.spec.containers[_]
  not container.resources.limits
  msg = sprintf("Container %s must have resource limits", [container.name])
}

# Deny if using latest tag
deny[msg] {
  input.kind == "Deployment"
  container := input.spec.template.spec.containers[_]
  endswith(container.image, ":latest")
  msg = sprintf("Container %s uses 'latest' tag", [container.name])
}

# Deny if no readiness probe
deny[msg] {
  input.kind == "Deployment"
  container := input.spec.template.spec.containers[_]
  not container.readinessProbe
  msg = sprintf("Container %s must have readiness probe", [container.name])
}

# Deny if service type is LoadBalancer without annotation
deny[msg] {
  input.kind == "Service"
  input.spec.type == "LoadBalancer"
  not input.metadata.annotations["service.beta.kubernetes.io/aws-load-balancer-internal"]
  msg = "LoadBalancer service must specify internal annotation"
}

# Warn if no pod disruption budget for production
warn[msg] {
  input.kind == "Deployment"
  input.metadata.labels.environment == "production"
  count([x | x := data.kubernetes.poddisruptionbudgets[_]; x.spec.selector.matchLabels.app == input.metadata.labels.app]) == 0
  msg = "Production deployment should have PodDisruptionBudget"
}
```

## Chart Linting {#chart-linting}

### Custom Linting Rules

```yaml
# lintconf.yaml - Custom linting configuration
rules:
  # Chart.yaml rules
  chart-yaml-version-gt-zero:
    severity: error
  chart-yaml-app-version-gt-zero:
    severity: warning

  # Template rules
  template-valid-yaml:
    severity: error
  template-has-namespace:
    severity: warning
  template-has-required-labels:
    severity: error
    labels:
      - app.kubernetes.io/name
      - app.kubernetes.io/instance
      - app.kubernetes.io/version
      - app.kubernetes.io/managed-by

  # Values rules
  values-valid-schema:
    severity: error
  values-has-description:
    severity: warning

  # Best practices
  container-image-has-tag:
    severity: error
  container-has-resource-limits:
    severity: error
  container-has-liveness-probe:
    severity: warning
  container-has-readiness-probe:
    severity: error

# Exclude patterns
exclude:
  - "*/tests/*"
  - "*/templates/NOTES.txt"
```

## End-to-End Testing {#e2e-testing}

### Application E2E Tests

```typescript
// e2e/helm-chart.spec.ts
import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';

test.describe('Helm Chart E2E Tests', () => {
  let baseUrl: string;

  test.beforeAll(async () => {
    // Install chart
    execSync(`
      helm install myapp ./charts/myapp \
        --namespace test \
        --create-namespace \
        --wait \
        --timeout 5m
    `);

    // Get service URL
    baseUrl = execSync(`
      kubectl get svc myapp-service -n test \
        -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
    `).toString().trim();
  });

  test.afterAll(async () => {
    // Cleanup
    execSync('helm uninstall myapp --namespace test');
    execSync('kubectl delete namespace test');
  });

  test('application should be accessible', async ({ page }) => {
    await page.goto(`http://${baseUrl}`);
    await expect(page).toHaveTitle(/My Application/);
  });

  test('health endpoint should return 200', async ({ request }) => {
    const response = await request.get(`http://${baseUrl}/health`);
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.status).toBe('healthy');
  });

  test('metrics endpoint should expose prometheus metrics', async ({ request }) => {
    const response = await request.get(`http://${baseUrl}/metrics`);
    expect(response.status()).toBe(200);

    const text = await response.text();
    expect(text).toContain('http_requests_total');
  });

  test('should handle load correctly', async ({ page }) => {
    // Send concurrent requests
    const promises = Array.from({ length: 100 }, (_, i) =>
      page.goto(`http://${baseUrl}/api/items/${i}`)
    );

    await Promise.all(promises);

    // Check all succeeded
    promises.forEach(async (p) => {
      const response = await p;
      expect(response.status()).toBeLessThan(500);
    });
  });

  test('should scale under load', async () => {
    // Get initial replica count
    const initialReplicas = parseInt(
      execSync(`
        kubectl get deployment myapp -n test \
          -o jsonpath='{.spec.replicas}'
      `).toString()
    );

    // Generate load
    execSync(`
      kubectl run load-generator \
        --image=williamyeh/hey:latest \
        --namespace=test \
        --restart=Never \
        -- -z 60s -c 100 http://myapp-service:8080/
    `);

    // Wait for scaling
    await new Promise(resolve => setTimeout(resolve, 90000));

    // Check replica count increased
    const finalReplicas = parseInt(
      execSync(`
        kubectl get deployment myapp -n test \
          -o jsonpath='{.spec.replicas}'
      `).toString()
    );

    expect(finalReplicas).toBeGreaterThan(initialReplicas);

    // Cleanup
    execSync('kubectl delete pod load-generator -n test');
  });
});
```

## CI/CD Pipeline Integration {#cicd-integration}

### GitLab CI Pipeline

```yaml
# .gitlab-ci.yml
variables:
  CHART_DIR: charts/myapp
  K8S_VERSION: 1.28.0

stages:
  - lint
  - test
  - security
  - package
  - publish

lint:helm:
  stage: lint
  image: alpine/helm:latest
  script:
    - helm lint $CHART_DIR --strict
    - helm lint $CHART_DIR --values $CHART_DIR/values.yaml
  only:
    changes:
      - charts/**/*

lint:yaml:
  stage: lint
  image: cytopia/yamllint:latest
  script:
    - yamllint $CHART_DIR
  only:
    changes:
      - charts/**/*

test:unit:
  stage: test
  image: alpine/helm:latest
  before_script:
    - helm plugin install https://github.com/helm-unittest/helm-unittest
  script:
    - helm unittest $CHART_DIR --color --output-type JUnit --output-file test-results.xml
  artifacts:
    reports:
      junit: test-results.xml
  only:
    changes:
      - charts/**/*

test:integration:
  stage: test
  image: ghcr.io/helm/chart-testing:v3.10.0
  services:
    - docker:dind
  variables:
    DOCKER_HOST: tcp://docker:2375
  before_script:
    - apk add --no-cache curl
    - curl -Lo kind https://kind.sigs.k8s.io/dl/v0.20.0/kind-linux-amd64
    - chmod +x kind && mv kind /usr/local/bin/
  script:
    - kind create cluster --name test --wait 5m
    - ct install --charts $CHART_DIR --debug
    - kind delete cluster --name test
  only:
    changes:
      - charts/**/*

security:scan:
  stage: security
  image: aquasec/trivy:latest
  script:
    - helm template test $CHART_DIR > rendered.yaml
    - trivy config rendered.yaml --severity HIGH,CRITICAL --exit-code 1
    - trivy config $CHART_DIR --format json --output trivy-report.json
  artifacts:
    reports:
      container_scanning: trivy-report.json
  only:
    changes:
      - charts/**/*

security:kubesec:
  stage: security
  image: kubesec/kubesec:v2
  script:
    - helm template test $CHART_DIR > rendered.yaml
    - kubesec scan rendered.yaml --json > kubesec-report.json
    - |
      SCORE=$(jq '[.[].score] | add / length' kubesec-report.json)
      if (( $(echo "$SCORE < 5" | bc -l) )); then
        echo "Kubesec score $SCORE is below threshold"
        exit 1
      fi
  artifacts:
    paths:
      - kubesec-report.json
  only:
    changes:
      - charts/**/*

package:chart:
  stage: package
  image: alpine/helm:latest
  script:
    - helm package $CHART_DIR --destination .
    - helm repo index . --url https://charts.example.com
  artifacts:
    paths:
      - "*.tgz"
      - index.yaml
  only:
    - tags

publish:chart:
  stage: publish
  image: alpine/helm:latest
  script:
    - helm plugin install https://github.com/chartmuseum/helm-push
    - helm cm-push *.tgz chartmuseum
  only:
    - tags
  dependencies:
    - package:chart
```

### GitHub Actions Workflow

```yaml
# .github/workflows/helm-test.yaml
name: Helm Chart Testing

on:
  pull_request:
    paths:
      - 'charts/**'
  push:
    branches:
      - main
    paths:
      - 'charts/**'

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: azure/setup-helm@v3
        with:
          version: v3.13.0

      - name: Helm Lint
        run: |
          helm lint charts/myapp --strict

      - name: YAML Lint
        run: |
          pip install yamllint
          yamllint charts/

  unit-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: azure/setup-helm@v3

      - name: Install helm-unittest
        run: |
          helm plugin install https://github.com/helm-unittest/helm-unittest

      - name: Run unit tests
        run: |
          helm unittest charts/myapp --color

  integration-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: azure/setup-helm@v3

      - uses: helm/chart-testing-action@v2.6.0

      - uses: helm/kind-action@v1.8.0

      - name: Run chart-testing (install)
        run: |
          ct install --charts charts/myapp

  security-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: azure/setup-helm@v3

      - name: Render templates
        run: |
          helm template test charts/myapp > rendered.yaml

      - name: Run Trivy
        uses: aquasecurity/trivy-action@master
        with:
          scan-type: 'config'
          scan-ref: 'rendered.yaml'
          severity: 'HIGH,CRITICAL'

      - name: Run Kubesec
        run: |
          docker run --rm -v $(pwd):/work kubesec/kubesec:v2 scan /work/rendered.yaml

  package:
    runs-on: ubuntu-latest
    needs: [lint, unit-test, integration-test, security-scan]
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4

      - uses: azure/setup-helm@v3

      - name: Package chart
        run: |
          helm package charts/myapp

      - name: Upload artifact
        uses: actions/upload-artifact@v3
        with:
          name: helm-chart
          path: "*.tgz"
```

## Production Validation {#production-validation}

### Pre-Deployment Validation

```bash
#!/bin/bash
# pre-deployment-validation.sh

set -euo pipefail

export CHART_DIR="${1}"
export VALUES_FILE="${2}"
export NAMESPACE="${3}"

echo "=== Pre-Deployment Validation ==="

# Validate chart
helm lint "$CHART_DIR" --values "$VALUES_FILE"

# Render and validate
helm template test "$CHART_DIR" --values "$VALUES_FILE" --namespace "$NAMESPACE" > /tmp/rendered.yaml

# Check resource quotas
echo -e "\n--- Checking Resource Quotas ---"
total_cpu=$(kubectl get resourcequota -n "$NAMESPACE" -o json | jq -r '.items[0].spec.hard.cpu // "unlimited"')
total_mem=$(kubectl get resourcequota -n "$NAMESPACE" -o json | jq -r '.items[0].spec.hard.memory // "unlimited"')

echo "Namespace quotas - CPU: $total_cpu, Memory: $total_mem"

# Dry-run installation
echo -e "\n--- Dry-Run Installation ---"
helm upgrade --install test "$CHART_DIR" \
  --values "$VALUES_FILE" \
  --namespace "$NAMESPACE" \
  --dry-run --debug

# Check for breaking changes
echo -e "\n--- Checking for Breaking Changes ---"
if helm get values test -n "$NAMESPACE" &>/dev/null; then
  helm diff upgrade test "$CHART_DIR" \
    --values "$VALUES_FILE" \
    --namespace "$NAMESPACE"
fi

echo -e "\n✓ Pre-deployment validation complete"
```

## Best Practices and Patterns {#best-practices}

### Testing Checklist

```markdown
## Helm Chart Testing Checklist

### Unit Tests
- [ ] All templates have unit tests
- [ ] Conditional rendering tested
- [ ] Helper functions tested
- [ ] Default values tested
- [ ] Edge cases covered
- [ ] Invalid input handled

### Integration Tests
- [ ] Chart installs successfully
- [ ] Chart upgrades work
- [ ] Chart rollback works
- [ ] Dependencies install correctly
- [ ] Hooks execute properly

### Security
- [ ] No privileged containers
- [ ] Resource limits defined
- [ ] Security contexts configured
- [ ] Network policies in place
- [ ] Secrets properly handled
- [ ] Image scanning passed

### Documentation
- [ ] README complete
- [ ] values.yaml documented
- [ ] NOTES.txt helpful
- [ ] Upgrade notes included
- [ ] Examples provided

### CI/CD
- [ ] Automated linting
- [ ] Automated testing
- [ ] Automated security scanning
- [ ] Automated packaging
- [ ] Automated publishing
```

## Conclusion

Comprehensive Helm chart testing is essential for reliable Kubernetes deployments at scale. This guide has covered enterprise-grade testing strategies including unit tests, integration tests, security scanning, and automated CI/CD pipelines that ensure chart quality before production deployment.

Key takeaways:

1. **Multi-Layer Testing**: Implement unit, integration, and E2E tests for comprehensive coverage
2. **Security First**: Integrate security scanning into every stage of the testing pipeline
3. **Automation**: Automate all testing in CI/CD to catch issues early
4. **Validation**: Use schema validation and linting to enforce standards
5. **Production Readiness**: Perform thorough pre-deployment validation
6. **Continuous Improvement**: Monitor and iterate on testing strategies

For more information on Helm and Kubernetes deployments, see our guides on [Kustomize advanced overlays](/kustomize-advanced-overlays-configuration-management-guide/) and [GitOps disaster recovery](/gitops-disaster-recovery-procedures-enterprise-guide/).