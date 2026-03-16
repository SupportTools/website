---
title: "Tanka and Jsonnet: Programmatic Kubernetes Configuration Management"
date: 2027-02-26T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Tanka", "Jsonnet", "Configuration Management", "GitOps"]
categories: ["Kubernetes", "DevOps", "Configuration Management"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Tanka and Jsonnet for Kubernetes configuration management, covering Jsonnet fundamentals, Tanka project structure, k8s-libsonnet, multi-environment workflows, Helm integration, and CI/CD pipelines."
more_link: "yes"
url: "/tanka-jsonnet-kubernetes-configuration-management-guide/"
---

Kubernetes configuration management suffers from a fundamental tension: YAML is declarative and readable, but it has no abstraction mechanisms. Helm adds templating, Kustomize adds patching, but neither gives you a real programming language. **Tanka** and **Jsonnet** resolve this by replacing YAML generation with a functional data templating language that produces deterministic, fully evaluated JSON output — which Kubernetes accepts natively.

This guide covers Jsonnet language fundamentals, Tanka project structure, multi-environment management, Helm chart import, secret handling with SOPS, and CI/CD integration at production scale.

<!--more-->

## Executive Summary

Tanka is a configuration utility for Kubernetes built on top of Jsonnet. It provides a structured project layout, environment management, and tight integration with `kubectl` diff and apply workflows. Teams that adopt Tanka typically eliminate hundreds of duplicated YAML files across environments by replacing them with parameterised Jsonnet libraries that compile down to exact Kubernetes manifests at apply time.

Key advantages over Helm and Kustomize:

- Full programming language semantics: functions, conditionals, local variables, imports
- Deterministic output: same input always produces the same YAML
- Native diff before apply with contextual output
- First-class multi-environment support without chart re-packaging
- Composable library ecosystem through `jsonnet-bundler`

---

## Jsonnet Language Fundamentals

### Data Types and Basic Syntax

Jsonnet is a superset of JSON. Every valid JSON document is also valid Jsonnet. The additions are: comments, string operations, conditionals, comprehensions, functions, and imports.

```jsonnet
// Single-line comment
/* Multi-line comment */

// All Jsonnet evaluates to a JSON value
{
  // String concatenation
  name: "prod" + "-cluster",

  // Arithmetic
  replicas: 2 + 1,

  // Conditional
  debug: if std.extVar("env") == "dev" then true else false,

  // Array comprehension
  ports: [8000 + i for i in std.range(0, 2)],
}
```

### Functions

Functions are first-class values in Jsonnet. They use parameter defaults, which eliminates the need for overrides at every call site.

```jsonnet
// lib/helpers.libsonnet
{
  // A function that returns a resource labels object
  labels(app, version="latest", component=null):: {
    "app.kubernetes.io/name": app,
    "app.kubernetes.io/version": version,
    [if component != null then "app.kubernetes.io/component"]: component,
  },

  // A function that builds a container resource block
  resources(cpu_req="100m", mem_req="128Mi", cpu_lim="500m", mem_lim="512Mi"):: {
    requests: { cpu: cpu_req, memory: mem_req },
    limits: { cpu: cpu_lim, memory: mem_lim },
  },
}
```

The `::` double-colon marks a hidden field — it appears in evaluated output only when explicitly referenced, not in the top-level JSON. This is the primary mechanism for defining reusable library functions.

### Object Merging and Inheritance

Jsonnet's `+` operator performs a recursive merge. The right-hand side overrides the left-hand side at each level.

```jsonnet
local base = {
  metadata: {
    namespace: "default",
    labels: { tier: "backend" },
  },
  spec: { replicas: 1 },
};

local override = {
  metadata+: {
    // + on a field merges instead of replacing
    labels+: { env: "production" },
  },
  spec+: { replicas: 3 },
};

base + override
// Result:
// {
//   metadata: { namespace: "default", labels: { tier: "backend", env: "production" } },
//   spec: { replicas: 3 }
// }
```

### Standard Library

The `std` library ships with Jsonnet and covers string manipulation, type checks, encoding, and data transformation.

```jsonnet
local std_examples = {
  // String operations
  upper: std.asciiUpper("hello"),          // "HELLO"
  split: std.split("a,b,c", ","),          // ["a","b","c"]
  format: std.format("%s:%d", ["web", 80]),// "web:80"

  // Type introspection
  is_array: std.isArray([1, 2, 3]),        // true

  // Object manipulation
  keys: std.objectFields({ a: 1, b: 2 }), // ["a","b"]
  values: std.objectValues({ a: 1 }),      // [1]
  merge: std.mergePatch({ a: 1 }, { b: 2 }),// { a:1, b:2 }

  // Encoding
  b64: std.base64("hello"),               // "aGVsbG8="

  // Numeric
  clamp: std.clamp(15, 0, 10),            // 10
  min: std.min(3, 7),                     // 3
};

std_examples
```

### Imports

Jsonnet supports three import forms:

```jsonnet
// Import a .libsonnet or .jsonnet file (returns the evaluated value)
local k = import "github.com/jsonnet-libs/k8s-libsonnet/1.29/main.libsonnet";

// Import raw file contents as a string
local config_template = importstr "config.yaml.tmpl";

// Import binary file as base64-encoded string
local tls_cert = importbin "tls.crt";
```

---

## Tanka Project Structure

### Initialising a Project

Install Tanka and `jsonnet-bundler` (the Jsonnet package manager):

```bash
# Install Tanka
curl -fsSL https://github.com/grafana/tanka/releases/download/v0.26.0/tk-linux-amd64 \
  -o /usr/local/bin/tk && chmod +x /usr/local/bin/tk

# Install jsonnet-bundler
go install github.com/jsonnet-bundler/jsonnet-bundler/cmd/jb@latest

# Initialise a new project
mkdir my-platform && cd my-platform
tk init
jb init
```

This creates the canonical Tanka layout:

```
my-platform/
├── jsonnetfile.json          # jb dependency manifest
├── jsonnetfile.lock.json     # pinned dependency versions
├── lib/                      # local shared libraries
├── vendor/                   # jb-managed third-party libs
└── environments/
    ├── default/              # one directory per environment
    │   ├── spec.json         # cluster connection spec
    │   └── main.jsonnet      # environment entry point
    ├── staging/
    └── production/
```

### Environment spec.json

Each environment's `spec.json` declares the Kubernetes API server and default namespace:

```json
{
  "apiVersion": "tanka.dev/v1alpha1",
  "kind": "Environment",
  "metadata": {
    "name": "environments/production"
  },
  "spec": {
    "apiServer": "https://k8s.prod.example.com:6443",
    "namespace": "platform",
    "resourceDefaults": {},
    "expectVersions": {}
  }
}
```

### Installing k8s-libsonnet

**k8s-libsonnet** provides typed constructor functions for every Kubernetes resource kind. It is auto-generated from the OpenAPI spec for each Kubernetes release.

```bash
# Install k8s-libsonnet for Kubernetes 1.29
jb install github.com/jsonnet-libs/k8s-libsonnet/1.29@main

# Create a convenience import alias
cat > lib/k.libsonnet <<'EOF'
import "github.com/jsonnet-libs/k8s-libsonnet/1.29/main.libsonnet"
EOF
```

---

## Building Kubernetes Resources with k8s-libsonnet

### Deployment and Service

```jsonnet
// lib/app.libsonnet
local k = import "k.libsonnet";

local deployment = k.apps.v1.deployment;
local container  = k.core.v1.container;
local service    = k.core.v1.service;
local port       = k.core.v1.servicePort;

{
  // new(name, image, replicas) returns {deployment, service}
  new(name, image, replicas=2, containerPort=8080):: {
    local labels = { "app.kubernetes.io/name": name },

    deployment: deployment.new(
      name=name,
      replicas=replicas,
      containers=[
        container.new(name, image)
        + container.withPorts([
            k.core.v1.containerPort.new(containerPort)
          ])
        + container.withEnvFrom([
            k.core.v1.envFromSource.secretRef.withName(name + "-env")
          ])
        + container.resources.withRequests({ cpu: "100m", memory: "128Mi" })
        + container.resources.withLimits({ cpu: "500m", memory: "512Mi" })
        + container.livenessProbe.httpGet.withPath("/healthz")
        + container.livenessProbe.httpGet.withPort(containerPort)
        + container.readinessProbe.httpGet.withPath("/readyz")
        + container.readinessProbe.httpGet.withPort(containerPort),
      ]
    ) + deployment.metadata.withLabels(labels)
      + deployment.spec.selector.withMatchLabels(labels)
      + deployment.spec.template.metadata.withLabels(labels),

    service: service.new(
      name=name,
      selector=labels,
      ports=[port.new(80, containerPort)]
    ),
  },
}
```

### HorizontalPodAutoscaler

```jsonnet
// lib/hpa.libsonnet
local k = import "k.libsonnet";

local hpa = k.autoscaling.v2.horizontalPodAutoscaler;
local metric = k.autoscaling.v2.metricSpec;

{
  forDeployment(name, min=2, max=10, cpu_target=70)::
    hpa.new(name)
    + hpa.spec.scaleTargetRef.withKind("Deployment")
    + hpa.spec.scaleTargetRef.withName(name)
    + hpa.spec.withMinReplicas(min)
    + hpa.spec.withMaxReplicas(max)
    + hpa.spec.withMetrics([
        metric.resource.withName("cpu")
        + metric.resource.target.withType("Utilization")
        + metric.resource.target.withAverageUtilization(cpu_target),
      ]),
}
```

### ConfigMap and Secret

```jsonnet
// lib/config.libsonnet
local k = import "k.libsonnet";

local cm = k.core.v1.configMap;
local secret = k.core.v1.secret;

{
  configMap(name, data)::
    cm.new(name, data),

  // Secrets should contain base64-encoded values or use SOPS (see below)
  // This creates an Opaque secret from a plain string map
  opaqueSecret(name, stringData)::
    secret.new(name, {})
    + secret.withStringData(stringData)
    + secret.withType("Opaque"),
}
```

---

## Multi-Environment Configuration

### Shared Library Pattern

Place reusable code in `lib/` and environment-specific values in `environments/<name>/main.jsonnet`.

```jsonnet
// lib/platform.libsonnet
local app  = import "app.libsonnet";
local hpa  = import "hpa.libsonnet";

{
  // Returns all platform resources for a given params object
  resources(params):: {
    // Each app component
    [comp.name + "_deploy"]: app.new(
      comp.name,
      comp.image,
      params.replicas,
    ).deployment
    for comp in params.components
  } + {
    [comp.name + "_svc"]: app.new(
      comp.name,
      comp.image,
      params.replicas,
    ).service
    for comp in params.components
  } + {
    [comp.name + "_hpa"]: hpa.forDeployment(
      comp.name,
      min=params.hpa.min,
      max=params.hpa.max,
    )
    for comp in params.components
    if params.hpa.enabled
  },
}
```

### Production Environment

```jsonnet
// environments/production/main.jsonnet
local platform = import "../../lib/platform.libsonnet";

platform.resources({
  replicas: 3,
  hpa: { enabled: true, min: 3, max: 20 },
  components: [
    { name: "api",     image: "registry.example.com/api:v2.4.1" },
    { name: "worker",  image: "registry.example.com/worker:v2.4.1" },
    { name: "gateway", image: "registry.example.com/gateway:v1.9.0" },
  ],
})
```

### Staging Environment

```jsonnet
// environments/staging/main.jsonnet
local platform = import "../../lib/platform.libsonnet";

platform.resources({
  replicas: 1,
  hpa: { enabled: false, min: 1, max: 3 },
  components: [
    { name: "api",     image: "registry.example.com/api:v2.4.1-rc1" },
    { name: "worker",  image: "registry.example.com/worker:v2.4.1-rc1" },
    { name: "gateway", image: "registry.example.com/gateway:v1.9.0" },
  ],
})
```

---

## Helm Chart Import via tanka-helm

**tanka-helm** provides a Jsonnet function that renders a Helm chart inside the Tanka evaluation, returning the resulting objects as a Jsonnet object rather than raw YAML strings.

```bash
jb install github.com/grafana/tanka-helm/helm@main
```

```jsonnet
// environments/production/main.jsonnet
local helm = (import "github.com/grafana/tanka-helm/helm/helm.libsonnet").new(std.thisFile);

// Import a Helm chart from the vendor directory
local certManager = helm.template("cert-manager", "./charts/cert-manager", {
  values: {
    installCRDs: true,
    replicaCount: 2,
    resources: {
      requests: { cpu: "10m", memory: "32Mi" },
    },
    prometheus: {
      enabled: true,
      servicemonitor: { enabled: true },
    },
  },
});

{
  // Merge cert-manager manifests with your other resources
  cert_manager: certManager,
}
```

Add the chart to the vendor directory so the project is self-contained:

```bash
# Add chart to charts/ directory (committed to git)
helm repo add jetstack https://charts.jetstack.io
helm pull jetstack/cert-manager --version v1.14.3 --untar --untardir charts/
```

---

## Diff and Apply Workflow

### Previewing Changes

`tk diff` renders the Jsonnet, queries the live cluster state, and produces a standard kubectl diff output:

```bash
# Diff a single environment
tk diff environments/production

# Diff and show only resource names that changed
tk diff environments/production | grep "^[+-][^+-]" | awk '{print $1, $2}'

# Diff with server-side apply dry-run (more accurate for webhook validation)
tk diff --server-side environments/production
```

### Applying Changes

```bash
# Apply a full environment
tk apply environments/production

# Apply and auto-approve (useful in CI)
tk apply --dangerous-auto-approve environments/production

# Show what would be applied without making changes
tk show environments/production
```

### Exporting to YAML Files

For GitOps workflows where the CD tool applies pre-rendered YAML:

```bash
# Export all environments to a rendered/ directory
for env in environments/*/; do
  name=$(basename "$env")
  mkdir -p rendered/"$name"
  tk export rendered/"$name" "$env"
done
```

---

## Secret Management with SOPS

**SOPS** (Secrets OPerationS) encrypts secret values in-place inside YAML or JSON files, leaving structure readable. Tanka integrates through a pre-processor hook.

### Encrypting a Secret File

```bash
# Create a plain secret file
cat > environments/production/secrets.yaml <<'EOF'
apiVersion: v1
kind: Secret
metadata:
  name: api-credentials
type: Opaque
stringData:
  DATABASE_URL: postgres://appuser:EXAMPLE_TOKEN_REPLACE_ME@db.prod.example.com/appdb
  API_KEY: EXAMPLE_TOKEN_REPLACE_ME
EOF

# Encrypt with AWS KMS (replace ARN with your own)
sops --kms arn:aws:kms:us-east-1:123456789012:key/mrk-EXAMPLE_REPLACE_ME \
     --encrypt --in-place environments/production/secrets.yaml

# The file now contains encrypted values — safe to commit
```

### Decrypting at Apply Time

Tanka supports an `--exec` flag to pre-process files through an external command:

```bash
# Define a SOPS-aware kubectl wrapper
cat > bin/kubectl-sops <<'EOF'
#!/usr/bin/env bash
# Decrypt any SOPS-encrypted files in stdin before passing to kubectl
sops --decrypt --input-type yaml --output-type yaml /dev/stdin | kubectl "$@"
EOF
chmod +x bin/kubectl-sops

# Apply with SOPS decryption
KUBECTL=bin/kubectl-sops tk apply environments/production
```

Alternatively, use **External Secrets Operator** and store only references in Jsonnet:

```jsonnet
// lib/external-secret.libsonnet
local k = import "k.libsonnet";

{
  fromAWSSecretsManager(name, secretName, keys)::
    {
      apiVersion: "external-secrets.io/v1beta1",
      kind: "ExternalSecret",
      metadata: { name: name },
      spec: {
        refreshInterval: "1h",
        secretStoreRef: { name: "aws-secrets-manager", kind: "ClusterSecretStore" },
        target: { name: name, creationPolicy: "Owner" },
        data: [
          {
            secretKey: key,
            remoteRef: { key: secretName, property: key },
          }
          for key in keys
        ],
      },
    },
}
```

---

## Grafonnet: Grafana Dashboards as Code

**Grafonnet** is the official Jsonnet library for generating Grafana dashboards. Combined with Tanka, it lets you version-control dashboards alongside the application configuration that generates the metrics.

```bash
jb install github.com/grafana/grafonnet/gen/grafonnet-latest@main
```

```jsonnet
// lib/dashboards/api-dashboard.libsonnet
local g = import "github.com/grafana/grafonnet/gen/grafonnet-latest/main.libsonnet";

local dashboard = g.dashboard;
local panel     = g.panel;
local query     = g.query.prometheus;

dashboard.new("API Service Overview")
+ dashboard.withUid("api-overview-v1")
+ dashboard.withTimezone("browser")
+ dashboard.withRefresh("30s")
+ dashboard.withPanels([
    panel.timeSeries.new("Request Rate")
    + panel.timeSeries.queryOptions.withTargets([
        query.new(
          "$datasource",
          "sum(rate(http_requests_total{job=\"api\"}[$__rate_interval])) by (status_code)"
        )
        + query.withLegendFormat("{{status_code}}"),
      ])
    + panel.timeSeries.gridPos.withX(0)
    + panel.timeSeries.gridPos.withY(0)
    + panel.timeSeries.gridPos.withW(12)
    + panel.timeSeries.gridPos.withH(8),

    panel.timeSeries.new("P99 Latency")
    + panel.timeSeries.queryOptions.withTargets([
        query.new(
          "$datasource",
          "histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{job=\"api\"}[$__rate_interval])) by (le))"
        )
        + query.withLegendFormat("p99"),
      ])
    + panel.timeSeries.gridPos.withX(12)
    + panel.timeSeries.gridPos.withY(0)
    + panel.timeSeries.gridPos.withW(12)
    + panel.timeSeries.gridPos.withH(8),
  ])
```

### Deploying Dashboards via ConfigMap

Grafana's sidecar pattern loads dashboards from ConfigMaps labelled `grafana_dashboard: "1"`:

```jsonnet
// environments/production/dashboards.jsonnet
local k = import "k.libsonnet";
local apiDash = import "../../lib/dashboards/api-dashboard.libsonnet";

{
  api_dashboard_cm:
    k.core.v1.configMap.new("api-dashboard", {
      "api-overview.json": std.manifestJsonEx(apiDash, "  "),
    })
    + k.core.v1.configMap.metadata.withLabels({
        grafana_dashboard: "1",
        grafana_folder: "Platform",
      }),
}
```

---

## Vendoring Dependencies

All `jb`-managed libraries should be committed to `vendor/` so the project builds offline and in CI without network access.

```bash
# Install all dependencies from jsonnetfile.json
jb install

# Update a specific package
jb update github.com/jsonnet-libs/k8s-libsonnet/1.29@main

# After update, commit both jsonnetfile.lock.json and the vendor/ changes
git add jsonnetfile.lock.json vendor/
git commit -m "chore: update k8s-libsonnet to latest"
```

`.gitignore` should NOT include `vendor/`:

```gitignore
# Never ignore vendor in a Tanka project
# vendor/ is intentionally committed

# Ignore generated output
rendered/
*.yaml.tmp
```

---

## CI/CD Integration

### GitHub Actions Pipeline

```yaml
# .github/workflows/tanka.yaml
name: Tanka

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

env:
  TK_VERSION: "0.26.0"

jobs:
  validate:
    name: Validate Jsonnet
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4

      - name: Install Tanka
        run: |
          curl -fsSL "https://github.com/grafana/tanka/releases/download/v${TK_VERSION}/tk-linux-amd64" \
            -o /usr/local/bin/tk
          chmod +x /usr/local/bin/tk

      - name: Install jsonnet-bundler
        run: go install github.com/jsonnet-bundler/jsonnet-bundler/cmd/jb@latest

      - name: Install dependencies
        run: jb install

      - name: Lint Jsonnet
        run: |
          find environments lib -name "*.jsonnet" -o -name "*.libsonnet" \
            | xargs -I{} tk fmt --test {}

      - name: Show all environments (compilation check)
        run: |
          for env in environments/*/; do
            echo "==> Checking $env"
            tk show "$env" > /dev/null
          done

  diff:
    name: Diff against cluster
    runs-on: ubuntu-24.04
    if: github.event_name == 'pull_request'
    environment: production-readonly
    steps:
      - uses: actions/checkout@v4

      - name: Configure kubectl
        uses: azure/k8s-set-context@v4
        with:
          kubeconfig: ${{ secrets.KUBECONFIG_PRODUCTION }}

      - name: Install Tanka
        run: |
          curl -fsSL "https://github.com/grafana/tanka/releases/download/v${TK_VERSION}/tk-linux-amd64" \
            -o /usr/local/bin/tk
          chmod +x /usr/local/bin/tk

      - name: Diff production
        run: tk diff environments/production

  apply:
    name: Apply to production
    runs-on: ubuntu-24.04
    needs: [validate]
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    environment: production
    steps:
      - uses: actions/checkout@v4

      - name: Configure kubectl
        uses: azure/k8s-set-context@v4
        with:
          kubeconfig: ${{ secrets.KUBECONFIG_PRODUCTION }}

      - name: Install Tanka
        run: |
          curl -fsSL "https://github.com/grafana/tanka/releases/download/v${TK_VERSION}/tk-linux-amd64" \
            -o /usr/local/bin/tk
          chmod +x /usr/local/bin/tk

      - name: Apply production
        run: tk apply --dangerous-auto-approve environments/production
```

### Export-and-Apply GitOps Pattern

For ArgoCD or Flux, pre-render YAML in CI and commit to a separate `rendered/` branch:

```bash
#!/usr/bin/env bash
# scripts/export-rendered.sh
set -euo pipefail

RENDERED_DIR="rendered"
rm -rf "${RENDERED_DIR}"

for env in environments/*/; do
  name=$(basename "${env}")
  mkdir -p "${RENDERED_DIR}/${name}"
  tk export "${RENDERED_DIR}/${name}" "${env}"
  echo "Exported ${name}: $(find "${RENDERED_DIR}/${name}" -name "*.yaml" | wc -l) files"
done
```

---

## Comparison with Helm and Kustomize

### Capability Matrix

| Feature | Helm | Kustomize | Tanka/Jsonnet |
|---|---|---|---|
| Templating language | Go templates | None (patch-based) | Jsonnet (full language) |
| Reusable abstractions | Chart library | Bases + patches | Libsonnet functions |
| Multi-environment | Values files | Overlays | Environment dirs + params |
| Third-party packages | Chart repos | Bases from git | jsonnet-bundler |
| Diff before apply | helm diff plugin | kubectl diff | tk diff (built-in) |
| Secret management | External (SOPS, ESO) | External | External (SOPS, ESO) |
| Learning curve | Low-Medium | Low | Medium-High |
| Output traceability | Difficult | Clear | Excellent (deterministic) |
| Helm chart reuse | Native | Via HelmRelease | tanka-helm import |

### When to Choose Tanka

Tanka works best when:

- Configuration complexity exceeds what Go templates can express cleanly
- Multiple environments share significant structure with controlled variation
- The team is comfortable with a functional programming approach
- Dashboard-as-code and config-as-code need to coexist in one repository
- Deterministic, auditable output is a hard requirement

Helm remains the better default for distributing software to external consumers. Kustomize is appropriate for teams that want minimal tooling and primarily manage variation through strategic merge patches.

---

## Production Usage Patterns

### Large-Scale Library Organisation

At scale, organise `lib/` to mirror your platform's logical layers:

```
lib/
├── k.libsonnet           # k8s-libsonnet alias
├── platform/
│   ├── app.libsonnet     # application component constructor
│   ├── database.libsonnet# database sidecar and init container patterns
│   ├── ingress.libsonnet # ingress + cert-manager certificate
│   └── rbac.libsonnet    # ServiceAccount + Role + RoleBinding
├── observability/
│   ├── servicemonitor.libsonnet
│   ├── prometheusrule.libsonnet
│   └── dashboards/
└── policy/
    ├── networkpolicy.libsonnet
    └── poddisruptionbudget.libsonnet
```

### Tracking Image Tags with External Variables

Pass image tags as external variables to keep Jsonnet code separate from CI pipeline output:

```jsonnet
// environments/production/main.jsonnet
local images = {
  api:     std.extVar("API_IMAGE"),
  worker:  std.extVar("WORKER_IMAGE"),
  gateway: std.extVar("GATEWAY_IMAGE"),
};

local platform = import "../../lib/platform.libsonnet";

platform.resources({ images: images, replicas: 3 })
```

```bash
# Apply with image tags injuted from CI environment
tk apply environments/production \
  --ext-str API_IMAGE="registry.example.com/api:v2.4.1" \
  --ext-str WORKER_IMAGE="registry.example.com/worker:v2.4.1" \
  --ext-str GATEWAY_IMAGE="registry.example.com/gateway:v1.9.0"
```

### Validating Output

Add a validation step that parses the exported YAML through kubeval or kubeconform:

```bash
#!/usr/bin/env bash
# scripts/validate.sh
set -euo pipefail

tk export /tmp/tanka-export environments/production

find /tmp/tanka-export -name "*.yaml" | xargs kubeconform \
  -kubernetes-version 1.29.0 \
  -strict \
  -summary \
  -schema-location default \
  -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'

echo "Validation passed"
```

---

## Troubleshooting

### Common Errors and Solutions

**`RUNTIME ERROR: Field does not exist: xxx`**

Jsonnet field access on a missing key raises a runtime error. Use `std.objectHas` to guard optional fields:

```jsonnet
local port = if std.objectHas(params, "port") then params.port else 8080;
```

**`Cyclic dependency`**

Circular imports between `.libsonnet` files cause this error. Resolve by extracting shared types into a separate file imported by both.

**`tk diff` shows unexpected deletions**

Check the namespace in `spec.json` matches the namespace in your resource metadata. Tanka scopes diffs to the configured namespace by default.

**Evaluation is slow on large environments**

Add `--jpath` flags to avoid re-scanning the full vendor tree. For very large projects, split into multiple Tanka environments and apply them independently.

**`jsonnet-bundler` checksum mismatch**

Delete `vendor/` and re-run `jb install`. This typically occurs after manually editing `jsonnetfile.lock.json`.

---

## Summary

Tanka and Jsonnet provide a production-grade alternative to Helm templating and Kustomize patching for teams that need full programmatic control over Kubernetes manifests. The combination of Jsonnet's deterministic evaluation, k8s-libsonnet's typed constructors, and Tanka's environment management produces configurations that are easier to test, diff, and reason about at scale than equivalent Helm charts.

The key discipline is investing in a well-structured `lib/` layer early — once the platform abstractions stabilise, adding new environments, components, or dashboard definitions becomes a matter of composing existing functions rather than copying YAML files.
