---
title: "Argo Workflows: Cloud-Native Workflow Orchestration at Scale"
date: 2027-10-30T00:00:00-05:00
draft: false
tags: ["Argo", "Workflows", "Kubernetes", "CI/CD", "Orchestration"]
categories:
- Kubernetes
- CI/CD
author: "Matthew Mattox - mmattox@support.tools"
description: "Workflow templates, DAG tasks, artifact passing, parallelism, resource templates, executor configuration, workflow archiving with MinIO, RBAC, and production operational patterns."
more_link: "yes"
url: "/argo-workflows-production-guide/"
---

Argo Workflows is the de facto standard for cloud-native workflow orchestration on Kubernetes. Unlike Jenkins or Airflow, Argo Workflows executes each workflow step as a Kubernetes pod, providing native integration with Kubernetes RBAC, resource management, and observability. This guide covers the full production deployment from installation through advanced patterns including DAG-based workflows, artifact management, and workflow archiving.

<!--more-->

# Argo Workflows: Cloud-Native Workflow Orchestration at Scale

## Why Argo Workflows

Traditional workflow tools like Airflow run workflow tasks as threads or processes within a single scheduler process. This creates operational challenges at scale: the scheduler becomes a bottleneck, task isolation requires manual configuration, and integrating with Kubernetes resource constraints is awkward.

Argo Workflows solves these problems by making each workflow step a first-class Kubernetes pod. This means:

- Every task runs in isolation with its own container image
- Resource requests and limits are set at the task level
- Tasks can use any container image without shared dependencies
- Kubernetes RBAC controls who can submit and view workflows
- Pod logs and metrics integrate with existing observability infrastructure
- The workflow controller can leverage Kubernetes scheduling for placement

## Installation

### Helm Installation

```bash
helm repo add argo https://argoproj.github.io/argo-helm
helm repo update

helm install argo-workflows argo/argo-workflows \
  --namespace argo \
  --create-namespace \
  --version 0.41.0 \
  --set controller.workflowNamespaces="{argo,production,batch}" \
  --set server.extraArgs="{--auth-mode=sso}" \
  --set server.ingress.enabled=true \
  --set server.ingress.hosts="{workflows.company.internal}" \
  --set artifactRepository.archiveLogs=true \
  --set artifactRepository.s3.bucket=company-argo-artifacts \
  --set artifactRepository.s3.region=us-east-1 \
  --set artifactRepository.s3.endpoint=s3.amazonaws.com
```

### ConfigMap for Artifact Repository

Argo Workflows uses an artifact repository to pass large data between workflow steps. Configure MinIO for on-premises deployments:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: workflow-controller-configmap
  namespace: argo
data:
  config: |
    artifactRepository:
      archiveLogs: true
      s3:
        bucket: argo-artifacts
        endpoint: minio.storage.svc.cluster.local:9000
        insecure: true
        accessKeySecret:
          name: argo-minio-secret
          key: accessKey
        secretKeySecret:
          name: argo-minio-secret
          key: secretKey
    containerRuntimeExecutor: emissary
    executor:
      resources:
        requests:
          cpu: 100m
          memory: 64Mi
        limits:
          cpu: 500m
          memory: 512Mi
    workflowDefaults:
      spec:
        serviceAccountName: default-workflow-runner
        ttlStrategy:
          secondsAfterCompletion: 86400
          secondsAfterSuccess: 86400
          secondsAfterFailure: 604800
        podGC:
          strategy: OnWorkflowCompletion
    links:
    - name: Workflow Logs
      scope: workflow
      url: "https://grafana.company.internal/explore?left=%5B%22now-1h%22,%22now%22,%22Loki%22,%7B%22expr%22:%22%7Bworkflow%3D%5C%22${metadata.name}%5C%22%7D%22%7D%5D"
    - name: Pod Logs
      scope: pod
      url: "https://grafana.company.internal/explore?left=%5B%22now-1h%22,%22now%22,%22Loki%22,%7B%22expr%22:%22%7Bpod%3D%5C%22${metadata.name}%5C%22%7D%22%7D%5D"
```

### MinIO Secret

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: argo-minio-secret
  namespace: argo
type: Opaque
stringData:
  accessKey: argo-minio-access-key
  secretKey: argo-minio-secret-key-32chars-min
```

## RBAC Configuration

Argo Workflows requires careful RBAC setup for multi-tenant environments:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: argo-workflow-controller
  namespace: argo
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: argo-workflow-controller
rules:
- apiGroups: [""]
  resources: ["pods", "pods/exec"]
  verbs: ["create", "get", "list", "watch", "update", "patch", "delete"]
- apiGroups: [""]
  resources: ["persistentvolumeclaims", "persistentvolumeclaimtemplates"]
  verbs: ["create", "delete", "get"]
- apiGroups: [""]
  resources: ["configmaps"]
  verbs: ["get", "watch", "list"]
- apiGroups: [""]
  resources: ["serviceaccounts"]
  verbs: ["get", "list"]
- apiGroups: ["argoproj.io"]
  resources: ["workflows", "workflows/finalizers", "workflowtasksets", "workflowtasksets/finalizers", "workflowartifactgctasks"]
  verbs: ["get", "list", "watch", "update", "patch", "delete", "create"]
- apiGroups: ["argoproj.io"]
  resources: ["workflowtemplates", "workflowtemplates/finalizers", "clusterworkflowtemplates", "clusterworkflowtemplates/finalizers"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["argoproj.io"]
  resources: ["cronworkflows", "cronworkflows/finalizers"]
  verbs: ["get", "list", "watch", "update", "patch", "delete"]
- apiGroups: [""]
  resources: ["events"]
  verbs: ["create", "patch"]
- apiGroups: ["policy"]
  resources: ["poddisruptionbudgets"]
  verbs: ["create", "get", "delete"]
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: default-workflow-runner
  namespace: production
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/argo-workflow-runner
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: workflow-runner
  namespace: production
rules:
- apiGroups: [""]
  resources: ["pods", "pods/log"]
  verbs: ["get", "watch", "list", "delete"]
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["get"]
- apiGroups: ["argoproj.io"]
  resources: ["workflows"]
  verbs: ["get", "watch", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: workflow-runner
  namespace: production
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: workflow-runner
subjects:
- kind: ServiceAccount
  name: default-workflow-runner
  namespace: production
```

## Basic Workflow Patterns

### Sequential Steps

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  name: data-pipeline-sequential
  namespace: production
spec:
  entrypoint: data-pipeline
  serviceAccountName: default-workflow-runner

  # Workflow-level arguments
  arguments:
    parameters:
    - name: input-date
      value: "2027-10-27"
    - name: environment
      value: "production"

  templates:
  - name: data-pipeline
    steps:
    - - name: extract
        template: run-extract
        arguments:
          parameters:
          - name: date
            value: "{{workflow.parameters.input-date}}"
    - - name: transform
        template: run-transform
        arguments:
          parameters:
          - name: date
            value: "{{workflow.parameters.input-date}}"
          artifacts:
          - name: raw-data
            from: "{{steps.extract.outputs.artifacts.raw-data}}"
    - - name: load
        template: run-load
        arguments:
          parameters:
          - name: date
            value: "{{workflow.parameters.input-date}}"
          artifacts:
          - name: transformed-data
            from: "{{steps.transform.outputs.artifacts.transformed-data}}"

  - name: run-extract
    inputs:
      parameters:
      - name: date
    outputs:
      artifacts:
      - name: raw-data
        path: /data/output/raw
        s3:
          bucket: argo-artifacts
          key: "workflows/{{workflow.name}}/raw-data.tar.gz"
    container:
      image: registry.company.com/data-extractor:v1.4.2
      command: [python, extract.py]
      args:
      - --date={{inputs.parameters.date}}
      - --output=/data/output/raw
      resources:
        requests:
          cpu: 500m
          memory: 2Gi
        limits:
          cpu: 2000m
          memory: 8Gi
      env:
      - name: DATABASE_URL
        valueFrom:
          secretKeyRef:
            name: database-credentials
            key: url
      volumeMounts:
      - name: data-volume
        mountPath: /data

  - name: run-transform
    inputs:
      parameters:
      - name: date
      artifacts:
      - name: raw-data
        path: /data/input
        s3:
          bucket: argo-artifacts
          key: "workflows/{{workflow.name}}/raw-data.tar.gz"
    outputs:
      artifacts:
      - name: transformed-data
        path: /data/output
        s3:
          bucket: argo-artifacts
          key: "workflows/{{workflow.name}}/transformed-data.tar.gz"
    container:
      image: registry.company.com/data-transformer:v2.1.0
      command: [python, transform.py]
      args:
      - --input=/data/input
      - --output=/data/output
      - --date={{inputs.parameters.date}}
      resources:
        requests:
          cpu: 1000m
          memory: 4Gi
        limits:
          cpu: 4000m
          memory: 16Gi

  - name: run-load
    inputs:
      parameters:
      - name: date
      artifacts:
      - name: transformed-data
        path: /data/transformed
        s3:
          bucket: argo-artifacts
          key: "workflows/{{workflow.name}}/transformed-data.tar.gz"
    container:
      image: registry.company.com/data-loader:v1.2.0
      command: [python, load.py]
      args:
      - --input=/data/transformed
      - --date={{inputs.parameters.date}}
      - --target=production-warehouse
      resources:
        requests:
          cpu: 200m
          memory: 512Mi
        limits:
          cpu: 1000m
          memory: 2Gi

  volumeClaimTemplates:
  - metadata:
      name: data-volume
    spec:
      accessModes: ["ReadWriteOnce"]
      resources:
        requests:
          storage: 50Gi
      storageClassName: fast-ssd
```

### DAG Workflows

DAG (Directed Acyclic Graph) templates allow declaring task dependencies explicitly, enabling maximum parallelism:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: ml-training-pipeline
  namespace: production
spec:
  entrypoint: ml-pipeline
  serviceAccountName: default-workflow-runner

  templates:
  - name: ml-pipeline
    dag:
      tasks:
      # Data preparation runs first
      - name: prepare-training-data
        template: prepare-data
        arguments:
          parameters:
          - name: dataset-version
            value: "{{workflow.parameters.dataset-version}}"

      # Feature engineering runs after data preparation
      - name: engineer-features
        template: feature-engineering
        dependencies: [prepare-training-data]
        arguments:
          artifacts:
          - name: raw-data
            from: "{{tasks.prepare-training-data.outputs.artifacts.dataset}}"

      # Two models train in parallel after feature engineering
      - name: train-model-a
        template: train-model
        dependencies: [engineer-features]
        arguments:
          parameters:
          - name: model-type
            value: "gradient-boost"
          artifacts:
          - name: features
            from: "{{tasks.engineer-features.outputs.artifacts.features}}"

      - name: train-model-b
        template: train-model
        dependencies: [engineer-features]
        arguments:
          parameters:
          - name: model-type
            value: "neural-network"
          artifacts:
          - name: features
            from: "{{tasks.engineer-features.outputs.artifacts.features}}"

      # Evaluation runs after both models complete
      - name: evaluate-models
        template: evaluate
        dependencies: [train-model-a, train-model-b]
        arguments:
          artifacts:
          - name: model-a
            from: "{{tasks.train-model-a.outputs.artifacts.model}}"
          - name: model-b
            from: "{{tasks.train-model-b.outputs.artifacts.model}}"

      # Deploy only the winning model
      - name: deploy-winner
        template: deploy-model
        dependencies: [evaluate-models]
        arguments:
          parameters:
          - name: winning-model
            value: "{{tasks.evaluate-models.outputs.parameters.winner}}"
          artifacts:
          - name: model
            from: "{{tasks.evaluate-models.outputs.artifacts.winning-model}}"

  - name: prepare-data
    inputs:
      parameters:
      - name: dataset-version
    outputs:
      artifacts:
      - name: dataset
        path: /data/output
        s3:
          bucket: argo-artifacts
          key: "ml-pipeline/{{workflow.name}}/dataset.tar.gz"
    container:
      image: registry.company.com/ml-pipeline/data-prep:v3.0.0
      resources:
        requests:
          cpu: 2000m
          memory: 8Gi

  - name: feature-engineering
    inputs:
      artifacts:
      - name: raw-data
        path: /data/input
    outputs:
      artifacts:
      - name: features
        path: /data/features
        s3:
          bucket: argo-artifacts
          key: "ml-pipeline/{{workflow.name}}/features.parquet"
    container:
      image: registry.company.com/ml-pipeline/feature-eng:v2.1.0
      resources:
        requests:
          cpu: 4000m
          memory: 16Gi
        limits:
          cpu: 8000m
          memory: 32Gi

  - name: train-model
    inputs:
      parameters:
      - name: model-type
      artifacts:
      - name: features
        path: /data/features
    outputs:
      parameters:
      - name: validation-accuracy
        valueFrom:
          path: /tmp/accuracy.txt
      artifacts:
      - name: model
        path: /models/output
        s3:
          bucket: argo-artifacts
          key: "ml-pipeline/{{workflow.name}}/model-{{inputs.parameters.model-type}}.pkl"
    container:
      image: registry.company.com/ml-pipeline/trainer:v4.0.0
      command: [python, train.py]
      args:
      - --model-type={{inputs.parameters.model-type}}
      - --features=/data/features
      - --output=/models/output
      - --accuracy-output=/tmp/accuracy.txt
      resources:
        requests:
          cpu: 8000m
          memory: 32Gi
          nvidia.com/gpu: "1"
        limits:
          cpu: 16000m
          memory: 64Gi
          nvidia.com/gpu: "1"
      tolerations:
      - key: "nvidia.com/gpu"
        operator: "Exists"
        effect: "NoSchedule"

  - name: evaluate
    inputs:
      artifacts:
      - name: model-a
        path: /models/model-a
      - name: model-b
        path: /models/model-b
    outputs:
      parameters:
      - name: winner
        valueFrom:
          path: /tmp/winner.txt
      artifacts:
      - name: winning-model
        path: /models/winner
        s3:
          bucket: argo-artifacts
          key: "ml-pipeline/{{workflow.name}}/winning-model.pkl"
    container:
      image: registry.company.com/ml-pipeline/evaluator:v1.5.0

  - name: deploy-model
    inputs:
      parameters:
      - name: winning-model
      artifacts:
      - name: model
        path: /models/deploy
    container:
      image: registry.company.com/ml-pipeline/deployer:v2.0.0
      command: [python, deploy.py]
      args:
      - --model=/models/deploy
      - --environment=production
      - --model-name={{inputs.parameters.winning-model}}
```

## Workflow Templates for Reuse

`WorkflowTemplate` resources define reusable workflow components that can be referenced from other workflows:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: common-tasks
  namespace: production
spec:
  templates:
  # Reusable container build step
  - name: build-and-push-image
    inputs:
      parameters:
      - name: image-name
      - name: image-tag
      - name: dockerfile-path
        value: "Dockerfile"
    container:
      image: gcr.io/kaniko-project/executor:v1.18.0
      command: [/kaniko/executor]
      args:
      - --context=/workspace
      - --dockerfile=/workspace/{{inputs.parameters.dockerfile-path}}
      - --destination=registry.company.com/{{inputs.parameters.image-name}}:{{inputs.parameters.image-tag}}
      - --cache=true
      - --cache-repo=registry.company.com/{{inputs.parameters.image-name}}-cache
      volumeMounts:
      - name: kaniko-secret
        mountPath: /kaniko/.docker
      - name: workspace
        mountPath: /workspace
    volumes:
    - name: kaniko-secret
      secret:
        secretName: registry-credentials
        items:
        - key: .dockerconfigjson
          path: config.json
    - name: workspace
      emptyDir: {}

  # Reusable notification step
  - name: slack-notification
    inputs:
      parameters:
      - name: message
      - name: channel
        value: "#deployments"
      - name: color
        value: "good"
    container:
      image: curlimages/curl:8.5.0
      command: [sh, -c]
      args:
      - |
        curl -X POST -H 'Content-type: application/json' \
          --data "{\"channel\":\"{{inputs.parameters.channel}}\",\"attachments\":[{\"color\":\"{{inputs.parameters.color}}\",\"text\":\"{{inputs.parameters.message}}\"}]}" \
          $SLACK_WEBHOOK_URL
      env:
      - name: SLACK_WEBHOOK_URL
        valueFrom:
          secretKeyRef:
            name: slack-secret
            key: webhook-url

  # Reusable database backup step
  - name: postgres-backup
    inputs:
      parameters:
      - name: database-name
      - name: backup-prefix
    outputs:
      artifacts:
      - name: backup
        path: /backups/{{inputs.parameters.database-name}}.pgdump
        s3:
          bucket: company-database-backups
          key: "{{inputs.parameters.backup-prefix}}/{{inputs.parameters.database-name}}-{{workflow.creationTimestamp.Y}}{{workflow.creationTimestamp.m}}{{workflow.creationTimestamp.d}}.pgdump"
    container:
      image: postgres:16-alpine
      command: [pg_dump]
      args:
      - --file=/backups/{{inputs.parameters.database-name}}.pgdump
      - --format=custom
      - --compress=9
      - "{{inputs.parameters.database-name}}"
      env:
      - name: PGHOST
        valueFrom:
          secretKeyRef:
            name: postgres-credentials
            key: host
      - name: PGUSER
        valueFrom:
          secretKeyRef:
            name: postgres-credentials
            key: username
      - name: PGPASSWORD
        valueFrom:
          secretKeyRef:
            name: postgres-credentials
            key: password
```

Reference from another workflow:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  name: nightly-backup
spec:
  entrypoint: backup-pipeline
  templates:
  - name: backup-pipeline
    steps:
    - - name: backup-users
        templateRef:
          name: common-tasks
          template: postgres-backup
        arguments:
          parameters:
          - name: database-name
            value: users_db
          - name: backup-prefix
            value: nightly
      - name: backup-orders
        templateRef:
          name: common-tasks
          template: postgres-backup
        arguments:
          parameters:
          - name: database-name
            value: orders_db
          - name: backup-prefix
            value: nightly
    - - name: notify-success
        templateRef:
          name: common-tasks
          template: slack-notification
        arguments:
          parameters:
          - name: message
            value: "Nightly backup completed successfully"
          - name: channel
            value: "#ops-alerts"
```

## CronWorkflows

For scheduled workflows, use `CronWorkflow` resources:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: CronWorkflow
metadata:
  name: daily-etl-pipeline
  namespace: production
spec:
  schedule: "0 2 * * *"
  timezone: "America/New_York"
  startingDeadlineSeconds: 3600
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 7
  failedJobsHistoryLimit: 7
  suspend: false
  workflowSpec:
    entrypoint: etl-pipeline
    serviceAccountName: default-workflow-runner
    arguments:
      parameters:
      - name: run-date
        value: "{{= toDate(\"2006-01-02\", \"2027-10-27\") | date(\"2006-01-02\") }}"
    templates:
    - name: etl-pipeline
      steps:
      - - name: extract-data
          template: extract
      - - name: transform-data
          template: transform
      - - name: load-data
          template: load
    - name: extract
      container:
        image: registry.company.com/etl/extractor:v3.2.0
    - name: transform
      container:
        image: registry.company.com/etl/transformer:v2.5.0
    - name: load
      container:
        image: registry.company.com/etl/loader:v1.8.0
```

## Parallelism and Fan-Out

For processing many items in parallel, use the `withItems` or `withParam` feature:

```yaml
  - name: process-all-regions
    steps:
    - - name: process-region
        template: process-single-region
        arguments:
          parameters:
          - name: region
            value: "{{item}}"
        withItems:
        - us-east-1
        - us-west-2
        - eu-west-1
        - ap-southeast-1
        - ap-northeast-1

  - name: dynamic-fan-out
    steps:
    - - name: get-items
        template: list-items
    - - name: process-each
        template: process-item
        arguments:
          parameters:
          - name: item-id
            value: "{{item.id}}"
          - name: item-type
            value: "{{item.type}}"
        withParam: "{{steps.get-items.outputs.result}}"
```

Control maximum parallelism to avoid overwhelming downstream systems:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  name: batch-processor
spec:
  entrypoint: main
  # Global parallelism limit
  parallelism: 10
  templates:
  - name: main
    # Step-level parallelism limit
    parallelism: 5
    steps:
    - - name: process
        template: process-item
        withParam: "{{inputs.parameters.items}}"
```

## Resource Templates

Resource templates allow workflows to create arbitrary Kubernetes resources and wait for them to complete:

```yaml
  - name: create-spark-job
    resource:
      action: create
      manifest: |
        apiVersion: sparkoperator.k8s.io/v1beta2
        kind: SparkApplication
        metadata:
          name: spark-etl-{{workflow.name}}
          namespace: spark
        spec:
          type: Python
          pythonVersion: "3"
          mode: cluster
          image: registry.company.com/spark-etl:v2.0.0
          imagePullPolicy: Always
          mainApplicationFile: local:///app/etl_job.py
          sparkVersion: "3.5.0"
          restartPolicy:
            type: OnFailure
            onFailureRetries: 2
          driver:
            cores: 1
            coreLimit: "1200m"
            memory: "4g"
            serviceAccount: spark-driver
          executor:
            cores: 2
            instances: 5
            memory: "8g"
      successCondition: status.applicationState.state == COMPLETED
      failureCondition: status.applicationState.state == FAILED
```

## Workflow Archiving

For long-term storage and analytics of workflow history, configure PostgreSQL archiving:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: workflow-controller-configmap
  namespace: argo
data:
  config: |
    persistence:
      connectionPool:
        maxIdleConns: 100
        maxOpenConns: 0
        connMaxLifetime: 0s
      nodeStatusOffload: true
      archive: true
      archiveTTL: 180d
      postgresql:
        host: postgresql.storage.svc.cluster.local
        port: 5432
        database: argo_workflows
        tableName: argo_archived_workflows
        ssl:
          enabled: true
        usernameSecret:
          name: argo-postgres-secret
          key: username
        passwordSecret:
          name: argo-postgres-secret
          key: password
```

Query archived workflows:

```bash
# Via CLI
argo list --archived --since 7d --namespace production

# Via UI
# Navigate to Archived Workflows section in the Argo UI

# Direct database query
psql -h postgresql.storage.svc.cluster.local -U argo argo_workflows \
  -c "SELECT name, namespace, phase, started_at, finished_at FROM argo_archived_workflows WHERE phase='Failed' AND started_at > NOW() - INTERVAL '7 days' ORDER BY started_at DESC;"
```

## Production Operations

### Workflow Resource Management

Set workflow-level defaults to prevent runaway resource consumption:

```yaml
workflowDefaults:
  spec:
    activeDeadlineSeconds: 86400
    ttlStrategy:
      secondsAfterCompletion: 86400
      secondsAfterSuccess: 43200
      secondsAfterFailure: 604800
    podGC:
      strategy: OnWorkflowCompletion
      deleteDelayDuration: 5s
    securityContext:
      runAsNonRoot: true
      runAsUser: 8737
    tolerations: []
    affinity:
      nodeAffinity:
        preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 1
          preference:
            matchExpressions:
            - key: workload-type
              operator: In
              values:
              - batch
```

### Monitoring

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: argo-workflows-alerts
  namespace: monitoring
spec:
  groups:
  - name: argo-workflows
    rules:
    - alert: ArgoWorkflowFailed
      expr: argo_workflows_count{phase="Failed"} > 0
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Argo workflow failures detected"
        description: "{{ $value }} workflows are in Failed state in namespace {{ $labels.namespace }}"

    - alert: ArgoWorkflowRunningTooLong
      expr: argo_workflows_count{phase="Running"} > 0 and (time() - argo_workflow_start_time) > 14400
      for: 1m
      labels:
        severity: warning
      annotations:
        summary: "Workflow running for over 4 hours"
        description: "Workflow {{ $labels.name }} has been running for over 4 hours"

    - alert: ArgoWorkflowControllerDown
      expr: absent(up{app="argo-workflows-workflow-controller"}) or up{app="argo-workflows-workflow-controller"} == 0
      for: 2m
      labels:
        severity: critical
      annotations:
        summary: "Argo Workflow controller is down"
```

## Conclusion

Argo Workflows provides a powerful, production-ready workflow orchestration platform that leverages Kubernetes primitives for execution isolation, resource management, and scalability. The combination of DAG-based task dependencies, artifact passing, and WorkflowTemplate reuse enables complex multi-step pipelines while maintaining operational clarity.

For production deployments, invest time in configuring proper artifact repository settings, workflow archiving for history retention, and resource defaults that prevent runaway workflows from consuming cluster capacity. With these foundations in place, Argo Workflows scales effectively from simple sequential jobs to complex ML training pipelines involving dozens of parallel tasks and terabytes of intermediate data.
