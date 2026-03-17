---
title: "Kubernetes Backstage Platform: Developer Portal with TechDocs and Software Catalog"
date: 2031-04-29T00:00:00-05:00
draft: false
tags: ["Backstage", "Kubernetes", "Developer Portal", "TechDocs", "Software Catalog", "Platform Engineering", "DevOps"]
categories: ["Kubernetes", "Platform Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Build a production-grade Backstage developer portal on Kubernetes with software catalog ingestion from GitHub/GitLab, TechDocs auto-generation, Kubernetes cluster status plugin, and Helm-based deployment."
more_link: "yes"
url: "/kubernetes-backstage-platform-developer-portal-techdocs-software-catalog/"
---

Backstage has become the standard for internal developer portals in large engineering organizations. Originally open-sourced by Spotify, it centralizes service catalogs, documentation, CI/CD status, cloud resources, and runbooks into a single pane of glass. This guide covers deploying Backstage on Kubernetes with a fully configured software catalog, TechDocs pipeline, and the Kubernetes plugin for live cluster visibility.

<!--more-->

# Kubernetes Backstage Platform: Developer Portal with TechDocs and Software Catalog

## Section 1: Backstage Architecture Overview

Backstage is a React frontend backed by a Node.js plugin-based server. Its architecture has three core pillars:

1. **Software Catalog** - a registry of all software components, APIs, resources, and teams
2. **TechDocs** - documentation-as-code, rendering MkDocs from source repositories
3. **Scaffolder** - templated service creation with software templates

The backend uses a PostgreSQL database for persistent state. Plugins extend both the frontend and backend. The catalog ingests from various sources (GitHub, GitLab, Bitbucket, static YAML) via a configurable processing loop.

```
┌─────────────────────────────────────────────────────────┐
│                    Backstage Application                  │
│                                                           │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │   Frontend  │  │   Backend    │  │   TechDocs     │  │
│  │  (React)    │  │  (Node.js)   │  │  (MkDocs/S3)   │  │
│  └──────┬──────┘  └──────┬───────┘  └───────┬────────┘  │
│         │                │                   │            │
│         └────────────────┼───────────────────┘            │
│                          │                               │
│              ┌───────────┴──────────┐                    │
│              │    PostgreSQL DB     │                    │
│              └──────────────────────┘                    │
└─────────────────────────────────────────────────────────┘
         │               │              │
    GitHub/GitLab    Kubernetes     Cloud Resources
    (Catalog)        (Plugin)       (AWS/GCP/Azure)
```

## Section 2: Prerequisites and Namespace Setup

Before deploying Backstage, ensure these prerequisites are met:

```bash
# Kubernetes 1.25+ with RBAC enabled
kubectl version --short

# Create dedicated namespace
kubectl create namespace backstage

# Label namespace for network policy selectors
kubectl label namespace backstage \
  app.kubernetes.io/managed-by=helm \
  environment=production

# Verify PostgreSQL operator or prepare external PostgreSQL
# We'll use a standalone PostgreSQL StatefulSet for this guide
```

Create the PostgreSQL credentials secret:

```bash
kubectl create secret generic backstage-postgresql \
  --namespace backstage \
  --from-literal=postgresql-password='<postgres-password>' \
  --from-literal=postgresql-postgres-password='<postgres-admin-password>'
```

Create the Backstage application secret for GitHub integration:

```bash
kubectl create secret generic backstage-secrets \
  --namespace backstage \
  --from-literal=GITHUB_TOKEN='<github-personal-access-token>' \
  --from-literal=GITLAB_TOKEN='<gitlab-personal-access-token>' \
  --from-literal=AUTH_GITHUB_CLIENT_ID='<github-oauth-app-client-id>' \
  --from-literal=AUTH_GITHUB_CLIENT_SECRET='<github-oauth-app-client-secret>'
```

## Section 3: Building the Backstage Docker Image

Backstage requires a custom Docker image because plugins are installed at build time.

Create a new Backstage application locally:

```bash
npx @backstage/create-app@latest --name my-backstage

cd my-backstage

# Install the Kubernetes plugin
yarn --cwd packages/app add @backstage/plugin-kubernetes
yarn --cwd packages/backend add @backstage/plugin-kubernetes-backend

# Install TechDocs
yarn --cwd packages/app add @backstage/plugin-techdocs
yarn --cwd packages/backend add @backstage/plugin-techdocs-backend @backstage/plugin-techdocs-node

# Install GitHub authentication
yarn --cwd packages/app add @backstage/plugin-auth-backend
yarn --cwd packages/backend add @backstage/plugin-auth-backend

# Install the catalog GitHub plugin
yarn --cwd packages/backend add @backstage/plugin-catalog-backend-module-github
```

The `packages/app/src/App.tsx` needs the Kubernetes and TechDocs routes:

```typescript
// packages/app/src/App.tsx
import { KubernetesPage } from '@backstage/plugin-kubernetes';
import {
  TechDocsIndexPage,
  TechDocsReaderPage,
} from '@backstage/plugin-techdocs';

// Inside the AppRouter:
<Route path="/kubernetes" element={<KubernetesPage />} />
<Route path="/docs" element={<TechDocsIndexPage />} />
<Route
  path="/docs/:namespace/:kind/:name/*"
  element={<TechDocsReaderPage />}
/>
```

Add the Kubernetes plugin to the entity page:

```typescript
// packages/app/src/components/catalog/EntityPage.tsx
import { EntityKubernetesContent } from '@backstage/plugin-kubernetes';

const serviceEntityPage = (
  <EntityLayout>
    <EntityLayout.Route path="/" title="Overview">
      {overviewContent}
    </EntityLayout.Route>
    <EntityLayout.Route path="/kubernetes" title="Kubernetes">
      <EntityKubernetesContent refreshIntervalMs={30000} />
    </EntityLayout.Route>
    <EntityLayout.Route path="/docs" title="Docs">
      <EntityTechdocsContent />
    </EntityLayout.Route>
  </EntityLayout>
);
```

The production Dockerfile:

```dockerfile
# Dockerfile
# Multi-stage build for Backstage

# Stage 1: Build the frontend and backend
FROM node:18-bookworm-slim AS build

# Install system dependencies for native modules
RUN apt-get update && apt-get install -y \
    python3 \
    g++ \
    build-essential \
    libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package.json yarn.lock ./
COPY packages/app/package.json packages/app/
COPY packages/backend/package.json packages/backend/

# Install dependencies
RUN yarn install --frozen-lockfile --network-timeout 600000

# Copy source
COPY . .

# Build frontend
RUN yarn tsc
RUN yarn --cwd packages/app build

# Build backend
RUN yarn --cwd packages/backend build

# Bundle backend dependencies
RUN mkdir -p packages/backend/dist/skeleton packages/backend/dist/bundle \
  && tar xzf packages/backend/dist/skeleton.tar.gz -C packages/backend/dist/skeleton \
  && tar xzf packages/backend/dist/bundle.tar.gz -C packages/backend/dist/bundle

# Stage 2: Production image
FROM node:18-bookworm-slim AS production

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    libsqlite3-dev \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Install mkdocs for TechDocs generation
RUN apt-get update && apt-get install -y \
    python3-pip \
    && pip3 install mkdocs mkdocs-techdocs-core==1.* \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy backend skeleton (node_modules structure)
COPY --from=build /app/packages/backend/dist/skeleton/ ./
RUN yarn install --frozen-lockfile --production --network-timeout 600000

# Copy built application
COPY --from=build /app/packages/backend/dist/bundle/ ./
COPY --from=build /app/packages/app/dist /app/packages/backend/dist/static

# Copy app config
COPY app-config.yaml ./
COPY app-config.production.yaml ./

# Create non-root user
RUN groupadd -r backstage && useradd -r -g backstage backstage
RUN chown -R backstage:backstage /app

USER backstage

EXPOSE 7007

CMD ["node", "packages/backend", "--config", "app-config.yaml", "--config", "app-config.production.yaml"]
```

## Section 4: app-config.yaml - Full Configuration

The `app-config.yaml` is the heart of Backstage configuration:

```yaml
# app-config.yaml - Base configuration
app:
  title: My Company Developer Portal
  baseUrl: http://localhost:3000

organization:
  name: My Company

backend:
  baseUrl: http://localhost:7007
  listen:
    port: 7007
    host: 0.0.0.0
  csp:
    connect-src: ["'self'", 'http:', 'https:']
    img-src: ["'self'", 'data:', 'https://avatars.githubusercontent.com']
  cors:
    origin: http://localhost:3000
    methods: [GET, HEAD, PATCH, POST, PUT, DELETE]
    credentials: true
  database:
    client: pg
    connection:
      host: ${POSTGRES_HOST}
      port: ${POSTGRES_PORT}
      user: ${POSTGRES_USER}
      password: ${POSTGRES_PASSWORD}
      database: backstage_plugin_catalog
  cache:
    store: memory

integrations:
  github:
    - host: github.com
      token: ${GITHUB_TOKEN}
  gitlab:
    - host: gitlab.com
      token: ${GITLAB_TOKEN}

proxy:
  endpoints:
    '/argocd/api':
      target: https://argocd.example.com/api/v1/
      changeOrigin: true
      headers:
        Cookie:
          $env: ARGOCD_AUTH_TOKEN

techdocs:
  builder: 'local' # Use 'external' for production with S3
  generator:
    runIn: 'local'
  publisher:
    type: 'local'

auth:
  environment: development
  providers:
    github:
      development:
        clientId: ${AUTH_GITHUB_CLIENT_ID}
        clientSecret: ${AUTH_GITHUB_CLIENT_SECRET}

scaffolder:
  defaultAuthor:
    name: Scaffolder
    email: scaffolder@example.com
  defaultCommitMessage: "feat: scaffolded new component"

catalog:
  import:
    entityFilename: catalog-info.yaml
    pullRequestBranchName: backstage-integration
  rules:
    - allow: [Component, System, API, Resource, Location, Template, User, Group]
  locations:
    # Static bootstrap location
    - type: url
      target: https://github.com/myorg/backstage-catalog/blob/main/all-components.yaml
      rules:
        - allow: [Location, Component, System, API, Resource, Group, User, Template]

  providers:
    github:
      myGithubOrg:
        organization: 'myorg'
        catalogPath: '/catalog-info.yaml'
        filters:
          branch: 'main'
          repository: '.*'
        schedule:
          frequency: { minutes: 30 }
          timeout: { minutes: 3 }

    gitlab:
      myGitlabGroup:
        host: gitlab.com
        orgEnabled: true
        group: 'mygroup'
        groupPattern: '.*'
        schedule:
          frequency: { minutes: 30 }
          timeout: { minutes: 3 }

kubernetes:
  serviceLocatorMethod:
    type: 'multiTenant'
  clusterLocatorMethods:
    - type: 'config'
      clusters:
        - url: https://kubernetes.default.svc
          name: production
          authProvider: 'serviceAccount'
          skipTLSVerify: false
          skipMetricsLookup: false
          serviceAccountToken: ${K8S_SERVICE_ACCOUNT_TOKEN}
          caData: ${K8S_CLUSTER_CA_DATA}
        - url: https://staging-k8s.example.com
          name: staging
          authProvider: 'serviceAccount'
          skipTLSVerify: false
          serviceAccountToken: ${K8S_STAGING_SERVICE_ACCOUNT_TOKEN}
          caData: ${K8S_STAGING_CA_DATA}
```

The production override file:

```yaml
# app-config.production.yaml
app:
  baseUrl: https://backstage.example.com

backend:
  baseUrl: https://backstage.example.com
  cors:
    origin: https://backstage.example.com

techdocs:
  builder: 'external'
  generator:
    runIn: 'docker'
    dockerImage: 'spotify/techdocs:v1.2.3'
    pullImage: false
  publisher:
    type: 'awsS3'
    awsS3:
      bucketName: my-company-techdocs
      region: us-east-1
      bucketRootPath: '/'
      s3ForcePathStyle: false

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
```

## Section 5: Software Catalog - catalog-info.yaml Patterns

Every service, API, and resource should have a `catalog-info.yaml` at the repository root.

### Component (Microservice)

```yaml
# catalog-info.yaml for a backend service
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: payment-service
  title: Payment Service
  description: Handles payment processing for orders
  annotations:
    github.com/project-slug: myorg/payment-service
    backstage.io/techdocs-ref: dir:.
    backstage.io/kubernetes-id: payment-service
    backstage.io/kubernetes-namespace: payments
    argocd/app-name: payment-service-prod
    prometheus.io/rule: |
      sum(rate(http_requests_total{job="payment-service"}[5m]))
    pagerduty.com/integration-key: <pagerduty-integration-key>
  tags:
    - payments
    - java
    - rest
  links:
    - url: https://grafana.example.com/d/payments
      title: Grafana Dashboard
      icon: dashboard
    - url: https://runbooks.example.com/payment-service
      title: Runbook
      icon: help
spec:
  type: service
  lifecycle: production
  owner: team-payments
  system: order-management
  dependsOn:
    - component:order-service
    - resource:payments-postgres-db
    - resource:stripe-api
  providesApis:
    - payment-api
  consumesApis:
    - notification-api
```

### API Definition

```yaml
# API catalog entry
apiVersion: backstage.io/v1alpha1
kind: API
metadata:
  name: payment-api
  description: REST API for payment operations
  annotations:
    backstage.io/techdocs-ref: dir:.
  tags:
    - rest
    - payments
spec:
  type: openapi
  lifecycle: production
  owner: team-payments
  system: order-management
  definition:
    $text: https://raw.githubusercontent.com/myorg/payment-service/main/openapi.yaml
```

### System

```yaml
# System grouping multiple components
apiVersion: backstage.io/v1alpha1
kind: System
metadata:
  name: order-management
  description: End-to-end order processing system
  tags:
    - core-domain
spec:
  owner: team-platform
  domain: ecommerce
```

### Resource (Database, Queue)

```yaml
apiVersion: backstage.io/v1alpha1
kind: Resource
metadata:
  name: payments-postgres-db
  description: PostgreSQL database for payment records
  annotations:
    backstage.io/kubernetes-id: payments-postgres
spec:
  type: database
  owner: team-dba
  system: order-management
```

### Group and User

```yaml
# groups.yaml
apiVersion: backstage.io/v1alpha1
kind: Group
metadata:
  name: team-payments
  description: Payments engineering team
spec:
  type: team
  profile:
    displayName: Payments Team
    email: payments-team@example.com
  parent: engineering
  children: []
  members:
    - jsmith
    - mjones

---
apiVersion: backstage.io/v1alpha1
kind: User
metadata:
  name: jsmith
spec:
  profile:
    displayName: Jane Smith
    email: jsmith@example.com
    picture: https://avatars.example.com/jsmith
  memberOf:
    - team-payments
```

### Aggregate Location File

```yaml
# all-components.yaml - bootstrap catalog
apiVersion: backstage.io/v1alpha1
kind: Location
metadata:
  name: root-catalog
  description: Root catalog location
spec:
  targets:
    - https://github.com/myorg/payment-service/blob/main/catalog-info.yaml
    - https://github.com/myorg/order-service/blob/main/catalog-info.yaml
    - https://github.com/myorg/notification-service/blob/main/catalog-info.yaml
    - https://github.com/myorg/backstage-catalog/blob/main/groups.yaml
    - https://github.com/myorg/backstage-catalog/blob/main/systems.yaml
    - https://github.com/myorg/backstage-catalog/blob/main/templates/all-templates.yaml
```

## Section 6: TechDocs Configuration

TechDocs renders MkDocs-based documentation from repositories. Each component needs an `mkdocs.yml` and a `docs/` folder.

### Repository Documentation Structure

```
payment-service/
├── catalog-info.yaml
├── mkdocs.yml
├── docs/
│   ├── index.md
│   ├── architecture.md
│   ├── api-reference.md
│   ├── runbooks/
│   │   ├── incident-response.md
│   │   └── database-maintenance.md
│   └── adr/
│       ├── 0001-use-postgresql.md
│       └── 0002-async-notifications.md
└── src/
    └── ...
```

The `mkdocs.yml`:

```yaml
# mkdocs.yml
site_name: Payment Service
site_description: Documentation for the Payment Service
repo_url: https://github.com/myorg/payment-service

nav:
  - Home: index.md
  - Architecture: architecture.md
  - API Reference: api-reference.md
  - Runbooks:
      - Incident Response: runbooks/incident-response.md
      - Database Maintenance: runbooks/database-maintenance.md
  - ADRs:
      - Use PostgreSQL: adr/0001-use-postgresql.md
      - Async Notifications: adr/0002-async-notifications.md

plugins:
  - techdocs-core

markdown_extensions:
  - admonition
  - codehilite
  - pymdownx.superfences:
      custom_fences:
        - name: mermaid
          class: mermaid
          format: !!python/name:pymdownx.superfences.fence_code_format
  - pymdownx.tabbed
  - pymdownx.details
```

For production TechDocs using S3, configure the TechDocs backend to publish to S3:

```bash
# Create S3 bucket for TechDocs
aws s3api create-bucket \
  --bucket my-company-techdocs \
  --region us-east-1

# Enable versioning
aws s3api put-bucket-versioning \
  --bucket my-company-techdocs \
  --versioning-configuration Status=Enabled

# Block public access
aws s3api put-public-access-block \
  --bucket my-company-techdocs \
  --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

# Bucket policy for Backstage IAM role
cat > techdocs-bucket-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowBackstageReadWrite",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::123456789012:role/backstage-techdocs-role"
      },
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:iam::123456789012:role/backstage-techdocs-role",
        "arn:aws:iam::123456789012:role/backstage-techdocs-role/*"
      ]
    }
  ]
}
EOF
```

## Section 7: Kubernetes Plugin RBAC Configuration

The Kubernetes plugin needs read access to workloads in target clusters:

```yaml
# kubernetes-rbac.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: backstage
  namespace: backstage
  annotations:
    # For EKS with IRSA
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/backstage-role

---
# ClusterRole for reading workloads
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: backstage-kubernetes-reader
rules:
  - apiGroups: [""]
    resources:
      - pods
      - pods/log
      - services
      - endpoints
      - namespaces
      - configmaps
      - nodes
      - replicationcontrollers
      - resourcequotas
      - limitranges
      - persistentvolumes
      - persistentvolumeclaims
      - events
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources:
      - deployments
      - replicasets
      - statefulsets
      - daemonsets
    verbs: ["get", "list", "watch"]
  - apiGroups: ["autoscaling"]
    resources:
      - horizontalpodautoscalers
    verbs: ["get", "list", "watch"]
  - apiGroups: ["batch"]
    resources:
      - jobs
      - cronjobs
    verbs: ["get", "list", "watch"]
  - apiGroups: ["networking.k8s.io"]
    resources:
      - ingresses
    verbs: ["get", "list", "watch"]
  - apiGroups: ["metrics.k8s.io"]
    resources:
      - pods
      - nodes
    verbs: ["get", "list"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: backstage-kubernetes-reader
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: backstage-kubernetes-reader
subjects:
  - kind: ServiceAccount
    name: backstage
    namespace: backstage
```

Extract the service account token for the Kubernetes plugin config:

```bash
# Create a long-lived token secret (Kubernetes 1.24+)
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Secret
metadata:
  name: backstage-sa-token
  namespace: backstage
  annotations:
    kubernetes.io/service-account.name: backstage
type: kubernetes.io/service-account-token
EOF

# Extract the token
kubectl get secret backstage-sa-token \
  --namespace backstage \
  -o jsonpath='{.data.token}' | base64 -d

# Extract the CA data
kubectl get secret backstage-sa-token \
  --namespace backstage \
  -o jsonpath='{.data.ca\.crt}'
```

## Section 8: Helm Chart Deployment

Deploy Backstage using the official Helm chart:

```bash
# Add the Backstage Helm repository
helm repo add backstage https://backstage.github.io/charts
helm repo update

# Create values file
cat > backstage-values.yaml <<'EOF'
backstage:
  image:
    registry: ghcr.io
    repository: myorg/backstage
    tag: "1.2.3"
    pullPolicy: IfNotPresent

  replicas: 2

  resources:
    requests:
      cpu: 500m
      memory: 512Mi
    limits:
      cpu: 2000m
      memory: 2Gi

  podAnnotations:
    prometheus.io/scrape: "true"
    prometheus.io/path: "/metrics"
    prometheus.io/port: "7007"

  appConfig:
    app:
      baseUrl: https://backstage.example.com
    backend:
      baseUrl: https://backstage.example.com
      database:
        client: pg
        connection:
          host:
            $env: POSTGRES_HOST
          port:
            $env: POSTGRES_PORT
          user:
            $env: POSTGRES_USER
          password:
            $env: POSTGRES_PASSWORD

  extraEnvVarsSecrets:
    - backstage-secrets

  extraEnvVars:
    - name: POSTGRES_HOST
      value: "backstage-postgresql"
    - name: POSTGRES_PORT
      value: "5432"
    - name: POSTGRES_USER
      value: "backstage"
    - name: POSTGRES_PASSWORD
      valueFrom:
        secretKeyRef:
          name: backstage-postgresql
          key: postgresql-password
    - name: K8S_SERVICE_ACCOUNT_TOKEN
      valueFrom:
        secretKeyRef:
          name: backstage-sa-token
          key: token

  serviceAccount:
    create: true
    name: backstage
    annotations: {}

postgresql:
  enabled: true
  auth:
    username: backstage
    database: backstage
    existingSecret: backstage-postgresql
    secretKeys:
      userPasswordKey: postgresql-password
      adminPasswordKey: postgresql-postgres-password
  primary:
    persistence:
      enabled: true
      size: 20Gi
      storageClass: "gp3"
    resources:
      requests:
        cpu: 250m
        memory: 256Mi
      limits:
        cpu: 1000m
        memory: 1Gi

ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/proxy-body-size: "50m"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "300"
  hosts:
    - host: backstage.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: backstage-tls
      hosts:
        - backstage.example.com

serviceMonitor:
  enabled: true
  labels:
    release: prometheus

networkPolicy:
  enabled: true
  egress:
    enabled: true
    namespaces:
      - name: monitoring
EOF

# Deploy
helm upgrade --install backstage backstage/backstage \
  --namespace backstage \
  --values backstage-values.yaml \
  --wait \
  --timeout 10m
```

## Section 9: GitHub Catalog Auto-Discovery

Configure automatic discovery of all repositories in a GitHub organization:

```yaml
# Add to app-config.yaml under catalog.providers
catalog:
  providers:
    github:
      # Discover all repos with catalog-info.yaml
      allOrganizationRepos:
        organization: 'myorg'
        catalogPath: '/catalog-info.yaml'
        filters:
          branch: 'main'
          # Only repos with the backstage topic
          topic:
            include: ['backstage-enabled']
            exclude: ['archived']
        schedule:
          frequency: { minutes: 15 }
          timeout: { minutes: 5 }
          initialDelay: { seconds: 15 }

      # Discover all users and groups from GitHub org
      orgUsers:
        organization: 'myorg'
        catalogPath: '/catalog-info.yaml'
        filters:
          branch: 'main'
```

Backend configuration for the GitHub module:

```typescript
// packages/backend/src/plugins/catalog.ts
import { CatalogBuilder } from '@backstage/plugin-catalog-backend';
import { GithubEntityProvider } from '@backstage/plugin-catalog-backend-module-github';
import { ScaffolderEntitiesProcessor } from '@backstage/plugin-scaffolder-backend';
import { Router } from 'express';
import { PluginEnvironment } from '../types';

export default async function createPlugin(
  env: PluginEnvironment,
): Promise<Router> {
  const builder = await CatalogBuilder.create(env);

  builder.addEntityProvider(
    GithubEntityProvider.fromConfig(env.config, {
      logger: env.logger,
      scheduler: env.scheduler,
      schedule: env.scheduler.createScheduledTaskRunner({
        frequency: { minutes: 30 },
        timeout: { minutes: 3 },
      }),
    }),
  );

  builder.addProcessor(new ScaffolderEntitiesProcessor());

  const { processingEngine, router } = await builder.build();
  await processingEngine.start();

  return router;
}
```

## Section 10: Software Templates (Scaffolder)

Create a template for bootstrapping new microservices:

```yaml
# templates/new-service-template.yaml
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: new-microservice
  title: New Microservice
  description: Bootstrap a new Go microservice with Kubernetes manifests
  tags:
    - go
    - microservice
    - kubernetes
spec:
  owner: team-platform
  type: service

  parameters:
    - title: Service Information
      required:
        - name
        - description
        - owner
      properties:
        name:
          title: Service Name
          type: string
          description: Unique name for the service (lowercase, hyphens only)
          ui:autofocus: true
          ui:options:
            rows: 1
        description:
          title: Description
          type: string
          description: Brief description of what this service does
        owner:
          title: Owner
          type: string
          description: Team that owns this service
          ui:field: OwnerPicker
          ui:options:
            allowedKinds:
              - Group

    - title: Infrastructure
      required:
        - replicas
        - cpuRequest
        - memoryRequest
      properties:
        replicas:
          title: Initial Replicas
          type: integer
          default: 2
          minimum: 1
          maximum: 10
        cpuRequest:
          title: CPU Request (millicores)
          type: integer
          default: 100
        memoryRequest:
          title: Memory Request (Mi)
          type: integer
          default: 128

  steps:
    - id: fetch-base
      name: Fetch Base Template
      action: fetch:template
      input:
        url: ./skeleton
        values:
          name: ${{ parameters.name }}
          description: ${{ parameters.description }}
          owner: ${{ parameters.owner }}
          replicas: ${{ parameters.replicas }}
          cpuRequest: ${{ parameters.cpuRequest }}
          memoryRequest: ${{ parameters.memoryRequest }}

    - id: publish
      name: Publish to GitHub
      action: publish:github
      input:
        allowedHosts: ['github.com']
        description: ${{ parameters.description }}
        repoUrl: github.com?owner=myorg&repo=${{ parameters.name }}
        defaultBranch: main
        repoVisibility: private
        topics:
          - backstage-enabled
          - microservice

    - id: register
      name: Register in Catalog
      action: catalog:register
      input:
        repoContentsUrl: ${{ steps['publish'].output.repoContentsUrl }}
        catalogInfoPath: '/catalog-info.yaml'

  output:
    links:
      - title: Repository
        url: ${{ steps['publish'].output.remoteUrl }}
      - title: Open in catalog
        icon: catalog
        entityRef: ${{ steps['register'].output.entityRef }}
```

## Section 11: Monitoring and Health Checks

Configure Prometheus monitoring for Backstage:

```yaml
# prometheus-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: backstage-alerts
  namespace: backstage
  labels:
    release: prometheus
spec:
  groups:
    - name: backstage
      rules:
        - alert: BackstageDown
          expr: up{job="backstage"} == 0
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Backstage is down"
            description: "Backstage has been down for more than 2 minutes"

        - alert: BackstageCatalogRefreshFailing
          expr: |
            rate(catalog_processing_errors_total[10m]) > 0.1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Backstage catalog refresh errors"
            description: "Catalog processing error rate above threshold"

        - alert: BackstageHighMemory
          expr: |
            process_resident_memory_bytes{job="backstage"} > 1.5e9
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Backstage high memory usage"
```

Kubernetes liveness and readiness probes:

```yaml
# Already handled by the Helm chart, but for reference:
livenessProbe:
  httpGet:
    path: /healthcheck
    port: 7007
  initialDelaySeconds: 60
  periodSeconds: 10
  timeoutSeconds: 5
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /healthcheck
    port: 7007
  initialDelaySeconds: 30
  periodSeconds: 5
  timeoutSeconds: 3
  failureThreshold: 3
```

## Section 12: Troubleshooting Common Issues

### Catalog Not Ingesting Entities

```bash
# Check catalog processor logs
kubectl logs -n backstage deployment/backstage --tail=100 | grep -i catalog

# Force a catalog refresh via API
curl -X POST https://backstage.example.com/api/catalog/refresh \
  -H "Authorization: Bearer <backstage-token>" \
  -H "Content-Type: application/json" \
  -d '{"entityRef": "component:default/payment-service"}'

# Check entity status
curl https://backstage.example.com/api/catalog/entities/by-name/component/default/payment-service \
  -H "Authorization: Bearer <backstage-token>"
```

### TechDocs Not Rendering

```bash
# Check TechDocs generator
kubectl logs -n backstage deployment/backstage | grep -i techdocs

# Manually trigger TechDocs build
curl -X POST https://backstage.example.com/api/techdocs/sync/default/component/payment-service \
  -H "Authorization: Bearer <backstage-token>"

# Verify mkdocs.yml is valid
cd payment-service
python3 -m mkdocs build --strict
```

### Kubernetes Plugin Not Showing Workloads

```bash
# Verify RBAC is correct
kubectl auth can-i list pods \
  --namespace payments \
  --as system:serviceaccount:backstage:backstage

# Test token validity
TOKEN=$(kubectl get secret backstage-sa-token -n backstage -o jsonpath='{.data.token}' | base64 -d)
kubectl --token="$TOKEN" get pods -n payments

# Check Backstage API
curl "https://backstage.example.com/api/kubernetes/proxy/api/v1/namespaces/payments/pods" \
  -H "Authorization: Bearer <backstage-token>"
```

### PostgreSQL Connection Issues

```bash
# Check connection from Backstage pod
kubectl exec -it -n backstage deployment/backstage -- \
  node -e "
const { Client } = require('pg');
const client = new Client({
  host: process.env.POSTGRES_HOST,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: 'backstage_plugin_catalog'
});
client.connect()
  .then(() => { console.log('Connected'); client.end(); })
  .catch(err => console.error('Error:', err));
"
```

## Section 13: Production Hardening

### Pod Disruption Budget

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: backstage-pdb
  namespace: backstage
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: backstage
```

### Network Policy

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: backstage-network-policy
  namespace: backstage
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: backstage
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ingress-nginx
      ports:
        - protocol: TCP
          port: 7007
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
      ports:
        - protocol: TCP
          port: 7007
  egress:
    - to:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: postgresql
      ports:
        - protocol: TCP
          port: 5432
    # Allow GitHub/GitLab API access
    - to: []
      ports:
        - protocol: TCP
          port: 443
    # Allow Kubernetes API
    - to: []
      ports:
        - protocol: TCP
          port: 6443
```

### Horizontal Pod Autoscaler

```yaml
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

## Summary

A production Backstage deployment on Kubernetes involves:

1. **Custom Docker image** with plugins compiled in at build time - plan for 10-15 minute image builds
2. **PostgreSQL** for persistent catalog storage - use a StatefulSet or managed RDS
3. **GitHub/GitLab integration** for automatic catalog discovery via entity providers
4. **TechDocs** with S3 publishing for scalable documentation serving
5. **Kubernetes plugin** with a dedicated ServiceAccount and ClusterRoleBinding
6. **Helm chart** deployment with proper resource limits, PDB, and HPA
7. **Software templates** to enforce golden path service creation

The catalog auto-discovery from GitHub organizations is the highest-value feature - once teams add `catalog-info.yaml` to their repositories, the entire organization graph becomes visible in minutes. Start with a small set of services and expand the `topic` filter as teams onboard.
