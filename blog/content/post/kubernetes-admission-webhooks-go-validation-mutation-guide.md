---
title: "Kubernetes Admission Webhooks in Go: Building Custom Validation and Mutation"
date: 2031-01-10T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Go", "Admission Webhooks", "controller-runtime", "Security", "TLS"]
categories:
- Kubernetes
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to building production-ready ValidatingAdmissionWebhook and MutatingAdmissionWebhook servers in Go using controller-runtime, including TLS management, idempotent mutations, envtest testing, and deployment patterns."
more_link: "yes"
url: "/kubernetes-admission-webhooks-go-validation-mutation-guide/"
---

Admission webhooks are the primary extension point for enforcing organizational policy in Kubernetes. Whether you need to reject resources that violate naming conventions, inject sidecar containers, or default missing labels before objects reach etcd, admission webhooks give you a synchronous intercept point in the API server's request path. This guide walks through building production-quality ValidatingAdmissionWebhook and MutatingAdmissionWebhook servers in Go using controller-runtime, covering TLS certificate lifecycle management, idempotent mutation design, comprehensive testing with envtest, and zero-downtime deployment strategies.

<!--more-->

# Kubernetes Admission Webhooks in Go: Building Custom Validation and Mutation

## Section 1: Admission Webhook Architecture

Kubernetes admission control runs in two phases. The first phase consists of mutating admission webhooks, which can modify the incoming object. The second phase is validating admission webhooks, which can only accept or reject. Both phases run in parallel across all registered webhooks within their respective phase.

```
API Request
    |
    v
Authentication & Authorization
    |
    v
MutatingAdmissionWebhooks (parallel)
    |
    v
Object Schema Validation
    |
    v
ValidatingAdmissionWebhooks (parallel)
    |
    v
Persisted to etcd
```

The API server sends an `AdmissionReview` object (JSON) to your webhook's HTTPS endpoint. Your webhook responds with an `AdmissionReview` containing an `AdmissionResponse`. The response contains an `allowed` boolean and, for mutating webhooks, a base64-encoded JSON Patch.

### When to Use Each Type

Use `MutatingAdmissionWebhook` when you need to:
- Inject sidecar containers or init containers
- Add default labels, annotations, or environment variables
- Set resource requests/limits when absent
- Rewrite image references to use an internal registry

Use `ValidatingAdmissionWebhook` when you need to:
- Enforce naming conventions
- Require specific labels or annotations
- Block privileged containers
- Validate custom resource field constraints beyond CEL expressions

Use both together when you want to set sensible defaults (mutating) while also ensuring mandatory fields are present after defaulting (validating).

## Section 2: Project Structure

```
webhook-server/
├── cmd/
│   └── webhook/
│       └── main.go
├── pkg/
│   ├── webhook/
│   │   ├── pod_validator.go
│   │   ├── pod_mutator.go
│   │   ├── deployment_validator.go
│   │   └── handler.go
│   └── certs/
│       └── manager.go
├── config/
│   ├── webhook/
│   │   ├── manifests.yaml
│   │   └── service.yaml
│   └── rbac/
│       └── role.yaml
├── test/
│   └── integration/
│       └── webhook_test.go
├── go.mod
└── Dockerfile
```

### go.mod Dependencies

```go
module github.com/example/webhook-server

go 1.22

require (
    k8s.io/api v0.30.0
    k8s.io/apimachinery v0.30.0
    k8s.io/client-go v0.30.0
    sigs.k8s.io/controller-runtime v0.18.0
    sigs.k8s.io/controller-tools v0.15.0
    go.uber.org/zap v1.27.0
)
```

## Section 3: The Webhook Handler Core

The `handler.go` file sets up the HTTP server and routes webhook endpoints. Controller-runtime provides a `webhook.Admission` type that handles the AdmissionReview serialization, but understanding the raw handler helps when you need to debug.

```go
// pkg/webhook/handler.go
package webhook

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	admissionv1 "k8s.io/api/admission/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/serializer"
	"go.uber.org/zap"
)

var (
	runtimeScheme = runtime.NewScheme()
	codecs        = serializer.NewCodecFactory(runtimeScheme)
	deserializer  = codecs.UniversalDeserializer()
)

// AdmissionHandler is a function signature for webhook handlers.
type AdmissionHandler func(ctx context.Context, req admissionv1.AdmissionRequest) admissionv1.AdmissionResponse

// ServeAdmission wraps an AdmissionHandler into an http.HandlerFunc.
func ServeAdmission(logger *zap.Logger, handler AdmissionHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			logger.Error("failed to read request body", zap.Error(err))
			http.Error(w, "failed to read body", http.StatusBadRequest)
			return
		}

		contentType := r.Header.Get("Content-Type")
		if contentType != "application/json" {
			logger.Error("invalid content type", zap.String("content-type", contentType))
			http.Error(w, "invalid content-type, expected application/json", http.StatusUnsupportedMediaType)
			return
		}

		var admissionReviewReq admissionv1.AdmissionReview
		if _, _, err := deserializer.Decode(body, nil, &admissionReviewReq); err != nil {
			logger.Error("failed to decode admission review", zap.Error(err))
			http.Error(w, fmt.Sprintf("failed to decode: %v", err), http.StatusBadRequest)
			return
		}

		if admissionReviewReq.Request == nil {
			logger.Error("admission review request is nil")
			http.Error(w, "admission review request is nil", http.StatusBadRequest)
			return
		}

		resp := handler(r.Context(), *admissionReviewReq.Request)
		resp.UID = admissionReviewReq.Request.UID

		admissionReviewResp := admissionv1.AdmissionReview{
			TypeMeta: metav1.TypeMeta{
				APIVersion: "admission.k8s.io/v1",
				Kind:       "AdmissionReview",
			},
			Response: &resp,
		}

		respBytes, err := json.Marshal(admissionReviewResp)
		if err != nil {
			logger.Error("failed to marshal response", zap.Error(err))
			http.Error(w, fmt.Sprintf("failed to marshal response: %v", err), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		if _, err := w.Write(respBytes); err != nil {
			logger.Error("failed to write response", zap.Error(err))
		}

		logger.Info("admission review handled",
			zap.String("uid", string(resp.UID)),
			zap.String("kind", admissionReviewReq.Request.Kind.Kind),
			zap.String("name", admissionReviewReq.Request.Name),
			zap.String("namespace", admissionReviewReq.Request.Namespace),
			zap.Bool("allowed", resp.Allowed),
		)
	}
}

// AllowedResponse returns a simple allowed response.
func AllowedResponse(uid types.UID) admissionv1.AdmissionResponse {
	return admissionv1.AdmissionResponse{
		UID:     uid,
		Allowed: true,
	}
}

// DeniedResponse returns a rejection response with a message.
func DeniedResponse(uid types.UID, code int32, msg string) admissionv1.AdmissionResponse {
	return admissionv1.AdmissionResponse{
		UID:     uid,
		Allowed: false,
		Result: &metav1.Status{
			Code:    code,
			Message: msg,
		},
	}
}
```

## Section 4: Building the Pod Validator

The validating webhook enforces a set of organizational policies on Pod creation and updates. The key principle: return clear, actionable error messages.

```go
// pkg/webhook/pod_validator.go
package webhook

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	admissionv1 "k8s.io/api/admission/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"go.uber.org/zap"
)

// PodValidationConfig holds policy settings.
type PodValidationConfig struct {
	RequiredLabels          []string
	MaxContainerCount       int
	AllowPrivileged         bool
	AllowHostNetwork        bool
	AllowHostPID            bool
	RequireResourceRequests bool
	AllowedRegistries       []string
}

// PodValidator validates pods against organizational policy.
type PodValidator struct {
	logger *zap.Logger
	config PodValidationConfig
}

// NewPodValidator creates a new PodValidator.
func NewPodValidator(logger *zap.Logger, config PodValidationConfig) *PodValidator {
	return &PodValidator{
		logger: logger,
		config: config,
	}
}

// Handle processes an AdmissionRequest for a Pod.
func (v *PodValidator) Handle(ctx context.Context, req admissionv1.AdmissionRequest) admissionv1.AdmissionResponse {
	// Only handle Pod create and update operations
	if req.Kind.Kind != "Pod" {
		return admissionv1.AdmissionResponse{Allowed: true}
	}

	if req.Operation != admissionv1.Create && req.Operation != admissionv1.Update {
		return admissionv1.AdmissionResponse{Allowed: true}
	}

	var pod corev1.Pod
	if err := json.Unmarshal(req.Object.Raw, &pod); err != nil {
		v.logger.Error("failed to unmarshal pod", zap.Error(err))
		return admissionv1.AdmissionResponse{
			Allowed: false,
			Result: &metav1.Status{
				Code:    400,
				Message: fmt.Sprintf("failed to unmarshal pod: %v", err),
			},
		}
	}

	var violations []string

	// Check required labels
	for _, label := range v.config.RequiredLabels {
		if _, ok := pod.Labels[label]; !ok {
			violations = append(violations, fmt.Sprintf("missing required label %q", label))
		}
	}

	// Check container count
	totalContainers := len(pod.Spec.Containers) + len(pod.Spec.InitContainers)
	if v.config.MaxContainerCount > 0 && totalContainers > v.config.MaxContainerCount {
		violations = append(violations,
			fmt.Sprintf("pod has %d containers (max: %d)", totalContainers, v.config.MaxContainerCount))
	}

	// Check privileged containers
	if !v.config.AllowPrivileged {
		for _, c := range pod.Spec.Containers {
			if c.SecurityContext != nil && c.SecurityContext.Privileged != nil && *c.SecurityContext.Privileged {
				violations = append(violations,
					fmt.Sprintf("container %q is privileged (not allowed)", c.Name))
			}
		}
	}

	// Check host network
	if !v.config.AllowHostNetwork && pod.Spec.HostNetwork {
		violations = append(violations, "hostNetwork is not allowed")
	}

	// Check hostPID
	if !v.config.AllowHostPID && pod.Spec.HostPID {
		violations = append(violations, "hostPID is not allowed")
	}

	// Check resource requests
	if v.config.RequireResourceRequests {
		for _, c := range pod.Spec.Containers {
			if c.Resources.Requests == nil || len(c.Resources.Requests) == 0 {
				violations = append(violations,
					fmt.Sprintf("container %q has no resource requests", c.Name))
			} else {
				if _, hasCPU := c.Resources.Requests[corev1.ResourceCPU]; !hasCPU {
					violations = append(violations,
						fmt.Sprintf("container %q missing CPU request", c.Name))
				}
				if _, hasMem := c.Resources.Requests[corev1.ResourceMemory]; !hasMem {
					violations = append(violations,
						fmt.Sprintf("container %q missing memory request", c.Name))
				}
			}
		}
	}

	// Check allowed registries
	if len(v.config.AllowedRegistries) > 0 {
		for _, c := range append(pod.Spec.Containers, pod.Spec.InitContainers...) {
			if !v.isImageAllowed(c.Image) {
				violations = append(violations,
					fmt.Sprintf("container %q uses disallowed registry in image %q", c.Name, c.Image))
			}
		}
	}

	if len(violations) > 0 {
		v.logger.Warn("pod validation failed",
			zap.String("pod", pod.Name),
			zap.String("namespace", pod.Namespace),
			zap.Strings("violations", violations),
		)
		return admissionv1.AdmissionResponse{
			Allowed: false,
			Result: &metav1.Status{
				Code:    403,
				Message: fmt.Sprintf("pod violates policy:\n- %s", strings.Join(violations, "\n- ")),
			},
		}
	}

	return admissionv1.AdmissionResponse{Allowed: true}
}

// isImageAllowed checks if an image's registry is in the allowed list.
func (v *PodValidator) isImageAllowed(image string) bool {
	for _, registry := range v.config.AllowedRegistries {
		if strings.HasPrefix(image, registry) {
			return true
		}
	}
	return false
}
```

## Section 5: Building the Pod Mutator

The mutating webhook must be idempotent: applying the mutation twice must produce the same result as applying it once. This is critical because the API server may retry requests.

```go
// pkg/webhook/pod_mutator.go
package webhook

import (
	"context"
	"encoding/json"
	"fmt"

	admissionv1 "k8s.io/api/admission/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"go.uber.org/zap"
)

// JSONPatch represents a single RFC6902 JSON Patch operation.
type JSONPatch struct {
	Op    string      `json:"op"`
	Path  string      `json:"path"`
	Value interface{} `json:"value,omitempty"`
}

// PodMutatorConfig holds mutation settings.
type PodMutatorConfig struct {
	DefaultCPURequest    string
	DefaultMemoryRequest string
	DefaultCPULimit      string
	DefaultMemoryLimit   string
	InjectedLabels       map[string]string
	InjectedAnnotations  map[string]string
	SidecarImage         string
	SidecarName          string
}

// PodMutator applies default values and injects sidecars.
type PodMutator struct {
	logger *zap.Logger
	config PodMutatorConfig
}

// NewPodMutator creates a new PodMutator.
func NewPodMutator(logger *zap.Logger, config PodMutatorConfig) *PodMutator {
	return &PodMutator{
		logger: logger,
		config: config,
	}
}

// Handle processes an AdmissionRequest for a Pod.
func (m *PodMutator) Handle(ctx context.Context, req admissionv1.AdmissionRequest) admissionv1.AdmissionResponse {
	if req.Kind.Kind != "Pod" {
		return admissionv1.AdmissionResponse{Allowed: true}
	}

	if req.Operation != admissionv1.Create {
		// Mutations are typically only applied on create to avoid
		// continuously re-patching objects on every update.
		return admissionv1.AdmissionResponse{Allowed: true}
	}

	var pod corev1.Pod
	if err := json.Unmarshal(req.Object.Raw, &pod); err != nil {
		m.logger.Error("failed to unmarshal pod", zap.Error(err))
		return admissionv1.AdmissionResponse{
			Allowed: false,
			Result: &metav1.Status{
				Code:    400,
				Message: fmt.Sprintf("failed to unmarshal pod: %v", err),
			},
		}
	}

	var patches []JSONPatch

	// Initialize maps if nil to avoid null pointer patches
	if pod.Labels == nil {
		patches = append(patches, JSONPatch{
			Op:    "add",
			Path:  "/metadata/labels",
			Value: map[string]string{},
		})
		pod.Labels = map[string]string{}
	}

	if pod.Annotations == nil {
		patches = append(patches, JSONPatch{
			Op:    "add",
			Path:  "/metadata/annotations",
			Value: map[string]string{},
		})
		pod.Annotations = map[string]string{}
	}

	// Inject labels (idempotent: only add if not present)
	for k, v := range m.config.InjectedLabels {
		if _, exists := pod.Labels[k]; !exists {
			patches = append(patches, JSONPatch{
				Op:    "add",
				Path:  fmt.Sprintf("/metadata/labels/%s", jsonPatchEscape(k)),
				Value: v,
			})
		}
	}

	// Inject annotations
	for k, v := range m.config.InjectedAnnotations {
		if _, exists := pod.Annotations[k]; !exists {
			patches = append(patches, JSONPatch{
				Op:    "add",
				Path:  fmt.Sprintf("/metadata/annotations/%s", jsonPatchEscape(k)),
				Value: v,
			})
		}
	}

	// Apply default resources to containers
	for i, c := range pod.Spec.Containers {
		containerPatches := m.defaultResourcePatches(i, "containers", c)
		patches = append(patches, containerPatches...)
	}

	for i, c := range pod.Spec.InitContainers {
		containerPatches := m.defaultResourcePatches(i, "initContainers", c)
		patches = append(patches, containerPatches...)
	}

	// Inject sidecar (idempotent: check if already present by name)
	if m.config.SidecarName != "" && m.config.SidecarImage != "" {
		if !m.hasSidecar(pod) {
			sidecar := corev1.Container{
				Name:  m.config.SidecarName,
				Image: m.config.SidecarImage,
				Resources: corev1.ResourceRequirements{
					Requests: corev1.ResourceList{
						corev1.ResourceCPU:    resource.MustParse("50m"),
						corev1.ResourceMemory: resource.MustParse("64Mi"),
					},
					Limits: corev1.ResourceList{
						corev1.ResourceCPU:    resource.MustParse("100m"),
						corev1.ResourceMemory: resource.MustParse("128Mi"),
					},
				},
			}
			patches = append(patches, JSONPatch{
				Op:    "add",
				Path:  "/spec/containers/-",
				Value: sidecar,
			})
		}
	}

	if len(patches) == 0 {
		return admissionv1.AdmissionResponse{Allowed: true}
	}

	patchBytes, err := json.Marshal(patches)
	if err != nil {
		m.logger.Error("failed to marshal patches", zap.Error(err))
		return admissionv1.AdmissionResponse{
			Allowed: false,
			Result: &metav1.Status{
				Code:    500,
				Message: fmt.Sprintf("failed to marshal patches: %v", err),
			},
		}
	}

	m.logger.Info("mutating pod",
		zap.String("pod", pod.Name),
		zap.String("namespace", pod.Namespace),
		zap.Int("patch_count", len(patches)),
	)

	patchType := admissionv1.PatchTypeJSONPatch
	return admissionv1.AdmissionResponse{
		Allowed:   true,
		Patch:     patchBytes,
		PatchType: &patchType,
	}
}

// defaultResourcePatches returns patches to set default resource requests/limits.
func (m *PodMutator) defaultResourcePatches(idx int, containerType string, c corev1.Container) []JSONPatch {
	var patches []JSONPatch
	basePath := fmt.Sprintf("/spec/%s/%d/resources", containerType, idx)

	if c.Resources.Requests == nil {
		patches = append(patches, JSONPatch{
			Op:    "add",
			Path:  basePath + "/requests",
			Value: map[string]interface{}{},
		})
	}
	if c.Resources.Limits == nil {
		patches = append(patches, JSONPatch{
			Op:    "add",
			Path:  basePath + "/limits",
			Value: map[string]interface{}{},
		})
	}

	if _, hasCPU := c.Resources.Requests[corev1.ResourceCPU]; !hasCPU && m.config.DefaultCPURequest != "" {
		patches = append(patches, JSONPatch{
			Op:    "add",
			Path:  basePath + "/requests/cpu",
			Value: m.config.DefaultCPURequest,
		})
	}

	if _, hasMem := c.Resources.Requests[corev1.ResourceMemory]; !hasMem && m.config.DefaultMemoryRequest != "" {
		patches = append(patches, JSONPatch{
			Op:    "add",
			Path:  basePath + "/requests/memory",
			Value: m.config.DefaultMemoryRequest,
		})
	}

	if _, hasCPULim := c.Resources.Limits[corev1.ResourceCPU]; !hasCPULim && m.config.DefaultCPULimit != "" {
		patches = append(patches, JSONPatch{
			Op:    "add",
			Path:  basePath + "/limits/cpu",
			Value: m.config.DefaultCPULimit,
		})
	}

	if _, hasMemLim := c.Resources.Limits[corev1.ResourceMemory]; !hasMemLim && m.config.DefaultMemoryLimit != "" {
		patches = append(patches, JSONPatch{
			Op:    "add",
			Path:  basePath + "/limits/memory",
			Value: m.config.DefaultMemoryLimit,
		})
	}

	return patches
}

// hasSidecar checks if the sidecar is already injected.
func (m *PodMutator) hasSidecar(pod corev1.Pod) bool {
	for _, c := range pod.Spec.Containers {
		if c.Name == m.config.SidecarName {
			return true
		}
	}
	return false
}

// jsonPatchEscape escapes a key for use in a JSON Patch path.
// RFC 6901: '~' -> '~0', '/' -> '~1'
func jsonPatchEscape(s string) string {
	s = strings.ReplaceAll(s, "~", "~0")
	s = strings.ReplaceAll(s, "/", "~1")
	return s
}
```

## Section 6: TLS Certificate Management

Webhooks require TLS. The API server must trust the certificate presented by your webhook server. There are three approaches: cert-manager, self-signed via `controller-runtime`'s certificate rotation, or a custom certificate manager.

```go
// pkg/certs/manager.go
package certs

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"os"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"go.uber.org/zap"
)

// CertificateManager manages TLS certificates for the webhook server.
type CertificateManager struct {
	logger        *zap.Logger
	client        kubernetes.Interface
	namespace     string
	secretName    string
	serviceName   string
	certDir       string
	renewBefore   time.Duration
}

// NewCertificateManager creates a new CertificateManager.
func NewCertificateManager(
	logger *zap.Logger,
	client kubernetes.Interface,
	namespace, secretName, serviceName, certDir string,
) *CertificateManager {
	return &CertificateManager{
		logger:      logger,
		client:      client,
		namespace:   namespace,
		secretName:  secretName,
		serviceName: serviceName,
		certDir:     certDir,
		renewBefore: 30 * 24 * time.Hour, // Renew 30 days before expiry
	}
}

// EnsureCertificates ensures valid TLS certificates exist and writes them to certDir.
// Returns the CA bundle for updating webhook configurations.
func (m *CertificateManager) EnsureCertificates(ctx context.Context) (caBundle []byte, err error) {
	secret, err := m.client.CoreV1().Secrets(m.namespace).Get(ctx, m.secretName, metav1.GetOptions{})
	if errors.IsNotFound(err) {
		return m.generateAndStore(ctx)
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get certificate secret: %w", err)
	}

	// Check if certificates are still valid
	if m.isCertificateValid(secret) {
		return m.writeCertificates(secret)
	}

	m.logger.Info("certificate needs renewal", zap.String("secret", m.secretName))
	return m.generateAndStore(ctx)
}

// generateAndStore generates new certificates and stores them in a Secret.
func (m *CertificateManager) generateAndStore(ctx context.Context) ([]byte, error) {
	ca, caKey, err := m.generateCA()
	if err != nil {
		return nil, fmt.Errorf("failed to generate CA: %w", err)
	}

	cert, key, err := m.generateServingCert(ca, caKey)
	if err != nil {
		return nil, fmt.Errorf("failed to generate serving cert: %w", err)
	}

	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      m.secretName,
			Namespace: m.namespace,
		},
		Type: corev1.SecretTypeTLS,
		Data: map[string][]byte{
			"tls.crt": cert,
			"tls.key": key,
			"ca.crt":  ca,
		},
	}

	existing, err := m.client.CoreV1().Secrets(m.namespace).Get(ctx, m.secretName, metav1.GetOptions{})
	if errors.IsNotFound(err) {
		_, err = m.client.CoreV1().Secrets(m.namespace).Create(ctx, secret, metav1.CreateOptions{})
	} else if err == nil {
		existing.Data = secret.Data
		_, err = m.client.CoreV1().Secrets(m.namespace).Update(ctx, existing, metav1.UpdateOptions{})
	}
	if err != nil {
		return nil, fmt.Errorf("failed to store certificate secret: %w", err)
	}

	if _, err := m.writeCertFiles(cert, key); err != nil {
		return nil, err
	}

	return ca, nil
}

// generateCA generates a self-signed CA certificate.
func (m *CertificateManager) generateCA() ([]byte, *rsa.PrivateKey, error) {
	caKey, err := rsa.GenerateKey(rand.Reader, 4096)
	if err != nil {
		return nil, nil, err
	}

	caTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject: pkix.Name{
			Organization: []string{"webhook-server"},
			CommonName:   "webhook-server-ca",
		},
		NotBefore:             time.Now(),
		NotAfter:              time.Now().Add(10 * 365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}

	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		return nil, nil, err
	}

	var caBundle bytes.Buffer
	if err := pem.Encode(&caBundle, &pem.Block{Type: "CERTIFICATE", Bytes: caDER}); err != nil {
		return nil, nil, err
	}

	return caBundle.Bytes(), caKey, nil
}

// generateServingCert generates a TLS serving certificate signed by the CA.
func (m *CertificateManager) generateServingCert(caPEM []byte, caKey *rsa.PrivateKey) ([]byte, []byte, error) {
	caBlock, _ := pem.Decode(caPEM)
	if caBlock == nil {
		return nil, nil, fmt.Errorf("failed to decode CA PEM")
	}
	caCert, err := x509.ParseCertificate(caBlock.Bytes)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to parse CA cert: %w", err)
	}

	servingKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, nil, err
	}

	dnsNames := []string{
		m.serviceName,
		fmt.Sprintf("%s.%s", m.serviceName, m.namespace),
		fmt.Sprintf("%s.%s.svc", m.serviceName, m.namespace),
		fmt.Sprintf("%s.%s.svc.cluster.local", m.serviceName, m.namespace),
	}

	template := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject: pkix.Name{
			Organization: []string{"webhook-server"},
			CommonName:   dnsNames[2],
		},
		DNSNames:    dnsNames,
		NotBefore:   time.Now(),
		NotAfter:    time.Now().Add(365 * 24 * time.Hour),
		KeyUsage:    x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}

	certDER, err := x509.CreateCertificate(rand.Reader, template, caCert, &servingKey.PublicKey, caKey)
	if err != nil {
		return nil, nil, err
	}

	var certBuf bytes.Buffer
	if err := pem.Encode(&certBuf, &pem.Block{Type: "CERTIFICATE", Bytes: certDER}); err != nil {
		return nil, nil, err
	}

	var keyBuf bytes.Buffer
	if err := pem.Encode(&keyBuf, &pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(servingKey)}); err != nil {
		return nil, nil, err
	}

	return certBuf.Bytes(), keyBuf.Bytes(), nil
}

// isCertificateValid checks if the certificate in the secret is still valid.
func (m *CertificateManager) isCertificateValid(secret *corev1.Secret) bool {
	certPEM, ok := secret.Data["tls.crt"]
	if !ok {
		return false
	}
	block, _ := pem.Decode(certPEM)
	if block == nil {
		return false
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return false
	}
	return time.Now().Add(m.renewBefore).Before(cert.NotAfter)
}

// writeCertificates extracts and writes certificates from a Secret.
func (m *CertificateManager) writeCertificates(secret *corev1.Secret) ([]byte, error) {
	cert := secret.Data["tls.crt"]
	key := secret.Data["tls.key"]
	if _, err := m.writeCertFiles(cert, key); err != nil {
		return nil, err
	}
	return secret.Data["ca.crt"], nil
}

// writeCertFiles writes cert and key to the configured cert directory.
func (m *CertificateManager) writeCertFiles(cert, key []byte) (string, error) {
	if err := os.MkdirAll(m.certDir, 0755); err != nil {
		return "", fmt.Errorf("failed to create cert dir: %w", err)
	}
	certPath := m.certDir + "/tls.crt"
	keyPath := m.certDir + "/tls.key"
	if err := os.WriteFile(certPath, cert, 0644); err != nil {
		return "", fmt.Errorf("failed to write cert: %w", err)
	}
	if err := os.WriteFile(keyPath, key, 0600); err != nil {
		return "", fmt.Errorf("failed to write key: %w", err)
	}
	return certPath, nil
}
```

## Section 7: Main Entry Point with controller-runtime

```go
// cmd/webhook/main.go
package main

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"go.uber.org/zap"
	"k8s.io/client-go/kubernetes"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"

	"github.com/example/webhook-server/pkg/certs"
	"github.com/example/webhook-server/pkg/webhook"
)

func main() {
	var (
		port        = flag.Int("port", 8443, "HTTPS port")
		certDir     = flag.String("cert-dir", "/tmp/webhook-certs", "Certificate directory")
		namespace   = flag.String("namespace", "webhook-system", "Namespace for secrets")
		serviceName = flag.String("service-name", "webhook-server", "Service name for certificate DNS SANs")
	)
	flag.Parse()

	logger, _ := zap.NewProduction()
	defer logger.Sync()

	config, err := ctrl.GetConfig()
	if err != nil {
		logger.Fatal("failed to get kubeconfig", zap.Error(err))
	}

	k8sClient, err := kubernetes.NewForConfig(config)
	if err != nil {
		logger.Fatal("failed to create kubernetes client", zap.Error(err))
	}

	// Manage TLS certificates
	certMgr := certs.NewCertificateManager(
		logger, k8sClient, *namespace, "webhook-tls", *serviceName, *certDir,
	)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	_, err = certMgr.EnsureCertificates(ctx)
	cancel()
	if err != nil {
		logger.Fatal("failed to ensure certificates", zap.Error(err))
	}

	// Set up validators and mutators
	validatorConfig := webhook.PodValidationConfig{
		RequiredLabels:          []string{"app", "version", "team"},
		MaxContainerCount:       10,
		AllowPrivileged:         false,
		AllowHostNetwork:        false,
		RequireResourceRequests: true,
		AllowedRegistries:       []string{"registry.example.com/", "gcr.io/distroless/"},
	}

	mutatorConfig := webhook.PodMutatorConfig{
		DefaultCPURequest:    "100m",
		DefaultMemoryRequest: "128Mi",
		DefaultCPULimit:      "500m",
		DefaultMemoryLimit:   "512Mi",
		InjectedLabels:       map[string]string{"injected-by": "webhook"},
		InjectedAnnotations:  map[string]string{"webhook.example.com/mutated": "true"},
		SidecarImage:         "registry.example.com/audit-sidecar:latest",
		SidecarName:          "audit-sidecar",
	}

	podValidator := webhook.NewPodValidator(logger, validatorConfig)
	podMutator := webhook.NewPodMutator(logger, mutatorConfig)

	mux := http.NewServeMux()
	mux.HandleFunc("/validate/pods", webhook.ServeAdmission(logger, podValidator.Handle))
	mux.HandleFunc("/mutate/pods", webhook.ServeAdmission(logger, podMutator.Handle))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

	server := &http.Server{
		Addr:         fmt.Sprintf(":%d", *port),
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	go func() {
		logger.Info("starting webhook server", zap.Int("port", *port))
		if err := server.ListenAndServeTLS(*certDir+"/tls.crt", *certDir+"/tls.key"); err != nil && err != http.ErrServerClosed {
			logger.Fatal("server failed", zap.Error(err))
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	ctx, cancel = context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		logger.Error("graceful shutdown failed", zap.Error(err))
	}
	logger.Info("webhook server stopped")
}
```

## Section 8: Kubernetes Manifests

```yaml
# config/webhook/manifests.yaml
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: pod-mutator
  annotations:
    # cert-manager injects the caBundle automatically when this annotation is present
    cert-manager.io/inject-ca-from: webhook-system/webhook-tls
webhooks:
  - name: pod-mutator.webhook.example.com
    admissionReviewVersions: ["v1"]
    sideEffects: None
    failurePolicy: Fail
    # Use Ignore during initial rollout, switch to Fail once stable
    # failurePolicy: Ignore
    timeoutSeconds: 10
    matchPolicy: Equivalent
    namespaceSelector:
      matchLabels:
        webhook.example.com/inject: "true"
    rules:
      - apiGroups:   [""]
        apiVersions: ["v1"]
        resources:   ["pods"]
        operations:  ["CREATE"]
    clientConfig:
      service:
        name: webhook-server
        namespace: webhook-system
        path: /mutate/pods
        port: 443
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: pod-validator
  annotations:
    cert-manager.io/inject-ca-from: webhook-system/webhook-tls
webhooks:
  - name: pod-validator.webhook.example.com
    admissionReviewVersions: ["v1"]
    sideEffects: None
    failurePolicy: Fail
    timeoutSeconds: 10
    matchPolicy: Equivalent
    namespaceSelector:
      matchLabels:
        webhook.example.com/inject: "true"
    rules:
      - apiGroups:   [""]
        apiVersions: ["v1"]
        resources:   ["pods"]
        operations:  ["CREATE", "UPDATE"]
    clientConfig:
      service:
        name: webhook-server
        namespace: webhook-system
        path: /validate/pods
        port: 443
---
apiVersion: v1
kind: Service
metadata:
  name: webhook-server
  namespace: webhook-system
spec:
  selector:
    app: webhook-server
  ports:
    - port: 443
      targetPort: 8443
      protocol: TCP
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: webhook-server
  namespace: webhook-system
spec:
  replicas: 2
  selector:
    matchLabels:
      app: webhook-server
  template:
    metadata:
      labels:
        app: webhook-server
    spec:
      serviceAccountName: webhook-server
      containers:
        - name: webhook-server
          image: registry.example.com/webhook-server:latest
          args:
            - --port=8443
            - --cert-dir=/tmp/certs
            - --namespace=webhook-system
            - --service-name=webhook-server
          ports:
            - containerPort: 8443
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8443
              scheme: HTTPS
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8443
              scheme: HTTPS
            initialDelaySeconds: 15
            periodSeconds: 20
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 256Mi
```

## Section 9: Testing with envtest

The controller-runtime `envtest` package spins up a real kube-apiserver and etcd binary, enabling integration testing of webhooks without a full cluster.

```go
// test/integration/webhook_test.go
package integration

import (
	"context"
	"path/filepath"
	"testing"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

var (
	testEnv   *envtest.Environment
	k8sClient client.Client
	ctx       context.Context
	cancel    context.CancelFunc
)

func TestWebhooks(t *testing.T) {
	RegisterFailHandler(Fail)
	RunSpecs(t, "Webhook Integration Suite")
}

var _ = BeforeSuite(func() {
	logf.SetLogger(zap.New(zap.WriteTo(GinkgoWriter), zap.UseDevMode(true)))

	ctx, cancel = context.WithCancel(context.TODO())

	testEnv = &envtest.Environment{
		CRDDirectoryPaths: []string{filepath.Join("..", "..", "config", "crd")},
		WebhookInstallOptions: envtest.WebhookInstallOptions{
			Paths: []string{filepath.Join("..", "..", "config", "webhook")},
		},
	}

	cfg, err := testEnv.Start()
	Expect(err).NotTo(HaveOccurred())
	Expect(cfg).NotTo(BeNil())

	k8sClient, err = client.New(cfg, client.Options{})
	Expect(err).NotTo(HaveOccurred())

	// Start the webhook server using test options
	// envtest handles certificate injection automatically
})

var _ = AfterSuite(func() {
	cancel()
	Expect(testEnv.Stop()).To(Succeed())
})

var _ = Describe("PodValidator", func() {
	Context("when creating a pod without required labels", func() {
		It("should deny the pod", func() {
			pod := &corev1.Pod{
				ObjectMeta: metav1.ObjectMeta{
					Name:      "test-pod-no-labels",
					Namespace: "default",
				},
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{
						{
							Name:  "nginx",
							Image: "registry.example.com/nginx:latest",
							Resources: corev1.ResourceRequirements{
								Requests: corev1.ResourceList{
									corev1.ResourceCPU:    resource.MustParse("100m"),
									corev1.ResourceMemory: resource.MustParse("128Mi"),
								},
							},
						},
					},
				},
			}

			err := k8sClient.Create(ctx, pod)
			Expect(err).To(HaveOccurred())
			Expect(err.Error()).To(ContainSubstring("missing required label"))
		})
	})

	Context("when creating a valid pod", func() {
		It("should allow the pod and inject defaults", func() {
			pod := &corev1.Pod{
				ObjectMeta: metav1.ObjectMeta{
					Name:      "test-pod-valid",
					Namespace: "default",
					Labels: map[string]string{
						"app":     "test",
						"version": "v1.0.0",
						"team":    "platform",
					},
				},
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{
						{
							Name:  "app",
							Image: "registry.example.com/app:latest",
						},
					},
				},
			}

			err := k8sClient.Create(ctx, pod)
			Expect(err).NotTo(HaveOccurred())

			// Verify mutation: resource defaults should be injected
			created := &corev1.Pod{}
			err = k8sClient.Get(ctx, client.ObjectKey{
				Name:      "test-pod-valid",
				Namespace: "default",
			}, created)
			Expect(err).NotTo(HaveOccurred())

			container := created.Spec.Containers[0]
			Expect(container.Resources.Requests).NotTo(BeNil())
			Expect(container.Resources.Requests.Cpu().String()).To(Equal("100m"))
		})
	})

	Context("when creating a privileged pod", func() {
		It("should deny the pod", func() {
			privileged := true
			pod := &corev1.Pod{
				ObjectMeta: metav1.ObjectMeta{
					Name:      "test-pod-privileged",
					Namespace: "default",
					Labels: map[string]string{
						"app":     "test",
						"version": "v1.0.0",
						"team":    "platform",
					},
				},
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{
						{
							Name:  "app",
							Image: "registry.example.com/app:latest",
							SecurityContext: &corev1.SecurityContext{
								Privileged: &privileged,
							},
						},
					},
				},
			}

			err := k8sClient.Create(ctx, pod)
			Expect(err).To(HaveOccurred())
			Expect(err.Error()).To(ContainSubstring("privileged"))
		})
	})
})
```

## Section 10: Unit Testing Without envtest

For fast unit tests, test the handler functions directly without HTTP:

```go
// pkg/webhook/pod_validator_test.go
package webhook_test

import (
	"context"
	"encoding/json"
	"testing"

	admissionv1 "k8s.io/api/admission/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"go.uber.org/zap/zaptest"

	"github.com/example/webhook-server/pkg/webhook"
)

func TestPodValidator_RequiredLabels(t *testing.T) {
	logger := zaptest.NewLogger(t)
	validator := webhook.NewPodValidator(logger, webhook.PodValidationConfig{
		RequiredLabels: []string{"app", "team"},
	})

	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "test",
			Namespace: "default",
			Labels:    map[string]string{"app": "myapp"}, // missing "team"
		},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{{Name: "c", Image: "nginx:latest"}},
		},
	}

	raw, _ := json.Marshal(pod)
	req := admissionv1.AdmissionRequest{
		Kind:      metav1.GroupVersionKind{Kind: "Pod"},
		Operation: admissionv1.Create,
		Object:    runtime.RawExtension{Raw: raw},
	}

	resp := validator.Handle(context.Background(), req)

	if resp.Allowed {
		t.Error("expected pod to be denied, but it was allowed")
	}
	if resp.Result == nil || resp.Result.Message == "" {
		t.Error("expected a denial message")
	}
	t.Logf("denial message: %s", resp.Result.Message)
}

func TestPodMutator_IdempotentSidecarInjection(t *testing.T) {
	logger := zaptest.NewLogger(t)
	mutator := webhook.NewPodMutator(logger, webhook.PodMutatorConfig{
		SidecarName:  "audit-sidecar",
		SidecarImage: "registry.example.com/audit:latest",
	})

	// First, mutate a pod without the sidecar
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "test", Namespace: "default"},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{{Name: "app", Image: "registry.example.com/app:latest"}},
		},
	}

	raw, _ := json.Marshal(pod)
	req := admissionv1.AdmissionRequest{
		Kind:      metav1.GroupVersionKind{Kind: "Pod"},
		Operation: admissionv1.Create,
		Object:    runtime.RawExtension{Raw: raw},
	}

	resp := mutator.Handle(context.Background(), req)
	if !resp.Allowed {
		t.Fatalf("expected pod to be allowed, got: %v", resp.Result)
	}

	// Now test a pod that already has the sidecar
	podWithSidecar := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "test", Namespace: "default"},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{
				{Name: "app", Image: "registry.example.com/app:latest"},
				{Name: "audit-sidecar", Image: "registry.example.com/audit:latest"},
			},
		},
	}

	raw2, _ := json.Marshal(podWithSidecar)
	req2 := admissionv1.AdmissionRequest{
		Kind:      metav1.GroupVersionKind{Kind: "Pod"},
		Operation: admissionv1.Create,
		Object:    runtime.RawExtension{Raw: raw2},
	}

	resp2 := mutator.Handle(context.Background(), req2)
	if !resp2.Allowed {
		t.Fatalf("expected idempotent mutation to be allowed")
	}

	// When sidecar already exists, there should be no patch adding another
	if resp2.Patch != nil {
		var patches []webhook.JSONPatch
		json.Unmarshal(resp2.Patch, &patches)
		for _, p := range patches {
			if p.Path == "/spec/containers/-" {
				t.Error("sidecar injected again, mutation is not idempotent")
			}
		}
	}
}
```

## Section 11: Production Deployment Patterns

### Zero-Downtime Webhook Updates

Never update a webhook with `failurePolicy: Fail` while it has zero running replicas. The API server will start rejecting ALL requests matching the webhook rules.

```bash
# Safe update procedure:
# 1. Scale up new version alongside old
kubectl set image deployment/webhook-server webhook-server=registry.example.com/webhook-server:v2.0.0 -n webhook-system

# 2. Wait for rollout
kubectl rollout status deployment/webhook-server -n webhook-system

# 3. If issues arise, rollback
kubectl rollout undo deployment/webhook-server -n webhook-system
```

### PodDisruptionBudget for Webhook Servers

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: webhook-server-pdb
  namespace: webhook-system
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app: webhook-server
```

### Webhook Timeout and Failure Policy Considerations

- Set `timeoutSeconds` to the 99th percentile latency of your webhook plus 2 seconds
- Start with `failurePolicy: Ignore` in non-production namespaces
- Switch to `failurePolicy: Fail` only after several weeks of stable operation
- Use `namespaceSelector` to exclude `kube-system` and your webhook namespace from rules

### Monitoring Webhook Latency

The API server exposes webhook duration metrics via Prometheus:

```promql
# 99th percentile webhook latency
histogram_quantile(0.99,
  sum(rate(apiserver_admission_webhook_admission_duration_seconds_bucket[5m]))
  by (name, le)
)

# Webhook rejection rate
rate(apiserver_admission_webhook_rejection_count[5m])
```

## Section 12: Common Pitfalls and Solutions

**Problem: Webhook causes circular dependency during cluster bootstrap**
Solution: Add `objectSelector` or `namespaceSelector` to exclude your webhook namespace. Always ensure `kube-system` is excluded.

**Problem: JSON Patch path escaping errors**
Solution: Remember RFC 6901 escaping: `~` becomes `~0`, `/` becomes `~1`. A label key like `app.kubernetes.io/name` must be escaped to `app.kubernetes.io~1name` in a JSON Patch path.

**Problem: Mutation not applied on updates**
Solution: This is intentional design. If you need to re-apply mutations on updates, explicitly handle `admissionv1.Update` operations, but ensure your logic handles all possible existing states correctly.

**Problem: Webhook latency spikes causing API server timeouts**
Solution: Implement connection pooling, use context deadlines in your handlers, and ensure your webhook does not call external services synchronously. Cache any data needed for validation locally with a periodic refresh.

**Problem: Certificate rotation causes downtime**
Solution: Mount certificates via a Kubernetes Secret volume with `defaultMode: 0644`. The kubelet automatically updates the mounted files when the Secret changes. Use `tls.Config` with `GetCertificate` to reload certificates without restarting the server.

```go
// Hot-reload TLS certificate without restart
tlsConfig := &tls.Config{
    GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
        cert, err := tls.LoadX509KeyPair(certFile, keyFile)
        if err != nil {
            return nil, err
        }
        return &cert, nil
    },
}
```

This approach to admission webhooks provides a foundation for enforcing organizational policy at scale. The combination of idempotent mutations, comprehensive testing with envtest, and careful attention to failure modes ensures your webhook operates reliably in production without becoming a chokepoint in cluster operations.
