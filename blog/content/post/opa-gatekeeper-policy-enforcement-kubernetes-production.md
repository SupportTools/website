---
title: "OPA Gatekeeper: Production-Grade Policy Enforcement for Kubernetes Clusters"
date: 2026-10-15T00:00:00-05:00
draft: false
tags: ["OPA", "Gatekeeper", "Kubernetes", "Policy", "Security", "Compliance", "Admission Control"]
categories: ["Security", "Kubernetes", "Policy Management"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing Open Policy Agent Gatekeeper for enterprise Kubernetes policy enforcement, including constraint templates, mutation policies, and compliance automation."
more_link: "yes"
url: "/opa-gatekeeper-policy-enforcement-kubernetes-production/"
---

Open Policy Agent (OPA) Gatekeeper has become the industry standard for policy-based control in Kubernetes environments. As a CNCF graduated project, Gatekeeper extends OPA's policy-as-code capabilities with Kubernetes-native resources, providing declarative admission control that enforces organizational policies across clusters.

In this comprehensive guide, we'll explore enterprise-grade Gatekeeper implementations, covering constraint template development, mutation policies, audit frameworks, and integration patterns that have proven effective in managing thousands of workloads across multi-tenant environments.

<!--more-->

# Understanding Gatekeeper Architecture

## Core Components and Workflow

Gatekeeper operates as a Kubernetes admission webhook that intercepts API requests before objects are persisted to etcd. The architecture consists of several key components:

**Admission Webhook**: Validates and mutates resources based on defined policies
**Constraint Framework**: Provides the mechanism for defining and enforcing policies
**Audit Controller**: Periodically evaluates existing resources against constraints
**Mutation Webhook**: Modifies resource specifications based on mutation policies

Let's deploy a production-ready Gatekeeper installation:

```yaml
# gatekeeper-deployment.yaml - Production Gatekeeper Setup
apiVersion: v1
kind: Namespace
metadata:
  name: gatekeeper-system
  labels:
    admission.gatekeeper.sh/ignore: "true"
    pod-security.kubernetes.io/enforce: restricted
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: gatekeeper-audit
  namespace: gatekeeper-system
  labels:
    app: gatekeeper
    control-plane: audit-controller
spec:
  replicas: 1
  selector:
    matchLabels:
      app: gatekeeper
      control-plane: audit-controller
  template:
    metadata:
      labels:
        app: gatekeeper
        control-plane: audit-controller
    spec:
      serviceAccountName: gatekeeper-admin
      containers:
      - name: manager
        image: openpolicyagent/gatekeeper:v3.14.0
        args:
        - --operation=audit
        - --operation=status
        - --operation=mutation-status
        - --logtostderr
        - --audit-interval=60
        - --constraint-violations-limit=100
        - --audit-from-cache=true
        - --audit-chunk-size=500
        - --emit-audit-events=true
        - --audit-events-involved-namespace=true
        env:
        - name: POD_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        ports:
        - containerPort: 8888
          name: metrics
          protocol: TCP
        - containerPort: 9090
          name: healthz
          protocol: TCP
        livenessProbe:
          httpGet:
            path: /healthz
            port: 9090
          initialDelaySeconds: 15
          periodSeconds: 20
        readinessProbe:
          httpGet:
            path: /readyz
            port: 9090
          initialDelaySeconds: 5
          periodSeconds: 10
        resources:
          requests:
            cpu: 100m
            memory: 512Mi
          limits:
            cpu: 1000m
            memory: 2Gi
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop:
            - ALL
          readOnlyRootFilesystem: true
          runAsNonRoot: true
          runAsUser: 1000
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: gatekeeper-controller-manager
  namespace: gatekeeper-system
  labels:
    app: gatekeeper
    control-plane: controller-manager
spec:
  replicas: 3
  selector:
    matchLabels:
      app: gatekeeper
      control-plane: controller-manager
  template:
    metadata:
      labels:
        app: gatekeeper
        control-plane: controller-manager
    spec:
      serviceAccountName: gatekeeper-admin
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchExpressions:
                - key: app
                  operator: In
                  values:
                  - gatekeeper
              topologyKey: kubernetes.io/hostname
      containers:
      - name: manager
        image: openpolicyagent/gatekeeper:v3.14.0
        args:
        - --port=8443
        - --health-addr=:9090
        - --prometheus-port=8888
        - --logtostderr
        - --log-denies=true
        - --emit-admission-events=true
        - --admission-events-involved-namespace=true
        - --log-level=INFO
        - --exempt-namespace=gatekeeper-system
        - --operation=webhook
        - --operation=mutation-webhook
        - --disable-opa-builtin={http.send}
        env:
        - name: POD_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        ports:
        - containerPort: 8443
          name: webhook-server
          protocol: TCP
        - containerPort: 8888
          name: metrics
          protocol: TCP
        - containerPort: 9090
          name: healthz
          protocol: TCP
        livenessProbe:
          httpGet:
            path: /healthz
            port: 9090
          initialDelaySeconds: 15
          periodSeconds: 20
        readinessProbe:
          httpGet:
            path: /readyz
            port: 9090
          initialDelaySeconds: 5
          periodSeconds: 10
        resources:
          requests:
            cpu: 250m
            memory: 1Gi
          limits:
            cpu: 2000m
            memory: 4Gi
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop:
            - ALL
          readOnlyRootFilesystem: true
          runAsNonRoot: true
          runAsUser: 1000
        volumeMounts:
        - mountPath: /certs
          name: cert
          readOnly: true
      volumes:
      - name: cert
        secret:
          secretName: gatekeeper-webhook-server-cert
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: gatekeeper-admin
  namespace: gatekeeper-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: gatekeeper-manager-role
rules:
- apiGroups:
  - "*"
  resources:
  - "*"
  verbs:
  - get
  - list
  - watch
- apiGroups:
  - apiextensions.k8s.io
  resources:
  - customresourcedefinitions
  verbs:
  - create
  - delete
  - get
  - list
  - patch
  - update
  - watch
- apiGroups:
  - config.gatekeeper.sh
  resources:
  - configs
  - configs/status
  verbs:
  - create
  - delete
  - get
  - list
  - patch
  - update
  - watch
- apiGroups:
  - constraints.gatekeeper.sh
  resources:
  - "*"
  verbs:
  - create
  - delete
  - get
  - list
  - patch
  - update
  - watch
- apiGroups:
  - mutations.gatekeeper.sh
  resources:
  - "*"
  verbs:
  - create
  - delete
  - get
  - list
  - patch
  - update
  - watch
- apiGroups:
  - status.gatekeeper.sh
  resources:
  - "*"
  verbs:
  - create
  - delete
  - get
  - list
  - patch
  - update
  - watch
- apiGroups:
  - templates.gatekeeper.sh
  resources:
  - constrainttemplates
  - constrainttemplates/status
  verbs:
  - create
  - delete
  - get
  - list
  - patch
  - update
  - watch
- apiGroups:
  - ""
  resources:
  - events
  verbs:
  - create
  - patch
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: gatekeeper-manager-rolebinding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: gatekeeper-manager-role
subjects:
- kind: ServiceAccount
  name: gatekeeper-admin
  namespace: gatekeeper-system
```

# Constraint Template Development

## Enterprise Constraint Templates

Let's create comprehensive constraint templates for common enterprise requirements:

```yaml
# constraint-templates.yaml - Enterprise Constraint Templates
---
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequiredlabels
  annotations:
    description: "Requires resources to have specified labels"
    compliance: "CIS Kubernetes Benchmark 5.7.3"
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
              description: "List of required labels"
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
          required := {label | label := input.parameters.labels[_].key}
          missing := required - provided
          count(missing) > 0
          msg := sprintf("You must provide labels: %v", [missing])
        }

        violation[{"msg": msg}] {
          value := input.review.object.metadata.labels[key]
          expected := input.parameters.labels[_]
          expected.key == key
          expected.allowedRegex != ""
          not re_match(expected.allowedRegex, value)
          msg := sprintf("Label <%v: %v> does not match required regex: %v", [key, value, expected.allowedRegex])
        }
---
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8scontainerlimits
  annotations:
    description: "Requires containers to have resource limits"
    compliance: "CIS Kubernetes Benchmark 5.2.1, 5.2.2"
spec:
  crd:
    spec:
      names:
        kind: K8sContainerLimits
      validation:
        openAPIV3Schema:
          type: object
          properties:
            cpu:
              type: string
            memory:
              type: string
            enforceLimitsEqualsRequests:
              type: boolean
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8scontainerlimits

        missing_limits(container) {
          not container.resources.limits
        }

        missing_limits(container) {
          not container.resources.limits.cpu
        }

        missing_limits(container) {
          not container.resources.limits.memory
        }

        violation[{"msg": msg, "details": {"missing_limits": name}}] {
          container := input.review.object.spec.containers[_]
          missing_limits(container)
          name := container.name
          msg := sprintf("Container <%v> does not have resource limits defined", [name])
        }

        violation[{"msg": msg}] {
          input.parameters.enforceLimitsEqualsRequests
          container := input.review.object.spec.containers[_]
          not container.resources.limits.cpu == container.resources.requests.cpu
          msg := sprintf("Container <%v> must have CPU limits equal to requests", [container.name])
        }

        violation[{"msg": msg}] {
          input.parameters.enforceLimitsEqualsRequests
          container := input.review.object.spec.containers[_]
          not container.resources.limits.memory == container.resources.requests.memory
          msg := sprintf("Container <%v> must have memory limits equal to requests", [container.name])
        }
---
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8sallowedrepos
  annotations:
    description: "Requires container images to come from approved registries"
    compliance: "Supply Chain Security"
spec:
  crd:
    spec:
      names:
        kind: K8sAllowedRepos
      validation:
        openAPIV3Schema:
          type: object
          properties:
            repos:
              type: array
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8sallowedrepos

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          satisfied := [good | repo = input.parameters.repos[_] ; good = startswith(container.image, repo)]
          not any(satisfied)
          msg := sprintf("Container <%v> has an invalid image repo <%v>, allowed repos are %v", [container.name, container.image, input.parameters.repos])
        }

        violation[{"msg": msg}] {
          container := input.review.object.spec.initContainers[_]
          satisfied := [good | repo = input.parameters.repos[_] ; good = startswith(container.image, repo)]
          not any(satisfied)
          msg := sprintf("InitContainer <%v> has an invalid image repo <%v>, allowed repos are %v", [container.name, container.image, input.parameters.repos])
        }
---
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8sblocknodeselector
  annotations:
    description: "Prevents use of node selectors that could break tenant isolation"
    compliance: "Multi-tenancy Isolation"
spec:
  crd:
    spec:
      names:
        kind: K8sBlockNodeSelector
      validation:
        openAPIV3Schema:
          type: object
          properties:
            blockedNodeSelectors:
              type: array
              items:
                type: object
                properties:
                  key:
                    type: string
                  value:
                    type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8sblocknodeselector

        violation[{"msg": msg}] {
          blocked := input.parameters.blockedNodeSelectors[_]
          selector := input.review.object.spec.nodeSelector[blocked.key]
          selector == blocked.value
          msg := sprintf("Node selector <%v: %v> is not allowed", [blocked.key, blocked.value])
        }
---
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequiresecuritycontext
  annotations:
    description: "Requires pods to have secure security context"
    compliance: "CIS Kubernetes Benchmark 5.2.6"
spec:
  crd:
    spec:
      names:
        kind: K8sRequireSecurityContext
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8srequiresecuritycontext

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          not container.securityContext.runAsNonRoot
          msg := sprintf("Container <%v> must set runAsNonRoot to true", [container.name])
        }

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          container.securityContext.privileged
          msg := sprintf("Container <%v> must not run as privileged", [container.name])
        }

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          not container.securityContext.allowPrivilegeEscalation == false
          msg := sprintf("Container <%v> must set allowPrivilegeEscalation to false", [container.name])
        }

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          not container.securityContext.readOnlyRootFilesystem
          msg := sprintf("Container <%v> must set readOnlyRootFilesystem to true", [container.name])
        }

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          has_dangerous_capability(container)
          msg := sprintf("Container <%v> must drop all capabilities and only add specific ones", [container.name])
        }

        has_dangerous_capability(container) {
          not container.securityContext.capabilities.drop
        }

        has_dangerous_capability(container) {
          not contains_all(container.securityContext.capabilities.drop)
        }

        contains_all(drops) {
          drops[_] == "ALL"
        }
---
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8singress alloweddomains
  annotations:
    description: "Restricts ingress hostnames to approved domains"
    compliance: "Network Security Policy"
spec:
  crd:
    spec:
      names:
        kind: K8sIngressAllowedDomains
      validation:
        openAPIV3Schema:
          type: object
          properties:
            domains:
              type: array
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8singressalloweddomains

        violation[{"msg": msg}] {
          input.review.kind.kind == "Ingress"
          host := input.review.object.spec.rules[_].host
          not domain_allowed(host, input.parameters.domains)
          msg := sprintf("Ingress host <%v> is not in allowed domains: %v", [host, input.parameters.domains])
        }

        domain_allowed(host, domains) {
          domain := domains[_]
          endswith(host, domain)
        }
```

## Applying Constraints to Enforce Policies

Now let's create the constraint instances that enforce these policies:

```yaml
# constraints.yaml - Policy Enforcement
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredLabels
metadata:
  name: require-standard-labels
spec:
  enforcementAction: deny
  match:
    kinds:
    - apiGroups: [""]
      kinds: ["Namespace"]
    - apiGroups: ["apps"]
      kinds: ["Deployment", "StatefulSet", "DaemonSet"]
    excludedNamespaces:
    - kube-system
    - kube-public
    - kube-node-lease
    - gatekeeper-system
  parameters:
    message: "All resources must have required labels"
    labels:
    - key: "app.kubernetes.io/name"
      allowedRegex: "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$"
    - key: "app.kubernetes.io/instance"
      allowedRegex: ".*"
    - key: "app.kubernetes.io/version"
      allowedRegex: ".*"
    - key: "app.kubernetes.io/component"
      allowedRegex: ".*"
    - key: "app.kubernetes.io/part-of"
      allowedRegex: ".*"
    - key: "app.kubernetes.io/managed-by"
      allowedRegex: ".*"
    - key: "environment"
      allowedRegex: "^(development|staging|production)$"
    - key: "owner"
      allowedRegex: "^[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}$"
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sContainerLimits
metadata:
  name: require-container-limits
spec:
  enforcementAction: deny
  match:
    kinds:
    - apiGroups: [""]
      kinds: ["Pod"]
    - apiGroups: ["apps"]
      kinds: ["Deployment", "StatefulSet", "DaemonSet"]
    namespaceSelector:
      matchExpressions:
      - key: environment
        operator: In
        values: ["production", "staging"]
  parameters:
    enforceLimitsEqualsRequests: true
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sAllowedRepos
metadata:
  name: allowed-image-repos
spec:
  enforcementAction: deny
  match:
    kinds:
    - apiGroups: [""]
      kinds: ["Pod"]
    - apiGroups: ["apps"]
      kinds: ["Deployment", "StatefulSet", "DaemonSet"]
    excludedNamespaces:
    - kube-system
    - gatekeeper-system
  parameters:
    repos:
    - "gcr.io/company-project/"
    - "docker.io/company/"
    - "registry.company.com/"
    - "quay.io/company/"
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequireSecurityContext
metadata:
  name: require-security-context
spec:
  enforcementAction: deny
  match:
    kinds:
    - apiGroups: [""]
      kinds: ["Pod"]
    - apiGroups: ["apps"]
      kinds: ["Deployment", "StatefulSet", "DaemonSet"]
    namespaceSelector:
      matchExpressions:
      - key: pod-security.kubernetes.io/enforce
        operator: Exists
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sIngressAllowedDomains
metadata:
  name: ingress-allowed-domains
spec:
  enforcementAction: deny
  match:
    kinds:
    - apiGroups: ["networking.k8s.io"]
      kinds: ["Ingress"]
  parameters:
    domains:
    - ".company.com"
    - ".company.io"
    - ".company-internal.net"
```

# Mutation Policies

## Automatic Resource Modification

Gatekeeper's mutation feature allows automatic modification of resources:

```yaml
# mutations.yaml - Mutation Policies
---
apiVersion: mutations.gatekeeper.sh/v1beta1
kind: Assign
metadata:
  name: add-security-context
spec:
  applyTo:
  - groups: [""]
    kinds: ["Pod"]
    versions: ["v1"]
  match:
    scope: Namespaced
    kinds:
    - apiGroups: ["*"]
      kinds: ["Pod"]
    excludedNamespaces:
    - kube-system
  location: "spec.securityContext"
  parameters:
    assign:
      value:
        runAsNonRoot: true
        fsGroup: 65534
        seccompProfile:
          type: RuntimeDefault
---
apiVersion: mutations.gatekeeper.sh/v1beta1
kind: Assign
metadata:
  name: add-container-security-context
spec:
  applyTo:
  - groups: [""]
    kinds: ["Pod"]
    versions: ["v1"]
  match:
    scope: Namespaced
    kinds:
    - apiGroups: ["*"]
      kinds: ["Pod"]
    excludedNamespaces:
    - kube-system
  location: "spec.containers[name: *].securityContext"
  parameters:
    assign:
      value:
        allowPrivilegeEscalation: false
        runAsNonRoot: true
        capabilities:
          drop:
          - ALL
        readOnlyRootFilesystem: true
---
apiVersion: mutations.gatekeeper.sh/v1beta1
kind: Assign
metadata:
  name: add-resource-limits
spec:
  applyTo:
  - groups: ["apps"]
    kinds: ["Deployment"]
    versions: ["v1"]
  match:
    scope: Namespaced
    namespaceSelector:
      matchExpressions:
      - key: mutation.gatekeeper.sh/add-limits
        operator: Exists
  location: "spec.template.spec.containers[name: *].resources"
  parameters:
    assign:
      value:
        limits:
          cpu: "1000m"
          memory: "1Gi"
        requests:
          cpu: "100m"
          memory: "128Mi"
    pathTests:
    - subPath: "spec.template.spec.containers[name: *].resources"
      condition: MustNotExist
---
apiVersion: mutations.gatekeeper.sh/v1beta1
kind: AssignMetadata
metadata:
  name: add-standard-labels
spec:
  match:
    scope: Namespaced
    kinds:
    - apiGroups: ["*"]
      kinds: ["Deployment", "StatefulSet", "DaemonSet"]
    namespaceSelector:
      matchExpressions:
      - key: mutation.gatekeeper.sh/add-labels
        operator: Exists
  location: "metadata.labels"
  parameters:
    assign:
      value:
        app.kubernetes.io/managed-by: "gatekeeper"
---
apiVersion: mutations.gatekeeper.sh/v1beta1
kind: ModifySet
metadata:
  name: add-image-pull-secrets
spec:
  applyTo:
  - groups: [""]
    kinds: ["Pod"]
    versions: ["v1"]
  match:
    scope: Namespaced
    kinds:
    - apiGroups: ["*"]
      kinds: ["Pod"]
    namespaceSelector:
      matchLabels:
        require-image-pull-secret: "true"
  location: "spec.imagePullSecrets"
  parameters:
    operation: merge
    values:
      fromList:
      - name: registry-credentials
```

# Compliance and Audit Framework

## Continuous Compliance Monitoring

Implement comprehensive audit and compliance monitoring:

```yaml
# audit-config.yaml - Audit Configuration
apiVersion: config.gatekeeper.sh/v1alpha1
kind: Config
metadata:
  name: config
  namespace: gatekeeper-system
spec:
  sync:
    syncOnly:
    - group: ""
      version: "v1"
      kind: "Namespace"
    - group: ""
      version: "v1"
      kind: "Pod"
    - group: "apps"
      version: "v1"
      kind: "Deployment"
    - group: "apps"
      version: "v1"
      kind: "StatefulSet"
    - group: "apps"
      version: "v1"
      kind: "DaemonSet"
    - group: "networking.k8s.io"
      version: "v1"
      kind: "Ingress"
    - group: "networking.k8s.io"
      version: "v1"
      kind: "NetworkPolicy"
  validation:
    traces:
    - user: "system:serviceaccount:gatekeeper-system:gatekeeper-admin"
      kind:
        group: ""
        version: "v1"
        kind: "Pod"
      dump: "All"
  match:
  - excludedNamespaces:
    - kube-system
    - kube-public
    - kube-node-lease
    processes:
    - "audit"
    - "webhook"
```

## Compliance Reporting Dashboard

Create a compliance monitoring solution:

```go
// compliance-reporter.go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "net/http"
    "time"

    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
    "k8s.io/apimachinery/pkg/runtime/schema"
    "k8s.io/client-go/dynamic"
    "k8s.io/client-go/rest"
)

type ComplianceReport struct {
    Timestamp          time.Time           `json:"timestamp"`
    TotalConstraints   int                 `json:"total_constraints"`
    ViolationsByPolicy map[string]int      `json:"violations_by_policy"`
    ViolationsByNS     map[string]int      `json:"violations_by_namespace"`
    TopViolators       []ResourceViolation `json:"top_violators"`
    ComplianceScore    float64             `json:"compliance_score"`
}

type ResourceViolation struct {
    Resource   string `json:"resource"`
    Namespace  string `json:"namespace"`
    Constraint string `json:"constraint"`
    Message    string `json:"message"`
}

type ComplianceReporter struct {
    dynamicClient dynamic.Interface
}

func NewComplianceReporter() (*ComplianceReporter, error) {
    config, err := rest.InClusterConfig()
    if err != nil {
        return nil, err
    }

    dynamicClient, err := dynamic.NewForConfig(config)
    if err != nil {
        return nil, err
    }

    return &ComplianceReporter{
        dynamicClient: dynamicClient,
    }, nil
}

func (cr *ComplianceReporter) GenerateReport() (*ComplianceReport, error) {
    report := &ComplianceReport{
        Timestamp:          time.Now(),
        ViolationsByPolicy: make(map[string]int),
        ViolationsByNS:     make(map[string]int),
        TopViolators:       []ResourceViolation{},
    }

    // List all constraint types
    constraintTemplateGVR := schema.GroupVersionResource{
        Group:    "templates.gatekeeper.sh",
        Version:  "v1",
        Resource: "constrainttemplates",
    }

    templates, err := cr.dynamicClient.Resource(constraintTemplateGVR).List(
        context.TODO(),
        metav1.ListOptions{},
    )
    if err != nil {
        return nil, fmt.Errorf("failed to list constraint templates: %w", err)
    }

    report.TotalConstraints = len(templates.Items)

    // Check violations for each constraint type
    totalResources := 0
    totalViolations := 0

    for _, template := range templates.Items {
        kind := template.GetName()
        constraintGVR := schema.GroupVersionResource{
            Group:    "constraints.gatekeeper.sh",
            Version:  "v1beta1",
            Resource: kind,
        }

        constraints, err := cr.dynamicClient.Resource(constraintGVR).List(
            context.TODO(),
            metav1.ListOptions{},
        )
        if err != nil {
            log.Printf("Failed to list constraints for %s: %v", kind, err)
            continue
        }

        for _, constraint := range constraints.Items {
            violations, err := cr.getViolations(&constraint)
            if err != nil {
                log.Printf("Failed to get violations: %v", err)
                continue
            }

            constraintName := constraint.GetName()
            report.ViolationsByPolicy[constraintName] = len(violations)
            totalViolations += len(violations)

            for _, violation := range violations {
                report.ViolationsByNS[violation.Namespace]++
                report.TopViolators = append(report.TopViolators, violation)
            }

            totalResources += cr.getTotalAuditedResources(&constraint)
        }
    }

    // Calculate compliance score
    if totalResources > 0 {
        report.ComplianceScore = float64(totalResources-totalViolations) / float64(totalResources) * 100
    }

    // Limit top violators to 20
    if len(report.TopViolators) > 20 {
        report.TopViolators = report.TopViolators[:20]
    }

    return report, nil
}

func (cr *ComplianceReporter) getViolations(constraint *unstructured.Unstructured) ([]ResourceViolation, error) {
    violations := []ResourceViolation{}

    status, found, err := unstructured.NestedSlice(constraint.Object, "status", "violations")
    if err != nil || !found {
        return violations, nil
    }

    for _, v := range status {
        violation, ok := v.(map[string]interface{})
        if !ok {
            continue
        }

        rv := ResourceViolation{
            Constraint: constraint.GetName(),
        }

        if kind, found := violation["kind"].(string); found {
            rv.Resource = kind
        }
        if name, found := violation["name"].(string); found {
            rv.Resource += "/" + name
        }
        if ns, found := violation["namespace"].(string); found {
            rv.Namespace = ns
        }
        if msg, found := violation["message"].(string); found {
            rv.Message = msg
        }

        violations = append(violations, rv)
    }

    return violations, nil
}

func (cr *ComplianceReporter) getTotalAuditedResources(constraint *unstructured.Unstructured) int {
    total, found, err := unstructured.NestedInt64(constraint.Object, "status", "totalViolations")
    if err != nil || !found {
        return 0
    }
    return int(total)
}

func (cr *ComplianceReporter) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    report, err := cr.GenerateReport()
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(report)
}

func main() {
    reporter, err := NewComplianceReporter()
    if err != nil {
        log.Fatalf("Failed to create compliance reporter: %v", err)
    }

    http.HandleFunc("/compliance", reporter.ServeHTTP)
    http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    })

    log.Println("Starting compliance reporter on :8080")
    if err := http.ListenAndServe(":8080", nil); err != nil {
        log.Fatalf("Server failed: %v", err)
    }
}
```

# Performance Optimization

## Constraint Performance Tuning

Optimize Gatekeeper for high-traffic environments:

```yaml
# performance-config.yaml
apiVersion: config.gatekeeper.sh/v1alpha1
kind: Config
metadata:
  name: config
  namespace: gatekeeper-system
spec:
  # Optimize sync cache
  sync:
    syncOnly:
    - group: ""
      version: "v1"
      kind: "Namespace"
    - group: ""
      version: "v1"
      kind: "Pod"
    - group: "apps"
      version: "v1"
      kind: "Deployment"

  # Enable constraint caching
  validation:
    traces: []

  # Configure audit performance
  match:
  - excludedNamespaces:
    - kube-system
    - kube-public
    - kube-node-lease
    processes:
    - "audit"
    - "webhook"

  # Readiness tracking
  readiness:
    statsEnabled: true
```

# Monitoring and Alerting

## Prometheus Metrics Integration

```yaml
# servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: gatekeeper
  namespace: gatekeeper-system
spec:
  selector:
    matchLabels:
      app: gatekeeper
  endpoints:
  - port: metrics
    interval: 30s
    path: /metrics
---
# PrometheusRule for alerts
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: gatekeeper-alerts
  namespace: gatekeeper-system
spec:
  groups:
  - name: gatekeeper
    interval: 30s
    rules:
    - alert: GatekeeperHighViolationRate
      expr: rate(gatekeeper_violations_total[5m]) > 10
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "High policy violation rate"
        description: "Gatekeeper is detecting {{ $value }} violations per second"

    - alert: GatekeeperAuditFailure
      expr: gatekeeper_audit_last_run_time < (time() - 300)
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Gatekeeper audit not running"
        description: "Gatekeeper audit has not run in 5 minutes"

    - alert: GatekeeperWebhookLatency
      expr: histogram_quantile(0.99, rate(gatekeeper_validation_request_duration_seconds_bucket[5m])) > 1
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "High webhook latency"
        description: "99th percentile webhook latency is {{ $value }}s"
```

# Best Practices

## Policy Development Lifecycle

1. **Development**: Test constraints in a development cluster with `enforcementAction: dryrun`
2. **Testing**: Deploy to staging with `enforcementAction: warn` and monitor violations
3. **Production**: Gradually roll out with `enforcementAction: deny` after validation
4. **Maintenance**: Regularly review and update policies based on new requirements

## Performance Considerations

1. Keep Rego policies simple and efficient
2. Use namespace selectors to limit scope
3. Enable caching for frequently evaluated resources
4. Monitor webhook latency and adjust replica count
5. Use exemptions sparingly and document thoroughly

## Multi-Cluster Management

1. Use GitOps to manage policies across clusters
2. Implement cluster-specific overrides via Kustomize
3. Centralize compliance reporting across clusters
4. Maintain consistent policy versions across environments

# Conclusion

OPA Gatekeeper provides enterprise-grade policy enforcement for Kubernetes with flexibility and power that scales to the largest deployments. By implementing comprehensive constraint templates, mutation policies, and continuous compliance monitoring, organizations can enforce security, compliance, and operational standards across their entire container infrastructure.

The key to success is starting with core security policies, gradually expanding coverage based on your specific compliance requirements, and continuously monitoring and tuning performance to maintain low latency in admission control.