---
title: "Kubernetes Audit Logging: Policy Configuration and Security Event Analysis"
date: 2028-02-23T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Security", "Audit Logging", "Falco", "Loki", "Compliance", "PCI-DSS", "SOC2"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Kubernetes audit logging: configuring policy levels and stage filtering, deploying webhook audit backends, writing Falco rules for audit events, analyzing logs with Loki, detecting privilege escalation, and meeting PCI-DSS and SOC2 retention requirements."
more_link: "yes"
url: "/kubernetes-security-audit-logging-guide/"
---

Every API server request that modifies cluster state—creating pods, binding cluster roles, updating secrets—produces an audit event. Without audit logging, a security incident in a Kubernetes cluster is nearly impossible to reconstruct: the control plane ephemeral logs do not provide "who did what to which resource at what time" attribution. With a well-configured audit policy and a durable log pipeline, an operator can answer those questions within minutes of an alert.

This guide covers the full audit logging stack: `kube-apiserver` policy configuration, webhook backend routing to Loki, Falco rule integration for real-time detection, privilege escalation pattern analysis, and the specific log retention and tamper-evidence controls required by PCI-DSS 4.0 and SOC 2 Type II.

<!--more-->

# Kubernetes Audit Logging: Policy Configuration and Security Event Analysis

## Understanding Audit Log Levels and Stages

The audit system intercepts every API request and emits events at configurable verbosity levels. Choosing the right level per resource is critical: `RequestResponse` on all resources generates gigabytes per hour and buries signal in noise; `None` on sensitive resources creates blind spots for compliance.

### Levels

| Level | What is recorded |
|---|---|
| `None` | Nothing; the request is silent |
| `Metadata` | HTTP method, URL, user, source IP, response code, timestamps |
| `Request` | Metadata + full request body |
| `RequestResponse` | Request + full response body (highest cost, highest fidelity) |

### Stages

| Stage | When it fires |
|---|---|
| `RequestReceived` | Immediately when the API server receives the request (before authentication) |
| `ResponseStarted` | After the response headers are sent (streaming responses, watches) |
| `ResponseComplete` | After the full response body is sent |
| `Panic` | If the API server panics handling the request |

## Audit Policy Configuration

The policy file is evaluated top-to-bottom; the first matching rule wins. Structure policies from most-specific (high-value targets) to least-specific (catch-all defaults).

```yaml
# /etc/kubernetes/audit-policy.yaml
# Applied via kube-apiserver flag: --audit-policy-file=/etc/kubernetes/audit-policy.yaml
apiVersion: audit.k8s.io/v1
kind: Policy

# omitStages: never record events at these stages globally.
# RequestReceived is very high-volume; only include it for specific rules below.
omitStages:
  - RequestReceived

rules:
  # Rule 1: Silence read-only requests on low-sensitivity resources.
  # Listing pods and nodes thousands of times per minute from controllers
  # adds no security value.
  - level: None
    users: ["system:kube-controller-manager", "system:kube-scheduler"]
    verbs: ["get", "list", "watch"]
    resources:
      - group: ""
        resources: ["pods", "nodes", "endpoints", "configmaps", "replicationcontrollers"]
      - group: "apps"
        resources: ["replicasets", "deployments", "statefulsets", "daemonsets"]

  # Rule 2: Silence health probes and metrics scrapes (extremely high volume).
  - level: None
    nonResourceURLs:
      - /healthz
      - /healthz/*
      - /livez
      - /livez/*
      - /readyz
      - /readyz/*
      - /metrics
      - /metrics/*
      - /version
      - /swagger*

  # Rule 3: Full RequestResponse for Secrets, ConfigMaps, and TokenRequests.
  # These resources carry credentials; every create/update/delete must be
  # recorded with full body for forensic and compliance purposes.
  - level: RequestResponse
    omitStages: []   # Override: also record RequestReceived for these.
    resources:
      - group: ""
        resources: ["secrets", "configmaps"]
        verbs: ["create", "update", "patch", "delete", "deletecollection"]
      - group: ""
        resources: ["serviceaccounts/token"]
        verbs: ["create"]

  # Rule 4: Record RBAC changes at RequestResponse.
  # Every role binding and cluster role binding change is a potential
  # privilege escalation.
  - level: RequestResponse
    resources:
      - group: "rbac.authorization.k8s.io"
        resources:
          - roles
          - clusterroles
          - rolebindings
          - clusterrolebindings
    verbs: ["create", "update", "patch", "delete", "deletecollection"]

  # Rule 5: Record all pod exec, port-forward, and attach operations.
  # These are interactive access events and are always high-risk.
  - level: RequestResponse
    resources:
      - group: ""
        resources:
          - pods/exec
          - pods/portforward
          - pods/attach
    verbs: ["create"]

  # Rule 6: Record pod-level mutations at RequestResponse.
  # Pod creation is the primary workload execution vector.
  - level: RequestResponse
    resources:
      - group: ""
        resources: ["pods"]
        verbs: ["create", "update", "patch", "delete", "deletecollection"]
      - group: "apps"
        resources: ["deployments", "replicasets", "statefulsets", "daemonsets"]
        verbs: ["create", "update", "patch", "delete"]

  # Rule 7: PersistentVolume and StorageClass mutations.
  # Attackers who gain control of PV claims can exfiltrate data by
  # mounting volumes containing sensitive data.
  - level: RequestResponse
    resources:
      - group: ""
        resources: ["persistentvolumes", "persistentvolumeclaims"]
        verbs: ["create", "update", "patch", "delete"]
      - group: "storage.k8s.io"
        resources: ["storageclasses", "volumeattachments"]
        verbs: ["create", "update", "patch", "delete"]

  # Rule 8: Network policy and service mutations.
  - level: RequestResponse
    resources:
      - group: "networking.k8s.io"
        resources: ["networkpolicies", "ingresses"]
        verbs: ["create", "update", "patch", "delete"]
      - group: ""
        resources: ["services"]
        verbs: ["create", "update", "patch", "delete"]

  # Rule 9: Namespace lifecycle events.
  - level: RequestResponse
    resources:
      - group: ""
        resources: ["namespaces"]
    verbs: ["create", "update", "patch", "delete"]

  # Rule 10: Record node admission and kubelet operations at Metadata.
  # High-volume but important for node-level incident investigations.
  - level: Metadata
    users: ["system:node:*", "system:nodes"]
    verbs: ["create", "update", "patch"]

  # Rule 11: Record all other mutations at Request level.
  # Everything not matched above and not a read-only operation.
  - level: Request
    verbs: ["create", "update", "patch", "delete", "deletecollection"]

  # Rule 12: Catch-all: Metadata for all remaining requests.
  # This captures read operations on resources not silenced above,
  # providing a breadcrumb trail without full body content.
  - level: Metadata
```

## kube-apiserver Flags for Audit

```bash
# /etc/kubernetes/manifests/kube-apiserver.yaml (static pod)
# Add these to the command array:

- --audit-policy-file=/etc/kubernetes/audit-policy.yaml

# --- File backend (local fallback) ---
# Use as a secondary backend; the webhook backend is the primary.
- --audit-log-path=/var/log/kubernetes/audit/audit.log
- --audit-log-maxage=7          # Keep local files for 7 days
- --audit-log-maxbackup=10      # Keep up to 10 rotated files
- --audit-log-maxsize=200       # Rotate at 200 MB
- --audit-log-format=json       # JSON is required for log parsing pipelines

# --- Webhook backend (primary, async) ---
# The webhook backend sends events to the audit sink in batches.
- --audit-webhook-config-file=/etc/kubernetes/audit-webhook.yaml
- --audit-webhook-mode=batch    # async; 'blocking' is only for debugging
- --audit-webhook-batch-max-size=400
- --audit-webhook-batch-max-wait=5s
- --audit-webhook-initial-backoff=10ms
- --audit-webhook-version=audit.k8s.io/v1
```

### Webhook Configuration

```yaml
# /etc/kubernetes/audit-webhook.yaml
# kubeconfig-style file pointing to the audit receiver (Fluent Bit or custom handler)
apiVersion: v1
kind: Config
clusters:
  - name: audit-receiver
    cluster:
      # The audit receiver accepts the raw audit event JSON array at /audit
      server: https://fluent-bit.logging.svc.cluster.local:9880/audit
      # CA cert for TLS verification of the receiver
      certificate-authority: /etc/kubernetes/pki/audit-receiver-ca.crt
users:
  - name: audit-sender
    user:
      # Mutual TLS: the API server authenticates to the receiver
      client-certificate: /etc/kubernetes/pki/audit-sender.crt
      client-key: /etc/kubernetes/pki/audit-sender.key
contexts:
  - name: audit-context
    context:
      cluster: audit-receiver
      user: audit-sender
current-context: audit-context
```

## Fluent Bit Audit Log Pipeline to Loki

```yaml
# fluent-bit-audit-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluent-bit-audit
  namespace: logging
data:
  fluent-bit.conf: |
    [SERVICE]
        Flush        5
        Daemon       Off
        Log_Level    info
        Parsers_File parsers.conf
        HTTP_Server  On
        HTTP_Listen  0.0.0.0
        HTTP_Port    2020
        # Buffer to disk if Loki is unavailable
        storage.type filesystem
        storage.path /var/log/fluentbit-buffer/

    # INPUT: Receive audit events from the API server webhook
    [INPUT]
        Name         http
        Listen       0.0.0.0
        Port         9880
        tls          on
        tls.verify   on
        tls.ca_file  /fluent-bit/tls/ca.crt
        tls.crt_file /fluent-bit/tls/server.crt
        tls.key_file /fluent-bit/tls/server.key
        tag          k8s.audit
        # The API server sends a JSON array of AuditEvent objects.
        # The http input wraps it; we need to unpack the array.

    # FILTER: Parse the nested AuditEvent JSON and flatten key fields
    [FILTER]
        Name   record_modifier
        Match  k8s.audit
        # Add cluster identifier to every audit record
        Record cluster_name production-us-east-1

    [FILTER]
        Name   lua
        Match  k8s.audit
        script /fluent-bit/scripts/extract-audit-fields.lua
        call   extract_fields

    # FILTER: Add Loki labels to high-risk events for fast querying
    [FILTER]
        Name  grep
        Match k8s.audit
        # Drop None-level events that slipped through (belt-and-suspenders)
        Exclude level None

    # OUTPUT: Ship to Loki with structured metadata as labels
    [OUTPUT]
        Name                 loki
        Match                k8s.audit
        Host                 loki.logging.svc.cluster.local
        Port                 3100
        Labels               job=k8s-audit,cluster=production-us-east-1
        # Dynamic labels extracted by the Lua filter
        Label_Keys           $level,$verb,$resource,$namespace
        # Auto-add timestamp from the audit event's requestReceivedTimestamp
        Auto_kubernetes_labels off
        Line_Format          json
        # Write-ahead log to avoid losing events on crash
        workers              2
        # Compress batches before sending
        compress             gzip
        # Retry on transient Loki errors
        retry_limit          5

  parsers.conf: |
    [PARSER]
        Name        audit-json
        Format      json
        Time_Key    requestReceivedTimestamp
        Time_Format %Y-%m-%dT%H:%M:%S.%LZ

  extract-audit-fields.lua: |
    -- Lua filter: flatten nested audit event fields into top-level keys
    -- for use as Loki labels.  Labels must be low-cardinality strings.
    function extract_fields(tag, timestamp, record)
        local new_record = record

        -- Extract user info
        if record["user"] then
            new_record["username"] = record["user"]["username"] or "unknown"
            if record["user"]["groups"] then
                -- Join groups as comma-separated string for label
                local groups = table.concat(record["user"]["groups"], ",")
                new_record["user_groups"] = groups
            end
        end

        -- Extract impersonated user if present
        if record["impersonatedUser"] then
            new_record["impersonated_user"] = record["impersonatedUser"]["username"]
        end

        -- Flatten objectRef fields
        if record["objectRef"] then
            new_record["resource"]   = record["objectRef"]["resource"] or ""
            new_record["namespace"]  = record["objectRef"]["namespace"] or "cluster-scope"
            new_record["name"]       = record["objectRef"]["name"] or ""
            new_record["apigroup"]   = record["objectRef"]["apiGroup"] or "core"
            new_record["subresource"]= record["objectRef"]["subresource"] or ""
        end

        -- HTTP verb is directly on the event
        new_record["verb"] = record["verb"] or ""

        -- Source IP (first entry in sourceIPs)
        if record["sourceIPs"] and #record["sourceIPs"] > 0 then
            new_record["source_ip"] = record["sourceIPs"][1]
        end

        return 1, timestamp, new_record
    end
```

## Falco Rules for Audit Event Detection

Falco's `k8s_audit` event source consumes audit events from the API server webhook. Falco rules defined against this source fire in near-real-time, enabling immediate alerting and automated response.

```yaml
# falco-audit-rules.yaml
# Deploy via falco-rules ConfigMap or Falco Helm chart values.customRules
---
- required_engine_version: 26

# ============================================================
# Privilege Escalation Detection
# ============================================================

# Alert when any ClusterRoleBinding is created binding a subject
# to a highly privileged ClusterRole.
- rule: Privileged ClusterRoleBinding Created
  desc: >
    Detects creation of ClusterRoleBindings that grant cluster-admin,
    system:masters, or other highly privileged roles.  This is the
    primary privilege escalation vector in Kubernetes.
  condition: >
    ka.verb = create and
    ka.target.resource = clusterrolebindings and
    (
      ka.req.binding.role = cluster-admin or
      ka.req.binding.role = system:masters or
      ka.req.binding.role = system:node or
      ka.req.binding.role contains "admin" or
      ka.req.binding.role contains "cluster"
    ) and
    not ka.user.name in (known_clusterrole_binders)
  output: >
    Privileged ClusterRoleBinding created (user=%ka.user.name
    role=%ka.req.binding.role subjects=%ka.req.binding.subjects
    ns=%ka.target.namespace sourceip=%ka.source.ip
    response=%ka.response.code)
  priority: CRITICAL
  tags: [k8s, rbac, privilege_escalation, pci_dss, soc2]
  source: k8s_audit

# Alert when a pod is created with hostPID, hostNetwork, or hostPath mounts.
- rule: Privileged Pod Created
  desc: >
    Detects creation of pods that request host-level access.  Such pods
    can escape container isolation and compromise the node.
  condition: >
    ka.verb in (create, update) and
    ka.target.resource = pods and
    not ka.target.subresource in (status, log, exec, portforward) and
    (
      ka.req.pod.host_pid = true or
      ka.req.pod.host_network = true or
      ka.req.pod.host_ipc = true or
      ka.req.pod.containers.privileged intersects (true) or
      ka.req.pod.volumes.hostpath intersects (*)
    ) and
    not ka.user.name in (known_privileged_pod_creators) and
    not ka.target.namespace in (kube-system, monitoring, logging)
  output: >
    Privileged pod created (user=%ka.user.name pod=%ka.target.name
    ns=%ka.target.namespace host_pid=%ka.req.pod.host_pid
    host_network=%ka.req.pod.host_network
    privileged=%ka.req.pod.containers.privileged
    sourceip=%ka.source.ip response=%ka.response.code)
  priority: CRITICAL
  tags: [k8s, pod_security, privilege_escalation]
  source: k8s_audit

# Alert when exec or attach is used against a pod.
# exec is a common lateral movement vector after initial pod compromise.
- rule: Pod Exec Detected
  desc: >
    Detects interactive exec or attach sessions to running pods.
    Legitimate access should flow through CI/CD pipelines, not
    direct exec.  Alert on exec by non-controller service accounts.
  condition: >
    ka.verb = create and
    ka.target.subresource in (exec, attach) and
    not ka.user.name in (known_exec_users) and
    not ka.user.groups intersects (system:masters, system:nodes)
  output: >
    Exec/attach to pod (user=%ka.user.name pod=%ka.target.name
    ns=%ka.target.namespace container=%ka.req.pod.containers.name
    command=%ka.req.pod.containers.args
    sourceip=%ka.source.ip response=%ka.response.code)
  priority: WARNING
  tags: [k8s, lateral_movement, audit]
  source: k8s_audit

# ============================================================
# Secret Access and Exfiltration
# ============================================================

# Alert on bulk secret listing (common data exfiltration technique).
- rule: Secrets Enumerated
  desc: >
    Detects list/watch operations against Secrets across namespaces.
    Legitimate components read individual secrets they need; bulk
    listing is a sign of reconnaissance or credential harvesting.
  condition: >
    ka.verb in (list, watch) and
    ka.target.resource = secrets and
    (
      ka.target.namespace = "" or  # cluster-scoped list (all namespaces)
      ka.target.namespace = "*"
    ) and
    not ka.user.name in (known_secret_enumerators) and
    not ka.user.groups intersects (system:masters)
  output: >
    Secrets enumerated cluster-wide (user=%ka.user.name
    ns=%ka.target.namespace sourceip=%ka.source.ip
    response=%ka.response.code)
  priority: HIGH
  tags: [k8s, secrets, exfiltration, pci_dss]
  source: k8s_audit

# Alert when a secret is read in a namespace the user does not normally access.
- rule: Secret Accessed in Unexpected Namespace
  desc: >
    Detects get/watch of Secrets in namespaces outside a user's
    normal operating scope.  This requires a baseline macro of
    expected user-to-namespace mappings.
  condition: >
    ka.verb = get and
    ka.target.resource = secrets and
    not ka.user.name in (known_secret_readers) and
    not ka.user.groups intersects (system:masters, system:nodes) and
    ka.response.code = 200
  output: >
    Secret accessed (user=%ka.user.name secret=%ka.target.name
    ns=%ka.target.namespace sourceip=%ka.source.ip)
  priority: MEDIUM
  tags: [k8s, secrets, data_access]
  source: k8s_audit

# ============================================================
# Service Account Token Abuse
# ============================================================

- rule: Service Account Token Created for Unexpected ServiceAccount
  desc: >
    Detects TokenRequest API calls for service accounts not associated
    with known workloads.  Attackers create service accounts and
    immediately request tokens for privilege escalation.
  condition: >
    ka.verb = create and
    ka.target.subresource = token and
    ka.target.resource = serviceaccounts and
    not ka.user.name in (known_token_requestors) and
    not ka.user.groups intersects (system:masters, system:nodes) and
    ka.response.code = 201
  output: >
    Service account token created (user=%ka.user.name
    serviceaccount=%ka.target.name ns=%ka.target.namespace
    sourceip=%ka.source.ip)
  priority: HIGH
  tags: [k8s, service_account, token_abuse]
  source: k8s_audit

# ============================================================
# Node and Cluster-Wide Changes
# ============================================================

- rule: Node Cordon or Taint Modified by Non-Admin
  desc: >
    Detects node taint or cordon changes made by non-administrative users.
    Cordoning a node can disrupt pod scheduling and is a potential
    availability attack vector.
  condition: >
    ka.verb in (update, patch) and
    ka.target.resource = nodes and
    not ka.user.name in (known_node_managers) and
    not ka.user.groups intersects (system:masters, system:nodes,
                                   system:node-controller)
  output: >
    Node modified by non-admin (user=%ka.user.name node=%ka.target.name
    verb=%ka.verb sourceip=%ka.source.ip)
  priority: MEDIUM
  tags: [k8s, node_management, availability]
  source: k8s_audit

# ============================================================
# Macros for allowlists (populate from your environment)
# ============================================================

- macro: known_clusterrole_binders
  condition: >
    ka.user.name in (
      "system:serviceaccount:kube-system:clusterrole-aggregation-controller",
      "system:serviceaccount:cert-manager:cert-manager",
      "cluster-bootstrap-admin"
    )

- macro: known_privileged_pod_creators
  condition: >
    ka.user.name in (
      "system:serviceaccount:kube-system:daemon-set-controller",
      "system:serviceaccount:monitoring:prometheus-operator"
    )

- macro: known_exec_users
  condition: >
    ka.user.name in (
      "system:serviceaccount:kube-system:job-controller"
    )

- macro: known_secret_enumerators
  condition: >
    ka.user.name in (
      "system:serviceaccount:cert-manager:cert-manager",
      "system:serviceaccount:external-secrets:external-secrets"
    )

- macro: known_secret_readers
  condition: >
    ka.user.name startswith "system:serviceaccount:"

- macro: known_token_requestors
  condition: >
    ka.user.name in (
      "system:serviceaccount:kube-system:token-cleaner",
      "vault-agent"
    )

- macro: known_node_managers
  condition: >
    ka.user.name in (
      "cluster-autoscaler",
      "system:serviceaccount:kube-system:node-controller"
    )
```

### Falco Deployment with Kubernetes Audit Plugin

```yaml
# falco-helm-values.yaml
falco:
  rules_file:
    - /etc/falco/falco_rules.yaml
    - /etc/falco/falco_rules.local.yaml
    - /etc/falco/k8s_audit_rules.yaml
    - /etc/falco/custom_audit_rules.yaml

  # Enable the k8s_audit event source
  plugins:
    - name: k8saudit
      library_path: libk8saudit.so
      init_config:
        sslCertificate: /etc/falco/tls/server.crt
        sslPrivateKey: /etc/falco/tls/server.key
        sslCACertificate: /etc/falco/tls/ca.crt
      open_params: "http://0.0.0.0:9765/k8s-audit"
    - name: json
      library_path: libjson.so
      init_config: ""

  load_plugins: [k8saudit, json]

  # Send Falco alerts to Slack and to a SIEM webhook
  outputs:
    json_output: true
    json_include_output_property: true
    json_include_tags_property: true
    rate: 1
    max_burst: 1000

falcosidekick:
  enabled: true
  config:
    slack:
      webhookurl: "" # set via secret
      channel: "#security-alerts"
      minimumpriority: "warning"
      messageformat: "Falco alert on *{{.Hostname}}*: {{.Output}}"
    webhook:
      address: "http://siem-forwarder.security:8080/falco"
      minimumpriority: "info"
    loki:
      hostport: "http://loki.logging:3100"
      minimumpriority: "info"
      # Add Loki labels for fast querying by rule and priority
      customlabels: "source=falco,cluster=production"
```

## Loki Queries for Security Analysis

### Privilege Escalation Detection

```logql
# Find all ClusterRoleBinding creates in the last 1 hour
{job="k8s-audit", verb="create", resource="clusterrolebindings"}
  | json
  | line_format "{{.username}} bound to {{.objectRef_name}} from {{.source_ip}}"

# Detect exec sessions by non-service-account users
{job="k8s-audit", verb="create"}
  | json
  | subresource = "exec"
  | username !~ "system:serviceaccount:.*"
  | line_format "EXEC by {{.username}} to pod {{.name}} in {{.namespace}} from {{.source_ip}}"

# Find rapid secret reads (>10 secrets in 1 minute from same IP — credential harvesting)
sum by (source_ip, username) (
  count_over_time(
    {job="k8s-audit", verb="get", resource="secrets"}
    | json
    | response_code = "200" [1m]
  )
) > 10

# Detect ClusterRoleBindings to cluster-admin created after hours (UTC)
{job="k8s-audit", verb="create", resource="clusterrolebindings"}
  | json
  | line_format "{{.requestReceivedTimestamp}} {{.username}} {{.objectRef_name}}"
  | timestamp > "23:00" or timestamp < "06:00"
```

### Compliance Queries (PCI-DSS and SOC 2)

```logql
# PCI-DSS 10.2.1: All individual user access to cardholder data environment
# Assumes CDE namespaces are labeled; filter by namespace prefix
{job="k8s-audit", namespace=~"cde-.*"}
  | json
  | verb != "list" and verb != "watch"
  | username !~ "system:.*"
  | line_format "{{.requestReceivedTimestamp}} {{.username}} {{.verb}} {{.resource}}/{{.name}}"

# PCI-DSS 10.2.4: Invalid logical access attempts
{job="k8s-audit"}
  | json
  | response_code = "403" or response_code = "401"
  | username !~ "system:serviceaccount:kube-system:.*"
  | line_format "{{.requestReceivedTimestamp}} DENIED {{.username}} {{.verb}} {{.resource}} from {{.source_ip}}"

# SOC 2 CC6.1: All administrative actions (cluster-scoped resources)
{job="k8s-audit", namespace="cluster-scope"}
  | json
  | verb =~ "create|update|patch|delete"
  | resource =~ "nodes|namespaces|clusterroles|clusterrolebindings|persistentvolumes"
  | line_format "{{.requestReceivedTimestamp}} {{.username}} {{.verb}} {{.resource}}/{{.name}}"

# SOC 2 CC7.2: Monitoring for unauthorized changes to security configurations
{job="k8s-audit"}
  | json
  | resource = "networkpolicies" and verb =~ "create|update|patch|delete"
  | line_format "{{.requestReceivedTimestamp}} {{.username}} {{.verb}} networkpolicy {{.name}} in {{.namespace}}"
```

### Generating Compliance Reports

```bash
#!/bin/bash
# generate-audit-report.sh — Generate monthly PCI-DSS 10 audit report
# Requires: logcli (Loki CLI), jq, date

REPORT_DATE=$(date -d "last month" +%Y-%m)
START_TIME="${REPORT_DATE}-01T00:00:00Z"
END_TIME=$(date -d "${REPORT_DATE}-01 +1 month" +%Y-%m-01T00:00:00Z)
LOKI_URL="http://loki.logging.svc.cluster.local:3100"
REPORT_DIR="/tmp/audit-reports/${REPORT_DATE}"

mkdir -p "${REPORT_DIR}"

echo "Generating PCI-DSS 10 audit report for ${REPORT_DATE}..."

# PCI-DSS 10.2.1: User access to CDE resources
logcli query \
  --addr="${LOKI_URL}" \
  --from="${START_TIME}" \
  --to="${END_TIME}" \
  --limit=100000 \
  --output=jsonl \
  '{job="k8s-audit", namespace=~"cde-.*"} | json | username !~ "system:.*"' \
  > "${REPORT_DIR}/pci-1021-cde-access.jsonl"

echo "PCI 10.2.1: $(wc -l < "${REPORT_DIR}/pci-1021-cde-access.jsonl") events"

# PCI-DSS 10.2.4: Failed access attempts
logcli query \
  --addr="${LOKI_URL}" \
  --from="${START_TIME}" \
  --to="${END_TIME}" \
  --limit=100000 \
  --output=jsonl \
  '{job="k8s-audit"} | json | response_code = "403" or response_code = "401" | username !~ "system:.*"' \
  > "${REPORT_DIR}/pci-1024-failed-access.jsonl"

echo "PCI 10.2.4: $(wc -l < "${REPORT_DIR}/pci-1024-failed-access.jsonl") failed attempts"

# PCI-DSS 10.2.5: Privilege escalation events
logcli query \
  --addr="${LOKI_URL}" \
  --from="${START_TIME}" \
  --to="${END_TIME}" \
  --limit=100000 \
  --output=jsonl \
  '{job="k8s-audit", verb="create", resource="clusterrolebindings"}' \
  > "${REPORT_DIR}/pci-1025-privilege-escalation.jsonl"

echo "PCI 10.2.5: $(wc -l < "${REPORT_DIR}/pci-1025-privilege-escalation.jsonl") privilege escalation events"

# Summary
echo ""
echo "=== Audit Report Summary for ${REPORT_DATE} ==="
echo "CDE Resource Access Events : $(wc -l < "${REPORT_DIR}/pci-1021-cde-access.jsonl")"
echo "Failed Access Attempts     : $(wc -l < "${REPORT_DIR}/pci-1024-failed-access.jsonl")"
echo "Privilege Escalation Events: $(wc -l < "${REPORT_DIR}/pci-1025-privilege-escalation.jsonl")"
echo "Report files written to    : ${REPORT_DIR}/"
```

## Detecting Privilege Escalation Patterns

The most common Kubernetes attack sequences leave distinct audit log signatures.

### Pattern 1: Token Theft and Cluster-Admin Binding

The attacker exfiltrates a token from a pod, authenticates to the API server, creates a new service account, and binds it to `cluster-admin`.

```bash
# Detect: same source IP creates a service account then immediately creates a ClusterRoleBinding
# This query joins two event streams (requires a log processing tool or Python script)

python3 << 'EOF'
import json
import sys
from collections import defaultdict
from datetime import datetime, timedelta

# Read JSONL audit events from stdin
events_by_ip = defaultdict(list)

for line in sys.stdin:
    try:
        event = json.loads(line)
    except json.JSONDecodeError:
        continue

    verb = event.get("verb", "")
    resource = event.get("objectRef", {}).get("resource", "")
    source_ip = (event.get("sourceIPs") or ["unknown"])[0]
    username = event.get("user", {}).get("username", "")
    ts_str = event.get("requestReceivedTimestamp", "")

    if verb in ("create",) and resource in ("serviceaccounts", "clusterrolebindings"):
        events_by_ip[source_ip].append({
            "ts": ts_str,
            "resource": resource,
            "username": username,
            "name": event.get("objectRef", {}).get("name", ""),
        })

# Detect sequence: serviceaccount create followed by clusterrolebinding within 5 minutes
for ip, events in events_by_ip.items():
    sa_events = [e for e in events if e["resource"] == "serviceaccounts"]
    crb_events = [e for e in events if e["resource"] == "clusterrolebindings"]

    for sa in sa_events:
        for crb in crb_events:
            if crb["ts"] > sa["ts"]:
                print(f"[ALERT] Possible privilege escalation from IP={ip}: "
                      f"created SA {sa['name']} then CRB {crb['name']} "
                      f"(user: {crb['username']})")
EOF
```

### Pattern 2: Pod Exec Followed by Secret Access

```logql
# Step 1: Find IPs that performed exec in last 10 minutes
{job="k8s-audit", verb="create"}
  | json
  | subresource = "exec"
  | response_code = "101"    # 101 Switching Protocols = exec stream opened
  [10m]

# Step 2: Cross-reference those IPs with secret gets in the same window
# (run as a separate query and correlate manually or in a SIEM)
{job="k8s-audit", verb="get", resource="secrets"}
  | json
  | response_code = "200"
  | source_ip =~ "10.0.0.0/8"  # restrict to internal IPs
  [10m]
```

### Prometheus Alert Rules for Audit Events

```yaml
# prometheus-audit-alerts.yaml
# These alerts fire on Falco alert count metrics exposed via falcosidekick-prometheus.
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kubernetes-audit-alerts
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
    - name: kubernetes-audit-security
      interval: 60s
      rules:
        # Alert when Falco detects a critical priority event.
        - alert: FalcoCriticalAuditEvent
          expr: |
            increase(falco_events_total{priority="Critical"}[5m]) > 0
          for: 0m    # page immediately; do not wait
          labels:
            severity: critical
            team: security
          annotations:
            summary: "Falco CRITICAL audit event detected"
            description: >
              {{ $value }} critical Falco audit events in the last 5 minutes.
              Rule: {{ $labels.rule }}.
              Check Falco alerts in Grafana or Loki.

        # Alert on spike in failed API server authentication.
        - alert: K8sAPIServerAuthFailureSpike
          expr: |
            sum(increase(
              apiserver_audit_requests_rejected_total[5m]
            )) by (cluster) > 50
          for: 2m
          labels:
            severity: warning
            team: security
          annotations:
            summary: "API server authentication failure spike"
            description: >
              {{ $value }} authentication failures in 5 minutes.
              Potential credential stuffing or misconfigured service account.

        # Alert on ClusterRoleBinding creates (any, during business hours and off-hours).
        - alert: ClusterRoleBindingCreated
          expr: |
            increase(
              apiserver_audit_event_total{
                verb="create",
                objectRef_resource="clusterrolebindings"
              }[10m]
            ) > 0
          for: 0m
          labels:
            severity: high
            team: security
          annotations:
            summary: "ClusterRoleBinding created"
            description: >
              A ClusterRoleBinding was created.  Verify this is authorized
              and aligns with change management records.

        # Alert when exec sessions exceed normal rate.
        - alert: ExcessivePodExecSessions
          expr: |
            sum(increase(
              apiserver_audit_event_total{
                verb="create",
                objectRef_subresource="exec"
              }[30m]
            )) > 20
          for: 5m
          labels:
            severity: warning
            team: security
          annotations:
            summary: "High volume of pod exec sessions"
            description: >
              {{ $value }} exec sessions in 30 minutes. Normal baseline
              should be near zero in production.  Investigate.
```

## Audit Log Retention for PCI-DSS and SOC 2

### PCI-DSS 4.0 Requirements

| Requirement | Control |
|---|---|
| 10.7: Retain audit logs for 12 months, 3 months immediately accessible | Loki retention 90 days hot, 9 months in object storage (S3/GCS) |
| 10.3.3: Audit logs protected from destruction and modifications | S3 Object Lock (WORM) with Compliance mode, minimum 365 days |
| 10.3.2: Audit log files protected against unauthorized access | S3 bucket policy: deny `s3:DeleteObject`, `s3:PutObject` from non-approved IAM roles |
| 10.4.1: Review logs at least daily | Falco real-time + daily Loki scheduled queries via Grafana alerting |

### Loki Retention Configuration

```yaml
# loki-values.yaml (Helm)
loki:
  compactor:
    # Enable retention
    retention_enabled: true
    retention_delete_delay: 2h
    retention_delete_worker_count: 150
    delete_request_cancel_period: 24h
    compaction_interval: 10m

  limits_config:
    # Global retention: 365 days
    retention_period: 8760h   # 365 days in hours
    # Per-stream override for audit logs: longer retention
    per_stream_rate_limit: 5MB
    per_stream_rate_limit_burst: 20MB

  # Stream-level retention override via label selector
  # This requires Loki >= 2.9 with per-tenant retention
  rulerConfig:
    storage:
      type: s3
      s3:
        bucketnames: loki-audit-rules
        region: us-east-1

  # Object storage for long-term retention
  storage:
    type: s3
    s3:
      endpoint: s3.amazonaws.com
      region: us-east-1
      bucketnames: loki-audit-chunks
      # S3 Object Lock is configured at the bucket level, not in Loki config
      insecure: false

  schema_config:
    configs:
      - from: "2025-01-01"
        store: tsdb
        object_store: s3
        schema: v13
        index:
          prefix: loki_audit_
          period: 24h
```

### S3 Bucket Policy for WORM Protection

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyDeleteAuditLogs",
      "Effect": "Deny",
      "Principal": "*",
      "Action": [
        "s3:DeleteObject",
        "s3:DeleteObjectVersion",
        "s3:PutLifecycleConfiguration"
      ],
      "Resource": [
        "arn:aws:s3:::loki-audit-chunks/*",
        "arn:aws:s3:::loki-audit-chunks"
      ],
      "Condition": {
        "ArnNotLike": {
          "aws:PrincipalArn": [
            "arn:aws:iam::123456789012:role/AuditLogRetentionManager"
          ]
        }
      }
    },
    {
      "Sid": "DenyPolicyChange",
      "Effect": "Deny",
      "Principal": "*",
      "Action": [
        "s3:PutBucketPolicy",
        "s3:DeleteBucketPolicy"
      ],
      "Resource": "arn:aws:s3:::loki-audit-chunks",
      "Condition": {
        "ArnNotLike": {
          "aws:PrincipalArn": [
            "arn:aws:iam::123456789012:role/SecurityTeamBreakGlass"
          ]
        }
      }
    }
  ]
}
```

## Audit Log Integrity Verification

Log tampering is undetectable without integrity controls. The following pattern signs each batch of audit events with a HMAC-SHA256 hash stored in a separate tamper-evident log.

```go
// integrity/signer.go
package integrity

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"
)

// AuditBatch represents a batch of audit events ready for signing.
type AuditBatch struct {
	BatchID    string          `json:"batch_id"`
	Timestamp  time.Time       `json:"timestamp"`
	EventCount int             `json:"event_count"`
	Events     json.RawMessage `json:"events"`
	PrevHash   string          `json:"prev_hash"` // hash of the previous batch (chain)
}

// SignedBatch is the batch with its HMAC signature.
type SignedBatch struct {
	AuditBatch
	Signature string `json:"signature"`
	Algorithm string `json:"algorithm"` // "HMAC-SHA256"
}

// Signer produces tamper-evident audit batches.
type Signer struct {
	// secretKey is loaded from a KMS-backed secret; never hardcoded.
	secretKey []byte
}

// NewSigner creates a Signer with the provided key material.
// In production, key should come from a Vault transit key or AWS KMS.
func NewSigner(keyMaterial []byte) *Signer {
	return &Signer{secretKey: keyMaterial}
}

// Sign produces a SignedBatch with a HMAC-SHA256 over the canonical JSON
// representation of the AuditBatch.
func (s *Signer) Sign(batch AuditBatch) (SignedBatch, error) {
	canonical, err := json.Marshal(batch)
	if err != nil {
		return SignedBatch{}, fmt.Errorf("failed to marshal batch for signing: %w", err)
	}

	mac := hmac.New(sha256.New, s.secretKey)
	mac.Write(canonical)
	sig := hex.EncodeToString(mac.Sum(nil))

	return SignedBatch{
		AuditBatch: batch,
		Signature:  sig,
		Algorithm:  "HMAC-SHA256",
	}, nil
}

// Verify checks that a SignedBatch's signature matches its content.
// Returns an error if the signature is invalid (tampered content).
func (s *Signer) Verify(signed SignedBatch) error {
	// Recompute the signature over the embedded AuditBatch.
	canonical, err := json.Marshal(signed.AuditBatch)
	if err != nil {
		return fmt.Errorf("failed to marshal batch for verification: %w", err)
	}

	mac := hmac.New(sha256.New, s.secretKey)
	mac.Write(canonical)
	expected := hex.EncodeToString(mac.Sum(nil))

	// Use hmac.Equal to prevent timing attacks.
	if !hmac.Equal([]byte(signed.Signature), []byte(expected)) {
		return fmt.Errorf("signature mismatch: batch %s may have been tampered", signed.BatchID)
	}
	return nil
}
```

## Operational Runbook: Responding to Audit Alerts

```bash
#!/bin/bash
# respond-to-privileged-binding.sh — First-responder runbook for ClusterRoleBinding alert
# Run when: FalcoCriticalAuditEvent fires with rule "Privileged ClusterRoleBinding Created"

set -euo pipefail

SUSPICIOUS_CRB="${1:?Usage: $0 <clusterrolebinding-name>}"
INCIDENT_DIR="/tmp/incident-$(date +%Y%m%d-%H%M%S)"
mkdir -p "${INCIDENT_DIR}"

echo "[1] Capturing current state of the suspicious ClusterRoleBinding..."
kubectl get clusterrolebinding "${SUSPICIOUS_CRB}" -o json \
  > "${INCIDENT_DIR}/crb-current.json"

# Extract who is bound
BOUND_SUBJECTS=$(jq -r '.subjects[]? | "\(.kind)/\(.name) in \(.namespace // "cluster")"' \
  "${INCIDENT_DIR}/crb-current.json")
echo "Bound subjects: ${BOUND_SUBJECTS}"

echo "[2] Retrieving audit events for this binding from Loki..."
logcli query \
  --addr="http://loki.logging.svc.cluster.local:3100" \
  --since=1h \
  --limit=100 \
  --output=jsonl \
  "{job=\"k8s-audit\", resource=\"clusterrolebindings\"} | json | name = \"${SUSPICIOUS_CRB}\"" \
  > "${INCIDENT_DIR}/audit-events.jsonl"

echo "Audit events captured: $(wc -l < "${INCIDENT_DIR}/audit-events.jsonl")"

echo "[3] Identifying who created this binding..."
jq -r 'select(.verb=="create") | "\(.requestReceivedTimestamp) CREATED BY \(.username) from \(.source_ip)"' \
  "${INCIDENT_DIR}/audit-events.jsonl"

echo "[4] Checking recent activity of the creating user..."
CREATOR=$(jq -r 'select(.verb=="create") | .username' "${INCIDENT_DIR}/audit-events.jsonl" | head -1)
if [[ -n "${CREATOR}" ]]; then
  logcli query \
    --addr="http://loki.logging.svc.cluster.local:3100" \
    --since=2h \
    --limit=500 \
    --output=jsonl \
    "{job=\"k8s-audit\"} | json | username = \"${CREATOR}\"" \
    > "${INCIDENT_DIR}/creator-activity.jsonl"
  echo "Events by ${CREATOR} in last 2h: $(wc -l < "${INCIDENT_DIR}/creator-activity.jsonl")"
fi

echo "[5] REMEDIATION OPTIONS:"
echo "  a) Delete binding (immediate): kubectl delete clusterrolebinding ${SUSPICIOUS_CRB}"
echo "  b) Capture before delete      : Already done in ${INCIDENT_DIR}/crb-current.json"
echo "  c) Disable user token         : kubectl delete secret -l user=${CREATOR} -A"
echo ""
echo "Evidence collected in: ${INCIDENT_DIR}/"
echo "Submit incident ticket with contents of this directory."
```

## Summary: Compliance Mapping

| Requirement | Kubernetes Control | Implementation |
|---|---|---|
| PCI-DSS 10.2.1 (access to cardholder data) | Audit policy `RequestResponse` on CDE namespace resources | Label CDE namespaces; use Loki label filter |
| PCI-DSS 10.2.4 (invalid access attempts) | API server 403/401 response code capture | Falco `K8sApiServerAuthFailure` rule |
| PCI-DSS 10.2.5 (privilege changes) | `RequestResponse` on RBAC resources | Falco `Privileged ClusterRoleBinding Created` rule |
| PCI-DSS 10.3.2 (log protection) | S3 Object Lock (WORM) Compliance mode | Bucket policy denying DeleteObject |
| PCI-DSS 10.7 (12-month retention) | Loki 90-day hot + S3 cold storage 275 days | `retention_period: 8760h` |
| SOC 2 CC6.1 (logical access controls) | Audit all RBAC mutations | Prometheus alert on ClusterRoleBinding creates |
| SOC 2 CC7.2 (monitoring for changes) | NetworkPolicy mutations audited | Loki scheduled query + Grafana alert |
| SOC 2 CC9.2 (business continuity) | Webhook backend with local file fallback | `--audit-log-path` + webhook with retry |
