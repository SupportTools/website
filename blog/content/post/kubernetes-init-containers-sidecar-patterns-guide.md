---
title: "Kubernetes Init Containers and Sidecar Patterns: Production Design"
date: 2027-05-03T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Init Containers", "Sidecar", "Patterns", "Pod Design"]
categories: ["Kubernetes", "Development"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Kubernetes init containers and sidecar container patterns covering dependency initialization, secret injection, log shipping, service mesh proxies, and native sidecar container support in Kubernetes 1.29+."
more_link: "yes"
url: "/kubernetes-init-containers-sidecar-patterns-guide/"
---

Multi-container pods are one of Kubernetes' most powerful patterns and one of its most misused. The ability to run auxiliary containers alongside application containers — sharing network namespace, process namespace, and volumes — enables initialization workflows, log shipping, and security proxies that would be difficult or impossible to bake into every application image. Init containers and sidecar containers each address distinct lifecycle phases, and understanding when to use each pattern, how they interact with Pod scheduling and resource accounting, and where the new native sidecar support in Kubernetes 1.29+ changes the equation is essential for production-grade pod design.

<!--more-->

# Kubernetes Init Containers and Sidecar Patterns: Production Design

## Architecture Overview

### Pod Container Types

A Kubernetes Pod can contain three categories of containers:

**Init Containers**: Run sequentially to completion before any application container starts. Each init container must exit with code 0 before the next one begins. If any init container fails, Kubernetes restarts it according to the pod's `restartPolicy`.

**App Containers** (the `containers` field): Run concurrently after all init containers have completed. The pod is considered Running once at least one app container is running.

**Sidecar Containers** (the `initContainers` field with `restartPolicy: Always`, Kubernetes 1.29+): A new category that starts alongside app containers but completes its lifecycle with the pod rather than before it. This solves the longstanding problem of sidecars that never exit blocking pod termination.

### Lifecycle Ordering

```
Pod Scheduled
     │
     ▼
Init Container 1 (runs to completion)
     │
     ▼
Init Container 2 (runs to completion)
     │
     ▼
[Native Sidecar Containers start here in K8s 1.29+]
     │
     ▼
App Containers (all start concurrently)
     │
     ▼
Pod Running
     │
     ▼
App Container exits → Pod terminates
     │
     ▼
[Native Sidecars receive SIGTERM and terminate]
```

## Init Container Patterns

### Database Migration

Running schema migrations before the application starts is the canonical init container use case. The migration tool must exit 0 before the application starts, ensuring the schema is ready:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-service
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api-service
  template:
    metadata:
      labels:
        app: api-service
    spec:
      initContainers:
      - name: db-migrate
        image: internal.registry.example.com/api-service:2.8.0
        command:
        - /app/migrate
        - --direction=up
        - --database-url=$(DATABASE_URL)
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: api-service-db
              key: url
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 256Mi
      containers:
      - name: api
        image: internal.registry.example.com/api-service:2.8.0
        command:
        - /app/server
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: api-service-db
              key: url
        ports:
        - containerPort: 8080
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
```

The migration image uses the same Docker image as the application — the init container simply calls a different binary. This approach ensures the migration tool's version is always in sync with the application schema expectations.

For services with multiple replicas, migration must be idempotent — all three replicas run their init containers concurrently. Use migration frameworks that handle concurrent migration attempts safely (most use advisory locks or migration state tables).

### Dependency Readiness Check

When the application must not start until its dependencies are available, init containers provide a robust waiting mechanism without embedding polling logic in the application:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: worker-service
  namespace: production
spec:
  replicas: 2
  template:
    spec:
      initContainers:
      # Wait for PostgreSQL
      - name: wait-for-postgres
        image: busybox:1.36
        command:
        - sh
        - -c
        - |
          until nc -z -w 3 postgres-service.production.svc.cluster.local 5432; do
            echo "Waiting for PostgreSQL..."
            sleep 5
          done
          echo "PostgreSQL is available"
        resources:
          requests:
            cpu: 10m
            memory: 16Mi

      # Wait for Kafka
      - name: wait-for-kafka
        image: confluentinc/cp-kafka:7.6.0
        command:
        - sh
        - -c
        - |
          until kafka-broker-api-versions.sh \
            --bootstrap-server kafka.data-platform.svc.cluster.local:9092 \
            2>/dev/null | grep -q "ApiVersions"; do
            echo "Waiting for Kafka..."
            sleep 5
          done
          echo "Kafka is available"
        resources:
          requests:
            cpu: 50m
            memory: 128Mi

      # Wait for Redis
      - name: wait-for-redis
        image: redis:7.2-alpine
        command:
        - sh
        - -c
        - |
          until redis-cli -h redis.production.svc.cluster.local ping 2>/dev/null | \
            grep -q PONG; do
            echo "Waiting for Redis..."
            sleep 3
          done
          echo "Redis is available"
        resources:
          requests:
            cpu: 10m
            memory: 16Mi

      containers:
      - name: worker
        image: internal.registry.example.com/worker:3.1.0
        resources:
          requests:
            cpu: 1000m
            memory: 1Gi
```

### Configuration Rendering

Some applications require configuration files generated from templates with environment-specific values. Init containers can render these files into a shared `emptyDir` volume:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx-proxy
  namespace: production
spec:
  template:
    spec:
      initContainers:
      - name: config-renderer
        image: hairyhenderson/gomplate:v3.11.5
        command:
        - gomplate
        - --input-dir=/templates
        - --output-dir=/config
        env:
        - name: UPSTREAM_HOST
          valueFrom:
            configMapKeyRef:
              name: proxy-config
              key: upstream_host
        - name: TLS_CERT_PATH
          value: /etc/ssl/certs/tls.crt
        - name: ENVIRONMENT
          value: production
        volumeMounts:
        - name: templates
          mountPath: /templates
          readOnly: true
        - name: config
          mountPath: /config
        resources:
          requests:
            cpu: 50m
            memory: 32Mi
      containers:
      - name: nginx
        image: nginx:1.27-alpine
        volumeMounts:
        - name: config
          mountPath: /etc/nginx/conf.d
          readOnly: true
        - name: tls-certs
          mountPath: /etc/ssl/certs
          readOnly: true
        ports:
        - containerPort: 443
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
      volumes:
      - name: templates
        configMap:
          name: nginx-templates
      - name: config
        emptyDir: {}
      - name: tls-certs
        secret:
          secretName: proxy-tls
```

### Certificate Setup

Before an application starts, init containers can retrieve or generate TLS certificates:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: secure-service
  namespace: production
spec:
  template:
    spec:
      serviceAccountName: secure-service-sa
      initContainers:
      - name: cert-fetcher
        image: vault:1.17.0
        command:
        - sh
        - -c
        - |
          # Authenticate to Vault using Kubernetes service account
          VAULT_TOKEN=$(vault write -field=token auth/kubernetes/login \
            role=secure-service \
            jwt="$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)")
          export VAULT_TOKEN

          # Fetch certificate from Vault PKI
          vault write -format=json pki/issue/secure-service \
            common_name=secure-service.production.svc.cluster.local \
            ttl=24h > /tmp/cert.json

          # Extract and write certificate files
          cat /tmp/cert.json | jq -r '.data.certificate' > /certs/tls.crt
          cat /tmp/cert.json | jq -r '.data.private_key' > /certs/tls.key
          cat /tmp/cert.json | jq -r '.data.ca_chain[]' >> /certs/ca.crt

          echo "Certificates written successfully"
          ls -la /certs/
        env:
        - name: VAULT_ADDR
          value: https://vault.vault-system.svc.cluster.local:8200
        volumeMounts:
        - name: certs
          mountPath: /certs
        resources:
          requests:
            cpu: 50m
            memory: 64Mi
      containers:
      - name: service
        image: internal.registry.example.com/secure-service:1.0.0
        volumeMounts:
        - name: certs
          mountPath: /etc/tls
          readOnly: true
        env:
        - name: TLS_CERT
          value: /etc/tls/tls.crt
        - name: TLS_KEY
          value: /etc/tls/tls.key
        ports:
        - containerPort: 8443
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
      volumes:
      - name: certs
        emptyDir:
          medium: Memory
          sizeLimit: 1Mi
```

Using `medium: Memory` for the certificate volume prevents certificates from being written to disk on the node.

### Ordering Guarantees and Failure Handling

Init containers run strictly in order. If init container N fails:

1. Kubernetes restarts it according to `restartPolicy` (for `Never`: pod fails; for `Always` or `OnFailure`: retry with backoff)
2. Init containers N+1 through M do not start
3. App containers do not start

```yaml
# Configure restart behavior for init containers
apiVersion: apps/v1
kind: Deployment
metadata:
  name: migration-service
  namespace: production
spec:
  template:
    spec:
      # restartPolicy applies to init containers too
      restartPolicy: Always
      initContainers:
      - name: schema-migration
        image: internal.registry.example.com/migrator:1.0.0
        command:
        - /migrate
        - --max-retries=3
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
        # Init containers can have their own readiness/liveness... no.
        # Init containers do NOT support readinessProbe or livenessProbe.
        # They only support startupProbe (1.21+)
        startupProbe:
          exec:
            command:
            - /health
          failureThreshold: 30
          periodSeconds: 10
```

## Sidecar Container Patterns (Pre-1.29)

Before native sidecar support, sidecars were implemented as regular containers in the `containers` list. The pod lifecycle tied all containers together: the pod terminated when the first container exited. Sidecars that never exit (log shippers, proxies) were beneficial during application runtime but caused problems when the application completed — for example, a batch job's pod would never reach `Completed` state because the log shipper sidecar kept running.

### Log Shipping Sidecar

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-app
  namespace: production
spec:
  template:
    spec:
      containers:
      - name: app
        image: internal.registry.example.com/web-app:5.0.0
        volumeMounts:
        - name: log-storage
          mountPath: /var/log/app
        resources:
          requests:
            cpu: 500m
            memory: 512Mi

      # Log shipper sidecar: reads from shared volume, ships to log aggregator
      - name: log-shipper
        image: fluent/fluent-bit:3.0
        volumeMounts:
        - name: log-storage
          mountPath: /var/log/app
          readOnly: true
        - name: fluent-bit-config
          mountPath: /fluent-bit/etc
          readOnly: true
        resources:
          requests:
            cpu: 50m
            memory: 64Mi
          limits:
            cpu: 200m
            memory: 256Mi

      volumes:
      - name: log-storage
        emptyDir: {}
      - name: fluent-bit-config
        configMap:
          name: fluent-bit-config
```

Fluent Bit ConfigMap:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluent-bit-config
  namespace: production
data:
  fluent-bit.conf: |
    [SERVICE]
        Flush        5
        Daemon       Off
        Log_Level    info

    [INPUT]
        Name         tail
        Path         /var/log/app/*.log
        Parser       json
        Tag          app.*
        Refresh_Interval 10

    [FILTER]
        Name         record_modifier
        Match        *
        Record       namespace ${NAMESPACE}
        Record       pod_name ${POD_NAME}

    [OUTPUT]
        Name         loki
        Match        *
        Host         loki.monitoring.svc.cluster.local
        Port         3100
        Labels       job=app_logs,namespace=${NAMESPACE}
        Line_Format  json
```

### Service Mesh Proxy Sidecar (Envoy)

Service meshes like Istio and Linkerd inject proxy sidecars automatically via mutating admission webhooks. Understanding the pattern directly is useful for custom proxy deployments:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backend-service
  namespace: production
  annotations:
    # Disable Istio injection if managing Envoy manually
    sidecar.istio.io/inject: "false"
spec:
  template:
    spec:
      initContainers:
      # iptables rules to redirect traffic through Envoy
      - name: proxy-init
        image: envoyproxy/envoy:v1.30.0
        command:
        - sh
        - -c
        - |
          iptables -t nat -A PREROUTING -p tcp --dport 8080 -j REDIRECT --to-port 15001
          iptables -t nat -A OUTPUT -p tcp -m owner --uid-owner 1337 -j RETURN
          iptables -t nat -A OUTPUT -p tcp -j REDIRECT --to-port 15001
        securityContext:
          capabilities:
            add:
            - NET_ADMIN
          runAsNonRoot: false
          runAsUser: 0
        resources:
          requests:
            cpu: 10m
            memory: 32Mi

      containers:
      - name: app
        image: internal.registry.example.com/backend-service:2.0.0
        ports:
        - containerPort: 8080
        securityContext:
          runAsUser: 1000
        resources:
          requests:
            cpu: 500m
            memory: 512Mi

      # Envoy proxy sidecar
      - name: envoy
        image: envoyproxy/envoy:v1.30.0
        command:
        - envoy
        - -c
        - /etc/envoy/envoy.yaml
        - --service-cluster
        - backend-service
        - --service-node
        - $(POD_NAME)
        env:
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        ports:
        - containerPort: 15001  # Proxy inbound
        - containerPort: 9901   # Admin interface
        volumeMounts:
        - name: envoy-config
          mountPath: /etc/envoy
        securityContext:
          runAsUser: 1337  # iptables OUTPUT rule exempts this UID
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi

      volumes:
      - name: envoy-config
        configMap:
          name: envoy-config
```

### Secret Agent Sidecar

A secret rotation sidecar periodically refreshes secrets from a secrets manager and writes them to a shared volume that the application reads via file:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: data-processor
  namespace: production
spec:
  template:
    spec:
      serviceAccountName: data-processor-sa
      containers:
      - name: processor
        image: internal.registry.example.com/data-processor:1.5.0
        volumeMounts:
        - name: secrets
          mountPath: /secrets
          readOnly: true
        resources:
          requests:
            cpu: 1000m
            memory: 2Gi

      # Vault Agent sidecar for automatic secret renewal
      - name: vault-agent
        image: vault:1.17.0
        command:
        - vault
        - agent
        - -config=/vault/config/agent.hcl
        env:
        - name: VAULT_ADDR
          value: https://vault.vault-system.svc.cluster.local:8200
        volumeMounts:
        - name: vault-config
          mountPath: /vault/config
        - name: secrets
          mountPath: /secrets
        - name: vault-token
          mountPath: /vault/token
        resources:
          requests:
            cpu: 50m
            memory: 64Mi
          limits:
            cpu: 200m
            memory: 128Mi

      volumes:
      - name: secrets
        emptyDir:
          medium: Memory
          sizeLimit: 10Mi
      - name: vault-config
        configMap:
          name: vault-agent-config
      - name: vault-token
        emptyDir:
          medium: Memory
          sizeLimit: 1Mi
```

Vault Agent configuration:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: vault-agent-config
  namespace: production
data:
  agent.hcl: |
    auto_auth {
      method "kubernetes" {
        mount_path = "auth/kubernetes"
        config = {
          role = "data-processor"
        }
      }

      sink "file" {
        config = {
          path = "/vault/token/vault-token"
        }
      }
    }

    template {
      source      = "/vault/config/db-credentials.tpl"
      destination = "/secrets/db-credentials.json"
      perms       = "0400"
      # Re-render when the secret changes
      error_on_missing_key = true
    }

    template {
      source      = "/vault/config/api-key.tpl"
      destination = "/secrets/api-key.txt"
      perms       = "0400"
    }

  db-credentials.tpl: |
    {{ with secret "secret/data/production/database" }}
    {
      "host": "{{ .Data.data.host }}",
      "username": "{{ .Data.data.username }}",
      "password": "{{ .Data.data.password }}"
    }
    {{ end }}

  api-key.tpl: |
    {{ with secret "secret/data/production/api-key" }}{{ .Data.data.value }}{{ end }}
```

## Native Sidecar Containers (Kubernetes 1.29+)

### The Problem Native Sidecars Solve

Before Kubernetes 1.29, the sidecar pattern had two critical limitations:

1. **Pod completion problem**: A `Job` pod with a sidecar log shipper would never reach `Completed` state because the log shipper container never exits, even after the job container finishes.

2. **Init container startup problem**: Sidecars implemented as init containers (with an infinite-sleep entrypoint) would block subsequent init containers from starting. Real sidecars need to start and remain running alongside other containers.

Native sidecars (an init container with `restartPolicy: Always`) solve both:
- They start before app containers (like init containers)
- They remain running alongside app containers (unlike regular init containers)
- They terminate after app containers exit (unlike regular containers, which would keep the pod alive)

### Native Sidecar Syntax

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: instrumented-service
  namespace: production
spec:
  template:
    spec:
      initContainers:
      # Native sidecar: starts before app, runs throughout pod lifetime
      - name: log-shipper
        image: fluent/fluent-bit:3.0
        restartPolicy: Always  # This is what makes it a native sidecar
        volumeMounts:
        - name: log-storage
          mountPath: /var/log/app
          readOnly: true
        resources:
          requests:
            cpu: 50m
            memory: 64Mi
        # Sidecars can have startup probes
        startupProbe:
          httpGet:
            path: /api/v1/health
            port: 2020
          failureThreshold: 30
          periodSeconds: 5

      # Regular init container (runs before app containers AND before sidecars are "ready")
      - name: db-migrate
        image: internal.registry.example.com/migrator:1.0.0
        command: ["/migrate", "--direction=up"]
        resources:
          requests:
            cpu: 100m
            memory: 128Mi

      containers:
      - name: service
        image: internal.registry.example.com/instrumented-service:2.0.0
        volumeMounts:
        - name: log-storage
          mountPath: /var/log/app
        resources:
          requests:
            cpu: 500m
            memory: 512Mi

      volumes:
      - name: log-storage
        emptyDir: {}
```

### Native Sidecar Startup Ordering

With native sidecars, the startup order is:

1. Regular init containers run in sequence to completion
2. Native sidecar containers (init containers with `restartPolicy: Always`) start and must pass their `startupProbe` before the next container starts
3. App containers start

This ordering guarantees that the Istio proxy (or any other network proxy) is accepting connections before the application container starts, eliminating a common race condition in service mesh deployments.

### Batch Job with Native Sidecar

The canonical example of native sidecar value is a batch job that needs log shipping:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: data-export
  namespace: production
spec:
  template:
    spec:
      restartPolicy: OnFailure
      initContainers:
      # Native sidecar: log shipper that terminates after the job container finishes
      - name: log-shipper
        image: fluent/fluent-bit:3.0
        restartPolicy: Always
        volumeMounts:
        - name: log-volume
          mountPath: /var/log/job
          readOnly: true
        - name: fluent-bit-config
          mountPath: /fluent-bit/etc
        resources:
          requests:
            cpu: 50m
            memory: 64Mi

      containers:
      - name: exporter
        image: internal.registry.example.com/data-exporter:1.2.0
        command:
        - /export
        - --output=/exports/data-$(date +%Y%m%d).parquet
        - --source=production-db
        volumeMounts:
        - name: log-volume
          mountPath: /var/log/job
        - name: export-storage
          mountPath: /exports
        resources:
          requests:
            cpu: 4000m
            memory: 8Gi
          limits:
            cpu: 8000m
            memory: 16Gi

      volumes:
      - name: log-volume
        emptyDir: {}
      - name: export-storage
        persistentVolumeClaim:
          claimName: export-data-pvc
      - name: fluent-bit-config
        configMap:
          name: job-fluent-bit-config
```

When the exporter container exits with code 0, Kubernetes sends SIGTERM to the log-shipper sidecar, waits for it to flush its buffers and exit, then marks the pod as Completed. Without native sidecar support, the log-shipper would keep the pod alive indefinitely.

### Istio Sidecar as Native Sidecar (Istio 1.22+)

Istio 1.22 introduced native sidecar support. Enable it cluster-wide:

```yaml
apiVersion: install.istio.io/v1alpha1
kind: IstioOperator
metadata:
  name: istio
  namespace: istio-system
spec:
  values:
    global:
      # Enable native sidecar for all injected proxies
      proxy:
        nativeSidecar: true
  components:
    pilot:
      k8s:
        env:
        - name: ENABLE_NATIVE_SIDECARS
          value: "true"
```

## Resource Sharing Between Containers

### Volume Sharing

Containers in a pod share volumes declared in `spec.volumes`. The most common patterns:

```yaml
spec:
  volumes:
  # Scratch space shared between containers
  - name: shared-tmp
    emptyDir: {}
  # In-memory volume for sensitive data
  - name: shared-secrets
    emptyDir:
      medium: Memory
      sizeLimit: 10Mi
  # Large in-memory volume for IPC
  - name: shared-ipc
    emptyDir:
      medium: Memory
      sizeLimit: 1Gi
  # Shared ConfigMap
  - name: shared-config
    configMap:
      name: app-config
  # Unix socket for IPC between containers
  - name: socket-dir
    emptyDir: {}
```

### Network Namespace Sharing

All containers in a pod share the same network namespace. A container listening on port 8080 is accessible to other containers via `localhost:8080`. This enables:

- Proxy sidecars that intercept traffic on specific ports
- Admin interfaces accessible only within the pod
- Shared Unix domain sockets via emptyDir volumes

```yaml
containers:
- name: app
  image: internal.registry.example.com/app:1.0.0
  ports:
  - containerPort: 8080  # Accessible externally via Service
  - containerPort: 9090  # Admin port, not exposed via Service

- name: admin-proxy
  image: nginx:1.27-alpine
  # This container serves the admin interface on port 9090 of the app
  # and adds authentication before forwarding
  volumeMounts:
  - name: nginx-config
    mountPath: /etc/nginx/conf.d
```

### Process Namespace Sharing

Enabling `shareProcessNamespace: true` allows containers to see each other's processes. This is useful for debugging and for sidecars that need to send signals to the main container:

```yaml
spec:
  shareProcessNamespace: true
  containers:
  - name: app
    image: internal.registry.example.com/app:1.0.0
    resources:
      requests:
        cpu: 500m
        memory: 512Mi

  # Sidecar that sends SIGHUP to reload config when ConfigMap changes
  - name: config-reloader
    image: jimmidyson/configmap-reload:v0.13.0
    args:
    - --volume-dir=/config
    - --webhook-url=http://localhost:8080/-/reload
    volumeMounts:
    - name: config
      mountPath: /config
    resources:
      requests:
        cpu: 10m
        memory: 16Mi
```

## Lifecycle Hooks

Lifecycle hooks complement init containers for managing startup and shutdown:

### postStart Hook

Runs immediately after the container starts, before readiness probes begin:

```yaml
containers:
- name: app
  image: internal.registry.example.com/app:1.0.0
  lifecycle:
    postStart:
      exec:
        command:
        - /bin/sh
        - -c
        - |
          # Register with service registry
          curl -sf -X PUT \
            "http://consul.consul-system.svc.cluster.local:8500/v1/agent/service/register" \
            -d "{\"ID\":\"$(hostname)\",\"Name\":\"app\",\"Port\":8080}"
    preStop:
      exec:
        command:
        - /bin/sh
        - -c
        - |
          # Deregister from service registry
          curl -sf -X PUT \
            "http://consul.consul-system.svc.cluster.local:8500/v1/agent/service/deregister/$(hostname)"
          # Wait for connections to drain
          sleep 15
```

### Combining Init Containers with Lifecycle Hooks

```yaml
spec:
  initContainers:
  - name: setup
    image: busybox:1.36
    command:
    - sh
    - -c
    - |
      # One-time setup that must complete before the app starts
      cp /source/config.template /config/config.yaml
      sed -i "s/__ENVIRONMENT__/${ENVIRONMENT}/g" /config/config.yaml
    env:
    - name: ENVIRONMENT
      value: production
    volumeMounts:
    - name: config
      mountPath: /config

  containers:
  - name: app
    image: internal.registry.example.com/app:1.0.0
    lifecycle:
      preStop:
        exec:
          command:
          - /app/graceful-shutdown
          - --timeout=30s
    terminationGracePeriodSeconds: 45
    volumeMounts:
    - name: config
      mountPath: /etc/app
      readOnly: true
```

## Common Antipatterns

### Antipattern 1: Using Init Containers for Sidecar-like Behavior

Before Kubernetes 1.29, some teams put sidecar containers in the `initContainers` list with an infinite loop to keep them running. This prevents subsequent init containers from starting and never becomes Ready, causing the pod to appear stuck:

```yaml
# ANTIPATTERN: Do not do this
initContainers:
- name: broken-sidecar
  image: log-shipper:1.0.0
  command: ["sh", "-c", "while true; do ship-logs; sleep 5; done"]
  # This never exits, blocking ALL subsequent init containers
```

The correct approach in Kubernetes 1.29+:

```yaml
# CORRECT: Native sidecar
initContainers:
- name: log-shipper
  image: log-shipper:1.0.0
  restartPolicy: Always  # Native sidecar
```

### Antipattern 2: Sharing Application Secrets in emptyDir Without Memory Medium

Writing secrets to a disk-backed `emptyDir` exposes them to node-level disk inspection:

```yaml
# ANTIPATTERN: Secrets written to disk
volumes:
- name: secrets
  emptyDir: {}  # Written to node disk

# CORRECT: Secrets in memory
volumes:
- name: secrets
  emptyDir:
    medium: Memory
    sizeLimit: 10Mi
```

### Antipattern 3: Heavy Initialization in readinessProbe Instead of Init Container

Some teams put database migration or schema validation in the readiness probe. This means:
- Multiple replicas run migrations simultaneously on every health check cycle
- The application process starts before migrations complete
- Migration failures cause pods to remain NotReady indefinitely with no clear error

```yaml
# ANTIPATTERN: Migrations in readinessProbe
containers:
- name: app
  readinessProbe:
    exec:
      command: ["/migrate", "--check-only"]  # Wrong place for migration
    periodSeconds: 30

# CORRECT: Migrations in initContainers
initContainers:
- name: db-migrate
  image: internal.registry.example.com/app:1.0.0
  command: ["/migrate", "--direction=up"]
```

### Antipattern 4: Insufficient Resource Requests on Init Containers

Init containers count toward pod resource requests: the effective pod resource request is the maximum of any single init container plus the sum of all app containers. Under-resourced init containers can cause scheduling failures or OOM kills during migration:

```yaml
# ANTIPATTERN: No resource requests on init container
initContainers:
- name: db-migrate
  image: internal.registry.example.com/migrator:1.0.0

# CORRECT: Explicit resource requests
initContainers:
- name: db-migrate
  image: internal.registry.example.com/migrator:1.0.0
  resources:
    requests:
      cpu: 200m
      memory: 256Mi
    limits:
      cpu: 500m
      memory: 512Mi
```

## Debugging Multi-Container Pods

```bash
# View logs from a specific container
kubectl logs <pod-name> -n <namespace> -c <container-name>

# View logs from a completed init container
kubectl logs <pod-name> -n <namespace> -c db-migrate

# Follow logs from multiple containers simultaneously
kubectl logs <pod-name> -n <namespace> --all-containers=true -f

# Execute a command in a specific container
kubectl exec -it <pod-name> -n <namespace> -c log-shipper -- sh

# Get container-level events and status
kubectl describe pod <pod-name> -n <namespace>
# Look for:
# Init Containers section showing exit codes
# Containers section showing restart counts
# Events section showing OOM, image pull errors

# Check if init containers completed successfully
kubectl get pod <pod-name> -n <namespace> \
  -o jsonpath='{range .status.initContainerStatuses[*]}{.name}: state={.state}{"\n"}{end}'

# Check native sidecar status
kubectl get pod <pod-name> -n <namespace> \
  -o jsonpath='{.status.initContainerStatuses}' | python3 -m json.tool
```

### Debugging Init Container Failures

```bash
#!/bin/bash
# Diagnose init container failures
# Usage: ./debug-init.sh <namespace> <pod-name>

NAMESPACE="${1:?namespace required}"
POD="${2:?pod name required}"

echo "=== Init Container Status ==="
kubectl get pod "${POD}" -n "${NAMESPACE}" \
  -o jsonpath='{range .status.initContainerStatuses[*]}Name: {.name}
  State: {.state}
  Ready: {.ready}
  Restart Count: {.restartCount}
  Last State: {.lastState}
---
{end}'

echo ""
echo "=== Init Container Logs ==="
INIT_CONTAINERS=$(kubectl get pod "${POD}" -n "${NAMESPACE}" \
  -o jsonpath='{range .spec.initContainers[*]}{.name}{"\n"}{end}')

for container in ${INIT_CONTAINERS}; do
  echo "--- ${container} ---"
  kubectl logs "${POD}" -n "${NAMESPACE}" -c "${container}" --tail=50 2>&1 || \
    echo "No logs available (container may not have started)"
  echo ""
done

echo "=== Pod Events ==="
kubectl describe pod "${POD}" -n "${NAMESPACE}" | \
  awk '/^Events:/,0 {print}'
```

## Conclusion

Init containers and sidecar patterns solve real problems in production Kubernetes deployments. Init containers provide deterministic, sequential dependency resolution and one-time setup operations with clear success/failure semantics. Traditional sidecars enable log shipping, proxy interception, and secret rotation that enhance the main application without requiring modifications to it. Native sidecar containers in Kubernetes 1.29+ resolve the longstanding issues with batch jobs and startup ordering, making the pattern more composable and lifecycle-correct. The key to avoiding complexity is clear ownership: each container should have a single, well-defined responsibility, resource requests should be explicitly set, and the choice between init container, native sidecar, and regular container should be driven by lifecycle requirements rather than convenience.
