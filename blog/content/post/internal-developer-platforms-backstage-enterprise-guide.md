---
title: "Building Internal Developer Platforms with Backstage: Enterprise Implementation Guide"
date: 2026-08-10T00:00:00-05:00
draft: false
tags: ["Backstage", "Platform Engineering", "Developer Experience", "Internal Developer Platform", "IDP", "Kubernetes", "DevOps"]
categories: ["Platform Engineering", "Developer Tools"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing Spotify's Backstage as an enterprise internal developer platform with service catalog, scaffolding templates, and plugin development."
more_link: "yes"
url: "/internal-developer-platforms-backstage-enterprise-guide/"
---

Internal Developer Platforms (IDPs) have become essential for organizations scaling their engineering teams. Backstage, originally developed by Spotify, provides an open-source framework for building developer portals that unify infrastructure tooling, services, and documentation. This guide demonstrates how to implement Backstage at enterprise scale with production-ready configurations.

<!--more-->

# Building Internal Developer Platforms with Backstage: Enterprise Implementation Guide

## Understanding Internal Developer Platforms

An Internal Developer Platform serves as the single pane of glass for developers, providing:

- **Service Catalog**: Centralized registry of all services, libraries, and resources
- **Software Templates**: Standardized project scaffolding with best practices
- **Documentation Hub**: Unified documentation across all teams
- **Infrastructure Abstraction**: Self-service access to infrastructure without deep expertise
- **Plugin Ecosystem**: Extensible architecture for integrating existing tools

## Backstage Architecture Overview

Backstage consists of three core components:

```
┌─────────────────────────────────────────────────────────┐
│                     Frontend (React)                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │ Catalog  │  │Templates │  │   Docs   │  │ Plugins │ │
│  └──────────┘  └──────────┘  └──────────┘  └─────────┘ │
└─────────────────────────────────────────────────────────┘
                            │
┌─────────────────────────────────────────────────────────┐
│                    Backend (Node.js)                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │ Catalog  │  │Scaffolder│  │TechDocs  │  │ Search  │ │
│  │  Engine  │  │  Engine  │  │  Engine  │  │ Engine  │ │
│  └──────────┘  └──────────┘  └──────────┘  └─────────┘ │
└─────────────────────────────────────────────────────────┘
                            │
┌─────────────────────────────────────────────────────────┐
│                    Data Sources                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │   Git    │  │   K8s    │  │  Cloud   │  │  APIs   │ │
│  └──────────┘  └──────────┘  └──────────┘  └─────────┘ │
└─────────────────────────────────────────────────────────┘
```

## Initial Backstage Setup

### Creating the Backstage Application

```bash
# Install Backstage CLI
npm install -g @backstage/create-app

# Create new Backstage instance
npx @backstage/create-app --skip-install

cd backstage

# Install dependencies
yarn install
```

### Enterprise Configuration Structure

```yaml
# app-config.yaml
app:
  title: Enterprise Developer Portal
  baseUrl: https://backstage.company.com

organization:
  name: Company Inc

backend:
  baseUrl: https://backstage.company.com
  listen:
    port: 7007
    host: 0.0.0.0

  csp:
    connect-src: ["'self'", 'http:', 'https:']
    upgrade-insecure-requests: false

  cors:
    origin: https://backstage.company.com
    methods: [GET, POST, PUT, DELETE]
    credentials: true

  database:
    client: pg
    connection:
      host: ${POSTGRES_HOST}
      port: ${POSTGRES_PORT}
      user: ${POSTGRES_USER}
      password: ${POSTGRES_PASSWORD}
      database: backstage_catalog
      ssl:
        ca: ${POSTGRES_CA_CERT}

  cache:
    store: redis
    connection: redis://${REDIS_HOST}:${REDIS_PORT}
    useRedisSets: true

auth:
  environment: production
  providers:
    okta:
      production:
        clientId: ${AUTH_OKTA_CLIENT_ID}
        clientSecret: ${AUTH_OKTA_CLIENT_SECRET}
        audience: ${AUTH_OKTA_AUDIENCE}
        authServerId: ${AUTH_OKTA_SERVER_ID}
        idp: ${AUTH_OKTA_IDP}

catalog:
  import:
    entityFilename: catalog-info.yaml
    pullRequestBranchName: backstage-integration

  rules:
    - allow: [Component, System, API, Resource, Location, Template, User, Group]

  locations:
    - type: url
      target: https://github.com/company/backstage-catalog/blob/main/catalog-info.yaml

    # Discover all catalog-info.yaml files in organization
    - type: github-discovery
      target: https://github.com/company/*/blob/main/catalog-info.yaml

  processors:
    githubOrg:
      providers:
        - target: https://github.com
          apiBaseUrl: https://api.github.com
          token: ${GITHUB_TOKEN}

integrations:
  github:
    - host: github.com
      token: ${GITHUB_TOKEN}
      apiBaseUrl: https://api.github.com

  gitlab:
    - host: gitlab.company.com
      token: ${GITLAB_TOKEN}
      apiBaseUrl: https://gitlab.company.com/api/v4

  azure:
    - host: dev.azure.com
      token: ${AZURE_TOKEN}

kubernetes:
  serviceLocatorMethod:
    type: 'multiTenant'
  clusterLocatorMethods:
    - type: 'config'
      clusters:
        - url: https://k8s-prod.company.com
          name: production
          authProvider: 'serviceAccount'
          skipTLSVerify: false
          caData: ${K8S_PROD_CA}
          serviceAccountToken: ${K8S_PROD_TOKEN}
          dashboardUrl: https://k8s-dashboard-prod.company.com

        - url: https://k8s-staging.company.com
          name: staging
          authProvider: 'serviceAccount'
          skipTLSVerify: false
          caData: ${K8S_STAGING_CA}
          serviceAccountToken: ${K8S_STAGING_TOKEN}

techdocs:
  builder: 'external'
  generator:
    runIn: 'docker'
  publisher:
    type: 'awsS3'
    awsS3:
      bucketName: ${TECHDOCS_S3_BUCKET}
      region: ${AWS_REGION}
      accountId: ${AWS_ACCOUNT_ID}

scaffolder:
  defaultAuthor:
    name: Backstage System
    email: backstage@company.com

  defaultCommitMessage: 'Initial commit from Backstage template'

proxy:
  '/prometheus/api':
    target: https://prometheus.company.com/api/v1/
    changeOrigin: true
    secure: true
    headers:
      Authorization: Bearer ${PROMETHEUS_TOKEN}

  '/grafana/api':
    target: https://grafana.company.com/
    changeOrigin: true
    secure: true
    headers:
      Authorization: Bearer ${GRAFANA_TOKEN}

  '/argocd/api':
    target: https://argocd.company.com/api/v1/
    changeOrigin: true
    secure: true
    headers:
      Cookie: ${ARGOCD_AUTH_TOKEN}

search:
  pg:
    highlightOptions:
      useHighlight: true
      maxWords: 35
      minWords: 15
      shortWord: 3
      highlightAll: false
      maxFragments: 0
      fragmentDelimiter: ' ... '

  elasticsearch:
    provider: elastic
    clientOptions:
      node: ${ELASTICSEARCH_URL}
      auth:
        username: ${ELASTICSEARCH_USERNAME}
        password: ${ELASTICSEARCH_PASSWORD}
```

## Service Catalog Implementation

### Entity Descriptor Schemas

```yaml
# catalog-info.yaml - API Definition
apiVersion: backstage.io/v1alpha1
kind: API
metadata:
  name: payment-api
  description: Payment processing API
  annotations:
    github.com/project-slug: company/payment-service
    backstage.io/techdocs-ref: dir:.
    prometheus.io/rule: payment_api_requests_total
    grafana/dashboard-selector: payment-api-dashboard
    pagerduty.com/integration-key: payment-api-key
    sonarqube.org/project-key: payment-api
spec:
  type: openapi
  lifecycle: production
  owner: payments-team
  system: payment-system
  definition:
    $text: https://github.com/company/payment-service/blob/main/openapi.yaml

---
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: payment-service
  description: Payment processing microservice
  tags:
    - java
    - spring-boot
    - payments
    - pci-dss
  annotations:
    github.com/project-slug: company/payment-service
    backstage.io/techdocs-ref: dir:.
    jenkins.io/job-full-name: payment-service/main
    sonarqube.org/project-key: payment-service
    snyk.io/org-id: company
    snyk.io/project-ids: payment-service-id
    circleci.com/project-slug: github/company/payment-service
    pagerduty.com/integration-key: payment-service-key
    opsgenie.com/component-selector: payment-service
    datadog/dashboard-url: https://app.datadoghq.com/dashboard/payment-service
    newrelic.com/dashboard-guid: payment-service-guid
  links:
    - url: https://wiki.company.com/payment-service
      title: Wiki
      icon: docs
    - url: https://grafana.company.com/d/payment-service
      title: Grafana Dashboard
      icon: dashboard
    - url: https://payment-service.company.com
      title: Production Service
      icon: web
    - url: https://runbooks.company.com/payment-service
      title: Runbook
      icon: catalog
spec:
  type: service
  lifecycle: production
  owner: payments-team
  system: payment-system
  providesApis:
    - payment-api
  consumesApis:
    - fraud-detection-api
    - notification-api
  dependsOn:
    - resource:payment-database
    - resource:payment-cache
    - component:fraud-detection-service

---
apiVersion: backstage.io/v1alpha1
kind: System
metadata:
  name: payment-system
  description: Complete payment processing system
  annotations:
    backstage.io/techdocs-ref: dir:.
spec:
  owner: payments-team
  domain: financial-services

---
apiVersion: backstage.io/v1alpha1
kind: Resource
metadata:
  name: payment-database
  description: PostgreSQL database for payments
  annotations:
    aws.com/arn: arn:aws:rds:us-east-1:123456789012:db:payment-prod
spec:
  type: database
  owner: payments-team
  system: payment-system

---
apiVersion: backstage.io/v1alpha1
kind: Group
metadata:
  name: payments-team
  description: Payment processing team
spec:
  type: team
  profile:
    displayName: Payments Team
    email: payments@company.com
    picture: https://avatars.company.com/teams/payments
  parent: financial-services
  children: []
  members:
    - user:john.doe
    - user:jane.smith
    - user:bob.johnson

---
apiVersion: backstage.io/v1alpha1
kind: User
metadata:
  name: john.doe
  description: Senior Backend Engineer
spec:
  profile:
    displayName: John Doe
    email: john.doe@company.com
    picture: https://avatars.company.com/john.doe
  memberOf:
    - payments-team
```

### Custom Catalog Processor

```typescript
// packages/backend/src/plugins/catalog/processors/CustomProcessor.ts
import {
  CatalogProcessor,
  CatalogProcessorEmit,
  processingResult,
} from '@backstage/plugin-catalog-node';
import { LocationSpec } from '@backstage/plugin-catalog-common';
import { Entity } from '@backstage/catalog-model';
import { Logger } from 'winston';

export class CustomEnrichmentProcessor implements CatalogProcessor {
  constructor(private readonly logger: Logger) {}

  getProcessorName(): string {
    return 'CustomEnrichmentProcessor';
  }

  async preProcessEntity(
    entity: Entity,
    location: LocationSpec,
    emit: CatalogProcessorEmit,
  ): Promise<Entity> {
    // Add custom annotations based on entity type
    if (entity.kind === 'Component') {
      // Automatically add monitoring links
      if (!entity.metadata.annotations?.['grafana/dashboard-url']) {
        const componentName = entity.metadata.name;
        entity.metadata.annotations = {
          ...entity.metadata.annotations,
          'grafana/dashboard-url': `https://grafana.company.com/d/${componentName}`,
        };
      }

      // Add cost center based on team
      const owner = entity.spec?.owner as string;
      const costCenter = await this.getCostCenterForTeam(owner);
      entity.metadata.annotations = {
        ...entity.metadata.annotations,
        'company.com/cost-center': costCenter,
      };

      // Add compliance tags
      const tags = entity.metadata.tags || [];
      if (tags.includes('pci-dss')) {
        entity.metadata.annotations = {
          ...entity.metadata.annotations,
          'company.com/compliance': 'pci-dss',
          'company.com/data-classification': 'confidential',
        };
      }
    }

    return entity;
  }

  async postProcessEntity(
    entity: Entity,
    location: LocationSpec,
    emit: CatalogProcessorEmit,
  ): Promise<Entity> {
    // Validate required annotations
    if (entity.kind === 'Component' && entity.spec?.lifecycle === 'production') {
      const requiredAnnotations = [
        'github.com/project-slug',
        'pagerduty.com/integration-key',
        'grafana/dashboard-url',
      ];

      const missingAnnotations = requiredAnnotations.filter(
        annotation => !entity.metadata.annotations?.[annotation],
      );

      if (missingAnnotations.length > 0) {
        this.logger.warn(
          `Component ${entity.metadata.name} missing required annotations: ${missingAnnotations.join(', ')}`,
        );
      }
    }

    return entity;
  }

  async validateEntityKind(entity: Entity): Promise<boolean> {
    return true;
  }

  private async getCostCenterForTeam(teamName: string): Promise<string> {
    // Implement logic to fetch cost center from internal API
    const costCenterMap: Record<string, string> = {
      'payments-team': 'CC-1001',
      'platform-team': 'CC-2001',
      'data-team': 'CC-3001',
    };
    return costCenterMap[teamName] || 'CC-9999';
  }
}
```

### Catalog Backend Configuration

```typescript
// packages/backend/src/plugins/catalog.ts
import { CatalogBuilder } from '@backstage/plugin-catalog-backend';
import { ScaffolderEntitiesProcessor } from '@backstage/plugin-scaffolder-backend';
import { Router } from 'express';
import { PluginEnvironment } from '../types';
import { CustomEnrichmentProcessor } from './catalog/processors/CustomProcessor';
import { GithubEntityProvider } from '@backstage/plugin-catalog-backend-module-github';
import { GitlabEntityProvider } from '@backstage/plugin-catalog-backend-module-gitlab';
import { LdapOrgEntityProvider } from '@backstage/plugin-catalog-backend-module-ldap';

export default async function createPlugin(
  env: PluginEnvironment,
): Promise<Router> {
  const builder = await CatalogBuilder.create(env);

  // Add standard processors
  builder.addProcessor(new ScaffolderEntitiesProcessor());
  builder.addProcessor(new CustomEnrichmentProcessor(env.logger));

  // GitHub Entity Provider for automatic discovery
  builder.addEntityProvider(
    GithubEntityProvider.fromConfig(env.config, {
      logger: env.logger,
      schedule: env.scheduler.createScheduledTaskRunner({
        frequency: { hours: 1 },
        timeout: { minutes: 15 },
      }),
    }),
  );

  // GitLab Entity Provider
  builder.addEntityProvider(
    GitlabEntityProvider.fromConfig(env.config, {
      logger: env.logger,
      schedule: env.scheduler.createScheduledTaskRunner({
        frequency: { hours: 1 },
        timeout: { minutes: 15 },
      }),
    }),
  );

  // LDAP Provider for user/group sync
  builder.addEntityProvider(
    LdapOrgEntityProvider.fromConfig(env.config, {
      id: 'production',
      target: 'ldaps://ldap.company.com',
      logger: env.logger,
      schedule: env.scheduler.createScheduledTaskRunner({
        frequency: { hours: 4 },
        timeout: { minutes: 30 },
      }),
    }),
  );

  const { processingEngine, router } = await builder.build();
  await processingEngine.start();

  return router;
}
```

## Software Templates (Scaffolder)

### Comprehensive Template Example

```yaml
# templates/spring-boot-service/template.yaml
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: spring-boot-service
  title: Spring Boot Microservice
  description: Create a new Spring Boot microservice with best practices
  tags:
    - java
    - spring-boot
    - microservice
    - recommended
spec:
  owner: platform-team
  type: service

  parameters:
    - title: Service Information
      required:
        - name
        - description
        - owner
      properties:
        name:
          title: Name
          type: string
          description: Unique name of the service
          pattern: '^[a-z0-9-]+$'
          ui:autofocus: true
          ui:help: 'Must be lowercase with hyphens'

        description:
          title: Description
          type: string
          description: Brief description of the service
          ui:widget: textarea
          ui:options:
            rows: 3

        owner:
          title: Owner
          type: string
          description: Team that owns this service
          ui:field: OwnerPicker
          ui:options:
            allowedKinds:
              - Group

        system:
          title: System
          type: string
          description: System this service belongs to
          ui:field: EntityPicker
          ui:options:
            allowedKinds:
              - System
            defaultKind: System

    - title: Technical Configuration
      required:
        - javaVersion
        - springBootVersion
      properties:
        javaVersion:
          title: Java Version
          type: string
          enum:
            - '17'
            - '21'
          default: '21'

        springBootVersion:
          title: Spring Boot Version
          type: string
          enum:
            - '3.2.0'
            - '3.1.5'
          default: '3.2.0'

        database:
          title: Database
          type: string
          enum:
            - none
            - postgresql
            - mysql
            - mongodb
          default: postgresql
          enumNames:
            - 'No Database'
            - 'PostgreSQL'
            - 'MySQL'
            - 'MongoDB'

        cache:
          title: Caching
          type: boolean
          default: true
          description: Enable Redis caching

        messaging:
          title: Messaging
          type: string
          enum:
            - none
            - kafka
            - rabbitmq
          default: kafka
          enumNames:
            - 'No Messaging'
            - 'Apache Kafka'
            - 'RabbitMQ'

        observability:
          title: Observability Stack
          type: array
          items:
            type: string
            enum:
              - prometheus
              - grafana
              - jaeger
              - loki
          uniqueItems: true
          default:
            - prometheus
            - grafana
            - jaeger

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
              - gitlab.company.com
            allowedOwners:
              - company

        visibility:
          title: Repository Visibility
          type: string
          enum:
            - public
            - internal
            - private
          default: internal

    - title: Deployment Configuration
      properties:
        namespace:
          title: Kubernetes Namespace
          type: string
          default: default
          pattern: '^[a-z0-9-]+$'

        replicas:
          title: Initial Replicas
          type: number
          default: 3
          minimum: 1
          maximum: 10

        enableHPA:
          title: Enable Horizontal Pod Autoscaling
          type: boolean
          default: true

        enableIstio:
          title: Enable Istio Service Mesh
          type: boolean
          default: true

        environments:
          title: Deployment Environments
          type: array
          items:
            type: string
            enum:
              - dev
              - staging
              - production
          uniqueItems: true
          default:
            - dev
            - staging
            - production

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
          system: ${{ parameters.system }}
          javaVersion: ${{ parameters.javaVersion }}
          springBootVersion: ${{ parameters.springBootVersion }}
          database: ${{ parameters.database }}
          cache: ${{ parameters.cache }}
          messaging: ${{ parameters.messaging }}
          observability: ${{ parameters.observability }}
          namespace: ${{ parameters.namespace }}
          replicas: ${{ parameters.replicas }}
          enableHPA: ${{ parameters.enableHPA }}
          enableIstio: ${{ parameters.enableIstio }}

    - id: create-repo
      name: Create Repository
      action: publish:github
      input:
        allowedHosts:
          - github.com
        description: ${{ parameters.description }}
        repoUrl: ${{ parameters.repoUrl }}
        repoVisibility: ${{ parameters.visibility }}
        defaultBranch: main
        protectDefaultBranch: true
        requiredStatusChecks:
          - build
          - test
          - security-scan
        requireCodeOwnerReviews: true
        dismissStaleReviews: true
        requiredApprovingReviewCount: 2

    - id: create-pull-request
      name: Create Initial PR
      action: publish:github:pull-request
      input:
        repoUrl: ${{ parameters.repoUrl }}
        branchName: scaffolder-initial-commit
        title: 'Initial commit from Backstage template'
        description: |
          This PR contains the initial scaffolded code for ${{ parameters.name }}.

          Generated with the following configuration:
          - Java Version: ${{ parameters.javaVersion }}
          - Spring Boot Version: ${{ parameters.springBootVersion }}
          - Database: ${{ parameters.database }}
          - Cache: ${{ parameters.cache }}
          - Messaging: ${{ parameters.messaging }}

          Please review and merge to complete the setup.

    - id: register-catalog
      name: Register in Catalog
      action: catalog:register
      input:
        repoContentsUrl: ${{ steps.create-repo.output.repoContentsUrl }}
        catalogInfoPath: '/catalog-info.yaml'

    - id: create-kubernetes-namespace
      name: Create Kubernetes Namespace
      action: kubernetes:create-namespace
      input:
        namespace: ${{ parameters.namespace }}
        labels:
          app.kubernetes.io/managed-by: backstage
          app.kubernetes.io/name: ${{ parameters.name }}
          team: ${{ parameters.owner }}

    - id: setup-argocd-application
      name: Setup ArgoCD Application
      action: argocd:create-application
      input:
        name: ${{ parameters.name }}
        namespace: argocd
        project: default
        source:
          repoURL: ${{ steps.create-repo.output.remoteUrl }}
          path: kubernetes
          targetRevision: main
        destination:
          server: https://kubernetes.default.svc
          namespace: ${{ parameters.namespace }}
        syncPolicy:
          automated:
            prune: true
            selfHeal: true
          syncOptions:
            - CreateNamespace=true

    - id: create-grafana-dashboard
      name: Create Grafana Dashboard
      action: grafana:create-dashboard
      input:
        title: ${{ parameters.name }} Service Dashboard
        tags:
          - backstage
          - ${{ parameters.name }}
        folder: Services

    - id: setup-pagerduty
      name: Setup PagerDuty Integration
      action: pagerduty:create-service
      input:
        name: ${{ parameters.name }}
        description: ${{ parameters.description }}
        escalationPolicyId: ${{ parameters.owner }}-policy
        alertCreation: create_alerts_and_incidents

    - id: create-jira-project
      name: Create Jira Project
      action: jira:create-project
      input:
        key: ${{ parameters.name | upper | replace('-', '') }}
        name: ${{ parameters.name }}
        projectTypeKey: software
        projectTemplateKey: com.pyxis.greenhopper.jira:gh-simplified-agility-kanban
        lead: ${{ parameters.owner }}

  output:
    links:
      - title: Repository
        url: ${{ steps.create-repo.output.remoteUrl }}
      - title: Pull Request
        url: ${{ steps.create-pull-request.output.pullRequestUrl }}
      - title: Catalog Entry
        icon: catalog
        entityRef: ${{ steps.register-catalog.output.entityRef }}
      - title: ArgoCD Application
        url: https://argocd.company.com/applications/${{ parameters.name }}
      - title: Grafana Dashboard
        url: ${{ steps.create-grafana-dashboard.output.dashboardUrl }}
      - title: PagerDuty Service
        url: ${{ steps.setup-pagerduty.output.serviceUrl }}
      - title: Jira Project
        url: ${{ steps.create-jira-project.output.projectUrl }}
```

### Custom Scaffolder Actions

```typescript
// packages/backend/src/plugins/scaffolder/actions/kubernetes.ts
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { KubeConfig, CoreV1Api } from '@kubernetes/client-node';

export const createKubernetesNamespaceAction = () => {
  return createTemplateAction<{
    namespace: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  }>({
    id: 'kubernetes:create-namespace',
    description: 'Creates a Kubernetes namespace',
    schema: {
      input: {
        required: ['namespace'],
        type: 'object',
        properties: {
          namespace: {
            type: 'string',
            title: 'Namespace',
            description: 'Name of the namespace to create',
          },
          labels: {
            type: 'object',
            title: 'Labels',
            description: 'Labels to apply to the namespace',
          },
          annotations: {
            type: 'object',
            title: 'Annotations',
            description: 'Annotations to apply to the namespace',
          },
        },
      },
      output: {
        type: 'object',
        properties: {
          namespace: {
            type: 'string',
            title: 'Created namespace name',
          },
        },
      },
    },
    async handler(ctx) {
      const { namespace, labels, annotations } = ctx.input;

      const kc = new KubeConfig();
      kc.loadFromDefault();
      const k8sApi = kc.makeApiClient(CoreV1Api);

      try {
        // Check if namespace already exists
        try {
          await k8sApi.readNamespace(namespace);
          ctx.logger.info(`Namespace ${namespace} already exists`);
          ctx.output('namespace', namespace);
          return;
        } catch (e: any) {
          if (e.statusCode !== 404) {
            throw e;
          }
        }

        // Create namespace
        await k8sApi.createNamespace({
          metadata: {
            name: namespace,
            labels: {
              'app.kubernetes.io/managed-by': 'backstage',
              ...labels,
            },
            annotations: {
              'backstage.io/created-at': new Date().toISOString(),
              ...annotations,
            },
          },
        });

        ctx.logger.info(`Created namespace ${namespace}`);
        ctx.output('namespace', namespace);

        // Create default network policies
        await createDefaultNetworkPolicies(k8sApi, namespace);

        // Create resource quotas
        await createResourceQuotas(k8sApi, namespace);

        // Create limit ranges
        await createLimitRanges(k8sApi, namespace);

      } catch (error: any) {
        ctx.logger.error(`Failed to create namespace: ${error.message}`);
        throw new Error(`Failed to create namespace: ${error.message}`);
      }
    },
  });
};

async function createDefaultNetworkPolicies(
  k8sApi: CoreV1Api,
  namespace: string,
): Promise<void> {
  // Implementation for creating default network policies
}

async function createResourceQuotas(
  k8sApi: CoreV1Api,
  namespace: string,
): Promise<void> {
  // Implementation for creating resource quotas
}

async function createLimitRanges(
  k8sApi: CoreV1Api,
  namespace: string,
): Promise<void> {
  // Implementation for creating limit ranges
}
```

## Plugin Development

### Custom Plugin: Cost Insights

```typescript
// plugins/cost-insights/src/plugin.ts
import {
  createPlugin,
  createRoutableExtension,
} from '@backstage/core-plugin-api';
import { rootRouteRef } from './routes';

export const costInsightsPlugin = createPlugin({
  id: 'cost-insights',
  routes: {
    root: rootRouteRef,
  },
});

export const CostInsightsPage = costInsightsPlugin.provide(
  createRoutableExtension({
    name: 'CostInsightsPage',
    component: () =>
      import('./components/CostInsightsPage').then(m => m.CostInsightsPage),
    mountPoint: rootRouteRef,
  }),
);

// plugins/cost-insights/src/components/CostInsightsPage.tsx
import React from 'react';
import { InfoCard, Header, Page, Content } from '@backstage/core-components';
import { useApi, configApiRef } from '@backstage/core-plugin-api';
import { Grid, Typography } from '@material-ui/core';
import { useEntity } from '@backstage/plugin-catalog-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  BarChart,
  Bar,
} from 'recharts';

export const CostInsightsPage = () => {
  const { entity } = useEntity();
  const config = useApi(configApiRef);
  const [costData, setCostData] = React.useState([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    fetchCostData();
  }, [entity]);

  const fetchCostData = async () => {
    try {
      const response = await fetch(
        `${config.getString('backend.baseUrl')}/api/cost-insights/${entity.metadata.name}`,
      );
      const data = await response.json();
      setCostData(data);
    } catch (error) {
      console.error('Failed to fetch cost data:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Page themeId="tool">
      <Header title="Cost Insights" subtitle={entity.metadata.name} />
      <Content>
        <Grid container spacing={3}>
          <Grid item xs={12} md={6}>
            <InfoCard title="Monthly Cost Trend">
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={costData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="month" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="compute" stroke="#8884d8" />
                  <Line type="monotone" dataKey="storage" stroke="#82ca9d" />
                  <Line type="monotone" dataKey="network" stroke="#ffc658" />
                </LineChart>
              </ResponsiveContainer>
            </InfoCard>
          </Grid>

          <Grid item xs={12} md={6}>
            <InfoCard title="Cost by Resource Type">
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={costData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="resourceType" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="cost" fill="#8884d8" />
                </BarChart>
              </ResponsiveContainer>
            </InfoCard>
          </Grid>

          <Grid item xs={12}>
            <InfoCard title="Cost Optimization Recommendations">
              <Typography variant="body1">
                {/* Recommendations based on cost analysis */}
              </Typography>
            </InfoCard>
          </Grid>
        </Grid>
      </Content>
    </Page>
  );
};
```

## Production Deployment

### Docker Configuration

```dockerfile
# Dockerfile
FROM node:18-bullseye-slim AS packages

WORKDIR /app
COPY package.json yarn.lock ./
COPY packages packages
RUN yarn install --frozen-lockfile --production --network-timeout 600000

FROM node:18-bullseye-slim AS build

WORKDIR /app
COPY --from=packages /app/node_modules ./node_modules
COPY . .

RUN yarn tsc
RUN yarn build:backend --config ../../app-config.yaml

FROM node:18-bullseye-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    python3 \
    g++ \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -r -u 1001 -g root backstage
WORKDIR /app

COPY --from=build --chown=backstage:root /app/yarn.lock /app/package.json ./
COPY --from=build --chown=backstage:root /app/node_modules ./node_modules
COPY --from=build --chown=backstage:root /app/packages ./packages
COPY --from=build --chown=backstage:root /app/plugins ./plugins

ENV NODE_ENV production

USER backstage
EXPOSE 7007

CMD ["node", "packages/backend", "--config", "app-config.yaml"]
```

### Kubernetes Deployment

```yaml
# kubernetes/backstage-deployment.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: backstage
  labels:
    name: backstage
    app.kubernetes.io/managed-by: kubectl

---
apiVersion: v1
kind: Secret
metadata:
  name: backstage-secrets
  namespace: backstage
type: Opaque
stringData:
  POSTGRES_PASSWORD: "${POSTGRES_PASSWORD}"
  GITHUB_TOKEN: "${GITHUB_TOKEN}"
  AUTH_OKTA_CLIENT_SECRET: "${AUTH_OKTA_CLIENT_SECRET}"

---
apiVersion: v1
kind: ConfigMap
metadata:
  name: backstage-config
  namespace: backstage
data:
  app-config.production.yaml: |
    app:
      baseUrl: https://backstage.company.com
    backend:
      baseUrl: https://backstage.company.com
      database:
        client: pg
        connection:
          host: postgres-service
          port: 5432
          user: backstage
          database: backstage_catalog

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backstage
  namespace: backstage
  labels:
    app: backstage
spec:
  replicas: 3
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
      containers:
        - name: backstage
          image: company/backstage:latest
          imagePullPolicy: Always
          ports:
            - name: http
              containerPort: 7007
          envFrom:
            - secretRef:
                name: backstage-secrets
          volumeMounts:
            - name: config
              mountPath: /app/app-config.production.yaml
              subPath: app-config.production.yaml
          livenessProbe:
            httpGet:
              path: /healthcheck
              port: 7007
            initialDelaySeconds: 60
            periodSeconds: 10
            timeoutSeconds: 5
          readinessProbe:
            httpGet:
              path: /healthcheck
              port: 7007
            initialDelaySeconds: 30
            periodSeconds: 10
          resources:
            requests:
              memory: "512Mi"
              cpu: "250m"
            limits:
              memory: "2Gi"
              cpu: "1000m"
      volumes:
        - name: config
          configMap:
            name: backstage-config

---
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
  type: ClusterIP

---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: backstage
  namespace: backstage
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/proxy-body-size: "50m"
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - backstage.company.com
      secretName: backstage-tls
  rules:
    - host: backstage.company.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: backstage
                port:
                  number: 80

---
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
  minReplicas: 3
  maxReplicas: 10
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

---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: backstage
  namespace: backstage
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: backstage
```

## Monitoring and Observability

### Prometheus Metrics

```typescript
// packages/backend/src/plugins/metrics.ts
import { Request, Response, NextFunction } from 'express';
import promClient from 'prom-client';

const httpRequestDuration = new promClient.Histogram({
  name: 'backstage_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.1, 0.5, 1, 2, 5],
});

const catalogEntitiesTotal = new promClient.Gauge({
  name: 'backstage_catalog_entities_total',
  help: 'Total number of entities in catalog',
  labelNames: ['kind', 'type'],
});

const scaffolderTasksTotal = new promClient.Counter({
  name: 'backstage_scaffolder_tasks_total',
  help: 'Total number of scaffolder tasks',
  labelNames: ['template', 'status'],
});

export const metricsMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    httpRequestDuration
      .labels(req.method, req.route?.path || req.path, res.statusCode.toString())
      .observe(duration);
  });

  next();
};

export const metricsEndpoint = async (req: Request, res: Response) => {
  res.set('Content-Type', promClient.register.contentType);
  res.end(await promClient.register.metrics());
};
```

## Conclusion

Implementing Backstage as an Internal Developer Platform provides organizations with a unified interface for all development activities. Key benefits include:

- **Developer Productivity**: Self-service capabilities reduce wait times
- **Standardization**: Templates enforce best practices across teams
- **Discoverability**: Centralized catalog makes finding resources easy
- **Integration**: Single pane of glass for all development tools
- **Scalability**: Plugin architecture supports growing tool ecosystems

Success requires commitment to maintaining the catalog, developing useful templates, and continuous improvement based on developer feedback.