---
title: "Kubernetes Admission Controllers: Production Patterns, Webhook Development, and Security Gates"
date: 2027-05-17T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Admission Controller", "Webhook", "Security", "OPA", "Kyverno"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes admission controllers covering ValidatingWebhookConfiguration, MutatingWebhookConfiguration, CEL-based admission policies, OPA Gatekeeper vs Kyverno, and production webhook development patterns."
more_link: "yes"
url: "/kubernetes-admission-controller-production-patterns-guide/"
---

Kubernetes admission controllers are the last line of defense before objects persist to etcd. Every configuration mistake, every security policy violation, every resource over-provisioning attempt passes through the admission control chain. For production clusters, admission controllers serve as automated enforcers of organizational policies — catching issues that would otherwise reach production as misconfigurations, security gaps, or capacity problems.

This guide covers the full admission controller ecosystem: the built-in controllers, the webhook framework for custom logic, the newer CEL-based admission policies that eliminate webhook operational overhead, and a detailed comparison of OPA Gatekeeper and Kyverno for policy management at scale.

<!--more-->

## The Admission Control Chain

### Request Lifecycle

When a Kubernetes API request arrives, it passes through a defined sequence of handlers:

```
Client Request
      │
      ▼
   TLS Termination
      │
      ▼
   Authentication
   (x509, Bearer token, OIDC, service account)
      │
      ▼
   Authorization
   (RBAC, ABAC, Node authorizer, Webhook authorizer)
      │
      ▼
   Mutating Admission
   ┌─────────────────────────────────────────┐
   │ Built-in mutating controllers           │
   │ Custom MutatingWebhookConfigurations    │
   │ (all run in parallel, then serialized)  │
   └─────────────────────────────────────────┘
      │
      ▼
   Object Schema Validation
      │
      ▼
   Validating Admission
   ┌─────────────────────────────────────────┐
   │ Built-in validating controllers         │
   │ Custom ValidatingWebhookConfigurations  │
   │ ValidatingAdmissionPolicies (CEL)       │
   │ (all run in parallel)                   │
   └─────────────────────────────────────────┘
      │
      ▼
   Persist to etcd
```

The distinction between mutating and validating phases is significant: mutating webhooks can modify the object before it persists, while validating webhooks can only accept or reject. This ordering ensures validators see the final form of the object including all mutations.

### Built-in Admission Controllers

The API server ships with numerous built-in controllers. Critical ones for production:

| Controller | Phase | Purpose |
|------------|-------|---------|
| `LimitRanger` | Both | Applies LimitRange defaults and validates bounds |
| `ResourceQuota` | Validating | Enforces ResourceQuota limits |
| `PodSecurity` | Validating | Enforces Pod Security Standards |
| `NodeRestriction` | Validating | Limits what kubelet can modify |
| `MutatingAdmissionWebhook` | Mutating | Delegates to external webhooks |
| `ValidatingAdmissionWebhook` | Validating | Delegates to external webhooks |
| `ServiceAccount` | Both | Adds service account tokens and imagePullSecrets |
| `DefaultStorageClass` | Mutating | Sets default StorageClass on PVCs |
| `StorageObjectInUseProtection` | Both | Prevents deletion of in-use PVCs |
| `NamespaceLifecycle` | Validating | Prevents operations in terminating namespaces |

### Checking Active Controllers

```bash
# View admission controllers enabled on the API server
kubectl get pods -n kube-system kube-apiserver-<node> -o yaml | \
  grep -A 10 enable-admission-plugins

# Or check the process args directly
ps aux | grep kube-apiserver | grep -o 'enable-admission-plugins=[^ ]*'

# For managed clusters (EKS, GKE, AKS) — use the cloud provider CLI
# EKS: admission plugins are managed by AWS
aws eks describe-cluster --name production-cluster \
  --query "cluster.kubernetesNetworkConfig"
```

## ValidatingWebhookConfiguration

### Anatomy

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: production-policy-validator
  annotations:
    # Avoid infinite loops — exclude the webhook's own namespace
    helm.sh/chart: admission-webhooks-1.2.0
webhooks:
  - name: validate-pod-security.policy.example.com
    # Failure policy controls what happens when the webhook is unreachable
    failurePolicy: Fail  # Fail | Ignore
    # Match policy: Exact (default) or Equivalent
    matchPolicy: Equivalent
    # Side effects declaration
    sideEffects: None  # None | Some | NoneOnDryRun | Unknown
    # Timeout in seconds (1-30, default 10)
    timeoutSeconds: 10
    # Reinvocation policy (Mutating only): Never | IfNeeded
    admissionReviewVersions: ["v1", "v1beta1"]
    # The webhook server to call
    clientConfig:
      service:
        name: admission-webhook
        namespace: webhook-system
        port: 443
        path: /validate/pods
      caBundle: <base64-encoded-CA>  # Validates the webhook's TLS certificate
    # What objects trigger this webhook
    rules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["pods"]
        scope: "Namespaced"  # Namespaced | Cluster | *
    # Namespace selector — skip system namespaces
    namespaceSelector:
      matchExpressions:
        - key: kubernetes.io/metadata.name
          operator: NotIn
          values:
            - kube-system
            - kube-public
            - webhook-system  # Avoid bootstrapping issues
    # Object selector — only evaluate pods with specific labels
    objectSelector:
      matchExpressions:
        - key: webhook.policy.example.com/skip
          operator: DoesNotExist
```

### WebhookConfiguration Fields Explained

**failurePolicy**

`Fail` means that if the webhook server is unreachable or returns an error, the API request is rejected. This is the secure default for security-critical policies. `Ignore` allows the request through if the webhook fails, suitable for non-critical enhancement webhooks.

```yaml
# Security-critical: use Fail
failurePolicy: Fail

# Non-critical enhancement (e.g., default label injection):
failurePolicy: Ignore
```

**sideEffects**

Webhooks must declare whether they have side effects (writes to external systems):

```yaml
# Webhook only reads the admission request, no external writes
sideEffects: None

# Webhook may write to external systems during dry-run calls
sideEffects: NoneOnDryRun

# Webhook writes to external systems (prevents dry-run from working correctly)
sideEffects: Some
```

Webhooks declaring `None` or `NoneOnDryRun` are safe to call during `kubectl apply --dry-run=server`.

**matchPolicy**

`Equivalent` ensures webhooks trigger even when the API group or version differs from what's listed in `rules`. This is important as Kubernetes evolves API versions:

```yaml
# Triggers for both apps/v1 Deployment and extensions/v1beta1 Deployment
matchPolicy: Equivalent
rules:
  - apiGroups: ["apps"]
    apiVersions: ["v1"]
    resources: ["deployments"]
```

## MutatingWebhookConfiguration

### Mutation Use Cases

Mutating webhooks inject defaults, add required fields, or transform objects before persistence. Common production use cases:

- Injecting sidecar containers (Istio, Linkerd, Datadog agents)
- Setting default resource requests/limits
- Adding required labels and annotations
- Injecting environment variables
- Setting imagePullPolicy
- Adding tolerations for node selectors

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: sidecar-injector
webhooks:
  - name: inject-sidecar.mesh.example.com
    failurePolicy: Ignore  # Don't break pods if sidecar injection fails
    sideEffects: None
    timeoutSeconds: 5
    admissionReviewVersions: ["v1"]
    reinvocationPolicy: Never  # IfNeeded | Never
    clientConfig:
      service:
        name: sidecar-injector
        namespace: mesh-system
        port: 443
        path: /inject
      caBundle: <base64-encoded-CA>
    rules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        operations: ["CREATE"]
        resources: ["pods"]
    namespaceSelector:
      matchLabels:
        mesh.example.com/injection: enabled
    objectSelector:
      matchExpressions:
        - key: mesh.example.com/inject
          operator: NotIn
          values: ["false"]
```

### Reinvocation Policy

When multiple mutating webhooks modify the same object, the reinvocation policy controls whether a webhook is called again after another webhook modifies the object:

```yaml
# IfNeeded: Re-invoked if another webhook modifies the object after this one runs
# Useful for webhooks that depend on other injected fields
reinvocationPolicy: IfNeeded

# Never: Called exactly once regardless of subsequent mutations
reinvocationPolicy: Never
```

### Object Selectors

Object selectors filter based on the object's labels. Namespace selectors filter based on the namespace's labels. Both support complex expressions:

```yaml
# Only match pods with specific environment label
objectSelector:
  matchExpressions:
    - key: environment
      operator: In
      values: ["production", "staging"]
    - key: skip-admission
      operator: DoesNotExist

# Only match namespaces with team label
namespaceSelector:
  matchLabels:
    kubernetes.io/metadata.name: finance
  matchExpressions:
    - key: admission.policy/skip
      operator: DoesNotExist
```

## Webhook Server Implementation

### Go Webhook Server

```go
package main

import (
    "context"
    "crypto/tls"
    "encoding/json"
    "fmt"
    "io"
    "log"
    "net/http"
    "os"
    "os/signal"
    "syscall"

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
    _ = admissionv1.AddToScheme(scheme)
    _ = corev1.AddToScheme(scheme)
}

type WebhookServer struct {
    server *http.Server
}

// admissionResponse creates a standard AdmissionResponse
func admissionResponse(uid string, allowed bool, message string) *admissionv1.AdmissionResponse {
    resp := &admissionv1.AdmissionResponse{
        UID:     admissionv1.UID(uid),
        Allowed: allowed,
    }
    if !allowed {
        resp.Result = &metav1.Status{
            Code:    403,
            Message: message,
        }
    }
    return resp
}

// validatePod implements the core validation logic
func validatePod(pod *corev1.Pod) (bool, string) {
    // Policy 1: All containers must have resource requests and limits
    for _, container := range pod.Spec.Containers {
        if container.Resources.Requests == nil || container.Resources.Limits == nil {
            return false, fmt.Sprintf(
                "container %q must have resource requests and limits defined",
                container.Name,
            )
        }
        if _, hasCPU := container.Resources.Requests[corev1.ResourceCPU]; !hasCPU {
            return false, fmt.Sprintf("container %q must have CPU request", container.Name)
        }
        if _, hasMem := container.Resources.Requests[corev1.ResourceMemory]; !hasMem {
            return false, fmt.Sprintf("container %q must have memory request", container.Name)
        }
    }

    // Policy 2: No privileged containers
    for _, container := range pod.Spec.Containers {
        if container.SecurityContext != nil &&
            container.SecurityContext.Privileged != nil &&
            *container.SecurityContext.Privileged {
            return false, fmt.Sprintf(
                "container %q must not run as privileged",
                container.Name,
            )
        }
    }

    // Policy 3: Required labels
    requiredLabels := []string{"app", "version", "team"}
    for _, label := range requiredLabels {
        if _, ok := pod.Labels[label]; !ok {
            return false, fmt.Sprintf("pod must have label %q", label)
        }
    }

    return true, ""
}

// mutatePod injects required defaults
func mutatePod(pod *corev1.Pod) []map[string]interface{} {
    patches := []map[string]interface{}{}

    // Inject default labels if missing
    if pod.Labels == nil {
        patches = append(patches, map[string]interface{}{
            "op":    "add",
            "path":  "/metadata/labels",
            "value": map[string]string{},
        })
    }

    if _, ok := pod.Labels["managed-by"]; !ok {
        patches = append(patches, map[string]interface{}{
            "op":    "add",
            "path":  "/metadata/labels/managed-by",
            "value": "platform-team",
        })
    }

    // Inject security context defaults
    for i, container := range pod.Spec.InitContainers {
        if container.SecurityContext == nil {
            readOnly := true
            allowPrivilegeEscalation := false
            patches = append(patches, map[string]interface{}{
                "op":   "add",
                "path": fmt.Sprintf("/spec/initContainers/%d/securityContext", i),
                "value": map[string]interface{}{
                    "readOnlyRootFilesystem":   readOnly,
                    "allowPrivilegeEscalation": allowPrivilegeEscalation,
                },
            })
        }
    }

    return patches
}

func (ws *WebhookServer) handleValidate(w http.ResponseWriter, r *http.Request) {
    body, err := io.ReadAll(r.Body)
    if err != nil {
        http.Error(w, fmt.Sprintf("reading body: %v", err), http.StatusBadRequest)
        return
    }

    var admissionReview admissionv1.AdmissionReview
    if _, _, err := codecs.UniversalDeserializer().Decode(body, nil, &admissionReview); err != nil {
        http.Error(w, fmt.Sprintf("decoding admission review: %v", err), http.StatusBadRequest)
        return
    }

    req := admissionReview.Request

    var pod corev1.Pod
    if err := json.Unmarshal(req.Object.Raw, &pod); err != nil {
        http.Error(w, fmt.Sprintf("decoding pod: %v", err), http.StatusBadRequest)
        return
    }

    allowed, message := validatePod(&pod)
    response := admissionResponse(string(req.UID), allowed, message)

    admissionReview.Response = response
    w.Header().Set("Content-Type", "application/json")
    if err := json.NewEncoder(w).Encode(admissionReview); err != nil {
        log.Printf("Error encoding response: %v", err)
    }
}

func (ws *WebhookServer) handleMutate(w http.ResponseWriter, r *http.Request) {
    body, err := io.ReadAll(r.Body)
    if err != nil {
        http.Error(w, fmt.Sprintf("reading body: %v", err), http.StatusBadRequest)
        return
    }

    var admissionReview admissionv1.AdmissionReview
    if _, _, err := codecs.UniversalDeserializer().Decode(body, nil, &admissionReview); err != nil {
        http.Error(w, fmt.Sprintf("decoding admission review: %v", err), http.StatusBadRequest)
        return
    }

    req := admissionReview.Request

    var pod corev1.Pod
    if err := json.Unmarshal(req.Object.Raw, &pod); err != nil {
        http.Error(w, fmt.Sprintf("decoding pod: %v", err), http.StatusBadRequest)
        return
    }

    patches := mutatePod(&pod)
    patchBytes, err := json.Marshal(patches)
    if err != nil {
        http.Error(w, fmt.Sprintf("encoding patches: %v", err), http.StatusInternalServerError)
        return
    }

    patchType := admissionv1.PatchTypeJSONPatch
    response := &admissionv1.AdmissionResponse{
        UID:       req.UID,
        Allowed:   true,
        Patch:     patchBytes,
        PatchType: &patchType,
    }

    admissionReview.Response = response
    w.Header().Set("Content-Type", "application/json")
    if err := json.NewEncoder(w).Encode(admissionReview); err != nil {
        log.Printf("Error encoding response: %v", err)
    }
}

func main() {
    certFile := os.Getenv("TLS_CERT_FILE")
    keyFile := os.Getenv("TLS_KEY_FILE")

    if certFile == "" {
        certFile = "/etc/webhook/certs/tls.crt"
    }
    if keyFile == "" {
        keyFile = "/etc/webhook/certs/tls.key"
    }

    cert, err := tls.LoadX509KeyPair(certFile, keyFile)
    if err != nil {
        log.Fatalf("Loading TLS certificates: %v", err)
    }

    mux := http.NewServeMux()

    ws := &WebhookServer{}
    mux.HandleFunc("/validate/pods", ws.handleValidate)
    mux.HandleFunc("/mutate/pods", ws.handleMutate)
    mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    })

    server := &http.Server{
        Addr:    ":8443",
        Handler: mux,
        TLSConfig: &tls.Config{
            Certificates: []tls.Certificate{cert},
            MinVersion:   tls.VersionTLS13,
        },
    }

    ws.server = server

    go func() {
        log.Printf("Starting webhook server on :8443")
        if err := server.ListenAndServeTLS("", ""); err != nil && err != http.ErrServerClosed {
            log.Fatalf("Webhook server error: %v", err)
        }
    }()

    // Graceful shutdown
    stop := make(chan os.Signal, 1)
    signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
    <-stop

    ctx, cancel := context.WithTimeout(context.Background(), 10)
    defer cancel()

    if err := server.Shutdown(ctx); err != nil {
        log.Printf("Error during shutdown: %v", err)
    }
}
```

### Certificate Management for Webhooks

Webhook servers must serve TLS. The most reliable production approach uses cert-manager:

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: webhook-server-cert
  namespace: webhook-system
spec:
  secretName: webhook-server-tls
  duration: 8760h   # 1 year
  renewBefore: 720h # 30 days before expiry
  subject:
    organizations:
      - example.com
  isCA: false
  privateKey:
    algorithm: RSA
    size: 2048
  usages:
    - digital signature
    - key encipherment
    - server auth
  dnsNames:
    - admission-webhook.webhook-system.svc
    - admission-webhook.webhook-system.svc.cluster.local
  issuerRef:
    name: cluster-ca-issuer
    kind: ClusterIssuer
---
# Inject CA bundle into webhook configuration
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: webhook-ca-injector
  namespace: webhook-system
  annotations:
    cert-manager.io/inject-ca-from: webhook-system/webhook-server-cert
```

### Deployment and RBAC

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: admission-webhook
  namespace: webhook-system
spec:
  replicas: 2  # HA — critical for failurePolicy: Fail
  selector:
    matchLabels:
      app: admission-webhook
  template:
    metadata:
      labels:
        app: admission-webhook
    spec:
      serviceAccountName: admission-webhook
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: admission-webhook
      containers:
        - name: webhook
          image: registry.example.com/admission-webhook:v1.0.0
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
            - name: tls-certs
              mountPath: /etc/webhook/certs
              readOnly: true
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 3
            periodSeconds: 5
      volumes:
        - name: tls-certs
          secret:
            secretName: webhook-server-tls
---
apiVersion: v1
kind: Service
metadata:
  name: admission-webhook
  namespace: webhook-system
spec:
  selector:
    app: admission-webhook
  ports:
    - port: 443
      targetPort: 8443
      name: https
---
# PodDisruptionBudget to ensure webhook availability during node drain
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: admission-webhook-pdb
  namespace: webhook-system
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: admission-webhook
```

## CEL-Based Admission: ValidatingAdmissionPolicy

### Overview

ValidatingAdmissionPolicy (stable in Kubernetes 1.30) provides webhook-like validation using Common Expression Language (CEL) evaluated directly in the API server, eliminating the need to run and maintain a webhook server for many use cases.

### Basic ValidatingAdmissionPolicy

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: require-resource-limits
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["pods"]
  variables:
    - name: containers
      expression: "object.spec.containers"
    - name: initContainers
      expression: "has(object.spec.initContainers) ? object.spec.initContainers : []"
    - name: allContainers
      expression: "variables.containers + variables.initContainers"
  validations:
    - expression: |
        variables.allContainers.all(c,
          has(c.resources) &&
          has(c.resources.limits) &&
          has(c.resources.limits.cpu) &&
          has(c.resources.limits.memory)
        )
      message: "All containers must have CPU and memory limits"
      reason: Forbidden

    - expression: |
        variables.allContainers.all(c,
          has(c.resources) &&
          has(c.resources.requests) &&
          has(c.resources.requests.cpu) &&
          has(c.resources.requests.memory)
        )
      message: "All containers must have CPU and memory requests"
      reason: Forbidden

    - expression: |
        variables.allContainers.all(c,
          !(has(c.securityContext) &&
            has(c.securityContext.privileged) &&
            c.securityContext.privileged == true)
        )
      message: "Privileged containers are not permitted"
      reason: Forbidden
---
# Bind the policy to specific resources and namespaces
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: require-resource-limits-binding
spec:
  policyName: require-resource-limits
  validationActions: [Deny]  # Deny | Audit | Warn
  matchResources:
    namespaceSelector:
      matchExpressions:
        - key: kubernetes.io/metadata.name
          operator: NotIn
          values:
            - kube-system
            - kube-public
```

### Advanced CEL Policies

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: image-registry-policy
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups: ["", "apps", "batch"]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["pods", "deployments", "statefulsets", "daemonsets", "jobs", "cronjobs"]
  variables:
    - name: containers
      expression: |
        (has(object.spec.template) ? object.spec.template : object).spec.containers
    - name: initContainers
      expression: |
        has((has(object.spec.template) ? object.spec.template : object).spec.initContainers)
        ? (has(object.spec.template) ? object.spec.template : object).spec.initContainers
        : []
    - name: allImages
      expression: |
        (variables.containers + variables.initContainers).map(c, c.image)
    - name: allowedRegistries
      expression: |
        ["registry.example.com", "gcr.io/my-project", "docker.io/library"]
  validations:
    - expression: |
        variables.allImages.all(image,
          variables.allowedRegistries.exists(registry,
            image.startsWith(registry)
          )
        )
      messageExpression: |
        "Image(s) not from approved registries. Found: " +
        variables.allImages.filter(image,
          !variables.allowedRegistries.exists(registry, image.startsWith(registry))
        ).join(", ")
      reason: Forbidden

    - expression: |
        variables.allImages.all(image,
          !image.contains(":latest") && image.contains(":")
        )
      message: "Images must specify an explicit tag and must not use :latest"
      reason: Forbidden
---
# Policy with parameterization
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: namespace-label-policy
spec:
  failurePolicy: Fail
  paramKind:
    apiVersion: v1
    kind: ConfigMap
  matchConstraints:
    resourceRules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["namespaces"]
  validations:
    - expression: |
        params.data.requiredLabels.split(",").all(label,
          label in object.metadata.labels
        )
      messageExpression: |
        "Namespace must have labels: " + params.data.requiredLabels
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: required-namespace-labels
  namespace: kube-system
data:
  requiredLabels: "team,environment,cost-center"
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: namespace-label-policy-binding
spec:
  policyName: namespace-label-policy
  validationActions: [Deny]
  paramRef:
    name: required-namespace-labels
    namespace: kube-system
    parameterNotFoundAction: Deny
```

### CEL Audit Mode

The `Audit` validation action logs violations without rejecting requests, useful for policy rollout:

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: require-resource-limits-audit
spec:
  policyName: require-resource-limits
  validationActions: [Audit, Warn]  # Log to audit log and warn in response
  matchResources:
    namespaceSelector:
      matchLabels:
        policy/audit-mode: "true"
```

## OPA Gatekeeper

### Architecture

OPA Gatekeeper implements Kubernetes admission control using Open Policy Agent (OPA) as the policy engine. Policies are written in Rego and managed as Kubernetes custom resources.

```
                    ┌──────────────────────────────────┐
                    │        Gatekeeper Manager        │
                    │   (webhook + controller manager) │
                    └──────────────────────────────────┘
                              │
                    ┌─────────┴──────────┐
                    │                    │
           Constraint Templates    Constraints
           (Rego policies wrapped   (Instances of
            as CRDs)                templates with
                                     parameters)
```

### Installation

```bash
# Install Gatekeeper
kubectl apply -f https://raw.githubusercontent.com/open-policy-agent/gatekeeper/v3.14.0/deploy/gatekeeper.yaml

# Verify installation
kubectl get pods -n gatekeeper-system
kubectl get constrainttemplate
```

### Constraint Template

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequiredlabels
  annotations:
    metadata.gatekeeper.sh/title: "Required Labels"
    metadata.gatekeeper.sh/version: "1.0.0"
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
                description: "Label key to require"
            message:
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
          msg := sprintf(
            "%v: missing required labels: %v",
            [
              input.parameters.message,
              concat(", ", missing)
            ]
          )
        }
```

### Constraint

```yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredLabels
metadata:
  name: pods-must-have-required-labels
spec:
  enforcementAction: deny  # deny | warn | dryrun
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Pod"]
    excludedNamespaces:
      - kube-system
      - kube-public
      - gatekeeper-system
  parameters:
    labels:
      - app
      - version
      - team
    message: "Pod"
```

### Audit Functionality

Gatekeeper continuously audits existing resources for policy violations:

```bash
# View audit results
kubectl get k8srequiredlabels pods-must-have-required-labels -o yaml | \
  yq '.status.violations'

# Query all constraint violations
kubectl get constraints --all-namespaces -o json | \
  jq '.items[] | {name: .metadata.name, violations: .status.violations}'
```

## Kyverno

### Architecture

Kyverno is a policy engine designed specifically for Kubernetes, using YAML-based policies rather than a dedicated policy language like Rego.

```bash
# Install Kyverno
helm install kyverno kyverno/kyverno \
  --namespace kyverno \
  --create-namespace \
  --version 3.2.0 \
  --set admissionController.replicas=3 \
  --set backgroundController.replicas=2 \
  --set reportsController.replicas=2 \
  --set cleanupController.replicas=1
```

### Kyverno Policy Examples

```yaml
# Validation policy
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-labels
  annotations:
    policies.kyverno.io/title: "Require Labels"
    policies.kyverno.io/category: "Best Practices"
    policies.kyverno.io/severity: "medium"
    policies.kyverno.io/subject: "Pod"
spec:
  validationFailureAction: Enforce  # Enforce | Audit
  background: true
  rules:
    - name: check-required-labels
      match:
        any:
          - resources:
              kinds:
                - Pod
      exclude:
        any:
          - resources:
              namespaces:
                - kube-system
                - kube-public
                - kyverno
      validate:
        message: "Pods must have labels: app, version, and team"
        pattern:
          metadata:
            labels:
              app: "?*"
              version: "?*"
              team: "?*"
---
# Mutation policy
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: add-default-labels
spec:
  rules:
    - name: add-managed-by-label
      match:
        any:
          - resources:
              kinds:
                - Pod
      mutate:
        patchStrategicMerge:
          metadata:
            labels:
              +(managed-by): "platform-team"  # + means add only if not present
              +(injection-timestamp): "{{ time_now_utc() }}"
---
# Generation policy — create resources when other resources are created
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: generate-namespace-defaults
spec:
  rules:
    - name: generate-network-policy
      match:
        any:
          - resources:
              kinds:
                - Namespace
              selector:
                matchLabels:
                  generate-defaults: "true"
      generate:
        synchronize: true
        apiVersion: networking.k8s.io/v1
        kind: NetworkPolicy
        name: default-deny-ingress
        namespace: "{{ request.object.metadata.name }}"
        data:
          spec:
            podSelector: {}
            policyTypes:
              - Ingress
```

### Kyverno vs OPA Gatekeeper Comparison

| Capability | OPA Gatekeeper | Kyverno |
|------------|---------------|---------|
| Policy Language | Rego | YAML/JMESPath |
| Learning Curve | High (Rego) | Low (YAML) |
| Policy Mutation | Not supported natively | Native support |
| Policy Generation | Not supported | Native support |
| Policy Testing | conftest, opa test | kyverno test |
| Audit Scanning | Built-in | Built-in |
| Multi-cluster | External tooling | Policy Reports |
| Performance | OPA cache | Wasm compilation |
| CRD Generation | Templates + Constraints | Single Policy CR |
| Kubernetes-native | Yes | Yes |
| Community | Large, cross-platform | Large, K8s-focused |

**When to use OPA Gatekeeper:**
- Cross-platform policy enforcement (Kubernetes + Terraform + other systems)
- Team has Rego expertise or investment
- Complex policy logic that benefits from Rego's expressiveness
- Integration with existing OPA infrastructure

**When to use Kyverno:**
- Kubernetes-only environments
- Teams prefer YAML-native configuration
- Need mutation and generation capabilities alongside validation
- Rapid policy development without learning Rego

## Production Webhook Best Practices

### High Availability Configuration

```yaml
# Ensure webhook can withstand node failures
apiVersion: apps/v1
kind: Deployment
metadata:
  name: admission-webhook
  namespace: webhook-system
spec:
  replicas: 3
  strategy:
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0  # Zero downtime updates
  template:
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: admission-webhook
              topologyKey: kubernetes.io/hostname
      # Prioritize webhook pods
      priorityClassName: system-cluster-critical
```

### Timeout Tuning

```yaml
webhooks:
  - name: validate-pods.policy.example.com
    # Conservative timeout for critical paths
    timeoutSeconds: 10
    # For computationally expensive policies
    # timeoutSeconds: 25  # Maximum is 30

    # If webhook consistently times out, investigate:
    # 1. Webhook server resource constraints
    # 2. Network policy blocking webhook traffic
    # 3. Policy complexity causing slow evaluation
```

### Namespace Exclusion Strategy

```yaml
# Always exclude system namespaces from non-critical webhooks
namespaceSelector:
  matchExpressions:
    - key: kubernetes.io/metadata.name
      operator: NotIn
      values:
        - kube-system
        - kube-public
        - kube-node-lease
        - webhook-system     # Avoid bootstrapping deadlock
        - cert-manager       # Cert rotation must work
        - monitoring         # Monitoring must work during incidents
        - gatekeeper-system  # Policy engine must function
```

### Webhook Performance Monitoring

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: admission-webhook-alerts
  namespace: monitoring
spec:
  groups:
    - name: admission-webhooks
      rules:
        - alert: AdmissionWebhookHighLatency
          expr: |
            histogram_quantile(0.99,
              rate(apiserver_admission_webhook_admission_duration_seconds_bucket[5m])
            ) > 5
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "Admission webhook {{ $labels.name }} p99 latency > 5s"

        - alert: AdmissionWebhookRejectionRate
          expr: |
            rate(apiserver_admission_webhook_rejection_count[5m]) > 0
          for: 1m
          labels:
            severity: warning
          annotations:
            summary: "Admission webhook {{ $labels.name }} is rejecting requests"

        - alert: AdmissionWebhookFailurePolicy
          expr: |
            rate(apiserver_admission_webhook_fail_open_count[5m]) > 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Webhook {{ $labels.name }} failed and was opened (failurePolicy: Ignore)"
```

### Testing Webhooks

```bash
# Test webhook logic without deploying
# Use a dry-run to validate webhook behavior

# Test a pod that should be rejected
cat <<'EOF' | kubectl apply --dry-run=server -f -
apiVersion: v1
kind: Pod
metadata:
  name: test-pod
  namespace: team-alpha
spec:
  containers:
    - name: app
      image: nginx:latest
      # Missing resource requests/limits — should be rejected
EOF

# Test a pod that should be accepted
cat <<'EOF' | kubectl apply --dry-run=server -f -
apiVersion: v1
kind: Pod
metadata:
  name: test-pod-valid
  namespace: team-alpha
  labels:
    app: test
    version: v1.0.0
    team: platform
spec:
  containers:
    - name: app
      image: registry.example.com/nginx:1.25.0
      resources:
        requests:
          cpu: 100m
          memory: 128Mi
        limits:
          cpu: 500m
          memory: 256Mi
      securityContext:
        privileged: false
        readOnlyRootFilesystem: true
        allowPrivilegeEscalation: false
EOF

# View webhook processing in audit logs
kubectl get --raw '/apis/audit.k8s.io/v1' 2>/dev/null || \
  echo "Check audit log file at /var/log/kubernetes/audit.log"
```

## Summary

Kubernetes admission controllers provide a powerful framework for enforcing organizational policies at the API level. The recommended architecture for production clusters:

1. Use CEL-based `ValidatingAdmissionPolicy` for simple, stateless validation rules — no webhook server to maintain
2. Deploy custom webhooks for complex logic requiring external state, mutation, or generation
3. Choose Kyverno for Kubernetes-native teams preferring YAML policies with mutation and generation support
4. Choose OPA Gatekeeper for cross-platform environments or teams with Rego expertise
5. Always deploy webhook servers with HA (minimum 2 replicas), PodDisruptionBudgets, and `system-cluster-critical` priority
6. Use `failurePolicy: Fail` for security-critical webhooks and `failurePolicy: Ignore` for optional enhancements
7. Exclude system namespaces from non-essential webhooks to prevent cluster bootstrapping deadlocks
8. Monitor webhook latency and error rates — admission control failures impact all cluster operations
