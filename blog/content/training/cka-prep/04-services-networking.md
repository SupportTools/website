---
title: "CKA Prep: Part 4 – Services & Networking"
description: "Understanding Kubernetes networking concepts, services, DNS, and network policies for the CKA exam."
date: 2025-04-04T00:00:00-00:00
series: "CKA Exam Preparation Guide"
series_rank: 4
draft: false
tags: ["kubernetes", "cka", "networking", "services", "k8s", "exam-prep"]
categories: ["Training", "Kubernetes Certification"]
author: "Matthew Mattox"
more_link: ""
---

## Kubernetes Networking Fundamentals

Kubernetes networking can be complex, but understanding it is crucial for the CKA exam. This section covers essential Kubernetes networking concepts.

### Kubernetes Network Model

The Kubernetes network model imposes the following requirements:

1. **Pod-to-Pod Communication**: All pods can communicate with all other pods without NAT
2. **Node-to-Pod Communication**: Nodes can communicate with all pods without NAT
3. **Pod-to-Node Communication**: Pods can communicate with all nodes without NAT

These requirements are implemented by Container Network Interface (CNI) plugins like Calico, Cilium, Flannel, and others.

### Pod Networking

Every pod in a Kubernetes cluster receives its own unique IP address. This IP address is ephemeral and will change if the pod is recreated.

**Key Pod Networking Concepts:**

- Each pod has its own IP address
- Containers within a pod share the same network namespace
- Containers within a pod can communicate via localhost
- The pod IP is visible to other pods in the cluster, regardless of the node

## Kubernetes Services

Services provide a stable networking endpoint for a set of pods. They abstract away the ephemeral nature of pod IPs and provide load balancing.

### Service Types

#### ClusterIP (Default)

Exposes the service on an internal IP within the cluster. Only accessible within the cluster.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: nginx-service
spec:
  selector:
    app: nginx
  ports:
  - port: 80        # Service port
    targetPort: 80  # Container port
  type: ClusterIP
```

**Common ClusterIP Commands:**

```bash
# Create a ClusterIP service
kubectl expose deployment nginx --port=80 --target-port=80

# Get services
kubectl get services

# Describe a service
kubectl describe service nginx-service
```

#### NodePort

Exposes the service on each node's IP at a static port. Accessible from outside the cluster using `<NodeIP>:<NodePort>`.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: nginx-nodeport
spec:
  selector:
    app: nginx
  ports:
  - port: 80            # Service port
    targetPort: 80      # Container port
    nodePort: 30080     # Node port (must be between 30000-32767)
  type: NodePort
```

**Common NodePort Commands:**

```bash
# Create a NodePort service
kubectl expose deployment nginx --port=80 --target-port=80 --type=NodePort

# Get the assigned NodePort
kubectl get service nginx-nodeport -o jsonpath='{.spec.ports[0].nodePort}'
```

#### LoadBalancer

Exposes the service externally using a cloud provider's load balancer.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: nginx-lb
spec:
  selector:
    app: nginx
  ports:
  - port: 80
    targetPort: 80
  type: LoadBalancer
```

**Common LoadBalancer Commands:**

```bash
# Create a LoadBalancer service
kubectl expose deployment nginx --port=80 --target-port=80 --type=LoadBalancer

# Check the external IP (may take a moment to provision)
kubectl get service nginx-lb -w
```

#### ExternalName

Maps the service to an external DNS name.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: external-service
spec:
  type: ExternalName
  externalName: api.example.com
```

### Headless Services

A headless service is created by setting the `clusterIP` field to `None`. This allows direct access to the pods behind the service.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: headless-service
spec:
  clusterIP: None
  selector:
    app: nginx
  ports:
  - port: 80
    targetPort: 80
```

Headless services are especially useful with StatefulSets to enable direct pod-to-pod communication.

## Service Discovery and DNS

Kubernetes provides a built-in DNS service, typically implemented by CoreDNS, for service discovery.

### DNS Resolution in Kubernetes

- Services are assigned a DNS name in the format: `<service-name>.<namespace>.svc.cluster.local`
- Pods can have DNS names in the format: `<pod-ip-with-dashes>.<namespace>.pod.cluster.local`

**Example DNS lookups from within a pod:**

```bash
# Access a service in the same namespace
curl http://nginx-service/

# Access a service in a different namespace
curl http://nginx-service.production.svc.cluster.local/
```

### CoreDNS

CoreDNS is the default DNS service in Kubernetes. It runs as a deployment in the `kube-system` namespace.

```bash
# Check CoreDNS pods
kubectl get pods -n kube-system -l k8s-app=kube-dns

# Examine CoreDNS configuration
kubectl get configmap -n kube-system coredns -o yaml
```

## Network Policies

Network Policies are a Kubernetes resource that controls the traffic flow to and from pods. They act as a firewall within the cluster.

**Note:** Network Policies are namespace-specific, and you must have a CNI plugin that supports Network Policies (such as Calico, Cilium, or Antrea).

### Example Network Policy

The following Network Policy allows inbound traffic to pods with the label `app=nginx` only from pods with the label `role=frontend`:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-frontend-to-nginx
spec:
  podSelector:
    matchLabels:
      app: nginx
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          role: frontend
    ports:
    - protocol: TCP
      port: 80
```

### Default Deny All Ingress Traffic

To create a default deny-all policy for a namespace:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
spec:
  podSelector: {}  # Selects all pods in the namespace
  policyTypes:
  - Ingress
```

### Allow All Egress Traffic

To allow all outbound traffic from all pods:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-all-egress
spec:
  podSelector: {}
  egress:
  - {}
  policyTypes:
  - Egress
```

### Common Network Policy Commands

```bash
# Create a network policy
kubectl apply -f network-policy.yaml

# Get network policies
kubectl get networkpolicies

# Describe a network policy
kubectl describe networkpolicy allow-frontend-to-nginx
```

## Ingress Resources and Controllers

Ingress exposes HTTP and HTTPS routes from outside the cluster to services within the cluster.

### Ingress Controllers

Before you can use Ingress resources, you must have an Ingress controller running in your cluster. Some popular options include:

- NGINX Ingress Controller
- HAProxy Ingress
- Traefik
- Istio
- Contour

To install the NGINX Ingress Controller:

```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.8.2/deploy/static/provider/cloud/deploy.yaml
```

### Ingress Resource

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: minimal-ingress
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  ingressClassName: nginx
  rules:
  - host: myapp.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: myapp
            port:
              number: 80
  - host: api.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: api-service
            port:
              number: 8080
```

### TLS with Ingress

To secure an Ingress with TLS:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: tls-ingress
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - myapp.example.com
    secretName: myapp-tls
  rules:
  - host: myapp.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: myapp
            port:
              number: 80
```

The TLS secret must be created separately:

```bash
kubectl create secret tls myapp-tls --cert=path/to/cert.crt --key=path/to/key.key
```

### Common Ingress Commands

```bash
# Create an Ingress resource
kubectl apply -f ingress.yaml

# Get Ingress resources
kubectl get ingress

# Describe an Ingress
kubectl describe ingress minimal-ingress
```

## Container Network Interface (CNI)

The Container Network Interface (CNI) is a standard for configuring network interfaces for Linux containers. Kubernetes uses CNI plugins to implement its networking model.

### Common CNI Plugins

1. **Calico**: Provides networking and network policy enforcement
2. **Cilium**: Layer 7 (HTTP/gRPC) aware networking and security
3. **Flannel**: Simple overlay network focused on traffic encapsulation
4. **Weave Net**: Mesh overlay network with minimal configuration
5. **Antrea**: Built on Open vSwitch to implement Kubernetes networking

### Viewing CNI Configuration

The CNI configuration is typically stored on each node at `/etc/cni/net.d/`:

```bash
# Examine CNI configuration on a node (requires SSH access to the node)
ls -la /etc/cni/net.d/
cat /etc/cni/net.d/10-calico.conflist
```

## Troubleshooting Networking Issues

Networking issues are common in Kubernetes. Here are some tools and commands to help diagnose problems:

### Pod Connectivity

```bash
# Run a temporary pod for testing network connectivity
kubectl run netshoot --rm -it --image=nicolaka/netshoot -- /bin/bash

# From inside the pod, test connectivity to a service
curl http://nginx-service

# Test DNS resolution
nslookup nginx-service
nslookup nginx-service.default.svc.cluster.local
```

### Service Connectivity

```bash
# Describe the service to check endpoint connections
kubectl describe service nginx-service

# Check the endpoints for a service
kubectl get endpoints nginx-service

# Check if pods are selected correctly
kubectl get pods -l app=nginx
```

### DNS Troubleshooting

```bash
# Check CoreDNS pods
kubectl get pods -n kube-system -l k8s-app=kube-dns

# Check DNS configuration in a pod
kubectl exec -it nginx -- cat /etc/resolv.conf

# Deploy a DNS debugging pod
kubectl apply -f https://k8s.io/examples/admin/dns/dnsutils.yaml
kubectl exec -it dnsutils -- nslookup kubernetes.default
```

### Network Policy Testing

```bash
# Test connectivity from one pod to another with labels
kubectl run frontend --image=nginx -l role=frontend
kubectl run backend --image=nginx -l app=nginx
kubectl exec -it frontend -- curl backend
```

## Sample Exam Questions

### Question 1: Create a Service

**Task**: Create a ClusterIP service named 'web-service' that exposes port 80 for a deployment named 'web-app' which is running containers that use port 8080.

**Solution**:

```bash
kubectl expose deployment web-app --name=web-service --port=80 --target-port=8080
```

Alternatively:

```bash
cat << EOF | kubectl apply -f -
apiVersion: v1
kind: Service
metadata:
  name: web-service
spec:
  selector:
    app: web-app
  ports:
  - port: 80
    targetPort: 8080
EOF
```

### Question 2: Network Policy Implementation

**Task**: Create a network policy named 'db-policy' that allows only pods with the label 'app=web' in the 'app' namespace to connect to pods with the label 'app=db' on port 3306.

**Solution**:

```bash
cat << EOF | kubectl apply -f -
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: db-policy
  namespace: app
spec:
  podSelector:
    matchLabels:
      app: db
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: web
    ports:
    - protocol: TCP
      port: 3306
EOF
```

### Question 3: Debugging Service Connectivity

**Task**: A service named 'frontend' is not able to connect to a service named 'backend'. Diagnose and fix the issue.

**Solution**:

```bash
# Step 1: Check if the backend service exists
kubectl get service backend

# Step 2: Check if the backend service has endpoints
kubectl get endpoints backend

# Step 3: Check if the selector matches any pods
kubectl describe service backend
kubectl get pods --show-labels | grep -E "$(kubectl get svc backend -o jsonpath='{.spec.selector}' | sed 's/[{},]/ /g' | sed 's/:/=/g')"

# Step 4: If no pods match the selector, check pod labels
kubectl get pods --show-labels

# Step 5: Fix the service selector or pod labels as needed
kubectl edit service backend
# Or
kubectl label pod <backend-pod-name> app=backend
```

### Question 4: Create an Ingress Resource

**Task**: Create an Ingress resource that routes traffic from 'app.example.com' to a service named 'webapp' on port 80, and traffic from 'api.example.com' to a service named 'api' on port 8080.

**Solution**:

```bash
cat << EOF | kubectl apply -f -
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: multi-ingress
spec:
  ingressClassName: nginx
  rules:
  - host: app.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: webapp
            port:
              number: 80
  - host: api.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: api
            port:
              number: 8080
EOF
```

## Key Tips for Services and Networking

1. **Master service creation**:
   - Know the differences between service types
   - Understand how selectors work to match pods
   - Learn to create services imperatively and declaratively

2. **Network Policy understanding**:
   - Be comfortable with both ingress and egress rules
   - Know how to select specific pods using podSelector
   - Understand namespace selection for cross-namespace policies

3. **DNS resolution**:
   - Memorize the DNS naming format: `<service-name>.<namespace>.svc.cluster.local`
   - Know how to troubleshoot DNS issues

4. **Troubleshooting skills**:
   - Develop a systematic approach to debugging network issues
   - Know how to check service-to-endpoint mappings
   - Be comfortable using temporary pods for testing connectivity

5. **Ingress configuration**:
   - Know how to route traffic based on hosts and paths
   - Understand how to configure TLS
   - Be familiar with common ingress annotations

## Practice Exercises

To reinforce your understanding, try these exercises in your practice environment:

1. Create a deployment and expose it using different service types (ClusterIP, NodePort)
2. Create a network policy that restricts communication between namespaces
3. Set up an Ingress resource with path-based routing
4. Deploy a headless service for a StatefulSet
5. Troubleshoot a service with no endpoints
6. Configure TLS for an Ingress resource
7. Deploy a multi-tier application with proper network isolation

## What's Next

In the next part, we'll explore Kubernetes Storage concepts, covering:
- Volumes and Volume Types
- Persistent Volumes and Persistent Volume Claims
- Storage Classes
- Volume Snapshots
- Dynamic Provisioning

👉 Continue to **[Part 5: Storage](/training/cka-prep/05-storage/)**
