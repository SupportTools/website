---
title: "Kubernetes API Server Operations: Tuning, Auditing, and High Availability"
date: 2027-08-22T00:00:00-05:00
draft: false
tags: ["Kubernetes", "API Server", "Security", "Operations"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Production API server operations covering admission plugin configuration, audit logging to Elasticsearch, API server flags tuning, request priority and fairness, HA API server setup, and API server aggregation for CRDs."
more_link: "yes"
url: "/kubernetes-api-server-operations-guide/"
---

The Kubernetes API server is the central nervous system of the cluster: every kubectl command, controller reconciliation, and webhook call passes through it. Under-tuned API servers throttle under load, audit logging gaps leave security investigations incomplete, and a single API server is a single point of failure. Production operations demand careful attention to admission configuration, request routing fairness, HA deployment, and comprehensive audit trails.

<!--more-->

## API Server Architecture

The kube-apiserver processes requests through a defined pipeline:

```
Request
  ↓
Authentication (certificates, tokens, OIDC)
  ↓
Authorization (RBAC, ABAC, Webhook)
  ↓
Admission Controllers
  ├── Mutating Admission Webhooks
  ├── Schema Validation
  └── Validating Admission Webhooks
  ↓
etcd persistence
  ↓
Response
```

Understanding this pipeline determines where to apply controls and where to instrument for observability.

### Checking API Server Configuration

```bash
# View current API server flags (kubeadm clusters)
kubectl get pod kube-apiserver-<node-name> -n kube-system -o yaml | \
  grep -A 100 "containers:" | grep "\-\-"

# Or directly on the control plane node
cat /etc/kubernetes/manifests/kube-apiserver.yaml | grep "\-\-"

# Check API server version and capabilities
kubectl version --short
kubectl api-versions | sort
kubectl api-resources | wc -l
```

## Admission Plugin Configuration

### Enabled Admission Plugins

```bash
# View enabled admission plugins
kubectl get pod kube-apiserver-<node-name> -n kube-system -o yaml | \
  grep enable-admission-plugins
```

Recommended admission plugin set for production:

```yaml
# kube-apiserver.yaml (kubeadm static pod manifest)
spec:
  containers:
    - command:
        - kube-apiserver
        - --enable-admission-plugins=NodeRestriction,ResourceQuota,LimitRanger,ServiceAccount,DefaultStorageClass,DefaultTolerationSeconds,MutatingAdmissionWebhook,ValidatingAdmissionWebhook,PodSecurity
        - --disable-admission-plugins=AlwaysAdmit
```

### Configuring Pod Security Admission

Pod Security Admission (PSA) is now the built-in mechanism replacing PodSecurityPolicy:

```yaml
# admission-configuration.yaml
apiVersion: apiserver.config.k8s.io/v1
kind: AdmissionConfiguration
plugins:
  - name: PodSecurity
    configuration:
      apiVersion: pod-security.admission.config.k8s.io/v1
      kind: PodSecurityConfiguration
      defaults:
        enforce: "baseline"
        enforce-version: "latest"
        audit: "restricted"
        audit-version: "latest"
        warn: "restricted"
        warn-version: "latest"
      exemptions:
        usernames: []
        runtimeClasses: []
        namespaces:
          - kube-system
          - kube-public
          - monitoring
          - longhorn-system
```

Reference this file in the API server:

```yaml
# kube-apiserver.yaml
- --admission-control-config-file=/etc/kubernetes/admission-config.yaml
```

### Webhook Admission Configuration

```yaml
# validating-webhook-config.yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: policy-enforcement
webhooks:
  - name: validate.example.com
    admissionReviewVersions: ["v1", "v1beta1"]
    clientConfig:
      service:
        name: policy-webhook
        namespace: policy-system
        path: "/validate"
      caBundle: LS0t...    # Base64-encoded CA certificate
    rules:
      - apiGroups: ["apps"]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["deployments", "statefulsets"]
    failurePolicy: Fail
    sideEffects: None
    timeoutSeconds: 10
    namespaceSelector:
      matchExpressions:
        - key: policy-enforcement
          operator: In
          values: ["enabled"]
```

**Important production considerations for admission webhooks:**

```yaml
# For webhooks that must not block cluster operations:
failurePolicy: Ignore    # Fail open — webhook errors don't block requests

# Add bypass annotation for critical system namespaces
namespaceSelector:
  matchExpressions:
    - key: kubernetes.io/metadata.name
      operator: NotIn
      values: ["kube-system", "kube-public"]
```

## Audit Logging

### Audit Policy Configuration

Audit logging captures all API server activity. The policy controls what gets logged:

```yaml
# audit-policy.yaml
apiVersion: audit.k8s.io/v1
kind: Policy
omitStages:
  - "RequestReceived"   # Avoid duplicate logging before response
rules:
  # Log authentication failures at Request level
  - level: Request
    verbs: ["create"]
    resources:
      - group: "authentication.k8s.io"
        resources: ["tokenreviews"]

  # Never audit read-only API health endpoints
  - level: None
    users: ["system:kube-proxy"]
    verbs: ["watch"]
    resources:
      - group: ""
        resources: ["endpoints", "services", "services/status"]

  # Never audit node kubelet reads
  - level: None
    userGroups: ["system:nodes"]
    verbs: ["get", "list", "watch"]
    resources:
      - group: ""
        resources: ["nodes", "nodes/status", "pods", "pods/status"]

  # Never audit frequent read-only requests from controllers
  - level: None
    users:
      - "system:kube-controller-manager"
      - "system:kube-scheduler"
    verbs: ["get", "list", "watch"]

  # Capture secret access at Metadata level (no data)
  - level: Metadata
    resources:
      - group: ""
        resources: ["secrets", "configmaps"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]

  # Capture all writes at RequestResponse level
  - level: RequestResponse
    verbs: ["create", "update", "patch", "delete", "deletecollection"]

  # Default: log everything else at Metadata level
  - level: Metadata
```

Enable audit logging in the API server:

```yaml
# kube-apiserver.yaml additions
- --audit-policy-file=/etc/kubernetes/audit-policy.yaml
- --audit-log-path=/var/log/kubernetes/audit.log
- --audit-log-maxsize=100         # MB per file
- --audit-log-maxbackup=10        # Number of rotated files
- --audit-log-maxage=30           # Days to retain
- --audit-log-compress=true
```

### Shipping Audit Logs to Elasticsearch

Use Filebeat as a DaemonSet to ship audit logs:

```yaml
# filebeat-audit-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: filebeat-config
  namespace: logging
data:
  filebeat.yml: |
    filebeat.inputs:
      - type: log
        enabled: true
        paths:
          - /var/log/kubernetes/audit*.log
        json.keys_under_root: true
        json.add_error_key: true
        tags: ["kubernetes-audit"]
        fields:
          log_type: audit
          cluster: production
        fields_under_root: true

    output.elasticsearch:
      hosts: ["https://elasticsearch.logging.svc.cluster.local:9200"]
      index: "kubernetes-audit-%{+yyyy.MM.dd}"
      username: "${ELASTICSEARCH_USERNAME}"
      password: "${ELASTICSEARCH_PASSWORD}"
      ssl.certificate_authorities: ["/usr/share/filebeat/config/ca.crt"]

    setup.ilm.enabled: true
    setup.ilm.rollover_alias: "kubernetes-audit"
    setup.ilm.pattern: "{now/d}-000001"
    setup.ilm.policy_name: "kubernetes-audit-30-day"
```

Useful Elasticsearch queries for security investigations:

```json
{
  "query": {
    "bool": {
      "must": [
        { "term": { "verb": "delete" } },
        { "term": { "objectRef.resource": "secrets" } },
        { "range": { "@timestamp": { "gte": "now-1h" } } }
      ],
      "must_not": [
        { "term": { "user.username": "system:serviceaccount:kube-system:replication-controller" } }
      ]
    }
  }
}
```

## API Server Performance Tuning

### Request Throttling Flags

```yaml
# kube-apiserver.yaml flags
- --max-requests-inflight=800          # Default 400 — increase for large clusters
- --max-mutating-requests-inflight=400 # Default 200
- --request-timeout=120s               # Default 60s
- --min-request-timeout=300            # Minimum for watch requests
```

### API Priority and Fairness (APF)

APF replaces the simple `--max-requests-inflight` with a sophisticated priority queue system:

```bash
# Check APF status
kubectl get flowschemas
kubectl get prioritylevelconfigurations

# View current concurrency limits
kubectl get prioritylevelconfigurations -o yaml | \
  grep -A 5 "limited:"
```

Create custom priority levels for critical workloads:

```yaml
# apf-priority-level.yaml
apiVersion: flowcontrol.apiserver.k8s.io/v1
kind: PriorityLevelConfiguration
metadata:
  name: critical-controllers
spec:
  type: Limited
  limited:
    nominalConcurrencyShares: 30
    limitResponse:
      type: Queue
      queuing:
        queues: 64
        handSize: 6
        queueLengthLimit: 100
---
apiVersion: flowcontrol.apiserver.k8s.io/v1
kind: FlowSchema
metadata:
  name: critical-controller-flows
spec:
  priorityLevelConfiguration:
    name: critical-controllers
  matchingPrecedence: 500
  distinguisherMethod:
    type: ByUser
  rules:
    - subjects:
        - kind: ServiceAccount
          serviceAccount:
            namespace: production
            name: critical-reconciler
      resourceRules:
        - verbs: ["*"]
          apiGroups: ["*"]
          resources: ["*"]
```

```bash
# Monitor APF metrics
kubectl get --raw /metrics | grep apiserver_flowcontrol | grep -E "request_concurrency|dispatched"

# Check if requests are being queued/rejected
kubectl get --raw /metrics | grep apiserver_flowcontrol_rejected_requests_total
```

### etcd Connection Tuning

```yaml
# kube-apiserver.yaml
- --etcd-servers=https://10.0.1.10:2379,https://10.0.1.11:2379,https://10.0.1.12:2379
- --etcd-compaction-interval=5m        # How often API server triggers compaction
- --etcd-count-metric-poll-period=1m   # How often etcd object counts are polled
- --storage-backend=etcd3
- --storage-media-type=application/vnd.kubernetes.protobuf  # Protobuf is faster than JSON
```

## High Availability API Server Setup

### Load Balancer Configuration

For on-premises clusters, HAProxy provides API server load balancing:

```
# /etc/haproxy/haproxy.cfg
global
    log stdout format raw local0 info
    maxconn 4000

defaults
    mode tcp
    log global
    option tcplog
    option tcp-check
    timeout connect 5s
    timeout client 50s
    timeout server 50s

frontend kubernetes-apiserver
    bind *:6443
    default_backend kubernetes-apiserver-backend

backend kubernetes-apiserver-backend
    balance roundrobin
    option tcp-check
    server control-plane-1 10.0.1.10:6443 check fall 3 rise 2
    server control-plane-2 10.0.1.11:6443 check fall 3 rise 2
    server control-plane-3 10.0.1.12:6443 check fall 3 rise 2
```

For keepalived (VIP failover):

```
# /etc/keepalived/keepalived.conf
vrrp_script check_apiserver {
    script "/usr/local/bin/check-apiserver.sh"
    interval 3
    weight -2
    fall 10
    rise 2
}

vrrp_instance VI_1 {
    state MASTER
    interface eth0
    virtual_router_id 51
    priority 101
    advert_int 1
    authentication {
        auth_type PASS
        auth_pass KEEPALIVED_PASSWORD_REPLACE_ME
    }
    virtual_ipaddress {
        10.0.1.100/24
    }
    track_script {
        check_apiserver
    }
}
```

### API Server Health Check Script for keepalived

```bash
#!/usr/bin/env bash
# /usr/local/bin/check-apiserver.sh
curl -sk https://localhost:6443/healthz -o /dev/null && \
  curl -sk https://localhost:6443/readyz -o /dev/null
exit $?
```

### kubeadm HA Control Plane Initialization

```yaml
# kubeadm-config-ha.yaml
apiVersion: kubeadm.k8s.io/v1beta3
kind: ClusterConfiguration
kubernetesVersion: "1.30.0"
controlPlaneEndpoint: "10.0.1.100:6443"   # Load balancer VIP
etcd:
  external:
    endpoints:
      - "https://10.0.1.10:2379"
      - "https://10.0.1.11:2379"
      - "https://10.0.1.12:2379"
    caFile: "/etc/etcd/ca.crt"
    certFile: "/etc/etcd/kubernetes.crt"
    keyFile: "/etc/etcd/kubernetes.key"
networking:
  serviceSubnet: "10.96.0.0/12"
  podSubnet: "10.244.0.0/16"
  dnsDomain: "cluster.local"
apiServer:
  extraArgs:
    audit-policy-file: "/etc/kubernetes/audit-policy.yaml"
    audit-log-path: "/var/log/kubernetes/audit.log"
    audit-log-maxsize: "100"
    audit-log-maxbackup: "10"
    enable-admission-plugins: "NodeRestriction,PodSecurity"
    request-timeout: "120s"
    max-requests-inflight: "800"
    max-mutating-requests-inflight: "400"
  extraVolumes:
    - name: audit-policy
      hostPath: "/etc/kubernetes/audit-policy.yaml"
      mountPath: "/etc/kubernetes/audit-policy.yaml"
      readOnly: true
      pathType: File
    - name: audit-log-dir
      hostPath: "/var/log/kubernetes"
      mountPath: "/var/log/kubernetes"
      readOnly: false
      pathType: DirectoryOrCreate
```

## API Aggregation Layer

### Registering an Extension API Server

The aggregation layer allows custom APIs to appear alongside native Kubernetes APIs:

```yaml
# api-service-registration.yaml
apiVersion: apiregistration.k8s.io/v1
kind: APIService
metadata:
  name: v1alpha1.metrics.example.com
spec:
  service:
    name: custom-metrics-apiserver
    namespace: monitoring
    port: 443
  group: metrics.example.com
  version: v1alpha1
  insecureSkipTLSVerify: false
  caBundle: LS0t...    # Base64-encoded CA cert for the extension API server
  groupPriorityMinimum: 100
  versionPriority: 100
```

```bash
# Verify the API service is available
kubectl get apiservice v1alpha1.metrics.example.com
kubectl api-resources | grep metrics.example.com

# Check aggregation layer connectivity
kubectl get apiservice v1alpha1.metrics.example.com -o yaml | grep -A 10 "status:"
```

### Monitoring API Server Health

```yaml
# api-server-prometheus-alerts.yaml
groups:
  - name: apiserver
    rules:
      - alert: KubeAPIServerErrorsHigh
        expr: |
          sum(rate(apiserver_request_total{code=~"5.."}[5m])) /
          sum(rate(apiserver_request_total[5m])) > 0.01
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "API server error rate {{ $value | humanizePercentage }}"

      - alert: KubeAPIServerLatencyHigh
        expr: |
          histogram_quantile(0.99,
            sum(rate(apiserver_request_duration_seconds_bucket{verb!="WATCH"}[5m]))
            by (le, verb, resource)
          ) > 1
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "API server p99 latency {{ $value }}s for {{ $labels.verb }} {{ $labels.resource }}"

      - alert: KubeAPIServerRequestsDropping
        expr: apiserver_flowcontrol_rejected_requests_total > 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "APF rejecting requests — consider increasing priority level concurrency"
```

The API server's role as cluster gatekeeper makes its configuration decisions high-leverage: admission plugins enforce security policies before objects persist, audit logs provide the forensic foundation for incident response, APF prevents noisy controllers from starving interactive users, and HA configuration ensures the control plane survives individual node failures. Each configuration area directly translates to cluster reliability, security posture, and operator experience.
