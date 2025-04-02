---
title: "RKE2 the Hard Way: Part 5 – Setting up kube-apiserver as Static Pods"
description: "Configuring and deploying the Kubernetes API Server as static pods managed by kubelet."
date: 2025-04-01T00:00:00-00:00
series: "RKE2 the Hard Way"
series_rank: 5
draft: false
tags: ["kubernetes", "rke2", "kube-apiserver", "high-availability", "static-pods"]
categories: ["Training", "RKE2"]
author: "Matthew Mattox"
description: "In Part 5 of RKE2 the Hard Way, we configure and deploy the Kubernetes API Server as static pods managed by kubelet."
more_link: ""
---

## Part 5 – Setting up kube-apiserver as Static Pods

In this part of the **"RKE2 the Hard Way"** training series, we will set up the **Kubernetes API Server** (`kube-apiserver`) as static pods managed by kubelet on each of our nodes. The API server is the central component of the Kubernetes control plane that exposes the Kubernetes API.

Using static pods for the API server is a key design principle in RKE2. This approach simplifies deployment and management, as kubelet will automatically start the API server and ensure it stays running. If an API server instance fails, kubelet will automatically restart it.

> ✅ **Assumption:** We've already set up etcd as static pods in [Part 4](/training/rke2-hard-way/04-setting-up-etcd-cluster/) and have our certificates from [Part 3](/training/rke2-hard-way/03-certificate-authority-tls-certificates/).

---

### 1. Download Kubernetes Binaries

First, we need to download the Kubernetes binaries on each node:

```bash
# Download Kubernetes binaries
KUBERNETES_VERSION="v1.32.3"
wget -q --show-progress --https-only --timestamping \
  "https://dl.k8s.io/${KUBERNETES_VERSION}/bin/linux/amd64/kubectl"

# Make them executable
chmod +x kubectl

# Move them to the appropriate directory
sudo mv kubectl /usr/local/bin/
```

---

### 2. Create API Server Static Pod Manifest

Now, we'll create the static pod manifest for the API server. The kubelet will use this manifest to create and manage the API server pod.

Replace the `NODE_IP` variable with the appropriate value for each node.

Run these steps on each control plane node. The script automatically detects the current node and sets the appropriate variables:

```bash
# First, determine which node we're on and set the appropriate IP variable
HOSTNAME=$(hostname)
if [ "$HOSTNAME" = "node01" ]; then
  # Use the NODE1_IP variable we set in Part 2
  CURRENT_NODE_IP=${NODE1_IP}
elif [ "$HOSTNAME" = "node02" ]; then
  CURRENT_NODE_IP=${NODE2_IP}
elif [ "$HOSTNAME" = "node03" ]; then
  CURRENT_NODE_IP=${NODE3_IP}
else
  echo "Unknown hostname: $HOSTNAME"
  exit 1
fi

# Create directory structure for certificates if it doesn't exist
mkdir -p /etc/kubernetes/ssl/etcd

# Get clean hostname (kubelet will automatically append the node name again)
NODE_NAME=$(hostname -s)

# Create kube-apiserver static pod manifest
cat > /etc/kubernetes/manifests/kube-apiserver.yaml << EOF
apiVersion: v1
kind: Pod
metadata:
  name: kube-apiserver
  namespace: kube-system
  labels:
    component: kube-apiserver
    tier: control-plane
spec:
  hostNetwork: true
  containers:
  - name: kube-apiserver
    image: registry.k8s.io/kube-apiserver:${KUBERNETES_VERSION}
    command:
    - kube-apiserver
    - --advertise-address=${CURRENT_NODE_IP}
    - --allow-privileged=true
    - --authorization-mode=Node,RBAC
    - --client-ca-file=/etc/kubernetes/ssl/ca.pem
    - --enable-admission-plugins=NodeRestriction
    - --enable-bootstrap-token-auth=true
    - --etcd-cafile=/etc/kubernetes/ssl/ca.pem
    - --etcd-certfile=/etc/kubernetes/ssl/kubernetes.pem
    - --etcd-keyfile=/etc/kubernetes/ssl/kubernetes-key.pem
    - --etcd-servers=https://${NODE1_IP}:2379,https://${NODE2_IP}:2379,https://${NODE3_IP}:2379
    - --kubelet-client-certificate=/etc/kubernetes/ssl/kubernetes.pem
    - --kubelet-client-key=/etc/kubernetes/ssl/kubernetes-key.pem
    - --kubelet-preferred-address-types=InternalIP,ExternalIP,Hostname
    - --proxy-client-cert-file=/etc/kubernetes/ssl/kubernetes.pem
    - --proxy-client-key-file=/etc/kubernetes/ssl/kubernetes-key.pem
    - --requestheader-allowed-names=front-proxy-client,kubernetes,kube-etcd
    - --requestheader-client-ca-file=/etc/kubernetes/ssl/ca.pem
    - --requestheader-extra-headers-prefix=X-Remote-Extra-
    - --requestheader-group-headers=X-Remote-Group
    - --requestheader-username-headers=X-Remote-User
    - --secure-port=6443
    - --service-account-issuer=https://kubernetes.default.svc.cluster.local
    - --service-account-key-file=/etc/kubernetes/ssl/service-account.pem
    - --service-account-signing-key-file=/etc/kubernetes/ssl/service-account-key.pem
    - --service-cluster-ip-range=10.43.0.0/16
    - --tls-cert-file=/etc/kubernetes/ssl/kubernetes.pem
    - --tls-private-key-file=/etc/kubernetes/ssl/kubernetes-key.pem
    volumeMounts:
    - mountPath: /etc/kubernetes/ssl
      name: k8s-certs
      readOnly: true
    livenessProbe:
      httpGet:
        host: 127.0.0.1
        path: /livez
        port: 6443
        scheme: HTTPS
      initialDelaySeconds: 10
      timeoutSeconds: 15
      periodSeconds: 20
    readinessProbe:
      httpGet:
        host: 127.0.0.1
        path: /readyz
        port: 6443
        scheme: HTTPS
      initialDelaySeconds: 10
      timeoutSeconds: 15
      periodSeconds: 20
  volumes:
  - hostPath:
      path: /etc/kubernetes/ssl
      type: DirectoryOrCreate
    name: k8s-certs
EOF
```

The above script will:
1. Detect the current node and set the IP variables
2. Create directories for certificates
3. Create a static pod manifest with the hostname appended (e.g., kube-apiserver-node01)
4. Use the certificates we created in Part 2

---

### 3. Verify Certificate Placement

The API server pod manifest is configured to use certificates from the `/etc/kubernetes/ssl` directory. Let's verify that all necessary certificates are in place:

```bash
# Check that all required certificates exist
ls -la /etc/kubernetes/ssl/

# We need at minimum these certificates:
# - ca.pem (CA certificate)
# - kubernetes.pem and kubernetes-key.pem (API server certificate and key)
# - service-account.pem and service-account-key.pem (Service account certificate and key)

# If any are missing, copy them from where they were generated in Part 2:
# sudo cp /path/to/certificates/* /etc/kubernetes/ssl/
```

The certificates should be properly placed during the certificate creation steps in Part 2. If they are not in the right location, you can copy them following the previous pattern we established.

Recall that in Part 2, we:
1. Generated the CA certificate and key
2. Generated the Kubernetes API server certificate and key
3. Generated the service account certificate and key
4. Copied them to all the nodes in the `/etc/kubernetes/ssl` directory

---

### 4. Verify API Server is Running

After creating the manifest and copying the certificates, the kubelet will automatically create the API server pod. Verify that it's running:

```bash
# Since the API server is just starting up, we'll use crictl
# Note: kubelet automatically appends the node name to static pod names,
# so the actual pod will be named "kube-apiserver-node01" on node01, etc.
sudo crictl pods | grep kube-apiserver
sudo crictl ps | grep kube-apiserver
```

You can also check the API server logs:

```bash
# Find the API server container ID first
CONTAINER_ID=$(sudo crictl ps | grep kube-apiserver | awk '{print $1}')
sudo crictl logs $CONTAINER_ID
```

---

### 5. Create kubeconfig File for kubectl

Now that the API server is running, we can create a kubeconfig file for the kubectl command-line tool:

```bash
# First, determine which node we're on and set the appropriate IP variable
if [ "$HOSTNAME" = "node01" ]; then
  # Use the NODE1_IP variable we set in Part 2
  CURRENT_NODE_IP=${NODE1_IP}
elif [ "$HOSTNAME" = "node02" ]; then
  CURRENT_NODE_IP=${NODE2_IP}
elif [ "$HOSTNAME" = "node03" ]; then
  CURRENT_NODE_IP=${NODE3_IP}
else
  echo "Unknown hostname: $HOSTNAME"
  exit 1
fi

# Set the cluster name and server endpoint
CLUSTER_NAME="kubernetes-the-hard-way"
SERVER="https://${CURRENT_NODE_IP}:6443"

# First, let's create an admin certificate if we don't already have one
if [ ! -f "/etc/kubernetes/ssl/admin.pem" ]; then
  # Generate an admin certificate
  cat > admin-csr.json << EOF
{
  "CN": "admin",
  "key": {
    "algo": "rsa",
    "size": 2048
  },
  "names": [
    {
      "C": "US",
      "L": "Rancher",
      "O": "system:masters",
      "OU": "Kubernetes The Hard Way",
      "ST": "SUSE"
    }
  ]
}
EOF

  cfssl gencert \
    -ca=/etc/kubernetes/ssl/ca.pem \
    -ca-key=/etc/kubernetes/ssl/ca-key.pem \
    -config=/etc/kubernetes/ssl/ca-config.json \
    -profile=kubernetes \
    admin-csr.json | cfssljson -bare admin

  # Move the certificates to the proper location
  sudo mv admin.pem admin-key.pem /etc/kubernetes/ssl/
  rm admin.csr admin-csr.json
fi

# Set up the kubeconfig file
kubectl config set-cluster ${CLUSTER_NAME} \
  --certificate-authority=/etc/kubernetes/ssl/ca.pem \
  --embed-certs=true \
  --server=${SERVER} \
  --kubeconfig=admin.kubeconfig

kubectl config set-credentials admin \
  --client-certificate=/etc/kubernetes/ssl/admin.pem \
  --client-key=/etc/kubernetes/ssl/admin-key.pem \
  --embed-certs=true \
  --kubeconfig=admin.kubeconfig

kubectl config set-context ${CLUSTER_NAME} \
  --cluster=${CLUSTER_NAME} \
  --user=admin \
  --kubeconfig=admin.kubeconfig

kubectl config use-context ${CLUSTER_NAME} --kubeconfig=admin.kubeconfig

# Move the kubeconfig file to the default location and ensure proper permissions
mkdir -p $HOME/.kube
sudo cp admin.kubeconfig $HOME/.kube/config
sudo chmod 644 admin.kubeconfig
sudo chown $(id -u):$(id -g) $HOME/.kube/config

# Create cluster role bindings for system users
cat > cluster-admin-bindings.yaml << EOF
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: admin-cluster-admin
subjects:
- kind: User
  name: admin
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: cluster-admin
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kubernetes-cluster-admin
subjects:
- kind: User
  name: kubernetes
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: cluster-admin
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: system:controller-manager-extended
rules:
- apiGroups: ["*"]
  resources: ["*"]
  verbs: ["*"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: system-controller-manager
subjects:
- kind: User
  name: system:kube-controller-manager
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: system:controller-manager-extended
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: system-scheduler
subjects:
- kind: User
  name: system:kube-scheduler
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: system:kube-scheduler
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: logs-reader
rules:
- apiGroups: [""]
  resources: ["pods", "pods/log"]
  verbs: ["get", "list", "watch"]
- apiGroups: [""]
  resources: ["nodes", "nodes/proxy"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: logs-reader-binding
subjects:
- kind: User
  name: kubernetes
  apiGroup: rbac.authorization.k8s.io
- kind: User
  name: admin
  apiGroup: rbac.authorization.k8s.io
- kind: ServiceAccount
  name: default
  namespace: kube-system
roleRef:
  kind: ClusterRole
  name: logs-reader
  apiGroup: rbac.authorization.k8s.io
EOF

# Apply the cluster role bindings
kubectl apply -f cluster-admin-bindings.yaml
```

This will create a kubeconfig file that:
1. Points to the API server on the current node
2. Uses the CA certificate to validate the server 
3. Uses the admin certificate for authentication
4. Sets the context to use the cluster and admin user

---

### 6. Verify API Server Connection

Verify that you can connect to the API server and get a response:

```bash
kubectl version
kubectl get nodes
```

At this point, you won't see any nodes registered because we haven't configured the kubelet to register with the API server yet. We'll do that in subsequent parts.

---

## Next Steps

Now that our Kubernetes API Server is up and running as a static pod managed by kubelet, we'll proceed to **Part 6** where we'll set up the **Kubernetes Controller Manager and Scheduler as static pods**!

👉 Continue to **[Part 6: Setting up kube-controller-manager and kube-scheduler as Static Pods](/training/rke2-hard-way/06-setting-up-kube-controller-manager-and-kube-scheduler/)**
