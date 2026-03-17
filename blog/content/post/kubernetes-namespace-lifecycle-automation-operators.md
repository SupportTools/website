---
title: "Kubernetes Namespace Lifecycle Automation: Auto-Provisioning with Operators"
date: 2029-02-08T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Operators", "Namespaces", "Automation", "RBAC", "GitOps"]
categories:
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to automating Kubernetes namespace lifecycle management using custom operators, covering RBAC bootstrapping, resource quota enforcement, and network policy provisioning at scale."
more_link: "yes"
url: "/kubernetes-namespace-lifecycle-automation-operators/"
---

Enterprise Kubernetes clusters host dozens or hundreds of teams, each requiring isolated namespaces with consistent RBAC, resource quotas, limit ranges, and network policies. Manually provisioning these resources is error-prone and does not scale. A namespace lifecycle operator solves this by watching a custom `NamespaceConfig` resource and reconciling the full namespace stack automatically—ensuring every namespace receives the correct policies from the moment it is created through to its eventual deletion.

This guide walks through designing, implementing, and operating a production-grade namespace lifecycle operator using the controller-runtime SDK, covering the full reconciliation loop, finalizer-based cleanup, and integration with GitOps workflows.

<!--more-->

## Why Namespace Automation Matters at Scale

In large organizations, namespace sprawl is a genuine operational hazard. Without automation:

- Teams receive inconsistent RBAC bindings, leading to privilege escalation or access denials
- Resource quotas go unset, allowing noisy-neighbor workloads to starve other teams
- Network policies are missing, creating unintended cross-namespace communication paths
- Namespace deletion leaves behind orphaned resources in external systems (Vault policies, CI runner registrations, monitoring dashboards)

A namespace lifecycle operator enforces a contract: every namespace matching a label selector receives a standardized set of child resources, and that contract is continuously reconciled.

## Architecture Overview

The operator manages a single CRD: `NamespaceConfig`. Each `NamespaceConfig` describes the desired state for one namespace class—for example, all namespaces belonging to a product team, or all ephemeral preview namespaces.

```
┌─────────────────────────────────────────────────────────────┐
│                    Kubernetes API Server                     │
├──────────────────┬──────────────────┬───────────────────────┤
│  NamespaceConfig │    Namespace     │  Child Resources       │
│  (CRD)          │  (watched)       │  RQ / LR / NP / RBAC  │
└──────┬───────────┴────────┬─────────┴───────────────────────┘
       │                    │
       ▼                    ▼
┌─────────────────────────────────────┐
│      Namespace Lifecycle Operator   │
│  ┌─────────────┐ ┌───────────────┐  │
│  │ Reconciler  │ │  Finalizer    │  │
│  │ (main loop) │ │  (cleanup)    │  │
│  └─────────────┘ └───────────────┘  │
└─────────────────────────────────────┘
```

## Defining the NamespaceConfig CRD

The CRD captures all policies that apply to a matched namespace.

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: namespaceconfigs.platform.support.tools
spec:
  group: platform.support.tools
  versions:
    - name: v1alpha1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              required: ["namespaceSelector"]
              properties:
                namespaceSelector:
                  type: object
                  properties:
                    matchLabels:
                      type: object
                      additionalProperties:
                        type: string
                resourceQuota:
                  type: object
                  properties:
                    hard:
                      type: object
                      additionalProperties:
                        type: string
                limitRange:
                  type: object
                  properties:
                    limits:
                      type: array
                      items:
                        type: object
                        x-kubernetes-preserve-unknown-fields: true
                networkPolicies:
                  type: array
                  items:
                    type: object
                    x-kubernetes-preserve-unknown-fields: true
                roleBindings:
                  type: array
                  items:
                    type: object
                    properties:
                      roleName:
                        type: string
                      subjects:
                        type: array
                        items:
                          type: object
                          x-kubernetes-preserve-unknown-fields: true
            status:
              type: object
              x-kubernetes-preserve-unknown-fields: true
      subresources:
        status: {}
  scope: Cluster
  names:
    plural: namespaceconfigs
    singular: namespaceconfig
    kind: NamespaceConfig
```

## Go Types for the Operator

```go
// api/v1alpha1/namespaceconfig_types.go
package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type NamespaceConfigSpec struct {
	NamespaceSelector metav1.LabelSelector        `json:"namespaceSelector"`
	ResourceQuota     *corev1.ResourceQuotaSpec   `json:"resourceQuota,omitempty"`
	LimitRange        *corev1.LimitRangeSpec      `json:"limitRange,omitempty"`
	NetworkPolicies   []networkingv1.NetworkPolicySpec `json:"networkPolicies,omitempty"`
	RoleBindings      []RoleBindingSpec            `json:"roleBindings,omitempty"`
}

type RoleBindingSpec struct {
	RoleName string            `json:"roleName"`
	Subjects []rbacv1.Subject  `json:"subjects"`
}

type NamespaceConfigStatus struct {
	ObservedGeneration int64              `json:"observedGeneration,omitempty"`
	ManagedNamespaces  []string           `json:"managedNamespaces,omitempty"`
	Conditions         []metav1.Condition `json:"conditions,omitempty"`
}

type NamespaceConfig struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              NamespaceConfigSpec   `json:"spec,omitempty"`
	Status            NamespaceConfigStatus `json:"status,omitempty"`
}

type NamespaceConfigList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []NamespaceConfig `json:"items"`
}
```

## The Reconciliation Loop

The reconciler is the heart of the operator. It runs on every change to a `NamespaceConfig` or any namespace matching the selector.

```go
// controllers/namespaceconfig_controller.go
package controllers

import (
	"context"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/log"

	platformv1alpha1 "github.com/supporttools/namespace-operator/api/v1alpha1"
)

const finalizerName = "platform.support.tools/namespace-cleanup"

type NamespaceConfigReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

func (r *NamespaceConfigReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	var cfg platformv1alpha1.NamespaceConfig
	if err := r.Get(ctx, req.NamespacedName, &cfg); err != nil {
		if errors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	// Handle deletion via finalizer
	if !cfg.DeletionTimestamp.IsZero() {
		return r.handleDeletion(ctx, &cfg)
	}

	// Ensure finalizer is registered
	if !controllerutil.ContainsFinalizer(&cfg, finalizerName) {
		controllerutil.AddFinalizer(&cfg, finalizerName)
		if err := r.Update(ctx, &cfg); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{Requeue: true}, nil
	}

	// List namespaces matching the selector
	selector, err := metav1.LabelSelectorAsSelector(&cfg.Spec.NamespaceSelector)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("invalid label selector: %w", err)
	}

	var nsList corev1.NamespaceList
	if err := r.List(ctx, &nsList, &client.ListOptions{LabelSelector: selector}); err != nil {
		return ctrl.Result{}, err
	}

	managedNamespaces := make([]string, 0, len(nsList.Items))
	var reconcileErrors []error

	for i := range nsList.Items {
		ns := &nsList.Items[i]
		if ns.DeletionTimestamp != nil {
			continue
		}
		if err := r.reconcileNamespace(ctx, &cfg, ns); err != nil {
			logger.Error(err, "failed to reconcile namespace", "namespace", ns.Name)
			reconcileErrors = append(reconcileErrors, err)
		} else {
			managedNamespaces = append(managedNamespaces, ns.Name)
		}
	}

	// Update status
	cfg.Status.ObservedGeneration = cfg.Generation
	cfg.Status.ManagedNamespaces = managedNamespaces
	setCondition(&cfg.Status.Conditions, reconcileErrors)
	if err := r.Status().Update(ctx, &cfg); err != nil {
		return ctrl.Result{}, err
	}

	if len(reconcileErrors) > 0 {
		return ctrl.Result{RequeueAfter: 30}, fmt.Errorf("partial reconciliation failure")
	}

	return ctrl.Result{}, nil
}

func (r *NamespaceConfigReconciler) reconcileNamespace(
	ctx context.Context,
	cfg *platformv1alpha1.NamespaceConfig,
	ns *corev1.Namespace,
) error {
	if err := r.reconcileResourceQuota(ctx, cfg, ns); err != nil {
		return fmt.Errorf("resource quota: %w", err)
	}
	if err := r.reconcileLimitRange(ctx, cfg, ns); err != nil {
		return fmt.Errorf("limit range: %w", err)
	}
	if err := r.reconcileNetworkPolicies(ctx, cfg, ns); err != nil {
		return fmt.Errorf("network policies: %w", err)
	}
	if err := r.reconcileRoleBindings(ctx, cfg, ns); err != nil {
		return fmt.Errorf("role bindings: %w", err)
	}
	return nil
}

func (r *NamespaceConfigReconciler) reconcileResourceQuota(
	ctx context.Context,
	cfg *platformv1alpha1.NamespaceConfig,
	ns *corev1.Namespace,
) error {
	if cfg.Spec.ResourceQuota == nil {
		return nil
	}
	desired := &corev1.ResourceQuota{
		ObjectMeta: metav1.ObjectMeta{
			Name:      fmt.Sprintf("nsconfig-%s", cfg.Name),
			Namespace: ns.Name,
			Labels: map[string]string{
				"platform.support.tools/managed-by": cfg.Name,
			},
		},
		Spec: *cfg.Spec.ResourceQuota,
	}
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, desired, func() error {
		desired.Spec = *cfg.Spec.ResourceQuota
		return nil
	})
	return err
}

func (r *NamespaceConfigReconciler) handleDeletion(
	ctx context.Context,
	cfg *platformv1alpha1.NamespaceConfig,
) (ctrl.Result, error) {
	if controllerutil.ContainsFinalizer(cfg, finalizerName) {
		// Cleanup logic: remove managed resources from all previously managed namespaces
		for _, nsName := range cfg.Status.ManagedNamespaces {
			if err := r.cleanupNamespace(ctx, cfg, nsName); err != nil {
				return ctrl.Result{}, err
			}
		}
		controllerutil.RemoveFinalizer(cfg, finalizerName)
		if err := r.Update(ctx, cfg); err != nil {
			return ctrl.Result{}, err
		}
	}
	return ctrl.Result{}, nil
}

func (r *NamespaceConfigReconciler) cleanupNamespace(
	ctx context.Context,
	cfg *platformv1alpha1.NamespaceConfig,
	nsName string,
) error {
	managedLabel := map[string]string{
		"platform.support.tools/managed-by": cfg.Name,
	}
	sel := labels.SelectorFromSet(managedLabel)
	opts := &client.DeleteAllOfOptions{
		ListOptions: client.ListOptions{
			Namespace:     nsName,
			LabelSelector: sel,
		},
	}
	if err := r.DeleteAllOf(ctx, &corev1.ResourceQuota{}, opts); client.IgnoreNotFound(err) != nil {
		return err
	}
	if err := r.DeleteAllOf(ctx, &networkingv1.NetworkPolicy{}, opts); client.IgnoreNotFound(err) != nil {
		return err
	}
	if err := r.DeleteAllOf(ctx, &rbacv1.RoleBinding{}, opts); client.IgnoreNotFound(err) != nil {
		return err
	}
	return nil
}
```

## Sample NamespaceConfig Resource

The following example provisions all namespaces labeled `team: platform` with a standard quota, limit range, default-deny network policy, and developer RBAC binding.

```yaml
apiVersion: platform.support.tools/v1alpha1
kind: NamespaceConfig
metadata:
  name: platform-team-standard
spec:
  namespaceSelector:
    matchLabels:
      team: platform
  resourceQuota:
    hard:
      requests.cpu: "16"
      requests.memory: 32Gi
      limits.cpu: "32"
      limits.memory: 64Gi
      pods: "100"
      services: "20"
      persistentvolumeclaims: "30"
      secrets: "100"
      configmaps: "100"
  limitRange:
    limits:
      - type: Container
        default:
          cpu: 500m
          memory: 512Mi
        defaultRequest:
          cpu: 100m
          memory: 128Mi
        max:
          cpu: "8"
          memory: 16Gi
      - type: PersistentVolumeClaim
        max:
          storage: 100Gi
  networkPolicies:
    - podSelector: {}
      policyTypes:
        - Ingress
        - Egress
      ingress:
        - from:
            - namespaceSelector:
                matchLabels:
                  kubernetes.io/metadata.name: ingress-nginx
            - namespaceSelector:
                matchLabels:
                  team: platform
      egress:
        - to:
            - namespaceSelector:
                matchLabels:
                  kubernetes.io/metadata.name: kube-system
          ports:
            - protocol: UDP
              port: 53
        - to:
            - ipBlock:
                cidr: 0.0.0.0/0
                except:
                  - 169.254.0.0/16
                  - 10.0.0.0/8
  roleBindings:
    - roleName: edit
      subjects:
        - kind: Group
          name: platform-developers
          apiGroup: rbac.authorization.k8s.io
    - roleName: view
      subjects:
        - kind: Group
          name: platform-readonly
          apiGroup: rbac.authorization.k8s.io
```

## Operator RBAC and Deployment

The operator needs cluster-level permissions to watch namespaces and manage child resources.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: namespace-operator
rules:
  - apiGroups: ["platform.support.tools"]
    resources: ["namespaceconfigs", "namespaceconfigs/status", "namespaceconfigs/finalizers"]
    verbs: ["get", "list", "watch", "update", "patch"]
  - apiGroups: [""]
    resources: ["namespaces"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["resourcequotas", "limitranges"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["networkpolicies"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["rbac.authorization.k8s.io"]
    resources: ["rolebindings"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: namespace-operator
  namespace: platform-system
spec:
  replicas: 2
  selector:
    matchLabels:
      app: namespace-operator
  template:
    metadata:
      labels:
        app: namespace-operator
    spec:
      serviceAccountName: namespace-operator
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: manager
          image: registry.support.tools/namespace-operator:v1.4.2
          args:
            - --leader-elect
            - --metrics-bind-address=:8080
            - --health-probe-bind-address=:8081
            - --max-concurrent-reconciles=10
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
            readOnlyRootFilesystem: true
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 500m
              memory: 256Mi
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
```

## Watching Namespaces for Reconciliation Triggers

The operator must re-reconcile when namespaces are created or labeled, not only when `NamespaceConfig` objects change.

```go
// controllers/setup.go
package controllers

import (
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/labels"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
	"sigs.k8s.io/controller-runtime/pkg/source"

	platformv1alpha1 "github.com/supporttools/namespace-operator/api/v1alpha1"
)

func (r *NamespaceConfigReconciler) SetupWithManager(mgr ctrl.Manager) error {
	// Index NamespaceConfigs by their selector labels for reverse lookup
	if err := mgr.GetFieldIndexer().IndexField(
		ctx,
		&platformv1alpha1.NamespaceConfig{},
		".spec.namespaceSelector",
		func(obj client.Object) []string {
			cfg := obj.(*platformv1alpha1.NamespaceConfig)
			sel, _ := metav1.LabelSelectorAsSelector(&cfg.Spec.NamespaceSelector)
			return []string{sel.String()}
		},
	); err != nil {
		return err
	}

	return ctrl.NewControllerManagedBy(mgr).
		For(&platformv1alpha1.NamespaceConfig{}).
		// Trigger reconcile when a namespace is created or its labels change
		Watches(
			&source.Kind{Type: &corev1.Namespace{}},
			handler.EnqueueRequestsFromMapFunc(r.namespaceToCfgRequests),
		).
		Complete(r)
}

func (r *NamespaceConfigReconciler) namespaceToCfgRequests(
	ctx context.Context,
	obj client.Object,
) []reconcile.Request {
	ns := obj.(*corev1.Namespace)
	var cfgList platformv1alpha1.NamespaceConfigList
	if err := r.List(ctx, &cfgList); err != nil {
		return nil
	}

	var requests []reconcile.Request
	for _, cfg := range cfgList.Items {
		sel, err := metav1.LabelSelectorAsSelector(&cfg.Spec.NamespaceSelector)
		if err != nil {
			continue
		}
		if sel.Matches(labels.Set(ns.Labels)) {
			requests = append(requests, reconcile.Request{
				NamespacedName: client.ObjectKey{Name: cfg.Name},
			})
		}
	}
	return requests
}
```

## GitOps Integration with ArgoCD

NamespaceConfig resources are ideal GitOps artifacts. Store them in a repository and let ArgoCD sync them.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: namespace-configs
  namespace: argocd
spec:
  project: platform
  source:
    repoURL: https://github.com/myorg/platform-config.git
    targetRevision: main
    path: clusters/prod/namespace-configs
  destination:
    server: https://kubernetes.default.svc
    namespace: platform-system
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=false
      - ServerSideApply=true
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m
```

## Metrics and Observability

Expose Prometheus metrics from the operator for alerting on reconciliation failures.

```go
// controllers/metrics.go
package controllers

import (
	"github.com/prometheus/client_golang/prometheus"
	"sigs.k8s.io/controller-runtime/pkg/metrics"
)

var (
	reconcileTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "namespace_operator_reconcile_total",
			Help: "Total number of reconcile operations",
		},
		[]string{"result"},
	)
	managedNamespacesGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "namespace_operator_managed_namespaces",
			Help: "Number of namespaces currently managed per NamespaceConfig",
		},
		[]string{"config"},
	)
	reconcileDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "namespace_operator_reconcile_duration_seconds",
			Help:    "Duration of reconcile operations",
			Buckets: []float64{0.01, 0.05, 0.1, 0.5, 1.0, 5.0},
		},
		[]string{"config"},
	)
)

func init() {
	metrics.Registry.MustRegister(
		reconcileTotal,
		managedNamespacesGauge,
		reconcileDuration,
	)
}
```

## PrometheusRule for Alerting

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: namespace-operator-alerts
  namespace: platform-system
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
    - name: namespace-operator
      interval: 30s
      rules:
        - alert: NamespaceOperatorReconcileFailure
          expr: |
            increase(namespace_operator_reconcile_total{result="error"}[5m]) > 3
          for: 5m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "Namespace operator reconcile failures"
            description: "{{ $value }} reconcile failures in the last 5 minutes"
        - alert: NamespaceOperatorDown
          expr: |
            absent(namespace_operator_reconcile_total)
          for: 10m
          labels:
            severity: critical
            team: platform
          annotations:
            summary: "Namespace operator metrics missing"
            description: "The namespace operator has not reported metrics for 10 minutes"
```

## Testing the Operator

Use envtest from controller-runtime to write integration tests against a real API server.

```go
// controllers/namespaceconfig_controller_test.go
package controllers_test

import (
	"context"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	platformv1alpha1 "github.com/supporttools/namespace-operator/api/v1alpha1"
)

var _ = Describe("NamespaceConfig Controller", func() {
	const timeout = 30 * time.Second
	const interval = 500 * time.Millisecond

	ctx := context.Background()

	Context("When a namespace matches the selector", func() {
		It("Should create a ResourceQuota in the namespace", func() {
			cfg := &platformv1alpha1.NamespaceConfig{
				ObjectMeta: metav1.ObjectMeta{Name: "test-config"},
				Spec: platformv1alpha1.NamespaceConfigSpec{
					NamespaceSelector: metav1.LabelSelector{
						MatchLabels: map[string]string{"test": "quota"},
					},
					ResourceQuota: &corev1.ResourceQuotaSpec{
						Hard: corev1.ResourceList{
							corev1.ResourcePods: resource.MustParse("10"),
						},
					},
				},
			}
			Expect(k8sClient.Create(ctx, cfg)).To(Succeed())

			ns := &corev1.Namespace{
				ObjectMeta: metav1.ObjectMeta{
					Name:   "test-ns-quota",
					Labels: map[string]string{"test": "quota"},
				},
			}
			Expect(k8sClient.Create(ctx, ns)).To(Succeed())

			rqKey := types.NamespacedName{
				Namespace: "test-ns-quota",
				Name:      "nsconfig-test-config",
			}
			var rq corev1.ResourceQuota
			Eventually(func() error {
				return k8sClient.Get(ctx, rqKey, &rq)
			}, timeout, interval).Should(Succeed())

			Expect(rq.Spec.Hard[corev1.ResourcePods]).To(Equal(resource.MustParse("10")))
		})
	})
})
```

## Production Deployment Checklist

Before running this operator in production, verify the following:

**High Availability**
- Deploy at least two operator replicas with leader election enabled
- Configure pod disruption budgets to prevent simultaneous eviction
- Pin the operator to dedicated infrastructure nodes using tolerations

**Security Hardening**
- Run as a non-root user with a read-only root filesystem
- Drop all Linux capabilities
- Use a dedicated service account with minimal RBAC permissions
- Enable Seccomp with RuntimeDefault profile

**Operational Readiness**
- Set resource requests and limits on the operator deployment
- Configure horizontal pod autoscaler if reconcile throughput is high
- Export and alert on reconcile error counters
- Store all NamespaceConfig resources in version control

**Namespace Onboarding Workflow**
- Establish a label convention (for example, `team: <team-slug>`) that triggers provisioning
- Create a self-service portal or Backstage plugin that adds the label and commits to Git
- Use a validating admission webhook to reject namespace creation without the required labels

## Troubleshooting Common Issues

**Reconcile loop not triggering on namespace creation**
Verify the namespace watch is registered in `SetupWithManager`. Check operator logs for `"starting event source"` messages during startup.

**ResourceQuota not appearing in namespace**
Check the operator service account has `create` and `update` verbs on `resourcequotas` in the target namespace. RBAC denials appear in API server audit logs.

**Finalizer preventing NamespaceConfig deletion**
The finalizer blocks deletion until cleanup succeeds. If cleanup is failing, check whether previously managed namespaces still exist. Patch the finalizer manually only as a last resort:

```bash
kubectl patch namespaceconfiguration platform-team-standard \
  --type=json \
  -p='[{"op":"remove","path":"/metadata/finalizers"}]'
```

**Network policy conflicts**
If workloads cannot communicate after a NamespaceConfig is applied, use `kubectl describe networkpolicy` and review the ingress/egress rules. Use `kubectl exec` with `curl` to test connectivity from within pods.

## Summary

A namespace lifecycle operator enforces a consistent contract across every team namespace in a cluster. By encoding RBAC, resource quotas, limit ranges, and network policies as code in a `NamespaceConfig` CRD, platform teams eliminate manual provisioning toil, reduce configuration drift, and gain a clear audit trail through GitOps tooling. The patterns shown here—finalizer-based cleanup, namespace watch triggers, and Prometheus instrumentation—apply equally to other operator use cases where child resource lifecycle must track a parent configuration.
