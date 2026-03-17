---
title: "Kubernetes AWS EKS Fargate: Serverless Kubernetes Node Provisioning"
date: 2031-06-01T00:00:00-05:00
draft: false
tags: ["Kubernetes", "AWS", "EKS", "Fargate", "Serverless", "DevOps", "Cloud"]
categories:
- Kubernetes
- AWS
- Cloud Native
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to EKS Fargate covering Fargate profile configuration, pod selector matching, resource overhead and billing, Fargate limitations, CoreDNS on Fargate, and hybrid Fargate plus EC2 node group architectures."
more_link: "yes"
url: "/kubernetes-eks-fargate-serverless-node-provisioning-guide/"
---

AWS EKS Fargate eliminates EC2 instance management by running each Kubernetes pod in its own isolated compute environment. Instead of managing node groups, scaling policies, and OS patches, you define Fargate profiles that match pods to serverless compute. This guide covers every aspect of production Fargate deployment: profile configuration, billing model, the constraints you must design around, and the hybrid architectures that combine Fargate's operational simplicity with EC2's flexibility.

<!--more-->

# Kubernetes AWS EKS Fargate: Serverless Kubernetes Node Provisioning

## Section 1: EKS Fargate Architecture

When a pod is scheduled on Fargate, AWS provisions a micro-VM for that pod using Firecracker. Each pod runs in isolation with its own kernel, CPU, memory, and network interface. The pod shares no OS-level resources with other pods. From Kubernetes's perspective, each Fargate pod appears as a node in the cluster.

### Key Architectural Properties

- Each Fargate pod = one dedicated Firecracker micro-VM
- The Kubernetes node is ephemeral and tied to the pod lifecycle
- Fargate nodes are named with the pattern: `fargate-ip-<a>-<b>-<c>-<d>.<region>.compute.internal`
- No SSH access, no host filesystem, no privileged containers
- VPC networking via ENI directly attached to the pod
- IAM execution role provides AWS API access for the Fargate data plane

### How Pod Scheduling Works

1. A pod is created in the cluster
2. The Fargate scheduler reads Fargate profiles in the EKS cluster
3. If the pod's namespace and labels match a profile's selectors, it is scheduled on Fargate
4. AWS provisions a Firecracker VM sized to the pod's resource requests
5. The VM registers as a Kubernetes node, the pod is bound to it, and kubelet starts the container
6. When the pod terminates, the VM is de-provisioned

## Section 2: Creating EKS Clusters with Fargate

### Using eksctl

```yaml
# cluster-fargate.yaml
apiVersion: eksctl.io/v1alpha5
kind: ClusterConfig

metadata:
  name: production-cluster
  region: us-east-1
  version: "1.29"

vpc:
  cidr: "10.0.0.0/16"
  nat:
    gateway: HighlyAvailable

fargateProfiles:
  - name: default
    selectors:
      - namespace: default
      - namespace: kube-system
        labels:
          k8s-app: kube-dns

  - name: app-team
    selectors:
      - namespace: app-production
      - namespace: app-staging
        labels:
          fargate: "true"
    podExecutionRoleARN: "arn:aws:iam::123456789012:role/FargatePodExecutionRole"
    subnets:
      - subnet-0a1b2c3d4e5f6a7b8  # Private subnets only
      - subnet-0b2c3d4e5f6a7b8c9
```

```bash
eksctl create cluster -f cluster-fargate.yaml
```

### Using AWS CLI

```bash
# Create the cluster
aws eks create-cluster \
    --name production-cluster \
    --role-arn arn:aws:iam::123456789012:role/EKSClusterRole \
    --kubernetes-version 1.29 \
    --resources-vpc-config \
        subnetIds=subnet-0a1b,subnet-0b2c,\
        securityGroupIds=sg-0abc123,\
        endpointPublicAccess=true,\
        endpointPrivateAccess=true

# Create a Fargate profile
aws eks create-fargate-profile \
    --cluster-name production-cluster \
    --fargate-profile-name app-team \
    --pod-execution-role-arn arn:aws:iam::123456789012:role/FargatePodExecutionRole \
    --selectors \
        namespace=app-production \
        namespace=app-staging,labels={fargate=true} \
    --subnets subnet-0a1b subnet-0b2c

# List Fargate profiles
aws eks list-fargate-profiles --cluster-name production-cluster

# Describe a profile
aws eks describe-fargate-profile \
    --cluster-name production-cluster \
    --fargate-profile-name app-team
```

### Terraform Configuration

```hcl
# fargate.tf

resource "aws_eks_cluster" "main" {
  name     = "production-cluster"
  role_arn = aws_iam_role.eks_cluster.arn
  version  = "1.29"

  vpc_config {
    subnet_ids              = module.vpc.private_subnets
    endpoint_private_access = true
    endpoint_public_access  = true
  }

  depends_on = [
    aws_iam_role_policy_attachment.eks_cluster_policy,
  ]
}

resource "aws_iam_role" "fargate_pod_execution" {
  name = "fargate-pod-execution-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "eks-fargate-pods.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "fargate_pod_execution" {
  role       = aws_iam_role.fargate_pod_execution.name
  policy_arn = "arn:aws:policy/AmazonEKSFargatePodExecutionRolePolicy"
}

resource "aws_eks_fargate_profile" "default" {
  cluster_name           = aws_eks_cluster.main.name
  fargate_profile_name   = "default"
  pod_execution_role_arn = aws_iam_role.fargate_pod_execution.arn
  subnet_ids             = module.vpc.private_subnets

  selector {
    namespace = "default"
  }

  selector {
    namespace = "kube-system"
    labels = {
      "k8s-app" = "kube-dns"
    }
  }
}

resource "aws_eks_fargate_profile" "app_team" {
  cluster_name           = aws_eks_cluster.main.name
  fargate_profile_name   = "app-team"
  pod_execution_role_arn = aws_iam_role.fargate_pod_execution.arn
  subnet_ids             = module.vpc.private_subnets

  selector {
    namespace = "app-production"
  }

  selector {
    namespace = "app-staging"
    labels = {
      fargate = "true"
    }
  }

  tags = {
    Environment = "production"
    Team        = "platform"
  }
}
```

## Section 3: Fargate Profile Selectors

Fargate profiles use namespace + label selectors to determine which pods run on Fargate. A pod runs on Fargate if it matches ANY selector in ANY profile.

### Selector Matching Rules

```yaml
# Profile with multiple selectors
fargateProfiles:
  - name: example
    selectors:
      # Selector 1: ALL pods in namespace "secure-apps"
      - namespace: secure-apps

      # Selector 2: Only pods with label tier=backend in "api" namespace
      - namespace: api
        labels:
          tier: backend

      # Selector 3: Pods with multiple required labels
      - namespace: workers
        labels:
          compute-type: fargate
          environment: production
```

A pod in `api` namespace with label `tier=backend` matches selector 2. A pod in `api` namespace without that label does NOT match and would be scheduled on EC2 nodes if available.

### Namespace-Scoped Isolation

```bash
# Create a namespace with Fargate profile
kubectl create namespace secure-payments

# All pods in secure-payments will run on Fargate
# because the profile selector has no label requirement

# Verify which Fargate profile matches a pod
kubectl describe pod <pod-name> -n secure-payments | grep fargate
```

### Label-Based Selective Fargate

```yaml
# Only pods with this annotation/label run on Fargate within a namespace
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-processor
  namespace: api
spec:
  template:
    metadata:
      labels:
        app: payment-processor
        tier: backend          # This label triggers Fargate scheduling
    spec:
      containers:
        - name: processor
          image: payment-processor:1.0
          resources:
            requests:
              cpu: "500m"
              memory: "1Gi"
            limits:
              cpu: "500m"
              memory: "1Gi"
```

## Section 4: Resource Sizing and Billing Model

### Resource Rounding

Fargate rounds pod resource requests up to the nearest supported combination. This is critical for cost optimization:

| vCPU | Memory Options |
|---|---|
| 0.25 | 0.5GB, 1GB, 2GB |
| 0.5 | 1GB, 2GB, 3GB, 4GB |
| 1 | 2GB, 3GB, 4GB, 5GB, 6GB, 7GB, 8GB |
| 2 | Between 4GB and 16GB (1GB increments) |
| 4 | Between 8GB and 30GB (1GB increments) |
| 8 | Between 16GB and 60GB (4GB increments) |
| 16 | Between 32GB and 120GB (8GB increments) |

### Pod Overhead

Fargate reserves resources for the Kubernetes components running in the pod's VM:

- 256m CPU overhead per pod
- 512MB memory overhead per pod

```yaml
# If you request 500m CPU and 1Gi memory:
# Fargate bills for: 500m + 256m = 756m -> rounds to 1 vCPU
# Fargate bills for: 1024Mi + 512Mi = 1536Mi -> rounds to 2GB

# Always set requests = limits on Fargate
# Fargate uses requests for sizing, not limits
resources:
  requests:
    cpu: "1"
    memory: "2Gi"
  limits:
    cpu: "1"
    memory: "2Gi"
```

### Cost Calculation

```bash
# Fargate pricing (us-east-1, 2024 rates - verify current pricing at aws.amazon.com/fargate/pricing)
# vCPU: $0.04048 per vCPU-hour
# Memory: $0.004445 per GB-hour

# Example: 1 vCPU, 2GB pod running 24/7 for 30 days
# vCPU cost: 1 * $0.04048 * 720h = $29.15
# Memory cost: 2 * $0.004445 * 720h = $6.40
# Total: $35.55 per month for one pod

# Compare to t3.medium EC2: ~$30/month but can run multiple pods
# Fargate makes sense when:
# - Pod density per node is low
# - You want to eliminate node management overhead
# - Security isolation per pod is required
```

## Section 5: CoreDNS on Fargate

By default, EKS CoreDNS runs on EC2 nodes. To run a fully Fargate cluster, CoreDNS must be patched to run on Fargate:

```bash
# Patch CoreDNS deployment to run on Fargate
# First, ensure you have a Fargate profile matching kube-system namespace
# with label k8s-app=kube-dns

# Remove the EC2-specific annotation from CoreDNS
kubectl patch deployment coredns \
    -n kube-system \
    --type json \
    -p='[{"op": "remove", "path": "/spec/template/metadata/annotations/eks.amazonaws.com~1compute-type"}]'

# This removes the annotation that forces CoreDNS to EC2
# Alternatively, add the Fargate annotation explicitly
kubectl patch deployment coredns \
    -n kube-system \
    --type merge \
    -p='{"spec":{"template":{"metadata":{"annotations":{"eks.amazonaws.com/compute-type":"fargate"}}}}}'

# Restart CoreDNS pods
kubectl rollout restart deployment coredns -n kube-system

# Verify CoreDNS pods are running on Fargate nodes
kubectl get pods -n kube-system -l k8s-app=kube-dns -o wide
# Node names should start with "fargate-ip-"

# Ensure Fargate profile covers kube-system/coredns
aws eks describe-fargate-profile \
    --cluster-name production-cluster \
    --fargate-profile-name default
```

### Fargate Profile for CoreDNS

```yaml
fargateProfiles:
  - name: coredns
    selectors:
      - namespace: kube-system
        labels:
          k8s-app: kube-dns
```

### CoreDNS Resource Sizing on Fargate

CoreDNS on Fargate requires explicit resource requests:

```bash
kubectl patch deployment coredns \
    -n kube-system \
    --type merge \
    -p='{
        "spec": {
            "template": {
                "spec": {
                    "containers": [{
                        "name": "coredns",
                        "resources": {
                            "requests": {
                                "cpu": "200m",
                                "memory": "256Mi"
                            },
                            "limits": {
                                "cpu": "200m",
                                "memory": "256Mi"
                            }
                        }
                    }]
                }
            }
        }
    }'
```

## Section 6: Fargate Limitations

Understanding what Fargate cannot do is essential for architectural decisions:

### DaemonSets Do Not Run on Fargate

DaemonSets are designed to run one pod per node. On Fargate, there are no persistent nodes, so DaemonSets are not scheduled on Fargate pods. This affects:

- Log collection agents (Fluentd, Fluent Bit, Filebeat)
- Monitoring agents (Datadog agent, New Relic infrastructure)
- Node-level security tools (Falco, Aqua)
- Network plugins

**Workaround for logging**: Use the AWS for Fluent Bit sidecar pattern:

```yaml
# logging-sidecar.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-with-logging
spec:
  template:
    spec:
      containers:
        - name: app
          image: myapp:1.0
          resources:
            requests: {cpu: "500m", memory: "1Gi"}
            limits: {cpu: "500m", memory: "1Gi"}

        - name: log-router
          image: public.ecr.aws/aws-observability/aws-for-fluent-bit:stable
          env:
            - name: AWS_REGION
              value: us-east-1
          resources:
            requests: {cpu: "50m", memory: "64Mi"}
            limits: {cpu: "50m", memory: "64Mi"}
          volumeMounts:
            - name: fluentbit-config
              mountPath: /fluent-bit/etc/

      volumes:
        - name: fluentbit-config
          configMap:
            name: fluentbit-config
```

**Workaround for monitoring**: Use AWS Container Insights with Fargate support:

```bash
# Enable Container Insights for EKS Fargate
aws eks update-addon \
    --cluster-name production-cluster \
    --addon-name amazon-cloudwatch-observability \
    --configuration-values '{"agent":{"config":{"logs":{"metrics_collected":{"kubernetes":{"enhanced_container_insights":true}}}}}}'
```

### No hostPath Volumes

Fargate pods cannot mount host filesystem paths. This is by design for security isolation.

**Affected patterns:**
- Shared /tmp or /var/run directories
- Docker socket mounting (not allowed anyway in production)
- Node-local storage for performance

**Alternative**: Use `emptyDir` for temporary shared storage between containers in a pod:

```yaml
spec:
  containers:
    - name: app
      volumeMounts:
        - name: shared-tmp
          mountPath: /tmp
    - name: sidecar
      volumeMounts:
        - name: shared-tmp
          mountPath: /tmp
  volumes:
    - name: shared-tmp
      emptyDir: {}
```

### No Privileged Containers

Fargate does not allow privileged containers or `hostNetwork`, `hostPID`, or `hostIPC`. This affects:
- Tools that need raw socket access
- CNI plugins
- Certain security scanning tools

### No GPU Support

GPU workloads cannot run on Fargate. These must use EC2 GPU instance node groups.

### Storage Limitations

- Ephemeral storage limit: 20GB by default, configurable up to 175GB
- No local NVMe SSD-backed storage (local instance store)
- EFS is supported for persistent storage
- EBS is supported as a block volume

```yaml
# Configure expanded ephemeral storage
apiVersion: apps/v1
kind: Deployment
metadata:
  name: data-processor
spec:
  template:
    metadata:
      annotations:
        # Request more ephemeral storage
        eks.amazonaws.com/fargate-ephemeral-storage: "50Gi"
    spec:
      containers:
        - name: processor
          image: data-processor:1.0
```

## Section 7: Hybrid Fargate + EC2 Node Group Architecture

Most production EKS clusters use a hybrid architecture that places appropriate workloads on Fargate and others on EC2:

### Architecture Pattern

```
┌─────────────────────────────────────────────────────┐
│                  EKS Cluster                        │
│                                                     │
│  ┌──────────────────┐  ┌────────────────────────┐  │
│  │   EC2 Node Group  │  │   Fargate Profiles      │  │
│  │                  │  │                         │  │
│  │  - DaemonSets    │  │  - Stateless microsvcs  │  │
│  │  - GPU workloads │  │  - Batch jobs           │  │
│  │  - Storage-heavy │  │  - API servers          │  │
│  │  - Long-running  │  │  - Staging workloads    │  │
│  │    stateful apps │  │  - Event-driven workers │  │
│  └──────────────────┘  └────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### eksctl Hybrid Configuration

```yaml
# hybrid-cluster.yaml
apiVersion: eksctl.io/v1alpha5
kind: ClusterConfig

metadata:
  name: hybrid-cluster
  region: us-east-1
  version: "1.29"

managedNodeGroups:
  - name: system-nodes
    instanceType: m5.large
    minSize: 2
    maxSize: 10
    desiredCapacity: 3
    labels:
      workload-type: system
    taints:
      - key: node-type
        value: system
        effect: NoSchedule
    iam:
      attachPolicyARNs:
        - arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy
        - arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy
        - arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly

  - name: gpu-nodes
    instanceType: g4dn.xlarge
    minSize: 0
    maxSize: 5
    desiredCapacity: 0
    labels:
      workload-type: gpu
    taints:
      - key: nvidia.com/gpu
        value: "true"
        effect: NoSchedule

fargateProfiles:
  - name: stateless-apps
    selectors:
      - namespace: apps
        labels:
          fargate: "true"
      - namespace: batch-jobs

  - name: staging
    selectors:
      - namespace: staging
```

### Directing Workloads to the Right Compute

```yaml
# Force a pod to EC2 (for workloads with DaemonSet dependencies)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: log-heavy-app
  namespace: apps
spec:
  template:
    metadata:
      labels:
        app: log-heavy-app
        # Deliberately NO fargate: "true" label
    spec:
      # This pod won't match any Fargate profile selector
      # (assuming the "apps" namespace profile requires fargate=true label)
      nodeSelector:
        workload-type: system
      containers:
        - name: app
          image: log-heavy-app:1.0
```

```yaml
# Opt a specific deployment into Fargate
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: apps
spec:
  template:
    metadata:
      labels:
        app: api-server
        fargate: "true"          # Matches Fargate profile selector
    spec:
      containers:
        - name: api
          image: api-server:2.0
          resources:
            requests:
              cpu: "1"
              memory: "2Gi"
            limits:
              cpu: "1"
              memory: "2Gi"
```

## Section 8: IAM and Security

### Fargate Pod Execution Role

The pod execution role is used by the Fargate data plane to pull images and write logs:

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "ecr:GetAuthorizationToken",
                "ecr:BatchCheckLayerAvailability",
                "ecr:GetDownloadUrlForLayer",
                "ecr:BatchGetImage",
                "logs:CreateLogStream",
                "logs:CreateLogGroup",
                "logs:DescribeLogStreams",
                "logs:PutLogEvents"
            ],
            "Resource": "*"
        }
    ]
}
```

### IRSA with Fargate (Pod-Level IAM)

Fargate fully supports IAM Roles for Service Accounts (IRSA):

```bash
# Create OIDC provider for the cluster
eksctl utils associate-iam-oidc-provider \
    --cluster production-cluster \
    --approve

# Create service account with IAM role
eksctl create iamserviceaccount \
    --cluster production-cluster \
    --namespace apps \
    --name s3-reader \
    --attach-policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess \
    --approve
```

```yaml
# Pod using IRSA on Fargate
apiVersion: apps/v1
kind: Deployment
metadata:
  name: s3-app
  namespace: apps
spec:
  template:
    metadata:
      labels:
        app: s3-app
        fargate: "true"
    spec:
      serviceAccountName: s3-reader
      containers:
        - name: app
          image: s3-app:1.0
          env:
            - name: AWS_REGION
              value: us-east-1
```

## Section 9: Observability on Fargate

### AWS CloudWatch Logging

```yaml
# Enable Fargate logging via ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: aws-logging
  namespace: aws-observability
data:
  output.conf: |
    [OUTPUT]
        Name cloudwatch_logs
        Match *
        region us-east-1
        log_group_name /aws/eks/production-cluster/fargate
        log_stream_prefix fargate-
        auto_create_group true
  parsers.conf: |
    [PARSER]
        Name json
        Format json
        Time_Key time
        Time_Format %Y-%m-%dT%H:%M:%S.%L
```

```bash
# Create the aws-observability namespace
kubectl create namespace aws-observability

# Apply the ConfigMap
kubectl apply -f aws-logging-configmap.yaml

# Verify logging is working
kubectl logs -n apps <fargate-pod-name>
# Also check CloudWatch Logs console
```

### Container Insights with Fargate

```bash
# Install CloudWatch agent for Fargate (uses IRSA)
kubectl apply -f https://raw.githubusercontent.com/aws-samples/amazon-cloudwatch-container-insights/latest/k8s-deployment-manifest-templates/deployment-mode/service/cwagent-service-account.yaml

# Create IRSA for CloudWatch agent
eksctl create iamserviceaccount \
    --cluster production-cluster \
    --namespace amazon-cloudwatch \
    --name cloudwatch-agent \
    --attach-policy-arn arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy \
    --approve
```

## Section 10: Autoscaling on Fargate

### Horizontal Pod Autoscaler

HPA works normally with Fargate because each new pod triggers a new Fargate VM:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-server-hpa
  namespace: apps
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  minReplicas: 2
  maxReplicas: 50
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Resource
      resource:
        name: memory
        target:
          type: AverageValue
          averageValue: 1.5Gi
```

### KEDA for Event-Driven Autoscaling

KEDA can scale Fargate pods to zero, which is particularly cost-effective:

```yaml
# Scale SQS consumer pods based on queue depth
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: sqs-consumer-scaler
  namespace: batch-jobs
spec:
  scaleTargetRef:
    name: sqs-consumer
  minReplicaCount: 0    # Scale to zero when queue is empty
  maxReplicaCount: 100  # Each pod is a Fargate VM
  triggers:
    - type: aws-sqs-queue
      metadata:
        queueURL: https://sqs.us-east-1.amazonaws.com/123456789012/work-queue
        queueLength: "10"
        awsRegion: us-east-1
      authenticationRef:
        name: keda-trigger-auth-aws
```

## Section 11: Networking on Fargate

### VPC CNI on Fargate

Each Fargate pod gets its own ENI with a private IP from the VPC subnet. This has implications:

```bash
# Check available IPs in your subnets
aws ec2 describe-subnets \
    --filters Name=vpc-id,Values=vpc-0abc \
    --query 'Subnets[*].[SubnetId,AvailabilityZone,AvailableIpAddressCount]' \
    --output table

# Plan for IP exhaustion: each Fargate pod consumes one ENI
# For 200 pods across 3 AZs, each subnet needs ~70 available IPs
# Use /24 or larger subnets for production Fargate workloads
```

### Security Groups for Pods

Fargate fully supports Security Groups for Pods:

```yaml
# SecurityGroupPolicy CRD
apiVersion: vpcresources.k8s.aws/v1beta1
kind: SecurityGroupPolicy
metadata:
  name: payment-service-sgp
  namespace: apps
spec:
  podSelector:
    matchLabels:
      app: payment-service
  securityGroups:
    groupIds:
      - sg-0payment123  # Allows only HTTPS to payment gateway
```

## Section 12: Common Pitfalls and Best Practices

### Always Set Resource Requests and Limits

```yaml
# Required: Fargate uses requests to size the VM
# Best practice: set requests == limits for predictable billing
resources:
  requests:
    cpu: "1"
    memory: "2Gi"
  limits:
    cpu: "1"
    memory: "2Gi"
```

### Pod Startup Time

Fargate pods take 30-90 seconds to start (Firecracker VM provisioning). Mitigate this with:

```yaml
# Pre-scale before expected traffic spikes
# Use KEDA with predictive scaling
# Keep minimum replicas > 0 for latency-sensitive services
spec:
  minReplicas: 2  # Never scale to zero for user-facing services
```

### Image Pull Optimization

```bash
# Use ECR for faster image pulls (same VPC, no public internet required)
# Enable ECR image caching

# Reduce image size - each start pulls the full image
# Use multi-stage builds and distroless base images

# Pin image tags for predictable behavior
image: 123456789012.dkr.ecr.us-east-1.amazonaws.com/myapp:1.2.3
```

### Cost Optimization

```bash
# Use Fargate Spot for fault-tolerant workloads (70% discount)
# In eksctl:
fargateProfiles:
  - name: spot-batch
    selectors:
      - namespace: batch-jobs
    # Note: Fargate Spot is set at the pod level via annotation

# Pod annotation for Fargate Spot
metadata:
  annotations:
    eks.amazonaws.com/fargate-profile: spot-batch
```

```yaml
# Fargate Spot scheduling preference
apiVersion: apps/v1
kind: Deployment
metadata:
  name: batch-worker
  namespace: batch-jobs
spec:
  template:
    spec:
      # Use topology spread to distribute across AZs
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: batch-worker
```

## Conclusion

EKS Fargate is the right choice when you want to eliminate EC2 node management, need strong pod-level isolation, or are running variable batch workloads at scale. Its limitations around DaemonSets, hostPath volumes, and privileged containers are real constraints that require architectural adaptation. The hybrid Fargate + EC2 approach is the most common production pattern: system workloads, DaemonSets, GPU jobs, and stateful applications on EC2 node groups, with stateless microservices and batch workloads on Fargate. Understanding the billing model — resource rounding, pod overhead, and Fargate Spot pricing — is essential to keeping costs under control at scale.
