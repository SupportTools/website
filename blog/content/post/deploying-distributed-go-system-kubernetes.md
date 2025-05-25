---
title: "Deploying Distributed Go Microservices on Kubernetes: A Complete Guide with Kind"
date: 2025-12-25T09:00:00-05:00
draft: false
tags: ["golang", "kubernetes", "microservices", "distributed systems", "observability", "kind"]
categories: ["Development", "Go", "Kubernetes"]
---

## Introduction

Distributed systems have become the foundation of modern applications, offering benefits in scalability, resilience, and separation of concerns. However, deploying and managing these systems presents unique challenges. In this guide, we'll walk through deploying a complete distributed system built in Go onto Kubernetes using Kind (Kubernetes in Docker).

This article builds on concepts from a multi-part series on building distributed systems, focusing specifically on the deployment aspects. We'll deploy a microservice architecture consisting of a User Service and Order Service, along with a complete observability stack including Jaeger for distributed tracing, Prometheus for metrics, and Alertmanager for alerting.

## Why Kubernetes for Distributed Systems?

Before diving into the implementation, let's understand why Kubernetes is an excellent choice for deploying distributed applications:

1. **Service Discovery**: Kubernetes provides built-in service discovery, making it easy for microservices to find and communicate with each other.
2. **Scaling**: Horizontal scaling becomes trivial with Kubernetes' declarative approach.
3. **Self-healing**: Kubernetes automatically restarts failed containers and replaces nodes when needed.
4. **Resource Efficiency**: Bin packing algorithms ensure optimal resource utilization.
5. **Declarative Configuration**: Infrastructure-as-code approach with YAML manifests.
6. **Observability**: Native integration with monitoring and logging solutions.

## Setting Up a Local Kubernetes Environment with Kind

[Kind](https://kind.sigs.k8s.io/) (Kubernetes in Docker) allows you to run Kubernetes clusters inside Docker containers, making it perfect for local development and testing. Let's set up a Kind cluster configured for our distributed system.

### Prerequisites

Ensure you have the following installed:
- Docker
- Kind
- kubectl

### Creating the Kind Cluster

First, we'll create a configuration file that defines our Kind cluster with the necessary port mappings:

```yaml
# kind.yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    extraPortMappings:
      - containerPort: 5432 # PostgreSQL
        hostPort: 5432
      - containerPort: 50051 # User Service gRPC
        hostPort: 50051
      - containerPort: 50052 # Order Service gRPC
        hostPort: 50052
      - containerPort: 9091 # User Service metrics
        hostPort: 9091
      - containerPort: 9092 # Order Service metrics
        hostPort: 9092
      - containerPort: 16686 # Jaeger UI
        hostPort: 16686
      - containerPort: 4317 # Jaeger gRPC
        hostPort: 4317
      - containerPort: 4318 # Jaeger HTTP
        hostPort: 4318
      - containerPort: 9090 # Prometheus
        hostPort: 9090
      - containerPort: 9093 # Alertmanager
        hostPort: 9093
```

Now create the cluster with this configuration:

```bash
kind create cluster --name distributed-system --config kind.yaml
```

This command creates a Kubernetes cluster named "distributed-system" with all the required ports exposed to your local machine.

## Deploying the Database Layer

Our microservices need databases to store their data. We'll deploy a single PostgreSQL instance and create separate databases for each service.

```yaml
# postgres.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
spec:
  replicas: 1
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
        - name: postgres
          image: postgres:15
          env:
            - name: POSTGRES_USER
              value: postgres
            - name: POSTGRES_PASSWORD
              value: postgres
          ports:
            - containerPort: 5432
          resources:
            limits:
              memory: "512Mi"
              cpu: "500m"
            requests:
              memory: "256Mi"
              cpu: "250m"
          volumeMounts:
            - name: postgres-storage
              mountPath: /var/lib/postgresql/data
      volumes:
        - name: postgres-storage
          emptyDir: {}  # For demo purposes; use PVC in production
---
apiVersion: v1
kind: Service
metadata:
  name: postgres
spec:
  ports:
    - port: 5432
      targetPort: 5432
  selector:
    app: postgres
---
apiVersion: batch/v1
kind: Job
metadata:
  name: create-userdb
spec:
  template:
    spec:
      containers:
        - name: create-userdb
          image: postgres:15
          command: ["/bin/sh", "-c", "psql -U postgres -h postgres -c 'CREATE DATABASE userdb;'"]
          env:
            - name: PGPASSWORD
              value: postgres
      restartPolicy: Never
  backoffLimit: 4
---
apiVersion: batch/v1
kind: Job
metadata:
  name: create-orderdb
spec:
  template:
    spec:
      containers:
        - name: create-orderdb
          image: postgres:15
          command: ["/bin/sh", "-c", "psql -U postgres -h postgres -c 'CREATE DATABASE orderdb;'"]
          env:
            - name: PGPASSWORD
              value: postgres
      restartPolicy: Never
  backoffLimit: 4
```

Apply this configuration:

```bash
kubectl apply -f postgres.yaml
```

This creates:
1. A PostgreSQL deployment with one replica
2. A PostgreSQL service that other pods can connect to
3. Two jobs that create separate databases for the User and Order services

## Deploying the Microservices

Now, let's deploy our Go microservices. For each service, we need to:
1. Create a Dockerfile to build the container
2. Push the image to a container registry (or load it into Kind)
3. Create Kubernetes Deployment and Service resources

### User Service (userd)

First, let's look at the Deployment and Service configuration:

```yaml
# userd.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: userd
spec:
  replicas: 2  # Run two instances for high availability
  selector:
    matchLabels:
      app: userd
  template:
    metadata:
      labels:
        app: userd
    spec:
      containers:
        - name: userd
          image: yourusername/ecom-grpc-userd:0.1.0  # Replace with your image
          env:
            - name: DB_URL
              value: "postgres://postgres:postgres@postgres:5432/userdb"
            - name: JWT_SECRET
              value: "your-secret-key" # Use Kubernetes secrets in production
            - name: JAEGER_URL
              value: "jaeger:4317"
          ports:
            - name: grpc
              containerPort: 50051
            - name: metrics
              containerPort: 9091
          readinessProbe:
            tcpSocket:
              port: 50051
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            tcpSocket:
              port: 50051
            initialDelaySeconds: 15
            periodSeconds: 20
          resources:
            limits:
              cpu: "500m"
              memory: "256Mi"
            requests:
              cpu: "100m"
              memory: "128Mi"
---
apiVersion: v1
kind: Service
metadata:
  name: userd
spec:
  selector:
    app: userd
  ports:
    - name: grpc
      port: 50051
      targetPort: grpc
    - name: metrics
      port: 9091
      targetPort: metrics
  type: ClusterIP
```

This configuration:
- Creates a deployment with 2 replicas of the User Service
- Sets environment variables for database connection, JWT, and Jaeger
- Exposes both the gRPC port (50051) and metrics port (9091)
- Configures health checks using readiness and liveness probes
- Sets resource limits to prevent resource hogging

### Order Service (orderd)

Similarly for the Order Service:

```yaml
# orderd.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orderd
spec:
  replicas: 2
  selector:
    matchLabels:
      app: orderd
  template:
    metadata:
      labels:
        app: orderd
    spec:
      containers:
        - name: orderd
          image: yourusername/ecom-grpc-orderd:0.1.0  # Replace with your image
          env:
            - name: DB_URL
              value: "postgres://postgres:postgres@postgres:5432/orderdb"
            - name: USER_SERVICE_URL
              value: "userd:50051"  # Service discovery via Kubernetes DNS
            - name: JAEGER_URL
              value: "jaeger:4317"
          ports:
            - name: grpc
              containerPort: 50052
            - name: metrics
              containerPort: 9092
          readinessProbe:
            tcpSocket:
              port: 50052
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            tcpSocket:
              port: 50052
            initialDelaySeconds: 15
            periodSeconds: 20
          resources:
            limits:
              cpu: "500m"
              memory: "256Mi"
            requests:
              cpu: "100m"
              memory: "128Mi"
---
apiVersion: v1
kind: Service
metadata:
  name: orderd
spec:
  selector:
    app: orderd
  ports:
    - name: grpc
      port: 50052
      targetPort: grpc
    - name: metrics
      port: 9092
      targetPort: metrics
  type: ClusterIP
```

Note how the Order Service references the User Service using Kubernetes DNS (`userd:50051`). This is one of the key benefits of Kubernetes—automatic service discovery.

Apply these configurations:

```bash
kubectl apply -f userd.yaml
kubectl apply -f orderd.yaml
```

## Deploying the Observability Stack

A robust observability stack is essential for distributed systems. We'll deploy:

1. Jaeger for distributed tracing
2. Prometheus for metrics collection
3. Alertmanager for alerts

### Jaeger

```yaml
# jaeger.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: jaeger
spec:
  replicas: 1
  selector:
    matchLabels:
      app: jaeger
  template:
    metadata:
      labels:
        app: jaeger
    spec:
      containers:
        - name: jaeger
          image: jaegertracing/all-in-one:latest
          ports:
            - name: ui
              containerPort: 16686
            - name: grpc
              containerPort: 4317
            - name: http
              containerPort: 4318
          env:
            - name: COLLECTOR_OTLP_ENABLED
              value: "true"
          resources:
            limits:
              cpu: "1000m"
              memory: "1Gi"
            requests:
              cpu: "500m"
              memory: "512Mi"
---
apiVersion: v1
kind: Service
metadata:
  name: jaeger
spec:
  selector:
    app: jaeger
  ports:
    - name: ui
      port: 16686
      targetPort: ui
    - name: grpc
      port: 4317
      targetPort: grpc
    - name: http
      port: 4318
      targetPort: http
  type: ClusterIP
```

### Prometheus

```yaml
# prometheus.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-config
data:
  prometheus.yml: |
    global:
      scrape_interval: 15s

    alerting:
      alertmanagers:
        - static_configs:
            - targets: ["alertmanager:9093"]

    rule_files:
      - "/etc/prometheus/alert_rules.yml"

    scrape_configs:
      - job_name: "userd"
        static_configs:
          - targets: ["userd:9091"]
        metrics_path: /metrics

      - job_name: "orderd"
        static_configs:
          - targets: ["orderd:9092"]
        metrics_path: /metrics

  alert_rules.yml: |
    groups:
      - name: userd
        rules:
          - alert: HighInvalidLoginAttempts
            expr: increase(userd_invalid_login_attempts_total[5m]) > 5
            for: 1m
            labels:
              severity: warning
            annotations:
              summary: "High number of invalid login attempts"
              description: "More than 5 invalid login attempts in 5 minutes"
              
      - name: orderd
        rules:
          - alert: HighOrderErrorRate
            expr: rate(orderd_errors_total[5m]) / rate(orderd_requests_total[5m]) > 0.05
            for: 2m
            labels:
              severity: critical
            annotations:
              summary: "High error rate in Order Service"
              description: "Error rate is above 5% for the last 2 minutes"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: prometheus
spec:
  replicas: 1
  selector:
    matchLabels:
      app: prometheus
  template:
    metadata:
      labels:
        app: prometheus
    spec:
      containers:
        - name: prometheus
          image: prom/prometheus:v2.40.0
          args:
            - "--config.file=/etc/prometheus/prometheus.yml"
            - "--storage.tsdb.path=/prometheus"
          ports:
            - containerPort: 9090
          volumeMounts:
            - name: prometheus-config
              mountPath: /etc/prometheus
      volumes:
        - name: prometheus-config
          configMap:
            name: prometheus-config
---
apiVersion: v1
kind: Service
metadata:
  name: prometheus
spec:
  selector:
    app: prometheus
  ports:
    - name: prometheus
      port: 9090
      targetPort: 9090
  type: ClusterIP
```

### Alertmanager

```yaml
# alertmanager.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: alertmanager-config
data:
  alertmanager.yml: |
    global:
      resolve_timeout: 5m

    route:
      group_by: ['alertname']
      group_wait: 10s
      group_interval: 10s
      repeat_interval: 1h
      receiver: 'slack'

    receivers:
    - name: 'slack'
      slack_configs:
      - api_url: 'https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK'  # Replace with your Slack webhook
        channel: '#alerts'
        send_resolved: true
        title: '{{ .GroupLabels.alertname }}'
        text: "{{ range .Alerts }}{{ .Annotations.description }}\n{{ end }}"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: alertmanager
spec:
  replicas: 1
  selector:
    matchLabels:
      app: alertmanager
  template:
    metadata:
      labels:
        app: alertmanager
    spec:
      containers:
        - name: alertmanager
          image: prom/alertmanager:v0.25.0
          args:
            - "--config.file=/etc/alertmanager/alertmanager.yml"
          ports:
            - containerPort: 9093
          volumeMounts:
            - name: config-volume
              mountPath: /etc/alertmanager
      volumes:
        - name: config-volume
          configMap:
            name: alertmanager-config
---
apiVersion: v1
kind: Service
metadata:
  name: alertmanager
spec:
  selector:
    app: alertmanager
  ports:
    - name: alertmanager
      port: 9093
      targetPort: 9093
  type: ClusterIP
```

Apply these configurations:

```bash
kubectl apply -f jaeger.yaml
kubectl apply -f prometheus.yaml
kubectl apply -f alertmanager.yaml
```

## Building Resilience into Your Deployment

Kubernetes offers several mechanisms to make your distributed system more resilient:

### 1. Liveness and Readiness Probes

We've already included these in our service deployments. They help Kubernetes determine:
- If a container is alive (liveness probe)
- If it's ready to receive traffic (readiness probe)

### 2. Pod Disruption Budgets (PDBs)

PDBs ensure a minimum number of pods are available during voluntary disruptions like node maintenance:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: userd-pdb
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: userd
```

### 3. Horizontal Pod Autoscaling

Automatically scale services based on CPU or memory usage:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: userd-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: userd
  minReplicas: 2
  maxReplicas: 5
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

## Service Mesh (Optional Enhancement)

For more advanced service-to-service communication features, you might consider adding a service mesh like Linkerd or Istio. This provides:

- Advanced traffic management
- Enhanced security with mTLS
- More detailed metrics
- Circuit breaking
- Request retries

Here's an example of how you might enhance the User Service with Linkerd annotations:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: userd
spec:
  template:
    metadata:
      annotations:
        linkerd.io/inject: enabled  # Auto-inject Linkerd proxy sidecar
        config.linkerd.io/proxy-cpu-limit: "0.2"
        config.linkerd.io/proxy-cpu-request: "0.1"
        config.linkerd.io/proxy-memory-limit: "128Mi"
        config.linkerd.io/proxy-memory-request: "64Mi"
```

## Testing the Deployment

Once everything is deployed, let's verify that our system is working properly:

### Check Pods Status

```bash
kubectl get pods
```

You should see all pods running:

```
NAME                           READY   STATUS    RESTARTS   AGE
postgres-7b8d4d6969-x7bj7      1/1     Running   0          15m
userd-5bf8c7f966-qpxl4         1/1     Running   0          10m
userd-5bf8c7f966-t2csm         1/1     Running   0          10m
orderd-7cbf96c8bd-2hfgn        1/1     Running   0          10m
orderd-7cbf96c8bd-9bjt3        1/1     Running   0          10m
jaeger-78b6f8fdbc-lqjnf        1/1     Running   0          8m
prometheus-65bcf46cd9-7k2c7    1/1     Running   0          8m
alertmanager-76f946fbf7-8x9lt  1/1     Running   0          8m
```

### Port-Forwarding for UIs

To access the UIs for Jaeger, Prometheus, and Alertmanager, you can use port-forwarding:

```bash
# Jaeger UI
kubectl port-forward svc/jaeger 16686:16686

# Prometheus
kubectl port-forward svc/prometheus 9090:9090 

# Alertmanager
kubectl port-forward svc/alertmanager 9093:9093
```

### Test gRPC Services

To test the gRPC services, you can use a tool like `grpcurl`:

```bash
# List User Service methods
grpcurl -plaintext localhost:50051 list

# List Order Service methods
grpcurl -plaintext localhost:50052 list
```

## Potential Issues and Troubleshooting

When deploying distributed systems on Kubernetes, several common issues may arise:

1. **Services can't communicate**: Check that service names are correct in environment variables and that DNS is working.

   ```bash
   # Debug DNS issues
   kubectl run -it --rm debug --image=busybox -- sh
   # Then try nslookup
   nslookup userd
   ```

2. **Database connection issues**: Verify database credentials and connection strings.

   ```bash
   # Check database logs
   kubectl logs $(kubectl get pod -l app=postgres -o jsonpath='{.items[0].metadata.name}')
   ```

3. **Tracing or metrics not showing up**: Check that the services are correctly configured to send data to Jaeger and Prometheus.

   ```bash
   # Check if metrics endpoints are accessible
   kubectl exec -it $(kubectl get pod -l app=userd -o jsonpath='{.items[0].metadata.name}') -- curl localhost:9091/metrics
   ```

4. **Out of memory errors**: Adjust resource limits and requests to match your application's actual needs.

## Production Considerations

When moving this setup to production, consider these additional steps:

1. **Secrets Management**: Use Kubernetes Secrets or external solutions like Vault for sensitive data.

   ```yaml
   apiVersion: v1
   kind: Secret
   metadata:
     name: db-credentials
   type: Opaque
   stringData:
     username: postgres
     password: secure-password
   ```

2. **Persistent Storage**: Use proper persistent volumes for databases.

   ```yaml
   apiVersion: v1
   kind: PersistentVolumeClaim
   metadata:
     name: postgres-data
   spec:
     accessModes:
       - ReadWriteOnce
     resources:
       requests:
         storage: 10Gi
     storageClassName: standard
   ```

3. **Network Policies**: Restrict pod-to-pod communication.

   ```yaml
   apiVersion: networking.k8s.io/v1
   kind: NetworkPolicy
   metadata:
     name: userd-network-policy
   spec:
     podSelector:
       matchLabels:
         app: userd
     policyTypes:
     - Ingress
     ingress:
     - from:
       - podSelector:
           matchLabels:
             app: orderd
       ports:
       - protocol: TCP
         port: 50051
   ```

4. **Resource Optimization**: Use vertical pod autoscaling to right-size your workloads.

5. **Multi-zone Deployment**: Spread your workloads across multiple zones for higher availability.

## Going Beyond: CI/CD Integration

To complete your Kubernetes setup, integrating a CI/CD pipeline is essential. Here's a simplified GitHub Actions workflow example:

```yaml
name: Deploy to Kubernetes

on:
  push:
    branches: [ main ]

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    
    steps:
    - uses: actions/checkout@v3
    
    - name: Build and push User Service
      uses: docker/build-push-action@v2
      with:
        context: ./userd
        push: true
        tags: yourusername/ecom-grpc-userd:${{ github.sha }}
    
    - name: Build and push Order Service
      uses: docker/build-push-action@v2
      with:
        context: ./orderd
        push: true
        tags: yourusername/ecom-grpc-orderd:${{ github.sha }}
    
    - name: Update Kubernetes deployments
      run: |
        # Update image tags in deployment files
        sed -i 's|yourusername/ecom-grpc-userd:.*|yourusername/ecom-grpc-userd:${{ github.sha }}|' kubernetes/userd.yaml
        sed -i 's|yourusername/ecom-grpc-orderd:.*|yourusername/ecom-grpc-orderd:${{ github.sha }}|' kubernetes/orderd.yaml
        
        # Apply updated deployments
        kubectl apply -f kubernetes/userd.yaml
        kubectl apply -f kubernetes/orderd.yaml
```

## Conclusion

Deploying distributed systems on Kubernetes offers numerous advantages in terms of scalability, resilience, and manageability. By following the approach outlined in this article, you can:

1. Deploy your Go microservices with proper resource allocation and health checking
2. Set up comprehensive observability with distributed tracing and metrics
3. Implement alerts to proactively address issues
4. Scale your services based on load
5. Make your system resilient against failures

As your system grows, Kubernetes provides the tools and patterns needed to manage complexity and ensure reliability. The declarative approach to infrastructure means your deployments remain consistent and reproducible, while the rich ecosystem of tools helps address the unique challenges of distributed systems.

Remember that distributed systems are inherently complex, and observability is your best friend in understanding how they behave in production. The combination of tracing, metrics, and logs gives you a complete picture of your system's health and performance.

By embracing these practices, you're well on your way to building and operating production-grade distributed systems that can scale with your business needs.