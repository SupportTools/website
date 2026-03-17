---
title: "Kubernetes Admission Controllers: Security Enforcement at Scale"
date: 2027-10-03T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Admission Controllers", "Security", "OPA", "Kyverno"]
categories:
- Security
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Kubernetes admission control — ValidatingAdmissionWebhook vs MutatingAdmissionWebhook architecture, custom Go webhooks, OPA Gatekeeper ConstraintTemplates, Kyverno policies, CEL admission policies, webhook latency, and defense-in-depth strategy."
more_link: "yes"
url: "/admission-controllers-kubernetes-security-guide/"
---

Admission controllers are the last line of defense before a Kubernetes object is persisted to etcd. They intercept API server requests after authentication and authorization but before storage, enabling policy enforcement, mutation of resource defaults, and rejection of non-compliant workloads. Understanding the admission control pipeline — from the webhook architecture to OPA Gatekeeper ConstraintTemplates, Kyverno policies, and the new CEL-based ValidatingAdmissionPolicy — is essential for building a defense-in-depth security posture at scale.

<!--more-->

# Kubernetes Admission Controllers: Security Enforcement at Scale

## Section 1: Admission Control Architecture

The Kubernetes API server processes requests through a multi-stage pipeline before persisting objects.

### Request Processing Pipeline

```
Client Request (kubectl apply, Helm, ArgoCD)
         │
         ▼
   Authentication (OIDC, ServiceAccount, x509)
         │
         ▼
   Authorization (RBAC)
         │
         ▼
   Mutating Admission Webhooks ← Runs first, can modify objects
         │                       Multiple webhooks run in order
         ▼
   Object Schema Validation
         │
         ▼
   Validating Admission Webhooks ← Runs second, reject/approve only
         │                         Multiple webhooks run in parallel
         ▼
   etcd persistence
```

### Mutating vs Validating Webhooks

```
MutatingAdmissionWebhook:
  - Modifies the incoming object (inject sidecars, set defaults)
  - Runs BEFORE validators
  - Can return modified object + allow/deny
  - Used by: Istio (sidecar injection), cert-manager (annotations), Kyverno (mutation)

ValidatingAdmissionWebhook:
  - Validates only — cannot modify
  - All validators run in parallel
  - Any rejection fails the request
  - Used by: OPA Gatekeeper, custom policy engines

ValidatingAdmissionPolicy (CEL, GA in 1.30):
  - In-cluster, no webhook required
  - Evaluated by API server directly
  - Lower latency than external webhooks
  - Expression-based using CEL (Common Expression Language)
```

## Section 2: Custom Webhook in Go

### Webhook Server Structure

```go
// main.go
package main

import (
	"crypto/tls"
	"flag"
	"fmt"
	"net/http"
	"os"
	"time"

	admissionv1 "k8s.io/api/admission/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/serializer"
	"go.uber.org/zap"
)

var (
	scheme = runtime.NewScheme()
	codecs = serializer.NewCodecFactory(scheme)
)

func main() {
	var (
		certFile = flag.String("tls-cert-file", "/certs/tls.crt", "TLS certificate file")
		keyFile  = flag.String("tls-key-file", "/certs/tls.key", "TLS private key file")
		port     = flag.Int("port", 8443, "HTTPS server port")
	)
	flag.Parse()

	logger, _ := zap.NewProduction()
	defer logger.Sync()

	mux := http.NewServeMux()
	mux.Handle("/validate/pods", &admissionHandler{
		logger:    logger,
		validator: validatePod,
	})
	mux.Handle("/mutate/pods", &admissionHandler{
		logger:    logger,
		validator: mutatePod,
	})
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	cert, err := tls.LoadX509KeyPair(*certFile, *keyFile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to load certificates: %v\n", err)
		os.Exit(1)
	}

	server := &http.Server{
		Addr:    fmt.Sprintf(":%d", *port),
		Handler: mux,
		TLSConfig: &tls.Config{
			Certificates: []tls.Certificate{cert},
			MinVersion:   tls.VersionTLS12,
		},
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	logger.Info("Starting admission webhook server", zap.Int("port", *port))
	if err := server.ListenAndServeTLS("", ""); err != nil {
		fmt.Fprintf(os.Stderr, "Server failed: %v\n", err)
		os.Exit(1)
	}
}
```

### Admission Handler

```go
// handler.go
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	admissionv1 "k8s.io/api/admission/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"go.uber.org/zap"
)

type admissionHandler struct {
	logger    *zap.Logger
	validator func(*admissionv1.AdmissionRequest) (*admissionv1.AdmissionResponse, error)
}

func (h *admissionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if ct := r.Header.Get("Content-Type"); ct != "application/json" {
		http.Error(w, "Invalid content type", http.StatusBadRequest)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read body", http.StatusBadRequest)
		return
	}

	var review admissionv1.AdmissionReview
	if err := json.Unmarshal(body, &review); err != nil {
		http.Error(w, fmt.Sprintf("Failed to decode request: %v", err), http.StatusBadRequest)
		return
	}

	resp, err := h.validator(review.Request)
	if err != nil {
		h.logger.Error("Admission validation error", zap.Error(err))
		resp = &admissionv1.AdmissionResponse{
			UID:     review.Request.UID,
			Allowed: false,
			Result: &metav1.Status{
				Message: err.Error(),
			},
		}
	}
	resp.UID = review.Request.UID

	review.Response = resp
	output, err := json.Marshal(review)
	if err != nil {
		http.Error(w, "Failed to encode response", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write(output)
}
```

### Pod Validator

```go
// validators.go
package main

import (
	"encoding/json"
	"fmt"
	"strings"

	admissionv1 "k8s.io/api/admission/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func validatePod(req *admissionv1.AdmissionRequest) (*admissionv1.AdmissionResponse, error) {
	var pod corev1.Pod
	if err := json.Unmarshal(req.Object.Raw, &pod); err != nil {
		return nil, fmt.Errorf("failed to decode pod: %w", err)
	}

	var violations []string

	for _, c := range pod.Spec.Containers {
		// Require resource requests
		if c.Resources.Requests.Cpu().IsZero() {
			violations = append(violations, fmt.Sprintf("container %q missing CPU request", c.Name))
		}
		if c.Resources.Requests.Memory().IsZero() {
			violations = append(violations, fmt.Sprintf("container %q missing memory request", c.Name))
		}

		// Require non-root
		if c.SecurityContext == nil || c.SecurityContext.RunAsNonRoot == nil || !*c.SecurityContext.RunAsNonRoot {
			violations = append(violations, fmt.Sprintf("container %q must set runAsNonRoot=true", c.Name))
		}

		// Block privileged containers in non-system namespaces
		if req.Namespace != "kube-system" && req.Namespace != "monitoring" {
			if c.SecurityContext != nil && c.SecurityContext.Privileged != nil && *c.SecurityContext.Privileged {
				violations = append(violations, fmt.Sprintf("container %q cannot be privileged", c.Name))
			}
		}

		// Require read-only root filesystem in production namespaces
		if isProductionNamespace(req.Namespace) {
			if c.SecurityContext == nil || c.SecurityContext.ReadOnlyRootFilesystem == nil || !*c.SecurityContext.ReadOnlyRootFilesystem {
				violations = append(violations, fmt.Sprintf("container %q must use readOnlyRootFilesystem in production", c.Name))
			}
		}

		// Block latest tag
		if strings.HasSuffix(c.Image, ":latest") || !strings.Contains(c.Image, ":") {
			violations = append(violations, fmt.Sprintf("container %q must specify an explicit image tag (not :latest)", c.Name))
		}
	}

	// Require labels
	requiredLabels := []string{"app", "team"}
	for _, label := range requiredLabels {
		if _, ok := pod.Labels[label]; !ok {
			violations = append(violations, fmt.Sprintf("pod missing required label %q", label))
		}
	}

	if len(violations) > 0 {
		return &admissionv1.AdmissionResponse{
			Allowed: false,
			Result: &metav1.Status{
				Message: strings.Join(violations, "; "),
				Code:    400,
			},
		}, nil
	}

	return &admissionv1.AdmissionResponse{Allowed: true}, nil
}

func isProductionNamespace(ns string) bool {
	productionNamespaces := map[string]bool{
		"payments": true, "orders": true, "checkout": true,
		"api-gateway": true, "production": true,
	}
	return productionNamespaces[ns]
}
```

### Mutating Webhook — Inject Defaults

```go
// mutators.go
package main

import (
	"encoding/json"
	"fmt"

	admissionv1 "k8s.io/api/admission/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
)

type patchOperation struct {
	Op    string      `json:"op"`
	Path  string      `json:"path"`
	Value interface{} `json:"value,omitempty"`
}

func mutatePod(req *admissionv1.AdmissionRequest) (*admissionv1.AdmissionResponse, error) {
	var pod corev1.Pod
	if err := json.Unmarshal(req.Object.Raw, &pod); err != nil {
		return nil, fmt.Errorf("failed to decode pod: %w", err)
	}

	var patches []patchOperation

	// Initialize labels if nil
	if pod.Labels == nil {
		patches = append(patches, patchOperation{
			Op:    "add",
			Path:  "/metadata/labels",
			Value: map[string]string{},
		})
	}

	// Add default labels
	if _, ok := pod.Labels["managed-by"]; !ok {
		patches = append(patches, patchOperation{
			Op:    "add",
			Path:  "/metadata/labels/managed-by",
			Value: "kubernetes",
		})
	}

	// Set default resource requests if missing
	cpuDefault := resource.MustParse("100m")
	memDefault := resource.MustParse("128Mi")

	for i, c := range pod.Spec.Containers {
		if c.Resources.Requests == nil {
			patches = append(patches, patchOperation{
				Op:    "add",
				Path:  fmt.Sprintf("/spec/containers/%d/resources/requests", i),
				Value: corev1.ResourceList{
					corev1.ResourceCPU:    cpuDefault,
					corev1.ResourceMemory: memDefault,
				},
			})
		}

		// Inject default securityContext
		if c.SecurityContext == nil {
			trueVal := true
			userID := int64(1000)
			patches = append(patches, patchOperation{
				Op:   "add",
				Path: fmt.Sprintf("/spec/containers/%d/securityContext", i),
				Value: &corev1.SecurityContext{
					RunAsNonRoot:             &trueVal,
					RunAsUser:                &userID,
					AllowPrivilegeEscalation: boolPtr(false),
					Capabilities: &corev1.Capabilities{
						Drop: []corev1.Capability{"ALL"},
					},
				},
			})
		}
	}

	patchBytes, err := json.Marshal(patches)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal patches: %w", err)
	}

	patchType := admissionv1.PatchTypeJSONPatch
	return &admissionv1.AdmissionResponse{
		Allowed:   true,
		Patch:     patchBytes,
		PatchType: &patchType,
	}, nil
}

func boolPtr(b bool) *bool { return &b }
```

### Webhook Registration

```yaml
# webhook-config.yaml
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: acme-pod-defaults
  annotations:
    cert-manager.io/inject-ca-from: webhook-system/webhook-cert
spec:
  webhooks:
    - name: pod-defaults.acme.internal
      admissionReviewVersions: ["v1"]
      sideEffects: None
      failurePolicy: Ignore  # Don't block pods if webhook is down
      timeoutSeconds: 5
      reinvocationPolicy: Never
      clientConfig:
        service:
          name: acme-admission-webhook
          namespace: webhook-system
          path: /mutate/pods
      rules:
        - apiGroups: [""]
          apiVersions: ["v1"]
          resources: ["pods"]
          operations: ["CREATE"]
      namespaceSelector:
        matchExpressions:
          - key: kubernetes.io/metadata.name
            operator: NotIn
            values:
              - kube-system
              - kube-public
              - webhook-system
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: acme-pod-validator
  annotations:
    cert-manager.io/inject-ca-from: webhook-system/webhook-cert
spec:
  webhooks:
    - name: pod-validator.acme.internal
      admissionReviewVersions: ["v1"]
      sideEffects: None
      failurePolicy: Fail
      timeoutSeconds: 10
      clientConfig:
        service:
          name: acme-admission-webhook
          namespace: webhook-system
          path: /validate/pods
      rules:
        - apiGroups: [""]
          apiVersions: ["v1"]
          resources: ["pods"]
          operations: ["CREATE", "UPDATE"]
      namespaceSelector:
        matchLabels:
          admission-control: enabled
```

## Section 3: OPA Gatekeeper

### Gatekeeper Installation

```bash
helm repo add gatekeeper https://open-policy-agent.github.io/gatekeeper/charts
helm repo update

helm upgrade --install gatekeeper gatekeeper/gatekeeper \
  --namespace gatekeeper-system \
  --create-namespace \
  --set replicas=3 \
  --set controllerManager.resources.requests.cpu=100m \
  --set controllerManager.resources.requests.memory=512Mi \
  --set audit.resources.requests.cpu=100m \
  --set audit.resources.requests.memory=512Mi \
  --set auditInterval=60 \
  --set auditMatchKindOnly=false \
  --version 3.16.0 \
  --wait
```

### ConstraintTemplate — Required Labels

```yaml
# constraint-template-required-labels.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequiredlabels
  annotations:
    description: Requires that all resources have specified labels
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
                type: object
                properties:
                  key:
                    type: string
                  allowedRegex:
                    type: string
            message:
              type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8srequiredlabels

        violation[{"msg": msg, "details": {"missing_labels": missing}}] {
          provided := {label | input.review.object.metadata.labels[label]}
          required := {label | input.parameters.labels[_].key = label}
          missing := required - provided
          count(missing) > 0
          msg := sprintf("Missing required labels: %v. %v", [missing, input.parameters.message])
        }

        violation[{"msg": msg}] {
          label := input.parameters.labels[_]
          value := input.review.object.metadata.labels[label.key]
          label.allowedRegex != ""
          not re_match(label.allowedRegex, value)
          msg := sprintf("Label '%v' value '%v' does not match regex '%v'", [label.key, value, label.allowedRegex])
        }
```

### Constraint — Enforce Labels

```yaml
# constraint-required-labels.yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredLabels
metadata:
  name: production-required-labels
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: ["apps"]
        kinds:
          - Deployment
          - StatefulSet
          - DaemonSet
    namespaceSelector:
      matchLabels:
        environment: production
  parameters:
    message: "All production workloads must have required labels for cost allocation and ownership"
    labels:
      - key: app
      - key: team
      - key: cost-center
        allowedRegex: "^CC-[0-9]{4}$"
      - key: version
```

### ConstraintTemplate — Container Security Context

```yaml
# constraint-template-container-security.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8scontainersecurity
spec:
  crd:
    spec:
      names:
        kind: K8sContainerSecurity
      validation:
        openAPIV3Schema:
          type: object
          properties:
            allowPrivileged:
              type: boolean
            requireReadOnlyRootFilesystem:
              type: boolean
            requireNonRoot:
              type: boolean
            allowedCapabilities:
              type: array
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8scontainersecurity

        violation[{"msg": msg}] {
          c := input.review.object.spec.containers[_]
          c.securityContext.privileged == true
          not input.parameters.allowPrivileged
          msg := sprintf("Container '%v' cannot be privileged", [c.name])
        }

        violation[{"msg": msg}] {
          c := input.review.object.spec.containers[_]
          input.parameters.requireReadOnlyRootFilesystem
          not c.securityContext.readOnlyRootFilesystem
          msg := sprintf("Container '%v' must use readOnlyRootFilesystem", [c.name])
        }

        violation[{"msg": msg}] {
          c := input.review.object.spec.containers[_]
          input.parameters.requireNonRoot
          not c.securityContext.runAsNonRoot
          msg := sprintf("Container '%v' must set runAsNonRoot=true", [c.name])
        }

        violation[{"msg": msg}] {
          c := input.review.object.spec.containers[_]
          cap := c.securityContext.capabilities.add[_]
          not cap_allowed(cap)
          msg := sprintf("Container '%v' requests disallowed capability '%v'", [c.name, cap])
        }

        cap_allowed(cap) {
          cap == input.parameters.allowedCapabilities[_]
        }
```

## Section 4: Kyverno Policies

### Kyverno Installation

```bash
helm repo add kyverno https://kyverno.github.io/kyverno/
helm repo update

helm upgrade --install kyverno kyverno/kyverno \
  --namespace kyverno \
  --create-namespace \
  --set replicaCount=3 \
  --set admissionController.resources.requests.cpu=100m \
  --set admissionController.resources.requests.memory=256Mi \
  --set backgroundController.enabled=true \
  --set cleanupController.enabled=true \
  --version 3.2.0 \
  --wait
```

### Kyverno Policy — Validate and Mutate

```yaml
# kyverno-policy-production.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: production-security-baseline
  annotations:
    policies.kyverno.io/title: Production Security Baseline
    policies.kyverno.io/category: Security, Best Practices
    policies.kyverno.io/severity: high
    policies.kyverno.io/description: >
      Enforces security baseline for all production workloads:
      required labels, resource limits, non-root containers,
      and image digest pinning.
spec:
  validationFailureAction: Enforce
  background: true
  rules:
    # Rule 1: Require resource limits
    - name: require-resource-limits
      match:
        any:
          - resources:
              kinds:
                - Pod
              namespaceSelector:
                matchLabels:
                  environment: production
      validate:
        message: "CPU and memory limits are required for production pods"
        pattern:
          spec:
            containers:
              - name: "*"
                resources:
                  limits:
                    cpu: "?*"
                    memory: "?*"
                  requests:
                    cpu: "?*"
                    memory: "?*"

    # Rule 2: Disallow latest image tag
    - name: disallow-latest-tag
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
                - monitoring
      validate:
        message: "Image tag ':latest' or missing tag is not allowed. Pin to a specific version or digest."
        foreach:
          - list: "request.object.spec.containers"
            deny:
              conditions:
                any:
                  - key: "{{element.image}}"
                    operator: Equals
                    value: "*:latest"
                  - key: "{{element.image}}"
                    operator: NotEquals
                    value: "*:*"

    # Rule 3: Require non-root
    - name: require-run-as-non-root
      match:
        any:
          - resources:
              kinds:
                - Pod
              namespaceSelector:
                matchLabels:
                  environment: production
      validate:
        message: "Containers must run as non-root user"
        pattern:
          spec:
            securityContext:
              runAsNonRoot: true
            =(initContainers):
              - =(securityContext):
                  =(runAsNonRoot): true

    # Rule 4: Mutate — add default labels
    - name: add-default-labels
      match:
        any:
          - resources:
              kinds:
                - Pod
      mutate:
        patchStrategicMerge:
          metadata:
            labels:
              +(managed-by): kubernetes
              +(admission-mutated: "true"

    # Rule 5: Mutate — drop all capabilities
    - name: drop-all-capabilities
      match:
        any:
          - resources:
              kinds:
                - Pod
              namespaceSelector:
                matchLabels:
                  environment: production
      mutate:
        foreach:
          - list: "request.object.spec.containers"
            patchStrategicMerge:
              spec:
                containers:
                  - name: "{{ element.name }}"
                    securityContext:
                      capabilities:
                        drop:
                          - ALL
```

### Kyverno Generate Policy

```yaml
# kyverno-generate-networkpolicy.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: generate-default-networkpolicy
  annotations:
    policies.kyverno.io/title: Generate Default NetworkPolicy
    policies.kyverno.io/category: Multi-Tenancy
spec:
  rules:
    - name: generate-default-deny
      match:
        any:
          - resources:
              kinds:
                - Namespace
              selector:
                matchLabels:
                  generate-networkpolicy: "true"
      generate:
        apiVersion: networking.k8s.io/v1
        kind: NetworkPolicy
        name: default-deny-all
        namespace: "{{request.object.metadata.name}}"
        synchronize: true
        data:
          spec:
            podSelector: {}
            policyTypes:
              - Ingress
              - Egress
            egress:
              # Allow DNS
              - ports:
                  - port: 53
                    protocol: UDP
                  - port: 53
                    protocol: TCP
              # Allow access to K8s API
              - to:
                  - namespaceSelector:
                      matchLabels:
                        kubernetes.io/metadata.name: kube-system
                ports:
                  - port: 443
```

## Section 5: CEL-Based ValidatingAdmissionPolicy

ValidatingAdmissionPolicy (GA in Kubernetes 1.30) provides in-cluster policy evaluation using CEL without external webhooks.

### CEL Policy Examples

```yaml
# cel-admission-policies.yaml

# Policy 1: Require resource requests
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: require-resource-requests
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups: ["apps"]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["deployments"]
  validations:
    - expression: |
        object.spec.template.spec.containers.all(c,
          has(c.resources) &&
          has(c.resources.requests) &&
          has(c.resources.requests.cpu) &&
          has(c.resources.requests.memory)
        )
      message: "All containers must specify CPU and memory resource requests"
      reason: Invalid

    - expression: |
        object.spec.template.spec.containers.all(c,
          !has(c.resources.limits) ||
          !has(c.resources.limits.cpu) ||
          quantity(c.resources.limits.cpu) <= quantity('16000m')
        )
      message: "CPU limits cannot exceed 16 cores per container"
      reason: Invalid

---
# Policy 2: Require specific labels
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: require-production-labels
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups: ["apps"]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["deployments", "statefulsets", "daemonsets"]
  validations:
    - expression: |
        has(object.metadata.labels) &&
        has(object.metadata.labels.app) &&
        has(object.metadata.labels.team)
      message: "Deployments must have 'app' and 'team' labels"
      reason: Invalid

    - expression: |
        !has(object.spec.template.spec.containers) ||
        object.spec.template.spec.containers.all(c,
          !c.image.endsWith(':latest') &&
          c.image.contains(':')
        )
      message: "Container images must specify explicit version tags, not :latest"
      reason: Invalid

---
# Policy 3: Enforce pod security standards
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: enforce-pod-security
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
          !has(c.securityContext) ||
          !has(c.securityContext.privileged) ||
          c.securityContext.privileged == false
        )
      message: "Privileged containers are not allowed"
      reason: Forbidden

    - expression: |
        !has(object.spec.hostNetwork) || object.spec.hostNetwork == false
      message: "hostNetwork is not allowed"
      reason: Forbidden

    - expression: |
        !has(object.spec.hostPID) || object.spec.hostPID == false
      message: "hostPID is not allowed"
      reason: Forbidden

---
# Bind policy to production namespaces
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: enforce-pod-security-binding
spec:
  policyName: enforce-pod-security
  validationActions: [Deny, Audit]
  matchResources:
    namespaceSelector:
      matchExpressions:
        - key: environment
          operator: In
          values:
            - production
            - staging
```

## Section 6: Webhook Latency and Performance

### Measuring Webhook Impact

```bash
#!/bin/bash
# webhook-latency-test.sh
set -euo pipefail

# Time pod creation with webhooks enabled
echo "=== Pod creation latency (with webhooks) ==="
time kubectl run perf-test-1 \
  --image=nginx:1.25 \
  --restart=Never \
  --namespace=default \
  --labels="app=perf-test,team=platform" \
  -- sleep 3600

# Check API server admission webhook metrics
kubectl get --raw /metrics | \
  grep 'apiserver_admission_webhook_admission_duration_seconds' | \
  grep -v '#' | \
  awk '{print $1, $2}' | \
  sort -t'name="' -k2 | \
  head -20

# Cleanup
kubectl delete pod perf-test-1 2>/dev/null || true
```

### Webhook Configuration for High Performance

```yaml
# High-performance webhook configuration
spec:
  webhooks:
    - name: fast-validator.acme.internal
      admissionReviewVersions: ["v1"]
      sideEffects: None
      failurePolicy: Ignore          # Don't block if webhook is slow/down
      timeoutSeconds: 3              # Short timeout
      matchConditions:
        # Skip validation for system namespaces
        - name: exclude-system-namespaces
          expression: >
            !(['kube-system', 'kube-public', 'cert-manager', 'monitoring']
              .exists(ns, ns == request.namespace))
        # Only validate Pods, not all resources
        - name: only-pods
          expression: request.resource.resource == 'pods'
      clientConfig:
        service:
          name: acme-webhook
          namespace: webhook-system
          path: /validate/pods
```

### Webhook Failure Modes

```yaml
# failurePolicy options:
# Fail  — reject the request if webhook is unreachable (high security)
# Ignore — allow the request if webhook is unreachable (high availability)

# Recommendation for production:
# - MutatingWebhook: Ignore (don't block pod creation for missing defaults)
# - ValidatingWebhook for security: Fail (security rules must be enforced)
# - ValidatingWebhook for best practices: Ignore (don't block for advisory rules)

# Webhook HA deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: acme-admission-webhook
  namespace: webhook-system
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
      maxSurge: 1
  template:
    spec:
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: acme-admission-webhook
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - topologyKey: kubernetes.io/hostname
              labelSelector:
                matchLabels:
                  app: acme-admission-webhook
```

## Section 7: Defense-in-Depth Admission Control Strategy

### Layered Policy Architecture

```
Layer 1: Pod Security Admission (built-in)
  ├── enforce: restricted/baseline per namespace
  └── Covers: privilege escalation, host access, volumes

Layer 2: CEL ValidatingAdmissionPolicy (in-cluster)
  ├── Resource request requirements
  ├── Image tag policies
  └── Label requirements
  Latency: < 1ms (in-process)

Layer 3: Kyverno (webhook, stateful)
  ├── Mutation: inject defaults, drop capabilities
  ├── Validation: complex business rules
  └── Generation: create derived resources
  Latency: 5-15ms

Layer 4: OPA Gatekeeper (webhook, audit)
  ├── Complex Rego policies
  ├── Audit existing resources
  └── Cost allocation policies
  Latency: 10-30ms

Layer 5: Custom Go Webhook (webhook, specialized)
  ├── Domain-specific validations
  ├── External system checks (registry scanning)
  └── Compliance checks
  Latency: 5-20ms
```

### Implementation Priority

```bash
# Phase 1: Enable Pod Security Admission (zero config needed)
kubectl label namespace payments \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/warn=restricted \
  pod-security.kubernetes.io/audit=restricted

# Phase 2: Deploy CEL policies for resource and label requirements
kubectl apply -f cel-admission-policies.yaml

# Phase 3: Deploy Kyverno for mutation and complex validation
helm upgrade --install kyverno kyverno/kyverno ...
kubectl apply -f kyverno-policy-production.yaml

# Phase 4: OPA Gatekeeper for audit and compliance reporting
helm upgrade --install gatekeeper gatekeeper/gatekeeper ...
kubectl apply -f constraint-template-required-labels.yaml
kubectl apply -f constraint-required-labels.yaml
```

## Summary

A production admission control strategy uses multiple complementary layers. Pod Security Admission handles the lowest-level kernel security constraints with no latency. CEL ValidatingAdmissionPolicy handles common validations in-process with sub-millisecond latency. Kyverno handles mutation (injecting defaults, dropping capabilities) and complex validation with a managed webhook. OPA Gatekeeper provides Rego-based policy flexibility and continuous audit of existing resources. Custom Go webhooks handle organization-specific requirements that require external system integration.

Webhook latency is the primary operational concern. Keep webhooks stateless, horizontally scalable, and appropriately time-bounded. Set `failurePolicy: Ignore` for non-security-critical webhooks, and `failurePolicy: Fail` only for enforcement that must not be bypassed. Monitor `apiserver_admission_webhook_admission_duration_seconds` in Prometheus to detect webhook performance regressions before they impact cluster operations.
