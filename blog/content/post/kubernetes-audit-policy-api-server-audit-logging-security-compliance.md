---
title: "Kubernetes Audit Policy: Comprehensive API Server Audit Logging for Security and Compliance"
date: 2030-11-10T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Audit", "Security", "Compliance", "Logging", "Falco", "API Server"]
categories:
- Kubernetes
- Security
- Compliance
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise audit logging guide: audit policy levels, stage filtering, sensitive resource omission, log backend vs webhook backend, audit log analysis with Falco, and correlating audit events with alerting systems."
more_link: "yes"
url: "/kubernetes-audit-policy-api-server-audit-logging-security-compliance/"
---

Kubernetes API server audit logging provides an immutable record of every action taken against the cluster API. For security incident response, regulatory compliance (SOC 2, PCI DSS, FedRAMP), and operational debugging, a well-configured audit policy is indispensable. However, a misconfigured audit policy either generates enormous volumes of low-value events that overwhelm storage and analysis tools, or omits critical events that prevent effective incident investigation. This guide covers every aspect of Kubernetes audit logging from policy design through log analysis and alerting.

<!--more-->

## Audit Architecture Overview

The Kubernetes API server processes every incoming API request through a series of handlers before and after request execution. The audit subsystem hooks into this pipeline at defined stages:

```
API Request
     │
     ▼
┌──────────────┐
│ RequestReceived│ ← Stage 1: Request received before handler
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ ResponseStarted│ ← Stage 2: Response headers sent (for streaming responses)
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ResponseComplete│ ← Stage 3: Response body complete (normal case)
└──────┬───────┘
       │
       ▼
┌──────────────┐
│    Panic     │ ← Stage 4: Panic during request handling
└──────────────┘
```

For each stage, the audit policy determines what information is recorded:

| Level | Information Recorded |
|-------|---------------------|
| `None` | Nothing |
| `Metadata` | Request metadata: user, verb, resource, namespace, timestamp, response code |
| `Request` | Metadata + request body |
| `RequestResponse` | Metadata + request body + response body |

## Audit Policy Design

### Minimal Production Policy

The minimal policy suitable for most production clusters balances coverage with storage efficiency:

```yaml
# /etc/kubernetes/audit-policy.yaml
apiVersion: audit.k8s.io/v1
kind: Policy

# OmitStages controls which pipeline stages generate events.
# RequestReceived generates a duplicate event before the handler runs.
# Omitting it halves audit volume with no loss of useful information.
omitStages:
  - RequestReceived

rules:
  # ─── Suppress high-volume, low-value events ────────────────────────────

  # Silence continuous controller health checks — these are not security-relevant
  # and can generate thousands of events per minute
  - level: None
    users: ["system:apiserver"]
    verbs: ["get"]
    resources:
    - group: ""
      resources: ["endpoints"]

  # Silence kube-proxy leader election
  - level: None
    users: ["system:kube-proxy"]
    verbs: ["watch"]
    resources:
    - group: ""
      resources: ["endpoints", "services", "namespaces"]

  # Silence Kubernetes controller manager and scheduler health checks
  - level: None
    users:
    - "system:kube-controller-manager"
    - "system:kube-scheduler"
    - "system:serviceaccount:kube-system:endpoint-controller"
    verbs: ["get", "list", "watch"]
    resources:
    - group: ""
      resources: ["endpoints", "services"]

  # Silence node status updates from kubelet (extremely high volume)
  - level: None
    users: ["kubelet"]
    verbs: ["patch", "update"]
    resources:
    - group: ""
      resources: ["nodes/status", "pods/status"]

  # Silence metrics server scrapes
  - level: None
    userGroups: ["system:nodes"]
    verbs: ["get"]
    resources:
    - group: ""
      resources: ["nodes", "pods"]

  # Silence Prometheus scrapes of metrics endpoints
  - level: None
    nonResourceURLs:
    - "/metrics"
    - "/healthz"
    - "/readyz"
    - "/livez"

  # ─── Maximum verbosity for security-critical resources ────────────────

  # Secrets: full request and response logging for audit trail
  # Any access to secrets must be traceable
  - level: RequestResponse
    resources:
    - group: ""
      resources: ["secrets"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]

  # ConfigMaps: requests may contain credentials or sensitive data
  - level: Request
    resources:
    - group: ""
      resources: ["configmaps"]
    namespaces:
    - production
    - staging
    verbs: ["create", "update", "patch", "delete"]

  # RBAC changes: any modification to roles or bindings is high-importance
  - level: RequestResponse
    resources:
    - group: "rbac.authorization.k8s.io"
      resources:
      - "clusterroles"
      - "clusterrolebindings"
      - "roles"
      - "rolebindings"
    verbs: ["create", "update", "patch", "delete"]

  # Pod privileged access: exec, attach, portforward
  - level: RequestResponse
    resources:
    - group: ""
      resources:
      - "pods/exec"
      - "pods/attach"
      - "pods/portforward"

  # Namespace operations: creation and deletion are significant events
  - level: RequestResponse
    resources:
    - group: ""
      resources: ["namespaces"]
    verbs: ["create", "delete", "update", "patch"]

  # Persistent volume and storage class changes
  - level: RequestResponse
    resources:
    - group: ""
      resources: ["persistentvolumes"]
    - group: "storage.k8s.io"
      resources: ["storageclasses"]
    verbs: ["create", "update", "patch", "delete"]

  # Certificate signing requests (potential credential abuse)
  - level: RequestResponse
    resources:
    - group: "certificates.k8s.io"
      resources: ["certificatesigningrequests"]

  # Admission webhook configurations (changes affect policy enforcement)
  - level: RequestResponse
    resources:
    - group: "admissionregistration.k8s.io"
      resources:
      - "mutatingwebhookconfigurations"
      - "validatingwebhookconfigurations"

  # ─── Standard verbosity for workload resources ─────────────────────────

  # Deployments, StatefulSets, DaemonSets: log request body for change tracking
  - level: Request
    resources:
    - group: "apps"
      resources:
      - "deployments"
      - "statefulsets"
      - "daemonsets"
      - "replicasets"
    verbs: ["create", "update", "patch", "delete"]

  # Pod creation and deletion (for audit trail)
  - level: Request
    resources:
    - group: ""
      resources: ["pods"]
    verbs: ["create", "delete", "deletecollection"]

  # Service account changes
  - level: Request
    resources:
    - group: ""
      resources: ["serviceaccounts"]
    verbs: ["create", "update", "patch", "delete"]

  # CRD changes (operators and custom resources)
  - level: Request
    resources:
    - group: "apiextensions.k8s.io"
      resources: ["customresourcedefinitions"]
    verbs: ["create", "update", "patch", "delete"]

  # ─── Default: metadata only for everything else ────────────────────────
  - level: Metadata
    omitStages:
    - RequestReceived
```

### FedRAMP / DoD-Specific Policy

For federal compliance requirements, additional categories must be captured at maximum verbosity:

```yaml
# /etc/kubernetes/audit-policy-fedramp.yaml
apiVersion: audit.k8s.io/v1
kind: Policy

omitStages:
  - RequestReceived

rules:
  # ─── Suppress operational noise (same as production policy above) ─────

  - level: None
    users: ["system:kube-proxy"]
    verbs: ["watch"]
    resources:
    - group: ""
      resources: ["endpoints", "services"]

  - level: None
    nonResourceURLs:
    - "/healthz"
    - "/readyz"
    - "/livez"
    - "/metrics"

  # ─── NIST 800-53 / FedRAMP Required Events ────────────────────────────

  # AU-2: All authentication events (successful and failed)
  - level: RequestResponse
    nonResourceURLs:
    - "/api"
    - "/api/*"
    - "/apis"
    - "/apis/*"
    users:
    - "system:anonymous"

  # AU-2: Privileged function use
  - level: RequestResponse
    userGroups:
    - "system:masters"

  # AC-2: Account management (user/SA creation, modification, deletion)
  - level: RequestResponse
    resources:
    - group: ""
      resources:
      - "serviceaccounts"
      - "serviceaccounts/token"

  # AC-3: Access enforcement — all RBAC changes
  - level: RequestResponse
    resources:
    - group: "rbac.authorization.k8s.io"
      resources: ["*"]

  # AU-10: Non-repudiation — exec and attach
  - level: RequestResponse
    resources:
    - group: ""
      resources:
      - "pods/exec"
      - "pods/attach"
      - "pods/portforward"
      - "pods/log"

  # CM-5: Access restrictions for change — all resource modifications
  - level: RequestResponse
    verbs: ["create", "update", "patch", "delete", "deletecollection"]
    resources:
    - group: ""
      resources: ["secrets", "configmaps", "namespaces", "persistentvolumes"]
    - group: "apps"
      resources: ["*"]
    - group: "rbac.authorization.k8s.io"
      resources: ["*"]
    - group: "certificates.k8s.io"
      resources: ["*"]
    - group: "admissionregistration.k8s.io"
      resources: ["*"]
    - group: "networking.k8s.io"
      resources: ["networkpolicies", "ingresses"]

  # Default: capture everything else at metadata level
  - level: Metadata
```

## Configuring the API Server

### Log Backend Configuration

```yaml
# kube-apiserver static pod manifest additions
# /etc/kubernetes/manifests/kube-apiserver.yaml

spec:
  containers:
  - command:
    - kube-apiserver

    # Audit policy file path
    - --audit-policy-file=/etc/kubernetes/audit-policy.yaml

    # Log backend: write audit events to files
    - --audit-log-path=/var/log/kubernetes/audit/audit.log

    # Maximum age of log files (days)
    - --audit-log-maxage=90

    # Maximum number of old log files to retain
    - --audit-log-maxbackup=20

    # Maximum size of log file before rotation (MB)
    - --audit-log-maxsize=200

    # Log format: json (recommended) or legacy
    - --audit-log-format=json

    # Number of log files to compress in parallel
    - --audit-log-compress=true

    volumeMounts:
    - name: audit-policy
      mountPath: /etc/kubernetes/audit-policy.yaml
      readOnly: true
    - name: audit-log
      mountPath: /var/log/kubernetes/audit

  volumes:
  - name: audit-policy
    hostPath:
      path: /etc/kubernetes/audit-policy.yaml
      type: File
  - name: audit-log
    hostPath:
      path: /var/log/kubernetes/audit
      type: DirectoryOrCreate
```

### Webhook Backend Configuration

The webhook backend sends audit events to an external HTTP endpoint in real-time, enabling streaming analysis:

```yaml
# /etc/kubernetes/audit-webhook.yaml
# Webhook backend configuration for sending audit events to a collector

apiVersion: v1
kind: Config
clusters:
- name: audit-webhook
  cluster:
    # Audit log collector endpoint
    server: https://audit-collector.internal.example.com/api/v1/events
    # TLS verification for the audit collector
    certificate-authority: /etc/kubernetes/pki/audit-ca.crt
users:
- name: apiserver
  user:
    client-certificate: /etc/kubernetes/pki/audit-webhook-client.crt
    client-key: /etc/kubernetes/pki/audit-webhook-client.key
contexts:
- context:
    cluster: audit-webhook
    user: apiserver
  name: default
current-context: default
```

```yaml
# Add these flags to kube-apiserver command for webhook backend:
- --audit-webhook-config-file=/etc/kubernetes/audit-webhook.yaml
- --audit-webhook-initial-backoff=10s
# Batch mode (recommended for performance):
- --audit-webhook-mode=batch
- --audit-webhook-batch-max-size=400
- --audit-webhook-batch-max-wait=30s
- --audit-webhook-batch-buffer-size=10000
- --audit-webhook-batch-throttle-qps=10
- --audit-webhook-batch-throttle-burst=15
```

### Using Both Backends Simultaneously

Both the log backend and webhook backend can be active simultaneously. The log backend serves as local retention; the webhook backend enables real-time alerting:

```yaml
# Both backends are enabled when all of the following flags are present:
# --audit-log-path (enables log backend)
# --audit-webhook-config-file (enables webhook backend)
# Both receive all events matching the audit policy
```

## Audit Log Format and Fields

Understanding the JSON audit event structure enables effective analysis:

```json
{
  "kind": "Event",
  "apiVersion": "audit.k8s.io/v1",
  "level": "RequestResponse",
  "auditID": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "stage": "ResponseComplete",
  "requestURI": "/api/v1/namespaces/production/secrets/db-password",
  "verb": "get",
  "user": {
    "username": "john.doe@example.com",
    "uid": "abc123",
    "groups": ["engineering", "system:authenticated"],
    "extra": {
      "authentication.kubernetes.io/pod-name": ["kubectl-debug-xyz"],
      "authentication.kubernetes.io/pod-uid": ["def456"]
    }
  },
  "impersonatedUser": null,
  "sourceIPs": ["10.0.1.45", "203.0.113.22"],
  "userAgent": "kubectl/v1.30.0 (linux/amd64) kubernetes/abc1234",
  "objectRef": {
    "resource": "secrets",
    "namespace": "production",
    "name": "db-password",
    "uid": "789xyz",
    "apiVersion": "v1",
    "resourceVersion": "12345678"
  },
  "responseStatus": {
    "metadata": {},
    "code": 200
  },
  "requestObject": null,
  "responseObject": {
    "kind": "Secret",
    "apiVersion": "v1",
    "metadata": {
      "name": "db-password",
      "namespace": "production",
      "uid": "789xyz"
    },
    "type": "Opaque",
    "data": {
      "password": "REDACTED"
    }
  },
  "requestReceivedTimestamp": "2030-11-10T03:14:07.123456Z",
  "stageTimestamp": "2030-11-10T03:14:07.456789Z",
  "annotations": {
    "authorization.k8s.io/decision": "allow",
    "authorization.k8s.io/reason": "RBAC: allowed by ClusterRoleBinding production-secret-reader"
  }
}
```

Key fields for security analysis:
- `user.username`: Who made the request (OIDC email, service account, system user)
- `user.groups`: Group memberships at time of request
- `sourceIPs`: Client IP and any forwarding proxies
- `verb`: Action taken (get, list, create, update, patch, delete, exec)
- `objectRef`: What resource was accessed
- `responseStatus.code`: HTTP status (403 = unauthorized, 200 = success)
- `annotations.authorization.k8s.io/decision`: allow or forbid
- `annotations.authorization.k8s.io/reason`: Which RBAC rule granted/denied

## Sensitive Resource Omission

Audit events for Secrets at `RequestResponse` level capture the secret data in the response body. This creates a compliance risk: the audit log itself becomes a sensitive artifact containing secret values. Two approaches address this:

### Approach 1: Redact Secret Data at Metadata Level for Reads

```yaml
# Restrict Secret read events to Metadata level (no response body)
# Only log creation/modification at RequestResponse level
rules:
  # Reads of secrets: metadata only (no secret values in audit log)
  - level: Metadata
    resources:
    - group: ""
      resources: ["secrets"]
    verbs: ["get", "list", "watch"]

  # Secret mutations: log what was changed (no values if careful with Opaque secrets)
  - level: Request
    resources:
    - group: ""
      resources: ["secrets"]
    verbs: ["create", "update", "patch", "delete"]
```

### Approach 2: Webhook Backend with Server-Side Redaction

```python
# audit-collector.py — FastAPI webhook that redacts secret data before storage
from fastapi import FastAPI, Request
import json
import re

app = FastAPI()

SENSITIVE_FIELDS = {"password", "token", "key", "secret", "credential", "apiKey"}

def redact_object(obj, depth=0):
    """Recursively redact sensitive fields from audit objects."""
    if depth > 10:  # Prevent infinite recursion
        return obj
    if isinstance(obj, dict):
        return {
            k: "[REDACTED]" if k.lower() in SENSITIVE_FIELDS or "password" in k.lower()
               else redact_object(v, depth+1)
            for k, v in obj.items()
        }
    elif isinstance(obj, list):
        return [redact_object(item, depth+1) for item in obj]
    return obj

@app.post("/api/v1/events")
async def receive_audit_events(request: Request):
    body = await request.json()
    events = body.get("items", [])

    redacted_events = []
    for event in events:
        # Redact response objects containing sensitive data
        if "responseObject" in event and event.get("objectRef", {}).get("resource") == "secrets":
            event["responseObject"] = redact_object(event.get("responseObject", {}))

        # Redact request objects for secret creation/update
        if "requestObject" in event and event.get("objectRef", {}).get("resource") == "secrets":
            event["requestObject"] = redact_object(event.get("requestObject", {}))

        redacted_events.append(event)

    # Forward redacted events to storage (Elasticsearch, S3, etc.)
    store_events(redacted_events)
    return {"status": "ok", "count": len(redacted_events)}
```

## Audit Log Analysis with Falco

Falco can consume Kubernetes audit events from the API server webhook and apply rule-based detection:

```yaml
# /etc/falco/falco.yaml — Configure Falco to receive K8s audit events
k8s_audit_endpoint: /k8s-audit
webserver:
  enabled: true
  listen_port: 9765
  k8s_audit_endpoint: /k8s_audit
  ssl_enabled: false

plugins:
- name: k8saudit
  library_path: libk8saudit.so
  init_config:
    webhook_maxbatchsize: 200
  open_params: "http://:9765/k8s_audit"

load_plugins:
- k8saudit
- json
```

```yaml
# /etc/falco/rules.d/k8s-audit-rules.yaml
# Falco rules for Kubernetes audit event analysis

- rule: K8s Secret Access by Unexpected User
  desc: >
    Detects access to Kubernetes secrets by users not in the approved list.
    Secrets access should be limited to specific service accounts and operators.
  condition: >
    ka.verb in (get, list) and
    ka.target.resource = secrets and
    not ka.user.name in (allowed_secret_users) and
    not ka.user.name startswith "system:serviceaccount:cert-manager" and
    not ka.user.name startswith "system:serviceaccount:kube-system" and
    ka.response.code = 200
  output: >
    Kubernetes secret accessed by unexpected user
    (user=%ka.user.name verb=%ka.verb secret=%ka.target.name
    ns=%ka.target.namespace src_ip=%ka.source.ip)
  priority: WARNING
  tags: [k8s_audit, secrets, access_control]
  source: k8s_audit

- list: allowed_secret_users
  items:
  - "system:serviceaccount:vault-agent:vault-agent"
  - "system:serviceaccount:external-secrets:external-secrets"

- rule: K8s ClusterRole Binding Created
  desc: >
    Alert on creation or modification of ClusterRoleBindings.
    These grant cluster-wide permissions and must be reviewed.
  condition: >
    ka.verb in (create, update, patch) and
    ka.target.resource = clusterrolebindings and
    ka.response.code = 201
  output: >
    ClusterRoleBinding created/modified
    (user=%ka.user.name verb=%ka.verb binding=%ka.target.name
    subject=%ka.request.object.subjects[] role=%ka.request.object.roleRef.name)
  priority: WARNING
  tags: [k8s_audit, rbac]
  source: k8s_audit

- rule: K8s Privileged Container Created
  desc: >
    Detects creation of privileged containers via the audit log.
    Privileged containers have full host access.
  condition: >
    ka.verb = create and
    ka.target.resource = pods and
    ka.request.object.spec.containers[0].securityContext.privileged = true and
    ka.response.code = 201
  output: >
    Privileged pod created
    (user=%ka.user.name pod=%ka.target.name ns=%ka.target.namespace
    image=%ka.request.object.spec.containers[0].image)
  priority: CRITICAL
  tags: [k8s_audit, privilege_escalation]
  source: k8s_audit

- rule: K8s Interactive Terminal in Pod
  desc: >
    Detects exec sessions with a TTY — typically indicates interactive
    access to a container, which may indicate unauthorized investigation.
  condition: >
    ka.verb = create and
    ka.target.resource = "pods/exec" and
    ka.uri.param[command] contains "sh" or
    ka.uri.param[command] contains "bash" and
    ka.response.code = 101
  output: >
    Interactive shell exec in pod
    (user=%ka.user.name pod=%ka.target.name ns=%ka.target.namespace
    command=%ka.uri.param[command])
  priority: NOTICE
  tags: [k8s_audit, exec]
  source: k8s_audit

- rule: K8s Admission Controller Webhook Modified
  desc: >
    Changes to admission webhooks affect all resource validation.
    This is a high-privilege operation that can bypass security policies.
  condition: >
    ka.verb in (create, update, patch, delete) and
    ka.target.resource in (mutatingwebhookconfigurations, validatingwebhookconfigurations) and
    ka.response.code in (200, 201)
  output: >
    Admission webhook configuration changed
    (user=%ka.user.name verb=%ka.verb webhook=%ka.target.name)
  priority: HIGH
  tags: [k8s_audit, admission_webhook]
  source: k8s_audit

- rule: K8s Namespace Deletion
  desc: >
    Namespace deletion is irreversible and destroys all resources within.
    This event should always be alerted.
  condition: >
    ka.verb = delete and
    ka.target.resource = namespaces and
    ka.response.code = 200 and
    not ka.target.name startswith "ci-"  # Exclude ephemeral CI namespaces
  output: >
    Kubernetes namespace deleted
    (user=%ka.user.name namespace=%ka.target.name)
  priority: CRITICAL
  tags: [k8s_audit, namespace]
  source: k8s_audit

- rule: K8s API Server Reached from Unexpected Network
  desc: >
    API server access from IPs outside expected ranges may indicate
    unauthorized access or lateral movement.
  condition: >
    ka.source.ip != "" and
    not ka.source.ip startswith "10." and
    not ka.source.ip startswith "172.16." and
    not ka.source.ip startswith "192.168." and
    not ka.source.ip = "127.0.0.1" and
    ka.response.code = 200 and
    ka.verb not in (get, list, watch)
  output: >
    Kubernetes API write access from external IP
    (user=%ka.user.name verb=%ka.verb resource=%ka.target.resource
    src_ip=%ka.source.ip)
  priority: HIGH
  tags: [k8s_audit, external_access]
  source: k8s_audit
```

## Correlating Audit Events with Alerting

### Prometheus Metrics from Audit Logs

Audit events can be converted to Prometheus metrics for trend analysis and alerting:

```yaml
# audit-to-metrics deployment — exposes Prometheus metrics from audit stream

# PrometheusRule for audit event alerting
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kubernetes-audit-alerts
  namespace: monitoring
  labels:
    release: prometheus
spec:
  groups:
  - name: kubernetes.audit
    rules:
    # Alert on sustained secret access rate spike
    - alert: KubernetesSecretAccessRateHigh
      expr: |
        rate(kubernetes_audit_events_total{
          verb=~"get|list",
          resource="secrets",
          code="200"
        }[5m]) > 10
      for: 5m
      labels:
        severity: warning
        team: security
      annotations:
        summary: "High rate of Kubernetes secret access"
        description: "{{ $value | humanize }} secrets accessed per second in last 5m"

    # Alert on any RBAC modification
    - alert: KubernetesRBACModified
      expr: |
        increase(kubernetes_audit_events_total{
          verb=~"create|update|patch|delete",
          resource=~"clusterroles|clusterrolebindings|roles|rolebindings",
          code=~"2.."
        }[1m]) > 0
      labels:
        severity: warning
        team: security
      annotations:
        summary: "Kubernetes RBAC modification detected"
        description: "{{ $labels.verb }} on {{ $labels.resource }} by {{ $labels.user }}"

    # Alert on unauthorized API access (403 responses)
    - alert: KubernetesAPIForbiddenSpike
      expr: |
        rate(kubernetes_audit_events_total{code="403"}[5m]) > 5
      for: 3m
      labels:
        severity: warning
        team: security
      annotations:
        summary: "High rate of Kubernetes API forbidden responses"
        description: "{{ $value | humanize }} 403 responses per second — possible unauthorized access attempt"
```

### Elasticsearch/OpenSearch Pipeline for Audit Log Analysis

```yaml
# Fluent Bit configuration for audit log ingestion to OpenSearch
# /etc/fluent-bit/fluent-bit.conf

[SERVICE]
    Flush         5
    Log_Level     info
    Parsers_File  parsers.conf

[INPUT]
    Name          tail
    Path          /var/log/kubernetes/audit/audit.log
    Tag           k8s.audit
    Parser        json
    DB            /var/log/fluent-bit-k8s-audit.db
    Refresh_Interval 30
    Rotate_Wait   30

[FILTER]
    Name          record_modifier
    Match         k8s.audit
    Record        cluster production-cluster-01
    Record        environment production

[FILTER]
    Name          nest
    Match         k8s.audit
    Operation     lift
    Nested_under  objectRef
    Add_prefix    objectRef_

[FILTER]
    Name          nest
    Match         k8s.audit
    Operation     lift
    Nested_under  user
    Add_prefix    user_

[OUTPUT]
    Name          opensearch
    Match         k8s.audit
    Host          opensearch.internal.example.com
    Port          9200
    TLS           On
    TLS.Verify    On
    Index         k8s-audit
    Type          _doc
    Logstash_Format On
    Logstash_Prefix k8s-audit
    Logstash_DateFormat %Y.%m.%d
    Suppress_Type_Name On
    Retry_Limit   5
```

### Audit Log Query Examples

```bash
# Useful jq queries for audit log analysis

# Find all secret accesses in the last hour
cat /var/log/kubernetes/audit/audit.log | \
  jq -r 'select(.objectRef.resource == "secrets" and
                .verb == "get" and
                .responseStatus.code == 200) |
         "\(.stageTimestamp) \(.user.username) accessed secret \(.objectRef.name) in \(.objectRef.namespace)"'

# Identify users with the most API write operations
cat /var/log/kubernetes/audit/audit.log | \
  jq -r 'select(.verb | IN("create","update","patch","delete")) |
         .user.username' | \
  sort | uniq -c | sort -rn | head -20

# Find all exec sessions (interactive container access)
cat /var/log/kubernetes/audit/audit.log | \
  jq -r 'select(.objectRef.subresource == "exec" and
                .responseStatus.code == 101) |
         "\(.stageTimestamp) \(.user.username) exec in \(.objectRef.name)/\(.objectRef.namespace)"'

# Detect RBAC changes
cat /var/log/kubernetes/audit/audit.log | \
  jq -r 'select(.objectRef.apiGroup == "rbac.authorization.k8s.io" and
                (.verb | IN("create","update","patch","delete")) and
                (.responseStatus.code | IN(200, 201))) |
         "\(.stageTimestamp) \(.user.username) \(.verb) \(.objectRef.resource)/\(.objectRef.name)"'

# Count API access patterns by source IP (detect scanning)
cat /var/log/kubernetes/audit/audit.log | \
  jq -r '.sourceIPs[0]' | \
  sort | uniq -c | sort -rn | head -20

# Find failed authentication attempts
cat /var/log/kubernetes/audit/audit.log | \
  jq -r 'select(.responseStatus.code == 401) |
         "\(.stageTimestamp) FAILED_AUTH from \(.sourceIPs[0]) user_agent=\(.userAgent)"'

# Audit trail for a specific namespace
NAMESPACE="production"
cat /var/log/kubernetes/audit/audit.log | \
  jq --arg ns "${NAMESPACE}" \
     'select(.objectRef.namespace == $ns and
             .verb | IN("create","update","patch","delete")) |
      {time: .stageTimestamp, user: .user.username, verb: .verb,
       resource: .objectRef.resource, name: .objectRef.name,
       code: .responseStatus.code}'
```

## Log Retention and Archival

```yaml
# audit-log-rotation-cronjob.yaml
# Compress and archive old audit logs to S3 for long-term retention
apiVersion: batch/v1
kind: CronJob
metadata:
  name: audit-log-archiver
  namespace: kube-system
spec:
  schedule: "0 1 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          nodeSelector:
            node-role.kubernetes.io/control-plane: ""
          tolerations:
          - key: node-role.kubernetes.io/control-plane
            operator: Exists
            effect: NoSchedule
          restartPolicy: OnFailure
          hostPID: true
          containers:
          - name: archiver
            image: amazon/aws-cli:2.15
            command:
            - /bin/sh
            - -c
            - |
              # Archive logs older than 7 days
              AUDIT_DIR="/var/log/kubernetes/audit"
              ARCHIVE_DATE=$(date -d "7 days ago" +%Y-%m-%d)

              find "${AUDIT_DIR}" -name "audit-*.log" -mtime +7 | \
              while read logfile; do
                filename=$(basename "${logfile}")
                gzip -c "${logfile}" | \
                  aws s3 cp - \
                    "s3://company-audit-logs/kubernetes/$(date +%Y/%m/%d)/${filename}.gz" \
                    --sse aws:kms
                rm -f "${logfile}"
                echo "Archived: ${logfile}"
              done

              echo "Archival complete"
            env:
            - name: AWS_DEFAULT_REGION
              value: us-east-1
            volumeMounts:
            - name: audit-log
              mountPath: /var/log/kubernetes/audit
              readOnly: false
          volumes:
          - name: audit-log
            hostPath:
              path: /var/log/kubernetes/audit
```

## Summary

A production-grade Kubernetes audit logging system requires careful attention to every layer of the pipeline:

- **Policy design**: Begin with a noise-suppression baseline (kubelet, kube-proxy health checks), then escalate to `RequestResponse` for secrets, RBAC changes, and privileged access; use `Request` for workload modifications; default to `Metadata` for everything else
- **FedRAMP/DoD compliance**: Capture all authentication events, all RBAC modifications, and all exec/attach operations at `RequestResponse` level per NIST 800-53 AU controls
- **Sensitive data**: Restrict secrets READ events to `Metadata` level to prevent secret values appearing in audit logs, or implement server-side redaction in the webhook backend
- **Log backend**: File-based logging with rotation and compression for local retention; configure appropriate `maxage`, `maxbackup`, and `maxsize` to prevent disk exhaustion
- **Webhook backend**: Batch mode delivery to an external collector for real-time analysis, with appropriate buffer and throttle settings
- **Falco integration**: Rule-based detection of security events from the audit stream — privilege escalation, unauthorized secret access, RBAC modifications, and external API access
- **Prometheus alerting**: Convert audit event counts to metrics for trend-based alerting on access rate anomalies and RBAC changes
- **Long-term archival**: Daily archival of rotated audit logs to object storage with encryption for compliance retention requirements
