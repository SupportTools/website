---
title: "Chaos Engineering with Litmus: Production-Ready Kubernetes Resilience Testing"
date: 2026-05-11T00:00:00-05:00
draft: false
tags: ["Chaos Engineering", "Litmus", "Kubernetes", "Resilience", "SRE", "Testing", "Production"]
categories: ["DevOps", "Kubernetes", "Site Reliability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing chaos engineering with Litmus in Kubernetes production environments, including experiment design, automation, and incident response integration."
more_link: "yes"
url: "/chaos-engineering-litmus-kubernetes-production-guide/"
---

Chaos engineering is essential for building resilient distributed systems. This comprehensive guide covers implementing production-ready chaos engineering practices using Litmus on Kubernetes, including experiment design, automation, and integration with incident response processes.

<!--more-->

## Executive Summary

Chaos engineering proactively identifies weaknesses in distributed systems before they cause outages. This guide provides enterprise teams with a complete framework for implementing chaos engineering using Litmus, including experiment design, safety measures, automation, and integration with incident response workflows. We'll cover everything from basic pod failures to complex network partition scenarios, with production-ready examples and best practices.

## Understanding Chaos Engineering Principles

### The Chaos Engineering Workflow

```yaml
# chaos-engineering-workflow.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: chaos-workflow-guide
  namespace: litmus
data:
  workflow.md: |
    # Chaos Engineering Workflow

    ## 1. Define Steady State
    - Identify key system metrics
    - Establish baseline behavior
    - Define success criteria

    ## 2. Hypothesize Impact
    - Predict failure scenarios
    - Document expected behavior
    - Set acceptable thresholds

    ## 3. Introduce Chaos
    - Start with smallest blast radius
    - Monitor system behavior
    - Collect metrics and logs

    ## 4. Analyze Results
    - Compare against hypothesis
    - Identify weaknesses
    - Document findings

    ## 5. Improve System
    - Implement fixes
    - Update documentation
    - Iterate and retest
```

### Building Blocks of Chaos Experiments

```python
# chaos_experiment_framework.py
from dataclasses import dataclass
from typing import List, Dict, Any
from enum import Enum
import logging

class ExperimentPhase(Enum):
    PLANNING = "planning"
    PREPARATION = "preparation"
    EXECUTION = "execution"
    ANALYSIS = "analysis"
    REMEDIATION = "remediation"

class BlastRadius(Enum):
    MINIMAL = "minimal"      # Single pod
    LIMITED = "limited"      # Single service
    MODERATE = "moderate"    # Multiple services
    EXTENSIVE = "extensive"  # Entire namespace

@dataclass
class SteadyStateMetric:
    name: str
    query: str
    threshold: float
    comparison: str  # 'greater_than', 'less_than', 'equals'

@dataclass
class ChaosExperiment:
    name: str
    description: str
    hypothesis: str
    blast_radius: BlastRadius
    steady_state_metrics: List[SteadyStateMetric]
    safety_checks: List[str]
    rollback_criteria: List[str]
    expected_impact: str

class ChaosExperimentBuilder:
    """Builder for creating chaos experiments with safety checks"""

    def __init__(self):
        self.logger = logging.getLogger(__name__)
        self.experiments: Dict[str, ChaosExperiment] = {}

    def define_experiment(
        self,
        name: str,
        description: str,
        hypothesis: str,
        blast_radius: BlastRadius
    ) -> 'ChaosExperimentBuilder':
        """Define basic experiment parameters"""
        self.current_experiment = {
            'name': name,
            'description': description,
            'hypothesis': hypothesis,
            'blast_radius': blast_radius,
            'steady_state_metrics': [],
            'safety_checks': [],
            'rollback_criteria': []
        }
        return self

    def add_steady_state_metric(
        self,
        name: str,
        query: str,
        threshold: float,
        comparison: str
    ) -> 'ChaosExperimentBuilder':
        """Add a metric to monitor during experiment"""
        metric = SteadyStateMetric(name, query, threshold, comparison)
        self.current_experiment['steady_state_metrics'].append(metric)
        return self

    def add_safety_check(self, check: str) -> 'ChaosExperimentBuilder':
        """Add a safety check that must pass before execution"""
        self.current_experiment['safety_checks'].append(check)
        return self

    def add_rollback_criteria(self, criteria: str) -> 'ChaosExperimentBuilder':
        """Add criteria that triggers automatic rollback"""
        self.current_experiment['rollback_criteria'].append(criteria)
        return self

    def set_expected_impact(self, impact: str) -> 'ChaosExperimentBuilder':
        """Define expected system behavior"""
        self.current_experiment['expected_impact'] = impact
        return self

    def build(self) -> ChaosExperiment:
        """Create the experiment object"""
        experiment = ChaosExperiment(**self.current_experiment)
        self.experiments[experiment.name] = experiment
        return experiment

# Example usage
builder = ChaosExperimentBuilder()

pod_deletion_experiment = (
    builder
    .define_experiment(
        name="payment-service-pod-deletion",
        description="Test payment service resilience to pod failures",
        hypothesis="Payment service will maintain 99.9% availability during pod failures",
        blast_radius=BlastRadius.LIMITED
    )
    .add_steady_state_metric(
        name="service_availability",
        query='avg(up{service="payment-service"})',
        threshold=0.999,
        comparison="greater_than"
    )
    .add_steady_state_metric(
        name="request_success_rate",
        query='rate(http_requests_total{status=~"2.."}[5m])',
        threshold=0.99,
        comparison="greater_than"
    )
    .add_safety_check("Verify no ongoing deployments")
    .add_safety_check("Confirm replica count >= 3")
    .add_rollback_criteria("Service availability < 95%")
    .add_rollback_criteria("Error rate > 5%")
    .set_expected_impact("Temporary latency increase, no failed requests")
    .build()
)
```

## Installing and Configuring Litmus

### Litmus Operator Installation

```yaml
# litmus-installation.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: litmus
  labels:
    app.kubernetes.io/name: litmus
    app.kubernetes.io/part-of: litmus

---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: litmus-admin
  namespace: litmus
  labels:
    app.kubernetes.io/name: litmus
    app.kubernetes.io/component: operator-serviceaccount

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: litmus-admin
  labels:
    app.kubernetes.io/name: litmus
    app.kubernetes.io/component: operator-clusterrole
rules:
  # Allow litmus to manage chaos resources
  - apiGroups: [""]
    resources: ["pods", "services", "configmaps", "secrets", "pods/log", "pods/exec", "events"]
    verbs: ["create", "delete", "get", "list", "patch", "update", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets", "replicasets", "daemonsets"]
    verbs: ["get", "list", "patch", "update"]
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["create", "delete", "get", "list", "patch", "update"]
  - apiGroups: ["litmuschaos.io"]
    resources: ["chaosengines", "chaosexperiments", "chaosresults"]
    verbs: ["create", "delete", "get", "list", "patch", "update", "watch"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: litmus-admin
  labels:
    app.kubernetes.io/name: litmus
    app.kubernetes.io/component: operator-clusterrolebinding
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
  labels:
    app.kubernetes.io/name: litmus
    app.kubernetes.io/component: operator
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: litmus
      app.kubernetes.io/component: operator
  template:
    metadata:
      labels:
        app.kubernetes.io/name: litmus
        app.kubernetes.io/component: operator
    spec:
      serviceAccountName: litmus-admin
      containers:
        - name: chaos-operator
          image: litmuschaos/chaos-operator:3.0.0
          imagePullPolicy: IfNotPresent
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
          resources:
            limits:
              cpu: 200m
              memory: 500Mi
            requests:
              cpu: 100m
              memory: 300Mi

---
apiVersion: v1
kind: Service
metadata:
  name: chaos-operator-metrics
  namespace: litmus
  labels:
    app.kubernetes.io/name: litmus
    app.kubernetes.io/component: operator-metrics
spec:
  ports:
    - name: metrics
      port: 8383
      targetPort: 8383
  selector:
    app.kubernetes.io/name: litmus
    app.kubernetes.io/component: operator
```

### Litmus Portal Installation

```bash
#!/bin/bash
# install-litmus-portal.sh

set -euo pipefail

LITMUS_VERSION="3.0.0"
NAMESPACE="litmus"
ADMIN_USERNAME="admin"
ADMIN_PASSWORD=$(openssl rand -base64 32)

echo "Installing Litmus Portal..."

# Create namespace
kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -

# Install Litmus Portal via Helm
helm repo add litmuschaos https://litmuschaos.github.io/litmus-helm/
helm repo update

helm install chaos litmuschaos/litmus \
  --namespace="${NAMESPACE}" \
  --version="${LITMUS_VERSION}" \
  --set portal.frontend.service.type=LoadBalancer \
  --set portal.server.graphqlServer.env.ADMIN_USERNAME="${ADMIN_USERNAME}" \
  --set portal.server.graphqlServer.env.ADMIN_PASSWORD="${ADMIN_PASSWORD}" \
  --set mongodb.auth.enabled=true \
  --set mongodb.auth.rootPassword=$(openssl rand -base64 32) \
  --set portal.server.graphqlServer.env.DB_PASSWORD=$(openssl rand -base64 32)

# Wait for portal to be ready
echo "Waiting for Litmus Portal to be ready..."
kubectl wait --for=condition=ready pod \
  -l app.kubernetes.io/component=litmusportal-frontend \
  -n "${NAMESPACE}" \
  --timeout=300s

# Get portal URL
PORTAL_URL=$(kubectl get svc -n "${NAMESPACE}" litmusportal-frontend-service \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}')

echo "=========================================="
echo "Litmus Portal Installation Complete!"
echo "=========================================="
echo "Portal URL: http://${PORTAL_URL}:9091"
echo "Username: ${ADMIN_USERNAME}"
echo "Password: ${ADMIN_PASSWORD}"
echo "=========================================="
echo "Please save these credentials securely!"

# Save credentials to secret
kubectl create secret generic litmus-portal-credentials \
  -n "${NAMESPACE}" \
  --from-literal=username="${ADMIN_USERNAME}" \
  --from-literal=password="${ADMIN_PASSWORD}" \
  --dry-run=client -o yaml | kubectl apply -f -
```

## Creating Chaos Experiments

### Pod Deletion Experiment

```yaml
# pod-delete-experiment.yaml
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: payment-service-chaos
  namespace: production
spec:
  # Application information
  appinfo:
    appns: production
    applabel: "app=payment-service"
    appkind: deployment

  # Chaos service account
  chaosServiceAccount: payment-service-chaos-sa

  # Monitor chaos progress
  monitoring: true

  # Job cleanup policy
  jobCleanUpPolicy: retain

  # Experiment list
  experiments:
    - name: pod-delete
      spec:
        components:
          env:
            # Target pods
            - name: TOTAL_CHAOS_DURATION
              value: "60"

            # Chaos interval
            - name: CHAOS_INTERVAL
              value: "10"

            # Force deletion
            - name: FORCE
              value: "false"

            # Number of pods to delete
            - name: PODS_AFFECTED_PERC
              value: "50"

            # Target specific pods
            - name: TARGET_PODS
              value: ""

            # Sequence of chaos
            - name: SEQUENCE
              value: "parallel"

          # Resource limits for chaos pod
          resources:
            limits:
              cpu: 100m
              memory: 256Mi
            requests:
              cpu: 100m
              memory: 128Mi

---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: payment-service-chaos-sa
  namespace: production
  labels:
    app.kubernetes.io/name: litmus
    app.kubernetes.io/instance: payment-service-chaos

---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: payment-service-chaos-role
  namespace: production
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log", "events"]
    verbs: ["create", "delete", "get", "list", "patch", "update", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "replicasets"]
    verbs: ["get", "list"]
  - apiGroups: ["litmuschaos.io"]
    resources: ["chaosengines", "chaosexperiments", "chaosresults"]
    verbs: ["create", "delete", "get", "list", "patch", "update"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: payment-service-chaos-rolebinding
  namespace: production
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: payment-service-chaos-role
subjects:
  - kind: ServiceAccount
    name: payment-service-chaos-sa
    namespace: production
```

### Network Chaos Experiment

```yaml
# network-chaos-experiment.yaml
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: payment-database-network-chaos
  namespace: production
spec:
  appinfo:
    appns: production
    applabel: "app=payment-service"
    appkind: deployment

  chaosServiceAccount: payment-service-chaos-sa
  monitoring: true
  jobCleanUpPolicy: retain

  experiments:
    - name: pod-network-latency
      spec:
        components:
          env:
            # Network interface
            - name: NETWORK_INTERFACE
              value: "eth0"

            # Target latency in ms
            - name: NETWORK_LATENCY
              value: "2000"

            # Total chaos duration
            - name: TOTAL_CHAOS_DURATION
              value: "120"

            # Target container
            - name: TARGET_CONTAINER
              value: "payment-service"

            # Destination IPs (database)
            - name: DESTINATION_IPS
              value: "10.100.50.10,10.100.50.11"

            # Destination ports
            - name: DESTINATION_PORTS
              value: "5432"

            # Percentage of pods affected
            - name: PODS_AFFECTED_PERC
              value: "50"

            # Jitter in ms
            - name: JITTER
              value: "0"

---
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: payment-database-packet-loss
  namespace: production
spec:
  appinfo:
    appns: production
    applabel: "app=payment-service"
    appkind: deployment

  chaosServiceAccount: payment-service-chaos-sa
  monitoring: true
  jobCleanUpPolicy: retain

  experiments:
    - name: pod-network-loss
      spec:
        components:
          env:
            - name: NETWORK_INTERFACE
              value: "eth0"

            # Packet loss percentage
            - name: NETWORK_PACKET_LOSS_PERCENTAGE
              value: "20"

            - name: TOTAL_CHAOS_DURATION
              value: "60"

            - name: TARGET_CONTAINER
              value: "payment-service"

            - name: DESTINATION_IPS
              value: "10.100.50.10,10.100.50.11"

            - name: DESTINATION_PORTS
              value: "5432"

            - name: PODS_AFFECTED_PERC
              value: "30"

---
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: payment-service-dns-chaos
  namespace: production
spec:
  appinfo:
    appns: production
    applabel: "app=payment-service"
    appkind: deployment

  chaosServiceAccount: payment-service-chaos-sa
  monitoring: true
  jobCleanUpPolicy: retain

  experiments:
    - name: pod-dns-error
      spec:
        components:
          env:
            # Target hostnames
            - name: TARGET_HOSTNAMES
              value: "payment-db.internal,user-service.production.svc.cluster.local"

            # Match scheme (exact or substring)
            - name: MATCH_SCHEME
              value: "exact"

            - name: TOTAL_CHAOS_DURATION
              value: "60"

            - name: TARGET_CONTAINER
              value: "payment-service"

            - name: PODS_AFFECTED_PERC
              value: "50"
```

### Resource Stress Experiment

```yaml
# resource-stress-experiment.yaml
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: payment-service-cpu-stress
  namespace: production
spec:
  appinfo:
    appns: production
    applabel: "app=payment-service"
    appkind: deployment

  chaosServiceAccount: payment-service-chaos-sa
  monitoring: true
  jobCleanUpPolicy: retain

  experiments:
    - name: pod-cpu-hog
      spec:
        components:
          env:
            # Number of CPU cores to stress
            - name: CPU_CORES
              value: "2"

            # Total chaos duration
            - name: TOTAL_CHAOS_DURATION
              value: "60"

            # CPU load percentage
            - name: CPU_LOAD
              value: "100"

            - name: TARGET_CONTAINER
              value: "payment-service"

            - name: PODS_AFFECTED_PERC
              value: "30"

            # Chaos interval
            - name: CHAOS_INTERVAL
              value: "10"

---
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: payment-service-memory-stress
  namespace: production
spec:
  appinfo:
    appns: production
    applabel: "app=payment-service"
    appkind: deployment

  chaosServiceAccount: payment-service-chaos-sa
  monitoring: true
  jobCleanUpPolicy: retain

  experiments:
    - name: pod-memory-hog
      spec:
        components:
          env:
            # Memory to consume (in MB)
            - name: MEMORY_CONSUMPTION
              value: "500"

            - name: TOTAL_CHAOS_DURATION
              value: "60"

            - name: TARGET_CONTAINER
              value: "payment-service"

            - name: PODS_AFFECTED_PERC
              value: "30"

            # Number of workers
            - name: NUMBER_OF_WORKERS
              value: "4"

---
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: payment-service-disk-fill
  namespace: production
spec:
  appinfo:
    appns: production
    applabel: "app=payment-service"
    appkind: deployment

  chaosServiceAccount: payment-service-chaos-sa
  monitoring: true
  jobCleanUpPolicy: retain

  experiments:
    - name: disk-fill
      spec:
        components:
          env:
            # Fill percentage
            - name: FILL_PERCENTAGE
              value: "80"

            - name: TOTAL_CHAOS_DURATION
              value: "60"

            - name: TARGET_CONTAINER
              value: "payment-service"

            # Container path to fill
            - name: CONTAINER_PATH
              value: "/tmp"

            - name: PODS_AFFECTED_PERC
              value: "30"
```

## Advanced Chaos Scenarios

### Node-Level Chaos

```yaml
# node-chaos-experiments.yaml
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: node-cpu-stress
  namespace: production
spec:
  engineState: "active"
  chaosServiceAccount: node-chaos-sa

  experiments:
    - name: node-cpu-hog
      spec:
        components:
          env:
            # Node selector
            - name: TARGET_NODE
              value: "worker-node-1"

            # CPU cores to stress
            - name: NODE_CPU_CORE
              value: "4"

            - name: TOTAL_CHAOS_DURATION
              value: "120"

            # CPU load percentage
            - name: CPU_LOAD
              value: "80"

---
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: node-drain-chaos
  namespace: production
spec:
  engineState: "active"
  chaosServiceAccount: node-chaos-sa

  experiments:
    - name: node-drain
      spec:
        components:
          env:
            - name: TARGET_NODE
              value: "worker-node-2"

            - name: TOTAL_CHAOS_DURATION
              value: "300"

---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: node-chaos-sa
  namespace: production

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: node-chaos-role
rules:
  - apiGroups: [""]
    resources: ["nodes"]
    verbs: ["get", "list", "patch", "update"]
  - apiGroups: [""]
    resources: ["pods", "pods/log", "pods/eviction"]
    verbs: ["create", "delete", "get", "list"]
  - apiGroups: ["apps"]
    resources: ["deployments", "daemonsets", "replicasets", "statefulsets"]
    verbs: ["get", "list"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: node-chaos-rolebinding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: node-chaos-role
subjects:
  - kind: ServiceAccount
    name: node-chaos-sa
    namespace: production
```

### Custom Chaos Experiments

```yaml
# custom-chaos-experiment.yaml
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosExperiment
metadata:
  name: custom-api-failure
  namespace: production
  labels:
    app.kubernetes.io/name: litmus
    app.kubernetes.io/component: experiment
spec:
  definition:
    scope: Namespaced
    permissions:
      - apiGroups: [""]
        resources: ["pods"]
        verbs: ["create", "delete", "get", "list", "patch", "update"]
      - apiGroups: [""]
        resources: ["pods/log", "pods/exec"]
        verbs: ["create", "get", "list"]

    image: "custom-chaos-experiments:latest"
    imagePullPolicy: IfNotPresent

    args:
      - -c
      - ./experiments -name custom-api-failure

    command:
      - /bin/bash

    env:
      - name: TOTAL_CHAOS_DURATION
        value: "60"

      - name: CHAOS_INTERVAL
        value: "10"

      - name: TARGET_CONTAINER
        value: ""

      - name: API_ENDPOINT
        value: "/api/v1/payments"

      - name: FAILURE_TYPE
        value: "http_500"

      - name: FAILURE_RATE
        value: "30"

    labels:
      name: custom-api-failure
      app.kubernetes.io/component: experiment-job

---
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: api-failure-chaos
  namespace: production
spec:
  appinfo:
    appns: production
    applabel: "app=payment-service"
    appkind: deployment

  chaosServiceAccount: payment-service-chaos-sa
  monitoring: true

  experiments:
    - name: custom-api-failure
      spec:
        components:
          env:
            - name: API_ENDPOINT
              value: "/api/v1/payments/process"

            - name: FAILURE_TYPE
              value: "timeout"

            - name: FAILURE_RATE
              value: "20"

            - name: TOTAL_CHAOS_DURATION
              value: "120"
```

## Chaos Experiment Automation

### Scheduled Chaos Workflows

```yaml
# chaos-workflow-schedule.yaml
apiVersion: argoproj.io/v1alpha1
kind: CronWorkflow
metadata:
  name: scheduled-chaos-tests
  namespace: litmus
spec:
  # Run every weekday at 2 AM
  schedule: "0 2 * * 1-5"
  timezone: "America/New_York"

  # Keep last 10 workflow runs
  successfulJobsHistoryLimit: 10
  failedJobsHistoryLimit: 10

  workflowSpec:
    entrypoint: chaos-workflow
    serviceAccountName: argo-chaos

    templates:
      - name: chaos-workflow
        steps:
          # Pre-chaos checks
          - - name: verify-cluster-health
              template: health-check

          # Run chaos experiments in parallel
          - - name: pod-deletion
              template: run-pod-delete
            - name: network-latency
              template: run-network-latency
            - name: resource-stress
              template: run-resource-stress

          # Post-chaos verification
          - - name: verify-recovery
              template: recovery-check

          # Generate report
          - - name: generate-report
              template: chaos-report

      - name: health-check
        script:
          image: bitnami/kubectl:latest
          command: [bash]
          source: |
            #!/bin/bash
            set -e

            echo "Checking cluster health..."

            # Check node status
            unhealthy_nodes=$(kubectl get nodes --no-headers | grep -v "Ready" | wc -l)
            if [ $unhealthy_nodes -gt 0 ]; then
              echo "ERROR: $unhealthy_nodes nodes are not Ready"
              exit 1
            fi

            # Check critical pod status
            failing_pods=$(kubectl get pods -n production --no-headers | grep -v "Running\|Completed" | wc -l)
            if [ $failing_pods -gt 0 ]; then
              echo "ERROR: $failing_pods pods are not Running"
              exit 1
            fi

            # Check recent alerts
            recent_alerts=$(curl -s http://prometheus:9090/api/v1/query \
              --data-urlencode 'query=ALERTS{severity="critical",alertstate="firing"}' | \
              jq '.data.result | length')

            if [ $recent_alerts -gt 0 ]; then
              echo "ERROR: $recent_alerts critical alerts are firing"
              exit 1
            fi

            echo "Cluster health check passed"

      - name: run-pod-delete
        resource:
          action: create
          manifest: |
            apiVersion: litmuschaos.io/v1alpha1
            kind: ChaosEngine
            metadata:
              name: scheduled-pod-delete
              namespace: production
            spec:
              appinfo:
                appns: production
                applabel: "app=payment-service"
                appkind: deployment
              chaosServiceAccount: payment-service-chaos-sa
              monitoring: true
              jobCleanUpPolicy: delete
              experiments:
                - name: pod-delete
                  spec:
                    components:
                      env:
                        - name: TOTAL_CHAOS_DURATION
                          value: "30"
                        - name: CHAOS_INTERVAL
                          value: "10"
                        - name: FORCE
                          value: "false"

      - name: run-network-latency
        resource:
          action: create
          manifest: |
            apiVersion: litmuschaos.io/v1alpha1
            kind: ChaosEngine
            metadata:
              name: scheduled-network-latency
              namespace: production
            spec:
              appinfo:
                appns: production
                applabel: "app=payment-service"
                appkind: deployment
              chaosServiceAccount: payment-service-chaos-sa
              monitoring: true
              jobCleanUpPolicy: delete
              experiments:
                - name: pod-network-latency
                  spec:
                    components:
                      env:
                        - name: NETWORK_LATENCY
                          value: "1000"
                        - name: TOTAL_CHAOS_DURATION
                          value: "60"

      - name: run-resource-stress
        resource:
          action: create
          manifest: |
            apiVersion: litmuschaos.io/v1alpha1
            kind: ChaosEngine
            metadata:
              name: scheduled-cpu-stress
              namespace: production
            spec:
              appinfo:
                appns: production
                applabel: "app=payment-service"
                appkind: deployment
              chaosServiceAccount: payment-service-chaos-sa
              monitoring: true
              jobCleanUpPolicy: delete
              experiments:
                - name: pod-cpu-hog
                  spec:
                    components:
                      env:
                        - name: CPU_CORES
                          value: "1"
                        - name: TOTAL_CHAOS_DURATION
                          value: "60"

      - name: recovery-check
        script:
          image: bitnami/kubectl:latest
          command: [bash]
          source: |
            #!/bin/bash
            set -e

            echo "Verifying system recovery..."

            # Wait for pods to stabilize
            sleep 30

            # Check pod status
            kubectl wait --for=condition=ready pod \
              -l app=payment-service \
              -n production \
              --timeout=300s

            # Verify service availability
            response=$(curl -s -o /dev/null -w "%{http_code}" \
              http://payment-service.production.svc.cluster.local/health)

            if [ "$response" != "200" ]; then
              echo "ERROR: Service health check failed with status $response"
              exit 1
            fi

            echo "Recovery verification passed"

      - name: chaos-report
        script:
          image: python:3.9-slim
          command: [python]
          source: |
            import json
            import subprocess
            from datetime import datetime

            def generate_report():
                report = {
                    'timestamp': datetime.now().isoformat(),
                    'experiments': [],
                    'summary': {}
                }

                # Get chaos results
                cmd = ['kubectl', 'get', 'chaosresults', '-n', 'production', '-o', 'json']
                result = subprocess.run(cmd, capture_output=True, text=True)
                results = json.loads(result.stdout)

                passed = 0
                failed = 0

                for item in results.get('items', []):
                    spec = item.get('spec', {})
                    status = item.get('status', {})

                    experiment = {
                        'name': item['metadata']['name'],
                        'verdict': status.get('experimentStatus', {}).get('verdict', 'N/A'),
                        'probe_success': status.get('experimentStatus', {}).get('probeSuccessPercentage', 'N/A')
                    }

                    report['experiments'].append(experiment)

                    if experiment['verdict'] == 'Pass':
                        passed += 1
                    else:
                        failed += 1

                report['summary'] = {
                    'total': len(report['experiments']),
                    'passed': passed,
                    'failed': failed,
                    'success_rate': f"{(passed / len(report['experiments']) * 100):.2f}%" if report['experiments'] else "0%"
                }

                print(json.dumps(report, indent=2))

                # Send to monitoring system
                # send_to_prometheus(report)
                # send_to_slack(report)

            generate_report()

---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: argo-chaos
  namespace: litmus

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: argo-chaos-role
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log", "services"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list"]
  - apiGroups: ["litmuschaos.io"]
    resources: ["chaosengines", "chaosresults"]
    verbs: ["create", "delete", "get", "list", "watch"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: argo-chaos-rolebinding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: argo-chaos-role
subjects:
  - kind: ServiceAccount
    name: argo-chaos
    namespace: litmus
```

### Chaos Orchestration with Python

```python
# chaos_orchestrator.py
import os
import time
import logging
from typing import List, Dict, Optional
from kubernetes import client, config
from kubernetes.client.rest import ApiException
from dataclasses import dataclass
from datetime import datetime, timedelta
import prometheus_client as prom

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Prometheus metrics
chaos_experiments_total = prom.Counter(
    'chaos_experiments_total',
    'Total number of chaos experiments executed',
    ['experiment_type', 'status']
)

chaos_experiment_duration = prom.Histogram(
    'chaos_experiment_duration_seconds',
    'Duration of chaos experiments',
    ['experiment_type']
)

system_recovery_time = prom.Histogram(
    'chaos_recovery_time_seconds',
    'Time taken for system to recover after chaos',
    ['experiment_type']
)

@dataclass
class ExperimentResult:
    name: str
    status: str
    start_time: datetime
    end_time: datetime
    verdict: str
    probe_success_percentage: float
    failure_reason: Optional[str] = None

class ChaosOrchestrator:
    """Orchestrates chaos experiments with safety checks"""

    def __init__(self, namespace: str = "production"):
        config.load_incluster_config()
        self.api = client.CustomObjectsApi()
        self.core_api = client.CoreV1Api()
        self.apps_api = client.AppsV1Api()
        self.namespace = namespace
        self.chaos_group = "litmuschaos.io"
        self.chaos_version = "v1alpha1"

    def pre_flight_checks(self) -> bool:
        """Perform safety checks before running chaos experiments"""
        logger.info("Running pre-flight checks...")

        try:
            # Check for ongoing deployments
            deployments = self.apps_api.list_namespaced_deployment(self.namespace)
            for deployment in deployments.items:
                if self._is_deployment_updating(deployment):
                    logger.warning(f"Deployment {deployment.metadata.name} is updating")
                    return False

            # Check for critical alerts
            if self._has_critical_alerts():
                logger.warning("Critical alerts detected")
                return False

            # Check cluster resources
            if not self._check_cluster_resources():
                logger.warning("Insufficient cluster resources")
                return False

            # Check for existing chaos experiments
            if self._has_running_chaos():
                logger.warning("Chaos experiments already running")
                return False

            logger.info("Pre-flight checks passed")
            return True

        except Exception as e:
            logger.error(f"Pre-flight check failed: {e}")
            return False

    def _is_deployment_updating(self, deployment) -> bool:
        """Check if deployment is currently updating"""
        status = deployment.status
        if status.updated_replicas != status.replicas:
            return True
        if status.available_replicas != status.replicas:
            return True
        return False

    def _has_critical_alerts(self) -> bool:
        """Check for critical alerts in Prometheus"""
        # This would integrate with your Prometheus instance
        # For now, returning False
        return False

    def _check_cluster_resources(self) -> bool:
        """Verify cluster has sufficient resources"""
        nodes = self.core_api.list_node()

        for node in nodes.items:
            # Check node conditions
            for condition in node.status.conditions:
                if condition.type == "Ready" and condition.status != "True":
                    logger.warning(f"Node {node.metadata.name} is not ready")
                    return False

                if condition.type in ["MemoryPressure", "DiskPressure"]:
                    if condition.status == "True":
                        logger.warning(f"Node {node.metadata.name} has {condition.type}")
                        return False

        return True

    def _has_running_chaos(self) -> bool:
        """Check for running chaos experiments"""
        try:
            engines = self.api.list_namespaced_custom_object(
                group=self.chaos_group,
                version=self.chaos_version,
                namespace=self.namespace,
                plural="chaosengines"
            )

            for engine in engines.get('items', []):
                status = engine.get('status', {}).get('engineStatus', '')
                if status in ['running', 'initialized']:
                    return True

            return False

        except ApiException as e:
            logger.error(f"Failed to check for running chaos: {e}")
            return True  # Fail safe

    def create_chaos_engine(self, engine_spec: Dict) -> str:
        """Create a chaos engine"""
        try:
            result = self.api.create_namespaced_custom_object(
                group=self.chaos_group,
                version=self.chaos_version,
                namespace=self.namespace,
                plural="chaosengines",
                body=engine_spec
            )

            engine_name = result['metadata']['name']
            logger.info(f"Created chaos engine: {engine_name}")

            chaos_experiments_total.labels(
                experiment_type=engine_spec['spec']['experiments'][0]['name'],
                status='started'
            ).inc()

            return engine_name

        except ApiException as e:
            logger.error(f"Failed to create chaos engine: {e}")
            raise

    def wait_for_experiment(
        self,
        engine_name: str,
        timeout: int = 600
    ) -> ExperimentResult:
        """Wait for chaos experiment to complete"""
        start_time = datetime.now()
        end_time = start_time + timedelta(seconds=timeout)

        while datetime.now() < end_time:
            try:
                engine = self.api.get_namespaced_custom_object(
                    group=self.chaos_group,
                    version=self.chaos_version,
                    namespace=self.namespace,
                    plural="chaosengines",
                    name=engine_name
                )

                status = engine.get('status', {})
                engine_status = status.get('engineStatus', '')

                if engine_status == 'completed':
                    exp_status = status.get('experiments', [{}])[0]

                    result = ExperimentResult(
                        name=engine_name,
                        status='completed',
                        start_time=start_time,
                        end_time=datetime.now(),
                        verdict=exp_status.get('verdict', 'Unknown'),
                        probe_success_percentage=float(
                            exp_status.get('probeSuccessPercentage', '0')
                        )
                    )

                    experiment_type = engine['spec']['experiments'][0]['name']
                    duration = (result.end_time - result.start_time).total_seconds()

                    chaos_experiment_duration.labels(
                        experiment_type=experiment_type
                    ).observe(duration)

                    chaos_experiments_total.labels(
                        experiment_type=experiment_type,
                        status=result.verdict.lower()
                    ).inc()

                    return result

                elif engine_status == 'stopped':
                    return ExperimentResult(
                        name=engine_name,
                        status='stopped',
                        start_time=start_time,
                        end_time=datetime.now(),
                        verdict='Stopped',
                        probe_success_percentage=0.0,
                        failure_reason="Experiment was stopped"
                    )

                time.sleep(10)

            except ApiException as e:
                logger.error(f"Failed to get chaos engine status: {e}")
                raise

        # Timeout
        return ExperimentResult(
            name=engine_name,
            status='timeout',
            start_time=start_time,
            end_time=datetime.now(),
            verdict='Timeout',
            probe_success_percentage=0.0,
            failure_reason="Experiment timed out"
        )

    def verify_recovery(self, target_labels: Dict[str, str]) -> bool:
        """Verify system has recovered after chaos"""
        logger.info("Verifying system recovery...")
        recovery_start = time.time()

        label_selector = ','.join([f"{k}={v}" for k, v in target_labels.items()])

        # Wait for pods to be ready
        max_wait = 300  # 5 minutes
        elapsed = 0

        while elapsed < max_wait:
            try:
                pods = self.core_api.list_namespaced_pod(
                    namespace=self.namespace,
                    label_selector=label_selector
                )

                total_pods = len(pods.items)
                ready_pods = sum(
                    1 for pod in pods.items
                    if pod.status.phase == 'Running' and
                    all(cs.ready for cs in pod.status.container_statuses or [])
                )

                if total_pods > 0 and ready_pods == total_pods:
                    recovery_time = time.time() - recovery_start
                    logger.info(f"System recovered in {recovery_time:.2f} seconds")

                    system_recovery_time.labels(
                        experiment_type='unknown'
                    ).observe(recovery_time)

                    return True

                time.sleep(10)
                elapsed += 10

            except ApiException as e:
                logger.error(f"Failed to verify recovery: {e}")
                return False

        logger.warning("System failed to recover within timeout")
        return False

    def cleanup_experiment(self, engine_name: str):
        """Clean up chaos engine after experiment"""
        try:
            self.api.delete_namespaced_custom_object(
                group=self.chaos_group,
                version=self.chaos_version,
                namespace=self.namespace,
                plural="chaosengines",
                name=engine_name
            )
            logger.info(f"Deleted chaos engine: {engine_name}")

        except ApiException as e:
            logger.error(f"Failed to cleanup chaos engine: {e}")

    def run_experiment_suite(
        self,
        experiments: List[Dict]
    ) -> List[ExperimentResult]:
        """Run a suite of chaos experiments"""
        if not self.pre_flight_checks():
            logger.error("Pre-flight checks failed, aborting experiments")
            return []

        results = []

        for exp_spec in experiments:
            logger.info(f"Running experiment: {exp_spec['metadata']['name']}")

            try:
                engine_name = self.create_chaos_engine(exp_spec)
                result = self.wait_for_experiment(engine_name)
                results.append(result)

                logger.info(
                    f"Experiment {engine_name} completed: "
                    f"verdict={result.verdict}, "
                    f"probe_success={result.probe_success_percentage}%"
                )

                # Verify recovery before next experiment
                target_labels = exp_spec['spec']['appinfo']['applabel']
                labels_dict = dict(
                    item.split('=') for item in target_labels.split(',')
                )

                if not self.verify_recovery(labels_dict):
                    logger.error("System failed to recover, stopping experiments")
                    break

                # Wait between experiments
                time.sleep(30)

            except Exception as e:
                logger.error(f"Experiment failed: {e}")
                results.append(ExperimentResult(
                    name=exp_spec['metadata']['name'],
                    status='failed',
                    start_time=datetime.now(),
                    end_time=datetime.now(),
                    verdict='Failed',
                    probe_success_percentage=0.0,
                    failure_reason=str(e)
                ))

            finally:
                self.cleanup_experiment(engine_name)

        return results

# Example usage
if __name__ == "__main__":
    orchestrator = ChaosOrchestrator(namespace="production")

    pod_delete_experiment = {
        'apiVersion': 'litmuschaos.io/v1alpha1',
        'kind': 'ChaosEngine',
        'metadata': {
            'name': 'payment-pod-delete',
            'namespace': 'production'
        },
        'spec': {
            'appinfo': {
                'appns': 'production',
                'applabel': 'app=payment-service',
                'appkind': 'deployment'
            },
            'chaosServiceAccount': 'payment-service-chaos-sa',
            'monitoring': True,
            'jobCleanUpPolicy': 'delete',
            'experiments': [
                {
                    'name': 'pod-delete',
                    'spec': {
                        'components': {
                            'env': [
                                {'name': 'TOTAL_CHAOS_DURATION', 'value': '30'},
                                {'name': 'CHAOS_INTERVAL', 'value': '10'},
                                {'name': 'FORCE', 'value': 'false'}
                            ]
                        }
                    }
                }
            ]
        }
    }

    results = orchestrator.run_experiment_suite([pod_delete_experiment])

    for result in results:
        print(f"\nExperiment: {result.name}")
        print(f"Verdict: {result.verdict}")
        print(f"Duration: {(result.end_time - result.start_time).total_seconds()}s")
        print(f"Probe Success: {result.probe_success_percentage}%")
```

## Monitoring and Observability

### Chaos Experiment Dashboards

```yaml
# chaos-monitoring-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: chaos-grafana-dashboard
  namespace: monitoring
  labels:
    grafana_dashboard: "1"
data:
  chaos-experiments.json: |
    {
      "dashboard": {
        "title": "Chaos Engineering Experiments",
        "panels": [
          {
            "title": "Experiment Success Rate",
            "targets": [
              {
                "expr": "rate(chaos_experiments_total{status=\"pass\"}[5m]) / rate(chaos_experiments_total[5m]) * 100"
              }
            ],
            "type": "graph"
          },
          {
            "title": "Experiment Duration",
            "targets": [
              {
                "expr": "chaos_experiment_duration_seconds"
              }
            ],
            "type": "graph"
          },
          {
            "title": "System Recovery Time",
            "targets": [
              {
                "expr": "chaos_recovery_time_seconds"
              }
            ],
            "type": "graph"
          },
          {
            "title": "Active Chaos Experiments",
            "targets": [
              {
                "expr": "count(kube_pod_info{pod=~\".*chaos.*\", phase=\"Running\"})"
              }
            ],
            "type": "singlestat"
          }
        ]
      }
    }
```

### Prometheus Rules for Chaos

```yaml
# chaos-prometheus-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: chaos-experiment-alerts
  namespace: monitoring
spec:
  groups:
    - name: chaos-engineering
      interval: 30s
      rules:
        - alert: ChaosExperimentFailed
          expr: |
            chaos_experiments_total{status="fail"} > 0
          for: 1m
          labels:
            severity: warning
            team: sre
          annotations:
            summary: "Chaos experiment failed"
            description: "Chaos experiment {{ $labels.experiment_type }} failed"

        - alert: SlowSystemRecovery
          expr: |
            chaos_recovery_time_seconds > 300
          for: 1m
          labels:
            severity: warning
            team: sre
          annotations:
            summary: "System recovery is slow"
            description: "System took {{ $value }}s to recover from chaos"

        - alert: LowExperimentSuccessRate
          expr: |
            (
              rate(chaos_experiments_total{status="pass"}[1h]) /
              rate(chaos_experiments_total[1h])
            ) < 0.8
          for: 10m
          labels:
            severity: critical
            team: sre
          annotations:
            summary: "Low chaos experiment success rate"
            description: "Only {{ $value | humanizePercentage }} of experiments passing"

        - alert: ChaosExperimentStuck
          expr: |
            time() - kube_pod_start_time{pod=~".*chaos.*"} > 1800
          for: 5m
          labels:
            severity: warning
            team: sre
          annotations:
            summary: "Chaos experiment appears stuck"
            description: "Pod {{ $labels.pod }} has been running for over 30 minutes"
```

## Integration with Incident Response

### Chaos-Triggered Incident Workflow

```python
# chaos_incident_integration.py
import json
import requests
from typing import Dict, Any
from datetime import datetime
import logging

logger = logging.getLogger(__name__)

class IncidentManager:
    """Integrates chaos engineering with incident management"""

    def __init__(
        self,
        pagerduty_api_key: str,
        slack_webhook_url: str,
        jira_url: str,
        jira_api_token: str
    ):
        self.pd_api_key = pagerduty_api_key
        self.slack_webhook = slack_webhook_url
        self.jira_url = jira_url
        self.jira_token = jira_api_token

    def create_incident_from_chaos(
        self,
        experiment_result: ExperimentResult,
        severity: str = "low"
    ) -> Dict[str, Any]:
        """Create incident if chaos experiment fails"""

        if experiment_result.verdict == "Pass":
            logger.info("Experiment passed, no incident created")
            return {}

        incident_data = {
            'title': f"Chaos Experiment Failed: {experiment_result.name}",
            'description': self._format_incident_description(experiment_result),
            'severity': severity,
            'source': 'chaos-engineering',
            'timestamp': datetime.now().isoformat(),
            'metadata': {
                'experiment_name': experiment_result.name,
                'verdict': experiment_result.verdict,
                'probe_success': experiment_result.probe_success_percentage,
                'duration': str(experiment_result.end_time - experiment_result.start_time)
            }
        }

        # Create PagerDuty incident for high severity
        if severity in ['high', 'critical']:
            pd_incident = self._create_pagerduty_incident(incident_data)
            incident_data['pagerduty_id'] = pd_incident.get('id')

        # Always create Slack notification
        self._send_slack_notification(incident_data)

        # Create JIRA ticket for tracking
        jira_issue = self._create_jira_ticket(incident_data)
        incident_data['jira_key'] = jira_issue.get('key')

        return incident_data

    def _format_incident_description(
        self,
        result: ExperimentResult
    ) -> str:
        """Format incident description"""
        return f"""
Chaos Experiment Failure Detected

**Experiment:** {result.name}
**Verdict:** {result.verdict}
**Probe Success Rate:** {result.probe_success_percentage}%
**Duration:** {result.end_time - result.start_time}
**Failure Reason:** {result.failure_reason or 'Unknown'}

**Timeline:**
- Started: {result.start_time.isoformat()}
- Ended: {result.end_time.isoformat()}

**Impact:**
The system did not meet the expected resilience criteria during chaos testing.
This indicates a potential weakness that could affect production reliability.

**Next Steps:**
1. Review experiment logs and metrics
2. Analyze system behavior during chaos
3. Identify root cause of failure
4. Implement fixes to improve resilience
5. Re-run experiment to verify fix
"""

    def _create_pagerduty_incident(
        self,
        incident_data: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Create PagerDuty incident"""
        payload = {
            'incident': {
                'type': 'incident',
                'title': incident_data['title'],
                'service': {
                    'id': 'YOUR_SERVICE_ID',
                    'type': 'service_reference'
                },
                'body': {
                    'type': 'incident_body',
                    'details': incident_data['description']
                },
                'urgency': 'high' if incident_data['severity'] == 'critical' else 'low'
            }
        }

        headers = {
            'Authorization': f'Token token={self.pd_api_key}',
            'Content-Type': 'application/json',
            'Accept': 'application/vnd.pagerduty+json;version=2'
        }

        try:
            response = requests.post(
                'https://api.pagerduty.com/incidents',
                headers=headers,
                json=payload,
                timeout=10
            )
            response.raise_for_status()
            return response.json()['incident']

        except Exception as e:
            logger.error(f"Failed to create PagerDuty incident: {e}")
            return {}

    def _send_slack_notification(
        self,
        incident_data: Dict[str, Any]
    ):
        """Send Slack notification"""
        severity_emoji = {
            'low': ':warning:',
            'medium': ':exclamation:',
            'high': ':rotating_light:',
            'critical': ':fire:'
        }

        message = {
            'blocks': [
                {
                    'type': 'header',
                    'text': {
                        'type': 'plain_text',
                        'text': f"{severity_emoji.get(incident_data['severity'], ':warning:')} Chaos Experiment Failed"
                    }
                },
                {
                    'type': 'section',
                    'fields': [
                        {
                            'type': 'mrkdwn',
                            'text': f"*Experiment:*\n{incident_data['metadata']['experiment_name']}"
                        },
                        {
                            'type': 'mrkdwn',
                            'text': f"*Verdict:*\n{incident_data['metadata']['verdict']}"
                        },
                        {
                            'type': 'mrkdwn',
                            'text': f"*Probe Success:*\n{incident_data['metadata']['probe_success']}%"
                        },
                        {
                            'type': 'mrkdwn',
                            'text': f"*Duration:*\n{incident_data['metadata']['duration']}"
                        }
                    ]
                },
                {
                    'type': 'section',
                    'text': {
                        'type': 'mrkdwn',
                        'text': f"*Description:*\n{incident_data['description'][:500]}"
                    }
                }
            ]
        }

        if incident_data.get('jira_key'):
            message['blocks'].append({
                'type': 'section',
                'text': {
                    'type': 'mrkdwn',
                    'text': f"*JIRA Ticket:* <{self.jira_url}/browse/{incident_data['jira_key']}|{incident_data['jira_key']}>"
                }
            })

        try:
            response = requests.post(
                self.slack_webhook,
                json=message,
                timeout=10
            )
            response.raise_for_status()

        except Exception as e:
            logger.error(f"Failed to send Slack notification: {e}")

    def _create_jira_ticket(
        self,
        incident_data: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Create JIRA ticket"""
        payload = {
            'fields': {
                'project': {'key': 'SRE'},
                'summary': incident_data['title'],
                'description': incident_data['description'],
                'issuetype': {'name': 'Bug'},
                'priority': {'name': self._map_severity_to_priority(incident_data['severity'])},
                'labels': ['chaos-engineering', 'reliability']
            }
        }

        headers = {
            'Authorization': f'Bearer {self.jira_token}',
            'Content-Type': 'application/json'
        }

        try:
            response = requests.post(
                f"{self.jira_url}/rest/api/2/issue",
                headers=headers,
                json=payload,
                timeout=10
            )
            response.raise_for_status()
            return response.json()

        except Exception as e:
            logger.error(f"Failed to create JIRA ticket: {e}")
            return {}

    def _map_severity_to_priority(self, severity: str) -> str:
        """Map severity to JIRA priority"""
        mapping = {
            'low': 'Low',
            'medium': 'Medium',
            'high': 'High',
            'critical': 'Highest'
        }
        return mapping.get(severity, 'Medium')
```

## Game Day Planning

### Game Day Execution Framework

```python
# game_day_orchestrator.py
from dataclasses import dataclass
from typing import List, Dict, Optional
from datetime import datetime, timedelta
import logging

@dataclass
class GameDayScenario:
    name: str
    description: str
    chaos_experiments: List[Dict]
    success_criteria: List[str]
    rollback_triggers: List[str]
    estimated_duration: int
    required_teams: List[str]

class GameDayOrchestrator:
    """Orchestrates chaos engineering game days"""

    def __init__(self):
        self.logger = logging.getLogger(__name__)
        self.chaos_orchestrator = ChaosOrchestrator()
        self.incident_manager = IncidentManager(
            pagerduty_api_key=os.getenv('PD_API_KEY'),
            slack_webhook_url=os.getenv('SLACK_WEBHOOK'),
            jira_url=os.getenv('JIRA_URL'),
            jira_api_token=os.getenv('JIRA_TOKEN')
        )

    def plan_game_day(
        self,
        scenario: GameDayScenario,
        scheduled_time: datetime
    ) -> Dict[str, Any]:
        """Plan a chaos engineering game day"""

        plan = {
            'scenario': scenario.name,
            'scheduled_time': scheduled_time,
            'preparation_checklist': self._create_preparation_checklist(scenario),
            'communication_plan': self._create_communication_plan(scenario),
            'runbook': self._create_runbook(scenario),
            'success_metrics': self._define_success_metrics(scenario)
        }

        self.logger.info(f"Game day planned: {scenario.name}")
        return plan

    def execute_game_day(
        self,
        scenario: GameDayScenario,
        dry_run: bool = False
    ) -> Dict[str, Any]:
        """Execute chaos engineering game day"""

        self.logger.info(f"Starting game day: {scenario.name}")

        # Pre-game checks
        if not self._pre_game_checks(scenario):
            return {'status': 'aborted', 'reason': 'Pre-game checks failed'}

        # Notify teams
        self._notify_teams_game_day_start(scenario)

        # Execute experiments
        results = []
        for experiment in scenario.chaos_experiments:
            if dry_run:
                self.logger.info(f"DRY RUN: Would execute {experiment['metadata']['name']}")
                continue

            result = self.chaos_orchestrator.run_experiment_suite([experiment])
            results.extend(result)

            # Check for rollback triggers
            if self._should_rollback(result[0], scenario):
                self.logger.warning("Rollback trigger activated, stopping game day")
                break

        # Post-game analysis
        analysis = self._analyze_game_day_results(results, scenario)

        # Notify teams of completion
        self._notify_teams_game_day_complete(scenario, analysis)

        return {
            'status': 'completed',
            'scenario': scenario.name,
            'results': results,
            'analysis': analysis
        }

    def _create_preparation_checklist(
        self,
        scenario: GameDayScenario
    ) -> List[Dict[str, Any]]:
        """Create preparation checklist for game day"""
        return [
            {
                'task': 'Notify all required teams',
                'teams': scenario.required_teams,
                'deadline': 'T-24h'
            },
            {
                'task': 'Verify monitoring and alerting',
                'details': 'Ensure all dashboards and alerts are functioning',
                'deadline': 'T-4h'
            },
            {
                'task': 'Review runbook procedures',
                'teams': ['SRE', 'On-Call'],
                'deadline': 'T-2h'
            },
            {
                'task': 'Confirm chaos experiment configurations',
                'details': 'Review all experiment parameters',
                'deadline': 'T-1h'
            },
            {
                'task': 'Establish communication channels',
                'details': 'Set up war room and video conference',
                'deadline': 'T-30m'
            }
        ]

    def _create_communication_plan(
        self,
        scenario: GameDayScenario
    ) -> Dict[str, Any]:
        """Create communication plan for game day"""
        return {
            'primary_channel': '#chaos-engineering-gameday',
            'video_conference': 'https://meet.company.com/gameday',
            'notification_schedule': {
                'T-24h': 'Initial notification to all teams',
                'T-1h': 'Reminder and preparation check-in',
                'T-0': 'Game day start notification',
                'T+completion': 'Results and debrief invitation'
            },
            'escalation_contacts': {
                'sre_lead': 'sre-lead@company.com',
                'engineering_manager': 'eng-mgr@company.com',
                'incident_commander': 'ic@company.com'
            }
        }

    def _create_runbook(
        self,
        scenario: GameDayScenario
    ) -> Dict[str, Any]:
        """Create runbook for game day execution"""
        return {
            'overview': scenario.description,
            'prerequisites': [
                'All teams notified and available',
                'Monitoring dashboards accessible',
                'Runbook procedures reviewed',
                'Rollback procedures tested'
            ],
            'execution_steps': [
                {
                    'step': 1,
                    'action': 'Verify system baseline',
                    'details': 'Confirm all services are healthy and metrics are normal'
                },
                {
                    'step': 2,
                    'action': 'Execute chaos experiments',
                    'details': 'Run experiments in sequence, monitoring impact'
                },
                {
                    'step': 3,
                    'action': 'Monitor system response',
                    'details': 'Watch dashboards, alerts, and logs'
                },
                {
                    'step': 4,
                    'action': 'Verify recovery',
                    'details': 'Ensure system returns to normal state'
                },
                {
                    'step': 5,
                    'action': 'Document findings',
                    'details': 'Record observations and unexpected behaviors'
                }
            ],
            'rollback_procedures': scenario.rollback_triggers,
            'success_criteria': scenario.success_criteria
        }
```

## Best Practices and Production Considerations

### Safety Guidelines

1. **Start Small**: Begin with minimal blast radius experiments
2. **Gradual Expansion**: Increase complexity and scope over time
3. **Always Monitor**: Implement comprehensive observability
4. **Have Rollback Plans**: Define clear rollback procedures
5. **Team Communication**: Keep all stakeholders informed
6. **Learn and Iterate**: Use failures as learning opportunities

### Production Deployment Checklist

```yaml
# chaos-engineering-checklist.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: chaos-engineering-checklist
  namespace: litmus
data:
  production-readiness.md: |
    # Chaos Engineering Production Readiness Checklist

    ## Infrastructure
    - [ ] Litmus operator installed and configured
    - [ ] Chaos experiments catalog available
    - [ ] RBAC policies properly configured
    - [ ] Resource limits set for chaos pods

    ## Safety
    - [ ] Pre-flight checks implemented
    - [ ] Automatic rollback triggers configured
    - [ ] Blast radius controls in place
    - [ ] Emergency stop procedures documented

    ## Monitoring
    - [ ] Chaos metrics exposed to Prometheus
    - [ ] Grafana dashboards created
    - [ ] Alert rules configured
    - [ ] Log aggregation working

    ## Communication
    - [ ] Team notification procedures defined
    - [ ] Incident integration configured
    - [ ] Escalation paths documented
    - [ ] Status page integration setup

    ## Documentation
    - [ ] Experiment catalog maintained
    - [ ] Runbooks created and tested
    - [ ] Post-mortem template ready
    - [ ] Best practices documented

    ## Validation
    - [ ] Experiments tested in non-production
    - [ ] Recovery procedures verified
    - [ ] Team training completed
    - [ ] Game day exercises conducted
```

## Conclusion

Chaos engineering with Litmus provides a robust framework for building resilient Kubernetes applications. By systematically introducing failures and observing system behavior, teams can identify weaknesses before they cause production outages. The key to successful chaos engineering is starting small, automating safety checks, integrating with incident response processes, and fostering a culture of continuous learning and improvement.

This comprehensive guide provides the foundation for implementing production-ready chaos engineering practices, from basic pod failures to complex distributed system scenarios, with complete automation and safety mechanisms.