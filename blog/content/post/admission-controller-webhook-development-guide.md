---
title: "Kubernetes Admission Controller Webhooks: Development and Production Deployment"
date: 2027-04-11T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Admission Controller", "Webhooks", "Security", "Go"]
categories: ["Kubernetes", "Security", "Development"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to developing and deploying Kubernetes admission controller webhooks in Go, covering ValidatingWebhookConfiguration and MutatingWebhookConfiguration, TLS with cert-manager, admission review request/response handling, side effects declaration, failure policies, and testing with webhook-test-tool."
more_link: "yes"
url: "/admission-controller-webhook-development-guide/"
---

Kubernetes admission controller webhooks are the extensibility point for enforcing custom policy at the API server boundary. Every resource creation, update, and deletion passes through the admission chain before reaching etcd. Validating webhooks can reject requests; mutating webhooks can modify them. Building a production-quality webhook in Go requires understanding the full lifecycle: TLS provisioning, AdmissionRequest/Response structures, idempotent mutation logic, correct side-effects declaration, and the failure policy that determines cluster behavior when the webhook itself is unavailable.

This guide builds a complete webhook server from scratch and deploys it to production with cert-manager for TLS, proper RBAC, and testing infrastructure.

<!--more-->

## Admission Webhook Phases and API Request Chain

### Request Flow

```
kubectl apply -f deployment.yaml
         │
         ▼
kube-apiserver
  1. Authentication
  2. Authorization (RBAC)
  3. Admission Controllers (built-in: NamespaceLifecycle, LimitRanger...)
  4. Mutating Admission Webhooks  ◄── Modifies resources BEFORE validation
         │ AdmissionRequest
         ▼
  Webhook Server ──► AdmissionResponse (patch or allow)
         │
  5. Object Schema Validation
  6. Validating Admission Webhooks ◄── Validates FINAL resource state
         │ AdmissionRequest
         ▼
  Webhook Server ──► AdmissionResponse (allow or deny)
         │
  7. Persist to etcd
```

Key distinction: mutating webhooks run before object schema validation, so they can add fields that would fail validation if missing. Validating webhooks see the final object after all mutations — they validate the complete intended state.

## Go Webhook Server Implementation

### Project Structure

```
webhook-server/
├── cmd/
│   └── webhook-server/
│       └── main.go           ← Entry point
├── internal/
│   ├── handler/
│   │   ├── validate.go       ← Validating webhook handlers
│   │   ├── mutate.go         ← Mutating webhook handlers
│   │   └── handler.go        ← HTTP server setup
│   ├── admission/
│   │   ├── request.go        ← AdmissionRequest parsing
│   │   └── response.go       ← AdmissionResponse construction
│   └── policy/
│       ├── labels.go         ← Label validation policy
│       ├── images.go         ← Image policy
│       └── resources.go      ← Resource limits policy
├── config/
│   ├── webhook-deployment.yaml
│   ├── validating-webhook.yaml
│   └── mutating-webhook.yaml
├── go.mod
└── go.sum
```

### Main Entry Point

```go
// cmd/webhook-server/main.go

package main

import (
	"context"
	"crypto/tls"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/acme-corp/webhook-server/internal/handler"
	"go.uber.org/zap"
)

func main() {
	var (
		port     = flag.Int("port", 8443, "HTTPS port for the webhook server")
		certFile = flag.String("cert-file", "/etc/webhook/certs/tls.crt", "Path to TLS certificate")
		keyFile  = flag.String("key-file", "/etc/webhook/certs/tls.key", "Path to TLS private key")
		logLevel = flag.String("log-level", "info", "Log level (debug, info, warn, error)")
	)
	flag.Parse()

	// Initialize structured logger
	var log *zap.Logger
	var err error
	if *logLevel == "debug" {
		log, err = zap.NewDevelopment()
	} else {
		log, err = zap.NewProduction()
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to initialize logger: %v\n", err)
		os.Exit(1)
	}
	defer log.Sync() // nolint:errcheck

	// Build the HTTP mux with all webhook endpoints
	mux := handler.NewMux(log)

	// Configure TLS — the API server requires HTTPS for webhook servers
	tlsConfig := &tls.Config{
		MinVersion: tls.VersionTLS12,
		// Only allow strong cipher suites
		CipherSuites: []uint16{
			tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
			tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
		},
	}

	server := &http.Server{
		Addr:         fmt.Sprintf(":%d", *port),
		Handler:      mux,
		TLSConfig:    tlsConfig,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	// Start server in a goroutine to allow graceful shutdown
	go func() {
		log.Info("Starting webhook server",
			zap.Int("port", *port),
			zap.String("cert", *certFile),
		)
		if err := server.ListenAndServeTLS(*certFile, *keyFile); err != nil && err != http.ErrServerClosed {
			log.Fatal("Failed to start server", zap.Error(err))
		}
	}()

	// Wait for termination signal
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	<-stop

	log.Info("Shutting down webhook server")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		log.Error("Server shutdown failed", zap.Error(err))
	}
}
```

### HTTP Handler Setup

```go
// internal/handler/handler.go

package handler

import (
	"encoding/json"
	"io"
	"net/http"

	admissionv1 "k8s.io/api/admission/v1"
	"go.uber.org/zap"
)

// NewMux builds the HTTP mux with all webhook and health endpoints
func NewMux(log *zap.Logger) *http.ServeMux {
	mux := http.NewServeMux()

	// Health endpoints for Kubernetes probes
	mux.HandleFunc("/healthz", handleHealthz)
	mux.HandleFunc("/readyz", handleHealthz)

	// Validating webhook endpoints
	mux.Handle("/validate/pods", newWebhookHandler(log, validatePod))
	mux.Handle("/validate/deployments", newWebhookHandler(log, validateDeployment))

	// Mutating webhook endpoints
	mux.Handle("/mutate/pods", newWebhookHandler(log, mutatePod))

	return mux
}

func handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("ok")) // nolint:errcheck
}

// webhookHandler wraps a handler function with request parsing and response encoding
type webhookHandler struct {
	log     *zap.Logger
	handler func(*admissionv1.AdmissionRequest, *zap.Logger) *admissionv1.AdmissionResponse
}

func newWebhookHandler(
	log *zap.Logger,
	fn func(*admissionv1.AdmissionRequest, *zap.Logger) *admissionv1.AdmissionResponse,
) *webhookHandler {
	return &webhookHandler{log: log, handler: fn}
}

func (h *webhookHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Only accept POST requests
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Read and parse the AdmissionReview from the request body
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // 1MB limit
	if err != nil {
		h.log.Error("Failed to read request body", zap.Error(err))
		http.Error(w, "Failed to read request body", http.StatusBadRequest)
		return
	}

	// Decode the AdmissionReview request
	var admissionReview admissionv1.AdmissionReview
	if err := json.Unmarshal(body, &admissionReview); err != nil {
		h.log.Error("Failed to decode AdmissionReview", zap.Error(err))
		http.Error(w, "Failed to decode AdmissionReview", http.StatusBadRequest)
		return
	}

	if admissionReview.Request == nil {
		http.Error(w, "AdmissionReview.Request is nil", http.StatusBadRequest)
		return
	}

	h.log.Info("Processing admission request",
		zap.String("uid", string(admissionReview.Request.UID)),
		zap.String("kind", admissionReview.Request.Kind.Kind),
		zap.String("namespace", admissionReview.Request.Namespace),
		zap.String("name", admissionReview.Request.Name),
		zap.String("operation", string(admissionReview.Request.Operation)),
	)

	// Call the actual handler function
	response := h.handler(admissionReview.Request, h.log)

	// The response UID must match the request UID
	response.UID = admissionReview.Request.UID

	// Wrap the response in an AdmissionReview
	admissionReview.Response = response

	// Encode and send the response
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(admissionReview); err != nil {
		h.log.Error("Failed to encode response", zap.Error(err))
	}
}
```

### Validating Webhook Handler

```go
// internal/handler/validate.go

package handler

import (
	"encoding/json"
	"fmt"
	"strings"

	admissionv1 "k8s.io/api/admission/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"go.uber.org/zap"
)

// approvedRegistries is the list of approved container image registries
var approvedRegistries = []string{
	"123456789012.dkr.ecr.us-east-1.amazonaws.com/",
	"ghcr.io/acme-corp/",
	"gcr.io/acme-corp-prod/",
	// System images are allowed without restriction
	"registry.k8s.io/",
	"quay.io/",
}

// validatePod validates Pod admission requests
func validatePod(req *admissionv1.AdmissionRequest, log *zap.Logger) *admissionv1.AdmissionResponse {
	// Parse the Pod object from the raw JSON
	var pod corev1.Pod
	if err := json.Unmarshal(req.Object.Raw, &pod); err != nil {
		log.Error("Failed to unmarshal Pod", zap.Error(err))
		return denyResponse(req.UID, fmt.Sprintf("Failed to parse Pod: %v", err))
	}

	var violations []string

	// Collect all containers including init and ephemeral containers
	allContainers := append(pod.Spec.Containers, pod.Spec.InitContainers...)
	allContainers = append(allContainers, pod.Spec.EphemeralContainers...)

	for _, container := range pod.Spec.EphemeralContainers {
		allContainers = append(allContainers, corev1.Container{
			Name:  container.Name,
			Image: container.Image,
		})
	}

	for _, container := range pod.Spec.Containers {
		// Validate image registry
		if violation := validateImageRegistry(container.Image, container.Name); violation != "" {
			violations = append(violations, violation)
		}

		// Validate image tag (no 'latest')
		if violation := validateImageTag(container.Image, container.Name); violation != "" {
			violations = append(violations, violation)
		}

		// Validate resource limits are set
		if violation := validateResourceLimits(container); violation != "" {
			violations = append(violations, violation)
		}
	}

	// Check for required labels
	if violation := validatePodLabels(pod.Labels); violation != "" {
		violations = append(violations, violation)
	}

	if len(violations) > 0 {
		log.Info("Pod validation failed",
			zap.String("name", pod.Name),
			zap.String("namespace", pod.Namespace),
			zap.Strings("violations", violations),
		)
		return denyResponse(req.UID, strings.Join(violations, "; "))
	}

	log.Debug("Pod validation passed",
		zap.String("name", pod.Name),
		zap.String("namespace", pod.Namespace),
	)
	return allowResponse(req.UID)
}

func validateImageRegistry(image, containerName string) string {
	for _, registry := range approvedRegistries {
		if strings.HasPrefix(image, registry) {
			return "" // Approved registry
		}
	}
	return fmt.Sprintf("container %q uses image %q from an unapproved registry", containerName, image)
}

func validateImageTag(image, containerName string) string {
	parts := strings.Split(image, ":")
	if len(parts) == 1 {
		return fmt.Sprintf("container %q image %q has no tag — specify a version tag", containerName, image)
	}
	tag := parts[len(parts)-1]
	if tag == "latest" || tag == "" {
		return fmt.Sprintf("container %q must not use the 'latest' tag", containerName)
	}
	return ""
}

func validateResourceLimits(container corev1.Container) string {
	if container.Resources.Limits == nil {
		return fmt.Sprintf("container %q has no resource limits", container.Name)
	}
	if _, ok := container.Resources.Limits[corev1.ResourceCPU]; !ok {
		return fmt.Sprintf("container %q is missing CPU limit", container.Name)
	}
	if _, ok := container.Resources.Limits[corev1.ResourceMemory]; !ok {
		return fmt.Sprintf("container %q is missing memory limit", container.Name)
	}
	return ""
}

func validatePodLabels(labels map[string]string) string {
	required := []string{
		"app.kubernetes.io/name",
		"app.kubernetes.io/version",
	}
	var missing []string
	for _, label := range required {
		if _, ok := labels[label]; !ok {
			missing = append(missing, label)
		}
	}
	if len(missing) > 0 {
		return fmt.Sprintf("pod is missing required labels: %v", missing)
	}
	return ""
}

// validateDeployment validates Deployment admission requests
func validateDeployment(req *admissionv1.AdmissionRequest, log *zap.Logger) *admissionv1.AdmissionResponse {
	// Handle DELETE operations — nothing to validate
	if req.Operation == admissionv1.Delete {
		return allowResponse(req.UID)
	}

	var deploy interface{}
	if err := json.Unmarshal(req.Object.Raw, &deploy); err != nil {
		return denyResponse(req.UID, fmt.Sprintf("Failed to parse Deployment: %v", err))
	}

	// Use the generic map approach for flexibility
	deployMap := deploy.(map[string]interface{})
	spec := deployMap["spec"].(map[string]interface{})

	// Validate replica count in production namespaces
	if req.Namespace != "dev" && req.Namespace != "sandbox" {
		replicas, ok := spec["replicas"]
		if ok {
			replicaCount := int(replicas.(float64))
			if replicaCount < 2 {
				return &admissionv1.AdmissionResponse{
					UID:     req.UID,
					Allowed: false,
					Result: &metav1.Status{
						Code:    400,
						Message: fmt.Sprintf("Deployment in namespace %q must have at least 2 replicas for HA", req.Namespace),
					},
				}
			}
		}
	}

	return allowResponse(req.UID)
}
```

### Mutating Webhook Handler

```go
// internal/handler/mutate.go

package handler

import (
	"encoding/json"
	"fmt"

	admissionv1 "k8s.io/api/admission/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	"go.uber.org/zap"
)

// JSONPatchOp represents a single JSON Patch operation (RFC 6902)
type JSONPatchOp struct {
	Op    string      `json:"op"`
	Path  string      `json:"path"`
	Value interface{} `json:"value,omitempty"`
}

// defaultCPURequest is the default CPU request injected when absent
var defaultCPURequest = resource.MustParse("100m")

// defaultMemoryRequest is the default memory request injected when absent
var defaultMemoryRequest = resource.MustParse("128Mi")

// defaultCPULimit is the default CPU limit injected when absent
var defaultCPULimit = resource.MustParse("500m")

// defaultMemoryLimit is the default memory limit injected when absent
var defaultMemoryLimit = resource.MustParse("512Mi")

// mutatePod injects default resource limits and security context
func mutatePod(req *admissionv1.AdmissionRequest, log *zap.Logger) *admissionv1.AdmissionResponse {
	// Skip DELETE operations — nothing to mutate
	if req.Operation == admissionv1.Delete {
		return allowResponse(req.UID)
	}

	var pod corev1.Pod
	if err := json.Unmarshal(req.Object.Raw, &pod); err != nil {
		log.Error("Failed to unmarshal Pod for mutation", zap.Error(err))
		// On mutation failure, allow the request unchanged rather than blocking
		// This depends on your failure policy — see failurePolicy field
		return allowResponse(req.UID)
	}

	var patches []JSONPatchOp

	// Inject resource defaults for each container
	for i, container := range pod.Spec.Containers {
		patches = append(patches, buildResourcePatches(i, container, "containers")...)
		patches = append(patches, buildSecurityContextPatches(i, container, "containers")...)
	}

	// Also patch init containers
	for i, container := range pod.Spec.InitContainers {
		patches = append(patches, buildResourcePatches(i, container, "initContainers")...)
	}

	// Add standard labels
	labelPatches := buildLabelPatches(pod.Labels)
	patches = append(patches, labelPatches...)

	if len(patches) == 0 {
		// No patches needed — allow as-is
		return allowResponse(req.UID)
	}

	patchBytes, err := json.Marshal(patches)
	if err != nil {
		log.Error("Failed to marshal patches", zap.Error(err))
		return allowResponse(req.UID)
	}

	log.Info("Mutating Pod",
		zap.String("name", pod.Name),
		zap.String("namespace", pod.Namespace),
		zap.Int("patches", len(patches)),
	)

	patchType := admissionv1.PatchTypeJSONPatch
	return &admissionv1.AdmissionResponse{
		UID:       req.UID,
		Allowed:   true,
		PatchType: &patchType,
		Patch:     patchBytes,
	}
}

// buildResourcePatches builds JSON Patch operations for missing resource specs
func buildResourcePatches(index int, container corev1.Container, containerType string) []JSONPatchOp {
	var patches []JSONPatchOp
	basePath := fmt.Sprintf("/spec/%s/%d", containerType, index)

	// Initialize resources map if completely absent
	if container.Resources.Requests == nil && container.Resources.Limits == nil {
		patches = append(patches, JSONPatchOp{
			Op:    "add",
			Path:  basePath + "/resources",
			Value: map[string]interface{}{},
		})
	}

	// Inject CPU request if absent
	if container.Resources.Requests == nil || container.Resources.Requests.Cpu().IsZero() {
		if container.Resources.Requests == nil {
			patches = append(patches, JSONPatchOp{
				Op:    "add",
				Path:  basePath + "/resources/requests",
				Value: map[string]string{},
			})
		}
		patches = append(patches, JSONPatchOp{
			Op:    "add",
			Path:  basePath + "/resources/requests/cpu",
			Value: defaultCPURequest.String(),
		})
	}

	// Inject memory request if absent
	if container.Resources.Requests == nil || container.Resources.Requests.Memory().IsZero() {
		patches = append(patches, JSONPatchOp{
			Op:    "add",
			Path:  basePath + "/resources/requests/memory",
			Value: defaultMemoryRequest.String(),
		})
	}

	// Inject CPU limit if absent
	if container.Resources.Limits == nil || container.Resources.Limits.Cpu().IsZero() {
		if container.Resources.Limits == nil {
			patches = append(patches, JSONPatchOp{
				Op:    "add",
				Path:  basePath + "/resources/limits",
				Value: map[string]string{},
			})
		}
		patches = append(patches, JSONPatchOp{
			Op:    "add",
			Path:  basePath + "/resources/limits/cpu",
			Value: defaultCPULimit.String(),
		})
	}

	// Inject memory limit if absent
	if container.Resources.Limits == nil || container.Resources.Limits.Memory().IsZero() {
		patches = append(patches, JSONPatchOp{
			Op:    "add",
			Path:  basePath + "/resources/limits/memory",
			Value: defaultMemoryLimit.String(),
		})
	}

	return patches
}

// buildSecurityContextPatches injects default security context when absent
func buildSecurityContextPatches(index int, container corev1.Container, containerType string) []JSONPatchOp {
	var patches []JSONPatchOp
	basePath := fmt.Sprintf("/spec/%s/%d", containerType, index)

	if container.SecurityContext == nil {
		patches = append(patches, JSONPatchOp{
			Op:   "add",
			Path: basePath + "/securityContext",
			Value: map[string]interface{}{
				"allowPrivilegeEscalation": false,
				"readOnlyRootFilesystem":   true,
				"runAsNonRoot":             true,
				"capabilities": map[string]interface{}{
					"drop": []string{"ALL"},
				},
			},
		})
	}

	return patches
}

// buildLabelPatches ensures pods have required labels
func buildLabelPatches(existing map[string]string) []JSONPatchOp {
	var patches []JSONPatchOp

	// Ensure labels map exists
	if existing == nil {
		patches = append(patches, JSONPatchOp{
			Op:    "add",
			Path:  "/metadata/labels",
			Value: map[string]string{},
		})
	}

	// Add managed-by label if absent
	if _, ok := existing["app.kubernetes.io/managed-by"]; !ok {
		patches = append(patches, JSONPatchOp{
			Op:    "add",
			Path:  "/metadata/labels/app.kubernetes.io~1managed-by",
			Value: "acme-webhook",
		})
	}

	return patches
}
```

### Response Helpers

```go
// internal/handler/responses.go

package handler

import (
	admissionv1 "k8s.io/api/admission/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

// allowResponse constructs an allow AdmissionResponse
func allowResponse(uid types.UID) *admissionv1.AdmissionResponse {
	return &admissionv1.AdmissionResponse{
		UID:     uid,
		Allowed: true,
	}
}

// denyResponse constructs a deny AdmissionResponse with a message
func denyResponse(uid types.UID, message string) *admissionv1.AdmissionResponse {
	return &admissionv1.AdmissionResponse{
		UID:     uid,
		Allowed: false,
		Result: &metav1.Status{
			APIVersion: "v1",
			Kind:       "Status",
			Status:     "Failure",
			Message:    message,
			Code:       400,
		},
	}
}

// warnResponse constructs an allow response with a warning message
// Warnings appear in kubectl output but do not block the request
func warnResponse(uid types.UID, warnings []string) *admissionv1.AdmissionResponse {
	return &admissionv1.AdmissionResponse{
		UID:      uid,
		Allowed:  true,
		Warnings: warnings,
	}
}
```

## TLS Certificate Provisioning with cert-manager

### Certificate and Webhook CABundle Injection

```yaml
# config/certificate.yaml — cert-manager Certificate for the webhook server

apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: webhook-server-tls
  namespace: webhook-system
spec:
  secretName: webhook-server-tls

  # Certificate must be valid for the service DNS name
  dnsNames:
    - webhook-server.webhook-system.svc
    - webhook-server.webhook-system.svc.cluster.local

  # Use the cluster-internal CA for signing
  issuerRef:
    name: cluster-ca-issuer
    kind: ClusterIssuer
    group: cert-manager.io

  duration: 8760h  # 1 year
  renewBefore: 720h  # Renew 30 days before expiry

  privateKey:
    algorithm: ECDSA
    size: 256
```

```yaml
# config/validating-webhook.yaml — ValidatingWebhookConfiguration

apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: acme-corp-validating-webhook
  annotations:
    # cert-manager injects the CA bundle automatically from the Certificate
    # The value is the namespace/secret-name of the webhook server's TLS secret
    cert-manager.io/inject-ca-from: "webhook-system/webhook-server-tls"
webhooks:
  - name: validate-pods.webhook.acme-corp.example.com
    # URL path that the API server calls on the webhook server
    clientConfig:
      service:
        name: webhook-server
        namespace: webhook-system
        path: /validate/pods
        port: 443
      # caBundle is populated automatically by cert-manager — leave empty
      caBundle: ""

    # Which operations and resources trigger this webhook
    rules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["pods"]
        scope: "Namespaced"

    # Only apply to namespaces with the label managed=true
    namespaceSelector:
      matchLabels:
        support.tools/managed: "true"

    # Skip objects with the bypass annotation
    objectSelector:
      matchExpressions:
        - key: "webhook.acme-corp.example.com/bypass"
          operator: DoesNotExist

    # Fail means: if the webhook is unreachable, reject the request
    # Use Ignore during initial rollout to avoid blocking deployments
    failurePolicy: Fail

    # Declare side effects for dry-run compatibility
    # None: webhook makes no changes to cluster state
    # NoneOnDryRun: has side effects normally but not during dry-run
    sideEffects: None

    # How long the API server waits before declaring failure
    timeoutSeconds: 10

    # Run during admission only (not for objects already in etcd)
    admissionReviewVersions: ["v1"]

    # matchPolicy: Equivalent matches resources even if accessed via different API versions
    matchPolicy: Equivalent

  - name: validate-deployments.webhook.acme-corp.example.com
    clientConfig:
      service:
        name: webhook-server
        namespace: webhook-system
        path: /validate/deployments
        port: 443
      caBundle: ""
    rules:
      - apiGroups: ["apps"]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["deployments"]
        scope: "Namespaced"
    namespaceSelector:
      matchLabels:
        support.tools/managed: "true"
    failurePolicy: Fail
    sideEffects: None
    timeoutSeconds: 10
    admissionReviewVersions: ["v1"]
```

```yaml
# config/mutating-webhook.yaml — MutatingWebhookConfiguration

apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: acme-corp-mutating-webhook
  annotations:
    cert-manager.io/inject-ca-from: "webhook-system/webhook-server-tls"
webhooks:
  - name: mutate-pods.webhook.acme-corp.example.com
    clientConfig:
      service:
        name: webhook-server
        namespace: webhook-system
        path: /mutate/pods
        port: 443
      caBundle: ""
    rules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        operations: ["CREATE"]  # Mutate on CREATE only — not UPDATE
        resources: ["pods"]
        scope: "Namespaced"
    namespaceSelector:
      matchLabels:
        support.tools/managed: "true"
    # For mutation: Ignore is safer — prevents webhook outage from blocking deploys
    # Once the webhook is stable, switch to Fail
    failurePolicy: Ignore
    # Mutation may have side effects (writing labels to other objects, etc.)
    # If the webhook only modifies the admitted object, use None
    sideEffects: None
    timeoutSeconds: 5
    admissionReviewVersions: ["v1"]
    # reinvocationPolicy: IfNeeded re-invokes the webhook if another webhook
    # modifies the pod after this webhook ran. Use for webhooks that depend on
    # the final state of the object.
    reinvocationPolicy: Never
```

## Webhook Deployment

```yaml
# config/webhook-deployment.yaml

apiVersion: v1
kind: Namespace
metadata:
  name: webhook-system
  labels:
    # Exclude webhook namespace from webhook rules to avoid bootstrapping issues
    support.tools/webhook-exempt: "true"

---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: webhook-server
  namespace: webhook-system

---
# The webhook server needs no RBAC if it doesn't access the API server
# If data replication or API calls are needed, add appropriate roles here

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: webhook-server
  namespace: webhook-system
  labels:
    app.kubernetes.io/name: webhook-server
    app.kubernetes.io/version: "1.0.0"
    app.kubernetes.io/managed-by: helm
spec:
  # Run 2 replicas for HA — single replica causes problems during rollouts
  replicas: 2
  selector:
    matchLabels:
      app.kubernetes.io/name: webhook-server
  template:
    metadata:
      labels:
        app.kubernetes.io/name: webhook-server
        app.kubernetes.io/version: "1.0.0"
    spec:
      serviceAccountName: webhook-server
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: webhook-server
          image: "123456789012.dkr.ecr.us-east-1.amazonaws.com/acme-corp/webhook-server:1.0.0"
          imagePullPolicy: IfNotPresent
          args:
            - --port=8443
            - --cert-file=/etc/webhook/certs/tls.crt
            - --key-file=/etc/webhook/certs/tls.key
            - --log-level=info
          ports:
            - name: https
              containerPort: 8443
              protocol: TCP
          volumeMounts:
            - name: tls-certs
              mountPath: /etc/webhook/certs
              readOnly: true
          resources:
            requests:
              cpu: "50m"
              memory: "64Mi"
            limits:
              cpu: "200m"
              memory: "256Mi"
          livenessProbe:
            httpGet:
              path: /healthz
              port: https
              scheme: HTTPS
            initialDelaySeconds: 5
            periodSeconds: 10
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /readyz
              port: https
              scheme: HTTPS
            initialDelaySeconds: 3
            periodSeconds: 5
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
      volumes:
        - name: tls-certs
          secret:
            secretName: webhook-server-tls
      # Spread replicas across nodes
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    app.kubernetes.io/name: webhook-server
                topologyKey: kubernetes.io/hostname
      # PriorityClass ensures webhook pods survive resource pressure
      priorityClassName: system-cluster-critical

---
apiVersion: v1
kind: Service
metadata:
  name: webhook-server
  namespace: webhook-system
spec:
  selector:
    app.kubernetes.io/name: webhook-server
  ports:
    - name: https
      port: 443
      targetPort: https
      protocol: TCP

---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: webhook-server
  namespace: webhook-system
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: webhook-server
```

## controller-runtime Webhook Builder

### Using controller-runtime for CRD Webhooks

```go
// For operators built with controller-runtime, use the webhook builder
// rather than implementing the HTTP server from scratch

package webhooks

import (
	"context"
	"fmt"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/validation/field"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/webhook"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	myappv1 "github.com/acme-corp/myapp-operator/api/v1"
)

// MyAppWebhook implements both validating and defaulting (mutating) webhooks
// for the MyApp custom resource
type MyAppWebhook struct{}

// SetupWebhookWithManager registers the webhook with the controller-runtime manager
func (r *MyAppWebhook) SetupWebhookWithManager(mgr ctrl.Manager) error {
	return ctrl.NewWebhookManagedBy(mgr).
		For(&myappv1.MyApp{}).
		WithDefaulter(r).  // Mutating webhook
		WithValidator(r).  // Validating webhook
		Complete()
}

// Default implements the mutating webhook — sets default field values
func (r *MyAppWebhook) Default(ctx context.Context, obj runtime.Object) error {
	myapp, ok := obj.(*myappv1.MyApp)
	if !ok {
		return fmt.Errorf("expected a MyApp but got %T", obj)
	}

	log := ctrl.LoggerFrom(ctx)
	log.Info("Setting defaults for MyApp", "name", myapp.Name)

	// Set default replica count
	if myapp.Spec.Replicas == 0 {
		myapp.Spec.Replicas = 1
	}

	// Set default image pull policy
	if myapp.Spec.ImagePullPolicy == "" {
		myapp.Spec.ImagePullPolicy = "IfNotPresent"
	}

	// Set default resource tier
	if myapp.Spec.Tier == "" {
		myapp.Spec.Tier = "standard"
	}

	return nil
}

// ValidateCreate implements the validating webhook for CREATE operations
func (r *MyAppWebhook) ValidateCreate(ctx context.Context, obj runtime.Object) (admission.Warnings, error) {
	myapp, ok := obj.(*myappv1.MyApp)
	if !ok {
		return nil, fmt.Errorf("expected a MyApp but got %T", obj)
	}
	return r.validate(myapp)
}

// ValidateUpdate implements the validating webhook for UPDATE operations
func (r *MyAppWebhook) ValidateUpdate(ctx context.Context, oldObj, newObj runtime.Object) (admission.Warnings, error) {
	myapp, ok := newObj.(*myappv1.MyApp)
	if !ok {
		return nil, fmt.Errorf("expected a MyApp but got %T", newObj)
	}

	old, ok := oldObj.(*myappv1.MyApp)
	if !ok {
		return nil, fmt.Errorf("expected a MyApp but got %T", oldObj)
	}

	// Prevent changing immutable fields
	if old.Spec.DatabaseType != myapp.Spec.DatabaseType {
		return nil, apierrors.NewForbidden(
			myappv1.GroupVersion.WithResource("myapps").GroupResource(),
			myapp.Name,
			field.Forbidden(field.NewPath("spec", "databaseType"), "field is immutable"),
		)
	}

	return r.validate(myapp)
}

// ValidateDelete implements the validating webhook for DELETE operations
func (r *MyAppWebhook) ValidateDelete(ctx context.Context, obj runtime.Object) (admission.Warnings, error) {
	// Allow all deletes
	return nil, nil
}

func (r *MyAppWebhook) validate(myapp *myappv1.MyApp) (admission.Warnings, error) {
	var allErrs field.ErrorList
	var warnings admission.Warnings

	// Validate replica count
	if myapp.Spec.Replicas < 1 {
		allErrs = append(allErrs, field.Invalid(
			field.NewPath("spec", "replicas"),
			myapp.Spec.Replicas,
			"replicas must be at least 1",
		))
	}

	// Warn (but allow) if replicas is 1 in a non-dev namespace
	if myapp.Spec.Replicas == 1 && !strings.HasPrefix(myapp.Namespace, "dev-") {
		warnings = append(warnings, "single replica deployments have no HA — consider replicas: 2")
	}

	// Validate tier values
	validTiers := map[string]bool{"standard": true, "premium": true, "enterprise": true}
	if !validTiers[myapp.Spec.Tier] {
		allErrs = append(allErrs, field.NotSupported(
			field.NewPath("spec", "tier"),
			myapp.Spec.Tier,
			[]string{"standard", "premium", "enterprise"},
		))
	}

	if len(allErrs) > 0 {
		return warnings, apierrors.NewInvalid(
			myappv1.GroupVersion.WithKind("MyApp").GroupKind(),
			myapp.Name,
			allErrs,
		)
	}

	return warnings, nil
}
```

## Webhook Testing

### Testing with curl

```bash
# Test the webhook server directly using curl
# Construct a minimal AdmissionReview request

TEST_POD_JSON=$(cat <<'EOF'
{
  "apiVersion": "admission.k8s.io/v1",
  "kind": "AdmissionReview",
  "request": {
    "uid": "705ab4f5-6393-11e8-b7cc-42010a800002",
    "kind": {"group": "", "version": "v1", "kind": "Pod"},
    "resource": {"group": "", "version": "v1", "resource": "pods"},
    "namespace": "default",
    "operation": "CREATE",
    "userInfo": {
      "username": "kubernetes-admin",
      "groups": ["system:masters"]
    },
    "object": {
      "apiVersion": "v1",
      "kind": "Pod",
      "metadata": {
        "name": "test-pod",
        "namespace": "default",
        "labels": {
          "app.kubernetes.io/name": "test-pod",
          "app.kubernetes.io/version": "1.0.0"
        }
      },
      "spec": {
        "containers": [
          {
            "name": "app",
            "image": "123456789012.dkr.ecr.us-east-1.amazonaws.com/acme-corp/myapp:1.0.0",
            "resources": {
              "limits": {"cpu": "500m", "memory": "512Mi"},
              "requests": {"cpu": "100m", "memory": "128Mi"}
            }
          }
        ]
      }
    }
  }
}
EOF
)

# Send to the webhook server (requires the TLS cert to be trusted or use -k)
curl -s -k \
  -X POST \
  -H "Content-Type: application/json" \
  -d "${TEST_POD_JSON}" \
  https://localhost:8443/validate/pods | jq .

# Test with an invalid pod (missing labels — should be denied)
INVALID_POD_JSON=$(cat <<'EOF'
{
  "apiVersion": "admission.k8s.io/v1",
  "kind": "AdmissionReview",
  "request": {
    "uid": "test-uid-002",
    "kind": {"group": "", "version": "v1", "kind": "Pod"},
    "resource": {"group": "", "version": "v1", "resource": "pods"},
    "namespace": "prod-payments",
    "operation": "CREATE",
    "userInfo": {"username": "dev-user"},
    "object": {
      "apiVersion": "v1",
      "kind": "Pod",
      "metadata": {"name": "bad-pod", "namespace": "prod-payments"},
      "spec": {
        "containers": [
          {"name": "app", "image": "nginx:latest"}
        ]
      }
    }
  }
}
EOF
)

curl -s -k \
  -X POST \
  -H "Content-Type: application/json" \
  -d "${INVALID_POD_JSON}" \
  https://localhost:8443/validate/pods | jq '.response | {allowed, status}'
```

### Go Unit Tests for Webhook Handlers

```go
// internal/handler/validate_test.go

package handler_test

import (
	"encoding/json"
	"testing"

	admissionv1 "k8s.io/api/admission/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"go.uber.org/zap/zaptest"

	"github.com/acme-corp/webhook-server/internal/handler"
)

func makePodRequest(pod corev1.Pod) *admissionv1.AdmissionRequest {
	raw, _ := json.Marshal(pod)
	return &admissionv1.AdmissionRequest{
		UID:       types.UID("test-uid"),
		Operation: admissionv1.Create,
		Kind:      metav1.GroupVersionKind{Group: "", Version: "v1", Kind: "Pod"},
		Namespace: pod.Namespace,
		Name:      pod.Name,
		Object:    runtime.RawExtension{Raw: raw},
	}
}

func TestValidPod(t *testing.T) {
	log := zaptest.NewLogger(t)

	pod := corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "valid-pod",
			Namespace: "payments",
			Labels: map[string]string{
				"app.kubernetes.io/name":    "valid-pod",
				"app.kubernetes.io/version": "1.0.0",
			},
		},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{
				{
					Name:  "app",
					Image: "123456789012.dkr.ecr.us-east-1.amazonaws.com/acme-corp/myapp:1.0.0",
					Resources: corev1.ResourceRequirements{
						Requests: corev1.ResourceList{
							corev1.ResourceCPU:    resource.MustParse("100m"),
							corev1.ResourceMemory: resource.MustParse("128Mi"),
						},
						Limits: corev1.ResourceList{
							corev1.ResourceCPU:    resource.MustParse("500m"),
							corev1.ResourceMemory: resource.MustParse("512Mi"),
						},
					},
				},
			},
		},
	}

	resp := handler.ValidatePodForTest(makePodRequest(pod), log)
	if !resp.Allowed {
		t.Errorf("Expected pod to be allowed, got denied: %v", resp.Result.Message)
	}
}

func TestPodWithLatestTag(t *testing.T) {
	log := zaptest.NewLogger(t)

	pod := corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "latest-pod",
			Namespace: "payments",
			Labels: map[string]string{
				"app.kubernetes.io/name":    "latest-pod",
				"app.kubernetes.io/version": "1.0.0",
			},
		},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{
				{
					Name:  "app",
					Image: "123456789012.dkr.ecr.us-east-1.amazonaws.com/acme-corp/myapp:latest",
				},
			},
		},
	}

	resp := handler.ValidatePodForTest(makePodRequest(pod), log)
	if resp.Allowed {
		t.Error("Expected pod with 'latest' tag to be denied")
	}
	if resp.Result == nil || resp.Result.Message == "" {
		t.Error("Expected denial message to be set")
	}
}
```

## Performance and Failure Policy Considerations

### Timeout and Failure Policy Decision Guide

```
Webhook Importance    | Recommended failurePolicy | Notes
---------------------|--------------------------|---------------------------
Security enforcement  | Fail                      | Use Ignore only during initial rollout
Best practices        | Fail (after stabilization)| Start with Ignore/warn
Mutation (defaults)   | Ignore                    | Missing mutation is better than blocked deploy
Audit/logging only    | Ignore                    | Never block for non-security webhooks

Timeout Guidance:
- Simple logic (label check): 3-5 seconds
- API server calls in webhook: 8-10 seconds (max 30s Kubernetes supports)
- External service calls: Not recommended — use data replication instead

Performance Tips:
- Cache expensive computations between requests (sync.Map with TTL)
- Use objectSelector to filter irrelevant objects before calling the webhook
- Use namespaceSelector to exclude system namespaces
- Profile webhook response times with Prometheus histograms:
  webhook_admission_duration_seconds
```

```yaml
# Add Prometheus metrics to the webhook server
# Instrument the handler with prometheus/client_golang

# Expose metrics on a separate port (not the webhook port)
# config/webhook-service-metrics.yaml

apiVersion: v1
kind: Service
metadata:
  name: webhook-server-metrics
  namespace: webhook-system
  labels:
    app.kubernetes.io/name: webhook-server
spec:
  selector:
    app.kubernetes.io/name: webhook-server
  ports:
    - name: metrics
      port: 9090
      targetPort: 9090

---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: webhook-server
  namespace: webhook-system
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: webhook-server
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
```

Admission webhooks are a powerful but high-responsibility extension point. A webhook with `failurePolicy: Fail` that times out or crashes can block all Pod creation in the cluster. Starting every new webhook with `failurePolicy: Ignore` and switching to `Fail` only after the webhook has proven stable in production is the safest path to enforcement without operational risk.
