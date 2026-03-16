---
title: "Kubernetes Audit Logging: Compliance, Forensics, and Anomaly Detection"
date: 2027-04-14T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Audit Logging", "Compliance", "Security", "Forensics"]
categories: ["Kubernetes", "Security", "Compliance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Kubernetes audit logging for compliance and security, covering audit policy levels (None/Metadata/Request/RequestResponse), dynamic audit sinks, Falco integration for real-time anomaly detection, Elasticsearch storage for long-term retention, and SOC2/PCI-DSS compliance mapping."
more_link: "yes"
url: "/kubernetes-audit-logging-compliance-guide/"
---

The Kubernetes API server records every request made to the cluster in an audit log that captures who did what, when, and to which resource. This log is the authoritative forensic record for security investigations, the raw material for compliance controls, and the data source for anomaly detection systems. Despite its importance, audit logging is frequently misconfigured: too verbose (generating hundreds of gigabytes per day of low-value events) or too sparse (missing exactly the operations that compliance frameworks require). This guide covers audit policy design, log shipping infrastructure, Falco integration for real-time alerting, and specific control mappings for SOC2 Type 2 and PCI-DSS Requirement 10.

<!--more-->

## Audit Log Anatomy

### Understanding Audit Events

Every audit log entry is a JSON object conforming to the Kubernetes `audit.k8s.io/v1` schema. Understanding the fields is prerequisite to writing effective policies and queries.

```json
{
  "kind": "Event",
  "apiVersion": "audit.k8s.io/v1",
  "level": "RequestResponse",
  "auditID": "b3a2e847-f1c4-4d9e-8b72-3c5a9f012e87",
  "stage": "ResponseComplete",
  "requestURI": "/api/v1/namespaces/payments-api/secrets/db-credentials",
  "verb": "get",
  "user": {
    "username": "service-account-jenkins",
    "uid": "a4f3d2c1-b5e6-4a7b-8c9d-0e1f2a3b4c5d",
    "groups": ["system:serviceaccounts", "system:serviceaccounts:ci-cd", "system:authenticated"],
    "extra": {
      "authentication.kubernetes.io/pod-name": ["jenkins-worker-abc12"],
      "authentication.kubernetes.io/pod-uid": ["f8e7d6c5-b4a3-2190-8f7e-6d5c4b3a2910"]
    }
  },
  "impersonatedUser": null,
  "sourceIPs": ["10.244.5.23"],
  "userAgent": "kubectl/v1.28.3 (linux/amd64) kubernetes/8dc4c03",
  "objectRef": {
    "resource": "secrets",
    "namespace": "payments-api",
    "name": "db-credentials",
    "uid": "c1b2a3d4-e5f6-7890-abcd-ef1234567890",
    "apiVersion": "v1",
    "resourceVersion": "948271"
  },
  "responseStatus": {
    "metadata": {},
    "code": 200
  },
  "requestReceivedTimestamp": "2025-03-10T14:23:41.847Z",
  "stageTimestamp": "2025-03-10T14:23:41.851Z",
  "annotations": {
    "authorization.k8s.io/decision": "allow",
    "authorization.k8s.io/reason": "RBAC: allowed by ClusterRoleBinding jenkins-secrets-reader"
  }
}
```

### Key Fields

| Field | Description | Compliance use |
|---|---|---|
| `stage` | RequestReceived, ResponseStarted, ResponseComplete, Panic | Filter to ResponseComplete for complete events |
| `verb` | get, list, watch, create, update, patch, delete, deletecollection | Detect destructive operations |
| `user.username` | Authenticated principal | Who performed the action |
| `user.groups` | Group memberships | Role-based filtering |
| `sourceIPs` | Client IP addresses | Geo-anomaly detection |
| `objectRef.resource` | Kubernetes resource type | What was accessed |
| `objectRef.namespace` | Namespace scope | Scope filtering |
| `responseStatus.code` | HTTP response code | Detect denied requests (403) |
| `annotations` | Authorization decision, PSA violations, custom | Enrichment data |

## Audit Policy Levels

### Level Semantics

| Level | What is logged | Typical use |
|---|---|---|
| `None` | Nothing | Skip high-volume low-value operations (watch, get on status) |
| `Metadata` | Request metadata only (no body) | Default for most resources |
| `Request` | Metadata + request body | Sensitive create/update operations |
| `RequestResponse` | Metadata + request body + response body | Secrets access, cluster-admin operations |

The performance cost scales with level. `RequestResponse` on frequently-accessed resources (ConfigMaps, pods/status) can add significant CPU and storage overhead to the API server. The audit policy must be designed to balance completeness with performance.

## Production Audit Policy

### Policy Design Principles

1. Start with a catch-all at `Metadata` level.
2. Elevate sensitive operations (secrets, RBAC, policy resources) to `Request` or `RequestResponse`.
3. Drop high-volume low-value events with `None` to control log volume.
4. Always log `ResponseComplete` stage only (avoids duplicate entries for single requests).

```yaml
# audit-policy.yaml — Production-grade audit policy
# Place at /etc/kubernetes/audit-policy.yaml on control plane nodes
apiVersion: audit.k8s.io/v1
kind: Policy
# Log only ResponseComplete and Panic stages
# Omitting RequestReceived and ResponseStarted cuts log volume by ~60%
omitStages:
  - RequestReceived
  - ResponseStarted

rules:
  # ================================================================
  # LEVEL: None — Drop high-volume, low-value operations
  # ================================================================

  # Drop all watch operations — they are continuous and generate enormous volume
  - level: None
    verbs: ["watch"]

  # Drop read operations on non-sensitive resources from controllers
  - level: None
    users:
      - system:kube-controller-manager
      - system:kube-scheduler
      - system:node
    verbs: ["get", "list", "watch"]

  # Drop leaderelection operations (extremely high volume)
  - level: None
    resources:
      - group: coordination.k8s.io
        resources: ["leases"]

  # Drop endpoint slice reads (high-frequency, no security value)
  - level: None
    resources:
      - group: discovery.k8s.io
        resources: ["endpointslices"]
    verbs: ["get", "list"]

  # Drop pod status and node status updates from kubelet
  - level: None
    users: ["system:nodes"]
    verbs: ["update", "patch"]
    resources:
      - group: ""
        resources: ["nodes/status", "pods/status"]

  # Drop metric scrape operations from Prometheus (read-only, high volume)
  - level: None
    users:
      - system:serviceaccount:monitoring:prometheus
    verbs: ["get", "list"]
    resources:
      - group: ""
        resources: ["nodes", "pods", "services", "endpoints"]

  # ================================================================
  # LEVEL: RequestResponse — Full detail for high-sensitivity resources
  # ================================================================

  # Secrets access — log full request and response for forensics and compliance
  # This is the most critical rule for compliance frameworks
  - level: RequestResponse
    resources:
      - group: ""
        resources: ["secrets"]
    verbs: ["get", "list", "create", "update", "patch", "delete"]

  # Cluster-admin and RBAC mutations — who is granting permissions
  - level: RequestResponse
    resources:
      - group: rbac.authorization.k8s.io
        resources:
          - clusterroles
          - clusterrolebindings
          - roles
          - rolebindings
    verbs: ["create", "update", "patch", "delete"]

  # Pod Security Policy / PSA-related resources (if using Kyverno policies)
  - level: RequestResponse
    resources:
      - group: kyverno.io
        resources: ["clusterpolicies", "policies"]
    verbs: ["create", "update", "patch", "delete"]

  # Namespace create/delete — important for multi-tenant compliance
  - level: RequestResponse
    resources:
      - group: ""
        resources: ["namespaces"]
    verbs: ["create", "delete"]

  # Certificate signing requests — PKI audit trail
  - level: RequestResponse
    resources:
      - group: certificates.k8s.io
        resources: ["certificatesigningrequests"]

  # ValidatingWebhookConfiguration and MutatingWebhookConfiguration changes
  # Attackers may modify these to intercept traffic
  - level: RequestResponse
    resources:
      - group: admissionregistration.k8s.io
        resources:
          - validatingwebhookconfigurations
          - mutatingwebhookconfigurations

  # ================================================================
  # LEVEL: Request — Request body without response for common mutations
  # ================================================================

  # Pod creation — capture spec for workload compliance review
  - level: Request
    resources:
      - group: ""
        resources: ["pods"]
    verbs: ["create", "update", "patch", "delete"]

  # Deployment, StatefulSet, DaemonSet mutations
  - level: Request
    resources:
      - group: apps
        resources:
          - deployments
          - statefulsets
          - daemonsets
          - replicasets
    verbs: ["create", "update", "patch", "delete"]

  # ConfigMap mutations (often contain sensitive configuration)
  - level: Request
    resources:
      - group: ""
        resources: ["configmaps"]
    verbs: ["create", "update", "patch", "delete"]

  # ServiceAccount mutations — used for identity and workload identity
  - level: Request
    resources:
      - group: ""
        resources: ["serviceaccounts"]
    verbs: ["create", "update", "patch", "delete"]

  # TokenRequest — service account token generation
  - level: Request
    resources:
      - group: ""
        resources: ["serviceaccounts/token"]

  # exec and attach into running containers — critical forensic event
  - level: RequestResponse
    resources:
      - group: ""
        resources: ["pods/exec", "pods/attach", "pods/portforward"]

  # ================================================================
  # LEVEL: Metadata — Default for everything else
  # ================================================================

  # Catch-all: log metadata for all remaining operations
  - level: Metadata
```

## Configuring the kube-apiserver

### Static Pod Flags

```yaml
# /etc/kubernetes/manifests/kube-apiserver.yaml (relevant snippet)
# Add these flags to the kube-apiserver command array
spec:
  containers:
  - name: kube-apiserver
    command:
    - kube-apiserver
    # Audit log backend — writes to a log file on the control plane node
    - --audit-log-path=/var/log/kubernetes/audit/audit.log
    - --audit-policy-file=/etc/kubernetes/audit-policy.yaml
    # Log rotation settings
    - --audit-log-maxage=30          # Retain for 30 days
    - --audit-log-maxbackup=10       # Keep 10 rotated files
    - --audit-log-maxsize=100        # Rotate at 100MB
    - --audit-log-compress=true      # Compress rotated files with gzip
    # Webhook backend for real-time streaming (optional, see below)
    # - --audit-webhook-config-file=/etc/kubernetes/audit-webhook.yaml
    # - --audit-webhook-batch-max-size=400
    # - --audit-webhook-batch-throttle-qps=10
    volumeMounts:
    - mountPath: /etc/kubernetes/audit-policy.yaml
      name: audit-policy
      readOnly: true
    - mountPath: /var/log/kubernetes/audit
      name: audit-logs
  volumes:
  - hostPath:
      path: /etc/kubernetes/audit-policy.yaml
      type: File
    name: audit-policy
  - hostPath:
      path: /var/log/kubernetes/audit
      type: DirectoryOrCreate
    name: audit-logs
```

### Dynamic Audit Webhook

The webhook backend streams audit events directly to an HTTP endpoint in near-real-time, enabling integration with SIEM systems and alerting pipelines without waiting for log file rotation:

```yaml
# audit-webhook-config.yaml — Streams audit events to a log aggregation service
apiVersion: v1
kind: Config
clusters:
  - name: audit-sink
    cluster:
      server: https://log-aggregator.internal.support.tools:9443/audit
      # TLS certificate for the log aggregation endpoint
      certificate-authority: /etc/kubernetes/pki/audit-ca.crt
users:
  - name: audit-sender
    user:
      client-certificate: /etc/kubernetes/pki/audit-client.crt
      client-key: /etc/kubernetes/pki/audit-client.key
contexts:
  - context:
      cluster: audit-sink
      user: audit-sender
    name: default
current-context: default
```

## Shipping Audit Logs to Elasticsearch

### Filebeat Configuration

```yaml
# filebeat-kubernetes-audit.yaml — DaemonSet or sidecar Filebeat config
# Reads audit logs from the control plane node hostPath and ships to Elasticsearch

apiVersion: v1
kind: ConfigMap
metadata:
  name: filebeat-audit-config
  namespace: logging
data:
  filebeat.yml: |
    filebeat.inputs:
      - type: log
        enabled: true
        paths:
          - /var/log/kubernetes/audit/audit.log
        # JSON parsing for Kubernetes audit events
        json.keys_under_root: true
        json.overwrite_keys: true
        json.add_error_key: true
        # Add node identification
        fields:
          log_type: kubernetes-audit
          cluster: prod-us-east-1
          environment: production
        fields_under_root: true
        # Handle multi-line JSON (single events per line in default format)
        multiline.type: pattern
        multiline.pattern: '^{'
        multiline.negate: true
        multiline.match: after

    processors:
      # Drop None-level events that may have slipped through
      - drop_event:
          when:
            equals:
              level: None
      # Add ingest timestamp
      - add_fields:
          target: ""
          fields:
            ingest_timestamp: '${TIMESTAMP}'

    output.elasticsearch:
      hosts: ["elasticsearch-master.logging.svc.cluster.local:9200"]
      index: "kubernetes-audit-%{+yyyy.MM.dd}"
      # Use ILM for automatic index lifecycle management
      ilm.enabled: true
      ilm.rollover_alias: "kubernetes-audit"
      ilm.policy: "kubernetes-audit-policy"
      # Authentication via Kubernetes service account + Elasticsearch API key
      api_key: "EXAMPLE_TOKEN_REPLACE_ME"
      ssl.certificate_authorities: ["/etc/ssl/certs/elasticsearch-ca.crt"]

    logging.level: info
    logging.to_files: true
    logging.files:
      path: /var/log/filebeat
      name: filebeat
      keepfiles: 7
```

### Elasticsearch Index Template

```json
{
  "index_patterns": ["kubernetes-audit-*"],
  "template": {
    "settings": {
      "number_of_shards": 3,
      "number_of_replicas": 1,
      "index.lifecycle.name": "kubernetes-audit-policy",
      "index.lifecycle.rollover_alias": "kubernetes-audit"
    },
    "mappings": {
      "dynamic": "true",
      "properties": {
        "@timestamp": { "type": "date" },
        "requestReceivedTimestamp": { "type": "date" },
        "stageTimestamp": { "type": "date" },
        "verb": { "type": "keyword" },
        "stage": { "type": "keyword" },
        "level": { "type": "keyword" },
        "auditID": { "type": "keyword" },
        "requestURI": { "type": "keyword" },
        "user": {
          "properties": {
            "username": { "type": "keyword" },
            "groups": { "type": "keyword" }
          }
        },
        "objectRef": {
          "properties": {
            "resource": { "type": "keyword" },
            "namespace": { "type": "keyword" },
            "name": { "type": "keyword" },
            "apiVersion": { "type": "keyword" }
          }
        },
        "sourceIPs": { "type": "ip" },
        "responseStatus": {
          "properties": {
            "code": { "type": "integer" }
          }
        }
      }
    }
  }
}
```

### Index Lifecycle Management Policy

```json
{
  "policy": {
    "phases": {
      "hot": {
        "min_age": "0ms",
        "actions": {
          "rollover": {
            "max_age": "1d",
            "max_size": "50gb"
          },
          "set_priority": { "priority": 100 }
        }
      },
      "warm": {
        "min_age": "7d",
        "actions": {
          "shrink": { "number_of_shards": 1 },
          "forcemerge": { "max_num_segments": 1 },
          "set_priority": { "priority": 50 }
        }
      },
      "cold": {
        "min_age": "30d",
        "actions": {
          "freeze": {},
          "set_priority": { "priority": 0 }
        }
      },
      "delete": {
        "min_age": "365d",
        "actions": {
          "delete": {}
        }
      }
    }
  }
}
```

## Falco Integration for Real-Time Anomaly Detection

### Falco Architecture with Kubernetes Audit

Falco can consume the Kubernetes audit log via its webhook plugin, allowing rule-based alerting on audit events in near-real-time. This is separate from Falco's syscall-based rules.

```bash
# Install Falco with audit log support
helm repo add falcosecurity https://falcosecurity.github.io/charts
helm repo update

helm install falco falcosecurity/falco \
  --namespace falco \
  --create-namespace \
  --version 4.2.1 \
  --set falco.grpc.enabled=true \
  --set falco.grpcOutput.enabled=true \
  --set falcosidekick.enabled=true \
  --set falcosidekick.config.slack.webhookurl="https://hooks.slack.com/services/EXAMPLE_TOKEN_REPLACE_ME" \
  --set auditLog.enabled=true
```

### Falco Audit Rules

```yaml
# falco-audit-rules.yaml — Custom rules for Kubernetes audit log anomaly detection
# Deploy as a ConfigMap and mount into the Falco pod

- rule: Kubernetes Secrets Accessed Outside Normal Hours
  desc: >
    A secret was accessed outside of business hours (weekdays 06:00-22:00 UTC).
    This may indicate automated theft or an attacker using stolen credentials.
  condition: >
    ka.verb in (get, list) and
    ka.target.resource = secrets and
    not ka.user.name in (known-secret-readers) and
    not (ka.user.groups contains "system:nodes") and
    not ka.user.name startswith "system:" and
    (jevt.time.hour < 6 or jevt.time.hour > 22)
  output: >
    Secrets accessed outside normal hours
    (user=%ka.user.name secret=%ka.target.name
     namespace=%ka.target.namespace hour=%jevt.time.hour
     sourceIP=%ka.source.ip)
  priority: WARNING
  source: k8s_audit
  tags: [secrets, compliance, anomaly]

- rule: Privilege Escalation via ClusterRoleBinding
  desc: >
    A ClusterRoleBinding was created or modified. This could be an attacker
    attempting to escalate privileges by granting cluster-admin to a compromised
    service account.
  condition: >
    ka.verb in (create, update, patch) and
    ka.target.resource = clusterrolebindings and
    not ka.user.groups contains "system:masters"
  output: >
    ClusterRoleBinding modified
    (user=%ka.user.name verb=%ka.verb
     binding=%ka.target.name sourceIP=%ka.source.ip
     groups=%ka.user.groups)
  priority: CRITICAL
  source: k8s_audit
  tags: [rbac, privilege-escalation, critical]

- rule: Container Exec into Pod
  desc: >
    An exec or attach command was run against a running pod. This is a
    high-value forensic event and may indicate an attacker exploring a
    compromised pod or attempting lateral movement.
  condition: >
    ka.verb in (create) and
    ka.target.subresource in (exec, attach) and
    not ka.user.groups contains "system:masters" and
    not ka.user.name startswith "system:serviceaccount:monitoring:"
  output: >
    Exec into pod
    (user=%ka.user.name pod=%ka.target.name
     namespace=%ka.target.namespace container=%ka.req.pod.containers.name
     command=%ka.req.pod.containers.args sourceIP=%ka.source.ip)
  priority: WARNING
  source: k8s_audit
  tags: [runtime, forensics, lateral-movement]

- rule: Secret Enumeration via List
  desc: >
    A user or service account listed all secrets in a namespace. Legitimate
    applications rarely list secrets; this pattern is characteristic of
    credential harvesting tools.
  condition: >
    ka.verb = list and
    ka.target.resource = secrets and
    not ka.user.name in (known-secret-listers) and
    not ka.user.name startswith "system:serviceaccount:kube-system:" and
    not ka.user.name startswith "system:serviceaccount:cert-manager:"
  output: >
    Secret list operation (potential enumeration)
    (user=%ka.user.name namespace=%ka.target.namespace
     sourceIP=%ka.source.ip groups=%ka.user.groups)
  priority: HIGH
  source: k8s_audit
  tags: [secrets, enumeration, credential-theft]

- rule: Unauthorized API Server Access (HTTP 403)
  desc: >
    An API request was denied with HTTP 403. Repeated 403s from the same
    source may indicate probing or a misconfigured service account.
  condition: >
    ka.response.code = 403 and
    not ka.user.name startswith "system:" and
    not ka.user.groups contains "system:unauthenticated"
  output: >
    Unauthorized API request denied
    (user=%ka.user.name verb=%ka.verb
     resource=%ka.target.resource namespace=%ka.target.namespace
     sourceIP=%ka.source.ip)
  priority: NOTICE
  source: k8s_audit
  tags: [access-control, authorization]

- rule: Admission Webhook Configuration Modified
  desc: >
    A ValidatingWebhookConfiguration or MutatingWebhookConfiguration was
    modified. Attackers sometimes disable admission webhooks to bypass
    security controls like OPA Gatekeeper or Kyverno.
  condition: >
    ka.verb in (create, update, patch, delete) and
    ka.target.resource in (validatingwebhookconfigurations, mutatingwebhookconfigurations)
  output: >
    Admission webhook configuration modified
    (user=%ka.user.name verb=%ka.verb
     webhook=%ka.target.name sourceIP=%ka.source.ip)
  priority: CRITICAL
  source: k8s_audit
  tags: [admission, security-controls, critical]
```

## Useful Audit Log Queries

### jq One-Liners for Common Investigations

```bash
# Find all secret access events in the last 10,000 lines
tail -10000 /var/log/kubernetes/audit/audit.log | \
  jq -r 'select(.objectRef.resource == "secrets") |
    [.requestReceivedTimestamp, .user.username, .verb,
     .objectRef.namespace, .objectRef.name, .responseStatus.code] |
    @tsv'

# Find all exec-into-pod events
tail -10000 /var/log/kubernetes/audit/audit.log | \
  jq -r 'select(.objectRef.subresource == "exec") |
    [.requestReceivedTimestamp, .user.username,
     .objectRef.namespace, .objectRef.name,
     (.requestObject.command // ["no-command"] | join(" "))] |
    @tsv'

# Find all ClusterRoleBinding creations
tail -10000 /var/log/kubernetes/audit/audit.log | \
  jq -r 'select(.objectRef.resource == "clusterrolebindings" and .verb == "create") |
    [.requestReceivedTimestamp, .user.username,
     .objectRef.name, .sourceIPs[0]] |
    @tsv'

# Find all 403 responses, grouped by user
tail -50000 /var/log/kubernetes/audit/audit.log | \
  jq -r 'select(.responseStatus.code == 403) | .user.username' | \
  sort | uniq -c | sort -rn | head -20

# Find namespace deletions
grep '"verb":"delete"' /var/log/kubernetes/audit/audit.log | \
  jq -r 'select(.objectRef.resource == "namespaces") |
    [.requestReceivedTimestamp, .user.username, .objectRef.name] | @tsv'

# Find all operations by a specific user in the last hour
tail -100000 /var/log/kubernetes/audit/audit.log | \
  jq -r --arg USER "service-account-jenkins" \
    'select(.user.username == $USER) |
     [.requestReceivedTimestamp, .verb,
      .objectRef.resource, .objectRef.namespace, .objectRef.name] |
     @tsv'
```

## SOC2 Type 2 Control Mapping

### Applicable Common Criteria

| SOC2 CC | Control Description | Kubernetes Audit Implementation |
|---|---|---|
| CC6.1 | Logical access security over protected information | Audit all `get`/`list` on Secrets, ConfigMaps at `RequestResponse` level |
| CC6.2 | Authentication and access control | Audit all authentication events; capture `user.username` and `sourceIPs` |
| CC6.3 | Authorization — role-based access control | Log all RBAC resource mutations (`roles`, `rolebindings`, `clusterroles`, `clusterrolebindings`) at `RequestResponse` |
| CC6.6 | Protection against logical access from outside | Audit `sourceIPs` for external IP detection; integrate with Falco for geo-anomaly alerting |
| CC6.8 | Malware prevention | Audit `pods/exec` and `pods/attach` (lateral movement indicator); image pull events |
| CC7.2 | Monitoring for anomalous activity | Falco rules consuming audit log for privilege escalation, secret enumeration, webhook modification |
| CC7.3 | Evaluation of security events | Elasticsearch queries for 403 patterns, off-hours access, unusual exec events |
| CC7.4 | Incident response procedures | Audit log retention ensures forensic data available within RTO (90-day online window) |

### Evidence Collection Script for SOC2 Audits

```bash
#!/bin/bash
# collect-soc2-evidence.sh — Generate audit evidence for SOC2 review period
# Usage: ./collect-soc2-evidence.sh 2025-01-01 2025-03-31
set -euo pipefail

START_DATE="${1:?Start date required (YYYY-MM-DD)}"
END_DATE="${2:?End date required (YYYY-MM-DD)}"
AUDIT_LOG="/var/log/kubernetes/audit/audit.log"
OUTPUT_DIR="soc2-evidence-${START_DATE}-${END_DATE}"

mkdir -p "${OUTPUT_DIR}"

echo "Collecting SOC2 evidence for period ${START_DATE} to ${END_DATE}"

# CC6.1 — Secret access log
echo "Generating secret access report..."
grep '"resource":"secrets"' "${AUDIT_LOG}" | \
  jq -r 'select(.requestReceivedTimestamp >= "'"${START_DATE}"'" and
               .requestReceivedTimestamp <= "'"${END_DATE}"'T23:59:59Z") |
    [.requestReceivedTimestamp, .user.username, .verb,
     .objectRef.namespace, .objectRef.name, .sourceIPs[0]] | @csv' \
  > "${OUTPUT_DIR}/cc6.1-secret-access.csv"

# CC6.3 — RBAC changes
echo "Generating RBAC mutation report..."
grep -E '"resource":"(roles|rolebindings|clusterroles|clusterrolebindings)"' "${AUDIT_LOG}" | \
  jq -r 'select(.verb != "get" and .verb != "list" and .verb != "watch") |
    select(.requestReceivedTimestamp >= "'"${START_DATE}"'") |
    [.requestReceivedTimestamp, .user.username, .verb,
     .objectRef.resource, .objectRef.name] | @csv' \
  > "${OUTPUT_DIR}/cc6.3-rbac-mutations.csv"

# CC7.2 — Exec events
echo "Generating exec-into-pod report..."
grep '"subresource":"exec"' "${AUDIT_LOG}" | \
  jq -r '[.requestReceivedTimestamp, .user.username,
           .objectRef.namespace, .objectRef.name, .sourceIPs[0]] | @csv' \
  > "${OUTPUT_DIR}/cc7.2-exec-events.csv"

echo "Evidence collected in ${OUTPUT_DIR}/"
ls -lh "${OUTPUT_DIR}/"
```

## PCI-DSS Requirement 10 Mapping

### Requirement 10.2 — Audit Trail for Specified Events

PCI-DSS Requirement 10.2 specifies that audit trails must be implemented for the following events. Each maps directly to Kubernetes audit log content:

| PCI Req | Required Event | Audit Policy Rule | Log Level |
|---|---|---|---|
| 10.2.1 | All individual user access to cardholder data | Secrets access in PCI namespaces | RequestResponse |
| 10.2.2 | All actions by root/administrator | cluster-admin role activity | RequestResponse |
| 10.2.3 | Access to all audit trails | audit log file access (OS level) | OS audit (auditd) |
| 10.2.4 | Invalid logical access attempts | HTTP 403 responses | Metadata |
| 10.2.5 | Use of identification/authentication mechanisms | ServiceAccount token creation | Request |
| 10.2.6 | Initialization/stopping of audit logs | kube-apiserver start/stop events | System logs |
| 10.2.7 | Creation/deletion of system-level objects | Namespace/Pod create/delete | Request |

### PCI Namespace Labeling

```bash
# Label namespaces containing cardholder data for targeted audit policies
kubectl label namespace payments-processing \
  pci-scope=cardholder-data-environment \
  pci-level=cde

# Verify the label
kubectl get namespace payments-processing \
  -o jsonpath='{.metadata.labels.pci-scope}'
```

### PCI Evidence Retention Configuration

```yaml
# elasticsearch-pci-ilm.yaml — ILM policy for PCI-DSS 10.7 (one-year retention)
# PCI-DSS 10.7 requires audit log history for at least one year,
# with the most recent three months immediately available for analysis.
{
  "policy": {
    "phases": {
      "hot": {
        "min_age": "0ms",
        "actions": {
          "rollover": { "max_age": "1d", "max_size": "50gb" },
          "set_priority": { "priority": 100 }
        }
      },
      "warm": {
        "min_age": "90d",
        "actions": {
          "shrink": { "number_of_shards": 1 },
          "forcemerge": { "max_num_segments": 1 },
          "set_priority": { "priority": 50 }
        }
      },
      "cold": {
        "min_age": "90d",
        "actions": {
          "freeze": {},
          "set_priority": { "priority": 0 },
          "searchable_snapshot": {
            "snapshot_repository": "s3-audit-archive"
          }
        }
      },
      "delete": {
        "min_age": "400d",
        "actions": { "delete": {} }
      }
    }
  }
}
```

## Audit Log Rotation and Storage Sizing

### Storage Estimation

```bash
# Estimate audit log volume for capacity planning
# Sample 1 hour of audit logs and extrapolate

SAMPLE_START=$(date -u --date="1 hour ago" +"%Y-%m-%dT%H:%M:%SZ")
SAMPLE_END=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Count events in the last hour
HOURLY_EVENTS=$(grep "\"stage\":\"ResponseComplete\"" /var/log/kubernetes/audit/audit.log | \
  awk -v start="${SAMPLE_START}" -v end="${SAMPLE_END}" \
  '$0 ~ start, $0 ~ end' | wc -l)

# Average event size in bytes
AVG_SIZE=$(grep "\"stage\":\"ResponseComplete\"" /var/log/kubernetes/audit/audit.log | \
  tail -1000 | awk '{ total += length($0) } END { print total/NR }')

echo "Hourly events: ${HOURLY_EVENTS}"
echo "Average event size: ${AVG_SIZE} bytes"
echo "Daily volume estimate: $(echo "${HOURLY_EVENTS} * 24 * ${AVG_SIZE} / 1024 / 1024" | bc) MB"
echo "Monthly volume estimate: $(echo "${HOURLY_EVENTS} * 24 * 30 * ${AVG_SIZE} / 1024 / 1024 / 1024" | bc) GB"
```

### Log Rotation Validation

```bash
# Verify audit log rotation is functioning
ls -lh /var/log/kubernetes/audit/
# Expected: current audit.log plus numbered rotations (audit.log.1, audit.log.2.gz, etc.)

# Check current log file size (should not exceed --audit-log-maxsize)
du -sh /var/log/kubernetes/audit/audit.log

# Check total audit log directory size
du -sh /var/log/kubernetes/audit/

# Verify compressed rotations are readable
zcat /var/log/kubernetes/audit/audit.log.1.gz | tail -1 | jq .
```

## Summary

A production-grade Kubernetes audit logging implementation requires careful design across several layers:

1. Write a tiered audit policy that uses `None` to drop high-volume low-value events, `Metadata` as a baseline, and `RequestResponse` only for secrets, RBAC mutations, exec events, and admission webhook changes.
2. Configure log rotation on the API server to prevent disk exhaustion on control plane nodes.
3. Ship logs to Elasticsearch via Filebeat with ILM policies that retain hot data for 90 days and archive to cold/frozen tier through one year (PCI-DSS Requirement 10.7 compliance).
4. Deploy Falco with audit webhook integration and rules covering the highest-priority anomaly patterns: secret enumeration, exec into pods, privilege escalation via ClusterRoleBinding, and admission webhook modification.
5. Map audit controls explicitly to SOC2 CC6/CC7 and PCI-DSS Requirement 10 evidence requirements, and automate evidence collection scripts to reduce audit preparation time.
6. Monitor audit log volume and storage capacity proactively — an audit logging failure during an incident or audit review period creates both a security gap and a compliance finding.
