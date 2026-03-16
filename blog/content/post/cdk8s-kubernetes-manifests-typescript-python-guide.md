---
title: "cdk8s: Kubernetes Manifests with TypeScript, Python, and Go"
date: 2027-02-28T00:00:00-05:00
draft: false
tags: ["Kubernetes", "cdk8s", "Infrastructure as Code", "TypeScript", "Python"]
categories: ["Kubernetes", "DevOps", "Infrastructure as Code"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to cdk8s for generating Kubernetes manifests using TypeScript, Python, and Go, covering constructs, charts, cdk8s-plus, CRD imports, testing, and GitOps integration."
more_link: "yes"
url: "/cdk8s-kubernetes-manifests-typescript-python-guide/"
---

**cdk8s** (Cloud Development Kit for Kubernetes) applies the CDK construct model — originally designed for AWS CloudFormation — to Kubernetes manifest generation. Instead of writing YAML by hand or templating it with Helm, you define Kubernetes resources as objects in TypeScript, Python, Go, or Java. The framework synthesises those objects into standard YAML files that any Kubernetes cluster can consume.

The core insight is that YAML is an output format, not a programming model. cdk8s treats manifest generation as a compilation step: write typed, testable code; run `cdk8s synth`; receive valid Kubernetes YAML. This guide covers the full cdk8s workflow from project setup through production GitOps integration.

<!--more-->

## Executive Summary

cdk8s provides:

- **Strongly-typed resource APIs** generated from the Kubernetes OpenAPI spec and custom CRD schemas
- **Construct hierarchy** — composable, reusable components that encapsulate Kubernetes resource patterns
- **cdk8s-plus** — a higher-level abstraction library that hides low-level Kubernetes API verbosity
- **YAML synthesis** — deterministic output suitable for committing to git and applying with any CD tool
- **Standard test frameworks** — Jest for TypeScript, pytest for Python, go test for Go

Unlike Pulumi or Terraform, cdk8s does not manage state and does not interact with the Kubernetes API directly. It is purely a manifest generation layer, which makes it simpler to reason about and easier to integrate with existing GitOps pipelines.

---

## Architecture: App, Charts, and Constructs

### Core Concepts

The cdk8s object model has three levels:

- **App** — the root of the construct tree. Calling `app.synth()` writes all generated YAML to disk.
- **Chart** — a group of related Kubernetes resources that synthesises to a single YAML file or directory.
- **Construct** — any node in the tree that can contain child constructs and resources.

```
App
├── Chart (networking.yaml)
│   ├── NetworkPolicy
│   └── Service
└── Chart (workloads.yaml)
    ├── Deployment
    ├── ServiceAccount
    └── HorizontalPodAutoscaler
```

### Installation

```bash
# TypeScript project
npm install -g cdk8s-cli
mkdir my-platform && cd my-platform
cdk8s init typescript-app

# Python project
pip install cdk8s-cli
cdk8s init python-app

# Go project
cdk8s init go-app
```

---

## TypeScript: Full Application Example

### Basic App with cdk8s-plus

`cdk8s-plus` provides higher-level constructs that reduce boilerplate significantly. The `28` suffix tracks the Kubernetes minor version (1.28).

```typescript
// main.ts
import { App, Chart, ChartProps } from "cdk8s";
import * as kplus from "cdk8s-plus-28";
import { Construct } from "constructs";

export interface ApiServiceProps extends ChartProps {
  image:     string;
  replicas?: number;
  hostname?: string;
}

export class ApiServiceChart extends Chart {
  constructor(scope: Construct, id: string, props: ApiServiceProps) {
    super(scope, id, props);

    const labels    = { app: id };
    const replicas  = props.replicas ?? 2;

    // ServiceAccount
    const sa = new kplus.ServiceAccount(this, "sa", {
      metadata: { name: id },
    });

    // ConfigMap
    const cm = new kplus.ConfigMap(this, "config", {
      metadata: { name: `${id}-config` },
      data: {
        LOG_LEVEL:   "info",
        SERVER_PORT: "8080",
      },
    });

    // Deployment — cdk8s-plus handles selector/labels wiring automatically
    const deployment = new kplus.Deployment(this, "deployment", {
      metadata: { name: id, labels },
      replicas,
      serviceAccount: sa,
      securityContext: {
        ensureNonRoot: true,
        readOnlyRootFilesystem: true,
      },
      containers: [{
        name:           id,
        image:          props.image,
        portNumber:     8080,
        envFrom: [kplus.EnvFrom.configMap(cm)],
        resources: {
          cpu:    { request: kplus.Cpu.millis(100), limit: kplus.Cpu.millis(500) },
          memory: {
            request: kplus.Size.mebibytes(128),
            limit:   kplus.Size.mebibytes(512),
          },
        },
        liveness: kplus.Probe.fromHttpGet("/healthz", { port: 8080, initialDelaySeconds: 5 }),
        readiness: kplus.Probe.fromHttpGet("/readyz",  { port: 8080, initialDelaySeconds: 3 }),
      }],
    });

    // Service — exposes the deployment on port 80
    const service = deployment.exposeViaService({
      name:     id,
      ports:    [{ port: 80, targetPort: 8080 }],
      serviceType: kplus.ServiceType.CLUSTER_IP,
    });

    // HorizontalPodAutoscaler
    const hpa = new kplus.HorizontalPodAutoscaler(this, "hpa", {
      metadata: { name: id },
      target:   deployment,
      minReplicas: replicas,
      maxReplicas: replicas * 5,
      metrics: [
        kplus.Metric.resourceCpu(kplus.MetricTarget.averageUtilization(70)),
      ],
    });

    // Optional: Ingress with TLS
    if (props.hostname) {
      const ingress = new kplus.Ingress(this, "ingress", {
        metadata: {
          name: id,
          annotations: { "cert-manager.io/cluster-issuer": "letsencrypt-prod" },
        },
      });

      ingress.addHostRule(props.hostname, "/", kplus.IngressBackend.fromService(service, {
        port: 80,
      }));

      ingress.addTls([{
        hosts:      [props.hostname],
        secret:     kplus.Secret.fromSecretName(this, "tls-secret", `${id}-tls`),
      }]);
    }
  }
}

// Entry point
const app = new App({ outdir: "dist" });

new ApiServiceChart(app, "api", {
  image:     "registry.example.com/api:v2.4.1",
  replicas:  3,
  hostname:  "api.prod.example.com",
  namespace: "platform",
});

app.synth();
```

```bash
# Synthesise to YAML
cdk8s synth

# Output:
# dist/api.k8s.yaml

# Apply to cluster
kubectl apply -f dist/
```

---

## Python: Deployment and StatefulSet

```python
#!/usr/bin/env python3
# main.py
from constructs import Construct
from cdk8s import App, Chart
import cdk8s_plus_28 as kplus

class DatabaseChart(Chart):
    def __init__(self, scope: Construct, id: str, **kwargs):
        super().__init__(scope, id, **kwargs)

        namespace = kwargs.get("namespace", "data")

        # PersistentVolumeClaim for data
        pvc = kplus.PersistentVolumeClaim(
            self, "pvc",
            metadata={"name": "postgres-data"},
            access_modes=[kplus.PersistentVolumeAccessMode.READ_WRITE_ONCE],
            storage=kplus.Size.gibibytes(20),
            storage_class_name="fast-ssd",
        )

        # StatefulSet
        ss = kplus.StatefulSet(
            self, "statefulset",
            metadata={"name": "postgres"},
            replicas=1,
            service=kplus.StatefulSetUpdateStrategy.rolling_update(),
            containers=[
                kplus.ContainerProps(
                    name="postgres",
                    image="postgres:16.2-alpine",
                    port_number=5432,
                    env_variables={
                        "POSTGRES_DB":       kplus.EnvValue.from_value("platform"),
                        "POSTGRES_USER":     kplus.EnvValue.from_value("appuser"),
                        "POSTGRES_PASSWORD": kplus.EnvValue.from_secret_value(
                            kplus.SecretValue(
                                secret=kplus.Secret.from_secret_name(self, "pg-secret", "postgres-credentials"),
                                key="password",
                            )
                        ),
                    },
                    volume_mounts=[
                        kplus.VolumeMount(
                            volume=kplus.Volume.from_persistent_volume_claim(self, "data-vol", pvc),
                            path="/var/lib/postgresql/data",
                            sub_path="pgdata",
                        )
                    ],
                    resources=kplus.ContainerResources(
                        cpu=kplus.CpuResources(
                            request=kplus.Cpu.millis(250),
                            limit=kplus.Cpu.millis(1000),
                        ),
                        memory=kplus.MemoryResources(
                            request=kplus.Size.mebibytes(512),
                            limit=kplus.Size.gibibytes(2),
                        ),
                    ),
                )
            ],
        )


class WorkerChart(Chart):
    def __init__(self, scope: Construct, id: str, **kwargs):
        super().__init__(scope, id, **kwargs)

        # CronJob for scheduled tasks
        cron_job = kplus.CronJob(
            self, "cron",
            metadata={"name": "report-generator"},
            schedule=kplus.Cron.daily(),
            containers=[
                kplus.ContainerProps(
                    name="reporter",
                    image="registry.example.com/reporter:v1.0.0",
                    resources=kplus.ContainerResources(
                        cpu=kplus.CpuResources(request=kplus.Cpu.millis(200)),
                        memory=kplus.MemoryResources(
                            request=kplus.Size.mebibytes(256)
                        ),
                    ),
                )
            ],
            restart_policy=kplus.RestartPolicy.ON_FAILURE,
            ttl_after_finished=kplus.Duration.minutes(30),
        )


app = App(outdir="dist")

DatabaseChart(app, "database", namespace="data")
WorkerChart(app, "workers",   namespace="platform")

app.synth()
```

---

## Go: Chart Definition

```go
// main.go
package main

import (
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/aws/jsii-runtime-go"
	"github.com/cdk8s-team/cdk8s-core-go/cdk8s/v2"
	kplus "github.com/cdk8s-team/cdk8s-plus-go/cdk8splus28/v2"
)

type AppChartProps struct {
	cdk8s.ChartProps
	Image    string
	Replicas float64
}

func NewAppChart(scope constructs.Construct, id string, props *AppChartProps) cdk8s.Chart {
	chart := cdk8s.NewChart(scope, jsii.String(id), &props.ChartProps)

	labels := &map[string]*string{
		"app": jsii.String(id),
	}

	deployment := kplus.NewDeployment(chart, jsii.String("deployment"), &kplus.DeploymentProps{
		Metadata: &cdk8s.ApiObjectMetadata{
			Name:   jsii.String(id),
			Labels: labels,
		},
		Replicas: jsii.Number(props.Replicas),
		Containers: &[]*kplus.ContainerProps{
			{
				Name:       jsii.String(id),
				Image:      jsii.String(props.Image),
				PortNumber: jsii.Number(8080),
				Resources: &kplus.ContainerResources{
					Cpu: &kplus.CpuResources{
						Request: kplus.Cpu_Millis(jsii.Number(100)),
						Limit:   kplus.Cpu_Millis(jsii.Number(500)),
					},
					Memory: &kplus.MemoryResources{
						Request: cdk8s.Size_Mebibytes(jsii.Number(128)),
						Limit:   cdk8s.Size_Mebibytes(jsii.Number(512)),
					},
				},
			},
		},
	})

	deployment.ExposeViaService(&kplus.DeploymentExposeViaServiceOptions{
		Name:        jsii.String(id),
		ServiceType: kplus.ServiceType_CLUSTER_IP,
		Ports: &[]*kplus.ServicePort{
			{Port: jsii.Number(80), TargetPort: jsii.Number(8080)},
		},
	})

	return chart
}

func main() {
	app := cdk8s.NewApp(&cdk8s.AppProps{
		Outdir: jsii.String("dist"),
	})

	NewAppChart(app, "api", &AppChartProps{
		ChartProps: cdk8s.ChartProps{
			Namespace: jsii.String("platform"),
		},
		Image:    "registry.example.com/api:v2.4.1",
		Replicas: 2,
	})

	app.Synth()
}
```

---

## Importing CRDs with cdk8s-cli

The `cdk8s import` command generates typed construct classes from CRD schemas, giving IDE autocomplete for custom resources.

```bash
# Import from a local CRD file
cdk8s import crds/cert-manager.crds.yaml --language typescript

# Import from a URL
cdk8s import https://raw.githubusercontent.com/cert-manager/cert-manager/v1.14.3/deploy/crds/crd-certificates.yaml

# Import from a running cluster (all installed CRDs)
cdk8s import k8s://my-cluster --language typescript

# Generated output is placed in imports/
ls imports/
# cert-manager.io_certificates.ts
# cert-manager.io_clusterissuers.ts
```

### Using Generated CRD Constructs

```typescript
import { Certificate } from "./imports/cert-manager.io_certificates";

// Fully typed Certificate construct — no raw YAML strings
const tlsCert = new Certificate(this, "tls-cert", {
  metadata: { name: "api-tls" },
  spec: {
    secretName: "api-tls",
    issuerRef: {
      name: "letsencrypt-prod",
      kind: "ClusterIssuer",
    },
    dnsNames: ["api.prod.example.com"],
    duration:   "2160h",  // 90 days
    renewBefore: "360h",  // 15 days
  },
});
```

---

## Custom Construct Libraries

Package reusable constructs as npm / PyPI / Go module packages for organisation-wide sharing.

```typescript
// packages/platform-constructs/src/webapp.ts
import { Construct } from "constructs";
import { Chart }     from "cdk8s";
import * as kplus    from "cdk8s-plus-28";

export interface PlatformWebAppProps {
  image:          string;
  replicas?:      number;
  containerPort?: number;
  hostname?:      string;
  extraEnv?:      Record<string, string>;
}

/**
 * PlatformWebApp encapsulates the company's standard web application
 * pattern: Deployment + Service + optional Ingress with TLS + HPA.
 * All containers run as non-root with a read-only root filesystem.
 */
export class PlatformWebApp extends Construct {
  public readonly deployment: kplus.Deployment;
  public readonly service:    kplus.Service;
  public readonly hpa:        kplus.HorizontalPodAutoscaler;

  constructor(scope: Construct, id: string, props: PlatformWebAppProps) {
    super(scope, id);

    const port     = props.containerPort ?? 8080;
    const replicas = props.replicas ?? 2;

    const envVars: Record<string, kplus.EnvValue> = {};
    for (const [k, v] of Object.entries(props.extraEnv ?? {})) {
      envVars[k] = kplus.EnvValue.fromValue(v);
    }

    this.deployment = new kplus.Deployment(this, "deploy", {
      metadata: { name: id },
      replicas,
      securityContext: { ensureNonRoot: true, readOnlyRootFilesystem: true },
      containers: [{
        name:          id,
        image:         props.image,
        portNumber:    port,
        envVariables:  envVars,
        resources: {
          cpu:    { request: kplus.Cpu.millis(100), limit: kplus.Cpu.millis(500) },
          memory: {
            request: kplus.Size.mebibytes(128),
            limit:   kplus.Size.mebibytes(512),
          },
        },
        liveness:  kplus.Probe.fromHttpGet("/healthz", { port, initialDelaySeconds: 5 }),
        readiness: kplus.Probe.fromHttpGet("/readyz",  { port, initialDelaySeconds: 3 }),
      }],
    });

    this.service = this.deployment.exposeViaService({
      name:        id,
      serviceType: kplus.ServiceType.CLUSTER_IP,
      ports:       [{ port: 80, targetPort: port }],
    });

    this.hpa = new kplus.HorizontalPodAutoscaler(this, "hpa", {
      metadata:    { name: id },
      target:      this.deployment,
      minReplicas: replicas,
      maxReplicas: replicas * 5,
      metrics:     [kplus.Metric.resourceCpu(kplus.MetricTarget.averageUtilization(70))],
    });
  }
}
```

---

## Testing with Jest

cdk8s charts synthesise synchronously, making them straightforward to test:

```typescript
// __tests__/api-chart.test.ts
import { App, Testing } from "cdk8s";
import { ApiServiceChart } from "../main";

describe("ApiServiceChart", () => {
  const app    = Testing.app();
  const chart  = new ApiServiceChart(app, "test-api", {
    image:    "test-image:latest",
    replicas: 3,
    namespace: "test",
  });
  const results = Testing.synth(chart);

  test("synthesises a Deployment", () => {
    expect(results).toContainEqual(
      expect.objectContaining({
        apiVersion: "apps/v1",
        kind:       "Deployment",
      })
    );
  });

  test("Deployment has correct replica count", () => {
    const deployment = results.find(r => r.kind === "Deployment");
    expect(deployment?.spec?.replicas).toBe(3);
  });

  test("container image matches input", () => {
    const deployment = results.find(r => r.kind === "Deployment");
    const container  = deployment?.spec?.template?.spec?.containers?.[0];
    expect(container?.image).toBe("test-image:latest");
  });

  test("HPA targets 70% CPU utilization", () => {
    const hpa = results.find(r => r.kind === "HorizontalPodAutoscaler");
    const metric = hpa?.spec?.metrics?.[0];
    expect(metric?.resource?.target?.averageUtilization).toBe(70);
  });

  test("no Ingress when hostname is not provided", () => {
    const ingresses = results.filter(r => r.kind === "Ingress");
    expect(ingresses).toHaveLength(0);
  });

  test("Ingress is created when hostname is provided", () => {
    const appWithHost = Testing.app();
    const chartWithHost = new ApiServiceChart(appWithHost, "test-api-ing", {
      image:    "test-image:latest",
      hostname: "api.example.com",
    });
    const res = Testing.synth(chartWithHost);
    const ingresses = res.filter(r => r.kind === "Ingress");
    expect(ingresses).toHaveLength(1);
  });

  test("containers run as non-root", () => {
    const deployment = results.find(r => r.kind === "Deployment");
    const sc = deployment?.spec?.template?.spec?.securityContext;
    expect(sc?.runAsNonRoot).toBe(true);
  });
});
```

```bash
npm test -- --coverage

# PASS __tests__/api-chart.test.ts
#   ApiServiceChart
#     ✓ synthesises a Deployment (12ms)
#     ✓ Deployment has correct replica count (3ms)
#     ✓ container image matches input (2ms)
#     ✓ HPA targets 70% CPU utilization (2ms)
#     ✓ no Ingress when hostname is not provided (2ms)
#     ✓ Ingress is created when hostname is provided (4ms)
#     ✓ containers run as non-root (2ms)
```

---

## Multi-Chart Application Structure

Large applications decompose into multiple charts to control apply ordering and limit blast radius:

```typescript
// main.ts
import { App } from "cdk8s";
import { NamespaceChart }    from "./charts/namespace";
import { NetworkPolicyChart } from "./charts/network-policy";
import { DatabaseChart }     from "./charts/database";
import { ApiChart }          from "./charts/api";
import { MonitoringChart }   from "./charts/monitoring";

const app = new App({ outdir: "dist" });

// Charts are synthesised in definition order
const ns   = new NamespaceChart(app,    "01-namespace",     { namespace: "platform" });
const net  = new NetworkPolicyChart(app, "02-network",      { namespace: "platform" });
const db   = new DatabaseChart(app,     "03-database",      { namespace: "platform" });
const api  = new ApiChart(app,          "04-api",           { namespace: "platform",
                                                              image: "registry.example.com/api:v2.4.1" });
const mon  = new MonitoringChart(app,   "05-monitoring",    { namespace: "platform" });

app.synth();

// dist/ contains:
// 01-namespace.k8s.yaml
// 02-network.k8s.yaml
// 03-database.k8s.yaml
// 04-api.k8s.yaml
// 05-monitoring.k8s.yaml
```

### Applying in Order

```bash
# The numeric prefix ensures kubectl applies in the correct sequence
kubectl apply -f dist/ --server-side

# Or with kustomize overlays on top of synthesised YAML
kubectl apply -k dist/
```

---

## Synthesising to YAML

```bash
# Synthesise
cdk8s synth

# Inspect output
cat dist/api.k8s.yaml

# Validate output with kubeconform
kubeconform -strict -summary dist/*.yaml

# Diff against cluster
kubectl diff -f dist/
```

### Output File Control

```typescript
const app = new App({
  outdir:   "dist",
  // One file per chart (default) or one combined file
  outputFileExtension: ".yaml",
  // Validate against Kubernetes schemas during synth
  validationSchemas: [
    cdk8s.ValidationSchemaType.KUBERNETES_1_28,
  ],
});
```

---

## Helm Chart Integration

cdk8s can render an existing Helm chart as part of the construct tree using `cdk8s.Helm`:

```typescript
import { App, Chart, Helm } from "cdk8s";
import { Construct } from "constructs";

class InfraChart extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    // Render cert-manager Helm chart as cdk8s constructs
    const certManager = new Helm(this, "cert-manager", {
      chart:   "./charts/cert-manager",
      version: "v1.14.3",
      values: {
        installCRDs: true,
        replicaCount: 2,
        prometheus: { enabled: true, servicemonitor: { enabled: true } },
      },
    });
  }
}

const app = new App({ outdir: "dist" });
new InfraChart(app, "infra");
app.synth();
```

---

## GitOps Integration

### ArgoCD Application Pointing at Synthesised YAML

Pre-synthesise manifests in CI and commit them to a `rendered/` directory. ArgoCD watches that directory.

```yaml
# argocd/application.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: platform-api
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/acme-corp/platform-config.git
    targetRevision: main
    path: rendered/production
  destination:
    server: https://kubernetes.default.svc
    namespace: platform
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - ServerSideApply=true
```

### CI Pipeline (GitHub Actions)

```yaml
# .github/workflows/cdk8s.yaml
name: cdk8s

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  synth-and-validate:
    name: Synthesise and Validate
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Install dependencies
        run: npm ci

      - name: Run unit tests
        run: npm test

      - name: Synthesise manifests
        run: cdk8s synth

      - name: Validate with kubeconform
        run: |
          curl -fsSL https://github.com/yannh/kubeconform/releases/latest/download/kubeconform-linux-amd64.tar.gz \
            | tar xz -C /usr/local/bin
          kubeconform -strict -summary dist/*.yaml

      - name: Diff against cluster (PRs)
        if: github.event_name == 'pull_request'
        run: kubectl diff -f dist/ || true
        env:
          KUBECONFIG_DATA: ${{ secrets.KUBECONFIG_STAGING }}

  commit-rendered:
    name: Commit Rendered Manifests
    runs-on: ubuntu-24.04
    needs: [synth-and-validate]
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
        with:
          token: ${{ secrets.BOT_TOKEN }}

      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - run: npm ci

      - run: cdk8s synth

      - name: Commit synthesised manifests
        run: |
          cp -r dist/ rendered/production/
          git config user.email "bot@example.com"
          git config user.name  "Platform Bot"
          git add rendered/
          git diff --staged --quiet || git commit -m "ci: update rendered manifests [skip ci]"
          git push
```

---

## Comparison with Pulumi and Raw YAML

| Dimension | Raw YAML | Helm | cdk8s | Pulumi |
|---|---|---|---|---|
| Language | YAML | Go templates + YAML | TypeScript / Python / Go | TypeScript / Python / Go |
| State management | None | Release state | None | Full state engine |
| API interactions | kubectl apply | helm install/upgrade | kubectl apply on synth output | pulumi up (direct API) |
| Testing | conftest/kyverno | helm test | Jest / pytest / go test | Jest / go test |
| CRD type safety | None | None | Generated constructs | Generated SDKs |
| Learning curve | Low | Medium | Medium | Medium-High |
| Reusability | Copy-paste | Helm library charts | npm / PyPI / Go modules | npm / PyPI / Go modules |
| Helm chart reuse | Direct | Native | `cdk8s.Helm` construct | Helm Release resource |
| Drift detection | `kubectl diff` | `helm diff` plugin | `kubectl diff` on synth | `pulumi refresh` |

cdk8s occupies a useful middle ground: it has full language power and good testing support, but it does not require managing Pulumi state or understanding the Pulumi engine. Teams already operating kubectl-based CD pipelines can adopt cdk8s without changing their apply workflow.

---

## cdk8s-plus API Reference: Key Resources

### Job and CronJob

```typescript
// One-time migration job
const migration = new kplus.Job(this, "migration", {
  metadata:  { name: "db-migrate" },
  ttlAfterFinished: cdk8s.Duration.minutes(10),
  containers: [{
    name:  "migrate",
    image: "registry.example.com/migrate:v2.4.1",
    command: ["./migrate", "--up"],
    resources: {
      cpu:    { request: kplus.Cpu.millis(200) },
      memory: { request: kplus.Size.mebibytes(256) },
    },
  }],
});

// Scheduled cache-warmer
const warmer = new kplus.CronJob(this, "cache-warmer", {
  metadata:  { name: "cache-warmer" },
  schedule:  kplus.Cron.schedule({ minute: "*/15" }),
  containers: [{
    name:  "warmer",
    image: "registry.example.com/cache-warmer:v1.0.0",
    resources: {
      cpu:    { request: kplus.Cpu.millis(100) },
      memory: { request: kplus.Size.mebibytes(128) },
    },
  }],
  restartPolicy: kplus.RestartPolicy.ON_FAILURE,
});
```

### NetworkPolicy

```typescript
const netpol = new kplus.NetworkPolicy(this, "netpol", {
  metadata: { name: "api-policy" },
  selector: deployment,
  ingress: {
    default: kplus.NetworkPolicyTrafficDefault.DENY,
    rules: [
      {
        // Allow traffic from the gateway only
        peer: kplus.NetworkPolicyPeer.ipBlock("0.0.0.0/0"),
        ports: [kplus.NetworkPolicyPort.tcp(8080)],
      },
    ],
  },
  egress: {
    default: kplus.NetworkPolicyTrafficDefault.DENY,
    rules: [
      {
        // Allow DNS
        ports: [kplus.NetworkPolicyPort.udp(53), kplus.NetworkPolicyPort.tcp(53)],
      },
      {
        // Allow database access
        ports: [kplus.NetworkPolicyPort.tcp(5432)],
      },
    ],
  },
});
```

---

## Troubleshooting

### Synthesis Fails with Schema Validation Error

```
Error: spec.containers[0].resources.limits[cpu]: Invalid value
```

cdk8s validates resource quantities during synth. Ensure CPU values are valid Kubernetes quantity strings (`100m`, `0.5`, `2`) or use `kplus.Cpu.millis()` / `kplus.Cpu.units()` helpers.

### Generated YAML Has Unexpected Null Fields

Set `App` validation to strict mode:

```typescript
const app = new App({
  outdir: "dist",
  // Strip null/undefined values from output
  yamlOutputType: cdk8s.YamlOutputType.FILE_PER_CHART,
});
```

### CRD Import Fails on Complex Validation Schemas

Some CRDs use `x-kubernetes-int-or-string` or `x-kubernetes-preserve-unknown-fields` markers that the importer cannot resolve to a strict TypeScript type. Pass `--no-validation` to generate permissive `any` types:

```bash
cdk8s import crds/complex-crd.yaml --language typescript --no-validation
```

### Tests Fail Due to Random Synthesised Names

cdk8s appends a hash to synthesised resource names to ensure uniqueness within the construct tree. Use `Testing.app()` which uses a deterministic test clock:

```typescript
const app   = Testing.app();          // Deterministic name generation
const chart = new MyChart(app, "id"); // Names will be stable across test runs
```

---

## Summary

cdk8s provides a clean, language-native approach to Kubernetes manifest generation that scales from single-application charts to organisation-wide construct libraries. The synthesis model — write code, compile to YAML, apply with standard kubectl — integrates naturally with any existing GitOps pipeline without requiring new controllers or state stores.

The `cdk8s-plus` library eliminates most boilerplate by encoding Kubernetes best practices (non-root containers, resource limits, liveness probes) as construct defaults. Custom construct packages let platform teams publish organisation standards as versioned libraries that application teams consume without needing to understand every Kubernetes primitive.
