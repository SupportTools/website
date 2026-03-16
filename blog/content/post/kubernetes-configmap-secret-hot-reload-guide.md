---
title: "Kubernetes ConfigMap and Secret Hot Reload: Dynamic Configuration Without Restarts"
date: 2027-05-04T00:00:00-05:00
draft: false
tags: ["Kubernetes", "ConfigMap", "Secrets", "Hot Reload", "Reloader", "Configuration"]
categories: ["Kubernetes", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production patterns for Kubernetes ConfigMap and Secret hot reloading using Reloader, Stakater, volume mounts, inotify watchers, and application-level reload signals to enable zero-downtime configuration changes."
more_link: "yes"
url: "/kubernetes-configmap-secret-hot-reload-guide/"
---

Configuration changes should not require application restarts. In a Kubernetes cluster serving production traffic, a rolling restart to pick up a new feature flag, a changed log level, or a rotated TLS certificate introduces unnecessary risk: deployment rollout takes time, readiness probe cycles add latency, and misconfigured rolling update strategies can briefly reduce capacity. Several patterns exist for updating running containers when ConfigMaps or Secrets change, ranging from Kubernetes-native volume mount propagation to controller-driven rolling restarts to application-level filesystem watchers. Choosing the right approach depends on whether the application supports runtime reload, the sensitivity of the configuration being changed, and the operational complexity the team is willing to accept.

<!--more-->

# Kubernetes ConfigMap and Secret Hot Reload: Dynamic Configuration Without Restarts

## Understanding ConfigMap and Secret Update Mechanics

### Volume Mount Updates

When a ConfigMap or Secret is mounted as a volume, Kubernetes eventually propagates updates to the mounted files inside the container. The update mechanism uses symbolic links:

```
/etc/config/
├── ..data -> ..2027_05_04_12_00_00.12345678/  (symlink updated atomically)
├── app.conf -> ..data/app.conf
└── ..2027_05_04_12_00_00.12345678/
    └── app.conf
```

Kubernetes replaces the `..data` symlink atomically when the ConfigMap changes. From the application's perspective, reading `/etc/config/app.conf` transparently reads the new version. The delay between a ConfigMap update and the file update inside the container is controlled by:

- `kubelet --sync-frequency` (default: 1 minute)
- `kubelet --configmap-and-secret-change-detection-strategy` (default: Watch)

In practice, updates typically propagate within 1–2 minutes with default settings. The propagation can be made faster by reducing the kubelet sync frequency, but this increases kubelet API server load.

```bash
# Verify a ConfigMap volume mount has been updated
kubectl exec -it <pod-name> -n <namespace> -- \
  ls -la /etc/config/

# Check the current content of a mounted ConfigMap file
kubectl exec -it <pod-name> -n <namespace> -- \
  cat /etc/config/app.conf

# Check when the ConfigMap was last modified
kubectl get configmap app-config -n production \
  -o jsonpath='{.metadata.creationTimestamp}'
```

### envFrom and env Updates: They Do NOT Update

Environment variables sourced from ConfigMaps and Secrets via `envFrom` or `env.valueFrom` are resolved at pod startup and are **never updated** during the pod's lifetime. This is a common source of confusion:

```yaml
# These values are read once at pod start and NEVER updated
containers:
- name: app
  envFrom:
  - configMapRef:
      name: app-config  # Changes to this ConfigMap do NOT reach the running pod
  env:
  - name: DB_HOST
    valueFrom:
      secretKeyRef:
        name: db-secret  # Changes to this Secret do NOT reach the running pod
        key: host
```

For environment variable-based configuration changes, a pod restart is required. The patterns in this guide focus on volume-mounted configuration.

### ConfigMap Immutability

Kubernetes 1.21+ allows marking ConfigMaps and Secrets as immutable:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config-v20270504
  namespace: production
immutable: true  # Cannot be updated after creation
data:
  app.conf: |
    log_level: info
    max_connections: 100
```

Immutable ConfigMaps offer two advantages:
1. Prevent accidental mutations that could affect running pods
2. Improved kubelet performance: the kubelet does not need to watch immutable ConfigMaps for changes

The trade-off is that configuration updates require creating a new ConfigMap with a new name and updating the Deployment to reference it, which triggers a rolling restart. This pattern is appropriate for critical configurations where auditability and immutability are more important than zero-downtime updates.

## Application-Level inotify Watching

### How inotify Works with Kubernetes Volume Mounts

Linux inotify watches for filesystem events on specific paths or directories. Combined with Kubernetes atomic symlink replacement, an inotify watch on the ConfigMap mount directory can detect configuration changes reliably.

The critical implementation detail: inotify watches must be placed on the **directory**, not the individual files. Because Kubernetes replaces the `..data` symlink rather than modifying the file in-place, a watch on the file itself misses the update. A watch on the directory catches the `IN_CREATE` event when the new `..data` symlink is created.

### Go Application with inotify Reload

```go
package main

import (
	"encoding/json"
	"log"
	"os"
	"os/signal"
	"sync"
	"syscall"

	"github.com/fsnotify/fsnotify"
)

// AppConfig holds runtime configuration
type AppConfig struct {
	LogLevel       string `json:"log_level"`
	MaxConnections int    `json:"max_connections"`
	FeatureFlags   struct {
		NewUI      bool `json:"new_ui"`
		BetaSearch bool `json:"beta_search"`
	} `json:"feature_flags"`
}

// ConfigManager manages hot-reloadable configuration
type ConfigManager struct {
	mu         sync.RWMutex
	config     AppConfig
	configPath string
	watcher    *fsnotify.Watcher
}

// NewConfigManager creates and initializes a ConfigManager
func NewConfigManager(configPath string) (*ConfigManager, error) {
	cm := &ConfigManager{configPath: configPath}

	if err := cm.load(); err != nil {
		return nil, err
	}

	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	cm.watcher = watcher

	// Watch the directory, not the file, to catch symlink replacements
	if err := watcher.Add(configPath[:len(configPath)-len("/app.conf")]); err != nil {
		return nil, err
	}

	go cm.watchLoop()
	return cm, nil
}

// Get returns a copy of the current config (safe for concurrent access)
func (cm *ConfigManager) Get() AppConfig {
	cm.mu.RLock()
	defer cm.mu.RUnlock()
	return cm.config
}

func (cm *ConfigManager) load() error {
	data, err := os.ReadFile(cm.configPath)
	if err != nil {
		return err
	}

	var cfg AppConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return err
	}

	cm.mu.Lock()
	cm.config = cfg
	cm.mu.Unlock()

	log.Printf("Configuration loaded: log_level=%s max_connections=%d",
		cfg.LogLevel, cfg.MaxConnections)
	return nil
}

func (cm *ConfigManager) watchLoop() {
	for {
		select {
		case event, ok := <-cm.watcher.Events:
			if !ok {
				return
			}
			// Kubernetes creates/replaces the ..data symlink on ConfigMap update
			if event.Name == cm.configPath[:len(cm.configPath)-len("/app.conf")]+"/../data" ||
				event.Op&fsnotify.Create != 0 || event.Op&fsnotify.Write != 0 {
				log.Printf("Configuration change detected: %s", event.Name)
				if err := cm.load(); err != nil {
					log.Printf("ERROR: Failed to reload configuration: %v", err)
				}
			}
		case err, ok := <-cm.watcher.Errors:
			if !ok {
				return
			}
			log.Printf("Config watcher error: %v", err)
		}
	}
}

func main() {
	cfgManager, err := NewConfigManager("/etc/config/app.json")
	if err != nil {
		log.Fatalf("Failed to initialize config manager: %v", err)
	}
	defer cfgManager.watcher.Close()

	// Handle SIGHUP as an additional reload trigger
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGHUP)
	go func() {
		for range sigs {
			log.Println("SIGHUP received, reloading configuration")
			if err := cfgManager.load(); err != nil {
				log.Printf("ERROR: Failed to reload on SIGHUP: %v", err)
			}
		}
	}()

	// Application main loop
	log.Println("Service started")
	select {}
}
```

### Python Application with watchdog

```python
#!/usr/bin/env python3
"""Application with hot-reload configuration using watchdog."""

import json
import logging
import os
import signal
import threading
import time
from pathlib import Path
from typing import Any

from watchdog.events import FileSystemEventHandler, FileSystemEvent
from watchdog.observers import Observer


class ConfigManager:
    """Thread-safe configuration manager with filesystem watching."""

    def __init__(self, config_path: str):
        self._config_path = Path(config_path)
        self._config: dict[str, Any] = {}
        self._lock = threading.RLock()
        self._load()

        # Watch the directory (not the file) for Kubernetes symlink updates
        self._observer = Observer()
        handler = self._ConfigChangeHandler(self)
        self._observer.schedule(
            handler,
            str(self._config_path.parent),
            recursive=False,
        )
        self._observer.start()

        # Also reload on SIGHUP
        signal.signal(signal.SIGHUP, self._handle_sighup)

    class _ConfigChangeHandler(FileSystemEventHandler):
        def __init__(self, manager: "ConfigManager"):
            self._manager = manager

        def on_any_event(self, event: FileSystemEvent):
            # Trigger on any event in the config directory
            if not event.is_directory:
                logging.info("Config change detected: %s", event.src_path)
                self._manager._load()

    def _load(self):
        try:
            with open(self._config_path, "r") as f:
                new_config = json.load(f)
            with self._lock:
                self._config = new_config
            logging.info(
                "Configuration loaded: log_level=%s",
                new_config.get("log_level", "unknown"),
            )
        except Exception as e:
            logging.error("Failed to reload configuration: %s", e)

    def _handle_sighup(self, signum, frame):
        logging.info("SIGHUP received, reloading configuration")
        self._load()

    def get(self, key: str, default: Any = None) -> Any:
        with self._lock:
            return self._config.get(key, default)

    def stop(self):
        self._observer.stop()
        self._observer.join()


# Kubernetes ConfigMap to mount the configuration file
```

### Nginx Configuration Reload

Nginx reloads its configuration in-place without dropping connections when it receives `SIGHUP`. This makes it ideal for sidecar-based hot reload:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx-gateway
  namespace: production
spec:
  template:
    spec:
      shareProcessNamespace: true  # Required for the reloader to signal nginx
      containers:
      - name: nginx
        image: nginx:1.27-alpine
        command:
        - nginx
        - -g
        - daemon off;
        volumeMounts:
        - name: nginx-config
          mountPath: /etc/nginx/conf.d
        - name: tls-certs
          mountPath: /etc/nginx/ssl
        lifecycle:
          preStop:
            exec:
              command: ["nginx", "-s", "quit"]
        readinessProbe:
          httpGet:
            path: /healthz
            port: 80
          periodSeconds: 5
        resources:
          requests:
            cpu: 100m
            memory: 128Mi

      # Config reloader sidecar: watches for changes and signals nginx
      - name: config-reloader
        image: jimmidyson/configmap-reload:v0.13.0
        args:
        - --volume-dir=/etc/nginx/conf.d
        - --volume-dir=/etc/nginx/ssl
        - --webhook-url=http://localhost:8080/nginx-reload
        - --webhook-method=POST
        volumeMounts:
        - name: nginx-config
          mountPath: /etc/nginx/conf.d
          readOnly: true
        - name: tls-certs
          mountPath: /etc/nginx/ssl
          readOnly: true
        resources:
          requests:
            cpu: 10m
            memory: 16Mi

      volumes:
      - name: nginx-config
        configMap:
          name: nginx-gateway-config
      - name: tls-certs
        secret:
          secretName: nginx-tls
```

With `shareProcessNamespace: true`, the config-reloader can also signal nginx directly:

```yaml
      - name: config-reloader
        image: busybox:1.36
        command:
        - sh
        - -c
        - |
          while true; do
            inotifywait -e modify,create,delete -r /etc/nginx/conf.d /etc/nginx/ssl
            echo "Config change detected, sending SIGHUP to nginx"
            # Find nginx master process PID and signal it
            NGINX_PID=$(pgrep -f "nginx: master" | head -1)
            if [ -n "${NGINX_PID}" ]; then
              kill -HUP "${NGINX_PID}"
              echo "Sent SIGHUP to nginx PID ${NGINX_PID}"
            fi
          done
        securityContext:
          capabilities:
            add: ["SYS_PTRACE"]
        volumeMounts:
        - name: nginx-config
          mountPath: /etc/nginx/conf.d
          readOnly: true
```

## Reloader Controller Pattern

### Stakater Reloader

Stakater Reloader is the most widely adopted Kubernetes controller for automating rolling restarts when ConfigMaps or Secrets change. It watches ConfigMap and Secret objects and triggers rolling updates on Deployments, StatefulSets, and DaemonSets that reference them.

### Installation

```bash
helm repo add stakater https://stakater.github.io/stakater-charts
helm repo update

helm install reloader stakater/reloader \
  --namespace reloader \
  --create-namespace \
  --version 1.2.1 \
  --set reloader.watchGlobally=false \
  --set reloader.isArgoRollouts=false \
  --set reloader.logFormat=json \
  --set reloader.podMonitor.enabled=true
```

Verify:

```bash
kubectl get pods -n reloader
kubectl get deployment reloader-reloader -n reloader
```

### Annotation-Based Auto-Reload

Add annotations to Deployments, StatefulSets, or DaemonSets to enable reloading:

```yaml
# Reload when ANY ConfigMap or Secret referenced by this Deployment changes
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-service
  namespace: production
  annotations:
    # Watch all ConfigMaps and Secrets used by this deployment
    reloader.stakater.com/auto: "true"
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api-service
  template:
    spec:
      containers:
      - name: api
        image: internal.registry.example.com/api-service:2.8.0
        envFrom:
        - configMapRef:
            name: api-config
        - secretRef:
            name: api-secrets
        volumeMounts:
        - name: feature-flags
          mountPath: /etc/feature-flags
      volumes:
      - name: feature-flags
        configMap:
          name: feature-flags-config
```

```yaml
# Watch only specific ConfigMaps/Secrets (more precise control)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  namespace: production
  annotations:
    # Reload only when these specific resources change
    reloader.stakater.com/search-match-type: "contains"
    configmap.reloader.stakater.com/reload: "payment-config,feature-flags-config"
    secret.reloader.stakater.com/reload: "payment-service-tls,payment-service-api-keys"
```

### Search-Based Reload with Hash Annotation

Alternatively, inject a hash of the ConfigMap into the pod template annotations. This approach works without any external controller — the hash changes when the ConfigMap changes, and Kubernetes triggers a rolling update because the pod template changes:

```yaml
# This pattern is typically applied by Helm or a CI/CD system
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-service
  namespace: production
spec:
  template:
    metadata:
      annotations:
        # Hash updated by Helm's sha256sum function or a CI script
        checksum/config: "8a9f2b3c4d5e6f7a8b9c0d1e2f3a4b5c"
        checksum/secret: "1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a"
    spec:
      containers:
      - name: web
        image: internal.registry.example.com/web-service:3.0.0
```

Helm template for automatic hash injection:

```yaml
# templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "web-service.fullname" . }}
spec:
  template:
    metadata:
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
        checksum/secret: {{ include (print $.Template.BasePath "/secret.yaml") . | sha256sum }}
```

### Reloader with ArgoCD

When using ArgoCD for GitOps, Reloader integrates cleanly. The Reloader controller updates the rolling restart annotation rather than modifying the Deployment spec directly. ArgoCD can be configured to ignore this annotation to avoid drift detection:

```yaml
# ArgoCD Application resource - ignore reloader annotations in diff
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: api-service
  namespace: argocd
spec:
  source:
    repoURL: https://git.internal.example.com/k8s-manifests
    targetRevision: HEAD
    path: apps/api-service
  destination:
    server: https://kubernetes.default.svc
    namespace: production
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
  ignoreDifferences:
  - group: apps
    kind: Deployment
    jsonPointers:
    - /spec/template/metadata/annotations/kubectl.kubernetes.io~1last-applied-configuration
  - group: apps
    kind: Deployment
    name: api-service
    jsonPointers:
    - /spec/template/metadata/annotations/reloader.stakater.com~1last-reload-from-configmap
    - /spec/template/metadata/annotations/reloader.stakater.com~1last-reload-from-secret
```

## ConfigMap Immutability Strategy

For environments where configuration changes must be versioned and auditable, the immutable ConfigMap pattern provides the strongest guarantees:

```bash
#!/bin/bash
# Deploy a new ConfigMap version and update the Deployment reference
# Usage: ./update-config.sh <namespace> <deployment-name> <config-file>

set -euo pipefail

NAMESPACE="${1:?namespace required}"
DEPLOYMENT="${2:?deployment name required}"
CONFIG_FILE="${3:?config file path required}"

TIMESTAMP=$(date -u +%Y%m%d%H%M%S)
NEW_CONFIGMAP="${DEPLOYMENT}-config-${TIMESTAMP}"

log() {
  echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] $*"
}

# Create the new immutable ConfigMap
log "Creating ConfigMap ${NEW_CONFIGMAP} in ${NAMESPACE}..."
kubectl create configmap "${NEW_CONFIGMAP}" \
  --from-file="${CONFIG_FILE}" \
  -n "${NAMESPACE}"

# Mark it immutable
kubectl patch configmap "${NEW_CONFIGMAP}" \
  -n "${NAMESPACE}" \
  --type merge \
  -p '{"immutable":true}'

log "ConfigMap ${NEW_CONFIGMAP} created and marked immutable"

# Get the current ConfigMap name from the Deployment
CURRENT_CONFIGMAP=$(kubectl get deployment "${DEPLOYMENT}" \
  -n "${NAMESPACE}" \
  -o jsonpath='{.spec.template.spec.volumes[?(@.name=="app-config")].configMap.name}')
log "Current ConfigMap: ${CURRENT_CONFIGMAP}"

# Update the Deployment to use the new ConfigMap
# This triggers a rolling update
kubectl set env deployment/"${DEPLOYMENT}" \
  -n "${NAMESPACE}" \
  "CONFIG_CHECKSUM=${TIMESTAMP}"

# Actually patch the volume reference
kubectl patch deployment "${DEPLOYMENT}" \
  -n "${NAMESPACE}" \
  --type json \
  -p "[{\"op\":\"replace\",\"path\":\"/spec/template/spec/volumes/0/configMap/name\",\"value\":\"${NEW_CONFIGMAP}\"}]"

log "Deployment ${DEPLOYMENT} updated to use ${NEW_CONFIGMAP}"

# Wait for the rollout to complete
log "Waiting for rollout to complete..."
kubectl rollout status deployment/"${DEPLOYMENT}" \
  -n "${NAMESPACE}" \
  --timeout=300s

log "Rollout complete"

# Optionally delete the old ConfigMap (with a delay for safety)
if [[ -n "${CURRENT_CONFIGMAP}" && "${CURRENT_CONFIGMAP}" != "${DEPLOYMENT}-config" ]]; then
  log "Old ConfigMap ${CURRENT_CONFIGMAP} will be preserved for 24h"
  # In production, implement a cleanup job rather than deleting immediately
fi
```

## Sidecar-Based Config Reload

### configmap-reload Sidecar

The `configmap-reload` project provides a minimal sidecar that watches a directory and calls a webhook when files change:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: prometheus-custom
  namespace: monitoring
spec:
  replicas: 1
  template:
    spec:
      containers:
      - name: prometheus
        image: prom/prometheus:v2.53.0
        args:
        - --config.file=/etc/prometheus/prometheus.yml
        - --web.enable-lifecycle  # Enables /-/reload endpoint
        volumeMounts:
        - name: prometheus-config
          mountPath: /etc/prometheus
        - name: rules
          mountPath: /etc/prometheus/rules
        ports:
        - containerPort: 9090
        resources:
          requests:
            cpu: 500m
            memory: 1Gi

      # configmap-reload sidecar
      - name: prometheus-config-reloader
        image: quay.io/prometheus-operator/prometheus-config-reloader:v0.75.0
        args:
        - --listen-address=:8080
        - --watched-dir=/etc/prometheus
        - --reload-url=http://localhost:9090/-/reload
        volumeMounts:
        - name: prometheus-config
          mountPath: /etc/prometheus
          readOnly: true
        - name: rules
          mountPath: /etc/prometheus/rules
          readOnly: true
        ports:
        - containerPort: 8080
          name: reloader-web
        resources:
          requests:
            cpu: 10m
            memory: 32Mi

      volumes:
      - name: prometheus-config
        configMap:
          name: prometheus-config
      - name: rules
        configMap:
          name: prometheus-rules
```

### Custom Reload Webhook

For applications with a custom reload API, implement a targeted reload sidecar:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: reload-sidecar-script
  namespace: production
data:
  reload.sh: |
    #!/bin/sh
    # Watch for config changes and call application reload API
    set -e

    WATCH_DIR="${WATCH_DIR:-/etc/config}"
    RELOAD_URL="${RELOAD_URL:-http://localhost:8080/config/reload}"
    RELOAD_METHOD="${RELOAD_METHOD:-POST}"

    log() {
      echo "[$(date '+%Y-%m-%dT%H:%M:%S')] $*"
    }

    log "Starting config watcher for ${WATCH_DIR}"
    log "Will call ${RELOAD_METHOD} ${RELOAD_URL} on changes"

    # Initial hash
    LAST_HASH=$(find "${WATCH_DIR}" -type f | sort | xargs md5sum 2>/dev/null | md5sum)

    while true; do
      sleep 15
      CURRENT_HASH=$(find "${WATCH_DIR}" -type f | sort | xargs md5sum 2>/dev/null | md5sum)

      if [ "${CURRENT_HASH}" != "${LAST_HASH}" ]; then
        log "Config change detected in ${WATCH_DIR}"
        log "Calling reload endpoint: ${RELOAD_URL}"

        HTTP_STATUS=$(curl -sf \
          -X "${RELOAD_METHOD}" \
          -o /dev/null \
          -w "%{http_code}" \
          "${RELOAD_URL}" || echo "000")

        if [ "${HTTP_STATUS}" = "200" ] || [ "${HTTP_STATUS}" = "204" ]; then
          log "Reload successful (HTTP ${HTTP_STATUS})"
          LAST_HASH="${CURRENT_HASH}"
        else
          log "ERROR: Reload failed (HTTP ${HTTP_STATUS}). Will retry next cycle."
        fi
      fi
    done
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: configurable-service
  namespace: production
spec:
  template:
    spec:
      containers:
      - name: service
        image: internal.registry.example.com/configurable-service:4.0.0
        ports:
        - containerPort: 8080
        volumeMounts:
        - name: app-config
          mountPath: /etc/config
        resources:
          requests:
            cpu: 500m
            memory: 512Mi

      - name: config-reloader
        image: curlimages/curl:8.8.0
        command:
        - sh
        - /scripts/reload.sh
        env:
        - name: WATCH_DIR
          value: /etc/config
        - name: RELOAD_URL
          value: http://localhost:8080/config/reload
        - name: RELOAD_METHOD
          value: POST
        volumeMounts:
        - name: app-config
          mountPath: /etc/config
          readOnly: true
        - name: reload-script
          mountPath: /scripts
        resources:
          requests:
            cpu: 10m
            memory: 16Mi

      volumes:
      - name: app-config
        configMap:
          name: configurable-service-config
      - name: reload-script
        configMap:
          name: reload-sidecar-script
          defaultMode: 0755
```

## Testing Reload Behavior

### Automated Reload Test

```bash
#!/bin/bash
# Test ConfigMap hot reload behavior
# Usage: ./test-reload.sh <namespace> <deployment-name> <configmap-name>

set -euo pipefail

NAMESPACE="${1:?namespace required}"
DEPLOYMENT="${2:?deployment name required}"
CONFIGMAP="${3:?configmap name required}"

log() {
  echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] $*"
}

# Step 1: Record current configuration
log "Reading current configuration from ConfigMap ${CONFIGMAP}..."
ORIGINAL_CONFIG=$(kubectl get configmap "${CONFIGMAP}" \
  -n "${NAMESPACE}" \
  -o jsonpath='{.data}')
log "Current config: ${ORIGINAL_CONFIG}"

# Step 2: Pick a test pod
TEST_POD=$(kubectl get pods -n "${NAMESPACE}" \
  -l "app=${DEPLOYMENT}" \
  -o jsonpath='{.items[0].metadata.name}')
log "Testing with pod: ${TEST_POD}"

# Step 3: Record the pre-change config file content inside the pod
log "Reading config file inside pod..."
PRE_CHANGE=$(kubectl exec "${TEST_POD}" -n "${NAMESPACE}" -- \
  cat /etc/config/app.conf 2>/dev/null || echo "FILE_NOT_FOUND")
log "Pre-change content: ${PRE_CHANGE}"

# Step 4: Update the ConfigMap with a test value
TEST_MARKER="RELOAD_TEST_$(date +%s)"
log "Updating ConfigMap with test marker: ${TEST_MARKER}..."

# Get current configmap data and add test key
kubectl patch configmap "${CONFIGMAP}" \
  -n "${NAMESPACE}" \
  --type merge \
  -p "{\"data\":{\"reload_test_marker\":\"${TEST_MARKER}\"}}"

# Step 5: Wait for propagation (up to 3 minutes)
log "Waiting for config update to propagate (up to 3 minutes)..."
MAX_WAIT=180
ELAPSED=0
INTERVAL=10

while (( ELAPSED < MAX_WAIT )); do
  sleep "${INTERVAL}"
  ELAPSED=$((ELAPSED + INTERVAL))

  # Check if the update appeared in the pod
  CURRENT_MARKER=$(kubectl exec "${TEST_POD}" -n "${NAMESPACE}" -- \
    cat /etc/config/reload_test_marker 2>/dev/null || echo "")

  if [[ "${CURRENT_MARKER}" == "${TEST_MARKER}" ]]; then
    log "SUCCESS: Config update propagated after ${ELAPSED}s"
    break
  fi

  log "Waiting... (${ELAPSED}s elapsed, marker not yet visible)"
done

if [[ "${ELAPSED}" -ge "${MAX_WAIT}" ]]; then
  log "FAILURE: Config update did not propagate within ${MAX_WAIT}s"
  exit 1
fi

# Step 6: Verify application reload (if application has a config endpoint)
log "Checking application reload endpoint..."
CONFIG_ENDPOINT_RESPONSE=$(kubectl exec "${TEST_POD}" -n "${NAMESPACE}" -- \
  curl -sf "http://localhost:8080/config" 2>/dev/null || echo "ENDPOINT_UNAVAILABLE")

if [[ "${CONFIG_ENDPOINT_RESPONSE}" != "ENDPOINT_UNAVAILABLE" ]]; then
  log "Application config endpoint response: ${CONFIG_ENDPOINT_RESPONSE}"
  if echo "${CONFIG_ENDPOINT_RESPONSE}" | grep -q "${TEST_MARKER}"; then
    log "SUCCESS: Application has loaded the new configuration"
  else
    log "WARNING: Config file updated but application may not have reloaded"
  fi
fi

# Step 7: Clean up test marker
log "Cleaning up test marker..."
kubectl patch configmap "${CONFIGMAP}" \
  -n "${NAMESPACE}" \
  --type json \
  -p '[{"op":"remove","path":"/data/reload_test_marker"}]' 2>/dev/null || true

log "Reload test complete"
```

## Prometheus Monitoring for Config Reload

### Metrics to Track

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: config-reload-alerts
  namespace: monitoring
spec:
  groups:
  - name: config-reload
    interval: 60s
    rules:
    # Alert when Reloader controller is not available
    - alert: ReloaderControllerDown
      expr: |
        absent(up{job="reloader"} == 1)
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Stakater Reloader controller is not running"
        description: "ConfigMap and Secret changes will not trigger rolling updates automatically"

    # Alert on failed reloads tracked by Reloader
    - alert: ConfigReloadFailed
      expr: |
        reloader_reload_failures_total > 0
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Config reload failures detected"
        description: "{{ $value }} reload failures in the past 5 minutes"

    # Alert when ConfigMaps are updated but pods are not
    # (may indicate inotify watcher failure)
    - alert: ConfigMapUpdatedPodNotReloaded
      expr: |
        (
          kube_configmap_info{namespace="production"}
          unless on(configmap)
          changes(kube_configmap_metadata_resource_version{namespace="production"}[30m]) == 0
        )
      for: 30m
      labels:
        severity: info
      annotations:
        summary: "ConfigMap {{ $labels.configmap }} changed but pods may not have reloaded"
```

### Grafana Dashboard JSON

```json
{
  "title": "ConfigMap Reload Monitoring",
  "panels": [
    {
      "title": "Reloader Controller Status",
      "type": "stat",
      "targets": [
        {
          "expr": "up{job=\"reloader\"}",
          "legendFormat": "Reloader"
        }
      ]
    },
    {
      "title": "Rolling Restarts Triggered by Reloader",
      "type": "graph",
      "targets": [
        {
          "expr": "increase(reloader_reload_executed_total[1h])",
          "legendFormat": "Reloads/hour"
        }
      ]
    },
    {
      "title": "Config Propagation Latency",
      "type": "graph",
      "description": "Time between ConfigMap update and pod filesystem update",
      "targets": [
        {
          "expr": "kubelet_volume_stats_available_bytes{persistentvolumeclaim=~\"config-.*\"}",
          "legendFormat": "{{ persistentvolumeclaim }}"
        }
      ]
    }
  ]
}
```

## Complete Working Example

### Feature Flag Hot Reload

This complete example demonstrates a web service with feature flags that reload without restarting:

```yaml
# ConfigMap with feature flags
apiVersion: v1
kind: ConfigMap
metadata:
  name: feature-flags
  namespace: production
data:
  flags.json: |
    {
      "new_checkout_flow": true,
      "beta_search": false,
      "dark_mode": true,
      "max_upload_size_mb": 25,
      "rate_limit_per_minute": 100
    }
---
# Service Account
apiVersion: v1
kind: ServiceAccount
metadata:
  name: web-service
  namespace: production
---
# Deployment with hot reload
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-service
  namespace: production
  annotations:
    # Reloader will trigger a rolling update if env-based config changes
    configmap.reloader.stakater.com/reload: "web-service-config"
    # Feature flags do NOT trigger restart - they hot-reload via volume mount
    # The distinction: env config requires restart, feature flags hot-reload
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web-service
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    metadata:
      labels:
        app: web-service
    spec:
      serviceAccountName: web-service
      terminationGracePeriodSeconds: 30
      containers:
      - name: web
        image: internal.registry.example.com/web-service:5.2.0
        ports:
        - containerPort: 8080
        env:
        - name: FEATURE_FLAGS_PATH
          value: /etc/feature-flags/flags.json
        envFrom:
        - configMapRef:
            name: web-service-config  # Restart required for these
        volumeMounts:
        - name: feature-flags
          mountPath: /etc/feature-flags
        readinessProbe:
          httpGet:
            path: /healthz/ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
          failureThreshold: 3
        livenessProbe:
          httpGet:
            path: /healthz/live
            port: 8080
          initialDelaySeconds: 15
          periodSeconds: 15
        lifecycle:
          preStop:
            exec:
              command: ["/bin/sh", "-c", "sleep 5"]
        resources:
          requests:
            cpu: 250m
            memory: 256Mi
          limits:
            cpu: 1000m
            memory: 512Mi

      volumes:
      - name: feature-flags
        configMap:
          name: feature-flags
---
# PodDisruptionBudget
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: web-service-pdb
  namespace: production
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: web-service
---
# HorizontalPodAutoscaler
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: web-service-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: web-service
  minReplicas: 3
  maxReplicas: 20
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

Update feature flags without any restart:

```bash
# Update a feature flag
kubectl patch configmap feature-flags -n production \
  --type merge \
  -p '{"data":{"flags.json":"{\"new_checkout_flow\":true,\"beta_search\":true,\"dark_mode\":true,\"max_upload_size_mb\":50,\"rate_limit_per_minute\":200}"}}'

# Watch the update propagate to pods (within ~60 seconds)
# No pod restarts occur - the application reads the new file

# Verify the update reached the pods
for pod in $(kubectl get pods -n production -l app=web-service -o name); do
  echo "=== ${pod} ==="
  kubectl exec -n production "${pod}" -- cat /etc/feature-flags/flags.json
done
```

## Choosing the Right Strategy

| Scenario | Recommended Pattern |
|----------|---------------------|
| Application reads config file at startup and has a reload API | Volume mount + inotify sidecar calling reload API |
| Application reads config file continuously in hot path | Volume mount with inotify watching in application |
| Application uses environment variables | Stakater Reloader for automatic rolling restart |
| Nginx, Prometheus, or similar with SIGHUP support | Volume mount + `shareProcessNamespace` + signal sidecar |
| GitOps environment with strict change control | Immutable ConfigMaps with versioned names |
| Batch jobs needing config changes mid-run | Volume mount (kubelet sync must be fast enough) |
| Security-sensitive secrets (TLS certs, API keys) | Vault Agent sidecar with dynamic renewal |
| Multiple environments with different configs | Kustomize overlays + immutable ConfigMaps per environment |

## Conclusion

Hot reloading Kubernetes configuration requires understanding the update propagation mechanics: volume-mounted ConfigMaps update within 1–2 minutes via atomic symlink replacement, but environment variables never update without a pod restart. The Stakater Reloader controller is the lowest-effort solution for workloads that need rolling restarts on config changes. For true zero-downtime reload, the application must actively watch the config directory via inotify (or a polling sidecar) and support an in-process reload mechanism. Native features like `shareProcessNamespace` enable signal-based reload (SIGHUP for nginx and similar tools) without modifying application code. The choice of pattern should be driven by the application's reload capability, the sensitivity of the data being rotated, and the acceptable propagation window.
