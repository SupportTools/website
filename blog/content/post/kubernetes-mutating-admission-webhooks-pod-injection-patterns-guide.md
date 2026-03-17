---
title: "Kubernetes Mutating Admission Webhooks: Pod Injection Patterns"
date: 2029-07-13T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Admission Webhooks", "Security", "Sidecar Injection", "Go", "Policy", "Service Mesh"]
categories: ["Kubernetes", "DevOps", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Kubernetes mutating admission webhooks: sidecar injection, init container injection, environment variable injection, annotation-driven configuration, and ordering with multiple webhooks in production."
more_link: "yes"
url: "/kubernetes-mutating-admission-webhooks-pod-injection-patterns-guide/"
---

Mutating admission webhooks intercept Kubernetes API requests before objects are persisted, allowing you to modify them. This is how Istio injects the Envoy sidecar, how Vault injects secret volumes, and how policy engines enforce defaults. Building your own webhook gives you the same power—the ability to transparently add behavior to every Pod created in your cluster. This guide covers the full implementation, from webhook server to production hardening.

<!--more-->

# Kubernetes Mutating Admission Webhooks: Pod Injection Patterns

## Admission Webhook Architecture

When a Pod creation request arrives at the API server, it passes through an admission chain:

```
kubectl apply -f pod.yaml
     |
     v
Authentication & Authorization
     |
     v
Mutating Admission (webhooks run here, can modify the object)
     |
     v  (object has been mutated)
Object Schema Validation
     |
     v
Validating Admission (webhooks run here, can only allow/deny)
     |
     v
Persisted to etcd
```

Multiple mutating webhooks run in a defined order. Each receives the (potentially already mutated) object from previous webhooks.

### MutatingWebhookConfiguration

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: pod-injector
webhooks:
- name: inject.example.com
  # Restrict to specific namespaces
  namespaceSelector:
    matchLabels:
      injection: enabled
  # Restrict to Pods
  rules:
  - apiGroups: [""]
    apiVersions: ["v1"]
    resources: ["pods"]
    operations: ["CREATE"]
    scope: "Namespaced"
  # Webhook endpoint
  clientConfig:
    service:
      name: pod-injector
      namespace: injection-system
      path: /mutate-pods
      port: 443
    caBundle: <base64-encoded-CA-cert>
  # What to do if the webhook fails
  failurePolicy: Fail    # or Ignore
  # Prevent infinite loops (injector doesn't inject itself)
  reinvocationPolicy: IfNeeded
  # Don't timeout the API server
  timeoutSeconds: 5
  # Only send to the webhook if admissionReview version matches
  admissionReviewVersions: ["v1", "v1beta1"]
  # Match objects that don't already have our label
  objectSelector:
    matchExpressions:
    - key: injected.example.com/version
      operator: DoesNotExist
  sideEffects: None
```

## Building a Webhook Server in Go

### Project Structure

```
webhook/
├── main.go
├── handler/
│   ├── webhook.go      # HTTP handler
│   ├── sidecar.go      # Sidecar injection logic
│   ├── initcontainer.go # Init container injection
│   └── envvar.go       # Environment variable injection
├── config/
│   └── config.go       # Configuration loading
└── certs/
    └── tls.go          # TLS certificate management
```

### Core Webhook Handler

```go
package handler

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
    scheme = runtime.NewScheme()
    codecs = serializer.NewCodecFactory(scheme)
)

func init() {
    _ = admissionv1.AddToScheme(scheme)
    _ = corev1.AddToScheme(scheme)
}

// JSONPatch represents a single RFC 6902 JSON Patch operation
type JSONPatch struct {
    Op    string      `json:"op"`
    Path  string      `json:"path"`
    Value interface{} `json:"value,omitempty"`
}

type WebhookHandler struct {
    logger    *zap.Logger
    injectors []PodInjector
}

// PodInjector is the interface all injection strategies implement
type PodInjector interface {
    Name() string
    ShouldInject(pod *corev1.Pod) bool
    Inject(pod *corev1.Pod) ([]JSONPatch, error)
}

func NewWebhookHandler(logger *zap.Logger, injectors ...PodInjector) *WebhookHandler {
    return &WebhookHandler{
        logger:    logger,
        injectors: injectors,
    }
}

func (h *WebhookHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    // Parse the admission request
    body, err := io.ReadAll(r.Body)
    if err != nil {
        h.logger.Error("failed to read request body", zap.Error(err))
        http.Error(w, "failed to read body", http.StatusBadRequest)
        return
    }

    contentType := r.Header.Get("Content-Type")
    if contentType != "application/json" {
        h.logger.Error("invalid content type", zap.String("content_type", contentType))
        http.Error(w, "invalid content type, expected application/json", http.StatusUnsupportedMediaType)
        return
    }

    // Decode the AdmissionReview
    obj, gvk, err := codecs.UniversalDeserializer().Decode(body, nil, nil)
    if err != nil {
        h.logger.Error("failed to decode admission review", zap.Error(err))
        http.Error(w, fmt.Sprintf("failed to decode: %v", err), http.StatusBadRequest)
        return
    }

    review, ok := obj.(*admissionv1.AdmissionReview)
    if !ok {
        h.logger.Error("unexpected type", zap.String("type", gvk.String()))
        http.Error(w, "unexpected type", http.StatusBadRequest)
        return
    }

    // Process the request
    response := h.mutate(review.Request)
    review.Response = response
    review.Response.UID = review.Request.UID

    // Send the response
    respBytes, err := json.Marshal(review)
    if err != nil {
        h.logger.Error("failed to marshal response", zap.Error(err))
        http.Error(w, "failed to marshal response", http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusOK)
    w.Write(respBytes)
}

func (h *WebhookHandler) mutate(req *admissionv1.AdmissionRequest) *admissionv1.AdmissionResponse {
    // Decode the Pod
    var pod corev1.Pod
    if err := json.Unmarshal(req.Object.Raw, &pod); err != nil {
        h.logger.Error("failed to decode pod", zap.Error(err))
        return &admissionv1.AdmissionResponse{
            Result: &metav1.Status{
                Message: fmt.Sprintf("failed to decode pod: %v", err),
            },
        }
    }

    h.logger.Info("processing pod admission",
        zap.String("name", pod.Name),
        zap.String("namespace", req.Namespace),
        zap.String("generateName", pod.GenerateName),
    )

    // Collect patches from all injectors
    var allPatches []JSONPatch

    for _, injector := range h.injectors {
        if !injector.ShouldInject(&pod) {
            h.logger.Debug("skipping injector",
                zap.String("injector", injector.Name()),
                zap.String("pod", pod.Name),
            )
            continue
        }

        patches, err := injector.Inject(&pod)
        if err != nil {
            h.logger.Error("injection failed",
                zap.String("injector", injector.Name()),
                zap.Error(err),
            )
            return &admissionv1.AdmissionResponse{
                Result: &metav1.Status{
                    Message: fmt.Sprintf("injection failed (%s): %v", injector.Name(), err),
                },
            }
        }

        h.logger.Info("injection applied",
            zap.String("injector", injector.Name()),
            zap.Int("patches", len(patches)),
        )
        allPatches = append(allPatches, patches...)
    }

    // Build the response
    response := &admissionv1.AdmissionResponse{
        Allowed: true,
    }

    if len(allPatches) > 0 {
        patchBytes, err := json.Marshal(allPatches)
        if err != nil {
            return &admissionv1.AdmissionResponse{
                Result: &metav1.Status{
                    Message: fmt.Sprintf("failed to marshal patches: %v", err),
                },
            }
        }
        patchType := admissionv1.PatchTypeJSONPatch
        response.Patch = patchBytes
        response.PatchType = &patchType
    }

    return response
}
```

## Sidecar Injection Pattern

```go
package handler

import (
    "encoding/json"
    "fmt"

    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/resource"
)

const (
    sidecarInjectedAnnotation = "sidecar-injector.example.com/injected"
    sidecarInjectAnnotation   = "sidecar-injector.example.com/inject"
)

// SidecarConfig defines the sidecar to inject
type SidecarConfig struct {
    Containers     []corev1.Container
    Volumes        []corev1.Volume
    InitContainers []corev1.Container
}

type SidecarInjector struct {
    config *SidecarConfig
}

func NewSidecarInjector(configJSON string) (*SidecarInjector, error) {
    var config SidecarConfig
    if err := json.Unmarshal([]byte(configJSON), &config); err != nil {
        return nil, fmt.Errorf("invalid sidecar config: %w", err)
    }
    return &SidecarInjector{config: &config}, nil
}

func (s *SidecarInjector) Name() string { return "sidecar-injector" }

func (s *SidecarInjector) ShouldInject(pod *corev1.Pod) bool {
    // Don't inject if already injected
    if _, ok := pod.Annotations[sidecarInjectedAnnotation]; ok {
        return false
    }
    // Only inject if annotation is set to "true"
    val, ok := pod.Annotations[sidecarInjectAnnotation]
    return ok && val == "true"
}

func (s *SidecarInjector) Inject(pod *corev1.Pod) ([]JSONPatch, error) {
    var patches []JSONPatch

    // Initialize containers array if nil
    if pod.Spec.Containers == nil {
        patches = append(patches, JSONPatch{
            Op:    "add",
            Path:  "/spec/containers",
            Value: []corev1.Container{},
        })
    }

    // Inject sidecar containers
    for _, container := range s.config.Containers {
        patches = append(patches, JSONPatch{
            Op:    "add",
            Path:  "/spec/containers/-",
            Value: container,
        })
    }

    // Inject volumes
    if len(s.config.Volumes) > 0 {
        if pod.Spec.Volumes == nil {
            patches = append(patches, JSONPatch{
                Op:    "add",
                Path:  "/spec/volumes",
                Value: []corev1.Volume{},
            })
        }
        for _, vol := range s.config.Volumes {
            patches = append(patches, JSONPatch{
                Op:    "add",
                Path:  "/spec/volumes/-",
                Value: vol,
            })
        }
    }

    // Mark as injected (prevents re-injection)
    if pod.Annotations == nil {
        patches = append(patches, JSONPatch{
            Op:    "add",
            Path:  "/metadata/annotations",
            Value: map[string]string{},
        })
    }
    patches = append(patches, JSONPatch{
        Op:    "add",
        Path:  "/metadata/annotations/" + escapeJSONPointer(sidecarInjectedAnnotation),
        Value: "true",
    })

    return patches, nil
}

// escapeJSONPointer escapes special characters in JSON Pointer (RFC 6901)
func escapeJSONPointer(s string) string {
    // Replace ~ with ~0, / with ~1
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

// Example sidecar configuration (loaded from ConfigMap)
func exampleSidecarConfig() string {
    return `{
  "containers": [
    {
      "name": "proxy",
      "image": "envoyproxy/envoy:v1.28",
      "args": ["-c", "/etc/envoy/config.yaml"],
      "ports": [{"containerPort": 15001}, {"containerPort": 15090}],
      "resources": {
        "requests": {"cpu": "100m", "memory": "128Mi"},
        "limits": {"cpu": "2", "memory": "1Gi"}
      },
      "volumeMounts": [
        {"name": "envoy-config", "mountPath": "/etc/envoy"}
      ],
      "readinessProbe": {
        "httpGet": {"path": "/ready", "port": 15000},
        "initialDelaySeconds": 5,
        "periodSeconds": 5
      }
    }
  ],
  "volumes": [
    {
      "name": "envoy-config",
      "configMap": {"name": "envoy-config"}
    }
  ]
}`
}
```

## Init Container Injection Pattern

```go
package handler

import (
    "fmt"
    "strings"

    corev1 "k8s.io/api/core/v1"
)

const (
    initContainerAnnotation = "init-injector.example.com/inject-db-migration"
)

// DBMigrationInitInjector injects a database migration init container
type DBMigrationInitInjector struct {
    migrationImage string
}

func NewDBMigrationInitInjector(image string) *DBMigrationInitInjector {
    return &DBMigrationInitInjector{migrationImage: image}
}

func (d *DBMigrationInitInjector) Name() string { return "db-migration-init-injector" }

func (d *DBMigrationInitInjector) ShouldInject(pod *corev1.Pod) bool {
    val, ok := pod.Annotations[initContainerAnnotation]
    return ok && strings.ToLower(val) == "true"
}

func (d *DBMigrationInitInjector) Inject(pod *corev1.Pod) ([]JSONPatch, error) {
    var patches []JSONPatch

    // Build the init container
    initContainer := corev1.Container{
        Name:  "db-migration",
        Image: d.migrationImage,
        Command: []string{
            "/bin/sh", "-c",
            "echo 'Running database migrations...' && /migrations/run.sh",
        },
        Env: []corev1.EnvVar{
            {
                Name: "DATABASE_URL",
                ValueFrom: &corev1.EnvVarSource{
                    SecretKeyRef: &corev1.SecretKeySelector{
                        LocalObjectReference: corev1.LocalObjectReference{
                            Name: "database-credentials",
                        },
                        Key: "url",
                    },
                },
            },
        },
        Resources: corev1.ResourceRequirements{
            Requests: corev1.ResourceList{
                corev1.ResourceCPU:    resource.MustParse("100m"),
                corev1.ResourceMemory: resource.MustParse("64Mi"),
            },
            Limits: corev1.ResourceList{
                corev1.ResourceCPU:    resource.MustParse("500m"),
                corev1.ResourceMemory: resource.MustParse("256Mi"),
            },
        },
    }

    // Init containers must be injected BEFORE existing init containers
    // (or at a specific position based on requirements)
    if len(pod.Spec.InitContainers) == 0 {
        // No init containers yet
        patches = append(patches, JSONPatch{
            Op:    "add",
            Path:  "/spec/initContainers",
            Value: []corev1.Container{initContainer},
        })
    } else {
        // Prepend to existing init containers
        patches = append(patches, JSONPatch{
            Op:    "add",
            Path:  "/spec/initContainers/0",
            Value: initContainer,
        })
    }

    return patches, nil
}
```

## Environment Variable Injection Pattern

```go
package handler

import (
    "fmt"
    "os"
    "strings"

    corev1 "k8s.io/api/core/v1"
)

const (
    envInjectAnnotation        = "env-injector.example.com/inject"
    envInjectFromAnnotation    = "env-injector.example.com/inject-from-secret"
    clusterNameAnnotation      = "env-injector.example.com/cluster-name"
)

// EnvVarInjector injects standard environment variables into all containers
type EnvVarInjector struct {
    clusterName string
    region      string
    environment string
}

func NewEnvVarInjector(clusterName, region, env string) *EnvVarInjector {
    return &EnvVarInjector{
        clusterName: clusterName,
        region:      region,
        environment: env,
    }
}

func (e *EnvVarInjector) Name() string { return "envvar-injector" }

func (e *EnvVarInjector) ShouldInject(pod *corev1.Pod) bool {
    // Always inject cluster metadata
    return true
}

func (e *EnvVarInjector) Inject(pod *corev1.Pod) ([]JSONPatch, error) {
    var patches []JSONPatch

    // Standard env vars to inject into every container
    standardEnvVars := []corev1.EnvVar{
        {
            Name:  "CLUSTER_NAME",
            Value: e.clusterName,
        },
        {
            Name:  "CLOUD_REGION",
            Value: e.region,
        },
        {
            Name:  "ENVIRONMENT",
            Value: e.environment,
        },
        {
            // Downward API: pod name
            Name: "POD_NAME",
            ValueFrom: &corev1.EnvVarSource{
                FieldRef: &corev1.ObjectFieldSelector{
                    FieldPath: "metadata.name",
                },
            },
        },
        {
            // Downward API: pod namespace
            Name: "POD_NAMESPACE",
            ValueFrom: &corev1.EnvVarSource{
                FieldRef: &corev1.ObjectFieldSelector{
                    FieldPath: "metadata.namespace",
                },
            },
        },
        {
            // Downward API: pod IP
            Name: "POD_IP",
            ValueFrom: &corev1.EnvVarSource{
                FieldRef: &corev1.ObjectFieldSelector{
                    FieldPath: "status.podIP",
                },
            },
        },
        {
            // Downward API: node name
            Name: "NODE_NAME",
            ValueFrom: &corev1.EnvVarSource{
                FieldRef: &corev1.ObjectFieldSelector{
                    FieldPath: "spec.nodeName",
                },
            },
        },
    }

    // Inject into each container
    for i, container := range pod.Spec.Containers {
        for _, envVar := range standardEnvVars {
            // Don't inject if already set (allow overrides)
            alreadySet := false
            for _, existing := range container.Env {
                if existing.Name == envVar.Name {
                    alreadySet = true
                    break
                }
            }
            if alreadySet {
                continue
            }

            // Construct the JSON patch path
            path := fmt.Sprintf("/spec/containers/%d/env", i)
            if container.Env == nil {
                patches = append(patches, JSONPatch{
                    Op:    "add",
                    Path:  path,
                    Value: []corev1.EnvVar{envVar},
                })
                // Mark as initialized to avoid duplicate "add" operations
                pod.Spec.Containers[i].Env = []corev1.EnvVar{{}}
            } else {
                patches = append(patches, JSONPatch{
                    Op:    "add",
                    Path:  path + "/-",
                    Value: envVar,
                })
            }
        }
    }

    // Annotation-driven secret injection
    if secretName, ok := pod.Annotations[envInjectFromAnnotation]; ok {
        for i := range pod.Spec.Containers {
            patches = append(patches, JSONPatch{
                Op:   "add",
                Path: fmt.Sprintf("/spec/containers/%d/envFrom", i),
                Value: []corev1.EnvFromSource{
                    {
                        SecretRef: &corev1.SecretEnvSource{
                            LocalObjectReference: corev1.LocalObjectReference{
                                Name: secretName,
                            },
                        },
                    },
                },
            })
        }
    }

    return patches, nil
}
```

## Annotation-Driven Configuration

Annotations allow per-Pod customization of injection behavior:

```go
package handler

import (
    "encoding/json"
    "fmt"
    "strconv"
    "strings"

    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/resource"
)

const (
    proxyImageAnnotation         = "proxy-injector.example.com/image"
    proxyResourceCPUAnnotation   = "proxy-injector.example.com/cpu"
    proxyResourceMemAnnotation   = "proxy-injector.example.com/memory"
    proxyConfigAnnotation        = "proxy-injector.example.com/config"
    proxyExcludePortsAnnotation  = "proxy-injector.example.com/exclude-outbound-ports"
    proxyIncludePortsAnnotation  = "proxy-injector.example.com/include-inbound-ports"
)

// AnnotationDrivenProxyInjector reads configuration from pod annotations
type AnnotationDrivenProxyInjector struct {
    defaultImage  string
    defaultCPU    string
    defaultMemory string
}

func (a *AnnotationDrivenProxyInjector) Name() string { return "annotation-driven-proxy-injector" }

func (a *AnnotationDrivenProxyInjector) ShouldInject(pod *corev1.Pod) bool {
    val, ok := pod.Annotations["proxy-injector.example.com/inject"]
    return ok && val == "true"
}

func (a *AnnotationDrivenProxyInjector) Inject(pod *corev1.Pod) ([]JSONPatch, error) {
    // Read configuration from annotations with defaults
    image := a.getAnnotation(pod, proxyImageAnnotation, a.defaultImage)
    cpu := a.getAnnotation(pod, proxyResourceCPUAnnotation, a.defaultCPU)
    mem := a.getAnnotation(pod, proxyResourceMemAnnotation, a.defaultMemory)

    // Parse excluded ports
    excludePorts := []string{}
    if portStr, ok := pod.Annotations[proxyExcludePortsAnnotation]; ok {
        excludePorts = strings.Split(portStr, ",")
    }

    // Parse custom proxy configuration
    proxyConfig := map[string]interface{}{
        "excludedOutboundPorts": excludePorts,
    }
    if configJSON, ok := pod.Annotations[proxyConfigAnnotation]; ok {
        if err := json.Unmarshal([]byte(configJSON), &proxyConfig); err != nil {
            return nil, fmt.Errorf("invalid proxy config annotation: %w", err)
        }
    }

    // Build the proxy container based on annotation configuration
    proxyContainer := corev1.Container{
        Name:  "proxy",
        Image: image,
        Env: []corev1.EnvVar{
            {
                Name:  "PROXY_CONFIG",
                Value: func() string { b, _ := json.Marshal(proxyConfig); return string(b) }(),
            },
        },
        Resources: corev1.ResourceRequirements{
            Requests: corev1.ResourceList{
                corev1.ResourceCPU:    resource.MustParse(cpu),
                corev1.ResourceMemory: resource.MustParse(mem),
            },
            Limits: corev1.ResourceList{
                corev1.ResourceCPU:    resource.MustParse(cpu),
                corev1.ResourceMemory: resource.MustParse(mem),
            },
        },
        SecurityContext: &corev1.SecurityContext{
            RunAsUser:    ptr(int64(1337)),
            RunAsNonRoot: ptr(true),
            Capabilities: &corev1.Capabilities{
                Drop: []corev1.Capability{"ALL"},
                Add:  []corev1.Capability{"NET_BIND_SERVICE"},
            },
        },
    }

    var patches []JSONPatch
    patches = append(patches, JSONPatch{
        Op:    "add",
        Path:  "/spec/containers/-",
        Value: proxyContainer,
    })

    return patches, nil
}

func (a *AnnotationDrivenProxyInjector) getAnnotation(pod *corev1.Pod, key, defaultVal string) string {
    if val, ok := pod.Annotations[key]; ok {
        return val
    }
    return defaultVal
}

func ptr[T any](v T) *T { return &v }
```

## Ordering with Multiple Webhooks

When multiple webhooks run on the same resource, ordering matters. Kubernetes applies webhooks in alphabetical order by webhook name within a `MutatingWebhookConfiguration`, and by name of the `MutatingWebhookConfiguration` across configurations.

### Reinvocation Policy

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: 01-pod-security-defaults
webhooks:
- name: defaults.security.example.com
  reinvocationPolicy: IfNeeded
  # IfNeeded: webhook is called again if another webhook modifies the object
  # Never: only called once (default)
  rules:
  - operations: ["CREATE"]
    resources: ["pods"]
    apiGroups: [""]
    apiVersions: ["v1"]
  # ...

---
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: 02-sidecar-injector  # Runs after 01- due to alphabetical ordering
webhooks:
- name: inject.sidecar.example.com
  reinvocationPolicy: IfNeeded
  rules:
  - operations: ["CREATE"]
    resources: ["pods"]
```

### Handling Ordered Injection

```go
// Some injections must happen in a specific order.
// Use a single webhook with multiple injectors in sequence.

func setupWebhookServer() *http.ServeMux {
    logger, _ := zap.NewProduction()

    // Order matters: security context first, then sidecars, then env vars
    injectors := []PodInjector{
        NewSecurityContextInjector(),       // 1. Set security defaults first
        NewDBMigrationInitInjector("myapp/migrations:latest"), // 2. Init containers before sidecars
        NewSidecarInjector(exampleSidecarConfig()), // 3. Sidecars
        NewEnvVarInjector("prod-cluster", "us-east-1", "production"), // 4. Env vars last (may reference sidecar ports)
    }

    handler := NewWebhookHandler(logger, injectors...)

    mux := http.NewServeMux()
    mux.Handle("/mutate-pods", handler)
    mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
        w.Write([]byte("ok"))
    })
    return mux
}
```

## TLS Certificate Management

The webhook server requires TLS. In production, use cert-manager:

```yaml
# cert-manager Certificate for the webhook server
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: pod-injector-cert
  namespace: injection-system
spec:
  secretName: pod-injector-tls
  duration: 8760h  # 1 year
  renewBefore: 720h  # Renew 30 days before expiry
  dnsNames:
  - pod-injector.injection-system.svc
  - pod-injector.injection-system.svc.cluster.local
  issuerRef:
    name: cluster-issuer
    kind: ClusterIssuer

---
# Patch the webhook to inject the CA bundle automatically
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: pod-injector
  annotations:
    # cert-manager will inject the caBundle automatically
    cert-manager.io/inject-ca-from: injection-system/pod-injector-cert
webhooks:
- name: inject.example.com
  clientConfig:
    service:
      name: pod-injector
      namespace: injection-system
      path: /mutate-pods
    # caBundle will be populated by cert-manager
```

```go
// main.go: loading TLS cert from Kubernetes secret
package main

import (
    "context"
    "crypto/tls"
    "fmt"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "go.uber.org/zap"
)

func main() {
    logger, _ := zap.NewProduction()
    defer logger.Sync()

    certFile := "/etc/webhook/tls/tls.crt"
    keyFile := "/etc/webhook/tls/tls.key"

    // TLS configuration with certificate reloading
    tlsConfig := &tls.Config{
        GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
            // Reload certificate on each connection
            // This enables zero-downtime cert rotation
            cert, err := tls.LoadX509KeyPair(certFile, keyFile)
            if err != nil {
                return nil, fmt.Errorf("loading TLS cert: %w", err)
            }
            return &cert, nil
        },
        MinVersion: tls.VersionTLS13,
    }

    mux := setupWebhookServer()

    server := &http.Server{
        Addr:              ":8443",
        Handler:           mux,
        TLSConfig:         tlsConfig,
        ReadTimeout:       10 * time.Second,
        WriteTimeout:      10 * time.Second,
        IdleTimeout:       60 * time.Second,
        ReadHeaderTimeout: 5 * time.Second,
    }

    // Graceful shutdown
    ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
    defer stop()

    go func() {
        logger.Info("starting webhook server", zap.String("addr", server.Addr))
        if err := server.ListenAndServeTLS("", ""); err != nil && err != http.ErrServerClosed {
            logger.Fatal("server failed", zap.Error(err))
        }
    }()

    <-ctx.Done()
    logger.Info("shutting down webhook server")

    shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()
    server.Shutdown(shutdownCtx)
}
```

## Deploying the Webhook

```yaml
# Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pod-injector
  namespace: injection-system
spec:
  replicas: 2  # High availability
  selector:
    matchLabels:
      app: pod-injector
  template:
    metadata:
      labels:
        app: pod-injector
        # Prevent the injector from injecting itself
        injected.example.com/version: "skip"
    spec:
      serviceAccountName: pod-injector
      # Spread across nodes for HA
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: kubernetes.io/hostname
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: pod-injector
      containers:
      - name: pod-injector
        image: myregistry/pod-injector:v1.2.0
        ports:
        - containerPort: 8443
          name: webhook
        - containerPort: 8080
          name: health
        env:
        - name: CLUSTER_NAME
          value: "prod-cluster"
        - name: REGION
          value: "us-east-1"
        - name: ENVIRONMENT
          value: "production"
        volumeMounts:
        - name: tls-certs
          mountPath: /etc/webhook/tls
          readOnly: true
        - name: sidecar-config
          mountPath: /etc/webhook/config
          readOnly: true
        readinessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 15
          periodSeconds: 20
        resources:
          requests:
            cpu: "100m"
            memory: "128Mi"
          limits:
            cpu: "500m"
            memory: "256Mi"
        securityContext:
          runAsNonRoot: true
          runAsUser: 1000
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities:
            drop: ["ALL"]
      volumes:
      - name: tls-certs
        secret:
          secretName: pod-injector-tls
      - name: sidecar-config
        configMap:
          name: sidecar-config

---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: pod-injector-pdb
  namespace: injection-system
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: pod-injector
```

## Testing the Webhook

```bash
#!/bin/bash
# Integration test for the webhook

# Create a test namespace with injection enabled
kubectl create namespace test-injection
kubectl label namespace test-injection injection=enabled

# Test 1: Sidecar injection
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: test-sidecar
  namespace: test-injection
  annotations:
    sidecar-injector.example.com/inject: "true"
spec:
  containers:
  - name: app
    image: nginx:alpine
EOF

kubectl wait pod/test-sidecar -n test-injection --for=condition=Ready --timeout=60s
CONTAINER_COUNT=$(kubectl get pod test-sidecar -n test-injection \
  -o jsonpath='{.spec.containers}' | jq length)
echo "Container count: ${CONTAINER_COUNT} (expected: 2)"

# Test 2: Env var injection
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: test-envvars
  namespace: test-injection
spec:
  containers:
  - name: app
    image: busybox
    command: ["env"]
EOF

kubectl wait pod/test-envvars -n test-injection --for=condition=Ready --timeout=60s
kubectl logs test-envvars -n test-injection | grep -E "CLUSTER_NAME|POD_NAME|POD_NAMESPACE"

# Cleanup
kubectl delete namespace test-injection
```

## Summary

Mutating admission webhooks are one of the most powerful extensibility mechanisms in Kubernetes:

1. **Architecture** — webhooks intercept API requests before persistence, enabling transparent mutation with JSON Patch operations
2. **Sidecar injection** — the `PodInjector` interface pattern enables composable, testable injection logic
3. **Init container injection** — prepend init containers for cross-cutting concerns like database migrations
4. **Env var injection** — Downward API enables injecting pod identity without application awareness
5. **Annotation-driven config** — per-pod customization without changing the webhook server
6. **Ordering** — use `reinvocationPolicy: IfNeeded` and alphabetical naming to control webhook execution order
7. **TLS** — dynamic certificate reloading enables zero-downtime cert rotation
8. **Production hardening** — `failurePolicy: Fail` for critical webhooks, `PodDisruptionBudgets` for HA, self-exclusion labels to prevent infinite loops
