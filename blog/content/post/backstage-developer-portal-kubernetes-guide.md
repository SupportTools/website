---
title: "Backstage Developer Portal on Kubernetes: Service Catalog, TechDocs, and Templates"
date: 2027-07-09T00:00:00-05:00
draft: false
tags: ["Backstage", "Platform Engineering", "Kubernetes", "Developer Experience"]
categories: ["Platform Engineering", "Kubernetes", "Developer Experience"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to deploying Backstage on Kubernetes with service catalog, TechDocs automated documentation, software templates for golden paths, RBAC, PostgreSQL backend, and plugin integrations."
more_link: "yes"
url: "/backstage-developer-portal-kubernetes-guide/"
---

Backstage, originally developed by Spotify and donated to the CNCF, has become the de facto standard for internal developer portals in enterprise Kubernetes environments. By centralizing service discovery, documentation, scaffolding, and plugin-driven integrations, Backstage transforms fragmented developer tooling into a coherent platform that dramatically reduces cognitive load and accelerates onboarding. This guide covers production-grade deployment of Backstage on Kubernetes, covering service catalog registration, TechDocs pipelines, software templates for golden paths, RBAC configuration, and the plugin ecosystem.

<!--more-->

## Executive Summary

Platform engineering teams investing in Backstage gain a unified interface for every developer-facing concern: discovering which services exist and who owns them, reading current documentation, scaffolding new projects from organizational standards, and navigating integrations with CI/CD, monitoring, and cloud infrastructure. This guide demonstrates a full Kubernetes deployment using Helm, a PostgreSQL backend, GitHub authentication, TechDocs with S3 publishing, and software templates that embody golden-path development workflows.

## Backstage Architecture

### Core Components

Backstage is a Node.js monorepo composed of three runtime packages:

```
backstage/
├── packages/
│   ├── app/         # React frontend
│   └── backend/     # Express backend
└── plugins/         # First-party and community plugins
```

The backend exposes a REST API consumed by the frontend and serves as the integration hub for all external systems. The catalog, scaffolder, TechDocs, and search subsystems each have dedicated backend plugins that register their own API routes and database tables.

### Database Layer

Production deployments require PostgreSQL. Backstage creates schema-per-plugin namespacing within a single database:

```
backstage_catalog
backstage_scaffolder
backstage_techdocs
backstage_search
backstage_auth
```

### Component Model

Every entity in the service catalog is described by a YAML descriptor file:

```
Kind         Description
─────────────────────────────────────────────────────
Component    A software component (service, library, website)
API          An API exposed by a component
System       A logical group of components
Domain       A business domain grouping systems
Resource     Infrastructure resources (databases, queues)
Group        An organizational team
User         An individual engineer
Location     A pointer to entity descriptor files
```

## Prerequisites

### Infrastructure Requirements

- Kubernetes 1.26+
- PostgreSQL 13+ (RDS, Cloud SQL, or in-cluster)
- Object storage for TechDocs (S3, GCS, or Azure Blob)
- GitHub, GitLab, or Azure DevOps for SCM integration
- Ingress controller with TLS termination

### Namespace and RBAC Setup

```bash
kubectl create namespace backstage

kubectl create serviceaccount backstage \
  --namespace backstage

kubectl create clusterrolebinding backstage-read \
  --clusterrole=view \
  --serviceaccount=backstage:backstage
```

## PostgreSQL Backend Configuration

### In-Cluster PostgreSQL with Helm

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update

helm install backstage-postgresql bitnami/postgresql \
  --namespace backstage \
  --set auth.username=backstage \
  --set auth.password=changeme \
  --set auth.database=backstage \
  --set primary.persistence.size=20Gi \
  --set primary.resources.requests.cpu=500m \
  --set primary.resources.requests.memory=512Mi
```

### Database Secret

```yaml
# backstage-db-secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: backstage-postgresql
  namespace: backstage
type: Opaque
stringData:
  POSTGRES_HOST: backstage-postgresql.backstage.svc.cluster.local
  POSTGRES_PORT: "5432"
  POSTGRES_USER: backstage
  POSTGRES_PASSWORD: changeme
  POSTGRES_DB: backstage
```

```bash
kubectl apply -f backstage-db-secret.yaml
```

## Building the Backstage Application Image

### app-config.yaml

The base configuration file drives all backend behavior:

```yaml
# app-config.yaml
app:
  title: Acme Developer Portal
  baseUrl: https://backstage.acme.internal

organization:
  name: Acme Engineering

backend:
  baseUrl: https://backstage.acme.internal
  listen:
    port: 7007
  csp:
    connect-src: ["'self'", 'http:', 'https:']
  cors:
    origin: https://backstage.acme.internal
    methods: [GET, HEAD, PATCH, POST, PUT, DELETE]
    credentials: true
  database:
    client: pg
    connection:
      host: ${POSTGRES_HOST}
      port: ${POSTGRES_PORT}
      user: ${POSTGRES_USER}
      password: ${POSTGRES_PASSWORD}
      database: ${POSTGRES_DB}
      ssl:
        rejectUnauthorized: false
  cache:
    store: memory
  reading:
    allow:
      - host: '*.acme.internal'
      - host: github.com
      - host: '*.githubusercontent.com'

integrations:
  github:
    - host: github.com
      token: ${GITHUB_TOKEN}

auth:
  environment: production
  providers:
    github:
      production:
        clientId: ${AUTH_GITHUB_CLIENT_ID}
        clientSecret: ${AUTH_GITHUB_CLIENT_SECRET}

catalog:
  import:
    entityFilename: catalog-info.yaml
    pullRequestBranchName: backstage-integration
  rules:
    - allow: [Component, System, API, Resource, Location, Group, User, Domain, Template]
  locations:
    - type: url
      target: https://github.com/acme/backstage-catalog/blob/main/all-components.yaml
    - type: url
      target: https://github.com/acme/backstage-catalog/blob/main/all-teams.yaml

techdocs:
  builder: external
  generator:
    runIn: local
  publisher:
    type: awsS3
    awsS3:
      bucketName: acme-techdocs
      region: us-east-1
      bucketRootPath: '/'

scaffolder:
  defaultAuthor:
    name: Backstage Scaffolder
    email: scaffolder@acme.internal
  defaultCommitMessage: "feat: scaffold from Backstage template"

search:
  pg:
    highlightOptions:
      useHighlight: true
      maxWord: 35
      minWord: 15
      shortWord: 3
      highlightAll: false
      maxFragments: 10
      fragmentDelimiter: ' ... '

kubernetes:
  serviceLocatorMethod:
    type: multiTenant
  clusterLocatorMethods:
    - type: config
      clusters:
        - url: https://kubernetes.default.svc
          name: in-cluster
          authProvider: serviceAccount
          skipTLSVerify: false
          skipMetricsLookup: false
```

### Production app-config.production.yaml

```yaml
# app-config.production.yaml
backend:
  reading:
    allow:
      - host: '*.acme.internal'

auth:
  session:
    secret: ${AUTH_SESSION_SECRET}

catalog:
  processingInterval: { minutes: 30 }

techdocs:
  publisher:
    type: awsS3
    awsS3:
      bucketName: acme-techdocs-prod
      region: us-east-1
      endpoint: ~
      s3ForcePathStyle: false
```

### Dockerfile

```dockerfile
FROM node:20-bookworm-slim AS base

RUN apt-get update && apt-get install -y \
    python3 \
    g++ \
    build-essential \
    libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS build
COPY package.json yarn.lock ./
COPY packages/app/package.json packages/app/
COPY packages/backend/package.json packages/backend/
COPY plugins/ plugins/

RUN yarn install --frozen-lockfile --network-timeout 600000

COPY . .
RUN yarn tsc
RUN yarn build:all

FROM base AS runtime

ENV NODE_ENV production
ENV NODE_OPTIONS "--max-old-space-size=1536"

WORKDIR /app

COPY --from=build /app/yarn.lock /app/package.json ./
COPY --from=build /app/packages/backend/dist ./packages/backend/dist
COPY --from=build /app/packages/backend/package.json ./packages/backend/
COPY --from=build /app/node_modules ./node_modules

CMD ["node", "packages/backend", "--config", "app-config.yaml", "--config", "app-config.production.yaml"]
```

## Kubernetes Deployment

### Secrets

```yaml
# backstage-secrets.yaml
apiVersion: v1
kind: Secret
metadata:
  name: backstage-secrets
  namespace: backstage
type: Opaque
stringData:
  GITHUB_TOKEN: GITHUB_PAT_REPLACE_ME
  AUTH_GITHUB_CLIENT_ID: your-github-oauth-app-client-id
  AUTH_GITHUB_CLIENT_SECRET: your-github-oauth-app-client-secret
  AUTH_SESSION_SECRET: a-long-random-secret-string-replace-me
  AWS_ACCESS_KEY_ID: REPLACE_WITH_AWS_KEY_ID
  AWS_SECRET_ACCESS_KEY: REPLACE_WITH_AWS_SECRET_KEY
```

### Deployment Manifest

```yaml
# backstage-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backstage
  namespace: backstage
  labels:
    app: backstage
spec:
  replicas: 2
  selector:
    matchLabels:
      app: backstage
  template:
    metadata:
      labels:
        app: backstage
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "7007"
        prometheus.io/path: "/metrics"
    spec:
      serviceAccountName: backstage
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
      containers:
        - name: backstage
          image: acme/backstage:1.0.0
          imagePullPolicy: Always
          ports:
            - name: http
              containerPort: 7007
          envFrom:
            - secretRef:
                name: backstage-postgresql
            - secretRef:
                name: backstage-secrets
          resources:
            requests:
              cpu: 500m
              memory: 1Gi
            limits:
              cpu: 2000m
              memory: 2Gi
          readinessProbe:
            httpGet:
              path: /healthcheck
              port: 7007
            initialDelaySeconds: 30
            periodSeconds: 10
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /healthcheck
              port: 7007
            initialDelaySeconds: 60
            periodSeconds: 20
            failureThreshold: 5
          volumeMounts:
            - name: app-config
              mountPath: /app/app-config.yaml
              subPath: app-config.yaml
            - name: app-config-production
              mountPath: /app/app-config.production.yaml
              subPath: app-config.production.yaml
      volumes:
        - name: app-config
          configMap:
            name: backstage-app-config
        - name: app-config-production
          configMap:
            name: backstage-app-config-production
```

### Service and Ingress

```yaml
# backstage-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: backstage
  namespace: backstage
spec:
  selector:
    app: backstage
  ports:
    - name: http
      port: 80
      targetPort: 7007
---
# backstage-ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: backstage
  namespace: backstage
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/proxy-body-size: "50m"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "600"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - backstage.acme.internal
      secretName: backstage-tls
  rules:
    - host: backstage.acme.internal
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: backstage
                port:
                  name: http
```

## Service Catalog and Component Registration

### Component Descriptor

Every service repository should contain a `catalog-info.yaml` at its root:

```yaml
# catalog-info.yaml (in service repository)
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: payment-service
  title: Payment Service
  description: Handles payment processing and reconciliation for all order flows
  annotations:
    github.com/project-slug: acme/payment-service
    backstage.io/techdocs-ref: dir:.
    backstage.io/kubernetes-id: payment-service
    backstage.io/kubernetes-namespace: payments
    grafana/dashboard-selector: "folderTitle='Payments'"
    pagerduty.com/service-id: P1234567
    sonarqube.org/project-key: acme_payment-service
  labels:
    domain: commerce
    tier: critical
  tags:
    - go
    - grpc
    - payments
  links:
    - url: https://grafana.acme.internal/d/payments
      title: Grafana Dashboard
      icon: dashboard
    - url: https://runbooks.acme.internal/payments
      title: Runbook
      icon: docs
spec:
  type: service
  lifecycle: production
  owner: group:payments-team
  system: commerce-platform
  dependsOn:
    - resource:default/payments-postgresql
    - component:default/notification-service
  providesApis:
    - payment-api
```

### API Descriptor

```yaml
# payment-api.yaml
apiVersion: backstage.io/v1alpha1
kind: API
metadata:
  name: payment-api
  description: REST API for payment operations
  annotations:
    backstage.io/techdocs-ref: dir:./docs/api
  tags:
    - rest
    - openapi
spec:
  type: openapi
  lifecycle: production
  owner: group:payments-team
  system: commerce-platform
  definition:
    $text: ./openapi.yaml
```

### System and Domain Descriptors

```yaml
# commerce-system.yaml
apiVersion: backstage.io/v1alpha1
kind: System
metadata:
  name: commerce-platform
  description: End-to-end commerce capabilities including cart, checkout, payments
  tags:
    - commerce
spec:
  owner: group:commerce-platform-team
  domain: commerce
---
apiVersion: backstage.io/v1alpha1
kind: Domain
metadata:
  name: commerce
  description: Commerce domain covering customer purchasing journeys
spec:
  owner: group:commerce-platform-team
```

### Catalog Location Index

```yaml
# all-components.yaml (in backstage-catalog repo)
apiVersion: backstage.io/v1alpha1
kind: Location
metadata:
  name: all-components
spec:
  targets:
    - https://github.com/acme/payment-service/blob/main/catalog-info.yaml
    - https://github.com/acme/order-service/blob/main/catalog-info.yaml
    - https://github.com/acme/inventory-service/blob/main/catalog-info.yaml
    - https://github.com/acme/notification-service/blob/main/catalog-info.yaml
    - https://github.com/acme/user-service/blob/main/catalog-info.yaml
```

## TechDocs Automated Documentation

### mkdocs.yml Configuration

Each component with TechDocs requires an `mkdocs.yml` in its repository root:

```yaml
# mkdocs.yml
site_name: Payment Service
site_description: Documentation for the Payment Service
docs_dir: docs
nav:
  - Home: index.md
  - Architecture:
      - Overview: architecture/overview.md
      - Data Flow: architecture/data-flow.md
      - ADR: architecture/adr/
  - API Reference:
      - REST API: api/rest.md
      - gRPC: api/grpc.md
  - Operations:
      - Deployment: ops/deployment.md
      - Runbook: ops/runbook.md
      - Alerts: ops/alerts.md
  - Development:
      - Getting Started: dev/getting-started.md
      - Testing: dev/testing.md

plugins:
  - techdocs-core

markdown_extensions:
  - admonition
  - pymdownx.details
  - pymdownx.highlight:
      anchor_linenums: true
  - pymdownx.superfences
  - pymdownx.tabbed:
      alternate_style: true
  - attr_list
  - tables
```

### TechDocs CI Pipeline (GitHub Actions)

```yaml
# .github/workflows/techdocs.yaml
name: Publish TechDocs

on:
  push:
    branches: [main]
    paths:
      - 'docs/**'
      - 'mkdocs.yml'

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Setup Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Install TechDocs CLI
        run: npm install -g @techdocs/cli

      - name: Install MkDocs dependencies
        run: pip install mkdocs-techdocs-core

      - name: Generate TechDocs
        run: techdocs-cli generate --no-docker --verbose

      - name: Publish TechDocs to S3
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          AWS_REGION: us-east-1
        run: |
          techdocs-cli publish \
            --publisher-type awsS3 \
            --storage-name acme-techdocs-prod \
            --entity default/Component/payment-service
```

### ADR Documentation Structure

```
docs/
└── architecture/
    └── adr/
        ├── index.md
        ├── 0001-use-grpc-for-internal-communication.md
        ├── 0002-postgresql-as-primary-datastore.md
        └── 0003-event-sourcing-for-payment-state.md
```

Example ADR file:

```markdown
# ADR 0001: Use gRPC for Internal Communication

## Status
Accepted

## Context
Payment Service needs to communicate with Order Service and Inventory Service
with low latency and strong typing guarantees.

## Decision
Use gRPC with Protocol Buffers for all synchronous internal service communication.

## Consequences
- Strong type contracts between services
- Generated client code reduces boilerplate
- Requires proto file management across repositories
- HTTP/2 provides multiplexing and header compression
```

## Software Templates for Golden Paths

### Go Microservice Template

```yaml
# templates/go-microservice/template.yaml
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: go-microservice
  title: Go Microservice
  description: Creates a new Go microservice following Acme golden-path standards
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
        - description
        - owner
        - domain
      properties:
        name:
          title: Service Name
          type: string
          description: Unique name for the service (kebab-case)
          pattern: '^[a-z][a-z0-9-]*[a-z0-9]$'
          ui:autofocus: true
        description:
          title: Description
          type: string
          description: Brief description of what the service does
        owner:
          title: Owner Team
          type: string
          description: Team that owns this service
          ui:field: OwnerPicker
          ui:options:
            catalogFilter:
              kind: Group
        domain:
          title: Domain
          type: string
          enum:
            - commerce
            - identity
            - data
            - platform
          enumNames:
            - Commerce
            - Identity
            - Data
            - Platform
        lifecycle:
          title: Lifecycle
          type: string
          enum: [experimental, production, deprecated]
          default: experimental

    - title: Infrastructure
      properties:
        enableDatabase:
          title: PostgreSQL Database
          type: boolean
          default: false
        enableCache:
          title: Redis Cache
          type: boolean
          default: false
        enableKafka:
          title: Kafka Integration
          type: boolean
          default: false

    - title: Repository
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
            allowedOrganizations:
              - acme

  steps:
    - id: fetch-base
      name: Fetch Base Template
      action: fetch:template
      input:
        url: ./skeleton
        copyWithoutRender:
          - .github/workflows/*.yaml
        values:
          name: ${{ parameters.name }}
          description: ${{ parameters.description }}
          owner: ${{ parameters.owner }}
          domain: ${{ parameters.domain }}
          lifecycle: ${{ parameters.lifecycle }}
          enableDatabase: ${{ parameters.enableDatabase }}
          enableCache: ${{ parameters.enableCache }}
          enableKafka: ${{ parameters.enableKafka }}

    - id: publish
      name: Publish to GitHub
      action: publish:github
      input:
        allowedHosts: ['github.com']
        description: ${{ parameters.description }}
        repoUrl: ${{ parameters.repoUrl }}
        defaultBranch: main
        repoVisibility: internal
        gitAuthorName: Backstage Scaffolder
        gitAuthorEmail: scaffolder@acme.internal
        topics:
          - ${{ parameters.domain }}
          - go
          - microservice

    - id: register
      name: Register in Catalog
      action: catalog:register
      input:
        repoContentsUrl: ${{ steps['publish'].output.repoContentsUrl }}
        catalogInfoPath: /catalog-info.yaml

    - id: create-argocd-app
      name: Create ArgoCD Application
      action: argocd:create-resources
      input:
        appName: ${{ parameters.name }}
        argoInstance: main
        namespace: ${{ parameters.name }}
        repoUrl: ${{ steps['publish'].output.remoteUrl }}
        labelValue: ${{ parameters.name }}
        path: helm/
        valueFiles:
          - values-dev.yaml

  output:
    links:
      - title: Repository
        url: ${{ steps['publish'].output.remoteUrl }}
      - title: Open in Catalog
        icon: catalog
        entityRef: ${{ steps['register'].output.entityRef }}
      - title: ArgoCD Application
        url: https://argocd.acme.internal/applications/${{ parameters.name }}
```

### Template Skeleton Structure

```
templates/go-microservice/skeleton/
├── catalog-info.yaml
├── mkdocs.yml
├── docs/
│   └── index.md
├── cmd/
│   └── ${{ values.name }}/
│       └── main.go
├── internal/
│   ├── config/
│   └── server/
├── helm/
│   ├── Chart.yaml
│   ├── values.yaml
│   ├── values-dev.yaml
│   ├── values-staging.yaml
│   └── templates/
├── .github/
│   └── workflows/
│       ├── ci.yaml
│       └── techdocs.yaml
├── Dockerfile
├── Makefile
└── README.md
```

Example skeleton `catalog-info.yaml`:

```yaml
# ${{ values.name }}/catalog-info.yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: ${{ values.name }}
  description: ${{ values.description }}
  annotations:
    github.com/project-slug: acme/${{ values.name }}
    backstage.io/techdocs-ref: dir:.
    backstage.io/kubernetes-id: ${{ values.name }}
  tags:
    - go
    - ${{ values.domain }}
spec:
  type: service
  lifecycle: ${{ values.lifecycle }}
  owner: ${{ values.owner }}
  system: ${{ values.domain }}-platform
```

## Kubernetes Plugin Integration

### Plugin Configuration

```typescript
// packages/backend/src/plugins/kubernetes.ts
import { KubernetesBuilder } from '@backstage/plugin-kubernetes-backend';
import { Router } from 'express';
import { PluginEnvironment } from '../types';
import { CatalogClient } from '@backstage/catalog-client';

export default async function createPlugin(
  env: PluginEnvironment,
): Promise<Router> {
  const catalogApi = new CatalogClient({ discoveryApi: env.discovery });
  const { router } = await KubernetesBuilder.createBuilder({
    logger: env.logger,
    config: env.config,
    catalogApi,
    permissions: env.permissions,
  }).build();
  return router;
}
```

### Cluster RBAC for Backstage Service Account

```yaml
# backstage-cluster-role.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: backstage-kubernetes-plugin
rules:
  - apiGroups: ['']
    resources:
      - pods
      - pods/log
      - services
      - endpoints
      - replicationcontrollers
      - configmaps
    verbs: [get, list, watch]
  - apiGroups: [apps]
    resources:
      - deployments
      - replicasets
      - statefulsets
      - daemonsets
    verbs: [get, list, watch]
  - apiGroups: [batch]
    resources:
      - jobs
      - cronjobs
    verbs: [get, list, watch]
  - apiGroups: [autoscaling]
    resources:
      - horizontalpodautoscalers
    verbs: [get, list, watch]
  - apiGroups: [networking.k8s.io]
    resources:
      - ingresses
    verbs: [get, list, watch]
  - apiGroups: [metrics.k8s.io]
    resources:
      - pods
      - nodes
    verbs: [get, list]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: backstage-kubernetes-plugin
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: backstage-kubernetes-plugin
subjects:
  - kind: ServiceAccount
    name: backstage
    namespace: backstage
```

## RBAC and Authentication

### GitHub OAuth Configuration

Register a GitHub OAuth App with:
- Homepage URL: `https://backstage.acme.internal`
- Callback URL: `https://backstage.acme.internal/api/auth/github/handler/frame`

### Sign-In Resolver

```typescript
// packages/backend/src/plugins/auth.ts
import {
  createRouter,
  providers,
  defaultAuthProviderFactories,
} from '@backstage/plugin-auth-backend';
import { Router } from 'express';
import { PluginEnvironment } from '../types';

export default async function createPlugin(
  env: PluginEnvironment,
): Promise<Router> {
  return await createRouter({
    logger: env.logger,
    config: env.config,
    database: env.database,
    discovery: env.discovery,
    tokenManager: env.tokenManager,
    providerFactories: {
      ...defaultAuthProviderFactories,
      github: providers.github.create({
        signIn: {
          resolver: providers.github.resolvers.usernameMatchingUserEntityName(),
        },
      }),
    },
  });
}
```

### Catalog-Based RBAC with Permissions

```yaml
# permission-policy.yaml
apiVersion: backstage.io/v1alpha1
kind: PermissionPolicy
metadata:
  name: default
spec:
  rules:
    - name: allow-catalog-read
      effect: allow
      conditions:
        resourceType: catalog-entity
        rule: IS_ENTITY_OWNER
      permissions:
        - catalog.entity.update
        - catalog.entity.delete

    - name: platform-team-admin
      effect: allow
      conditions:
        resourceType: catalog-entity
        rule: HAS_LABEL
        params:
          label: platform
      permissions:
        - catalog.entity.read
        - catalog.entity.update
```

### Team Descriptor Registration

```yaml
# teams.yaml
apiVersion: backstage.io/v1alpha1
kind: Group
metadata:
  name: payments-team
  description: Team responsible for payment processing
spec:
  type: team
  profile:
    displayName: Payments Team
    email: payments-team@acme.internal
  parent: engineering
  children: []
  members:
    - alice
    - bob
    - charlie
---
apiVersion: backstage.io/v1alpha1
kind: User
metadata:
  name: alice
spec:
  profile:
    displayName: Alice Smith
    email: alice@acme.internal
    picture: https://avatars.acme.internal/alice
  memberOf:
    - payments-team
```

## Plugin Ecosystem

### Installing Core Plugins

```bash
# In the Backstage app directory
yarn --cwd packages/app add \
  @backstage/plugin-catalog \
  @backstage/plugin-catalog-react \
  @backstage/plugin-techdocs \
  @backstage/plugin-scaffolder \
  @backstage/plugin-search \
  @backstage/plugin-kubernetes \
  @backstage/plugin-github-actions \
  @backstage/plugin-pagerduty \
  @roadiehq/backstage-plugin-github-insights \
  @backstage/plugin-cost-insights

yarn --cwd packages/backend add \
  @backstage/plugin-catalog-backend \
  @backstage/plugin-techdocs-backend \
  @backstage/plugin-scaffolder-backend \
  @backstage/plugin-search-backend \
  @backstage/plugin-kubernetes-backend \
  @backstage/plugin-auth-backend
```

### Prometheus/Grafana Plugin Integration

```typescript
// packages/app/src/components/catalog/EntityPage.tsx (excerpt)
import { EntityPrometheusGraphCard } from '@roadiehq/backstage-plugin-prometheus';

const serviceEntityPage = (
  <EntityLayout>
    <EntityLayout.Route path="/" title="Overview">
      <Grid container spacing={3}>
        <Grid item md={6}>
          <EntityAboutCard variant="gridItem" />
        </Grid>
        <Grid item md={6}>
          <EntityPrometheusGraphCard />
        </Grid>
      </Grid>
    </EntityLayout.Route>
  </EntityLayout>
);
```

## Production Observability

### HorizontalPodAutoscaler

```yaml
# backstage-hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: backstage
  namespace: backstage
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: backstage
  minReplicas: 2
  maxReplicas: 6
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
```

### PodDisruptionBudget

```yaml
# backstage-pdb.yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: backstage
  namespace: backstage
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: backstage
```

### Prometheus ServiceMonitor

```yaml
# backstage-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: backstage
  namespace: backstage
  labels:
    app: backstage
spec:
  selector:
    matchLabels:
      app: backstage
  endpoints:
    - port: http
      path: /metrics
      interval: 30s
      scrapeTimeout: 10s
```

## Helm Chart Deployment

### values.yaml for Backstage Helm Chart

```yaml
# backstage helm values (using backstage/backstage chart)
backstage:
  image:
    registry: ghcr.io
    repository: acme/backstage
    tag: 1.0.0
    pullPolicy: Always

  args:
    - '--config'
    - app-config.yaml
    - '--config'
    - app-config.production.yaml

  extraEnvVarsSecrets:
    - backstage-postgresql
    - backstage-secrets

  resources:
    requests:
      cpu: 500m
      memory: 1Gi
    limits:
      cpu: 2000m
      memory: 2Gi

  livenessProbe:
    httpGet:
      path: /healthcheck
      port: 7007
    initialDelaySeconds: 60
    periodSeconds: 20

  readinessProbe:
    httpGet:
      path: /healthcheck
      port: 7007
    initialDelaySeconds: 30
    periodSeconds: 10

  podAnnotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "7007"

  extraAppConfig:
    - filename: app-config.yaml
      configMapRef: backstage-app-config
    - filename: app-config.production.yaml
      configMapRef: backstage-app-config-production

postgresql:
  enabled: false

ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
  host: backstage.acme.internal
  tls:
    enabled: true
    secretName: backstage-tls

serviceAccount:
  create: false
  name: backstage

networkPolicy:
  enabled: true
```

```bash
helm repo add backstage https://backstage.github.io/charts
helm repo update

helm upgrade --install backstage backstage/backstage \
  --namespace backstage \
  --values values.yaml \
  --wait \
  --timeout 10m
```

## Troubleshooting

### Catalog Refresh Issues

```bash
# Force refresh a specific entity
kubectl exec -n backstage deployment/backstage -- \
  curl -s -X POST \
  "http://localhost:7007/api/catalog/refresh" \
  -H "Content-Type: application/json" \
  -d '{"entityRef": "component:default/payment-service"}'

# Check catalog processing logs
kubectl logs -n backstage deployment/backstage \
  --since=1h | grep -i "catalog\|refresh\|error"
```

### TechDocs Not Rendering

```bash
# Verify S3 bucket contents
aws s3 ls s3://acme-techdocs-prod/ --recursive | head -20

# Check TechDocs backend logs
kubectl logs -n backstage deployment/backstage \
  --since=30m | grep -i techdocs

# Manually trigger TechDocs build
techdocs-cli generate --no-docker
techdocs-cli publish \
  --publisher-type awsS3 \
  --storage-name acme-techdocs-prod \
  --entity default/Component/payment-service
```

### Database Connection Failures

```bash
# Test PostgreSQL connectivity from within the pod
kubectl exec -n backstage deployment/backstage -- \
  node -e "
const { Client } = require('pg');
const c = new Client({ host: process.env.POSTGRES_HOST, port: 5432, user: process.env.POSTGRES_USER, password: process.env.POSTGRES_PASSWORD, database: process.env.POSTGRES_DB });
c.connect().then(() => console.log('Connected')).catch(console.error);
"
```

## Summary

Backstage on Kubernetes delivers a unified developer portal that eliminates the scattered tooling problem plaguing engineering organizations at scale. The service catalog provides a single source of truth for component ownership and dependencies. TechDocs closes the gap between code and documentation. Software templates encode organizational best practices into repeatable golden paths that provision both code and infrastructure consistently. The plugin ecosystem extends these capabilities into every tool in the developer workflow, from CI/CD pipelines to production monitoring. Combined with PostgreSQL persistence, GitHub authentication, and Kubernetes-native deployment patterns, Backstage becomes the foundational layer of a mature internal developer platform.
