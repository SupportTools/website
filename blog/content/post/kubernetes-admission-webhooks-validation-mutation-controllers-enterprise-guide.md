---
title: "Kubernetes Admission Webhooks: Building Custom Validation and Mutation Controllers"
date: 2030-05-14T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Admission Webhooks", "Go", "Security", "Policy Enforcement", "TLS", "Custom Controllers"]
categories:
- Kubernetes
- Security
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide covering validating and mutating admission webhooks, webhook server implementation in Go, TLS certificate management, testing strategies, and production deployment patterns."
more_link: "yes"
url: "/kubernetes-admission-webhooks-validation-mutation-controllers-enterprise-guide/"
---

Admission webhooks represent one of the most powerful extension points in Kubernetes, enabling teams to enforce organizational policies, inject sidecar containers, and validate resource configurations before they are persisted to etcd. Building production-grade admission webhooks requires a thorough understanding of the admission control pipeline, secure TLS termination, idempotent mutation logic, and comprehensive testing strategies that cover both happy paths and adversarial edge cases.

<!--more-->

## Understanding the Admission Control Pipeline

Kubernetes processes every API server request through a chain of admission controllers before writing the object to etcd. The admission pipeline consists of two phases: mutation and validation. Mutating admission webhooks execute first and may modify the incoming object. Validating admission webhooks execute after all mutations are complete and may only accept or reject the request.

```
API Request → Authentication → Authorization → Mutating Admission → Object Validation → Validating Admission → etcd
```

The API server calls registered webhooks via HTTPS, sending an `AdmissionReview` object and expecting an `AdmissionResponse`. The webhook server must respond within the configured timeout (default 10 seconds, minimum 1 second) or the request fails according to the `failurePolicy` setting.

### When to Use Each Webhook Type

Mutating webhooks are appropriate for:
- Injecting sidecar containers (Istio envoy, logging agents, secrets sidecars)
- Setting default values that cannot be expressed via OpenAPI schema defaults
- Adding labels and annotations for policy compliance
- Transforming deprecated API fields to current equivalents

Validating webhooks are appropriate for:
- Enforcing naming conventions and label requirements
- Blocking privileged containers or host namespace usage
- Requiring resource limits and requests on all containers
- Preventing deletion of protected namespaces or resources

## Webhook Server Architecture in Go

A production webhook server requires careful attention to concurrency, TLS configuration, graceful shutdown, and structured logging. The following implementation demonstrates an enterprise-ready webhook server.

### Project Structure

```
webhook-server/
├── cmd/
│   └── webhook-server/
│       └── main.go
├── internal/
│   ├── webhook/
│   │   ├── server.go
│   │   ├── handler.go
│   │   ├── mutate.go
│   │   └── validate.go
│   ├── config/
│   │   └── config.go
│   └── metrics/
│       └── metrics.go
├── pkg/
│   └── admission/
│       ├── review.go
│       └── patcher.go
├── deploy/
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── certificate.yaml
│   └── webhook-configs.yaml
└── Dockerfile
```

### Server Implementation

```go
// internal/webhook/server.go
package webhook

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	admissionv1 "k8s.io/api/admission/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/serializer"
	"go.uber.org/zap"
)

var (
	scheme = runtime.NewScheme()
	codecs = serializer.NewCodecFactory(scheme)
)

// Server holds the webhook HTTP server and its dependencies.
type Server struct {
	logger     *zap.Logger
	httpServer *http.Server
	mutators   map[string]MutationHandler
	validators map[string]ValidationHandler
}

// MutationHandler processes a mutation request for a specific resource type.
type MutationHandler func(ctx context.Context, req *admissionv1.AdmissionRequest) (*admissionv1.AdmissionResponse, error)

// ValidationHandler processes a validation request for a specific resource type.
type ValidationHandler func(ctx context.Context, req *admissionv1.AdmissionRequest) (*admissionv1.AdmissionResponse, error)

// NewServer constructs a webhook server with the provided TLS configuration.
func NewServer(addr string, certFile, keyFile string, logger *zap.Logger) (*Server, error) {
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("loading TLS keypair: %w", err)
	}

	s := &Server{
		logger:     logger,
		mutators:   make(map[string]MutationHandler),
		validators: make(map[string]ValidationHandler),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/mutate/pods", s.serveMutate)
	mux.HandleFunc("/validate/pods", s.serveValidate)
	mux.HandleFunc("/healthz", s.serveHealthz)
	mux.HandleFunc("/readyz", s.serveReadyz)

	s.httpServer = &http.Server{
		Addr:    addr,
		Handler: mux,
		TLSConfig: &tls.Config{
			Certificates: []tls.Certificate{cert},
			MinVersion:   tls.VersionTLS13,
			CipherSuites: []uint16{
				tls.TLS_AES_128_GCM_SHA256,
				tls.TLS_AES_256_GCM_SHA384,
				tls.TLS_CHACHA20_POLY1305_SHA256,
			},
		},
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       120 * time.Second,
		ReadHeaderTimeout: 5 * time.Second,
	}

	return s, nil
}

// Start begins serving TLS requests.
func (s *Server) Start() error {
	s.logger.Info("starting webhook server", zap.String("addr", s.httpServer.Addr))
	return s.httpServer.ListenAndServeTLS("", "")
}

// Shutdown gracefully drains active connections.
func (s *Server) Shutdown(ctx context.Context) error {
	return s.httpServer.Shutdown(ctx)
}

// RegisterMutator maps a resource kind to a mutation handler.
func (s *Server) RegisterMutator(kind string, h MutationHandler) {
	s.mutators[kind] = h
}

// RegisterValidator maps a resource kind to a validation handler.
func (s *Server) RegisterValidator(kind string, h ValidationHandler) {
	s.validators[kind] = h
}

func (s *Server) serveMutate(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // 1 MiB limit
	if err != nil {
		s.logger.Error("reading request body", zap.Error(err))
		http.Error(w, "could not read body", http.StatusBadRequest)
		return
	}

	review, err := decodeAdmissionReview(body)
	if err != nil {
		s.logger.Error("decoding admission review", zap.Error(err))
		http.Error(w, "invalid admission review", http.StatusBadRequest)
		return
	}

	kind := review.Request.Kind.Kind
	handler, ok := s.mutators[kind]
	var response *admissionv1.AdmissionResponse

	if !ok {
		response = allowResponse(review.Request.UID)
	} else {
		response, err = handler(r.Context(), review.Request)
		if err != nil {
			s.logger.Error("mutation handler failed",
				zap.String("kind", kind),
				zap.String("name", review.Request.Name),
				zap.Error(err),
			)
			response = denyResponse(review.Request.UID, err.Error())
		}
	}

	s.writeAdmissionReview(w, review, response)
	s.logger.Info("mutation complete",
		zap.String("kind", kind),
		zap.String("namespace", review.Request.Namespace),
		zap.String("name", review.Request.Name),
		zap.Bool("allowed", response.Allowed),
		zap.Duration("duration", time.Since(start)),
	)
}

func (s *Server) serveValidate(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		s.logger.Error("reading request body", zap.Error(err))
		http.Error(w, "could not read body", http.StatusBadRequest)
		return
	}

	review, err := decodeAdmissionReview(body)
	if err != nil {
		s.logger.Error("decoding admission review", zap.Error(err))
		http.Error(w, "invalid admission review", http.StatusBadRequest)
		return
	}

	kind := review.Request.Kind.Kind
	handler, ok := s.validators[kind]
	var response *admissionv1.AdmissionResponse

	if !ok {
		response = allowResponse(review.Request.UID)
	} else {
		response, err = handler(r.Context(), review.Request)
		if err != nil {
			s.logger.Error("validation handler failed",
				zap.String("kind", kind),
				zap.String("name", review.Request.Name),
				zap.Error(err),
			)
			response = denyResponse(review.Request.UID, err.Error())
		}
	}

	s.writeAdmissionReview(w, review, response)
	s.logger.Info("validation complete",
		zap.String("kind", kind),
		zap.String("namespace", review.Request.Namespace),
		zap.String("name", review.Request.Name),
		zap.Bool("allowed", response.Allowed),
		zap.Duration("duration", time.Since(start)),
	)
}

func (s *Server) serveHealthz(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
}

func (s *Server) serveReadyz(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
}

func (s *Server) writeAdmissionReview(
	w http.ResponseWriter,
	review *admissionv1.AdmissionReview,
	resp *admissionv1.AdmissionResponse,
) {
	review.Response = resp
	review.Response.UID = review.Request.UID

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(review); err != nil {
		s.logger.Error("encoding admission review response", zap.Error(err))
	}
}

func decodeAdmissionReview(data []byte) (*admissionv1.AdmissionReview, error) {
	review := &admissionv1.AdmissionReview{}
	if _, _, err := codecs.UniversalDeserializer().Decode(data, nil, review); err != nil {
		return nil, fmt.Errorf("decoding: %w", err)
	}
	if review.Request == nil {
		return nil, fmt.Errorf("admission review has no request")
	}
	return review, nil
}
```

### JSON Patch Builder

```go
// pkg/admission/patcher.go
package admission

import (
	"encoding/json"
	"fmt"
)

// PatchOp represents a single JSON Patch operation per RFC 6902.
type PatchOp struct {
	Op    string      `json:"op"`
	Path  string      `json:"path"`
	Value interface{} `json:"value,omitempty"`
}

// Patcher accumulates JSON Patch operations.
type Patcher struct {
	ops []PatchOp
}

// Add appends an "add" operation.
func (p *Patcher) Add(path string, value interface{}) *Patcher {
	p.ops = append(p.ops, PatchOp{Op: "add", Path: path, Value: value})
	return p
}

// Replace appends a "replace" operation.
func (p *Patcher) Replace(path string, value interface{}) *Patcher {
	p.ops = append(p.ops, PatchOp{Op: "replace", Path: path, Value: value})
	return p
}

// Remove appends a "remove" operation.
func (p *Patcher) Remove(path string) *Patcher {
	p.ops = append(p.ops, PatchOp{Op: "remove", Path: path})
	return p
}

// Marshal serializes the patch operations to JSON bytes.
func (p *Patcher) Marshal() ([]byte, error) {
	if len(p.ops) == 0 {
		return []byte("[]"), nil
	}
	b, err := json.Marshal(p.ops)
	if err != nil {
		return nil, fmt.Errorf("marshaling patch: %w", err)
	}
	return b, nil
}

// EscapePath converts a label key or annotation key with slashes into a
// JSON Pointer-safe path segment per RFC 6901.
func EscapePath(s string) string {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '~':
			out = append(out, '~', '0')
		case '/':
			out = append(out, '~', '1')
		default:
			out = append(out, s[i])
		}
	}
	return string(out)
}
```

### Sidecar Injection Mutator

```go
// internal/webhook/mutate.go
package webhook

import (
	"context"
	"encoding/json"
	"fmt"

	admissionv1 "k8s.io/api/admission/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	"github.com/example/webhook-server/pkg/admission"
)

const (
	injectAnnotation = "sidecar.example.com/inject"
	injectedLabel    = "sidecar.example.com/injected"
)

// SidecarConfig holds the desired sidecar container specification.
type SidecarConfig struct {
	Name    string
	Image   string
	Version string
}

// PodMutator implements sidecar injection for annotated Pods.
type PodMutator struct {
	sidecar SidecarConfig
}

// NewPodMutator creates a PodMutator with the provided sidecar configuration.
func NewPodMutator(cfg SidecarConfig) *PodMutator {
	return &PodMutator{sidecar: cfg}
}

// Handle processes an AdmissionRequest for a Pod and injects the sidecar if requested.
func (m *PodMutator) Handle(ctx context.Context, req *admissionv1.AdmissionRequest) (*admissionv1.AdmissionResponse, error) {
	if req.Operation == admissionv1.Delete {
		return allowResponse(req.UID), nil
	}

	pod := &corev1.Pod{}
	if err := json.Unmarshal(req.Object.Raw, pod); err != nil {
		return nil, fmt.Errorf("unmarshaling pod: %w", err)
	}

	// Skip if injection not requested.
	if pod.Annotations[injectAnnotation] != "true" {
		return allowResponse(req.UID), nil
	}

	// Skip if already injected (handles update operations idempotently).
	if pod.Labels[injectedLabel] == "true" {
		return allowResponse(req.UID), nil
	}

	patch := &admission.Patcher{}

	// Ensure labels map exists before adding to it.
	if len(pod.Labels) == 0 {
		patch.Add("/metadata/labels", map[string]string{})
	}
	patch.Add("/metadata/labels/"+admission.EscapePath(injectedLabel), "true")

	// Append sidecar container.
	sidecar := m.buildSidecar(pod)
	if len(pod.Spec.Containers) == 0 {
		patch.Add("/spec/containers", []corev1.Container{sidecar})
	} else {
		patch.Add("/spec/containers/-", sidecar)
	}

	// Add shared volume for sidecar-to-app communication.
	sharedVol := corev1.Volume{
		Name: "sidecar-shared",
		VolumeSource: corev1.VolumeSource{
			EmptyDir: &corev1.EmptyDirVolumeSource{},
		},
	}
	if len(pod.Spec.Volumes) == 0 {
		patch.Add("/spec/volumes", []corev1.Volume{sharedVol})
	} else {
		patch.Add("/spec/volumes/-", sharedVol)
	}

	patchBytes, err := patch.Marshal()
	if err != nil {
		return nil, fmt.Errorf("marshaling patch: %w", err)
	}

	patchType := admissionv1.PatchTypeJSONPatch
	return &admissionv1.AdmissionResponse{
		UID:       req.UID,
		Allowed:   true,
		Patch:     patchBytes,
		PatchType: &patchType,
	}, nil
}

func (m *PodMutator) buildSidecar(pod *corev1.Pod) corev1.Container {
	return corev1.Container{
		Name:  m.sidecar.Name,
		Image: fmt.Sprintf("%s:%s", m.sidecar.Image, m.sidecar.Version),
		Resources: corev1.ResourceRequirements{
			Requests: corev1.ResourceList{
				corev1.ResourceCPU:    resource.MustParse("10m"),
				corev1.ResourceMemory: resource.MustParse("32Mi"),
			},
			Limits: corev1.ResourceList{
				corev1.ResourceCPU:    resource.MustParse("100m"),
				corev1.ResourceMemory: resource.MustParse("128Mi"),
			},
		},
		VolumeMounts: []corev1.VolumeMount{
			{
				Name:      "sidecar-shared",
				MountPath: "/var/run/sidecar",
			},
		},
		SecurityContext: &corev1.SecurityContext{
			RunAsNonRoot:             boolPtr(true),
			RunAsUser:                int64Ptr(65534),
			AllowPrivilegeEscalation: boolPtr(false),
			ReadOnlyRootFilesystem:   boolPtr(true),
			Capabilities: &corev1.Capabilities{
				Drop: []corev1.Capability{"ALL"},
			},
		},
	}
}

func allowResponse(uid types.UID) *admissionv1.AdmissionResponse {
	return &admissionv1.AdmissionResponse{UID: uid, Allowed: true}
}

func denyResponse(uid types.UID, message string) *admissionv1.AdmissionResponse {
	return &admissionv1.AdmissionResponse{
		UID:     uid,
		Allowed: false,
		Result: &metav1.Status{
			Message: message,
			Code:    403,
		},
	}
}

func boolPtr(b bool) *bool       { return &b }
func int64Ptr(i int64) *int64    { return &i }
```

### Resource Limits Validator

```go
// internal/webhook/validate.go
package webhook

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	admissionv1 "k8s.io/api/admission/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/types"
)

// PodValidator enforces organizational policies on Pod specifications.
type PodValidator struct{}

// Handle checks a Pod for policy compliance and returns a denial if violations exist.
func (v *PodValidator) Handle(ctx context.Context, req *admissionv1.AdmissionRequest) (*admissionv1.AdmissionResponse, error) {
	if req.Operation == admissionv1.Delete {
		return allowResponse(req.UID), nil
	}

	pod := &corev1.Pod{}
	if err := json.Unmarshal(req.Object.Raw, pod); err != nil {
		return nil, fmt.Errorf("unmarshaling pod: %w", err)
	}

	var violations []string
	violations = append(violations, v.checkResourceLimits(pod)...)
	violations = append(violations, v.checkSecurityContext(pod)...)
	violations = append(violations, v.checkRequiredLabels(pod)...)
	violations = append(violations, v.checkPrivilegedContainers(pod)...)

	if len(violations) > 0 {
		return &admissionv1.AdmissionResponse{
			UID:     req.UID,
			Allowed: false,
			Result: &metav1.Status{
				Message: fmt.Sprintf("policy violations:\n  - %s", strings.Join(violations, "\n  - ")),
				Code:    403,
			},
		}, nil
	}

	return allowResponse(req.UID), nil
}

func (v *PodValidator) checkResourceLimits(pod *corev1.Pod) []string {
	var violations []string
	for _, c := range append(pod.Spec.InitContainers, pod.Spec.Containers...) {
		if c.Resources.Limits == nil {
			violations = append(violations, fmt.Sprintf("container %q has no resource limits", c.Name))
			continue
		}
		if _, ok := c.Resources.Limits[corev1.ResourceCPU]; !ok {
			violations = append(violations, fmt.Sprintf("container %q is missing CPU limit", c.Name))
		}
		if _, ok := c.Resources.Limits[corev1.ResourceMemory]; !ok {
			violations = append(violations, fmt.Sprintf("container %q is missing memory limit", c.Name))
		}
		if c.Resources.Requests == nil {
			violations = append(violations, fmt.Sprintf("container %q has no resource requests", c.Name))
		}
	}
	return violations
}

func (v *PodValidator) checkSecurityContext(pod *corev1.Pod) []string {
	var violations []string
	if pod.Spec.SecurityContext == nil || !boolVal(pod.Spec.SecurityContext.RunAsNonRoot) {
		violations = append(violations, "pod security context must set runAsNonRoot: true")
	}
	for _, c := range pod.Spec.Containers {
		sc := c.SecurityContext
		if sc == nil {
			violations = append(violations, fmt.Sprintf("container %q missing securityContext", c.Name))
			continue
		}
		if !boolVal(sc.AllowPrivilegeEscalation) == false {
			// AllowPrivilegeEscalation defaults to true; must be explicitly set false.
			if sc.AllowPrivilegeEscalation == nil || *sc.AllowPrivilegeEscalation {
				violations = append(violations,
					fmt.Sprintf("container %q must set allowPrivilegeEscalation: false", c.Name))
			}
		}
		if !boolVal(sc.ReadOnlyRootFilesystem) {
			violations = append(violations,
				fmt.Sprintf("container %q must set readOnlyRootFilesystem: true", c.Name))
		}
	}
	return violations
}

func (v *PodValidator) checkRequiredLabels(pod *corev1.Pod) []string {
	required := []string{"app", "version", "team"}
	var violations []string
	for _, label := range required {
		if _, ok := pod.Labels[label]; !ok {
			violations = append(violations, fmt.Sprintf("missing required label %q", label))
		}
	}
	return violations
}

func (v *PodValidator) checkPrivilegedContainers(pod *corev1.Pod) []string {
	var violations []string
	for _, c := range pod.Spec.Containers {
		if c.SecurityContext != nil && boolVal(c.SecurityContext.Privileged) {
			violations = append(violations, fmt.Sprintf("container %q must not run as privileged", c.Name))
		}
		if pod.Spec.HostNetwork {
			violations = append(violations, "pod must not use hostNetwork")
		}
		if pod.Spec.HostPID {
			violations = append(violations, "pod must not use hostPID")
		}
	}
	return violations
}

func boolVal(b *bool) bool {
	if b == nil {
		return false
	}
	return *b
}
```

## TLS Certificate Management

Admission webhooks require valid TLS certificates trusted by the Kubernetes API server. For production, cert-manager is the recommended approach.

### cert-manager Certificate Resource

```yaml
# deploy/certificate.yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: webhook-server-tls
  namespace: webhook-system
spec:
  secretName: webhook-server-tls
  duration: 8760h   # 1 year
  renewBefore: 720h  # 30 days before expiry
  dnsNames:
    - webhook-server.webhook-system.svc
    - webhook-server.webhook-system.svc.cluster.local
  issuerRef:
    name: internal-ca-issuer
    kind: ClusterIssuer
  privateKey:
    algorithm: ECDSA
    size: 256
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: internal-ca-issuer
spec:
  ca:
    secretName: internal-ca-key-pair
```

### Webhook Configuration with caBundle

```yaml
# deploy/webhook-configs.yaml
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: pod-sidecar-injector
  annotations:
    cert-manager.io/inject-ca-from: webhook-system/webhook-server-tls
spec:
  webhooks:
    - name: sidecar-injector.example.com
      admissionReviewVersions: ["v1"]
      sideEffects: None
      failurePolicy: Ignore        # Non-critical: allow pods if webhook is unavailable
      timeoutSeconds: 5
      namespaceSelector:
        matchExpressions:
          - key: sidecar-injection
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
          path: /mutate/pods
          port: 443
        caBundle: ""  # Populated by cert-manager annotation
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: pod-policy-validator
  annotations:
    cert-manager.io/inject-ca-from: webhook-system/webhook-server-tls
spec:
  webhooks:
    - name: pod-validator.example.com
      admissionReviewVersions: ["v1"]
      sideEffects: None
      failurePolicy: Fail           # Critical: block pods that violate policy
      timeoutSeconds: 10
      namespaceSelector:
        matchExpressions:
          - key: policy-enforcement
            operator: In
            values: ["strict"]
          - key: kubernetes.io/metadata.name
            operator: NotIn
            values: ["kube-system", "kube-public", "cert-manager"]
      rules:
        - operations: ["CREATE", "UPDATE"]
          apiGroups: [""]
          apiVersions: ["v1"]
          resources: ["pods"]
      clientConfig:
        service:
          name: webhook-server
          namespace: webhook-system
          path: /validate/pods
          port: 443
        caBundle: ""
```

## Deployment Configuration

### Webhook Server Deployment

```yaml
# deploy/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: webhook-server
  namespace: webhook-system
  labels:
    app: webhook-server
    version: "1.0.0"
    team: platform
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels:
      app: webhook-server
  template:
    metadata:
      labels:
        app: webhook-server
        version: "1.0.0"
        team: platform
    spec:
      serviceAccountName: webhook-server
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        fsGroup: 65534
        seccompProfile:
          type: RuntimeDefault
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: webhook-server
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: webhook-server
      containers:
        - name: webhook-server
          image: registry.example.com/webhook-server:1.0.0
          ports:
            - containerPort: 8443
              name: https
            - containerPort: 9090
              name: metrics
          env:
            - name: TLS_CERT_FILE
              value: /tls/tls.crt
            - name: TLS_KEY_FILE
              value: /tls/tls.key
            - name: LOG_LEVEL
              value: info
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 500m
              memory: 256Mi
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
              scheme: HTTP
            initialDelaySeconds: 5
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /readyz
              port: 8080
              scheme: HTTP
            initialDelaySeconds: 5
            periodSeconds: 5
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          volumeMounts:
            - name: tls
              mountPath: /tls
              readOnly: true
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: tls
          secret:
            secretName: webhook-server-tls
        - name: tmp
          emptyDir: {}
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
    - name: https
      port: 443
      targetPort: 8443
    - name: metrics
      port: 9090
      targetPort: 9090
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: webhook-server
  namespace: webhook-system
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: webhook-server
```

## Testing Strategies

### Unit Testing Admission Handlers

```go
// internal/webhook/validate_test.go
package webhook_test

import (
	"context"
	"encoding/json"
	"testing"

	admissionv1 "k8s.io/api/admission/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"

	"github.com/example/webhook-server/internal/webhook"
)

func TestPodValidator_ResourceLimits(t *testing.T) {
	validator := &webhook.PodValidator{}

	tests := []struct {
		name        string
		pod         *corev1.Pod
		wantAllowed bool
		wantMessage string
	}{
		{
			name:        "compliant pod is allowed",
			pod:         buildCompliantPod("test-pod"),
			wantAllowed: true,
		},
		{
			name: "pod without CPU limit is denied",
			pod: func() *corev1.Pod {
				p := buildCompliantPod("no-cpu-limit")
				p.Spec.Containers[0].Resources.Limits = corev1.ResourceList{
					corev1.ResourceMemory: resource.MustParse("128Mi"),
				}
				return p
			}(),
			wantAllowed: false,
			wantMessage: "CPU limit",
		},
		{
			name: "pod without labels is denied",
			pod: func() *corev1.Pod {
				p := buildCompliantPod("no-labels")
				p.Labels = nil
				return p
			}(),
			wantAllowed: false,
			wantMessage: "missing required label",
		},
		{
			name: "privileged pod is denied",
			pod: func() *corev1.Pod {
				p := buildCompliantPod("privileged")
				privileged := true
				p.Spec.Containers[0].SecurityContext.Privileged = &privileged
				return p
			}(),
			wantAllowed: false,
			wantMessage: "privileged",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw, _ := json.Marshal(tt.pod)
			req := &admissionv1.AdmissionRequest{
				UID:       types.UID("test-uid"),
				Operation: admissionv1.Create,
				Object:    runtime.RawExtension{Raw: raw},
			}

			resp, err := validator.Handle(context.Background(), req)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if resp.Allowed != tt.wantAllowed {
				t.Errorf("allowed = %v, want %v; message: %s",
					resp.Allowed, tt.wantAllowed, resp.Result.Message)
			}
			if !tt.wantAllowed && tt.wantMessage != "" {
				if !strings.Contains(resp.Result.Message, tt.wantMessage) {
					t.Errorf("message %q does not contain %q", resp.Result.Message, tt.wantMessage)
				}
			}
		})
	}
}

func buildCompliantPod(name string) *corev1.Pod {
	allowPrivEsc := false
	readOnly := true
	runAsNonRoot := true
	runAsUser := int64(1000)

	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: "default",
			Labels: map[string]string{
				"app":     "test",
				"version": "1.0.0",
				"team":    "platform",
			},
		},
		Spec: corev1.PodSpec{
			SecurityContext: &corev1.PodSecurityContext{
				RunAsNonRoot: &runAsNonRoot,
				RunAsUser:    &runAsUser,
			},
			Containers: []corev1.Container{
				{
					Name:  "app",
					Image: "nginx:1.25",
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
					SecurityContext: &corev1.SecurityContext{
						AllowPrivilegeEscalation: &allowPrivEsc,
						ReadOnlyRootFilesystem:   &readOnly,
						Capabilities: &corev1.Capabilities{
							Drop: []corev1.Capability{"ALL"},
						},
					},
				},
			},
		},
	}
}
```

### Integration Testing with envtest

```go
// test/integration/webhook_integration_test.go
package integration_test

import (
	"context"
	"path/filepath"
	"testing"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
)

var (
	testEnv *envtest.Environment
	k8sClient client.Client
)

func TestWebhooks(t *testing.T) {
	RegisterFailHandler(Fail)
	RunSpecs(t, "Webhook Integration Suite")
}

var _ = BeforeSuite(func() {
	testEnv = &envtest.Environment{
		CRDDirectoryPaths:     []string{filepath.Join("..", "..", "config", "crd")},
		WebhookInstallOptions: envtest.WebhookInstallOptions{
			Paths: []string{filepath.Join("..", "..", "config", "webhook")},
		},
	}

	cfg, err := testEnv.Start()
	Expect(err).NotTo(HaveOccurred())

	k8sClient, err = client.New(cfg, client.Options{})
	Expect(err).NotTo(HaveOccurred())
})

var _ = AfterSuite(func() {
	Expect(testEnv.Stop()).To(Succeed())
})

var _ = Describe("Pod Validator", func() {
	Context("when creating a pod without resource limits", func() {
		It("should reject the pod", func() {
			pod := &corev1.Pod{
				ObjectMeta: metav1.ObjectMeta{
					Name:      "no-limits",
					Namespace: "default",
				},
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{
						{Name: "app", Image: "nginx:1.25"},
					},
				},
			}
			err := k8sClient.Create(context.Background(), pod)
			Expect(err).To(HaveOccurred())
			Expect(err.Error()).To(ContainSubstring("resource limits"))
		})
	})
})
```

## Production Operational Patterns

### Webhook Metrics with Prometheus

```go
// internal/metrics/metrics.go
package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	WebhookRequestsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "webhook_requests_total",
			Help: "Total number of admission webhook requests processed.",
		},
		[]string{"kind", "operation", "allowed"},
	)

	WebhookRequestDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "webhook_request_duration_seconds",
			Help:    "Duration of admission webhook request processing.",
			Buckets: prometheus.DefBuckets,
		},
		[]string{"kind", "operation"},
	)

	WebhookErrorsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "webhook_errors_total",
			Help: "Total number of errors encountered during webhook processing.",
		},
		[]string{"kind", "error_type"},
	)
)
```

### Namespace Selector Strategy

Namespace selectors are critical for avoiding webhook bootstrap deadlocks. Always exclude the `kube-system` namespace and namespaces hosting the webhook itself.

```yaml
namespaceSelector:
  matchExpressions:
    - key: policy-enforcement
      operator: In
      values: ["strict", "warn"]
    - key: kubernetes.io/metadata.name
      operator: NotIn
      values:
        - kube-system
        - kube-public
        - kube-node-lease
        - cert-manager
        - webhook-system
        - monitoring
```

Label namespaces to opt into enforcement:

```bash
kubectl label namespace production policy-enforcement=strict
kubectl label namespace staging policy-enforcement=strict
kubectl label namespace development policy-enforcement=warn
```

### Object Selector for Fine-Grained Control

```yaml
objectSelector:
  matchExpressions:
    - key: skip-validation
      operator: DoesNotExist
    - key: app.kubernetes.io/managed-by
      operator: NotIn
      values: ["Helm"]  # Exclude Helm hook pods during upgrades
```

## Debugging Admission Webhooks

### Examining API Server Audit Logs

```bash
# Filter admission webhook events from audit log
kubectl logs -n kube-system kube-apiserver-<node> \
  | jq 'select(.annotations["authorization.k8s.io/decision"] == "allow")
        | select(.objectRef.resource == "pods")
        | {time: .requestReceivedTimestamp,
           user: .user.username,
           namespace: .objectRef.namespace,
           name: .objectRef.name}'
```

### Testing Webhooks Manually

```bash
# Port-forward the webhook service for local testing
kubectl port-forward -n webhook-system svc/webhook-server 8443:443

# Craft a test AdmissionReview request
cat <<'EOF' > /tmp/admission-review.json
{
  "apiVersion": "admission.k8s.io/v1",
  "kind": "AdmissionReview",
  "request": {
    "uid": "test-uid-001",
    "kind": {"group": "", "version": "v1", "kind": "Pod"},
    "resource": {"group": "", "version": "v1", "resource": "pods"},
    "operation": "CREATE",
    "namespace": "default",
    "object": {
      "apiVersion": "v1",
      "kind": "Pod",
      "metadata": {
        "name": "test-pod",
        "labels": {"app": "test", "version": "1.0", "team": "platform"}
      },
      "spec": {
        "containers": [{"name": "app", "image": "nginx:1.25"}]
      }
    }
  }
}
EOF

curl -k -X POST \
  -H "Content-Type: application/json" \
  -d @/tmp/admission-review.json \
  https://localhost:8443/validate/pods | jq .
```

### Common Failure Modes and Remediation

| Symptom | Likely Cause | Remediation |
|---------|-------------|-------------|
| `x509: certificate signed by unknown authority` | caBundle mismatch | Verify cert-manager CA injection annotation |
| `context deadline exceeded` | Webhook timeout | Check network policy, increase `timeoutSeconds` |
| All pods pending in namespace | failurePolicy: Fail + webhook down | Restart webhook deployment or use `kubectl delete validatingwebhookconfiguration` temporarily |
| Bootstrap deadlock | Webhook applies to its own namespace | Add webhook-system to namespace exclusion list |
| Mutation not applied | Pod already has injected label | Verify idempotency logic handles updates |

## Upgrade and Maintenance Considerations

### Zero-Downtime Webhook Updates

```bash
# Verify webhook server has adequate replicas before upgrade
kubectl get deployment webhook-server -n webhook-system

# Roll out new image
kubectl set image deployment/webhook-server \
  webhook-server=registry.example.com/webhook-server:1.1.0 \
  -n webhook-system

# Monitor rollout
kubectl rollout status deployment/webhook-server -n webhook-system

# Verify webhooks are processing correctly
kubectl get events -n webhook-system --field-selector reason=AdmissionWebhook
```

### Testing Webhook Changes in Dry-Run Mode

```bash
# Test Pod creation through validation webhook without persisting
kubectl create --dry-run=server -f /tmp/test-pod.yaml

# Verify mutation webhook patches are applied correctly
kubectl apply --dry-run=server -f /tmp/test-pod.yaml -o yaml \
  | grep -A5 'sidecar.example.com'
```

Admission webhooks provide the flexibility to enforce complex organizational policies that cannot be expressed through standard Kubernetes RBAC or admission controllers. Investing in comprehensive testing, robust TLS management, and careful namespace selector configuration yields a secure and maintainable policy enforcement infrastructure that scales with the organization's Kubernetes footprint.
