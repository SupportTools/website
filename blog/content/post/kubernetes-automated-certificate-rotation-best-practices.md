---
title: "Kubernetes Automated Certificate Rotation: Best Practices"
date: 2029-07-23T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Certificates", "TLS", "PKI", "Security", "cert-manager", "Automation"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Kubernetes automated certificate rotation covering kubelet certificate rotation, API server serving cert rotation, etcd peer cert rotation, webhook cert rotation automation, and certificate expiry monitoring."
more_link: "yes"
url: "/kubernetes-automated-certificate-rotation-best-practices/"
---

Certificate expiry is responsible for a disproportionate number of Kubernetes cluster outages. A cluster where certificates expire silently causes API server connectivity failures, etcd cluster splits, scheduler and controller-manager disconnections, webhook admission failures, and complete cluster unavailability — all within seconds of the expiry clock ticking past midnight. This guide covers every certificate rotation mechanism in Kubernetes, from kubelet client certificates to etcd peer certs, with the alerting and automation to ensure none expire unnoticed in production.

<!--more-->

# Kubernetes Automated Certificate Rotation: Best Practices

## Section 1: Kubernetes Certificate Landscape

```
Kubernetes Certificate Map:

Cluster CA
├── API Server Certificates
│   ├── kube-apiserver serving cert (HTTPS)
│   ├── kube-apiserver kubelet client cert (→ kubelet)
│   ├── kube-apiserver etcd client cert (→ etcd)
│   └── kube-apiserver aggregation client cert
│
├── Kubelet Certificates (per node)
│   ├── kubelet server cert (API → kubelet)
│   └── kubelet client cert (kubelet → API)
│
├── Controller Manager
│   └── controller-manager client cert (→ API server)
│
├── Scheduler
│   └── scheduler client cert (→ API server)
│
├── etcd Cluster CA (separate CA recommended)
│   ├── etcd server cert
│   ├── etcd peer certs (node-to-node)
│   └── etcd client certs
│
└── Service Account Key Pair (not a certificate, but rotatable)

Additional Certs:
├── Admission Webhook Certs (per webhook)
├── APIService Certs (aggregated API servers)
├── Ingress TLS Certs (per ingress)
└── Application mTLS Certs (service mesh)
```

## Section 2: Kubelet Certificate Rotation

Kubelet has two certificate types that can be auto-rotated:
1. **Client certificates**: kubelet uses these to authenticate to the API server (bootstrap token → CSR → signed certificate)
2. **Server certificates**: API server uses these when making calls to kubelet (for exec, logs, port-forward)

### Enabling Kubelet Certificate Rotation

```yaml
# /var/lib/kubelet/config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration

# Enable client certificate rotation (default: true in k8s 1.19+)
rotateCertificates: true

# Server certificate rotation requires manual CSR approval or auto-approval
serverTLSBootstrap: true

# Certificate rotation thresholds
# Rotate when cert has less than 20% of its lifetime remaining
# Default behavior handles this automatically
```

```yaml
# Enable automatic approval of kubelet server CSRs via ClusterRole
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: approve-node-server-renewal-csr
rules:
- apiGroups: ["certificates.k8s.io"]
  resources: ["certificatesigningrequests/nodeclient"]
  verbs: ["create"]
- apiGroups: ["certificates.k8s.io"]
  resources: ["certificatesigningrequests/selfnodeclient"]
  verbs: ["create"]
- apiGroups: ["certificates.k8s.io"]
  resources: ["certificatesigningrequests"]
  verbs: ["get", "list", "watch"]
  resourceNames: []
---
# Auto-approve CSRs from nodes
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: auto-approve-renewals-for-nodes
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: system:certificates.k8s.io:certificatesigningrequests:selfnodeclient
subjects:
- apiGroup: rbac.authorization.k8s.io
  kind: Group
  name: system:nodes
```

```bash
# Monitor pending CSRs from kubelet rotation
kubectl get csr | grep -E "Pending|kubelet"

# Manually approve CSRs (if auto-approval not configured)
kubectl certificate approve $(kubectl get csr -o name | grep "kubelet")

# Check kubelet certificate expiry on a node
openssl x509 -in /var/lib/kubelet/pki/kubelet-client-current.pem -noout -dates
openssl x509 -in /var/lib/kubelet/pki/kubelet.crt -noout -dates

# Verify kubelet is using rotated certificate
journalctl -u kubelet | grep -E "certificate|CSR|rotation"
```

### Bootstrap Token Renewal

```bash
# Bootstrap tokens expire — renew them before they expire
# List current bootstrap tokens
kubectl get secrets -n kube-system | grep bootstrap-token

# Check token expiry
kubectl get secret bootstrap-token-abc123 -n kube-system \
    -o jsonpath='{.data.expiration}' | base64 -d

# Create a new long-lived bootstrap token
kubeadm token create --ttl 0 --description "node-bootstrap-permanent"

# Or extend via direct secret update
kubectl patch secret bootstrap-token-abc123 -n kube-system \
    -p '{"data":{"expiration":"'"$(date -d '+1 year' -u +%Y-%m-%dT%H:%M:%SZ | base64)"'"}}'
```

## Section 3: API Server Certificate Rotation

The API server serving certificate is critical — if it expires, all clients (kubectl, controllers, admission webhooks) will reject connections.

### kubeadm-based Rotation

```bash
# kubeadm can rotate all control plane certificates
# First, check current cert expiry
kubeadm certs check-expiration

# Output:
# CERTIFICATE                EXPIRES                  RESIDUAL TIME   CERTIFICATE AUTHORITY   EXTERNALLY MANAGED
# admin.conf                 Jul 20, 2030 15:04 UTC   365d            ca                      no
# apiserver                  Jul 20, 2030 15:04 UTC   365d            ca                      no
# apiserver-etcd-client      Jul 20, 2030 15:04 UTC   365d            etcd-ca                 no
# apiserver-kubelet-client   Jul 20, 2030 15:04 UTC   365d            ca                      no
# controller-manager.conf    Jul 20, 2030 15:04 UTC   365d            ca                      no
# etcd-healthcheck-client    Jul 20, 2030 15:04 UTC   365d            etcd-ca                 no
# etcd-peer                  Jul 20, 2030 15:04 UTC   365d            etcd-ca                 no
# etcd-server                Jul 20, 2030 15:04 UTC   365d            etcd-ca                 no
# front-proxy-client         Jul 20, 2030 15:04 UTC   365d            front-proxy-ca          no
# scheduler.conf             Jul 20, 2030 15:04 UTC   365d            ca                      no

# Renew all certificates (requires restart of control plane components)
kubeadm certs renew all

# Or renew specific certificates
kubeadm certs renew apiserver
kubeadm certs renew apiserver-etcd-client
kubeadm certs renew etcd-server

# Restart control plane static pods to pick up new certs
# For static pods (most installations):
mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/
sleep 5
mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/

# Or use crictl to restart:
crictl pods | grep kube-apiserver
crictl stopp <pod-id>
# Static pod will be recreated automatically
```

### Automated Rotation Script

```bash
#!/bin/bash
# /usr/local/bin/rotate-k8s-certs.sh
# Run via cron: 0 2 * * 0 /usr/local/bin/rotate-k8s-certs.sh

set -euo pipefail

LOG_FILE="/var/log/k8s-cert-rotation.log"
SLACK_WEBHOOK="${SLACK_WEBHOOK_URL:-}"
DAYS_BEFORE_EXPIRY=30

log() {
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$LOG_FILE"
}

notify() {
    local message="$1"
    log "$message"
    if [[ -n "$SLACK_WEBHOOK" ]]; then
        curl -sf -X POST "$SLACK_WEBHOOK" \
            -H 'Content-type: application/json' \
            --data "{\"text\":\"[k8s-cert-rotation] ${message}\"}" || true
    fi
}

check_cert_expiry() {
    local cert_file="$1"
    local cert_name="$2"

    if [[ ! -f "$cert_file" ]]; then
        log "SKIP: $cert_name ($cert_file not found)"
        return 0
    fi

    # Get expiry date
    expiry=$(openssl x509 -in "$cert_file" -noout -enddate 2>/dev/null | cut -d= -f2)
    expiry_epoch=$(date -d "$expiry" +%s)
    now_epoch=$(date +%s)
    days_remaining=$(( (expiry_epoch - now_epoch) / 86400 ))

    log "CERT: $cert_name expires in ${days_remaining} days ($expiry)"

    if [[ "$days_remaining" -lt "$DAYS_BEFORE_EXPIRY" ]]; then
        return 1  # Needs rotation
    fi
    return 0
}

ROTATION_NEEDED=0

# Check critical certificates
certs=(
    "/etc/kubernetes/pki/apiserver.crt:apiserver"
    "/etc/kubernetes/pki/apiserver-kubelet-client.crt:apiserver-kubelet-client"
    "/etc/kubernetes/pki/etcd/server.crt:etcd-server"
    "/etc/kubernetes/pki/etcd/peer.crt:etcd-peer"
    "/etc/kubernetes/pki/front-proxy-client.crt:front-proxy-client"
)

for entry in "${certs[@]}"; do
    cert_file="${entry%%:*}"
    cert_name="${entry##*:}"
    if ! check_cert_expiry "$cert_file" "$cert_name"; then
        ROTATION_NEEDED=1
    fi
done

if [[ "$ROTATION_NEEDED" -eq 1 ]]; then
    notify "Certificate rotation required — starting rotation on $(hostname)"

    # Rotate certificates
    kubeadm certs renew all 2>&1 | tee -a "$LOG_FILE"

    # Restart static pods by touching their manifests
    for manifest in /etc/kubernetes/manifests/kube-*.yaml; do
        touch "$manifest"
        sleep 10  # Wait for pod restart
    done

    # Update kubeconfig for admin
    cp /etc/kubernetes/admin.conf ~/.kube/config

    notify "Certificate rotation completed on $(hostname)"
else
    log "All certificates OK — no rotation needed"
fi
```

```yaml
# CronJob to run certificate rotation check on all control plane nodes
apiVersion: batch/v1
kind: CronJob
metadata:
  name: cert-rotation-check
  namespace: kube-system
spec:
  schedule: "0 2 * * 0"  # Weekly on Sunday at 2AM
  jobTemplate:
    spec:
      template:
        spec:
          hostPID: true
          hostNetwork: true
          tolerations:
          - key: node-role.kubernetes.io/control-plane
            operator: Exists
            effect: NoSchedule
          nodeSelector:
            node-role.kubernetes.io/control-plane: ""
          containers:
          - name: cert-checker
            image: bitnami/kubectl:latest
            command: ["/bin/sh", "-c"]
            args:
            - |
              nsenter -m/proc/1/ns/mnt -- /usr/local/bin/rotate-k8s-certs.sh
            securityContext:
              privileged: true
            volumeMounts:
            - name: host-root
              mountPath: /host
          volumes:
          - name: host-root
            hostPath:
              path: /
          restartPolicy: OnFailure
```

## Section 4: etcd Certificate Rotation

etcd certificates require special care because etcd is the cluster's source of truth — rotating incorrectly can cause data loss or cluster split.

```bash
# Check etcd certificate expiry
ETCDCTL_API=3 etcdctl \
    --cert=/etc/kubernetes/pki/etcd/server.crt \
    --key=/etc/kubernetes/pki/etcd/server.key \
    --cacert=/etc/kubernetes/pki/etcd/ca.crt \
    endpoint status

# Check all etcd cert expiry dates
for cert in /etc/kubernetes/pki/etcd/*.crt; do
    echo "=== $cert ==="
    openssl x509 -in "$cert" -noout -subject -enddate
done

# Renew etcd certs with kubeadm
kubeadm certs renew etcd-server
kubeadm certs renew etcd-peer
kubeadm certs renew etcd-healthcheck-client
kubeadm certs renew apiserver-etcd-client

# Restart etcd static pod to pick up new certs
mv /etc/kubernetes/manifests/etcd.yaml /tmp/
sleep 10
mv /tmp/etcd.yaml /etc/kubernetes/manifests/

# Verify etcd is healthy after restart
ETCDCTL_API=3 etcdctl \
    --cert=/etc/kubernetes/pki/etcd/server.crt \
    --key=/etc/kubernetes/pki/etcd/server.key \
    --cacert=/etc/kubernetes/pki/etcd/ca.crt \
    endpoint health

# For multi-node etcd clusters — rotate one node at a time
# Verify cluster is healthy before proceeding to next node
ETCDCTL_API=3 etcdctl \
    --cert=/etc/kubernetes/pki/etcd/server.crt \
    --key=/etc/kubernetes/pki/etcd/server.key \
    --cacert=/etc/kubernetes/pki/etcd/ca.crt \
    endpoint status --cluster
```

## Section 5: Webhook Certificate Rotation with cert-manager

Admission webhooks require TLS certificates that must be trusted by the API server. cert-manager automates this completely.

```yaml
# cert-manager ClusterIssuer for internal CA
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: internal-ca
spec:
  ca:
    secretName: internal-ca-key-pair
---
# CA key pair secret (generated once)
# openssl genrsa -out ca.key 4096
# openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 \
#   -subj "/CN=internal-ca" -out ca.crt
# kubectl create secret tls internal-ca-key-pair \
#   --cert=ca.crt --key=ca.key -n cert-manager
```

```yaml
# Certificate for an admission webhook
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: my-webhook-cert
  namespace: my-webhook-system
spec:
  secretName: my-webhook-tls
  issuerRef:
    name: internal-ca
    kind: ClusterIssuer
  dnsNames:
  - my-webhook-service.my-webhook-system.svc
  - my-webhook-service.my-webhook-system.svc.cluster.local
  duration: 8760h       # 1 year
  renewBefore: 720h     # Renew 30 days before expiry
  usages:
  - digital signature
  - key encipherment
  - server auth
```

```yaml
# MutatingWebhookConfiguration with caBundle injection
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: my-mutating-webhook
  annotations:
    # cert-manager will inject the CA bundle automatically
    cert-manager.io/inject-ca-from: my-webhook-system/my-webhook-cert
webhooks:
- name: my-webhook.example.com
  admissionReviewVersions: ["v1"]
  clientConfig:
    service:
      name: my-webhook-service
      namespace: my-webhook-system
      path: /mutate
    # caBundle is automatically kept up-to-date by cert-manager
  rules:
  - operations: ["CREATE", "UPDATE"]
    apiGroups: [""]
    apiVersions: ["v1"]
    resources: ["pods"]
  sideEffects: None
  failurePolicy: Fail
```

### Webhook Certificate Auto-Rotation Operator Pattern

```go
// webhook/cert_rotator.go
// Watches the webhook cert secret and updates webhook caBundle automatically
package webhook

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"log/slog"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// CertRotator watches a TLS secret and reloads certificates when they change
type CertRotator struct {
	client      client.Client
	secretName  string
	secretNS    string
	logger      *slog.Logger
	mu          sync.RWMutex
	currentCert *tls.Certificate
	caBundle    []byte
}

func NewCertRotator(c client.Client, secretName, ns string, logger *slog.Logger) *CertRotator {
	return &CertRotator{
		client:     c,
		secretName: secretName,
		secretNS:   ns,
		logger:     logger,
	}
}

// Start continuously monitors the secret for certificate updates
func (r *CertRotator) Start(ctx context.Context) error {
	// Load initial certificate
	if err := r.loadCert(ctx); err != nil {
		return fmt.Errorf("initial cert load: %w", err)
	}

	// Reload every 5 minutes (cert-manager writes the secret 30 days before expiry)
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if err := r.loadCert(ctx); err != nil {
				r.logger.Error("cert reload failed", "error", err)
			}
		}
	}
}

func (r *CertRotator) loadCert(ctx context.Context) error {
	var secret corev1.Secret
	if err := r.client.Get(ctx,
		client.ObjectKey{Name: r.secretName, Namespace: r.secretNS},
		&secret); err != nil {
		return fmt.Errorf("get secret: %w", err)
	}

	certPEM := secret.Data["tls.crt"]
	keyPEM := secret.Data["tls.key"]

	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return fmt.Errorf("parse key pair: %w", err)
	}

	// Verify the certificate is not expired
	if cert.Leaf == nil {
		if cert.Leaf, err = x509.ParseCertificate(cert.Certificate[0]); err != nil {
			return fmt.Errorf("parse leaf: %w", err)
		}
	}

	if time.Now().After(cert.Leaf.NotAfter) {
		return fmt.Errorf("loaded certificate is already expired: %s", cert.Leaf.NotAfter)
	}

	daysRemaining := int(time.Until(cert.Leaf.NotAfter).Hours() / 24)

	r.mu.Lock()
	r.currentCert = &cert
	r.caBundle = certPEM
	r.mu.Unlock()

	r.logger.Info("certificate loaded",
		"expires_in_days", daysRemaining,
		"expiry", cert.Leaf.NotAfter,
	)

	return nil
}

// GetCertificate returns the current TLS certificate for use in tls.Config
func (r *CertRotator) GetCertificate(_ *tls.ClientHelloInfo) (*tls.Certificate, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.currentCert == nil {
		return nil, fmt.Errorf("no certificate loaded")
	}
	return r.currentCert, nil
}

// DaysUntilExpiry returns days remaining on the current certificate
func (r *CertRotator) DaysUntilExpiry() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.currentCert == nil || r.currentCert.Leaf == nil {
		return 0
	}
	return int(time.Until(r.currentCert.Leaf.NotAfter).Hours() / 24)
}
```

## Section 6: Certificate Expiry Monitoring

### Prometheus Metrics with cert-manager

```yaml
# cert-manager exposes certificate expiry metrics
# x509_certificate_expiry_seconds{name="...", namespace="..."} <unix_timestamp>

# Prometheus rules for certificate monitoring
groups:
  - name: certificates
    rules:
      # Alert when any cert-manager Certificate will expire in 7 days
      - alert: CertManagerCertificateExpiringSoon
        expr: |
          (certmanager_certificate_expiration_timestamp_seconds - time()) < 7 * 24 * 3600
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Certificate {{ $labels.name }} in {{ $labels.namespace }} expires soon"
          description: >
            Certificate {{ $labels.name }} in {{ $labels.namespace }} expires in
            {{ $value | humanizeDuration }}

      # Alert when cert-manager Certificate is not ready
      - alert: CertManagerCertificateNotReady
        expr: certmanager_certificate_ready_status == 0
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Certificate {{ $labels.name }} is not ready"

      # Alert when cert-manager cannot renew a certificate
      - alert: CertManagerCertificateRenewalError
        expr: |
          increase(certmanager_certificate_renewal_errors_total[1h]) > 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Certificate renewal error for {{ $labels.name }}"
```

### External Certificate Monitoring

```bash
#!/bin/bash
# /usr/local/bin/check-k8s-certs.sh
# Comprehensive check of all Kubernetes certificates

set -euo pipefail

WARN_DAYS=30
CRITICAL_DAYS=7

check_cert() {
    local cert_path="$1"
    local name="$2"

    if [[ ! -f "$cert_path" ]]; then
        echo "SKIP: $name — file not found"
        return
    fi

    expiry=$(openssl x509 -in "$cert_path" -noout -enddate 2>/dev/null | cut -d= -f2)
    expiry_epoch=$(date -d "$expiry" +%s)
    now_epoch=$(date +%s)
    days=$(( (expiry_epoch - now_epoch) / 86400 ))

    if [[ "$days" -lt "$CRITICAL_DAYS" ]]; then
        echo "CRITICAL: $name expires in ${days} days ($expiry)"
    elif [[ "$days" -lt "$WARN_DAYS" ]]; then
        echo "WARNING: $name expires in ${days} days ($expiry)"
    else
        echo "OK: $name expires in ${days} days"
    fi
}

check_kubeconfig_cert() {
    local kubeconfig="$1"
    local name="$2"

    if [[ ! -f "$kubeconfig" ]]; then return; fi

    # Extract certificate from kubeconfig
    cert_data=$(kubectl --kubeconfig="$kubeconfig" config view --raw -o \
        jsonpath='{.users[0].user.client-certificate-data}' 2>/dev/null)

    if [[ -n "$cert_data" ]]; then
        echo "$cert_data" | base64 -d | openssl x509 -noout -enddate 2>/dev/null | \
        while IFS='=' read -r _ expiry; do
            expiry_epoch=$(date -d "$expiry" +%s)
            days=$(( (expiry_epoch - $(date +%s)) / 86400 ))
            if [[ "$days" -lt "$CRITICAL_DAYS" ]]; then
                echo "CRITICAL: $name kubeconfig cert expires in ${days} days"
            elif [[ "$days" -lt "$WARN_DAYS" ]]; then
                echo "WARNING: $name kubeconfig cert expires in ${days} days"
            else
                echo "OK: $name kubeconfig cert expires in ${days} days"
            fi
        done
    fi
}

echo "=== Kubernetes Certificate Health Check ==="
echo "Date: $(date -u)"
echo ""

echo "--- Control Plane Certs ---"
check_cert /etc/kubernetes/pki/apiserver.crt "API Server"
check_cert /etc/kubernetes/pki/apiserver-kubelet-client.crt "API→Kubelet Client"
check_cert /etc/kubernetes/pki/apiserver-etcd-client.crt "API→etcd Client"
check_cert /etc/kubernetes/pki/front-proxy-client.crt "Front Proxy Client"

echo ""
echo "--- etcd Certs ---"
check_cert /etc/kubernetes/pki/etcd/server.crt "etcd Server"
check_cert /etc/kubernetes/pki/etcd/peer.crt "etcd Peer"
check_cert /etc/kubernetes/pki/etcd/healthcheck-client.crt "etcd Healthcheck"

echo ""
echo "--- Kubeconfig Certs ---"
check_kubeconfig_cert /etc/kubernetes/admin.conf "admin"
check_kubeconfig_cert /etc/kubernetes/controller-manager.conf "controller-manager"
check_kubeconfig_cert /etc/kubernetes/scheduler.conf "scheduler"

echo ""
echo "--- Kubelet Certs ---"
check_cert /var/lib/kubelet/pki/kubelet-client-current.pem "Kubelet Client"
check_cert /var/lib/kubelet/pki/kubelet.crt "Kubelet Server"
```

### Kubernetes CronJob for Certificate Monitoring

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: cert-expiry-monitor
  namespace: kube-system
spec:
  schedule: "0 8 * * *"  # Daily at 8AM
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: cert-monitor
          hostPID: true
          tolerations:
          - key: node-role.kubernetes.io/control-plane
            operator: Exists
          nodeSelector:
            node-role.kubernetes.io/control-plane: ""
          containers:
          - name: cert-monitor
            image: alpine/openssl:latest
            command: ["/bin/sh", "-c"]
            args:
            - |
              # Check all Kubernetes certificates
              check_cert() {
                local f=$1 name=$2 warn=${3:-30} crit=${4:-7}
                [ -f "$f" ] || return
                expiry=$(openssl x509 -in "$f" -noout -enddate | cut -d= -f2)
                days=$(( ($(date -d "$expiry" +%s) - $(date +%s)) / 86400 ))
                echo "${days} ${name} ${expiry}"
                [ "$days" -lt "$crit" ] && echo "CRITICAL: ${name} expires in ${days}d" >&2
                [ "$days" -lt "$warn" ] && echo "WARNING: ${name} expires in ${days}d" >&2
              }
              check_cert /pki/apiserver.crt "kube-apiserver"
              check_cert /pki/etcd/server.crt "etcd-server"
              check_cert /pki/etcd/peer.crt "etcd-peer"
            volumeMounts:
            - name: pki
              mountPath: /pki
              readOnly: true
          volumes:
          - name: pki
            hostPath:
              path: /etc/kubernetes/pki
          restartPolicy: OnFailure
```

## Section 7: cert-manager Certificate Lifecycle

```bash
# Install cert-manager
helm repo add jetstack https://charts.jetstack.io
helm repo update
helm install cert-manager jetstack/cert-manager \
    --namespace cert-manager \
    --create-namespace \
    --version v1.15.0 \
    --set crds.enabled=true \
    --set prometheus.enabled=true \
    --set webhook.timeoutSeconds=10

# Verify installation
kubectl get pods -n cert-manager
kubectl get clusterissuer,issuer,certificate,certificaterequest --all-namespaces

# Check certificate status
kubectl describe certificate my-cert -n my-namespace

# Force immediate renewal
kubectl annotate certificate my-cert -n my-namespace \
    cert-manager.io/issue-temporary-certificate="true" --overwrite
kubectl delete certificaterequest -n my-namespace \
    $(kubectl get certificaterequest -n my-namespace -o name | grep my-cert)

# Debug certificate issuance
kubectl describe certificaterequest -n my-namespace
kubectl describe order -n my-namespace
kubectl describe challenge -n my-namespace
```

## Section 8: CA Rotation (The Hard Case)

CA rotation affects all certificates signed by that CA and requires careful coordination.

```bash
#!/bin/bash
# CA rotation procedure — exercise extreme caution
# This is for self-managed clusters only (not managed like EKS/GKE)

# STEP 1: Back up all existing PKI
cp -r /etc/kubernetes/pki /etc/kubernetes/pki.backup.$(date +%Y%m%d)

# STEP 2: Generate new CA alongside old CA
cd /etc/kubernetes/pki

# Create new CA key and self-signed cert
openssl genrsa -out ca-new.key 4096
openssl req -new -x509 -days 3650 \
    -key ca-new.key \
    -sha256 \
    -subj "/CN=kubernetes/O=kubernetes" \
    -out ca-new.crt

# STEP 3: Create a combined bundle (old + new) for transition period
cat ca.crt ca-new.crt > ca-bundle.crt

# STEP 4: Update all components to trust both CAs
# Deploy ca-bundle.crt as the trusted CA bundle to all nodes
# This allows existing certs (signed by old CA) and new certs to both be trusted

# STEP 5: Re-issue all certificates with the new CA
# (Detailed per-component procedure follows per cluster setup)

# STEP 6: Remove old CA from bundle after all certs are rotated
# cp ca-new.crt ca.crt
# cp ca-new.key ca.key

echo "CA rotation is a multi-step process. Consult documentation before proceeding."
echo "Always test in non-production first."
```

## Section 9: GitOps-Based Certificate Management

```yaml
# certificates/application-certs.yaml — managed via GitOps
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: app-tls
  namespace: production
  labels:
    app.kubernetes.io/managed-by: argocd
spec:
  secretName: app-tls-secret
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  dnsNames:
  - app.example.com
  duration: 2160h    # 90 days (Let's Encrypt default)
  renewBefore: 360h  # Renew 15 days before expiry
  usages:
  - digital signature
  - key encipherment
  - server auth
  privateKey:
    algorithm: ECDSA
    size: 384
    rotationPolicy: Always  # Always generate new key on renewal
```

## Section 10: Post-Rotation Verification

```bash
#!/bin/bash
# post-rotation-verify.sh
# Run after certificate rotation to verify cluster health

set -euo pipefail

echo "=== Post-Rotation Verification ==="

# 1. API server is responding
echo "Checking API server..."
kubectl cluster-info
echo "PASS: API server responding"

# 2. All nodes are Ready
echo "Checking node status..."
NOT_READY=$(kubectl get nodes --no-headers | grep -v " Ready" | wc -l)
if [[ "$NOT_READY" -gt 0 ]]; then
    echo "FAIL: $NOT_READY node(s) not ready"
    kubectl get nodes
else
    echo "PASS: All nodes Ready"
fi

# 3. Control plane pods are running
echo "Checking control plane pods..."
for comp in kube-apiserver kube-controller-manager kube-scheduler etcd; do
    status=$(kubectl get pods -n kube-system -l "component=${comp}" \
        --no-headers -o custom-columns=STATUS:.status.phase 2>/dev/null || echo "Unknown")
    echo "  $comp: $status"
done

# 4. No CSR pending for more than 10 minutes
PENDING_CSR=$(kubectl get csr --no-headers | grep -c Pending || true)
if [[ "$PENDING_CSR" -gt 0 ]]; then
    echo "WARN: $PENDING_CSR pending CSR(s)"
    kubectl get csr | grep Pending
fi

# 5. Admission webhooks are working
echo "Testing admission webhook..."
kubectl create namespace test-cert-rotation-$(date +%s) --dry-run=client -o yaml | \
    kubectl apply --dry-run=server -f - && echo "PASS: Admission webhook functional" || \
    echo "FAIL: Admission webhook not responding"

# 6. CoreDNS is working
echo "Testing DNS resolution..."
kubectl run dns-test --image=busybox:latest --rm -it --restart=Never \
    -- nslookup kubernetes.default.svc.cluster.local && \
    echo "PASS: DNS working" || echo "FAIL: DNS resolution failed"

echo ""
echo "=== Verification Complete ==="
```
