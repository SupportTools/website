---
title: "Kubernetes Observability with Perses: Next-Gen Dashboard as Code"
date: 2030-01-17T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Observability", "Perses", "Dashboard", "GitOps", "Prometheus", "Grafana"]
categories: ["Kubernetes", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deploying Perses for Kubernetes observability, authoring dashboards as code with the Go/TypeScript DSL, migrating from Grafana, implementing team ownership models, and GitOps-driven dashboard management."
more_link: "yes"
url: "/kubernetes-observability-perses-dashboard-as-code/"
---

Grafana is the default choice for Kubernetes observability dashboards, but its model has a fundamental limitation at scale: dashboards live in a database, making version control, review workflows, and multi-team ownership difficult. Perses, the CNCF sandbox observability project, inverts this model — dashboards are YAML/JSON files with a versioned schema, a typed Go and TypeScript SDK, and a Kubernetes-native CRD for in-cluster deployment. This guide covers deploying Perses on Kubernetes, authoring dashboards with the Go SDK, migrating from Grafana, and implementing GitOps workflows where teams own their dashboards like they own their code.

<!--more-->

# Kubernetes Observability with Perses: Next-Gen Dashboard as Code

## Why Perses?

Grafana's popularity comes with architectural debt:

- **Dashboard drift**: Dashboards modified through the UI diverge from version control
- **Import/export friction**: JSON exports are opaque blobs without semantic diffs
- **Access control at scale**: RBAC for 50+ teams sharing a Grafana instance is complex
- **No validation pipeline**: Invalid PromQL reaches production dashboards

Perses addresses these systematically:

| Problem | Grafana | Perses |
|---------|---------|--------|
| Version control | Optional (Grafana as Code tools) | First-class (YAML schema) |
| Schema validation | None | Built-in JSON Schema + CLI |
| SDK | None | Go and TypeScript SDKs |
| Kubernetes native | No | CRD-native |
| Multi-tenancy | Folder-based | Project-based with RBAC |
| Panel plugins | Plugin marketplace | Plugin interface + defaults |

## Perses Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Perses Control Plane                     │
│  ┌───────────────┐  ┌──────────────────┐  ┌──────────────┐  │
│  │  API Server   │  │  Dashboard       │  │  Plugin      │  │
│  │  (REST)       │  │  Storage (etcd/  │  │  Registry    │  │
│  │               │  │   SQLite/SQL)    │  │              │  │
│  └───────┬───────┘  └──────────────────┘  └──────────────┘  │
│          │                                                    │
│  ┌───────▼───────┐                                           │
│  │  Web UI       │                                           │
│  │  (React)      │                                           │
│  └───────────────┘                                           │
└─────────────────────────────────────────────────────────────┘
              │ HTTP API
┌─────────────▼───────────────────────────────────────────────┐
│              Perses Operator (Kubernetes)                    │
│  Watches PersesDashboard, PersesProject CRDs                │
│  Syncs to Perses API Server                                  │
└─────────────────────────────────────────────────────────────┘
```

## Deploying Perses on Kubernetes

### Helm Installation

```bash
helm repo add perses https://perses-project.github.io/perses/charts/
helm repo update

kubectl create namespace observability

helm install perses perses/perses \
  --namespace observability \
  --version 0.48.0 \
  --set server.database.type=sql \
  --set server.database.sql.driver=postgres \
  --set server.database.sql.dsn="host=postgres.observability.svc.cluster.local user=perses password=secret dbname=perses sslmode=disable" \
  --set server.authentication.providers.type=oidc \
  --set server.authentication.providers.oidc.issuerURL="https://sso.company.com" \
  --set server.authentication.providers.oidc.clientID="perses" \
  --set server.authentication.providers.oidc.redirectURI="https://perses.company.com/api/auth/callback" \
  --set ingress.enabled=true \
  --set ingress.host=perses.company.com \
  --set operator.enabled=true \
  --wait
```

### Production values.yaml

```yaml
# values-production.yaml
server:
  replicaCount: 3
  resources:
    requests:
      cpu: "200m"
      memory: "256Mi"
    limits:
      cpu: "1"
      memory: "1Gi"

  database:
    type: sql
    sql:
      driver: postgres

  authentication:
    accessTokenTTL: "15m"
    refreshTokenTTL: "24h"
    disableSignUp: true

  authorization:
    guestPermissions:
      - actions: ["read"]
        scope: "GlobalDatasource"

  datasource:
    global:
      - name: prometheus-production
        plugin:
          kind: PrometheusDatasource
          spec:
            directURL: "http://prometheus.monitoring.svc.cluster.local:9090"
      - name: thanos
        plugin:
          kind: PrometheusDatasource
          spec:
            directURL: "http://thanos-query.monitoring.svc.cluster.local:9090"

operator:
  enabled: true
  watchedNamespaces:
    - production
    - staging
    - platform

ingress:
  enabled: true
  className: nginx
  host: perses.company.com
  tls:
    - secretName: perses-tls
      hosts:
        - perses.company.com
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
```

### Installing the Perses CLI

```bash
curl -LO "https://github.com/perses/perses/releases/download/v0.48.0/percli_linux_amd64.tar.gz"
tar xzf percli_linux_amd64.tar.gz
install percli /usr/local/bin/

percli config set-server https://perses.company.com
percli config set-project platform-team
percli describe apiserver
```

## Dashboard as Code with the Go SDK

### Setting Up the SDK Project

```bash
mkdir -p dashboards/platform
cd dashboards/platform
go mod init github.com/company/perses-dashboards
go get github.com/perses/perses/go-sdk@v0.48.0
```

### Kubernetes Node Dashboard in Go

```go
// dashboards/platform/kubernetes_nodes.go
package main

import (
    "github.com/perses/perses/go-sdk/dashboard"
    "github.com/perses/perses/go-sdk/panel"
    "github.com/perses/perses/go-sdk/panel/stat"
    "github.com/perses/perses/go-sdk/panel/timeseries"
    "github.com/perses/perses/go-sdk/panel/gauge"
    "github.com/perses/perses/go-sdk/query"
    "github.com/perses/perses/go-sdk/variable"
    "github.com/perses/perses/go-sdk/common"
)

func KubernetesNodesDashboard() dashboard.Builder {
    return dashboard.New("kubernetes-nodes",
        dashboard.ProjectName("platform"),
        dashboard.Name("Kubernetes Nodes"),
        dashboard.Tags("kubernetes", "nodes", "infrastructure"),

        dashboard.AddVariable("cluster",
            variable.List(
                variable.DisplayName("Cluster"),
                variable.Query(
                    query.Prometheus(`label_values(kube_node_info, cluster)`),
                ),
            ),
        ),
        dashboard.AddVariable("node",
            variable.List(
                variable.DisplayName("Node"),
                variable.Query(
                    query.Prometheus(
                        `label_values(kube_node_info{cluster="$cluster"}, node)`,
                    ),
                ),
                variable.AllowAllValue(true),
                variable.AllowMultiple(true),
            ),
        ),

        dashboard.AddPanelGroup("Cluster Overview",
            panel.NewGroup(
                panel.Width(6),
                panel.AddPanel("Total Nodes",
                    stat.New(
                        stat.WithQuery(
                            query.Prometheus(
                                `count(kube_node_info{cluster="$cluster"})`,
                            ),
                        ),
                    ),
                ),
                panel.AddPanel("Ready Nodes",
                    stat.New(
                        stat.WithQuery(
                            query.Prometheus(
                                `count(kube_node_status_condition{cluster="$cluster",condition="Ready",status="true"})`,
                            ),
                        ),
                    ),
                ),
                panel.AddPanel("Not Ready",
                    stat.New(
                        stat.WithQuery(
                            query.Prometheus(
                                `count(kube_node_status_condition{cluster="$cluster",condition="Ready",status="false"}) or vector(0)`,
                            ),
                        ),
                        stat.ColorByThresholds(),
                        stat.Thresholds(
                            common.Threshold{Value: 0, Color: "green"},
                            common.Threshold{Value: 1, Color: "red"},
                        ),
                    ),
                ),
            ),
        ),

        dashboard.AddPanelGroup("CPU",
            panel.NewGroup(
                panel.Width(12),
                panel.AddPanel("CPU Usage by Node",
                    timeseries.New(
                        timeseries.WithQuery(
                            query.Prometheus(
                                `100 - (avg by (node) (rate(node_cpu_seconds_total{cluster="$cluster",mode="idle",node=~"$node"}[5m])) * 100)`,
                                query.SeriesName("{{node}}"),
                            ),
                        ),
                        timeseries.Unit("%"),
                        timeseries.Min(0),
                        timeseries.Max(100),
                    ),
                ),
            ),
            panel.NewGroup(
                panel.Width(6),
                panel.AddPanel("CPU Requests Allocation",
                    gauge.New(
                        gauge.WithQuery(
                            query.Prometheus(
                                `sum(kube_pod_container_resource_requests{cluster="$cluster",resource="cpu",node=~"$node"}) / sum(kube_node_status_allocatable{cluster="$cluster",resource="cpu",node=~"$node"}) * 100`,
                            ),
                        ),
                        gauge.Unit("%"),
                        gauge.Min(0),
                        gauge.Max(100),
                        gauge.Thresholds(
                            common.Threshold{Value: 0, Color: "green"},
                            common.Threshold{Value: 80, Color: "yellow"},
                            common.Threshold{Value: 95, Color: "red"},
                        ),
                    ),
                ),
            ),
        ),

        dashboard.AddPanelGroup("Memory",
            panel.NewGroup(
                panel.Width(12),
                panel.AddPanel("Memory Usage by Node",
                    timeseries.New(
                        timeseries.WithQuery(
                            query.Prometheus(
                                `(1 - (node_memory_MemAvailable_bytes{cluster="$cluster",node=~"$node"} / node_memory_MemTotal_bytes{cluster="$cluster",node=~"$node"})) * 100`,
                                query.SeriesName("{{node}}"),
                            ),
                        ),
                        timeseries.Unit("%"),
                        timeseries.Min(0),
                        timeseries.Max(100),
                    ),
                ),
            ),
        ),

        dashboard.AddPanelGroup("Network",
            panel.NewGroup(
                panel.Width(12),
                panel.AddPanel("Network Traffic",
                    timeseries.New(
                        timeseries.WithQuery(
                            query.Prometheus(
                                `rate(node_network_receive_bytes_total{cluster="$cluster",node=~"$node",device!="lo"}[5m])`,
                                query.SeriesName("{{node}} RX"),
                            ),
                        ),
                        timeseries.WithQuery(
                            query.Prometheus(
                                `-rate(node_network_transmit_bytes_total{cluster="$cluster",node=~"$node",device!="lo"}[5m])`,
                                query.SeriesName("{{node}} TX"),
                            ),
                        ),
                        timeseries.Unit("bytes/s"),
                    ),
                ),
            ),
        ),
    )
}
```

### Dashboard Generator

```go
// cmd/generate/main.go
package main

import (
    "encoding/json"
    "fmt"
    "os"
    "path/filepath"
)

func main() {
    outputDir := "./generated"
    if err := os.MkdirAll(outputDir, 0755); err != nil {
        fmt.Fprintf(os.Stderr, "failed to create output dir: %v\n", err)
        os.Exit(1)
    }

    dashboards := map[string]dashboard.Builder{
        "kubernetes-nodes":      KubernetesNodesDashboard(),
        "kubernetes-workloads":  KubernetesWorkloadsDashboard(),
        "slo-overview":         SLOOverviewDashboard(),
    }

    for name, builder := range dashboards {
        d, err := builder.Build()
        if err != nil {
            fmt.Fprintf(os.Stderr, "failed to build %s: %v\n", name, err)
            os.Exit(1)
        }

        crd := map[string]interface{}{
            "apiVersion": "perses.dev/v1alpha1",
            "kind":       "PersesDashboard",
            "metadata": map[string]interface{}{
                "name":      d.Metadata.Name,
                "namespace": "platform",
                "annotations": map[string]interface{}{
                    "perses.dev/owner": "platform-team@company.com",
                },
            },
            "spec": d.Spec,
        }

        data, err := json.MarshalIndent(crd, "", "  ")
        if err != nil {
            fmt.Fprintf(os.Stderr, "marshal failed for %s: %v\n", name, err)
            os.Exit(1)
        }

        outputPath := filepath.Join(outputDir, name+".json")
        if err := os.WriteFile(outputPath, data, 0644); err != nil {
            fmt.Fprintf(os.Stderr, "write failed for %s: %v\n", outputPath, err)
            os.Exit(1)
        }
        fmt.Printf("Generated: %s\n", outputPath)
    }
}
```

## Kubernetes CRD Resources

### PersesDashboard CRD

```yaml
apiVersion: perses.dev/v1alpha1
kind: PersesDashboard
metadata:
  name: kubernetes-nodes
  namespace: platform
  labels:
    app.kubernetes.io/managed-by: argocd
    perses.dev/project: platform
    team: platform-reliability
  annotations:
    perses.dev/dashboard-version: "v2.3.0"
    perses.dev/owner: "platform-team@company.com"
spec:
  display:
    name: "Kubernetes Nodes"
  variables:
    - kind: ListVariable
      spec:
        name: cluster
        display:
          name: Cluster
        plugin:
          kind: PrometheusLabelValuesVariable
          spec:
            datasource:
              name: prometheus-production
            labelName: cluster
            matchers:
              - kube_node_info
    - kind: ListVariable
      spec:
        name: node
        allowAllValue: true
        allowMultiple: true
        display:
          name: Node
        plugin:
          kind: PrometheusLabelValuesVariable
          spec:
            datasource:
              name: prometheus-production
            labelName: node
            matchers:
              - 'kube_node_info{cluster="$cluster"}'
  panels: {}
```

### PersesProject CRD

```yaml
apiVersion: perses.dev/v1alpha1
kind: PersesProject
metadata:
  name: platform
  namespace: observability
spec:
  display:
    name: "Platform Team"
    description: "Infrastructure and platform observability"
  datasources:
    - name: prometheus-production
      spec:
        default: true
        plugin:
          kind: PrometheusDatasource
          spec:
            directURL: http://prometheus.monitoring.svc.cluster.local:9090
```

## Grafana Migration Strategy

### Export Grafana Dashboards

```bash
GRAFANA_URL="https://grafana.company.com"
GRAFANA_TOKEN="your-service-account-token"
OUTPUT_DIR="./grafana-export"
mkdir -p "$OUTPUT_DIR"

# List all dashboard UIDs
DASHBOARDS=$(curl -s \
  -H "Authorization: Bearer $GRAFANA_TOKEN" \
  "$GRAFANA_URL/api/search?type=dash-db" | \
  jq -r '.[].uid')

for uid in $DASHBOARDS; do
  SAFE_TITLE=$(curl -s \
    -H "Authorization: Bearer $GRAFANA_TOKEN" \
    "$GRAFANA_URL/api/dashboards/uid/$uid" | \
    jq -r '.dashboard.title' | \
    tr '[:upper:]' '[:lower:]' | \
    sed 's/[^a-z0-9]/-/g')

  curl -s \
    -H "Authorization: Bearer $GRAFANA_TOKEN" \
    "$GRAFANA_URL/api/dashboards/uid/$uid" | \
    jq '.dashboard' > "$OUTPUT_DIR/$SAFE_TITLE.json"

  echo "Exported: $SAFE_TITLE"
done
```

### Convert and Validate

```bash
# Convert each Grafana dashboard to Perses format
for f in ./grafana-export/*.json; do
  name=$(basename "$f" .json)
  percli convert grafana-dashboard \
    --file "$f" \
    --output "./perses-dashboards/$name.yaml" \
    --project platform \
    --datasource prometheus-production
done

# Validate all converted dashboards
percli lint --strict ./perses-dashboards/

# Dry-run before applying
percli apply --dry-run -f ./perses-dashboards/

# Apply
percli apply -f ./perses-dashboards/
```

## GitOps Workflow with ArgoCD

### Repository Structure

```
observability-dashboards/
├── projects/
│   ├── platform/
│   │   ├── project.yaml
│   │   └── dashboards/
│   │       ├── kubernetes-nodes.yaml
│   │       └── slo-overview.yaml
│   └── payments/
│       ├── project.yaml
│       └── dashboards/
│           └── payment-service.yaml
└── global/
    └── datasources/
        └── prometheus.yaml
```

### ArgoCD Application

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: perses-dashboards
  namespace: argocd
spec:
  project: platform
  source:
    repoURL: https://github.com/company/observability-dashboards
    targetRevision: main
    path: projects/platform
  destination:
    server: https://kubernetes.default.svc
    namespace: platform
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
```

### CI Validation Pipeline

```yaml
# .github/workflows/validate-dashboards.yml
name: Validate Perses Dashboards
on:
  pull_request:
    paths:
      - 'projects/**/*.yaml'
      - 'global/**/*.yaml'

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install percli
        run: |
          curl -LO "https://github.com/perses/perses/releases/download/v0.48.0/percli_linux_amd64.tar.gz"
          tar xzf percli_linux_amd64.tar.gz
          sudo install percli /usr/local/bin/

      - name: Validate dashboard schema
        run: percli lint --strict projects/

      - name: Check owner annotations
        run: |
          find projects/ -name '*.yaml' | while read f; do
            OWNER=$(yq -r '.metadata.annotations["perses.dev/owner"] // ""' "$f" 2>/dev/null)
            NAME=$(yq -r '.metadata.name // "unknown"' "$f" 2>/dev/null)
            if [ -z "$OWNER" ]; then
              echo "ERROR: Missing owner annotation in $f (dashboard: $NAME)"
              exit 1
            fi
          done

      - name: Validate PromQL syntax
        run: |
          find projects/ -name '*.yaml' | while read f; do
            yq -r '.. | .expr? // empty' "$f" 2>/dev/null | while read query; do
              if ! promtool query instant "$query" 2>/dev/null; then
                echo "WARNING: Could not validate query: $query"
              fi
            done
          done
```

## Team Ownership and RBAC

### Namespace-Scoped Permissions

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: perses-dashboard-editor
rules:
  - apiGroups: ["perses.dev"]
    resources: ["persesdashboards"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["perses.dev"]
    resources: ["persesdatasources"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: platform-dashboard-editors
  namespace: platform
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: perses-dashboard-editor
subjects:
  - kind: Group
    name: platform-team
    apiGroup: rbac.authorization.k8s.io
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: payments-dashboard-editors
  namespace: payments
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: perses-dashboard-editor
subjects:
  - kind: Group
    name: payments-team
    apiGroup: rbac.authorization.k8s.io
```

## Monitoring Perses

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: perses
  namespace: observability
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: perses
  endpoints:
    - port: http
      path: /metrics
      interval: 30s
```

Key operational PromQL queries:

```promql
# API request latency p99
histogram_quantile(0.99,
  sum(rate(perses_http_request_duration_seconds_bucket[5m])) by (le, handler)
)

# Error rate
rate(perses_http_requests_total{code=~"5.."}[5m])
/
rate(perses_http_requests_total[5m])

# Active dashboard queries
perses_dashboard_renders_active
```

## Conclusion

Perses brings software engineering discipline to observability dashboards. The key benefits of adopting it for enterprise Kubernetes environments:

- **Schema-first design** means every dashboard has a defined, validated structure that can be reviewed in pull requests like any other configuration file
- **Go and TypeScript SDKs** enable dashboard logic to be composed and reused as code, with compile-time validation of panel configurations
- **Kubernetes-native CRDs** integrate dashboard deployment into existing GitOps workflows without special tooling
- **Project-based RBAC** provides clean team isolation — the payments team can edit payment dashboards without any risk of affecting the platform team's views
- **Automated migration tooling** makes the switch from Grafana tractable for large existing deployments

Start the migration incrementally: deploy Perses alongside Grafana, migrate new dashboards to Perses first, then gradually port existing dashboards using percli convert. The validation and review benefits appear immediately with the first few dashboards.
