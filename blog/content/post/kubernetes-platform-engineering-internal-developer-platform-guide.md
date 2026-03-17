---
title: "Kubernetes Platform Engineering: Building an Internal Developer Platform"
date: 2029-08-06T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Platform Engineering", "Backstage", "IDP", "Developer Experience", "GitOps", "DevOps"]
categories: ["Kubernetes", "Platform Engineering", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to building an Internal Developer Platform on Kubernetes: golden paths, Backstage self-service portal, platform team topology, abstraction layers over Kubernetes, and measuring developer experience metrics."
more_link: "yes"
url: "/kubernetes-platform-engineering-internal-developer-platform-guide/"
---

Platform engineering is the practice of building and maintaining a curated set of tools, services, and workflows that enable application developers to self-serve their infrastructure needs. An Internal Developer Platform (IDP) is the concrete product of this practice — the portal, CLI, and APIs that transform "file a ticket to provision a database" into "run `platform db create` and be done in 30 seconds." This guide covers the full lifecycle of building a production IDP on Kubernetes, from the philosophical underpinnings of golden paths to the practical implementation of Backstage, Crossplane, and developer experience measurement.

<!--more-->

# Kubernetes Platform Engineering: Building an Internal Developer Platform

## What is Platform Engineering?

Platform engineering emerged from the realization that DevOps as traditionally practiced — where every developer team owns their infrastructure from end to end — doesn't scale. By the time an organization has 50+ engineering teams, the cognitive overhead of each team independently managing Kubernetes deployments, security policies, monitoring configuration, and cloud resources becomes prohibitive.

Platform engineering solves this through **product thinking applied to internal infrastructure**. The platform team builds and maintains the IDP as a product with:
- Internal customers (development teams)
- Clear APIs and contracts
- SLOs for reliability and functionality
- Documentation and onboarding paths
- Feedback loops for continuous improvement

### The Golden Path Concept

A "golden path" is a well-lit, well-maintained trail through the forest of infrastructure options. It represents the platform team's opinionated answer to "how do we deploy a service here?" It is not the only path, but it is the one that:
- Has all security policies pre-applied
- Has monitoring configured automatically
- Has documentation and examples
- Has ongoing maintenance from the platform team

```
Without Golden Path:
Developer → reads 200 pages of docs → makes 50 choices → probably gets something wrong

With Golden Path:
Developer → runs `platform service create` → service deployed with all best practices
```

## Architecture of an Internal Developer Platform

```
┌─────────────────────────────────────────────────────────┐
│                    Developer Portal (Backstage)          │
│  Service Catalog | Templates | TechDocs | API Explorer  │
└─────────────────────────┬───────────────────────────────┘
                          │
              ┌───────────▼──────────────┐
              │   Platform API / CLI      │
              │  (platform create/list)   │
              └───────────┬──────────────┘
                          │
     ┌────────────────────▼──────────────────────────┐
     │              Orchestration Layer               │
     │   Crossplane | ArgoCD | Terraform Cloud        │
     └────────────────────┬──────────────────────────┘
                          │
     ┌────────────────────▼──────────────────────────┐
     │              Kubernetes Clusters               │
     │   Dev | Staging | Production (multi-region)    │
     └───────────────────────────────────────────────┘
```

## Setting Up Backstage

Backstage is the CNCF-graduated open-source developer portal created by Spotify. It provides the service catalog, software templates, and TechDocs system that form the visible face of your IDP.

### Deploying Backstage on Kubernetes

```bash
# Create a new Backstage app
npx @backstage/create-app@latest --skip-install
cd my-backstage-app
yarn install

# Build and push Docker image
cat > Dockerfile <<'EOF'
FROM node:20-bookworm-slim

WORKDIR /app
COPY package.json yarn.lock ./
COPY packages/app/package.json packages/app/
COPY packages/backend/package.json packages/backend/

RUN yarn install --frozen-lockfile --production --network-timeout 300000

COPY . .
RUN yarn tsc
RUN yarn build

CMD ["node", "packages/backend", "--config", "app-config.yaml", "--config", "app-config.production.yaml"]
EOF

docker build -t company.registry.io/backstage:latest .
docker push company.registry.io/backstage:latest
```

```yaml
# kubernetes/backstage-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backstage
  namespace: platform
spec:
  replicas: 2
  selector:
    matchLabels:
      app: backstage
  template:
    metadata:
      labels:
        app: backstage
    spec:
      serviceAccountName: backstage
      containers:
        - name: backstage
          image: company.registry.io/backstage:latest
          imagePullPolicy: Always
          ports:
            - name: http
              containerPort: 7007
          env:
            - name: POSTGRES_HOST
              valueFrom:
                secretKeyRef:
                  name: backstage-postgres
                  key: host
            - name: POSTGRES_PORT
              value: "5432"
            - name: POSTGRES_USER
              valueFrom:
                secretKeyRef:
                  name: backstage-postgres
                  key: username
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: backstage-postgres
                  key: password
            - name: GITHUB_TOKEN
              valueFrom:
                secretKeyRef:
                  name: backstage-github
                  key: token
            - name: AUTH_GITHUB_CLIENT_ID
              valueFrom:
                secretKeyRef:
                  name: backstage-auth
                  key: github-client-id
            - name: AUTH_GITHUB_CLIENT_SECRET
              valueFrom:
                secretKeyRef:
                  name: backstage-auth
                  key: github-client-secret
          resources:
            requests:
              cpu: "500m"
              memory: "1Gi"
            limits:
              cpu: "2"
              memory: "2Gi"
          readinessProbe:
            httpGet:
              path: /healthcheck
              port: 7007
            initialDelaySeconds: 30
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /healthcheck
              port: 7007
            initialDelaySeconds: 60
            periodSeconds: 30
```

### Backstage Configuration

```yaml
# app-config.production.yaml
app:
  title: Company Developer Portal
  baseUrl: https://backstage.company.com

backend:
  baseUrl: https://backstage.company.com
  listen:
    port: 7007
  database:
    client: pg
    connection:
      host: ${POSTGRES_HOST}
      port: ${POSTGRES_PORT}
      user: ${POSTGRES_USER}
      password: ${POSTGRES_PASSWORD}
      database: backstage

auth:
  environment: production
  providers:
    github:
      production:
        clientId: ${AUTH_GITHUB_CLIENT_ID}
        clientSecret: ${AUTH_GITHUB_CLIENT_SECRET}
        signIn:
          resolvers:
            - resolver: usernameMatchingUserEntityName
            - resolver: emailMatchingUserEntityProfileEmail

integrations:
  github:
    - host: github.com
      token: ${GITHUB_TOKEN}

catalog:
  import:
    entityFilename: catalog-info.yaml
    pullRequestBranchName: backstage-integration
  rules:
    - allow: [Component, System, API, Resource, Location, Template, User, Group]
  locations:
    # Organizational team structure
    - type: url
      target: https://github.com/company/org-catalog/blob/main/catalog-info.yaml

    # Discover all services automatically
    - type: github-discovery
      target: https://github.com/company
      filters:
        branch: main
        repository: '.*'  # All repos

techdocs:
  builder: external
  generator:
    runIn: docker
  publisher:
    type: googleGcs
    googleGcs:
      bucketName: company-techdocs
      projectId: company-project

kubernetes:
  clusterLocatorMethods:
    - type: config
      clusters:
        - url: https://k8s-production.company.com
          name: production
          authProvider: serviceAccount
          skipTLSVerify: false
          serviceAccountToken: ${K8S_PRODUCTION_TOKEN}
        - url: https://k8s-staging.company.com
          name: staging
          authProvider: serviceAccount
          serviceAccountToken: ${K8S_STAGING_TOKEN}
```

## Software Templates: The Golden Path Implementation

Software templates are the core of the self-service experience. They generate scaffolded projects, create repositories, and provision infrastructure — all through the Backstage UI.

### Creating a Service Template

```yaml
# templates/go-service-template.yaml
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: go-microservice
  title: Go Microservice
  description: Creates a production-ready Go microservice with all platform defaults
  tags:
    - go
    - microservice
    - recommended

spec:
  owner: group:platform-team
  type: service

  parameters:
    - title: Service Information
      required:
        - name
        - owner
        - system
        - description
      properties:
        name:
          title: Service Name
          type: string
          description: Unique name for your service (kebab-case)
          pattern: '^[a-z][a-z0-9-]{1,52}[a-z0-9]$'
          ui:autofocus: true

        owner:
          title: Owner Team
          type: string
          description: Team that owns this service
          ui:field: OwnerPicker
          ui:options:
            allowedKinds:
              - Group

        system:
          title: System
          type: string
          description: The system this service is part of
          ui:field: EntityPicker
          ui:options:
            allowedKinds:
              - System

        description:
          title: Description
          type: string
          description: What does this service do?

    - title: Infrastructure Configuration
      properties:
        environment:
          title: Initial Environment
          type: string
          enum: [development, staging, production]
          default: development

        database:
          title: Database Type
          type: string
          enum: [none, postgresql, redis]
          default: none

        replicas:
          title: Initial Replicas
          type: integer
          minimum: 1
          maximum: 10
          default: 2

        memoryLimit:
          title: Memory Limit
          type: string
          enum: ['256Mi', '512Mi', '1Gi', '2Gi']
          default: '512Mi'

  steps:
    # Step 1: Fetch and populate the template
    - id: fetch-base
      name: Fetch Base Template
      action: fetch:template
      input:
        url: ./skeleton
        values:
          name: ${{ parameters.name }}
          owner: ${{ parameters.owner }}
          system: ${{ parameters.system }}
          description: ${{ parameters.description }}
          database: ${{ parameters.database }}
          replicas: ${{ parameters.replicas }}
          memoryLimit: ${{ parameters.memoryLimit }}

    # Step 2: Create GitHub repository
    - id: publish
      name: Create Repository
      action: publish:github
      input:
        allowedHosts: ['github.com']
        description: ${{ parameters.description }}
        repoUrl: github.com?owner=company&repo=${{ parameters.name }}
        defaultBranch: main
        repoVisibility: internal
        topics:
          - microservice
          - go
          - platform-managed

    # Step 3: Register in service catalog
    - id: register
      name: Register Service
      action: catalog:register
      input:
        repoContentsUrl: ${{ steps.publish.output.repoContentsUrl }}
        catalogInfoPath: /catalog-info.yaml

    # Step 4: Create GitOps manifests
    - id: gitops
      name: Create GitOps Manifests
      action: fetch:template
      input:
        url: ./gitops-skeleton
        targetPath: gitops
        values:
          name: ${{ parameters.name }}
          owner: ${{ parameters.owner }}
          environment: ${{ parameters.environment }}
          replicas: ${{ parameters.replicas }}
          memoryLimit: ${{ parameters.memoryLimit }}

    # Step 5: Push GitOps manifests
    - id: publish-gitops
      name: Push GitOps Manifests
      action: publish:github:file
      input:
        repoUrl: github.com?owner=company&repo=k8s-manifests
        branchName: add-${{ parameters.name }}
        commitMessage: "feat: add ${{ parameters.name }} service manifests"
        files:
          - sourcePath: gitops/
            targetPath: apps/${{ parameters.name }}/

    # Step 6: Provision database if requested
    - id: provision-db
      if: ${{ parameters.database !== 'none' }}
      name: Provision Database
      action: http:backstage:request
      input:
        method: POST
        path: /api/platform/databases
        body:
          name: ${{ parameters.name }}
          type: ${{ parameters.database }}
          environment: ${{ parameters.environment }}

  output:
    links:
      - title: Repository
        url: ${{ steps.publish.output.remoteUrl }}
      - title: Open in Backstage
        icon: catalog
        entityRef: ${{ steps.register.output.entityRef }}
      - title: View in Kubernetes
        icon: kubernetes
        url: https://backstage.company.com/kubernetes/${{ parameters.name }}
```

### Template Skeleton Structure

```
templates/go-service-template/
├── skeleton/
│   ├── catalog-info.yaml
│   ├── .github/
│   │   └── workflows/
│   │       ├── ci.yaml
│   │       └── release.yaml
│   ├── cmd/
│   │   └── server/
│   │       └── main.go
│   ├── internal/
│   │   ├── api/
│   │   │   └── handler.go
│   │   └── config/
│   │       └── config.go
│   ├── Dockerfile
│   ├── Makefile
│   └── README.md
└── gitops-skeleton/
    ├── deployment.yaml
    ├── service.yaml
    ├── hpa.yaml
    └── kustomization.yaml
```

```yaml
# skeleton/catalog-info.yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: ${{ values.name }}
  title: ${{ values.name | title }}
  description: ${{ values.description }}
  annotations:
    github.com/project-slug: company/${{ values.name }}
    backstage.io/techdocs-ref: dir:.
    backstage.io/kubernetes-id: ${{ values.name }}
    backstage.io/kubernetes-namespace: production
    prometheus.io/path: /metrics
  tags:
    - go
    - microservice
  links:
    - url: https://grafana.company.com/d/${{ values.name }}
      title: Grafana Dashboard
      icon: dashboard
    - url: https://sentry.company.com/company/${{ values.name }}
      title: Error Tracking
      icon: bug
spec:
  type: service
  lifecycle: experimental
  owner: ${{ values.owner }}
  system: ${{ values.system }}
  providesApis:
    - ${{ values.name }}-api
  consumesApis: []
```

## Crossplane: Infrastructure as APIs

Crossplane extends Kubernetes with custom resource definitions for cloud resources, enabling developers to provision infrastructure using familiar Kubernetes YAML:

### Installing Crossplane

```bash
# Install Crossplane
helm repo add crossplane-stable https://charts.crossplane.io/stable
helm install crossplane crossplane-stable/crossplane \
  --namespace crossplane-system \
  --create-namespace

# Install AWS provider
kubectl apply -f - <<EOF
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws
spec:
  package: xpkg.upbound.io/upbound/provider-aws:v1.0.0
EOF
```

### Composite Resource Definitions for Developer Self-Service

```yaml
# xrd/database.yaml
# Defines the "AppDatabase" composite resource - what developers see
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: appdatabases.platform.company.com
spec:
  group: platform.company.com
  names:
    kind: AppDatabase
    plural: appdatabases
  claimNames:
    kind: Database
    plural: databases

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
                environment:
                  type: string
                  enum: [development, staging, production]
                size:
                  type: string
                  enum: [small, medium, large]
                  default: small
                engine:
                  type: string
                  enum: [postgresql, mysql]
                  default: postgresql
              required:
                - environment
            status:
              type: object
              properties:
                endpoint:
                  type: string
                secretName:
                  type: string
```

```yaml
# xrd/database-composition.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: database.platform.company.com
  labels:
    crossplane.io/xrd: appdatabases.platform.company.com
spec:
  compositeTypeRef:
    apiVersion: platform.company.com/v1alpha1
    kind: AppDatabase

  resources:
    # RDS instance
    - name: rds-instance
      base:
        apiVersion: rds.aws.upbound.io/v1beta1
        kind: Instance
        spec:
          forProvider:
            region: us-east-1
            instanceClass: db.t3.micro
            engine: postgres
            engineVersion: "16"
            multiAZ: false
            autoMinorVersionUpgrade: true
            deletionProtection: true
            skipFinalSnapshot: false
            publiclyAccessible: false
            storageType: gp3
      patches:
        # Set instance class based on size
        - type: FromCompositeFieldPath
          fromFieldPath: spec.size
          toFieldPath: spec.forProvider.instanceClass
          transforms:
            - type: map
              map:
                small:  db.t3.micro
                medium: db.r6g.large
                large:  db.r6g.xlarge

        # Multi-AZ for production
        - type: FromCompositeFieldPath
          fromFieldPath: spec.environment
          toFieldPath: spec.forProvider.multiAZ
          transforms:
            - type: map
              map:
                development: "false"
                staging: "false"
                production: "true"

    # RDS subnet group
    - name: subnet-group
      base:
        apiVersion: rds.aws.upbound.io/v1beta1
        kind: SubnetGroup
        spec:
          forProvider:
            region: us-east-1
            subnetIds:
              - subnet-aaaa1111
              - subnet-bbbb2222
              - subnet-cccc3333
            description: "Platform-managed RDS subnet group"
```

```yaml
# Using the composite resource (what developers write)
apiVersion: platform.company.com/v1alpha1
kind: Database  # This is the Claim - namespace-scoped
metadata:
  name: my-service-db
  namespace: my-team
spec:
  environment: production
  size: medium
  engine: postgresql
  compositeDeletePolicy: Delete
  # Connection details will appear in this secret
  writeConnectionSecretToRef:
    name: my-service-db-credentials
```

## Platform Team Topology

### Team Structures

The DORA research and Team Topologies book identify specific team patterns that work well for platform engineering:

**Platform Team**: Builds and maintains the IDP as a product. Owns the golden paths, templates, Crossplane compositions, and Backstage catalog.

**Stream-Aligned Teams**: Application development teams who consume the platform. They should be able to build and deploy independently using the platform's self-service capabilities.

**Enabling Teams**: Specialist teams that embed in stream-aligned teams temporarily to upskill them on new platform capabilities.

```yaml
# Platform team OKRs example
objectives:
  - title: "Reduce Time to First Deployment"
    key_results:
      - metric: "p50 time from service creation template to first production deployment"
        target: "< 4 hours"
        current: "3 days"

  - title: "Increase Developer Self-Service Rate"
    key_results:
      - metric: "Percentage of infrastructure provisioning done without platform team tickets"
        target: "80%"
        current: "35%"

  - title: "Improve Platform Reliability"
    key_results:
      - metric: "Platform API availability"
        target: "99.9%"
        current: "99.5%"
      - metric: "Mean time to detect platform issues"
        target: "< 5 minutes"
        current: "15 minutes"
```

## Developer Experience Metrics

You cannot improve what you do not measure. The key DX metrics for an IDP:

### DORA Metrics

```python
#!/usr/bin/env python3
# dora-metrics.py - Calculate DORA metrics from deployment data

import requests
from datetime import datetime, timedelta
from statistics import median

GITHUB_API = "https://api.github.com"
PROMETHEUS_URL = "http://prometheus.monitoring.svc.cluster.local:9090"

def get_deployment_frequency(org: str, repo: str, days: int = 30) -> float:
    """Deployments per day over the specified window"""
    since = (datetime.now() - timedelta(days=days)).isoformat() + "Z"

    resp = requests.get(
        f"{GITHUB_API}/repos/{org}/{repo}/deployments",
        params={"since": since, "per_page": 100},
        headers={"Authorization": f"token {GITHUB_TOKEN}"},
    )
    deployments = resp.json()
    return len(deployments) / days

def get_lead_time_for_change(org: str, repo: str, days: int = 30) -> float:
    """Median time from commit to production deployment (hours)"""
    # Get recent production deployments
    resp = requests.get(
        f"{GITHUB_API}/repos/{org}/{repo}/deployments",
        params={"environment": "production", "per_page": 50},
        headers={"Authorization": f"token {GITHUB_TOKEN}"},
    )
    deployments = resp.json()

    lead_times = []
    for deployment in deployments:
        # Get the commit for this deployment
        sha = deployment["sha"]
        commit_resp = requests.get(
            f"{GITHUB_API}/repos/{org}/{repo}/commits/{sha}",
            headers={"Authorization": f"token {GITHUB_TOKEN}"},
        )
        commit = commit_resp.json()

        commit_time = datetime.fromisoformat(
            commit["commit"]["author"]["date"].replace("Z", "+00:00")
        )
        deploy_time = datetime.fromisoformat(
            deployment["created_at"].replace("Z", "+00:00")
        )

        lead_time_hours = (deploy_time - commit_time).total_seconds() / 3600
        lead_times.append(lead_time_hours)

    return median(lead_times) if lead_times else 0

def get_change_failure_rate(service: str, days: int = 30) -> float:
    """Percentage of deployments that caused failures"""
    query = f"""
        sum(increase(deployment_failures_total{{service="{service}"}}[{days}d]))
        /
        sum(increase(deployments_total{{service="{service}"}}[{days}d]))
    """
    resp = requests.get(
        f"{PROMETHEUS_URL}/api/v1/query",
        params={"query": query},
    )
    result = resp.json().get("data", {}).get("result", [])
    return float(result[0]["value"][1]) if result else 0

def get_mean_time_to_recovery(service: str, days: int = 30) -> float:
    """Mean time to recover from failures (minutes)"""
    query = f"""
        avg(
            increase(incident_duration_seconds_total{{service="{service}"}}[{days}d])
            /
            increase(incident_count_total{{service="{service}"}}[{days}d])
        ) / 60
    """
    resp = requests.get(
        f"{PROMETHEUS_URL}/api/v1/query",
        params={"query": query},
    )
    result = resp.json().get("data", {}).get("result", [])
    return float(result[0]["value"][1]) if result else 0

def print_dora_report(org: str, repos: list[str]) -> None:
    print("=== DORA Metrics Report ===\n")
    print(f"{'Service':<30} {'Deploy Freq':>12} {'Lead Time':>12} {'CFR':>8} {'MTTR':>8}")
    print("-" * 80)

    for repo in repos:
        freq = get_deployment_frequency(org, repo)
        lead = get_lead_time_for_change(org, repo)
        cfr = get_change_failure_rate(repo) * 100
        mttr = get_mean_time_to_recovery(repo)

        print(f"{repo:<30} {freq:>11.1f}/d {lead:>10.1f}h {cfr:>7.1f}% {mttr:>7.0f}m")

if __name__ == "__main__":
    repos = ["order-service", "payment-service", "notification-service"]
    print_dora_report("company", repos)
```

### Platform Adoption Metrics

```yaml
# prometheus-rules/platform-adoption.yaml
groups:
  - name: platform-adoption
    rules:
      # Track service catalog coverage
      - record: platform:catalog_coverage_ratio
        expr: |
          count(kube_deployment_labels{label_backstage_io_kubernetes_id!=""})
          /
          count(kube_deployment_labels)

      # Track golden path adoption
      - record: platform:golden_path_adoption_ratio
        expr: |
          count(kube_deployment_labels{label_platform_company_com_managed="true"})
          /
          count(kube_deployment_labels)

      # Track self-service provisioning
      - record: platform:self_service_provisioning_ratio
        expr: |
          sum(increase(platform_resource_provisioned_total{source="template"}[30d]))
          /
          sum(increase(platform_resource_provisioned_total[30d]))

      # Alert when catalog coverage drops
      - alert: CatalogCoverageLow
        expr: platform:catalog_coverage_ratio < 0.8
        for: 24h
        labels:
          severity: warning
        annotations:
          summary: "Less than 80% of deployments are registered in the catalog"
          description: "{{ $value | humanizePercentage }} of services are in the catalog. Investigate new deployments."
```

## Backstage Plugins for Kubernetes Visibility

```typescript
// packages/app/src/components/catalog/EntityPage.tsx
import React from 'react';
import { EntitySwitch, EntityOrphanWarning } from '@backstage/plugin-catalog';
import { EntityKubernetesContent } from '@backstage/plugin-kubernetes';
import { EntityArgoCDContent } from '@roadiehq/backstage-plugin-argo-cd';
import { EntityPrometheusContent } from '@roadiehq/backstage-plugin-prometheus';
import { EntityGithubActionsContent } from '@backstage-community/plugin-github-actions';
import { EntityPagerDutyCard } from '@pagerduty/backstage-plugin';

const serviceEntityPage = (
  <EntityLayout>
    <EntityLayout.Route path="/" title="Overview">
      <Grid container spacing={3} alignItems="stretch">
        <Grid item md={6}>
          <EntityAboutCard variant="gridItem" />
        </Grid>
        <Grid item md={6}>
          <EntityPagerDutyCard readOnly />
        </Grid>
        <Grid item md={12}>
          <EntityLinksCard />
        </Grid>
      </Grid>
    </EntityLayout.Route>

    <EntityLayout.Route path="/kubernetes" title="Kubernetes">
      <EntityKubernetesContent refreshIntervalMs={30000} />
    </EntityLayout.Route>

    <EntityLayout.Route path="/cd" title="CD">
      <EntityArgoCDContent />
    </EntityLayout.Route>

    <EntityLayout.Route path="/ci" title="CI">
      <EntityGithubActionsContent />
    </EntityLayout.Route>

    <EntityLayout.Route path="/metrics" title="Metrics">
      <EntityPrometheusContent />
    </EntityLayout.Route>

    <EntityLayout.Route path="/docs" title="Docs">
      <EntityTechdocsContent />
    </EntityLayout.Route>
  </EntityLayout>
);
```

## Platform CLI

A CLI is often more ergonomic than a web portal for common operations:

```go
// platform-cli/cmd/root.go
package cmd

import (
    "github.com/spf13/cobra"
    "github.com/spf13/viper"
)

var rootCmd = &cobra.Command{
    Use:   "platform",
    Short: "Company Internal Developer Platform CLI",
    Long: `platform is the CLI for Company's Internal Developer Platform.
It allows you to create services, manage databases, and interact with
the Backstage catalog without leaving your terminal.`,
}

// platform service create --name my-service --team alpha
var serviceCreateCmd = &cobra.Command{
    Use:   "create",
    Short: "Create a new service from the golden path template",
    Run: func(cmd *cobra.Command, args []string) {
        name, _ := cmd.Flags().GetString("name")
        team, _ := cmd.Flags().GetString("team")
        db, _ := cmd.Flags().GetString("database")

        fmt.Printf("Creating service %s for team %s...\n", name, team)

        // Call Backstage scaffolder API
        resp, err := scaffolderClient.CreateFromTemplate(
            "go-microservice",
            map[string]interface{}{
                "name":     name,
                "owner":    fmt.Sprintf("group:%s", team),
                "database": db,
            },
        )
        if err != nil {
            fmt.Printf("Error: %v\n", err)
            os.Exit(1)
        }

        fmt.Printf("Service created successfully!\n")
        fmt.Printf("Repository: %s\n", resp.RepoURL)
        fmt.Printf("Backstage: %s\n", resp.BackstageURL)
        fmt.Printf("Kubernetes: kubectl get deploy/%s -n %s\n", name, team)
    },
}

func init() {
    serviceCmd.AddCommand(serviceCreateCmd)
    serviceCreateCmd.Flags().String("name", "", "Service name (required)")
    serviceCreateCmd.Flags().String("team", "", "Owning team (required)")
    serviceCreateCmd.Flags().String("database", "none", "Database type (none/postgresql/redis)")
    serviceCreateCmd.MarkFlagRequired("name")
    serviceCreateCmd.MarkFlagRequired("team")
}
```

## Summary

Building an effective Internal Developer Platform requires:

1. **Start with golden paths, not features**: Identify the most common workflows (deploy a service, create a database, set up monitoring) and make those the fastest, easiest, most opinionated paths.

2. **Backstage for the portal**: It handles service catalog, software templates, TechDocs, and plugin extensibility. The catalog alone — a single place to find every service and its ownership — delivers immediate value.

3. **Crossplane for infrastructure self-service**: Define composite resources that match your developers' mental model (AppDatabase, AppCache) while handling all the cloud complexity internally.

4. **Measure continuously**: DORA metrics, platform adoption ratios, and time-to-productivity metrics tell you whether the platform is actually helping or just adding another system to maintain.

5. **Treat the platform as a product**: Run quarterly surveys, hold regular office hours, maintain a public roadmap, and have an explicit process for deprecating old capabilities.

6. **The platform team's job is to make itself unnecessary**: The best platform is one where developers can accomplish everything they need without ever filing a ticket or interrupting the platform team.
