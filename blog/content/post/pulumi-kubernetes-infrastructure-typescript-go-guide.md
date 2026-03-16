---
title: "Pulumi: Kubernetes and Cloud Infrastructure as Code with TypeScript and Go"
date: 2027-02-27T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Pulumi", "Infrastructure as Code", "TypeScript", "Go"]
categories: ["Kubernetes", "DevOps", "Infrastructure as Code"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Pulumi for Kubernetes and cloud infrastructure management, covering TypeScript and Go providers, ComponentResource patterns, Pulumi ESC secrets, Automation API, drift detection, and cross-cloud deployments."
more_link: "yes"
url: "/pulumi-kubernetes-infrastructure-typescript-go-guide/"
---

Infrastructure as Code tooling has converged on two dominant paradigms: declarative DSLs (Terraform HCL, Kubernetes YAML) and general-purpose programming languages. **Pulumi** occupies the second camp, letting you write infrastructure code in TypeScript, Go, Python, or C# with full access to language features — loops, functions, classes, unit tests, and package managers — while still producing a declarative state model under the hood.

This guide covers Pulumi's Kubernetes and cloud providers in both TypeScript and Go, ComponentResource abstractions, cross-stack references, secret management with Pulumi ESC, the Automation API, and production patterns for multi-cloud deployments.

<!--more-->

## Executive Summary

Pulumi's core insight is that the declarative vs. imperative distinction is a false dichotomy. A program that describes desired infrastructure state is still declarative — it just uses a programming language as the description format instead of a custom DSL. This gives teams:

- Type-safe resource definitions with IDE autocomplete and refactoring support
- Reusable components through standard library and package mechanisms
- Unit and integration tests using familiar frameworks
- Dynamic configuration logic without string interpolation hacks
- Unified state management with preview, update, and destroy operations

Pulumi supports AWS, Azure, GCP, Kubernetes, and 120+ other providers through a single binary and SDK.

---

## Pulumi vs Terraform Trade-offs

| Dimension | Terraform | Pulumi |
|---|---|---|
| Language | HCL DSL | TypeScript, Go, Python, C# |
| Learning curve | Low (HCL is simple) | Medium (requires language knowledge) |
| Loops/conditionals | Limited (count, for_each) | Full language support |
| Reusable abstractions | Modules | Libraries, ComponentResource |
| Testing | terratest (external) | Built-in unit tests |
| State backend | Terraform Cloud, S3, etc. | Pulumi Cloud, S3, Azure, GCP |
| Provider ecosystem | Very large (2,000+) | Large (120+, growing) |
| Kubernetes support | kubernetes provider | Native Kubernetes provider |
| Secret handling | Sensitive values (limited) | Pulumi ESC (full integration) |
| Drift detection | `terraform plan` | `pulumi preview --refresh` |

Terraform remains the more widely known tool. Pulumi's advantage grows as configuration complexity increases — especially when conditional logic, computed values, and reusable abstractions would otherwise require complex HCL workarounds.

---

## Installation and Project Setup

```bash
# Install Pulumi CLI
curl -fsSL https://get.pulumi.com | sh

# Verify installation
pulumi version
# v3.116.0

# Login to Pulumi Cloud (free tier available)
pulumi login

# Or use local state (no account required)
pulumi login --local

# Create a new TypeScript project
mkdir platform-infra && cd platform-infra
pulumi new kubernetes-typescript

# Or a Go project
pulumi new kubernetes-go
```

---

## Kubernetes Provider: TypeScript

### Basic Deployment and Service

```typescript
// index.ts
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const appName = config.get("appName") ?? "web-api";
const image    = config.require("image");
const replicas = config.getNumber("replicas") ?? 2;

const labels = { app: appName };

const deployment = new k8s.apps.v1.Deployment(appName, {
  metadata: { name: appName },
  spec: {
    replicas,
    selector: { matchLabels: labels },
    template: {
      metadata: { labels },
      spec: {
        containers: [{
          name: appName,
          image,
          ports: [{ containerPort: 8080 }],
          resources: {
            requests: { cpu: "100m", memory: "128Mi" },
            limits:   { cpu: "500m", memory: "512Mi" },
          },
          livenessProbe: {
            httpGet: { path: "/healthz", port: 8080 },
            initialDelaySeconds: 5,
            periodSeconds: 10,
          },
          readinessProbe: {
            httpGet: { path: "/readyz", port: 8080 },
            initialDelaySeconds: 3,
            periodSeconds: 5,
          },
        }],
      },
    },
  },
});

const service = new k8s.core.v1.Service(appName, {
  metadata: { name: appName },
  spec: {
    selector: labels,
    ports: [{ port: 80, targetPort: 8080 }],
    type: "ClusterIP",
  },
});

// Export the cluster-internal DNS name
export const serviceHostname = service.metadata.name.apply(
  name => `${name}.${service.metadata.namespace ?? "default"}.svc.cluster.local`
);
```

### Ingress with cert-manager TLS

```typescript
// ingress.ts
import * as k8s from "@pulumi/kubernetes";

export function createIngress(
  name: string,
  serviceName: string,
  hostname: string,
  namespace: string = "default",
): k8s.networking.v1.Ingress {
  return new k8s.networking.v1.Ingress(name, {
    metadata: {
      name,
      namespace,
      annotations: {
        "cert-manager.io/cluster-issuer": "letsencrypt-prod",
        "nginx.ingress.kubernetes.io/proxy-body-size": "10m",
      },
    },
    spec: {
      ingressClassName: "nginx",
      tls: [{
        hosts: [hostname],
        secretName: `${name}-tls`,
      }],
      rules: [{
        host: hostname,
        http: {
          paths: [{
            path: "/",
            pathType: "Prefix",
            backend: {
              service: {
                name: serviceName,
                port: { number: 80 },
              },
            },
          }],
        },
      }],
    },
  });
}
```

---

## Kubernetes Provider: Go

### Full Application Stack in Go

```go
// main.go
package main

import (
	appsv1 "github.com/pulumi/pulumi-kubernetes/sdk/v4/go/kubernetes/apps/v1"
	corev1 "github.com/pulumi/pulumi-kubernetes/sdk/v4/go/kubernetes/core/v1"
	metav1 "github.com/pulumi/pulumi-kubernetes/sdk/v4/go/kubernetes/meta/v1"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi/config"
)

func main() {
	pulumi.Run(func(ctx *pulumi.Context) error {
		cfg := config.New(ctx, "")
		appName := cfg.Get("appName")
		if appName == "" {
			appName = "web-api"
		}
		image, err := cfg.Require("image"), error(nil)
		if image == "" {
			return fmt.Errorf("config 'image' is required")
		}
		_ = err

		labels := pulumi.StringMap{"app": pulumi.String(appName)}

		dep, err := appsv1.NewDeployment(ctx, appName, &appsv1.DeploymentArgs{
			Metadata: &metav1.ObjectMetaArgs{
				Name: pulumi.String(appName),
			},
			Spec: &appsv1.DeploymentSpecArgs{
				Replicas: pulumi.Int(2),
				Selector: &metav1.LabelSelectorArgs{
					MatchLabels: labels,
				},
				Template: &corev1.PodTemplateSpecArgs{
					Metadata: &metav1.ObjectMetaArgs{
						Labels: labels,
					},
					Spec: &corev1.PodSpecArgs{
						Containers: corev1.ContainerArray{
							&corev1.ContainerArgs{
								Name:  pulumi.String(appName),
								Image: pulumi.String(image),
								Ports: corev1.ContainerPortArray{
									&corev1.ContainerPortArgs{
										ContainerPort: pulumi.Int(8080),
									},
								},
								Resources: &corev1.ResourceRequirementsArgs{
									Requests: pulumi.StringMap{
										"cpu":    pulumi.String("100m"),
										"memory": pulumi.String("128Mi"),
									},
									Limits: pulumi.StringMap{
										"cpu":    pulumi.String("500m"),
										"memory": pulumi.String("512Mi"),
									},
								},
							},
						},
					},
				},
			},
		})
		if err != nil {
			return err
		}

		svc, err := corev1.NewService(ctx, appName, &corev1.ServiceArgs{
			Metadata: &metav1.ObjectMetaArgs{
				Name: pulumi.String(appName),
			},
			Spec: &corev1.ServiceSpecArgs{
				Selector: labels,
				Ports: corev1.ServicePortArray{
					&corev1.ServicePortArgs{
						Port:       pulumi.Int(80),
						TargetPort: pulumi.Int(8080),
					},
				},
				Type: pulumi.String("ClusterIP"),
			},
		})
		if err != nil {
			return err
		}

		ctx.Export("deploymentName", dep.Metadata.Name())
		ctx.Export("serviceName", svc.Metadata.Name())
		return nil
	})
}
```

---

## ComponentResource: Reusable Abstractions

**ComponentResource** is Pulumi's mechanism for packaging multiple resources into a reusable logical unit. It appears as a single resource in the state tree but manages child resources transparently.

### TypeScript ComponentResource

```typescript
// components/webapp.ts
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export interface WebAppArgs {
  image:          string;
  replicas?:      number;
  namespace?:     string;
  hostname?:      string;
  containerPort?: number;
  env?:           k8s.types.input.core.v1.EnvVar[];
}

export class WebApp extends pulumi.ComponentResource {
  public readonly deployment: k8s.apps.v1.Deployment;
  public readonly service:    k8s.core.v1.Service;
  public readonly ingress?:   k8s.networking.v1.Ingress;

  constructor(
    name: string,
    args: WebAppArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("platform:index:WebApp", name, args, opts);

    const childOpts = { parent: this };
    const ns    = args.namespace    ?? "default";
    const port  = args.containerPort ?? 8080;
    const reps  = args.replicas     ?? 2;
    const labels = { app: name };

    this.deployment = new k8s.apps.v1.Deployment(name, {
      metadata: { name, namespace: ns },
      spec: {
        replicas: reps,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            containers: [{
              name,
              image:  args.image,
              ports:  [{ containerPort: port }],
              env:    args.env ?? [],
              resources: {
                requests: { cpu: "100m", memory: "128Mi" },
                limits:   { cpu: "500m", memory: "512Mi" },
              },
            }],
          },
        },
      },
    }, childOpts);

    this.service = new k8s.core.v1.Service(`${name}-svc`, {
      metadata: { name, namespace: ns },
      spec: {
        selector: labels,
        ports: [{ port: 80, targetPort: port }],
      },
    }, childOpts);

    if (args.hostname) {
      this.ingress = new k8s.networking.v1.Ingress(`${name}-ing`, {
        metadata: {
          name,
          namespace: ns,
          annotations: { "cert-manager.io/cluster-issuer": "letsencrypt-prod" },
        },
        spec: {
          ingressClassName: "nginx",
          tls: [{ hosts: [args.hostname], secretName: `${name}-tls` }],
          rules: [{
            host: args.hostname,
            http: {
              paths: [{
                path: "/",
                pathType: "Prefix",
                backend: {
                  service: { name, port: { number: 80 } },
                },
              }],
            },
          }],
        },
      }, childOpts);
    }

    this.registerOutputs({
      deploymentName: this.deployment.metadata.name,
      serviceName:    this.service.metadata.name,
    });
  }
}
```

### Using the Component

```typescript
// index.ts
import { WebApp } from "./components/webapp";

const api = new WebApp("api", {
  image:     "registry.example.com/api:v2.4.1",
  replicas:  3,
  namespace: "platform",
  hostname:  "api.prod.example.com",
  env: [
    { name: "LOG_LEVEL", value: "info" },
    { name: "DB_HOST",   value: "postgres.platform.svc.cluster.local" },
  ],
});

export const apiServiceName = api.service.metadata.name;
```

---

## Stack References for Cross-Stack Dependencies

Large infrastructure is split into multiple stacks (e.g., networking, databases, applications). **StackReference** lets one stack consume outputs from another.

```typescript
// apps/index.ts — reads VPC and cluster info from a networking stack
import * as pulumi from "@pulumi/pulumi";
import * as aws    from "@pulumi/aws";
import * as eks    from "@pulumi/eks";

// Reference the networking stack
const networkStack = new pulumi.StackReference(
  `acme-corp/networking/${pulumi.getStack()}`
);

// Pull outputs from the networking stack
const vpcId         = networkStack.getOutput("vpcId");
const privateSubnets = networkStack.getOutput("privateSubnetIds");

// Create EKS cluster in the existing VPC
const cluster = new eks.Cluster("platform", {
  vpcId:                vpcId as pulumi.Output<string>,
  privateSubnetIds:     privateSubnets as pulumi.Output<string[]>,
  instanceType:         "m6i.large",
  desiredCapacity:      3,
  minSize:              2,
  maxSize:              10,
  enabledClusterLogTypes: ["api", "audit", "authenticator"],
});

export const kubeconfig    = cluster.kubeconfig;
export const clusterName   = cluster.eksCluster.name;
export const clusterEndpoint = cluster.eksCluster.endpoint;
```

---

## Pulumi ESC for Secrets

**Pulumi ESC** (Environments, Secrets, and Configuration) provides a centralised secret store that integrates with AWS Secrets Manager, HashiCorp Vault, Azure Key Vault, and GCP Secret Manager.

### Defining an ESC Environment

```yaml
# esc/production.yaml — managed by Pulumi Cloud
values:
  aws:
    login:
      fn::open::aws-login:
        oidc:
          roleArn: arn:aws:iam::123456789012:role/pulumi-esc-role
          sessionName: pulumi-esc

  secrets:
    fn::open::aws-secrets:
      login: ${aws.login}
      region: us-east-1
      get:
        dbPassword:
          secretId: prod/platform/db-password
        apiKey:
          secretId: prod/platform/api-key

  environmentVariables:
    DATABASE_PASSWORD: ${secrets.dbPassword}
    PLATFORM_API_KEY:  ${secrets.apiKey}

  pulumiConfig:
    aws:region: us-east-1
```

### Consuming ESC in a Stack

```bash
# Open an ESC environment interactively
pulumi env open acme-corp/production

# Run a stack update with ESC environment
pulumi up --env acme-corp/production

# List available environments
pulumi env ls
```

### Referencing Secrets Programmatically

```typescript
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();

// Values from ESC or Pulumi config (encrypted at rest)
const dbPassword = config.requireSecret("dbPassword");
const apiKey     = config.requireSecret("apiKey");

// dbPassword is pulumi.Output<string> — value is encrypted in state
const secret = new k8s.core.v1.Secret("app-secrets", {
  metadata: { name: "app-secrets" },
  stringData: {
    DATABASE_PASSWORD: dbPassword,
    PLATFORM_API_KEY:  apiKey,
  },
  type: "Opaque",
});
```

---

## State Backend Configuration

### Pulumi Cloud (Default)

```bash
pulumi login
# Authenticated state stored in Pulumi Cloud with audit logs
```

### AWS S3 Backend

```bash
# Use S3 with KMS encryption
pulumi login s3://my-pulumi-state-bucket

# With encryption key
export PULUMI_BACKEND_URL=s3://my-pulumi-state-bucket?region=us-east-1&awssdk=v2
export AWS_KMS_KEY_ID=arn:aws:kms:us-east-1:123456789012:key/mrk-EXAMPLE_REPLACE_ME
```

### Azure Blob Storage Backend

```bash
export AZURE_STORAGE_ACCOUNT=mypulumistateaccount
export AZURE_STORAGE_KEY=EXAMPLE_TOKEN_REPLACE_ME
pulumi login azblob://pulumi-state
```

### GCP GCS Backend

```bash
pulumi login gs://my-pulumi-state-bucket
```

---

## Automation API: Programmatic Deployments

The **Pulumi Automation API** exposes the entire Pulumi engine as a Go or TypeScript SDK, enabling custom deployment pipelines, multi-stack orchestration, and embedded infrastructure management.

### Go Automation API Example

```go
// cmd/deploy/main.go
package main

import (
	"context"
	"fmt"
	"os"

	"github.com/pulumi/pulumi/sdk/v3/go/auto"
	"github.com/pulumi/pulumi/sdk/v3/go/auto/optup"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
)

func deployPlatform(ctx context.Context, env string) error {
	projectName := "platform"
	stackName   := fmt.Sprintf("acme-corp/%s/%s", projectName, env)

	stack, err := auto.UpsertStackLocalSource(ctx, stackName, "./infra",
		auto.WorkDir("./infra"),
	)
	if err != nil {
		return fmt.Errorf("creating stack: %w", err)
	}

	// Set configuration
	if err := stack.SetConfig(ctx, "image",
		auto.ConfigValue{Value: os.Getenv("DEPLOY_IMAGE")}); err != nil {
		return fmt.Errorf("setting config: %w", err)
	}

	// Refresh state to detect drift
	_, err = stack.Refresh(ctx)
	if err != nil {
		return fmt.Errorf("refreshing state: %w", err)
	}

	// Preview changes
	prev, err := stack.Preview(ctx)
	if err != nil {
		return fmt.Errorf("previewing: %w", err)
	}
	fmt.Printf("Preview: %d to add, %d to change, %d to destroy\n",
		prev.ChangeSummary["create"],
		prev.ChangeSummary["update"],
		prev.ChangeSummary["delete"],
	)

	// Execute update with streaming output
	result, err := stack.Up(ctx,
		optup.ProgressStreams(os.Stdout),
		optup.ErrorProgressStreams(os.Stderr),
	)
	if err != nil {
		return fmt.Errorf("update failed: %w", err)
	}

	fmt.Printf("Update complete: %d resources\n", len(result.Outputs))
	return nil
}

func main() {
	env := os.Getenv("DEPLOY_ENV")
	if env == "" {
		env = "staging"
	}

	if err := deployPlatform(context.Background(), env); err != nil {
		fmt.Fprintf(os.Stderr, "deployment error: %v\n", err)
		os.Exit(1)
	}
}
```

---

## Drift Detection

Pulumi detects drift by refreshing state from the live cloud/cluster before planning:

```bash
# Refresh state to detect infrastructure drift
pulumi refresh

# Preview after refresh shows only actual changes
pulumi preview --refresh

# Common output when drift is detected:
# Refreshing state... (12 changes)
#   ~ k8s:apps/v1:Deployment::web-api (modified externally)
#     ~ spec.replicas: 2 => 3  [external change]
```

### Automated Drift Detection in CI

```yaml
# .github/workflows/drift.yaml
name: Drift Detection
on:
  schedule:
    - cron: "0 8 * * 1-5"   # Weekdays at 08:00 UTC

jobs:
  detect-drift:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: pulumi/actions@v5
        with:
          command: refresh
          stack-name: acme-corp/platform/production
          expect-no-changes: true
        env:
          PULUMI_ACCESS_TOKEN: ${{ secrets.PULUMI_ACCESS_TOKEN }}
```

---

## Importing Existing Resources

Resources created outside Pulumi can be imported into state without re-creation:

```bash
# Import an existing Kubernetes deployment
pulumi import kubernetes:apps/v1:Deployment web-api default/web-api

# Import an existing AWS RDS instance
pulumi import aws:rds/instance:Instance primary db-prod-primary

# Bulk import using import file
pulumi import --file imports.json
```

```json
// imports.json
{
  "resources": [
    {
      "type": "kubernetes:apps/v1:Deployment",
      "name": "web-api",
      "id": "default/web-api"
    },
    {
      "type": "kubernetes:core/v1:Service",
      "name": "web-api-svc",
      "id": "default/web-api"
    }
  ]
}
```

---

## Testing with Jest (TypeScript) and go test (Go)

### TypeScript Unit Tests

```typescript
// __tests__/webapp.test.ts
import * as pulumi from "@pulumi/pulumi";
import * as k8s    from "@pulumi/kubernetes";

pulumi.runtime.setMocks({
  newResource: (args) => ({
    id:   `${args.name}_id`,
    state: args.inputs,
  }),
  call: (args) => args.inputs,
});

import { WebApp } from "../components/webapp";

describe("WebApp Component", () => {
  test("creates deployment with correct replicas", async () => {
    const app = new WebApp("test-app", {
      image:    "test-image:latest",
      replicas: 3,
    });

    const replicas = await app.deployment.spec.replicas.apply(r => r);
    expect(replicas).toBe(3);
  });

  test("creates ingress when hostname is provided", async () => {
    const app = new WebApp("test-app-ing", {
      image:    "test-image:latest",
      hostname: "app.example.com",
    });

    expect(app.ingress).toBeDefined();
  });

  test("does not create ingress without hostname", async () => {
    const app = new WebApp("test-app-no-ing", {
      image: "test-image:latest",
    });

    expect(app.ingress).toBeUndefined();
  });
});
```

```bash
# Run tests
npm test
```

### Go Unit Tests

```go
// infra_test.go
package main

import (
	"testing"

	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	"github.com/stretchr/testify/assert"
)

func TestDeploymentReplicas(t *testing.T) {
	err := pulumi.RunErr(func(ctx *pulumi.Context) error {
		infra, err := createInfrastructure(ctx)
		if err != nil {
			return err
		}

		infra.deployment.Spec.Replicas().ApplyT(func(replicas *int) error {
			assert.NotNil(t, replicas)
			assert.Equal(t, 2, *replicas)
			return nil
		})

		return nil
	}, pulumi.WithMocks("project", "stack", mocks(0)))

	assert.NoError(t, err)
}

type mocks int

func (mocks) NewResource(args pulumi.MockResourceArgs) (string, resource.PropertyMap, error) {
	return args.Name + "_id", args.Inputs, nil
}

func (mocks) Call(args pulumi.MockCallArgs) (resource.PropertyMap, error) {
	return args.Args, nil
}
```

---

## Cross-Cloud Stack: EKS + RDS + Route53

A production platform stack that provisions an EKS cluster, RDS database, and Route53 DNS entry:

```typescript
// infra/index.ts
import * as pulumi from "@pulumi/pulumi";
import * as aws    from "@pulumi/aws";
import * as eks    from "@pulumi/eks";
import * as k8s    from "@pulumi/kubernetes";

const cfg    = new pulumi.Config();
const region = aws.config.region ?? "us-east-1";
const stage  = pulumi.getStack(); // dev, staging, production

// ---- VPC ---------------------------------------------------------------
const vpc = new aws.ec2.Vpc("platform", {
  cidrBlock:          "10.0.0.0/16",
  enableDnsSupport:   true,
  enableDnsHostnames: true,
  tags: { Name: `platform-${stage}`, Environment: stage },
});

const privateSubnets = [0, 1, 2].map(i =>
  new aws.ec2.Subnet(`private-${i}`, {
    vpcId:            vpc.id,
    cidrBlock:        `10.0.${i}.0/24`,
    availabilityZone: pulumi.output(aws.getAvailabilityZones()).names[i],
    tags: { "kubernetes.io/role/internal-elb": "1" },
  })
);

// ---- EKS Cluster -------------------------------------------------------
const cluster = new eks.Cluster("platform", {
  vpcId:            vpc.id,
  privateSubnetIds: privateSubnets.map(s => s.id),
  instanceType:     "m6i.xlarge",
  desiredCapacity:  3,
  minSize:          2,
  maxSize:          10,
  nodeRootVolumeSize: 50,
  enabledClusterLogTypes: ["api", "audit"],
  tags: { Environment: stage },
});

// ---- RDS PostgreSQL ----------------------------------------------------
const dbSubnetGroup = new aws.rds.SubnetGroup("platform", {
  subnetIds: privateSubnets.map(s => s.id),
});

const dbPassword = cfg.requireSecret("dbPassword");

const db = new aws.rds.Instance("platform", {
  engine:              "postgres",
  engineVersion:       "16.2",
  instanceClass:       "db.t4g.medium",
  allocatedStorage:    100,
  storageType:         "gp3",
  dbName:              "platform",
  username:            "appuser",
  password:            dbPassword,
  dbSubnetGroupName:   dbSubnetGroup.name,
  multiAz:             stage === "production",
  deletionProtection:  stage === "production",
  backupRetentionPeriod: stage === "production" ? 7 : 1,
  tags: { Environment: stage },
});

// ---- Route53 -----------------------------------------------------------
const zone = aws.route53.getZoneOutput({ name: "example.com" });

const apiDnsRecord = new aws.route53.Record("api", {
  zoneId: zone.zoneId,
  name:   `api.${stage}.example.com`,
  type:   "CNAME",
  ttl:    60,
  records: [cluster.eksCluster.endpoint],
});

// ---- Deploy app to EKS ------------------------------------------------
const k8sProvider = new k8s.Provider("eks", {
  kubeconfig: cluster.kubeconfig,
});

const apiDeployment = new k8s.apps.v1.Deployment("api", {
  metadata: { namespace: "platform" },
  spec: {
    replicas: stage === "production" ? 3 : 1,
    selector: { matchLabels: { app: "api" } },
    template: {
      metadata: { labels: { app: "api" } },
      spec: {
        containers: [{
          name:  "api",
          image: cfg.require("apiImage"),
          env: [{
            name:  "DATABASE_URL",
            value: pulumi.interpolate`postgres://appuser:${dbPassword}@${db.endpoint}/platform`,
          }],
        }],
      },
    },
  },
}, { provider: k8sProvider });

// ---- Exports -----------------------------------------------------------
export const clusterName     = cluster.eksCluster.name;
export const dbEndpoint      = db.endpoint;
export const apiUrl          = pulumi.interpolate`https://api.${stage}.example.com`;
export const kubeconfigOutput = cluster.kubeconfig;
```

---

## CI/CD Integration

### GitHub Actions

```yaml
# .github/workflows/pulumi.yaml
name: Pulumi

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  preview:
    name: Preview
    runs-on: ubuntu-24.04
    if: github.event_name == 'pull_request'
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npm ci
      - uses: pulumi/actions@v5
        with:
          command: preview
          stack-name: acme-corp/platform/production
          comment-on-pr: true
          comment-on-pr-number: ${{ github.event.number }}
        env:
          PULUMI_ACCESS_TOKEN: ${{ secrets.PULUMI_ACCESS_TOKEN }}
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}

  deploy:
    name: Deploy
    runs-on: ubuntu-24.04
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npm ci
      - uses: pulumi/actions@v5
        with:
          command: up
          stack-name: acme-corp/platform/production
        env:
          PULUMI_ACCESS_TOKEN: ${{ secrets.PULUMI_ACCESS_TOKEN }}
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
```

---

## Pulumi AI for IaC Generation

Pulumi AI (`pulumi.ai`) generates Pulumi code from natural language descriptions. Generated code should always be reviewed against provider documentation and tested before production use.

```bash
# Ask Pulumi AI to generate a starting point (CLI integration)
pulumi ai generate "Create an EKS cluster with 3 node groups, ALB ingress controller,
and external-dns in TypeScript"

# Review, test, and refine the generated output
```

---

## Production Checklist

Before promoting a Pulumi stack to production:

- State is stored in an encrypted backend with access controls
- Secrets are managed through Pulumi ESC or `config --secret` (never plain `config set`)
- `pulumi preview` output is reviewed and attached to every PR
- `pulumi refresh` is run in CI to detect external drift
- All ComponentResources have unit tests covering invariants
- Destructive changes (database deletions, VPC replacement) are protected by `protect: true` resource options
- Stack outputs expose only non-sensitive values (sensitive outputs use `pulumi.secret()`)
- CI has separate read-only (preview) and read-write (apply) credentials

---

## Summary

Pulumi brings the full expressiveness of general-purpose programming languages to infrastructure provisioning. The Kubernetes provider covers the same resource surface as `kubectl` and Helm, while ComponentResource patterns let teams build internal platform abstractions that enforce organisational standards at the code level rather than through documentation.

The Automation API unlocks embedding Pulumi in custom deployment pipelines, enabling sophisticated multi-stack orchestration that would require complex wrapper scripts with Terraform or Helm. Combined with Pulumi ESC for centralised secret management and first-class cross-stack references, Pulumi scales from a single developer's project to a multi-team platform engineering toolkit.
