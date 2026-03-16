---
title: "Jenkins X Cloud Native CI/CD: Kubernetes-Native Pipeline Automation at Scale"
date: 2026-08-15T00:00:00-05:00
draft: false
tags: ["Jenkins X", "CI/CD", "Kubernetes", "Tekton", "GitOps", "Cloud Native", "DevOps"]
categories: ["CI/CD", "Kubernetes", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Master Jenkins X for cloud-native CI/CD on Kubernetes. Learn automated environment promotion, preview environments, GitOps workflows, and enterprise-scale pipeline orchestration with Tekton integration."
more_link: "yes"
url: "/jenkins-x-cloud-native-cicd-kubernetes/"
---

Jenkins X revolutionizes cloud-native CI/CD by providing opinionated, automated pipelines built on Kubernetes and Tekton. This comprehensive guide explores Jenkins X architecture, automated promotion strategies, preview environments, GitOps workflows, and production-scale implementations for enterprise Kubernetes platforms.

<!--more-->

# Jenkins X Cloud Native CI/CD: Kubernetes-Native Pipeline Automation at Scale

## Executive Summary

Jenkins X provides a complete CI/CD platform designed specifically for Kubernetes, featuring automated environment promotion, pull request preview environments, GitOps-based deployment, and tight integration with cloud-native technologies. This guide covers Jenkins X 3.x architecture, pipeline configuration, environment management, and enterprise deployment patterns that enable teams to ship code faster with built-in best practices.

## Jenkins X Architecture

### Core Components

Jenkins X 3.x is built on a modular architecture:

```yaml
# Jenkins X 3.x installation using GitOps
apiVersion: v1
kind: Namespace
metadata:
  name: jx
---
# Install jx-git-operator for GitOps
apiVersion: apps/v1
kind: Deployment
metadata:
  name: jx-git-operator
  namespace: jx
spec:
  replicas: 1
  selector:
    matchLabels:
      app: jx-git-operator
  template:
    metadata:
      labels:
        app: jx-git-operator
    spec:
      serviceAccountName: jx-git-operator
      containers:
      - name: jx-git-operator
        image: ghcr.io/jenkins-x/jx-git-operator:0.7.0
        args:
        - --git-url=https://github.com/example/jx3-cluster-repo
        - --git-kind=github
        - --namespace=jx
        env:
        - name: GIT_TOKEN
          valueFrom:
            secretKeyRef:
              name: jx-git-operator
              key: token
        - name: GIT_USERNAME
          valueFrom:
            secretKeyRef:
              name: jx-git-operator
              key: username
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
---
# Lighthouse - webhook handler and ChatOps
apiVersion: apps/v1
kind: Deployment
metadata:
  name: lighthouse-webhooks
  namespace: jx
spec:
  replicas: 2
  selector:
    matchLabels:
      app: lighthouse-webhooks
  template:
    metadata:
      labels:
        app: lighthouse-webhooks
    spec:
      serviceAccountName: lighthouse-webhooks
      containers:
      - name: lighthouse-webhooks
        image: ghcr.io/jenkins-x/lighthouse-webhooks:1.7.0
        ports:
        - containerPort: 8080
          name: http
        env:
        - name: GIT_KIND
          value: "github"
        - name: GIT_SERVER
          value: "https://github.com"
        - name: HMAC_TOKEN
          valueFrom:
            secretKeyRef:
              name: lighthouse-hmac-token
              key: hmac
        resources:
          requests:
            cpu: 100m
            memory: 256Mi
          limits:
            cpu: 500m
            memory: 512Mi
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 60
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 5
---
# Lighthouse Foghorn - event broadcaster
apiVersion: apps/v1
kind: Deployment
metadata:
  name: lighthouse-foghorn
  namespace: jx
spec:
  replicas: 1
  selector:
    matchLabels:
      app: lighthouse-foghorn
  template:
    metadata:
      labels:
        app: lighthouse-foghorn
    spec:
      serviceAccountName: lighthouse-foghorn
      containers:
      - name: lighthouse-foghorn
        image: ghcr.io/jenkins-x/lighthouse-foghorn:1.7.0
        env:
        - name: GIT_KIND
          value: "github"
        - name: GIT_SERVER
          value: "https://github.com"
        - name: GIT_TOKEN
          valueFrom:
            secretKeyRef:
              name: lighthouse-oauth-token
              key: oauth
        resources:
          requests:
            cpu: 50m
            memory: 128Mi
          limits:
            cpu: 200m
            memory: 256Mi
---
# Lighthouse Keeper - PR merge automation
apiVersion: apps/v1
kind: Deployment
metadata:
  name: lighthouse-keeper
  namespace: jx
spec:
  replicas: 1
  selector:
    matchLabels:
      app: lighthouse-keeper
  template:
    metadata:
      labels:
        app: lighthouse-keeper
    spec:
      serviceAccountName: lighthouse-keeper
      containers:
      - name: lighthouse-keeper
        image: ghcr.io/jenkins-x/lighthouse-keeper:1.7.0
        args:
        - --dry-run=false
        env:
        - name: GIT_KIND
          value: "github"
        - name: GIT_SERVER
          value: "https://github.com"
        - name: GIT_TOKEN
          valueFrom:
            secretKeyRef:
              name: lighthouse-oauth-token
              key: oauth
        resources:
          requests:
            cpu: 100m
            memory: 256Mi
          limits:
            cpu: 500m
            memory: 512Mi
---
# Tekton Dashboard for pipeline visualization
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tekton-dashboard
  namespace: jx
spec:
  replicas: 1
  selector:
    matchLabels:
      app: tekton-dashboard
  template:
    metadata:
      labels:
        app: tekton-dashboard
    spec:
      serviceAccountName: tekton-dashboard
      containers:
      - name: tekton-dashboard
        image: gcr.io/tekton-releases/github.com/tektoncd/dashboard/cmd/dashboard:v0.40.0
        ports:
        - containerPort: 9097
          name: http
        livenessProbe:
          httpGet:
            path: /health
            port: 9097
        readinessProbe:
          httpGet:
            path: /readiness
            port: 9097
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
```

### GitOps Repository Structure

```
jx3-cluster-repo/
├── .jx/
│   ├── git-operator/
│   │   ├── job.yaml
│   │   └── resources.yaml
│   └── secret/
│       └── mapping/
│           └── secret-mappings.yaml
├── config-root/
│   ├── namespaces/
│   │   ├── jx/
│   │   │   ├── lighthouse/
│   │   │   ├── tekton-pipelines/
│   │   │   └── source-repositories/
│   │   ├── jx-staging/
│   │   └── jx-production/
│   └── cluster/
│       └── resources/
├── versionStream/
│   ├── charts/
│   ├── docker/
│   └── packages/
├── helmfiles/
│   ├── jx/
│   │   └── helmfile.yaml
│   └── tekton-pipelines/
│       └── helmfile.yaml
└── jx-requirements.yml
```

## Pipeline Configuration

### Automated Pipeline Detection

Jenkins X automatically creates pipelines based on `.lighthouse` directory:

```yaml
# .lighthouse/jenkins-x/pullrequest.yaml
apiVersion: tekton.dev/v1beta1
kind: PipelineRun
metadata:
  name: pullrequest
spec:
  pipelineSpec:
    tasks:
    # Checkout source code
    - name: from-build-pack
      taskRef:
        name: git-clone
        kind: Task
      params:
      - name: url
        value: $(params.repo_url)
      - name: revision
        value: $(params.pull_pull_sha)
      workspaces:
      - name: output
        workspace: source

    # Build and test
    - name: build
      runAfter:
      - from-build-pack
      taskSpec:
        workspaces:
        - name: source
        stepTemplate:
          name: ""
          resources:
            requests:
              cpu: 400m
              memory: 512Mi
            limits:
              cpu: 2
              memory: 4Gi
          volumeMounts:
          - name: maven-settings
            mountPath: /root/.m2
          - name: npm-cache
            mountPath: /root/.npm
        steps:
        # Run tests
        - name: test
          image: maven:3.8-openjdk-17
          script: |
            #!/bin/bash
            set -e
            cd /workspace/source
            mvn clean test

        # Code quality analysis
        - name: sonar-scan
          image: sonarsource/sonar-scanner-cli:latest
          env:
          - name: SONAR_TOKEN
            valueFrom:
              secretKeyRef:
                name: sonar-token
                key: token
          script: |
            #!/bin/bash
            set -e
            cd /workspace/source
            sonar-scanner \
              -Dsonar.projectKey=$(params.repo_name) \
              -Dsonar.sources=src/main \
              -Dsonar.host.url=https://sonar.example.com \
              -Dsonar.login=$SONAR_TOKEN

        # Build application
        - name: build-app
          image: maven:3.8-openjdk-17
          script: |
            #!/bin/bash
            set -e
            cd /workspace/source
            mvn clean package -DskipTests

        # Build container image
        - name: build-container
          image: gcr.io/kaniko-project/executor:v1.19.0
          env:
          - name: DOCKER_CONFIG
            value: /tekton/home/.docker
          script: |
            #!/busybox/sh
            set -e
            cd /workspace/source
            /kaniko/executor \
              --dockerfile=Dockerfile \
              --context=/workspace/source \
              --destination=gcr.io/my-project/$(params.repo_name):$(params.version) \
              --cache=true \
              --cache-ttl=24h \
              --snapshot-mode=redo

        volumes:
        - name: maven-settings
          emptyDir: {}
        - name: npm-cache
          emptyDir: {}

    # Security scanning
    - name: security-scan
      runAfter:
      - build
      taskSpec:
        workspaces:
        - name: source
        steps:
        - name: trivy-scan
          image: aquasec/trivy:latest
          script: |
            #!/bin/sh
            set -e
            trivy image \
              --severity HIGH,CRITICAL \
              --exit-code 1 \
              gcr.io/my-project/$(params.repo_name):$(params.version)

    # Deploy to preview environment
    - name: preview
      runAfter:
      - security-scan
      taskRef:
        name: jx-preview
        kind: Task
      params:
      - name: version
        value: $(params.version)
      workspaces:
      - name: source
        workspace: source

  workspaces:
  - name: source
    volumeClaimTemplate:
      spec:
        accessModes:
        - ReadWriteOnce
        resources:
          requests:
            storage: 10Gi
```

### Release Pipeline

```yaml
# .lighthouse/jenkins-x/release.yaml
apiVersion: tekton.dev/v1beta1
kind: PipelineRun
metadata:
  name: release
spec:
  pipelineSpec:
    tasks:
    # Checkout and version
    - name: from-build-pack
      taskRef:
        name: git-clone
      params:
      - name: url
        value: $(params.repo_url)
      - name: revision
        value: $(params.pull_base_sha)
      workspaces:
      - name: output
        workspace: source

    # Calculate next version
    - name: next-version
      runAfter:
      - from-build-pack
      taskSpec:
        workspaces:
        - name: source
        results:
        - name: version
          description: The next semantic version
        steps:
        - name: calculate-version
          image: ghcr.io/jenkins-x/jx-release-version:2.7.0
          script: |
            #!/bin/sh
            set -e
            cd /workspace/source
            VERSION=$(jx-release-version)
            echo -n $VERSION > $(results.version.path)
            echo "Next version: $VERSION"

    # Build and push
    - name: build-container-build
      runAfter:
      - next-version
      taskSpec:
        params:
        - name: version
        workspaces:
        - name: source
        steps:
        - name: build-and-push
          image: gcr.io/kaniko-project/executor:v1.19.0
          env:
          - name: DOCKER_CONFIG
            value: /tekton/home/.docker
          script: |
            #!/busybox/sh
            set -e
            cd /workspace/source
            /kaniko/executor \
              --dockerfile=Dockerfile \
              --context=/workspace/source \
              --destination=gcr.io/my-project/$(params.repo_name):$(params.version) \
              --destination=gcr.io/my-project/$(params.repo_name):latest \
              --cache=true \
              --snapshot-mode=redo \
              --build-arg VERSION=$(params.version)
      params:
      - name: version
        value: $(tasks.next-version.results.version)
      workspaces:
      - name: source
        workspace: source

    # Create and push git tag
    - name: create-tag
      runAfter:
      - build-container-build
      taskSpec:
        params:
        - name: version
        workspaces:
        - name: source
        steps:
        - name: git-tag
          image: gcr.io/jenkinsxio/jx-cli-base:0.0.43
          env:
          - name: GIT_TOKEN
            valueFrom:
              secretKeyRef:
                name: lighthouse-oauth-token
                key: oauth
          script: |
            #!/bin/sh
            set -e
            cd /workspace/source
            git config --global user.email "jenkins-x@example.com"
            git config --global user.name "Jenkins X"
            git tag -a "v$(params.version)" -m "Release version $(params.version)"
            git push https://jenkins-x:$GIT_TOKEN@github.com/$(params.repo_owner)/$(params.repo_name).git v$(params.version)
      params:
      - name: version
        value: $(tasks.next-version.results.version)
      workspaces:
      - name: source
        workspace: source

    # Update version in staging environment
    - name: promote-to-staging
      runAfter:
      - create-tag
      taskRef:
        name: jx-promote
      params:
      - name: version
        value: $(tasks.next-version.results.version)
      - name: environment
        value: staging
      workspaces:
      - name: source
        workspace: source

  workspaces:
  - name: source
    volumeClaimTemplate:
      spec:
        accessModes:
        - ReadWriteOnce
        resources:
          requests:
            storage: 10Gi
```

## Preview Environments

### Automatic PR Preview Creation

```yaml
# Preview environment configuration
apiVersion: preview.jenkins.io/v1alpha1
kind: Preview
metadata:
  name: pr-123
  namespace: jx
spec:
  pullRequest:
    number: 123
    owner: example
    repository: myapp
    title: "Add new feature"
    url: https://github.com/example/myapp/pull/123
    user:
      username: developer
      name: Developer Name
  source:
    url: https://github.com/example/myapp
    ref: feature-branch
    clonePath: github.com/example/myapp
  resources:
    limits:
      cpu: "1"
      memory: 1Gi
    requests:
      cpu: 100m
      memory: 128Mi
---
# Helmfile for preview environment
# preview/helmfile.yaml
repositories:
- name: dev
  url: https://storage.googleapis.com/chartmuseum.jenkins-x.io

releases:
- name: preview
  chart: dev/myapp
  values:
  - values.yaml
  - jx-values.yaml
  namespace: jx-preview-pr-123
  createNamespace: true
  wait: true
  timeout: 600
  hooks:
  - events: ["prepare"]
    command: "jx"
    args:
    - "gitops"
    - "helmfile"
    - "add"
    - "--chart"
    - "dev/myapp"
  set:
  - name: image.repository
    value: gcr.io/my-project/myapp
  - name: image.tag
    value: PR-123-${VERSION}
  - name: ingress.enabled
    value: "true"
  - name: ingress.hosts[0].host
    value: pr-123.preview.example.com
  - name: ingress.hosts[0].paths[0].path
    value: /
  - name: resources.limits.cpu
    value: "1"
  - name: resources.limits.memory
    value: 1Gi
  - name: resources.requests.cpu
    value: 100m
  - name: resources.requests.memory
    value: 128Mi
```

### Preview Environment Cleanup

```yaml
# Automatic preview cleanup after PR merge
apiVersion: batch/v1
kind: CronJob
metadata:
  name: preview-cleanup
  namespace: jx
spec:
  schedule: "0 */4 * * *"
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: preview-cleanup
          containers:
          - name: cleanup
            image: gcr.io/jenkinsxio/jx-cli-base:0.0.43
            command:
            - /bin/sh
            - -c
            - |
              #!/bin/sh
              set -e

              # Find closed PRs
              for preview in $(kubectl get preview -n jx -o name); do
                PR_NUM=$(kubectl get $preview -n jx -o jsonpath='{.spec.pullRequest.number}')
                REPO=$(kubectl get $preview -n jx -o jsonpath='{.spec.pullRequest.repository}')
                OWNER=$(kubectl get $preview -n jx -o jsonpath='{.spec.pullRequest.owner}')

                # Check PR status
                PR_STATE=$(curl -s \
                  -H "Authorization: token $GIT_TOKEN" \
                  https://api.github.com/repos/$OWNER/$REPO/pulls/$PR_NUM \
                  | jq -r '.state')

                if [ "$PR_STATE" = "closed" ]; then
                  echo "Cleaning up preview for closed PR #$PR_NUM"

                  # Delete preview resource
                  kubectl delete $preview -n jx

                  # Delete preview namespace
                  NAMESPACE="jx-preview-pr-$PR_NUM"
                  kubectl delete namespace $NAMESPACE --wait=false

                  # Delete Helm release
                  helm delete preview -n $NAMESPACE || true
                fi
              done
            env:
            - name: GIT_TOKEN
              valueFrom:
                secretKeyRef:
                  name: lighthouse-oauth-token
                  key: oauth
          restartPolicy: OnFailure
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: preview-cleanup
  namespace: jx
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: preview-cleanup
rules:
- apiGroups: ["preview.jenkins.io"]
  resources: ["previews"]
  verbs: ["get", "list", "delete"]
- apiGroups: [""]
  resources: ["namespaces"]
  verbs: ["get", "list", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: preview-cleanup
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: preview-cleanup
subjects:
- kind: ServiceAccount
  name: preview-cleanup
  namespace: jx
```

## Environment Promotion

### Staging Environment Configuration

```yaml
# jx-requirements.yml
apiVersion: core.jenkins-x.io/v4beta1
kind: Requirements
spec:
  cluster:
    provider: gke
    projectID: my-gcp-project
    clusterName: jx-production
    environmentGitOwner: example
    zone: us-central1-a

  environments:
  - key: dev
    repository: dev-environment

  - key: staging
    repository: staging-environment
    promotionStrategy: Auto
    order: 100

  - key: production
    repository: production-environment
    promotionStrategy: Manual
    order: 200

  gitops: true
  webhook: lighthouse

  ingress:
    domain: example.com
    externalDNS: true
    namespaceSubDomain: -jx.
    tls:
      enabled: true
      production: true
      email: admin@example.com

  storage:
    logs:
      enabled: true
      url: gs://jx-logs-bucket
    reports:
      enabled: true
      url: gs://jx-reports-bucket
    repository:
      enabled: true
      url: gs://jx-repository-bucket
---
# Staging environment repository structure
# environments/jx-staging/
├── Chart.yaml
├── requirements.yaml
├── values.yaml
├── templates/
│   ├── myapp.yaml
│   └── namespace.yaml
└── Makefile
```

### Automatic Promotion to Staging

```yaml
# .lighthouse/jenkins-x/triggers.yaml
apiVersion: config.lighthouse.jenkins-x.io/v1alpha1
kind: TriggerConfig
spec:
  presubmits:
  # Pull request validation
  - name: pr-validation
    context: "pr-validation"
    always_run: true
    optional: false
    source: "pullrequest.yaml"

  postsubmits:
  # Automatic release and promotion
  - name: release
    context: "release"
    source: "release.yaml"
    branches:
    - ^main$
    - ^master$
```

### Manual Promotion to Production

```yaml
# Production promotion via jx CLI
# This creates a PR to production environment repository
---
apiVersion: promote.jenkins-x.io/v1alpha1
kind: Promote
metadata:
  name: promote-to-production
  namespace: jx
spec:
  application: myapp
  version: 1.2.3
  environment: production
  pullRequest:
    title: "Promote myapp to version 1.2.3"
    body: |
      # Promote myapp to Production

      This PR promotes myapp to version 1.2.3

      ## Changes
      - Feature A
      - Bug fix B
      - Performance improvement C

      ## Testing
      - [x] Staging tests passed
      - [x] Load tests passed
      - [x] Security scan passed

      ## Rollback Plan
      Previous version: 1.2.2
      Rollback command: `jx promote myapp --version 1.2.2 --env production`
    labels:
    - promotion
    - production
    assignees:
    - production-team
```

## ChatOps Integration

### Lighthouse ChatOps Commands

```yaml
# .lighthouse/jenkins-x/chatops.yaml
apiVersion: config.lighthouse.jenkins-x.io/v1alpha1
kind: Plugins
spec:
  plugins:
    example/myapp:
    - approve
    - assign
    - blunderbuss
    - help
    - hold
    - lgtm
    - lifecycle
    - override
    - size
    - trigger
    - wip
    - heart
    - cat
    - dog

  approve:
  - repos:
    - example/myapp
    require_self_approval: false
    lgtm_acts_as_approve: true
    ignore_review_state: false

  lgtm:
  - repos:
    - example/myapp
    review_acts_as_lgtm: true

  # Custom commands
  external_plugins:
    example/myapp:
    - name: jira
      endpoint: http://jira-plugin.jx.svc.cluster.local
      events:
      - pull_request
      - issue_comment
---
# Example ChatOps interactions:

# /lgtm - Add LGTM label
# /approve - Approve PR for merge
# /hold - Prevent automatic merge
# /hold cancel - Remove hold
# /assign @user - Assign PR to user
# /cc @user - Request review from user
# /retest - Rerun failed tests
# /test all - Run all tests
# /test integration - Run specific test
# /jx promote --env production - Promote to production
```

## Multi-Cluster Management

### Cluster Registration

```yaml
# Register additional clusters
apiVersion: v1
kind: Secret
metadata:
  name: remote-cluster-staging
  namespace: jx
  labels:
    jenkins.io/kind: Environment
    jenkins.io/environment: staging
type: Opaque
stringData:
  kubeconfig: |
    apiVersion: v1
    kind: Config
    clusters:
    - name: staging-cluster
      cluster:
        server: https://staging.k8s.example.com
        certificate-authority-data: <base64-ca-cert>
    contexts:
    - name: staging-context
      context:
        cluster: staging-cluster
        user: jx-user
        namespace: jx-staging
    current-context: staging-context
    users:
    - name: jx-user
      user:
        token: <service-account-token>
---
# Remote environment configuration
apiVersion: jenkins.io/v1
kind: Environment
metadata:
  name: staging
  namespace: jx
spec:
  kind: Permanent
  label: Staging
  namespace: jx-staging
  promotionStrategy: Auto
  order: 100
  source:
    url: https://github.com/example/staging-environment
    ref: master
  remoteCluster: true
```

### Cross-Cluster Promotion

```yaml
# .jx/gitops/source-config.yaml
apiVersion: gitops.jenkins-x.io/v1alpha1
kind: SourceConfig
metadata:
  name: source-config
spec:
  groups:
  - owner: example
    provider: https://github.com
    providerKind: github
    repositories:
    - name: myapp
      scheduler: in-repo

  # Scheduler for multi-cluster promotion
  scheduler: multi-cluster-scheduler
---
apiVersion: batch/v1
kind: Job
metadata:
  name: promote-multi-cluster
  namespace: jx
spec:
  template:
    spec:
      serviceAccountName: jx-promote
      containers:
      - name: promote
        image: gcr.io/jenkinsxio/jx-cli-base:0.0.43
        command:
        - /bin/sh
        - -c
        - |
          #!/bin/sh
          set -e

          APP_NAME=${APP_NAME}
          VERSION=${VERSION}

          # Promote to staging cluster
          echo "Promoting $APP_NAME:$VERSION to staging"
          jx promote $APP_NAME \
            --version $VERSION \
            --env staging \
            --cluster staging-cluster

          # Wait for staging health check
          echo "Waiting for staging deployment..."
          kubectl wait --for=condition=available \
            --timeout=600s \
            deployment/$APP_NAME \
            -n jx-staging \
            --kubeconfig=/secrets/staging/kubeconfig

          # Promote to production cluster (manual approval)
          echo "Creating production promotion PR"
          jx promote $APP_NAME \
            --version $VERSION \
            --env production \
            --cluster production-cluster \
            --no-wait
        env:
        - name: APP_NAME
          value: myapp
        - name: VERSION
          value: "1.2.3"
        volumeMounts:
        - name: staging-kubeconfig
          mountPath: /secrets/staging
          readOnly: true
        - name: production-kubeconfig
          mountPath: /secrets/production
          readOnly: true
      volumes:
      - name: staging-kubeconfig
        secret:
          secretName: remote-cluster-staging
      - name: production-kubeconfig
        secret:
          secretName: remote-cluster-production
      restartPolicy: OnFailure
```

## Observability and Monitoring

### Pipeline Metrics

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: jenkins-x-dashboard
  namespace: jx
data:
  dashboard.json: |
    {
      "dashboard": {
        "title": "Jenkins X Pipeline Metrics",
        "panels": [
          {
            "title": "Pipeline Success Rate",
            "targets": [
              {
                "expr": "sum(rate(pipelinerun_duration_seconds_count{status=\"succeeded\"}[5m])) / sum(rate(pipelinerun_duration_seconds_count[5m])) * 100"
              }
            ]
          },
          {
            "title": "Pipeline Duration (P95)",
            "targets": [
              {
                "expr": "histogram_quantile(0.95, sum(rate(pipelinerun_duration_seconds_bucket[5m])) by (le))"
              }
            ]
          },
          {
            "title": "Active Pipelines",
            "targets": [
              {
                "expr": "count(pipelinerun_info{status=\"running\"})"
              }
            ]
          },
          {
            "title": "Preview Environments",
            "targets": [
              {
                "expr": "count(preview_info)"
              }
            ]
          },
          {
            "title": "Deployment Frequency",
            "targets": [
              {
                "expr": "sum(increase(promotion_count[1d]))"
              }
            ]
          },
          {
            "title": "Lead Time for Changes",
            "targets": [
              {
                "expr": "histogram_quantile(0.95, sum(rate(pr_merge_to_deploy_seconds_bucket[7d])) by (le)) / 3600"
              }
            ]
          }
        ]
      }
    }
```

### Alerting Configuration

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: jenkins-x-alerts
  namespace: jx
spec:
  groups:
  - name: jenkins-x
    interval: 30s
    rules:
    - alert: HighPipelineFailureRate
      expr: |
        sum(rate(pipelinerun_duration_seconds_count{status="failed"}[5m]))
        /
        sum(rate(pipelinerun_duration_seconds_count[5m]))
        > 0.2
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "High pipeline failure rate"
        description: "Pipeline failure rate is {{ $value | humanizePercentage }}"

    - alert: PipelineStuck
      expr: |
        time() - max(pipelinerun_start_time_seconds{status="running"})
        > 3600
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Pipeline stuck for over 1 hour"
        description: "Pipeline {{ $labels.pipeline }} has been running for over 1 hour"

    - alert: PreviewEnvironmentCreationFailed
      expr: |
        sum(increase(preview_creation_failed_total[5m])) > 0
      labels:
        severity: warning
      annotations:
        summary: "Preview environment creation failed"
        description: "Failed to create preview environment"

    - alert: PromotionFailed
      expr: |
        sum(increase(promotion_failed_total[5m])) > 0
      labels:
        severity: critical
      annotations:
        summary: "Promotion failed"
        description: "Failed to promote to {{ $labels.environment }}"
```

## Security and Compliance

### RBAC Configuration

```yaml
# Role for developers
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: jx-developer
  namespace: jx
rules:
# View pipelines and logs
- apiGroups: ["tekton.dev"]
  resources: ["pipelineruns", "taskruns", "pipelines", "tasks"]
  verbs: ["get", "list", "watch"]
# Manage preview environments
- apiGroups: ["preview.jenkins.io"]
  resources: ["previews"]
  verbs: ["get", "list", "create", "delete"]
# View environments
- apiGroups: ["jenkins.io"]
  resources: ["environments"]
  verbs: ["get", "list"]
---
# Role for CI/CD automation
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: jx-automation
rules:
# Manage Tekton resources
- apiGroups: ["tekton.dev"]
  resources: ["*"]
  verbs: ["*"]
# Manage environments
- apiGroups: ["jenkins.io"]
  resources: ["environments"]
  verbs: ["*"]
# Deploy applications
- apiGroups: ["apps"]
  resources: ["deployments", "statefulsets", "daemonsets"]
  verbs: ["get", "list", "create", "update", "patch", "delete"]
- apiGroups: [""]
  resources: ["services", "configmaps", "secrets"]
  verbs: ["get", "list", "create", "update", "patch", "delete"]
```

### Secret Management Integration

```yaml
# External Secrets integration
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: vault-backend
  namespace: jx
spec:
  provider:
    vault:
      server: "https://vault.example.com"
      path: "secret"
      version: "v2"
      auth:
        kubernetes:
          mountPath: "kubernetes"
          role: "jenkins-x"
          serviceAccountRef:
            name: external-secrets
---
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: pipeline-secrets
  namespace: jx
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: vault-backend
    kind: SecretStore
  target:
    name: pipeline-secrets
    creationPolicy: Owner
  data:
  - secretKey: github-token
    remoteRef:
      key: jenkins-x/github
      property: token
  - secretKey: docker-config
    remoteRef:
      key: jenkins-x/docker
      property: config.json
  - secretKey: npm-token
    remoteRef:
      key: jenkins-x/npm
      property: token
```

## Best Practices

### Pipeline Optimization

1. **Caching**: Implement build caching for dependencies and artifacts
2. **Parallel Execution**: Run independent tasks in parallel
3. **Resource Limits**: Set appropriate CPU and memory limits
4. **Workspace Management**: Use efficient workspace types (emptyDir for temporary data)
5. **Image Optimization**: Use minimal base images and multi-stage builds

### Environment Management

1. **GitOps**: Keep all environment configuration in Git
2. **Environment Promotion**: Use automatic promotion for non-production environments
3. **Preview Environments**: Enable preview environments for all pull requests
4. **Resource Quotas**: Set quotas for preview namespaces
5. **Cleanup Policies**: Implement automatic cleanup for closed PRs

### Security

1. **Secret Management**: Use external secret managers (Vault, AWS Secrets Manager)
2. **RBAC**: Implement least-privilege access control
3. **Image Scanning**: Scan all images for vulnerabilities
4. **Policy Enforcement**: Use OPA or Kyverno for policy enforcement
5. **Audit Logging**: Enable comprehensive audit logging

## Conclusion

Jenkins X provides a comprehensive, opinionated CI/CD platform that embodies cloud-native best practices for Kubernetes. By leveraging automated pipelines, preview environments, GitOps workflows, and intelligent promotion strategies, teams can achieve high deployment velocity while maintaining security and reliability.

Key takeaways:
- Use automated pipeline detection for zero-config CI/CD
- Leverage preview environments for safe testing of changes
- Implement GitOps-based promotion strategies
- Utilize ChatOps for collaborative deployment workflows
- Monitor pipeline performance and deployment metrics
- Follow security best practices for production deployments

With Jenkins X, organizations can standardize on cloud-native CI/CD practices and accelerate their journey to continuous deployment on Kubernetes.