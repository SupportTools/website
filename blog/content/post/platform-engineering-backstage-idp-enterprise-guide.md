---
title: "Platform Engineering with Backstage: Building Internal Developer Portals at Scale"
date: 2028-09-11T00:00:00-05:00
draft: false
tags: ["Platform Engineering", "Backstage", "DevOps", "Developer Experience", "Kubernetes"]
categories:
- Platform Engineering
- Backstage
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to deploying and customizing Backstage IDP — plugins, software catalog, TechDocs, scaffolder templates, RBAC, Kubernetes integration, and measuring developer experience metrics."
more_link: "yes"
url: "/platform-engineering-backstage-idp-enterprise-guide/"
---

Platform engineering has emerged as the discipline that separates organizations shipping software at scale from those perpetually firefighting infrastructure complexity. At the heart of most successful platform engineering initiatives sits an Internal Developer Portal (IDP), and Backstage — originally built by Spotify and now a CNCF incubating project — has become the de facto standard. This guide walks through every layer of a production-grade Backstage deployment: from initial Helm installation through custom plugins, TechDocs, scaffolder templates that actually enforce golden paths, RBAC integration with your identity provider, deep Kubernetes integration, and the metrics framework you need to demonstrate value to engineering leadership.

<!--more-->

# Platform Engineering with Backstage: Building Internal Developer Portals at Scale

## Why Backstage and Why Now

The core promise of an IDP is reducing cognitive load. When a developer needs to create a new microservice, they should not be asking: Which Helm chart template do I copy? Which GitHub team owns the secret rotation policy? Where do I find the runbook for this service? An IDP answers all of these questions in one place and automates the toil that slows down shipping.

Backstage delivers three primary capabilities:

1. **Software Catalog** — a machine-readable inventory of every service, library, website, pipeline, and infrastructure resource in your organization
2. **Scaffolder** — a template engine that bootstraps new software according to your organization's golden paths
3. **TechDocs** — docs-as-code rendered inline alongside the services that own them

The plugin ecosystem extends these with Kubernetes pod views, cost data, security posture, incident history, and hundreds of third-party integrations.

## Prerequisites

- Kubernetes 1.27+ cluster (the examples use EKS but translate directly)
- Helm 3.12+
- PostgreSQL 14+ (Backstage requires a persistent database)
- GitHub or GitLab for catalog integration and OAuth
- Node.js 18 LTS on your workstation for local development

## Section 1: Installing Backstage with Helm

The community-maintained Helm chart is the fastest production path. We will deploy into a dedicated `backstage` namespace and connect to an external PostgreSQL RDS instance.

```bash
helm repo add backstage https://backstage.github.io/charts
helm repo update

kubectl create namespace backstage

# Create the PostgreSQL secret first
kubectl create secret generic backstage-postgres \
  --namespace backstage \
  --from-literal=POSTGRES_HOST=backstage.cluster-xyz.us-east-1.rds.amazonaws.com \
  --from-literal=POSTGRES_PORT=5432 \
  --from-literal=POSTGRES_USER=backstage \
  --from-literal=POSTGRES_PASSWORD=changeme-use-vault \
  --from-literal=POSTGRES_DB=backstage
```

```yaml
# values.yaml for backstage Helm chart
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
          database: ${POSTGRES_DB}
          ssl:
            require: true
            rejectUnauthorized: false

    auth:
      environment: production
      providers:
        github:
          production:
            clientId: ${GITHUB_CLIENT_ID}
            clientSecret: ${GITHUB_CLIENT_SECRET}

    integrations:
      github:
        - host: github.com
          token: ${GITHUB_TOKEN}

    catalog:
      rules:
        - allow:
            - Component
            - API
            - Resource
            - Location
            - System
            - Domain
            - Group
            - User
            - Template
      locations:
        - type: url
          target: https://github.com/acme-corp/catalog/blob/main/all-components.yaml

    techdocs:
      builder: external
      generator:
        runIn: docker
      publisher:
        type: awsS3
        awsS3:
          bucketName: acme-techdocs
          region: us-east-1
          accountId: "123456789012"

  extraEnvVarsSecrets:
    - backstage-postgres
    - backstage-secrets

  podAnnotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "7007"
    prometheus.io/path: "/metrics"

ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/proxy-body-size: "50m"
  host: backstage.acme.internal
  tls:
    - secretName: backstage-tls
      hosts:
        - backstage.acme.internal

serviceAccount:
  create: true
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/backstage-sa-role

postgresql:
  enabled: false  # Using external RDS

resources:
  requests:
    cpu: 500m
    memory: 1Gi
  limits:
    cpu: 2000m
    memory: 2Gi
```

```bash
helm upgrade --install backstage backstage/backstage \
  --namespace backstage \
  --values values.yaml \
  --wait \
  --timeout 10m
```

## Section 2: Software Catalog — Defining Your Services

The catalog is the foundation. Every entity in Backstage is defined by a YAML descriptor committed to a repository and registered via a Location entity or auto-discovery.

### Component Entity

```yaml
# catalog-info.yaml — committed at the root of every service repo
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: payments-api
  description: "Core payment processing API handling all transaction flows"
  annotations:
    github.com/project-slug: acme-corp/payments-api
    backstage.io/techdocs-ref: dir:.
    prometheus.io/rule: |
      sum(rate(http_requests_total{job="payments-api"}[5m])) by (status_code)
    pagerduty.com/service-id: PXXXXXX
    runatlantis.io/repo: acme-corp/payments-api
  tags:
    - golang
    - payments
    - critical
  links:
    - url: https://grafana.acme.internal/d/payments-api
      title: Grafana Dashboard
      icon: dashboard
    - url: https://acme.pagerduty.com/services/PXXXXXX
      title: PagerDuty Service
      icon: alert
spec:
  type: service
  lifecycle: production
  owner: group:payments-team
  system: payment-platform
  providesApis:
    - payments-api-v2
  consumesApis:
    - fraud-detection-api
    - notification-api
  dependsOn:
    - resource:payments-postgres
    - resource:payments-redis
```

### System and Domain Hierarchy

```yaml
# systems.yaml
apiVersion: backstage.io/v1alpha1
kind: System
metadata:
  name: payment-platform
  description: "End-to-end payment processing platform"
spec:
  owner: group:payments-team
  domain: financial-services

---
apiVersion: backstage.io/v1alpha1
kind: Domain
metadata:
  name: financial-services
  description: "All financial services and integrations"
spec:
  owner: group:platform-team
```

### Catalog Auto-Discovery

For large organizations with hundreds of repositories, manual registration is impractical. Configure GitHub auto-discovery:

```yaml
# In appConfig section of values.yaml
catalog:
  providers:
    github:
      acme-org:
        organization: acme-corp
        catalogPath: /catalog-info.yaml
        filters:
          branch: main
          repository: ".*"  # discover all repos
        schedule:
          frequency:
            minutes: 30
          timeout:
            minutes: 5
```

Install the GitHub org provider plugin in your custom Backstage app:

```bash
# In your Backstage app directory
yarn --cwd packages/backend add @backstage/plugin-catalog-backend-module-github
```

```typescript
// packages/backend/src/index.ts
import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

backend.add(import('@backstage/plugin-catalog-backend/alpha'));
backend.add(
  import('@backstage/plugin-catalog-backend-module-github/alpha'),
);

backend.start();
```

## Section 3: TechDocs — Docs as Code

TechDocs renders MkDocs-based documentation inline in Backstage. The "external" builder model means your CI pipeline generates the docs and publishes them to S3; Backstage only serves the pre-built output.

### MkDocs Configuration

```yaml
# mkdocs.yml — committed alongside catalog-info.yaml
site_name: Payments API
site_description: Documentation for the Payments API service
repo_url: https://github.com/acme-corp/payments-api
edit_uri: edit/main/docs/

nav:
  - Home: index.md
  - Architecture: architecture.md
  - API Reference: api-reference.md
  - Operations:
      - Deployment: operations/deployment.md
      - Monitoring: operations/monitoring.md
      - Runbooks: operations/runbooks.md
  - ADRs: adrs/

plugins:
  - techdocs-core

theme:
  name: material
```

### CI Pipeline for TechDocs Generation

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
        with:
          fetch-depth: 0

      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Install techdocs-cli
        run: npm install -g @techdocs/cli

      - name: Install MkDocs dependencies
        run: pip install mkdocs-techdocs-core==1.3.3

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/techdocs-publisher
          aws-region: us-east-1

      - name: Generate and publish docs
        run: |
          techdocs-cli generate --no-docker --source-dir . --output-dir ./site
          techdocs-cli publish \
            --publisher-type awsS3 \
            --storage-name acme-techdocs \
            --entity default/component/payments-api
```

## Section 4: Scaffolder Templates — Enforcing Golden Paths

The Scaffolder is where Backstage moves from informational to operational. A well-designed template encodes years of institutional knowledge about how to create a new service correctly.

```yaml
# templates/go-service-template.yaml
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: go-microservice
  title: Go Microservice
  description: "Creates a production-ready Go microservice with standard Acme tooling"
  tags:
    - golang
    - recommended
  annotations:
    backstage.io/techdocs-ref: dir:.
spec:
  owner: group:platform-team
  type: service

  parameters:
    - title: Service Details
      required:
        - name
        - description
        - owner
        - system
      properties:
        name:
          title: Service Name
          type: string
          description: "Unique name for this service (lowercase, hyphens only)"
          pattern: '^[a-z][a-z0-9-]{2,62}$'
          ui:autofocus: true
        description:
          title: Description
          type: string
          description: "What does this service do?"
        owner:
          title: Owner Team
          type: string
          description: "GitHub team that owns this service"
          ui:field: OwnerPicker
          ui:options:
            catalogFilter:
              - kind: Group
        system:
          title: System
          type: string
          description: "Which system does this belong to?"
          ui:field: EntityPicker
          ui:options:
            catalogFilter:
              - kind: System

    - title: Infrastructure
      required:
        - database
        - region
      properties:
        database:
          title: Requires Database
          type: boolean
          default: false
        region:
          title: AWS Region
          type: string
          default: us-east-1
          enum:
            - us-east-1
            - us-west-2
            - eu-west-1
        port:
          title: Service Port
          type: integer
          default: 8080

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
            allowedOrganizations:
              - acme-corp

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
          region: ${{ parameters.region }}
          port: ${{ parameters.port }}
          orgName: acme-corp
          repoName: ${{ parameters.repoUrl | parseRepoUrl | pick('repo') }}

    - id: create-github-repo
      name: Create GitHub Repository
      action: publish:github
      input:
        allowedHosts: ['github.com']
        description: ${{ parameters.description }}
        repoUrl: ${{ parameters.repoUrl }}
        defaultBranch: main
        repoVisibility: private
        deleteBranchOnMerge: true
        requiredApprovingReviewCount: 1
        topics:
          - golang
          - microservice
          - acme
        collaborators:
          - team: ${{ parameters.owner | parseEntityRef | pick('name') }}
            access: push

    - id: register-catalog
      name: Register in Catalog
      action: catalog:register
      input:
        repoContentsUrl: ${{ steps['create-github-repo'].output.repoContentsUrl }}
        catalogInfoPath: /catalog-info.yaml

    - id: create-jira-ticket
      name: Create Onboarding Ticket
      action: jira:create-issue
      input:
        projectKey: PLAT
        summary: "Onboard new service: ${{ parameters.name }}"
        description: |
          New Go microservice created via Backstage scaffolder.

          - Owner: ${{ parameters.owner }}
          - Repository: ${{ steps['create-github-repo'].output.remoteUrl }}
          - System: ${{ parameters.system }}

          Required onboarding steps:
          - [ ] Configure Vault secrets
          - [ ] Set up Datadog monitors
          - [ ] Add to PagerDuty escalation policy

  output:
    links:
      - title: Repository
        url: ${{ steps['create-github-repo'].output.remoteUrl }}
      - title: Open in catalog
        icon: catalog
        entityRef: ${{ steps['register-catalog'].output.entityRef }}
      - title: Jira Ticket
        url: ${{ steps['create-jira-ticket'].output.issueUrl }}
```

### Skeleton Directory Structure

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
│   ├── config/
│   │   └── config.go
│   └── server/
│       └── server.go
├── deploy/
│   └── helm/
│       └── ${{ values.name }}/
│           ├── Chart.yaml
│           └── values.yaml
├── .github/
│   └── workflows/
│       ├── ci.yaml
│       └── techdocs.yaml
├── Dockerfile
├── Makefile
└── go.mod
```

## Section 5: RBAC with GitHub Teams

Backstage supports fine-grained permissions via its permission framework. Integrate with GitHub Teams for group membership.

```typescript
// packages/backend/src/plugins/permission.ts
import { createRouter } from '@backstage/plugin-permission-backend';
import {
  AuthorizeResult,
  PolicyDecision,
} from '@backstage/plugin-permission-common';
import {
  PermissionPolicy,
  PolicyQuery,
} from '@backstage/plugin-permission-node';
import { catalogConditions, createCatalogConditionalDecision } from '@backstage/plugin-catalog-backend/alpha';

class AcmePermissionPolicy implements PermissionPolicy {
  async handle(
    request: PolicyQuery,
    user?: BackstageIdentityResponse,
  ): Promise<PolicyDecision> {
    // Platform team has full access
    if (user?.identity.ownershipEntityRefs.includes('group:default/platform-team')) {
      return { result: AuthorizeResult.ALLOW };
    }

    // Catalog read is allowed for all authenticated users
    if (isPermission(request.permission, catalogEntityReadPermission)) {
      return { result: AuthorizeResult.ALLOW };
    }

    // Template execution is restricted to owners
    if (isPermission(request.permission, scaffolderTaskReadPermission)) {
      return createCatalogConditionalDecision(
        request.permission,
        catalogConditions.isEntityOwner({
          claims: user?.identity.ownershipEntityRefs ?? [],
        }),
      );
    }

    // TechDocs read is public within the org
    if (isPermission(request.permission, techdocsEntityReadPermission)) {
      return { result: AuthorizeResult.ALLOW };
    }

    return { result: AuthorizeResult.DENY };
  }
}

export default async function createPlugin(
  env: PluginEnvironment,
): Promise<Router> {
  return await createRouter({
    config: env.config,
    logger: env.logger,
    discovery: env.discovery,
    policy: new AcmePermissionPolicy(),
    identity: env.identity,
  });
}
```

## Section 6: Kubernetes Plugin Integration

The Kubernetes plugin gives developers a real-time view of their service's pods, deployments, and recent events without needing kubectl access.

```yaml
# In appConfig
kubernetes:
  serviceLocatorMethod:
    type: multiTenant
  clusterLocatorMethods:
    - type: config
      clusters:
        - name: production-us-east-1
          url: https://k8s-prod.acme.internal
          authProvider: serviceAccount
          serviceAccountToken: ${K8S_PROD_SA_TOKEN}
          skipTLSVerify: false
          caData: ${K8S_PROD_CA_DATA}
        - name: production-eu-west-1
          url: https://k8s-prod-eu.acme.internal
          authProvider: serviceAccount
          serviceAccountToken: ${K8S_PROD_EU_SA_TOKEN}
          skipTLSVerify: false
          caData: ${K8S_PROD_EU_CA_DATA}
        - name: staging
          url: https://k8s-staging.acme.internal
          authProvider: serviceAccount
          serviceAccountToken: ${K8S_STAGING_SA_TOKEN}
          skipTLSVerify: false
          caData: ${K8S_STAGING_CA_DATA}
```

Create RBAC for Backstage's service account in each cluster:

```yaml
# k8s-backstage-rbac.yaml
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
    resources:
      - pods
      - services
      - endpoints
      - replicationcontrollers
      - namespaces
      - nodes
      - resourcequotas
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
subjects:
  - kind: ServiceAccount
    name: backstage
    namespace: backstage
roleRef:
  kind: ClusterRole
  name: backstage-kubernetes-viewer
  apiGroup: rbac.authorization.k8s.io
```

Link catalog entities to Kubernetes resources using annotations:

```yaml
# In catalog-info.yaml for the payments-api service
metadata:
  annotations:
    backstage.io/kubernetes-id: payments-api
    backstage.io/kubernetes-namespace: payments
    backstage.io/kubernetes-label-selector: app.kubernetes.io/name=payments-api
```

## Section 7: Custom Plugin Development

When the community plugins do not cover a specific internal tool, you build a custom plugin. Here is a minimal plugin that shows the on-call schedule from PagerDuty.

```typescript
// plugins/pagerduty-oncall/src/components/OncallCard/OncallCard.tsx
import React, { useEffect, useState } from 'react';
import { InfoCard, Progress } from '@backstage/core-components';
import { useApi, configApiRef } from '@backstage/core-plugin-api';
import { Grid, Typography, Avatar, Chip } from '@material-ui/core';

interface OncallUser {
  id: string;
  name: string;
  email: string;
  avatarUrl: string;
}

interface OncallCardProps {
  serviceId: string;
}

export const OncallCard = ({ serviceId }: OncallCardProps) => {
  const config = useApi(configApiRef);
  const [oncall, setOncall] = useState<OncallUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const backendUrl = config.getString('backend.baseUrl');
    fetch(`${backendUrl}/api/proxy/pagerduty/oncalls?serviceId=${serviceId}`)
      .then(r => r.json())
      .then(data => {
        setOncall(data.oncalls ?? []);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
  }, [serviceId, config]);

  if (loading) return <Progress />;
  if (error) return <Typography color="error">{error}</Typography>;

  return (
    <InfoCard title="On Call Now">
      <Grid container spacing={2}>
        {oncall.map(user => (
          <Grid item key={user.id} xs={12}>
            <Grid container alignItems="center" spacing={1}>
              <Grid item>
                <Avatar src={user.avatarUrl} alt={user.name} />
              </Grid>
              <Grid item>
                <Typography variant="body1">{user.name}</Typography>
                <Typography variant="caption" color="textSecondary">
                  {user.email}
                </Typography>
              </Grid>
              <Grid item>
                <Chip label="Primary" color="primary" size="small" />
              </Grid>
            </Grid>
          </Grid>
        ))}
      </Grid>
    </InfoCard>
  );
};
```

## Section 8: Measuring Developer Experience Metrics

Deploying Backstage without measuring adoption is leaving value on the table. Track these metrics using Backstage's built-in analytics and supplemental tooling.

### Key Metrics to Track

```typescript
// analytics.ts — custom analytics module
import { analyticsApiRef, useAnalytics } from '@backstage/core-plugin-api';

// Track scaffolder template usage
const analytics = useAnalytics();
analytics.captureEvent('scaffold', 'template_used', {
  attributes: {
    templateName: 'go-microservice',
    team: 'payments-team',
    duration_seconds: 47,
  },
});

// Track catalog search queries
analytics.captureEvent('search', 'query', {
  value: query.length,
  attributes: { term: query },
});
```

### Prometheus Metrics from Backstage

```yaml
# ServiceMonitor for Backstage metrics
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: backstage
  namespace: backstage
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: backstage
  endpoints:
    - port: backend
      path: /metrics
      interval: 30s
```

### DORA Metrics Dashboard

Create a Grafana dashboard that correlates Backstage usage with DORA metrics:

```json
{
  "title": "Platform Engineering DORA Metrics",
  "panels": [
    {
      "title": "Services Created via Scaffolder (30d)",
      "type": "stat",
      "targets": [
        {
          "expr": "increase(backstage_scaffolder_task_completed_total{status='COMPLETED'}[30d])"
        }
      ]
    },
    {
      "title": "Catalog Coverage",
      "description": "% of known services with catalog entries",
      "type": "gauge",
      "targets": [
        {
          "expr": "backstage_catalog_entities_total{kind='Component'} / scalar(github_repos_total) * 100"
        }
      ]
    },
    {
      "title": "TechDocs Page Views (7d)",
      "type": "timeseries",
      "targets": [
        {
          "expr": "sum(increase(backstage_techdocs_pageviews_total[7d])) by (entity)"
        }
      ]
    }
  ]
}
```

## Section 9: Production Hardening

### Database Connection Pooling

```yaml
# PgBouncer sidecar for Backstage
spec:
  containers:
    - name: pgbouncer
      image: pgbouncer/pgbouncer:1.22.0
      env:
        - name: DATABASES
          value: "backstage=host=$(POSTGRES_HOST) port=$(POSTGRES_PORT) dbname=$(POSTGRES_DB)"
        - name: POOL_MODE
          value: "transaction"
        - name: MAX_CLIENT_CONN
          value: "100"
        - name: DEFAULT_POOL_SIZE
          value: "20"
      ports:
        - containerPort: 5432
          name: pgbouncer
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

### Cache Layer with Redis

```yaml
# In appConfig for caching hot catalog queries
backend:
  cache:
    store: redis
    connection: redis://redis-master.backstage.svc.cluster.local:6379
    ttl: 3600000  # 1 hour in milliseconds
```

## Section 10: Upgrade and Maintenance

Backstage releases frequently. Establish a structured upgrade cadence:

```bash
#!/bin/bash
# upgrade-backstage.sh
set -euo pipefail

NEW_VERSION="${1:?Usage: upgrade-backstage.sh <version>}"
NAMESPACE="backstage"

echo "Upgrading Backstage to ${NEW_VERSION}"

# Update the image tag in values.yaml
sed -i "s/tag: .*/tag: \"${NEW_VERSION}\"/" values.yaml

# Run the upgrade
helm upgrade backstage backstage/backstage \
  --namespace "${NAMESPACE}" \
  --values values.yaml \
  --wait \
  --timeout 10m \
  --atomic  # Roll back automatically on failure

echo "Verifying deployment..."
kubectl rollout status deployment/backstage -n "${NAMESPACE}" --timeout=5m

# Smoke test the catalog API
BACKSTAGE_URL=$(kubectl get ingress backstage -n "${NAMESPACE}" \
  -o jsonpath='{.spec.rules[0].host}')

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  "https://${BACKSTAGE_URL}/api/catalog/entities?limit=1")

if [[ "${HTTP_STATUS}" != "200" ]]; then
  echo "ERROR: Catalog API returned ${HTTP_STATUS}. Rolling back."
  helm rollback backstage --namespace "${NAMESPACE}"
  exit 1
fi

echo "Backstage ${NEW_VERSION} deployed successfully."
```

## Conclusion

A well-deployed Backstage IDP is not a one-time project — it is an ongoing product that your platform team owns. The teams with the highest return on investment treat the catalog as a living document with automated ingestion, build scaffolder templates for every common service archetype, measure adoption rigorously, and iterate based on developer feedback. Start with catalog coverage and one high-value scaffolder template, measure the time saved, and use that data to justify expanding the platform team to build more capabilities.
