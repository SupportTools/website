---
title: "Kubernetes Sidecar Containers: Init Containers, Sidecar Pattern, Istio Proxy Injection, and Pod Lifecycle"
date: 2028-08-22T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Sidecar", "Init Containers", "Pod Lifecycle", "Istio"]
categories:
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep technical guide to Kubernetes sidecar containers, init containers, the sidecar pattern, Istio proxy injection mechanics, and pod lifecycle management for production workloads."
more_link: "yes"
url: "/kubernetes-sidecar-init-containers-guide/"
---

Sidecar containers are one of the most powerful and widely used patterns in Kubernetes. From log shippers to service mesh proxies, the pattern allows you to extend the functionality of your main application container without modifying its code. Understanding how init containers, sidecar containers, and pod lifecycle interact is essential for building reliable, observable, and secure workloads at scale.

This guide covers the mechanics behind init containers, the sidecar pattern, Kubernetes 1.29+ native sidecar support, Istio proxy injection, and how to reason about startup ordering, termination sequencing, and lifecycle hooks in production pods.

<!--more-->

# [Kubernetes Sidecar Containers: Init Containers, Sidecar Pattern, Istio Proxy Injection, and Pod Lifecycle](#kubernetes-sidecar-containers)

## Section 1: Pod Container Types and Lifecycle Overview

A Kubernetes pod can contain several types of containers:

1. **Init containers** — run sequentially before any app containers start; must complete successfully
2. **App containers** — the primary workload containers, run concurrently after init containers complete
3. **Sidecar containers (Kubernetes 1.29+)** — a special init container subtype with `restartPolicy: Always`; run alongside app containers but start before them
4. **Ephemeral containers** — injected at runtime for debugging; not part of the pod spec lifecycle

### Pod Startup Sequence

```
Pod scheduled
    └─► Init container 1 (runs to completion)
        └─► Init container 2 (runs to completion)
            └─► [Kubernetes 1.29+] Sidecar init containers start (remain running)
                └─► App containers start concurrently
                    └─► postStart lifecycle hooks fire
                        └─► readinessProbes begin
                            └─► Pod enters Running state
```

### Pod Termination Sequence

```
SIGTERM sent to all containers
    └─► preStop lifecycle hooks execute (blocking)
        └─► terminationGracePeriodSeconds countdown begins
            └─► App containers receive SIGTERM
                └─► [after gracePeriod or exit] SIGKILL sent
                    └─► Sidecar containers terminated last (Kubernetes 1.29+)
```

This ordering matters enormously. A sidecar that terminates before the app container can cause requests to fail, log lines to be dropped, or mTLS connections to break mid-flight.

## Section 2: Init Containers in Depth

Init containers run sequentially and must exit with code 0 before the pod proceeds. They share the same network namespace and volumes as app containers, making them ideal for:

- Waiting for dependencies (databases, message brokers)
- Populating shared volumes with configuration or secrets
- Running database migrations
- Checking TLS certificate availability
- Fetching credentials from external vaults

### Basic Init Container Example

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: app-with-init
  namespace: production
spec:
  initContainers:
  - name: wait-for-postgres
    image: busybox:1.36
    command:
    - sh
    - -c
    - |
      echo "Waiting for Postgres..."
      until nc -z postgres-svc 5432; do
        echo "Postgres not ready, sleeping 2s..."
        sleep 2
      done
      echo "Postgres is ready"

  - name: run-migrations
    image: my-app:v2.3.1
    command: ["/app/migrate", "--up"]
    env:
    - name: DATABASE_URL
      valueFrom:
        secretKeyRef:
          name: app-secrets
          key: database-url
    volumeMounts:
    - name: migration-lock
      mountPath: /tmp/migration

  containers:
  - name: app
    image: my-app:v2.3.1
    ports:
    - containerPort: 8080
    env:
    - name: DATABASE_URL
      valueFrom:
        secretKeyRef:
          name: app-secrets
          key: database-url

  volumes:
  - name: migration-lock
    emptyDir: {}
```

### Init Container Retry Behavior

Init containers retry on failure based on the pod's `restartPolicy`:

- `Always` or `OnFailure` — init container restarts until success
- `Never` — pod fails if any init container fails

```yaml
spec:
  restartPolicy: OnFailure  # Init containers retry, pod doesn't restart on app failure
  initContainers:
  - name: db-check
    image: postgres:15
    command:
    - sh
    - -c
    - pg_isready -h $(PGHOST) -p $(PGPORT) -U $(PGUSER)
    env:
    - name: PGHOST
      value: "postgres.database.svc.cluster.local"
    - name: PGPORT
      value: "5432"
    - name: PGUSER
      value: "appuser"
```

### Init Container Resource Requests

Init containers do not run concurrently, so Kubernetes computes effective resource requests as:

```
max(any init container request, sum of all app container requests)
```

This means an init container doing heavy work (migrations, asset compilation) should have appropriate resources:

```yaml
initContainers:
- name: compile-assets
  image: node:20-alpine
  command: ["npm", "run", "build"]
  resources:
    requests:
      cpu: "2"
      memory: "2Gi"
    limits:
      cpu: "4"
      memory: "4Gi"
```

## Section 3: The Classic Sidecar Pattern

The sidecar pattern places a secondary container alongside the main application container in the same pod. The sidecar shares the pod's network namespace and can optionally share volumes.

### Common Sidecar Use Cases

| Use Case | Example | Shared Resource |
|----------|---------|-----------------|
| Log shipping | Fluent Bit forwarding `/var/log/app` | Volume |
| Metrics export | Prometheus exporter reading app stats | Network |
| Service mesh proxy | Envoy/Istio intercepting traffic | Network |
| Config reloader | ConfigMap watcher reloading app | Volume |
| Secret syncer | Vault agent injecting secrets | Volume |
| TLS termination | Nginx terminating TLS before app | Network |

### Fluent Bit Log Shipping Sidecar

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-with-logging
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: myapp
  template:
    metadata:
      labels:
        app: myapp
    spec:
      containers:
      - name: app
        image: my-app:v2.3.1
        volumeMounts:
        - name: log-volume
          mountPath: /var/log/app
        ports:
        - containerPort: 8080

      - name: fluent-bit
        image: fluent/fluent-bit:3.1
        volumeMounts:
        - name: log-volume
          mountPath: /var/log/app
          readOnly: true
        - name: fluent-bit-config
          mountPath: /fluent-bit/etc/
        resources:
          requests:
            cpu: "50m"
            memory: "64Mi"
          limits:
            cpu: "200m"
            memory: "256Mi"

      volumes:
      - name: log-volume
        emptyDir: {}
      - name: fluent-bit-config
        configMap:
          name: fluent-bit-config
```

```ini
# fluent-bit.conf ConfigMap content
[SERVICE]
    Flush         5
    Log_Level     info
    Parsers_File  parsers.conf

[INPUT]
    Name              tail
    Path              /var/log/app/*.log
    Parser            json
    Tag               app.*
    Refresh_Interval  5
    Mem_Buf_Limit     5MB

[FILTER]
    Name  record_modifier
    Match *
    Record pod_name ${HOSTNAME}
    Record namespace ${NAMESPACE}

[OUTPUT]
    Name  es
    Match *
    Host  elasticsearch.logging.svc.cluster.local
    Port  9200
    Index app-logs
    Type  _doc
```

### Ambassador Pattern: Sidecar as Proxy

The ambassador pattern wraps external service communication:

```yaml
containers:
- name: app
  image: my-app:v2.3.1
  env:
  # App talks to localhost:6379, ambassador proxies to Redis cluster
  - name: REDIS_URL
    value: "localhost:6379"

- name: redis-ambassador
  image: haproxy:2.8-alpine
  volumeMounts:
  - name: haproxy-config
    mountPath: /usr/local/etc/haproxy/
  ports:
  - containerPort: 6379
```

## Section 4: Kubernetes 1.29+ Native Sidecar Containers

Before Kubernetes 1.29, sidecars were ordinary app containers with no lifecycle guarantees. The new native sidecar feature introduces `restartPolicy: Always` on init containers, creating a new semantic: init containers that survive beyond pod startup.

### Enabling Native Sidecars

Native sidecars became GA in Kubernetes 1.29. No feature gate required.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: native-sidecar-demo
spec:
  initContainers:
  # This is a native sidecar — starts before app, stays running
  - name: log-collector
    image: fluent/fluent-bit:3.1
    restartPolicy: Always        # KEY: this makes it a native sidecar
    volumeMounts:
    - name: log-volume
      mountPath: /var/log/app
      readOnly: true

  # Regular init container — runs to completion before app starts
  - name: db-migrate
    image: my-app:v2.3.1
    command: ["/app/migrate", "--up"]

  containers:
  - name: app
    image: my-app:v2.3.1
    volumeMounts:
    - name: log-volume
      mountPath: /var/log/app

  volumes:
  - name: log-volume
    emptyDir: {}
```

### Startup Ordering with Native Sidecars

Native sidecar init containers must pass their `startupProbe` before subsequent init containers or app containers can proceed:

```yaml
initContainers:
- name: istio-proxy
  image: istio/proxyv2:1.20.0
  restartPolicy: Always
  startupProbe:
    httpGet:
      path: /healthz/ready
      port: 15021
    failureThreshold: 30
    periodSeconds: 1
  # App container won't start until this probe passes
```

### Termination Ordering with Native Sidecars

When a pod terminates:
1. App containers receive SIGTERM first
2. Native sidecar containers receive SIGTERM after app containers exit
3. This ensures the sidecar (log forwarder, proxy) is available until the app finishes

```yaml
initContainers:
- name: envoy-proxy
  image: envoyproxy/envoy:v1.28-latest
  restartPolicy: Always
  lifecycle:
    preStop:
      exec:
        # Drain connections before Envoy terminates
        command:
        - sh
        - -c
        - |
          curl -s -X POST http://localhost:9901/healthcheck/fail
          sleep 5
          curl -s -X POST http://localhost:9901/quitquitquit
```

## Section 5: Istio Proxy Injection Mechanics

Istio injects an Envoy proxy sidecar into pods automatically using a MutatingAdmissionWebhook. Understanding how this injection works helps you debug injection failures, resource contention, and startup ordering issues.

### How Injection Works

When a pod is created in a namespace labeled `istio-injection: enabled`, the Istio webhook mutates the pod spec to add:

1. An `istio-init` init container (sets up iptables rules to intercept traffic)
2. An `istio-proxy` sidecar container (the Envoy proxy)

```bash
# Enable automatic injection for a namespace
kubectl label namespace production istio-injection=enabled

# Verify injection label
kubectl get namespace production --show-labels

# Check injection on a specific deployment
kubectl get deployment myapp -n production -o jsonpath='{.spec.template.metadata.annotations}'
```

### Inspecting the Injected Pod

```bash
# See the full mutated pod spec after injection
kubectl get pod myapp-7d9f8c-xxx -n production -o yaml

# Check the injected containers
kubectl get pod myapp-7d9f8c-xxx -n production \
  -o jsonpath='{range .spec.initContainers[*]}{.name}{"\n"}{end}'
# Output: istio-init
#         (your other init containers)

kubectl get pod myapp-7d9f8c-xxx -n production \
  -o jsonpath='{range .spec.containers[*]}{.name}{"\n"}{end}'
# Output: app
#         istio-proxy
```

### The istio-init Container

The `istio-init` container configures iptables rules to redirect all traffic through Envoy:

```bash
# What istio-init effectively does:
iptables -t nat -A PREROUTING -p tcp -j ISTIO_INBOUND
iptables -t nat -A ISTIO_INBOUND -p tcp --dport 8080 -j ISTIO_IN_REDIRECT
iptables -t nat -A OUTPUT -p tcp -j ISTIO_OUTPUT
iptables -t nat -A ISTIO_OUTPUT -m owner --uid-owner 1337 -j RETURN
iptables -t nat -A ISTIO_OUTPUT -j ISTIO_REDIRECT
```

Because `istio-init` requires `NET_ADMIN` capability, this is a security concern in hardened environments. The alternative is Istio ambient mesh, which removes the need for per-pod proxy injection.

### Disabling Injection Per Pod

```yaml
metadata:
  annotations:
    sidecar.istio.io/inject: "false"   # Opt out of injection
```

### Controlling Sidecar Resources

```yaml
metadata:
  annotations:
    sidecar.istio.io/proxyCPU: "100m"
    sidecar.istio.io/proxyMemory: "128Mi"
    sidecar.istio.io/proxyCPULimit: "500m"
    sidecar.istio.io/proxyMemoryLimit: "256Mi"
```

### Istio Startup Race Condition (Pre-1.29)

A classic problem: your app container starts before `istio-proxy` is ready. The app tries to make outbound calls, which are intercepted by iptables but Envoy isn't ready yet, causing connection failures.

Fix pre-1.29:

```yaml
containers:
- name: app
  image: my-app:v2.3.1
  lifecycle:
    postStart:
      exec:
        command:
        - sh
        - -c
        - |
          # Wait for Envoy to be ready before app begins serving
          until curl -s http://localhost:15021/healthz/ready; do
            echo "Waiting for Envoy..."
            sleep 1
          done
```

Fix with Kubernetes 1.29+ native sidecars and Istio 1.20+:

Istio 1.20+ uses native sidecar containers when running on Kubernetes 1.29+, eliminating the race condition entirely.

## Section 6: Pod Lifecycle Hooks

### postStart Hook

Runs immediately after a container starts. The container is not marked as Running until the hook completes. If the hook fails, the container is killed and restarted.

```yaml
containers:
- name: app
  image: my-app:v2.3.1
  lifecycle:
    postStart:
      exec:
        command:
        - /bin/sh
        - -c
        - |
          # Register with service discovery
          curl -X PUT http://consul:8500/v1/agent/service/register \
            -H "Content-Type: application/json" \
            -d "{
              \"ID\": \"${HOSTNAME}\",
              \"Name\": \"myapp\",
              \"Port\": 8080,
              \"Check\": {
                \"HTTP\": \"http://localhost:8080/healthz\",
                \"Interval\": \"10s\"
              }
            }"
```

**Warning**: `postStart` runs concurrently with the container ENTRYPOINT. There is no guarantee of ordering between the hook and the main process.

### preStop Hook

The `preStop` hook is called before SIGTERM is sent. It blocks SIGTERM until the hook completes. This is critical for graceful shutdown.

```yaml
containers:
- name: nginx
  image: nginx:1.25
  lifecycle:
    preStop:
      exec:
        command:
        - sh
        - -c
        - |
          # Drain active connections before NGINX exits
          nginx -s quit
          # Wait up to 30s for connections to drain
          sleep 30
  terminationGracePeriodSeconds: 40
```

```yaml
containers:
- name: app
  image: my-app:v2.3.1
  lifecycle:
    preStop:
      httpGet:
        path: /shutdown
        port: 8080
        scheme: HTTP
```

### terminationGracePeriodSeconds

The grace period starts when SIGTERM is sent (after preStop completes). If the container hasn't exited, SIGKILL is sent.

```yaml
spec:
  terminationGracePeriodSeconds: 60  # Default is 30s
  containers:
  - name: app
    image: my-app:v2.3.1
    lifecycle:
      preStop:
        exec:
          command: ["/bin/sh", "-c", "sleep 5"]  # preStop uses grace period time
```

**Total time budget**: `terminationGracePeriodSeconds` covers both the preStop hook and the container's own shutdown. Plan accordingly.

## Section 7: Readiness, Liveness, and Startup Probes

### Probe Types and When to Use Them

| Probe | Triggers | Action on Failure |
|-------|----------|-------------------|
| `startupProbe` | During container startup only | Kill and restart container |
| `livenessProbe` | Continuously after startup | Kill and restart container |
| `readinessProbe` | Continuously | Remove from Service endpoints |

### Startup Probe Pattern for Slow Apps

```yaml
containers:
- name: slow-app
  image: heavy-jvm-app:v1.0
  startupProbe:
    httpGet:
      path: /actuator/health/readiness
      port: 8080
    failureThreshold: 30      # 30 * 10s = 300s max startup time
    periodSeconds: 10
    successThreshold: 1
  livenessProbe:
    httpGet:
      path: /actuator/health/liveness
      port: 8080
    initialDelaySeconds: 0   # startupProbe guards this
    periodSeconds: 10
    failureThreshold: 3
  readinessProbe:
    httpGet:
      path: /actuator/health/readiness
      port: 8080
    periodSeconds: 5
    failureThreshold: 3
    successThreshold: 1
```

### Probing a Sidecar

Sidecars can also have probes. The pod is only Ready when all containers with readiness probes are ready:

```yaml
- name: istio-proxy
  image: istio/proxyv2:1.20.0
  readinessProbe:
    httpGet:
      path: /healthz/ready
      port: 15021
    initialDelaySeconds: 1
    periodSeconds: 2
    failureThreshold: 30
  livenessProbe:
    httpGet:
      path: /healthz/ready
      port: 15021
    periodSeconds: 10
    failureThreshold: 3
```

## Section 8: Volume-Based Sidecar Communication Patterns

### Shared emptyDir for File-Based Communication

```yaml
spec:
  volumes:
  - name: shared-data
    emptyDir:
      medium: Memory  # tmpfs for performance-sensitive use cases
      sizeLimit: 256Mi

  containers:
  - name: app
    image: my-app:v2.3.1
    volumeMounts:
    - name: shared-data
      mountPath: /data/output

  - name: processor
    image: data-processor:v1.0
    volumeMounts:
    - name: shared-data
      mountPath: /data/input
      readOnly: true
```

### Secret Injection via Init Container

```yaml
initContainers:
- name: vault-agent
  image: hashicorp/vault:1.15
  command:
  - vault
  - agent
  - -config=/vault/config/agent.hcl
  volumeMounts:
  - name: vault-config
    mountPath: /vault/config
  - name: secrets-volume
    mountPath: /vault/secrets
  env:
  - name: VAULT_ADDR
    value: "https://vault.internal:8200"
  - name: VAULT_ROLE
    value: "myapp-role"

containers:
- name: app
  image: my-app:v2.3.1
  volumeMounts:
  - name: secrets-volume
    mountPath: /app/secrets
    readOnly: true

volumes:
- name: secrets-volume
  emptyDir:
    medium: Memory
- name: vault-config
  configMap:
    name: vault-agent-config
```

## Section 9: Resource Management for Multi-Container Pods

### QoS Classes and Multiple Containers

Pod QoS class is determined by the combined resource specs of all containers (including init containers for limit calculations, but not sidecar resource requests in Kubernetes 1.29 native mode).

```yaml
# This pod gets Burstable QoS
spec:
  initContainers:
  - name: init
    resources:
      requests:
        cpu: "100m"
        memory: "64Mi"

  containers:
  - name: app
    resources:
      requests:
        cpu: "500m"
        memory: "512Mi"
      limits:
        cpu: "1"
        memory: "1Gi"

  - name: sidecar
    resources:
      requests:
        cpu: "50m"
        memory: "64Mi"
      limits:
        cpu: "100m"
        memory: "128Mi"
```

### Vertical Pod Autoscaler with Multiple Containers

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: app-vpa
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp
  updatePolicy:
    updateMode: "Off"  # Recommendation only
  resourcePolicy:
    containerPolicies:
    - containerName: app
      minAllowed:
        cpu: "100m"
        memory: "128Mi"
      maxAllowed:
        cpu: "4"
        memory: "4Gi"
    - containerName: istio-proxy
      mode: "Off"  # Don't auto-scale the sidecar
    - containerName: fluent-bit
      minAllowed:
        cpu: "25m"
        memory: "32Mi"
      maxAllowed:
        cpu: "200m"
        memory: "256Mi"
```

## Section 10: Debugging Sidecar Issues

### Identifying Container States

```bash
# Check all container statuses in a pod
kubectl get pod myapp-xxx -n production \
  -o jsonpath='{range .status.containerStatuses[*]}{.name}: {.state}{"\n"}{end}'

# Check init container statuses
kubectl get pod myapp-xxx -n production \
  -o jsonpath='{range .status.initContainerStatuses[*]}{.name}: ready={.ready} restartCount={.restartCount}{"\n"}{end}'

# Stream logs from a specific container
kubectl logs myapp-xxx -n production -c istio-proxy -f

# Previous logs (after restart)
kubectl logs myapp-xxx -n production -c app --previous

# Execute into a specific container
kubectl exec -it myapp-xxx -n production -c istio-proxy -- /bin/sh
```

### Init Container Stuck in CrashLoopBackOff

```bash
# Get events for the pod
kubectl describe pod myapp-xxx -n production | grep -A 20 Events

# Check init container logs
kubectl logs myapp-xxx -n production -c wait-for-postgres

# Force delete and recreate if stuck
kubectl delete pod myapp-xxx -n production --grace-period=0 --force
```

### Debugging Istio Proxy Issues

```bash
# Check Envoy config dump
kubectl exec myapp-xxx -n production -c istio-proxy -- \
  pilot-agent request GET config_dump | jq '.configs[0]'

# Check Envoy clusters
kubectl exec myapp-xxx -n production -c istio-proxy -- \
  pilot-agent request GET clusters

# Check Envoy stats
kubectl exec myapp-xxx -n production -c istio-proxy -- \
  pilot-agent request GET stats | grep upstream_cx

# Check Istio proxy status
istioctl proxy-status

# Analyze configuration issues
istioctl analyze -n production

# Check proxy config for a specific pod
istioctl proxy-config cluster myapp-xxx.production
istioctl proxy-config listener myapp-xxx.production
istioctl proxy-config route myapp-xxx.production
```

### Checking iptables Rules Injected by istio-init

```bash
# Enter the pod's network namespace (requires privileged access)
kubectl debug -it myapp-xxx -n production --image=nicolaka/netshoot -- \
  iptables -t nat -L -n -v
```

## Section 11: Complete Production Pod Spec Example

This example brings together init containers, a native sidecar log forwarder, Istio injection, lifecycle hooks, and resource management:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: production-app
  namespace: production
  labels:
    app: production-app
    version: v2.3.1
spec:
  replicas: 3
  selector:
    matchLabels:
      app: production-app
  template:
    metadata:
      labels:
        app: production-app
        version: v2.3.1
      annotations:
        sidecar.istio.io/proxyCPU: "100m"
        sidecar.istio.io/proxyMemory: "128Mi"
        sidecar.istio.io/proxyCPULimit: "500m"
        sidecar.istio.io/proxyMemoryLimit: "256Mi"
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"
    spec:
      serviceAccountName: production-app-sa
      terminationGracePeriodSeconds: 60

      initContainers:
      # Native sidecar: starts before app, stays running, terminates after app
      - name: log-forwarder
        image: fluent/fluent-bit:3.1
        restartPolicy: Always
        startupProbe:
          exec:
            command: ["/fluent-bit/bin/fluent-bit", "--dry-run"]
          failureThreshold: 10
          periodSeconds: 2
        volumeMounts:
        - name: app-logs
          mountPath: /var/log/app
          readOnly: true
        - name: fluent-bit-config
          mountPath: /fluent-bit/etc/
        resources:
          requests:
            cpu: "50m"
            memory: "64Mi"
          limits:
            cpu: "200m"
            memory: "128Mi"

      # Regular init: waits for DB, runs migrations
      - name: wait-for-db
        image: busybox:1.36
        command:
        - sh
        - -c
        - |
          until nc -z postgres.database.svc.cluster.local 5432; do
            echo "$(date): waiting for postgres..."
            sleep 2
          done
          echo "Postgres is ready"

      - name: run-migrations
        image: production-app:v2.3.1
        command: ["/app/migrate", "--up", "--lock-timeout=60s"]
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: app-secrets
              key: database-url
        resources:
          requests:
            cpu: "200m"
            memory: "256Mi"
          limits:
            cpu: "1"
            memory: "512Mi"

      containers:
      - name: app
        image: production-app:v2.3.1
        ports:
        - name: http
          containerPort: 8080
        - name: metrics
          containerPort: 9090
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: app-secrets
              key: database-url
        - name: LOG_DIR
          value: /var/log/app
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        - name: POD_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace

        volumeMounts:
        - name: app-logs
          mountPath: /var/log/app

        lifecycle:
          preStop:
            exec:
              command:
              - sh
              - -c
              - |
                # Signal app to stop accepting new requests
                kill -SIGTERM 1
                # Wait for in-flight requests
                sleep 15

        startupProbe:
          httpGet:
            path: /healthz/startup
            port: 8080
          failureThreshold: 30
          periodSeconds: 2

        livenessProbe:
          httpGet:
            path: /healthz/live
            port: 8080
          periodSeconds: 10
          failureThreshold: 3
          timeoutSeconds: 5

        readinessProbe:
          httpGet:
            path: /healthz/ready
            port: 8080
          periodSeconds: 5
          failureThreshold: 3
          successThreshold: 1
          timeoutSeconds: 3

        resources:
          requests:
            cpu: "500m"
            memory: "512Mi"
          limits:
            cpu: "2"
            memory: "1Gi"

        securityContext:
          runAsNonRoot: true
          runAsUser: 1000
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities:
            drop: ["ALL"]

      volumes:
      - name: app-logs
        emptyDir:
          medium: Memory
          sizeLimit: 256Mi
      - name: fluent-bit-config
        configMap:
          name: fluent-bit-config

      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchExpressions:
                - key: app
                  operator: In
                  values: [production-app]
              topologyKey: kubernetes.io/hostname
```

## Section 12: Summary and Best Practices

### When to Use Init Containers

- Sequential dependency checks (wait for external services)
- One-time setup tasks (migrations, config generation)
- Security-sensitive bootstrapping (secret fetching)
- Tasks that need higher privileges than the app container

### When to Use Native Sidecar Containers (1.29+)

- Log forwarders that must outlive app startup and survive until app termination
- Service mesh proxies replacing Istio's pre-1.20 injection model
- Config watchers that need to reload configuration during pod lifetime

### When to Use Classic Sidecar App Containers

- Legacy clusters (< 1.29)
- Sidecars where ordering guarantees are not required
- Where the sidecar lifecycle needs to be fully independent of the app

### Key Takeaways

1. Native sidecar containers (Kubernetes 1.29+) solve startup/termination ordering without hacks
2. `terminationGracePeriodSeconds` must accommodate both preStop hooks and container shutdown time
3. Istio's `istio-init` init container requires `NET_ADMIN` — consider ambient mesh for unprivileged workloads
4. Always set resource requests and limits on sidecar containers; they consume real cluster capacity
5. Use `startupProbe` to protect slow-starting apps from premature liveness probe failures
6. VPA can manage sidecar resources independently using `containerPolicies`
7. For Istio startup race conditions on pre-1.29 clusters, use postStart hooks to wait for Envoy readiness
