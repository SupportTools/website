---
title: "From Docker Compose to Kubernetes: A Pragmatic Migration Guide"
date: 2026-01-13T09:00:00-05:00
draft: false
tags: ["Kubernetes", "Docker", "Docker Compose", "Kompose", "Migration", "DevOps", "Containers"]
categories:
- Kubernetes
- Docker
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A practical, step-by-step guide for migrating your Docker Compose applications to Kubernetes with minimal effort, focusing on real-world examples and best practices"
more_link: "yes"
url: "/docker-compose-to-kubernetes-migration-guide/"
---

You've got a working Docker Compose setup, but it's getting unwieldy as your application grows. Kubernetes offers the scaling and orchestration features you need, but the migration path seems daunting. This guide provides a pragmatic, no-nonsense approach to moving from Docker Compose to Kubernetes without rewriting your entire application stack.

<!--more-->

## Introduction: Why Migrate from Docker Compose to Kubernetes?

Docker Compose is excellent for local development and simple deployments, but it has limitations when it comes to:

- Horizontal scaling of services
- Rolling updates with zero downtime
- Auto-healing of failed containers
- Complex networking and load balancing
- Resource constraints and advanced scheduling

If your `docker-compose.yml` file has grown to manage multiple interconnected services, or you need more robust orchestration capabilities, Kubernetes offers a solution that can grow with your application.

But the question remains: can you migrate without starting from scratch? The answer is yes, and we'll show you how.

## Section 1: Understanding the Core Differences

Before diving into the migration, let's clarify some key conceptual differences:

| Docker Compose Concept | Kubernetes Equivalent |
|----------------------|----------------------|
| Service              | Deployment + Service |
| Container            | Pod                  |
| Volume               | PersistentVolume + PersistentVolumeClaim |
| Network              | Service + NetworkPolicy |
| depends_on           | No direct equivalent (use init containers or readiness probes) |
| restart: always      | restartPolicy: Always |
| environment          | env or ConfigMap     |
| secrets              | Secret               |

Understanding these differences helps you anticipate what your Kubernetes manifests will look like.

## Section 2: Starting with a Typical Docker Compose Setup

Let's begin with a common Docker Compose setup – a web application with a database backend:

```yaml
version: '3'
services:
  web:
    image: my-node-app:latest
    build: ./app
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - DB_HOST=mongo
      - DB_PORT=27017
      - DB_NAME=mydatabase
    depends_on:
      - mongo
    restart: always
    volumes:
      - ./app/data:/app/data

  mongo:
    image: mongo:5.0
    ports:
      - "27017:27017"
    volumes:
      - mongo-data:/data/db
    restart: always
    environment:
      - MONGO_INITDB_ROOT_USERNAME=admin
      - MONGO_INITDB_ROOT_PASSWORD=password

volumes:
  mongo-data:
```

This setup works fine for development and small deployments, but lacks the robustness needed for production-scale operations.

## Section 3: Migrating with Kompose - The Easy Way

[Kompose](https://kompose.io/) is a conversion tool that transforms Docker Compose files into Kubernetes manifests. It's not perfect, but it gives you a solid starting point.

### Installing Kompose

Choose your operating system:

**macOS:**
```bash
brew install kompose
```

**Linux:**
```bash
curl -L https://github.com/kubernetes/kompose/releases/download/v1.26.1/kompose-linux-amd64 -o kompose
chmod +x kompose
sudo mv kompose /usr/local/bin
```

**Windows:**
```bash
curl -L https://github.com/kubernetes/kompose/releases/download/v1.26.1/kompose-windows-amd64.exe -o kompose.exe
# Add to your PATH
```

### Converting Your Docker Compose File

With Kompose installed, conversion is straightforward:

```bash
kompose convert -f docker-compose.yml
```

This command generates several Kubernetes YAML files:

- `web-deployment.yaml` - Defines the web application deployment
- `web-service.yaml` - Exposes the web application
- `mongo-deployment.yaml` - Defines the MongoDB deployment
- `mongo-service.yaml` - Exposes MongoDB internally
- `mongo-data-persistentvolumeclaim.yaml` - For persistent storage

Let's examine what these files contain and how they map to our Docker Compose setup.

### Understanding the Generated Files

A typical generated deployment file looks like this:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  annotations:
    kompose.cmd: kompose convert -f docker-compose.yml
    kompose.version: 1.26.1
  name: web
spec:
  replicas: 1
  selector:
    matchLabels:
      io.kompose.service: web
  template:
    metadata:
      labels:
        io.kompose.service: web
    spec:
      containers:
        - env:
            - name: DB_HOST
              value: mongo
            - name: DB_NAME
              value: mydatabase
            - name: DB_PORT
              value: "27017"
            - name: NODE_ENV
              value: production
          image: my-node-app:latest
          name: web
          ports:
            - containerPort: 3000
          resources: {}
          volumeMounts:
            - mountPath: /app/data
              name: web-claim0
      restartPolicy: Always
      volumes:
        - name: web-claim0
          persistentVolumeClaim:
            claimName: web-claim0
```

And a generated service file:

```yaml
apiVersion: v1
kind: Service
metadata:
  annotations:
    kompose.cmd: kompose convert -f docker-compose.yml
    kompose.version: 1.26.1
  name: web
spec:
  ports:
    - port: 3000
      targetPort: 3000
  selector:
    io.kompose.service: web
```

## Section 4: Improving the Generated Manifests

While Kompose gives us a good start, we should make several improvements for a production-ready setup:

### 1. Organize Your Manifests

First, let's organize our files into a more maintainable structure:

```bash
mkdir -p k8s/{deployments,services,config,storage}
mv *deployment.yaml k8s/deployments/
mv *service.yaml k8s/services/
mv *persistentvolumeclaim.yaml k8s/storage/
```

### 2. Add Resource Limits

Add resource constraints to prevent any single pod from consuming all cluster resources:

```yaml
# In web-deployment.yaml
resources:
  limits:
    cpu: "500m"
    memory: "512Mi"
  requests:
    cpu: "100m"
    memory: "128Mi"
```

### 3. Implement Health Checks

Add readiness and liveness probes to ensure Kubernetes can detect and recover from application failures:

```yaml
# In web-deployment.yaml
livenessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 30
  periodSeconds: 10
readinessProbe:
  httpGet:
    path: /ready
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 5
```

### 4. Extract Configuration to ConfigMaps

Move environment variables to ConfigMaps for better configuration management:

```yaml
# Create new file: k8s/config/web-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: web-config
data:
  NODE_ENV: "production"
  DB_HOST: "mongo"
  DB_PORT: "27017"
  DB_NAME: "mydatabase"

# In web-deployment.yaml, replace individual env vars with:
envFrom:
  - configMapRef:
      name: web-config
```

### 5. Secure Sensitive Data with Secrets

For sensitive values like database credentials, use Kubernetes Secrets:

```yaml
# Create new file: k8s/config/mongo-secrets.yaml
apiVersion: v1
kind: Secret
metadata:
  name: mongo-secrets
type: Opaque
data:
  MONGO_INITDB_ROOT_USERNAME: YWRtaW4=  # base64 encoded "admin"
  MONGO_INITDB_ROOT_PASSWORD: cGFzc3dvcmQ=  # base64 encoded "password"

# In mongo-deployment.yaml, reference these secrets:
envFrom:
  - secretRef:
      name: mongo-secrets
```

### 6. Configure Proper Service Types

Adjust service types based on exposure requirements:

```yaml
# For internal services (like databases)
# In mongo-service.yaml
spec:
  type: ClusterIP  # Only accessible within the cluster
  
# For public-facing services
# In web-service.yaml
spec:
  type: LoadBalancer  # Accessible externally
  # OR
  type: NodePort  # Accessible on a specific port on each node
```

## Section 5: Deploying to a Kubernetes Cluster

Now let's deploy our improved manifests to a Kubernetes cluster. For local testing, you can use:

- [Minikube](https://minikube.sigs.k8s.io/docs/start/) - A lightweight Kubernetes implementation
- [kind](https://kind.sigs.k8s.io/) - Kubernetes in Docker
- [Docker Desktop](https://www.docker.com/products/docker-desktop) - Bundled Kubernetes setup

### Setting Up a Local Cluster

```bash
# With Minikube
minikube start --memory=4096 --cpus=2

# OR with kind
kind create cluster --name my-cluster

# Verify it's running
kubectl cluster-info
```

### Applying Your Manifests

Apply configuration files first, then storage, and finally deployments and services:

```bash
# Apply in the right order
kubectl apply -f k8s/config/
kubectl apply -f k8s/storage/
kubectl apply -f k8s/deployments/
kubectl apply -f k8s/services/

# Or apply everything at once
kubectl apply -f k8s/
```

### Verifying Deployment

Check that everything is running correctly:

```bash
# Check pods
kubectl get pods

# Check services
kubectl get services

# View detailed information about a specific deployment
kubectl describe deployment web

# View logs from a specific pod
kubectl logs <pod-name>
```

### Accessing Your Application

To access your application locally:

```bash
# If using Minikube with a LoadBalancer service
minikube service web

# If using NodePort
kubectl get service web -o jsonpath='{.spec.ports[0].nodePort}'
# Then access at: http://localhost:<nodePort>

# For ClusterIP services, you can port-forward
kubectl port-forward service/web 3000:3000
# Then access at: http://localhost:3000
```

## Section 6: Advanced Kubernetes Features

Once your basic migration is complete, you can leverage more advanced Kubernetes features:

### Horizontal Pod Autoscaling

Scale your application based on CPU or memory usage:

```yaml
# Create new file: k8s/autoscaling/web-hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: web-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: web
  minReplicas: 2
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

Apply with:

```bash
kubectl apply -f k8s/autoscaling/web-hpa.yaml
```

### Implementing Ingress for Better Routing

Instead of exposing services directly, use Ingress for HTTP routing:

```yaml
# Create new file: k8s/networking/web-ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web-ingress
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  rules:
  - host: myapp.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: web
            port:
              number: 3000
```

You'll need an Ingress controller like NGINX or Traefik installed in your cluster.

### StatefulSets for Databases

For databases like MongoDB that need stable network identities and persistent storage, consider using StatefulSets instead of Deployments:

```yaml
# Replace mongo-deployment.yaml with k8s/stateful/mongo-statefulset.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mongo
spec:
  serviceName: "mongo"
  replicas: 1
  selector:
    matchLabels:
      app: mongo
  template:
    metadata:
      labels:
        app: mongo
    spec:
      containers:
      - name: mongo
        image: mongo:5.0
        ports:
        - containerPort: 27017
        envFrom:
        - secretRef:
            name: mongo-secrets
        volumeMounts:
        - name: mongo-data
          mountPath: /data/db
  volumeClaimTemplates:
  - metadata:
      name: mongo-data
    spec:
      accessModes: [ "ReadWriteOnce" ]
      resources:
        requests:
          storage: 10Gi
```

## Section 7: Common Migration Challenges and Solutions

### Challenge 1: Dependency Ordering

Docker Compose's `depends_on` doesn't have a direct equivalent in Kubernetes. Instead, use:

1. **Init Containers**: Run setup tasks before the main container starts
   ```yaml
   initContainers:
   - name: wait-for-mongo
     image: busybox
     command: ['sh', '-c', 'until nc -z mongo 27017; do echo waiting for mongo; sleep 2; done;']
   ```

2. **Readiness Probes**: Prevent services from receiving traffic until they're ready
   ```yaml
   readinessProbe:
     exec:
       command:
       - mongo
       - --eval
       - "db.adminCommand('ping')"
     initialDelaySeconds: 10
     periodSeconds: 5
   ```

### Challenge 2: Volume Mapping

Docker Compose's simple volume mappings can be more complex in Kubernetes:

1. **For development with local files**: Use a PersistentVolume with `hostPath` (not recommended for production)

2. **For production**: Use managed storage services like:
   - AWS EBS volumes
   - Google Cloud Persistent Disks
   - Azure Disk
   - Or use your cloud provider's StorageClass for dynamic provisioning

### Challenge 3: Environment-Specific Configuration

Use Kubernetes namespaces and context-based configurations:

```bash
# Create namespaces
kubectl create namespace development
kubectl create namespace production

# Apply to specific namespace
kubectl apply -f k8s/ -n development

# Use Kustomize for environment-specific overrides
# Create overlays/development and overlays/production directories
```

## Section 8: Production Readiness Checklist

Before considering your migration complete, ensure you've addressed:

1. **Security**
   - [x] Sensitive data stored in Secrets
   - [x] Network Policies to restrict pod-to-pod communication
   - [x] RBAC for API access control
   - [x] Container security (non-root users, read-only filesystems)

2. **Reliability**
   - [x] Health checks for all services
   - [x] Resource limits and requests defined
   - [x] Pod disruption budgets for critical services
   - [x] Multiple replicas for high availability

3. **Observability**
   - [x] Logging strategy (centralized logs)
   - [x] Metrics collection (Prometheus)
   - [x] Tracing for distributed systems (Jaeger/OpenTelemetry)
   - [x] Monitoring and alerting

4. **Performance**
   - [x] Horizontal Pod Autoscaling
   - [x] Vertical Pod Autoscaling (for resource optimization)
   - [x] Proper resource allocation

## Conclusion: The Path Forward

Migrating from Docker Compose to Kubernetes doesn't have to be an all-or-nothing approach. Start with the simplest services, learn from the process, and gradually move more complex parts of your stack.

Remember that Kubernetes introduces new concepts and complexities, but these are balanced by powerful features that enable scaling, resilience, and operational excellence. The initial investment in learning and migration pays off in the long run with a more robust, scalable infrastructure.

For further Kubernetes exploration, consider:

1. **GitOps workflows** with tools like ArgoCD or Flux
2. **Service Mesh** implementations like Istio or Linkerd
3. **Operator patterns** for complex application lifecycle management

The journey from Docker Compose to Kubernetes might start with a simple afternoon of conversion using Kompose, but it opens the door to a much richer ecosystem of container orchestration capabilities.

## Sample Complete Migration Repository

To help you get started, here's a minimal directory structure for your Kubernetes manifests after migration:

```
k8s/
├── config/
│   ├── web-configmap.yaml
│   └── mongo-secrets.yaml
├── deployments/
│   └── web-deployment.yaml
├── services/
│   ├── web-service.yaml
│   └── mongo-service.yaml
├── storage/
│   └── mongo-data-persistentvolumeclaim.yaml
├── stateful/
│   └── mongo-statefulset.yaml
└── networking/
    └── web-ingress.yaml
```

With this structure, you can apply the entire configuration or selectively update components as needed, making your migration to Kubernetes manageable and incremental.