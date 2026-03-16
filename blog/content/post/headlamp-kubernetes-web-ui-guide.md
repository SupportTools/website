---
title: "Headlamp: Extensible Open-Source Kubernetes Web UI"
date: 2027-03-11T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Headlamp", "UI", "Dashboard", "Developer Tools"]
categories: ["Kubernetes", "Developer Tools", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise deployment guide for Headlamp Kubernetes web UI, covering in-cluster and desktop installation, RBAC integration, plugin development, custom resource views, multi-cluster management, and OAuth2 SSO configuration."
more_link: "yes"
url: "/headlamp-kubernetes-web-ui-guide/"
---

The Kubernetes Dashboard has long been the default web UI for cluster inspection, but its limited extensibility, infrequent release cadence, and minimal customization options leave platform teams wanting more. Headlamp is an open-source, extensible Kubernetes web UI built by the Kinvolk (now Microsoft) team and currently a CNCF Sandbox project. Its plugin system — based on React and TypeScript — allows teams to build custom resource views, integrate with internal tools, and present context-specific cluster information without forking the core application. This guide covers in-cluster Helm deployment, RBAC configuration, OAuth2/OIDC SSO, multi-cluster management, plugin development, and a detailed comparison with alternatives.

<!--more-->

## Section 1: Headlamp vs Alternatives Comparison

Before committing to a web UI, understanding the tradeoffs between available options helps teams choose the right tool for their context.

| Feature | Headlamp | Kubernetes Dashboard | Lens | Octant | k9s |
|---|---|---|---|---|---|
| Type | Web UI (in-cluster + desktop) | Web UI (in-cluster) | Desktop app | Desktop web UI | Terminal TUI |
| Open source | Yes (Apache 2.0) | Yes (Apache 2.0) | Free tier / commercial | Yes (Apache 2.0) | Yes (Apache 2.0) |
| Plugin system | Yes (React/TS) | No | Yes (commercial) | Yes (Go + JS) | No |
| OIDC/SSO | Yes | Yes (limited) | Yes (commercial) | No | No |
| Multi-cluster | Yes | No (one cluster) | Yes | Yes | Yes |
| CRD auto-discovery | Yes | Limited | Yes | Yes | Yes |
| Air-gapped | Yes | Yes | No | Yes | Yes |
| Active development | Yes | Limited | Yes | Archived | Yes |
| RBAC passthrough | Yes | Yes | Partial | Yes | Yes |

Headlamp's key differentiator is the plugin system combined with in-cluster deployment. Lens requires a desktop client. Octant is no longer actively maintained. Kubernetes Dashboard lacks extensibility. Headlamp provides the combination of a browser-based UI, RBAC passthrough (users see only what their Kubernetes RBAC allows), and an extensible plugin architecture suitable for internal developer platforms.

## Section 2: In-Cluster Helm Deployment

### Add Repository and Install

```bash
# Add the Headlamp Helm repository
helm repo add headlamp https://headlamp-k8s.github.io/headlamp/
helm repo update

# Create namespace
kubectl create namespace headlamp

# Install with production values
helm install headlamp headlamp/headlamp \
  --namespace headlamp \
  --version 0.25.0 \
  --values headlamp-values.yaml
```

### Production Helm Values

```yaml
# headlamp-values.yaml
replicaCount: 2

image:
  repository: ghcr.io/headlamp-k8s/headlamp
  tag: v0.25.0
  pullPolicy: IfNotPresent

config:
  # Base URL if running behind a path prefix
  baseURL: ""
  # Plugin directory inside the container
  pluginsDir: /headlamp/plugins
  # In-cluster mode — disable token-based authentication,
  # rely on OIDC instead
  oidc:
    clientID: headlamp
    clientSecret: EXAMPLE_OIDC_SECRET_REPLACE_ME
    issuerURL: https://dex.platform.example.com
    scopes: openid,email,groups
    # Map OIDC groups to Kubernetes RBAC groups
    usernameClaim: email
    groupsClaim: groups

ingress:
  enabled: true
  ingressClassName: nginx
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"
    cert-manager.io/cluster-issuer: letsencrypt-prod
  hosts:
    - host: headlamp.platform.example.com
      paths:
        - path: /
          type: Prefix
  tls:
    - secretName: headlamp-tls
      hosts:
        - headlamp.platform.example.com

resources:
  limits:
    cpu: 500m
    memory: 512Mi
  requests:
    cpu: 100m
    memory: 256Mi

podSecurityContext:
  runAsNonRoot: true
  runAsUser: 101
  fsGroup: 101

securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop:
      - ALL

# Persist plugin installations
persistentVolumeClaim:
  enabled: true
  accessModes:
    - ReadWriteOnce
  size: 1Gi
  storageClassName: standard

serviceAccount:
  create: true
  name: headlamp

# Health check configuration
livenessProbe:
  httpGet:
    path: /healthz
    port: 4466
  initialDelaySeconds: 30
  periodSeconds: 30

readinessProbe:
  httpGet:
    path: /healthz
    port: 4466
  initialDelaySeconds: 10
  periodSeconds: 10

# Pod Disruption Budget for HA
podDisruptionBudget:
  enabled: true
  minAvailable: 1

# Anti-affinity for spreading across nodes
affinity:
  podAntiAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          labelSelector:
            matchLabels:
              app.kubernetes.io/name: headlamp
          topologyKey: kubernetes.io/hostname
```

## Section 3: RBAC Configuration

Headlamp uses RBAC passthrough — it authenticates users via OIDC and then uses their Kubernetes identity for all API calls. The user sees only resources their Kubernetes RBAC allows.

### Read-Only Role for Developers

```yaml
# headlamp-readonly-role.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: headlamp-readonly
  labels:
    app.kubernetes.io/name: headlamp
    rbac.example.com/managed-by: platform-team
rules:
  # Core resources — read only
  - apiGroups: [""]
    resources:
      - pods
      - pods/log
      - services
      - endpoints
      - persistentvolumeclaims
      - configmaps
      - events
      - namespaces
      - nodes
      - replicationcontrollers
      - resourcequotas
      - serviceaccounts
    verbs: ["get", "list", "watch"]
  # Apps resources — read only
  - apiGroups: ["apps"]
    resources:
      - deployments
      - replicasets
      - statefulsets
      - daemonsets
    verbs: ["get", "list", "watch"]
  # Batch
  - apiGroups: ["batch"]
    resources:
      - jobs
      - cronjobs
    verbs: ["get", "list", "watch"]
  # Networking
  - apiGroups: ["networking.k8s.io"]
    resources:
      - ingresses
      - networkpolicies
    verbs: ["get", "list", "watch"]
  # Autoscaling
  - apiGroups: ["autoscaling"]
    resources:
      - horizontalpodautoscalers
    verbs: ["get", "list", "watch"]
  # Storage
  - apiGroups: ["storage.k8s.io"]
    resources:
      - storageclasses
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: headlamp-readonly-developers
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: headlamp-readonly
subjects:
  # Bind to the 'developers' OIDC group (mapped from Dex/Keycloak)
  - kind: Group
    name: developers
    apiGroup: rbac.authorization.k8s.io
```

### Developer Role (Namespace-Scoped Write Access)

```yaml
# headlamp-developer-role.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: headlamp-developer
  namespace: production
rules:
  # Pods: read + exec + log
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods/exec"]
    verbs: ["create"]
  # Deployments: read + scale + rollout restart
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "watch", "patch", "update"]
  - apiGroups: ["apps"]
    resources: ["deployments/scale"]
    verbs: ["get", "update", "patch"]
  # Services: read
  - apiGroups: [""]
    resources: ["services", "endpoints"]
    verbs: ["get", "list", "watch"]
  # ConfigMaps: read
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get", "list", "watch"]
  # Events: read
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: headlamp-developer-binding
  namespace: production
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: headlamp-developer
subjects:
  - kind: Group
    name: backend-team
    apiGroup: rbac.authorization.k8s.io
```

### Headlamp Service Account (Minimal Cluster-Level Permissions)

```yaml
# headlamp-serviceaccount-rbac.yaml
# The Headlamp server itself needs minimal permissions
# Individual user actions use their own OIDC-derived identity
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: headlamp-server
rules:
  # Required to read OIDC config and health checks
  - apiGroups: [""]
    resources: ["namespaces"]
    verbs: ["get", "list", "watch"]
  # Required for plugin ConfigMap storage
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]
    resourceNames: ["headlamp-plugins"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: headlamp-server-binding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: headlamp-server
subjects:
  - kind: ServiceAccount
    name: headlamp
    namespace: headlamp
```

## Section 4: OAuth2/OIDC SSO Configuration

### Dex OIDC Provider

```yaml
# dex-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: dex-config
  namespace: dex
data:
  config.yaml: |
    issuer: https://dex.platform.example.com

    storage:
      type: kubernetes
      config:
        inCluster: true

    web:
      http: 0.0.0.0:5556
      tlsCert: /etc/dex/tls/tls.crt
      tlsKey: /etc/dex/tls/tls.key

    connectors:
      - type: ldap
        name: Corporate LDAP
        id: ldap
        config:
          host: ldap.corp.example.com:636
          insecureNoSSL: false
          insecureSkipVerify: false
          bindDN: "cn=dex,ou=service-accounts,dc=corp,dc=example,dc=com"
          bindPW: EXAMPLE_LDAP_PASSWORD_REPLACE_ME
          userSearch:
            baseDN: "ou=users,dc=corp,dc=example,dc=com"
            filter: "(objectClass=person)"
            username: sAMAccountName
            idAttr: DN
            emailAttr: mail
            nameAttr: displayName
          groupSearch:
            baseDN: "ou=groups,dc=corp,dc=example,dc=com"
            filter: "(objectClass=group)"
            userMatchers:
              - userAttr: DN
                groupAttr: member
            nameAttr: cn

    staticClients:
      - id: headlamp
        redirectURIs:
          - https://headlamp.platform.example.com/oidc-callback
        name: Headlamp Kubernetes UI
        secret: EXAMPLE_OIDC_SECRET_REPLACE_ME

    oauth2:
      skipApprovalScreen: true
      responseTypes:
        - code
      grantTypes:
        - authorization_code
        - refresh_token

    expiry:
      idTokens: 24h
      signingKeys: 6h
      refreshTokens:
        validIfNotUsedFor: 168h  # 7 days
        absoluteLifetime: 720h  # 30 days
```

### Keycloak OIDC Configuration

For organizations using Keycloak:

```bash
# Create Headlamp client in Keycloak via CLI
/opt/jboss/keycloak/bin/kcadm.sh create clients \
  -r internal \
  -s clientId=headlamp \
  -s enabled=true \
  -s publicClient=false \
  -s "redirectUris=[\"https://headlamp.platform.example.com/oidc-callback\"]" \
  -s "webOrigins=[\"https://headlamp.platform.example.com\"]" \
  -s protocol=openid-connect \
  -s "attributes={\"access.token.lifespan\": \"86400\"}"

# Add group mapper to include groups in the token
/opt/jboss/keycloak/bin/kcadm.sh create \
  clients/<client-uuid>/protocol-mappers/models \
  -r internal \
  -s name=groups \
  -s protocol=openid-connect \
  -s protocolMapper=oidc-group-membership-mapper \
  -s "config={\"full.path\": \"false\", \"id.token.claim\": \"true\", \"access.token.claim\": \"true\", \"claim.name\": \"groups\", \"userinfo.token.claim\": \"true\"}"
```

Update Headlamp values to use Keycloak:

```yaml
# headlamp-keycloak-values.yaml (partial override)
config:
  oidc:
    clientID: headlamp
    clientSecret: EXAMPLE_OIDC_SECRET_REPLACE_ME
    issuerURL: https://keycloak.platform.example.com/realms/internal
    scopes: openid,email,groups,profile
    usernameClaim: preferred_username
    groupsClaim: groups
```

## Section 5: Multi-Cluster Management

Headlamp supports multiple clusters from a single installation using kubeconfig files mounted as secrets.

### Multi-Cluster ConfigMap Setup

```yaml
# headlamp-multicluster-values.yaml (partial override)
config:
  # Provide a kubeconfig with multiple cluster contexts
  kubeconfig: |
    apiVersion: v1
    kind: Config
    clusters:
      - name: production
        cluster:
          server: https://k8s-prod.example.com
          certificate-authority-data: <base64-encoded-CA-cert>
      - name: staging
        cluster:
          server: https://k8s-staging.example.com
          certificate-authority-data: <base64-encoded-CA-cert>
      - name: development
        cluster:
          server: https://k8s-dev.example.com
          certificate-authority-data: <base64-encoded-CA-cert>
    users:
      - name: headlamp-service-account
        user:
          token: EXAMPLE_TOKEN_REPLACE_ME
    contexts:
      - name: production
        context:
          cluster: production
          user: headlamp-service-account
      - name: staging
        context:
          cluster: staging
          user: headlamp-service-account
      - name: development
        context:
          cluster: development
          user: headlamp-service-account
    current-context: production
```

Store the kubeconfig as a Kubernetes Secret:

```bash
# Create the multi-cluster kubeconfig Secret
kubectl create secret generic headlamp-kubeconfig \
  --namespace headlamp \
  --from-file=config=/path/to/headlamp-multicluster.kubeconfig

# Reference it in Helm values
# extraEnv:
#   - name: KUBECONFIG
#     value: /headlamp/kubeconfig/config
# extraVolumes:
#   - name: kubeconfig
#     secret:
#       secretName: headlamp-kubeconfig
# extraVolumeMounts:
#   - name: kubeconfig
#     mountPath: /headlamp/kubeconfig
#     readOnly: true
```

## Section 6: Plugin Architecture

Headlamp plugins are React/TypeScript modules that run in the browser and extend the Headlamp UI. Plugins can:

- Add new sidebar navigation items and pages
- Add columns to resource list tables
- Add sections to resource detail pages
- Create entirely new views for CRDs
- Call the Kubernetes API directly

### Plugin Project Setup

```bash
# Create a new Headlamp plugin project
npx create-headlamp-plugin my-custom-plugin
cd my-custom-plugin

# Project structure:
# my-custom-plugin/
# ├── src/
# │   └── index.tsx          # Plugin entry point
# ├── package.json
# ├── tsconfig.json
# └── headlamp-plugin.json   # Plugin metadata

# Install dependencies
npm install

# Start development server against a local Headlamp instance
npm run start
```

Plugin metadata file:

```json
{
  "name": "my-custom-plugin",
  "description": "Custom CRD viewer and team annotations",
  "homepage": "https://platform.example.com/headlamp-plugins/my-custom-plugin",
  "version": "1.0.0",
  "author": "Platform Team <platform@example.com>"
}
```

## Section 7: Building a Custom CRD Viewer Plugin

This plugin adds a dedicated view for a custom `Application` CRD used by the platform team.

```typescript
// src/index.tsx
import {
  registerRoute,
  registerSidebarEntry,
  K8s,
  SectionBox,
  SimpleTable,
  StatusLabel,
} from '@kinvolk/headlamp-plugin/lib';
import React from 'react';

// Register a sidebar navigation entry under "Platform" section
registerSidebarEntry({
  parent: null,
  name: 'platform',
  label: 'Platform',
  icon: 'mdi:layers-triple',
});

registerSidebarEntry({
  parent: 'platform',
  name: 'applications',
  label: 'Applications',
  url: '/applications',
  icon: 'mdi:application',
});

// Register the route for the Applications list page
registerRoute({
  path: '/applications',
  exact: true,
  name: 'Applications',
  component: () => <ApplicationList />,
  sidebar: 'applications',
});

// Register route for individual Application detail page
registerRoute({
  path: '/applications/:namespace/:name',
  exact: true,
  name: 'Application Detail',
  component: () => <ApplicationDetail />,
  sidebar: 'applications',
});

// ApplicationList component: lists all Application CRDs
function ApplicationList() {
  // Use the generic CRD resource hook
  const [applications, applicationsError] = K8s.ResourceClasses.CustomResourceDefinition
    ? K8s.useKubeObjectList({
        apiVersion: 'platform.example.com/v1alpha1',
        kind: 'Application',
      })
    : [null, null];

  const columns = [
    {
      label: 'Name',
      getter: (app: any) => app.metadata.name,
    },
    {
      label: 'Namespace',
      getter: (app: any) => app.metadata.namespace,
    },
    {
      label: 'Status',
      getter: (app: any) => {
        const phase = app.status?.phase || 'Unknown';
        const statusMap: Record<string, 'success' | 'error' | 'warning'> = {
          Running: 'success',
          Failed: 'error',
          Pending: 'warning',
          Unknown: 'warning',
        };
        return (
          <StatusLabel status={statusMap[phase] || 'warning'}>
            {phase}
          </StatusLabel>
        );
      },
    },
    {
      label: 'Version',
      getter: (app: any) => app.spec?.version || '—',
    },
    {
      label: 'Team',
      getter: (app: any) => app.metadata.labels?.['platform.example.com/team'] || '—',
    },
    {
      label: 'Last Deployed',
      getter: (app: any) => {
        const ts = app.status?.lastDeployedAt;
        return ts ? new Date(ts).toLocaleString() : '—';
      },
    },
  ];

  if (applicationsError) {
    return <div>Error loading applications: {applicationsError.message}</div>;
  }

  return (
    <SectionBox title="Platform Applications">
      <SimpleTable
        columns={columns}
        data={applications || []}
        rowsPerPage={[25, 50, 100]}
      />
    </SectionBox>
  );
}

// ApplicationDetail component: shows CRD detail view
function ApplicationDetail() {
  const { name, namespace } = (window as any).__routeParams || {};

  const [application, applicationError] = K8s.useKubeObject({
    apiVersion: 'platform.example.com/v1alpha1',
    kind: 'Application',
    name,
    namespace,
  });

  if (applicationError) {
    return <div>Error: {applicationError.message}</div>;
  }

  if (!application) {
    return <div>Loading...</div>;
  }

  return (
    <div>
      <SectionBox title={`Application: ${application.metadata.name}`}>
        <SimpleTable
          columns={[
            { label: 'Field', getter: (item: any) => item.key },
            { label: 'Value', getter: (item: any) => item.value },
          ]}
          data={[
            { key: 'SPIFFE ID', value: application.status?.spiffeID || '—' },
            { key: 'Docker Image', value: application.spec?.image || '—' },
            { key: 'Replicas', value: `${application.status?.readyReplicas || 0} / ${application.spec?.replicas || 0}` },
            { key: 'Ingress URL', value: application.status?.ingressURL || '—' },
            { key: 'Health Score', value: application.status?.healthScore ? `${application.status.healthScore}%` : '—' },
          ]}
        />
      </SectionBox>
    </div>
  );
}
```

### Building and Packaging the Plugin

```bash
# Build the plugin for production
npm run build

# The build outputs to dist/
# Package as a tarball for the plugin registry
tar -czf my-custom-plugin-1.0.0.tgz -C dist .

# Alternatively, publish to an OCI registry
crane push dist/ registry.example.com/headlamp-plugins/my-custom-plugin:1.0.0
```

## Section 8: Plugin Registry Deployment

Headlamp supports loading plugins from a local HTTP server or OCI registry, enabling centralized plugin management.

```yaml
# plugin-registry-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: headlamp-plugin-registry
  namespace: headlamp
spec:
  replicas: 2
  selector:
    matchLabels:
      app: headlamp-plugin-registry
  template:
    metadata:
      labels:
        app: headlamp-plugin-registry
    spec:
      containers:
        - name: nginx
          image: nginx:1.27-alpine
          ports:
            - containerPort: 80
          volumeMounts:
            - name: plugins
              mountPath: /usr/share/nginx/html/plugins
            - name: nginx-config
              mountPath: /etc/nginx/conf.d
          resources:
            limits:
              cpu: 200m
              memory: 128Mi
            requests:
              cpu: 50m
              memory: 64Mi
      volumes:
        - name: plugins
          persistentVolumeClaim:
            claimName: headlamp-plugins-pvc
        - name: nginx-config
          configMap:
            name: plugin-registry-nginx-config
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: plugin-registry-nginx-config
  namespace: headlamp
data:
  default.conf: |
    server {
        listen 80;
        server_name _;
        root /usr/share/nginx/html;

        # Enable CORS for Headlamp to load plugins
        add_header Access-Control-Allow-Origin "https://headlamp.platform.example.com" always;
        add_header Access-Control-Allow-Methods "GET, OPTIONS" always;
        add_header Cache-Control "max-age=3600";

        location /plugins/ {
            autoindex on;
            autoindex_format json;
        }

        location /health {
            return 200 "ok\n";
            add_header Content-Type text/plain;
        }
    }
---
apiVersion: v1
kind: Service
metadata:
  name: headlamp-plugin-registry
  namespace: headlamp
spec:
  selector:
    app: headlamp-plugin-registry
  ports:
    - port: 80
      targetPort: 80
```

Configure Headlamp to load plugins from the registry:

```yaml
# headlamp-values-with-plugins.yaml (partial override)
config:
  # Plugin discovery URLs
  pluginsDir: /headlamp/plugins

extraEnv:
  - name: HEADLAMP_PLUGIN_URLS
    value: "http://headlamp-plugin-registry.headlamp.svc.cluster.local/plugins/my-custom-plugin-1.0.0.tgz,http://headlamp-plugin-registry.headlamp.svc.cluster.local/plugins/platform-tools-2.1.0.tgz"
```

## Section 9: Desktop App for Local Development

Headlamp provides an Electron-based desktop application for local development that reads the standard `~/.kube/config` file.

```bash
# macOS installation via Homebrew
brew install headlamp

# Linux installation
curl -Lo headlamp.AppImage https://github.com/headlamp-k8s/headlamp/releases/download/v0.25.0/Headlamp-0.25.0.AppImage
chmod +x headlamp.AppImage
./headlamp.AppImage

# Windows: download from GitHub Releases
# https://github.com/headlamp-k8s/headlamp/releases/download/v0.25.0/Headlamp-0.25.0-win-x64.exe
```

Desktop-specific plugin installation:

```bash
# On Linux: plugins go in ~/.config/Headlamp/plugins/
mkdir -p ~/.config/Headlamp/plugins/my-custom-plugin
cp -r ./dist/* ~/.config/Headlamp/plugins/my-custom-plugin/

# On macOS: ~/Library/Application Support/Headlamp/plugins/
mkdir -p ~/Library/Application\ Support/Headlamp/plugins/my-custom-plugin
cp -r ./dist/* ~/Library/Application\ Support/Headlamp/plugins/my-custom-plugin/

# On Windows: %APPDATA%\Headlamp\plugins\
```

## Section 10: Custom Resource Definition Support

Headlamp automatically discovers and displays CRDs. Additional configuration enables richer views.

### CRD Table Column Annotations

Headlamp respects the `additionalPrinterColumns` field in CRDs, displaying them as columns in the resource list:

```yaml
# example-application-crd.yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: applications.platform.example.com
spec:
  group: platform.example.com
  names:
    kind: Application
    listKind: ApplicationList
    plural: applications
    singular: application
    shortNames:
      - app
  scope: Namespaced
  versions:
    - name: v1alpha1
      served: true
      storage: true
      additionalPrinterColumns:
        # Headlamp displays these as columns in the CRD list view
        - name: Status
          type: string
          jsonPath: .status.phase
          description: Current phase of the application
        - name: Version
          type: string
          jsonPath: .spec.version
        - name: Replicas
          type: integer
          jsonPath: .status.readyReplicas
        - name: Age
          type: date
          jsonPath: .metadata.creationTimestamp
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                image:
                  type: string
                  description: Container image for the application
                version:
                  type: string
                  description: Application version tag
                replicas:
                  type: integer
                  minimum: 0
                  maximum: 100
            status:
              type: object
              properties:
                phase:
                  type: string
                  enum: [Pending, Running, Failed, Succeeded]
                readyReplicas:
                  type: integer
                ingressURL:
                  type: string
                lastDeployedAt:
                  type: string
                  format: date-time
```

## Section 11: Monitoring Headlamp

### Prometheus ServiceMonitor

```yaml
# headlamp-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: headlamp
  namespace: monitoring
  labels:
    release: prometheus
spec:
  namespaceSelector:
    matchNames:
      - headlamp
  selector:
    matchLabels:
      app.kubernetes.io/name: headlamp
  endpoints:
    - port: http
      interval: 30s
      path: /metrics
      scheme: http
```

### Key Metrics

```promql
# Headlamp request rate
rate(headlamp_http_requests_total[5m])

# Error rate
rate(headlamp_http_requests_total{code=~"5.."}[5m])
/
rate(headlamp_http_requests_total[5m])

# Active user sessions
headlamp_active_sessions

# Kubernetes API proxy latency (99th percentile)
histogram_quantile(0.99,
  rate(headlamp_kubernetes_request_duration_seconds_bucket[5m])
)
```

## Section 12: Network Policy for Headlamp

```yaml
# headlamp-networkpolicy.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: headlamp
  namespace: headlamp
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: headlamp
  policyTypes:
    - Ingress
    - Egress
  ingress:
    # Allow ingress from NGINX ingress controller
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ingress-nginx
      ports:
        - port: 4466
  egress:
    # Allow access to Kubernetes API server
    - ports:
        - port: 443
          protocol: TCP
    # Allow access to Dex OIDC provider
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: dex
      ports:
        - port: 5556
    # Allow access to plugin registry
    - to:
        - podSelector:
            matchLabels:
              app: headlamp-plugin-registry
      ports:
        - port: 80
    # Allow DNS resolution
    - ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
```

## Section 13: Upgrading Headlamp

```bash
# Check current version
helm list -n headlamp

# Pull latest chart values for review
helm show values headlamp/headlamp --version 0.26.0 > headlamp-new-values.yaml

# Diff against current values
diff headlamp-values.yaml headlamp-new-values.yaml

# Dry run upgrade
helm upgrade headlamp headlamp/headlamp \
  --namespace headlamp \
  --version 0.26.0 \
  --values headlamp-values.yaml \
  --dry-run

# Perform upgrade with rollback on failure
helm upgrade headlamp headlamp/headlamp \
  --namespace headlamp \
  --version 0.26.0 \
  --values headlamp-values.yaml \
  --atomic \
  --timeout 5m \
  --cleanup-on-fail

# Verify upgrade
kubectl rollout status deployment/headlamp -n headlamp
```

## Section 14: Production Recommendations

**RBAC Tightening:** Avoid granting `cluster-admin` or broad `ClusterRole` bindings through Headlamp. Configure OIDC group mappings carefully so that each team sees only the namespaces relevant to their work. The passthrough RBAC model means Headlamp is only as dangerous as the Kubernetes RBAC configuration behind it.

**Plugin Security:** Plugins run in the user's browser with the same Kubernetes credentials as the user's session. Vet all third-party plugins before deploying them to the plugin registry. Internal plugins should be reviewed through the same process as application code.

**Session Timeout:** Configure the OIDC provider to enforce reasonable session lifetimes (8 hours for regular work, 1 hour for privileged contexts). The default Dex configuration shown above uses 24-hour token lifetimes which may be too long for production cluster access.

**Read-Only by Default:** Apply the principle of least privilege — start all users with the `headlamp-readonly` ClusterRole. Grant write access only to specific namespaces and only when the business case is clear. The Kubernetes audit log provides full accountability for actions taken through the UI.

**Ingress Authentication Layering:** For additional defense in depth, add `nginx.ingress.kubernetes.io/auth-url` annotations to require authentication at the NGINX ingress layer before requests reach Headlamp, even if the OIDC configuration in Headlamp itself has issues.
