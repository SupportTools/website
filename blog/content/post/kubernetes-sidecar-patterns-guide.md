---
title: "Kubernetes Sidecar Patterns: Proxies, Adapters, and Ambassador Containers"
date: 2028-01-30T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Sidecar", "Patterns", "Architecture", "Service Mesh", "Platform Engineering"]
categories: ["Kubernetes", "Architecture", "Platform Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Kubernetes sidecar patterns including log forwarding, metrics export, ambassador proxy, adapter protocol translation, native sidecar containers with KEP-753, lifecycle coordination, and init container interaction patterns."
more_link: "yes"
url: "/kubernetes-sidecar-patterns-guide/"
---

Sidecars solve a fundamental problem in distributed systems: how to add infrastructure concerns like observability, security, and protocol translation to applications without modifying application code. The sidecar pattern injects a second container into a pod that shares the same network namespace, process namespace (optionally), and volume mounts as the primary application. This tight coupling enables capabilities that would otherwise require deep application-level integration. This guide examines the four canonical sidecar patterns and their production implementations, including the native sidecar container feature introduced in Kubernetes 1.29.

<!--more-->

# Kubernetes Sidecar Patterns: Proxies, Adapters, and Ambassador Containers

## Shared Resources in a Pod

Before examining specific patterns, understanding what containers in a pod share is essential:

```
Pod
├── Network namespace (shared by default)
│     └── All containers see the same IP address and ports
│           → Cannot have two containers listening on the same port
│           → Sidecar can intercept by binding to a different port
│           → Communication via localhost
├── Volumes (explicitly shared via volumeMounts)
│     └── Named volumes or emptyDir can be mounted in multiple containers
│           → Primary writes logs to /var/log/app
│           → Log forwarder reads from /var/log/app
├── Process namespace (shareProcessNamespace: true)
│     └── Enables process-level interaction between containers
│           → Sidecar can send signals to application process
│           → Enables live debugging via ephemeral containers
└── Cgroups (resource limits apply per container)
      → Each container has independent CPU/memory limits
```

## Pattern 1: Log Forwarder Sidecar

The log forwarder sidecar reads application log files and ships them to a centralized log aggregation system. This decouples the application from the log shipping infrastructure.

### Fluent Bit Log Forwarder

```yaml
# deployment-with-log-forwarder.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-api
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: my-api
  template:
    metadata:
      labels:
        app: my-api
    spec:
      volumes:
        # Shared volume for log files between app and forwarder
        - name: app-logs
          emptyDir: {}
        # Fluent Bit configuration
        - name: fluent-bit-config
          configMap:
            name: fluent-bit-config
      initContainers:
        # Init container creates the log directory with proper permissions
        - name: log-dir-init
          image: busybox:1.36
          command: ["sh", "-c", "mkdir -p /var/log/app && chmod 755 /var/log/app"]
          volumeMounts:
            - name: app-logs
              mountPath: /var/log/app
      containers:
        # Primary application container
        - name: app
          image: gcr.io/my-org/my-api:1.5.3
          ports:
            - containerPort: 8080
          volumeMounts:
            - name: app-logs
              mountPath: /var/log/app
          env:
            # Configure application to write structured JSON logs to a file
            # rather than stdout (avoids Docker log driver overhead)
            - name: LOG_FILE
              value: /var/log/app/access.log
            - name: LOG_LEVEL
              value: info
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
            limits:
              memory: 512Mi

        # Fluent Bit sidecar reads and ships application logs
        - name: fluent-bit
          image: fluent/fluent-bit:3.1
          volumeMounts:
            - name: app-logs
              mountPath: /var/log/app
              # readOnly prevents the sidecar from accidentally writing
              # to the log directory
              readOnly: true
            - name: fluent-bit-config
              mountPath: /fluent-bit/etc
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 100m
              memory: 128Mi
          # The log forwarder should not be marked as critical
          # — if it fails, the application should continue
          livenessProbe:
            httpGet:
              path: /api/v1/health
              port: 2020
            initialDelaySeconds: 10
            periodSeconds: 30
```

```yaml
# configmap-fluent-bit.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluent-bit-config
  namespace: production
data:
  fluent-bit.conf: |
    [SERVICE]
        Flush        1
        Log_Level    info
        Daemon       Off
        Parsers_File parsers.conf
        HTTP_Server  On
        HTTP_Listen  0.0.0.0
        HTTP_Port    2020

    [INPUT]
        Name             tail
        Path             /var/log/app/*.log
        Parser           json
        Tag              app.*
        # Refresh interval for discovering new log files
        Refresh_Interval 5
        # Rotate_Wait prevents reading a file while it is being rotated
        Rotate_Wait      30
        # Skip lines that cannot be parsed
        Skip_Long_Lines  On
        # DB stores the file read position across restarts
        DB               /tmp/fluent-bit-app.db

    [FILTER]
        Name   record_modifier
        Match  app.*
        # Add pod metadata for log correlation
        Record pod_name ${HOSTNAME}
        Record namespace production
        Record cluster production-cluster

    [OUTPUT]
        Name             forward
        Match            *
        Host             fluentd-aggregator.logging.svc.cluster.local
        Port             24224
        Self_Hostname    ${HOSTNAME}
        # Backpressure handling: buffer up to 10MB when downstream is slow
        Buffer_Chunk_Size 1M
        Buffer_Max_Size   10M

  parsers.conf: |
    [PARSER]
        Name        json
        Format      json
        Time_Key    timestamp
        Time_Format %Y-%m-%dT%H:%M:%S.%L%z
```

## Pattern 2: Metrics Exporter Sidecar

Applications that do not natively expose Prometheus metrics can use an exporter sidecar to translate internal metrics formats.

```yaml
# deployment-with-metrics-exporter.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: legacy-java-app
  namespace: production
spec:
  template:
    spec:
      volumes:
        # JMX credentials for the metrics exporter
        - name: jmx-config
          configMap:
            name: jmx-exporter-config
      containers:
        - name: app
          image: gcr.io/my-org/legacy-java:2.1.0
          ports:
            - containerPort: 8080
            # JMX port for the metrics exporter sidecar
            - containerPort: 1099
              name: jmx
          env:
            - name: JAVA_OPTS
              value: >-
                -Dcom.sun.management.jmxremote
                -Dcom.sun.management.jmxremote.port=1099
                -Dcom.sun.management.jmxremote.authenticate=false
                -Dcom.sun.management.jmxremote.ssl=false
                -Dcom.sun.management.jmxremote.local.only=true

        # JMX Exporter sidecar: translates JMX metrics to Prometheus format
        - name: jmx-exporter
          image: bitnami/jmx-exporter:0.20
          args:
            # Port for Prometheus scraping
            - "9404"
            # Config file path
            - /etc/jmx/config.yaml
          ports:
            - containerPort: 9404
              name: metrics
          volumeMounts:
            - name: jmx-config
              mountPath: /etc/jmx
          env:
            # JMX exporter connects to the app container via localhost
            - name: JMX_HOST
              value: localhost
            - name: JMX_PORT
              value: "1099"
          resources:
            requests:
              cpu: 50m
              memory: 128Mi
            limits:
              memory: 256Mi
```

## Pattern 3: Ambassador Pattern (Database Proxy)

The ambassador pattern places a proxy sidecar between the application and an external service. The application connects to localhost, and the ambassador handles connection pooling, SSL termination, or service discovery.

### PgBouncer Connection Pooler Ambassador

```yaml
# deployment-pgbouncer-ambassador.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-with-db-pooler
  namespace: production
spec:
  template:
    spec:
      volumes:
        - name: pgbouncer-config
          secret:
            secretName: pgbouncer-config
      containers:
        - name: api
          image: gcr.io/my-org/api:1.5.3
          env:
            # Application connects to the PgBouncer ambassador on localhost
            # rather than directly to the PostgreSQL primary
            - name: DATABASE_URL
              value: postgres://app_user@localhost:5432/appdb?sslmode=disable

        # PgBouncer ambassador: connection pooling proxy for PostgreSQL
        # The app creates many short-lived connections; PgBouncer maintains
        # a stable pool to the actual database
        - name: pgbouncer
          image: bitnami/pgbouncer:1.22.0
          ports:
            - containerPort: 5432
              name: postgres
          volumeMounts:
            - name: pgbouncer-config
              mountPath: /etc/pgbouncer
              readOnly: true
          env:
            # PgBouncer forwards to the actual PostgreSQL service
            - name: POSTGRESQL_HOST
              value: postgresql-primary.production.svc.cluster.local
            - name: POSTGRESQL_PORT
              value: "5432"
            - name: PGBOUNCER_DATABASE
              value: appdb
            - name: PGBOUNCER_POOL_MODE
              value: transaction  # transaction pooling for efficiency
            - name: PGBOUNCER_MAX_CLIENT_CONN
              value: "100"        # max connections from the application
            - name: PGBOUNCER_DEFAULT_POOL_SIZE
              value: "10"         # connections maintained to PostgreSQL
            - name: PGBOUNCER_AUTH_TYPE
              value: scram-sha-256
          resources:
            requests:
              cpu: 50m
              memory: 32Mi
            limits:
              memory: 64Mi
          livenessProbe:
            tcpSocket:
              port: 5432
            initialDelaySeconds: 5
            periodSeconds: 10
```

### Envoy Proxy Ambassador for Service Discovery

```yaml
# The Envoy ambassador pattern allows the application to connect to
# upstream services via simple localhost addresses while Envoy handles
# service discovery, load balancing, retries, and circuit breaking

# deployment-envoy-ambassador.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-with-envoy-ambassador
  namespace: production
spec:
  template:
    spec:
      volumes:
        - name: envoy-config
          configMap:
            name: envoy-ambassador-config
      containers:
        - name: app
          image: gcr.io/my-org/app:1.0.0
          env:
            # App calls "localhost:8001" — Envoy ambassador routes it
            # to the correct upstream based on path
            - name: UPSTREAM_API
              value: http://localhost:8001

        - name: envoy
          image: envoyproxy/envoy:v1.29-latest
          args:
            - "-c"
            - "/etc/envoy/envoy.yaml"
            - "--log-level"
            - "warn"
          ports:
            - containerPort: 8001   # Listens for app requests
            - containerPort: 9901   # Admin interface
          volumeMounts:
            - name: envoy-config
              mountPath: /etc/envoy
              readOnly: true
          resources:
            requests:
              cpu: 100m
              memory: 64Mi
            limits:
              memory: 128Mi
```

## Pattern 4: Adapter Pattern (Protocol Translation)

The adapter pattern translates the application's output format to a format expected by the infrastructure. Unlike the ambassador (which handles outbound traffic), the adapter handles inbound requests or translates output.

### StatsD to Prometheus Adapter

```yaml
# Many legacy applications emit StatsD metrics.
# The adapter receives StatsD and exposes Prometheus format metrics.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: legacy-app-with-metrics-adapter
  namespace: production
spec:
  template:
    metadata:
      annotations:
        # Prometheus will scrape the adapter sidecar's port, not the app
        prometheus.io/scrape: "true"
        prometheus.io/port: "9102"
    spec:
      containers:
        - name: app
          image: gcr.io/my-org/legacy-statsd-app:3.0
          env:
            # App sends StatsD metrics to localhost:8125
            - name: STATSD_HOST
              value: localhost
            - name: STATSD_PORT
              value: "8125"

        # StatsD to Prometheus adapter
        - name: statsd-exporter
          image: prom/statsd-exporter:v0.27.0
          args:
            - "--statsd.listen-udp=:8125"
            - "--web.listen-address=:9102"
            - "--statsd.mapping-config=/etc/statsd/mappings.yaml"
          ports:
            - containerPort: 8125
              protocol: UDP
              name: statsd
            - containerPort: 9102
              name: prometheus
          resources:
            requests:
              cpu: 50m
              memory: 32Mi
            limits:
              memory: 64Mi
```

## Native Sidecar Containers (KEP-753)

Prior to Kubernetes 1.29, sidecars were regular containers with the same lifecycle as the primary container. This caused several problems:

1. Init containers run before sidecars, so if an init container needed to communicate with a sidecar (e.g., Vault agent), this was impossible
2. In Jobs, the sidecar would keep the Job pod running after the main container exited
3. Probe ordering: the sidecar might not be ready before the primary container started

Native sidecars (KEP-753, stable in 1.29) address this by introducing a new `initContainer` with `restartPolicy: Always`.

```yaml
# deployment-native-sidecars.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-with-native-sidecars
  namespace: production
spec:
  template:
    spec:
      initContainers:
        # This is a native sidecar: it starts before other init containers
        # and keeps running for the lifetime of the pod
        - name: vault-agent
          image: hashicorp/vault-agent:1.16
          restartPolicy: Always  # This makes it a native sidecar
          args:
            - agent
            - -config=/vault/config/vault-agent-config.hcl
          volumeMounts:
            - name: vault-token
              mountPath: /vault/secrets
            - name: vault-config
              mountPath: /vault/config
          # The startupProbe ensures later init containers and the main
          # container do not start until Vault agent has obtained secrets
          startupProbe:
            exec:
              command:
                - test
                - -f
                - /vault/secrets/db-password
            initialDelaySeconds: 2
            periodSeconds: 1
            failureThreshold: 60  # Wait up to 60 seconds for Vault

        # Regular init container — runs AFTER vault-agent is ready
        # Can access secrets rendered by vault-agent
        - name: db-migrator
          image: gcr.io/my-org/db-migrator:1.2.0
          command:
            - /bin/sh
            - -c
            - |
              export DB_PASSWORD=$(cat /vault/secrets/db-password)
              ./migrate --direction=up
          volumeMounts:
            - name: vault-token
              mountPath: /vault/secrets

        # Second native sidecar: Fluent Bit log forwarder
        - name: fluent-bit
          image: fluent/fluent-bit:3.1
          restartPolicy: Always  # Native sidecar
          volumeMounts:
            - name: app-logs
              mountPath: /var/log/app
              readOnly: true
            - name: fluent-bit-config
              mountPath: /fluent-bit/etc

      containers:
        - name: app
          image: gcr.io/my-org/app:1.5.3
          volumeMounts:
            - name: vault-token
              mountPath: /vault/secrets
              readOnly: true
            - name: app-logs
              mountPath: /var/log/app

      volumes:
        - name: vault-token
          emptyDir:
            medium: Memory  # Store secrets in memory, not on disk
        - name: vault-config
          configMap:
            name: vault-agent-config
        - name: app-logs
          emptyDir: {}
        - name: fluent-bit-config
          configMap:
            name: fluent-bit-config
```

### Native Sidecar in a Job (Critical Use Case)

Before native sidecars, log forwarder sidecars would prevent Jobs from completing because the sidecar never exited.

```yaml
# job-with-native-sidecar.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: data-processor
  namespace: production
spec:
  template:
    spec:
      restartPolicy: OnFailure
      initContainers:
        # Native sidecar log forwarder
        # When the main container (data-processor) exits, this sidecar
        # terminates automatically — the Job can then complete
        - name: fluent-bit
          image: fluent/fluent-bit:3.1
          restartPolicy: Always  # Native sidecar — exits when pod terminates
          volumeMounts:
            - name: job-logs
              mountPath: /var/log/job
              readOnly: true
            - name: fluent-bit-config
              mountPath: /fluent-bit/etc
      containers:
        - name: data-processor
          image: gcr.io/my-org/data-processor:2.0.0
          command:
            - /bin/sh
            - -c
            - |
              # Process data and write structured logs
              ./process-data --input s3://data-bucket/input \
                             --output s3://data-bucket/output \
                             2>&1 | tee /var/log/job/processor.log
          volumeMounts:
            - name: job-logs
              mountPath: /var/log/job
      volumes:
        - name: job-logs
          emptyDir: {}
        - name: fluent-bit-config
          configMap:
            name: fluent-bit-config
```

## Lifecycle Coordination Between Containers

### PreStop Hook for Graceful Shutdown

When a pod receives SIGTERM, all containers receive it simultaneously. This can cause log data to be lost if the application flushes its log files but the log forwarder has already exited.

```yaml
containers:
  - name: app
    image: gcr.io/my-org/app:1.5.3
    lifecycle:
      preStop:
        exec:
          # Give the application time to finish writing logs before
          # the log forwarder starts shutting down
          # This runs before SIGTERM is sent to the container
          command:
            - /bin/sh
            - -c
            - |
              # Signal the app to finish current requests
              kill -TERM $(pgrep app)
              # Wait for log file to be fully written
              sleep 5

  - name: fluent-bit
    image: fluent/fluent-bit:3.1
    lifecycle:
      preStop:
        exec:
          # Wait for the application to finish writing before stopping
          command:
            - /bin/sh
            - -c
            - |
              # Wait for the application log file to stop growing
              LOGFILE="/var/log/app/access.log"
              LAST_SIZE=0
              SAME_COUNT=0
              while [ $SAME_COUNT -lt 3 ]; do
                CURRENT_SIZE=$(stat -c %s ${LOGFILE} 2>/dev/null || echo 0)
                if [ "${CURRENT_SIZE}" = "${LAST_SIZE}" ]; then
                  SAME_COUNT=$((SAME_COUNT + 1))
                else
                  SAME_COUNT=0
                fi
                LAST_SIZE=${CURRENT_SIZE}
                sleep 1
              done
              # Send a flush command to Fluent Bit
              curl -X POST http://localhost:2020/api/v1/push
```

### Init Container to Sidecar Dependency

When the application requires a sidecar to be ready before it starts (e.g., Vault agent must render secrets, Envoy must be ready for outbound traffic):

```yaml
spec:
  initContainers:
    # Vault agent as native sidecar
    - name: vault-agent
      image: hashicorp/vault-agent:1.16
      restartPolicy: Always
      startupProbe:
        exec:
          command: ["test", "-f", "/vault/secrets/.done"]
        periodSeconds: 1
        failureThreshold: 60

    # Wait for Envoy to be ready (also a native sidecar)
    - name: envoy
      image: envoyproxy/envoy:v1.29-latest
      restartPolicy: Always
      # Envoy's admin port serves /ready when all clusters are warmed up
      startupProbe:
        httpGet:
          path: /ready
          port: 9901
        periodSeconds: 1
        failureThreshold: 30

    # Regular init: verify the database is reachable via the Envoy ambassador
    - name: wait-for-db
      image: postgres:16-alpine
      command:
        - sh
        - -c
        - |
          until pg_isready -h localhost -p 5432 -U app_user; do
            echo "Waiting for database connection via ambassador..."
            sleep 2
          done

  containers:
    - name: app
      image: gcr.io/my-org/app:1.5.3
      # At this point: Vault agent has rendered secrets, Envoy is ready,
      # and the database is reachable
```

## Resource Sharing and Limits

Sidecar containers consume real resources and must be properly sized. Under-provisioning sidecars causes them to be OOMKilled or CPU-throttled, which can be worse than not having them at all.

```yaml
# Resource guidelines for common sidecar types:
containers:
  - name: app
    resources:
      requests:
        cpu: 500m
        memory: 512Mi
      limits:
        memory: 1Gi

  # Log forwarder (Fluent Bit): very lightweight
  - name: fluent-bit
    resources:
      requests:
        cpu: 50m
        memory: 64Mi
      limits:
        cpu: 100m
        memory: 128Mi

  # Envoy proxy sidecar: depends on throughput
  # Scale up MaxIdleConns proportionally with requests/sec
  - name: envoy
    resources:
      requests:
        cpu: 100m
        memory: 64Mi
      limits:
        cpu: 500m     # Burst headroom for spikes
        memory: 128Mi

  # Vault agent: mostly idle, occasional renewal
  - name: vault-agent
    resources:
      requests:
        cpu: 10m
        memory: 32Mi
      limits:
        cpu: 100m
        memory: 64Mi

  # PgBouncer: low resource but needs memory proportional to max_client_conn
  - name: pgbouncer
    resources:
      requests:
        cpu: 50m
        memory: 32Mi
      limits:
        cpu: 200m
        memory: 64Mi
```

## Mutating Webhook for Automatic Sidecar Injection

Platform teams can inject sidecars automatically without requiring application teams to modify their Deployments. This is how Istio, Vault agent, and Datadog work.

```go
// cmd/sidecar-injector/main.go
// A minimal mutating webhook that injects a log forwarder sidecar
package main

import (
    "encoding/json"
    "fmt"
    "net/http"

    admissionv1 "k8s.io/api/admission/v1"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// JSONPatch represents a single JSON patch operation.
type JSONPatch struct {
    Op    string      `json:"op"`
    Path  string      `json:"path"`
    Value interface{} `json:"value,omitempty"`
}

// injectHandler handles admission webhook requests.
func injectHandler(w http.ResponseWriter, r *http.Request) {
    var admReview admissionv1.AdmissionReview
    if err := json.NewDecoder(r.Body).Decode(&admReview); err != nil {
        http.Error(w, fmt.Sprintf("decoding admission review: %v", err), http.StatusBadRequest)
        return
    }

    req := admReview.Request
    var pod corev1.Pod
    if err := json.Unmarshal(req.Object.Raw, &pod); err != nil {
        http.Error(w, fmt.Sprintf("decoding pod: %v", err), http.StatusBadRequest)
        return
    }

    // Check if injection is requested via annotation
    if pod.Annotations["sidecar-injector.example.com/inject"] != "true" {
        // Return allow without mutation
        admReview.Response = &admissionv1.AdmissionResponse{
            UID:     req.UID,
            Allowed: true,
        }
        json.NewEncoder(w).Encode(admReview)
        return
    }

    // Build the sidecar container
    sidecar := corev1.Container{
        Name:  "fluent-bit",
        Image: "fluent/fluent-bit:3.1",
        VolumeMounts: []corev1.VolumeMount{
            {Name: "app-logs", MountPath: "/var/log/app", ReadOnly: true},
            {Name: "fluent-bit-config", MountPath: "/fluent-bit/etc"},
        },
        Resources: corev1.ResourceRequirements{
            Requests: corev1.ResourceList{
                corev1.ResourceCPU:    resourceMustParse("50m"),
                corev1.ResourceMemory: resourceMustParse("64Mi"),
            },
        },
    }

    // Create JSON patch operations
    patches := []JSONPatch{
        {
            Op:    "add",
            Path:  "/spec/containers/-",
            Value: sidecar,
        },
    }

    // If the app-logs volume does not exist, add it
    if !hasVolume(pod, "app-logs") {
        patches = append(patches, JSONPatch{
            Op:   "add",
            Path: "/spec/volumes/-",
            Value: corev1.Volume{
                Name: "app-logs",
                VolumeSource: corev1.VolumeSource{
                    EmptyDir: &corev1.EmptyDirVolumeSource{},
                },
            },
        })
    }

    patchBytes, _ := json.Marshal(patches)
    patchType := admissionv1.PatchTypeJSONPatch

    admReview.Response = &admissionv1.AdmissionResponse{
        UID:       req.UID,
        Allowed:   true,
        Patch:     patchBytes,
        PatchType: &patchType,
        Result: &metav1.Status{
            Message: "Fluent Bit sidecar injected",
        },
    }

    json.NewEncoder(w).Encode(admReview)
}

func hasVolume(pod corev1.Pod, name string) bool {
    for _, v := range pod.Spec.Volumes {
        if v.Name == name {
            return true
        }
    }
    return false
}
```

## Debugging Sidecar Interactions

```bash
# View all containers in a pod including sidecars
kubectl get pod my-app-7d4b9c-xk2lm -o jsonpath='{.spec.containers[*].name}'

# Get logs from a specific sidecar
kubectl logs my-app-7d4b9c-xk2lm -c fluent-bit -f

# Get logs from all containers simultaneously
kubectl logs my-app-7d4b9c-xk2lm --all-containers=true --prefix=true

# Exec into a specific sidecar for debugging
kubectl exec -it my-app-7d4b9c-xk2lm -c pgbouncer -- /bin/sh

# Check the shared volume content between containers
kubectl exec my-app-7d4b9c-xk2lm -c fluent-bit -- ls -la /var/log/app/

# Describe the pod to see resource usage and events across all containers
kubectl describe pod my-app-7d4b9c-xk2lm

# Watch resource usage across all containers in the pod
kubectl top pod my-app-7d4b9c-xk2lm --containers

# Check if the sidecar's port is accessible via localhost
kubectl exec my-app-7d4b9c-xk2lm -c app -- curl -s http://localhost:5432
```

## Summary

The four sidecar patterns — log forwarder, metrics exporter, ambassador, and adapter — each address a distinct infrastructure concern without requiring application code changes. The log forwarder and metrics exporter patterns decouple telemetry collection from application logic, enabling standardized logging and metrics across heterogeneous application stacks. The ambassador pattern allows applications to use simplified connection strings while the ambassador handles connection pooling, failover, and service discovery complexity. The adapter pattern bridges protocol mismatches between legacy applications and modern infrastructure. Native sidecar containers, introduced in Kubernetes 1.29 via KEP-753, resolve the long-standing lifecycle ordering problems that made sidecars unreliable in Jobs and in scenarios requiring ordered startup. Proper lifecycle coordination via PreStop hooks, startup probes on native sidecars, and resource provisioning proportional to actual sidecar workload are the operational details that determine whether these patterns work smoothly in production.
