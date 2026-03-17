---
title: "Kubernetes Admission Webhook Development: Validating and Mutating Webhooks in Go"
date: 2030-02-22T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Admission Webhooks", "Go", "Security", "Policy Enforcement", "Mutating Webhook", "Validating Webhook"]
categories: ["Kubernetes", "Go"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to building Kubernetes admission webhooks from scratch in Go, covering TLS certificate management, validating and mutating webhook implementations, failure policies, local testing, performance optimization, and production deployment patterns."
more_link: "yes"
url: "/kubernetes-admission-webhook-development-go/"
---

Kubernetes admission webhooks are the primary mechanism for enforcing organizational policies, automatically mutating resources at creation time, and integrating external systems into the Kubernetes object lifecycle. They intercept API server requests after authentication and authorization but before persistence, enabling both policy enforcement and automated configuration injection. This guide builds a complete, production-grade admission webhook server in Go from first principles, covering every aspect from TLS setup to performance testing.

<!--more-->

## Admission Webhook Architecture

When a user or controller submits a resource to the Kubernetes API server, the API server sends an `AdmissionReview` request to each registered webhook that matches the resource. The webhook server processes the request and returns an `AdmissionResponse` indicating approval, rejection, or mutation instructions.

Two types of webhooks:

- **MutatingAdmissionWebhook**: Can modify the object and approve or reject it. Called before ValidatingAdmissionWebhooks.
- **ValidatingAdmissionWebhook**: Can only approve or reject; cannot modify. Called after MutatingAdmissionWebhooks have finished.

The lifecycle:
1. Client submits CREATE/UPDATE/DELETE request
2. API server runs admission mutations in order
3. API server runs admission validations in order
4. Object is persisted if all webhooks approve

## Project Structure

```
webhook-server/
├── cmd/
│   └── webhook/
│       └── main.go
├── pkg/
│   ├── webhook/
│   │   ├── server.go         # HTTP server
│   │   ├── mutate.go         # Mutating webhook handlers
│   │   ├── validate.go       # Validating webhook handlers
│   │   └── handler.go        # AdmissionReview processing
│   └── certs/
│       └── manager.go        # Certificate lifecycle management
├── deploy/
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── mutatingwebhookconfiguration.yaml
│   └── validatingwebhookconfiguration.yaml
├── Dockerfile
├── go.mod
└── go.sum
```

## Building the Webhook Server

### go.mod Setup

```go
// go.mod
module github.com/example/webhook-server

go 1.23

require (
    k8s.io/api v0.32.0
    k8s.io/apimachinery v0.32.0
    k8s.io/client-go v0.32.0
    sigs.k8s.io/controller-runtime v0.19.0
    go.opentelemetry.io/otel v1.32.0
    go.opentelemetry.io/otel/trace v1.32.0
    go.uber.org/zap v1.27.0
)
```

### Core Handler: AdmissionReview Processing

```go
// pkg/webhook/handler.go
package webhook

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
    scheme = runtime.NewScheme()
    codecs = serializer.NewCodecFactory(scheme)
)

func init() {
    _ = admissionv1.AddToScheme(scheme)
}

// AdmissionHandler wraps an AdmissionHandlerFunc to implement http.Handler.
type AdmissionHandler struct {
    log    *zap.Logger
    handle func(admissionv1.AdmissionRequest) (*admissionv1.AdmissionResponse, error)
}

// ServeHTTP implements http.Handler.
func (h *AdmissionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // 1 MB limit
    if err != nil {
        h.log.Error("Failed to read request body", zap.Error(err))
        http.Error(w, "failed to read request body", http.StatusBadRequest)
        return
    }
    defer r.Body.Close()

    if len(body) == 0 {
        http.Error(w, "empty request body", http.StatusBadRequest)
        return
    }

    // Decode the AdmissionReview request
    contentType := r.Header.Get("Content-Type")
    if contentType != "application/json" {
        http.Error(w,
            fmt.Sprintf("unsupported content type %q; expected application/json", contentType),
            http.StatusUnsupportedMediaType)
        return
    }

    var admissionReview admissionv1.AdmissionReview
    if _, _, err := codecs.UniversalDeserializer().Decode(body, nil, &admissionReview); err != nil {
        h.log.Error("Failed to decode AdmissionReview", zap.Error(err))
        http.Error(w, "failed to decode AdmissionReview", http.StatusBadRequest)
        return
    }

    if admissionReview.Request == nil {
        http.Error(w, "missing AdmissionReview.Request", http.StatusBadRequest)
        return
    }

    // Call the handler function
    response, err := h.handle(*admissionReview.Request)
    if err != nil {
        h.log.Error("Webhook handler returned error",
            zap.String("uid", string(admissionReview.Request.UID)),
            zap.Error(err))
        response = &admissionv1.AdmissionResponse{
            Allowed: false,
            Result: &metav1.Status{
                Code:    http.StatusInternalServerError,
                Message: "internal webhook error",
            },
        }
    }

    // Set the response UID to match the request
    response.UID = admissionReview.Request.UID

    admissionReview.Response = response
    // Clear the request from the response to reduce payload size
    admissionReview.Request = nil

    // Encode and write the response
    respBody, err := json.Marshal(admissionReview)
    if err != nil {
        h.log.Error("Failed to marshal response", zap.Error(err))
        http.Error(w, "failed to marshal response", http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    if _, err := w.Write(respBody); err != nil {
        h.log.Error("Failed to write response", zap.Error(err))
    }
}
```

### Mutating Webhook: Inject Default Labels and Resource Limits

```go
// pkg/webhook/mutate.go
package webhook

import (
    "encoding/json"
    "fmt"

    admissionv1 "k8s.io/api/admission/v1"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/resource"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/apimachinery/pkg/runtime/serializer"
    "go.uber.org/zap"
)

// MutatePod processes an AdmissionRequest for a Pod and returns
// mutation patches. It:
// 1. Injects a standard set of labels
// 2. Sets default resource requests/limits on containers without them
// 3. Injects a sidecar container for log shipping
func MutatePod(log *zap.Logger) func(admissionv1.AdmissionRequest) (*admissionv1.AdmissionResponse, error) {
    return func(req admissionv1.AdmissionRequest) (*admissionv1.AdmissionResponse, error) {
        // Only process CREATE and UPDATE operations
        if req.Operation != admissionv1.Create && req.Operation != admissionv1.Update {
            return &admissionv1.AdmissionResponse{Allowed: true}, nil
        }

        // Decode the Pod
        var pod corev1.Pod
        if err := json.Unmarshal(req.Object.Raw, &pod); err != nil {
            return nil, fmt.Errorf("decoding pod: %w", err)
        }

        var patches []jsonPatch

        // 1. Inject standard labels
        labelPatches := injectLabels(&pod, map[string]string{
            "app.kubernetes.io/managed-by": "webhook",
            "security/scan-required":       "true",
            "cost-center":                  pod.Namespace,
        })
        patches = append(patches, labelPatches...)

        // 2. Set default resource requests/limits on containers without them
        resourcePatches := setDefaultResources(&pod)
        patches = append(patches, resourcePatches...)

        // 3. Inject log-shipper sidecar if not already present
        if !hasSidecar(&pod, "log-shipper") {
            sidecarPatch := injectLogShipperSidecar(&pod)
            patches = append(patches, sidecarPatch)
        }

        if len(patches) == 0 {
            return &admissionv1.AdmissionResponse{Allowed: true}, nil
        }

        patchBytes, err := json.Marshal(patches)
        if err != nil {
            return nil, fmt.Errorf("marshaling patches: %w", err)
        }

        patchType := admissionv1.PatchTypeJSONPatch
        log.Info("Mutating pod",
            zap.String("name", pod.Name),
            zap.String("namespace", pod.Namespace),
            zap.Int("patch_count", len(patches)))

        return &admissionv1.AdmissionResponse{
            Allowed:   true,
            PatchType: &patchType,
            Patch:     patchBytes,
        }, nil
    }
}

// jsonPatch represents a single RFC 6902 JSON Patch operation.
type jsonPatch struct {
    Op    string      `json:"op"`
    Path  string      `json:"path"`
    Value interface{} `json:"value,omitempty"`
}

func injectLabels(pod *corev1.Pod, labels map[string]string) []jsonPatch {
    var patches []jsonPatch

    if pod.Labels == nil {
        patches = append(patches, jsonPatch{
            Op:    "add",
            Path:  "/metadata/labels",
            Value: map[string]string{},
        })
    }

    for k, v := range labels {
        if _, exists := pod.Labels[k]; !exists {
            patches = append(patches, jsonPatch{
                Op: "add",
                // JSON pointer: escape '/' in label keys
                Path:  "/metadata/labels/" + jsonPointerEscape(k),
                Value: v,
            })
        }
    }
    return patches
}

func setDefaultResources(pod *corev1.Pod) []jsonPatch {
    var patches []jsonPatch

    defaultRequests := corev1.ResourceList{
        corev1.ResourceCPU:    resource.MustParse("100m"),
        corev1.ResourceMemory: resource.MustParse("128Mi"),
    }
    defaultLimits := corev1.ResourceList{
        corev1.ResourceCPU:    resource.MustParse("500m"),
        corev1.ResourceMemory: resource.MustParse("512Mi"),
    }

    for i, container := range pod.Spec.Containers {
        basePath := fmt.Sprintf("/spec/containers/%d/resources", i)

        if container.Resources.Requests == nil {
            patches = append(patches, jsonPatch{
                Op:    "add",
                Path:  basePath + "/requests",
                Value: defaultRequests,
            })
        }

        if container.Resources.Limits == nil {
            patches = append(patches, jsonPatch{
                Op:    "add",
                Path:  basePath + "/limits",
                Value: defaultLimits,
            })
        }
    }
    return patches
}

func hasSidecar(pod *corev1.Pod, name string) bool {
    for _, c := range pod.Spec.Containers {
        if c.Name == name {
            return true
        }
    }
    return false
}

func injectLogShipperSidecar(pod *corev1.Pod) jsonPatch {
    sidecar := corev1.Container{
        Name:  "log-shipper",
        Image: "registry.example.com/platform/log-shipper:1.2.0",
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
        VolumeMounts: []corev1.VolumeMount{
            {
                Name:      "varlog",
                MountPath: "/var/log",
                ReadOnly:  true,
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

    return jsonPatch{
        Op:    "add",
        Path:  "/spec/containers/-",
        Value: sidecar,
    }
}

func jsonPointerEscape(s string) string {
    // RFC 6901: '~' -> '~0', '/' -> '~1'
    result := ""
    for _, c := range s {
        switch c {
        case '~':
            result += "~0"
        case '/':
            result += "~1"
        default:
            result += string(c)
        }
    }
    return result
}

func boolPtr(b bool) *bool     { return &b }
func int64Ptr(i int64) *int64  { return &i }
```

### Validating Webhook: Security Policy Enforcement

```go
// pkg/webhook/validate.go
package webhook

import (
    "encoding/json"
    "fmt"
    "strings"

    admissionv1 "k8s.io/api/admission/v1"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "go.uber.org/zap"
)

// ValidationResult accumulates policy violations.
type ValidationResult struct {
    violations []string
}

func (r *ValidationResult) Deny(reason string, args ...interface{}) {
    r.violations = append(r.violations, fmt.Sprintf(reason, args...))
}

func (r *ValidationResult) Allowed() bool {
    return len(r.violations) == 0
}

func (r *ValidationResult) Summary() string {
    if r.Allowed() {
        return ""
    }
    return "Policy violations:\n- " + strings.Join(r.violations, "\n- ")
}

// ValidatePod enforces security policies on Pod creation and updates.
func ValidatePod(log *zap.Logger) func(admissionv1.AdmissionRequest) (*admissionv1.AdmissionResponse, error) {
    return func(req admissionv1.AdmissionRequest) (*admissionv1.AdmissionResponse, error) {
        if req.Operation != admissionv1.Create && req.Operation != admissionv1.Update {
            return &admissionv1.AdmissionResponse{Allowed: true}, nil
        }

        var pod corev1.Pod
        if err := json.Unmarshal(req.Object.Raw, &pod); err != nil {
            return nil, fmt.Errorf("decoding pod: %w", err)
        }

        result := &ValidationResult{}
        validatePodSecurity(&pod, result)
        validateContainerImages(&pod, result)
        validateResourceRequirements(&pod, result)
        validateNetworkPolicies(&pod, result)

        if !result.Allowed() {
            log.Warn("Pod rejected by security policy",
                zap.String("name", pod.Name),
                zap.String("namespace", pod.Namespace),
                zap.Strings("violations", result.violations))

            return &admissionv1.AdmissionResponse{
                Allowed: false,
                Result: &metav1.Status{
                    Code:    403,
                    Message: result.Summary(),
                },
            }, nil
        }

        return &admissionv1.AdmissionResponse{Allowed: true}, nil
    }
}

func validatePodSecurity(pod *corev1.Pod, r *ValidationResult) {
    spec := &pod.Spec

    // Pods must not run as root unless explicitly permitted
    if spec.SecurityContext != nil && spec.SecurityContext.RunAsUser != nil {
        if *spec.SecurityContext.RunAsUser == 0 {
            if _, ok := pod.Labels["security/allow-root"]; !ok {
                r.Deny("pod security context sets runAsUser=0 (root) without security/allow-root label")
            }
        }
    }

    // HostNetwork, HostPID, HostIPC are forbidden
    if spec.HostNetwork {
        r.Deny("hostNetwork=true is not permitted; use ClusterIP services instead")
    }
    if spec.HostPID {
        r.Deny("hostPID=true is not permitted")
    }
    if spec.HostIPC {
        r.Deny("hostIPC=true is not permitted")
    }

    // Host path volumes are restricted
    for _, vol := range spec.Volumes {
        if vol.HostPath != nil {
            allowedHostPaths := []string{"/var/log", "/etc/ssl/certs"}
            allowed := false
            for _, p := range allowedHostPaths {
                if strings.HasPrefix(vol.HostPath.Path, p) {
                    allowed = true
                    break
                }
            }
            if !allowed {
                r.Deny("hostPath volume %q uses path %q which is not in the allowed list",
                    vol.Name, vol.HostPath.Path)
            }
        }
    }
}

func validateContainerImages(pod *corev1.Pod, r *ValidationResult) {
    allowedRegistries := []string{
        "registry.example.com/",
        "gcr.io/distroless/",
        "public.ecr.aws/",
    }

    allContainers := append(pod.Spec.InitContainers, pod.Spec.Containers...)

    for _, c := range allContainers {
        allowed := false
        for _, reg := range allowedRegistries {
            if strings.HasPrefix(c.Image, reg) {
                allowed = true
                break
            }
        }
        if !allowed {
            r.Deny("container %q uses image %q from an unapproved registry; allowed registries: %v",
                c.Name, c.Image, allowedRegistries)
        }

        // Images must be pinned to a specific digest or tag (not :latest)
        if strings.HasSuffix(c.Image, ":latest") || !strings.Contains(c.Image, ":") {
            r.Deny("container %q must use a pinned image tag (not :latest and not untagged)",
                c.Name)
        }
    }
}

func validateResourceRequirements(pod *corev1.Pod, r *ValidationResult) {
    for _, c := range pod.Spec.Containers {
        if c.Resources.Requests == nil {
            r.Deny("container %q has no resource requests defined", c.Name)
            continue
        }
        if c.Resources.Limits == nil {
            r.Deny("container %q has no resource limits defined", c.Name)
            continue
        }

        // Memory limit must be set (OOM prevention)
        if _, ok := c.Resources.Limits[corev1.ResourceMemory]; !ok {
            r.Deny("container %q has no memory limit", c.Name)
        }

        // CPU request must be set (scheduler correctness)
        if _, ok := c.Resources.Requests[corev1.ResourceCPU]; !ok {
            r.Deny("container %q has no CPU request", c.Name)
        }
    }
}

func validateNetworkPolicies(pod *corev1.Pod, r *ValidationResult) {
    // Pods in restricted namespaces must have specific labels
    // for NetworkPolicy selection
    restrictedNamespaces := map[string]bool{
        "production": true,
        "staging":    true,
    }

    if _, ok := restrictedNamespaces[pod.Namespace]; ok {
        if _, hasNetLabel := pod.Labels["network-policy"]; !hasNetLabel {
            r.Deny("pod in namespace %q must have a 'network-policy' label for NetworkPolicy selection",
                pod.Namespace)
        }
    }
}
```

### HTTP Server with TLS

```go
// pkg/webhook/server.go
package webhook

import (
    "context"
    "crypto/tls"
    "net/http"
    "time"

    "go.opentelemetry.io/otel"
    "go.uber.org/zap"
)

// Config holds the webhook server configuration.
type Config struct {
    Port     string
    CertFile string
    KeyFile  string
}

// Server is the admission webhook HTTPS server.
type Server struct {
    log    *zap.Logger
    server *http.Server
    cfg    Config
}

// New creates a new webhook Server.
func New(cfg Config, log *zap.Logger) (*Server, error) {
    mux := http.NewServeMux()

    // Health and readiness endpoints
    mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
        _, _ = w.Write([]byte("ok"))
    })

    // Mutating webhook endpoint
    mutatePodHandler := &AdmissionHandler{
        log:    log.Named("mutate-pod"),
        handle: MutatePod(log),
    }
    mux.Handle("/mutate/pods", instrumented(mutatePodHandler, "mutate_pods"))

    // Validating webhook endpoint
    validatePodHandler := &AdmissionHandler{
        log:    log.Named("validate-pod"),
        handle: ValidatePod(log),
    }
    mux.Handle("/validate/pods", instrumented(validatePodHandler, "validate_pods"))

    // Load TLS certificate
    cert, err := tls.LoadX509KeyPair(cfg.CertFile, cfg.KeyFile)
    if err != nil {
        return nil, err
    }

    tlsCfg := &tls.Config{
        Certificates: []tls.Certificate{cert},
        MinVersion:   tls.VersionTLS13,
        // Restrict cipher suites
        CipherSuites: []uint16{
            tls.TLS_AES_128_GCM_SHA256,
            tls.TLS_AES_256_GCM_SHA384,
            tls.TLS_CHACHA20_POLY1305_SHA256,
        },
    }

    httpServer := &http.Server{
        Addr:         ":" + cfg.Port,
        Handler:      mux,
        TLSConfig:    tlsCfg,
        ReadTimeout:  5 * time.Second,
        WriteTimeout: 10 * time.Second,
        IdleTimeout:  120 * time.Second,
    }

    return &Server{log: log, server: httpServer, cfg: cfg}, nil
}

// Run starts the HTTPS server and blocks until ctx is cancelled.
func (s *Server) Run(ctx context.Context) error {
    errCh := make(chan error, 1)
    go func() {
        s.log.Info("Starting webhook server", zap.String("addr", s.server.Addr))
        if err := s.server.ListenAndServeTLS("", ""); err != nil && err != http.ErrServerClosed {
            errCh <- err
        }
        close(errCh)
    }()

    select {
    case <-ctx.Done():
        shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
        defer cancel()
        if err := s.server.Shutdown(shutdownCtx); err != nil {
            s.log.Error("Webhook server shutdown error", zap.Error(err))
        }
        return ctx.Err()
    case err := <-errCh:
        return err
    }
}

// instrumented wraps a handler with OpenTelemetry tracing.
func instrumented(h http.Handler, operation string) http.Handler {
    tracer := otel.Tracer("admission-webhook")
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        ctx, span := tracer.Start(r.Context(), operation)
        defer span.End()
        h.ServeHTTP(w, r.WithContext(ctx))
    })
}
```

## Certificate Management with cert-manager

The webhook server requires a valid TLS certificate trusted by the Kubernetes API server. The cleanest approach uses cert-manager to issue and rotate the certificate automatically, and the `caBundle` field in the webhook configuration is kept in sync via cert-manager's CA injector.

```yaml
# deploy/certificate.yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: webhook-tls
  namespace: webhook-system
spec:
  secretName: webhook-tls
  # 90-day certificates, renewed 30 days before expiry
  duration: 2160h
  renewBefore: 720h
  isCA: false
  subject:
    organizations:
    - "example.com"
  dnsNames:
  - webhook-server.webhook-system.svc
  - webhook-server.webhook-system.svc.cluster.local
  issuerRef:
    name: cluster-issuer
    kind: ClusterIssuer
    group: cert-manager.io
```

```yaml
# deploy/mutatingwebhookconfiguration.yaml
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: pod-mutation-webhook
  annotations:
    # cert-manager CA injector: automatically sets caBundle
    cert-manager.io/inject-ca-from: "webhook-system/webhook-tls"
webhooks:
- name: mutate.pods.webhook-system.svc
  admissionReviewVersions: ["v1"]
  sideEffects: None

  # Scope the webhook to specific namespaces
  namespaceSelector:
    matchExpressions:
    - key: webhook-injection
      operator: In
      values: ["enabled"]

  # Only match Pod resources
  rules:
  - operations: ["CREATE", "UPDATE"]
    apiGroups: [""]
    apiVersions: ["v1"]
    resources: ["pods"]
    scope: "Namespaced"

  clientConfig:
    service:
      name: webhook-server
      namespace: webhook-system
      path: "/mutate/pods"
      port: 443
    caBundle: ""  # Populated by cert-manager CA injector

  # FAIL_OPEN: if the webhook is unavailable, allow the operation
  # FAIL_CLOSED: if unavailable, reject the operation
  # For non-critical mutations, use Ignore
  failurePolicy: Ignore

  # Don't apply to our own webhook server pods
  objectSelector:
    matchExpressions:
    - key: app.kubernetes.io/name
      operator: NotIn
      values: ["webhook-server"]

  # Timeout: API server will give up after this duration
  timeoutSeconds: 5

  # Re-invocation: call the webhook again if another webhook
  # modified the object (enables composition of mutating webhooks)
  reinvocationPolicy: IfNeeded
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: pod-validation-webhook
  annotations:
    cert-manager.io/inject-ca-from: "webhook-system/webhook-tls"
webhooks:
- name: validate.pods.webhook-system.svc
  admissionReviewVersions: ["v1"]
  sideEffects: None
  namespaceSelector:
    matchExpressions:
    - key: webhook-injection
      operator: In
      values: ["enabled"]
  rules:
  - operations: ["CREATE", "UPDATE"]
    apiGroups: [""]
    apiVersions: ["v1"]
    resources: ["pods"]
  clientConfig:
    service:
      name: webhook-server
      namespace: webhook-system
      path: "/validate/pods"
      port: 443
    caBundle: ""
  # FAIL_CLOSED for validation: reject if webhook unavailable
  failurePolicy: Fail
  timeoutSeconds: 5
```

## Local Testing Without a Cluster

Testing admission webhooks locally is challenging because the API server needs to reach the webhook over HTTPS. The two standard approaches:

### Using kwok for Lightweight API Server

```bash
# Install kwok (Kubernetes Without Kubelet)
go install sigs.k8s.io/kwok/cmd/kwok@latest
go install sigs.k8s.io/kwok/cmd/kwokctl@latest

# Create a local cluster with kwok
kwokctl create cluster --name webhook-dev

# Forward the webhook server port
kubectl port-forward -n webhook-system svc/webhook-server 8443:443 &

# Now run the webhook server locally with the cluster's CA
CERT_FILE=./testdata/server.crt \
KEY_FILE=./testdata/server.key \
PORT=8443 \
./webhook-server
```

### Unit Testing the Webhook Logic

```go
// pkg/webhook/validate_test.go
package webhook

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
    "go.uber.org/zap/zaptest"
)

func makeAdmissionRequest(t *testing.T, pod *corev1.Pod) admissionv1.AdmissionRequest {
    t.Helper()
    raw, err := json.Marshal(pod)
    require.NoError(t, err)
    return admissionv1.AdmissionRequest{
        UID:       "test-uid-001",
        Operation: admissionv1.Create,
        Namespace: pod.Namespace,
        Name:      pod.Name,
        Object:    runtime.RawExtension{Raw: raw},
    }
}

func TestValidatePod_AllowsCompliantPod(t *testing.T) {
    log := zaptest.NewLogger(t)
    validate := ValidatePod(log)

    pod := &corev1.Pod{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "compliant-pod",
            Namespace: "default",
            Labels: map[string]string{
                "network-policy": "restricted",
            },
        },
        Spec: corev1.PodSpec{
            Containers: []corev1.Container{
                {
                    Name:  "app",
                    Image: "registry.example.com/myapp:v1.0.0",
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

    resp, err := validate(makeAdmissionRequest(t, pod))
    require.NoError(t, err)
    assert.True(t, resp.Allowed)
}

func TestValidatePod_RejectsLatestTag(t *testing.T) {
    log := zaptest.NewLogger(t)
    validate := ValidatePod(log)

    pod := &corev1.Pod{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "bad-pod",
            Namespace: "default",
        },
        Spec: corev1.PodSpec{
            Containers: []corev1.Container{
                {
                    Name:  "app",
                    Image: "registry.example.com/myapp:latest",
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

    resp, err := validate(makeAdmissionRequest(t, pod))
    require.NoError(t, err)
    assert.False(t, resp.Allowed)
    assert.Contains(t, resp.Result.Message, "pinned image tag")
}

func TestValidatePod_RejectsHostNetwork(t *testing.T) {
    log := zaptest.NewLogger(t)
    validate := ValidatePod(log)

    pod := &corev1.Pod{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "hostnet-pod",
            Namespace: "default",
        },
        Spec: corev1.PodSpec{
            HostNetwork: true,
            Containers: []corev1.Container{
                {
                    Name:  "app",
                    Image: "registry.example.com/myapp:v1.0.0",
                },
            },
        },
    }

    resp, err := validate(makeAdmissionRequest(t, pod))
    require.NoError(t, err)
    assert.False(t, resp.Allowed)
    assert.Contains(t, resp.Result.Message, "hostNetwork=true")
}

func TestMutatePod_InjectsDefaultLabels(t *testing.T) {
    log := zaptest.NewLogger(t)
    mutate := MutatePod(log)

    pod := &corev1.Pod{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "test-pod",
            Namespace: "default",
        },
        Spec: corev1.PodSpec{
            Containers: []corev1.Container{
                {
                    Name:  "app",
                    Image: "registry.example.com/myapp:v1.0.0",
                },
            },
        },
    }

    resp, err := mutate(makeAdmissionRequest(t, pod))
    require.NoError(t, err)
    assert.True(t, resp.Allowed)
    require.NotNil(t, resp.Patch)

    var patches []jsonPatch
    require.NoError(t, json.Unmarshal(resp.Patch, &patches))

    // Verify the standard labels are in the patches
    labelKeys := make(map[string]bool)
    for _, p := range patches {
        if p.Op == "add" {
            labelKeys[p.Path] = true
        }
    }
    assert.True(t, labelKeys["/metadata/labels/app.kubernetes.io~1managed-by"])
}
```

## Performance Considerations

Admission webhooks are on the critical path of every Kubernetes object creation. High latency or unavailability causes cluster-wide degradation.

```yaml
# Deployment with proper anti-affinity and replicas
apiVersion: apps/v1
kind: Deployment
metadata:
  name: webhook-server
  namespace: webhook-system
spec:
  replicas: 3
  selector:
    matchLabels:
      app.kubernetes.io/name: webhook-server
  template:
    metadata:
      labels:
        app.kubernetes.io/name: webhook-server
    spec:
      # Spread across availability zones
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app.kubernetes.io/name: webhook-server

      # High priority to survive resource pressure
      priorityClassName: system-cluster-critical

      containers:
      - name: webhook
        image: registry.example.com/platform/webhook-server:1.0.0
        ports:
        - containerPort: 8443
          name: https
        - containerPort: 8080
          name: metrics
        resources:
          requests:
            cpu: "100m"
            memory: "128Mi"
          limits:
            cpu: "500m"
            memory: "512Mi"
        livenessProbe:
          httpGet:
            path: /healthz
            port: https
            scheme: HTTPS
          initialDelaySeconds: 5
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /healthz
            port: https
            scheme: HTTPS
          initialDelaySeconds: 3
          periodSeconds: 5
        volumeMounts:
        - name: tls-certs
          mountPath: /etc/tls
          readOnly: true
      volumes:
      - name: tls-certs
        secret:
          secretName: webhook-tls
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: webhook-server-pdb
  namespace: webhook-system
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app.kubernetes.io/name: webhook-server
```

## Key Takeaways

Admission webhooks are the most powerful policy enforcement mechanism available in Kubernetes because they operate at the API server level and cannot be bypassed by users with kubectl or API access. Every organization running production Kubernetes should have at minimum a validating webhook enforcing resource limits, approved image registries, and security context requirements.

The failure policy choice (`Fail` vs. `Ignore`) is a critical operational decision. Validating webhooks that enforce security requirements should use `Fail` to prevent policy bypass when the webhook is unavailable. Mutating webhooks that inject non-critical configuration (labels, sidecars) should use `Ignore` to prevent cluster operations from blocking during webhook maintenance.

TLS certificate management via cert-manager's CA injector eliminates the manual `caBundle` management that historically made webhooks fragile during certificate rotation. Use cert-manager for all production webhook TLS.

The `timeoutSeconds` field (default 10, maximum 30) combined with `failurePolicy: Fail` means that a slow webhook can block all resource creation in targeted namespaces. Design webhooks to complete in under 100ms at the 99th percentile, maintain 3+ replicas across availability zones, and use PodDisruptionBudgets to prevent unsafe disruptions during node maintenance.

Unit testing webhook logic by directly calling handler functions (without an actual Kubernetes API server) is the most efficient development workflow. Reserve integration tests against a real cluster for the webhook configuration itself (correct selectors, namespace matching, certificate setup).
