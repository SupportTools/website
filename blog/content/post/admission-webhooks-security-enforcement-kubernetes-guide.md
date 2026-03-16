---
title: "Kubernetes Admission Webhooks for Security Enforcement: Building Dynamic Policy Controllers for Enterprise Clusters"
date: 2026-03-18T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Admission Webhooks", "Security", "Policy Enforcement", "Validating Webhooks", "Mutating Webhooks"]
categories: ["Kubernetes", "Security", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing Kubernetes admission webhooks for security enforcement, including validating and mutating webhooks, custom policy controllers, and production-ready implementations."
more_link: "yes"
url: "/admission-webhooks-security-enforcement-kubernetes-guide/"
---

Kubernetes admission webhooks provide a powerful mechanism for enforcing custom security policies and transforming resources before they're persisted to etcd. This comprehensive guide explores building production-grade admission controllers using both validating and mutating webhooks, covering architecture patterns, implementation strategies, and real-world security enforcement scenarios.

Understanding admission webhooks is essential for organizations requiring fine-grained control over cluster resources beyond what native RBAC and Pod Security Standards provide. This guide provides complete implementations, testing strategies, and operational patterns for enterprise environments.

<!--more-->

# Admission Webhooks for Security Enforcement

## Admission Control Architecture

### Admission Control Flow

The Kubernetes API server processes requests through multiple admission stages:

1. **Authentication**: Verify request identity
2. **Authorization**: Check RBAC permissions
3. **Mutating Admission**: Modify resources (first webhook phase)
4. **Object Schema Validation**: Validate against OpenAPI schema
5. **Validating Admission**: Validate resources (second webhook phase)
6. **Persistence**: Store in etcd

### Webhook Types

**Mutating Admission Webhooks**
- Modify resource specifications before persistence
- Add default values, inject sidecars, set labels
- Execute before validating webhooks
- Can transform requests in-flight

**Validating Admission Webhooks**
- Validate resource specifications
- Enforce security policies and constraints
- Execute after mutating webhooks
- Cannot modify requests (only approve/reject)

## Building a Validating Webhook

### Webhook Server Implementation

Complete Go implementation for a security-focused validating webhook:

```go
// main.go
package main

import (
    "context"
    "crypto/tls"
    "encoding/json"
    "fmt"
    "io/ioutil"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    admissionv1 "k8s.io/api/admission/v1"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/apimachinery/pkg/runtime/serializer"
    "k8s.io/klog/v2"
)

var (
    scheme = runtime.NewScheme()
    codecs = serializer.NewCodecFactory(scheme)
)

type SecurityValidator struct {
    decoder runtime.Decoder
}

func init() {
    _ = corev1.AddToScheme(scheme)
    _ = admissionv1.AddToScheme(scheme)
}

// Validate implements security validation logic
func (v *SecurityValidator) Validate(ar *admissionv1.AdmissionReview) *admissionv1.AdmissionResponse {
    req := ar.Request

    klog.Infof("Validating %s %s/%s", req.Kind.Kind, req.Namespace, req.Name)

    // Decode the object
    var pod corev1.Pod
    if err := json.Unmarshal(req.Object.Raw, &pod); err != nil {
        klog.Errorf("Failed to decode object: %v", err)
        return &admissionv1.AdmissionResponse{
            Allowed: false,
            Result: &metav1.Status{
                Message: fmt.Sprintf("Failed to decode object: %v", err),
            },
        }
    }

    // Perform security validations
    if violations := v.validatePodSecurity(&pod); len(violations) > 0 {
        return &admissionv1.AdmissionResponse{
            Allowed: false,
            Result: &metav1.Status{
                Status:  "Failure",
                Message: fmt.Sprintf("Security policy violations: %v", violations),
                Reason:  metav1.StatusReasonForbidden,
                Code:    http.StatusForbidden,
            },
        }
    }

    // Validate image policies
    if violations := v.validateImagePolicy(&pod); len(violations) > 0 {
        return &admissionv1.AdmissionResponse{
            Allowed: false,
            Result: &metav1.Status{
                Status:  "Failure",
                Message: fmt.Sprintf("Image policy violations: %v", violations),
                Reason:  metav1.StatusReasonForbidden,
                Code:    http.StatusForbidden,
            },
        }
    }

    // Validate resource requirements
    if violations := v.validateResourceRequirements(&pod); len(violations) > 0 {
        return &admissionv1.AdmissionResponse{
            Allowed: false,
            Result: &metav1.Status{
                Status:  "Failure",
                Message: fmt.Sprintf("Resource policy violations: %v", violations),
                Reason:  metav1.StatusReasonForbidden,
                Code:    http.StatusForbidden,
            },
        }
    }

    klog.Infof("Validation passed for %s/%s", req.Namespace, req.Name)
    return &admissionv1.AdmissionResponse{
        Allowed: true,
    }
}

func (v *SecurityValidator) validatePodSecurity(pod *corev1.Pod) []string {
    var violations []string

    // Check privileged containers
    for _, container := range pod.Spec.Containers {
        if container.SecurityContext != nil &&
           container.SecurityContext.Privileged != nil &&
           *container.SecurityContext.Privileged {
            violations = append(violations,
                fmt.Sprintf("Container %s runs as privileged", container.Name))
        }

        // Check for host namespace usage
        if pod.Spec.HostNetwork {
            violations = append(violations, "Pod uses hostNetwork")
        }
        if pod.Spec.HostPID {
            violations = append(violations, "Pod uses hostPID")
        }
        if pod.Spec.HostIPC {
            violations = append(violations, "Pod uses hostIPC")
        }

        // Check for privilege escalation
        if container.SecurityContext != nil &&
           container.SecurityContext.AllowPrivilegeEscalation != nil &&
           *container.SecurityContext.AllowPrivilegeEscalation {
            violations = append(violations,
                fmt.Sprintf("Container %s allows privilege escalation", container.Name))
        }

        // Check for running as root
        if container.SecurityContext == nil ||
           container.SecurityContext.RunAsNonRoot == nil ||
           !*container.SecurityContext.RunAsNonRoot {
            violations = append(violations,
                fmt.Sprintf("Container %s does not explicitly run as non-root", container.Name))
        }

        // Check for dangerous capabilities
        if container.SecurityContext != nil &&
           container.SecurityContext.Capabilities != nil {
            for _, cap := range container.SecurityContext.Capabilities.Add {
                if isDangerousCapability(string(cap)) {
                    violations = append(violations,
                        fmt.Sprintf("Container %s adds dangerous capability: %s",
                            container.Name, cap))
                }
            }
        }
    }

    // Check volume types
    for _, volume := range pod.Spec.Volumes {
        if volume.HostPath != nil {
            violations = append(violations,
                fmt.Sprintf("Pod uses hostPath volume: %s", volume.Name))
        }
    }

    return violations
}

func (v *SecurityValidator) validateImagePolicy(pod *corev1.Pod) []string {
    var violations []string

    allowedRegistries := []string{
        "gcr.io/mycompany",
        "docker.io/mycompany",
        "quay.io/mycompany",
    }

    for _, container := range pod.Spec.Containers {
        // Check image registry
        if !isAllowedRegistry(container.Image, allowedRegistries) {
            violations = append(violations,
                fmt.Sprintf("Container %s uses disallowed registry: %s",
                    container.Name, container.Image))
        }

        // Check for latest tag
        if hasLatestTag(container.Image) {
            violations = append(violations,
                fmt.Sprintf("Container %s uses 'latest' tag: %s",
                    container.Name, container.Image))
        }

        // Check for digest-based references
        if pod.Namespace == "production" && !hasDigest(container.Image) {
            violations = append(violations,
                fmt.Sprintf("Container %s in production must use digest-based image reference",
                    container.Name))
        }
    }

    return violations
}

func (v *SecurityValidator) validateResourceRequirements(pod *corev1.Pod) []string {
    var violations []string

    for _, container := range pod.Spec.Containers {
        // Check resource requests
        if container.Resources.Requests.Cpu().IsZero() {
            violations = append(violations,
                fmt.Sprintf("Container %s missing CPU request", container.Name))
        }
        if container.Resources.Requests.Memory().IsZero() {
            violations = append(violations,
                fmt.Sprintf("Container %s missing memory request", container.Name))
        }

        // Check resource limits
        if container.Resources.Limits.Cpu().IsZero() {
            violations = append(violations,
                fmt.Sprintf("Container %s missing CPU limit", container.Name))
        }
        if container.Resources.Limits.Memory().IsZero() {
            violations = append(violations,
                fmt.Sprintf("Container %s missing memory limit", container.Name))
        }

        // Validate limit/request ratios
        if !container.Resources.Limits.Cpu().IsZero() &&
           !container.Resources.Requests.Cpu().IsZero() {
            ratio := float64(container.Resources.Limits.Cpu().MilliValue()) /
                     float64(container.Resources.Requests.Cpu().MilliValue())
            if ratio > 4.0 {
                violations = append(violations,
                    fmt.Sprintf("Container %s CPU limit/request ratio %.2f exceeds maximum 4.0",
                        container.Name, ratio))
            }
        }
    }

    return violations
}

func isDangerousCapability(cap string) bool {
    dangerous := map[string]bool{
        "SYS_ADMIN":   true,
        "SYS_MODULE":  true,
        "SYS_RAWIO":   true,
        "SYS_PTRACE":  true,
        "SYS_BOOT":    true,
        "MAC_ADMIN":   true,
        "MAC_OVERRIDE": true,
        "DAC_OVERRIDE": true,
        "NET_ADMIN":   true,
    }
    return dangerous[cap]
}

func isAllowedRegistry(image string, allowed []string) bool {
    for _, registry := range allowed {
        if len(image) >= len(registry) && image[:len(registry)] == registry {
            return true
        }
    }
    return false
}

func hasLatestTag(image string) bool {
    return len(image) >= 7 && image[len(image)-7:] == ":latest" ||
           !contains(image, ":")
}

func hasDigest(image string) bool {
    return contains(image, "@sha256:")
}

func contains(s, substr string) bool {
    return len(s) >= len(substr) &&
           s[len(s)-len(substr):len(s)] == substr ||
           s[:len(substr)] == substr
}

// HTTP handler for webhook
func (v *SecurityValidator) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    var body []byte
    if r.Body != nil {
        if data, err := ioutil.ReadAll(r.Body); err == nil {
            body = data
        }
    }

    if len(body) == 0 {
        klog.Error("Empty request body")
        http.Error(w, "Empty request body", http.StatusBadRequest)
        return
    }

    contentType := r.Header.Get("Content-Type")
    if contentType != "application/json" {
        klog.Errorf("Invalid content type: %s", contentType)
        http.Error(w, "Invalid content type", http.StatusBadRequest)
        return
    }

    var admissionReview admissionv1.AdmissionReview
    if _, _, err := codecs.UniversalDeserializer().Decode(body, nil, &admissionReview); err != nil {
        klog.Errorf("Failed to decode admission review: %v", err)
        http.Error(w, fmt.Sprintf("Failed to decode: %v", err), http.StatusBadRequest)
        return
    }

    admissionResponse := v.Validate(&admissionReview)

    responseReview := admissionv1.AdmissionReview{
        TypeMeta: metav1.TypeMeta{
            APIVersion: "admission.k8s.io/v1",
            Kind:       "AdmissionReview",
        },
        Response: admissionResponse,
    }
    responseReview.Response.UID = admissionReview.Request.UID

    respBytes, err := json.Marshal(responseReview)
    if err != nil {
        klog.Errorf("Failed to marshal response: %v", err)
        http.Error(w, fmt.Sprintf("Failed to marshal response: %v", err),
                   http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    w.Write(respBytes)
}

func main() {
    var certFile, keyFile string
    certFile = os.Getenv("TLS_CERT_FILE")
    keyFile = os.Getenv("TLS_KEY_FILE")

    if certFile == "" || keyFile == "" {
        klog.Fatal("TLS_CERT_FILE and TLS_KEY_FILE must be set")
    }

    cert, err := tls.LoadX509KeyPair(certFile, keyFile)
    if err != nil {
        klog.Fatalf("Failed to load TLS cert/key: %v", err)
    }

    validator := &SecurityValidator{
        decoder: codecs.UniversalDeserializer(),
    }

    mux := http.NewServeMux()
    mux.Handle("/validate", validator)
    mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
        w.Write([]byte("OK"))
    })

    server := &http.Server{
        Addr:    ":8443",
        Handler: mux,
        TLSConfig: &tls.Config{
            Certificates: []tls.Certificate{cert},
            MinVersion:   tls.VersionTLS12,
            CipherSuites: []uint16{
                tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
                tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
                tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
                tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
            },
        },
        ReadTimeout:  10 * time.Second,
        WriteTimeout: 10 * time.Second,
        IdleTimeout:  60 * time.Second,
    }

    go func() {
        klog.Info("Starting webhook server on :8443")
        if err := server.ListenAndServeTLS("", ""); err != nil &&
           err != http.ErrServerClosed {
            klog.Fatalf("Server failed: %v", err)
        }
    }()

    // Graceful shutdown
    sigChan := make(chan os.Signal, 1)
    signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
    <-sigChan

    klog.Info("Shutting down webhook server...")
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := server.Shutdown(ctx); err != nil {
        klog.Errorf("Server shutdown failed: %v", err)
    }
}
```

### Deployment Configuration

Complete Kubernetes deployment for the webhook:

```yaml
# namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: webhook-system
---
# serviceaccount.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: security-webhook
  namespace: webhook-system
---
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: security-webhook
  namespace: webhook-system
  labels:
    app: security-webhook
spec:
  replicas: 3
  selector:
    matchLabels:
      app: security-webhook
  template:
    metadata:
      labels:
        app: security-webhook
    spec:
      serviceAccountName: security-webhook
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 2000
      containers:
      - name: webhook
        image: myregistry/security-webhook:v1.0.0
        imagePullPolicy: Always
        ports:
        - containerPort: 8443
          name: https
        - containerPort: 8080
          name: metrics
        env:
        - name: TLS_CERT_FILE
          value: /etc/webhook/certs/tls.crt
        - name: TLS_KEY_FILE
          value: /etc/webhook/certs/tls.key
        volumeMounts:
        - name: webhook-certs
          mountPath: /etc/webhook/certs
          readOnly: true
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
            scheme: HTTP
          initialDelaySeconds: 10
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health
            port: 8080
            scheme: HTTP
          initialDelaySeconds: 5
          periodSeconds: 5
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          runAsNonRoot: true
          runAsUser: 1000
          capabilities:
            drop:
            - ALL
      volumes:
      - name: webhook-certs
        secret:
          secretName: webhook-server-cert
---
# service.yaml
apiVersion: v1
kind: Service
metadata:
  name: security-webhook
  namespace: webhook-system
spec:
  selector:
    app: security-webhook
  ports:
  - name: https
    port: 443
    targetPort: 8443
  - name: metrics
    port: 8080
    targetPort: 8080
---
# servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: security-webhook
  namespace: webhook-system
spec:
  selector:
    matchLabels:
      app: security-webhook
  endpoints:
  - port: metrics
    interval: 30s
```

### Certificate Management

Use cert-manager for automatic certificate provisioning:

```yaml
# certificate.yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: webhook-server-cert
  namespace: webhook-system
spec:
  secretName: webhook-server-cert
  duration: 2160h # 90 days
  renewBefore: 360h # 15 days
  subject:
    organizations:
    - mycompany
  commonName: security-webhook.webhook-system.svc
  dnsNames:
  - security-webhook
  - security-webhook.webhook-system
  - security-webhook.webhook-system.svc
  - security-webhook.webhook-system.svc.cluster.local
  issuerRef:
    name: selfsigned-issuer
    kind: ClusterIssuer
---
# issuer.yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned-issuer
spec:
  selfSigned: {}
```

### Webhook Configuration

Register the validating webhook with Kubernetes:

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: security-webhook
  annotations:
    cert-manager.io/inject-ca-from: webhook-system/webhook-server-cert
webhooks:
- name: validate.pods.security.mycompany.com
  admissionReviewVersions: ["v1", "v1beta1"]
  clientConfig:
    service:
      name: security-webhook
      namespace: webhook-system
      path: /validate
      port: 443
    caBundle: Cg==  # Will be injected by cert-manager
  rules:
  - operations: ["CREATE", "UPDATE"]
    apiGroups: [""]
    apiVersions: ["v1"]
    resources: ["pods"]
    scope: "Namespaced"
  failurePolicy: Fail
  sideEffects: None
  timeoutSeconds: 10
  matchPolicy: Equivalent
  namespaceSelector:
    matchExpressions:
    - key: webhook-validation
      operator: NotIn
      values:
      - disabled
  objectSelector:
    matchExpressions:
    - key: webhook-validation
      operator: NotIn
      values:
      - skip
```

## Building a Mutating Webhook

### Sidecar Injection Pattern

Implement automatic sidecar injection:

```go
// mutator.go
package main

import (
    "encoding/json"
    "fmt"

    admissionv1 "k8s.io/api/admission/v1"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/resource"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/klog/v2"
)

type SecurityMutator struct{}

type patchOperation struct {
    Op    string      `json:"op"`
    Path  string      `json:"path"`
    Value interface{} `json:"value,omitempty"`
}

func (m *SecurityMutator) Mutate(ar *admissionv1.AdmissionReview) *admissionv1.AdmissionResponse {
    req := ar.Request

    var pod corev1.Pod
    if err := json.Unmarshal(req.Object.Raw, &pod); err != nil {
        klog.Errorf("Failed to decode pod: %v", err)
        return &admissionv1.AdmissionResponse{
            Allowed: false,
            Result: &metav1.Status{
                Message: fmt.Sprintf("Failed to decode pod: %v", err),
            },
        }
    }

    klog.Infof("Mutating pod %s/%s", req.Namespace, req.Name)

    var patches []patchOperation

    // Add security context if missing
    patches = append(patches, m.addSecurityContext(&pod)...)

    // Inject monitoring sidecar if needed
    if shouldInjectMonitoring(&pod) {
        patches = append(patches, m.injectMonitoringSidecar(&pod)...)
    }

    // Add resource defaults
    patches = append(patches, m.addResourceDefaults(&pod)...)

    // Add labels
    patches = append(patches, m.addLabels(&pod)...)

    patchBytes, err := json.Marshal(patches)
    if err != nil {
        klog.Errorf("Failed to marshal patches: %v", err)
        return &admissionv1.AdmissionResponse{
            Allowed: false,
            Result: &metav1.Status{
                Message: fmt.Sprintf("Failed to marshal patches: %v", err),
            },
        }
    }

    klog.Infof("Applied %d patches to pod %s/%s", len(patches), req.Namespace, req.Name)

    return &admissionv1.AdmissionResponse{
        Allowed: true,
        Patch:   patchBytes,
        PatchType: func() *admissionv1.PatchType {
            pt := admissionv1.PatchTypeJSONPatch
            return &pt
        }(),
    }
}

func (m *SecurityMutator) addSecurityContext(pod *corev1.Pod) []patchOperation {
    var patches []patchOperation

    // Add pod-level security context
    if pod.Spec.SecurityContext == nil {
        patches = append(patches, patchOperation{
            Op:   "add",
            Path: "/spec/securityContext",
            Value: &corev1.PodSecurityContext{
                RunAsNonRoot: boolPtr(true),
                RunAsUser:    int64Ptr(1000),
                FSGroup:      int64Ptr(2000),
                SeccompProfile: &corev1.SeccompProfile{
                    Type: corev1.SeccompProfileTypeRuntimeDefault,
                },
            },
        })
    }

    // Add container-level security contexts
    for i, container := range pod.Spec.Containers {
        if container.SecurityContext == nil {
            patches = append(patches, patchOperation{
                Op:   "add",
                Path: fmt.Sprintf("/spec/containers/%d/securityContext", i),
                Value: &corev1.SecurityContext{
                    AllowPrivilegeEscalation: boolPtr(false),
                    RunAsNonRoot:             boolPtr(true),
                    RunAsUser:                int64Ptr(1000),
                    Capabilities: &corev1.Capabilities{
                        Drop: []corev1.Capability{"ALL"},
                    },
                    ReadOnlyRootFilesystem: boolPtr(true),
                },
            })
        }
    }

    return patches
}

func (m *SecurityMutator) injectMonitoringSidecar(pod *corev1.Pod) []patchOperation {
    var patches []patchOperation

    sidecar := corev1.Container{
        Name:  "metrics-exporter",
        Image: "prom/node-exporter:latest",
        Ports: []corev1.ContainerPort{
            {
                Name:          "metrics",
                ContainerPort: 9100,
                Protocol:      corev1.ProtocolTCP,
            },
        },
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
        SecurityContext: &corev1.SecurityContext{
            AllowPrivilegeEscalation: boolPtr(false),
            RunAsNonRoot:             boolPtr(true),
            RunAsUser:                int64Ptr(65534),
            Capabilities: &corev1.Capabilities{
                Drop: []corev1.Capability{"ALL"},
            },
        },
    }

    patches = append(patches, patchOperation{
        Op:    "add",
        Path:  "/spec/containers/-",
        Value: sidecar,
    })

    return patches
}

func (m *SecurityMutator) addResourceDefaults(pod *corev1.Pod) []patchOperation {
    var patches []patchOperation

    for i, container := range pod.Spec.Containers {
        if container.Resources.Requests.Cpu().IsZero() {
            patches = append(patches, patchOperation{
                Op:   "add",
                Path: fmt.Sprintf("/spec/containers/%d/resources/requests/cpu", i),
                Value: "100m",
            })
        }
        if container.Resources.Requests.Memory().IsZero() {
            patches = append(patches, patchOperation{
                Op:   "add",
                Path: fmt.Sprintf("/spec/containers/%d/resources/requests/memory", i),
                Value: "128Mi",
            })
        }
        if container.Resources.Limits.Cpu().IsZero() {
            patches = append(patches, patchOperation{
                Op:   "add",
                Path: fmt.Sprintf("/spec/containers/%d/resources/limits/cpu", i),
                Value: "500m",
            })
        }
        if container.Resources.Limits.Memory().IsZero() {
            patches = append(patches, patchOperation{
                Op:   "add",
                Path: fmt.Sprintf("/spec/containers/%d/resources/limits/memory", i),
                Value: "512Mi",
            })
        }
    }

    return patches
}

func (m *SecurityMutator) addLabels(pod *corev1.Pod) []patchOperation {
    var patches []patchOperation

    requiredLabels := map[string]string{
        "mutated-by":         "security-webhook",
        "security-validated": "true",
    }

    if pod.Labels == nil {
        patches = append(patches, patchOperation{
            Op:    "add",
            Path:  "/metadata/labels",
            Value: requiredLabels,
        })
    } else {
        for key, value := range requiredLabels {
            if _, exists := pod.Labels[key]; !exists {
                patches = append(patches, patchOperation{
                    Op:    "add",
                    Path:  fmt.Sprintf("/metadata/labels/%s", key),
                    Value: value,
                })
            }
        }
    }

    return patches
}

func shouldInjectMonitoring(pod *corev1.Pod) bool {
    if pod.Annotations == nil {
        return false
    }
    val, exists := pod.Annotations["inject-monitoring"]
    return exists && val == "true"
}

func boolPtr(b bool) *bool {
    return &b
}

func int64Ptr(i int64) *int64 {
    return &i
}
```

### Mutating Webhook Configuration

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: security-mutating-webhook
  annotations:
    cert-manager.io/inject-ca-from: webhook-system/webhook-server-cert
webhooks:
- name: mutate.pods.security.mycompany.com
  admissionReviewVersions: ["v1", "v1beta1"]
  clientConfig:
    service:
      name: security-webhook
      namespace: webhook-system
      path: /mutate
      port: 443
    caBundle: Cg==
  rules:
  - operations: ["CREATE"]
    apiGroups: [""]
    apiVersions: ["v1"]
    resources: ["pods"]
    scope: "Namespaced"
  failurePolicy: Fail
  sideEffects: None
  timeoutSeconds: 10
  reinvocationPolicy: IfNeeded
  namespaceSelector:
    matchExpressions:
    - key: webhook-mutation
      operator: NotIn
      values:
      - disabled
```

## Advanced Use Cases

### Image Signature Verification

Integrate with Sigstore for image verification:

```go
// image_verifier.go
package main

import (
    "context"
    "fmt"

    "github.com/sigstore/cosign/pkg/cosign"
    "github.com/sigstore/cosign/pkg/oci/remote"
    corev1 "k8s.io/api/core/v1"
)

type ImageVerifier struct {
    publicKeys []string
    rekorURL   string
}

func (v *ImageVerifier) VerifyImage(ctx context.Context, image string) error {
    ref, err := name.ParseReference(image)
    if err != nil {
        return fmt.Errorf("invalid image reference: %w", err)
    }

    // Verify signature
    co := &cosign.CheckOpts{
        RegistryClientOpts: []remote.Option{
            remote.WithAuthFromKeychain(authn.DefaultKeychain),
        },
        RekorURL: v.rekorURL,
    }

    verified, err := cosign.Verify(ctx, ref, co)
    if err != nil {
        return fmt.Errorf("signature verification failed: %w", err)
    }

    if len(verified) == 0 {
        return fmt.Errorf("no verified signatures found for image %s", image)
    }

    return nil
}

func (v *ImageVerifier) ValidatePodImages(ctx context.Context, pod *corev1.Pod) error {
    for _, container := range pod.Spec.Containers {
        if err := v.VerifyImage(ctx, container.Image); err != nil {
            return fmt.Errorf("container %s: %w", container.Name, err)
        }
    }

    for _, container := range pod.Spec.InitContainers {
        if err := v.VerifyImage(ctx, container.Image); err != nil {
            return fmt.Errorf("init container %s: %w", container.Name, err)
        }
    }

    return nil
}
```

### Dynamic Policy Configuration

Use ConfigMap for dynamic policy updates:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: webhook-policies
  namespace: webhook-system
data:
  allowed-registries.json: |
    {
      "registries": [
        "gcr.io/mycompany",
        "quay.io/mycompany"
      ]
    }
  resource-limits.json: |
    {
      "defaults": {
        "cpu": {
          "request": "100m",
          "limit": "500m"
        },
        "memory": {
          "request": "128Mi",
          "limit": "512Mi"
        }
      },
      "production": {
        "cpu": {
          "request": "500m",
          "limit": "2000m"
        },
        "memory": {
          "request": "512Mi",
          "limit": "2048Mi"
        }
      }
    }
  security-policies.json: |
    {
      "requireNonRoot": true,
      "allowPrivilegeEscalation": false,
      "requiredDropCapabilities": ["ALL"],
      "allowedCapabilities": [],
      "hostNetwork": false,
      "hostPID": false,
      "hostIPC": false
    }
```

## Testing and Validation

### Unit Testing

```go
// validator_test.go
package main

import (
    "encoding/json"
    "testing"

    admissionv1 "k8s.io/api/admission/v1"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
)

func TestValidatePrivilegedPod(t *testing.T) {
    validator := &SecurityValidator{}

    privileged := true
    pod := &corev1.Pod{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "test-pod",
            Namespace: "default",
        },
        Spec: corev1.PodSpec{
            Containers: []corev1.Container{
                {
                    Name:  "test-container",
                    Image: "nginx:1.14",
                    SecurityContext: &corev1.SecurityContext{
                        Privileged: &privileged,
                    },
                },
            },
        },
    }

    podBytes, _ := json.Marshal(pod)
    ar := &admissionv1.AdmissionReview{
        Request: &admissionv1.AdmissionRequest{
            UID: "test-uid",
            Kind: metav1.GroupVersionKind{
                Kind: "Pod",
            },
            Namespace: "default",
            Name:      "test-pod",
            Operation: admissionv1.Create,
            Object: runtime.RawExtension{
                Raw: podBytes,
            },
        },
    }

    response := validator.Validate(ar)

    if response.Allowed {
        t.Error("Expected privileged pod to be rejected")
    }

    if response.Result == nil || response.Result.Message == "" {
        t.Error("Expected rejection message")
    }
}

func TestValidateValidPod(t *testing.T) {
    validator := &SecurityValidator{}

    nonRoot := true
    allowEscalation := false
    pod := &corev1.Pod{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "test-pod",
            Namespace: "default",
        },
        Spec: corev1.PodSpec{
            SecurityContext: &corev1.PodSecurityContext{
                RunAsNonRoot: &nonRoot,
                RunAsUser:    int64Ptr(1000),
            },
            Containers: []corev1.Container{
                {
                    Name:  "test-container",
                    Image: "gcr.io/mycompany/nginx:1.14",
                    SecurityContext: &corev1.SecurityContext{
                        AllowPrivilegeEscalation: &allowEscalation,
                        RunAsNonRoot:             &nonRoot,
                        Capabilities: &corev1.Capabilities{
                            Drop: []corev1.Capability{"ALL"},
                        },
                    },
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

    podBytes, _ := json.Marshal(pod)
    ar := &admissionv1.AdmissionReview{
        Request: &admissionv1.AdmissionRequest{
            UID: "test-uid",
            Kind: metav1.GroupVersionKind{
                Kind: "Pod",
            },
            Namespace: "default",
            Name:      "test-pod",
            Operation: admissionv1.Create,
            Object: runtime.RawExtension{
                Raw: podBytes,
            },
        },
    }

    response := validator.Validate(ar)

    if !response.Allowed {
        t.Errorf("Expected valid pod to be allowed, got: %v",
                 response.Result.Message)
    }
}
```

### Integration Testing

```bash
#!/bin/bash
# test-webhook.sh

set -e

echo "=== Testing Admission Webhook ==="
echo

# Test 1: Reject privileged pod
echo "Test 1: Rejecting privileged pod..."
cat <<EOF | kubectl apply -f - 2>&1 | grep -q "Security policy violations" && echo "✓ PASS" || echo "✗ FAIL"
apiVersion: v1
kind: Pod
metadata:
  name: privileged-pod
  namespace: default
spec:
  containers:
  - name: test
    image: nginx
    securityContext:
      privileged: true
EOF

# Test 2: Reject pod with hostNetwork
echo "Test 2: Rejecting pod with hostNetwork..."
cat <<EOF | kubectl apply -f - 2>&1 | grep -q "uses hostNetwork" && echo "✓ PASS" || echo "✗ FAIL"
apiVersion: v1
kind: Pod
metadata:
  name: hostnetwork-pod
  namespace: default
spec:
  hostNetwork: true
  containers:
  - name: test
    image: nginx
EOF

# Test 3: Accept secure pod
echo "Test 3: Accepting secure pod..."
cat <<EOF | kubectl apply -f - && echo "✓ PASS" || echo "✗ FAIL"
apiVersion: v1
kind: Pod
metadata:
  name: secure-pod
  namespace: default
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
  containers:
  - name: test
    image: gcr.io/mycompany/nginx:1.14
    securityContext:
      allowPrivilegeEscalation: false
      runAsNonRoot: true
      capabilities:
        drop:
        - ALL
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        cpu: 500m
        memory: 512Mi
EOF

# Cleanup
kubectl delete pod secure-pod --ignore-not-found

echo
echo "=== Tests Complete ==="
```

## Monitoring and Troubleshooting

### Prometheus Metrics

```go
// metrics.go
package main

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    webhookRequests = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "webhook_admission_requests_total",
            Help: "Total number of admission requests",
        },
        []string{"operation", "resource", "result"},
    )

    webhookDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "webhook_admission_duration_seconds",
            Help:    "Duration of admission webhook requests",
            Buckets: prometheus.DefBuckets,
        },
        []string{"operation", "resource"},
    )

    policyViolations = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "webhook_policy_violations_total",
            Help: "Total number of policy violations detected",
        },
        []string{"policy_type", "namespace"},
    )
)
```

### Logging Best Practices

```go
// Structured logging example
klog.InfoS("Processing admission request",
    "uid", req.UID,
    "operation", req.Operation,
    "namespace", req.Namespace,
    "name", req.Name,
    "kind", req.Kind.Kind,
    "user", req.UserInfo.Username,
)

klog.ErrorS(err, "Validation failed",
    "uid", req.UID,
    "violations", violations,
    "namespace", req.Namespace,
)
```

## Best Practices

### Production Deployment

1. **High Availability**: Deploy multiple replicas with PodDisruptionBudgets
2. **Fast Failure**: Set appropriate timeout values (5-10 seconds)
3. **Graceful Degradation**: Use `failurePolicy: Ignore` for non-critical webhooks
4. **Namespace Selectors**: Exclude system namespaces from validation
5. **Resource Limits**: Set appropriate CPU/memory limits
6. **Certificate Rotation**: Automate with cert-manager
7. **Monitoring**: Instrument with Prometheus metrics
8. **Testing**: Comprehensive unit and integration tests

### Security Considerations

1. **Least Privilege**: Minimal RBAC permissions for webhook service account
2. **Network Policies**: Restrict webhook traffic
3. **Audit Logging**: Enable audit logs for webhook decisions
4. **Input Validation**: Validate all admission review inputs
5. **Timeout Handling**: Implement proper timeout handling
6. **Error Messages**: Don't leak sensitive information in errors

## Conclusion

Admission webhooks provide powerful extensibility for enforcing custom security policies in Kubernetes. By implementing both validating and mutating webhooks, organizations can:

- Enforce security policies beyond native Kubernetes capabilities
- Automatically inject security configurations
- Validate compliance with organizational standards
- Provide defense-in-depth security controls

Success with admission webhooks requires careful design, comprehensive testing, robust error handling, and operational excellence. When combined with Pod Security Standards, RBAC, and network policies, admission webhooks enable sophisticated security enforcement for enterprise Kubernetes environments.