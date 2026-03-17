---
title: "Kubernetes Admission Webhooks: Building Custom Validation and Mutation"
date: 2027-12-24T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Admission Webhooks", "Go", "Validation", "Mutation", "kubebuilder", "Security", "Policy"]
categories:
- Kubernetes
- Go
- Platform Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to building Kubernetes admission webhooks in Go covering ValidatingAdmissionWebhook vs MutatingAdmissionWebhook, certificate management, failure policies, sidecar injection patterns, resource defaulting, testing with envtest, and kubebuilder webhook scaffolding."
more_link: "yes"
url: "/kubernetes-admission-webhooks-development-guide/"
---

Admission webhooks intercept every Kubernetes API request that creates, updates, or deletes a resource and give external code the ability to validate or mutate the resource before it persists to etcd. When policy engines like Kyverno or OPA Gatekeeper do not cover a use case, a custom admission webhook is the correct solution: inject environment-specific sidecars, enforce naming conventions, validate cross-resource dependencies, or default fields based on cluster-specific logic. This guide builds a complete production webhook server in Go using kubebuilder scaffolding, with TLS certificate management, failure policies, and envtest-based testing.

<!--more-->

# Kubernetes Admission Webhooks: Building Custom Validation and Mutation

## Admission Controller Flow

```
kubectl apply -f deployment.yaml
         │
         ▼
  kube-apiserver
         │
         ├──► Authentication
         ├──► Authorization (RBAC)
         ├──► MutatingAdmissionWebhook ◄─── External webhook server
         │       (modifies object)          (adds labels, injects sidecars)
         ├──► Object schema validation
         ├──► ValidatingAdmissionWebhook ◄── External webhook server
         │       (approve/reject)            (cross-field validation, policy)
         └──► Persist to etcd
```

Two webhook types:

- **MutatingAdmissionWebhook**: Runs first; can modify the incoming object. Multiple webhooks can mutate the same object sequentially, so mutations should be idempotent.
- **ValidatingAdmissionWebhook**: Runs after all mutations; can only approve or reject. Cannot modify the object.

## Use Cases for Custom Webhooks

| Use Case | Webhook Type | Why Not Kyverno/OPA |
|----------|-------------|---------------------|
| Vault sidecar injection | Mutating | Complex conditional injection logic |
| Dynamic label generation | Mutating | Labels derived from external API calls |
| Cross-namespace dependency validation | Validating | Requires cross-resource queries |
| Custom admission from internal CMDB | Validating | Integration with internal systems |
| Resource defaulting from team config | Mutating | Defaults from database/ConfigMap |

## Project Setup with kubebuilder

```bash
# Install kubebuilder
curl -L -o kubebuilder \
  https://github.com/kubernetes-sigs/kubebuilder/releases/download/v4.3.1/kubebuilder_linux_amd64
chmod +x kubebuilder
sudo mv kubebuilder /usr/local/bin/

# Initialize project
mkdir platform-admission-webhook
cd platform-admission-webhook
go mod init github.com/example-org/platform-admission-webhook

kubebuilder init \
  --domain example.com \
  --repo github.com/example-org/platform-admission-webhook

# Scaffold webhooks for core types
kubebuilder create webhook \
  --group core \
  --version v1 \
  --kind Pod \
  --defaulting \
  --programmatic-validation
```

Generated project structure:

```
platform-admission-webhook/
├── cmd/
│   └── main.go
├── internal/
│   └── webhook/
│       └── v1/
│           └── pod_webhook.go
├── config/
│   ├── certmanager/
│   ├── webhook/
│   │   ├── manifests.yaml      # WebhookConfiguration resources
│   │   └── service.yaml
│   └── default/
├── Dockerfile
└── go.mod
```

## Webhook Server in Go

### Pod Mutating Webhook: Sidecar Injection

```go
// internal/webhook/v1/pod_webhook.go
package v1

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"

    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/runtime"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    logf "sigs.k8s.io/controller-runtime/pkg/log"
    "sigs.k8s.io/controller-runtime/pkg/webhook"
    "sigs.k8s.io/controller-runtime/pkg/webhook/admission"
)

var podLog = logf.Log.WithName("pod-webhook")

// PodMutator handles sidecar injection and resource defaulting
type PodMutator struct {
    Client  client.Client
    decoder admission.Decoder
}

// SetupWebhookWithManager registers the webhook with the manager
func (m *PodMutator) SetupWebhookWithManager(mgr ctrl.Manager) error {
    return ctrl.NewWebhookManagedBy(mgr).
        For(&corev1.Pod{}).
        WithDefaulter(m).
        Complete()
}

func (m *PodMutator) InjectDecoder(d admission.Decoder) error {
    m.decoder = d
    return nil
}

// Default implements webhook.Defaulter - called for mutations
func (m *PodMutator) Default(ctx context.Context, obj runtime.Object) error {
    pod, ok := obj.(*corev1.Pod)
    if !ok {
        return fmt.Errorf("expected a Pod but got %T", obj)
    }

    log := podLog.WithValues("pod", pod.Name, "namespace", pod.Namespace)
    log.Info("Mutating pod")

    // Inject observability sidecar if annotation is present
    if err := m.injectObservabilitySidecar(pod); err != nil {
        return err
    }

    // Add standard labels if missing
    m.addStandardLabels(pod)

    // Set default resource requests if not specified
    m.setDefaultResourceRequests(pod)

    return nil
}

const observabilitySidecarAnnotation = "platform.example.com/inject-observability"

func (m *PodMutator) injectObservabilitySidecar(pod *corev1.Pod) error {
    // Check if already injected (idempotency)
    for _, container := range pod.Spec.Containers {
        if container.Name == "otel-collector-sidecar" {
            return nil
        }
    }

    // Check if injection is requested
    val, ok := pod.Annotations[observabilitySidecarAnnotation]
    if !ok || val != "true" {
        return nil
    }

    sidecar := corev1.Container{
        Name:  "otel-collector-sidecar",
        Image: "otel/opentelemetry-collector-contrib:0.110.0",
        Args: []string{
            "--config=/etc/otel/config.yaml",
        },
        Resources: corev1.ResourceRequirements{
            Requests: corev1.ResourceList{
                corev1.ResourceCPU:    mustParseQuantity("50m"),
                corev1.ResourceMemory: mustParseQuantity("64Mi"),
            },
            Limits: corev1.ResourceList{
                corev1.ResourceCPU:    mustParseQuantity("200m"),
                corev1.ResourceMemory: mustParseQuantity("256Mi"),
            },
        },
        VolumeMounts: []corev1.VolumeMount{
            {
                Name:      "otel-config",
                MountPath: "/etc/otel",
                ReadOnly:  true,
            },
        },
        Ports: []corev1.ContainerPort{
            {Name: "otlp-grpc", ContainerPort: 4317, Protocol: corev1.ProtocolTCP},
            {Name: "otlp-http", ContainerPort: 4318, Protocol: corev1.ProtocolTCP},
        },
        Env: []corev1.EnvVar{
            {
                Name: "POD_NAMESPACE",
                ValueFrom: &corev1.EnvVarSource{
                    FieldRef: &corev1.ObjectFieldSelector{
                        FieldPath: "metadata.namespace",
                    },
                },
            },
            {
                Name: "POD_NAME",
                ValueFrom: &corev1.EnvVarSource{
                    FieldRef: &corev1.ObjectFieldSelector{
                        FieldPath: "metadata.name",
                    },
                },
            },
        },
    }

    pod.Spec.Containers = append(pod.Spec.Containers, sidecar)

    // Add config volume if not present
    volumeExists := false
    for _, vol := range pod.Spec.Volumes {
        if vol.Name == "otel-config" {
            volumeExists = true
            break
        }
    }

    if !volumeExists {
        pod.Spec.Volumes = append(pod.Spec.Volumes, corev1.Volume{
            Name: "otel-config",
            VolumeSource: corev1.VolumeSource{
                ConfigMap: &corev1.ConfigMapVolumeSource{
                    LocalObjectReference: corev1.LocalObjectReference{
                        Name: "otel-collector-sidecar-config",
                    },
                },
            },
        })
    }

    podLog.Info("Injected observability sidecar", "pod", pod.Name)
    return nil
}

func (m *PodMutator) addStandardLabels(pod *corev1.Pod) {
    if pod.Labels == nil {
        pod.Labels = make(map[string]string)
    }

    // Add platform-managed-by label
    if _, ok := pod.Labels["platform.example.com/managed"]; !ok {
        pod.Labels["platform.example.com/managed"] = "true"
    }

    // Propagate team label from namespace if not set
    if _, ok := pod.Labels["team"]; !ok {
        if team, ok := pod.Annotations["platform.example.com/team"]; ok {
            pod.Labels["team"] = team
        }
    }
}

func (m *PodMutator) setDefaultResourceRequests(pod *corev1.Pod) {
    for i := range pod.Spec.Containers {
        container := &pod.Spec.Containers[i]

        if container.Resources.Requests == nil {
            container.Resources.Requests = corev1.ResourceList{}
        }
        if container.Resources.Limits == nil {
            container.Resources.Limits = corev1.ResourceList{}
        }

        if _, ok := container.Resources.Requests[corev1.ResourceCPU]; !ok {
            container.Resources.Requests[corev1.ResourceCPU] = mustParseQuantity("100m")
        }
        if _, ok := container.Resources.Requests[corev1.ResourceMemory]; !ok {
            container.Resources.Requests[corev1.ResourceMemory] = mustParseQuantity("128Mi")
        }
        if _, ok := container.Resources.Limits[corev1.ResourceMemory]; !ok {
            container.Resources.Limits[corev1.ResourceMemory] = mustParseQuantity("512Mi")
        }
    }
}
```

### Pod Validating Webhook

```go
// internal/webhook/v1/pod_validator.go
package v1

import (
    "context"
    "fmt"
    "strings"

    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/apimachinery/pkg/util/validation/field"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    logf "sigs.k8s.io/controller-runtime/pkg/log"
)

var podValidatorLog = logf.Log.WithName("pod-validator")

type PodValidator struct {
    Client client.Client
}

func (v *PodValidator) SetupWebhookWithManager(mgr ctrl.Manager) error {
    return ctrl.NewWebhookManagedBy(mgr).
        For(&corev1.Pod{}).
        WithValidator(v).
        Complete()
}

// ValidateCreate validates a new Pod
func (v *PodValidator) ValidateCreate(ctx context.Context, obj runtime.Object) (warnings admission.Warnings, err error) {
    pod, ok := obj.(*corev1.Pod)
    if !ok {
        return nil, fmt.Errorf("expected a Pod but got %T", obj)
    }
    return v.validate(ctx, pod)
}

// ValidateUpdate validates an updated Pod
func (v *PodValidator) ValidateUpdate(ctx context.Context, oldObj, newObj runtime.Object) (warnings admission.Warnings, err error) {
    pod, ok := newObj.(*corev1.Pod)
    if !ok {
        return nil, fmt.Errorf("expected a Pod but got %T", newObj)
    }
    return v.validate(ctx, pod)
}

// ValidateDelete validates Pod deletion (usually passthrough)
func (v *PodValidator) ValidateDelete(ctx context.Context, obj runtime.Object) (warnings admission.Warnings, err error) {
    return nil, nil
}

func (v *PodValidator) validate(ctx context.Context, pod *corev1.Pod) (admission.Warnings, error) {
    var allErrs field.ErrorList
    var warnings admission.Warnings

    containersPath := field.NewPath("spec").Child("containers")

    for i, container := range pod.Spec.Containers {
        containerPath := containersPath.Index(i)

        // Reject privileged containers outside allowed namespaces
        if container.SecurityContext != nil &&
            container.SecurityContext.Privileged != nil &&
            *container.SecurityContext.Privileged {
            if pod.Namespace != "kube-system" && pod.Namespace != "gpu-operator" {
                allErrs = append(allErrs, field.Forbidden(
                    containerPath.Child("securityContext", "privileged"),
                    "privileged containers are not allowed outside kube-system and gpu-operator",
                ))
            }
        }

        // Reject containers running as root (UID 0) without explicit override
        if container.SecurityContext != nil &&
            container.SecurityContext.RunAsUser != nil &&
            *container.SecurityContext.RunAsUser == 0 {
            if _, ok := pod.Annotations["platform.example.com/allow-root"]; !ok {
                allErrs = append(allErrs, field.Forbidden(
                    containerPath.Child("securityContext", "runAsUser"),
                    "running as root (UID 0) requires annotation platform.example.com/allow-root=true",
                ))
            }
        }

        // Warn on missing resource limits (do not block)
        if container.Resources.Limits == nil {
            warnings = append(warnings, fmt.Sprintf(
                "container %s has no resource limits set; this may cause OOM kills on the node",
                container.Name,
            ))
        }

        // Block host path mounts outside specific prefixes
        if err := v.validateVolumeMounts(pod, container, containerPath); err != nil {
            allErrs = append(allErrs, err...)
        }
    }

    // Validate required labels for production namespaces
    if isProductionNamespace(pod.Namespace) {
        if err := v.validateRequiredLabels(pod); err != nil {
            allErrs = append(allErrs, err...)
        }
    }

    if len(allErrs) > 0 {
        return warnings, allErrs.ToAggregate()
    }
    return warnings, nil
}

func (v *PodValidator) validateVolumeMounts(pod *corev1.Pod, container corev1.Container, path *field.Path) field.ErrorList {
    var errs field.ErrorList

    // Build set of hostPath volumes
    hostPaths := make(map[string]string)
    for _, vol := range pod.Spec.Volumes {
        if vol.HostPath != nil {
            hostPaths[vol.Name] = vol.HostPath.Path
        }
    }

    allowedHostPathPrefixes := []string{
        "/var/log/",
        "/tmp/",
        "/run/containerd/",
    }

    for i, mount := range container.VolumeMounts {
        hostPath, ok := hostPaths[mount.Name]
        if !ok {
            continue
        }

        allowed := false
        for _, prefix := range allowedHostPathPrefixes {
            if strings.HasPrefix(hostPath, prefix) {
                allowed = true
                break
            }
        }

        if !allowed {
            errs = append(errs, field.Forbidden(
                path.Child("volumeMounts").Index(i),
                fmt.Sprintf("hostPath mount %s (%s) is not in the allowed prefix list", mount.Name, hostPath),
            ))
        }
    }
    return errs
}

func (v *PodValidator) validateRequiredLabels(pod *corev1.Pod) field.ErrorList {
    var errs field.ErrorList
    requiredLabels := []string{"team", "product", "environment"}

    for _, label := range requiredLabels {
        if _, ok := pod.Labels[label]; !ok {
            errs = append(errs, field.Required(
                field.NewPath("metadata").Child("labels").Key(label),
                fmt.Sprintf("label %q is required in production namespaces", label),
            ))
        }
    }
    return errs
}

func isProductionNamespace(ns string) bool {
    productionNamespaces := map[string]bool{
        "payments": true, "identity": true, "api-gateway": true,
    }
    return productionNamespaces[ns]
}
```

## Certificate Management

### cert-manager Integration

The webhook server requires TLS. cert-manager automates certificate provisioning and rotation:

```yaml
# config/certmanager/certificate.yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: platform-webhook-cert
  namespace: platform-webhooks
spec:
  secretName: platform-webhook-tls
  duration: 8760h    # 1 year
  renewBefore: 720h  # Renew 30 days before expiry
  dnsNames:
    - platform-webhook-service.platform-webhooks.svc
    - platform-webhook-service.platform-webhooks.svc.cluster.local
  issuerRef:
    name: cluster-issuer-internal-ca
    kind: ClusterIssuer
    group: cert-manager.io
```

Inject the CA bundle into the WebhookConfiguration automatically with cert-manager's cainjector:

```yaml
# config/webhook/manifests.yaml
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: platform-mutating-webhook
  annotations:
    cert-manager.io/inject-ca-from: platform-webhooks/platform-webhook-cert
spec:
  webhooks:
    - name: pod.mutation.platform.example.com
      admissionReviewVersions: ["v1"]
      clientConfig:
        service:
          name: platform-webhook-service
          namespace: platform-webhooks
          path: "/mutate-v1-pod"
          port: 443
        # caBundle injected by cert-manager cainjector
      failurePolicy: Fail
      matchPolicy: Equivalent
      namespaceSelector:
        matchExpressions:
          - key: kubernetes.io/metadata.name
            operator: NotIn
            values:
              - kube-system
              - kyverno
              - cert-manager
              - platform-webhooks
      objectSelector:
        matchExpressions:
          - key: platform.example.com/skip-webhook
            operator: DoesNotExist
      rules:
        - apiGroups: [""]
          apiVersions: ["v1"]
          operations: ["CREATE", "UPDATE"]
          resources: ["pods"]
          scope: Namespaced
      sideEffects: None
      timeoutSeconds: 10
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: platform-validating-webhook
  annotations:
    cert-manager.io/inject-ca-from: platform-webhooks/platform-webhook-cert
spec:
  webhooks:
    - name: pod.validation.platform.example.com
      admissionReviewVersions: ["v1"]
      clientConfig:
        service:
          name: platform-webhook-service
          namespace: platform-webhooks
          path: "/validate-v1-pod"
          port: 443
      failurePolicy: Fail
      matchPolicy: Equivalent
      namespaceSelector:
        matchExpressions:
          - key: kubernetes.io/metadata.name
            operator: NotIn
            values:
              - kube-system
              - kyverno
              - cert-manager
              - platform-webhooks
      rules:
        - apiGroups: [""]
          apiVersions: ["v1"]
          operations: ["CREATE", "UPDATE"]
          resources: ["pods"]
          scope: Namespaced
      sideEffects: None
      timeoutSeconds: 10
```

## Failure Policy

`failurePolicy` controls what happens when the webhook server is unreachable:

- `Fail`: Reject the admission request. Use for security-critical webhooks (signature verification, registry allowlists).
- `Ignore`: Allow the admission request. Use for non-critical mutations (label injection, metric annotations).

Best practice: Use `Fail` for validating webhooks and `Ignore` for non-security mutations in development clusters. Both should use `Fail` in production with High Availability webhook deployments.

Webhook HA deployment:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: platform-webhook
  namespace: platform-webhooks
spec:
  replicas: 3
  selector:
    matchLabels:
      app: platform-webhook
  template:
    metadata:
      labels:
        app: platform-webhook
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: platform-webhook
              topologyKey: kubernetes.io/hostname
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: platform-webhook
      containers:
        - name: webhook
          image: registry.internal.example.com/platform/admission-webhook:1.0.0
          ports:
            - containerPort: 9443
              name: webhook-server
          volumeMounts:
            - name: cert
              mountPath: /tmp/k8s-webhook-server/serving-certs
              readOnly: true
          resources:
            requests:
              cpu: "100m"
              memory: "128Mi"
            limits:
              cpu: "500m"
              memory: "512Mi"
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
      volumes:
        - name: cert
          secret:
            secretName: platform-webhook-tls
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: platform-webhook-pdb
  namespace: platform-webhooks
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: platform-webhook
```

## Testing with envtest

```go
// internal/webhook/v1/pod_webhook_test.go
package v1_test

import (
    "context"
    "path/filepath"
    "testing"

    . "github.com/onsi/ginkgo/v2"
    . "github.com/onsi/gomega"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes/scheme"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/envtest"
    webhookv1 "github.com/example-org/platform-admission-webhook/internal/webhook/v1"
)

var (
    cfg       *rest.Config
    k8sClient client.Client
    testEnv   *envtest.Environment
    ctx       context.Context
    cancel    context.CancelFunc
)

func TestWebhooks(t *testing.T) {
    RegisterFailHandler(Fail)
    RunSpecs(t, "Admission Webhook Suite")
}

var _ = BeforeSuite(func() {
    ctx, cancel = context.WithCancel(context.TODO())

    testEnv = &envtest.Environment{
        CRDDirectoryPaths:     []string{filepath.Join("..", "..", "..", "config", "crd", "bases")},
        ErrorIfCRDPathMissing: false,
        WebhookInstallOptions: envtest.WebhookInstallOptions{
            Paths: []string{filepath.Join("..", "..", "..", "config", "webhook")},
        },
    }

    var err error
    cfg, err = testEnv.Start()
    Expect(err).NotTo(HaveOccurred())
    Expect(cfg).NotTo(BeNil())

    mgr, err := ctrl.NewManager(cfg, ctrl.Options{
        Scheme:         scheme.Scheme,
        LeaderElection: false,
        WebhookServer: webhook.NewServer(webhook.Options{
            Port:    testEnv.WebhookInstallOptions.LocalServingPort,
            Host:    testEnv.WebhookInstallOptions.LocalServingHost,
            CertDir: testEnv.WebhookInstallOptions.LocalServingCertDir,
        }),
    })
    Expect(err).NotTo(HaveOccurred())

    mutator := &webhookv1.PodMutator{Client: mgr.GetClient()}
    err = mutator.SetupWebhookWithManager(mgr)
    Expect(err).NotTo(HaveOccurred())

    validator := &webhookv1.PodValidator{Client: mgr.GetClient()}
    err = validator.SetupWebhookWithManager(mgr)
    Expect(err).NotTo(HaveOccurred())

    go func() {
        defer GinkgoRecover()
        err = mgr.Start(ctx)
        Expect(err).NotTo(HaveOccurred())
    }()

    k8sClient, err = client.New(cfg, client.Options{Scheme: scheme.Scheme})
    Expect(err).NotTo(HaveOccurred())

    // Create test namespace
    ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "payments"}}
    Expect(k8sClient.Create(ctx, ns)).To(Succeed())
})

var _ = AfterSuite(func() {
    cancel()
    Expect(testEnv.Stop()).To(Succeed())
})

var _ = Describe("Pod Mutation Webhook", func() {
    Context("when a pod has the observability injection annotation", func() {
        It("should inject the otel-collector sidecar", func() {
            pod := &corev1.Pod{
                ObjectMeta: metav1.ObjectMeta{
                    Name:      "test-pod-inject",
                    Namespace: "payments",
                    Annotations: map[string]string{
                        "platform.example.com/inject-observability": "true",
                    },
                    Labels: map[string]string{
                        "team":        "payments-team",
                        "product":     "payment-service",
                        "environment": "production",
                    },
                },
                Spec: corev1.PodSpec{
                    Containers: []corev1.Container{
                        {
                            Name:  "app",
                            Image: "registry.internal.example.com/payments/payment-service:v1.0.0",
                        },
                    },
                },
            }

            Expect(k8sClient.Create(ctx, pod)).To(Succeed())

            fetchedPod := &corev1.Pod{}
            Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(pod), fetchedPod)).To(Succeed())

            containerNames := make([]string, len(fetchedPod.Spec.Containers))
            for i, c := range fetchedPod.Spec.Containers {
                containerNames[i] = c.Name
            }
            Expect(containerNames).To(ContainElement("otel-collector-sidecar"))
        })
    })

    Context("when a pod does not have the observability annotation", func() {
        It("should not inject the sidecar", func() {
            pod := &corev1.Pod{
                ObjectMeta: metav1.ObjectMeta{
                    Name:      "test-pod-no-inject",
                    Namespace: "payments",
                    Labels: map[string]string{
                        "team":        "payments-team",
                        "product":     "payment-service",
                        "environment": "production",
                    },
                },
                Spec: corev1.PodSpec{
                    Containers: []corev1.Container{
                        {Name: "app", Image: "registry.internal.example.com/payments/service:v1.0.0"},
                    },
                },
            }

            Expect(k8sClient.Create(ctx, pod)).To(Succeed())

            fetchedPod := &corev1.Pod{}
            Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(pod), fetchedPod)).To(Succeed())

            Expect(fetchedPod.Spec.Containers).To(HaveLen(1))
        })
    })
})

var _ = Describe("Pod Validation Webhook", func() {
    Context("when a pod requests privileged access outside allowed namespaces", func() {
        It("should reject the pod", func() {
            privileged := true
            pod := &corev1.Pod{
                ObjectMeta: metav1.ObjectMeta{
                    Name:      "privileged-pod",
                    Namespace: "payments",
                    Labels: map[string]string{
                        "team": "payments-team", "product": "test", "environment": "production",
                    },
                },
                Spec: corev1.PodSpec{
                    Containers: []corev1.Container{
                        {
                            Name:  "privileged-app",
                            Image: "registry.internal.example.com/test:latest",
                            SecurityContext: &corev1.SecurityContext{
                                Privileged: &privileged,
                            },
                        },
                    },
                },
            }

            err := k8sClient.Create(ctx, pod)
            Expect(err).To(HaveOccurred())
            Expect(err.Error()).To(ContainSubstring("privileged containers are not allowed"))
        })
    })

    Context("when a production pod is missing required labels", func() {
        It("should reject the pod", func() {
            pod := &corev1.Pod{
                ObjectMeta: metav1.ObjectMeta{
                    Name:      "unlabeled-pod",
                    Namespace: "payments",
                    // Missing required labels
                },
                Spec: corev1.PodSpec{
                    Containers: []corev1.Container{
                        {Name: "app", Image: "registry.internal.example.com/test:latest"},
                    },
                },
            }

            err := k8sClient.Create(ctx, pod)
            Expect(err).To(HaveOccurred())
            Expect(err.Error()).To(ContainSubstring("required in production namespaces"))
        })
    })
})
```

## Deployment and main.go

```go
// cmd/main.go
package main

import (
    "flag"
    "os"

    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/runtime"
    utilruntime "k8s.io/apimachinery/pkg/util/runtime"
    clientgoscheme "k8s.io/client-go/kubernetes/scheme"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/healthz"
    "sigs.k8s.io/controller-runtime/pkg/log/zap"
    "sigs.k8s.io/controller-runtime/pkg/metrics/server"
    "sigs.k8s.io/controller-runtime/pkg/webhook"
    webhookv1 "github.com/example-org/platform-admission-webhook/internal/webhook/v1"
)

var (
    scheme   = runtime.NewScheme()
    setupLog = ctrl.Log.WithName("setup")
)

func init() {
    utilruntime.Must(clientgoscheme.AddToScheme(scheme))
    utilruntime.Must(corev1.AddToScheme(scheme))
}

func main() {
    var metricsAddr string
    var probeAddr string
    var webhookPort int

    flag.StringVar(&metricsAddr, "metrics-bind-address", ":8080", "The address the metrics endpoint binds to.")
    flag.StringVar(&probeAddr, "health-probe-bind-address", ":8081", "The address the probe endpoint binds to.")
    flag.IntVar(&webhookPort, "webhook-port", 9443, "Admission webhook server port.")

    opts := zap.Options{Development: false}
    opts.BindFlags(flag.CommandLine)
    flag.Parse()

    ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))

    mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
        Scheme: scheme,
        Metrics: server.Options{
            BindAddress: metricsAddr,
        },
        HealthProbeBindAddress: probeAddr,
        WebhookServer: webhook.NewServer(webhook.Options{
            Port:    webhookPort,
            CertDir: "/tmp/k8s-webhook-server/serving-certs",
        }),
        LeaderElection: false,
    })
    if err != nil {
        setupLog.Error(err, "unable to start manager")
        os.Exit(1)
    }

    mutator := &webhookv1.PodMutator{Client: mgr.GetClient()}
    if err = mutator.SetupWebhookWithManager(mgr); err != nil {
        setupLog.Error(err, "unable to set up pod mutating webhook")
        os.Exit(1)
    }

    validator := &webhookv1.PodValidator{Client: mgr.GetClient()}
    if err = validator.SetupWebhookWithManager(mgr); err != nil {
        setupLog.Error(err, "unable to set up pod validating webhook")
        os.Exit(1)
    }

    if err = mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
        setupLog.Error(err, "unable to set up health check")
        os.Exit(1)
    }
    if err = mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
        setupLog.Error(err, "unable to set up ready check")
        os.Exit(1)
    }

    setupLog.Info("starting platform admission webhook manager")
    if err = mgr.Start(ctrl.SetupSignalHandler()); err != nil {
        setupLog.Error(err, "problem running manager")
        os.Exit(1)
    }
}
```

## Troubleshooting

### Webhook Not Being Called

```bash
# Check webhook registration
kubectl get mutatingwebhookconfigurations platform-mutating-webhook -o yaml | \
  grep -A 5 "caBundle"

# Verify service endpoints
kubectl get endpoints platform-webhook-service -n platform-webhooks

# Check webhook server logs
kubectl logs -n platform-webhooks deployment/platform-webhook | grep -i "error\|webhook"

# Test webhook manually
kubectl apply --dry-run=server -f test-pod.yaml
```

### TLS Certificate Issues

```bash
# Check cert-manager certificate status
kubectl describe certificate platform-webhook-cert -n platform-webhooks

# Verify secret has the certificate
kubectl get secret platform-webhook-tls -n platform-webhooks -o jsonpath='{.data}' | \
  jq 'keys'

# Check CA injection
kubectl get mutatingwebhookconfigurations platform-mutating-webhook \
  -o jsonpath='{.webhooks[0].clientConfig.caBundle}' | base64 -d | \
  openssl x509 -text -noout | grep -E "Issuer|Subject|Not After"
```

## Summary

Custom admission webhooks fill the gap when policy engines lack the expressiveness or external integration capability needed. Key production requirements:

1. Implement mutation and validation as separate webhook types with separate failure policies
2. Make mutation idempotent: check if the sidecar is already injected before injecting again
3. Deploy webhook servers with 3 replicas, anti-affinity, and a PodDisruptionBudget
4. Use cert-manager with cainjector to automate TLS provisioning and CA bundle injection
5. Set `timeoutSeconds: 10` or less to prevent blocked API server operations during outages
6. Use envtest for integration tests that exercise the full webhook flow without a live cluster
7. Configure `matchPolicy: Equivalent` so webhooks catch both direct and converted API requests
