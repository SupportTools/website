---
title: "Kubernetes API Server Troubleshooting: Rate Limiting, Audit Logs, and Control Plane Debugging"
date: 2027-05-29T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Troubleshooting", "API Server", "Control Plane", "Audit", "Debugging"]
categories: ["Kubernetes", "Troubleshooting"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to diagnosing Kubernetes API server issues including 429 rate limiting, API Priority and Fairness tuning, audit log analysis, etcd latency, TLS certificate problems, webhook cascades, and control plane component debugging."
more_link: "yes"
url: "/kubernetes-api-server-troubleshooting-guide/"
---

The Kubernetes API server is the central hub through which every control plane and data plane operation flows. A degraded API server cascades into deployment failures, failed health checks, broken autoscaling, and degraded monitoring. Yet the API server's failure modes are varied and often non-obvious: a single misbehaving operator can flood the API with requests and trigger global rate limiting; a slow webhook can add seconds of latency to every pod creation; a certificate expiry can cause all kubeconfig-based authentication to fail silently. This guide provides systematic procedures for diagnosing and resolving every major API server failure category.

<!--more-->

## API Server Request Flow

### From kubectl to etcd

Every Kubernetes API request follows a well-defined pipeline. Understanding this pipeline is essential for diagnosing where a failure is occurring:

```
Client (kubectl/operator/kubelet)
       ↓
  [1] TLS Termination & Authentication
       - x509 client certificate validation
       - Bearer token (ServiceAccount, OIDC)
       - Webhook authentication (external auth)
       ↓
  [2] Authorization
       - RBAC evaluation
       - Node authorization
       - Webhook authorization
       ↓
  [3] Admission Controllers
       - Mutating admission webhooks (order matters)
       - Object validation (OpenAPI schema)
       - Validating admission webhooks
       ↓
  [4] API Priority and Fairness (APF)
       - Request classification into FlowSchemas
       - Queue management and rate limiting
       ↓
  [5] Persistence to etcd
       - etcd quorum write (for mutating requests)
       - etcd read (for GET/LIST/WATCH)
       ↓
  [6] Response
       - Object returned to client
       - Watch events dispatched
```

Failures at steps 1-3 return HTTP 4xx errors (401, 403, 400). Rate limiting at step 4 returns HTTP 429. etcd failures at step 5 return HTTP 500 or 503. Understanding which step is failing dramatically narrows the root cause space.

### Checking API Server Health

```bash
# Direct API server health check (bypasses most middleware)
curl -k https://<api-server-ip>:6443/healthz
curl -k https://<api-server-ip>:6443/readyz
curl -k https://<api-server-ip>:6443/livez

# Verbose readyz check (shows individual component status)
curl -k "https://<api-server-ip>:6443/readyz?verbose"
# Output example:
# [+] ping ok
# [+] log ok
# [+] etcd ok
# [+] etcd-readiness ok
# [+] informer-sync ok
# [+] poststarthook/start-kube-apiserver-admission-initializer ok
# [+] poststarthook/generic-apiserver-start-informers ok
# [-] shutdown ok

# Check via kubectl (uses kubeconfig credentials)
kubectl get --raw /healthz
kubectl get --raw /readyz?verbose

# Check API server version and info
kubectl version --short
kubectl api-versions | sort

# Check control plane component status
kubectl get componentstatuses 2>/dev/null || \
  kubectl get cs 2>/dev/null || \
  echo "componentstatuses deprecated in 1.19+"
```

### API Server Logs

```bash
# For managed Kubernetes (EKS, GKE, AKS) — API server logs are in cloud logging
# AWS: CloudWatch Logs
# GCP: Cloud Logging (Stackdriver)
# Azure: Azure Monitor

# For self-managed clusters (kubeadm):
# API server runs as a static pod
kubectl logs -n kube-system kube-apiserver-<node-name> | tail -50

# Or directly on the control plane node:
journalctl -u kubelet -n 200 | grep "kube-apiserver"
crictl logs $(crictl ps | grep kube-apiserver | awk '{print $1}') 2>&1 | tail -50

# For increased verbosity (temporary — add to static pod manifest)
# Add to kube-apiserver command: --v=4
# Level 4 shows timing for each request
```

## API Priority and Fairness (APF)

### Understanding APF

API Priority and Fairness (introduced stable in Kubernetes 1.29) replaces the older `--max-requests-inflight` and `--max-mutating-requests-inflight` flags with a sophisticated flow control system. APF categorizes requests into FlowSchemas and assigns them to PriorityLevelConfigurations that independently queue and rate-limit requests.

The default APF configuration includes:
- `exempt`: Reserved for health checks and high-priority system requests (no rate limiting)
- `node-high`: High-priority node requests (kubelet updates)
- `leader-election`: Leader election calls
- `workload-high`: High-priority workload requests
- `workload-low`: Standard workload requests
- `global-default`: Catch-all for unclassified requests
- `catch-all`: Final catch-all with strict limits

```bash
# List all FlowSchemas (request classification rules)
kubectl get flowschemas

# List all PriorityLevelConfigurations (queue configurations)
kubectl get prioritylevelconfigurations

# Get detailed FlowSchema information
kubectl describe flowschemas | head -80

# Check APF metrics
kubectl get --raw /metrics | grep apiserver_flowcontrol

# Key APF metrics:
# apiserver_flowcontrol_rejected_requests_total — requests dropped due to full queues
# apiserver_flowcontrol_request_wait_duration_seconds — time spent waiting in queue
# apiserver_flowcontrol_request_execution_seconds — time to execute after dequeuing
# apiserver_flowcontrol_current_inqueue_requests — current queue depth
# apiserver_flowcontrol_current_executing_requests — current execution count
```

### Diagnosing 429 Rate Limiting

HTTP 429 (`Too Many Requests`) from the Kubernetes API server means the APF system has rejected a request. The response includes headers indicating which priority level was exhausted:

```bash
# Check for 429 errors in audit logs
kubectl get --raw /apis/audit.k8s.io/v1/events 2>/dev/null

# Check via direct API response header
kubectl get pods -n production -v=6 2>&1 | grep -E "429|retry-after"

# Monitor rejection rate
kubectl get --raw /metrics | grep apiserver_flowcontrol_rejected_requests_total

# Find which FlowSchema is causing rejections
kubectl get --raw /metrics | \
  grep 'apiserver_flowcontrol_rejected_requests_total{' | \
  sort -t'"' -k6 -nr | head -10

# Example output:
# apiserver_flowcontrol_rejected_requests_total{flow_schema="global-default",priority_level="global-default",reason="queue-full"} 847

# If "global-default" is rejecting, an operator is flooding the API
# Find the high-volume requester
kubectl get --raw /metrics | grep apiserver_request_total | \
  sort -t'"' -k8 -nr | head -20
```

### Finding High-Volume API Clients

```bash
# API server metrics include per-user/per-resource request counts
kubectl get --raw /metrics | \
  grep 'apiserver_request_total{' | \
  awk -F'"' '{print $8, $0}' | \
  sort -rn | head -20

# Check current inflight requests
kubectl get --raw /debug/api_priority_and_fairness/dump_priority_levels

# This endpoint shows current queue depth per priority level:
# /debug/api_priority_and_fairness/dump_priority_levels
# /debug/api_priority_and_fairness/dump_queues
# /debug/api_priority_and_fairness/dump_requests

# Full request dump (shows which requests are currently executing/waiting)
kubectl get --raw /debug/api_priority_and_fairness/dump_requests | head -40
```

### Creating Custom FlowSchemas

When a critical workload is being rate-limited by the global-default, create a dedicated FlowSchema with a higher-priority level:

```yaml
# Give ArgoCD dedicated priority to prevent deployment delays during load
apiVersion: flowcontrol.apiserver.k8s.io/v1
kind: FlowSchema
metadata:
  name: argocd-high-priority
spec:
  priorityLevelConfiguration:
    name: workload-high
  matchingPrecedence: 900
  distinguisherMethod:
    type: ByUser
  rules:
  - subjects:
    - kind: ServiceAccount
      serviceAccount:
        namespace: argocd
        name: argocd-server
    - kind: ServiceAccount
      serviceAccount:
        namespace: argocd
        name: argocd-application-controller
    resourceRules:
    - verbs: ["*"]
      apiGroups: ["*"]
      resources: ["*"]
---
# Create a custom priority level for a high-throughput operator
apiVersion: flowcontrol.apiserver.k8s.io/v1
kind: PriorityLevelConfiguration
metadata:
  name: operator-priority
spec:
  type: Limited
  limited:
    nominalConcurrencyShares: 30
    lendablePercent: 0
    borrowingLimitPercent: 0
    limitResponse:
      type: Queue
      queuing:
        queues: 16
        handSize: 4
        queueLengthLimit: 50
---
apiVersion: flowcontrol.apiserver.k8s.io/v1
kind: FlowSchema
metadata:
  name: my-operator-flow
spec:
  priorityLevelConfiguration:
    name: operator-priority
  matchingPrecedence: 850
  distinguisherMethod:
    type: ByUser
  rules:
  - subjects:
    - kind: ServiceAccount
      serviceAccount:
        namespace: operators
        name: my-operator
    resourceRules:
    - verbs: ["*"]
      apiGroups: ["*"]
      resources: ["*"]
```

### Tuning API Server Flags for High Load

For clusters with many operators or high churn:

```yaml
# In kube-apiserver static pod manifest: /etc/kubernetes/manifests/kube-apiserver.yaml
spec:
  containers:
  - command:
    - kube-apiserver
    # Increase watch cache sizes for frequently accessed resources
    - --watch-cache-sizes=nodes#100,pods#500,endpoints#1000
    # Enable API Priority and Fairness (default in 1.20+)
    - --enable-priority-and-fairness=true
    # Increase max requests in flight (legacy fallback)
    - --max-requests-inflight=800
    - --max-mutating-requests-inflight=400
    # Tune request timeout
    - --request-timeout=60s
    # Enable request header logging at verbosity 4+
    - --v=2
    # Tune etcd compaction
    - --etcd-compaction-interval=5m
    - --etcd-count-metric-poll-period=1m
```

## Audit Log Analysis

### Configuring API Server Audit Logging

Audit logs record every API server interaction. They are essential for security investigations and forensic analysis:

```yaml
# Audit policy file — save as /etc/kubernetes/audit-policy.yaml
apiVersion: audit.k8s.io/v1
kind: Policy
# Don't audit requests from the system:masters group (internal)
omitStages:
  - "RequestReceived"

rules:
  # Log all secret access at RequestResponse level
  - level: RequestResponse
    resources:
    - group: ""
      resources: ["secrets"]

  # Log pod exec at RequestResponse (captures exec commands)
  - level: RequestResponse
    resources:
    - group: ""
      resources: ["pods/exec", "pods/portforward", "pods/attach"]

  # Log all create/update/delete operations at Metadata level
  - level: Metadata
    verbs: ["create", "update", "patch", "delete", "deletecollection"]
    resources:
    - group: ""
      resources: ["*"]
    - group: "apps"
      resources: ["*"]
    - group: "rbac.authorization.k8s.io"
      resources: ["*"]

  # Log changes to cluster-admin and admin roles
  - level: RequestResponse
    verbs: ["bind", "create", "update", "patch"]
    resources:
    - group: "rbac.authorization.k8s.io"
      resources: ["clusterrolebindings", "rolebindings"]

  # Log authentication failures
  - level: RequestResponse
    omitStages:
    - "ResponseStarted"
    users: ["system:anonymous"]

  # Skip high-volume read-only operations to control log size
  - level: None
    verbs: ["get", "list", "watch"]
    resources:
    - group: ""
      resources: ["events", "endpoints", "services", "configmaps"]
    - group: "coordination.k8s.io"
      resources: ["leases"]

  # Skip health check and metrics endpoints
  - level: None
    nonResourceURLs:
    - "/healthz*"
    - "/readyz*"
    - "/livez*"
    - "/metrics"
    - "/version"

  # Default: log metadata for everything else
  - level: Metadata
    omitStages:
    - "RequestReceived"
```

Configure kube-apiserver to use the audit policy:

```yaml
# /etc/kubernetes/manifests/kube-apiserver.yaml additions
spec:
  containers:
  - command:
    - kube-apiserver
    - --audit-log-path=/var/log/kubernetes/audit/audit.log
    - --audit-log-maxage=30
    - --audit-log-maxbackup=10
    - --audit-log-maxsize=100
    - --audit-policy-file=/etc/kubernetes/audit-policy.yaml
    # Optional: send to a webhook for real-time processing
    - --audit-webhook-config-file=/etc/kubernetes/audit-webhook.yaml
    - --audit-webhook-batch-max-size=100
    - --audit-webhook-batch-max-wait=5s
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

### Analyzing Audit Logs for Security Investigations

Audit logs are JSON-formatted. The key fields are:
- `user.username` — who made the request
- `verb` — what operation (get, list, create, update, delete, exec, bind)
- `objectRef.resource` — what resource type
- `objectRef.namespace` / `objectRef.name` — specific resource
- `responseStatus.code` — HTTP response code
- `requestURI` — full API path
- `sourceIPs` — client IP addresses
- `userAgent` — client tool (kubectl, operator name, etc.)

```bash
# Parse audit logs with jq

# Find all secret reads
cat /var/log/kubernetes/audit/audit.log | \
  jq -r 'select(.objectRef.resource == "secrets") |
    "\(.stageTimestamp) \(.user.username) \(.verb) \(.objectRef.namespace)/\(.objectRef.name)"'

# Find privilege escalation — new ClusterRoleBindings with cluster-admin
cat /var/log/kubernetes/audit/audit.log | \
  jq -r 'select(.objectRef.resource == "clusterrolebindings" and .verb == "create") |
    "\(.stageTimestamp) \(.user.username) created ClusterRoleBinding: \(.requestObject.metadata.name) → \(.requestObject.roleRef.name)"'

# Find failed authentication attempts (401 responses)
cat /var/log/kubernetes/audit/audit.log | \
  jq -r 'select(.responseStatus.code == 401) |
    "\(.stageTimestamp) \(.sourceIPs[0]) AUTHN_FAIL \(.requestURI) user=\(.user.username)"'

# Find all pod exec operations (often indicates investigation or incident response)
cat /var/log/kubernetes/audit/audit.log | \
  jq -r 'select(.objectRef.subresource == "exec") |
    "\(.stageTimestamp) \(.user.username) exec into \(.objectRef.namespace)/\(.objectRef.name)"'

# Find all resource deletions in the last hour
HOUR_AGO=$(date -d '1 hour ago' -u +%Y-%m-%dT%H:%M:%S)
cat /var/log/kubernetes/audit/audit.log | \
  jq -r "select(.stageTimestamp > \"${HOUR_AGO}\" and .verb == \"delete\") |
    \"\(.stageTimestamp) \(.user.username) deleted \(.objectRef.resource)/\(.objectRef.name) in \(.objectRef.namespace)\"" | \
  sort

# High-volume API users (potential runaway operators)
cat /var/log/kubernetes/audit/audit.log | \
  jq -r '.user.username' | \
  sort | uniq -c | sort -rn | head -20

# Find requests that triggered 429 (rate limited)
cat /var/log/kubernetes/audit/audit.log | \
  jq -r 'select(.responseStatus.code == 429) |
    "\(.stageTimestamp) \(.user.username) \(.verb) \(.requestURI)"'
```

### Sending Audit Logs to Elasticsearch

For production clusters, stream audit logs to a centralized SIEM:

```yaml
# audit-webhook.yaml — sends audit events to Falco, Elasticsearch, or SIEM
apiVersion: v1
kind: Config
clusters:
- name: audit-sink
  cluster:
    server: https://falco-audit-sink.falco.svc.cluster.local/k8s-audit
    certificate-authority: /etc/kubernetes/falco-ca.crt
contexts:
- context:
    cluster: audit-sink
    user: ""
  name: default
current-context: default
users: []
```

```yaml
# Fluent Bit configuration to forward audit logs to Elasticsearch
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluent-bit-audit-config
  namespace: logging
data:
  fluent-bit.conf: |
    [SERVICE]
        Flush         5
        Daemon        Off
        Log_Level     info

    [INPUT]
        Name          tail
        Path          /var/log/kubernetes/audit/audit.log
        Tag           k8s.audit
        Parser        json
        DB            /var/log/fluentbit-audit.db
        Mem_Buf_Limit 50MB

    [FILTER]
        Name          record_modifier
        Match         k8s.audit
        Record        cluster_name production-cluster

    [OUTPUT]
        Name          es
        Match         k8s.audit
        Host          elasticsearch.logging.svc.cluster.local
        Port          9200
        Index         k8s-audit
        Type          _doc
        HTTP_User     elastic
        HTTP_Passwd   ${ES_PASSWORD}
        tls           On
        tls.verify    On
```

## etcd Latency and Its Impact

### How etcd Latency Affects the API Server

The API server is synchronously dependent on etcd for every write operation and most read operations (unless served from the watch cache). etcd latency manifests as:

- Slow API responses (kubectl commands take > 1 second)
- Watch events delayed (deployments appear to stall)
- Leader election timeouts (controller-manager and scheduler failover)
- API server reporting `etcd` as unhealthy in `/readyz?verbose`

```bash
# Check etcd health directly
# For kubeadm clusters:
kubectl exec -n kube-system etcd-<control-plane-node> -- \
  etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  endpoint health

# Check etcd cluster members
kubectl exec -n kube-system etcd-<node> -- \
  etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  member list

# Check etcd endpoint status (latency and leader)
kubectl exec -n kube-system etcd-<node> -- \
  etcdctl \
  --endpoints=https://etcd-01:2379,https://etcd-02:2379,https://etcd-03:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  endpoint status --write-out=table
```

### etcd Performance Metrics

```bash
# Check etcd Prometheus metrics
kubectl port-forward -n kube-system etcd-<node> 2381:2381 &
curl http://localhost:2381/metrics | grep -E "etcd_disk|etcd_server|etcd_network"

# Critical etcd metrics:
# etcd_disk_wal_fsync_duration_seconds — disk write latency (should be < 10ms p99)
# etcd_disk_backend_commit_duration_seconds — fsync to disk (should be < 25ms p99)
# etcd_server_proposals_failed_total — failed Raft proposals
# etcd_server_is_leader — 1 if this member is leader
# etcd_network_peer_round_trip_time_seconds — network latency between etcd members

# Check etcd database size (large DB causes performance degradation)
kubectl exec -n kube-system etcd-<node> -- \
  etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  endpoint status --write-out=json | jq '.[0].Status.dbSize'

# Compact etcd (removes historical revisions)
REVISION=$(kubectl exec -n kube-system etcd-<node> -- \
  etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  endpoint status --write-out=json | jq '.[0].Status.header.revision')

kubectl exec -n kube-system etcd-<node> -- \
  etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  compact ${REVISION}

# Defragment to reclaim space after compaction
kubectl exec -n kube-system etcd-<node> -- \
  etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  defrag --cluster
```

### Diagnosing Slow etcd Disk IO

```bash
# On the etcd node, check disk latency
iostat -x 1 10 | grep -E "Device|nvme|sda|vda"

# Check if etcd is hitting disk IO limits
dmesg | grep -i "io error\|blk_update_request"

# Check etcd WAL directory disk usage
du -sh /var/lib/etcd/

# For AWS: check EBS volume metrics
# etcd requires < 1ms p99 write latency for reliable operation
# Use gp3 with provisioned IOPS or io2 for etcd in production

# Monitor etcd write latency with a simple benchmark
kubectl exec -n kube-system etcd-<node> -- \
  etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  check perf --load=s  # small load test
```

## TLS Certificate Expiry Issues

### Diagnosing Certificate Expiry

```bash
# Check all Kubernetes component certificates
# For kubeadm clusters:
kubeadm certs check-expiration

# Output:
# CERTIFICATE                EXPIRES                  RESIDUAL TIME  CERTIFICATE AUTHORITY  EXTERNALLY MANAGED
# admin.conf                 Nov 05, 2025 14:23 UTC   350d           ca                     no
# apiserver                  Nov 05, 2025 14:23 UTC   350d           ca                     no
# apiserver-etcd-client      Nov 05, 2025 14:23 UTC   350d           etcd-ca                no
# apiserver-kubelet-client   Nov 05, 2025 14:23 UTC   350d           ca                     no
# controller-manager.conf    Nov 05, 2025 14:23 UTC   350d           ca                     no
# etcd-healthcheck-client    Nov 05, 2025 14:23 UTC   350d           etcd-ca                no
# etcd-peer                  Nov 05, 2025 14:23 UTC   350d           etcd-ca                no
# etcd-server                Nov 05, 2025 14:23 UTC   350d           etcd-ca                no
# front-proxy-client         Nov 05, 2025 14:23 UTC   350d           front-proxy-ca         no
# scheduler.conf             Nov 05, 2025 14:23 UTC   350d           ca                     no

# Check cert-manager certificates in the cluster
kubectl get certificates -A

# Check a specific certificate manually
openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -dates
openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -text | grep -E "Subject:|Issuer:|Not After"

# Check kubeconfig certificates
kubectl config view --raw | \
  grep "client-certificate-data" | \
  awk '{print $2}' | \
  base64 -d | \
  openssl x509 -noout -dates
```

### Renewing Certificates Before Expiry

```bash
# Renew all kubeadm certificates (run on each control plane node)
# This renews certificates that expire within 365 days
kubeadm certs renew all

# Or renew specific certificates
kubeadm certs renew apiserver
kubeadm certs renew apiserver-kubelet-client
kubeadm certs renew etcd-server

# After renewal, restart control plane components to pick up new certs
# The static pods will automatically restart when their manifest changes
# but sometimes need a manual restart:
crictl pods | grep -E "kube-apiserver|kube-scheduler|kube-controller-manager|etcd" | \
  awk '{print $1}' | xargs -I{} crictl stopp {}

# Update kubeconfig files that use renewed certs
kubeadm init phase kubeconfig all
cp /etc/kubernetes/admin.conf ~/.kube/config

# Verify renewal succeeded
kubeadm certs check-expiration
```

### Certificate Expiry Monitoring

```bash
# Prometheus rule for certificate expiry
cat << 'EOF'
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kubernetes-cert-expiry
  namespace: monitoring
spec:
  groups:
  - name: kubernetes.certificates
    rules:
    - alert: KubernetesCertificateExpiryWarning
      expr: |
        kubeadm_cert_expiration_timestamp_seconds - time() < 86400 * 30
      for: 1h
      labels:
        severity: warning
      annotations:
        summary: "Kubernetes certificate expires in < 30 days"
        description: "Certificate {{ $labels.certificate }} expires at {{ $value | humanizeTimestamp }}"

    - alert: KubernetesCertificateExpiryCritical
      expr: |
        kubeadm_cert_expiration_timestamp_seconds - time() < 86400 * 7
      for: 15m
      labels:
        severity: critical
      annotations:
        summary: "Kubernetes certificate expires in < 7 days"
        description: "URGENT: Certificate {{ $labels.certificate }} expires in {{ $value | humanizeDuration }}"
EOF
```

## Webhook Timeout Cascades

### How Webhooks Can Break the API Server

Admission webhooks (both mutating and validating) are called synchronously during request processing. If a webhook is slow or unavailable:

- API server waits up to the `timeoutSeconds` value (default 10s)
- If `failurePolicy: Fail`, a webhook timeout causes the API request to fail with 500
- If `failurePolicy: Ignore`, the webhook is skipped
- A webhook that times out on every request adds the timeout to all matched resource operations
- Multiple slow webhooks compound the latency

```bash
# List all admission webhooks
kubectl get mutatingwebhookconfigurations
kubectl get validatingwebhookconfigurations

# Describe a webhook to see timeout and failure policy
kubectl describe mutatingwebhookconfiguration my-webhook | grep -A10 "Webhook"

# Check webhook endpoint health
# Find the service the webhook points to
kubectl get mutatingwebhookconfiguration my-webhook \
  -o jsonpath='{.webhooks[*].clientConfig.service}'

# Test the webhook service directly
kubectl port-forward -n my-webhook-ns svc/my-webhook 8443:443 &
curl -sk https://localhost:8443/mutate -H "Content-Type: application/json" \
  -d '{"request": {"uid": "test", "kind": {"group": "", "version": "v1", "kind": "Pod"}}}'
```

### Diagnosing Webhook-Caused API Failures

```bash
# Check API server logs for webhook timeouts
kubectl logs -n kube-system kube-apiserver-<node> 2>&1 | \
  grep -i "webhook\|admission\|timeout" | tail -20

# Look for patterns like:
# "failed calling webhook ... context deadline exceeded"
# "rejected by webhook ... <webhook-name>: ..."
# "admission webhook ... cannot handle resources"

# Check webhook controller pod health
kubectl get pods -n webhook-system

# Check webhook pod logs
kubectl logs -n webhook-system deployment/my-admission-webhook | tail -20

# Temporarily disable a problematic webhook (emergency procedure)
# Option 1: Change failurePolicy to Ignore
kubectl patch mutatingwebhookconfiguration my-webhook \
  --type='json' \
  -p='[{"op": "replace", "path": "/webhooks/0/failurePolicy", "value": "Ignore"}]'

# Option 2: Scale down the webhook deployment (failurePolicy must be Ignore first)
kubectl scale deployment my-admission-webhook -n webhook-system --replicas=0

# Option 3: Delete the webhook configuration (all requests bypass it)
# WARNING: This removes all enforcement — only do this in emergencies
kubectl delete mutatingwebhookconfiguration my-webhook

# Check webhook timing with metrics
kubectl get --raw /metrics | grep "apiserver_admission_webhook_request_duration"
```

### Webhook Best Practices Configuration

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: production-mutating-webhook
webhooks:
- name: mutate.pods.production
  rules:
  - apiGroups: [""]
    apiVersions: ["v1"]
    operations: ["CREATE", "UPDATE"]
    resources: ["pods"]
    scope: "Namespaced"
  clientConfig:
    service:
      namespace: webhook-system
      name: admission-webhook
      port: 8443
      path: /mutate-pods
    caBundle: <base64-ca-cert>
  # CRITICAL: Set a reasonable timeout
  timeoutSeconds: 5
  # CRITICAL: Use Ignore for non-critical webhooks
  failurePolicy: Ignore
  # Don't match system namespaces — prevents control plane deadlock
  namespaceSelector:
    matchExpressions:
    - key: kubernetes.io/metadata.name
      operator: NotIn
      values:
      - kube-system
      - kube-public
      - kube-node-lease
      - monitoring
  sideEffects: None
  admissionReviewVersions: ["v1", "v1beta1"]
  # Only match specific labels to reduce webhook call volume
  objectSelector:
    matchLabels:
      webhook.production.io/enabled: "true"
```

## RBAC Debugging

### Diagnosing Authorization Failures (403)

```bash
# HTTP 403 means the request was authenticated but not authorized

# Check if a user/ServiceAccount can perform an action
kubectl auth can-i get pods \
  --namespace production \
  --as system:serviceaccount:production:my-service-account

# Check all permissions for a service account
kubectl auth can-i --list \
  --namespace production \
  --as system:serviceaccount:production:my-service-account

# Find all roles and bindings for a service account
kubectl get rolebindings,clusterrolebindings -A \
  -o json | \
  jq -r '.items[] | select(
    .subjects[]? |
    select(.kind == "ServiceAccount" and
           .name == "my-service-account" and
           .namespace == "production")
  ) | "\(.kind)/\(.metadata.name) in \(.metadata.namespace // "cluster-scope") → \(.roleRef.name)"'

# Get the full permissions of a role
kubectl get clusterrole my-operator-role -o yaml | grep -A5 rules

# Check for RBAC-related events
kubectl get events -A | grep -i "forbidden\|unauthorized\|rbac"

# Audit log analysis for 403 errors
cat /var/log/kubernetes/audit/audit.log | \
  jq -r 'select(.responseStatus.code == 403) |
    "\(.stageTimestamp) \(.user.username) DENIED \(.verb) \(.objectRef.resource) in \(.objectRef.namespace)"' | \
  sort | uniq -c | sort -rn | head -20
```

### kubeconfig Authentication Debugging

```bash
# Verify kubeconfig is pointing to the correct cluster
kubectl config get-contexts
kubectl config current-context
kubectl config view --minify

# Test authentication
kubectl auth whoami
# or for older versions:
kubectl get nodes 2>&1 | head -3

# Check token validity
TOKEN=$(kubectl config view --raw \
  -o jsonpath='{.users[0].user.token}')
echo ${TOKEN} | cut -d. -f2 | base64 -d 2>/dev/null | jq .

# For OIDC authentication, check token expiry
# The JWT claims include exp (expiration)
echo ${TOKEN} | cut -d. -f2 | base64 -d 2>/dev/null | \
  jq -r '.exp' | xargs -I{} date -d @{}

# For x509 cert authentication, check cert in kubeconfig
kubectl config view --raw | \
  grep "client-certificate-data" | \
  awk '{print $2}' | \
  base64 -d | \
  openssl x509 -noout -text | grep -E "Subject:|Not After"

# Check if API server accepts requests from new kubeconfig
kubectl get pods -n kube-system \
  --kubeconfig /path/to/new-kubeconfig \
  --v=6 2>&1 | head -20
```

## Leader Election Failures

### Diagnosing Leader Election Issues

```bash
# kube-controller-manager and kube-scheduler use leader election
# to ensure only one instance is active in HA setups

# Check current leader (stored as an annotation on Lease object)
kubectl get lease kube-controller-manager -n kube-system -o yaml
kubectl get lease kube-scheduler -n kube-system -o yaml

# The holderIdentity field shows the current leader:
kubectl get lease kube-controller-manager -n kube-system \
  -o jsonpath='{.spec.holderIdentity}'

# If leader election is failing, check controller-manager logs
kubectl logs -n kube-system kube-controller-manager-<node> | grep -i "leader"

# Leader election parameters in controller-manager
# --leader-elect=true
# --leader-elect-lease-duration=15s   (default)
# --leader-elect-renew-deadline=10s   (default)
# --leader-elect-retry-period=2s      (default)

# If the API server is slow (etcd latency), leader election can fail
# because the lease renewal times out
# Solution: Increase renew-deadline and lease-duration proportionally

# Check if controller-manager is making progress
# If it's stuck, check if it can reach the API server
kubectl logs -n kube-system kube-controller-manager-<node> | \
  grep -E "error|fail|timeout" | tail -20

# Test controller-manager's API server connectivity
kubectl get componentstatuses 2>/dev/null
# Or verify deployments are being reconciled
kubectl rollout status deployment/my-app -n production --timeout=60s
```

## Control Plane Component Health Checks

### Comprehensive Control Plane Audit

```bash
#!/bin/bash
# control-plane-health.sh — run on control plane nodes or with cluster-admin RBAC

set -euo pipefail

echo "=== Kubernetes Control Plane Health Audit ==="
echo ""

echo "=== 1. API Server Health ==="
kubectl get --raw /readyz?verbose
echo ""

echo "=== 2. Control Plane Node Status ==="
kubectl get nodes \
  -l node-role.kubernetes.io/control-plane \
  -o wide 2>/dev/null || \
kubectl get nodes \
  -l node-role.kubernetes.io/master \
  -o wide 2>/dev/null
echo ""

echo "=== 3. Control Plane Pod Health ==="
kubectl get pods -n kube-system \
  -l tier=control-plane \
  -o wide 2>/dev/null || \
kubectl get pods -n kube-system | \
  grep -E "kube-apiserver|kube-controller|kube-scheduler|etcd"
echo ""

echo "=== 4. etcd Health ==="
# Get etcd pod name
ETCD_POD=$(kubectl get pods -n kube-system \
  -l component=etcd \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)

if [ -n "${ETCD_POD}" ]; then
  kubectl exec -n kube-system ${ETCD_POD} -- \
    etcdctl \
    --endpoints=https://127.0.0.1:2379 \
    --cacert=/etc/kubernetes/pki/etcd/ca.crt \
    --cert=/etc/kubernetes/pki/etcd/server.crt \
    --key=/etc/kubernetes/pki/etcd/server.key \
    endpoint health
fi
echo ""

echo "=== 5. Certificate Expiry ==="
kubeadm certs check-expiration 2>/dev/null | head -30 || \
  echo "kubeadm not available or not a kubeadm cluster"
echo ""

echo "=== 6. Webhook Health ==="
echo "--- Mutating Webhooks ---"
kubectl get mutatingwebhookconfigurations -o wide
echo ""
echo "--- Validating Webhooks ---"
kubectl get validatingwebhookconfigurations -o wide
echo ""

echo "=== 7. Leader Election ==="
echo "--- Controller Manager Leader ---"
kubectl get lease kube-controller-manager -n kube-system \
  -o jsonpath='Holder: {.spec.holderIdentity}\nAcquired: {.spec.acquireTime}\nRenewed: {.spec.renewTime}'
echo ""
echo "--- Scheduler Leader ---"
kubectl get lease kube-scheduler -n kube-system \
  -o jsonpath='Holder: {.spec.holderIdentity}\nAcquired: {.spec.acquireTime}\nRenewed: {.spec.renewTime}'
echo ""

echo "=== 8. API Server Request Rate ==="
kubectl get --raw /metrics | \
  grep 'apiserver_request_total{' | \
  awk -F'{' '{print $2}' | \
  awk -F'}' '{print $1}' | \
  sort | uniq -c | sort -rn | head -10 2>/dev/null || true
echo ""

echo "=== 9. APF Rejection Rate ==="
kubectl get --raw /metrics | \
  grep apiserver_flowcontrol_rejected_requests_total | \
  grep -v "^#"
echo ""

echo "=== 10. Recent Error Events ==="
kubectl get events -A \
  --field-selector type=Warning \
  --sort-by='.lastTimestamp' | tail -20

echo ""
echo "=== Control Plane Health Audit Complete ==="
```

### Restarting Control Plane Components

For self-managed clusters, control plane components run as static pods managed by kubelet. Restarting them is done by modifying or touching the manifest file:

```bash
# On the control plane node:

# Restart kube-apiserver (this will cause brief API unavailability)
mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/
sleep 5
mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/

# More graceful restart for controller-manager (no client impact)
mv /etc/kubernetes/manifests/kube-controller-manager.yaml /tmp/
sleep 5
mv /tmp/kube-controller-manager.yaml /etc/kubernetes/manifests/

# Check that the component came back
kubectl wait --for=condition=Ready pod \
  -l component=kube-apiserver \
  -n kube-system \
  --timeout=60s

# Verify the component is functioning
kubectl get nodes   # Tests API server
kubectl get cs      # Tests controller-manager connectivity (deprecated but useful)
```

## API Server Performance Profiling

### Using pprof to Diagnose Memory/CPU Issues

The API server exposes pprof endpoints for performance profiling:

```bash
# Get CPU profile (30 second sample)
kubectl get --raw /debug/pprof/profile?seconds=30 > cpu.pprof

# Get heap memory profile
kubectl get --raw /debug/pprof/heap > heap.pprof

# Get goroutine stack traces (useful for deadlock detection)
kubectl get --raw /debug/pprof/goroutine > goroutines.pprof

# Analyze with go tool pprof
go tool pprof -http=:8888 cpu.pprof
# Opens a web UI at http://localhost:8888 with flame graphs

# Check goroutine count (high count indicates potential leak)
kubectl get --raw /debug/pprof/goroutine?debug=2 | \
  grep -c "^goroutine"

# API server memory usage
kubectl get --raw /metrics | \
  grep "process_resident_memory_bytes"
```

## Conclusion

The Kubernetes API server sits at the center of everything — a degraded API server affects every component that communicates with the control plane, which in large clusters means essentially all workload operations. Effective troubleshooting requires understanding the request pipeline: authentication, authorization, admission, APF, and etcd. Each stage has distinct failure modes with identifiable symptoms.

The most impactful monitoring investments for API server reliability are: certificate expiry alerts (30-day and 7-day warnings), APF rejection rate monitoring, webhook latency alerts, and etcd write latency dashboards. These four metrics cover the majority of production incidents. Paired with structured audit logging sent to a centralized SIEM, they provide both preventive visibility and the forensic capability needed for post-incident analysis.

For organizations running self-managed Kubernetes, the highest-value operational practice is establishing a regular certificate renewal cadence before the kubeadm defaults expire (1 year), as certificate expiry remains one of the most common — and most avoidable — causes of complete cluster unavailability.
