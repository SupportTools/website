---
title: "Kubernetes OLM: Operator Lifecycle Manager for Enterprise Operator Management"
date: 2031-05-09T00:00:00-05:00
draft: false
tags: ["Kubernetes", "OLM", "Operators", "Operator Lifecycle Manager", "CatalogSource", "DevOps"]
categories:
- Kubernetes
- Operators
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-grade guide to Operator Lifecycle Manager covering OLM architecture, catalog creation with operator-sdk, channel and update graph design, approval strategies, and troubleshooting install failures."
more_link: "yes"
url: "/kubernetes-olm-operator-lifecycle-manager-enterprise-guide/"
---

Operator Lifecycle Manager (OLM) is the production-grade answer to managing the full lifecycle of Kubernetes operators at scale. Without OLM, installing operators means manually applying CRDs, ServiceAccounts, Deployments, and RBAC rules — with no visibility into update availability, no dependency resolution, and no consistent uninstall story. OLM introduces a declarative layer that treats operators as first-class software packages with structured metadata, dependency graphs, and channel-based delivery.

This guide covers the complete OLM architecture from CatalogSource through ClusterServiceVersion, building private operator catalogs, designing update channels, configuring approval strategies, and systematically troubleshooting install failures in enterprise environments.

<!--more-->

# Kubernetes OLM: Operator Lifecycle Manager for Enterprise Operator Management

## Section 1: OLM Architecture Deep Dive

OLM introduces four primary CRDs that work together to model the operator delivery pipeline:

- **CatalogSource**: A registry of operator metadata (an index image or gRPC server)
- **Subscription**: A desire to install an operator from a specific catalog and channel
- **InstallPlan**: A resolved list of steps to install/upgrade an operator
- **ClusterServiceVersion (CSV)**: The operator's deployment specification and metadata

A supporting set of CRDs handles ancillary concerns:

- **OperatorGroup**: Defines the namespaces an operator watches
- **PackageManifest**: Discovered metadata from a CatalogSource

### 1.1 Control Flow

When a Subscription is created, the OLM catalog operator queries the CatalogSource for available CSVs matching the channel. It generates an InstallPlan listing every resource that needs to be applied. If the `installPlanApproval` is `Automatic`, OLM immediately approves and executes the plan. If `Manual`, a human or automation must patch the InstallPlan to approve it.

```
User creates Subscription
        │
        ▼
Catalog Operator queries CatalogSource (gRPC)
        │
        ▼
Resolves latest CSV in requested channel
        │
        ▼
Creates InstallPlan (Pending approval)
        │
   ┌────┴────┐
   │ Automatic│──► OLM approves immediately
   │ Manual  │──► Human/automation approves
   └─────────┘
        │
        ▼
OLM Operator applies resources (CRDs, RBAC, Deployment)
        │
        ▼
CSV reaches "Succeeded" phase
```

### 1.2 Installing OLM

OLM is not included in upstream Kubernetes. Install it with the official install script or via the release manifests:

```bash
# Install OLM v0.28.0
curl -sL https://github.com/operator-framework/operator-lifecycle-manager/releases/download/v0.28.0/install.sh | bash -s v0.28.0

# Verify OLM pods are running
kubectl get pods -n olm
# Expected output:
# NAME                                READY   STATUS    RESTARTS   AGE
# catalog-operator-7d9b9b6c9d-x4k2p  1/1     Running   0          2m
# olm-operator-5f8d6b9d77-lp9rt      1/1     Running   0          2m
# operatorhubio-catalog-p7r8q        1/1     Running   0          2m
# packageserver-6b8f9c7d8-mjq2s      2/2     Running   0          2m

# Check OLM CRDs
kubectl get crd | grep operators.coreos.com
```

For production environments, deploy OLM via Helm for easier lifecycle management:

```bash
helm repo add operator-framework https://operator-framework.github.io/helm-charts
helm repo update

helm install olm operator-framework/olm \
  --namespace olm \
  --create-namespace \
  --version 0.28.0 \
  --set catalog.image=quay.io/operator-framework/upstream-community-operators:latest
```

## Section 2: CatalogSource Configuration

A CatalogSource tells OLM where to find operator packages. There are two delivery mechanisms: an index image (most common) and a gRPC address.

### 2.1 OperatorHub Community CatalogSource

```yaml
# catalogsource-community.yaml
apiVersion: operators.coreos.com/v1alpha1
kind: CatalogSource
metadata:
  name: operatorhubio-catalog
  namespace: olm
spec:
  sourceType: grpc
  image: quay.io/operator-framework/upstream-community-operators:latest
  displayName: Community Operators
  publisher: OperatorHub.io
  updateStrategy:
    registryPoll:
      interval: 60m
  # Specify a grpcPodConfig for resource limits
  grpcPodConfig:
    securityContextConfig: restricted
    nodeSelector:
      kubernetes.io/os: linux
    resources:
      requests:
        cpu: 10m
        memory: 50Mi
      limits:
        cpu: 100m
        memory: 200Mi
```

### 2.2 Private Enterprise CatalogSource

For air-gapped or enterprise environments, mirror your operator catalog to a private registry:

```bash
# Mirror the Red Hat certified operators catalog
oc adm catalog mirror \
  registry.redhat.io/redhat/certified-operator-index:v4.15 \
  registry.corp.example.com/olm-mirror \
  --manifests-only \
  --to-manifests=./certified-mirror-manifests

# Apply the generated ImageContentSourcePolicy and CatalogSource
kubectl apply -f ./certified-mirror-manifests/imageContentSourcePolicy.yaml
kubectl apply -f ./certified-mirror-manifests/catalogSource.yaml
```

For fully custom private catalogs:

```yaml
# catalogsource-private.yaml
apiVersion: operators.coreos.com/v1alpha1
kind: CatalogSource
metadata:
  name: enterprise-operators
  namespace: olm
spec:
  sourceType: grpc
  image: registry.corp.example.com/olm/enterprise-catalog:v2.1.0
  displayName: "Enterprise Operators"
  publisher: "Platform Engineering"
  secrets:
    - registry-pull-secret
  updateStrategy:
    registryPoll:
      interval: 30m
  grpcPodConfig:
    resources:
      requests:
        cpu: 50m
        memory: 100Mi
      limits:
        cpu: 500m
        memory: 500Mi
---
# Pull secret for private registry
apiVersion: v1
kind: Secret
metadata:
  name: registry-pull-secret
  namespace: olm
type: kubernetes.io/dockerconfigjson
data:
  .dockerconfigjson: <base64-encoded-docker-config>
```

### 2.3 Verifying CatalogSource Health

```bash
# Check catalog pod status
kubectl get catalogsource -n olm
kubectl get pods -n olm -l olm.catalogSource=enterprise-operators

# Query available packages via grpcurl
CATALOG_POD=$(kubectl get pod -n olm -l olm.catalogSource=enterprise-operators -o jsonpath='{.items[0].metadata.name}')
kubectl port-forward -n olm pod/$CATALOG_POD 50051:50051 &

grpcurl -plaintext localhost:50051 api.Registry/ListPackages
grpcurl -plaintext -d '{"name":"my-operator"}' localhost:50051 api.Registry/GetPackage
```

## Section 3: Building Custom Operator Catalogs

### 3.1 Operator Bundle Structure

An operator bundle is a container image containing the CSV, CRDs, and metadata for a single version of an operator:

```
my-operator/
├── bundle/
│   ├── manifests/
│   │   ├── my-operator.clusterserviceversion.yaml
│   │   ├── my-operator.v1.0.0.clusterserviceversion.yaml
│   │   ├── mycrd.crd.yaml
│   │   └── my-operator-metrics-service.yaml
│   ├── metadata/
│   │   └── annotations.yaml
│   └── Dockerfile
```

The `annotations.yaml` is critical — it tells OLM which channels this bundle belongs to:

```yaml
# bundle/metadata/annotations.yaml
annotations:
  operators.operatorframework.io.bundle.mediatype.v1: registry+v1
  operators.operatorframework.io.bundle.manifests.v1: manifests/
  operators.operatorframework.io.bundle.metadata.v1: metadata/
  operators.operatorframework.io.bundle.package.v1: my-operator
  operators.operatorframework.io.bundle.channels.v1: stable,alpha
  operators.operatorframework.io.bundle.channel.default.v1: stable
  operators.operatorframework.io.metrics.builder: operator-sdk-v1.35.0
  operators.operatorframework.io.metrics.mediatype.v1: metrics+v1
  operators.operatorframework.io.metrics.project_layout: go.kubebuilder.io/v4
```

### 3.2 ClusterServiceVersion Structure

The CSV is the heart of an operator bundle. It describes everything OLM needs to deploy and manage the operator:

```yaml
# bundle/manifests/my-operator.v1.2.0.clusterserviceversion.yaml
apiVersion: operators.coreos.com/v1alpha1
kind: ClusterServiceVersion
metadata:
  name: my-operator.v1.2.0
  namespace: placeholder
  annotations:
    alm-examples: |-
      [
        {
          "apiVersion": "apps.example.com/v1alpha1",
          "kind": "MyApp",
          "metadata": {"name": "example"},
          "spec": {"size": 3, "image": "example.com/myapp:latest"}
        }
      ]
    capabilities: Deep Insights
    categories: Application Runtime
    containerImage: registry.corp.example.com/my-operator:v1.2.0
    createdAt: "2031-01-15T00:00:00Z"
    description: Manages MyApp deployments on Kubernetes
    operators.operatorframework.io/builder: operator-sdk-v1.35.0
    operators.operatorframework.io/project_layout: go.kubebuilder.io/v4
spec:
  displayName: My Operator
  description: |
    ## Overview
    My Operator automates the deployment and management of MyApp instances.

    ## Features
    - Automated scaling
    - Rolling updates with health checks
    - Backup and restore integration
  version: 1.2.0
  replaces: my-operator.v1.1.0
  skips:
    - my-operator.v1.1.1  # Skip a bad release
  maturity: stable
  maintainers:
    - name: Platform Engineering
      email: platform@example.com
  provider:
    name: Example Corp
    url: https://example.com
  links:
    - name: Documentation
      url: https://docs.example.com/my-operator
    - name: Source Code
      url: https://github.com/example/my-operator
  keywords:
    - myapp
    - application runtime
  labels:
    operatorframework.io/arch.amd64: supported
    operatorframework.io/arch.arm64: supported
    operatorframework.io/os.linux: supported
  # Define owned CRDs
  customresourcedefinitions:
    owned:
      - name: myapps.apps.example.com
        version: v1alpha1
        kind: MyApp
        displayName: MyApp
        description: Represents a MyApp instance
        resources:
          - version: v1
            kind: Deployment
          - version: v1
            kind: Service
          - version: v1
            kind: ConfigMap
        specDescriptors:
          - path: size
            displayName: Cluster Size
            description: Number of replicas
            x-descriptors:
              - urn:alm:descriptor:com.tectonic.ui:podCount
          - path: image
            displayName: Container Image
            description: The container image for MyApp
            x-descriptors:
              - urn:alm:descriptor:com.tectonic.ui:text
        statusDescriptors:
          - path: conditions
            displayName: Conditions
            description: The current state of the MyApp instance
            x-descriptors:
              - urn:alm:descriptor:io.kubernetes.conditions
    required:
      - name: etcdclusters.etcd.database.coreos.com
        version: v1beta2
        kind: EtcdCluster
        description: Required etcd cluster dependency
  # Install strategy
  install:
    strategy: deployment
    spec:
      permissions:
        - serviceAccountName: my-operator-controller-manager
          rules:
            - apiGroups: [""]
              resources: ["pods", "services", "configmaps"]
              verbs: ["create", "delete", "get", "list", "patch", "update", "watch"]
            - apiGroups: ["apps"]
              resources: ["deployments"]
              verbs: ["create", "delete", "get", "list", "patch", "update", "watch"]
            - apiGroups: ["apps.example.com"]
              resources: ["myapps", "myapps/status", "myapps/finalizers"]
              verbs: ["create", "delete", "get", "list", "patch", "update", "watch"]
      clusterPermissions:
        - serviceAccountName: my-operator-controller-manager
          rules:
            - apiGroups: [""]
              resources: ["nodes"]
              verbs: ["get", "list", "watch"]
            - apiGroups: ["authentication.k8s.io"]
              resources: ["tokenreviews"]
              verbs: ["create"]
            - apiGroups: ["authorization.k8s.io"]
              resources: ["subjectaccessreviews"]
              verbs: ["create"]
      deployments:
        - name: my-operator-controller-manager
          label:
            app: my-operator
            control-plane: controller-manager
          spec:
            replicas: 1
            selector:
              matchLabels:
                control-plane: controller-manager
            template:
              metadata:
                labels:
                  control-plane: controller-manager
              spec:
                securityContext:
                  runAsNonRoot: true
                  seccompProfile:
                    type: RuntimeDefault
                serviceAccountName: my-operator-controller-manager
                terminationGracePeriodSeconds: 10
                containers:
                  - name: manager
                    image: registry.corp.example.com/my-operator:v1.2.0
                    command:
                      - /manager
                    args:
                      - --leader-elect
                      - --health-probe-bind-address=:8081
                      - --metrics-bind-address=127.0.0.1:8080
                    securityContext:
                      allowPrivilegeEscalation: false
                      capabilities:
                        drop: ["ALL"]
                    livenessProbe:
                      httpGet:
                        path: /healthz
                        port: 8081
                      initialDelaySeconds: 15
                      periodSeconds: 20
                    readinessProbe:
                      httpGet:
                        path: /readyz
                        port: 8081
                      initialDelaySeconds: 5
                      periodSeconds: 10
                    resources:
                      limits:
                        cpu: 500m
                        memory: 128Mi
                      requests:
                        cpu: 10m
                        memory: 64Mi
                    env:
                      - name: OPERATOR_NAMESPACE
                        valueFrom:
                          fieldRef:
                            fieldPath: metadata.namespace
  # Webhook definitions
  webhookdefinitions:
    - type: ValidatingAdmissionWebhook
      admissionReviewVersions: ["v1"]
      containerPort: 9443
      deploymentName: my-operator-controller-manager
      failurePolicy: Fail
      generateName: vmyapp.kb.io
      rules:
        - apiGroups: ["apps.example.com"]
          apiVersions: ["v1alpha1"]
          operations: ["CREATE", "UPDATE"]
          resources: ["myapps"]
      sideEffects: None
      targetPort: 9443
      webhookPath: /validate-apps-example-com-v1alpha1-myapp
  # Operator capability and install modes
  installModes:
    - type: OwnNamespace
      supported: true
    - type: SingleNamespace
      supported: true
    - type: MultiNamespace
      supported: false
    - type: AllNamespaces
      supported: true
```

### 3.3 Building the Catalog Index Image

OLM uses the File-Based Catalog (FBC) format for new catalogs. Build a catalog using `opm`:

```bash
# Initialize a new file-based catalog
mkdir -p enterprise-catalog/my-operator

# Generate catalog template from bundle
opm render registry.corp.example.com/my-operator-bundle:v1.2.0 \
  --output yaml >> enterprise-catalog/my-operator/catalog.yaml

# Also add v1.1.0 bundle
opm render registry.corp.example.com/my-operator-bundle:v1.1.0 \
  --output yaml >> enterprise-catalog/my-operator/catalog.yaml

# Add the channel and package definitions
cat >> enterprise-catalog/my-operator/catalog.yaml <<'EOF'
---
schema: olm.package
name: my-operator
defaultChannel: stable
---
schema: olm.channel
package: my-operator
name: stable
entries:
  - name: my-operator.v1.1.0
  - name: my-operator.v1.2.0
    replaces: my-operator.v1.1.0
---
schema: olm.channel
package: my-operator
name: alpha
entries:
  - name: my-operator.v1.2.0
EOF

# Validate the catalog
opm validate enterprise-catalog/

# Build the catalog image
cat > enterprise-catalog/Dockerfile <<'EOF'
FROM quay.io/operator-framework/opm:latest AS builder
COPY . /configs
RUN /bin/opm validate /configs

FROM scratch
COPY --from=builder /configs /configs
LABEL operators.operatorframework.io.index.configs.v1=/configs
ENTRYPOINT ["/bin/opm"]
CMD ["serve", "/configs"]
EOF

docker build -t registry.corp.example.com/olm/enterprise-catalog:v2.1.0 enterprise-catalog/
docker push registry.corp.example.com/olm/enterprise-catalog:v2.1.0
```

## Section 4: Channel and Update Graph Design

### 4.1 Channel Strategy

Channels enable delivering different maturity levels of the same operator to different consumers:

```
Package: my-operator
├── Channel: stable     (recommended for production)
│   └── my-operator.v1.0.0 → v1.1.0 → v1.2.0
├── Channel: fast       (recent releases, minor stability risk)
│   └── my-operator.v1.1.0 → v1.2.0 → v1.3.0-rc.1
└── Channel: alpha      (cutting edge, breaking changes possible)
    └── my-operator.v1.2.0 → v2.0.0-alpha.1 → v2.0.0-alpha.2
```

Design your update graph in the file-based catalog format:

```yaml
# enterprise-catalog/my-operator/catalog.yaml
---
schema: olm.package
name: my-operator
defaultChannel: stable

---
schema: olm.channel
package: my-operator
name: stable
entries:
  - name: my-operator.v1.0.0
  - name: my-operator.v1.1.0
    replaces: my-operator.v1.0.0
  - name: my-operator.v1.2.0
    replaces: my-operator.v1.1.0
    skips:
      - my-operator.v1.0.0  # Allow direct upgrade from v1.0.0 too

---
schema: olm.channel
package: my-operator
name: fast
entries:
  - name: my-operator.v1.1.0
  - name: my-operator.v1.2.0
    replaces: my-operator.v1.1.0
  - name: my-operator.v1.3.0-rc.1
    replaces: my-operator.v1.2.0

---
schema: olm.channel
package: my-operator
name: alpha
entries:
  - name: my-operator.v1.2.0
  - name: my-operator.v2.0.0-alpha.1
    replaces: my-operator.v1.2.0
  - name: my-operator.v2.0.0-alpha.2
    replaces: my-operator.v2.0.0-alpha.1
```

### 4.2 skipRange for Wide Compatibility

The `skipRange` annotation allows OLM to skip over a range of versions during upgrades, useful for consolidating upgrade paths:

```yaml
# In the CSV metadata
metadata:
  annotations:
    olm.skipRange: ">=1.0.0 <1.2.0"
```

This allows users on any v1.0.x or v1.1.x to upgrade directly to v1.2.0, regardless of individual `replaces` entries.

## Section 5: OperatorGroup and Install Modes

OperatorGroup controls which namespaces an operator can watch and act on.

### 5.1 AllNamespaces Mode

The operator watches all namespaces. Only one AllNamespaces operator of the same type can exist in a cluster:

```yaml
# operatorgroup-global.yaml
apiVersion: operators.coreos.com/v1
kind: OperatorGroup
metadata:
  name: global-operators
  namespace: operators
spec: {}  # Empty spec = watch all namespaces
```

### 5.2 SingleNamespace and OwnNamespace Mode

For tenant isolation, restrict the operator to specific namespaces:

```yaml
# operatorgroup-tenant.yaml
apiVersion: operators.coreos.com/v1
kind: OperatorGroup
metadata:
  name: tenant-a-operators
  namespace: tenant-a
spec:
  targetNamespaces:
    - tenant-a
```

For OwnNamespace (operator watches only its own namespace):

```yaml
apiVersion: operators.coreos.com/v1
kind: OperatorGroup
metadata:
  name: own-namespace-og
  namespace: my-operator-ns
spec:
  targetNamespaces:
    - my-operator-ns
```

### 5.3 MultiNamespace Mode

An operator manages multiple specific namespaces:

```yaml
apiVersion: operators.coreos.com/v1
kind: OperatorGroup
metadata:
  name: multi-tenant-og
  namespace: operator-ns
spec:
  targetNamespaces:
    - tenant-a
    - tenant-b
    - tenant-c
```

## Section 6: Subscription and Approval Strategies

### 6.1 Automatic Approval

OLM approves InstallPlans automatically. Use for dev/test environments or operators with low risk of breaking changes:

```yaml
# subscription-automatic.yaml
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: my-operator
  namespace: operators
spec:
  channel: stable
  installPlanApproval: Automatic
  name: my-operator
  source: enterprise-operators
  sourceNamespace: olm
  startingCSV: my-operator.v1.2.0
```

### 6.2 Manual Approval

Require explicit approval before applying updates. Critical for production environments:

```yaml
# subscription-manual.yaml
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: my-operator-prod
  namespace: operators
spec:
  channel: stable
  installPlanApproval: Manual
  name: my-operator
  source: enterprise-operators
  sourceNamespace: olm
  startingCSV: my-operator.v1.2.0
  config:
    resources:
      requests:
        memory: "64Mi"
        cpu: "250m"
      limits:
        memory: "128Mi"
        cpu: "500m"
    env:
      - name: LOG_LEVEL
        value: "info"
    nodeSelector:
      node-role.kubernetes.io/worker: ""
    tolerations:
      - key: "dedicated"
        operator: "Equal"
        value: "operators"
        effect: "NoSchedule"
```

### 6.3 Approving InstallPlans

When a new update is detected and approval is Manual, approve it:

```bash
# List pending InstallPlans
kubectl get installplan -n operators

# NAME               CSV                     APPROVAL   APPROVED
# install-plan-xyz   my-operator.v1.3.0     Manual     false
# install-plan-abc   my-operator.v1.2.0     Manual     true

# Inspect what will be applied
kubectl describe installplan install-plan-xyz -n operators

# Approve the InstallPlan
kubectl patch installplan install-plan-xyz \
  --namespace operators \
  --type merge \
  --patch '{"spec":{"approved":true}}'
```

Automate approval in CI/CD pipelines with a check:

```bash
#!/bin/bash
# approve-installplan.sh
NAMESPACE=${1:-operators}
OPERATOR=${2:-my-operator}

# Wait for a pending InstallPlan for the operator
for i in $(seq 1 30); do
  PLAN=$(kubectl get installplan -n "$NAMESPACE" \
    -o jsonpath="{.items[?(@.spec.approved==false)].metadata.name}" | tr ' ' '\n' | \
    while read name; do
      kubectl get installplan "$name" -n "$NAMESPACE" \
        -o jsonpath="{.spec.clusterServiceVersionNames[*]}" | grep -q "$OPERATOR" && echo "$name"
    done | head -1)

  if [ -n "$PLAN" ]; then
    echo "Approving InstallPlan: $PLAN"
    kubectl patch installplan "$PLAN" \
      --namespace "$NAMESPACE" \
      --type merge \
      --patch '{"spec":{"approved":true}}'
    break
  fi

  echo "Waiting for InstallPlan ($i/30)..."
  sleep 10
done

if [ -z "$PLAN" ]; then
  echo "ERROR: No pending InstallPlan found for $OPERATOR"
  exit 1
fi
```

## Section 7: Namespace vs Cluster-Scoped Operators

### 7.1 Determining Scope

The CSV `installModes` field and the OperatorGroup determine the effective scope:

```bash
# Check what install modes a CSV supports
kubectl get csv my-operator.v1.2.0 -n operators \
  -o jsonpath='{.spec.installModes}' | jq .

# [
#   {"supported": true,  "type": "OwnNamespace"},
#   {"supported": true,  "type": "SingleNamespace"},
#   {"supported": false, "type": "MultiNamespace"},
#   {"supported": true,  "type": "AllNamespaces"}
# ]
```

### 7.2 Cluster-Scoped Operator Deployment Pattern

For cluster-wide operators (e.g., cert-manager, external-secrets), deploy in a dedicated namespace with AllNamespaces mode:

```yaml
# namespace for cluster operators
apiVersion: v1
kind: Namespace
metadata:
  name: cluster-operators
  labels:
    app.kubernetes.io/managed-by: olm
    pod-security.kubernetes.io/enforce: restricted
---
apiVersion: operators.coreos.com/v1
kind: OperatorGroup
metadata:
  name: cluster-operators-og
  namespace: cluster-operators
spec: {}  # AllNamespaces
---
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: cert-manager
  namespace: cluster-operators
spec:
  channel: stable
  installPlanApproval: Manual
  name: cert-manager
  source: operatorhubio-catalog
  sourceNamespace: olm
```

### 7.3 Tenant-Scoped Operator Pattern

For multi-tenant clusters where each team manages their own operator instances:

```bash
# Create tenant namespaces with their own OperatorGroups
for tenant in team-alpha team-beta team-gamma; do
  kubectl create namespace $tenant --dry-run=client -o yaml | kubectl apply -f -

  cat <<EOF | kubectl apply -f -
apiVersion: operators.coreos.com/v1
kind: OperatorGroup
metadata:
  name: ${tenant}-og
  namespace: ${tenant}
spec:
  targetNamespaces:
    - ${tenant}
---
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: my-operator
  namespace: ${tenant}
spec:
  channel: stable
  installPlanApproval: Manual
  name: my-operator
  source: enterprise-operators
  sourceNamespace: olm
EOF
done
```

## Section 8: Troubleshooting Install Failures

### 8.1 Diagnosing Subscription Issues

```bash
# Check subscription status
kubectl describe subscription my-operator -n operators

# Look for conditions like:
# Conditions:
#   CatalogSourcesUnhealthy (False): All CSs are healthy
#   InstallPlanMissing (False): no InstallPlan found for subscription

# Or problems like:
#   ResolutionFailed (True): constraints not satisfiable:
#     my-operator requires my-operator.v1.2.0,
#     my-operator.v1.2.0 requires etcd >=3.5.0 which is not installed
```

### 8.2 CSV Phase Troubleshooting

CSVs go through phases: `None` → `Pending` → `InstallReady` → `Installing` → `Succeeded` (or `Failed`)

```bash
# Check CSV phase
kubectl get csv -n operators
# NAME                    DISPLAY       VERSION   REPLACES                PHASE
# my-operator.v1.2.0     My Operator   1.2.0     my-operator.v1.1.0     Succeeded

# If stuck in Installing, check reasons
kubectl describe csv my-operator.v1.2.0 -n operators | grep -A 20 "^Conditions:"

# Check the operator deployment itself
kubectl get deployment -n operators
kubectl describe deployment my-operator-controller-manager -n operators

# Check events
kubectl get events -n operators --sort-by='.lastTimestamp' | tail -30
```

### 8.3 Common Failure Scenarios

**Scenario 1: CatalogSource not ready**

```bash
kubectl get catalogsource -n olm
# NAME                  DISPLAY               TYPE   PUBLISHER     AGE    READY
# enterprise-operators  Enterprise Operators  grpc   Platform Eng  5m     False

# Check catalog pod
kubectl get pod -n olm -l olm.catalogSource=enterprise-operators
kubectl logs -n olm -l olm.catalogSource=enterprise-operators

# Common causes:
# 1. Image pull failure - check imagePullSecrets
# 2. gRPC server crash - check if the index image is valid
# 3. Network policy blocking gRPC port 50051
```

**Scenario 2: Missing required CRDs**

```bash
# OLM won't install a CSV if required CRDs are missing
kubectl describe csv my-operator.v1.2.0 -n operators | grep -A 5 "Required CRDs"
# Required CRDs:
#   etcdclusters.etcd.database.coreos.com (not found)

# Install the dependency first
kubectl apply -f https://example.com/etcd-crds.yaml
```

**Scenario 3: RBAC conflicts**

```bash
# Check if ServiceAccount exists
kubectl get serviceaccount my-operator-controller-manager -n operators

# Check ClusterRole/Role bindings
kubectl get clusterrolebinding | grep my-operator
kubectl describe clusterrolebinding my-operator-controller-manager

# OLM errors on RBAC usually appear in the OLM operator logs
kubectl logs -n olm -l app=olm-operator --since=10m | grep -i "error\|forbidden\|my-operator"
```

**Scenario 4: OperatorGroup conflicts**

```bash
# Only one OperatorGroup is allowed per namespace
kubectl get operatorgroup -n operators
# Error: multiple OperatorGroups (operators/og-1, operators/og-2) exist for the namespace

# Delete the duplicate
kubectl delete operatorgroup og-2 -n operators
```

**Scenario 5: Webhook installation failure**

```bash
# Webhooks require cert-manager or manual cert injection
kubectl describe csv my-operator.v1.2.0 -n operators | grep -A 10 "Webhook"

# Check if cert-manager is creating the certificate
kubectl get certificate -n operators
kubectl describe certificate my-operator-serving-cert -n operators

# For manual cert injection, the CSV needs:
# annotations:
#   cert-manager.io/inject-ca-from: operators/my-operator-serving-cert
```

### 8.4 Debugging with OLM Logs

```bash
# Catalog operator handles CatalogSource and Subscription reconciliation
kubectl logs -n olm -l app=catalog-operator --since=30m | grep -E "error|warn|my-operator"

# OLM operator handles CSV and OperatorGroup reconciliation
kubectl logs -n olm -l app=olm-operator --since=30m | grep -E "error|warn|my-operator"

# Enable debug logging for a session (not persistent across restarts)
kubectl set env deployment/catalog-operator -n olm LOG_LEVEL=debug
kubectl set env deployment/olm-operator -n olm LOG_LEVEL=debug
```

### 8.5 OLM Health Check Script

```bash
#!/bin/bash
# olm-health-check.sh
set -euo pipefail

NAMESPACE=${1:-operators}

echo "=== OLM System Health ==="
echo "--- OLM Pods ---"
kubectl get pods -n olm

echo ""
echo "--- CatalogSources ---"
kubectl get catalogsource -n olm -o custom-columns="NAME:.metadata.name,IMAGE:.spec.image,READY:.status.connectionState.lastObservedState"

echo ""
echo "--- OperatorGroups in $NAMESPACE ---"
kubectl get operatorgroup -n "$NAMESPACE"

echo ""
echo "--- Subscriptions in $NAMESPACE ---"
kubectl get subscription -n "$NAMESPACE" -o custom-columns="NAME:.metadata.name,CHANNEL:.spec.channel,APPROVAL:.spec.installPlanApproval,CURRENT_CSV:.status.currentCSV,STATE:.status.state"

echo ""
echo "--- CSVs in $NAMESPACE ---"
kubectl get csv -n "$NAMESPACE" -o custom-columns="NAME:.metadata.name,VERSION:.spec.version,PHASE:.status.phase"

echo ""
echo "--- Pending InstallPlans in $NAMESPACE ---"
kubectl get installplan -n "$NAMESPACE" | grep -v "^NAME" | while read name components approval approved; do
  if [ "$approved" = "false" ]; then
    echo "PENDING: $name (components: $components)"
  fi
done

echo ""
echo "--- Recent Events in $NAMESPACE ---"
kubectl get events -n "$NAMESPACE" --sort-by='.lastTimestamp' \
  --field-selector type!=Normal | tail -20
```

## Section 9: Advanced OLM Patterns

### 9.1 Operator Dependencies

OLM can resolve operator dependencies automatically. Declare them in the CSV:

```yaml
# In ClusterServiceVersion spec
spec:
  # Require another operator to be installed
  nativeAPIs:
    - group: cert-manager.io
      version: v1
      kind: Certificate
```

Or use the `dependencies.yaml` in the bundle metadata:

```yaml
# bundle/metadata/dependencies.yaml
dependencies:
  - type: olm.package
    value:
      packageName: cert-manager
      version: ">=1.12.0"
  - type: olm.gvk
    value:
      group: etcd.database.coreos.com
      kind: EtcdCluster
      version: v1beta2
```

### 9.2 Operator Conditions

Operators should report their own health via OperatorCondition CRDs:

```go
// In your operator's reconciler
import (
    operatorsv2 "github.com/operator-framework/api/pkg/operators/v2"
    apimeta "k8s.io/apimachinery/pkg/api/meta"
)

func (r *MyAppReconciler) updateOperatorCondition(ctx context.Context, condType string, status metav1.ConditionStatus, reason, message string) error {
    condition := metav1.Condition{
        Type:               condType,
        Status:             status,
        Reason:             reason,
        Message:            message,
        LastTransitionTime: metav1.Now(),
    }

    oc := &operatorsv2.OperatorCondition{}
    if err := r.Get(ctx, types.NamespacedName{
        Name:      os.Getenv("OPERATOR_CONDITION_NAME"),
        Namespace: os.Getenv("OPERATOR_NAMESPACE"),
    }, oc); err != nil {
        return err
    }

    apimeta.SetStatusCondition(&oc.Spec.Conditions, condition)
    return r.Update(ctx, oc)
}
```

### 9.3 Operator Metrics and Monitoring

Configure Prometheus monitoring for OLM itself:

```yaml
# prometheus-olm-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: olm-alerts
  namespace: olm
spec:
  groups:
    - name: olm.rules
      rules:
        - alert: OLMCSVFailed
          expr: csv_succeeded{phase="Failed"} == 1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "OLM CSV {{ $labels.name }} is in Failed phase"
            description: "ClusterServiceVersion {{ $labels.name }} in namespace {{ $labels.namespace }} has been in Failed phase for 5 minutes"

        - alert: OLMCatalogSourceUnhealthy
          expr: catalogsource_ready == 0
          for: 10m
          labels:
            severity: critical
          annotations:
            summary: "OLM CatalogSource {{ $labels.name }} is not ready"

        - alert: OLMPendingInstallPlans
          expr: installplan_count{approved="false"} > 5
          for: 1h
          labels:
            severity: warning
          annotations:
            summary: "More than 5 pending InstallPlans in {{ $labels.namespace }}"
```

## Section 10: Production Checklist

Before relying on OLM in production, verify these items:

```bash
#!/bin/bash
# olm-production-checklist.sh

echo "Checking OLM production readiness..."

# 1. OLM version
echo "[1] OLM Version:"
kubectl get deployment olm-operator -n olm -o jsonpath='{.spec.template.spec.containers[0].image}'
echo ""

# 2. CatalogSource image pinning (not using :latest)
echo "[2] CatalogSource image tags (should not be :latest):"
kubectl get catalogsource -A -o jsonpath='{range .items[*]}{.metadata.name}: {.spec.image}{"\n"}{end}'

# 3. Subscriptions with Manual approval
echo "[3] Subscriptions approval mode:"
kubectl get subscription -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}: {.spec.installPlanApproval}{"\n"}{end}'

# 4. No Failed CSVs
echo "[4] Failed CSVs (should be empty):"
kubectl get csv -A --field-selector='status.phase=Failed'

# 5. All CatalogSources healthy
echo "[5] CatalogSource health:"
kubectl get catalogsource -A -o jsonpath='{range .items[*]}{.metadata.name}: {.status.connectionState.lastObservedState}{"\n"}{end}'

# 6. Resource limits on catalog pods
echo "[6] Catalog pod resource limits:"
kubectl get catalogsource -A -o jsonpath='{range .items[*]}{.metadata.name}: cpu_limit={.spec.grpcPodConfig.resources.limits.cpu} mem_limit={.spec.grpcPodConfig.resources.limits.memory}{"\n"}{end}'

echo "Checklist complete."
```

OLM transforms operator management from an ad-hoc YAML marathon into a structured software delivery pipeline. With proper catalog design, channel strategy, and approval workflows, you gain the upgrade visibility and control that production environments demand.
