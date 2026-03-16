---
title: "Chaos Engineering Implementation with Litmus on Kubernetes"
date: 2026-05-09T00:00:00-05:00
draft: false
tags: ["Chaos Engineering", "Litmus", "Kubernetes", "Reliability", "Site Reliability Engineering", "Fault Injection", "Testing", "Observability", "Incident Response", "DevOps"]
categories:
- Chaos Engineering
- Kubernetes
- Site Reliability Engineering
- Testing
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing chaos engineering with Litmus on Kubernetes, including experiment design, failure scenario testing, automated chaos testing in CI/CD, and incident response automation."
more_link: "yes"
url: "/chaos-engineering-implementation-litmus-kubernetes/"
---

Chaos engineering represents a proactive approach to building resilient systems by intentionally introducing failures to uncover weaknesses before they manifest in production. This comprehensive guide explores implementing chaos engineering using Litmus on Kubernetes, providing production-ready strategies for building antifragile distributed systems.

<!--more-->

# Understanding Chaos Engineering Fundamentals

Chaos engineering operates on the principle that complex distributed systems will inevitably fail. Rather than waiting for these failures to occur naturally, chaos engineering proactively introduces controlled failures to validate system resilience and discover unknown failure modes.

## Core Principles of Chaos Engineering

### Hypothesis-Driven Experimentation

Chaos experiments begin with forming hypotheses about system behavior under failure conditions:

```yaml
# Example Chaos Experiment Hypothesis
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosExperiment
metadata:
  name: pod-delete-hypothesis
  namespace: litmus
spec:
  definition:
    scope: Namespaced
    permissions:
      - apiGroups: [""]
        resources: ["pods"]
        verbs: ["create", "delete", "get", "list", "patch", "update"]
    image: "litmuschaos/go-runner:latest"
    imagePullPolicy: Always
    args:
      - -c
      - ./experiments -name pod-delete
    command:
      - /bin/bash
    env:
      - name: TOTAL_CHAOS_DURATION
        value: "15"
      - name: RAMP_TIME
        value: "0"
      - name: FORCE
        value: "true"
      - name: CHAOS_INTERVAL
        value: "5"
      - name: LIB
        value: "litmus"
    labels:
      name: pod-delete
      app.kubernetes.io/part-of: litmus
      app.kubernetes.io/component: experiment-job
      app.kubernetes.io/version: latest
    secrets:
      - name: pod-delete-secret
        mountPath: /tmp/
```

### Blast Radius Control

Effective chaos engineering requires careful control of the experiment scope to prevent cascading failures:

```go
package chaos

import (
    "context"
    "fmt"
    "time"

    "k8s.io/client-go/kubernetes"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/labels"
)

type BlastRadiusController struct {
    clientset    kubernetes.Interface
    maxPods      int
    maxNodes     int
    namespace    string
    labelSelector string
}

func NewBlastRadiusController(
    clientset kubernetes.Interface,
    maxPods, maxNodes int,
    namespace, labelSelector string,
) *BlastRadiusController {
    return &BlastRadiusController{
        clientset:     clientset,
        maxPods:       maxPods,
        maxNodes:      maxNodes,
        namespace:     namespace,
        labelSelector: labelSelector,
    }
}

func (b *BlastRadiusController) ValidateBlastRadius(ctx context.Context) error {
    // Check pod count within blast radius
    podList, err := b.clientset.CoreV1().Pods(b.namespace).List(ctx, metav1.ListOptions{
        LabelSelector: b.labelSelector,
    })
    if err != nil {
        return fmt.Errorf("failed to list pods: %w", err)
    }

    if len(podList.Items) > b.maxPods {
        return fmt.Errorf("blast radius too large: %d pods exceed maximum of %d", 
                         len(podList.Items), b.maxPods)
    }

    // Check node distribution
    nodeMap := make(map[string]int)
    for _, pod := range podList.Items {
        nodeMap[pod.Spec.NodeName]++
    }

    if len(nodeMap) > b.maxNodes {
        return fmt.Errorf("blast radius spans too many nodes: %d nodes exceed maximum of %d", 
                         len(nodeMap), b.maxNodes)
    }

    return nil
}

func (b *BlastRadiusController) CalculateImpactPercentage(ctx context.Context) (float64, error) {
    // Get total pods in namespace
    allPods, err := b.clientset.CoreV1().Pods(b.namespace).List(ctx, metav1.ListOptions{})
    if err != nil {
        return 0, fmt.Errorf("failed to list all pods: %w", err)
    }

    // Get pods in blast radius
    targetPods, err := b.clientset.CoreV1().Pods(b.namespace).List(ctx, metav1.ListOptions{
        LabelSelector: b.labelSelector,
    })
    if err != nil {
        return 0, fmt.Errorf("failed to list target pods: %w", err)
    }

    if len(allPods.Items) == 0 {
        return 0, nil
    }

    percentage := (float64(len(targetPods.Items)) / float64(len(allPods.Items))) * 100
    return percentage, nil
}
```

# Litmus Setup and Configuration

Litmus provides a comprehensive chaos engineering platform specifically designed for Kubernetes environments. Let's explore detailed setup and configuration strategies.

## Installing Litmus Operator

### Helm Installation

```bash
# Add Litmus Helm repository
helm repo add litmuschaos https://litmuschaos.github.io/litmus-helm/
helm repo update

# Create namespace for Litmus
kubectl create namespace litmus

# Install Litmus with custom values
cat <<EOF > litmus-values.yaml
portal:
  frontend:
    service:
      type: ClusterIP
    ingress:
      enabled: true
      annotations:
        nginx.ingress.kubernetes.io/rewrite-target: /
        cert-manager.io/cluster-issuer: "letsencrypt-prod"
      hosts:
        - host: chaos.example.com
          paths:
            - path: /
              pathType: Prefix
      tls:
        - secretName: chaos-tls
          hosts:
            - chaos.example.com

  server:
    service:
      type: ClusterIP
    ingress:
      enabled: true
      annotations:
        nginx.ingress.kubernetes.io/rewrite-target: /
        cert-manager.io/cluster-issuer: "letsencrypt-prod"
      hosts:
        - host: chaos-api.example.com
          paths:
            - path: /
              pathType: Prefix
      tls:
        - secretName: chaos-api-tls
          hosts:
            - chaos-api.example.com

  mongo:
    persistence:
      enabled: true
      size: 20Gi
      storageClass: "fast-ssd"

adminConfig:
  DBPASSWORD: "your-secure-password"
  DBUSER: "admin"
  VERSION: "3.0.0"
EOF

# Install Litmus
helm install litmus litmuschaos/litmus \
  --namespace litmus \
  --values litmus-values.yaml \
  --create-namespace
```

### Kubernetes Manifest Installation

```yaml
# litmus-operator.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: litmus
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: litmus-admin
  namespace: litmus
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: litmus-admin
rules:
  - apiGroups: [""]
    resources: ["pods", "events", "configmaps", "secrets", "services"]
    verbs: ["create", "delete", "get", "list", "patch", "update", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "daemonsets", "replicasets", "statefulsets"]
    verbs: ["create", "delete", "get", "list", "patch", "update", "watch"]
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["create", "delete", "get", "list", "patch", "update", "watch"]
  - apiGroups: ["litmuschaos.io"]
    resources: ["chaosengines", "chaosexperiments", "chaosresults"]
    verbs: ["create", "delete", "get", "list", "patch", "update", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: litmus-admin
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: litmus-admin
subjects:
  - kind: ServiceAccount
    name: litmus-admin
    namespace: litmus
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: chaos-operator-ce
  namespace: litmus
spec:
  replicas: 1
  selector:
    matchLabels:
      name: chaos-operator
  template:
    metadata:
      labels:
        name: chaos-operator
    spec:
      serviceAccountName: litmus-admin
      containers:
        - name: chaos-operator
          image: litmuschaos/chaos-operator:3.0.0
          command:
            - chaos-operator
          imagePullPolicy: Always
          env:
            - name: CHAOS_RUNNER_IMAGE
              value: "litmuschaos/chaos-runner:3.0.0"
            - name: WATCH_NAMESPACE
              value: ""
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: OPERATOR_NAME
              value: "chaos-operator"
          ports:
            - containerPort: 8080
              name: http-metrics
```

## Advanced Configuration

### Custom Resource Definitions

```yaml
# chaos-experiment-crd.yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: chaosexperiments.litmuschaos.io
spec:
  group: litmuschaos.io
  versions:
  - name: v1alpha1
    served: true
    storage: true
    schema:
      openAPIV3Schema:
        type: object
        properties:
          spec:
            type: object
            properties:
              definition:
                type: object
                properties:
                  scope:
                    type: string
                    enum: ["Namespaced", "Cluster"]
                  permissions:
                    type: array
                    items:
                      type: object
                      properties:
                        apiGroups:
                          type: array
                          items:
                            type: string
                        resources:
                          type: array
                          items:
                            type: string
                        verbs:
                          type: array
                          items:
                            type: string
                  image:
                    type: string
                  imagePullPolicy:
                    type: string
                  args:
                    type: array
                    items:
                      type: string
                  command:
                    type: array
                    items:
                      type: string
                  env:
                    type: array
                    items:
                      type: object
                      properties:
                        name:
                          type: string
                        value:
                          type: string
          status:
            type: object
  scope: Namespaced
  names:
    plural: chaosexperiments
    singular: chaosexperiment
    kind: ChaosExperiment
```

### RBAC Configuration

```yaml
# litmus-rbac.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: pod-delete-sa
  namespace: default
  labels:
    name: pod-delete-sa
    app.kubernetes.io/part-of: litmus
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: default
  name: pod-delete-sa
  labels:
    name: pod-delete-sa
    app.kubernetes.io/part-of: litmus
rules:
  - apiGroups: [""]
    resources: ["pods", "events"]
    verbs: ["create", "delete", "get", "list", "patch", "update", "deletecollection"]
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get", "list"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods/exec"]
    verbs: ["get", "list", "create"]
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets", "replicasets", "daemonsets"]
    verbs: ["list", "get"]
  - apiGroups: ["apps"]
    resources: ["deployments/scale", "statefulsets/scale"]
    verbs: ["patch"]
  - apiGroups: [""]
    resources: ["replicationcontrollers"]
    verbs: ["get", "list"]
  - apiGroups: ["argoproj.io"]
    resources: ["rollouts"]
    verbs: ["list", "get"]
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["create", "list", "get", "delete", "deletecollection"]
  - apiGroups: ["litmuschaos.io"]
    resources: ["chaosengines", "chaosexperiments", "chaosresults"]
    verbs: ["create", "list", "get", "patch", "update", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: pod-delete-sa
  namespace: default
  labels:
    name: pod-delete-sa
    app.kubernetes.io/part-of: litmus
subjects:
  - kind: ServiceAccount
    name: pod-delete-sa
    namespace: default
roleRef:
  kind: Role
  name: pod-delete-sa
  apiGroup: rbac.authorization.k8s.io
```

# Chaos Experiment Design

Designing effective chaos experiments requires understanding system architecture, identifying failure modes, and creating comprehensive test scenarios.

## Application-Level Experiments

### Pod Failure Experiments

```yaml
# pod-delete-experiment.yaml
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: frontend-pod-delete-chaos
  namespace: ecommerce
spec:
  engineState: 'active'
  appinfo:
    appns: 'ecommerce'
    applabel: 'app=frontend'
    appkind: 'deployment'
  chaosServiceAccount: pod-delete-sa
  experiments:
  - name: pod-delete
    spec:
      components:
        env:
          # Number of pods to delete
          - name: TOTAL_CHAOS_DURATION
            value: '60'
          # Time between chaos injection
          - name: CHAOS_INTERVAL
            value: '10'
          # Percentage of pods to kill
          - name: PODS_AFFECTED_PERC
            value: '50'
          # Force deletion
          - name: FORCE
            value: 'false'
          # Sequence of chaos
          - name: SEQUENCE
            value: 'parallel'
      probe:
      - name: "frontend-availability-probe"
        type: "httpProbe"
        mode: "Continuous"
        runProperties:
          probeTimeout: 10
          retry: 3
          interval: 5
        httpProbe/inputs:
          url: "http://frontend-service.ecommerce.svc.cluster.local:80/health"
          insecureSkipTLS: false
          method:
            get:
              criteria: "=="
              responseCode: "200"
      - name: "database-connectivity-probe"
        type: "cmdProbe"
        mode: "Edge"
        runProperties:
          probeTimeout: 10
          retry: 1
          interval: 1
        cmdProbe/inputs:
          command: "curl -s http://backend-service.ecommerce.svc.cluster.local:8080/db-health"
          source:
            image: "curlimages/curl:latest"
          comparator:
            type: "string"
            criteria: "contains"
            value: "healthy"
```

### Memory Stress Experiments

```yaml
# memory-stress-experiment.yaml
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: backend-memory-stress
  namespace: ecommerce
spec:
  engineState: 'active'
  appinfo:
    appns: 'ecommerce'
    applabel: 'app=backend'
    appkind: 'deployment'
  chaosServiceAccount: container-kill-sa
  experiments:
  - name: pod-memory-hog
    spec:
      components:
        env:
          # Memory to consume (in MB)
          - name: MEMORY_CONSUMPTION
            value: '500'
          # Duration of memory stress
          - name: TOTAL_CHAOS_DURATION
            value: '120'
          # Percentage of pods to affect
          - name: PODS_AFFECTED_PERC
            value: '25'
          # CPU cores to use for stress
          - name: NUMBER_OF_WORKERS
            value: '1'
          # Memory consumption pattern
          - name: SEQUENCE
            value: 'parallel'
          # Container name to target
          - name: TARGET_CONTAINER
            value: 'backend'
      probe:
      - name: "response-time-probe"
        type: "httpProbe"
        mode: "Continuous"
        runProperties:
          probeTimeout: 15
          retry: 2
          interval: 10
        httpProbe/inputs:
          url: "http://backend-service.ecommerce.svc.cluster.local:8080/api/performance"
          insecureSkipTLS: false
          method:
            get:
              criteria: "<="
              responseTimeout: 5000  # Max 5 seconds response time
```

## Infrastructure-Level Experiments

### Network Partition Experiments

```yaml
# network-partition-experiment.yaml
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: network-partition-chaos
  namespace: ecommerce
spec:
  engineState: 'active'
  appinfo:
    appns: 'ecommerce'
    applabel: 'app=payment-service'
    appkind: 'deployment'
  chaosServiceAccount: litmus-admin
  experiments:
  - name: pod-network-partition
    spec:
      components:
        env:
          # Destination IPs to block
          - name: DESTINATION_IPS
            value: '10.244.1.5,10.244.2.8'  # Database and cache IPs
          # Destination services to block
          - name: DESTINATION_HOSTS
            value: 'postgres-service.database.svc.cluster.local,redis-service.cache.svc.cluster.local'
          # Duration of network partition
          - name: TOTAL_CHAOS_DURATION
            value: '300'
          # Network interface
          - name: NETWORK_INTERFACE
            value: 'eth0'
          # Percentage of pods to affect
          - name: PODS_AFFECTED_PERC
            value: '33'
      probe:
      - name: "payment-processing-probe"
        type: "httpProbe"
        mode: "Continuous"
        runProperties:
          probeTimeout: 20
          retry: 3
          interval: 15
        httpProbe/inputs:
          url: "http://payment-service.ecommerce.svc.cluster.local:8080/health"
          insecureSkipTLS: false
          method:
            get:
              criteria: "=="
              responseCode: "200"
      - name: "circuit-breaker-probe"
        type: "httpProbe"
        mode: "Continuous"
        runProperties:
          probeTimeout: 10
          retry: 1
          interval: 5
        httpProbe/inputs:
          url: "http://payment-service.ecommerce.svc.cluster.local:8080/circuit-breaker-status"
          insecureSkipTLS: false
          method:
            get:
              criteria: "contains"
              responseBody: "OPEN"
```

### Node Failure Experiments

```yaml
# node-drain-experiment.yaml
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: node-drain-chaos
  namespace: litmus
spec:
  engineState: 'active'
  auxiliaryAppInfo: ''
  chaosServiceAccount: litmus-admin
  experiments:
  - name: node-drain
    spec:
      components:
        env:
          # Target node name
          - name: TARGET_NODE
            value: 'worker-node-1'
          # Chaos duration
          - name: TOTAL_CHAOS_DURATION
            value: '600'
          # Force drain
          - name: FORCE
            value: 'false'
      probe:
      - name: "cluster-health-probe"
        type: "k8sProbe"
        mode: "Continuous"
        runProperties:
          probeTimeout: 30
          retry: 5
          interval: 20
        k8sProbe/inputs:
          group: ""
          version: "v1"
          resource: "nodes"
          namespace: ""
          operation: "present"
          fieldSelector: "metadata.name=worker-node-2,status.conditions[?(@.type=='Ready')].status=True"
      - name: "workload-availability-probe"
        type: "k8sProbe"
        mode: "Continuous"
        runProperties:
          probeTimeout: 15
          retry: 3
          interval: 10
        k8sProbe/inputs:
          group: "apps"
          version: "v1"
          resource: "deployments"
          namespace: "ecommerce"
          operation: "present"
          fieldSelector: "metadata.name=frontend,status.readyReplicas>=2"
```

## Custom Chaos Experiments

### Database Connection Pool Exhaustion

```go
package experiments

import (
    "context"
    "database/sql"
    "fmt"
    "sync"
    "time"

    _ "github.com/lib/pq"
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    activeConnections = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "chaos_db_active_connections",
        Help: "Number of active database connections during chaos experiment",
    })
)

type DBConnectionChaos struct {
    connectionString string
    maxConnections   int
    duration         time.Duration
    connections      []*sql.DB
    mutex           sync.Mutex
}

func NewDBConnectionChaos(connStr string, maxConns int, duration time.Duration) *DBConnectionChaos {
    return &DBConnectionChaos{
        connectionString: connStr,
        maxConnections:   maxConns,
        duration:         duration,
        connections:      make([]*sql.DB, 0, maxConns),
    }
}

func (d *DBConnectionChaos) Execute(ctx context.Context) error {
    fmt.Printf("Starting database connection pool exhaustion experiment\n")
    fmt.Printf("Target: %d connections for %v\n", d.maxConnections, d.duration)

    // Create connections to exhaust the pool
    for i := 0; i < d.maxConnections; i++ {
        db, err := sql.Open("postgres", d.connectionString)
        if err != nil {
            return fmt.Errorf("failed to create connection %d: %w", i, err)
        }

        // Set connection pool settings to force individual connections
        db.SetMaxOpenConns(1)
        db.SetMaxIdleConns(1)
        db.SetConnMaxLifetime(d.duration + time.Minute)

        // Test the connection
        if err := db.PingContext(ctx); err != nil {
            db.Close()
            return fmt.Errorf("failed to ping database on connection %d: %w", i, err)
        }

        d.mutex.Lock()
        d.connections = append(d.connections, db)
        activeConnections.Set(float64(len(d.connections)))
        d.mutex.Unlock()

        fmt.Printf("Created connection %d/%d\n", i+1, d.maxConnections)
        
        // Small delay to avoid overwhelming the database
        time.Sleep(time.Millisecond * 100)
    }

    fmt.Printf("All connections created. Holding for %v...\n", d.duration)

    // Hold connections for the specified duration
    select {
    case <-time.After(d.duration):
        fmt.Printf("Experiment duration completed\n")
    case <-ctx.Done():
        fmt.Printf("Experiment cancelled\n")
    }

    // Cleanup connections
    return d.cleanup()
}

func (d *DBConnectionChaos) cleanup() error {
    d.mutex.Lock()
    defer d.mutex.Unlock()

    fmt.Printf("Cleaning up %d connections\n", len(d.connections))

    var errors []error
    for i, db := range d.connections {
        if err := db.Close(); err != nil {
            errors = append(errors, fmt.Errorf("failed to close connection %d: %w", i, err))
        }
    }

    d.connections = d.connections[:0]
    activeConnections.Set(0)

    if len(errors) > 0 {
        return fmt.Errorf("cleanup errors: %v", errors)
    }

    fmt.Printf("Cleanup completed successfully\n")
    return nil
}

// Kubernetes Job definition for the custom experiment
func GenerateDBChaosJob(namespace, dbConnectionString string, maxConns int, duration time.Duration) string {
    return fmt.Sprintf(`
apiVersion: batch/v1
kind: Job
metadata:
  name: db-connection-chaos
  namespace: %s
spec:
  template:
    spec:
      containers:
      - name: chaos-executor
        image: postgres-chaos-experiment:latest
        env:
        - name: DB_CONNECTION_STRING
          value: "%s"
        - name: MAX_CONNECTIONS
          value: "%d"
        - name: DURATION_SECONDS
          value: "%d"
        resources:
          requests:
            memory: "64Mi"
            cpu: "100m"
          limits:
            memory: "128Mi"
            cpu: "200m"
      restartPolicy: Never
  backoffLimit: 1
`, namespace, dbConnectionString, maxConns, int(duration.Seconds()))
}
```

# Failure Scenario Testing

Comprehensive failure scenario testing validates system behavior under various fault conditions, ensuring resilience across different failure modes.

## Cascading Failure Scenarios

### Service Dependency Chain Failure

```yaml
# cascading-failure-workflow.yaml
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  generateName: cascading-failure-test-
  namespace: litmus
spec:
  entrypoint: cascading-failure-pipeline
  templates:
  - name: cascading-failure-pipeline
    steps:
    - - name: baseline-metrics
        template: collect-baseline-metrics
    - - name: database-failure
        template: inject-database-failure
    - - name: wait-propagation
        template: wait-for-failure-propagation
    - - name: validate-circuit-breakers
        template: validate-circuit-breaker-activation
    - - name: cache-failure
        template: inject-cache-failure
    - - name: validate-degraded-mode
        template: validate-degraded-mode-operation
    - - name: recovery-test
        template: test-system-recovery
    - - name: collect-final-metrics
        template: collect-final-metrics

  - name: collect-baseline-metrics
    container:
      image: curlimages/curl:latest
      command: [sh, -c]
      args:
        - |
          echo "Collecting baseline metrics..."
          curl -s "http://prometheus.monitoring.svc.cluster.local:9090/api/v1/query?query=up" > /tmp/baseline.json
          echo "Baseline metrics collected"

  - name: inject-database-failure
    resource:
      action: create
      manifest: |
        apiVersion: litmuschaos.io/v1alpha1
        kind: ChaosEngine
        metadata:
          name: database-pod-delete
          namespace: database
        spec:
          engineState: 'active'
          appinfo:
            appns: 'database'
            applabel: 'app=postgres'
            appkind: 'statefulset'
          chaosServiceAccount: litmus-admin
          experiments:
          - name: pod-delete
            spec:
              components:
                env:
                - name: TOTAL_CHAOS_DURATION
                  value: '180'
                - name: FORCE
                  value: 'false'

  - name: wait-for-failure-propagation
    container:
      image: alpine:latest
      command: [sh, -c]
      args:
        - |
          echo "Waiting for failure propagation..."
          sleep 30
          echo "Propagation wait completed"

  - name: validate-circuit-breaker-activation
    container:
      image: curlimages/curl:latest
      command: [sh, -c]
      args:
        - |
          echo "Validating circuit breaker activation..."
          RESPONSE=$(curl -s http://backend-service.ecommerce.svc.cluster.local:8080/circuit-breaker-status)
          if echo "$RESPONSE" | grep -q "OPEN"; then
            echo "Circuit breaker activated successfully"
          else
            echo "Circuit breaker not activated: $RESPONSE"
            exit 1
          fi

  - name: inject-cache-failure
    resource:
      action: create
      manifest: |
        apiVersion: litmuschaos.io/v1alpha1
        kind: ChaosEngine
        metadata:
          name: cache-memory-stress
          namespace: cache
        spec:
          engineState: 'active'
          appinfo:
            appns: 'cache'
            applabel: 'app=redis'
            appkind: 'deployment'
          chaosServiceAccount: litmus-admin
          experiments:
          - name: pod-memory-hog
            spec:
              components:
                env:
                - name: MEMORY_CONSUMPTION
                  value: '1024'
                - name: TOTAL_CHAOS_DURATION
                  value: '120'

  - name: validate-degraded-mode-operation
    container:
      image: curlimages/curl:latest
      command: [sh, -c]
      args:
        - |
          echo "Validating degraded mode operation..."
          for i in $(seq 1 10); do
            RESPONSE=$(curl -s -w "%{http_code}" http://frontend-service.ecommerce.svc.cluster.local:80/health)
            echo "Health check $i: $RESPONSE"
            if [[ "$RESPONSE" =~ 200$ ]]; then
              echo "System operating in degraded mode successfully"
              break
            fi
            sleep 5
          done

  - name: test-system-recovery
    container:
      image: kubectl:latest
      command: [sh, -c]
      args:
        - |
          echo "Testing system recovery..."
          # Delete chaos engines to stop chaos
          kubectl delete chaosengine database-pod-delete -n database --ignore-not-found=true
          kubectl delete chaosengine cache-memory-stress -n cache --ignore-not-found=true
          
          # Wait for recovery
          sleep 60
          
          # Validate recovery
          kubectl wait --for=condition=Ready pod -l app=postgres -n database --timeout=300s
          kubectl wait --for=condition=Ready pod -l app=redis -n cache --timeout=300s
          echo "System recovery validated"

  - name: collect-final-metrics
    container:
      image: curlimages/curl:latest
      command: [sh, -c]
      args:
        - |
          echo "Collecting final metrics..."
          curl -s "http://prometheus.monitoring.svc.cluster.local:9090/api/v1/query?query=up" > /tmp/final.json
          echo "Final metrics collected"
```

## Performance Degradation Testing

### Latency Injection Experiments

```go
package performance

import (
    "context"
    "fmt"
    "net/http"
    "net/http/httputil"
    "net/url"
    "time"
)

type LatencyChaosProxy struct {
    target      *url.URL
    proxy       *httputil.ReverseProxy
    latency     time.Duration
    jitter      time.Duration
    probability float64
}

func NewLatencyChaosProxy(targetURL string, latency, jitter time.Duration, probability float64) (*LatencyChaosProxy, error) {
    target, err := url.Parse(targetURL)
    if err != nil {
        return nil, fmt.Errorf("invalid target URL: %w", err)
    }

    proxy := httputil.NewSingleHostReverseProxy(target)
    
    return &LatencyChaosProxy{
        target:      target,
        proxy:       proxy,
        latency:     latency,
        jitter:      jitter,
        probability: probability,
    }, nil
}

func (l *LatencyChaosProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    // Decide whether to inject latency
    if l.shouldInjectLatency() {
        delay := l.calculateDelay()
        fmt.Printf("Injecting %v latency for request %s %s\n", delay, r.Method, r.URL.Path)
        time.Sleep(delay)
    }

    // Forward the request
    l.proxy.ServeHTTP(w, r)
}

func (l *LatencyChaosProxy) shouldInjectLatency() bool {
    return time.Now().UnixNano()%100 < int64(l.probability*100)
}

func (l *LatencyChaosProxy) calculateDelay() time.Duration {
    baseDelay := l.latency
    if l.jitter > 0 {
        jitterAmount := time.Duration(time.Now().UnixNano() % int64(l.jitter))
        baseDelay += jitterAmount
    }
    return baseDelay
}

// Kubernetes deployment for latency chaos proxy
func GenerateLatencyChaosProxyDeployment(namespace, serviceName, targetService string, latency time.Duration) string {
    return fmt.Sprintf(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: %s-latency-proxy
  namespace: %s
spec:
  replicas: 1
  selector:
    matchLabels:
      app: %s-latency-proxy
  template:
    metadata:
      labels:
        app: %s-latency-proxy
    spec:
      containers:
      - name: latency-proxy
        image: latency-chaos-proxy:latest
        ports:
        - containerPort: 8080
        env:
        - name: TARGET_SERVICE
          value: "%s"
        - name: LATENCY_MS
          value: "%d"
        - name: JITTER_MS
          value: "100"
        - name: PROBABILITY
          value: "0.3"
        resources:
          requests:
            memory: "64Mi"
            cpu: "100m"
          limits:
            memory: "128Mi"
            cpu: "200m"
---
apiVersion: v1
kind: Service
metadata:
  name: %s-latency-proxy
  namespace: %s
spec:
  selector:
    app: %s-latency-proxy
  ports:
  - port: 8080
    targetPort: 8080
  type: ClusterIP
`, serviceName, namespace, serviceName, serviceName, targetService, int(latency.Milliseconds()), serviceName, namespace, serviceName)
}
```

# Automated Chaos Testing in CI/CD

Integrating chaos testing into CI/CD pipelines ensures continuous validation of system resilience throughout the development lifecycle.

## GitHub Actions Integration

```yaml
# .github/workflows/chaos-testing.yml
name: Chaos Engineering Pipeline

on:
  schedule:
    # Run chaos tests daily at 2 AM UTC
    - cron: '0 2 * * *'
  workflow_dispatch:
    inputs:
      experiment_type:
        description: 'Type of chaos experiment to run'
        required: true
        default: 'pod-delete'
        type: choice
        options:
        - pod-delete
        - memory-stress
        - network-partition
        - node-drain
        - full-suite
      blast_radius:
        description: 'Blast radius percentage (1-100)'
        required: true
        default: '25'
        type: number

env:
  KUBECONFIG_DATA: ${{ secrets.KUBECONFIG_DATA }}
  SLACK_WEBHOOK: ${{ secrets.SLACK_WEBHOOK }}

jobs:
  pre-chaos-validation:
    runs-on: ubuntu-latest
    outputs:
      proceed: ${{ steps.health-check.outputs.proceed }}
    steps:
      - name: Checkout code
        uses: actions/checkout@v3

      - name: Setup kubectl
        uses: azure/setup-kubectl@v3
        with:
          version: 'v1.28.0'

      - name: Configure kubeconfig
        run: |
          echo "$KUBECONFIG_DATA" | base64 -d > ~/.kube/config

      - name: System Health Check
        id: health-check
        run: |
          #!/bin/bash
          set -e
          
          echo "Performing pre-chaos health checks..."
          
          # Check cluster health
          kubectl get nodes --no-headers | grep -v Ready && {
            echo "Some nodes are not ready. Aborting chaos tests."
            echo "proceed=false" >> $GITHUB_OUTPUT
            exit 0
          }
          
          # Check critical services
          kubectl get pods -n kube-system --no-headers | grep -v Running | grep -v Completed && {
            echo "Some system pods are not running. Aborting chaos tests."
            echo "proceed=false" >> $GITHUB_OUTPUT
            exit 0
          }
          
          # Check application health
          kubectl get deployments -n ecommerce -o jsonpath='{.items[*].status.readyReplicas}' | tr ' ' '\n' | while read replicas; do
            if [ "$replicas" -eq 0 ]; then
              echo "Some application deployments have no ready replicas. Aborting chaos tests."
              echo "proceed=false" >> $GITHUB_OUTPUT
              exit 0
            fi
          done
          
          echo "All health checks passed. Proceeding with chaos tests."
          echo "proceed=true" >> $GITHUB_OUTPUT

      - name: Notify Slack - Starting Tests
        if: steps.health-check.outputs.proceed == 'true'
        run: |
          curl -X POST -H 'Content-type: application/json' \
            --data '{"text":"🚀 Starting chaos engineering tests for production environment"}' \
            $SLACK_WEBHOOK

  chaos-experiments:
    runs-on: ubuntu-latest
    needs: pre-chaos-validation
    if: needs.pre-chaos-validation.outputs.proceed == 'true'
    strategy:
      matrix:
        experiment:
          - name: pod-delete
            namespace: ecommerce
            duration: 300
          - name: memory-stress
            namespace: ecommerce
            duration: 180
          - name: network-partition
            namespace: ecommerce
            duration: 240
    steps:
      - name: Checkout code
        uses: actions/checkout@v3

      - name: Setup kubectl
        uses: azure/setup-kubectl@v3
        with:
          version: 'v1.28.0'

      - name: Configure kubeconfig
        run: |
          echo "$KUBECONFIG_DATA" | base64 -d > ~/.kube/config

      - name: Install Litmus CLI
        run: |
          wget https://github.com/litmuschaos/litmusctl/releases/download/0.21.0/litmusctl-linux-amd64-0.21.0.tar.gz
          tar -zxvf litmusctl-linux-amd64-0.21.0.tar.gz
          sudo mv litmusctl /usr/local/bin/litmusctl
          litmusctl version

      - name: Run Chaos Experiment - ${{ matrix.experiment.name }}
        id: chaos-test
        timeout-minutes: 30
        run: |
          #!/bin/bash
          set -e
          
          EXPERIMENT_NAME="${{ matrix.experiment.name }}"
          NAMESPACE="${{ matrix.experiment.namespace }}"
          DURATION="${{ matrix.experiment.duration }}"
          
          echo "Running chaos experiment: $EXPERIMENT_NAME"
          
          # Create experiment manifest
          cat <<EOF > chaos-experiment.yaml
          apiVersion: litmuschaos.io/v1alpha1
          kind: ChaosEngine
          metadata:
            name: github-actions-$EXPERIMENT_NAME-$(date +%s)
            namespace: $NAMESPACE
          spec:
            engineState: 'active'
            appinfo:
              appns: '$NAMESPACE'
              applabel: 'app=frontend'
              appkind: 'deployment'
            chaosServiceAccount: litmus-admin
            experiments:
            - name: $EXPERIMENT_NAME
              spec:
                components:
                  env:
                  - name: TOTAL_CHAOS_DURATION
                    value: '$DURATION'
                  - name: PODS_AFFECTED_PERC
                    value: '${{ github.event.inputs.blast_radius || 25 }}'
                probe:
                - name: "application-availability-probe"
                  type: "httpProbe"
                  mode: "Continuous"
                  runProperties:
                    probeTimeout: 10
                    retry: 3
                    interval: 5
                  httpProbe/inputs:
                    url: "http://frontend-service.$NAMESPACE.svc.cluster.local:80/health"
                    insecureSkipTLS: false
                    method:
                      get:
                        criteria: "=="
                        responseCode: "200"
          EOF
          
          # Apply experiment
          kubectl apply -f chaos-experiment.yaml
          
          # Wait for completion
          ENGINE_NAME=$(kubectl get chaosengine -n $NAMESPACE --sort-by=.metadata.creationTimestamp -o name | tail -1 | cut -d'/' -f2)
          
          echo "Waiting for chaos engine $ENGINE_NAME to complete..."
          
          timeout 1800 bash -c "
            while true; do
              STATUS=\$(kubectl get chaosengine $ENGINE_NAME -n $NAMESPACE -o jsonpath='{.status.engineStatus}')
              echo \"Current status: \$STATUS\"
              if [ \"\$STATUS\" = \"completed\" ]; then
                break
              elif [ \"\$STATUS\" = \"stopped\" ]; then
                echo \"Experiment stopped unexpectedly\"
                exit 1
              fi
              sleep 10
            done
          "
          
          # Get experiment results
          RESULT_NAME=$(kubectl get chaosresult -n $NAMESPACE -l chaosUID=$ENGINE_NAME -o name | head -1 | cut -d'/' -f2)
          VERDICT=$(kubectl get chaosresult $RESULT_NAME -n $NAMESPACE -o jsonpath='{.status.experimentStatus.verdict}')
          
          echo "experiment_result=$VERDICT" >> $GITHUB_OUTPUT
          echo "Experiment $EXPERIMENT_NAME completed with verdict: $VERDICT"
          
          if [ "$VERDICT" != "Pass" ]; then
            echo "Experiment failed!"
            exit 1
          fi

      - name: Collect Experiment Artifacts
        if: always()
        run: |
          mkdir -p artifacts
          kubectl get chaosengine -n ${{ matrix.experiment.namespace }} -o yaml > artifacts/chaosengines.yaml
          kubectl get chaosresult -n ${{ matrix.experiment.namespace }} -o yaml > artifacts/chaosresults.yaml
          kubectl logs -n litmus -l app.kubernetes.io/component=runner --tail=1000 > artifacts/chaos-runner.log

      - name: Upload Artifacts
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: chaos-experiment-${{ matrix.experiment.name }}-artifacts
          path: artifacts/

      - name: Notify Slack - Experiment Result
        if: always()
        run: |
          if [ "${{ steps.chaos-test.outputs.experiment_result }}" = "Pass" ]; then
            MESSAGE="✅ Chaos experiment ${{ matrix.experiment.name }} PASSED"
          else
            MESSAGE="❌ Chaos experiment ${{ matrix.experiment.name }} FAILED"
          fi
          
          curl -X POST -H 'Content-type: application/json' \
            --data "{\"text\":\"$MESSAGE\"}" \
            $SLACK_WEBHOOK

  post-chaos-validation:
    runs-on: ubuntu-latest
    needs: chaos-experiments
    if: always()
    steps:
      - name: Setup kubectl
        uses: azure/setup-kubectl@v3
        with:
          version: 'v1.28.0'

      - name: Configure kubeconfig
        run: |
          echo "$KUBECONFIG_DATA" | base64 -d > ~/.kube/config

      - name: System Recovery Validation
        run: |
          #!/bin/bash
          echo "Validating system recovery..."
          
          # Wait for system stabilization
          sleep 60
          
          # Check all pods are running
          kubectl get pods --all-namespaces --field-selector=status.phase!=Running,status.phase!=Succeeded
          
          # Check deployments are healthy
          kubectl get deployments -n ecommerce -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.readyReplicas}/{.spec.replicas}{"\n"}{end}'
          
          # Validate application endpoints
          kubectl run curl-test --image=curlimages/curl:latest --rm -it --restart=Never -- \
            curl -f http://frontend-service.ecommerce.svc.cluster.local:80/health

      - name: Generate Chaos Report
        run: |
          #!/bin/bash
          echo "# Chaos Engineering Test Report" > chaos-report.md
          echo "Date: $(date)" >> chaos-report.md
          echo "" >> chaos-report.md
          
          echo "## Experiments Executed" >> chaos-report.md
          kubectl get chaosresult --all-namespaces -o custom-columns="NAMESPACE:.metadata.namespace,NAME:.metadata.name,VERDICT:.status.experimentStatus.verdict,DURATION:.status.experimentStatus.totalDuration" >> chaos-report.md
          
          echo "" >> chaos-report.md
          echo "## System Health Post-Chaos" >> chaos-report.md
          kubectl get deployments -n ecommerce -o custom-columns="NAME:.metadata.name,READY:.status.readyReplicas,DESIRED:.spec.replicas" >> chaos-report.md

      - name: Upload Report
        uses: actions/upload-artifact@v3
        with:
          name: chaos-engineering-report
          path: chaos-report.md

      - name: Final Notification
        if: always()
        run: |
          curl -X POST -H 'Content-type: application/json' \
            --data '{"text":"🏁 Chaos engineering test suite completed. Check GitHub Actions for detailed results."}' \
            $SLACK_WEBHOOK
```

## Jenkins Pipeline Integration

```groovy
// Jenkinsfile for Chaos Engineering
pipeline {
    agent any
    
    parameters {
        choice(
            name: 'EXPERIMENT_TYPE',
            choices: ['pod-delete', 'memory-stress', 'network-partition', 'full-suite'],
            description: 'Type of chaos experiment to run'
        )
        string(
            name: 'BLAST_RADIUS',
            defaultValue: '25',
            description: 'Blast radius percentage (1-100)'
        )
        booleanParam(
            name: 'SKIP_HEALTH_CHECK',
            defaultValue: false,
            description: 'Skip pre-chaos health validation'
        )
    }
    
    environment {
        KUBECONFIG = credentials('kubernetes-config')
        SLACK_WEBHOOK = credentials('slack-webhook-url')
        CHAOS_NAMESPACE = 'ecommerce'
    }
    
    stages {
        stage('Pre-Chaos Validation') {
            when {
                not { params.SKIP_HEALTH_CHECK }
            }
            steps {
                script {
                    def healthCheck = sh(
                        script: '''
                            # Check cluster health
                            if ! kubectl get nodes | grep -v Ready | grep -q Ready; then
                                echo "Some nodes are not ready"
                                exit 1
                            fi
                            
                            # Check application health
                            kubectl get deployments -n ${CHAOS_NAMESPACE} -o jsonpath='{.items[*].status.readyReplicas}' | tr ' ' '\\n' | while read replicas; do
                                if [ "$replicas" -eq 0 ]; then
                                    echo "Some deployments have no ready replicas"
                                    exit 1
                                fi
                            done
                            
                            echo "Health check passed"
                        ''',
                        returnStatus: true
                    )
                    
                    if (healthCheck != 0) {
                        error("Pre-chaos health check failed. Aborting chaos tests.")
                    }
                }
            }
        }
        
        stage('Execute Chaos Experiments') {
            parallel {
                stage('Pod Delete Experiment') {
                    when {
                        anyOf {
                            expression { params.EXPERIMENT_TYPE == 'pod-delete' }
                            expression { params.EXPERIMENT_TYPE == 'full-suite' }
                        }
                    }
                    steps {
                        script {
                            executeChaosExperiment('pod-delete', 300)
                        }
                    }
                }
                
                stage('Memory Stress Experiment') {
                    when {
                        anyOf {
                            expression { params.EXPERIMENT_TYPE == 'memory-stress' }
                            expression { params.EXPERIMENT_TYPE == 'full-suite' }
                        }
                    }
                    steps {
                        script {
                            executeChaosExperiment('pod-memory-hog', 180)
                        }
                    }
                }
                
                stage('Network Partition Experiment') {
                    when {
                        anyOf {
                            expression { params.EXPERIMENT_TYPE == 'network-partition' }
                            expression { params.EXPERIMENT_TYPE == 'full-suite' }
                        }
                    }
                    steps {
                        script {
                            executeChaosExperiment('pod-network-partition', 240)
                        }
                    }
                }
            }
        }
        
        stage('Post-Chaos Validation') {
            steps {
                script {
                    // Wait for system stabilization
                    sleep(60)
                    
                    sh '''
                        echo "Validating system recovery..."
                        
                        # Check all deployments are healthy
                        kubectl get deployments -n ${CHAOS_NAMESPACE} -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.readyReplicas}/{.spec.replicas}{"\n"}{end}'
                        
                        # Test application endpoints
                        kubectl run jenkins-curl-test --image=curlimages/curl:latest --rm --restart=Never -- \\
                            curl -f http://frontend-service.${CHAOS_NAMESPACE}.svc.cluster.local:80/health
                    '''
                }
            }
        }
        
        stage('Generate Report') {
            steps {
                script {
                    sh '''
                        echo "# Chaos Engineering Test Report" > chaos-report.md
                        echo "Build: ${BUILD_NUMBER}" >> chaos-report.md
                        echo "Date: $(date)" >> chaos-report.md
                        echo "Experiment Type: ${EXPERIMENT_TYPE}" >> chaos-report.md
                        echo "Blast Radius: ${BLAST_RADIUS}%" >> chaos-report.md
                        echo "" >> chaos-report.md
                        
                        echo "## Experiment Results" >> chaos-report.md
                        kubectl get chaosresult -n ${CHAOS_NAMESPACE} -o custom-columns="NAME:.metadata.name,VERDICT:.status.experimentStatus.verdict,DURATION:.status.experimentStatus.totalDuration" >> chaos-report.md
                        
                        echo "" >> chaos-report.md
                        echo "## Final System State" >> chaos-report.md
                        kubectl get deployments -n ${CHAOS_NAMESPACE} -o custom-columns="NAME:.metadata.name,READY:.status.readyReplicas,DESIRED:.spec.replicas" >> chaos-report.md
                    '''
                    
                    archiveArtifacts artifacts: 'chaos-report.md', allowEmptyArchive: false
                    publishHTML([
                        allowMissing: false,
                        alwaysLinkToLastBuild: true,
                        keepAll: true,
                        reportDir: '.',
                        reportFiles: 'chaos-report.md',
                        reportName: 'Chaos Engineering Report'
                    ])
                }
            }
        }
    }
    
    post {
        always {
            script {
                // Cleanup any remaining chaos engines
                sh '''
                    kubectl delete chaosengine --all -n ${CHAOS_NAMESPACE} --ignore-not-found=true
                '''
                
                // Send Slack notification
                def status = currentBuild.currentResult
                def color = status == 'SUCCESS' ? 'good' : 'danger'
                def message = "Chaos Engineering Pipeline ${status} - Build #${BUILD_NUMBER}"
                
                sh """
                    curl -X POST -H 'Content-type: application/json' \\
                        --data '{"text":"${message}", "color":"${color}"}' \\
                        ${SLACK_WEBHOOK}
                """
            }
        }
        
        failure {
            script {
                // Collect debug information on failure
                sh '''
                    mkdir -p debug-artifacts
                    kubectl get events --sort-by=.metadata.creationTimestamp -n ${CHAOS_NAMESPACE} > debug-artifacts/events.log
                    kubectl logs -n litmus -l app.kubernetes.io/component=runner --tail=1000 > debug-artifacts/litmus-logs.log
                    kubectl get chaosengine,chaosresult -n ${CHAOS_NAMESPACE} -o yaml > debug-artifacts/chaos-resources.yaml
                '''
                
                archiveArtifacts artifacts: 'debug-artifacts/**', allowEmptyArchive: true
            }
        }
    }
}

def executeChaosExperiment(experimentName, duration) {
    def engineName = "jenkins-${experimentName}-${BUILD_NUMBER}"
    
    // Create chaos experiment
    sh """
        cat <<EOF | kubectl apply -f -
        apiVersion: litmuschaos.io/v1alpha1
        kind: ChaosEngine
        metadata:
          name: ${engineName}
          namespace: ${CHAOS_NAMESPACE}
        spec:
          engineState: 'active'
          appinfo:
            appns: '${CHAOS_NAMESPACE}'
            applabel: 'app=frontend'
            appkind: 'deployment'
          chaosServiceAccount: litmus-admin
          experiments:
          - name: ${experimentName}
            spec:
              components:
                env:
                - name: TOTAL_CHAOS_DURATION
                  value: '${duration}'
                - name: PODS_AFFECTED_PERC
                  value: '${BLAST_RADIUS}'
              probe:
              - name: "application-availability-probe"
                type: "httpProbe"
                mode: "Continuous"
                runProperties:
                  probeTimeout: 10
                  retry: 3
                  interval: 5
                httpProbe/inputs:
                  url: "http://frontend-service.${CHAOS_NAMESPACE}.svc.cluster.local:80/health"
                  insecureSkipTLS: false
                  method:
                    get:
                      criteria: "=="
                      responseCode: "200"
        EOF
    """
    
    // Wait for experiment completion
    timeout(time: 30, unit: 'MINUTES') {
        sh """
            echo "Waiting for chaos engine ${engineName} to complete..."
            
            while true; do
                STATUS=\$(kubectl get chaosengine ${engineName} -n ${CHAOS_NAMESPACE} -o jsonpath='{.status.engineStatus}' 2>/dev/null || echo "not-found")
                echo "Current status: \$STATUS"
                
                if [ "\$STATUS" = "completed" ]; then
                    break
                elif [ "\$STATUS" = "stopped" ] || [ "\$STATUS" = "not-found" ]; then
                    echo "Experiment stopped unexpectedly or not found"
                    exit 1
                fi
                
                sleep 10
            done
        """
    }
    
    // Validate experiment results
    def verdict = sh(
        script: """
            RESULT_NAME=\$(kubectl get chaosresult -n ${CHAOS_NAMESPACE} -l chaosUID=${engineName} -o name | head -1 | cut -d'/' -f2)
            kubectl get chaosresult \$RESULT_NAME -n ${CHAOS_NAMESPACE} -o jsonpath='{.status.experimentStatus.verdict}'
        """,
        returnStdout: true
    ).trim()
    
    if (verdict != "Pass") {
        error("Chaos experiment ${experimentName} failed with verdict: ${verdict}")
    }
    
    echo "Chaos experiment ${experimentName} completed successfully with verdict: ${verdict}"
}
```

# Observability During Chaos Tests

Comprehensive observability during chaos experiments enables detailed analysis of system behavior under failure conditions and validates resilience mechanisms.

## Prometheus Metrics Collection

```yaml
# chaos-monitoring-setup.yaml
apiVersion: v1
kind: ServiceMonitor
metadata:
  name: chaos-experiments
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app.kubernetes.io/part-of: litmus
  endpoints:
  - port: metrics
    interval: 15s
    path: /metrics
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: chaos-engineering-rules
  namespace: monitoring
spec:
  groups:
  - name: chaos_experiments
    rules:
    - alert: ChaosExperimentRunning
      expr: litmus_experiment_status{status="running"} == 1
      for: 0m
      labels:
        severity: info
        team: sre
      annotations:
        summary: "Chaos experiment {{ $labels.experiment_name }} is running"
        description: "A chaos experiment is currently running in namespace {{ $labels.namespace }}"
        
    - alert: ChaosExperimentFailed
      expr: litmus_experiment_status{status="failed"} == 1
      for: 0m
      labels:
        severity: warning
        team: sre
      annotations:
        summary: "Chaos experiment {{ $labels.experiment_name }} failed"
        description: "Chaos experiment {{ $labels.experiment_name }} in namespace {{ $labels.namespace }} has failed"
        
    - record: chaos:probe_success_rate
      expr: |
        sum(rate(litmus_probe_success_total[5m])) by (experiment, probe_name) /
        sum(rate(litmus_probe_total[5m])) by (experiment, probe_name)
        
    - record: chaos:application_availability_during_chaos
      expr: |
        avg_over_time(up{job="application-metrics"}[5m]) during chaos experiments
```

## Custom Metrics Collection

```go
package observability

import (
    "context"
    "fmt"
    "sync"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "k8s.io/client-go/kubernetes"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

var (
    chaosExperimentDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name: "chaos_experiment_duration_seconds",
            Help: "Duration of chaos experiments",
            Buckets: []float64{30, 60, 120, 300, 600, 1200, 1800},
        },
        []string{"experiment_name", "namespace", "result"},
    )
    
    chaosProbeResults = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "chaos_probe_results_total",
            Help: "Total number of chaos probe results",
        },
        []string{"experiment_name", "probe_name", "result"},
    )
    
    systemRecoveryTime = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name: "chaos_system_recovery_seconds",
            Help: "Time taken for system to recover after chaos",
            Buckets: []float64{10, 30, 60, 120, 300, 600},
        },
        []string{"experiment_name", "component"},
    )
    
    chaosBlastRadius = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "chaos_blast_radius_pods",
            Help: "Number of pods affected by chaos experiment",
        },
        []string{"experiment_name", "namespace"},
    )
)

type ChaosObserver struct {
    client           kubernetes.Interface
    experimentName   string
    namespace        string
    startTime        time.Time
    probeResults     map[string]int
    affectedPods     []string
    mutex           sync.RWMutex
}

func NewChaosObserver(client kubernetes.Interface, experimentName, namespace string) *ChaosObserver {
    return &ChaosObserver{
        client:         client,
        experimentName: experimentName,
        namespace:      namespace,
        probeResults:   make(map[string]int),
        affectedPods:   make([]string, 0),
    }
}

func (c *ChaosObserver) StartObservation(ctx context.Context) {
    c.startTime = time.Now()
    
    // Start collecting metrics
    go c.collectSystemMetrics(ctx)
    go c.monitorAffectedResources(ctx)
    go c.trackProbeResults(ctx)
}

func (c *ChaosObserver) collectSystemMetrics(ctx context.Context) {
    ticker := time.NewTicker(15 * time.Second)
    defer ticker.Stop()
    
    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            c.collectMetricsSnapshot()
        }
    }
}

func (c *ChaosObserver) collectMetricsSnapshot() {
    c.mutex.RLock()
    defer c.mutex.RUnlock()
    
    // Record blast radius
    chaosBlastRadius.WithLabelValues(c.experimentName, c.namespace).
        Set(float64(len(c.affectedPods)))
}

func (c *ChaosObserver) monitorAffectedResources(ctx context.Context) {
    ticker := time.NewTicker(10 * time.Second)
    defer ticker.Stop()
    
    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            c.updateAffectedPods(ctx)
        }
    }
}

func (c *ChaosObserver) updateAffectedPods(ctx context.Context) {
    pods, err := c.client.CoreV1().Pods(c.namespace).List(ctx, metav1.ListOptions{
        LabelSelector: fmt.Sprintf("chaosUID=%s", c.experimentName),
    })
    if err != nil {
        return
    }
    
    c.mutex.Lock()
    c.affectedPods = c.affectedPods[:0]
    for _, pod := range pods.Items {
        c.affectedPods = append(c.affectedPods, pod.Name)
    }
    c.mutex.Unlock()
}

func (c *ChaosObserver) trackProbeResults(ctx context.Context) {
    ticker := time.NewTicker(5 * time.Second)
    defer ticker.Stop()
    
    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            c.collectProbeResults(ctx)
        }
    }
}

func (c *ChaosObserver) collectProbeResults(ctx context.Context) {
    // Query ChaosResult CRD for probe results
    // This would require using a custom client for Litmus CRDs
    // Implementation would parse probe results and update metrics
}

func (c *ChaosObserver) RecordProbeResult(probeName, result string) {
    chaosProbeResults.WithLabelValues(c.experimentName, probeName, result).Inc()
    
    c.mutex.Lock()
    c.probeResults[fmt.Sprintf("%s_%s", probeName, result)]++
    c.mutex.Unlock()
}

func (c *ChaosObserver) RecordExperimentCompletion(result string) {
    duration := time.Since(c.startTime)
    chaosExperimentDuration.WithLabelValues(c.experimentName, c.namespace, result).
        Observe(duration.Seconds())
}

func (c *ChaosObserver) RecordRecoveryTime(component string, recoveryTime time.Duration) {
    systemRecoveryTime.WithLabelValues(c.experimentName, component).
        Observe(recoveryTime.Seconds())
}

// Integration with chaos experiments
func (c *ChaosObserver) GetSummary() map[string]interface{} {
    c.mutex.RLock()
    defer c.mutex.RUnlock()
    
    return map[string]interface{}{
        "experiment_name":    c.experimentName,
        "namespace":          c.namespace,
        "duration":           time.Since(c.startTime).String(),
        "affected_pods":      len(c.affectedPods),
        "probe_results":      c.probeResults,
    }
}
```

## Grafana Dashboard for Chaos Experiments

```json
{
  "dashboard": {
    "id": null,
    "title": "Chaos Engineering Dashboard",
    "tags": ["chaos", "litmus", "sre"],
    "timezone": "browser",
    "panels": [
      {
        "id": 1,
        "title": "Active Chaos Experiments",
        "type": "stat",
        "targets": [
          {
            "expr": "sum(litmus_experiment_status{status=\"running\"})",
            "legendFormat": "Running Experiments"
          }
        ],
        "fieldConfig": {
          "defaults": {
            "color": {
              "mode": "thresholds"
            },
            "thresholds": {
              "steps": [
                {"color": "green", "value": 0},
                {"color": "yellow", "value": 1},
                {"color": "red", "value": 3}
              ]
            }
          }
        }
      },
      {
        "id": 2,
        "title": "Chaos Experiment Success Rate",
        "type": "stat",
        "targets": [
          {
            "expr": "sum(rate(chaos_experiment_duration_seconds{result=\"success\"}[24h])) / sum(rate(chaos_experiment_duration_seconds[24h])) * 100",
            "legendFormat": "Success Rate %"
          }
        ],
        "fieldConfig": {
          "defaults": {
            "unit": "percent",
            "min": 0,
            "max": 100,
            "thresholds": {
              "steps": [
                {"color": "red", "value": 0},
                {"color": "yellow", "value": 80},
                {"color": "green", "value": 95}
              ]
            }
          }
        }
      },
      {
        "id": 3,
        "title": "Application Availability During Chaos",
        "type": "graph",
        "targets": [
          {
            "expr": "avg_over_time(up{job=\"frontend-service\"}[5m])",
            "legendFormat": "Frontend Availability"
          },
          {
            "expr": "avg_over_time(up{job=\"backend-service\"}[5m])",
            "legendFormat": "Backend Availability"
          },
          {
            "expr": "avg_over_time(up{job=\"database-service\"}[5m])",
            "legendFormat": "Database Availability"
          }
        ],
        "yAxes": [
          {
            "min": 0,
            "max": 1,
            "unit": "short"
          }
        ]
      },
      {
        "id": 4,
        "title": "Response Time During Chaos",
        "type": "graph",
        "targets": [
          {
            "expr": "histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{job=\"frontend-service\"}[5m])) by (le))",
            "legendFormat": "95th Percentile Response Time"
          },
          {
            "expr": "histogram_quantile(0.50, sum(rate(http_request_duration_seconds_bucket{job=\"frontend-service\"}[5m])) by (le))",
            "legendFormat": "50th Percentile Response Time"
          }
        ],
        "yAxes": [
          {
            "unit": "s",
            "min": 0
          }
        ]
      },
      {
        "id": 5,
        "title": "Probe Success Rate",
        "type": "graph",
        "targets": [
          {
            "expr": "chaos:probe_success_rate",
            "legendFormat": "{{probe_name}} - {{experiment}}"
          }
        ],
        "yAxes": [
          {
            "min": 0,
            "max": 1,
            "unit": "percentunit"
          }
        ]
      },
      {
        "id": 6,
        "title": "System Recovery Time",
        "type": "table",
        "targets": [
          {
            "expr": "chaos_system_recovery_seconds",
            "format": "table",
            "instant": true
          }
        ],
        "transformations": [
          {
            "id": "organize",
            "options": {
              "excludeByName": {
                "__name__": true,
                "job": true,
                "instance": true
              }
            }
          }
        ]
      },
      {
        "id": 7,
        "title": "Chaos Blast Radius",
        "type": "graph",
        "targets": [
          {
            "expr": "chaos_blast_radius_pods",
            "legendFormat": "{{experiment_name}} - {{namespace}}"
          }
        ],
        "yAxes": [
          {
            "unit": "short",
            "min": 0
          }
        ]
      },
      {
        "id": 8,
        "title": "Error Rate During Chaos",
        "type": "graph",
        "targets": [
          {
            "expr": "sum(rate(http_requests_total{status=~\"5..\"}[5m])) by (service)",
            "legendFormat": "{{service}} Error Rate"
          }
        ],
        "yAxes": [
          {
            "unit": "reqps",
            "min": 0
          }
        ]
      }
    ],
    "time": {
      "from": "now-1h",
      "to": "now"
    },
    "refresh": "30s"
  }
}
```

# Incident Response Automation

Automated incident response during chaos experiments ensures rapid detection and resolution of unexpected failures while maintaining system stability.

## Automated Incident Detection

```go
package incident

import (
    "context"
    "fmt"
    "sync"
    "time"

    "github.com/prometheus/client_golang/api"
    v1 "github.com/prometheus/client_golang/api/prometheus/v1"
    "github.com/prometheus/common/model"
)

type IncidentDetector struct {
    promClient      v1.API
    rules          []DetectionRule
    incidents      map[string]*Incident
    alertCallback  func(*Incident)
    mutex          sync.RWMutex
}

type DetectionRule struct {
    Name        string
    Query       string
    Threshold   float64
    Duration    time.Duration
    Severity    Severity
    Description string
}

type Severity int

const (
    SeverityInfo Severity = iota
    SeverityWarning
    SeverityCritical
    SeverityEmergency
)

type Incident struct {
    ID          string
    Rule        DetectionRule
    Value       float64
    StartTime   time.Time
    EndTime     *time.Time
    Severity    Severity
    Status      IncidentStatus
    Description string
    Actions     []IncidentAction
}

type IncidentStatus int

const (
    StatusActive IncidentStatus = iota
    StatusResolved
    StatusAcknowledged
)

type IncidentAction struct {
    Timestamp   time.Time
    Action      string
    Result      string
    Error       error
}

func NewIncidentDetector(promClient v1.API, alertCallback func(*Incident)) *IncidentDetector {
    return &IncidentDetector{
        promClient:    promClient,
        incidents:     make(map[string]*Incident),
        alertCallback: alertCallback,
        rules: []DetectionRule{
            {
                Name:        "high_error_rate",
                Query:       "sum(rate(http_requests_total{status=~\"5..\"}[5m])) / sum(rate(http_requests_total[5m]))",
                Threshold:   0.05, // 5% error rate
                Duration:    2 * time.Minute,
                Severity:    SeverityCritical,
                Description: "High error rate detected",
            },
            {
                Name:        "low_availability",
                Query:       "avg_over_time(up[5m])",
                Threshold:   0.95, // 95% availability
                Duration:    1 * time.Minute,
                Severity:    SeverityWarning,
                Description: "Low service availability",
            },
            {
                Name:        "high_response_time",
                Query:       "histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))",
                Threshold:   2.0, // 2 seconds
                Duration:    3 * time.Minute,
                Severity:    SeverityWarning,
                Description: "High response time",
            },
            {
                Name:        "pod_crash_loop",
                Query:       "increase(kube_pod_container_status_restarts_total[5m])",
                Threshold:   3, // 3 restarts in 5 minutes
                Duration:    1 * time.Minute,
                Severity:    SeverityCritical,
                Description: "Pod crash loop detected",
            },
        },
    }
}

func (i *IncidentDetector) Start(ctx context.Context) {
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            i.checkRules(ctx)
        }
    }
}

func (i *IncidentDetector) checkRules(ctx context.Context) {
    for _, rule := range i.rules {
        value, err := i.queryMetric(ctx, rule.Query)
        if err != nil {
            continue
        }

        i.evaluateRule(rule, value)
    }
}

func (i *IncidentDetector) queryMetric(ctx context.Context, query string) (float64, error) {
    result, _, err := i.promClient.Query(ctx, query, time.Now())
    if err != nil {
        return 0, err
    }

    vector, ok := result.(model.Vector)
    if !ok || len(vector) == 0 {
        return 0, fmt.Errorf("no data returned for query: %s", query)
    }

    return float64(vector[0].Value), nil
}

func (i *IncidentDetector) evaluateRule(rule DetectionRule, value float64) {
    i.mutex.Lock()
    defer i.mutex.Unlock()

    incidentID := fmt.Sprintf("%s_%d", rule.Name, time.Now().Unix())
    
    if i.shouldTriggerIncident(rule, value) {
        if _, exists := i.incidents[rule.Name]; !exists {
            incident := &Incident{
                ID:          incidentID,
                Rule:        rule,
                Value:       value,
                StartTime:   time.Now(),
                Severity:    rule.Severity,
                Status:      StatusActive,
                Description: fmt.Sprintf("%s: Current value %.2f exceeds threshold %.2f", 
                           rule.Description, value, rule.Threshold),
                Actions:     make([]IncidentAction, 0),
            }
            
            i.incidents[rule.Name] = incident
            
            if i.alertCallback != nil {
                go i.alertCallback(incident)
            }
        }
    } else {
        if incident, exists := i.incidents[rule.Name]; exists && incident.Status == StatusActive {
            incident.Status = StatusResolved
            now := time.Now()
            incident.EndTime = &now
            
            if i.alertCallback != nil {
                go i.alertCallback(incident)
            }
            
            delete(i.incidents, rule.Name)
        }
    }
}

func (i *IncidentDetector) shouldTriggerIncident(rule DetectionRule, value float64) bool {
    switch rule.Name {
    case "low_availability":
        return value < rule.Threshold
    default:
        return value > rule.Threshold
    }
}

func (i *IncidentDetector) GetActiveIncidents() []*Incident {
    i.mutex.RLock()
    defer i.mutex.RUnlock()
    
    incidents := make([]*Incident, 0, len(i.incidents))
    for _, incident := range i.incidents {
        if incident.Status == StatusActive {
            incidents = append(incidents, incident)
        }
    }
    
    return incidents
}
```

## Automated Response Actions

```go
package response

import (
    "context"
    "fmt"
    "log"
    "time"

    "k8s.io/client-go/kubernetes"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/types"
)

type ResponseAction interface {
    Execute(ctx context.Context, incident *Incident) error
    CanHandle(incident *Incident) bool
    Priority() int
}

type AutoScaleAction struct {
    client kubernetes.Interface
}

func NewAutoScaleAction(client kubernetes.Interface) *AutoScaleAction {
    return &AutoScaleAction{client: client}
}

func (a *AutoScaleAction) CanHandle(incident *Incident) bool {
    return incident.Rule.Name == "high_response_time" || 
           incident.Rule.Name == "high_error_rate"
}

func (a *AutoScaleAction) Priority() int {
    return 1 // High priority
}

func (a *AutoScaleAction) Execute(ctx context.Context, incident *Incident) error {
    log.Printf("Executing auto-scale action for incident: %s", incident.ID)
    
    // Scale up deployments
    deployments := []string{"frontend", "backend", "api-gateway"}
    namespace := "ecommerce"
    
    for _, deployment := range deployments {
        err := a.scaleDeployment(ctx, namespace, deployment, 2) // Scale by factor of 2
        if err != nil {
            log.Printf("Failed to scale deployment %s: %v", deployment, err)
            continue
        }
        
        log.Printf("Successfully scaled deployment %s", deployment)
    }
    
    incident.Actions = append(incident.Actions, IncidentAction{
        Timestamp: time.Now(),
        Action:    "auto_scale",
        Result:    "Scaled up deployments",
    })
    
    return nil
}

func (a *AutoScaleAction) scaleDeployment(ctx context.Context, namespace, name string, factor int32) error {
    deployment, err := a.client.AppsV1().Deployments(namespace).Get(ctx, name, metav1.GetOptions{})
    if err != nil {
        return err
    }
    
    currentReplicas := *deployment.Spec.Replicas
    newReplicas := currentReplicas * factor
    
    // Cap at reasonable maximum
    if newReplicas > 10 {
        newReplicas = 10
    }
    
    patch := fmt.Sprintf(`{"spec":{"replicas":%d}}`, newReplicas)
    _, err = a.client.AppsV1().Deployments(namespace).Patch(
        ctx, name, types.StrategicMergePatchType, []byte(patch), metav1.PatchOptions{})
    
    return err
}

type CircuitBreakerAction struct {
    client kubernetes.Interface
}

func NewCircuitBreakerAction(client kubernetes.Interface) *CircuitBreakerAction {
    return &CircuitBreakerAction{client: client}
}

func (c *CircuitBreakerAction) CanHandle(incident *Incident) bool {
    return incident.Rule.Name == "high_error_rate" && incident.Severity >= SeverityCritical
}

func (c *CircuitBreakerAction) Priority() int {
    return 2 // Medium priority
}

func (c *CircuitBreakerAction) Execute(ctx context.Context, incident *Incident) error {
    log.Printf("Executing circuit breaker action for incident: %s", incident.ID)
    
    // Enable circuit breakers by updating ConfigMap
    configMapName := "circuit-breaker-config"
    namespace := "ecommerce"
    
    configMap, err := c.client.CoreV1().ConfigMaps(namespace).Get(ctx, configMapName, metav1.GetOptions{})
    if err != nil {
        return fmt.Errorf("failed to get circuit breaker config: %w", err)
    }
    
    // Update circuit breaker settings
    configMap.Data["failure_threshold"] = "3"
    configMap.Data["timeout"] = "30s"
    configMap.Data["enabled"] = "true"
    
    _, err = c.client.CoreV1().ConfigMaps(namespace).Update(ctx, configMap, metav1.UpdateOptions{})
    if err != nil {
        return fmt.Errorf("failed to update circuit breaker config: %w", err)
    }
    
    incident.Actions = append(incident.Actions, IncidentAction{
        Timestamp: time.Now(),
        Action:    "enable_circuit_breaker",
        Result:    "Circuit breaker enabled with aggressive settings",
    })
    
    return nil
}

type ChaosStopAction struct {
    client kubernetes.Interface
}

func NewChaosStopAction(client kubernetes.Interface) *ChaosStopAction {
    return &ChaosStopAction{client: client}
}

func (c *ChaosStopAction) CanHandle(incident *Incident) bool {
    return incident.Severity >= SeverityEmergency
}

func (c *ChaosStopAction) Priority() int {
    return 0 // Highest priority
}

func (c *ChaosStopAction) Execute(ctx context.Context, incident *Incident) error {
    log.Printf("Executing chaos stop action for incident: %s", incident.ID)
    
    // This would require Litmus client to stop chaos engines
    // For now, we'll use kubectl-style operations
    
    namespaces := []string{"ecommerce", "database", "cache", "monitoring"}
    
    for _, namespace := range namespaces {
        // Delete all active chaos engines
        err := c.deleteActiveChaosEngines(ctx, namespace)
        if err != nil {
            log.Printf("Failed to stop chaos in namespace %s: %v", namespace, err)
            continue
        }
        
        log.Printf("Stopped all chaos experiments in namespace %s", namespace)
    }
    
    incident.Actions = append(incident.Actions, IncidentAction{
        Timestamp: time.Now(),
        Action:    "stop_chaos",
        Result:    "All chaos experiments stopped due to emergency",
    })
    
    return nil
}

func (c *ChaosStopAction) deleteActiveChaosEngines(ctx context.Context, namespace string) error {
    // This would use the Litmus dynamic client
    // Implementation would delete ChaosEngine resources
    return nil
}

type ResponseManager struct {
    actions  []ResponseAction
    detector *IncidentDetector
}

func NewResponseManager(detector *IncidentDetector) *ResponseManager {
    return &ResponseManager{
        actions:  make([]ResponseAction, 0),
        detector: detector,
    }
}

func (r *ResponseManager) RegisterAction(action ResponseAction) {
    r.actions = append(r.actions, action)
}

func (r *ResponseManager) HandleIncident(incident *Incident) {
    if incident.Status != StatusActive {
        return
    }
    
    // Sort actions by priority
    eligibleActions := make([]ResponseAction, 0)
    for _, action := range r.actions {
        if action.CanHandle(incident) {
            eligibleActions = append(eligibleActions, action)
        }
    }
    
    // Sort by priority (lower number = higher priority)
    for i := 0; i < len(eligibleActions)-1; i++ {
        for j := i + 1; j < len(eligibleActions); j++ {
            if eligibleActions[i].Priority() > eligibleActions[j].Priority() {
                eligibleActions[i], eligibleActions[j] = eligibleActions[j], eligibleActions[i]
            }
        }
    }
    
    // Execute actions
    ctx := context.Background()
    for _, action := range eligibleActions {
        err := action.Execute(ctx, incident)
        if err != nil {
            log.Printf("Action execution failed: %v", err)
            incident.Actions = append(incident.Actions, IncidentAction{
                Timestamp: time.Now(),
                Action:    "action_execution",
                Result:    "Failed",
                Error:     err,
            })
        }
    }
}
```

## Slack Integration for Incident Alerts

```go
package notifications

import (
    "bytes"
    "encoding/json"
    "fmt"
    "net/http"
    "time"
)

type SlackNotifier struct {
    webhookURL string
    channel    string
    username   string
}

type SlackMessage struct {
    Channel     string            `json:"channel,omitempty"`
    Username    string            `json:"username,omitempty"`
    Text        string            `json:"text"`
    Attachments []SlackAttachment `json:"attachments,omitempty"`
}

type SlackAttachment struct {
    Color      string       `json:"color"`
    Title      string       `json:"title"`
    Text       string       `json:"text"`
    Fields     []SlackField `json:"fields"`
    Timestamp  int64        `json:"ts"`
    Footer     string       `json:"footer"`
    FooterIcon string       `json:"footer_icon"`
}

type SlackField struct {
    Title string `json:"title"`
    Value string `json:"value"`
    Short bool   `json:"short"`
}

func NewSlackNotifier(webhookURL, channel, username string) *SlackNotifier {
    return &SlackNotifier{
        webhookURL: webhookURL,
        channel:    channel,
        username:   username,
    }
}

func (s *SlackNotifier) SendIncidentAlert(incident *Incident) error {
    color := s.getSeverityColor(incident.Severity)
    emoji := s.getSeverityEmoji(incident.Severity)
    
    var title string
    if incident.Status == StatusActive {
        title = fmt.Sprintf("%s INCIDENT DETECTED: %s", emoji, incident.Rule.Name)
    } else {
        title = fmt.Sprintf("✅ INCIDENT RESOLVED: %s", incident.Rule.Name)
    }
    
    fields := []SlackField{
        {
            Title: "Severity",
            Value: s.getSeverityText(incident.Severity),
            Short: true,
        },
        {
            Title: "Current Value",
            Value: fmt.Sprintf("%.2f", incident.Value),
            Short: true,
        },
        {
            Title: "Threshold",
            Value: fmt.Sprintf("%.2f", incident.Rule.Threshold),
            Short: true,
        },
        {
            Title: "Duration",
            Value: time.Since(incident.StartTime).String(),
            Short: true,
        },
    }
    
    if len(incident.Actions) > 0 {
        actionText := ""
        for _, action := range incident.Actions {
            actionText += fmt.Sprintf("• %s: %s\n", action.Action, action.Result)
        }
        fields = append(fields, SlackField{
            Title: "Automated Actions",
            Value: actionText,
            Short: false,
        })
    }
    
    attachment := SlackAttachment{
        Color:     color,
        Title:     title,
        Text:      incident.Description,
        Fields:    fields,
        Timestamp: incident.StartTime.Unix(),
        Footer:    "Chaos Engineering Platform",
        FooterIcon: "https://github.com/litmuschaos/litmus/raw/master/mkdocs/docs/assets/logo-dark.png",
    }
    
    message := SlackMessage{
        Channel:     s.channel,
        Username:    s.username,
        Text:        "",
        Attachments: []SlackAttachment{attachment},
    }
    
    return s.sendMessage(message)
}

func (s *SlackNotifier) SendChaosReport(experiments []string, duration time.Duration, successRate float64) error {
    color := "good"
    if successRate < 80 {
        color = "warning"
    }
    if successRate < 60 {
        color = "danger"
    }
    
    experimentList := ""
    for _, exp := range experiments {
        experimentList += fmt.Sprintf("• %s\n", exp)
    }
    
    attachment := SlackAttachment{
        Color: color,
        Title: "🧪 Chaos Engineering Test Report",
        Fields: []SlackField{
            {
                Title: "Total Duration",
                Value: duration.String(),
                Short: true,
            },
            {
                Title: "Success Rate",
                Value: fmt.Sprintf("%.1f%%", successRate),
                Short: true,
            },
            {
                Title: "Experiments Executed",
                Value: experimentList,
                Short: false,
            },
        },
        Timestamp: time.Now().Unix(),
        Footer:    "Chaos Engineering Platform",
    }
    
    message := SlackMessage{
        Channel:     s.channel,
        Username:    s.username,
        Text:        "",
        Attachments: []SlackAttachment{attachment},
    }
    
    return s.sendMessage(message)
}

func (s *SlackNotifier) sendMessage(message SlackMessage) error {
    payload, err := json.Marshal(message)
    if err != nil {
        return fmt.Errorf("failed to marshal message: %w", err)
    }
    
    resp, err := http.Post(s.webhookURL, "application/json", bytes.NewBuffer(payload))
    if err != nil {
        return fmt.Errorf("failed to send message: %w", err)
    }
    defer resp.Body.Close()
    
    if resp.StatusCode != http.StatusOK {
        return fmt.Errorf("slack API returned status: %d", resp.StatusCode)
    }
    
    return nil
}

func (s *SlackNotifier) getSeverityColor(severity Severity) string {
    switch severity {
    case SeverityInfo:
        return "#36a64f" // Green
    case SeverityWarning:
        return "#ff9800" // Orange
    case SeverityCritical:
        return "#f44336" // Red
    case SeverityEmergency:
        return "#9c27b0" // Purple
    default:
        return "#607d8b" // Blue Grey
    }
}

func (s *SlackNotifier) getSeverityEmoji(severity Severity) string {
    switch severity {
    case SeverityInfo:
        return "ℹ️"
    case SeverityWarning:
        return "⚠️"
    case SeverityCritical:
        return "🚨"
    case SeverityEmergency:
        return "🆘"
    default:
        return "📊"
    }
}

func (s *SlackNotifier) getSeverityText(severity Severity) string {
    switch severity {
    case SeverityInfo:
        return "Info"
    case SeverityWarning:
        return "Warning"
    case SeverityCritical:
        return "Critical"
    case SeverityEmergency:
        return "Emergency"
    default:
        return "Unknown"
    }
}
```

# Conclusion

Chaos engineering with Litmus on Kubernetes provides a robust framework for building resilient distributed systems. Through systematic failure injection, comprehensive observability, and automated incident response, organizations can proactively identify and address system weaknesses before they impact production users.

The implementation patterns demonstrated in this guide enable teams to establish mature chaos engineering practices that integrate seamlessly with existing CI/CD pipelines and operational workflows. By treating failure as a normal part of system operation and continuously validating resilience mechanisms, teams can build confidence in their systems' ability to handle unexpected conditions.

Key success factors include starting with controlled experiments, gradually expanding blast radius, maintaining comprehensive observability, and automating response actions where appropriate. The combination of proactive chaos testing and reactive incident response creates a powerful foundation for building antifragile systems that improve under stress rather than merely surviving it.

As distributed systems continue to grow in complexity, chaos engineering becomes increasingly essential for maintaining system reliability and ensuring optimal user experience. The tools and techniques presented in this guide provide the foundation for implementing world-class chaos engineering practices that scale with organizational needs and system complexity.