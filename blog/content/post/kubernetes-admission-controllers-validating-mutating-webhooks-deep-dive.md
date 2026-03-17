---
title: "Kubernetes Admission Controllers: Validating and Mutating Webhooks Deep Dive"
date: 2029-04-05T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Admission Controllers", "Webhooks", "Security", "Policy", "cert-manager"]
categories: ["Kubernetes", "Security", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Kubernetes admission controllers: webhook lifecycle, TLS bootstrap with cert-manager, policy frameworks, testing strategies, and performance impact analysis for production environments."
more_link: "yes"
url: "/kubernetes-admission-controllers-validating-mutating-webhooks-deep-dive/"
---

Kubernetes admission controllers are the enforcement layer for all API server requests. Every time a Pod, Deployment, or any resource is created or modified, admission controllers have the opportunity to validate, mutate, or reject the request before it reaches etcd. Implementing custom webhooks is how you enforce organizational policies, inject sidecars, and add security controls that the native Kubernetes API does not provide. Understanding the webhook lifecycle and failure modes is critical for production reliability.

<!--more-->

# Kubernetes Admission Controllers: Validating and Mutating Webhooks Deep Dive

## Section 1: Admission Controller Architecture

The Kubernetes API server processes requests through this pipeline:

```
kubectl apply / API request
    ↓
Authentication & Authorization
    ↓
Mutating Admission Webhooks (MutatingAdmissionWebhook)
    ↓
Object schema validation
    ↓
Validating Admission Webhooks (ValidatingAdmissionWebhook)
    ↓
etcd persistence
```

Key points:
- **Mutating webhooks run first** and can modify the object
- **Multiple mutating webhooks run in order** but each sees the output of the previous
- **Validating webhooks run after all mutation** and cannot modify the object
- A **reject from any webhook** aborts the request with an error
- Webhook failures (network error, timeout) are handled according to `failurePolicy`

### Built-in Admission Controllers

```bash
# Check which admission controllers are enabled on your API server
kubectl exec -n kube-system kube-apiserver-<node> -- \
  kube-apiserver --help 2>&1 | grep "enable-admission-plugins"

# Default admission plugins in Kubernetes 1.28+
# NamespaceLifecycle, LimitRanger, ServiceAccount, TaintNodesByCondition,
# PodSecurity, Priority, DefaultTolerationSeconds, DefaultStorageClass,
# StorageObjectInUseProtection, PersistentVolumeClaimResize,
# RuntimeClass, CertificateApproval, CertificateSigning,
# ClusterTrustBundleAttest, CertificateSubjectRestriction,
# DefaultIngressClass, MutatingAdmissionWebhook,
# ValidatingAdmissionPolicy, ValidatingAdmissionWebhook,
# ResourceQuota
```

## Section 2: Writing a Mutating Admission Webhook

### Webhook Server in Go

```go
// cmd/webhook/main.go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "net/http"
    "os"

    admissionv1 "k8s.io/api/admission/v1"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/apimachinery/pkg/runtime/serializer"
)

var (
    scheme = runtime.NewScheme()
    codecs = serializer.NewCodecFactory(scheme)
)

func init() {
    admissionv1.AddToScheme(scheme)
}

type WebhookServer struct {
    server *http.Server
}

func main() {
    tlsCert := os.Getenv("TLS_CERT_FILE")
    tlsKey := os.Getenv("TLS_KEY_FILE")
    port := os.Getenv("PORT")
    if port == "" {
        port = "8443"
    }

    mux := http.NewServeMux()
    mux.HandleFunc("/mutate/pods", handleMutatePods)
    mux.HandleFunc("/validate/pods", handleValidatePods)
    mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
        w.Write([]byte("ok"))
    })

    server := &http.Server{
        Addr:    ":" + port,
        Handler: mux,
    }

    log.Printf("Webhook server starting on :%s", port)
    if err := server.ListenAndServeTLS(tlsCert, tlsKey); err != nil {
        log.Fatalf("Failed to start server: %v", err)
    }
}

// handleMutatePods handles pod mutation requests
func handleMutatePods(w http.ResponseWriter, r *http.Request) {
    // Parse the AdmissionReview request
    review, err := parseAdmissionReview(r)
    if err != nil {
        http.Error(w, err.Error(), http.StatusBadRequest)
        return
    }

    // Process the mutation
    response := mutatePod(review.Request)

    // Build the response
    review.Response = response
    review.Response.UID = review.Request.UID

    if err := json.NewEncoder(w).Encode(review); err != nil {
        log.Printf("Error encoding response: %v", err)
    }
}

func parseAdmissionReview(r *http.Request) (*admissionv1.AdmissionReview, error) {
    body := make([]byte, 0)
    if r.Body != nil {
        defer r.Body.Close()
        body, _ = io.ReadAll(r.Body)
    }

    if contentType := r.Header.Get("Content-Type"); contentType != "application/json" {
        return nil, fmt.Errorf("expected application/json, got %s", contentType)
    }

    review := &admissionv1.AdmissionReview{}
    if err := json.Unmarshal(body, review); err != nil {
        return nil, fmt.Errorf("parsing admission review: %w", err)
    }

    return review, nil
}

// mutatePod adds security context, resource defaults, and labels
func mutatePod(req *admissionv1.AdmissionRequest) *admissionv1.AdmissionResponse {
    // Deserialize the Pod
    pod := &corev1.Pod{}
    if err := json.Unmarshal(req.Object.Raw, pod); err != nil {
        return errorResponse(fmt.Sprintf("deserializing pod: %v", err))
    }

    var patches []JSONPatch

    // Patch 1: Add default labels if missing
    if pod.Labels == nil {
        patches = append(patches, JSONPatch{
            Op:    "add",
            Path:  "/metadata/labels",
            Value: map[string]string{},
        })
    }
    if _, ok := pod.Labels["app.kubernetes.io/managed-by"]; !ok {
        patches = append(patches, JSONPatch{
            Op:    "add",
            Path:  "/metadata/labels/app.kubernetes.io~1managed-by",
            Value: "my-platform",
        })
    }

    // Patch 2: Add security context if missing
    if pod.Spec.SecurityContext == nil {
        patches = append(patches, JSONPatch{
            Op:   "add",
            Path: "/spec/securityContext",
            Value: corev1.PodSecurityContext{
                RunAsNonRoot: boolPtr(true),
                SeccompProfile: &corev1.SeccompProfile{
                    Type: corev1.SeccompProfileTypeRuntimeDefault,
                },
            },
        })
    }

    // Patch 3: Add Prometheus scraping annotations
    if pod.Annotations == nil {
        patches = append(patches, JSONPatch{
            Op:    "add",
            Path:  "/metadata/annotations",
            Value: map[string]string{},
        })
    }
    if _, ok := pod.Annotations["prometheus.io/scrape"]; !ok {
        patches = append(patches, JSONPatch{
            Op:    "add",
            Path:  "/metadata/annotations/prometheus.io~1scrape",
            Value: "true",
        })
    }

    // Patch 4: Inject sidecar container if annotation present
    if inject, ok := pod.Annotations["sidecar-injector/inject"]; ok && inject == "true" {
        patches = append(patches, injectSidecar(pod)...)
    }

    patchBytes, err := json.Marshal(patches)
    if err != nil {
        return errorResponse(fmt.Sprintf("marshaling patches: %v", err))
    }

    patchType := admissionv1.PatchTypeJSONPatch
    return &admissionv1.AdmissionResponse{
        Allowed:   true,
        Patch:     patchBytes,
        PatchType: &patchType,
    }
}

type JSONPatch struct {
    Op    string      `json:"op"`
    Path  string      `json:"path"`
    Value interface{} `json:"value,omitempty"`
}

func injectSidecar(pod *corev1.Pod) []JSONPatch {
    sidecar := corev1.Container{
        Name:  "envoy-proxy",
        Image: "envoyproxy/envoy:v1.30.0",
        Ports: []corev1.ContainerPort{
            {ContainerPort: 9901, Name: "admin"},
            {ContainerPort: 15001, Name: "proxy"},
        },
        Resources: corev1.ResourceRequirements{
            Requests: corev1.ResourceList{
                corev1.ResourceCPU:    resource.MustParse("10m"),
                corev1.ResourceMemory: resource.MustParse("64Mi"),
            },
            Limits: corev1.ResourceList{
                corev1.ResourceCPU:    resource.MustParse("200m"),
                corev1.ResourceMemory: resource.MustParse("128Mi"),
            },
        },
        SecurityContext: &corev1.SecurityContext{
            RunAsNonRoot:             boolPtr(true),
            RunAsUser:                int64Ptr(1337),
            AllowPrivilegeEscalation: boolPtr(false),
            ReadOnlyRootFilesystem:   boolPtr(true),
        },
    }

    return []JSONPatch{
        {
            Op:    "add",
            Path:  "/spec/initContainers/-",
            Value: sidecar,
        },
    }
}

func errorResponse(message string) *admissionv1.AdmissionResponse {
    return &admissionv1.AdmissionResponse{
        Allowed: false,
        Result: &metav1.Status{
            Message: message,
            Code:    http.StatusInternalServerError,
        },
    }
}

func boolPtr(b bool) *bool     { return &b }
func int64Ptr(i int64) *int64  { return &i }
```

### Validating Webhook Handler

```go
// handleValidatePods enforces organizational policies
func handleValidatePods(w http.ResponseWriter, r *http.Request) {
    review, err := parseAdmissionReview(r)
    if err != nil {
        http.Error(w, err.Error(), http.StatusBadRequest)
        return
    }

    review.Response = validatePod(review.Request)
    review.Response.UID = review.Request.UID

    json.NewEncoder(w).Encode(review)
}

func validatePod(req *admissionv1.AdmissionRequest) *admissionv1.AdmissionResponse {
    pod := &corev1.Pod{}
    if err := json.Unmarshal(req.Object.Raw, pod); err != nil {
        return denyResponse(http.StatusBadRequest,
            fmt.Sprintf("deserializing pod: %v", err))
    }

    var violations []string

    // Policy 1: Require resource limits on all containers
    for _, container := range pod.Spec.Containers {
        if container.Resources.Limits == nil {
            violations = append(violations,
                fmt.Sprintf("container %q missing resource limits", container.Name))
        }
        if container.Resources.Requests == nil {
            violations = append(violations,
                fmt.Sprintf("container %q missing resource requests", container.Name))
        }
    }

    // Policy 2: Prohibit latest tag
    for _, container := range append(pod.Spec.Containers, pod.Spec.InitContainers...) {
        if hasLatestTag(container.Image) {
            violations = append(violations,
                fmt.Sprintf("container %q uses 'latest' tag which is prohibited",
                    container.Name))
        }
    }

    // Policy 3: Require team label
    if _, ok := pod.Labels["team"]; !ok {
        violations = append(violations, "pod missing required 'team' label")
    }

    // Policy 4: Enforce security context
    for _, container := range pod.Spec.Containers {
        sc := container.SecurityContext
        if sc == nil || sc.AllowPrivilegeEscalation == nil || *sc.AllowPrivilegeEscalation {
            violations = append(violations,
                fmt.Sprintf("container %q must set allowPrivilegeEscalation=false",
                    container.Name))
        }
    }

    if len(violations) > 0 {
        return denyResponse(http.StatusForbidden,
            "Policy violations:\n"+strings.Join(violations, "\n"))
    }

    return &admissionv1.AdmissionResponse{
        Allowed: true,
        Result: &metav1.Status{
            Message: "All policies passed",
        },
    }
}

func denyResponse(code int32, message string) *admissionv1.AdmissionResponse {
    return &admissionv1.AdmissionResponse{
        Allowed: false,
        Result: &metav1.Status{
            Message: message,
            Code:    code,
        },
    }
}

func hasLatestTag(image string) bool {
    parts := strings.Split(image, ":")
    if len(parts) == 1 {
        return true // No tag = implicit latest
    }
    return parts[len(parts)-1] == "latest"
}
```

## Section 3: TLS Bootstrap with cert-manager

Webhooks require HTTPS. cert-manager is the standard way to automate certificate management for webhooks.

### cert-manager Certificate Resource

```yaml
# Certificate for the webhook server
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: webhook-server-tls
  namespace: my-webhook-system
spec:
  secretName: webhook-server-tls
  duration: 8760h    # 1 year
  renewBefore: 360h  # Renew 15 days before expiry
  isCA: false
  privateKey:
    algorithm: ECDSA
    size: 256
  dnsNames:
    # Service name.namespace.svc
    - webhook-service.my-webhook-system.svc
    - webhook-service.my-webhook-system.svc.cluster.local
  issuerRef:
    name: cluster-ca-issuer
    kind: ClusterIssuer
    group: cert-manager.io
```

### Automatic CABundle Injection

cert-manager can automatically inject the CA bundle into webhook configurations:

```yaml
# ClusterIssuer for webhook CA
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned-issuer
spec:
  selfSigned: {}

---
# CA Certificate
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: webhook-ca
  namespace: cert-manager
spec:
  isCA: true
  commonName: webhook-ca
  secretName: webhook-ca-tls
  privateKey:
    algorithm: ECDSA
    size: 256
  issuerRef:
    name: selfsigned-issuer
    kind: ClusterIssuer

---
# Issuer using the CA
apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: webhook-ca-issuer
  namespace: my-webhook-system
spec:
  ca:
    secretName: webhook-ca-tls

---
# MutatingWebhookConfiguration with cert-manager CA injection annotation
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: my-pod-mutator
  annotations:
    # cert-manager will inject the CA bundle from this secret
    cert-manager.io/inject-ca-from: my-webhook-system/webhook-server-tls
spec:
  webhooks:
    - name: mutate.pods.example.com
      admissionReviewVersions: ["v1"]
      clientConfig:
        service:
          name: webhook-service
          namespace: my-webhook-system
          path: /mutate/pods
        # caBundle is auto-filled by cert-manager
      rules:
        - operations: ["CREATE", "UPDATE"]
          apiGroups: [""]
          apiVersions: ["v1"]
          resources: ["pods"]
          scope: Namespaced
      namespaceSelector:
        matchExpressions:
          - key: webhook-injection
            operator: NotIn
            values: ["disabled"]
      failurePolicy: Fail
      sideEffects: None
      timeoutSeconds: 10
```

## Section 4: WebhookConfiguration in Depth

### Scope and Selector Configuration

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: enterprise-policy-validator
spec:
  webhooks:
    - name: validate.deployments.example.com
      admissionReviewVersions: ["v1", "v1beta1"]

      clientConfig:
        service:
          name: policy-webhook
          namespace: policy-system
          path: /validate/deployments
          port: 443

      rules:
        - operations: ["CREATE", "UPDATE"]
          apiGroups: ["apps"]
          apiVersions: ["v1"]
          resources: ["deployments", "statefulsets", "daemonsets"]
          scope: Namespaced

      # Only validate namespaces with specific labels
      namespaceSelector:
        matchLabels:
          environment: production

      # Only apply to objects that match this selector
      objectSelector:
        matchExpressions:
          - key: skip-validation
            operator: DoesNotExist

      # Fail: reject the request if webhook unavailable
      # Ignore: allow the request if webhook unavailable
      failurePolicy: Fail

      # None: webhook has no side effects (stateless)
      # NoneOnDryRun: webhook has side effects but not on dry run
      sideEffects: None

      # Webhook timeout (1-30 seconds, default 10)
      timeoutSeconds: 5

      # When to re-invoke webhook after mutation
      # Never: only invoke once per admission
      # IfNeeded: reinvoke if another webhook mutated the object
      reinvocationPolicy: IfNeeded
```

### Restricting to Specific Operations

```yaml
rules:
  # Only validate on initial creation
  - operations: ["CREATE"]
    apiGroups: [""]
    resources: ["pods"]

  # Validate on create and update for deployments
  - operations: ["CREATE", "UPDATE"]
    apiGroups: ["apps"]
    resources: ["deployments"]

  # Include subresources
  - operations: ["UPDATE"]
    apiGroups: [""]
    resources: ["pods/status"]

  # Validate deletes (rare, but useful for finalization)
  - operations: ["DELETE"]
    apiGroups: [""]
    resources: ["namespaces"]
```

## Section 5: Deployment Configuration

### Kubernetes Deployment for Webhook Server

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: admission-webhook
  namespace: my-webhook-system
spec:
  replicas: 2  # High availability
  selector:
    matchLabels:
      app: admission-webhook
  template:
    metadata:
      labels:
        app: admission-webhook
    spec:
      serviceAccountName: admission-webhook
      # Run on control plane nodes (or dedicated infra nodes)
      # to minimize webhook availability dependency on worker nodes
      tolerations:
        - key: node-role.kubernetes.io/control-plane
          effect: NoSchedule
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: admission-webhook
              topologyKey: kubernetes.io/hostname

      containers:
        - name: webhook
          image: myregistry/admission-webhook:v1.2.0
          imagePullPolicy: Always
          ports:
            - containerPort: 8443
              name: https
          env:
            - name: TLS_CERT_FILE
              value: /tls/tls.crt
            - name: TLS_KEY_FILE
              value: /tls/tls.key
          volumeMounts:
            - name: tls
              mountPath: /tls
              readOnly: true
          resources:
            requests:
              cpu: 10m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 256Mi
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8443
              scheme: HTTPS
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8443
              scheme: HTTPS
            initialDelaySeconds: 10
            periodSeconds: 20
          securityContext:
            runAsNonRoot: true
            runAsUser: 65534
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]

      volumes:
        - name: tls
          secret:
            secretName: webhook-server-tls

---
apiVersion: v1
kind: Service
metadata:
  name: webhook-service
  namespace: my-webhook-system
spec:
  selector:
    app: admission-webhook
  ports:
    - port: 443
      targetPort: 8443

---
# PodDisruptionBudget: ensure at least one webhook pod is always running
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: admission-webhook-pdb
  namespace: my-webhook-system
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: admission-webhook
```

## Section 6: Testing Strategies

### Unit Testing Webhook Logic

```go
// webhook_test.go
package webhook_test

import (
    "encoding/json"
    "testing"

    admissionv1 "k8s.io/api/admission/v1"
    corev1 "k8s.io/api/core/v1"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestMutatePod_AddsLabels(t *testing.T) {
    pod := &corev1.Pod{
        Spec: corev1.PodSpec{
            Containers: []corev1.Container{
                {Name: "app", Image: "nginx:1.25"},
            },
        },
    }

    podBytes, err := json.Marshal(pod)
    require.NoError(t, err)

    req := &admissionv1.AdmissionRequest{
        UID:       "test-uid",
        Kind:      metav1.GroupVersionKind{Group: "", Version: "v1", Kind: "Pod"},
        Resource:  metav1.GroupVersionResource{Group: "", Version: "v1", Resource: "pods"},
        Name:      "test-pod",
        Namespace: "default",
        Operation: admissionv1.Create,
        Object:    runtime.RawExtension{Raw: podBytes},
    }

    response := mutatePod(req)

    assert.True(t, response.Allowed)
    assert.NotEmpty(t, response.Patch)

    // Parse and verify patches
    var patches []JSONPatch
    require.NoError(t, json.Unmarshal(response.Patch, &patches))

    // Find the managed-by label patch
    found := false
    for _, p := range patches {
        if p.Path == "/metadata/labels/app.kubernetes.io~1managed-by" {
            found = true
            assert.Equal(t, "my-platform", p.Value)
        }
    }
    assert.True(t, found, "Expected managed-by label patch")
}

func TestValidatePod_RejectsLatestTag(t *testing.T) {
    pod := &corev1.Pod{
        Spec: corev1.PodSpec{
            Containers: []corev1.Container{
                {
                    Name:  "app",
                    Image: "nginx:latest",  // Should be rejected
                    Resources: corev1.ResourceRequirements{
                        Requests: corev1.ResourceList{
                            corev1.ResourceCPU:    resource.MustParse("10m"),
                            corev1.ResourceMemory: resource.MustParse("64Mi"),
                        },
                        Limits: corev1.ResourceList{
                            corev1.ResourceCPU:    resource.MustParse("100m"),
                            corev1.ResourceMemory: resource.MustParse("128Mi"),
                        },
                    },
                },
            },
        },
        ObjectMeta: metav1.ObjectMeta{
            Labels: map[string]string{"team": "platform"},
        },
    }

    podBytes, _ := json.Marshal(pod)
    req := &admissionv1.AdmissionRequest{
        Object: runtime.RawExtension{Raw: podBytes},
    }

    response := validatePod(req)

    assert.False(t, response.Allowed)
    assert.Contains(t, response.Result.Message, "latest")
}

// Table-driven tests
func TestValidatePod_Policies(t *testing.T) {
    tests := []struct {
        name          string
        pod           *corev1.Pod
        expectAllowed bool
        expectMessage string
    }{
        {
            name:          "valid pod passes all checks",
            pod:           validPod(),
            expectAllowed: true,
        },
        {
            name:          "missing team label",
            pod:           podWithoutLabel("team"),
            expectAllowed: false,
            expectMessage: "team",
        },
        {
            name:          "image with no tag treated as latest",
            pod:           podWithImage("nginx"),
            expectAllowed: false,
            expectMessage: "latest",
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            podBytes, _ := json.Marshal(tt.pod)
            req := &admissionv1.AdmissionRequest{
                Object: runtime.RawExtension{Raw: podBytes},
            }

            response := validatePod(req)

            assert.Equal(t, tt.expectAllowed, response.Allowed)
            if tt.expectMessage != "" {
                assert.Contains(t, response.Result.Message, tt.expectMessage)
            }
        })
    }
}
```

### Integration Testing with envtest

```go
// suite_test.go
package integration_test

import (
    "context"
    "path/filepath"
    "testing"

    . "github.com/onsi/ginkgo/v2"
    . "github.com/onsi/gomega"
    admissionv1 "k8s.io/api/admissionregistration/v1"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/envtest"
)

var (
    testEnv *envtest.Environment
    k8sClient client.Client
    ctx    context.Context
    cancel context.CancelFunc
)

func TestWebhookIntegration(t *testing.T) {
    RegisterFailHandler(Fail)
    RunSpecs(t, "Webhook Integration Suite")
}

var _ = BeforeSuite(func() {
    ctx, cancel = context.WithCancel(context.Background())

    testEnv = &envtest.Environment{
        CRDDirectoryPaths: []string{
            filepath.Join("..", "config", "crd", "bases"),
        },
        WebhookInstallOptions: envtest.WebhookInstallOptions{
            Paths: []string{
                filepath.Join("..", "config", "webhook"),
            },
        },
    }

    cfg, err := testEnv.Start()
    Expect(err).NotTo(HaveOccurred())

    k8sClient, err = client.New(cfg, client.Options{})
    Expect(err).NotTo(HaveOccurred())
})

var _ = AfterSuite(func() {
    cancel()
    testEnv.Stop()
})
```

### End-to-End Testing with kubectl

```bash
#!/bin/bash
# e2e-webhook-test.sh

set -e

NAMESPACE="webhook-test"
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
kubectl label namespace "$NAMESPACE" webhook-injection=enabled

echo "=== Test 1: Valid pod should be admitted ==="
kubectl apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: valid-pod
  namespace: $NAMESPACE
  labels:
    team: platform
spec:
  containers:
    - name: app
      image: nginx:1.25.3
      resources:
        requests:
          cpu: 10m
          memory: 64Mi
        limits:
          cpu: 100m
          memory: 128Mi
      securityContext:
        allowPrivilegeEscalation: false
EOF

# Verify mutation was applied
MANAGED_BY=$(kubectl get pod valid-pod -n "$NAMESPACE" \
  -o jsonpath='{.metadata.labels.app\.kubernetes\.io/managed-by}')
if [ "$MANAGED_BY" != "my-platform" ]; then
  echo "FAIL: Expected managed-by=my-platform, got $MANAGED_BY"
  exit 1
fi
echo "PASS: Pod admitted and mutated correctly"

echo "=== Test 2: Pod with 'latest' tag should be rejected ==="
if kubectl apply -f - 2>&1 <<EOF | grep -q "prohibited"; then
apiVersion: v1
kind: Pod
metadata:
  name: invalid-pod
  namespace: $NAMESPACE
  labels:
    team: platform
spec:
  containers:
    - name: app
      image: nginx:latest
      resources:
        requests:
          cpu: 10m
          memory: 64Mi
        limits:
          cpu: 100m
          memory: 128Mi
EOF
  echo "PASS: Pod with latest tag was rejected"
else
  echo "FAIL: Pod with latest tag should have been rejected"
  exit 1
fi

# Cleanup
kubectl delete namespace "$NAMESPACE"
echo "All tests passed"
```

## Section 7: Policy Frameworks

### ValidatingAdmissionPolicy (CEL-based, Kubernetes 1.28+ GA)

```yaml
# No webhook server needed - policies evaluated in-process using CEL
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: no-latest-tag
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["pods"]

  validations:
    - expression: |
        object.spec.containers.all(c,
          !c.image.endsWith(':latest') && c.image.contains(':')
        )
      message: "All container images must have a specific tag (not 'latest')"
      reason: Invalid

    - expression: |
        object.spec.containers.all(c,
          has(c.resources) &&
          has(c.resources.limits) &&
          has(c.resources.requests)
        )
      message: "All containers must have resource limits and requests"
      reason: Invalid

    - expression: |
        has(object.metadata.labels) &&
        'team' in object.metadata.labels
      message: "All pods must have a 'team' label"
      reason: Invalid

---
# Bind the policy to namespaces
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: no-latest-tag-binding
spec:
  policyName: no-latest-tag
  validationActions: [Deny]
  matchResources:
    namespaceSelector:
      matchLabels:
        environment: production
```

### OPA Gatekeeper Integration

```yaml
# Gatekeeper ConstraintTemplate defines the policy in Rego
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequiredlabels
spec:
  crd:
    spec:
      names:
        kind: K8sRequiredLabels
      validation:
        openAPIV3Schema:
          type: object
          properties:
            labels:
              type: array
              items:
                type: string

  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8srequiredlabels

        violation[{"msg": msg, "details": {"missing_labels": missing}}] {
          provided := {label | input.review.object.metadata.labels[label]}
          required := {label | label := input.parameters.labels[_]}
          missing := required - provided
          count(missing) > 0
          msg := sprintf("Missing required labels: %v", [missing])
        }

---
# Constraint instance applying the template
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredLabels
metadata:
  name: pod-must-have-team-label
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Pod"]
    namespaceSelector:
      matchLabels:
        environment: production
  parameters:
    labels: ["team", "app"]
```

## Section 8: Performance Impact and Optimization

### Measuring Webhook Latency

```bash
# Check webhook call latency in API server metrics
kubectl get --raw /metrics | grep apiserver_admission

# Key metrics:
# apiserver_admission_webhook_admission_duration_seconds
# apiserver_admission_webhook_fail_open_count
# apiserver_admission_webhook_rejection_count

# View in Prometheus
apiserver_admission_webhook_admission_duration_seconds{
  name="mutate.pods.example.com",
  quantile="0.99"
}
```

### Optimization Strategies

```yaml
# 1. Use objectSelector to skip irrelevant objects
objectSelector:
  matchLabels:
    enable-injection: "true"

# 2. Use namespaceSelector to skip system namespaces
namespaceSelector:
  matchExpressions:
    - key: kubernetes.io/metadata.name
      operator: NotIn
      values: ["kube-system", "kube-public", "cert-manager", "monitoring"]

# 3. Limit operations to only what's needed
rules:
  - operations: ["CREATE"]  # Not UPDATE unless required
    resources: ["pods"]     # Not pods/status, pods/log, etc.

# 4. Set appropriate timeoutSeconds
timeoutSeconds: 5  # Don't set higher than needed

# 5. Use FailurePolicy: Ignore for non-critical mutations
failurePolicy: Ignore

# 6. Cache expensive computations in your webhook server
# Use sync.Map or groupcache for policy lookups
```

### Webhook Server Performance

```go
// High-performance webhook server with connection pooling and caching
package main

import (
    "net/http"
    "time"
    "sync"
    "github.com/patrickmn/go-cache"
)

type WebhookServer struct {
    policyCache *cache.Cache
    mu          sync.RWMutex
}

func NewWebhookServer() *WebhookServer {
    return &WebhookServer{
        // Cache policy decisions for 60 seconds to avoid repeated lookups
        policyCache: cache.New(60*time.Second, 10*time.Minute),
    }
}

func main() {
    ws := NewWebhookServer()

    server := &http.Server{
        Addr:         ":8443",
        Handler:      ws.handler(),
        ReadTimeout:  5 * time.Second,
        WriteTimeout: 5 * time.Second,
        // Keep connections alive for better performance under load
        IdleTimeout:  120 * time.Second,
        // Limit concurrent connections
        MaxHeaderBytes: 1 << 20,
    }

    server.ListenAndServeTLS("/tls/tls.crt", "/tls/tls.key")
}
```

## Section 9: Troubleshooting Webhooks

```bash
# Check webhook registration
kubectl get mutatingwebhookconfigurations
kubectl get validatingwebhookconfigurations

# Describe a webhook to see its current configuration
kubectl describe mutatingwebhookconfiguration my-pod-mutator

# Check if the webhook is being called
kubectl get --raw /metrics | grep webhook | grep my-pod-mutator

# Test webhook connectivity from within cluster
kubectl run test-webhook --rm -it --image=curlimages/curl -- \
  curl -k https://webhook-service.my-webhook-system.svc/healthz

# Check webhook server logs
kubectl logs -n my-webhook-system \
  -l app=admission-webhook \
  --tail=100 -f

# Debug a rejected admission
kubectl apply -f my-pod.yaml 2>&1
# Error from server: error when creating "my-pod.yaml":
# admission webhook "validate.pods.example.com" denied the request:
# Policy violations:
# - container "app" missing resource limits

# Dry run to test webhook without creating objects
kubectl apply -f my-pod.yaml --dry-run=server

# Check API server logs for webhook errors
kubectl logs -n kube-system kube-apiserver-<node> | grep webhook

# Temporarily disable a webhook for troubleshooting
kubectl patch mutatingwebhookconfiguration my-pod-mutator \
  --type='json' \
  -p='[{"op":"replace","path":"/webhooks/0/failurePolicy","value":"Ignore"}]'
```

## Summary

Production-grade admission webhooks require attention to several dimensions:

1. **TLS management**: cert-manager with automatic CA bundle injection is the reliable production approach

2. **Availability**: Run 2+ webhook replicas with PodAntiAffinity and PodDisruptionBudget; prefer control-plane or dedicated infra nodes to prevent circular dependencies

3. **Failure policy**: Use `failurePolicy: Fail` for security-critical validating webhooks; consider `Ignore` for non-critical mutations where availability matters more than enforcement

4. **Performance**: Use object and namespace selectors aggressively to minimize webhook call frequency; cache policy lookups; set appropriate timeouts

5. **Testing**: Unit test mutation/validation logic independently from HTTP concerns; integration test with envtest; end-to-end test the actual admission flow

6. **Modern alternatives**: ValidatingAdmissionPolicy (CEL-based, no server required) covers many common use cases without the operational overhead of running webhook servers
