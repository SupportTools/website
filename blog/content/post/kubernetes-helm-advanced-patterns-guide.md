---
title: "Kubernetes Helm Advanced Patterns: Library Charts, Subcharts, and Post-Render Hooks"
date: 2028-05-06T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Helm", "Library Charts", "Subcharts", "Templating"]
categories: ["Kubernetes", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to advanced Helm patterns including library charts for DRY templating, subchart composition, post-render hooks for Kustomize integration, and schema validation for production Helm chart development."
more_link: "yes"
url: "/kubernetes-helm-advanced-patterns-guide/"
---

Helm is the de facto package manager for Kubernetes, but most teams only scratch the surface of what it offers. Beyond basic templating and variable substitution, Helm supports library charts for shared template logic, subchart composition for complex application stacks, post-render hooks for escape-hatch customization, and JSON Schema validation for chart values. Mastering these patterns is the difference between charts that work on a developer's laptop and charts that reliably manage complex enterprise deployments across dozens of environments.

<!--more-->

# Kubernetes Helm Advanced Patterns: Library Charts, Subcharts, and Post-Render Hooks

## Why Advanced Helm Patterns Matter

A platform team managing hundreds of microservices faces a template sprawl problem. Each service has its own chart with Deployment, Service, ServiceMonitor, HorizontalPodAutoscaler, and PodDisruptionBudget resources. When a security policy changes — say, all containers must run as non-root — updating every chart manually is impractical and error-prone.

Library charts solve this by centralizing shared template logic. Subcharts handle complex application stacks where multiple components must be versioned and deployed together. Post-render hooks provide an escape hatch when Helm's templating isn't expressive enough. These patterns together form the foundation of a maintainable, enterprise-grade Helm strategy.

## Library Charts

A library chart is a Helm chart that provides reusable templates but produces no manifest output itself. It exists only to be used as a dependency by other charts.

### Creating a Library Chart

The key difference from a regular chart is `type: library` in `Chart.yaml`:

```yaml
# charts/acme-common/Chart.yaml
apiVersion: v2
name: acme-common
description: Common template helpers for ACME services
type: library
version: 2.5.0
keywords:
  - common
  - helper
  - library
home: https://github.com/acme-corp/helm-charts
sources:
  - https://github.com/acme-corp/helm-charts/tree/main/charts/acme-common
maintainers:
  - name: Platform Team
    email: platform@acme.com
```

Library chart templates must use `define` blocks rather than top-level manifest output:

```
charts/acme-common/
├── Chart.yaml
├── templates/
│   ├── _deployment.tpl
│   ├── _service.tpl
│   ├── _serviceaccount.tpl
│   ├── _hpa.tpl
│   ├── _pdb.tpl
│   ├── _servicemonitor.tpl
│   ├── _helpers.tpl
│   └── _pod.tpl
└── values.yaml
```

### Core Helper Templates

```yaml
{{/*
acme-common.deployment creates a standard Deployment with organizational defaults.
Usage:
  {{ include "acme-common.deployment" . }}
*/}}
{{- define "acme-common.deployment" -}}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "acme-common.fullname" . }}
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "acme-common.labels" . | nindent 4 }}
  annotations:
    {{- include "acme-common.commonAnnotations" . | nindent 4 }}
    {{- with .Values.deploymentAnnotations }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
spec:
  {{- if not .Values.autoscaling.enabled }}
  replicas: {{ .Values.replicaCount }}
  {{- end }}
  selector:
    matchLabels:
      {{- include "acme-common.selectorLabels" . | nindent 6 }}
  strategy:
    {{- if .Values.deploymentStrategy }}
    {{- toYaml .Values.deploymentStrategy | nindent 4 }}
    {{- else }}
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 25%
      maxSurge: 25%
    {{- end }}
  template:
    metadata:
      annotations:
        kubectl.kubernetes.io/rollout-restart: "true"
        {{- if .Values.podAnnotations }}
        {{- toYaml .Values.podAnnotations | nindent 8 }}
        {{- end }}
        {{- if .Values.metrics.enabled }}
        prometheus.io/scrape: "true"
        prometheus.io/port: {{ .Values.metrics.port | quote }}
        prometheus.io/path: {{ .Values.metrics.path | quote }}
        {{- end }}
      labels:
        {{- include "acme-common.selectorLabels" . | nindent 8 }}
        {{- with .Values.podLabels }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
    spec:
      {{- include "acme-common.podSpec" . | nindent 6 }}
{{- end }}

{{/*
acme-common.podSpec renders the pod spec with organizational security defaults.
*/}}
{{- define "acme-common.podSpec" -}}
serviceAccountName: {{ include "acme-common.serviceAccountName" . }}
automountServiceAccountToken: {{ .Values.serviceAccount.automountToken | default false }}
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
securityContext:
  runAsNonRoot: true
  runAsUser: {{ .Values.podSecurityContext.runAsUser | default 65534 }}
  runAsGroup: {{ .Values.podSecurityContext.runAsGroup | default 65534 }}
  fsGroup: {{ .Values.podSecurityContext.fsGroup | default 65534 }}
  seccompProfile:
    type: RuntimeDefault
  {{- with .Values.podSecurityContext.supplementalGroups }}
  supplementalGroups:
    {{- toYaml . | nindent 4 }}
  {{- end }}
{{- with .Values.initContainers }}
initContainers:
  {{- toYaml . | nindent 2 }}
{{- end }}
containers:
  - name: {{ .Chart.Name }}
    image: "{{ .Values.image.registry }}/{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
    imagePullPolicy: {{ .Values.image.pullPolicy }}
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: {{ .Values.containerSecurityContext.readOnlyRootFilesystem | default true }}
      capabilities:
        drop:
          - ALL
        {{- with .Values.containerSecurityContext.capabilities.add }}
        add:
          {{- toYaml . | nindent 10 }}
        {{- end }}
    {{- with .Values.command }}
    command:
      {{- toYaml . | nindent 6 }}
    {{- end }}
    {{- with .Values.args }}
    args:
      {{- toYaml . | nindent 6 }}
    {{- end }}
    env:
      - name: POD_NAME
        valueFrom:
          fieldRef:
            fieldPath: metadata.name
      - name: POD_NAMESPACE
        valueFrom:
          fieldRef:
            fieldPath: metadata.namespace
      - name: POD_IP
        valueFrom:
          fieldRef:
            fieldPath: status.podIP
      {{- with .Values.env }}
      {{- toYaml . | nindent 6 }}
      {{- end }}
    {{- with .Values.envFrom }}
    envFrom:
      {{- toYaml . | nindent 6 }}
    {{- end }}
    ports:
      - name: http
        containerPort: {{ .Values.service.targetPort | default 8080 }}
        protocol: TCP
      {{- if .Values.metrics.enabled }}
      - name: metrics
        containerPort: {{ .Values.metrics.port | default 9090 }}
        protocol: TCP
      {{- end }}
      {{- with .Values.extraPorts }}
      {{- toYaml . | nindent 6 }}
      {{- end }}
    {{- include "acme-common.probes" . | nindent 4 }}
    resources:
      {{- include "acme-common.resources" . | nindent 6 }}
    {{- with .Values.volumeMounts }}
    volumeMounts:
      {{- toYaml . | nindent 6 }}
    {{- end }}
  {{- with .Values.sidecars }}
  {{- toYaml . | nindent 2 }}
  {{- end }}
{{- with .Values.volumes }}
volumes:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- include "acme-common.affinity" . }}
{{- with .Values.tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.topologySpreadConstraints }}
topologySpreadConstraints:
  {{- toYaml . | nindent 2 }}
{{- end }}
terminationGracePeriodSeconds: {{ .Values.terminationGracePeriodSeconds | default 60 }}
{{- end }}

{{/*
acme-common.probes renders liveness, readiness, and startup probes.
*/}}
{{- define "acme-common.probes" -}}
{{- if .Values.livenessProbe.enabled }}
livenessProbe:
  {{- if .Values.livenessProbe.custom }}
  {{- toYaml .Values.livenessProbe.custom | nindent 2 }}
  {{- else }}
  httpGet:
    path: {{ .Values.livenessProbe.path | default "/healthz" }}
    port: http
  initialDelaySeconds: {{ .Values.livenessProbe.initialDelaySeconds | default 15 }}
  periodSeconds: {{ .Values.livenessProbe.periodSeconds | default 20 }}
  timeoutSeconds: {{ .Values.livenessProbe.timeoutSeconds | default 5 }}
  failureThreshold: {{ .Values.livenessProbe.failureThreshold | default 3 }}
  successThreshold: {{ .Values.livenessProbe.successThreshold | default 1 }}
  {{- end }}
{{- end }}
{{- if .Values.readinessProbe.enabled }}
readinessProbe:
  {{- if .Values.readinessProbe.custom }}
  {{- toYaml .Values.readinessProbe.custom | nindent 2 }}
  {{- else }}
  httpGet:
    path: {{ .Values.readinessProbe.path | default "/readyz" }}
    port: http
  initialDelaySeconds: {{ .Values.readinessProbe.initialDelaySeconds | default 5 }}
  periodSeconds: {{ .Values.readinessProbe.periodSeconds | default 10 }}
  timeoutSeconds: {{ .Values.readinessProbe.timeoutSeconds | default 3 }}
  failureThreshold: {{ .Values.readinessProbe.failureThreshold | default 3 }}
  successThreshold: {{ .Values.readinessProbe.successThreshold | default 1 }}
  {{- end }}
{{- end }}
{{- if .Values.startupProbe.enabled }}
startupProbe:
  httpGet:
    path: {{ .Values.startupProbe.path | default "/readyz" }}
    port: http
  initialDelaySeconds: {{ .Values.startupProbe.initialDelaySeconds | default 0 }}
  periodSeconds: {{ .Values.startupProbe.periodSeconds | default 10 }}
  timeoutSeconds: {{ .Values.startupProbe.timeoutSeconds | default 3 }}
  failureThreshold: {{ .Values.startupProbe.failureThreshold | default 30 }}
{{- end }}
{{- end }}

{{/*
acme-common.resources renders resource requests/limits with safe defaults.
*/}}
{{- define "acme-common.resources" -}}
{{- if .Values.resources }}
{{- toYaml .Values.resources }}
{{- else }}
requests:
  cpu: 100m
  memory: 128Mi
limits:
  memory: 512Mi
{{- end }}
{{- end }}

{{/*
acme-common.affinity generates affinity rules.
Defaults to soft pod anti-affinity for HA across nodes.
*/}}
{{- define "acme-common.affinity" -}}
{{- if .Values.affinity }}
affinity:
  {{- toYaml .Values.affinity | nindent 2 }}
{{- else if .Values.podAntiAffinity.enabled }}
affinity:
  podAntiAffinity:
    {{- if eq .Values.podAntiAffinity.type "hard" }}
    requiredDuringSchedulingIgnoredDuringExecution:
      - topologyKey: {{ .Values.podAntiAffinity.topologyKey | default "kubernetes.io/hostname" }}
        labelSelector:
          matchLabels:
            {{- include "acme-common.selectorLabels" . | nindent 12 }}
    {{- else }}
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          topologyKey: {{ .Values.podAntiAffinity.topologyKey | default "kubernetes.io/hostname" }}
          labelSelector:
            matchLabels:
              {{- include "acme-common.selectorLabels" . | nindent 14 }}
    {{- end }}
{{- end }}
{{- end }}
```

### HPA and PDB Templates

```yaml
{{/*
acme-common.hpa creates a HorizontalPodAutoscaler.
*/}}
{{- define "acme-common.hpa" -}}
{{- if .Values.autoscaling.enabled }}
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {{ include "acme-common.fullname" . }}
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "acme-common.labels" . | nindent 4 }}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {{ include "acme-common.fullname" . }}
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
      stabilizationWindowSeconds: 300
      policies:
        - type: Pods
          value: 1
          periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
        - type: Percent
          value: 100
          periodSeconds: 15
        - type: Pods
          value: 4
          periodSeconds: 15
      selectPolicy: Max
{{- end }}
{{- end }}

{{/*
acme-common.pdb creates a PodDisruptionBudget.
*/}}
{{- define "acme-common.pdb" -}}
{{- if .Values.podDisruptionBudget.enabled }}
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: {{ include "acme-common.fullname" . }}
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "acme-common.labels" . | nindent 4 }}
spec:
  selector:
    matchLabels:
      {{- include "acme-common.selectorLabels" . | nindent 6 }}
  {{- if .Values.podDisruptionBudget.minAvailable }}
  minAvailable: {{ .Values.podDisruptionBudget.minAvailable }}
  {{- else }}
  maxUnavailable: {{ .Values.podDisruptionBudget.maxUnavailable | default 1 }}
  {{- end }}
{{- end }}
{{- end }}
```

### Using a Library Chart

Add the library chart as a dependency:

```yaml
# charts/payments-service/Chart.yaml
apiVersion: v2
name: payments-service
description: Payments microservice
type: application
version: 1.4.0
appVersion: "2.1.0"
dependencies:
  - name: acme-common
    version: "2.x.x"
    repository: "https://charts.acme.com"
```

Service chart templates become thin wrappers:

```yaml
# charts/payments-service/templates/deployment.yaml
{{- include "acme-common.deployment" . }}
---
{{- include "acme-common.hpa" . }}
---
{{- include "acme-common.pdb" . }}
```

```yaml
# charts/payments-service/templates/service.yaml
{{- include "acme-common.service" . }}
```

```yaml
# charts/payments-service/templates/serviceaccount.yaml
{{- include "acme-common.serviceaccount" . }}
```

The service chart's values.yaml only needs service-specific overrides:

```yaml
# charts/payments-service/values.yaml
image:
  registry: ghcr.io
  repository: acme-corp/payments-service
  tag: ""  # Overridden at deploy time
  pullPolicy: IfNotPresent

replicaCount: 2

service:
  type: ClusterIP
  port: 80
  targetPort: 8080

metrics:
  enabled: true
  port: 9090
  path: /metrics

autoscaling:
  enabled: true
  minReplicas: 2
  maxReplicas: 20
  targetCPUUtilizationPercentage: 70

podDisruptionBudget:
  enabled: true
  maxUnavailable: 1

resources:
  requests:
    cpu: 250m
    memory: 256Mi
  limits:
    memory: 1Gi

podAntiAffinity:
  enabled: true
  type: soft

env:
  - name: DATABASE_URL
    valueFrom:
      secretKeyRef:
        name: payments-secrets
        key: database-url
  - name: REDIS_URL
    valueFrom:
      secretKeyRef:
        name: payments-secrets
        key: redis-url
```

## Subchart Composition

Subcharts allow complex application stacks to be packaged together. Each subchart manages one component, and the parent chart coordinates them.

### Structuring a Multi-Component Chart

```
charts/data-platform/
├── Chart.yaml
├── values.yaml
├── templates/
│   ├── _helpers.tpl
│   ├── namespace.yaml
│   └── networkpolicies.yaml
└── charts/
    ├── kafka/          # Subchart (vendored or dependency)
    ├── schema-registry/
    ├── kafka-connect/
    └── ksqldb/
```

```yaml
# charts/data-platform/Chart.yaml
apiVersion: v2
name: data-platform
description: Complete data streaming platform with Kafka ecosystem
type: application
version: 3.2.0
appVersion: "3.7.0"
dependencies:
  - name: kafka
    version: "26.x.x"
    repository: "https://charts.bitnami.com/bitnami"
    condition: kafka.enabled
    tags:
      - kafka
  - name: schema-registry
    version: "0.x.x"
    repository: "https://confluentinc.github.io/cp-helm-charts"
    condition: schema-registry.enabled
  - name: kafka-connect
    version: "0.x.x"
    repository: "https://confluentinc.github.io/cp-helm-charts"
    condition: kafka-connect.enabled
  - name: ksqldb
    version: "0.x.x"
    repository: "https://confluentinc.github.io/cp-helm-charts"
    condition: ksqldb.enabled
```

### Parent Chart Values for Subcharts

Parent values are scoped to subchart keys:

```yaml
# charts/data-platform/values.yaml

# Global values shared across all subcharts
global:
  storageClass: "fast-ssd"
  imagePullSecrets:
    - name: registry-credentials
  kafka:
    bootstrapServers: "data-platform-kafka:9092"
    schemaRegistry: "http://data-platform-schema-registry:8081"

# Kafka subchart configuration
kafka:
  enabled: true
  # These keys must match the subchart's values.yaml
  replicaCount: 3
  persistence:
    enabled: true
    storageClass: "{{ .Values.global.storageClass }}"  # NOTE: Global reference won't template in values.yaml
    size: "100Gi"
  resources:
    requests:
      cpu: 1000m
      memory: 2Gi
    limits:
      memory: 4Gi
  metrics:
    kafka:
      enabled: true
    jmx:
      enabled: true

# Schema Registry subchart
schema-registry:
  enabled: true
  replicaCount: 2
  kafka:
    bootstrapServers: "PLAINTEXT://data-platform-kafka-headless:9092"
  resources:
    requests:
      cpu: 200m
      memory: 512Mi

# Kafka Connect subchart
kafka-connect:
  enabled: true
  replicaCount: 2
  kafka:
    bootstrapServers: "data-platform-kafka:9092"
  cp-schema-registry:
    url: "http://data-platform-schema-registry:8081"
```

### Passing Global Values to Subcharts

Use `.Values.global` for values that every subchart needs:

```yaml
# In subchart templates, access global values like:
# {{ .Values.global.kafka.bootstrapServers }}
```

The parent chart can also use named templates from its own templates directory to produce coordinated NetworkPolicies:

```yaml
# charts/data-platform/templates/networkpolicies.yaml
{{- if .Values.networkPolicies.enabled }}
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: kafka-allow-connect
  namespace: {{ .Release.Namespace }}
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: kafka
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: kafka-connect
      ports:
        - port: 9092
        - port: 9093
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: schema-registry-allow-connect
  namespace: {{ .Release.Namespace }}
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: schema-registry
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: kafka-connect
      ports:
        - port: 8081
{{- end }}
```

### Subchart Hooks and Ordering

Helm hooks can coordinate initialization order:

```yaml
# charts/data-platform/templates/kafka-topics-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: kafka-init-topics
  annotations:
    # Run after Kafka is installed, before other components
    "helm.sh/hook": post-install,post-upgrade
    "helm.sh/hook-weight": "-5"
    "helm.sh/hook-delete-policy": hook-succeeded
spec:
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: kafka-init
          image: bitnami/kafka:3.7.0
          command:
            - /bin/bash
            - -c
            - |
              # Wait for Kafka to be ready
              until kafka-topics.sh --bootstrap-server {{ include "data-platform.kafkaBootstrap" . }} --list; do
                echo "Waiting for Kafka..."
                sleep 5
              done

              # Create required topics
              {{- range .Values.kafka.initTopics }}
              kafka-topics.sh \
                --bootstrap-server {{ include "data-platform.kafkaBootstrap" $ }} \
                --create \
                --if-not-exists \
                --topic {{ .name }} \
                --partitions {{ .partitions | default 12 }} \
                --replication-factor {{ .replicationFactor | default 3 }} \
                --config retention.ms={{ .retentionMs | default 604800000 }} \
                --config cleanup.policy={{ .cleanupPolicy | default "delete" }}
              {{- end }}
```

## Post-Render Hooks

Post-render hooks allow external tools to transform Helm's rendered manifests before they are applied to the cluster. This is the escape hatch for customization that Helm's templating can't handle.

### Kustomize as a Post-Renderer

The most common post-renderer is Kustomize, which applies patches after Helm rendering:

```bash
#!/bin/bash
# helm-postrender-kustomize.sh
# Usage: helm install myapp ./chart --post-renderer ./helm-postrender-kustomize.sh

set -euo pipefail

# Read stdin (Helm's rendered manifests)
cat > /tmp/all.yaml

# Create a temporary kustomization
mkdir -p /tmp/kustomize-work
cat /tmp/all.yaml > /tmp/kustomize-work/all.yaml

cat > /tmp/kustomize-work/kustomization.yaml << 'EOF'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - all.yaml

# Add organization-wide labels
commonLabels:
  managed-by: helm
  organization: acme

# Apply strategic merge patches
patches:
  - path: add-seccomp.yaml
    target:
      kind: Deployment
  - path: add-topology-spread.yaml
    target:
      kind: Deployment

# Add namespace
namespace: production
EOF

# Write patches
cat > /tmp/kustomize-work/add-seccomp.yaml << 'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: placeholder
spec:
  template:
    spec:
      securityContext:
        seccompProfile:
          type: RuntimeDefault
EOF

cat > /tmp/kustomize-work/add-topology-spread.yaml << 'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: placeholder
spec:
  template:
    spec:
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels: {}
EOF

# Apply kustomize and output
kustomize build /tmp/kustomize-work

# Cleanup
rm -rf /tmp/kustomize-work /tmp/all.yaml
```

### Go-Based Post-Renderer

For complex transformations, write a Go post-renderer:

```go
// cmd/helm-postrender/main.go
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"sigs.k8s.io/yaml"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/util/strategicpatch"
)

type Manifest struct {
	APIVersion string            `json:"apiVersion"`
	Kind       string            `json:"kind"`
	Metadata   map[string]interface{} `json:"metadata"`
}

func main() {
	input, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintf(os.Stderr, "reading stdin: %v\n", err)
		os.Exit(1)
	}

	output, err := processManifests(input)
	if err != nil {
		fmt.Fprintf(os.Stderr, "processing manifests: %v\n", err)
		os.Exit(1)
	}

	fmt.Print(string(output))
}

func processManifests(input []byte) ([]byte, error) {
	// Split multi-document YAML
	documents := splitYAMLDocuments(input)

	var outputs []string
	for _, doc := range documents {
		if len(doc) == 0 {
			continue
		}

		processed, err := processDocument(doc)
		if err != nil {
			return nil, fmt.Errorf("processing document: %w", err)
		}
		outputs = append(outputs, string(processed))
	}

	result := ""
	for i, out := range outputs {
		if i > 0 {
			result += "---\n"
		}
		result += out
	}

	return []byte(result), nil
}

func processDocument(doc []byte) ([]byte, error) {
	var obj unstructured.Unstructured
	if err := yaml.Unmarshal(doc, &obj); err != nil {
		return doc, nil // Return unchanged if not parseable
	}

	kind := obj.GetKind()

	switch kind {
	case "Deployment":
		addOrganizationalDefaults(&obj)
	case "Service":
		addServiceDefaults(&obj)
	case "Ingress":
		addIngressDefaults(&obj)
	}

	return yaml.Marshal(obj.Object)
}

func addOrganizationalDefaults(obj *unstructured.Unstructured) {
	// Add required labels
	labels := obj.GetLabels()
	if labels == nil {
		labels = make(map[string]string)
	}
	labels["acme.com/managed-by"] = "helm"
	labels["acme.com/security-scan"] = "enabled"
	obj.SetLabels(labels)

	// Ensure resource limits are set
	containers, found, err := unstructured.NestedSlice(obj.Object,
		"spec", "template", "spec", "containers")
	if err != nil || !found {
		return
	}

	for i, c := range containers {
		container, ok := c.(map[string]interface{})
		if !ok {
			continue
		}

		// Check if limits are set
		_, hasLimits, _ := unstructured.NestedMap(container, "resources", "limits")
		if !hasLimits {
			// Set default limits
			if err := unstructured.SetNestedField(container,
				map[string]interface{}{
					"limits": map[string]interface{}{
						"memory": "512Mi",
					},
					"requests": map[string]interface{}{
						"cpu":    "100m",
						"memory": "128Mi",
					},
				},
				"resources",
			); err == nil {
				containers[i] = container
			}
		}
	}

	unstructured.SetNestedSlice(obj.Object, containers,
		"spec", "template", "spec", "containers")
}

func addServiceDefaults(obj *unstructured.Unstructured) {
	annotations := obj.GetAnnotations()
	if annotations == nil {
		annotations = make(map[string]string)
	}
	// Add cloud provider annotations for NLB
	annotations["service.beta.kubernetes.io/aws-load-balancer-type"] = "nlb"
	obj.SetAnnotations(annotations)
}

func addIngressDefaults(obj *unstructured.Unstructured) {
	annotations := obj.GetAnnotations()
	if annotations == nil {
		annotations = make(map[string]string)
	}
	annotations["nginx.ingress.kubernetes.io/ssl-redirect"] = "true"
	annotations["nginx.ingress.kubernetes.io/force-ssl-redirect"] = "true"
	obj.SetAnnotations(annotations)
}

func splitYAMLDocuments(data []byte) [][]byte {
	// Simple YAML document splitter
	var docs [][]byte
	var current []byte

	for _, line := range splitLines(data) {
		if string(line) == "---" {
			if len(current) > 0 {
				docs = append(docs, current)
			}
			current = nil
		} else {
			current = append(current, line...)
			current = append(current, '\n')
		}
	}

	if len(current) > 0 {
		docs = append(docs, current)
	}

	return docs
}

func splitLines(data []byte) [][]byte {
	var lines [][]byte
	var current []byte

	for _, b := range data {
		if b == '\n' {
			lines = append(lines, current)
			current = nil
		} else {
			current = append(current, b)
		}
	}

	if len(current) > 0 {
		lines = append(lines, current)
	}

	return lines
}
```

## JSON Schema Validation

Add `values.schema.json` to validate values at `helm install` time, catching errors before any resources are applied:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Payments Service Chart Values",
  "type": "object",
  "required": ["image", "service"],
  "properties": {
    "image": {
      "type": "object",
      "required": ["repository", "tag"],
      "properties": {
        "registry": {
          "type": "string",
          "default": "ghcr.io"
        },
        "repository": {
          "type": "string",
          "pattern": "^[a-z0-9][a-z0-9-./]*$",
          "description": "Container image repository (lowercase)"
        },
        "tag": {
          "type": "string",
          "minLength": 1,
          "description": "Image tag, required for production"
        },
        "pullPolicy": {
          "type": "string",
          "enum": ["Always", "IfNotPresent", "Never"],
          "default": "IfNotPresent"
        }
      },
      "additionalProperties": false
    },
    "replicaCount": {
      "type": "integer",
      "minimum": 1,
      "maximum": 100,
      "default": 2
    },
    "resources": {
      "type": "object",
      "properties": {
        "requests": {
          "type": "object",
          "properties": {
            "cpu": {"type": "string"},
            "memory": {"type": "string"}
          }
        },
        "limits": {
          "type": "object",
          "properties": {
            "memory": {"type": "string"}
          }
        }
      }
    },
    "autoscaling": {
      "type": "object",
      "properties": {
        "enabled": {"type": "boolean", "default": false},
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
      },
      "if": {"properties": {"enabled": {"const": true}}},
      "then": {
        "required": ["minReplicas", "maxReplicas"],
        "properties": {
          "maxReplicas": {
            "minimum": 2,
            "description": "maxReplicas must be at least 2 when autoscaling is enabled"
          }
        }
      }
    },
    "ingress": {
      "type": "object",
      "properties": {
        "enabled": {"type": "boolean", "default": false},
        "className": {"type": "string"},
        "hosts": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["host", "paths"],
            "properties": {
              "host": {"type": "string", "format": "hostname"},
              "paths": {
                "type": "array",
                "items": {
                  "type": "object",
                  "required": ["path", "pathType"],
                  "properties": {
                    "path": {"type": "string"},
                    "pathType": {
                      "type": "string",
                      "enum": ["Exact", "Prefix", "ImplementationSpecific"]
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
```

## Helm Testing

Write chart tests that validate deployed resources:

```yaml
# templates/tests/test-connection.yaml
apiVersion: v1
kind: Pod
metadata:
  name: "{{ include "acme-common.fullname" . }}-test-connection"
  labels:
    {{- include "acme-common.labels" . | nindent 4 }}
  annotations:
    "helm.sh/hook": test
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
spec:
  restartPolicy: Never
  containers:
    - name: wget
      image: busybox:1.36
      command:
        - sh
        - -c
        - |
          set -e
          echo "Testing health endpoint..."
          wget -O- -q --timeout=10 \
            "http://{{ include "acme-common.fullname" . }}:{{ .Values.service.port }}/healthz"

          echo "Testing readiness endpoint..."
          wget -O- -q --timeout=10 \
            "http://{{ include "acme-common.fullname" . }}:{{ .Values.service.port }}/readyz"

          echo "Testing metrics endpoint..."
          wget -O- -q --timeout=10 \
            "http://{{ include "acme-common.fullname" . }}:{{ .Values.metrics.port }}/metrics" | \
            grep -q "go_goroutines"

          echo "All tests passed!"
```

Run tests with:

```bash
helm test payments-service --namespace payments --logs
```

## CI/CD Integration

Integrate chart testing with chart-testing (ct):

```yaml
# .github/workflows/helm-test.yaml
name: Helm Chart Testing

on:
  pull_request:
    paths:
      - "charts/**"

jobs:
  lint-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: azure/setup-helm@v4
        with:
          version: "3.14.0"

      - uses: helm/chart-testing-action@v2

      - name: Run chart-testing lint
        run: ct lint --config .ct.yaml --chart-dirs charts

      - name: Create kind cluster
        uses: helm/kind-action@v1

      - name: Run chart-testing install
        run: ct install --config .ct.yaml --chart-dirs charts
```

```yaml
# .ct.yaml
remote: origin
target-branch: main
chart-dirs:
  - charts
chart-repos:
  - bitnami=https://charts.bitnami.com/bitnami
helm-extra-args: --timeout 600s
check-version-increment: true
validate-maintainers: false
```

## Conclusion

Advanced Helm patterns dramatically reduce the operational burden of managing Kubernetes manifests at scale. Library charts eliminate template duplication and make organization-wide policy changes a single-chart update. Subchart composition enables packaging complex multi-component systems with proper dependency management. Post-render hooks provide the flexibility to layer concerns that Helm's templating can't express. JSON Schema validation catches configuration errors at install time rather than at runtime.

The investment in building a good library chart pays dividends immediately: security patches, resource default changes, and new organizational requirements propagate to every service chart simply by bumping the library version. Combined with proper CI testing, this approach makes Helm charts a reliable, enterprise-grade foundation for Kubernetes deployments.
