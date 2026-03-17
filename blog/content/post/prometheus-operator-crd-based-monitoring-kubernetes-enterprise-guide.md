---
title: "Prometheus Operator: CRD-Based Monitoring Stack Management for Kubernetes"
date: 2030-07-13T00:00:00-05:00
draft: false
tags: ["Prometheus", "Kubernetes", "Monitoring", "Observability", "Operator", "AlertManager", "ServiceMonitor"]
categories:
- Kubernetes
- Monitoring
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise Prometheus Operator guide covering ServiceMonitor and PodMonitor CRDs, PrometheusRule management, AlertmanagerConfig, TLS configuration, RBAC-scoped monitoring, and managing large multi-cluster monitoring deployments."
more_link: "yes"
url: "/prometheus-operator-crd-based-monitoring-kubernetes-enterprise-guide/"
---

The Prometheus Operator transforms monitoring configuration from a static YAML problem into a Kubernetes-native declarative workflow. By introducing Custom Resource Definitions (CRDs) for every component of the monitoring stack, the operator enables teams to version-control their monitoring configuration alongside application code, apply RBAC policies to scrape targets, and manage hundreds of Prometheus instances across multi-cluster environments without centralized configuration sprawl.

<!--more-->

## Overview and Architecture

The Prometheus Operator was originally developed by CoreOS and is now maintained under the prometheus-operator GitHub organization. It provisions and manages Prometheus, Alertmanager, and related components by watching Kubernetes custom resources and reconciling the desired state. The operator itself runs as a Deployment and translates CRD objects into StatefulSet configuration, ConfigMap mounts, and service discovery rules.

### Core CRDs

The operator introduces six primary CRDs:

| CRD | Purpose |
|-----|---------|
| `Prometheus` | Defines a Prometheus instance including retention, storage, and scrape config |
| `Alertmanager` | Manages Alertmanager cluster configuration and routing |
| `ServiceMonitor` | Declares scrape targets via Service label selectors |
| `PodMonitor` | Declares scrape targets directly from Pod labels |
| `PrometheusRule` | Manages recording rules and alerting rules |
| `AlertmanagerConfig` | Scopes Alertmanager routing/receiver config per namespace |

A `Probe` CRD handles blackbox-style probing, and `ThanosRuler` manages Thanos ruler deployments for long-term storage integrations.

### Operator Installation via kube-prometheus-stack

The recommended production installation path is the `kube-prometheus-stack` Helm chart, which bundles the operator, Prometheus, Alertmanager, Grafana, and a suite of default rules.

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace \
  --version 58.4.0 \
  --values values-production.yaml
```

A production-grade `values-production.yaml`:

```yaml
# values-production.yaml
global:
  resolve_timeout: 5m

crds:
  enabled: true

prometheusOperator:
  enabled: true
  replicaCount: 2
  resources:
    requests:
      cpu: 200m
      memory: 256Mi
    limits:
      cpu: 500m
      memory: 512Mi
  tolerations:
    - key: node-role.kubernetes.io/infra
      operator: Exists
      effect: NoSchedule
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app.kubernetes.io/name: prometheus-operator
          topologyKey: kubernetes.io/hostname

prometheus:
  enabled: true
  prometheusSpec:
    replicas: 2
    retention: 30d
    retentionSize: "80GB"
    storageSpec:
      volumeClaimTemplate:
        spec:
          storageClassName: fast-ssd
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 100Gi
    resources:
      requests:
        cpu: 2000m
        memory: 8Gi
      limits:
        cpu: 4000m
        memory: 16Gi
    # Allow the Prometheus instance to pick up ServiceMonitors from all namespaces
    serviceMonitorNamespaceSelector: {}
    serviceMonitorSelector: {}
    podMonitorNamespaceSelector: {}
    podMonitorSelector: {}
    ruleNamespaceSelector: {}
    ruleSelector: {}
    # External labels for federation and remote write identification
    externalLabels:
      cluster: prod-us-east-1
      environment: production
    # Remote write to long-term storage (Thanos/Cortex/Mimir)
    remoteWrite:
      - url: "http://thanos-receive.monitoring:19291/api/v1/receive"
        queueConfig:
          maxSamplesPerSend: 10000
          maxShards: 30
          capacity: 2500
    # WAL compression for storage efficiency
    walCompression: true
    # Enable TSDB head compaction
    enableFeatures:
      - memory-snapshot-on-shutdown
      - exemplar-storage

alertmanager:
  enabled: true
  alertmanagerSpec:
    replicas: 3
    storage:
      volumeClaimTemplate:
        spec:
          storageClassName: standard
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 10Gi
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        cpu: 500m
        memory: 512Mi

grafana:
  enabled: true
  adminPassword: "<grafana-admin-password>"
  persistence:
    enabled: true
    size: 20Gi
  grafana.ini:
    server:
      root_url: "https://grafana.prod.example.com"
    auth.generic_oauth:
      enabled: true
      name: "SSO"
      allow_sign_up: true
      client_id: "<oauth-client-id>"
      scopes: "openid email profile groups"
      auth_url: "https://sso.example.com/oauth/authorize"
      token_url: "https://sso.example.com/oauth/token"
      api_url: "https://sso.example.com/userinfo"
```

## ServiceMonitor CRD Deep Dive

The `ServiceMonitor` is the most commonly used CRD for configuring scrape targets. It selects Services by label and specifies how to scrape their endpoints.

### Basic ServiceMonitor

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: api-gateway
  namespace: production
  labels:
    app.kubernetes.io/name: api-gateway
    monitoring: "true"
spec:
  selector:
    matchLabels:
      app: api-gateway
  endpoints:
    - port: metrics
      interval: 30s
      scrapeTimeout: 10s
      path: /metrics
  namespaceSelector:
    matchNames:
      - production
```

### ServiceMonitor with TLS and Authentication

For services that expose metrics over HTTPS with mutual TLS:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: secure-service-monitor
  namespace: monitoring
  labels:
    team: platform
spec:
  selector:
    matchLabels:
      app: secure-api
      metrics-enabled: "true"
  endpoints:
    - port: https-metrics
      interval: 15s
      scheme: https
      tlsConfig:
        caFile: /etc/prometheus/secrets/mtls-ca/ca.crt
        certFile: /etc/prometheus/secrets/mtls-client/tls.crt
        keyFile: /etc/prometheus/secrets/mtls-client/tls.key
        serverName: secure-api.production.svc.cluster.local
        insecureSkipVerify: false
      bearerTokenFile: /var/run/secrets/kubernetes.io/serviceaccount/token
      relabelings:
        - sourceLabels: [__meta_kubernetes_pod_name]
          targetLabel: pod
        - sourceLabels: [__meta_kubernetes_namespace]
          targetLabel: namespace
        - sourceLabels: [__meta_kubernetes_service_name]
          targetLabel: service
      metricRelabelings:
        # Drop high-cardinality metrics that are not useful
        - sourceLabels: [__name__]
          regex: "go_gc_duration_seconds_bucket"
          action: drop
        # Normalize environment label values
        - sourceLabels: [env]
          regex: "(prod|production)"
          targetLabel: env
          replacement: "production"
  namespaceSelector:
    matchNames:
      - production
      - staging
```

### ServiceMonitor with OAuth2 Scraping

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: oauth2-protected-metrics
  namespace: monitoring
spec:
  selector:
    matchLabels:
      metrics-auth: oauth2
  endpoints:
    - port: metrics
      interval: 30s
      oauth2:
        clientId:
          secret:
            name: prometheus-oauth2-client
            key: client-id
        clientSecret:
          name: prometheus-oauth2-client
          key: client-secret
        tokenUrl: "https://sso.example.com/oauth/token"
        scopes:
          - metrics:read
        endpointParams:
          audience: "metrics-api"
```

## PodMonitor CRD

The `PodMonitor` scrapes Pods directly without requiring a Service, which is useful for Jobs, DaemonSets, or workloads where a Service is not warranted.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: batch-job-monitor
  namespace: data-processing
  labels:
    team: data-engineering
spec:
  selector:
    matchLabels:
      monitoring: prometheus
  podMetricsEndpoints:
    - port: metrics
      interval: 60s
      relabelings:
        - sourceLabels: [__meta_kubernetes_pod_label_job_name]
          targetLabel: job_name
        - sourceLabels: [__meta_kubernetes_pod_annotation_prometheus_io_job]
          targetLabel: job
          regex: (.+)
          action: replace
  namespaceSelector:
    matchNames:
      - data-processing
      - ml-workloads
```

### PodMonitor for DaemonSet Node Exporters

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: custom-node-exporter
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: custom-node-exporter
  podMetricsEndpoints:
    - port: metrics
      interval: 15s
      relabelings:
        - sourceLabels: [__meta_kubernetes_pod_node_name]
          targetLabel: node
        - action: labelmap
          regex: __meta_kubernetes_pod_label_(.+)
  namespaceSelector:
    any: true
```

## PrometheusRule Management

`PrometheusRule` objects define alerting and recording rules that Prometheus evaluates continuously. The operator watches for these CRDs and injects them into the Prometheus configuration via ConfigMap.

### Recording Rules for Performance

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: api-gateway-recording-rules
  namespace: production
  labels:
    team: platform
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
    - name: api_gateway.recording
      interval: 30s
      rules:
        - record: job:api_request_duration_seconds:p99
          expr: |
            histogram_quantile(0.99,
              sum by (job, le) (
                rate(api_request_duration_seconds_bucket[5m])
              )
            )
        - record: job:api_request_duration_seconds:p95
          expr: |
            histogram_quantile(0.95,
              sum by (job, le) (
                rate(api_request_duration_seconds_bucket[5m])
              )
            )
        - record: job:api_requests_total:rate5m
          expr: |
            sum by (job, method, status_code) (
              rate(api_requests_total[5m])
            )
        - record: job:api_error_rate:rate5m
          expr: |
            sum by (job) (rate(api_requests_total{status_code=~"5.."}[5m]))
            /
            sum by (job) (rate(api_requests_total[5m]))
```

### Alerting Rules with Severity Tiers

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: api-gateway-alerts
  namespace: production
  labels:
    team: platform
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
    - name: api_gateway.alerts
      rules:
        - alert: APIGatewayHighErrorRate
          expr: |
            job:api_error_rate:rate5m > 0.05
          for: 5m
          labels:
            severity: critical
            team: platform
            runbook: "https://runbooks.example.com/api-gateway/high-error-rate"
          annotations:
            summary: "API Gateway error rate exceeds 5%"
            description: |
              API Gateway error rate is {{ $value | humanizePercentage }} over the last 5 minutes.
              Job: {{ $labels.job }}
            dashboard: "https://grafana.example.com/d/api-gateway"

        - alert: APIGatewayHighLatencyP99
          expr: |
            job:api_request_duration_seconds:p99 > 2.0
          for: 10m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "API Gateway P99 latency exceeds 2 seconds"
            description: "P99 latency is {{ $value }}s for job {{ $labels.job }}"

        - alert: APIGatewayDown
          expr: |
            absent(up{job="api-gateway"} == 1)
          for: 1m
          labels:
            severity: critical
            pagerduty: "true"
          annotations:
            summary: "API Gateway is not reachable by Prometheus"

        - alert: PrometheusTargetMissing
          expr: |
            up == 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Prometheus target is down"
            description: |
              Prometheus target {{ $labels.instance }} in namespace {{ $labels.namespace }}
              has been unreachable for 5 minutes.

    - name: kubernetes.node.alerts
      rules:
        - alert: NodeMemoryPressure
          expr: |
            (
              node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes
            ) < 0.10
          for: 5m
          labels:
            severity: warning
            team: infra
          annotations:
            summary: "Node {{ $labels.instance }} memory available below 10%"
            description: "Available memory: {{ $value | humanizePercentage }}"

        - alert: NodeDiskSpaceCritical
          expr: |
            (
              node_filesystem_avail_bytes{fstype!="tmpfs",mountpoint="/"}
              / node_filesystem_size_bytes{fstype!="tmpfs",mountpoint="/"}
            ) < 0.10
          for: 10m
          labels:
            severity: critical
          annotations:
            summary: "Node {{ $labels.instance }} root filesystem under 10% free"
```

## AlertmanagerConfig for Namespace-Scoped Routing

The `AlertmanagerConfig` CRD enables application teams to define their own routing and receivers without requiring access to the global Alertmanager configuration. The operator merges namespace-scoped configs into the global Alertmanager configuration using a sub-route tree.

```yaml
apiVersion: monitoring.coreos.com/v1alpha1
kind: AlertmanagerConfig
metadata:
  name: platform-team-alerts
  namespace: production
  labels:
    alertmanagerConfig: platform
spec:
  route:
    receiver: platform-pagerduty
    groupBy: ["alertname", "job", "severity"]
    groupWait: 30s
    groupInterval: 5m
    repeatInterval: 4h
    matchers:
      - name: team
        value: platform
    routes:
      - receiver: platform-slack-critical
        matchers:
          - name: severity
            value: critical
        groupWait: 0s
        repeatInterval: 1h
      - receiver: platform-slack-warning
        matchers:
          - name: severity
            value: warning
        repeatInterval: 8h

  receivers:
    - name: platform-pagerduty
      pagerdutyConfigs:
        - routingKey:
            name: pagerduty-integration-key
            key: routing-key
          severity: "{{ .CommonLabels.severity }}"
          description: |
            {{ .CommonAnnotations.summary }}
            Runbook: {{ .CommonAnnotations.runbook }}
          links:
            - href: "{{ .CommonAnnotations.dashboard }}"
              text: "Dashboard"

    - name: platform-slack-critical
      slackConfigs:
        - apiURL:
            name: slack-webhook-secret
            key: webhook-url
          channel: "#alerts-critical"
          sendResolved: true
          title: |
            [{{ .Status | toUpper }}{{ if eq .Status "firing" }}:{{ .Alerts.Firing | len }}{{ end }}]
            {{ .CommonAnnotations.summary }}
          text: |
            *Description:* {{ .CommonAnnotations.description }}
            *Severity:* {{ .CommonLabels.severity }}
            *Runbook:* {{ .CommonAnnotations.runbook }}

    - name: platform-slack-warning
      slackConfigs:
        - apiURL:
            name: slack-webhook-secret
            key: webhook-url
          channel: "#alerts-warning"
          sendResolved: true

  inhibitRules:
    - sourceMatchers:
        - name: severity
          value: critical
      targetMatchers:
        - name: severity
          value: warning
      equal: ["alertname", "job"]
```

### Creating the Webhook Secret

```bash
kubectl create secret generic slack-webhook-secret \
  --namespace production \
  --from-literal=webhook-url='https://hooks.slack.com/services/<WORKSPACE_ID>/<CHANNEL_ID>/<WEBHOOK_TOKEN>'
```

## TLS Configuration for Prometheus

### Configuring Prometheus to Serve HTTPS

The operator supports configuring Prometheus itself with TLS for secure metrics endpoints:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus-production
  namespace: monitoring
spec:
  replicas: 2
  version: v2.50.1
  serviceAccountName: prometheus
  web:
    tlsConfig:
      cert:
        secret:
          name: prometheus-tls
          key: tls.crt
      keySecret:
        name: prometheus-tls
        key: tls.key
      clientCA:
        secret:
          name: prometheus-client-ca
          key: ca.crt
      clientAuthType: RequireAndVerifyClientCert
  # Mount TLS secrets for use in scraping
  secrets:
    - prometheus-tls
    - prometheus-client-ca
    - mtls-client
    - mtls-ca
  storage:
    volumeClaimTemplate:
      spec:
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 100Gi
  podMonitorSelector: {}
  serviceMonitorSelector: {}
  ruleSelector: {}
```

### Generating TLS Certificates with cert-manager

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: prometheus-tls
  namespace: monitoring
spec:
  secretName: prometheus-tls
  duration: 8760h  # 1 year
  renewBefore: 720h  # 30 days
  commonName: prometheus.monitoring.svc.cluster.local
  subject:
    organizations:
      - example-corp
  dnsNames:
    - prometheus.monitoring.svc.cluster.local
    - prometheus.monitoring.svc
    - prometheus-operated.monitoring.svc.cluster.local
  issuerRef:
    name: internal-ca-issuer
    kind: ClusterIssuer
    group: cert-manager.io
```

## RBAC-Scoped Monitoring

Enterprise environments commonly require that individual teams manage their own monitoring configuration without access to other teams' namespaces. The operator supports this through label selectors on the `Prometheus` CRD.

### Per-Team Prometheus Instance

```yaml
# Prometheus instance for the payments team
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus-payments
  namespace: monitoring-payments
spec:
  replicas: 2
  serviceAccountName: prometheus-payments
  serviceMonitorSelector:
    matchLabels:
      team: payments
  serviceMonitorNamespaceSelector:
    matchLabels:
      team: payments
  podMonitorSelector:
    matchLabels:
      team: payments
  ruleSelector:
    matchLabels:
      team: payments
  ruleNamespaceSelector:
    matchLabels:
      team: payments
  storage:
    volumeClaimTemplate:
      spec:
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 50Gi
  resources:
    requests:
      cpu: 500m
      memory: 2Gi
    limits:
      cpu: 2000m
      memory: 4Gi
```

### RBAC for Application Teams

```yaml
# ClusterRole allowing teams to manage their monitoring CRDs
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: monitoring-crd-manager
rules:
  - apiGroups: ["monitoring.coreos.com"]
    resources:
      - servicemonitors
      - podmonitors
      - prometheusrules
      - alertmanagerconfigs
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
---
# Bind to a team's service account in their namespace
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: payments-team-monitoring
  namespace: payments
subjects:
  - kind: ServiceAccount
    name: payments-ci-deployer
    namespace: payments
roleRef:
  kind: ClusterRole
  name: monitoring-crd-manager
  apiGroup: rbac.authorization.k8s.io
---
# ServiceAccount and ClusterRole for Prometheus to scrape across namespaces
apiVersion: v1
kind: ServiceAccount
metadata:
  name: prometheus-payments
  namespace: monitoring-payments
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: prometheus-payments
rules:
  - apiGroups: [""]
    resources:
      - nodes
      - nodes/metrics
      - services
      - endpoints
      - pods
    verbs: ["get", "list", "watch"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["ingresses"]
    verbs: ["get", "list", "watch"]
  - nonResourceURLs: ["/metrics", "/metrics/cadvisor"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: prometheus-payments
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: prometheus-payments
subjects:
  - kind: ServiceAccount
    name: prometheus-payments
    namespace: monitoring-payments
```

## Multi-Cluster Monitoring Architecture

### Thanos Sidecar Integration

For long-term storage and global query views across clusters, the operator integrates with Thanos via the sidecar pattern:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus-production
  namespace: monitoring
spec:
  replicas: 2
  version: v2.50.1
  serviceAccountName: prometheus
  thanos:
    image: quay.io/thanos/thanos:v0.35.0
    version: v0.35.0
    objectStorageConfig:
      key: objstore.yml
      name: thanos-objstore-config
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        cpu: 500m
        memory: 512Mi
    grpcServerTlsConfig:
      cert:
        secret:
          name: thanos-sidecar-tls
          key: tls.crt
      keySecret:
        name: thanos-sidecar-tls
        key: tls.key
      caSecret:
        name: thanos-ca
        key: ca.crt
  externalLabels:
    cluster: prod-us-east-1
    region: us-east-1
    environment: production
```

### Object Store Configuration for Thanos

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: thanos-objstore-config
  namespace: monitoring
stringData:
  objstore.yml: |
    type: S3
    config:
      bucket: thanos-metrics-prod
      endpoint: s3.us-east-1.amazonaws.com
      region: us-east-1
      sse_config:
        type: SSE-S3
```

### Cross-Cluster Federation with Prometheus Operator

For environments where Thanos is not feasible, federation rules allow a global Prometheus to scrape aggregated metrics from cluster-level Prometheus instances:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: federation-monitor
  namespace: monitoring-global
spec:
  endpoints:
    - path: /federate
      params:
        match[]:
          - '{job="api-gateway"}'
          - '{job="node-exporter"}'
          - '{__name__=~"job:.*"}'
      interval: 30s
      honorLabels: true
      port: web
  selector:
    matchLabels:
      app: prometheus
      federation-target: "true"
  namespaceSelector:
    any: true
```

## Performance Tuning at Scale

### Prometheus Sharding

For large environments with thousands of scrape targets, the operator supports horizontal sharding:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus-sharded
  namespace: monitoring
spec:
  shards: 3
  replicas: 2  # Per shard
  version: v2.50.1
  serviceAccountName: prometheus
  # Each shard scrapes 1/N of targets using modulo hashing
  serviceMonitorSelector: {}
  storageSpec:
    volumeClaimTemplate:
      spec:
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 100Gi
```

### Operator Resource Tuning

```yaml
prometheusOperator:
  resources:
    requests:
      cpu: 500m
      memory: 512Mi
    limits:
      cpu: 2000m
      memory: 1Gi
  # Increase workers for large numbers of CRDs
  prometheusConfigReloader:
    resources:
      requests:
        cpu: 100m
        memory: 50Mi
      limits:
        cpu: 200m
        memory: 100Mi
```

## Scrape Configuration Tuning

### Global Prometheus Spec for High-Cardinality Environments

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus-production
  namespace: monitoring
spec:
  version: v2.50.1
  replicas: 2
  serviceAccountName: prometheus
  # Tune scrape behavior globally
  scrapeInterval: 30s
  scrapeTimeout: 10s
  evaluationInterval: 30s
  # Limit samples per scrape to prevent memory spikes
  enforcedSampleLimit: 100000
  enforcedTargetLimit: 2000
  enforcedLabelLimit: 64
  enforcedLabelNameLengthLimit: 200
  enforcedLabelValueLengthLimit: 2000
  # Query configuration
  query:
    maxConcurrency: 20
    maxSamples: 50000000
    timeout: 2m
  # TSDB configuration
  tsdb:
    outOfOrderTimeWindow: 5m
  resources:
    requests:
      cpu: 2000m
      memory: 8Gi
    limits:
      cpu: 4000m
      memory: 16Gi
```

## Debugging and Troubleshooting

### Checking Operator Logs

```bash
# View operator logs
kubectl logs -n monitoring deployment/kube-prometheus-stack-operator -f

# Check for reconciliation errors
kubectl logs -n monitoring deployment/kube-prometheus-stack-operator \
  | grep -E "error|Error|failed|Failed"
```

### Validating ServiceMonitor Discovery

```bash
# Check which ServiceMonitors are being discovered by Prometheus
kubectl get prometheus -n monitoring prometheus-production -o jsonpath='{.status}'

# Verify targets in Prometheus UI via port-forward
kubectl port-forward -n monitoring svc/kube-prometheus-stack-prometheus 9090:9090

# List all ServiceMonitors
kubectl get servicemonitor -A --show-labels

# Check if a specific ServiceMonitor is selecting the right Services
kubectl get endpoints -n production -l app=api-gateway
```

### Debugging Missing Scrape Targets

```bash
# Check the generated Prometheus configuration
kubectl get secret -n monitoring prometheus-kube-prometheus-stack-prometheus \
  -o jsonpath='{.data.prometheus\.yaml\.gz}' \
  | base64 -d \
  | gunzip \
  | grep -A 20 "api-gateway"

# Watch for PrometheusRule evaluation errors
kubectl logs -n monitoring \
  $(kubectl get pod -n monitoring -l prometheus=kube-prometheus-stack-prometheus \
    -o jsonpath='{.items[0].metadata.name}') \
  --container prometheus \
  | grep "err" | tail -50
```

### Common Issues and Resolutions

**ServiceMonitor not being picked up:**

```bash
# Verify the Prometheus CRD's selector matches the ServiceMonitor labels
kubectl get prometheus -n monitoring prometheus-production \
  -o jsonpath='{.spec.serviceMonitorSelector}'

# Ensure ServiceMonitor namespace is covered
kubectl get prometheus -n monitoring prometheus-production \
  -o jsonpath='{.spec.serviceMonitorNamespaceSelector}'

# Check that the Service has the port name matching the ServiceMonitor
kubectl get svc -n production api-gateway \
  -o jsonpath='{.spec.ports[*].name}'
```

**PrometheusRule not loading:**

```bash
# Verify rule syntax before applying
promtool check rules rules.yaml

# Check the operator processed the rule
kubectl describe prometheusrule -n production api-gateway-alerts

# Look for rule evaluation errors in Prometheus
curl -s localhost:9090/api/v1/rules | jq '.data.groups[].rules[] | select(.type=="alerting") | .name'
```

## Upgrade and Maintenance Procedures

### Upgrading the Operator

```bash
# Backup CRDs before upgrade
kubectl get crd -o yaml \
  | grep -E "monitoring.coreos.com" \
  > monitoring-crds-backup.yaml

# Upgrade via Helm with CRD update
helm upgrade kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --version 59.0.0 \
  --values values-production.yaml \
  --set crds.enabled=true

# Verify operator pods are running after upgrade
kubectl rollout status deployment/kube-prometheus-stack-operator -n monitoring
kubectl rollout status statefulset/prometheus-kube-prometheus-stack-prometheus -n monitoring
```

### Backup and Restore

```bash
# Export all monitoring CRDs from a namespace
for crd in servicemonitor podmonitor prometheusrule alertmanagerconfig; do
  kubectl get ${crd} -A -o yaml > backup-${crd}.yaml
done

# Restore CRDs in a new cluster
kubectl apply -f backup-servicemonitor.yaml
kubectl apply -f backup-podmonitor.yaml
kubectl apply -f backup-prometheusrule.yaml
kubectl apply -f backup-alertmanagerconfig.yaml
```

## Summary

The Prometheus Operator provides a declarative, Kubernetes-native approach to monitoring configuration management. By leveraging `ServiceMonitor`, `PodMonitor`, and `PrometheusRule` CRDs, teams can own their monitoring configuration as code, apply fine-grained RBAC controls, and scale monitoring infrastructure horizontally through sharding. The `AlertmanagerConfig` CRD decentralizes alert routing without sacrificing security boundaries. For multi-cluster environments, Thanos sidecar integration through the operator enables long-term storage and global query capabilities with minimal operational overhead.
