---
title: "Infrastructure Testing: Terratest, Conftest, and Policy-as-Code Validation"
date: 2028-02-20T00:00:00-05:00
draft: false
tags: ["Terraform", "Terratest", "Conftest", "OPA", "Kubernetes", "IaC", "Security", "Testing"]
categories:
- DevOps
- Infrastructure
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to infrastructure testing using Terratest for Terraform modules, Conftest with OPA for policy validation, kube-score for Kubernetes manifest analysis, Polaris auditing, and Checkov for IaC security scanning."
more_link: "yes"
url: "/devops-infrastructure-testing-guide/"
---

Infrastructure code is production code. Untested Terraform modules, Kubernetes manifests without policy validation, and Helm charts without security checks reach production with the same confidence deficit as application code deployed without unit tests. The difference is that infrastructure failures tend to be categorical—a misconfigured security group exposes all services, a missing resource limit causes node-level resource starvation, an unvalidated IAM policy grants unintended permissions cluster-wide.

A mature infrastructure testing strategy combines multiple layers: Terratest for end-to-end validation of Terraform modules in real cloud environments, OPA/Conftest for policy-as-code validation of configuration files at CI time, kube-score and Polaris for Kubernetes manifest quality checks, and Checkov for automated security scanning of IaC across Terraform, Helm, and Kubernetes manifests.

<!--more-->

# Infrastructure Testing: Terratest, Conftest, and Policy-as-Code Validation

## The Infrastructure Testing Pyramid

Infrastructure testing follows a similar pyramid to application testing, with fast static analysis at the base and slower environment tests at the apex:

```
                     /\
                    /  \
                   / E2E\     <- Full environment tests (slow, expensive)
                  /------\
                 /Integr. \   <- Module integration tests (Terratest)
                /----------\
               /  Contract  \ <- Policy/schema validation (Conftest)
              /--------------\
             /    Static     \  <- Linting/security scanning (Checkov, kube-score)
            /----------------\
           /     Unit Tests   \ <- HCL unit tests, OPA unit tests
          /--------------------\
```

Each layer catches different defect classes. Static analysis catches misconfigurations before any infrastructure is provisioned. Policy validation enforces organizational standards. Integration tests catch provider behavior differences and interaction effects. End-to-end tests validate complete application stacks.

## Terratest: Go-Based Infrastructure Testing

Terratest is a Go testing library that applies standard software testing practices to infrastructure code. Tests create real infrastructure, validate it, and tear it down.

### Setting Up Terratest

```go
// go.mod for infrastructure tests
// tests/go.mod
module github.com/example/infra-tests

go 1.21

require (
    // Terratest core library
    github.com/gruntwork-io/terratest v0.46.0
    // Standard Go testing libraries
    github.com/stretchr/testify v1.8.4
    // AWS SDK for custom validation
    github.com/aws/aws-sdk-go-v2/config v1.26.0
    github.com/aws/aws-sdk-go-v2/service/s3 v1.47.0
)
```

### Testing a Terraform VPC Module

```go
// tests/vpc_test.go
// Integration test for a Terraform VPC module.
// Creates a real VPC in AWS, validates properties, then destroys it.
package test

import (
    "fmt"
    "testing"
    "time"

    "github.com/gruntwork-io/terratest/modules/aws"
    "github.com/gruntwork-io/terratest/modules/retry"
    "github.com/gruntwork-io/terratest/modules/terraform"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestVPCModule(t *testing.T) {
    t.Parallel()   // Run multiple tests concurrently

    // Region for test resources
    awsRegion := "us-east-1"

    // Unique suffix prevents collisions when tests run in parallel
    uniqueID := terraform.UniqueID()
    vpcName := fmt.Sprintf("test-vpc-%s", uniqueID)

    // Terraform options: directory, variables, and environment
    terraformOptions := &terraform.Options{
        // Path to the Terraform module being tested
        TerraformDir: "../../modules/vpc",

        // Input variables for the module
        Vars: map[string]interface{}{
            "vpc_name":          vpcName,
            "vpc_cidr":          "10.100.0.0/16",
            "azs":               []string{"us-east-1a", "us-east-1b", "us-east-1c"},
            "private_subnets":   []string{"10.100.1.0/24", "10.100.2.0/24", "10.100.3.0/24"},
            "public_subnets":    []string{"10.100.101.0/24", "10.100.102.0/24", "10.100.103.0/24"},
            "enable_nat_gateway": true,
            "single_nat_gateway": false,   // HA: one NAT per AZ
            "tags": map[string]string{
                "Environment": "test",
                "ManagedBy":   "terratest",
                "TestID":      uniqueID,
            },
        },

        // Environment variables passed to Terraform
        EnvVars: map[string]string{
            "AWS_REGION": awsRegion,
        },

        // Retry on errors (handles eventual consistency in AWS)
        RetryableTerraformErrors: map[string]string{
            "Error creating VPC":             "Retry on VPC creation errors",
            "Error creating subnet":          "Retry on subnet creation errors",
            "InvalidInternetGatewayID.NotFound": "IGW not yet available",
        },
        MaxRetries:         3,
        TimeBetweenRetries: 5 * time.Second,
    }

    // CRITICAL: Always destroy resources after the test
    // defer runs even if the test fails
    defer terraform.Destroy(t, terraformOptions)

    // Apply the Terraform module
    terraform.InitAndApply(t, terraformOptions)

    // --- Validation Section ---

    // Read outputs from Terraform state
    vpcID := terraform.Output(t, terraformOptions, "vpc_id")
    privateSubnetIDs := terraform.OutputList(t, terraformOptions, "private_subnets")
    publicSubnetIDs := terraform.OutputList(t, terraformOptions, "public_subnets")

    // Test 1: VPC was created with correct CIDR
    vpcInfo := aws.GetVpcById(t, vpcID, awsRegion)
    assert.Equal(t, "10.100.0.0/16", aws.GetTagValue(vpcInfo.Tags, "CIDR"),
        "VPC CIDR should match specification")

    // Test 2: Correct number of subnets created
    require.Len(t, privateSubnetIDs, 3,
        "Should have 3 private subnets (one per AZ)")
    require.Len(t, publicSubnetIDs, 3,
        "Should have 3 public subnets (one per AZ)")

    // Test 3: Private subnets have route to NAT gateway (not internet gateway)
    for _, subnetID := range privateSubnetIDs {
        routeTable := aws.GetRouteTableForSubnet(t, subnetID, awsRegion)
        hasNATRoute := false
        for _, route := range routeTable.Routes {
            if route.NatGatewayId != nil {
                hasNATRoute = true
                break
            }
        }
        assert.True(t, hasNATRoute,
            "Private subnet %s should have NAT gateway route", subnetID)

        // Verify no direct internet gateway route in private subnets
        for _, route := range routeTable.Routes {
            assert.Nil(t, route.GatewayId,
                "Private subnet %s should NOT have internet gateway route", subnetID)
        }
    }

    // Test 4: Public subnets have route to internet gateway
    for _, subnetID := range publicSubnetIDs {
        routeTable := aws.GetRouteTableForSubnet(t, subnetID, awsRegion)
        hasIGWRoute := false
        for _, route := range routeTable.Routes {
            if route.GatewayId != nil {
                hasIGWRoute = true
                break
            }
        }
        assert.True(t, hasIGWRoute,
            "Public subnet %s should have internet gateway route", subnetID)
    }

    // Test 5: VPC has DNS hostnames enabled (required for some services)
    dnsEnabled := aws.GetVpcAttribute(t, vpcID, "enableDnsHostnames", awsRegion)
    assert.True(t, dnsEnabled, "VPC should have DNS hostnames enabled")

    // Test 6: VPC tags are correct
    assert.Equal(t, vpcName, aws.GetTagValue(vpcInfo.Tags, "Name"),
        "VPC Name tag should match")
    assert.Equal(t, "test", aws.GetTagValue(vpcInfo.Tags, "Environment"),
        "Environment tag should be 'test'")
}
```

### Testing an EKS Cluster Module

```go
// tests/eks_test.go
// Integration test for an EKS cluster Terraform module.
// Validates cluster connectivity, node group health, and RBAC.
package test

import (
    "fmt"
    "testing"
    "time"

    "github.com/gruntwork-io/terratest/modules/k8s"
    "github.com/gruntwork-io/terratest/modules/retry"
    "github.com/gruntwork-io/terratest/modules/terraform"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestEKSClusterModule(t *testing.T) {
    t.Parallel()

    awsRegion := "us-east-1"
    uniqueID := terraform.UniqueID()
    clusterName := fmt.Sprintf("test-eks-%s", uniqueID)

    terraformOptions := &terraform.Options{
        TerraformDir: "../../modules/eks",
        Vars: map[string]interface{}{
            "cluster_name":    clusterName,
            "cluster_version": "1.29",
            "vpc_id":          "vpc-test123",     // Pre-existing test VPC
            "subnet_ids":      []string{"subnet-a", "subnet-b"},
            "node_groups": map[string]interface{}{
                "general": map[string]interface{}{
                    "instance_types": []string{"m6i.large"},
                    "min_size":       1,
                    "max_size":       3,
                    "desired_size":   2,
                },
            },
        },
        EnvVars: map[string]string{
            "AWS_REGION": awsRegion,
        },
    }

    defer terraform.Destroy(t, terraformOptions)
    terraform.InitAndApply(t, terraformOptions)

    // Get kubeconfig from terraform output
    kubeconfigPath := terraform.Output(t, terraformOptions, "kubeconfig_path")

    // Configure kubectl options using the generated kubeconfig
    kubectlOptions := k8s.NewKubectlOptions("", kubeconfigPath, "default")

    // Test 1: All cluster nodes are Ready
    retry.DoWithRetry(t, "Wait for nodes to be ready", 30, 20*time.Second, func() (string, error) {
        nodes, err := k8s.GetNodesE(t, kubectlOptions)
        if err != nil {
            return "", err
        }
        for _, node := range nodes {
            for _, condition := range node.Status.Conditions {
                if condition.Type == "Ready" && condition.Status != "True" {
                    return "", fmt.Errorf("node %s not ready", node.Name)
                }
            }
        }
        return fmt.Sprintf("%d nodes ready", len(nodes)), nil
    })

    // Test 2: Required system pods are running
    systemPods := []struct {
        namespace string
        label     string
    }{
        {"kube-system", "k8s-app=kube-dns"},
        {"kube-system", "app.kubernetes.io/name=aws-load-balancer-controller"},
        {"kube-system", "app=cluster-autoscaler"},
    }

    for _, sp := range systemPods {
        k8s.WaitUntilNumPodsCreated(t, kubectlOptions, metav1.ListOptions{
            LabelSelector: sp.label,
            Namespace:     sp.namespace,
        }, 1, 10, 30*time.Second)

        pods := k8s.ListPods(t, kubectlOptions, metav1.ListOptions{
            LabelSelector: sp.label,
            Namespace:     sp.namespace,
        })

        for _, pod := range pods {
            k8s.WaitUntilPodAvailable(t, kubectlOptions, pod.Name, 10, 30*time.Second)
        }
    }

    // Test 3: Default RBAC configuration is correct
    // Verify that cluster-admin is NOT assigned to the default service account
    clusterRoleBindings := k8s.GetClusterRoleBindings(t, kubectlOptions)
    for _, crb := range clusterRoleBindings {
        if crb.RoleRef.Name == "cluster-admin" {
            for _, subject := range crb.Subjects {
                assert.NotEqual(t, "default", subject.Name,
                    "default ServiceAccount should not have cluster-admin")
                assert.NotEqual(t, "system:serviceaccounts", subject.Name,
                    "All service accounts should not have cluster-admin")
            }
        }
    }

    // Test 4: Deploy a test application to verify cluster functionality
    testNamespace := fmt.Sprintf("test-%s", uniqueID)
    k8s.CreateNamespace(t, kubectlOptions, testNamespace)
    defer k8s.DeleteNamespace(t, kubectlOptions, testNamespace)

    testOptions := k8s.NewKubectlOptions("", kubeconfigPath, testNamespace)
    k8s.KubectlApply(t, testOptions, "testdata/hello-world.yaml")
    defer k8s.KubectlDelete(t, testOptions, "testdata/hello-world.yaml")

    k8s.WaitUntilDeploymentAvailable(t, testOptions, "hello-world", 20, 20*time.Second)

    // Test 5: Service account token projection works (IRSA validation)
    pods := k8s.ListPods(t, testOptions, metav1.ListOptions{
        LabelSelector: "app=hello-world",
    })
    require.Greater(t, len(pods), 0, "Test deployment should have running pods")
}
```

## Conftest: Policy-as-Code with OPA

Conftest uses Open Policy Agent (OPA) to validate configuration files against policies written in Rego. It integrates into CI pipelines to catch policy violations before infrastructure is applied.

### Installing Conftest

```bash
# Install conftest
VERSION=0.49.0
curl -Lo conftest.tar.gz \
  "https://github.com/open-policy-agent/conftest/releases/download/v${VERSION}/conftest_${VERSION}_Linux_x86_64.tar.gz"
tar xzf conftest.tar.gz
sudo mv conftest /usr/local/bin/

# Verify installation
conftest --version
```

### OPA Policies for Terraform

```rego
# policy/terraform/security.rego
# Policies for Terraform plan JSON output.
# Run: terraform plan -out plan.tfplan && terraform show -json plan.tfplan | conftest test -

package terraform.security

import future.keywords.contains
import future.keywords.every
import future.keywords.if

# --- Rule: S3 buckets must have versioning enabled ---
deny contains msg if {
    # Find all S3 bucket resources in the plan
    resource := input.resource_changes[_]
    resource.type == "aws_s3_bucket"
    resource.change.actions[_] != "delete"

    # Check if versioning is enabled
    bucket_name := resource.change.after.bucket
    not versioning_enabled(resource.change.after)

    msg := sprintf(
        "S3 bucket '%s' must have versioning enabled",
        [bucket_name]
    )
}

versioning_enabled(bucket_config) if {
    versioning := bucket_config.versioning[_]
    versioning.enabled == true
}

# --- Rule: RDS instances must have deletion protection enabled ---
deny contains msg if {
    resource := input.resource_changes[_]
    resource.type == "aws_db_instance"
    resource.change.actions[_] != "delete"

    not resource.change.after.deletion_protection

    msg := sprintf(
        "RDS instance '%s' must have deletion_protection = true",
        [resource.address]
    )
}

# --- Rule: Security groups must not allow unrestricted SSH ---
deny contains msg if {
    resource := input.resource_changes[_]
    resource.type == "aws_security_group"
    resource.change.actions[_] != "delete"

    # Check ingress rules for SSH port
    ingress := resource.change.after.ingress[_]
    ingress.from_port <= 22
    ingress.to_port >= 22

    # Allow only if the CIDR is restricted (not 0.0.0.0/0)
    cidr := ingress.cidr_blocks[_]
    cidr == "0.0.0.0/0"

    msg := sprintf(
        "Security group '%s' allows unrestricted SSH (0.0.0.0/0 on port 22). Use a bastion or VPN CIDR instead.",
        [resource.address]
    )
}

# --- Rule: EC2 instances must use approved AMIs ---
approved_ami_owners := {"123456789012", "amazon", "aws-marketplace"}

deny contains msg if {
    resource := input.resource_changes[_]
    resource.type == "aws_instance"
    resource.change.actions[_] != "delete"

    ami_id := resource.change.after.ami
    not ami_from_approved_owner(ami_id)

    msg := sprintf(
        "EC2 instance '%s' uses AMI '%s' which is not from an approved owner",
        [resource.address, ami_id]
    )
}

# Warning (not deny) for instances without monitoring
warn contains msg if {
    resource := input.resource_changes[_]
    resource.type == "aws_instance"
    resource.change.actions[_] != "delete"

    not resource.change.after.monitoring

    msg := sprintf(
        "EC2 instance '%s' should have detailed monitoring enabled",
        [resource.address]
    )
}
```

### OPA Policies for Kubernetes Manifests

```rego
# policy/kubernetes/security.rego
# Security policies for Kubernetes manifests.
# Run: conftest test -p policy/kubernetes/ k8s-manifests/

package kubernetes.security

import future.keywords.contains
import future.keywords.every
import future.keywords.if

# Helper: extract all containers from a workload (handles Pods, Deployments, etc.)
containers[container] if {
    input.kind == "Pod"
    container := input.spec.containers[_]
}

containers[container] if {
    input.kind in {"Deployment", "StatefulSet", "DaemonSet", "Job"}
    container := input.spec.template.spec.containers[_]
}

containers[container] if {
    input.kind in {"Deployment", "StatefulSet", "DaemonSet", "Job"}
    container := input.spec.template.spec.initContainers[_]
}

# --- Rule: Containers must not run as root ---
deny contains msg if {
    container := containers[_]

    # Check if securityContext is missing or allows root
    not container_non_root(container)

    msg := sprintf(
        "Container '%s' in %s '%s' must not run as root. Set securityContext.runAsNonRoot = true or runAsUser > 0",
        [container.name, input.kind, input.metadata.name]
    )
}

container_non_root(container) if {
    container.securityContext.runAsNonRoot == true
}

container_non_root(container) if {
    container.securityContext.runAsUser > 0
}

# --- Rule: Containers must have resource limits set ---
deny contains msg if {
    container := containers[_]

    # Memory limit must be set
    not container.resources.limits.memory

    msg := sprintf(
        "Container '%s' in %s '%s' must have memory limit set. Missing resources.limits.memory",
        [container.name, input.kind, input.metadata.name]
    )
}

deny contains msg if {
    container := containers[_]

    not container.resources.limits.cpu

    msg := sprintf(
        "Container '%s' in %s '%s' must have CPU limit set. Missing resources.limits.cpu",
        [container.name, input.kind, input.metadata.name]
    )
}

# --- Rule: Containers must not allow privilege escalation ---
deny contains msg if {
    container := containers[_]

    # allowPrivilegeEscalation defaults to true; must be explicitly false
    not container.securityContext.allowPrivilegeEscalation == false

    msg := sprintf(
        "Container '%s' in %s '%s' must set securityContext.allowPrivilegeEscalation = false",
        [container.name, input.kind, input.metadata.name]
    )
}

# --- Rule: Containers must use specific image tags (not 'latest') ---
deny contains msg if {
    container := containers[_]

    # Extract tag from image reference
    image := container.image
    endswith(image, ":latest")

    msg := sprintf(
        "Container '%s' uses ':latest' tag. Pin to a specific version for reproducibility.",
        [container.name]
    )
}

deny contains msg if {
    container := containers[_]

    # Image with no tag defaults to 'latest'
    image := container.image
    not contains(image, ":")

    msg := sprintf(
        "Container '%s' has no image tag. Pin to a specific version.",
        [container.name]
    )
}

# --- Rule: Services must not use NodePort or LoadBalancer without annotation ---
deny contains msg if {
    input.kind == "Service"
    input.spec.type == "NodePort"

    # NodePort services expose a port on all nodes; should be intentional
    not input.metadata.annotations["service.security/nodeport-approved"]

    msg := sprintf(
        "Service '%s' uses NodePort type which exposes a port on all nodes. Add annotation 'service.security/nodeport-approved: reason' to acknowledge this.",
        [input.metadata.name]
    )
}
```

### Running Conftest in CI

```bash
#!/bin/bash
# ci-policy-check.sh
# Runs Conftest policy validation in CI pipeline.
# Exits non-zero if any policy violations are found.

set -euo pipefail

POLICY_DIR="policy"
MANIFESTS_DIR="k8s"
TERRAFORM_DIR="terraform"

echo "=== Kubernetes Manifest Policy Check ==="
# Find all YAML files and validate against policies
find "${MANIFESTS_DIR}" -name "*.yaml" -o -name "*.yml" \
  | sort \
  | xargs conftest test \
    --policy "${POLICY_DIR}/kubernetes" \
    --output table \
    --fail-on-warn=false   # Warnings don't fail CI; only denies do

echo ""
echo "=== Helm Chart Policy Check ==="
# Render Helm charts and validate the rendered output
for chart_dir in helm/charts/*/; do
    chart_name=$(basename "${chart_dir}")
    echo "Checking chart: ${chart_name}"

    # Render with test values
    helm template "${chart_name}" "${chart_dir}" \
      --values "${chart_dir}/values.yaml" \
      --values "test/values-ci.yaml" \
    | conftest test \
        --policy "${POLICY_DIR}/kubernetes" \
        --input yaml \
        -
done

echo ""
echo "=== Terraform Plan Policy Check ==="
# Generate Terraform plan JSON and validate
for tf_module in terraform/modules/*/; do
    module_name=$(basename "${tf_module}")
    echo "Checking module: ${module_name}"

    if [ -f "${tf_module}/test-values.tfvars" ]; then
        cd "${tf_module}"
        terraform init -backend=false -input=false -no-color > /dev/null
        terraform plan \
          -var-file=test-values.tfvars \
          -out=plan.tfplan \
          -no-color \
          -input=false \
          2>/dev/null
        terraform show -json plan.tfplan \
          | conftest test \
              --policy "../../${POLICY_DIR}/terraform" \
              --input json \
              -
        rm -f plan.tfplan
        cd -
    fi
done

echo ""
echo "All policy checks passed"
```

## kube-score: Kubernetes Manifest Quality

kube-score analyzes Kubernetes manifests for common issues beyond security policies—resource requests, pod disruption budgets, probes, and more:

```bash
# Install kube-score
curl -L https://github.com/zegl/kube-score/releases/download/v1.18.0/kube-score_1.18.0_linux_amd64 \
  -o kube-score
chmod +x kube-score
sudo mv kube-score /usr/local/bin/

# Score a single manifest
kube-score score deployment.yaml

# Score all manifests in a directory
find k8s/ -name "*.yaml" | xargs kube-score score

# Score rendered Helm chart
helm template myapp ./helm/myapp | kube-score score -

# Output in JSON for CI parsing
kube-score score --output-format json deployment.yaml | jq '.[] | select(.score < 10)'

# Example output:
# [CRITICAL] Container Security Context
#   · my-container -> Container has no configured security context
# [WARNING] Deployment Replicas
#   · my-deployment -> Deployment has a single replica, this can cause downtime during upgrades
# [CRITICAL] Container Resources
#   · my-container -> CPU limit is not set
```

```bash
#!/bin/bash
# kube-score-ci.sh
# Runs kube-score in CI with strict thresholds.
# Fails if any CRITICAL checks fail.

MANIFESTS_DIR="${1:-k8s}"
SCORE_THRESHOLD="${2:-10}"  # 10 = fail on any critical issue

echo "=== kube-score Analysis ==="

# Score all manifests, output JSON for parsing
score_output=$(find "${MANIFESTS_DIR}" -name "*.yaml" \
  | xargs kube-score score --output-format json 2>/dev/null)

# Count failures by severity
critical_count=$(echo "${score_output}" \
  | jq '[.[].checks[] | select(.grade < 3 and .skipped == false)] | length')

warning_count=$(echo "${score_output}" \
  | jq '[.[].checks[] | select(.grade == 3 and .skipped == false)] | length')

echo "Critical issues: ${critical_count}"
echo "Warnings: ${warning_count}"

# Show critical issues
if [ "${critical_count}" -gt 0 ]; then
    echo ""
    echo "=== Critical Issues ==="
    echo "${score_output}" \
      | jq -r '
          .[] |
          .object_name as $obj |
          .checks[] |
          select(.grade < 3 and .skipped == false) |
          "[\(.grade | if . == 1 then "CRITICAL" elif . == 2 then "WARNING" else "OK" end)] \($obj): \(.check) - \(.comments[].summary // "see kube-score docs")"
        '
    echo ""
    echo "FAIL: ${critical_count} critical issues found"
    exit 1
fi

echo "PASS: No critical issues found"
```

## Polaris: Kubernetes Configuration Auditing

Polaris provides both a CLI for CI integration and an in-cluster admission webhook for real-time enforcement:

```yaml
# polaris-config.yaml
# Polaris configuration file defining check thresholds.
# Customize which checks are warnings vs. errors.
checks:
  # Security checks
  hostIPCSet: error           # HostIPC gives pod access to host IPC namespace
  hostPIDSet: error           # HostPID gives pod access to host PID namespace
  hostNetworkSet: warning     # HostNetwork gives pod access to host network
  hostPortSet: warning        # Port binding on host node
  privilegeEscalationAllowed: error
  runAsRootAllowed: error
  runAsPrivileged: error
  notReadOnlyRootFilesystem: warning
  dangerousCapabilities: error
  insecureCapabilities: warning
  seccompPolicyUnset: warning
  appArmorAnnotationMissing: warning

  # Reliability checks
  deploymentMissingReplicas: warning    # Single replica = no HA
  priorityClassNotSet: ignore           # Optional
  tagNotSpecified: error                # No :latest allowed
  pullPolicyNotAlways: warning          # Latest policy for mutable tags
  livenessProbeMissing: warning
  readinessProbeMissing: error          # Readiness is more critical
  metadataAndNameMismatched: warning

  # Efficiency checks
  cpuRequestsMissing: error
  cpuLimitsMissing: warning
  memoryRequestsMissing: error
  memoryLimitsMissing: error
  nodeSelectorPodAffinity: ignore

exemptions:
  # Exempt monitoring DaemonSets from hostNetwork requirement
  - namespace: monitoring
    controllerNames:
    - node-exporter
    rules:
    - hostNetworkSet

  # Exempt kube-system from some checks
  - namespace: kube-system
    rules:
    - runAsRootAllowed
    - privilegeEscalationAllowed
```

```bash
# Run Polaris audit CLI
# Install
curl -L https://github.com/FairwindsOps/polaris/releases/latest/download/polaris_linux_amd64.tar.gz \
  | tar xz
sudo mv polaris /usr/local/bin/

# Audit a directory of manifests
polaris audit \
  --audit-path ./k8s \
  --config polaris-config.yaml \
  --format pretty

# Audit the running cluster
polaris audit \
  --kubeconfig ~/.kube/config \
  --config polaris-config.yaml \
  --format json \
  | jq '.Results | to_entries[] | select(.value.Score < 0.8) | .key'

# Fail CI if score drops below threshold
polaris audit \
  --audit-path ./k8s \
  --config polaris-config.yaml \
  --set-exit-code-below-score 0.9
```

## Checkov: IaC Security Scanning

Checkov scans Terraform, CloudFormation, Kubernetes, Helm, and Dockerfile configurations for security misconfigurations:

```bash
# Install Checkov
pip install checkov

# Scan Terraform directory
checkov -d terraform/ \
  --framework terraform \
  --output cli \
  --compact

# Scan Kubernetes manifests
checkov -d k8s/ \
  --framework kubernetes \
  --output sarif \
  > checkov-results.sarif

# Scan Helm charts
checkov -d helm/ \
  --framework helm \
  --output json \
  | jq '.results.failed_checks[] | {id: .check_id, file: .repo_file_path, resource: .resource}'

# Skip specific checks (with documented reason)
checkov -d terraform/ \
  --skip-check CKV_AWS_20 \   # Skip S3 ACL check (using bucket policy instead)
  --skip-check CKV_AWS_57     # Skip S3 public access (intentionally public static site)

# Output for GitHub Actions PR annotations
checkov -d . \
  --framework all \
  --output github_failed_only
```

```yaml
# .checkov.yaml
# Checkov configuration file
# Suppress specific findings with justification
skip-check:
  - id: CKV_AWS_20
    reason: "S3 ACL managed via bucket policy; no separate ACL needed"
  - id: CKV_K8S_30
    reason: "Service account token mounting required for Vault injector"

# Configure which directories to scan
directory:
  - terraform/
  - k8s/
  - helm/

# Fail CI on HIGH severity findings only
hard-fail-on:
  - HIGH
```

## Integrating All Tools in CI/CD

### GitHub Actions Workflow

```yaml
# .github/workflows/infrastructure-tests.yml
# CI workflow that runs all infrastructure validation tools.
name: Infrastructure Tests

on:
  pull_request:
    paths:
    - 'terraform/**'
    - 'k8s/**'
    - 'helm/**'

jobs:
  static-analysis:
    name: Static Analysis
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4

    - name: Setup tools
      run: |
        # Install checkov
        pip install checkov

        # Install conftest
        VERSION=0.49.0
        curl -Lo conftest.tar.gz \
          "https://github.com/open-policy-agent/conftest/releases/download/v${VERSION}/conftest_${VERSION}_Linux_x86_64.tar.gz"
        tar xzf conftest.tar.gz && sudo mv conftest /usr/local/bin/

        # Install kube-score
        curl -L https://github.com/zegl/kube-score/releases/download/v1.18.0/kube-score_1.18.0_linux_amd64 \
          -o kube-score && chmod +x kube-score && sudo mv kube-score /usr/local/bin/

        # Install polaris
        curl -L https://github.com/FairwindsOps/polaris/releases/latest/download/polaris_linux_amd64.tar.gz \
          | tar xz && sudo mv polaris /usr/local/bin/

    - name: Checkov security scan
      run: |
        checkov -d . \
          --framework terraform,kubernetes,helm \
          --output github_failed_only \
          --compact
      continue-on-error: false

    - name: Conftest policy validation
      run: |
        bash ci/ci-policy-check.sh

    - name: kube-score manifest quality
      run: |
        find k8s/ -name "*.yaml" \
          | xargs kube-score score --output-format ci
      continue-on-error: false

    - name: Polaris audit
      run: |
        polaris audit \
          --audit-path k8s/ \
          --config polaris-config.yaml \
          --set-exit-code-below-score 0.8

  integration-tests:
    name: Terratest Integration
    runs-on: ubuntu-latest
    if: github.event.pull_request.head.repo.full_name == github.repository
    needs: static-analysis
    environment: ci-testing   # Requires AWS credentials for this environment
    steps:
    - uses: actions/checkout@v4

    - name: Setup Go
      uses: actions/setup-go@v5
      with:
        go-version: '1.21'

    - name: Configure AWS credentials
      uses: aws-actions/configure-aws-credentials@v4
      with:
        role-to-assume: ${{ secrets.AWS_CI_ROLE_ARN }}
        aws-region: us-east-1

    - name: Run Terratest
      run: |
        cd tests/
        go test ./... \
          -v \
          -timeout 60m \
          -run TestVPCModule     # Only run fast tests on PRs
      env:
        TERRATEST_REGION: us-east-1
```

## OPA Unit Testing

Policies themselves need testing. OPA's built-in test framework enables unit tests for Rego policies:

```rego
# policy/kubernetes/security_test.rego
# Unit tests for Kubernetes security policies.
# Run: opa test policy/ -v

package kubernetes.security

import future.keywords.if

# Test that root container is denied
test_deny_root_container if {
    deny["Container 'app' in Deployment 'myapp' must not run as root. Set securityContext.runAsNonRoot = true or runAsUser > 0"] with input as {
        "kind": "Deployment",
        "metadata": {"name": "myapp"},
        "spec": {
            "template": {
                "spec": {
                    "containers": [{
                        "name": "app",
                        "image": "nginx:1.25",
                        # No securityContext = defaults to root
                    }]
                }
            }
        }
    }
}

# Test that non-root container is allowed
test_allow_non_root_container if {
    count(deny) == 0 with input as {
        "kind": "Deployment",
        "metadata": {"name": "myapp"},
        "spec": {
            "template": {
                "spec": {
                    "containers": [{
                        "name": "app",
                        "image": "nginx:1.25",
                        "securityContext": {
                            "runAsNonRoot": true,
                            "allowPrivilegeEscalation": false,
                        },
                        "resources": {
                            "limits": {"cpu": "500m", "memory": "512Mi"},
                            "requests": {"cpu": "100m", "memory": "128Mi"},
                        }
                    }]
                }
            }
        }
    }
}

# Test that latest tag is denied
test_deny_latest_tag if {
    deny["Container 'app' uses ':latest' tag. Pin to a specific version for reproducibility."] with input as {
        "kind": "Pod",
        "metadata": {"name": "myapp"},
        "spec": {
            "containers": [{
                "name": "app",
                "image": "nginx:latest",
            }]
        }
    }
}
```

```bash
# Run OPA unit tests
opa test policy/ -v

# Output:
# data.kubernetes.security.test_deny_root_container: PASS (1.2ms)
# data.kubernetes.security.test_allow_non_root_container: PASS (0.8ms)
# data.kubernetes.security.test_deny_latest_tag: PASS (0.9ms)
# --------------------------------------------------------------------------------
# PASS: 3/3
```

## Summary

Infrastructure testing requires the same rigor as application testing, with tools matched to each validation layer. Checkov and kube-score provide immediate feedback on common misconfigurations through static analysis, running in seconds during PR checks. Conftest with OPA enables organizational policy enforcement expressed as code—version controlled, reviewable, and testable with OPA's built-in unit test framework. Polaris provides both CI scanning and in-cluster admission control for continuous enforcement.

Terratest addresses the gap that static analysis cannot fill: actual provider behavior, interaction effects between modules, and real-world deployment validation. Running in isolated test accounts with deterministic teardown, Terratest tests catch the issues that only emerge when infrastructure actually runs.

The combination provides confidence in infrastructure changes comparable to what unit and integration tests provide for application code, reducing the frequency and severity of production infrastructure incidents.
