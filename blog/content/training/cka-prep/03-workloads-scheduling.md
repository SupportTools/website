---
title: "CKA Prep: Part 3 – Workloads & Scheduling"
description: "Mastering Kubernetes workload resources, application configuration, and advanced scheduling for the CKA exam."
date: 2025-04-04T00:00:00-00:00
series: "CKA Exam Preparation Guide"
series_rank: 3
draft: false
tags: ["kubernetes", "cka", "workloads", "scheduling", "k8s", "exam-prep"]
categories: ["Training", "Kubernetes Certification"]
author: "Matthew Mattox"
more_link: ""
---

## Kubernetes Workload Resources

Kubernetes provides several workload resources to manage containerized applications. Understanding these resources is crucial for the CKA exam.

### Deployments

A Deployment provides declarative updates for Pods and ReplicaSets.

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
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 1
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
        resources:
          requests:
            memory: "64Mi"
            cpu: "250m"
          limits:
            memory: "128Mi"
            cpu: "500m"
```

**Key Features:**
- **Scaling**: Easily scale the number of replicas up or down
- **Rolling Updates**: Gradually update pods without downtime
- **Rollbacks**: Revert to a previous version if problems occur
- **Self-healing**: Automatically replaces failed pods

**Common Deployment Commands:**

```bash
# Create a deployment
kubectl create deployment nginx --image=nginx:1.21

# Scale a deployment
kubectl scale deployment nginx --replicas=5

# Update a deployment's image
kubectl set image deployment/nginx nginx=nginx:1.22

# Check rollout status
kubectl rollout status deployment/nginx

# View rollout history
kubectl rollout history deployment/nginx

# Rollback to a previous revision
kubectl rollout undo deployment/nginx
kubectl rollout undo deployment/nginx --to-revision=2

# Pause/Resume rollout
kubectl rollout pause deployment/nginx
kubectl rollout resume deployment/nginx
```

### DaemonSets

A DaemonSet ensures that all (or some) nodes run a copy of a Pod.

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-exporter
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: node-exporter
  template:
    metadata:
      labels:
        app: node-exporter
    spec:
      tolerations:
      - key: node-role.kubernetes.io/master
        effect: NoSchedule
      containers:
      - name: node-exporter
        image: prom/node-exporter:v1.3.1
        ports:
        - containerPort: 9100
          name: metrics
```

**Key Features:**
- Runs a pod on every node (or selected nodes)
- Automatically adds pods to new nodes as they join the cluster
- Removes pods when nodes are removed
- Useful for node-level operations (monitoring, logging, storage, etc.)

**Common DaemonSet Commands:**

```bash
# Create a DaemonSet (typically from a YAML file)
kubectl apply -f daemonset.yaml

# View DaemonSets
kubectl get daemonsets -n monitoring

# Describe a DaemonSet
kubectl describe daemonset node-exporter -n monitoring

# Delete a DaemonSet
kubectl delete daemonset node-exporter -n monitoring
```

### StatefulSets

A StatefulSet is used to manage stateful applications, providing guarantees about the ordering and uniqueness of Pods.

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: web
spec:
  serviceName: "nginx"
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
          name: web
        volumeMounts:
        - name: www
          mountPath: /usr/share/nginx/html
  volumeClaimTemplates:
  - metadata:
      name: www
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: "standard"
      resources:
        requests:
          storage: 1Gi
```

**Key Features:**
- Stable, unique network identifiers for each pod
- Stable, persistent storage for each pod
- Ordered, graceful deployment and scaling
- Ordered, automated rolling updates
- Ideal for stateful applications (databases, etc.)

**Common StatefulSet Commands:**

```bash
# Create a StatefulSet (typically from a YAML file)
kubectl apply -f statefulset.yaml

# View StatefulSets
kubectl get statefulsets

# Scale a StatefulSet
kubectl scale statefulset web --replicas=5

# Delete a StatefulSet
kubectl delete statefulset web
```

### Jobs and CronJobs

Jobs create pods that run until successful completion. CronJobs create Jobs on a schedule.

**Job Example:**

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: pi-calculation
spec:
  completions: 5      # Number of successful pod completions required
  parallelism: 2      # Number of pods to run in parallel
  backoffLimit: 6     # Number of retries before marking job failed
  template:
    spec:
      containers:
      - name: pi
        image: perl:5.34
        command: ["perl", "-Mbignum=bpi", "-wle", "print bpi(2000)"]
      restartPolicy: Never  # Important for Jobs
```

**CronJob Example:**

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: backup-database
spec:
  schedule: "0 2 * * *"   # Cron schedule format (2 AM daily)
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: backup
            image: database-backup:v1.2
            command: ["/bin/sh", "-c", "backup.sh"]
          restartPolicy: OnFailure
```

**Key Features:**
- **Jobs**: Run-to-completion workloads
- **CronJobs**: Scheduled jobs based on cron format
- Useful for batch processing, backups, and scheduled tasks

**Common Job/CronJob Commands:**

```bash
# Create a job
kubectl create job one-off --image=busybox -- date

# View jobs
kubectl get jobs

# View pods created by jobs
kubectl get pods --selector=job-name=pi-calculation

# Create a cronjob
kubectl create cronjob hello --image=busybox --schedule="*/1 * * * *" -- echo "Hello World"

# View cronjobs
kubectl get cronjobs

# View the jobs created by a cronjob
kubectl get jobs --selector=cronjob-name=hello
```

## Application Configuration

### ConfigMaps

ConfigMaps allow you to decouple configuration from container images.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  app.properties: |
    environment=production
    log_level=INFO
  ui.properties: |
    color.background=blue
    color.text=white
  DB_HOST: "mysql.example.com"
  DB_PORT: "3306"
```

**Using ConfigMaps in a Pod:**

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: config-pod
spec:
  containers:
  - name: app
    image: my-app:v1
    env:
    - name: DATABASE_HOST
      valueFrom:
        configMapKeyRef:
          name: app-config
          key: DB_HOST
    - name: DATABASE_PORT
      valueFrom:
        configMapKeyRef:
          name: app-config
          key: DB_PORT
    volumeMounts:
    - name: config-volume
      mountPath: /etc/config
  volumes:
  - name: config-volume
    configMap:
      name: app-config
```

**Common ConfigMap Commands:**

```bash
# Create a ConfigMap from literal values
kubectl create configmap app-settings --from-literal=APP_ENV=production --from-literal=APP_DEBUG=false

# Create a ConfigMap from a file
kubectl create configmap app-config --from-file=app.properties

# View ConfigMaps
kubectl get configmaps
kubectl describe configmap app-config
```

### Secrets

Secrets let you store and manage sensitive information separately from your application code.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: db-credentials
type: Opaque
data:
  username: YWRtaW4=        # base64 encoded "admin"
  password: cGFzc3dvcmQxMjM= # base64 encoded "password123"
```

**Using Secrets in a Pod:**

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: secret-pod
spec:
  containers:
  - name: app
    image: my-app:v1
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
      readOnly: true
  volumes:
  - name: secret-volume
    secret:
      secretName: db-credentials
```

**Common Secret Commands:**

```bash
# Create a Secret from literal values
kubectl create secret generic db-credentials --from-literal=username=admin --from-literal=password=password123

# View Secrets
kubectl get secrets
kubectl describe secret db-credentials

# Decode a Secret value
kubectl get secret db-credentials -o jsonpath='{.data.username}' | base64 --decode
```

## Resource Management and Limits

Properly configuring resource requests and limits is crucial for efficient cluster utilization and application performance.

### Resource Requests and Limits

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: resource-demo
spec:
  containers:
  - name: resource-container
    image: nginx
    resources:
      requests:
        memory: "64Mi"    # Memory request (what the container is guaranteed)
        cpu: "250m"       # CPU request (0.25 CPU cores)
      limits:
        memory: "128Mi"   # Memory limit (max the container can use)
        cpu: "500m"       # CPU limit (0.5 CPU cores)
```

**Key Concepts:**

- **Resource Requests**: The amount of resources guaranteed to the container
- **Resource Limits**: The maximum amount of resources the container can use
- **CPU Units**: Measured in cores or millicores (m), where 1000m = 1 core
- **Memory Units**: Measured in bytes (K, M, G, T, P, E suffixes for SI units)

### Resource Quotas

ResourceQuota objects define constraints on resource consumption per namespace.

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: compute-quota
  namespace: development
spec:
  hard:
    pods: "10"
    requests.cpu: "4"
    requests.memory: 5Gi
    limits.cpu: "8"
    limits.memory: 10Gi
    count/deployments.apps: "5"
    count/replicasets.apps: "10"
```

### LimitRanges

LimitRange objects define default, min, and max resource constraints for individual containers.

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: container-limits
  namespace: development
spec:
  limits:
  - type: Container
    default:
      cpu: 500m
      memory: 256Mi
    defaultRequest:
      cpu: 100m
      memory: 50Mi
    min:
      cpu: 50m
      memory: 10Mi
    max:
      cpu: "2"
      memory: 1Gi
```

## Advanced Scheduling Concepts

The CKA exam tests your knowledge of how to influence pod scheduling decisions.

### Node Selectors

The simplest way to constrain pods to nodes with specific labels.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: gpu-pod
spec:
  containers:
  - name: gpu-container
    image: tensorflow/tensorflow:latest-gpu
  nodeSelector:
    hardware: gpu
```

To label a node:

```bash
kubectl label nodes node1 hardware=gpu
```

### Node Affinity and Anti-Affinity

Node affinity provides more expressive pod placement constraints than nodeSelector.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: with-node-affinity
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
        - matchExpressions:
          - key: hardware
            operator: In
            values:
            - gpu
      preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 1
        preference:
          matchExpressions:
          - key: zone
            operator: In
            values:
            - us-east-1a
  containers:
  - name: with-node-affinity
    image: tensorflow/tensorflow:latest-gpu
```

**Types of Node Affinity:**

- **requiredDuringSchedulingIgnoredDuringExecution**: Hard requirement that must be met for a pod to be scheduled
- **preferredDuringSchedulingIgnoredDuringExecution**: Soft requirement that the scheduler will try to enforce but won't guarantee

### Pod Affinity and Anti-Affinity

Pod affinity/anti-affinity allows you to constrain which nodes pods can be scheduled on based on labels of pods already running on the node.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: with-pod-affinity
spec:
  affinity:
    podAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchExpressions:
          - key: app
            operator: In
            values:
            - cache
        topologyKey: kubernetes.io/hostname
    podAntiAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          labelSelector:
            matchExpressions:
            - key: app
              operator: In
              values:
              - web
          topologyKey: kubernetes.io/hostname
  containers:
  - name: with-pod-affinity
    image: nginx
```

**Key Concepts:**
- **Pod Affinity**: Schedule pods on the same node or zone as other pods
- **Pod Anti-Affinity**: Avoid scheduling pods on the same node or zone as other pods
- **topologyKey**: The key for the node label that the system uses to denote the domain

### Taints and Tolerations

Taints are properties of nodes that repel pods without matching tolerations.

**To taint a node:**

```bash
kubectl taint nodes node1 key=value:NoSchedule
```

**Pod with tolerations:**

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: with-toleration
spec:
  containers:
  - name: nginx
    image: nginx
  tolerations:
  - key: "key"
    operator: "Equal"
    value: "value"
    effect: "NoSchedule"
```

**Taint Effects:**
- **NoSchedule**: Pods won't be scheduled on the node unless they tolerate the taint
- **PreferNoSchedule**: Kubernetes will try to avoid placing pods on the node, but it's not guaranteed
- **NoExecute**: New pods won't be scheduled, and existing pods will be evicted if they don't tolerate the taint

## Sample Exam Questions

### Question 1: Pod Scheduling with Node Affinity

**Task**: Create a pod named `app-pod` using the `nginx:1.21` image that will only be scheduled on nodes with the label `disk=ssd` and preferably in the zone `us-east-1a`.

**Solution**:

```bash
cat << EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: app-pod
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
        - matchExpressions:
          - key: disk
            operator: In
            values:
            - ssd
      preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 1
        preference:
          matchExpressions:
          - key: zone
            operator: In
            values:
            - us-east-1a
  containers:
  - name: nginx
    image: nginx:1.21
EOF
```

### Question 2: Create Deployment with ConfigMap

**Task**: Create a ConfigMap named `app-config` with the values `DB_HOST=mysql` and `DB_PORT=3306`. Then create a Deployment named `web-app` with 3 replicas using the `nginx:1.21` image that uses these values as environment variables.

**Solution**:

```bash
# Create the ConfigMap
kubectl create configmap app-config --from-literal=DB_HOST=mysql --from-literal=DB_PORT=3306

# Create the Deployment
cat << EOF | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-app
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web-app
  template:
    metadata:
      labels:
        app: web-app
    spec:
      containers:
      - name: nginx
        image: nginx:1.21
        env:
        - name: DATABASE_HOST
          valueFrom:
            configMapKeyRef:
              name: app-config
              key: DB_HOST
        - name: DATABASE_PORT
          valueFrom:
            configMapKeyRef:
              name: app-config
              key: DB_PORT
EOF
```

### Question 3: DaemonSet for Monitoring

**Task**: Create a DaemonSet named `node-monitoring` that runs on all nodes including master nodes. It should use the image `prom/node-exporter:v1.3.1` and expose port 9100.

**Solution**:

```bash
cat << EOF | kubectl apply -f -
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-monitoring
spec:
  selector:
    matchLabels:
      app: node-monitoring
  template:
    metadata:
      labels:
        app: node-monitoring
    spec:
      tolerations:
      - key: node-role.kubernetes.io/control-plane
        operator: Exists
        effect: NoSchedule
      - key: node-role.kubernetes.io/master
        operator: Exists
        effect: NoSchedule
      containers:
      - name: node-exporter
        image: prom/node-exporter:v1.3.1
        ports:
        - containerPort: 9100
          name: metrics
EOF
```

### Question 4: Resource Quota Management

**Task**: Create a namespace named `development` and set a resource quota limiting the namespace to maximum 10 pods, 4 CPU cores, and 8GiB memory in total.

**Solution**:

```bash
# Create the namespace
kubectl create namespace development

# Create the ResourceQuota
cat << EOF | kubectl apply -f -
apiVersion: v1
kind: ResourceQuota
metadata:
  name: compute-quota
  namespace: development
spec:
  hard:
    pods: "10"
    requests.cpu: "4"
    requests.memory: 8Gi
    limits.cpu: "4"
    limits.memory: 8Gi
EOF
```

## Key Tips for Workloads and Scheduling

1. **Master imperative pod creation**:
   - Use `kubectl run` with various flags for quick pod creation
   - Learn the flags for attaching resources, volumes, etc.

2. **Understand deployment strategies**:
   - Know the difference between RollingUpdate and Recreate
   - Be familiar with maxSurge and maxUnavailable parameters

3. **Know when to use each workload type**:
   - **Deployments**: Stateless applications
   - **StatefulSets**: Stateful applications
   - **DaemonSets**: Node-level operations
   - **Jobs/CronJobs**: Batch processing or scheduled tasks

4. **Be efficient with ConfigMaps and Secrets**:
   - Know the different ways to use them (environment variables, volumes)
   - Remember the different creation methods (from file, from literal)

5. **Understand scheduling concepts deeply**:
   - Know the difference between node selectors, affinity, and taints/tolerations
   - Practice combined scheduling scenarios

## Practice Exercises

To reinforce your understanding, try these exercises in your practice environment:

1. Create a Deployment with specific resource requests and limits
2. Create a ConfigMap from multiple files and consume it in a pod
3. Set up node affinity rules to schedule pods on specific nodes
4. Create a DaemonSet that runs on specific nodes using node affinity
5. Implement a pod anti-affinity strategy to ensure high availability
6. Create a Job that runs multiple completions in parallel
7. Set up a CronJob that runs a backup task every day at midnight

## What's Next

In the next part, we'll explore Services and Networking in Kubernetes, covering:
- Different service types
- Network policies
- Ingress controllers and resources
- DNS configuration
- CNI plugins

👉 Continue to **[Part 4: Services & Networking](/training/cka-prep/04-services-networking/)**
