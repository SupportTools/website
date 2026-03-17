---
title: "Backstage: Building a Production-Grade Internal Developer Portal"
date: 2027-12-18T00:00:00-05:00
draft: false
tags: ["Backstage", "Platform Engineering", "Developer Portal", "Kubernetes", "IDP", "TechDocs", "GitOps"]
categories:
- Platform Engineering
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A production engineering guide to deploying Spotify Backstage on Kubernetes with software catalog, TechDocs, scaffolder templates, plugin development, GitHub/GitLab integrations, Kubernetes plugin, and RBAC with OAuth2."
more_link: "yes"
url: "/backstage-platform-engineering-guide/"
---

Backstage transforms the fragmented experience of navigating dozens of internal tools into a single, unified developer portal. Teams locate services in the software catalog, generate new projects from scaffolder templates, read TechDocs without leaving the portal, and monitor Kubernetes deployments from a single pane of glass. This guide covers a production-ready Backstage deployment on Kubernetes, catalog architecture, TechDocs pipeline, scaffolder template design, key plugins, and OAuth2-backed RBAC.

<!--more-->

# Backstage: Building a Production-Grade Internal Developer Portal

## The Internal Developer Portal Problem

Enterprise engineering organizations accumulate tooling debt over years: Jenkins for CI, GitHub for source, PagerDuty for on-call, Datadog for observability, Terraform Cloud for IaC, Confluence for documentation. The result is a discovery problem. New engineers cannot find the service they are responsible for, let alone the runbook for it. Senior engineers spend time answering questions that are documented somewhere, but nowhere findable.

Backstage addresses this with three core primitives:

- **Software Catalog**: A registry of all software components (services, libraries, pipelines, websites) with ownership, dependency, and metadata.
- **TechDocs**: Documentation that lives alongside source code and renders inside the portal.
- **Scaffolder**: Template engine for creating new services, repositories, and infrastructure from approved patterns.

Plugins extend each of these surfaces with integrations to CI/CD systems, cloud providers, and observability platforms.

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│                  Backstage Pod                   │
│  ┌─────────────┐  ┌────────────┐  ┌──────────┐  │
│  │   Frontend  │  │  Backend   │  │ TechDocs │  │
│  │  (React SPA)│  │ (Node.js)  │  │  Builder │  │
│  └─────────────┘  └────────────┘  └──────────┘  │
│                        │                         │
│              ┌─────────┴──────────┐              │
│              │   PostgreSQL DB    │              │
│              └────────────────────┘              │
└─────────────────────────────────────────────────┘
         │              │               │
    GitHub API    Kubernetes API    S3/GCS
    (catalog)     (k8s plugin)    (techdocs)
```

## Prerequisites

```bash
# Node.js 20+ required for Backstage
node --version  # v20.x.x
yarn --version  # 4.x

# Create a new Backstage app
npx @backstage/create-app@latest --path ./backstage-platform
cd backstage-platform
```

## Kubernetes Deployment

### PostgreSQL Deployment

Backstage requires a PostgreSQL database for the catalog, scaffolder state, and search index:

```yaml
# postgres-statefulset.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: backstage-postgres
  namespace: backstage
spec:
  serviceName: backstage-postgres
  replicas: 1
  selector:
    matchLabels:
      app: backstage-postgres
  template:
    metadata:
      labels:
        app: backstage-postgres
    spec:
      securityContext:
        fsGroup: 999
        runAsUser: 999
      containers:
        - name: postgres
          image: postgres:16.3
          env:
            - name: POSTGRES_DB
              value: backstage
            - name: POSTGRES_USER
              valueFrom:
                secretKeyRef:
                  name: backstage-postgres-secret
                  key: username
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: backstage-postgres-secret
                  key: password
          ports:
            - containerPort: 5432
          resources:
            requests:
              memory: "512Mi"
              cpu: "250m"
            limits:
              memory: "2Gi"
              cpu: "1"
          volumeMounts:
            - name: postgres-data
              mountPath: /var/lib/postgresql/data
              subPath: pgdata
          livenessProbe:
            exec:
              command:
                - pg_isready
                - -U
                - backstage
            periodSeconds: 10
          readinessProbe:
            exec:
              command:
                - pg_isready
                - -U
                - backstage
            initialDelaySeconds: 5
            periodSeconds: 5
  volumeClaimTemplates:
    - metadata:
        name: postgres-data
      spec:
        accessModes:
          - ReadWriteOnce
        storageClassName: local-path
        resources:
          requests:
            storage: 20Gi
```

### Backstage Application Deployment

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
    spec:
      serviceAccountName: backstage
      containers:
        - name: backstage
          image: registry.internal.example.com/platform/backstage:1.28.0
          ports:
            - containerPort: 7007
              name: http
          env:
            - name: NODE_ENV
              value: production
            - name: APP_CONFIG_app_baseUrl
              value: https://backstage.internal.example.com
            - name: APP_CONFIG_backend_baseUrl
              value: https://backstage.internal.example.com
            - name: APP_CONFIG_backend_database_client
              value: pg
            - name: APP_CONFIG_backend_database_connection_host
              value: backstage-postgres.backstage.svc.cluster.local
            - name: APP_CONFIG_backend_database_connection_port
              value: "5432"
            - name: APP_CONFIG_backend_database_connection_database
              value: backstage
            - name: POSTGRES_USER
              valueFrom:
                secretKeyRef:
                  name: backstage-postgres-secret
                  key: username
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: backstage-postgres-secret
                  key: password
            - name: GITHUB_TOKEN
              valueFrom:
                secretKeyRef:
                  name: backstage-github-secret
                  key: token
            - name: AUTH_GITHUB_CLIENT_ID
              valueFrom:
                secretKeyRef:
                  name: backstage-oauth-secret
                  key: github-client-id
            - name: AUTH_GITHUB_CLIENT_SECRET
              valueFrom:
                secretKeyRef:
                  name: backstage-oauth-secret
                  key: github-client-secret
          resources:
            requests:
              memory: "1Gi"
              cpu: "500m"
            limits:
              memory: "4Gi"
              cpu: "2"
          volumeMounts:
            - name: app-config
              mountPath: /app/app-config.production.yaml
              subPath: app-config.production.yaml
          livenessProbe:
            httpGet:
              path: /healthcheck
              port: 7007
            initialDelaySeconds: 60
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /healthcheck
              port: 7007
            initialDelaySeconds: 30
            periodSeconds: 10
      volumes:
        - name: app-config
          configMap:
            name: backstage-app-config
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: backstage
  namespace: backstage
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: backstage-kubernetes-viewer
rules:
  - apiGroups: [""]
    resources: ["pods", "services", "configmaps", "namespaces", "nodes", "resourcequotas", "limitranges"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "replicasets", "statefulsets", "daemonsets"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["autoscaling"]
    resources: ["horizontalpodautoscalers"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["batch"]
    resources: ["jobs", "cronjobs"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["ingresses"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["metrics.k8s.io"]
    resources: ["pods", "nodes"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: backstage-kubernetes-viewer
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: backstage-kubernetes-viewer
subjects:
  - kind: ServiceAccount
    name: backstage
    namespace: backstage
```

## Application Configuration

```yaml
# backstage-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: backstage-app-config
  namespace: backstage
data:
  app-config.production.yaml: |
    app:
      title: "Platform Portal"
      baseUrl: https://backstage.internal.example.com

    organization:
      name: "Example Corp"

    backend:
      baseUrl: https://backstage.internal.example.com
      listen:
        port: 7007
      csp:
        connect-src: ["'self'", 'http:', 'https:']
      cors:
        origin: https://backstage.internal.example.com
        methods: [GET, HEAD, PATCH, POST, PUT, DELETE]
        credentials: true
      database:
        client: pg
        connection:
          host: ${POSTGRES_HOST}
          port: 5432
          user: ${POSTGRES_USER}
          password: ${POSTGRES_PASSWORD}
          database: backstage
          ssl:
            rejectUnauthorized: false
      cache:
        store: memory
      reading:
        allow:
          - host: '*.internal.example.com'
          - host: '*.github.com'

    auth:
      environment: production
      session:
        secret: ${SESSION_SECRET}
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

    proxy:
      endpoints:
        '/argocd/api':
          target: https://argocd.internal.example.com/api/v1/
          changeOrigin: true
          secure: true
          headers:
            Cookie: argocd.token=${ARGOCD_TOKEN}

    techdocs:
      builder: external
      generator:
        runIn: local
      publisher:
        type: awsS3
        awsS3:
          bucketName: platform-techdocs
          region: us-east-1
          accountId: "${AWS_ACCOUNT_ID}"

    catalog:
      import:
        entityFilename: catalog-info.yaml
        pullRequestBranchName: backstage-integration
      rules:
        - allow: [Component, System, API, Resource, Location, Group, User, Template, Domain]
      locations:
        - type: url
          target: https://github.com/example-org/backstage-catalog/blob/main/all.yaml
          rules:
            - allow: [Location, Component, System, API, Resource, Group, User]

    kubernetes:
      serviceLocatorMethod:
        type: multiTenant
      clusterLocatorMethods:
        - type: config
          clusters:
            - name: production
              url: https://kubernetes.default.svc
              authProvider: serviceAccount
              serviceAccountToken: ${K8S_SA_TOKEN}
              skipTLSVerify: false
            - name: staging
              url: https://k8s-staging.internal.example.com
              authProvider: serviceAccount
              serviceAccountToken: ${K8S_STAGING_SA_TOKEN}
              skipTLSVerify: false

    permission:
      enabled: true
```

## Software Catalog

### catalog-info.yaml Structure

Every service registers itself with a `catalog-info.yaml` at the repository root:

```yaml
# catalog-info.yaml (in service repository)
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: payment-service
  title: Payment Service
  description: Handles payment processing, refunds, and subscription management
  annotations:
    github.com/project-slug: example-org/payment-service
    backstage.io/techdocs-ref: dir:.
    backstage.io/kubernetes-id: payment-service
    backstage.io/kubernetes-namespace: payments
    prometheus.io/rule: payment_service
    pagerduty.com/service-id: "P1234AB"
    argocd/app-name: payment-service-production
  tags:
    - payments
    - critical
    - go
  links:
    - url: https://grafana.internal.example.com/d/payment-service
      title: Grafana Dashboard
      icon: dashboard
    - url: https://argocd.internal.example.com/applications/payment-service-production
      title: ArgoCD
      icon: web
spec:
  type: service
  lifecycle: production
  owner: group:payments-team
  system: payment-platform
  dependsOn:
    - component:postgres-payments
    - component:kafka-platform
    - resource:aws-s3-payment-receipts
  providesApis:
    - payment-api
---
apiVersion: backstage.io/v1alpha1
kind: API
metadata:
  name: payment-api
  title: Payment API
  description: REST API for payment operations
  annotations:
    github.com/project-slug: example-org/payment-service
spec:
  type: openapi
  lifecycle: production
  owner: group:payments-team
  system: payment-platform
  definition:
    $text: https://raw.githubusercontent.com/example-org/payment-service/main/openapi.yaml
```

### Aggregate Catalog Location

A central catalog repository references all service catalogs:

```yaml
# backstage-catalog/all.yaml
apiVersion: backstage.io/v1alpha1
kind: Location
metadata:
  name: platform-catalog-root
  description: Root catalog location for all services
spec:
  targets:
    # Team group definitions
    - ./groups/engineering.yaml
    - ./groups/platform.yaml
    - ./groups/data.yaml

    # System definitions
    - ./systems/payment-platform.yaml
    - ./systems/identity-platform.yaml
    - ./systems/data-platform.yaml

    # Service catalogs (auto-discovered from GitHub)
    - type: github-discovery
      target: https://github.com/example-org?path=/catalog-info.yaml

    # Domain definitions
    - ./domains/commerce.yaml
    - ./domains/infrastructure.yaml
```

## TechDocs Pipeline

TechDocs converts MkDocs-based documentation (committed alongside source code) to static HTML stored in S3 and served through Backstage.

### Repository Structure for TechDocs

```
payment-service/
├── catalog-info.yaml
├── docs/
│   ├── index.md
│   ├── architecture.md
│   ├── runbooks/
│   │   ├── incident-response.md
│   │   └── deployment.md
│   └── api-reference.md
└── mkdocs.yml
```

```yaml
# mkdocs.yml
site_name: Payment Service
site_description: Documentation for the Payment Service
repo_url: https://github.com/example-org/payment-service
docs_dir: docs

plugins:
  - techdocs-core

nav:
  - Home: index.md
  - Architecture: architecture.md
  - Runbooks:
    - Incident Response: runbooks/incident-response.md
    - Deployment: runbooks/deployment.md
  - API Reference: api-reference.md

markdown_extensions:
  - admonition
  - pymdownx.highlight
  - pymdownx.superfences
  - pymdownx.tabbed
```

### TechDocs Builder Job (CI Pipeline)

```yaml
# .github/workflows/techdocs.yaml
name: Publish TechDocs

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

      - name: Setup Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Install TechDocs CLI
        run: |
          pip install mkdocs-techdocs-core==1.3.3
          npm install -g @techdocs/cli@1.7.6

      - name: Generate TechDocs
        run: |
          techdocs-cli generate \
            --source-dir . \
            --output-dir ./site \
            --no-docker

      - name: Publish to S3
        env:
          AWS_REGION: us-east-1
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
        run: |
          techdocs-cli publish \
            --publisher-type awsS3 \
            --storage-name platform-techdocs \
            --entity default/component/payment-service \
            --directory ./site
```

## Scaffolder Templates

Scaffolder templates define approved patterns for creating new services. Templates live in a catalog repository and use Nunjucks for templating.

```yaml
# templates/go-service-template.yaml
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: go-service-template
  title: Go Microservice
  description: Creates a new Go microservice with CI/CD, Kubernetes manifests, and Backstage catalog registration
  tags:
    - go
    - microservice
    - kubernetes
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
          description: Unique identifier for the service (kebab-case)
          pattern: '^[a-z0-9-]+$'
          ui:autofocus: true
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
        system:
          title: System
          type: string
          description: System this service belongs to
          ui:field: EntityPicker
          ui:options:
            allowedKinds:
              - System

    - title: Infrastructure Options
      properties:
        database:
          title: Requires Database
          type: boolean
          default: false
        cache:
          title: Requires Redis Cache
          type: boolean
          default: false
        messageQueue:
          title: Requires Kafka
          type: boolean
          default: false
        environment:
          title: Target Environment
          type: string
          enum:
            - development
            - staging
            - production
          default: development

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
          database: ${{ parameters.database }}
          cache: ${{ parameters.cache }}

    - id: publish
      name: Publish to GitHub
      action: publish:github
      input:
        allowedHosts: ['github.com']
        description: ${{ parameters.description }}
        repoUrl: github.com?repo=${{ parameters.name }}&owner=example-org
        defaultBranch: main
        repoVisibility: private
        topics:
          - go
          - microservice
          - kubernetes
        gitCommitMessage: "chore: initial commit from Backstage scaffolder"
        collaborators:
          - team: ${{ parameters.owner | parseEntityRef | pick('name') }}
            access: push

    - id: register-catalog
      name: Register in Catalog
      action: catalog:register
      input:
        repoContentsUrl: ${{ steps['publish'].output.repoContentsUrl }}
        catalogInfoPath: '/catalog-info.yaml'

    - id: create-argocd-app
      name: Create ArgoCD Application
      action: argocd:create-resources
      input:
        appName: ${{ parameters.name }}-${{ parameters.environment }}
        argoInstance: production
        namespace: ${{ parameters.name }}
        repoUrl: ${{ steps['publish'].output.remoteUrl }}
        path: ./k8s/overlays/${{ parameters.environment }}

  output:
    links:
      - title: Repository
        url: ${{ steps['publish'].output.remoteUrl }}
      - title: Open in Catalog
        icon: catalog
        entityRef: ${{ steps['register-catalog'].output.entityRef }}
      - title: Open in ArgoCD
        url: https://argocd.internal.example.com/applications/${{ parameters.name }}-${{ parameters.environment }}
```

## Plugin Configuration

### GitHub Actions Plugin

```typescript
// packages/app/src/components/catalog/EntityPage.tsx (excerpt)
import {
  EntityGithubActionsContent,
  isGithubActionsAvailable,
} from '@backstage-community/plugin-github-actions';

const cicdContent = (
  <EntitySwitch>
    <EntitySwitch.Case if={isGithubActionsAvailable}>
      <EntityGithubActionsContent />
    </EntitySwitch.Case>
  </EntitySwitch>
);
```

### Kubernetes Plugin Entity Annotations

For the Kubernetes plugin to surface deployment information, services must annotate their catalog entry:

```yaml
annotations:
  backstage.io/kubernetes-id: payment-service
  backstage.io/kubernetes-namespace: payments
  backstage.io/kubernetes-label-selector: app=payment-service
```

### Cost Insights Plugin (via Kubecost)

```typescript
// packages/backend/src/plugins/cost-insights.ts
import { createRouter } from '@backstage-community/plugin-cost-insights-backend';
import { CostInsightsKubecostClient } from './clients/kubecost';

export async function createCostInsightsRouter(env: PluginEnvironment) {
  return await createRouter({
    logger: env.logger,
    config: env.config,
    client: new CostInsightsKubecostClient({
      baseUrl: 'http://kubecost.monitoring.svc.cluster.local:9090',
      window: '30d',
    }),
  });
}
```

### ArgoCD Plugin

```yaml
# app-config.production.yaml addition
argocd:
  username: backstage-readonly
  password: ${ARGOCD_PASSWORD}
  appLocatorMethods:
    - type: config
      instances:
        - name: production
          url: https://argocd.internal.example.com
          token: ${ARGOCD_TOKEN}
```

## RBAC with Permissions Framework

Backstage's Permission Framework restricts catalog and scaffolder access by team membership:

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
import {
  catalogEntityReadPermission,
  catalogEntityDeletePermission,
} from '@backstage/plugin-catalog-common/alpha';

class PlatformPermissionPolicy {
  async handle(
    request: PolicyQuery,
    user?: BackstageIdentityResponse,
  ): Promise<PolicyDecision> {
    const userGroups = user?.identity?.ownershipEntityRefs ?? [];

    // Platform team has full access
    if (userGroups.includes('group:default/platform-team')) {
      return { result: AuthorizeResult.ALLOW };
    }

    // Entity delete requires ownership
    if (isPermission(request.permission, catalogEntityDeletePermission)) {
      return createCatalogConditionalDecision(
        request.permission,
        catalogConditions.isEntityOwner({
          claims: userGroups,
        }),
      );
    }

    // Default: allow read, conditionally allow mutations
    if (isPermission(request.permission, catalogEntityReadPermission)) {
      return { result: AuthorizeResult.ALLOW };
    }

    return { result: AuthorizeResult.DENY };
  }
}

export async function createPermissionRouter(env: PluginEnvironment) {
  return await createRouter({
    config: env.config,
    logger: env.logger,
    discovery: env.discovery,
    identity: env.identity,
    policy: new PlatformPermissionPolicy(),
  });
}
```

## Custom Plugin Development

Building a plugin to surface on-call rotation data from PagerDuty:

```typescript
// plugins/pagerduty-oncall/src/plugin.ts
import { createPlugin, createRoutableExtension } from '@backstage/core-plugin-api';

export const pagerdutyOncallPlugin = createPlugin({
  id: 'pagerduty-oncall',
  routes: {
    root: rootRouteRef,
  },
});

export const PagerDutyOncallCard = pagerdutyOncallPlugin.provide(
  createRoutableExtension({
    name: 'PagerDutyOncallCard',
    component: () =>
      import('./components/OncallCard').then(m => m.OncallCard),
    mountPoint: rootRouteRef,
  }),
);
```

```typescript
// plugins/pagerduty-oncall/src/components/OncallCard.tsx
import React, { useEffect, useState } from 'react';
import { useApi, configApiRef } from '@backstage/core-plugin-api';
import { InfoCard, Progress } from '@backstage/core-components';
import { useEntity } from '@backstage/plugin-catalog-react';

export const OncallCard = () => {
  const { entity } = useEntity();
  const config = useApi(configApiRef);
  const [oncallData, setOncallData] = useState<OncallResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const serviceId = entity.metadata.annotations?.['pagerduty.com/service-id'];

  useEffect(() => {
    if (!serviceId) return;

    const fetchOncall = async () => {
      const baseUrl = config.getString('backend.baseUrl');
      const response = await fetch(
        `${baseUrl}/api/proxy/pagerduty/oncalls?service_ids[]=${serviceId}`,
      );
      const data = await response.json();
      setOncallData(data);
      setLoading(false);
    };

    fetchOncall();
  }, [serviceId, config]);

  if (!serviceId) {
    return (
      <InfoCard title="On-Call">
        <p>No PagerDuty service ID configured. Add annotation: pagerduty.com/service-id</p>
      </InfoCard>
    );
  }

  if (loading) return <Progress />;

  return (
    <InfoCard title="Current On-Call">
      {oncallData?.oncalls.map(oncall => (
        <div key={oncall.user.id}>
          <strong>{oncall.escalation_policy.name}</strong>
          <p>
            {oncall.user.name} ({oncall.user.email})
          </p>
          <p>Level {oncall.escalation_level}</p>
        </div>
      ))}
    </InfoCard>
  );
};
```

## Ingress and TLS

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: backstage
  namespace: backstage
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "120"
    cert-manager.io/cluster-issuer: internal-ca
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - backstage.internal.example.com
      secretName: backstage-tls
  rules:
    - host: backstage.internal.example.com
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

## Production Readiness Checklist

### Performance

- Enable Redis caching for catalog queries when catalog size exceeds 1000 entities
- Configure `backend.cache.store: redis` with a dedicated Redis instance
- Set replica count to 2+ with pod anti-affinity for availability
- Use Horizontal Pod Autoscaler targeting CPU at 70%

### Reliability

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
      app: backstage
```

### Catalog Health Monitoring

```bash
# Check catalog entity counts
kubectl exec -it backstage-pod -n backstage -- \
  curl -s http://localhost:7007/api/catalog/entities/by-query?limit=0 | \
  jq '.totalItems'

# Check catalog refresh errors
kubectl logs -n backstage deployment/backstage | grep '"level":"error"' | \
  jq '.message' | sort | uniq -c | sort -rn | head -20
```

## Summary

A production Backstage deployment on Kubernetes requires treating the portal itself as a first-class service with proper database management, RBAC configuration, and operational monitoring. The high-value components are:

1. Software Catalog with GitHub auto-discovery scanning repositories for `catalog-info.yaml`
2. TechDocs published to S3 by CI pipelines, eliminating the need to run a docs server
3. Scaffolder templates encoding approved architectural patterns for new service creation
4. Kubernetes plugin surfacing deployment health inline with service catalog entries
5. Permission Framework restricting destructive operations to entity owners
6. OAuth2 authentication via GitHub or internal OIDC provider
7. ArgoCD and PagerDuty plugins closing the loop between ownership, deployment, and on-call
