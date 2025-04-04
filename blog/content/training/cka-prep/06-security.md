---
title: "CKA Prep: Part 6 – Security"
description: "Understanding Kubernetes security concepts, authentication, authorization, and RBAC for the CKA exam."
date: 2025-04-04T00:00:00-00:00
series: "CKA Exam Preparation Guide"
series_rank: 6
draft: false
tags: ["kubernetes", "cka", "security", "k8s", "exam-prep", "rbac", "authentication", "authorization"]
categories: ["Training", "Kubernetes Certification"]
author: "Matthew Mattox"
more_link: ""
---

## Kubernetes Security Fundamentals

Security is a critical aspect of Kubernetes administration and a significant portion of the CKA exam. In this section, we'll cover the key security concepts and components you need to understand.

## Authentication

Authentication in Kubernetes validates whether a user is who they claim to be. Kubernetes supports several authentication methods, but the CKA exam focuses primarily on:

1. Client certificates (x509)
2. Service accounts with tokens
3. Static token files (less common in exams)

### X.509 Client Certificates

Kubernetes uses X.509 certificates for authentication. When you use kubectl, it generally uses client certificates stored in the kubeconfig file.

**Example kubeconfig with client certificate authentication:**

```yaml
apiVersion: v1
kind: Config
users:
- name: admin-user
  user:
    client-certificate: admin.crt
    client-key: admin.key
```

**Generating Certificates:**

In the exam, you might be asked to create a new client certificate for a user. Here's a simplified example:

```bash
# Generate a private key
openssl genrsa -out john.key 2048

# Create a certificate signing request
openssl req -new -key john.key -out john.csr -subj "/CN=john/O=development"

# Sign the CSR using the Kubernetes CA
openssl x509 -req -in john.csr -CA /etc/kubernetes/pki/ca.crt \
  -CAkey /etc/kubernetes/pki/ca.key -CAcreateserial -out john.crt -days 365
```

**Creating a kubeconfig:**

```bash
# Set cluster
kubectl config set-cluster kubernetes --server=https://kubernetes:6443 \
  --certificate-authority=/etc/kubernetes/pki/ca.crt \
  --embed-certs=true \
  --kubeconfig=john.kubeconfig

# Set user
kubectl config set-credentials john \
  --client-certificate=john.crt \
  --client-key=john.key \
  --embed-certs=true \
  --kubeconfig=john.kubeconfig

# Set context
kubectl config set-context john@kubernetes \
  --cluster=kubernetes \
  --user=john \
  --kubeconfig=john.kubeconfig

# Set current context
kubectl config use-context john@kubernetes --kubeconfig=john.kubeconfig
```

### Service Accounts

Service Accounts are Kubernetes resources used by pods to authenticate to the API server.

**Creating a Service Account:**

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: app-service-account
  namespace: default
```

**Using a Service Account in a Pod:**

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: app-pod
spec:
  serviceAccountName: app-service-account
  containers:
  - name: app
    image: nginx
```

**Common Service Account Commands:**

```bash
# Create a service account
kubectl create serviceaccount app-sa

# List service accounts
kubectl get serviceaccounts

# View service account details
kubectl describe serviceaccount app-sa
```

## Authorization

Once a user is authenticated, authorization determines what actions they're allowed to perform. Kubernetes provides several authorization mechanisms, but the CKA exam primarily focuses on:

1. Role-Based Access Control (RBAC)
2. Node authorization (for kubelet)

### Role-Based Access Control (RBAC)

RBAC is the standard authorization mechanism in Kubernetes. It uses the following resources:

1. **Roles/ClusterRoles**: Define what actions can be performed on which resources
2. **RoleBindings/ClusterRoleBindings**: Link roles to users, groups, or service accounts

#### Roles

A Role defines a set of permissions within a specific namespace:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: default
  name: pod-reader
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "watch", "list"]
```

#### RoleBindings

A RoleBinding grants permissions defined in a Role to users or service accounts:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: read-pods
  namespace: default
subjects:
- kind: User
  name: john
  apiGroup: rbac.authorization.k8s.io
- kind: ServiceAccount
  name: app-service-account
  namespace: default
roleRef:
  kind: Role
  name: pod-reader
  apiGroup: rbac.authorization.k8s.io
```

#### ClusterRoles

A ClusterRole defines permissions across all namespaces:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: pods-viewer
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "watch", "list"]
```

#### ClusterRoleBindings

A ClusterRoleBinding grants permissions defined in a ClusterRole across all namespaces:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: view-pods-global
subjects:
- kind: Group
  name: system:developers
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: pods-viewer
  apiGroup: rbac.authorization.k8s.io
```

### Common RBAC Commands

```bash
# Create a Role
kubectl create role pod-reader --verb=get,list,watch --resource=pods

# Create a RoleBinding
kubectl create rolebinding read-pods \
  --role=pod-reader \
  --user=john

# Create a ClusterRole
kubectl create clusterrole pod-reader \
  --verb=get,list,watch \
  --resource=pods

# Create a ClusterRoleBinding
kubectl create clusterrolebinding read-pods-global \
  --clusterrole=pod-reader \
  --user=john

# Check if a user has specific permissions
kubectl auth can-i list pods --as=john
kubectl auth can-i create deployments --as=john --namespace=development
```

## Admission Control

Admission Controllers intercept requests to the Kubernetes API server after authentication and authorization but before objects are persisted. They can modify or reject requests.

Common admission controllers you should know for the CKA exam:

1. **PodSecurityPolicy** (deprecated but still in exams): Enforces security standards on pods
2. **ResourceQuota**: Enforces resource consumption limits for namespaces
3. **LimitRange**: Sets default resource limits and requests for containers
4. **NodeRestriction**: Limits what kubelet can modify
5. **ServiceAccount**: Automates service account management

## Securing Kubernetes Components

### API Server Security

The API server is the primary entry point to the Kubernetes control plane. Its security configurations include:

```bash
# View API server configuration
kubectl describe pod kube-apiserver-master -n kube-system
```

Key security flags to know:
- `--client-ca-file`: CA certificate for client auth
- `--tls-cert-file` and `--tls-private-key-file`: API Server's TLS certificate and key
- `--enable-admission-plugins`: Enable specific admission controllers
- `--authorization-mode`: Authorization methods (e.g., Node,RBAC)

### etcd Security

etcd stores all Kubernetes cluster data and should be highly secured:

```bash
# View etcd configuration
kubectl describe pod etcd-master -n kube-system
```

Key security features:
- Mutual TLS authentication
- Encryption of data at rest

### kubelet Security

The kubelet is the primary node agent:

```bash
# View kubelet configuration
systemctl status kubelet
cat /var/lib/kubelet/config.yaml
```

Key security aspects:
- Authentication to API server
- Authorization of API requests using Node authorizer
- Securing the kubelet API

## Security Contexts

Security Contexts allow you to define privilege and access control settings for pods and containers:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: secure-pod
spec:
  securityContext:
    runAsUser: 1000
    runAsGroup: 3000
    fsGroup: 2000
  containers:
  - name: app
    image: nginx
    securityContext:
      allowPrivilegeEscalation: false
      capabilities:
        drop:
        - ALL
        add:
        - NET_BIND_SERVICE
```

Key container security settings:
- `runAsUser`: User ID to run processes
- `runAsGroup`: Group ID to run processes
- `fsGroup`: Group ID applied to mounted volumes
- `capabilities`: Linux capabilities to add or drop
- `privileged`: Run as privileged container
- `allowPrivilegeEscalation`: Process can gain more privileges than its parent

## Secrets Management

Secrets store sensitive information like passwords, tokens, or keys:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: db-credentials
type: Opaque
data:
  username: YWRtaW4=  # Base64 encoded "admin"
  password: cGFzc3dvcmQxMjM=  # Base64 encoded "password123"
```

**Creating Secrets Imperatively:**

```bash
# Create a secret from literal values
kubectl create secret generic db-credentials \
  --from-literal=username=admin \
  --from-literal=password=password123

# Create a secret from files
kubectl create secret generic tls-certs \
  --from-file=tls.crt=path/to/tls.crt \
  --from-file=tls.key=path/to/tls.key
```

**Using Secrets in Pods:**

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: secret-pod
spec:
  containers:
  - name: app
    image: nginx
    env:
    - name: DB_USERNAME
      valueFrom:
        secretKeyRef:
          name: db-credentials
          key: username
    - name: DB_PASSWORD
      valueFrom:
        secretKeyRef:
          name: db-credentials
          key: password
    volumeMounts:
    - name: secret-volume
      mountPath: /etc/secrets
  volumes:
  - name: secret-volume
    secret:
      secretName: db-credentials
```

## Network Policies

Network Policies define how pods communicate with each other and other network endpoints:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: db-network-policy
  namespace: default
spec:
  podSelector:
    matchLabels:
      role: db
  policyTypes:
  - Ingress
  - Egress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          role: frontend
    ports:
    - protocol: TCP
      port: 3306
  egress:
  - to:
    - podSelector:
        matchLabels:
          role: monitoring
    ports:
    - protocol: TCP
      port: 8080
```

Key concepts:
- Ingress: Incoming traffic to selected pods
- Egress: Outgoing traffic from selected pods
- selectors: Define which pods/namespaces the policy applies to

## Sample Exam Questions

### Question 1: Create a Role and RoleBinding

**Task**: Create a Role named `deployment-manager` that allows a user to create, delete, and update deployments in the `development` namespace. Then create a RoleBinding that grants this role to user `john`.

**Solution**:

```bash
# Create the namespace if it doesn't exist
kubectl create namespace development

# Create the Role
cat << EOF | kubectl apply -f -
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: development
  name: deployment-manager
rules:
- apiGroups: ["apps"]
  resources: ["deployments"]
  verbs: ["create", "delete", "update", "get", "list"]
EOF

# Create the RoleBinding
cat << EOF | kubectl apply -f -
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: john-deployment-manager
  namespace: development
subjects:
- kind: User
  name: john
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: deployment-manager
  apiGroup: rbac.authorization.k8s.io
EOF
```

### Question 2: Service Account with Limited Permissions

**Task**: Create a service account named `api-service-account` in the `default` namespace. Create a role that allows only read access to pods and services. Bind this role to the service account.

**Solution**:

```bash
# Create the service account
kubectl create serviceaccount api-service-account

# Create the Role
cat << EOF | kubectl apply -f -
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: default
  name: pod-and-service-reader
rules:
- apiGroups: [""]
  resources: ["pods", "services"]
  verbs: ["get", "watch", "list"]
EOF

# Create the RoleBinding
cat << EOF | kubectl apply -f -
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: api-read-access
  namespace: default
subjects:
- kind: ServiceAccount
  name: api-service-account
  namespace: default
roleRef:
  kind: Role
  name: pod-and-service-reader
  apiGroup: rbac.authorization.k8s.io
EOF
```

### Question 3: Create a Pod with Security Context

**Task**: Create a pod named `secure-nginx` using the `nginx` image with the following security requirements:
- Run as user ID 1000
- Run as group ID 2000
- Mount a volume at `/data` that belongs to group ID 3000
- Prevent privilege escalation

**Solution**:

```bash
cat << EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: secure-nginx
spec:
  securityContext:
    runAsUser: 1000
    runAsGroup: 2000
    fsGroup: 3000
  containers:
  - name: nginx
    image: nginx
    securityContext:
      allowPrivilegeEscalation: false
    volumeMounts:
    - name: data-volume
      mountPath: /data
  volumes:
  - name: data-volume
    emptyDir: {}
EOF
```

### Question 4: Create and Use a Secret

**Task**: Create a secret named `db-auth` with the values `username=db-admin` and `password=S3cr3t!`. Then create a pod that exposes these as environment variables.

**Solution**:

```bash
# Create the secret
kubectl create secret generic db-auth \
  --from-literal=username=db-admin \
  --from-literal=password=S3cr3t!

# Create the pod using the secret
cat << EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: db-client-pod
spec:
  containers:
  - name: db-client
    image: busybox
    command: ["sleep", "3600"]
    env:
    - name: DB_USERNAME
      valueFrom:
        secretKeyRef:
          name: db-auth
          key: username
    - name: DB_PASSWORD
      valueFrom:
        secretKeyRef:
          name: db-auth
          key: password
EOF
```

## Key Tips for Security

1. **Master RBAC concepts**:
   - Understand the difference between Roles and ClusterRoles
   - Know how to create and bind roles to users and service accounts
   - Practice checking permissions with `kubectl auth can-i`

2. **Understand Authentication**:
   - Know how to generate client certificates
   - Be familiar with kubeconfig file structure
   - Understand service account tokens

3. **Security Context**:
   - Know how to set security requirements for pods and containers
   - Understand Linux security concepts like user/group IDs and capabilities

4. **Secrets Management**:
   - Know different ways to create and use secrets
   - Understand the difference between environment variables and volume mounts

5. **Network Policies**:
   - Understand how to restrict pod communication
   - Know the difference between ingress and egress rules

## Practice Exercises

To reinforce your understanding, try these exercises in your practice environment:

1. Create a Role for managing pods (CRUD operations) and bind it to a service account
2. Create a new namespace with a ResourceQuota limiting resources
3. Create a pod with specific security contexts
4. Create and use secrets in different ways (env vars, files)
5. Implement a network policy to isolate a database pod
6. Create a custom user with certificate-based authentication
7. Explore API server flags related to security

## What's Next

In the next part, we'll explore Kubernetes Cluster Maintenance concepts, covering:
- OS Upgrades
- Kubernetes Version Upgrades
- Backup and Restore
- Cluster Monitoring
- Resource Monitoring
- etcd Backup and Restore

👉 Continue to **[Part 7: Cluster Maintenance](/training/cka-prep/07-cluster-maintenance/)**
