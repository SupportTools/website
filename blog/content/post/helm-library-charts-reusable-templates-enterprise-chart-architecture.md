---
title: "Helm Library Charts: Reusable Templates and Enterprise Chart Architecture"
date: 2030-07-26T00:00:00-05:00
draft: false
tags: ["Helm", "Kubernetes", "GitOps", "DevOps", "Chart Architecture", "OCI Registry"]
categories:
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise Helm library chart patterns covering named templates, helper functions, shared values schemas, chart dependencies, monorepo chart organization, testing library charts with helm-unittest, and publishing to OCI registries."
more_link: "yes"
url: "/helm-library-charts-reusable-templates-enterprise-chart-architecture/"
---

Enterprise Kubernetes platforms commonly operate dozens of application Helm charts that share infrastructure concerns: standard labels, security contexts, resource quotas, ingress patterns, and ServiceMonitor configurations. Without abstraction, these concerns are duplicated across every chart, creating drift and maintenance debt. Helm library charts provide the abstraction layer that eliminates this duplication — enabling platform teams to encode organizational standards in reusable named templates and helper functions consumed by all application charts.

<!--more-->

## What Library Charts Are

A library chart is a Helm chart with `type: library` in its `Chart.yaml`. Library charts cannot be deployed directly — they contain only named templates (defined with `define`) and no manifests of their own. Application charts declare library charts as dependencies and use their templates via `include` and `template` calls.

```yaml
# Chart.yaml for a library chart
apiVersion: v2
name: platform-library
description: Platform-standard Helm template library for enterprise applications
type: library
version: 2.1.0
appVersion: "2.1.0"
```

This single `type: library` declaration is what distinguishes a library chart from an application chart. Helm refuses to deploy library charts directly, enforcing their role as pure abstractions.

## Naming Conventions for Library Templates

Named templates in Helm use a dot-separated namespace convention to avoid collisions between charts. All templates in a library should be prefixed with the library name:

```
{{- define "platform-library.labels.standard" -}}
{{- define "platform-library.pod.securityContext" -}}
{{- define "platform-library.container.resources" -}}
```

Template files in library charts conventionally use an underscore prefix (`_helpers.tpl`, `_labels.tpl`) to signal that they contain only definitions rather than rendered manifests.

## Building a Comprehensive Platform Library

### Standard Labels Template

Platform-wide label standards ensure consistent observability and cost allocation:

```yaml
# templates/_labels.tpl

{{/*
Standard Kubernetes labels following app.kubernetes.io conventions.
Usage:
  labels: {{- include "platform-library.labels.standard" . | nindent 4 }}
*/}}
{{- define "platform-library.labels.standard" -}}
app.kubernetes.io/name: {{ include "platform-library.app.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: {{ .Values.global.platform | default "platform" }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Selector labels — used for pod selection, must be stable across upgrades.
Usage:
  selector: {{- include "platform-library.labels.selector" . | nindent 6 }}
*/}}
{{- define "platform-library.labels.selector" -}}
app.kubernetes.io/name: {{ include "platform-library.app.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Cost allocation labels for FinOps.
Usage:
  {{- include "platform-library.labels.cost" . | nindent 4 }}
*/}}
{{- define "platform-library.labels.cost" -}}
{{- if .Values.global.team }}
platform.io/team: {{ .Values.global.team | quote }}
{{- end }}
{{- if .Values.global.costCenter }}
platform.io/cost-center: {{ .Values.global.costCenter | quote }}
{{- end }}
{{- if .Values.global.environment }}
platform.io/environment: {{ .Values.global.environment | quote }}
{{- end }}
{{- end }}

{{/*
App name: prefers .Values.nameOverride, falls back to chart name.
*/}}
{{- define "platform-library.app.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fullname: Release.Name + chart name with override support.
*/}}
{{- define "platform-library.fullname" -}}
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
```

### Security Context Templates

Centralizing security context ensures policy compliance across all workloads:

```yaml
# templates/_security.tpl

{{/*
Default pod security context.
Applies non-root user and seccomp profile.
Override via .Values.podSecurityContext.
*/}}
{{- define "platform-library.pod.securityContext" -}}
{{- $defaults := dict
  "runAsNonRoot" true
  "runAsUser" 65534
  "runAsGroup" 65534
  "fsGroup" 65534
  "seccompProfile" (dict "type" "RuntimeDefault")
-}}
{{- $merged := merge (default dict .Values.podSecurityContext) $defaults -}}
{{- toYaml $merged }}
{{- end }}

{{/*
Default container security context.
Drops all capabilities, disallows privilege escalation.
Override via .Values.containerSecurityContext.
*/}}
{{- define "platform-library.container.securityContext" -}}
{{- $defaults := dict
  "allowPrivilegeEscalation" false
  "readOnlyRootFilesystem" true
  "runAsNonRoot" true
  "capabilities" (dict "drop" (list "ALL"))
-}}
{{- $merged := merge (default dict .Values.containerSecurityContext) $defaults -}}
{{- toYaml $merged }}
{{- end }}
```

### Resource Management Templates

```yaml
# templates/_resources.tpl

{{/*
Renders container resource requests and limits.
Falls back to values-specified defaults or platform minimums.
Usage:
  resources: {{- include "platform-library.container.resources" . | nindent 10 }}
*/}}
{{- define "platform-library.container.resources" -}}
{{- if .Values.resources }}
{{- toYaml .Values.resources }}
{{- else }}
requests:
  cpu: {{ .Values.global.defaultResources.requests.cpu | default "100m" | quote }}
  memory: {{ .Values.global.defaultResources.requests.memory | default "128Mi" | quote }}
limits:
  cpu: {{ .Values.global.defaultResources.limits.cpu | default "500m" | quote }}
  memory: {{ .Values.global.defaultResources.limits.memory | default "256Mi" | quote }}
{{- end }}
{{- end }}

{{/*
Horizontal Pod Autoscaler spec.
Usage: {{- include "platform-library.hpa.spec" (dict "values" .Values "target" "myapp") | nindent 2 }}
*/}}
{{- define "platform-library.hpa.spec" -}}
minReplicas: {{ .values.autoscaling.minReplicas | default 2 }}
maxReplicas: {{ .values.autoscaling.maxReplicas | default 10 }}
metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: {{ .values.autoscaling.targetCPUUtilization | default 70 }}
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: {{ .values.autoscaling.targetMemoryUtilization | default 80 }}
{{- end }}
```

### Ingress Template

```yaml
# templates/_ingress.tpl

{{/*
Platform-standard Ingress with TLS and annotations.
Usage:
  {{- include "platform-library.ingress" . | nindent 0 }}
*/}}
{{- define "platform-library.ingress" -}}
{{- if .Values.ingress.enabled -}}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ include "platform-library.fullname" . }}
  labels:
    {{- include "platform-library.labels.standard" . | nindent 4 }}
  annotations:
    nginx.ingress.kubernetes.io/proxy-body-size: {{ .Values.ingress.maxBodySize | default "8m" | quote }}
    nginx.ingress.kubernetes.io/proxy-read-timeout: {{ .Values.ingress.readTimeout | default "60" | quote }}
    {{- if .Values.ingress.rateLimit }}
    nginx.ingress.kubernetes.io/limit-rps: {{ .Values.ingress.rateLimit.requestsPerSecond | quote }}
    nginx.ingress.kubernetes.io/limit-connections: {{ .Values.ingress.rateLimit.connections | quote }}
    {{- end }}
    {{- with .Values.ingress.annotations }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
spec:
  ingressClassName: {{ .Values.ingress.className | default "nginx" }}
  {{- if .Values.ingress.tls }}
  tls:
    {{- range .Values.ingress.tls }}
    - hosts:
        {{- range .hosts }}
        - {{ . | quote }}
        {{- end }}
      secretName: {{ .secretName }}
    {{- end }}
  {{- end }}
  rules:
    {{- range .Values.ingress.hosts }}
    - host: {{ .host | quote }}
      http:
        paths:
          {{- range .paths }}
          - path: {{ .path }}
            pathType: {{ .pathType | default "Prefix" }}
            backend:
              service:
                name: {{ include "platform-library.fullname" $ }}
                port:
                  number: {{ $.Values.service.port | default 8080 }}
          {{- end }}
    {{- end }}
{{- end }}
{{- end }}
```

### ServiceMonitor Template

```yaml
# templates/_monitoring.tpl

{{/*
Prometheus ServiceMonitor for automatic scraping.
Requires prometheus-operator to be installed.
*/}}
{{- define "platform-library.servicemonitor" -}}
{{- if and .Values.metrics.enabled .Values.metrics.serviceMonitor.enabled -}}
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: {{ include "platform-library.fullname" . }}
  labels:
    {{- include "platform-library.labels.standard" . | nindent 4 }}
    {{- with .Values.metrics.serviceMonitor.additionalLabels }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
spec:
  selector:
    matchLabels:
      {{- include "platform-library.labels.selector" . | nindent 6 }}
  endpoints:
    - port: {{ .Values.metrics.portName | default "metrics" }}
      path: {{ .Values.metrics.path | default "/metrics" }}
      interval: {{ .Values.metrics.serviceMonitor.interval | default "30s" }}
      scrapeTimeout: {{ .Values.metrics.serviceMonitor.scrapeTimeout | default "10s" }}
      {{- if .Values.metrics.serviceMonitor.relabelings }}
      relabelings:
        {{- toYaml .Values.metrics.serviceMonitor.relabelings | nindent 8 }}
      {{- end }}
{{- end }}
{{- end }}
```

## Shared Values Schema

Library charts should document their expected values using a JSON schema file. Application charts that use the library inherit schema validation:

```json
// values.schema.json in the library chart
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Platform Library Values",
  "type": "object",
  "properties": {
    "global": {
      "type": "object",
      "properties": {
        "platform": {
          "type": "string",
          "description": "Platform name for app.kubernetes.io/part-of label"
        },
        "team": {
          "type": "string",
          "description": "Team name for cost allocation labels"
        },
        "costCenter": {
          "type": "string",
          "pattern": "^CC[0-9]{4}$",
          "description": "Cost center code in format CC followed by 4 digits"
        },
        "environment": {
          "type": "string",
          "enum": ["development", "staging", "production"],
          "description": "Deployment environment"
        },
        "defaultResources": {
          "type": "object",
          "properties": {
            "requests": {
              "type": "object",
              "properties": {
                "cpu": { "type": "string" },
                "memory": { "type": "string" }
              }
            },
            "limits": {
              "type": "object",
              "properties": {
                "cpu": { "type": "string" },
                "memory": { "type": "string" }
              }
            }
          }
        }
      }
    },
    "metrics": {
      "type": "object",
      "properties": {
        "enabled": {
          "type": "boolean",
          "default": true
        },
        "path": {
          "type": "string",
          "default": "/metrics"
        },
        "portName": {
          "type": "string",
          "default": "metrics"
        },
        "serviceMonitor": {
          "type": "object",
          "properties": {
            "enabled": { "type": "boolean", "default": false },
            "interval": { "type": "string", "default": "30s" },
            "scrapeTimeout": { "type": "string", "default": "10s" }
          }
        }
      }
    }
  }
}
```

## Application Chart Using the Library

An application chart declares the library as a dependency in `Chart.yaml`:

```yaml
# myapp/Chart.yaml
apiVersion: v2
name: myapp
description: My application Helm chart
type: application
version: 1.5.0
appVersion: "3.2.1"
dependencies:
  - name: platform-library
    version: ">=2.1.0 <3.0.0"
    repository: "oci://registry.platform.io/helm-charts"
```

After `helm dependency update`, the library is available in `charts/`. Using library templates in the application chart:

```yaml
# myapp/templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "platform-library.fullname" . }}
  labels:
    {{- include "platform-library.labels.standard" . | nindent 4 }}
    {{- include "platform-library.labels.cost" . | nindent 4 }}
spec:
  {{- if not .Values.autoscaling.enabled }}
  replicas: {{ .Values.replicaCount | default 2 }}
  {{- end }}
  selector:
    matchLabels:
      {{- include "platform-library.labels.selector" . | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "platform-library.labels.standard" . | nindent 8 }}
    spec:
      securityContext:
        {{- include "platform-library.pod.securityContext" . | nindent 8 }}
      containers:
        - name: {{ .Chart.Name }}
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
          securityContext:
            {{- include "platform-library.container.securityContext" . | nindent 12 }}
          ports:
            - name: http
              containerPort: {{ .Values.containerPort | default 8080 }}
              protocol: TCP
            {{- if .Values.metrics.enabled }}
            - name: {{ .Values.metrics.portName | default "metrics" }}
              containerPort: {{ .Values.metrics.port | default 9090 }}
              protocol: TCP
            {{- end }}
          resources:
            {{- include "platform-library.container.resources" . | nindent 12 }}
          livenessProbe:
            httpGet:
              path: {{ .Values.healthcheck.liveness.path | default "/healthz" }}
              port: http
            initialDelaySeconds: {{ .Values.healthcheck.liveness.initialDelaySeconds | default 30 }}
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: {{ .Values.healthcheck.readiness.path | default "/ready" }}
              port: http
            initialDelaySeconds: {{ .Values.healthcheck.readiness.initialDelaySeconds | default 10 }}
            periodSeconds: 5
```

```yaml
# myapp/templates/monitoring.yaml
{{- include "platform-library.servicemonitor" . }}
```

```yaml
# myapp/templates/ingress.yaml
{{- include "platform-library.ingress" . }}
```

## Monorepo Chart Organization

Large organizations often manage dozens of application charts alongside their library in a monorepo:

```
platform-charts/
├── library/
│   ├── platform-library/
│   │   ├── Chart.yaml
│   │   ├── values.schema.json
│   │   └── templates/
│   │       ├── _labels.tpl
│   │       ├── _security.tpl
│   │       ├── _resources.tpl
│   │       ├── _ingress.tpl
│   │       └── _monitoring.tpl
├── apps/
│   ├── api-gateway/
│   │   ├── Chart.yaml
│   │   ├── values.yaml
│   │   ├── values-staging.yaml
│   │   ├── values-production.yaml
│   │   └── templates/
│   ├── user-service/
│   │   ├── Chart.yaml
│   │   └── ...
│   └── payment-service/
│       ├── Chart.yaml
│       └── ...
├── infrastructure/
│   ├── cert-manager/
│   ├── ingress-nginx/
│   └── prometheus-stack/
├── Makefile
└── .github/
    └── workflows/
        └── chart-release.yaml
```

### Makefile for Monorepo Operations

```makefile
# Makefile

REGISTRY := oci://registry.platform.io/helm-charts
LIBRARY_DIR := library/platform-library
APPS_DIR := apps

.PHONY: library-package library-push app-deps app-lint test

library-version:
	@grep "^version:" $(LIBRARY_DIR)/Chart.yaml | awk '{print $$2}'

library-package:
	helm package $(LIBRARY_DIR) --destination .dist/

library-push: library-package
	helm push .dist/platform-library-*.tgz $(REGISTRY)

app-deps:
	@for chart in $(APPS_DIR)/*/; do \
		echo "Updating deps for $${chart}..."; \
		helm dependency update $${chart}; \
	done

app-lint: app-deps
	@for chart in $(APPS_DIR)/*/; do \
		echo "Linting $${chart}..."; \
		helm lint $${chart} --values $${chart}/values.yaml; \
	done

test:
	@for chart in $(APPS_DIR)/*/; do \
		echo "Testing $${chart}..."; \
		helm unittest $${chart}; \
	done

template-diff:
	@for chart in $(APPS_DIR)/*/; do \
		helm diff upgrade --install \
			$$(basename $${chart}) $${chart} \
			-n production; \
	done
```

## Testing Library Charts with helm-unittest

`helm-unittest` is a YAML-based testing framework for Helm charts. Library charts cannot be tested directly (they produce no output), but test charts that consume the library can validate the output:

```bash
# Install helm-unittest
helm plugin install https://github.com/helm-unittest/helm-unittest
```

### Test Chart Structure

Create a minimal test application chart that exercises all library templates:

```
tests/
└── library-test-chart/
    ├── Chart.yaml
    ├── values.yaml
    ├── templates/
    │   ├── deployment.yaml
    │   ├── ingress.yaml
    │   └── servicemonitor.yaml
    └── tests/
        ├── deployment_test.yaml
        ├── ingress_test.yaml
        ├── labels_test.yaml
        └── security_test.yaml
```

```yaml
# tests/library-test-chart/tests/labels_test.yaml
suite: "Platform Library - Standard Labels"
templates:
  - templates/deployment.yaml

tests:
  - it: "should render app.kubernetes.io/name from chart name"
    set:
      global.team: platform-team
      global.costCenter: CC0042
    asserts:
      - matchRegex:
          path: metadata.labels["app.kubernetes.io/name"]
          pattern: "^[a-z0-9-]+$"
      - equal:
          path: metadata.labels["platform.io/team"]
          value: "platform-team"
      - equal:
          path: metadata.labels["platform.io/cost-center"]
          value: "CC0042"

  - it: "should include helm chart version in labels"
    asserts:
      - isNotNull:
          path: metadata.labels["helm.sh/chart"]

  - it: "should use nameOverride when provided"
    set:
      nameOverride: "custom-name"
    asserts:
      - equal:
          path: metadata.labels["app.kubernetes.io/name"]
          value: "custom-name"
```

```yaml
# tests/library-test-chart/tests/security_test.yaml
suite: "Platform Library - Security Contexts"
templates:
  - templates/deployment.yaml

tests:
  - it: "should set runAsNonRoot on pod security context"
    asserts:
      - equal:
          path: spec.template.spec.securityContext.runAsNonRoot
          value: true

  - it: "should apply seccompProfile RuntimeDefault"
    asserts:
      - equal:
          path: spec.template.spec.securityContext.seccompProfile.type
          value: RuntimeDefault

  - it: "should drop all capabilities on container security context"
    asserts:
      - contains:
          path: spec.template.spec.containers[0].securityContext.capabilities.drop
          content: ALL

  - it: "should disallow privilege escalation"
    asserts:
      - equal:
          path: spec.template.spec.containers[0].securityContext.allowPrivilegeEscalation
          value: false

  - it: "should allow security context override from values"
    set:
      podSecurityContext:
        runAsUser: 1000
        runAsGroup: 1000
    asserts:
      - equal:
          path: spec.template.spec.securityContext.runAsUser
          value: 1000
```

```yaml
# tests/library-test-chart/tests/ingress_test.yaml
suite: "Platform Library - Ingress"
templates:
  - templates/ingress.yaml

tests:
  - it: "should not render ingress when disabled"
    set:
      ingress.enabled: false
    asserts:
      - hasDocuments:
          count: 0

  - it: "should render ingress with TLS when enabled"
    set:
      ingress.enabled: true
      ingress.className: nginx
      ingress.hosts:
        - host: myapp.example.com
          paths:
            - path: /
              pathType: Prefix
      ingress.tls:
        - hosts:
            - myapp.example.com
          secretName: myapp-tls
    asserts:
      - hasDocuments:
          count: 1
      - equal:
          path: spec.ingressClassName
          value: nginx
      - equal:
          path: spec.tls[0].secretName
          value: myapp-tls

  - it: "should render rate limit annotations when configured"
    set:
      ingress.enabled: true
      ingress.rateLimit:
        requestsPerSecond: "100"
        connections: "50"
      ingress.hosts:
        - host: myapp.example.com
          paths:
            - path: /
    asserts:
      - equal:
          path: metadata.annotations["nginx.ingress.kubernetes.io/limit-rps"]
          value: "100"
```

Running the tests:

```bash
# Run all tests
helm unittest tests/library-test-chart/

# Run with coverage report
helm unittest tests/library-test-chart/ -o test-results.xml -t JUnit

# Run specific test suite
helm unittest tests/library-test-chart/ \
  --file 'tests/security_test.yaml'
```

## Publishing to OCI Registries

Helm 3.8+ supports OCI registries as the primary distribution mechanism, superseding HTTP chart repositories.

### Publishing the Library

```bash
# Login to OCI registry
helm registry login registry.platform.io \
  --username <registry-username> \
  --password <registry-password>

# Package and push
helm package library/platform-library \
  --destination .dist/

helm push .dist/platform-library-2.1.0.tgz \
  oci://registry.platform.io/helm-charts

# Verify the push
helm show chart \
  oci://registry.platform.io/helm-charts/platform-library:2.1.0
```

### CI/CD Pipeline for Library Release

```yaml
# .github/workflows/chart-release.yaml
name: Chart Release

on:
  push:
    branches: [main]
    paths:
      - 'library/platform-library/**'
      - 'tests/library-test-chart/**'

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Helm
        uses: azure/setup-helm@v3
        with:
          version: v3.16.0

      - name: Install helm-unittest
        run: |
          helm plugin install https://github.com/helm-unittest/helm-unittest

      - name: Update test chart dependencies
        run: |
          helm dependency update tests/library-test-chart/

      - name: Run unit tests
        run: |
          helm unittest tests/library-test-chart/ \
            --output-type JUnit \
            --output-file test-results.xml

      - name: Publish test results
        uses: EnricoMi/publish-unit-test-result-action@v2
        if: always()
        with:
          junit_files: test-results.xml

  release:
    runs-on: ubuntu-latest
    needs: test
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4

      - name: Get library version
        id: version
        run: |
          VERSION=$(grep "^version:" library/platform-library/Chart.yaml | awk '{print $2}')
          echo "version=$VERSION" >> $GITHUB_OUTPUT

      - name: Check if version already published
        id: check
        run: |
          if helm show chart \
            oci://registry.platform.io/helm-charts/platform-library:${{ steps.version.outputs.version }} \
            2>/dev/null; then
            echo "exists=true" >> $GITHUB_OUTPUT
          else
            echo "exists=false" >> $GITHUB_OUTPUT
          fi

      - name: Package and push library chart
        if: steps.check.outputs.exists == 'false'
        run: |
          helm registry login registry.platform.io \
            --username "${{ secrets.REGISTRY_USERNAME }}" \
            --password "${{ secrets.REGISTRY_PASSWORD }}"
          helm package library/platform-library --destination .dist/
          helm push .dist/platform-library-${{ steps.version.outputs.version }}.tgz \
            oci://registry.platform.io/helm-charts

      - name: Create GitHub release
        if: steps.check.outputs.exists == 'false'
        uses: softprops/action-gh-release@v2
        with:
          tag_name: "platform-library-${{ steps.version.outputs.version }}"
          name: "Platform Library ${{ steps.version.outputs.version }}"
          files: .dist/platform-library-*.tgz
```

## Version Management and Deprecation

### Semantic Versioning for Library Charts

Library chart versions have semantic meaning for consumers:

- **Patch**: Bug fixes in template rendering, no output changes
- **Minor**: New templates or new optional template parameters (backwards compatible)
- **Major**: Template renames, removed templates, changed required parameters (breaking changes)

### Deprecation Pattern

When removing or renaming a template:

```yaml
# templates/_deprecated.tpl

{{/*
DEPRECATED: use "platform-library.pod.securityContext" instead.
This template will be removed in version 3.0.0.
*/}}
{{- define "platform-library.securityContext" -}}
{{- /* Log deprecation warning */}}
{{- $_ := required "WARNING: platform-library.securityContext is deprecated. Migrate to platform-library.pod.securityContext before upgrading to v3.0.0" "" -}}
{{- include "platform-library.pod.securityContext" . }}
{{- end }}
```

Using `required` with an empty string emits a warning without failing (prior to removing in the next major version, convert to a hard failure by using `fail`).

## Summary

Helm library charts are the foundation of scalable enterprise chart architectures. By encoding security contexts, label standards, ingress patterns, and monitoring configurations as named templates in a versioned library, platform teams ensure consistency across every application chart in the organization. The combination of JSON schema validation, helm-unittest automated testing, and OCI registry publishing creates a reliable, testable chart delivery pipeline that scales from a handful of services to hundreds while preventing configuration drift and enforcing organizational standards at the Helm template layer.
