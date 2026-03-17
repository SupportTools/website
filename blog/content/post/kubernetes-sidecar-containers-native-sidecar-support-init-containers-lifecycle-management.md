---
title: "Kubernetes Sidecar Containers: Native Sidecar Support, Init Containers, and Lifecycle Management"
date: 2030-03-15T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Sidecar Containers", "Init Containers", "Service Mesh", "Envoy", "Lifecycle Management"]
categories: ["Kubernetes", "Container Orchestration"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Kubernetes 1.29+ native sidecar container support, sidecar ordering guarantees, proxy sidecar patterns, log forwarding sidecars, and health check coordination between main containers and sidecars."
more_link: "yes"
url: "/kubernetes-sidecar-containers-native-sidecar-support-init-containers-lifecycle-management/"
---

The sidecar pattern is one of the most powerful architectural primitives in Kubernetes workload design. From Envoy proxy injection in service meshes to Fluent Bit log forwarders and Vault agent secret injectors, sidecars extend the capabilities of application containers without modifying application code. For years, the pattern was implemented through regular containers running alongside the main container, with no ordering guarantees and fragile shutdown sequencing. Kubernetes 1.29 changed this fundamentally by introducing native sidecar container support, elevating what was a convention into a first-class API primitive.

This guide covers the complete lifecycle of Kubernetes sidecar containers: the pre-1.29 patterns, the new native sidecar API, startup and shutdown ordering, proxy sidecar design for service meshes, log forwarding architectures, and health check coordination strategies for production workloads.

<!--more-->

## The Sidecar Pattern: Concepts and Motivations

A sidecar container runs alongside the main application container within the same Pod, sharing the same network namespace, process namespace (optionally), and volumes. The pattern provides separation of concerns at the infrastructure level: the application container focuses on business logic while sidecar containers handle cross-cutting concerns.

Common sidecar use cases in production:

- **Service mesh proxies**: Envoy (Istio), Linkerd proxy, NGINX Service Mesh intercept and route all network traffic
- **Log forwarding**: Fluent Bit, Filebeat, Logstash tail log files and ship to centralized logging
- **Secret management**: Vault Agent, AWS Secrets Manager sidecar refresh and deliver secrets
- **Configuration management**: Consul Template, Confd watch key-value stores and render configurations
- **Metrics collection**: Prometheus pushgateway client, StatsD exporter expose application metrics
- **Security scanning**: Falco, Aqua, Twistlock enforce runtime security policies

The fundamental challenge with the pre-1.29 sidecar implementation was that all containers in a Pod start and stop concurrently. A log forwarder might miss the last log lines from a batch job because it shut down before the main container finished writing. An Envoy proxy might not be ready when the application starts making outbound requests. These race conditions required complex application-level workarounds.

## Pre-1.29 Sidecar Patterns and Their Limitations

Before native sidecar support, teams used several workarounds to manage sidecar ordering:

### The postStart Hook Workaround

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: app-with-sidecar
spec:
  initContainers:
  - name: istio-init
    image: istio/proxyv2:1.18.0
    command: ["istio-iptables"]
    args:
    - "-p"
    - "15001"
    - "-z"
    - "15006"
    - "-u"
    - "1337"
    - "-m"
    - "REDIRECT"
    - "-i"
    - "*"
    - "-x"
    - ""
    - "-b"
    - "*"
    - "-d"
    - "15090,15021,15020"
    securityContext:
      capabilities:
        add:
        - NET_ADMIN
        - NET_RAW
      runAsNonRoot: false
      runAsUser: 0
  containers:
  - name: envoy-proxy
    image: istio/proxyv2:1.18.0
    # No ordering guarantee with this approach
    readinessProbe:
      httpGet:
        path: /healthz/ready
        port: 15021
      initialDelaySeconds: 1
      periodSeconds: 2
  - name: app
    image: myapp:1.0.0
    # App may start before envoy is ready
    lifecycle:
      postStart:
        exec:
          command:
          - /bin/sh
          - -c
          - |
            # Hack: wait for envoy to be ready
            until curl -sf http://localhost:15021/healthz/ready; do
              echo "Waiting for envoy..."
              sleep 1
            done
```

This postStart hook approach is fragile. The hook runs concurrently with the container's main process, meaning the application process might have already started making network calls before the hook completes. Additionally, if the hook fails, the container is killed and restarted, potentially creating a restart loop.

### The Shared Process Namespace Approach

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: shared-pid-pod
spec:
  shareProcessNamespace: true
  containers:
  - name: app
    image: myapp:1.0.0
  - name: sidecar-helper
    image: alpine:3.18
    command:
    - /bin/sh
    - -c
    - |
      # Wait for main process to appear
      while ! pgrep -x "myapp" > /dev/null; do
        sleep 0.5
      done
      echo "Main app detected, starting sidecar work"
      exec my-sidecar-binary
```

Sharing process namespaces introduces security concerns and coupling between containers.

### Shutdown Race Conditions

The most damaging pre-1.29 limitation was shutdown ordering. When a Pod terminates, Kubernetes sends SIGTERM to all containers simultaneously. A log forwarder must flush its buffer before the main application writes its final log lines. A metrics scraper must complete its final scrape before the application exits. Neither is guaranteed without explicit coordination.

```yaml
# Pre-1.29 workaround: delay main container shutdown
containers:
- name: app
  image: myapp:1.0.0
  lifecycle:
    preStop:
      exec:
        command:
        - /bin/sh
        - -c
        - |
          # Send signal to app to start draining
          kill -SIGTERM 1
          # Wait for sidecar to flush
          sleep 5
```

This approach introduces artificial delays and is difficult to tune correctly across different workload types.

## Native Sidecar Containers in Kubernetes 1.29+

Kubernetes 1.29 introduced native sidecar containers as a beta feature (KEP-753) by extending the init container API with a `restartPolicy: Always` field. This seemingly small addition has profound implications for container lifecycle management.

### Enabling Native Sidecars

Native sidecars are available in Kubernetes 1.29+ with the `SidecarContainers` feature gate. In 1.29 and 1.30, it is enabled by default in beta. Check your cluster:

```bash
# Check feature gate status
kubectl get nodes -o json | jq '.items[0].status.nodeInfo.kubeletVersion'

# Verify feature gate is active
kubectl get --raw /healthz/ready
kubectl get --raw /metrics | grep 'sidecar'
```

### Native Sidecar Pod Specification

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: native-sidecar-demo
  namespace: production
spec:
  initContainers:
  # Phase 1: True init container - runs to completion before anything else
  - name: db-migration
    image: myapp-migrations:1.0.0
    command: ["./migrate", "--up"]
    env:
    - name: DATABASE_URL
      valueFrom:
        secretKeyRef:
          name: db-credentials
          key: url
    restartPolicy: null  # Default: no restartPolicy = classic init container

  # Phase 2: Native sidecar - starts before main container, keeps running
  - name: fluent-bit
    image: fluent/fluent-bit:2.2.0
    restartPolicy: Always  # This is what makes it a native sidecar
    volumeMounts:
    - name: log-volume
      mountPath: /var/log/app
    - name: fluent-bit-config
      mountPath: /fluent-bit/etc
    resources:
      requests:
        cpu: 50m
        memory: 64Mi
      limits:
        cpu: 200m
        memory: 128Mi

  # Phase 3: Another native sidecar
  - name: envoy
    image: envoyproxy/envoy:v1.28.0
    restartPolicy: Always
    args:
    - -c
    - /etc/envoy/envoy.yaml
    - --service-cluster
    - $(POD_NAMESPACE)/$(POD_NAME)
    env:
    - name: POD_NAME
      valueFrom:
        fieldRef:
          fieldPath: metadata.name
    - name: POD_NAMESPACE
      valueFrom:
        fieldRef:
          fieldPath: metadata.namespace
    ports:
    - containerPort: 15001
      name: outbound
    - containerPort: 15006
      name: inbound
    - containerPort: 15021
      name: health
    readinessProbe:
      httpGet:
        path: /ready
        port: 15021
      initialDelaySeconds: 1
      periodSeconds: 2
      failureThreshold: 30
    volumeMounts:
    - name: envoy-config
      mountPath: /etc/envoy
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        cpu: 500m
        memory: 256Mi

  containers:
  # Main container starts AFTER all native sidecars are Ready
  - name: app
    image: myapp:1.0.0
    ports:
    - containerPort: 8080
    env:
    - name: LOG_DIR
      value: /var/log/app
    readinessProbe:
      httpGet:
        path: /healthz
        port: 8080
      initialDelaySeconds: 5
      periodSeconds: 10
    livenessProbe:
      httpGet:
        path: /healthz
        port: 8080
      initialDelaySeconds: 15
      periodSeconds: 20
    volumeMounts:
    - name: log-volume
      mountPath: /var/log/app

  volumes:
  - name: log-volume
    emptyDir: {}
  - name: fluent-bit-config
    configMap:
      name: fluent-bit-config
  - name: envoy-config
    configMap:
      name: envoy-config
```

### Startup Ordering Guarantees

With native sidecars, the startup sequence is deterministic:

```
1. Classic init containers run sequentially (to completion)
2. Native sidecar init containers start in order
3. Each native sidecar must pass its readinessProbe before the next sidecar starts
4. The main container starts only after ALL native sidecars are Ready
```

This means if your envoy sidecar has a readinessProbe, the main application container will not start until Envoy is fully ready to handle traffic. No more postStart hacks.

```bash
# Observe startup ordering in real time
kubectl get events --field-selector involvedObject.name=native-sidecar-demo \
  --sort-by='.lastTimestamp' -w

# Expected event sequence:
# Normal  Pulled     Container image pulled: db-migration
# Normal  Started    Started container db-migration
# Normal  Completed  Container db-migration completed
# Normal  Pulled     Container image pulled: fluent-bit
# Normal  Started    Started container fluent-bit
# Normal  Ready      Container fluent-bit is ready
# Normal  Pulled     Container image pulled: envoy
# Normal  Started    Started container envoy
# Normal  Ready      Container envoy is ready
# Normal  Pulled     Container image pulled: app
# Normal  Started    Started container app
```

### Shutdown Ordering: The Critical Difference

When a Pod receives a termination signal, native sidecars shut down AFTER the main container exits. This is the inverse of startup ordering and solves the log flushing race condition:

```
Shutdown sequence:
1. SIGTERM sent to main container
2. Main container performs graceful shutdown (preStop hook, drain connections)
3. Main container exits
4. SIGTERM sent to native sidecar containers (in reverse order of declaration)
5. Sidecars flush buffers, complete pending work, exit
6. Pod termination complete
```

```yaml
# Production configuration with proper shutdown hooks
apiVersion: v1
kind: Pod
metadata:
  name: production-pod
spec:
  terminationGracePeriodSeconds: 60
  initContainers:
  - name: log-forwarder
    image: fluent/fluent-bit:2.2.0
    restartPolicy: Always
    lifecycle:
      preStop:
        exec:
          command:
          - /bin/sh
          - -c
          - |
            # Flush remaining logs, then exit
            kill -SIGUSR2 1
            sleep 5
    resources:
      requests:
        cpu: 50m
        memory: 64Mi
      limits:
        cpu: 200m
        memory: 128Mi

  containers:
  - name: app
    image: myapp:1.0.0
    lifecycle:
      preStop:
        exec:
          command:
          - /bin/sh
          - -c
          - |
            # Drain HTTP connections gracefully
            curl -sf -X POST http://localhost:8080/admin/shutdown || true
            sleep 10
    terminationMessagePolicy: FallbackToLogsOnError
```

## Proxy Sidecar Patterns for Service Mesh

Service mesh implementations inject proxy sidecars (typically Envoy) to intercept all network traffic. Understanding how these proxies interact with native sidecar support is critical for production deployments.

### Istio with Native Sidecar Support

Istio 1.18+ supports the Kubernetes native sidecar API, eliminating many of the race conditions that plagued earlier versions:

```yaml
# Istio ambient mode pod annotation (no sidecar injection needed)
apiVersion: v1
kind: Pod
metadata:
  annotations:
    ambient.istio.io/redirection: enabled
  labels:
    app: myapp
spec:
  containers:
  - name: app
    image: myapp:1.0.0
```

For traditional sidecar injection with native sidecar support, configure Istio:

```yaml
# IstioOperator configuration to use native sidecars
apiVersion: install.istio.io/v1alpha1
kind: IstioOperator
metadata:
  name: istio-control-plane
  namespace: istio-system
spec:
  meshConfig:
    defaultConfig:
      proxyMetadata:
        ISTIO_META_ENABLE_HBONE: "true"
  values:
    pilot:
      env:
        PILOT_ENABLE_K8S_SELECT_WORKLOAD_ENTRIES: "true"
    sidecarInjectorWebhook:
      nativeSidecars: true  # Enable native sidecar injection
```

### Manual Envoy Sidecar Configuration

For teams managing their own proxy sidecars without a service mesh:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: envoy-sidecar-config
  namespace: production
data:
  envoy.yaml: |
    static_resources:
      listeners:
      - name: inbound
        address:
          socket_address:
            address: 0.0.0.0
            port_value: 8081
        filter_chains:
        - filters:
          - name: envoy.filters.network.http_connection_manager
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
              stat_prefix: inbound_http
              route_config:
                name: local_route
                virtual_hosts:
                - name: local_service
                  domains: ["*"]
                  routes:
                  - match:
                      prefix: "/"
                    route:
                      cluster: local_app
              http_filters:
              - name: envoy.filters.http.router
                typed_config:
                  "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
      clusters:
      - name: local_app
        connect_timeout: 0.25s
        type: STATIC
        load_assignment:
          cluster_name: local_app
          endpoints:
          - lb_endpoints:
            - endpoint:
                address:
                  socket_address:
                    address: 127.0.0.1
                    port_value: 8080
    admin:
      address:
        socket_address:
          address: 0.0.0.0
          port_value: 9901
```

```yaml
# Pod with manual Envoy sidecar
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-with-envoy
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
      initContainers:
      - name: envoy-sidecar
        image: envoyproxy/envoy:v1.28.0
        restartPolicy: Always
        args:
        - -c
        - /etc/envoy/envoy.yaml
        readinessProbe:
          httpGet:
            path: /ready
            port: 9901
          initialDelaySeconds: 1
          periodSeconds: 2
          successThreshold: 1
          failureThreshold: 10
        livenessProbe:
          httpGet:
            path: /ready
            port: 9901
          initialDelaySeconds: 10
          periodSeconds: 30
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 256Mi
        volumeMounts:
        - name: envoy-config
          mountPath: /etc/envoy
        securityContext:
          runAsUser: 1337
          runAsNonRoot: true
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities:
            drop: ["ALL"]

      containers:
      - name: app
        image: myapp:1.0.0
        ports:
        - containerPort: 8080
          name: http
        readinessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 10
        resources:
          requests:
            cpu: 200m
            memory: 256Mi
          limits:
            cpu: 1000m
            memory: 512Mi
        securityContext:
          runAsNonRoot: true
          runAsUser: 1000
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities:
            drop: ["ALL"]

      volumes:
      - name: envoy-config
        configMap:
          name: envoy-sidecar-config
```

## Log Forwarding Sidecar Architecture

Log forwarding sidecars are the most common sidecar pattern after service mesh proxies. The native sidecar API solves the critical problem of log loss during shutdown.

### Fluent Bit Sidecar Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluent-bit-sidecar-config
  namespace: production
data:
  fluent-bit.conf: |
    [SERVICE]
        Flush         1
        Daemon        Off
        Log_Level     info
        Parsers_File  parsers.conf
        HTTP_Server   On
        HTTP_Listen   0.0.0.0
        HTTP_Port     2020

    [INPUT]
        Name              tail
        Tag               app.*
        Path              /var/log/app/*.log
        Parser            json
        DB                /var/log/flb_kube.db
        Mem_Buf_Limit     5MB
        Skip_Long_Lines   On
        Refresh_Interval  10
        # Read from the beginning of new files
        Read_from_Head    True

    [FILTER]
        Name                kubernetes
        Match               app.*
        Kube_URL            https://kubernetes.default.svc:443
        Kube_CA_File        /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
        Kube_Token_File     /var/run/secrets/kubernetes.io/serviceaccount/token
        Kube_Tag_Prefix     app.var.log.app.
        Merge_Log           On
        Merge_Log_Key       log_processed
        K8S-Logging.Parser  On
        K8S-Logging.Exclude Off

    [FILTER]
        Name  record_modifier
        Match *
        Record hostname ${HOSTNAME}
        Record pod_name ${POD_NAME}
        Record namespace ${POD_NAMESPACE}
        Record node_name ${NODE_NAME}

    [OUTPUT]
        Name            es
        Match           app.*
        Host            elasticsearch.logging.svc.cluster.local
        Port            9200
        HTTP_User       ${ES_USERNAME}
        HTTP_Passwd     ${ES_PASSWORD}
        Index           app-logs
        Type            _doc
        Logstash_Format On
        Logstash_Prefix app-logs
        tls             On
        tls.verify      Off
        Retry_Limit     5

  parsers.conf: |
    [PARSER]
        Name        json
        Format      json
        Time_Key    timestamp
        Time_Format %Y-%m-%dT%H:%M:%S.%L%z
        Time_Keep   On
```

```yaml
# Deployment with Fluent Bit native sidecar
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
      serviceAccountName: log-forwarder-sa
      terminationGracePeriodSeconds: 45
      initContainers:
      - name: fluent-bit
        image: fluent/fluent-bit:2.2.0
        restartPolicy: Always
        env:
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        - name: POD_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace
        - name: NODE_NAME
          valueFrom:
            fieldRef:
              fieldPath: spec.nodeName
        - name: ES_USERNAME
          valueFrom:
            secretKeyRef:
              name: elasticsearch-credentials
              key: username
        - name: ES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: elasticsearch-credentials
              key: password
        readinessProbe:
          httpGet:
            path: /api/v1/health
            port: 2020
          initialDelaySeconds: 2
          periodSeconds: 5
        livenessProbe:
          httpGet:
            path: /api/v1/health
            port: 2020
          initialDelaySeconds: 10
          periodSeconds: 30
        lifecycle:
          preStop:
            exec:
              command:
              - /bin/sh
              - -c
              - |
                # Wait for final log flush before exit
                sleep 5
        resources:
          requests:
            cpu: 50m
            memory: 64Mi
          limits:
            cpu: 200m
            memory: 128Mi
        volumeMounts:
        - name: log-volume
          mountPath: /var/log/app
          readOnly: true
        - name: fluent-bit-config
          mountPath: /fluent-bit/etc
        - name: fluent-bit-db
          mountPath: /var/log
        securityContext:
          runAsNonRoot: true
          runAsUser: 1000
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: false  # Needs to write DB file

      containers:
      - name: app
        image: myapp:1.0.0
        env:
        - name: LOG_DIR
          value: /var/log/app
        - name: LOG_FORMAT
          value: json
        lifecycle:
          preStop:
            exec:
              command:
              - /bin/sh
              - -c
              - |
                # Signal graceful shutdown to app
                kill -SIGTERM 1
                # Wait for in-flight requests to complete
                sleep 15
        resources:
          requests:
            cpu: 200m
            memory: 256Mi
          limits:
            cpu: 1000m
            memory: 512Mi
        volumeMounts:
        - name: log-volume
          mountPath: /var/log/app

      volumes:
      - name: log-volume
        emptyDir: {}
      - name: fluent-bit-config
        configMap:
          name: fluent-bit-sidecar-config
      - name: fluent-bit-db
        emptyDir: {}
```

### RBAC for Log Forwarder ServiceAccount

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: log-forwarder-sa
  namespace: production
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: log-forwarder
rules:
- apiGroups: [""]
  resources:
  - namespaces
  - pods
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: log-forwarder-binding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: log-forwarder
subjects:
- kind: ServiceAccount
  name: log-forwarder-sa
  namespace: production
```

## Health Check Coordination Between Main Container and Sidecar

One of the most nuanced aspects of sidecar design is health check coordination. A Pod is Ready only when ALL containers report Ready. This can be used deliberately to gate traffic until sidecars are fully operational, or it can cause unexpected delays.

### Coordinating Readiness Gates

For scenarios where the main container's readiness depends on sidecar state (beyond the startup ordering guarantee), use Pod Readiness Gates:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: coordinated-health-pod
spec:
  readinessGates:
  - conditionType: "feature-gate/proxy-ready"
  - conditionType: "feature-gate/config-loaded"

  initContainers:
  - name: config-loader
    image: myapp-config:1.0.0
    restartPolicy: Always
    readinessProbe:
      exec:
        command:
        - /bin/sh
        - -c
        - |
          # Check if config is loaded and fresh
          test -f /config/app.yaml && \
          test $(( $(date +%s) - $(stat -c %Y /config/app.yaml) )) -lt 300
      initialDelaySeconds: 5
      periodSeconds: 30
    volumeMounts:
    - name: config-volume
      mountPath: /config

  containers:
  - name: app
    image: myapp:1.0.0
    readinessProbe:
      httpGet:
        path: /healthz/ready
        port: 8080
      initialDelaySeconds: 10
      periodSeconds: 5

  volumes:
  - name: config-volume
    emptyDir: {}
```

### Sidecar Health Propagation Controller

For advanced scenarios, implement a controller that propagates sidecar health to Pod conditions:

```go
// health-propagator/main.go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "os"
    "time"

    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/types"
    "k8s.io/client-go/kubernetes"
    "k8s.io/client-go/rest"
)

const (
    proxyHealthEndpoint = "http://localhost:9901/ready"
    podName             = "POD_NAME"
    podNamespace        = "POD_NAMESPACE"
    conditionType       = "feature-gate/proxy-ready"
    checkInterval       = 5 * time.Second
)

func checkProxyHealth() bool {
    client := &http.Client{Timeout: 2 * time.Second}
    resp, err := client.Get(proxyHealthEndpoint)
    if err != nil {
        return false
    }
    defer resp.Body.Close()
    return resp.StatusCode == http.StatusOK
}

func updatePodCondition(ctx context.Context, clientset *kubernetes.Clientset, healthy bool) error {
    name := os.Getenv(podName)
    namespace := os.Getenv(podNamespace)

    status := corev1.ConditionFalse
    reason := "ProxyUnhealthy"
    message := "Envoy proxy is not ready"
    if healthy {
        status = corev1.ConditionTrue
        reason = "ProxyHealthy"
        message = "Envoy proxy is ready and accepting traffic"
    }

    patch := map[string]interface{}{
        "status": map[string]interface{}{
            "conditions": []map[string]interface{}{
                {
                    "type":               conditionType,
                    "status":             string(status),
                    "lastTransitionTime": metav1.Now().UTC().Format(time.RFC3339),
                    "reason":             reason,
                    "message":            message,
                },
            },
        },
    }

    patchBytes, err := json.Marshal(patch)
    if err != nil {
        return fmt.Errorf("marshaling patch: %w", err)
    }

    _, err = clientset.CoreV1().Pods(namespace).Patch(
        ctx,
        name,
        types.MergePatchType,
        patchBytes,
        metav1.PatchOptions{},
        "status",
    )
    return err
}

func main() {
    config, err := rest.InClusterConfig()
    if err != nil {
        panic(err)
    }
    clientset, err := kubernetes.NewForConfig(config)
    if err != nil {
        panic(err)
    }

    ctx := context.Background()
    ticker := time.NewTicker(checkInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ticker.C:
            healthy := checkProxyHealth()
            if err := updatePodCondition(ctx, clientset, healthy); err != nil {
                fmt.Fprintf(os.Stderr, "Failed to update pod condition: %v\n", err)
            }
        case <-ctx.Done():
            return
        }
    }
}
```

## Job and CronJob Sidecar Patterns

Native sidecars are especially valuable for batch workloads (Jobs and CronJobs), where the pre-1.29 behavior caused sidecars to keep the Pod alive indefinitely even after the main container completed.

### Pre-1.29 Job Sidecar Problem

```bash
# Pre-1.29: Job pod hangs because fluent-bit sidecar never exits
kubectl get pods -n batch
# NAME                    READY   STATUS    RESTARTS   AGE
# batch-job-xk9f2         1/2     Running   0          45m  # Stuck!
```

### Native Sidecar Job Configuration

With native sidecars, sidecar containers receive SIGTERM when the main container exits, regardless of `restartPolicy: OnFailure` at the Job level:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: data-processor
  namespace: batch
spec:
  completions: 10
  parallelism: 5
  backoffLimit: 3
  template:
    spec:
      restartPolicy: OnFailure
      initContainers:
      - name: log-forwarder
        image: fluent/fluent-bit:2.2.0
        restartPolicy: Always  # Native sidecar
        volumeMounts:
        - name: log-volume
          mountPath: /var/log/app
          readOnly: true
        - name: fb-config
          mountPath: /fluent-bit/etc

      containers:
      - name: processor
        image: data-processor:2.0.0
        command:
        - /bin/sh
        - -c
        - |
          echo "Starting data processing batch"
          ./process-data --input /data/input --output /data/output
          EXIT_CODE=$?
          echo "Processing complete with exit code: $EXIT_CODE"
          # Write final log line
          echo '{"level":"info","msg":"batch_complete","exit_code":'$EXIT_CODE'}' >> /var/log/app/app.log
          exit $EXIT_CODE
        volumeMounts:
        - name: log-volume
          mountPath: /var/log/app
        - name: data-volume
          mountPath: /data
        resources:
          requests:
            cpu: 500m
            memory: 1Gi
          limits:
            cpu: 2000m
            memory: 4Gi

      volumes:
      - name: log-volume
        emptyDir: {}
      - name: fb-config
        configMap:
          name: fluent-bit-batch-config
      - name: data-volume
        persistentVolumeClaim:
          claimName: batch-data-pvc
```

## Vault Agent Sidecar for Secret Management

Vault Agent as a native sidecar provides reliable secret injection and renewal:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: vault-agent-config
  namespace: production
data:
  vault-agent.hcl: |
    vault {
      address = "https://vault.vault.svc.cluster.local:8200"
    }

    auto_auth {
      method "kubernetes" {
        mount_path = "auth/kubernetes"
        config = {
          role = "myapp"
        }
      }
      sink "file" {
        config = {
          path = "/home/vault/.vault-token"
        }
      }
    }

    template {
      source      = "/vault/templates/database.tmpl"
      destination = "/vault/secrets/database.env"
      perms       = "0440"
      command     = "/bin/sh -c 'kill -HUP $(pgrep -x myapp) 2>/dev/null || true'"
    }

    cache {
      use_auto_auth_token = true
    }

  database.tmpl: |
    {{- with secret "database/creds/myapp-role" -}}
    DATABASE_USER={{ .Data.username }}
    DATABASE_PASSWORD={{ .Data.password }}
    {{- end -}}
```

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-with-vault
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
      serviceAccountName: myapp-vault-sa
      initContainers:
      # True init: fetch initial secrets before app starts
      - name: vault-agent-init
        image: hashicorp/vault:1.15.0
        command:
        - vault
        - agent
        - -config=/vault/config/vault-agent.hcl
        - -exit-after-auth
        env:
        - name: VAULT_ADDR
          value: "https://vault.vault.svc.cluster.local:8200"
        - name: VAULT_SKIP_VERIFY
          value: "false"
        volumeMounts:
        - name: vault-config
          mountPath: /vault/config
        - name: vault-templates
          mountPath: /vault/templates
        - name: vault-secrets
          mountPath: /vault/secrets
        restartPolicy: null  # Classic init container

      # Native sidecar: continuously renew secrets
      - name: vault-agent-renewer
        image: hashicorp/vault:1.15.0
        restartPolicy: Always
        command:
        - vault
        - agent
        - -config=/vault/config/vault-agent.hcl
        env:
        - name: VAULT_ADDR
          value: "https://vault.vault.svc.cluster.local:8200"
        readinessProbe:
          exec:
            command:
            - test
            - -f
            - /vault/secrets/database.env
          initialDelaySeconds: 5
          periodSeconds: 10
        volumeMounts:
        - name: vault-config
          mountPath: /vault/config
        - name: vault-templates
          mountPath: /vault/templates
        - name: vault-secrets
          mountPath: /vault/secrets
        resources:
          requests:
            cpu: 50m
            memory: 64Mi
          limits:
            cpu: 200m
            memory: 128Mi

      containers:
      - name: app
        image: myapp:1.0.0
        envFrom:
        - secretRef:
            name: app-static-secrets
        command:
        - /bin/sh
        - -c
        - |
          # Source dynamic secrets from vault
          set -a
          source /vault/secrets/database.env
          set +a
          exec ./myapp
        volumeMounts:
        - name: vault-secrets
          mountPath: /vault/secrets
          readOnly: true

      volumes:
      - name: vault-config
        configMap:
          name: vault-agent-config
      - name: vault-templates
        configMap:
          name: vault-agent-config
          items:
          - key: database.tmpl
            path: database.tmpl
      - name: vault-secrets
        emptyDir:
          medium: Memory  # Use tmpfs for secrets
```

## Debugging Native Sidecar Containers

### Inspecting Sidecar State

```bash
# Get detailed pod status including init container states
kubectl get pod native-sidecar-demo -o jsonpath='{.status.initContainerStatuses}' | jq .

# Expected output for native sidecars:
# [
#   {
#     "containerID": "containerd://abc123...",
#     "image": "fluent/fluent-bit:2.2.0",
#     "name": "fluent-bit",
#     "ready": true,
#     "restartCount": 0,
#     "state": {
#       "running": {
#         "startedAt": "2030-03-15T10:00:00Z"
#       }
#     }
#   }
# ]

# Stream logs from a sidecar
kubectl logs -f native-sidecar-demo -c fluent-bit

# Execute into a sidecar for debugging
kubectl exec -it native-sidecar-demo -c envoy -- /bin/sh

# Check sidecar resource usage
kubectl top pod native-sidecar-demo --containers
```

### Diagnosing Startup Failures

```bash
# Describe pod to see init container events
kubectl describe pod native-sidecar-demo

# Common failure: sidecar readinessProbe failing prevents main container from starting
# Look for:
# Events:
#   Warning  Unhealthy  Container envoy failed liveness probe
#   Normal   Killing    Container envoy failed liveness probe, will be restarted

# Check sidecar logs for startup errors
kubectl logs native-sidecar-demo -c envoy --previous

# Increase readinessProbe failure threshold for slow-starting sidecars
# initialDelaySeconds: 30  # Allow more time for initialization
# failureThreshold: 10     # Allow more failures before declaring not ready
```

### Network Debugging with Proxy Sidecars

```bash
# Access Envoy admin interface for traffic inspection
kubectl port-forward pod/app-with-envoy-xyz 9901:9901

# Check Envoy cluster stats
curl http://localhost:9901/stats/prometheus | grep upstream_cx

# View Envoy configuration dump
curl http://localhost:9901/config_dump | jq '.configs[] | select(.["@type"] | contains("RouteConfiguration"))'

# Check active connections
curl http://localhost:9901/stats | grep "active_cx"

# View recent access logs
kubectl exec -it app-with-envoy-xyz -c envoy -- \
  curl http://localhost:9901/clusters
```

## Performance Considerations

Sidecars consume resources that compete with the main container. Production sizing guidelines:

```yaml
# Conservative sidecar resource budgets
resources:
  # Fluent Bit (log forwarding)
  fluentbit:
    requests:
      cpu: 50m
      memory: 64Mi
    limits:
      cpu: 200m
      memory: 128Mi

  # Envoy proxy (service mesh)
  envoy:
    requests:
      cpu: 100m      # Higher for TLS termination
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 256Mi

  # Vault Agent (secret renewal)
  vault_agent:
    requests:
      cpu: 25m
      memory: 32Mi
    limits:
      cpu: 100m
      memory: 64Mi
```

For pods with multiple sidecars, account for total overhead:

```bash
# Calculate total sidecar overhead per pod
kubectl get pods -n production -o json | jq '
  .items[] | {
    name: .metadata.name,
    sidecar_cpu: [
      .spec.initContainers[] |
      select(.restartPolicy == "Always") |
      .resources.requests.cpu
    ] | add,
    main_cpu: .spec.containers[].resources.requests.cpu
  }'
```

## Key Takeaways

Native Kubernetes sidecar container support (Kubernetes 1.29+) resolves the fundamental ordering and lifecycle issues that plagued the sidecar pattern for years. The key improvements are:

**Startup ordering**: Native sidecars start in declaration order, with each sidecar's readinessProbe gating the next container's startup. Main containers start only after all sidecars are Ready.

**Shutdown ordering**: When a Pod terminates, sidecars receive SIGTERM after the main container exits. This solves log loss in log forwarding sidecars and connection draining in proxy sidecars.

**Job compatibility**: Native sidecars terminate automatically when the main container exits, solving the long-standing issue of Jobs hanging indefinitely due to running sidecar containers.

**Service mesh integration**: Istio 1.18+, Linkerd, and other service meshes support the native sidecar API, eliminating proxy injection race conditions.

For production deployments, combine native sidecar ordering with proper readinessProbes, terminationGracePeriodSeconds budgeting, and resource limits that account for the total sidecar overhead in your cluster capacity planning.
