---
title: "Dex Identity Provider: Federated OIDC for Kubernetes Authentication"
date: 2027-01-18T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Dex", "OIDC", "Authentication", "Security"]
categories: ["Security", "Kubernetes", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to deploying Dex as a federated OIDC identity broker for Kubernetes. Covers connectors (LDAP, GitHub, Google, SAML), kubelogin kubectl flow, OAuth2 clients for ArgoCD and Grafana, Vault integration, HA setup, and production monitoring."
more_link: "yes"
url: "/dex-identity-provider-kubernetes-oidc-enterprise-guide/"
---

Enterprise Kubernetes clusters require centralized, federated identity that connects corporate LDAP directories, GitHub organizations, Google Workspace, and SAML identity providers into a single OIDC token endpoint that every cluster component trusts. **Dex** fills this role as a lightweight, Kubernetes-native identity broker: it accepts logins from upstream identity providers through configurable connectors and issues standard OIDC tokens that the Kubernetes API server, ArgoCD, Grafana, Harbor, and Vault all consume natively.

<!--more-->

## Executive Summary

**Dex** (Dex Identity Service) is a CNCF project that acts as an OIDC Identity Provider (IdP) federation layer. Instead of building direct integrations between each downstream application and every upstream IdP, Dex centralizes that complexity: upstream connectors translate diverse authentication protocols (LDAP, SAML 2.0, OAuth2, GitHub, Google) into a consistent OIDC token stream. Downstream OAuth2 clients register with Dex once and receive JWTs regardless of where the user actually authenticated. This guide covers a full production deployment on Kubernetes including HA configuration, all major connector types, Kubernetes API server integration with `kubelogin`, and monitoring.

## Dex Architecture

### Component Overview

```
                   ┌──────────────────────────────────┐
  kubectl oidc-login│           Dex Server              │
  ArgoCD            │  ┌─────────┐   ┌───────────────┐ │
  Grafana  ─────────►  │ gRPC    │   │ OIDC/OAuth2   │ │
  Harbor            │  │ API     │   │ Endpoints     │ │
  Vault             │  └────┬────┘   └──────┬────────┘ │
                   │       │               │           │
                   │  ┌────▼────────────────▼────────┐ │
                   │  │     Connector Layer           │ │
                   │  │  LDAP  GitHub  Google  SAML   │ │
                   │  └───────────────────────────────┘ │
                   │  ┌───────────────────────────────┐ │
                   │  │     Storage Backend           │ │
                   │  │  Kubernetes CRDs / PostgreSQL │ │
                   │  └───────────────────────────────┘ │
                   └──────────────────────────────────┘
                              │
              ┌───────────────┼────────────────┐
              ▼               ▼                ▼
    Corporate LDAP     GitHub Org        SAML IdP
```

### Storage Backends

Dex supports multiple storage backends. For Kubernetes deployments, the **Kubernetes CRD** backend is preferred because it eliminates the need for an external database and leverages ETCD replication for HA:

| Backend | Use Case |
|---|---|
| Kubernetes CRDs | Recommended for in-cluster deployments |
| PostgreSQL | Multi-cluster setups, external HA |
| MySQL | Legacy environments |
| SQLite3 | Single-node dev/test only |
| Memory | Testing only — no persistence |

## Deploying Dex on Kubernetes

### Namespace and RBAC

```yaml
# dex-rbac.yaml
---
apiVersion: v1
kind: Namespace
metadata:
  name: dex
  labels:
    app.kubernetes.io/name: dex
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: dex
  namespace: dex
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: dex
rules:
# Required for Kubernetes CRD storage backend
- apiGroups: ["dex.coreos.com"]
  resources:
  - authcodes
  - authrequests
  - connectors
  - devicerequests
  - devicetokens
  - oauth2clients
  - offlinesessionses
  - passwords
  - refreshtokens
  - signingkeies
  verbs: ["*"]
- apiGroups: ["apiextensions.k8s.io"]
  resources: ["customresourcedefinitions"]
  verbs: ["create"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: dex
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: dex
subjects:
- kind: ServiceAccount
  name: dex
  namespace: dex
```

### Helm Deployment

```bash
#!/bin/bash
# deploy-dex.sh

helm repo add dex https://charts.dexidp.io
helm repo update

helm upgrade --install dex dex/dex \
  --namespace dex \
  --create-namespace \
  --version 0.18.0 \
  --values dex-values.yaml \
  --wait
```

### Helm Values — Production HA

```yaml
# dex-values.yaml
replicaCount: 2

image:
  repository: ghcr.io/dexidp/dex
  tag: v2.38.0
  pullPolicy: IfNotPresent

resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 256Mi

affinity:
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
    - labelSelector:
        matchLabels:
          app.kubernetes.io/name: dex
      topologyKey: kubernetes.io/hostname

topologySpreadConstraints:
- maxSkew: 1
  topologyKey: topology.kubernetes.io/zone
  whenUnsatisfiable: DoNotSchedule
  labelSelector:
    matchLabels:
      app.kubernetes.io/name: dex

service:
  type: ClusterIP
  ports:
    http:
      port: 5556
    grpc:
      port: 5557
    metrics:
      port: 5558

ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/proxy-buffer-size: "16k"
  hosts:
  - host: dex.example.com
    paths:
    - path: /
      pathType: Prefix
  tls:
  - secretName: dex-tls
    hosts:
    - dex.example.com

config:
  # Issuer URL must match the ingress hostname exactly
  issuer: https://dex.example.com

  storage:
    type: kubernetes
    config:
      inCluster: true

  web:
    http: 0.0.0.0:5556

  grpc:
    addr: 0.0.0.0:5557
    tlsCert: /etc/dex/tls/tls.crt
    tlsKey: /etc/dex/tls/tls.key

  telemetry:
    http: 0.0.0.0:5558

  expiry:
    authRequests: 24h
    deviceRequests: 5m
    # ID token lifetime — keep short; refresh tokens handle long-lived sessions
    idTokens: 1h
    refreshTokens:
      validIfNotUsedFor: 720h    # 30 days idle
      absoluteLifetime: 8760h   # 1 year max

  logger:
    level: info
    format: json

  oauth2:
    skipApprovalScreen: false
    responseTypes:
    - code
    grantTypes:
    - authorization_code
    - refresh_token
    - urn:ietf:params:oauth:grant-type:device_code

  # Frontend customization
  frontend:
    issuer: Platform Engineering
    logoURL: https://example.com/logo.png
    dir: ""
    theme: coreos

  connectors: []   # Defined per-connector sections below
  staticClients: [] # Defined per-application sections below
```

## Configuring Connectors

### LDAP / Active Directory Connector

```yaml
# ldap-connector-config.yaml
# Add this under dex-values.yaml config.connectors:
connectors:
- type: ldap
  id: ldap
  name: LDAP / Active Directory
  config:
    # LDAP server connection
    host: ldap.example.com:636
    insecureNoSSL: false
    insecureSkipVerify: false
    rootCAData: |
      LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0t...  # base64 PEM CA cert

    # Bind credentials (use a read-only service account)
    bindDN: "CN=svc-dex,OU=ServiceAccounts,DC=example,DC=com"
    bindPW: "$DEX_LDAP_BIND_PASSWORD"  # Resolved from env var

    # User search
    userSearch:
      baseDN: "OU=Users,DC=example,DC=com"
      filter: "(objectClass=person)"
      username: sAMAccountName
      idAttr: DN
      emailAttr: mail
      nameAttr: displayName
      preferredUsernameAttr: sAMAccountName

    # Group search — groups become OIDC `groups` claim
    groupSearch:
      baseDN: "OU=Groups,DC=example,DC=com"
      filter: "(objectClass=group)"
      userMatchers:
      - userAttr: DN
        groupAttr: member
      nameAttr: cn
```

Store the bind password in a Kubernetes Secret and inject it as an environment variable:

```yaml
# dex-ldap-secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: dex-ldap-secret
  namespace: dex
type: Opaque
stringData:
  bindPW: "ChangeMe-ServiceAccountPassword"
---
# Patch values to mount the secret as env
# In dex-values.yaml:
envFrom:
- secretRef:
    name: dex-ldap-secret
env:
- name: DEX_LDAP_BIND_PASSWORD
  valueFrom:
    secretKeyRef:
      name: dex-ldap-secret
      key: bindPW
```

### GitHub Connector

```yaml
# github-connector.yaml
connectors:
- type: github
  id: github
  name: GitHub
  config:
    clientID: "${GITHUB_CLIENT_ID}"
    clientSecret: "${GITHUB_CLIENT_SECRET}"
    redirectURI: https://dex.example.com/callback

    # Restrict to specific organizations
    orgs:
    - name: mycompany
      teams:
      - platform-engineering
      - devops
      - sre
    - name: mycompany-contractors

    # Include team membership in `groups` claim
    loadAllGroups: false
    teamNameField: slug
    useLoginAsID: false
```

Register the GitHub OAuth App at `https://github.com/organizations/mycompany/settings/applications/new`:
- Homepage URL: `https://dex.example.com`
- Authorization callback URL: `https://dex.example.com/callback`

### Google Workspace Connector

```yaml
# google-connector.yaml
connectors:
- type: google
  id: google
  name: Google Workspace
  config:
    clientID: "${GOOGLE_CLIENT_ID}"
    clientSecret: "${GOOGLE_CLIENT_SECRET}"
    redirectURI: https://dex.example.com/callback

    # Restrict to your domain
    hostedDomains:
    - example.com

    # Fetch group membership via Admin SDK (requires service account)
    serviceAccountFilePath: /etc/dex/google-sa.json
    adminEmail: admin@example.com
    groups:
    - platform-team@example.com
    - devops@example.com
    - sre@example.com
```

### SAML 2.0 Connector

```yaml
# saml-connector.yaml
connectors:
- type: saml
  id: saml-okta
  name: Okta
  config:
    ssoURL: https://example.okta.com/app/saml/exkabcdef1234567890/sso/saml
    ca: /etc/dex/saml-ca.pem
    redirectURI: https://dex.example.com/callback

    # Attribute mapping from SAML assertion
    usernameAttr: email
    emailAttr: email
    groupsAttr: groups

    entityIssuer: https://dex.example.com
    ssoIssuer: https://example.okta.com
    nameIDPolicyFormat: emailAddress

    # Signature verification
    insecureSkipSignatureValidation: false
```

### Password DB (Local Accounts)

```yaml
# Useful for break-glass access and CI service accounts
staticPasswords:
- email: admin@example.com
  # Generate with: echo password | htpasswd -BinC 10 admin | cut -d: -f2
  hash: "$2a$10$2b2cU8CPhOTaGrs1HRQuAueS7JTT5ZHsHSzYbe.OR5YTYZV8tKMJm"
  username: admin
  userID: "08a8684b-db88-4b73-90a9-3cd1661f5466"
- email: ci-service@example.com
  hash: "$2a$10$ExampleHashValueForDocumentationOnly1234567890abcdef"
  username: ci-service
  userID: "4d9d4c43-e2f6-4c08-9d87-1234567890ab"
```

## OAuth2 Client Registration

### Static Clients

```yaml
# static-clients in dex-values.yaml config:
staticClients:
# Kubernetes API server client (used by kubelogin)
- id: kubernetes
  name: Kubernetes
  secret: EXAMPLE_KUBE_CLIENT_SECRET
  redirectURIs:
  - http://localhost:8000
  - http://localhost:18000
  - urn:ietf:wg:oauth:2.0:oob

# ArgoCD
- id: argocd
  name: ArgoCD
  secret: EXAMPLE_ARGOCD_CLIENT_SECRET
  redirectURIs:
  - https://argocd.example.com/auth/callback

# Grafana
- id: grafana
  name: Grafana
  secret: EXAMPLE_GRAFANA_CLIENT_SECRET
  redirectURIs:
  - https://grafana.example.com/login/generic_oauth

# Harbor
- id: harbor
  name: Harbor
  secret: EXAMPLE_HARBOR_CLIENT_SECRET
  redirectURIs:
  - https://harbor.example.com/c/oidc/callback

# Vault (uses OIDC auth method)
- id: vault
  name: HashiCorp Vault
  secret: EXAMPLE_VAULT_CLIENT_SECRET
  redirectURIs:
  - https://vault.example.com/ui/vault/auth/oidc/oidc/callback
  - https://vault.example.com/oidc/callback
```

## Kubernetes API Server OIDC Integration

### API Server Flags

Add the following flags to the kube-apiserver (or the EKS/AKS/GKE equivalent configuration):

```yaml
# kube-apiserver extra args (kubeadm ClusterConfiguration)
apiServer:
  extraArgs:
    oidc-issuer-url: https://dex.example.com
    oidc-client-id: kubernetes
    # Claim to use as the user's username
    oidc-username-claim: email
    # Prefix to avoid namespace collision with local accounts
    oidc-username-prefix: "dex:"
    # Claim to use as group memberships
    oidc-groups-claim: groups
    oidc-groups-prefix: "dex:"
    # Validate the CA of Dex's TLS certificate
    oidc-ca-file: /etc/kubernetes/pki/dex-ca.pem
```

For EKS, OIDC configuration is applied through the `associateOIDCProvider` API and via `aws eks associate-identity-provider-config`:

```bash
#!/bin/bash
# eks-oidc-config.sh

CLUSTER_NAME="production-cluster"
ISSUER_URL="https://dex.example.com"

aws eks associate-identity-provider-config \
  --cluster-name "${CLUSTER_NAME}" \
  --oidc "{
    \"identityProviderConfigName\": \"dex\",
    \"issuerUrl\": \"${ISSUER_URL}\",
    \"clientId\": \"kubernetes\",
    \"usernameClaim\": \"email\",
    \"usernamePrefix\": \"dex:\",
    \"groupsClaim\": \"groups\",
    \"groupsPrefix\": \"dex:\"
  }"
```

### RBAC for OIDC Users

```yaml
# oidc-rbac.yaml
---
# Bind the platform-engineering group to cluster-admin
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: dex-platform-admins
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin
subjects:
- kind: Group
  name: "dex:platform-engineering"   # dex: prefix matches oidc-groups-prefix
  apiGroup: rbac.authorization.k8s.io
---
# Read-only for devs
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: dex-developers-view
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: view
subjects:
- kind: Group
  name: "dex:developers"
  apiGroup: rbac.authorization.k8s.io
---
# Namespace-scoped edit for a team
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: dex-sre-edit
  namespace: production
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: edit
subjects:
- kind: Group
  name: "dex:sre"
  apiGroup: rbac.authorization.k8s.io
```

## kubelogin — kubectl OIDC Authentication Flow

**kubelogin** (`kubectl oidc-login`) is the client-side credential plugin that handles the browser-based OIDC flow for `kubectl`.

### Installation

```bash
# macOS
brew install int128/kubelogin/kubelogin

# Linux
curl -LO https://github.com/int128/kubelogin/releases/latest/download/kubelogin_linux_amd64.zip
unzip kubelogin_linux_amd64.zip
sudo mv kubelogin /usr/local/bin/kubectl-oidc_login

# Verify
kubectl oidc-login --help
```

### kubeconfig Configuration

```yaml
# ~/.kube/config (user section)
apiVersion: v1
kind: Config
clusters:
- name: production-cluster
  cluster:
    server: https://api.production.example.com
    certificate-authority-data: LS0tLS1CRUdJTiB...

users:
- name: oidc-user
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: kubectl
      args:
      - oidc-login
      - get-token
      - --oidc-issuer-url=https://dex.example.com
      - --oidc-client-id=kubernetes
      - --oidc-client-secret=EXAMPLE_KUBE_CLIENT_SECRET
      - --oidc-extra-scope=groups
      - --oidc-extra-scope=email
      - --oidc-extra-scope=profile
      - --grant-type=authcode
      - --listen-address=127.0.0.1:8000
      interactiveMode: IfAvailable
      provideClusterInfo: false

contexts:
- name: production
  context:
    cluster: production-cluster
    user: oidc-user
    namespace: default
```

### CLI-Only Flow with Device Authorization

For headless environments (CI, SSH sessions):

```yaml
# kubeconfig for device flow
users:
- name: oidc-device
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: kubectl
      args:
      - oidc-login
      - get-token
      - --oidc-issuer-url=https://dex.example.com
      - --oidc-client-id=kubernetes
      - --oidc-client-secret=EXAMPLE_KUBE_CLIENT_SECRET
      - --grant-type=device-code
```

## Downstream Application Integration

### ArgoCD OIDC Configuration

```yaml
# argocd-cm ConfigMap patch
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  url: https://argocd.example.com
  oidc.config: |
    name: Dex
    issuer: https://dex.example.com
    clientID: argocd
    clientSecret: $oidc.dex.clientSecret
    requestedScopes:
    - openid
    - profile
    - email
    - groups
    requestedIDTokenClaims:
      groups:
        essential: true
---
# argocd-rbac-cm: map Dex groups to ArgoCD roles
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-rbac-cm
  namespace: argocd
data:
  policy.csv: |
    g, dex:platform-engineering, role:admin
    g, dex:developers, role:readonly
    g, dex:sre, role:operator
  policy.default: role:readonly
```

### Grafana OIDC Configuration

```ini
# grafana.ini (relevant sections)
[server]
root_url = https://grafana.example.com

[auth.generic_oauth]
enabled = true
name = Dex
allow_sign_up = true
client_id = grafana
client_secret = EXAMPLE_GRAFANA_CLIENT_SECRET
scopes = openid email profile groups
auth_url = https://dex.example.com/auth
token_url = https://dex.example.com/token
api_url = https://dex.example.com/userinfo
use_pkce = true

# Map OIDC groups to Grafana roles
role_attribute_path = contains(groups[*], 'dex:grafana-admin') && 'GrafanaAdmin' || contains(groups[*], 'dex:grafana-editor') && 'Editor' || 'Viewer'
role_attribute_strict = false
allow_assign_grafana_admin = true
```

### Vault OIDC Integration

```bash
#!/bin/bash
# configure-vault-dex-oidc.sh

VAULT_ADDR="https://vault.example.com"

# Enable OIDC auth method
vault auth enable oidc

# Configure OIDC
vault write auth/oidc/config \
  oidc_discovery_url="https://dex.example.com" \
  oidc_client_id="vault" \
  oidc_client_secret="EXAMPLE_VAULT_CLIENT_SECRET" \
  default_role="default"

# Create a role mapping groups to Vault policies
vault write auth/oidc/role/default \
  bound_audiences="vault" \
  allowed_redirect_uris="https://vault.example.com/ui/vault/auth/oidc/oidc/callback" \
  allowed_redirect_uris="https://vault.example.com/oidc/callback" \
  user_claim="email" \
  groups_claim="groups" \
  oidc_scopes="openid,profile,email,groups" \
  token_policies="default" \
  token_ttl="1h" \
  token_max_ttl="8h"

# Map external group to Vault policy
vault write identity/group \
  name="platform-engineering" \
  type="external" \
  policies="superuser"

GROUP_ID=$(vault read -field=id identity/group/name/platform-engineering)

vault write identity/group-alias \
  name="dex:platform-engineering" \
  canonical_id="${GROUP_ID}" \
  mount_accessor=$(vault auth list -format=json | \
    python3 -c "import sys,json; d=json.load(sys.stdin); print(d['oidc/']['accessor'])")
```

## PKI Connector

Dex supports client TLS certificate authentication through the x509 PKI connector, useful for automated systems that hold client certificates rather than user credentials:

```yaml
# pki-connector.yaml
connectors:
- type: authproxy
  id: x509-pki
  name: Client Certificate
  config:
    # Dex trusts a reverse proxy (nginx/envoy) to validate the client cert
    # and pass the user info in HTTP headers
    userHeader: X-Remote-User
    groupHeader: X-Remote-Group
    emailHeader: X-Remote-Email
```

## Token Refresh and Session Management

Dex issues both `id_token` (short-lived, 1h) and `refresh_token` (long-lived). kubelogin automatically refreshes the id_token using the stored refresh_token:

```bash
# Force token refresh
kubectl oidc-login get-token \
  --oidc-issuer-url=https://dex.example.com \
  --oidc-client-id=kubernetes \
  --oidc-client-secret=EXAMPLE_KUBE_CLIENT_SECRET \
  --force-refresh

# Clear stored tokens
kubectl oidc-login clean-token-cache
```

Adjust token lifetimes based on security requirements:

```yaml
# In dex config:
expiry:
  idTokens: 1h          # Short for security
  authRequests: 24h
  refreshTokens:
    validIfNotUsedFor: 168h   # 7 days inactivity expiry
    absoluteLifetime: 2160h   # 90 days max
    reuseInterval: 3s         # Prevent refresh token reuse attacks
```

## Production HA Setup

### Horizontal Pod Autoscaler

```yaml
# dex-hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: dex
  namespace: dex
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: dex
  minReplicas: 2
  maxReplicas: 5
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 60
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 75
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: dex
  namespace: dex
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: dex
```

## Monitoring

### ServiceMonitor and Alerts

```yaml
# dex-monitoring.yaml
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: dex
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: dex
  namespaceSelector:
    matchNames:
    - dex
  endpoints:
  - port: metrics
    interval: 30s
    path: /metrics
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: dex-alerts
  namespace: monitoring
spec:
  groups:
  - name: dex
    interval: 30s
    rules:
    - alert: DexDown
      expr: up{job="dex"} == 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Dex identity provider is down"
        description: "All Dex replicas have been unreachable for 5 minutes."

    - alert: DexHighLoginFailureRate
      expr: |
        rate(dex_client_authentication_errors_total[5m]) /
        rate(dex_client_authentication_attempts_total[5m]) > 0.10
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "High Dex login failure rate"
        description: "{{ $value | humanizePercentage }} of login attempts are failing."

    - alert: DexConnectorError
      expr: rate(dex_connector_get_user_errors_total[5m]) > 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Dex connector errors for {{ $labels.connector_id }}"
        description: "Errors: {{ $value }}/s — upstream IdP may be unreachable."

    - alert: DexTokenSigningKeyRotationError
      expr: dex_keyserver_signing_key_expiry_seconds < 3600
      for: 10m
      labels:
        severity: critical
      annotations:
        summary: "Dex signing key expires soon"
        description: "Signing key expires in {{ $value | humanizeDuration }}."
```

## Troubleshooting

```bash
# Check Dex pod health
kubectl get pods -n dex
kubectl describe pod -n dex -l app.kubernetes.io/name=dex

# Tail Dex logs
kubectl logs -n dex -l app.kubernetes.io/name=dex --follow

# Test OIDC discovery endpoint
curl https://dex.example.com/.well-known/openid-configuration | python3 -m json.tool

# Verify JWKS endpoint (used by API server to validate tokens)
curl https://dex.example.com/keys | python3 -m json.tool

# Test LDAP connector connectivity from inside the cluster
kubectl run ldap-test --rm -it --image=alpine --restart=Never -- \
  sh -c "apk add openldap-clients && ldapsearch -H ldaps://ldap.example.com:636 \
    -D 'CN=svc-dex,OU=ServiceAccounts,DC=example,DC=com' \
    -w 'PASSWORD' -b 'OU=Users,DC=example,DC=com' '(sAMAccountName=testuser)'"

# Decode and inspect a Dex-issued JWT
kubectl oidc-login get-token --oidc-issuer-url=https://dex.example.com \
  --oidc-client-id=kubernetes --oidc-client-secret=EXAMPLE_KUBE_CLIENT_SECRET | \
  python3 -c "
import sys, base64, json
token = sys.stdin.read().strip()
payload = token.split('.')[1]
payload += '=' * (4 - len(payload) % 4)
print(json.dumps(json.loads(base64.urlsafe_b64decode(payload)), indent=2))
"
```

## Conclusion

Dex provides a battle-tested federation layer that decouples Kubernetes and downstream applications from any single upstream identity provider. Key operational recommendations:

- Use the Kubernetes CRD storage backend for in-cluster deployments — no external database required
- Set `expireAfter` on refresh tokens to enforce re-authentication after defined inactivity windows
- Deploy at least two replicas with a `PodDisruptionBudget` of `minAvailable: 1` to prevent auth outages during node maintenance
- Monitor `dex_connector_get_user_errors_total` to detect upstream IdP connectivity issues before they impact users
- Rotate client secrets stored in Kubernetes Secrets using sealed-secrets or External Secrets Operator
- Pin the Dex image tag and test connector upgrades in a staging environment before rolling to production
