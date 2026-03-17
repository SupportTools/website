---
title: "Kubernetes Multi-Cluster Management: Fleet Operations at Scale"
date: 2027-10-25T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Multi-Cluster", "Fleet", "Management", "ArgoCD"]
categories:
- Kubernetes
- Platform Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "Multi-cluster Kubernetes management at scale covering fleet topology patterns, Rancher Fleet, ArgoCD ApplicationSets, Cluster API, cross-cluster service discovery with Submariner, and operational practices for 50+ clusters."
more_link: "yes"
url: "/k8s-multi-cluster-management-guide/"
---

Managing a single Kubernetes cluster is a solved problem. Managing fifty clusters — across multiple cloud providers, regions, and compliance boundaries — is an ongoing engineering challenge. This guide covers the topology patterns, tooling, and operational practices that scale from ten clusters to several hundred.

<!--more-->

# Kubernetes Multi-Cluster Management: Fleet Operations at Scale

## Section 1: Fleet Topology Patterns

### Hub-and-Spoke

The hub cluster runs management tooling (ArgoCD, Rancher, cluster API controllers). Spoke clusters run workloads. The hub has network access to spoke clusters; spokes generally do not communicate with each other.

```
           ┌─────────────┐
           │  Hub Cluster │
           │  - ArgoCD    │
           │  - Rancher   │
           │  - Vault     │
           └──────┬───────┘
          ┌───────┼───────┐
          ▼       ▼       ▼
       Spoke-1  Spoke-2  Spoke-3
       (prod)   (prod)   (staging)
```

Best for: organizations where the platform team centrally manages all clusters and workload teams are consumers.

### Mesh (Federated)

Each cluster is a peer. Control planes are federated — any cluster can target any other. This is more complex but avoids the hub becoming a single point of failure.

```
Cluster-A ←→ Cluster-B ←→ Cluster-C
    ↑                           ↑
    └───────────────────────────┘
```

Best for: multiple autonomous platform teams that share infrastructure but maintain independence.

### Hierarchical

A root hub manages regional hubs, which each manage a group of spoke clusters. Used at organizations with hundreds of clusters spread across multiple data centers.

```
        Root Hub
       /         \
  Region-Hub-1  Region-Hub-2
  /   |   \        /   |
C1   C2   C3     C4   C5
```

---

## Section 2: Rancher Fleet for GitOps Across Clusters

Rancher Fleet is a GitOps engine designed specifically for multi-cluster management. It can manage hundreds of clusters with low control-plane overhead.

### Fleet Installation

```bash
# Install Fleet on the management cluster
helm repo add fleet https://rancher.github.io/fleet-helm-charts/
helm repo update

helm install fleet-crd fleet/fleet-crd \
  -n cattle-fleet-system --create-namespace \
  --version 0.10.0

helm install fleet fleet/fleet \
  -n cattle-fleet-system \
  --version 0.10.0 \
  --set apiServerURL="https://management-cluster.example.com:6443" \
  --set apiServerCA="$(kubectl get secret -n cattle-fleet-system fleet-controller-bootstrap-token -o jsonpath='{.data.value}' | base64 -d)"
```

### Registering Spoke Clusters

```bash
# Generate registration token on management cluster
kubectl apply -f - <<'EOF'
apiVersion: "fleet.cattle.io/v1alpha1"
kind: ClusterRegistrationToken
metadata:
  name: prod-registration-token
  namespace: fleet-default
spec:
  ttl: 24h
EOF

TOKEN=$(kubectl get clusterregistrationtoken prod-registration-token \
  -n fleet-default -o jsonpath='{.status.secretName}')
VALUES=$(kubectl get secret "$TOKEN" -n fleet-default -o jsonpath='{.data.values}' | base64 -d)

# On each spoke cluster, install the Fleet agent:
helm install fleet-agent fleet/fleet-agent \
  -n cattle-fleet-system --create-namespace \
  --version 0.10.0 \
  --set-string labels.env=production \
  --set-string labels.region=us-east-1 \
  $(echo "$VALUES" | yq -r 'to_entries | .[] | "--set " + .key + "=" + .value' | tr '\n' ' ')
```

### GitRepo with Cluster Selector

```yaml
# fleet/gitrepo-production.yaml — deploy to all clusters labeled env=production
apiVersion: fleet.cattle.io/v1alpha1
kind: GitRepo
metadata:
  name: myapp-production
  namespace: fleet-default
spec:
  repo: https://github.com/myorg/myapp-deployments
  branch: main
  paths:
    - k8s/production
  targets:
    - name: production-clusters
      clusterSelector:
        matchLabels:
          env: production
  pollingInterval: 30s
```

### Bundle Override per Cluster

```yaml
# fleet/gitrepo-with-overrides.yaml
apiVersion: fleet.cattle.io/v1alpha1
kind: GitRepo
metadata:
  name: myapp-all-envs
  namespace: fleet-default
spec:
  repo: https://github.com/myorg/myapp-deployments
  branch: main
  paths:
    - k8s/base
  targets:
    - name: staging
      clusterSelector:
        matchLabels:
          env: staging
      kustomize:
        dir: k8s/overlays/staging
    - name: production-us
      clusterSelector:
        matchLabels:
          env: production
          region: us-east-1
      kustomize:
        dir: k8s/overlays/production-us
    - name: production-eu
      clusterSelector:
        matchLabels:
          env: production
          region: eu-west-1
      kustomize:
        dir: k8s/overlays/production-eu
```

---

## Section 3: ArgoCD ApplicationSets for Multi-Cluster Deployments

ArgoCD ApplicationSets generate multiple ArgoCD Applications from a single template.

### Cluster Generator

```yaml
# applicationset-all-clusters.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: myapp-all-clusters
  namespace: argocd
spec:
  generators:
    - clusters:
        selector:
          matchLabels:
            argocd.argoproj.io/secret-type: cluster
            environment: production
  template:
    metadata:
      name: "myapp-{{name}}"
      labels:
        cluster: "{{name}}"
    spec:
      project: production
      source:
        repoURL: https://github.com/myorg/myapp-deployments
        targetRevision: main
        path: "k8s/clusters/{{name}}"
      destination:
        server: "{{server}}"
        namespace: myapp
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
          - PrunePropagationPolicy=foreground
        retry:
          limit: 3
          backoff:
            duration: 5s
            factor: 2
            maxDuration: 3m
```

### Matrix Generator — Environment x Region

```yaml
# applicationset-matrix.yaml — deploy all (environment, region) combinations
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: myapp-matrix
  namespace: argocd
spec:
  generators:
    - matrix:
        generators:
          - list:
              elements:
                - environment: staging
                  replicaCount: "1"
                  resourceProfile: small
                - environment: production
                  replicaCount: "3"
                  resourceProfile: large
          - list:
              elements:
                - region: us-east-1
                  clusterName: prod-us-east-1
                - region: eu-west-1
                  clusterName: prod-eu-west-1
                - region: ap-southeast-1
                  clusterName: prod-ap-se-1
  template:
    metadata:
      name: "myapp-{{environment}}-{{region}}"
    spec:
      project: default
      source:
        repoURL: https://github.com/myorg/myapp-deployments
        targetRevision: main
        path: k8s/base
        helm:
          valueFiles:
            - "../../values/{{environment}}.yaml"
            - "../../values/{{region}}.yaml"
          parameters:
            - name: replicaCount
              value: "{{replicaCount}}"
            - name: resources.profile
              value: "{{resourceProfile}}"
      destination:
        name: "{{clusterName}}"
        namespace: myapp-{{environment}}
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

### Pull Request Preview Environments

```yaml
# applicationset-pr-preview.yaml — create ephemeral environments for each PR
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: myapp-preview
  namespace: argocd
spec:
  generators:
    - pullRequest:
        github:
          owner: myorg
          repo: myapp
          tokenRef:
            secretName: github-token
            key: token
          labels:
            - preview
        requeueAfterSeconds: 60
  template:
    metadata:
      name: "myapp-pr-{{number}}"
      labels:
        pull-request: "{{number}}"
      annotations:
        notifications.argoproj.io/subscribe.on-deployed.slack: preview-environments
    spec:
      project: preview
      source:
        repoURL: https://github.com/myorg/myapp
        targetRevision: "{{head_sha}}"
        path: k8s/preview
        helm:
          parameters:
            - name: image.tag
              value: "pr-{{number}}"
            - name: ingress.host
              value: "pr-{{number}}.preview.example.com"
      destination:
        name: dev-cluster
        namespace: "pr-{{number}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
```

---

## Section 4: Cluster API for Cluster Lifecycle Management

Cluster API (CAPI) treats cluster creation as a Kubernetes API operation.

### Cluster Provisioning

```bash
# Initialize CAPI management cluster with AWS provider
clusterctl init --infrastructure aws

# Generate cluster manifest
clusterctl generate cluster prod-us-east-1a \
  --kubernetes-version v1.31.2 \
  --control-plane-machine-count=3 \
  --worker-machine-count=5 \
  --infrastructure aws \
  --flavor eks > cluster-prod-us-east-1a.yaml

# Apply the cluster manifest
kubectl apply -f cluster-prod-us-east-1a.yaml

# Watch cluster provisioning
clusterctl describe cluster prod-us-east-1a
kubectl get cluster prod-us-east-1a -w
```

### Machine Health Check for Self-Healing

```yaml
# machinehealthcheck.yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineHealthCheck
metadata:
  name: prod-us-east-1a-worker-mhc
  namespace: default
spec:
  clusterName: prod-us-east-1a
  maxUnhealthy: "33%"
  nodeStartupTimeout: 10m
  selector:
    matchLabels:
      cluster.x-k8s.io/deployment-name: prod-us-east-1a-worker
  unhealthyConditions:
    - type: Ready
      status: Unknown
      timeout: 5m
    - type: Ready
      status: "False"
      timeout: 10m
    - type: MemoryPressure
      status: "True"
      timeout: 2m
    - type: DiskPressure
      status: "True"
      timeout: 2m
```

### ClusterClass for Standardized Cluster Templates

```yaml
# clusterclass.yaml — define a reusable cluster shape
apiVersion: cluster.x-k8s.io/v1beta1
kind: ClusterClass
metadata:
  name: production-standard
  namespace: default
spec:
  controlPlane:
    ref:
      apiVersion: controlplane.cluster.x-k8s.io/v1beta2
      kind: AWSManagedControlPlaneTemplate
      name: production-cp-template
    machineInfrastructure:
      ref:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        kind: AWSMachineTemplate
        name: production-cp-machine-template
  infrastructure:
    ref:
      apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
      kind: AWSManagedClusterTemplate
      name: production-cluster-template
  workers:
    machineDeployments:
      - class: general
        template:
          bootstrap:
            ref:
              apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
              kind: EKSConfigTemplate
              name: production-bootstrap-template
          infrastructure:
            ref:
              apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
              kind: AWSMachineTemplate
              name: production-worker-machine-template
  variables:
    - name: workerCount
      required: true
      schema:
        openAPIV3Schema:
          type: integer
          minimum: 1
          maximum: 100
    - name: region
      required: true
      schema:
        openAPIV3Schema:
          type: string
          enum: [us-east-1, eu-west-1, ap-southeast-1]
```

---

## Section 5: Cross-Cluster Service Discovery with Submariner

Submariner creates an encrypted tunnel network between clusters, enabling pods in cluster A to reach services in cluster B using DNS:

```bash
# Install Submariner broker on the hub cluster
subctl deploy-broker --kubeconfig ~/.kube/hub.yaml

# Join spoke clusters
subctl join broker-info.subm \
  --kubeconfig ~/.kube/prod-us-east-1.yaml \
  --clusterid prod-us-east-1 \
  --natt=false  # disable if clusters have direct network access

subctl join broker-info.subm \
  --kubeconfig ~/.kube/prod-eu-west-1.yaml \
  --clusterid prod-eu-west-1 \
  --natt=false

# Export a service from cluster A (prod-us-east-1)
kubectl export service auth-service -n auth \
  --kubeconfig ~/.kube/prod-us-east-1.yaml

# Access it from cluster B using Lighthouse DNS:
# auth-service.auth.svc.clusterset.local
kubectl exec -n frontend deploy/frontend \
  --kubeconfig ~/.kube/prod-eu-west-1.yaml -- \
  curl http://auth-service.auth.svc.clusterset.local:8080/health
```

### ServiceExport CRD

```yaml
# service-export.yaml — export a service for cross-cluster discovery
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: auth-service
  namespace: auth
# No spec needed — exports the matching Service by name/namespace.
```

---

## Section 6: Multi-Cluster Networking with Skupper

Skupper creates an application-layer network that does not require pod CIDR overlap:

```bash
# Initialize Skupper on both clusters
skupper init --site-name prod-us-east-1 \
  --kubeconfig ~/.kube/prod-us-east-1.yaml \
  --namespace my-app

skupper init --site-name prod-eu-west-1 \
  --kubeconfig ~/.kube/prod-eu-west-1.yaml \
  --namespace my-app

# Link the sites
skupper token create link-token.yaml \
  --kubeconfig ~/.kube/prod-us-east-1.yaml

skupper link create link-token.yaml \
  --kubeconfig ~/.kube/prod-eu-west-1.yaml

# Expose a service across the link
skupper expose deployment/database \
  --kubeconfig ~/.kube/prod-us-east-1.yaml \
  --port 5432

# database:5432 is now accessible from prod-eu-west-1
kubectl exec -n my-app deploy/app \
  --kubeconfig ~/.kube/prod-eu-west-1.yaml -- \
  psql "postgres://user:pass@database:5432/mydb"
```

---

## Section 7: Operational Practices for 50+ Clusters

### Cluster Inventory and Metadata

```yaml
# argocd cluster secret with metadata labels (stored in argocd namespace)
apiVersion: v1
kind: Secret
metadata:
  name: prod-us-east-1a
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: cluster
    environment: production
    region: us-east-1
    tier: prod
    compliance: pci
    managed-by: capi
    k8s-version: "1.31"
type: Opaque
stringData:
  name: prod-us-east-1a
  server: https://prod-us-east-1a.k8s.example.com:6443
  config: |
    {
      "bearerToken": "<token>",
      "tlsClientConfig": {
        "insecure": false,
        "caData": "<base64-ca>"
      }
    }
```

### Fleet-Wide kubectl Operations

```bash
# Run a command across all production clusters
for cluster in $(kubectl get secrets -n argocd -l environment=production \
  -o jsonpath='{.items[*].metadata.name}'); do
  echo "=== $cluster ==="
  KUBECONFIG="/tmp/${cluster}.yaml" kubectl get nodes --no-headers | wc -l
done

# Or use kubeconfig aggregation with kubectx
# Generate a combined kubeconfig for all clusters:
for cluster in prod-us-east-1a prod-eu-west-1a prod-ap-se-1a; do
  kubectl get secret "$cluster" -n argocd -o jsonpath='{.data.config}' | \
    base64 -d | jq -r '.bearerToken' > "/tmp/${cluster}-token"
  # Build individual kubeconfig entries...
done
```

### Cluster Upgrade Automation

```bash
#!/usr/bin/env bash
# cluster-upgrade.sh — rolling Kubernetes version upgrade across fleet
# Usage: ./cluster-upgrade.sh 1.31.2 staging

TARGET_VERSION=$1
CLUSTER_LABEL=$2  # e.g., "environment=staging"

echo "Upgrading clusters matching label: $CLUSTER_LABEL to k8s $TARGET_VERSION"

# Get all matching clusters via CAPI
CLUSTERS=$(kubectl get cluster -A \
  -l "$CLUSTER_LABEL" \
  -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name} {end}')

for cluster in $CLUSTERS; do
  ns=$(echo "$cluster" | cut -d/ -f1)
  name=$(echo "$cluster" | cut -d/ -f2)

  echo "Upgrading $name in $ns..."

  # Patch the KubeadmControlPlane version
  kubectl patch kubeadmcontrolplane "${name}-control-plane" \
    -n "$ns" \
    --type merge \
    -p "{\"spec\":{\"version\":\"v${TARGET_VERSION}\"}}"

  # Wait for control plane to finish upgrading
  kubectl wait kubeadmcontrolplane "${name}-control-plane" \
    -n "$ns" \
    --for=condition=Ready \
    --timeout=30m

  echo "$name control plane upgraded successfully"

  # Upgrade worker machine deployments
  kubectl patch machinedeployment "${name}-workers" \
    -n "$ns" \
    --type merge \
    -p "{\"spec\":{\"template\":{\"spec\":{\"version\":\"v${TARGET_VERSION}\"}}}}"

  kubectl wait machinedeployment "${name}-workers" \
    -n "$ns" \
    --for=condition=Available \
    --timeout=60m

  echo "$name workers upgraded successfully"
done
```

### Cluster Health Dashboard

```yaml
# prometheus/fleet-rules.yaml
groups:
  - name: cluster-fleet
    rules:
      - alert: ClusterNodeNotReady
        expr: |
          kube_node_status_condition{condition="Ready",status="true"} == 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Node {{ $labels.node }} not ready in cluster {{ $labels.cluster }}"

      - alert: ClusterAPIServerUnreachable
        expr: |
          up{job="kubernetes-apiservers"} == 0
        for: 2m
        labels:
          severity: critical

      - alert: ClusterVersionOutdated
        expr: |
          (time() - kube_node_created) > 90 * 24 * 3600
          and on(cluster) label_replace(
            kube_node_info{kubelet_version!~"v1\\.3[1-9].*"},
            "cluster", "$1", "node", ".*"
          )
        labels:
          severity: warning
        annotations:
          summary: "Cluster {{ $labels.cluster }} running Kubernetes older than v1.31"

      - record: fleet:cluster_count
        expr: count(up{job="kubernetes-apiservers"}) by (environment, region)

      - record: fleet:cluster_node_count
        expr: sum(kube_node_info) by (cluster, environment, region)
```

---

## Section 8: Secrets Management Across Clusters

The External Secrets Operator syncs secrets from Vault/AWS SSM to all clusters:

```yaml
# external-secrets/clusterstore.yaml — deployed to each spoke cluster
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: vault-backend
spec:
  provider:
    vault:
      server: "https://vault.example.com"
      path: "secret"
      version: "v2"
      auth:
        kubernetes:
          mountPath: "kubernetes"
          role: "cluster-reader"
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets
```

```yaml
# external-secrets/externalsecret.yaml — provisioned per namespace by the golden path
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: myapp-secrets
  namespace: myapp
spec:
  refreshInterval: 1h
  secretStoreRef:
    kind: ClusterSecretStore
    name: vault-backend
  target:
    name: myapp-secrets
    creationPolicy: Owner
  data:
    - secretKey: DATABASE_URL
      remoteRef:
        key: "services/myapp/database"
        property: url
    - secretKey: API_KEY
      remoteRef:
        key: "services/myapp/api"
        property: key
```

This architecture — Fleet or ArgoCD for GitOps, CAPI for cluster lifecycle, Submariner for cross-cluster networking, and External Secrets for secrets sync — covers the complete operational surface of a multi-cluster Kubernetes fleet at scale.

---

## Section 9: Cluster-Level Resource Quotas and Policy Enforcement

When many teams share a fleet, enforce consistent resource quotas and policies across all clusters using a GitOps-delivered ClusterResourceQuota (OpenShift) or Kyverno ClusterPolicy:

```yaml
# fleet/gitrepo-policies.yaml — deploy quota policies to all clusters
apiVersion: fleet.cattle.io/v1alpha1
kind: GitRepo
metadata:
  name: cluster-policies
  namespace: fleet-default
spec:
  repo: https://github.com/myorg/fleet-policies
  branch: main
  paths:
    - policies/resource-quotas
    - policies/network-policies
    - policies/pod-security
  targets:
    - name: all-clusters
      clusterSelector:
        matchLabels: {}  # matches all clusters
```

```yaml
# policies/pod-security/pss-enforce.yaml — Pod Security Standards for all namespaces
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: enforce-pod-security-baseline
spec:
  validationFailureAction: Enforce
  background: true
  rules:
    - name: restrict-privileged
      match:
        any:
          - resources:
              kinds: [Pod]
      validate:
        message: "Privileged pods are not allowed."
        deny:
          conditions:
            any:
              - key: "{{ request.object.spec.containers[].securityContext.privileged | [] | max(@) }}"
                operator: Equals
                value: true
    - name: require-nonroot
      match:
        any:
          - resources:
              kinds: [Pod]
              namespaceSelector:
                matchLabels:
                  pod-security: enforced
      validate:
        message: "Pods must run as non-root."
        pattern:
          spec:
            securityContext:
              runAsNonRoot: true
```

---

## Section 10: Cost Allocation Across Clusters

Tracking cost per cluster, namespace, and team is essential at fleet scale:

```yaml
# opencost/values.yaml — deploy to each spoke cluster
opencost:
  exporter:
    defaultClusterId: "{{cluster_name}}"  # set per cluster
  prometheus:
    internal:
      enabled: false
    external:
      enabled: true
      url: "http://thanos-query.monitoring.svc.cluster.local:9090"

# Aggregate cost data from all clusters in Thanos:
# opencost_total_cluster_memory_request_average
# opencost_namespace_allocation_hours
# opencost_container_cpu_allocation
```

```bash
# Query fleet-wide cost via Thanos (hub cluster)
kubectl port-forward -n monitoring svc/thanos-query 9090:9090

curl -sG http://localhost:9090/api/v1/query \
  --data-urlencode 'query=sum(opencost_namespace_allocation_hours * on(namespace, cluster) group_left(team) kube_namespace_labels) by (team, cluster)' | \
  jq '.data.result[] | {team: .metric.team, cluster: .metric.cluster, cost: .value[1]}'
```

---

## Section 11: Gitops Promotion Workflow

Use ApplicationSets with Git generator to promote between environments:

```
git/
  environments/
    dev/
      myapp/
        values.yaml       ← dev-specific values, image tag auto-updated
    staging/
      myapp/
        values.yaml       ← promoted from dev after tests pass
    production/
      myapp/
        values.yaml       ← promoted from staging after manual approval
```

```yaml
# applicationset-git-files.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: myapp-promotion
  namespace: argocd
spec:
  generators:
    - git:
        repoURL: https://github.com/myorg/fleet-configs
        revision: main
        files:
          - path: "environments/*/myapp/values.yaml"
  template:
    metadata:
      name: "myapp-{{path.basename}}"  # e.g., myapp-dev, myapp-staging
    spec:
      project: default
      source:
        repoURL: https://github.com/myorg/myapp-chart
        targetRevision: main
        path: chart
        helm:
          valueFiles:
            - "{{path}}"
      destination:
        name: "{{path[1]}}-cluster"  # "dev" → dev-cluster
        namespace: myapp
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

Promotion is a pull request that copies the values.yaml from one environment directory to the next — no special tooling needed, and the history is in git.

---

## Section 12: Handling Cluster Emergencies at Scale

When a cluster needs emergency intervention across many pods simultaneously:

```bash
#!/usr/bin/env bash
# emergency-rollback.sh — roll back all deployments in a namespace across all clusters
# Usage: ./emergency-rollback.sh myapp production

NAMESPACE=$1
ENVIRONMENT=$2

CLUSTERS=$(kubectl get secrets -n argocd \
  -l "environment=${ENVIRONMENT},argocd.argoproj.io/secret-type=cluster" \
  -o jsonpath='{.items[*].metadata.name}')

for cluster in $CLUSTERS; do
  echo "Rolling back all deployments in $cluster/$NAMESPACE..."
  KUBECONFIG="/tmp/${cluster}.yaml" \
    kubectl rollout undo deployments --all -n "$NAMESPACE" || \
    echo "WARNING: rollback failed on $cluster"
done

# Suspend all ArgoCD auto-sync to prevent re-deployment:
for cluster in $CLUSTERS; do
  argocd app list \
    --selector "cluster=${cluster},environment=${ENVIRONMENT}" \
    -o name | xargs -I{} argocd app set {} --sync-policy none
done

echo "Rollback complete. ArgoCD auto-sync suspended."
echo "Re-enable sync after root cause analysis: argocd app set <app> --sync-policy automated"
```
