---
title: "Kubernetes Admission Controller Webhook Development: Validating and Mutating at Scale"
date: 2027-04-16T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Admission Controller", "Webhook", "Go", "Security"]
categories: ["Kubernetes", "Go"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Step-by-step guide to developing custom Kubernetes admission controller webhooks in Go, covering validating and mutating webhooks, TLS configuration, leader election, and production deployment patterns."
more_link: "yes"
url: "/admission-controller-webhook-development-guide/"
---

Kubernetes admission controllers are plugins that intercept API server requests after authentication and authorization but before the object is persisted. The two most powerful extension points are validating admission webhooks and mutating admission webhooks. Validating webhooks enforce business rules and reject non-compliant objects. Mutating webhooks rewrite incoming objects — injecting sidecars, setting default fields, or normalizing configuration — before they are stored.

Building a custom admission webhook in Go unlocks enforcement logic that is too complex for OPA/Rego, requires external service calls, or needs tighter integration with internal systems. This guide covers the complete development lifecycle: webhook types, the admission review flow, implementing handlers with controller-runtime, TLS configuration with cert-manager, testing strategies, failure policies, and production-grade deployment patterns.

<!--more-->

## Section 1: Admission Webhook Architecture

### The Admission Flow

```
kubectl apply -f pod.yaml
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│  Kubernetes API Server                                        │
│                                                              │
│  1. Authentication & Authorization                           │
│  2. Object Deserialization + Schema Validation               │
│  3. ┌────────────────────────────────────────────────────┐  │
│     │  Mutating Admission Webhooks (called in parallel)  │  │
│     │  - Patch objects before storage                    │  │
│     │  - Return JSON Patch operations                    │  │
│     └────────────────────────────────────────────────────┘  │
│  4. Object Schema Re-validation (after mutations)            │
│  5. ┌────────────────────────────────────────────────────┐  │
│     │  Validating Admission Webhooks (called in parallel)│  │
│     │  - Approve or reject the object                    │  │
│     │  - No object modification allowed                  │  │
│     └────────────────────────────────────────────────────┘  │
│  6. etcd storage (if all webhooks approve)                   │
└──────────────────────────────────────────────────────────────┘
```

### Webhook vs Policy Engine

Custom webhooks are preferable when:
- Policy logic requires calling external APIs (image scanners, secret vaults, CMDB).
- Mutation logic is complex (building pod templates, transforming specifications).
- Strong type safety and unit testability are required.
- Performance requirements demand sub-millisecond evaluation.

OPA Gatekeeper and Kyverno are preferable for:
- Declarative, configuration-driven policies manageable by non-developers.
- Audit reporting and bulk compliance scanning.
- Standardized policy sets shared across teams.

---

## Section 2: Project Structure

```
admission-webhook/
├── cmd/
│   └── webhook/
│       └── main.go
├── pkg/
│   ├── webhook/
│   │   ├── server.go          # HTTP server setup
│   │   ├── handler.go         # AdmissionReview routing
│   │   ├── validating.go      # Validating webhook handlers
│   │   ├── mutating.go        # Mutating webhook handlers
│   │   └── response.go        # Helper functions
│   └── validators/
│       ├── pod_validator.go
│       └── ingress_validator.go
├── config/
│   ├── webhook-deployment.yaml
│   ├── webhook-service.yaml
│   ├── validating-webhook-config.yaml
│   ├── mutating-webhook-config.yaml
│   └── cert-manager-certificate.yaml
├── Dockerfile
├── go.mod
└── go.sum
```

### Go Module Setup

```bash
mkdir admission-webhook && cd admission-webhook
go mod init github.com/company/admission-webhook

# Required dependencies
go get sigs.k8s.io/controller-runtime@v0.18.4
go get k8s.io/api@v0.29.3
go get k8s.io/apimachinery@v0.29.3
go get k8s.io/client-go@v0.29.3
go get github.com/go-logr/logr@v1.4.2
go get go.uber.org/zap@v1.27.0
```

---

## Section 3: Core Webhook Server Implementation

### main.go

```go
// cmd/webhook/main.go
package main

import (
    "flag"
    "os"

    "go.uber.org/zap/zapcore"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/runtime"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/healthz"
    "sigs.k8s.io/controller-runtime/pkg/log/zap"
    "sigs.k8s.io/controller-runtime/pkg/webhook"

    "github.com/company/admission-webhook/pkg/validators"
)

var (
    scheme   = runtime.NewScheme()
    setupLog = ctrl.Log.WithName("setup")
)

func init() {
    _ = corev1.AddToScheme(scheme)
}

func main() {
    var (
        metricsAddr          string
        probeAddr            string
        certDir              string
        port                 int
        enableLeaderElection bool
    )

    flag.StringVar(&metricsAddr, "metrics-bind-address", ":8080", "Address for metrics endpoint")
    flag.StringVar(&probeAddr, "health-probe-bind-address", ":8081", "Address for health probes")
    flag.StringVar(&certDir, "cert-dir", "/tmp/k8s-webhook-server/serving-certs", "Directory containing TLS certificates")
    flag.IntVar(&port, "port", 9443, "Port for webhook server")
    flag.BoolVar(&enableLeaderElection, "leader-elect", false, "Enable leader election for controller manager")
    flag.Parse()

    opts := zap.Options{
        Development: false,
        TimeEncoder: zapcore.ISO8601TimeEncoder,
    }
    ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))

    mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
        Scheme:                 scheme,
        MetricsBindAddress:     metricsAddr,
        Port:                   port,
        HealthProbeBindAddress: probeAddr,
        LeaderElection:         enableLeaderElection,
        LeaderElectionID:       "admission-webhook-leader.company.io",
        CertDir:                certDir,
    })
    if err != nil {
        setupLog.Error(err, "unable to create manager")
        os.Exit(1)
    }

    // Register validating webhook handlers
    podValidator := &validators.PodValidator{
        Client: mgr.GetClient(),
        Log:    ctrl.Log.WithName("validators").WithName("Pod"),
    }
    mgr.GetWebhookServer().Register("/validate-pod", &webhook.Admission{
        Handler: podValidator,
    })

    // Register mutating webhook handlers
    podMutator := &validators.PodMutator{
        Client:  mgr.GetClient(),
        Log:     ctrl.Log.WithName("mutators").WithName("Pod"),
        Decoder: admission.NewDecoder(scheme),
    }
    mgr.GetWebhookServer().Register("/mutate-pod", &webhook.Admission{
        Handler: podMutator,
    })

    if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
        setupLog.Error(err, "unable to set up health check")
        os.Exit(1)
    }
    if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
        setupLog.Error(err, "unable to set up ready check")
        os.Exit(1)
    }

    setupLog.Info("starting manager")
    if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
        setupLog.Error(err, "problem running manager")
        os.Exit(1)
    }
}
```

---

## Section 4: Validating Webhook Handler

```go
// pkg/validators/pod_validator.go
package validators

import (
    "context"
    "fmt"
    "net/http"
    "strings"

    "github.com/go-logr/logr"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/util/validation/field"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/webhook/admission"
)

// PodValidator handles validating admission webhooks for Pods
type PodValidator struct {
    Client client.Client
    Log    logr.Logger
}

// Implement the admission.Handler interface
func (v *PodValidator) Handle(ctx context.Context, req admission.Request) admission.Response {
    log := v.Log.WithValues(
        "namespace", req.Namespace,
        "name", req.Name,
        "operation", req.Operation,
    )

    pod := &corev1.Pod{}
    if err := admission.NewDecoder(req.Scheme).Decode(req, pod); err != nil {
        log.Error(err, "failed to decode pod")
        return admission.Errored(http.StatusBadRequest, err)
    }

    log.V(1).Info("validating pod", "pod", pod.Name)

    // Run all validation checks; collect all errors
    var allErrs field.ErrorList
    allErrs = append(allErrs, v.validateResourceLimits(pod)...)
    allErrs = append(allErrs, v.validateImageTags(pod)...)
    allErrs = append(allErrs, v.validateSecurityContext(pod)...)
    allErrs = append(allErrs, v.validateRequiredLabels(pod)...)

    if len(allErrs) > 0 {
        log.Info("pod validation failed",
            "violations", len(allErrs),
            "errors", allErrs.ToAggregate().Error(),
        )
        return admission.Denied(allErrs.ToAggregate().Error())
    }

    log.V(1).Info("pod validation passed")
    return admission.Allowed("pod passed all validation checks")
}

// validateResourceLimits checks that all containers specify CPU and memory limits
func (v *PodValidator) validateResourceLimits(pod *corev1.Pod) field.ErrorList {
    var errs field.ErrorList
    containersField := field.NewPath("spec", "containers")
    initContainersField := field.NewPath("spec", "initContainers")

    checkContainer := func(containers []corev1.Container, basePath *field.Path) {
        for i, c := range containers {
            containerPath := basePath.Index(i)
            if c.Resources.Limits.Cpu().IsZero() {
                errs = append(errs, field.Required(
                    containerPath.Child("resources", "limits", "cpu"),
                    fmt.Sprintf("container %q must specify a CPU limit", c.Name),
                ))
            }
            if c.Resources.Limits.Memory().IsZero() {
                errs = append(errs, field.Required(
                    containerPath.Child("resources", "limits", "memory"),
                    fmt.Sprintf("container %q must specify a memory limit", c.Name),
                ))
            }
        }
    }

    checkContainer(pod.Spec.Containers, containersField)
    checkContainer(pod.Spec.InitContainers, initContainersField)
    return errs
}

// validateImageTags rejects :latest tags and untagged images
func (v *PodValidator) validateImageTags(pod *corev1.Pod) field.ErrorList {
    var errs field.ErrorList

    // System namespaces are exempt
    exemptNamespaces := map[string]bool{
        "kube-system":       true,
        "gatekeeper-system": true,
        "cert-manager":      true,
    }
    if exemptNamespaces[pod.Namespace] {
        return errs
    }

    checkImage := func(containers []corev1.Container, basePath *field.Path) {
        for i, c := range containers {
            image := c.Image
            if !strings.Contains(image, ":") || strings.HasSuffix(image, ":latest") {
                errs = append(errs, field.Invalid(
                    basePath.Index(i).Child("image"),
                    image,
                    "container image must specify a tag other than :latest",
                ))
            }
        }
    }

    containersField := field.NewPath("spec", "containers")
    initContainersField := field.NewPath("spec", "initContainers")
    checkImage(pod.Spec.Containers, containersField)
    checkImage(pod.Spec.InitContainers, initContainersField)
    return errs
}

// validateSecurityContext ensures containers do not run privileged
func (v *PodValidator) validateSecurityContext(pod *corev1.Pod) field.ErrorList {
    var errs field.ErrorList

    checkSecurity := func(containers []corev1.Container, basePath *field.Path) {
        for i, c := range containers {
            containerPath := basePath.Index(i)
            sc := c.SecurityContext
            if sc == nil {
                continue
            }
            if sc.Privileged != nil && *sc.Privileged {
                errs = append(errs, field.Forbidden(
                    containerPath.Child("securityContext", "privileged"),
                    fmt.Sprintf("container %q must not run as privileged", c.Name),
                ))
            }
            if sc.AllowPrivilegeEscalation != nil && *sc.AllowPrivilegeEscalation {
                errs = append(errs, field.Forbidden(
                    containerPath.Child("securityContext", "allowPrivilegeEscalation"),
                    fmt.Sprintf("container %q must not allow privilege escalation", c.Name),
                ))
            }
        }
    }

    checkSecurity(pod.Spec.Containers, field.NewPath("spec", "containers"))
    checkSecurity(pod.Spec.InitContainers, field.NewPath("spec", "initContainers"))
    return errs
}

// validateRequiredLabels ensures required labels are present
func (v *PodValidator) validateRequiredLabels(pod *corev1.Pod) field.ErrorList {
    var errs field.ErrorList
    requiredLabels := []string{"app", "version", "team"}

    for _, label := range requiredLabels {
        if _, ok := pod.Labels[label]; !ok {
            errs = append(errs, field.Required(
                field.NewPath("metadata", "labels").Key(label),
                fmt.Sprintf("label %q is required", label),
            ))
        }
    }
    return errs
}
```

---

## Section 5: Mutating Webhook Handler

```go
// pkg/validators/pod_mutator.go
package validators

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"

    "github.com/go-logr/logr"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/resource"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/webhook/admission"
)

// PodMutator handles mutating admission webhooks for Pods
type PodMutator struct {
    Client  client.Client
    Log     logr.Logger
    Decoder *admission.Decoder
}

func (m *PodMutator) Handle(ctx context.Context, req admission.Request) admission.Response {
    log := m.Log.WithValues(
        "namespace", req.Namespace,
        "name", req.Name,
        "operation", req.Operation,
    )

    pod := &corev1.Pod{}
    if err := m.Decoder.Decode(req, pod); err != nil {
        log.Error(err, "failed to decode pod")
        return admission.Errored(http.StatusBadRequest, err)
    }

    // Make a deep copy for comparison
    original, err := json.Marshal(pod)
    if err != nil {
        return admission.Errored(http.StatusInternalServerError, err)
    }

    // Apply mutations
    m.setDefaultResourceLimits(pod)
    m.injectCommonLabels(pod)
    m.setSecurityDefaults(pod)
    m.addLoggingAnnotations(pod)

    // Build and return JSON patch
    mutated, err := json.Marshal(pod)
    if err != nil {
        return admission.Errored(http.StatusInternalServerError, err)
    }

    log.V(1).Info("pod mutation complete")
    return admission.PatchResponseFromRaw(original, mutated)
}

// setDefaultResourceLimits injects default resource limits for containers
// that do not specify their own
func (m *PodMutator) setDefaultResourceLimits(pod *corev1.Pod) {
    defaultCPURequest := resource.MustParse("100m")
    defaultCPULimit := resource.MustParse("500m")
    defaultMemRequest := resource.MustParse("128Mi")
    defaultMemLimit := resource.MustParse("256Mi")

    for i := range pod.Spec.Containers {
        c := &pod.Spec.Containers[i]
        if c.Resources.Requests == nil {
            c.Resources.Requests = corev1.ResourceList{}
        }
        if c.Resources.Limits == nil {
            c.Resources.Limits = corev1.ResourceList{}
        }

        if _, ok := c.Resources.Requests[corev1.ResourceCPU]; !ok {
            c.Resources.Requests[corev1.ResourceCPU] = defaultCPURequest
        }
        if _, ok := c.Resources.Limits[corev1.ResourceCPU]; !ok {
            c.Resources.Limits[corev1.ResourceCPU] = defaultCPULimit
        }
        if _, ok := c.Resources.Requests[corev1.ResourceMemory]; !ok {
            c.Resources.Requests[corev1.ResourceMemory] = defaultMemRequest
        }
        if _, ok := c.Resources.Limits[corev1.ResourceMemory]; !ok {
            c.Resources.Limits[corev1.ResourceMemory] = defaultMemLimit
        }
    }
}

// injectCommonLabels adds platform-required labels if not already present
func (m *PodMutator) injectCommonLabels(pod *corev1.Pod) {
    if pod.Labels == nil {
        pod.Labels = map[string]string{}
    }
    if _, ok := pod.Labels["managed-by"]; !ok {
        pod.Labels["managed-by"] = "admission-webhook"
    }
    if _, ok := pod.Labels["webhook-injected"]; !ok {
        pod.Labels["webhook-injected"] = "true"
    }
}

// setSecurityDefaults applies baseline security context settings
func (m *PodMutator) setSecurityDefaults(pod *corev1.Pod) {
    falseVal := false
    trueVal := true

    if pod.Spec.SecurityContext == nil {
        pod.Spec.SecurityContext = &corev1.PodSecurityContext{}
    }
    if pod.Spec.SecurityContext.RunAsNonRoot == nil {
        pod.Spec.SecurityContext.RunAsNonRoot = &trueVal
    }

    for i := range pod.Spec.Containers {
        c := &pod.Spec.Containers[i]
        if c.SecurityContext == nil {
            c.SecurityContext = &corev1.SecurityContext{}
        }
        if c.SecurityContext.AllowPrivilegeEscalation == nil {
            c.SecurityContext.AllowPrivilegeEscalation = &falseVal
        }
        if c.SecurityContext.ReadOnlyRootFilesystem == nil {
            c.SecurityContext.ReadOnlyRootFilesystem = &trueVal
        }
    }
}

// addLoggingAnnotations adds annotations for log aggregation routing
func (m *PodMutator) addLoggingAnnotations(pod *corev1.Pod) {
    if pod.Annotations == nil {
        pod.Annotations = map[string]string{}
    }
    if _, ok := pod.Annotations["logging.company.io/enabled"]; !ok {
        pod.Annotations["logging.company.io/enabled"] = "true"
    }
    if _, ok := pod.Annotations["logging.company.io/format"]; !ok {
        pod.Annotations["logging.company.io/format"] = "json"
    }
    if team, ok := pod.Labels["team"]; ok {
        pod.Annotations["logging.company.io/team"] = team
    }
    // Record that this pod was processed by the mutating webhook
    pod.Annotations["webhook.company.io/mutated"] = fmt.Sprintf("true")
}
```

---

## Section 6: TLS Configuration with cert-manager

Admission webhooks require TLS. The Kubernetes API server verifies the webhook server's certificate using a CA bundle specified in the `WebhookConfiguration`. cert-manager automates certificate issuance and renewal.

### cert-manager Certificate for Webhook

```yaml
# config/cert-manager-certificate.yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: admission-webhook-tls
  namespace: admission-webhook
spec:
  secretName: admission-webhook-tls-secret
  duration: 8760h     # 1 year
  renewBefore: 720h   # Renew 30 days before expiry
  subject:
    organizations:
      - "company.internal"
  commonName: admission-webhook.admission-webhook.svc
  dnsNames:
    - admission-webhook.admission-webhook.svc
    - admission-webhook.admission-webhook.svc.cluster.local
  issuerRef:
    name: cluster-ca-issuer
    kind: ClusterIssuer
    group: cert-manager.io
```

### WebhookConfiguration with caInjectFrom Annotation

cert-manager can automatically inject the CA bundle into WebhookConfiguration objects using the `cert-manager.io/inject-ca-from` annotation.

```yaml
# config/validating-webhook-config.yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: admission-webhook-validation
  annotations:
    # cert-manager injects the CA bundle automatically
    cert-manager.io/inject-ca-from: "admission-webhook/admission-webhook-tls"
webhooks:
  - name: pod.validation.admission-webhook.company.io
    admissionReviewVersions: ["v1", "v1beta1"]
    sideEffects: None
    failurePolicy: Fail
    timeoutSeconds: 10
    rules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["pods"]
        scope: "Namespaced"
    clientConfig:
      service:
        name: admission-webhook
        namespace: admission-webhook
        path: "/validate-pod"
        port: 443
    namespaceSelector:
      matchExpressions:
        - key: "kubernetes.io/metadata.name"
          operator: NotIn
          values:
            - kube-system
            - gatekeeper-system
            - cert-manager
            - admission-webhook
    # Exclude resources with the bypass annotation
    objectSelector:
      matchExpressions:
        - key: "webhook.company.io/bypass-validation"
          operator: DoesNotExist
```

```yaml
# config/mutating-webhook-config.yaml
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: admission-webhook-mutation
  annotations:
    cert-manager.io/inject-ca-from: "admission-webhook/admission-webhook-tls"
webhooks:
  - name: pod.mutation.admission-webhook.company.io
    admissionReviewVersions: ["v1", "v1beta1"]
    sideEffects: None
    failurePolicy: Ignore   # Mutation failures should not block pod creation
    timeoutSeconds: 10
    reinvocationPolicy: Never
    rules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        operations: ["CREATE"]
        resources: ["pods"]
        scope: "Namespaced"
    clientConfig:
      service:
        name: admission-webhook
        namespace: admission-webhook
        path: "/mutate-pod"
        port: 443
    namespaceSelector:
      matchExpressions:
        - key: "kubernetes.io/metadata.name"
          operator: NotIn
          values:
            - kube-system
            - gatekeeper-system
            - admission-webhook
```

---

## Section 7: Deployment Manifests

### Webhook Deployment

```yaml
# config/webhook-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: admission-webhook
  namespace: admission-webhook
  labels:
    app: admission-webhook
    version: "1.0.0"
spec:
  replicas: 3
  selector:
    matchLabels:
      app: admission-webhook
  template:
    metadata:
      labels:
        app: admission-webhook
        version: "1.0.0"
    spec:
      serviceAccountName: admission-webhook
      # Spread across nodes for availability
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: admission-webhook
      containers:
        - name: webhook
          image: registry.company.internal/admission-webhook:1.0.0
          args:
            - --cert-dir=/tmp/k8s-webhook-server/serving-certs
            - --port=9443
            - --metrics-bind-address=:8080
            - --health-probe-bind-address=:8081
            - --leader-elect=false
          ports:
            - name: webhook
              containerPort: 9443
              protocol: TCP
            - name: metrics
              containerPort: 8080
              protocol: TCP
            - name: healthz
              containerPort: 8081
              protocol: TCP
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
              port: 8081
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8081
            initialDelaySeconds: 15
            periodSeconds: 20
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            runAsNonRoot: true
            runAsUser: 65534
            capabilities:
              drop:
                - ALL
          volumeMounts:
            - name: webhook-tls
              mountPath: /tmp/k8s-webhook-server/serving-certs
              readOnly: true
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: webhook-tls
          secret:
            secretName: admission-webhook-tls-secret
        - name: tmp
          emptyDir: {}
```

### Service and RBAC

```yaml
# config/webhook-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: admission-webhook
  namespace: admission-webhook
spec:
  selector:
    app: admission-webhook
  ports:
    - name: https
      port: 443
      targetPort: 9443
      protocol: TCP
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: admission-webhook
  namespace: admission-webhook
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: admission-webhook
rules:
  - apiGroups: [""]
    resources: ["pods", "namespaces", "configmaps"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "replicasets", "statefulsets"]
    verbs: ["get", "list", "watch"]
  # Required for leader election (if enabled)
  - apiGroups: ["coordination.k8s.io"]
    resources: ["leases"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: admission-webhook
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: admission-webhook
subjects:
  - kind: ServiceAccount
    name: admission-webhook
    namespace: admission-webhook
```

### PodDisruptionBudget

```yaml
# Ensure at least 2 webhook replicas are always available
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: admission-webhook-pdb
  namespace: admission-webhook
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: admission-webhook
```

---

## Section 8: Dockerfile

```dockerfile
# Dockerfile
# Stage 1: Build
FROM golang:1.22-alpine AS builder

RUN apk add --no-cache git ca-certificates

WORKDIR /workspace

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -ldflags="-w -s" \
    -o /workspace/admission-webhook \
    ./cmd/webhook/

# Stage 2: Runtime
FROM gcr.io/distroless/static:nonroot

COPY --from=builder /workspace/admission-webhook /admission-webhook

USER 65534:65534

ENTRYPOINT ["/admission-webhook"]
```

---

## Section 9: Testing Strategies

### Unit Tests for Validator Logic

```go
// pkg/validators/pod_validator_test.go
package validators_test

import (
    "testing"

    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/resource"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

    "github.com/company/admission-webhook/pkg/validators"
)

func TestValidateResourceLimits(t *testing.T) {
    v := &validators.PodValidator{}

    tests := []struct {
        name      string
        pod       *corev1.Pod
        expectErr bool
    }{
        {
            name: "pod with complete limits passes",
            pod: podWithLimits("500m", "256Mi"),
            expectErr: false,
        },
        {
            name: "pod without CPU limit fails",
            pod: podWithMemoryLimitOnly("256Mi"),
            expectErr: true,
        },
        {
            name: "pod without memory limit fails",
            pod: podWithCPULimitOnly("500m"),
            expectErr: true,
        },
        {
            name: "pod with no limits fails",
            pod: podWithNoLimits(),
            expectErr: true,
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            errs := v.ValidateResourceLimits(tt.pod)
            if tt.expectErr && len(errs) == 0 {
                t.Error("expected validation errors but got none")
            }
            if !tt.expectErr && len(errs) > 0 {
                t.Errorf("expected no errors but got: %v", errs)
            }
        })
    }
}

func podWithLimits(cpu, memory string) *corev1.Pod {
    return &corev1.Pod{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "test-pod",
            Namespace: "default",
            Labels: map[string]string{
                "app":     "test",
                "version": "v1",
                "team":    "platform",
            },
        },
        Spec: corev1.PodSpec{
            Containers: []corev1.Container{
                {
                    Name:  "app",
                    Image: "nginx:1.25",
                    Resources: corev1.ResourceRequirements{
                        Limits: corev1.ResourceList{
                            corev1.ResourceCPU:    resource.MustParse(cpu),
                            corev1.ResourceMemory: resource.MustParse(memory),
                        },
                    },
                },
            },
        },
    }
}

func podWithNoLimits() *corev1.Pod {
    return &corev1.Pod{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "test-pod",
            Namespace: "default",
        },
        Spec: corev1.PodSpec{
            Containers: []corev1.Container{
                {
                    Name:  "app",
                    Image: "nginx:1.25",
                },
            },
        },
    }
}
```

### Integration Tests with envtest

`controller-runtime`'s `envtest` package spins up a real API server and etcd for integration testing without a full cluster.

```go
// pkg/validators/integration_test.go
package validators_test

import (
    "context"
    "path/filepath"
    "testing"

    admissionv1 "k8s.io/api/admission/v1"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "sigs.k8s.io/controller-runtime/pkg/envtest"
    "sigs.k8s.io/controller-runtime/pkg/webhook/admission"
)

func TestPodValidatorIntegration(t *testing.T) {
    testEnv := &envtest.Environment{
        CRDDirectoryPaths: []string{filepath.Join("..", "..", "config", "crd")},
    }

    cfg, err := testEnv.Start()
    if err != nil {
        t.Fatalf("failed to start test environment: %v", err)
    }
    defer testEnv.Stop()

    scheme := runtime.NewScheme()
    _ = corev1.AddToScheme(scheme)

    decoder := admission.NewDecoder(scheme)
    v := &validators.PodValidator{
        Log: logr.Discard(),
    }

    // Build a fake AdmissionRequest for a pod without limits
    pod := &corev1.Pod{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "test-pod",
            Namespace: "default",
        },
        Spec: corev1.PodSpec{
            Containers: []corev1.Container{
                {Name: "app", Image: "nginx:1.25"},
            },
        },
    }

    podJSON, _ := json.Marshal(pod)
    req := admission.Request{
        AdmissionRequest: admissionv1.AdmissionRequest{
            Operation: admissionv1.Create,
            Object: runtime.RawExtension{
                Raw: podJSON,
            },
            Namespace: "default",
            Name:      "test-pod",
        },
    }

    resp := v.Handle(context.Background(), req)

    if resp.Allowed {
        t.Error("expected pod without limits to be denied")
    }
    if resp.Result == nil || resp.Result.Message == "" {
        t.Error("expected a denial message")
    }
}
```

### Smoke Tests Against a Real Cluster

```bash
# Create a test namespace
kubectl create namespace webhook-test

# Annotate namespace to NOT skip validation
kubectl label namespace webhook-test environment=production

# Test 1: Pod without resource limits should be denied
cat <<'EOF' | kubectl apply -n webhook-test -f - && echo "FAIL: should have been denied" || echo "PASS: pod correctly denied"
apiVersion: v1
kind: Pod
metadata:
  name: test-no-limits
  labels:
    app: test
    version: v1
    team: platform
spec:
  containers:
    - name: app
      image: nginx:1.25
EOF

# Test 2: Pod with :latest tag should be denied
cat <<'EOF' | kubectl apply -n webhook-test -f - && echo "FAIL: should have been denied" || echo "PASS: pod correctly denied"
apiVersion: v1
kind: Pod
metadata:
  name: test-latest-tag
  labels:
    app: test
    version: v1
    team: platform
spec:
  containers:
    - name: app
      image: nginx:latest
      resources:
        limits:
          cpu: "500m"
          memory: "256Mi"
EOF

# Test 3: Valid pod should be allowed
cat <<'EOF' | kubectl apply -n webhook-test -f - && echo "PASS: valid pod created" || echo "FAIL: valid pod was denied"
apiVersion: v1
kind: Pod
metadata:
  name: test-valid
  labels:
    app: test
    version: v1
    team: platform
spec:
  containers:
    - name: app
      image: nginx:1.25
      resources:
        requests:
          cpu: "100m"
          memory: "128Mi"
        limits:
          cpu: "500m"
          memory: "256Mi"
EOF

# Clean up
kubectl delete namespace webhook-test
```

---

## Section 10: Failure Policies and Timeout Considerations

### Choosing Between Fail and Ignore

The `failurePolicy` field in a `WebhookConfiguration` controls behavior when the webhook server is unreachable or returns an error.

```
failurePolicy: Fail    — Reject the admission request if the webhook is unavailable
                         Use for security-critical validation (prevents bypass on outage)

failurePolicy: Ignore  — Allow the admission request if the webhook is unavailable
                         Use for mutation webhooks and non-critical validation
                         (cluster remains functional during webhook outages)
```

### Timeout Configuration

Kubernetes enforces a maximum webhook timeout of 30 seconds (API server enforces this). The recommended production timeout is 10-15 seconds to leave headroom for API server processing.

```yaml
# Recommended timeout settings
webhooks:
  - name: pod.validation.admission-webhook.company.io
    timeoutSeconds: 10    # Validation: use Fail policy, shorter timeout
    failurePolicy: Fail

  - name: pod.mutation.admission-webhook.company.io
    timeoutSeconds: 15    # Mutation: use Ignore policy, slightly longer timeout
    failurePolicy: Ignore
```

### Context Propagation for Timeouts

```go
// Always respect the context deadline in webhook handlers
func (v *PodValidator) Handle(ctx context.Context, req admission.Request) admission.Response {
    // Create a child context with an explicit deadline
    // that leaves time for response serialization
    ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
    defer cancel()

    // Pass ctx to any external service calls
    result, err := v.externalScanner.Scan(ctx, req.Object.Raw)
    if err != nil {
        if errors.Is(err, context.DeadlineExceeded) {
            // Return a failure-open response on timeout
            // to prevent cluster disruption
            v.Log.Error(err, "external scanner timed out, allowing admission")
            return admission.Allowed("scanner timeout — admission allowed by policy")
        }
        return admission.Errored(http.StatusInternalServerError, err)
    }
    // ... process result
}
```

---

## Section 11: Metrics and Observability

### Adding Prometheus Metrics

```go
// pkg/metrics/metrics.go
package metrics

import (
    "github.com/prometheus/client_golang/prometheus"
    "sigs.k8s.io/controller-runtime/pkg/metrics"
)

var (
    WebhookRequestsTotal = prometheus.NewCounterVec(
        prometheus.CounterOpts{
            Name: "admission_webhook_requests_total",
            Help: "Total number of admission webhook requests processed",
        },
        []string{"webhook", "operation", "result"},
    )

    WebhookDuration = prometheus.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "admission_webhook_duration_seconds",
            Help:    "Duration of admission webhook handler execution",
            Buckets: prometheus.DefBuckets,
        },
        []string{"webhook", "operation"},
    )

    WebhookValidationFailures = prometheus.NewCounterVec(
        prometheus.CounterOpts{
            Name: "admission_webhook_validation_failures_total",
            Help: "Total number of validation failures by rule",
        },
        []string{"webhook", "rule", "namespace"},
    )
)

func init() {
    metrics.Registry.MustRegister(
        WebhookRequestsTotal,
        WebhookDuration,
        WebhookValidationFailures,
    )
}
```

```go
// Instrument the handler
func (v *PodValidator) Handle(ctx context.Context, req admission.Request) admission.Response {
    start := time.Now()
    operation := string(req.Operation)

    defer func() {
        duration := time.Since(start).Seconds()
        metrics.WebhookDuration.
            WithLabelValues("pod-validator", operation).
            Observe(duration)
    }()

    // ... validation logic ...

    if len(allErrs) > 0 {
        for _, err := range allErrs {
            metrics.WebhookValidationFailures.
                WithLabelValues("pod-validator", err.Field, req.Namespace).
                Inc()
        }
        metrics.WebhookRequestsTotal.
            WithLabelValues("pod-validator", operation, "denied").
            Inc()
        return admission.Denied(allErrs.ToAggregate().Error())
    }

    metrics.WebhookRequestsTotal.
        WithLabelValues("pod-validator", operation, "allowed").
        Inc()
    return admission.Allowed("passed all checks")
}
```

### ServiceMonitor for Webhook Metrics

```yaml
# config/service-monitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: admission-webhook
  namespace: admission-webhook
  labels:
    release: kube-prometheus-stack
spec:
  selector:
    matchLabels:
      app: admission-webhook
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
```

---

## Section 12: Production Readiness Checklist

### Pre-Deployment Verification

```bash
# 1. Verify TLS certificate is valid
kubectl get secret admission-webhook-tls-secret \
  -n admission-webhook \
  -o jsonpath='{.data.tls\.crt}' | \
  base64 -d | openssl x509 -noout -dates -subject

# 2. Verify CA bundle in WebhookConfiguration matches the cert
kubectl get validatingwebhookconfiguration admission-webhook-validation \
  -o jsonpath='{.webhooks[0].clientConfig.caBundle}' | \
  base64 -d | openssl x509 -noout -subject

# 3. Check that webhook replicas are spread across nodes
kubectl get pods -n admission-webhook -o wide

# 4. Verify PDB is in place
kubectl get pdb -n admission-webhook

# 5. Test webhook connectivity from the API server perspective
kubectl get --raw /apis/admissionregistration.k8s.io/v1/validatingwebhookconfigurations \
  | jq '.items[] | select(.metadata.name == "admission-webhook-validation") | .webhooks[0].clientConfig'

# 6. Trigger a test admission and observe webhook logs
kubectl run test-probe \
  --image=nginx:1.25 \
  --restart=Never \
  --namespace=default \
  --dry-run=server 2>&1
kubectl logs -n admission-webhook \
  -l app=admission-webhook \
  --tail=20 | grep test-probe
```

### Graceful Shutdown Configuration

```go
// In main.go — configure graceful shutdown
mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
    // ...
    // Allow 30 seconds for in-flight requests to complete
    GracefulShutdownTimeout: &[]time.Duration{30 * time.Second}[0],
})
```

```yaml
# In Deployment spec — give the container time to drain
spec:
  template:
    spec:
      terminationGracePeriodSeconds: 45
      containers:
        - name: webhook
          lifecycle:
            preStop:
              exec:
                # Brief sleep allows the load balancer to drain connections
                command: ["/bin/sh", "-c", "sleep 5"]
```

---

Custom admission webhooks give platform teams the full power of Go for expressing enforcement and mutation logic that cannot be captured in declarative policy languages. The controller-runtime framework reduces boilerplate to a minimum, while cert-manager handles TLS certificate lifecycle automatically. With proper failure policies, timeout configuration, metrics instrumentation, and a PodDisruptionBudget, a custom webhook can enforce enterprise requirements without introducing cluster instability.
