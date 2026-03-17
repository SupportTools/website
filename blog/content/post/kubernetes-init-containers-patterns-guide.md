---
title: "Kubernetes Init Containers: Database Migration, Config Bootstrap, and Sidecar Patterns"
date: 2028-01-17T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Init Containers", "Database Migrations", "Sidecar", "Istio", "Patterns"]
categories: ["Kubernetes", "Application Patterns"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Kubernetes init container patterns covering database migration initialization, config template rendering, wait-for-dependency patterns, sidecar injection, Istio interaction, and the native sidecar containers feature from KEP-753."
more_link: "yes"
url: "/kubernetes-init-containers-patterns-guide/"
---

Init containers execute before application containers start, run to completion before the next container begins, and share the pod's volumes and network namespace with all containers in the pod. This execution model solves a class of bootstrapping problems that regular containers cannot: ensuring migrations complete before applications start, rendering configuration from templates using secrets, waiting for external dependencies to become available, and setting up shared state that sidecars and application containers both require.

<!--more-->

# Kubernetes Init Containers: Database Migration, Config Bootstrap, and Sidecar Patterns

## Section 1: Init Container Fundamentals

### Execution Model

Init containers run sequentially in the order defined. Each must exit with code 0 before the next starts. If any init container fails, Kubernetes restarts it according to the pod's `restartPolicy`. For regular pods, `restartPolicy: Always` causes indefinite retries; for Jobs, `restartPolicy: Never` causes the pod to fail immediately.

```yaml
# init-container-execution-model.yaml
apiVersion: v1
kind: Pod
metadata:
  name: execution-model-demo
spec:
  initContainers:
    # Step 1: Runs first, must succeed before Step 2 starts
    - name: step-1-network-check
      image: busybox:1.36
      command:
        - sh
        - -c
        - |
          echo "Init container 1: checking network..."
          # This init container exits 0 immediately
          echo "Network check passed"

    # Step 2: Runs only after Step 1 completes successfully
    - name: step-2-wait-for-db
      image: postgres:16.2
      command:
        - sh
        - -c
        - |
          echo "Init container 2: waiting for database..."
          until pg_isready -h postgres-service -p 5432; do
            echo "Database not ready, waiting 5s..."
            sleep 5
          done
          echo "Database is ready"

    # Step 3: Runs only after Step 2 completes successfully
    - name: step-3-run-migrations
      image: flyway/flyway:10.10
      args:
        - -url=jdbc:postgresql://postgres-service:5432/appdb
        - -schemas=public
        - migrate
      envFrom:
        - secretRef:
            name: database-credentials
      volumeMounts:
        - name: migrations
          mountPath: /flyway/sql

  containers:
    # Application starts only after all init containers complete
    - name: application
      image: app:latest

  volumes:
    - name: migrations
      configMap:
        name: db-migrations
```

### Resource Handling for Init Containers

Init containers do not run concurrently, so resource requests for the pod are the maximum of:
- The largest request across all init containers, OR
- The sum of all regular container requests

This matters for cluster scheduling and quota management.

```yaml
# init-container-resource-sizing.yaml
apiVersion: v1
kind: Pod
metadata:
  name: resource-aware-init
spec:
  initContainers:
    # This init container needs more resources temporarily for migration work
    - name: run-migrations
      image: flyway/flyway:10.10
      resources:
        requests:
          cpu: 1000m      # 1 CPU for migration processing
          memory: 512Mi
        limits:
          cpu: 2000m
          memory: 1Gi
      args:
        - migrate

  containers:
    - name: application
      image: app:latest
      resources:
        requests:
          cpu: 200m       # Application only needs 200m in steady state
          memory: 256Mi
        limits:
          cpu: 500m
          memory: 512Mi
  # Effective pod resource request during init phase: 1000m CPU, 512Mi memory
  # Effective pod resource request during running phase: 200m CPU, 256Mi memory
```

## Section 2: Database Migration Patterns

### Pattern 1: Flyway Migrations

```yaml
# flyway-migration-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: user-service
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: user-service
  template:
    metadata:
      labels:
        app: user-service
    spec:
      serviceAccountName: user-service
      initContainers:
        - name: flyway-migrate
          image: flyway/flyway:10.10-alpine
          # Use the repair command before migrate to handle checksum mismatches
          # in development environments where SQL files may have been modified
          args:
            - -url=jdbc:postgresql://$(DB_HOST):$(DB_PORT)/$(DB_NAME)
            - -user=$(DB_USER)
            - -password=$(DB_PASSWORD)
            - -schemas=$(DB_SCHEMA)
            - -locations=filesystem:/flyway/sql
            - -validateOnMigrate=true
            - -outOfOrder=false
            - migrate
          env:
            - name: DB_HOST
              valueFrom:
                secretKeyRef:
                  name: database-credentials
                  key: host
            - name: DB_PORT
              valueFrom:
                secretKeyRef:
                  name: database-credentials
                  key: port
            - name: DB_NAME
              valueFrom:
                secretKeyRef:
                  name: database-credentials
                  key: database
            - name: DB_USER
              valueFrom:
                secretKeyRef:
                  name: database-credentials
                  key: username
            - name: DB_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: database-credentials
                  key: password
            - name: DB_SCHEMA
              value: "public"
          volumeMounts:
            - name: migrations
              mountPath: /flyway/sql
              readOnly: true
          resources:
            requests:
              cpu: 500m
              memory: 256Mi
            limits:
              cpu: 1000m
              memory: 512Mi

      containers:
        - name: user-service
          image: user-service:2.5.1
          ports:
            - containerPort: 8080
          env:
            - name: DB_HOST
              valueFrom:
                secretKeyRef:
                  name: database-credentials
                  key: host
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
            limits:
              cpu: 1000m
              memory: 512Mi

      volumes:
        - name: migrations
          configMap:
            name: flyway-migrations
---
# flyway-migrations-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: flyway-migrations
  namespace: production
data:
  # Flyway naming convention: V{version}__{description}.sql
  V1__create_users_table.sql: |
    CREATE TABLE IF NOT EXISTS users (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email       VARCHAR(255) UNIQUE NOT NULL,
      created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_email
      ON users (email);

  V2__add_users_status.sql: |
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active',
      ADD COLUMN IF NOT EXISTS last_login TIMESTAMP WITH TIME ZONE;

    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_status
      ON users (status) WHERE status != 'active';

  V3__create_audit_log.sql: |
    CREATE TABLE IF NOT EXISTS user_audit_log (
      id          BIGSERIAL PRIMARY KEY,
      user_id     UUID NOT NULL REFERENCES users(id),
      action      VARCHAR(100) NOT NULL,
      metadata    JSONB,
      performed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_user_id
      ON user_audit_log (user_id);
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_performed_at
      ON user_audit_log (performed_at);
```

### Pattern 2: Goose Migrations (Go-Native)

```yaml
# goose-migration-init-container.yaml
# For Go services using the github.com/pressly/goose migration library
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
  namespace: production
spec:
  selector:
    matchLabels:
      app: order-service
  template:
    spec:
      initContainers:
        - name: goose-migrate
          # Build a dedicated migration image containing only goose and SQL files
          image: registry.example.com/order-service-migrations:2.5.1
          command:
            - /usr/local/bin/goose
            - -dir=/migrations
            - postgres
            - $(DATABASE_URL)
            - up
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: order-service-db
                  key: database_url
            - name: GOOSE_LOCK_TIMEOUT
              value: "60s"  # Prevent long-running lock waits
          resources:
            requests:
              cpu: 200m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 256Mi
      containers:
        - name: order-service
          image: registry.example.com/order-service:2.5.1
```

### Pattern 3: Migration Locking for Concurrent Deployments

When rolling updates run, multiple pods attempt migrations simultaneously. A distributed lock prevents concurrent migration execution.

```yaml
# migration-with-lock.yaml
# Uses a Kubernetes lease as a distributed lock before running migrations
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  namespace: production
spec:
  selector:
    matchLabels:
      app: payment-service
  template:
    spec:
      serviceAccountName: payment-service-migration
      initContainers:
        - name: acquire-migration-lock
          image: bitnami/kubectl:1.29
          command:
            - /bin/bash
            - -c
            - |
              set -euo pipefail
              LEASE_NAME="payment-service-migration-lock"
              NAMESPACE="${POD_NAMESPACE}"
              HOLDER="${POD_NAME}"
              MAX_WAIT=300  # Wait up to 5 minutes for lock
              ELAPSED=0

              echo "Attempting to acquire migration lock..."

              while true; do
                # Try to create a Lease object as a distributed lock
                if kubectl create lease "${LEASE_NAME}" \
                  -n "${NAMESPACE}" \
                  --duration=5m \
                  2>/dev/null; then
                  echo "Lock acquired by ${HOLDER}"
                  break
                fi

                # Check if lock is stale (older than 10 minutes)
                LOCK_AGE=$(kubectl get lease "${LEASE_NAME}" \
                  -n "${NAMESPACE}" \
                  -o jsonpath='{.metadata.creationTimestamp}' 2>/dev/null || echo "")

                if [[ -n "${LOCK_AGE}" ]]; then
                  # Lease exists — wait for it to expire or be released
                  echo "Migration lock held, waiting... (${ELAPSED}s/${MAX_WAIT}s)"
                fi

                if [[ ${ELAPSED} -ge ${MAX_WAIT} ]]; then
                  echo "ERROR: Timed out waiting for migration lock"
                  exit 1
                fi

                sleep 10
                ELAPSED=$((ELAPSED + 10))
              done
          env:
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: POD_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace

        - name: run-migrations
          image: flyway/flyway:10.10-alpine
          args:
            - migrate
          envFrom:
            - secretRef:
                name: payment-service-db-credentials

        - name: release-migration-lock
          image: bitnami/kubectl:1.29
          command:
            - kubectl
            - delete
            - lease
            - payment-service-migration-lock
            - -n
            - $(POD_NAMESPACE)
            - --ignore-not-found
          env:
            - name: POD_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace

      containers:
        - name: payment-service
          image: registry.example.com/payment-service:3.1.0
```

## Section 3: Configuration Bootstrap Patterns

### Rendering Templates with Environment Variables

```yaml
# config-template-init.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx-dynamic-config
  namespace: production
spec:
  selector:
    matchLabels:
      app: nginx-dynamic-config
  template:
    spec:
      initContainers:
        - name: render-config
          image: busybox:1.36
          command:
            - sh
            - -c
            - |
              set -euo pipefail
              echo "Rendering nginx configuration from template..."

              # Replace placeholders in the template with environment variables
              # Uses envsubst which is available in Alpine-based images
              # For busybox, use sed with explicit variable substitution
              sed \
                -e "s|__UPSTREAM_HOST__|${UPSTREAM_HOST}|g" \
                -e "s|__UPSTREAM_PORT__|${UPSTREAM_PORT}|g" \
                -e "s|__SERVER_NAME__|${SERVER_NAME}|g" \
                -e "s|__WORKER_PROCESSES__|${WORKER_PROCESSES:-auto}|g" \
                /config-template/nginx.conf.tmpl \
                > /config-rendered/nginx.conf

              echo "Validating rendered configuration..."
              # nginx -t requires the nginx binary — use a separate validation container
              # or accept that template rendering is sufficient for this pattern
              echo "Configuration rendered successfully:"
              cat /config-rendered/nginx.conf
          env:
            - name: UPSTREAM_HOST
              value: "backend-service.production.svc.cluster.local"
            - name: UPSTREAM_PORT
              value: "8080"
            - name: SERVER_NAME
              valueFrom:
                configMapKeyRef:
                  name: nginx-config-vars
                  key: server_name
          volumeMounts:
            - name: config-template
              mountPath: /config-template
              readOnly: true
            - name: config-rendered
              mountPath: /config-rendered

      containers:
        - name: nginx
          image: nginx:1.25-alpine
          volumeMounts:
            - name: config-rendered
              mountPath: /etc/nginx/conf.d
          ports:
            - containerPort: 80

      volumes:
        - name: config-template
          configMap:
            name: nginx-config-template
        # EmptyDir shared between init container and application container
        - name: config-rendered
          emptyDir: {}
```

### Vault Secret Injection Pattern

```yaml
# vault-init-container.yaml
# Pull secrets from HashiCorp Vault into shared emptyDir
# before application container starts
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vault-secret-consumer
  namespace: production
spec:
  selector:
    matchLabels:
      app: vault-secret-consumer
  template:
    spec:
      serviceAccountName: vault-secret-consumer
      initContainers:
        - name: vault-secret-injector
          image: hashicorp/vault:1.16
          command:
            - sh
            - -c
            - |
              set -euo pipefail

              # Authenticate with Vault using Kubernetes service account token
              VAULT_TOKEN=$(vault write auth/kubernetes/login \
                role=payment-service \
                jwt="$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)" \
                -format=json | jq -r '.auth.client_token')

              # Retrieve secrets and write to shared volume as env file
              vault kv get \
                -field=database_url \
                secret/payment-service/database \
                > /secrets/database_url

              vault kv get \
                -field=api_key \
                secret/payment-service/stripe \
                > /secrets/stripe_api_key

              # Create .env file for dotenv-compatible applications
              vault kv get \
                -format=json \
                secret/payment-service \
                | jq -r '.data.data | to_entries[] | "\(.key | ascii_upcase)=\(.value)"' \
                > /secrets/.env

              echo "Secrets retrieved and written to /secrets"
              # Clear Vault token from memory
              unset VAULT_TOKEN
          env:
            - name: VAULT_ADDR
              value: "https://vault.vault.svc.cluster.local:8200"
            - name: VAULT_CACERT
              value: "/vault/tls/ca.crt"
          volumeMounts:
            - name: secrets
              mountPath: /secrets
            - name: vault-tls
              mountPath: /vault/tls
              readOnly: true
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 100m
              memory: 128Mi

      containers:
        - name: payment-service
          image: registry.example.com/payment-service:3.1.0
          envFrom:
            - secretRef:
                name: payment-service-base-config
          volumeMounts:
            - name: secrets
              mountPath: /run/secrets
              readOnly: true

      volumes:
        - name: secrets
          emptyDir:
            medium: Memory  # Secrets stored in tmpfs, not disk
        - name: vault-tls
          secret:
            secretName: vault-tls-ca
```

## Section 4: Wait-For-Dependency Patterns

### Waiting for Services with Exponential Backoff

```yaml
# wait-for-dependency-init.yaml
# Robust wait pattern with exponential backoff and maximum timeout
apiVersion: v1
kind: Pod
metadata:
  name: dependency-wait-demo
spec:
  initContainers:
    - name: wait-for-postgres
      image: postgres:16.2-alpine
      command:
        - /bin/sh
        - -c
        - |
          #!/bin/sh
          set -e
          MAX_RETRIES=60
          RETRY_INTERVAL=5
          RETRY=0
          DB_HOST="${DB_HOST}"
          DB_PORT="${DB_PORT:-5432}"

          echo "Waiting for PostgreSQL at ${DB_HOST}:${DB_PORT}..."

          until pg_isready -h "${DB_HOST}" -p "${DB_PORT}" -q; do
            RETRY=$((RETRY + 1))
            if [ ${RETRY} -ge ${MAX_RETRIES} ]; then
              echo "ERROR: PostgreSQL did not become ready after $((MAX_RETRIES * RETRY_INTERVAL)) seconds"
              exit 1
            fi
            echo "PostgreSQL not ready (attempt ${RETRY}/${MAX_RETRIES}), retrying in ${RETRY_INTERVAL}s..."
            sleep ${RETRY_INTERVAL}
          done
          echo "PostgreSQL is ready after $((RETRY * RETRY_INTERVAL)) seconds"
      env:
        - name: DB_HOST
          value: "postgres-service.databases.svc.cluster.local"
        - name: DB_PORT
          value: "5432"

    - name: wait-for-redis
      image: redis:7.2-alpine
      command:
        - /bin/sh
        - -c
        - |
          REDIS_HOST="${REDIS_HOST}"
          REDIS_PORT="${REDIS_PORT:-6379}"
          MAX_RETRIES=30
          RETRY=0

          echo "Waiting for Redis at ${REDIS_HOST}:${REDIS_PORT}..."

          until redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" ping | grep -q PONG; do
            RETRY=$((RETRY + 1))
            if [ ${RETRY} -ge ${MAX_RETRIES} ]; then
              echo "ERROR: Redis did not respond within timeout"
              exit 1
            fi
            echo "Redis not ready (${RETRY}/${MAX_RETRIES}), waiting 5s..."
            sleep 5
          done
          echo "Redis is ready"
      env:
        - name: REDIS_HOST
          value: "redis-service.caches.svc.cluster.local"

    - name: wait-for-kafka
      image: bitnami/kafka:3.7
      command:
        - /bin/sh
        - -c
        - |
          KAFKA_BROKERS="${KAFKA_BROKERS}"
          MAX_RETRIES=60
          RETRY=0

          echo "Waiting for Kafka brokers: ${KAFKA_BROKERS}..."

          until kafka-topics.sh \
            --bootstrap-server "${KAFKA_BROKERS}" \
            --list > /dev/null 2>&1; do
            RETRY=$((RETRY + 1))
            if [ ${RETRY} -ge ${MAX_RETRIES} ]; then
              echo "ERROR: Kafka brokers unreachable after timeout"
              exit 1
            fi
            echo "Kafka not ready (${RETRY}/${MAX_RETRIES}), waiting 5s..."
            sleep 5
          done
          echo "Kafka is ready"
      env:
        - name: KAFKA_BROKERS
          value: "kafka-0.kafka-headless.messaging.svc.cluster.local:9092,kafka-1.kafka-headless.messaging.svc.cluster.local:9092,kafka-2.kafka-headless.messaging.svc.cluster.local:9092"

  containers:
    - name: application
      image: app:latest
```

## Section 5: Shared Volume Patterns

### Preloading Static Assets

```yaml
# static-asset-preload-init.yaml
# Download and validate static assets before serving
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-frontend
  namespace: production
spec:
  selector:
    matchLabels:
      app: web-frontend
  template:
    spec:
      initContainers:
        - name: download-assets
          image: curlimages/curl:8.6.0
          command:
            - sh
            - -c
            - |
              set -euo pipefail

              ASSETS_BASE_URL="https://cdn.example.com/assets/v${APP_VERSION}"
              DEST_DIR="/static"

              echo "Downloading static assets for version ${APP_VERSION}..."

              # Download and verify each asset bundle
              for BUNDLE in main.js main.css fonts.css images.tar.gz; do
                echo "Downloading ${BUNDLE}..."
                curl -fsSL \
                  --retry 3 \
                  --retry-delay 5 \
                  --max-time 120 \
                  "${ASSETS_BASE_URL}/${BUNDLE}" \
                  -o "${DEST_DIR}/${BUNDLE}"

                # Verify checksum if manifest is available
                if curl -fsSL "${ASSETS_BASE_URL}/checksums.sha256" \
                  -o /tmp/checksums.sha256 2>/dev/null; then
                  echo "Verifying checksum for ${BUNDLE}..."
                  grep "${BUNDLE}" /tmp/checksums.sha256 | \
                    sha256sum -c - || {
                      echo "ERROR: Checksum verification failed for ${BUNDLE}"
                      exit 1
                    }
                fi
              done

              # Extract image archive
              tar -xzf "${DEST_DIR}/images.tar.gz" -C "${DEST_DIR}/images/"

              echo "All assets downloaded and verified."
              ls -la "${DEST_DIR}"
          env:
            - name: APP_VERSION
              value: "2.1.0"
          volumeMounts:
            - name: static-assets
              mountPath: /static
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi

      containers:
        - name: nginx
          image: nginx:1.25-alpine
          volumeMounts:
            - name: static-assets
              mountPath: /usr/share/nginx/html/static
              readOnly: true
          ports:
            - containerPort: 80

      volumes:
        - name: static-assets
          emptyDir:
            sizeLimit: 2Gi  # Prevent unbounded disk usage
```

## Section 6: Istio Init Container Interaction

Istio injects its own init container (`istio-init`) and a sidecar container (`istio-proxy`) into every pod in an injection-enabled namespace. The `istio-init` container configures iptables rules to intercept all traffic through the Envoy proxy.

### Ordering Considerations with Istio

```yaml
# istio-init-interaction.yaml
# Demonstrates issues that arise when init containers need network access
# but run before Istio's iptables rules are configured

# The istio-init container runs first, configuring iptables
# All subsequent init containers have traffic routed through Envoy
# This means init containers that make outbound calls will:
# 1. Have traffic intercepted by Envoy
# 2. Need mTLS certificates if the target requires mTLS
# 3. Respect Istio's AuthorizationPolicy

# For database migration init containers that connect to databases
# protected by Istio PeerAuthentication requiring STRICT mTLS:
# The init container must be able to present a valid Envoy client cert.
# Since Istio injects both istio-init AND istio-proxy, and the proxy
# starts alongside regular containers (not init containers), there is
# a race condition during the init container phase.

# Solution 1: Annotate the pod to hold application start until Envoy is ready
metadata:
  annotations:
    # Wait for Envoy to be ready before starting containers (including init)
    # This annotation is respected by Istio 1.7+ with holdApplicationUntilProxyStarts=true
    proxy.istio.io/config: |
      holdApplicationUntilProxyStarts: true
    # Exclude init container traffic from Istio interception
    # This allows init containers to bypass Envoy entirely
    traffic.sidecar.istio.io/excludeOutboundIPRanges: "10.0.0.0/8"

# Solution 2: Exclude specific ports from Istio interception for init containers
metadata:
  annotations:
    # Port 5432 (PostgreSQL) traffic bypasses Envoy for init containers
    traffic.sidecar.istio.io/excludeOutboundPorts: "5432"
```

```yaml
# istio-aware-migration-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: istio-aware-service
  namespace: istio-injection-enabled
  annotations:
    # Ensure Envoy proxy is running before app containers start
    # This does NOT apply to init containers, which run before sidecars
spec:
  template:
    metadata:
      annotations:
        # Bypass Istio for database connections in init containers
        # The database should be protected by network policies instead
        traffic.sidecar.istio.io/excludeOutboundPorts: "5432,6379"
        # Hold application containers until Istio proxy is ready
        proxy.istio.io/config: |
          holdApplicationUntilProxyStarts: true
    spec:
      initContainers:
        - name: run-migrations
          image: flyway/flyway:10.10-alpine
          # This init container connects directly to PostgreSQL on port 5432
          # Port 5432 is excluded from Istio interception via the annotation above
          args:
            - migrate
          envFrom:
            - secretRef:
                name: database-credentials
      containers:
        - name: application
          image: app:latest
```

## Section 7: Native Sidecar Containers (KEP-753)

Kubernetes 1.29 introduced native sidecar containers (alpha), graduating to beta in 1.30. This feature addresses the fundamental limitation of sidecars implemented as regular containers: they cannot be guaranteed to start before application containers or outlive them on shutdown.

### The Problem with Traditional Sidecar Implementation

```yaml
# traditional-sidecar-problem.yaml
# PROBLEM: Traditional sidecar via regular container
# The logging agent and application start concurrently.
# If the application writes logs before the agent starts,
# those logs may be lost. On pod shutdown, the application
# may stop before the agent has flushed all buffered logs.
apiVersion: v1
kind: Pod
metadata:
  name: traditional-sidecar-problem
spec:
  containers:
    # Regular container — starts concurrently with application
    # No guarantee it starts first
    - name: log-agent
      image: fluent-bit:3.0
      # PROBLEM: May start after the application generates its first logs

    - name: application
      image: app:latest
      # May generate logs before log-agent is ready
```

### Native Sidecar Container Solution

```yaml
# native-sidecar-containers.yaml
# Native sidecars via initContainers with restartPolicy: Always
# Available in Kubernetes 1.29+ (beta in 1.30)
apiVersion: v1
kind: Pod
metadata:
  name: native-sidecar-demo
spec:
  initContainers:
    # Native sidecar: runs as init container but restartPolicy: Always
    # means it keeps running alongside application containers
    - name: log-agent
      image: fluent-bit:3.0
      restartPolicy: Always  # This is what makes it a native sidecar
      # GUARANTEE: Starts before application containers
      # GUARANTEE: Stays running alongside application containers
      # GUARANTEE: On pod shutdown, app containers stop before this sidecar
      volumeMounts:
        - name: log-volume
          mountPath: /var/log/app
      resources:
        requests:
          cpu: 50m
          memory: 64Mi
        limits:
          cpu: 200m
          memory: 128Mi

    - name: envoy-proxy
      image: envoyproxy/envoy:v1.29-latest
      restartPolicy: Always  # Native sidecar
      # Envoy proxy guaranteed to be running before application receives traffic
      ports:
        - containerPort: 9901
          name: admin
      resources:
        requests:
          cpu: 100m
          memory: 128Mi
        limits:
          cpu: 500m
          memory: 256Mi

    # Regular init container — runs to completion, configures shared volume
    - name: config-renderer
      image: alpine:3.19
      # No restartPolicy — runs once and exits, like a traditional init container
      command:
        - sh
        - -c
        - |
          echo "Rendering configuration..."
          cp /config-template/* /config-rendered/
          echo "Done"
      volumeMounts:
        - name: config-rendered
          mountPath: /config-rendered

  containers:
    - name: application
      image: app:latest
      volumeMounts:
        - name: log-volume
          mountPath: /var/log/app
        - name: config-rendered
          mountPath: /etc/app/config

  volumes:
    - name: log-volume
      emptyDir: {}
    - name: config-rendered
      emptyDir: {}
```

### Native Sidecar Feature Gate Check

```bash
#!/bin/bash
# check-native-sidecar-support.sh
# Verify that the cluster supports native sidecar containers

KUBERNETES_VERSION=$(kubectl version -o json | jq -r '.serverVersion.gitVersion')
echo "Kubernetes version: ${KUBERNETES_VERSION}"

# Check for SidecarContainers feature gate (requires Kubernetes 1.29+)
# Method 1: Check kube-apiserver flags
kubectl get pod -n kube-system \
  -l component=kube-apiserver \
  -o jsonpath='{.items[0].spec.containers[0].command}' \
  | tr ',' '\n' \
  | grep -i "sidecar" || echo "SidecarContainers feature gate not explicitly set (may be default in 1.29+)"

# Method 2: Test if the feature is active by deploying a test pod
cat << 'EOF' | kubectl apply --dry-run=server -f - 2>&1
apiVersion: v1
kind: Pod
metadata:
  name: sidecar-feature-test
  namespace: default
spec:
  initContainers:
    - name: test-sidecar
      image: busybox:1.36
      restartPolicy: Always
      command: ["sleep", "infinity"]
  containers:
    - name: app
      image: busybox:1.36
      command: ["sleep", "10"]
EOF
```

## Section 8: Security Considerations for Init Containers

### Minimal Privilege Init Containers

```yaml
# secure-init-containers.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: secure-init-demo
  namespace: production
spec:
  selector:
    matchLabels:
      app: secure-init-demo
  template:
    spec:
      # Pod-level security context
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault

      initContainers:
        - name: migration
          image: flyway/flyway:10.10-alpine
          securityContext:
            runAsUser: 1000  # Non-root user
            runAsGroup: 1000
            readOnlyRootFilesystem: true  # Prevent filesystem modifications
            allowPrivilegeEscalation: false
            capabilities:
              drop:
                - ALL  # Drop all Linux capabilities
          args:
            - migrate
          # Flyway needs a writable temp directory
          volumeMounts:
            - name: flyway-temp
              mountPath: /flyway/temp
          envFrom:
            - secretRef:
                name: database-credentials

      containers:
        - name: application
          image: app:latest
          securityContext:
            runAsUser: 1000
            runAsGroup: 1000
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
            capabilities:
              drop:
                - ALL

      volumes:
        - name: flyway-temp
          emptyDir: {}
```

## Summary

Init containers solve three distinct categories of bootstrapping problems:

**Sequencing and dependencies**: Database migrations must complete before applications start. Services must verify that their dependencies are reachable. These are hard requirements that restart-based application health checks cannot enforce—an application that starts and immediately crashes because its database schema does not match is a worse experience than a clearly communicating init container that blocks startup.

**Configuration materialization**: Secret injection, template rendering, and asset downloading all produce artifacts that application containers consume. The emptyDir shared volume pattern with Memory medium for sensitive data provides a secure, Kubernetes-native mechanism for passing this data without embedding it in images.

**Native sidecars**: KEP-753's native sidecar containers (`restartPolicy: Always` in initContainers) eliminate the race conditions and shutdown ordering problems that plagued sidecar implementations as regular containers. Logging agents, proxy sidecars, and monitoring agents all benefit from guaranteed startup and shutdown ordering relative to application containers.
