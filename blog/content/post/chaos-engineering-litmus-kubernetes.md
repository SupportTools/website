---
title: "Chaos Engineering Implementation with Litmus on Kubernetes"
date: 2026-05-10T00:00:00-05:00
draft: false
tags: ["Chaos Engineering", "Litmus", "Kubernetes", "Reliability", "SRE", "DevOps", "Observability", "CI/CD"]
categories:
- Chaos Engineering
- Kubernetes
- SRE
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing chaos engineering with Litmus on Kubernetes, covering setup, experiment design, automated testing, and production-ready practices for building resilient systems."
more_link: "yes"
url: "/chaos-engineering-litmus-kubernetes/"
---

Chaos Engineering has emerged as a critical discipline for building resilient distributed systems. As organizations increasingly rely on Kubernetes for production workloads, the need for systematic failure testing becomes paramount. Litmus, a Cloud Native Computing Foundation (CNCF) project, provides a comprehensive chaos engineering platform specifically designed for Kubernetes environments.

This comprehensive guide explores implementing chaos engineering with Litmus, covering everything from basic setup to advanced production scenarios, automated testing pipelines, and observability integration.

<!--more-->

# Understanding Chaos Engineering Principles

## The Foundation of Chaos Engineering

Chaos Engineering is the discipline of experimenting on a system to build confidence in the system's capability to withstand turbulent conditions in production. The practice involves four fundamental principles:

1. **Define "steady state" as some measurable output** - Establish baseline metrics that indicate normal system behavior
2. **Hypothesize that this steady state will continue** - Form testable hypotheses about system behavior under failure conditions
3. **Introduce variables that reflect real-world events** - Simulate realistic failure scenarios
4. **Try to disprove the hypothesis** - Design experiments to challenge system assumptions

## Why Kubernetes Needs Chaos Engineering

Kubernetes environments introduce unique complexities:

- **Dynamic scheduling** - Pods can be scheduled on any node
- **Network complexity** - Multiple networking layers and service meshes
- **Storage dependencies** - Persistent volumes and storage classes
- **Distributed state** - etcd clusters and control plane components
- **Resource constraints** - CPU, memory, and storage limitations

These complexities create numerous failure scenarios that traditional testing methods cannot adequately cover.

# Litmus Architecture and Components

## Core Components Overview

Litmus consists of several key components that work together to orchestrate chaos experiments:

### Litmus Portal
The central management interface providing:
- Experiment workflow management
- Real-time monitoring and analytics
- Team collaboration features
- Integration with observability tools

### Chaos Operator
A Kubernetes operator that:
- Manages the lifecycle of chaos experiments
- Handles experiment scheduling and execution
- Provides resource management and cleanup

### Chaos Exporter
Metrics collection component that:
- Exports experiment metrics to Prometheus
- Provides observability into chaos experiment results
- Enables integration with monitoring dashboards

### Chaos Runner
The execution engine that:
- Runs individual chaos experiments
- Manages experiment state and progression
- Handles failure injection and recovery

## Litmus CRDs (Custom Resource Definitions)

Litmus introduces several custom resources:

```yaml
# ChaosEngine - Defines the chaos experiment configuration
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: nginx-chaos
  namespace: default
spec:
  engineState: 'active'
  appinfo:
    appns: 'default'
    applabel: 'app=nginx'
    appkind: 'deployment'
  chaosServiceAccount: litmus-admin
  experiments:
  - name: pod-delete
    spec:
      components:
        env:
        - name: TOTAL_CHAOS_DURATION
          value: '30'
        - name: CHAOS_INTERVAL
          value: '10'
        - name: FORCE
          value: 'false'

# ChaosExperiment - Defines the chaos experiment template
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosExperiment
metadata:
  name: pod-delete
  labels:
    name: pod-delete
    app.kubernetes.io/part-of: litmus
    app.kubernetes.io/component: chaosexperiment
    app.kubernetes.io/version: latest
spec:
  definition:
    scope: Namespaced
    permissions:
    - apiGroups: [""]
      resources: ["pods"]
      verbs: ["create","delete","get","list","patch","update","deletecollection"]
    - apiGroups: [""]
      resources: ["events"]
      verbs: ["create","get","list","patch","update"]
    - apiGroups: [""]
      resources: ["configmaps"]
      verbs: ["get","list"]
    - apiGroups: [""]
      resources: ["pods/log"]
      verbs: ["get","list","watch"]
    - apiGroups: [""]
      resources: ["pods/exec"]
      verbs: ["get","list","create"]
    - apiGroups: ["apps"]
      resources: ["deployments","statefulsets","replicasets","daemonsets"]
      verbs: ["list","get"]
    - apiGroups: ["apps"]
      resources: ["deployments/scale","statefulsets/scale"]
      verbs: ["patch"]
    - apiGroups: [""]
      resources: ["replicationcontrollers"]
      verbs: ["get","list"]
    - apiGroups: ["argoproj.io"]
      resources: ["rollouts"]
      verbs: ["list","get"]
    - apiGroups: ["batch"]
      resources: ["jobs"]
      verbs: ["create","list","get","delete","deletecollection"]
    - apiGroups: ["litmuschaos.io"]
      resources: ["chaosengines","chaosexperiments","chaosresults"]
      verbs: ["create","list","get","patch","update","delete"]
    image: "litmuschaos/go-runner:latest"
    imagePullPolicy: Always
    args:
    - -c
    - ./experiments -name pod-delete
    command:
    - /bin/bash
    env:
    - name: TOTAL_CHAOS_DURATION
      value: '15'
    - name: RAMP_TIME
      value: ''
    - name: FORCE
      value: 'true'
    - name: CHAOS_INTERVAL
      value: '5'
    - name: PODS_AFFECTED_PERC
      value: ''
    - name: LIB
      value: 'litmus'
    - name: TARGET_PODS
      value: ''
    - name: SEQUENCE
      value: 'parallel'
    labels:
      name: pod-delete
      app.kubernetes.io/part-of: litmus
      app.kubernetes.io/component: experiment-job
      app.kubernetes.io/version: latest

# ChaosResult - Stores the experiment execution results
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosResult
metadata:
  name: nginx-chaos-pod-delete
  namespace: default
spec:
  engine: nginx-chaos
  experiment: pod-delete
status:
  experimentStatus:
    phase: Completed
    verdict: Pass
  history:
    targets:
    - name: nginx-deployment-7d8f7b6c4f-xyz123
      kind: Pod
```

# Litmus Installation and Setup

## Prerequisites

Before installing Litmus, ensure your Kubernetes cluster meets these requirements:

```bash
# Verify Kubernetes version (1.17+)
kubectl version --short

# Check cluster permissions
kubectl auth can-i create customresourcedefinitions --all-namespaces
kubectl auth can-i create clusterroles
kubectl auth can-i create clusterrolebindings

# Verify storage class availability
kubectl get storageclass
```

## Installing Litmus Using Helm

The recommended installation method uses Helm charts:

```bash
# Add Litmus Helm repository
helm repo add litmuschaos https://litmuschaos.github.io/litmus-helm/
helm repo update

# Create namespace for Litmus
kubectl create namespace litmus

# Install Litmus with custom values
cat > litmus-values.yaml <<EOF
portal:
  frontend:
    service:
      type: LoadBalancer
    resources:
      requests:
        memory: "250Mi"
        cpu: "125m"
      limits:
        memory: "512Mi"
        cpu: "250m"
  
  server:
    resources:
      requests:
        memory: "250Mi"
        cpu: "125m"
      limits:
        memory: "512Mi"
        cpu: "250m"
    
    authServer:
      resources:
        requests:
          memory: "250Mi"
          cpu: "125m"
        limits:
          memory: "512Mi"
          cpu: "250m"

mongodb:
  resources:
    requests:
      memory: "250Mi"
      cpu: "125m"
    limits:
      memory: "512Mi"
      cpu: "250m"
  persistence:
    size: 20Gi

ingress:
  enabled: true
  annotations:
    kubernetes.io/ingress.class: "nginx"
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
  hosts:
    - host: litmus.your-domain.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: litmus-tls
      hosts:
        - litmus.your-domain.com
EOF

# Install Litmus
helm install litmus litmuschaos/litmus \
  --namespace litmus \
  --values litmus-values.yaml
```

## Verifying the Installation

```bash
# Check all Litmus components are running
kubectl get pods -n litmus

# Verify custom resource definitions
kubectl get crd | grep chaos

# Check Litmus operator logs
kubectl logs -n litmus -l app.kubernetes.io/name=litmus-portal-server

# Access Litmus Portal (if using LoadBalancer)
kubectl get svc -n litmus litmus-portal-frontend-service
```

## Initial Configuration

After installation, configure the initial setup:

```bash
# Get the default admin credentials
kubectl get secret litmus-portal-admin-secret -n litmus -o jsonpath='{.data.JWE_PASSWORD}' | base64 -d

# Create additional user accounts via the portal
# Or use the API:
curl -X POST \
  http://litmus.your-domain.com/auth/create_user \
  -H 'Content-Type: application/json' \
  -d '{
    "email": "user@example.com",
    "password": "secure-password",
    "username": "chaos-engineer",
    "role": "admin"
  }'
```

# Setting Up Chaos Experiments

## Experiment Categories

Litmus provides experiments across several categories:

### Pod-Level Experiments
- **pod-delete**: Kills one or more pods
- **pod-cpu-hog**: Consumes CPU resources
- **pod-memory-hog**: Consumes memory resources
- **pod-network-latency**: Introduces network latency
- **pod-network-loss**: Simulates packet loss
- **pod-network-corruption**: Corrupts network packets

### Node-Level Experiments
- **node-drain**: Drains a Kubernetes node
- **node-cpu-hog**: Consumes node CPU resources
- **node-memory-hog**: Consumes node memory
- **node-io-stress**: Creates I/O stress on nodes
- **kubelet-service-kill**: Kills the kubelet service

### Platform-Specific Experiments
- **aws-ec2-terminate**: Terminates EC2 instances
- **gcp-vm-instance-stop**: Stops GCP VM instances
- **azure-instance-stop**: Stops Azure VM instances
- **aws-ebs-loss**: Detaches EBS volumes

## Creating Your First Chaos Experiment

Let's create a comprehensive pod deletion experiment:

```yaml
# chaos-experiment-pod-delete.yaml
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  name: pod-delete-chaos-workflow
  namespace: litmus
spec:
  entrypoint: chaos-workflow
  serviceAccountName: argo-chaos
  templates:
  - name: chaos-workflow
    steps:
    - - name: install-chaos-experiments
        template: install-chaos-experiments
    - - name: pod-delete
        template: pod-delete
    - - name: revert-chaos
        template: revert-chaos
  
  - name: install-chaos-experiments
    container:
      image: litmuschaos/k8s:latest
      command: [sh, -c]
      args:
        - "kubectl apply -f https://hub.litmuschaos.io/api/chaos/master?file=charts/generic/experiments.yaml -n {{workflow.parameters.adminModeNamespace}} | sleep 30"

  - name: pod-delete
    inputs:
      artifacts:
      - name: pod-delete
        path: /tmp/chaosengine-pod-delete.yaml
        raw:
          data: |
            apiVersion: litmuschaos.io/v1alpha1
            kind: ChaosEngine
            metadata:
              name: pod-delete-chaos
              namespace: default
            spec:
              engineState: 'active'
              appinfo:
                appns: 'default'
                applabel: 'app=nginx'
                appkind: 'deployment'
              chaosServiceAccount: litmus-admin
              experiments:
              - name: pod-delete
                spec:
                  components:
                    env:
                    - name: TOTAL_CHAOS_DURATION
                      value: '30'
                    - name: CHAOS_INTERVAL
                      value: '10'
                    - name: FORCE
                      value: 'false'
                    - name: PODS_AFFECTED_PERC
                      value: '50'
                  probe:
                  - name: nginx-probe
                    type: httpProbe
                    mode: Continuous
                    runProperties:
                      probeTimeout: 10s
                      retry: 3
                      interval: 5s
                      probePollingInterval: 2s
                    httpProbe/inputs:
                      url: http://nginx-service.default.svc.cluster.local
                      insecureSkipTLS: true
                      method:
                        get:
                          criteria: ==
                          responseCode: "200"
    container:
      image: litmuschaos/litmus-checker:latest
      args: ["-file=/tmp/chaosengine-pod-delete.yaml","-saveName=/tmp/engine-name"]

  - name: revert-chaos
    container:
      image: litmuschaos/k8s:latest
      command: [sh, -c]
      args:
        - "kubectl delete chaosengine pod-delete-chaos -n default"
```

## Advanced Experiment Configuration

### Multi-Step Experiment with Probes

```yaml
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: comprehensive-chaos-test
  namespace: production
spec:
  engineState: 'active'
  appinfo:
    appns: 'production'
    applabel: 'tier=frontend'
    appkind: 'deployment'
  chaosServiceAccount: litmus-admin
  experiments:
  - name: pod-cpu-hog
    spec:
      components:
        env:
        - name: TOTAL_CHAOS_DURATION
          value: '60'
        - name: CPU_CORES
          value: '2'
        - name: PODS_AFFECTED_PERC
          value: '25'
      probe:
      - name: "cpu-probe"
        type: "cmdProbe"
        mode: "Edge"
        runProperties:
          probeTimeout: 5s
          retry: 3
          interval: 5s
        cmdProbe/inputs:
          command: "kubectl"
          args: 
            - "top"
            - "pods"
            - "-n"
            - "production"
            - "--sort-by=cpu"
          source:
            image: "bitnami/kubectl:latest"
            hostNetwork: false
          comparator:
            type: "int"
            criteria: "<"
            value: "80"
      
      - name: "availability-probe"
        type: "httpProbe"
        mode: "Continuous"
        runProperties:
          probeTimeout: 10s
          retry: 3
          interval: 10s
          probePollingInterval: 2s
        httpProbe/inputs:
          url: "http://frontend-service.production.svc.cluster.local/health"
          insecureSkipTLS: true
          method:
            get:
              criteria: "=="
              responseCode: "200"
      
      - name: "latency-probe"
        type: "promProbe"
        mode: "Continuous"
        runProperties:
          probeTimeout: 5s
          retry: 3
          interval: 5s
        promProbe/inputs:
          endpoint: "http://prometheus.monitoring.svc.cluster.local:9090"
          query: "histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))"
          comparator:
            criteria: "<"
            value: "0.5"
```

### Resource Stress Testing

```yaml
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: resource-stress-test
  namespace: testing
spec:
  engineState: 'active'
  appinfo:
    appns: 'testing'
    applabel: 'app=microservice'
    appkind: 'deployment'
  chaosServiceAccount: litmus-admin
  experiments:
  - name: pod-memory-hog
    spec:
      components:
        env:
        - name: TOTAL_CHAOS_DURATION
          value: '120'
        - name: MEMORY_CONSUMPTION
          value: '500'
        - name: NUMBER_OF_WORKERS
          value: '4'
        - name: PODS_AFFECTED_PERC
          value: '50'
        - name: SEQUENCE
          value: 'parallel'
      probe:
      - name: "memory-usage-probe"
        type: "k8sProbe"
        mode: "Continuous"
        runProperties:
          probeTimeout: 5s
          retry: 3
          interval: 10s
        k8sProbe/inputs:
          group: ""
          version: "v1"
          resource: "pods"
          namespace: "testing"
          fieldSelector: "status.phase=Running"
          labelSelector: "app=microservice"
          operation: "present"
      
      - name: "oom-killer-probe"
        type: "cmdProbe"
        mode: "OnChaos"
        runProperties:
          probeTimeout: 30s
          retry: 1
          interval: 30s
        cmdProbe/inputs:
          command: "sh"
          args:
            - "-c"
            - "dmesg | grep -i 'killed process' | wc -l"
          source:
            image: "alpine:latest"
            hostNetwork: true
            inheritInputs: true
          comparator:
            type: "int"
            criteria: "=="
            value: "0"
```

# Network Chaos Testing

## Network Latency Experiments

```yaml
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: network-latency-test
  namespace: ecommerce
spec:
  engineState: 'active'
  appinfo:
    appns: 'ecommerce'
    applabel: 'service=payment'
    appkind: 'deployment'
  chaosServiceAccount: litmus-admin
  experiments:
  - name: pod-network-latency
    spec:
      components:
        env:
        - name: TOTAL_CHAOS_DURATION
          value: '60'
        - name: NETWORK_LATENCY
          value: '2000'
        - name: JITTER
          value: '200'
        - name: CONTAINER_RUNTIME
          value: 'containerd'
        - name: SOCKET_PATH
          value: '/run/containerd/containerd.sock'
        - name: DESTINATION_IPS
          value: 'database-service.ecommerce.svc.cluster.local'
        - name: DESTINATION_HOSTS
          value: 'external-payment-api.com'
      probe:
      - name: "payment-latency-probe"
        type: "httpProbe"
        mode: "Continuous"
        runProperties:
          probeTimeout: 15s
          retry: 3
          interval: 5s
          probePollingInterval: 2s
        httpProbe/inputs:
          url: "http://payment-service.ecommerce.svc.cluster.local/api/process"
          insecureSkipTLS: true
          method:
            post:
              contentType: "application/json"
              body: '{"amount":100,"currency":"USD","test":true}'
              criteria: "<"
              responseTimeout: "10s"
      
      - name: "database-connectivity-probe"
        type: "cmdProbe"
        mode: "Continuous"
        runProperties:
          probeTimeout: 10s
          retry: 3
          interval: 15s
        cmdProbe/inputs:
          command: "nc"
          args:
            - "-zv"
            - "database-service.ecommerce.svc.cluster.local"
            - "5432"
          source:
            image: "busybox:latest"
          comparator:
            type: "string"
            criteria: "contains"
            value: "succeeded"
```

## Packet Loss Simulation

```yaml
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: packet-loss-simulation
  namespace: microservices
spec:
  engineState: 'active'
  appinfo:
    appns: 'microservices'
    applabel: 'tier=api-gateway'
    appkind: 'deployment'
  chaosServiceAccount: litmus-admin
  experiments:
  - name: pod-network-loss
    spec:
      components:
        env:
        - name: TOTAL_CHAOS_DURATION
          value: '90'
        - name: NETWORK_PACKET_LOSS_PERCENTAGE
          value: '10'
        - name: CONTAINER_RUNTIME
          value: 'containerd'
        - name: SOCKET_PATH
          value: '/run/containerd/containerd.sock'
        - name: DESTINATION_IPS
          value: 'user-service.microservices.svc.cluster.local,order-service.microservices.svc.cluster.local'
      probe:
      - name: "service-mesh-probe"
        type: "promProbe"
        mode: "Continuous"
        runProperties:
          probeTimeout: 10s
          retry: 3
          interval: 15s
        promProbe/inputs:
          endpoint: "http://prometheus.istio-system.svc.cluster.local:9090"
          query: "istio_request_total{destination_service_name=\"user-service\",response_code!=\"200\"}"
          comparator:
            criteria: "<"
            value: "5"
      
      - name: "circuit-breaker-probe"
        type: "k8sProbe"
        mode: "Edge"
        runProperties:
          probeTimeout: 5s
          retry: 3
          interval: 10s
        k8sProbe/inputs:
          group: "networking.istio.io"
          version: "v1beta1"
          resource: "destinationrules"
          namespace: "microservices"
          fieldSelector: "metadata.name=user-service-circuit-breaker"
          operation: "present"
```

# Storage and Persistent Volume Chaos

## Disk Fill Experiments

```yaml
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: storage-chaos-test
  namespace: database
spec:
  engineState: 'active'
  appinfo:
    appns: 'database'
    applabel: 'app=postgresql'
    appkind: 'statefulset'
  chaosServiceAccount: litmus-admin
  experiments:
  - name: disk-fill
    spec:
      components:
        env:
        - name: TOTAL_CHAOS_DURATION
          value: '180'
        - name: FILL_PERCENTAGE
          value: '80'
        - name: EPHEMERAL_STORAGE_MEBIBYTES
          value: '1000'
        - name: CONTAINER_PATH
          value: '/var/lib/postgresql/data'
      probe:
      - name: "database-health-probe"
        type: "cmdProbe"
        mode: "Continuous"
        runProperties:
          probeTimeout: 15s
          retry: 3
          interval: 30s
        cmdProbe/inputs:
          command: "pg_isready"
          args:
            - "-h"
            - "postgresql.database.svc.cluster.local"
            - "-p"
            - "5432"
            - "-U"
            - "postgres"
          source:
            image: "postgres:13"
          comparator:
            type: "string"
            criteria: "contains"
            value: "accepting connections"
      
      - name: "disk-usage-probe"
        type: "cmdProbe"
        mode: "Continuous"
        runProperties:
          probeTimeout: 10s
          retry: 2
          interval: 20s
        cmdProbe/inputs:
          command: "df"
          args:
            - "-h"
            - "/var/lib/postgresql/data"
          source:
            image: "busybox:latest"
          comparator:
            type: "string"
            criteria: "!contains"
            value: "100%"
      
      - name: "backup-integrity-probe"
        type: "httpProbe"
        mode: "Edge"
        runProperties:
          probeTimeout: 30s
          retry: 3
          interval: 60s
        httpProbe/inputs:
          url: "http://backup-service.database.svc.cluster.local/health"
          insecureSkipTLS: true
          method:
            get:
              criteria: "=="
              responseCode: "200"
```

## PVC Detachment Simulation

```yaml
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: pvc-detachment-test
  namespace: storage-test
spec:
  engineState: 'active'
  appinfo:
    appns: 'storage-test'
    applabel: 'app=file-processor'
    appkind: 'deployment'
  chaosServiceAccount: litmus-admin
  experiments:
  - name: disk-loss
    spec:
      components:
        env:
        - name: TOTAL_CHAOS_DURATION
          value: '120'
        - name: APP_NAMESPACE
          value: 'storage-test'
        - name: APP_LABEL
          value: 'app=file-processor'
        - name: APP_KIND
          value: 'deployment'
      probe:
      - name: "pvc-status-probe"
        type: "k8sProbe"
        mode: "Continuous"
        runProperties:
          probeTimeout: 10s
          retry: 3
          interval: 15s
        k8sProbe/inputs:
          group: ""
          version: "v1"
          resource: "persistentvolumeclaims"
          namespace: "storage-test"
          labelSelector: "app=file-processor"
          operation: "present"
      
      - name: "pod-restart-probe"
        type: "k8sProbe"
        mode: "OnChaos"
        runProperties:
          probeTimeout: 30s
          retry: 5
          interval: 10s
        k8sProbe/inputs:
          group: ""
          version: "v1"
          resource: "pods"
          namespace: "storage-test"
          labelSelector: "app=file-processor"
          fieldSelector: "status.phase=Running"
          operation: "present"
```

# Observability Integration

## Prometheus Metrics Integration

Configure Prometheus to collect Litmus metrics:

```yaml
# prometheus-litmus-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-litmus-config
  namespace: monitoring
data:
  litmus-metrics.yml: |
    global:
      scrape_interval: 15s
      evaluation_interval: 15s
    
    rule_files:
      - "/etc/prometheus/rules/*.yml"
    
    scrape_configs:
    - job_name: 'litmus-metrics'
      static_configs:
      - targets: ['chaos-exporter.litmus.svc.cluster.local:8080']
      scrape_interval: 5s
      metrics_path: /metrics
    
    - job_name: 'chaos-operator-metrics'
      static_configs:
      - targets: ['chaos-operator-metrics.litmus.svc.cluster.local:8383']
      scrape_interval: 10s
      metrics_path: /metrics

---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: litmus-chaos-exporter
  namespace: monitoring
  labels:
    app: litmus-chaos-exporter
spec:
  selector:
    matchLabels:
      app: chaos-exporter
  endpoints:
  - port: tcp-8080-8080
    interval: 5s
    path: /metrics
  namespaceSelector:
    matchNames:
    - litmus
```

## Grafana Dashboard Configuration

Create comprehensive Grafana dashboards for chaos engineering metrics:

```json
{
  "dashboard": {
    "id": null,
    "title": "Litmus Chaos Engineering Dashboard",
    "tags": ["chaos", "litmus", "sre"],
    "style": "dark",
    "timezone": "browser",
    "panels": [
      {
        "id": 1,
        "title": "Chaos Experiment Status",
        "type": "stat",
        "targets": [
          {
            "expr": "litmuschaos_experiment_status",
            "legendFormat": "{{experiment_name}} - {{status}}"
          }
        ],
        "fieldConfig": {
          "defaults": {
            "color": {
              "mode": "palette-classic"
            },
            "custom": {
              "displayMode": "list",
              "orientation": "horizontal"
            },
            "mappings": [
              {
                "options": {
                  "0": {
                    "text": "Not Started"
                  },
                  "1": {
                    "text": "Running"
                  },
                  "2": {
                    "text": "Completed"
                  },
                  "3": {
                    "text": "Failed"
                  }
                },
                "type": "value"
              }
            ]
          }
        }
      },
      {
        "id": 2,
        "title": "Experiment Success Rate",
        "type": "timeseries",
        "targets": [
          {
            "expr": "rate(litmuschaos_experiment_passed_total[5m]) / rate(litmuschaos_experiment_total[5m]) * 100",
            "legendFormat": "Success Rate %"
          }
        ]
      },
      {
        "id": 3,
        "title": "Application SLA During Chaos",
        "type": "timeseries",
        "targets": [
          {
            "expr": "probe_success",
            "legendFormat": "{{probe_name}}"
          }
        ]
      },
      {
        "id": 4,
        "title": "Resource Utilization During Chaos",
        "type": "timeseries",
        "targets": [
          {
            "expr": "rate(container_cpu_usage_seconds_total[1m]) * 100",
            "legendFormat": "CPU - {{pod}}"
          },
          {
            "expr": "container_memory_usage_bytes / container_spec_memory_limit_bytes * 100",
            "legendFormat": "Memory - {{pod}}"
          }
        ]
      }
    ],
    "time": {
      "from": "now-1h",
      "to": "now"
    },
    "refresh": "5s"
  }
}
```

## Alert Rules for Chaos Experiments

```yaml
# chaos-alert-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: litmus-chaos-alerts
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
  - name: chaos.rules
    rules:
    - alert: ChaosExperimentFailed
      expr: litmuschaos_experiment_status == 3
      for: 0m
      labels:
        severity: critical
      annotations:
        summary: "Chaos experiment {{ $labels.experiment_name }} failed"
        description: "Chaos experiment {{ $labels.experiment_name }} in namespace {{ $labels.namespace }} has failed. This indicates a potential reliability issue."
    
    - alert: ApplicationSLABreach
      expr: probe_success == 0
      for: 2m
      labels:
        severity: warning
      annotations:
        summary: "Application SLA breach detected during chaos experiment"
        description: "Probe {{ $labels.probe_name }} is failing for more than 2 minutes during chaos testing."
    
    - alert: HighChaosExperimentFailureRate
      expr: (rate(litmuschaos_experiment_failed_total[10m]) / rate(litmuschaos_experiment_total[10m])) > 0.5
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "High chaos experiment failure rate detected"
        description: "More than 50% of chaos experiments are failing in the last 10 minutes."
    
    - alert: LongRunningChaosExperiment
      expr: time() - litmuschaos_experiment_start_time > 3600
      for: 0m
      labels:
        severity: warning
      annotations:
        summary: "Chaos experiment running for more than 1 hour"
        description: "Experiment {{ $labels.experiment_name }} has been running for more than 1 hour, which may indicate it's stuck."
```

# Automated Chaos Testing in CI/CD

## GitLab CI Integration

```yaml
# .gitlab-ci.yml
stages:
  - build
  - test
  - chaos-test
  - deploy

variables:
  KUBECONFIG: /tmp/kubeconfig
  CHAOS_NAMESPACE: "chaos-testing"

build:
  stage: build
  script:
    - docker build -t $CI_REGISTRY_IMAGE:$CI_COMMIT_SHA .
    - docker push $CI_REGISTRY_IMAGE:$CI_COMMIT_SHA

unit-tests:
  stage: test
  script:
    - go test ./...

chaos-test:
  stage: chaos-test
  image: litmuschaos/litmus-e2e:latest
  before_script:
    - echo "$KUBE_CONFIG" | base64 -d > $KUBECONFIG
    - kubectl config set-context --current --namespace=$CHAOS_NAMESPACE
  script:
    - |
      # Deploy application to chaos testing environment
      helm upgrade --install test-app ./helm-chart \
        --namespace $CHAOS_NAMESPACE \
        --set image.tag=$CI_COMMIT_SHA \
        --wait --timeout=300s
      
      # Run pod deletion chaos test
      kubectl apply -f - <<EOF
      apiVersion: litmuschaos.io/v1alpha1
      kind: ChaosEngine
      metadata:
        name: ci-pod-delete-$CI_PIPELINE_ID
        namespace: $CHAOS_NAMESPACE
      spec:
        engineState: 'active'
        appinfo:
          appns: '$CHAOS_NAMESPACE'
          applabel: 'app=test-app'
          appkind: 'deployment'
        chaosServiceAccount: litmus-admin
        experiments:
        - name: pod-delete
          spec:
            components:
              env:
              - name: TOTAL_CHAOS_DURATION
                value: '60'
              - name: CHAOS_INTERVAL
                value: '15'
              - name: FORCE
                value: 'false'
            probe:
            - name: availability-probe
              type: httpProbe
              mode: Continuous
              runProperties:
                probeTimeout: 10s
                retry: 3
                interval: 5s
              httpProbe/inputs:
                url: http://test-app.$CHAOS_NAMESPACE.svc.cluster.local/health
                insecureSkipTLS: true
                method:
                  get:
                    criteria: "=="
                    responseCode: "200"
      EOF
      
      # Wait for chaos experiment to complete
      kubectl wait --for=condition=complete \
        chaosresult/ci-pod-delete-$CI_PIPELINE_ID-pod-delete \
        --namespace=$CHAOS_NAMESPACE \
        --timeout=300s
      
      # Check experiment result
      VERDICT=$(kubectl get chaosresult ci-pod-delete-$CI_PIPELINE_ID-pod-delete \
        -n $CHAOS_NAMESPACE -o jsonpath='{.status.experimentStatus.verdict}')
      
      if [ "$VERDICT" != "Pass" ]; then
        echo "Chaos experiment failed with verdict: $VERDICT"
        exit 1
      fi
      
      echo "Chaos experiment passed successfully"
  after_script:
    - kubectl delete chaosengine ci-pod-delete-$CI_PIPELINE_ID -n $CHAOS_NAMESPACE --ignore-not-found
  only:
    - merge_requests
    - main

deploy-production:
  stage: deploy
  script:
    - helm upgrade --install prod-app ./helm-chart --namespace production
  only:
    - main
  when: manual
```

## GitHub Actions Workflow

```yaml
# .github/workflows/chaos-testing.yml
name: Chaos Engineering Tests

on:
  pull_request:
    branches: [ main ]
  push:
    branches: [ main ]

env:
  CHAOS_NAMESPACE: chaos-testing
  KUBECTL_VERSION: v1.28.0

jobs:
  chaos-test:
    runs-on: ubuntu-latest
    steps:
    - name: Checkout code
      uses: actions/checkout@v4
    
    - name: Set up kubectl
      uses: azure/setup-kubectl@v3
      with:
        version: ${{ env.KUBECTL_VERSION }}
    
    - name: Configure kubeconfig
      run: |
        mkdir -p ~/.kube
        echo "${{ secrets.KUBECONFIG }}" | base64 -d > ~/.kube/config
    
    - name: Install Litmus ChaosCenter CLI
      run: |
        curl -O https://litmusctl-production-bucket.s3.amazonaws.com/litmusctl-linux-amd64-master.tar.gz
        tar -zxvf litmusctl-linux-amd64-master.tar.gz
        chmod +x litmusctl
        sudo mv litmusctl /usr/local/bin/
    
    - name: Deploy test application
      run: |
        kubectl create namespace $CHAOS_NAMESPACE --dry-run=client -o yaml | kubectl apply -f -
        helm upgrade --install test-app ./charts/app \
          --namespace $CHAOS_NAMESPACE \
          --set image.tag=${{ github.sha }} \
          --wait --timeout=300s
    
    - name: Run CPU stress test
      id: cpu-stress
      run: |
        cat > cpu-stress-test.yaml <<EOF
        apiVersion: litmuschaos.io/v1alpha1
        kind: ChaosEngine
        metadata:
          name: cpu-stress-${{ github.run_id }}
          namespace: $CHAOS_NAMESPACE
        spec:
          engineState: 'active'
          appinfo:
            appns: '$CHAOS_NAMESPACE'
            applabel: 'app=test-app'
            appkind: 'deployment'
          chaosServiceAccount: litmus-admin
          experiments:
          - name: pod-cpu-hog
            spec:
              components:
                env:
                - name: TOTAL_CHAOS_DURATION
                  value: '120'
                - name: CPU_CORES
                  value: '1'
                - name: PODS_AFFECTED_PERC
                  value: '50'
              probe:
              - name: response-time-probe
                type: httpProbe
                mode: Continuous
                runProperties:
                  probeTimeout: 5s
                  retry: 3
                  interval: 10s
                httpProbe/inputs:
                  url: http://test-app.$CHAOS_NAMESPACE.svc.cluster.local/api/health
                  insecureSkipTLS: true
                  method:
                    get:
                      criteria: "<"
                      responseTimeout: "3s"
        EOF
        
        kubectl apply -f cpu-stress-test.yaml
        
        # Wait for experiment completion
        timeout 300s bash -c 'until kubectl get chaosresult cpu-stress-${{ github.run_id }}-pod-cpu-hog -n $CHAOS_NAMESPACE; do sleep 10; done'
        
        # Get experiment verdict
        VERDICT=$(kubectl get chaosresult cpu-stress-${{ github.run_id }}-pod-cpu-hog \
          -n $CHAOS_NAMESPACE -o jsonpath='{.status.experimentStatus.verdict}')
        
        echo "cpu_stress_verdict=$VERDICT" >> $GITHUB_OUTPUT
        
        if [ "$VERDICT" != "Pass" ]; then
          echo "CPU stress test failed"
          exit 1
        fi
    
    - name: Run network latency test
      id: network-latency
      run: |
        cat > network-latency-test.yaml <<EOF
        apiVersion: litmuschaos.io/v1alpha1
        kind: ChaosEngine
        metadata:
          name: network-latency-${{ github.run_id }}
          namespace: $CHAOS_NAMESPACE
        spec:
          engineState: 'active'
          appinfo:
            appns: '$CHAOS_NAMESPACE'
            applabel: 'app=test-app'
            appkind: 'deployment'
          chaosServiceAccount: litmus-admin
          experiments:
          - name: pod-network-latency
            spec:
              components:
                env:
                - name: TOTAL_CHAOS_DURATION
                  value: '60'
                - name: NETWORK_LATENCY
                  value: '2000'
                - name: JITTER
                  value: '200'
                - name: CONTAINER_RUNTIME
                  value: 'containerd'
                - name: SOCKET_PATH
                  value: '/run/containerd/containerd.sock'
              probe:
              - name: latency-tolerance-probe
                type: httpProbe
                mode: Continuous
                runProperties:
                  probeTimeout: 15s
                  retry: 3
                  interval: 5s
                httpProbe/inputs:
                  url: http://test-app.$CHAOS_NAMESPACE.svc.cluster.local/api/ping
                  insecureSkipTLS: true
                  method:
                    get:
                      criteria: "=="
                      responseCode: "200"
        EOF
        
        kubectl apply -f network-latency-test.yaml
        
        # Wait for experiment completion
        timeout 300s bash -c 'until kubectl get chaosresult network-latency-${{ github.run_id }}-pod-network-latency -n $CHAOS_NAMESPACE; do sleep 10; done'
        
        # Get experiment verdict
        VERDICT=$(kubectl get chaosresult network-latency-${{ github.run_id }}-pod-network-latency \
          -n $CHAOS_NAMESPACE -o jsonpath='{.status.experimentStatus.verdict}')
        
        echo "network_latency_verdict=$VERDICT" >> $GITHUB_OUTPUT
        
        if [ "$VERDICT" != "Pass" ]; then
          echo "Network latency test failed"
          exit 1
        fi
    
    - name: Generate chaos test report
      run: |
        cat > chaos-test-report.md <<EOF
        # Chaos Engineering Test Report
        
        **Pipeline:** ${{ github.workflow }}
        **Commit:** ${{ github.sha }}
        **Branch:** ${{ github.ref_name }}
        **Run ID:** ${{ github.run_id }}
        
        ## Test Results
        
        | Test | Result |
        |------|--------|
        | CPU Stress Test | ${{ steps.cpu-stress.outputs.cpu_stress_verdict }} |
        | Network Latency Test | ${{ steps.network-latency.outputs.network_latency_verdict }} |
        
        ## Experiment Details
        
        - **CPU Stress Duration:** 120 seconds
        - **Network Latency:** 2000ms ± 200ms jitter
        - **Affected Pods:** 50%
        - **Probe Failures:** 0
        
        EOF
        
        cat chaos-test-report.md
    
    - name: Cleanup
      if: always()
      run: |
        kubectl delete chaosengine --all -n $CHAOS_NAMESPACE --ignore-not-found
        kubectl delete namespace $CHAOS_NAMESPACE --ignore-not-found
```

## Jenkins Pipeline Integration

```groovy
// Jenkinsfile
pipeline {
    agent any
    
    environment {
        KUBECONFIG = credentials('kubeconfig')
        CHAOS_NAMESPACE = 'chaos-testing'
        DOCKER_REGISTRY = 'your-registry.com'
    }
    
    stages {
        stage('Build and Test') {
            parallel {
                stage('Build') {
                    steps {
                        script {
                            def image = docker.build("${DOCKER_REGISTRY}/test-app:${BUILD_NUMBER}")
                            image.push()
                        }
                    }
                }
                
                stage('Unit Tests') {
                    steps {
                        sh 'go test ./...'
                    }
                }
            }
        }
        
        stage('Deploy to Chaos Environment') {
            steps {
                sh """
                    kubectl create namespace ${CHAOS_NAMESPACE} --dry-run=client -o yaml | kubectl apply -f -
                    helm upgrade --install test-app ./helm-chart \\
                      --namespace ${CHAOS_NAMESPACE} \\
                      --set image.tag=${BUILD_NUMBER} \\
                      --wait --timeout=300s
                """
            }
        }
        
        stage('Chaos Engineering Tests') {
            parallel {
                stage('Pod Deletion Test') {
                    steps {
                        script {
                            sh """
                                cat > pod-deletion-test.yaml <<EOF
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: pod-deletion-${BUILD_NUMBER}
  namespace: ${CHAOS_NAMESPACE}
spec:
  engineState: 'active'
  appinfo:
    appns: '${CHAOS_NAMESPACE}'
    applabel: 'app=test-app'
    appkind: 'deployment'
  chaosServiceAccount: litmus-admin
  experiments:
  - name: pod-delete
    spec:
      components:
        env:
        - name: TOTAL_CHAOS_DURATION
          value: '60'
        - name: CHAOS_INTERVAL
          value: '10'
        - name: FORCE
          value: 'false'
      probe:
      - name: availability-probe
        type: httpProbe
        mode: Continuous
        runProperties:
          probeTimeout: 10s
          retry: 3
          interval: 5s
        httpProbe/inputs:
          url: http://test-app.${CHAOS_NAMESPACE}.svc.cluster.local/health
          insecureSkipTLS: true
          method:
            get:
              criteria: "=="
              responseCode: "200"
EOF
                                kubectl apply -f pod-deletion-test.yaml
                                
                                timeout 300 bash -c 'until kubectl get chaosresult pod-deletion-${BUILD_NUMBER}-pod-delete -n ${CHAOS_NAMESPACE}; do sleep 10; done'
                                
                                VERDICT=\$(kubectl get chaosresult pod-deletion-${BUILD_NUMBER}-pod-delete -n ${CHAOS_NAMESPACE} -o jsonpath='{.status.experimentStatus.verdict}')
                                
                                if [ "\$VERDICT" != "Pass" ]; then
                                    echo "Pod deletion test failed with verdict: \$VERDICT"
                                    exit 1
                                fi
                            """
                        }
                    }
                }
                
                stage('Memory Stress Test') {
                    steps {
                        script {
                            sh """
                                cat > memory-stress-test.yaml <<EOF
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: memory-stress-${BUILD_NUMBER}
  namespace: ${CHAOS_NAMESPACE}
spec:
  engineState: 'active'
  appinfo:
    appns: '${CHAOS_NAMESPACE}'
    applabel: 'app=test-app'
    appkind: 'deployment'
  chaosServiceAccount: litmus-admin
  experiments:
  - name: pod-memory-hog
    spec:
      components:
        env:
        - name: TOTAL_CHAOS_DURATION
          value: '90'
        - name: MEMORY_CONSUMPTION
          value: '500'
        - name: NUMBER_OF_WORKERS
          value: '2'
      probe:
      - name: memory-probe
        type: k8sProbe
        mode: Continuous
        runProperties:
          probeTimeout: 5s
          retry: 3
          interval: 10s
        k8sProbe/inputs:
          group: ""
          version: "v1"
          resource: "pods"
          namespace: "${CHAOS_NAMESPACE}"
          fieldSelector: "status.phase=Running"
          labelSelector: "app=test-app"
          operation: "present"
EOF
                                kubectl apply -f memory-stress-test.yaml
                                
                                timeout 300 bash -c 'until kubectl get chaosresult memory-stress-${BUILD_NUMBER}-pod-memory-hog -n ${CHAOS_NAMESPACE}; do sleep 10; done'
                                
                                VERDICT=\$(kubectl get chaosresult memory-stress-${BUILD_NUMBER}-pod-memory-hog -n ${CHAOS_NAMESPACE} -o jsonpath='{.status.experimentStatus.verdict}')
                                
                                if [ "\$VERDICT" != "Pass" ]; then
                                    echo "Memory stress test failed with verdict: \$VERDICT"
                                    exit 1
                                fi
                            """
                        }
                    }
                }
            }
        }
        
        stage('Collect Chaos Results') {
            steps {
                script {
                    sh """
                        echo "Collecting chaos engineering test results..."
                        kubectl get chaosresults -n ${CHAOS_NAMESPACE} -o yaml > chaos-results-${BUILD_NUMBER}.yaml
                        
                        # Generate summary report
                        echo "# Chaos Engineering Results - Build ${BUILD_NUMBER}" > chaos-summary.md
                        echo "" >> chaos-summary.md
                        echo "## Experiments Executed:" >> chaos-summary.md
                        kubectl get chaosresults -n ${CHAOS_NAMESPACE} --no-headers | while read result; do
                            name=\$(echo \$result | awk '{print \$1}')
                            verdict=\$(kubectl get chaosresult \$name -n ${CHAOS_NAMESPACE} -o jsonpath='{.status.experimentStatus.verdict}')
                            echo "- \$name: \$verdict" >> chaos-summary.md
                        done
                    """
                    
                    archiveArtifacts artifacts: 'chaos-results-*.yaml, chaos-summary.md', fingerprint: true
                }
            }
        }
    }
    
    post {
        always {
            sh """
                kubectl delete chaosengine --all -n ${CHAOS_NAMESPACE} --ignore-not-found || true
                kubectl delete namespace ${CHAOS_NAMESPACE} --ignore-not-found || true
            """
        }
        
        failure {
            emailext (
                subject: "Chaos Engineering Tests Failed - Build ${BUILD_NUMBER}",
                body: "The chaos engineering tests have failed for build ${BUILD_NUMBER}. Please check the Jenkins console output for details.",
                to: "${env.CHANGE_AUTHOR_EMAIL}"
            )
        }
        
        success {
            slackSend (
                color: 'good',
                message: "Chaos engineering tests passed for build ${BUILD_NUMBER}! 🎉"
            )
        }
    }
}
```

# Production Readiness and Best Practices

## Security Considerations

### RBAC Configuration

```yaml
# litmus-rbac.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: litmus-admin
  namespace: litmus
  labels:
    name: litmus-admin

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: litmus-admin
  labels:
    name: litmus-admin
rules:
- apiGroups: [""]
  resources: ["pods","events","configmaps","secrets","pods/log","pods/exec"]
  verbs: ["create","delete","get","list","patch","update","deletecollection"]
- apiGroups: [""]
  resources: ["nodes"]
  verbs: ["patch","get","list"]
- apiGroups: ["apps"]
  resources: ["deployments","statefulsets","replicasets","daemonsets"]
  verbs: ["list","get","patch","create","delete"]
- apiGroups: ["apps"]
  resources: ["deployments/scale","statefulsets/scale"]
  verbs: ["patch"]
- apiGroups: [""]
  resources: ["replicationcontrollers"]
  verbs: ["get","list"]
- apiGroups: ["argoproj.io"]
  resources: ["rollouts"]
  verbs: ["list","get","patch"]
- apiGroups: ["batch"]
  resources: ["jobs"]
  verbs: ["create","list","get","delete","deletecollection"]
- apiGroups: ["litmuschaos.io"]
  resources: ["chaosengines","chaosexperiments","chaosresults"]
  verbs: ["create","list","get","patch","update","delete"]
- apiGroups: ["apiextensions.k8s.io"]
  resources: ["customresourcedefinitions"]
  verbs: ["list","get"]
- apiGroups: ["policy"]
  resources: ["podsecuritypolicies"]
  verbs: ["use"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: litmus-admin
  labels:
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
# Namespace-scoped service account for production experiments
apiVersion: v1
kind: ServiceAccount
metadata:
  name: chaos-executor
  namespace: production

---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: production
  name: chaos-executor
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["delete","get","list"]
- apiGroups: [""]
  resources: ["events"]
  verbs: ["create","get","list"]
- apiGroups: ["apps"]
  resources: ["deployments","replicasets"]
  verbs: ["get","list","patch"]
- apiGroups: ["litmuschaos.io"]
  resources: ["chaosengines","chaosexperiments","chaosresults"]
  verbs: ["create","list","get","patch","update"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: chaos-executor
  namespace: production
subjects:
- kind: ServiceAccount
  name: chaos-executor
  namespace: production
roleRef:
  kind: Role
  name: chaos-executor
  apiGroup: rbac.authorization.k8s.io
```

### Network Policies

```yaml
# litmus-network-policy.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: litmus-ingress-policy
  namespace: litmus
spec:
  podSelector:
    matchLabels:
      app: litmus-portal-frontend
  policyTypes:
  - Ingress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          name: ingress-nginx
    ports:
    - protocol: TCP
      port: 8080

---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: litmus-egress-policy
  namespace: litmus
spec:
  podSelector:
    matchLabels:
      app: chaos-operator
  policyTypes:
  - Egress
  egress:
  - to:
    - namespaceSelector: {}
    ports:
    - protocol: TCP
      port: 443
    - protocol: TCP
      port: 6443
  - to: []
    ports:
    - protocol: TCP
      port: 53
    - protocol: UDP
      port: 53
```

## Disaster Recovery Planning

### Backup Strategy

```bash
#!/bin/bash
# backup-litmus.sh

BACKUP_DIR="/backup/litmus/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"

echo "Starting Litmus backup..."

# Backup CRDs
kubectl get crd -o yaml > "$BACKUP_DIR/crds.yaml"

# Backup Litmus resources
kubectl get chaosengines --all-namespaces -o yaml > "$BACKUP_DIR/chaosengines.yaml"
kubectl get chaosexperiments --all-namespaces -o yaml > "$BACKUP_DIR/chaosexperiments.yaml"
kubectl get chaosresults --all-namespaces -o yaml > "$BACKUP_DIR/chaosresults.yaml"

# Backup Litmus configuration
kubectl get configmaps -n litmus -o yaml > "$BACKUP_DIR/configmaps.yaml"
kubectl get secrets -n litmus -o yaml > "$BACKUP_DIR/secrets.yaml"

# Backup MongoDB data if using internal MongoDB
if kubectl get pods -n litmus | grep -q mongodb; then
    kubectl exec -n litmus deployment/mongodb -- mongodump --archive | gzip > "$BACKUP_DIR/mongodb.gz"
fi

# Create archive
tar -czf "$BACKUP_DIR.tar.gz" -C "$(dirname "$BACKUP_DIR")" "$(basename "$BACKUP_DIR")"
rm -rf "$BACKUP_DIR"

echo "Backup completed: $BACKUP_DIR.tar.gz"
```

### Recovery Procedures

```bash
#!/bin/bash
# restore-litmus.sh

BACKUP_FILE="$1"

if [ -z "$BACKUP_FILE" ]; then
    echo "Usage: $0 <backup-file.tar.gz>"
    exit 1
fi

RESTORE_DIR="/tmp/litmus-restore/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$RESTORE_DIR"

echo "Extracting backup..."
tar -xzf "$BACKUP_FILE" -C "$RESTORE_DIR" --strip-components=1

echo "Restoring Litmus..."

# Restore CRDs first
kubectl apply -f "$RESTORE_DIR/crds.yaml"

# Wait for CRDs to be ready
sleep 30

# Restore Litmus namespace and basic resources
kubectl apply -f "$RESTORE_DIR/configmaps.yaml"
kubectl apply -f "$RESTORE_DIR/secrets.yaml"

# Restore chaos experiments (templates)
kubectl apply -f "$RESTORE_DIR/chaosexperiments.yaml"

# Restore MongoDB data if backup exists
if [ -f "$RESTORE_DIR/mongodb.gz" ]; then
    kubectl exec -n litmus deployment/mongodb -- sh -c 'mongorestore --archive --gzip' < "$RESTORE_DIR/mongodb.gz"
fi

echo "Restore completed from: $BACKUP_FILE"
rm -rf "$RESTORE_DIR"
```

## Scaling and Performance Optimization

### Resource Optimization

```yaml
# litmus-performance-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: chaos-operator-config
  namespace: litmus
data:
  CHAOS_OPERATOR_LOG_LEVEL: "INFO"
  CHAOS_OPERATOR_WATCH_NAMESPACE: ""
  REQUEUE_TIME: "2"
  OPERATOR_SCOPE: "cluster"

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: chaos-operator
  namespace: litmus
spec:
  replicas: 2
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
        image: litmuschaos/chaos-operator:latest
        resources:
          requests:
            memory: "128Mi"
            cpu: "100m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        env:
        - name: CHAOS_RUNNER_IMAGE
          value: "litmuschaos/chaos-runner:latest"
        - name: WATCH_NAMESPACE
          value: ""
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        - name: OPERATOR_NAME
          value: "chaos-operator"
        - name: REQUEUE_TIME
          value: "2"
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8081
          initialDelaySeconds: 15
          periodSeconds: 20
        readinessProbe:
          httpGet:
            path: /readyz
            port: 8081
          initialDelaySeconds: 5
          periodSeconds: 10

---
apiVersion: v1
kind: Service
metadata:
  name: chaos-operator-metrics
  namespace: litmus
  labels:
    name: chaos-operator
spec:
  ports:
  - name: metrics
    port: 8383
    protocol: TCP
    targetPort: 8383
  selector:
    name: chaos-operator
```

### Horizontal Pod Autoscaling

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: litmus-portal-server-hpa
  namespace: litmus
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: litmusportal-server
  minReplicas: 2
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 10
        periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
      - type: Percent
        value: 50
        periodSeconds: 60
```

# Incident Response Automation

## Automated Incident Detection

```yaml
# incident-detection-workflow.yaml
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  name: incident-response-workflow
  namespace: sre
spec:
  entrypoint: incident-response
  serviceAccountName: incident-responder
  templates:
  - name: incident-response
    steps:
    - - name: detect-anomaly
        template: detect-anomaly
    - - name: trigger-chaos-validation
        template: chaos-validation
        when: "{{steps.detect-anomaly.outputs.parameters.anomaly-detected}} == true"
    - - name: incident-mitigation
        template: incident-mitigation
        when: "{{steps.chaos-validation.outputs.parameters.validation-failed}} == true"

  - name: detect-anomaly
    script:
      image: prom/prometheus:latest
      command: [sh]
      source: |
        # Query Prometheus for anomalies
        RESPONSE=$(curl -s "http://prometheus.monitoring.svc.cluster.local:9090/api/v1/query?query=up{job=\"kubernetes-nodes\"}")
        
        # Check if any nodes are down
        DOWN_NODES=$(echo $RESPONSE | jq '.data.result[] | select(.value[1] == "0") | length')
        
        if [ "$DOWN_NODES" -gt 0 ]; then
          echo "true" > /tmp/anomaly-detected
          echo "Node failure detected" > /tmp/anomaly-reason
        else
          echo "false" > /tmp/anomaly-detected
          echo "No anomalies detected" > /tmp/anomaly-reason
        fi
    outputs:
      parameters:
      - name: anomaly-detected
        valueFrom:
          path: /tmp/anomaly-detected
      - name: anomaly-reason
        valueFrom:
          path: /tmp/anomaly-reason

  - name: chaos-validation
    script:
      image: litmuschaos/k8s:latest
      command: [sh]
      source: |
        # Create validation chaos experiment
        cat > /tmp/validation-experiment.yaml <<EOF
        apiVersion: litmuschaos.io/v1alpha1
        kind: ChaosEngine
        metadata:
          name: incident-validation
          namespace: default
        spec:
          engineState: 'active'
          appinfo:
            appns: 'default'
            applabel: 'app=critical-service'
            appkind: 'deployment'
          chaosServiceAccount: litmus-admin
          experiments:
          - name: pod-delete
            spec:
              components:
                env:
                - name: TOTAL_CHAOS_DURATION
                  value: '30'
                - name: FORCE
                  value: 'false'
              probe:
              - name: service-availability
                type: httpProbe
                mode: Continuous
                runProperties:
                  probeTimeout: 10s
                  retry: 3
                  interval: 5s
                httpProbe/inputs:
                  url: http://critical-service.default.svc.cluster.local/health
                  insecureSkipTLS: true
                  method:
                    get:
                      criteria: "=="
                      responseCode: "200"
        EOF
        
        kubectl apply -f /tmp/validation-experiment.yaml
        
        # Wait for result
        sleep 60
        
        VERDICT=$(kubectl get chaosresult incident-validation-pod-delete -o jsonpath='{.status.experimentStatus.verdict}' 2>/dev/null || echo "Failed")
        
        if [ "$VERDICT" != "Pass" ]; then
          echo "true" > /tmp/validation-failed
        else
          echo "false" > /tmp/validation-failed
        fi
        
        kubectl delete chaosengine incident-validation --ignore-not-found
    outputs:
      parameters:
      - name: validation-failed
        valueFrom:
          path: /tmp/validation-failed

  - name: incident-mitigation
    script:
      image: alpine/helm:latest
      command: [sh]
      source: |
        # Implement automated mitigation strategies
        echo "Implementing incident mitigation..."
        
        # Scale up replicas
        kubectl scale deployment critical-service --replicas=10 -n default
        
        # Update service mesh configuration for circuit breaking
        kubectl patch destinationrule critical-service -n default --type='merge' -p='
        {
          "spec": {
            "trafficPolicy": {
              "outlierDetection": {
                "consecutiveErrors": 3,
                "interval": "30s",
                "baseEjectionTime": "30s",
                "maxEjectionPercent": 50
              }
            }
          }
        }'
        
        # Send alert to incident response team
        curl -X POST "$SLACK_WEBHOOK_URL" \
          -H 'Content-type: application/json' \
          --data '{"text":"🚨 Automated incident mitigation triggered. Critical service scaled up and circuit breaker activated."}'
```

## Runbook Automation

```yaml
# runbook-automation.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: chaos-runbooks
  namespace: sre
data:
  database-failure-runbook.yaml: |
    apiVersion: argoproj.io/v1alpha1
    kind: Workflow
    metadata:
      name: database-failure-runbook
    spec:
      entrypoint: database-recovery
      templates:
      - name: database-recovery
        steps:
        - - name: verify-failure
            template: verify-database-failure
        - - name: failover-database
            template: failover-to-replica
            when: "{{steps.verify-failure.outputs.parameters.database-down}} == true"
        - - name: notify-team
            template: send-notification
      
      - name: verify-database-failure
        script:
          image: postgres:13
          command: [sh]
          source: |
            pg_isready -h database.production.svc.cluster.local -p 5432 -U postgres
            if [ $? -eq 0 ]; then
              echo "false" > /tmp/database-down
            else
              echo "true" > /tmp/database-down
            fi
        outputs:
          parameters:
          - name: database-down
            valueFrom:
              path: /tmp/database-down
      
      - name: failover-to-replica
        script:
          image: bitnami/kubectl:latest
          command: [sh]
          source: |
            # Update service to point to replica
            kubectl patch service database -n production -p '{"spec":{"selector":{"app":"database-replica"}}}'
            
            # Scale down failed primary
            kubectl scale statefulset database-primary --replicas=0 -n production
            
            # Promote replica to primary
            kubectl patch statefulset database-replica -n production -p '{"spec":{"template":{"metadata":{"labels":{"role":"primary"}}}}}'
      
      - name: send-notification
        script:
          image: curlimages/curl:latest
          command: [sh]
          source: |
            curl -X POST "$TEAMS_WEBHOOK_URL" \
              -H 'Content-Type: application/json' \
              -d '{
                "title": "Database Failover Completed",
                "text": "Automated database failover has been executed. Primary database failed and traffic has been redirected to replica.",
                "potentialAction": [{
                  "@type": "OpenUri",
                  "name": "View Grafana Dashboard",
                  "targets": [{"os": "default", "uri": "https://grafana.company.com/d/database"}]
                }]
              }'

  network-partition-runbook.yaml: |
    apiVersion: argoproj.io/v1alpha1
    kind: Workflow
    metadata:
      name: network-partition-runbook
    spec:
      entrypoint: network-recovery
      templates:
      - name: network-recovery
        steps:
        - - name: detect-partition
            template: detect-network-partition
        - - name: activate-circuit-breaker
            template: enable-circuit-breaker
            when: "{{steps.detect-partition.outputs.parameters.partition-detected}} == true"
        - - name: reroute-traffic
            template: traffic-rerouting
            when: "{{steps.detect-partition.outputs.parameters.partition-detected}} == true"
      
      - name: detect-network-partition
        script:
          image: nicolaka/netshoot:latest
          command: [sh]
          source: |
            # Test connectivity between microservices
            SERVICES=("user-service" "order-service" "payment-service")
            FAILURES=0
            
            for service in "${SERVICES[@]}"; do
              if ! nc -zv $service.microservices.svc.cluster.local 80; then
                FAILURES=$((FAILURES + 1))
              fi
            done
            
            if [ $FAILURES -gt 1 ]; then
              echo "true" > /tmp/partition-detected
            else
              echo "false" > /tmp/partition-detected
            fi
        outputs:
          parameters:
          - name: partition-detected
            valueFrom:
              path: /tmp/partition-detected
      
      - name: enable-circuit-breaker
        script:
          image: istio/pilot:latest
          command: [sh]
          source: |
            # Apply emergency circuit breaker configuration
            kubectl apply -f - <<EOF
            apiVersion: networking.istio.io/v1beta1
            kind: DestinationRule
            metadata:
              name: emergency-circuit-breaker
              namespace: microservices
            spec:
              host: "*.microservices.svc.cluster.local"
              trafficPolicy:
                outlierDetection:
                  consecutiveErrors: 1
                  interval: 10s
                  baseEjectionTime: 30s
                  maxEjectionPercent: 100
                connectionPool:
                  tcp:
                    maxConnections: 1
                  http:
                    http1MaxPendingRequests: 1
                    maxRequestsPerConnection: 1
            EOF
      
      - name: traffic-rerouting
        script:
          image: bitnami/kubectl:latest
          command: [sh]
          source: |
            # Route traffic to backup region
            kubectl patch virtualservice api-gateway -n microservices --type='merge' -p='
            {
              "spec": {
                "http": [{
                  "route": [{
                    "destination": {
                      "host": "api-gateway.backup-region.svc.cluster.local"
                    },
                    "weight": 100
                  }]
                }]
              }
            }'
```

# Advanced Chaos Scenarios

## Multi-Region Chaos Testing

```yaml
# multi-region-chaos.yaml
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  name: multi-region-chaos-test
  namespace: chaos-engineering
spec:
  entrypoint: multi-region-test
  serviceAccountName: chaos-engineer
  arguments:
    parameters:
    - name: primary-region
      value: "us-east-1"
    - name: backup-region
      value: "us-west-2"
  
  templates:
  - name: multi-region-test
    steps:
    - - name: baseline-metrics
        template: collect-baseline
    - - name: region-failure-simulation
        template: simulate-region-failure
        arguments:
          parameters:
          - name: failed-region
            value: "{{workflow.parameters.primary-region}}"
    - - name: validate-failover
        template: validate-regional-failover
    - - name: recovery-test
        template: test-recovery
    - - name: final-validation
        template: validate-full-recovery

  - name: collect-baseline
    script:
      image: prom/prometheus:latest
      command: [sh]
      source: |
        # Collect baseline metrics across regions
        echo "Collecting baseline metrics..."
        
        METRICS=(
          "http_requests_total"
          "http_request_duration_seconds"
          "up{job='kubernetes-nodes'}"
          "cluster_health_score"
        )
        
        for metric in "${METRICS[@]}"; do
          curl -s "http://prometheus.monitoring.svc.cluster.local:9090/api/v1/query?query=$metric" \
            > "/tmp/baseline_$(echo $metric | tr '{}=' '___').json"
        done

  - name: simulate-region-failure
    inputs:
      parameters:
      - name: failed-region
    script:
      image: litmuschaos/k8s:latest
      command: [sh]
      source: |
        FAILED_REGION="{{inputs.parameters.failed-region}}"
        
        # Create comprehensive region failure scenario
        cat > /tmp/region-failure-experiment.yaml <<EOF
        apiVersion: litmuschaos.io/v1alpha1
        kind: ChaosEngine
        metadata:
          name: region-failure-simulation
          namespace: production
        spec:
          engineState: 'active'
          appinfo:
            appns: 'production'
            applabel: "region=$FAILED_REGION"
            appkind: 'deployment'
          chaosServiceAccount: litmus-admin
          experiments:
          - name: node-drain
            spec:
              components:
                env:
                - name: TARGET_NODE
                  value: ""
                - name: NODE_LABEL
                  value: "topology.kubernetes.io/zone=$FAILED_REGION"
          - name: pod-network-partition
            spec:
              components:
                env:
                - name: TOTAL_CHAOS_DURATION
                  value: '300'
                - name: DESTINATION_IPS
                  value: "*.us-west-2.compute.amazonaws.com"
          - name: aws-ec2-terminate-by-tag
            spec:
              components:
                env:
                - name: TOTAL_CHAOS_DURATION
                  value: '300'
                - name: EC2_INSTANCE_TAG
                  value: "Region=$FAILED_REGION"
                - name: MANAGED_NODEGROUP
                  value: "enabled"
        EOF
        
        kubectl apply -f /tmp/region-failure-experiment.yaml

  - name: validate-regional-failover
    script:
      image: curlimages/curl:latest
      command: [sh]
      source: |
        echo "Validating regional failover..."
        
        # Test API endpoints
        ENDPOINTS=(
          "https://api.company.com/health"
          "https://api.company.com/users"
          "https://api.company.com/orders"
        )
        
        for endpoint in "${ENDPOINTS[@]}"; do
          response=$(curl -s -o /dev/null -w "%{http_code}" "$endpoint")
          if [ "$response" != "200" ]; then
            echo "FAIL: $endpoint returned $response"
            exit 1
          else
            echo "PASS: $endpoint accessible"
          fi
        done
        
        # Validate traffic is routed to backup region
        trace_output=$(curl -s -H "X-Trace-Region: true" https://api.company.com/health)
        if echo "$trace_output" | grep -q "us-west-2"; then
          echo "PASS: Traffic routed to backup region"
        else
          echo "FAIL: Traffic not properly routed"
          exit 1
        fi

  - name: test-recovery
    script:
      image: litmuschaos/k8s:latest
      command: [sh]
      source: |
        echo "Testing recovery procedures..."
        
        # Simulate recovery by stopping chaos experiments
        kubectl delete chaosengine region-failure-simulation -n production
        
        # Wait for nodes to recover
        sleep 120
        
        # Gradually restore traffic to primary region
        for weight in 25 50 75 100; do
          kubectl patch virtualservice api-gateway -n production --type='merge' -p="
          {
            \"spec\": {
              \"http\": [{
                \"route\": [
                  {
                    \"destination\": {\"host\": \"api-gateway.us-east-1.local\"},
                    \"weight\": $weight
                  },
                  {
                    \"destination\": {\"host\": \"api-gateway.us-west-2.local\"},
                    \"weight\": $((100 - weight))
                  }
                ]
              }]
            }
          }"
          
          echo "Traffic weight adjusted: Primary $weight%, Backup $((100 - weight))%"
          sleep 60
        done

  - name: validate-full-recovery
    script:
      image: prom/prometheus:latest
      command: [sh]
      source: |
        echo "Validating full recovery..."
        
        # Check all nodes are ready
        ready_nodes=$(kubectl get nodes --no-headers | grep Ready | wc -l)
        total_nodes=$(kubectl get nodes --no-headers | wc -l)
        
        if [ "$ready_nodes" -eq "$total_nodes" ]; then
          echo "PASS: All nodes are ready ($ready_nodes/$total_nodes)"
        else
          echo "FAIL: Not all nodes are ready ($ready_nodes/$total_nodes)"
          exit 1
        fi
        
        # Validate metrics have returned to baseline
        current_rps=$(curl -s "http://prometheus.monitoring.svc.cluster.local:9090/api/v1/query?query=rate(http_requests_total[5m])" | jq '.data.result[0].value[1]' | sed 's/"//g')
        baseline_rps=$(cat /tmp/baseline_http_requests_total.json | jq '.data.result[0].value[1]' | sed 's/"//g')
        
        variance=$(echo "scale=2; ($current_rps - $baseline_rps) / $baseline_rps * 100" | bc)
        
        if (( $(echo "$variance < 10" | bc -l) )); then
          echo "PASS: RPS within 10% of baseline (variance: ${variance}%)"
        else
          echo "FAIL: RPS significantly different from baseline (variance: ${variance}%)"
          exit 1
        fi
```

## Service Mesh Chaos Testing

```yaml
# service-mesh-chaos.yaml
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: service-mesh-chaos
  namespace: microservices
spec:
  engineState: 'active'
  appinfo:
    appns: 'microservices'
    applabel: 'version=v1'
    appkind: 'deployment'
  chaosServiceAccount: litmus-admin
  experiments:
  - name: istio-proxy-kill
    spec:
      components:
        env:
        - name: TOTAL_CHAOS_DURATION
          value: '60'
        - name: CHAOS_INTERVAL
          value: '15'
        - name: FORCE
          value: 'false'
        - name: PROXY_CONTAINER
          value: 'istio-proxy'
      probe:
      - name: service-mesh-metrics
        type: promProbe
        mode: Continuous
        runProperties:
          probeTimeout: 10s
          retry: 3
          interval: 15s
        promProbe/inputs:
          endpoint: "http://prometheus.istio-system.svc.cluster.local:9090"
          query: "istio_requests_total{destination_service_name='user-service',response_code='200'}"
          comparator:
            criteria: ">"
            value: "0"
      
      - name: circuit-breaker-status
        type: k8sProbe
        mode: Edge
        runProperties:
          probeTimeout: 5s
          retry: 3
          interval: 30s
        k8sProbe/inputs:
          group: "networking.istio.io"
          version: "v1beta1"
          resource: "destinationrules"
          namespace: "microservices"
          fieldSelector: "metadata.name=user-service-circuit-breaker"
          operation: "present"

  - name: envoy-config-corruption
    spec:
      components:
        env:
        - name: TOTAL_CHAOS_DURATION
          value: '120'
        - name: TARGET_CONTAINER
          value: 'istio-proxy'
        - name: CONFIG_MAP_NAME
          value: 'istio-envoy-config'
      probe:
      - name: envoy-health-check
        type: httpProbe
        mode: Continuous
        runProperties:
          probeTimeout: 5s
          retry: 3
          interval: 10s
        httpProbe/inputs:
          url: "http://user-service.microservices.svc.cluster.local:15000/ready"
          insecureSkipTLS: true
          method:
            get:
              criteria: "=="
              responseCode: "200"
      
      - name: traffic-routing-validation
        type: cmdProbe
        mode: Continuous
        runProperties:
          probeTimeout: 15s
          retry: 3
          interval: 20s
        cmdProbe/inputs:
          command: "curl"
          args:
            - "-H"
            - "x-test-route: canary"
            - "http://user-service.microservices.svc.cluster.local/api/test"
          source:
            image: "curlimages/curl:latest"
          comparator:
            type: "string"
            criteria: "contains"
            value: "canary-response"
```

This comprehensive guide provides a complete foundation for implementing chaos engineering with Litmus on Kubernetes. The examples demonstrate production-ready configurations, automated testing pipelines, observability integration, and incident response automation. By following these practices, organizations can build more resilient systems and improve their confidence in handling production failures.

Key takeaways include starting with simple experiments, gradually increasing complexity, integrating chaos testing into CI/CD pipelines, maintaining comprehensive observability, and automating incident response procedures. The combination of systematic chaos testing and automated response mechanisms creates a robust foundation for reliable distributed systems.