---
title: "Grafana Enterprise Dashboards: Production Patterns, Variables, and GitOps Management"
date: 2027-06-06T00:00:00-05:00
draft: false
tags: ["Grafana", "Monitoring", "Dashboards", "Observability", "GitOps", "Prometheus"]
categories: ["Monitoring", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to Grafana dashboard management covering dashboard-as-code with Grafonnet/Jsonnet, Grafana Operator, template variables, GitOps workflows, Loki log correlation, exemplar trace linking, and production operations patterns."
more_link: "yes"
url: "/grafana-enterprise-dashboards-guide/"
---

Grafana is the de facto visualization layer for modern observability stacks. Most teams start with Grafana by clicking through the UI to build dashboards, importing community dashboards from grafana.com, and calling it done. This approach works at small scale but breaks down in enterprise environments where dozens of teams, hundreds of dashboards, multiple Grafana instances, and strict change management requirements are the norm.

Production Grafana management requires treating dashboards as code: version-controlled, reviewed, tested, and deployed through CI/CD pipelines. This guide covers the full enterprise Grafana management lifecycle from dashboard-as-code patterns to multi-cluster deployment, advanced variable configuration, and observability signal correlation.

<!--more-->

## Dashboard-as-Code with Grafonnet and Jsonnet

Grafana dashboards are stored as JSON. Managing raw JSON in Git is painful: diffs are unreadable, duplication is rampant, and sharing panels between dashboards requires copy-paste. Grafonnet solves this by providing a Jsonnet library for generating Grafana dashboard JSON.

### Why Jsonnet for Dashboards

Jsonnet is a data templating language that extends JSON with:

- **Functions** - reusable panel definitions
- **Imports** - library files shared across dashboards
- **Variables** - parameterize queries, titles, and layout
- **Inheritance** - extend base templates
- **Error checking** - catch typos before deploying

### Setting Up Grafonnet

```bash
# Install jsonnet and jsonnet-bundler
go install github.com/google/go-jsonnet/cmd/jsonnet@latest
go install github.com/jsonnet-bundler/jsonnet-bundler/cmd/jb@latest

# Initialize a new dashboard project
mkdir grafana-dashboards
cd grafana-dashboards
jb init

# Add Grafonnet library
jb install github.com/grafana/grafonnet/gen/grafonnet-latest@main
```

Directory structure:

```
grafana-dashboards/
├── jsonnetfile.json
├── jsonnetfile.lock.json
├── vendor/              # Grafonnet library (gitignored or committed)
├── lib/
│   ├── panels.libsonnet  # Reusable panel definitions
│   └── vars.libsonnet    # Variable templates
├── dashboards/
│   ├── kubernetes-overview.jsonnet
│   ├── service-health.jsonnet
│   └── slo-dashboard.jsonnet
└── Makefile
```

### Example Dashboard with Grafonnet

```jsonnet
// dashboards/service-health.jsonnet
local g = import 'github.com/grafana/grafonnet/gen/grafonnet-latest/main.libsonnet';
local panels = import '../lib/panels.libsonnet';

// Dashboard metadata
local dashboard = g.dashboard;
local ts = g.panel.timeSeries;
local stat = g.panel.stat;
local row = g.panel.row;

// Dashboard variables
local dsVar = g.dashboard.variable.datasource.new('datasource', 'prometheus')
  + g.dashboard.variable.datasource.generalOptions.withLabel('Data Source');

local clusterVar = g.dashboard.variable.query.new('cluster')
  + g.dashboard.variable.query.withDatasourceFromVariable(dsVar)
  + g.dashboard.variable.query.queryTypes.withLabelValues('cluster', 'up')
  + g.dashboard.variable.query.generalOptions.withLabel('Cluster')
  + g.dashboard.variable.query.selectionOptions.withMulti(false);

local namespaceVar = g.dashboard.variable.query.new('namespace')
  + g.dashboard.variable.query.withDatasourceFromVariable(dsVar)
  + g.dashboard.variable.query.queryTypes.withLabelValues(
      'namespace',
      'kube_namespace_status_phase{cluster="$cluster", phase="Active"}'
    )
  + g.dashboard.variable.query.generalOptions.withLabel('Namespace')
  + g.dashboard.variable.query.selectionOptions.withIncludeAll(true)
  + g.dashboard.variable.query.selectionOptions.withMulti(true);

// Request rate panel
local requestRatePanel =
  ts.new('Request Rate')
  + ts.queryOptions.withDatasource('prometheus', '$datasource')
  + ts.queryOptions.withTargets([
      g.query.prometheus.new(
        '$datasource',
        'sum by (service) (service:http_requests_total:rate5m{cluster="$cluster", namespace=~"$namespace"})'
      )
      + g.query.prometheus.withLegendFormat('{{ service }}'),
    ])
  + ts.standardOptions.withUnit('reqps')
  + ts.gridPos.withW(12)
  + ts.gridPos.withH(8);

// P99 latency panel
local latencyPanel =
  ts.new('P99 Latency')
  + ts.queryOptions.withDatasource('prometheus', '$datasource')
  + ts.queryOptions.withTargets([
      g.query.prometheus.new(
        '$datasource',
        'service:http_request_duration_p99:rate5m{cluster="$cluster", namespace=~"$namespace"}'
      )
      + g.query.prometheus.withLegendFormat('{{ service }}'),
    ])
  + ts.standardOptions.withUnit('s')
  + ts.gridPos.withW(12)
  + ts.gridPos.withH(8);

// Error rate stat panel
local errorRateStat =
  stat.new('Error Rate')
  + stat.queryOptions.withDatasource('prometheus', '$datasource')
  + stat.queryOptions.withTargets([
      g.query.prometheus.new(
        '$datasource',
        'avg(service:http_error_ratio:rate5m{cluster="$cluster", namespace=~"$namespace"}) * 100'
      ),
    ])
  + stat.standardOptions.withUnit('percent')
  + stat.options.withColorMode('background')
  + stat.standardOptions.thresholds.withSteps([
      { value: null, color: 'green' },
      { value: 1, color: 'yellow' },
      { value: 5, color: 'red' },
    ])
  + stat.gridPos.withW(4)
  + stat.gridPos.withH(4);

// Assemble the dashboard
dashboard.new('Service Health Overview')
+ dashboard.withUid('service-health-overview')
+ dashboard.withDescription('Service request rates, latency, and error rates')
+ dashboard.withTags(['services', 'slo', 'platform'])
+ dashboard.withRefresh('30s')
+ dashboard.time.withFrom('now-1h')
+ dashboard.time.withTo('now')
+ dashboard.withVariables([dsVar, clusterVar, namespaceVar])
+ dashboard.withPanels([
    row.new('Service Metrics') + row.gridPos.withY(0),
    errorRateStat + ts.gridPos.withX(0) + ts.gridPos.withY(1),
    requestRatePanel + ts.gridPos.withX(0) + ts.gridPos.withY(5),
    latencyPanel + ts.gridPos.withX(12) + ts.gridPos.withY(5),
  ])
```

### Building Dashboards

```makefile
# Makefile
JSONNET_ARGS = -J vendor
DASHBOARDS_DIR = dashboards
OUTPUT_DIR = dist

.PHONY: build clean deploy

build:
	@mkdir -p $(OUTPUT_DIR)
	@for f in $(DASHBOARDS_DIR)/*.jsonnet; do \
		name=$$(basename $$f .jsonnet); \
		echo "Building $$name..."; \
		jsonnet $(JSONNET_ARGS) $$f > $(OUTPUT_DIR)/$$name.json; \
	done

validate:
	@for f in $(OUTPUT_DIR)/*.json; do \
		python3 -c "import json,sys; json.load(open('$$f'))" && echo "$$f: OK"; \
	done

deploy: build
	@for f in $(OUTPUT_DIR)/*.json; do \
		name=$$(basename $$f .json); \
		echo "Deploying $$name..."; \
		curl -sf -XPOST \
			-H "Content-Type: application/json" \
			-H "Authorization: Bearer $(GRAFANA_API_KEY)" \
			-d "{\"dashboard\": $$(cat $$f), \"overwrite\": true, \"folderId\": $(FOLDER_ID)}" \
			$(GRAFANA_URL)/api/dashboards/db; \
	done
```

## Grafana Operator for Kubernetes

The Grafana Operator allows declaring Grafana instances, data sources, and dashboards as Kubernetes custom resources. This enables full GitOps management of Grafana through tools like ArgoCD or Flux.

### Installing the Grafana Operator

```bash
# Install via Helm
helm repo add grafana-operator https://grafana.github.io/helm-charts
helm repo update

helm install grafana-operator grafana-operator/grafana-operator \
  --namespace monitoring \
  --set image.tag=v5.7.0
```

### Grafana Instance CRD

```yaml
apiVersion: grafana.integreatly.org/v1beta1
kind: Grafana
metadata:
  name: grafana
  namespace: monitoring
spec:
  config:
    log:
      mode: "console"
    auth:
      disable_login_form: "false"
    server:
      domain: "grafana.company.com"
      root_url: "https://grafana.company.com"
    auth.ldap:
      enabled: "true"
      config_file: "/etc/grafana/ldap.toml"
    security:
      admin_user: admin
      admin_password: "${GRAFANA_ADMIN_PASSWORD}"
    database:
      type: postgres
      host: "grafana-db:5432"
      name: grafana
      user: grafana
      password: "${GRAFANA_DB_PASSWORD}"
  deployment:
    spec:
      template:
        spec:
          containers:
            - name: grafana
              resources:
                requests:
                  cpu: 250m
                  memory: 512Mi
                limits:
                  cpu: 1000m
                  memory: 2Gi
              envFrom:
                - secretRef:
                    name: grafana-secrets
  ingress:
    spec:
      ingressClassName: nginx
      rules:
        - host: grafana.company.com
          http:
            paths:
              - path: /
                pathType: Prefix
                backend:
                  service:
                    name: grafana-service
                    port:
                      number: 3000
      tls:
        - hosts:
            - grafana.company.com
          secretName: grafana-tls
```

### GrafanaDataSource CRD

```yaml
apiVersion: grafana.integreatly.org/v1beta1
kind: GrafanaDataSource
metadata:
  name: prometheus-datasource
  namespace: monitoring
spec:
  instanceSelector:
    matchLabels:
      dashboards: "grafana"
  datasource:
    name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus-operated:9090
    isDefault: true
    jsonData:
      timeInterval: "15s"
      queryTimeout: "60s"
      httpMethod: "POST"
      manageAlerts: false
      prometheusType: Prometheus
      prometheusVersion: "2.47.0"
---
apiVersion: grafana.integreatly.org/v1beta1
kind: GrafanaDataSource
metadata:
  name: loki-datasource
  namespace: monitoring
spec:
  instanceSelector:
    matchLabels:
      dashboards: "grafana"
  datasource:
    name: Loki
    type: loki
    access: proxy
    url: http://loki-gateway:80
    jsonData:
      maxLines: 5000
      derivedFields:
        - datasourceUid: tempo
          matcherRegex: 'traceId=(\w+)'
          name: TraceID
          url: '$${__value.raw}'
---
apiVersion: grafana.integreatly.org/v1beta1
kind: GrafanaDataSource
metadata:
  name: tempo-datasource
  namespace: monitoring
spec:
  instanceSelector:
    matchLabels:
      dashboards: "grafana"
  datasource:
    name: Tempo
    type: tempo
    access: proxy
    url: http://tempo:3100
    uid: tempo
    jsonData:
      tracesToLogsV2:
        datasourceUid: loki
        filterByTraceID: true
        filterBySpanID: true
```

### GrafanaDashboard CRD

The Grafana Operator can deploy dashboards directly from ConfigMaps, URLs, or inline JSON:

```yaml
apiVersion: grafana.integreatly.org/v1beta1
kind: GrafanaDashboard
metadata:
  name: service-health
  namespace: monitoring
  labels:
    app: grafana
spec:
  instanceSelector:
    matchLabels:
      dashboards: "grafana"
  folder: "Platform"
  # Reference a ConfigMap containing the dashboard JSON
  configMapRef:
    name: service-health-dashboard
    key: dashboard.json
  # OR use an inline JSON definition
  # json: |
  #   { ... dashboard json ... }
  # OR reference a Grafana.com dashboard
  # grafanaCom:
  #   id: 315
  #   revision: 3
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: service-health-dashboard
  namespace: monitoring
data:
  dashboard.json: |
    {
      "uid": "service-health-overview",
      "title": "Service Health Overview",
      ...
    }
```

## Dashboard Variables

Template variables are the most powerful feature for building reusable dashboards. They transform a static dashboard into one that works across all clusters, namespaces, and services.

### Variable Types

**Query Variables**

Query variables dynamically populate their values from a data source query:

```json
{
  "name": "namespace",
  "type": "query",
  "datasource": { "type": "prometheus", "uid": "$datasource" },
  "query": {
    "query": "label_values(kube_namespace_status_phase{cluster=\"$cluster\", phase=\"Active\"}, namespace)",
    "refId": "StandardVariableQuery"
  },
  "refresh": 2,
  "multi": true,
  "includeAll": true,
  "allValue": ".*",
  "sort": 1
}
```

**Custom Variables**

Custom variables have a static list of values:

```json
{
  "name": "interval",
  "type": "custom",
  "query": "1m,5m,15m,30m,1h,6h,12h,1d",
  "current": { "value": "5m", "text": "5m" },
  "options": [
    { "value": "1m", "text": "1m" },
    { "value": "5m", "text": "5m", "selected": true },
    { "value": "15m", "text": "15m" }
  ]
}
```

**Textbox Variables**

Free-form text input for filtering:

```json
{
  "name": "pod_filter",
  "type": "textbox",
  "label": "Pod Name Filter",
  "query": ".*"
}
```

**Constant Variables**

Hard-coded values useful for parameterizing base URLs:

```json
{
  "name": "grafana_url",
  "type": "constant",
  "hide": 2,
  "query": "https://grafana.company.com"
}
```

### Template Variable Chaining

Variables can reference other variables to create cascading filters:

```
datasource -> cluster -> namespace -> service -> pod
```

Each variable's query depends on the value of the previous variable:

```
datasource: (first variable - no dependency)
cluster: label_values(up{job="kube-apiserver"}, cluster)
namespace: label_values(kube_namespace_status_phase{cluster="$cluster"}, namespace)
service: label_values(kube_service_info{cluster="$cluster", namespace="$namespace"}, service)
pod: label_values(kube_pod_info{cluster="$cluster", namespace="$namespace", created_by_name=~"$service.*"}, pod)
```

When the cluster variable changes, all downstream variables automatically refresh and filter their options.

### Interval Variables for Rate Windows

Using a variable for the rate window makes dashboards flexible:

```promql
# In your panel query, use the $interval variable
rate(http_requests_total{service="$service"}[$interval])
```

The `$__interval` automatic variable adjusts the rate window based on the panel's time range, which is often more useful than a static interval.

### Repeat Panels and Rows

Grafana can repeat panels or rows for each value of a multi-value variable:

```json
{
  "type": "timeseries",
  "title": "Requests: $service",
  "repeat": "service",
  "repeatDirection": "h",
  "maxPerRow": 3
}
```

This creates one copy of the panel per selected service, arranged in a 3-column grid. Combined with the `service` variable set to `All`, this automatically creates per-service panels for every service in the namespace.

For rows:

```json
{
  "type": "row",
  "title": "$cluster",
  "repeat": "cluster"
}
```

This creates one row section per cluster, useful for multi-cluster dashboards.

## Time Series vs Stat Panels: Best Practices

Choosing the right panel type is fundamental to dashboard readability.

### Time Series Panels

Use for: trends over time, spotting patterns, correlating events

```json
{
  "type": "timeseries",
  "fieldConfig": {
    "defaults": {
      "custom": {
        "lineInterpolation": "linear",
        "fillOpacity": 10,
        "gradientMode": "none",
        "showPoints": "never",
        "spanNulls": false
      },
      "unit": "reqps",
      "thresholds": {
        "mode": "absolute",
        "steps": [
          { "value": null, "color": "green" },
          { "value": 1000, "color": "yellow" },
          { "value": 5000, "color": "red" }
        ]
      }
    }
  },
  "options": {
    "legend": {
      "displayMode": "table",
      "placement": "bottom",
      "calcs": ["mean", "max", "lastNotNull"]
    },
    "tooltip": { "mode": "multi", "sort": "desc" }
  }
}
```

**Best practices:**
- Use `spanNulls: false` to show gaps in data rather than connecting across them
- Enable the legend table with `mean`, `max`, and `lastNotNull` calculators
- Use `tooltip.mode: "multi"` to compare all series at a timestamp
- Set `fillOpacity` to 5-20 for visual depth without obscuring individual lines

### Stat Panels

Use for: current values, SLO status, single-number KPIs

```json
{
  "type": "stat",
  "options": {
    "colorMode": "background",
    "graphMode": "area",
    "justifyMode": "center",
    "orientation": "auto",
    "reduceOptions": {
      "calcs": ["lastNotNull"],
      "fields": "",
      "values": false
    }
  },
  "fieldConfig": {
    "defaults": {
      "unit": "percent",
      "min": 0,
      "max": 100,
      "thresholds": {
        "mode": "absolute",
        "steps": [
          { "value": null, "color": "red" },
          { "value": 95, "color": "yellow" },
          { "value": 99, "color": "green" }
        ]
      }
    }
  }
}
```

**Best practices:**
- Use `colorMode: "background"` for high-visibility status indication
- Set meaningful thresholds with semantic colors (red = bad, green = good)
- Use `graphMode: "area"` to show trend context alongside the current value
- Use `lastNotNull` not `last` to avoid showing null/empty values

### Gauge vs Bar Gauge

Gauges are useful for utilization metrics with clear min/max bounds:

```json
{
  "type": "gauge",
  "fieldConfig": {
    "defaults": {
      "unit": "percentunit",
      "min": 0,
      "max": 1,
      "thresholds": {
        "mode": "absolute",
        "steps": [
          { "value": null, "color": "green" },
          { "value": 0.7, "color": "yellow" },
          { "value": 0.9, "color": "red" }
        ]
      }
    }
  },
  "options": {
    "reduceOptions": { "calcs": ["lastNotNull"] },
    "showThresholdLabels": true,
    "showThresholdMarkers": true
  }
}
```

Use bar gauges when comparing multiple values simultaneously (CPU usage across all nodes).

## Grafana Alerting vs Prometheus Alertmanager

Grafana supports its own alerting system in addition to routing Prometheus Alertmanager alerts. Understanding when to use each is important.

### Grafana Unified Alerting

Grafana's unified alerting evaluates alert rules directly against any data source (not just Prometheus). This is valuable when:

- Alerting on Loki log patterns
- Alerting on Elasticsearch or other non-Prometheus sources
- Business-level alerts that combine multiple data sources

```yaml
# Grafana alert rule (defined via API or UI)
{
  "title": "High Error Rate",
  "condition": "C",
  "data": [
    {
      "refId": "A",
      "queryType": "",
      "relativeTimeRange": { "from": 600, "to": 0 },
      "datasourceUid": "prometheus-uid",
      "model": {
        "expr": "service:http_error_ratio:rate5m > 0.05",
        "refId": "A"
      }
    },
    {
      "refId": "C",
      "queryType": "",
      "relativeTimeRange": { "from": 0, "to": 0 },
      "datasourceUid": "-100",
      "model": {
        "conditions": [{
          "evaluator": { "type": "gt", "params": [0] },
          "operator": { "type": "and" },
          "query": { "params": ["A"] },
          "reducer": { "type": "last" },
          "type": "query"
        }],
        "refId": "C",
        "type": "classic_conditions"
      }
    }
  ],
  "for": "5m",
  "labels": { "severity": "warning" },
  "annotations": {
    "summary": "Error rate exceeds 5%",
    "runbook_url": "https://runbooks.company.com/high-error-rate"
  }
}
```

### When to Use Prometheus Alertmanager Instead

For Prometheus-based metrics, keep alerting in Prometheus/Alertmanager:

- More mature routing and grouping features
- Native inhibition rules
- Better HA deduplication via gossip
- Prometheus Operator rule management

Use Grafana alerting as a supplement for non-Prometheus sources, not as a replacement for Alertmanager in Prometheus workflows.

## Loki Log Correlation

Grafana's split panel layout allows viewing metrics and logs side-by-side, with automatic log filtering based on the selected time range.

### Logs Panel Configuration

```json
{
  "type": "logs",
  "datasource": { "type": "loki", "uid": "$loki_datasource" },
  "targets": [
    {
      "expr": "{namespace=\"$namespace\", pod=~\"$service.*\"} |= \"$log_filter\"",
      "refId": "A"
    }
  ],
  "options": {
    "dedupStrategy": "none",
    "enableLogDetails": true,
    "prettifyLogMessage": false,
    "showLabels": false,
    "showTime": true,
    "sortOrder": "Descending",
    "wrapLogMessage": false
  }
}
```

### Explore Correlation Links

Configure metric panels to link to Loki log exploration:

```json
{
  "fieldConfig": {
    "defaults": {
      "links": [
        {
          "title": "View Logs",
          "url": "/explore?left={\"datasource\":\"loki\",\"queries\":[{\"expr\":\"{namespace=\\\"${__field.labels.namespace}\\\",pod=~\\\"${__field.labels.service}.*\\\"}\"}],\"range\":{\"from\":\"${__value.time}[30m\",\"to\":\"${__value.time}30m\"}}",
          "targetBlank": true
        }
      ]
    }
  }
}
```

### Derived Fields for Trace Linking

Loki derived fields extract values from log lines and link them to trace backends:

```yaml
# In Loki data source configuration
jsonData:
  derivedFields:
    # Extract traceId from structured JSON logs
    - name: TraceID
      matcherRegex: '"traceId":"(\w+)"'
      url: '${__value.raw}'
      datasourceUid: tempo
    # Extract span ID
    - name: SpanID
      matcherRegex: '"spanId":"(\w+)"'
      url: '${__value.raw}'
      datasourceUid: tempo
```

With derived fields configured, Grafana automatically detects trace IDs in log lines and renders them as clickable links to the trace backend.

## Exemplars for Trace Linking from Metrics

Prometheus exemplars embed trace IDs alongside metric samples. Grafana uses these to create direct links from a latency spike in a time series panel to the specific trace in Tempo.

### Enabling Exemplars in Prometheus

```yaml
# prometheus.yaml
global:
  scrape_interval: 15s
  # Enable exemplar storage
feature_flags:
  - exemplar-storage

storage:
  exemplars:
    max_exemplars: 100000
```

Application-side exemplar instrumentation (Go):

```go
// In your HTTP handler, add trace ID as exemplar
import (
    "github.com/prometheus/client_golang/prometheus"
    "go.opentelemetry.io/otel/trace"
)

var requestDuration = prometheus.NewHistogramVec(
    prometheus.HistogramOpts{
        Name:    "http_request_duration_seconds",
        Help:    "HTTP request duration with exemplars",
        Buckets: prometheus.DefBuckets,
    },
    []string{"method", "path", "status"},
)

func handler(w http.ResponseWriter, r *http.Request) {
    spanCtx := trace.SpanFromContext(r.Context()).SpanContext()
    timer := prometheus.NewTimer(
        requestDuration.With(prometheus.Labels{
            "method": r.Method,
            "path":   r.URL.Path,
            "status": "200",
        }).(prometheus.ExemplarObserver).ObserveWithExemplar(
            // Duration recorded in the Observe call below
        ),
    )
    // ... handler logic
    timer.ObserveWithExemplar(prometheus.Labels{
        "traceID": spanCtx.TraceID().String(),
    })
}
```

### Enabling Exemplar Display in Grafana

```json
{
  "type": "timeseries",
  "targets": [
    {
      "expr": "histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))",
      "exemplar": true,
      "refId": "A"
    }
  ]
}
```

Exemplars appear as diamond markers on the time series. Clicking one opens the associated trace in Tempo.

## Folder and Permission Management

Enterprise Grafana deployments require structured folder hierarchies and team-based access control.

### Folder Structure

```
Grafana
├── Platform Team
│   ├── Kubernetes Overview
│   ├── Node Resources
│   └── Cluster Capacity
├── Application Teams
│   ├── Frontend Service
│   ├── Backend API
│   └── Worker Jobs
├── Databases
│   ├── PostgreSQL
│   └── Redis
├── SLO Dashboards
│   └── Service SLOs
└── Shared
    └── Templates (hidden from non-admin)
```

### RBAC Configuration via API

```bash
# Create a folder
curl -sf -XPOST \
  -H "Authorization: Bearer $GRAFANA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title": "Platform Team", "uid": "platform-team"}' \
  http://grafana:3000/api/folders

# Set folder permissions
# team_id comes from /api/teams/search
curl -sf -XPOST \
  -H "Authorization: Bearer $GRAFANA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "items": [
      {
        "role": "Viewer",
        "permission": 1
      },
      {
        "teamId": 2,
        "permission": 2
      },
      {
        "userId": 5,
        "permission": 4
      }
    ]
  }' \
  "http://grafana:3000/api/folders/platform-team/permissions"
```

Permission levels: 1 = View, 2 = Edit, 4 = Admin

## LDAP and SSO Integration

### LDAP Configuration

```ini
# /etc/grafana/ldap.toml
[[servers]]
host = "ldap.company.com"
port = 636
use_ssl = true
start_tls = false
ssl_skip_verify = false
bind_dn = "cn=grafana,ou=serviceaccounts,dc=company,dc=com"
bind_password = "password"
search_filter = "(sAMAccountName=%s)"
search_base_dns = ["ou=users,dc=company,dc=com"]

[servers.attributes]
name = "givenName"
surname = "sn"
username = "sAMAccountName"
member_of = "memberOf"
email = "mail"

[[servers.group_mappings]]
group_dn = "cn=grafana-admins,ou=groups,dc=company,dc=com"
org_role = "Admin"

[[servers.group_mappings]]
group_dn = "cn=grafana-editors,ou=groups,dc=company,dc=com"
org_role = "Editor"

[[servers.group_mappings]]
group_dn = "*"
org_role = "Viewer"
```

### OAuth/SSO via Grafana INI

```ini
# /etc/grafana/grafana.ini
[auth.generic_oauth]
enabled = true
name = Company SSO
allow_sign_up = true
client_id = grafana
client_secret = ${OAUTH_CLIENT_SECRET}
scopes = openid profile email groups
auth_url = https://sso.company.com/auth
token_url = https://sso.company.com/token
api_url = https://sso.company.com/userinfo
role_attribute_path = contains(groups[*], 'grafana-admin') && 'Admin' || contains(groups[*], 'grafana-editor') && 'Editor' || 'Viewer'
auto_login = false
```

## Dashboard Backup and Restore

### Backup All Dashboards

```bash
#!/bin/bash
# backup-grafana-dashboards.sh
GRAFANA_URL="${GRAFANA_URL:-http://grafana:3000}"
GRAFANA_TOKEN="${GRAFANA_TOKEN}"
BACKUP_DIR="./grafana-backup/$(date +%Y%m%d)"

mkdir -p "$BACKUP_DIR"

# Get all dashboard UIDs
UIDS=$(curl -sf \
  -H "Authorization: Bearer $GRAFANA_TOKEN" \
  "$GRAFANA_URL/api/search?type=dash-db&limit=1000" | \
  jq -r '.[].uid')

for UID in $UIDS; do
  TITLE=$(curl -sf \
    -H "Authorization: Bearer $GRAFANA_TOKEN" \
    "$GRAFANA_URL/api/dashboards/uid/$UID" | \
    jq -r '.dashboard.title | gsub(" "; "-") | ascii_downcase')

  curl -sf \
    -H "Authorization: Bearer $GRAFANA_TOKEN" \
    "$GRAFANA_URL/api/dashboards/uid/$UID" | \
    jq '.dashboard' > "$BACKUP_DIR/${TITLE}-${UID}.json"

  echo "Backed up: $TITLE ($UID)"
done

echo "Backup complete: $(ls $BACKUP_DIR | wc -l) dashboards saved to $BACKUP_DIR"
```

### Restore from Backup

```bash
#!/bin/bash
# restore-grafana-dashboards.sh
BACKUP_DIR="${1:?Usage: $0 <backup-dir>}"
GRAFANA_URL="${GRAFANA_URL:-http://grafana:3000}"
GRAFANA_TOKEN="${GRAFANA_TOKEN}"
FOLDER_ID="${FOLDER_ID:-0}"

for FILE in "$BACKUP_DIR"/*.json; do
  DASHBOARD_JSON=$(cat "$FILE")
  TITLE=$(echo "$DASHBOARD_JSON" | jq -r '.title')

  RESULT=$(curl -sf -XPOST \
    -H "Authorization: Bearer $GRAFANA_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"dashboard\": $DASHBOARD_JSON, \"overwrite\": true, \"folderId\": $FOLDER_ID}" \
    "$GRAFANA_URL/api/dashboards/db")

  STATUS=$(echo "$RESULT" | jq -r '.status')
  echo "$TITLE: $STATUS"
done
```

## GitOps Workflow with ArgoCD

The complete GitOps workflow for Grafana dashboards:

```yaml
# argocd-grafana-application.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: grafana-dashboards
  namespace: argocd
spec:
  project: monitoring
  source:
    repoURL: https://git.company.com/monitoring/grafana-dashboards.git
    targetRevision: main
    path: kubernetes/
  destination:
    server: https://kubernetes.default.svc
    namespace: monitoring
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=false
      - ApplyOutOfSyncOnly=true
```

The CI/CD pipeline builds Jsonnet to JSON and commits to the GitOps repository:

```yaml
# .github/workflows/build-dashboards.yml
name: Build and Deploy Dashboards
on:
  push:
    branches: [main]
    paths: ['dashboards/**', 'lib/**']

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install jsonnet tools
        run: |
          go install github.com/google/go-jsonnet/cmd/jsonnet@latest
          go install github.com/jsonnet-bundler/jsonnet-bundler/cmd/jb@latest

      - name: Install dependencies
        run: jb install

      - name: Build dashboards
        run: make build

      - name: Validate JSON
        run: make validate

      - name: Commit to GitOps repo
        run: |
          git clone https://${{ secrets.GITOPS_TOKEN }}@git.company.com/monitoring/grafana-dashboards-k8s.git
          cp dist/*.json grafana-dashboards-k8s/configmaps/
          cd grafana-dashboards-k8s
          git add .
          git commit -m "Update dashboards from ${{ github.sha }}"
          git push
```

## Production Grafana Monitoring

Monitor Grafana health with these key metrics:

```promql
# Dashboard load time (user experience)
rate(grafana_api_dashboard_get_milliseconds_sum[5m])
/ rate(grafana_api_dashboard_get_milliseconds_count[5m])

# Active sessions
grafana_stat_totals_active_admins + grafana_stat_totals_active_editors + grafana_stat_totals_active_viewers

# Alert evaluation failures
rate(grafana_alerting_rule_evaluation_failures_total[5m])

# Database connection pool
grafana_database_conn_in_use_total

# Plugin errors
rate(grafana_plugin_request_duration_milliseconds_count{status="error"}[5m])
```

Alert on slow dashboard loads:

```yaml
- alert: GrafanaDashboardSlowLoad
  expr: |
    rate(grafana_api_dashboard_get_milliseconds_sum[5m])
    / rate(grafana_api_dashboard_get_milliseconds_count[5m]) > 2000
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Grafana dashboard API response time exceeds 2s"
```

## Summary

Enterprise Grafana management requires treating dashboards as first-class code artifacts. The key practices that enable scalable, maintainable Grafana deployments are:

- Use Grafonnet/Jsonnet for dashboard generation to enable code reuse and diff-friendly version control
- Deploy through the Grafana Operator for full GitOps management via ArgoCD or Flux
- Design variable hierarchies that chain from cluster to namespace to service to pod, enabling deep drill-down without duplicating dashboards
- Use repeat panels/rows for automatic per-service and per-cluster layout generation
- Configure Loki derived fields and Prometheus exemplars for seamless metrics-to-logs-to-traces correlation
- Implement structured folder hierarchies with RBAC aligned to team ownership
- Automate backup and restore procedures to protect against accidental dashboard deletion
- Monitor Grafana itself with Prometheus metrics and alert on degraded performance

The investment in proper dashboard-as-code infrastructure pays immediate dividends: faster onboarding for new team members, consistent dashboard quality, reliable change management, and the ability to reproduce an entire Grafana setup from scratch in minutes rather than days.
