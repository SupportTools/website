---
title: "Kubernetes Mutating Admission Webhooks: Automated Policy Enforcement and Configuration Injection"
date: 2030-06-12T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Admission Webhooks", "Policy", "Security", "Sidecar Injection", "Automation", "Go"]
categories:
- Kubernetes
- Security
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to mutating webhooks: JSON Patch operations, strategic merge patches, sidecar injection patterns, defaulting webhooks, webhook failure policies, and testing mutation logic."
more_link: "yes"
url: "/kubernetes-mutating-admission-webhooks-policy-enforcement/"
---

Mutating admission webhooks intercept Kubernetes API requests before objects are persisted and modify them based on cluster policy. This mechanism powers some of the most critical Kubernetes infrastructure: Istio's automatic sidecar injection, cert-manager's annotation-based certificate provisioning, and OPA Gatekeeper's policy mutation. Building custom mutating webhooks enables platform teams to enforce configuration standards, inject operational tooling, and implement defaulting logic without requiring developers to know every required field. This guide covers the implementation patterns and operational considerations for production webhook deployments.

<!--more-->

## Admission Webhook Architecture

### The Admission Chain

Every create, update, and delete request to the Kubernetes API passes through the admission chain before being persisted to etcd:

```
Client Request
     ↓
Authentication
     ↓
Authorization (RBAC)
     ↓
Mutating Admission Webhooks  ← External HTTP calls to webhook servers
     ↓
Schema Validation (CRD validation, OpenAPI)
     ↓
Validating Admission Webhooks
     ↓
Persisted to etcd
```

Mutating webhooks run before validating webhooks. Multiple mutating webhooks can operate on the same request; they run in sorted order by name and each sees the object as modified by the previous webhook.

### Request and Response Format

The API server sends `AdmissionReview` objects to webhook servers and expects `AdmissionReview` responses:

```json
// Request from API server to webhook
{
  "apiVersion": "admission.k8s.io/v1",
  "kind": "AdmissionReview",
  "request": {
    "uid": "705ab4f5-6393-11e8-b7cc-42010a800002",
    "kind": {"group": "", "version": "v1", "resource": "pods"},
    "resource": {"group": "", "version": "v1", "resource": "pods"},
    "requestKind": {"group": "", "version": "v1", "resource": "pods"},
    "name": "my-pod",
    "namespace": "production",
    "operation": "CREATE",
    "userInfo": {"username": "alice"},
    "object": { /* the Pod JSON */ },
    "oldObject": null,
    "dryRun": false
  }
}

// Response from webhook to API server
{
  "apiVersion": "admission.k8s.io/v1",
  "kind": "AdmissionReview",
  "response": {
    "uid": "705ab4f5-6393-11e8-b7cc-42010a800002",
    "allowed": true,
    "patchType": "JSONPatch",
    "patch": "<base64-encoded-json-patch>"
  }
}
```

## JSON Patch Operations

RFC 6902 JSON Patch is the standard format for expressing mutations. Each patch is an array of operations:

### JSON Patch Reference

```json
[
  // add: Insert a value at a path (creates intermediate nodes)
  {"op": "add", "path": "/metadata/labels/environment", "value": "production"},

  // replace: Replace existing value
  {"op": "replace", "path": "/spec/containers/0/imagePullPolicy", "value": "Always"},

  // remove: Delete a field
  {"op": "remove", "path": "/metadata/annotations/debug-mode"},

  // copy: Copy a value from one path to another
  {"op": "copy", "from": "/metadata/labels/app", "path": "/metadata/labels/app-name"},

  // move: Move a value from one path to another
  {"op": "move", "from": "/spec/containers/0/env/0", "path": "/spec/containers/0/env/-"},

  // test: Verify a value (fails the patch if test fails)
  {"op": "test", "path": "/metadata/namespace", "value": "production"}
]
```

### Path Reference for Kubernetes Objects

```json
// Common Kubernetes object paths
"/metadata/name"
"/metadata/namespace"
"/metadata/labels/my-label"
"/metadata/annotations/annotation-key"
"/spec/containers/0/image"           // First container image
"/spec/containers/0/env/-"           // Append to env array
"/spec/containers/0/resources/limits/memory"
"/spec/initContainers/-"             // Append to initContainers
"/spec/volumes/-"                    // Append to volumes
"/spec/serviceAccountName"
"/spec/securityContext/runAsNonRoot"
```

## Building a Mutating Webhook in Go

### Project Structure

```
webhook/
├── cmd/
│   └── webhook/
│       └── main.go
├── internal/
│   └── webhook/
│       ├── handler.go
│       ├── mutate.go
│       ├── patch.go
│       └── types.go
├── config/
│   ├── deployment.yaml
│   ├── service.yaml
│   └── webhook-config.yaml
└── Dockerfile
```

### Webhook Server Implementation

```go
// internal/webhook/handler.go
package webhook

import (
    "encoding/json"
    "fmt"
    "io"
    "net/http"

    admissionv1 "k8s.io/api/admission/v1"
    corev1 "k8s.io/api/core/v1"
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

func init() {
    admissionv1.AddToScheme(runtimeScheme)
    corev1.AddToScheme(runtimeScheme)
}

// Handler processes admission webhook requests.
type Handler struct {
    logger   *zap.Logger
    mutators []Mutator
}

// Mutator defines the interface for a mutation function.
type Mutator interface {
    // Mutate accepts the raw pod bytes and returns JSON Patch operations.
    // Returns nil, nil if no mutation is needed.
    Mutate(pod *corev1.Pod, req *admissionv1.AdmissionRequest) ([]PatchOperation, error)
}

// NewHandler creates a new webhook handler.
func NewHandler(logger *zap.Logger, mutators ...Mutator) *Handler {
    return &Handler{
        logger:   logger,
        mutators: mutators,
    }
}

// ServeHTTP handles the admission webhook HTTP request.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    body, err := io.ReadAll(r.Body)
    if err != nil {
        h.logger.Error("failed to read request body", zap.Error(err))
        http.Error(w, "failed to read body", http.StatusBadRequest)
        return
    }

    if len(body) == 0 {
        h.logger.Warn("empty request body")
        http.Error(w, "empty body", http.StatusBadRequest)
        return
    }

    contentType := r.Header.Get("Content-Type")
    if contentType != "application/json" {
        h.logger.Warn("invalid content type", zap.String("content_type", contentType))
        http.Error(w, "invalid content type", http.StatusUnsupportedMediaType)
        return
    }

    var admissionReview admissionv1.AdmissionReview
    if _, _, err := deserializer.Decode(body, nil, &admissionReview); err != nil {
        h.logger.Error("failed to decode admission review", zap.Error(err))
        http.Error(w, fmt.Sprintf("decode error: %v", err), http.StatusBadRequest)
        return
    }

    req := admissionReview.Request
    h.logger.Info("admission request",
        zap.String("uid", string(req.UID)),
        zap.String("kind", req.Kind.Kind),
        zap.String("namespace", req.Namespace),
        zap.String("name", req.Name),
        zap.String("operation", string(req.Operation)),
    )

    response := h.admit(req)
    response.UID = req.UID

    admissionReview.Response = response

    w.Header().Set("Content-Type", "application/json")
    if err := json.NewEncoder(w).Encode(admissionReview); err != nil {
        h.logger.Error("failed to encode response", zap.Error(err))
    }
}

func (h *Handler) admit(req *admissionv1.AdmissionRequest) *admissionv1.AdmissionResponse {
    var pod corev1.Pod
    if err := json.Unmarshal(req.Object.Raw, &pod); err != nil {
        h.logger.Error("failed to unmarshal pod", zap.Error(err))
        return &admissionv1.AdmissionResponse{
            Result: &metav1.Status{
                Message: fmt.Sprintf("failed to unmarshal pod: %v", err),
                Code:    http.StatusBadRequest,
            },
        }
    }

    var allPatches []PatchOperation
    for _, mutator := range h.mutators {
        patches, err := mutator.Mutate(&pod, req)
        if err != nil {
            h.logger.Error("mutator failed",
                zap.String("mutator", fmt.Sprintf("%T", mutator)),
                zap.Error(err))
            return &admissionv1.AdmissionResponse{
                Result: &metav1.Status{
                    Message: fmt.Sprintf("mutation failed: %v", err),
                    Code:    http.StatusInternalServerError,
                },
            }
        }
        allPatches = append(allPatches, patches...)
    }

    if len(allPatches) == 0 {
        return &admissionv1.AdmissionResponse{Allowed: true}
    }

    patchBytes, err := json.Marshal(allPatches)
    if err != nil {
        return &admissionv1.AdmissionResponse{
            Result: &metav1.Status{
                Message: fmt.Sprintf("failed to marshal patches: %v", err),
                Code:    http.StatusInternalServerError,
            },
        }
    }

    patchType := admissionv1.PatchTypeJSONPatch
    return &admissionv1.AdmissionResponse{
        Allowed:   true,
        PatchType: &patchType,
        Patch:     patchBytes,
    }
}
```

### Patch Operation Types

```go
// internal/webhook/patch.go
package webhook

import "encoding/json"

// PatchOperation represents a single JSON Patch operation.
type PatchOperation struct {
    Op    string          `json:"op"`
    Path  string          `json:"path"`
    Value json.RawMessage `json:"value,omitempty"`
    From  string          `json:"from,omitempty"`
}

// Add creates an "add" patch operation.
func Add(path string, value interface{}) (PatchOperation, error) {
    v, err := json.Marshal(value)
    if err != nil {
        return PatchOperation{}, fmt.Errorf("marshaling add value: %w", err)
    }
    return PatchOperation{Op: "add", Path: path, Value: v}, nil
}

// Replace creates a "replace" patch operation.
func Replace(path string, value interface{}) (PatchOperation, error) {
    v, err := json.Marshal(value)
    if err != nil {
        return PatchOperation{}, fmt.Errorf("marshaling replace value: %w", err)
    }
    return PatchOperation{Op: "replace", Path: path, Value: v}, nil
}

// Remove creates a "remove" patch operation.
func Remove(path string) PatchOperation {
    return PatchOperation{Op: "remove", Path: path}
}

// AddOrReplace returns an "add" operation if the field does not exist,
// or "replace" if it does.
func AddOrReplace(path string, value interface{}, exists bool) (PatchOperation, error) {
    if exists {
        return Replace(path, value)
    }
    return Add(path, value)
}
```

## Mutation Patterns

### Pattern 1: Label and Annotation Defaulting

```go
// internal/webhook/mutate_labels.go
package webhook

import (
    "fmt"

    admissionv1 "k8s.io/api/admission/v1"
    corev1 "k8s.io/api/core/v1"
)

// LabelDefaulter adds required labels to pods that are missing them.
type LabelDefaulter struct {
    DefaultLabels map[string]string
}

func (m *LabelDefaulter) Mutate(pod *corev1.Pod, req *admissionv1.AdmissionRequest) ([]PatchOperation, error) {
    var patches []PatchOperation

    // Initialize labels map if it doesn't exist
    if pod.Labels == nil {
        p, err := Add("/metadata/labels", map[string]string{})
        if err != nil {
            return nil, err
        }
        patches = append(patches, p)
    }

    for key, defaultValue := range m.DefaultLabels {
        if _, exists := pod.Labels[key]; !exists {
            p, err := Add(fmt.Sprintf("/metadata/labels/%s", jsonPatchEscapePath(key)), defaultValue)
            if err != nil {
                return nil, fmt.Errorf("adding label %q: %w", key, err)
            }
            patches = append(patches, p)
        }
    }

    return patches, nil
}

// jsonPatchEscapePath escapes special characters in JSON Pointer paths.
func jsonPatchEscapePath(s string) string {
    s = strings.ReplaceAll(s, "~", "~0")
    s = strings.ReplaceAll(s, "/", "~1")
    return s
}
```

### Pattern 2: Resource Limit Injection

```go
// ResourceLimitInjector ensures all containers have resource limits set.
type ResourceLimitInjector struct {
    DefaultCPULimit    string
    DefaultMemoryLimit string
    DefaultCPURequest  string
    DefaultMemoryRequest string
}

func (m *ResourceLimitInjector) Mutate(pod *corev1.Pod, req *admissionv1.AdmissionRequest) ([]PatchOperation, error) {
    var patches []PatchOperation

    for i, container := range pod.Spec.Containers {
        containerPatches, err := m.ensureContainerLimits(i, container)
        if err != nil {
            return nil, fmt.Errorf("container %d (%s): %w", i, container.Name, err)
        }
        patches = append(patches, containerPatches...)
    }

    return patches, nil
}

func (m *ResourceLimitInjector) ensureContainerLimits(idx int, c corev1.Container) ([]PatchOperation, error) {
    var patches []PatchOperation
    basePath := fmt.Sprintf("/spec/containers/%d/resources", idx)

    // Add resources map if it doesn't exist
    if c.Resources.Limits == nil && c.Resources.Requests == nil {
        p, err := Add(basePath, corev1.ResourceRequirements{})
        if err != nil {
            return nil, err
        }
        patches = append(patches, p)
    }

    // Add limits if missing
    if c.Resources.Limits == nil {
        p, err := Add(basePath+"/limits", map[string]string{})
        if err != nil {
            return nil, err
        }
        patches = append(patches, p)
    }

    if _, ok := c.Resources.Limits[corev1.ResourceCPU]; !ok {
        p, err := Add(basePath+"/limits/cpu", m.DefaultCPULimit)
        if err != nil {
            return nil, err
        }
        patches = append(patches, p)
    }

    if _, ok := c.Resources.Limits[corev1.ResourceMemory]; !ok {
        p, err := Add(basePath+"/limits/memory", m.DefaultMemoryLimit)
        if err != nil {
            return nil, err
        }
        patches = append(patches, p)
    }

    return patches, nil
}
```

### Pattern 3: Sidecar Injection

```go
// SidecarInjector injects a sidecar container when a specific annotation is present.
type SidecarInjector struct {
    AnnotationKey string        // e.g., "example.com/inject-sidecar"
    Sidecar       corev1.Container
    SidecarVolumes []corev1.Volume
}

func (m *SidecarInjector) Mutate(pod *corev1.Pod, req *admissionv1.AdmissionRequest) ([]PatchOperation, error) {
    // Check if injection is requested
    if pod.Annotations == nil {
        return nil, nil
    }
    if val := pod.Annotations[m.AnnotationKey]; val != "true" && val != "enabled" {
        return nil, nil
    }

    // Check if already injected (idempotency)
    for _, container := range pod.Spec.Containers {
        if container.Name == m.Sidecar.Name {
            return nil, nil  // Already injected
        }
    }

    var patches []PatchOperation

    // Initialize containers array if needed (shouldn't happen for pods)
    if pod.Spec.Containers == nil {
        p, err := Add("/spec/containers", []corev1.Container{})
        if err != nil {
            return nil, err
        }
        patches = append(patches, p)
    }

    // Inject sidecar container
    p, err := Add("/spec/containers/-", m.Sidecar)
    if err != nil {
        return nil, fmt.Errorf("adding sidecar container: %w", err)
    }
    patches = append(patches, p)

    // Add sidecar volumes
    if pod.Spec.Volumes == nil {
        vp, err := Add("/spec/volumes", []corev1.Volume{})
        if err != nil {
            return nil, err
        }
        patches = append(patches, vp)
    }

    for _, volume := range m.SidecarVolumes {
        vp, err := Add("/spec/volumes/-", volume)
        if err != nil {
            return nil, fmt.Errorf("adding volume %q: %w", volume.Name, err)
        }
        patches = append(patches, vp)
    }

    // Add status annotation to mark injection complete
    if pod.Annotations == nil {
        ap, err := Add("/metadata/annotations", map[string]string{})
        if err != nil {
            return nil, err
        }
        patches = append(patches, ap)
    }

    injected, err := Add(
        fmt.Sprintf("/metadata/annotations/%s", jsonPatchEscapePath("example.com/sidecar-injected")),
        "true",
    )
    if err != nil {
        return nil, err
    }
    patches = append(patches, injected)

    return patches, nil
}
```

### Pattern 4: Security Context Enforcement

```go
// SecurityContextEnforcer ensures pods run with secure defaults.
type SecurityContextEnforcer struct{}

func (m *SecurityContextEnforcer) Mutate(pod *corev1.Pod, req *admissionv1.AdmissionRequest) ([]PatchOperation, error) {
    var patches []PatchOperation

    // Ensure pod-level security context
    if pod.Spec.SecurityContext == nil {
        p, err := Add("/spec/securityContext", corev1.PodSecurityContext{})
        if err != nil {
            return nil, err
        }
        patches = append(patches, p)
    }

    // Set runAsNonRoot if not set
    if pod.Spec.SecurityContext == nil || pod.Spec.SecurityContext.RunAsNonRoot == nil {
        truth := true
        p, err := Add("/spec/securityContext/runAsNonRoot", truth)
        if err != nil {
            return nil, err
        }
        patches = append(patches, p)
    }

    // Ensure each container has securityContext
    for i, container := range pod.Spec.Containers {
        basePath := fmt.Sprintf("/spec/containers/%d/securityContext", i)

        if container.SecurityContext == nil {
            p, err := Add(basePath, corev1.SecurityContext{})
            if err != nil {
                return nil, err
            }
            patches = append(patches, p)

            // Add all security defaults
            noPrivEsc := false
            p2, _ := Add(basePath+"/allowPrivilegeEscalation", noPrivEsc)
            patches = append(patches, p2)
        }
    }

    return patches, nil
}
```

## MutatingWebhookConfiguration

### Webhook Registration

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: platform-webhook
  labels:
    app: platform-webhook
  annotations:
    # cert-manager injects the CA bundle automatically when this annotation is present
    cert-manager.io/inject-ca-from: platform-system/platform-webhook-cert
spec:
  webhooks:
    - name: pod-defaults.platform.example.com
      # Rules define what this webhook fires on
      rules:
        - operations: ["CREATE", "UPDATE"]
          apiGroups: [""]
          apiVersions: ["v1"]
          resources: ["pods"]
          scope: Namespaced
      # Namespace selector — only fire for namespaces with this label
      namespaceSelector:
        matchExpressions:
          - key: platform-webhooks
            operator: In
            values: ["enabled"]
      # Object selector — skip system pods
      objectSelector:
        matchExpressions:
          - key: app.kubernetes.io/managed-by
            operator: NotIn
            values: ["Helm"]  # Skip Helm-managed pods in flight
      clientConfig:
        service:
          name: platform-webhook
          namespace: platform-system
          path: /mutate-pods
          port: 443
        # caBundle is injected by cert-manager
        caBundle: ""
      # FailurePolicy controls what happens when the webhook is unavailable
      failurePolicy: Ignore  # or Fail
      # How long to wait for the webhook response
      timeoutSeconds: 10
      # Only call the webhook once per object (prevents loops)
      reinvocationPolicy: Never
      # Whether to match dry-run requests
      admissionReviewVersions: ["v1"]
      sideEffects: None  # Required: None, NoneOnDryRun, Some, Unknown
```

### Failure Policy Selection

```yaml
# failurePolicy: Fail
# The API request fails if the webhook is unavailable.
# Use for: security-critical mutations (sidecar injection for mTLS)
# Risk: Webhook outage blocks all Pod creation in matched namespaces
failurePolicy: Fail

# failurePolicy: Ignore
# The API request proceeds if the webhook is unavailable.
# Use for: best-effort defaulting (label injection, annotations)
# Risk: Policy may not be applied during webhook outage
failurePolicy: Ignore
```

### Namespace Exemptions

Always exempt the webhook's own namespace and system namespaces to prevent deadlock:

```yaml
namespaceSelector:
  matchExpressions:
    - key: platform-webhooks
      operator: In
      values: ["enabled"]
    # Explicit exemptions
    - key: kubernetes.io/metadata.name
      operator: NotIn
      values:
        - kube-system
        - kube-public
        - platform-system  # Webhook's own namespace — CRITICAL
        - cert-manager
```

## TLS Configuration

Admission webhooks require HTTPS with a CA bundle registered in the `MutatingWebhookConfiguration`. The recommended approach is cert-manager with the CA injector:

```yaml
# Certificate for the webhook server
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: platform-webhook-cert
  namespace: platform-system
spec:
  secretName: platform-webhook-tls
  dnsNames:
    - platform-webhook.platform-system.svc
    - platform-webhook.platform-system.svc.cluster.local
  issuerRef:
    name: cluster-issuer
    kind: ClusterIssuer
```

```go
// cmd/webhook/main.go — TLS server setup
package main

import (
    "crypto/tls"
    "net/http"
    "os"

    "go.uber.org/zap"
)

func main() {
    logger, _ := zap.NewProduction()
    defer logger.Sync()

    certFile := os.Getenv("TLS_CERT_FILE")
    keyFile := os.Getenv("TLS_KEY_FILE")
    if certFile == "" {
        certFile = "/etc/webhook/tls/tls.crt"
    }
    if keyFile == "" {
        keyFile = "/etc/webhook/tls/tls.key"
    }

    mux := http.NewServeMux()

    mutators := []webhook.Mutator{
        &webhook.LabelDefaulter{
            DefaultLabels: map[string]string{
                "platform-managed": "true",
            },
        },
        &webhook.ResourceLimitInjector{
            DefaultCPULimit:      "500m",
            DefaultMemoryLimit:   "512Mi",
            DefaultCPURequest:    "50m",
            DefaultMemoryRequest: "64Mi",
        },
        &webhook.SecurityContextEnforcer{},
    }

    handler := webhook.NewHandler(logger, mutators...)
    mux.Handle("/mutate-pods", handler)
    mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    })

    server := &http.Server{
        Addr:    ":8443",
        Handler: mux,
        TLSConfig: &tls.Config{
            MinVersion: tls.VersionTLS13,
        },
    }

    logger.Info("starting webhook server", zap.String("addr", ":8443"))
    if err := server.ListenAndServeTLS(certFile, keyFile); err != nil {
        logger.Fatal("server failed", zap.Error(err))
    }
}
```

## Testing Webhook Logic

### Unit Testing Mutation Logic

```go
package webhook_test

import (
    "encoding/json"
    "testing"

    admissionv1 "k8s.io/api/admission/v1"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/runtime"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

    "github.com/example/platform-webhook/internal/webhook"
)

func podToRaw(t *testing.T, pod *corev1.Pod) runtime.RawExtension {
    t.Helper()
    b, err := json.Marshal(pod)
    if err != nil {
        t.Fatalf("failed to marshal pod: %v", err)
    }
    return runtime.RawExtension{Raw: b}
}

func TestLabelDefaulter_AddsMissingLabels(t *testing.T) {
    mutator := &webhook.LabelDefaulter{
        DefaultLabels: map[string]string{
            "platform-managed": "true",
            "environment":      "production",
        },
    }

    pod := &corev1.Pod{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "test-pod",
            Namespace: "production",
            Labels: map[string]string{
                "app": "my-app",  // Existing label should be preserved
            },
        },
    }

    req := &admissionv1.AdmissionRequest{
        UID:       "test-uid",
        Operation: admissionv1.Create,
    }

    patches, err := mutator.Mutate(pod, req)
    if err != nil {
        t.Fatalf("unexpected error: %v", err)
    }

    // Should add 2 missing labels
    if len(patches) != 2 {
        t.Errorf("expected 2 patches, got %d: %v", len(patches), patches)
    }

    // Verify patch operations
    patchMap := make(map[string]string)
    for _, p := range patches {
        var val string
        json.Unmarshal(p.Value, &val)
        patchMap[p.Path] = val
    }

    if patchMap["/metadata/labels/platform-managed"] != "true" {
        t.Error("expected platform-managed label to be set to 'true'")
    }
    if patchMap["/metadata/labels/environment"] != "production" {
        t.Error("expected environment label to be set to 'production'")
    }
}

func TestLabelDefaulter_SkipsExistingLabels(t *testing.T) {
    mutator := &webhook.LabelDefaulter{
        DefaultLabels: map[string]string{
            "environment": "production",
        },
    }

    pod := &corev1.Pod{
        ObjectMeta: metav1.ObjectMeta{
            Labels: map[string]string{
                "environment": "staging",  // Existing value should be preserved
            },
        },
    }

    patches, err := mutator.Mutate(pod, &admissionv1.AdmissionRequest{})
    if err != nil {
        t.Fatalf("unexpected error: %v", err)
    }

    if len(patches) != 0 {
        t.Errorf("expected no patches for existing label, got: %v", patches)
    }
}
```

### Integration Testing with envtest

```go
package integration_test

import (
    "context"
    "path/filepath"
    "testing"

    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/envtest"
)

func TestWebhookIntegration(t *testing.T) {
    env := &envtest.Environment{
        WebhookInstallOptions: envtest.WebhookInstallOptions{
            Paths: []string{filepath.Join("..", "config", "webhook")},
        },
    }

    cfg, err := env.Start()
    if err != nil {
        t.Fatalf("failed to start test environment: %v", err)
    }
    defer env.Stop()

    k8sClient, err := client.New(cfg, client.Options{})
    if err != nil {
        t.Fatalf("failed to create client: %v", err)
    }

    // Create a namespace with the webhook enabled
    ns := &corev1.Namespace{
        ObjectMeta: metav1.ObjectMeta{
            Name:   "webhook-test",
            Labels: map[string]string{"platform-webhooks": "enabled"},
        },
    }
    if err := k8sClient.Create(context.Background(), ns); err != nil {
        t.Fatalf("failed to create namespace: %v", err)
    }

    // Create a pod without required labels
    pod := &corev1.Pod{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "test-pod",
            Namespace: "webhook-test",
        },
        Spec: corev1.PodSpec{
            Containers: []corev1.Container{
                {
                    Name:  "app",
                    Image: "nginx:alpine",
                },
            },
        },
    }

    if err := k8sClient.Create(context.Background(), pod); err != nil {
        t.Fatalf("failed to create pod: %v", err)
    }

    // Verify the webhook injected the required labels
    var createdPod corev1.Pod
    if err := k8sClient.Get(context.Background(),
        client.ObjectKey{Namespace: "webhook-test", Name: "test-pod"},
        &createdPod); err != nil {
        t.Fatalf("failed to get pod: %v", err)
    }

    if createdPod.Labels["platform-managed"] != "true" {
        t.Errorf("expected platform-managed label, got labels: %v", createdPod.Labels)
    }
}
```

## Deployment Configuration

### Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: platform-webhook
  namespace: platform-system
spec:
  replicas: 3  # HA for Fail policy webhooks
  selector:
    matchLabels:
      app: platform-webhook
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0  # Never reduce capacity below 3 during rollout
  template:
    metadata:
      labels:
        app: platform-webhook
    spec:
      serviceAccountName: platform-webhook
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: platform-webhook
      containers:
        - name: webhook
          image: registry.example.com/platform-webhook:v1.2.0
          ports:
            - containerPort: 8443
          env:
            - name: TLS_CERT_FILE
              value: /etc/webhook/tls/tls.crt
            - name: TLS_KEY_FILE
              value: /etc/webhook/tls/tls.key
          volumeMounts:
            - name: tls
              mountPath: /etc/webhook/tls
              readOnly: true
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8443
              scheme: HTTPS
            initialDelaySeconds: 5
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8443
              scheme: HTTPS
            initialDelaySeconds: 15
            periodSeconds: 15
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 256Mi
          securityContext:
            runAsNonRoot: true
            runAsUser: 65534
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: [ALL]
      volumes:
        - name: tls
          secret:
            secretName: platform-webhook-tls
```

### PodDisruptionBudget for High Availability

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: platform-webhook-pdb
  namespace: platform-system
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: platform-webhook
```

## Operational Considerations

### Webhook Performance Impact

Every Pod admission request makes an HTTP call to the webhook. Measure and monitor the latency:

```yaml
# Prometheus metrics from the webhook server
histogram_quantile(0.99,
  rate(webhook_admission_duration_seconds_bucket[5m])
)

# Track API server webhook latency
histogram_quantile(0.99,
  rate(apiserver_admission_webhook_admission_duration_seconds_bucket{
    name="pod-defaults.platform.example.com"
  }[5m])
)
```

Target latency: P99 < 100ms. If the webhook exceeds `timeoutSeconds`, the API server either fails or ignores (per `failurePolicy`).

### Preventing Infinite Loops

If a webhook modifies a Pod and the modification triggers another admission request, the webhook can loop. Prevent this with:

1. `reinvocationPolicy: Never` — Do not call the webhook more than once per admission
2. Idempotency checks — Return empty patches if the object already has the desired state
3. Object selectors — Exclude already-mutated objects

```yaml
objectSelector:
  matchExpressions:
    - key: example.com/webhook-mutated
      operator: DoesNotExist
```

## Summary

Mutating admission webhooks provide a powerful extension point for enforcing cluster-wide policies without modifying application manifests. The patterns covered here — label defaulting, resource limit injection, sidecar injection, and security context enforcement — represent the most common enterprise use cases.

Production webhook deployments require careful attention to availability (3+ replicas with PodDisruptionBudgets), TLS management via cert-manager, failure policy selection that matches the criticality of the mutation, and namespace exemptions to prevent deadlock. The combination of unit tests for mutation logic and envtest integration tests provides the confidence needed to deploy webhooks that modify every Pod in a cluster.
