---
title: "Kubernetes Admission Webhooks: Building Policy Enforcement with Go"
date: 2028-10-02T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Admission Webhooks", "Security", "Policy", "Go"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Build ValidatingAdmissionWebhook and MutatingAdmissionWebhook servers in Go with TLS via cert-manager, sidecar injection, image tag enforcement, and integration testing."
more_link: "yes"
url: "/kubernetes-admission-webhooks-policy-enforcement-guide/"
---

Admission webhooks are the most powerful extensibility mechanism in Kubernetes for enforcing organizational policies. Unlike OPA/Gatekeeper which uses Rego, admission webhooks let you enforce any policy you can express in Go, call external APIs, mutate resources in-flight, and return rich error messages. This guide builds a production webhook server from scratch, covering TLS certificate management, the full AdmissionReview protocol, sidecar injection, image tag enforcement, and a complete integration test suite.

<!--more-->

# Kubernetes Admission Webhooks: Building Policy Enforcement with Go

## Admission Controller Architecture

When a client submits a resource to the Kubernetes API server, it passes through an ordered chain of admission controllers before being persisted to etcd. Webhook admission controllers sit at the end of this chain in two phases:

1. **MutatingAdmissionWebhook**: Called first. Can modify the incoming object by returning a JSON patch.
2. **ValidatingAdmissionWebhook**: Called after all mutations. Can only allow or reject; no modifications.

Both types receive an `AdmissionReview` object via HTTPS POST and must respond with an `AdmissionReview` containing an `AdmissionResponse`. The API server enforces the `failurePolicy` field—if your webhook is unreachable, `Fail` policy rejects the request while `Ignore` allows it through.

## Project Structure

```
admission-webhook/
├── cmd/
│   └── webhook/
│       └── main.go
├── internal/
│   ├── handler/
│   │   ├── handler.go
│   │   ├── validate.go
│   │   └── mutate.go
│   └── policy/
│       ├── image_tag.go
│       └── resource_limits.go
├── deploy/
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── certificate.yaml
│   ├── validating-webhook.yaml
│   └── mutating-webhook.yaml
├── tests/
│   └── integration_test.go
├── go.mod
└── Dockerfile
```

## Go Module Setup

```bash
mkdir admission-webhook && cd admission-webhook
go mod init github.com/yourorg/admission-webhook
go get k8s.io/api@v0.28.4
go get k8s.io/apimachinery@v0.28.4
go get sigs.k8s.io/controller-runtime@v0.16.3
go get go.uber.org/zap@v1.26.0
go get github.com/prometheus/client_golang@v1.17.0
```

## Core HTTP Handler

The webhook handler parses the incoming `AdmissionReview`, routes to the appropriate policy function, and serializes the response:

```go
// internal/handler/handler.go
package handler

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
	codecFactory  = serializer.NewCodecFactory(runtimeScheme)
	deserializer  = codecFactory.UniversalDeserializer()
)

// Handler holds shared dependencies for webhook handlers.
type Handler struct {
	log             *zap.Logger
	validatePolicies []ValidatePolicy
	mutatePolicies  []MutatePolicy
}

// ValidatePolicy is a function that validates an AdmissionRequest.
// Returns (allowed bool, reason string, err error).
type ValidatePolicy func(req *admissionv1.AdmissionRequest) (bool, string, error)

// MutatePolicy is a function that mutates an AdmissionRequest.
// Returns a JSON Patch or nil if no changes are needed.
type MutatePolicy func(req *admissionv1.AdmissionRequest) ([]PatchOperation, error)

// PatchOperation is a single JSON Patch operation.
type PatchOperation struct {
	Op    string      `json:"op"`
	Path  string      `json:"path"`
	Value interface{} `json:"value,omitempty"`
}

// New creates a new Handler.
func New(log *zap.Logger, validate []ValidatePolicy, mutate []MutatePolicy) *Handler {
	return &Handler{
		log:             log,
		validatePolicies: validate,
		mutatePolicies:  mutate,
	}
}

// parseAdmissionReview reads and deserializes an AdmissionReview from the request body.
func parseAdmissionReview(r *http.Request) (*admissionv1.AdmissionReview, error) {
	if r.Method != http.MethodPost {
		return nil, fmt.Errorf("invalid method: %s", r.Method)
	}
	if ct := r.Header.Get("Content-Type"); ct != "application/json" {
		return nil, fmt.Errorf("invalid content-type: %s", ct)
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // 1 MiB limit
	if err != nil {
		return nil, fmt.Errorf("reading body: %w", err)
	}

	var review admissionv1.AdmissionReview
	if _, _, err := deserializer.Decode(body, nil, &review); err != nil {
		// Fall back to plain JSON decode if scheme not registered
		if err2 := json.Unmarshal(body, &review); err2 != nil {
			return nil, fmt.Errorf("decoding admission review: %w", err)
		}
	}

	if review.Request == nil {
		return nil, fmt.Errorf("admission review request is nil")
	}

	return &review, nil
}

// writeResponse serializes and writes an AdmissionReview response.
func writeResponse(w http.ResponseWriter, review *admissionv1.AdmissionReview) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(review); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// allowed constructs an allowing AdmissionResponse.
func allowed(uid string) *admissionv1.AdmissionResponse {
	return &admissionv1.AdmissionResponse{
		UID:     admissionv1.UID(uid),
		Allowed: true,
	}
}

// denied constructs a denying AdmissionResponse with a human-readable message.
func denied(uid, reason string) *admissionv1.AdmissionResponse {
	return &admissionv1.AdmissionResponse{
		UID:     admissionv1.UID(uid),
		Allowed: false,
		Result: &metav1.Status{
			Code:    400,
			Message: reason,
		},
	}
}
```

## Validating Webhook Handler

```go
// internal/handler/validate.go
package handler

import (
	"net/http"

	admissionv1 "k8s.io/api/admission/v1"
	"go.uber.org/zap"
)

// ServeValidate handles ValidatingAdmissionWebhook requests.
func (h *Handler) ServeValidate(w http.ResponseWriter, r *http.Request) {
	review, err := parseAdmissionReview(r)
	if err != nil {
		h.log.Error("failed to parse admission review", zap.Error(err))
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	uid := string(review.Request.UID)
	h.log.Info("validating request",
		zap.String("uid", uid),
		zap.String("kind", review.Request.Kind.Kind),
		zap.String("namespace", review.Request.Namespace),
		zap.String("name", review.Request.Name),
		zap.String("operation", string(review.Request.Operation)),
	)

	response := h.runValidatePolicies(review.Request)

	writeResponse(w, &admissionv1.AdmissionReview{
		TypeMeta: review.TypeMeta,
		Response: response,
	})
}

func (h *Handler) runValidatePolicies(req *admissionv1.AdmissionRequest) *admissionv1.AdmissionResponse {
	for _, policy := range h.validatePolicies {
		ok, reason, err := policy(req)
		if err != nil {
			h.log.Error("policy error", zap.Error(err))
			return denied(string(req.UID), "internal policy error: "+err.Error())
		}
		if !ok {
			h.log.Info("request denied", zap.String("reason", reason))
			return denied(string(req.UID), reason)
		}
	}
	return allowed(string(req.UID))
}
```

## Mutating Webhook Handler

```go
// internal/handler/mutate.go
package handler

import (
	"encoding/json"
	"net/http"

	admissionv1 "k8s.io/api/admission/v1"
	"go.uber.org/zap"
)

// ServeMutate handles MutatingAdmissionWebhook requests.
func (h *Handler) ServeMutate(w http.ResponseWriter, r *http.Request) {
	review, err := parseAdmissionReview(r)
	if err != nil {
		h.log.Error("failed to parse admission review", zap.Error(err))
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	uid := string(review.Request.UID)
	h.log.Info("mutating request",
		zap.String("uid", uid),
		zap.String("kind", review.Request.Kind.Kind),
		zap.String("namespace", review.Request.Namespace),
	)

	response := h.runMutatePolicies(review.Request)

	writeResponse(w, &admissionv1.AdmissionReview{
		TypeMeta: review.TypeMeta,
		Response: response,
	})
}

func (h *Handler) runMutatePolicies(req *admissionv1.AdmissionRequest) *admissionv1.AdmissionResponse {
	var allPatches []PatchOperation

	for _, policy := range h.mutatePolicies {
		patches, err := policy(req)
		if err != nil {
			h.log.Error("mutation policy error", zap.Error(err))
			return denied(string(req.UID), "internal mutation error: "+err.Error())
		}
		allPatches = append(allPatches, patches...)
	}

	if len(allPatches) == 0 {
		return allowed(string(req.UID))
	}

	patchBytes, err := json.Marshal(allPatches)
	if err != nil {
		return denied(string(req.UID), "failed to marshal patch")
	}

	patchType := admissionv1.PatchTypeJSONPatch
	return &admissionv1.AdmissionResponse{
		UID:       req.UID,
		Allowed:   true,
		Patch:     patchBytes,
		PatchType: &patchType,
	}
}
```

## Policy Implementations

### Image Tag Enforcement

This policy rejects pods that use the `latest` tag or no tag at all, which prevents unintentional image drift:

```go
// internal/policy/image_tag.go
package policy

import (
	"encoding/json"
	"fmt"
	"strings"

	admissionv1 "k8s.io/api/admission/v1"
	corev1 "k8s.io/api/core/v1"
)

// DenyLatestTag is a ValidatePolicy that rejects pods using :latest or untagged images.
func DenyLatestTag(req *admissionv1.AdmissionRequest) (bool, string, error) {
	// Only inspect Pods and Pod template updates
	if req.Kind.Kind != "Pod" {
		return true, "", nil
	}
	// Skip DELETE operations
	if req.Operation == admissionv1.Delete {
		return true, "", nil
	}

	var pod corev1.Pod
	if err := json.Unmarshal(req.Object.Raw, &pod); err != nil {
		return false, "", fmt.Errorf("decoding pod: %w", err)
	}

	for _, container := range append(pod.Spec.InitContainers, pod.Spec.Containers...) {
		if violatesTagPolicy(container.Image) {
			return false, fmt.Sprintf(
				"container %q uses image %q which violates the image tag policy: "+
					"all images must specify an explicit tag other than 'latest'",
				container.Name, container.Image,
			), nil
		}
	}

	return true, "", nil
}

// violatesTagPolicy returns true if the image reference violates the tag policy.
func violatesTagPolicy(image string) bool {
	// Extract the tag portion (after the last colon, ignoring digest references)
	// Examples:
	//   nginx           → no tag     → violates
	//   nginx:latest    → latest     → violates
	//   nginx:1.25.3    → ok
	//   registry/nginx@sha256:abc → digest ref → ok
	if strings.Contains(image, "@sha256:") {
		return false // Digest-pinned images are always acceptable
	}

	parts := strings.Split(image, ":")
	if len(parts) == 1 {
		return true // No tag
	}

	tag := parts[len(parts)-1]
	return tag == "" || tag == "latest"
}
```

### Resource Limits Policy

Enforce that all containers declare CPU and memory limits:

```go
// internal/policy/resource_limits.go
package policy

import (
	"encoding/json"
	"fmt"

	admissionv1 "k8s.io/api/admission/v1"
	corev1 "k8s.io/api/core/v1"
	"github.com/yourorg/admission-webhook/internal/handler"
)

// RequireResourceLimits is a ValidatePolicy that rejects pods without resource limits.
func RequireResourceLimits(req *admissionv1.AdmissionRequest) (bool, string, error) {
	if req.Kind.Kind != "Pod" {
		return true, "", nil
	}
	if req.Operation == admissionv1.Delete {
		return true, "", nil
	}

	var pod corev1.Pod
	if err := json.Unmarshal(req.Object.Raw, &pod); err != nil {
		return false, "", fmt.Errorf("decoding pod: %w", err)
	}

	allContainers := append(pod.Spec.InitContainers, pod.Spec.Containers...)
	for _, c := range allContainers {
		if c.Resources.Limits == nil {
			return false, fmt.Sprintf(
				"container %q must declare resource limits (cpu and memory)",
				c.Name,
			), nil
		}
		if _, ok := c.Resources.Limits[corev1.ResourceCPU]; !ok {
			return false, fmt.Sprintf("container %q missing CPU limit", c.Name), nil
		}
		if _, ok := c.Resources.Limits[corev1.ResourceMemory]; !ok {
			return false, fmt.Sprintf("container %q missing memory limit", c.Name), nil
		}
	}

	return true, "", nil
}

// InjectDefaultLimits is a MutatePolicy that adds default limits to containers missing them.
func InjectDefaultLimits(req *admissionv1.AdmissionRequest) ([]handler.PatchOperation, error) {
	if req.Kind.Kind != "Pod" {
		return nil, nil
	}
	if req.Operation == admissionv1.Delete {
		return nil, nil
	}

	var pod corev1.Pod
	if err := json.Unmarshal(req.Object.Raw, &pod); err != nil {
		return nil, fmt.Errorf("decoding pod: %w", err)
	}

	var patches []handler.PatchOperation

	for i, c := range pod.Spec.Containers {
		if c.Resources.Requests == nil {
			patches = append(patches, handler.PatchOperation{
				Op:    "add",
				Path:  fmt.Sprintf("/spec/containers/%d/resources/requests", i),
				Value: map[string]string{"cpu": "100m", "memory": "128Mi"},
			})
		}
	}

	return patches, nil
}
```

### Sidecar Injection Policy

The classic use case for mutating webhooks is injecting a logging or tracing sidecar:

```go
// internal/policy/sidecar_inject.go
package policy

import (
	"encoding/json"
	"fmt"

	admissionv1 "k8s.io/api/admission/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	"github.com/yourorg/admission-webhook/internal/handler"
)

const (
	sidecarAnnotation = "sidecar-injector.example.com/inject"
	sidecarName       = "log-shipper"
	sidecarImage      = "fluent/fluent-bit:3.1.4"
)

// InjectLogSidecar injects a Fluent Bit log shipper into annotated pods.
func InjectLogSidecar(req *admissionv1.AdmissionRequest) ([]handler.PatchOperation, error) {
	if req.Kind.Kind != "Pod" {
		return nil, nil
	}

	var pod corev1.Pod
	if err := json.Unmarshal(req.Object.Raw, &pod); err != nil {
		return nil, fmt.Errorf("decoding pod: %w", err)
	}

	// Check opt-in annotation
	if pod.Annotations[sidecarAnnotation] != "true" {
		return nil, nil
	}

	// Check if already injected (idempotency)
	for _, c := range pod.Spec.Containers {
		if c.Name == sidecarName {
			return nil, nil
		}
	}

	sidecar := corev1.Container{
		Name:  sidecarName,
		Image: sidecarImage,
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
			{Name: "varlog", MountPath: "/var/log"},
		},
		Env: []corev1.EnvVar{
			{Name: "POD_NAME", ValueFrom: &corev1.EnvVarSource{
				FieldRef: &corev1.ObjectFieldSelector{FieldPath: "metadata.name"},
			}},
			{Name: "POD_NAMESPACE", ValueFrom: &corev1.EnvVarSource{
				FieldRef: &corev1.ObjectFieldSelector{FieldPath: "metadata.namespace"},
			}},
		},
	}

	// Add the sidecar container and the shared log volume
	var patches []handler.PatchOperation

	if len(pod.Spec.Containers) == 0 {
		patches = append(patches, handler.PatchOperation{
			Op:    "add",
			Path:  "/spec/containers",
			Value: []corev1.Container{sidecar},
		})
	} else {
		patches = append(patches, handler.PatchOperation{
			Op:    "add",
			Path:  "/spec/containers/-",
			Value: sidecar,
		})
	}

	// Add shared log volume if not present
	volumeExists := false
	for _, v := range pod.Spec.Volumes {
		if v.Name == "varlog" {
			volumeExists = true
			break
		}
	}

	if !volumeExists {
		logVolume := corev1.Volume{
			Name: "varlog",
			VolumeSource: corev1.VolumeSource{
				EmptyDir: &corev1.EmptyDirVolumeSource{},
			},
		}
		if len(pod.Spec.Volumes) == 0 {
			patches = append(patches, handler.PatchOperation{
				Op:    "add",
				Path:  "/spec/volumes",
				Value: []corev1.Volume{logVolume},
			})
		} else {
			patches = append(patches, handler.PatchOperation{
				Op:    "add",
				Path:  "/spec/volumes/-",
				Value: logVolume,
			})
		}
	}

	return patches, nil
}
```

## Main Server with TLS

```go
// cmd/webhook/main.go
package main

import (
	"context"
	"crypto/tls"
	"flag"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"go.uber.org/zap"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/yourorg/admission-webhook/internal/handler"
	"github.com/yourorg/admission-webhook/internal/policy"
)

func main() {
	var (
		tlsCertFile  = flag.String("tls-cert", "/certs/tls.crt", "TLS certificate file")
		tlsKeyFile   = flag.String("tls-key", "/certs/tls.key", "TLS key file")
		port         = flag.String("port", "8443", "HTTPS port")
		metricsPort  = flag.String("metrics-port", "9090", "Metrics port")
	)
	flag.Parse()

	log, _ := zap.NewProduction()
	defer log.Sync()

	// Wire up policies
	validatePolicies := []handler.ValidatePolicy{
		policy.DenyLatestTag,
		policy.RequireResourceLimits,
	}

	mutatePolicies := []handler.MutatePolicy{
		policy.InjectLogSidecar,
		policy.InjectDefaultLimits,
	}

	h := handler.New(log, validatePolicies, mutatePolicies)

	// TLS configuration
	cert, err := tls.LoadX509KeyPair(*tlsCertFile, *tlsKeyFile)
	if err != nil {
		log.Fatal("failed to load TLS keypair", zap.Error(err))
	}

	tlsConfig := &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS13,
	}

	// Webhook HTTPS server
	mux := http.NewServeMux()
	mux.HandleFunc("/validate", h.ServeValidate)
	mux.HandleFunc("/mutate", h.ServeMutate)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	server := &http.Server{
		Addr:         ":" + *port,
		Handler:      mux,
		TLSConfig:    tlsConfig,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Metrics HTTP server
	metricsMux := http.NewServeMux()
	metricsMux.Handle("/metrics", promhttp.Handler())
	metricsServer := &http.Server{
		Addr:    ":" + *metricsPort,
		Handler: metricsMux,
	}

	go func() {
		log.Info("starting metrics server", zap.String("addr", ":"+*metricsPort))
		if err := metricsServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Error("metrics server error", zap.Error(err))
		}
	}()

	go func() {
		log.Info("starting webhook server", zap.String("addr", ":"+*port))
		if err := server.ListenAndServeTLS("", ""); err != nil && err != http.ErrServerClosed {
			log.Fatal("webhook server error", zap.Error(err))
		}
	}()

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
	<-quit

	log.Info("shutting down webhook server")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		log.Error("server shutdown error", zap.Error(err))
	}
}
```

## cert-manager Certificate for Webhook TLS

The Kubernetes API server calls your webhook over HTTPS and validates the certificate against the `caBundle` in the webhook configuration. cert-manager automates this certificate lifecycle:

```yaml
# deploy/certificate.yaml
apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: webhook-selfsigned
  namespace: admission-webhook
spec:
  selfSigned: {}
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: admission-webhook-tls
  namespace: admission-webhook
spec:
  secretName: admission-webhook-tls
  duration: 8760h  # 1 year
  renewBefore: 720h  # Renew 30 days before expiry
  subject:
    organizations:
      - example-org
  dnsNames:
    - admission-webhook.admission-webhook.svc
    - admission-webhook.admission-webhook.svc.cluster.local
  issuerRef:
    name: webhook-selfsigned
    kind: Issuer
```

## Deployment Manifests

```yaml
# deploy/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: admission-webhook
  namespace: admission-webhook
  labels:
    app.kubernetes.io/name: admission-webhook
spec:
  replicas: 2
  selector:
    matchLabels:
      app.kubernetes.io/name: admission-webhook
  template:
    metadata:
      labels:
        app.kubernetes.io/name: admission-webhook
    spec:
      serviceAccountName: admission-webhook
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app.kubernetes.io/name: admission-webhook
      containers:
        - name: webhook
          image: ghcr.io/yourorg/admission-webhook:1.0.0
          args:
            - --tls-cert=/certs/tls.crt
            - --tls-key=/certs/tls.key
            - --port=8443
            - --metrics-port=9090
          ports:
            - containerPort: 8443
              name: https
            - containerPort: 9090
              name: metrics
          resources:
            requests:
              cpu: "100m"
              memory: "64Mi"
            limits:
              cpu: "500m"
              memory: "256Mi"
          volumeMounts:
            - name: tls
              mountPath: /certs
              readOnly: true
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
            initialDelaySeconds: 5
            periodSeconds: 5
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            runAsNonRoot: true
            runAsUser: 1000
            capabilities:
              drop: ["ALL"]
      volumes:
        - name: tls
          secret:
            secretName: admission-webhook-tls
---
apiVersion: v1
kind: Service
metadata:
  name: admission-webhook
  namespace: admission-webhook
spec:
  selector:
    app.kubernetes.io/name: admission-webhook
  ports:
    - name: https
      port: 443
      targetPort: https
    - name: metrics
      port: 9090
      targetPort: metrics
```

## Webhook Registration with caBundle Injection

cert-manager can automatically inject the CA bundle into webhook configurations using the `cert-manager.io/inject-ca-from` annotation:

```yaml
# deploy/validating-webhook.yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: admission-webhook
  annotations:
    # cert-manager injects the CA bundle automatically
    cert-manager.io/inject-ca-from: admission-webhook/admission-webhook-tls
webhooks:
  - name: validate.pods.admission-webhook.example.com
    admissionReviewVersions: ["v1"]
    sideEffects: None
    failurePolicy: Fail
    matchPolicy: Equivalent
    timeoutSeconds: 10
    namespaceSelector:
      matchExpressions:
        - key: admission-webhook/skip
          operator: DoesNotExist
    objectSelector:
      matchExpressions:
        - key: admission-webhook/skip
          operator: DoesNotExist
    rules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        resources: ["pods"]
        operations: ["CREATE", "UPDATE"]
        scope: "Namespaced"
    clientConfig:
      service:
        name: admission-webhook
        namespace: admission-webhook
        path: /validate
        port: 443
---
# deploy/mutating-webhook.yaml
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: admission-webhook
  annotations:
    cert-manager.io/inject-ca-from: admission-webhook/admission-webhook-tls
webhooks:
  - name: mutate.pods.admission-webhook.example.com
    admissionReviewVersions: ["v1"]
    sideEffects: None
    failurePolicy: Fail
    timeoutSeconds: 10
    namespaceSelector:
      matchExpressions:
        - key: admission-webhook/skip
          operator: DoesNotExist
    rules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        resources: ["pods"]
        operations: ["CREATE"]
        scope: "Namespaced"
    clientConfig:
      service:
        name: admission-webhook
        namespace: admission-webhook
        path: /mutate
        port: 443
    reinvocationPolicy: Never
```

## Integration Tests

Use `envtest` from controller-runtime to run a real Kubernetes API server in tests:

```go
// tests/integration_test.go
package tests

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	admissionv1 "k8s.io/api/admission/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"go.uber.org/zap"

	"github.com/yourorg/admission-webhook/internal/handler"
	"github.com/yourorg/admission-webhook/internal/policy"
)

func newTestHandler() *handler.Handler {
	log, _ := zap.NewDevelopment()
	return handler.New(log,
		[]handler.ValidatePolicy{policy.DenyLatestTag, policy.RequireResourceLimits},
		[]handler.MutatePolicy{policy.InjectLogSidecar},
	)
}

func makeAdmissionReview(pod *corev1.Pod) *admissionv1.AdmissionReview {
	raw, _ := json.Marshal(pod)
	return &admissionv1.AdmissionReview{
		TypeMeta: metav1.TypeMeta{
			APIVersion: "admission.k8s.io/v1",
			Kind:       "AdmissionReview",
		},
		Request: &admissionv1.AdmissionRequest{
			UID:       "test-uid-001",
			Kind:      metav1.GroupVersionKind{Group: "", Version: "v1", Kind: "Pod"},
			Resource:  metav1.GroupVersionResource{Group: "", Version: "v1", Resource: "pods"},
			Name:      pod.Name,
			Namespace: "default",
			Operation: admissionv1.Create,
			Object:    runtime.RawExtension{Raw: raw},
		},
	}
}

func callWebhook(t *testing.T, h *handler.Handler, path string, review *admissionv1.AdmissionReview) *admissionv1.AdmissionReview {
	t.Helper()
	body, _ := json.Marshal(review)
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()

	if path == "/validate" {
		h.ServeValidate(rr, req)
	} else {
		h.ServeMutate(rr, req)
	}

	var resp admissionv1.AdmissionReview
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	return &resp
}

func podWithImage(image string) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "test-pod", Namespace: "default"},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{{
				Name:  "app",
				Image: image,
				Resources: corev1.ResourceRequirements{
					Requests: corev1.ResourceList{
						corev1.ResourceCPU:    resource.MustParse("100m"),
						corev1.ResourceMemory: resource.MustParse("128Mi"),
					},
					Limits: corev1.ResourceList{
						corev1.ResourceCPU:    resource.MustParse("500m"),
						corev1.ResourceMemory: resource.MustParse("256Mi"),
					},
				},
			}},
		},
	}
}

func TestValidate_DenyLatestTag(t *testing.T) {
	h := newTestHandler()
	cases := []struct {
		image   string
		allowed bool
	}{
		{"nginx:latest", false},
		{"nginx", false},
		{"nginx:1.25.3", true},
		{"nginx@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc123", true},
		{"registry.example.com/myapp:v2.3.1", true},
	}

	for _, tc := range cases {
		t.Run(tc.image, func(t *testing.T) {
			review := makeAdmissionReview(podWithImage(tc.image))
			resp := callWebhook(t, h, "/validate", review)
			if resp.Response.Allowed != tc.allowed {
				t.Errorf("image %q: expected allowed=%v, got allowed=%v (reason: %s)",
					tc.image, tc.allowed, resp.Response.Allowed,
					resp.Response.Result.GetMessage())
			}
		})
	}
}

func TestValidate_RequireResourceLimits(t *testing.T) {
	h := newTestHandler()

	podNoLimits := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "nolimits", Namespace: "default"},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{{
				Name:  "app",
				Image: "nginx:1.25.3",
			}},
		},
	}

	review := makeAdmissionReview(podNoLimits)
	resp := callWebhook(t, h, "/validate", review)
	if resp.Response.Allowed {
		t.Error("expected pod without resource limits to be denied")
	}
}

func TestMutate_SidecarInjection(t *testing.T) {
	h := newTestHandler()

	pod := podWithImage("nginx:1.25.3")
	pod.Annotations = map[string]string{
		"sidecar-injector.example.com/inject": "true",
	}

	review := makeAdmissionReview(pod)
	resp := callWebhook(t, h, "/mutate", review)

	if !resp.Response.Allowed {
		t.Fatalf("expected pod to be allowed, got denied: %s",
			resp.Response.Result.GetMessage())
	}

	if len(resp.Response.Patch) == 0 {
		t.Fatal("expected patch to be non-empty for annotated pod")
	}

	var patches []handler.PatchOperation
	if err := json.Unmarshal(resp.Response.Patch, &patches); err != nil {
		t.Fatalf("decoding patch: %v", err)
	}

	found := false
	for _, p := range patches {
		if p.Op == "add" && strings.Contains(p.Path, "/spec/containers") {
			container, _ := json.Marshal(p.Value)
			if strings.Contains(string(container), "log-shipper") {
				found = true
				break
			}
		}
	}

	if !found {
		t.Error("expected sidecar injection patch not found")
	}
}

func TestMutate_NoInjectionWithoutAnnotation(t *testing.T) {
	h := newTestHandler()
	review := makeAdmissionReview(podWithImage("nginx:1.25.3"))
	resp := callWebhook(t, h, "/mutate", review)

	if !resp.Response.Allowed {
		t.Fatalf("expected pod to be allowed")
	}
	if len(resp.Response.Patch) > 0 {
		t.Errorf("expected no patch for unannotated pod, got: %s", resp.Response.Patch)
	}
}
```

Run the tests:

```bash
go test ./tests/... -v -count=1
```

## Failure Policy and Namespace Exclusion

Always exclude system namespaces and the webhook's own namespace from webhook scope. If the webhook is unreachable and `failurePolicy: Fail`, a broken webhook blocks all pod creation system-wide:

```bash
# Label namespaces to exclude from webhook enforcement
kubectl label namespace kube-system admission-webhook/skip=true
kubectl label namespace kube-public admission-webhook/skip=true
kubectl label namespace admission-webhook admission-webhook/skip=true
kubectl label namespace cert-manager admission-webhook/skip=true
```

Verify webhook configuration is correct:

```bash
# Check webhook configurations
kubectl get validatingwebhookconfigurations
kubectl describe validatingwebhookconfiguration admission-webhook

# Test by creating a pod that should be denied
kubectl run bad-pod --image=nginx:latest -n default
# Expected: Error from server: admission webhook "validate.pods.admission-webhook.example.com" denied the request

# Test by creating a valid pod
kubectl run good-pod \
  --image=nginx:1.25.3 \
  --requests='cpu=100m,memory=128Mi' \
  --limits='cpu=500m,memory=256Mi' \
  -n default
```

## Operational Considerations

**Webhook latency budget**: The Kubernetes API server times out webhook calls at `timeoutSeconds`. Keep your webhook under 5 seconds. Profile with:

```bash
kubectl get --raw /metrics | grep apiserver_admission_webhook_admission_duration
```

**High availability**: Run at least two replicas with a PodDisruptionBudget:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: admission-webhook
  namespace: admission-webhook
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: admission-webhook
```

**Certificate rotation**: cert-manager handles rotation automatically. The webhook must reload the certificate without restarting. Use `crypto/tls`'s `GetCertificate` callback to reload from disk on each TLS handshake rather than caching it at startup.

## Summary

Admission webhooks give you full programmatic control over Kubernetes policy enforcement. The validating webhook pattern is best for hard requirements like image tag pinning and resource limits—it provides clear error messages and blocks non-compliant resources at the API layer. The mutating webhook pattern works well for defaults injection and sidecar management where you want the user experience to be transparent. cert-manager makes TLS lifecycle management hands-off, and the `envtest` integration tests let you verify policy logic without a full cluster.
