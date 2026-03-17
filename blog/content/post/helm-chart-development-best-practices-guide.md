---
title: "Helm Chart Development Best Practices: Enterprise Patterns and Testing Strategies"
date: 2027-08-24T00:00:00-05:00
draft: false
tags: ["Helm", "Kubernetes", "DevOps", "CI/CD"]
categories:
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise Helm chart development covering chart structure best practices, values schema validation, hooks and hook weights, library charts for shared templates, chart testing with chart-testing and helm-unittest, OCI registry publishing, and Helm secrets management."
more_link: "yes"
url: "/helm-chart-development-best-practices-guide/"
---

Helm charts that work on the developer's laptop frequently fail in production due to missing validation, untested edge cases, and hard-coded values that conflict with enterprise requirements. Building production-grade charts requires schema validation, comprehensive testing with chart-testing and helm-unittest, shared template libraries to eliminate duplication, and secure secrets management — practices that prevent the majority of chart-related production incidents.

<!--more-->

## Chart Structure and Organization

### Standard Directory Layout

```
my-application/
├── Chart.yaml              # Chart metadata
├── Chart.lock              # Dependency lock file
├── values.yaml             # Default values
├── values.schema.json      # JSON Schema for values validation
├── README.md               # Documentation
├── .helmignore             # Files excluded from packaging
├── charts/                 # Chart dependencies
├── templates/
│   ├── NOTES.txt           # Post-install notes
│   ├── _helpers.tpl        # Template helpers and partials
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── serviceaccount.yaml
│   ├── ingress.yaml
│   ├── configmap.yaml
│   ├── hpa.yaml
│   ├── pdb.yaml
│   └── tests/
│       └── test-connection.yaml
└── ci/
    ├── default-values.yaml
    ├── minimal-values.yaml
    └── full-values.yaml
```

### Chart.yaml Metadata

```yaml
# Chart.yaml
apiVersion: v2
name: my-application
description: A production-grade application deployment chart
type: application
version: 1.4.2            # Chart version — increment with every change
appVersion: "2.3.0"       # Application version being deployed

keywords:
  - api
  - microservice
  - production

maintainers:
  - name: Platform Team
    email: platform@example.com
    url: https://platform.example.com

dependencies:
  - name: postgresql
    version: "13.2.x"
    repository: "https://charts.bitnami.com/bitnami"
    condition: postgresql.enabled   # Only deploy if postgresql.enabled=true
  - name: redis
    version: "18.x.x"
    repository: "https://charts.bitnami.com/bitnami"
    condition: redis.enabled
```

## Values Schema Validation

JSON Schema validation catches misconfigured values at `helm install` time rather than at runtime:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "my-application values",
  "type": "object",
  "required": ["image", "replicaCount"],
  "properties": {
    "replicaCount": {
      "type": "integer",
      "minimum": 1,
      "maximum": 100,
      "description": "Number of replicas. Must be at least 1."
    },
    "image": {
      "type": "object",
      "required": ["repository", "tag"],
      "properties": {
        "repository": {
          "type": "string",
          "pattern": "^[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*$",
          "description": "Container image repository"
        },
        "tag": {
          "type": "string",
          "minLength": 1,
          "description": "Image tag — never use 'latest' in production"
        },
        "pullPolicy": {
          "type": "string",
          "enum": ["Always", "Never", "IfNotPresent"],
          "default": "IfNotPresent"
        }
      }
    },
    "resources": {
      "type": "object",
      "properties": {
        "requests": {
          "type": "object",
          "properties": {
            "cpu": { "type": "string", "pattern": "^[0-9]+(m|\\.[0-9]+)?$" },
            "memory": { "type": "string", "pattern": "^[0-9]+(Mi|Gi|M|G)$" }
          }
        },
        "limits": {
          "type": "object",
          "properties": {
            "cpu": { "type": "string", "pattern": "^[0-9]+(m|\\.[0-9]+)?$" },
            "memory": { "type": "string", "pattern": "^[0-9]+(Mi|Gi|M|G)$" }
          }
        }
      }
    },
    "ingress": {
      "type": "object",
      "properties": {
        "enabled": { "type": "boolean" },
        "className": { "type": "string" },
        "hosts": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["host"],
            "properties": {
              "host": {
                "type": "string",
                "format": "hostname"
              }
            }
          }
        }
      }
    }
  }
}
```

Test schema validation:

```bash
# Schema violations are caught immediately
helm install my-app ./my-application \
  --set replicaCount="invalid"
# Error: values don't meet the specifications of the schema(s) in the following chart(s):
# my-application: replicaCount: Invalid type. Expected: integer, given: string

helm install my-app ./my-application \
  --set image.pullPolicy=Always-Wrong
# Error: image.pullPolicy: image.pullPolicy must be one of the following: "Always", "Never", "IfNotPresent"
```

## Template Helpers and _helpers.tpl

### Comprehensive Helper Library

```yaml
{{/*
Expand the name of the chart.
*/}}
{{- define "my-application.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
Truncate at 63 chars due to Kubernetes label length restrictions.
*/}}
{{- define "my-application.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Common labels applied to all resources.
*/}}
{{- define "my-application.labels" -}}
helm.sh/chart: {{ include "my-application.chart" . }}
{{ include "my-application.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: {{ .Chart.Name }}
{{- end }}

{{/*
Selector labels — used in both spec.selector and pod template metadata.
*/}}
{{- define "my-application.selectorLabels" -}}
app.kubernetes.io/name: {{ include "my-application.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
ServiceAccount name — use override if provided.
*/}}
{{- define "my-application.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "my-application.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Validate required values — fails fast with clear error messages.
*/}}
{{- define "my-application.validateValues" -}}
{{- if not .Values.image.repository -}}
  {{ fail "image.repository is required" }}
{{- end }}
{{- if eq .Values.image.tag "latest" -}}
  {{ fail "image.tag must not be 'latest' in production deployments" }}
{{- end }}
{{- if and .Values.ingress.enabled (not .Values.ingress.hosts) -}}
  {{ fail "ingress.hosts must be set when ingress.enabled=true" }}
{{- end }}
{{- end }}
```

## Helm Hooks and Hook Weights

### Pre-Install Database Migration Hook

```yaml
# templates/pre-install-migration.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ include "my-application.fullname" . }}-migrations
  labels:
    {{- include "my-application.labels" . | nindent 4 }}
  annotations:
    "helm.sh/hook": pre-install,pre-upgrade
    "helm.sh/hook-weight": "-5"          # Lower weight runs first
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
spec:
  template:
    metadata:
      labels:
        app.kubernetes.io/name: {{ include "my-application.name" . }}-migration
    spec:
      restartPolicy: Never
      containers:
        - name: migration
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          command: ["/app/migrate"]
          args: ["--direction=up"]
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: {{ include "my-application.fullname" . }}-db-secret
                  key: database-url
      {{- with .Values.imagePullSecrets }}
      imagePullSecrets:
        {{- toYaml . | nindent 8 }}
      {{- end }}
  backoffLimit: 3
```

### Post-Upgrade Smoke Test Hook

```yaml
# templates/post-upgrade-test.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ include "my-application.fullname" . }}-smoke-test
  annotations:
    "helm.sh/hook": post-upgrade
    "helm.sh/hook-weight": "5"
    "helm.sh/hook-delete-policy": before-hook-creation
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: smoke-test
          image: curlimages/curl:latest
          command:
            - sh
            - -c
            - |
              set -e
              echo "Running smoke tests..."
              # Health check
              curl -f http://{{ include "my-application.fullname" . }}:{{ .Values.service.port }}/health
              # Readiness check
              curl -f http://{{ include "my-application.fullname" . }}:{{ .Values.service.port }}/ready
              echo "All smoke tests passed"
  backoffLimit: 2
```

## Library Charts for Shared Templates

Library charts provide shared template functions without generating Kubernetes objects:

```yaml
# common-library/Chart.yaml
apiVersion: v2
name: common-library
description: Shared template library for all company Helm charts
type: library      # type: library — no objects are rendered
version: 2.1.0
```

```yaml
# common-library/templates/_deployment.tpl
{{/*
Standard enterprise deployment template.
Usage: {{ include "common.deployment" (dict "root" . "values" .Values) }}
*/}}
{{- define "common.deployment" -}}
{{- $root := .root }}
{{- $values := .values }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "common.fullname" $root }}
  labels:
    {{- include "common.labels" $root | nindent 4 }}
    {{- with $values.additionalLabels }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
  annotations:
    deployment.kubernetes.io/revision: "1"
    {{- with $values.additionalAnnotations }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
spec:
  {{- if not $values.autoscaling.enabled }}
  replicas: {{ $values.replicaCount }}
  {{- end }}
  selector:
    matchLabels:
      {{- include "common.selectorLabels" $root | nindent 6 }}
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
  template:
    metadata:
      labels:
        {{- include "common.selectorLabels" $root | nindent 8 }}
      annotations:
        checksum/config: {{ include (print $root.Template.BasePath "/configmap.yaml") $root | sha256sum }}
        checksum/secret: {{ include (print $root.Template.BasePath "/secret.yaml") $root | sha256sum }}
    spec:
      serviceAccountName: {{ include "common.serviceAccountName" $root }}
      securityContext:
        {{- toYaml $values.podSecurityContext | nindent 8 }}
      containers:
        - name: {{ $root.Chart.Name }}
          securityContext:
            {{- toYaml $values.securityContext | nindent 12 }}
          image: "{{ $values.image.repository }}:{{ $values.image.tag | default $root.Chart.AppVersion }}"
          imagePullPolicy: {{ $values.image.pullPolicy }}
          {{- with $values.resources }}
          resources:
            {{- toYaml . | nindent 12 }}
          {{- end }}
{{- end }}
```

Reference the library chart from an application chart:

```yaml
# my-application/Chart.yaml
dependencies:
  - name: common-library
    version: "2.x.x"
    repository: "oci://registry.example.com/helm-charts"
```

## Chart Testing with chart-testing and helm-unittest

### chart-testing (ct) Configuration

```yaml
# ct.yaml
target-branch: main
chart-dirs:
  - charts
excluded-charts:
  - common-library
chart-repos:
  - bitnami=https://charts.bitnami.com/bitnami
  - prometheus-community=https://prometheus-community.github.io/helm-charts
validate-maintainers: false
check-version-increment: true
```

```bash
# Lint all charts
ct lint --config ct.yaml

# Install test all charts against a cluster
ct install --config ct.yaml --all

# Test a specific chart
ct install --config ct.yaml --charts charts/my-application

# Run with custom CI values files
ct install --config ct.yaml \
  --charts charts/my-application \
  --helm-extra-args "--timeout 5m"
```

### helm-unittest for Unit Testing

```yaml
# templates/tests/unittest/deployment_test.yaml
suite: Deployment tests
templates:
  - deployment.yaml
tests:
  - it: should set default replica count
    asserts:
      - equal:
          path: spec.replicas
          value: 1

  - it: should use custom replica count
    set:
      replicaCount: 3
    asserts:
      - equal:
          path: spec.replicas
          value: 3

  - it: should include checksum annotation for config changes
    asserts:
      - isNotEmpty:
          path: spec.template.metadata.annotations["checksum/config"]

  - it: should not set replicas when HPA is enabled
    set:
      autoscaling.enabled: true
    asserts:
      - notExists:
          path: spec.replicas

  - it: should fail with invalid image tag
    set:
      image.tag: "latest"
    asserts:
      - failedTemplate:
          errorMessage: "image.tag must not be 'latest'"
```

```bash
# Install helm-unittest plugin
helm plugin install https://github.com/helm-unittest/helm-unittest

# Run all tests
helm unittest charts/my-application

# Run with verbose output
helm unittest -v charts/my-application

# Run specific test file
helm unittest charts/my-application -f "templates/tests/unittest/deployment_test.yaml"

# Generate JUnit output for CI
helm unittest charts/my-application -o junit -d test-results/
```

### CI/CD Integration

```yaml
# .github/workflows/helm-test.yaml
name: Helm Chart Testing

on:
  pull_request:
    paths:
      - 'charts/**'

jobs:
  lint-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Set up Helm
        uses: azure/setup-helm@v3
        with:
          version: v3.14.0

      - name: Set up chart-testing
        uses: helm/chart-testing-action@v2.6.1

      - name: Run chart linting
        run: ct lint --config ct.yaml

      - name: Run helm-unittest
        run: |
          helm plugin install https://github.com/helm-unittest/helm-unittest
          helm unittest charts/*/ --output-file test-results.xml --output-type JUnit

      - name: Create kind cluster for integration testing
        uses: helm/kind-action@v1.9.0
        if: steps.list-changed.outputs.changed == 'true'

      - name: Run chart install tests
        run: ct install --config ct.yaml
        if: steps.list-changed.outputs.changed == 'true'
```

## OCI Registry Publishing

```bash
# Package chart
helm package charts/my-application --version 1.4.2

# Login to OCI registry
helm registry login registry.example.com \
  --username REGISTRY_USERNAME_REPLACE_ME \
  --password REGISTRY_PASSWORD_REPLACE_ME

# Push to OCI registry
helm push my-application-1.4.2.tgz oci://registry.example.com/helm-charts

# Pull and install from OCI registry
helm pull oci://registry.example.com/helm-charts/my-application --version 1.4.2
helm install my-app oci://registry.example.com/helm-charts/my-application \
  --version 1.4.2 \
  -f production-values.yaml

# List tags in OCI registry
helm show chart oci://registry.example.com/helm-charts/my-application --version 1.4.2
```

## Helm Secrets Management

### Using helm-secrets with SOPS

```bash
# Install helm-secrets plugin
helm plugin install https://github.com/jkroepke/helm-secrets

# Create encrypted values file with SOPS (AWS KMS backend)
sops --kms "arn:aws:kms:us-east-1:123456789012:key/EXAMPLE-KEY-ID-REPLACE-ME" \
  --encrypt secrets.yaml > secrets.enc.yaml

# Install with encrypted secrets
helm secrets install my-app ./my-application \
  -f values.yaml \
  -f secrets.enc.yaml   # helm-secrets decrypts this automatically

# Diff with secrets (shows what would change without applying)
helm secrets diff upgrade my-app ./my-application \
  -f values.yaml \
  -f secrets.enc.yaml
```

### External Secrets Operator Integration

For GitOps workflows where secrets must not exist in the Helm chart at all:

```yaml
# templates/externalsecret.yaml
{{- if .Values.externalSecrets.enabled }}
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: {{ include "my-application.fullname" . }}-secrets
  labels:
    {{- include "my-application.labels" . | nindent 4 }}
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: {{ .Values.externalSecrets.secretStore }}
    kind: ClusterSecretStore
  target:
    name: {{ include "my-application.fullname" . }}-secrets
    creationPolicy: Owner
  data:
    {{- range .Values.externalSecrets.keys }}
    - secretKey: {{ .secretKey }}
      remoteRef:
        key: {{ $.Values.externalSecrets.path }}/{{ .remoteKey }}
    {{- end }}
{{- end }}
```

Chart testing with both helm-unittest for unit-level template logic and chart-testing for integration-level cluster install validation creates a two-tier quality gate. The schema validation ensures bad values fail immediately with clear error messages rather than producing cryptic Kubernetes errors, and the library chart pattern eliminates the drift between charts that causes subtle differences in production behavior when the same template function is duplicated across twenty service charts.
