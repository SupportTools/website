---
title: "Kubernetes ArgoCD ApplicationSets: Templating Multi-Cluster Deployments"
date: 2029-06-27T00:00:00-05:00
draft: false
tags: ["Kubernetes", "ArgoCD", "GitOps", "ApplicationSet", "Multi-Cluster", "Argo Rollouts"]
categories: ["Kubernetes", "GitOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to ArgoCD ApplicationSets covering list, cluster, git, matrix, and merge generators; template patches; sync policy automation; and progressive delivery integration with Argo Rollouts for multi-cluster deployments."
more_link: "yes"
url: "/kubernetes-argocd-applicationsets-multi-cluster/"
---

ArgoCD ApplicationSet is the solution to a problem every team hits when managing multiple clusters: maintaining dozens of nearly-identical ArgoCD Application resources that differ only in environment-specific values. ApplicationSet introduces a controller that generates Application resources from templates and generators, turning a 200-line YAML file that must be manually duplicated per cluster into a 30-line generator specification. This guide covers all generator types and progressive delivery integration with Argo Rollouts.

<!--more-->

# Kubernetes ArgoCD ApplicationSets: Templating Multi-Cluster Deployments

## Section 1: ApplicationSet Architecture

The ApplicationSet controller runs alongside ArgoCD and watches `ApplicationSet` resources. When a generator produces a new set of parameters, the controller creates, updates, or deletes `Application` resources accordingly.

```
ApplicationSet
└── Generators (produce parameter sets)
    ├── List Generator
    ├── Cluster Generator
    ├── Git Generator (directory, file)
    ├── SCM Provider Generator
    ├── Pull Request Generator
    ├── Matrix Generator (Cartesian product of two generators)
    └── Merge Generator (merge parameter sets)

For each parameter set → Template fills in Application spec
```

### Install ApplicationSet Controller

```bash
# Install ArgoCD with ApplicationSet (included by default since ArgoCD 2.3)
kubectl create namespace argocd
kubectl apply -n argocd -f \
  https://raw.githubusercontent.com/argoproj/argo-cd/v2.10.0/manifests/install.yaml

# Verify ApplicationSet controller
kubectl get deployment argocd-applicationset-controller -n argocd

# Check CRD
kubectl get crd applicationsets.argoproj.io
```

---

## Section 2: List Generator

The list generator is the simplest: you provide a static list of parameter sets.

```yaml
# list-generator.yaml
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
        url: https://1.2.3.4
        values:
          replicaCount: "1"
          environment: development
          imageTag: latest
      - cluster: staging
        url: https://5.6.7.8
        values:
          replicaCount: "2"
          environment: staging
          imageTag: v1.2.3
      - cluster: production
        url: https://9.10.11.12
        values:
          replicaCount: "5"
          environment: production
          imageTag: v1.2.3

  template:
    metadata:
      name: "guestbook-{{cluster}}"
      labels:
        environment: "{{values.environment}}"
    spec:
      project: default
      source:
        repoURL: https://github.com/argoproj/argocd-example-apps
        targetRevision: HEAD
        path: guestbook
        helm:
          values: |
            replicaCount: {{values.replicaCount}}
            image:
              tag: {{values.imageTag}}
            env: {{values.environment}}
      destination:
        server: "{{url}}"
        namespace: guestbook
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
        - CreateNamespace=true
```

---

## Section 3: Cluster Generator

The cluster generator iterates over ArgoCD cluster secrets, making it dynamic — when you add a cluster to ArgoCD, applications are automatically deployed to it.

### Register Clusters in ArgoCD

```bash
# Add clusters to ArgoCD
argocd cluster add dev-context --name dev
argocd cluster add staging-context --name staging
argocd cluster add prod-us-east-1 --name prod-us-east-1
argocd cluster add prod-us-west-2 --name prod-us-west-2

# List registered clusters
argocd cluster list

# Label clusters for generator filtering
kubectl label secret -n argocd \
  $(kubectl get secret -n argocd -l argocd.argoproj.io/secret-type=cluster \
    -o jsonpath='{.items[?(@.metadata.annotations.cluster-name=="prod-us-east-1")].metadata.name}') \
  environment=production \
  region=us-east-1
```

### Basic Cluster Generator

```yaml
# cluster-generator.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: deploy-to-all-clusters
  namespace: argocd
spec:
  generators:
  - clusters:
      selector:
        matchLabels:
          environment: production  # Only deploy to production-labeled clusters

  template:
    metadata:
      name: "my-app-{{name}}"
    spec:
      project: default
      source:
        repoURL: https://github.com/myorg/my-app
        targetRevision: HEAD
        path: "charts/my-app"
        helm:
          parameters:
          - name: cluster.name
            value: "{{name}}"
          - name: cluster.server
            value: "{{server}}"
      destination:
        server: "{{server}}"
        namespace: my-app
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
        - CreateNamespace=true
```

### Cluster Generator with Values from Secret

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: per-cluster-config
  namespace: argocd
spec:
  generators:
  - clusters:
      # The cluster secret's annotations become available as generator values
      # Add custom values via secret annotation:
      # argocd.argoproj.io/cluster-region: us-east-1
      # argocd.argoproj.io/cluster-tier: premium
      selector:
        matchExpressions:
        - key: environment
          operator: In
          values: [production, staging]

  template:
    metadata:
      name: "monitoring-{{name}}"
      annotations:
        notifications.argoproj.io/subscribe.on-sync-failed.slack: "#platform-alerts"
    spec:
      project: platform
      source:
        repoURL: https://github.com/myorg/platform
        targetRevision: HEAD
        path: monitoring
        helm:
          values: |
            cluster:
              name: {{name}}
              server: {{server}}
              region: {{metadata.annotations.cluster-region}}
      destination:
        server: "{{server}}"
        namespace: monitoring
```

---

## Section 4: Git Generator

The Git generator reads parameters from files or directory structures in a Git repository.

### Git Directory Generator

Deploy an app for each directory found under a path:

```yaml
# git-dir-generator.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: apps-from-git
  namespace: argocd
spec:
  generators:
  - git:
      repoURL: https://github.com/myorg/gitops
      revision: HEAD
      directories:
      - path: "apps/*"          # Match any directory under apps/
      - path: "apps/excluded/*" # Exclude subdirectories
        exclude: true

  template:
    metadata:
      name: "{{path.basename}}"
    spec:
      project: default
      source:
        repoURL: https://github.com/myorg/gitops
        targetRevision: HEAD
        path: "{{path}}"
      destination:
        server: https://kubernetes.default.svc
        namespace: "{{path.basename}}"
      syncPolicy:
        automated:
          prune: true
```

### Git File Generator

Reads JSON or YAML parameter files from the repo:

```yaml
# git-file-generator.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: apps-from-config-files
  namespace: argocd
spec:
  generators:
  - git:
      repoURL: https://github.com/myorg/gitops
      revision: HEAD
      files:
      - path: "environments/*/config.yaml"
      # This matches:
      # environments/dev/config.yaml
      # environments/staging/config.yaml
      # environments/prod-us-east/config.yaml

  template:
    metadata:
      name: "my-app-{{environment}}"
    spec:
      project: default
      source:
        repoURL: https://github.com/myorg/my-app
        targetRevision: "{{revision}}"
        path: "helm"
        helm:
          values: |
            environment: {{environment}}
            region: {{region}}
            replicas: {{replicas}}
            image:
              tag: {{imageTag}}
      destination:
        server: "{{clusterURL}}"
        namespace: "{{namespace}}"
```

```yaml
# environments/prod-us-east/config.yaml
environment: production
region: us-east-1
replicas: 5
imageTag: v1.2.3
clusterURL: https://prod-us-east.example.com
namespace: my-app
revision: v1.2.3
```

---

## Section 5: Matrix Generator

The Matrix generator produces the Cartesian product of two generators. This is powerful for "deploy this app to every cluster in every environment".

```yaml
# matrix-generator.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: app-matrix-deploy
  namespace: argocd
spec:
  generators:
  - matrix:
      generators:
      # Generator 1: Which apps to deploy
      - git:
          repoURL: https://github.com/myorg/apps
          revision: HEAD
          directories:
          - path: "apps/*"

      # Generator 2: Which clusters to deploy to
      - clusters:
          selector:
            matchLabels:
              deploy-standard-apps: "true"

  template:
    metadata:
      name: "{{path.basename}}-{{name}}"
    spec:
      project: default
      source:
        repoURL: https://github.com/myorg/apps
        targetRevision: HEAD
        path: "{{path}}"
        helm:
          parameters:
          - name: cluster
            value: "{{name}}"
      destination:
        server: "{{server}}"
        namespace: "{{path.basename}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
        - CreateNamespace=true
        retry:
          limit: 5
          backoff:
            duration: 5s
            factor: 2
            maxDuration: 3m
```

### Multi-Environment Matrix with Git Files

```yaml
# Deploy every app from git to every environment from another git path
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: full-matrix-deploy
  namespace: argocd
spec:
  generators:
  - matrix:
      generators:
      # Apps to deploy
      - git:
          repoURL: https://github.com/myorg/platform
          revision: HEAD
          files:
          - path: "apps/*/app-config.yaml"

      # Environments/clusters to deploy to
      - git:
          repoURL: https://github.com/myorg/gitops-config
          revision: HEAD
          files:
          - path: "clusters/*/cluster-config.yaml"

  template:
    metadata:
      name: "{{appName}}-{{clusterName}}"
    spec:
      project: "{{team}}"
      source:
        repoURL: "{{appRepo}}"
        targetRevision: "{{appRevision}}"
        path: "helm"
        helm:
          values: |
            app:
              name: {{appName}}
            cluster:
              name: {{clusterName}}
              region: {{clusterRegion}}
            {{helmValues}}
      destination:
        server: "{{clusterServer}}"
        namespace: "{{appName}}"
```

---

## Section 6: Merge Generator

The Merge generator combines multiple generators' output. Use it to set default values from one generator and override specific values from another.

```yaml
# merge-generator.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: merged-config-deploy
  namespace: argocd
spec:
  generators:
  - merge:
      mergeKeys:
      - clusterName   # Merge by matching this key
      generators:
      # Base: cluster info (provides default values for all clusters)
      - clusters:
          values:
            revision: main
            replicaCount: "2"
            logLevel: info

      # Override: git file provides per-cluster overrides
      - git:
          repoURL: https://github.com/myorg/cluster-configs
          revision: HEAD
          files:
          - path: "overrides/*/config.yaml"
          # Each file provides:
          # clusterName: prod-us-east  (merge key)
          # revision: v2.0.0           (override)
          # replicaCount: "10"         (override)

  template:
    metadata:
      name: "my-app-{{clusterName}}"
    spec:
      project: default
      source:
        repoURL: https://github.com/myorg/my-app
        targetRevision: "{{revision}}"
        path: helm
        helm:
          parameters:
          - name: replicaCount
            value: "{{replicaCount}}"
          - name: logLevel
            value: "{{logLevel}}"
      destination:
        server: "{{server}}"
        namespace: my-app
```

---

## Section 7: Template Patch

Template patches allow modifying the generated Application spec using JSON/YAML patches, enabling per-element customization that would be impossible with string templating alone.

```yaml
# template-patch.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: with-template-patch
  namespace: argocd
spec:
  generators:
  - list:
      elements:
      - cluster: dev
        env: development
        enableMonitoring: "false"
        ingressTLS: "false"
      - cluster: staging
        env: staging
        enableMonitoring: "true"
        ingressTLS: "true"
      - cluster: production
        env: production
        enableMonitoring: "true"
        ingressTLS: "true"
        # Production gets additional sync policy
        syncPolicyManual: "true"

  # Base template
  template:
    metadata:
      name: "my-app-{{cluster}}"
    spec:
      project: default
      source:
        repoURL: https://github.com/myorg/my-app
        targetRevision: HEAD
        path: helm
      destination:
        server: https://kubernetes.default.svc
        namespace: "{{env}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true

  # Conditional patches applied after template rendering
  templatePatch: |
    {{- if eq .syncPolicyManual "true" }}
    spec:
      syncPolicy:
        automated: null
    {{- end }}
    {{- if eq .enableMonitoring "true" }}
    metadata:
      annotations:
        monitoring.io/scrape: "true"
        monitoring.io/port: "9090"
    {{- end }}
```

---

## Section 8: Sync Policy and Automation

### Auto-Sync with Resource Hooks

```yaml
# sync-policy-advanced.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: production-apps
  namespace: argocd
spec:
  generators:
  - clusters:
      selector:
        matchLabels:
          environment: production

  template:
    metadata:
      name: "production-{{name}}"
    spec:
      project: production

      source:
        repoURL: https://github.com/myorg/apps
        targetRevision: HEAD
        path: production

      destination:
        server: "{{server}}"
        namespace: production

      # Comprehensive sync policy for production
      syncPolicy:
        automated:
          prune: true      # Remove resources not in git
          selfHeal: true   # Revert manual changes
          allowEmpty: false # Never sync empty application

        managedNamespaceMetadata:
          labels:
            team: platform
          annotations:
            owner: platform-team

        syncOptions:
        - CreateNamespace=true
        - PrunePropagationPolicy=foreground
        - PruneLast=true          # Prune after all other resources sync
        - RespectIgnoreDifferences=true
        - ServerSideApply=true    # Use server-side apply for better conflict handling

        retry:
          limit: 3
          backoff:
            duration: 10s
            factor: 2
            maxDuration: 5m

      # Ignore differences in certain fields
      ignoreDifferences:
      - group: apps
        kind: Deployment
        jsonPointers:
        - /spec/replicas  # HPA manages this, ignore drift
      - group: ""
        kind: Secret
        jsonPointers:
        - /data           # External secrets manage this
      - group: autoscaling
        kind: HorizontalPodAutoscaler
        jsonPointers:
        - /status
```

---

## Section 9: Progressive Sync with Argo Rollouts

Combining ApplicationSets with Argo Rollouts enables progressive delivery across multiple clusters.

### Install Argo Rollouts

```bash
kubectl create namespace argo-rollouts
kubectl apply -n argo-rollouts -f \
  https://github.com/argoproj/argo-rollouts/releases/latest/download/install.yaml

# Install kubectl plugin
curl -LO https://github.com/argoproj/argo-rollouts/releases/latest/download/kubectl-argo-rollouts-linux-amd64
chmod +x kubectl-argo-rollouts-linux-amd64
mv kubectl-argo-rollouts-linux-amd64 /usr/local/bin/kubectl-argo-rollouts
```

### Rollout Resource for Canary Deployment

```yaml
# rollout.yaml (in your app's helm chart)
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: my-app
spec:
  replicas: 10
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
      - name: my-app
        image: "{{.Values.image.repository}}:{{.Values.image.tag}}"
        ports:
        - containerPort: 8080

  strategy:
    canary:
      canaryService: my-app-canary
      stableService: my-app-stable
      trafficRouting:
        istio:
          virtualService:
            name: my-app-vsvc
            routes:
            - primary
          destinationRule:
            name: my-app-destrule
            canarySubsetName: canary
            stableSubsetName: stable

      steps:
      - setWeight: 5
      - pause:
          duration: 5m
      - analysis:
          templates:
          - templateName: http-benchmark
      - setWeight: 20
      - pause:
          duration: 10m
      - analysis:
          templates:
          - templateName: http-benchmark
      - setWeight: 50
      - pause:
          duration: 15m
      - setWeight: 100
```

### AnalysisTemplate for Automated Validation

```yaml
# analysis-template.yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: http-benchmark
spec:
  args:
  - name: service-name
  - name: namespace
  metrics:
  - name: success-rate
    interval: 60s
    successCondition: result[0] >= 0.99
    failureLimit: 3
    provider:
      prometheus:
        address: http://prometheus.monitoring:9090
        query: |
          sum(rate(
            istio_requests_total{
              destination_service_name="{{args.service-name}}",
              destination_service_namespace="{{args.namespace}}",
              response_code!~"5.*"
            }[2m]
          )) /
          sum(rate(
            istio_requests_total{
              destination_service_name="{{args.service-name}}",
              destination_service_namespace="{{args.namespace}}"
            }[2m]
          ))

  - name: p99-latency
    interval: 60s
    successCondition: result[0] < 0.5  # 500ms
    failureLimit: 2
    provider:
      prometheus:
        address: http://prometheus.monitoring:9090
        query: |
          histogram_quantile(0.99,
            sum(rate(
              istio_request_duration_milliseconds_bucket{
                destination_service_name="{{args.service-name}}"
              }[2m]
            )) by (le)
          ) / 1000  # Convert ms to seconds
```

### ApplicationSet for Progressive Multi-Cluster Rollout

```yaml
# progressive-rollout-appset.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: progressive-rollout
  namespace: argocd
spec:
  generators:
  - list:
      elements:
      # Wave 1: Canary cluster (5% traffic)
      - cluster: canary
        wave: "1"
        canaryWeight: "5"
        autoPromote: "false"
      # Wave 2: 10% of prod clusters
      - cluster: prod-us-east-1
        wave: "2"
        canaryWeight: "10"
        autoPromote: "true"
      # Wave 3: All remaining prod clusters
      - cluster: prod-us-west-2
        wave: "3"
        canaryWeight: "100"
        autoPromote: "true"
      - cluster: prod-eu-west-1
        wave: "3"
        canaryWeight: "100"
        autoPromote: "true"

  template:
    metadata:
      name: "my-app-{{cluster}}"
      annotations:
        argocd.argoproj.io/sync-wave: "{{wave}}"
        notifications.argoproj.io/subscribe.on-sync-failed.slack: "#deploy-alerts"
    spec:
      project: production
      source:
        repoURL: https://github.com/myorg/my-app
        targetRevision: HEAD
        path: helm
        helm:
          parameters:
          - name: rollout.canaryWeight
            value: "{{canaryWeight}}"
          - name: rollout.autoPromote
            value: "{{autoPromote}}"
      destination:
        server: https://clusters.example.com/{{cluster}}
        namespace: my-app
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
        - ServerSideApply=true
```

---

## Section 10: ApplicationSet Policies — Controlling Application Deletion

When a generator no longer produces an entry for an Application, the controller's behavior depends on the deletion policy.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: managed-lifecycle
  namespace: argocd
spec:
  # Policy controlling Application resource deletion
  goTemplate: true
  goTemplateOptions: ["missingkey=error"]

  syncPolicy:
    # Preserve = do not delete Application (just abandon it) when removed from generator
    # Delete = delete the Application (and potentially its resources)
    # Replace = delete and recreate with the same name
    applicationSetDeletion: true    # Delete AppSet deletes all generated Applications

  preservedFields:
    # Don't diff these fields (user might have changed them)
    annotations:
    - "kubectl.kubernetes.io/last-applied-configuration"
    - "my-custom-annotation"

  generators:
  - list:
      elements:
      - name: my-app
        namespace: production

  template:
    metadata:
      name: "{{.name}}"
      finalizers:
      - resources-finalizer.argocd.argoproj.io  # Delete App resources on deletion
    spec:
      # ...
```

---

## Section 11: Notification Integration

```yaml
# Configure ArgoCD Notifications for ApplicationSet events
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-notifications-cm
  namespace: argocd
data:
  trigger.on-sync-failed: |
    - when: app.status.operationState.phase in ['Error', 'Failed']
      oncePer: app.status.sync.revision
      send: [slack-sync-failed]
  trigger.on-health-degraded: |
    - when: app.status.health.status == 'Degraded'
      oncePer: app.status.sync.revision
      send: [slack-health-degraded]
  template.slack-sync-failed: |
    message: |
      Application {{.app.metadata.name}} sync failed.
      Revision: {{.app.status.sync.revision}}
      Message: {{.app.status.operationState.message}}
    slack:
      attachments: |
        [{
          "title": "{{.app.metadata.name}}",
          "color": "#E96D76",
          "fields": [
            {"title": "Cluster", "value": "{{.app.spec.destination.server}}", "short": true},
            {"title": "Namespace", "value": "{{.app.spec.destination.namespace}}", "short": true}
          ]
        }]
  service.slack: |
    token: $slack-token
```

### Annotate Applications for Notifications

```yaml
# In your ApplicationSet template:
template:
  metadata:
    name: "my-app-{{cluster}}"
    annotations:
      notifications.argoproj.io/subscribe.on-sync-failed.slack: "#deploy-failures"
      notifications.argoproj.io/subscribe.on-health-degraded.slack: "#platform-alerts"
      notifications.argoproj.io/subscribe.on-deployed.slack: "#deploy-success"
```

ApplicationSet transforms ArgoCD from a per-cluster tool into a true multi-cluster platform. The generator composition model — combining Matrix for Cartesian products, Merge for value overrides, and Git generators for dynamic discovery — eliminates the maintenance burden of managing individual Application resources while the template patch capability handles the edge cases where simple string templating falls short.
