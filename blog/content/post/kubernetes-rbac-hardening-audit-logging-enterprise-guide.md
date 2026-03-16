---
title: "Kubernetes RBAC Hardening and Audit Logging: Enterprise Security Implementation Guide"
date: 2026-09-08T00:00:00-05:00
draft: false
tags: ["Kubernetes", "RBAC", "Security", "Audit", "Authorization", "Access Control", "Compliance"]
categories: ["Security", "Kubernetes", "Compliance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to hardening Kubernetes RBAC, implementing least-privilege access control, and configuring comprehensive audit logging for enterprise compliance and security."
more_link: "yes"
url: "/kubernetes-rbac-hardening-audit-logging-enterprise-guide/"
---

Role-Based Access Control (RBAC) is the cornerstone of Kubernetes security, providing fine-grained authorization for who can perform what actions on which resources. When combined with comprehensive audit logging, RBAC creates a security foundation that meets the most stringent enterprise and compliance requirements.

In this comprehensive guide, we'll explore production-proven strategies for RBAC hardening, implementing least-privilege access patterns, automating RBAC management at scale, and configuring audit logging that provides complete visibility into cluster activity while remaining performant and manageable.

<!--more-->

# Understanding Kubernetes RBAC Architecture

## RBAC Components and Authorization Flow

Kubernetes RBAC consists of four primary resources that work together to control access:

**Roles and ClusterRoles**: Define sets of permissions (rules) that specify which actions can be performed on which resources.

**RoleBindings and ClusterRoleBindings**: Associate roles with users, groups, or service accounts, granting the defined permissions.

**Subjects**: Entities (users, groups, or service accounts) that are granted permissions through bindings.

**Rules**: Individual permission statements that allow specific actions (verbs) on specific resources.

Let's examine enterprise-grade RBAC implementations:

```yaml
# rbac-foundation.yaml - Enterprise RBAC Foundation
---
# Namespace Admin Role - Full control within namespace
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: namespace-admin
  namespace: production
  labels:
    rbac.authorization.k8s.io/aggregate-to-admin: "true"
rules:
- apiGroups: ["*"]
  resources: ["*"]
  verbs: ["*"]
# Explicitly deny dangerous operations
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["delete", "deletecollection"]
  resourceNames: ["critical-secret"]
---
# Developer Role - Read/Write for applications
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: developer
  namespace: production
rules:
# Core resources
- apiGroups: [""]
  resources:
  - pods
  - pods/log
  - pods/portforward
  - configmaps
  - services
  - persistentvolumeclaims
  verbs: ["get", "list", "watch", "create", "update", "patch"]

# Applications
- apiGroups: ["apps"]
  resources:
  - deployments
  - statefulsets
  - daemonsets
  - replicasets
  verbs: ["get", "list", "watch", "create", "update", "patch"]

# Read-only for secrets (no list to prevent enumeration)
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["get"]

# Batch jobs
- apiGroups: ["batch"]
  resources:
  - jobs
  - cronjobs
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]

# Networking
- apiGroups: ["networking.k8s.io"]
  resources:
  - ingresses
  - networkpolicies
  verbs: ["get", "list", "watch", "create", "update", "patch"]

# Horizontal Pod Autoscaler
- apiGroups: ["autoscaling"]
  resources:
  - horizontalpodautoscalers
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]

# Service mesh resources (Istio)
- apiGroups: ["networking.istio.io"]
  resources:
  - virtualservices
  - destinationrules
  - gateways
  verbs: ["get", "list", "watch", "create", "update", "patch"]
---
# Read-Only Role - View-only access
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: viewer
  namespace: production
rules:
- apiGroups: [""]
  resources:
  - pods
  - pods/log
  - configmaps
  - services
  - persistentvolumeclaims
  - events
  verbs: ["get", "list", "watch"]

- apiGroups: ["apps"]
  resources:
  - deployments
  - statefulsets
  - daemonsets
  - replicasets
  verbs: ["get", "list", "watch"]

- apiGroups: ["batch"]
  resources:
  - jobs
  - cronjobs
  verbs: ["get", "list", "watch"]

- apiGroups: ["networking.k8s.io"]
  resources:
  - ingresses
  - networkpolicies
  verbs: ["get", "list", "watch"]
---
# Cluster-level roles
---
# Cluster Viewer - Read-only cluster-wide
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: cluster-viewer
  labels:
    rbac.support.tools/role-type: "monitoring"
rules:
- apiGroups: [""]
  resources:
  - nodes
  - namespaces
  - persistentvolumes
  - componentstatuses
  verbs: ["get", "list", "watch"]

- apiGroups: ["storage.k8s.io"]
  resources:
  - storageclasses
  verbs: ["get", "list", "watch"]

- apiGroups: ["rbac.authorization.k8s.io"]
  resources:
  - clusterroles
  - clusterrolebindings
  verbs: ["get", "list"]

- apiGroups: ["metrics.k8s.io"]
  resources:
  - nodes
  - pods
  verbs: ["get", "list"]
---
# Security Auditor - Comprehensive read access for security review
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: security-auditor
  labels:
    rbac.support.tools/role-type: "security"
rules:
# Full read access to all resources
- apiGroups: ["*"]
  resources: ["*"]
  verbs: ["get", "list", "watch"]

# Pod exec/portforward for investigation
- apiGroups: [""]
  resources:
  - pods/exec
  - pods/portforward
  verbs: ["create"]

# Access to audit logs
- apiGroups: ["audit.k8s.io"]
  resources:
  - events
  verbs: ["get", "list", "watch"]
---
# CI/CD Service Account Role
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: ci-cd-deployer
  namespace: production
rules:
# Deployment management
- apiGroups: ["apps"]
  resources:
  - deployments
  - statefulsets
  verbs: ["get", "list", "watch", "create", "update", "patch"]

# Rollout status checking
- apiGroups: ["apps"]
  resources:
  - deployments/status
  - statefulsets/status
  verbs: ["get", "watch"]

# ConfigMap and Secret management
- apiGroups: [""]
  resources:
  - configmaps
  - secrets
  verbs: ["get", "create", "update", "patch"]

# Service management
- apiGroups: [""]
  resources:
  - services
  verbs: ["get", "create", "update", "patch"]

# Ingress management
- apiGroups: ["networking.k8s.io"]
  resources:
  - ingresses
  verbs: ["get", "create", "update", "patch"]
---
# Monitoring Service Account Role
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: monitoring-reader
  labels:
    rbac.support.tools/role-type: "monitoring"
rules:
# Metrics collection
- apiGroups: [""]
  resources:
  - nodes
  - nodes/stats
  - nodes/metrics
  - nodes/proxy
  - services
  - endpoints
  - pods
  verbs: ["get", "list", "watch"]

- apiGroups: ["apps"]
  resources:
  - deployments
  - daemonsets
  - statefulsets
  - replicasets
  verbs: ["get", "list", "watch"]

- apiGroups: ["batch"]
  resources:
  - jobs
  - cronjobs
  verbs: ["get", "list", "watch"]

# Metrics API
- apiGroups: ["metrics.k8s.io"]
  resources:
  - nodes
  - pods
  verbs: ["get", "list"]

# Custom metrics
- apiGroups: ["custom.metrics.k8s.io"]
  resources: ["*"]
  verbs: ["get", "list"]
---
# Backup Service Account Role
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: backup-operator
  labels:
    rbac.support.tools/role-type: "operations"
rules:
# Full read access for backup
- apiGroups: ["*"]
  resources: ["*"]
  verbs: ["get", "list", "watch"]

# Volume snapshot management
- apiGroups: ["snapshot.storage.k8s.io"]
  resources:
  - volumesnapshots
  - volumesnapshotcontents
  - volumesnapshotclasses
  verbs: ["*"]

# PV/PVC management for restore
- apiGroups: [""]
  resources:
  - persistentvolumes
  - persistentvolumeclaims
  verbs: ["get", "list", "create", "update", "patch"]
```

## RoleBinding Examples

```yaml
# rolebindings.yaml - Binding Examples
---
# Team-based access control
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: team-alpha-developers
  namespace: production
subjects:
# Group binding (from OIDC/LDAP)
- kind: Group
  name: "team-alpha"
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: developer
  apiGroup: rbac.authorization.k8s.io
---
# Individual user binding
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: john-admin
  namespace: production
subjects:
- kind: User
  name: "john@company.com"
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: namespace-admin
  apiGroup: rbac.authorization.k8s.io
---
# Service account binding for CI/CD
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ci-cd-deployer-binding
  namespace: production
subjects:
- kind: ServiceAccount
  name: gitlab-runner
  namespace: ci-cd
roleRef:
  kind: Role
  name: ci-cd-deployer
  apiGroup: rbac.authorization.k8s.io
---
# ClusterRoleBinding for monitoring
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: prometheus-monitoring
subjects:
- kind: ServiceAccount
  name: prometheus
  namespace: monitoring
roleRef:
  kind: ClusterRole
  name: monitoring-reader
  apiGroup: rbac.authorization.k8s.io
---
# Security team access
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: security-team-auditors
subjects:
- kind: Group
  name: "security-team"
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: security-auditor
  apiGroup: rbac.authorization.k8s.io
```

# Advanced RBAC Patterns

## Attribute-Based Access Control (ABAC) with RBAC

Implement dynamic access control based on resource attributes:

```yaml
# dynamic-rbac.yaml - Attribute-based patterns
---
# Label-based access control
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: environment-scoped-developer
  namespace: multi-tenant
rules:
# Only access pods with specific labels
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  # Note: RBAC doesn't support label selectors directly
  # This must be enforced via admission controllers (OPA/Gatekeeper)
---
# Time-based access with annotations
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: temporary-access
  namespace: production
  annotations:
    rbac.support.tools/expires: "2025-12-31T23:59:59Z"
    rbac.support.tools/justification: "Emergency production access for incident #1234"
    rbac.support.tools/approved-by: "senior-engineer@company.com"
subjects:
- kind: User
  name: "junior-engineer@company.com"
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: developer
  apiGroup: rbac.authorization.k8s.io
```

## Service Account Token Security

Implement secure service account token management:

```yaml
# service-account-security.yaml
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: application-sa
  namespace: production
  annotations:
    # Disable automatic token mounting
    kubernetes.io/enforce-mountable-secrets: "true"
automountServiceAccountToken: false
---
# Use projected volumes for short-lived tokens
apiVersion: apps/v1
kind: Deployment
metadata:
  name: secure-app
  namespace: production
spec:
  template:
    spec:
      serviceAccountName: application-sa
      # Don't automount default token
      automountServiceAccountToken: false
      containers:
      - name: app
        image: myapp:latest
        volumeMounts:
        - name: sa-token
          mountPath: /var/run/secrets/tokens
          readOnly: true
      volumes:
      - name: sa-token
        projected:
          sources:
          - serviceAccountToken:
              path: token
              expirationSeconds: 3600  # 1 hour
              audience: api
          - configMap:
              name: ca-bundle
              items:
              - key: ca.crt
                path: ca.crt
          - downwardAPI:
              items:
              - path: namespace
                fieldRef:
                  fieldPath: metadata.namespace
```

# RBAC Audit and Compliance

## Automated RBAC Analysis Tool

Create a tool to analyze and report on RBAC configurations:

```go
// rbac-analyzer.go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "net/http"
    "strings"
    "time"

    rbacv1 "k8s.io/api/rbac/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes"
    "k8s.io/client-go/rest"
)

type RBACAnalysisReport struct {
    Timestamp                time.Time           `json:"timestamp"`
    TotalRoles               int                 `json:"total_roles"`
    TotalClusterRoles        int                 `json:"total_cluster_roles"`
    TotalRoleBindings        int                 `json:"total_role_bindings"`
    TotalClusterRoleBindings int                 `json:"total_cluster_role_bindings"`
    OverprivilegedRoles      []OverprivilegedRole `json:"overprivileged_roles"`
    UnusedRoles              []string            `json:"unused_roles"`
    WildcardPermissions      []WildcardUsage     `json:"wildcard_permissions"`
    ExpiredBindings          []ExpiredBinding    `json:"expired_bindings"`
    ServiceAccountAnalysis   ServiceAccountStats `json:"service_account_analysis"`
    Recommendations          []string            `json:"recommendations"`
}

type OverprivilegedRole struct {
    Name       string   `json:"name"`
    Namespace  string   `json:"namespace,omitempty"`
    Type       string   `json:"type"`
    Reasons    []string `json:"reasons"`
    Severity   string   `json:"severity"`
}

type WildcardUsage struct {
    Role      string `json:"role"`
    Namespace string `json:"namespace,omitempty"`
    Rule      string `json:"rule"`
}

type ExpiredBinding struct {
    Name      string    `json:"name"`
    Namespace string    `json:"namespace,omitempty"`
    ExpiryTime time.Time `json:"expiry_time"`
    Subject   string    `json:"subject"`
}

type ServiceAccountStats struct {
    TotalServiceAccounts          int      `json:"total_service_accounts"`
    AutoMountEnabled              int      `json:"automount_enabled"`
    ServiceAccountsWithoutBinding int      `json:"without_bindings"`
    UnusedServiceAccounts         []string `json:"unused_service_accounts"`
}

type RBACAnalyzer struct {
    clientset *kubernetes.Clientset
}

func NewRBACAnalyzer() (*RBACAnalyzer, error) {
    config, err := rest.InClusterConfig()
    if err != nil {
        return nil, err
    }

    clientset, err := kubernetes.NewForConfig(config)
    if err != nil {
        return nil, err
    }

    return &RBACAnalyzer{
        clientset: clientset,
    }, nil
}

func (ra *RBACAnalyzer) AnalyzeRBAC() (*RBACAnalysisReport, error) {
    report := &RBACAnalysisReport{
        Timestamp:           time.Now(),
        OverprivilegedRoles: []OverprivilegedRole{},
        UnusedRoles:         []string{},
        WildcardPermissions: []WildcardUsage{},
        ExpiredBindings:     []ExpiredBinding{},
        Recommendations:     []string{},
    }

    // Analyze Roles
    if err := ra.analyzeRoles(report); err != nil {
        return nil, err
    }

    // Analyze ClusterRoles
    if err := ra.analyzeClusterRoles(report); err != nil {
        return nil, err
    }

    // Analyze RoleBindings
    if err := ra.analyzeRoleBindings(report); err != nil {
        return nil, err
    }

    // Analyze ClusterRoleBindings
    if err := ra.analyzeClusterRoleBindings(report); err != nil {
        return nil, err
    }

    // Analyze Service Accounts
    if err := ra.analyzeServiceAccounts(report); err != nil {
        return nil, err
    }

    // Generate recommendations
    ra.generateRecommendations(report)

    return report, nil
}

func (ra *RBACAnalyzer) analyzeRoles(report *RBACAnalysisReport) error {
    roles, err := ra.clientset.RbacV1().Roles("").List(
        context.TODO(),
        metav1.ListOptions{},
    )
    if err != nil {
        return err
    }

    report.TotalRoles = len(roles.Items)

    for _, role := range roles.Items {
        // Check for overprivileged roles
        if ra.isOverprivileged(&role.Rules) {
            report.OverprivilegedRoles = append(report.OverprivilegedRoles, OverprivilegedRole{
                Name:      role.Name,
                Namespace: role.Namespace,
                Type:      "Role",
                Reasons:   ra.getOverprivilegeReasons(&role.Rules),
                Severity:  ra.calculateSeverity(&role.Rules),
            })
        }

        // Check for wildcard permissions
        for _, rule := range role.Rules {
            if ra.hasWildcard(&rule) {
                report.WildcardPermissions = append(report.WildcardPermissions, WildcardUsage{
                    Role:      role.Name,
                    Namespace: role.Namespace,
                    Rule:      ra.ruleToString(&rule),
                })
            }
        }
    }

    return nil
}

func (ra *RBACAnalyzer) analyzeClusterRoles(report *RBACAnalysisReport) error {
    clusterRoles, err := ra.clientset.RbacV1().ClusterRoles().List(
        context.TODO(),
        metav1.ListOptions{},
    )
    if err != nil {
        return err
    }

    report.TotalClusterRoles = len(clusterRoles.Items)

    for _, role := range clusterRoles.Items {
        // Skip system roles
        if strings.HasPrefix(role.Name, "system:") {
            continue
        }

        if ra.isOverprivileged(&role.Rules) {
            report.OverprivilegedRoles = append(report.OverprivilegedRoles, OverprivilegedRole{
                Name:     role.Name,
                Type:     "ClusterRole",
                Reasons:  ra.getOverprivilegeReasons(&role.Rules),
                Severity: ra.calculateSeverity(&role.Rules),
            })
        }

        for _, rule := range role.Rules {
            if ra.hasWildcard(&rule) {
                report.WildcardPermissions = append(report.WildcardPermissions, WildcardUsage{
                    Role: role.Name,
                    Rule: ra.ruleToString(&rule),
                })
            }
        }
    }

    return nil
}

func (ra *RBACAnalyzer) analyzeRoleBindings(report *RBACAnalysisReport) error {
    bindings, err := ra.clientset.RbacV1().RoleBindings("").List(
        context.TODO(),
        metav1.ListOptions{},
    )
    if err != nil {
        return err
    }

    report.TotalRoleBindings = len(bindings.Items)

    for _, binding := range bindings.Items {
        // Check for expired bindings
        if expiryStr, ok := binding.Annotations["rbac.support.tools/expires"]; ok {
            expiry, err := time.Parse(time.RFC3339, expiryStr)
            if err == nil && expiry.Before(time.Now()) {
                report.ExpiredBindings = append(report.ExpiredBindings, ExpiredBinding{
                    Name:       binding.Name,
                    Namespace:  binding.Namespace,
                    ExpiryTime: expiry,
                    Subject:    ra.subjectsToString(binding.Subjects),
                })
            }
        }
    }

    return nil
}

func (ra *RBACAnalyzer) analyzeClusterRoleBindings(report *RBACAnalysisReport) error {
    bindings, err := ra.clientset.RbacV1().ClusterRoleBindings().List(
        context.TODO(),
        metav1.ListOptions{},
    )
    if err != nil {
        return err
    }

    report.TotalClusterRoleBindings = len(bindings.Items)

    for _, binding := range bindings.Items {
        if expiryStr, ok := binding.Annotations["rbac.support.tools/expires"]; ok {
            expiry, err := time.Parse(time.RFC3339, expiryStr)
            if err == nil && expiry.Before(time.Now()) {
                report.ExpiredBindings = append(report.ExpiredBindings, ExpiredBinding{
                    Name:       binding.Name,
                    ExpiryTime: expiry,
                    Subject:    ra.subjectsToString(binding.Subjects),
                })
            }
        }
    }

    return nil
}

func (ra *RBACAnalyzer) analyzeServiceAccounts(report *RBACAnalysisReport) error {
    serviceAccounts, err := ra.clientset.CoreV1().ServiceAccounts("").List(
        context.TODO(),
        metav1.ListOptions{},
    )
    if err != nil {
        return err
    }

    report.ServiceAccountAnalysis.TotalServiceAccounts = len(serviceAccounts.Items)

    for _, sa := range serviceAccounts.Items {
        // Skip system service accounts
        if sa.Namespace == "kube-system" || sa.Namespace == "kube-public" {
            continue
        }

        // Check automount setting
        if sa.AutomountServiceAccountToken == nil || *sa.AutomountServiceAccountToken {
            report.ServiceAccountAnalysis.AutoMountEnabled++
        }
    }

    return nil
}

func (ra *RBACAnalyzer) isOverprivileged(rules *[]rbacv1.PolicyRule) bool {
    for _, rule := range *rules {
        // Check for dangerous permissions
        if ra.containsAll(rule.APIGroups, "*") &&
           ra.containsAll(rule.Resources, "*") &&
           ra.containsAll(rule.Verbs, "*") {
            return true
        }

        // Check for cluster-admin equivalent permissions
        if ra.contains(rule.Verbs, "*") ||
           (ra.contains(rule.Verbs, "create") &&
            ra.contains(rule.Verbs, "delete") &&
            ra.contains(rule.Verbs, "update")) {
            if ra.containsAny(rule.Resources, []string{"clusterroles", "clusterrolebindings", "roles", "rolebindings"}) {
                return true
            }
        }

        // Check for secret access with delete
        if ra.contains(rule.Resources, "secrets") &&
           (ra.contains(rule.Verbs, "delete") || ra.contains(rule.Verbs, "*")) {
            return true
        }
    }

    return false
}

func (ra *RBACAnalyzer) getOverprivilegeReasons(rules *[]rbacv1.PolicyRule) []string {
    reasons := []string{}

    for _, rule := range *rules {
        if ra.containsAll(rule.APIGroups, "*") {
            reasons = append(reasons, "Grants access to all API groups")
        }
        if ra.containsAll(rule.Resources, "*") {
            reasons = append(reasons, "Grants access to all resources")
        }
        if ra.containsAll(rule.Verbs, "*") {
            reasons = append(reasons, "Grants all verbs (including delete)")
        }
        if ra.contains(rule.Resources, "secrets") && ra.contains(rule.Verbs, "list") {
            reasons = append(reasons, "Allows listing secrets (enumeration risk)")
        }
    }

    return reasons
}

func (ra *RBACAnalyzer) calculateSeverity(rules *[]rbacv1.PolicyRule) string {
    score := 0

    for _, rule := range *rules {
        if ra.containsAll(rule.Verbs, "*") {
            score += 3
        }
        if ra.containsAll(rule.Resources, "*") {
            score += 3
        }
        if ra.contains(rule.Resources, "secrets") {
            score += 2
        }
        if ra.containsAny(rule.Resources, []string{"clusterroles", "clusterrolebindings"}) {
            score += 2
        }
    }

    if score >= 6 {
        return "CRITICAL"
    } else if score >= 3 {
        return "HIGH"
    } else if score >= 1 {
        return "MEDIUM"
    }
    return "LOW"
}

func (ra *RBACAnalyzer) hasWildcard(rule *rbacv1.PolicyRule) bool {
    return ra.containsAll(rule.APIGroups, "*") ||
           ra.containsAll(rule.Resources, "*") ||
           ra.containsAll(rule.Verbs, "*")
}

func (ra *RBACAnalyzer) ruleToString(rule *rbacv1.PolicyRule) string {
    return fmt.Sprintf("APIGroups:%v Resources:%v Verbs:%v",
        rule.APIGroups, rule.Resources, rule.Verbs)
}

func (ra *RBACAnalyzer) subjectsToString(subjects []rbacv1.Subject) string {
    names := []string{}
    for _, subject := range subjects {
        names = append(names, fmt.Sprintf("%s:%s", subject.Kind, subject.Name))
    }
    return strings.Join(names, ", ")
}

func (ra *RBACAnalyzer) contains(slice []string, item string) bool {
    for _, s := range slice {
        if s == item {
            return true
        }
    }
    return false
}

func (ra *RBACAnalyzer) containsAll(slice []string, item string) bool {
    return len(slice) == 1 && slice[0] == item
}

func (ra *RBACAnalyzer) containsAny(slice []string, items []string) bool {
    for _, item := range items {
        if ra.contains(slice, item) {
            return true
        }
    }
    return false
}

func (ra *RBACAnalyzer) generateRecommendations(report *RBACAnalysisReport) {
    if len(report.OverprivilegedRoles) > 0 {
        report.Recommendations = append(report.Recommendations,
            fmt.Sprintf("Found %d overprivileged roles. Review and apply least-privilege principle.",
                len(report.OverprivilegedRoles)))
    }

    if len(report.WildcardPermissions) > 0 {
        report.Recommendations = append(report.Recommendations,
            fmt.Sprintf("Found %d roles using wildcard permissions. Replace with specific permissions.",
                len(report.WildcardPermissions)))
    }

    if len(report.ExpiredBindings) > 0 {
        report.Recommendations = append(report.Recommendations,
            fmt.Sprintf("Found %d expired bindings. Remove them immediately.",
                len(report.ExpiredBindings)))
    }

    if report.ServiceAccountAnalysis.AutoMountEnabled > 0 {
        report.Recommendations = append(report.Recommendations,
            fmt.Sprintf("%d service accounts have automountServiceAccountToken enabled. Disable unless necessary.",
                report.ServiceAccountAnalysis.AutoMountEnabled))
    }
}

func (ra *RBACAnalyzer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    report, err := ra.AnalyzeRBAC()
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(report)
}

func main() {
    analyzer, err := NewRBACAnalyzer()
    if err != nil {
        log.Fatalf("Failed to create RBAC analyzer: %v", err)
    }

    http.HandleFunc("/analyze", analyzer.ServeHTTP)
    http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    })

    log.Println("Starting RBAC analyzer on :8080")
    if err := http.ListenAndServe(":8080", nil); err != nil {
        log.Fatalf("Server failed: %v", err)
    }
}
```

# Comprehensive Audit Logging

## Audit Policy Configuration

Implement detailed audit logging for compliance and security:

```yaml
# audit-policy.yaml - Comprehensive Audit Policy
apiVersion: audit.k8s.io/v1
kind: Policy
# Don't generate audit events for all requests in RequestReceived stage
omitStages:
  - "RequestReceived"
rules:
  # Log pod exec/attach at RequestResponse level
  - level: RequestResponse
    verbs: ["create"]
    resources:
    - group: ""
      resources: ["pods/exec", "pods/attach", "pods/portforward"]

  # Log authentication and authorization events
  - level: Metadata
    resources:
    - group: "authentication.k8s.io"
      resources: ["tokenreviews"]
    - group: "authorization.k8s.io"
      resources: ["subjectaccessreviews", "localsubjectaccessreviews", "selfsubjectaccessreviews"]

  # Log secret, configmap changes at metadata level
  - level: Metadata
    resources:
    - group: ""
      resources: ["secrets", "configmaps"]
    - group: "rbac.authorization.k8s.io"
      resources: ["clusterroles", "roles", "clusterrolebindings", "rolebindings"]

  # Log changes to security policies
  - level: RequestResponse
    resources:
    - group: "policy"
      resources: ["podsecuritypolicies"]
    - group: "networking.k8s.io"
      resources: ["networkpolicies"]
    - group: "authorization.k8s.io"
      resources: ["subjectaccessreviews"]

  # Log workload changes at Request level
  - level: Request
    verbs: ["create", "update", "patch", "delete"]
    resources:
    - group: "apps"
      resources: ["deployments", "daemonsets", "statefulsets", "replicasets"]
    - group: "batch"
      resources: ["jobs", "cronjobs"]

  # Log admission webhook decisions
  - level: Request
    verbs: ["create", "update"]
    resources:
    - group: "admissionregistration.k8s.io"
      resources: ["validatingwebhookconfigurations", "mutatingwebhookconfigurations"]

  # Log service account token creation
  - level: Metadata
    verbs: ["create"]
    resources:
    - group: ""
      resources: ["serviceaccounts/token"]

  # Don't log read-only requests at all
  - level: None
    verbs: ["get", "list", "watch"]

  # Don't log system components
  - level: None
    users:
    - "system:kube-proxy"
    - "system:kube-scheduler"
    - "system:kube-controller-manager"
    - "system:serviceaccount:kube-system:endpoint-controller"

  # Don't log health checks
  - level: None
    nonResourceURLs:
    - "/healthz*"
    - "/version"
    - "/swagger*"

  # Log everything else at Metadata level
  - level: Metadata
```

## API Server Configuration for Audit Logging

```yaml
# kube-apiserver-audit.yaml - API Server Audit Configuration
apiVersion: v1
kind: Pod
metadata:
  name: kube-apiserver
  namespace: kube-system
spec:
  containers:
  - name: kube-apiserver
    command:
    - kube-apiserver
    # Audit logging flags
    - --audit-policy-file=/etc/kubernetes/audit-policy.yaml
    - --audit-log-path=/var/log/kubernetes/audit.log
    - --audit-log-maxage=30
    - --audit-log-maxbackup=10
    - --audit-log-maxsize=100
    - --audit-log-format=json
    # Optional: Send to webhook
    - --audit-webhook-config-file=/etc/kubernetes/audit-webhook.yaml
    - --audit-webhook-batch-max-size=100
    - --audit-webhook-batch-max-wait=5s
    volumeMounts:
    - name: audit-policy
      mountPath: /etc/kubernetes/audit-policy.yaml
      readOnly: true
    - name: audit-logs
      mountPath: /var/log/kubernetes
    - name: audit-webhook
      mountPath: /etc/kubernetes/audit-webhook.yaml
      readOnly: true
  volumes:
  - name: audit-policy
    hostPath:
      path: /etc/kubernetes/audit-policy.yaml
      type: File
  - name: audit-logs
    hostPath:
      path: /var/log/kubernetes
      type: DirectoryOrCreate
  - name: audit-webhook
    hostPath:
      path: /etc/kubernetes/audit-webhook.yaml
      type: File
```

## Audit Log Analysis and Alerting

```python
# audit-analyzer.py - Audit Log Analysis
import json
import re
from datetime import datetime, timedelta
from collections import defaultdict
import logging

class AuditLogAnalyzer:
    def __init__(self, log_file):
        self.log_file = log_file
        self.alerts = []
        self.statistics = defaultdict(int)

    def analyze(self):
        """Analyze audit logs for suspicious activity"""
        with open(self.log_file, 'r') as f:
            for line in f:
                try:
                    event = json.loads(line)
                    self.analyze_event(event)
                except json.JSONDecodeError:
                    continue

        return {
            'alerts': self.alerts,
            'statistics': dict(self.statistics)
        }

    def analyze_event(self, event):
        """Analyze individual audit event"""
        self.statistics['total_events'] += 1

        # Check for privilege escalation attempts
        if self.is_privilege_escalation(event):
            self.create_alert('PRIVILEGE_ESCALATION', event)

        # Check for secret access
        if self.is_secret_access(event):
            self.create_alert('SECRET_ACCESS', event)

        # Check for RBAC modifications
        if self.is_rbac_modification(event):
            self.create_alert('RBAC_MODIFICATION', event)

        # Check for pod exec
        if self.is_pod_exec(event):
            self.create_alert('POD_EXEC', event)

        # Check for failed authentication
        if self.is_auth_failure(event):
            self.statistics['auth_failures'] += 1
            if self.statistics['auth_failures'] > 10:
                self.create_alert('BRUTE_FORCE_ATTEMPT', event)

    def is_privilege_escalation(self, event):
        """Detect privilege escalation attempts"""
        if event.get('verb') in ['create', 'update', 'patch']:
            resource = event.get('objectRef', {})
            if resource.get('resource') in ['clusterrolebindings', 'rolebindings']:
                # Check if binding grants cluster-admin or similar
                request_object = event.get('requestObject', {})
                role_ref = request_object.get('roleRef', {})
                if role_ref.get('name') in ['cluster-admin', 'admin']:
                    return True
        return False

    def is_secret_access(self, event):
        """Detect secret access"""
        resource = event.get('objectRef', {})
        if resource.get('resource') == 'secrets':
            if event.get('verb') in ['get', 'list', 'watch']:
                user = event.get('user', {}).get('username', '')
                # Alert on non-system user access
                if not user.startswith('system:'):
                    return True
        return False

    def is_rbac_modification(self, event):
        """Detect RBAC modifications"""
        if event.get('verb') in ['create', 'update', 'patch', 'delete']:
            resource = event.get('objectRef', {})
            if resource.get('resource') in ['roles', 'clusterroles',
                                           'rolebindings', 'clusterrolebindings']:
                return True
        return False

    def is_pod_exec(self, event):
        """Detect pod exec"""
        resource = event.get('objectRef', {})
        if resource.get('resource') == 'pods' and \
           resource.get('subresource') == 'exec':
            return True
        return False

    def is_auth_failure(self, event):
        """Detect authentication failures"""
        return event.get('responseStatus', {}).get('code') == 401

    def create_alert(self, alert_type, event):
        """Create security alert"""
        alert = {
            'type': alert_type,
            'timestamp': event.get('timestamp'),
            'user': event.get('user', {}).get('username'),
            'source_ip': event.get('sourceIPs', [])[0] if event.get('sourceIPs') else None,
            'resource': event.get('objectRef', {}).get('resource'),
            'verb': event.get('verb'),
            'namespace': event.get('objectRef', {}).get('namespace'),
            'response_code': event.get('responseStatus', {}).get('code')
        }
        self.alerts.append(alert)
        logging.warning(f"Security Alert: {alert_type} - {json.dumps(alert)}")

if __name__ == '__main__':
    analyzer = AuditLogAnalyzer('/var/log/kubernetes/audit.log')
    results = analyzer.analyze()
    print(json.dumps(results, indent=2))
```

# Best Practices and Recommendations

## RBAC Security Principles

1. **Least Privilege**: Grant only the minimum permissions required
2. **Namespace Isolation**: Use RoleBindings instead of ClusterRoleBindings when possible
3. **Regular Audits**: Periodically review and cleanup unused roles and bindings
4. **Temporary Access**: Use time-limited bindings with expiration annotations
5. **Service Account Security**: Disable automount unless necessary

## Audit Logging Best Practices

1. **Structured Logging**: Use JSON format for easier parsing
2. **Log Rotation**: Implement proper log rotation to manage disk space
3. **Centralized Storage**: Send audit logs to centralized SIEM system
4. **Real-time Alerting**: Implement automated alerting for critical events
5. **Compliance Retention**: Maintain audit logs per compliance requirements (typically 90-365 days)

## Monitoring and Alerting

1. **RBAC Changes**: Alert on any RBAC role or binding modifications
2. **Privilege Escalation**: Detect attempts to gain cluster-admin access
3. **Secret Access**: Monitor and alert on secret access patterns
4. **Failed Authentication**: Track authentication failures for brute force detection
5. **Anomalous Activity**: Baseline normal behavior and alert on deviations

# Conclusion

Kubernetes RBAC combined with comprehensive audit logging provides a robust foundation for cluster security and compliance. By implementing least-privilege access control, regularly auditing permissions, and maintaining detailed audit logs, organizations can meet stringent security requirements while enabling teams to work productively.

The key is to start with restrictive policies and gradually expand permissions based on actual needs, while continuously monitoring for security violations and compliance drift. Automated tools for RBAC analysis and audit log monitoring are essential for managing security at scale across multiple clusters.