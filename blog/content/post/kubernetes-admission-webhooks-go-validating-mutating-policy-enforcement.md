---
title: "Kubernetes Admission Webhooks with Go: Validating and Mutating Webhooks for Policy Enforcement"
date: 2031-07-01T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Go", "Admission Webhooks", "Policy", "Security", "OPA"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Build production-grade validating and mutating admission webhooks in Go, covering TLS bootstrapping, webhook server architecture, pod security injection, resource quota enforcement, and integration testing strategies."
more_link: "yes"
url: "/kubernetes-admission-webhooks-go-validating-mutating-policy-enforcement/"
---

Admission webhooks are the most powerful extensibility point in Kubernetes. They intercept every API server request before the object is persisted, enabling organizations to enforce policies that the built-in admission controllers cannot express: mandatory labels, resource limit requirements, sidecar injection, image registry allowlists, and much more. This post builds a complete, production-ready webhook server in Go from TLS bootstrapping through integration testing.

<!--more-->

# Kubernetes Admission Webhooks with Go: Validating and Mutating Webhooks for Policy Enforcement

## Admission Control Architecture

When a client submits a request to the Kubernetes API server, it passes through several admission phases:

```
Client Request
    |
    v
Authentication -> Authorization -> Mutating Admission -> Object Schema Validation -> Validating Admission -> etcd
                                         |                                                    |
                              (MutatingWebhookConfiguration)                  (ValidatingWebhookConfiguration)
                              - Modify request objects                         - Approve or deny requests
                              - Inject sidecars                                - Enforce policies
                              - Set defaults                                   - Validate configurations
```

Key behaviors to understand:
- **Mutating webhooks** run before validating webhooks and may modify the object
- Mutating webhooks run sequentially (not in parallel)
- **Validating webhooks** run in parallel after all mutating webhooks complete
- If any validating webhook denies the request, the entire request fails
- Webhooks that fail or are unreachable can be configured to either fail-open or fail-closed

## Project Structure

```
k8s-webhook/
├── cmd/
│   └── webhook/
│       └── main.go
├── pkg/
│   ├── admission/
│   │   ├── handler.go           # HTTP handler, webhook dispatch
│   │   ├── mutating.go          # Mutating webhook implementations
│   │   └── validating.go        # Validating webhook implementations
│   ├── patch/
│   │   └── patch.go             # JSON Patch construction helpers
│   └── tls/
│       └── tls.go               # TLS certificate management
├── deploy/
│   ├── webhook-deployment.yaml
│   ├── webhook-service.yaml
│   ├── mutating-webhook-config.yaml
│   └── validating-webhook-config.yaml
├── Dockerfile
├── go.mod
└── go.sum
```

```bash
go mod init github.com/myorg/k8s-webhook
go get k8s.io/api@latest
go get k8s.io/apimachinery@latest
go get k8s.io/client-go@latest
go get sigs.k8s.io/controller-runtime@latest
go get go.uber.org/zap@latest
```

## TLS Certificate Management

Admission webhooks require TLS. The API server verifies the webhook's certificate using the CA bundle specified in the webhook configuration.

```go
// pkg/tls/tls.go
package tls

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"time"
)

// GenerateSelfSignedCert generates a self-signed TLS certificate
// suitable for use with a Kubernetes admission webhook.
// The certificate is valid for the given DNS names and IP addresses.
func GenerateSelfSignedCert(dnsNames []string, ipAddresses []net.IP) (certPEM, keyPEM []byte, err error) {
	key, err := rsa.GenerateKey(rand.Reader, 4096)
	if err != nil {
		return nil, nil, fmt.Errorf("generating RSA key: %w", err)
	}

	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject: pkix.Name{
			Organization: []string{"MyOrg Kubernetes Webhook"},
			CommonName:   dnsNames[0],
		},
		DNSNames:    dnsNames,
		IPAddresses: ipAddresses,
		NotBefore:   time.Now(),
		NotAfter:    time.Now().Add(10 * 365 * 24 * time.Hour), // 10 years
		KeyUsage:    x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageTLSServer},
	}

	certDER, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return nil, nil, fmt.Errorf("creating certificate: %w", err)
	}

	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})

	return certPEM, keyPEM, nil
}

// SaveCertAndKey writes cert and key PEM data to files.
func SaveCertAndKey(certPEM, keyPEM []byte, certPath, keyPath string) error {
	if err := os.WriteFile(certPath, certPEM, 0644); err != nil {
		return fmt.Errorf("writing cert: %w", err)
	}
	if err := os.WriteFile(keyPath, keyPEM, 0600); err != nil {
		return fmt.Errorf("writing key: %w", err)
	}
	return nil
}
```

In practice, use cert-manager to manage webhook certificates. This eliminates certificate rotation concerns:

```yaml
# deploy/certificate.yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: webhook-tls
  namespace: webhook-system
spec:
  secretName: webhook-tls-secret
  dnsNames:
  - webhook-service.webhook-system.svc
  - webhook-service.webhook-system.svc.cluster.local
  issuerRef:
    name: cluster-issuer
    kind: ClusterIssuer
  duration: 8760h   # 1 year
  renewBefore: 720h # Renew 30 days before expiry
```

## Webhook Server

```go
// pkg/admission/handler.go
package admission

import (
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

// WebhookFunc is the signature for webhook handler functions.
type WebhookFunc func(req *admissionv1.AdmissionRequest) (*admissionv1.AdmissionResponse, error)

// Handler wraps webhook functions as HTTP handlers.
type Handler struct {
	logger *zap.Logger

	// Registry maps path -> webhook handler function
	mutatingHandlers   map[string]WebhookFunc
	validatingHandlers map[string]WebhookFunc
}

// NewHandler creates a new webhook handler.
func NewHandler(logger *zap.Logger) *Handler {
	return &Handler{
		logger:             logger,
		mutatingHandlers:   make(map[string]WebhookFunc),
		validatingHandlers: make(map[string]WebhookFunc),
	}
}

// RegisterMutating registers a mutating webhook at the given path.
func (h *Handler) RegisterMutating(path string, fn WebhookFunc) {
	h.mutatingHandlers[path] = fn
}

// RegisterValidating registers a validating webhook at the given path.
func (h *Handler) RegisterValidating(path string, fn WebhookFunc) {
	h.validatingHandlers[path] = fn
}

// ServeHTTP dispatches incoming webhook requests to the registered handlers.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Determine handler type based on path prefix
	var fn WebhookFunc
	var ok bool

	if fn, ok = h.mutatingHandlers[r.URL.Path]; !ok {
		if fn, ok = h.validatingHandlers[r.URL.Path]; !ok {
			http.NotFound(w, r)
			return
		}
	}

	h.serve(w, r, fn)
}

func (h *Handler) serve(w http.ResponseWriter, r *http.Request, webhook WebhookFunc) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 10*1024*1024)) // 10MB limit
	if err != nil {
		h.logger.Error("reading request body", zap.Error(err))
		http.Error(w, "error reading body", http.StatusBadRequest)
		return
	}

	if contentType := r.Header.Get("Content-Type"); contentType != "application/json" {
		h.logger.Error("unexpected content type", zap.String("contentType", contentType))
		http.Error(w, "expected application/json", http.StatusUnsupportedMediaType)
		return
	}

	// Decode the AdmissionReview
	var admissionReview admissionv1.AdmissionReview
	if _, _, err := deserializer.Decode(body, nil, &admissionReview); err != nil {
		h.logger.Error("decoding admission review", zap.Error(err))
		http.Error(w, fmt.Sprintf("could not decode body: %v", err), http.StatusBadRequest)
		return
	}

	if admissionReview.Request == nil {
		h.logger.Error("admission review request is nil")
		http.Error(w, "admission review request is nil", http.StatusBadRequest)
		return
	}

	h.logger.Info("processing admission request",
		zap.String("uid", string(admissionReview.Request.UID)),
		zap.String("kind", admissionReview.Request.Kind.Kind),
		zap.String("namespace", admissionReview.Request.Namespace),
		zap.String("name", admissionReview.Request.Name),
		zap.String("operation", string(admissionReview.Request.Operation)),
	)

	// Call the webhook handler
	resp, err := webhook(admissionReview.Request)
	if err != nil {
		h.logger.Error("webhook handler error",
			zap.Error(err),
			zap.String("uid", string(admissionReview.Request.UID)),
		)
		resp = &admissionv1.AdmissionResponse{
			Allowed: false,
			Result: &metav1.Status{
				Code:    http.StatusInternalServerError,
				Message: err.Error(),
			},
		}
	}

	// Always echo back the UID
	resp.UID = admissionReview.Request.UID

	// Write the response
	review := admissionv1.AdmissionReview{
		TypeMeta: metav1.TypeMeta{
			APIVersion: "admission.k8s.io/v1",
			Kind:       "AdmissionReview",
		},
		Response: resp,
	}

	respBytes, err := json.Marshal(review)
	if err != nil {
		h.logger.Error("marshaling response", zap.Error(err))
		http.Error(w, "error marshaling response", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write(respBytes)
}
```

## JSON Patch Helpers

Mutating webhooks return RFC 6902 JSON Patch documents. A helper library prevents encoding errors:

```go
// pkg/patch/patch.go
package patch

import (
	"encoding/json"
	"fmt"
)

// Operation represents a single JSON Patch operation.
type Operation struct {
	Op    string      `json:"op"`
	Path  string      `json:"path"`
	Value interface{} `json:"value,omitempty"`
}

// Builder accumulates patch operations.
type Builder struct {
	ops []Operation
}

// New returns a new patch Builder.
func New() *Builder {
	return &Builder{}
}

// Add appends an "add" operation.
func (b *Builder) Add(path string, value interface{}) *Builder {
	b.ops = append(b.ops, Operation{Op: "add", Path: path, Value: value})
	return b
}

// Replace appends a "replace" operation.
func (b *Builder) Replace(path string, value interface{}) *Builder {
	b.ops = append(b.ops, Operation{Op: "replace", Path: path, Value: value})
	return b
}

// Remove appends a "remove" operation.
func (b *Builder) Remove(path string) *Builder {
	b.ops = append(b.ops, Operation{Op: "remove", Path: path})
	return b
}

// Bytes returns the JSON-encoded patch.
func (b *Builder) Bytes() ([]byte, error) {
	if len(b.ops) == 0 {
		return []byte("[]"), nil
	}
	data, err := json.Marshal(b.ops)
	if err != nil {
		return nil, fmt.Errorf("marshaling patch: %w", err)
	}
	return data, nil
}

// EscapePath escapes a JSON Pointer path component per RFC 6901.
// ~ is escaped as ~0, / is escaped as ~1.
func EscapePath(s string) string {
	result := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '~':
			result = append(result, '~', '0')
		case '/':
			result = append(result, '~', '1')
		default:
			result = append(result, s[i])
		}
	}
	return string(result)
}
```

## Mutating Webhook: Sidecar Injector

This example injects a log collection sidecar into pods that have the `inject-logger: "true"` annotation.

```go
// pkg/admission/mutating.go
package admission

import (
	"encoding/json"
	"fmt"

	admissionv1 "k8s.io/api/admission/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/myorg/k8s-webhook/pkg/patch"
)

const (
	sidecarInjectAnnotation = "logging.myorg.com/inject"
	sidecarInjectedLabel    = "logging.myorg.com/injected"
)

// MutatePod handles pod mutation requests.
// It injects a log collection sidecar if the annotation is present.
func MutatePod(req *admissionv1.AdmissionRequest) (*admissionv1.AdmissionResponse, error) {
	// Only handle pod operations
	if req.Kind.Kind != "Pod" {
		return &admissionv1.AdmissionResponse{Allowed: true}, nil
	}

	// Only handle CREATE operations
	if req.Operation != admissionv1.Create {
		return &admissionv1.AdmissionResponse{Allowed: true}, nil
	}

	var pod corev1.Pod
	if err := json.Unmarshal(req.Object.Raw, &pod); err != nil {
		return nil, fmt.Errorf("unmarshaling pod: %w", err)
	}

	// Check for injection annotation
	if pod.Annotations[sidecarInjectAnnotation] != "true" {
		return &admissionv1.AdmissionResponse{Allowed: true}, nil
	}

	// Don't inject if already injected (idempotency)
	if pod.Labels[sidecarInjectedLabel] == "true" {
		return &admissionv1.AdmissionResponse{Allowed: true}, nil
	}

	patchBuilder := patch.New()

	// Ensure containers array exists
	if pod.Spec.Containers == nil {
		patchBuilder.Add("/spec/containers", []interface{}{})
	}

	// Add the sidecar container
	sidecar := buildLogSidecar(&pod)
	patchBuilder.Add("/spec/containers/-", sidecar)

	// Add the shared log volume
	logVolume := corev1.Volume{
		Name: "app-logs",
		VolumeSource: corev1.VolumeSource{
			EmptyDir: &corev1.EmptyDirVolumeSource{
				SizeLimit: resourcePtr(resource.MustParse("1Gi")),
			},
		},
	}

	if pod.Spec.Volumes == nil {
		patchBuilder.Add("/spec/volumes", []interface{}{})
	}
	patchBuilder.Add("/spec/volumes/-", logVolume)

	// Add the volume mount to the first application container
	logMount := corev1.VolumeMount{
		Name:      "app-logs",
		MountPath: "/var/log/app",
	}
	patchBuilder.Add("/spec/containers/0/volumeMounts/-", logMount)

	// Set the injection label
	if pod.Labels == nil {
		patchBuilder.Add("/metadata/labels", map[string]string{})
	}
	patchBuilder.Add(
		"/metadata/labels/"+patch.EscapePath(sidecarInjectedLabel),
		"true",
	)

	patchBytes, err := patchBuilder.Bytes()
	if err != nil {
		return nil, fmt.Errorf("building patch: %w", err)
	}

	patchType := admissionv1.PatchTypeJSONPatch
	return &admissionv1.AdmissionResponse{
		Allowed:   true,
		Patch:     patchBytes,
		PatchType: &patchType,
	}, nil
}

func buildLogSidecar(pod *corev1.Pod) corev1.Container {
	// Determine log path from pod annotation, default to /var/log/app
	logPath := "/var/log/app"
	if customPath, ok := pod.Annotations["logging.myorg.com/log-path"]; ok {
		logPath = customPath
	}

	return corev1.Container{
		Name:            "log-collector",
		Image:           "registry.myorg.com/log-collector:v2.1.0",
		ImagePullPolicy: corev1.PullIfNotPresent,
		Args: []string{
			"--log-path=" + logPath,
			"--output=elasticsearch",
			"--elasticsearch-host=elasticsearch.logging.svc.cluster.local:9200",
		},
		VolumeMounts: []corev1.VolumeMount{
			{
				Name:      "app-logs",
				MountPath: logPath,
				ReadOnly:  true,
			},
		},
		Resources: corev1.ResourceRequirements{
			Requests: corev1.ResourceList{
				corev1.ResourceCPU:    resource.MustParse("50m"),
				corev1.ResourceMemory: resource.MustParse("64Mi"),
			},
			Limits: corev1.ResourceList{
				corev1.ResourceCPU:    resource.MustParse("200m"),
				corev1.ResourceMemory: resource.MustParse("128Mi"),
			},
		},
		SecurityContext: &corev1.SecurityContext{
			AllowPrivilegeEscalation: boolPtr(false),
			ReadOnlyRootFilesystem:   boolPtr(true),
			RunAsNonRoot:             boolPtr(true),
			RunAsUser:                int64Ptr(65534),
			Capabilities: &corev1.Capabilities{
				Drop: []corev1.Capability{"ALL"},
			},
		},
	}
}

func boolPtr(b bool) *bool         { return &b }
func int64Ptr(i int64) *int64      { return &i }
func resourcePtr(r resource.Quantity) *resource.Quantity { return &r }
```

## Validating Webhook: Policy Enforcement

This validating webhook enforces several enterprise policies:

```go
// pkg/admission/validating.go
package admission

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	admissionv1 "k8s.io/api/admission/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

var (
	// allowedRegistries lists the only image registries permitted
	allowedRegistries = []string{
		"registry.myorg.com",
		"gcr.io/myorg-project",
		"public.ecr.aws/myorg",
	}

	// requiredLabels lists labels that must be present on all pods
	requiredLabels = []string{
		"app",
		"version",
		"team",
		"environment",
	}

	imageTagRegex = regexp.MustCompile(`^[a-zA-Z0-9_.-]+:[a-zA-Z0-9_.-]+$`)
)

// PolicyViolation describes a single policy violation.
type PolicyViolation struct {
	Policy  string
	Field   string
	Message string
}

func (v PolicyViolation) String() string {
	return fmt.Sprintf("[%s] %s: %s", v.Policy, v.Field, v.Message)
}

// ValidatePod enforces enterprise pod policies.
func ValidatePod(req *admissionv1.AdmissionRequest) (*admissionv1.AdmissionResponse, error) {
	if req.Kind.Kind != "Pod" {
		return &admissionv1.AdmissionResponse{Allowed: true}, nil
	}

	var pod corev1.Pod
	if err := json.Unmarshal(req.Object.Raw, &pod); err != nil {
		return nil, fmt.Errorf("unmarshaling pod: %w", err)
	}

	var violations []PolicyViolation

	violations = append(violations, validateRequiredLabels(&pod)...)
	violations = append(violations, validateImageRegistries(&pod)...)
	violations = append(violations, validateImageTags(&pod)...)
	violations = append(violations, validateResourceLimits(&pod)...)
	violations = append(violations, validateSecurityContext(&pod)...)

	if len(violations) > 0 {
		messages := make([]string, len(violations))
		for i, v := range violations {
			messages[i] = v.String()
		}
		return &admissionv1.AdmissionResponse{
			Allowed: false,
			Result: &metav1.Status{
				Code:    403,
				Message: fmt.Sprintf("%d policy violation(s):\n%s", len(violations), strings.Join(messages, "\n")),
			},
		}, nil
	}

	return &admissionv1.AdmissionResponse{Allowed: true}, nil
}

func validateRequiredLabels(pod *corev1.Pod) []PolicyViolation {
	var violations []PolicyViolation
	for _, label := range requiredLabels {
		if _, ok := pod.Labels[label]; !ok {
			violations = append(violations, PolicyViolation{
				Policy:  "required-labels",
				Field:   "metadata.labels." + label,
				Message: fmt.Sprintf("label %q is required on all pods", label),
			})
		}
	}
	return violations
}

func validateImageRegistries(pod *corev1.Pod) []PolicyViolation {
	var violations []PolicyViolation

	allContainers := append(pod.Spec.InitContainers, pod.Spec.Containers...)
	for _, c := range allContainers {
		allowed := false
		for _, registry := range allowedRegistries {
			if strings.HasPrefix(c.Image, registry+"/") || c.Image == registry {
				allowed = true
				break
			}
		}
		if !allowed {
			violations = append(violations, PolicyViolation{
				Policy:  "allowed-registries",
				Field:   fmt.Sprintf("spec.containers[name=%s].image", c.Name),
				Message: fmt.Sprintf("image %q is from a disallowed registry; allowed registries: %v", c.Image, allowedRegistries),
			})
		}
	}
	return violations
}

func validateImageTags(pod *corev1.Pod) []PolicyViolation {
	var violations []PolicyViolation

	allContainers := append(pod.Spec.InitContainers, pod.Spec.Containers...)
	for _, c := range allContainers {
		// Disallow 'latest' tag
		if strings.HasSuffix(c.Image, ":latest") || !strings.Contains(c.Image, ":") {
			violations = append(violations, PolicyViolation{
				Policy:  "no-latest-tag",
				Field:   fmt.Sprintf("spec.containers[name=%s].image", c.Name),
				Message: fmt.Sprintf("image %q uses the 'latest' tag or has no tag; explicit tags are required", c.Image),
			})
		}

		// Disallow imagePullPolicy: Always for non-development environments
		if c.ImagePullPolicy == corev1.PullAlways && pod.Labels["environment"] == "production" {
			violations = append(violations, PolicyViolation{
				Policy:  "image-pull-policy",
				Field:   fmt.Sprintf("spec.containers[name=%s].imagePullPolicy", c.Name),
				Message: "imagePullPolicy: Always is not permitted in production environments",
			})
		}
	}
	return violations
}

func validateResourceLimits(pod *corev1.Pod) []PolicyViolation {
	var violations []PolicyViolation

	for _, c := range pod.Spec.Containers {
		if c.Resources.Limits == nil {
			violations = append(violations, PolicyViolation{
				Policy:  "resource-limits",
				Field:   fmt.Sprintf("spec.containers[name=%s].resources.limits", c.Name),
				Message: "resource limits (cpu and memory) are required on all containers",
			})
			continue
		}

		if _, ok := c.Resources.Limits[corev1.ResourceCPU]; !ok {
			violations = append(violations, PolicyViolation{
				Policy:  "resource-limits",
				Field:   fmt.Sprintf("spec.containers[name=%s].resources.limits.cpu", c.Name),
				Message: "CPU limit is required",
			})
		}

		if _, ok := c.Resources.Limits[corev1.ResourceMemory]; !ok {
			violations = append(violations, PolicyViolation{
				Policy:  "resource-limits",
				Field:   fmt.Sprintf("spec.containers[name=%s].resources.limits.memory", c.Name),
				Message: "memory limit is required",
			})
		}
	}
	return violations
}

func validateSecurityContext(pod *corev1.Pod) []PolicyViolation {
	var violations []PolicyViolation

	// Pod-level security context checks
	if pod.Spec.HostNetwork {
		violations = append(violations, PolicyViolation{
			Policy:  "host-access",
			Field:   "spec.hostNetwork",
			Message: "hostNetwork is not permitted",
		})
	}

	if pod.Spec.HostPID {
		violations = append(violations, PolicyViolation{
			Policy:  "host-access",
			Field:   "spec.hostPID",
			Message: "hostPID is not permitted",
		})
	}

	// Container-level security context checks
	for _, c := range pod.Spec.Containers {
		if c.SecurityContext == nil {
			violations = append(violations, PolicyViolation{
				Policy:  "security-context",
				Field:   fmt.Sprintf("spec.containers[name=%s].securityContext", c.Name),
				Message: "securityContext is required on all containers",
			})
			continue
		}

		sc := c.SecurityContext

		if sc.AllowPrivilegeEscalation == nil || *sc.AllowPrivilegeEscalation {
			violations = append(violations, PolicyViolation{
				Policy:  "security-context",
				Field:   fmt.Sprintf("spec.containers[name=%s].securityContext.allowPrivilegeEscalation", c.Name),
				Message: "allowPrivilegeEscalation must be set to false",
			})
		}

		if sc.RunAsNonRoot == nil || !*sc.RunAsNonRoot {
			violations = append(violations, PolicyViolation{
				Policy:  "security-context",
				Field:   fmt.Sprintf("spec.containers[name=%s].securityContext.runAsNonRoot", c.Name),
				Message: "runAsNonRoot must be set to true",
			})
		}

		if sc.Capabilities == nil {
			violations = append(violations, PolicyViolation{
				Policy:  "security-context",
				Field:   fmt.Sprintf("spec.containers[name=%s].securityContext.capabilities", c.Name),
				Message: "capabilities must be explicitly configured; at minimum, drop ALL",
			})
		}
	}
	return violations
}
```

## Main Server

```go
// cmd/webhook/main.go
package main

import (
	"context"
	"crypto/tls"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/myorg/k8s-webhook/pkg/admission"
	"go.uber.org/zap"
)

func main() {
	logger, _ := zap.NewProduction()
	defer logger.Sync()

	certFile := getEnvOrDefault("TLS_CERT_FILE", "/etc/webhook/tls/tls.crt")
	keyFile := getEnvOrDefault("TLS_KEY_FILE", "/etc/webhook/tls/tls.key")
	port := getEnvOrDefault("PORT", "8443")

	// Initialize webhook handler
	handler := admission.NewHandler(logger)
	handler.RegisterMutating("/mutate/pods", admission.MutatePod)
	handler.RegisterValidating("/validate/pods", admission.ValidatePod)

	// Health check endpoint (no TLS required, served on separate port)
	go func() {
		mux := http.NewServeMux()
		mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("ok"))
		})
		mux.HandleFunc("/readyz", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("ok"))
		})
		healthSrv := &http.Server{
			Addr:    ":8080",
			Handler: mux,
		}
		if err := healthSrv.ListenAndServe(); err != nil {
			logger.Fatal("health server error", zap.Error(err))
		}
	}()

	// TLS server
	server := &http.Server{
		Addr:    ":" + port,
		Handler: handler,
		TLSConfig: &tls.Config{
			MinVersion: tls.VersionTLS13,
		},
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		logger.Info("starting webhook server", zap.String("port", port))
		if err := server.ListenAndServeTLS(certFile, keyFile); err != nil && err != http.ErrServerClosed {
			logger.Fatal("server error", zap.Error(err))
		}
	}()

	<-quit
	logger.Info("shutting down webhook server")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		logger.Fatal("forced shutdown", zap.Error(err))
	}
}

func getEnvOrDefault(key, defaultVal string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultVal
}
```

## Kubernetes Deployment

```yaml
# deploy/webhook-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: policy-webhook
  namespace: webhook-system
  labels:
    app: policy-webhook
spec:
  replicas: 2
  selector:
    matchLabels:
      app: policy-webhook
  strategy:
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    metadata:
      labels:
        app: policy-webhook
    spec:
      serviceAccountName: policy-webhook
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: policy-webhook
            topologyKey: kubernetes.io/hostname
      containers:
      - name: webhook
        image: registry.myorg.com/policy-webhook:v1.0.0
        ports:
        - containerPort: 8443
          name: webhook
        - containerPort: 8080
          name: health
        volumeMounts:
        - name: tls
          mountPath: /etc/webhook/tls
          readOnly: true
        env:
        - name: TLS_CERT_FILE
          value: /etc/webhook/tls/tls.crt
        - name: TLS_KEY_FILE
          value: /etc/webhook/tls/tls.key
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 256Mi
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /readyz
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          runAsNonRoot: true
          runAsUser: 65534
          capabilities:
            drop: ["ALL"]
      volumes:
      - name: tls
        secret:
          secretName: webhook-tls-secret
```

```yaml
# deploy/validating-webhook-config.yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: policy-webhook
  annotations:
    # cert-manager injects the caBundle automatically
    cert-manager.io/inject-ca-from: webhook-system/webhook-tls
spec:
  webhooks:
  - name: pods.policy.myorg.com
    rules:
    - apiGroups: [""]
      apiVersions: ["v1"]
      operations: ["CREATE", "UPDATE"]
      resources: ["pods"]
      scope: "Namespaced"
    clientConfig:
      service:
        name: policy-webhook
        namespace: webhook-system
        path: /validate/pods
        port: 8443
    admissionReviewVersions: ["v1"]
    sideEffects: None
    timeoutSeconds: 10
    failurePolicy: Fail
    # Only enforce in namespaces with this label
    namespaceSelector:
      matchLabels:
        policy.myorg.com/enforced: "true"
    # Exclude system namespaces
    objectSelector:
      matchExpressions:
      - key: "policy.myorg.com/exempt"
        operator: DoesNotExist
```

## Integration Testing

```go
// pkg/admission/validating_test.go
package admission

import (
	"encoding/json"
	"testing"

	admissionv1 "k8s.io/api/admission/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newPodRequest(pod *corev1.Pod) *admissionv1.AdmissionRequest {
	raw, _ := json.Marshal(pod)
	return &admissionv1.AdmissionRequest{
		UID:       "test-uid",
		Kind:      metav1.GroupVersionKind{Group: "", Version: "v1", Kind: "Pod"},
		Operation: admissionv1.Create,
		Object:    runtime.RawExtension{Raw: raw},
	}
}

func compliantPod() *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "test-pod",
			Namespace: "default",
			Labels: map[string]string{
				"app":         "my-app",
				"version":     "v1.0.0",
				"team":        "platform",
				"environment": "production",
			},
		},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{
				{
					Name:  "app",
					Image: "registry.myorg.com/my-app:v1.0.0",
					Resources: corev1.ResourceRequirements{
						Limits: corev1.ResourceList{
							corev1.ResourceCPU:    resource.MustParse("500m"),
							corev1.ResourceMemory: resource.MustParse("256Mi"),
						},
					},
					SecurityContext: &corev1.SecurityContext{
						AllowPrivilegeEscalation: boolPtr(false),
						RunAsNonRoot:             boolPtr(true),
						Capabilities: &corev1.Capabilities{
							Drop: []corev1.Capability{"ALL"},
						},
					},
				},
			},
		},
	}
}

func TestValidatePod_CompliantPodIsAllowed(t *testing.T) {
	resp, err := ValidatePod(newPodRequest(compliantPod()))
	require.NoError(t, err)
	assert.True(t, resp.Allowed)
}

func TestValidatePod_MissingLabels(t *testing.T) {
	pod := compliantPod()
	delete(pod.Labels, "team")
	delete(pod.Labels, "version")

	resp, err := ValidatePod(newPodRequest(pod))
	require.NoError(t, err)
	assert.False(t, resp.Allowed)
	assert.Contains(t, resp.Result.Message, "team")
	assert.Contains(t, resp.Result.Message, "version")
}

func TestValidatePod_DisallowedRegistry(t *testing.T) {
	pod := compliantPod()
	pod.Spec.Containers[0].Image = "docker.io/nginx:1.25"

	resp, err := ValidatePod(newPodRequest(pod))
	require.NoError(t, err)
	assert.False(t, resp.Allowed)
	assert.Contains(t, resp.Result.Message, "disallowed registry")
}

func TestValidatePod_LatestTagDenied(t *testing.T) {
	pod := compliantPod()
	pod.Spec.Containers[0].Image = "registry.myorg.com/my-app:latest"

	resp, err := ValidatePod(newPodRequest(pod))
	require.NoError(t, err)
	assert.False(t, resp.Allowed)
	assert.Contains(t, resp.Result.Message, "latest")
}

func TestValidatePod_MissingResourceLimits(t *testing.T) {
	pod := compliantPod()
	pod.Spec.Containers[0].Resources = corev1.ResourceRequirements{}

	resp, err := ValidatePod(newPodRequest(pod))
	require.NoError(t, err)
	assert.False(t, resp.Allowed)
	assert.Contains(t, resp.Result.Message, "resource limits")
}
```

## Conclusion

Admission webhooks are the correct tool when you need to enforce policies that the Kubernetes API server cannot express natively. The patterns shown here—webhook dispatch, typed policy violations, cert-manager TLS integration, and comprehensive unit tests—provide a foundation that scales to dozens of policies without becoming unmaintainable. The critical operational consideration is `failurePolicy`: setting it to `Fail` for security-critical policies and `Ignore` for non-critical enhancements, with appropriate PodDisruptionBudgets and multi-replica deployments to ensure the webhook itself never becomes a single point of failure.
