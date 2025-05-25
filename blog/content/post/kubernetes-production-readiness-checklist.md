---
title: "The Ultimate Kubernetes Production Readiness Checklist: 50+ Best Practices"
date: 2027-01-05T09:00:00-05:00
draft: false
tags: ["Kubernetes", "DevOps", "Production", "Best Practices", "Security", "Reliability", "Scaling", "Observability", "RBAC"]
categories:
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive, battle-tested checklist for production-grade Kubernetes deployments, covering health checks, security, scaling, observability, governance, and more"
more_link: "yes"
url: "/kubernetes-production-readiness-checklist/"
---

After deploying and managing hundreds of Kubernetes clusters across countless organizations, I've learned that the difference between a stable production environment and a disaster waiting to happen often comes down to a specific set of practices. This isn't theoretical advice—it's a distillation of hard-earned lessons, production incidents, and 3 AM pages that have shaped my approach to Kubernetes.

<!--more-->

## Introduction: Beyond the Hello World Kubernetes

Setting up your first Kubernetes cluster is relatively straightforward—plenty of tutorials can get you running a basic deployment in minutes. But production is a completely different animal. The gap between a functioning demo and a production-ready platform is vast, filled with nuanced configuration decisions that impact security, reliability, and operational efficiency.

Having spent years in the trenches building and fixing Kubernetes deployments, I've developed this comprehensive checklist. It's the same one I use when auditing client environments or building new production platforms from scratch.

## Health Checks: The Foundation of Reliability

Health checks are the first line of defense against service disruptions. Without them, Kubernetes can't effectively manage your workloads during deployments, restarts, or when nodes fail.

### Best Practices

#### 1. Implement Readiness Probes Properly

Readiness probes tell Kubernetes when your application is ready to accept traffic. Missing or incorrectly configured probes lead to premature traffic routing and failed requests:

```yaml
readinessProbe:
  httpGet:
    path: /healthz
    port: 8080
  initialDelaySeconds: 10  # Adjust based on typical startup time
  periodSeconds: 5
  failureThreshold: 3
```

**Pro Tip**: For applications with complex startup sequences (like apps that need to sync data or build caches), tune `initialDelaySeconds` based on actual startup timing data rather than guessing.

#### 2. Configure Liveness Probes Deliberately

Liveness probes check if your application is still running properly. Unlike readiness probes, failing liveness probes result in container restarts:

```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 8080
  periodSeconds: 15
  failureThreshold: 3
  timeoutSeconds: 1
```

**Common Pitfall**: I've seen many teams reuse the same endpoint for both readiness and liveness, which often leads to disastrous restart loops. Your liveness endpoint should check only if the process is running, not if it's ready for traffic.

#### 3. Add Startup Probes for Slow-Starting Applications

Startup probes, introduced in Kubernetes 1.16, are ideal for applications with variable or slow startup times:

```yaml
startupProbe:
  httpGet:
    path: /healthz
    port: 8080
  failureThreshold: 30
  periodSeconds: 10
```

This configuration gives your application up to 5 minutes to start before Kubernetes begins checking liveness.

## Application Resilience: Handling Failure Gracefully

The real world is messy—networks fail, dependencies become unavailable, and nodes crash. Your applications must be designed to handle these realities gracefully.

### Best Practices

#### 1. Implement Graceful Termination

When Kubernetes needs to stop a container, it sends a SIGTERM signal. Your application should catch this signal and shut down gracefully:

```yaml
lifecycle:
  preStop:
    exec:
      command: ["sh", "-c", "sleep 10 && /app/preStop.sh"]
```

This preStop hook delays termination to allow in-flight requests to complete. I've seen countless outages where this simple configuration would have prevented dropped connections during deployments.

#### 2. Make Startup Logic Resilient to Dependency Failures

Your application should handle temporary unavailability of dependencies during startup:

```go
// Pseudo-code example
for retries := 0; retries < maxRetries; retries++ {
  if dbConnection := connectToDatabase(); dbConnection != nil {
    break
  }
  sleep(exponentialBackoff(retries))
}
```

This approach prevents cascading failures when infrastructure components restart.

#### 3. Implement Circuit Breakers for External Dependencies

Use circuit breakers to fail fast when dependencies are unreachable, rather than letting requests pile up:

```yaml
apiVersion: networking.istio.io/v1alpha3
kind: DestinationRule
metadata:
  name: circuit-breaker
spec:
  host: my-service
  trafficPolicy:
    connectionPool:
      http:
        http1MaxPendingRequests: 1
        maxRequestsPerConnection: 1
    outlierDetection:
      consecutive5xxErrors: 1
      interval: 1s
      baseEjectionTime: 3m
```

#### 4. Test Failure Scenarios Regularly

Use chaos engineering tools to validate your application's resilience to common failure modes:

```yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: PodChaos
metadata:
  name: pod-failure-test
spec:
  action: pod-failure
  mode: one
  selector:
    namespaces:
      - default
    labelSelectors:
      "app": "my-app"
  duration: "30s"
  scheduler:
    cron: "@every 24h"
```

## Scaling: Handling Variable Loads

Proper scaling configuration ensures your application remains reliable under varying loads while optimizing resource utilization.

### Best Practices

#### 1. Configure Horizontal Pod Autoscaling (HPA)

Set up HPAs based on CPU utilization, memory usage, or custom metrics:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: my-service
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: my-service
  minReplicas: 3
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

**Pro Tip**: Don't set target utilization too low—I typically aim for 70-80% to balance responsiveness with efficiency.

#### 2. Configure Pod Disruption Budgets (PDBs)

PDBs protect your application during node maintenance and cluster upgrades:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: my-service-pdb
spec:
  minAvailable: 2  # Or use maxUnavailable: 1
  selector:
    matchLabels:
      app: my-service
```

This ensures at least 2 pods remain available during voluntary disruptions.

#### 3. Use Node Affinity to Distribute Workloads

Spread your workloads across failure domains to improve reliability:

```yaml
affinity:
  nodeAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      nodeSelectorTerms:
      - matchExpressions:
        - key: topology.kubernetes.io/zone
          operator: In
          values:
          - us-central1-a
          - us-central1-b
          - us-central1-c
```

#### 4. Consider TopologySpreadConstraints for High Availability

Ensure workloads spread evenly across nodes and zones:

```yaml
topologySpreadConstraints:
- maxSkew: 1
  topologyKey: topology.kubernetes.io/zone
  whenUnsatisfiable: DoNotSchedule
  labelSelector:
    matchLabels:
      app: my-service
```

## Resource Management: Balancing Performance and Efficiency

Proper resource allocation is critical for both application performance and cluster stability.

### Best Practices

#### 1. Always Set Resource Requests and Limits

Define CPU and memory parameters for every container:

```yaml
resources:
  requests:
    cpu: 250m
    memory: 512Mi
  limits:
    memory: 1Gi
```

**Important**: I often recommend setting CPU requests but not limits, as CPU is a compressible resource and limits can cause throttling. For memory, both requests and limits are essential.

#### 2. Set Namespace Quotas and Default Limits

Use ResourceQuotas to prevent namespace-level resource exhaustion:

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: compute-resources
spec:
  hard:
    requests.cpu: "10"
    requests.memory: 20Gi
    limits.cpu: "20"
    limits.memory: 40Gi
    pods: "50"
```

And LimitRanges to set defaults for containers that don't specify resources:

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: default-limits
spec:
  limits:
  - default:
      memory: 512Mi
      cpu: 500m
    defaultRequest:
      memory: 256Mi
      cpu: 100m
    type: Container
```

#### 3. Rightsize with VPA Recommendations

Use Vertical Pod Autoscaler in recommendation mode to gather data on actual usage:

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: my-service-vpa
spec:
  targetRef:
    apiVersion: "apps/v1"
    kind: Deployment
    name: my-service
  updatePolicy:
    updateMode: "Off"  # Recommendation mode
```

This provides insights without automatic changes, which can be disruptive.

## Security: Defense in Depth

Security is non-negotiable in production environments. These practices establish multiple layers of protection.

### Best Practices

#### 1. Configure Pod Security Context

Run containers as non-root users with limited capabilities:

```yaml
securityContext:
  runAsUser: 1000
  runAsGroup: 3000
  runAsNonRoot: true
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities:
    drop:
    - ALL
    add:
    - NET_BIND_SERVICE  # Only if needed
```

#### 2. Enforce Pod Security Standards

Use Kubernetes Pod Security Standards to enforce baseline security:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: my-namespace
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
```

#### 3. Scan Images for Vulnerabilities

Implement CI/CD pipeline scanning and admission control:

```bash
# In your CI/CD pipeline
trivy image my-app:latest --severity HIGH,CRITICAL

# Kubernetes validation using Kyverno
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: block-vulnerable-images
spec:
  validationFailureAction: Enforce
  background: false
  rules:
  - name: validate-image-scan
    match:
      resources:
        kinds:
        - Pod
    validate:
      message: "Image contains critical vulnerabilities"
      image:
        attestations:
        - type: https://trivy.dev/
          conditions:
          - key: "{{ contains(scan.fixableCriticalCount, '0') }}"
            operator: Equals
            value: true
```

#### 4. Use Network Policies

Implement defense-in-depth with explicit network rules:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
spec:
  podSelector: {}
  policyTypes:
  - Ingress
```

This denies all ingress traffic by default. Then add specific allowances:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-specific-ingress
spec:
  podSelector:
    matchLabels:
      app: my-service
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: frontend
    ports:
    - protocol: TCP
      port: 8080
```

## Secrets and Configuration Management

Proper secrets management is essential for security and operational simplicity.

### Best Practices

#### 1. Use External Secrets Management

Integrate with a dedicated secrets manager rather than relying on Kubernetes Secrets:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: database-credentials
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: vault-backend
    kind: ClusterSecretStore
  target:
    name: db-credentials
  data:
  - secretKey: username
    remoteRef:
      key: my-app/database
      property: username
  - secretKey: password
    remoteRef:
      key: my-app/database
      property: password
```

#### 2. Mount Secrets as Files, Not Environment Variables

When using Kubernetes Secrets, mount them as volumes:

```yaml
containers:
- name: my-app
  volumeMounts:
  - name: secrets
    mountPath: "/etc/secrets"
    readOnly: true
volumes:
- name: secrets
  secret:
    secretName: app-credentials
```

This prevents secrets from appearing in environment dumps and process listings.

#### 3. Separate Configuration by Environment

Use Kubernetes configurations that follow environment boundaries:

```bash
# Structure
environments/
  base/
    deployment.yaml
    service.yaml
  production/
    kustomization.yaml
    configmap.yaml
  staging/
    kustomization.yaml
    configmap.yaml
```

With Kustomize overlays to manage differences:

```yaml
# kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
- ../base
patches:
- path: configmap.yaml
```

## Observability and Logging: Understanding System Behavior

You can't manage what you can't measure. Comprehensive observability is crucial for production operations.

### Best Practices

#### 1. Implement Structured JSON Logging

Ensure logs are machine-parseable with consistent formats:

```yaml
containers:
- name: my-app
  env:
  - name: LOG_FORMAT
    value: json
```

This makes logs easier to parse, filter, and analyze.

#### 2. Add Context to Logs

Include request IDs and trace IDs for correlation:

```go
// Pseudo-code example
log.WithFields(log.Fields{
  "requestId": ctx.RequestID(),
  "traceId": opentelemetry.TraceIDFromContext(ctx),
  "service": "payment-service",
  "user": user.ID,
}).Info("Payment processing started")
```

#### 3. Configure Cluster-Level Monitoring

Set up comprehensive metrics collection:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: my-service
spec:
  selector:
    matchLabels:
      app: my-service
  endpoints:
  - port: metrics
    interval: 15s
    path: /metrics
```

#### 4. Implement Distributed Tracing

Add OpenTelemetry instrumentation to track requests across services:

```yaml
env:
- name: OTEL_SERVICE_NAME
  value: "payment-service"
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: "http://otel-collector:4317"
```

## Governance and RBAC: Managing Access

Proper access control is essential for security and auditability.

### Best Practices

#### 1. Use Fine-Grained RBAC

Create role bindings that follow the principle of least privilege:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: my-namespace
  name: pod-reader
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list", "watch"]
```

#### 2. Leverage Service Accounts with Minimal Permissions

Create dedicated service accounts for each workload:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-service
automountServiceAccountToken: false  # Disable default token mounting
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-service
spec:
  template:
    spec:
      serviceAccountName: my-service
      volumes:
      - name: token
        projected:
          sources:
          - serviceAccountToken:
              path: token
              expirationSeconds: 3600
              audience: my-service
```

#### 3. Implement Multi-Tenancy Boundaries

Use namespaces with network policies, resource quotas, and RBAC:

```yaml
# Create namespace with resource limits
kubectl create namespace team-a
kubectl apply -f resource-quota.yaml -n team-a

# Apply network isolation
kubectl apply -f network-policy-default-deny.yaml -n team-a

# Set up RBAC for the team
kubectl apply -f team-a-role.yaml -n team-a
kubectl apply -f team-a-rolebinding.yaml -n team-a
```

## Policy Enforcement: Ensuring Compliance

Automated policy enforcement prevents configuration drift and security gaps.

### Best Practices

#### 1. Implement Admission Controllers

Use OPA Gatekeeper or Kyverno to enforce organizational policies:

```yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredLabels
metadata:
  name: require-team-label
spec:
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Namespace"]
    excludedNamespaces: ["kube-system", "gatekeeper-system"]
  parameters:
    labels: ["team"]
```

#### 2. Enforce Image Source Policies

Restrict image sources to trusted registries:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: restrict-image-registries
spec:
  validationFailureAction: Enforce
  rules:
  - name: validate-registries
    match:
      resources:
        kinds:
        - Pod
    validate:
      message: "Only images from approved registries are allowed"
      pattern:
        spec:
          containers:
          - image: "docker.io/mycompany/*"
```

#### 3. Validate Configuration with CI/CD

Implement pre-deployment validation in your pipelines:

```bash
# In your CI/CD pipeline
kubectl apply --dry-run=server -f k8s-manifests/
```

This validates configurations against the API server without making changes.

## Conclusion: Building Production-Grade Kubernetes

This checklist represents years of operational experience and countless production incidents. It's not meant to be implemented all at once—start with the basics and incrementally enhance your environment as your needs grow.

Remember that production readiness is a journey, not a destination. These practices evolve along with Kubernetes itself and the ever-changing threat landscape.

The most successful Kubernetes operators I've worked with treat their platforms as products—continuously improving based on real operational feedback and metrics. By implementing the practices in this checklist, you'll be well on your way to a robust, secure, and reliable Kubernetes environment.

What production challenges have you faced with Kubernetes? Let me know in the comments below, and I'll try to provide guidance based on my experience.