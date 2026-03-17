---
title: "Kubernetes Platform Engineering with Backstage: Software Catalog and Golden Paths"
date: 2028-05-04T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Backstage", "Platform Engineering", "IDP", "Developer Experience"]
categories: ["Platform Engineering", "Kubernetes"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to building an Internal Developer Platform with Backstage on Kubernetes, covering software catalog setup, golden path templates, scaffolder actions, and TechDocs integration for enterprise developer experience."
more_link: "yes"
url: "/kubernetes-platform-engineering-backstage-guide/"
---

Platform engineering has emerged as the discipline that transforms how development teams interact with infrastructure. Rather than every team reinventing the wheel on deployment pipelines, secret management, and observability setup, a platform team builds a paved road — golden paths — that guide developers toward production-ready patterns by default. Backstage, the open-source developer portal from Spotify, has become the de facto foundation for Internal Developer Platforms (IDPs) in the Kubernetes ecosystem. This guide covers deploying Backstage on Kubernetes, building a meaningful software catalog, creating golden path templates, and integrating with your existing toolchain.

<!--more-->

# Kubernetes Platform Engineering with Backstage: Software Catalog and Golden Paths

## Why Platform Engineering Matters

The cognitive load placed on individual developers in modern cloud-native environments is enormous. A single engineer must understand Kubernetes deployments, service meshes, observability pipelines, secret management, CI/CD systems, and cost management — all before writing a line of business logic. This is unsustainable at scale.

Platform engineering solves this through abstraction. The platform team builds well-paved paths that encode organizational best practices, compliance requirements, and operational knowledge into reusable templates and self-service tooling. Developers follow the path and get a production-ready service without needing deep platform expertise.

Backstage provides the user-facing layer of this platform: a developer portal where engineers can discover services, provision new ones, access documentation, and understand dependencies across the organization.

## Backstage Architecture Overview

Backstage consists of several core components:

- **Software Catalog**: A centralized registry of all software assets (services, libraries, APIs, pipelines, infrastructure)
- **Scaffolder**: A template engine that creates new software components following organizational standards
- **TechDocs**: Documentation-as-code system that renders Markdown docs alongside service catalog entries
- **Search**: Cross-catalog search across all entities and documentation
- **Plugins**: Extensible plugin system for integrating external tools

On Kubernetes, Backstage runs as a standard deployment with a PostgreSQL backend for persistence.

## Deploying Backstage on Kubernetes

### Prerequisites

Before deploying Backstage, ensure you have:
- A running Kubernetes cluster (1.24+)
- PostgreSQL 13+ (in-cluster or managed)
- GitHub/GitLab OAuth application for authentication
- Container registry access

### Helm-Based Deployment

The Backstage community maintains a Helm chart. Start with a values file that reflects production requirements:

```yaml
# backstage-values.yaml
backstage:
  image:
    registry: ghcr.io
    repository: your-org/backstage
    tag: "1.25.0"
    pullPolicy: IfNotPresent

  appConfig:
    app:
      title: "ACME Developer Portal"
      baseUrl: https://backstage.internal.acme.com

    backend:
      baseUrl: https://backstage.internal.acme.com
      listen:
        port: 7007
      database:
        client: pg
        connection:
          host: ${POSTGRES_HOST}
          port: ${POSTGRES_PORT}
          user: ${POSTGRES_USER}
          password: ${POSTGRES_PASSWORD}
          database: backstage_plugin_catalog
          ssl:
            require: true
            rejectUnauthorized: false

    auth:
      environment: production
      providers:
        github:
          production:
            clientId: ${GITHUB_OAUTH_CLIENT_ID}
            clientSecret: ${GITHUB_OAUTH_CLIENT_SECRET}

    integrations:
      github:
        - host: github.com
          token: ${GITHUB_TOKEN}

    catalog:
      providers:
        github:
          production:
            organization: "acme-corp"
            catalogPath: "/catalog-info.yaml"
            filters:
              branch: "main"
              repository: ".*"
            schedule:
              frequency: { minutes: 30 }
              timeout: { minutes: 3 }

    techdocs:
      builder: "external"
      generator:
        runIn: "docker"
      publisher:
        type: "googleGcs"
        googleGcs:
          bucketName: acme-techdocs
          projectId: acme-platform

postgresql:
  enabled: false  # Use external PostgreSQL

ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"
  hosts:
    - host: backstage.internal.acme.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: backstage-tls
      hosts:
        - backstage.internal.acme.com

serviceAccount:
  create: true
  name: backstage
  annotations:
    iam.gke.io/gcp-service-account: backstage@acme-platform.iam.gserviceaccount.com
```

Deploy with Helm:

```bash
helm repo add backstage https://backstage.github.io/charts
helm repo update

kubectl create namespace backstage

kubectl create secret generic backstage-secrets \
  --namespace backstage \
  --from-literal=POSTGRES_HOST=postgres.backstage.svc.cluster.local \
  --from-literal=POSTGRES_PORT=5432 \
  --from-literal=POSTGRES_USER=backstage \
  --from-literal=POSTGRES_PASSWORD="$(openssl rand -base64 32)" \
  --from-literal=GITHUB_TOKEN="${GITHUB_TOKEN}" \
  --from-literal=GITHUB_OAUTH_CLIENT_ID="${GITHUB_CLIENT_ID}" \
  --from-literal=GITHUB_OAUTH_CLIENT_SECRET="${GITHUB_CLIENT_SECRET}"

helm install backstage backstage/backstage \
  --namespace backstage \
  --values backstage-values.yaml \
  --version 1.9.0
```

### Building a Custom Backstage Image

The upstream Backstage image rarely has all the plugins you need. Build a custom image:

```dockerfile
# Dockerfile
FROM node:18-bookworm-slim AS packages

WORKDIR /app
COPY package.json yarn.lock ./
COPY packages packages

RUN find packages -maxdepth 2 -name "package.json" | \
    xargs grep -l '"name"' | \
    xargs -I{} cp --parents {} /tmp/

FROM node:18-bookworm-slim AS build

WORKDIR /app
COPY --from=packages /tmp/packages ./packages
COPY package.json yarn.lock ./
COPY . .

RUN yarn install --frozen-lockfile --network-timeout 600000

RUN yarn tsc

RUN yarn build:backend --config ../../app-config.yaml

FROM node:18-bookworm-slim

ENV NODE_ENV production

WORKDIR /app

# Install required system dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install mkdocs for TechDocs
RUN pip3 install mkdocs mkdocs-techdocs-core

COPY --from=build --chown=node:node /app/packages/backend/dist ./
COPY --from=build --chown=node:node /app/packages/backend/package.json ./

RUN yarn install --frozen-lockfile --production --network-timeout 600000

USER node
EXPOSE 7007

CMD ["node", "packages/backend", "--config", "app-config.yaml"]
```

### Adding Essential Plugins

Create `packages/backend/src/index.ts` with the plugin registrations:

```typescript
import { createBackend } from '@backstage/backend-defaults';
import { catalogPlugin } from '@backstage/plugin-catalog-backend/alpha';
import { scaffolderPlugin } from '@backstage/plugin-scaffolder-backend/alpha';
import { techdocsPlugin } from '@backstage/plugin-techdocs-backend/alpha';
import { permissionsPlugin } from '@backstage/plugin-permission-backend/alpha';
import { searchPlugin } from '@backstage/plugin-search-backend/alpha';
import { kubernetesPlugin } from '@backstage/plugin-kubernetes-backend/alpha';
import { githubActionsPlugin } from '@backstage/plugin-github-actions-backend/alpha';

const backend = createBackend();

// Core plugins
backend.add(catalogPlugin());
backend.add(scaffolderPlugin());
backend.add(techdocsPlugin());
backend.add(permissionsPlugin());
backend.add(searchPlugin());

// Infrastructure integrations
backend.add(kubernetesPlugin());
backend.add(githubActionsPlugin());

backend.start();
```

## Building the Software Catalog

### Understanding Catalog Entities

Backstage's catalog uses a descriptor format defined in YAML files committed alongside your code. The key entity kinds are:

- **Component**: A software unit (service, library, website, pipeline)
- **API**: An API offered or consumed by a component
- **Resource**: Infrastructure resources (databases, S3 buckets, queues)
- **System**: A collection of related components
- **Domain**: A high-level business domain grouping systems
- **Group**: An organizational unit (team, department)
- **User**: An individual engineer

### Component Descriptor

Place `catalog-info.yaml` at the root of every service repository:

```yaml
# catalog-info.yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: payments-service
  title: Payments Service
  description: |
    Core payment processing service handling charge, refund, and dispute workflows.
    Integrates with Stripe, PayPal, and internal ledger systems.
  annotations:
    # GitHub integration
    github.com/project-slug: acme-corp/payments-service
    # Kubernetes integration
    backstage.io/kubernetes-id: payments-service
    backstage.io/kubernetes-namespace: payments
    backstage.io/kubernetes-label-selector: "app=payments-service"
    # CI/CD integration
    github.com/team-slug: acme-corp/payments-team
    # TechDocs
    backstage.io/techdocs-ref: dir:.
    # PagerDuty
    pagerduty.com/service-id: P1234567
    # Datadog
    datadoghq.com/service-name: payments-service
    # Runbook
    backstage.io/runbook-url: https://wiki.acme.com/runbooks/payments-service
  tags:
    - payments
    - stripe
    - financial
    - critical-path
  links:
    - url: https://payments.internal.acme.com/health
      title: Health Endpoint
      icon: web
    - url: https://grafana.internal.acme.com/d/payments
      title: Grafana Dashboard
      icon: dashboard
    - url: https://runbook.acme.com/payments
      title: Runbook
      icon: book
spec:
  type: service
  lifecycle: production
  owner: group:payments-team
  system: financial-platform
  dependsOn:
    - component:ledger-service
    - component:fraud-detection-service
    - resource:payments-postgres
    - resource:payments-redis
  providesApis:
    - payments-api
  consumesApis:
    - stripe-api
    - paypal-api
```

### Defining APIs

APIs are first-class citizens in Backstage, allowing teams to understand the contract between services:

```yaml
# api-info.yaml
apiVersion: backstage.io/v1alpha1
kind: API
metadata:
  name: payments-api
  title: Payments API
  description: REST API for payment processing operations
  annotations:
    backstage.io/techdocs-ref: dir:./docs/api
  tags:
    - rest
    - payments
spec:
  type: openapi
  lifecycle: production
  owner: group:payments-team
  system: financial-platform
  definition:
    $text: ./openapi.yaml
```

### Defining Infrastructure Resources

Link services to their backing infrastructure:

```yaml
# resources.yaml
apiVersion: backstage.io/v1alpha1
kind: Resource
metadata:
  name: payments-postgres
  title: Payments PostgreSQL Database
  description: Primary PostgreSQL database for payments service
  annotations:
    backstage.io/managed-by-location: "url:https://github.com/acme-corp/infra/blob/main/databases/payments-postgres.tf"
  tags:
    - database
    - postgresql
    - financial
spec:
  type: database
  owner: group:platform-team
  system: financial-platform
---
apiVersion: backstage.io/v1alpha1
kind: Resource
metadata:
  name: payments-redis
  title: Payments Redis Cache
  description: Redis cache for payment session state and rate limiting
  tags:
    - cache
    - redis
spec:
  type: cache
  owner: group:platform-team
  system: financial-platform
```

### Organizational Structure

Define your team hierarchy to enable ownership queries:

```yaml
# groups.yaml
apiVersion: backstage.io/v1alpha1
kind: Group
metadata:
  name: engineering
  title: Engineering
  description: Top-level engineering organization
spec:
  type: organization
  children:
    - platform-team
    - payments-team
    - identity-team
    - data-team
---
apiVersion: backstage.io/v1alpha1
kind: Group
metadata:
  name: payments-team
  title: Payments Team
  description: Team responsible for all payment processing systems
  annotations:
    slack.com/channel-id: C0123456789
  links:
    - url: https://backstage.internal.acme.com/catalog/default/group/payments-team
      title: Backstage Profile
spec:
  type: team
  parent: engineering
  children: []
  members:
    - alice.smith
    - bob.jones
    - carol.white
```

### Automated Catalog Discovery

Rather than manually registering every service, configure automatic discovery from GitHub:

```yaml
# app-config.yaml catalog section
catalog:
  rules:
    - allow:
        [Component, API, Resource, System, Domain, Group, User, Template, Location]

  providers:
    github:
      # Discover all catalog-info.yaml files across the org
      allRepos:
        organization: "acme-corp"
        catalogPath: "/catalog-info.yaml"
        filters:
          branch: "main"
        schedule:
          frequency: { minutes: 30 }
          timeout: { minutes: 10 }

      # Separate provider for infrastructure repos
      infraRepos:
        organization: "acme-corp"
        catalogPath: "/infrastructure/**/*.yaml"
        filters:
          branch: "main"
          repository: "^infra-.*"
        schedule:
          frequency: { hours: 1 }
          timeout: { minutes: 5 }

  # Statically registered locations for shared entities
  locations:
    - type: url
      target: https://github.com/acme-corp/backstage-catalog/blob/main/groups.yaml
    - type: url
      target: https://github.com/acme-corp/backstage-catalog/blob/main/users.yaml
    - type: url
      target: https://github.com/acme-corp/backstage-catalog/blob/main/systems.yaml
```

## Creating Golden Path Templates

Golden paths are the heart of platform engineering — they encode organizational best practices into templates that any developer can use to create production-ready services.

### Template Structure

Backstage templates live in the catalog as `Template` entities:

```yaml
# templates/go-microservice/template.yaml
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: go-microservice
  title: Go Microservice
  description: |
    Creates a production-ready Go microservice with:
    - Kubernetes deployment manifests
    - Dockerfile with multi-stage build
    - GitHub Actions CI/CD pipeline
    - Prometheus metrics endpoint
    - Structured logging with zerolog
    - Health check endpoints
    - OpenTelemetry tracing
  annotations:
    backstage.io/techdocs-ref: dir:.
  tags:
    - go
    - microservice
    - kubernetes
    - recommended
spec:
  owner: group:platform-team
  type: service

  parameters:
    - title: Service Information
      required:
        - serviceName
        - serviceDescription
        - owner
        - system
      properties:
        serviceName:
          title: Service Name
          type: string
          description: Unique identifier for this service (lowercase, hyphens only)
          pattern: "^[a-z][a-z0-9-]*[a-z0-9]$"
          ui:autofocus: true
          ui:help: "Example: payments-processor, user-notifications"
        serviceDescription:
          title: Description
          type: string
          description: Brief description of what this service does
          ui:widget: textarea
        owner:
          title: Owning Team
          type: string
          description: Team responsible for this service
          ui:field: OwnerPicker
          ui:options:
            catalogFilter:
              kind: Group
        system:
          title: System
          type: string
          description: System this service belongs to
          ui:field: EntityPicker
          ui:options:
            catalogFilter:
              kind: System

    - title: Infrastructure Configuration
      required:
        - namespace
        - replicas
        - cpuRequest
        - memoryRequest
      properties:
        namespace:
          title: Kubernetes Namespace
          type: string
          description: Target namespace for deployment
          default: "default"
        replicas:
          title: Initial Replicas
          type: integer
          minimum: 1
          maximum: 10
          default: 2
        cpuRequest:
          title: CPU Request
          type: string
          default: "100m"
          enum: ["50m", "100m", "250m", "500m", "1000m"]
        memoryRequest:
          title: Memory Request
          type: string
          default: "128Mi"
          enum: ["64Mi", "128Mi", "256Mi", "512Mi", "1Gi"]
        enableDatabase:
          title: Enable PostgreSQL Database
          type: boolean
          default: false
        enableCache:
          title: Enable Redis Cache
          type: boolean
          default: false

    - title: Repository Setup
      required:
        - repoUrl
      properties:
        repoUrl:
          title: Repository Location
          type: string
          ui:field: RepoUrlPicker
          ui:options:
            allowedHosts:
              - github.com
            allowedOwners:
              - acme-corp

  steps:
    - id: fetch-base
      name: Fetch Base Template
      action: fetch:template
      input:
        url: ./skeleton
        values:
          serviceName: ${{ parameters.serviceName }}
          serviceDescription: ${{ parameters.serviceDescription }}
          owner: ${{ parameters.owner }}
          system: ${{ parameters.system }}
          namespace: ${{ parameters.namespace }}
          replicas: ${{ parameters.replicas }}
          cpuRequest: ${{ parameters.cpuRequest }}
          memoryRequest: ${{ parameters.memoryRequest }}
          enableDatabase: ${{ parameters.enableDatabase }}
          enableCache: ${{ parameters.enableCache }}
          repoUrl: ${{ parameters.repoUrl }}

    - id: publish
      name: Publish to GitHub
      action: publish:github
      input:
        allowedHosts: ["github.com"]
        description: ${{ parameters.serviceDescription }}
        repoUrl: ${{ parameters.repoUrl }}
        defaultBranch: main
        repoVisibility: private
        gitAuthorName: "Backstage Platform Bot"
        gitAuthorEmail: "platform-bot@acme.com"
        topics:
          - microservice
          - go
          - kubernetes

    - id: create-argocd-app
      name: Create ArgoCD Application
      action: argocd:create-resources
      input:
        appName: ${{ parameters.serviceName }}
        argoInstance: production
        namespace: argocd
        projectName: ${{ parameters.system }}
        repoUrl: ${{ steps.publish.output.remoteUrl }}
        path: "k8s/overlays/production"

    - id: register-catalog
      name: Register in Catalog
      action: catalog:register
      input:
        repoContentsUrl: ${{ steps.publish.output.repoContentsUrl }}
        catalogInfoPath: "/catalog-info.yaml"

    - id: create-slack-channel
      name: Create Team Slack Channel
      action: slack:create-channel
      input:
        channelName: "${{ parameters.serviceName }}-alerts"
        isPrivate: false
        description: "Alerts for ${{ parameters.serviceName }}"

    - id: notify-team
      name: Notify Team
      action: slack:send-message
      input:
        channel: "${{ parameters.owner }}-general"
        message: |
          :rocket: New service *${{ parameters.serviceName }}* has been created!

          Repository: ${{ steps.publish.output.remoteUrl }}
          Owner: ${{ parameters.owner }}
          System: ${{ parameters.system }}

  output:
    links:
      - title: Repository
        url: ${{ steps.publish.output.remoteUrl }}
      - title: Open in Catalog
        icon: catalog
        entityRef: ${{ steps.register-catalog.output.entityRef }}
      - title: ArgoCD Application
        url: https://argocd.internal.acme.com/applications/${{ parameters.serviceName }}
```

### Template Skeleton Structure

The skeleton directory contains the actual file templates using Nunjucks syntax:

```
templates/go-microservice/
├── template.yaml
├── mkdocs.yml
├── docs/
│   ├── index.md
│   └── architecture.md
└── skeleton/
    ├── catalog-info.yaml
    ├── Dockerfile
    ├── Makefile
    ├── go.mod
    ├── main.go
    ├── .github/
    │   └── workflows/
    │       ├── ci.yaml
    │       └── release.yaml
    ├── k8s/
    │   ├── base/
    │   │   ├── kustomization.yaml
    │   │   ├── deployment.yaml
    │   │   ├── service.yaml
    │   │   ├── serviceaccount.yaml
    │   │   └── servicemonitor.yaml
    │   └── overlays/
    │       ├── production/
    │       │   └── kustomization.yaml
    │       └── staging/
    │           └── kustomization.yaml
    └── internal/
        ├── server/
        │   └── server.go
        └── metrics/
            └── metrics.go
```

Skeleton files use `${{ values.xxx }}` syntax:

```go
// skeleton/main.go
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/acme-corp/${{ values.serviceName }}/internal/server"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	slog.Info("starting ${{ values.serviceName }}",
		"service", "${{ values.serviceName }}",
		"version", os.Getenv("APP_VERSION"),
	)

	srv := server.New(server.Config{
		Port:        8080,
		MetricsPort: 9090,
	})

	ctx, cancel := signal.NotifyContext(context.Background(),
		syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	if err := srv.Run(ctx); err != nil {
		slog.Error("server failed", "error", err)
		os.Exit(1)
	}
}
```

```yaml
# skeleton/catalog-info.yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: ${{ values.serviceName }}
  title: ${{ values.serviceName | title }}
  description: ${{ values.serviceDescription }}
  annotations:
    github.com/project-slug: acme-corp/${{ values.serviceName }}
    backstage.io/kubernetes-id: ${{ values.serviceName }}
    backstage.io/kubernetes-namespace: ${{ values.namespace }}
    backstage.io/techdocs-ref: dir:.
  tags:
    - go
    - microservice
spec:
  type: service
  lifecycle: experimental
  owner: ${{ values.owner }}
  system: ${{ values.system }}
```

### Custom Scaffolder Actions

Extend the scaffolder with organization-specific actions:

```typescript
// packages/backend/src/plugins/scaffolderActions.ts
import { createTemplateAction } from '@backstage/plugin-scaffolder-backend';
import { z } from 'zod';
import { Octokit } from '@octokit/rest';

export const createGitHubBranchProtectionAction = () => {
  return createTemplateAction({
    id: 'acme:github:branch-protection',
    description: 'Apply standard branch protection rules to a GitHub repository',
    schema: {
      input: z.object({
        repoUrl: z.string().describe('Repository URL'),
        requireCodeOwners: z.boolean().default(true),
        requiredApprovals: z.number().default(2),
        requireLinearHistory: z.boolean().default(true),
      }),
    },
    async handler(ctx) {
      const { repoUrl, requireCodeOwners, requiredApprovals, requireLinearHistory } = ctx.input;

      // Parse owner/repo from URL
      const url = new URL(repoUrl);
      const [owner, repo] = url.pathname.slice(1).split('/');

      const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

      ctx.logger.info(`Applying branch protection to ${owner}/${repo}`);

      await octokit.repos.updateBranchProtection({
        owner,
        repo,
        branch: 'main',
        required_status_checks: {
          strict: true,
          contexts: ['ci/build', 'ci/test', 'ci/lint', 'security/snyk'],
        },
        enforce_admins: false,
        required_pull_request_reviews: {
          dismiss_stale_reviews: true,
          require_code_owner_reviews: requireCodeOwners,
          required_approving_review_count: requiredApprovals,
        },
        restrictions: null,
        allow_force_pushes: false,
        allow_deletions: false,
        required_linear_history: requireLinearHistory,
      });

      ctx.logger.info('Branch protection applied successfully');
    },
  });
};

export const createPagerDutyServiceAction = () => {
  return createTemplateAction({
    id: 'acme:pagerduty:create-service',
    description: 'Create a PagerDuty service for a new component',
    schema: {
      input: z.object({
        serviceName: z.string(),
        escalationPolicyId: z.string(),
        teamId: z.string(),
      }),
      output: z.object({
        serviceId: z.string(),
        serviceUrl: z.string(),
      }),
    },
    async handler(ctx) {
      const { serviceName, escalationPolicyId, teamId } = ctx.input;

      const response = await fetch('https://api.pagerduty.com/services', {
        method: 'POST',
        headers: {
          'Authorization': `Token token=${process.env.PAGERDUTY_API_KEY}`,
          'Content-Type': 'application/json',
          'Accept': 'application/vnd.pagerduty+json;version=2',
        },
        body: JSON.stringify({
          service: {
            name: serviceName,
            description: `Auto-created service for ${serviceName}`,
            status: 'active',
            escalation_policy: { id: escalationPolicyId, type: 'escalation_policy_reference' },
            teams: [{ id: teamId, type: 'team_reference' }],
            incident_urgency_rule: {
              type: 'constant',
              urgency: 'high',
            },
            alert_creation: 'create_alerts_and_incidents',
          },
        }),
      });

      const data = await response.json();

      ctx.output('serviceId', data.service.id);
      ctx.output('serviceUrl', data.service.html_url);

      ctx.logger.info(`PagerDuty service created: ${data.service.id}`);
    },
  });
};
```

## Kubernetes Integration

### Backstage Kubernetes Plugin Configuration

The Kubernetes plugin lets developers see their service's pods, deployments, and events directly in Backstage:

```yaml
# app-config.yaml
kubernetes:
  serviceLocatorMethod:
    type: "multiTenant"
  clusterLocatorMethods:
    - type: "config"
      clusters:
        - url: https://k8s-production.internal.acme.com
          name: production
          authProvider: serviceAccount
          serviceAccountToken: ${K8S_PRODUCTION_SA_TOKEN}
          caData: ${K8S_PRODUCTION_CA}
          customResources:
            - group: "argoproj.io"
              apiVersion: "v1alpha1"
              plural: "rollouts"
        - url: https://k8s-staging.internal.acme.com
          name: staging
          authProvider: serviceAccount
          serviceAccountToken: ${K8S_STAGING_SA_TOKEN}
          caData: ${K8S_STAGING_CA}
```

Create a ServiceAccount in each cluster for Backstage:

```yaml
# rbac/backstage-kubernetes.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: backstage
  namespace: backstage
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: backstage-read
rules:
  - apiGroups: [""]
    resources:
      - pods
      - pods/log
      - services
      - configmaps
      - limitranges
      - resourcequotas
      - namespaces
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources:
      - deployments
      - replicasets
      - statefulsets
      - daemonsets
    verbs: ["get", "list", "watch"]
  - apiGroups: ["autoscaling"]
    resources: ["horizontalpodautoscalers"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["ingresses"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["argoproj.io"]
    resources: ["rollouts"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["metrics.k8s.io"]
    resources: ["pods"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: backstage-read
subjects:
  - kind: ServiceAccount
    name: backstage
    namespace: backstage
roleRef:
  kind: ClusterRole
  name: backstage-read
  apiGroup: rbac.authorization.k8s.io
```

## TechDocs Configuration

TechDocs turns Markdown documentation into searchable, navigable docs sites within Backstage.

### Service Documentation Structure

```
my-service/
├── catalog-info.yaml
├── mkdocs.yml
└── docs/
    ├── index.md
    ├── architecture.md
    ├── runbooks/
    │   ├── deployment.md
    │   ├── incident-response.md
    │   └── scaling.md
    └── api/
        └── endpoints.md
```

```yaml
# mkdocs.yml
site_name: "Payments Service"
site_description: "Documentation for the Payments Service"

nav:
  - Overview: index.md
  - Architecture: architecture.md
  - Runbooks:
    - Deployment: runbooks/deployment.md
    - Incident Response: runbooks/incident-response.md
    - Scaling: runbooks/scaling.md
  - API Reference: api/endpoints.md

plugins:
  - techdocs-core
```

### External TechDocs Builder with Cloud Storage

For production, pre-build docs in CI and publish to cloud storage:

```yaml
# .github/workflows/techdocs.yaml
name: TechDocs Build and Publish

on:
  push:
    branches: [main]
    paths:
      - docs/**
      - mkdocs.yml
      - catalog-info.yaml

jobs:
  publish-techdocs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.11"

      - name: Install TechDocs CLI
        run: npm install -g @techdocs/cli

      - name: Install mkdocs dependencies
        run: pip install mkdocs mkdocs-techdocs-core

      - name: Authenticate to GCS
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ secrets.WIF_PROVIDER }}
          service_account: techdocs-publisher@acme-platform.iam.gserviceaccount.com

      - name: Build and Publish TechDocs
        run: |
          techdocs-cli generate --no-docker --source-dir . --output-dir ./site

          techdocs-cli publish \
            --publisher-type googleGcs \
            --storage-name acme-techdocs \
            --entity default/Component/payments-service \
            --directory ./site
```

## Permissions and Access Control

Backstage supports fine-grained permissions through the permissions framework:

```typescript
// packages/backend/src/plugins/permission.ts
import { createRouter } from '@backstage/plugin-permission-backend';
import {
  AuthorizeResult,
  PolicyDecision,
  isPermission,
} from '@backstage/plugin-permission-common';
import {
  catalogConditions,
  createCatalogConditionalDecision,
} from '@backstage/plugin-catalog-backend/alpha';

class AcmePermissionPolicy {
  async handle(request: PolicyQuery, user?: PolicyQueryUser): Promise<PolicyDecision> {
    const { permission } = request;

    // Platform team has full access
    if (user?.info.ownershipEntityRefs?.includes('group:default/platform-team')) {
      return { result: AuthorizeResult.ALLOW };
    }

    // Catalog read is open to all authenticated users
    if (isPermission(permission, catalogEntityReadPermission)) {
      return { result: AuthorizeResult.ALLOW };
    }

    // Scaffolder execution requires authentication
    if (isPermission(permission, scaffolderExecutePermission)) {
      if (!user) return { result: AuthorizeResult.DENY };
      return { result: AuthorizeResult.ALLOW };
    }

    // Catalog entity unregister restricted to owners
    if (isPermission(permission, catalogEntityDeletePermission)) {
      return createCatalogConditionalDecision(
        permission,
        catalogConditions.isEntityOwner({
          claims: user?.info.ownershipEntityRefs ?? [],
        }),
      );
    }

    return { result: AuthorizeResult.DENY };
  }
}
```

## Measuring Platform Success

Track platform adoption and impact:

```yaml
# platform-metrics/dashboard.yaml
# Grafana dashboard for platform KPIs
panels:
  - title: "Services Onboarded to Backstage"
    query: "count(backstage_catalog_entities_total{kind='Component'})"

  - title: "Golden Path Template Usage (30d)"
    query: "increase(backstage_scaffolder_task_count_total[30d])"

  - title: "Documentation Coverage"
    query: |
      count(backstage_catalog_entities_total{has_techdocs='true'}) /
      count(backstage_catalog_entities_total{kind='Component'}) * 100

  - title: "Mean Time to Onboard New Service"
    query: "histogram_quantile(0.50, backstage_scaffolder_task_duration_seconds_bucket)"
```

## Production Operational Considerations

### High Availability

```yaml
# backstage deployment for HA
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
      maxSurge: 1
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app: backstage
          topologyKey: kubernetes.io/hostname
```

### Database Connection Pooling

Configure PgBouncer in front of PostgreSQL to handle connection pooling for multiple Backstage replicas:

```ini
; pgbouncer.ini
[databases]
backstage_plugin_catalog = host=postgres port=5432 dbname=backstage_plugin_catalog
backstage_plugin_auth = host=postgres port=5432 dbname=backstage_plugin_auth
backstage_plugin_scaffolder = host=postgres port=5432 dbname=backstage_plugin_scaffolder

[pgbouncer]
pool_mode = transaction
max_client_conn = 200
default_pool_size = 25
min_pool_size = 5
reserve_pool_size = 5
reserve_pool_timeout = 5
server_idle_timeout = 600
client_idle_timeout = 0
```

### Backup Strategy

```bash
#!/bin/bash
# backstage-backup.sh

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_BUCKET="gs://acme-backstage-backups"

# Backup all Backstage databases
for DB in backstage_plugin_catalog backstage_plugin_auth backstage_plugin_scaffolder; do
  pg_dump \
    -h "$POSTGRES_HOST" \
    -U "$POSTGRES_USER" \
    -d "$DB" \
    --format=custom \
    --compress=9 \
    | gsutil cp - "${BACKUP_BUCKET}/${DB}/${TIMESTAMP}.dump"
done

# Retain 30 days of backups
gsutil -m rm $(gsutil ls "${BACKUP_BUCKET}/**" | \
  sort | head -n -30) 2>/dev/null || true
```

## Conclusion

Backstage transforms the developer experience by centralizing software discovery, documentation, and provisioning into a single coherent interface. The combination of a living software catalog and opinionated golden path templates dramatically reduces the time it takes to get a new service into production while ensuring compliance with organizational standards.

The key to successful Backstage adoption is starting with high-quality golden path templates that developers actually want to use, and ensuring the software catalog provides genuine value — real links to dashboards, runbooks, and on-call information. When Backstage becomes the single source of truth for "where is my service running and who do I call when it breaks," adoption follows naturally.

Platform teams should measure success through adoption metrics: percentage of services with catalog entries, golden path template usage rates, and time-to-production for new services. These metrics demonstrate the business value of platform engineering investment and guide future platform development priorities.
