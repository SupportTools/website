---
title: "Kubernetes Admission Webhook Development: MutatingWebhookConfiguration, Dynamic Defaulting, and Idempotency"
date: 2032-04-16T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Admission Webhooks", "MutatingWebhookConfiguration", "Go", "Security", "Policy"]
categories:
- Kubernetes
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to developing production-grade Kubernetes admission webhooks covering MutatingWebhookConfiguration setup, dynamic defaulting patterns, idempotency guarantees, certificate management, and thorough testing strategies."
more_link: "yes"
url: "/kubernetes-admission-webhook-development-mutating-dynamic-defaulting-idempotency/"
---

Kubernetes admission webhooks are the primary extensibility mechanism for enforcing policies, injecting defaults, and mutating API objects before they are persisted. Building production-quality webhooks requires understanding the admission chain, implementing idempotent mutations, managing TLS certificates, and writing comprehensive tests. This guide covers all of these topics with complete, working code.

<!--more-->

## Admission Webhook Architecture

Kubernetes has two types of admission webhooks:

- **MutatingAdmissionWebhook**: Can modify the object before storage. Invoked before validation.
- **ValidatingAdmissionWebhook**: Can approve or reject objects. Invoked after mutation.

The admission chain:
```
kubectl apply → API Server → Authentication → Authorization →
MutatingAdmissionWebhook(s) → Object Schema Validation →
ValidatingAdmissionWebhook(s) → etcd
```

Multiple mutating webhooks are called in registration order. Each webhook receives the object in its current state (after previous mutations).

### Admission Review Protocol

The API server sends an `AdmissionReview` request and expects an `AdmissionReview` response:

```json
// Request
{
  "apiVersion": "admission.k8s.io/v1",
  "kind": "AdmissionReview",
  "request": {
    "uid": "705ab4f5-6393-11e8-b7cc-42010a800002",
    "kind": {"group": "", "version": "v1", "resource": "pods"},
    "resource": {"group": "", "version": "v1", "resource": "pods"},
    "operation": "CREATE",
    "userInfo": {"username": "system:serviceaccount:default:my-sa"},
    "object": { /* pod spec */ },
    "oldObject": null,
    "dryRun": false
  }
}

// Response
{
  "apiVersion": "admission.k8s.io/v1",
  "kind": "AdmissionReview",
  "response": {
    "uid": "705ab4f5-6393-11e8-b7cc-42010a800002",
    "allowed": true,
    "patchType": "JSONPatch",
    "patch": "W3sib3AiOiJhZGQiLCJwYXRoIjoiL3NwZWMvY29udGFpbmVycy8wL3Jlc291cmNlcyIsInZhbHVlIjp7fX1d"
  }
}
```

---

## Project Structure

```
webhook/
├── cmd/
│   └── webhook/
│       └── main.go
├── internal/
│   ├── webhook/
│   │   ├── handler.go          # HTTP handler wrapping
│   │   ├── pod_defaulter.go    # Pod mutation logic
│   │   ├── pod_validator.go    # Pod validation logic
│   │   └── decoder.go          # Request decoding
│   └── config/
│       └── config.go
├── pkg/
│   └── mutation/
│       ├── resources.go        # Resource defaulting
│       ├── labels.go           # Label injection
│       ├── securitycontext.go  # Security context defaulting
│       └── sidecar.go          # Sidecar injection
├── deploy/
│   ├── webhook-deployment.yaml
│   ├── webhook-service.yaml
│   ├── mutating-webhook.yaml
│   └── validating-webhook.yaml
└── Dockerfile
```

---

## Core Webhook Server

### main.go

```go
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

    "go.uber.org/zap"
    "go.uber.org/zap/zapcore"

    "github.com/example/webhook/internal/config"
    "github.com/example/webhook/internal/webhook"
)

func main() {
    var (
        certFile  = flag.String("tls-cert", "/certs/tls.crt", "TLS certificate file")
        keyFile   = flag.String("tls-key", "/certs/tls.key", "TLS key file")
        port      = flag.Int("port", 8443, "HTTPS port")
        metricsPort = flag.Int("metrics-port", 8080, "Metrics port")
        logLevel  = flag.String("log-level", "info", "Log level (debug, info, warn, error)")
    )
    flag.Parse()

    level, err := zapcore.ParseLevel(*logLevel)
    if err != nil {
        fmt.Fprintf(os.Stderr, "invalid log level: %v\n", err)
        os.Exit(1)
    }

    logCfg := zap.NewProductionConfig()
    logCfg.Level = zap.NewAtomicLevelAt(level)
    logger, err := logCfg.Build()
    if err != nil {
        fmt.Fprintf(os.Stderr, "building logger: %v\n", err)
        os.Exit(1)
    }
    defer logger.Sync()

    cfg, err := config.Load()
    if err != nil {
        logger.Fatal("loading config", zap.Error(err))
    }

    // Build HTTP mux
    mux := http.NewServeMux()

    // Register webhook handlers
    handler := webhook.NewHandler(logger, cfg)
    mux.HandleFunc("/mutate/pods", handler.MutatePods)
    mux.HandleFunc("/validate/pods", handler.ValidatePods)
    mux.HandleFunc("/healthz", healthz)
    mux.HandleFunc("/readyz", readyz)

    // TLS configuration
    cert, err := tls.LoadX509KeyPair(*certFile, *keyFile)
    if err != nil {
        logger.Fatal("loading TLS certificate", zap.Error(err))
    }

    tlsCfg := &tls.Config{
        Certificates: []tls.Certificate{cert},
        MinVersion:   tls.VersionTLS13,
    }

    server := &http.Server{
        Addr:         fmt.Sprintf(":%d", *port),
        Handler:      mux,
        TLSConfig:    tlsCfg,
        ReadTimeout:  10 * time.Second,
        WriteTimeout: 10 * time.Second,
        IdleTimeout:  60 * time.Second,
    }

    // Metrics server (plain HTTP)
    metricsMux := http.NewServeMux()
    metricsMux.Handle("/metrics", promhttp.Handler())
    metricsServer := &http.Server{
        Addr:    fmt.Sprintf(":%d", *metricsPort),
        Handler: metricsMux,
    }

    // Start servers
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    go func() {
        logger.Info("starting metrics server", zap.Int("port", *metricsPort))
        if err := metricsServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            logger.Error("metrics server error", zap.Error(err))
        }
    }()

    go func() {
        logger.Info("starting webhook server", zap.Int("port", *port))
        if err := server.ListenAndServeTLS("", ""); err != nil && err != http.ErrServerClosed {
            logger.Fatal("webhook server error", zap.Error(err))
        }
    }()

    // Wait for shutdown signal
    sigChan := make(chan os.Signal, 1)
    signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
    <-sigChan

    logger.Info("shutting down")
    shutdownCtx, shutdownCancel := context.WithTimeout(ctx, 30*time.Second)
    defer shutdownCancel()

    server.Shutdown(shutdownCtx)
    metricsServer.Shutdown(shutdownCtx)
}

func healthz(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
}

func readyz(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
}
```

### Handler Core

```go
package webhook

import (
    "encoding/json"
    "fmt"
    "io"
    "net/http"
    "time"

    "go.uber.org/zap"
    admissionv1 "k8s.io/api/admission/v1"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/apimachinery/pkg/runtime/serializer"
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"

    "github.com/example/webhook/internal/config"
    "github.com/example/webhook/pkg/mutation"
)

var (
    scheme = runtime.NewScheme()
    codecs = serializer.NewCodecFactory(scheme)
)

func init() {
    _ = admissionv1.AddToScheme(scheme)
    _ = corev1.AddToScheme(scheme)
}

var (
    webhookRequests = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "webhook_requests_total",
        Help: "Total admission webhook requests",
    }, []string{"webhook", "operation", "result"})

    webhookDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
        Name:    "webhook_request_duration_seconds",
        Help:    "Admission webhook request duration",
        Buckets: prometheus.DefBuckets,
    }, []string{"webhook", "operation"})
)

// Handler processes admission webhook requests.
type Handler struct {
    logger  *zap.Logger
    cfg     *config.Config
    mutator *mutation.PodMutator
}

// NewHandler creates a webhook handler.
func NewHandler(logger *zap.Logger, cfg *config.Config) *Handler {
    return &Handler{
        logger:  logger,
        cfg:     cfg,
        mutator: mutation.NewPodMutator(logger, cfg),
    }
}

// MutatePods handles pod mutation requests.
func (h *Handler) MutatePods(w http.ResponseWriter, r *http.Request) {
    start := time.Now()

    review, err := h.decodeAdmissionReview(r)
    if err != nil {
        h.logger.Error("decoding admission review", zap.Error(err))
        http.Error(w, "invalid admission review", http.StatusBadRequest)
        webhookRequests.WithLabelValues("mutate-pods", "unknown", "error").Inc()
        return
    }

    operation := string(review.Request.Operation)
    h.logger.Info("mutation request",
        zap.String("uid", string(review.Request.UID)),
        zap.String("operation", operation),
        zap.String("namespace", review.Request.Namespace),
        zap.String("name", review.Request.Name),
    )

    response := h.mutator.Mutate(review.Request)
    response.UID = review.Request.UID

    review.Response = response
    review.Request = nil

    if err := h.writeAdmissionReview(w, review); err != nil {
        h.logger.Error("writing response", zap.Error(err))
        webhookRequests.WithLabelValues("mutate-pods", operation, "error").Inc()
        return
    }

    result := "allowed"
    if !response.Allowed {
        result = "denied"
    }

    webhookRequests.WithLabelValues("mutate-pods", operation, result).Inc()
    webhookDuration.WithLabelValues("mutate-pods", operation).Observe(time.Since(start).Seconds())
}

func (h *Handler) decodeAdmissionReview(r *http.Request) (*admissionv1.AdmissionReview, error) {
    if r.Method != http.MethodPost {
        return nil, fmt.Errorf("expected POST, got %s", r.Method)
    }

    contentType := r.Header.Get("Content-Type")
    if contentType != "application/json" {
        return nil, fmt.Errorf("expected Content-Type application/json, got %s", contentType)
    }

    body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // 1MB limit
    if err != nil {
        return nil, fmt.Errorf("reading body: %w", err)
    }

    review := &admissionv1.AdmissionReview{}
    if _, _, err := codecs.UniversalDeserializer().Decode(body, nil, review); err != nil {
        return nil, fmt.Errorf("decoding review: %w", err)
    }

    if review.Request == nil {
        return nil, fmt.Errorf("admission review request is nil")
    }

    return review, nil
}

func (h *Handler) writeAdmissionReview(w http.ResponseWriter, review *admissionv1.AdmissionReview) error {
    w.Header().Set("Content-Type", "application/json")
    return json.NewEncoder(w).Encode(review)
}

// allowed returns an allowed AdmissionResponse.
func allowed(msg string) *admissionv1.AdmissionResponse {
    return &admissionv1.AdmissionResponse{
        Allowed: true,
        Result: &metav1.Status{
            Message: msg,
        },
    }
}

// denied returns a denied AdmissionResponse.
func denied(msg string) *admissionv1.AdmissionResponse {
    return &admissionv1.AdmissionResponse{
        Allowed: false,
        Result: &metav1.Status{
            Message: msg,
            Code:    http.StatusForbidden,
        },
    }
}
```

---

## Pod Mutation with Idempotency

Idempotency is critical for admission webhooks. If a webhook is called multiple times on the same object (e.g., during retry), it must produce the same result without duplicating mutations.

### Pod Mutator

```go
package mutation

import (
    "encoding/json"
    "fmt"

    "go.uber.org/zap"
    admissionv1 "k8s.io/api/admission/v1"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/resource"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/apimachinery/pkg/runtime/serializer"
    jsonpatch "github.com/evanphx/json-patch/v5"

    "github.com/example/webhook/internal/config"
)

var (
    scheme = runtime.NewScheme()
    codecs = serializer.NewCodecFactory(scheme)
)

func init() {
    _ = corev1.AddToScheme(scheme)
}

// PodMutator applies defaults and mutations to pods.
type PodMutator struct {
    logger *zap.Logger
    cfg    *config.Config
}

// NewPodMutator creates a pod mutator.
func NewPodMutator(logger *zap.Logger, cfg *config.Config) *PodMutator {
    return &PodMutator{logger: logger, cfg: cfg}
}

// Mutate processes a pod admission request and returns a response with patches.
func (m *PodMutator) Mutate(req *admissionv1.AdmissionRequest) *admissionv1.AdmissionResponse {
    if req.Operation == admissionv1.Delete {
        return &admissionv1.AdmissionResponse{Allowed: true}
    }

    pod := &corev1.Pod{}
    if _, _, err := codecs.UniversalDeserializer().Decode(req.Object.Raw, nil, pod); err != nil {
        m.logger.Error("decoding pod", zap.Error(err))
        return &admissionv1.AdmissionResponse{
            Allowed: false,
            Result:  &metav1.Status{Message: fmt.Sprintf("decoding pod: %v", err)},
        }
    }

    // Build ordered list of mutations
    mutations := []PodMutation{
        &ResourceDefaulter{cfg: m.cfg},
        &LabelInjector{cfg: m.cfg},
        &SecurityContextDefaulter{cfg: m.cfg},
        &SidecarInjector{cfg: m.cfg},
    }

    // Apply mutations - each mutation checks if it needs to run (idempotency)
    original, err := json.Marshal(pod)
    if err != nil {
        return &admissionv1.AdmissionResponse{
            Allowed: false,
            Result:  &metav1.Status{Message: fmt.Sprintf("marshaling pod: %v", err)},
        }
    }

    for _, mut := range mutations {
        if err := mut.Apply(pod); err != nil {
            m.logger.Error("applying mutation",
                zap.String("mutation", fmt.Sprintf("%T", mut)),
                zap.Error(err),
            )
            return &admissionv1.AdmissionResponse{
                Allowed: false,
                Result:  &metav1.Status{Message: fmt.Sprintf("applying mutation: %v", err)},
            }
        }
    }

    mutated, err := json.Marshal(pod)
    if err != nil {
        return &admissionv1.AdmissionResponse{
            Allowed: false,
            Result:  &metav1.Status{Message: fmt.Sprintf("marshaling mutated pod: %v", err)},
        }
    }

    // Only include patch if there were actual changes
    if string(original) == string(mutated) {
        return &admissionv1.AdmissionResponse{Allowed: true}
    }

    patch, err := jsonpatch.CreateMergePatch(original, mutated)
    if err != nil {
        return &admissionv1.AdmissionResponse{
            Allowed: false,
            Result:  &metav1.Status{Message: fmt.Sprintf("creating patch: %v", err)},
        }
    }

    // Convert to JSON patch for compatibility
    jsonPatch, err := mergePatchToJSONPatch(original, mutated)
    if err != nil {
        return &admissionv1.AdmissionResponse{
            Allowed: false,
            Result:  &metav1.Status{Message: fmt.Sprintf("converting patch: %v", err)},
        }
    }

    _ = patch // mergePatch unused if using jsonPatch

    patchType := admissionv1.PatchTypeJSONPatch
    return &admissionv1.AdmissionResponse{
        Allowed:   true,
        Patch:     jsonPatch,
        PatchType: &patchType,
    }
}

// PodMutation is an interface for individual pod mutations.
type PodMutation interface {
    Apply(pod *corev1.Pod) error
}
```

### Resource Defaulter (Idempotent)

```go
package mutation

import (
    "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/resource"

    "github.com/example/webhook/internal/config"
)

// ResourceDefaulter sets default resource requests and limits on containers
// that don't have them defined.
type ResourceDefaulter struct {
    cfg *config.Config
}

// Apply sets default resources. It is idempotent - if resources are already
// set, they are not modified.
func (r *ResourceDefaulter) Apply(pod *v1.Pod) error {
    defaultCPURequest    := resource.MustParse(r.cfg.DefaultCPURequest)
    defaultMemRequest    := resource.MustParse(r.cfg.DefaultMemoryRequest)
    defaultCPULimit      := resource.MustParse(r.cfg.DefaultCPULimit)
    defaultMemLimit      := resource.MustParse(r.cfg.DefaultMemoryLimit)

    for i := range pod.Spec.Containers {
        c := &pod.Spec.Containers[i]
        if c.Resources.Requests == nil {
            c.Resources.Requests = make(v1.ResourceList)
        }
        if c.Resources.Limits == nil {
            c.Resources.Limits = make(v1.ResourceList)
        }

        // Only set if not already specified (idempotency check)
        if _, ok := c.Resources.Requests[v1.ResourceCPU]; !ok {
            c.Resources.Requests[v1.ResourceCPU] = defaultCPURequest
        }
        if _, ok := c.Resources.Requests[v1.ResourceMemory]; !ok {
            c.Resources.Requests[v1.ResourceMemory] = defaultMemRequest
        }
        if _, ok := c.Resources.Limits[v1.ResourceCPU]; !ok {
            c.Resources.Limits[v1.ResourceCPU] = defaultCPULimit
        }
        if _, ok := c.Resources.Limits[v1.ResourceMemory]; !ok {
            c.Resources.Limits[v1.ResourceMemory] = defaultMemLimit
        }
    }

    // Apply same logic to init containers
    for i := range pod.Spec.InitContainers {
        c := &pod.Spec.InitContainers[i]
        if c.Resources.Requests == nil {
            c.Resources.Requests = make(v1.ResourceList)
        }
        if _, ok := c.Resources.Requests[v1.ResourceCPU]; !ok {
            c.Resources.Requests[v1.ResourceCPU] = resource.MustParse("50m")
        }
        if _, ok := c.Resources.Requests[v1.ResourceMemory]; !ok {
            c.Resources.Requests[v1.ResourceMemory] = resource.MustParse("64Mi")
        }
    }

    return nil
}
```

### Sidecar Injector (Idempotent)

```go
package mutation

import (
    "fmt"

    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/resource"

    "github.com/example/webhook/internal/config"
)

const (
    sidecarInjectedAnnotation = "sidecar.example.com/injected"
    sidecarContainerName      = "logging-agent"
)

// SidecarInjector injects a logging sidecar into pods that opt-in via annotation.
type SidecarInjector struct {
    cfg *config.Config
}

// Apply injects the sidecar if the pod has the injection annotation
// and the sidecar is not already present (idempotency).
func (s *SidecarInjector) Apply(pod *corev1.Pod) error {
    // Check opt-in annotation
    if pod.Annotations == nil {
        return nil
    }
    if pod.Annotations["sidecar.example.com/inject"] != "true" {
        return nil
    }

    // Idempotency check: skip if sidecar already injected
    if pod.Annotations[sidecarInjectedAnnotation] == "true" {
        return nil
    }
    for _, c := range pod.Spec.Containers {
        if c.Name == sidecarContainerName {
            return nil // Already present
        }
    }

    // Build sidecar container
    sidecar := corev1.Container{
        Name:            sidecarContainerName,
        Image:           fmt.Sprintf("%s:%s", s.cfg.SidecarImage, s.cfg.SidecarTag),
        ImagePullPolicy: corev1.PullIfNotPresent,
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
                Name:      "varlog",
                MountPath: "/var/log",
                ReadOnly:  true,
            },
        },
        SecurityContext: &corev1.SecurityContext{
            ReadOnlyRootFilesystem:   boolPtr(true),
            AllowPrivilegeEscalation: boolPtr(false),
            RunAsNonRoot:             boolPtr(true),
            RunAsUser:                int64Ptr(65534),
            Capabilities: &corev1.Capabilities{
                Drop: []corev1.Capability{"ALL"},
            },
        },
    }

    // Ensure the shared volume exists
    varlogVolumeExists := false
    for _, v := range pod.Spec.Volumes {
        if v.Name == "varlog" {
            varlogVolumeExists = true
            break
        }
    }

    if !varlogVolumeExists {
        pod.Spec.Volumes = append(pod.Spec.Volumes, corev1.Volume{
            Name: "varlog",
            VolumeSource: corev1.VolumeSource{
                EmptyDir: &corev1.EmptyDirVolumeSource{},
            },
        })
    }

    pod.Spec.Containers = append(pod.Spec.Containers, sidecar)

    // Mark as injected
    if pod.Annotations == nil {
        pod.Annotations = make(map[string]string)
    }
    pod.Annotations[sidecarInjectedAnnotation] = "true"

    return nil
}

func boolPtr(b bool) *bool     { return &b }
func int64Ptr(i int64) *int64  { return &i }
```

---

## MutatingWebhookConfiguration

### Webhook Registration

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: pod-webhook
  annotations:
    # cert-manager injects the CA bundle automatically
    cert-manager.io/inject-ca-from: "webhook-system/webhook-serving-cert"
webhooks:
  - name: pod-defaults.webhook.example.com
    admissionReviewVersions: ["v1"]
    # Only call webhook for relevant operations
    rules:
      - operations: ["CREATE", "UPDATE"]
        apiGroups: [""]
        apiVersions: ["v1"]
        resources: ["pods"]
        scope: "Namespaced"
    clientConfig:
      service:
        name: pod-webhook
        namespace: webhook-system
        path: /mutate/pods
        port: 443
      # caBundle injected by cert-manager
    # Control webhook behavior
    failurePolicy: Fail       # Fail = deny on webhook error; Ignore = allow on webhook error
    sideEffects: None         # Indicates webhook has no side effects
    timeoutSeconds: 10
    # Only process pods in specific namespaces
    namespaceSelector:
      matchExpressions:
        - key: kubernetes.io/metadata.name
          operator: NotIn
          values:
            - kube-system
            - kube-public
            - kube-node-lease
            - webhook-system
    # Skip pods with the opt-out annotation
    objectSelector:
      matchExpressions:
        - key: webhook.example.com/skip-mutation
          operator: DoesNotExist
    # Reinvocation policy: call webhook again if a later webhook modifies the pod
    reinvocationPolicy: IfNeeded
```

### Service and TLS Configuration

```yaml
apiVersion: v1
kind: Service
metadata:
  name: pod-webhook
  namespace: webhook-system
spec:
  selector:
    app: pod-webhook
  ports:
    - port: 443
      targetPort: 8443
      protocol: TCP
---
# cert-manager Certificate for webhook TLS
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: webhook-serving-cert
  namespace: webhook-system
spec:
  dnsNames:
    - pod-webhook.webhook-system.svc
    - pod-webhook.webhook-system.svc.cluster.local
  issuerRef:
    kind: ClusterIssuer
    name: selfsigned-cluster-issuer
  secretName: webhook-server-cert
  duration: 8760h    # 1 year
  renewBefore: 720h  # Renew 30 days before expiry
---
# Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pod-webhook
  namespace: webhook-system
spec:
  replicas: 2
  selector:
    matchLabels:
      app: pod-webhook
  template:
    metadata:
      labels:
        app: pod-webhook
    spec:
      serviceAccountName: pod-webhook
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: webhook
          image: registry.example.com/pod-webhook:v1.0.0
          args:
            - --tls-cert=/certs/tls.crt
            - --tls-key=/certs/tls.key
            - --port=8443
            - --log-level=info
          ports:
            - containerPort: 8443
              name: https
            - containerPort: 8080
              name: metrics
          volumeMounts:
            - name: certs
              mountPath: /certs
              readOnly: true
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
              port: 8443
              scheme: HTTPS
            initialDelaySeconds: 10
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /readyz
              port: 8443
              scheme: HTTPS
            initialDelaySeconds: 5
            periodSeconds: 5
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
      volumes:
        - name: certs
          secret:
            secretName: webhook-server-cert
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: pod-webhook
              topologyKey: kubernetes.io/hostname
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: pod-webhook
```

---

## Testing Admission Webhooks

### Unit Tests for Mutators

```go
package mutation_test

import (
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/resource"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

    "github.com/example/webhook/internal/config"
    "github.com/example/webhook/pkg/mutation"
)

func TestResourceDefaulter_Apply(t *testing.T) {
    cfg := &config.Config{
        DefaultCPURequest:    "100m",
        DefaultMemoryRequest: "128Mi",
        DefaultCPULimit:      "1000m",
        DefaultMemoryLimit:   "512Mi",
    }

    defaulter := &mutation.ResourceDefaulter{Cfg: cfg}

    t.Run("applies defaults when resources not set", func(t *testing.T) {
        pod := &corev1.Pod{
            Spec: corev1.PodSpec{
                Containers: []corev1.Container{
                    {Name: "app", Image: "nginx:latest"},
                },
            },
        }

        require.NoError(t, defaulter.Apply(pod))

        c := pod.Spec.Containers[0]
        assert.Equal(t, resource.MustParse("100m"), c.Resources.Requests[corev1.ResourceCPU])
        assert.Equal(t, resource.MustParse("128Mi"), c.Resources.Requests[corev1.ResourceMemory])
        assert.Equal(t, resource.MustParse("1000m"), c.Resources.Limits[corev1.ResourceCPU])
        assert.Equal(t, resource.MustParse("512Mi"), c.Resources.Limits[corev1.ResourceMemory])
    })

    t.Run("does not override existing resources (idempotency)", func(t *testing.T) {
        existingCPU := resource.MustParse("200m")
        existingMem := resource.MustParse("256Mi")

        pod := &corev1.Pod{
            Spec: corev1.PodSpec{
                Containers: []corev1.Container{
                    {
                        Name:  "app",
                        Image: "nginx:latest",
                        Resources: corev1.ResourceRequirements{
                            Requests: corev1.ResourceList{
                                corev1.ResourceCPU:    existingCPU,
                                corev1.ResourceMemory: existingMem,
                            },
                        },
                    },
                },
            },
        }

        require.NoError(t, defaulter.Apply(pod))

        c := pod.Spec.Containers[0]
        // Original values must be preserved
        assert.Equal(t, existingCPU, c.Resources.Requests[corev1.ResourceCPU])
        assert.Equal(t, existingMem, c.Resources.Requests[corev1.ResourceMemory])
    })

    t.Run("idempotent when applied twice", func(t *testing.T) {
        pod := &corev1.Pod{
            Spec: corev1.PodSpec{
                Containers: []corev1.Container{
                    {Name: "app", Image: "nginx:latest"},
                },
            },
        }

        require.NoError(t, defaulter.Apply(pod))
        firstResult := pod.Spec.Containers[0].Resources.DeepCopy()

        require.NoError(t, defaulter.Apply(pod)) // Apply again
        secondResult := pod.Spec.Containers[0].Resources

        assert.Equal(t, *firstResult, secondResult, "second apply should not change result")
    })
}

func TestSidecarInjector_Apply(t *testing.T) {
    cfg := &config.Config{
        SidecarImage: "logging-agent",
        SidecarTag:   "v2.1.0",
    }

    injector := &mutation.SidecarInjector{Cfg: cfg}

    t.Run("injects sidecar with opt-in annotation", func(t *testing.T) {
        pod := &corev1.Pod{
            ObjectMeta: metav1.ObjectMeta{
                Annotations: map[string]string{
                    "sidecar.example.com/inject": "true",
                },
            },
            Spec: corev1.PodSpec{
                Containers: []corev1.Container{
                    {Name: "app", Image: "myapp:latest"},
                },
            },
        }

        require.NoError(t, injector.Apply(pod))

        assert.Len(t, pod.Spec.Containers, 2)
        assert.Equal(t, "logging-agent", pod.Spec.Containers[1].Name)
        assert.Equal(t, "true", pod.Annotations["sidecar.example.com/injected"])
    })

    t.Run("does not inject without opt-in annotation", func(t *testing.T) {
        pod := &corev1.Pod{
            Spec: corev1.PodSpec{
                Containers: []corev1.Container{
                    {Name: "app", Image: "myapp:latest"},
                },
            },
        }

        require.NoError(t, injector.Apply(pod))

        assert.Len(t, pod.Spec.Containers, 1)
    })

    t.Run("idempotent - does not inject twice", func(t *testing.T) {
        pod := &corev1.Pod{
            ObjectMeta: metav1.ObjectMeta{
                Annotations: map[string]string{
                    "sidecar.example.com/inject":   "true",
                    "sidecar.example.com/injected": "true", // Already injected
                },
            },
            Spec: corev1.PodSpec{
                Containers: []corev1.Container{
                    {Name: "app", Image: "myapp:latest"},
                    {Name: "logging-agent", Image: "logging-agent:v2.1.0"},
                },
            },
        }

        require.NoError(t, injector.Apply(pod))

        // Still only 2 containers
        assert.Len(t, pod.Spec.Containers, 2)
    })
}
```

### Integration Test with envtest

```go
package integration_test

import (
    "context"
    "path/filepath"
    "testing"
    "time"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/envtest"
)

func TestWebhookIntegration(t *testing.T) {
    env := &envtest.Environment{
        WebhookInstallOptions: envtest.WebhookInstallOptions{
            Paths: []string{filepath.Join("..", "deploy", "webhook-manifests")},
        },
    }

    cfg, err := env.Start()
    require.NoError(t, err)
    t.Cleanup(func() { env.Stop() })

    k8sClient, err := client.New(cfg, client.Options{})
    require.NoError(t, err)

    // Start webhook server in background using test config
    // (webhook server setup omitted for brevity)

    t.Run("pod gets default resources", func(t *testing.T) {
        pod := &corev1.Pod{
            ObjectMeta: metav1.ObjectMeta{
                Name:      "test-pod",
                Namespace: "default",
            },
            Spec: corev1.PodSpec{
                Containers: []corev1.Container{
                    {Name: "app", Image: "nginx:latest"},
                },
            },
        }

        require.NoError(t, k8sClient.Create(context.Background(), pod))

        ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
        defer cancel()

        require.NoError(t, k8sClient.Get(ctx, client.ObjectKeyFromObject(pod), pod))

        c := pod.Spec.Containers[0]
        assert.NotNil(t, c.Resources.Requests)
        assert.NotNil(t, c.Resources.Limits)
    })
}
```

---

## Webhook Failure Policies

### Choosing Between Fail and Ignore

```yaml
# failurePolicy: Fail (recommended for security-critical mutations)
# If the webhook is unavailable or returns an error, the API request is rejected
webhooks:
  - name: required-labels.webhook.example.com
    failurePolicy: Fail
    # With Fail policy, the webhook must be highly available
    # Use PodDisruptionBudget to protect webhook pods
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: pod-webhook-pdb
  namespace: webhook-system
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: pod-webhook
```

### Circuit Breaker Pattern

For `failurePolicy: Fail` webhooks, a circuit breaker prevents cascading failures:

```go
package webhook

import (
    "net/http"
    "sync/atomic"
    "time"
)

// CircuitBreaker implements a simple circuit breaker for webhook handlers.
// When too many requests timeout or error, the circuit opens and the webhook
// returns immediately (allowing or denying based on failsafe policy).
type CircuitBreaker struct {
    failureCount    atomic.Int64
    lastFailureTime atomic.Int64
    threshold       int64
    resetTimeout    time.Duration
    failsafeAllowed bool // When circuit is open, allow or deny requests
}

func NewCircuitBreaker(threshold int, resetTimeout time.Duration, failsafeAllowed bool) *CircuitBreaker {
    return &CircuitBreaker{
        threshold:       int64(threshold),
        resetTimeout:    resetTimeout,
        failsafeAllowed: failsafeAllowed,
    }
}

func (cb *CircuitBreaker) IsOpen() bool {
    if cb.failureCount.Load() < cb.threshold {
        return false
    }

    lastFailure := time.Unix(0, cb.lastFailureTime.Load())
    if time.Since(lastFailure) > cb.resetTimeout {
        cb.failureCount.Store(0)
        return false
    }

    return true
}

func (cb *CircuitBreaker) RecordFailure() {
    cb.failureCount.Add(1)
    cb.lastFailureTime.Store(time.Now().UnixNano())
}

func (cb *CircuitBreaker) RecordSuccess() {
    cb.failureCount.Store(0)
}

// Middleware wraps a webhook handler with circuit breaker logic.
func (cb *CircuitBreaker) Middleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if cb.IsOpen() {
            // Circuit is open - return failsafe response
            review := buildFailsafeResponse(cb.failsafeAllowed)
            w.Header().Set("Content-Type", "application/json")
            json.NewEncoder(w).Encode(review)
            return
        }

        next.ServeHTTP(w, r)
    })
}
```

---

## Dynamic Certificate Rotation

Webhooks must handle certificate rotation without downtime:

```go
package tls

import (
    "crypto/tls"
    "sync"
    "time"

    "go.uber.org/zap"
)

// RotatingCertProvider loads and automatically rotates TLS certificates.
type RotatingCertProvider struct {
    mu       sync.RWMutex
    cert     *tls.Certificate
    certFile string
    keyFile  string
    logger   *zap.Logger
}

// NewRotatingCertProvider creates a cert provider that checks for new
// certificates every checkInterval.
func NewRotatingCertProvider(certFile, keyFile string, logger *zap.Logger, checkInterval time.Duration) (*RotatingCertProvider, error) {
    p := &RotatingCertProvider{
        certFile: certFile,
        keyFile:  keyFile,
        logger:   logger,
    }

    if err := p.reload(); err != nil {
        return nil, err
    }

    go p.watchForChanges(checkInterval)

    return p, nil
}

func (p *RotatingCertProvider) reload() error {
    cert, err := tls.LoadX509KeyPair(p.certFile, p.keyFile)
    if err != nil {
        return err
    }

    p.mu.Lock()
    p.cert = &cert
    p.mu.Unlock()

    p.logger.Info("TLS certificate loaded/rotated")
    return nil
}

func (p *RotatingCertProvider) watchForChanges(interval time.Duration) {
    ticker := time.NewTicker(interval)
    defer ticker.Stop()

    for range ticker.C {
        if err := p.reload(); err != nil {
            p.logger.Error("reloading certificate", zap.Error(err))
        }
    }
}

// GetCertificate is the function signature expected by tls.Config.GetCertificate.
func (p *RotatingCertProvider) GetCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error) {
    p.mu.RLock()
    defer p.mu.RUnlock()
    return p.cert, nil
}
```

The production-grade webhook pattern covers all aspects: idempotent mutations, proper certificate management, HA deployment, circuit breaking, and comprehensive testing at both unit and integration levels.
