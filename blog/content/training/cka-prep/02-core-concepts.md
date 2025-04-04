---
title: "CKA Prep: Part 2 – Kubernetes Core Concepts"
description: "Essential Kubernetes architecture, API primitives, and core resources for the CKA exam."
date: 2025-04-04T00:00:00-00:00
series: "CKA Exam Preparation Guide"
series_rank: 2
draft: false
tags: ["kubernetes", "cka", "core-concepts", "k8s", "exam-prep"]
categories: ["Training", "Kubernetes Certification"]
author: "Matthew Mattox"
more_link: ""
---

## Kubernetes Architecture Components

Understanding the Kubernetes architecture is fundamental to passing the CKA exam. Let's break down the key components:

### Control Plane Components

The Control Plane (previously known as the master node) manages the worker nodes and the Pods in the cluster. The control plane components include:

1. **kube-apiserver**
   - Front-end for the Kubernetes control plane
   - Exposes the Kubernetes API
   - Scales horizontally (by adding more instances)
   - Primary point of communication for all cluster components

2. **etcd**
   - Consistent and highly-available key-value store
   - Stores all cluster data
   - Critical for cluster state management
   - Requires backup for disaster recovery

3. **kube-scheduler**
   - Watches for newly created Pods with no assigned node
   - Selects a node for the Pod to run on based on resource requirements, constraints, etc.
   - Makes scheduling decisions but doesn't perform the placement

4. **kube-controller-manager**
   - Runs controller processes (monitoring the shared state through the apiserver)
   - Node Controller: Notices and responds when nodes go down
   - Job Controller: Watches for Job objects and creates Pods to run them
   - Endpoints Controller: Populates the Endpoints object
   - Service Account & Token Controllers: Create accounts and API access tokens

5. **cloud-controller-manager**
   - Embeds cloud-specific control logic
   - Links your cluster to your cloud provider's API
   - Only runs controllers specific to your cloud provider

### Node Components

The node components run on every node in the cluster, maintaining running pods and providing the Kubernetes runtime environment:

1. **kubelet**
   - Agent that runs on each node
   - Ensures containers are running in a Pod
   - Takes a set of PodSpecs and ensures the containers described are running and healthy
   - Communicates with the control plane

2. **kube-proxy**
   - Network proxy that runs on each node
   - Maintains network rules that allow communication to your Pods
   - Implements part of the Kubernetes Service concept
   - Performs connection forwarding or network proxy based on cluster configuration

3. **Container Runtime**
   - Software responsible for running containers
   - Kubernetes supports several container runtimes: containerd, CRI-O, Docker Engine (via cri-dockerd)
   - Implements the Container Runtime Interface (CRI)

### Diagram of Kubernetes Architecture

```
+-------------------------------------------+
|                CONTROL PLANE              |
|                                           |
|  +---------------+    +----------------+  |
|  | kube-apiserver|<-->|      etcd      |  |
|  +---------------+    +----------------+  |
|         ^                                 |
|         |                                 |
|         v                                 |
|  +---------------+    +----------------+  |
|  |kube-scheduler |    |kube-controller |  |
|  +---------------+    +----------------+  |
|         ^                    ^            |
|         |                    |            |
+---------|--------------------|------------+
          |                    |
          v                    v
+-------------------------------------------+
|                  NODE                     |
|                                           |
|  +---------------+    +----------------+  |
|  |    kubelet    |<-->|   kube-proxy   |  |
|  +---------------+    +----------------+  |
|         ^                                 |
|         |                                 |
|         v                                 |
|  +-----------------------------------+    |
|  |          Container Runtime        |    |
|  +-----------------------------------+    |
|                                           |
|  +-----------------------------------+    |
|  |               Pods                |    |
|  +-----------------------------------+    |
+-------------------------------------------+
```

## Kubernetes API Primitives

Kubernetes objects are persistent entities in the Kubernetes system that represent the state of your cluster.

### Basic Structure of Kubernetes YAML

Most Kubernetes objects follow this structure:

```yaml
apiVersion: <API version>  # v1, apps/v1, etc.
kind: <kind>               # Pod, Deployment, Service, etc.
metadata:
  name: <object name>
  namespace: <namespace>   # default is "default"
  labels:
    <key>: <value>
spec:
  # Object-specific configuration
```

### Key Kubernetes Objects

#### 1. Pods

The smallest deployable units of computing that you can create and manage in Kubernetes.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: nginx-pod
spec:
  containers:
  - name: nginx
    image: nginx:1.21
    ports:
    - containerPort: 80
```

**Key Pod Concepts:**
- A Pod represents a single instance of an application
- Pods can contain multiple containers that share resources
- Pods are ephemeral by nature (they can die and are not automatically replaced)
- Typically, you don't create individual Pods directly; use higher-level controllers

#### 2. ReplicaSets

Ensures that a specified number of pod replicas are running at any given time.

```yaml
apiVersion: apps/v1
kind: ReplicaSet
metadata:
  name: nginx-replicaset
spec:
  replicas: 3
  selector:
    matchLabels:
      app: nginx
  template:
    metadata:
      labels:
        app: nginx
    spec:
      containers:
      - name: nginx
        image: nginx:1.21
```

**Key ReplicaSet Concepts:**
- Maintains a stable set of replica Pods
- Ensures the specified number of pods are available
- Used to guarantee availability of a specified number of identical Pods

#### 3. Deployments

Provides declarative updates for Pods and ReplicaSets.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx-deployment
spec:
  replicas: 3
  selector:
    matchLabels:
      app: nginx
  template:
    metadata:
      labels:
        app: nginx
    spec:
      containers:
      - name: nginx
        image: nginx:1.21
        ports:
        - containerPort: 80
```

**Key Deployment Concepts:**
- Manages ReplicaSets and enables declarative updates to Pods
- Supports rolling updates and rollbacks
- Provides revision history
- Self-healing mechanism

#### 4. Services

An abstract way to expose an application running on a set of Pods as a network service.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: nginx-service
spec:
  selector:
    app: nginx
  ports:
  - port: 80
    targetPort: 80
  type: ClusterIP  # ClusterIP, NodePort, LoadBalancer
```

**Key Service Concepts:**
- Provides stable IP address and DNS name for pod access
- Load balances traffic to pods
- Types:
  - **ClusterIP**: Exposes the service on an internal IP (default)
  - **NodePort**: Exposes the service on each node's IP at a static port
  - **LoadBalancer**: Exposes the service externally using a cloud provider's load balancer
  - **ExternalName**: Maps the service to an external name

#### 5. Namespaces

Virtual clusters backed by the same physical cluster, providing a way to divide cluster resources.

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: development
```

**Key Namespace Concepts:**
- Provides scope for names (prevents name collisions)
- Allows resource quotas across teams/projects
- Default namespaces: default, kube-system, kube-public, kube-node-lease

## Working with Kubernetes Objects

### Using Imperative Commands

For the CKA exam, mastering imperative commands is crucial for time management:

```bash
# Create and manage Pods
kubectl run nginx --image=nginx:1.21 --port=80
kubectl get pods
kubectl describe pod nginx
kubectl delete pod nginx

# Create and manage Deployments
kubectl create deployment nginx --image=nginx:1.21
kubectl scale deployment nginx --replicas=3
kubectl set image deployment/nginx nginx=nginx:1.22
kubectl rollout status deployment/nginx
kubectl rollout history deployment/nginx
kubectl rollout undo deployment/nginx
kubectl delete deployment nginx

# Create and manage Services
kubectl expose deployment nginx --port=80 --target-port=80 --type=ClusterIP
kubectl get services
kubectl describe service nginx
kubectl delete service nginx
```

### Using Declarative Commands

```bash
# Apply a YAML configuration file
kubectl apply -f nginx-deployment.yaml

# Get YAML for an existing resource
kubectl get deployment nginx -o yaml > nginx-deployment.yaml

# Create a resource with dry-run
kubectl create deployment nginx --image=nginx --dry-run=client -o yaml > nginx-deployment.yaml
```

## Understanding the kubectl Configuration File

The `kubectl` configuration file, usually found at `~/.kube/config`, is crucial for managing multiple clusters:

```yaml
apiVersion: v1
kind: Config
current-context: my-cluster
clusters:
- name: my-cluster
  cluster:
    server: https://kubernetes.example.com
    certificate-authority-data: DATA+OMITTED
contexts:
- name: my-cluster
  context:
    cluster: my-cluster
    namespace: default
    user: my-user
users:
- name: my-user
  user:
    client-certificate-data: DATA+OMITTED
    client-key-data: DATA+OMITTED
```

To work with this file:

```bash
# View current context
kubectl config current-context

# Switch context
kubectl config use-context my-other-cluster

# Set namespace for current context
kubectl config set-context --current --namespace=my-namespace
```

## Working with the Kubernetes API

Understanding the Kubernetes API structure helps with troubleshooting and advanced operations:

```bash
# Get API resources
kubectl api-resources

# Get API versions
kubectl api-versions

# Explain a resource type
kubectl explain pod
kubectl explain pod.spec.containers

# Access the API server directly (advanced)
kubectl proxy
curl http://localhost:8001/api/v1/namespaces/default/pods
```

## Sample Exam Questions

### Question 1: Create Essential Resources

**Task**: Create a namespace called 'production'. In this namespace, create a Pod named 'web-pod' using the 'nginx:1.21' image with resource limits of 200m CPU and 256Mi memory.

**Solution**:

```bash
# Create the namespace
kubectl create namespace production

# Create the pod with resource limits
cat << EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: web-pod
  namespace: production
spec:
  containers:
  - name: nginx
    image: nginx:1.21
    resources:
      limits:
        cpu: 200m
        memory: 256Mi
EOF
```

Alternatively, using imperative commands:

```bash
kubectl create namespace production
kubectl run web-pod --image=nginx:1.21 -n production --limits=cpu=200m,memory=256Mi
```

### Question 2: Working with Contexts

**Task**: A kubeconfig file is located at `/home/user/config`. Use this file to get the list of nodes in the 'production' context.

**Solution**:

```bash
kubectl --kubeconfig=/home/user/config config use-context production
kubectl --kubeconfig=/home/user/config get nodes
```

Or in a single command:

```bash
kubectl --kubeconfig=/home/user/config --context=production get nodes
```

### Question 3: Deployment Update and Rollback

**Task**: Update the 'web-deployment' in the 'apps' namespace to use the 'nginx:1.22' image, then check the rollout status. If any issues are found, roll back to the previous version.

**Solution**:

```bash
# Update the deployment
kubectl -n apps set image deployment/web-deployment nginx=nginx:1.22

# Check rollout status
kubectl -n apps rollout status deployment/web-deployment

# If issues are found, perform a rollback
kubectl -n apps rollout undo deployment/web-deployment

# Verify the rollback was successful
kubectl -n apps get deployment web-deployment -o wide
```

### Question 4: Multi-Container Pod

**Task**: Create a Pod named 'multi-container-pod' in the default namespace with two containers:
- A container named 'nginx' using the 'nginx:1.21' image
- A container named 'sidecar' using the 'busybox:1.35' image that runs the command 'while true; do echo Monitoring; sleep 10; done'

**Solution**:

```bash
cat << EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: multi-container-pod
spec:
  containers:
  - name: nginx
    image: nginx:1.21
    ports:
    - containerPort: 80
  - name: sidecar
    image: busybox:1.35
    command: ["/bin/sh", "-c"]
    args: ["while true; do echo Monitoring; sleep 10; done"]
EOF
```

To verify:
```bash
kubectl get pod multi-container-pod
kubectl describe pod multi-container-pod
kubectl logs multi-container-pod -c sidecar
```

### Question 5: Working with Labels and Selectors

**Task**: Find all pods in the 'kube-system' namespace with the label 'k8s-app=kube-dns' and output their IP addresses.

**Solution**:

```bash
# Get the pods with the label and their IPs
kubectl get pods -n kube-system -l k8s-app=kube-dns -o custom-columns=NAME:.metadata.name,IP:.status.podIP

# Alternative with jsonpath
kubectl get pods -n kube-system -l k8s-app=kube-dns -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.podIP}{"\n"}{end}'
```

### Question 6: Debugging Pod Status

**Task**: A pod named 'web-server' in the 'default' namespace is stuck in a 'Pending' state. Identify the issue and how you would troubleshoot it.

**Solution**:

```bash
# First, check the pod details
kubectl describe pod web-server

# Look for events that might indicate issues:
# - Insufficient resources
# - Node selector/affinity issues
# - PersistentVolume issues
# - Image pull failures

# Check node resource availability
kubectl get nodes -o wide
kubectl describe nodes | grep -A 10 "Allocated resources"

# If it's a resource issue, you might need to:
# - Modify the resource requests
# - Add more nodes to the cluster
# - Delete unused resources

# Example - Edit pod resource requests
kubectl edit pod web-server
# Reduce CPU/memory requests in the editor
```

### Question 7: Working with Namespaces

**Task**: Create a new namespace called 'restricted' with a ResourceQuota limiting it to 5 pods, 10 CPU cores, and 20Gi of memory.

**Solution**:

```bash
# Create the namespace
kubectl create namespace restricted

# Create the ResourceQuota
cat << EOF | kubectl apply -f -
apiVersion: v1
kind: ResourceQuota
metadata:
  name: compute-quota
  namespace: restricted
spec:
  hard:
    pods: "5"
    requests.cpu: "10"
    requests.memory: 20Gi
    limits.cpu: "10"
    limits.memory: 20Gi
EOF

# Verify the quota
kubectl describe quota compute-quota -n restricted
```

## Key Tips for the Core Concepts Section

1. **Master the kubectl command-line tool**:
   - Use kubectl shortcuts (e.g., `po` for pods, `deploy` for deployments)
   - Learn to use `-o wide` and `-o yaml` output formats
   - Practice with `--dry-run=client` to validate commands

2. **Understand the relationship between objects**:
   - Pods are managed by ReplicaSets
   - ReplicaSets are managed by Deployments
   - Services expose Pods based on label selectors

3. **Get comfortable with declarative and imperative approaches**:
   - Imperative: Fast for exam scenarios
   - Declarative: Better for complex configurations

4. **Use kubectl explain extensively**:
   - When uncertain about specific field configuration
   - To explore API object structure

## Practice Exercises

To reinforce your understanding, try these exercises in your practice environment:

1. Create a namespace called 'practice'
2. Deploy a pod running 'busybox' in the 'practice' namespace that runs the command 'sleep 3600'
3. Create a deployment with 3 replicas running 'nginx' in the 'practice' namespace
4. Expose the deployment using a ClusterIP Service
5. Scale the deployment to 5 replicas
6. Update the deployment to use 'nginx:1.22'
7. Roll back the deployment to the previous version

## What's Next

In the next part, we'll dive deeper into Workloads and Scheduling, covering:
- Deployments, DaemonSets, and StatefulSets
- ConfigMaps and Secrets
- Resource requirements and limits
- Node selectors, affinity, and taints/tolerations

👉 Continue to **[Part 3: Workloads & Scheduling](/training/cka-prep/03-workloads-scheduling/)**
