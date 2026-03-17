---
title: "Kubernetes Spinnaker: Halyard to Operator Migration, Pipeline Templates, Canary Analysis, and Manual Judgments"
date: 2032-02-16T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Spinnaker", "CI/CD", "Canary", "Deployment", "Pipeline"]
categories:
- Kubernetes
- CI/CD
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to running Spinnaker on Kubernetes: migrating from Halyard to the Spinnaker Operator, building reusable pipeline templates, configuring automated canary analysis with Kayenta, and implementing manual judgment gates for compliance."
more_link: "yes"
url: "/kubernetes-spinnaker-halyard-operator-pipeline-canary-enterprise-guide/"
---

Spinnaker remains the deployment platform of choice for organizations that require multi-cloud delivery, sophisticated traffic management, and audit-grade approval workflows. This guide covers migrating from the legacy Halyard-based deployment to the Spinnaker Operator, creating reusable pipeline templates, configuring Kayenta for automated canary analysis using Prometheus metrics, and implementing manual judgment stages with notifications and compliance hooks.

<!--more-->

# Kubernetes Spinnaker: Enterprise Deployment and Pipeline Guide

## Section 1: Architecture Overview

Spinnaker is composed of independent microservices, each responsible for a specific domain:

| Service | Role |
|---|---|
| Gate | API gateway (REST + WebSocket) |
| Orca | Orchestration engine (pipeline execution) |
| Clouddriver | Cloud provider adapter (Kubernetes, AWS, GCP) |
| Front50 | Persistent store for pipelines, applications, projects |
| Rosco | Image bakery (AMI, Docker) |
| Igor | CI/CD integration (Jenkins, GitHub Actions, Concourse) |
| Echo | Event bus and notifications |
| Fiat | Authorization (RBAC) |
| Kayenta | Automated canary analysis |
| Deck | Browser UI |

All services communicate via internal REST APIs. Orca drives pipeline execution by calling other services in a saga-like pattern.

## Section 2: Spinnaker Operator Installation

The Spinnaker Operator replaces Halyard as the Kubernetes-native way to deploy and manage Spinnaker. It uses a `SpinnakerService` CRD.

### Install the Operator

```bash
# Install the CRDs
kubectl apply -f https://raw.githubusercontent.com/armory/spinnaker-operator/main/deploy/crds/spinnaker.io_spinnakerservices_crd.yaml

# Create namespace
kubectl create namespace spinnaker-operator
kubectl create namespace spinnaker

# Install the operator
kubectl -n spinnaker-operator apply -f \
  https://raw.githubusercontent.com/armory/spinnaker-operator/main/deploy/operator/cluster/

# Verify operator is running
kubectl -n spinnaker-operator get pods
```

### SpinnakerService Custom Resource

```yaml
# spinnaker-service.yaml
apiVersion: spinnaker.io/v1alpha2
kind: SpinnakerService
metadata:
  name: spinnaker
  namespace: spinnaker
spec:
  # The Spinnaker version to deploy
  spinnakerConfig:
    config:
      version: 1.35.0

      # ── Persistence ─────────────────────────────────────────────
      persistentStorage:
        persistentStoreType: s3
        s3:
          bucket: <spinnaker-front50-bucket>
          region: us-east-1
          rootFolder: front50

      # ── Features ─────────────────────────────────────────────────
      features:
        pipelineTemplates: true
        managedPipelineTemplatesV2UI: true
        artifactsRewrite: true

      # ── Providers ────────────────────────────────────────────────
      providers:
        kubernetes:
          enabled: true
          accounts:
          - name: production-k8s
            providerVersion: V2
            kubeconfigFile: encryptedFile:k8s:k8s-kubeconfig
            namespaces:
            - production
            - staging
            onlySpinnakerManaged: false
            liveManifestCalls: true
          - name: staging-k8s
            providerVersion: V2
            kubeconfigFile: encryptedFile:k8s:k8s-staging-kubeconfig
            namespaces:
            - staging
          primaryAccount: production-k8s

      # ── CI Integration ───────────────────────────────────────────
      ci:
        jenkins:
          enabled: false
        github:
          enabled: true
          accounts:
          - name: github
            token: encryptedFile:github:github-token

      # ── Artifact Sources ─────────────────────────────────────────
      artifacts:
        github:
          enabled: true
          accounts:
          - name: github-artifacts
            token: encryptedFile:github:github-token
        s3:
          enabled: true
          accounts:
          - name: s3-artifacts
            region: us-east-1

      # ── Notifications ────────────────────────────────────────────
      notifications:
        slack:
          enabled: true
          botName: spinnaker
          token: encryptedFile:slack:slack-bot-token

      # ── Security ─────────────────────────────────────────────────
      security:
        authn:
          oauth2:
            enabled: true
            client:
              clientId: <oauth-client-id>
              clientSecret: encryptedFile:oauth:oauth-secret
              scope: email profile
            provider: GITHUB
            userInfoMapping:
              email: email
              firstName: name
              lastName: ""
              username: login
        authz:
          enabled: true
          groupMembership:
            service: GITHUB_TEAMS
            github:
              organization: myorg
              baseUrl: https://api.github.com
              token: encryptedFile:github:github-token

    # ── Service-specific overrides ─────────────────────────────────
    service-settings:
      gate:
        healthEndpoint: /health
        kubernetes:
          serviceType: ClusterIP
      deck:
        env:
          API_HOST: https://spinnaker-gate.example.com
          AUTH_ENABLED: "true"
        kubernetes:
          serviceType: ClusterIP

    # ── Profile overrides ──────────────────────────────────────────
    profiles:
      orca:
        tasks:
          executionWindow: 7200000
        executionRepository:
          redis:
            enabled: true
        queue:
          zombieCheck:
            enabled: true
            frequency: PT10M
        # Limit concurrent pipeline executions per application
        maxConcurrentExecutions: 20

      clouddriver:
        kubernetes:
          # Cache refresh interval
          cachingAgents:
            threadCount: 8
        sql:
          enabled: true
          connectionPools:
            default:
              jdbcUrl: jdbc:mysql://<db-host>:3306/clouddriver
              user: clouddriver
              password: encryptedFile:db:clouddriver-password
              connectionTimeout: 6000
              maxLifetime: 30000
              maxPoolSize: 50

      gate:
        default:
          apiPort: 8084
        cors:
          allowedOriginsPattern: https://spinnaker.example.com

      front50:
        sql:
          enabled: true
          connectionPools:
            default:
              jdbcUrl: jdbc:mysql://<db-host>:3306/front50
              user: front50
              password: encryptedFile:db:front50-password

      echo:
        slack:
          token: encryptedFile:slack:slack-bot-token
        notifications:
          mail:
            enabled: true
            from: noreply@example.com
          slack:
            enabled: true

      kayenta:
        enabled: true
        prometheus:
          enabled: true
          accounts:
          - name: prometheus-production
            endpoint:
              baseUrl: http://prometheus.monitoring.svc.cluster.local:9090

  # ── Kubernetes resource sizing ──────────────────────────────────
  expose:
    service:
      type: ClusterIP

  validation:
    providers:
      kubernetes:
        enabled: true
```

### Encrypting Secrets with Kubernetes Secrets

```bash
# Create Kubernetes secrets for Spinnaker secrets
kubectl -n spinnaker create secret generic k8s-kubeconfig \
  --from-file=k8s-kubeconfig=/path/to/production-kubeconfig

kubectl -n spinnaker create secret generic github-token \
  --from-literal=github-token=<your-github-token>

kubectl -n spinnaker create secret generic slack-bot-token \
  --from-literal=slack-bot-token=<your-slack-bot-token>
```

Reference secrets in the SpinnakerService config using `encryptedFile:k8s:<secret-name>` syntax.

### Validate and Apply

```bash
# Apply the SpinnakerService
kubectl -n spinnaker apply -f spinnaker-service.yaml

# Watch the operator reconcile
kubectl -n spinnaker-operator logs -f -l app=spinnaker-operator

# Check SpinnakerService status
kubectl -n spinnaker get spinnakerservices
kubectl -n spinnaker describe spinnakerservice spinnaker

# Wait for all services to be ready
kubectl -n spinnaker get pods -w
```

## Section 3: Migrating from Halyard

If you have an existing Halyard-managed deployment, the migration involves exporting the Halyard config and converting it to the operator format.

```bash
# On the Halyard host: export current config
hal config list
hal version current
cat ~/.hal/config > halyard-config.yaml

# Key differences:
# Halyard                      | Operator (SpinnakerService)
# hal config provider k8s ...  | spec.spinnakerConfig.config.providers.kubernetes
# hal config storage s3 ...    | spec.spinnakerConfig.config.persistentStorage.s3
# hal deploy edit --type distributed | spec.spinnakerConfig (operator manages deployment)

# Use armory's migration script to convert
curl -LO https://raw.githubusercontent.com/armory/spinnaker-operator/main/tools/hal-to-operator/migrate.py
python3 migrate.py halyard-config.yaml > spinnaker-service-migrated.yaml

# Review and adjust the output before applying
kubectl -n spinnaker apply -f spinnaker-service-migrated.yaml
```

## Section 4: Pipeline Templates (MPTv2)

Managed Pipeline Templates v2 (MPTv2) allows defining reusable pipeline skeletons that applications inherit. Teams customize behavior via variables without modifying the template.

### Template Definition

```yaml
# pipeline-template.yaml
schema: v2
id: standard-deploy-template
metadata:
  name: standard-deploy-template
  description: >
    Standard deployment pipeline with bake, staging deploy,
    canary analysis, manual judgment, and production deploy.
  owner: platform-team@example.com
  scopes:
  - global   # available to all applications

variables:
- name: registry
  group: Docker
  description: Docker registry hostname
  type: string
  defaultValue: registry.example.com

- name: imageTag
  group: Docker
  description: Docker image tag to deploy
  type: string

- name: application
  group: App
  description: Application name
  type: string

- name: namespace
  group: Kubernetes
  description: Target Kubernetes namespace
  type: string
  defaultValue: production

- name: canaryEnabled
  group: Canary
  description: Whether to run canary analysis before full rollout
  type: boolean
  defaultValue: true

- name: canaryWeight
  group: Canary
  description: Percentage of traffic to route to canary
  type: int
  defaultValue: 10

- name: requiredApprovers
  group: Approvals
  description: Comma-separated list of GitHub teams that must approve
  type: string
  defaultValue: "platform-team"

pipeline:
  keepWaitingPipelines: false
  limitConcurrent: true
  parameterConfig:
  - name: imageTag
    required: true
    description: Docker image tag
  - name: releaseNotes
    required: false
    description: Release notes for this deployment

  stages:
  # Stage 1: Validate Image Exists
  - name: Validate Image
    type: runJobManifest
    refId: "1"
    requisiteStageRefIds: []
    account: production-k8s
    cloudProvider: kubernetes
    source: text
    manifest:
      apiVersion: batch/v1
      kind: Job
      metadata:
        name: validate-image-${ parameters.imageTag }-${ execution.id }
        namespace: spinnaker
      spec:
        ttlSecondsAfterFinished: 3600
        template:
          spec:
            restartPolicy: Never
            containers:
            - name: validate
              image: alpine:3.18
              command:
              - sh
              - -c
              - |
                apk add -q crane
                crane manifest ${ variables.registry }/${ variables.application }:${ parameters.imageTag }
                echo "Image validated successfully"

  # Stage 2: Deploy to Staging
  - name: Deploy to Staging
    type: deployManifest
    refId: "2"
    requisiteStageRefIds: ["1"]
    account: staging-k8s
    cloudProvider: kubernetes
    source: text
    skipExpressionEvaluation: false
    trafficManagement:
      enabled: false
    manifests:
    - apiVersion: apps/v1
      kind: Deployment
      metadata:
        name: ${ variables.application }-staging
        namespace: staging
        labels:
          app: ${ variables.application }
          env: staging
          version: ${ parameters.imageTag }
      spec:
        replicas: 2
        selector:
          matchLabels:
            app: ${ variables.application }
            env: staging
        template:
          metadata:
            labels:
              app: ${ variables.application }
              env: staging
              version: ${ parameters.imageTag }
          spec:
            containers:
            - name: app
              image: ${ variables.registry }/${ variables.application }:${ parameters.imageTag }
              ports:
              - containerPort: 8080

  # Stage 3: Integration Tests
  - name: Integration Tests
    type: runJobManifest
    refId: "3"
    requisiteStageRefIds: ["2"]
    account: staging-k8s
    cloudProvider: kubernetes
    stageTimeoutMs: 1800000  # 30 minutes
    source: text
    manifest:
      apiVersion: batch/v1
      kind: Job
      metadata:
        name: integration-test-${ parameters.imageTag }-${ execution.id }
        namespace: staging
      spec:
        ttlSecondsAfterFinished: 7200
        template:
          spec:
            restartPolicy: Never
            containers:
            - name: tests
              image: ${ variables.registry }/${ variables.application }-tests:${ parameters.imageTag }
              env:
              - name: APP_URL
                value: http://${ variables.application }-staging.staging.svc.cluster.local:8080

  # Stage 4: Canary Deploy (conditional)
  - name: Deploy Canary
    type: deployManifest
    refId: "4"
    requisiteStageRefIds: ["3"]
    stageEnabled:
      expression: "${ variables.canaryEnabled }"
      type: expression
    account: production-k8s
    cloudProvider: kubernetes
    source: text
    manifests:
    - apiVersion: apps/v1
      kind: Deployment
      metadata:
        name: ${ variables.application }-canary
        namespace: ${ variables.namespace }
        labels:
          app: ${ variables.application }
          track: canary
          version: ${ parameters.imageTag }
      spec:
        replicas: 1
        selector:
          matchLabels:
            app: ${ variables.application }
            track: canary
        template:
          metadata:
            labels:
              app: ${ variables.application }
              track: canary
              version: ${ parameters.imageTag }
          spec:
            containers:
            - name: app
              image: ${ variables.registry }/${ variables.application }:${ parameters.imageTag }

  # Stage 5: Canary Analysis
  - name: Canary Analysis
    type: kayentaCanary
    refId: "5"
    requisiteStageRefIds: ["4"]
    stageEnabled:
      expression: "${ variables.canaryEnabled }"
      type: expression
    analysisType: RealTime
    canaryConfig:
      canaryConfigId: standard-canary-config
      lifetimeDuration: PT30M
      metricsAccountName: prometheus-production
      storageAccountName: s3-canary
      scoreThresholds:
        marginal: 75
        pass: 90
    deployments:
      baseline:
        account: production-k8s
        cluster: ${ variables.application }
        moniker:
          app: ${ variables.application }
        cloudProvider: kubernetes
      canary:
        account: production-k8s
        cluster: ${ variables.application }-canary
        moniker:
          app: ${ variables.application }-canary
        cloudProvider: kubernetes

  # Stage 6: Manual Judgment
  - name: Approve Production Deploy
    type: manualJudgment
    refId: "6"
    requisiteStageRefIds: ["5"]
    judgmentInputs:
    - value: Proceed
    - value: Rollback
    instructions: |
      ## Production Deployment Review

      **Application**: ${ variables.application }
      **Version**: ${ parameters.imageTag }
      **Release Notes**:
      ${ parameters.releaseNotes ?: "No release notes provided" }

      ### Pre-approval Checklist
      - [ ] Canary analysis passed (see Stage 5 results)
      - [ ] Integration tests passed (see Stage 3 results)
      - [ ] On-call engineer notified
      - [ ] Change ticket updated

      Approve to proceed with full production rollout or rollback to cancel.
    notifications:
    - type: slack
      address: "#deployments"
      message:
        manualJudgment:
          text: |
            :warning: Manual judgment required for *${ variables.application }* deployment
            Version: `${ parameters.imageTag }`
            Requester: `${ trigger.user }`
            Review in Spinnaker: ${ execution.id }
      when:
      - manualJudgment
    sendNotifications: true

  # Stage 7: Production Deploy
  - name: Deploy to Production
    type: deployManifest
    refId: "7"
    requisiteStageRefIds: ["6"]
    completeOtherBranchesThenFail: false
    continuePipeline: false
    failPipeline: true
    stageEnabled:
      expression: "${ #judgment('Approve Production Deploy') == 'Proceed' }"
      type: expression
    account: production-k8s
    cloudProvider: kubernetes
    source: text
    strategy: highlander
    trafficManagement:
      enabled: true
      options:
        enableTraffic: true
        services:
        - ${ variables.application }
    manifests:
    - apiVersion: apps/v1
      kind: Deployment
      metadata:
        name: ${ variables.application }
        namespace: ${ variables.namespace }
        labels:
          app: ${ variables.application }
          version: ${ parameters.imageTag }
      spec:
        replicas: 3
        selector:
          matchLabels:
            app: ${ variables.application }
        template:
          metadata:
            labels:
              app: ${ variables.application }
              version: ${ parameters.imageTag }
          spec:
            containers:
            - name: app
              image: ${ variables.registry }/${ variables.application }:${ parameters.imageTag }

  # Stage 8: Cleanup Canary
  - name: Cleanup Canary
    type: deleteManifest
    refId: "8"
    requisiteStageRefIds: ["7"]
    account: production-k8s
    cloudProvider: kubernetes
    kinds:
    - Deployment
    labelSelectors:
      selectors:
      - key: track
        kind: EQUALS
        values:
        - canary
    location: ${ variables.namespace }

  # Stage 9: Rollback (on rejection)
  - name: Rollback on Rejection
    type: undoRolloutManifest
    refId: "9"
    requisiteStageRefIds: ["6"]
    stageEnabled:
      expression: "${ #judgment('Approve Production Deploy') == 'Rollback' }"
      type: expression
    account: production-k8s
    cloudProvider: kubernetes
    location: ${ variables.namespace }
    kind: Deployment
    targetName: ${ variables.application }
    numRevisionsBack: 1
```

### Uploading the Template

```bash
# Using spin CLI
spin pipeline-templates save --file pipeline-template.yaml

# Via API
curl -X POST \
  https://spinnaker-gate.example.com/pipelineTemplates \
  -H "Content-Type: application/json" \
  -d @pipeline-template.json
```

### Using the Template in an Application Pipeline

```yaml
# application-pipeline.yaml
schema: v2
application: my-service
template:
  reference: spinnaker://standard-deploy-template
variables:
  application: my-service
  registry: registry.example.com
  namespace: production
  canaryEnabled: true
  canaryWeight: 20
  requiredApprovers: my-team,platform-team
```

## Section 5: Kayenta Canary Analysis Configuration

Kayenta is Spinnaker's standalone canary analysis service. It queries metrics backends, computes scores based on statistical comparisons, and returns pass/fail decisions.

### Canary Config

```yaml
# kayenta-config.yaml
applications:
- my-service
name: standard-canary-config
description: Standard canary config comparing HTTP error rates and latency
metrics:
# Metric 1: HTTP Error Rate
- name: http_error_rate
  query:
    type: prometheus
    customInlineTemplate: >
      sum(rate(http_requests_total{status=~"5..",app="${scope}"}[2m]))
      /
      sum(rate(http_requests_total{app="${scope}"}[2m]))
  groups:
  - errors
  analysisConfigurations:
    canary:
      direction: increase
      nanStrategy: replace
      replaceWithZero: true
  scopeName: default

# Metric 2: P99 Request Latency
- name: http_latency_p99
  query:
    type: prometheus
    customInlineTemplate: >
      histogram_quantile(0.99,
        sum by (le) (
          rate(http_request_duration_seconds_bucket{app="${scope}"}[2m])
        )
      )
  groups:
  - latency
  analysisConfigurations:
    canary:
      direction: increase
      nanStrategy: replace
  scopeName: default

# Metric 3: Throughput (should stay flat)
- name: http_throughput
  query:
    type: prometheus
    customInlineTemplate: >
      sum(rate(http_requests_total{app="${scope}"}[2m]))
  groups:
  - throughput
  analysisConfigurations:
    canary:
      direction: either
      nanStrategy: replace
  scopeName: default

# Metric 4: CPU Usage
- name: cpu_usage
  query:
    type: prometheus
    customInlineTemplate: >
      sum(rate(container_cpu_usage_seconds_total{pod=~"${scope}-.*"}[2m]))
  groups:
  - resources
  analysisConfigurations:
    canary:
      direction: increase
  scopeName: default

classifier:
  groupWeights:
    errors: 40
    latency: 40
    throughput: 10
    resources: 10
  scoreThresholds:
    marginal: 75
    pass: 90
```

Upload the canary config:

```bash
spin canary-configs save --file kayenta-config.yaml
```

### Real-Time vs Retrospective Canary Analysis

```yaml
# Real-time: analysis runs while canary is live
- name: Canary Analysis (Real-Time)
  type: kayentaCanary
  analysisType: RealTime
  canaryConfig:
    lifetimeDuration: PT30M    # analyze for 30 minutes
    scoreThresholds:
      marginal: 75
      pass: 90

# Retrospective: analyze historical data (useful for off-hours deploys)
- name: Canary Analysis (Retrospective)
  type: kayentaCanary
  analysisType: Retrospective
  canaryConfig:
    beginCanaryAnalysisAfterMins: 5    # wait for metrics to stabilize
    lookbackMins: 30                   # analyze the last 30 minutes
```

## Section 6: Manual Judgment with Compliance Hooks

Manual judgment stages pause pipeline execution until a human approves. For compliance (SOX, PCI), they serve as change approval records.

### Advanced Manual Judgment with External Webhook

```yaml
- name: Change Management Approval
  type: manualJudgment
  refId: "cm-approval"
  stageTimeoutMs: 86400000   # 24 hour timeout
  judgmentInputs:
  - value: "Approved - CAB-{{ execution.id }}"
  - value: "Rejected"
  - value: "Emergency - Skip CAB"
  instructions: |
    ## Change Advisory Board Approval Required

    This deployment requires CAB approval per change management policy CM-101.

    **Change Details:**
    - Application: {{ trigger.artifacts[0].name }}
    - Version: {{ trigger.artifacts[0].version }}
    - Environment: Production
    - Requested by: {{ trigger.user }}
    - Pipeline ID: {{ execution.id }}

    **Instructions:**
    1. Create a change ticket in ServiceNow with the above details
    2. Obtain CAB approval
    3. Enter the ticket number in the judgment input above
    4. Click Approve

    Emergency changes require separate approval from CISO.
  notifications:
  - type: slack
    address: "#change-management"
    message:
      manualJudgment:
        text: |
          :clipboard: CAB Approval Required
          App: *{{ trigger.artifacts[0].name }}*
          Requester: {{ trigger.user }}
          Spinnaker: https://spinnaker.example.com/#/applications/{{ application }}/executions/details/{{ execution.id }}
    when:
    - manualJudgment
  - type: email
    address: "cab@example.com"
    message:
      manualJudgment:
        subject: "CAB Approval Required: {{ trigger.artifacts[0].name }}"
        text: |
          Change Advisory Board approval required for deployment.
          Application: {{ trigger.artifacts[0].name }}
          Pipeline: https://spinnaker.example.com/#/applications/{{ application }}/executions/details/{{ execution.id }}
    when:
    - manualJudgment
```

### Pre-Judgment Webhook to Create Change Ticket

```yaml
# Before the manual judgment, create a change ticket via webhook
- name: Create Change Ticket
  type: webhook
  refId: "create-ticket"
  requisiteStageRefIds: ["canary"]
  url: https://servicenow.example.com/api/now/table/change_request
  method: POST
  customHeaders:
    Authorization: Basic encryptedFile:snow:snow-credentials
    Content-Type: application/json
  payload: |
    {
      "short_description": "Automated deployment: {{ trigger.artifacts[0].name }}:{{ trigger.artifacts[0].version }}",
      "description": "Spinnaker pipeline execution {{ execution.id }} requesting production deployment",
      "category": "Software",
      "cmdb_ci": "{{ variables.application }}",
      "requested_by": "{{ trigger.user }}",
      "assignment_group": "platform-team",
      "start_date": "{{ new java.util.Date() | date('yyyy-MM-dd HH:mm:ss') }}",
      "end_date": "{{ (new java.util.Date().time + 3600000) | date('yyyy-MM-dd HH:mm:ss') }}"
    }
  statusUrlResolution: GET_METHOD
  statusJsonPath: $.result.state
  successStatuses: approved,scheduled

# Post-judgment webhook to close the ticket
- name: Close Change Ticket
  type: webhook
  refId: "close-ticket"
  requisiteStageRefIds: ["production-deploy"]
  url: https://servicenow.example.com/api/now/table/change_request/{{ #stage('Create Change Ticket').outputs.body.result.sys_id }}
  method: PATCH
  customHeaders:
    Authorization: Basic encryptedFile:snow:snow-credentials
    Content-Type: application/json
  payload: |
    {
      "state": "closed_complete",
      "close_notes": "Deployment completed successfully. Pipeline: {{ execution.id }}"
    }
```

## Section 7: Execution Windows (Maintenance Windows)

Restrict deployments to approved time windows for change management compliance:

```yaml
# Only deploy during business hours Mon-Fri
- name: Check Deployment Window
  type: checkPreconditions
  preconditions:
  - context:
      expression: >
        #toJson(#stage('Check Deployment Window').context)
        new DateTime().hourOfDay().get() >= 9 &&
        new DateTime().hourOfDay().get() <= 17 &&
        new DateTime().dayOfWeek().get() != 6 &&   # not Saturday
        new DateTime().dayOfWeek().get() != 7       # not Sunday
    failPipeline: true
    type: expression
```

Or use Spinnaker's built-in execution window stage:

```yaml
- name: Deployment Window
  type: restrictExecutionDuringTimeWindow
  restrictedExecutionWindow:
    days:
    - 1  # Monday
    - 2
    - 3
    - 4
    - 5  # Friday
    whitelist:
    - startHour: 9
      startMin: 0
      endHour: 17
      endMin: 0
  skipWindowText: "Skipping deployment window check (emergency bypass)"
```

## Section 8: Igor — GitHub Actions Trigger Integration

```yaml
# Configure Igor to listen for GitHub Actions events
# In SpinnakerService profiles.igor:
github:
  enabled: true
  accounts:
  - name: github
    token: encryptedFile:github:github-token
    permissions: []

# Application pipeline trigger
triggers:
- type: git
  branch: main
  enabled: true
  project: myorg
  repo: my-service
  source: github
  actions:
  - push
```

Trigger from GitHub Actions workflow:

```yaml
# .github/workflows/spinnaker-trigger.yaml
name: Deploy via Spinnaker
on:
  push:
    branches: [main]
    tags: ['v*']

jobs:
  trigger-spinnaker:
    runs-on: ubuntu-latest
    steps:
    - name: Trigger Spinnaker Pipeline
      run: |
        curl -X POST \
          https://spinnaker-gate.example.com/webhooks/git/github \
          -H "Content-Type: application/json" \
          -d '{
            "project": "${{ github.repository_owner }}",
            "slug": "${{ github.event.repository.name }}",
            "branch": "${{ github.ref_name }}",
            "hash": "${{ github.sha }}",
            "parameters": {
              "imageTag": "${{ github.sha }}",
              "releaseNotes": "${{ github.event.head_commit.message }}"
            }
          }'
```

## Section 9: RBAC and Application Permissions

Spinnaker Fiat enforces RBAC. Map GitHub teams to permissions:

```yaml
# Application permissions (set via API or UI)
permissions:
  READ:
  - everyone           # all authenticated users can view
  EXECUTE:
  - my-service-team    # only team members can trigger pipelines
  WRITE:
  - platform-team      # only platform team can modify pipelines
  CREATE_EXECUTION:
  - my-service-team
  - platform-team
```

```bash
# Using spin CLI to set permissions
spin application save \
  --application my-service \
  --permissions-read everyone \
  --permissions-execute my-service-team \
  --permissions-write platform-team

# Check effective permissions
spin application get my-service
```

## Section 10: Observability and Troubleshooting

### Key Metrics to Monitor

```promql
# Pipeline execution rate
sum(rate(spinnaker_pipelines_executions_total[5m])) by (application, status)

# Stage duration P99
histogram_quantile(0.99,
  sum by (application, stageType, le) (
    rate(spinnaker_stage_duration_seconds_bucket[5m])
  )
)

# Clouddriver API errors
sum(rate(spinnaker_clouddriver_requests_total{status="5xx"}[5m])) by (account)

# Orca queue depth
sum(spinnaker_orca_queue_depth) by (type)
```

### Debugging Pipeline Execution

```bash
# Get pipeline execution details via API
EXEC_ID="01ABCD1234"
curl -s \
  "https://spinnaker-gate.example.com/pipelines/${EXEC_ID}" | \
  jq '.stages[] | {name: .name, status: .status, startTime, endTime}'

# Orca logs for a specific execution
kubectl -n spinnaker logs -l app=orca --tail=500 | \
  grep "${EXEC_ID}"

# Force cancel a stuck execution
curl -X DELETE \
  "https://spinnaker-gate.example.com/pipelines/${EXEC_ID}"

# Retry a specific stage in a failed execution
curl -X POST \
  "https://spinnaker-gate.example.com/pipelines/${EXEC_ID}/stages/<stageId>/restart"
```

### Operator-Managed Upgrades

```bash
# Update Spinnaker version via operator
kubectl -n spinnaker patch spinnakerservice spinnaker \
  --type merge \
  -p '{"spec":{"spinnakerConfig":{"config":{"version":"1.36.0"}}}}'

# Watch rollout progress
kubectl -n spinnaker-operator logs -f -l app=spinnaker-operator
kubectl -n spinnaker rollout status deployment/spin-gate
```

## Section 11: Backup and Disaster Recovery

Front50 holds all pipeline and application definitions. Back it up regularly:

```bash
#!/bin/bash
# /usr/local/bin/spinnaker-backup.sh
BACKUP_DIR="/backup/spinnaker/$(date +%Y-%m-%d)"
mkdir -p "${BACKUP_DIR}"

# Export all applications and pipelines via spin CLI
spin application list | jq -r '.[].name' | while read -r app; do
  echo "Backing up application: ${app}"
  spin application get "${app}" > "${BACKUP_DIR}/app-${app}.json"
  spin pipeline list --application "${app}" | jq -r '.[].name' | while read -r pipeline; do
    spin pipeline get --application "${app}" --name "${pipeline}" \
      > "${BACKUP_DIR}/pipeline-${app}-${pipeline}.json"
  done
done

# Backup pipeline templates
spin pipeline-templates list | jq -r '.[].id' | while read -r tmpl; do
  spin pipeline-templates get --id "${tmpl}" \
    > "${BACKUP_DIR}/template-${tmpl}.json"
done

echo "Backup complete: ${BACKUP_DIR}"
aws s3 sync "${BACKUP_DIR}" "s3://<backup-bucket>/spinnaker/$(date +%Y-%m-%d)/"
```

## Summary

The Spinnaker Operator provides a declarative, Kubernetes-native way to manage Spinnaker deployments that is significantly more maintainable than Halyard. Key operational principles:

- **Operator adoption**: use `SpinnakerService` CRD with SQL backends for Front50 and Clouddriver for production-grade persistence
- **Pipeline templates** (MPTv2) eliminate copy-paste pipelines across applications — one template, many applications
- **Kayenta canary analysis** with Prometheus metrics provides objective, automated quality gates before production traffic shifts
- **Manual judgment** stages with notification hooks and webhook integrations satisfy change management and compliance requirements
- **Fiat RBAC** mapped to identity provider groups ensures least-privilege access to pipeline execution and modification

Together, these capabilities make Spinnaker a reliable platform for regulated environments where deployment safety, auditability, and multi-team isolation are requirements.
