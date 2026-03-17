---
title: "Argo CD ApplicationSets: Dynamic Multi-Cluster and Multi-Environment Deployment"
date: 2030-06-26T00:00:00-05:00
draft: false
tags: ["ArgoCD", "GitOps", "ApplicationSets", "Kubernetes", "Multi-Cluster", "CD", "Generators"]
categories:
- Kubernetes
- DevOps
- GitOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Production ApplicationSets: list, cluster, git directory, and matrix generators, template patches, sync policies, progressive rollouts across clusters, and managing 100+ applications with generators."
more_link: "yes"
url: "/argocd-applicationsets-dynamic-multi-cluster-deployment/"
---

Managing dozens of Argo CD Application resources by hand is sustainable only in small environments. As teams scale to dozens of clusters, hundreds of services, and multiple environments per service, the manual Application approach collapses under its own weight: every new environment requires touching manifests, every new cluster requires duplicating configuration, and drift between environments is invisible until something breaks. ApplicationSets solve this by generating Application resources dynamically from parameterized templates and generators, enabling a single ApplicationSet to manage an application's entire lifecycle across all environments and clusters.

<!--more-->

## ApplicationSet Architecture

An ApplicationSet is a Kubernetes custom resource that the ApplicationSet controller (bundled with Argo CD 2.3+) watches. The controller evaluates the ApplicationSet's generators, renders the Application template for each generated parameter set, and creates, updates, or deletes the resulting Application objects.

```
ApplicationSet
├── Generators (produce parameter sets)
│   ├── List (static parameter sets)
│   ├── Clusters (from Argo CD cluster secrets)
│   ├── Git (from repository structure)
│   ├── Matrix (cartesian product of other generators)
│   └── Merge (combine generators with overrides)
└── Template (Application spec with parameter substitution)
    └── Generates Application objects
        ├── app-dev
        ├── app-staging
        └── app-production
```

## List Generator

The list generator is the simplest: it iterates over a static list of parameter sets. Use it for environments with fixed, well-known properties.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: podinfo
  namespace: argocd
spec:
  generators:
  - list:
      elements:
      - cluster: dev
        url: https://k8s-dev.internal.company.com
        namespace: podinfo-dev
        replicaCount: "1"
        resources: low
        imageTag: "6.5.0-dev"
      - cluster: staging
        url: https://k8s-staging.internal.company.com
        namespace: podinfo-staging
        replicaCount: "2"
        resources: medium
        imageTag: "6.5.0"
      - cluster: production-us-east
        url: https://k8s-prod-use1.internal.company.com
        namespace: podinfo-prod
        replicaCount: "5"
        resources: high
        imageTag: "6.5.0"
      - cluster: production-eu-west
        url: https://k8s-prod-euw1.internal.company.com
        namespace: podinfo-prod
        replicaCount: "5"
        resources: high
        imageTag: "6.5.0"
  template:
    metadata:
      name: "podinfo-{{cluster}}"
      labels:
        app.kubernetes.io/name: podinfo
        environment: "{{cluster}}"
      annotations:
        notifications.argoproj.io/subscribe.on-sync-failed.slack: devops-alerts
    spec:
      project: microservices
      source:
        repoURL: https://github.com/company/gitops-configs
        targetRevision: HEAD
        path: "apps/podinfo/{{cluster}}"
        helm:
          valueFiles:
          - values-{{resources}}.yaml
          parameters:
          - name: replicaCount
            value: "{{replicaCount}}"
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
        - PrunePropagationPolicy=foreground
        - ServerSideApply=true
        retry:
          limit: 5
          backoff:
            duration: 5s
            factor: 2
            maxDuration: 3m
```

## Cluster Generator

The cluster generator dynamically discovers clusters registered in Argo CD and creates Applications for each. When a new cluster is added to Argo CD, the ApplicationSet automatically generates the corresponding Application without any additional configuration.

### Basic Cluster Generator

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: cluster-addons
  namespace: argocd
spec:
  generators:
  - clusters:
      # Apply to all clusters
      selector:
        matchLabels:
          cluster-type: eks
  template:
    metadata:
      name: "cluster-addons-{{name}}"
    spec:
      project: cluster-addons
      source:
        repoURL: https://github.com/company/cluster-addons
        targetRevision: HEAD
        path: addons
        helm:
          valueFiles:
          - values-{{metadata.labels.environment}}.yaml
      destination:
        server: "{{server}}"
        namespace: kube-system
      syncPolicy:
        automated:
          prune: false
          selfHeal: true
```

### Cluster Generator with Selectors

Label clusters to control which ApplicationSets apply to them:

```bash
# Label clusters in Argo CD
argocd cluster set https://k8s-prod-use1.internal.company.com \
    --label environment=production \
    --label region=us-east-1 \
    --label cluster-tier=tier1

argocd cluster set https://k8s-dev.internal.company.com \
    --label environment=development \
    --label region=us-east-1 \
    --label cluster-tier=tier3
```

```yaml
# Apply only to production clusters in us-east-1
spec:
  generators:
  - clusters:
      selector:
        matchLabels:
          environment: production
          region: us-east-1
      values:
        # Custom values injected into template parameters
        alertChannel: production-us
        replicaCount: "5"
```

### Cluster Generator with Values

The `values` field injects additional parameters that are not available from the cluster secret:

```yaml
spec:
  generators:
  - clusters:
      selector:
        matchExpressions:
        - key: environment
          operator: In
          values: [staging, production]
      values:
        kustomizeOverlay: "{{metadata.labels.environment}}"
        maxSurge: "25%"
        minAvailable: "1"
```

## Git Generator

The git generator creates Applications based on the directory structure or file contents of a Git repository. This is the most powerful generator for teams that store per-application or per-environment configuration in directories.

### Git Directory Generator

Detect applications from directory structure:

```
gitops-repo/
├── apps/
│   ├── api-gateway/
│   │   ├── dev/
│   │   ├── staging/
│   │   └── production/
│   ├── user-service/
│   │   ├── dev/
│   │   ├── staging/
│   │   └── production/
│   └── payment-service/
│       ├── dev/
│       └── production/
```

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: all-apps
  namespace: argocd
spec:
  generators:
  - git:
      repoURL: https://github.com/company/gitops-repo
      revision: HEAD
      directories:
      - path: "apps/*/*"  # Match app/environment paths
      - path: "apps/legacy/*"
        exclude: true  # Exclude legacy apps
  template:
    metadata:
      # apps/api-gateway/dev -> name: api-gateway-dev
      name: "{{path[1]}}-{{path[2]}}"
      labels:
        app-name: "{{path[1]}}"
        environment: "{{path[2]}}"
    spec:
      project: "{{path[2]}}"  # Project per environment
      source:
        repoURL: https://github.com/company/gitops-repo
        targetRevision: HEAD
        path: "{{path}}"
      destination:
        server: "https://k8s-{{path[2]}}.internal.company.com"
        namespace: "{{path[1]}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
        - CreateNamespace=true
```

### Git File Generator

Generate Applications from JSON or YAML files within the repository. This provides more structured parameterization than directory naming:

```
gitops-repo/
└── cluster-config/
    ├── us-east-1-prod.json
    ├── us-west-2-prod.json
    ├── eu-west-1-prod.json
    └── us-east-1-dev.json
```

```json
// cluster-config/us-east-1-prod.json
{
  "cluster": {
    "name": "prod-use1",
    "url": "https://k8s-prod-use1.internal.company.com",
    "environment": "production",
    "region": "us-east-1",
    "replicaCount": 5,
    "storageClass": "gp3",
    "nodeSelector": {
      "node.kubernetes.io/instance-type": "m6i.2xlarge"
    }
  }
}
```

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: app-from-config-files
  namespace: argocd
spec:
  generators:
  - git:
      repoURL: https://github.com/company/gitops-repo
      revision: HEAD
      files:
      - path: "cluster-config/*-prod.json"
  template:
    metadata:
      name: "myapp-{{cluster.name}}"
    spec:
      project: production
      source:
        repoURL: https://github.com/company/gitops-repo
        targetRevision: HEAD
        path: apps/myapp
        helm:
          parameters:
          - name: replicaCount
            value: "{{cluster.replicaCount}}"
          - name: global.region
            value: "{{cluster.region}}"
          - name: storageClass
            value: "{{cluster.storageClass}}"
      destination:
        server: "{{cluster.url}}"
        namespace: myapp
```

## Matrix Generator

The matrix generator produces the cartesian product of two or more generators. This is essential for deploying all applications to all clusters without enumerating every combination:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: all-services-all-envs
  namespace: argocd
spec:
  generators:
  - matrix:
      generators:
      # First generator: all services (from git directories)
      - git:
          repoURL: https://github.com/company/services
          revision: HEAD
          directories:
          - path: "services/*"
          - path: "services/deprecated/*"
            exclude: true
      # Second generator: all clusters matching selector
      - clusters:
          selector:
            matchLabels:
              managed-by: platform-team
          values:
            # These values are available in the template
            deploymentStrategy: "RollingUpdate"
  template:
    metadata:
      name: "{{path.basename}}-{{name}}"
      annotations:
        argocd.argoproj.io/manifest-generate-paths: "/services/{{path.basename}}"
    spec:
      project: "{{metadata.labels.environment}}"
      source:
        repoURL: https://github.com/company/services
        targetRevision: HEAD
        path: "{{path}}"
        helm:
          valueFiles:
          - values-{{metadata.labels.environment}}.yaml
      destination:
        server: "{{server}}"
        namespace: "{{path.basename}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
        - CreateNamespace=true
```

### Matrix with Three Generators

For extremely large-scale deployments, nest matrix generators:

```yaml
spec:
  generators:
  - matrix:
      generators:
      - matrix:
          generators:
          - list:
              elements:
              - tier: frontend
              - tier: backend
              - tier: data
          - git:
              repoURL: https://github.com/company/services
              revision: HEAD
              directories:
              - path: "{{tier}}/*"
      - clusters:
          selector:
            matchLabels:
              region: us-east-1
```

## Template Patches

Template patches allow overriding specific template fields for specific generated Applications based on conditions. This avoids duplicating entire ApplicationSets for minor variations:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: service-with-patches
  namespace: argocd
spec:
  generators:
  - list:
      elements:
      - env: dev
        cluster: https://k8s-dev.internal.company.com
        automated: "true"
      - env: staging
        cluster: https://k8s-staging.internal.company.com
        automated: "true"
      - env: production
        cluster: https://k8s-prod-use1.internal.company.com
        automated: "false"
  template:
    metadata:
      name: "myservice-{{env}}"
    spec:
      project: "{{env}}"
      source:
        repoURL: https://github.com/company/gitops
        targetRevision: HEAD
        path: "apps/myservice/{{env}}"
      destination:
        server: "{{cluster}}"
        namespace: myservice
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
  # Template patches override specific fields per-element
  templatePatch: |
    spec:
      syncPolicy:
        automated:
          prune: {{automated}}
          selfHeal: {{automated}}
        {{- if eq .automated "false" }}
        syncOptions:
        - ApplyOutOfSyncOnly=true
        {{- end}}
```

## Sync Policies for Production Safety

### Preventing Automated Sync in Production

For production environments, automated sync should create applications but require manual approval for destructive operations:

```yaml
# Production ApplicationSet with conservative sync
spec:
  generators:
  - list:
      elements:
      - env: production
        cluster: https://k8s-prod.internal.company.com
  template:
    metadata:
      name: "critical-service-{{env}}"
    spec:
      syncPolicy:
        # Automated: allow sync but not prune
        automated:
          prune: false   # Never auto-delete resources in production
          selfHeal: true # Self-heal drift in existing resources
        syncOptions:
        - PruneLast=true          # Run prune after all other sync steps
        - ApplyOutOfSyncOnly=true # Only sync resources that differ
        - RespectIgnoreDifferences=true
        retry:
          limit: 3
          backoff:
            duration: 30s
            factor: 2
            maxDuration: 5m
      ignoreDifferences:
      # Ignore HPA current replica count
      - group: autoscaling
        kind: HorizontalPodAutoscaler
        jsonPointers:
        - /spec/replicas
      # Ignore cert-manager injected fields
      - group: ""
        kind: Secret
        name: "tls-cert"
        jsonPointers:
        - /data
```

### Resource Health Checks

Configure custom health checks for resources that Argo CD does not know about natively:

```yaml
# argocd-cm ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  resource.customizations.health.certmanager.k8s.io_Certificate: |
    hs = {}
    if obj.status ~= nil then
      if obj.status.conditions ~= nil then
        for i, condition in ipairs(obj.status.conditions) do
          if condition.type == "Ready" and condition.status == "False" then
            hs.status = "Degraded"
            hs.message = condition.message
            return hs
          end
          if condition.type == "Ready" and condition.status == "True" then
            hs.status = "Healthy"
            hs.message = condition.message
            return hs
          end
        end
      end
    end
    hs.status = "Progressing"
    hs.message = "Waiting for certificate"
    return hs

  resource.customizations.ignoreDifferences.admissionregistration.k8s.io_MutatingWebhookConfiguration: |
    jsonPointers:
    - /webhooks/0/clientConfig/caBundle
```

## Progressive Rollouts Across Clusters

ApplicationSets can be combined with Argo CD's notification system to implement progressive delivery: promote to dev, wait for health checks, promote to staging, run smoke tests, promote to production.

### Progressive Sync Waves

Use sync waves to control the order of resource creation within an Application:

```yaml
# In a Helm chart or Kustomize manifests
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
  annotations:
    argocd.argoproj.io/sync-wave: "2"  # Deploy after CRDs (wave 0) and ConfigMaps (wave 1)
```

### Multi-Cluster Progressive Strategy with Notifications

```yaml
# argocd-notifications-cm ConfigMap snippet
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-notifications-cm
  namespace: argocd
data:
  trigger.on-sync-succeeded-dev: |
    - when: app.status.sync.status == 'Synced' and app.status.health.status == 'Healthy'
      oncePer: app.status.sync.revision
      send: [promote-to-staging]

  template.promote-to-staging: |
    webhook:
      promotion-service:
        method: POST
        path: /promote
        body: |
          {
            "app": "{{.app.metadata.name}}",
            "revision": "{{.app.status.sync.revision}}",
            "from_env": "dev",
            "to_env": "staging"
          }
```

### Rollout Strategy with ApplicationSet and Argo Rollouts

```yaml
# Canary rollout ApplicationSet
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: payment-service-progressive
  namespace: argocd
spec:
  generators:
  - list:
      elements:
      - env: dev
        weight: "100"
        strategy: Recreate
      - env: canary
        weight: "10"
        strategy: Canary
      - env: production
        weight: "90"
        strategy: Canary
  template:
    metadata:
      name: "payment-service-{{env}}"
    spec:
      source:
        path: "apps/payment-service"
        helm:
          parameters:
          - name: rollout.strategy
            value: "{{strategy}}"
          - name: rollout.canaryWeight
            value: "{{weight}}"
```

## Managing 100+ Applications

### ApplicationSet Organization Patterns

At scale, organize ApplicationSets by ownership boundary rather than technology:

```
argocd/
├── platform/
│   ├── cluster-addons-appset.yaml      # All clusters: monitoring, cert-manager, etc.
│   ├── ingress-appset.yaml             # Ingress controllers per cluster
│   └── security-appset.yaml           # Security tooling per environment
├── teams/
│   ├── platform-team/
│   │   └── shared-services-appset.yaml
│   ├── payments-team/
│   │   └── payment-services-appset.yaml
│   └── identity-team/
│       └── identity-services-appset.yaml
└── environments/
    ├── dev-applications-appset.yaml
    ├── staging-applications-appset.yaml
    └── production-applications-appset.yaml
```

### Project-Based Multi-Tenancy

```yaml
# Argo CD AppProject per team
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: payments-team
  namespace: argocd
spec:
  description: Payment processing services
  sourceRepos:
  - "https://github.com/company/payments-*"
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
  - name: payments-deployer
    description: Deploy access for payments team
    policies:
    - p, proj:payments-team:payments-deployer, applications, *, payments-team/*, allow
    - p, proj:payments-team:payments-deployer, applications, sync, payments-team/*, allow
    jwtTokens:
    - iat: 1700000000
  orphanedResources:
    warn: true
```

### ApplicationSet Deletion Policy

Control what happens to generated Applications when an ApplicationSet is deleted or an element is removed from a generator:

```yaml
spec:
  syncPolicy:
    # preserveResourcesOnDeletion: true prevents deleting cluster resources
    # when an Application is deleted
    preserveResourcesOnDeletion: true
  # applicationsetControllerOptions
  goTemplate: true
  goTemplateOptions: ["missingkey=error"]
```

## Troubleshooting ApplicationSets

### Debugging Generator Output

```bash
# Check ApplicationSet status and errors
kubectl describe applicationset podinfo -n argocd

# View generated Applications
kubectl get applications -n argocd -l "argocd.argoproj.io/application-set-name=podinfo"

# Check ApplicationSet controller logs
kubectl logs -n argocd \
  -l app.kubernetes.io/name=argocd-applicationset-controller \
  --tail=100 | grep -E "ERROR|error|podinfo"

# Dry-run ApplicationSet generation (show what would be created)
kubectl apply --dry-run=server -f applicationset.yaml
```

### Common Issues

**Generator produces no output:**
```bash
# Verify git repository access
kubectl exec -n argocd \
  deployment/argocd-applicationset-controller \
  -- argocd-applicationset-controller --loglevel=debug 2>&1 | grep -i "generator"

# Check cluster selector matches any clusters
kubectl get secrets -n argocd \
  -l "argocd.argoproj.io/secret-type=cluster" \
  -o custom-columns=NAME:.metadata.name,LABELS:.metadata.labels
```

**Template rendering errors:**
```bash
# Enable goTemplate and check for syntax errors
# ApplicationSet events show rendering errors
kubectl get events -n argocd \
  --field-selector reason=ApplicationSetRefresh | grep -i error

# Check for missing keys with goTemplate
# Add goTemplateOptions: ["missingkey=error"] to catch undefined parameters
```

**Applications not syncing after generation:**
```bash
# Force ApplicationSet reconciliation
kubectl patch applicationset podinfo -n argocd \
  --type=merge \
  -p '{"metadata":{"annotations":{"argocd.argoproj.io/refresh":"hard"}}}'

# Check individual Application status
kubectl get applications -n argocd -o wide | grep -E "OutOfSync|Degraded|Unknown"
```

## ApplicationSet with Kustomize

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: kustomize-multi-env
  namespace: argocd
spec:
  generators:
  - list:
      elements:
      - env: dev
        cluster: https://k8s-dev.internal.company.com
      - env: staging
        cluster: https://k8s-staging.internal.company.com
      - env: production
        cluster: https://k8s-prod.internal.company.com
  template:
    metadata:
      name: "webapp-{{env}}"
    spec:
      project: default
      source:
        repoURL: https://github.com/company/webapp
        targetRevision: HEAD
        # Each environment has its own kustomize overlay
        path: "k8s/overlays/{{env}}"
        kustomize:
          # Force image tag for all environments from a single parameter
          images:
          - "company/webapp:{{env}}-latest"
          commonAnnotations:
            deployment.kubernetes.io/environment: "{{env}}"
      destination:
        server: "{{cluster}}"
        namespace: webapp
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
        - CreateNamespace=true
```

## Production Best Practices

**Separate ApplicationSets by lifecycle**: Platform ApplicationSets (cluster-addons, monitoring) should be in separate files from application ApplicationSets. Platform changes need careful review; application changes are routine.

**Use goTemplate for complex logic**: The default `{{parameter}}` substitution is limited. Enable `goTemplate: true` for conditionals, range loops, and the full power of Go templates.

**Pin revision for production**: Use a specific Git commit SHA or tag for production Applications rather than HEAD. Track the current deployed version explicitly.

**Resource tracking**: Use `trackingMethod: annotation+label` to avoid Kubernetes resource ownership conflicts when multiple controllers manage the same namespace.

**Notification integration**: Wire ApplicationSet changes to Slack or PagerDuty notifications. Failed syncs and drift in production should generate alerts.

ApplicationSets transform Argo CD from a per-application deployment tool into a fleet management platform. A mature implementation can generate hundreds of consistently configured Applications from a handful of ApplicationSets, with per-cluster and per-environment customization driven entirely by repository structure.
