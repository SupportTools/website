---
title: "Kubernetes Keycloak Integration: OIDC Authentication for API Server and Applications"
date: 2031-03-31T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Keycloak", "OIDC", "Authentication", "RBAC", "Security"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to deploying Keycloak on Kubernetes, configuring kube-apiserver OIDC flags, kubelogin for kubectl authentication, group-based RBAC, token refresh, and multi-realm multi-cluster setups."
more_link: "yes"
url: "/kubernetes-keycloak-oidc-authentication-api-server-applications/"
---

Integrating Keycloak as an OIDC provider for Kubernetes delivers centralized identity management, group-based access control, and audit-ready authentication across clusters. This guide walks through a production-grade deployment covering Keycloak on Kubernetes, kube-apiserver OIDC configuration, kubelogin for seamless kubectl authentication, RBAC binding to OIDC groups, token refresh handling, and multi-realm multi-cluster patterns.

<!--more-->

# Kubernetes Keycloak Integration: OIDC Authentication for API Server and Applications

## Why Keycloak for Kubernetes Authentication

Kubernetes natively supports OIDC as an authentication strategy through the kube-apiserver. Rather than managing individual kubeconfig credentials or static ServiceAccount tokens for human users, an OIDC provider allows you to:

- Authenticate users through your existing identity store (LDAP, Active Directory, Google Workspace)
- Enforce MFA at the identity provider layer
- Issue short-lived tokens with automatic expiry
- Map directory groups to Kubernetes RBAC roles without per-user configuration
- Centralize audit logs at the identity provider

Keycloak is a mature open-source OIDC and SAML provider with Kubernetes-native deployment options, extensive federation capabilities, and a rich administrative API.

## Section 1: Deploying Keycloak on Kubernetes

### Namespace and Storage Preparation

```bash
kubectl create namespace keycloak

kubectl apply -f - <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: keycloak-postgres-pvc
  namespace: keycloak
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 20Gi
  storageClassName: fast-ssd
EOF
```

### PostgreSQL Backend Deployment

Keycloak requires a relational database for production. SQLite and H2 are unsuitable for clustered deployments.

```yaml
# postgres-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: keycloak-postgres
  namespace: keycloak
spec:
  replicas: 1
  selector:
    matchLabels:
      app: keycloak-postgres
  template:
    metadata:
      labels:
        app: keycloak-postgres
    spec:
      containers:
        - name: postgres
          image: postgres:15-alpine
          env:
            - name: POSTGRES_DB
              value: keycloak
            - name: POSTGRES_USER
              valueFrom:
                secretKeyRef:
                  name: keycloak-postgres-secret
                  key: username
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: keycloak-postgres-secret
                  key: password
          ports:
            - containerPort: 5432
          volumeMounts:
            - name: postgres-data
              mountPath: /var/lib/postgresql/data
          resources:
            requests:
              cpu: 250m
              memory: 512Mi
            limits:
              cpu: 1000m
              memory: 1Gi
          livenessProbe:
            exec:
              command: ["pg_isready", "-U", "keycloak"]
            initialDelaySeconds: 30
            periodSeconds: 10
      volumes:
        - name: postgres-data
          persistentVolumeClaim:
            claimName: keycloak-postgres-pvc
---
apiVersion: v1
kind: Service
metadata:
  name: keycloak-postgres
  namespace: keycloak
spec:
  selector:
    app: keycloak-postgres
  ports:
    - port: 5432
      targetPort: 5432
```

```bash
# Create the database secret
kubectl create secret generic keycloak-postgres-secret \
  --namespace keycloak \
  --from-literal=username=keycloak \
  --from-literal=password='<db-password-here>'
```

### Keycloak Deployment with Production Configuration

```yaml
# keycloak-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: keycloak
  namespace: keycloak
  labels:
    app: keycloak
spec:
  replicas: 2
  selector:
    matchLabels:
      app: keycloak
  template:
    metadata:
      labels:
        app: keycloak
    spec:
      initContainers:
        - name: wait-for-postgres
          image: busybox:1.36
          command:
            - sh
            - -c
            - |
              until nc -z keycloak-postgres 5432; do
                echo "Waiting for PostgreSQL..."
                sleep 2
              done
      containers:
        - name: keycloak
          image: quay.io/keycloak/keycloak:23.0.4
          args:
            - start
            - --optimized
          env:
            - name: KC_DB
              value: postgres
            - name: KC_DB_URL
              value: jdbc:postgresql://keycloak-postgres:5432/keycloak
            - name: KC_DB_USERNAME
              valueFrom:
                secretKeyRef:
                  name: keycloak-postgres-secret
                  key: username
            - name: KC_DB_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: keycloak-postgres-secret
                  key: password
            - name: KC_HOSTNAME
              value: keycloak.example.com
            - name: KC_HOSTNAME_STRICT
              value: "false"
            - name: KC_HTTP_ENABLED
              value: "true"
            - name: KC_PROXY
              value: edge
            - name: KC_CACHE
              value: ispn
            - name: KC_CACHE_STACK
              value: kubernetes
            - name: KEYCLOAK_ADMIN
              valueFrom:
                secretKeyRef:
                  name: keycloak-admin-secret
                  key: username
            - name: KEYCLOAK_ADMIN_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: keycloak-admin-secret
                  key: password
            - name: jgroups.dns.query
              value: keycloak-headless.keycloak.svc.cluster.local
          ports:
            - name: http
              containerPort: 8080
            - name: jgroups
              containerPort: 7800
          resources:
            requests:
              cpu: 500m
              memory: 1Gi
            limits:
              cpu: 2000m
              memory: 2Gi
          readinessProbe:
            httpGet:
              path: /realms/master
              port: 8080
            initialDelaySeconds: 60
            periodSeconds: 10
            failureThreshold: 6
          livenessProbe:
            httpGet:
              path: /realms/master
              port: 8080
            initialDelaySeconds: 90
            periodSeconds: 30
            failureThreshold: 3
---
apiVersion: v1
kind: Service
metadata:
  name: keycloak
  namespace: keycloak
spec:
  selector:
    app: keycloak
  ports:
    - name: http
      port: 80
      targetPort: 8080
---
# Headless service for cluster discovery
apiVersion: v1
kind: Service
metadata:
  name: keycloak-headless
  namespace: keycloak
spec:
  clusterIP: None
  selector:
    app: keycloak
  ports:
    - name: jgroups
      port: 7800
      targetPort: 7800
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: keycloak
  namespace: keycloak
  annotations:
    nginx.ingress.kubernetes.io/proxy-buffer-size: "128k"
    nginx.ingress.kubernetes.io/proxy-buffers-number: "4"
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - keycloak.example.com
      secretName: keycloak-tls
  rules:
    - host: keycloak.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: keycloak
                port:
                  name: http
```

```bash
kubectl create secret generic keycloak-admin-secret \
  --namespace keycloak \
  --from-literal=username=admin \
  --from-literal=password='<admin-password-here>'

kubectl apply -f postgres-deployment.yaml
kubectl apply -f keycloak-deployment.yaml

# Wait for rollout
kubectl rollout status deployment/keycloak -n keycloak --timeout=300s
```

## Section 2: Realm and Client Configuration

### Creating the Kubernetes Realm

Keycloak uses realms as isolated identity namespaces. Create a dedicated realm for Kubernetes rather than using the master realm.

```bash
# Get admin token
KEYCLOAK_URL="https://keycloak.example.com"
TOKEN=$(curl -s -X POST "${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=admin&password=<admin-password>&grant_type=password&client_id=admin-cli" \
  | jq -r '.access_token')

# Create kubernetes realm
curl -s -X POST "${KEYCLOAK_URL}/admin/realms" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "realm": "kubernetes",
    "enabled": true,
    "displayName": "Kubernetes",
    "accessTokenLifespan": 300,
    "refreshTokenMaxReuse": 0,
    "ssoSessionIdleTimeout": 1800,
    "ssoSessionMaxLifespan": 36000,
    "bruteForceProtected": true,
    "permanentLockout": false,
    "maxFailureWaitSeconds": 900,
    "minimumQuickLoginWaitSeconds": 60,
    "waitIncrementSeconds": 60,
    "quickLoginCheckMilliSeconds": 1000,
    "maxDeltaTimeSeconds": 43200,
    "failureFactor": 5
  }'
```

### Creating the kubectl Client

```bash
# Create the kubectl OIDC client
curl -s -X POST "${KEYCLOAK_URL}/admin/realms/kubernetes/clients" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "clientId": "kubectl",
    "name": "kubectl",
    "enabled": true,
    "clientAuthenticatorType": "client-secret",
    "secret": "<kubectl-client-secret>",
    "redirectUris": [
      "http://localhost:8000",
      "http://localhost:18000"
    ],
    "webOrigins": ["*"],
    "standardFlowEnabled": true,
    "implicitFlowEnabled": false,
    "directAccessGrantsEnabled": false,
    "serviceAccountsEnabled": false,
    "publicClient": false,
    "protocol": "openid-connect",
    "attributes": {
      "pkce.code.challenge.method": "S256"
    }
  }'
```

### Configuring Group Claims in ID Token

Kubernetes reads group membership from a configurable claim in the ID token. Configure a mapper to include group paths:

```bash
# Get the client ID (UUID) for kubectl
CLIENT_UUID=$(curl -s "${KEYCLOAK_URL}/admin/realms/kubernetes/clients?clientId=kubectl" \
  -H "Authorization: Bearer ${TOKEN}" | jq -r '.[0].id')

# Add groups mapper to the client
curl -s -X POST "${KEYCLOAK_URL}/admin/realms/kubernetes/clients/${CLIENT_UUID}/protocol-mappers/models" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "groups",
    "protocol": "openid-connect",
    "protocolMapper": "oidc-group-membership-mapper",
    "config": {
      "full.path": "false",
      "id.token.claim": "true",
      "access.token.claim": "true",
      "claim.name": "groups",
      "userinfo.token.claim": "true"
    }
  }'
```

### Creating Groups and Users

```bash
# Create cluster-admin group
curl -s -X POST "${KEYCLOAK_URL}/admin/realms/kubernetes/groups" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"name": "cluster-admins"}'

# Create developers group
curl -s -X POST "${KEYCLOAK_URL}/admin/realms/kubernetes/groups" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"name": "developers"}'

# Create readonly group
curl -s -X POST "${KEYCLOAK_URL}/admin/realms/kubernetes/groups" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"name": "readonly"}'

# Create a user and add to developers group
curl -s -X POST "${KEYCLOAK_URL}/admin/realms/kubernetes/users" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "jane.doe",
    "email": "jane.doe@example.com",
    "firstName": "Jane",
    "lastName": "Doe",
    "enabled": true,
    "credentials": [{"type": "password", "value": "TempPass123!", "temporary": true}]
  }'

# Get user ID and add to developers group
USER_ID=$(curl -s "${KEYCLOAK_URL}/admin/realms/kubernetes/users?username=jane.doe" \
  -H "Authorization: Bearer ${TOKEN}" | jq -r '.[0].id')

GROUP_ID=$(curl -s "${KEYCLOAK_URL}/admin/realms/kubernetes/groups?search=developers" \
  -H "Authorization: Bearer ${TOKEN}" | jq -r '.[0].id')

curl -s -X PUT "${KEYCLOAK_URL}/admin/realms/kubernetes/users/${USER_ID}/groups/${GROUP_ID}" \
  -H "Authorization: Bearer ${TOKEN}"
```

## Section 3: Configuring kube-apiserver for OIDC

### Obtaining the Keycloak Discovery Endpoint

```bash
# Verify the OIDC discovery endpoint is accessible from the control plane
curl -s "https://keycloak.example.com/realms/kubernetes/.well-known/openid-configuration" | jq '{
  issuer: .issuer,
  authorization_endpoint: .authorization_endpoint,
  token_endpoint: .token_endpoint,
  jwks_uri: .jwks_uri
}'
```

### Modifying kube-apiserver Flags

For kubeadm-managed clusters, modify the apiserver manifest:

```yaml
# /etc/kubernetes/manifests/kube-apiserver.yaml (relevant additions)
apiVersion: v1
kind: Pod
metadata:
  name: kube-apiserver
  namespace: kube-system
spec:
  containers:
    - name: kube-apiserver
      command:
        - kube-apiserver
        # ... existing flags ...
        - --oidc-issuer-url=https://keycloak.example.com/realms/kubernetes
        - --oidc-client-id=kubectl
        - --oidc-username-claim=preferred_username
        - --oidc-username-prefix=oidc:
        - --oidc-groups-claim=groups
        - --oidc-groups-prefix=oidc:
        # Optional: restrict to specific signing algorithms
        - --oidc-signing-algs=RS256
        # Optional: CA bundle if using private CA for Keycloak TLS
        # - --oidc-ca-file=/etc/kubernetes/pki/keycloak-ca.crt
```

For managed Kubernetes (EKS, GKE, AKS), refer to provider-specific OIDC configuration. EKS supports OIDC identity providers through the IAM console or eksctl:

```bash
# EKS - Associate OIDC provider
eksctl utils associate-iam-oidc-provider \
  --cluster my-cluster \
  --region us-east-1 \
  --approve

# For EKS API server authentication, use aws-auth ConfigMap approach or
# EKS Access Entries (newer API)
```

For K3s:

```bash
# /etc/rancher/k3s/config.yaml
kube-apiserver-arg:
  - "oidc-issuer-url=https://keycloak.example.com/realms/kubernetes"
  - "oidc-client-id=kubectl"
  - "oidc-username-claim=preferred_username"
  - "oidc-username-prefix=oidc:"
  - "oidc-groups-claim=groups"
  - "oidc-groups-prefix=oidc:"
```

After modifying the apiserver manifest, the kubelet will restart kube-apiserver automatically on kubeadm clusters:

```bash
# Verify the flags are applied
kubectl get pod kube-apiserver-$(hostname) -n kube-system -o yaml | \
  grep -A5 "oidc"
```

## Section 4: kubelogin for kubectl Authentication

### Installing kubelogin

kubelogin (krew plugin: `oidc-login`) handles the OIDC authentication flow for kubectl, managing the browser-based redirect and token storage.

```bash
# Install via krew
kubectl krew install oidc-login

# Or install directly
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m | sed 's/x86_64/amd64/')
VERSION="v1.28.0"
curl -fsSL "https://github.com/int128/kubelogin/releases/download/${VERSION}/kubelogin_${OS}_${ARCH}.zip" \
  -o kubelogin.zip
unzip kubelogin.zip
sudo install -m 755 kubelogin /usr/local/bin/kubectl-oidc_login
```

### Configuring kubeconfig for OIDC

```yaml
# ~/.kube/config (OIDC user section)
apiVersion: v1
kind: Config
clusters:
  - cluster:
      server: https://api.mycluster.example.com
      certificate-authority-data: <base64-encoded-tls-certificate>
    name: mycluster
contexts:
  - context:
      cluster: mycluster
      user: oidc-user
    name: mycluster-oidc
current-context: mycluster-oidc
users:
  - name: oidc-user
    user:
      exec:
        apiVersion: client.authentication.k8s.io/v1beta1
        command: kubectl
        args:
          - oidc-login
          - get-token
          - --oidc-issuer-url=https://keycloak.example.com/realms/kubernetes
          - --oidc-client-id=kubectl
          - --oidc-client-secret=<kubectl-client-secret>
          - --oidc-extra-scope=groups
          - --oidc-extra-scope=email
          - --oidc-extra-scope=profile
          # Use port 8000 for the local redirect server
          - --listen-address=localhost:8000
          # Cache tokens to avoid re-authentication on every kubectl call
          - --token-cache-dir=/home/user/.kube/cache/oidc-login
        env: []
        interactiveMode: IfAvailable
        provideClusterInfo: false
```

### Generating kubeconfig Programmatically

For distributing kubeconfigs to team members:

```bash
#!/bin/bash
# generate-kubeconfig.sh

CLUSTER_NAME="${1:-mycluster}"
API_SERVER="${2:-https://api.mycluster.example.com}"
KEYCLOAK_URL="https://keycloak.example.com"
REALM="kubernetes"
CLIENT_ID="kubectl"
CLIENT_SECRET="<kubectl-client-secret>"

# Get cluster CA certificate
CA_DATA=$(kubectl config view --raw --minify \
  --output 'jsonpath={.clusters[0].cluster.certificate-authority-data}')

cat > "${CLUSTER_NAME}-oidc.kubeconfig" <<EOF
apiVersion: v1
kind: Config
preferences: {}
clusters:
  - cluster:
      server: ${API_SERVER}
      certificate-authority-data: ${CA_DATA}
    name: ${CLUSTER_NAME}
contexts:
  - context:
      cluster: ${CLUSTER_NAME}
      user: oidc-user
    name: ${CLUSTER_NAME}-oidc
current-context: ${CLUSTER_NAME}-oidc
users:
  - name: oidc-user
    user:
      exec:
        apiVersion: client.authentication.k8s.io/v1beta1
        command: kubectl
        args:
          - oidc-login
          - get-token
          - --oidc-issuer-url=${KEYCLOAK_URL}/realms/${REALM}
          - --oidc-client-id=${CLIENT_ID}
          - --oidc-client-secret=${CLIENT_SECRET}
          - --oidc-extra-scope=groups
          - --oidc-extra-scope=email
          - --listen-address=localhost:8000
          - --token-cache-dir=\${HOME}/.kube/cache/oidc-login
        interactiveMode: IfAvailable
EOF

echo "Generated ${CLUSTER_NAME}-oidc.kubeconfig"
echo "Distribute this file to users who have kubectl and kubelogin installed."
```

### First Login Flow

```bash
# First use triggers the browser-based auth flow
kubectl --kubeconfig mycluster-oidc.kubeconfig get nodes

# kubelogin opens browser to:
# https://keycloak.example.com/realms/kubernetes/protocol/openid-connect/auth
# After authentication, tokens are cached at ~/.kube/cache/oidc-login/

# Subsequent calls use cached token until expiry
kubectl --kubeconfig mycluster-oidc.kubeconfig get pods --all-namespaces
```

### Headless/Non-Interactive Authentication (CI/CD)

For CI/CD pipelines, use the Resource Owner Password Credentials flow or a dedicated service account client:

```bash
# Direct grant (headless) - requires directAccessGrantsEnabled on the client
kubectl oidc-login get-token \
  --oidc-issuer-url=https://keycloak.example.com/realms/kubernetes \
  --oidc-client-id=kubectl-ci \
  --oidc-client-secret=<ci-client-secret> \
  --grant-type=password \
  --username="${CI_USERNAME}" \
  --password="${CI_PASSWORD}"
```

## Section 5: Group-Based RBAC Binding

With the OIDC username prefix set to `oidc:` and groups prefix set to `oidc:`, create ClusterRoleBindings that reference the prefixed group names.

### Cluster Admin Group Binding

```yaml
# rbac-cluster-admins.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: oidc-cluster-admins
subjects:
  - kind: Group
    name: "oidc:cluster-admins"
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: cluster-admin
  apiGroup: rbac.authorization.k8s.io
```

### Namespace-Scoped Developer Access

```yaml
# rbac-developers.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: developer
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log", "pods/exec", "services", "endpoints",
                 "configmaps", "persistentvolumeclaims"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["apps"]
    resources: ["deployments", "replicasets", "statefulsets", "daemonsets"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["batch"]
    resources: ["jobs", "cronjobs"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["ingresses"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "list", "watch"]
---
# Bind developers to specific namespaces
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: oidc-developers
  namespace: production
subjects:
  - kind: Group
    name: "oidc:developers"
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: developer
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: oidc-developers
  namespace: staging
subjects:
  - kind: Group
    name: "oidc:developers"
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: developer
  apiGroup: rbac.authorization.k8s.io
```

### Read-Only Cluster Access

```yaml
# rbac-readonly.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: oidc-readonly
subjects:
  - kind: Group
    name: "oidc:readonly"
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: view
  apiGroup: rbac.authorization.k8s.io
```

```bash
kubectl apply -f rbac-cluster-admins.yaml
kubectl apply -f rbac-developers.yaml
kubectl apply -f rbac-readonly.yaml

# Verify a user's effective permissions
kubectl auth can-i list pods --namespace production \
  --as="oidc:jane.doe" \
  --as-group="oidc:developers"
```

### Dynamic Namespace-Based RBAC with LimitRange

For teams that need isolated namespaces automatically provisioned based on group membership, combine RBAC with a namespace controller or GitOps workflow:

```yaml
# namespace-template.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: team-platform
  labels:
    team: platform
    managed-by: gitops
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: team-admin
  namespace: team-platform
subjects:
  - kind: Group
    name: "oidc:team-platform-admins"
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: admin
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: v1
kind: LimitRange
metadata:
  name: default-limits
  namespace: team-platform
spec:
  limits:
    - default:
        cpu: 500m
        memory: 512Mi
      defaultRequest:
        cpu: 100m
        memory: 128Mi
      type: Container
```

## Section 6: Token Refresh Handling

### Understanding Token Lifetimes

Keycloak issues three token types:
- **Access token**: Short-lived (5 minutes recommended for Kubernetes). Sent to the API server.
- **Refresh token**: Longer-lived (30 minutes session idle, 10 hours max). Used by kubelogin to obtain new access tokens.
- **ID token**: Contains user claims. Used by kube-apiserver for identity extraction.

### kubelogin Token Caching Behavior

kubelogin caches tokens in `~/.kube/cache/oidc-login/` by default. It automatically refreshes tokens before expiry:

```bash
# Inspect cached token
ls -la ~/.kube/cache/oidc-login/

# Token files are named by a hash of the OIDC configuration parameters
# kubelogin automatically uses the cached refresh token to get a new access token
# when the current access token is within 10 seconds of expiry

# Force re-authentication (clear cache)
kubectl oidc-login setup \
  --oidc-issuer-url=https://keycloak.example.com/realms/kubernetes \
  --oidc-client-id=kubectl

# Or clear cache manually
rm -rf ~/.kube/cache/oidc-login/
```

### Server-Side Session Management

Configure Keycloak realm settings for appropriate session lifetimes:

```bash
# Update realm token settings via API
curl -s -X PUT "${KEYCLOAK_URL}/admin/realms/kubernetes" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "accessTokenLifespan": 300,
    "accessTokenLifespanForImplicitFlow": 900,
    "ssoSessionIdleTimeout": 1800,
    "ssoSessionMaxLifespan": 36000,
    "offlineSessionIdleTimeout": 2592000,
    "refreshTokenMaxReuse": 0,
    "revokeRefreshToken": true
  }'
```

Setting `revokeRefreshToken: true` and `refreshTokenMaxReuse: 0` implements refresh token rotation, invalidating the previous refresh token each time a new access token is issued. This limits the blast radius of a stolen refresh token.

### Token Introspection for Applications

Applications running in Kubernetes that need to validate OIDC tokens use the introspection endpoint:

```go
// token-validator.go
package auth

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "net/url"
    "strings"
    "sync"
    "time"

    "github.com/coreos/go-oidc/v3/oidc"
    "golang.org/x/oauth2"
)

type OIDCValidator struct {
    provider *oidc.Provider
    verifier *oidc.IDTokenVerifier
    mu       sync.RWMutex
}

func NewOIDCValidator(ctx context.Context, issuerURL, clientID string) (*OIDCValidator, error) {
    provider, err := oidc.NewProvider(ctx, issuerURL)
    if err != nil {
        return nil, fmt.Errorf("failed to create OIDC provider: %w", err)
    }

    verifier := provider.Verifier(&oidc.Config{
        ClientID: clientID,
    })

    return &OIDCValidator{
        provider: provider,
        verifier: verifier,
    }, nil
}

type Claims struct {
    Subject           string   `json:"sub"`
    Email             string   `json:"email"`
    PreferredUsername string   `json:"preferred_username"`
    Groups            []string `json:"groups"`
    ExpiresAt         int64    `json:"exp"`
}

func (v *OIDCValidator) ValidateToken(ctx context.Context, rawToken string) (*Claims, error) {
    idToken, err := v.verifier.Verify(ctx, rawToken)
    if err != nil {
        return nil, fmt.Errorf("token verification failed: %w", err)
    }

    var claims Claims
    if err := idToken.Claims(&claims); err != nil {
        return nil, fmt.Errorf("failed to parse claims: %w", err)
    }

    return &claims, nil
}

// Middleware for HTTP handlers
func (v *OIDCValidator) Middleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        authHeader := r.Header.Get("Authorization")
        if !strings.HasPrefix(authHeader, "Bearer ") {
            http.Error(w, "missing or invalid Authorization header", http.StatusUnauthorized)
            return
        }

        token := strings.TrimPrefix(authHeader, "Bearer ")
        claims, err := v.ValidateToken(r.Context(), token)
        if err != nil {
            http.Error(w, fmt.Sprintf("invalid token: %v", err), http.StatusUnauthorized)
            return
        }

        ctx := context.WithValue(r.Context(), claimsKey{}, claims)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

type claimsKey struct{}

func ClaimsFromContext(ctx context.Context) (*Claims, bool) {
    claims, ok := ctx.Value(claimsKey{}).(*Claims)
    return claims, ok
}
```

## Section 7: Multi-Realm Multi-Cluster Configuration

### Architecture for Multiple Clusters

A common pattern is to use separate realms for different security domains (production vs. development) while sharing Keycloak infrastructure:

```
Keycloak
├── Realm: kubernetes-prod
│   ├── Client: prod-cluster-1
│   ├── Client: prod-cluster-2
│   └── Groups: prod-admins, prod-developers
└── Realm: kubernetes-dev
    ├── Client: dev-cluster-1
    └── Groups: dev-admins, all-developers
```

### Per-Cluster Client Configuration

```bash
#!/bin/bash
# configure-cluster-client.sh

KEYCLOAK_URL="https://keycloak.example.com"
REALM="${1}"
CLUSTER_NAME="${2}"
REDIRECT_PORTS=("8000" "18000")

TOKEN=$(curl -s -X POST "${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=admin&password=<admin-password>&grant_type=password&client_id=admin-cli" \
  | jq -r '.access_token')

REDIRECT_URIS=$(printf '"http://localhost:%s",' "${REDIRECT_PORTS[@]}")
REDIRECT_URIS="[${REDIRECT_URIS%,}]"

curl -s -X POST "${KEYCLOAK_URL}/admin/realms/${REALM}/clients" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"clientId\": \"${CLUSTER_NAME}\",
    \"name\": \"${CLUSTER_NAME}\",
    \"enabled\": true,
    \"clientAuthenticatorType\": \"client-secret\",
    \"secret\": \"<cluster-client-secret>\",
    \"redirectUris\": ${REDIRECT_URIS},
    \"standardFlowEnabled\": true,
    \"directAccessGrantsEnabled\": false,
    \"protocol\": \"openid-connect\",
    \"attributes\": {\"pkce.code.challenge.method\": \"S256\"}
  }"

echo "Created client ${CLUSTER_NAME} in realm ${REALM}"
```

### Federated Identity with LDAP

For enterprises with Active Directory or LDAP, configure Keycloak federation:

```bash
# Configure LDAP federation via API
curl -s -X POST "${KEYCLOAK_URL}/admin/realms/kubernetes/components" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "corporate-ldap",
    "providerId": "ldap",
    "providerType": "org.keycloak.storage.UserStorageProvider",
    "config": {
      "vendor": ["ad"],
      "connectionUrl": ["ldap://dc01.corp.example.com:389"],
      "bindDn": ["CN=keycloak-svc,OU=Service Accounts,DC=corp,DC=example,DC=com"],
      "bindCredential": ["<ldap-bind-password>"],
      "usersDn": ["OU=Users,DC=corp,DC=example,DC=com"],
      "userObjectClasses": ["person, organizationalPerson, user"],
      "usernameAttribute": ["sAMAccountName"],
      "uuidAttribute": ["objectGUID"],
      "usernameLDAPAttribute": ["sAMAccountName"],
      "rdnAttribute": ["cn"],
      "syncRegistrations": ["false"],
      "authType": ["simple"],
      "searchScope": ["2"],
      "importEnabled": ["true"],
      "editMode": ["READ_ONLY"],
      "pagination": ["true"]
    }
  }'
```

### Multi-Cluster kubeconfig Management

```yaml
# ~/.kube/config with multiple OIDC clusters
apiVersion: v1
kind: Config
clusters:
  - cluster:
      server: https://api.prod-cluster-1.example.com
      certificate-authority-data: <base64-encoded-tls-certificate>
    name: prod-cluster-1
  - cluster:
      server: https://api.prod-cluster-2.example.com
      certificate-authority-data: <base64-encoded-tls-certificate>
    name: prod-cluster-2
  - cluster:
      server: https://api.dev-cluster-1.example.com
      certificate-authority-data: <base64-encoded-tls-certificate>
    name: dev-cluster-1
contexts:
  - context:
      cluster: prod-cluster-1
      user: oidc-prod
    name: prod-cluster-1
  - context:
      cluster: prod-cluster-2
      user: oidc-prod
    name: prod-cluster-2
  - context:
      cluster: dev-cluster-1
      user: oidc-dev
    name: dev-cluster-1
users:
  - name: oidc-prod
    user:
      exec:
        apiVersion: client.authentication.k8s.io/v1beta1
        command: kubectl
        args:
          - oidc-login
          - get-token
          - --oidc-issuer-url=https://keycloak.example.com/realms/kubernetes-prod
          - --oidc-client-id=prod-cluster-1
          - --oidc-client-secret=<prod-client-secret>
          - --oidc-extra-scope=groups
          - --token-cache-dir=/home/user/.kube/cache/oidc-login
        interactiveMode: IfAvailable
  - name: oidc-dev
    user:
      exec:
        apiVersion: client.authentication.k8s.io/v1beta1
        command: kubectl
        args:
          - oidc-login
          - get-token
          - --oidc-issuer-url=https://keycloak.example.com/realms/kubernetes-dev
          - --oidc-client-id=dev-cluster-1
          - --oidc-client-secret=<dev-client-secret>
          - --oidc-extra-scope=groups
          - --token-cache-dir=/home/user/.kube/cache/oidc-login
        interactiveMode: IfAvailable
```

## Section 8: Keycloak High Availability and Operations

### Keycloak Cluster Health Monitoring

```yaml
# keycloak-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: keycloak
  namespace: keycloak
spec:
  selector:
    matchLabels:
      app: keycloak
  endpoints:
    - port: http
      path: /metrics
      interval: 30s
```

### Backup and Restore

```bash
#!/bin/bash
# keycloak-backup.sh

KEYCLOAK_URL="https://keycloak.example.com"
BACKUP_DIR="/backup/keycloak/$(date +%Y%m%d)"
mkdir -p "${BACKUP_DIR}"

TOKEN=$(curl -s -X POST "${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=admin&password=<admin-password>&grant_type=password&client_id=admin-cli" \
  | jq -r '.access_token')

# Export each realm
for REALM in kubernetes kubernetes-prod kubernetes-dev; do
  echo "Exporting realm: ${REALM}"
  curl -s "${KEYCLOAK_URL}/admin/realms/${REALM}" \
    -H "Authorization: Bearer ${TOKEN}" \
    > "${BACKUP_DIR}/${REALM}-realm.json"
done

# Backup PostgreSQL
kubectl exec -n keycloak \
  $(kubectl get pods -n keycloak -l app=keycloak-postgres -o jsonpath='{.items[0].metadata.name}') \
  -- pg_dump -U keycloak keycloak | gzip > "${BACKUP_DIR}/keycloak-postgres.sql.gz"

echo "Backup complete: ${BACKUP_DIR}"
```

### Troubleshooting OIDC Authentication

```bash
# Test the OIDC flow manually
TOKEN_RESPONSE=$(curl -s -X POST \
  "https://keycloak.example.com/realms/kubernetes/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password" \
  -d "client_id=kubectl" \
  -d "client_secret=<kubectl-client-secret>" \
  -d "username=jane.doe" \
  -d "password=<user-password>" \
  -d "scope=openid email profile groups")

ACCESS_TOKEN=$(echo "${TOKEN_RESPONSE}" | jq -r '.access_token')
ID_TOKEN=$(echo "${TOKEN_RESPONSE}" | jq -r '.id_token')

# Decode the ID token (JWT) to verify claims
echo "${ID_TOKEN}" | cut -d'.' -f2 | base64 -d 2>/dev/null | jq .

# Test against the API server directly
kubectl get nodes \
  --token="${ID_TOKEN}" \
  --server=https://api.mycluster.example.com \
  --certificate-authority=/etc/kubernetes/pki/ca.crt

# Check kube-apiserver logs for OIDC errors
kubectl logs -n kube-system kube-apiserver-$(hostname) | grep -i oidc

# Verify group membership appears in token
echo "${ID_TOKEN}" | cut -d'.' -f2 | base64 -d 2>/dev/null | jq '.groups'

# Expected output: ["cluster-admins"] or ["developers"] etc.

# Check if RBAC is correctly configured
kubectl auth can-i list pods --namespace production \
  --as="oidc:jane.doe" \
  --as-group="oidc:developers"
```

### Common Issues and Solutions

**Issue: "oidc: unable to verify signature"**
- Verify the issuer URL in kube-apiserver flags exactly matches the `iss` claim in the token
- Check network connectivity from control plane to Keycloak
- Verify TLS certificates are valid and trusted

**Issue: Groups not appearing in token**
- Confirm the groups mapper is added to the client (not just the realm)
- Check the claim name matches `--oidc-groups-claim` flag
- Verify the user is actually a member of Keycloak groups

**Issue: Token expiry causing frequent re-authentication**
- Increase `accessTokenLifespan` in realm settings (balance with security requirements)
- Ensure kubelogin's token cache directory is writable and persisted

**Issue: kubelogin port conflict**
- Use `--listen-address=localhost:18000` as alternative port
- Multiple cluster logins can conflict on the same port; use different ports per cluster client

## Conclusion

Deploying Keycloak as the OIDC provider for Kubernetes delivers a robust, enterprise-grade authentication foundation. The combination of short-lived tokens, group-based RBAC, and centralized identity federation reduces operational overhead while strengthening the security posture across multiple clusters. Key operational practices include enabling refresh token rotation, monitoring Keycloak cluster health, implementing regular realm backups, and maintaining documented runbooks for token-related incidents.
