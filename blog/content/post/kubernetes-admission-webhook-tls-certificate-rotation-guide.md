---
title: "Kubernetes Admission Webhook TLS: Certificate Rotation and Production Hardening"
date: 2027-04-25T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Admission Webhook", "TLS", "Certificates", "cert-manager", "Security"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to managing TLS certificates for Kubernetes admission webhooks including cert-manager integration, automatic rotation, caBundle injection, failure policies, and debugging certificate issues."
more_link: "yes"
url: "/kubernetes-admission-webhook-tls-certificate-rotation-guide/"
---

Admission webhooks are the backbone of policy enforcement in Kubernetes clusters — gating every create, update, and delete operation through custom validation or mutation logic. The TLS handshake between the API server and a webhook server is the single most common failure point teams encounter after initial deployment. Certificate expiry silently breaks policy enforcement, and a misconfigured `caBundle` field can take down an entire cluster if the webhook is configured with `failurePolicy: Fail`.

This guide covers the full lifecycle of admission webhook TLS from initial certificate provisioning through automatic rotation, caBundle synchronization, failure policy design, and systematic debugging of certificate-related failures.

<!--more-->

# Kubernetes Admission Webhook TLS Architecture

## How the API Server Validates Webhook TLS

When the Kubernetes API server calls an admission webhook, it performs a standard TLS client verification using the CA bundle stored in the `WebhookConfiguration` resource. The `caBundle` field holds a base64-encoded PEM certificate authority that the API server trusts to verify the webhook server's certificate. This means two components must stay synchronized at all times:

1. The TLS certificate presented by the webhook server
2. The `caBundle` field in the `ValidatingWebhookConfiguration` or `MutatingWebhookConfiguration` resource

If either component is stale, expired, or mismatched, the API server rejects the TLS connection with a certificate verification error. The result depends on the `failurePolicy` setting: `Ignore` means the request proceeds without webhook validation (a silent security bypass), and `Fail` means the API server returns an error to the caller, potentially preventing all mutations or deployments cluster-wide.

```
┌─────────────────────────────────────────────────────────────────────┐
│                 Admission Webhook TLS Flow                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  kubectl apply / API call                                           │
│         │                                                           │
│         ▼                                                           │
│  ┌─────────────┐    TLS with caBundle    ┌──────────────────────┐   │
│  │  API Server │ ──────────────────────► │  Webhook Server Pod  │   │
│  │             │ ◄────────────────────── │  (tls.crt / tls.key) │   │
│  └─────────────┘    webhook response     └──────────────────────┘   │
│         │                                          │                 │
│         │                               ┌──────────────────────┐   │
│         │                               │  TLS Secret          │   │
│         │                               │  - tls.crt (leaf)   │   │
│         │                               │  - tls.key (private) │   │
│         │                               └──────────────────────┘   │
│         │                                                           │
│  ┌──────────────────────────┐                                       │
│  │ WebhookConfiguration     │                                       │
│  │   caBundle: <base64 CA>  │  ◄── must match leaf cert's signer   │
│  └──────────────────────────┘                                       │
└─────────────────────────────────────────────────────────────────────┘
```

## Certificate Requirements for Webhook Servers

The certificate presented by the webhook server must satisfy several constraints that differ from typical workload certificates:

- The Subject Alternative Name (SAN) must include the internal Kubernetes DNS name of the webhook service: `<service-name>.<namespace>.svc` and `<service-name>.<namespace>.svc.cluster.local`
- The certificate must be issued by a CA whose PEM-encoded certificate is present in the `caBundle` field of the webhook configuration
- The certificate must not be expired at the time of the API server's connection attempt
- Extended Key Usage must include `serverAuth`

Failure to include the correct SAN is the most common manual certificate mistake. The API server checks the SAN, not the Common Name, so a certificate with `CN: my-webhook` but no SAN matching the service DNS name will fail verification.

## cert-manager Integration Architecture

cert-manager provides the cleanest automated approach to webhook certificate management. The key components are a `Certificate` resource that requests the cert from an `Issuer` or `ClusterIssuer`, and the cert-manager `cainjector` sidecar which reads certificates from secrets and injects the CA into webhook configurations automatically.

```
┌────────────────────────────────────────────────────────────────────┐
│                  cert-manager Webhook TLS Flow                    │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  cert-manager controller                                           │
│       │                                                            │
│       │  reconcile Certificate resource                            │
│       ▼                                                            │
│  ┌─────────────────┐   issues   ┌──────────────────────────────┐  │
│  │  ClusterIssuer   │ ─────────► │  Secret: webhook-tls         │  │
│  │  (self-signed   │            │  - ca.crt                    │  │
│  │   or ACME/Vault)│            │  - tls.crt                   │  │
│  └─────────────────┘            │  - tls.key                   │  │
│                                 └──────────────────────────────┘  │
│                                          │                         │
│  cert-manager cainjector                 │                         │
│       │  watches Secret annotations      │                         │
│       │  injects ca.crt                  │                         │
│       ▼                                  │                         │
│  ┌─────────────────────────────┐         │                         │
│  │  ValidatingWebhookConfig    │         │                         │
│  │    caBundle: <auto-injected>│         │                         │
│  └─────────────────────────────┘         │                         │
│                                          │ mounted                 │
│  Webhook Deployment Pod ◄────────────────┘                         │
│    /etc/tls/tls.crt                                                │
│    /etc/tls/tls.key                                                │
└────────────────────────────────────────────────────────────────────┘
```

# Setting Up cert-manager for Webhook TLS

## Installing cert-manager

```bash
# Install cert-manager with CRDs
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.14.4/cert-manager.yaml

# Verify the installation
kubectl -n cert-manager rollout status deployment/cert-manager
kubectl -n cert-manager rollout status deployment/cert-manager-cainjector
kubectl -n cert-manager rollout status deployment/cert-manager-webhook

# Confirm all pods are running
kubectl -n cert-manager get pods
```

## Creating a Self-Signed CA for Internal Webhooks

For admission webhooks that serve only internal cluster traffic, a self-signed CA is appropriate. The cert-manager bootstrap pattern creates a self-signed root CA, then uses that CA as an issuer for webhook server certificates.

```yaml
# webhook-pki.yaml - Complete PKI for admission webhooks
---
# Step 1: Self-signed bootstrap issuer
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned-bootstrap
spec:
  selfSigned: {}
---
# Step 2: Root CA certificate
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: webhook-ca
  namespace: cert-manager
spec:
  isCA: true
  commonName: webhook-ca
  subject:
    organizations:
      - my-org
  secretName: webhook-ca-secret
  privateKey:
    algorithm: ECDSA
    size: 256
  duration: 87600h    # 10 years for CA
  renewBefore: 720h   # renew 30 days before expiry
  issuerRef:
    name: selfsigned-bootstrap
    kind: ClusterIssuer
    group: cert-manager.io
---
# Step 3: CA-backed ClusterIssuer for signing leaf certs
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: webhook-ca-issuer
spec:
  ca:
    secretName: webhook-ca-secret
```

## Issuing the Webhook Server Certificate

```yaml
# webhook-certificate.yaml
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: my-webhook-tls
  namespace: my-webhook-system
  # The cainjector watches this annotation to know which webhook configs to update
  annotations:
    cert-manager.io/issuer-name: webhook-ca-issuer
    cert-manager.io/issuer-kind: ClusterIssuer
spec:
  secretName: my-webhook-tls-secret
  duration: 8760h     # 1 year
  renewBefore: 720h   # renew 30 days before expiry
  subject:
    organizations:
      - my-org
  commonName: my-webhook.my-webhook-system.svc
  dnsNames:
    - my-webhook.my-webhook-system.svc
    - my-webhook.my-webhook-system.svc.cluster.local
  privateKey:
    algorithm: ECDSA
    size: 256
    rotationPolicy: Always  # generate new key on each renewal
  usages:
    - server auth
    - digital signature
    - key encipherment
  issuerRef:
    name: webhook-ca-issuer
    kind: ClusterIssuer
    group: cert-manager.io
```

```bash
# Verify certificate was issued
kubectl -n my-webhook-system get certificate my-webhook-tls
kubectl -n my-webhook-system describe certificate my-webhook-tls

# Check secret was populated
kubectl -n my-webhook-system get secret my-webhook-tls-secret -o yaml

# Inspect the leaf certificate
kubectl -n my-webhook-system get secret my-webhook-tls-secret \
  -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -noout -text

# Check SAN entries
kubectl -n my-webhook-system get secret my-webhook-tls-secret \
  -o jsonpath='{.data.tls\.crt}' | base64 -d | \
  openssl x509 -noout -ext subjectAltName
```

## Deploying the Webhook Server

```yaml
# webhook-deployment.yaml
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-webhook
  namespace: my-webhook-system
  labels:
    app: my-webhook
spec:
  replicas: 2
  selector:
    matchLabels:
      app: my-webhook
  template:
    metadata:
      labels:
        app: my-webhook
    spec:
      serviceAccountName: my-webhook
      # Anti-affinity to spread webhook pods across nodes
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchExpressions:
                  - key: app
                    operator: In
                    values: [my-webhook]
              topologyKey: kubernetes.io/hostname
      containers:
        - name: webhook
          image: my-org/my-webhook:v1.2.0
          args:
            - --tls-cert-file=/etc/tls/tls.crt
            - --tls-private-key-file=/etc/tls/tls.key
            - --port=8443
          ports:
            - containerPort: 8443
              name: https
          volumeMounts:
            - name: tls
              mountPath: /etc/tls
              readOnly: true
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8443
              scheme: HTTPS
            initialDelaySeconds: 5
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /readyz
              port: 8443
              scheme: HTTPS
            initialDelaySeconds: 5
            periodSeconds: 5
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 500m
              memory: 256Mi
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            runAsNonRoot: true
            runAsUser: 65534
            capabilities:
              drop: [ALL]
      volumes:
        - name: tls
          secret:
            secretName: my-webhook-tls-secret
            defaultMode: 0440
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels:
              app: my-webhook
---
apiVersion: v1
kind: Service
metadata:
  name: my-webhook
  namespace: my-webhook-system
spec:
  selector:
    app: my-webhook
  ports:
    - name: https
      port: 443
      targetPort: 8443
  type: ClusterIP
```

# Configuring Webhook Resources with caBundle Auto-Injection

## The cert-manager cainjector Annotation

The cert-manager cainjector component watches for specific annotations on `ValidatingWebhookConfiguration` and `MutatingWebhookConfiguration` resources. When it finds the annotation `cert-manager.io/inject-ca-from`, it reads the CA certificate from the referenced secret and automatically populates the `caBundle` field on every webhook entry in the configuration.

```yaml
# validating-webhook-config.yaml
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: my-validating-webhook
  annotations:
    # Format: <namespace>/<certificate-resource-name>
    cert-manager.io/inject-ca-from: my-webhook-system/my-webhook-tls
spec:
  webhooks:
    - name: validate.myresource.my-org.io
      admissionReviewVersions: ["v1", "v1beta1"]
      clientConfig:
        service:
          name: my-webhook
          namespace: my-webhook-system
          path: /validate
          port: 443
        # caBundle is intentionally left empty here - cainjector populates it
        caBundle: ""
      rules:
        - apiGroups: ["apps"]
          apiVersions: ["v1"]
          operations: ["CREATE", "UPDATE"]
          resources: ["deployments"]
          scope: "Namespaced"
      namespaceSelector:
        matchExpressions:
          - key: kubernetes.io/metadata.name
            operator: NotIn
            values:
              - kube-system
              - cert-manager
              - my-webhook-system
      objectSelector:
        matchExpressions:
          - key: webhook.my-org.io/skip-validation
            operator: DoesNotExist
      failurePolicy: Fail
      sideEffects: None
      timeoutSeconds: 10
```

```yaml
# mutating-webhook-config.yaml
---
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: my-mutating-webhook
  annotations:
    cert-manager.io/inject-ca-from: my-webhook-system/my-webhook-tls
spec:
  webhooks:
    - name: mutate.myresource.my-org.io
      admissionReviewVersions: ["v1", "v1beta1"]
      clientConfig:
        service:
          name: my-webhook
          namespace: my-webhook-system
          path: /mutate
          port: 443
        caBundle: ""
      rules:
        - apiGroups: [""]
          apiVersions: ["v1"]
          operations: ["CREATE"]
          resources: ["pods"]
          scope: "Namespaced"
      namespaceSelector:
        matchExpressions:
          - key: kubernetes.io/metadata.name
            operator: NotIn
            values:
              - kube-system
              - cert-manager
              - my-webhook-system
      failurePolicy: Ignore   # pods can still be created if webhook is down
      reinvocationPolicy: IfNeeded
      sideEffects: None
      timeoutSeconds: 5
```

```bash
# Verify cainjector populated the caBundle field
kubectl get validatingwebhookconfiguration my-validating-webhook \
  -o jsonpath='{.webhooks[0].clientConfig.caBundle}' | base64 -d | \
  openssl x509 -noout -subject -issuer

# Watch cainjector logs to confirm injection happened
kubectl -n cert-manager logs -l app=cainjector --follow
```

## Manual caBundle Management (Without cert-manager)

When cert-manager is not available, the `caBundle` field must be managed manually or through a custom controller. The following pattern uses a shell script and CronJob to keep the caBundle synchronized.

```yaml
# caBundle-sync-rbac.yaml
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: webhook-ca-sync
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: webhook-ca-sync
rules:
  - apiGroups: ["admissionregistration.k8s.io"]
    resources:
      - validatingwebhookconfigurations
      - mutatingwebhookconfigurations
    verbs: ["get", "patch"]
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: webhook-ca-sync
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: webhook-ca-sync
subjects:
  - kind: ServiceAccount
    name: webhook-ca-sync
    namespace: kube-system
```

```yaml
# caBundle-sync-cronjob.yaml
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: webhook-ca-sync
  namespace: kube-system
spec:
  schedule: "0 * * * *"   # every hour
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: webhook-ca-sync
          restartPolicy: OnFailure
          containers:
            - name: sync
              image: bitnami/kubectl:latest
              command:
                - /bin/sh
                - -c
                - |
                  set -e
                  # Extract CA from the TLS secret
                  CA_BUNDLE=$(kubectl -n my-webhook-system get secret my-webhook-tls-secret \
                    -o jsonpath='{.data.ca\.crt}')

                  if [ -z "$CA_BUNDLE" ]; then
                    echo "ERROR: CA bundle is empty, aborting"
                    exit 1
                  fi

                  # Patch the webhook configurations
                  kubectl patch validatingwebhookconfiguration my-validating-webhook \
                    --type='json' \
                    -p="[{\"op\":\"replace\",\"path\":\"/webhooks/0/clientConfig/caBundle\",\"value\":\"${CA_BUNDLE}\"}]"

                  kubectl patch mutatingwebhookconfiguration my-mutating-webhook \
                    --type='json' \
                    -p="[{\"op\":\"replace\",\"path\":\"/webhooks/0/clientConfig/caBundle\",\"value\":\"${CA_BUNDLE}\"}]"

                  echo "caBundle sync complete"
```

# Failure Policy Design for Production

## Understanding failurePolicy Tradeoffs

The `failurePolicy` field is a critical production decision. `Fail` provides the strongest security guarantee — if the webhook cannot be contacted or returns an error, the API server rejects the admission request. `Ignore` provides the highest availability — webhook failures are silently bypassed, allowing operations to continue.

```
┌──────────────────────────────────────────────────────────────────┐
│              failurePolicy Decision Matrix                      │
├────────────────────┬─────────────────┬──────────────────────────┤
│  Webhook Type      │ Recommended     │ Rationale                │
├────────────────────┼─────────────────┼──────────────────────────┤
│ Security policy    │ Fail            │ Must enforce; bypass is  │
│ enforcement        │                 │ a security hole          │
├────────────────────┼─────────────────┼──────────────────────────┤
│ Resource defaulting│ Ignore          │ Missing defaults are     │
│ / mutation         │                 │ recoverable              │
├────────────────────┼─────────────────┼──────────────────────────┤
│ Audit / logging    │ Ignore          │ Audit failure should not │
│ webhooks           │                 │ block cluster operations │
├────────────────────┼─────────────────┼──────────────────────────┤
│ Cost allocation    │ Ignore          │ Label injection failure  │
│ label injection    │                 │ is non-critical          │
├────────────────────┼─────────────────┼──────────────────────────┤
│ Image policy       │ Fail            │ Unsigned images must be  │
│ enforcement        │                 │ blocked                  │
└────────────────────┴─────────────────┴──────────────────────────┘
```

## Protecting the Webhook System Namespace

Any webhook with `failurePolicy: Fail` must exclude the webhook's own namespace from the scope rules, or exclude it via `namespaceSelector`. Otherwise, the webhook itself cannot start because the API server tries to call the webhook to admit the webhook pod — creating a deadlock.

```yaml
# Safe namespaceSelector pattern for Fail policy webhooks
spec:
  webhooks:
    - name: validate.myresource.my-org.io
      failurePolicy: Fail
      namespaceSelector:
        matchExpressions:
          # Exclude the webhook's own namespace unconditionally
          - key: kubernetes.io/metadata.name
            operator: NotIn
            values:
              - my-webhook-system
          # Exclude system namespaces
          - key: kubernetes.io/metadata.name
            operator: NotIn
            values:
              - kube-system
              - kube-public
              - kube-node-lease
```

```bash
# Label namespaces that should bypass the webhook
kubectl label namespace kube-system webhook.my-org.io/skip=true
kubectl label namespace my-webhook-system webhook.my-org.io/skip=true

# Use the label in the namespaceSelector instead of hardcoding names
# This is more maintainable in large clusters
```

## PodDisruptionBudget for High-Availability Webhooks

```yaml
# webhook-pdb.yaml
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: my-webhook-pdb
  namespace: my-webhook-system
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: my-webhook
```

# Certificate Rotation Procedures

## Automatic Rotation with cert-manager

cert-manager handles rotation automatically when the certificate approaches the `renewBefore` threshold. The rotation sequence is:

1. cert-manager issues a new certificate to a temporary secret
2. The new certificate is written to the existing secret (atomic update)
3. The cainjector detects the secret change and updates the `caBundle` field
4. The running webhook pods reload the certificate from the updated secret volume mount

For step 4 to work without pod restarts, the webhook server must support hot-reloading of TLS certificates. Many frameworks support this; the following Go pattern shows the standard approach.

```go
// tls-reloader.go - Hot-reloading TLS certificate server
package main

import (
	"crypto/tls"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// CertReloader watches a certificate directory and hot-reloads
// the TLS certificate when files change.
type CertReloader struct {
	mu       sync.RWMutex
	certPath string
	keyPath  string
	cert     *tls.Certificate
}

func NewCertReloader(certPath, keyPath string) (*CertReloader, error) {
	r := &CertReloader{
		certPath: certPath,
		keyPath:  keyPath,
	}
	if err := r.reload(); err != nil {
		return nil, fmt.Errorf("initial cert load failed: %w", err)
	}
	return r, nil
}

func (r *CertReloader) reload() error {
	cert, err := tls.LoadX509KeyPair(r.certPath, r.keyPath)
	if err != nil {
		return fmt.Errorf("loading key pair: %w", err)
	}
	r.mu.Lock()
	r.cert = &cert
	r.mu.Unlock()
	log.Printf("TLS certificate reloaded from %s", r.certPath)
	return nil
}

// GetCertificate implements the tls.Config.GetCertificate callback.
// The API server calls this on every TLS handshake.
func (r *CertReloader) GetCertificate(_ *tls.ClientHelloInfo) (*tls.Certificate, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.cert, nil
}

// WatchAndReload starts a file watcher that reloads the certificate
// whenever tls.crt or tls.key changes on disk.
func (r *CertReloader) WatchAndReload() error {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return fmt.Errorf("creating watcher: %w", err)
	}

	if err := watcher.Add(r.certPath); err != nil {
		return fmt.Errorf("watching cert: %w", err)
	}
	if err := watcher.Add(r.keyPath); err != nil {
		return fmt.Errorf("watching key: %w", err)
	}

	go func() {
		for {
			select {
			case event, ok := <-watcher.Events:
				if !ok {
					return
				}
				if event.Has(fsnotify.Write) || event.Has(fsnotify.Create) {
					// Brief delay to allow atomic write to complete
					time.Sleep(100 * time.Millisecond)
					if err := r.reload(); err != nil {
						log.Printf("ERROR: cert reload failed: %v", err)
					}
				}
			case err, ok := <-watcher.Errors:
				if !ok {
					return
				}
				log.Printf("ERROR: watcher error: %v", err)
			}
		}
	}()
	return nil
}

func main() {
	reloader, err := NewCertReloader("/etc/tls/tls.crt", "/etc/tls/tls.key")
	if err != nil {
		log.Fatalf("cert reloader init: %v", err)
	}
	if err := reloader.WatchAndReload(); err != nil {
		log.Fatalf("cert watcher: %v", err)
	}

	tlsConfig := &tls.Config{
		GetCertificate: reloader.GetCertificate,
		MinVersion:     tls.VersionTLS13,
	}

	server := &http.Server{
		Addr:      ":8443",
		TLSConfig: tlsConfig,
	}

	log.Printf("Starting webhook server on :8443")
	// The empty strings tell ListenAndServeTLS to use GetCertificate instead
	if err := server.ListenAndServeTLS("", ""); err != nil {
		log.Fatalf("server: %v", err)
	}
}
```

## Manual Emergency Certificate Rotation

When cert-manager is not available or a certificate has already expired, manual rotation is required.

```bash
#!/bin/bash
# manual-cert-rotation.sh - Emergency manual certificate rotation

set -euo pipefail

NAMESPACE="my-webhook-system"
SECRET_NAME="my-webhook-tls-secret"
WEBHOOK_SERVICE="my-webhook"
CERT_DIR=$(mktemp -d)

echo "=== Emergency Webhook Certificate Rotation ==="
echo "Temporary cert directory: ${CERT_DIR}"

# Step 1: Generate a new CA
openssl genrsa -out "${CERT_DIR}/ca.key" 4096
openssl req -new -x509 -days 3650 \
  -key "${CERT_DIR}/ca.key" \
  -out "${CERT_DIR}/ca.crt" \
  -subj "/CN=webhook-ca/O=my-org"

# Step 2: Generate the webhook server private key
openssl genrsa -out "${CERT_DIR}/tls.key" 4096

# Step 3: Create CSR config with proper SANs
cat > "${CERT_DIR}/csr.conf" <<EOF
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
DNS.1 = ${WEBHOOK_SERVICE}.${NAMESPACE}.svc
DNS.2 = ${WEBHOOK_SERVICE}.${NAMESPACE}.svc.cluster.local
EOF

# Step 4: Generate CSR
openssl req -new \
  -key "${CERT_DIR}/tls.key" \
  -out "${CERT_DIR}/tls.csr" \
  -subj "/CN=${WEBHOOK_SERVICE}.${NAMESPACE}.svc" \
  -config "${CERT_DIR}/csr.conf"

# Step 5: Sign the certificate with the CA
openssl x509 -req -days 365 \
  -in "${CERT_DIR}/tls.csr" \
  -CA "${CERT_DIR}/ca.crt" \
  -CAkey "${CERT_DIR}/ca.key" \
  -CAcreateserial \
  -out "${CERT_DIR}/tls.crt" \
  -extensions v3_req \
  -extfile "${CERT_DIR}/csr.conf"

# Step 6: Verify the certificate
echo "=== Certificate Details ==="
openssl x509 -noout -text -in "${CERT_DIR}/tls.crt" | grep -A 5 "Subject Alternative Name"
openssl verify -CAfile "${CERT_DIR}/ca.crt" "${CERT_DIR}/tls.crt"

# Step 7: Update the Kubernetes secret
kubectl -n "${NAMESPACE}" create secret tls "${SECRET_NAME}" \
  --cert="${CERT_DIR}/tls.crt" \
  --key="${CERT_DIR}/tls.key" \
  --dry-run=client -o yaml | \
  kubectl -n "${NAMESPACE}" apply -f -

# Also store the CA cert in the secret for caBundle updates
CA_DATA=$(base64 -w 0 < "${CERT_DIR}/ca.crt")
kubectl -n "${NAMESPACE}" patch secret "${SECRET_NAME}" \
  --type='json' \
  -p="[{\"op\":\"add\",\"path\":\"/data/ca.crt\",\"value\":\"${CA_DATA}\"}]"

# Step 8: Update caBundle in webhook configurations
echo "=== Updating WebhookConfiguration caBundle ==="
kubectl patch validatingwebhookconfiguration my-validating-webhook \
  --type='json' \
  -p="[{\"op\":\"replace\",\"path\":\"/webhooks/0/clientConfig/caBundle\",\"value\":\"${CA_DATA}\"}]"

kubectl patch mutatingwebhookconfiguration my-mutating-webhook \
  --type='json' \
  -p="[{\"op\":\"replace\",\"path\":\"/webhooks/0/clientConfig/caBundle\",\"value\":\"${CA_DATA}\"}]"

# Step 9: Restart webhook pods to pick up new cert if hot-reload is not supported
echo "=== Restarting webhook deployment ==="
kubectl -n "${NAMESPACE}" rollout restart deployment/my-webhook
kubectl -n "${NAMESPACE}" rollout status deployment/my-webhook

# Cleanup
rm -rf "${CERT_DIR}"
echo "=== Certificate rotation complete ==="
```

# Testing Webhook TLS

## Verifying TLS Connectivity from Inside the Cluster

```bash
# Deploy a debug pod to test TLS from the cluster network
kubectl run tls-test --image=alpine/openssl --rm -it --restart=Never -- \
  openssl s_client -connect my-webhook.my-webhook-system.svc:443 \
  -servername my-webhook.my-webhook-system.svc \
  -verify_return_error \
  </dev/null 2>&1 | head -30

# Test with the specific CA from the webhook configuration
kubectl -n my-webhook-system get secret my-webhook-tls-secret \
  -o jsonpath='{.data.ca\.crt}' | base64 -d > /tmp/webhook-ca.crt

kubectl run tls-verify --image=alpine/openssl --rm -it --restart=Never \
  --overrides='{"spec":{"volumes":[{"name":"ca","configMap":{"name":"webhook-ca"}}],"containers":[{"name":"tls-verify","image":"alpine/openssl","command":["sleep","3600"],"volumeMounts":[{"name":"ca","mountPath":"/etc/ca"}]}]}}' -- \
  openssl s_client \
  -connect my-webhook.my-webhook-system.svc:443 \
  -CAfile /etc/ca/ca.crt \
  -verify_return_error \
  </dev/null

# Check certificate expiry
kubectl run cert-check --image=alpine/openssl --rm -it --restart=Never -- \
  sh -c "echo | openssl s_client -connect my-webhook.my-webhook-system.svc:443 2>/dev/null | openssl x509 -noout -dates"
```

## Sending a Test AdmissionReview Request

```bash
# Create a test AdmissionReview payload
cat > /tmp/test-admission-review.json <<'EOF'
{
  "apiVersion": "admission.k8s.io/v1",
  "kind": "AdmissionReview",
  "request": {
    "uid": "705ab4f5-6393-11e8-b7cc-42010a800002",
    "kind": {
      "group": "apps",
      "version": "v1",
      "kind": "Deployment"
    },
    "resource": {
      "group": "apps",
      "version": "v1",
      "resource": "deployments"
    },
    "namespace": "default",
    "operation": "CREATE",
    "object": {
      "apiVersion": "apps/v1",
      "kind": "Deployment",
      "metadata": {
        "name": "test-deployment",
        "namespace": "default"
      },
      "spec": {
        "replicas": 1,
        "selector": {
          "matchLabels": {"app": "test"}
        },
        "template": {
          "metadata": {"labels": {"app": "test"}},
          "spec": {
            "containers": [
              {"name": "test", "image": "nginx:latest"}
            ]
          }
        }
      }
    }
  }
}
EOF

# Send test request from a pod that can reach the webhook service
kubectl run webhook-test --image=curlimages/curl --rm -it --restart=Never -- \
  curl -sk --cacert /dev/null \
  -X POST \
  -H "Content-Type: application/json" \
  -d @/tmp/test-admission-review.json \
  https://my-webhook.my-webhook-system.svc/validate
```

## Integration Testing with a Real API Server Request

```bash
# The most reliable test: create a resource that triggers the webhook
# and observe whether validation/mutation occurred

# For a validating webhook - test with an invalid resource
kubectl create deployment test-invalid --image=invalid:latest --dry-run=server 2>&1

# For a mutating webhook - check if mutations were applied
kubectl create deployment test-mutation --image=nginx:latest --dry-run=server \
  -o yaml | grep -A 5 "annotations:"

# Watch webhook server logs during API call
kubectl -n my-webhook-system logs -l app=my-webhook --follow &
kubectl create deployment test-live --image=nginx:latest
kill %1
```

# Diagnosing Certificate Errors

## Identifying the Root Cause from API Server Errors

When a webhook TLS error occurs, the API server returns an error message that appears in `kubectl` output and in the API server audit logs. The error messages follow predictable patterns.

```bash
# Error: x509: certificate signed by unknown authority
# Cause: caBundle in WebhookConfiguration does not match the CA that signed tls.crt
# Fix: Update caBundle to match the CA that signed the current server certificate

# Error: x509: certificate has expired or is not yet valid
# Cause: tls.crt in the webhook server's secret has expired
# Fix: Rotate the certificate and restart pods

# Error: x509: certificate is valid for my-webhook.default.svc,
#        not my-webhook.production.svc
# Cause: Certificate SAN does not match the service name/namespace
# Fix: Re-issue the certificate with the correct SAN

# Check API server logs for webhook errors (on managed clusters, use audit logs)
kubectl -n kube-system logs kube-apiserver-<node-name> 2>/dev/null | \
  grep -i "webhook\|certificate\|tls" | tail -20
```

## Systematic Diagnosis Script

```bash
#!/bin/bash
# diagnose-webhook-tls.sh - Systematic webhook TLS diagnosis

NAMESPACE="${1:-my-webhook-system}"
WEBHOOK_NAME="${2:-my-validating-webhook}"
SECRET_NAME="${3:-my-webhook-tls-secret}"

echo "=== Webhook TLS Diagnosis: ${WEBHOOK_NAME} ==="
echo ""

echo "--- 1. Certificate Expiry Check ---"
kubectl -n "${NAMESPACE}" get secret "${SECRET_NAME}" \
  -o jsonpath='{.data.tls\.crt}' 2>/dev/null | base64 -d | \
  openssl x509 -noout -dates -subject 2>/dev/null || echo "FAIL: Cannot read secret"

echo ""
echo "--- 2. SAN Entries in Leaf Certificate ---"
kubectl -n "${NAMESPACE}" get secret "${SECRET_NAME}" \
  -o jsonpath='{.data.tls\.crt}' 2>/dev/null | base64 -d | \
  openssl x509 -noout -ext subjectAltName 2>/dev/null || echo "FAIL: Cannot decode cert"

echo ""
echo "--- 3. caBundle in WebhookConfiguration ---"
CABUNDLE=$(kubectl get validatingwebhookconfiguration "${WEBHOOK_NAME}" \
  -o jsonpath='{.webhooks[0].clientConfig.caBundle}' 2>/dev/null)
if [ -z "${CABUNDLE}" ]; then
  echo "WARNING: caBundle is empty - webhook will fail TLS verification"
else
  echo "${CABUNDLE}" | base64 -d | openssl x509 -noout -dates -subject 2>/dev/null
fi

echo ""
echo "--- 4. CA Bundle vs Secret CA Comparison ---"
SECRET_CA=$(kubectl -n "${NAMESPACE}" get secret "${SECRET_NAME}" \
  -o jsonpath='{.data.ca\.crt}' 2>/dev/null | base64 -d | \
  openssl x509 -noout -fingerprint -sha256 2>/dev/null)
WEBHOOK_CA=$(echo "${CABUNDLE}" | base64 -d 2>/dev/null | \
  openssl x509 -noout -fingerprint -sha256 2>/dev/null)

if [ "${SECRET_CA}" = "${WEBHOOK_CA}" ]; then
  echo "OK: CA in secret matches caBundle in webhook configuration"
else
  echo "MISMATCH: CAs differ"
  echo "  Secret CA:  ${SECRET_CA}"
  echo "  Webhook CA: ${WEBHOOK_CA}"
fi

echo ""
echo "--- 5. Webhook Pod TLS Status ---"
WEBHOOK_ENDPOINT=$(kubectl -n "${NAMESPACE}" get service my-webhook \
  -o jsonpath='{.spec.clusterIP}' 2>/dev/null)
if [ -n "${WEBHOOK_ENDPOINT}" ]; then
  echo "Service ClusterIP: ${WEBHOOK_ENDPOINT}"
  kubectl -n "${NAMESPACE}" get pods -l app=my-webhook \
    -o custom-columns="NAME:.metadata.name,READY:.status.containerStatuses[0].ready,RESTARTS:.status.containerStatuses[0].restartCount"
else
  echo "WARNING: Cannot find webhook service"
fi

echo ""
echo "--- 6. cert-manager Certificate Status ---"
kubectl -n "${NAMESPACE}" get certificate -o wide 2>/dev/null || \
  echo "No cert-manager certificates found in namespace ${NAMESPACE}"

echo ""
echo "--- 7. Recent Webhook Events ---"
kubectl -n "${NAMESPACE}" get events --sort-by='.lastTimestamp' \
  --field-selector reason=Failed 2>/dev/null | tail -10
```

## Handling the Deadlock: Webhook Blocks Its Own Pod

The most catastrophic TLS failure scenario occurs when a `failurePolicy: Fail` webhook loses its certificate while also intercepting pod creation in its own namespace. No new pods can start because the API server cannot reach the webhook, and the webhook cannot start because its pod creation is being blocked.

```bash
# Emergency recovery: temporarily disable the failing webhook
# This is a break-glass procedure - document and reverse immediately after fix

# Option 1: Delete the webhook configuration entirely
kubectl delete validatingwebhookconfiguration my-validating-webhook
# Fix the certificate, then re-apply the webhook configuration

# Option 2: Patch failurePolicy to Ignore temporarily
kubectl patch validatingwebhookconfiguration my-validating-webhook \
  --type='json' \
  -p='[{"op":"replace","path":"/webhooks/0/failurePolicy","value":"Ignore"}]'

# Fix the certificate and pods, then restore failurePolicy to Fail
kubectl patch validatingwebhookconfiguration my-validating-webhook \
  --type='json' \
  -p='[{"op":"replace","path":"/webhooks/0/failurePolicy","value":"Fail"}]'

# Option 3: Remove the namespace exclusion temporarily to exclude webhook NS
kubectl patch validatingwebhookconfiguration my-validating-webhook \
  --type='json' \
  -p='[{"op":"add","path":"/webhooks/0/namespaceSelector/matchExpressions/-","value":{"key":"kubernetes.io/metadata.name","operator":"In","values":["my-webhook-system"]}}]'
```

# mTLS Patterns for High-Security Environments

## Configuring mTLS Between API Server and Webhook

While standard webhook TLS authenticates the server to the client (API server), mutual TLS additionally authenticates the API server to the webhook server. This prevents unauthorized callers from hitting the webhook endpoint.

```go
// mtls-webhook-server.go - mTLS webhook server skeleton
package main

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"log"
	"net/http"
	"os"
)

func buildMTLSConfig(certFile, keyFile, caFile string) (*tls.Config, error) {
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("loading server cert: %w", err)
	}

	caData, err := os.ReadFile(caFile)
	if err != nil {
		return nil, fmt.Errorf("reading CA: %w", err)
	}

	clientCAs := x509.NewCertPool()
	if !clientCAs.AppendCertsFromPEM(caData) {
		return nil, fmt.Errorf("parsing CA cert")
	}

	return &tls.Config{
		Certificates: []tls.Certificate{cert},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    clientCAs,
		MinVersion:   tls.VersionTLS13,
	}, nil
}

func main() {
	tlsConfig, err := buildMTLSConfig(
		"/etc/tls/tls.crt",
		"/etc/tls/tls.key",
		"/etc/tls/client-ca.crt",
	)
	if err != nil {
		log.Fatalf("TLS config: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/validate", handleValidate)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	server := &http.Server{
		Addr:      ":8443",
		Handler:   mux,
		TLSConfig: tlsConfig,
	}

	log.Println("Starting mTLS webhook server on :8443")
	if err := server.ListenAndServeTLS("", ""); err != nil {
		log.Fatalf("server: %v", err)
	}
}

func handleValidate(w http.ResponseWriter, r *http.Request) {
	// Verify the client certificate subject to ensure it's the API server
	if len(r.TLS.PeerCertificates) == 0 {
		http.Error(w, "client cert required", http.StatusUnauthorized)
		return
	}
	clientCN := r.TLS.PeerCertificates[0].Subject.CommonName
	log.Printf("Admitted request from CN: %s", clientCN)
	// Handle admission review...
}
```

# Monitoring and Alerting for Certificate Health

## Prometheus Metrics for Certificate Expiry

```yaml
# cert-expiry-alerts.yaml
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: webhook-cert-alerts
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
    - name: webhook-certificate-health
      interval: 1m
      rules:
        # Alert when cert expires within 30 days
        - alert: WebhookCertificateExpiringSoon
          expr: |
            (x509_cert_not_after{secret_namespace="my-webhook-system",secret_name="my-webhook-tls-secret"}
            - time()) / 86400 < 30
          for: 1h
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "Webhook certificate expiring soon"
            description: "Certificate in {{ $labels.secret_namespace }}/{{ $labels.secret_name }} expires in {{ $value | humanizeDuration }}"
            runbook_url: "https://wiki.my-org.io/runbooks/webhook-cert-rotation"

        # Alert when cert expires within 7 days
        - alert: WebhookCertificateExpiringCritical
          expr: |
            (x509_cert_not_after{secret_namespace="my-webhook-system",secret_name="my-webhook-tls-secret"}
            - time()) / 86400 < 7
          for: 30m
          labels:
            severity: critical
            team: platform
          annotations:
            summary: "Webhook certificate expiring CRITICALLY SOON"
            description: "Certificate expires in {{ $value | humanizeDuration }} - immediate action required"

        # Alert when cert-manager fails to renew
        - alert: CertManagerCertificateNotReady
          expr: |
            certmanager_certificate_ready_status{
              namespace="my-webhook-system",
              name="my-webhook-tls"
            } == 0
          for: 15m
          labels:
            severity: critical
          annotations:
            summary: "cert-manager certificate not ready"
            description: "Certificate {{ $labels.namespace }}/{{ $labels.name }} is not Ready"
```

```bash
# Install the x509-certificate-exporter to scrape cert expiry from secrets
helm repo add enix https://charts.enix.io
helm install x509-certificate-exporter enix/x509-certificate-exporter \
  --namespace monitoring \
  --set secretsExporter.enabled=true \
  --set-json 'secretsExporter.watchedSecrets=[{"namespace":"my-webhook-system","name":"my-webhook-tls-secret"}]'
```

# Hardening Checklist

## Production Readiness Checklist

```
Webhook Server
  [ ] Certificate SANs include <service>.<namespace>.svc and .svc.cluster.local
  [ ] Certificate duration <= 1 year with renewBefore >= 30 days
  [ ] Hot-reload implemented (avoid forced pod restarts on renewal)
  [ ] Webhook pods have PodDisruptionBudget with minAvailable: 1
  [ ] Webhook pods spread across zones with topologySpreadConstraints
  [ ] Resource limits set on webhook containers
  [ ] securityContext: runAsNonRoot, readOnlyRootFilesystem, drop ALL caps
  [ ] Health endpoints (/healthz, /readyz) implemented

WebhookConfiguration
  [ ] caBundle populated and matches the CA in the TLS secret
  [ ] namespaceSelector excludes webhook's own namespace
  [ ] namespaceSelector excludes kube-system, kube-public, kube-node-lease
  [ ] failurePolicy: Fail only for security-critical webhooks
  [ ] timeoutSeconds set to <= 10 (API server default max is 30)
  [ ] sideEffects: None or NoneOnDryRun declared

cert-manager Integration
  [ ] ClusterIssuer created and Ready
  [ ] Certificate resource shows READY=True
  [ ] cainjector annotation present on WebhookConfiguration
  [ ] Renewal tested in non-production before production

Monitoring
  [ ] x509-certificate-exporter or equivalent installed
  [ ] Alert for expiry < 30 days (warning)
  [ ] Alert for expiry < 7 days (critical)
  [ ] cert-manager certificate Ready status monitored
```

Admission webhook TLS management is one of the highest-impact operational concerns in a production Kubernetes cluster. Automated certificate rotation through cert-manager's cainjector eliminates the entire class of manual rotation errors. Combined with hot-reload on the webhook server, proper failure policy design, and namespace exclusions, a well-configured webhook can provide years of uninterrupted operation while remaining transparent to cluster users.
