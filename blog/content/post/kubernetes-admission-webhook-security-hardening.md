---
title: "Kubernetes Admission Webhook Security: Hardening and Best Practices"
date: 2029-05-27T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Admission Webhooks", "Security", "TLS", "OPA", "Hardening", "RBAC"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive security hardening guide for Kubernetes admission webhooks covering TLS requirements, failurePolicy implications, sideEffects, objectSelector performance optimization, and webhook timeout tuning."
more_link: "yes"
url: "/kubernetes-admission-webhook-security-hardening/"
---

Admission webhooks are among the most security-critical components in a Kubernetes cluster. A misconfigured or compromised webhook can block all pod deployments, mutate workloads silently, or be exploited to gain cluster-wide access. Yet they are also essential for policy enforcement, secret injection, and resource validation. This guide covers the full security hardening picture: TLS certificate management, failurePolicy design, sideEffect declarations, objectSelector performance tuning, timeout configuration, and protection against webhook-based attacks.

<!--more-->

# Kubernetes Admission Webhook Security: Hardening and Best Practices

## Understanding the Admission Control Flow

```
kubectl apply / API Server

          |
          v
Authentication + Authorization (RBAC)
          |
          v
Mutating Admission Webhooks (in order)
  - inject-sidecar.example.com
  - mutate-labels.example.com
          |
          v
Object Schema Validation
          |
          v
Validating Admission Webhooks (all run, any can deny)
  - validate-policy.example.com
  - validate-images.example.com
          |
          v
etcd (object persisted)
```

Critically: both mutating and validating webhooks run on **every matching request**. A single slow webhook delays the entire API path.

## Section 1: TLS Requirements and Certificate Management

### Why TLS is Mandatory

The API server calls your webhook over HTTPS. TLS is not optional — an HTTP webhook will be rejected. The CA bundle you provide tells the API server how to verify your webhook's certificate.

### cert-manager Integration (Recommended)

```yaml
# webhook-certificate.yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: admission-webhook-cert
  namespace: webhook-system
spec:
  secretName: admission-webhook-tls
  issuerRef:
    name: internal-ca
    kind: ClusterIssuer
  dnsNames:
  - admission-webhook.webhook-system.svc
  - admission-webhook.webhook-system.svc.cluster.local
  duration: 8760h    # 1 year
  renewBefore: 720h  # 30 days
  privateKey:
    algorithm: ECDSA
    size: 256
```

### CA Bundle Injection with cert-manager's cainjector

```yaml
# webhook-configuration.yaml
# The cert-manager.io/inject-ca-from annotation causes cainjector
# to automatically populate the caBundle field
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: pod-mutator
  annotations:
    cert-manager.io/inject-ca-from: webhook-system/admission-webhook-cert
spec:
  webhooks:
  - name: pod-mutator.example.com
    clientConfig:
      service:
        name: admission-webhook
        namespace: webhook-system
        path: /mutate-pods
        port: 8443
      # caBundle is populated automatically by cert-manager cainjector
      # Leave empty here — cainjector will fill it in
      caBundle: ""
    rules: [...]
```

### Manual TLS Certificate Setup

```bash
# Generate webhook CA and serving certificate
# Step 1: Create CA key and self-signed certificate
openssl genrsa -out webhook-ca.key 4096
openssl req -new -x509 -days 3650 \
  -key webhook-ca.key \
  -out webhook-ca.crt \
  -subj "/CN=webhook-ca/O=example.com"

# Step 2: Create server key and CSR
openssl genrsa -out webhook-server.key 2048
openssl req -new \
  -key webhook-server.key \
  -out webhook-server.csr \
  -subj "/CN=admission-webhook.webhook-system.svc" \
  -config <(cat <<EOF
[req]
req_extensions = v3_req
distinguished_name = req_distinguished_name
[req_distinguished_name]
[v3_req]
basicConstraints = CA:FALSE
keyUsage = nonRepudiation, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names
[alt_names]
DNS.1 = admission-webhook.webhook-system.svc
DNS.2 = admission-webhook.webhook-system.svc.cluster.local
DNS.3 = admission-webhook
EOF
)

# Step 3: Sign with CA
openssl x509 -req -days 365 \
  -in webhook-server.csr \
  -CA webhook-ca.crt \
  -CAkey webhook-ca.key \
  -CAcreateserial \
  -out webhook-server.crt \
  -extensions v3_req \
  -extfile <(cat <<EOF
[v3_req]
basicConstraints = CA:FALSE
keyUsage = nonRepudiation, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names
[alt_names]
DNS.1 = admission-webhook.webhook-system.svc
DNS.2 = admission-webhook.webhook-system.svc.cluster.local
EOF
)

# Step 4: Create Kubernetes Secret
kubectl create secret tls admission-webhook-tls \
  -n webhook-system \
  --cert=webhook-server.crt \
  --key=webhook-server.key

# Step 5: Get base64-encoded CA bundle for webhook config
CA_BUNDLE=$(cat webhook-ca.crt | base64 -w 0)
```

### Webhook TLS Server Implementation

```go
package main

import (
    "crypto/tls"
    "net/http"
    "os"
    "path/filepath"

    "k8s.io/client-go/kubernetes"
    "sigs.k8s.io/controller-runtime/pkg/webhook"
)

func startWebhookServer() error {
    // Load TLS credentials
    certFile := filepath.Join("/etc/webhook/tls", "tls.crt")
    keyFile  := filepath.Join("/etc/webhook/tls", "tls.key")

    cert, err := tls.LoadX509KeyPair(certFile, keyFile)
    if err != nil {
        return fmt.Errorf("loading TLS keypair: %w", err)
    }

    // Configure TLS with modern settings
    tlsCfg := &tls.Config{
        Certificates: []tls.Certificate{cert},
        MinVersion:   tls.VersionTLS12,  // Minimum TLS 1.2 (API server default)
        // Prefer TLS 1.3 for new connections
        CipherSuites: []uint16{
            tls.TLS_AES_128_GCM_SHA256,
            tls.TLS_AES_256_GCM_SHA384,
            tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
            tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
        },
    }

    mux := http.NewServeMux()
    mux.Handle("/mutate-pods", &PodMutator{})
    mux.Handle("/validate-pods", &PodValidator{})
    mux.Handle("/healthz", http.HandlerFunc(healthHandler))
    mux.Handle("/readyz", http.HandlerFunc(healthHandler))

    server := &http.Server{
        Addr:      ":8443",
        Handler:   mux,
        TLSConfig: tlsCfg,
        // Security: limit request body size
        // The API server sends admission reviews — typically small
        MaxHeaderBytes: 1 << 20,  // 1 MB max headers
    }

    return server.ListenAndServeTLS("", "")  // TLS config already has cert
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
    w.Write([]byte("OK"))
}
```

## Section 2: failurePolicy — The Most Dangerous Setting

The `failurePolicy` field determines what happens when the webhook is unreachable or returns an error. This is the most operationally dangerous configuration in webhook setup.

### failurePolicy: Fail (Default for Production Security)

```yaml
webhooks:
- name: validate-policy.example.com
  failurePolicy: Fail  # DEFAULT and MOST SECURE
  # If the webhook is unreachable: DENY the request
  # Use this for: security policies you cannot bypass
```

**Risk**: If your webhook pod is down, ALL matching requests will be denied. This includes:
- New deployments
- Pod evictions (if the eviction webhook matches pods)
- Namespace deletion (if you match namespace resources)
- Cluster upgrades if webhook namespace is affected

**Mitigation for failurePolicy: Fail**:

```yaml
# 1. Always exclude the webhook's own namespace
webhooks:
- name: validate-policy.example.com
  failurePolicy: Fail
  namespaceSelector:
    matchExpressions:
    - key: kubernetes.io/metadata.name
      operator: NotIn
      values:
      - webhook-system  # Webhook's own namespace — always allow
      - kube-system     # System namespace — never block
      - kube-public
      - kube-node-lease

# 2. Run multiple webhook replicas with PodAntiAffinity
apiVersion: apps/v1
kind: Deployment
metadata:
  name: admission-webhook
  namespace: webhook-system
spec:
  replicas: 3  # Never run fewer than 2 replicas
  template:
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: admission-webhook
            topologyKey: kubernetes.io/hostname  # Spread across nodes
      # Webhook pods should not be affected by their own policies
      # Add appropriate tolerations and ensure non-interference
      priorityClassName: system-cluster-critical
```

### failurePolicy: Ignore

```yaml
webhooks:
- name: add-labels.example.com
  failurePolicy: Ignore
  # If the webhook is unreachable: ALLOW the request
  # Use this for: non-critical mutations (e.g., adding optional labels)
```

**Risk**: Your security policy is silently bypassed when the webhook is unavailable. For mutating webhooks doing injection (sidecars, labels), `Ignore` means applications may start without their sidecar during an outage.

### Choosing failurePolicy

| Use Case | Recommended Policy | Reasoning |
|----------|--------------------|-----------|
| Security policy enforcement | Fail | Policy bypass is worse than downtime |
| Mandatory sidecar injection | Fail | App without sidecar = broken |
| Optional label addition | Ignore | Missing label != security issue |
| Resource cost estimation | Ignore | Estimation failure is acceptable |
| Image scanning results | Fail | Unscanned image = security risk |

## Section 3: sideEffects — Correctness and Dry-Run Support

The `sideEffects` field tells the API server whether your webhook modifies external state. This matters for:
- `kubectl apply --dry-run=server` — should not trigger real side effects
- Audit logging — understanding what webhooks change
- Replay safety

### sideEffects Values

```yaml
webhooks:
- name: my-webhook.example.com
  sideEffects: None
  # Possible values:
  # None        - No side effects (safe for dry-run)
  # NoneOnDryRun - Side effects only on real requests (not dry-run)
  # Some        - Has side effects (dry-run is excluded from this webhook)
  # Unknown     - Legacy, treated as "Some" for dry-run
```

### Implementation for NoneOnDryRun

```go
// handler.go
package webhook

import (
    "encoding/json"
    "net/http"

    admissionv1 "k8s.io/api/admission/v1"
)

type PodMutator struct {
    auditLogger *AuditLogger  // External side effect
}

func (m *PodMutator) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    var admReview admissionv1.AdmissionReview

    if err := json.NewDecoder(r.Body).Decode(&admReview); err != nil {
        http.Error(w, "bad request", http.StatusBadRequest)
        return
    }

    req := admReview.Request

    // Check if this is a dry-run request
    isDryRun := req.DryRun != nil && *req.DryRun

    patches, err := m.mutate(req)
    if err != nil {
        writeFailure(w, admReview, err.Error())
        return
    }

    // Only log to audit system on real (non-dry-run) requests
    // This makes the webhook sideEffects: NoneOnDryRun compliant
    if !isDryRun && len(patches) > 0 {
        m.auditLogger.Log(AuditEntry{
            Resource:  req.Resource.Resource,
            Name:      req.Name,
            Namespace: req.Namespace,
            Patches:   patches,
        })
    }

    writeSuccess(w, admReview, patches)
}
```

### Verifying Dry-Run Behavior

```bash
# Test that dry-run does not trigger side effects
kubectl apply -f my-pod.yaml --dry-run=server -v=8 2>&1 | grep "webhook"

# Check webhook logs during dry-run
kubectl logs -n webhook-system deployment/admission-webhook | grep "dry_run"

# The webhook should log differently or skip external writes for dry-run
```

## Section 4: objectSelector — Performance Optimization

Every API request that matches the webhook's `rules` section triggers an HTTPS call to your webhook. objectSelector lets you filter requests client-side (in the API server) before the call is made, dramatically reducing load.

### Without objectSelector (Expensive)

```yaml
# INEFFICIENT: Every pod creation calls the webhook
webhooks:
- name: inject-monitoring.example.com
  rules:
  - apiGroups: [""]
    apiVersions: ["v1"]
    operations: ["CREATE"]
    resources: ["pods"]
  # No selector — webhook called for EVERY pod in EVERY namespace
```

On a busy cluster with 100 pod starts per second, this is 100 HTTPS calls per second to your webhook.

### With objectSelector (Efficient)

```yaml
# EFFICIENT: Only call webhook for pods that opt in
webhooks:
- name: inject-monitoring.example.com
  rules:
  - apiGroups: [""]
    apiVersions: ["v1"]
    operations: ["CREATE"]
    resources: ["pods"]

  # Only call if the pod's labels match
  objectSelector:
    matchLabels:
      monitoring-injection: "enabled"  # Only pods that request injection

  # Never call for system namespaces
  namespaceSelector:
    matchExpressions:
    - key: kubernetes.io/metadata.name
      operator: NotIn
      values:
      - kube-system
      - kube-public
      - kube-node-lease
      - cert-manager
      - monitoring
```

### Namespace-Based Filtering

```yaml
# Option 1: Opt-in by namespace label
webhooks:
- name: policy-enforcer.example.com
  namespaceSelector:
    matchLabels:
      policy-enforcement: "strict"

# Label namespaces to opt in:
# kubectl label namespace production policy-enforcement=strict

# Option 2: Opt-out by namespace label (allow namespaces to bypass)
webhooks:
- name: policy-enforcer.example.com
  namespaceSelector:
    matchExpressions:
    - key: admission.example.com/disable
      operator: DoesNotExist
# Namespaces can opt out:
# kubectl label namespace testing admission.example.com/disable=true
```

### Resource-Type Filtering Best Practices

```yaml
webhooks:
- name: container-security.example.com
  rules:
  # Be specific about resource types
  - apiGroups: [""]
    apiVersions: ["v1"]
    operations: ["CREATE", "UPDATE"]
    resources: ["pods"]
    # Not pods/*, which would include logs, exec, etc.

  # Separate rules for different resource types
  - apiGroups: ["apps"]
    apiVersions: ["v1"]
    operations: ["CREATE", "UPDATE"]
    resources: ["deployments", "statefulsets", "daemonsets"]
    # Note: Deployment mutations may not reach the pod spec
    # because pods are created by the ReplicaSet controller later
```

## Section 5: Webhook Timeout Tuning

Webhook timeouts affect the user-visible latency of every API operation they match.

### Setting Appropriate Timeouts

```yaml
webhooks:
- name: fast-mutator.example.com
  timeoutSeconds: 3   # Must complete in 3 seconds or request fails
  # API server default timeout: 10 seconds
  # Kubernetes maximum: 30 seconds

- name: slow-validator.example.com
  timeoutSeconds: 10  # Allow more time for complex policy evaluation
```

### What Happens on Timeout

```
timeoutSeconds elapsed:
    |
    v
failurePolicy: Fail   → Request DENIED with timeout error
failurePolicy: Ignore → Request ALLOWED (webhook timeout bypassed)
```

### Measuring Webhook Latency

```bash
# Check API server audit logs for webhook call durations
kubectl get events -n kube-system | grep "webhook"

# Use metrics if enabled
# API server exposes webhook latency metrics:
# apiserver_admission_webhook_admission_duration_seconds{name="...", operation="...", type="..."}

# Query via Prometheus
curl -s http://localhost:9090/api/v1/query?query=\
'histogram_quantile(0.99, rate(apiserver_admission_webhook_admission_duration_seconds_bucket[5m]))' | \
jq '.data.result[] | {webhook: .metric.name, p99_latency_s: .value[1]}'
```

### Webhook Implementation for Low Latency

```go
// Fast webhook handler — optimize for latency
package webhook

import (
    "context"
    "encoding/json"
    "net/http"
    "time"
)

// Handler with strict timeout enforcement
type TimeoutedHandler struct {
    handler     http.Handler
    maxDuration time.Duration
}

func (t *TimeoutedHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    ctx, cancel := context.WithTimeout(r.Context(), t.maxDuration)
    defer cancel()
    t.handler.ServeHTTP(w, r.WithContext(ctx))
}

// Performance-optimized admission handler
type FastValidator struct {
    // Pre-compiled policy rules
    policies []*CompiledPolicy
    // Pre-allocated response pool
    respPool sync.Pool
}

func NewFastValidator(policies []*CompiledPolicy) *FastValidator {
    return &FastValidator{
        policies: policies,
        respPool: sync.Pool{
            New: func() interface{} {
                return &admissionv1.AdmissionReview{}
            },
        },
    }
}

func (v *FastValidator) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    start := time.Now()

    // Reuse response object from pool
    review := v.respPool.Get().(*admissionv1.AdmissionReview)
    defer v.respPool.Put(review)

    // Decode request
    if err := json.NewDecoder(r.Body).Decode(review); err != nil {
        http.Error(w, "bad request", http.StatusBadRequest)
        return
    }

    // Evaluate policies (with context timeout)
    allowed, reason := v.evaluatePolicies(r.Context(), review.Request)

    // Build response
    review.Response = &admissionv1.AdmissionResponse{
        UID:     review.Request.UID,
        Allowed: allowed,
    }
    if !allowed {
        review.Response.Result = &metav1.Status{
            Code:    http.StatusForbidden,
            Message: reason,
        }
    }

    // Encode and send
    w.Header().Set("Content-Type", "application/json")
    if err := json.NewEncoder(w).Encode(review); err != nil {
        log.Printf("error encoding response: %v", err)
    }

    // Track latency
    webhookLatency.WithLabelValues("validate").Observe(time.Since(start).Seconds())
}

func (v *FastValidator) evaluatePolicies(ctx context.Context, req *admissionv1.AdmissionRequest) (bool, string) {
    // Parse the resource being admitted
    var pod corev1.Pod
    if err := json.Unmarshal(req.Object.Raw, &pod); err != nil {
        return false, "invalid pod spec"
    }

    // Check context before starting expensive evaluations
    select {
    case <-ctx.Done():
        return false, "timeout evaluating policies"
    default:
    }

    // Run policies in order — short circuit on first failure
    for _, policy := range v.policies {
        if !policy.Evaluate(&pod) {
            return false, policy.ViolationMessage(&pod)
        }
    }

    return true, ""
}
```

## Section 6: Protecting Against Webhook-Based Attacks

### The Webhook Bootstrap Problem

A webhook that matches all pods can prevent itself from being updated if its pod fails:

```yaml
# DANGEROUS: This can cause a deadlock
webhooks:
- name: my-webhook.example.com
  rules:
  - resources: ["pods"]
  # Missing: excludes the webhook's own namespace
  # If the webhook pod dies, this webhook denies the replacement pod
```

**Solution: Always exclude your own namespace**:

```yaml
webhooks:
- name: my-webhook.example.com
  rules:
  - resources: ["pods"]
  namespaceSelector:
    matchExpressions:
    - key: kubernetes.io/metadata.name
      operator: NotIn
      values:
      - webhook-system  # My own namespace — never intercept
      - kube-system
```

### Webhook Privilege Escalation Prevention

```yaml
# IMPORTANT: What RBAC does your webhook's ServiceAccount need?
# Principle of least privilege:

apiVersion: v1
kind: ServiceAccount
metadata:
  name: admission-webhook
  namespace: webhook-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: admission-webhook-role
rules:
# Only what the webhook actually needs to do its job
- apiGroups: [""]
  resources: ["namespaces"]
  verbs: ["get", "list", "watch"]  # Read-only — to check namespace labels

# If webhook needs to patch resources, be explicit:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get"]  # Read-only for validation

# NEVER grant:
# - wildcard resources/verbs
# - secrets access (unless absolutely necessary)
# - cluster-admin or similar broad roles
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: admission-webhook-binding
subjects:
- kind: ServiceAccount
  name: admission-webhook
  namespace: webhook-system
roleRef:
  kind: ClusterRole
  name: admission-webhook-role
  apiGroup: rbac.authorization.k8s.io
```

### Network Policy for Webhook

```yaml
# The API server needs to reach the webhook — but nothing else should
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: admission-webhook-netpol
  namespace: webhook-system
spec:
  podSelector:
    matchLabels:
      app: admission-webhook
  policyTypes:
  - Ingress
  - Egress
  ingress:
  # Allow from API server (CIDR depends on your cluster setup)
  # For kubeadm: API server typically runs on control plane nodes
  - from:
    - ipBlock:
        cidr: 10.0.0.0/8  # Adjust to your control plane network
    ports:
    - protocol: TCP
      port: 8443
  egress:
  # Allow DNS
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
    ports:
    - protocol: UDP
      port: 53
  # Allow Kubernetes API (if webhook needs to query the cluster)
  - to:
    - ipBlock:
        cidr: 0.0.0.0/0
    ports:
    - protocol: TCP
      port: 443
    - protocol: TCP
      port: 6443
```

### Validating Webhook Integrity

```bash
# Audit your webhook configurations
kubectl get mutatingwebhookconfigurations -o json | jq '
.items[] |
{
  name: .metadata.name,
  webhooks: [.webhooks[] | {
    name: .name,
    failurePolicy: .failurePolicy,
    sideEffects: .sideEffects,
    timeoutSeconds: .timeoutSeconds,
    namespaceSelector: (if .namespaceSelector then "defined" else "MISSING - affects all namespaces" end),
    objectSelector: (if .objectSelector then "defined" else "none - expensive" end),
    caBundle: (if .clientConfig.caBundle then "present" else "MISSING - TLS not configured" end)
  }]
}'

kubectl get validatingwebhookconfigurations -o json | jq '
.items[] | {
  name: .metadata.name,
  webhooks: [.webhooks[] | {
    name: .name,
    failurePolicy: .failurePolicy,
    timeoutSeconds: .timeoutSeconds,
    hasNamespaceSelector: (.namespaceSelector != null)
  }]
}'
```

## Section 7: Complete Hardened Webhook Example

```yaml
# hardened-webhook-configuration.yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: security-policy-validator
  annotations:
    # cert-manager injects the CA bundle automatically
    cert-manager.io/inject-ca-from: webhook-system/admission-webhook-cert
spec:
  webhooks:
  - name: validate-security-policy.webhook-system.svc

    # SECURITY: Restrict which namespaces this webhook intercepts
    # Never touch kube-system or the webhook's own namespace
    namespaceSelector:
      matchExpressions:
      - key: kubernetes.io/metadata.name
        operator: NotIn
        values:
        - kube-system
        - kube-public
        - kube-node-lease
        - webhook-system
        - cert-manager
        - monitoring
      # Only enforce in namespaces with the enforcement label
      - key: security.example.com/enforce
        operator: In
        values:
        - "true"

    # PERFORMANCE: Only intercept pods with specific labels
    objectSelector:
      matchExpressions:
      - key: security.example.com/skip-validation
        operator: DoesNotExist  # Skip pods that opt out

    rules:
    - apiGroups: [""]
      apiVersions: ["v1"]
      operations: ["CREATE", "UPDATE"]
      resources: ["pods"]
      # Scope: Namespaced (default) — not cluster-scoped
      scope: "Namespaced"

    clientConfig:
      service:
        name: admission-webhook
        namespace: webhook-system
        path: /validate-pods
        port: 8443
      # CA bundle populated by cert-manager cainjector

    # SECURITY: Fail closed — deny if webhook unavailable
    failurePolicy: Fail

    # CORRECTNESS: No external state written
    sideEffects: None

    # PERFORMANCE: 5 second timeout — fail fast
    timeoutSeconds: 5

    # COMPATIBILITY: Declare what Kubernetes versions are supported
    admissionReviewVersions: ["v1", "v1beta1"]

    # REINVOCATION: For mutating webhooks — reinvoke if another webhook
    # modifies the object (validating webhooks don't need this)
    # reinvocationPolicy: IfNeeded  # Only for MutatingWebhookConfiguration
```

## Section 8: Monitoring and Alerting

```yaml
# prometheus-webhook-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: admission-webhook-alerts
  namespace: monitoring
spec:
  groups:
  - name: admission-webhooks
    rules:
    # High webhook rejection rate
    - alert: AdmissionWebhookHighRejectionRate
      expr: |
        rate(apiserver_admission_webhook_rejection_count_total[5m]) > 0.1
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Webhook {{ $labels.name }} has high rejection rate"
        description: "Rejection rate: {{ $value }} rejections/s"

    # Webhook latency too high
    - alert: AdmissionWebhookHighLatency
      expr: |
        histogram_quantile(0.99,
          rate(apiserver_admission_webhook_admission_duration_seconds_bucket[5m])
        ) > 2
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Webhook {{ $labels.name }} p99 latency > 2s"

    # Webhook timing out
    - alert: AdmissionWebhookTimeout
      expr: |
        rate(apiserver_admission_webhook_fail_open_count_total[5m]) > 0
        and
        apiserver_admission_webhook_admission_duration_seconds_count > 0
      for: 1m
      labels:
        severity: critical
      annotations:
        summary: "Admission webhook {{ $labels.name }} is timing out"

    # Webhook cert expiry
    - alert: WebhookCertificateExpiry
      expr: |
        (certmanager_certificate_expiration_timestamp_seconds{namespace="webhook-system"} - time()) < (14 * 24 * 3600)
      for: 1h
      labels:
        severity: warning
      annotations:
        summary: "Webhook certificate expiring soon"
```

## Conclusion

Securing admission webhooks requires attention to several distinct concerns. On the TLS side, use cert-manager for automated certificate rotation and ensure your webhook always excludes its own namespace to prevent bootstrap deadlocks. For `failurePolicy`, default to `Fail` for security-sensitive validations — the risk of bypassed policies outweighs the risk of temporary unavailability when you maintain proper redundancy. Declare accurate `sideEffects` to enable dry-run workflows correctly. Optimize performance with `objectSelector` and `namespaceSelector` to minimize unnecessary webhook calls. Set aggressive but realistic `timeoutSeconds` values (3-10 seconds), and build proper alerting around webhook rejection rates, latency percentiles, and certificate expiry. The payoff is a webhook infrastructure that is both secure and operationally reliable.
