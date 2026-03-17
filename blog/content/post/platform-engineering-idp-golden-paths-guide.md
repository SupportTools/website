---
title: "Platform Engineering: Building Golden Paths for Developer Self-Service"
date: 2028-01-09T00:00:00-05:00
draft: false
tags: ["Platform Engineering", "Internal Developer Platform", "Backstage", "Crossplane", "GitOps", "Developer Experience", "Golden Paths"]
categories:
- Platform Engineering
- DevOps
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to platform engineering for enterprise teams covering Internal Developer Platform architecture, Backstage scaffolder templates, Crossplane compositions, Helm chart libraries, cognitive load reduction, platform team topologies, and success metrics."
more_link: "yes"
url: "/platform-engineering-idp-golden-paths-guide/"
---

Platform engineering is the discipline of designing and building toolchains and workflows that enable self-service for software engineering organizations. Rather than centralizing infrastructure operations in a gateway-model where developers file tickets and wait for operations teams, platform engineering creates internal products that developers use directly. The golden path concept defines the recommended, well-supported route through the platform for common tasks: creating a new service, deploying to production, setting up a database, or configuring alerting. This guide examines the architecture of an Internal Developer Platform (IDP), the tools required to build one, and the organizational patterns that make platform engineering investments pay off.

<!--more-->

# Platform Engineering: Building Golden Paths for Developer Self-Service

## Section 1: Platform Engineering Foundations

### The Problem with Traditional Ops Models

In organizations without a platform team, the path from "developer writes code" to "code runs in production" involves numerous handoffs:

1. Developer needs a new service → Opens a ticket with infrastructure team.
2. Infrastructure team provisions Kubernetes namespace, RBAC, network policies.
3. Developer needs a database → Second ticket, different team, 3-day SLA.
4. Developer needs CI/CD pipeline → Third ticket.
5. Developer needs monitoring and alerting → Fourth ticket.
6. Total time from idea to running service: 2-4 weeks.

Each handoff introduces cognitive context-switching, knowledge loss, and coordination overhead. The infrastructure teams become bottlenecks, developers become frustrated, and organizational velocity suffers.

### The Platform Engineering Alternative

A platform team builds an Internal Developer Platform—essentially a product whose customers are internal developers. The IDP provides:

- **Self-service provisioning**: Developers create services, databases, and pipelines without tickets.
- **Golden paths**: Opinionated but flexible templates for common use cases.
- **Paved roads**: Infrastructure abstractions that hide undifferentiated complexity.
- **Developer portal**: Single pane of glass for discovering, creating, and managing resources.

```
Developer Experience Layer
┌────────────────────────────────────────────────────────┐
│            Backstage (Developer Portal)                │
│  Software Catalog │ Templates │ Docs │ CI Status        │
└─────────────────────────────┬──────────────────────────┘
                              │
Self-Service Provisioning Layer
┌─────────────────────────────▼──────────────────────────┐
│  Crossplane Compositions │ Helm Libraries │ ArgoCD Apps │
└─────────────────────────────┬──────────────────────────┘
                              │
Infrastructure Layer
┌─────────────────────────────▼──────────────────────────┐
│  Kubernetes │ AWS/GCP/Azure │ Terraform (for non-k8s)  │
└────────────────────────────────────────────────────────┘
```

## Section 2: Internal Developer Platform Architecture

### Core IDP Components

An enterprise IDP typically consists of:

1. **Developer Portal** (Backstage): Software catalog, service creation templates, documentation hub.
2. **Resource Provisioner** (Crossplane): Self-service infrastructure via Kubernetes-native CRDs.
3. **Application Deployer** (ArgoCD/Flux): GitOps-based application deployment.
4. **Secret Manager** (External Secrets Operator): Automatic secret synchronization from KMS/Vault.
5. **Observability Stack** (Prometheus/Grafana/Loki): Pre-configured for new services automatically.
6. **CI System** (GitHub Actions/Tekton): Pipeline templates applied by scaffolding.
7. **Policy Engine** (OPA/Kyverno): Guardrails that enable self-service safely.

### Golden Path vs Paved Road

A **paved road** is a path the platform makes easy: using Helm, for instance, is a paved road because the platform provides charts, values templates, and deployment automation. But developers can still go off-road.

A **golden path** is a specific end-to-end journey for a common scenario: "create a new REST API service with PostgreSQL, deployed to three environments, with monitoring, logging, and alerting pre-configured." The golden path is opinionated (specific Helm chart structure, specific logging format, specific alert thresholds), but the opinions are based on what has worked well at scale.

The distinction matters for prioritization: golden paths require more investment to build (complete end-to-end templates and automation) but provide more value (developers hit the ground running). Paved roads are tactical improvements to existing workflows.

## Section 3: Backstage Installation and Configuration

### Installing Backstage

```bash
# Create Backstage app
npx @backstage/create-app@latest --skip-install
cd my-backstage

# Install dependencies
yarn install

# Configure database (production uses PostgreSQL)
cat > app-config.production.yaml <<'EOF'
backend:
  database:
    client: pg
    connection:
      host: ${POSTGRES_HOST}
      port: ${POSTGRES_PORT}
      user: ${POSTGRES_USER}
      password: ${POSTGRES_PASSWORD}
      database: backstage
      ssl:
        rejectUnauthorized: true
        ca: ${POSTGRES_CA_CERT}
EOF

# Build Docker image
yarn build
yarn build-image --tag registry.internal.example.com/backstage:latest
docker push registry.internal.example.com/backstage:latest
```

### Backstage Helm Deployment

```yaml
# backstage-values.yaml
backstage:
  image:
    registry: registry.internal.example.com
    repository: backstage
    tag: "1.25.0"

  appConfig:
    app:
      title: "ACME Platform Portal"
      baseUrl: https://portal.internal.example.com

    organization:
      name: "ACME Engineering"

    backend:
      baseUrl: https://portal.internal.example.com
      listen:
        port: 7007

    auth:
      providers:
        github:
          development:
            clientId: ${AUTH_GITHUB_CLIENT_ID}
            clientSecret: ${AUTH_GITHUB_CLIENT_SECRET}

    catalog:
      providers:
        github:
          myGithubOrg:
            organization: "acme-engineering"
            catalogPath: "/catalog-info.yaml"
            filters:
              branch: "main"
            schedule:
              frequency:
                minutes: 30
              timeout:
                minutes: 3

    kubernetes:
      serviceLocatorMethod:
        type: "multiTenant"
      clusterLocatorMethods:
      - type: "config"
        clusters:
        - url: https://kubernetes.default.svc
          name: prod-us-east
          authProvider: "serviceAccount"
          serviceAccountToken: ${K8S_SA_TOKEN}
          caData: ${K8S_CA_DATA}
          skipTLSVerify: false
        - url: https://gke-prod-central.example.com
          name: prod-gcp-central
          authProvider: "serviceAccount"
          serviceAccountToken: ${K8S_GCP_SA_TOKEN}
          caData: ${K8S_GCP_CA_DATA}

    techdocs:
      builder: "external"
      generator:
        runIn: "local"
      publisher:
        type: "awsS3"
        awsS3:
          bucketName: acme-techdocs
          region: us-east-1

  postgresql:
    enabled: false  # Use external PostgreSQL

ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
  hosts:
  - host: portal.internal.example.com
    paths:
    - path: /
      pathType: Prefix
  tls:
  - secretName: backstage-tls
    hosts:
    - portal.internal.example.com

serviceAccount:
  create: true
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/backstage-role
```

## Section 4: Backstage Scaffolder Templates

Scaffolder templates define the golden paths. When a developer creates a new service, they select a template, fill in parameters, and Backstage executes a series of actions: creating a git repository, initializing the project structure, adding CI/CD configuration, registering the service in the software catalog, and optionally provisioning infrastructure.

### New Service Template

```yaml
# backstage/templates/new-service/template.yaml
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: new-rest-api-service
  title: "New REST API Service"
  description: "Create a new Go REST API service with full production setup"
  tags:
  - go
  - rest-api
  - production-ready
spec:
  owner: platform-team
  type: service

  parameters:
  - title: Service Information
    required:
    - serviceName
    - serviceOwner
    - serviceDescription
    - team
    properties:
      serviceName:
        title: Service Name
        type: string
        pattern: "^[a-z][a-z0-9-]{2,30}$"
        description: "Lowercase, hyphen-separated (e.g., payment-processor)"
        ui:autofocus: true
      serviceOwner:
        title: Owner Group
        type: string
        ui:field: OwnerPicker
        ui:options:
          catalogFilter:
          - kind: Group
      serviceDescription:
        title: Description
        type: string
        description: "What does this service do?"
      team:
        title: Team
        type: string
        enum:
        - platform
        - payments
        - identity
        - catalog
        - checkout

  - title: Infrastructure Configuration
    required:
    - environment
    - requestCPU
    - requestMemory
    - enableDatabase
    properties:
      environment:
        title: Target Environment
        type: string
        enum:
        - development
        - staging
        - production
        default: development
      requestCPU:
        title: CPU Request
        type: string
        enum:
        - "100m"
        - "250m"
        - "500m"
        - "1000m"
        default: "250m"
      requestMemory:
        title: Memory Request
        type: string
        enum:
        - "128Mi"
        - "256Mi"
        - "512Mi"
        - "1Gi"
        default: "256Mi"
      enableDatabase:
        title: Provision PostgreSQL Database
        type: boolean
        default: false
      enableRedisCache:
        title: Provision Redis Cache
        type: boolean
        default: false

  - title: Repository Configuration
    required:
    - repoOrg
    properties:
      repoOrg:
        title: GitHub Organization
        type: string
        default: "acme-engineering"
      repoVisibility:
        title: Repository Visibility
        type: string
        enum:
        - private
        - internal
        default: private

  steps:
  # 1. Generate project files from template
  - id: generate-files
    name: Generate Service Files
    action: fetch:template
    input:
      url: ./skeleton
      values:
        serviceName: ${{ parameters.serviceName }}
        serviceOwner: ${{ parameters.serviceOwner }}
        description: ${{ parameters.serviceDescription }}
        team: ${{ parameters.team }}
        requestCPU: ${{ parameters.requestCPU }}
        requestMemory: ${{ parameters.requestMemory }}
        enableDatabase: ${{ parameters.enableDatabase }}
        enableRedisCache: ${{ parameters.enableRedisCache }}

  # 2. Create GitHub repository
  - id: create-repo
    name: Create GitHub Repository
    action: publish:github
    input:
      allowedHosts: ["github.com"]
      description: ${{ parameters.serviceDescription }}
      repoUrl: github.com?repo=${{ parameters.serviceName }}&owner=${{ parameters.repoOrg }}
      defaultBranch: main
      repoVisibility: ${{ parameters.repoVisibility }}
      hasWiki: false
      hasProjects: false
      requireCodeOwners: true
      topics:
      - go
      - microservice
      - ${{ parameters.team }}

  # 3. Add GitHub Actions CI
  - id: add-ci
    name: Configure CI/CD Pipeline
    action: github:actions:dispatch
    input:
      repoUrl: github.com?repo=platform-templates&owner=${{ parameters.repoOrg }}
      workflowId: setup-service-ci.yaml
      branchOrTagName: main
      workflowInputs:
        targetRepo: ${{ parameters.serviceName }}
        targetOrg: ${{ parameters.repoOrg }}
        team: ${{ parameters.team }}

  # 4. Provision infrastructure if database requested
  - id: provision-database
    name: Provision PostgreSQL Database
    if: ${{ parameters.enableDatabase }}
    action: http:backstage:request
    input:
      method: POST
      path: /api/proxy/crossplane
      body:
        apiVersion: platform.example.com/v1alpha1
        kind: PostgreSQLDatabase
        metadata:
          name: ${{ parameters.serviceName }}-db
          namespace: platform-managed
        spec:
          forProvider:
            serviceName: ${{ parameters.serviceName }}
            team: ${{ parameters.team }}
            environment: ${{ parameters.environment }}
            instanceClass: db.t4g.small
            engineVersion: "15"
            storageGB: 20

  # 5. Register in Backstage software catalog
  - id: register-catalog
    name: Register in Software Catalog
    action: catalog:register
    input:
      repoContentsUrl: ${{ steps['create-repo'].output.repoContentsUrl }}
      catalogInfoPath: /catalog-info.yaml

  output:
    links:
    - title: Repository
      url: ${{ steps['create-repo'].output.remoteUrl }}
    - title: Open in Catalog
      icon: catalog
      entityRef: ${{ steps['register-catalog'].output.entityRef }}
    - title: CI/CD Pipeline
      url: ${{ steps['create-repo'].output.remoteUrl }}/actions
```

### Template Skeleton Structure

```
templates/new-service/skeleton/
├── catalog-info.yaml
├── README.md
├── Makefile
├── Dockerfile
├── .github/
│   └── workflows/
│       └── ci.yaml
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── handler/
│   │   └── handler.go
│   └── server/
│       └── server.go
├── deploy/
│   └── helm/
│       ├── Chart.yaml
│       ├── values.yaml
│       └── templates/
│           ├── deployment.yaml
│           ├── service.yaml
│           └── ingress.yaml
└── docs/
    └── index.md
```

```yaml
# templates/new-service/skeleton/catalog-info.yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: ${{ values.serviceName }}
  description: ${{ values.description }}
  annotations:
    github.com/project-slug: acme-engineering/${{ values.serviceName }}
    backstage.io/techdocs-ref: dir:.
    prometheus.io/rule: |
      - alert: ServiceHighErrorRate
        expr: sum(rate(http_requests_total{service="${{ values.serviceName }}",status=~"5.."}[5m])) / sum(rate(http_requests_total{service="${{ values.serviceName }}"}[5m])) > 0.01
  labels:
    team: ${{ values.team }}
spec:
  type: service
  lifecycle: experimental
  owner: group:${{ values.serviceOwner }}
  system: ${{ values.team }}-platform
  dependsOn:
  {% if values.enableDatabase %}
  - resource:default/${{ values.serviceName }}-db
  {% endif %}
  providesApis:
  - ${{ values.serviceName }}-api
```

## Section 5: Crossplane Compositions as Service Catalog

Crossplane allows platform teams to define composite resources (XRDs) that abstract cloud infrastructure details. Developers request a "PostgreSQLDatabase" without knowing which cloud provider, region, or RDS configuration parameters are involved.

### Defining a Composite Resource

```yaml
# crossplane/xrd/postgresql-database.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xpostgresqldatabases.platform.example.com
spec:
  group: platform.example.com
  names:
    kind: XPostgreSQLDatabase
    plural: xpostgresqldatabases
  claimNames:
    kind: PostgreSQLDatabase
    plural: postgresqldatabases
  defaultCompositionRef:
    name: postgresql-aws
  versions:
  - name: v1alpha1
    served: true
    referenceable: true
    schema:
      openAPIV3Schema:
        type: object
        properties:
          spec:
            type: object
            required:
            - parameters
            properties:
              parameters:
                type: object
                required:
                - serviceName
                - team
                - environment
                properties:
                  serviceName:
                    type: string
                    description: "Name of the service that owns this database"
                  team:
                    type: string
                    description: "Team responsible for the service"
                  environment:
                    type: string
                    enum: [development, staging, production]
                  instanceClass:
                    type: string
                    default: db.t4g.small
                    enum:
                    - db.t4g.small
                    - db.t4g.medium
                    - db.t4g.large
                    - db.r6g.large
                  engineVersion:
                    type: string
                    default: "15"
                    enum: ["14", "15", "16"]
                  storageGB:
                    type: integer
                    default: 20
                    minimum: 20
                    maximum: 500
                  enableReadReplica:
                    type: boolean
                    default: false
          status:
            type: object
            properties:
              endpoint:
                type: string
                description: "Database connection endpoint"
              secretName:
                type: string
                description: "Name of the secret containing credentials"
              ready:
                type: boolean
```

### Crossplane Composition for AWS RDS

```yaml
# crossplane/compositions/postgresql-aws.yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: postgresql-aws
  labels:
    provider: aws
    environment: production
spec:
  compositeTypeRef:
    apiVersion: platform.example.com/v1alpha1
    kind: XPostgreSQLDatabase
  patchSets:
  - name: common-tags
    patches:
    - type: FromCompositeFieldPath
      fromFieldPath: spec.parameters.team
      toFieldPath: spec.forProvider.tags.team
    - type: FromCompositeFieldPath
      fromFieldPath: spec.parameters.serviceName
      toFieldPath: spec.forProvider.tags.service
    - type: FromCompositeFieldPath
      fromFieldPath: spec.parameters.environment
      toFieldPath: spec.forProvider.tags.environment

  resources:
  # RDS Parameter Group
  - name: parameter-group
    base:
      apiVersion: rds.aws.upbound.io/v1beta1
      kind: ParameterGroup
      spec:
        forProvider:
          region: us-east-1
          family: postgres15
          description: "Managed by Crossplane"
          parameter:
          - name: log_min_duration_statement
            value: "1000"  # Log queries slower than 1 second
          - name: log_connections
            value: "1"
          - name: log_disconnections
            value: "1"
          - name: shared_preload_libraries
            value: "pg_stat_statements"
        providerConfigRef:
          name: aws-provider-config
    patches:
    - type: FromCompositeFieldPath
      fromFieldPath: spec.parameters.serviceName
      toFieldPath: metadata.name
      transforms:
      - type: string
        string:
          fmt: "%s-pg-params"

  # RDS Instance
  - name: rds-instance
    base:
      apiVersion: rds.aws.upbound.io/v1beta1
      kind: Instance
      spec:
        forProvider:
          region: us-east-1
          engine: postgres
          engineVersion: "15"
          dbInstanceClass: db.t4g.small
          allocatedStorage: 20
          storageType: gp3
          storageEncrypted: true
          kmsKeyId: arn:aws:kms:us-east-1:123456789012:key/placeholder-key-id-db
          multiAz: false
          skipFinalSnapshot: false
          deletionProtection: true
          backupRetentionPeriod: 7
          maintenanceWindow: "sun:04:00-sun:05:00"
          backupWindow: "03:00-04:00"
          enabledCloudwatchLogsExports:
          - postgresql
          - upgrade
          autoMinorVersionUpgrade: true
          dbSubnetGroupName: rds-private-subnet-group
          vpcSecurityGroupIds:
          - sg-placeholder-rds-sg
          publiclyAccessible: false
          username: postgres
          passwordSecretRef:
            namespace: platform-managed
            key: password
        writeConnectionSecretToRef:
          namespace: platform-managed
        providerConfigRef:
          name: aws-provider-config
    patches:
    - type: FromCompositeFieldPath
      fromFieldPath: spec.parameters.serviceName
      toFieldPath: metadata.name
      transforms:
      - type: string
        string:
          fmt: "%s-db"
    - type: FromCompositeFieldPath
      fromFieldPath: spec.parameters.instanceClass
      toFieldPath: spec.forProvider.dbInstanceClass
    - type: FromCompositeFieldPath
      fromFieldPath: spec.parameters.engineVersion
      toFieldPath: spec.forProvider.engineVersion
    - type: FromCompositeFieldPath
      fromFieldPath: spec.parameters.storageGB
      toFieldPath: spec.forProvider.allocatedStorage
    - type: ToCompositeFieldPath
      fromFieldPath: status.atProvider.endpoint
      toFieldPath: status.endpoint
    connectionDetails:
    - fromConnectionSecretKey: endpoint
    - fromConnectionSecretKey: port
    - fromConnectionSecretKey: username
    - fromConnectionSecretKey: password
    readinessChecks:
    - type: MatchString
      fieldPath: status.atProvider.dbInstanceStatus
      matchString: available
```

### Developer Usage of Crossplane Composite Resource

```yaml
# developer-creates-this.yaml
apiVersion: platform.example.com/v1alpha1
kind: PostgreSQLDatabase
metadata:
  name: payment-service-db
  namespace: payments
spec:
  parameters:
    serviceName: payment-service
    team: payments
    environment: production
    instanceClass: db.t4g.medium
    engineVersion: "15"
    storageGB: 50
    enableReadReplica: false
  writeConnectionSecretToRef:
    name: payment-service-db-credentials
    namespace: payments
```

The developer submits this 15-line YAML and Crossplane handles creating the RDS parameter group, instance, monitoring, tags, and connection secret—without the developer needing to know any of those details.

## Section 6: Helm Chart Libraries

Helm chart libraries (library charts) provide reusable templates that reduce boilerplate across service Helm charts. Instead of each service maintaining its own `deployment.yaml`, they share a common template from the library chart.

### Platform Library Chart

```yaml
# charts/platform-library/Chart.yaml
apiVersion: v2
name: platform-library
description: "Shared Helm templates for all ACME services"
type: library
version: 1.5.0
```

```yaml
# charts/platform-library/templates/_deployment.yaml
{{/*
Standard deployment template for all services.
Services include this via {{ include "platform-library.deployment" . }}
*/}}
{{- define "platform-library.deployment" -}}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "platform-library.fullname" . }}
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "platform-library.labels" . | nindent 4 }}
  annotations:
    deployment.kubernetes.io/revision: {{ .Release.Revision | quote }}
spec:
  replicas: {{ .Values.replicaCount | default 2 }}
  selector:
    matchLabels:
      {{- include "platform-library.selectorLabels" . | nindent 6 }}
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    metadata:
      labels:
        {{- include "platform-library.labels" . | nindent 8 }}
        version: {{ .Values.image.tag | default "latest" | quote }}
      annotations:
        # Force pod restart on configmap change
        checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
    spec:
      serviceAccountName: {{ include "platform-library.serviceAccountName" . }}
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        fsGroup: 65534
        seccompProfile:
          type: RuntimeDefault
      terminationGracePeriodSeconds: 60
      containers:
      - name: {{ .Chart.Name }}
        image: "{{ .Values.image.registry }}/{{ .Values.image.repository }}:{{ .Values.image.tag }}"
        imagePullPolicy: {{ .Values.image.pullPolicy | default "IfNotPresent" }}
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities:
            drop:
            - ALL
        ports:
        - name: http
          containerPort: {{ .Values.service.port | default 8080 }}
          protocol: TCP
        - name: metrics
          containerPort: {{ .Values.metrics.port | default 9090 }}
          protocol: TCP
        env:
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        - name: POD_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace
        - name: POD_IP
          valueFrom:
            fieldRef:
              fieldPath: status.podIP
        {{- with .Values.env }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
        {{- with .Values.envFrom }}
        envFrom:
        {{- toYaml . | nindent 8 }}
        {{- end }}
        resources:
          {{- toYaml .Values.resources | nindent 10 }}
        livenessProbe:
          httpGet:
            path: {{ .Values.probes.liveness.path | default "/healthz" }}
            port: http
          initialDelaySeconds: {{ .Values.probes.liveness.initialDelaySeconds | default 10 }}
          periodSeconds: 10
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: {{ .Values.probes.readiness.path | default "/readyz" }}
            port: http
          initialDelaySeconds: {{ .Values.probes.readiness.initialDelaySeconds | default 5 }}
          periodSeconds: 5
          failureThreshold: 3
        volumeMounts:
        - name: tmp
          mountPath: /tmp
        {{- with .Values.volumeMounts }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
      volumes:
      - name: tmp
        emptyDir: {}
      {{- with .Values.volumes }}
      {{- toYaml . | nindent 6 }}
      {{- end }}
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: kubernetes.io/hostname
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            {{- include "platform-library.selectorLabels" . | nindent 12 }}
      {{- with .Values.nodeSelector }}
      nodeSelector:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with .Values.affinity }}
      affinity:
        {{- toYaml . | nindent 8 }}
      {{- end }}
{{- end -}}
```

### Service Using the Library Chart

```yaml
# services/payment-service/Chart.yaml
apiVersion: v2
name: payment-service
description: "Payment processing microservice"
type: application
version: 2.1.0
appVersion: "2.1.0"

dependencies:
- name: platform-library
  version: ">=1.5.0"
  repository: "oci://registry.internal.example.com/charts"
```

```yaml
# services/payment-service/templates/deployment.yaml
{{- include "platform-library.deployment" . }}
```

```yaml
# services/payment-service/values.yaml
replicaCount: 3

image:
  registry: registry.internal.example.com
  repository: payment-service
  tag: "2.1.0"

service:
  port: 8080

metrics:
  port: 9090

resources:
  requests:
    cpu: "500m"
    memory: "512Mi"
  limits:
    cpu: "2"
    memory: "2Gi"

env:
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: payment-service-db-credentials
      key: endpoint
- name: LOG_LEVEL
  value: "info"

probes:
  liveness:
    path: /healthz
    initialDelaySeconds: 15
  readiness:
    path: /readyz
    initialDelaySeconds: 5
```

## Section 7: Developer Cognitive Load Reduction

### Measuring Cognitive Load

Developer cognitive load manifests as:
- Time spent reading documentation to understand how to deploy a change.
- Number of systems a developer must understand to complete a task.
- Number of tickets or slack messages needed per deployment.
- Error rate on first-time deployments.

Tracking these metrics before and after platform investments quantifies the impact.

### Abstractions That Reduce Load

**Before platform (high cognitive load)**:
```
Developer must know:
- Which Kubernetes cluster(s) to deploy to
- How to write a Helm chart
- How to configure ArgoCD ApplicationSet
- How to set up GitHub Actions
- How to provision RDS (Terraform, VPC, subnet groups, security groups)
- How to configure External Secrets Operator
- How to define Prometheus alert rules
- How to create a Loki dashboard
- How to configure PodDisruptionBudgets
- Total: ~12 distinct systems with their own learning curves
```

**After platform (reduced cognitive load)**:
```
Developer must know:
- Run `backstage-create new-service` and fill in a form
- Deploy by merging to main (GitOps handles the rest)
- Total: 1 workflow, most infrastructure details hidden
```

### Service Level Objectives as Code

```yaml
# services/payment-service/slos.yaml
# Developer-facing SLO configuration (simplified)
apiVersion: platform.example.com/v1alpha1
kind: ServiceLevelObjective
metadata:
  name: payment-service-slos
  namespace: payments
spec:
  service: payment-service
  slos:
  - name: availability
    target: 99.9
    window: 30d
    indicator:
      type: request_availability
      goodCondition: "http_response_code < 500"

  - name: latency
    target: 99.0
    window: 30d
    indicator:
      type: request_latency
      threshold: 500ms
      percentile: 99

  alerting:
    page:
      burnRateThreshold: 14.4  # Page if burning 14.4x budget
    ticket:
      burnRateThreshold: 6.0   # Create ticket if burning 6x budget
```

The platform team builds the Prometheus recording rules, Alertmanager routes, and Grafana dashboards from this simplified YAML. The developer specifies what matters (99.9% available, 99th percentile latency under 500ms) without knowing how to write PromQL.

## Section 8: Platform Team Topologies

### Team Topologies Framework Applied to Platform

Matthew Skelton and Manuel Pais's Team Topologies framework provides a model for organizing platform teams:

**Platform Team**: Builds and maintains the IDP. Works in product mode: roadmaps, user research with developers, release notes. Does NOT handle individual service deployments.

**Enabling Team**: Temporarily assists development teams adopting new platform capabilities. Focused on knowledge transfer, not doing the work for them.

**Stream-aligned Teams**: Development teams building products. Primary consumers of the platform. Provide feedback to platform team via RFC process and support tickets.

**Complicated Subsystem Teams**: Teams with deep specialization (database operations, network security) that platform teams consult for XRD designs.

### Platform Team Charter Template

```markdown
## Platform Engineering Team Charter

### Mission
Enable development teams to deliver software to production safely and quickly
by building and maintaining the Internal Developer Platform.

### Customers
All engineering teams at ACME Engineering.

### Responsibilities
- Maintain Backstage developer portal
- Design and implement Crossplane XRDs for approved infrastructure patterns
- Maintain platform Helm library charts
- Run the shared GitOps infrastructure (ArgoCD, Flux)
- Define and enforce platform security policies via OPA/Kyverno
- Maintain observability platform (Prometheus, Grafana, Loki, Tempo)
- On-call rotation for platform components

### NOT Responsibilities
- Deploying individual services (teams own their deployments)
- Writing application code for other teams
- Managing individual service incidents (platform on-call escalates only)

### Engagement Model
- Golden Path adoption: Office hours every Tuesday 2-4pm
- New infrastructure patterns: RFC process with 2-week review
- Urgent platform issues: Slack #platform-team (SLA: 4h response, 8h resolution)
- Feature requests: GitHub Issues on platform-idp repository

### Success Metrics
- DORA metrics improvement across engineering org
- Time-to-first-deployment for new services: target < 2 hours
- Platform NPS (measured quarterly): target > 50
- On-call escalation rate: < 10% of incidents reach platform team
```

## Section 9: Success Metrics for Platform Engineering

### DORA Metrics as Platform KPIs

The four DORA metrics directly reflect platform engineering quality:

```promql
# Deployment Frequency (per team)
# Count successful deployments in ArgoCD per day
count_over_time(
  argocd_app_info{
    health_status="Healthy",
    sync_status="Synced"
  }[1d]
)

# Lead Time for Changes
# Time from PR merge to production deployment
histogram_quantile(0.50,
  rate(platform_deployment_lead_time_seconds_bucket[7d])
)

# Change Failure Rate
# Percentage of deployments requiring rollback
sum(rate(argocd_app_sync_total{phase="Error"}[7d]))
/
sum(rate(argocd_app_sync_total[7d]))
* 100

# Time to Restore Service
# Time from incident created to resolved
histogram_quantile(0.50,
  rate(platform_incident_duration_seconds_bucket[30d])
)
```

### Platform-Specific Metrics

```yaml
# platform-metrics-dashboard.yaml
# Grafana dashboard JSON (abbreviated)
panels:
- title: "Golden Path Adoption Rate"
  description: "% of services deployed via golden path vs custom"
  # Measured as: services with platform-managed label / total services
  query: |
    count(kube_deployment_labels{label_platform_managed="true"})
    /
    count(kube_deployment_created)
    * 100

- title: "Time to First Deployment (New Services)"
  description: "Hours from template instantiation to first production deployment"
  query: |
    histogram_quantile(0.50,
      rate(backstage_scaffolder_task_duration_seconds_bucket[30d])
    ) / 3600

- title: "Self-Service Success Rate"
  description: "% of resource requests completed without platform team involvement"
  query: |
    sum(rate(crossplane_managed_resource_ready_total[7d]))
    /
    sum(rate(crossplane_managed_resource_applied_total[7d]))
    * 100

- title: "Developer Portal Daily Active Users"
  description: "Unique developers using Backstage per day"
  query: |
    count(backstage_http_requests_total{method="GET"}) by (user)
```

### Platform Health Dashboard

```yaml
# Kyverno policy to enforce platform standards
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-platform-labels
spec:
  validationFailureAction: audit
  background: true
  rules:
  - name: check-platform-labels
    match:
      any:
      - resources:
          kinds:
          - Deployment
          namespaces:
          - "production"
          - "staging"
    validate:
      message: "Deployment must have platform-managed, team, and service labels"
      pattern:
        metadata:
          labels:
            platform-managed: "true"
            team: "?*"
            app: "?*"
```

## Section 10: Incremental Platform Adoption

Building a platform is a multi-year investment. Attempting to build the entire IDP before delivering value leads to failure. An incremental approach:

### Phase 1: Foundation (Months 1-3)
- Deploy Backstage with software catalog populated from existing GitHub repos.
- Set up ArgoCD with existing Helm charts (no new golden paths yet).
- Establish platform team charter and engagement model.
- **Value delivered**: Visibility into what runs where, who owns what.

### Phase 2: First Golden Path (Months 3-6)
- Build one complete golden path for the most common service type.
- Create the Backstage scaffolder template.
- Validate with 2-3 pilot teams.
- **Value delivered**: New services deployed in hours, not weeks.

### Phase 3: Self-Service Infrastructure (Months 6-12)
- Implement Crossplane XRDs for top 3 infrastructure requests (databases, queues, caches).
- Integrate with External Secrets Operator.
- **Value delivered**: Database provisioning in minutes, no tickets.

### Phase 4: Observability Integration (Months 9-15)
- Auto-configure Prometheus scraping and basic alerts for all golden path services.
- Implement SLO-as-code.
- Pre-built Grafana dashboards per service type.
- **Value delivered**: New services observable from day one.

### Phase 5: Policy as Code (Months 12-18)
- OPA/Kyverno policies enforcing security baselines.
- Policy violations reported in Backstage.
- Automated remediation for common issues.
- **Value delivered**: Security compliance without security team being a bottleneck.

## Conclusion

Platform engineering succeeds when it is treated as product development, not infrastructure maintenance. The customers are developers, and their satisfaction (measured via developer NPS, time-to-production, and DORA metrics) determines whether the investment is justified.

The golden path concept provides a useful design constraint: rather than building infinitely flexible infrastructure, the platform team makes opinionated choices about the recommended path for 80% of use cases, invests in making that path excellent, and allows escape hatches for the remaining 20%. Backstage provides the developer-facing interface, Crossplane provides the infrastructure abstraction, and GitOps provides the deployment mechanism. Together, these tools reduce cognitive load for development teams while maintaining the security and compliance guardrails that enterprise organizations require.
