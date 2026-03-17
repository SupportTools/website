---
title: "Kubernetes Admission Webhooks: Implementation, cert-manager TLS, and Production Testing"
date: 2028-05-31T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Admission Webhooks", "Go", "cert-manager", "Security", "Policy Enforcement"]
categories: ["Kubernetes", "Security", "Platform Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Kubernetes admission webhooks covering ValidatingAdmissionWebhook vs MutatingAdmissionWebhook, Go webhook server implementation, cert-manager TLS integration, failure policies, and production testing strategies."
more_link: "yes"
url: "/kubernetes-admission-webhooks-production-guide/"
---

Kubernetes admission webhooks extend the API server's admission process, enabling platform teams to enforce organizational policies and inject configuration at resource creation time. A mutating webhook can add sidecar containers, inject environment variables, or apply security contexts. A validating webhook can reject resources that violate cost limits, label requirements, or security policies. This guide covers building production-grade webhook servers in Go, securing them with cert-manager, and testing them thoroughly before cluster-wide deployment.

<!--more-->

## Admission Control Architecture

Kubernetes processes every API server request through an admission chain:

```
kubectl apply →  API Server
                     ↓
                Authentication
                     ↓
                Authorization (RBAC)
                     ↓
            Mutating Admission Plugins
                     ↓
             MutatingAdmissionWebhooks  ← custom webhooks (mutation)
                     ↓
            Object Schema Validation
                     ↓
           ValidatingAdmissionPlugins
                     ↓
           ValidatingAdmissionWebhooks  ← custom webhooks (validation)
                     ↓
              Stored to etcd
```

**Key distinction**: Mutating webhooks run before validating webhooks. Multiple mutating webhooks can modify the same object — each receives the result of the previous webhook's mutations. Validating webhooks see the final mutated object.

## Webhook vs Admission Policies

Before building a custom webhook, consider whether `ValidatingAdmissionPolicy` (CEL-based, GA in 1.30) covers the use case:

```yaml
# CEL policy — no webhook server required
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: require-labels
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups: ["apps"]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["deployments"]
  validations:
    - expression: "has(object.metadata.labels) && has(object.metadata.labels.team)"
      message: "Deployment must have a 'team' label"
    - expression: "has(object.metadata.labels) && has(object.metadata.labels.env)"
      message: "Deployment must have an 'env' label"
```

Use custom webhooks when you need:
- External system lookups (check a cost management API)
- Complex mutation logic (generate dynamic values)
- State that CEL cannot express
- Legacy compatibility requirements

## Building a Webhook Server in Go

### Project Structure

```
webhook-server/
├── cmd/
│   └── webhook/
│       └── main.go
├── internal/
│   ├── webhook/
│   │   ├── server.go
│   │   ├── handler.go
│   │   ├── mutating/
│   │   │   ├── sidecar_injector.go
│   │   │   └── resource_limits.go
│   │   └── validating/
│   │       ├── label_validator.go
│   │       └── cost_validator.go
│   └── tls/
│       └── certloader.go
├── go.mod
└── Dockerfile
```

### Main Server

```go
// cmd/webhook/main.go
package main

import (
    "context"
    "crypto/tls"
    "flag"
    "log/slog"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/example/webhook-server/internal/webhook"
    "github.com/example/webhook-server/internal/tls"
)

func main() {
    var (
        port        = flag.String("port", "8443", "HTTPS port")
        certDir     = flag.String("cert-dir", "/etc/webhook/certs", "Directory with tls.crt and tls.key")
        metricsPort = flag.String("metrics-port", "9090", "Metrics port")
    )
    flag.Parse()

    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))
    slog.SetDefault(logger)

    // Load TLS certificates with hot-reload support
    certLoader, err := tls.NewDynamicCertLoader(*certDir)
    if err != nil {
        slog.Error("failed to load certificates", "err", err)
        os.Exit(1)
    }

    // Build the mux
    mux := webhook.NewServeMux()

    srv := &http.Server{
        Addr:    ":" + *port,
        Handler: mux,
        TLSConfig: &tls.Config{
            GetCertificate: certLoader.GetCertificate,
            MinVersion:     tls.VersionTLS13,
        },
        ReadTimeout:       10 * time.Second,
        WriteTimeout:      10 * time.Second,
        IdleTimeout:       60 * time.Second,
        ReadHeaderTimeout: 5 * time.Second,
    }

    // Start metrics server
    go startMetricsServer(*metricsPort)

    // Start webhook server
    go func() {
        slog.Info("starting webhook server", "addr", srv.Addr)
        if err := srv.ListenAndServeTLS("", ""); err != nil && err != http.ErrServerClosed {
            slog.Error("webhook server failed", "err", err)
            os.Exit(1)
        }
    }()

    // Graceful shutdown
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
    <-quit

    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()
    if err := srv.Shutdown(ctx); err != nil {
        slog.Error("shutdown error", "err", err)
    }
    slog.Info("webhook server stopped")
}
```

### Handler Foundation

```go
// internal/webhook/handler.go
package webhook

import (
    "encoding/json"
    "io"
    "log/slog"
    "net/http"

    admissionv1 "k8s.io/api/admission/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type Handler interface {
    Handle(req *admissionv1.AdmissionRequest) *admissionv1.AdmissionResponse
}

// AdmitFunc is a simpler function-based handler
type AdmitFunc func(req *admissionv1.AdmissionRequest) (*admissionv1.AdmissionResponse, error)

func NewServeMux() *http.ServeMux {
    mux := http.NewServeMux()

    // Mutating webhooks
    mux.Handle("/mutate/sidecar-inject", admitHandler(sidecarInjector))
    mux.Handle("/mutate/resource-defaults", admitHandler(resourceDefaults))

    // Validating webhooks
    mux.Handle("/validate/labels", admitHandler(labelValidator))
    mux.Handle("/validate/cost", admitHandler(costValidator))

    // Health endpoints
    mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    })
    mux.HandleFunc("/readyz", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    })

    return mux
}

func admitHandler(fn AdmitFunc) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if r.Method != http.MethodPost {
            http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
            return
        }

        if ct := r.Header.Get("Content-Type"); ct != "application/json" {
            http.Error(w, "invalid content type", http.StatusBadRequest)
            return
        }

        body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // 1MB limit
        if err != nil {
            http.Error(w, "failed to read body", http.StatusBadRequest)
            return
        }

        var review admissionv1.AdmissionReview
        if err := json.Unmarshal(body, &review); err != nil {
            slog.Error("failed to decode admission review", "err", err)
            http.Error(w, "invalid JSON", http.StatusBadRequest)
            return
        }

        if review.Request == nil {
            http.Error(w, "missing request", http.StatusBadRequest)
            return
        }

        // Process the admission request
        response, err := fn(review.Request)
        if err != nil {
            slog.Error("webhook handler error",
                "uid", review.Request.UID,
                "err", err,
            )
            response = &admissionv1.AdmissionResponse{
                UID:     review.Request.UID,
                Allowed: false,
                Result: &metav1.Status{
                    Code:    http.StatusInternalServerError,
                    Message: "internal webhook error",
                },
            }
        }

        response.UID = review.Request.UID

        // Encode and send response
        review.Response = response
        review.Request = nil // Don't echo request back

        w.Header().Set("Content-Type", "application/json")
        if err := json.NewEncoder(w).Encode(review); err != nil {
            slog.Error("failed to encode response", "uid", review.Response.UID, "err", err)
        }
    })
}

// Helpers for building responses
func Allowed(uid types.UID) *admissionv1.AdmissionResponse {
    return &admissionv1.AdmissionResponse{
        UID:     uid,
        Allowed: true,
    }
}

func Denied(uid types.UID, message string) *admissionv1.AdmissionResponse {
    return &admissionv1.AdmissionResponse{
        UID:     uid,
        Allowed: false,
        Result: &metav1.Status{
            Code:    http.StatusForbidden,
            Message: message,
        },
    }
}

func DeniedWithWarning(uid types.UID, message, warning string) *admissionv1.AdmissionResponse {
    return &admissionv1.AdmissionResponse{
        UID:     uid,
        Allowed: false,
        Warnings: []string{warning},
        Result: &metav1.Status{
            Code:    http.StatusForbidden,
            Message: message,
        },
    }
}
```

### Mutating Webhook: Sidecar Injector

```go
// internal/webhook/mutating/sidecar_injector.go
package mutating

import (
    "encoding/json"
    "fmt"

    admissionv1 "k8s.io/api/admission/v1"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/util/strategicpatch"
)

const (
    injectAnnotation = "sidecar.example.com/inject"
    injectedLabel    = "sidecar.example.com/injected"
)

var sidecarContainer = corev1.Container{
    Name:  "envoy-proxy",
    Image: "envoyproxy/envoy:v1.29.0",
    Ports: []corev1.ContainerPort{
        {Name: "envoy-admin", ContainerPort: 9901},
        {Name: "envoy-proxy", ContainerPort: 15001},
    },
    Resources: corev1.ResourceRequirements{
        Requests: corev1.ResourceList{
            corev1.ResourceCPU:    resource.MustParse("50m"),
            corev1.ResourceMemory: resource.MustParse("64Mi"),
        },
        Limits: corev1.ResourceList{
            corev1.ResourceCPU:    resource.MustParse("200m"),
            corev1.ResourceMemory: resource.MustParse("256Mi"),
        },
    },
    VolumeMounts: []corev1.VolumeMount{
        {
            Name:      "envoy-config",
            MountPath: "/etc/envoy",
        },
    },
}

func SidecarInjector(req *admissionv1.AdmissionRequest) (*admissionv1.AdmissionResponse, error) {
    if req.Resource.Resource != "pods" {
        return Allowed(req.UID), nil
    }

    var pod corev1.Pod
    if err := json.Unmarshal(req.Object.Raw, &pod); err != nil {
        return nil, fmt.Errorf("decode pod: %w", err)
    }

    // Check injection annotation
    if pod.Annotations[injectAnnotation] != "true" {
        return Allowed(req.UID), nil
    }

    // Already injected (idempotency check)
    if pod.Labels[injectedLabel] == "true" {
        return Allowed(req.UID), nil
    }

    // Build the patch
    patch, err := buildSidecarPatch(&pod)
    if err != nil {
        return nil, fmt.Errorf("build patch: %w", err)
    }

    patchType := admissionv1.PatchTypeJSONPatch
    return &admissionv1.AdmissionResponse{
        UID:       req.UID,
        Allowed:   true,
        Patch:     patch,
        PatchType: &patchType,
    }, nil
}

func buildSidecarPatch(pod *corev1.Pod) ([]byte, error) {
    type patchOperation struct {
        Op    string      `json:"op"`
        Path  string      `json:"path"`
        Value interface{} `json:"value,omitempty"`
    }

    var ops []patchOperation

    // Initialize containers array if empty
    if len(pod.Spec.Containers) == 0 {
        ops = append(ops, patchOperation{
            Op:    "add",
            Path:  "/spec/containers",
            Value: []corev1.Container{},
        })
    }

    // Inject sidecar container
    ops = append(ops, patchOperation{
        Op:    "add",
        Path:  "/spec/containers/-",
        Value: sidecarContainer,
    })

    // Inject init container for iptables setup
    ops = append(ops, patchOperation{
        Op:   "add",
        Path: "/spec/initContainers/-",
        Value: corev1.Container{
            Name:            "envoy-init",
            Image:           "envoyproxy/envoy-init:v1.29.0",
            ImagePullPolicy: corev1.PullIfNotPresent,
            SecurityContext: &corev1.SecurityContext{
                Capabilities: &corev1.Capabilities{
                    Add: []corev1.Capability{"NET_ADMIN"},
                },
                RunAsNonRoot: ptr(false),
                RunAsUser:    ptr(int64(0)),
            },
        },
    })

    // Add injected label
    if pod.Labels == nil {
        ops = append(ops, patchOperation{
            Op:    "add",
            Path:  "/metadata/labels",
            Value: map[string]string{},
        })
    }
    ops = append(ops, patchOperation{
        Op:    "add",
        Path:  "/metadata/labels/sidecar.example.com~1injected",
        Value: "true",
    })

    // Add envoy config volume
    ops = append(ops, patchOperation{
        Op:   "add",
        Path: "/spec/volumes/-",
        Value: corev1.Volume{
            Name: "envoy-config",
            VolumeSource: corev1.VolumeSource{
                ConfigMap: &corev1.ConfigMapVolumeSource{
                    LocalObjectReference: corev1.LocalObjectReference{
                        Name: "envoy-bootstrap-config",
                    },
                },
            },
        },
    })

    return json.Marshal(ops)
}

func ptr[T any](v T) *T { return &v }
```

### Validating Webhook: Label Enforcement

```go
// internal/webhook/validating/label_validator.go
package validating

import (
    "encoding/json"
    "fmt"
    "strings"

    admissionv1 "k8s.io/api/admission/v1"
    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
)

var requiredLabels = map[string]struct{}{
    "app":     {},
    "version": {},
    "team":    {},
    "env":     {},
}

var allowedEnvValues = map[string]bool{
    "production":  true,
    "staging":     true,
    "development": true,
    "test":        true,
}

func LabelValidator(req *admissionv1.AdmissionRequest) (*admissionv1.AdmissionResponse, error) {
    var labels map[string]string

    switch req.Resource.Resource {
    case "deployments":
        var deploy appsv1.Deployment
        if err := json.Unmarshal(req.Object.Raw, &deploy); err != nil {
            return nil, err
        }
        labels = deploy.Spec.Template.Labels
    case "pods":
        var pod corev1.Pod
        if err := json.Unmarshal(req.Object.Raw, &pod); err != nil {
            return nil, err
        }
        labels = pod.Labels
    default:
        return Allowed(req.UID), nil
    }

    var violations []string

    // Check required labels
    for label := range requiredLabels {
        if _, ok := labels[label]; !ok {
            violations = append(violations, fmt.Sprintf("missing required label %q", label))
        }
    }

    // Validate env label value
    if env, ok := labels["env"]; ok && !allowedEnvValues[env] {
        violations = append(violations, fmt.Sprintf(
            "label 'env' has invalid value %q, must be one of: %s",
            env,
            strings.Join(validEnvList(), ", "),
        ))
    }

    // Validate app label format (lowercase alphanumeric with hyphens)
    if app, ok := labels["app"]; ok {
        if !isValidAppName(app) {
            violations = append(violations, fmt.Sprintf(
                "label 'app' value %q must be lowercase alphanumeric with hyphens",
                app,
            ))
        }
    }

    if len(violations) > 0 {
        return Denied(req.UID, strings.Join(violations, "; ")), nil
    }

    return Allowed(req.UID), nil
}

func validEnvList() []string {
    var envs []string
    for k := range allowedEnvValues {
        envs = append(envs, k)
    }
    sort.Strings(envs)
    return envs
}

func isValidAppName(name string) bool {
    if len(name) == 0 || len(name) > 63 {
        return false
    }
    for _, c := range name {
        if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-') {
            return false
        }
    }
    return !strings.HasPrefix(name, "-") && !strings.HasSuffix(name, "-")
}
```

## cert-manager Integration

### Issuer and Certificate

```yaml
# webhook-tls.yaml
apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: webhook-selfsigned-issuer
  namespace: webhook-system
spec:
  selfSigned: {}
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: webhook-cert
  namespace: webhook-system
spec:
  secretName: webhook-tls
  duration: 8760h   # 1 year
  renewBefore: 720h # Renew 30 days before expiry
  issuerRef:
    name: webhook-selfsigned-issuer
    kind: Issuer
  dnsNames:
    - webhook-server.webhook-system.svc
    - webhook-server.webhook-system.svc.cluster.local
  privateKey:
    algorithm: ECDSA
    size: 256
  usages:
    - digital signature
    - key encipherment
    - server auth
```

### CA Injection with cert-manager

cert-manager can automatically inject the CA bundle into webhook configurations:

```yaml
# mutating-webhook-config.yaml
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: sidecar-injector
  annotations:
    # cert-manager automatically injects the CA bundle
    cert-manager.io/inject-ca-from: webhook-system/webhook-cert
webhooks:
  - name: sidecar-inject.example.com
    admissionReviewVersions: ["v1"]
    clientConfig:
      service:
        name: webhook-server
        namespace: webhook-system
        path: /mutate/sidecar-inject
        port: 443
    rules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        operations: ["CREATE"]
        resources: ["pods"]
    namespaceSelector:
      matchLabels:
        sidecar-injection: enabled
    # Inject only if annotation is present
    objectSelector:
      matchExpressions:
        - key: sidecar.example.com/inject
          operator: In
          values: ["true"]
    failurePolicy: Ignore
    sideEffects: None
    timeoutSeconds: 5
    reinvocationPolicy: Never
---
# validating-webhook-config.yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: label-validator
  annotations:
    cert-manager.io/inject-ca-from: webhook-system/webhook-cert
webhooks:
  - name: validate-labels.example.com
    admissionReviewVersions: ["v1"]
    clientConfig:
      service:
        name: webhook-server
        namespace: webhook-system
        path: /validate/labels
        port: 443
    rules:
      - apiGroups: ["apps"]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["deployments"]
    namespaceSelector:
      matchExpressions:
        - key: webhook.example.com/skip-validation
          operator: DoesNotExist
    failurePolicy: Fail    # Reject resources if webhook is unavailable
    sideEffects: None
    timeoutSeconds: 10
```

## Failure Policy Considerations

`failurePolicy: Fail` provides strong enforcement but requires high webhook availability. Plan for this:

```yaml
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: webhook-server
  namespace: webhook-system
spec:
  # Minimum 2 replicas for availability
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
      maxSurge: 1
  template:
    spec:
      # Spread across failure domains
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: webhook-server
      # Protect from accidental eviction
      priorityClassName: system-cluster-critical
      containers:
        - name: webhook-server
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 500m
              memory: 512Mi
          readinessProbe:
            httpGet:
              path: /readyz
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
```

### Webhook Exclusion for Critical Namespaces

```yaml
# Exclude kube-system and the webhook's own namespace from validation
# to prevent deadlock during cluster bootstrap
namespaceSelector:
  matchExpressions:
    - key: kubernetes.io/metadata.name
      operator: NotIn
      values:
        - kube-system
        - kube-public
        - webhook-system
        - cert-manager
```

## Testing Webhooks

### Unit Testing Admission Logic

```go
// internal/webhook/validating/label_validator_test.go
package validating_test

import (
    "encoding/json"
    "testing"

    admissionv1 "k8s.io/api/admission/v1"
    appsv1 "k8s.io/api/apps/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func makeDeployRequest(labels map[string]string) *admissionv1.AdmissionRequest {
    deploy := appsv1.Deployment{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "test-app",
            Namespace: "production",
        },
        Spec: appsv1.DeploymentSpec{
            Template: corev1.PodTemplateSpec{
                ObjectMeta: metav1.ObjectMeta{
                    Labels: labels,
                },
            },
        },
    }
    raw, _ := json.Marshal(deploy)
    return &admissionv1.AdmissionRequest{
        UID:  "test-uid",
        Resource: metav1.GroupVersionResource{Resource: "deployments"},
        Object: runtime.RawExtension{Raw: raw},
    }
}

func TestLabelValidator_ValidLabels(t *testing.T) {
    req := makeDeployRequest(map[string]string{
        "app":     "orders-api",
        "version": "v1.2.0",
        "team":    "platform",
        "env":     "production",
    })
    resp, err := LabelValidator(req)
    if err != nil {
        t.Fatalf("unexpected error: %v", err)
    }
    if !resp.Allowed {
        t.Errorf("expected allowed, got: %s", resp.Result.Message)
    }
}

func TestLabelValidator_MissingLabels(t *testing.T) {
    req := makeDeployRequest(map[string]string{
        "app": "orders-api",
        // missing version, team, env
    })
    resp, err := LabelValidator(req)
    if err != nil {
        t.Fatalf("unexpected error: %v", err)
    }
    if resp.Allowed {
        t.Error("expected denied for missing labels")
    }
    // Verify all missing labels are mentioned
    for _, label := range []string{"version", "team", "env"} {
        if !strings.Contains(resp.Result.Message, label) {
            t.Errorf("expected message to mention missing label %q, got: %s", label, resp.Result.Message)
        }
    }
}

func TestLabelValidator_InvalidEnvValue(t *testing.T) {
    req := makeDeployRequest(map[string]string{
        "app":     "orders-api",
        "version": "v1.0.0",
        "team":    "platform",
        "env":     "prod", // invalid — should be "production"
    })
    resp, _ := LabelValidator(req)
    if resp.Allowed {
        t.Error("expected denied for invalid env value")
    }
}
```

### Integration Testing with envtest

```go
// integration_test.go
package webhook_test

import (
    "context"
    "path/filepath"
    "testing"

    . "github.com/onsi/gomega"
    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/envtest"
)

var (
    testEnv   *envtest.Environment
    k8sClient client.Client
)

func TestMain(m *testing.M) {
    testEnv = &envtest.Environment{
        CRDDirectoryPaths: []string{filepath.Join("..", "config", "crd")},
        WebhookInstallOptions: envtest.WebhookInstallOptions{
            Paths: []string{filepath.Join("..", "config", "webhook")},
        },
        BinaryAssetsDirectory: filepath.Join("..", "..", "bin", "k8s", "1.29"),
    }

    cfg, err := testEnv.Start()
    if err != nil {
        panic(err)
    }
    defer testEnv.Stop()

    // Start the webhook server
    go startWebhookServer(cfg, testEnv.WebhookInstallOptions)

    os.Exit(m.Run())
}

func TestValidatingWebhook_RejectsInvalidDeploy(t *testing.T) {
    g := NewWithT(t)

    deploy := &appsv1.Deployment{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "bad-deployment",
            Namespace: "default",
            Labels: map[string]string{
                "app": "test",
                // Missing required labels
            },
        },
        Spec: appsv1.DeploymentSpec{
            Selector: &metav1.LabelSelector{
                MatchLabels: map[string]string{"app": "test"},
            },
            Template: corev1.PodTemplateSpec{
                ObjectMeta: metav1.ObjectMeta{
                    Labels: map[string]string{"app": "test"},
                },
                Spec: corev1.PodSpec{
                    Containers: []corev1.Container{
                        {Name: "app", Image: "nginx:latest"},
                    },
                },
            },
        },
    }

    err := k8sClient.Create(context.Background(), deploy)
    g.Expect(err).To(HaveOccurred())
    g.Expect(err.Error()).To(ContainSubstring("missing required label"))
}
```

### End-to-End Testing Script

```bash
#!/bin/bash
# test-webhook.sh

set -euo pipefail

NAMESPACE="webhook-test-$(date +%s)"
kubectl create namespace "$NAMESPACE"
kubectl label namespace "$NAMESPACE" sidecar-injection=enabled

# Test 1: Valid deployment should be accepted
echo "Test 1: Valid deployment..."
kubectl apply -n "$NAMESPACE" -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: valid-app
  labels:
    app: valid-app
    version: v1.0.0
    team: platform
    env: production
spec:
  selector:
    matchLabels:
      app: valid-app
  template:
    metadata:
      labels:
        app: valid-app
        version: v1.0.0
        team: platform
        env: production
    spec:
      containers:
        - name: app
          image: nginx:1.25
EOF
echo "PASS: Valid deployment accepted"

# Test 2: Invalid deployment should be rejected
echo "Test 2: Invalid deployment (missing labels)..."
if kubectl apply -n "$NAMESPACE" -f - <<EOF 2>/dev/null; then
apiVersion: apps/v1
kind: Deployment
metadata:
  name: invalid-app
spec:
  selector:
    matchLabels:
      app: invalid-app
  template:
    metadata:
      labels:
        app: invalid-app
    spec:
      containers:
        - name: app
          image: nginx:1.25
EOF
  echo "FAIL: Invalid deployment was accepted (should have been rejected)"
  exit 1
else
  echo "PASS: Invalid deployment correctly rejected"
fi

# Test 3: Sidecar injection
echo "Test 3: Sidecar injection..."
kubectl apply -n "$NAMESPACE" -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: inject-test
  labels:
    app: inject-test
  annotations:
    sidecar.example.com/inject: "true"
spec:
  containers:
    - name: app
      image: nginx:1.25
EOF

# Check sidecar was injected
CONTAINER_COUNT=$(kubectl get pod inject-test -n "$NAMESPACE" \
  -o jsonpath='{.spec.containers}' | jq '. | length')
if [[ "$CONTAINER_COUNT" -eq 2 ]]; then
  echo "PASS: Sidecar successfully injected ($CONTAINER_COUNT containers)"
else
  echo "FAIL: Expected 2 containers, got $CONTAINER_COUNT"
  exit 1
fi

kubectl delete namespace "$NAMESPACE"
echo "All webhook tests PASSED"
```

## Dynamic Certificate Loading

```go
// internal/tls/certloader.go
package tls

import (
    "crypto/tls"
    "crypto/x509"
    "os"
    "path/filepath"
    "sync"
    "time"
)

type DynamicCertLoader struct {
    certDir string
    cert    *tls.Certificate
    mu      sync.RWMutex
    done    chan struct{}
}

func NewDynamicCertLoader(certDir string) (*DynamicCertLoader, error) {
    l := &DynamicCertLoader{
        certDir: certDir,
        done:    make(chan struct{}),
    }

    if err := l.reload(); err != nil {
        return nil, err
    }

    go l.watchAndReload()
    return l, nil
}

func (l *DynamicCertLoader) GetCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error) {
    l.mu.RLock()
    defer l.mu.RUnlock()
    return l.cert, nil
}

func (l *DynamicCertLoader) reload() error {
    certFile := filepath.Join(l.certDir, "tls.crt")
    keyFile := filepath.Join(l.certDir, "tls.key")

    cert, err := tls.LoadX509KeyPair(certFile, keyFile)
    if err != nil {
        return err
    }

    l.mu.Lock()
    l.cert = &cert
    l.mu.Unlock()

    slog.Info("TLS certificate loaded",
        "cert_file", certFile,
        "not_after", cert.Leaf.NotAfter,
    )
    return nil
}

func (l *DynamicCertLoader) watchAndReload() {
    ticker := time.NewTicker(10 * time.Second)
    defer ticker.Stop()
    for {
        select {
        case <-ticker.C:
            if err := l.reload(); err != nil {
                slog.Error("failed to reload TLS cert", "err", err)
            }
        case <-l.done:
            return
        }
    }
}
```

## Summary

Kubernetes admission webhooks provide powerful hooks into the API server's resource lifecycle. Production deployment requires:

- Implement separate validating and mutating webhooks — never perform side effects in a validating webhook
- Use `sideEffects: None` for webhooks without side effects to allow safe use in dry-run mode
- Set appropriate `timeoutSeconds` — the default is 10 seconds, but the API server will fail the webhook if it doesn't respond
- Use cert-manager's CA injection annotation to automatically populate the `caBundle` field rather than managing it manually
- Exclude system namespaces (kube-system, cert-manager, webhook-system itself) from webhooks with `failurePolicy: Fail` to prevent bootstrap deadlocks
- Test admission logic as pure Go functions with unit tests, then use envtest for integration tests before deploying to a live cluster
- Run minimum 3 replicas with anti-affinity for webhooks with `failurePolicy: Fail` — a single-replica webhook is a single point of failure for all resource creation
