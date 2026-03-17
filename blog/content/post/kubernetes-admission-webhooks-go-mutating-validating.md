---
title: "Kubernetes Admission Webhooks in Go: Building Mutating and Validating Webhooks"
date: 2028-12-30T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Go", "Admission Webhooks", "Security", "Policy Enforcement"]
categories:
- Kubernetes
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to building production-grade mutating and validating admission webhooks in Go, covering TLS bootstrap, webhook logic, testing strategies, and deployment patterns for enterprise Kubernetes clusters."
more_link: "yes"
url: "/kubernetes-admission-webhooks-go-mutating-validating/"
---

Admission webhooks represent one of the most powerful extension points in Kubernetes. They intercept API server requests before objects are persisted, enabling enforcement of custom policies, automatic injection of sidecar containers, and default value population at cluster scale. Building reliable webhooks in Go requires understanding the full lifecycle: TLS certificate management, webhook registration, request decoding, patch generation, and graceful failure handling.

This guide walks through the complete implementation of both mutating and validating admission webhooks using Go, with production patterns suitable for multi-tenant enterprise clusters.

<!--more-->

## Admission Webhook Architecture

The Kubernetes API server calls admission webhooks synchronously during the admission chain. Two webhook types serve distinct purposes:

- **MutatingAdmissionWebhook**: Called first, allows modification of the object before persistence. Multiple mutating webhooks are called sequentially, and each sees the object as modified by all prior webhooks.
- **ValidatingAdmissionWebhook**: Called after all mutations are complete. These webhooks cannot modify objects but can reject requests based on the final state.

The API server sends an `AdmissionReview` object to the webhook over HTTPS and expects a corresponding `AdmissionReview` response containing an `AdmissionResponse`.

### Request Flow

```
kubectl apply → API Server → Authentication → Authorization
  → MutatingAdmissionWebhooks (sequential)
  → Object validation
  → ValidatingAdmissionWebhooks (parallel)
  → etcd persistence
```

Understanding that mutating webhooks run sequentially while validating webhooks run in parallel has significant implications for ordering dependencies and performance.

## Project Structure

A production webhook server is organized to separate concerns cleanly:

```
webhook-server/
├── cmd/
│   └── webhook/
│       └── main.go
├── internal/
│   ├── admission/
│   │   ├── handler.go
│   │   ├── mutating.go
│   │   └── validating.go
│   ├── cert/
│   │   └── manager.go
│   └── config/
│       └── config.go
├── deploy/
│   ├── webhook-deployment.yaml
│   ├── webhook-service.yaml
│   ├── mutatingwebhookconfiguration.yaml
│   └── validatingwebhookconfiguration.yaml
├── Dockerfile
└── go.mod
```

## TLS Certificate Management

Every admission webhook must serve over TLS. The API server validates the webhook's certificate against the `caBundle` configured in the `MutatingWebhookConfiguration` or `ValidatingWebhookConfiguration`. There are two approaches:

1. **cert-manager integration**: cert-manager injects the CA bundle automatically via the `cert-manager.io/inject-ca-from` annotation.
2. **Self-signed bootstrap**: Generate a self-signed CA at startup and patch the webhook configuration.

### cert-manager Approach (Recommended)

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: admission-webhook-cert
  namespace: webhook-system
spec:
  secretName: admission-webhook-tls
  dnsNames:
    - admission-webhook.webhook-system.svc
    - admission-webhook.webhook-system.svc.cluster.local
  issuerRef:
    name: cluster-ca-issuer
    kind: ClusterIssuer
  duration: 8760h
  renewBefore: 720h
---
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: enterprise-mutating-webhook
  annotations:
    cert-manager.io/inject-ca-from: webhook-system/admission-webhook-cert
spec:
  webhooks:
    - name: pod-defaults.webhook-system.svc
      admissionReviewVersions: ["v1", "v1beta1"]
      clientConfig:
        service:
          name: admission-webhook
          namespace: webhook-system
          path: "/mutate-pods"
          port: 8443
      rules:
        - operations: ["CREATE"]
          apiGroups: [""]
          apiVersions: ["v1"]
          resources: ["pods"]
      failurePolicy: Fail
      sideEffects: None
      namespaceSelector:
        matchExpressions:
          - key: admission-webhook/enabled
            operator: In
            values: ["true"]
```

### Self-Signed Bootstrap in Go

For environments without cert-manager, generate certificates at startup:

```go
package cert

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"time"

	admissionv1 "k8s.io/api/admissionregistration/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

type Manager struct {
	client    kubernetes.Interface
	namespace string
	service   string
}

func NewManager(client kubernetes.Interface, namespace, service string) *Manager {
	return &Manager{
		client:    client,
		namespace: namespace,
		service:   service,
	}
}

func (m *Manager) GenerateAndInject(ctx context.Context, webhookName string) ([]byte, []byte, error) {
	caKey, _ := rsa.GenerateKey(rand.Reader, 4096)
	serverKey, _ := rsa.GenerateKey(rand.Reader, 4096)

	caTemplate := &x509.Certificate{
		SerialNumber:          big.NewInt(2024),
		Subject:               pkix.Name{CommonName: "webhook-ca"},
		NotBefore:             time.Now(),
		NotAfter:              time.Now().Add(10 * 365 * 24 * time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
	}
	caDER, _ := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	caCert, _ := x509.ParseCertificate(caDER)

	serverTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(2025),
		Subject: pkix.Name{
			CommonName: m.service + "." + m.namespace + ".svc",
		},
		DNSNames: []string{
			m.service,
			m.service + "." + m.namespace,
			m.service + "." + m.namespace + ".svc",
			m.service + "." + m.namespace + ".svc.cluster.local",
		},
		NotBefore: time.Now(),
		NotAfter:  time.Now().Add(365 * 24 * time.Hour),
		KeyUsage:  x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{
			x509.ExtKeyUsageServerAuth,
		},
	}
	serverDER, _ := x509.CreateCertificate(rand.Reader, serverTemplate, caCert, &serverKey.PublicKey, caKey)

	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: serverDER})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(serverKey)})
	caPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})

	// Patch the MutatingWebhookConfiguration with the CA bundle
	webhook, err := m.client.AdmissionregistrationV1().MutatingWebhookConfigurations().Get(
		ctx, webhookName, metav1.GetOptions{},
	)
	if err != nil {
		return nil, nil, err
	}
	for i := range webhook.Webhooks {
		webhook.Webhooks[i].ClientConfig.CABundle = caPEM
	}
	_, err = m.client.AdmissionregistrationV1().MutatingWebhookConfigurations().Update(
		ctx, webhook, metav1.UpdateOptions{},
	)
	if err != nil {
		return nil, nil, err
	}

	_ = admissionv1.MutatingWebhook{} // ensure import is used
	return certPEM, keyPEM, nil
}
```

## HTTP Server and Handler Setup

The webhook server handles multiple paths, each corresponding to a specific webhook:

```go
package main

import (
	"context"
	"crypto/tls"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/example/webhook-server/internal/admission"
	"github.com/example/webhook-server/internal/cert"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	restConfig, err := rest.InClusterConfig()
	if err != nil {
		logger.Error("failed to get in-cluster config", "error", err)
		os.Exit(1)
	}
	client, err := kubernetes.NewForConfig(restConfig)
	if err != nil {
		logger.Error("failed to create kubernetes client", "error", err)
		os.Exit(1)
	}

	certManager := cert.NewManager(client, "webhook-system", "admission-webhook")
	certPEM, keyPEM, err := certManager.GenerateAndInject(context.Background(), "enterprise-mutating-webhook")
	if err != nil {
		logger.Error("failed to generate certificates", "error", err)
		os.Exit(1)
	}

	tlsCert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		logger.Error("failed to load TLS certificate", "error", err)
		os.Exit(1)
	}

	mux := http.NewServeMux()
	mux.Handle("/mutate-pods", admission.NewMutatingHandler(logger))
	mux.Handle("/validate-pods", admission.NewValidatingHandler(logger))
	mux.Handle("/healthz", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	server := &http.Server{
		Addr:    ":8443",
		Handler: mux,
		TLSConfig: &tls.Config{
			Certificates: []tls.Certificate{tlsCert},
			MinVersion:   tls.VersionTLS13,
		},
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		logger.Info("starting webhook server", "addr", ":8443")
		if err := server.ListenAndServeTLS("", ""); err != nil && err != http.ErrServerClosed {
			logger.Error("server error", "error", err)
			os.Exit(1)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
	<-quit

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		logger.Error("graceful shutdown failed", "error", err)
	}
	logger.Info("server stopped")
}
```

## Admission Request Handling

The core handler decodes the `AdmissionReview`, dispatches to business logic, and encodes the response:

```go
package admission

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"

	admissionv1 "k8s.io/api/admission/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/serializer"
)

var (
	scheme = runtime.NewScheme()
	codecs = serializer.NewCodecFactory(scheme)
)

func init() {
	_ = admissionv1.AddToScheme(scheme)
}

type handler struct {
	logger  *slog.Logger
	handler func(*admissionv1.AdmissionRequest) (*admissionv1.AdmissionResponse, error)
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if ct := r.Header.Get("Content-Type"); ct != "application/json" {
		http.Error(w, "unsupported content type", http.StatusUnsupportedMediaType)
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // 1 MB limit
	if err != nil {
		h.logger.Error("failed to read request body", "error", err)
		http.Error(w, "failed to read body", http.StatusBadRequest)
		return
	}

	review := &admissionv1.AdmissionReview{}
	if _, _, err := codecs.UniversalDeserializer().Decode(body, nil, review); err != nil {
		h.logger.Error("failed to decode admission review", "error", err)
		http.Error(w, "failed to decode", http.StatusBadRequest)
		return
	}

	response, err := h.handler(review.Request)
	if err != nil {
		h.logger.Error("admission handler error",
			"uid", review.Request.UID,
			"resource", review.Request.Resource.Resource,
			"name", review.Request.Name,
			"namespace", review.Request.Namespace,
			"error", err,
		)
		response = &admissionv1.AdmissionResponse{
			UID:     review.Request.UID,
			Allowed: false,
			Result: &metav1.Status{
				Message: fmt.Sprintf("internal webhook error: %v", err),
				Code:    500,
			},
		}
	}
	response.UID = review.Request.UID

	h.logger.Info("admission decision",
		"uid", review.Request.UID,
		"resource", review.Request.Resource.Resource,
		"name", review.Request.Name,
		"namespace", review.Request.Namespace,
		"allowed", response.Allowed,
	)

	reviewResponse := &admissionv1.AdmissionReview{
		TypeMeta: metav1.TypeMeta{
			APIVersion: "admission.k8s.io/v1",
			Kind:       "AdmissionReview",
		},
		Response: response,
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(reviewResponse); err != nil {
		h.logger.Error("failed to encode response", "error", err)
	}
}
```

## Mutating Webhook: Pod Defaults Injection

A common use case injects default resource requests, security contexts, and labels into pods:

```go
package admission

import (
	"encoding/json"
	"log/slog"
	"net/http"

	admissionv1 "k8s.io/api/admission/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
)

// JSONPatch represents a single RFC 6902 JSON Patch operation.
type JSONPatch struct {
	Op    string      `json:"op"`
	Path  string      `json:"path"`
	Value interface{} `json:"value,omitempty"`
}

func NewMutatingHandler(logger *slog.Logger) http.Handler {
	h := &handler{
		logger: logger,
	}
	h.handler = mutatePods
	return h
}

func mutatePods(req *admissionv1.AdmissionRequest) (*admissionv1.AdmissionResponse, error) {
	pod := &corev1.Pod{}
	if err := json.Unmarshal(req.Object.Raw, pod); err != nil {
		return nil, fmt.Errorf("failed to unmarshal pod: %w", err)
	}

	var patches []JSONPatch

	// Inject default resource requests for containers that have none
	for i, container := range pod.Spec.Containers {
		if container.Resources.Requests == nil {
			patches = append(patches, JSONPatch{
				Op:   "add",
				Path: fmt.Sprintf("/spec/containers/%d/resources/requests", i),
				Value: map[string]string{
					"cpu":    "50m",
					"memory": "64Mi",
				},
			})
		}
		if container.Resources.Limits == nil {
			patches = append(patches, JSONPatch{
				Op:   "add",
				Path: fmt.Sprintf("/spec/containers/%d/resources/limits", i),
				Value: map[string]string{
					"cpu":    "500m",
					"memory": "512Mi",
				},
			})
		}
		_ = resource.MustParse("50m") // import validation
	}

	// Inject security context defaults
	if pod.Spec.SecurityContext == nil {
		runAsNonRoot := true
		runAsUser := int64(65534)
		patches = append(patches,
			JSONPatch{
				Op:    "add",
				Path:  "/spec/securityContext",
				Value: map[string]interface{}{},
			},
			JSONPatch{
				Op:    "add",
				Path:  "/spec/securityContext/runAsNonRoot",
				Value: runAsNonRoot,
			},
			JSONPatch{
				Op:    "add",
				Path:  "/spec/securityContext/runAsUser",
				Value: runAsUser,
			},
		)
	}

	// Add team label from namespace annotation if missing
	if pod.Labels == nil {
		patches = append(patches, JSONPatch{
			Op:    "add",
			Path:  "/metadata/labels",
			Value: map[string]string{},
		})
	}
	if _, ok := pod.Labels["app.kubernetes.io/managed-by"]; !ok {
		patches = append(patches, JSONPatch{
			Op:    "add",
			Path:  "/metadata/labels/app.kubernetes.io~1managed-by",
			Value: "enterprise-webhook",
		})
	}

	if len(patches) == 0 {
		return &admissionv1.AdmissionResponse{Allowed: true}, nil
	}

	patchBytes, err := json.Marshal(patches)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal patches: %w", err)
	}

	patchType := admissionv1.PatchTypeJSONPatch
	return &admissionv1.AdmissionResponse{
		Allowed:   true,
		Patch:     patchBytes,
		PatchType: &patchType,
	}, nil
}
```

### JSON Patch Path Escaping

A critical detail: JSON Patch paths use `/` as a separator. To reference label or annotation keys containing `/`, escape them as `~1`. The tilde character itself is escaped as `~0`. For example, the label key `app.kubernetes.io/name` becomes `/metadata/labels/app.kubernetes.io~1name` in a patch path.

## Validating Webhook: Resource Policy Enforcement

Validating webhooks enforce policies that cannot be expressed with standard Kubernetes admission controls:

```go
package admission

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	admissionv1 "k8s.io/api/admission/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func NewValidatingHandler(logger *slog.Logger) http.Handler {
	h := &handler{
		logger: logger,
	}
	h.handler = validatePods
	return h
}

func validatePods(req *admissionv1.AdmissionRequest) (*admissionv1.AdmissionResponse, error) {
	pod := &corev1.Pod{}
	if err := json.Unmarshal(req.Object.Raw, pod); err != nil {
		return nil, fmt.Errorf("failed to unmarshal pod: %w", err)
	}

	var violations []string

	// Enforce: all containers must have resource limits
	for _, container := range pod.Spec.Containers {
		if container.Resources.Limits == nil {
			violations = append(violations,
				fmt.Sprintf("container %q must define resource limits", container.Name))
		}
	}

	// Enforce: disallow privileged containers
	for _, container := range pod.Spec.Containers {
		if container.SecurityContext != nil &&
			container.SecurityContext.Privileged != nil &&
			*container.SecurityContext.Privileged {
			violations = append(violations,
				fmt.Sprintf("container %q must not run as privileged", container.Name))
		}
	}

	// Enforce: disallow hostPath volumes
	for _, volume := range pod.Spec.Volumes {
		if volume.HostPath != nil {
			violations = append(violations,
				fmt.Sprintf("volume %q uses hostPath which is not permitted", volume.Name))
		}
	}

	// Enforce: disallow latest image tag
	for _, container := range pod.Spec.Containers {
		if strings.HasSuffix(container.Image, ":latest") || !strings.Contains(container.Image, ":") {
			violations = append(violations,
				fmt.Sprintf("container %q must not use the :latest image tag", container.Name))
		}
	}

	// Enforce: required labels
	requiredLabels := []string{"app.kubernetes.io/name", "app.kubernetes.io/version"}
	for _, label := range requiredLabels {
		if _, ok := pod.Labels[label]; !ok {
			violations = append(violations,
				fmt.Sprintf("pod must have label %q", label))
		}
	}

	if len(violations) > 0 {
		return &admissionv1.AdmissionResponse{
			Allowed: false,
			Result: &metav1.Status{
				Code:    403,
				Message: fmt.Sprintf("policy violations:\n- %s", strings.Join(violations, "\n- ")),
			},
		}, nil
	}

	return &admissionv1.AdmissionResponse{Allowed: true}, nil
}
```

## Webhook Configuration and Failure Policy

The choice of `failurePolicy` determines behavior when the webhook is unreachable:

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: enterprise-validating-webhook
  annotations:
    cert-manager.io/inject-ca-from: webhook-system/admission-webhook-cert
spec:
  webhooks:
    - name: validate-pods.webhook-system.svc
      admissionReviewVersions: ["v1"]
      clientConfig:
        service:
          name: admission-webhook
          namespace: webhook-system
          path: "/validate-pods"
          port: 8443
        timeoutSeconds: 10
      rules:
        - operations: ["CREATE", "UPDATE"]
          apiGroups: [""]
          apiVersions: ["v1"]
          resources: ["pods"]
          scope: "Namespaced"
      failurePolicy: Fail
      matchPolicy: Equivalent
      sideEffects: None
      namespaceSelector:
        matchExpressions:
          - key: kubernetes.io/metadata.name
            operator: NotIn
            values:
              - kube-system
              - kube-public
              - cert-manager
              - webhook-system
      objectSelector:
        matchExpressions:
          - key: admission-webhook/skip
            operator: DoesNotExist
```

### Failure Policy Considerations

- **`failurePolicy: Fail`**: Rejects requests when the webhook is unavailable. Use for security-critical enforcement. Requires high webhook availability (target 99.99% uptime).
- **`failurePolicy: Ignore`**: Allows requests to proceed if the webhook times out or returns an error. Use for non-critical defaults injection.

For production clusters, run at minimum 3 webhook replicas with pod anti-affinity across availability zones. Set `timeoutSeconds` to 10-15 seconds to avoid blocking the API server.

## Testing Webhooks

### Unit Testing with Fake Requests

```go
package admission_test

import (
	"encoding/json"
	"testing"

	admissionv1 "k8s.io/api/admission/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"

	"github.com/example/webhook-server/internal/admission"
)

func TestValidatePods_NoResourceLimits(t *testing.T) {
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "test-pod",
			Namespace: "production",
			Labels: map[string]string{
				"app.kubernetes.io/name":    "myapp",
				"app.kubernetes.io/version": "1.2.3",
			},
		},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{
				{
					Name:  "app",
					Image: "myapp:1.2.3",
					// Resources intentionally omitted
				},
			},
		},
	}

	raw, _ := json.Marshal(pod)
	req := &admissionv1.AdmissionRequest{
		UID:       "test-uid-001",
		Operation: admissionv1.Create,
		Resource: metav1.GroupVersionResource{
			Group: "", Version: "v1", Resource: "pods",
		},
		Object: runtime.RawExtension{Raw: raw},
	}

	// Access the internal validatePods function through the exported handler
	// In practice, expose validatePods as a package-level function for testing
	resp, err := admission.ValidatePodsRequest(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Allowed {
		t.Error("expected request to be denied due to missing resource limits")
	}
	if resp.Result == nil || resp.Result.Code != 403 {
		t.Errorf("expected status code 403, got: %v", resp.Result)
	}
}
```

### Integration Testing with envtest

The `controller-runtime` `envtest` package provides a real API server and etcd for integration testing without a full cluster:

```bash
# Install envtest binaries
go install sigs.k8s.io/controller-runtime/tools/setup-envtest@latest
setup-envtest use 1.30.0

# Run integration tests
KUBEBUILDER_ASSETS=$(setup-envtest use 1.30.0 --bin-path /usr/local/kubebuilder/bin -p path) \
  go test ./... -v -timeout 120s
```

## Deployment Manifests

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: admission-webhook
  namespace: webhook-system
spec:
  replicas: 3
  selector:
    matchLabels:
      app: admission-webhook
  template:
    metadata:
      labels:
        app: admission-webhook
    spec:
      serviceAccountName: admission-webhook
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: admission-webhook
              topologyKey: topology.kubernetes.io/zone
      containers:
        - name: webhook
          image: registry.example.com/admission-webhook:1.4.2
          ports:
            - name: https
              containerPort: 8443
          volumeMounts:
            - name: tls
              mountPath: /tls
              readOnly: true
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8443
              scheme: HTTPS
            initialDelaySeconds: 10
            periodSeconds: 15
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8443
              scheme: HTTPS
            initialDelaySeconds: 5
            periodSeconds: 10
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 500m
              memory: 256Mi
          securityContext:
            runAsNonRoot: true
            runAsUser: 65534
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
      volumes:
        - name: tls
          secret:
            secretName: admission-webhook-tls
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: admission-webhook
```

## RBAC for the Webhook Server

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: admission-webhook
  namespace: webhook-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: admission-webhook
rules:
  - apiGroups: ["admissionregistration.k8s.io"]
    resources: ["mutatingwebhookconfigurations", "validatingwebhookconfigurations"]
    verbs: ["get", "update", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: admission-webhook
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: admission-webhook
subjects:
  - kind: ServiceAccount
    name: admission-webhook
    namespace: webhook-system
```

## Performance and Observability

Instrument the webhook with Prometheus metrics to track latency and error rates:

```go
package admission

import (
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	webhookRequestDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "admission_webhook_request_duration_seconds",
			Help:    "Duration of admission webhook processing",
			Buckets: prometheus.DefBuckets,
		},
		[]string{"webhook", "operation", "resource", "allowed"},
	)

	webhookRequestTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "admission_webhook_requests_total",
			Help: "Total number of admission webhook requests",
		},
		[]string{"webhook", "operation", "resource", "allowed"},
	)
)

func instrumentedHandler(name string, fn func(*admissionv1.AdmissionRequest) (*admissionv1.AdmissionResponse, error)) func(*admissionv1.AdmissionRequest) (*admissionv1.AdmissionResponse, error) {
	return func(req *admissionv1.AdmissionRequest) (*admissionv1.AdmissionResponse, error) {
		start := time.Now()
		resp, err := fn(req)
		duration := time.Since(start).Seconds()

		allowed := "true"
		if err != nil || (resp != nil && !resp.Allowed) {
			allowed = "false"
		}

		labels := prometheus.Labels{
			"webhook":   name,
			"operation": string(req.Operation),
			"resource":  req.Resource.Resource,
			"allowed":   allowed,
		}
		webhookRequestDuration.With(labels).Observe(duration)
		webhookRequestTotal.With(labels).Inc()

		return resp, err
	}
}
```

## Common Pitfalls

**Infinite mutation loops**: If a mutating webhook modifies a resource and the webhook configuration matches the same update operation, it can trigger an infinite loop. Use `objectSelector` to exclude objects already processed by the webhook, or limit rules to `CREATE` only.

**Namespace exclusion**: Always exclude `kube-system`, `cert-manager`, and the webhook's own namespace from the `namespaceSelector`. Failing to do so can cause chicken-and-egg failures during cluster bootstrap and cert-manager certificate issuance.

**Timeout tuning**: The default API server webhook timeout is 10 seconds. Complex webhook logic that calls external APIs or databases can easily exceed this. Cache external data using informers or a local store rather than making live API calls per request.

**Dry-run handling**: Webhooks receive requests with `dryRun: true` set in the request object when kubectl applies with `--dry-run=server`. Webhooks with `sideEffects: None` are called during dry runs. Webhooks marked `sideEffects: NoneOnDryRun` or `sideEffects: Unknown` are skipped. Declare side effects accurately to enable dry-run validation.

## Summary

Building admission webhooks in Go involves careful attention to TLS management, JSON Patch path encoding, failure policy selection, and performance instrumentation. The patterns in this guide provide a foundation for enterprise-grade webhook implementations that handle edge cases gracefully, support high request volumes, and remain observable through standard Prometheus metrics.

Key takeaways:
- Use cert-manager for certificate lifecycle management in production
- Run 3+ replicas with pod anti-affinity to ensure high availability
- Exclude system namespaces to prevent bootstrap failures
- Instrument all webhook handlers with latency and error metrics
- Test with envtest for realistic integration coverage without a full cluster
