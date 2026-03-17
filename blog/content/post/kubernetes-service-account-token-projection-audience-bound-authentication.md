---
title: "Kubernetes Service Account Token Projection and Audience-Bound Tokens for Secure Pod Authentication"
date: 2031-09-16T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Security", "Service Accounts", "OIDC", "Authentication", "RBAC"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes projected service account tokens, audience-bound token scoping, OIDC federation, and production patterns for secure workload identity."
more_link: "yes"
url: "/kubernetes-service-account-token-projection-audience-bound-authentication/"
---

Every pod that runs in a Kubernetes cluster carries an identity. For most of Kubernetes history that identity was a long-lived, auto-mounted service account token stored in a secret — a token that never expired, had no audience restriction, and persisted in etcd until the secret was manually deleted. The security posture of that model is poor by modern standards, and the community has steadily moved toward projected service account tokens (PSATs) as the replacement.

This post walks through how projected tokens work, how audience binding prevents token reuse across services, how to federate that identity with cloud IAM systems (AWS IRSA, GCP Workload Identity, Azure Workload Identity), and the operational patterns required to make the whole system reliable in a large production cluster.

<!--more-->

# Kubernetes Service Account Token Projection and Audience-Bound Tokens

## Background: Why Legacy Tokens Are a Problem

The original service account token mechanism mounted a `kubernetes.io/service-account-token` secret into every pod at `/var/run/secrets/kubernetes.io/serviceaccount/token`. That JWT had several properties that made it dangerous:

- **No expiry** — the token was valid indefinitely unless the secret was deleted.
- **No audience** — any service that could validate Kubernetes tokens could accept it.
- **Secret-backed** — it lived in etcd as a Secret object, broadening the blast radius of an etcd compromise.
- **Auto-mounted** — even pods that needed no API access received a token.

The `BoundServiceAccountTokenVolume` feature gate (beta in 1.21, stable in 1.22, enabled by default since 1.24) changes this default. New pods now receive time-limited, audience-bound tokens via the `projected` volume type rather than from a Secret.

## How Projected Service Account Tokens Work

A projected volume allows several independent volume sources to be combined into a single directory. The `serviceAccountToken` source within a projected volume is special: it asks the kubelet to request a token from the API server's `TokenRequest` API, cache it locally, and rotate it before expiration.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: example-app
  namespace: production
spec:
  serviceAccountName: example-sa
  automountServiceAccountToken: false   # disable the legacy auto-mount
  volumes:
    - name: workload-identity
      projected:
        sources:
          - serviceAccountToken:
              path: token
              expirationSeconds: 3600   # rotate every hour
              audience: "https://kubernetes.default.svc"
          - configMap:
              name: kube-root-ca.crt
              items:
                - key: ca.crt
                  path: ca.crt
          - downwardAPI:
              items:
                - path: namespace
                  fieldRef:
                    fieldPath: metadata.namespace
  containers:
    - name: app
      image: example-app:latest
      volumeMounts:
        - name: workload-identity
          mountPath: /var/run/secrets/kubernetes.io/serviceaccount
          readOnly: true
```

The key fields on the `serviceAccountToken` source:

| Field | Purpose | Default |
|-------|---------|---------|
| `audience` | Intended recipient of the token (JWT `aud` claim) | kube-apiserver audiences |
| `expirationSeconds` | Requested token lifetime in seconds (kubelet rotates before expiry) | 3600 |
| `path` | File name inside the projected volume directory | required |

The kubelet will refresh the token when 80% of its lifetime has elapsed, so a 3600-second token is refreshed approximately every 48 minutes.

## The TokenRequest API

Understanding the kubelet's behavior requires understanding the underlying API. The kubelet calls `POST /api/v1/namespaces/{namespace}/serviceaccounts/{name}/token` with a `TokenRequest` object:

```json
{
  "apiVersion": "authentication.k8s.io/v1",
  "kind": "TokenRequest",
  "spec": {
    "audiences": ["https://kubernetes.default.svc"],
    "expirationSeconds": 3600,
    "boundObjectRef": {
      "apiVersion": "v1",
      "kind": "Pod",
      "name": "example-app",
      "uid": "a1b2c3d4-..."
    }
  }
}
```

The `boundObjectRef` is critical. It cryptographically binds the token to the pod's UID. When the pod is deleted, the token becomes invalid even before its expiration because the binding object no longer exists. This closes the window where a leaked token remains valid after the workload is gone.

You can request tokens manually using kubectl for testing:

```bash
kubectl create token example-sa \
  --namespace production \
  --audience https://kubernetes.default.svc \
  --duration 1h
```

Inspect the resulting JWT:

```bash
TOKEN=$(kubectl create token example-sa \
  --namespace production \
  --audience https://kubernetes.default.svc \
  --duration 1h)

echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | python3 -m json.tool
```

Example decoded payload:

```json
{
  "aud": ["https://kubernetes.default.svc"],
  "exp": 1726500000,
  "iat": 1726496400,
  "iss": "https://kubernetes.default.svc",
  "kubernetes.io": {
    "namespace": "production",
    "pod": {
      "name": "example-app",
      "uid": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
    },
    "serviceaccount": {
      "name": "example-sa",
      "uid": "b2c3d4e5-f6a7-8901-bcde-f12345678901"
    },
    "warnafter": 1726499700
  },
  "nbf": 1726496400,
  "sub": "system:serviceaccount:production:example-sa"
}
```

## Audience Binding: Preventing Cross-Service Token Reuse

The `aud` claim is enforced by each relying party independently. The Kubernetes API server rejects tokens whose audience does not match its configured service account issuer audiences. External services that validate Kubernetes tokens must similarly verify `aud`.

A concrete example: you have a sidecar that calls an internal metadata service and also calls the Kubernetes API. Use two separate token sources with different audiences:

```yaml
volumes:
  - name: multi-audience-tokens
    projected:
      sources:
        - serviceAccountToken:
            path: kube-api-token
            audience: "https://kubernetes.default.svc"
            expirationSeconds: 3600
        - serviceAccountToken:
            path: metadata-service-token
            audience: "https://metadata.internal.example.com"
            expirationSeconds: 1800
```

The metadata service validates that `aud` equals `https://metadata.internal.example.com`. Even if an attacker intercepts the metadata service token, they cannot use it against the Kubernetes API because the audience does not match.

## OIDC Discovery and Token Verification

The API server publishes OIDC discovery documents that allow external systems to validate tokens without calling the Kubernetes API:

```
GET /.well-known/openid-configuration
GET /openid/v1/jwks
```

For clusters where the API server is not publicly reachable, you need to host these documents externally. Both AWS EKS and GKE do this automatically. For self-managed clusters, configure the API server with a public OIDC issuer URL:

```bash
kube-apiserver \
  --service-account-issuer=https://oidc.example.com \
  --service-account-jwks-uri=https://oidc.example.com/openid/v1/jwks \
  --service-account-key-file=/etc/kubernetes/pki/sa.pub \
  --service-account-signing-key-file=/etc/kubernetes/pki/sa.key
```

Then publish the JWKS to the public URL. A simple approach uses a ConfigMap synced to an S3 bucket or GCS bucket:

```bash
# Extract JWKS from the cluster
kubectl get --raw /openid/v1/jwks | jq . > jwks.json

# Upload to S3 with proper content type
aws s3 cp jwks.json s3://my-oidc-bucket/openid/v1/jwks \
  --content-type application/json \
  --acl public-read

# Create discovery document
cat > discovery.json <<EOF
{
  "issuer": "https://oidc.example.com",
  "jwks_uri": "https://oidc.example.com/openid/v1/jwks",
  "response_types_supported": ["id_token"],
  "subject_types_supported": ["public"],
  "id_token_signing_alg_values_supported": ["RS256"]
}
EOF

aws s3 cp discovery.json \
  s3://my-oidc-bucket/.well-known/openid-configuration \
  --content-type application/json \
  --acl public-read
```

## AWS IRSA (IAM Roles for Service Accounts)

IRSA is the canonical example of federating Kubernetes service account identity with a cloud IAM system. When a pod assumes an IAM role via IRSA, the flow is:

1. Pod reads projected token from `/var/run/secrets/eks.amazonaws.com/serviceaccount/token` (audience: `sts.amazonaws.com`).
2. AWS SDK calls `sts:AssumeRoleWithWebIdentity` with the token and role ARN.
3. STS validates the token against the cluster OIDC provider.
4. STS returns temporary credentials scoped to the IAM role.

Setting up IRSA on a self-managed cluster:

```bash
# 1. Register the OIDC provider with AWS
OIDC_ISSUER="https://oidc.example.com"
THUMBPRINT=$(openssl s_client -connect oidc.example.com:443 \
  -showcerts </dev/null 2>/dev/null | \
  openssl x509 -fingerprint -noout | \
  sed 's/://g' | awk -F= '{print tolower($2)}')

aws iam create-open-id-connect-provider \
  --url "${OIDC_ISSUER}" \
  --client-id-list "sts.amazonaws.com" \
  --thumbprint-list "${THUMBPRINT}"
```

IAM trust policy for the role:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<account-id>:oidc-provider/oidc.example.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "oidc.example.com:sub": "system:serviceaccount:production:s3-reader",
          "oidc.example.com:aud": "sts.amazonaws.com"
        }
      }
    }
  ]
}
```

Service account annotation:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: s3-reader
  namespace: production
  annotations:
    eks.amazonaws.com/role-arn: "arn:aws:iam::<account-id>:role/s3-reader-role"
```

Pod using IRSA:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: s3-reader
  namespace: production
spec:
  serviceAccountName: s3-reader
  automountServiceAccountToken: false
  volumes:
    - name: aws-iam-token
      projected:
        sources:
          - serviceAccountToken:
              path: token
              audience: "sts.amazonaws.com"
              expirationSeconds: 86400
  containers:
    - name: app
      image: amazon/aws-cli:latest
      env:
        - name: AWS_ROLE_ARN
          value: "arn:aws:iam::<account-id>:role/s3-reader-role"
        - name: AWS_WEB_IDENTITY_TOKEN_FILE
          value: /var/run/secrets/eks.amazonaws.com/serviceaccount/token
        - name: AWS_DEFAULT_REGION
          value: us-east-1
      volumeMounts:
        - name: aws-iam-token
          mountPath: /var/run/secrets/eks.amazonaws.com/serviceaccount
          readOnly: true
```

## GCP Workload Identity

GCP Workload Identity follows a similar pattern. A Kubernetes service account is bound to a GCP service account:

```bash
# Allow the Kubernetes SA to impersonate the GCP SA
gcloud iam service-accounts add-iam-policy-binding \
  gcp-sa@my-project.iam.gserviceaccount.com \
  --role roles/iam.workloadIdentityUser \
  --member "serviceAccount:my-project.svc.id.goog[production/gcp-reader]"
```

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: gcp-reader
  namespace: production
  annotations:
    iam.gke.io/gcp-service-account: gcp-sa@my-project.iam.gserviceaccount.com
```

## Azure Workload Identity

Azure Workload Identity uses the same OIDC federation model:

```bash
# Create federated identity credential
az identity federated-credential create \
  --name k8s-federation \
  --identity-name my-identity \
  --resource-group my-rg \
  --issuer "https://oidc.example.com" \
  --subject "system:serviceaccount:production:azure-reader" \
  --audience "api://AzureADTokenExchange"
```

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: azure-reader
  namespace: production
  annotations:
    azure.workload.identity/client-id: "<client-id>"
    azure.workload.identity/tenant-id: "<tenant-id>"
```

## Enforcing Projected Tokens Cluster-Wide

Use OPA Gatekeeper or Kyverno to prevent pods from using legacy auto-mounted tokens.

Kyverno policy:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-projected-service-account-token
spec:
  validationFailureAction: Enforce
  background: true
  rules:
    - name: check-automount-disabled
      match:
        any:
          - resources:
              kinds:
                - Pod
      validate:
        message: "Pods must set automountServiceAccountToken: false and use projected volumes"
        pattern:
          spec:
            automountServiceAccountToken: false
    - name: check-no-legacy-sa-secret-mount
      match:
        any:
          - resources:
              kinds:
                - Pod
      validate:
        message: "Pods must not mount service account token secrets directly"
        deny:
          conditions:
            any:
              - key: "{{ request.object.spec.volumes[].secret.secretName | to_string(@) }}"
                operator: Contains
                value: "token"
```

## Token Rotation and Application Readiness

Applications must re-read the token file periodically. The kubelet updates the file in place before expiry. Most cloud SDKs handle this automatically when `AWS_WEB_IDENTITY_TOKEN_FILE` is set, but custom token consumers need explicit rotation logic.

Go example for reading a rotated token:

```go
package auth

import (
    "os"
    "sync"
    "time"
)

type TokenFile struct {
    path        string
    mu          sync.RWMutex
    cachedToken string
    cachedAt    time.Time
    ttl         time.Duration
}

func NewTokenFile(path string, ttl time.Duration) *TokenFile {
    return &TokenFile{
        path: path,
        ttl:  ttl,
    }
}

func (t *TokenFile) Token() (string, error) {
    t.mu.RLock()
    if time.Since(t.cachedAt) < t.ttl {
        tok := t.cachedToken
        t.mu.RUnlock()
        return tok, nil
    }
    t.mu.RUnlock()

    t.mu.Lock()
    defer t.mu.Unlock()

    // Double-check after acquiring write lock
    if time.Since(t.cachedAt) < t.ttl {
        return t.cachedToken, nil
    }

    data, err := os.ReadFile(t.path)
    if err != nil {
        return "", fmt.Errorf("reading token file %s: %w", t.path, err)
    }

    t.cachedToken = strings.TrimSpace(string(data))
    t.cachedAt = time.Now()
    return t.cachedToken, nil
}
```

## Auditing Token Usage

Enable audit logging to track token issuance and usage:

```yaml
# audit-policy.yaml
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
  # Log all TokenRequest calls
  - level: RequestResponse
    resources:
      - group: ""
        resources: ["serviceaccounts/token"]
    verbs: ["create"]
  # Log authentication failures
  - level: Request
    resources:
      - group: "authentication.k8s.io"
        resources: ["tokenreviews"]
    verbs: ["create"]
```

Query audit logs for token requests from a specific service account:

```bash
kubectl logs -n kube-system -l component=kube-apiserver | \
  jq 'select(.objectRef.resource == "serviceaccounts" and
             .objectRef.subresource == "token" and
             .objectRef.name == "example-sa")'
```

## Service Account Security Hardening Checklist

A production-grade deployment should verify:

```bash
#!/bin/bash
# sa-audit.sh - Audit service account security posture

echo "=== Pods with automountServiceAccountToken not explicitly disabled ==="
kubectl get pods --all-namespaces -o json | \
  jq -r '.items[] | select(.spec.automountServiceAccountToken != false) |
    [.metadata.namespace, .metadata.name] | @tsv'

echo ""
echo "=== Service accounts with cluster-admin binding ==="
kubectl get clusterrolebindings -o json | \
  jq -r '.items[] |
    select(.roleRef.name == "cluster-admin") |
    .subjects[]? |
    select(.kind == "ServiceAccount") |
    [.namespace, .name] | @tsv'

echo ""
echo "=== Pods mounting service account token secrets ==="
kubectl get pods --all-namespaces -o json | \
  jq -r '.items[] |
    .metadata as $meta |
    .spec.volumes[]? |
    select(.secret.secretName | strings | test("token")) |
    [$meta.namespace, $meta.name, .secret.secretName] | @tsv'

echo ""
echo "=== Service accounts with no RBAC bindings (overly permissive defaults) ==="
for ns in $(kubectl get namespaces -o jsonpath='{.items[*].metadata.name}'); do
  for sa in $(kubectl get serviceaccounts -n "$ns" \
    -o jsonpath='{.items[*].metadata.name}'); do
    bindings=$(kubectl get rolebindings,clusterrolebindings \
      --all-namespaces -o json 2>/dev/null | \
      jq --arg ns "$ns" --arg sa "$sa" \
        '[.items[].subjects[]? |
          select(.kind == "ServiceAccount" and
                 .namespace == $ns and
                 .name == $sa)] | length')
    if [ "$bindings" -eq 0 ] && [ "$sa" != "default" ]; then
      echo "  $ns/$sa has no RBAC bindings"
    fi
  done
done
```

## Monitoring Token Health

Prometheus metrics to track in production:

```yaml
# ServiceMonitor for token expiry tracking
# Use kube-state-metrics and a custom exporter to surface:
# - kubernetes_service_account_token_expiry_seconds
# - kubernetes_projected_volume_token_rotation_total

# Alert on impending token expiry
groups:
  - name: service-account-tokens
    rules:
      - alert: ProjectedTokenRotationFailure
        expr: |
          increase(kubelet_volume_stats_inodes_free{
            volume_plugin="kubernetes.io/projected"
          }[5m]) == 0
          and
          time() - kube_pod_start_time > 3600
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Projected token may not be rotating"
          description: "Pod {{ $labels.pod }} in {{ $labels.namespace }} may have stale projected token"
```

## Practical Considerations for Migration

When migrating a cluster from legacy tokens to projected tokens:

1. **Audit first** — run the audit script above to identify all pods using legacy tokens.
2. **Set `automountServiceAccountToken: false`** on the default service accounts in each namespace.
3. **Add explicit projected volumes** to pods that need API access.
4. **Update applications** to read from the new token path.
5. **Enable the `BoundServiceAccountTokenVolume` feature gate** if not already active (default since 1.24).
6. **Rotate signing keys** — after migration, rotate the service account signing key and wait for all legacy tokens to expire.
7. **Set `--service-account-max-token-expiration`** on the API server to enforce a maximum lifetime.

```bash
# API server flag to cap token lifetime at 24 hours
kube-apiserver \
  --service-account-max-token-expiration=86400s
```

## Summary

Projected service account tokens with audience binding represent a significant improvement in Kubernetes workload identity security. The combination of short-lived tokens, audience scoping, pod binding, and OIDC federation enables zero-trust authentication patterns where each workload has a tightly scoped, verifiable identity. The migration from legacy tokens requires coordination across application teams, but the security posture improvement justifies the investment for any production cluster handling sensitive workloads.
