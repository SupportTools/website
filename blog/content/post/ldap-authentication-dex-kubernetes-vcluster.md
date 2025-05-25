---
title: "Implementing LDAP Authentication for Kubernetes with Dex and Vcluster"
date: 2027-01-26T09:00:00-05:00
draft: false
tags: ["Kubernetes", "Authentication", "LDAP", "Dex", "Vcluster", "OIDC", "K3s"]
categories:
- Kubernetes
- Security
- Authentication
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to implementing LDAP authentication for Kubernetes using Dex as an OIDC provider with vcluster, allowing seamless integration with existing directory services"
more_link: "yes"
url: "/ldap-authentication-dex-kubernetes-vcluster/"
---

In multi-tenant Kubernetes environments, connecting cluster authentication to your organization's existing identity management system is crucial. This guide shows how to implement LDAP authentication for Kubernetes using Dex as an OpenID Connect provider with vcluster.

<!--more-->

# [Introduction to LDAP Authentication for Kubernetes](#introduction)

When managing Kubernetes clusters for multiple teams or tenants, integrating with your organization's existing identity provider simplifies user management and enhances security. Rather than managing separate credentials for Kubernetes access, users can authenticate with their existing corporate credentials.

This guide demonstrates how to set up LDAP authentication for Kubernetes using:

- **Dex**: An identity service that uses OpenID Connect to authenticate users against various backend providers, including LDAP
- **Vcluster**: A virtual Kubernetes cluster running inside a namespace of a physical host cluster
- **Kubectl with kubelogin**: A kubectl plugin that provides OIDC authentication support

## [Architecture Overview](#architecture-overview)

Here's how the authentication flow works:

1. The user executes a kubectl command targeting the vcluster API server
2. The kubelogin plugin opens the user's browser to Dex's login page
3. The user enters their LDAP credentials
4. Dex validates these credentials against the LDAP server
5. Upon successful authentication, Dex issues a JWT token
6. Kubelogin captures this token and sends it to the Kubernetes API server
7. The API server validates the token using Dex's public key
8. If valid, the API server extracts user identity and group membership from the token
9. Kubernetes RBAC policies determine what resources the user can access

![Authentication Flow](/images/ldap-authentication-dex-kubernetes-vcluster/auth-flow.png)

# [Prerequisites](#prerequisites)

Before starting, ensure you have:

- A running Kubernetes cluster with vcluster installed
- Access to an LDAP server (e.g., Active Directory, OpenLDAP)
- Administrative access to the host Kubernetes cluster
- Basic understanding of TLS certificates
- Kubectl and the kubelogin plugin installed on your workstation

# [Setting Up TLS Certificates](#tls-certificates)

Since we're dealing with authentication, secure communication with TLS is essential. We'll need certificates for:

1. The Dex server
2. The vcluster API server

## [Creating a Certificate Authority (CA)](#certificate-authority)

First, let's create a simple CA for our demo environment:

```bash
# Create CA configuration file
cat > ca-config.conf << EOF
[req]
req_extensions = v3_req
distinguished_name = req_distinguished_name

[req_distinguished_name]

[ v3_req ]
basicConstraints = CA:TRUE
keyUsage = keyCertSign, cRLSign
subjectAltName = @alt_names

[alt_names]
DNS.1 = *.example.com
EOF

# Generate CA key
openssl genrsa -out ca.key 4096

# Generate CA certificate
openssl req -x509 -new -nodes -key ca.key -sha256 -days 1095 -out ca.pem \
  -subj "/CN=Kubernetes Demo CA" \
  -config ca-config.conf
```

## [Creating Server Certificates](#server-certificates)

Now, let's create certificates for the Dex server:

```bash
# Create certificate configuration
cat > server-cert-config.conf << EOF
[req]
req_extensions = v3_req
distinguished_name = req_distinguished_name

[req_distinguished_name]

[ v3_req ]
basicConstraints = CA:FALSE
keyUsage = nonRepudiation, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = dex.example.com
DNS.2 = vcluster-auth.example.com
EOF

# Generate server key
openssl genrsa -out server.key 2048

# Generate certificate signing request
openssl req -new -key server.key -out server.csr \
  -subj "/CN=dex.example.com" \
  -config server-cert-config.conf

# Sign the certificate with our CA
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key \
  -CAcreateserial -out server.pem -days 365 \
  -extensions v3_req -extfile server-cert-config.conf
```

For simplicity, we'll rename these files:
```bash
cp server.pem certificate.pem
cp server.key key.pem
cp ca.pem openid-ca.pem
```

# [Setting Up Dex on the Host Cluster](#dex-setup)

Dex will be deployed on the host cluster and shared across all vclusters.

## [Creating the Dex Namespace](#dex-namespace)

```bash
kubectl create namespace dex
```

## [Configuring Dex](#dex-config)

Create a ConfigMap for Dex configuration:

```yaml
kind: ConfigMap
apiVersion: v1
metadata:
  name: dex
  namespace: dex
data:
  config.yaml: |
    issuer: https://vcluster-auth.example.com
    storage:
      type: memory
    web:
      https: 0.0.0.0:5556
      tlsCert: /etc/dex/tls/certificate.pem
      tlsKey: /etc/dex/tls/key.pem
    
    connectors:
    - type: ldap
      name: Corporate LDAP
      id: ldap
      config:
        host: ldap.example.com:636
        insecureNoSSL: false
        insecureSkipVerify: true
        
        # LDAP bind credentials for directory access
        bindDN: cn=dex-service,ou=Service Accounts,dc=example,dc=com
        bindPW: SecurePassword123

        usernamePrompt: LDAP Username

        userSearch:
          baseDN: ou=Users,dc=example,dc=com
          filter: "(objectClass=person)"
          username: sAMAccountName
          idAttr: sAMAccountName
          emailAttr: mail
          nameAttr: displayName

        groupSearch:
          baseDN: ou=Groups,dc=example,dc=com
          filter: "(objectClass=group)"
          userMatchers:
          - userAttr: DN
            groupAttr: member
          nameAttr: cn
    
    staticClients:
    - id: kubernetes
      redirectURIs:
      - 'http://localhost:8000'
      name: 'Kubernetes'
      secret: aGVsbG9fdGhlcmUK  # base64 encoded "hello_there"
```

This configuration:
- Defines the OIDC issuer URL
- Configures in-memory storage (suitable for demos, use a database for production)
- Sets up LDAP connectivity with search parameters for users and groups
- Defines a static client for Kubernetes

## [Creating TLS Secrets for Dex](#dex-tls-secrets)

Create secrets for the TLS certificates:

```bash
# Create secret for Dex's TLS certificates
kubectl create secret generic dex-openid-certs \
  --from-file=certificate.pem=./certificate.pem \
  --from-file=key.pem=./key.pem \
  -n dex

# Create TLS secret for Ingress
kubectl create secret tls dex-openid-cert-tls \
  --cert=./certificate.pem \
  --key=./key.pem \
  -n dex
```

## [Deploying Dex](#dex-deployment)

Create the Dex deployment:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app: dex
  name: dex
  namespace: dex
spec:
  replicas: 1
  selector:
    matchLabels:
      app: dex
  template:
    metadata:
      labels:
        app: dex
    spec:
      serviceAccountName: dex
      containers:
      - image: ghcr.io/dexidp/dex:v2.35.3
        name: dex
        command: ["/usr/local/bin/dex", "serve", "/etc/dex/cfg/config.yaml"]
        ports:
        - name: https
          containerPort: 5556
        volumeMounts:
        - name: config
          mountPath: /etc/dex/cfg
        - name: dex-openid-certs
          mountPath: /etc/dex/tls
        resources:
          limits:
            cpu: 300m
            memory: 100Mi
          requests:
            cpu: 100m
            memory: 50Mi
        readinessProbe:
          httpGet:
            path: /healthz
            port: 5556
            scheme: HTTPS
      volumes:
      - name: config
        configMap:
          name: dex
          items:
          - key: config.yaml
            path: config.yaml
      - name: dex-openid-certs
        secret:
          secretName: dex-openid-certs
```

## [Creating Dex Service and RBAC](#dex-service-rbac)

Set up service and permissions for Dex:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: dex
  namespace: dex
spec:
  type: ClusterIP
  ports:
  - name: https
    port: 5556
    protocol: TCP
    targetPort: 5556
  selector:
    app: dex
---
apiVersion: v1
kind: ServiceAccount
metadata:
  labels:
    app: dex
  name: dex
  namespace: dex
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: dex
rules:
- apiGroups: ["dex.coreos.com"]
  resources: ["*"]
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

## [Exposing Dex with Ingress](#dex-ingress)

Create an Ingress resource to expose Dex:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: dex
  namespace: dex
  annotations:
    kubernetes.io/ingress.class: nginx
    nginx.ingress.kubernetes.io/proxy-buffer-size: "8k"
    nginx.ingress.kubernetes.io/backend-protocol: "HTTPS"
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  rules:
  - host: vcluster-auth.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: dex
            port:
              number: 5556
  tls:
  - hosts:
    - vcluster-auth.example.com
    secretName: dex-openid-cert-tls
```

Apply all these resources to deploy Dex:

```bash
kubectl apply -f dex-config.yaml
kubectl apply -f dex-deployment.yaml
kubectl apply -f dex-service-rbac.yaml
kubectl apply -f dex-ingress.yaml
```

# [Configuring Vcluster with OIDC](#vcluster-config)

Now we'll configure vcluster to use Dex for authentication.

## [Creating CA Secret for Vcluster](#vcluster-ca-secret)

First, create a secret containing the CA certificate:

```bash
kubectl create secret generic openid-ca \
  --from-file=openid-ca.pem=./openid-ca.pem \
  -n tenant-1
```

## [Configuring Vcluster for OIDC](#vcluster-oidc-config)

Create or update your vcluster values:

```yaml
vcluster:
  image: rancher/k3s:v1.24.8-k3s1
  command:
    - /bin/k3s
  extraArgs:
    - --service-cidr=10.96.0.0/16
    # OIDC Configuration
    - --kube-apiserver-arg=oidc-issuer-url=https://vcluster-auth.example.com
    - --kube-apiserver-arg=oidc-client-id=kubernetes
    - --kube-apiserver-arg=oidc-ca-file=/var/openid-ca.pem
    - --kube-apiserver-arg=oidc-username-claim=email
    - --kube-apiserver-arg=oidc-groups-claim=groups

  volumeMounts:
    - mountPath: /data
      name: data
    - mountPath: /var
      name: openid-ca
      readOnly: true

  resources:
    limits:
      memory: 2Gi
    requests:
      cpu: 200m
      memory: 256Mi

volumes:
  - name: openid-ca
    secret:
      secretName: openid-ca

# Additional vcluster configuration
sync:
  networkpolicies:
    enabled: true
  priorityclasses:
    enabled: false
  persistentvolumes:
    enabled: true
  legacy-storageclasses:
    enabled: true
  storageclasses:
    enabled: false
  fake-persistentvolumes:
    enabled: false
  nodes:
    enabled: false
    syncAllNodes: false

syncer:
  extraArgs:
  - --tls-san=tenant-1-vcluster.example.com
```

Key points in this configuration:
- `oidc-issuer-url`: Specifies Dex's OIDC endpoint
- `oidc-client-id`: Must match the client ID in Dex's config
- `oidc-ca-file`: Path to the CA certificate in the container
- `oidc-username-claim`: Specifies which claim to use for the Kubernetes username (email in this case)
- `oidc-groups-claim`: Specifies which claim to use for Kubernetes groups

## [Deploying Vcluster](#vcluster-deployment)

Install or upgrade your vcluster with this configuration:

```bash
helm upgrade --install tenant-1 vcluster \
  --values vcluster-values.yaml \
  --repo https://charts.loft.sh \
  --namespace tenant-1 \
  --repository-config=''
```

## [Exposing Vcluster API Server](#vcluster-ingress)

Create an Ingress for the vcluster API server:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: tenant-1-vcluster
  namespace: tenant-1
  annotations:
    kubernetes.io/ingress.class: nginx
    nginx.ingress.kubernetes.io/backend-protocol: "HTTPS"
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  rules:
  - host: tenant-1-vcluster.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: tenant-1
            port:
              number: 443
  tls:
  - hosts:
    - tenant-1-vcluster.example.com
    secretName: tenant-1-vcluster-tls
```

# [Creating Kubeconfig for OIDC Authentication](#kubeconfig)

Now we'll create a kubeconfig file for users to authenticate with LDAP via Dex:

```yaml
apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: BASE64_ENCODED_CA_CERTIFICATE
    server: https://tenant-1-vcluster.example.com
  name: tenant-1-vcluster
contexts:
- context:
    cluster: tenant-1-vcluster
    namespace: default
    user: oidc-user
  name: tenant-1-vcluster
current-context: tenant-1-vcluster
kind: Config
preferences: {}
users:
- name: oidc-user
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      args:
      - oidc-login
      - get-token
      - --oidc-issuer-url=https://vcluster-auth.example.com
      - --oidc-client-id=kubernetes
      - --oidc-client-secret=aGVsbG9fdGhlcmUK  # base64 encoded "hello_there"
      - --oidc-extra-scope=profile
      - --oidc-extra-scope=email
      - --oidc-extra-scope=groups
      - --certificate-authority-data=BASE64_ENCODED_CA_CERTIFICATE
      command: kubectl
      env: null
      interactiveMode: IfAvailable
      provideClusterInfo: false
```

Make sure to replace `BASE64_ENCODED_CA_CERTIFICATE` with the output of:

```bash
cat openid-ca.pem | base64 -w 0
```

# [Setting Up RBAC for LDAP Users and Groups](#rbac-setup)

Before users can access resources, we need to define RBAC rules. First, let's get admin access to the vcluster:

```bash
vcluster connect tenant-1 -n tenant-1 \
  --server=https://tenant-1-vcluster.example.com \
  --service-account admin \
  --cluster-role cluster-admin \
  --insecure
```

This generates a kubeconfig with admin permissions to the vcluster.

## [Creating RBAC for LDAP Groups](#rbac-groups)

Now, create RBAC rules for LDAP groups:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ldap-devops-team-admin
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin
subjects:
- apiGroup: rbac.authorization.k8s.io
  kind: Group
  name: DevOps-Team
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ldap-developers-edit
  namespace: dev
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: edit
subjects:
- apiGroup: rbac.authorization.k8s.io
  kind: Group
  name: Developers
```

Apply these RBAC rules:

```bash
kubectl apply -f rbac.yaml --kubeconfig ./kubeconfig-admin.yaml
```

# [Testing the Authentication Flow](#testing)

Now let's test the LDAP authentication flow:

```bash
kubectl get pods --kubeconfig ./kubeconfig-oidc.yaml
```

This should:
1. Prompt kubectl to run the kubelogin plugin
2. Open your browser to the Dex login page
3. Allow you to enter your LDAP credentials
4. Redirect back to kubectl with a valid token
5. Execute your command with your LDAP identity and group memberships

If you belong to the `DevOps-Team` group in LDAP, you should have cluster-admin permissions. If you belong to the `Developers` group, you should have edit permissions in the `dev` namespace.

# [Advanced Configurations](#advanced-configs)

## [Persistent Storage for Dex](#persistent-storage)

For production, replace the in-memory storage with a database:

```yaml
storage:
  type: postgresql
  config:
    host: postgresql.example.com
    port: 5432
    database: dex
    user: dex
    password: securepassword
    ssl:
      mode: verify-full
      caFile: /etc/dex/postgres/ca.crt
```

## [Multi-Factor Authentication](#mfa)

You can enable MFA by configuring Dex with additional authentication methods:

```yaml
enablePasswordDB: true
staticPasswords:
- email: "admin@example.com"
  hash: "$2a$10$2b2cU8CPhOTaGrs1HRQuAueS7JTT5ZHsHSzYiFPm1leZck7Mc8T4W" # bcrypt hash of password
  username: "admin"
  userID: "08a8684b-db88-4b73-90a9-3cd1661f5466"
```

## [Customizing Token Claims](#token-claims)

You can customize the claims in the OIDC tokens by adding a claims configuration to Dex:

```yaml
claims:
  groups:
  - groups
  - roles
  - teams
```

# [Troubleshooting](#troubleshooting)

## [LDAP Connection Issues](#ldap-issues)

If you have trouble connecting to your LDAP server:

1. Verify LDAP server connectivity from the Dex pod:
   ```bash
   kubectl exec -it -n dex deploy/dex -- nc -zv ldap.example.com 636
   ```

2. Check Dex logs for LDAP-related errors:
   ```bash
   kubectl logs -n dex deploy/dex | grep -i ldap
   ```

## [Authentication Flow Issues](#auth-flow-issues)

If the authentication flow doesn't work:

1. Verify your CA certificate is correct:
   ```bash
   openssl x509 -in openid-ca.pem -text -noout
   ```

2. Check vcluster API server logs:
   ```bash
   kubectl logs -n tenant-1 -c kubernetes tenant-1-0
   ```

3. Make sure your browser can resolve and access the Dex URL.

## [Authorization Issues](#authorization-issues)

If you can authenticate but not access resources:

1. Check the user identity and groups from the token:
   ```bash
   kubectl get --raw /api/v1/namespaces --kubeconfig ./kubeconfig-oidc.yaml -v 8
   ```

2. Verify your RBAC rules match the groups from your LDAP directory:
   ```bash
   kubectl auth can-i list pods --kubeconfig ./kubeconfig-oidc.yaml
   ```

# [Conclusion](#conclusion)

You've now successfully set up LDAP authentication for your Kubernetes vclusters using Dex as an OIDC provider. This configuration:

- Integrates with your existing identity management system
- Provides seamless single sign-on for Kubernetes users
- Maps LDAP groups to Kubernetes RBAC permissions
- Centralizes authentication for multiple vclusters

This approach significantly improves security by removing the need for separate Kubernetes credentials and enables you to apply consistent access policies across your organization.

For production deployments, consider:
- Using a database backend for Dex instead of in-memory storage
- Implementing high availability for Dex
- Setting up monitoring for the authentication components
- Regularly rotating TLS certificates
- Automating user onboarding/offboarding through LDAP group management