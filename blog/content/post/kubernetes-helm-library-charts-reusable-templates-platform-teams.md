---
title: "Kubernetes Helm Library Charts: Reusable Templates for Platform Teams"
date: 2031-04-19T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Helm", "DevOps", "Platform Engineering", "GitOps", "Templates", "Testing"]
categories:
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to building and maintaining Helm library charts for platform teams, covering named template definitions, default values inheritance, partial chart composition, versioning strategy, using library charts across multiple application charts, and testing with helm-unittest."
more_link: "yes"
url: "/kubernetes-helm-library-charts-reusable-templates-platform-teams/"
---

Helm library charts transform repetitive Kubernetes configuration into reusable, versioned template functions that application teams consume with minimal configuration. As Kubernetes deployments grow, the overhead of maintaining consistent security policies, resource configurations, and observability instrumentation across dozens of microservices becomes significant. Library charts solve this by centralizing these concerns in the platform team's domain while giving application teams a simple, opinionated interface. This guide covers library chart creation, named templates, default inheritance, composition patterns, versioning, and comprehensive testing.

<!--more-->

# Kubernetes Helm Library Charts: Reusable Templates for Platform Teams

## Section 1: Library Chart Concepts

A library chart (type: library) differs from a regular application chart:

```
Regular Chart (type: application):
- Contains templates that render to Kubernetes manifests
- Can be deployed directly with helm install
- Has its own Chart.yaml, values.yaml, templates/

Library Chart (type: library):
- Contains ONLY named templates (helpers)
- CANNOT be deployed directly (no rendered manifests)
- Can ONLY be used as a dependency in other charts
- Provides reusable _helpers.tpl functions
- Must be declared as dependency in consuming charts
```

### Why Library Charts for Platform Teams

```
Without library charts (copy-paste maintenance nightmare):
├── service-a/
│   └── templates/
│       ├── deployment.yaml    # 200 lines with security policies
│       ├── service.yaml       # 50 lines
│       └── ingress.yaml       # 80 lines
├── service-b/
│   └── templates/
│       ├── deployment.yaml    # Same 200 lines (slightly different)
│       ├── service.yaml       # Same 50 lines
│       └── ingress.yaml       # Same 80 lines
... (x30 services)

Problems:
- Security policy update requires touching 30 deployments
- Drift between services over time
- No standard for new services

With library charts:
├── platform-library/           # Platform team owns this
│   └── templates/
│       └── _deployment.tpl     # 200 lines of standards
├── service-a/
│   ├── Chart.yaml              # depends: [platform-library]
│   └── values.yaml             # 20 lines of config
├── service-b/
│   ├── Chart.yaml
│   └── values.yaml             # Different values, same template

Benefits:
- Security update in one place
- Consistency guaranteed by template
- New services get all policies automatically
```

## Section 2: Creating the Library Chart

### Directory Structure

```
platform-library/
├── Chart.yaml
├── README.md
├── values.yaml          # Default values (used for testing only)
├── templates/
│   ├── _deployment.tpl  # Deployment template
│   ├── _service.tpl     # Service template
│   ├── _ingress.tpl     # Ingress template
│   ├── _configmap.tpl   # ConfigMap template
│   ├── _hpa.tpl         # HorizontalPodAutoscaler template
│   ├── _pdb.tpl         # PodDisruptionBudget template
│   ├── _serviceaccount.tpl
│   ├── _networkpolicy.tpl
│   ├── _helpers.tpl     # Utility functions
│   └── NOTES.txt
└── ci/
    └── test-values.yaml # Values for CI testing
```

### Chart.yaml

```yaml
# platform-library/Chart.yaml
apiVersion: v2
name: platform-library
description: |
  Platform engineering library chart providing standardized Kubernetes
  workload templates with security hardening, observability, and
  operational best practices built in.

# CRITICAL: type must be "library"
type: library

version: 1.5.0
appVersion: "1.0"

keywords:
  - library
  - platform
  - templates

maintainers:
  - name: Platform Team
    email: platform@example.com
    url: https://wiki.example.com/platform

sources:
  - https://github.com/example/platform-library

annotations:
  # Signal minimum Helm version
  "helm.sh/min-helm-version": "3.8.0"
```

## Section 3: Named Template Definitions

### _helpers.tpl - Utility Functions

```yaml
{{/*
platform-library/templates/_helpers.tpl
Utility functions shared across all templates
*/}}

{{/*
Expand the name of the chart.
*/}}
{{- define "platform.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this.
*/}}
{{- define "platform.fullname" -}}
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
Create chart label value.
*/}}
{{- define "platform.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Standard labels applied to all resources.
These labels are used for Kubernetes selectors and GitOps tooling.
*/}}
{{- define "platform.labels" -}}
helm.sh/chart: {{ include "platform.chart" . }}
{{ include "platform.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: {{ .Values.partOf | default .Release.Name }}
{{- if .Values.team }}
app.kubernetes.io/team: {{ .Values.team }}
{{- end }}
{{- range $k, $v := .Values.additionalLabels }}
{{ $k }}: {{ $v | quote }}
{{- end }}
{{- end }}

{{/*
Selector labels - used in matchLabels (must remain stable across upgrades)
*/}}
{{- define "platform.selectorLabels" -}}
app.kubernetes.io/name: {{ include "platform.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use.
*/}}
{{- define "platform.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "platform.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Get the image pull policy.
Defaults to IfNotPresent for tags, Always for latest.
*/}}
{{- define "platform.imagePullPolicy" -}}
{{- if .Values.image.pullPolicy }}
{{- .Values.image.pullPolicy }}
{{- else if eq (toString .Values.image.tag) "latest" }}
{{- "Always" }}
{{- else }}
{{- "IfNotPresent" }}
{{- end }}
{{- end }}

{{/*
Standard security context for pods.
Applications can override specific fields.
*/}}
{{- define "platform.podSecurityContext" -}}
{{- $defaults := dict
  "runAsNonRoot" true
  "runAsUser" 65534
  "runAsGroup" 65534
  "fsGroup" 65534
  "fsGroupChangePolicy" "OnRootMismatch"
  "seccompProfile" (dict "type" "RuntimeDefault")
-}}
{{- $merged := merge (.Values.podSecurityContext | default dict) $defaults -}}
{{- toYaml $merged | nindent 0 -}}
{{- end }}

{{/*
Standard container security context.
*/}}
{{- define "platform.containerSecurityContext" -}}
{{- $defaults := dict
  "allowPrivilegeEscalation" false
  "readOnlyRootFilesystem" true
  "runAsNonRoot" true
  "runAsUser" 65534
  "capabilities" (dict "drop" (list "ALL"))
  "seccompProfile" (dict "type" "RuntimeDefault")
-}}
{{- $merged := merge (.Values.securityContext | default dict) $defaults -}}
{{- toYaml $merged | nindent 0 -}}
{{- end }}

{{/*
Topology spread constraints for high availability.
Spreads pods across zones and nodes.
*/}}
{{- define "platform.topologySpreadConstraints" -}}
{{- if .Values.topologySpread.enabled }}
- maxSkew: 1
  topologyKey: topology.kubernetes.io/zone
  whenUnsatisfiable: {{ .Values.topologySpread.whenUnsatisfiable | default "DoNotSchedule" }}
  labelSelector:
    matchLabels:
      {{- include "platform.selectorLabels" . | nindent 6 }}
- maxSkew: 1
  topologyKey: kubernetes.io/hostname
  whenUnsatisfiable: ScheduleAnyway
  labelSelector:
    matchLabels:
      {{- include "platform.selectorLabels" . | nindent 6 }}
{{- end }}
{{- end }}

{{/*
Standard probe defaults.
Merges application-specific overrides with platform defaults.
*/}}
{{- define "platform.livenessProbe" -}}
{{- $defaults := dict
  "httpGet" (dict "path" "/healthz" "port" "http")
  "initialDelaySeconds" 30
  "periodSeconds" 10
  "timeoutSeconds" 5
  "failureThreshold" 3
  "successThreshold" 1
-}}
{{- mergeOverwrite $defaults (.Values.livenessProbe | default dict) | toYaml | nindent 0 -}}
{{- end }}

{{- define "platform.readinessProbe" -}}
{{- $defaults := dict
  "httpGet" (dict "path" "/readyz" "port" "http")
  "initialDelaySeconds" 10
  "periodSeconds" 5
  "timeoutSeconds" 3
  "failureThreshold" 3
  "successThreshold" 1
-}}
{{- mergeOverwrite $defaults (.Values.readinessProbe | default dict) | toYaml | nindent 0 -}}
{{- end }}

{{- define "platform.startupProbe" -}}
{{- if .Values.startupProbe }}
{{- $defaults := dict
  "httpGet" (dict "path" "/healthz" "port" "http")
  "initialDelaySeconds" 5
  "periodSeconds" 5
  "timeoutSeconds" 3
  "failureThreshold" 30
  "successThreshold" 1
-}}
{{- mergeOverwrite $defaults (.Values.startupProbe | default dict) | toYaml | nindent 0 -}}
{{- end }}
{{- end }}
```

### _deployment.tpl - Full Deployment Template

```yaml
{{/*
platform-library/templates/_deployment.tpl
Renders a complete, hardened Deployment.
Usage: {{ include "platform.deployment" . }}
*/}}
{{- define "platform.deployment" -}}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "platform.fullname" . }}
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "platform.labels" . | nindent 4 }}
  {{- with .Values.deploymentAnnotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
spec:
  {{- if not .Values.autoscaling.enabled }}
  replicas: {{ .Values.replicaCount }}
  {{- end }}

  selector:
    matchLabels:
      {{- include "platform.selectorLabels" . | nindent 6 }}

  strategy:
    {{- if eq (.Values.deploymentStrategy | default "RollingUpdate") "Recreate" }}
    type: Recreate
    {{- else }}
    type: RollingUpdate
    rollingUpdate:
      maxSurge: {{ .Values.rollingUpdate.maxSurge | default "25%" }}
      maxUnavailable: {{ .Values.rollingUpdate.maxUnavailable | default "0" }}
    {{- end }}

  # Minimum time before considering pod available
  minReadySeconds: {{ .Values.minReadySeconds | default 10 }}

  # Keep history for rollback
  revisionHistoryLimit: {{ .Values.revisionHistoryLimit | default 3 }}

  template:
    metadata:
      annotations:
        # Force pod restart on configmap/secret changes
        checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
        {{- if .Values.prometheus.enabled }}
        prometheus.io/scrape: "true"
        prometheus.io/port: {{ .Values.prometheus.port | default "9090" | quote }}
        prometheus.io/path: {{ .Values.prometheus.path | default "/metrics" | quote }}
        {{- end }}
        {{- with .Values.podAnnotations }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
      labels:
        {{- include "platform.selectorLabels" . | nindent 8 }}
        {{- with .Values.podLabels }}
        {{- toYaml . | nindent 8 }}
        {{- end }}

    spec:
      serviceAccountName: {{ include "platform.serviceAccountName" . }}

      # Security context for the pod
      securityContext:
        {{- include "platform.podSecurityContext" . | nindent 8 }}

      # Termination grace period
      terminationGracePeriodSeconds: {{ .Values.terminationGracePeriodSeconds | default 60 }}

      # Priority class for workload criticality
      {{- if .Values.priorityClassName }}
      priorityClassName: {{ .Values.priorityClassName }}
      {{- end }}

      # Topology spread for HA
      {{- include "platform.topologySpreadConstraints" . | nindent 6 }}

      # Affinity rules
      {{- with .Values.affinity }}
      affinity:
        {{- toYaml . | nindent 8 }}
      {{- else }}
      {{- if .Values.podAntiAffinity.enabled }}
      affinity:
        podAntiAffinity:
          {{- if eq (.Values.podAntiAffinity.type | default "preferred") "required" }}
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  {{- include "platform.selectorLabels" . | nindent 18 }}
              topologyKey: kubernetes.io/hostname
          {{- else }}
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    {{- include "platform.selectorLabels" . | nindent 20 }}
                topologyKey: kubernetes.io/hostname
          {{- end }}
      {{- end }}
      {{- end }}

      # Node selector
      {{- with .Values.nodeSelector }}
      nodeSelector:
        {{- toYaml . | nindent 8 }}
      {{- end }}

      # Tolerations
      {{- with .Values.tolerations }}
      tolerations:
        {{- toYaml . | nindent 8 }}
      {{- end }}

      # Image pull secrets
      {{- with .Values.imagePullSecrets }}
      imagePullSecrets:
        {{- toYaml . | nindent 8 }}
      {{- end }}

      # Init containers
      {{- with .Values.initContainers }}
      initContainers:
        {{- toYaml . | nindent 8 }}
      {{- end }}

      containers:
        - name: {{ .Chart.Name }}
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
          imagePullPolicy: {{ include "platform.imagePullPolicy" . }}

          # Container security context
          securityContext:
            {{- include "platform.containerSecurityContext" . | nindent 12 }}

          # Ports
          ports:
            - name: http
              containerPort: {{ .Values.service.targetPort | default 8080 }}
              protocol: TCP
            {{- if .Values.prometheus.enabled }}
            - name: metrics
              containerPort: {{ .Values.prometheus.port | default 9090 }}
              protocol: TCP
            {{- end }}
            {{- with .Values.additionalPorts }}
            {{- toYaml . | nindent 12 }}
            {{- end }}

          # Health probes
          livenessProbe:
            {{- include "platform.livenessProbe" . | nindent 12 }}

          readinessProbe:
            {{- include "platform.readinessProbe" . | nindent 12 }}

          {{- if .Values.startupProbe }}
          startupProbe:
            {{- include "platform.startupProbe" . | nindent 12 }}
          {{- end }}

          # Environment variables
          {{- with .Values.env }}
          env:
            {{- toYaml . | nindent 12 }}
          {{- end }}

          # Environment from ConfigMaps/Secrets
          {{- with .Values.envFrom }}
          envFrom:
            {{- toYaml . | nindent 12 }}
          {{- end }}

          # Resource limits
          resources:
            {{- toYaml .Values.resources | nindent 12 }}

          # Volume mounts
          {{- with .Values.volumeMounts }}
          volumeMounts:
            {{- toYaml . | nindent 12 }}
          {{- end }}

          # Lifecycle hooks
          {{- with .Values.lifecycle }}
          lifecycle:
            {{- toYaml . | nindent 12 }}
          {{- end }}

        # Sidecar containers
        {{- with .Values.sidecars }}
        {{- toYaml . | nindent 8 }}
        {{- end }}

      # Volumes
      {{- with .Values.volumes }}
      volumes:
        {{- toYaml . | nindent 8 }}
      {{- end }}

      # DNS configuration
      {{- with .Values.dnsConfig }}
      dnsConfig:
        {{- toYaml . | nindent 8 }}
      {{- end }}
{{- end }}
```

### _service.tpl

```yaml
{{/*
platform-library/templates/_service.tpl
*/}}
{{- define "platform.service" -}}
apiVersion: v1
kind: Service
metadata:
  name: {{ include "platform.fullname" . }}
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "platform.labels" . | nindent 4 }}
  {{- with .Values.service.annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
spec:
  type: {{ .Values.service.type | default "ClusterIP" }}
  {{- if and (eq .Values.service.type "LoadBalancer") .Values.service.loadBalancerIP }}
  loadBalancerIP: {{ .Values.service.loadBalancerIP }}
  {{- end }}
  {{- if and (eq .Values.service.type "LoadBalancer") .Values.service.loadBalancerSourceRanges }}
  loadBalancerSourceRanges:
    {{- toYaml .Values.service.loadBalancerSourceRanges | nindent 4 }}
  {{- end }}
  # sessionAffinity for sticky sessions
  {{- if .Values.service.sessionAffinity }}
  sessionAffinity: {{ .Values.service.sessionAffinity }}
  {{- if eq .Values.service.sessionAffinity "ClientIP" }}
  sessionAffinityConfig:
    clientIP:
      timeoutSeconds: {{ .Values.service.sessionAffinityTimeout | default 10800 }}
  {{- end }}
  {{- end }}
  ports:
    - port: {{ .Values.service.port | default 80 }}
      targetPort: http
      protocol: TCP
      name: http
      {{- if and (eq .Values.service.type "NodePort") .Values.service.nodePort }}
      nodePort: {{ .Values.service.nodePort }}
      {{- end }}
    {{- if .Values.prometheus.enabled }}
    - port: {{ .Values.prometheus.port | default 9090 }}
      targetPort: metrics
      protocol: TCP
      name: metrics
    {{- end }}
    {{- with .Values.service.additionalPorts }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
  selector:
    {{- include "platform.selectorLabels" . | nindent 4 }}
{{- end }}
```

### _hpa.tpl - HorizontalPodAutoscaler

```yaml
{{/*
platform-library/templates/_hpa.tpl
*/}}
{{- define "platform.hpa" -}}
{{- if .Values.autoscaling.enabled }}
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {{ include "platform.fullname" . }}
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "platform.labels" . | nindent 4 }}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {{ include "platform.fullname" . }}
  minReplicas: {{ .Values.autoscaling.minReplicas | default 2 }}
  maxReplicas: {{ .Values.autoscaling.maxReplicas | default 10 }}
  metrics:
    {{- if .Values.autoscaling.targetCPUUtilizationPercentage }}
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: {{ .Values.autoscaling.targetCPUUtilizationPercentage }}
    {{- end }}
    {{- if .Values.autoscaling.targetMemoryUtilizationPercentage }}
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: {{ .Values.autoscaling.targetMemoryUtilizationPercentage }}
    {{- end }}
    {{- with .Values.autoscaling.customMetrics }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
  behavior:
    scaleDown:
      stabilizationWindowSeconds: {{ .Values.autoscaling.scaleDownStabilizationWindow | default 300 }}
      policies:
        - type: Percent
          value: {{ .Values.autoscaling.scaleDownPercent | default 25 }}
          periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: {{ .Values.autoscaling.scaleUpStabilizationWindow | default 0 }}
      policies:
        - type: Pods
          value: {{ .Values.autoscaling.scaleUpPods | default 4 }}
          periodSeconds: 60
        - type: Percent
          value: {{ .Values.autoscaling.scaleUpPercent | default 100 }}
          periodSeconds: 60
{{- end }}
{{- end }}
```

## Section 4: Default Values with Documentation

```yaml
# platform-library/values.yaml
# These defaults are used when testing the library chart
# and as reference documentation for consuming charts

# Override the chart name
nameOverride: ""
fullnameOverride: ""

# Team label applied to all resources
team: ""

# Workload type annotation
partOf: ""

# Additional labels added to all resources
additionalLabels: {}

# Image configuration
image:
  repository: nginx
  tag: "latest"
  pullPolicy: ""  # Auto-detected: IfNotPresent for tags, Always for latest

imagePullSecrets: []

# Replica count (when autoscaling is disabled)
replicaCount: 2

# Deployment strategy
deploymentStrategy: RollingUpdate
rollingUpdate:
  maxSurge: "25%"
  maxUnavailable: "0"

minReadySeconds: 10
revisionHistoryLimit: 3
terminationGracePeriodSeconds: 60

# Service account
serviceAccount:
  create: true
  name: ""
  annotations: {}

# Pod security context (merged with hardened defaults)
# Defaults: runAsNonRoot=true, runAsUser=65534, seccompProfile=RuntimeDefault
podSecurityContext: {}
  # Override example:
  # runAsUser: 1000
  # fsGroup: 2000

# Container security context (merged with hardened defaults)
# Defaults: allowPrivilegeEscalation=false, readOnlyRootFilesystem=true
securityContext: {}
  # Override example:
  # readOnlyRootFilesystem: false  # For apps needing file writes

# Resources (no defaults - application teams MUST set these)
resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 256Mi

# Service configuration
service:
  type: ClusterIP
  port: 80
  targetPort: 8080
  annotations: {}
  additionalPorts: []

# Prometheus metrics
prometheus:
  enabled: true
  port: 9090
  path: /metrics

# Health probes (merged with defaults)
# Defaults use /healthz and /readyz on the http port
livenessProbe: {}
  # Override example:
  # httpGet:
  #   path: /health
  #   port: 8080
  # initialDelaySeconds: 60

readinessProbe: {}

startupProbe: {}

# Autoscaling
autoscaling:
  enabled: false
  minReplicas: 2
  maxReplicas: 10
  targetCPUUtilizationPercentage: 70
  targetMemoryUtilizationPercentage: 80
  scaleDownStabilizationWindow: 300
  customMetrics: []

# PodDisruptionBudget
podDisruptionBudget:
  enabled: true
  minAvailable: 1

# Topology spread for HA across zones
topologySpread:
  enabled: true
  whenUnsatisfiable: ScheduleAnyway

# Pod anti-affinity for HA across nodes
podAntiAffinity:
  enabled: true
  type: preferred  # or "required"

# Environment variables
env: []
envFrom: []

# Volume mounts and volumes
volumeMounts: []
volumes: []

# Sidecar containers
sidecars: []

# Init containers
initContainers: []

# Additional port definitions
additionalPorts: []

# Deployment annotations
deploymentAnnotations: {}

# Pod annotations
podAnnotations: {}

# Pod labels
podLabels: {}

# Node selector, tolerations, affinity
nodeSelector: {}
tolerations: []
affinity: {}

# Lifecycle hooks
lifecycle: {}

# Priority class
priorityClassName: ""

# Network policy
networkPolicy:
  enabled: false
  ingressRules: []
  egressRules: []

# Ingress
ingress:
  enabled: false
  className: nginx
  annotations: {}
  hosts: []
  tls: []
```

## Section 5: Consuming Library Charts in Application Charts

### Application Chart Chart.yaml

```yaml
# my-service/Chart.yaml
apiVersion: v2
name: my-service
description: My application service
type: application
version: 1.0.0
appVersion: "2.1.0"

dependencies:
  - name: platform-library
    version: "~1.5.0"   # Allow patch updates automatically
    repository: "https://charts.example.com/platform"
    # Or use OCI:
    # repository: "oci://ghcr.io/example/charts"
```

```bash
# Update dependencies
helm dependency update my-service/
# Creates: my-service/charts/platform-library-1.5.0.tgz
```

### Application Chart Templates

```yaml
# my-service/templates/deployment.yaml
# Delegates entirely to the library chart
{{- include "platform.deployment" . }}
```

```yaml
# my-service/templates/service.yaml
{{- include "platform.service" . }}
```

```yaml
# my-service/templates/hpa.yaml
{{- include "platform.hpa" . }}
```

```yaml
# my-service/templates/pdb.yaml
{{- include "platform.pdb" . }}
```

### Application-Specific values.yaml

```yaml
# my-service/values.yaml
# Only configure what differs from platform defaults

image:
  repository: ghcr.io/mycompany/my-service
  tag: "2.1.0"

# Application identity
team: "backend"
partOf: "checkout-platform"

replicaCount: 3

service:
  port: 80
  targetPort: 8080

# Application-specific env vars
env:
  - name: DB_HOST
    valueFrom:
      secretKeyRef:
        name: database-credentials
        key: host
  - name: DB_PASSWORD
    valueFrom:
      secretKeyRef:
        name: database-credentials
        key: password
  - name: LOG_LEVEL
    value: "info"

# Override probe paths for this application
livenessProbe:
  httpGet:
    path: /api/health
    port: http
  initialDelaySeconds: 30

# Resources for this specific service
resources:
  requests:
    cpu: 250m
    memory: 256Mi
  limits:
    cpu: 1000m
    memory: 512Mi

# Enable HPA
autoscaling:
  enabled: true
  minReplicas: 3
  maxReplicas: 20
  targetCPUUtilizationPercentage: 65

# Override security context (this app needs write access)
securityContext:
  readOnlyRootFilesystem: false
  allowPrivilegeEscalation: false
  runAsNonRoot: true
  runAsUser: 1000

# Mount writable tmpdir
volumeMounts:
  - name: tmp
    mountPath: /tmp
  - name: cache
    mountPath: /app/cache

volumes:
  - name: tmp
    emptyDir: {}
  - name: cache
    emptyDir:
      sizeLimit: 500Mi
```

## Section 6: Versioning Strategy

```
Semantic Versioning for Library Charts:

MAJOR.MINOR.PATCH

PATCH (1.5.0 → 1.5.1):
- Bug fixes in templates
- Documentation improvements
- No behavioral changes

MINOR (1.5.0 → 1.6.0):
- New optional features (new optional values)
- New template helpers
- Backward compatible changes

MAJOR (1.5.0 → 2.0.0):
- Breaking changes to template interface
- Removed template helpers
- Changed default values that affect existing deployments

Example consuming chart pinning strategies:
- "~1.5.0" - Allow patch updates (1.5.x) - RECOMMENDED
- ">=1.5.0 <2.0.0" - Allow minor updates - For more flexibility
- "1.5.0" - Exact version - Maximum stability
```

### CHANGELOG.md Template

```markdown
# Platform Library Chart Changelog

## 1.5.0 (2026-03-17)

### Added
- `platform.hpa` template with scale behavior configuration
- `topologySpread.enabled` value for multi-zone pod distribution
- Support for `lifecycle` hooks in deployment template
- `startupProbe` support for slow-starting applications

### Changed
- `podAntiAffinity.enabled` now defaults to `true` for all deployments
- Default `terminationGracePeriodSeconds` increased from 30 to 60

### Fixed
- Fixed label propagation bug in PDB template

## 1.4.0 (2026-02-10)

### Added
- Network policy template via `networkPolicy.enabled`
- `prometheus.path` configuration

## 1.3.0 - 1.0.0
...
```

## Section 7: Testing with helm-unittest

```bash
# Install helm-unittest plugin
helm plugin install https://github.com/helm-unittest/helm-unittest.git

# Or update
helm plugin update unittest
```

### Test Structure

```
my-service/
├── tests/
│   ├── deployment_test.yaml
│   ├── service_test.yaml
│   ├── hpa_test.yaml
│   └── security_test.yaml
└── values.yaml
```

### Deployment Tests

```yaml
# my-service/tests/deployment_test.yaml
suite: Deployment Tests
templates:
  - templates/deployment.yaml

tests:
  - it: should have correct apiVersion and kind
    asserts:
      - isKind:
          of: Deployment
      - isAPIVersion:
          of: apps/v1

  - it: should use the correct image
    set:
      image.repository: myregistry/myapp
      image.tag: v1.2.3
    asserts:
      - equal:
          path: spec.template.spec.containers[0].image
          value: myregistry/myapp:v1.2.3

  - it: should not allow privilege escalation
    asserts:
      - equal:
          path: spec.template.spec.containers[0].securityContext.allowPrivilegeEscalation
          value: false

  - it: should run as non-root
    asserts:
      - equal:
          path: spec.template.spec.containers[0].securityContext.runAsNonRoot
          value: true
      - equal:
          path: spec.template.spec.securityContext.runAsNonRoot
          value: true

  - it: should drop all capabilities
    asserts:
      - contains:
          path: spec.template.spec.containers[0].securityContext.capabilities.drop
          content: ALL

  - it: should have read-only root filesystem by default
    asserts:
      - equal:
          path: spec.template.spec.containers[0].securityContext.readOnlyRootFilesystem
          value: true

  - it: should have pod anti-affinity enabled by default
    asserts:
      - isNotEmpty:
          path: spec.template.spec.affinity.podAntiAffinity

  - it: should configure liveness probe with platform defaults
    asserts:
      - equal:
          path: spec.template.spec.containers[0].livenessProbe.httpGet.path
          value: /healthz
      - equal:
          path: spec.template.spec.containers[0].livenessProbe.initialDelaySeconds
          value: 30

  - it: should override liveness probe path
    set:
      livenessProbe.httpGet.path: /api/health
    asserts:
      - equal:
          path: spec.template.spec.containers[0].livenessProbe.httpGet.path
          value: /api/health
      - equal:
          path: spec.template.spec.containers[0].livenessProbe.initialDelaySeconds
          value: 30  # Default should still apply

  - it: should have prometheus metrics port when enabled
    set:
      prometheus.enabled: true
      prometheus.port: 9090
    asserts:
      - contains:
          path: spec.template.spec.containers[0].ports
          content:
            name: metrics
            containerPort: 9090
            protocol: TCP

  - it: should not include replica count when autoscaling is enabled
    set:
      autoscaling.enabled: true
    asserts:
      - notExists:
          path: spec.replicas

  - it: should have topology spread constraints enabled
    set:
      topologySpread.enabled: true
    asserts:
      - isNotEmpty:
          path: spec.template.spec.topologySpreadConstraints

  - it: should have correct termination grace period
    asserts:
      - equal:
          path: spec.template.spec.terminationGracePeriodSeconds
          value: 60

  - it: should apply additional labels
    set:
      additionalLabels:
        cost-center: "engineering"
        team: "platform"
    asserts:
      - equal:
          path: metadata.labels["cost-center"]
          value: engineering
      - equal:
          path: metadata.labels["team"]
          value: platform

  - it: should fail with no resources defined
    set:
      resources: null
    asserts:
      - failedTemplate:
          errorMessage: ""  # Any error is expected
```

### Security Policy Tests

```yaml
# my-service/tests/security_test.yaml
suite: Security Policy Tests
templates:
  - templates/deployment.yaml

tests:
  - it: should enforce seccomp RuntimeDefault
    asserts:
      - equal:
          path: spec.template.spec.securityContext.seccompProfile.type
          value: RuntimeDefault

  - it: should set fsGroupChangePolicy to OnRootMismatch
    asserts:
      - equal:
          path: spec.template.spec.securityContext.fsGroupChangePolicy
          value: OnRootMismatch

  - it: should not run as root by default
    asserts:
      - equal:
          path: spec.template.spec.securityContext.runAsUser
          value: 65534

  - it: should allow custom user ID override
    set:
      podSecurityContext.runAsUser: 1000
    asserts:
      - equal:
          path: spec.template.spec.securityContext.runAsUser
          value: 1000

  - it: should maintain security defaults even when overriding other values
    set:
      securityContext.readOnlyRootFilesystem: false
    asserts:
      # Should still enforce allowPrivilegeEscalation=false
      - equal:
          path: spec.template.spec.containers[0].securityContext.allowPrivilegeEscalation
          value: false
      # Should still drop all caps
      - contains:
          path: spec.template.spec.containers[0].securityContext.capabilities.drop
          content: ALL
      # But readOnlyRootFilesystem should be overridden
      - equal:
          path: spec.template.spec.containers[0].securityContext.readOnlyRootFilesystem
          value: false
```

### Running Tests

```bash
# Run all tests for a chart
helm unittest my-service/

# Run tests with verbose output
helm unittest --verbose my-service/

# Run specific test file
helm unittest --file 'tests/security_test.yaml' my-service/

# Update snapshots
helm unittest --update-snapshot my-service/

# Run tests in CI with JUnit output
helm unittest --output-type JUnit \
  --output-file test-results.xml \
  my-service/
```

## Section 8: Publishing Library Charts

```yaml
# .github/workflows/chart-publish.yml
name: Publish Helm Charts

on:
  push:
    branches: [main]
    paths:
      - 'platform-library/**'

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Helm
        uses: azure/setup-helm@v3
        with:
          version: v3.14.0

      - name: Run chart tests
        run: |
          helm plugin install https://github.com/helm-unittest/helm-unittest.git
          helm unittest platform-library/

      - name: Lint chart
        run: |
          helm lint platform-library/

      - name: Package chart
        run: |
          helm package platform-library/ --destination .helm-packages/

      - name: Push to OCI registry
        env:
          REGISTRY_PASSWORD: ${{ secrets.REGISTRY_PASSWORD }}
        run: |
          echo "${REGISTRY_PASSWORD}" | helm registry login ghcr.io \
            --username ${{ github.actor }} \
            --password-stdin

          helm push .helm-packages/platform-library-*.tgz \
            oci://ghcr.io/${{ github.repository_owner }}/charts
```

Helm library charts are a force multiplier for platform teams. By centralizing security policies, observability configurations, and operational best practices in a versioned library, application teams can focus on business logic while the platform team maintains the infrastructure standards. The combination of comprehensive helm-unittest coverage and semantic versioning ensures that library updates can be deployed with confidence, and the consuming chart interface remains clean and approachable.
