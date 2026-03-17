---
title: "ArgoCD ApplicationSets: Scaling GitOps Across Hundreds of Clusters"
date: 2027-12-10T00:00:00-05:00
draft: false
tags: ["ArgoCD", "GitOps", "Kubernetes", "ApplicationSets", "Multi-Cluster", "CD", "DevOps"]
categories:
- DevOps
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to ArgoCD ApplicationSets covering all generator types, progressive sync waves, notification templates, multi-tenancy with Projects, and scaling GitOps across hundreds of clusters."
more_link: "yes"
url: "/argocd-application-sets-enterprise-guide/"
---

Managing ArgoCD Applications at scale becomes unmanageable when each application requires a manually maintained manifest. ApplicationSets solve this by generating Application resources programmatically from templates combined with generators. A single ApplicationSet can deploy an application to hundreds of clusters, creating per-environment configurations automatically. This guide covers every generator type, advanced patterns for multi-tenancy, progressive deployment, and the operational practices required to run ApplicationSets safely in production.

<!--more-->

# ArgoCD ApplicationSets: Scaling GitOps Across Hundreds of Clusters

## Why ApplicationSets

Consider the management burden of a platform team maintaining 200 microservices across 15 cluster environments. Without ApplicationSets, that team manages 3,000 Application manifests. With a Matrix generator combining a Git generator and a List generator, the same coverage requires three ApplicationSet manifests.

ApplicationSets also enforce consistency. A manually managed Application manifest can drift from the organizational template. An ApplicationSet derives every Application from the same template, making drift impossible.

## ApplicationSet Controller

The ApplicationSet controller is bundled with ArgoCD 2.3+ and does not require separate installation. Verify it is running:

```bash
kubectl get pods -n argocd -l app.kubernetes.io/component=applicationset-controller
kubectl get crds | grep applicationset
```

## Generator Types

### List Generator

The simplest generator iterates over an explicit list of values.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: guestbook-environments
  namespace: argocd
spec:
  generators:
    - list:
        elements:
          - cluster: dev
            url: https://dev.k8s.example.com
            namespace: guestbook-dev
            imageTag: latest
          - cluster: staging
            url: https://staging.k8s.example.com
            namespace: guestbook-staging
            imageTag: 1.2.3
          - cluster: production
            url: https://prod.k8s.example.com
            namespace: guestbook-prod
            imageTag: 1.2.3
  template:
    metadata:
      name: "guestbook-{{cluster}}"
    spec:
      project: default
      source:
        repoURL: https://github.com/company/gitops
        targetRevision: HEAD
        path: apps/guestbook
        helm:
          valueFiles:
            - "values-{{cluster}}.yaml"
          parameters:
            - name: image.tag
              value: "{{imageTag}}"
      destination:
        server: "{{url}}"
        namespace: "{{namespace}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
```

### Git Generator

The Git generator discovers applications from a Git repository by scanning for specific files or directories.

#### Directory Generator

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: cluster-addons
  namespace: argocd
spec:
  generators:
    - git:
        repoURL: https://github.com/company/cluster-addons
        revision: HEAD
        directories:
          - path: "addons/*"
          - path: "addons/experimental/*"
            exclude: true   # Exclude experimental addons
  template:
    metadata:
      name: "{{path.basename}}"
    spec:
      project: platform
      source:
        repoURL: https://github.com/company/cluster-addons
        targetRevision: HEAD
        path: "{{path}}"
      destination:
        server: https://kubernetes.default.svc
        namespace: "{{path.basename}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
```

#### File Generator

The file generator reads JSON/YAML files from Git to extract generator parameters:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: tenant-applications
  namespace: argocd
spec:
  generators:
    - git:
        repoURL: https://github.com/company/tenants
        revision: HEAD
        files:
          - path: "tenants/*/config.yaml"
  template:
    metadata:
      name: "{{tenant.name}}-app"
      annotations:
        notifications.argoproj.io/subscribe.on-sync-succeeded.slack: "{{tenant.slackChannel}}"
    spec:
      project: "{{tenant.project}}"
      source:
        repoURL: "{{tenant.repoURL}}"
        targetRevision: "{{tenant.revision}}"
        path: "{{tenant.appPath}}"
      destination:
        server: "{{tenant.clusterURL}}"
        namespace: "{{tenant.namespace}}"
```

Example `tenants/acme-corp/config.yaml`:

```yaml
tenant:
  name: acme-corp
  project: acme
  repoURL: https://github.com/acme-corp/k8s-apps
  revision: main
  appPath: apps/production
  clusterURL: https://acme.k8s.example.com
  namespace: acme-production
  slackChannel: acme-deployments
```

### Cluster Generator

The cluster generator creates Applications for every registered ArgoCD cluster, or for clusters matching label selectors.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: cluster-monitoring
  namespace: argocd
spec:
  generators:
    - clusters:
        selector:
          matchLabels:
            environment: production
            monitoring: enabled
        # Template values from cluster secret annotations
        values:
          prometheusVersion: "2.48.0"
  template:
    metadata:
      name: "monitoring-{{name}}"
    spec:
      project: platform
      source:
        repoURL: https://github.com/company/platform-tools
        targetRevision: HEAD
        path: monitoring
        helm:
          releaseName: "monitoring-{{name}}"
          values: |
            cluster:
              name: "{{name}}"
              server: "{{server}}"
            prometheus:
              version: "{{values.prometheusVersion}}"
      destination:
        server: "{{server}}"
        namespace: monitoring
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
          - ServerSideApply=true
```

Cluster label annotations are set on the ArgoCD cluster Secret:

```bash
# Label a cluster for selection by ClusterGenerator
kubectl label secret <cluster-secret-name> -n argocd \
  environment=production \
  monitoring=enabled
```

### Pull Request Generator

The Pull Request generator creates ephemeral preview environments for each open pull request:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: preview-environments
  namespace: argocd
spec:
  generators:
    - pullRequest:
        github:
          owner: company
          repo: main-app
          tokenRef:
            secretName: github-token
            key: token
          # Only PRs with this label get preview environments
          labels:
            - preview
        requeueAfterSeconds: 60
  template:
    metadata:
      name: "preview-{{number}}"
      labels:
        app.kubernetes.io/instance: "preview-{{number}}"
      annotations:
        link.argocd.argoproj.io/external-link: "https://preview-{{number}}.preview.example.com"
    spec:
      project: previews
      source:
        repoURL: https://github.com/company/main-app
        targetRevision: "{{head_sha}}"
        path: k8s/preview
        helm:
          parameters:
            - name: image.tag
              value: "pr-{{number}}"
            - name: ingress.host
              value: "preview-{{number}}.preview.example.com"
      destination:
        server: https://preview.k8s.example.com
        namespace: "preview-{{number}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
      info:
        - name: PR
          value: "https://github.com/company/main-app/pull/{{number}}"
        - name: Branch
          value: "{{branch}}"
```

### SCM Provider Generator

The SCM Provider generator creates Applications from every repository in a GitHub organization or GitLab group:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: org-services
  namespace: argocd
spec:
  generators:
    - scmProvider:
        github:
          organization: company
          tokenRef:
            secretName: github-token
            key: token
          allBranches: false
        filters:
          - repositoryMatch: "^svc-"   # Only repos starting with svc-
          - pathsExist:
              - k8s/production        # Only repos with this path
          - labelMatch: "deploy=true"  # Only repos with this topic
  template:
    metadata:
      name: "{{repository}}"
    spec:
      project: services
      source:
        repoURL: "{{url}}"
        targetRevision: HEAD
        path: k8s/production
      destination:
        server: https://prod.k8s.example.com
        namespace: "{{repository}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: false  # Require manual approval for production
```

### Matrix Generator

The Matrix generator produces the Cartesian product of two generators, enabling "each service on each cluster" patterns:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: services-all-clusters
  namespace: argocd
spec:
  generators:
    - matrix:
        generators:
          # First dimension: all services from Git
          - git:
              repoURL: https://github.com/company/services
              revision: HEAD
              directories:
                - path: "services/*"
          # Second dimension: all production clusters
          - clusters:
              selector:
                matchLabels:
                  environment: production
  template:
    metadata:
      name: "{{path.basename}}-{{name}}"
    spec:
      project: production
      source:
        repoURL: https://github.com/company/services
        targetRevision: HEAD
        path: "{{path}}"
        helm:
          valueFiles:
            - "values-{{name}}.yaml"
            - "values.yaml"
      destination:
        server: "{{server}}"
        namespace: "{{path.basename}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

### Merge Generator

The Merge generator combines parameters from multiple generators, allowing base values to be overridden by environment-specific values:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: merged-config
  namespace: argocd
spec:
  generators:
    - merge:
        mergeKeys:
          - cluster
        generators:
          # Base configuration from list
          - list:
              elements:
                - cluster: us-east-1
                  region: us-east-1
                  replicas: "3"
                - cluster: eu-west-1
                  region: eu-west-1
                  replicas: "3"
          # Override from Git file (if file exists for that cluster)
          - git:
              repoURL: https://github.com/company/cluster-overrides
              revision: HEAD
              files:
                - path: "overrides/{{cluster}}.yaml"
  template:
    metadata:
      name: "app-{{cluster}}"
    spec:
      project: default
      source:
        repoURL: https://github.com/company/app
        targetRevision: HEAD
        path: k8s
        helm:
          parameters:
            - name: replicaCount
              value: "{{replicas}}"
            - name: aws.region
              value: "{{region}}"
      destination:
        server: "https://{{cluster}}.k8s.example.com"
        namespace: app
```

## Progressive Sync Waves

Sync waves control the order in which ArgoCD applies resources within an Application. The wave number is set via annotation.

### Within-Application Wave Ordering

```yaml
# Deploy CRDs first (wave -2)
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: myresources.example.com
  annotations:
    argocd.argoproj.io/sync-wave: "-2"

---
# Deploy namespace and RBAC next (wave -1)
apiVersion: v1
kind: Namespace
metadata:
  name: app-namespace
  annotations:
    argocd.argoproj.io/sync-wave: "-1"

---
# Deploy stateful services before apps (wave 0 - default)
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres

---
# Deploy application after database (wave 1)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-service
  annotations:
    argocd.argoproj.io/sync-wave: "1"
```

### Progressive ApplicationSet Delivery

For deploying to multiple clusters progressively (canary cluster before production):

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: progressive-delivery
  namespace: argocd
spec:
  strategy:
    type: RollingSync
    rollingSync:
      steps:
        - matchExpressions:
            - key: environment
              operator: In
              values:
                - dev
          maxUpdate: 100%
        - matchExpressions:
            - key: environment
              operator: In
              values:
                - staging
          maxUpdate: 100%
        - matchExpressions:
            - key: environment
              operator: In
              values:
                - production
          maxUpdate: 20%   # Update 20% of prod clusters at a time
  generators:
    - clusters:
        selector:
          matchExpressions:
            - key: environment
              operator: In
              values: [dev, staging, production]
  template:
    metadata:
      name: "app-{{name}}"
      labels:
        environment: "{{metadata.labels.environment}}"
    spec:
      project: default
      source:
        repoURL: https://github.com/company/app
        targetRevision: HEAD
        path: k8s
      destination:
        server: "{{server}}"
        namespace: app
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

## ignoreDifferences

`ignoreDifferences` prevents ArgoCD from flagging expected drift as out-of-sync:

```yaml
spec:
  template:
    spec:
      ignoreDifferences:
        # Ignore HPA-managed replica count
        - group: apps
          kind: Deployment
          jsonPointers:
            - /spec/replicas

        # Ignore injected sidecar containers
        - group: apps
          kind: Deployment
          jqPathExpressions:
            - .spec.template.spec.containers[] | select(.name == "istio-proxy")

        # Ignore controller-managed fields
        - group: ""
          kind: ServiceAccount
          jsonPointers:
            - /secrets

        # Ignore admission webhook CA bundles
        - group: admissionregistration.k8s.io
          kind: MutatingWebhookConfiguration
          jqPathExpressions:
            - .webhooks[]?.clientConfig.caBundle
```

## Resource Hooks

Resource hooks execute at specific points in the sync lifecycle:

```yaml
# PreSync hook: run database migration before deploying new version
apiVersion: batch/v1
kind: Job
metadata:
  name: db-migrate
  annotations:
    argocd.argoproj.io/hook: PreSync
    argocd.argoproj.io/hook-delete-policy: BeforeHookCreation
spec:
  template:
    spec:
      containers:
        - name: migrate
          image: company/app:{{imageTag}}
          command: ["./migrate", "up"]
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: db-credentials
                  key: url
      restartPolicy: Never
  backoffLimit: 2

---
# PostSync hook: run smoke tests after deployment
apiVersion: batch/v1
kind: Job
metadata:
  name: smoke-test
  annotations:
    argocd.argoproj.io/hook: PostSync
    argocd.argoproj.io/hook-delete-policy: HookSucceeded
spec:
  template:
    spec:
      containers:
        - name: test
          image: company/smoke-tests:latest
          command: ["./run-smoke-tests.sh"]
          env:
            - name: TARGET_URL
              value: "http://app.production.svc.cluster.local"
      restartPolicy: Never
  backoffLimit: 1

---
# SyncFail hook: notify on failure
apiVersion: batch/v1
kind: Job
metadata:
  name: notify-failure
  annotations:
    argocd.argoproj.io/hook: SyncFail
    argocd.argoproj.io/hook-delete-policy: HookSucceeded
spec:
  template:
    spec:
      containers:
        - name: notify
          image: curlimages/curl:latest
          command:
            - sh
            - -c
            - |
              curl -X POST https://hooks.slack.com/services/T0000000/B0000000/placeholder-webhook-url \
                -H 'Content-Type: application/json' \
                -d '{"text": "Deployment failed in {{app.metadata.namespace}}"}'
      restartPolicy: Never
```

## Multi-Tenancy with AppProjects

AppProjects enforce RBAC boundaries between teams using the same ArgoCD instance.

### Project Definition

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: payments-team
  namespace: argocd
spec:
  description: "Payments team applications"
  sourceRepos:
    - "https://github.com/company/payments-*"
  destinations:
    - namespace: payments-*
      server: https://prod.k8s.example.com
    - namespace: payments-*
      server: https://staging.k8s.example.com
  clusterResourceWhitelist:
    - group: ""
      kind: Namespace
  namespaceResourceBlacklist:
    - group: ""
      kind: ResourceQuota
    - group: ""
      kind: LimitRange
  roles:
    - name: payments-developer
      description: "Read-only access for developers"
      policies:
        - p, proj:payments-team:payments-developer, applications, get, payments-team/*, allow
        - p, proj:payments-team:payments-developer, applications, sync, payments-team/*, allow
      groups:
        - payments-developers
    - name: payments-admin
      description: "Full access for team leads"
      policies:
        - p, proj:payments-team:payments-admin, applications, *, payments-team/*, allow
      groups:
        - payments-leads
  syncWindows:
    - kind: allow
      schedule: "0 8-17 * * 1-5"
      duration: 9h
      applications:
        - "*"
      namespaces:
        - "payments-*"
    - kind: deny
      schedule: "0 0 * * *"
      duration: 24h
      applications:
        - "*"
      namespaces:
        - "payments-prod"
      manualSync: true  # Allow manual sync during deny window
```

### ApplicationSet with Project Scoping

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: payments-services
  namespace: argocd
spec:
  generators:
    - git:
        repoURL: https://github.com/company/payments-services
        revision: HEAD
        directories:
          - path: "services/*"
  template:
    metadata:
      name: "payments-{{path.basename}}"
    spec:
      project: payments-team   # Bound to payments project
      source:
        repoURL: https://github.com/company/payments-services
        targetRevision: HEAD
        path: "{{path}}"
      destination:
        server: https://prod.k8s.example.com
        namespace: "payments-{{path.basename}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
```

## Notification Templates

ArgoCD Notifications integrate with ApplicationSets to send alerts on deployment events.

### Notification Subscription via Annotation

```yaml
spec:
  template:
    metadata:
      annotations:
        # Subscribe to events for this application
        notifications.argoproj.io/subscribe.on-sync-succeeded.slack: "deployments"
        notifications.argoproj.io/subscribe.on-sync-failed.slack: "deployments-alerts"
        notifications.argoproj.io/subscribe.on-health-degraded.pagerduty: "platform-oncall"
```

### Custom Notification Template

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-notifications-cm
  namespace: argocd
data:
  template.app-deployed: |
    message: |
      Application {{.app.metadata.name}} deployed successfully.
      Environment: {{.app.metadata.labels.environment}}
      Revision: {{.app.status.sync.revision}}
      Cluster: {{.app.spec.destination.server}}
    slack:
      attachments: |
        [{
          "color": "good",
          "title": "Deployment Successful: {{.app.metadata.name}}",
          "fields": [
            {"title": "Environment", "value": "{{.app.metadata.labels.environment}}", "short": true},
            {"title": "Revision", "value": "{{.app.status.sync.revision | substr 0 8}}", "short": true}
          ]
        }]

  trigger.on-sync-succeeded: |
    - when: app.status.operationState.phase in ['Succeeded']
      send: [app-deployed]

  service.slack: |
    token: $slack-token
    defaultChannel: deployments
```

## Validating ApplicationSets

```bash
# Dry-run ApplicationSet to see generated Applications
kubectl apply --dry-run=server -f applicationset.yaml

# Use argocd CLI to preview generated applications
argocd app generate applicationset.yaml

# Check ApplicationSet status
kubectl get applicationset -n argocd -o wide

# List all Applications generated by a specific ApplicationSet
kubectl get application -n argocd \
  -l app.kubernetes.io/managed-by=argocd-applicationset-controller

# Check generation errors
kubectl describe applicationset <name> -n argocd | grep -A 20 "Status"
```

## Protecting Production Applications

```yaml
# Add deletion protection to prevent accidental removal
spec:
  template:
    metadata:
      finalizers:
        - resources-finalizer.argocd.argoproj.io/background
      annotations:
        # Require manual sync for production
        argocd.argoproj.io/sync-options: "ManualSync=true"
    spec:
      # Disable automated sync for production tier
      syncPolicy:
        automated: null
```

## Summary

ArgoCD ApplicationSets transform GitOps management from O(applications * clusters) manual effort to O(generators + templates). The generator types cover every enterprise pattern: static lists for simple environments, Git directory scanning for self-service platforms, cluster generators for fleet-wide deployments, pull request generators for preview environments, and matrix generators for the Cartesian product of services and clusters.

Progressive sync with RollingSync strategy provides the deployment safety valve needed for large fleets. Combined with AppProjects for multi-tenancy, sync windows for change management compliance, and notification templates for operational visibility, ApplicationSets provide the full enterprise GitOps platform on top of ArgoCD.

The key operational principle: start with List generators for predictable environments, graduate to Git generators as teams add new services, and use Matrix generators only when the Cartesian product is genuinely needed. Each additional generator type adds cognitive complexity; the simplest generator that solves the problem is the right choice.
