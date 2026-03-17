---
title: "Prometheus Operator Advanced: Custom Metrics, Federation, and Remote Write"
date: 2027-09-22T00:00:00-05:00
draft: false
tags: ["Prometheus", "Kubernetes", "Monitoring", "Prometheus Operator", "Alertmanager", "Thanos"]
categories: ["Monitoring", "Kubernetes"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Advanced Prometheus Operator patterns covering PrometheusRule management, cross-namespace ServiceMonitor federation, metric relabeling, remote_write to Mimir and Thanos, sharding for large-scale deployments, and AlertmanagerConfig."
more_link: "yes"
url: "/prometheus-operator-advanced-guide/"
---

The Prometheus Operator translates Kubernetes-native Custom Resource Definitions into Prometheus configuration files, enabling declarative metric collection at enterprise scale. Beyond basic ServiceMonitor deployment, production teams encounter challenges around PrometheusRule validation and testing, cross-namespace scrape federation, remote_write reliability to long-term storage backends, horizontal sharding for clusters with hundreds of thousands of active series, and distributed alerting coordination with AlertmanagerConfig. This guide covers all of these patterns with production-ready YAML.

<!--more-->

## Operator Architecture and CRD Relationships

The Prometheus Operator manages six primary CRDs:

| CRD | Purpose |
|-----|---------|
| `Prometheus` | StatefulSet spec and global configuration |
| `PrometheusRule` | Recording rules and alerting rules |
| `ServiceMonitor` | Scrape config generated from Service selectors |
| `PodMonitor` | Scrape config generated from Pod selectors |
| `Probe` | Blackbox/synthetic monitoring targets |
| `Alertmanager` | Alertmanager StatefulSet spec |
| `AlertmanagerConfig` | Per-namespace Alertmanager routing/receiver config |
| `ThanosRuler` | Thanos Ruler deployment for federated alerting |

The operator watches all namespaces for these resources and reconciles the Prometheus StatefulSet configuration files. Changes to PrometheusRule resources trigger a configuration reload (SIGHUP) rather than a pod restart.

## PrometheusRule Management

### Rule Validation with promtool

All PrometheusRule resources should be validated before deployment. The `promtool` utility checks syntax, label requirements, and unit test assertions.

```yaml
# rules/api-latency.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: api-latency-rules
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
    app.kubernetes.io/part-of: kube-prometheus
spec:
  groups:
    - name: api.latency
      interval: 30s
      rules:
        # Recording rule: pre-aggregate P99 latency by service and environment
        - record: service:http_request_duration_seconds:p99
          expr: |
            histogram_quantile(0.99,
              sum by (service, environment, le) (
                rate(http_request_duration_seconds_bucket[5m])
              )
            )

        # Recording rule: request rate by service
        - record: service:http_requests:rate5m
          expr: |
            sum by (service, environment, method, status_code) (
              rate(http_requests_total[5m])
            )

        # Alert: high P99 latency
        - alert: APIHighLatencyP99
          expr: |
            service:http_request_duration_seconds:p99{environment="production"} > 1.0
          for: 5m
          labels:
            severity: warning
            team: platform
            runbook: "https://runbooks.example.com/api-high-latency"
          annotations:
            summary: "Service {{ $labels.service }} P99 latency {{ $value | humanizeDuration }} exceeds SLO"
            description: |
              The P99 response latency for {{ $labels.service }} in {{ $labels.environment }}
              has exceeded 1 second for 5 consecutive minutes.
              Current value: {{ $value | humanizeDuration }}

        # Alert: high error rate
        - alert: APIHighErrorRate
          expr: |
            (
              sum by (service, environment) (
                rate(http_requests_total{status_code=~"5.."}[5m])
              )
              /
              sum by (service, environment) (
                rate(http_requests_total[5m])
              )
            ) > 0.01
          for: 2m
          labels:
            severity: critical
            team: platform
            runbook: "https://runbooks.example.com/api-error-rate"
          annotations:
            summary: "Service {{ $labels.service }} error rate {{ $value | humanizePercentage }} exceeds 1%"
```

### promtool Unit Tests

```yaml
# tests/api-latency_test.yaml
rule_files:
  - api-latency.yaml

evaluation_interval: 30s

tests:
  - interval: 30s
    input_series:
      # Simulate high-latency histogram buckets
      - series: 'http_request_duration_seconds_bucket{service="payments",environment="production",le="0.5"}'
        values: "100+0x10"
      - series: 'http_request_duration_seconds_bucket{service="payments",environment="production",le="1.0"}'
        values: "150+0x10"
      - series: 'http_request_duration_seconds_bucket{service="payments",environment="production",le="2.0"}'
        values: "200+0x10"
      - series: 'http_request_duration_seconds_bucket{service="payments",environment="production",le="+Inf"}'
        values: "250+0x10"

    alert_rule_test:
      - eval_time: 5m
        alertname: APIHighLatencyP99
        exp_alerts:
          - exp_labels:
              severity: warning
              team: platform
              service: payments
              environment: production
            exp_annotations:
              summary: "Service payments P99 latency 1.6s exceeds SLO"

  - interval: 30s
    input_series:
      # Normal traffic — no alert expected
      - series: 'http_request_duration_seconds_bucket{service="auth",environment="production",le="0.5"}'
        values: "1000+10x10"
      - series: 'http_request_duration_seconds_bucket{service="auth",environment="production",le="+Inf"}'
        values: "1000+10x10"

    alert_rule_test:
      - eval_time: 5m
        alertname: APIHighLatencyP99
        exp_alerts: []
```

Run validation:

```bash
# Validate rule syntax
promtool check rules rules/api-latency.yaml

# Run unit tests
promtool test rules tests/api-latency_test.yaml

# Test output:
# Unit Testing:  tests/api-latency_test.yaml
#   SUCCESS
```

### CI/CD Validation Workflow

```yaml
# .github/workflows/validate-rules.yaml
name: Validate Prometheus Rules

on:
  pull_request:
    paths:
      - "monitoring/rules/**"
      - "monitoring/tests/**"

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install promtool
        run: |
          PROM_VERSION="2.50.1"
          curl -sSL "https://github.com/prometheus/prometheus/releases/download/v${PROM_VERSION}/prometheus-${PROM_VERSION}.linux-amd64.tar.gz" \
            | tar -xz "prometheus-${PROM_VERSION}.linux-amd64/promtool"
          mv "prometheus-${PROM_VERSION}.linux-amd64/promtool" /usr/local/bin/promtool

      - name: Validate all rule files
        run: |
          find monitoring/rules -name "*.yaml" -exec promtool check rules {} \;

      - name: Run unit tests
        run: |
          find monitoring/tests -name "*_test.yaml" -exec promtool test rules {} \;

      - name: Validate Kubernetes YAML
        run: |
          kubectl --dry-run=client apply -f monitoring/rules/ -R
```

## Cross-Namespace ServiceMonitor Federation

### Enabling Cross-Namespace Discovery

By default, Prometheus only discovers ServiceMonitors in namespaces matching its `serviceMonitorNamespaceSelector`. To enable cluster-wide discovery:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: kube-prometheus
  namespace: monitoring
spec:
  # Allow ServiceMonitors from any namespace
  serviceMonitorNamespaceSelector: {}
  serviceMonitorSelector:
    matchLabels:
      prometheus: kube-prometheus

  # Allow PodMonitors from any namespace
  podMonitorNamespaceSelector: {}
  podMonitorSelector:
    matchLabels:
      prometheus: kube-prometheus

  # RBAC: grant cross-namespace read access
  serviceAccountName: kube-prometheus

  replicas: 2
  retention: 30d
  retentionSize: 50GB

  storage:
    volumeClaimTemplate:
      spec:
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 100Gi
```

Grant the Prometheus service account read access to Services and Endpoints across all namespaces:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: prometheus-cross-namespace
rules:
  - apiGroups: [""]
    resources: ["services", "endpoints", "pods", "nodes", "nodes/proxy", "nodes/metrics"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["extensions", "networking.k8s.io"]
    resources: ["ingresses"]
    verbs: ["get", "list", "watch"]
  - nonResourceURLs: ["/metrics", "/metrics/cadvisor"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: prometheus-cross-namespace
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: prometheus-cross-namespace
subjects:
  - kind: ServiceAccount
    name: kube-prometheus
    namespace: monitoring
```

### Application-Side ServiceMonitor

Application teams deploy ServiceMonitors in their own namespace that the central Prometheus discovers:

```yaml
# Deployed by the payments team in namespace: payments
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: payments-api
  namespace: payments
  labels:
    prometheus: kube-prometheus     # matches central Prometheus selector
    team: payments
spec:
  selector:
    matchLabels:
      app: payments-api
  namespaceSelector:
    matchNames:
      - payments
  endpoints:
    - port: metrics
      path: /metrics
      interval: 15s
      scrapeTimeout: 10s
      scheme: https
      tlsConfig:
        caFile: /etc/prometheus/certs/ca.crt
        certFile: /etc/prometheus/certs/tls.crt
        keyFile: /etc/prometheus/certs/tls.key
        serverName: payments-api.payments.svc.cluster.local
      relabelings:
        # Add namespace label to all metrics
        - sourceLabels: [__meta_kubernetes_namespace]
          targetLabel: namespace
        # Add pod name
        - sourceLabels: [__meta_kubernetes_pod_name]
          targetLabel: pod
        # Add deployment name via pod labels
        - sourceLabels: [__meta_kubernetes_pod_label_app]
          targetLabel: deployment
      metricRelabelings:
        # Drop high-cardinality debug metrics
        - sourceLabels: [__name__]
          regex: "go_.*|process_.*"
          action: drop
        # Normalize environment label values
        - sourceLabels: [env]
          regex: "prod|production|prd"
          replacement: "production"
          targetLabel: environment
```

## Metric Relabeling Patterns

### Drop High-Cardinality Metrics

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: high-volume-app
  namespace: monitoring
spec:
  endpoints:
    - port: metrics
      metricRelabelings:
        # Drop all metrics with more than 3 label dimensions to control cardinality
        # This example drops per-user metrics that have unbounded cardinality
        - sourceLabels: [user_id]
          regex: ".+"
          action: drop

        # Drop histogram bucket metrics for non-critical paths
        - sourceLabels: [__name__, handler]
          regex: "http_request_duration_seconds_bucket;/debug/.*"
          action: drop

        # Keep only the required percentile buckets for latency histograms
        - sourceLabels: [__name__, le]
          regex: "http_request_duration_seconds_bucket;(0\\.1|0\\.25|0\\.5|0\\.75|0\\.9|0\\.95|0\\.99|\\+Inf)"
          action: keep

        # Hash high-cardinality labels to a fixed-cardinality representation
        - sourceLabels: [request_id]
          regex: ".{8}(.*)"
          replacement: "truncated"
          targetLabel: request_id
```

### Aggregation Recording Rules for Cost Reduction

Replace high-cardinality raw metrics with pre-aggregated recording rules before remote_write:

```yaml
spec:
  groups:
    - name: aggregation.pre-remote-write
      interval: 60s
      rules:
        # Aggregate request counters to service level before remote write
        - record: cluster:http_requests:rate5m
          expr: |
            sum without (pod, instance, node) (
              rate(http_requests_total[5m])
            )

        # Aggregate latency histograms to service level
        - record: cluster:http_request_duration_seconds_bucket:rate5m
          expr: |
            sum without (pod, instance, node) (
              rate(http_request_duration_seconds_bucket[5m])
            )

        - record: cluster:http_request_duration_seconds_count:rate5m
          expr: |
            sum without (pod, instance, node) (
              rate(http_request_duration_seconds_count[5m])
            )

        - record: cluster:http_request_duration_seconds_sum:rate5m
          expr: |
            sum without (pod, instance, node) (
              rate(http_request_duration_seconds_sum[5m])
            )
```

## Remote Write Configuration

### Remote Write to Grafana Mimir

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: kube-prometheus
  namespace: monitoring
spec:
  remoteWrite:
    - url: "https://mimir.example.com/api/v1/push"
      name: mimir-primary

      # TLS configuration for mTLS to Mimir
      tlsConfig:
        caFile: /etc/prometheus/secrets/mimir-tls/ca.crt
        certFile: /etc/prometheus/secrets/mimir-tls/tls.crt
        keyFile: /etc/prometheus/secrets/mimir-tls/tls.key

      # Authorization header from Kubernetes secret
      authorization:
        credentials:
          name: mimir-remote-write-auth
          key: token

      # Tenant identification (Mimir multi-tenancy)
      headers:
        X-Scope-OrgID: "production-cluster-01"

      # Queue configuration for high-throughput
      queueConfig:
        capacity: 100000
        maxSamplesPerSend: 10000
        batchSendDeadline: 5s
        minShards: 4
        maxShards: 32
        minBackoff: 30ms
        maxBackoff: 5s

      # Write relabeling: only send pre-aggregated metrics to remote
      writeRelabelConfigs:
        - sourceLabels: [__name__]
          regex: "cluster:.*"
          action: keep
        - sourceLabels: [__name__]
          regex: "ALERTS|ALERTS_FOR_STATE"
          action: keep

    # Secondary: send all metrics to Thanos sidecar
    - url: "http://localhost:19291/api/v1/receive"
      name: thanos-sidecar
      queueConfig:
        capacity: 500000
        maxSamplesPerSend: 50000
        maxShards: 50
        minBackoff: 30ms
        maxBackoff: 100ms
      writeRelabelConfigs:
        # Drop debug and cardinality-heavy metrics from long-term storage
        - sourceLabels: [__name__]
          regex: "go_.*|process_.*|promhttp_.*"
          action: drop
```

### Remote Write Secret for Authentication

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: mimir-remote-write-auth
  namespace: monitoring
type: Opaque
stringData:
  # Replace with actual token value
  token: "REPLACE_WITH_ACTUAL_MIMIR_TOKEN"
```

### Remote Write Health Monitoring

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: remote-write-health
  namespace: monitoring
spec:
  groups:
    - name: remote-write
      rules:
        - alert: RemoteWriteDroppedSamples
          expr: |
            rate(prometheus_remote_storage_samples_dropped_total[5m]) > 100
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Prometheus remote_write {{ $labels.remote_name }} dropping {{ $value | humanize }} samples/s"

        - alert: RemoteWriteQueueNotDraining
          expr: |
            prometheus_remote_storage_queue_highest_sent_timestamp_seconds
            - ignoring(remote_name, url) group_right
            prometheus_remote_storage_highest_timestamp_in_seconds
            < -300
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Remote write queue {{ $labels.remote_name }} is {{ $value | humanizeDuration }} behind"

        - alert: RemoteWriteShardMaxed
          expr: |
            prometheus_remote_storage_shards == prometheus_remote_storage_shards_max
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "Remote write {{ $labels.remote_name }} has maxed out shards; increase maxShards"
```

## Horizontal Sharding

For clusters with more than 2 million active time series, a single Prometheus instance cannot keep up with scrape and query load. Sharding distributes series across multiple Prometheus replicas using a consistent hash of the `__address__` label.

### Shard Configuration

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: kube-prometheus-shard-0
  namespace: monitoring
spec:
  shards: 4          # Total number of shards
  # The operator sets PROMETHEUS_SHARD_NUMBER env var; each shard scrapes
  # only targets where hash(address) % shards == shard_number

  # Each shard has its own storage
  storage:
    volumeClaimTemplate:
      spec:
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 50Gi

  # Shard-level recording rules aggregate to cluster level for the Thanos Query tier
  additionalScrapeConfigs:
    name: additional-scrape-configs
    key: prometheus-additional.yaml
```

When `shards: 4` is set, the operator creates four Prometheus StatefulSets: `prometheus-kube-prometheus-0` through `prometheus-kube-prometheus-3`. Each StatefulSet scrapes only the targets consistent-hashed to its shard number.

### Querying Sharded Data with Thanos Query

```yaml
# Thanos Query deployment aggregating all shards
apiVersion: apps/v1
kind: Deployment
metadata:
  name: thanos-query
  namespace: monitoring
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: thanos-query
          image: quay.io/thanos/thanos:v0.35.0
          args:
            - query
            - --http-address=0.0.0.0:9090
            - --grpc-address=0.0.0.0:10901
            - --query.replica-label=prometheus_replica
            - --query.replica-label=prometheus
            # StoreAPI endpoints for each shard (or use --store.sd-files for dynamic discovery)
            - --store=dnssrv+_grpc._tcp.prometheus-operated.monitoring.svc.cluster.local
            - --store=thanos-store-gateway.monitoring.svc.cluster.local:10901
            - --query.auto-downsampling
          ports:
            - name: http
              containerPort: 9090
            - name: grpc
              containerPort: 10901
```

## ThanosRuler for Federated Alerting

ThanosRuler evaluates alerting rules across all shards, eliminating per-shard rule duplication:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ThanosRuler
metadata:
  name: thanos-ruler
  namespace: monitoring
spec:
  image: quay.io/thanos/thanos:v0.35.0
  replicas: 2

  # Query endpoint for evaluating rules against aggregated data
  queryConfig:
    key: query-config.yaml
    name: thanos-ruler-query-config

  # Rules to evaluate (matches PrometheusRule labels)
  ruleSelector:
    matchLabels:
      role: thanos-alert-rules

  # Alertmanager endpoint
  alertmanagersConfig:
    key: alertmanager-config.yaml
    name: thanos-ruler-alertmanager-config

  storage:
    volumeClaimTemplate:
      spec:
        storageClassName: standard
        resources:
          requests:
            storage: 10Gi

  # Object storage for rule evaluation state (optional)
  objectStorageConfig:
    key: objstore.yaml
    name: thanos-object-store-config
```

```yaml
# ConfigMap: thanos-ruler-query-config
apiVersion: v1
kind: ConfigMap
metadata:
  name: thanos-ruler-query-config
  namespace: monitoring
data:
  query-config.yaml: |
    - http://thanos-query.monitoring.svc.cluster.local:9090
```

```yaml
# PrometheusRule targeting ThanosRuler (different label)
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: slo-alerting-rules
  namespace: monitoring
  labels:
    role: thanos-alert-rules    # ThanosRuler selector
    prometheus: kube-prometheus  # Also loaded by local Prometheus
spec:
  groups:
    - name: slo.availability
      rules:
        - alert: ServiceAvailabilityBelowSLO
          expr: |
            (
              1 - (
                sum by (service, environment) (
                  rate(http_requests_total{status_code=~"5.."}[30m])
                )
                /
                sum by (service, environment) (
                  rate(http_requests_total[30m])
                )
              )
            ) < 0.999
          for: 1m
          labels:
            severity: critical
            slo: availability
          annotations:
            summary: "Service {{ $labels.service }} availability {{ $value | humanizePercentage }} below 99.9% SLO"
```

## AlertmanagerConfig for Per-Namespace Routing

AlertmanagerConfig enables application teams to manage their own alert routing rules without modifying the global Alertmanager configuration:

```yaml
apiVersion: monitoring.coreos.com/v1alpha1
kind: AlertmanagerConfig
metadata:
  name: payments-team-alerts
  namespace: payments
spec:
  route:
    groupBy: ["alertname", "service", "environment"]
    groupWait: 30s
    groupInterval: 5m
    repeatInterval: 4h
    matchers:
      - name: team
        value: payments
        matchType: "="
    routes:
      - matchers:
          - name: severity
            value: critical
        receiver: payments-pagerduty
        repeatInterval: 1h
      - matchers:
          - name: severity
            value: warning
        receiver: payments-slack

  receivers:
    - name: payments-pagerduty
      pagerdutyConfigs:
        - routingKey:
            name: payments-pagerduty-secret
            key: routing-key
          description: |
            {{ range .Alerts }}
            Alert: {{ .Annotations.summary }}
            Runbook: {{ .Labels.runbook }}
            {{ end }}
          severity: "{{ .CommonLabels.severity }}"
          class: "{{ .CommonLabels.alertname }}"
          group: "payments"
          component: "{{ .CommonLabels.service }}"

    - name: payments-slack
      slackConfigs:
        - apiURL:
            name: payments-slack-secret
            key: webhook-url
          channel: "#payments-alerts"
          iconEmoji: ":prometheus:"
          title: '[{{ .Status | toUpper }}] {{ .CommonAnnotations.summary }}'
          text: |
            *Alert:* {{ .CommonAnnotations.summary }}
            *Severity:* {{ .CommonLabels.severity }}
            *Service:* {{ .CommonLabels.service }}
            *Runbook:* {{ .CommonLabels.runbook }}
          sendResolved: true
```

### Global Alertmanager with AlertmanagerConfig Integration

The global Alertmanager must be configured to accept AlertmanagerConfig resources by specifying the `alertmanagerConfigSelector`:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Alertmanager
metadata:
  name: kube-alertmanager
  namespace: monitoring
spec:
  replicas: 3
  image: quay.io/prometheus/alertmanager:v0.27.0

  # Allow AlertmanagerConfig from any namespace
  alertmanagerConfigNamespaceSelector: {}
  alertmanagerConfigSelector:
    matchLabels: {}  # empty matches all AlertmanagerConfig resources

  # Gossip-based HA clustering
  clusterPeerTimeout: 15s

  storage:
    volumeClaimTemplate:
      spec:
        storageClassName: standard
        resources:
          requests:
            storage: 5Gi

  # Global default configuration
  configSecret: alertmanager-global-config
```

## Prometheus Operator Upgrade Strategy

### In-Place Rolling Upgrade

```bash
# Check current CRD version
kubectl get crds prometheuses.monitoring.coreos.com -o jsonpath='{.spec.versions[*].name}'

# Apply new CRDs first (CRDs are backward-compatible within the same major version)
kubectl apply --server-side -f https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/v0.73.0/example/prometheus-operator-crd/monitoring.coreos.com_prometheuses.yaml
kubectl apply --server-side -f https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/v0.73.0/example/prometheus-operator-crd/monitoring.coreos.com_prometheusrules.yaml
kubectl apply --server-side -f https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/v0.73.0/example/prometheus-operator-crd/monitoring.coreos.com_servicemonitors.yaml
kubectl apply --server-side -f https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/v0.73.0/example/prometheus-operator-crd/monitoring.coreos.com_alertmanagers.yaml
kubectl apply --server-side -f https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/v0.73.0/example/prometheus-operator-crd/monitoring.coreos.com_alertmanagerconfigs.yaml
kubectl apply --server-side -f https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/v0.73.0/example/prometheus-operator-crd/monitoring.coreos.com_thanosrulers.yaml

# Update operator deployment
kubectl set image deployment/prometheus-operator \
  prometheus-operator=quay.io/prometheus-operator/prometheus-operator:v0.73.0 \
  -n monitoring

# Monitor rollout
kubectl rollout status deployment/prometheus-operator -n monitoring

# Verify Prometheus StatefulSets are healthy after operator restart
kubectl get statefulsets -n monitoring
kubectl get pods -n monitoring -l prometheus=kube-prometheus
```

### Validation After Upgrade

```bash
# Verify all PrometheusRule resources were loaded successfully
kubectl get prometheusrules -A

# Check operator logs for any reconciliation errors
kubectl logs -n monitoring deployment/prometheus-operator --since=5m \
  | grep -E "level=error|failed to|reconcile error"

# Verify scrape targets are healthy
kubectl port-forward -n monitoring svc/prometheus-operated 9090:9090 &
curl -s http://localhost:9090/api/v1/targets | \
  python3 -c "import sys,json; d=json.load(sys.stdin); \
  down=[t for t in d['data']['activeTargets'] if t['health']=='down']; \
  print(f'Down targets: {len(down)}')"

# Check alert rules are loaded
curl -s http://localhost:9090/api/v1/rules | \
  python3 -c "import sys,json; d=json.load(sys.stdin); \
  rules=[r for g in d['data']['groups'] for r in g['rules']]; \
  print(f'Total rules loaded: {len(rules)}')"
```

## Cardinality Management

### Identifying High-Cardinality Metrics

```bash
# Query top-20 metrics by time series count
curl -sG http://localhost:9090/api/v1/label/__name__/values | \
  python3 -c "
import sys, json, urllib.request
names = json.load(sys.stdin)['data']
counts = []
for name in names[:200]:  # Sample first 200
    resp = urllib.request.urlopen(f'http://localhost:9090/api/v1/series?match[]={name}')
    data = json.load(resp)
    counts.append((len(data['data']), name))
counts.sort(reverse=True)
for count, name in counts[:20]:
    print(f'{count:8d}  {name}')
"

# Use TSDB status endpoint for cardinality overview
curl -sG http://localhost:9090/api/v1/status/tsdb | \
  python3 -m json.tool | grep -A50 '"headStats"'
```

### Applying Cardinality Limits

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: kube-prometheus
  namespace: monitoring
spec:
  # Global per-scrape sample limit
  enforcedSampleLimit: 50000

  # Per-ServiceMonitor limits (can be overridden per monitor)
  enforcedTargetLimit: 1000
  enforcedLabelLimit: 50
  enforcedLabelNameLengthLimit: 100
  enforcedLabelValueLengthLimit: 512
```

Per-ServiceMonitor sample limits override the global setting:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: high-volume-service
  namespace: monitoring
spec:
  endpoints:
    - port: metrics
      sampleLimit: 100000    # Override global limit for this target
      targetLimit: 50
      labelLimit: 30
```
