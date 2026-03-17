---
title: "Kubernetes Knative Serving: Autoscaling to Zero, Traffic Splitting, and Revision Management"
date: 2031-07-24T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Knative", "Serverless", "Autoscaling", "Traffic Management", "Service Mesh"]
categories:
- Kubernetes
- Serverless
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Knative Serving on Kubernetes covering scale-to-zero configuration, cold start optimization, traffic splitting for canary deployments, and revision lifecycle management for production serverless workloads."
more_link: "yes"
url: "/kubernetes-knative-serving-autoscaling-zero-traffic-splitting-revision-management/"
---

Knative Serving brings serverless semantics to Kubernetes without requiring a managed serverless platform. The value proposition is precise: scale to zero when idle (eliminating costs for infrequently-used services), scale rapidly from zero on demand, and deploy new versions with fine-grained traffic splitting that makes canary releases and rollbacks safe operations. This guide builds a production-ready Knative Serving deployment and covers the configuration decisions that matter most in enterprise environments.

<!--more-->

# Kubernetes Knative Serving: Autoscaling to Zero, Traffic Splitting, and Revision Management

## Knative Serving Architecture

Knative Serving consists of several cooperating components:

```
┌─────────────────────────────────────────────────────────────────┐
│ Knative Serving                                                  │
│                                                                  │
│  ┌──────────────┐   ┌──────────────┐   ┌────────────────────┐  │
│  │   Service    │──▶│   Route      │──▶│  Ingress Gateway   │  │
│  │  (top-level) │   │  (traffic    │   │  (Istio/Contour/   │  │
│  └──────┬───────┘   │   routing)   │   │   Kourier)         │  │
│         │           └──────────────┘   └────────────────────┘  │
│         │                                                        │
│         ▼                                                        │
│  ┌──────────────┐   ┌──────────────────────────────────────┐   │
│  │ Configuration│──▶│  Revision 1 (old)  │  Revision 2     │   │
│  │  (template)  │   │  - 20% traffic     │  (new)          │   │
│  └──────────────┘   │                    │  - 80% traffic  │   │
│                     └────────────────────┴─────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Autoscaler (KPA)                                        │   │
│  │  - Watches RPS/concurrency metrics from Queue Proxy      │   │
│  │  - Scales Deployment replicas                            │   │
│  │  - Activator handles scale-from-zero buffering           │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

Key objects:
- **Service**: The top-level abstraction. Creates and manages Configuration, Route, and Revisions.
- **Revision**: An immutable snapshot of the Service configuration at a point in time.
- **Route**: Defines traffic distribution across Revisions.
- **Configuration**: The latest desired state (template for new Revisions).

## Installing Knative Serving

### Using the Knative Operator

```bash
# Install the Knative Operator
kubectl apply -f https://github.com/knative/operator/releases/download/knative-v1.16.0/operator.yaml

# Wait for operator to be ready
kubectl wait --for=condition=available deployment/knative-operator \
  --namespace knative-operator --timeout=120s
```

### KnativeServing Custom Resource

```yaml
# knative-serving.yaml
apiVersion: operator.knative.dev/v1beta1
kind: KnativeServing
metadata:
  name: knative-serving
  namespace: knative-serving
spec:
  version: "1.16"

  # Ingress configuration (using Kourier for simplicity, Istio for production)
  ingress:
    kourier:
      enabled: true

  # Core Knative Serving configuration
  config:
    config-autoscaler:
      # Global scale-to-zero grace period before termination
      scale-to-zero-grace-period: "30s"
      # How long to wait after last request before considering scale-to-zero
      scale-to-zero-pod-retention-period: "0s"
      # Stable window for autoscaling decisions
      stable-window: "60s"
      # Panic window (short-term scaling reaction)
      panic-window: "6s"
      # Panic threshold: scale aggressively when load exceeds this % of target
      panic-threshold-percentage: "200.0"
      # Target concurrency per pod (default)
      container-concurrency-target-default: "100"
      # Max scale-up rate per second
      max-scale-up-rate: "1000.0"
      # Max scale-down rate per second
      max-scale-down-rate: "2.0"
      # Activator capacity: how many requests the activator buffers during cold start
      activator-capacity: "100.0"
      # Enable scale-to-zero globally
      enable-scale-to-zero: "true"

    config-defaults:
      # Default revision timeout
      revision-timeout-seconds: "300"
      # Default response start timeout (connection established but no response headers)
      revision-response-start-timeout-seconds: "300"
      # Default initial scale (pods started when Service is created)
      initial-scale: "1"
      # Allow initial-scale=0 (start with zero pods)
      allow-zero-initial-scale: "true"
      # Default container concurrency
      container-concurrency: "0"  # 0 = unlimited
      # Maximum scale
      max-scale: "100"
      # Minimum scale
      min-scale: "0"

    config-domain:
      # Base domain for Knative Services
      # Revisions will be at: <name>-<namespace>.<domain>
      example.com: |
        selector:
          app: prod

    config-features:
      # Enable multi-container (sidecar) support
      multi-container: "enabled"
      # Enable init containers
      kubernetes.podspec-init-containers: "enabled"
      # Enable pod topology spread constraints
      kubernetes.podspec-topologyspreadconstraints: "enabled"
      # Enable field-level security context
      kubernetes.containerspec-addcapabilities: "disabled"
      kubernetes.podspec-securitycontext: "enabled"

    config-network:
      ingress-class: "kourier.ingress.networking.knative.dev"
      certificate-class: "cert-manager.certificate.networking.knative.dev"
      auto-tls: "enabled"
      http-protocol: "redirected"

    config-gc:
      # Keep last 5 revisions that are not active
      retain-since-create-time: "disabled"
      retain-since-last-active-time: "disabled"
      min-non-active-revisions: "2"
      max-non-active-revisions: "5"

    config-logging:
      loglevel.autoscaler: "info"
      loglevel.controller: "info"
      loglevel.webhook: "info"
```

```bash
kubectl apply -f knative-serving.yaml

# Wait for Knative Serving components to be ready
kubectl wait --for=condition=Ready knativeserving/knative-serving \
  --namespace knative-serving --timeout=300s

# Verify pods
kubectl get pods -n knative-serving
```

## Deploying a Knative Service

### Basic Service Definition

```yaml
# payment-service.yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: payment-service
  namespace: production
  labels:
    app: payment-service
    team: payments
spec:
  template:
    metadata:
      annotations:
        # Autoscaler configuration (overrides global defaults for this service)
        autoscaling.knative.dev/class: "kpa.autoscaling.knative.dev"
        autoscaling.knative.dev/metric: "rps"
        autoscaling.knative.dev/target: "50"           # 50 RPS per pod
        autoscaling.knative.dev/min-scale: "2"         # Always maintain 2 pods
        autoscaling.knative.dev/max-scale: "20"        # Cap at 20 pods
        autoscaling.knative.dev/scale-to-zero-pod-retention-period: "0s"
        autoscaling.knative.dev/window: "60s"
        autoscaling.knative.dev/panic-window-percentage: "10.0"
        autoscaling.knative.dev/panic-threshold-percentage: "200.0"
        # Target utilization: scale when actual utilization exceeds target * utilization
        autoscaling.knative.dev/target-utilization-percentage: "70"

        # Initial scale: start with 2 pods immediately (avoid cold start on first deploy)
        autoscaling.knative.dev/initial-scale: "2"

      labels:
        app: payment-service
        version: "v1.2.0"

    spec:
      # Container concurrency: 0 = unlimited, positive value = bounded
      containerConcurrency: 50

      # Timeout for the entire request lifecycle
      timeoutSeconds: 60

      # Response start timeout: headers must start within this time
      responseStartTimeoutSeconds: 60

      containers:
        - name: payment-service
          image: registry.example.com/payment-service:v1.2.0
          ports:
            - containerPort: 8080
              protocol: TCP
          env:
            - name: PORT
              value: "8080"
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: payments-db-credentials
                  key: url
          resources:
            requests:
              cpu: 100m
              memory: 256Mi
            limits:
              cpu: "1"
              memory: 512Mi
          readinessProbe:
            httpGet:
              path: /ready
              port: 8080
            initialDelaySeconds: 3
            periodSeconds: 5
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 30

      # Security context
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
```

```bash
kubectl apply -f payment-service.yaml

# Check service status
kubectl get ksvc payment-service -n production
# NAME              URL                                          LATESTCREATED          LATESTREADY            READY   REASON
# payment-service   https://payment-service.production.example.com   payment-service-00001   payment-service-00001   True

# Watch the service become ready
kubectl get revisions -n production -w
```

## Scale-to-Zero Configuration

### Understanding the Scale-to-Zero Process

When traffic to a Revision drops to zero:

1. The KPA (Knative Pod Autoscaler) sets the Revision's desired replica count to 0
2. The Ingress rule is updated to route incoming requests to the Activator instead of pods
3. The Activator buffers incoming requests (up to `activator-capacity`)
4. When a buffered request arrives, KPA creates pods
5. Once pods are ready, the Activator proxies the buffered requests
6. The Ingress rule is updated to route directly to pods

The `scale-to-zero-grace-period` determines how long the activator waits after the last replica terminates before marking the revision as scaled to zero.

### Configuring Scale-to-Zero Behavior

```yaml
# service-with-scale-to-zero.yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: report-generator
  namespace: production
spec:
  template:
    metadata:
      annotations:
        # Scale to zero after 30 seconds of no traffic
        autoscaling.knative.dev/scale-to-zero-pod-retention-period: "30s"

        # But always warm up at least 1 pod
        autoscaling.knative.dev/min-scale: "0"
        autoscaling.knative.dev/max-scale: "10"

        # Use concurrency as the scaling metric
        autoscaling.knative.dev/metric: "concurrency"
        autoscaling.knative.dev/target: "10"

        # Start with 1 pod on first deploy
        autoscaling.knative.dev/initial-scale: "1"

    spec:
      containers:
        - name: report-generator
          image: registry.example.com/report-generator:v2.1.0
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: "2"
              memory: 2Gi
```

### Cold Start Optimization

Cold start latency is the biggest challenge with scale-to-zero. Strategies to minimize it:

**1. Pre-pull images on all nodes:**

```yaml
# image-puller-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: image-puller
  namespace: production
spec:
  selector:
    matchLabels:
      app: image-puller
  template:
    metadata:
      labels:
        app: image-puller
    spec:
      initContainers:
        - name: pull-report-generator
          image: registry.example.com/report-generator:v2.1.0
          command: ["sh", "-c", "echo image pulled"]
      containers:
        - name: pause
          image: gcr.io/google_containers/pause:3.9
          resources:
            requests:
              cpu: 1m
              memory: 8Mi
```

**2. Use distroless or minimal base images to reduce pull time.**

**3. Configure the Activator queue depth:**

```yaml
# config-autoscaler
data:
  activator-capacity: "200.0"  # Buffer up to 200 concurrent requests during cold start
```

**4. Use HPA (Kubernetes HPA) instead of KPA for services where cold start is unacceptable:**

```yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: payment-service
  namespace: production
spec:
  template:
    metadata:
      annotations:
        # Use HPA instead of KPA for more predictable scaling
        autoscaling.knative.dev/class: "hpa.autoscaling.knative.dev"
        autoscaling.knative.dev/metric: "cpu"
        autoscaling.knative.dev/target: "70"
        # HPA never scales to zero
        autoscaling.knative.dev/min-scale: "2"
        autoscaling.knative.dev/max-scale: "20"
```

## Traffic Splitting

Knative's Route resource provides fine-grained traffic control across Revisions.

### Named Revision Deployment (Blue/Green)

```yaml
# service-blue-green.yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: payment-service
  namespace: production
spec:
  # Latest template creates a new revision
  template:
    metadata:
      name: payment-service-v2  # Explicit revision name
      annotations:
        autoscaling.knative.dev/min-scale: "2"
    spec:
      containers:
        - name: payment-service
          image: registry.example.com/payment-service:v2.0.0
          # ... resource and health check config

  traffic:
    # Keep current production traffic on old revision
    - revisionName: payment-service-v1
      percent: 100
      tag: stable
    # Deploy new revision but send 0% traffic initially
    - revisionName: payment-service-v2
      percent: 0
      tag: candidate
```

The `tag` field creates additional URLs for testing the revision directly:
- `stable-payment-service.production.example.com` → v1
- `candidate-payment-service.production.example.com` → v2 (direct access for testing)

### Canary Release (Progressive Traffic Splitting)

Gradually increase traffic to the new revision:

```bash
# Step 1: Deploy with 5% traffic to new revision
kubectl patch ksvc payment-service -n production \
  --type merge \
  -p '{"spec":{"traffic":[
    {"revisionName":"payment-service-v1","percent":95,"tag":"stable"},
    {"revisionName":"payment-service-v2","percent":5,"tag":"canary"}
  ]}}'

# Step 2: After validation, increase to 20%
kubectl patch ksvc payment-service -n production \
  --type merge \
  -p '{"spec":{"traffic":[
    {"revisionName":"payment-service-v1","percent":80,"tag":"stable"},
    {"revisionName":"payment-service-v2","percent":20,"tag":"canary"}
  ]}}'

# Step 3: After further validation, 50/50
kubectl patch ksvc payment-service -n production \
  --type merge \
  -p '{"spec":{"traffic":[
    {"revisionName":"payment-service-v1","percent":50,"tag":"stable"},
    {"revisionName":"payment-service-v2","percent":50,"tag":"canary"}
  ]}}'

# Step 4: Full cutover
kubectl patch ksvc payment-service -n production \
  --type merge \
  -p '{"spec":{"traffic":[
    {"revisionName":"payment-service-v2","percent":100,"tag":"stable"}
  ]}}'

# Verify current traffic distribution
kubectl get route payment-service -n production -o yaml | grep -A20 traffic
```

### Rollback

```bash
# Instant rollback to previous revision
kubectl patch ksvc payment-service -n production \
  --type merge \
  -p '{"spec":{"traffic":[
    {"revisionName":"payment-service-v1","percent":100,"tag":"stable"}
  ]}}'
```

### Traffic Splitting YAML

For GitOps workflows, manage traffic configuration declaratively:

```yaml
# payment-service-canary.yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: payment-service
  namespace: production
  annotations:
    serving.knative.dev/rolloutDuration: "180s"  # Gradual rollout over 3 minutes
spec:
  template:
    metadata:
      name: payment-service-v3
      annotations:
        autoscaling.knative.dev/min-scale: "2"
        autoscaling.knative.dev/max-scale: "20"
    spec:
      containers:
        - name: payment-service
          image: registry.example.com/payment-service:v3.0.0
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: 100m
              memory: 256Mi

  traffic:
    - latestRevision: true
      percent: 10
      tag: canary
    - revisionName: payment-service-v2
      percent: 90
      tag: stable
```

The `rolloutDuration` annotation triggers a gradual rollout where Knative automatically increases traffic to the latest revision over the specified duration.

## Revision Management

### Listing and Inspecting Revisions

```bash
# List all revisions
kubectl get revisions -n production
# NAME                      CONFIG NAME       K8S SERVICE NAME          GENERATION   READY   REASON
# payment-service-00001    payment-service   payment-service-00001    1            True
# payment-service-00002    payment-service   payment-service-00002    2            True
# payment-service-v2        payment-service   payment-service-v2       3            True
# payment-service-v3        payment-service   payment-service-v3       4            True

# Describe a specific revision
kubectl describe revision payment-service-v3 -n production

# Check which revisions are receiving traffic
kubectl get route payment-service -n production -o yaml
```

### Garbage Collection

By default, Knative retains all revisions. Configure automatic cleanup:

```yaml
# config-gc ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: config-gc
  namespace: knative-serving
data:
  # Minimum number of non-active revisions to retain regardless of time
  min-non-active-revisions: "2"
  # Maximum non-active revisions to retain
  max-non-active-revisions: "5"
  # Retain for at least this duration since creation (disabled = immediate eligible)
  retain-since-create-time: "disabled"
  # Retain for at least this duration after last being active
  retain-since-last-active-time: "168h"  # 7 days
```

### Manual Revision Deletion

```bash
# Delete a specific revision (only works if it has 0% traffic)
kubectl delete revision payment-service-00001 -n production

# Delete all non-active revisions older than 7 days
kubectl get revisions -n production -o json | \
  jq -r '.items[] |
    select(.metadata.creationTimestamp < (now - 604800 | todate)) |
    select(.spec.traffic == null or (.spec.traffic | length == 0)) |
    .metadata.name' | \
  xargs -I{} kubectl delete revision {} -n production
```

### Revision Labels and Pinning

For important revisions (like "last known good"), add labels to prevent GC:

```yaml
# Pin a revision by adding a label
apiVersion: serving.knative.dev/v1
kind: Revision
metadata:
  name: payment-service-v2
  namespace: production
  labels:
    serving.knative.dev/configuration: payment-service
    # Custom label to prevent auto-deletion
    environment: production-stable
    pinned: "true"
```

## Multi-Container Services

Knative Serving supports sidecar containers for service mesh and logging:

```yaml
# service-with-sidecar.yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: data-processor
  namespace: production
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/min-scale: "0"
        autoscaling.knative.dev/max-scale: "50"
        autoscaling.knative.dev/metric: "rps"
        autoscaling.knative.dev/target: "10"
    spec:
      containers:
        # Main application container
        - name: data-processor
          image: registry.example.com/data-processor:v1.0.0
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: 200m
              memory: 512Mi

        # Fluent Bit log shipper sidecar
        - name: fluent-bit
          image: fluent/fluent-bit:3.1
          volumeMounts:
            - name: fluent-bit-config
              mountPath: /fluent-bit/etc/
          resources:
            requests:
              cpu: 10m
              memory: 32Mi
            limits:
              cpu: 100m
              memory: 64Mi

      volumes:
        - name: fluent-bit-config
          configMap:
            name: fluent-bit-config
```

## Monitoring and Observability

### Prometheus Metrics

Knative Serving exposes metrics for monitoring:

```bash
# View available metrics
kubectl exec -n knative-serving deploy/autoscaler -- \
  curl -s localhost:9090/metrics | grep -E "^# HELP"
```

Key metrics:
- `autoscaler_desired_pods` - Target replica count
- `autoscaler_actual_pods` - Current replica count
- `autoscaler_not_ready_pods` - Pods not yet ready
- `autoscaler_panic_mode` - Whether autoscaler is in panic mode
- `queue_average_concurrent_requests` - Average concurrency at queue proxy
- `queue_requests_per_second` - RPS at queue proxy

```yaml
# knative-serving-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: knative-serving-alerts
  namespace: monitoring
spec:
  groups:
    - name: knative-serving
      rules:
        - alert: KnativeRevisionNotReady
          expr: |
            kube_deployment_status_replicas_ready{deployment=~".*-deployment"}
            / kube_deployment_spec_replicas{deployment=~".*-deployment"} < 0.5
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Knative revision has less than 50% pods ready"

        - alert: KnativeScaleToZeroStuck
          expr: |
            autoscaler_desired_pods > 0
            and on (namespace, service)
            autoscaler_actual_pods == 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Knative service desired > 0 but actual = 0"
            description: "Service {{ $labels.service }} in {{ $labels.namespace }} may have a cold start issue."

        - alert: KnativeHighColdStartLatency
          expr: |
            histogram_quantile(0.99,
              rate(activator_request_latencies_bucket[5m])
            ) > 5
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High P99 cold start latency for Knative services"
            description: "P99 cold start latency is {{ $value | humanizeDuration }}."
```

### Knative Service Status Conditions

```bash
# Check service conditions
kubectl get ksvc payment-service -n production -o yaml | \
  yq '.status.conditions'

# Check for configuration issues
kubectl describe ksvc payment-service -n production | tail -20
```

## GitOps Integration with ArgoCD

Managing Knative Services with ArgoCD requires careful attention to traffic splits:

```yaml
# argocd-knative-app.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: payment-service
  namespace: argocd
spec:
  project: production
  source:
    repoURL: https://github.com/yourorg/gitops-repo
    targetRevision: HEAD
    path: services/payment-service

  destination:
    server: https://kubernetes.default.svc
    namespace: production

  syncPolicy:
    automated:
      prune: false  # Don't delete revisions automatically
      selfHeal: true
    syncOptions:
      - ApplyOutOfSyncOnly=true
      - RespectIgnoreDifferences=true

  # Ignore differences in traffic split and status fields
  # (Knative updates these dynamically)
  ignoreDifferences:
    - group: serving.knative.dev
      kind: Service
      jsonPointers:
        - /status
        - /spec/traffic
```

## Production Best Practices

### Service Configuration Checklist

```yaml
# production-service-template.yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: my-service
  namespace: production
  labels:
    team: platform
    cost-center: engineering
spec:
  template:
    metadata:
      annotations:
        # Autoscaling
        autoscaling.knative.dev/min-scale: "2"   # Never below 2 for availability
        autoscaling.knative.dev/max-scale: "50"
        autoscaling.knative.dev/metric: "rps"
        autoscaling.knative.dev/target: "50"
        autoscaling.knative.dev/target-utilization-percentage: "70"

        # Concurrency
        autoscaling.knative.dev/window: "60s"

        # Revision naming for easier rollback
        # name will be set per deployment

    spec:
      containerConcurrency: 100
      timeoutSeconds: 300

      # Node affinity to avoid scheduling on spot instances for min-scale pods
      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              preference:
                matchExpressions:
                  - key: node.kubernetes.io/lifecycle
                    operator: NotIn
                    values: ["spot"]

      # Topology spread for high availability
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: my-service

      containers:
        - name: my-service
          image: registry.example.com/my-service:latest
          ports:
            - containerPort: 8080
          env:
            - name: PORT
              value: "8080"
          resources:
            requests:
              cpu: 100m
              memory: 256Mi
            limits:
              cpu: "1"
              memory: 512Mi
          readinessProbe:
            httpGet:
              path: /ready
              port: 8080
            initialDelaySeconds: 3
            periodSeconds: 3
            failureThreshold: 5
          livenessProbe:
            httpGet:
              path: /live
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 30
          lifecycle:
            preStop:
              exec:
                # Drain in-flight requests before shutdown
                command: ["/bin/sh", "-c", "sleep 5"]

      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
```

## Summary

Knative Serving provides a production-ready serverless platform on top of Kubernetes with three core capabilities:

- **Scale-to-zero** eliminates idle compute costs for infrequently-used services, with the Activator handling cold start buffering to maintain acceptable latency during scale-up
- **Traffic splitting** enables safe canary deployments and instant rollbacks by controlling traffic distribution across immutable Revisions, without requiring separate Deployment objects or Ingress configurations
- **Revision management** provides full history of service configurations with configurable garbage collection policies

The key operational decisions are: setting appropriate `min-scale` values (0 for truly infrequent services, 2+ for SLO-sensitive services), choosing between KPA (for aggressive scale-to-zero) and HPA (for stable latency), and integrating the traffic split lifecycle with your CI/CD pipeline for safe progressive delivery.
