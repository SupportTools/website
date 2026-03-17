---
title: "Kubernetes Mutating Webhooks for Policy: Image Pull Policy, Labels, and Annotations"
date: 2029-01-30T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Webhooks", "Policy", "Go", "Security", "Admission Control"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to building production-grade Kubernetes mutating admission webhooks in Go for enforcing image pull policies, injecting mandatory labels, and automating annotation standards across enterprise clusters."
more_link: "yes"
url: "/kubernetes-mutating-webhooks-policy-image-labels-annotations/"
---

Kubernetes admission webhooks are one of the most powerful policy enforcement mechanisms available to platform teams. Mutating admission webhooks intercept API server requests before persistence and can modify the object — injecting sidecars, enforcing image pull policies, adding mandatory labels, or enriching annotations with cost center metadata. Unlike OPA/Gatekeeper which validates, mutating webhooks silently fix non-compliant resources.

This guide walks through building a production-ready mutating admission webhook in Go that enforces three common enterprise policies: image pull policy normalization, mandatory label injection, and annotation enrichment.

<!--more-->

## Admission Webhook Architecture

The Kubernetes API server evaluates admission webhooks during the admission phase of every object write (CREATE, UPDATE, DELETE). Mutating webhooks run before validating webhooks, and multiple mutating webhooks may run in sequence — the order matters when mutations build on each other.

```
kubectl apply → kube-apiserver → Authentication → Authorization
  → MutatingAdmissionWebhooks (in order) → Object stored in etcd
  → ValidatingAdmissionWebhooks → Response to client
```

Each webhook receives an `AdmissionReview` object, processes it, and returns a patch in JSON Patch format (RFC 6902). The API server applies the patch and continues to the next webhook or persists the object.

### Critical Production Constraints

- Webhook response timeout: default 10s, max 30s — anything slower blocks pod scheduling
- Webhooks with `failurePolicy: Fail` will prevent any object creation if the webhook is unavailable
- Webhooks using `failurePolicy: Ignore` will let unmodified objects through if unavailable
- Mutual TLS is required: the API server validates the webhook's TLS certificate

## Project Structure

```bash
mkdir -p mutating-webhook/{cmd/webhook,internal/{handlers,patches,tls},deploy}
tree mutating-webhook/
# mutating-webhook/
# ├── cmd/webhook/main.go
# ├── internal/
# │   ├── handlers/
# │   │   ├── admission.go
# │   │   └── healthz.go
# │   ├── patches/
# │   │   ├── image_policy.go
# │   │   ├── labels.go
# │   │   └── annotations.go
# │   └── tls/
# │       └── cert.go
# └── deploy/
#     ├── deployment.yaml
#     ├── service.yaml
#     └── webhook-config.yaml
```

## Core Admission Handler

```go
// internal/handlers/admission.go
package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"

	admissionv1 "k8s.io/api/admission/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/serializer"

	"github.com/company/mutating-webhook/internal/patches"
)

var (
	runtimeScheme = runtime.NewScheme()
	codecFactory  = serializer.NewCodecFactory(runtimeScheme)
	deserializer  = codecFactory.UniversalDeserializer()
)

type AdmissionHandler struct {
	log            *slog.Logger
	requiredLabels []string
	costCenterEnv  string
}

func NewAdmissionHandler(log *slog.Logger, requiredLabels []string, costCenterEnv string) *AdmissionHandler {
	return &AdmissionHandler{
		log:            log,
		requiredLabels: requiredLabels,
		costCenterEnv:  costCenterEnv,
	}
}

func (h *AdmissionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1*1024*1024))
	if err != nil {
		h.log.Error("failed to read request body", "error", err)
		http.Error(w, "failed to read body", http.StatusBadRequest)
		return
	}

	if contentType := r.Header.Get("Content-Type"); contentType != "application/json" {
		http.Error(w, "invalid content type, expected application/json", http.StatusBadRequest)
		return
	}

	admissionReview := &admissionv1.AdmissionReview{}
	if _, _, err := deserializer.Decode(body, nil, admissionReview); err != nil {
		h.log.Error("failed to decode admission review", "error", err)
		http.Error(w, fmt.Sprintf("decode error: %v", err), http.StatusBadRequest)
		return
	}

	response := h.mutate(admissionReview.Request)
	response.UID = admissionReview.Request.UID

	admissionReview.Response = response
	admissionReview.SetGroupVersionKind(admissionv1.SchemeGroupVersion.WithKind("AdmissionReview"))

	respBytes, err := json.Marshal(admissionReview)
	if err != nil {
		h.log.Error("failed to marshal response", "error", err)
		http.Error(w, "marshal error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write(respBytes)
}

func (h *AdmissionHandler) mutate(req *admissionv1.AdmissionRequest) *admissionv1.AdmissionResponse {
	if req.Kind.Kind != "Pod" {
		return &admissionv1.AdmissionResponse{Allowed: true}
	}

	var pod corev1.Pod
	if _, _, err := deserializer.Decode(req.Object.Raw, nil, &pod); err != nil {
		h.log.Error("failed to decode pod", "error", err, "namespace", req.Namespace, "name", req.Name)
		return &admissionv1.AdmissionResponse{
			Allowed: false,
			Result:  &metav1.Status{Message: fmt.Sprintf("decode pod: %v", err)},
		}
	}

	var allPatches []patches.JSONPatch

	// Policy 1: Normalize image pull policy
	imagePolicyPatches := patches.EnforceImagePullPolicy(&pod)
	allPatches = append(allPatches, imagePolicyPatches...)

	// Policy 2: Inject mandatory labels
	labelPatches := patches.InjectRequiredLabels(&pod, h.requiredLabels)
	allPatches = append(allPatches, labelPatches...)

	// Policy 3: Enrich annotations
	annotationPatches := patches.EnrichAnnotations(&pod, req.Namespace)
	allPatches = append(allPatches, annotationPatches...)

	if len(allPatches) == 0 {
		return &admissionv1.AdmissionResponse{Allowed: true}
	}

	patchBytes, err := json.Marshal(allPatches)
	if err != nil {
		h.log.Error("failed to marshal patches", "error", err)
		return &admissionv1.AdmissionResponse{
			Allowed: false,
			Result:  &metav1.Status{Message: fmt.Sprintf("marshal patches: %v", err)},
		}
	}

	patchType := admissionv1.PatchTypeJSONPatch
	h.log.Info("mutating pod",
		"namespace", req.Namespace,
		"pod", req.Name,
		"patches", len(allPatches),
	)

	return &admissionv1.AdmissionResponse{
		Allowed:   true,
		Patch:     patchBytes,
		PatchType: &patchType,
	}
}
```

## Image Pull Policy Enforcement

In production clusters, using `IfNotPresent` with mutable tags like `latest` creates a split-brain scenario where different nodes run different image versions. The webhook enforces `Always` for any image using a mutable tag.

```go
// internal/patches/image_policy.go
package patches

import (
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
)

// JSONPatch represents a single RFC 6902 JSON Patch operation
type JSONPatch struct {
	Op    string      `json:"op"`
	Path  string      `json:"path"`
	Value interface{} `json:"value,omitempty"`
}

// mutableTags are tags that should always use imagePullPolicy: Always
// because they do not guarantee image immutability
var mutableTags = map[string]bool{
	"latest":  true,
	"stable":  true,
	"edge":    true,
	"canary":  true,
	"release": true,
}

func isMutableTag(image string) bool {
	parts := strings.SplitN(image, ":", 2)
	if len(parts) == 1 {
		// no tag specified — defaults to latest
		return true
	}
	tag := parts[1]
	// SHA digest is immutable
	if strings.HasPrefix(tag, "sha256:") {
		return false
	}
	return mutableTags[strings.ToLower(tag)]
}

func EnforceImagePullPolicy(pod *corev1.Pod) []JSONPatch {
	var p []JSONPatch

	// Initialize labels/annotations maps if nil — needed before adding to them
	if pod.Labels == nil {
		p = append(p, JSONPatch{
			Op:    "add",
			Path:  "/metadata/labels",
			Value: map[string]string{},
		})
	}

	for i, container := range pod.Spec.InitContainers {
		if patch := pullPolicyPatch(container.Image, container.ImagePullPolicy,
			fmt.Sprintf("/spec/initContainers/%d/imagePullPolicy", i)); patch != nil {
			p = append(p, *patch)
		}
	}

	for i, container := range pod.Spec.Containers {
		if patch := pullPolicyPatch(container.Image, container.ImagePullPolicy,
			fmt.Sprintf("/spec/containers/%d/imagePullPolicy", i)); patch != nil {
			p = append(p, *patch)
		}
	}

	for i, container := range pod.Spec.EphemeralContainers {
		if patch := pullPolicyPatch(container.Image, corev1.PullPolicy(container.ImagePullPolicy),
			fmt.Sprintf("/spec/ephemeralContainers/%d/imagePullPolicy", i)); patch != nil {
			p = append(p, *patch)
		}
	}

	return p
}

func pullPolicyPatch(image string, current corev1.PullPolicy, path string) *JSONPatch {
	if isMutableTag(image) && current != corev1.PullAlways {
		return &JSONPatch{
			Op:    "replace",
			Path:  path,
			Value: string(corev1.PullAlways),
		}
	}
	// For digest-pinned images, ensure IfNotPresent for efficiency
	if !isMutableTag(image) && current == "" {
		return &JSONPatch{
			Op:    "add",
			Path:  path,
			Value: string(corev1.PullIfNotPresent),
		}
	}
	return nil
}
```

## Mandatory Label Injection

Platform teams need consistent labels for cost allocation, network policy targeting, and service discovery. The webhook injects labels that workload owners frequently omit.

```go
// internal/patches/labels.go
package patches

import (
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
)

const (
	LabelManagedBy    = "app.kubernetes.io/managed-by"
	LabelPartOf       = "app.kubernetes.io/part-of"
	LabelEnvironment  = "environment"
	LabelCostCenter   = "cost-center"
	LabelTeam         = "team"
	LabelWebhookMutated = "platform.company.com/mutated-by-webhook"
)

// derivedLabels are extracted from existing pod labels/annotations if not set
func InjectRequiredLabels(pod *corev1.Pod, requiredKeys []string) []JSONPatch {
	var p []JSONPatch

	labelsExist := pod.Labels != nil
	if !labelsExist {
		p = append(p, JSONPatch{
			Op:    "add",
			Path:  "/metadata/labels",
			Value: map[string]string{},
		})
	}

	// Mark the pod as mutated by this webhook
	if _, ok := pod.Labels[LabelWebhookMutated]; !ok {
		p = append(p, JSONPatch{
			Op:    "add",
			Path:  fmt.Sprintf("/metadata/labels/%s", escapeJSONPointer(LabelWebhookMutated)),
			Value: "policy-webhook",
		})
	}

	// Inject managed-by if not set
	if _, ok := pod.Labels[LabelManagedBy]; !ok {
		p = append(p, JSONPatch{
			Op:    "add",
			Path:  fmt.Sprintf("/metadata/labels/%s", escapeJSONPointer(LabelManagedBy)),
			Value: "platform-team",
		})
	}

	// Derive environment from namespace naming convention
	// Namespaces follow pattern: <team>-<env> e.g. payments-production
	if _, ok := pod.Labels[LabelEnvironment]; !ok {
		if env := deriveEnvironment(pod); env != "" {
			p = append(p, JSONPatch{
				Op:    "add",
				Path:  fmt.Sprintf("/metadata/labels/%s", escapeJSONPointer(LabelEnvironment)),
				Value: env,
			})
		}
	}

	return p
}

func deriveEnvironment(pod *corev1.Pod) string {
	// Check annotations first (explicitly set by CI/CD)
	if ann := pod.Annotations["platform.company.com/environment"]; ann != "" {
		return ann
	}
	// Fall through: return empty, caller will use namespace-derived value
	return ""
}

// escapeJSONPointer escapes special characters in JSON Pointer path segments
// per RFC 6901: '~' -> '~0', '/' -> '~1'
func escapeJSONPointer(s string) string {
	s = strings.ReplaceAll(s, "~", "~0")
	s = strings.ReplaceAll(s, "/", "~1")
	return s
}
```

## Annotation Enrichment

Annotations carry operational metadata: rollout timestamps, CI pipeline links, and compliance markers. The webhook stamps every pod with data that downstream tools expect.

```go
// internal/patches/annotations.go
package patches

import (
	"fmt"
	"os"
	"time"

	corev1 "k8s.io/api/core/v1"
)

const (
	AnnotationMutatedAt      = "platform.company.com/mutated-at"
	AnnotationWebhookVersion = "platform.company.com/webhook-version"
	AnnotationClusterName    = "platform.company.com/cluster-name"
	AnnotationCompliance     = "platform.company.com/compliance-scanned"
)

var (
	WebhookVersion = "1.0.0" // set via ldflags at build time
	ClusterName    = os.Getenv("CLUSTER_NAME")
)

func EnrichAnnotations(pod *corev1.Pod, namespace string) []JSONPatch {
	var p []JSONPatch

	annotationsExist := pod.Annotations != nil
	if !annotationsExist {
		p = append(p, JSONPatch{
			Op:    "add",
			Path:  "/metadata/annotations",
			Value: map[string]string{},
		})
	}

	now := time.Now().UTC().Format(time.RFC3339)

	additions := map[string]string{
		AnnotationMutatedAt:      now,
		AnnotationWebhookVersion: WebhookVersion,
	}

	if ClusterName != "" {
		additions[AnnotationClusterName] = ClusterName
	}

	// Mark compliance scan requirement based on namespace
	if isProductionNamespace(namespace) {
		additions[AnnotationCompliance] = "required"
	}

	for key, val := range additions {
		op := "add"
		if annotationsExist {
			if _, exists := pod.Annotations[key]; exists {
				op = "replace"
			}
		}
		p = append(p, JSONPatch{
			Op:    op,
			Path:  fmt.Sprintf("/metadata/annotations/%s", escapeJSONPointer(key)),
			Value: val,
		})
	}

	return p
}

func isProductionNamespace(ns string) bool {
	for _, suffix := range []string{"-prod", "-production", "-prd"} {
		if len(ns) > len(suffix) && ns[len(ns)-len(suffix):] == suffix {
			return true
		}
	}
	return ns == "production" || ns == "prod"
}
```

## Main Server with TLS

```go
// cmd/webhook/main.go
package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/company/mutating-webhook/internal/handlers"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	certFile := envOrDefault("TLS_CERT_FILE", "/etc/webhook/certs/tls.crt")
	keyFile := envOrDefault("TLS_KEY_FILE", "/etc/webhook/certs/tls.key")
	port := envOrDefault("PORT", "8443")
	requiredLabels := strings.Split(envOrDefault("REQUIRED_LABELS", "app,team,cost-center"), ",")
	clusterName := envOrDefault("CLUSTER_NAME", "production-us-east-1")

	handlers.WebhookVersion = envOrDefault("WEBHOOK_VERSION", "1.0.0")
	handlers.ClusterName = clusterName

	admissionHandler := handlers.NewAdmissionHandler(log, requiredLabels, clusterName)

	mux := http.NewServeMux()
	mux.Handle("/mutate", admissionHandler)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

	tlsCert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		log.Error("failed to load TLS certificate", "error", err)
		os.Exit(1)
	}

	server := &http.Server{
		Addr:    fmt.Sprintf(":%s", port),
		Handler: mux,
		TLSConfig: &tls.Config{
			Certificates: []tls.Certificate{tlsCert},
			MinVersion:   tls.VersionTLS13,
		},
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
		ReadHeaderTimeout: 5 * time.Second,
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)

	go func() {
		log.Info("starting webhook server", "port", port)
		if err := server.ListenAndServeTLS("", ""); err != nil && err != http.ErrServerClosed {
			log.Error("server error", "error", err)
			os.Exit(1)
		}
	}()

	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		log.Error("shutdown error", "error", err)
	}
	log.Info("webhook server stopped")
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
```

## Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: policy-webhook
  namespace: platform-system
  labels:
    app: policy-webhook
    app.kubernetes.io/component: admission-webhook
spec:
  replicas: 3
  selector:
    matchLabels:
      app: policy-webhook
  template:
    metadata:
      labels:
        app: policy-webhook
        app.kubernetes.io/managed-by: helm
    spec:
      serviceAccountName: policy-webhook
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: policy-webhook
              topologyKey: kubernetes.io/hostname
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: policy-webhook
      containers:
        - name: webhook
          image: registry.company.com/platform/policy-webhook:1.0.0
          ports:
            - name: https
              containerPort: 8443
              protocol: TCP
          env:
            - name: TLS_CERT_FILE
              value: /etc/webhook/certs/tls.crt
            - name: TLS_KEY_FILE
              value: /etc/webhook/certs/tls.key
            - name: CLUSTER_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.annotations['platform.company.com/cluster-name']
            - name: WEBHOOK_VERSION
              value: "1.0.0"
            - name: REQUIRED_LABELS
              value: "app,team,cost-center,environment"
          volumeMounts:
            - name: tls-certs
              mountPath: /etc/webhook/certs
              readOnly: true
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 256Mi
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
            initialDelaySeconds: 3
            periodSeconds: 5
      volumes:
        - name: tls-certs
          secret:
            secretName: policy-webhook-tls
---
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: policy-webhook
  annotations:
    cert-manager.io/inject-ca-from: platform-system/policy-webhook-tls
spec:
  webhooks:
    - name: pods.policy-webhook.platform.company.com
      admissionReviewVersions: ["v1"]
      sideEffects: None
      failurePolicy: Ignore
      matchPolicy: Equivalent
      namespaceSelector:
        matchExpressions:
          - key: platform.company.com/webhook-enabled
            operator: In
            values: ["true"]
          - key: kubernetes.io/metadata.name
            operator: NotIn
            values: ["platform-system", "kube-system", "cert-manager"]
      objectSelector:
        matchExpressions:
          - key: platform.company.com/webhook-skip
            operator: DoesNotExist
      clientConfig:
        service:
          name: policy-webhook
          namespace: platform-system
          path: /mutate
          port: 8443
      rules:
        - apiGroups: [""]
          apiVersions: ["v1"]
          resources: ["pods"]
          operations: ["CREATE", "UPDATE"]
      timeoutSeconds: 5
```

## Certificate Management with cert-manager

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: policy-webhook-tls
  namespace: platform-system
spec:
  secretName: policy-webhook-tls
  duration: 8760h   # 1 year
  renewBefore: 720h # 30 days
  isCA: false
  privateKey:
    algorithm: ECDSA
    size: 256
  dnsNames:
    - policy-webhook.platform-system.svc
    - policy-webhook.platform-system.svc.cluster.local
  issuerRef:
    name: cluster-ca
    kind: ClusterIssuer
    group: cert-manager.io
```

## Testing the Webhook

```bash
# Namespace setup — label enables the webhook
kubectl label namespace default platform.company.com/webhook-enabled=true

# Test pod that will be mutated
kubectl run test-pod \
  --image=nginx:latest \
  --dry-run=server \
  -o yaml | grep -A5 "imagePullPolicy\|labels\|annotations"

# Verify image pull policy was set to Always
kubectl get pod test-pod -o jsonpath='{.spec.containers[0].imagePullPolicy}'
# Expected output: Always

# Verify mandatory labels were injected
kubectl get pod test-pod --show-labels

# Verify annotations were enriched
kubectl get pod test-pod -o jsonpath='{.metadata.annotations}'

# Skip webhook for specific pod
kubectl run privileged-tool \
  --image=registry.company.com/tools/debug:sha256:abc123 \
  -l platform.company.com/webhook-skip=true

# Check webhook server logs
kubectl logs -n platform-system -l app=policy-webhook --tail=50

# Webhook audit: find all pods mutated by the webhook
kubectl get pods -A -l platform.company.com/mutated-by-webhook=policy-webhook
```

## Unit Tests for Patch Logic

```go
package patches_test

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/company/mutating-webhook/internal/patches"
)

func TestEnforceImagePullPolicy(t *testing.T) {
	tests := []struct {
		name           string
		image          string
		currentPolicy  corev1.PullPolicy
		expectedPolicy corev1.PullPolicy
		expectPatch    bool
	}{
		{
			name:          "latest tag should be Always",
			image:         "nginx:latest",
			currentPolicy: corev1.PullIfNotPresent,
			expectPatch:   true,
		},
		{
			name:          "digest-pinned should remain IfNotPresent",
			image:         "nginx@sha256:abc123def456",
			currentPolicy: corev1.PullIfNotPresent,
			expectPatch:   false,
		},
		{
			name:          "no tag defaults to latest - should be Always",
			image:         "nginx",
			currentPolicy: corev1.PullIfNotPresent,
			expectPatch:   true,
		},
		{
			name:          "semantic version tag - no change needed",
			image:         "nginx:1.25.3",
			currentPolicy: corev1.PullIfNotPresent,
			expectPatch:   false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pod := &corev1.Pod{
				ObjectMeta: metav1.ObjectMeta{Name: "test-pod", Namespace: "default"},
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{
						{Name: "app", Image: tt.image, ImagePullPolicy: tt.currentPolicy},
					},
				},
			}

			patchList := patches.EnforceImagePullPolicy(pod)
			hasPatch := len(patchList) > 0

			if hasPatch != tt.expectPatch {
				t.Errorf("image %q: expected patch=%v, got patch=%v (patches: %+v)",
					tt.image, tt.expectPatch, hasPatch, patchList)
			}
		})
	}
}
```

## Production Considerations

**High availability**: Deploy at least 3 replicas spread across zones. The webhook is in the critical path for pod creation — a single replica means a single-node failure blocks all pod scheduling in enabled namespaces.

**Failure policy**: Start with `failurePolicy: Ignore` during rollout. Switch to `Fail` only after the webhook has proven reliable in production for at least two weeks. With `Fail`, any webhook outage prevents pod creation cluster-wide.

**Namespace exclusions**: Always exclude `kube-system`, `cert-manager`, and your own webhook namespace. A webhook that breaks its own namespace cannot self-heal.

**Idempotency**: Mutations must be idempotent. A pod that goes through the webhook twice (update operations) must produce the same result. The `op: replace` vs `op: add` distinction in JSON Patch is critical here.

**Performance**: Keep mutations fast. Target under 2ms processing time per admission request. The total webhook timeout is shared across all webhooks in the chain plus network latency.
