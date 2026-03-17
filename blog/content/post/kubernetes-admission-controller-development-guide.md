---
title: "Kubernetes Admission Controller Development: Validating and Mutating Webhooks"
date: 2028-03-15T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Admission Controllers", "Webhooks", "Go", "controller-runtime", "cert-manager", "Security"]
categories: ["Kubernetes", "Development"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to building production-grade Kubernetes admission webhooks using Go and controller-runtime, covering ValidatingWebhookConfiguration, MutatingWebhookConfiguration, TLS management with cert-manager, failure policies, and testing with envtest."
more_link: "yes"
url: "/kubernetes-admission-controller-development-guide/"
---

Admission controllers are the enforcement layer that sits between the Kubernetes API server and the backing etcd store. Every resource write—create, update, delete—passes through the admission control chain before it is persisted. Building custom admission webhooks allows platform teams to enforce organizational policy, inject standard configuration, and prevent misconfigured workloads from reaching cluster nodes.

This guide walks through the full lifecycle: architectural decisions, Go implementation using controller-runtime, TLS certificate management via cert-manager, failure policy selection, namespace exclusion patterns, and a comprehensive testing strategy using envtest.

<!--more-->

## Admission Webhook Architecture

### Request Flow

When the API server receives a mutating or validating request it serializes an `AdmissionReview` object and delivers it to every registered webhook endpoint over HTTPS. The API server waits for a response before allowing or denying the operation. The full request path is:

```
kubectl apply → kube-apiserver
  → MutatingAdmissionWebhook (ordered, sequential)
  → Object validation against OpenAPI schema
  → ValidatingAdmissionWebhook (parallel)
  → etcd persistence
```

Mutating webhooks run first and may modify the object by returning a JSON patch. Validating webhooks run after all mutations are applied and may only accept or reject. Because mutating webhooks run before validation, a webhook that both mutates and validates should split responsibilities across two separate webhook registrations or use a single handler that performs mutations during the mutating phase and validations during the validating phase.

### ValidatingWebhookConfiguration vs MutatingWebhookConfiguration

```yaml
# ValidatingWebhookConfiguration — read-only enforcement
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: policy-validator
webhooks:
  - name: validate.pods.support.tools
    admissionReviewVersions: ["v1", "v1beta1"]
    clientConfig:
      service:
        name: webhook-service
        namespace: webhook-system
        path: /validate-pods
      caBundle: "" # injected by cert-manager
    rules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["pods"]
        scope: "Namespaced"
    failurePolicy: Fail
    sideEffects: None
    timeoutSeconds: 10
    namespaceSelector:
      matchExpressions:
        - key: kubernetes.io/metadata.name
          operator: NotIn
          values: ["kube-system", "kube-public", "cert-manager", "webhook-system"]
```

```yaml
# MutatingWebhookConfiguration — object modification
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: sidecar-injector
  annotations:
    cert-manager.io/inject-ca-from: webhook-system/webhook-serving-cert
webhooks:
  - name: inject.pods.support.tools
    admissionReviewVersions: ["v1"]
    clientConfig:
      service:
        name: webhook-service
        namespace: webhook-system
        path: /mutate-pods
    rules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        operations: ["CREATE"]
        resources: ["pods"]
    failurePolicy: Ignore
    sideEffects: None
    timeoutSeconds: 5
    namespaceSelector:
      matchLabels:
        sidecar-injection: enabled
    objectSelector:
      matchExpressions:
        - key: sidecar.support.tools/inject
          operator: NotIn
          values: ["false"]
```

Key differences:

| Attribute | Validating | Mutating |
|-----------|-----------|---------|
| Can modify object | No | Yes (JSON Patch) |
| Execution order | After mutations | Before validation |
| Parallel execution | Yes | No (sequential) |
| reinvocationPolicy | N/A | IfNeeded / Never |

## Project Setup with controller-runtime

```bash
mkdir -p webhook-controller/cmd webhook-controller/internal/webhook
cd webhook-controller
go mod init github.com/support-tools/webhook-controller
go get sigs.k8s.io/controller-runtime@v0.18.0
go get github.com/go-logr/logr
go get k8s.io/api
go get k8s.io/apimachinery
```

### Main Entry Point

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
	"sigs.k8s.io/controller-runtime/pkg/webhook"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	whv1 "github.com/support-tools/webhook-controller/internal/webhook/v1"
)

var (
	scheme   = runtime.NewScheme()
	setupLog = ctrl.Log.WithName("setup")
)

func init() {
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
}

func main() {
	var metricsAddr string
	var probeAddr string
	var certDir string

	flag.StringVar(&metricsAddr, "metrics-bind-address", ":8080", "metrics endpoint address")
	flag.StringVar(&probeAddr, "health-probe-bind-address", ":8081", "health probe address")
	flag.StringVar(&certDir, "cert-dir", "/tmp/k8s-webhook-server/serving-certs",
		"directory containing tls.crt and tls.key")
	opts := zap.Options{Development: false}
	opts.BindFlags(flag.CommandLine)
	flag.Parse()

	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))

	mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
		Scheme:                 scheme,
		MetricsBindAddress:     metricsAddr,
		HealthProbeBindAddress: probeAddr,
		WebhookServer: webhook.NewServer(webhook.Options{
			Port:    9443,
			CertDir: certDir,
		}),
		LeaderElection:          true,
		LeaderElectionID:        "webhook-controller.support.tools",
		LeaderElectionNamespace: "webhook-system",
	})
	if err != nil {
		setupLog.Error(err, "unable to start manager")
		os.Exit(1)
	}

	// Register handlers
	decoder := admission.NewDecoder(scheme)

	mgr.GetWebhookServer().Register("/mutate-pods",
		&webhook.Admission{Handler: whv1.NewPodMutator(mgr.GetClient(), decoder)})
	mgr.GetWebhookServer().Register("/validate-pods",
		&webhook.Admission{Handler: whv1.NewPodValidator(mgr.GetClient(), decoder)})

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

## Mutating Webhook: Sidecar Injection

```go
// internal/webhook/v1/pod_mutator.go
package v1

import (
	"context"
	"encoding/json"
	"net/http"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"
)

const (
	injectAnnotation  = "sidecar.support.tools/inject"
	injectedAnnotation = "sidecar.support.tools/injected"
)

// PodMutator injects a logging sidecar into annotated pods.
type PodMutator struct {
	Client  client.Client
	decoder *admission.Decoder
}

func NewPodMutator(c client.Client, d *admission.Decoder) *PodMutator {
	return &PodMutator{Client: c, decoder: d}
}

func (m *PodMutator) Handle(ctx context.Context, req admission.Request) admission.Response {
	logger := log.FromContext(ctx).WithValues(
		"pod", req.Name,
		"namespace", req.Namespace,
		"operation", req.Operation,
	)

	pod := &corev1.Pod{}
	if err := m.decoder.Decode(req, pod); err != nil {
		return admission.Errored(http.StatusBadRequest, err)
	}

	// Idempotency check — skip if already injected
	if pod.Annotations[injectedAnnotation] == "true" {
		logger.V(1).Info("sidecar already injected, skipping")
		return admission.Allowed("already injected")
	}

	// Respect explicit opt-out
	if pod.Annotations[injectAnnotation] == "false" {
		return admission.Allowed("injection disabled by annotation")
	}

	logger.Info("injecting sidecar")
	mutated := pod.DeepCopy()
	m.inject(mutated)

	marshaled, err := json.Marshal(mutated)
	if err != nil {
		return admission.Errored(http.StatusInternalServerError, err)
	}

	return admission.PatchResponseFromRaw(req.Object.Raw, marshaled)
}

func (m *PodMutator) inject(pod *corev1.Pod) {
	sidecar := corev1.Container{
		Name:  "log-collector",
		Image: "registry.support.tools/log-collector:v1.4.2",
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
			{Name: "varlog", MountPath: "/var/log"},
		},
		SecurityContext: &corev1.SecurityContext{
			AllowPrivilegeEscalation: boolPtr(false),
			ReadOnlyRootFilesystem:   boolPtr(true),
			RunAsNonRoot:             boolPtr(true),
			RunAsUser:                int64Ptr(65534),
		},
	}

	pod.Spec.Containers = append(pod.Spec.Containers, sidecar)

	// Add shared log volume if absent
	if !hasVolume(pod, "varlog") {
		pod.Spec.Volumes = append(pod.Spec.Volumes, corev1.Volume{
			Name:         "varlog",
			VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}},
		})
	}

	// Mark as injected
	if pod.Annotations == nil {
		pod.Annotations = make(map[string]string)
	}
	pod.Annotations[injectedAnnotation] = "true"
}

func hasVolume(pod *corev1.Pod, name string) bool {
	for _, v := range pod.Spec.Volumes {
		if v.Name == name {
			return true
		}
	}
	return false
}

func boolPtr(b bool) *bool        { return &b }
func int64Ptr(i int64) *int64     { return &i }
```

## Validating Webhook: Image Policy Enforcement

```go
// internal/webhook/v1/pod_validator.go
package v1

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	corev1 "k8s.io/api/core/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"
)

// AllowedRegistries defines trusted image registries. In production
// this should be sourced from a ConfigMap or CRD.
var AllowedRegistries = []string{
	"registry.support.tools/",
	"gcr.io/distroless/",
	"public.ecr.aws/",
}

// PodValidator enforces image registry policy.
type PodValidator struct {
	Client  client.Client
	decoder *admission.Decoder
}

func NewPodValidator(c client.Client, d *admission.Decoder) *PodValidator {
	return &PodValidator{Client: c, decoder: d}
}

func (v *PodValidator) Handle(ctx context.Context, req admission.Request) admission.Response {
	logger := log.FromContext(ctx).WithValues(
		"pod", req.Name,
		"namespace", req.Namespace,
	)

	pod := &corev1.Pod{}
	if err := v.decoder.Decode(req, pod); err != nil {
		return admission.Errored(http.StatusBadRequest, err)
	}

	var violations []string
	allContainers := append(pod.Spec.InitContainers, pod.Spec.Containers...)
	allContainers = append(allContainers, pod.Spec.EphemeralContainers...)

	for _, c := range allContainers {
		if !isAllowedImage(c.Image) {
			violations = append(violations,
				fmt.Sprintf("container %q uses disallowed image %q", c.Name, c.Image))
		}
	}

	if len(violations) > 0 {
		logger.Info("pod rejected", "violations", violations)
		return admission.Denied(strings.Join(violations, "; "))
	}

	logger.V(1).Info("pod allowed")
	return admission.Allowed("all images comply with registry policy")
}

func isAllowedImage(image string) bool {
	for _, prefix := range AllowedRegistries {
		if strings.HasPrefix(image, prefix) {
			return true
		}
	}
	return false
}
```

## Mutating Webhook: Label Injection

```go
// internal/webhook/v1/label_injector.go
package v1

import (
	"context"
	"encoding/json"
	"net/http"

	corev1 "k8s.io/api/core/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"
)

// RequiredLabels defines labels that must appear on every pod.
var RequiredLabels = map[string]string{
	"app.kubernetes.io/managed-by": "support-tools",
}

// LabelInjector ensures required labels are present.
type LabelInjector struct {
	Client  client.Client
	decoder *admission.Decoder
}

func NewLabelInjector(c client.Client, d *admission.Decoder) *LabelInjector {
	return &LabelInjector{Client: c, decoder: d}
}

func (l *LabelInjector) Handle(ctx context.Context, req admission.Request) admission.Response {
	pod := &corev1.Pod{}
	if err := l.decoder.Decode(req, pod); err != nil {
		return admission.Errored(http.StatusBadRequest, err)
	}

	mutated := pod.DeepCopy()
	if mutated.Labels == nil {
		mutated.Labels = make(map[string]string)
	}

	modified := false
	for k, v := range RequiredLabels {
		if existing, ok := mutated.Labels[k]; !ok || existing == "" {
			mutated.Labels[k] = v
			modified = true
		}
	}

	if !modified {
		return admission.Allowed("labels already present")
	}

	marshaled, err := json.Marshal(mutated)
	if err != nil {
		return admission.Errored(http.StatusInternalServerError, err)
	}
	return admission.PatchResponseFromRaw(req.Object.Raw, marshaled)
}
```

## TLS Certificate Management with cert-manager

Admission webhooks require TLS. The API server validates the webhook server's certificate against the `caBundle` field in the webhook configuration. cert-manager's CA Injector automates this lifecycle.

### cert-manager Resources

```yaml
# Certificate for the webhook server
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: webhook-serving-cert
  namespace: webhook-system
spec:
  dnsNames:
    - webhook-service.webhook-system.svc
    - webhook-service.webhook-system.svc.cluster.local
  issuerRef:
    kind: Issuer
    name: webhook-selfsigned-issuer
  secretName: webhook-server-cert
---
# Self-signed issuer (replace with a ClusterIssuer in production)
apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: webhook-selfsigned-issuer
  namespace: webhook-system
spec:
  selfSigned: {}
```

cert-manager's CA Injector watches resources annotated with `cert-manager.io/inject-ca-from` and automatically patches the `caBundle` field:

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: policy-validator
  annotations:
    cert-manager.io/inject-ca-from: webhook-system/webhook-serving-cert
```

### Manual caBundle Rotation (without cert-manager)

For environments without cert-manager, generate a self-signed CA and patch the webhook configuration:

```bash
# Generate CA key and certificate
openssl genrsa -out ca.key 4096
openssl req -new -x509 -days 3650 -key ca.key -out ca.crt \
  -subj "/CN=webhook-ca/O=support.tools"

# Generate server key and CSR
openssl genrsa -out server.key 4096
openssl req -new -key server.key -out server.csr \
  -subj "/CN=webhook-service.webhook-system.svc"

# Sign the server certificate
cat > san.ext <<EOF
subjectAltName = DNS:webhook-service.webhook-system.svc,DNS:webhook-service.webhook-system.svc.cluster.local
EOF
openssl x509 -req -days 365 -in server.csr -CA ca.crt -CAkey ca.key \
  -CAcreateserial -out server.crt -extfile san.ext

# Create TLS secret
kubectl create secret tls webhook-server-cert \
  --cert=server.crt --key=server.key \
  -n webhook-system

# Patch caBundle
CA_BUNDLE=$(base64 -w0 < ca.crt)
kubectl patch validatingwebhookconfiguration policy-validator \
  --type=json \
  -p="[{\"op\":\"replace\",\"path\":\"/webhooks/0/clientConfig/caBundle\",\"value\":\"${CA_BUNDLE}\"}]"
```

## Failure Policies

The `failurePolicy` field controls what happens when the webhook server is unreachable or returns an error:

```yaml
# Fail — deny the request if the webhook cannot be reached
# Use for critical security enforcement where denying is safer than allowing
failurePolicy: Fail

# Ignore — allow the request if the webhook cannot be reached
# Use for non-critical enhancements (sidecar injection, label defaults)
failurePolicy: Ignore
```

### Choosing the Right Policy

```
Webhook Purpose              | Recommended Policy | Rationale
-----------------------------|-------------------|---------------------------
Image registry enforcement   | Fail               | Security must block unapproved images
Resource limit defaults      | Ignore             | Cluster should function without defaults
Network policy injection     | Fail               | Workloads without policy are a risk
Label/annotation enrichment  | Ignore             | Missing labels degrade observability only
PVC size limits              | Fail               | Unbound quotas cause cluster instability
Sidecar injection            | Ignore             | App must start even if logging fails
```

For `failurePolicy: Fail`, the webhook server must maintain very high availability. Deploy a minimum of two replicas with pod disruption budgets:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: webhook-pdb
  namespace: webhook-system
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: webhook-controller
```

## Namespace Selector Patterns

Always exclude system namespaces and the webhook's own namespace to prevent bootstrap deadlocks:

```yaml
namespaceSelector:
  matchExpressions:
    # Exclude well-known system namespaces
    - key: kubernetes.io/metadata.name
      operator: NotIn
      values:
        - kube-system
        - kube-public
        - kube-node-lease
        - cert-manager
        - webhook-system
    # Include only namespaces that have opted in
    - key: policy.support.tools/enforce
      operator: In
      values: ["true"]
```

Alternatively use an allowlist pattern with a dedicated label:

```bash
# Label namespaces for webhook enforcement
kubectl label namespace production policy.support.tools/enforce=true
kubectl label namespace staging policy.support.tools/enforce=true
```

## Testing with envtest

envtest starts a real API server and etcd binary locally, enabling integration tests without a running cluster.

### Test Setup

```go
// internal/webhook/v1/suite_test.go
package v1_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	corev1 "k8s.io/api/core/v1"
	admissionv1 "k8s.io/api/admissionregistration/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/rest"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	"sigs.k8s.io/controller-runtime/pkg/webhook"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	whv1 "github.com/support-tools/webhook-controller/internal/webhook/v1"
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
	RunSpecs(t, "Webhook Suite")
}

var _ = BeforeSuite(func() {
	ctrl.SetLogger(zap.New(zap.WriteTo(GinkgoWriter), zap.UseDevMode(true)))
	ctx, cancel = context.WithCancel(context.Background())

	testEnv = &envtest.Environment{
		// Path to CRD manifests (empty for core types)
		CRDDirectoryPaths: []string{filepath.Join("..", "..", "..", "config", "crd", "bases")},
		WebhookInstallOptions: envtest.WebhookInstallOptions{
			Paths: []string{filepath.Join("..", "..", "..", "config", "webhook")},
		},
	}

	var err error
	cfg, err = testEnv.Start()
	Expect(err).NotTo(HaveOccurred())
	Expect(cfg).NotTo(BeNil())

	k8sClient, err = client.New(cfg, client.Options{})
	Expect(err).NotTo(HaveOccurred())

	mgr, err := ctrl.NewManager(cfg, ctrl.Options{
		WebhookServer: webhook.NewServer(webhook.Options{
			Host:    testEnv.WebhookInstallOptions.LocalServingHost,
			Port:    testEnv.WebhookInstallOptions.LocalServingPort,
			CertDir: testEnv.WebhookInstallOptions.LocalServingCertDir,
		}),
	})
	Expect(err).NotTo(HaveOccurred())

	decoder := admission.NewDecoder(mgr.GetScheme())
	mgr.GetWebhookServer().Register("/mutate-pods",
		&webhook.Admission{Handler: whv1.NewPodMutator(mgr.GetClient(), decoder)})
	mgr.GetWebhookServer().Register("/validate-pods",
		&webhook.Admission{Handler: whv1.NewPodValidator(mgr.GetClient(), decoder)})

	go func() {
		defer GinkgoRecover()
		Expect(mgr.Start(ctx)).To(Succeed())
	}()

	// Wait for webhook server readiness
	dialer := &envtest.WebhookInstallOptions{
		LocalServingHost: testEnv.WebhookInstallOptions.LocalServingHost,
		LocalServingPort: testEnv.WebhookInstallOptions.LocalServingPort,
	}
	Eventually(func() bool {
		return dialer.LocalServingPort > 0
	}, 10*time.Second, 250*time.Millisecond).Should(BeTrue())
})

var _ = AfterSuite(func() {
	cancel()
	Expect(testEnv.Stop()).To(Succeed())
})
```

### Webhook Tests

```go
// internal/webhook/v1/pod_validator_test.go
package v1_test

import (
	"context"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

var _ = Describe("PodValidator", func() {
	ctx := context.Background()

	ns := &corev1.Namespace{
		ObjectMeta: metav1.ObjectMeta{
			Name:   "test-validation",
			Labels: map[string]string{"policy.support.tools/enforce": "true"},
		},
	}

	BeforeEach(func() {
		Expect(k8sClient.Create(ctx, ns.DeepCopy())).To(Or(Succeed(), MatchError(ContainSubstring("already exists"))))
	})

	Context("with allowed images", func() {
		It("should allow the pod", func() {
			pod := &corev1.Pod{
				ObjectMeta: metav1.ObjectMeta{
					Name:      "allowed-pod",
					Namespace: ns.Name,
				},
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{
						{Name: "app", Image: "registry.support.tools/myapp:v1.0.0"},
					},
				},
			}
			Expect(k8sClient.Create(ctx, pod)).To(Succeed())
		})
	})

	Context("with disallowed images", func() {
		It("should deny the pod", func() {
			pod := &corev1.Pod{
				ObjectMeta: metav1.ObjectMeta{
					Name:      "disallowed-pod",
					Namespace: ns.Name,
				},
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{
						{Name: "app", Image: "docker.io/untrusted/image:latest"},
					},
				},
			}
			err := k8sClient.Create(ctx, pod)
			Expect(err).To(HaveOccurred())
			Expect(err.Error()).To(ContainSubstring("disallowed image"))
		})
	})
})
```

## Deployment Manifest

```yaml
# config/manager/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: webhook-controller
  namespace: webhook-system
  labels:
    app: webhook-controller
spec:
  replicas: 2
  selector:
    matchLabels:
      app: webhook-controller
  template:
    metadata:
      labels:
        app: webhook-controller
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8080"
    spec:
      serviceAccountName: webhook-controller
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: manager
          image: registry.support.tools/webhook-controller:latest
          args:
            - --cert-dir=/tmp/k8s-webhook-server/serving-certs
            - --metrics-bind-address=:8080
            - --health-probe-bind-address=:8081
          ports:
            - name: webhook
              containerPort: 9443
              protocol: TCP
            - name: metrics
              containerPort: 8080
              protocol: TCP
            - name: health
              containerPort: 8081
              protocol: TCP
          volumeMounts:
            - name: cert
              mountPath: /tmp/k8s-webhook-server/serving-certs
              readOnly: true
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8081
            initialDelaySeconds: 15
            periodSeconds: 20
          readinessProbe:
            httpGet:
              path: /readyz
              port: 8081
            initialDelaySeconds: 5
            periodSeconds: 10
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 500m
              memory: 256Mi
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
      volumes:
        - name: cert
          secret:
            defaultMode: 420
            secretName: webhook-server-cert
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: webhook-controller
```

## Observability and Debugging

### Metrics

controller-runtime exposes webhook latency and error metrics by default. Add custom counters:

```go
import (
	"github.com/prometheus/client_golang/prometheus"
	"sigs.k8s.io/controller-runtime/pkg/metrics"
)

var (
	admissionTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "webhook_admissions_total",
		Help: "Total admission requests processed by this webhook.",
	}, []string{"webhook", "operation", "result"})
)

func init() {
	metrics.Registry.MustRegister(admissionTotal)
}
```

### Debugging Webhook Invocations

```bash
# Watch API server audit logs for webhook calls
kubectl get events -n webhook-system --sort-by='.lastTimestamp'

# Check webhook endpoint connectivity from a debug pod
kubectl run debug --image=curlimages/curl --rm -it --restart=Never -- \
  curl -k https://webhook-service.webhook-system.svc:443/healthz

# View active webhook configurations
kubectl get validatingwebhookconfigurations,mutatingwebhookconfigurations

# Test with dry-run to see what a webhook would do
kubectl apply --dry-run=server -f test-pod.yaml

# Check if caBundle is populated
kubectl get validatingwebhookconfiguration policy-validator \
  -o jsonpath='{.webhooks[0].clientConfig.caBundle}' | base64 -d | openssl x509 -text -noout
```

### Common Failure Modes

```bash
# 1. caBundle mismatch — API server cannot verify TLS
#    Symptom: "x509: certificate signed by unknown authority"
#    Fix: Verify caBundle matches the CA that signed server.crt

# 2. Timeout — webhook handler too slow
#    Symptom: "context deadline exceeded" in API server logs
#    Fix: Increase timeoutSeconds or optimize handler; default is 10s

# 3. Bootstrap deadlock — webhook blocks its own namespace resources
#    Symptom: webhook pod stuck in Pending/ContainerCreating
#    Fix: Add webhook-system to namespaceSelector exclusion list

# 4. reinvocationPolicy loop — mutating webhook triggers another admission cycle
#    Symptom: request loops until timeout
#    Fix: Use idempotency checks; set reinvocationPolicy: Never
```

## reinvocationPolicy for Complex Mutation Chains

When multiple mutating webhooks run sequentially, a later webhook may need to re-run an earlier one. The `reinvocationPolicy` controls this:

```yaml
webhooks:
  - name: inject.pods.support.tools
    reinvocationPolicy: IfNeeded  # Re-run if a later webhook modifies the object
    # ...
```

Use `IfNeeded` only when your mutation is genuinely dependent on the final object state. Always implement idempotency checks to prevent infinite loops.

## Production Checklist

```
Infrastructure
[ ] Minimum 2 webhook server replicas across different nodes
[ ] PodDisruptionBudget with minAvailable: 1
[ ] TopologySpreadConstraints for zone distribution
[ ] cert-manager managing TLS lifecycle with automatic renewal
[ ] NetworkPolicy allowing API server to reach webhook port 9443

Webhook Configuration
[ ] Correct failurePolicy per webhook purpose (Fail vs Ignore)
[ ] namespaceSelector excludes kube-system, webhook-system, cert-manager
[ ] timeoutSeconds tuned to handler performance (start at 10s)
[ ] sideEffects: None for stateless webhooks
[ ] admissionReviewVersions includes both v1 and v1beta1

Testing
[ ] envtest integration tests covering admit/deny paths
[ ] Idempotency tests (apply same resource twice)
[ ] Failure simulation tests (handler returns 500)
[ ] Namespace exclusion tests (kube-system pods unaffected)

Operations
[ ] Prometheus metrics scraping configured
[ ] Alerts on admission error rate > 1% over 5 minutes
[ ] Runbook for caBundle rotation procedure
[ ] Documented namespace labeling procedure for opt-in
```

Admission controllers represent one of the highest-leverage extension points in Kubernetes. A well-architected webhook enforces policy at admission time before any workload starts, eliminating entire categories of operational incidents caused by misconfigured resources.
