---
title: "Keycloak on Kubernetes: Enterprise SSO and Identity Federation"
date: 2027-11-01T00:00:00-05:00
draft: false
tags: ["Keycloak", "SSO", "OIDC", "Kubernetes", "Identity"]
categories:
- Security
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Keycloak HA deployment on Kubernetes, realm configuration, OIDC client setup, LDAP federation, custom themes, Kubernetes Keycloak operator, integration with Kubernetes RBAC via OIDC, and production hardening."
more_link: "yes"
url: "/keycloak-kubernetes-sso-guide/"
---

Keycloak is the leading open-source identity and access management solution for enterprise environments. Running it on Kubernetes with high availability, proper database backing, and integration into Kubernetes RBAC via OIDC creates a unified identity plane that covers both user applications and cluster access. This guide covers the full production deployment lifecycle.

<!--more-->

# Keycloak on Kubernetes: Enterprise SSO and Identity Federation

## Architecture Overview

A production Keycloak deployment on Kubernetes consists of:

- **Keycloak Pods**: The application servers, running in HA mode with multiple replicas
- **PostgreSQL Database**: Persistent storage for realm configurations, user data, and sessions
- **Infinispan/JGroups Clustering**: Session replication between Keycloak pods
- **Ingress**: TLS termination and routing
- **Keycloak Operator**: Manages the lifecycle of Keycloak instances via CRDs (optional but recommended)

## Installing via Keycloak Operator

The Keycloak Operator provides a Kubernetes-native management interface for Keycloak:

```bash
# Install the Keycloak Operator
kubectl apply -f https://raw.githubusercontent.com/keycloak/keycloak-k8s-resources/25.0.6/kubernetes/keycloaks.k8s.keycloak.org-v1.yml
kubectl apply -f https://raw.githubusercontent.com/keycloak/keycloak-k8s-resources/25.0.6/kubernetes/keycloakrealmimports.k8s.keycloak.org-v1.yml
kubectl apply -f https://raw.githubusercontent.com/keycloak/keycloak-k8s-resources/25.0.6/kubernetes/kubernetes.yml
```

### PostgreSQL Setup

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: keycloak-db-secret
  namespace: keycloak
type: Opaque
stringData:
  username: keycloak
  password: keycloak-db-password-here
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgresql-keycloak
  namespace: keycloak
spec:
  serviceName: postgresql-keycloak
  replicas: 1
  selector:
    matchLabels:
      app: postgresql-keycloak
  template:
    metadata:
      labels:
        app: postgresql-keycloak
    spec:
      containers:
      - name: postgresql
        image: postgres:16-alpine
        env:
        - name: POSTGRES_DB
          value: keycloak
        - name: POSTGRES_USER
          valueFrom:
            secretKeyRef:
              name: keycloak-db-secret
              key: username
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: keycloak-db-secret
              key: password
        - name: PGDATA
          value: /var/lib/postgresql/data/pgdata
        ports:
        - containerPort: 5432
          name: postgres
        volumeMounts:
        - name: postgres-data
          mountPath: /var/lib/postgresql/data
        resources:
          requests:
            cpu: 500m
            memory: 1Gi
          limits:
            cpu: 2000m
            memory: 4Gi
        livenessProbe:
          exec:
            command:
            - pg_isready
            - -U
            - keycloak
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          exec:
            command:
            - pg_isready
            - -U
            - keycloak
          initialDelaySeconds: 5
          periodSeconds: 5
  volumeClaimTemplates:
  - metadata:
      name: postgres-data
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: fast-ssd
      resources:
        requests:
          storage: 50Gi
---
apiVersion: v1
kind: Service
metadata:
  name: postgresql-keycloak
  namespace: keycloak
spec:
  selector:
    app: postgresql-keycloak
  ports:
  - port: 5432
    targetPort: 5432
```

### Keycloak Instance via Operator

```yaml
apiVersion: k8s.keycloak.org/v2alpha1
kind: Keycloak
metadata:
  name: keycloak
  namespace: keycloak
spec:
  instances: 3
  image: quay.io/keycloak/keycloak:25.0.6
  startOptimized: false

  # HTTP configuration
  http:
    httpEnabled: false
    httpsPort: 8443

  # Hostname configuration
  hostname:
    hostname: sso.company.com
    strict: true
    strictBackchannel: false

  # Database configuration
  db:
    vendor: postgres
    host: postgresql-keycloak.keycloak.svc.cluster.local
    port: 5432
    database: keycloak
    usernameSecret:
      name: keycloak-db-secret
      key: username
    passwordSecret:
      name: keycloak-db-secret
      key: password

  # TLS configuration
  tlsSecret: keycloak-tls-secret

  # Additional options
  additionalOptions:
  - name: log-level
    value: INFO
  - name: cache
    value: ispn
  - name: cache-stack
    value: kubernetes
  - name: http-max-queued-requests
    value: "1000"
  - name: proxy
    value: edge
  # JVM heap settings for production
  - name: JAVA_OPTS_APPEND
    value: "-Xms512m -Xmx2048m -XX:MetaspaceSize=96M -XX:MaxMetaspaceSize=256m"

  # Resource requirements
  resources:
    requests:
      cpu: "500m"
      memory: "1Gi"
    limits:
      cpu: "2"
      memory: "3Gi"

  # Ingress configuration
  ingress:
    enabled: false
```

### TLS Secret for Keycloak

```bash
# Generate TLS secret from existing certificate
kubectl create secret tls keycloak-tls-secret \
  --cert=sso.company.com.crt \
  --key=sso.company.com.key \
  -n keycloak

# Or create from cert-manager Certificate resource
```

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: keycloak-tls
  namespace: keycloak
spec:
  secretName: keycloak-tls-secret
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  dnsNames:
  - sso.company.com
  duration: 2160h
  renewBefore: 360h
```

### Ingress

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: keycloak
  namespace: keycloak
  annotations:
    nginx.ingress.kubernetes.io/proxy-buffer-size: "128k"
    nginx.ingress.kubernetes.io/proxy-buffers-number: "4"
    nginx.ingress.kubernetes.io/proxy-body-size: "100m"
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/backend-protocol: "HTTPS"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - sso.company.com
    secretName: keycloak-ingress-tls
  rules:
  - host: sso.company.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: keycloak-service
            port:
              number: 8443
```

## Realm Configuration via KeycloakRealmImport

The Keycloak Operator supports importing realm configurations as Kubernetes resources:

```yaml
apiVersion: k8s.keycloak.org/v2alpha1
kind: KeycloakRealmImport
metadata:
  name: company-realm
  namespace: keycloak
spec:
  keycloakCRName: keycloak
  realm:
    realm: company
    displayName: Company SSO
    displayNameHtml: "<b>Company</b> SSO"
    enabled: true
    loginTheme: company-theme
    accountTheme: company-theme
    emailTheme: company-theme
    internationalizationEnabled: true
    supportedLocales:
    - en
    defaultLocale: en

    # Token settings
    accessTokenLifespan: 300
    accessTokenLifespanForImplicitFlow: 900
    ssoSessionIdleTimeout: 1800
    ssoSessionMaxLifespan: 36000

    # Security settings
    bruteForceProtected: true
    failureFactor: 5
    waitIncrementSeconds: 60
    maxFailureWaitSeconds: 900
    minimumQuickLoginWaitSeconds: 60
    quickLoginCheckMilliSeconds: 1000

    # Password policy
    passwordPolicy: "length(12) and upperCase(1) and lowerCase(1) and specialChars(1) and digits(1) and notUsername(undefined) and passwordHistory(5)"

    # Email configuration
    smtpServer:
      host: smtp.company.com
      port: "587"
      from: noreply@company.com
      fromDisplayName: Company SSO
      auth: "true"
      starttls: "true"
      user: smtp-user@company.com
      password: smtp-password

    # Roles
    roles:
      realm:
      - name: platform-admin
        description: Platform administrators
      - name: developer
        description: Application developers
      - name: viewer
        description: Read-only viewers

    # Groups
    groups:
    - name: platform-admins
      realmRoles:
      - platform-admin
    - name: developers
      realmRoles:
      - developer
    - name: viewers
      realmRoles:
      - viewer

    # OIDC clients
    clients:
    - clientId: kubernetes
      name: Kubernetes
      description: Kubernetes cluster API access
      enabled: true
      clientAuthenticatorType: client-secret
      secret: kubernetes-oidc-secret-here
      redirectUris:
      - https://kubectl.company.com/callback
      - http://localhost:8000/callback
      webOrigins:
      - https://kubectl.company.com
      standardFlowEnabled: true
      implicitFlowEnabled: false
      directAccessGrantsEnabled: false
      serviceAccountsEnabled: false
      protocol: openid-connect
      attributes:
        access.token.lifespan: "300"
      protocolMappers:
      - name: groups
        protocol: openid-connect
        protocolMapper: oidc-group-membership-mapper
        config:
          full.path: "false"
          id.token.claim: "true"
          access.token.claim: "true"
          claim.name: groups
          userinfo.token.claim: "true"

    - clientId: grafana
      name: Grafana
      description: Grafana dashboard SSO
      enabled: true
      clientAuthenticatorType: client-secret
      secret: grafana-oidc-secret-here
      redirectUris:
      - https://grafana.company.com/login/generic_oauth
      webOrigins:
      - https://grafana.company.com
      standardFlowEnabled: true
      implicitFlowEnabled: false
      directAccessGrantsEnabled: false
      protocol: openid-connect
      protocolMappers:
      - name: roles
        protocol: openid-connect
        protocolMapper: oidc-user-realm-role-mapper
        config:
          id.token.claim: "true"
          access.token.claim: "true"
          claim.name: roles
          jsonType.label: String
          multivalued: "true"
          userinfo.token.claim: "true"
```

## LDAP Federation

For organizations with an existing Active Directory or LDAP directory:

```yaml
# LDAP user federation configuration as part of KeycloakRealmImport
    userFederationProviders:
    - displayName: Company Active Directory
      providerName: ldap
      config:
        enabled:
        - "true"
        priority:
        - "0"
        importEnabled:
        - "true"
        editMode:
        - READ_ONLY
        syncRegistrations:
        - "false"
        vendor:
        - ad
        usernameLDAPAttribute:
        - sAMAccountName
        rdnLDAPAttribute:
        - cn
        uuidLDAPAttribute:
        - objectGUID
        userObjectClasses:
        - person, organizationalPerson, user
        connectionUrl:
        - ldaps://ad.company.com:636
        usersDn:
        - OU=Users,DC=company,DC=com
        authType:
        - simple
        bindDn:
        - CN=keycloak-bind,OU=Service Accounts,DC=company,DC=com
        bindCredential:
        - ldap-bind-password-here
        searchScope:
        - "2"
        useTruststoreSpi:
        - ldapsOnly
        connectionPooling:
        - "true"
        pagination:
        - "true"
        allowKerberosAuthentication:
        - "false"
        debug:
        - "false"
        useKerberosForPasswordAuthentication:
        - "false"
        fullSyncPeriod:
        - "86400"
        changedSyncPeriod:
        - "900"
```

## Kubernetes RBAC Integration via OIDC

Configure the Kubernetes API server to trust Keycloak as an OIDC provider. This allows users to authenticate to the cluster using their Keycloak credentials:

### API Server OIDC Configuration

For kubeadm-managed clusters, modify the API server configuration:

```yaml
apiVersion: kubeadm.k8s.io/v1beta3
kind: ClusterConfiguration
apiServer:
  extraArgs:
    oidc-issuer-url: "https://sso.company.com/realms/company"
    oidc-client-id: "kubernetes"
    oidc-username-claim: "preferred_username"
    oidc-username-prefix: "oidc:"
    oidc-groups-claim: "groups"
    oidc-groups-prefix: "oidc:"
    oidc-ca-file: "/etc/kubernetes/pki/oidc-ca.crt"
```

For EKS, configure the OIDC identity provider in the cluster:

```bash
aws eks associate-identity-provider-config \
  --cluster-name production-cluster \
  --oidc \
  clientId=kubernetes,\
  groupsClaim=groups,\
  groupsPrefix="oidc:",\
  issuerUrl="https://sso.company.com/realms/company",\
  requiredClaims="",\
  usernameClaim=preferred_username,\
  usernamePrefix="oidc:"
```

### RBAC Bindings for OIDC Groups

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: oidc-platform-admins
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin
subjects:
- kind: Group
  name: "oidc:platform-admins"
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: oidc-developers-view
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: view
subjects:
- kind: Group
  name: "oidc:developers"
  apiGroup: rbac.authorization.k8s.io
---
# Namespace-specific developer access
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: oidc-developers-edit
  namespace: production
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: edit
subjects:
- kind: Group
  name: "oidc:developers"
  apiGroup: rbac.authorization.k8s.io
```

### Kubelogin for kubectl Authentication

Install and configure kubelogin to handle the OIDC authentication flow for kubectl:

```bash
# Install kubelogin
kubectl krew install oidc-login

# Configure kubectl to use Keycloak for authentication
kubectl config set-credentials oidc-user \
  --exec-api-version=client.authentication.k8s.io/v1beta1 \
  --exec-command=kubectl \
  --exec-arg=oidc-login \
  --exec-arg=get-token \
  --exec-arg=--oidc-issuer-url=https://sso.company.com/realms/company \
  --exec-arg=--oidc-client-id=kubernetes \
  --exec-arg=--oidc-client-secret=kubernetes-oidc-secret-here \
  --exec-arg=--oidc-extra-scope=groups \
  --exec-arg=--oidc-extra-scope=email

# Set context to use OIDC credentials
kubectl config set-context production \
  --cluster=production-cluster \
  --user=oidc-user
```

## Production Hardening

### Resource Limits and Anti-Affinity

```yaml
apiVersion: k8s.keycloak.org/v2alpha1
kind: Keycloak
metadata:
  name: keycloak
  namespace: keycloak
spec:
  instances: 3
  resources:
    requests:
      cpu: "500m"
      memory: "1Gi"
    limits:
      cpu: "2"
      memory: "3Gi"
  unsupported:
    podTemplate:
      spec:
        affinity:
          podAntiAffinity:
            requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: keycloak
              topologyKey: kubernetes.io/hostname
          nodeAffinity:
            preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 1
              preference:
                matchExpressions:
                - key: node-role
                  operator: In
                  values:
                  - identity-services
        topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: keycloak
```

### PodDisruptionBudget

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: keycloak-pdb
  namespace: keycloak
spec:
  selector:
    matchLabels:
      app: keycloak
  minAvailable: 2
```

### Network Policy

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: keycloak-network-policy
  namespace: keycloak
spec:
  podSelector:
    matchLabels:
      app: keycloak
  policyTypes:
  - Ingress
  - Egress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: ingress-nginx
    ports:
    - port: 8443
      protocol: TCP
  # Allow cluster members to communicate with each other for JGroups
  - from:
    - podSelector:
        matchLabels:
          app: keycloak
    ports:
    - port: 7800
      protocol: TCP
    - port: 57600
      protocol: TCP
  egress:
  # PostgreSQL
  - to:
    - podSelector:
        matchLabels:
          app: postgresql-keycloak
    ports:
    - port: 5432
      protocol: TCP
  # LDAP
  - to:
    - ipBlock:
        cidr: 10.0.0.0/8
    ports:
    - port: 636
      protocol: TCP
  # DNS
  - to:
    - namespaceSelector: {}
    ports:
    - port: 53
      protocol: UDP
    - port: 53
      protocol: TCP
  # SMTP
  - to:
    - ipBlock:
        cidr: 0.0.0.0/0
    ports:
    - port: 587
      protocol: TCP
```

## Monitoring Keycloak

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: keycloak
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
spec:
  selector:
    matchLabels:
      app: keycloak
  namespaceSelector:
    matchNames:
    - keycloak
  endpoints:
  - port: https
    scheme: https
    path: /realms/master/metrics
    tlsConfig:
      insecureSkipVerify: true
    bearerTokenSecret:
      name: keycloak-metrics-token
      key: token
    interval: 30s
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: keycloak-alerts
  namespace: monitoring
spec:
  groups:
  - name: keycloak
    rules:
    - alert: KeycloakHighLoginFailureRate
      expr: |
        rate(keycloak_failed_login_attempts_total[5m]) > 10
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "High Keycloak login failure rate in realm {{ $labels.realm }}"
        description: "More than 10 failed login attempts per second in realm {{ $labels.realm }}. Possible brute force attack."

    - alert: KeycloakInstanceDown
      expr: |
        absent(up{job="keycloak"}) or up{job="keycloak"} == 0
      for: 2m
      labels:
        severity: critical
      annotations:
        summary: "Keycloak instance is down"
        description: "Keycloak SSO is not available. All OIDC-authenticated services will be affected."

    - alert: KeycloakSessionPoolExhausted
      expr: |
        keycloak_sessions > 10000
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Keycloak session count very high"
        description: "Keycloak has {{ $value }} active sessions, approaching resource limits."
```

## Backup and Recovery

```bash
#!/bin/bash
# keycloak-backup.sh - Export realm configurations

KEYCLOAK_POD=$(kubectl get pods -n keycloak -l app=keycloak -o jsonpath='{.items[0].metadata.name}')
BACKUP_DATE=$(date +%Y%m%d-%H%M%S)
BACKUP_PATH="/tmp/keycloak-backup-${BACKUP_DATE}"

# Export all realms
kubectl exec -n keycloak "$KEYCLOAK_POD" -- \
  /opt/keycloak/bin/kc.sh export \
  --dir="${BACKUP_PATH}" \
  --realm=company \
  --users=realm_file

# Copy backup out of pod
kubectl cp "keycloak/${KEYCLOAK_POD}:${BACKUP_PATH}" "./backups/keycloak-${BACKUP_DATE}"

# Upload to S3
aws s3 sync "./backups/keycloak-${BACKUP_DATE}" \
  "s3://company-backups/keycloak/${BACKUP_DATE}/"

echo "Backup completed: s3://company-backups/keycloak/${BACKUP_DATE}/"
```

## Conclusion

A properly configured Keycloak deployment on Kubernetes provides a robust foundation for enterprise SSO that covers both user-facing applications and Kubernetes cluster access. The combination of the Keycloak Operator for lifecycle management, PostgreSQL for persistence, OIDC integration for Kubernetes RBAC, and LDAP federation for existing user directories creates a complete identity solution that scales from small teams to enterprise organizations.

The investment in proper configuration pays dividends in improved security posture (centralized authentication with MFA), reduced operational overhead (single place to manage user access), and better developer experience (single login for all company systems). Combined with Keycloak's audit logging and session management, you gain the visibility needed to meet compliance requirements for most regulatory frameworks.
