---
title: "Platform Engineering with Backstage: Building Internal Developer Portals"
date: 2027-09-27T00:00:00-05:00
draft: false
tags: ["Platform Engineering", "Backstage", "IDP", "Developer Experience", "Kubernetes"]
categories:
- Platform Engineering
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to building Internal Developer Portals with Backstage, covering software catalog setup, TechDocs, scaffolder templates, custom plugins, RBAC, and Kubernetes integration."
more_link: "yes"
url: "/platform-engineering-idp-backstage-guide/"
---

Platform engineering has matured from a buzzword into a discipline that directly determines how fast engineering organizations ship software. Backstage, the CNCF-graduated developer portal framework originally built at Spotify, provides the scaffolding for Internal Developer Portals (IDPs) that reduce cognitive load, enforce golden paths, and make infrastructure self-service. This guide covers every layer of a production Backstage deployment — from software catalog design and TechDocs integration to custom plugin development, RBAC configuration, and Kubernetes integration — with validated configurations and realistic operational patterns.

<!--more-->

# Platform Engineering with Backstage: Building Internal Developer Portals

## Section 1: Platform Engineering Principles and Backstage Architecture

Platform engineering treats internal tooling as a product. The platform team maintains paved roads — documented, automated paths that developers follow to ship services safely. Backstage is the portal layer that surfaces those roads in a single UI.

### Core Backstage Components

```
┌─────────────────────────────────────────────────────────────┐
│                      Backstage Frontend                      │
│  Software Catalog │ TechDocs │ Scaffolder │ Search │ Plugins │
└───────────────────────────┬─────────────────────────────────┘
                            │ REST / GraphQL
┌───────────────────────────▼─────────────────────────────────┐
│                      Backstage Backend                       │
│  Catalog Processor │ Auth │ TechDocs │ Scaffolder │ Plugins  │
└───────────────────────────┬─────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
   PostgreSQL          GitHub/GitLab        Kubernetes
   (Catalog DB)        (Entity Source)      (K8s Plugin)
```

Backstage's backend processes entity descriptors (YAML files in repositories), populates a PostgreSQL catalog database, and serves a plugin-based frontend. Each plugin registers routes, sidebar items, and entity content cards.

### Deployment Architecture for Production

Production Backstage deployments require:

- **PostgreSQL 14+** for catalog persistence
- **GitHub/GitLab OAuth** for authentication
- **Object storage** (S3/GCS) for TechDocs
- **Kubernetes access** for the K8s plugin
- **Redis** (optional) for caching

The reference deployment uses Kubernetes with a Helm chart maintained by the Backstage community.

## Section 2: Installing Backstage with the Official Helm Chart

### Prerequisites

```bash
# Install the Backstage Helm repository
helm repo add backstage https://backstage.github.io/charts
helm repo update

# Verify chart availability
helm search repo backstage/backstage --versions | head -5
```

### Core values.yaml

```yaml
# values.yaml
backstage:
  image:
    registry: ghcr.io
    repository: backstage/backstage
    tag: "1.28.0"

  appConfig:
    app:
      title: "Acme Developer Portal"
      baseUrl: https://backstage.acme.internal

    backend:
      baseUrl: https://backstage.acme.internal
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

    auth:
      environment: production
      providers:
        github:
          production:
            clientId: ${AUTH_GITHUB_CLIENT_ID}
            clientSecret: ${AUTH_GITHUB_CLIENT_SECRET}

    catalog:
      rules:
        - allow: [Component, API, System, Domain, Resource, User, Group, Location]
      locations:
        - type: url
          target: https://github.com/acme-org/backstage-catalog/blob/main/all-components.yaml
          rules:
            - allow: [Component, API, System, Domain, Resource, User, Group, Location]

    techdocs:
      builder: external
      generator:
        runIn: local
      publisher:
        type: awsS3
        awsS3:
          bucketName: acme-techdocs-production
          region: us-east-1
          accountId: "123456789012"

    kubernetes:
      serviceLocatorMethod:
        type: multiTenant
      clusterLocatorMethods:
        - type: config
          clusters:
            - url: https://k8s-prod.acme.internal
              name: production
              authProvider: serviceAccount
              skipTLSVerify: false
              skipMetricsLookup: false
              serviceAccountToken: ${K8S_SA_TOKEN}
              caData: ${K8S_CA_DATA}
            - url: https://k8s-staging.acme.internal
              name: staging
              authProvider: serviceAccount
              skipTLSVerify: false
              serviceAccountToken: ${K8S_STAGING_SA_TOKEN}
              caData: ${K8S_STAGING_CA_DATA}

postgresql:
  enabled: true
  auth:
    username: backstage
    password: ${POSTGRES_PASSWORD}
    database: backstage

ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/proxy-body-size: "50m"
  host: backstage.acme.internal
  tls:
    enabled: true
    secretName: backstage-tls
```

### Kubernetes Secrets

```yaml
# backstage-secrets.yaml
apiVersion: v1
kind: Secret
metadata:
  name: backstage-secrets
  namespace: backstage
type: Opaque
stringData:
  POSTGRES_HOST: "backstage-postgresql.backstage.svc.cluster.local"
  POSTGRES_PORT: "5432"
  POSTGRES_USER: "backstage"
  POSTGRES_PASSWORD: "super-secure-password-replace-me"
  AUTH_GITHUB_CLIENT_ID: "your-github-oauth-app-client-id"
  AUTH_GITHUB_CLIENT_SECRET: "your-github-oauth-app-client-secret"
  K8S_SA_TOKEN: "your-k8s-service-account-token"
  K8S_CA_DATA: "base64-encoded-ca-cert"
  K8S_STAGING_SA_TOKEN: "your-staging-k8s-service-account-token"
  K8S_STAGING_CA_DATA: "base64-encoded-staging-ca-cert"
```

### Deploy

```bash
kubectl create namespace backstage

kubectl apply -f backstage-secrets.yaml

helm upgrade --install backstage backstage/backstage \
  --namespace backstage \
  --values values.yaml \
  --set backstage.extraEnvVarsSecrets[0]=backstage-secrets \
  --wait \
  --timeout 10m
```

## Section 3: Software Catalog Configuration

The software catalog is Backstage's foundation. Every service, API, library, and piece of infrastructure is represented as an entity with a `catalog-info.yaml` descriptor.

### Entity Kinds and Relationships

```
Domain
  └── System
        ├── Component (Service, Library, Website)
        │     └── API (OpenAPI, AsyncAPI, GraphQL)
        └── Resource (Database, S3 Bucket, Queue)
```

### Component Descriptor — Microservice

```yaml
# catalog-info.yaml (in each service repository)
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: payment-service
  title: Payment Service
  description: Handles payment processing and refunds for checkout flow
  annotations:
    github.com/project-slug: acme-org/payment-service
    backstage.io/techdocs-ref: dir:.
    backstage.io/kubernetes-id: payment-service
    backstage.io/kubernetes-namespace: payments
    prometheus.io/rule: |
      - alert: PaymentServiceHighErrorRate
        expr: rate(http_requests_total{job="payment-service",status=~"5.."}[5m]) > 0.05
    pagerduty.com/integration-key: "pd-integration-key-placeholder"
    sonarqube.org/project-key: acme-org_payment-service
  labels:
    tier: backend
    team: payments
  tags:
    - go
    - grpc
    - payments
  links:
    - url: https://grafana.acme.internal/d/payment-service
      title: Grafana Dashboard
      icon: dashboard
    - url: https://runbooks.acme.internal/payment-service
      title: Runbook
      icon: book
spec:
  type: service
  lifecycle: production
  owner: group:payments-team
  system: checkout-system
  dependsOn:
    - component:order-service
    - resource:payments-postgres
    - resource:stripe-api
  providesApis:
    - payment-api
```

### API Entity

```yaml
apiVersion: backstage.io/v1alpha1
kind: API
metadata:
  name: payment-api
  description: Payment processing API
  annotations:
    backstage.io/techdocs-ref: dir:.
spec:
  type: openapi
  lifecycle: production
  owner: group:payments-team
  system: checkout-system
  definition:
    $text: https://raw.githubusercontent.com/acme-org/payment-service/main/openapi.yaml
```

### System and Domain Entities

```yaml
# systems.yaml
apiVersion: backstage.io/v1alpha1
kind: System
metadata:
  name: checkout-system
  description: End-to-end checkout and payment processing
spec:
  owner: group:payments-team
  domain: ecommerce
---
apiVersion: backstage.io/v1alpha1
kind: Domain
metadata:
  name: ecommerce
  description: E-commerce and retail services
spec:
  owner: group:platform-team
```

### Catalog Index File

```yaml
# all-components.yaml (in central catalog repository)
apiVersion: backstage.io/v1alpha1
kind: Location
metadata:
  name: acme-catalog-root
  description: Root location for all Acme services
spec:
  targets:
    - ./teams/payments/components.yaml
    - ./teams/orders/components.yaml
    - ./teams/platform/components.yaml
    - ./infrastructure/databases.yaml
    - ./infrastructure/queues.yaml
    - ./groups-and-users.yaml
```

### Organization Entities

```yaml
# groups-and-users.yaml
apiVersion: backstage.io/v1alpha1
kind: Group
metadata:
  name: payments-team
  description: Payments engineering team
spec:
  type: team
  profile:
    displayName: Payments Team
    email: payments-eng@acme.com
  parent: engineering
  children: []
  members:
    - alice-chen
    - bob-martinez
---
apiVersion: backstage.io/v1alpha1
kind: User
metadata:
  name: alice-chen
spec:
  profile:
    displayName: Alice Chen
    email: alice.chen@acme.com
    picture: https://avatars.acme.com/alice-chen
  memberOf:
    - payments-team
    - backend-guild
```

## Section 4: TechDocs Integration

TechDocs renders Markdown documentation from service repositories into a consistent portal experience. The external builder pattern runs `mkdocs` in CI and uploads the artifacts to object storage.

### mkdocs.yml Configuration

```yaml
# mkdocs.yml (in each service repository)
site_name: "Payment Service"
site_description: "Documentation for the Payment Service"
nav:
  - Home: index.md
  - Architecture:
      - Overview: architecture/overview.md
      - Data Flow: architecture/data-flow.md
      - Dependencies: architecture/dependencies.md
  - API Reference: api-reference.md
  - Operations:
      - Deployment: ops/deployment.md
      - Runbook: ops/runbook.md
      - Alerting: ops/alerting.md
  - Development:
      - Getting Started: dev/getting-started.md
      - Local Setup: dev/local-setup.md
      - Testing: dev/testing.md

plugins:
  - techdocs-core

markdown_extensions:
  - admonition
  - pymdownx.superfences:
      custom_fences:
        - name: mermaid
          class: mermaid
          format: !!python/name:pymdownx.superfences.fence_code_format
  - pymdownx.tabbed:
      alternate_style: true
  - attr_list
  - md_in_html
```

### GitHub Actions — TechDocs CI

```yaml
# .github/workflows/techdocs.yml
name: TechDocs Publish

on:
  push:
    branches: [main]
    paths:
      - 'docs/**'
      - 'mkdocs.yml'
      - 'catalog-info.yaml'

jobs:
  publish-techdocs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Setup Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Install TechDocs CLI and dependencies
        run: |
          pip install mkdocs-techdocs-core==1.3.3
          npm install -g @techdocs/cli@1.8.0

      - name: Generate TechDocs
        run: techdocs-cli generate --source-dir . --output-dir ./site

      - name: Publish to S3
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.TECHDOCS_AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.TECHDOCS_AWS_SECRET_ACCESS_KEY }}
          AWS_REGION: us-east-1
        run: |
          techdocs-cli publish \
            --publisher-type awsS3 \
            --storage-name acme-techdocs-production \
            --entity default/component/payment-service \
            --directory ./site
```

## Section 5: Scaffolder Templates — Golden Path Service Creation

The Scaffolder is Backstage's template engine. Golden path templates enforce architectural standards, provision infrastructure, and register new services in the catalog automatically.

### Go Microservice Template

```yaml
# templates/go-microservice/template.yaml
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: go-microservice
  title: Go Microservice
  description: Creates a production-ready Go microservice with CI/CD, monitoring, and K8s deployment
  tags:
    - go
    - microservice
    - recommended
  annotations:
    backstage.io/techdocs-ref: dir:.
spec:
  owner: group:platform-team
  type: service

  parameters:
    - title: Service Information
      required:
        - name
        - description
        - owner
        - system
      properties:
        name:
          title: Service Name
          type: string
          description: Unique service identifier (lowercase, hyphens only)
          pattern: '^[a-z][a-z0-9-]{2,50}$'
          ui:autofocus: true
        description:
          title: Description
          type: string
          description: Brief description of the service's purpose
          maxLength: 200
        owner:
          title: Owner Team
          type: string
          description: Team responsible for this service
          ui:field: OwnerPicker
          ui:options:
            allowArbitraryValues: false
        system:
          title: System
          type: string
          description: System this service belongs to
          ui:field: EntityPicker
          ui:options:
            catalogFilter:
              kind: System

    - title: Infrastructure Options
      properties:
        database:
          title: Requires PostgreSQL Database
          type: boolean
          default: false
        cache:
          title: Requires Redis Cache
          type: boolean
          default: false
        messageQueue:
          title: Message Queue
          type: string
          enum:
            - none
            - kafka
            - rabbitmq
          default: none
        environments:
          title: Target Environments
          type: array
          items:
            type: string
            enum:
              - development
              - staging
              - production
          uniqueItems: true
          default:
            - development
            - staging
            - production

    - title: Repository Configuration
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
              - acme-org

  steps:
    - id: fetch-template
      name: Fetch Template
      action: fetch:template
      input:
        url: ./skeleton
        values:
          name: ${{ parameters.name }}
          description: ${{ parameters.description }}
          owner: ${{ parameters.owner }}
          system: ${{ parameters.system }}
          database: ${{ parameters.database }}
          cache: ${{ parameters.cache }}
          messageQueue: ${{ parameters.messageQueue }}

    - id: publish
      name: Publish to GitHub
      action: publish:github
      input:
        allowedHosts: ['github.com']
        description: ${{ parameters.description }}
        repoUrl: ${{ parameters.repoUrl }}
        defaultBranch: main
        gitCommitMessage: "feat: initial service scaffolding"
        topics:
          - go
          - microservice
          - ${{ parameters.system }}
        repoVisibility: private
        requireCodeOwnerReviews: true
        requiredStatusCheckContexts:
          - ci/test
          - ci/build
          - security/scan

    - id: register
      name: Register in Catalog
      action: catalog:register
      input:
        repoContentsUrl: ${{ steps.publish.output.repoContentsUrl }}
        catalogInfoPath: /catalog-info.yaml

    - id: create-argocd-app
      name: Create ArgoCD Application
      action: argocd:create-resources
      input:
        appName: ${{ parameters.name }}
        argoInstance: production
        namespace: ${{ parameters.name }}
        repoUrl: ${{ steps.publish.output.remoteUrl }}
        labelValue: ${{ parameters.name }}
        path: deploy/kubernetes

    - id: create-pagerduty-service
      name: Create PagerDuty Service
      action: pagerduty:service:create
      input:
        name: ${{ parameters.name }}
        description: ${{ parameters.description }}
        escalationPolicyId: "PXXXXXX"
        alertGrouping: intelligent

    - id: slack-notify
      name: Notify Team Channel
      action: http:backstage:request
      input:
        method: POST
        path: /api/proxy/slack/chat.postMessage
        body:
          channel: "#platform-announcements"
          text: "New service created: *${{ parameters.name }}* by ${{ parameters.owner }}"

  output:
    links:
      - title: Repository
        url: ${{ steps.publish.output.remoteUrl }}
      - title: Open in Catalog
        icon: catalog
        entityRef: ${{ steps.register.output.entityRef }}
      - title: Open in ArgoCD
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
│   └── server/
│       └── main.go
├── internal/
│   ├── handler/
│   ├── service/
│   └── repository/
├── deploy/
│   └── kubernetes/
│       ├── deployment.yaml
│       ├── service.yaml
│       ├── ingress.yaml
│       └── servicemonitor.yaml
├── .github/
│   └── workflows/
│       ├── ci.yml
│       └── techdocs.yml
├── Dockerfile
├── Makefile
└── README.md
```

## Section 6: Custom Plugin Development

Backstage plugins extend the portal with domain-specific capabilities. A plugin consists of a frontend React package and optionally a backend package.

### Scaffolding a New Plugin

```bash
# From the Backstage app root
yarn backstage-cli new --select plugin

# Choose: plugin
# Enter ID: cost-dashboard
# This creates:
#   plugins/cost-dashboard/         (frontend)
#   plugins/cost-dashboard-backend/ (backend)
```

### Frontend Plugin — Custom Entity Card

```typescript
// plugins/cost-dashboard/src/components/CostCard/CostCard.tsx
import React, { useEffect, useState } from 'react';
import {
  Card,
  CardContent,
  CardHeader,
  Grid,
  Typography,
  CircularProgress,
  Chip,
} from '@material-ui/core';
import { useEntity } from '@backstage/plugin-catalog-react';
import { useApi } from '@backstage/core-plugin-api';
import { costDashboardApiRef } from '../../api';

interface CostData {
  monthToDate: number;
  projected: number;
  trend: 'up' | 'down' | 'stable';
  breakdown: {
    compute: number;
    storage: number;
    network: number;
  };
}

export const CostCard = () => {
  const { entity } = useEntity();
  const costApi = useApi(costDashboardApiRef);
  const [cost, setCost] = useState<CostData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const serviceName = entity.metadata.name;
  const namespace = entity.metadata.annotations?.['backstage.io/kubernetes-namespace'] || 'default';

  useEffect(() => {
    costApi
      .getServiceCost(serviceName, namespace)
      .then(data => {
        setCost(data);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
  }, [serviceName, namespace, costApi]);

  if (loading) return <CircularProgress />;
  if (error) return <Typography color="error">{error}</Typography>;
  if (!cost) return null;

  const trendColor = cost.trend === 'up' ? 'error' : cost.trend === 'down' ? 'primary' : 'default';

  return (
    <Card>
      <CardHeader
        title="Cloud Cost"
        subheader={`Namespace: ${namespace}`}
        action={<Chip label={`Trend: ${cost.trend}`} color={trendColor} size="small" />}
      />
      <CardContent>
        <Grid container spacing={3}>
          <Grid item xs={6}>
            <Typography variant="subtitle2" color="textSecondary">
              Month to Date
            </Typography>
            <Typography variant="h5">
              ${cost.monthToDate.toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </Typography>
          </Grid>
          <Grid item xs={6}>
            <Typography variant="subtitle2" color="textSecondary">
              Projected Monthly
            </Typography>
            <Typography variant="h5">
              ${cost.projected.toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </Typography>
          </Grid>
          <Grid item xs={4}>
            <Typography variant="caption" color="textSecondary">Compute</Typography>
            <Typography>${cost.breakdown.compute.toFixed(2)}</Typography>
          </Grid>
          <Grid item xs={4}>
            <Typography variant="caption" color="textSecondary">Storage</Typography>
            <Typography>${cost.breakdown.storage.toFixed(2)}</Typography>
          </Grid>
          <Grid item xs={4}>
            <Typography variant="caption" color="textSecondary">Network</Typography>
            <Typography>${cost.breakdown.network.toFixed(2)}</Typography>
          </Grid>
        </Grid>
      </CardContent>
    </Card>
  );
};

// Register the card as an entity content extension
export const EntityCostCard = CostCard;
```

### Plugin API Client

```typescript
// plugins/cost-dashboard/src/api/CostDashboardClient.ts
import { createApiRef, DiscoveryApi, IdentityApi } from '@backstage/core-plugin-api';

export interface CostDashboardApi {
  getServiceCost(serviceName: string, namespace: string): Promise<CostData>;
  getNamespaceCost(namespace: string, period: string): Promise<NamespaceCostData>;
}

export const costDashboardApiRef = createApiRef<CostDashboardApi>({
  id: 'plugin.cost-dashboard.service',
});

export class CostDashboardClient implements CostDashboardApi {
  private readonly discoveryApi: DiscoveryApi;
  private readonly identityApi: IdentityApi;

  constructor(options: { discoveryApi: DiscoveryApi; identityApi: IdentityApi }) {
    this.discoveryApi = options.discoveryApi;
    this.identityApi = options.identityApi;
  }

  private async getBaseUrl(): Promise<string> {
    return this.discoveryApi.getBaseUrl('cost-dashboard');
  }

  private async getHeaders(): Promise<HeadersInit> {
    const { token } = await this.identityApi.getCredentials();
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  async getServiceCost(serviceName: string, namespace: string): Promise<CostData> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();
    const response = await fetch(
      `${baseUrl}/cost/service/${namespace}/${serviceName}`,
      { headers },
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch cost data: ${response.statusText}`);
    }
    return response.json();
  }

  async getNamespaceCost(namespace: string, period: string): Promise<NamespaceCostData> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();
    const response = await fetch(
      `${baseUrl}/cost/namespace/${namespace}?period=${period}`,
      { headers },
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch namespace cost: ${response.statusText}`);
    }
    return response.json();
  }
}
```

### Backend Plugin Router

```typescript
// plugins/cost-dashboard-backend/src/service/router.ts
import { Router } from 'express';
import { Logger } from 'winston';
import { Config } from '@backstage/config';

export interface RouterOptions {
  logger: Logger;
  config: Config;
}

export async function createRouter(options: RouterOptions): Promise<Router> {
  const { logger, config } = options;
  const router = Router();

  const kubecostBaseUrl = config.getString('costDashboard.kubecostBaseUrl');

  router.get('/cost/service/:namespace/:serviceName', async (req, res) => {
    const { namespace, serviceName } = req.params;

    try {
      const response = await fetch(
        `${kubecostBaseUrl}/model/allocation?window=month&namespace=${namespace}&filter=label%5Bapp%5D%3D${serviceName}&aggregate=label:app`
      );

      if (!response.ok) {
        throw new Error(`Kubecost API error: ${response.statusText}`);
      }

      const data = await response.json();
      const allocation = data.data?.[0]?.[`${namespace}/${serviceName}`];

      if (!allocation) {
        return res.status(404).json({ error: 'No cost data found' });
      }

      const costData = {
        monthToDate: allocation.totalCost || 0,
        projected: (allocation.totalCost || 0) * (30 / new Date().getDate()),
        trend: 'stable',
        breakdown: {
          compute: allocation.cpuCost + allocation.ramCost || 0,
          storage: allocation.pvCost || 0,
          network: allocation.networkCost || 0,
        },
      };

      logger.info(`Cost data retrieved for ${namespace}/${serviceName}`);
      return res.json(costData);
    } catch (error) {
      logger.error(`Failed to fetch cost for ${namespace}/${serviceName}: ${error}`);
      return res.status(500).json({ error: 'Failed to retrieve cost data' });
    }
  });

  return router;
}
```

## Section 7: RBAC with GitHub/GitLab OAuth

Backstage uses a permission framework to control access to catalog entities, scaffolder templates, and plugin features.

### Auth Configuration

```yaml
# app-config.production.yaml
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
            - resolver: emailLocalPartMatchingUserEntityName
```

### Permission Policy

```typescript
// packages/backend/src/plugins/permission.ts
import { BackstageIdentityResponse } from '@backstage/plugin-auth-node';
import {
  PolicyDecision,
  AuthorizeResult,
  isPermission,
} from '@backstage/plugin-permission-common';
import {
  catalogEntityDeletePermission,
  catalogEntityRefreshPermission,
} from '@backstage/plugin-catalog-common/alpha';
import {
  scaffolderActionExecutePermission,
  scaffolderTemplateParameterReadPermission,
} from '@backstage/plugin-scaffolder-common/alpha';
import { PermissionPolicy, PolicyQuery } from '@backstage/plugin-permission-node';

export class AcmePermissionPolicy implements PermissionPolicy {
  async handle(
    request: PolicyQuery,
    user?: BackstageIdentityResponse,
  ): Promise<PolicyDecision> {
    const userRef = user?.identity.userEntityRef;
    const ownershipRefs = user?.identity.ownershipEntityRefs ?? [];

    // Platform team has full access
    if (ownershipRefs.includes('group:default/platform-team')) {
      return { result: AuthorizeResult.ALLOW };
    }

    // Block catalog entity deletion for non-platform team members
    if (isPermission(request.permission, catalogEntityDeletePermission)) {
      return { result: AuthorizeResult.DENY };
    }

    // Allow catalog refresh for entity owners
    if (isPermission(request.permission, catalogEntityRefreshPermission)) {
      return { result: AuthorizeResult.CONDITIONAL, conditions: {
        rule: 'IS_ENTITY_OWNER',
        resourceType: 'catalog-entity',
        params: { claims: ownershipRefs },
      }};
    }

    // Restrict scaffolder template execution to authenticated users only
    if (isPermission(request.permission, scaffolderActionExecutePermission)) {
      if (!userRef) {
        return { result: AuthorizeResult.DENY };
      }
      return { result: AuthorizeResult.ALLOW };
    }

    // Default: allow for authenticated users
    if (userRef) {
      return { result: AuthorizeResult.ALLOW };
    }

    return { result: AuthorizeResult.DENY };
  }
}
```

## Section 8: Kubernetes Plugin Integration

The Kubernetes plugin surfaces live cluster state within service catalog pages — pods, deployments, rollouts, and events.

### Kubernetes RBAC for Backstage

```yaml
# kubernetes-backstage-rbac.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: backstage
  namespace: backstage
---
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
      - events
      - nodes
      - replicationcontrollers
      - persistentvolumes
      - persistentvolumeclaims
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
      - networkpolicies
    verbs: ["get", "list", "watch"]
  - apiGroups: ["argoproj.io"]
    resources:
      - rollouts
      - rollouthistories
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

### Generate Long-lived Token for Backstage

```bash
# Create a long-lived token secret for Backstage service account
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

# Retrieve the token
kubectl get secret backstage-sa-token -n backstage \
  -o jsonpath='{.data.token}' | base64 -d

# Retrieve the CA certificate
kubectl get secret backstage-sa-token -n backstage \
  -o jsonpath='{.data.ca\.crt}'
```

### Component Annotation for K8s Discovery

```yaml
# In catalog-info.yaml of each service
metadata:
  annotations:
    backstage.io/kubernetes-id: payment-service
    backstage.io/kubernetes-namespace: payments
    backstage.io/kubernetes-label-selector: "app=payment-service"
    backstage.io/kubernetes-cluster: production
```

## Section 9: Measuring Developer Productivity

Platform engineering success is measured through DORA metrics and developer experience surveys.

### DORA Metrics Collection

```yaml
# dora-metrics-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: dora-collector-config
  namespace: backstage
data:
  config.yaml: |
    sources:
      github:
        organizations:
          - acme-org
        metrics:
          - deployment_frequency
          - lead_time_for_changes
          - change_failure_rate
          - time_to_restore
      argocd:
        url: https://argocd.acme.internal
        metrics:
          - deployment_frequency
          - rollback_rate
    destinations:
      - type: prometheus
        pushgateway: http://prometheus-pushgateway:9091
      - type: backstage_techhub
        url: http://backstage:7007/api/tech-insights
```

### Tech Insights Fact Collector

```typescript
// packages/backend/src/plugins/techInsights.ts
import {
  createFactRetrieverRegistration,
  TechInsightsDatabase,
} from '@backstage/plugin-tech-insights-backend';
import { CatalogClient } from '@backstage/catalog-client';
import { JsonValue } from '@backstage/types';

export const serviceReadinessFactRetriever = createFactRetrieverRegistration({
  cadence: '0 * * * *', // Every hour
  factRetriever: {
    id: 'serviceReadiness',
    version: '0.1.0',
    entityFilter: [{ kind: 'Component', 'spec.type': 'service' }],
    schema: {
      hasTechDocs: {
        type: 'boolean',
        description: 'Whether the service has TechDocs configured',
      },
      hasPagerDuty: {
        type: 'boolean',
        description: 'Whether the service has PagerDuty integration',
      },
      hasOwner: {
        type: 'boolean',
        description: 'Whether the service has a defined owner',
      },
      hasRunbook: {
        type: 'boolean',
        description: 'Whether the service has a runbook link',
      },
      productionReadinessScore: {
        type: 'integer',
        description: 'Overall production readiness score out of 100',
      },
    },
    handler: async ({ entities }) => {
      return entities.map(entity => {
        const annotations = entity.metadata.annotations ?? {};
        const links = entity.metadata.links ?? [];

        const hasTechDocs = !!annotations['backstage.io/techdocs-ref'];
        const hasPagerDuty = !!annotations['pagerduty.com/integration-key'];
        const hasOwner = !!entity.spec?.owner;
        const hasRunbook = links.some(l => l.title?.toLowerCase().includes('runbook'));

        const score = [hasTechDocs, hasPagerDuty, hasOwner, hasRunbook]
          .filter(Boolean).length * 25;

        return {
          entity: {
            namespace: entity.metadata.namespace ?? 'default',
            kind: entity.kind,
            name: entity.metadata.name,
          },
          facts: {
            hasTechDocs,
            hasPagerDuty,
            hasOwner,
            hasRunbook,
            productionReadinessScore: score,
          } as Record<string, JsonValue>,
        };
      });
    },
  },
});
```

### Scorecards Dashboard Configuration

```yaml
# backstage-scorecards.yaml (Tech Insights checks)
checks:
  - id: has-techdocs
    name: Has TechDocs
    description: Service must have TechDocs configured in catalog-info.yaml
    factRef: serviceReadiness/hasTechDocs
    rule:
      factOperator: EQUALS
      operands:
        - factValue: true
    successMetadata:
      label: documented
    failureMetadata:
      label: undocumented
      severity: warning

  - id: has-owner
    name: Has Owner
    description: Service must have a defined owner team
    factRef: serviceReadiness/hasOwner
    rule:
      factOperator: EQUALS
      operands:
        - factValue: true
    failureMetadata:
      severity: error

  - id: has-runbook
    name: Has Runbook
    description: Production services must have an operations runbook
    factRef: serviceReadiness/hasRunbook
    rule:
      factOperator: EQUALS
      operands:
        - factValue: true
    failureMetadata:
      severity: warning
      recommendation: "Add a runbook link to catalog-info.yaml metadata.links"
```

## Section 10: Production Operations

### Health Checks and Resource Configuration

```yaml
# backstage-deployment-patch.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backstage
  namespace: backstage
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: backstage
          resources:
            requests:
              cpu: "500m"
              memory: "1Gi"
            limits:
              cpu: "2000m"
              memory: "2Gi"
          livenessProbe:
            httpGet:
              path: /.backstage/health/v1/liveness
              port: 7007
            initialDelaySeconds: 60
            periodSeconds: 30
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /.backstage/health/v1/readiness
              port: 7007
            initialDelaySeconds: 30
            periodSeconds: 10
            failureThreshold: 3
```

### Catalog Performance Tuning

```yaml
# app-config.production.yaml additions
catalog:
  processingInterval:
    minutes: 3
  orphanStrategy: delete
  cache:
    store: redis
    connection: ${REDIS_URL}
    defaultTtl: 300

backend:
  cache:
    store: redis
    connection: ${REDIS_URL}
  database:
    client: pg
    connection:
      host: ${POSTGRES_HOST}
      user: ${POSTGRES_USER}
      password: ${POSTGRES_PASSWORD}
      database: backstage_plugin_catalog
      pool:
        min: 2
        max: 10
        acquireTimeoutMillis: 60000
        idleTimeoutMillis: 600000
```

### Backup Strategy

```bash
#!/bin/bash
# backstage-backup.sh
set -euo pipefail

NAMESPACE="backstage"
S3_BUCKET="acme-backstage-backups"
DATE=$(date +%Y%m%d-%H%M%S)

# PostgreSQL backup
kubectl exec -n "${NAMESPACE}" deploy/backstage-postgresql -- \
  pg_dump -U backstage backstage_plugin_catalog | \
  gzip | \
  aws s3 cp - "s3://${S3_BUCKET}/postgres/catalog-${DATE}.sql.gz"

echo "Backup completed: catalog-${DATE}.sql.gz"
```

## Summary

A production Backstage deployment delivers measurable improvements in developer experience and platform visibility. Key outcomes from mature implementations include 40-60% reduction in service onboarding time through scaffolder golden paths, unified documentation discovery via TechDocs, real-time Kubernetes visibility within the catalog, and data-driven platform investment decisions through Tech Insights scorecards. The permission framework ensures that catalog data remains accurate and governed while remaining accessible to the teams that need it.

The configurations in this guide represent production-validated patterns from enterprise Backstage deployments. Start with the software catalog and TechDocs to deliver immediate value, then layer in scaffolder templates and custom plugins as the platform team's capacity allows.
