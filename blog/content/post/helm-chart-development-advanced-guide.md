---
title: "Advanced Helm Chart Development: Library Charts, Hooks, and Testing"
date: 2028-02-06T00:00:00-05:00
draft: false
tags: ["Helm", "Kubernetes", "Helm Hooks", "Chart Testing", "Library Charts", "OCI Registry", "DevOps"]
categories:
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to advanced Helm chart development covering library charts, hook lifecycle management, values schema validation, chart testing with ct, and OCI registry storage for enterprise deployments."
more_link: "yes"
url: "/advanced-helm-chart-development-library-hooks-testing/"
---

Helm is the de facto package manager for Kubernetes, but most teams barely scratch its surface. Library charts eliminate copy-paste between application charts. Hooks enable complex deployment orchestration — database migrations, certificate pre-provisioning, post-deploy smoke tests. JSON schema validation catches misconfigured values at install time, not hours later during runtime. This guide covers the patterns that distinguish production-grade chart maintainers from teams that just use `helm create` and ship.

<!--more-->

# Advanced Helm Chart Development: Library Charts, Hooks, and Testing

## Library Charts: Reusable Template Primitives

A library chart is a Helm chart with `type: library` in its `Chart.yaml`. It contains only `_helpers.tpl` files (named with a leading underscore) and cannot be deployed directly. Consumer charts declare it as a dependency and call its named templates.

Library charts solve the DRY problem: container security contexts, resource request structures, affinity templates, and standard label sets defined once and used across dozens of application charts.

### Library Chart Structure

```
charts/common-lib/
├── Chart.yaml
├── templates/
│   ├── _labels.tpl          # Standard label generators
│   ├── _affinities.tpl      # Affinity and topology spread templates
│   ├── _containers.tpl      # Container spec helpers
│   ├── _security.tpl        # Pod and container security context templates
│   └── _resources.tpl       # Resource request/limit generators
└── values.yaml              # Default values referenced by templates
```

```yaml
# charts/common-lib/Chart.yaml
apiVersion: v2
name: common-lib
description: Shared Helm template library for support.tools services
# type: library means this chart cannot be installed directly
type: library
version: 1.4.2
# Library charts have no appVersion since they deploy no application
```

### Implementing Library Templates

```
{{/* charts/common-lib/templates/_labels.tpl */}}

{{/*
Generate standard Kubernetes labels for a resource.
Usage: include "common-lib.labels" .
Context: pass the root chart context (.)
*/}}
{{- define "common-lib.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ .Chart.Name | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/instance: {{ .Release.Name | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/version: {{ .Chart.AppVersion | default "latest" | trunc 63 | trimSuffix "-" | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: {{ .Values.global.partOf | default .Chart.Name }}
{{- end }}

{{/*
Generate selector labels (subset of standard labels, must be immutable after first deploy).
Usage: include "common-lib.selectorLabels" .
*/}}
{{- define "common-lib.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/instance: {{ .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Generate a fully qualified chart name, truncated to 63 characters.
Usage: include "common-lib.fullname" .
*/}}
{{- define "common-lib.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := .Chart.Name }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Generate a service account name using nameOverride or fullname.
*/}}
{{- define "common-lib.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "common-lib.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}
```

```
{{/* charts/common-lib/templates/_security.tpl */}}

{{/*
Standard pod security context for non-root workloads.
Usage: include "common-lib.podSecurityContext" .Values.podSecurityContext
*/}}
{{- define "common-lib.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: {{ .runAsUser | default 65534 }}
runAsGroup: {{ .runAsGroup | default 65534 }}
fsGroup: {{ .fsGroup | default 65534 }}
seccompProfile:
  type: RuntimeDefault
{{- end }}

{{/*
Standard container security context implementing least privilege.
Usage: include "common-lib.containerSecurityContext" .Values.securityContext
*/}}
{{- define "common-lib.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: {{ .readOnlyRootFilesystem | default true }}
capabilities:
  drop:
  - ALL
  {{- if .addCapabilities }}
  add:
  {{- toYaml .addCapabilities | nindent 2 }}
  {{- end }}
{{- end }}

{{/*
Standard topology spread constraints for HA deployment.
Usage: include "common-lib.topologySpread" (dict "app" "order-service" "maxSkew" 1)
*/}}
{{- define "common-lib.topologySpread" -}}
- maxSkew: {{ .maxSkew | default 1 }}
  topologyKey: topology.kubernetes.io/zone
  whenUnsatisfiable: DoNotSchedule
  labelSelector:
    matchLabels:
      app.kubernetes.io/name: {{ .app }}
  minDomains: 3
- maxSkew: {{ .maxSkew | default 1 }}
  topologyKey: kubernetes.io/hostname
  whenUnsatisfiable: ScheduleAnyway
  labelSelector:
    matchLabels:
      app.kubernetes.io/name: {{ .app }}
{{- end }}
```

### Consuming the Library Chart

```yaml
# charts/order-service/Chart.yaml
apiVersion: v2
name: order-service
description: Order processing microservice
type: application
version: 3.1.0
appVersion: "4.2.1"
dependencies:
# Declare the library chart as a dependency
- name: common-lib
  version: ">=1.4.0"
  repository: "oci://registry.example.com/helm-charts"
```

```yaml
# charts/order-service/templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "common-lib.fullname" . }}
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "common-lib.labels" . | nindent 4 }}
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels:
      {{- include "common-lib.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "common-lib.labels" . | nindent 8 }}
      annotations:
        # Force pod restart when ConfigMap content changes
        checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
    spec:
      serviceAccountName: {{ include "common-lib.serviceAccountName" . }}
      securityContext:
        {{- include "common-lib.podSecurityContext" .Values.podSecurityContext | nindent 8 }}
      topologySpreadConstraints:
        {{- include "common-lib.topologySpread" (dict "app" (include "common-lib.fullname" .) "maxSkew" 1) | nindent 8 }}
      containers:
      - name: {{ .Chart.Name }}
        image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
        imagePullPolicy: {{ .Values.image.pullPolicy | default "IfNotPresent" }}
        securityContext:
          {{- include "common-lib.containerSecurityContext" .Values.securityContext | nindent 10 }}
        ports:
        - containerPort: {{ .Values.service.targetPort }}
          name: http
          protocol: TCP
        resources:
          {{- toYaml .Values.resources | nindent 10 }}
```

## Chart Hooks: Lifecycle Management

Helm hooks allow running Kubernetes Jobs at specific points in the release lifecycle. Common use cases: database migrations before application upgrade, secret provisioning before installation, smoke tests after deployment, cleanup after rollback.

### Hook Annotations Reference

```yaml
# Hook timing annotations
"helm.sh/hook": pre-install      # Before any release resources are created
"helm.sh/hook": pre-upgrade      # Before upgrade begins
"helm.sh/hook": post-install     # After all resources are created
"helm.sh/hook": post-upgrade     # After upgrade completes
"helm.sh/hook": pre-rollback     # Before rollback begins
"helm.sh/hook": post-rollback    # After rollback completes
"helm.sh/hook": pre-delete       # Before release is deleted
"helm.sh/hook": post-delete      # After release is deleted
"helm.sh/hook": test             # Run during helm test

# Multiple hooks can be assigned to a single resource
"helm.sh/hook": pre-install,pre-upgrade

# Hook weight: lower weight hooks run first (-100 to 100, default 0)
"helm.sh/hook-weight": "-5"

# Deletion policy: what happens to the hook resource after it completes
"helm.sh/hook-delete-policy": hook-succeeded         # Delete on success
"helm.sh/hook-delete-policy": hook-failed            # Delete on failure
"helm.sh/hook-delete-policy": before-hook-creation   # Delete before next run
```

### Database Migration Hook

```yaml
# charts/order-service/templates/hooks/pre-upgrade-migrate.yaml
{{- if .Values.database.migrations.enabled }}
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ include "common-lib.fullname" . }}-migrate-{{ .Release.Revision }}
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "common-lib.labels" . | nindent 4 }}
    app.kubernetes.io/component: migration
  annotations:
    # Run before installation AND before upgrades
    "helm.sh/hook": pre-install,pre-upgrade
    # Lower weight runs first; use -5 so migrations precede certificate setup
    "helm.sh/hook-weight": "-5"
    # Keep the job around for debugging after success; delete before next hook run
    "helm.sh/hook-delete-policy": before-hook-creation
spec:
  # Retry up to 3 times before marking the hook as failed
  # A failed hook blocks the Helm operation
  backoffLimit: 3
  activeDeadlineSeconds: 300
  template:
    metadata:
      labels:
        app.kubernetes.io/component: migration
        helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
    spec:
      restartPolicy: OnFailure
      serviceAccountName: {{ include "common-lib.serviceAccountName" . }}-migration
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        seccompProfile:
          type: RuntimeDefault
      initContainers:
      # Wait for the database to be reachable before running migrations
      - name: wait-for-db
        image: "{{ .Values.database.migrations.initImage | default "busybox:1.36" }}"
        command:
        - /bin/sh
        - -c
        - |
          until nc -z {{ .Values.database.host }} {{ .Values.database.port }}; do
            echo "Waiting for database at {{ .Values.database.host }}:{{ .Values.database.port }}..."
            sleep 2
          done
          echo "Database is reachable"
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities:
            drop: [ALL]
      containers:
      - name: migrate
        image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
        command: ["/app/migrate"]
        args: ["--direction=up", "--verbose"]
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: {{ include "common-lib.fullname" . }}-db-credentials
              key: url
        - name: MIGRATION_DIR
          value: /app/migrations
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities:
            drop: [ALL]
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
{{- end }}
```

### Post-Deploy Smoke Test Hook

```yaml
# charts/order-service/templates/hooks/post-upgrade-smoketest.yaml
{{- if .Values.smokeTest.enabled }}
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ include "common-lib.fullname" . }}-smoketest-{{ .Release.Revision }}
  namespace: {{ .Release.Namespace }}
  annotations:
    "helm.sh/hook": post-install,post-upgrade
    "helm.sh/hook-weight": "5"
    # Delete before next hook creation (not on success) so failures are inspectable
    "helm.sh/hook-delete-policy": before-hook-creation
spec:
  backoffLimit: 1
  activeDeadlineSeconds: 120
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: smoke-test
        image: "{{ .Values.smokeTest.image | default "curlimages/curl:8.6.0" }}"
        command:
        - /bin/sh
        - -c
        - |
          set -e
          SERVICE_URL="http://{{ include "common-lib.fullname" . }}.{{ .Release.Namespace }}.svc.cluster.local:{{ .Values.service.port }}"

          echo "=== Smoke Test: order-service ==="
          echo "Target: ${SERVICE_URL}"

          # Health check
          echo "--- Health Check ---"
          curl -sf "${SERVICE_URL}/health" || { echo "FAIL: health check"; exit 1; }
          echo "PASS: health check"

          # Readiness check
          echo "--- Readiness Check ---"
          curl -sf "${SERVICE_URL}/ready" || { echo "FAIL: readiness check"; exit 1; }
          echo "PASS: readiness check"

          # API version check
          echo "--- API Version Check ---"
          VERSION=$(curl -sf "${SERVICE_URL}/version" | jq -r '.version')
          EXPECTED="{{ .Values.image.tag | default .Chart.AppVersion }}"
          if [ "${VERSION}" != "${EXPECTED}" ]; then
            echo "FAIL: version mismatch (got ${VERSION}, expected ${EXPECTED})"
            exit 1
          fi
          echo "PASS: version check (${VERSION})"

          echo "=== All smoke tests passed ==="
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities:
            drop: [ALL]
        resources:
          requests:
            cpu: 50m
            memory: 64Mi
{{- end }}
```

### Pre-Rollback Diagnostic Hook

```yaml
# charts/order-service/templates/hooks/pre-rollback-diag.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ include "common-lib.fullname" . }}-rollback-diag-{{ .Release.Revision }}
  namespace: {{ .Release.Namespace }}
  annotations:
    "helm.sh/hook": pre-rollback
    "helm.sh/hook-weight": "0"
    "helm.sh/hook-delete-policy": hook-succeeded
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: diagnostics
        image: "bitnami/kubectl:1.30"
        command:
        - /bin/sh
        - -c
        - |
          echo "=== Pre-Rollback Diagnostics: {{ include "common-lib.fullname" . }} ==="
          echo "Revision being rolled back: {{ .Release.Revision }}"
          kubectl get pods -n {{ .Release.Namespace }} \
            -l app.kubernetes.io/name={{ .Chart.Name }} \
            -o wide
          echo "--- Recent Events ---"
          kubectl get events -n {{ .Release.Namespace }} \
            --sort-by='.lastTimestamp' \
            --field-selector involvedObject.name={{ include "common-lib.fullname" . }} | tail -20
        resources:
          requests:
            cpu: 50m
            memory: 64Mi
```

## Values Schema Validation

The `values.schema.json` file defines JSON Schema constraints for chart values. Helm validates values against this schema on `helm install`, `helm upgrade`, and `helm lint` — catching misconfiguration before cluster changes.

```json
{
  "$schema": "https://json-schema.org/draft-07/schema#",
  "title": "order-service Chart Values",
  "type": "object",
  "required": ["image", "service", "database"],
  "properties": {
    "replicaCount": {
      "type": "integer",
      "minimum": 1,
      "maximum": 50,
      "description": "Number of deployment replicas",
      "default": 3
    },
    "image": {
      "type": "object",
      "required": ["repository"],
      "properties": {
        "repository": {
          "type": "string",
          "minLength": 1,
          "description": "Container image repository (without tag)"
        },
        "tag": {
          "type": "string",
          "description": "Image tag; defaults to Chart.AppVersion if empty"
        },
        "pullPolicy": {
          "type": "string",
          "enum": ["Always", "IfNotPresent", "Never"],
          "default": "IfNotPresent"
        }
      },
      "additionalProperties": false
    },
    "service": {
      "type": "object",
      "required": ["type", "port"],
      "properties": {
        "type": {
          "type": "string",
          "enum": ["ClusterIP", "NodePort", "LoadBalancer"],
          "default": "ClusterIP"
        },
        "port": {
          "type": "integer",
          "minimum": 1,
          "maximum": 65535
        },
        "targetPort": {
          "type": "integer",
          "minimum": 1,
          "maximum": 65535,
          "default": 8080
        }
      }
    },
    "database": {
      "type": "object",
      "required": ["host", "port", "name"],
      "properties": {
        "host": {
          "type": "string",
          "minLength": 1,
          "format": "hostname"
        },
        "port": {
          "type": "integer",
          "minimum": 1,
          "maximum": 65535,
          "default": 5432
        },
        "name": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9_]{0,62}$"
        },
        "migrations": {
          "type": "object",
          "properties": {
            "enabled": {
              "type": "boolean",
              "default": true
            }
          }
        }
      },
      "additionalProperties": false
    },
    "resources": {
      "type": "object",
      "properties": {
        "requests": {
          "type": "object",
          "required": ["cpu", "memory"],
          "properties": {
            "cpu": { "type": "string", "pattern": "^[0-9]+(m|[.][0-9]+)?$" },
            "memory": { "type": "string", "pattern": "^[0-9]+(Mi|Gi|Ki)$" }
          }
        },
        "limits": {
          "type": "object",
          "properties": {
            "cpu": { "type": "string", "pattern": "^[0-9]+(m|[.][0-9]+)?$" },
            "memory": { "type": "string", "pattern": "^[0-9]+(Mi|Gi|Ki)$" }
          }
        }
      }
    },
    "smokeTest": {
      "type": "object",
      "properties": {
        "enabled": { "type": "boolean", "default": true },
        "image": { "type": "string" }
      }
    }
  }
}
```

## Helm Test Pods

`helm test` runs Jobs annotated with `helm.sh/hook: test`. Unlike hook jobs, test jobs are explicitly triggered by the operator after deployment to verify functionality in the live environment.

```yaml
# charts/order-service/templates/tests/test-connection.yaml
apiVersion: v1
kind: Pod
metadata:
  name: {{ include "common-lib.fullname" . }}-test-connection
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "common-lib.labels" . | nindent 4 }}
    app.kubernetes.io/component: test
  annotations:
    # This resource only exists during helm test execution
    "helm.sh/hook": test
    "helm.sh/hook-delete-policy": hook-succeeded
spec:
  restartPolicy: Never
  containers:
  - name: test-connection
    image: curlimages/curl:8.6.0
    command:
    - /bin/sh
    - -c
    - |
      set -e
      TARGET="http://{{ include "common-lib.fullname" . }}:{{ .Values.service.port }}"
      echo "Testing connection to ${TARGET}"

      # Test 1: Health endpoint
      HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${TARGET}/health")
      if [ "${HTTP_CODE}" != "200" ]; then
        echo "FAIL: /health returned ${HTTP_CODE}"
        exit 1
      fi
      echo "PASS: /health returned 200"

      # Test 2: API responds correctly
      RESPONSE=$(curl -sf "${TARGET}/api/v1/status")
      echo "API status: ${RESPONSE}"
      echo "PASS: API is responsive"
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities:
        drop: [ALL]
    resources:
      requests:
        cpu: 50m
        memory: 64Mi
```

## Chart Linting and Testing with ct

The `chart-testing` tool (`ct`) adds chart-level testing on top of `helm lint`. It identifies changed charts in a git diff, runs lint against them, and executes install + test against a real Kubernetes cluster.

### ct Configuration

```yaml
# ct.yaml (chart-testing configuration)
remote: origin
target-branch: main

# Directories to search for charts
chart-dirs:
- charts

# Helm extra arguments
helm-extra-args: --timeout 600s

# validate-maintainers: ensure Chart.yaml has maintainer entries
validate-maintainers: true

# Exclude specific charts from testing
excluded-charts:
- common-lib   # Library chart cannot be installed directly

# Check for version bump when chart changes
check-version-increment: true

# Lint configuration passed to helm lint
lint-conf: lint-conf.yaml
```

```yaml
# lint-conf.yaml
# Helm lint configuration
rules:
  # Disallow deprecated Kubernetes API versions
  deprecations:
    enabled: true
  # Require all values.schema.json files
  schema:
    enabled: true
```

### CI Pipeline with ct

```yaml
# .github/workflows/chart-test.yaml
name: Chart Testing

on:
  pull_request:
    paths:
    - 'charts/**'

jobs:
  lint-test:
    runs-on: ubuntu-latest
    steps:
    - name: Checkout
      uses: actions/checkout@v4
      with:
        fetch-depth: 0  # Required for ct to detect changed charts via git diff

    - name: Set up Helm
      uses: azure/setup-helm@v4
      with:
        version: v3.14.0

    - name: Set up chart-testing
      uses: helm/chart-testing-action@v2.6.1

    - name: Run chart-testing lint
      run: ct lint --config ct.yaml

    - name: Create kind cluster
      uses: helm/kind-action@v1.10.0
      with:
        config: kind-config.yaml

    - name: Run chart-testing install
      run: ct install --config ct.yaml
```

```yaml
# kind-config.yaml — multi-node cluster for topology spread testing
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
- role: control-plane
- role: worker
  kubeadmConfigPatches:
  - |
    kind: JoinConfiguration
    nodeRegistration:
      kubeletExtraArgs:
        node-labels: "topology.kubernetes.io/zone=us-east-1a"
- role: worker
  kubeadmConfigPatches:
  - |
    kind: JoinConfiguration
    nodeRegistration:
      kubeletExtraArgs:
        node-labels: "topology.kubernetes.io/zone=us-east-1b"
- role: worker
  kubeadmConfigPatches:
  - |
    kind: JoinConfiguration
    nodeRegistration:
      kubeletExtraArgs:
        node-labels: "topology.kubernetes.io/zone=us-east-1c"
```

## OCI Registry Storage

Helm v3.8+ supports storing charts as OCI artifacts. This eliminates the need for a dedicated chart repository server — any OCI-compliant registry (ECR, GCR, Docker Hub, Harbor) serves as a Helm repository.

### Pushing Charts to OCI Registry

```bash
# Authenticate to OCI registry (ECR example)
aws ecr get-login-password --region us-east-1 | \
  helm registry login \
    --username AWS \
    --password-stdin \
    123456789012.dkr.ecr.us-east-1.amazonaws.com

# Package the chart
helm package charts/order-service --destination /tmp/helm-packages

# Push to OCI registry
helm push /tmp/helm-packages/order-service-3.1.0.tgz \
  oci://123456789012.dkr.ecr.us-east-1.amazonaws.com/helm-charts

# Inspect pushed chart
helm show chart \
  oci://123456789012.dkr.ecr.us-east-1.amazonaws.com/helm-charts/order-service:3.1.0

# Install directly from OCI registry (no helm repo add required)
helm install order-service \
  oci://123456789012.dkr.ecr.us-east-1.amazonaws.com/helm-charts/order-service \
  --version 3.1.0 \
  --namespace commerce \
  --values values-production.yaml
```

### Automating Chart Publishing in CI

```bash
#!/usr/bin/env bash
# publish-chart.sh — build, test, and publish a Helm chart to OCI registry

set -euo pipefail

CHART_DIR="${1:?Usage: publish-chart.sh <chart-dir>}"
REGISTRY="${HELM_REGISTRY:?HELM_REGISTRY env var required}"
DRY_RUN="${DRY_RUN:-false}"

CHART_NAME=$(yq '.name' "${CHART_DIR}/Chart.yaml")
CHART_VERSION=$(yq '.version' "${CHART_DIR}/Chart.yaml")
PACKAGE_PATH="/tmp/helm-pkg/${CHART_NAME}-${CHART_VERSION}.tgz"

echo "=== Publishing ${CHART_NAME}:${CHART_VERSION} ==="

# Step 1: Update chart dependencies
echo "--- Updating dependencies ---"
helm dependency update "${CHART_DIR}"

# Step 2: Lint with strict mode
echo "--- Linting chart ---"
helm lint "${CHART_DIR}" --strict

# Step 3: Validate values schema
echo "--- Schema validation ---"
helm lint "${CHART_DIR}" \
  --values "${CHART_DIR}/ci/test-values.yaml" \
  --strict

# Step 4: Package
echo "--- Packaging chart ---"
mkdir -p /tmp/helm-pkg
helm package "${CHART_DIR}" \
  --destination /tmp/helm-pkg \
  --sign \
  --key "Helm Signing Key" \
  --keyring ~/.gnupg/secring.gpg

# Step 5: Verify signature
echo "--- Verifying package signature ---"
helm verify "${PACKAGE_PATH}" \
  --keyring ~/.gnupg/pubring.gpg

# Step 6: Push to registry
if [ "${DRY_RUN}" = "true" ]; then
  echo "--- DRY RUN: Skipping push ---"
  echo "Would push: ${PACKAGE_PATH} -> oci://${REGISTRY}/helm-charts"
else
  echo "--- Pushing to OCI registry ---"
  helm push "${PACKAGE_PATH}" "oci://${REGISTRY}/helm-charts"
  echo "Pushed: oci://${REGISTRY}/helm-charts/${CHART_NAME}:${CHART_VERSION}"
fi
```

## Comprehensive values.yaml Structure

```yaml
# charts/order-service/values.yaml
# Annotations describe each field for documentation and schema compliance

# Number of pod replicas. Override per-environment in values-*.yaml files.
replicaCount: 3

image:
  repository: registry.example.com/order-service
  # tag defaults to Chart.AppVersion if not set
  tag: ""
  pullPolicy: IfNotPresent

# Image pull secrets for private registries
imagePullSecrets: []

nameOverride: ""
fullnameOverride: ""

serviceAccount:
  create: true
  name: ""
  annotations: {}

podSecurityContext:
  runAsNonRoot: true
  runAsUser: 65534
  runAsGroup: 65534
  fsGroup: 65534
  seccompProfile:
    type: RuntimeDefault

securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop: [ALL]

service:
  type: ClusterIP
  port: 80
  targetPort: 8080

ingress:
  enabled: false
  className: nginx
  annotations: {}
  hosts:
  - host: order-service.example.com
    paths:
    - path: /
      pathType: Prefix
  tls: []

resources:
  requests:
    cpu: "1"
    memory: 2Gi
  limits:
    cpu: "2"
    memory: 4Gi

autoscaling:
  enabled: false
  minReplicas: 3
  maxReplicas: 20
  targetCPUUtilizationPercentage: 70
  targetMemoryUtilizationPercentage: 80

database:
  host: postgres.data-platform.svc.cluster.local
  port: 5432
  name: orders
  migrations:
    enabled: true
    initImage: busybox:1.36

smokeTest:
  enabled: true
  image: curlimages/curl:8.6.0

global:
  partOf: commerce-platform
  environment: production
```

## Debugging Helm Chart Issues

```bash
# Render templates locally without installing — essential for debugging
helm template order-service charts/order-service \
  --namespace commerce \
  --values values-production.yaml \
  --debug

# Validate rendered templates against the API server (dry run)
helm install order-service charts/order-service \
  --namespace commerce \
  --values values-production.yaml \
  --dry-run \
  --debug

# Show the diff between current and desired state (requires helm-diff plugin)
helm plugin install https://github.com/databus23/helm-diff
helm diff upgrade order-service charts/order-service \
  --namespace commerce \
  --values values-production.yaml

# Inspect release history and rollback if needed
helm history order-service -n commerce
helm rollback order-service 2 -n commerce

# Get the values used for a specific release revision
helm get values order-service -n commerce --revision 3

# Check hook status after a release
kubectl get jobs -n commerce -l "helm.sh/chart=order-service-3.1.0"

# Debug a failed hook by checking job logs
kubectl logs -n commerce job/order-service-migrate-4 --previous
```

Helm library charts, lifecycle hooks, schema-validated values, and ct-based pipeline testing represent the toolset of mature chart maintainers. Applied together, they eliminate entire categories of configuration errors, enable safe automated migrations, and reduce the surface area of production deployment failures caused by chart defects.
