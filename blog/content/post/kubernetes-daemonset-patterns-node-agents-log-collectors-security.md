---
title: "Kubernetes DaemonSet Patterns: Node Agents, Log Collectors, and Security Sensors"
date: 2029-03-18T00:00:00-05:00
draft: false
tags: ["Kubernetes", "DaemonSet", "Node Agents", "Logging", "Security", "Observability"]
categories:
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Kubernetes DaemonSet design patterns for node agents, log collectors, and security sensors — covering scheduling, resource management, host access patterns, rolling updates, and operational considerations for fleet-wide node-level workloads."
more_link: "yes"
url: "/kubernetes-daemonset-patterns-node-agents-log-collectors-security/"
---

DaemonSets are the mechanism for deploying exactly one pod per node (or per matching node subset) in a Kubernetes cluster. They are the foundation of infrastructure concerns that must run on every node: log collection, metrics collection, network policy enforcement, storage plugins, security sensors, and certificate distribution agents. Unlike Deployments, DaemonSets have a direct relationship with cluster topology — adding a node automatically schedules the DaemonSet pod; removing a node terminates it. This topology coupling creates distinct patterns for resource management, update strategy, and access control that differ significantly from application workload deployment.

<!--more-->

## DaemonSet Fundamentals

The Kubernetes scheduler bypasses normal scheduling for DaemonSets. Instead of finding a suitable node through the filter and score phases, the DaemonSet controller creates pods with `spec.nodeName` set to each matching node directly. This means:

- DaemonSet pods can run on nodes marked as `Unschedulable` (cordon does not prevent DaemonSet pods)
- DaemonSet pods can tolerate taints through `spec.tolerations`
- DaemonSet pods are not subject to the `PodFitsResources` filter — they must fit or the pod will be pending

### Basic DaemonSet Structure

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-exporter
  namespace: monitoring
  labels:
    app: node-exporter
spec:
  selector:
    matchLabels:
      app: node-exporter
  template:
    metadata:
      labels:
        app: node-exporter
      annotations:
        # Prometheus scrape configuration
        prometheus.io/scrape: "true"
        prometheus.io/port: "9100"
        prometheus.io/path: "/metrics"
    spec:
      # DaemonSet-specific tolerations
      tolerations:
      - effect: NoSchedule
        operator: Exists
      - effect: NoExecute
        operator: Exists
      - key: node-role.kubernetes.io/control-plane
        operator: Exists
        effect: NoSchedule
      # Host network access for network metrics
      hostNetwork: true
      hostPID: true
      # ServiceAccount for RBAC
      serviceAccountName: node-exporter
      # Priority to ensure scheduling even under pressure
      priorityClassName: system-node-critical
      containers:
      - name: node-exporter
        image: prom/node-exporter:v1.8.2
        args:
        - "--path.rootfs=/host"
        - "--path.procfs=/host/proc"
        - "--path.sysfs=/host/sys"
        - "--collector.filesystem.mount-points-exclude=^/(dev|proc|sys|var/lib/docker/.+|var/lib/kubelet/.+|run/containerd/.+)($|/)"
        ports:
        - name: metrics
          containerPort: 9100
          hostPort: 9100
          protocol: TCP
        resources:
          requests:
            cpu: "50m"
            memory: "64Mi"
          limits:
            cpu: "250m"
            memory: "192Mi"
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          runAsNonRoot: true
          runAsUser: 65534
          capabilities:
            drop: ["ALL"]
            add: ["SYS_TIME"]
        volumeMounts:
        - name: proc
          mountPath: /host/proc
          readOnly: true
        - name: sys
          mountPath: /host/sys
          readOnly: true
        - name: root
          mountPath: /host
          readOnly: true
          mountPropagation: HostToContainer
      volumes:
      - name: proc
        hostPath:
          path: /proc
      - name: sys
        hostPath:
          path: /sys
      - name: root
        hostPath:
          path: /
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
```

## Node Selection Patterns

### Running on a Subset of Nodes

DaemonSets support `nodeSelector` and `affinity` rules to restrict scheduling to specific nodes:

```yaml
spec:
  template:
    spec:
      # Node selector for GPU nodes only
      nodeSelector:
        accelerator: nvidia-tesla-a100

      # More expressive: node affinity for GPU and high-memory nodes
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: node.kubernetes.io/instance-type
                operator: In
                values:
                - p4d.24xlarge
                - p3.16xlarge
                - g4dn.12xlarge
              - key: kubernetes.io/os
                operator: In
                values:
                - linux
```

### Toleration Patterns for Infrastructure DaemonSets

Infrastructure components like CNI plugins, CSI drivers, and monitoring agents must run on all nodes including those with workload-exclusion taints:

```yaml
spec:
  template:
    spec:
      # Tolerate all taints — appropriate for critical infrastructure agents
      tolerations:
      - operator: Exists

      # More conservative: tolerate specific taints only
      tolerations:
      - key: node-role.kubernetes.io/control-plane
        operator: Exists
        effect: NoSchedule
      - key: node-role.kubernetes.io/etcd
        operator: Exists
        effect: NoExecute
      - key: node.kubernetes.io/not-ready
        operator: Exists
        effect: NoExecute
        tolerationSeconds: 300
      - key: node.kubernetes.io/unreachable
        operator: Exists
        effect: NoExecute
        tolerationSeconds: 300
      - key: node.kubernetes.io/disk-pressure
        operator: Exists
        effect: NoSchedule
      - key: node.kubernetes.io/memory-pressure
        operator: Exists
        effect: NoSchedule
      - key: node.kubernetes.io/pid-pressure
        operator: Exists
        effect: NoSchedule
```

## Log Collection Pattern

Fluentbit is the production standard for DaemonSet-based log collection, combining low resource overhead with rich transformation capabilities.

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: fluent-bit
  namespace: logging
spec:
  selector:
    matchLabels:
      app: fluent-bit
  template:
    metadata:
      labels:
        app: fluent-bit
      annotations:
        checksum/config: "{{ configmap-sha256 }}"
    spec:
      tolerations:
      - operator: Exists
      serviceAccountName: fluent-bit
      priorityClassName: system-node-critical
      terminationGracePeriodSeconds: 30
      containers:
      - name: fluent-bit
        image: fluent/fluent-bit:3.2.2
        ports:
        - containerPort: 2020
          name: http-metrics
          protocol: TCP
        resources:
          requests:
            cpu: "50m"
            memory: "64Mi"
          limits:
            cpu: "500m"
            memory: "256Mi"
        env:
        - name: NODE_NAME
          valueFrom:
            fieldRef:
              fieldPath: spec.nodeName
        - name: POD_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace
        livenessProbe:
          httpGet:
            path: /api/v1/health
            port: 2020
          initialDelaySeconds: 10
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /api/v1/health
            port: 2020
          initialDelaySeconds: 5
          periodSeconds: 5
        volumeMounts:
        - name: varlog
          mountPath: /var/log
          readOnly: true
        - name: varlibdockercontainers
          mountPath: /var/lib/docker/containers
          readOnly: true
        - name: etcmachineid
          mountPath: /etc/machine-id
          readOnly: true
        - name: config
          mountPath: /fluent-bit/etc
      volumes:
      - name: varlog
        hostPath:
          path: /var/log
      - name: varlibdockercontainers
        hostPath:
          path: /var/lib/docker/containers
      - name: etcmachineid
        hostPath:
          path: /etc/machine-id
          type: File
      - name: config
        configMap:
          name: fluent-bit-config
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 10%
```

### Fluent Bit Configuration for Kubernetes

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluent-bit-config
  namespace: logging
data:
  fluent-bit.conf: |
    [SERVICE]
        Daemon          Off
        Flush           5
        Log_Level       warn
        Parsers_File    parsers.conf
        HTTP_Server     On
        HTTP_Listen     0.0.0.0
        HTTP_Port       2020
        storage.metrics on
        storage.path    /tmp/fb-storage
        storage.sync    normal
        storage.checksum off
        storage.backlog.mem_limit 32MB

    [INPUT]
        Name              tail
        Tag               kube.*
        Path              /var/log/containers/*.log
        multiline.parser  docker, cri
        DB                /var/log/flb_kube.db
        DB.sync           normal
        Mem_Buf_Limit     32MB
        Skip_Long_Lines   On
        Refresh_Interval  10
        Ignore_Older      1d

    [FILTER]
        Name                kubernetes
        Match               kube.*
        Merge_Log           On
        Keep_Log            Off
        K8S-Logging.Parser  On
        K8S-Logging.Exclude On
        Kube_Tag_Prefix     kube.var.log.containers.
        # Enrich with pod metadata
        Labels              On
        Annotations         Off
        Use_Kubelet         Off

    [FILTER]
        Name    modify
        Match   kube.*
        Add     cluster eks-prod-us-east-1
        Add     environment production

    [OUTPUT]
        Name                    opensearch
        Match                   kube.*
        Host                    opensearch.logging.svc.cluster.local
        Port                    9200
        Index                   kubernetes-logs
        Logstash_Format         On
        Logstash_Prefix         k8s
        Logstash_DateFormat     %Y.%m.%d
        Retry_Limit             5
        Buffer_Size             5MB
        Workers                 2

  parsers.conf: |
    [PARSER]
        Name        json
        Format      json
        Time_Key    time
        Time_Format %Y-%m-%dT%H:%M:%S.%L%z

    [PARSER]
        Name        cri
        Format      regex
        Regex       ^(?<time>[^ ]+) (?<stream>stdout|stderr) (?<logtag>[^ ]*) (?<log>.*)$
        Time_Key    time
        Time_Format %Y-%m-%dT%H:%M:%S.%L%z
```

## Security Sensor Pattern (Falco-Style)

Security DaemonSets require elevated privileges and direct kernel access:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: security-sensor
  namespace: security
spec:
  selector:
    matchLabels:
      app: security-sensor
  template:
    metadata:
      labels:
        app: security-sensor
    spec:
      tolerations:
      - operator: Exists
      serviceAccountName: security-sensor
      hostNetwork: false
      hostPID: true
      priorityClassName: system-node-critical
      initContainers:
      # Init container loads the eBPF program
      - name: ebpf-loader
        image: registry.example.com/security-sensor:v2.1.0
        command: ["/usr/bin/loader"]
        securityContext:
          privileged: true
        volumeMounts:
        - name: boot
          mountPath: /host/boot
          readOnly: true
        - name: modules
          mountPath: /host/lib/modules
          readOnly: true
        - name: usr
          mountPath: /host/usr
          readOnly: true
        - name: etc
          mountPath: /host/etc
          readOnly: true
      containers:
      - name: sensor
        image: registry.example.com/security-sensor:v2.1.0
        securityContext:
          # Required for eBPF programs
          capabilities:
            add:
            - SYS_ADMIN
            - BPF
            - PERFMON
            drop:
            - ALL
          readOnlyRootFilesystem: true
          allowPrivilegeEscalation: false
        env:
        - name: NODE_NAME
          valueFrom:
            fieldRef:
              fieldPath: spec.nodeName
        - name: FALCO_BPF_PROBE
          value: ""
        ports:
        - containerPort: 8765
          name: grpc
        - containerPort: 8766
          name: health
        resources:
          requests:
            cpu: "100m"
            memory: "512Mi"
          limits:
            cpu: "1000m"
            memory: "1Gi"
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8766
          initialDelaySeconds: 60
          periodSeconds: 15
          failureThreshold: 3
        volumeMounts:
        - name: dev
          mountPath: /host/dev
        - name: proc
          mountPath: /host/proc
          readOnly: true
        - name: sys
          mountPath: /host/sys
          readOnly: true
        - name: boot
          mountPath: /host/boot
          readOnly: true
        - name: modules
          mountPath: /host/lib/modules
          readOnly: true
        - name: sensor-config
          mountPath: /etc/sensor
          readOnly: true
        - name: sensor-data
          mountPath: /var/run/sensor
      volumes:
      - name: dev
        hostPath:
          path: /dev
      - name: proc
        hostPath:
          path: /proc
      - name: sys
        hostPath:
          path: /sys
      - name: boot
        hostPath:
          path: /boot
      - name: modules
        hostPath:
          path: /lib/modules
      - name: usr
        hostPath:
          path: /usr
      - name: etc
        hostPath:
          path: /etc
      - name: sensor-config
        configMap:
          name: security-sensor-config
      - name: sensor-data
        emptyDir: {}
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      # Update one node at a time for security sensors
      maxUnavailable: 1
```

## Resource Management for DaemonSets

### Calculating Cluster-Wide DaemonSet Resource Impact

DaemonSets consume resources on every matching node. In a 200-node cluster, a DaemonSet requesting 100m CPU consumes 20 CPU cores cluster-wide. This must be accounted for in capacity planning:

```bash
# Calculate total DaemonSet resource consumption
kubectl get ds --all-namespaces -o json | jq -r '
  .items[] |
  .metadata.namespace + "/" + .metadata.name as $ds |
  .spec.template.spec.containers[] |
  [$ds, .name, (.resources.requests.cpu // "0"), (.resources.requests.memory // "0")] |
  @csv
'

# Get node count for a DaemonSet
kubectl get ds node-exporter -n monitoring -o json | \
  jq '.status | {desired: .desiredNumberScheduled, ready: .numberReady, available: .numberAvailable}'
```

### Priority Classes for DaemonSets

Assign appropriate priority classes to ensure DaemonSet pods are scheduled and not evicted:

```yaml
# Critical infrastructure agents (CNI, CSI, kube-proxy)
spec:
  template:
    spec:
      priorityClassName: system-node-critical  # value: 2000001000

# Important monitoring/logging agents
spec:
  template:
    spec:
      priorityClassName: system-cluster-critical  # value: 2000000000

# Non-critical auxiliary agents
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: daemonset-standard
value: 100000
globalDefault: false
---
spec:
  template:
    spec:
      priorityClassName: daemonset-standard
```

## Update Strategies

### OnDelete Update Strategy

Use `OnDelete` when updates require manual coordination (e.g., when node draining is required):

```yaml
spec:
  updateStrategy:
    type: OnDelete
```

With `OnDelete`, the DaemonSet controller only updates a pod when it is manually deleted. This is appropriate for components like CNI plugins where an uncoordinated update could disrupt all pod networking on a node.

### Rolling Update with maxSurge (Kubernetes 1.22+)

```yaml
spec:
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0   # Never allow unavailability
      maxSurge: 1         # Temporarily run 2 pods per node during update
```

`maxSurge` on DaemonSets allows running a second pod on the node during the update, enabling zero-downtime transitions for DaemonSets that use `hostPort` binding.

### Canary Update Pattern

For gradual rollout of DaemonSet updates to a subset of nodes:

```bash
# Label a subset of nodes for canary update
kubectl label node k8s-worker-01 k8s-worker-02 k8s-worker-03 \
  canary=daemonset-update

# Create a canary DaemonSet targeting only labeled nodes
# (This is a separate DaemonSet with the same functionality but new version)
```

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-exporter-canary
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: node-exporter
      release: canary
  template:
    metadata:
      labels:
        app: node-exporter
        release: canary
    spec:
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: canary
                operator: In
                values:
                - daemonset-update
      containers:
      - name: node-exporter
        image: prom/node-exporter:v1.9.0  # New version under test
        # ... same config as production DaemonSet ...
```

Monitor the canary, then proceed with the main DaemonSet update or roll back.

## Host Access Patterns and Security

### Minimal Host Access Principle

Grant the minimum host access required. Use the following checklist:

| Capability | When Required | Alternative |
|-----------|---------------|-------------|
| `hostNetwork: true` | CNI plugins, low-latency packet capture | `hostPort` for specific ports |
| `hostPID: true` | Process monitoring, eBPF probes | Downward API for pod info |
| `hostIPC: true` | Shared memory IPC (rare) | Usually avoidable |
| `privileged: true` | Kernel module loading | Specific capabilities (`CAP_SYS_ADMIN`) |
| Mounting `/dev` | Direct device access | Device plugins |
| Mounting `/proc` read-only | Process/network metrics | Read-only is sufficient |
| Mounting `/var/log` read-only | Log collection | Write access not needed |

### Pod Security Standards for DaemonSets

DaemonSets running in the `Restricted` Pod Security Standard profile cannot use host namespaces or privileged mode. Use the `Privileged` or `Baseline` PSS namespace label for infrastructure DaemonSet namespaces:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: logging
  labels:
    pod-security.kubernetes.io/enforce: baseline
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
---
apiVersion: v1
kind: Namespace
metadata:
  name: security
  labels:
    # Security sensors require privileged access
    pod-security.kubernetes.io/enforce: privileged
```

## Monitoring DaemonSet Health

### Prometheus Alerts for DaemonSet Coverage

```yaml
groups:
- name: daemonset.health
  rules:
  - alert: DaemonSetNotFullyScheduled
    expr: |
      kube_daemonset_status_desired_number_scheduled
      - kube_daemonset_status_number_ready > 0
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "DaemonSet {{ $labels.namespace }}/{{ $labels.daemonset }} not fully scheduled"
      description: "{{ $value }} pods in DaemonSet {{ $labels.namespace }}/{{ $labels.daemonset }} are not ready. Check node affinity, tolerations, and resource availability."

  - alert: DaemonSetMisscheduled
    expr: kube_daemonset_status_number_misscheduled > 0
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "DaemonSet {{ $labels.namespace }}/{{ $labels.daemonset }} has misscheduled pods"
      description: "{{ $value }} pods are running on nodes where they should not be scheduled."

  - alert: DaemonSetUpdateRolledOut
    expr: |
      kube_daemonset_status_updated_number_scheduled
      / kube_daemonset_status_desired_number_scheduled < 1
    for: 30m
    labels:
      severity: warning
    annotations:
      summary: "DaemonSet {{ $labels.namespace }}/{{ $labels.daemonset }} update in progress for >30 minutes"
      description: "Only {{ $value | humanizePercentage }} of pods are updated. Check for unhealthy nodes or pod crash loops during the update."
```

### Operational Runbook: DaemonSet Coverage Gaps

```bash
# Find nodes where a DaemonSet pod is not running
DAEMONSET="node-exporter"
NAMESPACE="monitoring"

# Get nodes with the DaemonSet pod
NODES_WITH_POD=$(kubectl get pods -n $NAMESPACE \
  -l app=$DAEMONSET \
  -o jsonpath='{.items[*].spec.nodeName}' | tr ' ' '\n' | sort)

# Get all schedulable nodes
ALL_NODES=$(kubectl get nodes \
  --field-selector spec.unschedulable=false \
  -o jsonpath='{.items[*].metadata.name}' | tr ' ' '\n' | sort)

# Find the difference
MISSING=$(comm -23 <(echo "$ALL_NODES") <(echo "$NODES_WITH_POD"))
echo "Nodes missing $DAEMONSET pod:"
echo "$MISSING"

# Diagnose why the DaemonSet pod is not scheduled on a specific node
kubectl describe node <missing-node> | grep -E "Taints:|Conditions:"
kubectl get events --field-selector involvedObject.kind=Pod \
  --field-selector involvedObject.namespace=$NAMESPACE \
  -n $NAMESPACE | grep $DAEMONSET
```

## Complete Example: Certificate Distribution Agent

A DaemonSet that distributes CA certificates to each node's trust store demonstrates combining multiple patterns:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: ca-cert-distributor
  namespace: cert-distribution
spec:
  selector:
    matchLabels:
      app: ca-cert-distributor
  template:
    metadata:
      labels:
        app: ca-cert-distributor
    spec:
      tolerations:
      - operator: Exists
      serviceAccountName: ca-cert-distributor
      hostNetwork: false
      priorityClassName: system-cluster-critical
      initContainers:
      - name: distributor
        image: registry.example.com/ca-distributor:v1.0.0
        command:
        - /bin/sh
        - -c
        - |
          set -e
          cp /certs/internal-ca.crt /host-certs/internal-ca.crt
          # Update the system trust store on the node
          if [ -d /host-etc/ca-certificates ]; then
            cp /certs/internal-ca.crt /host-etc/ca-certificates/internal-ca.crt
            chroot /host update-ca-certificates
          fi
          echo "CA certificate distributed successfully"
        securityContext:
          privileged: true
          runAsUser: 0
        volumeMounts:
        - name: host-certs
          mountPath: /host-certs
        - name: host-etc
          mountPath: /host-etc
        - name: certs
          mountPath: /certs
          readOnly: true
      containers:
      - name: watcher
        image: registry.example.com/ca-distributor:v1.0.0
        command:
        - /bin/ca-watcher
        args:
        - --cert-dir=/certs
        - --host-cert-dir=/host-certs
        - --update-interval=1h
        resources:
          requests:
            cpu: "10m"
            memory: "32Mi"
          limits:
            cpu: "50m"
            memory: "64Mi"
        volumeMounts:
        - name: host-certs
          mountPath: /host-certs
        - name: certs
          mountPath: /certs
          readOnly: true
      volumes:
      - name: host-certs
        hostPath:
          path: /usr/local/share/ca-certificates
          type: DirectoryOrCreate
      - name: host-etc
        hostPath:
          path: /etc
          type: Directory
      - name: certs
        secret:
          secretName: internal-ca-bundle
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 10%
```

This pattern — init container for one-time setup, main container for ongoing maintenance — is broadly applicable to node configuration agents, certificate managers, and kernel parameter tuners.
