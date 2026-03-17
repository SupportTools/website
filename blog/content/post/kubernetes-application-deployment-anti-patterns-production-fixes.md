---
title: "Kubernetes Application Deployment Anti-Patterns: Common Mistakes and How to Fix Them in Production"
date: 2031-09-09T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Deployments", "Best Practices", "Production", "Reliability", "DevOps"]
categories:
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A catalog of the most common Kubernetes deployment anti-patterns seen in production environments, with detailed explanations of why they fail and concrete fixes for each one."
more_link: "yes"
url: "/kubernetes-application-deployment-anti-patterns-production-fixes/"
---

After reviewing hundreds of production Kubernetes deployments, the same anti-patterns appear repeatedly. They range from missing resource limits that cause noisy neighbor problems to misconfigured health checks that cause cascading failures during deployments. Understanding why these patterns are harmful — not just that they are — helps teams build the intuition to avoid them in new services.

This guide catalogs the most impactful deployment anti-patterns with root cause analysis, real failure scenarios, and production-ready fixes for each one.

<!--more-->

# Kubernetes Application Deployment Anti-Patterns

## Anti-Pattern 1: Missing or Incorrect Resource Requests and Limits

This is the most common and most dangerous anti-pattern. Pods without resource requests get the `BestEffort` QoS class, meaning they are the first to be evicted under node pressure.

### Why It Fails

```yaml
# ANTI-PATTERN: No resource configuration
spec:
  containers:
    - name: api-server
      image: myapp:latest
      # No resources block
```

Consequences:
- Node gets overcommitted because the scheduler doesn't know what the pod needs
- During memory pressure, BestEffort pods are evicted first, causing unexpected service disruptions
- A memory-leaking pod consumes all node memory and causes OOMKill for other pods
- CPU-intensive pods starve neighbors without limits

### The Fix

```yaml
spec:
  containers:
    - name: api-server
      image: myapp:v1.2.3
      resources:
        requests:
          cpu: 100m       # Minimum CPU needed for scheduling
          memory: 128Mi   # Minimum memory for scheduling
        limits:
          cpu: 500m       # Maximum CPU before throttling
          memory: 256Mi   # Maximum memory before OOMKill
```

Guidelines for setting values:
1. Start with the VPA recommendation: deploy `VerticalPodAutoscaler` in `Off` mode first to gather recommendations without applying them
2. Set `requests` to roughly the p50 usage, `limits` to p99 + 30% buffer
3. For memory: set `limits` to no more than 2x `requests` unless the application has highly variable memory usage

```yaml
# VPA in recommendation-only mode
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: api-server-vpa
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  updatePolicy:
    updateMode: "Off"  # Recommendation only, no automatic changes
  resourcePolicy:
    containerPolicies:
      - containerName: api-server
        minAllowed:
          cpu: 50m
          memory: 64Mi
        maxAllowed:
          cpu: 2000m
          memory: 2Gi
```

## Anti-Pattern 2: Using `latest` Image Tag

```yaml
# ANTI-PATTERN
image: myapp:latest
```

### Why It Fails

- `latest` is mutable: two pods may run different code if the image was pushed between pulls
- Rollback is impossible: you cannot roll back to the "previous latest"
- CI/CD pipelines become unreliable: `latest` in staging may not match what goes to production
- Kubernetes cannot detect that an image changed for pod restarts if the tag is the same

### The Fix

Always use immutable, content-addressed image references. The best practice is to use the full digest:

```yaml
# CORRECT: immutable digest reference
image: registry.example.com/myapp@sha256:a1b2c3d4e5f6...

# Also acceptable: semantic version tag (if tags are never overwritten)
image: registry.example.com/myapp:v1.2.3

# For CI/CD: use git SHA
image: registry.example.com/myapp:git-$(git rev-parse --short HEAD)
```

Enforce this with a policy:

```yaml
# OPA Gatekeeper constraint to block latest tag
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequireImageDigestOrSemver
metadata:
  name: require-immutable-image-tags
spec:
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Pod"]
  parameters:
    exemptImages:
      - "gcr.io/google-containers/pause:*"
```

Also set `imagePullPolicy: Always` for mutable tags and `IfNotPresent` for immutable ones:

```yaml
image: registry.example.com/myapp:v1.2.3
imagePullPolicy: IfNotPresent  # Correct for immutable tags - avoids unnecessary pulls
```

## Anti-Pattern 3: Misconfigured Liveness Probes

Liveness probes that are too aggressive, or that check external dependencies, cause pod restart loops that look like application bugs.

### Why It Fails

```yaml
# ANTI-PATTERN 1: Liveness checks an external dependency
livenessProbe:
  httpGet:
    path: /health  # This endpoint calls the database
    port: 8080
  failureThreshold: 3
  periodSeconds: 10
```

If the database goes down, pods restart in a loop. The application is healthy but Kubernetes keeps killing it, making the database outage worse.

```yaml
# ANTI-PATTERN 2: Too aggressive liveness probe
livenessProbe:
  httpGet:
    path: /live
    port: 8080
  initialDelaySeconds: 5   # App may not be ready in 5 seconds
  failureThreshold: 1      # One failure = restart
  periodSeconds: 5         # Checks every 5 seconds
  timeoutSeconds: 1        # 1 second is too short for slow responses
```

A slow GC pause causes a timeout, triggers a restart, which causes more pressure.

### The Fix

Separate liveness, readiness, and startup probes with correct semantics:

- **Liveness**: Is the application process alive and not deadlocked? Check only internal state, never external dependencies.
- **Readiness**: Can this pod serve traffic right now? Check internal state AND critical dependencies (database, cache).
- **Startup**: Has the application finished initialization? Use this for slow-starting apps.

```yaml
# CORRECT: Properly separated probes
startupProbe:
  httpGet:
    path: /startup  # Returns 200 only after initialization
    port: 8080
  failureThreshold: 30
  periodSeconds: 10
  # 30 * 10s = 300 seconds for startup before restart

livenessProbe:
  httpGet:
    path: /live     # Returns 200 if process is alive and not deadlocked
    port: 8080
  initialDelaySeconds: 0  # startupProbe handles the delay
  periodSeconds: 15
  failureThreshold: 3
  timeoutSeconds: 5
  # Only restarts after 3 consecutive failures over 45 seconds

readinessProbe:
  httpGet:
    path: /ready    # Returns 200 if ready to receive traffic (can check DB)
    port: 8080
  periodSeconds: 5
  failureThreshold: 3
  successThreshold: 1
  timeoutSeconds: 3
```

Application-level health check implementation:

```go
// Liveness: only checks that the process is healthy, not dependencies
func livenessHandler(w http.ResponseWriter, r *http.Request) {
    // Check internal state: is the goroutine pool alive? Is the work queue draining?
    if isInternallyHealthy() {
        w.WriteHeader(http.StatusOK)
    } else {
        w.WriteHeader(http.StatusServiceUnavailable)
    }
}

// Readiness: checks dependencies but does NOT restart the pod on failure
func readinessHandler(w http.ResponseWriter, r *http.Request) {
    ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
    defer cancel()

    if err := db.PingContext(ctx); err != nil {
        w.WriteHeader(http.StatusServiceUnavailable)
        fmt.Fprintf(w, "database unavailable: %v", err)
        return
    }

    if err := cache.Ping(ctx); err != nil {
        w.WriteHeader(http.StatusServiceUnavailable)
        fmt.Fprintf(w, "cache unavailable: %v", err)
        return
    }

    w.WriteHeader(http.StatusOK)
}
```

## Anti-Pattern 4: No Pod Disruption Budget

```yaml
# ANTI-PATTERN: Deployment with no PDB
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-api
spec:
  replicas: 3
  # No PodDisruptionBudget created
```

### Why It Fails

During node drains (upgrades, maintenance), Kubernetes evicts pods without regard for service availability. With 3 replicas and no PDB, all 3 can be evicted simultaneously, causing a complete service outage during a rolling upgrade.

### The Fix

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payment-api-pdb
spec:
  minAvailable: 2  # Always keep at least 2 pods running
  selector:
    matchLabels:
      app: payment-api
```

Or using `maxUnavailable`:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payment-api-pdb
spec:
  maxUnavailable: 1  # At most 1 pod can be unavailable at a time
  selector:
    matchLabels:
      app: payment-api
```

Guidelines:
- For services with 1 replica: `maxUnavailable: 0` (PDB will block drain until replica count increases)
- For services with 2-3 replicas: `minAvailable: 1` or `maxUnavailable: 1`
- For services with 5+ replicas: `maxUnavailable: 20%`
- For critical services: `minAvailable: 2` regardless of total replicas

## Anti-Pattern 5: Hardcoded Configuration and Secrets

```yaml
# ANTI-PATTERN: Secrets in environment variables from literal values in the Deployment
env:
  - name: DATABASE_PASSWORD
    value: "actualpassword123"   # Hardcoded in manifest
  - name: API_KEY
    value: "sk-1234567890abcdef" # Hardcoded in manifest
```

### Why It Fails

- Secrets in manifests get committed to Git (even private repos can be exfiltrated)
- No rotation capability: changing a secret requires a deployment
- No audit trail for secret access
- Violates the 12-factor app principle

### The Fix

Use Kubernetes Secrets with proper injection:

```yaml
# CORRECT: Secret reference (still store the Secret in Vault/ESO, not Git)
env:
  - name: DATABASE_PASSWORD
    valueFrom:
      secretKeyRef:
        name: database-credentials
        key: password
  - name: API_KEY
    valueFrom:
      secretKeyRef:
        name: external-api-credentials
        key: api-key

# Or mount as files
volumeMounts:
  - name: secrets-volume
    mountPath: /etc/secrets
    readOnly: true
volumes:
  - name: secrets-volume
    secret:
      secretName: application-secrets
      defaultMode: 0400
```

Use External Secrets Operator to sync from Vault or AWS Secrets Manager:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: payment-service-secrets
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: vault-secret-store
    kind: SecretStore
  target:
    name: payment-service-secrets
    creationPolicy: Owner
  data:
    - secretKey: database-password
      remoteRef:
        key: secret/payments/database
        property: password
    - secretKey: api-key
      remoteRef:
        key: secret/payments/external-api
        property: key
```

## Anti-Pattern 6: Single Replica with No Anti-Affinity

```yaml
# ANTI-PATTERN: Single replica without affinity rules
spec:
  replicas: 1
  # No affinity/anti-affinity rules
```

Even with `replicas: 2`, if both pods land on the same node, a node failure takes down the service.

### The Fix

```yaml
spec:
  replicas: 3
  template:
    spec:
      # Prefer spreading across nodes
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: payment-api
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels:
              app: payment-api

      # Hard anti-affinity: never put two of the same pod on the same node
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchExpressions:
                  - key: app
                    operator: In
                    values:
                      - payment-api
              topologyKey: kubernetes.io/hostname
```

Use `requiredDuringSchedulingIgnoredDuringExecution` only if you are confident there are always enough nodes. For flexibility, use `preferredDuringSchedulingIgnoredDuringExecution`.

## Anti-Pattern 7: Ignoring Graceful Shutdown

```yaml
# ANTI-PATTERN: No terminationGracePeriodSeconds, no SIGTERM handler
spec:
  terminationGracePeriodSeconds: 30  # This is the default, but often ignored
  containers:
    - name: api
      image: myapp:v1.2.3
      # Application ignores SIGTERM and processes die mid-request
```

### Why It Fails

Kubernetes sends SIGTERM to containers before SIGKILL (with a grace period). If the application does not handle SIGTERM gracefully, in-flight requests fail, database connections are left open, and queued work is lost.

### The Fix

Application must handle SIGTERM:

```go
package main

import (
    "context"
    "log"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"
)

func main() {
    server := &http.Server{
        Addr:    ":8080",
        Handler: buildRouter(),
    }

    // Channel to receive OS signals
    sigChan := make(chan os.Signal, 1)
    signal.Notify(sigChan, syscall.SIGTERM, syscall.SIGINT)

    // Start server in goroutine
    go func() {
        if err := server.ListenAndServe(); err != http.ErrServerClosed {
            log.Fatalf("server error: %v", err)
        }
    }()

    // Wait for shutdown signal
    sig := <-sigChan
    log.Printf("received signal %v, initiating graceful shutdown", sig)

    // Stop accepting new connections; wait for in-flight requests
    ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
    defer cancel()

    if err := server.Shutdown(ctx); err != nil {
        log.Printf("graceful shutdown failed: %v", err)
    }

    // Close database connections, flush queues, etc.
    if err := closeDatabase(); err != nil {
        log.Printf("database close failed: %v", err)
    }

    log.Println("shutdown complete")
}
```

In the Kubernetes manifest, add a preStop hook to delay SIGTERM during endpoint deregistration:

```yaml
lifecycle:
  preStop:
    exec:
      command: ["/bin/sh", "-c", "sleep 5"]
# This sleep allows the Service endpoint to be removed
# from all kube-proxy iptables rules before SIGTERM is sent
terminationGracePeriodSeconds: 60
# Total grace period > preStop sleep + max request duration
```

## Anti-Pattern 8: Deploying without Rolling Update Configuration

```yaml
# ANTI-PATTERN: Default rolling update with no tuning
spec:
  strategy:
    type: RollingUpdate
    # No maxUnavailable / maxSurge specified
    # Defaults: maxUnavailable=25%, maxSurge=25%
```

With `replicas: 2` and default settings, `maxUnavailable: 25%` rounds to 0 and `maxSurge: 25%` rounds to 1, so the rollout creates one new pod before taking down the old one. This is usually fine, but for small replica counts it is worth being explicit.

### The Fix

```yaml
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0     # Never reduce capacity during rollout
      maxSurge: 1           # Add one pod at a time (conservative)
```

For faster rollouts on larger deployments:

```yaml
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxUnavailable: 0       # Zero downtime
    maxSurge: 3             # Surge 3 pods at a time for faster rollout
```

Also set a `minReadySeconds` to ensure new pods are actually healthy before marking them ready:

```yaml
spec:
  minReadySeconds: 10  # Pod must be ready for 10s before counting as available
```

## Anti-Pattern 9: No Namespace Resource Quotas

Teams often deploy to shared namespaces without quotas. One misbehaving deployment can exhaust cluster resources.

```yaml
# ANTI-PATTERN: Namespace with no ResourceQuota
# Any deployment can consume unlimited cluster resources
```

### The Fix

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: payments-quota
  namespace: payments
spec:
  hard:
    # Compute resources
    requests.cpu: "8"
    requests.memory: 16Gi
    limits.cpu: "16"
    limits.memory: 32Gi

    # Object count limits
    pods: "50"
    services: "10"
    secrets: "50"
    configmaps: "50"
    persistentvolumeclaims: "10"

    # LoadBalancer services are expensive
    services.loadbalancers: "2"
    services.nodeports: "0"
---
apiVersion: v1
kind: LimitRange
metadata:
  name: payments-limits
  namespace: payments
spec:
  limits:
    - type: Container
      default:           # Applied if no limits specified
        cpu: 200m
        memory: 256Mi
      defaultRequest:    # Applied if no requests specified
        cpu: 50m
        memory: 64Mi
      max:               # Maximum allowed
        cpu: "4"
        memory: 4Gi
      min:               # Minimum allowed
        cpu: 10m
        memory: 16Mi
    - type: PersistentVolumeClaim
      max:
        storage: 50Gi
```

## Anti-Pattern 10: Missing NetworkPolicy (Zero Trust Ignored)

```yaml
# ANTI-PATTERN: No NetworkPolicy
# All pods can communicate with all other pods cluster-wide
```

### Why It Fails

A compromised pod can freely communicate with any service in the cluster. PCI-DSS, SOC2, and HIPAA compliance require network segmentation.

### The Fix

Start with a deny-all policy, then add explicit allows:

```yaml
# Deny all ingress and egress by default
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: payments
spec:
  podSelector: {}  # Applies to all pods in namespace
  policyTypes:
    - Ingress
    - Egress
---
# Allow payments API to receive traffic from ingress controller
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-ingress-to-payments-api
  namespace: payments
spec:
  podSelector:
    matchLabels:
      app: payments-api
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ingress-nginx
          podSelector:
            matchLabels:
              app.kubernetes.io/name: ingress-nginx
      ports:
        - port: 8080
---
# Allow payments API to reach database
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-payments-api-to-db
  namespace: payments
spec:
  podSelector:
    matchLabels:
      app: payments-database
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: payments-api
      ports:
        - port: 5432
---
# Allow DNS egress for all pods (required for service discovery)
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns-egress
  namespace: payments
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
```

## Anti-Pattern 11: Storing State in a Deployment

```yaml
# ANTI-PATTERN: Using Deployment for stateful workloads that need stable storage
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: postgres
          image: postgres:15
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
      volumes:
        - name: data
          emptyDir: {}  # Data lost on pod restart!
```

### Why It Fails

- `emptyDir` volumes are lost when pods are rescheduled
- Deployment pods get random names, breaking identity-based clustering
- No stable network identity for peer discovery in clustered databases
- Rolling updates on databases can cause data loss

### The Fix

Use `StatefulSet` for stateful workloads:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
spec:
  serviceName: postgres  # Headless service for stable DNS
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
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
          volumeMounts:
            - name: postgres-data
              mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
    - metadata:
        name: postgres-data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: gp3
        resources:
          requests:
            storage: 50Gi
---
# Headless service for stable DNS
apiVersion: v1
kind: Service
metadata:
  name: postgres
spec:
  clusterIP: None  # Headless
  selector:
    app: postgres
  ports:
    - port: 5432
```

## Anti-Pattern 12: Unvalidated ConfigMaps and Secrets in Deployments

```yaml
# ANTI-PATTERN: ConfigMap mounted as env without validation
envFrom:
  - configMapRef:
      name: app-config
      # optional: false (default) - pod fails if ConfigMap doesn't exist
```

If the ConfigMap or Secret does not exist, the pod enters `CreateContainerConfigError` and never starts. Even if it exists, a typo in a key name causes silent misconfiguration.

### The Fix

```yaml
# Always specify optional for non-critical configs
envFrom:
  - configMapRef:
      name: app-config
      optional: false  # Explicit: fail fast if missing
  - secretRef:
      name: app-secrets
      optional: false  # Explicit: fail fast if missing

# For individual env vars, use valueFrom with explicit keys
env:
  - name: LOG_LEVEL
    valueFrom:
      configMapKeyRef:
        name: app-config
        key: log_level
        optional: false
```

Also validate ConfigMaps in CI using kubeconform or kyverno policies before deploying:

```bash
# Validate all manifests before deployment
kubeconform -schema-location default \
  -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
  -summary \
  k8s/manifests/
```

## Summary: Deployment Readiness Checklist

Use this checklist for every new service going to production:

```markdown
## Resource Configuration
- [ ] CPU and memory requests set (based on VPA recommendation or benchmarks)
- [ ] CPU and memory limits set (memory limit ≤ 2x request for stable services)
- [ ] No `latest` image tag used anywhere

## Availability
- [ ] Minimum 2 replicas for all services (3+ for critical)
- [ ] PodDisruptionBudget configured
- [ ] topologySpreadConstraints or podAntiAffinity configured
- [ ] RollingUpdate strategy explicitly configured (not default)
- [ ] minReadySeconds set

## Health Checks
- [ ] startupProbe configured for slow-starting apps
- [ ] livenessProbe checks only internal health (no external deps)
- [ ] readinessProbe checks actual service readiness
- [ ] All probe timeouts and failure thresholds explicitly set

## Graceful Shutdown
- [ ] Application handles SIGTERM gracefully
- [ ] preStop hook adds sleep for endpoint deregistration
- [ ] terminationGracePeriodSeconds > preStop sleep + max request duration

## Security
- [ ] No hardcoded secrets in manifests
- [ ] Secrets managed via ExternalSecrets or Vault Agent
- [ ] NetworkPolicy applied (default deny + explicit allows)
- [ ] SecurityContext set (runAsNonRoot, readOnlyRootFilesystem)
- [ ] No privileged containers unless required

## Operations
- [ ] Namespace ResourceQuota configured
- [ ] LimitRange with sensible defaults set
- [ ] StatefulSet used for stateful workloads (not Deployment)
- [ ] ConfigMap/Secret references validated in CI
```

These patterns are not theoretical concerns. Each one has caused production incidents at scale. Building them into your deployment standards prevents the class of failures they represent.
