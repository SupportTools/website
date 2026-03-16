---
title: "Brigade: Event-Driven Scripting for Kubernetes CI/CD"
date: 2027-03-01T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Brigade", "CI/CD", "Event-Driven", "Scripting"]
categories: ["Kubernetes", "DevOps", "CI/CD"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Brigade v2 for event-driven Kubernetes CI/CD, covering architecture, project CRDs, TypeScript scripting, gateways, secret management, RBAC, and production deployment patterns."
more_link: "yes"
url: "/brigade-kubernetes-event-driven-scripting-guide/"
---

Most CI/CD systems treat Kubernetes as a deployment target. **Brigade** inverts this: Kubernetes is the CI/CD runtime. Brigade runs entirely inside a cluster, dispatching event-driven pipelines as native Kubernetes jobs. Scripts are written in TypeScript or JavaScript using the Brigade SDK, and every pipeline step executes in a container of your choosing — there are no proprietary agents or runner binaries to maintain.

This guide covers Brigade v2 architecture, Project and Event CRDs, the TypeScript SDK, event source gateways, secret management, RBAC, monitoring, and deployment patterns for production workloads.

<!--more-->

## Executive Summary

Brigade v2 is a complete rewrite of the original Brigade that introduces a proper API server, persistent event storage, and a formal project model. Key characteristics:

- **All Kubernetes native**: Projects, Events, and Workers are Kubernetes custom resources
- **Polyglot scripting**: Any language that can produce a Brigade worker container is supported; the official SDK is TypeScript
- **Gateway extensibility**: New event sources (Slack, Jira, custom webhooks) are added as independent gateway deployments
- **Strong RBAC**: Projects are first-class security boundaries; access to events and secrets is scoped per project
- **Persistent audit trail**: All events and their outcomes are stored and queryable through the Brigade API

Brigade excels in environments where the CI/CD logic is complex, highly conditional, or tightly integrated with cluster state. For simple build-and-push pipelines, dedicated CI tools may have lower operational overhead.

---

## Brigade v2 Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Kubernetes Cluster                                                   │
│                                                                       │
│  ┌──────────────┐    ┌──────────────┐    ┌────────────────────────┐ │
│  │ GitHub       │    │ Cron         │    │ Generic Webhook        │ │
│  │ Gateway      │    │ Gateway      │    │ Gateway                │ │
│  └──────┬───────┘    └──────┬───────┘    └──────────┬─────────────┘ │
│         │                   │                       │               │
│         └───────────────────┼───────────────────────┘               │
│                             │ Events                                 │
│                    ┌────────▼────────┐                               │
│                    │  Brigade        │                               │
│                    │  API Server     │◄──── brig CLI                │
│                    └────────┬────────┘                               │
│                             │                                         │
│                    ┌────────▼────────┐                               │
│                    │  Brigade        │                               │
│                    │  Scheduler      │                               │
│                    └────────┬────────┘                               │
│                             │ Creates pods                            │
│               ┌─────────────┼──────────────┐                        │
│               │             │              │                        │
│         ┌─────▼─────┐ ┌─────▼─────┐ ┌─────▼─────┐                │
│         │  Worker   │ │  Worker   │ │  Worker   │                │
│         │  Pod      │ │  Pod      │ │  Pod      │                │
│         └─────┬─────┘ └─────┬─────┘ └─────┬─────┘                │
│               │             │              │                        │
│         ┌─────▼─────┐ ┌─────▼─────┐ ┌─────▼─────┐                │
│         │  Job      │ │  Job      │ │  Job      │                │
│         │  Pods     │ │  Pods     │ │  Pods     │                │
│         └───────────┘ └───────────┘ └───────────┘                │
│                                                                       │
│                    ┌────────────────┐                               │
│                    │  Brigade       │                               │
│                    │  Observer      │  (watches pod completion)     │
│                    └────────────────┘                               │
│                    ┌────────────────┐                               │
│                    │  Brigade       │                               │
│                    │  Logger        │  (aggregates pod logs)        │
│                    └────────────────┘                               │
└──────────────────────────────────────────────────────────────────────┘
```

### Core Components

**API Server** — Stores Projects, Events, and Workers in a MongoDB backend. Exposes a REST API consumed by gateways and the `brig` CLI.

**Scheduler** — Watches for pending events and creates Worker pods to process them. Manages resource quotas and concurrency limits per project.

**Observer** — Watches Worker and Job pod phase transitions and updates event status in the API. This is what propagates job success/failure back to the event record.

**Logger** — Aggregates stdout/stderr from Worker and Job pods and stores logs in a queryable format. Replaces the need to access pod logs directly.

---

## Installation via Helm

```bash
# Add the Brigade Helm repo
helm repo add brigade https://brigadecore.github.io/charts
helm repo update

# Create namespace
kubectl create namespace brigade

# Install Brigade with MongoDB backend
helm install brigade brigade/brigade \
  --namespace brigade \
  --set apiserver.host=brigade.prod.example.com \
  --set apiserver.tls.enabled=true \
  --set apiserver.tls.generateSelfSignedCert=false \
  --set apiserver.ingress.enabled=true \
  --set apiserver.ingress.ingressClassName=nginx \
  --set apiserver.ingress.hosts[0].host=brigade.prod.example.com \
  --set apiserver.ingress.tls[0].hosts[0]=brigade.prod.example.com \
  --set apiserver.ingress.tls[0].secretName=brigade-tls \
  --set mongodb.auth.rootPassword=EXAMPLE_TOKEN_REPLACE_ME \
  --wait

# Install Brigade CLI
curl -fsSL https://github.com/brigadecore/brigade/releases/latest/download/brig-linux-amd64 \
  -o /usr/local/bin/brig && chmod +x /usr/local/bin/brig

# Authenticate
brig login --server https://brigade.prod.example.com --root
```

---

## Projects

A **Project** is the Brigade equivalent of a repository/pipeline definition. It declares the event types the project handles and the default worker configuration.

### Creating a Project via CRD

```yaml
# project.yaml
apiVersion: brigade.sh/v2
kind: Project
metadata:
  name: platform-ci
  namespace: brigade
spec:
  description: "CI/CD pipeline for the platform API service"

  # Events this project subscribes to
  eventSubscriptions:
    - source: brigade.sh/github
      types:
        - push
        - pull_request

  # Default worker container config
  workerTemplate:
    defaultConfigFiles:
      brigade.ts: |
        // (inline brigade script — use git source for production)
    git:
      cloneURL: https://github.com/acme-corp/platform.git
      initSubmodules: false
    logLevel: DEBUG
    workspaceSize: 10Gi
    nodeSelector:
      kubernetes.io/os: linux
    tolerations: []
    timeoutDuration: 30m

  # Project-scoped secrets (accessed in scripts via brigadier.project.secrets)
  secrets:
    registryUsername: EXAMPLE_TOKEN_REPLACE_ME
    # Sensitive values are stored encrypted in MongoDB
```

```bash
# Apply project
kubectl apply -f project.yaml

# Or create via brig CLI
brig project create --file project.yaml

# List projects
brig project list

# Inspect a project
brig project get platform-ci
```

---

## Brigade SDK: TypeScript Scripting

The **@brigadecore/brigadier** package provides the TypeScript API for defining event handlers, running jobs, and controlling pipeline flow.

### brigade.ts File Structure

```typescript
// brigade.ts
import { events, Event, Job, ConcurrentGroup, SerialGroup } from "@brigadecore/brigadier";

// Handle GitHub push events
events.on("brigade.sh/github", "push", async (event: Event) => {
  const sha     = event.git?.commit ?? "HEAD";
  const branch  = event.git?.ref?.replace("refs/heads/", "") ?? "unknown";

  console.log(`Processing push: ${sha} on ${branch}`);

  // Run build and test serially
  await new SerialGroup(
    buildJob(event),
    testJob(event),
  ).run();

  // Run lint and security scan concurrently
  await new ConcurrentGroup(
    lintJob(event),
    scanJob(event),
  ).run();

  // Deploy only on main branch
  if (branch === "main") {
    await deployJob(event, "staging").run();
  }
});

// Handle pull request events
events.on("brigade.sh/github", "pull_request", async (event: Event) => {
  await new ConcurrentGroup(
    buildJob(event),
    lintJob(event),
    testJob(event),
    scanJob(event),
  ).run();
});

events.process();
```

### Job Definitions

```typescript
// jobs.ts
import { Event, Job } from "@brigadecore/brigadier";

const REGISTRY    = "registry.example.com";
const IMAGE_BASE  = `${REGISTRY}/platform/api`;

function buildJob(event: Event): Job {
  const job = new Job("build", "docker:24-dind", event);

  job.primaryContainer.environment = {
    DOCKER_HOST:        "tcp://localhost:2375",
    REGISTRY:           REGISTRY,
    // Secrets from the project are available as environment variables
    REGISTRY_USERNAME:  event.project.secrets.registryUsername,
    REGISTRY_PASSWORD:  event.project.secrets.registryPassword,
    GIT_SHA:            event.git?.commit ?? "dev",
  };

  job.primaryContainer.command = ["sh", "-c"];
  job.primaryContainer.arguments = [`
    docker login ${REGISTRY} -u $REGISTRY_USERNAME -p $REGISTRY_PASSWORD
    docker build -t ${IMAGE_BASE}:$GIT_SHA -t ${IMAGE_BASE}:latest .
    docker push ${IMAGE_BASE}:$GIT_SHA
    docker push ${IMAGE_BASE}:latest
  `];

  // DinD sidecar for Docker-in-Docker builds
  job.sidecarContainers.docker = {
    image: "docker:24-dind",
    privileged: true,
    environment: { DOCKER_TLS_CERTDIR: "" },
  };

  job.timeout = 1200;  // 20 minutes
  return job;
}

function testJob(event: Event): Job {
  const job = new Job("test", `${IMAGE_BASE}:${event.git?.commit ?? "latest"}`, event);

  job.primaryContainer.command   = ["go"];
  job.primaryContainer.arguments = ["test", "-v", "-race", "-coverprofile=coverage.out", "./..."];
  job.primaryContainer.environment = {
    CGO_ENABLED: "1",
    GOPROXY:     "https://proxy.golang.org,direct",
  };

  job.timeout = 600;  // 10 minutes
  return job;
}

function lintJob(event: Event): Job {
  const job = new Job("lint", "golangci/golangci-lint:v1.57", event);

  job.primaryContainer.command   = ["golangci-lint"];
  job.primaryContainer.arguments = ["run", "--timeout=5m", "./..."];

  job.timeout = 360;
  return job;
}

function scanJob(event: Event): Job {
  const job = new Job("security-scan", "aquasec/trivy:latest", event);

  job.primaryContainer.command   = ["trivy"];
  job.primaryContainer.arguments = [
    "image",
    "--exit-code", "1",
    "--severity",  "CRITICAL,HIGH",
    `${IMAGE_BASE}:${event.git?.commit ?? "latest"}`,
  ];

  job.timeout = 300;
  return job;
}

function deployJob(event: Event, environment: string): Job {
  const job = new Job(`deploy-${environment}`, "bitnami/kubectl:1.29", event);

  job.primaryContainer.environment = {
    IMAGE_TAG:   event.git?.commit ?? "latest",
    ENVIRONMENT: environment,
    KUBECONFIG:  "/home/user/.kube/config",
  };

  job.primaryContainer.command = ["sh", "-c"];
  job.primaryContainer.arguments = [`
    kubectl set image deployment/api \
      api=${IMAGE_BASE}:$IMAGE_TAG \
      -n $ENVIRONMENT
    kubectl rollout status deployment/api -n $ENVIRONMENT --timeout=5m
  `];

  // Mount kubeconfig from a Kubernetes secret
  job.primaryContainer.volumeMounts = [{
    name:      "kubeconfig",
    mountPath: "/home/user/.kube",
    readOnly:  true,
  }];

  job.volumes = [{
    name: "kubeconfig",
    secret: { secretName: `brigade-kubeconfig-${environment}` },
  }];

  job.timeout = 600;
  return job;
}

export { buildJob, testJob, lintJob, scanJob, deployJob };
```

---

## Event Source Gateways

### GitHub Gateway

The GitHub gateway converts webhook payloads into Brigade Events.

```bash
# Install GitHub gateway
helm install brigade-github-gateway brigade/brigade-github-app-gateway \
  --namespace brigade \
  --set github.appID=123456 \
  --set github.apiKey=EXAMPLE_TOKEN_REPLACE_ME \
  --set service.type=ClusterIP \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=brigade-github.prod.example.com

# Register the gateway's webhook URL in GitHub:
# https://brigade-github.prod.example.com/events
# Secret: EXAMPLE_TOKEN_REPLACE_ME (set during gateway install)
```

### Cron Gateway

The cron gateway emits scheduled events on a cron schedule:

```bash
helm install brigade-cron-gateway brigade/brigade-cron-gateway \
  --namespace brigade
```

```yaml
# cron-event.yaml
# This CRD creates a scheduled Brigade event
apiVersion: brigade.sh/v2
kind: CronEvent
metadata:
  name: nightly-build
  namespace: brigade
spec:
  schedule: "0 2 * * *"   # 02:00 UTC nightly
  event:
    source: brigade.sh/cron
    type: nightly
    projectID: platform-ci
    payload: |
      { "trigger": "scheduled", "type": "nightly" }
```

### Generic Webhook Gateway

For custom integrations (Jira, PagerDuty, internal tools):

```bash
helm install brigade-generic-gateway brigade/brigade-generic-gateway \
  --namespace brigade \
  --set tokens.mySystemToken=EXAMPLE_TOKEN_REPLACE_ME
```

Trigger an event via HTTP:

```bash
curl -X POST https://brigade-generic.prod.example.com/events \
  -H "Authorization: Bearer EXAMPLE_TOKEN_REPLACE_ME" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "acme/deploy-trigger",
    "type":   "deploy",
    "project": "platform-ci",
    "payload": "{\"image\": \"registry.example.com/api:v2.4.1\", \"env\": \"staging\"}"
  }'
```

Handle the custom event in `brigade.ts`:

```typescript
events.on("acme/deploy-trigger", "deploy", async (event: Event) => {
  const payload = JSON.parse(event.payload ?? "{}") as {
    image: string;
    env:   string;
  };

  console.log(`Deploying ${payload.image} to ${payload.env}`);

  const job = new Job("deploy", "bitnami/kubectl:1.29", event);
  job.primaryContainer.command   = ["kubectl"];
  job.primaryContainer.arguments = [
    "set", "image", "deployment/api",
    `api=${payload.image}`,
    "-n", payload.env,
  ];
  await job.run();
});
```

---

## Secret Management

### Project Secrets

Project-scoped secrets are stored encrypted in Brigade's MongoDB backend and mounted into Worker pods as environment variables:

```bash
# Set a secret on a project
brig project secret set \
  --project platform-ci \
  --set "registryPassword=EXAMPLE_TOKEN_REPLACE_ME"

# List secrets (values are masked)
brig project secret list --project platform-ci

# Delete a secret
brig project secret unset --project platform-ci --unset registryPassword
```

Access in `brigade.ts`:

```typescript
const password = event.project.secrets.registryPassword;
// event.project.secrets is a map of key → decrypted value
```

### Kubernetes Secrets for Job Pods

For secrets that need to be mounted as files (kubeconfig, TLS certificates):

```bash
# Create a Kubernetes secret in the brigade namespace
kubectl create secret generic brigade-kubeconfig-staging \
  --from-file=config=/path/to/staging-kubeconfig \
  -n brigade
```

Reference in a job:

```typescript
job.volumes = [{
  name:   "kubeconfig",
  secret: { secretName: "brigade-kubeconfig-staging" },
}];

job.primaryContainer.volumeMounts = [{
  name:      "kubeconfig",
  mountPath: "/home/user/.kube",
  readOnly:  true,
}];
```

---

## Brigade CLI (brig) Reference

```bash
# Authentication
brig login  --server https://brigade.prod.example.com
brig logout

# Projects
brig project create  --file project.yaml
brig project list
brig project get     platform-ci
brig project delete  platform-ci

# Events — manually trigger or inspect
brig event create \
  --project platform-ci \
  --source  brigade.sh/cli \
  --type    exec \
  --payload '{"manual": true}'

brig event list  --project platform-ci

# Set EVENT_ID from the output of 'brig event list'
EVENT_ID="01hv2e3f4g5h6j7k8m9n0p1q2r"

brig event get    "${EVENT_ID}"
brig event cancel "${EVENT_ID}"

# Workers and logs
brig event logs --id "${EVENT_ID}" --worker
brig event logs --id "${EVENT_ID}" --job build

# Secrets
brig project secret set   --project platform-ci --set "key=value"
brig project secret list  --project platform-ci
brig project secret unset --project platform-ci --unset key
```

---

## RBAC and Project Permissions

Brigade enforces fine-grained RBAC at the project level. Access is controlled through roles and role assignments stored in the Brigade API.

### Built-in Roles

| Role | Capabilities |
|---|---|
| `PROJECT_ADMIN` | Full control: manage secrets, update project config, cancel events |
| `PROJECT_DEVELOPER` | Read events and logs, trigger events |
| `PROJECT_USER` | Read events and logs only |

### Assigning Roles

```bash
# Grant a service account developer access to a project
brig role grant PROJECT_DEVELOPER \
  --project platform-ci \
  --service-account ci-bot

# Grant a user admin access
brig role grant PROJECT_ADMIN \
  --project platform-ci \
  --user alice@example.com

# List role assignments
brig role list --project platform-ci
```

### Service Account for Gateways

Each gateway should use a dedicated service account:

```bash
# Create service account for GitHub gateway
brig service-account create --id github-gateway --description "GitHub event gateway"

# Grant it permission to create events on the platform-ci project
brig role grant EVENT_CREATOR \
  --project platform-ci \
  --service-account github-gateway

# Get the token (used in gateway config)
brig service-account get-token --id github-gateway
```

---

## Monitoring with Prometheus

Brigade exposes Prometheus metrics from the API server and scheduler:

```yaml
# brigade-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: brigade
  namespace: brigade
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: brigade
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
```

### Key Metrics

| Metric | Description |
|---|---|
| `brigade_events_total` | Total events received, labelled by project and type |
| `brigade_workers_active` | Currently running workers |
| `brigade_workers_total` | Total worker completions, labelled by outcome |
| `brigade_jobs_active` | Currently running job pods |
| `brigade_jobs_total` | Total job completions, labelled by outcome |
| `brigade_api_requests_total` | HTTP request counts to the API server |
| `brigade_api_request_duration_seconds` | API request latency histogram |

### Grafana Dashboard (Jsonnet snippet)

```jsonnet
// dashboards/brigade.libsonnet
local g = import "github.com/grafana/grafonnet/gen/grafonnet-latest/main.libsonnet";

g.dashboard.new("Brigade Overview")
+ g.dashboard.withPanels([
    g.panel.stat.new("Active Workers")
    + g.panel.stat.queryOptions.withTargets([
        g.query.prometheus.new("$datasource", "brigade_workers_active")
      ]),

    g.panel.timeSeries.new("Events per Minute")
    + g.panel.timeSeries.queryOptions.withTargets([
        g.query.prometheus.new("$datasource",
          "sum(rate(brigade_events_total[5m])) by (project)")
        + g.query.prometheus.withLegendFormat("{{project}}"),
      ]),

    g.panel.timeSeries.new("Job Success Rate")
    + g.panel.timeSeries.queryOptions.withTargets([
        g.query.prometheus.new("$datasource", |||
          sum(rate(brigade_jobs_total{outcome="SUCCEEDED"}[5m]))
          /
          sum(rate(brigade_jobs_total[5m]))
        |||)
        + g.query.prometheus.withLegendFormat("success rate"),
      ]),
  ])
```

---

## GitHub Integration for Pull Request CI

A complete pull request CI workflow:

```typescript
// brigade.ts — full PR validation pipeline
import { events, Event, Job, ConcurrentGroup, SerialGroup } from "@brigadecore/brigadier";

const IMAGE = "registry.example.com/platform/api";

events.on("brigade.sh/github", "pull_request:opened", runPRChecks);
events.on("brigade.sh/github", "pull_request:synchronize", runPRChecks);
events.on("brigade.sh/github", "pull_request:reopened", runPRChecks);

async function runPRChecks(event: Event): Promise<void> {
  const sha    = event.git?.commit ?? "";
  const prNum  = JSON.parse(event.payload ?? "{}").number ?? 0;

  console.log(`Running checks for PR #${prNum} (${sha})`);

  // Fail fast: lint runs first
  const lint = new Job("lint", "golangci/golangci-lint:v1.57", event);
  lint.primaryContainer.command   = ["golangci-lint"];
  lint.primaryContainer.arguments = ["run", "--timeout=5m", "--out-format=github-actions"];
  await lint.run();

  // Build and test in parallel after lint passes
  const build = new Job("build", "golang:1.22-alpine", event);
  build.primaryContainer.command   = ["go"];
  build.primaryContainer.arguments = ["build", "-v", "./..."];
  build.primaryContainer.environment = { CGO_ENABLED: "0" };

  const test = new Job("test", "golang:1.22-alpine", event);
  test.primaryContainer.command   = ["go"];
  test.primaryContainer.arguments = [
    "test", "-v", "-race",
    "-coverprofile=/workspace/coverage.out",
    "./...",
  ];
  test.primaryContainer.environment = { CGO_ENABLED: "1" };

  await new ConcurrentGroup(build, test).run();

  // Build and scan image
  const buildImage = new Job("build-image", "gcr.io/kaniko-project/executor:latest", event);
  buildImage.primaryContainer.arguments = [
    `--destination=${IMAGE}:pr-${prNum}-${sha.slice(0, 8)}`,
    "--cache=true",
    "--cache-repo=registry.example.com/cache/api",
    "--context=dir:///workspace",
    "--no-push",
  ];
  buildImage.primaryContainer.volumeMounts = [{
    name:      "docker-config",
    mountPath: "/kaniko/.docker",
  }];
  buildImage.volumes = [{
    name:   "docker-config",
    secret: { secretName: "registry-credentials" },
  }];

  await buildImage.run();

  console.log(`PR #${prNum}: all checks passed`);
}

events.process();
```

---

## Brigade vs Tekton vs Argo Workflows

| Dimension | Brigade | Tekton | Argo Workflows |
|---|---|---|---|
| Primary abstraction | Event + Script | Pipeline/Task CRDs | Workflow CRD |
| Scripting model | TypeScript/JavaScript | YAML task steps | YAML DAG steps |
| Event-driven | Native (core design) | Via Tekton Triggers | Via Argo Events |
| Git source execution | Built-in | Via git-clone task | Via git clone step |
| Dashboard UI | Basic (brig CLI) | Tekton Dashboard | Full Argo UI |
| Artifact management | Job volumes | Workspace PVCs | Artifact repository |
| Concurrency control | SerialGroup/ConcurrentGroup | Pipeline DAG | DAG / Steps |
| Secret scoping | Per-project | Namespace-wide | Namespace-wide |
| Learning curve | Medium (TypeScript) | Medium-High (YAML CRDs) | Medium (YAML CRDs) |
| Scalability | Good | Very good | Very good |

**Brigade** is the right choice when:
- Pipeline logic requires complex conditional branching that is unwieldy in YAML
- Existing JavaScript/TypeScript expertise is available
- Per-project secret isolation is a hard security requirement
- Pipelines integrate deeply with external APIs (GitHub status checks, Slack, JIRA)

**Tekton** is preferable when strict YAML-based definitions and reusable Task/ClusterTask catalogs align with the team model.

**Argo Workflows** excels at complex DAG pipelines, data engineering workflows, and scenarios where the visual DAG UI provides value.

---

## Log Aggregation

Brigade's logger component stores pod logs persistently. Access them through `brig`:

```bash
# Set EVENT_ID from the output of 'brig event list'
EVENT_ID="01hv2e3f4g5h6j7k8m9n0p1q2r"

# Stream worker logs in real time
brig event logs --id "${EVENT_ID}" --worker --follow

# Retrieve completed job logs
brig event logs --id "${EVENT_ID}" --job build

# All logs for an event
brig event logs --id "${EVENT_ID}"
```

### Forwarding Brigade Logs to Loki

```yaml
# fluent-bit-brigade.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluent-bit-brigade-config
  namespace: brigade
data:
  fluent-bit.conf: |
    [SERVICE]
        Flush         5
        Daemon        Off
        Log_Level     info

    [INPUT]
        Name              tail
        Tag               brigade.*
        Path              /var/log/containers/*brigade*.log
        Parser            docker
        Refresh_Interval  5
        Mem_Buf_Limit     5MB

    [FILTER]
        Name   kubernetes
        Match  brigade.*
        Merge_Log On
        Keep_Log Off

    [OUTPUT]
        Name            loki
        Match           brigade.*
        Host            loki.monitoring.svc.cluster.local
        Port            3100
        Labels          job=brigade
        label_keys      $kubernetes['namespace_name'],$kubernetes['pod_name']
```

---

## Production Deployment Checklist

Before running Brigade in production:

**High Availability**

```bash
# Scale API server and scheduler to 2+ replicas
helm upgrade brigade brigade/brigade \
  --namespace brigade \
  --set apiserver.replicas=2 \
  --set scheduler.replicas=2 \
  --set mongodb.replicaCount=3
```

**Resource Limits**

```yaml
# Set resource limits for Brigade components in values.yaml
apiserver:
  resources:
    requests:
      cpu: "250m"
      memory: "256Mi"
    limits:
      cpu: "1"
      memory: "512Mi"

scheduler:
  resources:
    requests:
      cpu: "100m"
      memory: "128Mi"
    limits:
      cpu: "500m"
      memory: "256Mi"
```

**Worker Namespace Isolation**

```bash
# Run worker pods in a dedicated namespace separate from Brigade components
helm upgrade brigade brigade/brigade \
  --set scheduler.workerNamespace=brigade-workers
```

**MongoDB Backup**

```bash
# Brigade stores all event state and secrets in MongoDB
# Ensure regular backups with a CronJob
kubectl create cronjob brigade-backup \
  --image=mongo:7 \
  --schedule="0 3 * * *" \
  -n brigade \
  -- mongodump --host brigade-mongodb --out /backup/$(date +%Y%m%d)
```

**Network Policies**

```yaml
# Restrict gateway egress to Brigade API only
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: github-gateway-egress
  namespace: brigade
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: brigade-github-app-gateway
  policyTypes: [Egress]
  egress:
    - to:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: brigade-apiserver
      ports:
        - port: 8080
```

---

## Troubleshooting

### Worker Pod Fails to Start

```bash
# Set EVENT_ID from the output of 'brig event list'
EVENT_ID="01hv2e3f4g5h6j7k8m9n0p1q2r"

# Check worker pod events
kubectl describe pod -l "brigade.sh/event=${EVENT_ID}" -n brigade-workers

# Check scheduler logs
kubectl logs -l app.kubernetes.io/name=brigade-scheduler -n brigade

# Common cause: insufficient resource quota in worker namespace
kubectl describe resourcequota -n brigade-workers
```

### Event Stuck in PENDING State

```bash
EVENT_ID="01hv2e3f4g5h6j7k8m9n0p1q2r"

# Check if scheduler has errors
brig event get "${EVENT_ID}"

# Verify project subscription matches the event source/type
brig project get platform-ci

# Manually cancel stuck event
brig event cancel "${EVENT_ID}"
```

### Job Container Cannot Access Registry

Ensure the registry secret is in the correct namespace (`brigade-workers`, not `brigade`):

```bash
kubectl get secret registry-credentials -n brigade-workers
# If missing:
kubectl get secret registry-credentials -n brigade -o yaml \
  | sed 's/namespace: brigade/namespace: brigade-workers/' \
  | kubectl apply -f -
```

---

## Summary

Brigade v2 brings a well-structured, Kubernetes-native event-driven pipeline model to teams that want programmatic CI/CD scripting rather than YAML-configured task graphs. The TypeScript SDK provides full language expressiveness — real loops, async/await, error handling, and unit tests — for pipeline logic that would be extremely difficult to express in Tekton YAML or Argo Workflow templates.

The project-level RBAC model and per-project secret store make Brigade particularly compelling for multi-team platforms where pipeline isolation is a security requirement. Gateway extensibility means any external event source can integrate without modifying Brigade's core components.

The operational cost relative to Tekton or Argo is a MongoDB dependency and a less mature UI. For teams comfortable with `brig` CLI workflows and willing to invest in the TypeScript SDK, Brigade offers a uniquely powerful event-driven automation layer on Kubernetes.
