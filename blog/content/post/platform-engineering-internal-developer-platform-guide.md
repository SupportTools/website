---
title: "Platform Engineering: Building an Internal Developer Platform with Kubernetes"
date: 2027-07-10T00:00:00-05:00
draft: false
tags: ["Platform Engineering", "Kubernetes", "Developer Experience", "IDP", "DevOps"]
categories: ["Platform Engineering", "Kubernetes", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "End-to-end guide to building an Internal Developer Platform on Kubernetes using platform engineering principles, golden paths, Crossplane self-service infrastructure, GitOps provisioning, and DORA metrics measurement."
more_link: "yes"
url: "/platform-engineering-internal-developer-platform-guide/"
---

Platform engineering has emerged as the discipline that transforms ad-hoc DevOps tooling into a coherent, product-minded internal developer platform (IDP). Rather than requiring every team to independently navigate Kubernetes, cloud infrastructure, and CI/CD pipelines, platform engineering teams build curated abstractions — golden paths — that encode organizational standards and reduce the cognitive load imposed on product engineers. This guide covers the foundational principles, team topologies, technical implementation, and measurement frameworks required to build a production-grade IDP on Kubernetes.

<!--more-->

## Executive Summary

An Internal Developer Platform is the sum of all self-service capabilities that allow product engineers to provision environments, deploy services, observe workloads, and manage infrastructure without deep expertise in every underlying system. Platform engineering teams treat this platform as a product, measuring developer satisfaction and DORA metrics to drive continuous improvement. This guide demonstrates how to implement the key building blocks: self-service infrastructure via Crossplane, GitOps-driven environment provisioning, developer portals via Backstage, and DORA metrics pipelines that provide objective feedback loops.

## Platform Engineering Principles

### Team Topologies Alignment

Platform engineering builds on the Team Topologies framework, identifying four fundamental team types:

```
Stream-aligned teams    → Own product delivery end-to-end
Platform teams          → Provide self-service capabilities
Enabling teams          → Temporary coaching and upskilling
Complicated-subsystem   → Specialized deep expertise teams
```

The platform team creates an X-as-a-Service interface that minimizes cognitive load for stream-aligned teams. The interaction mode shifts from collaboration (high bandwidth) to X-as-a-Service (low friction).

### Platform as a Product

Treating the platform as a product requires:

```
Traditional DevOps Tooling       Internal Developer Platform
────────────────────────────     ──────────────────────────
Tribal knowledge required        Self-service documentation
Manual provisioning              Automated golden paths
One-off configurations           Standardized templates
No feedback mechanism            NPS surveys, ticket analysis
Reactive maintenance             Roadmap-driven development
```

### The Three Platform Laws

1. **Law of Cognitive Load**: Every capability added to the platform must reduce total developer cognitive load, not increase it
2. **Law of Golden Paths**: The platform-blessed path must be easier than the alternative
3. **Law of Escape Hatches**: Developers must be able to bypass golden paths with deliberate effort when business needs require it

## Platform Maturity Model

### Level 0: Manual Operations

```
Characteristics:
- Tickets for every infrastructure request
- Days-to-weeks lead time for environments
- Tribal knowledge in ops team heads
- No standardization across teams
```

### Level 1: Scripted Automation

```
Characteristics:
- Bash/Ansible scripts for common operations
- Shared Terraform modules
- Hours-to-days lead time
- Documentation exists but is out of date
```

### Level 2: Self-Service Portal

```
Characteristics:
- Backstage or Port for service catalog and templates
- Minutes-to-hours lead time
- Golden paths defined and enforced
- Basic DORA metrics tracked
```

### Level 3: Product-Grade IDP

```
Characteristics:
- Full self-service from idea to production
- Minutes lead time for standard environments
- Developer NPS > 40
- DORA elite metrics achieved
- Platform roadmap driven by developer feedback
```

## Infrastructure Architecture

### Control Plane Components

```yaml
# idp-namespace-structure.yaml
# platform-system  - Backstage, Port, platform tooling
# crossplane-system - Crossplane and providers
# argocd           - ArgoCD for GitOps
# cert-manager     - Certificate automation
# external-secrets - Secret synchronization
# monitoring       - Prometheus, Grafana, Alertmanager
# logging          - Loki, Fluent Bit
# ingress-nginx    - Ingress controller
```

### Platform Kubernetes Cluster Setup

```bash
# Install platform tooling via Helm
PLATFORM_COMPONENTS=(
  "cert-manager:cert-manager:jetstack"
  "external-secrets:external-secrets:external-secrets"
  "argocd:argo-cd:argo"
  "crossplane-system:crossplane:crossplane-stable"
  "ingress-nginx:ingress-nginx:ingress-nginx"
  "monitoring:kube-prometheus-stack:prometheus-community"
)

for component in "${PLATFORM_COMPONENTS[@]}"; do
  namespace=$(echo "$component" | cut -d: -f1)
  chart=$(echo "$component" | cut -d: -f2)
  repo=$(echo "$component" | cut -d: -f3)
  kubectl create namespace "$namespace" --dry-run=client -o yaml | kubectl apply -f -
  helm upgrade --install "$chart" "$repo/$chart" \
    --namespace "$namespace" \
    --wait --timeout 5m
done
```

## Golden Paths Implementation

### Golden Path Definition

A golden path is the set of opinionated decisions the platform team makes on behalf of product engineers:

```
Golden Path: New Go Microservice
├── Repository structure (monorepo or polyrepo convention)
├── Dockerfile (multi-stage, distroless, non-root)
├── GitHub Actions workflow (lint, test, build, push, security scan)
├── Helm chart (standardized values, resource limits, probes)
├── ArgoCD Application (dev → staging → prod promotion)
├── Kubernetes namespace (with NetworkPolicy, ResourceQuota, LimitRange)
├── Observability (ServiceMonitor, dashboards, alerts)
├── TechDocs (mkdocs.yml scaffold, ADR template)
└── catalog-info.yaml (Backstage registration)
```

### Namespace-Per-Team GitOps Structure

```
platform-gitops/
├── clusters/
│   ├── production/
│   │   ├── kustomization.yaml
│   │   └── applications/
│   ├── staging/
│   │   ├── kustomization.yaml
│   │   └── applications/
│   └── dev/
│       ├── kustomization.yaml
│       └── applications/
├── teams/
│   ├── payments-team/
│   │   ├── namespace.yaml
│   │   ├── resourcequota.yaml
│   │   ├── networkpolicy.yaml
│   │   └── rbac.yaml
│   ├── order-team/
│   └── identity-team/
├── platform/
│   ├── cert-manager/
│   ├── crossplane/
│   ├── monitoring/
│   └── ingress/
└── apps/
    ├── payment-service/
    ├── order-service/
    └── inventory-service/
```

### Standardized Namespace Template

```yaml
# teams/payments-team/namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: payments
  labels:
    team: payments-team
    domain: commerce
    environment: production
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/audit: restricted
---
# teams/payments-team/resourcequota.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: payments-quota
  namespace: payments
spec:
  hard:
    requests.cpu: "8"
    requests.memory: 16Gi
    limits.cpu: "16"
    limits.memory: 32Gi
    pods: "50"
    services: "20"
    persistentvolumeclaims: "10"
    services.loadbalancers: "0"
---
# teams/payments-team/limitrange.yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: payments-limits
  namespace: payments
spec:
  limits:
    - type: Container
      default:
        cpu: 200m
        memory: 256Mi
      defaultRequest:
        cpu: 100m
        memory: 128Mi
      max:
        cpu: "2"
        memory: 4Gi
    - type: Pod
      max:
        cpu: "4"
        memory: 8Gi
---
# teams/payments-team/networkpolicy.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
  namespace: payments
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - port: 53
          protocol: UDP
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ingress-nginx
```

## Self-Service Infrastructure with Crossplane

### AWS Provider Setup

```yaml
# crossplane/providers/aws-provider.yaml
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws
spec:
  package: xpkg.upbound.io/upbound/provider-aws:v0.43.0
  controllerConfigRef:
    name: aws-provider-config

---
apiVersion: pkg.crossplane.io/v1alpha1
kind: ControllerConfig
metadata:
  name: aws-provider-config
spec:
  podSecurityContext:
    runAsUser: 2000
  args:
    - --debug
---
apiVersion: aws.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: default
spec:
  credentials:
    source: InjectedIdentity
```

### CompositeResourceDefinition for Application Database

```yaml
# crossplane/compositions/xrd-applicationdatabase.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xapplicationdatabases.platform.acme.internal
spec:
  group: platform.acme.internal
  names:
    kind: XApplicationDatabase
    plural: xapplicationdatabases
  claimNames:
    kind: ApplicationDatabase
    plural: applicationdatabases
  connectionSecretKeys:
    - username
    - password
    - endpoint
    - port
  versions:
    - name: v1alpha1
      served: true
      referenceable: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                parameters:
                  type: object
                  required: [storageGB, tier]
                  properties:
                    storageGB:
                      type: integer
                      minimum: 20
                      maximum: 1000
                      description: Storage size in GB
                    tier:
                      type: string
                      enum: [dev, standard, production]
                      description: Performance tier
                    backupRetentionDays:
                      type: integer
                      default: 7
                      minimum: 1
                      maximum: 35
                    enableMultiAZ:
                      type: boolean
                      default: false
              required: [parameters]
```

### Composition for RDS PostgreSQL

```yaml
# crossplane/compositions/composition-rds.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: xapplicationdatabases-rds
  labels:
    provider: aws
    service: rds
spec:
  writeConnectionSecretsToNamespace: crossplane-system
  compositeTypeRef:
    apiVersion: platform.acme.internal/v1alpha1
    kind: XApplicationDatabase
  resources:
    - name: rds-instance
      base:
        apiVersion: rds.aws.upbound.io/v1beta1
        kind: Instance
        spec:
          forProvider:
            region: us-east-1
            engine: postgres
            engineVersion: "15.4"
            instanceClass: db.t3.medium
            dbName: appdb
            username: appuser
            skipFinalSnapshot: true
            publiclyAccessible: false
            vpcSecurityGroupIdSelector:
              matchLabels:
                purpose: rds
            dbSubnetGroupNameSelector:
              matchLabels:
                purpose: rds
          writeConnectionSecretToRef:
            namespace: crossplane-system
      patches:
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.storageGB
          toFieldPath: spec.forProvider.allocatedStorage
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.backupRetentionDays
          toFieldPath: spec.forProvider.backupRetentionPeriod
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.enableMultiAZ
          toFieldPath: spec.forProvider.multiAZ
        - type: FromCompositeFieldPath
          fromFieldPath: spec.parameters.tier
          toFieldPath: spec.forProvider.instanceClass
          transforms:
            - type: map
              map:
                dev: db.t3.micro
                standard: db.t3.medium
                production: db.r6g.large
        - type: FromCompositeFieldPath
          fromFieldPath: metadata.uid
          toFieldPath: spec.writeConnectionSecretToRef.name
          transforms:
            - type: string
              string:
                fmt: "rds-%s"
      connectionDetails:
        - name: username
          fromFieldPath: spec.forProvider.username
        - name: endpoint
          fromConnectionSecretKey: endpoint
        - name: port
          fromConnectionSecretKey: port
        - name: password
          fromConnectionSecretKey: password
```

### Developer Database Claim

```yaml
# Developer creates this in their namespace
# payment-service-db-claim.yaml
apiVersion: platform.acme.internal/v1alpha1
kind: ApplicationDatabase
metadata:
  name: payment-db
  namespace: payments
spec:
  parameters:
    storageGB: 100
    tier: production
    backupRetentionDays: 14
    enableMultiAZ: true
  writeConnectionSecretToRef:
    name: payment-db-connection
```

```bash
# Developer applies the claim
kubectl apply -f payment-service-db-claim.yaml

# Monitor provisioning
kubectl get applicationdatabase payment-db -n payments -w

# Once ready, connection details are available
kubectl get secret payment-db-connection -n payments -o yaml
```

## GitOps-Driven Environment Provisioning

### Environment Request CRD

```yaml
# platform/crds/environment-crd.yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: environments.platform.acme.internal
spec:
  group: platform.acme.internal
  names:
    kind: Environment
    plural: environments
    singular: environment
    shortNames: [env]
  scope: Cluster
  versions:
    - name: v1alpha1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              required: [team, type]
              properties:
                team:
                  type: string
                type:
                  type: string
                  enum: [preview, staging, production]
                ttl:
                  type: string
                  description: Duration string (e.g., 24h, 7d)
                apps:
                  type: array
                  items:
                    type: object
                    properties:
                      name:
                        type: string
                      imageTag:
                        type: string
```

### Argo Workflow for Environment Provisioning

```yaml
# platform/workflows/provision-environment.yaml
apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: provision-environment
  namespace: argo
spec:
  entrypoint: provision
  arguments:
    parameters:
      - name: team
      - name: environment-type
      - name: ttl
        value: "24h"

  templates:
    - name: provision
      steps:
        - - name: create-namespace
            template: create-namespace
            arguments:
              parameters:
                - name: team
                  value: "{{workflow.parameters.team}}"
                - name: env-type
                  value: "{{workflow.parameters.environment-type}}"

        - - name: apply-policies
            template: apply-policies
            arguments:
              parameters:
                - name: namespace
                  value: "{{steps.create-namespace.outputs.parameters.namespace}}"

        - - name: provision-infrastructure
            template: provision-infrastructure
            arguments:
              parameters:
                - name: namespace
                  value: "{{steps.create-namespace.outputs.parameters.namespace}}"

        - - name: deploy-applications
            template: deploy-applications
            arguments:
              parameters:
                - name: namespace
                  value: "{{steps.create-namespace.outputs.parameters.namespace}}"

    - name: create-namespace
      script:
        image: bitnami/kubectl:latest
        command: [bash]
        source: |
          NAMESPACE="{{inputs.parameters.team}}-{{inputs.parameters.env-type}}-$(date +%s)"
          kubectl create namespace "$NAMESPACE"
          kubectl label namespace "$NAMESPACE" \
            team={{inputs.parameters.team}} \
            env-type={{inputs.parameters.env-type}} \
            managed-by=platform
          echo "$NAMESPACE" > /tmp/namespace
        outputs:
          parameters:
            - name: namespace
              valueFrom:
                path: /tmp/namespace
```

## Developer Feedback Loops

### Developer Portal with Port

```yaml
# port/blueprints/service-blueprint.yaml
identifier: service
title: Service
icon: Service
schema:
  properties:
    language:
      type: string
      enum: [go, python, java, typescript]
    tier:
      type: string
      enum: [critical, standard, internal]
    domain:
      type: string
    deploymentFrequency:
      type: number
      title: Deployments per week
    meanTimeToRecovery:
      type: string
      title: MTTR
    changeFailureRate:
      type: number
      title: Change Failure Rate (%)
```

### NPS Survey Automation

```yaml
# platform/cronjobs/nps-survey.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: developer-nps-survey
  namespace: platform-system
spec:
  schedule: "0 9 1 * *"  # First day of each month at 9am
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: survey-sender
              image: acme/platform-tools:latest
              command: ["/bin/sh", "-c"]
              args:
                - |
                  python3 /scripts/send_nps_survey.py \
                    --slack-channel platform-feedback \
                    --survey-url https://platform.acme.internal/nps \
                    --month "$(date +%B)"
              env:
                - name: SLACK_WEBHOOK_URL
                  valueFrom:
                    secretKeyRef:
                      name: platform-slack-secrets
                      key: webhook-url
```

## DORA Metrics Measurement

### Four Key DORA Metrics

```
Metric                    Elite        High       Medium     Low
──────────────────────────────────────────────────────────────────
Deployment Frequency      Multiple/day Daily      Weekly     Monthly
Lead Time for Changes     < 1 hour     < 1 day    < 1 week   < 1 month
Change Failure Rate       0-15%        16-30%     16-30%     16-30%
Time to Restore Service   < 1 hour     < 1 day    < 1 day    < 1 week
```

### DORA Metrics Collection Pipeline

```yaml
# dora/deployment-event-collector.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dora-collector
  namespace: platform-system
spec:
  replicas: 1
  selector:
    matchLabels:
      app: dora-collector
  template:
    spec:
      containers:
        - name: collector
          image: acme/dora-collector:latest
          env:
            - name: GITHUB_TOKEN
              valueFrom:
                secretKeyRef:
                  name: github-secrets
                  key: token
            - name: POSTGRES_URL
              valueFrom:
                secretKeyRef:
                  name: dora-db
                  key: url
          volumeMounts:
            - name: config
              mountPath: /etc/collector
      volumes:
        - name: config
          configMap:
            name: dora-collector-config
```

### DORA Metrics Prometheus Exporters

```yaml
# dora/prometheusrule.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: dora-metrics
  namespace: platform-system
spec:
  groups:
    - name: dora
      interval: 5m
      rules:
        - record: dora:deployment_frequency:rate1w
          expr: |
            sum(increase(deployment_total[1w])) by (team, service)

        - record: dora:lead_time_seconds:avg
          expr: |
            avg(deployment_lead_time_seconds) by (team, service)

        - record: dora:change_failure_rate:ratio
          expr: |
            sum(deployment_failures_total) by (team)
            /
            sum(deployment_total) by (team)

        - record: dora:time_to_restore_seconds:avg
          expr: |
            avg(incident_resolution_duration_seconds) by (team)

        - alert: DegradedDeploymentFrequency
          expr: dora:deployment_frequency:rate1w < 1
          for: 7d
          labels:
            severity: warning
          annotations:
            summary: "Team {{ $labels.team }} deploying less than once per week"
```

### Grafana Dashboard for DORA

```json
{
  "title": "DORA Metrics Dashboard",
  "uid": "dora-metrics",
  "panels": [
    {
      "title": "Deployment Frequency",
      "type": "stat",
      "targets": [
        {
          "expr": "sum(rate(deployment_total[7d])) * 86400",
          "legendFormat": "Deployments/day"
        }
      ]
    },
    {
      "title": "Lead Time for Changes",
      "type": "gauge",
      "fieldConfig": {
        "thresholds": {
          "steps": [
            {"color": "green", "value": 0},
            {"color": "yellow", "value": 86400},
            {"color": "red", "value": 604800}
          ]
        }
      },
      "targets": [
        {
          "expr": "avg(deployment_lead_time_seconds)",
          "legendFormat": "Avg Lead Time"
        }
      ]
    },
    {
      "title": "Change Failure Rate",
      "type": "gauge",
      "fieldConfig": {
        "max": 100,
        "thresholds": {
          "steps": [
            {"color": "green", "value": 0},
            {"color": "yellow", "value": 15},
            {"color": "red", "value": 30}
          ]
        }
      },
      "targets": [
        {
          "expr": "dora:change_failure_rate:ratio * 100",
          "legendFormat": "Failure Rate %"
        }
      ]
    }
  ]
}
```

## Platform Roadmap Governance

### Platform RFC Template

```markdown
# RFC-XXXX: [Title]

## Status
Draft | In Review | Accepted | Rejected

## Context
What problem does this solve? What is the current state?

## Proposal
Describe the proposed change in detail.

## Alternatives Considered
What other approaches were evaluated?

## Impact Assessment
- Developer Experience: [Positive/Neutral/Negative]
- Cognitive Load: [Increases/Decreases/Neutral]
- Migration Required: [Yes/No]
- Breaking Change: [Yes/No]

## Success Metrics
How will success be measured?

## Implementation Plan
Phases and timeline.
```

### Platform Ticket Classification

```yaml
# platform/config/ticket-classification.yaml
ticket_types:
  golden_path_request:
    sla_hours: 72
    template: golden-path-template
    auto_assign: platform-team
  infrastructure_request:
    sla_hours: 24
    template: infra-request-template
    auto_assign: platform-team
  incident:
    sla_hours: 1
    template: incident-template
    auto_assign: platform-oncall
  developer_question:
    sla_hours: 8
    template: question-template
    auto_assign: platform-team
```

## Reducing Cognitive Load

### Cognitive Load Matrix

```
Capability                    Without IDP        With IDP
──────────────────────────────────────────────────────────────
Provision new service         4 hours manual     5 minutes
Create staging environment    2 hours             2 minutes
Debug production pod          20+ CLI commands    3 clicks
Find service owner            Slack hunting       Catalog lookup
Deploy to prod                Manual runbook      Git push
Rotate database password      Ops ticket          Self-service
Access logs                   Direct kubectl      Grafana/Loki
Update TLS certificate        Manual              Automated
```

### Documentation as Code

```bash
# Platform documentation build
cat << 'EOF' > platform-docs/Makefile
build:
	techdocs-cli generate --no-docker
	techdocs-cli publish \
	  --publisher-type awsS3 \
	  --storage-name acme-techdocs-prod \
	  --entity default/System/internal-developer-platform

serve:
	mkdocs serve

lint:
	markdownlint docs/
EOF
```

## Production Operations

### Platform SLA Targets

```yaml
# platform/slas.yaml
slas:
  backstage_availability:
    target: 99.9%
    window: 30d
  environment_provisioning:
    target: 5_minutes
    percentile: p95
  secret_rotation:
    target: automated
    frequency: 90d
  certificate_renewal:
    target: automated
    days_before_expiry: 30
  deployment_pipeline:
    target: 10_minutes
    percentile: p95
```

### Platform Runbook Automation

```yaml
# platform/runbooks/scale-backstage.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: runbook-scale-backstage
  namespace: platform-system
  annotations:
    runbook/name: "Scale Backstage Under Load"
    runbook/severity: "P2"
data:
  procedure: |
    1. Check current HPA status:
       kubectl get hpa backstage -n backstage

    2. If CPU > 80%:
       kubectl patch hpa backstage -n backstage \
         --type merge \
         -p '{"spec":{"maxReplicas":10}}'

    3. Verify database connection pool:
       kubectl exec -n backstage deployment/backstage -- \
         curl -s http://localhost:7007/api/catalog/entities?limit=1

    4. Check for stuck catalog refresh:
       kubectl logs -n backstage deployment/backstage \
         --since=5m | grep -i "timeout\|stuck"
```

## Summary

Building an Internal Developer Platform is a multi-year investment that compounds returns over time. The platform engineering team's primary deliverable is not infrastructure or code — it is reduced cognitive load and accelerated developer flow. By encoding organizational best practices into golden paths via Backstage templates, providing self-service infrastructure through Crossplane compositions, automating environment lifecycle through GitOps, and continuously measuring developer experience via DORA metrics and NPS surveys, platform teams create a flywheel where each improvement attracts more usage, which surfaces more requirements, which drives further improvements. The organizations that invest in this discipline consistently achieve elite DORA metrics and retain engineering talent at higher rates than those that rely on fragmented ad-hoc tooling.
