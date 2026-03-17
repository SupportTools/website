---
title: "Kubernetes Dynamic Admission Webhooks: ValidatingAdmissionWebhook, MutatingAdmissionWebhook, Cert Rotation, and Testing"
date: 2031-12-14T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Admission Webhooks", "Validating", "Mutating", "cert-manager", "Operator SDK", "Policy", "Security"]
categories: ["Kubernetes", "Platform Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to building production-grade Kubernetes admission webhooks in Go, covering ValidatingAdmissionWebhook and MutatingAdmissionWebhook implementation, automatic certificate rotation with cert-manager, integration testing with envtest, and operational patterns for webhook availability and debugging."
more_link: "yes"
url: "/kubernetes-dynamic-admission-webhooks-validating-mutating-cert-rotation-testing-guide/"
---

Kubernetes admission webhooks are the primary extensibility point for enforcing organizational policies, injecting sidecar containers, setting resource defaults, and validating custom resource configurations. A webhook that is incorrectly configured or unavailable can block ALL pod creation in a namespace, making webhook reliability and certificate management first-class operational concerns. This guide builds a production-ready webhook from scratch, covering the complete lifecycle from implementation through cert rotation and integration testing.

<!--more-->

# Kubernetes Dynamic Admission Webhooks: Production Guide

## Webhook Architecture

Kubernetes calls admission webhooks during the admission phase of API server request processing. There are two types:

- **MutatingAdmissionWebhook**: Called first; can modify the object (add labels, inject containers, set defaults)
- **ValidatingAdmissionWebhook**: Called second (after mutation); can only allow or deny

```
kubectl apply pod.yaml
    |
    v
[API Server]
    |
    +-- [MutatingAdmissionWebhook handlers] --> object may be modified
    |
    +-- [ValidatingAdmissionWebhook handlers] --> allow or deny
    |
    v
[etcd persistence]
```

Multiple webhooks of each type are called in parallel unless ordered via reinvocationPolicy.

## Project Structure

```
webhook-server/
├── cmd/
│   └── webhook/
│       └── main.go
├── internal/
│   ├── webhook/
│   │   ├── server.go
│   │   ├── mutate_pods.go
│   │   ├── validate_pods.go
│   │   ├── validate_deployments.go
│   │   └── health.go
│   └── certs/
│       └── watcher.go
├── deploy/
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── webhook-configs.yaml
│   └── certificate.yaml
├── test/
│   └── integration/
│       └── webhook_test.go
└── Dockerfile
```

## Building the Webhook Server

### Main Entry Point

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
    "syscall"
    "time"

    "github.com/example/webhook-server/internal/certs"
    "github.com/example/webhook-server/internal/webhook"
)

func main() {
    log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))
    slog.SetDefault(log)

    certFile := envOrDefault("TLS_CERT_FILE", "/certs/tls.crt")
    keyFile  := envOrDefault("TLS_KEY_FILE",  "/certs/tls.key")
    port     := envOrDefault("PORT", "8443")

    // Set up certificate watcher for hot-reload on cert rotation
    certWatcher, err := certs.NewWatcher(certFile, keyFile, log)
    if err != nil {
        log.Error("create cert watcher", "err", err)
        os.Exit(1)
    }

    // TLS config that reloads certs on rotation
    tlsConfig := &tls.Config{
        GetCertificate: certWatcher.GetCertificate,
        MinVersion:     tls.VersionTLS13,
    }

    // Register webhook handlers
    mux := http.NewServeMux()
    mux.HandleFunc("/mutate/pods", webhook.ServeMutatePods(log))
    mux.HandleFunc("/validate/pods", webhook.ServeValidatePods(log))
    mux.HandleFunc("/validate/deployments", webhook.ServeValidateDeployments(log))
    mux.HandleFunc("/healthz", webhook.ServeHealth)
    mux.HandleFunc("/readyz", webhook.ServeReady(certWatcher))

    server := &http.Server{
        Addr:         ":" + port,
        Handler:      mux,
        TLSConfig:    tlsConfig,
        ReadTimeout:  10 * time.Second,
        WriteTimeout: 10 * time.Second,
        IdleTimeout:  120 * time.Second,
    }

    ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
    defer stop()

    go func() {
        log.Info("starting webhook server", "port", port)
        if err := server.ListenAndServeTLS("", ""); err != http.ErrServerClosed {
            log.Error("webhook server failed", "err", err)
            os.Exit(1)
        }
    }()

    go certWatcher.Start(ctx)

    <-ctx.Done()
    log.Info("shutting down webhook server")

    shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := server.Shutdown(shutdownCtx); err != nil {
        log.Error("graceful shutdown failed", "err", err)
    }
}

func envOrDefault(key, defaultVal string) string {
    if v := os.Getenv(key); v != "" {
        return v
    }
    return defaultVal
}
```

### Certificate Hot-Reload Watcher

```go
// internal/certs/watcher.go
package certs

import (
    "crypto/tls"
    "fmt"
    "log/slog"
    "os"
    "sync"
    "time"
)

// Watcher monitors TLS certificate files and reloads them when they change.
// This is essential for cert-manager certificate rotation to take effect
// without restarting the webhook server.
type Watcher struct {
    certFile string
    keyFile  string
    mu       sync.RWMutex
    cert     *tls.Certificate
    log      *slog.Logger
    ready    bool
}

func NewWatcher(certFile, keyFile string, log *slog.Logger) (*Watcher, error) {
    w := &Watcher{
        certFile: certFile,
        keyFile:  keyFile,
        log:      log,
    }
    if err := w.reload(); err != nil {
        return nil, fmt.Errorf("initial cert load: %w", err)
    }
    return w, nil
}

func (w *Watcher) reload() error {
    cert, err := tls.LoadX509KeyPair(w.certFile, w.keyFile)
    if err != nil {
        return fmt.Errorf("load key pair: %w", err)
    }
    w.mu.Lock()
    w.cert = &cert
    w.ready = true
    w.mu.Unlock()
    w.log.Info("TLS certificate reloaded")
    return nil
}

// GetCertificate is compatible with tls.Config.GetCertificate
func (w *Watcher) GetCertificate(_ *tls.ClientHelloInfo) (*tls.Certificate, error) {
    w.mu.RLock()
    defer w.mu.RUnlock()
    if w.cert == nil {
        return nil, fmt.Errorf("no certificate loaded")
    }
    return w.cert, nil
}

// IsReady returns true if a valid certificate is loaded
func (w *Watcher) IsReady() bool {
    w.mu.RLock()
    defer w.mu.RUnlock()
    return w.ready
}

// Start polls for certificate file changes and reloads when they change
func (w *Watcher) Start(ctx context.Context) {
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()

    var lastModTime time.Time

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            info, err := os.Stat(w.certFile)
            if err != nil {
                w.log.Warn("stat cert file", "path", w.certFile, "err", err)
                continue
            }
            if info.ModTime().After(lastModTime) {
                lastModTime = info.ModTime()
                if err := w.reload(); err != nil {
                    w.log.Error("reload cert", "err", err)
                }
            }
        }
    }
}
```

### Mutating Webhook: Pod Sidecar Injection

```go
// internal/webhook/mutate_pods.go
package webhook

import (
    "context"
    "encoding/json"
    "fmt"
    "log/slog"
    "net/http"

    admissionv1 "k8s.io/api/admission/v1"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/resource"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// JSONPatch represents a single JSON Patch operation
type JSONPatch struct {
    Op    string      `json:"op"`
    Path  string      `json:"path"`
    Value interface{} `json:"value,omitempty"`
}

// ServeMutatePods handles Pod mutation requests
func ServeMutatePods(log *slog.Logger) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        ar, err := decodeAdmissionReview(r)
        if err != nil {
            log.Error("decode admission review", "err", err)
            http.Error(w, err.Error(), http.StatusBadRequest)
            return
        }

        response := mutatePod(ar, log)
        response.UID = ar.Request.UID
        sendAdmissionResponse(w, ar, response, log)
    }
}

func mutatePod(ar admissionv1.AdmissionReview, log *slog.Logger) *admissionv1.AdmissionResponse {
    pod := &corev1.Pod{}
    if err := json.Unmarshal(ar.Request.Object.Raw, pod); err != nil {
        return &admissionv1.AdmissionResponse{
            Allowed: false,
            Result:  &metav1.Status{Message: fmt.Sprintf("decode pod: %v", err)},
        }
    }

    var patches []JSONPatch

    // Mutation 1: Add standard labels if missing
    if _, ok := pod.Labels["app.kubernetes.io/managed-by"]; !ok {
        if pod.Labels == nil {
            patches = append(patches, JSONPatch{
                Op:    "add",
                Path:  "/metadata/labels",
                Value: map[string]string{},
            })
        }
        patches = append(patches, JSONPatch{
            Op:    "add",
            Path:  "/metadata/labels/app.kubernetes.io~1managed-by",
            Value: "platform-webhook",
        })
    }

    // Mutation 2: Inject logging sidecar if annotation requests it
    if inject, ok := pod.Annotations["logging.example.com/inject"]; ok && inject == "true" {
        if !hasSidecar(pod, "log-collector") {
            patches = append(patches, injectLogCollectorSidecar(pod)...)
        }
    }

    // Mutation 3: Set default resource requests if not specified
    for i, c := range pod.Spec.Containers {
        if c.Resources.Requests == nil {
            patches = append(patches, JSONPatch{
                Op:    "add",
                Path:  fmt.Sprintf("/spec/containers/%d/resources/requests", i),
                Value: map[string]string{
                    "cpu":    "50m",
                    "memory": "64Mi",
                },
            })
        }
    }

    // Mutation 4: Add pod anti-affinity for workloads with high-availability label
    if pod.Labels["ha.example.com/required"] == "true" {
        if pod.Spec.Affinity == nil || pod.Spec.Affinity.PodAntiAffinity == nil {
            patches = append(patches, injectPodAntiAffinity(pod.Labels["app"])...)
        }
    }

    if len(patches) == 0 {
        return &admissionv1.AdmissionResponse{Allowed: true}
    }

    patchBytes, err := json.Marshal(patches)
    if err != nil {
        return &admissionv1.AdmissionResponse{
            Allowed: false,
            Result:  &metav1.Status{Message: fmt.Sprintf("marshal patches: %v", err)},
        }
    }

    patchType := admissionv1.PatchTypeJSONPatch
    log.Info("mutating pod",
        "pod", pod.Name,
        "namespace", ar.Request.Namespace,
        "patches", len(patches),
    )

    return &admissionv1.AdmissionResponse{
        Allowed:   true,
        Patch:     patchBytes,
        PatchType: &patchType,
    }
}

func hasSidecar(pod *corev1.Pod, name string) bool {
    for _, c := range pod.Spec.InitContainers {
        if c.Name == name {
            return true
        }
    }
    for _, c := range pod.Spec.Containers {
        if c.Name == name {
            return true
        }
    }
    return false
}

func injectLogCollectorSidecar(pod *corev1.Pod) []JSONPatch {
    sidecar := corev1.Container{
        Name:  "log-collector",
        Image: "registry.example.com/log-collector:v2.1.0",
        Resources: corev1.ResourceRequirements{
            Requests: corev1.ResourceList{
                corev1.ResourceCPU:    resource.MustParse("10m"),
                corev1.ResourceMemory: resource.MustParse("32Mi"),
            },
            Limits: corev1.ResourceList{
                corev1.ResourceCPU:    resource.MustParse("100m"),
                corev1.ResourceMemory: resource.MustParse("64Mi"),
            },
        },
        VolumeMounts: []corev1.VolumeMount{
            {
                Name:      "varlog",
                MountPath: "/var/log",
            },
        },
    }

    var patches []JSONPatch
    if len(pod.Spec.Containers) == 0 {
        patches = append(patches, JSONPatch{
            Op:    "add",
            Path:  "/spec/containers",
            Value: []corev1.Container{sidecar},
        })
    } else {
        patches = append(patches, JSONPatch{
            Op:    "add",
            Path:  "/spec/containers/-",
            Value: sidecar,
        })
    }

    return patches
}

func injectPodAntiAffinity(appLabel string) []JSONPatch {
    affinity := corev1.Affinity{
        PodAntiAffinity: &corev1.PodAntiAffinity{
            PreferredDuringSchedulingIgnoredDuringExecution: []corev1.WeightedPodAffinityTerm{
                {
                    Weight: 100,
                    PodAffinityTerm: corev1.PodAffinityTerm{
                        LabelSelector: &metav1.LabelSelector{
                            MatchLabels: map[string]string{"app": appLabel},
                        },
                        TopologyKey: "topology.kubernetes.io/zone",
                    },
                },
            },
        },
    }

    return []JSONPatch{
        {
            Op:    "add",
            Path:  "/spec/affinity",
            Value: affinity,
        },
    }
}
```

### Validating Webhook: Policy Enforcement

```go
// internal/webhook/validate_pods.go
package webhook

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

// ServeValidatePods handles Pod validation requests
func ServeValidatePods(log *slog.Logger) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        ar, err := decodeAdmissionReview(r)
        if err != nil {
            http.Error(w, err.Error(), http.StatusBadRequest)
            return
        }
        response := validatePod(ar, log)
        response.UID = ar.Request.UID
        sendAdmissionResponse(w, ar, response, log)
    }
}

type ValidationRule func(pod *corev1.Pod, ns string) []string

var podValidationRules = []ValidationRule{
    requireCostCenterLabel,
    requireTeamLabel,
    requireResourceRequests,
    forbidPrivilegedContainers,
    forbidHostNetworkInProduction,
    requireReadinessProbeInProduction,
    validateImageRegistry,
}

func validatePod(ar admissionv1.AdmissionReview, log *slog.Logger) *admissionv1.AdmissionResponse {
    pod := &corev1.Pod{}
    if err := json.Unmarshal(ar.Request.Object.Raw, pod); err != nil {
        return &admissionv1.AdmissionResponse{
            Allowed: false,
            Result:  &metav1.Status{Message: fmt.Sprintf("decode pod: %v", err)},
        }
    }

    var allViolations []string
    for _, rule := range podValidationRules {
        violations := rule(pod, ar.Request.Namespace)
        allViolations = append(allViolations, violations...)
    }

    if len(allViolations) > 0 {
        msg := fmt.Sprintf("Pod policy violations:\n- %s",
            strings.Join(allViolations, "\n- "))
        log.Warn("pod rejected by admission webhook",
            "pod", pod.Name,
            "namespace", ar.Request.Namespace,
            "violations", allViolations,
        )
        return &admissionv1.AdmissionResponse{
            Allowed: false,
            Result: &metav1.Status{
                Code:    http.StatusForbidden,
                Message: msg,
                Reason:  metav1.StatusReasonForbidden,
            },
        }
    }

    return &admissionv1.AdmissionResponse{Allowed: true}
}

func requireCostCenterLabel(pod *corev1.Pod, _ string) []string {
    if _, ok := pod.Labels["cost-center"]; !ok {
        return []string{"label 'cost-center' is required on all pods"}
    }
    return nil
}

func requireTeamLabel(pod *corev1.Pod, _ string) []string {
    if _, ok := pod.Labels["team"]; !ok {
        return []string{"label 'team' is required on all pods"}
    }
    return nil
}

func requireResourceRequests(pod *corev1.Pod, _ string) []string {
    var violations []string
    for _, c := range pod.Spec.Containers {
        if c.Resources.Requests == nil {
            violations = append(violations,
                fmt.Sprintf("container %q: resource requests are required", c.Name))
            continue
        }
        if c.Resources.Requests.Cpu().IsZero() {
            violations = append(violations,
                fmt.Sprintf("container %q: cpu request is required", c.Name))
        }
        if c.Resources.Requests.Memory().IsZero() {
            violations = append(violations,
                fmt.Sprintf("container %q: memory request is required", c.Name))
        }
    }
    return violations
}

func forbidPrivilegedContainers(pod *corev1.Pod, _ string) []string {
    var violations []string
    for _, c := range pod.Spec.Containers {
        if c.SecurityContext != nil &&
            c.SecurityContext.Privileged != nil &&
            *c.SecurityContext.Privileged {
            violations = append(violations,
                fmt.Sprintf("container %q: privileged mode is forbidden", c.Name))
        }
    }
    // Check pod-level security context
    if pod.Spec.SecurityContext != nil {
        for _, sysctls := range pod.Spec.SecurityContext.Sysctls {
            if !isSafeKernelParam(sysctls.Name) {
                violations = append(violations,
                    fmt.Sprintf("sysctl %q is not in the allowed list", sysctls.Name))
            }
        }
    }
    return violations
}

func forbidHostNetworkInProduction(pod *corev1.Pod, ns string) []string {
    if !isProductionNamespace(ns) {
        return nil
    }
    if pod.Spec.HostNetwork {
        return []string{"hostNetwork is forbidden in production namespaces"}
    }
    return nil
}

func requireReadinessProbeInProduction(pod *corev1.Pod, ns string) []string {
    if !isProductionNamespace(ns) {
        return nil
    }
    var violations []string
    for _, c := range pod.Spec.Containers {
        if c.ReadinessProbe == nil {
            violations = append(violations,
                fmt.Sprintf("container %q: readiness probe is required in production", c.Name))
        }
    }
    return violations
}

func validateImageRegistry(pod *corev1.Pod, _ string) []string {
    allowedRegistries := []string{
        "registry.example.com/",
        "gcr.io/distroless/",
        "registry.k8s.io/",
    }
    var violations []string
    for _, c := range pod.Spec.Containers {
        allowed := false
        for _, reg := range allowedRegistries {
            if strings.HasPrefix(c.Image, reg) {
                allowed = true
                break
            }
        }
        if !allowed {
            violations = append(violations,
                fmt.Sprintf("container %q: image %q is not from an allowed registry", c.Name, c.Image))
        }
    }
    return violations
}

func isProductionNamespace(ns string) bool {
    return strings.HasPrefix(ns, "production") || ns == "prod"
}

func isSafeKernelParam(name string) bool {
    safeSysctls := map[string]bool{
        "net.ipv4.tcp_fin_timeout":      true,
        "net.ipv4.tcp_keepalive_time":   true,
        "net.ipv4.tcp_keepalive_intvl":  true,
        "net.ipv4.tcp_keepalive_probes": true,
        "net.core.somaxconn":            true,
    }
    return safeSysctls[name]
}
```

### Shared Utilities

```go
// internal/webhook/server.go
package webhook

import (
    "encoding/json"
    "fmt"
    "io"
    "log/slog"
    "net/http"

    admissionv1 "k8s.io/api/admission/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func decodeAdmissionReview(r *http.Request) (admissionv1.AdmissionReview, error) {
    var ar admissionv1.AdmissionReview

    if r.Method != http.MethodPost {
        return ar, fmt.Errorf("expected POST, got %s", r.Method)
    }

    body, err := io.ReadAll(io.LimitReader(r.Body, 10<<20)) // 10 MiB limit
    if err != nil {
        return ar, fmt.Errorf("read body: %w", err)
    }

    if err := json.Unmarshal(body, &ar); err != nil {
        return ar, fmt.Errorf("unmarshal AdmissionReview: %w", err)
    }

    if ar.Request == nil {
        return ar, fmt.Errorf("admission review has no request")
    }

    return ar, nil
}

func sendAdmissionResponse(
    w http.ResponseWriter,
    ar admissionv1.AdmissionReview,
    response *admissionv1.AdmissionResponse,
    log *slog.Logger,
) {
    responseAR := admissionv1.AdmissionReview{
        TypeMeta: metav1.TypeMeta{
            APIVersion: "admission.k8s.io/v1",
            Kind:       "AdmissionReview",
        },
        Response: response,
    }

    responseBytes, err := json.Marshal(responseAR)
    if err != nil {
        log.Error("marshal admission response", "err", err)
        http.Error(w, "internal error", http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusOK)
    w.Write(responseBytes)
}
```

## Certificate Management with cert-manager

### Certificate Resource

```yaml
# deploy/certificate.yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: webhook-server-cert
  namespace: webhook-system
spec:
  secretName: webhook-server-tls
  duration: 8760h    # 1 year
  renewBefore: 720h  # Renew 30 days before expiry
  subject:
    organizations:
      - example.com
  dnsNames:
    - webhook-server
    - webhook-server.webhook-system.svc
    - webhook-server.webhook-system.svc.cluster.local
  issuerRef:
    name: internal-ca-issuer
    kind: ClusterIssuer
```

### Webhook Configuration with CA Injection

```yaml
# deploy/webhook-configs.yaml
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: platform-webhook-mutating
  annotations:
    # cert-manager will inject the CA bundle into caBundle field automatically
    cert-manager.io/inject-ca-from: "webhook-system/webhook-server-cert"
webhooks:
  - name: mutate-pods.webhook.example.com
    admissionReviewVersions: ["v1"]
    sideEffects: None
    timeoutSeconds: 10
    failurePolicy: Ignore  # IMPORTANT: Ignore = allow even if webhook is down
    # For critical policies, use Fail; have robust HA setup
    matchPolicy: Equivalent
    namespaceSelector:
      matchExpressions:
        - key: webhook.example.com/inject
          operator: In
          values: ["true"]
    objectSelector:
      matchExpressions:
        - key: webhook.example.com/skip-mutation
          operator: DoesNotExist
    rules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        resources: ["pods"]
        operations: ["CREATE"]
    clientConfig:
      service:
        name: webhook-server
        namespace: webhook-system
        path: /mutate/pods
        port: 8443
    reinvocationPolicy: Never

---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: platform-webhook-validating
  annotations:
    cert-manager.io/inject-ca-from: "webhook-system/webhook-server-cert"
webhooks:
  - name: validate-pods.webhook.example.com
    admissionReviewVersions: ["v1"]
    sideEffects: None
    timeoutSeconds: 10
    failurePolicy: Fail  # Validation is critical — fail if webhook is down
    matchPolicy: Equivalent
    namespaceSelector:
      matchExpressions:
        - key: webhook.example.com/enforce
          operator: In
          values: ["true"]
        - key: kubernetes.io/metadata.name
          operator: NotIn
          values: ["kube-system", "kube-public", "webhook-system"]
    rules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        resources: ["pods"]
        operations: ["CREATE", "UPDATE"]
    clientConfig:
      service:
        name: webhook-server
        namespace: webhook-system
        path: /validate/pods
        port: 8443
```

### High-Availability Deployment

```yaml
# deploy/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: webhook-server
  namespace: webhook-system
spec:
  replicas: 3      # HA: 3 replicas across zones
  selector:
    matchLabels:
      app: webhook-server
  template:
    metadata:
      labels:
        app: webhook-server
    spec:
      serviceAccountName: webhook-server
      priorityClassName: system-cluster-critical  # High priority
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: webhook-server
      containers:
        - name: webhook-server
          image: registry.example.com/webhook-server:v1.0.0
          ports:
            - containerPort: 8443
          env:
            - name: TLS_CERT_FILE
              value: /certs/tls.crt
            - name: TLS_KEY_FILE
              value: /certs/tls.key
          volumeMounts:
            - name: tls-certs
              mountPath: /certs
              readOnly: true
          resources:
            requests:
              cpu: "100m"
              memory: "128Mi"
            limits:
              cpu: "500m"
              memory: "256Mi"
          readinessProbe:
            httpGet:
              path: /readyz
              port: 8443
              scheme: HTTPS
            periodSeconds: 5
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8443
              scheme: HTTPS
            initialDelaySeconds: 10
            periodSeconds: 10
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            runAsNonRoot: true
            runAsUser: 65534
            seccompProfile:
              type: RuntimeDefault
            capabilities:
              drop: ["ALL"]
      volumes:
        - name: tls-certs
          secret:
            secretName: webhook-server-tls
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: webhook-server-pdb
  namespace: webhook-system
spec:
  minAvailable: 2  # Always keep at least 2 pods during node drains
  selector:
    matchLabels:
      app: webhook-server
```

## Integration Testing with envtest

```go
// test/integration/webhook_test.go
package integration_test

import (
    "context"
    "path/filepath"
    "testing"

    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/resource"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/envtest"
    "sigs.k8s.io/controller-runtime/pkg/webhook"
    "sigs.k8s.io/controller-runtime/pkg/webhook/admission"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    "github.com/stretchr/testify/suite"
)

type WebhookIntegrationSuite struct {
    suite.Suite
    env    *envtest.Environment
    client client.Client
    ctx    context.Context
    cancel context.CancelFunc
}

func (s *WebhookIntegrationSuite) SetupSuite() {
    s.ctx, s.cancel = context.WithCancel(context.Background())

    s.env = &envtest.Environment{
        CRDDirectoryPaths: []string{
            filepath.Join("..", "..", "deploy", "crds"),
        },
        WebhookInstallOptions: envtest.WebhookInstallOptions{
            Paths: []string{
                filepath.Join("..", "..", "deploy", "webhook-configs.yaml"),
            },
        },
        ErrorIfCRDPathMissing: false,
    }

    cfg, err := s.env.Start()
    require.NoError(s.T(), err)

    scheme := runtime.NewScheme()
    require.NoError(s.T(), corev1.AddToScheme(scheme))

    s.client, err = client.New(cfg, client.Options{Scheme: scheme})
    require.NoError(s.T(), err)

    // Register webhook handlers against the envtest webhook server
    webhookServer := webhook.NewServer(webhook.Options{
        Port:    s.env.WebhookInstallOptions.LocalServingPort,
        Host:    s.env.WebhookInstallOptions.LocalServingHost,
        CertDir: s.env.WebhookInstallOptions.LocalServingCertDir,
    })

    log := slog.Default()
    webhookServer.Register("/mutate/pods", &admission.Webhook{
        Handler: &PodMutator{Log: log},
    })
    webhookServer.Register("/validate/pods", &admission.Webhook{
        Handler: &PodValidator{Log: log},
    })

    go func() {
        require.NoError(s.T(), webhookServer.Start(s.ctx))
    }()
}

func (s *WebhookIntegrationSuite) TearDownSuite() {
    s.cancel()
    require.NoError(s.T(), s.env.Stop())
}

func (s *WebhookIntegrationSuite) TestValidation_MissingCostCenterLabel() {
    pod := &corev1.Pod{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "test-pod-no-cost-center",
            Namespace: "production",
            Labels: map[string]string{
                "team": "platform",
                // cost-center is missing
            },
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
                    ReadinessProbe: &corev1.Probe{
                        ProbeHandler: corev1.ProbeHandler{
                            HTTPGet: &corev1.HTTPGetAction{
                                Path: "/health",
                                Port: intstr.FromInt(8080),
                            },
                        },
                    },
                },
            },
        },
    }

    err := s.client.Create(s.ctx, pod)
    require.Error(s.T(), err)
    assert.Contains(s.T(), err.Error(), "cost-center")
}

func (s *WebhookIntegrationSuite) TestMutation_InjectsDefaultLabels() {
    pod := &corev1.Pod{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "test-pod-mutation",
            Namespace: "default",
            Labels: map[string]string{
                "cost-center": "engineering",
                "team":        "platform",
            },
        },
        Spec: corev1.PodSpec{
            Containers: []corev1.Container{
                {
                    Name:  "app",
                    Image: "registry.example.com/app:v1",
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

    require.NoError(s.T(), s.client.Create(s.ctx, pod))
    defer s.client.Delete(s.ctx, pod)

    // Re-fetch to get the mutated version
    var mutatedPod corev1.Pod
    require.NoError(s.T(), s.client.Get(s.ctx, client.ObjectKeyFromObject(pod), &mutatedPod))

    assert.Equal(s.T(), "platform-webhook",
        mutatedPod.Labels["app.kubernetes.io/managed-by"])
}

func (s *WebhookIntegrationSuite) TestValidation_PrivilegedContainerRejected() {
    priv := true
    pod := &corev1.Pod{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "privileged-pod",
            Namespace: "production",
            Labels: map[string]string{
                "cost-center": "security",
                "team":        "infra",
            },
        },
        Spec: corev1.PodSpec{
            Containers: []corev1.Container{
                {
                    Name:  "privileged",
                    Image: "registry.example.com/privileged:v1",
                    SecurityContext: &corev1.SecurityContext{
                        Privileged: &priv,
                    },
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

    err := s.client.Create(s.ctx, pod)
    require.Error(s.T(), err)
    assert.Contains(s.T(), err.Error(), "privileged mode is forbidden")
}

func TestWebhookIntegrationSuite(t *testing.T) {
    suite.Run(t, new(WebhookIntegrationSuite))
}
```

## Operational Debugging

### Checking Webhook Health

```bash
#!/usr/bin/env bash
# check-webhook-health.sh

echo "=== Admission Webhook Health Check ==="

echo ""
echo "Webhook server pods:"
kubectl -n webhook-system get pods -l app=webhook-server -o wide

echo ""
echo "Certificate expiry:"
kubectl -n webhook-system get certificate webhook-server-cert \
  -o jsonpath='{.status.notAfter}' && echo ""

echo ""
echo "Webhook configuration status:"
kubectl get validatingwebhookconfigurations platform-webhook-validating \
  -o jsonpath='{.webhooks[*].name}' && echo ""

echo ""
echo "Recent webhook call errors (from API server logs):"
kubectl -n kube-system logs -l component=kube-apiserver --since=5m 2>/dev/null | \
  grep -E "webhook|admission" | tail -20

echo ""
echo "Testing webhook endpoint directly:"
kubectl -n webhook-system port-forward deploy/webhook-server 8443:8443 &
PF_PID=$!
sleep 2
curl -sk https://localhost:8443/healthz | python3 -m json.tool || true
kill "${PF_PID}" 2>/dev/null
```

### Dry-Run Admission Testing

```bash
# Test if a pod would be admitted without actually creating it
kubectl apply --dry-run=server -f test-pod.yaml

# Test mutation output
kubectl apply --dry-run=server -o yaml -f test-pod.yaml | \
  grep -A5 "labels:"
```

## Summary

Production admission webhooks require attention to four areas beyond basic functionality: availability, certificate lifecycle, failure policy, and testing. For availability, deploy at least 3 replicas across zones with a PodDisruptionBudget, use `priorityClassName: system-cluster-critical`, and always set `failurePolicy: Ignore` for non-critical mutations to avoid blocking workloads during webhook downtime. For certificates, cert-manager with CA injection into the webhook configuration eliminates manual CA bundle updates entirely, and a hot-reload cert watcher eliminates the need to restart the server on renewal. Set `failurePolicy: Fail` only for security-critical validating webhooks and ensure robust HA so that policy enforcement never blocks cluster operations. Use envtest for integration tests that exercise the real webhook admission pipeline against a real (local) API server, which catches both the Go logic and the webhook registration configuration.
