---
title: "Open Cluster Management: Multi-Cluster Governance and Policy Enforcement"
date: 2027-02-18T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Open Cluster Management", "Multi-Cluster", "Policy", "Governance"]
categories: ["Kubernetes", "Multi-Cluster", "Governance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Open Cluster Management for multi-cluster Kubernetes governance, covering hub/managed cluster architecture, ManifestWork, Placement API, policy enforcement, add-ons, and integration with ArgoCD and Flux."
more_link: "yes"
url: "/open-cluster-management-multicluster-kubernetes-guide/"
---

**Open Cluster Management (OCM)** is a CNCF sandbox project that provides a vendor-neutral multi-cluster control plane for Kubernetes. It separates the concerns of cluster registration, workload distribution, and policy governance through a clean API surface centered on the **hub cluster** — a management plane that stores cluster state and desired configuration — and **managed clusters** running a lightweight `klusterlet` agent that pulls instructions from the hub. This guide walks through the full OCM stack: registering clusters, distributing workloads with ManifestWork, selecting clusters with the Placement API, enforcing governance with Policy and PolicySet, and extending functionality with the add-on framework.

<!--more-->

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    Hub Cluster                               │
│                                                              │
│  ┌──────────────────┐  ┌──────────────────────────────────┐  │
│  │  cluster-manager  │  │   OCM Hub CRDs                  │  │
│  │  (control plane)  │  │   ManagedCluster                │  │
│  └──────────────────┘  │   ManagedClusterSet              │  │
│                         │   ManifestWork                  │  │
│  ┌──────────────────┐  │   Placement / PlacementDecision  │  │
│  │  placement       │  │   Policy / PolicySet             │  │
│  │  (scheduler)     │  └──────────────────────────────────┘  │
│  └──────────────────┘                                        │
└──────────────────────┬───────────────────────────────────────┘
                       │  mTLS / CSR
         ┌─────────────┼─────────────┐
         ▼             ▼             ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ Managed      │ │ Managed      │ │ Managed      │
│ Cluster: us  │ │ Cluster: eu  │ │ Cluster: ap  │
│              │ │              │ │              │
│ klusterlet   │ │ klusterlet   │ │ klusterlet   │
│ work-agent   │ │ work-agent   │ │ work-agent   │
│ registration │ │ registration │ │ registration │
│ -agent       │ │ -agent       │ │ -agent       │
└──────────────┘ └──────────────┘ └──────────────┘
```

### Key Components

- **cluster-manager** — runs on the hub, manages cluster registrations, CRD lifecycle, and add-on coordination
- **klusterlet** — runs on each managed cluster, composed of a `registration-agent` and a `work-agent`
- **registration-agent** — handles cluster registration, CSR approval, and hub kubeconfig rotation
- **work-agent** — watches `ManifestWork` objects on the hub and applies/removes resources on the managed cluster
- **placement** — schedules `ManagedCluster` selection based on predicates and add-on scores

## Installation

### Hub Cluster Setup

```bash
#!/bin/bash
set -euo pipefail

OCM_VERSION="v0.13.0"

# Install the clusteradm CLI
curl -L https://raw.githubusercontent.com/open-cluster-management-io/clusteradm/main/install.sh | bash

# Initialize the hub (creates cluster-manager and hub CRDs)
clusteradm init \
  --wait \
  --bundle-version "${OCM_VERSION}"

# Save the join command token (will be used to register managed clusters)
clusteradm get token > /tmp/hub-token.txt
cat /tmp/hub-token.txt

echo "Hub initialization complete"
kubectl get pods -n open-cluster-management
kubectl get managedclusters
```

Alternative Helm-based installation for GitOps workflows:

```bash
# Install OCM hub via Helm
helm repo add ocm https://open-cluster-management.io/helm-charts
helm repo update

helm upgrade --install cluster-manager ocm/cluster-manager \
  --namespace open-cluster-management \
  --create-namespace \
  --set replicaCount=3 \
  --set hubApiServer="https://hub-api.example.com:6443" \
  --wait

# Install the placement controller
helm upgrade --install placement ocm/placement \
  --namespace open-cluster-management \
  --set replicaCount=3 \
  --wait
```

### Registering Managed Clusters

```bash
#!/bin/bash
# Run on the MANAGED cluster

OCM_HUB_TOKEN="REPLACE_WITH_HUB_TOKEN_FROM_CLUSTERADM_GET_TOKEN"
HUB_API_SERVER="https://hub-api.example.com:6443"
CLUSTER_NAME="us-east-1-prod"

# Join the hub
clusteradm join \
  --token "${OCM_HUB_TOKEN}" \
  --hub-apiserver "${HUB_API_SERVER}" \
  --cluster-name "${CLUSTER_NAME}" \
  --wait

echo "Cluster ${CLUSTER_NAME} joined. Waiting for CSR approval on hub..."
```

```bash
# Run on the HUB cluster — approve the CSR
clusteradm accept --clusters us-east-1-prod
clusteradm accept --clusters eu-west-1-prod
clusteradm accept --clusters ap-southeast-1-prod

# Verify registration
kubectl get managedclusters
```

### Labeling Clusters for Placement

```yaml
# ManagedCluster — add labels for Placement filtering
apiVersion: cluster.open-cluster-management.io/v1
kind: ManagedCluster
metadata:
  name: us-east-1-prod
  labels:
    cluster.open-cluster-management.io/clusterset: production
    region: us-east-1
    environment: production
    cloud: aws
    tier: tier-1
    k8s-version: "1.30"
spec:
  hubAcceptsClient: true
  leaseDurationSeconds: 60
---
apiVersion: cluster.open-cluster-management.io/v1
kind: ManagedCluster
metadata:
  name: eu-west-1-prod
  labels:
    cluster.open-cluster-management.io/clusterset: production
    region: eu-west-1
    environment: production
    cloud: aws
    tier: tier-1
    k8s-version: "1.30"
spec:
  hubAcceptsClient: true
  leaseDurationSeconds: 60
---
apiVersion: cluster.open-cluster-management.io/v1
kind: ManagedCluster
metadata:
  name: us-east-1-dev
  labels:
    cluster.open-cluster-management.io/clusterset: development
    region: us-east-1
    environment: development
    cloud: aws
    tier: tier-2
    k8s-version: "1.30"
spec:
  hubAcceptsClient: true
  leaseDurationSeconds: 60
```

### ManagedClusterSets

```yaml
# ManagedClusterSet — logical grouping of clusters
apiVersion: cluster.open-cluster-management.io/v1beta2
kind: ManagedClusterSet
metadata:
  name: production
---
apiVersion: cluster.open-cluster-management.io/v1beta2
kind: ManagedClusterSet
metadata:
  name: development
---
# ManagedClusterSetBinding — expose a ClusterSet to a namespace
apiVersion: cluster.open-cluster-management.io/v1beta2
kind: ManagedClusterSetBinding
metadata:
  name: production
  namespace: app-team-a
spec:
  clusterSet: production
```

## ManifestWork: Distributing Workloads

**ManifestWork** is the primary mechanism for pushing Kubernetes resources from the hub to a managed cluster. The work-agent on the managed cluster watches ManifestWork objects in its cluster namespace on the hub and reconciles the desired state.

```yaml
# ManifestWork — deploy a namespace and application to us-east-1-prod
apiVersion: work.open-cluster-management.io/v1
kind: ManifestWork
metadata:
  name: order-service-deployment
  namespace: us-east-1-prod   # namespace = cluster name on the hub
spec:
  workload:
    manifests:
      # Namespace
      - apiVersion: v1
        kind: Namespace
        metadata:
          name: order-service
          labels:
            team: platform
            environment: production

      # Deployment
      - apiVersion: apps/v1
        kind: Deployment
        metadata:
          name: order-service
          namespace: order-service
        spec:
          replicas: 3
          selector:
            matchLabels:
              app: order-service
          template:
            metadata:
              labels:
                app: order-service
            spec:
              containers:
                - name: order-service
                  image: registry.example.com/order-service:2.4.1
                  ports:
                    - containerPort: 8080
                  resources:
                    requests:
                      cpu: 200m
                      memory: 256Mi
                    limits:
                      cpu: 1000m
                      memory: 512Mi

      # Service
      - apiVersion: v1
        kind: Service
        metadata:
          name: order-service
          namespace: order-service
        spec:
          selector:
            app: order-service
          ports:
            - port: 80
              targetPort: 8080

  # ManifestWork executor — which RBAC identity runs the apply
  executor:
    subject:
      type: ServiceAccount
      serviceAccount:
        namespace: open-cluster-management-agent
        name: klusterlet-work-sa

  # Update strategy
  manifestConfigs:
    - resourceIdentifier:
        group: apps
        resource: deployments
        namespace: order-service
        name: order-service
      updateStrategy:
        type: ServerSideApply
        serverSideApply:
          force: false
          fieldManager: open-cluster-management
```

```bash
# Check ManifestWork status — view which manifests are applied
kubectl get manifestwork order-service-deployment -n us-east-1-prod -o yaml | \
  grep -A 30 "status:"

# Check resource conditions on the managed cluster via the hub
kubectl get manifestwork order-service-deployment \
  -n us-east-1-prod \
  -o jsonpath='{.status.conditions}' | python3 -m json.tool
```

## Placement API

The **Placement** API selects clusters based on label predicates and numeric scores provided by add-ons. **PlacementDecision** objects are created by the placement controller and consumed by ManifestWork controllers or GitOps tools.

```yaml
# Placement — select all production tier-1 clusters in AWS
apiVersion: cluster.open-cluster-management.io/v1beta1
kind: Placement
metadata:
  name: production-aws-tier1
  namespace: app-team-a
spec:
  clusterSets:
    - production
  numberOfClusters: 3
  predicates:
    - requiredClusterSelector:
        labelSelector:
          matchLabels:
            cloud: aws
            tier: tier-1
        claimSelector:
          matchExpressions:
            - key: platform.open-cluster-management.io/hosted-cluster
              operator: DoesNotExist
  prioritizerPolicy:
    mode: Additive
    configurations:
      # Prefer clusters with fewer running pods (load balance)
      - scoreCoordinate:
          type: AddOn
          addOn:
            resourceName: resource-usage-collect
            scoreName: cpuAvailableFraction
        weight: 2
      # Prefer clusters in the same region as the workload origin
      - scoreCoordinate:
          type: BuiltIn
          builtIn: Steady
        weight: 1
  spreadPolicy:
    spreadConstraints:
      - topologyKey: region
        topologyKeyType: Label
        maxSkew: 1
        whenUnsatisfiable: DoNotSchedule
```

```bash
# Check PlacementDecision — see which clusters were selected
kubectl get placementdecisions -n app-team-a -l placement=production-aws-tier1

# Get the selected cluster names
kubectl get placementdecisions \
  -n app-team-a \
  -l placement=production-aws-tier1 \
  -o jsonpath='{.items[*].status.decisions[*].clusterName}'
```

## Policy and PolicySet for Governance

The **Policy** API enforces configuration standards across managed clusters. The governance framework evaluates policies on managed clusters and reports compliance status back to the hub.

### Configuration Policies

```yaml
# Policy — enforce a namespace must exist on all production clusters
apiVersion: policy.open-cluster-management.io/v1
kind: Policy
metadata:
  name: require-monitoring-namespace
  namespace: policies
  annotations:
    policy.open-cluster-management.io/standards: NIST-CSF
    policy.open-cluster-management.io/categories: PR.IP Information Protection Processes
    policy.open-cluster-management.io/controls: PR.IP-1 Baseline Configuration
spec:
  disabled: false
  remediationAction: enforce
  policy-templates:
    - objectDefinition:
        apiVersion: policy.open-cluster-management.io/v1
        kind: ConfigurationPolicy
        metadata:
          name: require-monitoring-namespace
        spec:
          remediationAction: enforce
          severity: high
          object-templates:
            - complianceType: musthave
              objectDefinition:
                apiVersion: v1
                kind: Namespace
                metadata:
                  name: monitoring
                  labels:
                    pod-security.kubernetes.io/enforce: restricted
                    pod-security.kubernetes.io/audit: restricted
                    pod-security.kubernetes.io/warn: restricted
---
# PlacementBinding — bind the policy to all production clusters
apiVersion: policy.open-cluster-management.io/v1
kind: PlacementBinding
metadata:
  name: require-monitoring-ns-binding
  namespace: policies
placementRef:
  apiVersion: cluster.open-cluster-management.io/v1beta1
  kind: Placement
  name: production-aws-tier1
subjects:
  - apiVersion: policy.open-cluster-management.io/v1
    kind: Policy
    name: require-monitoring-namespace
```

### RBAC Governance Policy

```yaml
# Policy — enforce that no ClusterAdmin bindings exist outside system namespaces
apiVersion: policy.open-cluster-management.io/v1
kind: Policy
metadata:
  name: no-wildcard-clusterroles
  namespace: policies
  annotations:
    policy.open-cluster-management.io/standards: CIS Kubernetes Benchmark
    policy.open-cluster-management.io/categories: 5 Policies
    policy.open-cluster-management.io/controls: 5.1 RBAC and Service Accounts
spec:
  disabled: false
  remediationAction: inform
  policy-templates:
    - objectDefinition:
        apiVersion: policy.open-cluster-management.io/v1
        kind: ConfigurationPolicy
        metadata:
          name: no-wildcard-clusterroles
        spec:
          remediationAction: inform
          severity: critical
          namespaceSelector:
            exclude:
              - kube-*
              - open-cluster-management*
          object-templates:
            - complianceType: mustnothave
              objectDefinition:
                apiVersion: rbac.authorization.k8s.io/v1
                kind: ClusterRoleBinding
                subjects:
                  - kind: User
                    name: system:anonymous
            - complianceType: mustnothave
              objectDefinition:
                apiVersion: rbac.authorization.k8s.io/v1
                kind: ClusterRoleBinding
                roleRef:
                  name: cluster-admin
                  kind: ClusterRole
                subjects:
                  - kind: Group
                    name: system:unauthenticated
```

### Network Policy Enforcement

```yaml
# Policy — every namespace must have a default-deny NetworkPolicy
apiVersion: policy.open-cluster-management.io/v1
kind: Policy
metadata:
  name: require-default-deny-network-policy
  namespace: policies
spec:
  disabled: false
  remediationAction: enforce
  policy-templates:
    - objectDefinition:
        apiVersion: policy.open-cluster-management.io/v1
        kind: ConfigurationPolicy
        metadata:
          name: default-deny-network-policy
        spec:
          remediationAction: enforce
          severity: high
          namespaceSelector:
            include:
              - production
              - staging
            exclude:
              - kube-*
              - open-cluster-management*
              - monitoring
          object-templates:
            - complianceType: musthave
              objectDefinition:
                apiVersion: networking.k8s.io/v1
                kind: NetworkPolicy
                metadata:
                  name: default-deny-all
                spec:
                  podSelector: {}
                  policyTypes:
                    - Ingress
                    - Egress
```

### Pod Security Policy Enforcement

```yaml
# Policy — enforce Pod Security Standards
apiVersion: policy.open-cluster-management.io/v1
kind: Policy
metadata:
  name: pod-security-enforce
  namespace: policies
spec:
  disabled: false
  remediationAction: enforce
  policy-templates:
    - objectDefinition:
        apiVersion: policy.open-cluster-management.io/v1
        kind: ConfigurationPolicy
        metadata:
          name: pod-security-enforce
        spec:
          remediationAction: enforce
          severity: high
          namespaceSelector:
            include:
              - production
              - staging
            exclude:
              - kube-*
              - open-cluster-management*
          object-templates:
            # Enforce restricted Pod Security Standard via namespace labels
            - complianceType: musthave
              objectDefinition:
                apiVersion: v1
                kind: Namespace
                metadata:
                  labels:
                    pod-security.kubernetes.io/enforce: restricted
                    pod-security.kubernetes.io/enforce-version: latest
                    pod-security.kubernetes.io/audit: restricted
                    pod-security.kubernetes.io/warn: restricted
```

### PolicySet for Grouping Related Policies

```yaml
# PolicySet — group all CIS benchmark policies
apiVersion: policy.open-cluster-management.io/v1beta1
kind: PolicySet
metadata:
  name: cis-benchmark
  namespace: policies
spec:
  description: "CIS Kubernetes Benchmark compliance policies"
  policies:
    - no-wildcard-clusterroles
    - require-default-deny-network-policy
    - pod-security-enforce
    - require-monitoring-namespace
    - require-resource-limits
    - no-privileged-containers
---
# PlacementBinding for the PolicySet
apiVersion: policy.open-cluster-management.io/v1
kind: PlacementBinding
metadata:
  name: cis-benchmark-binding
  namespace: policies
placementRef:
  apiVersion: cluster.open-cluster-management.io/v1beta1
  kind: Placement
  name: production-aws-tier1
subjects:
  - apiVersion: policy.open-cluster-management.io/v1beta1
    kind: PolicySet
    name: cis-benchmark
```

```bash
# Check policy compliance across all clusters
kubectl get policy -n policies
kubectl get policy require-monitoring-namespace -n policies -o yaml | grep -A 20 "status:"

# Get compliance summary per cluster
kubectl get managedclusterpolicystatus -n policies

# Get all non-compliant policies
kubectl get policy -n policies \
  -o jsonpath='{range .items[?(@.status.compliant!="Compliant")]}{.metadata.name}{"\n"}{end}'
```

## Add-On Framework

The OCM **Add-On** framework provides a standardized mechanism for deploying and managing cluster agents beyond the core klusterlet.

### Application Lifecycle Add-On

```yaml
# ManagedClusterAddOn — enable the application lifecycle add-on
apiVersion: addon.open-cluster-management.io/v1alpha1
kind: ManagedClusterAddOn
metadata:
  name: application-manager
  namespace: us-east-1-prod
spec:
  installNamespace: open-cluster-management-agent-addon
```

```bash
# Enable the application manager add-on on all production clusters
for cluster in us-east-1-prod eu-west-1-prod ap-southeast-1-prod; do
  kubectl apply -f - <<EOF
apiVersion: addon.open-cluster-management.io/v1alpha1
kind: ManagedClusterAddOn
metadata:
  name: application-manager
  namespace: ${cluster}
spec:
  installNamespace: open-cluster-management-agent-addon
EOF
done

# Verify add-on status
kubectl get managedclusteraddon application-manager -n us-east-1-prod
```

### Observability Add-On

```yaml
# MultiClusterObservability — deploy centralized monitoring
apiVersion: observability.open-cluster-management.io/v1beta2
kind: MultiClusterObservability
metadata:
  name: observability
  namespace: open-cluster-management-observability
spec:
  storageConfig:
    metricObjectStorage:
      name: thanos-object-storage
      key: thanos.yaml
    statefulSetSize: "50Gi"
    statefulSetStorageClass: gp3
  observabilityAddonSpec:
    enableMetrics: true
    interval: 30
    resources:
      limits:
        cpu: 200m
        memory: 512Mi
      requests:
        cpu: 10m
        memory: 100Mi
  availabilityConfig: High
  nodeSelector:
    kubernetes.io/os: linux
  tolerations:
    - effect: NoSchedule
      key: node-role.kubernetes.io/infra
      operator: Exists
  retentionResolution1h: 30d
  retentionResolution5m: 14d
  retentionResolutionRaw: 5d
```

### Custom Add-On Development

```yaml
# ClusterManagementAddOn — register a custom add-on with the hub
apiVersion: addon.open-cluster-management.io/v1alpha1
kind: ClusterManagementAddOn
metadata:
  name: cert-policy-controller
  annotations:
    addon.open-cluster-management.io/lifecycle: addon-manager
spec:
  addonMeta:
    displayName: Certificate Policy Controller
    description: "Enforces certificate expiration policies across managed clusters"
  supportedConfigs:
    - group: addon.open-cluster-management.io
      resource: addondeploymentconfigs
  installStrategy:
    type: Placements
    placements:
      - name: production-aws-tier1
        namespace: policies
        configs:
          - group: addon.open-cluster-management.io
            resource: addondeploymentconfigs
            name: cert-policy-controller-config
            namespace: policies
```

## Integration with ArgoCD

OCM's Placement API can drive ArgoCD's `ApplicationSet` controller to automatically create ArgoCD `Application` objects for each cluster in a placement decision.

```yaml
# ApplicationSet — deploy to all clusters in the production PlacementDecision
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: order-service
  namespace: argocd
spec:
  generators:
    - clusterDecisionResource:
        configMapRef: ocm-placement-generator
        labelSelector:
          matchLabels:
            cluster.open-cluster-management.io/placement: production-aws-tier1
        requeueAfterSeconds: 60
  template:
    metadata:
      name: "order-service-{{name}}"
      labels:
        app.kubernetes.io/managed-by: argocd
    spec:
      project: production
      source:
        repoURL: https://git.example.com/platform/gitops.git
        targetRevision: main
        path: "apps/order-service/overlays/{{metadata.labels.environment}}"
      destination:
        server: "{{server}}"
        namespace: order-service
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
          - ServerSideApply=true
        retry:
          limit: 5
          backoff:
            duration: 5s
            factor: 2
            maxDuration: 3m
---
# ConfigMap required by the ArgoCD cluster-decision generator
apiVersion: v1
kind: ConfigMap
metadata:
  name: ocm-placement-generator
  namespace: argocd
data:
  apiVersion: cluster.open-cluster-management.io/v1alpha1
  kind: placementdecisions
  statusListKey: decisions
  matchKey: clusterName
```

## Integration with Flux

```yaml
# Kustomization — distribute a Flux Kustomization to managed clusters via ManifestWork
apiVersion: work.open-cluster-management.io/v1
kind: ManifestWork
metadata:
  name: flux-kustomization-order-service
  namespace: us-east-1-prod
spec:
  workload:
    manifests:
      - apiVersion: kustomize.toolkit.fluxcd.io/v1
        kind: Kustomization
        metadata:
          name: order-service
          namespace: flux-system
        spec:
          interval: 5m
          path: "./apps/order-service/overlays/production"
          prune: true
          sourceRef:
            kind: GitRepository
            name: platform-gitops
          targetNamespace: order-service
          timeout: 5m
          postBuild:
            substituteFrom:
              - kind: ConfigMap
                name: cluster-vars
```

## Troubleshooting

```bash
#!/bin/bash
# OCM diagnostics

# Check cluster registration status
kubectl get managedclusters -o wide
kubectl describe managedcluster us-east-1-prod | grep -A 20 "Conditions:"

# Check klusterlet health from the hub
kubectl get managedclusteraddons -n us-east-1-prod

# Check work-agent logs on the managed cluster
kubectl logs -n open-cluster-management-agent deployment/klusterlet-work-agent --tail 100

# Check registration-agent logs
kubectl logs -n open-cluster-management-agent deployment/klusterlet-registration-agent --tail 100

# Check ManifestWork apply status
kubectl get manifestworks -n us-east-1-prod
kubectl describe manifestwork order-service-deployment -n us-east-1-prod

# Debug placement decisions
kubectl get placementdecisions -n app-team-a
kubectl describe placementdecision -n app-team-a -l placement=production-aws-tier1

# Check policy compliance in detail
kubectl get certificatepolicies,configurationpolicies -n us-east-1-prod --all-namespaces

# Check hub cluster-manager logs
kubectl logs -n open-cluster-management deployment/cluster-manager-hub-controller-manager --tail 200

# Check placement controller
kubectl logs -n open-cluster-management deployment/placement-controller --tail 200
```

## Summary

Open Cluster Management provides a principled, CNCF-aligned multi-cluster Kubernetes control plane. The hub/klusterlet architecture keeps the managed cluster footprint minimal while enabling centralized governance. **ManifestWork** provides a reliable, status-reporting mechanism for distributing any Kubernetes resource. The **Placement API** replaces hand-crafted cluster lists with a scheduler that considers topology, labels, and add-on scores, enabling dynamic fleet management at scale. The **Policy and PolicySet** framework enforces RBAC, network, pod security, and custom configuration invariants across the entire fleet with `inform` mode for auditing and `enforce` mode for auto-remediation. For workload delivery, OCM integrates cleanly with ArgoCD ApplicationSets and Flux ManifestWork, allowing platform teams to use familiar GitOps tooling while OCM handles cluster selection and governance.
