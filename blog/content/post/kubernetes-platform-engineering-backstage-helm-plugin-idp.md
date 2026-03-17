---
title: "Kubernetes Platform Engineering: Internal Developer Portal with Backstage and Helm Plugin"
date: 2030-04-06T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Backstage", "Platform Engineering", "Internal Developer Portal", "Helm", "DevOps"]
categories: ["Kubernetes", "Platform Engineering", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production Backstage deployment on Kubernetes: software catalog automation, Helm plugin for deploying from the Internal Developer Portal, custom plugin development, tech-radar automation, and full GitOps integration."
more_link: "yes"
url: "/kubernetes-platform-engineering-backstage-helm-plugin-idp/"
---

Platform engineering has emerged as the discipline of building and maintaining the toolchains that product teams use to build, deploy, and operate software. At the center of many mature platform engineering efforts is an Internal Developer Portal (IDP) — a single pane of glass that surfaces service catalogs, runbooks, deployment capabilities, and operational insights to developers without requiring them to understand the underlying platform machinery.

Backstage, developed by Spotify and donated to the CNCF, has become the dominant open-source IDP framework. This guide covers a production-grade Backstage deployment on Kubernetes, software catalog automation via annotation conventions, the Helm plugin for deployments, and the patterns needed to make an IDP valuable rather than yet another internal tool that nobody uses.

<!--more-->

## Why Internal Developer Portals Fail

Before getting into implementation, it is worth understanding why most IDP initiatives underdeliver. The pattern is consistent: a platform team builds a portal, populates it with documentation and service entries, launches it internally, and achieves mediocre adoption. Six months later, the catalog is stale, developers continue using their existing workflows, and the portal becomes a maintenance burden.

The failures share common causes:

- **Catalog populated manually**: Documentation written by hand goes stale. Engineers stop trusting it.
- **No integration with actual workflows**: If deploying from the portal requires extra steps versus using the CLI, developers will use the CLI.
- **Ownership gaps**: Nobody owns keeping catalog entries accurate over time.
- **Missing self-service**: The portal surfaces information but doesn't let developers take action.

The implementation in this guide addresses all four failure modes: automated catalog discovery via Kubernetes annotations, Helm-based self-service deployments, ownership enforced through CODEOWNERS-style policies, and actions that replace CLI workflows rather than duplicating them.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Platform Cluster                        │
│                                                             │
│  ┌────────────────────────────────────────────────────┐     │
│  │                   Backstage Pod                    │     │
│  │  ┌──────────────┐  ┌──────────────────────────┐   │     │
│  │  │  App Backend │  │     Frontend (React)     │   │     │
│  │  │  - Catalog   │  │  - Software Catalog UI   │   │     │
│  │  │  - K8s Plugin│  │  - Tech Radar            │   │     │
│  │  │  - Helm Plugin│ │  - Scaffolder Templates  │   │     │
│  │  │  - Auth (GH) │  │  - API Explorer          │   │     │
│  │  └──────────────┘  └──────────────────────────┘   │     │
│  └────────────────────────────────────────────────────┘     │
│                            │                                │
│  ┌─────────────────────────┼───────────────────────────┐   │
│  │         Dependencies    │                            │   │
│  │  PostgreSQL (catalog)   │   Redis (cache)            │   │
│  └─────────────────────────┼───────────────────────────┘   │
└────────────────────────────┼────────────────────────────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
    GitHub API         K8s API Server      Helm Repos
  (catalog, SCM)     (service discovery)  (deployments)
```

## Deploying Backstage on Kubernetes

### Helm Chart Installation

The official Backstage Helm chart from the Backstage community is the recommended deployment mechanism:

```bash
# Add the Backstage Helm repository
helm repo add backstage https://backstage.github.io/charts
helm repo update

# Inspect available chart values
helm show values backstage/backstage > backstage-values.yaml
```

### Core Values Configuration

```yaml
# backstage-production-values.yaml
backstage:
  image:
    registry: your-registry.io
    repository: platform/backstage
    tag: "1.25.0"
    pullPolicy: IfNotPresent

  # Application configuration mounted from ConfigMap
  appConfig:
    app:
      title: "Acme Developer Portal"
      baseUrl: https://portal.internal.acme.com

    backend:
      baseUrl: https://portal.internal.acme.com
      listen:
        port: 7007
      csp:
        connect-src: ["'self'", "http:", "https:"]
      cors:
        origin: https://portal.internal.acme.com
        methods: [GET, HEAD, PATCH, POST, PUT, DELETE]
        credentials: true

      # Database connection (uses K8s secret)
      database:
        client: pg
        connection:
          host: ${POSTGRES_HOST}
          port: ${POSTGRES_PORT}
          user: ${POSTGRES_USER}
          password: ${POSTGRES_PASSWORD}
          database: backstage_plugin_catalog

      cache:
        store: redis
        connection: ${REDIS_URL}

    # GitHub integration for catalog discovery
    integrations:
      github:
        - host: github.com
          token: ${GITHUB_TOKEN}

    # Catalog configuration
    catalog:
      import:
        entityFilename: catalog-info.yaml
        pullRequestBranchName: backstage-integration
      rules:
        - allow: [Component, API, Location, Template, User, Group, System, Domain]
      providers:
        github:
          # Auto-discover catalog-info.yaml files across the organization
          acme-org:
            organization: acme-corp
            catalogPath: /catalog-info.yaml
            filters:
              branch: main
              repository: '.*'  # all repositories
            schedule:
              frequency:
                minutes: 30
              timeout:
                minutes: 10

    # Authentication
    auth:
      environment: production
      providers:
        github:
          production:
            clientId: ${AUTH_GITHUB_CLIENT_ID}
            clientSecret: ${AUTH_GITHUB_CLIENT_SECRET}

    # Kubernetes plugin
    kubernetes:
      serviceLocatorMethod:
        type: multiTenant
      clusterLocatorMethods:
        - type: config
          clusters:
            - url: https://production.k8s.acme.com
              name: production
              authProvider: serviceAccount
              serviceAccountToken: ${K8S_PROD_TOKEN}
              skipTLSVerify: false
              caData: ${K8S_PROD_CA}
            - url: https://staging.k8s.acme.com
              name: staging
              authProvider: serviceAccount
              serviceAccountToken: ${K8S_STAGING_TOKEN}
              caData: ${K8S_STAGING_CA}

    # Tech Radar
    techRadar:
      url: https://portal.internal.acme.com/tech-radar.json

  extraEnvVars:
    - name: LOG_LEVEL
      value: warn
    - name: NODE_ENV
      value: production

  extraEnvVarsSecrets:
    - backstage-secrets

  podAnnotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "7007"
    prometheus.io/path: "/api/metrics"

postgresql:
  enabled: false  # Use external PostgreSQL

ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/proxy-body-size: 10m
  hosts:
    - host: portal.internal.acme.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: backstage-tls
      hosts:
        - portal.internal.acme.com

serviceAccount:
  create: true
  name: backstage
  annotations:
    # AWS IRSA annotation if using EKS
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/backstage-role

resources:
  requests:
    memory: "512Mi"
    cpu: "250m"
  limits:
    memory: "1Gi"
    cpu: "1000m"
```

### Secrets Management

```yaml
# backstage-secret.yaml (created via external-secrets or manual)
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: backstage-secrets
  namespace: backstage
spec:
  refreshInterval: 1h
  secretStoreRef:
    kind: ClusterSecretStore
    name: vault-backend
  target:
    name: backstage-secrets
    creationPolicy: Owner
  data:
    - secretKey: POSTGRES_HOST
      remoteRef:
        key: backstage/database
        property: host
    - secretKey: POSTGRES_PORT
      remoteRef:
        key: backstage/database
        property: port
    - secretKey: POSTGRES_USER
      remoteRef:
        key: backstage/database
        property: username
    - secretKey: POSTGRES_PASSWORD
      remoteRef:
        key: backstage/database
        property: password
    - secretKey: GITHUB_TOKEN
      remoteRef:
        key: backstage/github
        property: token
    - secretKey: AUTH_GITHUB_CLIENT_ID
      remoteRef:
        key: backstage/github-oauth
        property: client_id
    - secretKey: AUTH_GITHUB_CLIENT_SECRET
      remoteRef:
        key: backstage/github-oauth
        property: client_secret
```

## Software Catalog Automation

### catalog-info.yaml Convention

Every service in your organization should have a `catalog-info.yaml` at the root of its repository:

```yaml
# catalog-info.yaml in a typical service repository
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: payment-service
  title: Payment Service
  description: Handles payment processing, refunds, and charge-backs
  annotations:
    # GitHub repository link
    github.com/project-slug: acme-corp/payment-service

    # Kubernetes workload discovery
    backstage.io/kubernetes-id: payment-service
    backstage.io/kubernetes-label-selector: "app=payment-service"

    # Link to Argo CD application
    argocd/app-name: payment-service-prod

    # Link to monitoring dashboards
    grafana/dashboard-selector: "service=payment-service"
    grafana/alert-label-selector: "service=payment-service"

    # Runbook location
    backstage.io/techdocs-ref: dir:.

    # On-call information
    pagerduty.com/integration-key: ${PAGERDUTY_INTEGRATION_KEY}

    # Sonarqube for code quality
    sonarqube.org/project-key: payment-service

    # Link to CI/CD
    backstage.io/ci-workflow: ".github/workflows/ci.yml"

  tags:
    - payments
    - critical
    - go

  links:
    - url: https://grafana.acme.com/d/payment-service
      title: Grafana Dashboard
      icon: dashboard
    - url: https://logs.acme.com/app/discover#/?_a=(query:(language:kuery,query:'kubernetes.labels.app:payment-service'))
      title: Kibana Logs
      icon: logs
    - url: https://runbooks.acme.com/payment-service
      title: Runbook
      icon: book

spec:
  type: service
  lifecycle: production
  owner: team-payments
  system: payment-platform
  dependsOn:
    - component:default/fraud-detection-service
    - resource:default/payments-postgres-db
    - resource:default/payments-kafka-topic
  providesApis:
    - payment-service-api
  consumesApis:
    - user-service-api
    - notification-service-api
```

### API Definition Registration

```yaml
# api-catalog-info.yaml
apiVersion: backstage.io/v1alpha1
kind: API
metadata:
  name: payment-service-api
  title: Payment Service API
  description: REST API for payment processing operations
  annotations:
    backstage.io/kubernetes-id: payment-service
spec:
  type: openapi
  lifecycle: production
  owner: team-payments
  system: payment-platform
  definition:
    $text: https://payment-service.acme.com/openapi.json
```

### Automated Catalog Refresh

```typescript
// packages/backend/src/plugins/catalog.ts
import { CatalogBuilder } from '@backstage/plugin-catalog-backend';
import { ScaffolderEntitiesProcessor } from '@backstage/plugin-scaffolder-backend';
import { Router } from 'express';
import { PluginEnvironment } from '../types';
import { GithubDiscoveryProcessor, GithubOrgReaderProcessor } from '@backstage/plugin-catalog-backend-module-github';
import { GitlabDiscoveryProcessor } from '@backstage/plugin-catalog-backend-module-gitlab';

export default async function createPlugin(
  env: PluginEnvironment,
): Promise<Router> {
  const builder = await CatalogBuilder.create(env);

  // Add GitHub discovery processor for automatic catalog-info.yaml discovery
  builder.addProcessor(
    GithubDiscoveryProcessor.fromConfig(env.config, {
      logger: env.logger,
    }),
  );

  // Add GitHub org reader for user/group discovery
  builder.addProcessor(
    GithubOrgReaderProcessor.fromConfig(env.config, {
      logger: env.logger,
    }),
  );

  builder.addProcessor(new ScaffolderEntitiesProcessor());

  const { processingEngine, router } = await builder.build();
  await processingEngine.start();

  return router;
}
```

## Helm Plugin for Self-Service Deployments

### Installing the Backstage Helm Plugin

```bash
# In your Backstage app directory
# Install the Helm plugin packages
yarn --cwd packages/app add @backstage-community/plugin-helm

# Backend plugin for Helm operations
yarn --cwd packages/backend add @backstage-community/plugin-helm-backend
```

### Frontend Plugin Integration

```typescript
// packages/app/src/components/catalog/EntityPage.tsx
import { HelmReleaseCard, isHelmAvailable } from '@backstage-community/plugin-helm';

// Add to the service entity page
const serviceEntityPage = (
  <EntityLayout>
    <EntityLayout.Route path="/" title="Overview">
      <Grid container spacing={3} alignItems="stretch">
        <Grid item md={6}>
          <EntityAboutCard variant="gridItem" />
        </Grid>
        <Grid item md={6} xs={12}>
          <EntityCatalogGraphCard variant="gridItem" height={400} />
        </Grid>
        {/* Add Helm releases card */}
        <EntitySwitch>
          <EntitySwitch.Case if={isHelmAvailable}>
            <Grid item md={6}>
              <HelmReleaseCard />
            </Grid>
          </EntitySwitch.Case>
        </EntitySwitch>
      </Grid>
    </EntityLayout.Route>

    {/* Helm releases tab */}
    <EntityLayout.Route path="/helm" title="Helm Releases">
      <HelmReleaseCard />
    </EntityLayout.Route>
  </EntityLayout>
);
```

### Backend Helm Plugin Configuration

```typescript
// packages/backend/src/plugins/helm.ts
import { createRouter } from '@backstage-community/plugin-helm-backend';
import { Router } from 'express';
import { PluginEnvironment } from '../types';

export default async function createPlugin(
  env: PluginEnvironment,
): Promise<Router> {
  return await createRouter({
    logger: env.logger,
    config: env.config,
    discovery: env.discovery,
    identity: env.identity,
  });
}
```

```yaml
# app-config.yaml - Helm plugin configuration
helm:
  clusterLocatorMethods:
    - type: config
      clusters:
        - url: https://production.k8s.acme.com
          name: production
          serviceAccountToken: ${K8S_PROD_TOKEN}
          caData: ${K8S_PROD_CA}
```

### Catalog Annotation for Helm Integration

```yaml
# catalog-info.yaml with Helm annotations
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: payment-service
  annotations:
    # Helm plugin annotations
    helm.sh/chart: payment-service
    helm.sh/release-name: payment-service
    helm.sh/namespace: payment-service
    helm.sh/cluster: production
spec:
  type: service
  lifecycle: production
  owner: team-payments
```

## Scaffolder Templates for New Services

### Service Template

```yaml
# scaffold-template-go-service.yaml
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: go-microservice-template
  title: Go Microservice
  description: Create a new Go microservice with standard tooling pre-configured
  tags:
    - go
    - microservice
    - recommended
spec:
  owner: platform-team
  type: service

  parameters:
    - title: Service Details
      required: [name, description, owner, system]
      properties:
        name:
          title: Service Name
          type: string
          description: Unique name for your service (kebab-case)
          pattern: '^[a-z][a-z0-9-]*[a-z0-9]$'
          maxLength: 63

        description:
          title: Description
          type: string
          description: What does this service do?

        owner:
          title: Owner Team
          type: string
          description: Team responsible for this service
          ui:field: OwnerPicker
          ui:options:
            catalogFilter:
              kind: Group

        system:
          title: System
          type: string
          description: Which system does this service belong to?
          ui:field: EntityPicker
          ui:options:
            catalogFilter:
              kind: System

    - title: Infrastructure
      required: [database, cache]
      properties:
        database:
          title: Database
          type: string
          enum: [none, postgres, mysql, sqlite]
          default: none

        cache:
          title: Cache
          type: string
          enum: [none, redis, memcached]
          default: none

        cloudProvider:
          title: Cloud Provider
          type: string
          enum: [aws, gcp, azure]
          default: aws

    - title: Repository
      required: [repoUrl]
      properties:
        repoUrl:
          title: Repository Location
          type: string
          ui:field: RepoUrlPicker
          ui:options:
            allowedHosts: [github.com]

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

    - id: create-repo
      name: Create Repository
      action: publish:github
      input:
        allowedHosts: [github.com]
        description: ${{ parameters.description }}
        repoUrl: ${{ parameters.repoUrl }}
        defaultBranch: main
        topics: [go, microservice, ${{ parameters.system }}]
        repoVisibility: internal

    - id: create-argocd-app
      name: Create ArgoCD Application
      action: argocd:create-application
      input:
        appName: ${{ parameters.name }}-staging
        argoInstance: production
        namespace: ${{ parameters.name }}
        project: default
        repoUrl: ${{ steps['create-repo'].output.repoContentsUrl }}
        labelValue: ${{ parameters.name }}
        path: deploy/helm
        valueFiles:
          - values-staging.yaml

    - id: register-catalog
      name: Register in Catalog
      action: catalog:register
      input:
        repoContentsUrl: ${{ steps['create-repo'].output.repoContentsUrl }}
        catalogInfoPath: /catalog-info.yaml

  output:
    links:
      - title: Repository
        url: ${{ steps['create-repo'].output.remoteUrl }}
      - title: Open in catalog
        icon: catalog
        entityRef: ${{ steps['register-catalog'].output.entityRef }}
```

## Custom Plugin: Deployment Approval Workflow

```typescript
// plugins/deployment-approvals/src/plugin.ts
import {
  createPlugin,
  createRoutableExtension,
} from '@backstage/core-plugin-api';
import { rootRouteRef } from './routes';

export const deploymentApprovalsPlugin = createPlugin({
  id: 'deployment-approvals',
  routes: {
    root: rootRouteRef,
  },
});

export const DeploymentApprovalsPage = deploymentApprovalsPlugin.provide(
  createRoutableExtension({
    name: 'DeploymentApprovalsPage',
    component: () =>
      import('./components/DeploymentApprovalsPage').then(
        m => m.DeploymentApprovalsPage,
      ),
    mountPoint: rootRouteRef,
  }),
);
```

```typescript
// plugins/deployment-approvals/src/components/DeploymentApprovalsPage.tsx
import React, { useState, useEffect } from 'react';
import {
  Table,
  TableColumn,
  Progress,
  ResponseErrorPanel,
} from '@backstage/core-components';
import {
  useApi,
  discoveryApiRef,
  identityApiRef,
} from '@backstage/core-plugin-api';
import { Button, Chip } from '@material-ui/core';

interface DeploymentRequest {
  id: string;
  serviceName: string;
  environment: string;
  version: string;
  requestedBy: string;
  requestedAt: string;
  status: 'pending' | 'approved' | 'rejected';
}

export const DeploymentApprovalsPage = () => {
  const discoveryApi = useApi(discoveryApiRef);
  const identityApi = useApi(identityApiRef);
  const [requests, setRequests] = useState<DeploymentRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const fetchRequests = async () => {
      try {
        const baseUrl = await discoveryApi.getBaseUrl('deployment-approvals');
        const identity = await identityApi.getCredentials();
        const response = await fetch(`${baseUrl}/requests?status=pending`, {
          headers: { Authorization: `Bearer ${identity.token}` },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        setRequests(data.requests);
      } catch (e) {
        setError(e as Error);
      } finally {
        setLoading(false);
      }
    };
    fetchRequests();
  }, [discoveryApi, identityApi]);

  const handleApprove = async (id: string) => {
    const baseUrl = await discoveryApi.getBaseUrl('deployment-approvals');
    const identity = await identityApi.getCredentials();
    await fetch(`${baseUrl}/requests/${id}/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${identity.token}` },
    });
    setRequests(prev => prev.filter(r => r.id !== id));
  };

  if (loading) return <Progress />;
  if (error) return <ResponseErrorPanel error={error} />;

  const columns: TableColumn<DeploymentRequest>[] = [
    { title: 'Service', field: 'serviceName' },
    { title: 'Environment', field: 'environment' },
    { title: 'Version', field: 'version' },
    { title: 'Requested By', field: 'requestedBy' },
    {
      title: 'Status',
      field: 'status',
      render: row => (
        <Chip
          label={row.status}
          color={row.status === 'pending' ? 'default' : row.status === 'approved' ? 'primary' : 'secondary'}
        />
      ),
    },
    {
      title: 'Actions',
      render: row => (
        <Button
          variant="contained"
          color="primary"
          size="small"
          onClick={() => handleApprove(row.id)}
        >
          Approve
        </Button>
      ),
    },
  ];

  return (
    <Table
      title="Pending Deployment Approvals"
      options={{ search: true, paging: true, pageSize: 20 }}
      columns={columns}
      data={requests}
    />
  );
};
```

## Tech Radar Automation

### Generating Tech Radar from Repository Data

```typescript
// packages/backend/src/tech-radar/generator.ts
import { Octokit } from '@octokit/rest';

interface TechRadarEntry {
  key: string;
  id: string;
  title: string;
  quadrant: string;
  ring: string;
  description: string;
  moved: number; // 1=moved_in, -1=moved_out, 0=unchanged
}

interface TechRadarData {
  entries: TechRadarEntry[];
  quadrants: Array<{ id: string; name: string }>;
  rings: Array<{ id: string; name: string; color: string; description: string }>;
}

export async function generateTechRadar(
  octokit: Octokit,
  org: string,
): Promise<TechRadarData> {
  // Analyze dependencies across all repositories
  const languageCounts = new Map<string, number>();
  const frameworkCounts = new Map<string, number>();

  const repos = await octokit.paginate(octokit.repos.listForOrg, {
    org,
    type: 'internal',
    per_page: 100,
  });

  for (const repo of repos) {
    const languages = await octokit.repos.listLanguages({
      owner: org,
      repo: repo.name,
    });
    for (const [lang, bytes] of Object.entries(languages.data)) {
      languageCounts.set(lang, (languageCounts.get(lang) || 0) + bytes);
    }
  }

  // Build radar entries based on usage
  const entries: TechRadarEntry[] = [];

  for (const [lang, bytes] of languageCounts.entries()) {
    const ring = bytes > 1_000_000 ? 'adopt' :
                 bytes > 100_000  ? 'trial' :
                 bytes > 10_000   ? 'assess' : 'hold';

    entries.push({
      key: lang.toLowerCase(),
      id: lang.toLowerCase(),
      title: lang,
      quadrant: 'languages',
      ring,
      description: `${lang} is used across ${Math.floor(bytes / 1000)}KB of code in the organization`,
      moved: 0,
    });
  }

  return {
    entries,
    quadrants: [
      { id: 'languages', name: 'Languages' },
      { id: 'frameworks', name: 'Frameworks' },
      { id: 'tools', name: 'Tools' },
      { id: 'platforms', name: 'Platforms & Infrastructure' },
    ],
    rings: [
      { id: 'adopt', name: 'Adopt', color: '#93c47d', description: 'Proven and recommended for wide use' },
      { id: 'trial', name: 'Trial', color: '#93d2d9', description: 'Worth pursuing; limited production use' },
      { id: 'assess', name: 'Assess', color: '#fbdb84', description: 'Interesting, investigate before production' },
      { id: 'hold', name: 'Hold', color: '#efafa9', description: 'Proceed with caution or avoid for new projects' },
    ],
  };
}
```

## RBAC and Access Control

### Backstage Permission Framework

```typescript
// packages/backend/src/plugins/permission.ts
import {
  BackstageIdentityResponse,
} from '@backstage/plugin-auth-node';
import {
  PolicyDecision,
  AuthorizeResult,
  PolicyQuery,
} from '@backstage/plugin-permission-common';
import {
  PermissionPolicy,
} from '@backstage/plugin-permission-node';
import {
  catalogConditions,
  createCatalogConditionalDecision,
} from '@backstage/plugin-catalog-backend/alpha';

export class AcmePermissionPolicy implements PermissionPolicy {
  async handle(
    request: PolicyQuery,
    user?: BackstageIdentityResponse,
  ): Promise<PolicyDecision> {
    if (!user) {
      return { result: AuthorizeResult.DENY };
    }

    // Platform team has full access
    if (user.identity.ownershipEntityRefs.includes('group:default/platform-team')) {
      return { result: AuthorizeResult.ALLOW };
    }

    // For catalog entity operations, restrict to owned entities
    if (request.permission.name === 'catalog.entity.delete') {
      return createCatalogConditionalDecision(
        request.permission,
        catalogConditions.isEntityOwner({
          claims: user.identity.ownershipEntityRefs,
        }),
      );
    }

    // Default allow read operations
    if (request.permission.attributes.action === 'read') {
      return { result: AuthorizeResult.ALLOW };
    }

    return { result: AuthorizeResult.DENY };
  }
}
```

## Operational Considerations

### Health Check and Monitoring

```yaml
# backstage-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: backstage
  namespace: backstage
  labels:
    release: kube-prometheus-stack
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: backstage
  endpoints:
    - port: backend
      path: /api/metrics
      interval: 30s
```

```yaml
# backstage-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: backstage-alerts
  namespace: backstage
spec:
  groups:
    - name: backstage.rules
      rules:
        - alert: BackstageCatalogStale
          expr: |
            backstage_catalog_entities_count < 10
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "Backstage catalog has fewer than 10 entities"
            description: "The Backstage software catalog may have failed to sync from GitHub"

        - alert: BackstageHighLatency
          expr: |
            histogram_quantile(0.95,
              rate(http_request_duration_seconds_bucket{job="backstage"}[5m])
            ) > 2
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Backstage API p95 latency > 2s"
```

## Key Takeaways

A successful Internal Developer Portal requires more than deploying Backstage. The patterns that drive adoption are:

1. **Automated catalog population** via GitHub discovery and annotation conventions. Manual catalog entries stale immediately. Every `catalog-info.yaml` should be generated from a template during service scaffolding and kept current by CI checks that fail when annotations are missing or outdated.

2. **Self-service deployments via the Helm plugin** replace CLI workflows rather than duplicating them. When a developer can trigger a deployment from the IDP with the same reliability as running `helm upgrade`, adoption follows naturally. The approval workflow plugin closes the loop by giving team leads visibility and control.

3. **Scaffolder templates as the gateway** ensure every new service starts with the right structure, annotations, monitoring, and compliance controls in place. No tribal knowledge required.

4. **Permission policies** that match your organizational model. Platform engineers need full access; application teams need write access to their own components. Overly restrictive policies prevent self-service; overly permissive ones create compliance exposure.

5. **Measure catalog health** with alerts on entity count and staleness. A catalog that silently fails to sync creates false confidence and erodes trust in the portal over time.
