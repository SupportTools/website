---
title: "Traefik Production Incidents: Configuration Management and Recovery"
date: 2026-12-06T00:00:00-05:00
draft: false
tags: ["Traefik", "Kubernetes", "Incident Response", "Configuration Management", "Load Balancer"]
categories: ["DevOps", "Incident Response", "Kubernetes"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A detailed analysis of a 1.5-hour production outage caused by Traefik configuration drift, including incident timeline, root cause analysis, recovery procedures, and architectural improvements to prevent configuration-related failures in enterprise Kubernetes environments."
more_link: "yes"
url: "/traefik-production-incidents-configuration-management-recovery/"
---

At 6:23 AM on a Saturday morning, our production ingress controller stopped routing traffic. What should have been a routine Helm upgrade instead triggered a cascade of failures that took down our entire customer-facing infrastructure for 1.5 hours. The root cause? A subtle interaction between Helm chart upgrades, Traefik configuration drift, and inadequate staging validation that had been building technical debt for months.

This post chronicles that incident, the emergency response procedures that saved us, and the comprehensive configuration management framework we implemented to ensure it never happens again. For teams running Traefik in production, this is essential reading on configuration validation, staged deployments, and disaster recovery.

<!--more-->

## Incident Timeline

### Pre-Incident State (06:00 UTC)

Saturday morning routine maintenance window. The plan was straightforward:
- Upgrade Traefik from version 2.9.6 to 2.10.4
- Apply updated IngressRoute configurations for new TLS certificates
- Complete rollout within 30-minute window

Our production environment consisted of:
- 3 Traefik ingress controller pods (HA deployment)
- 157 IngressRoute resources across 23 namespaces
- 45 middleware configurations
- 12 TLS certificate stores
- Average traffic: 15,000 requests/minute

### Incident Start (06:23 UTC)

The Helm upgrade command was executed:

```bash
helm upgrade traefik traefik/traefik \
  --namespace traefik \
  --version 24.0.0 \
  --values prod-values.yaml \
  --wait \
  --timeout 5m
```

Initial output looked normal:

```
Release "traefik" has been upgraded. Happy Helming!
NAME: traefik
LAST DEPLOYED: Sat Nov 04 06:23:15 2025
NAMESPACE: traefik
STATUS: deployed
REVISION: 47
```

However, within 2 minutes, monitoring alerts started firing:

```
[CRITICAL] HTTP 503 responses > 50%
[CRITICAL] Traefik pod restarts detected
[CRITICAL] SSL certificate validation failures
[WARNING] Backend connection failures increasing
```

### Initial Assessment (06:25 UTC)

The on-call engineer checked pod status:

```bash
kubectl get pods -n traefik

NAME                       READY   STATUS             RESTARTS   AGE
traefik-7d9f8b6c4-2kqm9   0/1     CrashLoopBackOff   3          2m
traefik-7d9f8b6c4-h7x2p   0/1     CrashLoopBackOff   3          2m
traefik-7d9f8b6c4-n9k5w   0/1     CrashLoopBackOff   3          2m
```

All three Traefik pods were in CrashLoopBackOff. Checking logs revealed the issue:

```bash
kubectl logs traefik-7d9f8b6c4-2kqm9 -n traefik

time="2025-11-04T06:23:47Z" level=error msg="Configuration error: conflicting middleware definitions"
time="2025-11-04T06:23:47Z" level=error msg="Middleware 'auth-middleware@kubernetescrd' already exists with different configuration"
time="2025-11-04T06:23:47Z" level=fatal msg="Error configuring provider: middleware configuration conflict"
```

### Failed Recovery Attempt #1 (06:30 UTC)

First instinct: rollback the Helm release.

```bash
helm rollback traefik -n traefik
```

Result: Rollback failed. The previous Helm revision also had configuration issues that had been masked by runtime state.

```
Error: UPGRADE FAILED: failed to create resource: Ingress.extensions "api-gateway" is invalid
```

### Critical Discovery (06:35 UTC)

Examining the Helm history showed a concerning pattern:

```bash
helm history traefik -n traefik

REVISION  UPDATED                   STATUS      CHART           DESCRIPTION
42        Thu Nov 02 14:23:01 2025  superseded  traefik-23.0.1  Upgrade complete
43        Thu Nov 02 16:45:12 2025  superseded  traefik-23.0.1  Upgrade complete
44        Fri Nov 03 09:12:33 2025  superseded  traefik-23.1.0  Upgrade complete
45        Fri Nov 03 14:22:45 2025  superseded  traefik-23.1.0  Upgrade complete
46        Fri Nov 03 18:30:11 2025  superseded  traefik-23.2.0  Upgrade complete
47        Sat Nov 04 06:23:15 2025  failed      traefik-24.0.0  Upgrade failed
```

Six upgrades in 48 hours, each applying incremental changes without full validation. Configuration drift had accumulated silently.

### Emergency Response (06:40 UTC)

With rollback failing, we needed a different approach. The team made the critical decision to:

1. Export current working configuration from staging (known good state)
2. Manually reconcile with production requirements
3. Perform a clean installation with validated configuration

```bash
# Export staging configuration
kubectl get ingressroute -n traefik -o yaml > staging-ingressroutes.yaml
kubectl get middleware -n traefik -o yaml > staging-middleware.yaml
kubectl get tlsoption -n traefik -o yaml > staging-tlsoptions.yaml

# Delete the failed Traefik installation
helm delete traefik -n traefik

# Wait for all resources to be cleaned up
kubectl delete all --all -n traefik --grace-period=0 --force

# Reinstall with validated configuration
helm install traefik traefik/traefik \
  --namespace traefik \
  --version 23.2.0 \
  --values validated-prod-values.yaml \
  --wait \
  --timeout 10m
```

### Service Restoration (07:15 UTC)

After installing Traefik with the last known good configuration (version 23.2.0), services began responding:

```bash
kubectl get pods -n traefik

NAME                       READY   STATUS    RESTARTS   AGE
traefik-6c8f7b5d9-4mh2x   1/1     Running   0          3m
traefik-6c8f7b5d9-7xk9n   1/1     Running   0          3m
traefik-6c8f7b5d9-p2w8q   1/1     Running   0          3m
```

Traffic resumed, but at reduced capacity. The team monitored error rates and gradually increased replica count.

### Post-Incident Investigation (07:30 UTC - 10:00 UTC)

Root cause analysis revealed multiple contributing factors:

1. **Configuration Drift**: Middleware definitions had been modified directly in production without updating Helm values
2. **Inadequate Staging**: Staging environment didn't replicate full production IngressRoute complexity
3. **No Pre-Flight Validation**: Helm upgrades lacked configuration validation before application
4. **Incomplete Testing**: Previous "successful" upgrades had latent issues masked by Traefik's graceful degradation
5. **Missing Backup Strategy**: No quick recovery path for complete ingress controller failure

## Root Cause Analysis

### Configuration Drift Deep Dive

The core issue was configuration drift between Helm-managed resources and kubectl-applied resources. Here's what happened:

#### Initial State (Helm-Managed)

```yaml
# From Helm chart values
apiVersion: traefik.containo.us/v1alpha1
kind: Middleware
metadata:
  name: auth-middleware
  namespace: traefik
spec:
  forwardAuth:
    address: http://auth-service:8080/verify
    trustForwardHeader: true
```

#### Production Modification (kubectl apply)

A developer had applied a hotfix directly:

```yaml
# Applied via kubectl apply -f
apiVersion: traefik.containo.us/v1alpha1
kind: Middleware
metadata:
  name: auth-middleware
  namespace: traefik
  annotations:
    meta.helm.sh/release-name: traefik  # This made it appear Helm-managed
spec:
  forwardAuth:
    address: http://auth-service:8080/verify
    trustForwardHeader: true
    authResponseHeaders:
      - X-Auth-User
      - X-Auth-Groups
    authRequestHeaders:
      - Authorization
```

When Helm attempted to upgrade, it found conflicting definitions and failed to reconcile.

### Traefik Configuration Validation Gap

Traefik validates configuration at startup, but the validation didn't catch all drift scenarios:

```go
// Simplified example of the validation issue
type Middleware struct {
    ForwardAuth *ForwardAuth `json:"forwardAuth,omitempty"`
}

type ForwardAuth struct {
    Address            string   `json:"address"`
    TrustForwardHeader bool     `json:"trustForwardHeader"`
    AuthResponseHeaders []string `json:"authResponseHeaders,omitempty"`
    // New fields added in 2.10.4
    AuthRequestHeaders []string `json:"authRequestHeaders,omitempty"`
}

// During upgrade, Traefik found two middleware with same name
// but different configurations - unable to merge or choose
```

### Staging Environment Gaps

Our staging environment lacked production parity:

| Aspect | Production | Staging | Gap |
|--------|-----------|---------|-----|
| IngressRoutes | 157 | 12 | 92% fewer resources |
| Namespaces | 23 | 3 | 87% fewer namespaces |
| Middleware | 45 | 8 | 82% fewer middleware |
| TLS Certificates | 12 | 2 | 83% fewer certificates |
| Traffic Volume | 15k req/min | ~50 req/min | 99.7% less traffic |

The reduced complexity in staging meant configuration conflicts didn't manifest during testing.

## Recovery Procedures

### Emergency Rollback Procedure

We developed a comprehensive emergency rollback procedure:

```bash
#!/bin/bash
# emergency-traefik-rollback.sh
# Emergency procedure for Traefik ingress controller recovery

set -euo pipefail

NAMESPACE="traefik"
BACKUP_DIR="/var/backups/traefik"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

echo "=== Traefik Emergency Rollback Procedure ==="
echo "Timestamp: $TIMESTAMP"
echo "Namespace: $NAMESPACE"
echo ""

# Step 1: Backup current state
echo "Step 1: Backing up current state..."
mkdir -p "$BACKUP_DIR/$TIMESTAMP"

kubectl get all -n $NAMESPACE -o yaml > "$BACKUP_DIR/$TIMESTAMP/all-resources.yaml"
kubectl get ingressroute --all-namespaces -o yaml > "$BACKUP_DIR/$TIMESTAMP/ingressroutes.yaml"
kubectl get middleware --all-namespaces -o yaml > "$BACKUP_DIR/$TIMESTAMP/middleware.yaml"
kubectl get tlsoption --all-namespaces -o yaml > "$BACKUP_DIR/$TIMESTAMP/tlsoptions.yaml"
kubectl get tlsstore --all-namespaces -o yaml > "$BACKUP_DIR/$TIMESTAMP/tlsstores.yaml"
kubectl get ingressroutetcp --all-namespaces -o yaml > "$BACKUP_DIR/$TIMESTAMP/ingressroutetcp.yaml"
kubectl get ingressrouteudp --all-namespaces -o yaml > "$BACKUP_DIR/$TIMESTAMP/ingressrouteudp.yaml"

helm get values traefik -n $NAMESPACE > "$BACKUP_DIR/$TIMESTAMP/helm-values.yaml"
helm get manifest traefik -n $NAMESPACE > "$BACKUP_DIR/$TIMESTAMP/helm-manifest.yaml"

echo "Backup completed: $BACKUP_DIR/$TIMESTAMP"

# Step 2: Check for last known good backup
echo ""
echo "Step 2: Checking for last known good backup..."

LAST_GOOD_BACKUP=$(find "$BACKUP_DIR" -name "*.validated" -type f | sort -r | head -n 1)

if [ -z "$LAST_GOOD_BACKUP" ]; then
    echo "ERROR: No validated backup found!"
    echo "Please specify backup directory manually."
    exit 1
fi

RESTORE_DIR=$(dirname "$LAST_GOOD_BACKUP")
echo "Found validated backup: $RESTORE_DIR"
echo ""

# Step 3: Confirmation
echo "Step 3: Confirmation required"
echo "This will:"
echo "  1. Delete current Traefik installation"
echo "  2. Remove all Traefik CRD resources"
echo "  3. Restore from: $RESTORE_DIR"
echo ""
read -p "Continue? (type 'yes' to proceed): " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
    echo "Rollback cancelled."
    exit 0
fi

# Step 4: Delete current installation
echo ""
echo "Step 4: Removing current Traefik installation..."

# Scale down to prevent further traffic disruption
kubectl scale deployment traefik -n $NAMESPACE --replicas=0

# Delete Helm release
helm delete traefik -n $NAMESPACE --wait || true

# Delete any remaining resources
kubectl delete ingressroute --all --all-namespaces --wait=false || true
kubectl delete middleware --all --all-namespaces --wait=false || true
kubectl delete tlsoption --all --all-namespaces --wait=false || true
kubectl delete tlsstore --all --all-namespaces --wait=false || true
kubectl delete ingressroutetcp --all --all-namespaces --wait=false || true
kubectl delete ingressrouteudp --all --all-namespaces --wait=false || true

# Force delete any stuck resources
kubectl delete all --all -n $NAMESPACE --grace-period=0 --force || true

echo "Waiting 30 seconds for cleanup..."
sleep 30

# Step 5: Restore from backup
echo ""
echo "Step 5: Restoring from validated backup..."

# Restore Helm release
CHART_VERSION=$(cat "$RESTORE_DIR/chart-version.txt")
helm install traefik traefik/traefik \
    --namespace $NAMESPACE \
    --version "$CHART_VERSION" \
    --values "$RESTORE_DIR/helm-values.yaml" \
    --wait \
    --timeout 10m

# Wait for Traefik to be ready
echo "Waiting for Traefik pods to be ready..."
kubectl wait --for=condition=ready pod \
    -l app.kubernetes.io/name=traefik \
    -n $NAMESPACE \
    --timeout=300s

# Restore CRD resources
echo "Restoring IngressRoutes and Middleware..."
kubectl apply -f "$RESTORE_DIR/ingressroutes.yaml" --wait=true
kubectl apply -f "$RESTORE_DIR/middleware.yaml" --wait=true
kubectl apply -f "$RESTORE_DIR/tlsoptions.yaml" --wait=true
kubectl apply -f "$RESTORE_DIR/tlsstores.yaml" --wait=true

# Step 6: Validation
echo ""
echo "Step 6: Validating restoration..."

# Check pod status
PODS_READY=$(kubectl get pods -n $NAMESPACE -l app.kubernetes.io/name=traefik -o json | \
    jq '.items | length')
PODS_RUNNING=$(kubectl get pods -n $NAMESPACE -l app.kubernetes.io/name=traefik -o json | \
    jq '[.items[] | select(.status.phase=="Running")] | length')

echo "Pods ready: $PODS_RUNNING/$PODS_READY"

if [ "$PODS_RUNNING" -ne "$PODS_READY" ]; then
    echo "WARNING: Not all pods are running!"
fi

# Check service endpoint
TRAEFIK_IP=$(kubectl get svc traefik -n $NAMESPACE -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
echo "Traefik LoadBalancer IP: $TRAEFIK_IP"

# Test health endpoint
echo "Testing Traefik health endpoint..."
if curl -sf "http://$TRAEFIK_IP:8080/ping" > /dev/null; then
    echo "✓ Health check passed"
else
    echo "✗ Health check failed"
    exit 1
fi

# Step 7: Traffic validation
echo ""
echo "Step 7: Validating traffic routing..."

# Test a sample IngressRoute
TEST_ROUTES=$(kubectl get ingressroute --all-namespaces -o json | \
    jq -r '.items[0:3] | .[] | "\(.metadata.namespace)/\(.metadata.name)"')

for ROUTE in $TEST_ROUTES; do
    echo "Testing route: $ROUTE"
    # Add specific validation logic here
done

echo ""
echo "=== Rollback Complete ==="
echo "Timestamp: $(date +%Y%m%d_%H%M%S)"
echo "Restored from: $RESTORE_DIR"
echo ""
echo "Next steps:"
echo "  1. Monitor error rates and traffic metrics"
echo "  2. Review incident timeline and root cause"
echo "  3. Update runbooks and procedures"
echo "  4. Schedule post-incident review"
```

### Automated Backup Strategy

We implemented automated backups of known-good configurations:

```yaml
# traefik-backup-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: traefik-config-backup
  namespace: traefik
spec:
  schedule: "0 */6 * * *"  # Every 6 hours
  successfulJobsHistoryLimit: 10
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: traefik-backup
          containers:
          - name: backup
            image: bitnami/kubectl:latest
            command:
            - /bin/bash
            - -c
            - |
              set -euo pipefail

              BACKUP_DIR="/backups/traefik"
              TIMESTAMP=$(date +%Y%m%d_%H%M%S)
              TARGET_DIR="$BACKUP_DIR/$TIMESTAMP"

              mkdir -p "$TARGET_DIR"

              # Export all Traefik resources
              kubectl get ingressroute --all-namespaces -o yaml > "$TARGET_DIR/ingressroutes.yaml"
              kubectl get middleware --all-namespaces -o yaml > "$TARGET_DIR/middleware.yaml"
              kubectl get tlsoption --all-namespaces -o yaml > "$TARGET_DIR/tlsoptions.yaml"
              kubectl get tlsstore --all-namespaces -o yaml > "$TARGET_DIR/tlsstores.yaml"

              # Export Helm configuration
              helm get values traefik -n traefik > "$TARGET_DIR/helm-values.yaml"
              helm list -n traefik -o json | jq -r '.[0].chart' | cut -d'-' -f2 > "$TARGET_DIR/chart-version.txt"

              # Validate configuration
              echo "Validating configuration..."
              if kubectl apply --dry-run=server -f "$TARGET_DIR/ingressroutes.yaml" && \
                 kubectl apply --dry-run=server -f "$TARGET_DIR/middleware.yaml"; then
                  touch "$TARGET_DIR/backup.validated"
                  echo "✓ Configuration validated successfully"
              else
                  echo "✗ Configuration validation failed"
                  exit 1
              fi

              # Upload to S3 (optional)
              if [ -n "${AWS_S3_BUCKET:-}" ]; then
                  aws s3 sync "$TARGET_DIR" "s3://$AWS_S3_BUCKET/traefik-backups/$TIMESTAMP/"
                  echo "✓ Backup uploaded to S3"
              fi

              # Cleanup old backups (keep last 30 days)
              find "$BACKUP_DIR" -type d -mtime +30 -exec rm -rf {} +

              echo "Backup completed: $TARGET_DIR"

            volumeMounts:
            - name: backup-storage
              mountPath: /backups
            env:
            - name: AWS_S3_BUCKET
              valueFrom:
                configMapKeyRef:
                  name: backup-config
                  key: s3-bucket
                  optional: true

          volumes:
          - name: backup-storage
            persistentVolumeClaim:
              claimName: traefik-backup-pvc

          restartPolicy: OnFailure
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: traefik-backup
  namespace: traefik
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: traefik-backup
rules:
- apiGroups: ["traefik.containo.us"]
  resources: ["*"]
  verbs: ["get", "list"]
- apiGroups: [""]
  resources: ["services", "endpoints", "secrets"]
  verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: traefik-backup
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: traefik-backup
subjects:
- kind: ServiceAccount
  name: traefik-backup
  namespace: traefik
```

## Configuration Validation Framework

### Pre-Flight Validation Script

We developed a comprehensive validation script that runs before any Helm upgrade:

```bash
#!/bin/bash
# traefik-preflight-validation.sh
# Validates Traefik configuration before deployment

set -euo pipefail

NAMESPACE="${1:-traefik}"
VALUES_FILE="${2:-values.yaml}"
CHART_VERSION="${3:-latest}"

echo "=== Traefik Pre-Flight Validation ==="
echo "Namespace: $NAMESPACE"
echo "Values File: $VALUES_FILE"
echo "Chart Version: $CHART_VERSION"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

VALIDATION_FAILED=0

# Function to print test results
print_result() {
    local test_name="$1"
    local result="$2"
    local message="$3"

    if [ "$result" -eq 0 ]; then
        echo -e "${GREEN}✓${NC} $test_name"
    else
        echo -e "${RED}✗${NC} $test_name"
        echo -e "  ${message}"
        VALIDATION_FAILED=1
    fi
}

# Test 1: Helm chart availability
echo "Test 1: Checking Helm chart availability..."
if helm search repo traefik/traefik --version "$CHART_VERSION" > /dev/null 2>&1; then
    print_result "Helm chart availability" 0 ""
else
    print_result "Helm chart availability" 1 "Chart version $CHART_VERSION not found"
fi

# Test 2: Values file syntax
echo "Test 2: Validating values file syntax..."
if helm lint traefik/traefik --values "$VALUES_FILE" > /dev/null 2>&1; then
    print_result "Values file syntax" 0 ""
else
    print_result "Values file syntax" 1 "Syntax errors in values file"
fi

# Test 3: Template rendering
echo "Test 3: Testing template rendering..."
TEMP_DIR=$(mktemp -d)
if helm template traefik traefik/traefik \
    --version "$CHART_VERSION" \
    --values "$VALUES_FILE" \
    --output-dir "$TEMP_DIR" > /dev/null 2>&1; then
    print_result "Template rendering" 0 ""
else
    print_result "Template rendering" 1 "Template rendering failed"
fi

# Test 4: Dry-run installation
echo "Test 4: Performing dry-run installation..."
if helm upgrade --install traefik traefik/traefik \
    --namespace "$NAMESPACE" \
    --version "$CHART_VERSION" \
    --values "$VALUES_FILE" \
    --dry-run > /dev/null 2>&1; then
    print_result "Dry-run installation" 0 ""
else
    print_result "Dry-run installation" 1 "Dry-run failed"
fi

# Test 5: Configuration conflict detection
echo "Test 5: Checking for configuration conflicts..."
RENDERED_MANIFEST="$TEMP_DIR/traefik/templates"

# Check for duplicate middleware names
DUPLICATE_MIDDLEWARE=$(grep -h "kind: Middleware" "$RENDERED_MANIFEST"/* | \
    grep "name:" | sort | uniq -d | wc -l)

if [ "$DUPLICATE_MIDDLEWARE" -eq 0 ]; then
    print_result "Middleware conflicts" 0 ""
else
    print_result "Middleware conflicts" 1 "$DUPLICATE_MIDDLEWARE duplicate middleware definitions found"
fi

# Check for duplicate IngressRoute names
DUPLICATE_ROUTES=$(grep -h "kind: IngressRoute" "$RENDERED_MANIFEST"/* | \
    grep "name:" | sort | uniq -d | wc -l)

if [ "$DUPLICATE_ROUTES" -eq 0 ]; then
    print_result "IngressRoute conflicts" 0 ""
else
    print_result "IngressRoute conflicts" 1 "$DUPLICATE_ROUTES duplicate IngressRoute definitions found"
fi

# Test 6: Resource limits validation
echo "Test 6: Validating resource limits..."
RESOURCE_LIMITS=$(helm template traefik traefik/traefik \
    --version "$CHART_VERSION" \
    --values "$VALUES_FILE" | \
    yq e '.spec.template.spec.containers[].resources.limits' - 2>/dev/null || echo "")

if [ -n "$RESOURCE_LIMITS" ]; then
    print_result "Resource limits defined" 0 ""
else
    print_result "Resource limits defined" 1 "Resource limits not defined (recommended for production)"
    VALIDATION_FAILED=1
fi

# Test 7: High availability configuration
echo "Test 7: Validating HA configuration..."
REPLICA_COUNT=$(yq e '.deployment.replicas' "$VALUES_FILE" 2>/dev/null || echo "1")

if [ "$REPLICA_COUNT" -ge 3 ]; then
    print_result "High availability (replicas >= 3)" 0 ""
else
    print_result "High availability (replicas >= 3)" 1 "Only $REPLICA_COUNT replicas configured (recommended: >= 3)"
fi

# Test 8: TLS configuration validation
echo "Test 8: Validating TLS configuration..."
TLS_ENABLED=$(yq e '.ports.websecure.tls.enabled' "$VALUES_FILE" 2>/dev/null || echo "false")

if [ "$TLS_ENABLED" = "true" ]; then
    print_result "TLS enabled" 0 ""
else
    print_result "TLS enabled" 1 "TLS not enabled (recommended for production)"
fi

# Test 9: Probe configuration
echo "Test 9: Validating health probes..."
READINESS_PROBE=$(yq e '.readinessProbe' "$VALUES_FILE" 2>/dev/null || echo "")
LIVENESS_PROBE=$(yq e '.livenessProbe' "$VALUES_FILE" 2>/dev/null || echo "")

if [ -n "$READINESS_PROBE" ] && [ -n "$LIVENESS_PROBE" ]; then
    print_result "Health probes configured" 0 ""
else
    print_result "Health probes configured" 1 "Health probes not properly configured"
fi

# Test 10: Security context validation
echo "Test 10: Validating security context..."
SECURITY_CONTEXT=$(helm template traefik traefik/traefik \
    --version "$CHART_VERSION" \
    --values "$VALUES_FILE" | \
    yq e '.spec.template.spec.securityContext' - 2>/dev/null || echo "")

if [ -n "$SECURITY_CONTEXT" ]; then
    print_result "Security context defined" 0 ""
else
    print_result "Security context defined" 1 "Security context not defined (recommended)"
fi

# Test 11: Check existing IngressRoutes compatibility
echo "Test 11: Validating existing IngressRoute compatibility..."
INCOMPATIBLE_ROUTES=0

for ROUTE in $(kubectl get ingressroute --all-namespaces -o json | \
    jq -r '.items[] | "\(.metadata.namespace)/\(.metadata.name)"'); do

    NAMESPACE_NAME=$(echo "$ROUTE" | cut -d'/' -f1)
    ROUTE_NAME=$(echo "$ROUTE" | cut -d'/' -f2)

    # Check if route uses deprecated features
    DEPRECATED=$(kubectl get ingressroute "$ROUTE_NAME" -n "$NAMESPACE_NAME" -o json | \
        jq -r '.spec | has("tls") and (.tls | has("options"))' 2>/dev/null || echo "false")

    if [ "$DEPRECATED" = "true" ]; then
        ((INCOMPATIBLE_ROUTES++))
    fi
done

if [ "$INCOMPATIBLE_ROUTES" -eq 0 ]; then
    print_result "IngressRoute compatibility" 0 ""
else
    print_result "IngressRoute compatibility" 1 "$INCOMPATIBLE_ROUTES routes use deprecated features"
fi

# Test 12: Staging validation check
echo "Test 12: Checking staging validation..."
if [ -f "/tmp/traefik-staging-validated" ]; then
    STAGING_VALIDATED=$(cat /tmp/traefik-staging-validated)
    if [ "$STAGING_VALIDATED" = "true" ]; then
        print_result "Staging validation" 0 ""
    else
        print_result "Staging validation" 1 "Configuration not validated in staging"
    fi
else
    print_result "Staging validation" 1 "No staging validation record found"
fi

# Cleanup
rm -rf "$TEMP_DIR"

# Final result
echo ""
echo "=== Validation Summary ==="
if [ "$VALIDATION_FAILED" -eq 0 ]; then
    echo -e "${GREEN}All validations passed!${NC}"
    echo "Safe to proceed with deployment."
    exit 0
else
    echo -e "${RED}Validation failed!${NC}"
    echo "Please address the issues before deploying."
    exit 1
fi
```

### Automated Staging Validation

We implemented a CI/CD pipeline that automatically validates changes in staging:

```yaml
# .gitlab-ci.yml
stages:
  - validate
  - deploy-staging
  - test-staging
  - deploy-production

variables:
  TRAEFIK_CHART_VERSION: "24.0.0"
  STAGING_NAMESPACE: "traefik-staging"
  PROD_NAMESPACE: "traefik"

validate-configuration:
  stage: validate
  image: alpine/helm:latest
  script:
    - helm repo add traefik https://traefik.github.io/charts
    - helm repo update
    - ./scripts/traefik-preflight-validation.sh $STAGING_NAMESPACE staging-values.yaml $TRAEFIK_CHART_VERSION
  only:
    - main
    - merge_requests

deploy-staging:
  stage: deploy-staging
  image: alpine/helm:latest
  script:
    - helm repo add traefik https://traefik.github.io/charts
    - helm upgrade --install traefik traefik/traefik
        --namespace $STAGING_NAMESPACE
        --create-namespace
        --version $TRAEFIK_CHART_VERSION
        --values staging-values.yaml
        --wait
        --timeout 10m
    - kubectl wait --for=condition=ready pod
        -l app.kubernetes.io/name=traefik
        -n $STAGING_NAMESPACE
        --timeout=300s
  only:
    - main
  environment:
    name: staging

test-staging:
  stage: test-staging
  image: curlimages/curl:latest
  script:
    - ./scripts/test-traefik-routes.sh $STAGING_NAMESPACE
    - |
      if [ $? -eq 0 ]; then
        echo "true" > /tmp/traefik-staging-validated
      else
        echo "Staging validation failed!"
        exit 1
      fi
  artifacts:
    paths:
      - /tmp/traefik-staging-validated
    expire_in: 1 hour
  only:
    - main
  environment:
    name: staging

deploy-production:
  stage: deploy-production
  image: alpine/helm:latest
  script:
    - |
      if [ ! -f "/tmp/traefik-staging-validated" ]; then
        echo "ERROR: Staging validation not found!"
        exit 1
      fi
    - helm repo add traefik https://traefik.github.io/charts
    - ./scripts/traefik-preflight-validation.sh $PROD_NAMESPACE prod-values.yaml $TRAEFIK_CHART_VERSION
    - helm upgrade --install traefik traefik/traefik
        --namespace $PROD_NAMESPACE
        --version $TRAEFIK_CHART_VERSION
        --values prod-values.yaml
        --wait
        --timeout 10m
    - kubectl wait --for=condition=ready pod
        -l app.kubernetes.io/name=traefik
        -n $PROD_NAMESPACE
        --timeout=300s
  only:
    - main
  when: manual
  environment:
    name: production
```

## Configuration Management Best Practices

### 1. Single Source of Truth

All Traefik configuration must be managed through Helm:

```yaml
# prod-values.yaml - Complete configuration
deployment:
  replicas: 3
  podAnnotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "9090"

resources:
  requests:
    cpu: "1000m"
    memory: "1Gi"
  limits:
    cpu: "2000m"
    memory: "2Gi"

service:
  type: LoadBalancer
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-type: "nlb"
    service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "true"

ports:
  web:
    port: 80
    exposedPort: 80
    redirectTo: websecure
  websecure:
    port: 443
    exposedPort: 443
    tls:
      enabled: true
      certResolver: letsencrypt
  metrics:
    port: 9090
    expose: false

ingressRoute:
  dashboard:
    enabled: true
    annotations:
      kubernetes.io/ingress.class: traefik

providers:
  kubernetesIngress:
    publishedService:
      enabled: true
  kubernetesCRD:
    enabled: true
    allowCrossNamespace: true
    allowExternalNameServices: true

logs:
  general:
    level: INFO
  access:
    enabled: true
    format: json
    fields:
      headers:
        defaultMode: keep

metrics:
  prometheus:
    enabled: true
    entryPoint: metrics

additionalArguments:
  - "--providers.kubernetesingress.ingressclass=traefik"
  - "--serversTransport.insecureSkipVerify=true"
  - "--api.dashboard=true"
  - "--ping=true"
```

### 2. GitOps Workflow

All changes follow a strict GitOps workflow:

```bash
# Developer workflow
1. Create feature branch
   git checkout -b feature/update-traefik-config

2. Modify values files
   vi helm/traefik/staging-values.yaml
   vi helm/traefik/prod-values.yaml

3. Validate locally
   ./scripts/traefik-preflight-validation.sh traefik-staging staging-values.yaml

4. Commit and push
   git add helm/traefik/
   git commit -m "Update Traefik timeout configurations"
   git push origin feature/update-traefik-config

5. Create merge request

6. CI/CD pipeline runs:
   - Validate configuration
   - Deploy to staging
   - Run integration tests
   - Await manual approval for production

7. After approval, deploy to production
```

### 3. Version Pinning

Always pin specific versions in production:

```yaml
# Chart.yaml
dependencies:
  - name: traefik
    version: 24.0.0  # Specific version, not "latest" or "~24.0.0"
    repository: https://traefik.github.io/charts
```

### 4. Configuration Documentation

Document all non-default configurations:

```yaml
# prod-values.yaml with inline documentation
deployment:
  # Use 3 replicas for HA across availability zones
  replicas: 3

resources:
  limits:
    # Based on load testing: 2000 req/s peak with 1000m CPU
    # See: docs/load-testing/2025-10-15-results.md
    cpu: "2000m"
    memory: "2Gi"

additionalArguments:
  # Skip certificate verification for internal services
  # Required for legacy services without valid certificates
  # TODO: Remove after certificate migration (Q1 2026)
  - "--serversTransport.insecureSkipVerify=true"
```

## Monitoring and Alerting

### Traefik Metrics Dashboard

We created a comprehensive Grafana dashboard:

```json
{
  "dashboard": {
    "title": "Traefik Production Metrics",
    "panels": [
      {
        "title": "Request Rate",
        "targets": [
          {
            "expr": "rate(traefik_entrypoint_requests_total[5m])"
          }
        ]
      },
      {
        "title": "Response Time (p95)",
        "targets": [
          {
            "expr": "histogram_quantile(0.95, rate(traefik_entrypoint_request_duration_seconds_bucket[5m]))"
          }
        ]
      },
      {
        "title": "Error Rate (5xx)",
        "targets": [
          {
            "expr": "rate(traefik_entrypoint_requests_total{code=~\"5..\"}[5m])"
          }
        ]
      },
      {
        "title": "Configuration Reloads",
        "targets": [
          {
            "expr": "increase(traefik_config_reloads_total[1h])"
          }
        ]
      }
    ]
  }
}
```

### Alerting Rules

Critical alerts for Traefik health:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-traefik-rules
  namespace: monitoring
data:
  traefik-alerts.yaml: |
    groups:
    - name: traefik
      interval: 30s
      rules:
      - alert: TraefikDown
        expr: up{job="traefik"} == 0
        for: 1m
        labels:
          severity: critical
          component: traefik
        annotations:
          summary: "Traefik instance {{ $labels.instance }} is down"
          description: "Traefik has been down for more than 1 minute"

      - alert: TraefikHighErrorRate
        expr: rate(traefik_entrypoint_requests_total{code=~"5.."}[5m]) > 0.05
        for: 2m
        labels:
          severity: critical
          component: traefik
        annotations:
          summary: "High 5xx error rate on {{ $labels.entrypoint }}"
          description: "Error rate is {{ $value | humanizePercentage }} (threshold: 5%)"

      - alert: TraefikConfigReloadFailure
        expr: increase(traefik_config_reloads_failure_total[5m]) > 0
        for: 1m
        labels:
          severity: warning
          component: traefik
        annotations:
          summary: "Traefik configuration reload failed"
          description: "Configuration reload has failed {{ $value }} times in the last 5 minutes"

      - alert: TraefikBackendDown
        expr: traefik_backend_server_up == 0
        for: 2m
        labels:
          severity: warning
          component: traefik
        annotations:
          summary: "Backend {{ $labels.backend }} is down"
          description: "Backend has been unavailable for more than 2 minutes"

      - alert: TraefikCertificateExpiring
        expr: (traefik_tls_certs_not_after - time()) / 86400 < 7
        for: 1h
        labels:
          severity: warning
          component: traefik
        annotations:
          summary: "TLS certificate expiring soon"
          description: "Certificate for {{ $labels.cn }} expires in {{ $value }} days"
```

## Lessons Learned

### 1. Configuration Drift is Silent and Deadly

The incident was caused by months of accumulated configuration drift. Small, well-intentioned hotfixes bypassed our GitOps workflow and created hidden inconsistencies.

**Prevention:**
- Implement admission controllers to block kubectl apply of managed resources
- Regular configuration audits comparing Git to cluster state
- Mandatory code review for all configuration changes

### 2. Staging Must Match Production

Our 92% smaller staging environment failed to catch the issue. Configuration complexity doesn't scale linearly - the interactions between components create exponential complexity.

**Solution:**
- Staging now has full production parity (same number of IngressRoutes, Middleware, etc.)
- Use production traffic replays in staging
- Regular "chaos days" where we test failure scenarios

### 3. Rollback is Not Always Safe

We assumed Helm rollback would always work. When the previous revision also had latent issues, rollback failed.

**Mitigation:**
- Automated backups of validated configurations
- Emergency recovery procedures tested quarterly
- "Break glass" procedures for complete reinstallation

### 4. Validation Before Deployment

Pre-flight validation catches issues before they impact production. A 5-minute validation script saved us from future 1.5-hour outages.

**Implementation:**
- Mandatory pre-flight validation in CI/CD pipeline
- Manual deployments require validation script completion
- Validation results logged and tracked

### 5. Documentation During Crisis

During the incident, we wasted precious minutes searching for procedures and commands. Having a well-documented runbook would have reduced recovery time significantly.

**Improvement:**
- Created comprehensive runbooks for common scenarios
- Regular runbook validation exercises
- On-call engineer training includes runbook walkthrough

## Conclusion

The Traefik production incident was a painful but valuable learning experience. What started as a routine upgrade exposed fundamental weaknesses in our configuration management, testing, and recovery procedures.

The key lessons:

1. **Configuration drift kills** - Implement strict GitOps workflows and admission controls
2. **Staging must match production** - Not just in resources, but in complexity and topology
3. **Validate before deploying** - Automated pre-flight validation is not optional
4. **Have a recovery plan** - Test your disaster recovery procedures regularly
5. **Learn from incidents** - Document, share, and improve after every outage

Since implementing these changes:
- Zero configuration-related incidents in 6 months
- Mean time to recovery (MTTR) reduced from 90 minutes to < 10 minutes for similar issues
- Configuration drift detected and prevented by admission controllers
- Team confidence in deployment process significantly improved

The incident was costly, but the architectural improvements and operational maturity we gained were invaluable. For teams running Traefik in production, invest in configuration management and validation now - before an incident forces you to.

## Additional Resources

- [Traefik Documentation](https://doc.traefik.io/traefik/)
- [Helm Best Practices](https://helm.sh/docs/chart_best_practices/)
- [GitOps Principles](https://www.gitops.tech/)
- [Kubernetes Configuration Management](https://kubernetes.io/docs/tasks/manage-kubernetes-objects/declarative-config/)

For consultation on Traefik architecture and incident response, contact mmattox@support.tools.