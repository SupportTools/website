---
title: "Backstage Internal Developer Platform on Kubernetes: Enterprise Implementation Guide"
date: 2026-12-19T00:00:00-05:00
draft: false
tags: ["Backstage", "Internal Developer Platform", "Platform Engineering", "Kubernetes", "Developer Experience", "IDP"]
categories:
- Platform Engineering
- Developer Experience
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to deploying and configuring Backstage IDP on Kubernetes: software catalog, tech radar, TechDocs, scaffolding templates, GitHub/GitLab integration, and plugin ecosystem."
more_link: "yes"
url: "/backstage-internal-developer-platform-kubernetes-enterprise-guide/"
---

**Backstage**, the open-source **Internal Developer Platform (IDP)** originally built at Spotify and donated to the CNCF, has become the de facto standard for organizations attempting to reduce engineering cognitive load at scale. By centralizing the software catalog, documentation, scaffolding templates, and operational tooling into a single, unified developer portal, Backstage addresses the core problem that grows with every new service added to an organization's footprint: discoverability, ownership, and the proliferation of inconsistent patterns.

When deployed on Kubernetes with proper integrations, Backstage transforms from a developer convenience into a platform engineering force multiplier — the single place where engineers find services, understand their dependencies, launch new projects from golden-path templates, and access the operational context they need to own what they build.

<!--more-->

## The IDP Value Proposition

### Reducing Cognitive Load

A typical enterprise engineering organization running hundreds of microservices suffers from invisible taxation: engineers spend hours per week answering questions about system ownership, hunting for runbooks, re-creating configuration patterns that exist elsewhere, and context-switching between a dozen disparate tools. This is **cognitive load** in its most expensive form.

Backstage's **software catalog** makes every service, API, resource, and system in the organization machine-readable and searchable. The catalog's entity model — Components, APIs, Systems, Domains — maps naturally to how engineering organizations think about their software portfolio.

### Golden Paths and Paved Roads

The **scaffolder** component enables platform teams to encode organizational best practices into templates that developers can invoke with a wizard interface. A new Go microservice template might automatically create the GitHub repository, configure CI/CD pipelines, add the service to the catalog, provision a Kubernetes namespace, create a Grafana dashboard, and register alerting rules — all in a single self-service workflow that a developer triggers without filing tickets.

### Discoverability at Scale

The combination of the catalog, **TechDocs** (documentation-as-code co-located with the service repository), and full-text search means that institutional knowledge previously locked inside individual engineers' heads becomes organizational capital.

## Architecture Overview

A production Backstage deployment on Kubernetes consists of:

- **Backstage application**: The Node.js frontend and backend, typically deployed as a single container built from the organization's custom Backstage app
- **PostgreSQL**: The persistence layer for catalog state, scaffolder history, and plugin data
- **Ingress**: TLS-terminated endpoint with SSO or OAuth2 authentication
- **Plugin ecosystem**: Kubernetes, GitHub Actions, Grafana, PagerDuty, and dozens of community plugins wired in at build time

## Kubernetes Deployment with Helm

The official `backstage/backstage` Helm chart provides a production-ready deployment scaffold.

```bash
helm repo add backstage https://backstage.github.io/charts
helm repo update
```

Create the namespace and required secrets before deploying:

```bash
kubectl create namespace backstage

# PostgreSQL credentials
kubectl create secret generic backstage-postgresql-secret \
  --from-literal=username=backstage \
  --from-literal=password="$(openssl rand -base64 32)" \
  -n backstage

# GitHub integration token
kubectl create secret generic backstage-github-token \
  --from-literal=GITHUB_TOKEN="ghp_xxxxxxxxxxxxxxxxxxxx" \
  -n backstage

# GitHub OAuth app credentials
kubectl create secret generic backstage-github-oauth \
  --from-literal=GITHUB_CLIENT_ID="Iv1.xxxxxxxxxxxx" \
  --from-literal=GITHUB_CLIENT_SECRET="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -n backstage
```

Helm values file for a production deployment:

```yaml
global:
  postgresql:
    auth:
      existingSecret: backstage-postgresql-secret

backstage:
  image:
    registry: ghcr.io
    repository: backstage/backstage
    tag: latest
  appConfig:
    app:
      title: "Enterprise Developer Portal"
      baseUrl: https://backstage.internal.example.com
    backend:
      baseUrl: https://backstage.internal.example.com
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
  extraEnvVars:
  - name: POSTGRES_HOST
    value: backstage-postgresql
  - name: POSTGRES_PORT
    value: "5432"
  - name: POSTGRES_USER
    valueFrom:
      secretKeyRef:
        name: backstage-postgresql-secret
        key: username
  - name: POSTGRES_PASSWORD
    valueFrom:
      secretKeyRef:
        name: backstage-postgresql-secret
        key: password
  - name: GITHUB_TOKEN
    valueFrom:
      secretKeyRef:
        name: backstage-github-token
        key: GITHUB_TOKEN
  - name: GITHUB_CLIENT_ID
    valueFrom:
      secretKeyRef:
        name: backstage-github-oauth
        key: GITHUB_CLIENT_ID
  - name: GITHUB_CLIENT_SECRET
    valueFrom:
      secretKeyRef:
        name: backstage-github-oauth
        key: GITHUB_CLIENT_SECRET

postgresql:
  enabled: true
  auth:
    username: backstage
    database: backstage
    existingSecret: backstage-postgresql-secret

ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/proxy-body-size: "50m"
  host: backstage.internal.example.com
  tls:
    enabled: true
    secretName: backstage-tls
```

Deploy with Helm:

```bash
helm upgrade --install backstage backstage/backstage \
  --namespace backstage \
  --values backstage-values.yaml \
  --version 1.9.2 \
  --wait \
  --timeout 10m
```

## GitHub and GitLab Integration

The `app-config.yaml` integration section connects Backstage to source control providers for catalog discovery and scaffolding.

Mount this as an additional ConfigMap that gets merged with the chart-managed config:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: backstage-app-config-integrations
  namespace: backstage
data:
  app-config.integrations.yaml: |
    integrations:
      github:
      - host: github.com
        token: ${GITHUB_TOKEN}
      gitlab:
      - host: gitlab.example.com
        token: ${GITLAB_TOKEN}
        baseUrl: https://gitlab.example.com

    auth:
      environment: production
      providers:
        github:
          production:
            clientId: ${GITHUB_CLIENT_ID}
            clientSecret: ${GITHUB_CLIENT_SECRET}

    catalog:
      providers:
        github:
          organization: my-enterprise-org
          schedule:
            frequency:
              minutes: 30
            timeout:
              minutes: 3
      rules:
      - allow:
        - Component
        - API
        - Resource
        - System
        - Domain
        - Location
        - Template
      locations:
      - type: url
        target: https://github.com/my-enterprise-org/catalog-info/blob/main/all.yaml
        rules:
        - allow:
          - Location
          - Component
          - API
          - System
```

## Software Catalog Entity Definitions

### Component Entity

Every deployable service or library registers itself via a `catalog-info.yaml` in its repository root:

```yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: payment-service
  title: Payment Service
  description: Core payment processing microservice handling card transactions and refunds
  tags:
  - go
  - payments
  - pci-dss
  annotations:
    github.com/project-slug: my-enterprise-org/payment-service
    backstage.io/techdocs-ref: dir:.
    backstage.io/kubernetes-label-selector: app=payment-service
    prometheus.io/rule: |
      - alert: PaymentServiceErrorRate
        expr: rate(http_requests_total{job="payment-service",status=~"5.."}[5m]) > 0.01
        labels:
          severity: critical
spec:
  type: service
  lifecycle: production
  owner: payments-team
  system: payments-platform
  providesApis:
  - payment-api
  dependsOn:
  - resource:default/payments-postgres
  - component:default/notification-service
```

### API Entity

Document API contracts in the catalog to enable discoverability and dependency tracking:

```yaml
apiVersion: backstage.io/v1alpha1
kind: API
metadata:
  name: payment-api
  title: Payment API
  description: RESTful API for payment processing operations
  tags:
  - rest
  - payments
spec:
  type: openapi
  lifecycle: production
  owner: payments-team
  system: payments-platform
  definition: |
    openapi: "3.0.0"
    info:
      title: Payment API
      version: "2.0.0"
    paths:
      /payments:
        post:
          summary: Create a payment
          requestBody:
            required: true
            content:
              application/json:
                schema:
                  type: object
                  properties:
                    amount:
                      type: number
                    currency:
                      type: string
          responses:
            "201":
              description: Payment created
```

### System Entity

Group related components into logical systems:

```yaml
apiVersion: backstage.io/v1alpha1
kind: System
metadata:
  name: payments-platform
  title: Payments Platform
  description: End-to-end payment processing, reconciliation, and reporting
  tags:
  - payments
  - core-platform
spec:
  owner: payments-team
  domain: financial-services
```

## Scaffolder Template for a Go Microservice

The scaffolder template encodes golden-path patterns for new service creation:

```yaml
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: go-service-template
  title: Go Microservice Template
  description: Creates a new Go microservice with standard enterprise tooling including CI/CD, monitoring, and Kubernetes manifests
  tags:
  - go
  - microservice
  - recommended
spec:
  owner: platform-team
  type: service
  parameters:
  - title: Service Details
    required:
    - name
    - description
    - owner
    properties:
      name:
        title: Name
        type: string
        description: Unique service name (lowercase, hyphens allowed)
        pattern: "^[a-z][a-z0-9-]{2,62}$"
      description:
        title: Description
        type: string
        description: Short description of the service purpose
      owner:
        title: Owner
        type: string
        description: Team owning this service
        ui:field: OwnerPicker
        ui:options:
          allowedKinds:
          - Group
  - title: Infrastructure
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
      namespace:
        title: Kubernetes Namespace
        type: string
        default: production
        enum:
        - production
        - staging
        - development
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
        namespace: ${{ parameters.namespace }}
  - id: publish
    name: Publish to GitHub
    action: publish:github
    input:
      allowedHosts:
      - github.com
      description: ${{ parameters.description }}
      repoUrl: ${{ parameters.repoUrl }}
      defaultBranch: main
      repoVisibility: private
  - id: register
    name: Register in Catalog
    action: catalog:register
    input:
      repoContentsUrl: ${{ steps.publish.output.repoContentsUrl }}
      catalogInfoPath: /catalog-info.yaml
  output:
    links:
    - title: Repository
      url: ${{ steps.publish.output.remoteUrl }}
    - title: Open in catalog
      icon: catalog
      entityRef: ${{ steps.register.output.entityRef }}
```

## TechDocs with S3 Backend

**TechDocs** renders MkDocs-based documentation co-located with the service repository. For production deployments, pre-generate and publish docs to S3 to avoid on-demand generation latency.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: backstage-app-config-techdocs
  namespace: backstage
data:
  app-config.techdocs.yaml: |
    techdocs:
      builder: external
      generator:
        runIn: local
      publisher:
        type: awsS3
        awsS3:
          bucketName: my-enterprise-techdocs
          region: us-east-1
          credentials:
            roleArn: arn:aws:iam::123456789012:role/backstage-techdocs-role
      cache:
        ttl: 3600000
```

CI/CD pipeline integration to publish docs on merge:

```bash
#!/usr/bin/env bash
# Publish TechDocs to S3 in CI pipeline
# Requires: npx @techdocs/cli, AWS credentials

ENTITY_NAMESPACE="${1:-default}"
ENTITY_KIND="${2:-component}"
ENTITY_NAME="${3:-my-service}"

npx @techdocs/cli generate \
  --source-dir . \
  --output-dir ./site

npx @techdocs/cli publish \
  --publisher-type awsS3 \
  --storage-name my-enterprise-techdocs \
  --entity "${ENTITY_NAMESPACE}/${ENTITY_KIND}/${ENTITY_NAME}"
```

## RBAC and Authentication

Backstage supports pluggable authentication backends. For enterprise deployments, integrate with an existing OIDC provider (Okta, Azure AD, Google Workspace):

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: backstage-app-config-auth
  namespace: backstage
data:
  app-config.auth.yaml: |
    auth:
      environment: production
      session:
        secret: ${AUTH_SESSION_SECRET}
      providers:
        oidc:
          production:
            metadataUrl: https://login.microsoftonline.com/tenant-id/v2.0/.well-known/openid-configuration
            clientId: ${AZURE_CLIENT_ID}
            clientSecret: ${AZURE_CLIENT_SECRET}
            prompt: auto
            scope: openid profile email

    permission:
      enabled: true

    signInPage: oidc
```

Role-based access within the Backstage catalog is enforced through the **Permissions framework**. A policy that grants developers read access to all entities and restricts delete operations to catalog-admin:

```typescript
// packages/backend/src/plugins/permission.ts
import { createBackendModule } from '@backstage/backend-plugin-api';
import {
  PolicyDecision,
  AuthorizeResult,
} from '@backstage/plugin-permission-common';

export const permissionModuleAllowAll = createBackendModule({
  pluginId: 'permission',
  moduleId: 'allow-all-policy',
  register(reg) {
    reg.registerInit({
      deps: { policy: policyExtensionPoint },
      async init({ policy }) {
        policy.setPolicy({
          async handle(request, user) {
            // Deny catalog entity delete unless user has catalog-admin role
            if (
              request.permission.name === 'catalog.entity.delete' &&
              !user?.info.ownershipEntityRefs?.includes('group:default/catalog-admin')
            ) {
              return { result: AuthorizeResult.DENY };
            }
            return { result: AuthorizeResult.ALLOW };
          },
        });
      },
    });
  },
});
```

## Measuring IDP Adoption

Platform engineering value is demonstrated through measurable adoption metrics. Configure the following data collection:

### Catalog Growth Metrics

```bash
#!/usr/bin/env bash
# Query Backstage catalog API for adoption metrics
BACKSTAGE_URL="${BACKSTAGE_URL:-https://backstage.internal.example.com}"
BACKSTAGE_TOKEN="${BACKSTAGE_TOKEN}"

# Count entities by kind
curl -s \
  -H "Authorization: Bearer ${BACKSTAGE_TOKEN}" \
  "${BACKSTAGE_URL}/api/catalog/entities?filter=kind=component" | \
  jq '.[] | .metadata.name' | wc -l

# Count services by lifecycle
for lifecycle in production experimental deprecated; do
  count=$(curl -s \
    -H "Authorization: Bearer ${BACKSTAGE_TOKEN}" \
    "${BACKSTAGE_URL}/api/catalog/entities?filter=kind=component,spec.lifecycle=${lifecycle}" | \
    jq 'length')
  echo "Lifecycle ${lifecycle}: ${count} components"
done
```

### Key Adoption KPIs

Track these metrics on a monthly basis to demonstrate platform value to leadership:

| KPI | Target | Measurement |
|-----|--------|-------------|
| Catalog coverage | > 90% of production services | (catalog entities / total known services) x 100 |
| New service time-to-catalog | < 1 day | Time from first commit to catalog registration |
| Scaffolder template usage | > 70% of new services | New services via template / total new services |
| TechDocs coverage | > 60% of components | Components with docs-ref / total components |
| Developer portal DAU | > 40% of engineering org | Unique daily active users / headcount |
| Support ticket deflection | > 30% reduction | Tickets tagged "could be self-served" before vs after |

### Grafana Dashboard Integration

Add the Backstage Kubernetes plugin to surface real-time deployment status alongside catalog metadata:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: backstage-app-config-kubernetes
  namespace: backstage
data:
  app-config.kubernetes.yaml: |
    kubernetes:
      serviceLocatorMethod:
        type: multiTenant
      clusterLocatorMethods:
      - type: config
        clusters:
        - name: production-cluster
          url: https://kubernetes.default.svc
          authProvider: serviceAccount
          serviceAccountToken: ${K8S_SERVICE_ACCOUNT_TOKEN}
          caData: ${K8S_CA_DATA}
          skipTLSVerify: false
        - name: staging-cluster
          url: https://staging-api.example.com
          authProvider: aws
          assumeRole: arn:aws:iam::123456789012:role/backstage-k8s-staging
```

## Operational Considerations

### Backstage Version Management

Backstage releases frequently. Establish a cadence for tracking the main changelog and bundling plugin upgrades:

```bash
#!/usr/bin/env bash
# Check for Backstage version upgrades
npx @backstage/create-app --version

# Run the automated upgrade script in a dev branch
npx @backstage/cli versions:bump --pattern '@backstage/*'

# Verify no breaking changes in app-config schema
npx @backstage/cli config:check --config app-config.production.yaml
```

### Resource Sizing

For an organization of 200-500 engineers with 300-500 catalog entities:

- **Backstage pod**: 2 vCPU request, 4 vCPU limit, 2 Gi memory request, 4 Gi limit
- **PostgreSQL**: 2 vCPU, 4 Gi RAM, 50 Gi storage
- **Startup time**: Allow 90 seconds for catalog sync on first load; liveness probe should have a generous `initialDelaySeconds` of 120

```yaml
resources:
  requests:
    cpu: "2"
    memory: 2Gi
  limits:
    cpu: "4"
    memory: 4Gi
livenessProbe:
  httpGet:
    path: /healthcheck
    port: 7007
  initialDelaySeconds: 120
  periodSeconds: 30
  failureThreshold: 5
readinessProbe:
  httpGet:
    path: /healthcheck
    port: 7007
  initialDelaySeconds: 60
  periodSeconds: 10
  failureThreshold: 3
```

A Backstage IDP deployment rewards the investment with compounding returns: every template adopted, every service cataloged, and every runbook published in TechDocs reduces the entropy cost of maintaining a large-scale distributed system. For platform engineering teams, it is the operational surface where the "you build it, you run it" philosophy meets the enabling infrastructure that makes that philosophy tractable.
