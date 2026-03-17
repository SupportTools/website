---
title: "Kubernetes ArgoCD ApplicationSet Controller: Generator Patterns for Multi-Cluster GitOps"
date: 2028-05-09T00:00:00-05:00
draft: false
tags: ["Kubernetes", "ArgoCD", "ApplicationSet", "GitOps", "Multi-Cluster"]
categories: ["Kubernetes", "GitOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to ArgoCD ApplicationSet controller generator patterns including List, Cluster, Git, Matrix, and Merge generators for automating multi-cluster GitOps deployments at scale."
more_link: "yes"
url: "/kubernetes-argocd-applicationset-generator-guide/"
---

ArgoCD's ApplicationSet controller transforms multi-cluster GitOps from a manual, error-prone process into a declarative, automated system. Rather than creating and managing hundreds of individual ArgoCD Application resources, ApplicationSets dynamically generate them based on templates and generators. This guide covers the full range of generator patterns — from simple list generators to complex matrix compositions — and shows how to build production-grade multi-cluster deployment pipelines that scale from dozens to thousands of deployments.

<!--more-->

# Kubernetes ArgoCD ApplicationSet Controller: Generator Patterns for Multi-Cluster GitOps

## ApplicationSet Architecture

The ApplicationSet controller watches `ApplicationSet` custom resources and generates `Application` resources according to the generator configuration. When the generator's input changes — a new cluster is registered, a new directory appears in Git, a new entry is added to a list — the controller automatically creates, updates, or deletes the corresponding Applications.

This solves the "N applications across M clusters" problem declaratively:

- N services × M environments = N×M Application resources, all managed by a single ApplicationSet
- New cluster added to the fleet? Applications are automatically provisioned
- New service directory pushed to Git? Applications are automatically created across all target clusters
- Service removed from Git? Applications are automatically deleted (with configurable deletion policy)

## Installing the ApplicationSet Controller

In modern ArgoCD versions (2.3+), the ApplicationSet controller is bundled with ArgoCD:

```bash
# Install ArgoCD with ApplicationSet controller enabled (default)
kubectl create namespace argocd

kubectl apply -n argocd -f \
  https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# Verify ApplicationSet controller is running
kubectl get pods -n argocd | grep applicationset
# argocd-applicationset-controller-6b4d8b9f8c-xyz12   1/1   Running   0   2m
```

## Generator 1: List Generator

The simplest generator creates Applications from an explicit list of parameters:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: team-environments
  namespace: argocd
spec:
  generators:
    - list:
        elements:
          - cluster: dev
            url: https://k8s-dev.internal.acme.com
            namespace: payments-dev
            values:
              environment: development
              replicas: "1"
              imageTag: latest
              resourceTier: small

          - cluster: staging
            url: https://k8s-staging.internal.acme.com
            namespace: payments-staging
            values:
              environment: staging
              replicas: "2"
              imageTag: "1.5.2-rc.1"
              resourceTier: medium

          - cluster: production
            url: https://k8s-prod.internal.acme.com
            namespace: payments-production
            values:
              environment: production
              replicas: "5"
              imageTag: "1.5.1"
              resourceTier: large

  template:
    metadata:
      name: "payments-{{cluster}}"
      labels:
        environment: "{{values.environment}}"
        team: payments
      annotations:
        argocd.argoproj.io/manifest-generate-paths: .
    spec:
      project: payments

      source:
        repoURL: https://github.com/acme-corp/payments-service
        targetRevision: main
        path: k8s/overlays/{{values.environment}}
        helm:
          releaseName: payments
          values: |
            replicaCount: {{values.replicas}}
            image:
              tag: {{values.imageTag}}
            resources:
              tier: {{values.resourceTier}}

      destination:
        server: "{{url}}"
        namespace: "{{namespace}}"

      syncPolicy:
        automated:
          prune: true
          selfHeal: true
          allowEmpty: false
        syncOptions:
          - CreateNamespace=true
          - PrunePropagationPolicy=foreground
          - ApplyOutOfSyncOnly=true
        retry:
          limit: 5
          backoff:
            duration: 5s
            factor: 2
            maxDuration: 3m

      ignoreDifferences:
        - group: apps
          kind: Deployment
          jsonPointers:
            - /spec/replicas  # Managed by HPA

  syncPolicy:
    # What happens when an element is removed from the list
    preserveResourcesOnDeletion: false
```

## Generator 2: Cluster Generator

The cluster generator dynamically creates Applications for every cluster registered in ArgoCD. As clusters are added or removed from ArgoCD's cluster registry, Applications are automatically provisioned or cleaned up:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: cluster-addons
  namespace: argocd
spec:
  generators:
    - clusters:
        # Deploy to all clusters
        selector: {}

  template:
    metadata:
      name: "cluster-addons-{{name}}"
    spec:
      project: infrastructure

      source:
        repoURL: https://github.com/acme-corp/cluster-addons
        targetRevision: main
        path: charts/cluster-addons
        helm:
          releaseName: cluster-addons
          values: |
            clusterName: {{name}}
            clusterServer: {{server}}

      destination:
        server: "{{server}}"
        namespace: kube-system

      syncPolicy:
        automated:
          prune: false  # Don't prune cluster addons
          selfHeal: true

---
# Deploy to clusters with specific labels
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: gpu-workloads
  namespace: argocd
spec:
  generators:
    - clusters:
        selector:
          matchLabels:
            accelerator: nvidia-gpu
          matchExpressions:
            - key: region
              operator: In
              values: [us-east-1, us-west-2]

  template:
    metadata:
      name: "gpu-operator-{{name}}"
    spec:
      project: infrastructure

      source:
        repoURL: https://nvidia.github.io/gpu-operator
        chart: gpu-operator
        targetRevision: "23.9.0"
        helm:
          releaseName: gpu-operator
          values: |
            operator:
              defaultRuntime: containerd
            driver:
              enabled: true
              version: "535.104.12"
            toolkit:
              enabled: true

      destination:
        server: "{{server}}"
        namespace: gpu-operator

      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
```

### Labeling Clusters for Generator Targeting

```bash
# Add labels to registered clusters via ArgoCD CLI
argocd cluster set https://k8s-prod-us-east.internal.acme.com \
  --label region=us-east-1 \
  --label tier=production \
  --label accelerator=nvidia-gpu

# Or via the Cluster secret that ArgoCD uses
kubectl patch secret cluster-prod-us-east -n argocd --type=merge -p '{
  "metadata": {
    "labels": {
      "argocd.argoproj.io/secret-type": "cluster",
      "region": "us-east-1",
      "tier": "production",
      "accelerator": "nvidia-gpu"
    }
  }
}'
```

## Generator 3: Git Generator

The Git generator creates Applications based on the contents of a Git repository. This enables "app of apps" patterns where adding a directory to Git automatically creates a new deployment.

### Git Directory Generator

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: microservices
  namespace: argocd
spec:
  generators:
    - git:
        repoURL: https://github.com/acme-corp/microservices
        revision: main
        directories:
          # Create an Application for each directory in services/
          - path: "services/*"
          # Exclude specific directories
          - path: "services/deprecated-*"
            exclude: true
        # Check for new directories every 3 minutes
        requeueAfterSeconds: 180

  template:
    metadata:
      # Extract service name from directory path
      name: "{{path.basename}}"
      labels:
        service: "{{path.basename}}"
      annotations:
        # Trigger sync only when files in this service's directory change
        argocd.argoproj.io/manifest-generate-paths: "{{path}}"
    spec:
      project: microservices

      source:
        repoURL: https://github.com/acme-corp/microservices
        targetRevision: main
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

### Git File Generator

The file generator reads JSON/YAML files in the repository to parameterize Applications:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: tenant-deployments
  namespace: argocd
spec:
  generators:
    - git:
        repoURL: https://github.com/acme-corp/tenant-registry
        revision: main
        files:
          # Find all cluster.yaml files in tenant directories
          - path: "tenants/*/cluster.yaml"

  template:
    metadata:
      name: "tenant-{{tenant_id}}-{{cluster_name}}"
    spec:
      project: tenants

      source:
        repoURL: https://github.com/acme-corp/tenant-platform
        targetRevision: main
        path: charts/tenant-platform
        helm:
          releaseName: "tenant-{{tenant_id}}"
          values: |
            tenantId: {{tenant_id}}
            tenantName: {{tenant_name}}
            clusterName: {{cluster_name}}
            database:
              host: {{db_host}}
              name: {{db_name}}
            ingress:
              host: {{ingress_host}}
            resources:
              tier: {{resource_tier}}

      destination:
        server: "{{cluster_server}}"
        namespace: "tenant-{{tenant_id}}"

      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
          - ServerSideApply=true
```

The corresponding `cluster.yaml` files in the tenant registry:

```yaml
# tenants/acme-corp/cluster.yaml
tenant_id: "acme-001"
tenant_name: "ACME Corporation"
cluster_name: "us-east-production"
cluster_server: "https://k8s-prod-us-east.internal.acme.com"
db_host: "acme-001.postgres.internal.acme.com"
db_name: "acme_001_prod"
ingress_host: "app.acme-corp.com"
resource_tier: "enterprise"
```

## Generator 4: Matrix Generator

The Matrix generator creates the Cartesian product of two generators, enabling "deploy every service to every cluster":

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: all-services-all-clusters
  namespace: argocd
spec:
  generators:
    - matrix:
        generators:
          # First dimension: clusters (from Git file)
          - git:
              repoURL: https://github.com/acme-corp/fleet-registry
              revision: main
              files:
                - path: "clusters/*.yaml"

          # Second dimension: services (from Git directory)
          - git:
              repoURL: https://github.com/acme-corp/services
              revision: main
              directories:
                - path: "services/*"

  template:
    metadata:
      name: "{{cluster_name}}-{{path.basename}}"
    spec:
      project: "{{project}}"

      source:
        repoURL: https://github.com/acme-corp/services
        targetRevision: main
        path: "{{path}}"
        helm:
          values: |
            cluster: {{cluster_name}}
            environment: {{environment}}
            region: {{region}}

      destination:
        server: "{{cluster_server}}"
        namespace: "{{path.basename}}"

      syncPolicy:
        automated:
          prune: true
          selfHeal: "{{auto_sync}}"
        syncOptions:
          - CreateNamespace=true
```

Cluster configuration files:

```yaml
# clusters/prod-us-east.yaml
cluster_name: prod-us-east
cluster_server: "https://k8s-prod-us-east.internal.acme.com"
environment: production
region: us-east-1
project: production
auto_sync: "true"

# clusters/dev-eu-west.yaml
cluster_name: dev-eu-west
cluster_server: "https://k8s-dev-eu-west.internal.acme.com"
environment: development
region: eu-west-1
project: development
auto_sync: "true"
```

## Generator 5: Merge Generator

The Merge generator combines multiple generators, with later generators overriding values from earlier ones. This is useful for defining defaults with per-environment or per-cluster overrides:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: payments-with-overrides
  namespace: argocd
spec:
  generators:
    - merge:
        mergeKeys:
          - cluster_name

        generators:
          # Base configuration: defaults for all clusters
          - list:
              elements:
                - cluster_name: dev
                  replicas: "1"
                  resource_tier: small
                  enable_canary: "false"
                  log_level: debug

                - cluster_name: staging
                  replicas: "2"
                  resource_tier: medium
                  enable_canary: "true"
                  log_level: info

                - cluster_name: production
                  replicas: "5"
                  resource_tier: large
                  enable_canary: "true"
                  log_level: warn

          # Override: get cluster server URLs from ArgoCD cluster registry
          - clusters:
              selector: {}
              values:
                # cluster.name from ArgoCD maps to cluster_name
                cluster_name: "{{name}}"
                cluster_server: "{{server}}"

  template:
    metadata:
      name: "payments-{{cluster_name}}"
    spec:
      project: payments

      source:
        repoURL: https://github.com/acme-corp/payments-service
        targetRevision: main
        path: k8s/base
        helm:
          values: |
            replicaCount: {{replicas}}
            resources:
              tier: {{resource_tier}}
            canary:
              enabled: {{enable_canary}}
            logging:
              level: {{log_level}}

      destination:
        server: "{{cluster_server}}"
        namespace: payments

      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

## Progressive Delivery with ApplicationSet

Combine ApplicationSet with Argo Rollouts for automated canary deployments:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: payments-progressive-delivery
  namespace: argocd
spec:
  generators:
    - list:
        elements:
          # Phase 1: Deploy to canary cluster first
          - cluster: prod-canary
            url: https://k8s-prod-canary.internal.acme.com
            weight: 5
            phase: canary

          # Phase 2: US East after canary validation
          - cluster: prod-us-east
            url: https://k8s-prod-us-east.internal.acme.com
            weight: 45
            phase: production

          # Phase 3: EU West
          - cluster: prod-eu-west
            url: https://k8s-prod-eu-west.internal.acme.com
            weight: 45
            phase: production

          # Phase 4: APAC
          - cluster: prod-ap-south
            url: https://k8s-prod-ap-south.internal.acme.com
            weight: 5
            phase: production

  template:
    metadata:
      name: "payments-{{cluster}}"
      annotations:
        notifications.argoproj.io/subscribe.on-sync-succeeded.slack: platform-deployments
        notifications.argoproj.io/subscribe.on-sync-failed.pagerduty: payments-oncall
    spec:
      project: payments

      source:
        repoURL: https://github.com/acme-corp/payments-service
        targetRevision: HEAD
        path: k8s/overlays/{{phase}}
        helm:
          values: |
            trafficWeight: {{weight}}

      destination:
        server: "{{url}}"
        namespace: payments

      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - RespectIgnoreDifferences=true
```

## ApplicationSet with Notifications

Configure ArgoCD Notifications for deployment status alerts:

```yaml
# argocd-notifications-cm ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-notifications-cm
  namespace: argocd
data:
  # Slack template for sync events
  template.app-sync-succeeded: |
    message: |
      *Deployment Succeeded* :white_check_mark:
      Application: {{.app.metadata.name}}
      Environment: {{.app.metadata.labels.environment}}
      Revision: {{.app.status.sync.revision}}
      Synced At: {{.app.status.operationState.finishedAt}}
    slack:
      attachments: |
        [{
          "color": "#18be52",
          "title": "{{.app.metadata.name}}",
          "title_link": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}",
          "fields": [
            {"title": "Revision", "value": "{{.app.status.sync.revision}}", "short": true},
            {"title": "Environment", "value": "{{.app.metadata.labels.environment}}", "short": true}
          ]
        }]

  template.app-sync-failed: |
    message: |
      *Deployment Failed* :x:
      Application: {{.app.metadata.name}}
      Error: {{.app.status.operationState.message}}
    slack:
      attachments: |
        [{
          "color": "#E96D76",
          "title": "{{.app.metadata.name}} - Sync Failed",
          "title_link": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}",
          "fields": [
            {"title": "Error", "value": "{{.app.status.operationState.message}}", "short": false}
          ]
        }]

  # Triggers
  trigger.on-sync-succeeded: |
    - description: Application synced successfully
      when: app.status.operationState.phase in ['Succeeded']
      send: [app-sync-succeeded]

  trigger.on-sync-failed: |
    - description: Application sync failed
      when: app.status.operationState.phase in ['Error', 'Failed']
      send: [app-sync-failed]
```

## ApplicationSet Security Patterns

### Namespace Isolation

```yaml
# Restrict ApplicationSet to specific namespaces
# argocd-cmd-params-cm
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cmd-params-cm
  namespace: argocd
data:
  # Only allow ApplicationSets in these namespaces
  applicationsetcontroller.namespaces: argocd,platform

---
# RBAC: Limit which namespaces teams can target
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: payments-team
  namespace: argocd
spec:
  description: Payments team project
  sourceRepos:
    - "https://github.com/acme-corp/payments-*"
  destinations:
    - namespace: "payments-*"
      server: "*"
  clusterResourceWhitelist:
    - group: ""
      kind: Namespace
  namespaceResourceWhitelist:
    - group: "*"
      kind: "*"
  roles:
    - name: deploy
      policies:
        - p, proj:payments-team:deploy, applications, sync, payments-team/*, allow
        - p, proj:payments-team:deploy, applications, get, payments-team/*, allow
      groups:
        - acme-corp:payments-team
```

### SCM Provider Authentication

```yaml
# Use a private SCM provider with credentials
apiVersion: v1
kind: Secret
metadata:
  name: github-creds
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: repo-creds
stringData:
  url: https://github.com/acme-corp
  username: x-access-token
  password: "github_pat_REDACTED"  # Use a PAT with repo read scope
type: Opaque
```

## Pull Request Generator

The PR generator creates Applications for open pull requests — essential for preview environments:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: pr-previews
  namespace: argocd
spec:
  generators:
    - pullRequest:
        github:
          owner: acme-corp
          repo: payments-service
          appSecretName: github-app-secret
          labels:
            - preview  # Only PRs with 'preview' label
        requeueAfterSeconds: 120

  template:
    metadata:
      name: "pr-{{number}}-payments"
      labels:
        environment: preview
        pr: "{{number}}"
    spec:
      project: previews

      source:
        repoURL: https://github.com/acme-corp/payments-service
        targetRevision: "{{head_sha}}"
        path: k8s/overlays/preview
        helm:
          values: |
            ingress:
              host: "pr-{{number}}.preview.payments.acme.com"
            image:
              tag: "pr-{{number}}"
            replicaCount: 1
            database:
              name: "payments_pr_{{number}}"

      destination:
        server: https://k8s-preview.internal.acme.com
        namespace: "pr-{{number}}-payments"

      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true

  # Delete preview environments when PR is merged/closed
  syncPolicy:
    preserveResourcesOnDeletion: false
```

## Debugging ApplicationSets

```bash
# Check ApplicationSet status
kubectl get applicationset -n argocd
kubectl describe applicationset microservices -n argocd

# View generated Applications
kubectl get applications -n argocd -l argocd.argoproj.io/applicationset=microservices

# Check ApplicationSet controller logs
kubectl logs -n argocd deploy/argocd-applicationset-controller --tail=100 -f

# Force reconciliation
kubectl annotate applicationset microservices -n argocd \
  argocd.argoproj.io/refresh=hard --overwrite

# Test generator output without creating Applications
# (dry run not natively supported — use this workaround)
argocd app list | grep "microservices-"

# Check for generator errors
kubectl get applicationset microservices -n argocd -o yaml | \
  grep -A 20 "status:"
```

## ApplicationSet Resource Customization

Use the `goTemplate` engine for more powerful templating:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: services-go-template
  namespace: argocd
spec:
  goTemplate: true
  goTemplateOptions: ["missingkey=error"]

  generators:
    - git:
        repoURL: https://github.com/acme-corp/services
        revision: main
        files:
          - path: "*/config.yaml"

  template:
    metadata:
      # Use Go template functions
      name: "{{ .path.basename }}-{{ .cluster | default \"default\" }}"
    spec:
      project: "{{ if eq .environment \"production\" }}production{{ else }}development{{ end }}"

      source:
        repoURL: https://github.com/acme-corp/services
        targetRevision: "{{ .targetRevision | default \"main\" }}"
        path: "{{ .path.path }}/k8s/{{ .environment }}"
        helm:
          values: |
            {{- if .customValues }}
            {{ toYaml .customValues | indent 12 }}
            {{- end }}
            environment: {{ .environment }}
            imageTag: "{{ .imageTag | default \"latest\" }}"

      destination:
        server: "{{ .clusterServer }}"
        namespace: "{{ .path.basename }}-{{ .environment }}"
```

## Conclusion

The ApplicationSet controller transforms ArgoCD from a single-application deployment tool into a fleet management system. The generator composability is particularly powerful: combining Git, Cluster, and Matrix generators enables fully automated multi-cluster deployments where adding a cluster to your fleet or a service to your repository automatically provisions the corresponding ArgoCD Applications.

Key patterns to remember: use the Git file generator for environment-specific configuration stored alongside the fleet registry, the cluster generator for infrastructure-level components that must run everywhere, the matrix generator for the Cartesian product deployment model, and the PR generator for ephemeral preview environments that match every open pull request. With notifications configured, your team gets real-time feedback on deployment status across every cluster and environment without manual monitoring.
