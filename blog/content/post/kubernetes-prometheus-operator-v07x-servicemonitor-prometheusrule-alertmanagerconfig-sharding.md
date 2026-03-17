---
title: "Kubernetes Prometheus Operator v0.7x: ServiceMonitor, PrometheusRule, AlertmanagerConfig, and Sharding"
date: 2031-11-08T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Prometheus", "Prometheus Operator", "Monitoring", "Alertmanager", "Observability", "ServiceMonitor"]
categories: ["Kubernetes", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-focused guide to Prometheus Operator v0.7x covering ServiceMonitor and PodMonitor configuration, PrometheusRule management, AlertmanagerConfig for multi-tenant routing, and horizontal sharding for large-scale deployments."
more_link: "yes"
url: "/kubernetes-prometheus-operator-v07x-servicemonitor-prometheusrule-alertmanagerconfig-sharding/"
---

Prometheus Operator v0.7x brings significant improvements to the declarative management of Prometheus and Alertmanager deployments on Kubernetes. This guide covers the full operational stack: ServiceMonitor and PodMonitor patterns for service discovery, PrometheusRule management at scale, AlertmanagerConfig for multi-tenant alert routing, and the horizontal sharding capability that makes large cluster monitoring tractable.

<!--more-->

# Kubernetes Prometheus Operator v0.7x: ServiceMonitor, PrometheusRule, AlertmanagerConfig, and Sharding

## Architecture Overview

Prometheus Operator translates Kubernetes Custom Resources into Prometheus and Alertmanager configurations, eliminating the need to manage static configuration files. The key CRDs in v0.7x are:

| CRD | Purpose |
|---|---|
| `Prometheus` | Manages a Prometheus StatefulSet and its configuration |
| `Alertmanager` | Manages an Alertmanager cluster |
| `ServiceMonitor` | Scrape configuration for Service endpoints |
| `PodMonitor` | Scrape configuration for Pod endpoints directly |
| `ProbeMonitor` | Blackbox exporter probe configuration |
| `ScrapeConfig` | Low-level scrape config for non-Kubernetes targets |
| `PrometheusRule` | Recording and alerting rules |
| `AlertmanagerConfig` | Namespaced alert routing subtree |

The operator watches these resources and reconciles them into `prometheus.yaml` and `alertmanager.yaml` configuration files, then performs a rolling restart (or live reload) of the Prometheus pods.

## Section 1: Prometheus Deployment

### 1.1 Core Prometheus Resource

```yaml
# prometheus-production.yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: production
  namespace: monitoring
spec:
  # Image version
  image: quay.io/prometheus/prometheus:v2.52.0

  # Replica count — use 2 for HA, but note they scrape independently
  replicas: 2

  # Retention
  retention: 30d
  retentionSize: "400GB"

  # Storage
  storage:
    volumeClaimTemplate:
      spec:
        storageClassName: fast-nvme
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 500Gi

  # ServiceMonitor selector — which ServiceMonitors this Prometheus will process
  serviceMonitorSelector:
    matchLabels:
      prometheus: production

  # Namespace selector for ServiceMonitors
  serviceMonitorNamespaceSelector:
    matchExpressions:
      - key: monitoring
        operator: In
        values: ["enabled"]

  # PodMonitor selector
  podMonitorSelector:
    matchLabels:
      prometheus: production

  podMonitorNamespaceSelector:
    matchExpressions:
      - key: monitoring
        operator: In
        values: ["enabled"]

  # PrometheusRule selector
  ruleSelector:
    matchLabels:
      prometheus: production
      role: alert-rules

  ruleNamespaceSelector:
    matchExpressions:
      - key: monitoring
        operator: In
        values: ["enabled"]

  # Alertmanager integration
  alerting:
    alertmanagers:
      - namespace: monitoring
        name: alertmanager-production
        port: web

  # Remote write for long-term storage (Thanos/VictoriaMetrics)
  remoteWrite:
    - url: http://thanos-receive.monitoring.svc.cluster.local:19291/api/v1/receive
      queueConfig:
        maxSamplesPerSend: 10000
        maxShards: 30
        capacity: 50000
      writeRelabelConfigs:
        - sourceLabels: [__name__]
          regex: "go_.*|process_.*"
          action: drop

  # Resources
  resources:
    requests:
      cpu: "2"
      memory: "8Gi"
    limits:
      cpu: "4"
      memory: "16Gi"

  # Security
  securityContext:
    fsGroup: 2000
    runAsNonRoot: true
    runAsUser: 1000

  # RBAC — allow Prometheus to scrape from all namespaces
  serviceAccountName: prometheus-production

  # Additional scrape configs (for non-operator-managed targets)
  additionalScrapeConfigsSecret:
    name: additional-scrape-configs
    key: prometheus-additional.yaml

  # Topology spread for HA
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: kubernetes.io/hostname
      whenUnsatisfiable: DoNotSchedule
      labelSelector:
        matchLabels:
          prometheus: production

  # Thanos sidecar for remote storage and query federation
  thanos:
    image: quay.io/thanos/thanos:v0.35.0
    objectStorageConfig:
      name: thanos-objstore-config
      key: objstore.yml
```

### 1.2 RBAC for Multi-Namespace Scraping

```yaml
# prometheus-rbac.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: prometheus-production
  namespace: monitoring

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: prometheus-production
rules:
  - apiGroups: [""]
    resources:
      - nodes
      - nodes/metrics
      - services
      - endpoints
      - pods
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources:
      - configmaps
    verbs: ["get"]
  - apiGroups: ["networking.k8s.io"]
    resources:
      - ingresses
    verbs: ["get", "list", "watch"]
  - nonResourceURLs:
      - "/metrics"
      - "/metrics/cadvisor"
    verbs: ["get"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: prometheus-production
subjects:
  - kind: ServiceAccount
    name: prometheus-production
    namespace: monitoring
roleRef:
  kind: ClusterRole
  name: prometheus-production
  apiGroup: rbac.authorization.k8s.io
```

## Section 2: ServiceMonitor Configuration Patterns

### 2.1 Basic ServiceMonitor

```yaml
# servicemonitor-api-service.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: api-service
  namespace: production
  labels:
    prometheus: production   # Must match Prometheus.spec.serviceMonitorSelector
spec:
  selector:
    matchLabels:
      app: api-service
      environment: production
  namespaceSelector:
    matchNames:
      - production
      - production-canary
  endpoints:
    - port: metrics           # Named port on the Service
      path: /metrics
      interval: 30s
      scrapeTimeout: 10s
      honorLabels: false
      metricRelabelings:
        # Drop high-cardinality labels that aren't needed
        - sourceLabels: [pod_template_hash]
          action: labeldrop
        # Rename labels for consistency
        - sourceLabels: [app_kubernetes_io_name]
          targetLabel: service_name
          action: replace
        # Drop metrics with no active users
        - sourceLabels: [__name__]
          regex: "go_gc_duration_seconds"
          action: drop
```

### 2.2 ServiceMonitor with TLS

```yaml
# servicemonitor-secure-service.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: secure-internal-service
  namespace: monitoring
  labels:
    prometheus: production
spec:
  selector:
    matchLabels:
      app: secure-service
  endpoints:
    - port: https-metrics
      path: /metrics
      scheme: https
      tlsConfig:
        # CA certificate for verifying the target's server cert
        ca:
          secret:
            name: internal-ca
            key: ca.crt
        # Client certificate for mTLS
        cert:
          secret:
            name: prometheus-client-cert
            key: tls.crt
        keySecret:
          name: prometheus-client-cert
          key: tls.key
        serverName: secure-service.production.svc.cluster.local
        insecureSkipVerify: false
      bearerTokenSecret:
        name: prometheus-scrape-token
        key: token
```

### 2.3 ServiceMonitor with Authorization

```yaml
# servicemonitor-with-auth.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: kubernetes-api-server
  namespace: monitoring
  labels:
    prometheus: production
spec:
  endpoints:
    - bearerTokenFile: /var/run/secrets/kubernetes.io/serviceaccount/token
      honorLabels: true
      interval: 30s
      port: https
      scheme: https
      tlsConfig:
        caFile: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
        serverName: kubernetes
  jobLabel: component
  namespaceSelector:
    matchNames:
      - default
  selector:
    matchLabels:
      component: apiserver
      provider: kubernetes
```

### 2.4 PodMonitor for Sidecar Metrics

```yaml
# podmonitor-envoy-sidecar.yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: envoy-sidecar-metrics
  namespace: monitoring
  labels:
    prometheus: production
spec:
  selector:
    matchLabels:
      sidecar.istio.io/inject: "true"
  namespaceSelector:
    any: true   # All namespaces with monitoring=enabled label
  podMetricsEndpoints:
    - port: envoy-prom
      path: /stats/prometheus
      interval: 15s
      relabelings:
        # Add the pod's namespace as a label
        - sourceLabels: [__meta_kubernetes_pod_namespace]
          targetLabel: namespace
        - sourceLabels: [__meta_kubernetes_pod_name]
          targetLabel: pod
        - sourceLabels: [__meta_kubernetes_pod_label_app]
          targetLabel: app
```

## Section 3: PrometheusRule Management

### 3.1 Recording Rules for Performance

Recording rules pre-compute expensive queries and store results as new time series. This is critical for dashboards that aggregate across many series.

```yaml
# prometheusrule-recording-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: production-recording-rules
  namespace: monitoring
  labels:
    prometheus: production
    role: alert-rules
spec:
  groups:
    - name: http_requests
      interval: 30s
      rules:
        # Per-service request rate (reduces cardinality for dashboards)
        - record: job:http_requests_total:rate5m
          expr: |
            sum by (job, namespace, status_code) (
              rate(http_requests_total[5m])
            )

        # P99 latency per service
        - record: job:http_request_duration_seconds:p99_5m
          expr: |
            histogram_quantile(0.99,
              sum by (job, namespace, le) (
                rate(http_request_duration_seconds_bucket[5m])
              )
            )

        # Error ratio per service
        - record: job:http_error_ratio:rate5m
          expr: |
            sum by (job, namespace) (
              rate(http_requests_total{status_code=~"5.."}[5m])
            )
            /
            sum by (job, namespace) (
              rate(http_requests_total[5m])
            )

    - name: kubernetes_resources
      interval: 60s
      rules:
        # Memory utilization per namespace
        - record: namespace:container_memory_working_set_bytes:sum
          expr: |
            sum by (namespace) (
              container_memory_working_set_bytes{container!=""}
            )

        # CPU utilization per namespace
        - record: namespace:container_cpu_usage_seconds_total:rate5m
          expr: |
            sum by (namespace) (
              rate(container_cpu_usage_seconds_total{container!=""}[5m])
            )
```

### 3.2 Alert Rules with Proper Inhibitions

```yaml
# prometheusrule-application-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: application-slo-alerts
  namespace: monitoring
  labels:
    prometheus: production
    role: alert-rules
spec:
  groups:
    - name: slo.availability
      rules:
        - alert: ServiceAvailabilityBudgetBurning
          expr: |
            (
              # 1-hour burn rate
              job:http_error_ratio:rate5m > (14.4 * 0.001)
            )
            and
            (
              # 5-minute burn rate also elevated (avoids false positives)
              sum by (job, namespace) (
                rate(http_requests_total{status_code=~"5.."}[1m])
              )
              /
              sum by (job, namespace) (
                rate(http_requests_total[1m])
              ) > (14.4 * 0.001)
            )
          for: 2m
          labels:
            severity: critical
            slo: availability
          annotations:
            summary: "Service {{ $labels.job }} is burning through error budget too fast"
            description: |
              Service {{ $labels.job }} in {{ $labels.namespace }} has an error rate of
              {{ $value | humanizePercentage }} which is 14.4x above the SLO threshold.
              At this rate, the monthly error budget will be exhausted in ~1 hour.
            runbook: "https://runbooks.example.com/slos/availability-budget-burning"
            dashboard: "https://grafana.example.com/d/slo-dashboard?var-job={{ $labels.job }}"

        - alert: ServiceLatencyP99High
          expr: |
            job:http_request_duration_seconds:p99_5m > 1.0
          for: 5m
          labels:
            severity: warning
            slo: latency
          annotations:
            summary: "P99 latency too high for {{ $labels.job }}"
            description: "P99 latency is {{ $value | humanizeDuration }} (SLO: 1s)"

    - name: infrastructure.capacity
      rules:
        - alert: NodeMemoryPressure
          expr: |
            (
              node_memory_MemAvailable_bytes
              /
              node_memory_MemTotal_bytes
            ) < 0.10
          for: 5m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "Node {{ $labels.instance }} has less than 10% memory available"

        - alert: PersistentVolumeFillingUp
          expr: |
            (
              kubelet_volume_stats_available_bytes
              /
              kubelet_volume_stats_capacity_bytes
            ) < 0.15
            and
            predict_linear(
              kubelet_volume_stats_available_bytes[6h], 4 * 3600
            ) < 0
          for: 1h
          labels:
            severity: warning
          annotations:
            summary: "PVC {{ $labels.persistentvolumeclaim }} in {{ $labels.namespace }} will fill up in 4 hours"
```

### 3.3 Rule Validation Script

```bash
#!/usr/bin/env bash
# validate-prometheusrules.sh
# Validates PrometheusRule YAML files before applying them

set -euo pipefail

RULES_DIR="${1:-./rules}"
PROMTOOL="${PROMTOOL:-promtool}"
ERRORS=0

find "$RULES_DIR" -name "*.yaml" -o -name "*.yml" | while read -r file; do
    # Extract the groups section from the CRD
    RULES_YAML=$(yq eval '.spec' "$file" 2>/dev/null) || {
        echo "SKIP: $file (not a PrometheusRule or yq not available)"
        continue
    }

    # Write to temp file for promtool
    TMPFILE=$(mktemp /tmp/rules-XXXXXXXX.yaml)
    echo "$RULES_YAML" > "$TMPFILE"

    echo -n "Validating $file ... "
    if "$PROMTOOL" check rules "$TMPFILE" 2>&1; then
        echo "OK"
    else
        echo "FAILED"
        ERRORS=$((ERRORS + 1))
    fi

    rm -f "$TMPFILE"
done

if [[ $ERRORS -gt 0 ]]; then
    echo "Validation failed with $ERRORS error(s)"
    exit 1
fi

echo "All rules validated successfully"
```

## Section 4: AlertmanagerConfig for Multi-Tenant Routing

### 4.1 Global Alertmanager Configuration

```yaml
# alertmanager-production.yaml
apiVersion: monitoring.coreos.com/v1
kind: Alertmanager
metadata:
  name: production
  namespace: monitoring
spec:
  replicas: 3
  image: quay.io/prometheus/alertmanager:v0.27.0

  # AlertmanagerConfig selector — which configs to merge
  alertmanagerConfigSelector:
    matchLabels:
      alertmanager: production

  alertmanagerConfigNamespaceSelector:
    matchExpressions:
      - key: monitoring
        operator: In
        values: ["enabled"]

  # Global configuration (base routing)
  configSecret: alertmanager-global-config

  storage:
    volumeClaimTemplate:
      spec:
        storageClassName: standard-ssd
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 10Gi

  resources:
    requests:
      cpu: 100m
      memory: 256Mi
    limits:
      cpu: 500m
      memory: 512Mi
```

The global configuration secret contains the top-level routing tree:

```yaml
# alertmanager-global-config.yaml (content of secret)
global:
  resolve_timeout: 5m
  smtp_from: alerts@example.com
  smtp_smarthost: smtp.example.com:587
  smtp_auth_username: alerts@example.com
  smtp_auth_password: "smtp-password-placeholder-not-real"

route:
  group_by: ["alertname", "namespace", "severity"]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  receiver: "default-pagerduty"

  routes:
    # AlertmanagerConfig routes are inserted here automatically by the operator
    # Platform team alerts
    - match:
        team: platform
      receiver: platform-pagerduty
      routes:
        - match:
            severity: critical
          receiver: platform-pagerduty-critical
          continue: false

    # Inhibit non-critical alerts when a critical alert fires for same target
    inhibit_rules:
      - source_match:
          severity: critical
        target_match_re:
          severity: "warning|info"
        equal: ["namespace", "alertname"]

receivers:
  - name: "default-pagerduty"
    pagerduty_configs:
      - routing_key: "pd-integration-key-placeholder"
        description: "{{ range .Alerts }}{{ .Annotations.summary }}\n{{ end }}"

  - name: "platform-pagerduty"
    pagerduty_configs:
      - routing_key: "pd-platform-key-placeholder"
```

### 4.2 Namespaced AlertmanagerConfig (Multi-Tenant)

Each application team can manage their own alert routing without access to the global Alertmanager configuration:

```yaml
# alertmanagerconfig-team-payments.yaml
apiVersion: monitoring.coreos.com/v1alpha1
kind: AlertmanagerConfig
metadata:
  name: payments-team-routing
  namespace: payments
  labels:
    alertmanager: production
spec:
  route:
    # This config handles alerts where namespace=payments
    # The operator automatically adds a namespace matcher
    groupBy: ["alertname", "service"]
    groupWait: 30s
    groupInterval: 5m
    repeatInterval: 2h
    receiver: payments-slack
    routes:
      - matchers:
          - name: severity
            value: critical
        receiver: payments-pagerduty
        repeatInterval: 30m

  receivers:
    - name: payments-slack
      slackConfigs:
        - apiURL:
            name: payments-slack-secret
            key: webhook-url
          channel: "#payments-alerts"
          sendResolved: true
          title: "[{{ .Status | toUpper }}{{ if eq .Status \"firing\" }}:{{ .Alerts.Firing | len }}{{ end }}] {{ .CommonLabels.alertname }}"
          text: |
            {{ range .Alerts }}
            *Alert:* {{ .Annotations.summary }}
            *Details:*
            {{ range .Labels.SortedPairs }} - *{{ .Name }}:* `{{ .Value }}`
            {{ end }}
            *Source:* {{ .GeneratorURL }}
            {{ end }}

    - name: payments-pagerduty
      pagerdutyConfigs:
        - routingKey:
            name: payments-pagerduty-secret
            key: routing-key
          description: "{{ .CommonAnnotations.summary }}"
          severity: "{{ if .CommonLabels.severity }}{{ .CommonLabels.severity }}{{ else }}warning{{ end }}"
          details:
            firing: "{{ .Alerts.Firing | len }}"
            namespace: "{{ .CommonLabels.namespace }}"
            runbook: "{{ .CommonAnnotations.runbook }}"

  inhibitRules:
    - sourceMatch:
        - name: alertname
          value: PaymentsServiceDown
      targetMatch:
        - name: alertname
          matchType: "=~"
          value: "Payments.*"
      equal: ["namespace"]
```

### 4.3 AlertmanagerConfig for Silence Automation

```yaml
# alertmanagerconfig-maintenance-silence.yaml
# Used during planned maintenance windows
apiVersion: monitoring.coreos.com/v1alpha1
kind: AlertmanagerConfig
metadata:
  name: maintenance-window
  namespace: monitoring
  labels:
    alertmanager: production
  annotations:
    # Automation annotation — remove after maintenance
    maintenance.example.com/expires: "2031-11-15T06:00:00Z"
spec:
  route:
    matchers:
      - name: maintenance
        value: "true"
    receiver: blackhole

  receivers:
    - name: blackhole
      # Empty receiver discards matching alerts
```

## Section 5: Horizontal Sharding

### 5.1 Why Sharding is Necessary

A single Prometheus instance at v2.52 can comfortably handle approximately 1–2 million active time series. Beyond that, ingestion latency increases and memory consumption becomes unmanageable. The Prometheus Operator supports two sharding models:

1. **Static sharding**: Each Prometheus shard scrapes a subset of targets based on a modulo hash of the target's `__address__` label.
2. **Functional sharding**: Different Prometheus instances are configured with different ServiceMonitorSelectors to scrape different service categories.

### 5.2 Static Sharding Configuration

```yaml
# prometheus-sharded.yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: production-sharded
  namespace: monitoring
spec:
  shards: 4    # Creates 4 StatefulSets: prometheus-sharded-0 through -3
  replicas: 2  # 2 replicas per shard = 8 pods total

  # The operator automatically adds a __tmp_hash_of_shard modulo filter
  # to each shard's scrape configuration
  serviceMonitorSelector:
    matchLabels:
      prometheus: production

  # Each shard gets its own storage
  storage:
    volumeClaimTemplate:
      spec:
        storageClassName: fast-nvme
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 150Gi

  # Thanos sidecar for cross-shard querying
  thanos:
    image: quay.io/thanos/thanos:v0.35.0
    objectStorageConfig:
      name: thanos-objstore-config
      key: objstore.yml
    resources:
      requests:
        cpu: 100m
        memory: 256Mi
      limits:
        cpu: 500m
        memory: 1Gi
```

### 5.3 Functional Sharding: Per-Team Prometheus Instances

```yaml
# prometheus-platform-team.yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: platform
  namespace: monitoring
spec:
  replicas: 2
  retention: 15d
  serviceMonitorSelector:
    matchLabels:
      team: platform
      prometheus: platform
  ruleSelector:
    matchLabels:
      team: platform
  externalLabels:
    prometheus_instance: platform
    environment: production

---
# prometheus-application-teams.yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: applications
  namespace: monitoring
spec:
  replicas: 2
  retention: 30d
  serviceMonitorSelector:
    matchExpressions:
      - key: team
        operator: NotIn
        values: ["platform"]
      - key: prometheus
        operator: In
        values: ["applications"]
  ruleSelector:
    matchExpressions:
      - key: team
        operator: NotIn
        values: ["platform"]
  externalLabels:
    prometheus_instance: applications
    environment: production
```

### 5.4 Thanos Query Frontend for Unified View

With multiple Prometheus instances (whether shards or functional), Thanos Query Frontend provides a unified query interface:

```yaml
# thanos-query.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: thanos-query
  namespace: monitoring
spec:
  replicas: 2
  selector:
    matchLabels:
      app: thanos-query
  template:
    metadata:
      labels:
        app: thanos-query
    spec:
      containers:
        - name: thanos-query
          image: quay.io/thanos/thanos:v0.35.0
          args:
            - query
            - --log.level=info
            - --grpc-address=0.0.0.0:10901
            - --http-address=0.0.0.0:9090
            - --query.partial-response
            - --query.replica-label=prometheus_replica
            - --query.replica-label=replica
            # Store endpoints: one per shard StatefulSet pod
            - --store=dnssrv+_grpc._tcp.prometheus-operated.monitoring.svc.cluster.local
          ports:
            - name: http
              containerPort: 9090
            - name: grpc
              containerPort: 10901
          livenessProbe:
            httpGet:
              path: /-/healthy
              port: http
          readinessProbe:
            httpGet:
              path: /-/ready
              port: http
```

## Section 6: Advanced ServiceMonitor Patterns

### 6.1 Dynamic Relabeling for Multi-Cloud

```yaml
# servicemonitor-multi-cloud-relabeling.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: cross-cloud-services
  namespace: monitoring
  labels:
    prometheus: production
spec:
  selector:
    matchLabels:
      monitored: "true"
  endpoints:
    - port: metrics
      interval: 30s
      relabelings:
        # Extract region from node label via pod-to-node mapping
        - sourceLabels: [__meta_kubernetes_pod_node_name]
          targetLabel: __tmp_node
        - sourceLabels: [__meta_kubernetes_node_label_topology_kubernetes_io_region]
          targetLabel: cloud_region
        - sourceLabels: [__meta_kubernetes_node_label_topology_kubernetes_io_zone]
          targetLabel: cloud_zone
        - sourceLabels: [__meta_kubernetes_pod_label_app_kubernetes_io_version]
          targetLabel: app_version
        # Drop the __tmp labels before storing
        - regex: __tmp.*
          action: labeldrop
      metricRelabelings:
        # Normalize metric names from different exporters
        - sourceLabels: [__name__]
          regex: "myapp_http_requests_total"
          targetLabel: __name__
          replacement: "http_requests_total"
        # Apply cardinality limit: drop high-cardinality user_id label
        - regex: user_id
          action: labeldrop
```

### 6.2 ScrapeConfig for External Targets

```yaml
# scrapeconfig-external-targets.yaml
# Prometheus Operator v0.65+ supports ScrapeConfig CRD
apiVersion: monitoring.coreos.com/v1alpha1
kind: ScrapeConfig
metadata:
  name: external-databases
  namespace: monitoring
  labels:
    prometheus: production
spec:
  staticConfigs:
    - labels:
        job: external-postgres
        environment: production
      targets:
        - "db-primary.example.com:9187"
        - "db-replica-1.example.com:9187"
        - "db-replica-2.example.com:9187"

  tlsConfig:
    ca:
      secret:
        name: external-ca-cert
        key: ca.crt
    insecureSkipVerify: false

  metricsPath: /metrics
  scrapeInterval: 30s
  scrapeTimeout: 10s
```

## Section 7: Operational Runbooks

### 7.1 Diagnosing Scrape Failures

```bash
# Check Prometheus targets status
kubectl port-forward -n monitoring svc/prometheus-operated 9090 &
sleep 2

# List all targets and their status
curl -s http://localhost:9090/api/v1/targets | \
  jq '.data.activeTargets[] | select(.health != "up") | {
    job: .labels.job,
    instance: .labels.instance,
    health: .health,
    lastError: .lastError,
    lastScrape: .lastScrape
  }'

# Check ServiceMonitor discovery
kubectl get servicemonitor -A -o json | jq '
  .items[] | {
    name: .metadata.name,
    namespace: .metadata.namespace,
    selector: .spec.selector,
    endpoints: [.spec.endpoints[].port]
  }'
```

### 7.2 Rule Group Performance Analysis

```bash
# Find slow recording rules
curl -s http://localhost:9090/api/v1/rules | jq '
  .data.groups[].rules[]
  | select(.type == "recording")
  | select(.evaluationTime > 0.5)
  | {
    name: .name,
    evaluationTime: .evaluationTime,
    lastEvaluation: .lastEvaluation
  }
' | sort_by(.evaluationTime) | reverse | head -20

# Check for stale rule evaluation
curl -s http://localhost:9090/api/v1/rules | jq '
  .data.groups[]
  | select(.lastEvaluation | fromdateiso8601 < (now - 120))
  | {
    name: .name,
    lastEvaluation: .lastEvaluation,
    evaluationTime: .evaluationTime
  }'
```

### 7.3 Cardinality Management

```bash
# Find the top series by label cardinality
curl -s 'http://localhost:9090/api/v1/query?query=topk(20,count by (__name__)({__name__!=""}))' | \
  jq '.data.result[] | {metric: .metric.__name__, count: .value[1] | tonumber}' | \
  sort_by(.count) | reverse | head -20

# Find unexpected high-cardinality labels
curl -s 'http://localhost:9090/api/v1/label/__names__/values' | \
  jq '.data[]' | while read -r name; do
    count=$(curl -s "http://localhost:9090/api/v1/label/${name}/values" | jq '.data | length')
    echo "$count $name"
  done | sort -rn | head -20
```

## Summary

Prometheus Operator v0.7x provides a production-ready declarative management layer for Prometheus and Alertmanager on Kubernetes. The operational patterns that matter most are:

1. **ServiceMonitor label selectors** must match both the ServiceMonitor labels and the Prometheus `serviceMonitorSelector`. Track this carefully as teams proliferate — a mismatch is the most common cause of targets disappearing from Prometheus.

2. **PrometheusRule recording rules** are not optional for large deployments. Dashboards that query raw counters at high cardinality will time out; pre-compute with recording rules at 30-second intervals.

3. **AlertmanagerConfig** enables genuine multi-tenancy for alerts. Teams own their routing subtree, receivers, and inhibitions without cluster-admin access to the global Alertmanager configuration.

4. **Sharding** should be considered once active time series consistently exceed 800K on any Prometheus instance. Functional sharding (by team or service category) is operationally simpler than static hash sharding; it requires a Thanos or similar query layer for cross-instance queries.

5. **Cardinality management** is an ongoing discipline. Add `metricRelabelings` to every ServiceMonitor from day one to drop known high-cardinality labels, and set up cardinality monitoring via the Prometheus API to catch problems before they impact ingestion performance.
