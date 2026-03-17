---
title: "Kubernetes ConfigMap Immutability and Configuration Drift Detection"
date: 2029-10-05T00:00:00-05:00
draft: false
tags: ["Kubernetes", "ConfigMap", "GitOps", "ArgoCD", "Kustomize", "Configuration Management"]
categories: ["Kubernetes", "GitOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes ConfigMap immutability, Reloader annotation patterns, configuration hash injection for rolling restarts, Argo CD drift detection, and Kustomize patches for managing configuration across environments."
more_link: "yes"
url: "/kubernetes-configmap-immutability-configuration-drift-detection/"
---

Configuration drift is one of the most insidious problems in Kubernetes operations. A ConfigMap gets updated in production directly via `kubectl` while the Git repository drifts — within days the cluster state no longer matches what anyone believes is deployed. Applications continue running with the old configuration because their pods haven't been restarted to pick up the change, or conversely, they pick up a new ConfigMap that hasn't been tested.

This guide covers the complete configuration management stack: immutable ConfigMaps (and their tradeoffs), automated rolling restarts via Reloader, configuration hash injection, Argo CD drift detection and self-healing, and Kustomize patches for multi-environment configuration management.

<!--more-->

# Kubernetes ConfigMap Immutability and Configuration Drift Detection

## Section 1: ConfigMap Immutability

Kubernetes 1.21 introduced the `immutable` field for ConfigMaps and Secrets. When set to `true`, the data cannot be modified — any attempt to update the ConfigMap will be rejected by the API server.

### Creating Immutable ConfigMaps

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config-v1.2.3
  namespace: production
  labels:
    app: my-app
    config-version: "1.2.3"
immutable: true
data:
  APP_ENVIRONMENT: "production"
  DATABASE_HOST: "postgres.production.svc.cluster.local"
  DATABASE_PORT: "5432"
  CACHE_TTL_SECONDS: "300"
  LOG_LEVEL: "info"
  MAX_CONNECTIONS: "100"
```

### Benefits of Immutability

1. **Performance**: The kubelet caches immutable ConfigMaps more aggressively — it does not watch for changes, reducing API server load in large clusters
2. **Safety**: Prevents accidental in-place mutations that could cause inconsistent state across pod restarts
3. **Auditability**: Forces versioned naming, making the configuration history explicit
4. **GitOps compatibility**: Immutable ConfigMaps with version-stamped names align naturally with GitOps workflows

### Limitations

Once set to `immutable: true`, the ConfigMap can only be deleted and recreated — not updated. This means the name must be versioned (or include a hash) to allow rotation.

```bash
# Attempting to update an immutable ConfigMap returns:
# Error from server: ConfigMaps "app-config-v1.2.3" is immutable

# The only way to "update" is to create a new ConfigMap
kubectl create configmap app-config-v1.2.4 \
  --from-file=./config/ \
  --dry-run=client -o yaml | \
  kubectl apply -f -

# Then update the Deployment to reference the new ConfigMap
kubectl set env deployment/my-app \
  --from=configmap/app-config-v1.2.4
```

### Immutable ConfigMap Naming Conventions

```bash
# Option 1: Semantic versioning
app-config-v1.2.3

# Option 2: Git commit hash (enables direct correlation with code)
app-config-a1b2c3d  # First 7 chars of git commit

# Option 3: Content hash (ensures name changes when content changes)
HASH=$(cat config.yaml | sha256sum | cut -c1-8)
app-config-${HASH}

# Option 4: Timestamp
app-config-20241015T031459Z
```

## Section 2: Rolling Restarts on ConfigMap Changes

The most common pain point with ConfigMaps: pods don't automatically restart when a ConfigMap is updated. There are three approaches to solve this.

### Approach 1: Configuration Hash Injection

Inject a hash of the ConfigMap data into the pod spec annotation. When the ConfigMap changes, the hash changes, triggering a rolling restart via the normal Deployment update mechanism.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  template:
    metadata:
      annotations:
        # Inject hash of ConfigMap data — triggers rolling update when config changes
        checksum/config: "sha256:a1b2c3d4e5f6..."
    spec:
      containers:
        - name: my-app
          image: my-app:v2.0.0
          envFrom:
            - configMapRef:
                name: app-config
```

With Helm, this is the standard pattern:

```yaml
# In a Helm chart template:
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    metadata:
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
        checksum/secret: {{ include (print $.Template.BasePath "/secret.yaml") . | sha256sum }}
```

With Kustomize:

```yaml
# kustomization.yaml — hash suffix is automatically appended
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

# Generate ConfigMaps with content hash suffixes
configMapGenerator:
  - name: app-config
    files:
      - config/app.properties
    options:
      disableNameSuffixHash: false  # Default: hash suffix appended

# When app.properties changes, the ConfigMap gets a new name
# Kustomize also updates all references to the ConfigMap automatically
```

### Approach 2: Reloader

[Reloader](https://github.com/stakater/Reloader) is a Kubernetes controller that watches ConfigMaps and Secrets, then triggers rolling restarts of Deployments, StatefulSets, and DaemonSets that reference them.

```bash
# Install Reloader
helm repo add stakater https://stakater.github.io/stakater-charts
helm install reloader stakater/reloader \
  --namespace reloader \
  --create-namespace \
  --set reloader.watchGlobally=false  # Only watch annotated resources
```

```yaml
# Deployment with Reloader annotation
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  annotations:
    # Watch a specific ConfigMap
    reloader.stakater.com/auto: "true"  # Watch all ConfigMaps/Secrets used by this deployment

    # Or be specific:
    configmap.reloader.stakater.com/reload: "app-config,app-extra-config"
    secret.reloader.stakater.com/reload: "app-secrets"
spec:
  template:
    spec:
      containers:
        - name: my-app
          image: my-app:v2.0.0
          envFrom:
            - configMapRef:
                name: app-config
```

Reloader will detect when `app-config` is modified and trigger a rolling restart of the Deployment automatically.

### Approach 3: Manual Restart Annotation

The simplest approach for environments without Reloader:

```bash
# Trigger a rolling restart by updating the restartedAt annotation
kubectl rollout restart deployment/my-app

# This adds/updates the annotation:
# kubectl.kubernetes.io/restartedAt: "2024-10-15T03:14:59Z"
```

## Section 3: Kustomize ConfigMap Generation

Kustomize's `configMapGenerator` creates immutable-compatible ConfigMaps with content-hash name suffixes:

### Basic configMapGenerator

```yaml
# kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: production

resources:
  - deployment.yaml
  - service.yaml

configMapGenerator:
  - name: app-config
    literals:
      - APP_ENVIRONMENT=production
      - LOG_LEVEL=info
    files:
      - config/database.properties
      - config/app.yaml
    envs:
      - config/app.env

  - name: nginx-config
    files:
      - nginx.conf=config/nginx/nginx.conf
      - default.conf=config/nginx/default.conf
    options:
      annotations:
        config-version: "1.0"
      labels:
        managed-by: kustomize
```

When applied, Kustomize generates:
```
app-config-<hash>
nginx-config-<hash>
```

And automatically updates all references in the Deployment/other resources.

### Environment-Specific Configuration Patches

```
config/
├── base/
│   ├── kustomization.yaml
│   ├── deployment.yaml
│   └── configmap.yaml
├── overlays/
│   ├── staging/
│   │   ├── kustomization.yaml
│   │   └── patches/
│   │       └── app-config.yaml
│   └── production/
│       ├── kustomization.yaml
│       └── patches/
│           └── app-config.yaml
```

```yaml
# base/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - deployment.yaml

configMapGenerator:
  - name: app-config
    literals:
      - DATABASE_HOST=postgres.default.svc.cluster.local
      - LOG_LEVEL=debug
      - REPLICAS=1
```

```yaml
# overlays/production/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

bases:
  - ../../base

# Override ConfigMap values for production
configMapGenerator:
  - name: app-config
    behavior: merge  # Merge with base, override matching keys
    literals:
      - DATABASE_HOST=postgres.production.svc.cluster.local
      - LOG_LEVEL=info
      - REPLICAS=5
```

### ConfigMap Patches with JSON Merge Patch

```yaml
# patches/configmap-patch.yaml — patch specific ConfigMap fields
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  DATABASE_HOST: "postgres.production.svc.cluster.local"
  LOG_LEVEL: "warn"
  # Remove a key by setting it to null (strategic merge patch)
  DEBUG_FLAG: null
```

```yaml
# kustomization.yaml
patches:
  - path: patches/configmap-patch.yaml
    target:
      kind: ConfigMap
      name: app-config
```

## Section 4: Argo CD Drift Detection

Argo CD continuously compares the desired state (Git) with the actual state (cluster) and can automatically remediate drift.

### Application Configuration for Drift Detection

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: my-app
  namespace: argocd
spec:
  project: production

  source:
    repoURL: https://github.com/my-org/my-app.git
    targetRevision: main
    path: k8s/overlays/production

  destination:
    server: https://kubernetes.default.svc
    namespace: production

  syncPolicy:
    # Auto-sync on detected drift
    automated:
      prune: true      # Delete resources not in Git
      selfHeal: true   # Automatically re-apply drifted resources

    syncOptions:
      - CreateNamespace=true
      - ApplyOutOfSyncOnly=true  # Only sync drifted resources
      - ServerSideApply=true

  # Ignore certain differences that are expected to drift
  ignoreDifferences:
    # Ignore replicas if HPA is managing them
    - group: apps
      kind: Deployment
      jsonPointers:
        - /spec/replicas

    # Ignore resource limits that auto-scaling may modify
    - group: apps
      kind: Deployment
      jqPathExpressions:
        - '.spec.template.spec.containers[].resources.limits'
```

### Detecting Manual Changes to ConfigMaps

```bash
# Check Argo CD sync status for a specific application
argocd app get my-app

# Get detailed diff between Git and cluster
argocd app diff my-app

# List all out-of-sync resources
argocd app get my-app --output json | \
  jq '.status.resources[] | select(.status != "Synced") | {kind, name, status}'

# Get details of a specific resource's diff
argocd app diff my-app --server-side-generate \
  | grep -A5 "ConfigMap"
```

### Custom Resource Hooks for Pre-Sync Validation

```yaml
# Argo CD hook: validate ConfigMap before sync
apiVersion: batch/v1
kind: Job
metadata:
  name: config-validator
  annotations:
    argocd.argoproj.io/hook: PreSync
    argocd.argoproj.io/hook-delete-policy: BeforeHookCreation
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: validator
          image: config-validator:v1.0.0
          command:
            - /bin/sh
            - -c
            - |
              echo "Validating ConfigMap..."

              # Check required keys are present
              REQUIRED_KEYS="DATABASE_HOST DATABASE_PORT LOG_LEVEL"
              for key in $REQUIRED_KEYS; do
                if ! kubectl get configmap app-config -o jsonpath="{.data.$key}" \
                    &>/dev/null; then
                  echo "ERROR: Required key $key missing from app-config"
                  exit 1
                fi
              done

              # Validate database connectivity
              DB_HOST=$(kubectl get configmap app-config \
                -o jsonpath="{.data.DATABASE_HOST}")
              if ! nc -z -w5 $DB_HOST 5432; then
                echo "ERROR: Cannot connect to database $DB_HOST:5432"
                exit 1
              fi

              echo "ConfigMap validation passed"
```

### Notification on Drift Detection

```yaml
# Argo CD notifications: alert when sync status changes
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-notifications-cm
  namespace: argocd
data:
  service.slack: |
    token: $slack-token
  template.app-out-of-sync: |
    message: |
      Application {{.app.metadata.name}} is out of sync!
      Environment: {{.app.spec.destination.namespace}}
      Status: {{.app.status.sync.status}}
      Drifted resources:
      {{range .app.status.resources}}
      {{if ne .status "Synced"}}  - {{.kind}}/{{.name}} ({{.status}})
      {{end}}{{end}}
  trigger.on-out-of-sync: |
    - when: app.status.sync.status == 'OutOfSync'
      oncePer: app.metadata.name
      send: [app-out-of-sync]
---
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: production
  namespace: argocd
  annotations:
    notifications.argoproj.io/subscribe.on-out-of-sync.slack: "#platform-alerts"
```

## Section 5: Detecting In-Cluster ConfigMap Mutations

Not all organizations use Argo CD. For manual drift detection:

### Custom Controller for ConfigMap Audit

```go
package main

import (
    "context"
    "crypto/sha256"
    "encoding/json"
    "fmt"
    "log"
    "time"

    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/types"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/manager"
)

// ConfigMapAuditController watches ConfigMaps and detects unauthorized changes.
type ConfigMapAuditController struct {
    client    client.Client
    gitHashes map[types.NamespacedName]string // Expected hashes from Git
    alerter   AlertFunc
}

type AlertFunc func(msg string)

// hashConfigMap creates a deterministic hash of ConfigMap data.
func hashConfigMap(cm *corev1.ConfigMap) string {
    // Sort keys for deterministic ordering
    sortedData, _ := json.Marshal(sortedMap(cm.Data))
    return fmt.Sprintf("%x", sha256.Sum256(sortedData))[:16]
}

func (c *ConfigMapAuditController) Reconcile(ctx context.Context, key types.NamespacedName) error {
    cm := &corev1.ConfigMap{}
    if err := c.client.Get(ctx, key, cm); err != nil {
        return client.IgnoreNotFound(err)
    }

    actualHash := hashConfigMap(cm)
    expectedHash, ok := c.gitHashes[key]

    if !ok {
        log.Printf("ConfigMap %s not tracked in Git — potential rogue resource", key)
        c.alerter(fmt.Sprintf("Untracked ConfigMap detected: %s in namespace %s", key.Name, key.Namespace))
        return nil
    }

    if actualHash != expectedHash {
        c.alerter(fmt.Sprintf(
            "ConfigMap drift detected: %s/%s\n  Expected hash: %s\n  Actual hash: %s\n  Last modified: %s",
            key.Namespace, key.Name,
            expectedHash, actualHash,
            cm.CreationTimestamp.Format(time.RFC3339),
        ))
    }

    return nil
}
```

### ConfigMap Change Detection with kubectl

```bash
#!/bin/bash
# detect-configmap-drift.sh

NAMESPACE=${1:-default}
EXPECTED_DIR=${2:-./k8s/configmaps}

echo "=== ConfigMap Drift Detection ==="
echo "Namespace: $NAMESPACE"
echo "Expected state: $EXPECTED_DIR"

DRIFT_FOUND=false

# Compare each ConfigMap with its expected state
for cm_file in "$EXPECTED_DIR"/*.yaml; do
    CM_NAME=$(yq eval '.metadata.name' "$cm_file")

    # Get current state from cluster
    kubectl get configmap "$CM_NAME" -n "$NAMESPACE" -o yaml > /tmp/current_cm.yaml 2>/dev/null

    if [ $? -ne 0 ]; then
        echo "MISSING: ConfigMap $CM_NAME not found in cluster"
        DRIFT_FOUND=true
        continue
    fi

    # Normalize both for comparison (remove managed fields, timestamps)
    normalize_cm() {
        yq eval 'del(.metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"],
                     .metadata.managedFields,
                     .metadata.resourceVersion,
                     .metadata.uid,
                     .metadata.creationTimestamp,
                     .metadata.generation)' "$1"
    }

    EXPECTED_HASH=$(normalize_cm "$cm_file" | sha256sum | cut -c1-16)
    ACTUAL_HASH=$(normalize_cm /tmp/current_cm.yaml | sha256sum | cut -c1-16)

    if [ "$EXPECTED_HASH" != "$ACTUAL_HASH" ]; then
        echo "DRIFT: ConfigMap $CM_NAME has changed"
        echo "  Expected: $EXPECTED_HASH"
        echo "  Actual:   $ACTUAL_HASH"
        diff <(normalize_cm "$cm_file") <(normalize_cm /tmp/current_cm.yaml)
        DRIFT_FOUND=true
    else
        echo "OK: ConfigMap $CM_NAME matches expected state"
    fi
done

if $DRIFT_FOUND; then
    exit 1
fi
exit 0
```

## Section 6: ConfigMap Versioning Strategy

A complete versioning strategy combines immutability, hash-based naming, and automated cleanup:

### Versioned ConfigMap Lifecycle

```yaml
# Step 1: Create versioned ConfigMap (via CI/CD)
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config-a1b2c3d  # git commit hash
  namespace: production
  labels:
    app: my-app
    git-commit: "a1b2c3d"
    deployed-by: "ci-pipeline"
immutable: true
data:
  DATABASE_HOST: "postgres.production.svc.cluster.local"
  LOG_LEVEL: "info"
```

```bash
# Step 2: Update Deployment to reference new ConfigMap
kubectl patch deployment my-app \
  --type json \
  -p '[{"op": "replace", "path": "/spec/template/spec/containers/0/envFrom/0/configMapRef/name", "value": "app-config-a1b2c3d"}]'

# Step 3: Wait for rollout to complete
kubectl rollout status deployment/my-app

# Step 4: Clean up old ConfigMaps (keep last 3)
kubectl get configmaps -n production \
  -l app=my-app \
  --sort-by=.metadata.creationTimestamp \
  -o jsonpath='{.items[*].metadata.name}' | \
  tr ' ' '\n' | \
  head -n -3 | \
  xargs -r kubectl delete configmap -n production
```

### ConfigMap Cleanup Operator

```go
package cleanup

import (
    "context"
    "sort"

    corev1 "k8s.io/api/core/v1"
    "sigs.k8s.io/controller-runtime/pkg/client"
)

// CleanupOldConfigMaps removes old versioned ConfigMaps, keeping the N most recent.
func CleanupOldConfigMaps(
    ctx context.Context,
    c client.Client,
    namespace, appName string,
    keepCount int,
) error {
    cmList := &corev1.ConfigMapList{}
    if err := c.List(ctx, cmList,
        client.InNamespace(namespace),
        client.MatchingLabels{"app": appName},
    ); err != nil {
        return err
    }

    // Filter to only versioned (immutable) ConfigMaps
    var versioned []corev1.ConfigMap
    for _, cm := range cmList.Items {
        if cm.Immutable != nil && *cm.Immutable {
            versioned = append(versioned, cm)
        }
    }

    // Sort by creation timestamp (oldest first)
    sort.Slice(versioned, func(i, j int) bool {
        return versioned[i].CreationTimestamp.Before(
            &versioned[j].CreationTimestamp)
    })

    // Check which are actively used
    activeConfigMaps := getActiveConfigMaps(ctx, c, namespace, appName)

    // Delete old ones that aren't active
    var deleted int
    for _, cm := range versioned {
        if len(versioned)-deleted <= keepCount {
            break
        }
        if _, isActive := activeConfigMaps[cm.Name]; isActive {
            continue // Don't delete active ConfigMaps
        }

        if err := c.Delete(ctx, &cm); err != nil {
            return err
        }
        deleted++
    }

    return nil
}
```

## Section 7: Validating ConfigMap Contents

Admission webhooks can enforce ConfigMap content policies:

```go
package admission

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"

    corev1 "k8s.io/api/core/v1"
    admissionv1 "k8s.io/api/admission/v1"
)

type ConfigMapValidator struct{}

func (v *ConfigMapValidator) Handle(
    ctx context.Context,
    req admissionv1.AdmissionRequest,
) admissionv1.AdmissionResponse {
    cm := &corev1.ConfigMap{}
    if err := json.Unmarshal(req.Object.Raw, cm); err != nil {
        return deny(fmt.Sprintf("failed to parse ConfigMap: %v", err))
    }

    // Enforce required labels
    requiredLabels := []string{"app", "version", "managed-by"}
    for _, label := range requiredLabels {
        if _, ok := cm.Labels[label]; !ok {
            return deny(fmt.Sprintf("missing required label: %s", label))
        }
    }

    // Enforce immutability for production namespace
    if req.Namespace == "production" {
        if cm.Immutable == nil || !*cm.Immutable {
            return deny("ConfigMaps in production namespace must be immutable")
        }
    }

    // Validate specific keys
    if host, ok := cm.Data["DATABASE_HOST"]; ok {
        if !isValidDNSName(host) {
            return deny(fmt.Sprintf("invalid DATABASE_HOST: %s", host))
        }
    }

    return allow()
}

func deny(reason string) admissionv1.AdmissionResponse {
    return admissionv1.AdmissionResponse{
        Allowed: false,
        Result: &metav1.Status{
            Message: reason,
        },
    }
}

func allow() admissionv1.AdmissionResponse {
    return admissionv1.AdmissionResponse{Allowed: true}
}
```

## Section 8: Multi-Environment Configuration with Kustomize Components

For complex multi-environment setups, Kustomize Components provide reusable configuration modules:

```
config/
├── base/
│   ├── kustomization.yaml
│   └── deployment.yaml
├── components/
│   ├── high-availability/
│   │   ├── kustomization.yaml
│   │   └── patches.yaml
│   ├── debug-logging/
│   │   ├── kustomization.yaml
│   │   └── configmap.yaml
│   └── rate-limiting/
│       ├── kustomization.yaml
│       └── configmap.yaml
└── overlays/
    ├── staging/
    │   └── kustomization.yaml
    └── production/
        └── kustomization.yaml
```

```yaml
# components/debug-logging/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1alpha1
kind: Component

configMapGenerator:
  - name: app-config
    behavior: merge
    literals:
      - LOG_LEVEL=debug
      - LOG_FORMAT=json
      - TRACE_ENABLED=true
```

```yaml
# overlays/staging/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

bases:
  - ../../base

# Compose components for staging
components:
  - ../../components/debug-logging
  - ../../components/high-availability

configMapGenerator:
  - name: app-config
    behavior: merge
    literals:
      - DATABASE_HOST=postgres.staging.svc.cluster.local
      - REPLICAS=2
```

## Section 9: Observability for Configuration Changes

```yaml
# Prometheus recording rule for ConfigMap changes
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: configmap-change-rate
  namespace: monitoring
spec:
  groups:
    - name: configmap.rules
      rules:
        # Count ConfigMap modifications in the last hour
        - alert: HighConfigMapChangeRate
          expr: |
            sum(increase(apiserver_request_total{
              resource="configmaps",
              verb=~"create|update|patch|delete"
            }[1h])) by (namespace) > 20
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High ConfigMap change rate in namespace {{ $labels.namespace }}"
            description: "{{ $value }} ConfigMap changes in the last hour. Possible configuration churn."

        # Alert if ConfigMap update triggers are causing too many pod restarts
        - alert: ConfigMapTriggeredRestartStorm
          expr: |
            sum(increase(kube_pod_container_status_restarts_total[1h])) by (namespace)
            > 50
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High pod restart rate in {{ $labels.namespace }}"
```

## Section 10: Complete GitOps Configuration Pipeline

A complete configuration management pipeline combining all the above techniques:

```bash
#!/bin/bash
# deploy-config.sh — complete configuration deployment pipeline

set -euo pipefail

ENVIRONMENT=$1
GIT_COMMIT=$(git rev-parse --short HEAD)
NAMESPACE="production"
APP_NAME="my-app"

echo "=== Deploying configuration for $ENVIRONMENT ==="

# Step 1: Generate versioned ConfigMap
CONFIGMAP_NAME="${APP_NAME}-config-${GIT_COMMIT}"

# Build the kustomize overlay
kustomize build "k8s/overlays/${ENVIRONMENT}" > /tmp/manifests.yaml

# Inject immutability and version labels
yq eval '
  select(.kind == "ConfigMap") |
  .metadata.name = "'${CONFIGMAP_NAME}'" |
  .immutable = true |
  .metadata.labels["git-commit"] = "'${GIT_COMMIT}'" |
  .metadata.labels["deployed-by"] = "ci-pipeline"
' /tmp/manifests.yaml > /tmp/versioned-configmap.yaml

# Step 2: Apply the new ConfigMap
kubectl apply -f /tmp/versioned-configmap.yaml

# Step 3: Update Deployments to reference the new ConfigMap
kubectl set env deployment/${APP_NAME} \
  --namespace=${NAMESPACE} \
  --from=configmap/${CONFIGMAP_NAME}

# Step 4: Wait for rollout
kubectl rollout status deployment/${APP_NAME} \
  --namespace=${NAMESPACE} \
  --timeout=10m

# Step 5: Verify new config is in use
DEPLOYED_CONFIG=$(kubectl get pods -n ${NAMESPACE} \
  -l app=${APP_NAME} \
  -o jsonpath='{.items[0].spec.containers[0].envFrom[0].configMapRef.name}')

if [ "$DEPLOYED_CONFIG" != "$CONFIGMAP_NAME" ]; then
    echo "ERROR: Deployed config $DEPLOYED_CONFIG != expected $CONFIGMAP_NAME"
    exit 1
fi

# Step 6: Clean up old ConfigMaps (keep last 5)
kubectl get configmaps -n ${NAMESPACE} \
  -l app=${APP_NAME} \
  --sort-by=.metadata.creationTimestamp \
  -o jsonpath='{.items[*].metadata.name}' | \
  tr ' ' '\n' | \
  head -n -5 | \
  xargs -r kubectl delete configmap -n ${NAMESPACE} --ignore-not-found

echo "=== Deployment complete ==="
echo "  ConfigMap: $CONFIGMAP_NAME"
echo "  Git commit: $GIT_COMMIT"
```

## Summary

Effective ConfigMap management requires a multi-layered strategy:

- **Immutable ConfigMaps** with version-stamped names (git hash or semantic version) prevent in-place mutations and enable reliable audit trails; they're the foundational pattern for GitOps-aligned configuration management
- **Kustomize configMapGenerator** automatically appends content hashes to ConfigMap names and updates all references, providing the hash-name pattern without manual management
- **Reloader** or **annotation-based checksum injection** ensures pods pick up ConfigMap changes without manual intervention
- **Argo CD self-heal** with `selfHeal: true` automatically remediates manual cluster changes, enforcing the Git state as the source of truth
- **Admission webhooks** enforce immutability requirements and validate ConfigMap contents before they reach the cluster
- **Prometheus alerts** on high ConfigMap change rates catch configuration churn before it affects production stability

The combination of immutable ConfigMaps, GitOps automation, and drift detection creates a configuration management system where the state of the cluster is always knowable, auditable, and recoverable from Git — regardless of what manual changes operators may have attempted.
