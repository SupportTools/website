---
title: "Kubernetes Projected Volumes: Combining ConfigMaps, Secrets, Service Account Tokens, and DownwardAPI for Secure Configuration"
date: 2032-02-09T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Projected Volumes", "ConfigMap", "Secrets", "Service Account", "DownwardAPI", "Security", "Storage"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Kubernetes projected volumes: combining ConfigMaps, Secrets, bound service account tokens, and DownwardAPI fields into unified mounts for secure, composable application configuration in production clusters."
more_link: "yes"
url: "/kubernetes-projected-volumes-configmap-secret-serviceaccount-downwardapi-enterprise-guide/"
---

Kubernetes **projected volumes** solve a problem that becomes painfully apparent in security-conscious production environments: applications often need configuration data, credentials, identity tokens, and runtime metadata simultaneously — but legacy volume configurations scatter these across separate mounts, complicate RBAC review, and make auditing injection points difficult. A projected volume collapses multiple volume sources into a single mount point using a unified directory tree, enabling clean separation between what an application reads and the complex machinery that populates it.

Beyond the organizational benefit, projected volumes unlock capabilities unavailable through individual volume types. Only a `projected` volume can combine a bound service account token (audience-restricted, time-limited) with a CA bundle and namespace metadata in one atomic mount — the pattern required for Kubernetes-native OIDC authentication to external services like Vault, AWS IAM, or GCP Workload Identity. Understanding projected volumes thoroughly is prerequisite knowledge for building zero-trust workload authentication in any serious Kubernetes environment.

<!--more-->

## Projected Volume Architecture

### Source Types and Composition Rules

A projected volume accepts four source types, any combination of which can be merged into a single directory:

| Source | Type Key | What It Provides |
|---|---|---|
| ConfigMap | `configMap` | Key-value pairs as files |
| Secret | `secret` | Sensitive key-value pairs as files |
| Service Account Token | `serviceAccountToken` | Bound JWT with audience + expiry |
| DownwardAPI | `downwardAPI` | Pod metadata and resource fields |

All sources are merged into the same target directory. If two sources provide a file at the same path, the pod fails to start with a `FailedMount` error — paths must be unique across all sources. Each source can optionally specify a `path` prefix or per-key `path` mappings to control where its files land.

```yaml
# Conceptual layout of a projected volume with all four sources
# /etc/app-config/
# ├── token           ← serviceAccountToken
# ├── ca.crt          ← configMap (cluster CA bundle)
# ├── database.yaml   ← secret (database credentials)
# ├── feature-flags   ← configMap (application config)
# ├── namespace        ← downwardAPI (pod namespace)
# └── pod-name        ← downwardAPI (pod name)
```

### How Projected Volumes Differ from emptyDir and Individual Mounts

Individual volume mounts work at the directory level — each volume occupies its own mount point. Projected volumes work at the file level within a single mount point. This is not merely cosmetic: it means the application sees a coherent directory where every file arrived from potentially different Kubernetes objects, all managed and rotated independently by the kubelet.

The kubelet handles two distinct update mechanisms for projected volumes:

- **ConfigMap and Secret data**: synced periodically (controlled by `--sync-frequency`, default 1 minute) when not using `subPath` mounts
- **Service account tokens**: rotated proactively by the kubelet when 80% of the token's TTL has elapsed, without any pod restart

This difference matters operationally. Applications that read credentials on startup and cache them in memory will miss ConfigMap/Secret updates unless they re-read periodically. Token rotation, however, is transparent because the kubelet atomically replaces the file — the application's next read gets the fresh token.

## Basic Projected Volume Configuration

### Minimal Example: Token + CA Bundle

The most common projected volume pattern is the OIDC-ready mount: a bound service account token paired with the cluster's CA certificate for validating the OIDC issuer's TLS, plus the namespace for constructing audience strings.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: oidc-consumer
  namespace: payments
spec:
  serviceAccountName: payments-worker
  volumes:
    - name: workload-identity
      projected:
        sources:
          # Bound service account token: 1-hour TTL, audience = vault
          - serviceAccountToken:
              path: token
              expirationSeconds: 3600
              audience: vault
          # ConfigMap containing the cluster's OIDC CA bundle
          - configMap:
              name: kube-root-ca.crt   # auto-created in every namespace
              items:
                - key: ca.crt
                  path: ca.crt
          # Pod namespace from DownwardAPI
          - downwardAPI:
              items:
                - path: namespace
                  fieldRef:
                    fieldPath: metadata.namespace
  containers:
    - name: worker
      image: payments-worker:v2.1.0
      volumeMounts:
        - name: workload-identity
          mountPath: /var/run/secrets/workload-identity
          readOnly: true
```

The application now reads `/var/run/secrets/workload-identity/token` to obtain a JWT it can present to Vault's Kubernetes auth method. The token is guaranteed fresh because the kubelet rotates it automatically.

### Default Permissions and Security

Projected volumes default to `defaultMode: 0644` for all files. For security-sensitive environments where credentials should not be world-readable:

```yaml
volumes:
  - name: workload-identity
    projected:
      defaultMode: 0400    # owner read-only
      sources:
        - serviceAccountToken:
            path: token
            expirationSeconds: 3600
            audience: vault
        - secret:
            name: db-credentials
            defaultMode: 0400   # per-source override
            items:
              - key: password
                path: db-password
                mode: 0400       # per-key override (highest precedence)
```

The precedence hierarchy for file permissions is: per-key `mode` > per-source `defaultMode` > volume-level `defaultMode`.

## Service Account Token Projection

### Audience-Restricted Tokens for External Services

**Audience restriction** is the most important security property of projected tokens. A token minted with `audience: vault` contains `"aud": ["vault"]` in its JWT claims. Any service that validates the audience (including Vault, AWS IAM roles, and GCP workload identity) will reject the token if its own audience string does not match — preventing token reuse across services.

```yaml
# Multiple tokens for multiple services, each with its own audience
volumes:
  - name: service-tokens
    projected:
      sources:
        # Token for Vault authentication
        - serviceAccountToken:
            path: vault-token
            expirationSeconds: 3600
            audience: vault
        # Token for internal metrics service (short-lived)
        - serviceAccountToken:
            path: metrics-token
            expirationSeconds: 600
            audience: https://metrics.internal.example.com
```

Multiple `serviceAccountToken` sources in one projected volume are allowed as long as their `path` values differ. The kubelet independently tracks and rotates each token.

### Token Expiry and Rotation Behavior

The minimum `expirationSeconds` is 600 (10 minutes). The kubelet requests a new token when the current token is 80% through its TTL. For a 1-hour token, rotation triggers at 48 minutes, providing a 12-minute window during which both the old and new token are valid — important for in-flight requests during rotation.

```bash
# Inspect a projected token's claims (on the node or in a debug container)
TOKEN=$(cat /var/run/secrets/workload-identity/token)
PAYLOAD=$(echo "$TOKEN" | cut -d. -f2 | awk '{ n=length($0)%4; if(n==2) print $0"=="; else if(n==3) print $0"="; else print $0 }' | base64 -d 2>/dev/null)
echo "$PAYLOAD" | python3 -m json.tool

# Expected output structure:
# {
#   "aud": ["vault"],
#   "exp": 1740000000,
#   "iat": 1739996400,
#   "iss": "https://kubernetes.default.svc",
#   "kubernetes.io": {
#     "namespace": "payments",
#     "pod": { "name": "oidc-consumer", "uid": "..." },
#     "serviceaccount": { "name": "payments-worker", "uid": "..." }
#   },
#   "sub": "system:serviceaccount:payments:payments-worker"
# }
```

### Configuring the OIDC Issuer URL

For external services to validate projected tokens, the Kubernetes API server must be configured as an OIDC issuer. The issuer URL must be publicly reachable by the external service.

```yaml
# kube-apiserver flags (kubeadm ClusterConfiguration)
apiServer:
  extraArgs:
    service-account-issuer: "https://oidc.k8s.example.com"
    service-account-jwks-uri: "https://oidc.k8s.example.com/openid/v1/jwks"
    api-audiences: "kubernetes.default.svc,vault,https://metrics.internal.example.com"
```

```bash
# Verify the OIDC discovery endpoint is reachable
curl -s https://oidc.k8s.example.com/.well-known/openid-configuration | python3 -m json.tool

# Fetch the JWKS (public keys used to validate token signatures)
curl -s https://oidc.k8s.example.com/openid/v1/jwks | python3 -m json.tool
```

The `api-audiences` flag controls which audience strings the API server will accept when authenticating requests using service account tokens. Add any custom audience strings your services use.

## ConfigMap and Secret Projections

### Selective Key Projection

Both ConfigMaps and Secrets support selective key mounting via the `items` field. Without `items`, all keys are projected as files. With `items`, only the listed keys are projected, and you control the filename independently of the key name.

```yaml
# Secret with multiple keys — only project database credentials
apiVersion: v1
kind: Pod
metadata:
  name: db-consumer
spec:
  volumes:
    - name: app-config
      projected:
        sources:
          # ConfigMap: project only the prod config key, rename it
          - configMap:
              name: app-config-v3
              items:
                - key: production.yaml
                  path: config.yaml      # file appears as config.yaml
          # Secret: project only db credentials
          - secret:
              name: postgres-credentials
              items:
                - key: username
                  path: db/username
                - key: password
                  path: db/password
                  mode: 0400
  containers:
    - name: app
      image: myapp:latest
      volumeMounts:
        - name: app-config
          mountPath: /etc/app
          readOnly: true
      # Result:
      # /etc/app/config.yaml      ← from ConfigMap
      # /etc/app/db/username      ← from Secret
      # /etc/app/db/password      ← from Secret (mode 0400)
```

### Optional Sources

Mark a source as `optional: true` to allow the pod to start even if the referenced ConfigMap or Secret does not exist. This is useful for environment-specific secrets that only exist in certain clusters.

```yaml
volumes:
  - name: app-config
    projected:
      sources:
        - configMap:
            name: app-config           # required — pod fails if missing
        - secret:
            name: datadog-api-key
            optional: true             # pod starts even if secret absent
            items:
              - key: api-key
                path: datadog/api-key
```

When an optional source is absent, its projected files simply do not appear in the directory. Applications must handle the case where these files do not exist.

## DownwardAPI Projection

### Pod Metadata as Files

The DownwardAPI source exposes pod metadata and resource allocations as files in the projected volume. This lets applications discover their own identity, namespace, and resource limits without making Kubernetes API calls — which avoids service account permission requirements and API server load.

```yaml
volumes:
  - name: pod-info
    projected:
      sources:
        - downwardAPI:
            items:
              # Pod identity
              - path: pod-name
                fieldRef:
                  fieldPath: metadata.name
              - path: pod-uid
                fieldRef:
                  fieldPath: metadata.uid
              - path: namespace
                fieldRef:
                  fieldPath: metadata.namespace
              - path: node-name
                fieldRef:
                  fieldPath: spec.nodeName
              # Resource limits (useful for JVM heap sizing)
              - path: cpu-limit
                resourceFieldRef:
                  containerName: app
                  resource: limits.cpu
              - path: memory-limit
                resourceFieldRef:
                  containerName: app
                  resource: limits.memory
              # Labels and annotations (updated live when labels change)
              - path: labels
                fieldRef:
                  fieldPath: metadata.labels
              - path: annotations
                fieldRef:
                  fieldPath: metadata.annotations
```

```bash
# Application reads its own identity at startup
POD_NAME=$(cat /etc/pod-info/pod-name)
NAMESPACE=$(cat /etc/pod-info/namespace)
MEM_LIMIT=$(cat /etc/pod-info/memory-limit)  # in bytes

# Compute JVM heap as 75% of memory limit
HEAP_MB=$((MEM_LIMIT / 1024 / 1024 * 75 / 100))
exec java -Xmx${HEAP_MB}m -jar app.jar
```

### Labels and Annotations: Live Update Behavior

Pod labels and annotations exposed via DownwardAPI are **updated live** when the pod's metadata changes — unlike `fieldRef` values for `metadata.name` or `spec.nodeName`, which are static. This means a pod can observe its own label changes, which is useful for rollout coordination:

```bash
# Operator sets a drain label before evicting the pod
kubectl label pod my-pod drain=true

# Application detects the label change and begins graceful shutdown
while true; do
  DRAIN=$(cat /etc/pod-info/labels | grep 'drain="true"' | wc -l)
  if [ "$DRAIN" -gt 0 ]; then
    echo "Drain label detected, initiating shutdown"
    kill -SIGTERM 1
    break
  fi
  sleep 5
done
```

## Enterprise Patterns

### Pattern 1: Vault Agent Injection Replacement

Vault Agent Injector is the standard approach for injecting Vault secrets into pods, but it adds a sidecar container per pod and requires Vault Agent configuration. Projected volumes with OIDC can replace the sidecar pattern with direct JWT authentication from the application:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: vault-native-consumer
spec:
  serviceAccountName: app-service-account
  volumes:
    - name: vault-auth
      projected:
        sources:
          - serviceAccountToken:
              path: jwt
              expirationSeconds: 3600
              audience: vault
          - configMap:
              name: vault-config
              items:
                - key: addr
                  path: addr
                - key: role
                  path: role
  containers:
    - name: app
      image: myapp:latest
      env:
        - name: VAULT_ADDR
          value: "https://vault.internal.example.com"
      volumeMounts:
        - name: vault-auth
          mountPath: /var/run/secrets/vault
          readOnly: true
```

```go
// Application authenticates to Vault using the projected JWT
package main

import (
    "os"
    "time"

    vault "github.com/hashicorp/vault/api"
    auth "github.com/hashicorp/vault/api/auth/kubernetes"
)

func newVaultClient() (*vault.Client, error) {
    config := vault.DefaultConfig()
    config.Address = os.Getenv("VAULT_ADDR")

    client, err := vault.NewClient(config)
    if err != nil {
        return nil, err
    }

    // Read the projected JWT (automatically refreshed by kubelet)
    jwtBytes, err := os.ReadFile("/var/run/secrets/vault/jwt")
    if err != nil {
        return nil, err
    }

    roleName, _ := os.ReadFile("/var/run/secrets/vault/role")

    k8sAuth, err := auth.NewKubernetesAuth(
        string(roleName),
        auth.WithServiceAccountToken(string(jwtBytes)),
    )
    if err != nil {
        return nil, err
    }

    authInfo, err := client.Auth().Login(context.Background(), k8sAuth)
    if err != nil {
        return nil, err
    }
    _ = authInfo // contains the Vault token lease

    return client, nil
}
```

### Pattern 2: AWS IRSA-Compatible Projected Volumes (EKS Alternative)

AWS IRSA (IAM Roles for Service Accounts) uses projected volumes under the hood on EKS. For self-managed clusters, you can replicate IRSA behavior with a custom OIDC provider:

```yaml
# Annotate the service account with the IAM role ARN
apiVersion: v1
kind: ServiceAccount
metadata:
  name: s3-reader
  namespace: data-pipeline
  annotations:
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/k8s-s3-reader"

---
apiVersion: v1
kind: Pod
metadata:
  name: s3-consumer
spec:
  serviceAccountName: s3-reader
  volumes:
    - name: aws-iam-token
      projected:
        sources:
          - serviceAccountToken:
              audience: sts.amazonaws.com    # AWS STS expects this audience
              expirationSeconds: 86400        # 24 hours (AWS STS minimum)
              path: token
  containers:
    - name: app
      image: myapp:latest
      env:
        # AWS SDK picks these up automatically
        - name: AWS_WEB_IDENTITY_TOKEN_FILE
          value: /var/run/secrets/eks.amazonaws.com/serviceaccount/token
        - name: AWS_ROLE_ARN
          value: "arn:aws:iam::123456789012:role/k8s-s3-reader"
        - name: AWS_REGION
          value: us-east-1
      volumeMounts:
        - name: aws-iam-token
          mountPath: /var/run/secrets/eks.amazonaws.com/serviceaccount
          readOnly: true
```

When the AWS SDK initializes, it reads `AWS_WEB_IDENTITY_TOKEN_FILE`, calls `sts:AssumeRoleWithWebIdentity`, and obtains temporary credentials. No static AWS credentials are needed anywhere in the cluster.

### Pattern 3: Multi-Tenant Configuration Composition

In multi-tenant clusters where a single application binary serves multiple tenants, projected volumes let each tenant pod compose a unique configuration from shared and tenant-specific sources:

```yaml
# Shared base configuration (applies to all tenants)
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-base-config
  namespace: platform
data:
  base.yaml: |
    log_level: info
    metrics_port: 9090
    health_path: /healthz

---
# Tenant-specific configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: tenant-acme-config
  namespace: tenant-acme
data:
  tenant.yaml: |
    tenant_id: acme
    database_host: acme-postgres.tenant-acme.svc.cluster.local
    feature_flags:
      advanced_reporting: true

---
apiVersion: v1
kind: Pod
metadata:
  name: app-acme
  namespace: tenant-acme
spec:
  volumes:
    - name: config
      projected:
        sources:
          # Shared base config from platform namespace (cross-namespace read)
          # Note: ConfigMap must be in same namespace; use ConfigMapGenerator
          # or sync operator for cross-namespace configs
          - configMap:
              name: app-base-config    # synced into tenant namespace
              items:
                - key: base.yaml
                  path: base.yaml
          # Tenant-specific config
          - configMap:
              name: tenant-acme-config
              items:
                - key: tenant.yaml
                  path: tenant.yaml
          # Tenant database credentials
          - secret:
              name: acme-db-credentials
              items:
                - key: password
                  path: db-password
                  mode: 0400
          # Pod identity for structured logging
          - downwardAPI:
              items:
                - path: pod-name
                  fieldRef:
                    fieldPath: metadata.name
                - path: namespace
                  fieldRef:
                    fieldPath: metadata.namespace
  containers:
    - name: app
      image: platform-app:v3.0.0
      volumeMounts:
        - name: config
          mountPath: /etc/app
          readOnly: true
```

### Pattern 4: Certificate and Token Bundle for mTLS + OIDC

Applications that simultaneously need mTLS certificates (for service mesh bypass or direct mTLS) and OIDC tokens (for API gateway authentication) benefit from a unified projected volume:

```yaml
volumes:
  - name: identity-bundle
    projected:
      defaultMode: 0400
      sources:
        # OIDC token for API gateway
        - serviceAccountToken:
            path: oidc-token
            expirationSeconds: 3600
            audience: https://api-gateway.example.com
        # mTLS certificate from cert-manager (via Secret)
        - secret:
            name: mtls-cert     # managed by cert-manager Certificate resource
            items:
              - key: tls.crt
                path: tls.crt
              - key: tls.key
                path: tls.key
                mode: 0400
        # CA bundle for server verification
        - configMap:
            name: internal-ca-bundle
            items:
              - key: ca.crt
                path: ca.crt
        # Runtime identity for logging correlation
        - downwardAPI:
            items:
              - path: pod-uid
                fieldRef:
                  fieldPath: metadata.uid
```

## Troubleshooting Projected Volumes

### Common Failure Modes

**Path collision between sources** causes `FailedMount`:

```bash
# Check events for path collision details
kubectl describe pod <pod-name> | grep -A 10 "Events:"

# Example error:
# Warning  FailedMount  kubelet  MountVolume.SetUp failed:
# projected volume contains duplicate file path "token"
```

**Missing optional=false ConfigMap or Secret**:

```bash
# Pod stuck in ContainerCreating
kubectl get events --field-selector involvedObject.name=<pod-name>

# Error: secrets "missing-secret" not found
# Fix: either create the secret or mark the source optional: true
```

**Token audience mismatch** (token validates but service rejects it):

```bash
# Decode the token and check the aud claim
TOKEN=$(kubectl exec <pod> -- cat /var/run/secrets/workload-identity/token)
echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
print('Audience:', data.get('aud'))
print('Subject:', data.get('sub'))
print('Issuer:', data.get('iss'))
"
```

**Permission denied reading projected files** despite correct pod spec:

```bash
# Verify the file mode in the running container
kubectl exec <pod> -- ls -la /var/run/secrets/workload-identity/

# If using a non-root security context, ensure defaultMode allows reads
# defaultMode: 0444 for world-readable, 0440 for owner+group, 0400 for owner only
```

### Debugging Token Rotation

```bash
# Monitor token file modification time to verify rotation is occurring
kubectl exec -it <pod> -- sh -c '
while true; do
  echo "$(date) - mtime: $(stat -c %y /var/run/secrets/workload-identity/token)"
  sleep 60
done'

# Decode current token expiry
kubectl exec <pod> -- sh -c '
TOKEN=$(cat /var/run/secrets/workload-identity/token)
EXP=$(echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[\"exp\"])")
echo "Token expires: $(date -d @$EXP)"
echo "Current time:  $(date)"
'
```

### Using kubectl debug with Projected Volumes

Ephemeral debug containers can access the same projected volumes as the target container:

```bash
# Attach a debug container that shares the pod's volume namespace
kubectl debug -it <pod-name> \
  --image=alpine:latest \
  --share-processes \
  -- sh

# Inside the debug container, access the projected volume
# (volumes are shared at the pod level, not container level)
ls -la /proc/1/root/var/run/secrets/workload-identity/
```

## Security Hardening for Projected Volumes

### Preventing Token Exfiltration

Projected tokens should be treated as sensitive credentials. Apply the principle of least privilege:

```yaml
apiVersion: v1
kind: Pod
spec:
  serviceAccountName: minimal-permissions-sa
  securityContext:
    runAsNonRoot: true
    runAsUser: 10001
    runAsGroup: 10001
    fsGroup: 10001          # projected volume files owned by this group
    seccompProfile:
      type: RuntimeDefault
  automountServiceAccountToken: false   # disable the legacy token mount
  volumes:
    - name: workload-identity
      projected:
        defaultMode: 0440   # owner + group read only
        sources:
          - serviceAccountToken:
              path: token
              expirationSeconds: 3600
              audience: vault
  containers:
    - name: app
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: ["ALL"]
      volumeMounts:
        - name: workload-identity
          mountPath: /var/run/secrets/workload-identity
          readOnly: true
```

### Admission Policies for Projected Volume Validation

Use ValidatingAdmissionPolicy (CEL-based) to enforce that all projected volumes include a bound service account token with a minimum expiry:

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: require-projected-token-ttl
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        resources: ["pods"]
        operations: ["CREATE"]
  validations:
    - expression: |
        object.spec.volumes.filter(v, has(v.projected)).all(pv,
          pv.projected.sources.filter(s, has(s.serviceAccountToken)).all(sat,
            sat.serviceAccountToken.expirationSeconds <= 86400
          )
        )
      message: "Projected service account tokens must have expirationSeconds <= 86400 (24 hours)"
      reason: Invalid
```

### Audit Logging for Token Usage

Enable audit logging to track projected token usage patterns:

```yaml
# kube-apiserver audit policy
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
  # Log all token requests (projected token minting)
  - level: Metadata
    resources:
      - group: ""
        resources: ["serviceaccounts/token"]
    verbs: ["create"]
  # Log token reviews (token validation by external services)
  - level: RequestResponse
    resources:
      - group: "authentication.k8s.io"
        resources: ["tokenreviews"]
    verbs: ["create"]
```

## Conclusion

Kubernetes projected volumes provide the foundation for secure, composable workload identity and configuration in production clusters. By merging ConfigMaps, Secrets, bound service account tokens, and DownwardAPI fields into a single mount, they enable application configurations that are both auditable and minimal in attack surface.

Key takeaways:

- Projected volumes merge multiple Kubernetes sources into a single directory, removing the need for scattered mount points and simplifying audit trails
- Bound service account tokens (with audience restriction and automatic rotation) are only accessible through projected volumes — they are the required mechanism for Kubernetes-native OIDC authentication to Vault, AWS IAM, and GCP Workload Identity
- DownwardAPI sources allow applications to discover their own identity and resource limits without Kubernetes API calls, reducing service account permission requirements
- Token rotation at 80% of TTL is transparent to the application — the kubelet atomically replaces the file, and the next read returns the fresh token
- Disable `automountServiceAccountToken: true` (the default) and use explicit projected volumes so each pod mounts only the audience-scoped token it actually needs
