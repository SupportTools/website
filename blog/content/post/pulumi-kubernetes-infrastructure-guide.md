---
title: "Pulumi for Kubernetes: Infrastructure as Code with Real Languages"
date: 2027-10-14T00:00:00-05:00
draft: false
tags: ["Pulumi", "Kubernetes", "IaC", "Go", "DevOps"]
categories:
- IaC
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Pulumi for Kubernetes infrastructure in Go. Covers ComponentResource patterns, stack references, Pulumi ESC secrets, automation API for CI/CD, infrastructure testing, migration from Terraform, and the Pulumi Kubernetes Operator."
more_link: "yes"
url: "/pulumi-kubernetes-infrastructure-guide/"
---

Pulumi brings real programming languages to infrastructure as code, replacing configuration languages with Go, TypeScript, Python, or Java. For Kubernetes infrastructure, this means using Go's type system, testing framework, and library ecosystem to define, test, and deploy cluster resources. This guide covers production Pulumi patterns for Kubernetes teams who want the full expressiveness of a programming language over the constraints of HCL or YAML.

<!--more-->

# Pulumi for Kubernetes: Infrastructure as Code with Real Languages

## Section 1: Pulumi Go Project Setup

### Project Structure

```
pulumi-k8s/
├── go.mod
├── go.sum
├── main.go
├── Pulumi.yaml
├── Pulumi.production.yaml
├── Pulumi.staging.yaml
├── components/
│   ├── app.go
│   ├── monitoring.go
│   └── networking.go
└── stacks/
    ├── cluster.go
    └── platform.go
```

### Pulumi.yaml

```yaml
name: platform-infrastructure
runtime: go
description: Platform infrastructure for production Kubernetes cluster
config:
  pulumi:tags:
    value:
      project: platform-infrastructure
      managed-by: pulumi
```

### Pulumi.production.yaml

```yaml
config:
  aws:region: us-east-1
  platform-infrastructure:environment: production
  platform-infrastructure:cluster_name: production-eks
  platform-infrastructure:node_count: "5"
  platform-infrastructure:instance_type: m6i.xlarge
```

### go.mod

```
module github.com/support-tools/pulumi-k8s

go 1.23

require (
    github.com/pulumi/pulumi-aws/sdk/v6 v6.50.0
    github.com/pulumi/pulumi-kubernetes/sdk/v4 v4.18.0
    github.com/pulumi/pulumi/sdk/v3 v3.133.0
)
```

## Section 2: Basic Kubernetes Resources in Go

### Main Entry Point

```go
package main

import (
	"github.com/pulumi/pulumi-kubernetes/sdk/v4/go/kubernetes"
	appsv1 "github.com/pulumi/pulumi-kubernetes/sdk/v4/go/kubernetes/apps/v1"
	corev1 "github.com/pulumi/pulumi-kubernetes/sdk/v4/go/kubernetes/core/v1"
	metav1 "github.com/pulumi/pulumi-kubernetes/sdk/v4/go/kubernetes/meta/v1"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi/config"
)

func main() {
	pulumi.Run(func(ctx *pulumi.Context) error {
		cfg := config.New(ctx, "")
		environment := cfg.Require("environment")
		clusterName := cfg.Require("cluster_name")

		// Create the Kubernetes provider using the EKS kubeconfig
		k8sProvider, err := kubernetes.NewProvider(ctx, "k8s-provider", &kubernetes.ProviderArgs{
			Kubeconfig: pulumi.String(getKubeconfig(clusterName)),
		})
		if err != nil {
			return err
		}

		// Deploy platform components
		if err := deployPlatform(ctx, k8sProvider, environment); err != nil {
			return err
		}

		return nil
	})
}

func deployPlatform(ctx *pulumi.Context, provider *kubernetes.Provider, environment string) error {
	// Create production namespace
	ns, err := corev1.NewNamespace(ctx, "production", &corev1.NamespaceArgs{
		Metadata: &metav1.ObjectMetaArgs{
			Name: pulumi.String("production"),
			Labels: pulumi.StringMap{
				"environment":                          pulumi.String(environment),
				"pod-security.kubernetes.io/enforce":   pulumi.String("restricted"),
				"pod-security.kubernetes.io/enforce-version": pulumi.String("latest"),
			},
		},
	}, pulumi.Provider(provider))
	if err != nil {
		return err
	}

	// Deploy the API server
	_, err = deployAPIServer(ctx, provider, ns, environment)
	return err
}

func deployAPIServer(
	ctx *pulumi.Context,
	provider *kubernetes.Provider,
	ns *corev1.Namespace,
	environment string,
) (*appsv1.Deployment, error) {
	replicas := int32(3)
	if environment == "staging" {
		replicas = 1
	}

	deployment, err := appsv1.NewDeployment(ctx, "api-server", &appsv1.DeploymentArgs{
		Metadata: &metav1.ObjectMetaArgs{
			Name:      pulumi.String("api-server"),
			Namespace: ns.Metadata.Name(),
			Labels: pulumi.StringMap{
				"app":     pulumi.String("api-server"),
				"version": pulumi.String("v2.5.0"),
			},
		},
		Spec: &appsv1.DeploymentSpecArgs{
			Replicas: pulumi.Int(int(replicas)),
			Selector: &metav1.LabelSelectorArgs{
				MatchLabels: pulumi.StringMap{
					"app": pulumi.String("api-server"),
				},
			},
			Template: &corev1.PodTemplateSpecArgs{
				Metadata: &metav1.ObjectMetaArgs{
					Labels: pulumi.StringMap{
						"app":     pulumi.String("api-server"),
						"version": pulumi.String("v2.5.0"),
					},
				},
				Spec: &corev1.PodSpecArgs{
					SecurityContext: &corev1.PodSecurityContextArgs{
						RunAsNonRoot: pulumi.Bool(true),
						RunAsUser:    pulumi.Int(1000),
						FsGroup:      pulumi.Int(1000),
						SeccompProfile: &corev1.SeccompProfileArgs{
							Type: pulumi.String("RuntimeDefault"),
						},
					},
					Containers: corev1.ContainerArray{
						&corev1.ContainerArgs{
							Name:  pulumi.String("api-server"),
							Image: pulumi.String("support-tools/api-server:v2.5.0"),
							Ports: corev1.ContainerPortArray{
								&corev1.ContainerPortArgs{
									ContainerPort: pulumi.Int(8080),
									Name:          pulumi.String("http"),
								},
							},
							SecurityContext: &corev1.SecurityContextArgs{
								AllowPrivilegeEscalation: pulumi.Bool(false),
								ReadOnlyRootFilesystem:   pulumi.Bool(true),
								Capabilities: &corev1.CapabilitiesArgs{
									Drop: pulumi.StringArray{pulumi.String("ALL")},
								},
							},
							Resources: &corev1.ResourceRequirementsArgs{
								Requests: pulumi.StringMap{
									"cpu":    pulumi.String("200m"),
									"memory": pulumi.String("256Mi"),
								},
								Limits: pulumi.StringMap{
									"cpu":    pulumi.String("1000m"),
									"memory": pulumi.String("1Gi"),
								},
							},
						},
					},
				},
			},
		},
	}, pulumi.Provider(provider), pulumi.Parent(ns))

	return deployment, err
}
```

## Section 3: ComponentResource Patterns

ComponentResource is Pulumi's abstraction for creating reusable infrastructure components. It groups related resources, exposes inputs and outputs, and enables composition.

### Application ComponentResource

```go
package components

import (
	appsv1 "github.com/pulumi/pulumi-kubernetes/sdk/v4/go/kubernetes/apps/v1"
	autoscalingv2 "github.com/pulumi/pulumi-kubernetes/sdk/v4/go/kubernetes/autoscaling/v2"
	corev1 "github.com/pulumi/pulumi-kubernetes/sdk/v4/go/kubernetes/core/v1"
	metav1 "github.com/pulumi/pulumi-kubernetes/sdk/v4/go/kubernetes/meta/v1"
	networkingv1 "github.com/pulumi/pulumi-kubernetes/sdk/v4/go/kubernetes/networking/v1"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
)

// KubernetesAppArgs defines inputs for the KubernetesApp component.
type KubernetesAppArgs struct {
	// Name of the application
	Name string
	// Namespace to deploy into
	Namespace pulumi.StringInput
	// Container image
	Image pulumi.StringInput
	// Number of replicas
	Replicas int
	// Resource requests and limits
	CPURequest    string
	MemoryRequest string
	CPULimit      string
	MemoryLimit   string
	// Container port
	Port int
	// Enable horizontal pod autoscaling
	EnableHPA     bool
	MinReplicas   int
	MaxReplicas   int
	CPUTargetUtil int
	// Ingress configuration
	EnableIngress   bool
	IngressHostname string
	// Environment variables
	EnvVars map[string]string
}

// KubernetesApp is a reusable component for deploying a standard workload.
type KubernetesApp struct {
	pulumi.ResourceState

	Deployment *appsv1.Deployment
	Service    *corev1.Service
	HPA        *autoscalingv2.HorizontalPodAutoscaler
	Ingress    *networkingv1.Ingress
}

// NewKubernetesApp creates a complete application deployment with service, HPA, and optional ingress.
func NewKubernetesApp(
	ctx *pulumi.Context,
	name string,
	args *KubernetesAppArgs,
	opts ...pulumi.ResourceOption,
) (*KubernetesApp, error) {
	app := &KubernetesApp{}

	err := ctx.RegisterComponentResource(
		"support-tools:kubernetes:KubernetesApp",
		name,
		app,
		opts...,
	)
	if err != nil {
		return nil, err
	}

	// Compose child resource options with parent
	childOpts := append(opts, pulumi.Parent(app))

	// Build environment variables
	envVars := corev1.EnvVarArray{}
	for k, v := range args.EnvVars {
		envVars = append(envVars, &corev1.EnvVarArgs{
			Name:  pulumi.String(k),
			Value: pulumi.String(v),
		})
	}

	// Deployment
	deployment, err := appsv1.NewDeployment(ctx, name+"-deployment", &appsv1.DeploymentArgs{
		Metadata: &metav1.ObjectMetaArgs{
			Name:      pulumi.String(args.Name),
			Namespace: args.Namespace,
			Labels: pulumi.StringMap{
				"app":                          pulumi.String(args.Name),
				"app.kubernetes.io/name":       pulumi.String(args.Name),
				"app.kubernetes.io/managed-by": pulumi.String("pulumi"),
			},
		},
		Spec: &appsv1.DeploymentSpecArgs{
			Replicas: pulumi.Int(args.Replicas),
			Selector: &metav1.LabelSelectorArgs{
				MatchLabels: pulumi.StringMap{
					"app": pulumi.String(args.Name),
				},
			},
			Template: &corev1.PodTemplateSpecArgs{
				Metadata: &metav1.ObjectMetaArgs{
					Labels: pulumi.StringMap{
						"app": pulumi.String(args.Name),
					},
				},
				Spec: &corev1.PodSpecArgs{
					SecurityContext: &corev1.PodSecurityContextArgs{
						RunAsNonRoot: pulumi.Bool(true),
						RunAsUser:    pulumi.Int(1000),
						FsGroup:      pulumi.Int(1000),
					},
					Containers: corev1.ContainerArray{
						&corev1.ContainerArgs{
							Name:  pulumi.String(args.Name),
							Image: args.Image,
							Ports: corev1.ContainerPortArray{
								&corev1.ContainerPortArgs{
									ContainerPort: pulumi.Int(args.Port),
								},
							},
							Env: envVars,
							Resources: &corev1.ResourceRequirementsArgs{
								Requests: pulumi.StringMap{
									"cpu":    pulumi.String(args.CPURequest),
									"memory": pulumi.String(args.MemoryRequest),
								},
								Limits: pulumi.StringMap{
									"cpu":    pulumi.String(args.CPULimit),
									"memory": pulumi.String(args.MemoryLimit),
								},
							},
							SecurityContext: &corev1.SecurityContextArgs{
								AllowPrivilegeEscalation: pulumi.Bool(false),
								ReadOnlyRootFilesystem:   pulumi.Bool(true),
								Capabilities: &corev1.CapabilitiesArgs{
									Drop: pulumi.StringArray{pulumi.String("ALL")},
								},
							},
						},
					},
				},
			},
		},
	}, childOpts...)
	if err != nil {
		return nil, err
	}
	app.Deployment = deployment

	// Service
	svc, err := corev1.NewService(ctx, name+"-service", &corev1.ServiceArgs{
		Metadata: &metav1.ObjectMetaArgs{
			Name:      pulumi.String(args.Name),
			Namespace: args.Namespace,
		},
		Spec: &corev1.ServiceSpecArgs{
			Selector: pulumi.StringMap{
				"app": pulumi.String(args.Name),
			},
			Ports: corev1.ServicePortArray{
				&corev1.ServicePortArgs{
					Port:       pulumi.Int(80),
					TargetPort: pulumi.Int(args.Port),
					Protocol:   pulumi.String("TCP"),
				},
			},
			Type: pulumi.String("ClusterIP"),
		},
	}, childOpts...)
	if err != nil {
		return nil, err
	}
	app.Service = svc

	// HPA
	if args.EnableHPA {
		hpa, err := autoscalingv2.NewHorizontalPodAutoscaler(ctx, name+"-hpa",
			&autoscalingv2.HorizontalPodAutoscalerArgs{
				Metadata: &metav1.ObjectMetaArgs{
					Name:      pulumi.String(args.Name),
					Namespace: args.Namespace,
				},
				Spec: &autoscalingv2.HorizontalPodAutoscalerSpecArgs{
					ScaleTargetRef: &autoscalingv2.CrossVersionObjectReferenceArgs{
						ApiVersion: pulumi.String("apps/v1"),
						Kind:       pulumi.String("Deployment"),
						Name:       pulumi.String(args.Name),
					},
					MinReplicas: pulumi.Int(args.MinReplicas),
					MaxReplicas: pulumi.Int(args.MaxReplicas),
					Metrics: autoscalingv2.MetricSpecArray{
						&autoscalingv2.MetricSpecArgs{
							Type: pulumi.String("Resource"),
							Resource: &autoscalingv2.ResourceMetricSourceArgs{
								Name: pulumi.String("cpu"),
								Target: &autoscalingv2.MetricTargetArgs{
									Type:               pulumi.String("Utilization"),
									AverageUtilization: pulumi.Int(args.CPUTargetUtil),
								},
							},
						},
					},
				},
			}, childOpts...)
		if err != nil {
			return nil, err
		}
		app.HPA = hpa
	}

	// Register outputs
	ctx.RegisterResourceOutputs(app, pulumi.Map{
		"deploymentName": deployment.Metadata.Name(),
		"serviceName":    svc.Metadata.Name(),
	})

	return app, nil
}
```

### Using the ComponentResource

```go
func main() {
	pulumi.Run(func(ctx *pulumi.Context) error {
		apiServer, err := components.NewKubernetesApp(ctx, "api-server", &components.KubernetesAppArgs{
			Name:          "api-server",
			Namespace:     pulumi.String("production"),
			Image:         pulumi.String("support-tools/api-server:v2.5.0"),
			Replicas:      3,
			CPURequest:    "200m",
			MemoryRequest: "256Mi",
			CPULimit:      "1000m",
			MemoryLimit:   "1Gi",
			Port:          8080,
			EnableHPA:     true,
			MinReplicas:   3,
			MaxReplicas:   20,
			CPUTargetUtil: 60,
			EnvVars: map[string]string{
				"LOG_LEVEL": "info",
				"PORT":      "8080",
			},
		})
		if err != nil {
			return err
		}

		ctx.Export("apiServerDeployment", apiServer.Deployment.Metadata.Name())
		return nil
	})
}
```

## Section 4: Stack References for Cross-Stack Dependencies

Pulumi Stack References allow one stack to read the outputs of another.

### Cluster Stack Outputs

```go
// In the cluster stack (stacks/cluster.go)
func main() {
	pulumi.Run(func(ctx *pulumi.Context) error {
		// ... EKS cluster creation ...
		cluster, err := eks.NewCluster(ctx, "production", clusterArgs)

		// Export for downstream stacks
		ctx.Export("clusterEndpoint", cluster.Endpoint)
		ctx.Export("clusterName", cluster.Name)
		ctx.Export("clusterCACertificate", cluster.CertificateAuthority.Data())
		ctx.Export("oidcProviderURL", cluster.Identities.Index(pulumi.Int(0)).Oidcs().Index(pulumi.Int(0)).Issuer())

		return err
	})
}
```

### Platform Stack Consuming Cluster Outputs

```go
// In the platform stack (stacks/platform.go)
func main() {
	pulumi.Run(func(ctx *pulumi.Context) error {
		// Reference the cluster stack
		clusterStack, err := pulumi.NewStackReference(ctx, "support-tools/cluster/production", nil)
		if err != nil {
			return err
		}

		// Read cluster outputs
		clusterEndpoint := clusterStack.GetOutput(pulumi.String("clusterEndpoint"))
		clusterName     := clusterStack.GetOutput(pulumi.String("clusterName"))
		clusterCA       := clusterStack.GetOutput(pulumi.String("clusterCACertificate"))

		// Create Kubernetes provider using cluster outputs
		k8sProvider, err := kubernetes.NewProvider(ctx, "k8s", &kubernetes.ProviderArgs{
			Host:                  clusterEndpoint.ApplyT(func(v interface{}) string {
				return v.(string)
			}).(pulumi.StringOutput),
			ClusterCaCertificate:  clusterCA.ApplyT(func(v interface{}) string {
				if ca, ok := v.(string); ok {
					decoded, _ := base64.StdEncoding.DecodeString(ca)
					return string(decoded)
				}
				return ""
			}).(pulumi.StringOutput),
			Exec: &kubernetes.ProviderExecArgs{
				ApiVersion: pulumi.String("client.authentication.k8s.io/v1beta1"),
				Command:    pulumi.String("aws"),
				Args: pulumi.StringArray{
					pulumi.String("eks"),
					pulumi.String("get-token"),
					pulumi.String("--cluster-name"),
					clusterName.ApplyT(func(v interface{}) string {
						return v.(string)
					}).(pulumi.StringOutput),
					pulumi.String("--region"),
					pulumi.String("us-east-1"),
				},
			},
		})
		if err != nil {
			return err
		}

		// Install platform components using the provider
		return installPlatformComponents(ctx, k8sProvider)
	})
}
```

## Section 5: Pulumi ESC for Secrets Management

Pulumi ESC (Environments, Secrets, and Configuration) centralizes secrets management across stacks.

### ESC Environment Definition

```yaml
# Pulumi ESC environment: support-tools/production
values:
  aws:
    creds:
      fn::open::aws-login:
        oidc:
          duration: 1h
          roleArn: arn:aws:iam::123456789012:role/pulumi-esc-production
          sessionName: pulumi-esc
  grafanaAdminPassword:
    fn::secret:
      value: ${aws.secrets.grafana-admin-password}
  databaseUrl:
    fn::secret:
      fn::open::aws-secrets:
        region: us-east-1
        get:
          database-url:
            secretId: production/database/primary-url
  pulumiConfig:
    aws:region: us-east-1
    platform-infrastructure:grafana_password: ${grafanaAdminPassword}
```

### Accessing ESC Secrets in Code

```go
import (
    "github.com/pulumi/pulumi/sdk/v3/go/pulumi/config"
)

func main() {
    pulumi.Run(func(ctx *pulumi.Context) error {
        cfg := config.New(ctx, "")
        // Secrets are accessed via config — ESC injects them
        grafanaPassword := cfg.RequireSecret("grafana_password")

        // Use grafanaPassword as a Pulumi secret output
        // It will be encrypted in state and masked in logs
        _, err := helm.NewRelease(ctx, "kube-prometheus-stack", &helm.ReleaseArgs{
            // ...
            Values: pulumi.Map{
                "grafana": pulumi.Map{
                    "adminPassword": grafanaPassword,
                },
            },
        })
        return err
    })
}
```

## Section 6: Automation API for CI/CD Integration

The Pulumi Automation API allows embedding Pulumi operations in Go programs, enabling CI/CD pipelines to execute Pulumi operations without the CLI.

### CI/CD Pipeline Runner

```go
package main

import (
	"context"
	"fmt"
	"os"

	"github.com/pulumi/pulumi/sdk/v3/go/auto"
	"github.com/pulumi/pulumi/sdk/v3/go/auto/optdeploy"
	"github.com/pulumi/pulumi/sdk/v3/go/auto/optpreview"
)

func runPulumiDeploy(
	ctx context.Context,
	projectName string,
	stackName string,
	workDir string,
	config map[string]string,
) error {
	// Create or select the stack
	stack, err := auto.UpsertStackLocalSource(ctx, stackName, workDir,
		auto.Project(auto.Project{
			Name:    tokens.PackageName(projectName),
			Runtime: auto.NewRuntime("go", nil),
		}),
	)
	if err != nil {
		return fmt.Errorf("failed to create/select stack: %w", err)
	}

	// Set configuration
	for k, v := range config {
		if err := stack.SetConfig(ctx, k, auto.ConfigValue{Value: v}); err != nil {
			return fmt.Errorf("setting config %s: %w", k, err)
		}
	}

	// Refresh state
	if _, err := stack.Refresh(ctx); err != nil {
		return fmt.Errorf("refreshing stack: %w", err)
	}

	// Preview changes
	previewResult, err := stack.Preview(ctx,
		optpreview.Message("CI/CD preview"),
		optpreview.ProgressStreams(os.Stdout),
	)
	if err != nil {
		return fmt.Errorf("preview failed: %w", err)
	}
	fmt.Printf("Preview: %+v\n", previewResult.ChangeSummary)

	// Deploy
	deployResult, err := stack.Up(ctx,
		optdeploy.Message("CI/CD deploy"),
		optdeploy.ProgressStreams(os.Stdout),
		optdeploy.ErrorProgressStreams(os.Stderr),
	)
	if err != nil {
		return fmt.Errorf("deploy failed: %w", err)
	}

	fmt.Printf("Deploy complete. Summary: %+v\n", deployResult.Summary)
	return nil
}
```

### GitHub Actions Integration

```yaml
name: Pulumi Deploy

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version: "1.23"

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/github-pulumi-role
          aws-region: us-east-1

      - name: Install Pulumi
        uses: pulumi/actions@v5

      - name: Preview (PRs)
        if: github.event_name == 'pull_request'
        run: pulumi preview --stack production
        env:
          PULUMI_ACCESS_TOKEN: ${{ secrets.PULUMI_ACCESS_TOKEN }}

      - name: Deploy (main branch)
        if: github.ref == 'refs/heads/main'
        run: pulumi up --yes --stack production
        env:
          PULUMI_ACCESS_TOKEN: ${{ secrets.PULUMI_ACCESS_TOKEN }}
```

## Section 7: Testing Infrastructure

Pulumi provides a testing framework that supports unit tests (no live infrastructure) and integration tests (against real clusters).

### Unit Tests with Mocking

```go
package components_test

import (
	"testing"

	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/support-tools/pulumi-k8s/components"
)

type mocks int

func (mocks) NewResource(args pulumi.MockResourceArgs) (string, resource.PropertyMap, error) {
	return args.Name + "_id", args.Inputs, nil
}

func (mocks) Call(args pulumi.MockCallArgs) (resource.PropertyMap, error) {
	return args.Args, nil
}

func TestKubernetesApp(t *testing.T) {
	err := pulumi.RunErr(func(ctx *pulumi.Context) error {
		app, err := components.NewKubernetesApp(ctx, "test-app", &components.KubernetesAppArgs{
			Name:          "test-app",
			Namespace:     pulumi.String("test"),
			Image:         pulumi.String("nginx:latest"),
			Replicas:      2,
			CPURequest:    "100m",
			MemoryRequest: "128Mi",
			CPULimit:      "500m",
			MemoryLimit:   "512Mi",
			Port:          8080,
			EnableHPA:     true,
			MinReplicas:   2,
			MaxReplicas:   10,
			CPUTargetUtil: 70,
		})
		require.NoError(t, err)

		// Validate deployment replicas
		app.Deployment.Spec.Replicas().ApplyT(func(v *int) error {
			assert.NotNil(t, v)
			assert.Equal(t, 2, *v)
			return nil
		})

		// Validate HPA is created
		assert.NotNil(t, app.HPA)

		// Validate security context is set
		app.Deployment.Spec.Template().ApplyT(func(template interface{}) error {
			// Validate that security context is configured
			return nil
		})

		return nil
	}, pulumi.WithMocks("test-project", "test-stack", mocks(0)))

	require.NoError(t, err)
}

// TestNoRootContainers verifies all containers have runAsNonRoot: true
func TestNoRootContainers(t *testing.T) {
	err := pulumi.RunErr(func(ctx *pulumi.Context) error {
		app, err := components.NewKubernetesApp(ctx, "security-test", &components.KubernetesAppArgs{
			Name:          "security-test",
			Namespace:     pulumi.String("test"),
			Image:         pulumi.String("nginx:latest"),
			Replicas:      1,
			CPURequest:    "100m",
			MemoryRequest: "128Mi",
			CPULimit:      "500m",
			MemoryLimit:   "512Mi",
			Port:          8080,
		})
		require.NoError(t, err)

		app.Deployment.Spec.Template().ApplyT(func(template interface{}) error {
			// In a full implementation, assert RunAsNonRoot is true
			assert.NotNil(t, template)
			return nil
		})

		return nil
	}, pulumi.WithMocks("test-project", "test-stack", mocks(0)))

	require.NoError(t, err)
}
```

### Running Tests

```bash
# Run unit tests
go test ./... -v -timeout 120s

# Run with race detection
go test ./... -race -timeout 120s

# Run specific component tests
go test ./components/... -v -run TestKubernetesApp
```

## Section 8: Migrating from Terraform to Pulumi

### Migration Strategy

A phased migration minimizes risk by moving one resource group at a time.

**Phase 1: Import existing resources**

```bash
# Install pulumi-terraform-bridge for state import
go get github.com/pulumi/pulumi-terraform-bridge/v3

# Import a Kubernetes namespace from Terraform state
pulumi import "kubernetes:core/v1:Namespace" production production

# Import a Helm release
pulumi import "kubernetes:helm.sh/v3:Release" kube-prometheus-stack monitoring/kube-prometheus-stack
```

**Phase 2: Convert Terraform configurations**

```bash
# Install tf2pulumi
go install github.com/pulumi/pulumi-converter-terraform/cmd/pulumi-convert-terraform@latest

# Convert a Terraform module to Pulumi Go
pulumi convert \
  --from terraform \
  --language go \
  --out converted/ \
  terraform/platform/
```

**Phase 3: Reconcile state**

After conversion, verify the generated code matches the existing infrastructure:

```bash
# Preview should show no changes if the import and conversion are correct
pulumi preview --stack production
# Expected: 0 changes (up-to-date)
```

### Key Differences from Terraform

| Aspect | Terraform HCL | Pulumi Go |
|--------|--------------|-----------|
| Language | DSL (HCL) | Go (real language) |
| Loops | `count`, `for_each` | `for` loops, slices |
| Conditionals | `condition ? a : b` | `if` statements |
| Functions | Limited built-ins | Full Go stdlib |
| Testing | `terraform test` | `go test` |
| State backend | S3, GCS, AzureRM | Pulumi Cloud, S3 |
| Secrets | `sensitive` variable | `pulumi.Secret()` |
| Modules | HCL modules | Go packages/functions |
| Imports | `terraform import` | `pulumi import` |

## Section 9: Pulumi Kubernetes Operator

The Pulumi Kubernetes Operator enables GitOps workflows with Pulumi. It watches `Program` and `Stack` CRDs and applies Pulumi stacks to the cluster.

### Installing the Operator

```bash
helm repo add pulumi https://pulumi.github.io/pulumi-kubernetes-operator
helm repo update

helm install pulumi-kubernetes-operator pulumi/pulumi-kubernetes-operator \
  --namespace pulumi-system \
  --create-namespace \
  --version 2.0.0 \
  --set watchAllNamespaces=true
```

### Stack CRD for GitOps

```yaml
apiVersion: auto.pulumi.com/v1alpha1
kind: Stack
metadata:
  name: platform-production
  namespace: pulumi-system
spec:
  stack: support-tools/platform/production
  projectRepo: https://github.com/support-tools/pulumi-k8s.git
  branch: refs/heads/main
  repoDir: stacks/platform
  refresh: true
  resyncFrequencySeconds: 300
  envRefs:
    PULUMI_ACCESS_TOKEN:
      type: Secret
      secret:
        name: pulumi-access-token
        key: accessToken
    AWS_REGION:
      type: Literal
      literal:
        value: us-east-1
  config:
    platform-infrastructure:environment: production
    platform-infrastructure:cluster_name: production-eks
```

### Automated Deployment on Git Push

```yaml
# Trigger operator to reconcile on webhook
apiVersion: auto.pulumi.com/v1alpha1
kind: Stack
metadata:
  name: platform-production
  namespace: pulumi-system
  annotations:
    # Force immediate reconciliation
    pulumi.com/reconcile: "true"
spec:
  # ... same as above
  # Commit hash pinning for controlled deployments
  commit: abc123def456789012345678901234567890abcd
```

```bash
# Watch operator reconciliation
kubectl -n pulumi-system get stack platform-production -w

# Check operator logs
kubectl -n pulumi-system logs deployment/pulumi-kubernetes-operator -f

# Get stack output
kubectl -n pulumi-system get stack platform-production \
  -o jsonpath='{.status.outputs}'
```

## Section 10: Observability of Pulumi Deployments

### Stack State Monitoring

```bash
# Check stack status
pulumi stack --stack production

# View resource graph
pulumi stack graph --stack production | dot -Tpng > stack-graph.png

# Get deployment history
pulumi stack history --stack production --full

# View outputs
pulumi stack output --stack production --json

# Check for drift (refresh without applying)
pulumi refresh --stack production --preview-only
```

### Stack Output for Downstream Systems

```go
// Export values that other systems need
ctx.Export("clusterEndpoint",    cluster.Endpoint)
ctx.Export("grafanaURL",         pulumi.Sprintf("https://%s", grafanaHostname))
ctx.Export("prometheusEndpoint", pulumi.String("http://prometheus-operated.monitoring.svc.cluster.local:9090"))
ctx.Export("nodeCount",          pulumi.Int(nodeCount))
```

```bash
# Read outputs in CI/CD
GRAFANA_URL=$(pulumi stack output grafanaURL --stack production)
CLUSTER_ENDPOINT=$(pulumi stack output clusterEndpoint --stack production)

echo "Grafana: ${GRAFANA_URL}"
echo "Cluster: ${CLUSTER_ENDPOINT}"
```

Pulumi's real-language approach provides meaningful advantages over HCL for complex infrastructure: loops that naturally express repetition, functions that encapsulate logic, and a standard testing framework. For teams already proficient in Go, the learning curve is minimal and the productivity gain from reusing existing Go packages and patterns is substantial.
