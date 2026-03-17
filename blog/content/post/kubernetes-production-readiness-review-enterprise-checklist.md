---
title: "Kubernetes Production Readiness Review: Checklist for Enterprise Workloads"
date: 2031-03-20T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Production", "Security", "Reliability", "SRE", "Enterprise"]
categories:
- Kubernetes
- SRE
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive Kubernetes production readiness checklist: resource requests/limits, PodDisruptionBudgets, liveness/readiness/startup probe tuning, security context hardening, network policies, image scanning gates, and runbook integration."
more_link: "yes"
url: "/kubernetes-production-readiness-review-enterprise-checklist/"
---

Production readiness reviews (PRRs) are the systematic checkpoint between a working application and one that can be operated safely at scale. In Kubernetes environments, the failure modes are subtle and often only surface during cluster upgrades, traffic spikes, or partial outages. A team that confidently passed a demo during development may discover their application has no resource limits, liveness probes that restart healthy pods under load, or no PodDisruptionBudget that prevents voluntary disruption during node drainage. This guide provides a comprehensive PRR checklist with implementation examples for each category, designed for platform engineering teams to apply consistently across workloads.

<!--more-->

# Kubernetes Production Readiness Review: Checklist for Enterprise Workloads

## Section 1: Resource Requests and Limits

Resource configuration is the single most common source of cluster instability. Applications without requests prevent the scheduler from making good placement decisions. Applications without limits can consume unbounded resources and starve neighbors.

### The Three States of Resource Configuration

**No requests, no limits (worst):** The scheduler treats these Pods as having zero resource consumption. They pack onto any node and can use all available resources, causing OOM kills and CPU throttling that affect all other workloads on the node.

**Requests but no limits (common mistake):** Better - the scheduler can make reasonable placement decisions. But a runaway process or memory leak will consume all available node resources.

**Requests equal limits (best for predictability):** The Pod is placed in the Guaranteed QoS class. The scheduler allocates exactly the specified resources and the container is never CPU-throttled below its request. This is the recommended production configuration.

### Setting Requests and Limits

```yaml
# Good: Requests and limits set, with limits >= requests
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-service
spec:
  template:
    spec:
      containers:
      - name: api
        image: myregistry/api-service:1.0.0
        resources:
          requests:
            cpu: "500m"       # Half a CPU core minimum
            memory: "512Mi"   # 512MB minimum
          limits:
            cpu: "2000m"      # 2 CPU cores maximum
            memory: "1Gi"     # 1GB maximum (never exceed)

        # For Java/JVM applications: add memory headroom for JVM overhead
        # JVM heap + JVM overhead (threads, JIT) typically requires
        # 20-50% more than heap size
        # If -Xmx512m: request ~640Mi, limit ~896Mi
```

### QoS Class Impact on Eviction

```yaml
# Guaranteed QoS: requests == limits
# These Pods are the LAST to be evicted under memory pressure
resources:
  requests:
    cpu: "500m"
    memory: "512Mi"
  limits:
    cpu: "500m"   # Same as request
    memory: "512Mi"  # Same as request

# Burstable QoS: requests < limits OR only one is set
# Evicted after BestEffort but before Guaranteed
resources:
  requests:
    cpu: "100m"
    memory: "128Mi"
  limits:
    cpu: "1000m"
    memory: "512Mi"

# BestEffort QoS: NO requests OR limits
# First to be evicted under memory pressure
# Never use in production
resources: {}  # This is BestEffort - NEVER do this in production
```

### Validating Resource Configuration

```bash
# Find pods without resource limits
kubectl get pods -A -o json | jq '
  .items[] |
  select(.spec.containers[].resources.limits == null) |
  {namespace: .metadata.namespace, name: .metadata.name}'

# Find pods without resource requests
kubectl get pods -A -o json | jq '
  .items[] |
  select(.spec.containers[].resources.requests == null) |
  {namespace: .metadata.namespace, name: .metadata.name}'

# Check QoS class for each pod
kubectl get pods -A -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,QOS:.status.qosClass'

# Find BestEffort pods (danger!)
kubectl get pods -A -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,QOS:.status.qosClass' | grep BestEffort
```

### Admission Webhook to Enforce Resources

```yaml
# OPA Gatekeeper constraint to require resource limits
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: requiredresources
spec:
  crd:
    spec:
      names:
        kind: RequiredResources
  targets:
  - target: admission.k8s.gatekeeper.sh
    rego: |
      package requiredresources

      violation[{"msg": msg}] {
        container := input.review.object.spec.containers[_]
        not container.resources.limits
        msg := sprintf("Container '%v' has no resource limits defined", [container.name])
      }

      violation[{"msg": msg}] {
        container := input.review.object.spec.containers[_]
        not container.resources.requests
        msg := sprintf("Container '%v' has no resource requests defined", [container.name])
      }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: RequiredResources
metadata:
  name: require-container-resources
spec:
  enforcementAction: deny
  match:
    kinds:
    - apiGroups: ["apps"]
      kinds: ["Deployment", "StatefulSet", "DaemonSet"]
    namespaces:
    - production
    - staging
```

## Section 2: PodDisruptionBudgets

PodDisruptionBudgets (PDBs) protect applications from voluntary disruptions during:
- Node drains for maintenance or upgrades
- Cluster autoscaler scale-down operations
- Manual pod deletions during deployments

Without a PDB, a node drain can take all replicas of your application offline simultaneously.

### PDB Implementation

```yaml
# For a deployment with 3+ replicas: always keep at least 2 available
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-service-pdb
  namespace: production
spec:
  minAvailable: 2  # At least 2 pods must be available at all times
  selector:
    matchLabels:
      app: api-service

---
# Alternative: use maxUnavailable
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: web-frontend-pdb
  namespace: production
spec:
  maxUnavailable: 1  # At most 1 pod can be unavailable at any time
  selector:
    matchLabels:
      app: web-frontend

---
# For single-replica deployments: be explicit about accepting disruption
# (You CANNOT use minAvailable: 1 with a single replica - it will block drains)
# For critical single-replica services, consider minAvailable: 0 with alerting
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: singleton-pdb
  namespace: production
spec:
  maxUnavailable: 0  # CAUTION: This will block all node drains!
  # Only use this if the service is truly critical and can handle brief interruption
  # through other means (reconnect logic, circuit breakers in clients)
  selector:
    matchLabels:
      app: critical-singleton
```

### PDB Anti-Patterns

```bash
# Find services without PDBs
kubectl get deployments -n production -o json | jq -r '.items[].metadata.name' | \
  while read dep; do
    pdb=$(kubectl get pdb -n production -o json | \
      jq --arg app "$dep" '.items[] | select(.spec.selector.matchLabels.app == $app) | .metadata.name')
    if [ -z "$pdb" ]; then
      echo "NO PDB: $dep"
    fi
  done

# Test that a PDB is effective (simulate drain)
kubectl drain --dry-run=client <node-name> --ignore-daemonsets

# Check PDB status
kubectl get pdb -n production
# NAME              MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS   AGE
# api-service-pdb   2               N/A               1                     30d
# web-frontend-pdb  N/A             1                 1                     30d
```

### PDB for StatefulSets

StatefulSets with ordered rolling updates need careful PDB configuration:

```yaml
# StatefulSet with 3 replicas: allow rolling update without blocking
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: postgres-pdb
  namespace: production
spec:
  maxUnavailable: 1  # Allow rolling update to proceed
  selector:
    matchLabels:
      app: postgres

# The StatefulSet should also configure proper update strategy
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
spec:
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1  # Matches PDB's maxUnavailable
  podManagementPolicy: OrderedReady  # Wait for each pod to be ready before next
```

## Section 3: Probe Configuration

Probes are the most common source of reliability regressions in Kubernetes. Misconfigured probes cause:
- Healthy pods restarted during traffic spikes (liveness probe false positive)
- Traffic sent to pods before they're ready (readiness probe too optimistic)
- Slow startup pods killed before they finish initializing (missing startup probe)

### The Three Probe Types

**Liveness probe:** "Is the application still functioning? If not, restart it."
Should only fail if the application is genuinely in an unrecoverable state. Should NOT fail during high load.

**Readiness probe:** "Is the application ready to accept traffic? If not, remove it from the Service endpoint."
Should fail whenever the application cannot serve requests (not initialized yet, dependencies unavailable, temporarily overloaded).

**Startup probe:** "Is the application finished starting up?"
Blocks liveness and readiness checks until the startup probe succeeds. Critical for slow-starting applications.

### Production Probe Configuration

```yaml
spec:
  containers:
  - name: api-service
    image: myregistry/api-service:1.0.0

    # Startup probe: allow up to 5 minutes for startup
    # (30 * 10 = 300 seconds = 5 minutes)
    startupProbe:
      httpGet:
        path: /health/startup  # Distinct endpoint from liveness/readiness
        port: 8080
      # For database-heavy apps that run migrations:
      failureThreshold: 30    # 30 consecutive failures before giving up
      periodSeconds: 10       # Check every 10 seconds
      # Total allowed startup time = failureThreshold * periodSeconds = 300s
      timeoutSeconds: 5       # Each check must respond within 5s

    # Liveness probe: detect and recover from deadlocks/corruption
    # IMPORTANT: Set generous thresholds to avoid killing healthy pods under load
    livenessProbe:
      httpGet:
        path: /health/live    # Should check: is the app responsive? NOT dependencies
        port: 8080
      # Only fail after 3 consecutive misses at 30-second intervals = 90 seconds
      failureThreshold: 3
      periodSeconds: 30       # Check every 30 seconds (not too frequent)
      initialDelaySeconds: 0  # With startupProbe, this can be 0
      timeoutSeconds: 10      # Give the app time to respond under load
      successThreshold: 1     # One success to restore liveness

    # Readiness probe: remove from load balancer when not ready
    # Can be more aggressive than liveness - failing readiness doesn't restart the pod
    readinessProbe:
      httpGet:
        path: /health/ready   # Check: are dependencies available? Am I warmed up?
        port: 8080
      failureThreshold: 3
      periodSeconds: 10       # Check every 10 seconds
      initialDelaySeconds: 0  # With startupProbe, this can be 0
      timeoutSeconds: 5
      successThreshold: 1
```

### Implementing Health Check Endpoints

```go
package health

import (
    "context"
    "net/http"
    "sync/atomic"
    "time"
)

// HealthServer provides the three health endpoints for Kubernetes probes.
type HealthServer struct {
    // started is set to 1 when startup is complete
    started atomic.Int32
    // ready is set to 0 when the service is temporarily unavailable
    ready atomic.Int32
    // Dependencies to check for readiness
    checks []HealthCheck
}

type HealthCheck struct {
    Name    string
    Check   func(ctx context.Context) error
    Timeout time.Duration
}

func NewHealthServer(checks []HealthCheck) *HealthServer {
    h := &HealthServer{checks: checks}
    h.ready.Store(1)
    return h
}

// SetStarted marks startup as complete. Call this after initialization.
func (h *HealthServer) SetStarted() {
    h.started.Store(1)
}

// SetReady can be called by application logic to temporarily take the service
// out of load balancer rotation without restarting.
func (h *HealthServer) SetReady(ready bool) {
    if ready {
        h.ready.Store(1)
    } else {
        h.ready.Store(0)
    }
}

// StartupHandler responds to the startup probe.
// Returns 200 once SetStarted() has been called.
func (h *HealthServer) StartupHandler(w http.ResponseWriter, r *http.Request) {
    if h.started.Load() == 1 {
        w.WriteHeader(http.StatusOK)
        w.Write([]byte("started"))
        return
    }
    w.WriteHeader(http.StatusServiceUnavailable)
    w.Write([]byte("starting"))
}

// LivenessHandler responds to the liveness probe.
// Should only fail for truly unrecoverable conditions.
// Note: We do NOT check external dependencies here - that would cause
// cascading restarts if a database goes down.
func (h *HealthServer) LivenessHandler(w http.ResponseWriter, r *http.Request) {
    // Check only internal application state
    // e.g., goroutine deadlock detection, memory sanity
    if h.started.Load() == 0 {
        // Still starting up - liveness should not fail during startup
        // (startupProbe should be blocking this check)
        w.WriteHeader(http.StatusOK)
        w.Write([]byte("starting"))
        return
    }
    w.WriteHeader(http.StatusOK)
    w.Write([]byte("alive"))
}

// ReadinessHandler responds to the readiness probe.
// Checks external dependencies and returns 503 if the service cannot handle requests.
func (h *HealthServer) ReadinessHandler(w http.ResponseWriter, r *http.Request) {
    if h.started.Load() == 0 {
        w.WriteHeader(http.StatusServiceUnavailable)
        w.Write([]byte("starting"))
        return
    }

    if h.ready.Load() == 0 {
        w.WriteHeader(http.StatusServiceUnavailable)
        w.Write([]byte("not ready"))
        return
    }

    // Check dependencies with timeout
    ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
    defer cancel()

    for _, check := range h.checks {
        checkCtx, checkCancel := context.WithTimeout(ctx, check.Timeout)
        if err := check.Check(checkCtx); err != nil {
            checkCancel()
            w.WriteHeader(http.StatusServiceUnavailable)
            w.Write([]byte("dependency: " + check.Name + " unavailable"))
            return
        }
        checkCancel()
    }

    w.WriteHeader(http.StatusOK)
    w.Write([]byte("ready"))
}

func (h *HealthServer) Register(mux *http.ServeMux) {
    mux.HandleFunc("/health/startup", h.StartupHandler)
    mux.HandleFunc("/health/live", h.LivenessHandler)
    mux.HandleFunc("/health/ready", h.ReadinessHandler)
}
```

### Probe Anti-Patterns to Avoid

```yaml
# ANTI-PATTERN 1: Liveness probe checking external dependencies
# If the database goes down, ALL pods restart simultaneously
livenessProbe:
  httpGet:
    path: /health/live  # BAD if this path queries the database
    port: 8080

# ANTI-PATTERN 2: Identical liveness and readiness endpoints
# The semantics are different - don't reuse the same endpoint
livenessProbe:
  httpGet:
    path: /health      # BAD: same endpoint for both
    port: 8080
readinessProbe:
  httpGet:
    path: /health      # BAD: same endpoint for both
    port: 8080

# ANTI-PATTERN 3: Aggressive liveness probe thresholds
livenessProbe:
  httpGet:
    path: /health/live
    port: 8080
  failureThreshold: 1  # BAD: one timeout/slow response = restart
  periodSeconds: 5     # BAD: checking too frequently
  timeoutSeconds: 1    # BAD: 1 second too aggressive for GC pauses or cold starts

# ANTI-PATTERN 4: Slow application with no startup probe
# The liveness probe kills it before it finishes starting
livenessProbe:
  httpGet:
    path: /health/live
    port: 8080
  initialDelaySeconds: 30  # BAD: fixed delay, may be too short or too long
  failureThreshold: 3      # BAD: will restart if startup takes > 30+3*10=60s
  periodSeconds: 10
# MISSING: startupProbe
```

## Section 4: Security Context Hardening

### Mandatory Security Context Fields

```yaml
spec:
  # Pod-level security context
  securityContext:
    # Run as non-root user
    runAsNonRoot: true
    runAsUser: 65534   # "nobody" user
    runAsGroup: 65534  # "nobody" group
    fsGroup: 65534     # Files created by containers have this group
    # Prevent privilege escalation attacks
    seccompProfile:
      type: RuntimeDefault  # Use the container runtime's default seccomp profile
    # Linux supplemental groups
    supplementalGroups: []

  containers:
  - name: api
    # Container-level security context (overrides pod-level for this container)
    securityContext:
      # MUST: Cannot become root even if the image user is root
      runAsNonRoot: true
      # MUST: Prevent privilege escalation via setuid/setgid
      allowPrivilegeEscalation: false
      # MUST: Drop all capabilities, add only what's needed
      capabilities:
        drop:
        - ALL
        add:
        - NET_BIND_SERVICE  # Only if the container needs to bind port < 1024
      # Recommended: Read-only root filesystem
      readOnlyRootFilesystem: true
      # Recommended: Seccomp profile
      seccompProfile:
        type: RuntimeDefault

    # If using readOnlyRootFilesystem, mount writable volumes for required paths
    volumeMounts:
    - name: tmp-dir
      mountPath: /tmp
    - name: cache-dir
      mountPath: /var/cache/app
    - name: run-dir
      mountPath: /var/run/app

  volumes:
  - name: tmp-dir
    emptyDir: {}
  - name: cache-dir
    emptyDir:
      sizeLimit: 1Gi  # Limit cache directory size
  - name: run-dir
    emptyDir:
      medium: Memory  # In-memory filesystem for PID files, sockets
```

### Pod Security Standards

```yaml
# Enforce restricted PSS at namespace level
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    # Enforce: Reject non-compliant pods
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: latest
    # Audit: Log non-compliant pods
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: latest
    # Warn: Show warnings for non-compliant pods
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: latest
```

### ServiceAccount Configuration

```yaml
# Create a dedicated ServiceAccount per application
apiVersion: v1
kind: ServiceAccount
metadata:
  name: api-service
  namespace: production
  annotations:
    # For AWS IRSA (IAM Roles for Service Accounts)
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789:role/api-service-role
automountServiceAccountToken: false  # Disable unless needed for K8s API access

---
# Only grant minimum required RBAC permissions
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: api-service
  namespace: production
rules:
- apiGroups: [""]
  resources: ["configmaps"]
  resourceNames: ["api-service-config"]  # Specific resource, not all configmaps
  verbs: ["get", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: api-service
  namespace: production
subjects:
- kind: ServiceAccount
  name: api-service
  namespace: production
roleRef:
  kind: Role
  apiRef: api-service
  apiGroup: rbac.authorization.k8s.io
```

### Secret Management Best Practices

```yaml
# Never commit secrets to git. Use ExternalSecrets to pull from Vault/ASM
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: api-service-secrets
  namespace: production
spec:
  refreshInterval: 5m
  secretStoreRef:
    kind: ClusterSecretStore
    name: vault-backend
  target:
    name: api-service-secrets
    creationPolicy: Owner
    deletionPolicy: Retain
  data:
  - secretKey: DATABASE_PASSWORD
    remoteRef:
      key: secret/production/api-service
      property: database_password
  - secretKey: API_KEY
    remoteRef:
      key: secret/production/api-service
      property: api_key
```

## Section 5: Network Policy Coverage

### Default Deny Policy

```yaml
# Start with deny-all and explicitly allow required traffic
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: production
spec:
  podSelector: {}  # Apply to all pods in namespace
  policyTypes:
  - Ingress
  - Egress
  # No ingress or egress rules = deny all
```

### Application-Specific Policies

```yaml
# Allow ingress from ingress controller and Prometheus
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-service-ingress
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: api-service
  policyTypes:
  - Ingress
  ingress:
  # Allow from ingress controller
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: ingress-nginx
      podSelector:
        matchLabels:
          app.kubernetes.io/name: ingress-nginx
    ports:
    - protocol: TCP
      port: 8080
  # Allow from Prometheus for metrics scraping
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: monitoring
      podSelector:
        matchLabels:
          app.kubernetes.io/name: prometheus
    ports:
    - protocol: TCP
      port: 9090  # Metrics port

---
# Allow egress to required dependencies only
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-service-egress
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: api-service
  policyTypes:
  - Egress
  egress:
  # DNS resolution (required for all pods)
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
    ports:
    - protocol: UDP
      port: 53
    - protocol: TCP
      port: 53
  # Allow to database namespace
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: databases
      podSelector:
        matchLabels:
          app: postgres
    ports:
    - protocol: TCP
      port: 5432
  # Allow to external HTTPS (if needed)
  - to:
    - ipBlock:
        cidr: 0.0.0.0/0
        except:
        - 10.0.0.0/8      # Internal subnets
        - 172.16.0.0/12
        - 192.168.0.0/16
    ports:
    - protocol: TCP
      port: 443
```

### Verifying Network Policy Effectiveness

```bash
# Test that policy is working
kubectl run test-pod --image=busybox -n production --rm -it -- \
  wget -O- http://postgres.databases.svc.cluster.local:5432 2>&1
# Should succeed (allowed)

kubectl run test-pod --image=busybox -n production --rm -it -- \
  wget -O- http://redis.databases.svc.cluster.local:6379 2>&1
# Should fail (not in egress policy)

# Use network policy visualizer
kubectl get networkpolicies -n production -o json | \
  python3 -c "
import json, sys
policies = json.load(sys.stdin)
for p in policies['items']:
    print(f'Policy: {p[\"metadata\"][\"name\"]}')
    print(f'  Applies to: {p[\"spec\"][\"podSelector\"]}')
    print(f'  Types: {p[\"spec\"][\"policyTypes\"]}')
"
```

## Section 6: Image Scanning and Supply Chain Security

### Container Image Scanning Gate

```yaml
# Kyverno policy: require image vulnerability scan before deployment
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-image-scan
spec:
  validationFailureAction: Enforce
  background: false
  rules:
  - name: check-image-scan
    match:
      any:
      - resources:
          kinds:
          - Pod
          namespaces:
          - production
          - staging
    validate:
      message: "Images must be scanned and have no critical vulnerabilities. Check image scan report for {{ request.object.spec.containers[].image }}"
      pattern:
        spec:
          containers:
          - image: "myregistry.example.com/*"  # Require approved registry
```

### Trivy Integration in CI/CD

```yaml
# GitHub Actions: fail on critical vulnerabilities
name: Container Security Scan

on:
  push:
    branches: [main]

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4

    - name: Build image
      run: docker build -t myapp:${{ github.sha }} .

    - name: Run Trivy vulnerability scanner
      uses: aquasecurity/trivy-action@master
      with:
        image-ref: 'myapp:${{ github.sha }}'
        format: 'sarif'
        output: 'trivy-results.sarif'
        exit-code: '1'           # Fail the build on vulnerabilities
        ignore-unfixed: true      # Allow unfixed vulnerabilities (no patch available)
        vuln-type: 'os,library'
        severity: 'CRITICAL,HIGH' # Fail on CRITICAL and HIGH only

    - name: Upload Trivy scan results to GitHub Security
      uses: github/codeql-action/upload-sarif@v3
      if: always()
      with:
        sarif_file: 'trivy-results.sarif'
```

### Image Policy Admission

```yaml
# Use Connaisseur or Kyverno for image signing verification
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-image-signature
spec:
  validationFailureAction: Enforce
  background: false
  rules:
  - name: verify-cosign-signature
    match:
      any:
      - resources:
          kinds:
          - Pod
          namespaces:
          - production
    verifyImages:
    - imageReferences:
      - "myregistry.example.com/*"
      attestors:
      - count: 1
        entries:
        - keys:
            publicKeys: |-
              -----BEGIN PUBLIC KEY-----
              # Your Cosign public key here (this is a placeholder, not a real key)
              -----END PUBLIC KEY-----
```

## Section 7: Graceful Shutdown and Drain Handling

### preStop Hooks and terminationGracePeriodSeconds

```yaml
spec:
  # Give the container 60 seconds to shut down gracefully
  terminationGracePeriodSeconds: 60

  containers:
  - name: api
    lifecycle:
      preStop:
        exec:
          command:
          - /bin/sh
          - -c
          - |
            # Ensure in-flight requests complete
            # This runs BEFORE SIGTERM is sent
            sleep 5  # Allow load balancer to remove pod from rotation

            # For more complex cleanup:
            # curl -X POST http://localhost:8080/admin/shutdown
```

### Application-Level Graceful Shutdown

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
    srv := &http.Server{
        Addr:    ":8080",
        Handler: setupRoutes(),
    }

    // Channel for OS signals
    done := make(chan os.Signal, 1)
    signal.Notify(done, syscall.SIGINT, syscall.SIGTERM)

    go func() {
        if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            log.Fatalf("ListenAndServe: %v", err)
        }
    }()

    log.Println("Server started")

    // Wait for shutdown signal
    <-done
    log.Println("Shutdown signal received, starting graceful shutdown")

    // Create shutdown context with deadline matching terminationGracePeriodSeconds
    ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
    defer cancel()

    // Stop accepting new connections and wait for in-flight requests
    if err := srv.Shutdown(ctx); err != nil {
        log.Printf("Graceful shutdown error: %v", err)
    }

    log.Println("Server shutdown complete")
}
```

## Section 8: Anti-Affinity and Topology Spread

### Preventing Single-Node Colocation

```yaml
# Ensure replicas spread across nodes and AZs
spec:
  template:
    spec:
      # Hard anti-affinity: NEVER place two pods of this app on the same node
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: api-service
            topologyKey: kubernetes.io/hostname  # Per-node spread

      # Topology spread: distribute across availability zones
      topologySpreadConstraints:
      - maxSkew: 1               # At most 1 pod more in any zone vs others
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule  # Fail scheduling rather than violate
        labelSelector:
          matchLabels:
            app: api-service
      - maxSkew: 1
        topologyKey: kubernetes.io/hostname
        whenUnsatisfiable: ScheduleAnyway  # Best-effort per-node spread
        labelSelector:
          matchLabels:
            app: api-service
```

## Section 9: Runbook Integration

Every production workload should have a runbook that operators can follow when the application misbehaves.

### Runbook Template for Kubernetes Workloads

```yaml
# Store runbook reference in pod annotations
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-service
  namespace: production
  annotations:
    # Link to runbook for this service
    runbook-url: "https://wiki.company.com/runbooks/api-service"
    # On-call team contact
    team: "platform-team"
    pagerduty-service: "P123456"
```

### Standard Runbook Structure

Each runbook should answer:

1. **What does this service do?** (1-2 sentences for context when alerted at 3 AM)
2. **Common alerts and initial triage steps**
3. **How to restart safely** (which commands, what to watch for)
4. **Dependency map** (what does this service depend on?)
5. **Key metrics** (links to dashboards)
6. **Escalation path** (who to call if you can't fix it)

```markdown
# API Service Runbook

## Service Overview
The API service handles user authentication and session management for the customer portal.
Owned by: Platform Team | On-call: platform-oncall@company.com

## Key Metrics
- Grafana dashboard: https://grafana.company.com/d/api-service
- SLO: 99.9% availability, p99 < 500ms

## Common Alerts

### APIServiceHighErrorRate
**Meaning:** More than 1% of requests are returning 5xx errors
**Initial triage:**
1. Check pod logs: `kubectl -n production logs -l app=api-service --tail=100`
2. Check if the database is healthy: `kubectl -n databases get pods -l app=postgres`
3. Check recent deployments: `kubectl -n production rollout history deployment/api-service`

**Remediation:**
- If recent deployment: `kubectl -n production rollout undo deployment/api-service`
- If database connectivity: See database runbook
- If pod crashes: `kubectl -n production describe pod -l app=api-service`

### APIServicePodCrashLooping
**Meaning:** One or more pods are restarting repeatedly
**Initial triage:**
1. Get crash logs: `kubectl -n production logs -l app=api-service --previous`
2. Check resource usage: `kubectl -n production top pods -l app=api-service`
3. Check events: `kubectl -n production get events --sort-by='.lastTimestamp'`
```

## Section 10: Complete PRR Checklist

```markdown
## Kubernetes Production Readiness Checklist

### Resources
- [ ] All containers have CPU and memory requests defined
- [ ] All containers have CPU and memory limits defined
- [ ] Memory limits are set to a value that won't cause OOM before the app's own GC
- [ ] JVM apps: memory limit accounts for heap + off-heap overhead
- [ ] Verified QoS class is appropriate (Guaranteed for critical services)

### High Availability
- [ ] Deployment has >= 2 replicas in production
- [ ] PodDisruptionBudget is configured and tested
- [ ] Anti-affinity ensures pods don't collocate on same node
- [ ] TopologySpreadConstraints spread across availability zones
- [ ] HorizontalPodAutoscaler configured with appropriate min/max

### Health Checks
- [ ] startupProbe configured for applications with > 30s startup time
- [ ] livenessProbe does NOT check external dependencies
- [ ] readinessProbe checks all required dependencies
- [ ] All probes have appropriate timeoutSeconds (>= 5s for production)
- [ ] All probes have appropriate failureThreshold (>= 3)
- [ ] Distinct endpoints implemented for startup/liveness/readiness

### Security
- [ ] securityContext.runAsNonRoot: true
- [ ] securityContext.allowPrivilegeEscalation: false
- [ ] securityContext.capabilities.drop: [ALL]
- [ ] securityContext.readOnlyRootFilesystem: true (with emptyDir mounts as needed)
- [ ] Dedicated ServiceAccount with minimal RBAC permissions
- [ ] automountServiceAccountToken: false (unless K8s API access is needed)
- [ ] Secrets sourced from external secret store (not hardcoded in manifests)
- [ ] Namespace has appropriate PodSecurityStandard enforcement label

### Networking
- [ ] Default-deny NetworkPolicy applied to namespace
- [ ] Explicit ingress NetworkPolicy for the service
- [ ] Explicit egress NetworkPolicy allowing only required destinations
- [ ] No overly broad egress rules (e.g., 0.0.0.0/0 without port restriction)

### Image Security
- [ ] Image is from approved registry
- [ ] Image has been scanned with no CRITICAL vulnerabilities
- [ ] Image uses a specific tag (not :latest)
- [ ] Image signature verified (if using Cosign)
- [ ] Image based on minimal base image (distroless preferred)

### Graceful Shutdown
- [ ] terminationGracePeriodSeconds >= maximum request duration
- [ ] preStop hook delays SIGTERM to allow load balancer to drain
- [ ] Application handles SIGTERM and completes in-flight requests

### Observability
- [ ] Application exposes Prometheus metrics
- [ ] ServiceMonitor or PodMonitor configured for metric scraping
- [ ] Structured JSON logging (not plain text)
- [ ] Log level configurable via environment variable
- [ ] Traces emitted via OpenTelemetry

### Operational
- [ ] Runbook exists and is linked from pod annotations
- [ ] Alerts configured for SLO burn rate
- [ ] Deployment has proper labels (app, version, team, environment)
- [ ] Resource has appropriate namespace
- [ ] CI/CD pipeline runs automated tests before production deployment
```

## Summary

A production readiness review is not a bureaucratic checklist exercise - it is the systematic application of hard-won operational knowledge to prevent predictable incidents. The categories covered in this guide represent real failure modes that have caused production outages:

- Resources without limits cause node-level resource exhaustion that affects all tenants
- Missing PodDisruptionBudgets allow cluster operations to take down applications without warning
- Aggressive or absent probes cause either unnecessary restarts or prolonged serving of unready pods
- Missing security contexts allow container escapes and privilege escalation in multi-tenant clusters
- Absent network policies allow lateral movement if any pod in a namespace is compromised
- Missing runbooks mean incidents last longer than necessary because operators must reconstruct context under pressure

The investment in getting these right before reaching production is far smaller than the cost of the incident they prevent. Automating the checklist through admission controllers (Gatekeeper, Kyverno) ensures that the standards are enforced consistently rather than depending on individual review thoroughness.
