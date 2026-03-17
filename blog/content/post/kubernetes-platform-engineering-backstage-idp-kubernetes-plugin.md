---
title: "Kubernetes Platform Engineering: Backstage IDP with Kubernetes Plugin Integration"
date: 2029-12-15T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Backstage", "Platform Engineering", "IDP", "Internal Developer Platform", "Scaffolder", "Helm", "DevEx"]
categories:
- Kubernetes
- Platform Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide covering Backstage deployment on Kubernetes, catalog entities, software templates, the Kubernetes plugin for service visibility, and custom scaffolder actions for golden-path workflows."
more_link: "yes"
url: "/kubernetes-platform-engineering-backstage-idp-kubernetes-plugin/"
---

Internal Developer Platforms built on Backstage have become the cornerstone of platform engineering at scale. When deployed on Kubernetes and wired to your cluster infrastructure, Backstage transforms from a simple service catalog into a self-service portal where developers can discover services, view live Kubernetes workload status, and spin up new projects through opinionated templates — all without touching a kubeconfig file.

<!--more-->

## Why Backstage on Kubernetes

Backstage's plugin ecosystem is extensive, but the Kubernetes plugin stands apart because it closes the observability loop directly inside the developer portal. A developer opens their service's Backstage page and immediately sees pod health, recent deployments, HPA status, and rollout history — without needing `kubectl` access or a separate Grafana dashboard hunt. Combined with software templates that enforce golden paths, Backstage becomes the single pane of glass that platform teams have always promised but rarely delivered.

This guide covers deploying Backstage on Kubernetes via Helm, structuring catalog entities, building software templates, configuring the Kubernetes plugin with cluster permissions, and writing custom scaffolder actions in TypeScript.

## Deploying Backstage on Kubernetes

### Helm Chart Setup

The Backstage community Helm chart is the recommended deployment mechanism for production. Start with a values file that externalizes secrets through environment variables sourced from Kubernetes Secrets.

```yaml
# backstage-values.yaml
backstage:
  image:
    registry: ghcr.io
    repository: my-org/backstage
    tag: "1.24.0"
  extraEnvVarsSecrets:
    - backstage-secrets
  appConfig:
    app:
      title: "My Org Developer Portal"
      baseUrl: https://backstage.internal.example.com
    backend:
      baseUrl: https://backstage.internal.example.com
      cors:
        origin: https://backstage.internal.example.com
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
      providers:
        githubOrg:
          default:
            id: production
            githubUrl: https://github.com
            orgs:
              - my-org
    kubernetes:
      serviceLocatorMethod:
        type: multiTenant
      clusterLocatorMethods:
        - type: config
          clusters:
            - name: production-us-east-1
              url: https://k8s-api.us-east-1.internal.example.com
              authProvider: serviceAccount
              skipTLSVerify: false
              caData: ${K8S_PROD_US_EAST_1_CA_DATA}
              serviceAccountToken: ${K8S_PROD_US_EAST_1_SA_TOKEN}
            - name: staging
              url: https://k8s-api.staging.internal.example.com
              authProvider: serviceAccount
              skipTLSVerify: false
              caData: ${K8S_STAGING_CA_DATA}
              serviceAccountToken: ${K8S_STAGING_SA_TOKEN}

ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
  hosts:
    - host: backstage.internal.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: backstage-tls
      hosts:
        - backstage.internal.example.com

postgresql:
  enabled: false

serviceAccount:
  create: true
  name: backstage
```

Create the secret that holds all sensitive values:

```bash
kubectl create namespace backstage

kubectl create secret generic backstage-secrets \
  --namespace backstage \
  --from-literal=POSTGRES_HOST=postgres.backstage.svc.cluster.local \
  --from-literal=POSTGRES_PORT=5432 \
  --from-literal=POSTGRES_USER=backstage \
  --from-literal=POSTGRES_PASSWORD=<your-db-password> \
  --from-literal=AUTH_GITHUB_CLIENT_ID=<your-github-oauth-app-client-id> \
  --from-literal=AUTH_GITHUB_CLIENT_SECRET=<your-github-oauth-app-client-secret> \
  --from-literal=K8S_PROD_US_EAST_1_CA_DATA=<base64-encoded-ca-cert> \
  --from-literal=K8S_PROD_US_EAST_1_SA_TOKEN=<service-account-token> \
  --from-literal=K8S_STAGING_CA_DATA=<base64-encoded-ca-cert> \
  --from-literal=K8S_STAGING_SA_TOKEN=<service-account-token>
```

Install the chart:

```bash
helm repo add backstage https://backstage.github.io/charts
helm repo update

helm upgrade --install backstage backstage/backstage \
  --namespace backstage \
  --create-namespace \
  --values backstage-values.yaml \
  --wait \
  --timeout 10m
```

### Kubernetes RBAC for the Plugin

The Kubernetes plugin needs read access to workload resources. Create a ClusterRole and bind it to the Backstage service account in each cluster:

```yaml
# backstage-k8s-rbac.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: backstage-kubernetes-plugin
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
  - apiGroups: ["networking.k8s.io"]
    resources:
      - ingresses
    verbs: ["get", "list", "watch"]
  - apiGroups: ["batch"]
    resources:
      - jobs
      - cronjobs
    verbs: ["get", "list", "watch"]
  - apiGroups: ["metrics.k8s.io"]
    resources:
      - pods
      - nodes
    verbs: ["get", "list"]
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: backstage-k8s-reader
  namespace: backstage-system
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
    name: backstage-k8s-reader
    namespace: backstage-system
```

Extract the token for use in the Backstage secret:

```bash
kubectl apply -f backstage-k8s-rbac.yaml

# Kubernetes 1.24+ requires explicit token creation
kubectl create token backstage-k8s-reader \
  --namespace backstage-system \
  --duration 8760h \
  > backstage-k8s-token.txt
```

## Catalog Entities

### Component Entity with Kubernetes Annotations

The Kubernetes plugin resolves workloads to catalog components via labels and annotations. The critical annotation is `backstage.io/kubernetes-label-selector`, which tells the plugin which pods belong to this component.

```yaml
# catalog-info.yaml (checked into each service's repo)
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: payment-service
  description: "Core payment processing microservice"
  annotations:
    github.com/project-slug: my-org/payment-service
    backstage.io/kubernetes-label-selector: "app.kubernetes.io/name=payment-service"
    backstage.io/techdocs-ref: dir:.
    pagerduty.com/service-id: P1AB2CD
    argocd/app-name: payment-service-prod
  tags:
    - go
    - payments
    - pci-dss
  links:
    - url: https://grafana.internal.example.com/d/payment-service
      title: Grafana Dashboard
      icon: dashboard
    - url: https://runbook.internal.example.com/payment-service
      title: Runbook
      icon: docs
spec:
  type: service
  lifecycle: production
  owner: group:payments-team
  system: payment-platform
  dependsOn:
    - component:postgres-payments
    - component:redis-session-cache
  providesApis:
    - payment-service-api
```

### System and Domain Entities

Organize components into systems and domains for hierarchical navigation:

```yaml
# system-payment-platform.yaml
apiVersion: backstage.io/v1alpha1
kind: System
metadata:
  name: payment-platform
  description: "All components responsible for payment processing"
  annotations:
    backstage.io/techdocs-ref: dir:.
spec:
  owner: group:payments-team
  domain: financial-services
---
apiVersion: backstage.io/v1alpha1
kind: Domain
metadata:
  name: financial-services
  description: "Financial services domain including payments, billing, and invoicing"
spec:
  owner: group:platform-team
```

### API Entity

```yaml
# api-payment-service.yaml
apiVersion: backstage.io/v1alpha1
kind: API
metadata:
  name: payment-service-api
  description: "RESTful API for payment processing operations"
  tags:
    - rest
    - payments
spec:
  type: openapi
  lifecycle: production
  owner: group:payments-team
  system: payment-platform
  definition:
    $text: https://raw.githubusercontent.com/my-org/payment-service/main/openapi.yaml
```

## Software Templates

### Golden Path: New Go Microservice

Software templates use the Scaffolder to generate repositories from parameterized cookiecutter-style templates.

```yaml
# template-go-service.yaml
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: go-microservice
  title: "Go Microservice"
  description: "Create a new Go microservice with Kubernetes deployment, Helm chart, and CI/CD pipeline"
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
          description: "Unique service name (lowercase, hyphens only)"
          pattern: "^[a-z][a-z0-9-]*[a-z0-9]$"
          ui:autofocus: true
        description:
          title: Description
          type: string
          description: "Short description of what this service does"
        owner:
          title: Owner
          type: string
          description: "Team owning this service"
          ui:field: OwnerPicker
          ui:options:
            catalogFilter:
              kind: Group
        system:
          title: System
          type: string
          description: "System this service belongs to"
          ui:field: EntityPicker
          ui:options:
            catalogFilter:
              kind: System
    - title: Infrastructure Configuration
      properties:
        port:
          title: Service Port
          type: integer
          default: 8080
          description: "HTTP port the service listens on"
        enableDatabase:
          title: Enable PostgreSQL
          type: boolean
          default: false
        enableRedis:
          title: Enable Redis
          type: boolean
          default: false
        minReplicas:
          title: Minimum Replicas
          type: integer
          default: 2
          minimum: 1
          maximum: 10
        maxReplicas:
          title: Maximum Replicas
          type: integer
          default: 10
          minimum: 2
          maximum: 50
    - title: Repository Location
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
              - my-org

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
          port: ${{ parameters.port }}
          enableDatabase: ${{ parameters.enableDatabase }}
          enableRedis: ${{ parameters.enableRedis }}
          minReplicas: ${{ parameters.minReplicas }}
          maxReplicas: ${{ parameters.maxReplicas }}

    - id: publish
      name: Publish to GitHub
      action: publish:github
      input:
        allowedHosts: ["github.com"]
        description: ${{ parameters.description }}
        repoUrl: ${{ parameters.repoUrl }}
        repoVisibility: private
        defaultBranch: main
        topics:
          - go
          - microservice
          - kubernetes

    - id: register
      name: Register in Catalog
      action: catalog:register
      input:
        repoContentsUrl: ${{ steps.publish.output.repoContentsUrl }}
        catalogInfoPath: "/catalog-info.yaml"

    - id: create-argocd-app
      name: Create ArgoCD Application
      action: custom:argocd:create-application
      input:
        appName: ${{ parameters.name }}
        repoUrl: ${{ steps.publish.output.remoteUrl }}
        targetNamespace: ${{ parameters.name }}
        targetCluster: production-us-east-1

  output:
    links:
      - title: Repository
        url: ${{ steps.publish.output.remoteUrl }}
      - title: Open in Catalog
        icon: catalog
        entityRef: ${{ steps.register.output.entityRef }}
```

## Custom Scaffolder Actions

### ArgoCD Application Creation Action

Custom scaffolder actions extend the golden-path capabilities. Here is a TypeScript action that creates an ArgoCD Application resource:

```typescript
// packages/backend/src/plugins/scaffolder/actions/argocd.ts
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { z } from 'zod';
import * as k8s from '@kubernetes/client-node';

export const createArgoCDApplicationAction = () => {
  return createTemplateAction({
    id: 'custom:argocd:create-application',
    description: 'Creates an ArgoCD Application resource in the target cluster',
    schema: {
      input: z.object({
        appName: z.string().describe('Name of the ArgoCD application'),
        repoUrl: z.string().url().describe('Git repository URL'),
        targetRevision: z.string().default('HEAD').describe('Git branch/tag/commit'),
        targetNamespace: z.string().describe('Kubernetes namespace to deploy into'),
        targetCluster: z.string().default('in-cluster').describe('ArgoCD destination cluster name'),
        helmValuesFile: z.string().optional().describe('Path to Helm values file'),
        syncPolicy: z.enum(['manual', 'automated']).default('automated'),
      }),
      output: z.object({
        applicationName: z.string(),
        applicationUrl: z.string(),
      }),
    },
    async handler(ctx) {
      const {
        appName,
        repoUrl,
        targetRevision,
        targetNamespace,
        targetCluster,
        helmValuesFile,
        syncPolicy,
      } = ctx.input;

      ctx.logger.info(`Creating ArgoCD application: ${appName}`);

      const kc = new k8s.KubeConfig();
      kc.loadFromCluster();
      const customObjectsApi = kc.makeApiClient(k8s.CustomObjectsApi);
      const coreApi = kc.makeApiClient(k8s.CoreV1Api);

      // Ensure namespace exists
      try {
        await coreApi.readNamespace({ name: targetNamespace });
      } catch {
        await coreApi.createNamespace({
          body: {
            metadata: {
              name: targetNamespace,
              labels: {
                'backstage.io/managed': 'true',
                'app.kubernetes.io/managed-by': 'backstage-scaffolder',
              },
            },
          },
        });
        ctx.logger.info(`Created namespace: ${targetNamespace}`);
      }

      const application = {
        apiVersion: 'argoproj.io/v1alpha1',
        kind: 'Application',
        metadata: {
          name: appName,
          namespace: 'argocd',
          labels: {
            'backstage.io/managed': 'true',
          },
          finalizers: ['resources-finalizer.argocd.argoproj.io'],
        },
        spec: {
          project: 'default',
          source: {
            repoURL: repoUrl,
            targetRevision: targetRevision,
            path: 'helm',
            helm: {
              valueFiles: helmValuesFile ? [helmValuesFile] : ['values.yaml'],
            },
          },
          destination: {
            server: targetCluster === 'in-cluster'
              ? 'https://kubernetes.default.svc'
              : `https://${targetCluster}.internal.example.com`,
            namespace: targetNamespace,
          },
          syncPolicy: syncPolicy === 'automated' ? {
            automated: {
              prune: true,
              selfHeal: true,
            },
            syncOptions: [
              'CreateNamespace=true',
              'PrunePropagationPolicy=foreground',
            ],
            retry: {
              limit: 5,
              backoff: {
                duration: '5s',
                factor: 2,
                maxDuration: '3m',
              },
            },
          } : {},
        },
      };

      await customObjectsApi.createNamespacedCustomObject({
        group: 'argoproj.io',
        version: 'v1alpha1',
        namespace: 'argocd',
        plural: 'applications',
        body: application,
      });

      const applicationUrl = `https://argocd.internal.example.com/applications/argocd/${appName}`;

      ctx.output('applicationName', appName);
      ctx.output('applicationUrl', applicationUrl);

      ctx.logger.info(`ArgoCD application created: ${applicationUrl}`);
    },
  });
};
```

Register the action in the scaffolder backend plugin:

```typescript
// packages/backend/src/plugins/scaffolder.ts
import { createBuiltinActions, createRouter } from '@backstage/plugin-scaffolder-backend';
import { createArgoCDApplicationAction } from './scaffolder/actions/argocd';
import { Router } from 'express';
import type { PluginEnvironment } from '../types';

export default async function createPlugin(
  env: PluginEnvironment,
): Promise<Router> {
  const builtinActions = createBuiltinActions({
    integrations: env.integrations,
    catalogClient: env.catalogClient,
    reader: env.reader,
    config: env.config,
  });

  const actions = [
    ...builtinActions,
    createArgoCDApplicationAction(),
  ];

  return await createRouter({
    actions,
    logger: env.logger,
    config: env.config,
    database: env.database,
    reader: env.reader,
    catalogClient: env.catalogClient,
    identity: env.identity,
    scheduler: env.scheduler,
  });
}
```

## Kubernetes Plugin: Service-Level Visibility

### Associating Pods with Catalog Entities

The plugin uses label selectors defined in the `catalog-info.yaml` to associate pods with components. Ensure your Helm chart templates include the required label:

```yaml
# helm/templates/deployment.yaml (snippet)
metadata:
  labels:
    app.kubernetes.io/name: {{ .Release.Name }}
    app.kubernetes.io/version: {{ .Chart.AppVersion }}
    app.kubernetes.io/managed-by: {{ .Release.Service }}
    app.kubernetes.io/component: service
    backstage.io/kubernetes-id: {{ .Release.Name }}
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: {{ .Release.Name }}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: {{ .Release.Name }}
        app.kubernetes.io/version: {{ .Chart.AppVersion }}
        backstage.io/kubernetes-id: {{ .Release.Name }}
```

The annotation in `catalog-info.yaml` then reads:

```yaml
annotations:
  backstage.io/kubernetes-label-selector: "app.kubernetes.io/name=payment-service"
```

### Namespace-Scoped Plugin Configuration

For multi-tenant clusters where each team owns a namespace, configure the plugin to scope lookups per namespace:

```yaml
# app-config.yaml addition
kubernetes:
  serviceLocatorMethod:
    type: multiTenant
  clusterLocatorMethods:
    - type: config
      clusters:
        - name: production-us-east-1
          url: https://k8s-api.us-east-1.internal.example.com
          authProvider: serviceAccount
          skipTLSVerify: false
          caData: ${K8S_PROD_US_EAST_1_CA_DATA}
          serviceAccountToken: ${K8S_PROD_US_EAST_1_SA_TOKEN}
          skipMetricsLookup: false
          customResources:
            - group: argoproj.io
              apiVersion: v1alpha1
              plural: rollouts
```

## Catalog Auto-Discovery

### GitHub Discovery Provider

Rather than registering each `catalog-info.yaml` manually, the GitHub discovery provider scans repositories automatically:

```yaml
# app-config.yaml
catalog:
  providers:
    github:
      myOrg:
        organization: my-org
        catalogPath: /catalog-info.yaml
        filters:
          branch: main
          repository: ".*"
        schedule:
          frequency:
            minutes: 30
          timeout:
            minutes: 3
```

### Location Rules

Restrict which entity kinds are allowed from external sources to prevent catalog pollution:

```yaml
catalog:
  rules:
    - allow: [Component, API, Resource, System, Domain, Group, User]
  locations:
    - type: url
      target: https://github.com/my-org/platform-catalog/blob/main/all.yaml
      rules:
        - allow: [System, Domain, Group]
```

## TechDocs Integration

Enable in-portal documentation by adding TechDocs configuration and the `mkdocs.yml` file to each service repository:

```yaml
# app-config.yaml
techdocs:
  builder: external
  generator:
    runIn: docker
  publisher:
    type: googleGcs
    googleGcs:
      bucketName: my-org-techdocs
      credentials: ${GOOGLE_APPLICATION_CREDENTIALS_JSON}
```

Add to the component's `catalog-info.yaml`:

```yaml
annotations:
  backstage.io/techdocs-ref: dir:.
```

And add a minimal `mkdocs.yml` to the service repo root:

```yaml
site_name: Payment Service
site_description: Documentation for the Payment Service
nav:
  - Home: index.md
  - Architecture: architecture.md
  - Runbook: runbook.md
  - API Reference: api.md
plugins:
  - techdocs-core
```

## Monitoring Backstage Itself

Deploy Backstage with a ServiceMonitor so Prometheus scrapes its built-in metrics endpoint:

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
      path: /metrics
      interval: 30s
```

## Production Hardening

### PodDisruptionBudget and Affinity

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
      app.kubernetes.io/name: backstage
```

Add affinity rules in the values file to spread replicas across nodes:

```yaml
backstage:
  affinity:
    podAntiAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          podAffinityTerm:
            labelSelector:
              matchExpressions:
                - key: app.kubernetes.io/name
                  operator: In
                  values:
                    - backstage
            topologyKey: kubernetes.io/hostname
```

## Summary

Backstage on Kubernetes delivers a self-service internal developer platform that reduces cognitive load for every engineer in the organization. Key outcomes from this architecture include automatic service discovery via GitHub provider, live Kubernetes workload visibility through the plugin, golden-path templates that enforce standards at creation time, and custom scaffolder actions that wire together GitOps pipelines without manual intervention. The platform team controls the catalog rules, templates, and RBAC — developers get everything they need without ever touching a kubeconfig.
